import { logger } from "@vendetta";
import { findByStoreName, findByProps, findByName } from "@vendetta/metro";
import { React, ReactNative, constants, FluxDispatcher } from "@vendetta/metro/common";
import { Forms, General } from "@vendetta/ui/components";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { showToast } from "@vendetta/ui/toasts";
import { after } from "@vendetta/patcher";

const { FormSection, FormRow, FormInput, FormSwitchRow } = Forms;
const { ScrollView, View, Text, TouchableOpacity, TextInput } = General;

// Discord stores
const UserStore = findByStoreName("UserStore");
const GuildStore = findByStoreName("GuildStore");
const GuildMemberStore = findByStoreName("GuildMemberStore");
const ChannelStore = findByStoreName("ChannelStore");
const SelectedGuildStore = findByStoreName("SelectedGuildStore");
const GuildChannelStore = findByStoreName("GuildChannelStore");
const GuildRoleStore = findByStoreName("GuildRoleStore");

// Permissions module
const Permissions = findByProps("getChannelPermissions", "can");
const { getChannel } = findByProps("getChannel") || {};
const ChannelTypes = findByProps("ChannelTypes")?.ChannelTypes || {};

// Clipboard & REST API
const Clipboard = ReactNative?.Clipboard || findByProps("setString", "getString");
const RestAPI = findByProps("getAPIBaseURL", "get") || findByProps("API_HOST", "get");

// Permission constants
const VIEW_CHANNEL = constants?.Permissions?.VIEW_CHANNEL || 1024;

const PERMISSION_NAMES: { [key: number]: string } = {
    1: "Create Invite", 2: "Kick Members", 4: "Ban Members", 8: "Administrator",
    16: "Manage Channels", 32: "Manage Server", 64: "Add Reactions", 128: "View Audit Log",
    256: "Priority Speaker", 512: "Stream", 1024: "View Channel", 2048: "Send Messages",
    4096: "Send TTS", 8192: "Manage Messages", 16384: "Embed Links", 32768: "Attach Files",
    65536: "Read History", 131072: "Mention Everyone", 262144: "Use External Emoji",
    524288: "View Insights", 1048576: "Connect", 2097152: "Speak", 4194304: "Mute Members",
    8388608: "Deafen Members", 16777216: "Move Members", 33554432: "Use VAD",
    67108864: "Change Nickname", 134217728: "Manage Nicknames", 268435456: "Manage Roles",
    536870912: "Manage Webhooks", 1073741824: "Manage Emojis",
};

// Storage
let clipboardMonitorActive = false;
let autoSearchEnabled = true; // Toggle for auto-search
let isDashboardOpen = false; // Track if dashboard is open
let lastCheckedClipboard = "";
let checkIntervalId: any = null;
let patches: (() => void)[] = [];
let isActivelyScanning = false;

const skipChannels = [ChannelTypes.DM, ChannelTypes.GROUP_DM, ChannelTypes.GUILD_CATEGORY];

// ========================================
// INTERFACES
// ========================================

interface HiddenChannel {
    id: string;
    name: string;
    type: number;
    parentName: string;
    permissions: ChannelPermissions;
    guildId: string;
}

interface PermissionOverwrite {
    id: string;
    name: string;
    type: 'role' | 'user';
    color: number;
    allowed: string[];
    denied: string[];
    isUnknown: boolean;
    isFetched: boolean; // Track if user data was successfully fetched
}

interface ChannelPermissions {
    overwrites: PermissionOverwrite[];
    userIds: string[];
}

interface SearchMessage {
    id: string;
    content: string;
    channelId: string;
    channelName: string;
    guildId: string;
    guildName: string;
    timestamp: string;
}

// ========================================
// HELPER FUNCTIONS
// ========================================

function requestGuildMembers(guildId: string, userIds: string[]) {
    if (!FluxDispatcher || userIds.length === 0) return;
    try {
        FluxDispatcher.dispatch({ type: "GUILD_MEMBERS_REQUEST", guildIds: [guildId], userIds });
        logger.log(`Requested ${userIds.length} guild members`);
    } catch { }
}

function isHidden(channel: any): boolean {
    if (!channel) return false;
    if (typeof channel === "string") channel = getChannel?.(channel) || ChannelStore?.getChannel?.(channel);
    if (!channel || skipChannels.includes(channel.type)) return false;
    channel.realCheck = true;
    const hidden = !Permissions?.can?.(VIEW_CHANNEL, channel);
    delete channel.realCheck;
    return hidden;
}

function parsePermissionBits(bits: number | string): string[] {
    const numBits = Number(bits);
    const perms: string[] = [];
    for (const [bit, name] of Object.entries(PERMISSION_NAMES)) {
        if ((numBits & Number(bit)) !== 0) perms.push(name);
    }
    return perms;
}

function getRoleName(roleId: string, guildId: string): { name: string, color: number, found: boolean } {
    try {
        const guild = GuildStore?.getGuild?.(guildId);
        if (guild?.roles?.[roleId]) {
            const role = guild.roles[roleId];
            return { name: role.name, color: role.color || 0, found: true };
        }
    } catch { }

    try {
        if (GuildRoleStore) {
            const role = GuildRoleStore.getRole?.(guildId, roleId);
            if (role) return { name: role.name, color: role.color || 0, found: true };
            const roles = GuildRoleStore.getRoles?.(guildId);
            if (roles?.[roleId]) return { name: roles[roleId].name, color: roles[roleId].color || 0, found: true };
        }
    } catch { }

    return { name: `Role ID: ${roleId}`, color: 0x5865F2, found: false };
}

// Get user info with better handling
function getUserDisplayName(userId: string, guildId: string): { name: string, isFetched: boolean } {
    const user = UserStore?.getUser?.(userId);
    const member = GuildMemberStore?.getMember?.(guildId, userId);

    if (user) {
        const name = member?.nick || user.globalName || user.username;
        return { name, isFetched: true };
    }

    // Not in cache - show ID with indicator
    return { name: `User ID: ${userId}`, isFetched: false };
}

function getChannelPermissions(channel: any, guildId: string): ChannelPermissions {
    const overwrites: PermissionOverwrite[] = [];
    const userIds: string[] = [];

    try {
        const rawOverwrites = channel.permissionOverwrites || {};

        for (const [id, ow] of Object.entries(rawOverwrites) as any[]) {
            if (!ow) continue;
            const allow = Number(ow.allow || 0);
            const deny = Number(ow.deny || 0);
            const isRole = ow.type === 0 || ow.type === "role";
            const type = isRole ? 'role' : 'user';

            let name = "", color = 0, isUnknown = false, isFetched = true;

            if (isRole) {
                if (id === guildId) { name = "@everyone"; color = 0x99AAB5; }
                else {
                    const roleInfo = getRoleName(id, guildId);
                    name = roleInfo.name; color = roleInfo.color; isUnknown = !roleInfo.found;
                }
            } else {
                userIds.push(id);
                const userInfo = getUserDisplayName(id, guildId);
                name = userInfo.name;
                isFetched = userInfo.isFetched;
                isUnknown = !isFetched;
            }

            overwrites.push({ id, name, type, color, allowed: parsePermissionBits(allow), denied: parsePermissionBits(deny), isUnknown, isFetched });
        }

        overwrites.sort((a, b) => {
            if (a.name === "@everyone") return -1;
            if (b.name === "@everyone") return 1;
            if (a.type !== b.type) return a.type === 'role' ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
    } catch { }
    return { overwrites, userIds };
}

function getChannelTypeName(type: number): string {
    switch (type) {
        case 0: return "💬"; case 2: return "🔊"; case 4: return "📁";
        case 5: return "📢"; case 13: return "🎭"; case 15: return "📋";
        default: return "📝";
    }
}

function getAllGuildChannels(guildId: string): any[] {
    const channelMap = new Map<string, any>();

    try {
        const method1 = ChannelStore?.getMutableGuildChannelsForGuild?.(guildId);
        if (method1) {
            const channels = Array.isArray(method1) ? method1 : Object.values(method1);
            for (const ch of channels) { if (ch?.id) channelMap.set(ch.id, ch); }
        }
    } catch { }

    try {
        const allChannels = ChannelStore?.getMutableGuildChannels?.();
        if (allChannels) {
            for (const ch of Object.values(allChannels) as any[]) {
                if (ch?.guild_id === guildId && ch?.id) channelMap.set(ch.id, ch);
            }
        }
    } catch { }

    try {
        if (GuildChannelStore?.getChannels) {
            const result = GuildChannelStore.getChannels(guildId);
            if (result) {
                const processChannels = (arr: any[]) => {
                    if (!Array.isArray(arr)) return;
                    for (const item of arr) {
                        const ch = item?.channel || item;
                        if (ch?.id) channelMap.set(ch.id, ch);
                    }
                };
                if (Array.isArray(result)) processChannels(result);
                else {
                    for (const key of Object.keys(result)) {
                        if (Array.isArray(result[key])) processChannels(result[key]);
                    }
                }
            }
        }
    } catch { }

    return Array.from(channelMap.values());
}

function getHiddenChannels(guildId: string): HiddenChannel[] {
    const hidden: HiddenChannel[] = [];
    isActivelyScanning = true;

    try {
        const channels = getAllGuildChannels(guildId);
        for (const channel of channels) {
            if (!channel?.id) continue;
            if (channel.type === 4 || channel.type === 1 || channel.type === 3) continue;
            if (channel.type === 11 || channel.type === 12) continue;
            if (skipChannels.includes(channel.type)) continue;

            if (isHidden(channel)) {
                hidden.push({
                    id: channel.id,
                    name: channel.name || "unknown",
                    type: channel.type || 0,
                    parentName: channel.parent_id ? (ChannelStore?.getChannel?.(channel.parent_id)?.name || "") : "",
                    permissions: getChannelPermissions(channel, guildId),
                    guildId
                });
            }
        }
    } catch (e) { logger.error("getHiddenChannels error:", e); }
    finally { isActivelyScanning = false; }

    return hidden.sort((a, b) => a.name.localeCompare(b.name));
}

function canUserAccessChannel(userId: string, channel: HiddenChannel, guildId: string): boolean {
    const member = GuildMemberStore?.getMember?.(guildId, userId);
    if (!member) return false;
    const memberRoles = member.roles || [];
    for (const ow of channel.permissions.overwrites) {
        if (ow.type === 'user' && ow.id === userId && ow.allowed.includes("View Channel")) return true;
        if (ow.type === 'role' && memberRoles.includes(ow.id) && ow.allowed.includes("View Channel")) return true;
    }
    return false;
}

function getUserAccessibleHiddenChannels(userId: string, guildId: string): HiddenChannel[] {
    return getHiddenChannels(guildId).filter(ch => canUserAccessChannel(userId, ch, guildId));
}

// ========================================
// MESSAGE SEARCH
// ========================================

function getMutualGuilds(userId: string) {
    if (!GuildStore || !GuildMemberStore) return [];
    try {
        return (Object.values(GuildStore.getGuilds() || {}) as any[]).filter(g => GuildMemberStore.getMember(g.id, userId));
    } catch { return []; }
}

async function searchMessagesInGuild(guildId: string, authorId: string): Promise<SearchMessage[]> {
    if (!RestAPI?.get) return [];
    try {
        const res = await RestAPI.get({ url: `/guilds/${guildId}/messages/search`, query: { author_id: authorId, include_nsfw: true, sort_by: "timestamp", sort_order: "desc" } });
        const guildName = GuildStore?.getGuild?.(guildId)?.name || "Unknown Server";
        return (res?.body?.messages || []).map((m: any[]) => ({
            id: m[0].id,
            content: m[0].content || "[No text content]",
            channelId: m[0].channel_id,
            channelName: ChannelStore?.getChannel?.(m[0].channel_id)?.name || "unknown",
            guildId,
            guildName,
            timestamp: m[0].timestamp
        }));
    } catch { return []; }
}

async function autoSearchUser(userId: string) {
    const currentUser = UserStore?.getCurrentUser?.();
    if (currentUser && userId === currentUser.id) return;
    const guilds = getMutualGuilds(userId);
    if (guilds.length === 0) { showToast("❌ No mutual servers", getAssetIDByName("Small")); return; }
    showToast(`🔍 Searching...`, getAssetIDByName("ic_search"));

    let allMsgs: SearchMessage[] = [];
    for (let i = 0; i < Math.min(guilds.length, 8); i++) {
        try { allMsgs.push(...await searchMessagesInGuild(guilds[i].id, userId)); } catch { }
        if (i < guilds.length - 1) await new Promise(r => setTimeout(r, 250));
    }
    allMsgs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    if (allMsgs.length === 0) { showToast(`📭 No messages`, getAssetIDByName("Small")); return; }

    const latest = allMsgs[0];
    const link = `https://discord.com/channels/${latest.guildId}/${latest.channelId}/${latest.id}`;

    showToast(`✅ Found ${allMsgs.length}!`, getAssetIDByName("Check"));
    setTimeout(() => { if (safeClipboardCopy(link)) { showToast(`📋 Copied latest!`, getAssetIDByName("Check")); } }, 1500);
}

async function checkClipboardContent() {
    // Don't check if dashboard is open or auto-search is disabled
    if (isDashboardOpen || !autoSearchEnabled) return;

    try {
        if (!Clipboard?.getString) return;
        const content = await Clipboard.getString();
        if (content && content !== lastCheckedClipboard && /^\d{17,19}$/.test(content.trim())) {
            lastCheckedClipboard = content;
            showToast(`🎯 ID detected!`, getAssetIDByName("Check"));
            setTimeout(() => autoSearchUser(content.trim()), 1000);
        }
    } catch { }
}

function formatTimeAgo(timestamp: string): string {
    const ago = Date.now() - new Date(timestamp).getTime();
    const m = Math.floor(ago / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (d > 0) return `${d}d ago`;
    if (h > 0) return `${h}h ago`;
    return `${m}m ago`;
}

// Safe clipboard copy - always update lastCheckedClipboard to prevent auto-search trigger
function safeClipboardCopy(text: string) {
    if (Clipboard?.setString) {
        Clipboard.setString(text);
        lastCheckedClipboard = text; // Prevent auto-search from triggering
        return true;
    }
    return false;
}

// Copy ID with toast
function copyId(id: string, type: 'role' | 'user') {
    if (safeClipboardCopy(id)) {
        showToast(`📋 ${type === 'role' ? 'Role' : 'User'} ID copied!`, getAssetIDByName("Check"));
    }
}

// ========================================
// SETTINGS UI
// ========================================

function StalkerSettings() {
    const [activeTab, setActiveTab] = React.useState<'hidden' | 'perms' | 'user' | 'search'>('hidden');
    const [hiddenChannels, setHiddenChannels] = React.useState<HiddenChannel[]>([]);
    const [isScanning, setIsScanning] = React.useState(false);
    const [selectedGuild, setSelectedGuild] = React.useState<any>(null);
    const [selectedChannel, setSelectedChannel] = React.useState<HiddenChannel | null>(null);
    const [debugInfo, setDebugInfo] = React.useState("Tap 'Scan' to find hidden channels");

    const [lookupUserId, setLookupUserId] = React.useState("");
    const [userAccessChannels, setUserAccessChannels] = React.useState<HiddenChannel[]>([]);
    const [lookupUserInfo, setLookupUserInfo] = React.useState<any>(null);
    const [isLookingUp, setIsLookingUp] = React.useState(false);

    const [searchUserId, setSearchUserId] = React.useState("");
    const [isSearching, setIsSearching] = React.useState(false);
    const [searchResults, setSearchResults] = React.useState<SearchMessage[]>([]);
    const [autoSearchToggle, setAutoSearchToggle] = React.useState(autoSearchEnabled);

    const [, forceUpdate] = React.useState(0);

    // Mark dashboard as open/closed
    React.useEffect(() => {
        isDashboardOpen = true;
        logger.log("Dashboard opened - auto-search paused");

        const guildId = SelectedGuildStore?.getGuildId?.();
        if (guildId) setSelectedGuild(GuildStore?.getGuild?.(guildId));

        return () => {
            isDashboardOpen = false;
            logger.log("Dashboard closed - auto-search resumed");
        };
    }, []);

    // Re-fetch permissions when channel selected
    React.useEffect(() => {
        if (selectedChannel && selectedChannel.permissions.userIds.length > 0) {
            requestGuildMembers(selectedChannel.guildId, selectedChannel.permissions.userIds);
            // Auto-refresh after delay to get user data
            const timer = setTimeout(() => {
                if (selectedChannel && selectedGuild) {
                    const channel = ChannelStore?.getChannel?.(selectedChannel.id);
                    if (channel) {
                        setSelectedChannel({ ...selectedChannel, permissions: getChannelPermissions(channel, selectedGuild.id) });
                    }
                }
            }, 1500);
            return () => clearTimeout(timer);
        }
    }, [selectedChannel?.id]);

    const scanCurrentGuild = () => {
        setIsScanning(true);
        setHiddenChannels([]);
        try {
            const guildId = SelectedGuildStore?.getGuildId?.();
            if (guildId) {
                const guild = GuildStore?.getGuild?.(guildId);
                setSelectedGuild(guild);
                const channels = getHiddenChannels(guildId);
                setHiddenChannels(channels);
                setDebugInfo(`Scanned → ${channels.length} hidden`);
                showToast(channels.length > 0 ? `🔒 ${channels.length} hidden!` : `✨ No hidden`, getAssetIDByName("Check"));
            } else {
                setSelectedGuild(null);
                setDebugInfo("Open a server first");
            }
        } catch (e) { setDebugInfo(`Error: ${e}`); }
        finally { setIsScanning(false); }
    };

    const refreshSelectedChannel = () => {
        if (selectedChannel && selectedGuild) {
            requestGuildMembers(selectedGuild.id, selectedChannel.permissions.userIds);
            setTimeout(() => {
                const channel = ChannelStore?.getChannel?.(selectedChannel.id);
                if (channel) {
                    setSelectedChannel({ ...selectedChannel, permissions: getChannelPermissions(channel, selectedGuild.id) });
                    showToast("🔄 Refreshed!", getAssetIDByName("Check"));
                }
            }, 500);
        }
    };

    const handleUserLookup = () => {
        const cleanId = lookupUserId.trim();
        if (!cleanId || cleanId.length < 17) { showToast("Enter valid ID", getAssetIDByName("Small")); return; }
        if (!selectedGuild) { showToast("Open a server first", getAssetIDByName("Small")); return; }
        setIsLookingUp(true);
        requestGuildMembers(selectedGuild.id, [cleanId]);
        setTimeout(() => {
            const user = UserStore?.getUser?.(cleanId);
            const member = GuildMemberStore?.getMember?.(selectedGuild.id, cleanId);
            setLookupUserInfo({ user, member, id: cleanId });
            setUserAccessChannels(getUserAccessibleHiddenChannels(cleanId, selectedGuild.id));
            setIsLookingUp(false);
        }, 500);
    };

    const handleManualSearch = async () => {
        const cleanId = searchUserId.trim();
        if (!cleanId || cleanId.length < 17) { showToast("Enter valid ID", getAssetIDByName("Small")); return; }
        setIsSearching(true);
        setSearchResults([]);

        const guilds = getMutualGuilds(cleanId);
        if (guilds.length === 0) { showToast("❌ No mutual servers", getAssetIDByName("Small")); setIsSearching(false); return; }

        showToast(`🔍 Searching...`, getAssetIDByName("ic_search"));
        let allMsgs: SearchMessage[] = [];
        for (let i = 0; i < Math.min(guilds.length, 8); i++) {
            try { allMsgs.push(...await searchMessagesInGuild(guilds[i].id, cleanId)); } catch { }
            if (i < guilds.length - 1) await new Promise(r => setTimeout(r, 250));
        }
        allMsgs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        setSearchResults(allMsgs);
        setIsSearching(false);
        showToast(allMsgs.length > 0 ? `✅ ${allMsgs.length} messages!` : `📭 No messages`, getAssetIDByName("Check"));
    };

    const copyMessageLink = (msg: SearchMessage) => {
        const link = `https://discord.com/channels/${msg.guildId}/${msg.channelId}/${msg.id}`;
        if (safeClipboardCopy(link)) { showToast("📋 Link copied!", getAssetIDByName("Check")); }
    };

    const pasteFromClipboard = async (setter: (v: string) => void) => {
        try {
            const content = await Clipboard?.getString?.();
            if (content) { setter(content.trim()); showToast("📋 Pasted!", getAssetIDByName("Check")); }
        } catch { }
    };

    const toggleAutoSearch = (val: boolean) => {
        autoSearchEnabled = val;
        setAutoSearchToggle(val);
        showToast(val ? "✅ Auto-search enabled" : "❌ Auto-search disabled", getAssetIDByName("Check"));
    };

    const roleColor = (c: number) => c ? `#${c.toString(16).padStart(6, '0')}` : '#99AAB5';

    const TabBtn = ({ id, label, icon }: any) =>
        React.createElement(TouchableOpacity, {
            style: { flex: 1, padding: 8, backgroundColor: activeTab === id ? '#5865F2' : '#2b2d31', borderRadius: 8, marginHorizontal: 2 },
            onPress: () => { setActiveTab(id); if (id !== 'perms') setSelectedChannel(null); }
        }, React.createElement(Text, { style: { color: '#fff', textAlign: 'center', fontSize: 11, fontWeight: activeTab === id ? 'bold' : 'normal' } }, `${icon}${label}`));

    const ChannelCard = ({ ch, onPress }: { ch: HiddenChannel, onPress: () => void }) =>
        React.createElement(TouchableOpacity, { style: { margin: 6, padding: 10, backgroundColor: '#2b2d31', borderRadius: 10, borderLeftWidth: 3, borderLeftColor: '#5865F2' }, onPress }, [
            React.createElement(View, { key: 'h', style: { flexDirection: 'row', alignItems: 'center' } }, [
                React.createElement(Text, { key: 'i', style: { fontSize: 14, marginRight: 6 } }, getChannelTypeName(ch.type)),
                React.createElement(View, { key: 'n', style: { flex: 1 } }, [
                    React.createElement(Text, { key: 'nm', style: { color: '#fff', fontSize: 13, fontWeight: 'bold' } }, ch.name),
                    ch.parentName && React.createElement(Text, { key: 'p', style: { color: '#949ba4', fontSize: 10 } }, `in ${ch.parentName}`)
                ]),
                React.createElement(Text, { key: 'a', style: { color: '#5865F2', fontSize: 10 } }, "→")
            ])
        ]);

    // Interactive Role/User item
    const OverwriteItem = ({ ow }: { ow: PermissionOverwrite }) =>
        React.createElement(TouchableOpacity, {
            style: { margin: 4, marginHorizontal: 6, padding: 8, backgroundColor: '#2b2d31', borderRadius: 8, borderLeftWidth: 3, borderLeftColor: ow.type === 'role' ? roleColor(ow.color) : '#43b581' },
            onPress: () => copyId(ow.id, ow.type)
        }, [
            React.createElement(View, { key: 'hdr', style: { flexDirection: 'row', alignItems: 'center', marginBottom: 3 } }, [
                React.createElement(Text, { key: 't', style: { fontSize: 11, marginRight: 4 } }, ow.type === 'role' ? '🏷️' : '👤'),
                React.createElement(View, { key: 'nw', style: { flex: 1 } }, [
                    React.createElement(Text, { key: 'n', style: { color: ow.type === 'role' ? roleColor(ow.color) : '#43b581', fontSize: 12, fontWeight: 'bold' } }, ow.name),
                    !ow.isFetched && ow.type === 'user' && React.createElement(Text, { key: 'hint', style: { color: '#949ba4', fontSize: 9 } }, "Tap refresh to load name")
                ]),
                React.createElement(View, { key: 'b', style: { backgroundColor: ow.type === 'role' ? '#5865F2' : '#43b581', paddingHorizontal: 5, paddingVertical: 2, borderRadius: 3 } },
                    React.createElement(Text, { style: { color: '#fff', fontSize: 8, fontWeight: 'bold' } }, ow.type === 'role' ? 'ROLE' : 'USER')),
                React.createElement(Text, { key: 'copy', style: { color: '#949ba4', fontSize: 9, marginLeft: 4 } }, "📋")
            ]),
            ow.allowed.length > 0 && React.createElement(View, { key: 'a', style: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 2 } },
                ow.allowed.map((p, pi) => React.createElement(Text, { key: `a${pi}`, style: { color: '#43b581', fontSize: 9, backgroundColor: 'rgba(67,181,129,0.15)', paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3, marginRight: 2, marginBottom: 2 } }, `✅${p}`))),
            ow.denied.length > 0 && React.createElement(View, { key: 'd', style: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 2 } },
                ow.denied.map((p, pi) => React.createElement(Text, { key: `d${pi}`, style: { color: '#ed4245', fontSize: 9, backgroundColor: 'rgba(237,66,69,0.15)', paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3, marginRight: 2, marginBottom: 2 } }, `❌${p}`)))
        ]);

    return React.createElement(ScrollView, { style: { flex: 1, backgroundColor: '#1e1f22' } }, [
        React.createElement(View, { key: 'h', style: { padding: 10, backgroundColor: '#2b2d31', marginBottom: 6 } }, [
            React.createElement(Text, { key: 't', style: { color: '#fff', fontSize: 16, fontWeight: 'bold', textAlign: 'center' } }, "🔍 Stalker Pro v4.6"),
            React.createElement(Text, { key: 's', style: { color: '#b5bac1', fontSize: 10, textAlign: 'center' } }, selectedGuild ? `📍 ${selectedGuild.name}` : "Open a server")
        ]),

        React.createElement(View, { key: 'tabs', style: { flexDirection: 'row', padding: 4, marginBottom: 4 } }, [
            React.createElement(TabBtn, { key: '1', id: 'hidden', label: 'Hidden', icon: '🔒' }),
            React.createElement(TabBtn, { key: '2', id: 'perms', label: 'Perms', icon: '🔐' }),
            React.createElement(TabBtn, { key: '3', id: 'user', label: 'User', icon: '👤' }),
            React.createElement(TabBtn, { key: '4', id: 'search', label: 'Msgs', icon: '💬' })
        ]),

        activeTab === 'hidden' && [
            React.createElement(TouchableOpacity, { key: 'scan', style: { margin: 8, padding: 12, backgroundColor: '#5865F2', borderRadius: 8, alignItems: 'center' }, onPress: scanCurrentGuild },
                React.createElement(Text, { style: { color: '#fff', fontWeight: 'bold', fontSize: 14 } }, isScanning ? "⏳ Scanning..." : "🔄 Scan Server")),
            React.createElement(Text, { key: 'dbg', style: { color: '#949ba4', textAlign: 'center', fontSize: 10, marginBottom: 6 } }, debugInfo),
            ...hiddenChannels.map((ch, i) => React.createElement(ChannelCard, { key: `c${i}`, ch, onPress: () => { setSelectedChannel(ch); setActiveTab('perms'); } })),
            hiddenChannels.length === 0 && !isScanning && React.createElement(View, { key: 'empty', style: { padding: 30, alignItems: 'center' } }, [
                React.createElement(Text, { key: 'e1', style: { fontSize: 30 } }, "🔒"),
                React.createElement(Text, { key: 'e2', style: { color: '#b5bac1', fontSize: 12, marginTop: 6, textAlign: 'center' } }, "Tap 'Scan Server' to find hidden channels")
            ])
        ],

        activeTab === 'perms' && [
            !selectedChannel && React.createElement(View, { key: 'no-sel', style: { padding: 30, alignItems: 'center' } }, [
                React.createElement(Text, { key: 't1', style: { fontSize: 30 } }, "🔐"),
                React.createElement(Text, { key: 't2', style: { color: '#fff', fontSize: 13, marginTop: 6 } }, "Select a channel")
            ]),
            selectedChannel && [
                React.createElement(View, { key: 'ch-hdr', style: { padding: 10, backgroundColor: '#2b2d31', margin: 6, borderRadius: 8 } }, [
                    React.createElement(View, { key: 'r', style: { flexDirection: 'row', alignItems: 'center' } }, [
                        React.createElement(Text, { key: 'i', style: { fontSize: 18, marginRight: 8 } }, getChannelTypeName(selectedChannel.type)),
                        React.createElement(Text, { key: 'n', style: { color: '#fff', fontSize: 14, fontWeight: 'bold', flex: 1 } }, selectedChannel.name)
                    ])
                ]),
                React.createElement(View, { key: 'btns', style: { flexDirection: 'row', margin: 6, marginTop: 0 } }, [
                    React.createElement(TouchableOpacity, { key: 'ref', style: { flex: 1, padding: 8, backgroundColor: '#3f4147', borderRadius: 6, marginRight: 2, alignItems: 'center' }, onPress: refreshSelectedChannel },
                        React.createElement(Text, { style: { color: '#fff', fontSize: 10 } }, "🔄 Refresh Names")),
                    React.createElement(TouchableOpacity, { key: 'cpy', style: { flex: 1, padding: 8, backgroundColor: '#3f4147', borderRadius: 6, marginLeft: 2, alignItems: 'center' }, onPress: () => { if (safeClipboardCopy(selectedChannel.id)) { showToast("📋 Channel ID copied", getAssetIDByName("Check")); } } },
                        React.createElement(Text, { style: { color: '#b5bac1', fontSize: 9 } }, `📋 Channel ID`))
                ]),
                React.createElement(Text, { key: 'hint', style: { color: '#949ba4', fontSize: 9, textAlign: 'center', marginBottom: 4 } }, "Tap any role/user to copy their ID"),
                ...selectedChannel.permissions.overwrites.map((ow, i) => React.createElement(OverwriteItem, { key: `ow-${i}`, ow }))
            ]
        ],

        activeTab === 'user' && [
            React.createElement(View, { key: 'input-box', style: { margin: 8, padding: 10, backgroundColor: '#2b2d31', borderRadius: 8 } }, [
                React.createElement(Text, { key: 'lbl', style: { color: '#fff', fontSize: 11, fontWeight: 'bold', marginBottom: 4 } }, "👤 User ID Lookup"),
                React.createElement(View, { key: 'row', style: { flexDirection: 'row', alignItems: 'center' } }, [
                    React.createElement(TextInput, { key: 'input', style: { flex: 1, backgroundColor: '#1e1f22', color: '#fff', padding: 8, borderRadius: 6, fontSize: 12 }, placeholder: "Enter User ID", placeholderTextColor: '#72767d', value: lookupUserId, onChangeText: setLookupUserId }),
                    React.createElement(TouchableOpacity, { key: 'paste', style: { marginLeft: 4, padding: 8, backgroundColor: '#3f4147', borderRadius: 6 }, onPress: () => pasteFromClipboard(setLookupUserId) },
                        React.createElement(Text, { style: { color: '#fff', fontSize: 11 } }, "📋"))
                ]),
                React.createElement(TouchableOpacity, { key: 'btn', style: { marginTop: 8, padding: 10, backgroundColor: '#5865F2', borderRadius: 6, alignItems: 'center' }, onPress: handleUserLookup },
                    React.createElement(Text, { style: { color: '#fff', fontWeight: 'bold', fontSize: 12 } }, isLookingUp ? "⏳..." : "🔍 Find Hidden Channels"))
            ]),
            lookupUserInfo && React.createElement(View, { key: 'user-info', style: { margin: 8, marginTop: 0, padding: 8, backgroundColor: '#2b2d31', borderRadius: 8 } }, [
                React.createElement(Text, { key: 'name', style: { color: '#fff', fontSize: 12, fontWeight: 'bold' } }, lookupUserInfo.member?.nick || lookupUserInfo.user?.globalName || lookupUserInfo.user?.username || `User ${lookupUserInfo.id.slice(-6)}`),
                React.createElement(Text, { key: 'access', style: { color: '#43b581', fontSize: 10, marginTop: 2 } }, `✅ Can access ${userAccessChannels.length} hidden channels`)
            ]),
            ...userAccessChannels.map((ch, i) => React.createElement(ChannelCard, { key: `uc${i}`, ch, onPress: () => { setSelectedChannel(ch); setActiveTab('perms'); } })),
            lookupUserInfo && userAccessChannels.length === 0 && React.createElement(Text, { key: 'no', style: { color: '#949ba4', textAlign: 'center', fontSize: 11, marginTop: 10 } }, "No hidden channel access")
        ],

        activeTab === 'search' && [
            React.createElement(View, { key: 'auto-box', style: { margin: 8, padding: 10, backgroundColor: '#2b2d31', borderRadius: 8 } }, [
                React.createElement(View, { key: 'row', style: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' } }, [
                    React.createElement(View, { key: 'txt' }, [
                        React.createElement(Text, { key: 't', style: { color: '#fff', fontSize: 11, fontWeight: 'bold' } }, "💬 Auto-Search"),
                        React.createElement(Text, { key: 's', style: { color: '#b5bac1', fontSize: 9 } }, "Copy User ID → auto-copies latest message")
                    ]),
                    React.createElement(TouchableOpacity, {
                        key: 'toggle',
                        style: { padding: 8, backgroundColor: autoSearchToggle ? '#43b581' : '#ed4245', borderRadius: 6 },
                        onPress: () => toggleAutoSearch(!autoSearchToggle)
                    }, React.createElement(Text, { style: { color: '#fff', fontSize: 10, fontWeight: 'bold' } }, autoSearchToggle ? "ON" : "OFF"))
                ]),
                React.createElement(Text, { key: 'note', style: { color: '#949ba4', fontSize: 9, marginTop: 6 } },
                    isDashboardOpen ? "⏸️ Paused while dashboard is open" : (autoSearchToggle ? "✅ Active" : "❌ Disabled"))
            ]),

            React.createElement(View, { key: 'search-box', style: { margin: 8, marginTop: 0, padding: 10, backgroundColor: '#2b2d31', borderRadius: 8 } }, [
                React.createElement(Text, { key: 'lbl', style: { color: '#fff', fontSize: 11, fontWeight: 'bold', marginBottom: 4 } }, "🔍 Manual Search"),
                React.createElement(View, { key: 'row', style: { flexDirection: 'row', alignItems: 'center' } }, [
                    React.createElement(TextInput, { key: 'input', style: { flex: 1, backgroundColor: '#1e1f22', color: '#fff', padding: 8, borderRadius: 6, fontSize: 12 }, placeholder: "Enter User ID", placeholderTextColor: '#72767d', value: searchUserId, onChangeText: setSearchUserId }),
                    React.createElement(TouchableOpacity, { key: 'paste', style: { marginLeft: 4, padding: 8, backgroundColor: '#3f4147', borderRadius: 6 }, onPress: () => pasteFromClipboard(setSearchUserId) },
                        React.createElement(Text, { style: { color: '#fff', fontSize: 11 } }, "📋"))
                ]),
                React.createElement(TouchableOpacity, { key: 'btn', style: { marginTop: 8, padding: 10, backgroundColor: '#5865F2', borderRadius: 6, alignItems: 'center' }, onPress: handleManualSearch },
                    React.createElement(Text, { style: { color: '#fff', fontWeight: 'bold', fontSize: 12 } }, isSearching ? "⏳ Searching..." : "🔍 Find Messages"))
            ]),

            searchResults.length > 0 && React.createElement(Text, { key: 'results-title', style: { color: '#fff', fontSize: 11, fontWeight: 'bold', marginLeft: 8, marginTop: 4 } }, `📝 ${searchResults.length} Messages:`),

            ...searchResults.slice(0, 25).map((msg, i) =>
                React.createElement(TouchableOpacity, { key: `msg${i}`, style: { margin: 4, marginHorizontal: 8, padding: 10, backgroundColor: '#2b2d31', borderRadius: 8, borderLeftWidth: 3, borderLeftColor: '#5865F2' }, onPress: () => copyMessageLink(msg) }, [
                    React.createElement(View, { key: 'hdr', style: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 } }, [
                        React.createElement(Text, { key: 'ch', style: { color: '#5865F2', fontSize: 11, flex: 1 } }, `#${msg.channelName}`),
                        React.createElement(Text, { key: 'time', style: { color: '#949ba4', fontSize: 9 } }, formatTimeAgo(msg.timestamp))
                    ]),
                    React.createElement(Text, { key: 'content', style: { color: '#dcddde', fontSize: 11 }, numberOfLines: 2 }, msg.content),
                    React.createElement(Text, { key: 'server', style: { color: '#72767d', fontSize: 9, marginTop: 4 } }, `📍 ${msg.guildName}`)
                ])
            )
        ]
    ]);
}

export const settings = StalkerSettings;

export const onLoad = () => {
    logger.log("=== STALKER PRO v4.6 ===");

    if (Permissions?.can) {
        patches.push(after("can", Permissions, ([permID, channel], res) => {
            if (channel?.realCheck) return res;
            if (isActivelyScanning && permID === VIEW_CHANNEL) return true;
            return res;
        }));
    }

    if (Clipboard?.getString) {
        clipboardMonitorActive = true;
        checkIntervalId = setInterval(checkClipboardContent, 2000);
    }

    showToast("🔍 Stalker Pro v4.6", getAssetIDByName("Check"));
};

export const onUnload = () => {
    if (checkIntervalId) { clearInterval(checkIntervalId); checkIntervalId = null; }
    for (const p of patches) { try { p(); } catch { } }
    patches = [];
    isActivelyScanning = false;
    isDashboardOpen = false;
};
