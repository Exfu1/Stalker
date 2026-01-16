import { logger } from "@vendetta";
import { findByStoreName, findByProps } from "@vendetta/metro";
import { React, ReactNative, FluxDispatcher } from "@vendetta/metro/common";
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
const PermissionStore = findByStoreName("PermissionStore");

// Get the raw GuildChannelStore module to patch
const GuildChannelStoreModule = findByProps("getChannels", "getSelectableChannelIds");

// Clipboard
const Clipboard = ReactNative?.Clipboard || findByProps("setString", "getString");

// REST API
const RestAPI = findByProps("getAPIBaseURL", "get") || findByProps("API_HOST", "get");

// Permission bit for VIEW_CHANNEL
const VIEW_CHANNEL = 1024;
const CONNECT = 1048576;

// Storage
let clipboardMonitorActive = false;
let lastCheckedClipboard = "";
let checkIntervalId: any = null;
let patches: (() => void)[] = [];
let cachedHiddenChannels: Map<string, any[]> = new Map();

// ========================================
// HIDDEN CHANNEL DETECTION
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

// Check if a channel is hidden (user can't VIEW_CHANNEL)
function isHiddenChannel(channel: any): boolean {
    if (!channel || !PermissionStore) return false;

    try {
        // Check if we can view this channel
        const canView = PermissionStore.can?.(VIEW_CHANNEL, channel);
        return canView === false;
    } catch {
        return false;
    }
}

// Get ALL channels for a guild, including hidden ones
function getAllGuildChannels(guildId: string): any[] {
    const channels: any[] = [];

    try {
        // Method 1: Try GuildChannelStore with our patch
        if (GuildChannelStoreModule?.getChannels) {
            const result = GuildChannelStoreModule.getChannels(guildId);
            logger.log("getChannels result keys:", Object.keys(result || {}));

            if (result) {
                // The result has categories like SELECTABLE, VOCAL, etc.
                for (const key of Object.keys(result)) {
                    const categoryChannels = result[key];
                    if (Array.isArray(categoryChannels)) {
                        for (const item of categoryChannels) {
                            const ch = item?.channel || item;
                            if (ch?.id && ch?.guild_id === guildId) {
                                channels.push(ch);
                            }
                        }
                    }
                }
            }
        }

        // Method 2: Also try getting raw channels from ChannelStore
        const rawChannels = ChannelStore?.getMutableGuildChannelsForGuild?.(guildId) ||
            ChannelStore?.getGuildChannels?.(guildId) ||
            {};

        for (const channel of Object.values(rawChannels) as any[]) {
            if (channel?.id && channel?.guild_id === guildId) {
                // Add if not already present
                if (!channels.find(c => c.id === channel.id)) {
                    channels.push(channel);
                }
            }
        }

        logger.log("Total channels from all methods:", channels.length);

    } catch (e) {
        logger.error("getAllGuildChannels error:", e);
    }

    return channels;
}

// Get hidden channels for a guild
function getHiddenChannels(guildId: string): HiddenChannel[] {
    const hidden: HiddenChannel[] = [];

    try {
        logger.log("=== SCANNING HIDDEN CHANNELS ===");
        logger.log("GuildChannelStoreModule:", !!GuildChannelStoreModule);
        logger.log("PermissionStore:", !!PermissionStore);

        const allChannels = getAllGuildChannels(guildId);
        logger.log("All channels count:", allChannels.length);

        for (const channel of allChannels) {
            if (!channel?.id) continue;

            // Skip categories, DMs, threads
            if (channel.type === 4) continue; // Category
            if (channel.type === 1 || channel.type === 3) continue; // DMs
            if (channel.type === 11 || channel.type === 12) continue; // Threads

            // Check if hidden
            if (isHiddenChannel(channel)) {
                const roles = getChannelRoles(channel, guildId);

                hidden.push({
                    id: channel.id,
                    name: channel.name || "unknown",
                    type: channel.type || 0,
                    parentName: channel.parent_id ?
                        (ChannelStore?.getChannel?.(channel.parent_id)?.name || "") : "",
                    rolesWithAccess: roles
                });
            }
        }

        logger.log("Hidden channels found:", hidden.length);

        // Cache for user lookup
        cachedHiddenChannels.set(guildId, hidden);

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

            if ((allow & VIEW_CHANNEL) !== 0) {
                if (ow.type === 0 || ow.type === "role") {
                    const role = guild?.roles?.[id];
                    if (role && role.name !== "@everyone") {
                        roles.push({
                            id: role.id,
                            name: role.name,
                            color: role.color || 0
                        });
                    }
                }
            }
        }
    } catch { }
    return roles;
}

function getUserHiddenAccess(guildId: string, userId: string): HiddenChannel[] {
    // Use cached hidden channels or scan
    let hidden = cachedHiddenChannels.get(guildId);
    if (!hidden) {
        hidden = getHiddenChannels(guildId);
    }

    const member = GuildMemberStore?.getMember?.(guildId, userId);
    if (!member?.roles) return [];

    return hidden.filter(ch =>
        ch.rolesWithAccess.some(r => member.roles.includes(r.id))
    );
}

// ========================================
// MESSAGE SEARCH
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
            query: {
                author_id: authorId,
                include_nsfw: true,
                sort_by: "timestamp",
                sort_order: "desc"
            }
        });

        return (res?.body?.messages || []).map((m: any[]) => ({
            id: m[0].id,
            content: m[0].content || "[No text]",
            channelId: m[0].channel_id,
            guildId,
            timestamp: m[0].timestamp
        }));
    } catch { return []; }
}

function getChannelName(id: string) { return ChannelStore?.getChannel(id)?.name || "unknown"; }
function getGuildName(id: string) { return GuildStore?.getGuild(id)?.name || "Unknown"; }
function getUserInfo(id: string) {
    const u = UserStore?.getUser(id);
    return u ? { username: u.username, globalName: u.globalName, id: u.id } : null;
}

function isUserIdFormat(text: string): boolean {
    return text ? /^\d{17,19}$/.test(text.trim()) : false;
}

async function autoSearchUser(userId: string) {
    const currentUser = UserStore?.getCurrentUser?.();
    if (currentUser && userId === currentUser.id) return;

    const guilds = getMutualGuilds(userId);
    const userInfo = getUserInfo(userId);

    if (guilds.length === 0) {
        showToast("❌ No mutual servers", getAssetIDByName("Small"));
        return;
    }

    const displayName = userInfo?.globalName || userInfo?.username || `User`;
    showToast(`🔍 Searching ${displayName}...`, getAssetIDByName("ic_search"));

    let allMsgs: any[] = [];

    for (let i = 0; i < Math.min(guilds.length, 8); i++) {
        try {
            const msgs = await searchMessagesInGuild(guilds[i].id, userId);
            allMsgs.push(...msgs);
        } catch { }
        if (i < guilds.length - 1) await new Promise(r => setTimeout(r, 250));
    }

    // Sort by timestamp descending
    allMsgs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    if (allMsgs.length === 0) {
        showToast(`📭 No messages found`, getAssetIDByName("Small"));
        return;
    }

    showToast(`✅ Found ${allMsgs.length} messages!`, getAssetIDByName("Check"));

    const latest = allMsgs[0];
    const channelName = getChannelName(latest.channelId);
    const guildName = getGuildName(latest.guildId);
    const messageLink = `https://discord.com/channels/${latest.guildId}/${latest.channelId}/${latest.id}`;

    // Calculate time ago
    const msgDate = new Date(latest.timestamp);
    const diffMs = Date.now() - msgDate.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    let timeAgo = diffMins < 60 ? `${diffMins}m ago` :
        diffHours < 24 ? `${diffHours}h ago` : `${diffDays}d ago`;

    setTimeout(() => {
        showToast(`📍 #${channelName} (${timeAgo})`, getAssetIDByName("ic_message"));
    }, 1500);

    setTimeout(async () => {
        if (Clipboard?.setString) {
            Clipboard.setString(messageLink);
            showToast(`📋 Link copied!`, getAssetIDByName("Check"));
        }
    }, 3000);
}

async function checkClipboardContent() {
    try {
        if (!Clipboard?.getString) return;
        const content = await Clipboard.getString();

        if (content && content !== lastCheckedClipboard && isUserIdFormat(content)) {
            lastCheckedClipboard = content;
            showToast(`🎯 User ID detected!`, getAssetIDByName("Check"));
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
        setDebugInfo("Scanning...");

        try {
            const guildId = SelectedGuildStore?.getGuildId?.();

            if (guildId) {
                const guild = GuildStore?.getGuild?.(guildId);
                setSelectedGuild(guild);

                const channels = getHiddenChannels(guildId);
                setHiddenChannels(channels);

                const allChannels = getAllGuildChannels(guildId);
                setDebugInfo(`Total: ${allChannels.length} | Hidden: ${channels.length}`);

                if (channels.length > 0) {
                    showToast(`🔒 Found ${channels.length} hidden!`, getAssetIDByName("Check"));
                } else {
                    showToast(`✨ No hidden channels`, getAssetIDByName("Check"));
                }
            } else {
                setSelectedGuild(null);
                setHiddenChannels([]);
                setDebugInfo("No server selected");
                showToast("Open a server first!", getAssetIDByName("Small"));
            }
        } catch (e) {
            logger.error("Scan error:", e);
            setDebugInfo(`Error: ${e}`);
        } finally {
            setIsScanning(false);
        }
    };

    const handleUserSearch = async () => {
        if (!userId || userId.length < 17) {
            showToast("Enter valid User ID", getAssetIDByName("Small"));
            return;
        }
        setIsSearchingUser(true);
        await autoSearchUser(userId);
        setIsSearchingUser(false);
    };

    const handleUserLookup = () => {
        if (!lookupUserId || lookupUserId.length < 17) {
            showToast("Enter valid User ID", getAssetIDByName("Small"));
            return;
        }

        const guildId = SelectedGuildStore?.getGuildId?.();
        if (!guildId) {
            showToast("Open a server first!", getAssetIDByName("Small"));
            return;
        }

        const channels = getUserHiddenAccess(guildId, lookupUserId);
        setUserChannels(channels);

        const user = UserStore?.getUser?.(lookupUserId);
        const name = user?.globalName || user?.username || "User";
        showToast(`${name}: ${channels.length} hidden`, getAssetIDByName("Check"));
    };

    const roleColor = (c: number) => c ? `#${c.toString(16).padStart(6, '0')}` : '#99AAB5';

    const TabBtn = ({ id, label, icon }: any) =>
        React.createElement(TouchableOpacity, {
            style: {
                flex: 1, padding: 10,
                backgroundColor: activeTab === id ? '#5865F2' : '#2b2d31',
                borderRadius: 8, marginHorizontal: 2
            },
            onPress: () => setActiveTab(id)
        }, React.createElement(Text, {
            style: { color: '#fff', textAlign: 'center', fontSize: 12, fontWeight: activeTab === id ? 'bold' : 'normal' }
        }, `${icon} ${label}`));

    return React.createElement(ScrollView, { style: { flex: 1, backgroundColor: '#1e1f22' } }, [
        // Header
        React.createElement(View, { key: 'h', style: { padding: 16, backgroundColor: '#2b2d31', marginBottom: 8 } }, [
            React.createElement(Text, { key: 't', style: { color: '#fff', fontSize: 20, fontWeight: 'bold', textAlign: 'center' } },
                "🔍 Stalker Pro v3.2"),
            React.createElement(Text, { key: 's', style: { color: '#b5bac1', fontSize: 12, textAlign: 'center', marginTop: 4 } },
                selectedGuild ? `📍 ${selectedGuild.name}` : "Open a server to scan")
        ]),

        // Tabs
        React.createElement(View, { key: 'tabs', style: { flexDirection: 'row', padding: 8, marginBottom: 8 } }, [
            React.createElement(TabBtn, { key: '1', id: 'hidden', label: 'Hidden', icon: '🔒' }),
            React.createElement(TabBtn, { key: '2', id: 'user', label: 'User', icon: '👤' }),
            React.createElement(TabBtn, { key: '3', id: 'search', label: 'Messages', icon: '💬' })
        ]),

        // === HIDDEN TAB ===
        activeTab === 'hidden' && [
            React.createElement(TouchableOpacity, {
                key: 'scan',
                style: { margin: 12, padding: 14, backgroundColor: '#5865F2', borderRadius: 12, alignItems: 'center' },
                onPress: scanCurrentGuild
            }, React.createElement(Text, { style: { color: '#fff', fontWeight: 'bold', fontSize: 16 } },
                isScanning ? "⏳ Scanning..." : "🔄 Scan Current Server")),

            React.createElement(Text, { key: 'debug', style: { color: '#949ba4', textAlign: 'center', fontSize: 11, marginBottom: 8 } },
                debugInfo),

            ...hiddenChannels.map((ch, i) =>
                React.createElement(TouchableOpacity, {
                    key: `c${i}`,
                    style: { margin: 8, marginTop: 4, padding: 14, backgroundColor: '#2b2d31', borderRadius: 12, borderLeftWidth: 4, borderLeftColor: '#5865F2' },
                    onPress: () => setExpandedChannel(expandedChannel === ch.id ? null : ch.id)
                }, [
                    React.createElement(View, { key: 'h', style: { flexDirection: 'row', alignItems: 'center' } }, [
                        React.createElement(Text, { key: 'i', style: { fontSize: 18, marginRight: 10 } }, getChannelTypeName(ch.type)),
                        React.createElement(View, { key: 'n', style: { flex: 1 } }, [
                            React.createElement(Text, { key: 'nm', style: { color: '#fff', fontSize: 16, fontWeight: 'bold' } }, ch.name),
                            ch.parentName && React.createElement(Text, { key: 'p', style: { color: '#949ba4', fontSize: 12 } }, `in ${ch.parentName}`)
                        ]),
                        React.createElement(Text, { key: 'a', style: { color: '#b5bac1' } }, expandedChannel === ch.id ? "▼" : "▶")
                    ]),
                    React.createElement(Text, { key: 'r', style: { color: '#00b894', fontSize: 12, marginTop: 6 } },
                        `👥 ${ch.rolesWithAccess.length} roles`),

                    expandedChannel === ch.id && React.createElement(View, { key: 'd', style: { marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#3f4147' } },
                        ch.rolesWithAccess.length > 0
                            ? ch.rolesWithAccess.map((r: any, ri: number) =>
                                React.createElement(Text, { key: `r${ri}`, style: { color: roleColor(r.color), marginLeft: 12, marginTop: 2, fontSize: 14 } }, `• ${r.name}`)
                            )
                            : [React.createElement(Text, { key: 'no', style: { color: '#949ba4', marginLeft: 12 } }, "No role overwrites")]
                    )
                ])
            ),

            hiddenChannels.length === 0 && !isScanning && React.createElement(View, { key: 'empty', style: { padding: 30, alignItems: 'center' } }, [
                React.createElement(Text, { key: 'e1', style: { fontSize: 40 } }, "✨"),
                React.createElement(Text, { key: 'e2', style: { color: '#fff', fontSize: 16, marginTop: 10 } },
                    selectedGuild ? "No hidden channels found" : "Open a server first"),
                React.createElement(Text, { key: 'e3', style: { color: '#b5bac1', marginTop: 4, textAlign: 'center', fontSize: 12 } },
                    "Make sure you're in a server with private channels")
            ])
        ],

        // === USER TAB ===
        activeTab === 'user' && [
            React.createElement(FormSection, { key: 'us', title: "👤 USER HIDDEN ACCESS" }, [
                React.createElement(FormInput, { key: 'in', title: "User ID", placeholder: "Enter User ID", value: lookupUserId, onChangeText: setLookupUserId, keyboardType: "numeric" }),
                React.createElement(FormRow, { key: 'btn', label: "🔍 Check Access", subLabel: selectedGuild ? `In ${selectedGuild.name}` : "Open server first", onPress: handleUserLookup })
            ]),

            userChannels.length > 0 && React.createElement(FormSection, { key: 'res', title: `✅ Can access ${userChannels.length} hidden:` },
                userChannels.map((ch, i) => React.createElement(FormRow, { key: `uc${i}`, label: `${getChannelTypeName(ch.type)} ${ch.name}`, subLabel: ch.parentName || undefined }))
            ),

            userChannels.length === 0 && lookupUserId.length >= 17 && React.createElement(View, { key: 'no', style: { padding: 30, alignItems: 'center' } }, [
                React.createElement(Text, { key: 'n1', style: { fontSize: 40 } }, "🚫"),
                React.createElement(Text, { key: 'n2', style: { color: '#fff', fontSize: 16, marginTop: 10 } }, "No hidden access")
            ])
        ],

        // === SEARCH TAB ===
        activeTab === 'search' && [
            React.createElement(FormSection, { key: 'auto', title: "💬 MESSAGE SEARCH" }, [
                React.createElement(FormRow, { key: 'a1', label: "📋 Auto-Detection", subLabel: clipboardMonitorActive ? "✅ Copy User ID to auto-search" : "❌ Inactive" }),
                React.createElement(FormRow, { key: 'a2', label: "⏱️ Most Recent First", subLabel: "Sorted by timestamp (newest)" })
            ]),
            React.createElement(FormSection, { key: 'man', title: "🔍 MANUAL SEARCH" }, [
                React.createElement(FormInput, { key: 'in', title: "User ID", placeholder: "Enter Discord User ID", value: userId, onChangeText: setUserId, keyboardType: "numeric" }),
                React.createElement(FormRow, { key: 'btn', label: isSearchingUser ? "⏳ Searching..." : "🔍 Find Messages", onPress: isSearchingUser ? undefined : handleUserSearch })
            ])
        ],

        // Footer
        React.createElement(View, { key: 'ft', style: { padding: 20, alignItems: 'center' } },
            React.createElement(Text, { style: { color: '#949ba4', fontSize: 10, textAlign: 'center' } },
                "💡 Copy User ID → auto-search"))
    ]);
}

export const settings = StalkerSettings;

export const onLoad = () => {
    logger.log("=== STALKER PRO v3.2 LOADING ===");
    logger.log("GuildChannelStoreModule:", !!GuildChannelStoreModule);
    logger.log("PermissionStore:", !!PermissionStore);

    // Start clipboard monitoring
    if (Clipboard?.getString) {
        clipboardMonitorActive = true;
        checkIntervalId = setInterval(checkClipboardContent, 2000);
    }

    showToast("🔍 Stalker Pro v3.2 ready!", getAssetIDByName("Check"));
};

export const onUnload = () => {
    logger.log("=== STALKER PRO UNLOADING ===");

    if (checkIntervalId) {
        clearInterval(checkIntervalId);
        checkIntervalId = null;
        clipboardMonitorActive = false;
    }

    // Unpatch
    for (const unpatch of patches) {
        try { unpatch(); } catch { }
    }
    patches = [];
};
