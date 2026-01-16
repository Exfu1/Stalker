import { logger } from "@vendetta";
import { findByStoreName, findByProps } from "@vendetta/metro";
import { React, ReactNative, FluxDispatcher } from "@vendetta/metro/common";
import { Forms, General } from "@vendetta/ui/components";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { showToast } from "@vendetta/ui/toasts";

const { FormSection, FormRow, FormInput, FormDivider, FormSwitchRow } = Forms;
const { ScrollView, View, Text, TouchableOpacity, ActivityIndicator } = General;

// Discord stores
const UserStore = findByStoreName("UserStore");
const GuildStore = findByStoreName("GuildStore");
const GuildMemberStore = findByStoreName("GuildMemberStore");
const ChannelStore = findByStoreName("ChannelStore");
const SelectedGuildStore = findByStoreName("SelectedGuildStore");
const PermissionStore = findByStoreName("PermissionStore");
const GuildChannelStore = findByStoreName("GuildChannelStore");

// Clipboard
const Clipboard = ReactNative?.Clipboard || findByProps("setString", "getString");

// REST API
const RestAPI = findByProps("getAPIBaseURL", "get") || findByProps("API_HOST", "get");

// Permission constants
const VIEW_CHANNEL = 1024;

// Storage
let clipboardMonitorActive = false;
let lastCheckedClipboard = "";
let checkIntervalId: any = null;

// ========================================
// HIDDEN CHANNEL DETECTION LOGIC
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

// Get hidden channels using GuildChannelStore which knows about ALL channels
function getHiddenChannels(guildId: string): HiddenChannel[] {
    const hidden: HiddenChannel[] = [];

    try {
        logger.log("=== SCANNING FOR HIDDEN CHANNELS ===");
        logger.log("Guild ID:", guildId);

        // Method 1: Try GuildChannelStore.getChannels which includes hidden ones
        let allChannels: any[] = [];

        if (GuildChannelStore?.getChannels) {
            const channelData = GuildChannelStore.getChannels(guildId);
            logger.log("GuildChannelStore.getChannels result:", JSON.stringify(Object.keys(channelData || {})));

            // It returns an object with different channel categories
            if (channelData) {
                // GUILD_TEXT, GUILD_VOICE, etc. or just arrays
                for (const key of Object.keys(channelData)) {
                    const channels = channelData[key];
                    if (Array.isArray(channels)) {
                        // Each item might be {channel: {...}, comparator: ...}
                        for (const item of channels) {
                            const ch = item?.channel || item;
                            if (ch && ch.id) allChannels.push(ch);
                        }
                    }
                }
            }
        }

        // Method 2: Also try ChannelStore methods
        if (allChannels.length === 0) {
            const storeChannels = ChannelStore?.getGuildChannelsVersion?.(guildId) ||
                ChannelStore?.getMutableGuildChannels?.() ||
                {};
            allChannels = Object.values(storeChannels).filter((c: any) => c?.guild_id === guildId);
        }

        logger.log("Total channels found:", allChannels.length);

        // Method 3: Check each channel for VIEW_CHANNEL permission
        for (const channel of allChannels) {
            if (!channel || !channel.id) continue;
            if (channel.type === 4) continue; // Skip categories
            if (channel.type === 11 || channel.type === 12) continue; // Skip threads

            // Check if we can view this channel
            let canView = true;

            if (PermissionStore?.can) {
                try {
                    canView = PermissionStore.can(VIEW_CHANNEL, channel);
                } catch { }
            }

            if (!canView) {
                // Get roles that CAN see it
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

    } catch (e) {
        logger.error("Error scanning channels:", e);
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

            // Check if VIEW_CHANNEL is allowed
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
    const allHidden = getHiddenChannels(guildId);
    const member = GuildMemberStore?.getMember?.(guildId, userId);

    if (!member?.roles) return [];

    return allHidden.filter(ch =>
        ch.rolesWithAccess.some(r => member.roles.includes(r.id))
    );
}

// ========================================
// MESSAGE SEARCH - ENSURE MOST RECENT
// ========================================

function getMutualGuilds(userId: string) {
    if (!GuildStore || !GuildMemberStore) return [];
    try {
        const guilds = Object.values(GuildStore.getGuilds() || {}) as any[];
        return guilds.filter(g => GuildMemberStore.getMember(g.id, userId));
    } catch { return []; }
}

// Search with explicit sorting for most recent
async function searchMessagesInGuild(guildId: string, authorId: string): Promise<any[]> {
    if (!RestAPI?.get) return [];
    try {
        const res = await RestAPI.get({
            url: `/guilds/${guildId}/messages/search`,
            query: {
                author_id: authorId,
                include_nsfw: true,
                sort_by: "timestamp",    // Sort by timestamp
                sort_order: "desc"       // Descending = newest first
            }
        });

        const messages = (res?.body?.messages || []).map((m: any[]) => ({
            id: m[0].id,
            content: m[0].content || "[No text]",
            channelId: m[0].channel_id,
            guildId,
            timestamp: m[0].timestamp
        }));

        logger.log(`Found ${messages.length} messages in guild ${guildId}`);
        return messages;
    } catch (e) {
        logger.error("Search error:", e);
        return [];
    }
}

function getChannelName(id: string) { return ChannelStore?.getChannel(id)?.name || "unknown"; }
function getGuildName(id: string) { return GuildStore?.getGuild(id)?.name || "Unknown"; }
function getUserInfo(id: string) {
    const u = UserStore?.getUser(id);
    return u ? { username: u.username, globalName: u.globalName, id: u.id } : null;
}

function isUserIdFormat(text: string): boolean {
    if (!text) return false;
    return /^\d{17,19}$/.test(text.trim());
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

    // Search up to 8 servers
    for (let i = 0; i < Math.min(guilds.length, 8); i++) {
        try {
            const msgs = await searchMessagesInGuild(guilds[i].id, userId);
            allMsgs.push(...msgs);
        } catch { }
        if (i < guilds.length - 1) await new Promise(r => setTimeout(r, 250));
    }

    // Sort ALL messages by timestamp (newest first) to get the absolute most recent
    allMsgs.sort((a, b) => {
        const dateA = new Date(a.timestamp).getTime();
        const dateB = new Date(b.timestamp).getTime();
        return dateB - dateA; // Descending order
    });

    logger.log(`Total messages across all servers: ${allMsgs.length}`);
    if (allMsgs.length > 0) {
        logger.log(`Most recent message timestamp: ${allMsgs[0].timestamp}`);
    }

    if (allMsgs.length === 0) {
        showToast(`📭 No messages found`, getAssetIDByName("Small"));
        return;
    }

    showToast(`✅ Found ${allMsgs.length} messages!`, getAssetIDByName("Check"));

    // allMsgs[0] is now guaranteed to be the most recent
    const latest = allMsgs[0];
    const channelName = getChannelName(latest.channelId);
    const guildName = getGuildName(latest.guildId);
    const messageLink = `https://discord.com/channels/${latest.guildId}/${latest.channelId}/${latest.id}`;

    setTimeout(() => {
        // Show when the message was sent
        const msgDate = new Date(latest.timestamp);
        const now = new Date();
        const diffMs = now.getTime() - msgDate.getTime();
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMins / 60);
        const diffDays = Math.floor(diffHours / 24);

        let timeAgo = "";
        if (diffMins < 60) timeAgo = `${diffMins}m ago`;
        else if (diffHours < 24) timeAgo = `${diffHours}h ago`;
        else timeAgo = `${diffDays}d ago`;

        showToast(`📍 #${channelName} (${timeAgo})`, getAssetIDByName("ic_message"));
    }, 1500);

    setTimeout(async () => {
        try {
            if (Clipboard?.setString) {
                Clipboard.setString(messageLink);
                showToast(`📋 Link copied to ${guildName}!`, getAssetIDByName("Check"));
            }
        } catch (e) {
            logger.error("Copy failed:", e);
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
// SETTINGS DASHBOARD
// ========================================

function StalkerSettings() {
    const [activeTab, setActiveTab] = React.useState<'hidden' | 'user' | 'search'>('hidden');

    // Hidden channels state
    const [hiddenChannels, setHiddenChannels] = React.useState<HiddenChannel[]>([]);
    const [isScanning, setIsScanning] = React.useState(false);
    const [selectedGuild, setSelectedGuild] = React.useState<any>(null);
    const [expandedChannel, setExpandedChannel] = React.useState<string | null>(null);
    const [scanLog, setScanLog] = React.useState("");

    // User lookup state
    const [lookupUserId, setLookupUserId] = React.useState("");
    const [userChannels, setUserChannels] = React.useState<HiddenChannel[]>([]);

    // Message search state
    const [userId, setUserId] = React.useState("");
    const [isSearchingUser, setIsSearchingUser] = React.useState(false);

    React.useEffect(() => {
        scanCurrentGuild();
    }, []);

    const scanCurrentGuild = () => {
        setIsScanning(true);
        setScanLog("Scanning...");
        try {
            const guildId = SelectedGuildStore?.getGuildId?.();
            logger.log("Current guild ID:", guildId);

            if (guildId) {
                const guild = GuildStore?.getGuild?.(guildId);
                setSelectedGuild(guild);

                const channels = getHiddenChannels(guildId);
                setHiddenChannels(channels);

                setScanLog(`Found ${channels.length} hidden channels`);

                if (channels.length > 0) {
                    showToast(`🔒 Found ${channels.length} hidden!`, getAssetIDByName("Check"));
                } else {
                    showToast(`✨ No hidden channels`, getAssetIDByName("Check"));
                }
            } else {
                setSelectedGuild(null);
                setHiddenChannels([]);
                setScanLog("No server selected - open a server first!");
                showToast("Open a server first!", getAssetIDByName("Small"));
            }
        } catch (e) {
            logger.error("Scan error:", e);
            setScanLog(`Error: ${e}`);
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
        showToast(`${name}: ${channels.length} hidden channels`, getAssetIDByName("Check"));
    };

    const roleColor = (color: number) => color ? `#${color.toString(16).padStart(6, '0')}` : '#99AAB5';

    const TabBtn = ({ id, label, icon }: any) =>
        React.createElement(TouchableOpacity, {
            style: {
                flex: 1,
                padding: 10,
                backgroundColor: activeTab === id ? '#5865F2' : '#2b2d31',
                borderRadius: 8,
                marginHorizontal: 2
            },
            onPress: () => setActiveTab(id)
        }, React.createElement(Text, {
            style: { color: '#fff', textAlign: 'center', fontSize: 12, fontWeight: activeTab === id ? 'bold' : 'normal' }
        }, `${icon} ${label}`));

    return React.createElement(ScrollView, { style: { flex: 1, backgroundColor: '#1e1f22' } }, [
        // Header
        React.createElement(View, { key: 'hdr', style: { padding: 16, backgroundColor: '#2b2d31', marginBottom: 8 } }, [
            React.createElement(Text, { key: 't', style: { color: '#fff', fontSize: 20, fontWeight: 'bold', textAlign: 'center' } },
                "🔍 Stalker Pro v3.1"),
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

            React.createElement(Text, { key: 'log', style: { color: '#b5bac1', textAlign: 'center', marginBottom: 12, fontSize: 13 } },
                scanLog),

            // Debug info
            React.createElement(Text, { key: 'debug', style: { color: '#949ba4', textAlign: 'center', fontSize: 10, marginBottom: 8 } },
                `GuildChannelStore: ${GuildChannelStore ? '✅' : '❌'} | PermissionStore: ${PermissionStore ? '✅' : '❌'}`),

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
                        `👥 ${ch.rolesWithAccess.length} roles with access`),

                    expandedChannel === ch.id && React.createElement(View, { key: 'd', style: { marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#3f4147' } },
                        ch.rolesWithAccess.length > 0
                            ? ch.rolesWithAccess.map((r: any, ri: number) =>
                                React.createElement(Text, { key: `r${ri}`, style: { color: roleColor(r.color), marginLeft: 12, marginTop: 2, fontSize: 14 } }, `• ${r.name}`)
                            )
                            : [React.createElement(Text, { key: 'no', style: { color: '#949ba4', marginLeft: 12 } }, "No specific role overwrites found")]
                    )
                ])
            ),

            hiddenChannels.length === 0 && !isScanning && React.createElement(View, { key: 'empty', style: { padding: 30, alignItems: 'center' } }, [
                React.createElement(Text, { key: 'e1', style: { fontSize: 40 } }, "✨"),
                React.createElement(Text, { key: 'e2', style: { color: '#fff', fontSize: 16, marginTop: 10 } },
                    selectedGuild ? "No hidden channels found" : "Open a server first"),
                React.createElement(Text, { key: 'e3', style: { color: '#b5bac1', marginTop: 4, textAlign: 'center', fontSize: 12 } },
                    "Note: Discord may not expose\nchannels you can't see at all")
            ])
        ],

        // === USER TAB ===
        activeTab === 'user' && [
            React.createElement(FormSection, { key: 'us', title: "👤 USER HIDDEN ACCESS" }, [
                React.createElement(FormInput, { key: 'in', title: "User ID", placeholder: "Enter User ID", value: lookupUserId, onChangeText: setLookupUserId, keyboardType: "numeric" }),
                React.createElement(FormRow, { key: 'btn', label: "🔍 Check Hidden Access", subLabel: selectedGuild ? `In ${selectedGuild.name}` : "Open server first", onPress: handleUserLookup })
            ]),

            userChannels.length > 0 && React.createElement(FormSection, { key: 'res', title: `✅ Can access ${userChannels.length} hidden channels:` },
                userChannels.map((ch, i) => React.createElement(FormRow, { key: `uc${i}`, label: `${getChannelTypeName(ch.type)} ${ch.name}`, subLabel: ch.parentName || undefined }))
            ),

            userChannels.length === 0 && lookupUserId.length >= 17 && React.createElement(View, { key: 'no', style: { padding: 30, alignItems: 'center' } }, [
                React.createElement(Text, { key: 'n1', style: { fontSize: 40 } }, "🚫"),
                React.createElement(Text, { key: 'n2', style: { color: '#fff', fontSize: 16, marginTop: 10 } }, "No hidden access found")
            ])
        ],

        // === SEARCH TAB ===
        activeTab === 'search' && [
            React.createElement(FormSection, { key: 'auto', title: "💬 MESSAGE SEARCH" }, [
                React.createElement(FormRow, { key: 'a1', label: "📋 Auto-Detection", subLabel: clipboardMonitorActive ? "✅ Copy User ID to auto-search!" : "❌ Inactive" }),
                React.createElement(FormRow, { key: 'a2', label: "⏱️ Returns Most Recent", subLabel: "Messages sorted by timestamp (newest first)" })
            ]),
            React.createElement(FormSection, { key: 'man', title: "🔍 MANUAL SEARCH" }, [
                React.createElement(FormInput, { key: 'in', title: "User ID", placeholder: "Enter Discord User ID", value: userId, onChangeText: setUserId, keyboardType: "numeric" }),
                React.createElement(FormRow, { key: 'btn', label: isSearchingUser ? "⏳ Searching..." : "🔍 Find Recent Messages", onPress: isSearchingUser ? undefined : handleUserSearch })
            ])
        ],

        // Footer
        React.createElement(View, { key: 'ft', style: { padding: 20, alignItems: 'center' } },
            React.createElement(Text, { style: { color: '#949ba4', fontSize: 10, textAlign: 'center' } },
                "💡 Copy User ID → auto-search\n🔒 Open server → Scan for hidden channels"))
    ]);
}

export const settings = StalkerSettings;

export const onLoad = () => {
    logger.log("=== STALKER PRO v3.1 LOADING ===");
    logger.log("GuildChannelStore:", !!GuildChannelStore);
    logger.log("PermissionStore:", !!PermissionStore);

    if (Clipboard?.getString) {
        clipboardMonitorActive = true;
        checkIntervalId = setInterval(checkClipboardContent, 2000);
    }

    showToast("🔍 Stalker Pro v3.1 ready!", getAssetIDByName("Check"));
};

export const onUnload = () => {
    if (checkIntervalId) {
        clearInterval(checkIntervalId);
        checkIntervalId = null;
        clipboardMonitorActive = false;
    }
};
