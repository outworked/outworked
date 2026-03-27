# iMessage Channel

Connect your Mac's iMessage to Outworked so the agent can read and reply to your text messages.

## Before You Start

iMessage integration requires **Full Disk Access** on macOS. No API keys or third-party accounts needed.

1. Open **System Settings** → **Privacy & Security** → **Full Disk Access**
2. Toggle **on** for Outworked
3. Restart the app if prompted

## Form Fields

- **Channel Name** — a display name for this channel (defaults to "iMessage")
- **Allowed Senders** — comma-separated phone numbers or emails, e.g. `+15555550100, jane@example.com`. Leave empty to allow messages from everyone.
- **Your iMessage Email Handles** — your own email address(es). Only needed if you want to message yourself as a way to talk to the agent.
- **System Instructions** — optional prompt that tells the agent how to respond on this channel

## How It Works

- Once connected, Outworked polls for new iMessages every 5 seconds
- It only picks up messages received **after** you connect — it won't replay your history
- The agent can reply to both 1:1 and group chats
- If you set **Allowed Senders**, only messages from those contacts are processed (phone number formatting is normalized automatically)

## Tips

- You can create multiple iMessage channels with different allowed senders and different system instructions — great for handling work vs. personal contacts differently
- If a contact matches a specific channel, it won't also trigger a catch-all channel

<details>
<summary>Developer Notes</summary>

### Registration

- Generates an ID like `imessage-1711500000000`
- Creates an `ImessageChannel` instance, saves config to SQLite

### Connection

- Checks `process.platform === "darwin"` — errors on non-Mac
- Queries `SELECT MAX(ROWID) FROM message` to verify DB access
- If this is the first connect (`lastMessageId === 0`), sets the cursor to the current max ROWID so it won't replay history
- If the DB query fails with "authorization denied", throws a clear error pointing to Full Disk Access settings
- Starts polling every 5 seconds

### Inbound Message Flow

- Poll query joins `message → handle → chat` tables, fetching rows where `ROWID > lastMessageId` and `is_from_me = 0`
- If `selfHandles` is configured, also picks up `is_from_me = 1` rows where the handle matches your own email — this is how self-messaging works
- Converts Apple's Core Data timestamps (seconds or nanoseconds since 2001-01-01) to Unix ms
- Detects group chats via `chat_style = 43` — uses the full chat GUID (e.g. `iMessage;+;chat123456`) as the `conversationId`
- For 1:1 chats, uses the sender's phone/email as the `conversationId`
- Emits to channel manager → persisted to SQLite → pushed to renderer → trigger engine evaluates

### Outbound Message Flow

- Agent calls `send_message` with the `conversationId` (phone number, email, or group chat GUID)
- Content is sanitized against AppleScript injection (escapes backslashes, quotes, newlines)
- Group chats: `tell application "Messages" to send "..." to chat id "iMessage;+;chat123456"`
- 1:1 chats: `tell application "Messages" to send "..." to buddy "+15555550100" of (get first service whose service type = iMessage)`

### Echo Prevention (self-messaging)

iMessage creates a received copy when you message yourself:

1. **Send-time cursor bump:** After sending, the channel retries up to 3 times (300ms, 600ms, 900ms delays) to re-read `MAX(ROWID)` and advance `lastMessageId` past any rows the send created (`imessage-channel.js:164-182`)
2. **Polling pause:** While a send is in flight (`this._sending = true`), polling is skipped entirely (`imessage-channel.js:196`)
3. **Channel manager fallback:** The content-hash echo detection in `channel-manager.js` catches anything that slips through

### Allowed Senders Filtering

This happens at the channel manager level (`channel-manager.js:437-498`), not in the iMessage channel itself:

- If `allowedSenders` has entries, only messages from those senders are processed
- Normalizes phone formatting (`+1 555-550-0100` matches `+15555500100`)
- Wildcard channels yield to specific ones: if you have two iMessage channels — one with specific senders and one catch-all — the catch-all won't process messages that belong to the specific channel

</details>
