# Stalker Pro (Revenge/Vendetta Version)

A Revenge/Vendetta plugin for Discord Mobile that adds user activity tracking features.

## Features

### 🔍 Recent Messages
- Find a user's recent messages across all mutual servers
- Shows server icon, channel name, and relative time
- Click to jump directly to the message

### 🔒 Hidden Channels
- See which hidden channels a user can access (but you can't)
- Dropdown to select different mutual servers
- View channel types (text, voice, announcements, etc.)

## Installation

### Method 1: Direct URL (Recommended)

1. Open Revenge/Vendetta on your device
2. Go to Settings → Plugins
3. Tap the **+** button
4. Enter this URL:

```
https://raw.githubusercontent.com/YOUR_USERNAME/StalkerProRevenge/main/
```

Replace `YOUR_USERNAME` with your GitHub username after uploading.

### Method 2: From Source

1. Clone/download this repository
2. Upload to your GitHub
3. Follow Method 1 with your GitHub URL

## Usage

1. Open Discord on your device
2. Tap on any user's profile (long press on avatar)
3. Scroll down to see the **"🔍 Stalker Pro"** section
4. Tap **"Recent Messages"** to find their latest messages
5. Tap **"Hidden Channels"** to see channels they can access

## Project Structure

```
StalkerProRevenge/
├── manifest.json           # Plugin metadata
├── src/
│   ├── index.ts           # Main plugin entry point
│   ├── components/
│   │   ├── StalkerSection.tsx       # Main UI section
│   │   ├── RecentMessagesSheet.tsx  # Recent messages view
│   │   ├── HiddenChannelsSheet.tsx  # Hidden channels view
│   │   └── index.ts                 # Component exports
│   └── utils/
│       ├── messageSearcher.ts       # Message search logic
│       ├── channelChecker.ts        # Permission checking
│       └── index.ts                 # Utility exports
└── README.md
```

## How It Works

### Recent Messages
- Iterates through all mutual guilds with the target user
- Searches cached messages in each channel
- Sorts by timestamp and displays newest first
- Click to navigate directly to the message

### Hidden Channels
- Compares permission overwrites between you and target user
- Identifies channels where:
  - Target user has VIEW_CHANNEL permission
  - You don't have VIEW_CHANNEL permission
- Shows channel type icons for easy identification

## Technical Details

- Built for Revenge/Vendetta Discord mod
- Uses React Native components
- Integrates with Discord's internal stores:
  - `UserStore` - User data
  - `GuildStore` - Server data
  - `ChannelStore` - Channel data
  - `MessageStore` - Message cache
  - `PermissionStore` - Permission data
  - `GuildMemberStore` - Member roles

## GitHub Setup for Plugin URL

1. Create a new GitHub repository
2. Upload all files from this folder
3. Go to repository Settings → Pages
4. Enable GitHub Pages (optional, for hosting)
5. Your plugin URL will be:
   ```
   https://raw.githubusercontent.com/<username>/<repo>/main/
   ```

## Disclaimer

⚠️ **Educational purposes only.** Using Discord mods violates Discord's Terms of Service. Use at your own risk.

## License

MIT License - Feel free to modify and redistribute.

---

## Quick Setup

```bash
# 1. Create GitHub repo named "StalkerProRevenge"

# 2. Upload these files to the repo

# 3. In Revenge/Vendetta:
#    Settings → Plugins → + → Enter URL:
#    https://raw.githubusercontent.com/YOUR_USERNAME/StalkerProRevenge/main/
```

**That's it! The plugin will be installed and ready to use.**
