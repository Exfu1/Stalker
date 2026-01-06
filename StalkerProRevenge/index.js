(() => {
    "use strict";

    // Vendetta module shims
    const metro = vendetta.metro;
    const { findByStoreName, findByProps } = metro;
    const { React } = metro.common;
    const { after } = vendetta.patcher;
    const { showToast } = vendetta.ui.toasts;
    const { getAssetIDByName } = vendetta.ui.assets;
    const { Forms, General } = vendetta.ui.components;

    const { FormSection, FormRow, FormDivider } = Forms;
    const { ScrollView, View, Text } = General;

    // Discord stores
    const UserStore = findByStoreName("UserStore");
    const GuildStore = findByStoreName("GuildStore");
    const ChannelStore = findByStoreName("ChannelStore");
    const MessageStore = findByStoreName("MessageStore");
    const GuildMemberStore = findByStoreName("GuildMemberStore");

    let unpatch = null;

    // Get mutual guilds with a user
    function getMutualGuilds(userId) {
        const guilds = GuildStore ? Object.values(GuildStore.getGuilds() || {}) : [];
        const mutual = [];
        for (let i = 0; i < guilds.length; i++) {
            const member = GuildMemberStore ? GuildMemberStore.getMember(guilds[i].id, userId) : null;
            if (member) mutual.push(guilds[i]);
        }
        return mutual;
    }

    // Find recent messages from user
    function findRecentMessages(userId, mutualGuilds) {
        const results = [];
        for (let i = 0; i < mutualGuilds.length; i++) {
            const guild = mutualGuilds[i];
            try {
                const channels = ChannelStore ? Object.values(ChannelStore.getChannels() || {}) : [];
                const textChannels = channels.filter(c => c.guild_id === guild.id && c.type === 0);
                for (let j = 0; j < textChannels.length; j++) {
                    const channel = textChannels[j];
                    const messages = MessageStore ? MessageStore.getMessages(channel.id) : null;
                    if (messages && messages._array) {
                        const userMsgs = messages._array.filter(m => m.author && m.author.id === userId);
                        for (let k = 0; k < Math.min(userMsgs.length, 3); k++) {
                            results.push({
                                id: userMsgs[k].id,
                                content: (userMsgs[k].content || "").substring(0, 50),
                                channel: channel.name,
                                guild: guild.name
                            });
                        }
                    }
                }
            } catch (e) { /* skip */ }
        }
        return results.slice(0, 10);
    }

    // Plugin export
    const plugin = {
        onLoad: function () {
            try {
                const UserProfile = findByProps("UserProfileSection");
                if (UserProfile && UserProfile.default) {
                    unpatch = after("default", UserProfile, (args, res) => {
                        const userId = args[0] ? args[0].userId : null;
                        if (!userId) return res;

                        const currentUser = UserStore ? UserStore.getCurrentUser() : null;
                        if (currentUser && userId === currentUser.id) return res;

                        if (res && res.props && res.props.children && Array.isArray(res.props.children)) {
                            const mutualGuilds = getMutualGuilds(userId);

                            const stalkerSection = React.createElement(FormSection, {
                                key: "stalker-pro",
                                title: "🔍 Stalker Pro"
                            }, [
                                React.createElement(FormRow, {
                                    key: "recent",
                                    label: "Recent Messages",
                                    subLabel: "Find their messages across servers",
                                    trailing: React.createElement(FormRow.Arrow, null),
                                    onPress: function () {
                                        const msgs = findRecentMessages(userId, mutualGuilds);
                                        showToast("Found " + msgs.length + " messages", getAssetIDByName("Check"));
                                    }
                                }),
                                React.createElement(FormDivider, { key: "div" }),
                                React.createElement(FormRow, {
                                    key: "hidden",
                                    label: "Hidden Channels",
                                    subLabel: "Channels they can see but you can't",
                                    trailing: React.createElement(FormRow.Arrow, null),
                                    onPress: function () {
                                        showToast("Checking " + mutualGuilds.length + " servers", getAssetIDByName("Check"));
                                    }
                                })
                            ]);

                            res.props.children.push(stalkerSection);
                        }
                        return res;
                    });
                }
                showToast("Stalker Pro loaded!", getAssetIDByName("Check"));
            } catch (e) {
                console.error("Stalker Pro:", e);
            }
        },
        onUnload: function () {
            if (unpatch) unpatch();
        }
    };

    // Export for Vendetta
    return { default: plugin, __esModule: true };
})();
