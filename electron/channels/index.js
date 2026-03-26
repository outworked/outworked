// ─── Channels barrel export ───────────────────────────────────────
// Auto-discovers all *-channel.js files in this directory (excluding
// base-channel.js) and exports them keyed by their metadata type.

const fs = require("fs");
const path = require("path");

/** @type {Map<string, typeof import('./base-channel')>} type → ChannelClass */
const channelClasses = new Map();

const dir = __dirname;
const files = fs.readdirSync(dir);

for (const file of files) {
  if (
    !file.endsWith("-channel.js") ||
    file === "base-channel.js"
  ) {
    continue;
  }

  try {
    const ChannelClass = require(path.join(dir, file));
    if (ChannelClass?.metadata?.type) {
      channelClasses.set(ChannelClass.metadata.type, ChannelClass);
    }
  } catch (err) {
    console.error(`[Channels] Failed to load ${file}: ${err.message}`);
  }
}

/**
 * Get all discovered channel classes keyed by type.
 * @returns {Map<string, typeof import('./base-channel')>}
 */
function getChannelClasses() {
  return channelClasses;
}

/**
 * Get metadata for all available channel types.
 * @returns {Array<object>}
 */
function getAvailableTypes() {
  return Array.from(channelClasses.values()).map((C) => C.metadata);
}

module.exports = { getChannelClasses, getAvailableTypes };
