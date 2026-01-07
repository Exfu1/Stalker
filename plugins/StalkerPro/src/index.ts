import { logger } from "@vendetta";
import { findByStoreName, findByProps, findByName, findByDisplayName } from "@vendetta/metro";
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

// Create the Stalker Section component
function StalkerSection({ userId }: { userId: string }) {
    const mutualGuilds = getMutualGuilds(userId);

    return React.createElement(
        FormSection,
        { title: "🔍 Stalker Pro" },
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
}

export const onLoad = () => {
    try {
        showToast("Stalker Pro: Starting...", getAssetIDByName("Check"));
        logger.log("Stalker Pro: Starting initialization");

        // Try multiple approaches to find the right component to patch

        // Approach 1: Try findByDisplayName for common profile component names
        const displayNames = [
            "UserProfileSection",
            "UserProfileBody",
            "UserProfileHeader",
            "UserProfile",
            "ProfileBanner",
            "UserSheet",
            "UserProfileSheet",
            "UserProfileBio",
            "UserProfileCard",
            "SimplifiedUserProfileBody",
            "UserProfileBodyMobile"
        ];

        let ProfileComponent: any = null;
        let foundDisplayName: string | null = null;

        for (const name of displayNames) {
            try {
                const comp = findByDisplayName(name, false);
                if (comp) {
                    ProfileComponent = comp;
                    foundDisplayName = name;
                    logger.log(`Found component by display name: ${name}`);
                    break;
                }
            } catch (e) {
                // Continue
            }
        }

        // Approach 2: If display name didn't work, try findByName
        if (!ProfileComponent) {
            for (const name of displayNames) {
                try {
                    const comp = findByName(name, false);
                    if (comp) {
                        ProfileComponent = comp;
                        foundDisplayName = name;
                        logger.log(`Found component by name: ${name}`);
                        break;
                    }
                } catch (e) {
                    // Continue
                }
            }
        }

        // Approach 3: Try findByProps for known profile module patterns
        if (!ProfileComponent) {
            const propPatterns = [
                ["UserProfileSection"],
                ["UserProfileBody"],
                ["default", "UserProfileSection"],
                ["default", "UserProfileBody"],
                ["UserSheet"],
            ];

            for (const props of propPatterns) {
                try {
                    const mod = findByProps(...props);
                    if (mod) {
                        // Get the actual component
                        ProfileComponent = mod.default || mod[props[props.length - 1]] || mod;
                        foundDisplayName = props.join(".");
                        logger.log(`Found module by props: ${props.join(", ")}`);
                        break;
                    }
                } catch (e) {
                    // Continue
                }
            }
        }

        if (!ProfileComponent) {
            showToast("Stalker Pro: No profile component found!", getAssetIDByName("Small"));
            logger.error("Could not find any profile component to patch");
            return;
        }

        showToast(`Stalker Pro: Found ${foundDisplayName}`, getAssetIDByName("Check"));
        logger.log(`Profile component type: ${typeof ProfileComponent}`);
        logger.log(`Profile component keys: ${Object.keys(ProfileComponent || {}).slice(0, 10).join(", ")}`);

        // Try to patch the component
        if (typeof ProfileComponent === "function") {
            // It's a function component or class component
            logger.log("Patching function component directly");

            const originalComponent = ProfileComponent;

            // We need to wrap it instead of patching 'default'
            // This approach patches the render output
            patches.push(
                after("type", { type: ProfileComponent }, (args: any[], res: any) => {
                    logger.log("Stalker Pro: Patch callback triggered!");
                    return patchProfileResult(args, res);
                })
            );
        } else if (ProfileComponent.default && typeof ProfileComponent.default === "function") {
            // It has a default export
            logger.log("Patching default export");

            patches.push(
                after("default", ProfileComponent, (args: any[], res: any) => {
                    logger.log("Stalker Pro: Default patch callback triggered!");
                    return patchProfileResult(args, res);
                })
            );
        } else if (ProfileComponent.render && typeof ProfileComponent.render === "function") {
            // Class component with render method
            logger.log("Patching render method");

            patches.push(
                after("render", ProfileComponent.prototype || ProfileComponent, (args: any[], res: any) => {
                    logger.log("Stalker Pro: Render patch callback triggered!");
                    return patchProfileResult(args, res);
                })
            );
        } else {
            // Try patching any function property we find
            const funcProps = Object.keys(ProfileComponent).filter(
                k => typeof ProfileComponent[k] === "function"
            );
            logger.log(`Function properties found: ${funcProps.join(", ")}`);

            if (funcProps.length > 0) {
                const propToPatch = funcProps[0];
                logger.log(`Patching first function property: ${propToPatch}`);

                patches.push(
                    after(propToPatch, ProfileComponent, (args: any[], res: any) => {
                        logger.log(`Stalker Pro: ${propToPatch} patch callback triggered!`);
                        return patchProfileResult(args, res);
                    })
                );
            } else {
                showToast("Stalker Pro: No patchable function found!", getAssetIDByName("Small"));
                logger.error("Component has no function properties to patch");
                return;
            }
        }

        showToast("Stalker Pro loaded!", getAssetIDByName("Check"));
        logger.log("Stalker Pro plugin loaded and patches applied");

    } catch (e: any) {
        showToast("Stalker Pro: Error!", getAssetIDByName("Small"));
        logger.error("Stalker Pro load error:", e?.message || e);
    }
};

function patchProfileResult(args: any[], res: any) {
    try {
        // Try to extract userId from various possible locations
        const userId =
            args[0]?.userId ||
            args[0]?.user?.id ||
            args[0]?.props?.userId ||
            args[0]?.props?.user?.id ||
            (typeof args[0] === "string" ? args[0] : null);

        logger.log("patchProfileResult called with userId:", userId);

        if (!userId) {
            logger.log("No userId found in args:", JSON.stringify(args[0])?.substring(0, 200));
            return res;
        }

        // Don't show for yourself
        const currentUser = UserStore?.getCurrentUser();
        if (currentUser && userId === currentUser.id) {
            logger.log("Skipping own profile");
            return res;
        }

        // Try to inject our section
        if (res?.props?.children && Array.isArray(res.props.children)) {
            logger.log("Injecting into res.props.children array");
            res.props.children.push(
                React.createElement(StalkerSection, { key: "stalker-pro", userId })
            );
            logger.log("Stalker section successfully injected!");
        } else if (res?.props?.children) {
            // Children exists but isn't an array - wrap it
            logger.log("Wrapping non-array children");
            const existingChildren = res.props.children;
            res.props.children = [
                existingChildren,
                React.createElement(StalkerSection, { key: "stalker-pro", userId })
            ];
            logger.log("Stalker section injected by wrapping!");
        } else if (res?.type?.render || res?.type) {
            // Try to inject at the element level
            logger.log("Result structure:", Object.keys(res || {}).join(", "));
        } else {
            logger.log("Cannot inject - unexpected result structure");
            logger.log("Result type:", typeof res);
            logger.log("Result keys:", Object.keys(res || {}).slice(0, 5).join(", "));
        }
    } catch (e: any) {
        logger.error("Error in patchProfileResult:", e?.message || e);
    }

    return res;
}

export const onUnload = () => {
    // Cleanup all patches
    for (const unpatch of patches) {
        unpatch?.();
    }
    patches = [];
    logger.log("Stalker Pro plugin unloaded");
};
