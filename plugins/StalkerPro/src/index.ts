import { logger } from "@vendetta";
import { findByStoreName, findByProps, findByName } from "@vendetta/metro";
import { React, ReactNative, constants, FluxDispatcher } from "@vendetta/metro/common";
import { Forms, General } from "@vendetta/ui/components";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { showToast } from "@vendetta/ui/toasts";
import { after } from "@vendetta/patcher";

const { FormSection, FormRow, FormInput } = Forms;
const { ScrollView, View, Text, TouchableOpacity } = General;

// Discord stores
const UserStore = findByStoreName("UserStore");
const GuildStore = findByStoreName("GuildStore");
const GuildMemberStore = findByStoreName("GuildMemberStore");
const ChannelStore = findByStoreName("ChannelStore");
const SelectedGuildStore = findByStoreName("SelectedGuildStore");

// Permissions module
const Permissions = findByProps("getChannelPermissions", "can");
const { getChannel } = findByProps("getChannel") || {};
const ChannelTypes = findByProps("ChannelTypes")?.ChannelTypes || {};

// Clipboard & REST API
const Clipboard = ReactNative?.Clipboard || findByProps("setString", "getString");
const RestAPI = findByProps("getAPIBaseURL", "get") || findByProps("API_HOST", "get");

// Permission constants
const VIEW_CHANNEL = constants?.Permissions?.VIEW_CHANNEL || 1024;

// All permission bits
const PERMISSION_NAMES: { [key: number]: string } = {
    1: "Create Invite",
    2: "Kick Members",
    4: "Ban Members",
    8: "Administrator",
    16: "Manage Channels",
    32: "Manage Server",
    64: "Add Reactions",
    128: "View Audit Log",
    256: "Priority Speaker",
    512: "Stream",
    1024: "View Channel",
    2048: "Send Messages",
    4096: "Send TTS",
    8192: "Manage Messages",
    16384: "Embed Links",
    32768: "Attach Files",
    65536: "Read History",
    131072: "Mention Everyone",
    262144: "Use External Emoji",
    524288: "View Insights",
    1048576: "Connect",
    2097152: "Speak",
    4194304: "Mute Members",
    8388608: "Deafen Members",
    16777216: "Move Members",
    33554432: "Use VAD",
    67108864: "Change Nickname",
    134217728: "Manage Nicknames",
    268435456: "Manage Roles",
    536870912: "Manage Webhooks",
    1073741824: "Manage Emojis",
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
    userIds: string[]; // Users we need to fetch
}

// ========================================
// FETCH GUILD MEMBERS
// ========================================

function requestGuildMembers(guildId: string, userIds: string[]) {
    if (!FluxDispatcher || userIds.length === 0) return;

    try {
        FluxDispatcher.dispatch({
            type: "GUILD_MEMBERS_REQUEST",
            guildIds: [guildId],
            userIds: userIds
        });
        logger.log(`Requested ${userIds.length} guild members`);
    } catch (e) {
        logger.error("Failed to request guild members:", e);
    }
}

// ========================================
// PERMISSION FUNCTIONS
// ========================================

function isHidden(channel: any): boolean {
    if (!channel) return false;
    if (typeof channel === "string") {
        channel = getChannel?.(channel) || ChannelStore?.getChannel?.(channel);
    }
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

// Get detailed permissions for a channel
function getChannelPermissions(channel: any, guildId: string): ChannelPermissions {
    const overwrites: PermissionOverwrite[] = [];
    const userIds: string[] = [];

    try {
        const rawOverwrites = channel.permissionOverwrites || {};
        const guild = GuildStore?.getGuild?.(guildId);

        logger.log(`Parsing ${Object.keys(rawOverwrites).length} overwrites for channel ${channel.name}`);

        for (const [id, ow] of Object.entries(rawOverwrites) as any[]) {
            if (!ow) continue;

            const allow = Number(ow.allow || 0);
            const deny = Number(ow.deny || 0);

            // Determine type: 0 = role, 1 = member
            const isRole = ow.type === 0 || ow.type === "role";
            const type = isRole ? 'role' : 'user';

            let name = "";
            let color = 0;
            let isUnknown = false;

            if (isRole) {
                // It's a role
                if (id === guildId) {
                    name = "@everyone";
                } else {
                    const role = guild?.roles?.[id];
                    if (role) {
                        name = role.name;
                        color = role.color || 0;
                    } else {
                        // Role not found - might be deleted or special
                        name = `Role (${id.slice(-6)})`;
                        isUnknown = true;
                    }
                }
            } else {
                // It's a user/member - track for fetching
                userIds.push(id);

                // Try to get user from cache
                const user = UserStore?.getUser?.(id);
                const member = GuildMemberStore?.getMember?.(guildId, id);

                if (user) {
                    name = member?.nick || user.globalName || user.username;
                } else {
                    name = `User (${id.slice(-6)})`;
                    isUnknown = true;
                }
            }

            overwrites.push({
                id,
                name,
                type,
                color,
                allowed: parsePermissionBits(allow),
                denied: parsePermissionBits(deny),
                isUnknown
            });
        }

        // Sort: @everyone first, then roles, then users
        overwrites.sort((a, b) => {
            if (a.name === "@everyone") return -1;
            if (b.name === "@everyone") return 1;
            if (a.type !== b.type) return a.type === 'role' ? -1 : 1;
            return a.name.localeCompare(b.name);
        });

    } catch (e) {
        logger.error("getChannelPermissions error:", e);
    }

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
    } catch (e) { logger.error("getHiddenChannels error:", e); }
    return hidden.sort((a, b) => a.name.localeCompare(b.name));
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

async function searchMessagesInGuild(guildId: string, authorId: string): Promise<any[]> {
    if (!RestAPI?.get) return [];
    try {
        const res = await RestAPI.get({ url: `/guilds/${guildId}/messages/search`, query: { author_id: authorId, include_nsfw: true, sort_by: "timestamp", sort_order: "desc" } });
        return (res?.body?.messages || []).map((m: any[]) => ({ id: m[0].id, channelId: m[0].channel_id, guildId, timestamp: m[0].timestamp }));
    } catch { return []; }
}

async function autoSearchUser(userId: string) {
    const currentUser = UserStore?.getCurrentUser?.();
    if (currentUser && userId === currentUser.id) return;
    const guilds = getMutualGuilds(userId);
    if (guilds.length === 0) { showToast("❌ No mutual servers", getAssetIDByName("Small")); return; }
    showToast(`🔍 Searching...`, getAssetIDByName("ic_search"));

    let allMsgs: any[] = [];
    for (let i = 0; i < Math.min(guilds.length, 8); i++) {
        try { allMsgs.push(...await searchMessagesInGuild(guilds[i].id, userId)); } catch { }
        if (i < guilds.length - 1) await new Promise(r => setTimeout(r, 250));
    }
    allMsgs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    if (allMsgs.length === 0) { showToast(`📭 No messages`, getAssetIDByName("Small")); return; }
    showToast(`✅ Found ${allMsgs.length}!`, getAssetIDByName("Check"));

    const latest = allMsgs[0];
    const link = `https://discord.com/channels/${latest.guildId}/${latest.channelId}/${latest.id}`;
    const cname = ChannelStore?.getChannel(latest.channelId)?.name || "unknown";

    setTimeout(() => {
        const ago = Date.now() - new Date(latest.timestamp).getTime();
        const m = Math.floor(ago / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
        showToast(`📍 #${cname} (${m < 60 ? m + 'm' : h < 24 ? h + 'h' : d + 'd'})`, getAssetIDByName("ic_message"));
    }, 1500);

    setTimeout(() => { if (Clipboard?.setString) { Clipboard.setString(link); showToast(`📋 Copied!`, getAssetIDByName("Check")); } }, 3000);
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

// ========================================
// SETTINGS UI
// ========================================

function StalkerSettings() {
    const [activeTab, setActiveTab] = React.useState<'hidden' | 'perms' | 'search'>('hidden');
    const [hiddenChannels, setHiddenChannels] = React.useState<HiddenChannel[]>([]);
    const [isScanning, setIsScanning] = React.useState(false);
    const [selectedGuild, setSelectedGuild] = React.useState<any>(null);
    const [selectedChannel, setSelectedChannel] = React.useState<HiddenChannel | null>(null);
    const [debugInfo, setDebugInfo] = React.useState("");
    const [userId, setUserId] = React.useState("");
    const [isSearchingUser, setIsSearchingUser] = React.useState(false);
    const [, forceUpdate] = React.useState(0);

    React.useEffect(() => { scanCurrentGuild(); }, []);

    // Re-fetch permissions when channel selected to get updated member data
    React.useEffect(() => {
        if (selectedChannel && selectedChannel.permissions.userIds.length > 0) {
            // Request member data for users in this channel
            requestGuildMembers(selectedChannel.guildId, selectedChannel.permissions.userIds);

            // Re-render after short delay to pick up fetched data
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
                const all = getAllGuildChannels(guildId);
                setDebugInfo(`${all.length} ch → ${channels.length} hidden`);
                showToast(channels.length > 0 ? `🔒 ${channels.length} hidden!` : `✨ No hidden`, getAssetIDByName("Check"));
            } else {
                setSelectedGuild(null); setHiddenChannels([]); setDebugInfo("Open server first");
            }
        } catch (e) { setDebugInfo(`Error: ${e}`); }
        finally { setIsScanning(false); }
    };

    // Refresh the selected channel's permissions
    const refreshSelectedChannel = () => {
        if (selectedChannel && selectedGuild) {
            const channel = ChannelStore?.getChannel?.(selectedChannel.id);
            if (channel) {
                const updated: HiddenChannel = {
                    ...selectedChannel,
                    permissions: getChannelPermissions(channel, selectedGuild.id)
                };
                setSelectedChannel(updated);
                showToast("🔄 Refreshed!", getAssetIDByName("Check"));
            }
        }
    };

    const handleUserSearch = async () => {
        if (!userId || userId.length < 17) return;
        setIsSearchingUser(true);
        await autoSearchUser(userId);
        setIsSearchingUser(false);
    };

    const roleColor = (c: number) => c ? `#${c.toString(16).padStart(6, '0')}` : '#99AAB5';

    const TabBtn = ({ id, label, icon }: any) =>
        React.createElement(TouchableOpacity, {
            style: { flex: 1, padding: 10, backgroundColor: activeTab === id ? '#5865F2' : '#2b2d31', borderRadius: 8, marginHorizontal: 2 },
            onPress: () => { setActiveTab(id); if (id !== 'perms') setSelectedChannel(null); }
        }, React.createElement(Text, { style: { color: '#fff', textAlign: 'center', fontSize: 12, fontWeight: activeTab === id ? 'bold' : 'normal' } }, `${icon} ${label}`));

    return React.createElement(ScrollView, { style: { flex: 1, backgroundColor: '#1e1f22' } }, [
        // Header
        React.createElement(View, { key: 'h', style: { padding: 16, backgroundColor: '#2b2d31', marginBottom: 8 } }, [
            React.createElement(Text, { key: 't', style: { color: '#fff', fontSize: 20, fontWeight: 'bold', textAlign: 'center' } }, "🔍 Stalker Pro v4.2"),
            React.createElement(Text, { key: 's', style: { color: '#b5bac1', fontSize: 12, textAlign: 'center', marginTop: 4 } }, selectedGuild ? `📍 ${selectedGuild.name}` : "Open a server")
        ]),

        // Tabs
        React.createElement(View, { key: 'tabs', style: { flexDirection: 'row', padding: 8, marginBottom: 8 } }, [
            React.createElement(TabBtn, { key: '1', id: 'hidden', label: 'Hidden', icon: '🔒' }),
            React.createElement(TabBtn, { key: '2', id: 'perms', label: 'Perms', icon: '🔐' }),
            React.createElement(TabBtn, { key: '3', id: 'search', label: 'Msgs', icon: '💬' })
        ]),

        // === HIDDEN TAB ===
        activeTab === 'hidden' && [
            React.createElement(TouchableOpacity, { key: 'scan', style: { margin: 12, padding: 14, backgroundColor: '#5865F2', borderRadius: 12, alignItems: 'center' }, onPress: scanCurrentGuild },
                React.createElement(Text, { style: { color: '#fff', fontWeight: 'bold', fontSize: 16 } }, isScanning ? "⏳..." : "🔄 Scan Server")),
            React.createElement(Text, { key: 'dbg', style: { color: '#949ba4', textAlign: 'center', fontSize: 11, marginBottom: 8 } }, debugInfo),

            ...hiddenChannels.map((ch, i) =>
                React.createElement(TouchableOpacity, { key: `c${i}`, style: { margin: 8, marginTop: 4, padding: 14, backgroundColor: '#2b2d31', borderRadius: 12, borderLeftWidth: 4, borderLeftColor: '#5865F2' }, onPress: () => { setSelectedChannel(ch); setActiveTab('perms'); } }, [
                    React.createElement(View, { key: 'h', style: { flexDirection: 'row', alignItems: 'center' } }, [
                        React.createElement(Text, { key: 'i', style: { fontSize: 18, marginRight: 10 } }, getChannelTypeName(ch.type)),
                        React.createElement(View, { key: 'n', style: { flex: 1 } }, [
                            React.createElement(Text, { key: 'nm', style: { color: '#fff', fontSize: 16, fontWeight: 'bold' } }, ch.name),
                            ch.parentName && React.createElement(Text, { key: 'p', style: { color: '#949ba4', fontSize: 12 } }, `in ${ch.parentName}`)
                        ]),
                        React.createElement(Text, { key: 'a', style: { color: '#5865F2', fontSize: 12 } }, "View →")
                    ]),
                    React.createElement(Text, { key: 'r', style: { color: '#00b894', fontSize: 12, marginTop: 6 } },
                        `🏷️ ${ch.permissions.overwrites.filter(o => o.type === 'role').length} roles • 👤 ${ch.permissions.overwrites.filter(o => o.type === 'user').length} users`)
                ])),

            hiddenChannels.length === 0 && !isScanning && React.createElement(View, { key: 'empty', style: { padding: 30, alignItems: 'center' } }, [
                React.createElement(Text, { key: 'e1', style: { fontSize: 40 } }, "🔓"),
                React.createElement(Text, { key: 'e2', style: { color: '#fff', fontSize: 16, marginTop: 10 } }, selectedGuild ? "No hidden channels" : "Open a server")
            ])
        ],

        // === PERMISSIONS TAB ===
        activeTab === 'perms' && [
            !selectedChannel && React.createElement(View, { key: 'no-sel', style: { padding: 30, alignItems: 'center' } }, [
                React.createElement(Text, { key: 't1', style: { fontSize: 40 } }, "🔐"),
                React.createElement(Text, { key: 't2', style: { color: '#fff', fontSize: 16, marginTop: 10 } }, "Select a channel"),
                React.createElement(Text, { key: 't3', style: { color: '#b5bac1', fontSize: 12, marginTop: 4, textAlign: 'center' } }, "Go to Hidden tab and tap a channel")
            ]),

            selectedChannel && [
                // Channel header
                React.createElement(View, { key: 'ch-header', style: { padding: 16, backgroundColor: '#2b2d31', margin: 8, borderRadius: 12 } }, [
                    React.createElement(View, { key: 'row', style: { flexDirection: 'row', alignItems: 'center' } }, [
                        React.createElement(Text, { key: 'icon', style: { fontSize: 24, marginRight: 12 } }, getChannelTypeName(selectedChannel.type)),
                        React.createElement(View, { key: 'info', style: { flex: 1 } }, [
                            React.createElement(Text, { key: 'name', style: { color: '#fff', fontSize: 18, fontWeight: 'bold' } }, selectedChannel.name),
                            selectedChannel.parentName && React.createElement(Text, { key: 'cat', style: { color: '#b5bac1', fontSize: 12 } }, `in ${selectedChannel.parentName}`)
                        ])
                    ])
                ]),

                // Refresh & Copy ID buttons
                React.createElement(View, { key: 'btns', style: { flexDirection: 'row', margin: 8, marginTop: 0 } }, [
                    React.createElement(TouchableOpacity, { key: 'refresh', style: { flex: 1, padding: 10, backgroundColor: '#3f4147', borderRadius: 8, marginRight: 4, alignItems: 'center' }, onPress: refreshSelectedChannel },
                        React.createElement(Text, { style: { color: '#fff', fontSize: 12 } }, "🔄 Refresh")),
                    React.createElement(TouchableOpacity, { key: 'copy', style: { flex: 1, padding: 10, backgroundColor: '#3f4147', borderRadius: 8, marginLeft: 4, alignItems: 'center' }, onPress: () => { if (Clipboard?.setString) { Clipboard.setString(selectedChannel.id); showToast("📋 ID copied", getAssetIDByName("Check")); } } },
                        React.createElement(Text, { style: { color: '#b5bac1', fontSize: 10 } }, `📋 ${selectedChannel.id}`))
                ]),

                // Stats
                React.createElement(Text, { key: 'stats', style: { color: '#5865F2', fontSize: 12, textAlign: 'center', marginVertical: 8 } },
                    `🏷️ ${selectedChannel.permissions.overwrites.filter(o => o.type === 'role').length} Roles • 👤 ${selectedChannel.permissions.overwrites.filter(o => o.type === 'user').length} Individual Users`),

                // Permission overwrites
                React.createElement(Text, { key: 'perms-title', style: { color: '#fff', fontSize: 14, fontWeight: 'bold', marginLeft: 12, marginTop: 8 } }, "🔐 Permission Overwrites"),

                ...selectedChannel.permissions.overwrites.map((ow, i) =>
                    React.createElement(View, { key: `ow-${i}`, style: { margin: 8, marginTop: 6, padding: 12, backgroundColor: '#2b2d31', borderRadius: 12, borderLeftWidth: 3, borderLeftColor: ow.type === 'role' ? (ow.color || '#5865F2') : '#43b581' } }, [
                        // Overwrite header
                        React.createElement(View, { key: 'hdr', style: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 } }, [
                            React.createElement(Text, { key: 'type', style: { fontSize: 14, marginRight: 8 } }, ow.type === 'role' ? '🏷️' : '👤'),
                            React.createElement(View, { key: 'name-wrap', style: { flex: 1 } }, [
                                React.createElement(Text, { key: 'name', style: { color: ow.type === 'role' ? roleColor(ow.color) : '#43b581', fontSize: 14, fontWeight: 'bold' } }, ow.name),
                                ow.isUnknown && React.createElement(Text, { key: 'id', style: { color: '#949ba4', fontSize: 10 } }, `ID: ${ow.id}`)
                            ]),
                            React.createElement(View, { key: 'badge', style: { backgroundColor: ow.type === 'role' ? '#5865F2' : '#43b581', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4 } },
                                React.createElement(Text, { style: { color: '#fff', fontSize: 9, fontWeight: 'bold' } }, ow.type === 'role' ? 'ROLE' : 'USER'))
                        ]),

                        // Allowed permissions
                        ow.allowed.length > 0 && React.createElement(View, { key: 'allowed', style: { marginTop: 4 } }, [
                            React.createElement(Text, { key: 'title', style: { color: '#43b581', fontSize: 11, fontWeight: 'bold', marginBottom: 4 } }, `✅ ALLOWED (${ow.allowed.length}):`),
                            React.createElement(View, { key: 'perms', style: { flexDirection: 'row', flexWrap: 'wrap' } },
                                ow.allowed.map((p, pi) =>
                                    React.createElement(Text, { key: `a${pi}`, style: { color: '#43b581', fontSize: 10, backgroundColor: 'rgba(67,181,129,0.15)', paddingHorizontal: 6, paddingVertical: 3, borderRadius: 4, marginRight: 4, marginBottom: 4 } }, p)))
                        ]),

                        // Denied permissions
                        ow.denied.length > 0 && React.createElement(View, { key: 'denied', style: { marginTop: 6 } }, [
                            React.createElement(Text, { key: 'title', style: { color: '#ed4245', fontSize: 11, fontWeight: 'bold', marginBottom: 4 } }, `❌ DENIED (${ow.denied.length}):`),
                            React.createElement(View, { key: 'perms', style: { flexDirection: 'row', flexWrap: 'wrap' } },
                                ow.denied.map((p, pi) =>
                                    React.createElement(Text, { key: `d${pi}`, style: { color: '#ed4245', fontSize: 10, backgroundColor: 'rgba(237,66,69,0.15)', paddingHorizontal: 6, paddingVertical: 3, borderRadius: 4, marginRight: 4, marginBottom: 4 } }, p)))
                        ]),

                        ow.allowed.length === 0 && ow.denied.length === 0 && React.createElement(Text, { key: 'none', style: { color: '#949ba4', fontSize: 11, fontStyle: 'italic' } }, "No specific permissions")
                    ])
                ),

                selectedChannel.permissions.overwrites.length === 0 && React.createElement(View, { key: 'no-perms', style: { padding: 20, alignItems: 'center' } },
                    React.createElement(Text, { style: { color: '#949ba4', fontSize: 12 } }, "No permission overwrites"))
            ]
        ],

        // === SEARCH TAB ===
        activeTab === 'search' && [
            React.createElement(FormSection, { key: 'auto', title: "💬 MESSAGES" }, [
                React.createElement(FormRow, { key: 'a1', label: "📋 Auto-detect", subLabel: clipboardMonitorActive ? "✅ Copy User ID to search" : "❌" })
            ]),
            React.createElement(FormSection, { key: 'man', title: "🔍 SEARCH" }, [
                React.createElement(FormInput, { key: 'in', title: "User ID", value: userId, onChangeText: setUserId, keyboardType: "numeric" }),
                React.createElement(FormRow, { key: 'btn', label: isSearchingUser ? "⏳..." : "🔍 Find", onPress: handleUserSearch })
            ])
        ]
    ]);
}

export const settings = StalkerSettings;

export const onLoad = () => {
    logger.log("=== STALKER PRO v4.2 ===");

    if (Permissions?.can) {
        patches.push(after("can", Permissions, ([permID, channel], res) => {
            if (channel?.realCheck) return res;
            if (permID === VIEW_CHANNEL) return true;
            return res;
        }));
        logger.log("✅ Patched Permissions.can");
    }

    if (Clipboard?.getString) {
        clipboardMonitorActive = true;
        checkIntervalId = setInterval(checkClipboardContent, 2000);
    }

    showToast("🔍 Stalker Pro v4.2", getAssetIDByName("Check"));
};

export const onUnload = () => {
    if (checkIntervalId) { clearInterval(checkIntervalId); checkIntervalId = null; }
    for (const p of patches) { try { p(); } catch { } }
    patches = [];
};
