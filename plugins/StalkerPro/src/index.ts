import { logger } from "@vendetta";
import { findByStoreName, findByProps } from "@vendetta/metro";
import { React, ReactNative, FluxDispatcher } from "@vendetta/metro/common";
import { Forms, General } from "@vendetta/ui/components";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { showToast } from "@vendetta/ui/toasts";

const { FormSection, FormRow, FormInput } = Forms;
const { ScrollView, View, Text, TouchableOpacity, ActivityIndicator, Clipboard } = General;

// Get Clipboard from ReactNative if not in General
const ClipboardAPI = Clipboard || ReactNative?.Clipboard || findByProps("getString", "setString");

// Discord stores
const UserStore = findByStoreName("UserStore");
const GuildStore = findByStoreName("GuildStore");
const GuildMemberStore = findByStoreName("GuildMemberStore");
const ChannelStore = findByStoreName("ChannelStore");

// REST API
const RestAPI = findByProps("getAPIBaseURL", "get") || findByProps("API_HOST", "get");

// Navigation
const Router = findByProps("transitionToGuild", "transitionTo") || findByProps("transitionTo");
const MessageActions = findByProps("jumpToMessage");
const URLOpener = findByProps("openURL") || ReactNative?.Linking;

// Storage for tracking
let lastClipboardContent = "";
let clipboardCheckInterval: any = null;
let detectedUserId: string | null = null;
let targetUserId: string = "";

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

// Check if string is a Discord User ID (17-19 digits)
function isUserIdFormat(text: string): boolean {
    const trimmed = text.trim();
    return /^\d{17,19}$/.test(trimmed);
}

// Start searching for a user
async function searchUser(userId: string) {
    const guilds = getMutualGuilds(userId);
    const userInfo = getUserInfo(userId);

    if (guilds.length === 0) {
        showToast("No mutual servers found", getAssetIDByName("Small"));
        return;
    }

    const displayName = userInfo?.globalName || userInfo?.username || userId;
    showToast(`🔍 Searching for ${displayName}...`, getAssetIDByName("ic_search"));

    let allMsgs: any[] = [];

    for (let i = 0; i < Math.min(guilds.length, 10); i++) {
        try {
            const msgs = await searchMessagesInGuild(guilds[i].id, userId);
            allMsgs.push(...msgs);
        } catch { }
        if (i < guilds.length - 1) await new Promise(r => setTimeout(r, 300));
    }

    allMsgs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    if (allMsgs.length === 0) {
        showToast(`No messages found in ${guilds.length} servers`, getAssetIDByName("Small"));
        return;
    }

    showToast(`✅ Found ${allMsgs.length} messages!`, getAssetIDByName("Check"));

    // Show latest message after a delay
    setTimeout(() => {
        const latest = allMsgs[0];
        const content = latest.content.length > 30 ? latest.content.substring(0, 30) + "..." : latest.content;
        const channel = getChannelName(latest.channelId);
        const guild = getGuildName(latest.guildId);
        showToast(`📍 #${channel} in ${guild}`, getAssetIDByName("ic_message"));

        // Store for potential navigation
        detectedUserId = userId;
    }, 1500);

    // Show another toast to open
    setTimeout(() => {
        if (allMsgs.length > 0) {
            const latest = allMsgs[0];
            showToast(`👆 Tap here to open latest message`, getAssetIDByName("Arrow"));

            // Auto-open after showing the toast
            setTimeout(() => {
                openMessageLink(latest.guildId, latest.channelId, latest.id);
            }, 2000);
        }
    }, 3500);
}

// Check clipboard for User ID
async function checkClipboard() {
    try {
        if (!ClipboardAPI?.getString) return;

        const content = await ClipboardAPI.getString();

        if (content && content !== lastClipboardContent) {
            lastClipboardContent = content;

            if (isUserIdFormat(content)) {
                const userId = content.trim();
                logger.log("User ID detected in clipboard:", userId);

                // Check if it's the current user
                const currentUser = UserStore?.getCurrentUser?.();
                if (currentUser && userId === currentUser.id) {
                    return; // Don't stalk yourself
                }

                // Get user info if available
                const userInfo = getUserInfo(userId);
                const guilds = getMutualGuilds(userId);

                if (userInfo) {
                    const name = userInfo.globalName || userInfo.username;
                    showToast(`🎯 ${name} copied! Tap to search...`, getAssetIDByName("ic_search"));
                } else if (guilds.length > 0) {
                    showToast(`🎯 User ID copied! Tap to search...`, getAssetIDByName("ic_search"));
                } else {
                    showToast(`🎯 User ID copied (no mutual servers)`, getAssetIDByName("Small"));
                    return;
                }

                // Store detected ID
                detectedUserId = userId;

                // Wait a moment then offer to search
                setTimeout(() => {
                    if (detectedUserId === userId) {
                        showToast(`🔎 Searching ${guilds.length} servers...`, getAssetIDByName("ic_search"));
                        searchUser(userId);
                    }
                }, 2000);
            }
        }
    } catch (e) {
        logger.error("Clipboard check error:", e);
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

    return React.createElement(ScrollView, { style: { flex: 1, backgroundColor: '#1e1f22' } }, [
        // Quick Access Info
        React.createElement(FormSection, { key: "quick", title: "⚡ QUICK ACCESS" }, [
            React.createElement(FormRow, {
                key: "info",
                label: "Copy any User ID",
                subLabel: "Plugin auto-detects and searches!"
            }),
            React.createElement(FormRow, {
                key: "how",
                label: "How to use",
                subLabel: "Long-press user → Copy ID → Wait for search"
            })
        ]),

        // Manual Search
        React.createElement(FormSection, { key: "search", title: "🔍 MANUAL SEARCH" }, [
            React.createElement(FormInput, { key: "in", title: "User ID", placeholder: "Enter Discord User ID", value: userId, onChangeText: setUserId, keyboardType: "numeric" }),
            React.createElement(FormRow, { key: "btn", label: isSearching ? "⏳ Searching..." : "🔍 Search All Servers", subLabel: isSearching ? searchProgress : "Find messages", onPress: isSearching ? undefined : handleSearch })
        ]),

        // User Info
        userInfo && React.createElement(FormSection, { key: "user", title: "👤 USER" }, [
            React.createElement(FormRow, { key: "n", label: userInfo.globalName || userInfo.username, subLabel: `@${userInfo.username} • ${userInfo.id}` })
        ]),

        // Servers
        mutualServers.length > 0 && React.createElement(FormSection, { key: "srv", title: `🏠 SERVERS (${mutualServers.length})` },
            mutualServers.slice(0, 15).map((g: any, i: number) => React.createElement(FormRow, { key: `s${i}`, label: g.name }))
        ),

        // Loading
        isSearching && React.createElement(View, { key: "load", style: { padding: 20, alignItems: 'center' } }, [
            React.createElement(ActivityIndicator, { key: "sp", size: "large", color: "#5865f2" }),
            React.createElement(Text, { key: "t", style: { color: '#b5bac1', marginTop: 10 } }, searchProgress)
        ]),

        // Messages
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

        // Debug
        React.createElement(FormSection, { key: "dbg", title: "🔧 STATUS" }, [
            React.createElement(FormRow, { key: "d1", label: "Clipboard Monitor", subLabel: clipboardCheckInterval ? "✅ Active" : "❌ Inactive" }),
            React.createElement(FormRow, { key: "d2", label: "Last Detected ID", subLabel: detectedUserId || "None" })
        ])
    ]);
}

export const settings = StalkerSettings;

export const onLoad = () => {
    logger.log("=== Stalker Pro Loading ===");
    logger.log("ClipboardAPI available:", !!ClipboardAPI?.getString);

    // Start clipboard monitoring
    if (ClipboardAPI?.getString) {
        // Check clipboard every 1.5 seconds
        clipboardCheckInterval = setInterval(checkClipboard, 1500);
        logger.log("Clipboard monitoring started");
        showToast("🔍 Stalker Pro ready! Copy a User ID to search", getAssetIDByName("Check"));
    } else {
        logger.warn("Clipboard API not available");
        showToast("Stalker Pro ready (manual mode)", getAssetIDByName("Check"));
    }
};

export const onUnload = () => {
    logger.log("Stalker Pro unloading...");

    // Stop clipboard monitoring
    if (clipboardCheckInterval) {
        clearInterval(clipboardCheckInterval);
        clipboardCheckInterval = null;
        logger.log("Clipboard monitoring stopped");
    }
};
