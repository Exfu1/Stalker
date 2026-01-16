import { logger } from "@vendetta";
import { findByStoreName, findByProps } from "@vendetta/metro";
import { React, ReactNative, FluxDispatcher } from "@vendetta/metro/common";
import { Forms, General } from "@vendetta/ui/components";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { showToast } from "@vendetta/ui/toasts";
import { after } from "@vendetta/patcher";

const { FormSection, FormRow, FormInput, FormDivider } = Forms;
const { ScrollView, View, Text, TouchableOpacity, ActivityIndicator, Linking } = General;

const URLOpener = Linking || ReactNative?.Linking;

// Discord stores
const UserStore = findByStoreName("UserStore");
const GuildStore = findByStoreName("GuildStore");
const GuildMemberStore = findByStoreName("GuildMemberStore");
const ChannelStore = findByStoreName("ChannelStore");
const RelationshipStore = findByStoreName("RelationshipStore");

// REST API
const RestAPI = findByProps("getAPIBaseURL", "get") || findByProps("API_HOST", "get");

// Navigation
const Router = findByProps("transitionToGuild", "transitionTo") || findByProps("transitionTo");
const MessageActions = findByProps("jumpToMessage");

// Store patches - use array for multiple patches
let patches: Function[] = [];
let targetUserId: string = "";
let profileInjectionStatus = "Not attempted";

const RelationshipTypes = { NONE: 0, FRIEND: 1, BLOCKED: 2, PENDING_INCOMING: 3, PENDING_OUTGOING: 4 };

function getRelationship(userId: string) {
    if (!RelationshipStore) return null;
    try {
        const type = RelationshipStore.getRelationshipType?.(userId) ?? 0;
        return {
            type,
            isFriend: type === 1,
            emoji: type === 1 ? "✅" : type === 2 ? "🚫" : type === 3 ? "📨" : type === 4 ? "📤" : "❌",
            label: type === 1 ? "Friend" : type === 2 ? "Blocked" : type === 3 ? "Pending In" : type === 4 ? "Pending Out" : "Not Friends"
        };
    } catch { return null; }
}

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

async function quickSearchMessages(userId: string) {
    const guilds = getMutualGuilds(userId);
    if (guilds.length === 0) { showToast("No mutual servers", getAssetIDByName("Small")); return; }

    showToast(`Searching ${guilds.length} servers...`, getAssetIDByName("ic_search"));
    let allMsgs: any[] = [];

    for (let i = 0; i < Math.min(guilds.length, 8); i++) {
        const msgs = await searchMessagesInGuild(guilds[i].id, userId);
        allMsgs.push(...msgs);
        if (i < guilds.length - 1) await new Promise(r => setTimeout(r, 250));
    }

    allMsgs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    showToast(`Found ${allMsgs.length} messages!`, getAssetIDByName("Check"));

    if (allMsgs.length > 0) {
        const latest = allMsgs[0].content.substring(0, 35);
        setTimeout(() => showToast(`Latest: "${latest}..."`, getAssetIDByName("ic_message")), 1200);
    }
}

function getChannelName(id: string) { return ChannelStore?.getChannel(id)?.name || "unknown"; }
function getGuildName(id: string) { return GuildStore?.getGuild(id)?.name || "Unknown"; }
function getUserInfo(id: string) {
    const u = UserStore?.getUser(id);
    return u ? { username: u.username, globalName: u.globalName, id: u.id } : null;
}

function openMessageLink(guildId: string, channelId: string, messageId: string) {
    try {
        FluxDispatcher?.dispatch({ type: "NAVIGATE_TO_JUMP_TO_MESSAGE", messageId, channelId, guildId });
        return true;
    } catch { }
    try {
        MessageActions?.jumpToMessage({ channelId, messageId, flash: true });
        return true;
    } catch { }
    try {
        URLOpener?.openURL(`discord://-/channels/${guildId}/${channelId}/${messageId}`);
        return true;
    } catch { }
    return false;
}

// Settings Component
function StalkerSettings() {
    const [userId, setUserId] = React.useState(targetUserId);
    const [results, setResults] = React.useState<any[]>([]);
    const [userInfo, setUserInfo] = React.useState<any>(null);
    const [relationship, setRelationship] = React.useState<any>(null);
    const [mutualServers, setMutualServers] = React.useState<any[]>([]);
    const [isSearching, setIsSearching] = React.useState(false);
    const [searchProgress, setSearchProgress] = React.useState("");

    const handleSearch = async () => {
        if (!userId || userId.length < 17) { showToast("Invalid User ID", getAssetIDByName("Small")); return; }
        setIsSearching(true); setResults([]); targetUserId = userId;

        const info = getUserInfo(userId); setUserInfo(info);
        const rel = getRelationship(userId); setRelationship(rel);
        const guilds = getMutualGuilds(userId); setMutualServers(guilds);

        if (guilds.length === 0) { showToast("No mutual servers", getAssetIDByName("Small")); setIsSearching(false); return; }

        const allMsgs: any[] = [];
        for (let i = 0; i < Math.min(guilds.length, 12); i++) {
            setSearchProgress(`${guilds[i].name} (${i + 1}/${Math.min(guilds.length, 12)})`);
            const msgs = await searchMessagesInGuild(guilds[i].id, userId);
            allMsgs.push(...msgs);
            await new Promise(r => setTimeout(r, 350));
        }
        allMsgs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        setResults(allMsgs.slice(0, 50));
        showToast(`Found ${allMsgs.length} messages`, getAssetIDByName("Check"));
        setIsSearching(false); setSearchProgress("");
    };

    const formatTime = (ts: string) => {
        try { const d = new Date(ts); return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`; }
        catch { return ts; }
    };

    return React.createElement(ScrollView, { style: { flex: 1, backgroundColor: '#1e1f22' } }, [
        React.createElement(FormSection, { key: "search", title: "🔍 USER SEARCH" }, [
            React.createElement(FormInput, { key: "in", title: "User ID", placeholder: "Enter Discord User ID", value: userId, onChangeText: setUserId, keyboardType: "numeric" }),
            React.createElement(FormRow, { key: "btn", label: isSearching ? "⏳ Searching..." : "🔍 Search All Servers", subLabel: isSearching ? searchProgress : "Find messages", onPress: isSearching ? undefined : handleSearch })
        ]),
        userInfo && React.createElement(FormSection, { key: "user", title: "👤 USER" }, [
            React.createElement(FormRow, { key: "n", label: userInfo.globalName || userInfo.username, subLabel: `@${userInfo.username} • ${userInfo.id}` }),
            relationship && React.createElement(FormRow, { key: "r", label: `${relationship.emoji} ${relationship.label}`, subLabel: relationship.isFriend ? "You are friends" : "Not friends" })
        ]),
        mutualServers.length > 0 && React.createElement(FormSection, { key: "srv", title: `🏠 SERVERS (${mutualServers.length})` },
            mutualServers.slice(0, 15).map((g: any, i: number) => React.createElement(FormRow, { key: `s${i}`, label: g.name }))
        ),
        isSearching && React.createElement(View, { key: "load", style: { padding: 20, alignItems: 'center' } }, [
            React.createElement(ActivityIndicator, { key: "sp", size: "large", color: "#5865f2" }),
            React.createElement(Text, { key: "t", style: { color: '#b5bac1', marginTop: 10 } }, searchProgress)
        ]),
        !isSearching && results.length > 0 && React.createElement(FormSection, { key: "msgs", title: `💬 MESSAGES (${results.length})` },
            results.map((msg: any, i: number) => React.createElement(TouchableOpacity, {
                key: `m${i}`, style: { padding: 12, borderBottomWidth: 1, borderBottomColor: '#3f4147', backgroundColor: '#2b2d31' },
                onPress: () => { showToast("Opening...", getAssetIDByName("Check")); openMessageLink(msg.guildId, msg.channelId, msg.id); }
            }, [
                React.createElement(Text, { key: "c", style: { color: '#5865f2', fontSize: 12 } }, `#${getChannelName(msg.channelId)} • ${getGuildName(msg.guildId)}`),
                React.createElement(Text, { key: "m", style: { color: '#f2f3f5', fontSize: 14, marginVertical: 3 } }, msg.content.substring(0, 120)),
                React.createElement(Text, { key: "t", style: { color: '#949ba4', fontSize: 11 } }, formatTime(msg.timestamp) + " • Tap to open")
            ]))
        ),
        React.createElement(FormSection, { key: "dbg", title: "🔧 DEBUG" }, [
            React.createElement(FormRow, { key: "d1", label: "RelationshipStore", subLabel: RelationshipStore ? "✅" : "❌" }),
            React.createElement(FormRow, { key: "d2", label: "Profile Injection", subLabel: profileInjectionStatus })
        ]),
        !isSearching && results.length === 0 && React.createElement(FormSection, { key: "help", title: "ℹ️ HELP" }, [
            React.createElement(FormRow, { key: "h1", label: "1. Copy User ID", subLabel: "Long-press user → Copy ID" }),
            React.createElement(FormRow, { key: "h2", label: "2. Paste & Search", subLabel: "Enter ID above and tap Search" })
        ])
    ]);
}

export const settings = StalkerSettings;

export const onLoad = () => {
    logger.log("=== Stalker Pro Loading ===");

    // EXACT approach from StalkerClean - find UserProfileSection by props
    const UserProfileSection = findByProps("UserProfileSection");
    logger.log("UserProfileSection module:", !!UserProfileSection);
    logger.log("Has .default:", !!UserProfileSection?.default);

    if (UserProfileSection && UserProfileSection.default) {
        try {
            const unpatch = after("default", UserProfileSection, (args: any[], res: any) => {
                try {
                    const userId = args[0]?.userId;
                    if (!userId) return res;

                    const currentUser = UserStore?.getCurrentUser?.();
                    if (currentUser && userId === currentUser.id) return res;

                    // Check if children array exists
                    if (!res?.props?.children || !Array.isArray(res.props.children)) {
                        logger.log("Profile: children not array, type:", typeof res?.props?.children);
                        return res;
                    }

                    const rel = getRelationship(userId);
                    const mutualGuilds = getMutualGuilds(userId);

                    const section = React.createElement(FormSection, { key: "stalker-pro", title: "🔍 Stalker Pro" }, [
                        rel && React.createElement(FormRow, { key: "rel", label: `${rel.emoji} ${rel.label}`, subLabel: rel.isFriend ? "You are friends" : "Not friends" }),
                        React.createElement(FormDivider, { key: "d1" }),
                        React.createElement(FormRow, {
                            key: "search", label: "🔎 Find Messages", subLabel: `${mutualGuilds.length} mutual servers`,
                            trailing: FormRow.Arrow ? React.createElement(FormRow.Arrow, null) : null,
                            onPress: () => quickSearchMessages(userId)
                        }),
                        React.createElement(FormDivider, { key: "d2" }),
                        React.createElement(FormRow, {
                            key: "srv", label: `🏠 ${mutualGuilds.length} Mutual Servers`,
                            subLabel: mutualGuilds.slice(0, 2).map((g: any) => g.name).join(", ") + (mutualGuilds.length > 2 ? "..." : "")
                        })
                    ]);

                    res.props.children.push(section);
                    logger.log("Profile section injected for user:", userId);
                } catch (e) {
                    logger.error("Injection error:", e);
                }
                return res;
            });

            patches.push(unpatch);
            profileInjectionStatus = "✅ Method 1: UserProfileSection.default";
            logger.log("Patch applied: UserProfileSection.default");
        } catch (e) {
            logger.error("Failed to patch UserProfileSection.default:", e);
            profileInjectionStatus = "❌ Patch failed (Method 1)";
        }
    } else {
        // Fallback: Try other module names
        const alternatives = [
            findByProps("default", "UserProfileSection"),
            findByProps("UserProfile"),
            findByProps("ProfileBody"),
            findByProps("UserProfileBody")
        ];

        let found = false;
        for (const mod of alternatives) {
            if (mod?.default) {
                try {
                    const unpatch = after("default", mod, (args: any[], res: any) => {
                        try {
                            const userId = args[0]?.userId || args[0]?.user?.id;
                            if (!userId) return res;

                            const currentUser = UserStore?.getCurrentUser?.();
                            if (currentUser && userId === currentUser.id) return res;

                            if (!res?.props?.children) return res;
                            if (!Array.isArray(res.props.children)) res.props.children = [res.props.children];

                            const rel = getRelationship(userId);
                            const mutualGuilds = getMutualGuilds(userId);

                            res.props.children.push(
                                React.createElement(FormSection, { key: "stalker-pro", title: "🔍 Stalker Pro" }, [
                                    rel && React.createElement(FormRow, { key: "rel", label: `${rel.emoji} ${rel.label}` }),
                                    React.createElement(FormRow, {
                                        key: "search", label: "🔎 Find Messages",
                                        onPress: () => quickSearchMessages(userId)
                                    })
                                ])
                            );
                        } catch (e) { logger.error("Alt injection error:", e); }
                        return res;
                    });
                    patches.push(unpatch);
                    found = true;
                    profileInjectionStatus = "✅ Alt method";
                    break;
                } catch (e) { }
            }
        }

        if (!found) {
            profileInjectionStatus = "❌ No module found";
            logger.warn("Could not find any profile module to patch");
        }
    }

    showToast("Stalker Pro ready!", getAssetIDByName("Check"));
};

export const onUnload = () => {
    logger.log("Stalker Pro unloading...");
    patches.forEach(p => { try { p(); } catch { } });
    patches = [];
};
