import { logger } from "@vendetta";
import { findByStoreName, findByProps } from "@vendetta/metro";
import { React, ReactNative, FluxDispatcher } from "@vendetta/metro/common";
import { Forms, General } from "@vendetta/ui/components";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { showToast } from "@vendetta/ui/toasts";

const { FormSection, FormRow, FormInput } = Forms;
const { ScrollView, View, Text, TouchableOpacity, ActivityIndicator } = General;

// Discord stores
const UserStore = findByStoreName("UserStore");
const GuildStore = findByStoreName("GuildStore");
const GuildMemberStore = findByStoreName("GuildMemberStore");
const ChannelStore = findByStoreName("ChannelStore");

// Clipboard - try multiple ways
const Clipboard = ReactNative?.Clipboard ||
    findByProps("setString", "getString") ||
    findByProps("getString");

// REST API
const RestAPI = findByProps("getAPIBaseURL", "get") || findByProps("API_HOST", "get");

// Navigation
const MessageActions = findByProps("jumpToMessage");
const URLOpener = findByProps("openURL") || ReactNative?.Linking;

// Storage
let targetUserId: string = "";
let clipboardMonitorActive = false;
let lastCheckedClipboard = "";
let checkIntervalId: any = null;

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

function openMessageLink(guildId: string, channelId: string, messageId: string) {
    try { FluxDispatcher?.dispatch({ type: "NAVIGATE_TO_JUMP_TO_MESSAGE", messageId, channelId, guildId }); return true; } catch { }
    try { MessageActions?.jumpToMessage({ channelId, messageId, flash: true }); return true; } catch { }
    try { URLOpener?.openURL?.(`discord://-/channels/${guildId}/${channelId}/${messageId}`); return true; } catch { }
    return false;
}

function isUserIdFormat(text: string): boolean {
    if (!text) return false;
    const trimmed = text.trim();
    return /^\d{17,19}$/.test(trimmed);
}

async function autoSearchUser(userId: string) {
    logger.log("Auto-searching user:", userId);

    const currentUser = UserStore?.getCurrentUser?.();
    if (currentUser && userId === currentUser.id) {
        logger.log("Skipping - this is current user");
        return;
    }

    const guilds = getMutualGuilds(userId);
    const userInfo = getUserInfo(userId);

    if (guilds.length === 0) {
        showToast("❌ No mutual servers with this user", getAssetIDByName("Small"));
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

    // Show location after delay
    setTimeout(() => {
        if (allMsgs.length > 0) {
            const latest = allMsgs[0];
            showToast(`📍 Latest in #${getChannelName(latest.channelId)}`, getAssetIDByName("ic_message"));
        }
    }, 1500);

    // Auto-open after another delay
    setTimeout(() => {
        if (allMsgs.length > 0) {
            const latest = allMsgs[0];
            showToast(`👆 Opening message...`, getAssetIDByName("Arrow"));
            openMessageLink(latest.guildId, latest.channelId, latest.id);
        }
    }, 3000);
}

async function checkClipboardContent() {
    try {
        if (!Clipboard?.getString) {
            logger.log("Clipboard.getString not available");
            return;
        }

        const content = await Clipboard.getString();

        if (content && content !== lastCheckedClipboard && isUserIdFormat(content)) {
            lastCheckedClipboard = content;
            const userId = content.trim();

            logger.log("Detected User ID in clipboard:", userId);
            showToast(`🎯 User ID detected!`, getAssetIDByName("Check"));

            // Start search after short delay
            setTimeout(() => autoSearchUser(userId), 1000);
        }
    } catch (e) {
        logger.error("Clipboard check failed:", e);
    }
}

// Settings Component
function StalkerSettings() {
    const [userId, setUserId] = React.useState(targetUserId);
    const [results, setResults] = React.useState<any[]>([]);
    const [userInfo, setUserInfo] = React.useState<any>(null);
    const [mutualServers, setMutualServers] = React.useState<any[]>([]);
    const [isSearching, setIsSearching] = React.useState(false);
    const [searchProgress, setSearchProgress] = React.useState("");

    const handleSearch = async () => {
        if (!userId || userId.length < 17) { showToast("Invalid User ID", getAssetIDByName("Small")); return; }
        setIsSearching(true); setResults([]); targetUserId = userId;

        const info = getUserInfo(userId); setUserInfo(info);
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

    // Manual clipboard check button
    const handleManualCheck = async () => {
        showToast("Checking clipboard...", getAssetIDByName("ic_search"));
        await checkClipboardContent();
    };

    return React.createElement(ScrollView, { style: { flex: 1, backgroundColor: '#1e1f22' } }, [
        // VERSION INFO - to verify plugin is updated
        React.createElement(FormSection, { key: "ver", title: "📱 STALKER PRO v2.0" }, [
            React.createElement(FormRow, {
                key: "v1",
                label: "✨ Copy ID Detection",
                subLabel: "Copy any User ID to auto-search!"
            }),
            React.createElement(FormRow, {
                key: "v2",
                label: "📋 Check Clipboard Now",
                subLabel: "Tap to manually check clipboard",
                trailing: FormRow.Arrow ? React.createElement(FormRow.Arrow, null) : null,
                onPress: handleManualCheck
            })
        ]),

        // Manual Search
        React.createElement(FormSection, { key: "search", title: "🔍 MANUAL SEARCH" }, [
            React.createElement(FormInput, { key: "in", title: "User ID", placeholder: "Paste Discord User ID here", value: userId, onChangeText: setUserId, keyboardType: "numeric" }),
            React.createElement(FormRow, { key: "btn", label: isSearching ? "⏳ Searching..." : "🔍 Search", subLabel: isSearching ? searchProgress : "Find their messages", onPress: isSearching ? undefined : handleSearch })
        ]),

        // User Info
        userInfo && React.createElement(FormSection, { key: "user", title: "👤 USER" }, [
            React.createElement(FormRow, { key: "n", label: userInfo.globalName || userInfo.username, subLabel: `@${userInfo.username}` })
        ]),

        // Servers
        mutualServers.length > 0 && React.createElement(FormSection, { key: "srv", title: `🏠 ${mutualServers.length} MUTUAL SERVERS` },
            mutualServers.slice(0, 10).map((g: any, i: number) => React.createElement(FormRow, { key: `s${i}`, label: g.name }))
        ),

        // Loading
        isSearching && React.createElement(View, { key: "load", style: { padding: 20, alignItems: 'center' } }, [
            React.createElement(ActivityIndicator, { key: "sp", size: "large", color: "#5865f2" }),
            React.createElement(Text, { key: "t", style: { color: '#b5bac1', marginTop: 10 } }, searchProgress)
        ]),

        // Messages
        !isSearching && results.length > 0 && React.createElement(FormSection, { key: "msgs", title: `💬 ${results.length} MESSAGES` },
            results.map((msg: any, i: number) => React.createElement(TouchableOpacity, {
                key: `m${i}`, style: { padding: 12, borderBottomWidth: 1, borderBottomColor: '#3f4147', backgroundColor: '#2b2d31' },
                onPress: () => { showToast("Opening...", getAssetIDByName("Check")); openMessageLink(msg.guildId, msg.channelId, msg.id); }
            }, [
                React.createElement(Text, { key: "c", style: { color: '#5865f2', fontSize: 12 } }, `#${getChannelName(msg.channelId)} • ${getGuildName(msg.guildId)}`),
                React.createElement(Text, { key: "m", style: { color: '#f2f3f5', fontSize: 14, marginVertical: 3 } }, msg.content.substring(0, 100)),
                React.createElement(Text, { key: "t", style: { color: '#949ba4', fontSize: 11 } }, formatTime(msg.timestamp))
            ]))
        ),

        // Status
        React.createElement(FormSection, { key: "status", title: "⚙️ STATUS" }, [
            React.createElement(FormRow, { key: "s1", label: "Clipboard API", subLabel: Clipboard?.getString ? "✅ Available" : "❌ Not Available" }),
            React.createElement(FormRow, { key: "s2", label: "Auto Monitor", subLabel: clipboardMonitorActive ? "✅ Running" : "❌ Stopped" }),
            React.createElement(FormRow, { key: "s3", label: "Last Clipboard", subLabel: lastCheckedClipboard || "Nothing checked yet" })
        ])
    ]);
}

export const settings = StalkerSettings;

export const onLoad = () => {
    logger.log("========================================");
    logger.log("=== STALKER PRO v2.0 LOADING ===");
    logger.log("========================================");

    logger.log("Clipboard API:", !!Clipboard);
    logger.log("Clipboard.getString:", !!Clipboard?.getString);
    logger.log("Clipboard.setString:", !!Clipboard?.setString);

    // Start clipboard monitoring
    if (Clipboard?.getString) {
        clipboardMonitorActive = true;
        checkIntervalId = setInterval(checkClipboardContent, 2000);
        logger.log("Clipboard monitoring STARTED (every 2s)");
        showToast("🔍 Stalker Pro v2.0 ready!", getAssetIDByName("Check"));
    } else {
        clipboardMonitorActive = false;
        logger.warn("Clipboard API not available - manual mode only");
        showToast("Stalker Pro ready (manual mode)", getAssetIDByName("Small"));
    }
};

export const onUnload = () => {
    logger.log("=== STALKER PRO UNLOADING ===");

    if (checkIntervalId) {
        clearInterval(checkIntervalId);
        checkIntervalId = null;
        clipboardMonitorActive = false;
        logger.log("Clipboard monitoring STOPPED");
    }
};
