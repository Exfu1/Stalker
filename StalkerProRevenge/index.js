(function (exports, metro, common, ui, assets, toasts, storage, plugin, components, patcher) {
    "use strict";

    // Find modules
    const { findByStoreName, findByProps } = metro;
    const { React, ReactNative } = common;
    const { View, Text, Pressable, ScrollView } = components.General || findByProps("View", "Text");
    const { FormSection, FormRow, FormDivider } = components.Forms || findByProps("FormSection", "FormRow");
    const { getAssetIDByName } = assets;
    const { showToast } = toasts;

    // Discord stores
    const UserStore = findByStoreName("UserStore");
    const GuildStore = findByStoreName("GuildStore");
    const ChannelStore = findByStoreName("ChannelStore");
    const MessageStore = findByStoreName("MessageStore");
    const GuildMemberStore = findByStoreName("GuildMemberStore");

    // Track patches
    const patches = [];

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
                const channels = ChannelStore ? Object.values(ChannelStore.getChannels?.() || ChannelStore.getMutableGuildChannels?.() || {}) : [];
                const textChannels = channels.filter(function (c) { return c.guild_id === guild.id && c.type === 0; });
                for (let j = 0; j < textChannels.length; j++) {
                    const channel = textChannels[j];
                    const messages = MessageStore ? MessageStore.getMessages(channel.id) : null;
                    if (messages && messages._array) {
                        const userMsgs = messages._array.filter(function (m) { return m.author && m.author.id === userId; });
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

    // Plugin definition
    var pluginExport = {
        onLoad: function () {
            try {
                const UserProfile = findByProps("UserProfileSection");
                if (UserProfile && UserProfile.default) {
                    patches.push(patcher.after("default", UserProfile, function (args, res) {
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
                                    trailing: FormRow.Arrow ? React.createElement(FormRow.Arrow, null) : null,
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
                                    trailing: FormRow.Arrow ? React.createElement(FormRow.Arrow, null) : null,
                                    onPress: function () {
                                        showToast("Checking " + mutualGuilds.length + " servers", getAssetIDByName("Check"));
                                    }
                                })
                            ]);

                            res.props.children.push(stalkerSection);
                        }
                        return res;
                    }));
                }
                showToast("Stalker Pro loaded!", getAssetIDByName("Check"));
            } catch (e) {
                console.error("Stalker Pro:", e);
            }
        },
        onUnload: function () {
            for (const unpatch of patches) {
                if (unpatch) unpatch();
            }
        }
    };

    exports.default = pluginExport;
    Object.defineProperty(exports, "__esModule", { value: true });
    return exports;
})({}, vendetta.metro, vendetta.metro.common, vendetta.ui, vendetta.ui.assets, vendetta.ui.toasts, vendetta.storage, vendetta.plugin, vendetta.ui.components, vendetta.patcher);
