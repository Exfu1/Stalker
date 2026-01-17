import { logger } from "@vendetta";
import { findByStoreName, findByProps, findByName } from "@vendetta/metro";
import { React, ReactNative, constants, FluxDispatcher } from "@vendetta/metro/common";
import { Forms, General } from "@vendetta/ui/components";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { showToast } from "@vendetta/ui/toasts";
import { after, before } from "@vendetta/patcher";

const { FormSection, FormRow, FormInput, FormSwitchRow } = Forms;
const { ScrollView, View, Text, TouchableOpacity, TextInput } = General;

// Modal from React Native
const Modal = ReactNative?.Modal || findByName("Modal", false) || findByProps("Modal")?.Modal;

// BackHandler for navigation
const BackHandler = ReactNative?.BackHandler || findByProps("addEventListener", "removeEventListener", "exitApp");

// Global state for popup dashboard
let showDashboardPopup = false;
let setShowDashboardPopup: ((v: boolean) => void) | null = null;

// Discord stores
const UserStore = findByStoreName("UserStore");
const GuildStore = findByStoreName("GuildStore");
const GuildMemberStore = findByStoreName("GuildMemberStore");
const ChannelStore = findByStoreName("ChannelStore");
const SelectedGuildStore = findByStoreName("SelectedGuildStore");
const GuildChannelStore = findByStoreName("GuildChannelStore");
const GuildRoleStore = findByStoreName("GuildRoleStore");

// Permissions module
const Permissions = findByProps("getChannelPermissions", "can");
const { getChannel } = findByProps("getChannel") || {};
const ChannelTypes = findByProps("ChannelTypes")?.ChannelTypes || {};

// Clipboard & REST API
const Clipboard = ReactNative?.Clipboard || findByProps("setString", "getString");
const RestAPI = findByProps("getAPIBaseURL", "get") || findByProps("API_HOST", "get");

// ========================================
// DEBUG LOG SYSTEM
// ========================================
let debugLogs: string[] = [];
const MAX_DEBUG_LOGS = 50;

function debugLog(category: string, message: string) {
    const timestamp = new Date().toLocaleTimeString();
    const entry = `[${timestamp}] [${category}] ${message}`;
    debugLogs.unshift(entry); // Add to front
    if (debugLogs.length > MAX_DEBUG_LOGS) debugLogs.pop();
    logger.log(entry);
}

function getDebugLogs(): string[] {
    return debugLogs;
}

function clearDebugLogs() {
    debugLogs = [];
}

// ========================================
// MODULES FOR QUICK ACCESS
// ========================================

// Try to find various modules for patching
debugLog("INIT", "Starting module discovery...");

// User Profile modules - try multiple approaches
const UserProfileHeader = findByName("UserProfileHeader", false);
const UserProfileActions = findByProps("UserProfileActions")?.UserProfileActions;
const UserProfileSection = findByName("UserProfileSection", false);
const ProfileBanner = findByName("ProfileBanner", false);

// Channel context menu modules - try different names
const ChannelLongPress = findByName("ChannelLongPressActionSheet", false);
const ChannelLongPress2 = findByName("ChannelLongPress", false);
const ChannelContextMenu = findByName("ChannelContextMenu", false);
const ContextMenu = findByProps("openContextMenu", "closeContextMenu");

// Try to find by props as well
const ChannelActionSheet = findByProps("ChannelLongPressActionSheet");
const LazyActionSheet = findByProps("openLazy", "hideActionSheet");

// Action sheet base module
const ActionSheet = findByProps("openLazy", "hideActionSheet");

// Navigation
const NavigationNative = findByProps("NavigationContainer")?.default;
const NavigationStack = findByProps("createStackNavigator");
const useNavigation = findByProps("useNavigation")?.useNavigation;

// Commands module
const Commands = findByProps("registerCommand", "unregisterCommand");

// ========================================
// ACTIONSHEETROW DISCOVERY (Enhanced)
// ========================================
// Native-backed ActionSheet components use RectButton from react-native-gesture-handler
// These work correctly in the gesture arena unlike standard TouchableOpacity

// Method 1: Try findByProps with various combinations
const ActionSheetComponents =
    findByProps("ActionSheetRow", "ActionSheetHeader") ||
    findByProps("ActionSheetRow") ||
    findByProps("ActionSheetItem") ||
    {};

// Method 2: Try findByName with variations
const ActionSheetRow =
    ActionSheetComponents.ActionSheetRow ||
    ActionSheetComponents.ActionSheetItem ||
    findByName("ActionSheetRow", false) ||
    findByName("ActionSheetItem", false) ||
    findByName("ActionSheetButton", false) ||
    findByName("BottomSheetRow", false) ||
    findByName("SheetRow", false);

const ActionSheetHeader =
    ActionSheetComponents.ActionSheetHeader ||
    findByName("ActionSheetTitleHeader", false) ||
    findByName("ActionSheetHeader", false);

// Method 3: Try to find via the ActionSheet module itself
let ActionSheetRowFromModule: any = null;
if (ActionSheet) {
    try {
        const asKeys = Object.keys(ActionSheet);
        debugLog("DISCOVER", `ActionSheet has keys: ${asKeys.join(', ')}`);
        // Look for Row or Item in ActionSheet
        for (const key of asKeys) {
            if (key.includes('Row') || key.includes('Item') || key.includes('Button')) {
                ActionSheetRowFromModule = ActionSheet[key];
                debugLog("DISCOVER", `Found ActionSheet.${key}: ${typeof ActionSheetRowFromModule}`);
            }
        }
    } catch (e) { debugLog("ERROR", `ActionSheet exploration failed: ${e}`); }
}

// Final ActionSheetRow selection
const FinalActionSheetRow = ActionSheetRow || ActionSheetRowFromModule;

// Log ActionSheetRow structure to understand its props
if (FinalActionSheetRow) {
    try {
        const rowKeys = Object.keys(FinalActionSheetRow);
        debugLog("DISCOVER", `FinalActionSheetRow keys: ${rowKeys.join(', ') || 'none'}`);
        debugLog("DISCOVER", `FinalActionSheetRow type: ${typeof FinalActionSheetRow}`);
        if (FinalActionSheetRow.displayName) {
            debugLog("DISCOVER", `FinalActionSheetRow.displayName: ${FinalActionSheetRow.displayName}`);
        }
        if (FinalActionSheetRow.propTypes) {
            const propTypeKeys = Object.keys(FinalActionSheetRow.propTypes);
            debugLog("DISCOVER", `FinalActionSheetRow.propTypes: ${propTypeKeys.join(', ')}`);
        }
        if (FinalActionSheetRow.defaultProps) {
            const defaultPropKeys = Object.keys(FinalActionSheetRow.defaultProps);
            debugLog("DISCOVER", `FinalActionSheetRow.defaultProps: ${defaultPropKeys.join(', ')}`);
        }
        // Try to see if it's a function component
        if (typeof FinalActionSheetRow === 'function') {
            debugLog("DISCOVER", `FinalActionSheetRow.length (params): ${FinalActionSheetRow.length}`);
        }
    } catch (e) {
        debugLog("ERROR", `ActionSheetRow exploration failed: ${e}`);
    }
}

// Log what we found - with more detail
debugLog("INIT", `UserProfileHeader: ${!!UserProfileHeader}`);
debugLog("INIT", `UserProfileSection: ${!!UserProfileSection}`);
debugLog("INIT", `ProfileBanner: ${!!ProfileBanner}`);
debugLog("INIT", `ChannelLongPress: ${!!ChannelLongPress}`);
debugLog("INIT", `ChannelLongPress2: ${!!ChannelLongPress2}`);
debugLog("INIT", `ChannelActionSheet: ${!!ChannelActionSheet}`);
debugLog("INIT", `ActionSheet: ${!!ActionSheet}`);
debugLog("INIT", `ActionSheetRow: ${!!ActionSheetRow}`);
debugLog("INIT", `ActionSheetHeader: ${!!ActionSheetHeader}`);
debugLog("INIT", `Commands: ${!!Commands}`);
debugLog("INIT", `NavigationNative: ${!!NavigationNative}`);

// Log module keys to find correct patch targets
if (ChannelLongPress) {
    try {
        const keys = Object.keys(ChannelLongPress);
        debugLog("KEYS", `ChannelLongPress keys: ${keys.join(', ') || 'none'}`);
        if (typeof ChannelLongPress === 'function') {
            debugLog("KEYS", "ChannelLongPress is a function");
        }
    } catch (e) { debugLog("ERROR", `Keys read failed: ${e}`); }
}

if (UserProfileSection) {
    try {
        const keys = Object.keys(UserProfileSection);
        debugLog("KEYS", `UserProfileSection keys: ${keys.join(', ') || 'none'}`);
        if (typeof UserProfileSection === 'function') {
            debugLog("KEYS", "UserProfileSection is a function");
        }
    } catch (e) { debugLog("ERROR", `Keys read failed: ${e}`); }
}

if (ActionSheet) {
    try {
        const keys = Object.keys(ActionSheet);
        debugLog("KEYS", `ActionSheet keys: ${keys.join(', ') || 'none'}`);
    } catch (e) { debugLog("ERROR", `Keys read failed: ${e}`); }
}

// Try to find navigation methods
const Navigation = findByProps("pushLazy", "popLazy") || findByProps("push", "pop") || findByProps("navigate");
const NavigationRouter = findByProps("transitionTo", "back");
const SettingsRouter = findByProps("open", "openSection") || findByName("SettingsRouter", false);

debugLog("INIT", `Navigation: ${!!Navigation}`);
debugLog("INIT", `NavigationRouter: ${!!NavigationRouter}`);
debugLog("INIT", `SettingsRouter: ${!!SettingsRouter}`);

if (Navigation) {
    try {
        const keys = Object.keys(Navigation);
        debugLog("KEYS", `Navigation keys: ${keys.join(', ') || 'none'}`);
    } catch (e) { debugLog("ERROR", `Navigation keys failed: ${e}`); }
}

if (NavigationRouter) {
    try {
        const keys = Object.keys(NavigationRouter);
        debugLog("KEYS", `NavigationRouter keys: ${keys.join(', ') || 'none'}`);
    } catch (e) { debugLog("ERROR", `NavigationRouter keys failed: ${e}`); }
}


// Permission constants
const VIEW_CHANNEL = constants?.Permissions?.VIEW_CHANNEL || 1024;

const PERMISSION_NAMES: { [key: number]: string } = {
    1: "Create Invite", 2: "Kick Members", 4: "Ban Members", 8: "Administrator",
    16: "Manage Channels", 32: "Manage Server", 64: "Add Reactions", 128: "View Audit Log",
    256: "Priority Speaker", 512: "Stream", 1024: "View Channel", 2048: "Send Messages",
    4096: "Send TTS", 8192: "Manage Messages", 16384: "Embed Links", 32768: "Attach Files",
    65536: "Read History", 131072: "Mention Everyone", 262144: "Use External Emoji",
    524288: "View Insights", 1048576: "Connect", 2097152: "Speak", 4194304: "Mute Members",
    8388608: "Deafen Members", 16777216: "Move Members", 33554432: "Use VAD",
    67108864: "Change Nickname", 134217728: "Manage Nicknames", 268435456: "Manage Roles",
    536870912: "Manage Webhooks", 1073741824: "Manage Emojis",
};

// Storage
let clipboardMonitorActive = false;
let autoSearchEnabled = true;
let isDashboardOpen = false;
let lastCheckedClipboard = "";
let checkIntervalId: any = null;
let patches: (() => void)[] = [];
let isActivelyScanning = false;

// Quick access context - for opening dashboard with pre-filled data
let quickAccessContext: { type: 'user' | 'channel' | null, id: string | null } = { type: null, id: null };

const skipChannels = [ChannelTypes.DM, ChannelTypes.GROUP_DM, ChannelTypes.GUILD_CATEGORY];

// ========================================
// INTERFACES
// ========================================

interface HiddenChannel {
    id: string;
    name: string;
    type: number;
    parentName: string;
    permissions: ChannelPermissions;
    guildId: string;
}

interface PermissionOverwrite {
    id: string;
    name: string;
    type: 'role' | 'user';
    color: number;
    allowed: string[];
    denied: string[];
    isUnknown: boolean;
    isFetched: boolean;
}

interface ChannelPermissions {
    overwrites: PermissionOverwrite[];
    userIds: string[];
}

interface SearchMessage {
    id: string;
    content: string;
    channelId: string;
    channelName: string;
    guildId: string;
    guildName: string;
    timestamp: string;
}

// ========================================
// HELPER FUNCTIONS
// ========================================

function requestGuildMembers(guildId: string, userIds: string[]) {
    if (!FluxDispatcher || userIds.length === 0) return;
    try {
        FluxDispatcher.dispatch({ type: "GUILD_MEMBERS_REQUEST", guildIds: [guildId], userIds });
    } catch { }
}

function isHidden(channel: any): boolean {
    if (!channel) return false;
    if (typeof channel === "string") channel = getChannel?.(channel) || ChannelStore?.getChannel?.(channel);
    if (!channel || skipChannels.includes(channel.type)) return false;
    channel.realCheck = true;
    const hidden = !Permissions?.can?.(VIEW_CHANNEL, channel);
    delete channel.realCheck;
    return hidden;
}

function parsePermissionBits(bits: number | string): string[] {
    const numBits = Number(bits);
    const perms: string[] = [];
    for (const [bit, name] of Object.entries(PERMISSION_NAMES)) {
        if ((numBits & Number(bit)) !== 0) perms.push(name);
    }
    return perms;
}

function getRoleName(roleId: string, guildId: string): { name: string, color: number, found: boolean } {
    try {
        const guild = GuildStore?.getGuild?.(guildId);
        if (guild?.roles?.[roleId]) {
            return { name: guild.roles[roleId].name, color: guild.roles[roleId].color || 0, found: true };
        }
    } catch { }
    try {
        if (GuildRoleStore) {
            const role = GuildRoleStore.getRole?.(guildId, roleId);
            if (role) return { name: role.name, color: role.color || 0, found: true };
        }
    } catch { }
    return { name: `Role ID: ${roleId}`, color: 0x5865F2, found: false };
}

function getUserDisplayName(userId: string, guildId: string): { name: string, isFetched: boolean } {
    const user = UserStore?.getUser?.(userId);
    const member = GuildMemberStore?.getMember?.(guildId, userId);
    if (user) {
        return { name: member?.nick || user.globalName || user.username, isFetched: true };
    }
    return { name: `User ID: ${userId}`, isFetched: false };
}

function getChannelPermissions(channel: any, guildId: string): ChannelPermissions {
    const overwrites: PermissionOverwrite[] = [];
    const userIds: string[] = [];
    try {
        const rawOverwrites = channel.permissionOverwrites || {};
        for (const [id, ow] of Object.entries(rawOverwrites) as any[]) {
            if (!ow) continue;
            const allow = Number(ow.allow || 0);
            const deny = Number(ow.deny || 0);
            const isRole = ow.type === 0 || ow.type === "role";
            const type = isRole ? 'role' : 'user';
            let name = "", color = 0, isUnknown = false, isFetched = true;
            if (isRole) {
                if (id === guildId) { name = "@everyone"; color = 0x99AAB5; }
                else { const r = getRoleName(id, guildId); name = r.name; color = r.color; isUnknown = !r.found; }
            } else {
                userIds.push(id);
                const u = getUserDisplayName(id, guildId);
                name = u.name; isFetched = u.isFetched; isUnknown = !isFetched;
            }
            overwrites.push({ id, name, type, color, allowed: parsePermissionBits(allow), denied: parsePermissionBits(deny), isUnknown, isFetched });
        }
        overwrites.sort((a, b) => {
            if (a.name === "@everyone") return -1;
            if (b.name === "@everyone") return 1;
            if (a.type !== b.type) return a.type === 'role' ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
    } catch { }
    return { overwrites, userIds };
}

function getChannelTypeName(type: number): string {
    switch (type) {
        case 0: return "💬"; case 2: return "🔊"; case 4: return "📁";
        case 5: return "📢"; case 13: return "🎭"; case 15: return "📋";
        default: return "📝";
    }
}

function getAllGuildChannels(guildId: string): any[] {
    const channelMap = new Map<string, any>();
    try {
        const m1 = ChannelStore?.getMutableGuildChannelsForGuild?.(guildId);
        if (m1) { for (const ch of (Array.isArray(m1) ? m1 : Object.values(m1))) { if (ch?.id) channelMap.set(ch.id, ch); } }
    } catch { }
    try {
        const all = ChannelStore?.getMutableGuildChannels?.();
        if (all) { for (const ch of Object.values(all) as any[]) { if (ch?.guild_id === guildId && ch?.id) channelMap.set(ch.id, ch); } }
    } catch { }
    try {
        if (GuildChannelStore?.getChannels) {
            const r = GuildChannelStore.getChannels(guildId);
            if (r) {
                const proc = (arr: any[]) => { if (Array.isArray(arr)) { for (const i of arr) { const ch = i?.channel || i; if (ch?.id) channelMap.set(ch.id, ch); } } };
                if (Array.isArray(r)) proc(r);
                else { for (const k of Object.keys(r)) { if (Array.isArray(r[k])) proc(r[k]); } }
            }
        }
    } catch { }
    return Array.from(channelMap.values());
}

function getHiddenChannels(guildId: string): HiddenChannel[] {
    const hidden: HiddenChannel[] = [];
    isActivelyScanning = true;
    try {
        const channels = getAllGuildChannels(guildId);
        for (const channel of channels) {
            if (!channel?.id || channel.type === 4 || channel.type === 1 || channel.type === 3 || channel.type === 11 || channel.type === 12 || skipChannels.includes(channel.type)) continue;
            if (isHidden(channel)) {
                hidden.push({ id: channel.id, name: channel.name || "unknown", type: channel.type || 0, parentName: channel.parent_id ? (ChannelStore?.getChannel?.(channel.parent_id)?.name || "") : "", permissions: getChannelPermissions(channel, guildId), guildId });
            }
        }
    } catch (e) { debugLog("ERROR", `getHiddenChannels: ${e}`); }
    finally { isActivelyScanning = false; }
    return hidden.sort((a, b) => a.name.localeCompare(b.name));
}

function canUserAccessChannel(userId: string, channel: HiddenChannel, guildId: string): boolean {
    const member = GuildMemberStore?.getMember?.(guildId, userId);
    if (!member) return false;
    const memberRoles = member.roles || [];
    for (const ow of channel.permissions.overwrites) {
        if (ow.type === 'user' && ow.id === userId && ow.allowed.includes("View Channel")) return true;
        if (ow.type === 'role' && memberRoles.includes(ow.id) && ow.allowed.includes("View Channel")) return true;
    }
    return false;
}

function getUserAccessibleHiddenChannels(userId: string, guildId: string): HiddenChannel[] {
    return getHiddenChannels(guildId).filter(ch => canUserAccessChannel(userId, ch, guildId));
}

// ========================================
// MESSAGE SEARCH
// ========================================

function getMutualGuilds(userId: string) {
    if (!GuildStore || !GuildMemberStore) return [];
    try { return (Object.values(GuildStore.getGuilds() || {}) as any[]).filter(g => GuildMemberStore.getMember(g.id, userId)); } catch { return []; }
}

async function searchMessagesInGuild(guildId: string, authorId: string): Promise<SearchMessage[]> {
    if (!RestAPI?.get) return [];
    try {
        const res = await RestAPI.get({ url: `/guilds/${guildId}/messages/search`, query: { author_id: authorId, include_nsfw: true, sort_by: "timestamp", sort_order: "desc" } });
        const guildName = GuildStore?.getGuild?.(guildId)?.name || "Unknown Server";
        return (res?.body?.messages || []).map((m: any[]) => ({ id: m[0].id, content: m[0].content || "[No text]", channelId: m[0].channel_id, channelName: ChannelStore?.getChannel?.(m[0].channel_id)?.name || "unknown", guildId, guildName, timestamp: m[0].timestamp }));
    } catch { return []; }
}

function safeClipboardCopy(text: string) {
    if (Clipboard?.setString) { Clipboard.setString(text); lastCheckedClipboard = text; return true; }
    return false;
}

function copyId(id: string, type: 'role' | 'user') {
    if (safeClipboardCopy(id)) { showToast(`📋 ${type === 'role' ? 'Role' : 'User'} ID copied!`, getAssetIDByName("Check")); }
}

async function autoSearchUser(userId: string) {
    const currentUser = UserStore?.getCurrentUser?.();
    if (currentUser && userId === currentUser.id) return;
    const guilds = getMutualGuilds(userId);
    if (guilds.length === 0) { showToast("❌ No mutual servers", getAssetIDByName("Small")); return; }
    showToast(`🔍 Searching...`, getAssetIDByName("ic_search"));
    let allMsgs: SearchMessage[] = [];
    for (let i = 0; i < Math.min(guilds.length, 8); i++) {
        try { allMsgs.push(...await searchMessagesInGuild(guilds[i].id, userId)); } catch { }
        if (i < guilds.length - 1) await new Promise(r => setTimeout(r, 250));
    }
    allMsgs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    if (allMsgs.length === 0) { showToast(`📭 No messages`, getAssetIDByName("Small")); return; }
    const latest = allMsgs[0];
    const link = `https://discord.com/channels/${latest.guildId}/${latest.channelId}/${latest.id}`;
    showToast(`✅ Found ${allMsgs.length}!`, getAssetIDByName("Check"));
    setTimeout(() => { if (safeClipboardCopy(link)) { showToast(`📋 Copied latest!`, getAssetIDByName("Check")); } }, 1500);
}

async function checkClipboardContent() {
    if (isDashboardOpen || !autoSearchEnabled) return;
    try {
        if (!Clipboard?.getString) return;
        const content = await Clipboard.getString();
        if (content && content !== lastCheckedClipboard && /^\d{17,19}$/.test(content.trim())) {
            lastCheckedClipboard = content;
            showToast(`🎯 ID detected!`, getAssetIDByName("Check"));
            setTimeout(() => autoSearchUser(content.trim()), 1000);
        }
    } catch { }
}

function formatTimeAgo(timestamp: string): string {
    const ago = Date.now() - new Date(timestamp).getTime();
    const m = Math.floor(ago / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (d > 0) return `${d}d ago`;
    if (h > 0) return `${h}h ago`;
    return `${m}m ago`;
}

// ========================================
// QUICK ACCESS: NAVIGATION TO DASHBOARD
// ========================================

// Store for quick access context
let quickAccessChannelId: string | null = null;

/**
 * Opens the Stalker Pro dashboard using NavigationRouter.transitionTo
 * This bypasses the ActionSheet gesture arena conflict by using proper navigation
 * instead of trying to render custom components inside openLazy
 */
function openStalkerDashboard(channelId?: string) {
    debugLog("NAV", `Opening dashboard via NavigationRouter, channel: ${channelId || 'none'}`);

    // Store channel context for dashboard use
    if (channelId) {
        quickAccessChannelId = channelId;
        quickAccessContext = { type: 'channel', id: channelId };
    }

    // Log current navigation history for debugging - DETAILED
    if (NavigationRouter?.getHistory) {
        try {
            const history = NavigationRouter.getHistory();
            debugLog("NAV", `History entries: ${history?.length || 0}`);
            if (history?.length > 0) {
                // Log last few entries to understand structure
                const lastEntries = history.slice(-3);
                lastEntries.forEach((entry: any, i: number) => {
                    if (entry) {
                        const keys = Object.keys(entry);
                        debugLog("NAV", `History[${history.length - 3 + i}] keys: ${keys.join(', ')}`);
                        // Log key properties
                        if (entry.pathname) debugLog("NAV", `  pathname: ${entry.pathname}`);
                        if (entry.path) debugLog("NAV", `  path: ${entry.path}`);
                        if (entry.key) debugLog("NAV", `  key: ${entry.key}`);
                        if (entry.state) {
                            const stateKeys = Object.keys(entry.state);
                            debugLog("NAV", `  state keys: ${stateKeys.join(', ')}`);
                        }
                    }
                });
            }
        } catch (e) {
            debugLog("NAV", `History read failed: ${e}`);
        }
    }

    // Try navigation to known Discord routes
    if (NavigationRouter?.transitionTo) {
        // Try valid Discord routes that might lead to settings
        const discordRoutes = [
            "user_settings",           // Settings main
            "SETTINGS",                // Alternative
            "/settings",               // Path style  
            "settings/overview",       // Settings overview
            "app_settings",            // App settings
        ];

        for (const route of discordRoutes) {
            try {
                debugLog("NAV", `Trying route: ${route}`);
                NavigationRouter.transitionTo(route);
                debugLog("NAV", `✅ transitionTo('${route}') called - checking if navigated...`);
                // Don't return - check if navigation happened
            } catch (e) {
                debugLog("NAV", `❌ ${route} threw: ${e}`);
            }
        }
    }

    // For now, since navigation doesn't work, provide useful fallback
    if (channelId) {
        const channel = ChannelStore?.getChannel?.(channelId);
        if (channel) {
            safeClipboardCopy(channelId);
            const permissions = getChannelPermissions(channel, channel.guild_id);
            const roles = permissions.overwrites.filter(o => o.type === 'role');
            const users = permissions.overwrites.filter(o => o.type === 'user');
            const isHidden = permissions.overwrites.some(o =>
                o.name === '@everyone' && o.denied.some(p => p.includes('VIEW'))
            );

            let info = `🔍 #${channel.name}\n`;
            info += `📋 ID: ${channelId} (copied)\n`;
            info += isHidden ? `🔒 HIDDEN\n` : '';
            info += `👥 ${roles.length} roles, ${users.length} users\n`;
            if (roles.length > 0) {
                info += `Roles: ${roles.slice(0, 3).map(r => r.name).join(', ')}`;
            }

            showToast(info, getAssetIDByName("Check"));

            // Log detailed permissions to debug tab
            debugLog("PERMS", `=== #${channel.name} permissions ===`);
            permissions.overwrites.forEach(ow => {
                const allowed = ow.allowed.slice(0, 5).join(', ');
                const denied = ow.denied.slice(0, 5).join(', ');
                debugLog("PERMS", `${ow.type === 'role' ? '🏷️' : '👤'} ${ow.name}`);
                if (allowed) debugLog("PERMS", `  ✅ ${allowed}`);
                if (denied) debugLog("PERMS", `  ❌ ${denied}`);
            });

            debugLog("NAV", "✅ Quick info shown, full details in Debug tab");
        }
    } else {
        showToast("📱 Settings → Plugins → Stalker Pro\nCheck Debug tab for channel permissions", getAssetIDByName("Check"));
    }
}

// ========================================
// SETTINGS UI
// ========================================

function StalkerSettings() {
    const [activeTab, setActiveTab] = React.useState<'hidden' | 'perms' | 'user' | 'search' | 'debug'>('hidden');
    const [hiddenChannels, setHiddenChannels] = React.useState<HiddenChannel[]>([]);
    const [isScanning, setIsScanning] = React.useState(false);
    const [selectedGuild, setSelectedGuild] = React.useState<any>(null);
    const [selectedChannel, setSelectedChannel] = React.useState<HiddenChannel | null>(null);
    const [debugInfo, setDebugInfo] = React.useState("Tap 'Scan' to find hidden channels");
    const [lookupUserId, setLookupUserId] = React.useState("");
    const [userAccessChannels, setUserAccessChannels] = React.useState<HiddenChannel[]>([]);
    const [lookupUserInfo, setLookupUserInfo] = React.useState<any>(null);
    const [isLookingUp, setIsLookingUp] = React.useState(false);
    const [searchUserId, setSearchUserId] = React.useState("");
    const [isSearching, setIsSearching] = React.useState(false);
    const [searchResults, setSearchResults] = React.useState<SearchMessage[]>([]);
    const [autoSearchToggle, setAutoSearchToggle] = React.useState(autoSearchEnabled);
    const [logs, setLogs] = React.useState<string[]>(getDebugLogs());
    const [, forceUpdate] = React.useState(0);

    // Check for pre-filled context from quick access
    React.useEffect(() => {
        if (quickAccessContext.type === 'user' && quickAccessContext.id) {
            setLookupUserId(quickAccessContext.id);
            setActiveTab('user');
            quickAccessContext = { type: null, id: null };
        } else if (quickAccessContext.type === 'channel' && quickAccessContext.id) {
            // Find channel and show perms
            const guildId = SelectedGuildStore?.getGuildId?.();
            if (guildId) {
                const ch = ChannelStore?.getChannel?.(quickAccessContext.id);
                if (ch) {
                    const hc: HiddenChannel = {
                        id: ch.id, name: ch.name, type: ch.type, parentName: "",
                        permissions: getChannelPermissions(ch, guildId), guildId
                    };
                    setSelectedChannel(hc);
                    setActiveTab('perms');
                }
            }
            quickAccessContext = { type: null, id: null };
        }
    }, []);

    // Mark dashboard as open/closed + handle back button
    React.useEffect(() => {
        isDashboardOpen = true;
        const guildId = SelectedGuildStore?.getGuildId?.();
        if (guildId) setSelectedGuild(GuildStore?.getGuild?.(guildId));

        const backHandler = BackHandler?.addEventListener?.("hardwareBackPress", () => {
            if (selectedChannel) {
                setSelectedChannel(null);
                if (activeTab === 'perms') setActiveTab('hidden');
                return true;
            }
            if (activeTab !== 'hidden') { setActiveTab('hidden'); return true; }
            return false;
        });

        return () => { isDashboardOpen = false; backHandler?.remove?.(); };
    }, [selectedChannel, activeTab]);

    React.useEffect(() => {
        if (selectedChannel && selectedChannel.permissions.userIds.length > 0) {
            requestGuildMembers(selectedChannel.guildId, selectedChannel.permissions.userIds);
            const timer = setTimeout(() => {
                if (selectedChannel && selectedGuild) {
                    const channel = ChannelStore?.getChannel?.(selectedChannel.id);
                    if (channel) setSelectedChannel({ ...selectedChannel, permissions: getChannelPermissions(channel, selectedGuild.id) });
                }
            }, 1500);
            return () => clearTimeout(timer);
        }
    }, [selectedChannel?.id]);

    const scanCurrentGuild = () => {
        setIsScanning(true); setHiddenChannels([]);
        try {
            const guildId = SelectedGuildStore?.getGuildId?.();
            if (guildId) {
                setSelectedGuild(GuildStore?.getGuild?.(guildId));
                const channels = getHiddenChannels(guildId);
                setHiddenChannels(channels);
                setDebugInfo(`Scanned → ${channels.length} hidden`);
                showToast(channels.length > 0 ? `🔒 ${channels.length} hidden!` : `✨ No hidden`, getAssetIDByName("Check"));
            } else { setSelectedGuild(null); setDebugInfo("Open a server first"); }
        } catch (e) { setDebugInfo(`Error: ${e}`); }
        finally { setIsScanning(false); }
    };

    const refreshSelectedChannel = () => {
        if (selectedChannel && selectedGuild) {
            requestGuildMembers(selectedGuild.id, selectedChannel.permissions.userIds);
            setTimeout(() => {
                const channel = ChannelStore?.getChannel?.(selectedChannel.id);
                if (channel) { setSelectedChannel({ ...selectedChannel, permissions: getChannelPermissions(channel, selectedGuild.id) }); showToast("🔄 Refreshed!", getAssetIDByName("Check")); }
            }, 500);
        }
    };

    const handleUserLookup = () => {
        const cleanId = lookupUserId.trim();
        if (!cleanId || cleanId.length < 17) { showToast("Enter valid ID", getAssetIDByName("Small")); return; }
        if (!selectedGuild) { showToast("Open a server first", getAssetIDByName("Small")); return; }
        setIsLookingUp(true);
        requestGuildMembers(selectedGuild.id, [cleanId]);
        setTimeout(() => {
            const user = UserStore?.getUser?.(cleanId);
            const member = GuildMemberStore?.getMember?.(selectedGuild.id, cleanId);
            setLookupUserInfo({ user, member, id: cleanId });
            setUserAccessChannels(getUserAccessibleHiddenChannels(cleanId, selectedGuild.id));
            setIsLookingUp(false);
        }, 500);
    };

    const handleManualSearch = async () => {
        const cleanId = searchUserId.trim();
        if (!cleanId || cleanId.length < 17) { showToast("Enter valid ID", getAssetIDByName("Small")); return; }
        setIsSearching(true); setSearchResults([]);
        const guilds = getMutualGuilds(cleanId);
        if (guilds.length === 0) { showToast("❌ No mutual servers", getAssetIDByName("Small")); setIsSearching(false); return; }
        showToast(`🔍 Searching...`, getAssetIDByName("ic_search"));
        let allMsgs: SearchMessage[] = [];
        for (let i = 0; i < Math.min(guilds.length, 8); i++) {
            try { allMsgs.push(...await searchMessagesInGuild(guilds[i].id, cleanId)); } catch { }
            if (i < guilds.length - 1) await new Promise(r => setTimeout(r, 250));
        }
        allMsgs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        setSearchResults(allMsgs); setIsSearching(false);
        showToast(allMsgs.length > 0 ? `✅ ${allMsgs.length} messages!` : `📭 No messages`, getAssetIDByName("Check"));
    };

    const copyMessageLink = (msg: SearchMessage) => {
        const link = `https://discord.com/channels/${msg.guildId}/${msg.channelId}/${msg.id}`;
        if (safeClipboardCopy(link)) { showToast("📋 Link copied!", getAssetIDByName("Check")); }
    };

    const pasteFromClipboard = async (setter: (v: string) => void) => {
        try { const c = await Clipboard?.getString?.(); if (c) { setter(c.trim()); showToast("📋 Pasted!", getAssetIDByName("Check")); } } catch { }
    };

    const toggleAutoSearch = (val: boolean) => { autoSearchEnabled = val; setAutoSearchToggle(val); showToast(val ? "✅ Auto-search enabled" : "❌ Auto-search disabled", getAssetIDByName("Check")); };

    const roleColor = (c: number) => c ? `#${c.toString(16).padStart(6, '0')}` : '#99AAB5';

    const TabBtn = ({ id, label, icon }: any) =>
        React.createElement(TouchableOpacity, {
            style: { flex: 1, padding: 6, backgroundColor: activeTab === id ? '#5865F2' : '#2b2d31', borderRadius: 6, marginHorizontal: 1 },
            onPress: () => { setActiveTab(id); if (id !== 'perms') setSelectedChannel(null); if (id === 'debug') setLogs(getDebugLogs()); }
        }, React.createElement(Text, { style: { color: '#fff', textAlign: 'center', fontSize: 9, fontWeight: activeTab === id ? 'bold' : 'normal' } }, `${icon}${label}`));

    const ChannelCard = ({ ch, onPress }: { ch: HiddenChannel, onPress: () => void }) =>
        React.createElement(TouchableOpacity, { style: { margin: 6, padding: 10, backgroundColor: '#2b2d31', borderRadius: 10, borderLeftWidth: 3, borderLeftColor: '#5865F2' }, onPress }, [
            React.createElement(View, { key: 'h', style: { flexDirection: 'row', alignItems: 'center' } }, [
                React.createElement(Text, { key: 'i', style: { fontSize: 14, marginRight: 6 } }, getChannelTypeName(ch.type)),
                React.createElement(View, { key: 'n', style: { flex: 1 } }, [
                    React.createElement(Text, { key: 'nm', style: { color: '#fff', fontSize: 13, fontWeight: 'bold' } }, ch.name),
                    ch.parentName && React.createElement(Text, { key: 'p', style: { color: '#949ba4', fontSize: 10 } }, `in ${ch.parentName}`)
                ]),
                React.createElement(Text, { key: 'a', style: { color: '#5865F2', fontSize: 10 } }, "→")
            ])
        ]);

    const OverwriteItem = ({ ow }: { ow: PermissionOverwrite }) =>
        React.createElement(TouchableOpacity, { style: { margin: 4, marginHorizontal: 6, padding: 8, backgroundColor: '#2b2d31', borderRadius: 8, borderLeftWidth: 3, borderLeftColor: ow.type === 'role' ? roleColor(ow.color) : '#43b581' }, onPress: () => copyId(ow.id, ow.type) }, [
            React.createElement(View, { key: 'hdr', style: { flexDirection: 'row', alignItems: 'center', marginBottom: 3 } }, [
                React.createElement(Text, { key: 't', style: { fontSize: 11, marginRight: 4 } }, ow.type === 'role' ? '🏷️' : '👤'),
                React.createElement(View, { key: 'nw', style: { flex: 1 } }, [
                    React.createElement(Text, { key: 'n', style: { color: ow.type === 'role' ? roleColor(ow.color) : '#43b581', fontSize: 12, fontWeight: 'bold' } }, ow.name),
                    !ow.isFetched && ow.type === 'user' && React.createElement(Text, { key: 'hint', style: { color: '#949ba4', fontSize: 9 } }, "Tap refresh")
                ]),
                React.createElement(View, { key: 'b', style: { backgroundColor: ow.type === 'role' ? '#5865F2' : '#43b581', paddingHorizontal: 5, paddingVertical: 2, borderRadius: 3 } },
                    React.createElement(Text, { style: { color: '#fff', fontSize: 8, fontWeight: 'bold' } }, ow.type === 'role' ? 'ROLE' : 'USER')),
                React.createElement(Text, { key: 'copy', style: { color: '#949ba4', fontSize: 9, marginLeft: 4 } }, "📋")
            ]),
            ow.allowed.length > 0 && React.createElement(View, { key: 'a', style: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 2 } },
                ow.allowed.map((p, pi) => React.createElement(Text, { key: `a${pi}`, style: { color: '#43b581', fontSize: 9, backgroundColor: 'rgba(67,181,129,0.15)', paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3, marginRight: 2, marginBottom: 2 } }, `✅${p}`))),
            ow.denied.length > 0 && React.createElement(View, { key: 'd', style: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 2 } },
                ow.denied.map((p, pi) => React.createElement(Text, { key: `d${pi}`, style: { color: '#ed4245', fontSize: 9, backgroundColor: 'rgba(237,66,69,0.15)', paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3, marginRight: 2, marginBottom: 2 } }, `❌${p}`)))
        ]);

    return React.createElement(ScrollView, { style: { flex: 1, backgroundColor: '#1e1f22' } }, [
        React.createElement(View, { key: 'h', style: { padding: 10, backgroundColor: '#2b2d31', marginBottom: 6 } }, [
            React.createElement(Text, { key: 't', style: { color: '#fff', fontSize: 16, fontWeight: 'bold', textAlign: 'center' } }, "🔍 Stalker Pro v7.5-dev"),
            React.createElement(Text, { key: 's', style: { color: '#b5bac1', fontSize: 10, textAlign: 'center' } }, selectedGuild ? `📍 ${selectedGuild.name}` : "Open a server")
        ]),

        React.createElement(View, { key: 'tabs', style: { flexDirection: 'row', padding: 4, marginBottom: 4 } }, [
            React.createElement(TabBtn, { key: '1', id: 'hidden', label: 'Hidden', icon: '🔒' }),
            React.createElement(TabBtn, { key: '2', id: 'perms', label: 'Perms', icon: '🔐' }),
            React.createElement(TabBtn, { key: '3', id: 'user', label: 'User', icon: '👤' }),
            React.createElement(TabBtn, { key: '4', id: 'search', label: 'Msgs', icon: '💬' }),
            React.createElement(TabBtn, { key: '5', id: 'debug', label: 'Debug', icon: '🐛' })
        ]),

        // Hidden tab
        activeTab === 'hidden' && [
            React.createElement(TouchableOpacity, { key: 'scan', style: { margin: 8, padding: 12, backgroundColor: '#5865F2', borderRadius: 8, alignItems: 'center' }, onPress: scanCurrentGuild },
                React.createElement(Text, { style: { color: '#fff', fontWeight: 'bold', fontSize: 14 } }, isScanning ? "⏳ Scanning..." : "🔄 Scan Server")),
            React.createElement(Text, { key: 'dbg', style: { color: '#949ba4', textAlign: 'center', fontSize: 10, marginBottom: 6 } }, debugInfo),
            ...hiddenChannels.map((ch, i) => React.createElement(ChannelCard, { key: `c${i}`, ch, onPress: () => { setSelectedChannel(ch); setActiveTab('perms'); } })),
            hiddenChannels.length === 0 && !isScanning && React.createElement(View, { key: 'empty', style: { padding: 30, alignItems: 'center' } }, [
                React.createElement(Text, { key: 'e1', style: { fontSize: 30 } }, "🔒"),
                React.createElement(Text, { key: 'e2', style: { color: '#b5bac1', fontSize: 12, marginTop: 6, textAlign: 'center' } }, "Tap 'Scan Server' to find hidden channels")
            ])
        ],

        // Perms tab
        activeTab === 'perms' && [
            !selectedChannel && React.createElement(View, { key: 'no-sel', style: { padding: 30, alignItems: 'center' } }, [
                React.createElement(Text, { key: 't1', style: { fontSize: 30 } }, "🔐"),
                React.createElement(Text, { key: 't2', style: { color: '#fff', fontSize: 13, marginTop: 6 } }, "Select a channel")
            ]),
            selectedChannel && [
                React.createElement(View, { key: 'ch-hdr', style: { padding: 10, backgroundColor: '#2b2d31', margin: 6, borderRadius: 8 } }, [
                    React.createElement(View, { key: 'r', style: { flexDirection: 'row', alignItems: 'center' } }, [
                        React.createElement(Text, { key: 'i', style: { fontSize: 18, marginRight: 8 } }, getChannelTypeName(selectedChannel.type)),
                        React.createElement(Text, { key: 'n', style: { color: '#fff', fontSize: 14, fontWeight: 'bold', flex: 1 } }, selectedChannel.name)
                    ])
                ]),
                React.createElement(View, { key: 'btns', style: { flexDirection: 'row', margin: 6, marginTop: 0 } }, [
                    React.createElement(TouchableOpacity, { key: 'ref', style: { flex: 1, padding: 8, backgroundColor: '#3f4147', borderRadius: 6, marginRight: 2, alignItems: 'center' }, onPress: refreshSelectedChannel },
                        React.createElement(Text, { style: { color: '#fff', fontSize: 10 } }, "🔄 Refresh")),
                    React.createElement(TouchableOpacity, { key: 'cpy', style: { flex: 1, padding: 8, backgroundColor: '#3f4147', borderRadius: 6, marginLeft: 2, alignItems: 'center' }, onPress: () => { if (safeClipboardCopy(selectedChannel.id)) { showToast("📋 Channel ID copied", getAssetIDByName("Check")); } } },
                        React.createElement(Text, { style: { color: '#b5bac1', fontSize: 9 } }, `📋 Channel ID`))
                ]),
                React.createElement(Text, { key: 'hint', style: { color: '#949ba4', fontSize: 9, textAlign: 'center', marginBottom: 4 } }, "Tap any role/user to copy ID"),
                ...selectedChannel.permissions.overwrites.map((ow, i) => React.createElement(OverwriteItem, { key: `ow-${i}`, ow }))
            ]
        ],

        // User tab
        activeTab === 'user' && [
            React.createElement(View, { key: 'input-box', style: { margin: 8, padding: 10, backgroundColor: '#2b2d31', borderRadius: 8 } }, [
                React.createElement(Text, { key: 'lbl', style: { color: '#fff', fontSize: 11, fontWeight: 'bold', marginBottom: 4 } }, "👤 User ID Lookup"),
                React.createElement(View, { key: 'row', style: { flexDirection: 'row', alignItems: 'center' } }, [
                    React.createElement(TextInput, { key: 'input', style: { flex: 1, backgroundColor: '#1e1f22', color: '#fff', padding: 8, borderRadius: 6, fontSize: 12 }, placeholder: "Enter User ID", placeholderTextColor: '#72767d', value: lookupUserId, onChangeText: setLookupUserId }),
                    React.createElement(TouchableOpacity, { key: 'paste', style: { marginLeft: 4, padding: 8, backgroundColor: '#3f4147', borderRadius: 6 }, onPress: () => pasteFromClipboard(setLookupUserId) },
                        React.createElement(Text, { style: { color: '#fff', fontSize: 11 } }, "📋"))
                ]),
                React.createElement(TouchableOpacity, { key: 'btn', style: { marginTop: 8, padding: 10, backgroundColor: '#5865F2', borderRadius: 6, alignItems: 'center' }, onPress: handleUserLookup },
                    React.createElement(Text, { style: { color: '#fff', fontWeight: 'bold', fontSize: 12 } }, isLookingUp ? "⏳..." : "🔍 Find Hidden Channels"))
            ]),
            lookupUserInfo && React.createElement(View, { key: 'user-info', style: { margin: 8, marginTop: 0, padding: 8, backgroundColor: '#2b2d31', borderRadius: 8 } }, [
                React.createElement(Text, { key: 'name', style: { color: '#fff', fontSize: 12, fontWeight: 'bold' } }, lookupUserInfo.member?.nick || lookupUserInfo.user?.globalName || lookupUserInfo.user?.username || `User ${lookupUserInfo.id.slice(-6)}`),
                React.createElement(Text, { key: 'access', style: { color: '#43b581', fontSize: 10, marginTop: 2 } }, `✅ Can access ${userAccessChannels.length} hidden channels`)
            ]),
            ...userAccessChannels.map((ch, i) => React.createElement(ChannelCard, { key: `uc${i}`, ch, onPress: () => { setSelectedChannel(ch); setActiveTab('perms'); } })),
            lookupUserInfo && userAccessChannels.length === 0 && React.createElement(Text, { key: 'no', style: { color: '#949ba4', textAlign: 'center', fontSize: 11, marginTop: 10 } }, "No hidden channel access")
        ],

        // Search tab
        activeTab === 'search' && [
            React.createElement(View, { key: 'auto-box', style: { margin: 8, padding: 10, backgroundColor: '#2b2d31', borderRadius: 8 } }, [
                React.createElement(View, { key: 'row', style: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' } }, [
                    React.createElement(View, { key: 'txt' }, [
                        React.createElement(Text, { key: 't', style: { color: '#fff', fontSize: 11, fontWeight: 'bold' } }, "💬 Auto-Search"),
                        React.createElement(Text, { key: 's', style: { color: '#b5bac1', fontSize: 9 } }, "Copy User ID → auto-copies latest message")
                    ]),
                    React.createElement(TouchableOpacity, { key: 'toggle', style: { padding: 8, backgroundColor: autoSearchToggle ? '#43b581' : '#ed4245', borderRadius: 6 }, onPress: () => toggleAutoSearch(!autoSearchToggle) },
                        React.createElement(Text, { style: { color: '#fff', fontSize: 10, fontWeight: 'bold' } }, autoSearchToggle ? "ON" : "OFF"))
                ]),
                React.createElement(Text, { key: 'note', style: { color: '#949ba4', fontSize: 9, marginTop: 6 } }, isDashboardOpen ? "⏸️ Paused while dashboard is open" : (autoSearchToggle ? "✅ Active" : "❌ Disabled"))
            ]),
            React.createElement(View, { key: 'search-box', style: { margin: 8, marginTop: 0, padding: 10, backgroundColor: '#2b2d31', borderRadius: 8 } }, [
                React.createElement(Text, { key: 'lbl', style: { color: '#fff', fontSize: 11, fontWeight: 'bold', marginBottom: 4 } }, "🔍 Manual Search"),
                React.createElement(View, { key: 'row', style: { flexDirection: 'row', alignItems: 'center' } }, [
                    React.createElement(TextInput, { key: 'input', style: { flex: 1, backgroundColor: '#1e1f22', color: '#fff', padding: 8, borderRadius: 6, fontSize: 12 }, placeholder: "Enter User ID", placeholderTextColor: '#72767d', value: searchUserId, onChangeText: setSearchUserId }),
                    React.createElement(TouchableOpacity, { key: 'paste', style: { marginLeft: 4, padding: 8, backgroundColor: '#3f4147', borderRadius: 6 }, onPress: () => pasteFromClipboard(setSearchUserId) },
                        React.createElement(Text, { style: { color: '#fff', fontSize: 11 } }, "📋"))
                ]),
                React.createElement(TouchableOpacity, { key: 'btn', style: { marginTop: 8, padding: 10, backgroundColor: '#5865F2', borderRadius: 6, alignItems: 'center' }, onPress: handleManualSearch },
                    React.createElement(Text, { style: { color: '#fff', fontWeight: 'bold', fontSize: 12 } }, isSearching ? "⏳ Searching..." : "🔍 Find Messages"))
            ]),
            searchResults.length > 0 && React.createElement(Text, { key: 'results-title', style: { color: '#fff', fontSize: 11, fontWeight: 'bold', marginLeft: 8, marginTop: 4 } }, `📝 ${searchResults.length} Messages:`),
            ...searchResults.slice(0, 25).map((msg, i) =>
                React.createElement(TouchableOpacity, { key: `msg${i}`, style: { margin: 4, marginHorizontal: 8, padding: 10, backgroundColor: '#2b2d31', borderRadius: 8, borderLeftWidth: 3, borderLeftColor: '#5865F2' }, onPress: () => copyMessageLink(msg) }, [
                    React.createElement(View, { key: 'hdr', style: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 } }, [
                        React.createElement(Text, { key: 'ch', style: { color: '#5865F2', fontSize: 11, flex: 1 } }, `#${msg.channelName}`),
                        React.createElement(Text, { key: 'time', style: { color: '#949ba4', fontSize: 9 } }, formatTimeAgo(msg.timestamp))
                    ]),
                    React.createElement(Text, { key: 'content', style: { color: '#dcddde', fontSize: 11 }, numberOfLines: 2 }, msg.content),
                    React.createElement(Text, { key: 'server', style: { color: '#72767d', fontSize: 9, marginTop: 4 } }, `📍 ${msg.guildName}`)
                ])
            )
        ],

        // Debug tab
        activeTab === 'debug' && [
            React.createElement(View, { key: 'debug-header', style: { margin: 8, padding: 10, backgroundColor: '#2b2d31', borderRadius: 8 } }, [
                React.createElement(Text, { key: 't', style: { color: '#fff', fontSize: 14, fontWeight: 'bold' } }, "🐛 Debug Logs"),
                React.createElement(Text, { key: 's', style: { color: '#b5bac1', fontSize: 10, marginTop: 4 } }, `${logs.length} log entries`),
                React.createElement(View, { key: 'btns', style: { flexDirection: 'row', marginTop: 8 } }, [
                    React.createElement(TouchableOpacity, { key: 'refresh', style: { flex: 1, padding: 8, backgroundColor: '#5865F2', borderRadius: 6, marginRight: 4, alignItems: 'center' }, onPress: () => setLogs(getDebugLogs()) },
                        React.createElement(Text, { style: { color: '#fff', fontSize: 10 } }, "🔄 Refresh")),
                    React.createElement(TouchableOpacity, { key: 'clear', style: { flex: 1, padding: 8, backgroundColor: '#ed4245', borderRadius: 6, marginLeft: 4, alignItems: 'center' }, onPress: () => { clearDebugLogs(); setLogs([]); } },
                        React.createElement(Text, { style: { color: '#fff', fontSize: 10 } }, "🗑️ Clear")),
                    React.createElement(TouchableOpacity, { key: 'copy', style: { flex: 1, padding: 8, backgroundColor: '#3f4147', borderRadius: 6, marginLeft: 4, alignItems: 'center' }, onPress: () => { if (safeClipboardCopy(logs.join('\n'))) showToast("📋 Logs copied!", getAssetIDByName("Check")); } },
                        React.createElement(Text, { style: { color: '#fff', fontSize: 10 } }, "📋 Copy"))
                ])
            ]),
            React.createElement(View, { key: 'module-status', style: { margin: 8, marginTop: 0, padding: 10, backgroundColor: '#2b2d31', borderRadius: 8 } }, [
                React.createElement(Text, { key: 't', style: { color: '#fff', fontSize: 12, fontWeight: 'bold', marginBottom: 6 } }, "📦 Module Status"),
                React.createElement(Text, { key: 'm1', style: { color: UserProfileHeader ? '#43b581' : '#ed4245', fontSize: 10 } }, `UserProfileHeader: ${UserProfileHeader ? '✅' : '❌'}`),
                React.createElement(Text, { key: 'm2', style: { color: ChannelLongPress ? '#43b581' : '#ed4245', fontSize: 10 } }, `ChannelLongPress: ${ChannelLongPress ? '✅' : '❌'}`),
                React.createElement(Text, { key: 'm3', style: { color: ActionSheet ? '#43b581' : '#ed4245', fontSize: 10 } }, `ActionSheet: ${ActionSheet ? '✅' : '❌'}`),
                React.createElement(Text, { key: 'm4', style: { color: Commands ? '#43b581' : '#ed4245', fontSize: 10 } }, `Commands: ${Commands ? '✅' : '❌'}`),
                React.createElement(Text, { key: 'm5', style: { color: '#949ba4', fontSize: 10, marginTop: 4 } }, `Patches active: ${patches.length}`)
            ]),
            ...logs.map((log: string, i: number) =>
                React.createElement(Text, { key: `log${i}`, style: { color: log.includes('ERROR') ? '#ed4245' : log.includes('SUCCESS') ? '#43b581' : '#b5bac1', fontSize: 9, paddingHorizontal: 8, paddingVertical: 2, fontFamily: 'monospace' } }, log)
            ),
            logs.length === 0 && React.createElement(Text, { key: 'no-logs', style: { color: '#949ba4', textAlign: 'center', marginTop: 20, fontSize: 11 }, }, "No logs yet")
        ]
    ]);
}

// ========================================
// POPUP DASHBOARD COMPONENT
// ========================================

function PopupDashboard() {
    const [visible, setVisible] = React.useState(false);

    // Register the global setter so openStalkerDashboard can trigger this
    React.useEffect(() => {
        setShowDashboardPopup = setVisible;
        debugLog("POPUP", "Popup dashboard registered");
        return () => {
            setShowDashboardPopup = null;
        };
    }, []);

    if (!Modal) {
        debugLog("POPUP", "Modal not available");
        return null;
    }

    if (!visible) return null;

    return React.createElement(
        Modal,
        {
            visible: true,
            animationType: 'slide',
            presentationStyle: 'fullScreen',
            onRequestClose: () => setVisible(false)
        },
        React.createElement(View, {
            style: {
                flex: 1,
                backgroundColor: '#1e1f22'
            }
        }, [
            // Close button header
            React.createElement(View, {
                key: 'header',
                style: {
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: 12,
                    backgroundColor: '#2b2d31',
                    borderBottomWidth: 1,
                    borderBottomColor: '#1e1f22'
                }
            }, [
                React.createElement(Text, { key: 'title', style: { color: '#fff', fontSize: 16, fontWeight: 'bold' } }, "🔍 Stalker Pro"),
                React.createElement(TouchableOpacity, {
                    key: 'close',
                    style: { padding: 8, backgroundColor: '#ed4245', borderRadius: 6 },
                    onPress: () => setVisible(false)
                }, React.createElement(Text, { style: { color: '#fff', fontWeight: 'bold' } }, "✕ Close"))
            ]),
            // Dashboard content
            React.createElement(StalkerSettings, { key: 'content' })
        ])
    );
}

export const settings = StalkerSettings;

// Render the popup dashboard globally
// This needs to be added to the app somehow - we'll try patching a root component

// Helper to open dashboard with context
function openDashboardWithContext(type: 'user' | 'channel', id: string) {
    quickAccessContext = { type, id };
    debugLog("ACTION", `Set context: ${type} = ${id}`);
    showToast(`🔍 Open plugin settings to view!`, getAssetIDByName("Check"));
}

export const onLoad = () => {
    debugLog("LOAD", "=== STALKER PRO v7.5-dev ===");

    // Check if Modal is available
    debugLog("INIT", `Modal available: ${!!Modal}`);

    // Try to patch a root component to inject our popup
    // We'll try patching the App or Navigator component
    const AppContainer = findByName("App", false) || findByName("AppContainer", false) || findByName("Navigator", false);

    if (AppContainer) {
        try {
            patches.push(after("default", AppContainer, (args: any, res: any) => {
                if (!res) return res;
                // Wrap the result with our popup dashboard
                return React.createElement(View, { style: { flex: 1 } }, [
                    res,
                    React.createElement(PopupDashboard, { key: 'stalker-popup' })
                ]);
            }));
            debugLog("PATCH", "✅ App container patched for popup");
        } catch (e) {
            debugLog("ERROR", `App container patch failed: ${e}`);
        }
    } else {
        debugLog("INIT", "App container not found, trying alternative...");

        // Alternative: Try to patch MessageList or similar that's always rendered
        const ChatContainer = findByName("Chat", false) || findByName("ChatContainer", false);
        if (ChatContainer) {
            try {
                patches.push(after("default", ChatContainer, (args: any, res: any) => {
                    if (!res) return res;
                    return React.createElement(View, { style: { flex: 1 } }, [
                        res,
                        React.createElement(PopupDashboard, { key: 'stalker-popup' })
                    ]);
                }));
                debugLog("PATCH", "✅ Chat container patched for popup");
            } catch (e) {
                debugLog("ERROR", `Chat container patch failed: ${e}`);
            }
        }
    }

    // Patch Permissions.can
    if (Permissions?.can) {
        try {
            patches.push(after("can", Permissions, ([permID, channel]: any, res: any) => {
                if (channel?.realCheck) return res;
                if (isActivelyScanning && permID === VIEW_CHANNEL) return true;
                return res;
            }));
            debugLog("PATCH", "✅ Permissions.can patched");
        } catch (e) { debugLog("ERROR", `Permissions.can patch failed: ${e}`); }
    }

    // Try to patch ChannelLongPress to add our option
    if (ChannelLongPress) {
        try {
            patches.push(after("default", ChannelLongPress, (args: any, res: any) => {
                try {
                    const props = args[0];

                    // Log props structure to find where channel data is
                    if (props) {
                        const propKeys = Object.keys(props);
                        debugLog("STRUCT", `Props keys: ${propKeys.join(', ')}`);

                        // Try to find channel in various places
                        const channelId = props?.channel?.id || props?.channelId || props?.id;
                        const channelName = props?.channel?.name || props?.name || "unknown";
                        debugLog("CHANNEL", `LongPress: ${channelName} (${channelId})`);

                        // Log a preview of each prop
                        for (const key of propKeys.slice(0, 5)) {
                            const val = props[key];
                            const type = typeof val;
                            if (type === 'object' && val !== null) {
                                const subKeys = Object.keys(val).slice(0, 3);
                                debugLog("STRUCT", `  props.${key} = {${subKeys.join(', ')}...}`);
                            } else {
                                debugLog("STRUCT", `  props.${key} = ${type}`);
                            }
                        }
                    }

                    // Log res structure to find where to inject
                    if (res) {
                        debugLog("STRUCT", `res type: ${res.type?.name || res.type?.displayName || typeof res.type}`);
                        if (res.props) {
                            const resKeys = Object.keys(res.props);
                            debugLog("STRUCT", `res.props keys: ${resKeys.join(', ')}`);

                            if (res.props.children) {
                                const children = res.props.children;
                                if (Array.isArray(children)) {
                                    debugLog("STRUCT", `res.props.children = Array(${children.length})`);
                                } else if (children && typeof children === 'object') {
                                    debugLog("STRUCT", `res.props.children = ${children.type?.name || children.type?.displayName || 'object'}`);
                                } else {
                                    debugLog("STRUCT", `res.props.children = ${typeof children}`);
                                }
                            }
                        }
                    }

                    // Approach: Wrap the result in a Fragment with our button appended
                    // Since res is a connected component, we can't inject into its internal children,
                    // but we can wrap it with our button as a sibling
                    const channelId = props?.channelId;
                    const channel = res?.props?.channel;
                    const channelName = channel?.name || "this channel";

                    debugLog("INJECT", `Wrapping with button for: ${channelName} (${channelId})`);

                    // ALWAYS use TouchableOpacity - it works!
                    // ActionSheetRow is just a layout container, not touchable
                    const stalkerButton = React.createElement(
                        TouchableOpacity,
                        {
                            key: "stalker-action",
                            style: {
                                flexDirection: 'row',
                                alignItems: 'center',
                                paddingVertical: 14,
                                paddingHorizontal: 20,
                                backgroundColor: '#2b2d31',
                                marginHorizontal: 12,
                                marginTop: 8,
                                marginBottom: 12,
                                borderRadius: 12,
                                borderWidth: 1,
                                borderColor: '#5865F2',
                            },
                            onPress: () => {
                                debugLog("ACTION", `Button pressed for ${channelId}`);
                                ActionSheet?.hideActionSheet?.();
                                setTimeout(() => {
                                    openStalkerDashboard(channelId);
                                }, 100);
                            }
                        },
                        [
                            React.createElement(Text, { key: "icon", style: { fontSize: 18, marginRight: 12 } }, "🔍"),
                            React.createElement(View, { key: "txt", style: { flex: 1 } }, [
                                React.createElement(Text, { key: "t1", style: { color: '#fff', fontSize: 15, fontWeight: 'bold' } }, "Stalker Pro"),
                                React.createElement(Text, { key: "t2", style: { color: '#b5bac1', fontSize: 11 } }, `Quick Info #${channelName}`)
                            ]),
                            React.createElement(Text, { key: "arrow", style: { color: '#5865F2', fontSize: 14 } }, "→")
                        ]
                    );
                    debugLog("INJECT", "Using TouchableOpacity");

                    // Return a wrapper that includes both the original and our button
                    return React.createElement(
                        View,
                        { key: "stalker-wrapper", style: { flex: 1 } },
                        [res, stalkerButton]
                    );
                } catch (e) {
                    debugLog("ERROR", `ChannelLongPress inject failed: ${e}`);
                    return res;
                }
            }));
            debugLog("PATCH", "✅ ChannelLongPress patched (v5.4 - wrapper)");
        } catch (e) { debugLog("ERROR", `ChannelLongPress patch failed: ${e}`); }
    }

    // Try to patch ProfileBanner if available
    if (ProfileBanner) {
        try {
            patches.push(after("default", ProfileBanner, (args, res) => {
                try {
                    const props = args[0];
                    const userId = props?.user?.id || props?.userId;

                    if (userId) {
                        debugLog("PROFILE", `ProfileBanner rendered: ${userId}`);
                    }
                } catch (e) {
                    debugLog("ERROR", `ProfileBanner read failed: ${e}`);
                }
                return res;
            }));
            debugLog("PATCH", "✅ ProfileBanner patched (monitoring)");
        } catch (e) { debugLog("ERROR", `ProfileBanner patch failed: ${e}`); }
    }

    // Try to patch UserProfileSection if available
    if (UserProfileSection) {
        try {
            patches.push(after("default", UserProfileSection, (args, res) => {
                try {
                    const props = args[0];
                    const userId = props?.user?.id || props?.userId;

                    if (userId) {
                        debugLog("PROFILE", `UserProfileSection rendered: ${userId}`);

                        // Try to add a section
                        if (res && res.props && res.props.children) {
                            const stalkerSection = React.createElement(
                                TouchableOpacity,
                                {
                                    key: "stalker-section",
                                    style: {
                                        backgroundColor: '#2b2d31',
                                        margin: 12,
                                        padding: 12,
                                        borderRadius: 8,
                                        flexDirection: 'row',
                                        alignItems: 'center',
                                    },
                                    onPress: () => {
                                        debugLog("ACTION", `Stalker pressed for user: ${userId}`);
                                        openDashboardWithContext('user', userId);
                                    }
                                },
                                [
                                    React.createElement(Text, { key: "icon", style: { fontSize: 16, marginRight: 8 } }, "🔍"),
                                    React.createElement(Text, { key: "text", style: { color: '#fff', fontSize: 14 } }, "Stalker Pro")
                                ]
                            );

                            const children = res.props.children;
                            if (Array.isArray(children)) {
                                children.push(stalkerSection);
                                debugLog("INJECT", "✅ Added section to profile");
                            }
                        }
                    }
                } catch (e) {
                    debugLog("ERROR", `UserProfileSection inject failed: ${e}`);
                }
                return res;
            }));
            debugLog("PATCH", "✅ UserProfileSection patched (with injection)");
        } catch (e) { debugLog("ERROR", `UserProfileSection patch failed: ${e}`); }
    }

    // Start clipboard monitor
    if (Clipboard?.getString) {
        clipboardMonitorActive = true;
        checkIntervalId = setInterval(checkClipboardContent, 2000);
        debugLog("LOAD", "✅ Clipboard monitor started");
    }

    debugLog("LOAD", `Total patches: ${patches.length}`);
    showToast("🔍 Stalker Pro v5.1-dev", getAssetIDByName("Check"));
};

export const onUnload = () => {
    debugLog("UNLOAD", "Cleaning up...");
    if (checkIntervalId) { clearInterval(checkIntervalId); checkIntervalId = null; }
    const patchCount = patches.length;
    for (const p of patches) { try { p(); } catch { } }
    patches = [];
    isActivelyScanning = false;
    isDashboardOpen = false;
    debugLog("UNLOAD", `Removed ${patchCount} patches`);
};

