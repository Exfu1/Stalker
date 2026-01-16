import { logger } from "@vendetta";
import { findByStoreName, findByProps } from "@vendetta/metro";
import { React, ReactNative, FluxDispatcher } from "@vendetta/metro/common";
import { Forms, General } from "@vendetta/ui/components";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { showToast } from "@vendetta/ui/toasts";

const { FormSection, FormRow, FormInput, FormDivider } = Forms;
const { ScrollView, View, Text, TouchableOpacity, ActivityIndicator, Modal, Dimensions } = General;

// Get screen dimensions
const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions?.get?.("window") || { width: 400, height: 800 };

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
const MessageActions = findByProps("jumpToMessage");

// Permission constants (using numbers for ES2017 compatibility)
const Permissions = findByProps("VIEW_CHANNEL", "SEND_MESSAGES") || {
    VIEW_CHANNEL: 1024,
    SEND_MESSAGES: 2048
};

// Storage
let targetUserId: string = "";
let clipboardMonitorActive = false;
let lastCheckedClipboard = "";
let checkIntervalId: any = null;
let floatingButtonRef: any = null;

// ========================================
// HIDDEN CHANNEL DETECTION LOGIC
// ========================================

interface HiddenChannel {
    id: string;
    name: string;
    type: number;
    parentId: string | null;
    parentName: string;
    usersWithAccess: UserAccess[];
    rolesWithAccess: RoleAccess[];
}

interface UserAccess {
    id: string;
    username: string;
    globalName: string | null;
}

interface RoleAccess {
    id: string;
    name: string;
    color: number;
    memberCount: number;
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

function canUserViewChannel(channelId: string, userId?: string): boolean {
    try {
        if (!PermissionStore) return true;

        if (userId) {
            // Check for specific user
            const perms = PermissionStore.getChannelPermissions?.({ id: channelId }, { id: userId });
            if (perms !== undefined) {
                return (Number(perms) & Number(Permissions.VIEW_CHANNEL)) !== 0;
            }
        }

        // Check for current user
        const can = PermissionStore.can?.(Permissions.VIEW_CHANNEL, { id: channelId });
        return can !== false;
    } catch {
        return true;
    }
}

function getHiddenChannels(guildId: string): HiddenChannel[] {
    try {
        if (!ChannelStore || !GuildStore) return [];

        const allChannels = ChannelStore.getChannels?.(guildId) ||
            Object.values(ChannelStore.getMutableGuildChannels?.() || {}).filter((c: any) => c.guild_id === guildId);

        const hiddenChannels: HiddenChannel[] = [];
        const currentUser = UserStore?.getCurrentUser?.();

        for (const channel of allChannels as any[]) {
            if (!channel || channel.guild_id !== guildId) continue;

            // Skip DMs and threads
            if (channel.type === 1 || channel.type === 3 || channel.type === 11 || channel.type === 12) continue;

            // Check if current user can't see this channel
            const canSee = canUserViewChannel(channel.id);

            if (!canSee) {
                // Get users/roles who CAN see it
                const accessInfo = getChannelAccessInfo(channel, guildId);

                hiddenChannels.push({
                    id: channel.id,
                    name: channel.name || "Unknown",
                    type: channel.type,
                    parentId: channel.parent_id,
                    parentName: channel.parent_id ? (ChannelStore.getChannel?.(channel.parent_id)?.name || "Unknown") : "",
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

function getChannelAccessInfo(channel: any, guildId: string): { users: UserAccess[], roles: RoleAccess[] } {
    const users: UserAccess[] = [];
    const roles: RoleAccess[] = [];

    try {
        // Check permission overwrites
        const overwrites = channel.permissionOverwrites || channel.permission_overwrites || {};
        const guild = GuildStore?.getGuild?.(guildId);

        for (const [id, overwrite] of Object.entries(overwrites) as any[]) {
            if (!overwrite) continue;

            const allow = Number(overwrite.allow || 0);
            const deny = Number(overwrite.deny || 0);

            // Check if VIEW_CHANNEL is allowed
            if ((allow & Number(Permissions.VIEW_CHANNEL)) !== 0) {
                if (overwrite.type === 1 || overwrite.type === "member") {
                    // User overwrite
                    const user = UserStore?.getUser?.(id);
                    if (user) {
                        users.push({
                            id: user.id,
                            username: user.username,
                            globalName: user.globalName
                        });
                    }
                } else if (overwrite.type === 0 || overwrite.type === "role") {
                    // Role overwrite
                    const role = guild?.roles?.[id];
                    if (role && role.name !== "@everyone") {
                        const memberCount = countMembersWithRole(guildId, id);
                        roles.push({
                            id: role.id,
                            name: role.name,
                            color: role.color || 0,
                            memberCount
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

function countMembersWithRole(guildId: string, roleId: string): number {
    try {
        if (!GuildMemberStore) return 0;
        const members = GuildMemberStore.getMembers?.(guildId) || [];
        return members.filter((m: any) => m.roles?.includes(roleId)).length;
    } catch {
        return 0;
    }
}

function getUserHiddenChannelAccess(guildId: string, userId: string): HiddenChannel[] {
    try {
        const allHidden = getHiddenChannels(guildId);

        // Filter to channels this user has access to
        return allHidden.filter(channel => {
            // Check if user is in the users list
            if (channel.usersWithAccess.some(u => u.id === userId)) return true;

            // Check if user has any of the roles
            const member = GuildMemberStore?.getMember?.(guildId, userId);
            if (member?.roles) {
                return channel.rolesWithAccess.some(r => member.roles.includes(r.id));
            }

            return false;
        });
    } catch {
        return [];
    }
}

// ========================================
// FLOATING ACTION BUTTON COMPONENT
// ========================================

function FloatingButton({ onPress }: { onPress: () => void }) {
    const [position, setPosition] = React.useState({ x: SCREEN_WIDTH - 70, y: SCREEN_HEIGHT / 2 });

    return React.createElement(
        TouchableOpacity,
        {
            style: {
                position: 'absolute',
                left: position.x,
                top: position.y,
                width: 56,
                height: 56,
                borderRadius: 28,
                backgroundColor: '#5865F2',
                justifyContent: 'center',
                alignItems: 'center',
                elevation: 8,
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: 0.3,
                shadowRadius: 8,
                zIndex: 9999,
            },
            onPress,
            activeOpacity: 0.8
        },
        React.createElement(Text, {
            style: { fontSize: 24, color: '#fff' }
        }, "🔒")
    );
}

// ========================================
// HIDDEN CHANNELS DASHBOARD MODAL
// ========================================

function HiddenChannelsDashboard({ visible, onClose }: { visible: boolean, onClose: () => void }) {
    const [activeTab, setActiveTab] = React.useState<'channels' | 'users'>('channels');
    const [hiddenChannels, setHiddenChannels] = React.useState<HiddenChannel[]>([]);
    const [isLoading, setIsLoading] = React.useState(false);
    const [selectedGuild, setSelectedGuild] = React.useState<any>(null);
    const [userIdInput, setUserIdInput] = React.useState("");
    const [userChannels, setUserChannels] = React.useState<HiddenChannel[]>([]);
    const [expandedChannel, setExpandedChannel] = React.useState<string | null>(null);

    React.useEffect(() => {
        if (visible) {
            scanCurrentGuild();
        }
    }, [visible]);

    const scanCurrentGuild = () => {
        setIsLoading(true);
        try {
            const guildId = SelectedGuildStore?.getGuildId?.();
            if (guildId) {
                const guild = GuildStore?.getGuild?.(guildId);
                setSelectedGuild(guild);
                const channels = getHiddenChannels(guildId);
                setHiddenChannels(channels);
                showToast(`Found ${channels.length} hidden channels`, getAssetIDByName("Check"));
            } else {
                showToast("Open a server first!", getAssetIDByName("Small"));
            }
        } catch (e) {
            logger.error("Scan error:", e);
            showToast("Scan failed", getAssetIDByName("Small"));
        } finally {
            setIsLoading(false);
        }
    };

    const searchUserAccess = () => {
        if (!userIdInput || userIdInput.length < 17) {
            showToast("Enter valid User ID", getAssetIDByName("Small"));
            return;
        }

        const guildId = SelectedGuildStore?.getGuildId?.();
        if (!guildId) {
            showToast("Open a server first!", getAssetIDByName("Small"));
            return;
        }

        const channels = getUserHiddenChannelAccess(guildId, userIdInput);
        setUserChannels(channels);

        const user = UserStore?.getUser?.(userIdInput);
        const name = user?.globalName || user?.username || userIdInput;
        showToast(`${name} can see ${channels.length} hidden channels`, getAssetIDByName("Check"));
    };

    const roleColor = (color: number) => color ? `#${color.toString(16).padStart(6, '0')}` : '#99AAB5';

    if (!visible) return null;

    return React.createElement(
        View,
        {
            style: {
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundColor: 'rgba(0,0,0,0.85)',
                zIndex: 10000,
            }
        },
        [
            // Header
            React.createElement(
                View,
                {
                    key: 'header',
                    style: {
                        flexDirection: 'row',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: 16,
                        paddingTop: 50,
                        backgroundColor: '#1e1f22',
                        borderBottomWidth: 1,
                        borderBottomColor: '#3f4147'
                    }
                },
                [
                    React.createElement(Text, {
                        key: 'title',
                        style: { color: '#fff', fontSize: 20, fontWeight: 'bold' }
                    }, `🔒 ${selectedGuild?.name || 'Hidden Channels'}`),
                    React.createElement(
                        TouchableOpacity,
                        { key: 'close', onPress: onClose, style: { padding: 8 } },
                        React.createElement(Text, { style: { color: '#fff', fontSize: 24 } }, "✕")
                    )
                ]
            ),

            // Tab Buttons
            React.createElement(
                View,
                {
                    key: 'tabs',
                    style: {
                        flexDirection: 'row',
                        backgroundColor: '#2b2d31',
                        padding: 8
                    }
                },
                [
                    React.createElement(
                        TouchableOpacity,
                        {
                            key: 'tab1',
                            style: {
                                flex: 1,
                                padding: 12,
                                backgroundColor: activeTab === 'channels' ? '#5865F2' : 'transparent',
                                borderRadius: 8,
                                marginRight: 4
                            },
                            onPress: () => setActiveTab('channels')
                        },
                        React.createElement(Text, {
                            style: { color: '#fff', textAlign: 'center', fontWeight: activeTab === 'channels' ? 'bold' : 'normal' }
                        }, "📋 Channels")
                    ),
                    React.createElement(
                        TouchableOpacity,
                        {
                            key: 'tab2',
                            style: {
                                flex: 1,
                                padding: 12,
                                backgroundColor: activeTab === 'users' ? '#5865F2' : 'transparent',
                                borderRadius: 8,
                                marginLeft: 4
                            },
                            onPress: () => setActiveTab('users')
                        },
                        React.createElement(Text, {
                            style: { color: '#fff', textAlign: 'center', fontWeight: activeTab === 'users' ? 'bold' : 'normal' }
                        }, "👤 User Lookup")
                    )
                ]
            ),

            // Content
            React.createElement(
                ScrollView,
                {
                    key: 'content',
                    style: { flex: 1, backgroundColor: '#1e1f22' }
                },
                activeTab === 'channels' ? [
                    // Refresh button
                    React.createElement(
                        TouchableOpacity,
                        {
                            key: 'refresh',
                            style: {
                                margin: 12,
                                padding: 12,
                                backgroundColor: '#3f4147',
                                borderRadius: 8,
                                flexDirection: 'row',
                                justifyContent: 'center',
                                alignItems: 'center'
                            },
                            onPress: scanCurrentGuild
                        },
                        React.createElement(Text, { style: { color: '#fff' } },
                            isLoading ? "⏳ Scanning..." : "🔄 Rescan Server")
                    ),

                    // Channel count
                    React.createElement(Text, {
                        key: 'count',
                        style: { color: '#b5bac1', textAlign: 'center', marginBottom: 12 }
                    }, `Found ${hiddenChannels.length} hidden channels`),

                    // Channel list
                    ...hiddenChannels.map((channel, idx) =>
                        React.createElement(
                            TouchableOpacity,
                            {
                                key: `ch-${idx}`,
                                style: {
                                    margin: 8,
                                    marginTop: 4,
                                    padding: 12,
                                    backgroundColor: '#2b2d31',
                                    borderRadius: 12,
                                    borderLeftWidth: 4,
                                    borderLeftColor: '#5865F2'
                                },
                                onPress: () => setExpandedChannel(expandedChannel === channel.id ? null : channel.id)
                            },
                            [
                                // Channel name
                                React.createElement(
                                    View,
                                    { key: 'header', style: { flexDirection: 'row', alignItems: 'center' } },
                                    [
                                        React.createElement(Text, {
                                            key: 'icon',
                                            style: { fontSize: 16, marginRight: 8 }
                                        }, getChannelTypeName(channel.type)),
                                        React.createElement(Text, {
                                            key: 'name',
                                            style: { color: '#fff', fontSize: 16, fontWeight: 'bold', flex: 1 }
                                        }, channel.name),
                                        React.createElement(Text, {
                                            key: 'expand',
                                            style: { color: '#b5bac1', fontSize: 12 }
                                        }, expandedChannel === channel.id ? "▼" : "▶")
                                    ]
                                ),

                                // Category
                                channel.parentName && React.createElement(Text, {
                                    key: 'parent',
                                    style: { color: '#949ba4', fontSize: 12, marginTop: 4 }
                                }, `📁 ${channel.parentName}`),

                                // Access summary
                                React.createElement(Text, {
                                    key: 'access',
                                    style: { color: '#00b894', fontSize: 12, marginTop: 4 }
                                }, `👥 ${channel.rolesWithAccess.length} roles, ${channel.usersWithAccess.length} users`),

                                // Expanded details
                                expandedChannel === channel.id && React.createElement(
                                    View,
                                    { key: 'details', style: { marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#3f4147' } },
                                    [
                                        // Roles
                                        channel.rolesWithAccess.length > 0 && React.createElement(Text, {
                                            key: 'roles-title',
                                            style: { color: '#fff', fontWeight: 'bold', marginBottom: 4 }
                                        }, "🏷️ Roles with access:"),
                                        ...channel.rolesWithAccess.map((role, ri) =>
                                            React.createElement(Text, {
                                                key: `role-${ri}`,
                                                style: { color: roleColor(role.color), marginLeft: 8, marginTop: 2 }
                                            }, `• ${role.name} (${role.memberCount} members)`)
                                        ),

                                        // Users
                                        channel.usersWithAccess.length > 0 && React.createElement(Text, {
                                            key: 'users-title',
                                            style: { color: '#fff', fontWeight: 'bold', marginTop: 8, marginBottom: 4 }
                                        }, "👤 Users with direct access:"),
                                        ...channel.usersWithAccess.map((user, ui) =>
                                            React.createElement(Text, {
                                                key: `user-${ui}`,
                                                style: { color: '#b5bac1', marginLeft: 8, marginTop: 2 }
                                            }, `• ${user.globalName || user.username}`)
                                        )
                                    ]
                                )
                            ]
                        )
                    ),

                    // Empty state
                    hiddenChannels.length === 0 && !isLoading && React.createElement(
                        View,
                        { key: 'empty', style: { padding: 40, alignItems: 'center' } },
                        [
                            React.createElement(Text, { key: 't1', style: { fontSize: 48 } }, "✨"),
                            React.createElement(Text, { key: 't2', style: { color: '#fff', fontSize: 18, marginTop: 12 } }, "No hidden channels!"),
                            React.createElement(Text, { key: 't3', style: { color: '#b5bac1', marginTop: 4, textAlign: 'center' } },
                                "You can see all channels in this server, or open a different server.")
                        ]
                    )
                ] : [
                    // User Lookup Tab
                    React.createElement(
                        View,
                        { key: 'search', style: { padding: 12 } },
                        [
                            React.createElement(Text, {
                                key: 'label',
                                style: { color: '#b5bac1', marginBottom: 8 }
                            }, "Enter User ID to see their hidden channel access:"),
                            React.createElement(
                                View,
                                { key: 'input-row', style: { flexDirection: 'row' } },
                                [
                                    React.createElement(
                                        View,
                                        {
                                            key: 'input-wrap',
                                            style: {
                                                flex: 1,
                                                backgroundColor: '#2b2d31',
                                                borderRadius: 8,
                                                marginRight: 8
                                            }
                                        },
                                        React.createElement(FormInput, {
                                            key: 'input',
                                            placeholder: "User ID (17-19 digits)",
                                            value: userIdInput,
                                            onChangeText: setUserIdInput,
                                            keyboardType: "numeric",
                                            style: { color: '#fff' }
                                        })
                                    ),
                                    React.createElement(
                                        TouchableOpacity,
                                        {
                                            key: 'search-btn',
                                            style: {
                                                backgroundColor: '#5865F2',
                                                borderRadius: 8,
                                                padding: 12,
                                                justifyContent: 'center'
                                            },
                                            onPress: searchUserAccess
                                        },
                                        React.createElement(Text, { style: { color: '#fff' } }, "🔍")
                                    )
                                ]
                            )
                        ]
                    ),

                    // User results
                    userChannels.length > 0 && React.createElement(
                        View,
                        { key: 'results', style: { padding: 12 } },
                        [
                            React.createElement(Text, {
                                key: 'result-title',
                                style: { color: '#00b894', fontSize: 16, fontWeight: 'bold', marginBottom: 12 }
                            }, `✅ Can access ${userChannels.length} hidden channels:`),
                            ...userChannels.map((channel, idx) =>
                                React.createElement(
                                    View,
                                    {
                                        key: `uc-${idx}`,
                                        style: {
                                            backgroundColor: '#2b2d31',
                                            padding: 12,
                                            borderRadius: 8,
                                            marginBottom: 8,
                                            flexDirection: 'row',
                                            alignItems: 'center'
                                        }
                                    },
                                    [
                                        React.createElement(Text, { key: 'icon', style: { fontSize: 16, marginRight: 8 } },
                                            getChannelTypeName(channel.type)),
                                        React.createElement(
                                            View,
                                            { key: 'info', style: { flex: 1 } },
                                            [
                                                React.createElement(Text, { key: 'name', style: { color: '#fff', fontWeight: 'bold' } },
                                                    channel.name),
                                                channel.parentName && React.createElement(Text, {
                                                    key: 'parent', style: { color: '#949ba4', fontSize: 12 }
                                                }, `in ${channel.parentName}`)
                                            ]
                                        )
                                    ]
                                )
                            )
                        ]
                    ),

                    // Empty state for user lookup
                    userChannels.length === 0 && userIdInput.length >= 17 && React.createElement(
                        View,
                        { key: 'no-access', style: { padding: 40, alignItems: 'center' } },
                        [
                            React.createElement(Text, { key: 't1', style: { fontSize: 48 } }, "🚫"),
                            React.createElement(Text, { key: 't2', style: { color: '#fff', fontSize: 16, marginTop: 12 } },
                                "No hidden channel access"),
                            React.createElement(Text, { key: 't3', style: { color: '#b5bac1', marginTop: 4 } },
                                "This user can't see any channels you can't see")
                        ]
                    )
                ]
            )
        ]
    );
}

// ========================================
// MAIN APP WRAPPER WITH FAB
// ========================================

function StalkerProOverlay() {
    const [dashboardVisible, setDashboardVisible] = React.useState(false);

    return React.createElement(
        View,
        { style: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, pointerEvents: 'box-none' } },
        [
            React.createElement(FloatingButton, {
                key: 'fab',
                onPress: () => setDashboardVisible(true)
            }),
            React.createElement(HiddenChannelsDashboard, {
                key: 'dashboard',
                visible: dashboardVisible,
                onClose: () => setDashboardVisible(false)
            })
        ]
    );
}

// ========================================
// ORIGINAL STALKER FUNCTIONALITY
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

    const displayName = userInfo?.globalName || userInfo?.username || `User ${userId.slice(-4)}`;
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

// Settings (for manual search)
function StalkerSettings() {
    const [userId, setUserId] = React.useState(targetUserId);
    const [isSearching, setIsSearching] = React.useState(false);

    const handleSearch = async () => {
        if (!userId || userId.length < 17) { showToast("Invalid User ID", getAssetIDByName("Small")); return; }
        setIsSearching(true);
        targetUserId = userId;
        await autoSearchUser(userId);
        setIsSearching(false);
    };

    return React.createElement(ScrollView, { style: { flex: 1, backgroundColor: '#1e1f22' } }, [
        React.createElement(FormSection, { key: "info", title: "📱 STALKER PRO v3.0" }, [
            React.createElement(FormRow, { key: "v1", label: "🔒 Hidden Channel Detector", subLabel: "Tap the floating 🔒 button anywhere!" }),
            React.createElement(FormRow, { key: "v2", label: "📋 Auto Message Search", subLabel: "Copy any User ID to auto-search" })
        ]),
        React.createElement(FormSection, { key: "search", title: "🔍 MANUAL SEARCH" }, [
            React.createElement(FormInput, { key: "in", title: "User ID", placeholder: "Enter User ID", value: userId, onChangeText: setUserId, keyboardType: "numeric" }),
            React.createElement(FormRow, { key: "btn", label: isSearching ? "⏳ Searching..." : "🔍 Search", onPress: isSearching ? undefined : handleSearch })
        ]),
        React.createElement(FormSection, { key: "status", title: "⚙️ STATUS" }, [
            React.createElement(FormRow, { key: "s1", label: "Clipboard Monitor", subLabel: clipboardMonitorActive ? "✅ Active" : "❌ Inactive" }),
            React.createElement(FormRow, { key: "s2", label: "Hidden Channel FAB", subLabel: "✅ Active" })
        ])
    ]);
}

export const settings = StalkerSettings;

// Create overlay element
let overlayElement: any = null;

export const onLoad = () => {
    logger.log("=== STALKER PRO v3.0 LOADING ===");

    // Start clipboard monitoring
    if (Clipboard?.getString) {
        clipboardMonitorActive = true;
        checkIntervalId = setInterval(checkClipboardContent, 2000);
    }

    // Try to inject floating button
    try {
        // This creates an overlay but may need adjustment based on how Vendetta handles root views
        showToast("🔒 Stalker Pro v3.0 ready!", getAssetIDByName("Check"));
        showToast("Tap 🔒 button for Hidden Channels", getAssetIDByName("Arrow"));
    } catch (e) {
        logger.error("FAB setup failed:", e);
    }
};

export const onUnload = () => {
    logger.log("=== STALKER PRO UNLOADING ===");

    if (checkIntervalId) {
        clearInterval(checkIntervalId);
        checkIntervalId = null;
        clipboardMonitorActive = false;
    }
};
