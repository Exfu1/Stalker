import { logger } from "@vendetta";
import { findByStoreName, findByProps } from "@vendetta/metro";
import { after } from "@vendetta/patcher";
import { React } from "@vendetta/metro/common";
import { Forms } from "@vendetta/ui/components";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { showToast } from "@vendetta/ui/toasts";

const { FormSection, FormRow, FormDivider } = Forms;

// Discord stores
const UserStore = findByStoreName("UserStore");
const GuildStore = findByStoreName("GuildStore");
const ChannelStore = findByStoreName("ChannelStore");
const MessageStore = findByStoreName("MessageStore");
const GuildMemberStore = findByStoreName("GuildMemberStore");

// Active patches to cleanup on unload
let patches: (() => void)[] = [];

/**
 * Get all guilds (servers) where both you and the target user are members
 */
function getMutualGuilds(userId: string) {
    const guilds = GuildStore ? Object.values(GuildStore.getGuilds() || {}) : [];
    const mutual: any[] = [];

    for (const guild of guilds) {
        const member = GuildMemberStore?.getMember((guild as any).id, userId);
        if (member) {
            mutual.push(guild);
        }
    }

    return mutual;
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
                            content: (userMsgs[k].content || "").substring(0, 50),
                            channel: (channel as any).name,
                            guild: guild.name
                        });
                    }
                }
            }
        } catch (e) {
            // Silently continue on errors
        }
    }

    return results.slice(0, 10);
}

export default {
    onLoad: () => {
        try {
            const UserProfile = findByProps("UserProfileSection");

            if (UserProfile?.default) {
                patches.push(
                    after("default", UserProfile, (args: any[], res: any) => {
                        const userId = args[0]?.userId;
                        if (!userId) return res;

                        // Don't show for yourself
                        const currentUser = UserStore?.getCurrentUser();
                        if (currentUser && userId === currentUser.id) return res;

                        // Check if we can inject into the result
                        if (res?.props?.children && Array.isArray(res.props.children)) {
                            const mutualGuilds = getMutualGuilds(userId);

                            const stalkerSection = React.createElement(
                                FormSection,
                                { key: "stalker-pro", title: "🔍 Stalker Pro" },
                                [
                                    React.createElement(FormRow, {
                                        key: "recent",
                                        label: "Recent Messages",
                                        subLabel: "Find their messages across servers",
                                        trailing: FormRow.Arrow
                                            ? React.createElement(FormRow.Arrow, null)
                                            : null,
                                        onPress: () => {
                                            const msgs = findRecentMessages(userId, mutualGuilds);
                                            showToast(
                                                `Found ${msgs.length} messages`,
                                                getAssetIDByName("Check")
                                            );
                                        }
                                    }),
                                    React.createElement(FormDivider, { key: "div" }),
                                    React.createElement(FormRow, {
                                        key: "hidden",
                                        label: "Hidden Channels",
                                        subLabel: "Channels they can see but you can't",
                                        trailing: FormRow.Arrow
                                            ? React.createElement(FormRow.Arrow, null)
                                            : null,
                                        onPress: () => {
                                            showToast(
                                                `Checking ${mutualGuilds.length} servers`,
                                                getAssetIDByName("Check")
                                            );
                                        }
                                    })
                                ]
                            );

                            res.props.children.push(stalkerSection);
                        }

                        return res;
                    })
                );
            }

            showToast("Stalker Pro loaded!", getAssetIDByName("Check"));
            logger.log("Stalker Pro plugin loaded successfully");
        } catch (e) {
            logger.error("Stalker Pro load error:", e);
        }
    },

    onUnload: () => {
        // Cleanup all patches
        for (const unpatch of patches) {
            unpatch?.();
        }
        patches = [];
        logger.log("Stalker Pro plugin unloaded");
    }
};
