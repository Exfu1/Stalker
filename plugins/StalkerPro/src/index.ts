import { logger } from "@vendetta";
import { findByStoreName, findByProps } from "@vendetta/metro";
import { React, NavigationNative, ReactNative } from "@vendetta/metro/common";
import { Forms, General } from "@vendetta/ui/components";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { showToast } from "@vendetta/ui/toasts";

const { FormSection, FormRow, FormDivider, FormInput } = Forms;
const { ScrollView, View, Text, TouchableOpacity, ActivityIndicator } = General;

// Discord stores and utilities
const UserStore = findByStoreName("UserStore");
const GuildStore = findByStoreName("GuildStore");
const GuildMemberStore = findByStoreName("GuildMemberStore");
const ChannelStore = findByStoreName("ChannelStore");

// Try to find navigation/transitioner utilities
const NavigationUtils = findByProps("transitionToGuild") || findByProps("transitionTo");
const MessageLinkUtils = findByProps("jumpToMessage") || findByProps("transitionToGuildSync");
const SearchUtils = findByProps("searchGuildMessages") || findByProps("search");

// REST API for fetching messages
const RestAPI = findByProps("getAPIBaseURL", "get") || findByProps("API_HOST", "get");

// Store the target user ID
let targetUserId: string = "";

/**
 * Get all guilds (servers) where both you and the target user are members
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
 * Navigate to a guild
 */
function navigateToGuild(guildId: string) {
    try {
        if (NavigationUtils?.transitionToGuild) {
            NavigationUtils.transitionToGuild(guildId);
            return true;
        } else if (NavigationUtils?.transitionTo) {
            NavigationUtils.transitionTo(`/channels/${guildId}`);
            return true;
        }
    } catch (e) {
        logger.error("Error navigating to guild:", e);
    }
    return false;
}

/**
 * Navigate to a specific message
 */
function navigateToMessage(guildId: string, channelId: string, messageId: string) {
    try {
        if (MessageLinkUtils?.jumpToMessage) {
            MessageLinkUtils.jumpToMessage({
                guildId,
                channelId,
                messageId
            });
            return true;
        } else if (NavigationUtils?.transitionTo) {
            NavigationUtils.transitionTo(`/channels/${guildId}/${channelId}/${messageId}`);
            return true;
        }
    } catch (e) {
        logger.error("Error navigating to message:", e);
    }
    return false;
}

/**
 * Search for messages from a user in a specific guild using Discord's search API
 */
async function searchMessagesInGuild(guildId: string, authorId: string): Promise<any[]> {
    try {
        // Use Discord's internal REST API
        if (!RestAPI?.get) {
            logger.error("RestAPI not found");
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
            // Discord returns nested arrays, flatten and map
            return response.body.messages.map((msgArray: any[]) => {
                const msg = msgArray[0]; // First message in the context
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
        // 403 means no access, which is expected for some channels
        if (e?.status !== 403) {
            logger.error(`Error searching messages in guild ${guildId}:`, e?.message || e);
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
        return channel?.name || "unknown-channel";
    } catch {
        return "unknown-channel";
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
                discriminator: user.discriminator,
                globalName: user.globalName,
                avatar: user.avatar,
                id: user.id
            };
        }
    } catch (e) {
        logger.error("Error getting user info:", e);
    }
    return null;
}

// Settings/UI Component
function StalkerSettings() {
    const [userId, setUserId] = React.useState(targetUserId);
    const [results, setResults] = React.useState<any[]>([]);
    const [userInfo, setUserInfo] = React.useState<any>(null);
    const [mutualServers, setMutualServers] = React.useState<any[]>([]);
    const [isSearching, setIsSearching] = React.useState(false);
    const [searchProgress, setSearchProgress] = React.useState("");
    const [selectedGuild, setSelectedGuild] = React.useState<string | null>(null);

    const handleSearch = async () => {
        if (!userId || userId.length < 17) {
            showToast("Please enter a valid User ID (17-19 digits)", getAssetIDByName("Small"));
            return;
        }

        setIsSearching(true);
        setResults([]);
        setSearchProgress("Finding mutual servers...");
        targetUserId = userId;

        try {
            // Get user info
            const info = getUserInfo(userId);
            setUserInfo(info);

            // Get mutual guilds
            const guilds = getMutualGuilds(userId);
            setMutualServers(guilds);

            if (guilds.length === 0) {
                showToast("No mutual servers found with this user", getAssetIDByName("Small"));
                setIsSearching(false);
                return;
            }

            // Search for messages in each guild
            const allMessages: any[] = [];

            for (let i = 0; i < guilds.length; i++) {
                const guild = guilds[i];
                setSearchProgress(`Searching ${guild.name} (${i + 1}/${guilds.length})...`);

                try {
                    const messages = await searchMessagesInGuild(guild.id, userId);
                    allMessages.push(...messages);
                } catch (e) {
                    // Continue with other guilds
                }

                // Small delay to avoid rate limiting
                if (i < guilds.length - 1) {
                    await new Promise(r => setTimeout(r, 300));
                }
            }

            // Sort by timestamp, newest first
            allMessages.sort((a, b) =>
                new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
            );

            setResults(allMessages.slice(0, 50)); // Limit to 50 most recent
            setSearchProgress("");

            showToast(
                `Found ${allMessages.length} messages in ${guilds.length} servers`,
                getAssetIDByName("Check")
            );
        } catch (e: any) {
            showToast("Error: " + (e?.message || "Unknown error"), getAssetIDByName("Small"));
            logger.error("Search error:", e);
        } finally {
            setIsSearching(false);
            setSearchProgress("");
        }
    };

    const handleSearchInGuild = async (guild: any) => {
        setSelectedGuild(guild.id);
        setIsSearching(true);
        setSearchProgress(`Searching in ${guild.name}...`);

        try {
            const messages = await searchMessagesInGuild(guild.id, userId);

            messages.sort((a: any, b: any) =>
                new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
            );

            setResults(messages);

            showToast(
                `Found ${messages.length} messages in ${guild.name}`,
                getAssetIDByName("Check")
            );
        } catch (e: any) {
            showToast("Error searching: " + (e?.message || "Unknown"), getAssetIDByName("Small"));
        } finally {
            setIsSearching(false);
            setSearchProgress("");
        }
    };

    const formatTimestamp = (ts: string) => {
        try {
            const date = new Date(ts);
            return date.toLocaleDateString() + " " + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } catch {
            return ts;
        }
    };

    return React.createElement(
        ScrollView,
        { style: { flex: 1 } },
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
                        subLabel: isSearching ? searchProgress : "Search for messages across all mutual servers",
                        onPress: isSearching ? undefined : handleSearch
                    })
                ]
            ),

            // User Info Section
            userInfo && React.createElement(
                FormSection,
                { key: "userInfo", title: "👤 USER INFO" },
                [
                    React.createElement(FormRow, {
                        key: "name",
                        label: "Username",
                        subLabel: userInfo.globalName || userInfo.username || "Unknown"
                    }),
                    React.createElement(FormRow, {
                        key: "id",
                        label: "User ID",
                        subLabel: userInfo.id
                    })
                ]
            ),

            // Mutual Servers Section - Now clickable!
            mutualServers.length > 0 && React.createElement(
                FormSection,
                { key: "servers", title: `🏠 MUTUAL SERVERS (${mutualServers.length}) - Tap to search` },
                mutualServers.map((guild: any, index: number) =>
                    React.createElement(FormRow, {
                        key: `server-${index}`,
                        label: guild.name,
                        subLabel: selectedGuild === guild.id ? "✓ Selected" : "Tap to search messages here",
                        trailing: FormRow.Arrow ? React.createElement(FormRow.Arrow, null) : null,
                        onPress: () => handleSearchInGuild(guild)
                    })
                )
            ),

            // Loading indicator
            isSearching && React.createElement(
                View,
                { key: "loading", style: { padding: 20, alignItems: 'center' } },
                [
                    React.createElement(ActivityIndicator, { key: "spinner", size: "large", color: "#7289da" }),
                    React.createElement(Text, {
                        key: "progress",
                        style: { color: '#b9bbbe', marginTop: 10, textAlign: 'center' }
                    }, searchProgress)
                ]
            ),

            // Messages Section - Now clickable to jump!
            !isSearching && results.length > 0 && React.createElement(
                FormSection,
                { key: "messages", title: `💬 MESSAGES (${results.length}) - Tap to jump` },
                results.map((msg: any, index: number) =>
                    React.createElement(
                        TouchableOpacity,
                        {
                            key: `msg-${index}`,
                            style: {
                                padding: 12,
                                borderBottomWidth: 1,
                                borderBottomColor: '#2f3136',
                                backgroundColor: '#36393f'
                            },
                            onPress: () => {
                                const success = navigateToMessage(msg.guildId, msg.channelId, msg.id);
                                if (success) {
                                    showToast("Jumping to message...", getAssetIDByName("Check"));
                                } else {
                                    showToast("Could not navigate to message", getAssetIDByName("Small"));
                                }
                            }
                        },
                        [
                            React.createElement(Text, {
                                key: "header",
                                style: { color: '#7289da', fontSize: 12, marginBottom: 4 }
                            }, `#${getChannelName(msg.channelId)} • ${getGuildName(msg.guildId)}`),
                            React.createElement(Text, {
                                key: "content",
                                style: { color: '#dcddde', fontSize: 14, marginBottom: 4 }
                            }, msg.content.substring(0, 200) + (msg.content.length > 200 ? "..." : "")),
                            React.createElement(Text, {
                                key: "time",
                                style: { color: '#72767d', fontSize: 11 }
                            }, formatTimestamp(msg.timestamp) + (msg.attachments > 0 ? ` • 📎 ${msg.attachments}` : ""))
                        ]
                    )
                )
            ),

            // No results message
            !isSearching && results.length === 0 && mutualServers.length > 0 && React.createElement(
                FormSection,
                { key: "noResults", title: "ℹ️ RESULTS" },
                [
                    React.createElement(FormRow, {
                        key: "noMsg",
                        label: "Tap a server above to search",
                        subLabel: "Or use 'Search All Servers' for a complete search"
                    })
                ]
            ),

            // Help Section
            React.createElement(
                FormSection,
                { key: "help", title: "❓ HOW TO USE" },
                [
                    React.createElement(FormRow, {
                        key: "h1",
                        label: "1. Get User ID",
                        subLabel: "Long-press user > Copy ID (Dev Mode required)"
                    }),
                    React.createElement(FormRow, {
                        key: "h2",
                        label: "2. Enter ID & Search",
                        subLabel: "Searches Discord's API for real messages"
                    }),
                    React.createElement(FormRow, {
                        key: "h3",
                        label: "3. Tap Messages",
                        subLabel: "Jump directly to any message"
                    })
                ]
            )
        ]
    );
}

// Export the settings component
export const settings = StalkerSettings;

export const onLoad = () => {
    logger.log("Stalker Pro: Plugin loaded!");
    showToast("Stalker Pro loaded!", getAssetIDByName("Check"));
};

export const onUnload = () => {
    logger.log("Stalker Pro: Plugin unloaded");
};
