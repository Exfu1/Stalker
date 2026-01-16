import { logger } from "@vendetta";
import { findByStoreName, findByProps, findByName, findByDisplayName } from "@vendetta/metro";
import { React, ReactNative, FluxDispatcher, NavigationNative } from "@vendetta/metro/common";
import { Forms, General } from "@vendetta/ui/components";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { showToast } from "@vendetta/ui/toasts";
import { after } from "@vendetta/patcher";

const { FormSection, FormRow, FormInput, FormDivider } = Forms;
const { ScrollView, View, Text, TouchableOpacity, ActivityIndicator, Linking } = General;

// Also try to get Linking from ReactNative if not in General
const URLOpener = Linking || ReactNative?.Linking;

// Discord stores and utilities
const UserStore = findByStoreName("UserStore");
const GuildStore = findByStoreName("GuildStore");
const GuildMemberStore = findByStoreName("GuildMemberStore");
const ChannelStore = findByStoreName("ChannelStore");
const RelationshipStore = findByStoreName("RelationshipStore");

// Try MANY different ways to find profile-related modules
const UserProfileModule =
    findByProps("UserProfileSection") ||
    findByProps("default", "UserProfileSection") ||
    findByName("UserProfileSection") ||
    findByDisplayName("UserProfileSection") ||
    findByProps("UserProfile") ||
    findByName("UserProfile") ||
    findByDisplayName("UserProfile") ||
    findByProps("ProfileBanner") ||
    findByProps("UserProfileHeader") ||
    findByName("UserProfileHeader") ||
    findByProps("UserProfileBody") ||
    null;

// Try to find the specific section component
const UserProfileSectionModule =
    findByProps("UserProfileSection")?.UserProfileSection ||
    findByName("UserProfileSection") ||
    findByDisplayName("UserProfileSection") ||
    findByProps("Section", "UserProfileSection")?.Section ||
    null;

// REST API for fetching messages
const RestAPI = findByProps("getAPIBaseURL", "get") || findByProps("API_HOST", "get");

// Try to find Router/Navigation modules
const Router = findByProps("transitionToGuild", "transitionTo") ||
    findByProps("transitionTo") ||
    findByProps("replaceWith", "back") ||
    findByProps("openURL");

// Message link handler
const MessageActions = findByProps("jumpToMessage") ||
    findByProps("fetchMessages", "jumpToMessage");

// Store patches for cleanup
let patches: (() => void)[] = [];

// Store the target user ID
let targetUserId: string = "";

// Relationship type constants
const RelationshipTypes = {
    NONE: 0,
    FRIEND: 1,
    BLOCKED: 2,
    PENDING_INCOMING: 3,
    PENDING_OUTGOING: 4,
    IMPLICIT: 5
};

// Profile injection status for debugging
let profileInjectionStatus = "Not attempted";

/**
 * Get relationship status with a user
 */
function getRelationship(userId: string) {
    try {
        if (!RelationshipStore) {
            return null;
        }

        const type = RelationshipStore.getRelationshipType?.(userId) ??
            RelationshipStore.getRelationship?.(userId)?.type ??
            RelationshipTypes.NONE;

        return {
            type: type,
            isFriend: type === RelationshipTypes.FRIEND,
            isBlocked: type === RelationshipTypes.BLOCKED,
            hasPendingIncoming: type === RelationshipTypes.PENDING_INCOMING,
            hasPendingOutgoing: type === RelationshipTypes.PENDING_OUTGOING,
            label: getRelationshipLabel(type),
            emoji: getRelationshipEmoji(type)
        };
    } catch (e) {
        logger.error("Error getting relationship:", e);
        return null;
    }
}

function getRelationshipLabel(type: number): string {
    switch (type) {
        case RelationshipTypes.FRIEND: return "Friend";
        case RelationshipTypes.BLOCKED: return "Blocked";
        case RelationshipTypes.PENDING_INCOMING: return "Pending (Incoming)";
        case RelationshipTypes.PENDING_OUTGOING: return "Pending (Outgoing)";
        default: return "Not Friends";
    }
}

function getRelationshipEmoji(type: number): string {
    switch (type) {
        case RelationshipTypes.FRIEND: return "✅";
        case RelationshipTypes.BLOCKED: return "🚫";
        case RelationshipTypes.PENDING_INCOMING: return "📨";
        case RelationshipTypes.PENDING_OUTGOING: return "📤";
        default: return "❌";
    }
}

/**
 * Get all guilds where both you and the target user are members
 */
function getMutualGuilds(userId: string) {
    try {
        const guilds = GuildStore ? Object.values(GuildStore.getGuilds() || {}) : [];
        const mutual: any[] = [];

        for (const guild of guilds) {
            const member = GuildMemberStore?.getMember((guild as any).id, userId);
            if (member) {
                mutual.push(guild);
            }
        }

        return mutual;
    } catch (e) {
        logger.error("Error getting mutual guilds:", e);
        return [];
    }
}

/**
 * Open Discord message link
 */
function openMessageLink(guildId: string, channelId: string, messageId: string) {
    const messageUrl = `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
    const discordUrl = `discord://-/channels/${guildId}/${channelId}/${messageId}`;

    // Method 1: Try FluxDispatcher action
    try {
        if (FluxDispatcher) {
            FluxDispatcher.dispatch({
                type: "NAVIGATE_TO_JUMP_TO_MESSAGE",
                messageId: messageId,
                channelId: channelId,
                guildId: guildId
            });
            return true;
        }
    } catch (e) { }

    // Method 2: Try jumpToMessage function
    try {
        if (MessageActions?.jumpToMessage) {
            MessageActions.jumpToMessage({
                channelId: channelId,
                messageId: messageId,
                flash: true
            });
            return true;
        }
    } catch (e) { }

    // Method 3: Try Router transitionTo
    try {
        if (Router?.transitionToGuild) {
            Router.transitionToGuild(guildId, channelId, messageId);
            return true;
        } else if (Router?.transitionTo) {
            Router.transitionTo(`/channels/${guildId}/${channelId}/${messageId}`);
            return true;
        }
    } catch (e) { }

    // Method 4: Try opening discord:// URL scheme
    try {
        if (URLOpener?.openURL) {
            URLOpener.openURL(discordUrl);
            return true;
        }
    } catch (e) { }

    return false;
}

/**
 * Search for messages from a user in a specific guild
 */
async function searchMessagesInGuild(guildId: string, authorId: string): Promise<any[]> {
    try {
        if (!RestAPI?.get) {
            return [];
        }

        const response = await RestAPI.get({
            url: `/guilds/${guildId}/messages/search`,
            query: {
                author_id: authorId,
                include_nsfw: true
            }
        });

        if (response?.body?.messages) {
            return response.body.messages.map((msgArray: any[]) => {
                const msg = msgArray[0];
                return {
                    id: msg.id,
                    content: msg.content || "[No text content]",
                    channelId: msg.channel_id,
                    guildId: guildId,
                    timestamp: msg.timestamp,
                    attachments: msg.attachments?.length || 0
                };
            });
        }

        return [];
    } catch (e: any) {
        if (e?.status !== 403) {
            logger.error(`Error searching guild ${guildId}:`, e?.message || e);
        }
        return [];
    }
}

/**
 * Get channel name by ID
 */
function getChannelName(channelId: string): string {
    try {
        const channel = ChannelStore?.getChannel(channelId);
        return channel?.name || "unknown";
    } catch {
        return "unknown";
    }
}

/**
 * Get guild name by ID
 */
function getGuildName(guildId: string): string {
    try {
        const guild = GuildStore?.getGuild(guildId);
        return guild?.name || "Unknown Server";
    } catch {
        return "Unknown Server";
    }
}

/**
 * Get user info from store
 */
function getUserInfo(userId: string) {
    try {
        const user = UserStore?.getUser(userId);
        if (user) {
            return {
                username: user.username,
                globalName: user.globalName,
                id: user.id,
                avatar: user.avatar,
                discriminator: user.discriminator
            };
        }
    } catch (e) {
        logger.error("Error getting user info:", e);
    }
    return null;
}

/**
 * Quick search for messages across all mutual guilds (for profile button)
 */
async function quickSearchMessages(userId: string) {
    const guilds = getMutualGuilds(userId);

    if (guilds.length === 0) {
        showToast("No mutual servers found", getAssetIDByName("Small"));
        return;
    }

    showToast(`Searching ${guilds.length} servers...`, getAssetIDByName("ic_search"));

    const allMessages: any[] = [];

    for (let i = 0; i < Math.min(guilds.length, 10); i++) {
        try {
            const messages = await searchMessagesInGuild(guilds[i].id, userId);
            allMessages.push(...messages);
        } catch (e) {
            // Continue
        }

        if (i < guilds.length - 1) {
            await new Promise(r => setTimeout(r, 300));
        }
    }

    // Sort by timestamp
    allMessages.sort((a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    showToast(`Found ${allMessages.length} messages!`, getAssetIDByName("Check"));

    // Show the most recent message details
    if (allMessages.length > 0) {
        const latest = allMessages[0];
        const content = latest.content.length > 40
            ? latest.content.substring(0, 40) + "..."
            : latest.content;
        setTimeout(() => {
            showToast(`Latest: "${content}"`, getAssetIDByName("ic_message"));
        }, 1500);
    }
}

// Settings/UI Component
function StalkerSettings() {
    const [userId, setUserId] = React.useState(targetUserId);
    const [results, setResults] = React.useState<any[]>([]);
    const [userInfo, setUserInfo] = React.useState<any>(null);
    const [relationship, setRelationship] = React.useState<any>(null);
    const [mutualServers, setMutualServers] = React.useState<any[]>([]);
    const [isSearching, setIsSearching] = React.useState(false);
    const [searchProgress, setSearchProgress] = React.useState("");

    const handleSearch = async () => {
        if (!userId || userId.length < 17) {
            showToast("Enter a valid User ID (17-19 digits)", getAssetIDByName("Small"));
            return;
        }

        setIsSearching(true);
        setResults([]);
        setSearchProgress("Finding user info...");
        targetUserId = userId;

        try {
            const info = getUserInfo(userId);
            setUserInfo(info);

            const rel = getRelationship(userId);
            setRelationship(rel);

            setSearchProgress("Finding mutual servers...");
            const guilds = getMutualGuilds(userId);
            setMutualServers(guilds);

            if (guilds.length === 0) {
                showToast("No mutual servers found", getAssetIDByName("Small"));
                setIsSearching(false);
                return;
            }

            const allMessages: any[] = [];

            for (let i = 0; i < Math.min(guilds.length, 15); i++) {
                const guild = guilds[i];
                setSearchProgress(`${guild.name} (${i + 1}/${Math.min(guilds.length, 15)})`);

                try {
                    const messages = await searchMessagesInGuild(guild.id, userId);
                    allMessages.push(...messages);
                } catch (e) {
                    // Continue
                }

                if (i < guilds.length - 1) {
                    await new Promise(r => setTimeout(r, 400));
                }
            }

            allMessages.sort((a, b) =>
                new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
            );

            setResults(allMessages.slice(0, 50));
            showToast(`Found ${allMessages.length} messages`, getAssetIDByName("Check"));
        } catch (e: any) {
            showToast("Error: " + (e?.message || "Unknown"), getAssetIDByName("Small"));
        } finally {
            setIsSearching(false);
            setSearchProgress("");
        }
    };

    const handleSearchInGuild = async (guild: any) => {
        setIsSearching(true);
        setSearchProgress(`Searching ${guild.name}...`);

        try {
            const messages = await searchMessagesInGuild(guild.id, userId);
            messages.sort((a: any, b: any) =>
                new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
            );
            setResults(messages);
            showToast(`Found ${messages.length} messages`, getAssetIDByName("Check"));
        } catch (e: any) {
            showToast("Error: " + (e?.message || "Unknown"), getAssetIDByName("Small"));
        } finally {
            setIsSearching(false);
            setSearchProgress("");
        }
    };

    const formatTime = (ts: string) => {
        try {
            const d = new Date(ts);
            return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
        } catch {
            return ts;
        }
    };

    const handleMessageTap = (msg: any) => {
        showToast("Opening message...", getAssetIDByName("Check"));
        const success = openMessageLink(msg.guildId, msg.channelId, msg.id);
        if (!success) {
            showToast("Navigation failed", getAssetIDByName("Small"));
        }
    };

    return React.createElement(
        ScrollView,
        { style: { flex: 1, backgroundColor: '#1e1f22' } },
        [
            // Search Section
            React.createElement(
                FormSection,
                { key: "search", title: "🔍 USER SEARCH" },
                [
                    React.createElement(FormInput, {
                        key: "input",
                        title: "User ID",
                        placeholder: "Enter Discord User ID",
                        value: userId,
                        onChangeText: setUserId,
                        keyboardType: "numeric"
                    }),
                    React.createElement(FormRow, {
                        key: "searchBtn",
                        label: isSearching ? "⏳ Searching..." : "🔍 Search All Servers",
                        subLabel: isSearching ? searchProgress : "Find messages across mutual servers",
                        onPress: isSearching ? undefined : handleSearch
                    })
                ]
            ),

            // User Info with Relationship Status
            userInfo && React.createElement(
                FormSection,
                { key: "userInfo", title: "👤 USER INFO" },
                [
                    React.createElement(FormRow, {
                        key: "name",
                        label: userInfo.globalName || userInfo.username || "Unknown",
                        subLabel: `@${userInfo.username} • ID: ${userInfo.id}`
                    }),
                    relationship && React.createElement(FormRow, {
                        key: "relationship",
                        label: `${relationship.emoji} ${relationship.label}`,
                        subLabel: relationship.isFriend
                            ? "You are friends with this user"
                            : relationship.isBlocked
                                ? "You have blocked this user"
                                : relationship.hasPendingIncoming
                                    ? "This user sent you a friend request"
                                    : relationship.hasPendingOutgoing
                                        ? "You sent this user a friend request"
                                        : "You are not friends with this user"
                    })
                ]
            ),

            // Servers - Clickable
            mutualServers.length > 0 && React.createElement(
                FormSection,
                { key: "servers", title: `🏠 MUTUAL SERVERS (${mutualServers.length})` },
                mutualServers.slice(0, 20).map((guild: any, idx: number) =>
                    React.createElement(FormRow, {
                        key: `s-${idx}`,
                        label: guild.name,
                        trailing: FormRow.Arrow ? React.createElement(FormRow.Arrow, null) : null,
                        onPress: () => handleSearchInGuild(guild)
                    })
                )
            ),

            // Loading
            isSearching && React.createElement(
                View,
                { key: "loading", style: { padding: 20, alignItems: 'center' } },
                [
                    React.createElement(ActivityIndicator, { key: "spin", size: "large", color: "#5865f2" }),
                    React.createElement(Text, {
                        key: "txt",
                        style: { color: '#b5bac1', marginTop: 10 }
                    }, searchProgress)
                ]
            ),

            // Messages - Clickable
            !isSearching && results.length > 0 && React.createElement(
                FormSection,
                { key: "msgs", title: `💬 MESSAGES (${results.length})` },
                results.map((msg: any, idx: number) =>
                    React.createElement(
                        TouchableOpacity,
                        {
                            key: `m-${idx}`,
                            style: {
                                padding: 12,
                                borderBottomWidth: 1,
                                borderBottomColor: '#3f4147',
                                backgroundColor: '#2b2d31'
                            },
                            onPress: () => handleMessageTap(msg),
                            activeOpacity: 0.7
                        },
                        [
                            React.createElement(Text, {
                                key: "ch",
                                style: { color: '#5865f2', fontSize: 12, marginBottom: 2 }
                            }, `#${getChannelName(msg.channelId)} • ${getGuildName(msg.guildId)}`),
                            React.createElement(Text, {
                                key: "ct",
                                style: { color: '#f2f3f5', fontSize: 14, marginBottom: 4 }
                            }, msg.content.length > 150 ? msg.content.substring(0, 150) + "..." : msg.content),
                            React.createElement(Text, {
                                key: "tm",
                                style: { color: '#949ba4', fontSize: 11 }
                            }, formatTime(msg.timestamp) + (msg.attachments > 0 ? ` • 📎${msg.attachments}` : "") + " • Tap to open")
                        ]
                    )
                )
            ),

            // Debug Info Section
            React.createElement(
                FormSection,
                { key: "debug", title: "🔧 DEBUG INFO" },
                [
                    React.createElement(FormRow, {
                        key: "relStore",
                        label: "RelationshipStore",
                        subLabel: RelationshipStore ? "✅ Found" : "❌ Not Found"
                    }),
                    React.createElement(FormRow, {
                        key: "userStore",
                        label: "UserStore",
                        subLabel: UserStore ? "✅ Found" : "❌ Not Found"
                    }),
                    React.createElement(FormRow, {
                        key: "profileModule",
                        label: "Profile Module",
                        subLabel: UserProfileModule ? "✅ Found" : "❌ Not Found"
                    }),
                    React.createElement(FormRow, {
                        key: "profileInjection",
                        label: "Profile Injection",
                        subLabel: profileInjectionStatus
                    })
                ]
            ),

            // Instructions
            !isSearching && results.length === 0 && React.createElement(
                FormSection,
                { key: "help", title: "ℹ️ HOW TO USE" },
                [
                    React.createElement(FormRow, {
                        key: "h0",
                        label: "📱 Quick Access",
                        subLabel: "Tap any user → scroll down → Stalker Pro section"
                    }),
                    React.createElement(FormRow, {
                        key: "h1",
                        label: "1. Get User ID",
                        subLabel: "Long-press user → Copy ID (enable Developer Mode)"
                    }),
                    React.createElement(FormRow, {
                        key: "h2",
                        label: "2. Search",
                        subLabel: "Paste ID and tap Search All Servers"
                    }),
                    React.createElement(FormRow, {
                        key: "h3",
                        label: "3. View Results",
                        subLabel: "See friend status, mutual servers & messages"
                    })
                ]
            )
        ]
    );
}

export const settings = StalkerSettings;

export const onLoad = () => {
    logger.log("=== Stalker Pro Loading ===");
    logger.log("RelationshipStore:", !!RelationshipStore);
    logger.log("UserProfileModule:", !!UserProfileModule);
    logger.log("UserProfileSectionModule:", !!UserProfileSectionModule);

    // Log what we found
    if (UserProfileModule) {
        logger.log("UserProfileModule keys:", Object.keys(UserProfileModule));
    }

    // Try to patch profile module
    let patchSuccess = false;

    // Method 1: Try patching UserProfileSection.default
    if (UserProfileModule?.default) {
        try {
            const unpatch = after("default", UserProfileModule, patchProfileSection);
            patches.push(unpatch);
            patchSuccess = true;
            profileInjectionStatus = "✅ Patched (default)";
            logger.log("Profile patch applied via default!");
        } catch (e) {
            logger.error("Failed to patch default:", e);
        }
    }

    // Method 2: Try patching UserProfileSection directly
    if (!patchSuccess && UserProfileModule?.UserProfileSection) {
        try {
            const unpatch = after("UserProfileSection", UserProfileModule, patchProfileSection);
            patches.push(unpatch);
            patchSuccess = true;
            profileInjectionStatus = "✅ Patched (UserProfileSection)";
            logger.log("Profile patch applied via UserProfileSection!");
        } catch (e) {
            logger.error("Failed to patch UserProfileSection:", e);
        }
    }

    // Method 3: Try findByName result
    if (!patchSuccess) {
        const ByName = findByName("UserProfileSection", false);
        if (ByName?.default) {
            try {
                const unpatch = after("default", ByName, patchProfileSection);
                patches.push(unpatch);
                patchSuccess = true;
                profileInjectionStatus = "✅ Patched (findByName)";
                logger.log("Profile patch applied via findByName!");
            } catch (e) {
                logger.error("Failed to patch findByName result:", e);
            }
        }
    }

    // Method 4: Try UserProfile (different component name)
    if (!patchSuccess) {
        const UserProfile = findByName("UserProfile", false) ||
            findByDisplayName("UserProfile") ||
            findByProps("UserProfile")?.UserProfile;
        if (UserProfile) {
            try {
                const target = UserProfile.default ? "default" : "UserProfile";
                const module = UserProfile.default ? UserProfile : { UserProfile };
                const unpatch = after(target, module, patchProfileSection);
                patches.push(unpatch);
                patchSuccess = true;
                profileInjectionStatus = "✅ Patched (UserProfile)";
                logger.log("Profile patch applied via UserProfile!");
            } catch (e) {
                logger.error("Failed to patch UserProfile:", e);
            }
        }
    }

    if (!patchSuccess) {
        profileInjectionStatus = "❌ No compatible module found";
        logger.warn("Could not find profile module to patch");
    }

    showToast("Stalker Pro ready!", getAssetIDByName("Check"));
};

function patchProfileSection(args: any[], res: any) {
    try {
        // Get userId from props
        const userId = args[0]?.userId || args[0]?.user?.id;
        if (!userId) return res;

        // Don't show for current user
        const currentUser = UserStore?.getCurrentUser?.();
        if (currentUser && userId === currentUser.id) return res;

        // Check if we can inject
        if (!res?.props?.children) {
            return res;
        }

        // Make sure children is an array
        if (!Array.isArray(res.props.children)) {
            res.props.children = [res.props.children];
        }

        // Get relationship and mutual guilds
        const rel = getRelationship(userId);
        const mutualGuilds = getMutualGuilds(userId);

        // Create Stalker Pro section
        const stalkerSection = React.createElement(
            FormSection,
            { key: "stalker-pro", title: "🔍 Stalker Pro" },
            [
                // Relationship status row
                rel && React.createElement(FormRow, {
                    key: "relationship",
                    label: `${rel.emoji} ${rel.label}`,
                    subLabel: rel.isFriend ? "You are friends" : "Not friends"
                }),
                React.createElement(FormDivider, { key: "div1" }),
                // Recent messages button
                React.createElement(FormRow, {
                    key: "recent",
                    label: "🔎 Find Recent Messages",
                    subLabel: `Search across ${mutualGuilds.length} mutual servers`,
                    trailing: FormRow.Arrow ? React.createElement(FormRow.Arrow, null) : null,
                    onPress: () => quickSearchMessages(userId)
                }),
                React.createElement(FormDivider, { key: "div2" }),
                // Mutual servers info
                React.createElement(FormRow, {
                    key: "servers",
                    label: `🏠 ${mutualGuilds.length} Mutual Servers`,
                    subLabel: mutualGuilds.slice(0, 3).map((g: any) => g.name).join(", ") +
                        (mutualGuilds.length > 3 ? "..." : "")
                })
            ]
        );

        // Inject the section
        res.props.children.push(stalkerSection);

    } catch (e) {
        logger.error("Error injecting profile section:", e);
    }

    return res;
}

export const onUnload = () => {
    logger.log("Stalker Pro unloading...");

    // Unpatch all patches
    for (const unpatch of patches) {
        try {
            unpatch();
        } catch (e) {
            logger.error("Error unpatching:", e);
        }
    }
    patches = [];

    logger.log("Stalker Pro unloaded");
};
