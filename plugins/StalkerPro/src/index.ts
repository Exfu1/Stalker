import { logger } from "@vendetta";
import { findByStoreName, findByProps } from "@vendetta/metro";
import { React, ReactNative, FluxDispatcher } from "@vendetta/metro/common";
import { Forms, General } from "@vendetta/ui/components";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { showToast } from "@vendetta/ui/toasts";

const { FormSection, FormRow, FormInput } = Forms;
const { ScrollView, View, Text, TouchableOpacity, ActivityIndicator, Linking } = General;

// Also try to get Linking from ReactNative if not in General
const URLOpener = Linking || ReactNative?.Linking;

// Discord stores and utilities
const UserStore = findByStoreName("UserStore");
const GuildStore = findByStoreName("GuildStore");
const GuildMemberStore = findByStoreName("GuildMemberStore");
const ChannelStore = findByStoreName("ChannelStore");

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

// Store the target user ID
let targetUserId: string = "";

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
 * Open Discord message link - this opens the message in Discord's navigation
 */
function openMessageLink(guildId: string, channelId: string, messageId: string) {
    const messageUrl = `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
    const discordUrl = `discord://-/channels/${guildId}/${channelId}/${messageId}`;

    logger.log("Attempting to open:", discordUrl);

    // Method 1: Try FluxDispatcher action
    try {
        if (FluxDispatcher) {
            FluxDispatcher.dispatch({
                type: "NAVIGATE_TO_JUMP_TO_MESSAGE",
                messageId: messageId,
                channelId: channelId,
                guildId: guildId
            });
            logger.log("FluxDispatcher NAVIGATE_TO_JUMP_TO_MESSAGE dispatched");
        }
    } catch (e) {
        logger.error("FluxDispatcher method failed:", e);
    }

    // Method 2: Try jumpToMessage function
    try {
        if (MessageActions?.jumpToMessage) {
            MessageActions.jumpToMessage({
                channelId: channelId,
                messageId: messageId,
                flash: true
            });
            logger.log("jumpToMessage called");
            return true;
        }
    } catch (e) {
        logger.error("jumpToMessage method failed:", e);
    }

    // Method 3: Try Router transitionTo
    try {
        if (Router?.transitionToGuild) {
            Router.transitionToGuild(guildId, channelId, messageId);
            logger.log("transitionToGuild called");
            return true;
        } else if (Router?.transitionTo) {
            Router.transitionTo(`/channels/${guildId}/${channelId}/${messageId}`);
            logger.log("transitionTo called");
            return true;
        }
    } catch (e) {
        logger.error("Router method failed:", e);
    }

    // Method 4: Try opening discord:// URL scheme
    try {
        if (URLOpener?.openURL) {
            URLOpener.openURL(discordUrl);
            logger.log("openURL called with discord:// scheme");
            return true;
        }
    } catch (e) {
        logger.error("URL opener method failed:", e);
    }

    // Method 5: Dispatch MESSAGE_LINK_PRESSED action
    try {
        if (FluxDispatcher) {
            FluxDispatcher.dispatch({
                type: "MESSAGE_LINK_PRESSED",
                href: messageUrl
            });
            logger.log("MESSAGE_LINK_PRESSED dispatched");
            return true;
        }
    } catch (e) {
        logger.error("MESSAGE_LINK_PRESSED dispatch failed:", e);
    }

    return false;
}

/**
 * Search for messages from a user in a specific guild
 */
async function searchMessagesInGuild(guildId: string, authorId: string): Promise<any[]> {
    try {
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

    const handleSearch = async () => {
        if (!userId || userId.length < 17) {
            showToast("Enter a valid User ID (17-19 digits)", getAssetIDByName("Small"));
            return;
        }

        setIsSearching(true);
        setResults([]);
        setSearchProgress("Finding mutual servers...");
        targetUserId = userId;

        try {
            const info = getUserInfo(userId);
            setUserInfo(info);

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
        logger.log(`Tapping message: ${msg.id} in channel ${msg.channelId}`);
        showToast("Opening message...", getAssetIDByName("Check"));

        const success = openMessageLink(msg.guildId, msg.channelId, msg.id);

        if (!success) {
            // Fallback: Copy the message link
            const link = `https://discord.com/channels/${msg.guildId}/${msg.channelId}/${msg.id}`;
            showToast("Navigation failed, check logs", getAssetIDByName("Small"));
            logger.log("Navigation failed. Message link:", link);
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

            // User Info
            userInfo && React.createElement(
                FormSection,
                { key: "userInfo", title: "👤 USER" },
                [
                    React.createElement(FormRow, {
                        key: "name",
                        label: userInfo.globalName || userInfo.username || "Unknown",
                        subLabel: `ID: ${userInfo.id}`
                    })
                ]
            ),

            // Servers - Clickable
            mutualServers.length > 0 && React.createElement(
                FormSection,
                { key: "servers", title: `🏠 SERVERS (${mutualServers.length})` },
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

            // Instructions
            !isSearching && results.length === 0 && React.createElement(
                FormSection,
                { key: "help", title: "ℹ️ HELP" },
                [
                    React.createElement(FormRow, {
                        key: "h1",
                        label: "1. Enter User ID",
                        subLabel: "Long-press user → Copy ID"
                    }),
                    React.createElement(FormRow, {
                        key: "h2",
                        label: "2. Search",
                        subLabel: "Tap a server or Search All"
                    }),
                    React.createElement(FormRow, {
                        key: "h3",
                        label: "3. Tap Message",
                        subLabel: "Opens message in Discord"
                    })
                ]
            )
        ]
    );
}

export const settings = StalkerSettings;

export const onLoad = () => {
    logger.log("Stalker Pro loaded");
    logger.log("Router found:", !!Router);
    logger.log("FluxDispatcher found:", !!FluxDispatcher);
    logger.log("MessageActions found:", !!MessageActions);
    logger.log("URLOpener found:", !!URLOpener);
    showToast("Stalker Pro ready!", getAssetIDByName("Check"));
};

export const onUnload = () => {
    logger.log("Stalker Pro unloaded");
};
