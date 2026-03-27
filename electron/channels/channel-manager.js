// ─── Channel Manager ─────────────────────────────────────────────
// Main-process singleton that owns channel lifecycle, routes outbound
// messages, persists all traffic to SQLite, and bridges inbound events
// to the renderer via IPC.

const path = require("path");
const fs = require("fs");
const db = require("../db/database");
const verbose = process.env.VERBOSE_LOGGING === "true";

/** @type {Map<string, import('./base-channel')>} id → channel instance */
const _registry = new Map();

/** @type {Electron.WebContents | null} */
let _mainWindowContents = null;

/** @type {(() => void) | null} */
let _onStatusChange = null;

/**
 * Track recently sent outbound messages so we can ignore them if they
 * echo back as "inbound" (e.g. iMessage DB race conditions).
 * Key: "channelId:conversationId:contentFingerprint"
 * Value: { expiry: number, count: number, content: string }
 * @type {Map<string, { expiry: number, count: number, content: string }>}
 */
const _recentOutbound = new Map();
const OUTBOUND_ECHO_WINDOW_MS = 30_000; // 30 seconds

/**
 * Track per-conversation recent sends for fuzzy echo detection.
 * Keyed by normalizedConversationId ONLY (no channelId) so that echoes
 * arriving on a different channel than the one used to send are still caught.
 * Key: normalizedConversationId
 * Value: { expiry: number, contents: string[] }
 * @type {Map<string, { expiry: number, contents: string[] }>}
 */
const _recentConversationSends = new Map();

// ─── Registry management ──────────────────────────────────────

/**
 * Register a channel instance with the manager.
 * Does NOT automatically connect it — call connectChannel() separately.
 *
 * @param {import('./base-channel')} channel
 */
function registerChannel(channel) {
  if (_registry.has(channel.id)) {
    console.warn(
      `[ChannelManager] Channel '${channel.id}' is already registered; replacing.`,
    );
  }

  // Wire up inbound message handling before we register.
  channel.onMessage((msg) => _handleInbound(channel.id, msg));

  _registry.set(channel.id, channel);
}

/**
 * Return all registered channel instances as an array.
 *
 * @returns {import('./base-channel')[]}
 */
function getChannels() {
  return Array.from(_registry.values());
}

/**
 * Unregister a channel, disconnecting it first if needed, and remove
 * its config from the database.
 *
 * @param {string} id
 * @returns {Promise<void>}
 */
async function removeChannel(id) {
  const channel = _registry.get(id);
  if (channel) {
    try {
      await channel.disconnect();
    } catch {
      /* best-effort */
    }
    _registry.delete(id);
  }
  try {
    db.channelConfigDelete(id);
  } catch {
    /* may already be gone */
  }
  _onStatusChange?.();
}

// ─── Lifecycle ────────────────────────────────────────────────

/**
 * Connect a registered channel by ID.
 * Updates the channel_configs row in SQLite to reflect the new status.
 *
 * @param {string} id
 * @returns {Promise<void>}
 */
async function connectChannel(id) {
  const channel = _getOrThrow(id);

  try {
    await channel.connect();
    _persistStatus(channel);
    _onStatusChange?.();
    verbose &&
      console.log(
        `[ChannelManager] Connected channel '${id}' (${channel.type})`,
      );
  } catch (err) {
    channel.status = "error";
    channel.errorMessage = err.message;
    _persistStatus(channel);
    _onStatusChange?.();
    console.error(
      `[ChannelManager] Failed to connect channel '${id}': ${err.message}`,
    );
    throw err;
  }
}

/**
 * Disconnect a registered channel by ID.
 *
 * @param {string} id
 * @returns {Promise<void>}
 */
async function disconnectChannel(id) {
  const channel = _getOrThrow(id);
  await channel.disconnect();
  _persistStatus(channel);
  _onStatusChange?.();
  verbose && console.log(`[ChannelManager] Disconnected channel '${id}'`);
}

// ─── Outbound messaging ───────────────────────────────────────

/**
 * Send a message via the specified channel and persist it as an outbound
 * record in channel_messages.
 *
 * @param {string} channelId
 * @param {string} conversationId
 * @param {string} content
 * @returns {Promise<void>}
 */
async function sendMessage(channelId, conversationId, content) {
  const channel = _getOrThrow(channelId);

  if (channel.status !== "connected") {
    throw new Error(
      `Channel '${channelId}' is not connected (status: ${channel.status})`,
    );
  }

  await channel.sendMessage(conversationId, content);

  // Track this outbound so we can detect echo-back in inbound polling
  const normalized = _normalizeForEcho(content);
  const echoKey = _buildEchoKey(channelId, conversationId, content);
  const existing = _recentOutbound.get(echoKey);
  if (existing && Date.now() < existing.expiry) {
    existing.count += 1;
    existing.expiry = Date.now() + OUTBOUND_ECHO_WINDOW_MS;
  } else {
    _recentOutbound.set(echoKey, {
      expiry: Date.now() + OUTBOUND_ECHO_WINDOW_MS,
      count: 1,
      content: normalized,
    });
  }

  // Also track per-conversation sends for fuzzy echo detection
  const convKey = _buildConversationKey(channelId, conversationId);
  const convEntry = _recentConversationSends.get(convKey);
  if (convEntry && Date.now() < convEntry.expiry) {
    convEntry.contents.push(normalized);
    convEntry.expiry = Date.now() + OUTBOUND_ECHO_WINDOW_MS;
  } else {
    _recentConversationSends.set(convKey, {
      expiry: Date.now() + OUTBOUND_ECHO_WINDOW_MS,
      contents: [normalized],
    });
  }

  // Persist the outbound record.
  db.channelMessageSave({
    channelId,
    direction: "outbound",
    conversationId,
    sender: null,
    content,
    metadata: {},
    timestamp: Date.now(),
  });
}

// ─── IPC bridge ───────────────────────────────────────────────

/**
 * Register all channel-manager IPC handlers and store a reference to the
 * main window's webContents for push notifications.
 *
 * Call this from main.js after the main window has been created.
 *
 * Exposes:
 *   channel:register    — create + register a channel from a saved ChannelConfig
 *   channel:connect     — connect by id
 *   channel:disconnect  — disconnect by id
 *   channel:send        — send an outbound message
 *   channel:list        — return all registered channel summaries
 *   channel:loadAll     — load all saved configs from DB and register them
 *
 * @param {Electron.IpcMain}     ipcMain
 * @param {Electron.BrowserWindow} mainWindow
 */
function setupChannelIPC(ipcMain, mainWindow) {
  _mainWindowContents = mainWindow.webContents;

  const { getChannelClasses, getAvailableTypes } = require("./index");

  // ── channel:types ─────────────────────────────────────────────
  // Return metadata for all discovered channel types so the UI can
  // build add-channel forms dynamically.
  ipcMain.handle("channel:types", () => {
    return getAvailableTypes();
  });

  // ── channel:docs ───────────────────────────────────────────────
  // Return the setup documentation markdown for a channel type.
  ipcMain.handle("channel:docs", (_event, type) => {
    const mdPath = path.join(__dirname, `${type}-channel.md`);
    try {
      return fs.readFileSync(mdPath, "utf-8");
    } catch {
      return null;
    }
  });

  // ── channel:register ──────────────────────────────────────────
  // Create a channel instance from a ChannelConfig object and register it.
  ipcMain.handle("channel:register", (_event, config) => {
    const channel = _buildChannel(config, getChannelClasses());
    registerChannel(channel);
    // Persist to DB so it survives restarts.
    db.channelConfigSave({
      id: config.id,
      type: config.type,
      name: config.name,
      config: config.config || {},
      status: "disconnected",
    });
    return { ok: true };
  });

  // ── channel:remove ──────────────────────────────────────────
  ipcMain.handle("channel:remove", async (_event, id) => {
    try {
      await removeChannel(id);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── channel:connect ───────────────────────────────────────────
  ipcMain.handle("channel:connect", async (_event, id) => {
    try {
      await connectChannel(id);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── channel:disconnect ────────────────────────────────────────
  ipcMain.handle("channel:disconnect", async (_event, id) => {
    try {
      await disconnectChannel(id);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── channel:send ──────────────────────────────────────────────
  ipcMain.handle(
    "channel:send",
    async (_event, channelId, conversationId, content) => {
      try {
        await sendMessage(channelId, conversationId, content);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
  );

  // ── channel:list ──────────────────────────────────────────────
  ipcMain.handle("channel:list", () => {
    return getChannels().map((ch) => ({
      id: ch.id,
      type: ch.type,
      name: ch.name,
      config: ch.config || {},
      status: ch.status,
      errorMessage: ch.errorMessage || null,
    }));
  });

  // ── channel:update ──────────────────────────────────────────
  // Update a channel's name and/or config.  Disconnects, rebuilds,
  // and re-registers the instance so the new config takes effect.
  ipcMain.handle("channel:update", async (_event, { id, name, config }) => {
    try {
      const existing = _registry.get(id);
      if (!existing) return { ok: false, error: `Channel '${id}' not found` };

      const wasConnected = existing.status === "connected";

      // Disconnect the old instance
      try {
        await existing.disconnect();
      } catch {
        /* best-effort */
      }
      _registry.delete(id);

      // Persist updated config
      const updatedName = name || existing.name;
      const updatedConfig = config ?? existing.config;
      db.channelConfigSave({
        id,
        type: existing.type,
        name: updatedName,
        config: updatedConfig,
        status: "disconnected",
      });

      // Rebuild and re-register
      const classes = getChannelClasses();
      const newChannel = _buildChannel(
        { id, type: existing.type, name: updatedName, config: updatedConfig },
        classes,
      );
      registerChannel(newChannel);

      // Reconnect if it was connected before
      if (wasConnected) {
        await connectChannel(id);
      }

      _onStatusChange?.();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── channel:loadAll ───────────────────────────────────────────
  // Load all persisted ChannelConfig rows and register (but don't connect)
  // the corresponding channel instances.  Useful on app startup.
  ipcMain.handle("channel:loadAll", () => {
    const classes = getChannelClasses();
    const configs = db.channelConfigList();
    for (const config of configs) {
      if (!_registry.has(config.id)) {
        try {
          const channel = _buildChannel(config, classes);
          registerChannel(channel);
        } catch (err) {
          console.error(
            `[ChannelManager] Could not build channel '${config.id}': ${err.message}`,
          );
        }
      }
    }
    return { ok: true, count: configs.length };
  });
}

// ─── Private helpers ──────────────────────────────────────────

/**
 * Handle an inbound message from any channel:
 *   1. Persist it to channel_messages.
 *   2. Push it to the renderer over the 'channel:inbound' IPC event.
 *
 * @param {string} channelId
 * @param {object} msg
 */
function _handleInbound(channelId, msg) {
  const full = {
    channelId,
    direction: "inbound",
    conversationId: msg.conversationId || null,
    sender: msg.sender || null,
    content: msg.content,
    metadata: msg.metadata || {},
    timestamp: msg.timestamp || Date.now(),
  };

  // ── Echo detection: skip messages that match a recent outbound ──
  _pruneExpiredOutbound();
  const inboundNormalized = _normalizeForEcho(full.content);

  // 1. Exact hash match (fast path)
  const echoKey = _buildEchoKey(
    channelId,
    full.conversationId || "",
    full.content,
  );
  const tracked = _recentOutbound.get(echoKey);
  if (tracked) {
    console.log(
      `[ChannelManager] Skipping echo-back (exact): ${echoKey} (remaining: ${tracked.count - 1})`,
    );
    tracked.count -= 1;
    if (tracked.count <= 0) {
      _recentOutbound.delete(echoKey);
    }
    return;
  }

  // 2. Fuzzy match: check all recent outbound to this conversation
  //    Catches platform reformatting (smart quotes, link expansion, etc.)
  const convKey = _buildConversationKey(channelId, full.conversationId || "");
  const convSends = _recentConversationSends.get(convKey);
  if (convSends && Date.now() < convSends.expiry) {
    const matchIdx = convSends.contents.findIndex((sent) =>
      _isEchoMatch(sent, inboundNormalized),
    );
    if (matchIdx !== -1) {
      console.log(
        `[ChannelManager] Skipping echo-back (fuzzy) for conversation ${convKey}`,
      );
      convSends.contents.splice(matchIdx, 1);
      if (convSends.contents.length === 0) {
        _recentConversationSends.delete(convKey);
      }
      return;
    }
  }

  // ── Sender allowlist: drop messages from unknown senders ──
  const channel = _registry.get(channelId);
  const allowedSenders = channel?.config?.allowedSenders;
  if (Array.isArray(allowedSenders) && allowedSenders.length > 0) {
    const hasWildcard = allowedSenders.includes("*");
    if (!hasWildcard && full.sender) {
      const senderNorm = full.sender.replace(/[\s\-()]/g, "");
      const isAllowed = allowedSenders.some((s) => {
        const norm = s.replace(/[\s\-()]/g, "");
        return (
          senderNorm === norm ||
          senderNorm.endsWith(norm) ||
          norm.endsWith(senderNorm)
        );
      });
      if (!isAllowed) {
        verbose &&
          console.log(
            `[ChannelManager] Blocked message from ${full.sender} — not in allowedSenders`,
          );
        return;
      }
    }
  }

  // ── Fallthrough: wildcard channels yield to more-specific siblings ──
  // If this channel has no allowlist (catch-all) or a wildcard entry, check
  // whether a sibling channel of the same type has a specific allowlist that
  // includes this sender.  If so, let the specific channel handle it.
  if (channel && full.sender) {
    const myAllowed = channel.config?.allowedSenders;
    const isCatchAll =
      !Array.isArray(myAllowed) ||
      myAllowed.length === 0 ||
      myAllowed.includes("*");

    if (isCatchAll) {
      const senderNorm = full.sender.replace(/[\s\-()]/g, "");
      for (const [otherId, other] of _registry) {
        if (otherId === channelId || other.type !== channel.type) continue;
        const otherAllowed = other.config?.allowedSenders;
        if (!Array.isArray(otherAllowed) || otherAllowed.length === 0) continue;
        if (otherAllowed.includes("*")) continue;

        const claimedByOther = otherAllowed.some((s) => {
          const norm = s.replace(/[\s\-()]/g, "");
          return (
            senderNorm === norm ||
            senderNorm.endsWith(norm) ||
            norm.endsWith(senderNorm)
          );
        });
        if (claimedByOther) {
          verbose &&
            console.log(
              `[ChannelManager] Fallthrough: ${channelId} yielding to ${otherId} for sender ${full.sender}`,
            );
          return;
        }
      }
    }
  }

  // Persist
  try {
    db.channelMessageSave(full);
  } catch (err) {
    console.error(
      `[ChannelManager] Failed to persist inbound message: ${err.message}`,
    );
  }

  // Push to renderer
  if (_mainWindowContents && !_mainWindowContents.isDestroyed()) {
    _mainWindowContents.send("channel:inbound", full);
  }

  // Evaluate against triggers — if no trigger matches, fire to boss as default
  try {
    const triggerEngine = require("../triggers/trigger-engine");
    const matched = triggerEngine.evaluateMessage(full);
    if (!matched && _mainWindowContents && !_mainWindowContents.isDestroyed()) {
      // No trigger matched — send a default trigger:fire to the boss
      const chan = _registry.get(channelId);
      const sysInstructions = chan?.config?.systemInstructions;

      const instructions = sysInstructions
        ? `## Channel Instructions\nFollow these instructions when replying via send_message on this channel:\n${sysInstructions}`
        : `## Channel Instructions\nNo specific instructions are configured for this channel. Reply naturally and helpfully to the message.`;

      let prompt =
        `${instructions}\n\n` +
        `You received a message via ${chan?.type || "messaging channel"}.\n\n` +
        `From: ${full.sender || "unknown"}\n` +
        `Channel: ${channelId}\n` +
        `Conversation: ${full.conversationId || "unknown"}\n\n` +
        `Message:\n${full.content}\n\n` +
        `You MUST reply using the send_message tool with channelId="${channelId}" and conversationId="${full.conversationId || full.sender}".\n\n` +
        `## Reply Protocol\n` +
        `1. FIRST, send a brief confirmation message acknowledging you received the message (e.g. "Got it, looking into this now." or "On it, one moment."). This lets the sender know their message was received.\n` +
        `2. THEN, process the request and send your full reply with the actual response.\n` +
        `Keep the confirmation short and natural — do not repeat the sender's message back to them.`;

      _mainWindowContents.send("trigger:fire", {
        triggerId: "__default_channel_message",
        triggerName: "Channel Message (default)",
        agentId: null, // null signals "use the boss"
        prompt,
        context: full,
      });
    }
  } catch (err) {
    console.error(`[ChannelManager] Trigger evaluation failed: ${err.message}`);
  }
}

/**
 * Persist the current status of a channel back to channel_configs.
 *
 * @param {import('./base-channel')} channel
 */
function _persistStatus(channel) {
  try {
    db.channelConfigSave({
      id: channel.id,
      type: channel.type,
      name: channel.name,
      config: channel.config || {},
      status: channel.status,
    });
  } catch (err) {
    console.error(
      `[ChannelManager] Failed to persist status for '${channel.id}': ${err.message}`,
    );
  }
}

/**
 * Retrieve a registered channel or throw a descriptive error.
 *
 * @param {string} id
 * @returns {import('./base-channel')}
 */
function _getOrThrow(id) {
  const channel = _registry.get(id);
  if (!channel) {
    throw new Error(
      `Channel '${id}' is not registered. Call registerChannel() or channel:loadAll first.`,
    );
  }
  return channel;
}

/**
 * Instantiate the correct BaseChannel subclass for a given ChannelConfig.
 *
 * @param {object} config
 * @param {Map<string, typeof import('./base-channel')>} classes - type → ChannelClass map
 * @returns {import('./base-channel')}
 */
function _buildChannel(config, classes) {
  const ChannelClass = classes.get(config.type);
  if (!ChannelClass) {
    throw new Error(`Unknown channel type: '${config.type}'`);
  }
  return new ChannelClass(config.id, config.name, config.config || {});
}

// ─── Helpers ──────────────────────────────────────────────────

/**
 * Normalise message text for echo comparison.
 * Collapses whitespace, trims, and lowercases so that platform-introduced
 * differences (e.g. AppleScript newline escaping, Slack mrkdwn) don't
 * cause a false-negative on the echo check.
 */
function _normalizeForEcho(text) {
  return (text || "")
    .replace(/\\n/g, "\n") // treat literal "\n" same as newline
    .replace(/\s+/g, " ") // collapse all whitespace runs
    .trim()
    .toLowerCase()
    .slice(0, 500); // cap to keep keys bounded
}

/**
 * Build a deterministic echo key from channel, conversation, and content.
 * Uses FNV-1a (32-bit) for a better distribution than the old djb2 variant,
 * and hashes normalised content so platform whitespace differences don't
 * break detection.
 */
function _buildEchoKey(channelId, conversationId, content) {
  const normalized = _normalizeForEcho(content);
  return `${channelId}:${_normalizeConversationId(conversationId)}:${_fnv1a(normalized)}`;
}

/** FNV-1a 32-bit hash — better collision resistance than djb2. */
function _fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) | 0;
  }
  return (hash >>> 0).toString(36);
}

/** Remove expired entries from the outbound echo tracker. */
function _pruneExpiredOutbound() {
  const now = Date.now();
  for (const [key, entry] of _recentOutbound) {
    if (now > entry.expiry) _recentOutbound.delete(key);
  }
  for (const [key, entry] of _recentConversationSends) {
    if (now > entry.expiry) _recentConversationSends.delete(key);
  }
}

/**
 * Normalise a conversationId for echo key matching.
 * Strips whitespace, dashes, parens, and lowercases so that phone number
 * format differences (e.g. "+1 555-550-0100" vs "+15555500100") don't
 * cause false negatives.
 */
function _normalizeConversationId(id) {
  return (id || "").replace(/[\s\-()\.]/g, "").toLowerCase();
}

/**
 * Build a conversation-level key for tracking recent sends.
 * Intentionally omits channelId so cross-channel echoes are caught
 * (e.g. agent sends via channel A, echo arrives on channel B).
 */
function _buildConversationKey(_channelId, conversationId) {
  return _normalizeConversationId(conversationId);
}

/**
 * Check if an inbound message is a fuzzy echo of a sent message.
 * Handles platform reformatting like smart quotes, link cards, emoji
 * substitution, and trailing whitespace differences.
 *
 * @param {string} sent      - Normalised outbound content
 * @param {string} received  - Normalised inbound content
 * @returns {boolean}
 */
function _isEchoMatch(sent, received) {
  // Exact match after normalization
  if (sent === received) return true;

  // Prefix match: platform may truncate or append to messages
  if (
    sent.length > 10 &&
    (received.startsWith(sent) || sent.startsWith(received))
  ) {
    return true;
  }

  // Strip all non-alphanumeric and compare (catches smart quotes, unicode subs)
  const alphaOnly = (s) => s.replace(/[^a-z0-9]/g, "");
  if (alphaOnly(sent) === alphaOnly(received) && alphaOnly(sent).length > 5) {
    return true;
  }

  // Levenshtein similarity: if > 85% similar by character, treat as echo
  if (sent.length > 10 && received.length > 10) {
    const similarity = _similarity(sent, received);
    if (similarity > 0.85) return true;
  }

  return false;
}

/**
 * Fast Levenshtein-based similarity ratio (0..1).
 * Bails early if the lengths are too different to ever reach the threshold.
 */
function _similarity(a, b) {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;

  // Quick bail: if length ratio is already below threshold, skip expensive calc
  const minLen = Math.min(a.length, b.length);
  if (minLen / maxLen < 0.7) return minLen / maxLen;

  // Use a single-row DP for space efficiency
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const val = Math.min(row[j] + 1, prev + 1, row[j - 1] + cost);
      row[j - 1] = prev;
      prev = val;
    }
    row[b.length] = prev;
  }

  return 1 - row[b.length] / maxLen;
}

// ─── Exports ──────────────────────────────────────────────────

/**
 * Set a callback invoked whenever a channel's connection status changes.
 * @param {() => void} fn
 */
function setOnStatusChange(fn) {
  _onStatusChange = fn;
}

module.exports = {
  registerChannel,
  removeChannel,
  connectChannel,
  disconnectChannel,
  sendMessage,
  getChannels,
  setupChannelIPC,
  setOnStatusChange,
};
