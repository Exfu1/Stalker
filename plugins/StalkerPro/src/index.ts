import { logger } from "@vendetta";
import { findByStoreName, findByProps } from "@vendetta/metro";
import { React, NavigationNative } from "@vendetta/metro/common";
import { Forms, General } from "@vendetta/ui/components";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { showToast } from "@vendetta/ui/toasts";

const { FormSection, FormRow, FormDivider, FormInput } = Forms;
const { ScrollView, View, Text } = General;

// Discord stores
const UserStore = findByStoreName("UserStore");
const GuildStore = findByStoreName("GuildStore");
const ChannelStore = findByStoreName("ChannelStore");
const MessageStore = findByStoreName("MessageStore");
const GuildMemberStore = findByStoreName("GuildMemberStore");

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
 * Find recent messages from a user across mutual servers
 */
function findRecentMessages(userId: string, mutualGuilds: any[]) {
    const results: any[] = [];

    for (const guild of mutualGuilds) {
        try {
            const channels = ChannelStore
                ? Object.values(ChannelStore.getChannels?.() || ChannelStore.getMutableGuildChannels?.() || {})
                : [];

            // Filter to text channels in this guild
            const textChannels = channels.filter((c: any) =>
                c.guild_id === guild.id && c.type === 0
            );

            for (const channel of textChannels) {
                const messages = MessageStore?.getMessages((channel as any).id);

                if (messages?._array) {
                    const userMsgs = messages._array.filter((m: any) =>
                        m.author?.id === userId
                    );

                    // Get up to 3 messages per channel
                    for (let k = 0; k < Math.min(userMsgs.length, 3); k++) {
                        results.push({
                            id: userMsgs[k].id,
                            content: (userMsgs[k].content || "").substring(0, 100),
                            channel: (channel as any).name,
                            guild: guild.name,
                            timestamp: userMsgs[k].timestamp
                        });
                    }
                }
            }
        } catch (e) {
            // Silently continue on errors
        }
    }

    // Sort by timestamp, newest first
    results.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return results.slice(0, 15);
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

    const handleSearch = () => {
        if (!userId || userId.length < 17) {
            showToast("Please enter a valid User ID", getAssetIDByName("Small"));
            return;
        }

        setIsSearching(true);
        targetUserId = userId;

        try {
            // Get user info
            const info = getUserInfo(userId);
            setUserInfo(info);

            // Get mutual guilds
            const guilds = getMutualGuilds(userId);
            setMutualServers(guilds);

            // Find messages
            const msgs = findRecentMessages(userId, guilds);
            setResults(msgs);

            showToast(
                `Found ${msgs.length} messages in ${guilds.length} servers`,
                getAssetIDByName("Check")
            );
        } catch (e: any) {
            showToast("Error searching: " + (e?.message || "Unknown"), getAssetIDByName("Small"));
        } finally {
            setIsSearching(false);
        }
    };

    return React.createElement(
        ScrollView,
        { style: { flex: 1 } },
        [
            // Search Section
            React.createElement(
                FormSection,
                { key: "search", title: "🔍 User Search" },
                [
                    React.createElement(FormInput, {
                        key: "input",
                        title: "User ID",
                        placeholder: "Enter Discord User ID (e.g. 123456789012345678)",
                        value: userId,
                        onChangeText: setUserId,
                        keyboardType: "numeric"
                    }),
                    React.createElement(FormRow, {
                        key: "searchBtn",
                        label: isSearching ? "Searching..." : "🔍 Search User",
                        subLabel: "Find their messages and activity",
                        onPress: handleSearch,
                        disabled: isSearching
                    })
                ]
            ),

            // User Info Section (if found)
            userInfo && React.createElement(
                FormSection,
                { key: "userInfo", title: "👤 User Info" },
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

            // Mutual Servers Section
            mutualServers.length > 0 && React.createElement(
                FormSection,
                { key: "servers", title: `🏠 Mutual Servers (${mutualServers.length})` },
                mutualServers.slice(0, 10).map((guild: any, index: number) =>
                    React.createElement(FormRow, {
                        key: `server-${index}`,
                        label: guild.name,
                        subLabel: `ID: ${guild.id}`
                    })
                )
            ),

            // Messages Section
            results.length > 0 && React.createElement(
                FormSection,
                { key: "messages", title: `💬 Recent Messages (${results.length})` },
                results.map((msg: any, index: number) =>
                    React.createElement(
                        View,
                        { key: `msg-${index}`, style: { padding: 12, borderBottomWidth: 1, borderBottomColor: '#333' } },
                        [
                            React.createElement(Text, {
                                key: "header",
                                style: { color: '#7289da', fontSize: 12, marginBottom: 4 }
                            }, `#${msg.channel} • ${msg.guild}`),
                            React.createElement(Text, {
                                key: "content",
                                style: { color: '#dcddde', fontSize: 14 }
                            }, msg.content || "[No text content]")
                        ]
                    )
                )
            ),

            // No results message
            results.length === 0 && userId && !isSearching && React.createElement(
                FormSection,
                { key: "noResults", title: "ℹ️ Results" },
                [
                    React.createElement(FormRow, {
                        key: "noMsg",
                        label: "No messages found",
                        subLabel: "The user may not be in your servers or has no cached messages"
                    })
                ]
            ),

            // Help Section
            React.createElement(
                FormSection,
                { key: "help", title: "❓ How to Use" },
                [
                    React.createElement(FormRow, {
                        key: "h1",
                        label: "1. Get User ID",
                        subLabel: "Long-press on a user > Copy ID (Developer Mode must be on)"
                    }),
                    React.createElement(FormRow, {
                        key: "h2",
                        label: "2. Paste ID above",
                        subLabel: "Enter the 18-digit User ID"
                    }),
                    React.createElement(FormRow, {
                        key: "h3",
                        label: "3. Tap Search",
                        subLabel: "Find their messages in mutual servers"
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
    showToast("Stalker Pro loaded! Check plugin settings.", getAssetIDByName("Check"));
};

export const onUnload = () => {
    logger.log("Stalker Pro: Plugin unloaded");
};
