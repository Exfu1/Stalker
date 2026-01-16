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

// Clipboard
const Clipboard = ReactNative?.Clipboard || findByProps("setString", "getString");

// REST API
const RestAPI = findByProps("getAPIBaseURL", "get") || findByProps("API_HOST", "get");

// Permission constants (using numbers for ES2017 compatibility)
const Permissions = findByProps("VIEW_CHANNEL", "SEND_MESSAGES") || {
    VIEW_CHANNEL: 1024,
    SEND_MESSAGES: 2048
};

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
    parentId: string | null;
    parentName: string;
    usersWithAccess: any[];
    rolesWithAccess: any[];
}

function getChannelTypeName(type: number): string {
    switch (type) {
        case 0: return "💬";  // Text
        case 2: return "🔊";  // Voice
        case 4: return "📁";  // Category
        case 5: return "📢";  // Announcement
        case 13: return "🎭"; // Stage
        case 15: return "📋"; // Forum
        default: return "📝";
    }
}

function canUserViewChannel(channelId: string): boolean {
    try {
        if (!PermissionStore) return true;
        const can = PermissionStore.can?.(Permissions.VIEW_CHANNEL, { id: channelId });
        return can !== false;
    } catch {
        return true;
    }
}

function getHiddenChannels(guildId: string): HiddenChannel[] {
    try {
        if (!ChannelStore || !GuildStore) return [];

        // Get all channels for this guild
        const allChannels = Object.values(ChannelStore.getMutableGuildChannelsForGuild?.(guildId) ||
            ChannelStore.getMutableGuildChannels?.() || {})
            .filter((c: any) => c.guild_id === guildId);

        const hiddenChannels: HiddenChannel[] = [];

        for (const channel of allChannels as any[]) {
            if (!channel) continue;

            // Skip DMs and threads
            if (channel.type === 1 || channel.type === 3 || channel.type === 11 || channel.type === 12) continue;

            // Check if current user can't see this channel
            const canSee = canUserViewChannel(channel.id);

            if (!canSee) {
                const accessInfo = getChannelAccessInfo(channel, guildId);

                hiddenChannels.push({
                    id: channel.id,
                    name: channel.name || "Unknown",
                    type: channel.type,
                    parentId: channel.parent_id,
                    parentName: channel.parent_id ? (ChannelStore.getChannel?.(channel.parent_id)?.name || "") : "",
                    usersWithAccess: accessInfo.users,
                    rolesWithAccess: accessInfo.roles
                });
            }
        }

        return hiddenChannels.sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
        logger.error("Error getting hidden channels:", e);
        return [];
    }
}

function getChannelAccessInfo(channel: any, guildId: string): { users: any[], roles: any[] } {
    const users: any[] = [];
    const roles: any[] = [];

    try {
        const overwrites = channel.permissionOverwrites || channel.permission_overwrites || {};
        const guild = GuildStore?.getGuild?.(guildId);

        for (const [id, overwrite] of Object.entries(overwrites) as any[]) {
            if (!overwrite) continue;

            const allow = Number(overwrite.allow || 0);

            if ((allow & Number(Permissions.VIEW_CHANNEL)) !== 0) {
                if (overwrite.type === 1 || overwrite.type === "member") {
                    const user = UserStore?.getUser?.(id);
                    if (user) {
                        users.push({
                            id: user.id,
                            username: user.username,
                            globalName: user.globalName
                        });
                    }
                } else if (overwrite.type === 0 || overwrite.type === "role") {
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
    } catch (e) {
        logger.error("Error getting access info:", e);
    }

    return { users, roles };
}

function getUserHiddenChannelAccess(guildId: string, userId: string): HiddenChannel[] {
    try {
        const allHidden = getHiddenChannels(guildId);
        const member = GuildMemberStore?.getMember?.(guildId, userId);

        return allHidden.filter(channel => {
            if (channel.usersWithAccess.some((u: any) => u.id === userId)) return true;
            if (member?.roles) {
                return channel.rolesWithAccess.some((r: any) => member.roles.includes(r.id));
            }
            return false;
        });
    } catch {
        return [];
    }
}

// ========================================
// MESSAGE SEARCH FUNCTIONS
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
            query: { author_id: authorId, include_nsfw: true }
        });
        return (res?.body?.messages || []).map((m: any[]) => ({
            id: m[0].id, content: m[0].content || "[No text]",
            channelId: m[0].channel_id, guildId, timestamp: m[0].timestamp
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

    for (let i = 0; i < Math.min(guilds.length, 8); i++) {
        try {
            const msgs = await searchMessagesInGuild(guilds[i].id, userId);
            allMsgs.push(...msgs);
        } catch { }
        if (i < guilds.length - 1) await new Promise(r => setTimeout(r, 250));
    }

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

    setTimeout(() => {
        showToast(`📍 #${channelName} in ${guildName}`, getAssetIDByName("ic_message"));
    }, 1500);

    setTimeout(async () => {
        try {
            if (Clipboard?.setString) {
                Clipboard.setString(messageLink);
                showToast(`📋 Link copied!`, getAssetIDByName("Check"));
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
            const userId = content.trim();
            showToast(`🎯 User ID detected!`, getAssetIDByName("Check"));
            setTimeout(() => autoSearchUser(userId), 1000);
        }
    } catch (e) {
        logger.error("Clipboard error:", e);
    }
}

// ========================================
// SETTINGS WITH TABBED DASHBOARD
// ========================================

function StalkerSettings() {
    // Tab state
    const [activeTab, setActiveTab] = React.useState<'search' | 'hidden' | 'user'>('hidden');

    // Message search state
    const [userId, setUserId] = React.useState("");
    const [isSearchingUser, setIsSearchingUser] = React.useState(false);

    // Hidden channels state
    const [hiddenChannels, setHiddenChannels] = React.useState<HiddenChannel[]>([]);
    const [isScanning, setIsScanning] = React.useState(false);
    const [selectedGuild, setSelectedGuild] = React.useState<any>(null);
    const [expandedChannel, setExpandedChannel] = React.useState<string | null>(null);

    // User lookup state
    const [lookupUserId, setLookupUserId] = React.useState("");
    const [userChannels, setUserChannels] = React.useState<HiddenChannel[]>([]);
    const [lookupUserInfo, setLookupUserInfo] = React.useState<any>(null);

    // Scan current guild on mount
    React.useEffect(() => {
        scanCurrentGuild();
    }, []);

    const scanCurrentGuild = () => {
        setIsScanning(true);
        try {
            const guildId = SelectedGuildStore?.getGuildId?.();
            if (guildId) {
                const guild = GuildStore?.getGuild?.(guildId);
                setSelectedGuild(guild);
                const channels = getHiddenChannels(guildId);
                setHiddenChannels(channels);
                if (channels.length > 0) {
                    showToast(`🔒 Found ${channels.length} hidden channels`, getAssetIDByName("Check"));
                }
            } else {
                setSelectedGuild(null);
                setHiddenChannels([]);
            }
        } catch (e) {
            logger.error("Scan error:", e);
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

        const channels = getUserHiddenChannelAccess(guildId, lookupUserId);
        setUserChannels(channels);

        const user = UserStore?.getUser?.(lookupUserId);
        setLookupUserInfo(user);

        const name = user?.globalName || user?.username || lookupUserId;
        showToast(`${name}: ${channels.length} hidden channels`, getAssetIDByName("Check"));
    };

    const roleColor = (color: number) => color ? `#${color.toString(16).padStart(6, '0')}` : '#99AAB5';

    // Tab button component
    const TabButton = ({ id, label, icon }: { id: string, label: string, icon: string }) =>
        React.createElement(
            TouchableOpacity,
            {
                style: {
                    flex: 1,
                    padding: 10,
                    backgroundColor: activeTab === id ? '#5865F2' : '#2b2d31',
                    borderRadius: 8,
                    marginHorizontal: 2
                },
                onPress: () => setActiveTab(id as any)
            },
            React.createElement(Text, {
                style: {
                    color: '#fff',
                    textAlign: 'center',
                    fontSize: 12,
                    fontWeight: activeTab === id ? 'bold' : 'normal'
                }
            }, `${icon} ${label}`)
        );

    return React.createElement(ScrollView, { style: { flex: 1, backgroundColor: '#1e1f22' } }, [
        // Header
        React.createElement(View, {
            key: 'header',
            style: { padding: 16, backgroundColor: '#2b2d31', marginBottom: 8 }
        }, [
            React.createElement(Text, {
                key: 'title',
                style: { color: '#fff', fontSize: 20, fontWeight: 'bold', textAlign: 'center' }
            }, "🔍 Stalker Pro v3.0"),
            React.createElement(Text, {
                key: 'subtitle',
                style: { color: '#b5bac1', fontSize: 12, textAlign: 'center', marginTop: 4 }
            }, selectedGuild ? `📍 ${selectedGuild.name}` : "Open a server for hidden channels")
        ]),

        // Tab Buttons
        React.createElement(View, {
            key: 'tabs',
            style: { flexDirection: 'row', padding: 8, marginBottom: 8 }
        }, [
            React.createElement(TabButton, { key: 't1', id: 'hidden', label: 'Hidden', icon: '🔒' }),
            React.createElement(TabButton, { key: 't2', id: 'user', label: 'User Access', icon: '👤' }),
            React.createElement(TabButton, { key: 't3', id: 'search', label: 'Messages', icon: '💬' })
        ]),

        // ========== HIDDEN CHANNELS TAB ==========
        activeTab === 'hidden' && [
            // Scan button
            React.createElement(
                TouchableOpacity,
                {
                    key: 'scan-btn',
                    style: {
                        margin: 12,
                        padding: 14,
                        backgroundColor: '#5865F2',
                        borderRadius: 12,
                        flexDirection: 'row',
                        justifyContent: 'center',
                        alignItems: 'center'
                    },
                    onPress: scanCurrentGuild
                },
                React.createElement(Text, { style: { color: '#fff', fontWeight: 'bold', fontSize: 16 } },
                    isScanning ? "⏳ Scanning..." : "🔄 Scan Current Server")
            ),

            // Results count
            React.createElement(Text, {
                key: 'count',
                style: { color: '#b5bac1', textAlign: 'center', marginBottom: 12, fontSize: 14 }
            }, hiddenChannels.length > 0
                ? `Found ${hiddenChannels.length} hidden channels`
                : selectedGuild ? "No hidden channels found ✨" : "Open a server to scan"),

            // Channel list
            ...hiddenChannels.map((channel, idx) =>
                React.createElement(
                    TouchableOpacity,
                    {
                        key: `ch-${idx}`,
                        style: {
                            margin: 8,
                            marginTop: 4,
                            padding: 14,
                            backgroundColor: '#2b2d31',
                            borderRadius: 12,
                            borderLeftWidth: 4,
                            borderLeftColor: '#5865F2'
                        },
                        onPress: () => setExpandedChannel(expandedChannel === channel.id ? null : channel.id)
                    },
                    [
                        // Channel header
                        React.createElement(View, { key: 'hdr', style: { flexDirection: 'row', alignItems: 'center' } }, [
                            React.createElement(Text, { key: 'icon', style: { fontSize: 18, marginRight: 10 } },
                                getChannelTypeName(channel.type)),
                            React.createElement(View, { key: 'info', style: { flex: 1 } }, [
                                React.createElement(Text, { key: 'name', style: { color: '#fff', fontSize: 16, fontWeight: 'bold' } },
                                    channel.name),
                                channel.parentName && React.createElement(Text, { key: 'parent', style: { color: '#949ba4', fontSize: 12 } },
                                    `in ${channel.parentName}`)
                            ]),
                            React.createElement(Text, { key: 'arrow', style: { color: '#b5bac1' } },
                                expandedChannel === channel.id ? "▼" : "▶")
                        ]),

                        // Access summary
                        React.createElement(Text, {
                            key: 'access',
                            style: { color: '#00b894', fontSize: 12, marginTop: 6 }
                        }, `👥 ${channel.rolesWithAccess.length} roles, ${channel.usersWithAccess.length} users`),

                        // Expanded details
                        expandedChannel === channel.id && React.createElement(View, {
                            key: 'details',
                            style: { marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#3f4147' }
                        }, [
                            // Roles
                            channel.rolesWithAccess.length > 0 && React.createElement(Text, {
                                key: 'roles-title',
                                style: { color: '#fff', fontWeight: 'bold', marginBottom: 6 }
                            }, "🏷️ Roles:"),
                            ...channel.rolesWithAccess.map((role: any, ri: number) =>
                                React.createElement(Text, {
                                    key: `role-${ri}`,
                                    style: { color: roleColor(role.color), marginLeft: 12, marginTop: 2, fontSize: 14 }
                                }, `• ${role.name}`)
                            ),

                            // Users
                            channel.usersWithAccess.length > 0 && React.createElement(Text, {
                                key: 'users-title',
                                style: { color: '#fff', fontWeight: 'bold', marginTop: 10, marginBottom: 6 }
                            }, "👤 Direct Access:"),
                            ...channel.usersWithAccess.map((user: any, ui: number) =>
                                React.createElement(Text, {
                                    key: `user-${ui}`,
                                    style: { color: '#b5bac1', marginLeft: 12, marginTop: 2, fontSize: 14 }
                                }, `• ${user.globalName || user.username}`)
                            )
                        ])
                    ]
                )
            )
        ],

        // ========== USER LOOKUP TAB ==========
        activeTab === 'user' && [
            React.createElement(FormSection, { key: 'user-section', title: "👤 USER LOOKUP" }, [
                React.createElement(FormInput, {
                    key: 'input',
                    title: "User ID",
                    placeholder: "Enter User ID to check their access",
                    value: lookupUserId,
                    onChangeText: setLookupUserId,
                    keyboardType: "numeric"
                }),
                React.createElement(FormRow, {
                    key: 'btn',
                    label: "🔍 Check Access",
                    subLabel: selectedGuild ? `In ${selectedGuild.name}` : "Open a server first",
                    trailing: FormRow.Arrow ? React.createElement(FormRow.Arrow, null) : null,
                    onPress: handleUserLookup
                })
            ]),

            // Results
            userChannels.length > 0 && React.createElement(FormSection, {
                key: 'results',
                title: `✅ ${lookupUserInfo?.globalName || lookupUserInfo?.username || 'User'} has access to:`
            }, userChannels.map((channel, idx) =>
                React.createElement(FormRow, {
                    key: `uc-${idx}`,
                    label: `${getChannelTypeName(channel.type)} ${channel.name}`,
                    subLabel: channel.parentName ? `in ${channel.parentName}` : undefined
                })
            )),

            userChannels.length === 0 && lookupUserId.length >= 17 && React.createElement(
                View,
                { key: 'no-access', style: { padding: 30, alignItems: 'center' } },
                [
                    React.createElement(Text, { key: 't1', style: { fontSize: 40 } }, "🚫"),
                    React.createElement(Text, { key: 't2', style: { color: '#fff', fontSize: 16, marginTop: 10 } },
                        "No hidden channel access"),
                    React.createElement(Text, { key: 't3', style: { color: '#b5bac1', marginTop: 4, textAlign: 'center' } },
                        "This user can't see any channels you can't see")
                ]
            )
        ],

        // ========== MESSAGE SEARCH TAB ==========
        activeTab === 'search' && [
            React.createElement(FormSection, { key: 'search-info', title: "💬 MESSAGE SEARCH" }, [
                React.createElement(FormRow, {
                    key: 'auto',
                    label: "📋 Auto-Detection",
                    subLabel: clipboardMonitorActive
                        ? "✅ Copy any User ID to auto-search!"
                        : "❌ Clipboard monitoring inactive"
                })
            ]),
            React.createElement(FormSection, { key: 'manual', title: "🔍 MANUAL SEARCH" }, [
                React.createElement(FormInput, {
                    key: 'input',
                    title: "User ID",
                    placeholder: "Enter Discord User ID",
                    value: userId,
                    onChangeText: setUserId,
                    keyboardType: "numeric"
                }),
                React.createElement(FormRow, {
                    key: 'btn',
                    label: isSearchingUser ? "⏳ Searching..." : "🔍 Search Messages",
                    subLabel: "Find their recent messages across servers",
                    onPress: isSearchingUser ? undefined : handleUserSearch
                })
            ])
        ],

        // Footer
        React.createElement(View, {
            key: 'footer',
            style: { padding: 20, alignItems: 'center' }
        }, [
            React.createElement(Text, {
                key: 'tip',
                style: { color: '#949ba4', fontSize: 11, textAlign: 'center' }
            }, "💡 Tip: Copy any User ID and it auto-searches!\n🔒 Open a server and tap Scan to find hidden channels")
        ])
    ]);
}

export const settings = StalkerSettings;

export const onLoad = () => {
    logger.log("=== STALKER PRO v3.0 LOADING ===");

    // Start clipboard monitoring
    if (Clipboard?.getString) {
        clipboardMonitorActive = true;
        checkIntervalId = setInterval(checkClipboardContent, 2000);
        logger.log("Clipboard monitoring started");
    }

    showToast("🔍 Stalker Pro v3.0 ready!", getAssetIDByName("Check"));
};

export const onUnload = () => {
    logger.log("=== STALKER PRO UNLOADING ===");

    if (checkIntervalId) {
        clearInterval(checkIntervalId);
        checkIntervalId = null;
        clipboardMonitorActive = false;
    }
};
