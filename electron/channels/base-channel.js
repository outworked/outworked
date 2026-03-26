// ─── Base Channel ────────────────────────────────────────────────
// Abstract base class that all channel plugins extend.
// Concrete implementations must override connect() and sendMessage().

class BaseChannel {
  /**
   * @param {string} id      - Unique channel instance ID (from ChannelConfig.id)
   * @param {string} type    - Channel type identifier, e.g. 'imessage', 'slack'
   * @param {string} name    - Human-readable display name
   * @param {object} config  - Channel-specific configuration object
   */
  constructor(id, type, name, config = {}) {
    this.id = id;
    this.type = type;
    this.name = name;
    this.config = config;

    /** @type {'connected' | 'disconnected' | 'error'} */
    this.status = "disconnected";

    /** @type {string | null} */
    this.errorMessage = null;

    /** @type {((msg: object) => void) | null} */
    this.onMessageCallback = null;
  }

  // ─── Lifecycle ────────────────────────────────────────────────

  /**
   * Establish the channel connection and begin listening for messages.
   * Implementations should set this.status = 'connected' on success,
   * or throw (and the manager will set status = 'error').
   *
   * @returns {Promise<void>}
   */
  async connect() {
    throw new Error(`${this.type} channel does not implement connect()`);
  }

  /**
   * Tear down the channel connection and stop any polling timers.
   * Safe to call even when already disconnected.
   *
   * @returns {Promise<void>}
   */
  async disconnect() {
    this.status = "disconnected";
    this.errorMessage = null;
  }

  // ─── Messaging ────────────────────────────────────────────────

  /**
   * Send an outbound message on this channel.
   *
   * @param {string} conversationId - The conversation/thread/buddy to message
   * @param {string} content        - Plain-text message body
   * @returns {Promise<void>}
   */
  async sendMessage(conversationId, content) {
    throw new Error(`${this.type} channel does not implement sendMessage()`);
  }

  // ─── Inbound handler registration ────────────────────────────

  /**
   * Register a callback that will be invoked whenever this channel receives
   * an inbound message.  The manager calls this once during setup.
   *
   * @param {(msg: object) => void} handler
   */
  onMessage(handler) {
    this.onMessageCallback = handler;
  }

  // ─── Metadata ────────────────────────────────────────────────

  /**
   * Channel implementations should override this static getter to describe
   * their type, display properties, and configurable fields so the UI can
   * build add-channel forms dynamically.
   *
   * @returns {{ type: string, label: string, color: string, description: string, fields: Array<{ key: string, label: string, type: string, placeholder?: string, hint?: string, required?: boolean }> }}
   */
  static get metadata() {
    return {
      type: "base",
      label: "Base",
      color: "slate",
      description: "",
      fields: [],
    };
  }

  // ─── Status helpers ───────────────────────────────────────────

  /**
   * Returns the current connection status of this channel.
   *
   * @returns {'connected' | 'disconnected' | 'error'}
   */
  getStatus() {
    return this.status;
  }

  /**
   * Convenience method for subclasses to call when an inbound message
   * arrives.  Guards against missing callbacks gracefully.
   *
   * @param {object} msg - A partial ChannelMessage (channelId, direction,
   *                        conversationId, sender, content, metadata, timestamp)
   */
  _emitInbound(msg) {
    if (typeof this.onMessageCallback === "function") {
      this.onMessageCallback(msg);
    }
  }
}

module.exports = BaseChannel;
