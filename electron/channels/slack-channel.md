# Slack Channel

Connect a Slack workspace to Outworked so the agent can monitor channels and reply to messages.

## Before You Start

You'll need to create a Slack app and get a bot token.

### 1. Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click **Create New App** → **From scratch** → pick your workspace

### 2. Add Permissions

Go to **OAuth & Permissions** and add these **Bot Token Scopes**:

- `channels:history` — read messages in public channels
- `chat:write` — send messages
- `groups:history` — only needed for private channels

### 3. Install & Copy Token

1. Click **Install to Workspace** and authorize
2. Copy the **Bot User OAuth Token** — it starts with `xoxb-`

### 4. Invite the Bot

In Slack, go to each channel you want monitored and type:
```
/invite @YourBotName
```

### 5. Get Channel IDs

Right-click a channel name → **View channel details** → scroll to the bottom and copy the **Channel ID** (looks like `C07ABC1234`).

## Form Fields

- **Channel Name** — a display name for this channel (defaults to "Slack")
- **Bot Token** — your `xoxb-...` token (required)
- **Channel IDs** — comma-separated Slack channel IDs to monitor (required)
- **Bot User ID** — optional, auto-detected when you connect
- **System Instructions** — optional prompt that tells the agent how to respond on this channel

## How It Works

- Once connected, Outworked polls for new messages every 5 seconds
- It only picks up messages received **after** you connect — no history replay
- Thread replies are supported — the agent will reply in-thread when someone messages in a thread
- You can monitor multiple Slack channels with a single connection

## Tips

- Use **System Instructions** to control tone and format, e.g. "Keep replies under 2 sentences" or "Always respond in bullet points"
- You can create separate Slack channels in Outworked with different system instructions for different use cases

<details>
<summary>Developer Notes</summary>

### Registration

- Generates an ID like `slack-1711500000000`
- Calls `channel:register` IPC → `channel-manager.js:234-246`
- Creates a `SlackChannel` instance, wires up the inbound handler, saves config to SQLite

### Connection

- Calls `channel:connect` IPC → `SlackChannel.connect()` (`slack-channel.js:81-121`)
- Verifies the bot token via `auth.test`
- Auto-detects the bot's user ID (so it can filter its own messages)
- Seeds cursors to "now" (won't replay old history)
- Starts polling every 5 seconds

### Inbound Message Flow

- Poll finds new messages → `_pollChannel()` → `_emitInbound()`
- Channel manager persists to SQLite, pushes to renderer via `channel:inbound` IPC
- Trigger engine evaluates — if no trigger matches, fires a default prompt to the boss agent with the message content and a `send_message` instruction

### Outbound Message Flow

- Agent calls the `send_message` tool with `channelId` and `conversationId`
- Channel manager → `SlackChannel.sendMessage()` → `chat.postMessage` API
- Threads are supported: if the `conversationId` is `C1234:1234567890.123456`, it replies in-thread

### Key Implementation Details

- **Echo detection:** The channel manager tracks outbound messages for 30s to avoid processing them as inbound when the poll picks them up
- **Thread support:** Inbound thread replies get a `conversationId` of `CHANNEL_ID:THREAD_TS`, and outbound replies to that same ID will be threaded
- **Multiple channels:** Monitoring several Slack channels with one connection works by comma-separating the IDs in config
- **System instructions:** Get prepended to the agent's prompt when handling messages on this channel

</details>
