import { logger } from "@vendetta";
import { findByStoreName, findByProps, findByName } from "@vendetta/metro";
import { React, ReactNative, constants, FluxDispatcher } from "@vendetta/metro/common";
import { Forms, General } from "@vendetta/ui/components";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { showToast } from "@vendetta/ui/toasts";
import { after } from "@vendetta/patcher";

const { FormSection, FormRow, FormInput } = Forms;
const { ScrollView, View, Text, TouchableOpacity, TextInput } = General;

// Discord stores
const UserStore = findByStoreName("UserStore");
const GuildStore = findByStoreName("GuildStore");
const GuildMemberStore = findByStoreName("GuildMemberStore");
const ChannelStore = findByStoreName("ChannelStore");
const SelectedGuildStore = findByStoreName("SelectedGuildStore");

// Try multiple ways to get role store
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
let lastCheckedClipboard = "";
let checkIntervalId: any = null;
let patches: (() => void)[] = [];

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

// Get role name using multiple methods
function getRoleName(roleId: string, guildId: string): { name: string, color: number, found: boolean } {
    // Method 1: GuildStore.getGuild().roles
    try {
        const guild = GuildStore?.getGuild?.(guildId);
        if (guild?.roles?.[roleId]) {
            const role = guild.roles[roleId];
            return { name: role.name, color: role.color || 0, found: true };
        }
    } catch { }

    // Method 2: GuildRoleStore
    try {
        if (GuildRoleStore) {
            const role = GuildRoleStore.getRole?.(guildId, roleId);
            if (role) {
                return { name: role.name, color: role.color || 0, found: true };
            }

            const roles = GuildRoleStore.getRoles?.(guildId);
            if (roles?.[roleId]) {
                return { name: roles[roleId].name, color: roles[roleId].color || 0, found: true };
            }
        }
    } catch { }

    // Method 3: Try GuildStore.getRoles
    try {
        const roles = GuildStore?.getRoles?.(guildId);
        if (roles?.[roleId]) {
            return { name: roles[roleId].name, color: roles[roleId].color || 0, found: true };
        }
    } catch { }

    // Not found - return ID as name
    return { name: `Role ID: ${roleId}`, color: 0x5865F2, found: false };
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

            let name = "", color = 0, isUnknown = false;

            if (isRole) {
                if (id === guildId) {
                    name = "@everyone";
                    color = 0x99AAB5;
                } else {
                    const roleInfo = getRoleName(id, guildId);
                    name = roleInfo.name;
                    color = roleInfo.color;
                    isUnknown = !roleInfo.found;
                }
            } else {
                userIds.push(id);
                const user = UserStore?.getUser?.(id);
                const member = GuildMemberStore?.getMember?.(guildId, id);
                if (user) name = member?.nick || user.globalName || user.username;
                else { name = `User ID: ${id}`; isUnknown = true; }
            }

            overwrites.push({ id, name, type, color, allowed: parsePermissionBits(allow), denied: parsePermissionBits(deny), isUnknown });
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
    try {
        const channels = ChannelStore?.getMutableGuildChannelsForGuild?.(guildId) ||
            Object.values(ChannelStore?.getMutableGuildChannels?.() || {}).filter((c: any) => c?.guild_id === guildId);
        return Array.isArray(channels) ? channels : Object.values(channels || {});
    } catch { return []; }
}

function getHiddenChannels(guildId: string): HiddenChannel[] {
    const hidden: HiddenChannel[] = [];
    try {
        const channels = getAllGuildChannels(guildId);
        for (const channel of channels) {
            if (!channel?.id || channel.type === 4 || skipChannels.includes(channel.type)) continue;
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
    } catch { }
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

// For auto-search (clipboard) - still copies
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
    setTimeout(() => { if (Clipboard?.setString) { Clipboard.setString(link); showToast(`📋 Copied latest!`, getAssetIDByName("Check")); } }, 1500);
}

async function checkClipboardContent() {
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

// Format timestamp
function formatTimeAgo(timestamp: string): string {
    const ago = Date.now() - new Date(timestamp).getTime();
    const m = Math.floor(ago / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (d > 0) return `${d}d ago`;
    if (h > 0) return `${h}h ago`;
    return `${m}m ago`;
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
    const [debugInfo, setDebugInfo] = React.useState("");

    // User lookup state
    const [lookupUserId, setLookupUserId] = React.useState("");
    const [userAccessChannels, setUserAccessChannels] = React.useState<HiddenChannel[]>([]);
    const [lookupUserInfo, setLookupUserInfo] = React.useState<any>(null);
    const [isLookingUp, setIsLookingUp] = React.useState(false);

    // Message search state
    const [searchUserId, setSearchUserId] = React.useState("");
    const [isSearching, setIsSearching] = React.useState(false);
    const [searchResults, setSearchResults] = React.useState<SearchMessage[]>([]);

    const [, forceUpdate] = React.useState(0);

    React.useEffect(() => { scanCurrentGuild(); }, []);

    React.useEffect(() => {
        if (selectedChannel && selectedChannel.permissions.userIds.length > 0) {
            requestGuildMembers(selectedChannel.guildId, selectedChannel.permissions.userIds);
            const timer = setTimeout(() => forceUpdate(n => n + 1), 1000);
            return () => clearTimeout(timer);
        }
    }, [selectedChannel?.id]);

    const scanCurrentGuild = () => {
        setIsScanning(true);
        try {
            const guildId = SelectedGuildStore?.getGuildId?.();
            if (guildId) {
                const guild = GuildStore?.getGuild?.(guildId);
                setSelectedGuild(guild);
                const channels = getHiddenChannels(guildId);
                setHiddenChannels(channels);
                setDebugInfo(`${getAllGuildChannels(guildId).length} ch → ${channels.length} hidden`);
                showToast(channels.length > 0 ? `🔒 ${channels.length} hidden!` : `✨ No hidden`, getAssetIDByName("Check"));
            } else {
                setSelectedGuild(null); setHiddenChannels([]); setDebugInfo("Open server first");
            }
        } catch (e) { setDebugInfo(`Error: ${e}`); }
        finally { setIsScanning(false); }
    };

    const refreshSelectedChannel = () => {
        if (selectedChannel && selectedGuild) {
            const channel = ChannelStore?.getChannel?.(selectedChannel.id);
            if (channel) {
                setSelectedChannel({ ...selectedChannel, permissions: getChannelPermissions(channel, selectedGuild.id) });
                showToast("🔄 Refreshed!", getAssetIDByName("Check"));
            }
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

    // Manual search - returns list of messages
    const handleManualSearch = async () => {
        const cleanId = searchUserId.trim();
        if (!cleanId || cleanId.length < 17) { showToast("Enter valid ID", getAssetIDByName("Small")); return; }
        setIsSearching(true);
        setSearchResults([]);

        const guilds = getMutualGuilds(cleanId);
        if (guilds.length === 0) {
            showToast("❌ No mutual servers", getAssetIDByName("Small"));
            setIsSearching(false);
            return;
        }

        showToast(`🔍 Searching ${guilds.length} servers...`, getAssetIDByName("ic_search"));

        let allMsgs: SearchMessage[] = [];
        for (let i = 0; i < Math.min(guilds.length, 8); i++) {
            try { allMsgs.push(...await searchMessagesInGuild(guilds[i].id, cleanId)); } catch { }
            if (i < guilds.length - 1) await new Promise(r => setTimeout(r, 250));
        }

        allMsgs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        setSearchResults(allMsgs);
        setIsSearching(false);
        showToast(allMsgs.length > 0 ? `✅ Found ${allMsgs.length} messages!` : `📭 No messages`, getAssetIDByName("Check"));
    };

    const copyMessageLink = (msg: SearchMessage) => {
        const link = `https://discord.com/channels/${msg.guildId}/${msg.channelId}/${msg.id}`;
        if (Clipboard?.setString) {
            Clipboard.setString(link);
            showToast("📋 Link copied!", getAssetIDByName("Check"));
        }
    };

    const pasteFromClipboard = async (setter: (v: string) => void) => {
        try {
            const content = await Clipboard?.getString?.();
            if (content) { setter(content.trim()); showToast("📋 Pasted!", getAssetIDByName("Check")); }
        } catch { }
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

    return React.createElement(ScrollView, { style: { flex: 1, backgroundColor: '#1e1f22' } }, [
        // Header
        React.createElement(View, { key: 'h', style: { padding: 10, backgroundColor: '#2b2d31', marginBottom: 6 } }, [
            React.createElement(Text, { key: 't', style: { color: '#fff', fontSize: 16, fontWeight: 'bold', textAlign: 'center' } }, "🔍 Stalker Pro v4.4"),
            React.createElement(Text, { key: 's', style: { color: '#b5bac1', fontSize: 10, textAlign: 'center' } }, selectedGuild ? `📍 ${selectedGuild.name}` : "Open a server")
        ]),

        // Tabs
        React.createElement(View, { key: 'tabs', style: { flexDirection: 'row', padding: 4, marginBottom: 4 } }, [
            React.createElement(TabBtn, { key: '1', id: 'hidden', label: 'Hidden', icon: '🔒' }),
            React.createElement(TabBtn, { key: '2', id: 'perms', label: 'Perms', icon: '🔐' }),
            React.createElement(TabBtn, { key: '3', id: 'user', label: 'User', icon: '👤' }),
            React.createElement(TabBtn, { key: '4', id: 'search', label: 'Msgs', icon: '💬' })
        ]),

        // === HIDDEN TAB ===
        activeTab === 'hidden' && [
            React.createElement(TouchableOpacity, { key: 'scan', style: { margin: 8, padding: 10, backgroundColor: '#5865F2', borderRadius: 8, alignItems: 'center' }, onPress: scanCurrentGuild },
                React.createElement(Text, { style: { color: '#fff', fontWeight: 'bold', fontSize: 13 } }, isScanning ? "⏳..." : "🔄 Scan Server")),
            React.createElement(Text, { key: 'dbg', style: { color: '#949ba4', textAlign: 'center', fontSize: 9, marginBottom: 4 } }, debugInfo),
            ...hiddenChannels.map((ch, i) => React.createElement(ChannelCard, { key: `c${i}`, ch, onPress: () => { setSelectedChannel(ch); setActiveTab('perms'); } })),
            hiddenChannels.length === 0 && !isScanning && React.createElement(View, { key: 'empty', style: { padding: 30, alignItems: 'center' } }, [
                React.createElement(Text, { key: 'e1', style: { fontSize: 30 } }, "🔓"),
                React.createElement(Text, { key: 'e2', style: { color: '#fff', fontSize: 13, marginTop: 6 } }, selectedGuild ? "No hidden channels" : "Open a server")
            ])
        ],

        // === PERMISSIONS TAB ===
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
                        React.createElement(Text, { style: { color: '#fff', fontSize: 10 } }, "🔄 Refresh")),
                    React.createElement(TouchableOpacity, { key: 'cpy', style: { flex: 1, padding: 8, backgroundColor: '#3f4147', borderRadius: 6, marginLeft: 2, alignItems: 'center' }, onPress: () => { if (Clipboard?.setString) { Clipboard.setString(selectedChannel.id); showToast("📋 Copied", getAssetIDByName("Check")); } } },
                        React.createElement(Text, { style: { color: '#b5bac1', fontSize: 9 } }, `📋 ID`))
                ]),
                ...selectedChannel.permissions.overwrites.map((ow, i) =>
                    React.createElement(View, { key: `ow-${i}`, style: { margin: 4, marginHorizontal: 6, padding: 8, backgroundColor: '#2b2d31', borderRadius: 8, borderLeftWidth: 3, borderLeftColor: ow.type === 'role' ? roleColor(ow.color) : '#43b581' } }, [
                        React.createElement(View, { key: 'hdr', style: { flexDirection: 'row', alignItems: 'center', marginBottom: 3 } }, [
                            React.createElement(Text, { key: 't', style: { fontSize: 11, marginRight: 4 } }, ow.type === 'role' ? '🏷️' : '👤'),
                            React.createElement(Text, { key: 'n', style: { color: ow.type === 'role' ? roleColor(ow.color) : '#43b581', fontSize: 12, fontWeight: 'bold', flex: 1 } }, ow.name),
                            React.createElement(View, { key: 'b', style: { backgroundColor: ow.type === 'role' ? '#5865F2' : '#43b581', paddingHorizontal: 5, paddingVertical: 2, borderRadius: 3 } },
                                React.createElement(Text, { style: { color: '#fff', fontSize: 8, fontWeight: 'bold' } }, ow.type === 'role' ? 'ROLE' : 'USER'))
                        ]),
                        ow.allowed.length > 0 && React.createElement(View, { key: 'a', style: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 2 } },
                            ow.allowed.map((p, pi) => React.createElement(Text, { key: `a${pi}`, style: { color: '#43b581', fontSize: 9, backgroundColor: 'rgba(67,181,129,0.15)', paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3, marginRight: 2, marginBottom: 2 } }, `✅${p}`))),
                        ow.denied.length > 0 && React.createElement(View, { key: 'd', style: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 2 } },
                            ow.denied.map((p, pi) => React.createElement(Text, { key: `d${pi}`, style: { color: '#ed4245', fontSize: 9, backgroundColor: 'rgba(237,66,69,0.15)', paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3, marginRight: 2, marginBottom: 2 } }, `❌${p}`)))
                    ])
                )
            ]
        ],

        // === USER LOOKUP TAB ===
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

        // === MESSAGE SEARCH TAB ===
        activeTab === 'search' && [
            React.createElement(View, { key: 'auto-info', style: { margin: 8, padding: 8, backgroundColor: '#2b2d31', borderRadius: 8 } }, [
                React.createElement(Text, { key: 't', style: { color: '#fff', fontSize: 11, fontWeight: 'bold' } }, "💬 Auto-Search"),
                React.createElement(Text, { key: 's', style: { color: '#b5bac1', fontSize: 10 } }, clipboardMonitorActive ? "✅ Copy any User ID → auto-copies latest message link" : "❌ Inactive")
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

            searchResults.length > 0 && React.createElement(Text, { key: 'results-title', style: { color: '#fff', fontSize: 11, fontWeight: 'bold', marginLeft: 8, marginTop: 4 } }, `📝 ${searchResults.length} Messages (tap to copy link):`),

            ...searchResults.slice(0, 25).map((msg, i) =>
                React.createElement(TouchableOpacity, { key: `msg${i}`, style: { margin: 4, marginHorizontal: 8, padding: 10, backgroundColor: '#2b2d31', borderRadius: 8, borderLeftWidth: 3, borderLeftColor: '#5865F2' }, onPress: () => copyMessageLink(msg) }, [
                    React.createElement(View, { key: 'hdr', style: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 } }, [
                        React.createElement(Text, { key: 'ch', style: { color: '#5865F2', fontSize: 11, flex: 1 } }, `#${msg.channelName}`),
                        React.createElement(Text, { key: 'time', style: { color: '#949ba4', fontSize: 9 } }, formatTimeAgo(msg.timestamp))
                    ]),
                    React.createElement(Text, { key: 'content', style: { color: '#dcddde', fontSize: 11 }, numberOfLines: 2 }, msg.content),
                    React.createElement(Text, { key: 'server', style: { color: '#72767d', fontSize: 9, marginTop: 4 } }, `📍 ${msg.guildName}`)
                ])
            ),

            searchResults.length > 25 && React.createElement(Text, { key: 'more', style: { color: '#949ba4', textAlign: 'center', fontSize: 10, marginVertical: 8 } }, `+${searchResults.length - 25} more messages...`)
        ]
    ]);
}

export const settings = StalkerSettings;

export const onLoad = () => {
    logger.log("=== STALKER PRO v4.4 ===");
    if (Permissions?.can) {
        patches.push(after("can", Permissions, ([permID, channel], res) => {
            if (channel?.realCheck) return res;
            if (permID === VIEW_CHANNEL) return true;
            return res;
        }));
    }
    if (Clipboard?.getString) {
        clipboardMonitorActive = true;
        checkIntervalId = setInterval(checkClipboardContent, 2000);
    }
    showToast("🔍 Stalker Pro v4.4", getAssetIDByName("Check"));
};

export const onUnload = () => {
    if (checkIntervalId) { clearInterval(checkIntervalId); checkIntervalId = null; }
    for (const p of patches) { try { p(); } catch { } }
    patches = [];
};
