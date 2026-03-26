// ─── Slack Channel ────────────────────────────────────────────────
// Polls the Slack Web API for new messages and sends replies via
// chat.postMessage.  Uses raw Node.js https — no Bolt SDK required.

const https = require("https");
const BaseChannel = require("./base-channel");

// How often to poll each monitored channel (milliseconds).
const POLL_INTERVAL_MS = 5000;

// Maximum messages to fetch per poll request.
const MESSAGES_PER_PAGE = 50;

class SlackChannel extends BaseChannel {
  static get metadata() {
    return {
      type: "slack",
      label: "Slack",
      color: "purple",
      description:
        "Polls Slack channels via the Web API and sends replies via chat.postMessage. Requires a bot token with channels:history and chat:write scopes.",
      fields: [
        {
          key: "botToken",
          label: "Bot Token",
          type: "password",
          placeholder: "xoxb-...",
          required: true,
        },
        {
          key: "channelIds",
          label: "Channel IDs",
          type: "text",
          placeholder: "C01234567, C09876543",
          hint: "Comma-separated Slack channel IDs to monitor.",
          required: true,
          isList: true,
        },
        {
          key: "appUserId",
          label: "Bot User ID",
          type: "text",
          placeholder: "U01234567",
          hint: "Optional — auto-detected on connect if omitted.",
          required: false,
        },
      ],
    };
  }

  /**
   * @param {string} id
   * @param {string} name
   * @param {object} config
   * @param {string}   config.botToken    - Slack bot OAuth token (xoxb-…)
   * @param {string[]} config.channelIds  - Slack channel IDs to monitor
   * @param {string}   config.appUserId   - Bot's own user ID (to filter self-messages)
   */
  constructor(id, name, config = {}) {
    super(id, "slack", name, config);

    this.botToken = config.botToken || "";
    this.channelIds = Array.isArray(config.channelIds) ? config.channelIds : [];
    this.appUserId = config.appUserId || "";

    /**
     * Per-channel cursor tracking — maps channelId → ISO timestamp string of
     * the most recent message we have processed (Slack "oldest" parameter).
     * We initialise lazily on first connect.
     *
     * @type {Map<string, string>}
     */
    this._cursors = new Map();

    /** @type {ReturnType<typeof setInterval> | null} */
    this._pollTimer = null;
  }

  // ─── Lifecycle ────────────────────────────────────────────────

  async connect() {
    if (!this.botToken) {
      throw new Error("Slack channel requires a botToken in its config");
    }
    if (this.channelIds.length === 0) {
      throw new Error(
        "Slack channel requires at least one channelId in its config",
      );
    }

    // Verify credentials by calling auth.test.
    const authResult = await this._apiCall("auth.test", {});
    if (!authResult.ok) {
      throw new Error(
        `Slack auth.test failed: ${authResult.error || "unknown error"}`,
      );
    }

    // If the caller didn't provide an appUserId, use the one returned by auth.test.
    if (!this.appUserId && authResult.user_id) {
      this.appUserId = authResult.user_id;
    }

    // Seed cursors: set "oldest" to right now so we don't replay history.
    const seed = (Date.now() / 1000).toFixed(6);
    for (const channelId of this.channelIds) {
      if (!this._cursors.has(channelId)) {
        this._cursors.set(channelId, seed);
      }
    }

    this.status = "connected";
    this.errorMessage = null;

    // Begin polling all monitored channels.
    this._pollTimer = setInterval(() => {
      this._pollAll().catch((err) => {
        console.error(`[Slack] Poll error: ${err.message}`);
      });
    }, POLL_INTERVAL_MS);
  }

  async disconnect() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    await super.disconnect();
  }

  // ─── Outbound messaging ───────────────────────────────────────

  /**
   * Post a message to a Slack channel or thread.
   *
   * @param {string} conversationId - Slack channel ID, or "CHANNEL_ID:THREAD_TS"
   *                                  to reply in a thread
   * @param {string} content        - Message text (plain-text or mrkdwn)
   */
  async sendMessage(conversationId, content) {
    // Support thread replies: "C1234567890:1234567890.123456"
    let channel = conversationId;
    let thread_ts;

    if (conversationId.includes(":")) {
      const parts = conversationId.split(":");
      channel = parts[0];
      thread_ts = parts[1];
    }

    const payload = { channel, text: content };
    if (thread_ts) {
      payload.thread_ts = thread_ts;
    }

    const result = await this._apiCall("chat.postMessage", payload);
    if (!result.ok) {
      throw new Error(
        `chat.postMessage failed: ${result.error || "unknown error"}`,
      );
    }
  }

  // ─── Internal helpers ─────────────────────────────────────────

  /**
   * Poll all configured Slack channels for new messages.
   */
  async _pollAll() {
    for (const channelId of this.channelIds) {
      try {
        await this._pollChannel(channelId);
      } catch (err) {
        // Log per-channel errors but don't stop polling other channels.
        console.error(
          `[Slack] Error polling channel ${channelId}: ${err.message}`,
        );
      }
    }
  }

  /**
   * Fetch new messages for a single Slack channel since the last cursor.
   *
   * @param {string} channelId
   */
  async _pollChannel(channelId) {
    const oldest = this._cursors.get(channelId) || "0";

    const result = await this._apiCall("conversations.history", {
      channel: channelId,
      oldest,
      limit: MESSAGES_PER_PAGE,
      inclusive: false,
    });

    if (!result.ok) {
      throw new Error(
        `conversations.history failed for ${channelId}: ${result.error || "unknown error"}`,
      );
    }

    const messages = result.messages || [];
    if (messages.length === 0) return;

    // Slack returns messages newest-first; process oldest-first.
    const sorted = [...messages].sort(
      (a, b) => parseFloat(a.ts) - parseFloat(b.ts),
    );

    let latestTs = oldest;

    for (const msg of sorted) {
      // Advance the cursor regardless of whether we emit the message.
      if (parseFloat(msg.ts) > parseFloat(latestTs)) {
        latestTs = msg.ts;
      }

      // Skip messages from the bot itself.
      if (msg.user === this.appUserId) continue;

      // Skip bot messages from other integrations.
      if (msg.subtype && msg.subtype !== "thread_broadcast") continue;

      // Skip messages with no text content.
      const text = (msg.text || "").trim();
      if (!text) continue;

      const tsMs = Math.round(parseFloat(msg.ts) * 1000);

      // Use "CHANNEL:THREAD_TS" as conversationId when inside a thread so
      // that replies can be threaded.
      const conversationId = msg.thread_ts
        ? `${channelId}:${msg.thread_ts}`
        : channelId;

      const inboundMsg = {
        channelId: this.id,
        direction: "inbound",
        conversationId,
        sender: msg.user || msg.username || "unknown",
        content: text,
        metadata: {
          slackChannelId: channelId,
          ts: msg.ts,
          thread_ts: msg.thread_ts || null,
        },
        timestamp: tsMs,
      };

      this._emitInbound(inboundMsg);
    }

    // Advance cursor past the last message we saw.
    // Adding a tiny epsilon avoids re-fetching the boundary message.
    const nextOldest = (parseFloat(latestTs) + 0.000001).toFixed(6);
    this._cursors.set(channelId, nextOldest);
  }

  /**
   * Make an authenticated Slack Web API call.
   * Returns the parsed JSON response body.
   *
   * @param {string} method  - API method, e.g. 'chat.postMessage'
   * @param {object} params  - Request parameters
   * @returns {Promise<object>}
   */
  _apiCall(method, params) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(params);

      const options = {
        hostname: "slack.com",
        path: `/api/${method}`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.botToken}`,
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(body),
        },
      };

      const req = https.request(options, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            reject(new Error(`Failed to parse Slack response: ${e.message}`));
          }
        });
      });

      req.on("error", reject);
      req.setTimeout(10000, () => {
        req.destroy(new Error(`Slack API request to ${method} timed out`));
      });

      req.write(body);
      req.end();
    });
  }
}

module.exports = SlackChannel;
