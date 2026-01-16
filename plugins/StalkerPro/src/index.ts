import { logger } from "@vendetta";
import { findByStoreName, findByProps } from "@vendetta/metro";
import { React, ReactNative, FluxDispatcher } from "@vendetta/metro/common";
import { Forms, General } from "@vendetta/ui/components";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { showToast } from "@vendetta/ui/toasts";
import { before, after } from "@vendetta/patcher";

const { FormSection, FormRow, FormInput } = Forms;
const { ScrollView, View, Text, TouchableOpacity } = General;

// Discord stores
const UserStore = findByStoreName("UserStore");
const GuildStore = findByStoreName("GuildStore");
const GuildMemberStore = findByStoreName("GuildMemberStore");
const ChannelStore = findByStoreName("ChannelStore");
const SelectedGuildStore = findByStoreName("SelectedGuildStore");
const PermissionStore = findByStoreName("PermissionStore");

// Get GuildChannelStore for patching
const GuildChannelStore = findByStoreName("GuildChannelStore");

// Clipboard
const Clipboard = ReactNative?.Clipboard || findByProps("setString", "getString");

// REST API  
const RestAPI = findByProps("getAPIBaseURL", "get") || findByProps("API_HOST", "get");

// Permission constants
const VIEW_CHANNEL_BIT = 1024;

// Storage
let clipboardMonitorActive = false;
let lastCheckedClipboard = "";
let checkIntervalId: any = null;
let patches: (() => void)[] = [];

// Cached channels with permission overrides (these indicate hidden channels)
let allGuildChannelsCache: Map<string, any[]> = new Map();

// ========================================
// PATCHING TO GET HIDDEN CHANNELS
// ========================================

function patchGuildChannelStore() {
    if (!GuildChannelStore) {
        logger.warn("GuildChannelStore not found for patching");
        return;
    }

    try {
        // Patch getChannels to log what it returns
        if (GuildChannelStore.getChannels) {
            const unpatch = after("getChannels", GuildChannelStore, (args: any[], result: any) => {
                // The result normally filters out hidden channels
                // We'll try to intercept and add hidden ones back
                logger.log("getChannels called for guild:", args[0]);
                return result;
            });
            patches.push(unpatch);
            logger.log("Patched GuildChannelStore.getChannels");
        }
    } catch (e) {
        logger.error("Failed to patch GuildChannelStore:", e);
    }
}

// ========================================
// HIDDEN CHANNEL DETECTION - Using ChannelStore directly
// ========================================

interface HiddenChannel {
    id: string;
    name: string;
    type: number;
    parentName: string;
    rolesWithAccess: any[];
}

function getChannelTypeName(type: number): string {
    switch (type) {
        case 0: return "💬";
        case 2: return "🔊";
        case 4: return "📁";
        case 5: return "📢";
        case 13: return "🎭";
        case 15: return "📋";
        default: return "📝";
    }
}

// Get ALL channels including hidden ones by checking the raw channel cache
function getAllChannelsIncludingHidden(guildId: string): any[] {
    const channels: any[] = [];

    try {
        // Method 1: Direct access to ChannelStore's internal state
        // ChannelStore should have ALL channels that Discord knows about
        const allChannels = ChannelStore?.getAllChannels?.() ||
            ChannelStore?.getChannels?.() ||
            {};

        // Filter to just this guild
        if (Array.isArray(allChannels)) {
            for (const ch of allChannels) {
                if (ch?.guild_id === guildId) channels.push(ch);
            }
        } else {
            for (const ch of Object.values(allChannels) as any[]) {
                if (ch?.guild_id === guildId) channels.push(ch);
            }
        }

        logger.log("Method 1 (getAllChannels) count:", channels.length);

        // Method 2: Try getMutableGuildChannelsForGuild
        if (channels.length === 0) {
            const guildChannels = ChannelStore?.getMutableGuildChannelsForGuild?.(guildId) || {};
            for (const ch of Object.values(guildChannels) as any[]) {
                if (ch?.id) channels.push(ch);
            }
            logger.log("Method 2 (getMutableGuildChannelsForGuild) count:", channels.length);
        }

        // Method 3: Check if there's a way to get raw channel data
        if (ChannelStore?.__getLocalVars) {
            try {
                const localVars = ChannelStore.__getLocalVars();
                logger.log("ChannelStore local vars keys:", Object.keys(localVars || {}));
            } catch { }
        }

    } catch (e) {
        logger.error("getAllChannelsIncludingHidden error:", e);
    }

    return channels;
}

// Check if a channel is hidden by examining permission overwrites
function isChannelHidden(channel: any): boolean {
    if (!channel || !PermissionStore) return false;

    try {
        // Try PermissionStore.can with the actual channel object
        const canView = PermissionStore.can?.(VIEW_CHANNEL_BIT, channel);

        if (canView === false) {
            return true;
        }

        // Alternative: Check if channel has deny overwrites for @everyone
        const overwrites = channel.permissionOverwrites || {};
        const guild = GuildStore?.getGuild?.(channel.guild_id);

        if (guild && overwrites[guild.id]) {
            const everyoneOverwrite = overwrites[guild.id];
            const deny = Number(everyoneOverwrite.deny || 0);

            // Check if VIEW_CHANNEL is denied for @everyone
            if ((deny & VIEW_CHANNEL_BIT) !== 0) {
                return true;
            }
        }

        return false;
    } catch {
        return false;
    }
}

function getHiddenChannels(guildId: string): HiddenChannel[] {
    const hidden: HiddenChannel[] = [];

    try {
        logger.log("=== SCANNING FOR HIDDEN CHANNELS ===");
        logger.log("Guild ID:", guildId);

        const channels = getAllChannelsIncludingHidden(guildId);
        logger.log("Total channels retrieved:", channels.length);

        // Log some sample channels for debugging
        if (channels.length > 0) {
            logger.log("Sample channel:", JSON.stringify({
                id: channels[0].id,
                name: channels[0].name,
                type: channels[0].type,
                hasOverwrites: !!channels[0].permissionOverwrites
            }));
        }

        let checkedCount = 0;
        let hiddenByPerms = 0;
        let hiddenByOverwrites = 0;

        for (const channel of channels) {
            if (!channel?.id) continue;
            if (channel.type === 4) continue; // Category
            if (channel.type === 1 || channel.type === 3) continue; // DMs
            if (channel.type === 11 || channel.type === 12) continue; // Threads

            checkedCount++;

            // Check using PermissionStore
            const canView = PermissionStore?.can?.(VIEW_CHANNEL_BIT, channel);

            if (canView === false) {
                hiddenByPerms++;
                hidden.push({
                    id: channel.id,
                    name: channel.name || "unknown",
                    type: channel.type || 0,
                    parentName: channel.parent_id ?
                        (ChannelStore?.getChannel?.(channel.parent_id)?.name || "") : "",
                    rolesWithAccess: getChannelRoles(channel, guildId)
                });
                continue;
            }

            // Also check if @everyone has VIEW_CHANNEL denied
            const overwrites = channel.permissionOverwrites || {};
            const everyoneId = guildId; // @everyone role has same ID as guild

            if (overwrites[everyoneId]) {
                const deny = Number(overwrites[everyoneId].deny || 0);
                if ((deny & VIEW_CHANNEL_BIT) !== 0) {
                    // @everyone is denied VIEW_CHANNEL
                    // Check if we have an allow somewhere
                    const user = UserStore?.getCurrentUser?.();
                    const member = GuildMemberStore?.getMember?.(guildId, user?.id);

                    let hasAccess = false;

                    // Check if any of our roles grant access
                    if (member?.roles) {
                        for (const roleId of member.roles) {
                            if (overwrites[roleId]) {
                                const allow = Number(overwrites[roleId].allow || 0);
                                if ((allow & VIEW_CHANNEL_BIT) !== 0) {
                                    hasAccess = true;
                                    break;
                                }
                            }
                        }
                    }

                    // If we don't have access, it's hidden
                    if (!hasAccess) {
                        hiddenByOverwrites++;
                        hidden.push({
                            id: channel.id,
                            name: channel.name || "unknown",
                            type: channel.type || 0,
                            parentName: channel.parent_id ?
                                (ChannelStore?.getChannel?.(channel.parent_id)?.name || "") : "",
                            rolesWithAccess: getChannelRoles(channel, guildId)
                        });
                    }
                }
            }
        }

        logger.log(`Checked: ${checkedCount}, HiddenByPerms: ${hiddenByPerms}, HiddenByOverwrites: ${hiddenByOverwrites}`);
        logger.log("Final hidden count:", hidden.length);

    } catch (e) {
        logger.error("getHiddenChannels error:", e);
    }

    return hidden.sort((a, b) => a.name.localeCompare(b.name));
}

function getChannelRoles(channel: any, guildId: string): any[] {
    const roles: any[] = [];
    try {
        const overwrites = channel.permissionOverwrites || {};
        const guild = GuildStore?.getGuild?.(guildId);

        for (const [id, ow] of Object.entries(overwrites) as any[]) {
            if (!ow) continue;
            const allow = Number(ow.allow || 0);

            if ((allow & VIEW_CHANNEL_BIT) !== 0) {
                if (ow.type === 0 || ow.type === "role") {
                    const role = guild?.roles?.[id];
                    if (role && role.name !== "@everyone") {
                        roles.push({ id: role.id, name: role.name, color: role.color || 0 });
                    }
                }
            }
        }
    } catch { }
    return roles;
}

function getUserHiddenAccess(guildId: string, userId: string): HiddenChannel[] {
    const hidden = getHiddenChannels(guildId);
    const member = GuildMemberStore?.getMember?.(guildId, userId);

    if (!member?.roles) return [];

    return hidden.filter(ch =>
        ch.rolesWithAccess.some(r => member.roles.includes(r.id))
    );
}

// ========================================
// MESSAGE SEARCH (unchanged)
// ========================================

function getMutualGuilds(userId: string) {
    if (!GuildStore || !GuildMemberStore) return [];
    try {
        const guilds = Object.values(GuildStore.getGuilds() || {}) as any[];
        return guilds.filter(g => GuildMemberStore.getMember(g.id, userId));
    } catch { return []; }
}

async function searchMessagesInGuild(guildId: string, authorId: string): Promise<any[]> {
    if (!RestAPI?.get) return [];
    try {
        const res = await RestAPI.get({
            url: `/guilds/${guildId}/messages/search`,
            query: { author_id: authorId, include_nsfw: true, sort_by: "timestamp", sort_order: "desc" }
        });
        return (res?.body?.messages || []).map((m: any[]) => ({
            id: m[0].id, content: m[0].content || "[No text]",
            channelId: m[0].channel_id, guildId, timestamp: m[0].timestamp
        }));
    } catch { return []; }
}

function getChannelName(id: string) { return ChannelStore?.getChannel(id)?.name || "unknown"; }
function getGuildName(id: string) { return GuildStore?.getGuild(id)?.name || "Unknown"; }

async function autoSearchUser(userId: string) {
    const currentUser = UserStore?.getCurrentUser?.();
    if (currentUser && userId === currentUser.id) return;

    const guilds = getMutualGuilds(userId);
    if (guilds.length === 0) {
        showToast("❌ No mutual servers", getAssetIDByName("Small"));
        return;
    }

    showToast(`🔍 Searching...`, getAssetIDByName("ic_search"));

    let allMsgs: any[] = [];
    for (let i = 0; i < Math.min(guilds.length, 8); i++) {
        try {
            allMsgs.push(...await searchMessagesInGuild(guilds[i].id, userId));
        } catch { }
        if (i < guilds.length - 1) await new Promise(r => setTimeout(r, 250));
    }

    allMsgs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    if (allMsgs.length === 0) {
        showToast(`📭 No messages`, getAssetIDByName("Small"));
        return;
    }

    showToast(`✅ Found ${allMsgs.length}!`, getAssetIDByName("Check"));

    const latest = allMsgs[0];
    const link = `https://discord.com/channels/${latest.guildId}/${latest.channelId}/${latest.id}`;

    setTimeout(() => {
        const d = new Date(latest.timestamp);
        const ago = Date.now() - d.getTime();
        const mins = Math.floor(ago / 60000);
        const hrs = Math.floor(mins / 60);
        const days = Math.floor(hrs / 24);
        const timeStr = mins < 60 ? `${mins}m` : hrs < 24 ? `${hrs}h` : `${days}d`;
        showToast(`📍 #${getChannelName(latest.channelId)} (${timeStr})`, getAssetIDByName("ic_message"));
    }, 1500);

    setTimeout(() => {
        if (Clipboard?.setString) {
            Clipboard.setString(link);
            showToast(`📋 Copied!`, getAssetIDByName("Check"));
        }
    }, 3000);
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
    const [activeTab, setActiveTab] = React.useState<'hidden' | 'user' | 'search'>('hidden');
    const [hiddenChannels, setHiddenChannels] = React.useState<HiddenChannel[]>([]);
    const [isScanning, setIsScanning] = React.useState(false);
    const [selectedGuild, setSelectedGuild] = React.useState<any>(null);
    const [expandedChannel, setExpandedChannel] = React.useState<string | null>(null);
    const [debugInfo, setDebugInfo] = React.useState("");
    const [lookupUserId, setLookupUserId] = React.useState("");
    const [userChannels, setUserChannels] = React.useState<HiddenChannel[]>([]);
    const [userId, setUserId] = React.useState("");
    const [isSearchingUser, setIsSearchingUser] = React.useState(false);

    React.useEffect(() => { scanCurrentGuild(); }, []);

    const scanCurrentGuild = () => {
        setIsScanning(true);
        try {
            const guildId = SelectedGuildStore?.getGuildId?.();
            if (guildId) {
                const guild = GuildStore?.getGuild?.(guildId);
                setSelectedGuild(guild);
                const channels = getHiddenChannels(guildId);
                setHiddenChannels(channels);
                const all = getAllChannelsIncludingHidden(guildId);
                setDebugInfo(`Scanned ${all.length} ch | Found ${channels.length} hidden`);
                showToast(channels.length > 0 ? `🔒 ${channels.length} hidden!` : `✨ No hidden`, getAssetIDByName("Check"));
            } else {
                setSelectedGuild(null);
                setHiddenChannels([]);
                setDebugInfo("Open a server first");
            }
        } catch (e) {
            setDebugInfo(`Error: ${e}`);
        } finally {
            setIsScanning(false);
        }
    };

    const handleUserSearch = async () => {
        if (!userId || userId.length < 17) return;
        setIsSearchingUser(true);
        await autoSearchUser(userId);
        setIsSearchingUser(false);
    };

    const handleUserLookup = () => {
        if (!lookupUserId || lookupUserId.length < 17) return;
        const guildId = SelectedGuildStore?.getGuildId?.();
        if (!guildId) return;
        const channels = getUserHiddenAccess(guildId, lookupUserId);
        setUserChannels(channels);
        showToast(`${channels.length} hidden access`, getAssetIDByName("Check"));
    };

    const roleColor = (c: number) => c ? `#${c.toString(16).padStart(6, '0')}` : '#99AAB5';

    const TabBtn = ({ id, label, icon }: any) =>
        React.createElement(TouchableOpacity, {
            style: { flex: 1, padding: 10, backgroundColor: activeTab === id ? '#5865F2' : '#2b2d31', borderRadius: 8, marginHorizontal: 2 },
            onPress: () => setActiveTab(id)
        }, React.createElement(Text, { style: { color: '#fff', textAlign: 'center', fontSize: 12, fontWeight: activeTab === id ? 'bold' : 'normal' } }, `${icon} ${label}`));

    return React.createElement(ScrollView, { style: { flex: 1, backgroundColor: '#1e1f22' } }, [
        React.createElement(View, { key: 'h', style: { padding: 16, backgroundColor: '#2b2d31', marginBottom: 8 } }, [
            React.createElement(Text, { key: 't', style: { color: '#fff', fontSize: 20, fontWeight: 'bold', textAlign: 'center' } }, "🔍 Stalker Pro v3.3"),
            React.createElement(Text, { key: 's', style: { color: '#b5bac1', fontSize: 12, textAlign: 'center', marginTop: 4 } }, selectedGuild ? `📍 ${selectedGuild.name}` : "Open a server")
        ]),

        React.createElement(View, { key: 'tabs', style: { flexDirection: 'row', padding: 8, marginBottom: 8 } }, [
            React.createElement(TabBtn, { key: '1', id: 'hidden', label: 'Hidden', icon: '🔒' }),
            React.createElement(TabBtn, { key: '2', id: 'user', label: 'User', icon: '👤' }),
            React.createElement(TabBtn, { key: '3', id: 'search', label: 'Msgs', icon: '💬' })
        ]),

        activeTab === 'hidden' && [
            React.createElement(TouchableOpacity, { key: 'scan', style: { margin: 12, padding: 14, backgroundColor: '#5865F2', borderRadius: 12, alignItems: 'center' }, onPress: scanCurrentGuild },
                React.createElement(Text, { style: { color: '#fff', fontWeight: 'bold', fontSize: 16 } }, isScanning ? "⏳ Scanning..." : "🔄 Scan Server")),
            React.createElement(Text, { key: 'dbg', style: { color: '#949ba4', textAlign: 'center', fontSize: 11, marginBottom: 8 } }, debugInfo),
            ...hiddenChannels.map((ch, i) =>
                React.createElement(TouchableOpacity, { key: `c${i}`, style: { margin: 8, marginTop: 4, padding: 14, backgroundColor: '#2b2d31', borderRadius: 12, borderLeftWidth: 4, borderLeftColor: '#5865F2' }, onPress: () => setExpandedChannel(expandedChannel === ch.id ? null : ch.id) }, [
                    React.createElement(View, { key: 'h', style: { flexDirection: 'row', alignItems: 'center' } }, [
                        React.createElement(Text, { key: 'i', style: { fontSize: 18, marginRight: 10 } }, getChannelTypeName(ch.type)),
                        React.createElement(View, { key: 'n', style: { flex: 1 } }, [
                            React.createElement(Text, { key: 'nm', style: { color: '#fff', fontSize: 16, fontWeight: 'bold' } }, ch.name),
                            ch.parentName && React.createElement(Text, { key: 'p', style: { color: '#949ba4', fontSize: 12 } }, `in ${ch.parentName}`)
                        ]),
                        React.createElement(Text, { key: 'a', style: { color: '#b5bac1' } }, expandedChannel === ch.id ? "▼" : "▶")
                    ]),
                    React.createElement(Text, { key: 'r', style: { color: '#00b894', fontSize: 12, marginTop: 6 } }, `👥 ${ch.rolesWithAccess.length} roles`),
                    expandedChannel === ch.id && React.createElement(View, { key: 'd', style: { marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#3f4147' } },
                        ch.rolesWithAccess.map((r: any, ri: number) => React.createElement(Text, { key: `r${ri}`, style: { color: roleColor(r.color), marginLeft: 12, marginTop: 2 } }, `• ${r.name}`)))
                ])),
            hiddenChannels.length === 0 && !isScanning && React.createElement(View, { key: 'empty', style: { padding: 30, alignItems: 'center' } }, [
                React.createElement(Text, { key: 'e1', style: { fontSize: 40 } }, selectedGuild ? "🔓" : "📍"),
                React.createElement(Text, { key: 'e2', style: { color: '#fff', fontSize: 16, marginTop: 10 } }, selectedGuild ? "No hidden channels" : "Open a server"),
                React.createElement(Text, { key: 'e3', style: { color: '#b5bac1', marginTop: 4, textAlign: 'center', fontSize: 11 } }, "Check Debug Logs for details")
            ])
        ],

        activeTab === 'user' && [
            React.createElement(FormSection, { key: 'us', title: "👤 USER ACCESS" }, [
                React.createElement(FormInput, { key: 'in', title: "User ID", placeholder: "Enter ID", value: lookupUserId, onChangeText: setLookupUserId, keyboardType: "numeric" }),
                React.createElement(FormRow, { key: 'btn', label: "🔍 Check", onPress: handleUserLookup })
            ]),
            userChannels.length > 0 && React.createElement(FormSection, { key: 'res', title: `✅ ${userChannels.length} hidden:` },
                userChannels.map((ch, i) => React.createElement(FormRow, { key: `uc${i}`, label: `${getChannelTypeName(ch.type)} ${ch.name}` })))
        ],

        activeTab === 'search' && [
            React.createElement(FormSection, { key: 'auto', title: "💬 MESSAGES" }, [
                React.createElement(FormRow, { key: 'a1', label: "📋 Auto-detect", subLabel: clipboardMonitorActive ? "✅ Active" : "❌" })
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
    logger.log("=== STALKER PRO v3.3 ===");

    // Apply patches
    patchGuildChannelStore();

    if (Clipboard?.getString) {
        clipboardMonitorActive = true;
        checkIntervalId = setInterval(checkClipboardContent, 2000);
    }

    showToast("🔍 Stalker Pro v3.3", getAssetIDByName("Check"));
};

export const onUnload = () => {
    if (checkIntervalId) { clearInterval(checkIntervalId); checkIntervalId = null; }
    for (const p of patches) { try { p(); } catch { } }
    patches = [];
};
