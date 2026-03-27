// ─── Skill Runtime Manager ───────────────────────────────────────
// Main-process manager for active skill runtimes.
//
// Responsibilities:
//   - Auto-discover and register runtime instances from electron/skills/*/
//   - Maintain a tool name → runtime index for dispatch
//   - Middleware pipeline (before/after hooks on tool execution)
//   - Timeout wrapping and error normalization
//   - Load persisted auth from DB on startup, save after auth
//   - Forward runtime events to the renderer via IPC

const fs = require("fs");
const path = require("path");
const db = require("../db/database");
const BaseRuntime = require("./base-runtime");
const verbose = process.env.VERBOSE_LOGGING === "true";

// ── SkillError ──────────────────────────────────────────────────

class SkillError extends Error {
  constructor(message, { runtime, tool, code, cause } = {}) {
    super(message);
    this.name = "SkillError";
    this.runtime = runtime;
    this.tool = tool;
    this.code = code || "SKILL_ERROR";
    this.cause = cause;
  }
}

// ── Constants ───────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;

// Files in electron/skills/ that are NOT runtime directories
const SKIP_ENTRIES = new Set([
  "base-runtime.js",
  "skill-runtime-manager.js",
  "oauth-helper.js",
  "index.js",
]);

// ── Registry ─────────────────────────────────────────────────────

/** @type {Map<string, import('./base-runtime')>} */
const runtimes = new Map();

/** @type {Map<string, string>} tool name -> runtime name */
const _toolIndex = new Map();

/** @type {Array<{ before?: Function, after?: Function }>} */
const _middleware = [];

/** Weak ref to the mainWindow used to push events to renderer */
let _mainWindow = null;

// ── SKILL.md cache ──────────────────────────────────────────────

/** @type {Map<string, string>} runtime name -> raw SKILL.md content */
const _skillDocs = new Map();

/**
 * Read and cache the SKILL.md file for a runtime directory.
 * @param {string} runtimeName
 * @param {string} dirPath — absolute path to the runtime's directory
 */
function _loadSkillDoc(runtimeName, dirPath) {
  const skillMdPath = path.join(dirPath, "SKILL.md");
  try {
    if (fs.existsSync(skillMdPath)) {
      _skillDocs.set(runtimeName, fs.readFileSync(skillMdPath, "utf8"));
    }
  } catch (err) {
    verbose &&
      console.warn(
        `[skill-runtime-manager] Failed to read SKILL.md for '${runtimeName}': ${err.message}`,
      );
  }
}

/**
 * Return the raw SKILL.md content for a runtime, or null if none.
 * @param {string} name
 * @returns {string | null}
 */
function getSkillDoc(name) {
  return _skillDocs.get(name) || null;
}

/**
 * Return skill docs for all registered runtimes, optionally filtered to
 * connected-only. Each entry includes runtime name, status, and raw SKILL.md.
 * @param {{ connectedOnly?: boolean }} [opts]
 * @returns {Array<{ name: string, status: string, doc: string | null }>}
 */
function getAllSkillDocs(opts = {}) {
  const results = [];
  for (const [name, runtime] of runtimes) {
    if (opts.connectedOnly && runtime.status !== "connected") continue;
    results.push({
      name,
      status: runtime.status,
      doc: _skillDocs.get(name) || null,
    });
  }
  return results;
}

// ── Auto-discovery ───────────────────────────────────────────────

/**
 * Scan electron/skills/*\/index.js for BaseRuntime subclasses,
 * instantiate them, call init(), and register them.
 */
async function discoverAndRegister() {
  const skillsDir = path.join(__dirname);
  let entries;
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch (err) {
    console.error(
      "[skill-runtime-manager] Failed to read skills directory:",
      err.message,
    );
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKIP_ENTRIES.has(entry.name)) continue;

    const indexPath = path.join(skillsDir, entry.name, "index.js");
    if (!fs.existsSync(indexPath)) continue;

    try {
      const RuntimeClass = require(indexPath);

      // Verify it's a BaseRuntime subclass
      if (
        !RuntimeClass ||
        !RuntimeClass.prototype ||
        !(RuntimeClass.prototype instanceof BaseRuntime)
      ) {
        console.warn(
          `[skill-runtime-manager] Skipping '${entry.name}': does not extend BaseRuntime`,
        );
        continue;
      }

      // Load SKILL.md before instantiation so docs are available even if init fails
      const dirPath = path.join(skillsDir, entry.name);
      _loadSkillDoc(entry.name, dirPath);

      const runtime = new RuntimeClass();
      await runtime.init();
      registerRuntime(runtime);

      // Auto-connect runtimes that don't require auth (e.g. browser, scheduler)
      if (!runtime.getAuthConfig() && runtime.status !== "connected") {
        try {
          await runtime.authenticate({});
          await _persistAuth(runtime);
        } catch (err) {
          verbose &&
            console.warn(
              `[skill-runtime-manager] Auto-connect failed for '${runtime.name}': ${err.message}`,
            );
        }
      }

      verbose &&
        console.log(
          `[skill-runtime-manager] Discovered and registered: ${runtime.name} (${runtime.status})`,
        );
    } catch (err) {
      console.error(
        `[skill-runtime-manager] Failed to load runtime '${entry.name}':`,
        err.message,
      );
    }
  }
}

// ── Registration ─────────────────────────────────────────────────

/**
 * Register a runtime instance.
 * @param {import('./base-runtime')} runtime
 */
function registerRuntime(runtime) {
  if (runtimes.has(runtime.name)) {
    console.warn(
      `[skill-runtime-manager] Runtime '${runtime.name}' is already registered — replacing`,
    );
    // Clean up old tool index entries
    for (const [toolName, rtName] of _toolIndex) {
      if (rtName === runtime.name) _toolIndex.delete(toolName);
    }
  }
  runtimes.set(runtime.name, runtime);

  // Index tools for dispatch
  for (const tool of runtime.getTools()) {
    _toolIndex.set(tool.name, runtime.name);
  }

  // Wire up the event handler so the runtime can push events to the renderer
  runtime.onEvent((eventType, data) => {
    _pushEventToRenderer(runtime.name, eventType, data);
  });

  // Restore persisted auth, if any
  _restoreAuth(runtime).catch((err) => {
    console.error(
      `[skill-runtime-manager] Failed to restore auth for '${runtime.name}':`,
      err.message,
    );
  });
}

/**
 * Retrieve a registered runtime by name.
 * @param {string} name
 * @returns {import('./base-runtime') | undefined}
 */
function getRuntime(name) {
  return runtimes.get(name);
}

/**
 * Resolve a tool name to its runtime name.
 * @param {string} toolName
 * @returns {string | null}
 */
function resolveToolRuntime(toolName) {
  return _toolIndex.get(toolName) || null;
}

/**
 * List all registered runtimes with their current status.
 * @returns {Array<{ name: string, status: string, tools: string[], triggerTypes: string[], authConfig: object | null }>}
 */
function listRuntimes() {
  return Array.from(runtimes.values()).map((rt) => ({
    name: rt.name,
    status: rt.status,
    tools: rt.getTools().map((t) => t.name),
    triggerTypes: rt.getTriggerTypes(),
    authConfig: rt.getAuthConfig(),
  }));
}

// ── Middleware ────────────────────────────────────────────────────

/**
 * Add a middleware to the tool execution pipeline.
 * @param {{ before?: (ctx: object) => Promise<void>, after?: (ctx: object, result: unknown) => Promise<void> }} mw
 */
function use(mw) {
  _middleware.push(mw);
}

// Default logging middleware
use({
  async after(ctx, _result) {
    const duration = Date.now() - ctx.startedAt;
    verbose &&
      console.log(
        `[skill] ${ctx.runtimeName}:${ctx.toolName} completed in ${duration}ms`,
      );
  },
});

// ── Auth ─────────────────────────────────────────────────────────

/**
 * Trigger the OAuth / API-key flow for a runtime, then persist credentials.
 * @param {string} name        Runtime name
 * @param {object} credentials For OAuth2 runtimes pass { clientId, clientSecret }.
 * @returns {Promise<{ ok: boolean, status?: string, error?: string }>}
 */
async function authenticateRuntime(name, credentials) {
  const runtime = _requireRuntime(name);
  const authConfig = runtime.getAuthConfig();

  // Runtimes that don't need auth (e.g., browser)
  if (!credentials && (!authConfig || !authConfig.type)) {
    await runtime.authenticate({});
    await _persistAuth(runtime);
    return { ok: true, status: runtime.status };
  }

  // OAuth2 runtimes — need app credentials (clientId/clientSecret)
  if (!credentials && authConfig && authConfig.type === "oauth2") {
    const appCreds = loadOAuthAppCredentials(authConfig.provider || name);

    if (appCreds) {
      credentials = appCreds;
    } else {
      const entered = await promptForOAuthAppCredentials(name, authConfig);
      if (!entered) {
        return { ok: false, error: "Setup cancelled" };
      }
      saveOAuthAppCredentials(authConfig.provider || name, entered);
      credentials = entered;
    }
  }

  await runtime.authenticate(credentials);
  await _persistAuth(runtime);
  return { ok: true, status: runtime.status };
}

// ── OAuth app credential storage ────────────────────────────────

const os = require("os");
const OAUTH_CREDS_DIR = path.join(os.homedir(), ".outworked");
const OAUTH_CREDS_FILE = path.join(OAUTH_CREDS_DIR, "oauth-apps.json");

function loadAllOAuthAppCredentials() {
  try {
    if (fs.existsSync(OAUTH_CREDS_FILE)) {
      return JSON.parse(fs.readFileSync(OAUTH_CREDS_FILE, "utf8"));
    }
  } catch {
    /* ignore */
  }
  return {};
}

function loadOAuthAppCredentials(provider) {
  const all = loadAllOAuthAppCredentials();
  return all[provider] || null;
}

function saveOAuthAppCredentials(provider, creds) {
  const all = loadAllOAuthAppCredentials();
  all[provider] = {
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
  };
  fs.mkdirSync(OAUTH_CREDS_DIR, { recursive: true });
  fs.writeFileSync(OAUTH_CREDS_FILE, JSON.stringify(all, null, 2), "utf8");
}

function promptForOAuthAppCredentials(runtimeName, authConfig) {
  const { BrowserWindow, shell } = require("electron");
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 520,
      height: 440,
      title: `Set up ${runtimeName}`,
      resizable: false,
      minimizable: false,
      maximizable: false,
      alwaysOnTop: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });

    const provider = authConfig.provider || "the service";

    const html = `<!DOCTYPE html>
<html><head><style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #1a1a2e; color: #e0e0e0; padding: 24px; margin: 0; }
  h2 { font-size: 16px; margin: 0 0 4px; color: #a78bfa; }
  .subtitle { font-size: 11px; color: #6b7280; margin: 0 0 16px; }
  .step { font-size: 12px; color: #d1d5db; margin: 0 0 6px; line-height: 1.5; }
  .step b { color: #e0e0e0; }
  a { color: #818cf8; text-decoration: none; }
  a:hover { text-decoration: underline; }
  label { display: block; font-size: 12px; color: #d1d5db; margin: 12px 0 4px; }
  input { width: 100%; box-sizing: border-box; padding: 8px 10px; background: #0f0f23; border: 1px solid #374151; border-radius: 4px; color: #e0e0e0; font-size: 13px; font-family: monospace; }
  input:focus { outline: none; border-color: #6366f1; }
  .buttons { display: flex; gap: 8px; margin-top: 16px; }
  button { flex: 1; padding: 8px; border: none; border-radius: 4px; font-size: 13px; cursor: pointer; font-weight: 500; }
  .cancel { background: #374151; color: #d1d5db; }
  .connect { background: #4f46e5; color: white; }
  .cancel:hover { background: #4b5563; }
  .connect:hover { background: #4338ca; }
  hr { border: none; border-top: 1px solid #2d2d44; margin: 14px 0; }
</style></head><body>
  <h2>One-time setup</h2>
  <p class="subtitle">You only need to do this once — future connects will go straight to ${provider} login.</p>
  <p class="step">1. Go to <a id="consoleLink" href="#">Google Cloud Console &rarr; Credentials</a></p>
  <p class="step">2. Create an <b>OAuth 2.0 Client ID</b> (type: <b>Desktop app</b>)</p>
  <p class="step">3. Copy the Client ID and Client Secret below</p>
  <hr>
  <label>Client ID</label>
  <input id="clientId" placeholder="xxxxx.apps.googleusercontent.com" spellcheck="false" />
  <label>Client Secret</label>
  <input id="clientSecret" placeholder="GOCSPX-xxxxx" spellcheck="false" />
  <div class="buttons">
    <button class="cancel" onclick="window.close()">Cancel</button>
    <button class="connect" id="connectBtn">Save &amp; Connect</button>
  </div>
  <script>
    document.getElementById('consoleLink').onclick = (e) => {
      e.preventDefault();
      document.title = 'OPEN:https://console.cloud.google.com/apis/credentials';
    };
    document.getElementById('connectBtn').onclick = () => {
      const clientId = document.getElementById('clientId').value.trim();
      const clientSecret = document.getElementById('clientSecret').value.trim();
      if (!clientId || !clientSecret) return;
      document.title = 'AUTH:' + JSON.stringify({ clientId, clientSecret });
    };
    document.getElementById('clientId').focus();
  </script>
</body></html>`;

    win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    win.setMenu(null);

    win.webContents.on("page-title-updated", (_event, title) => {
      if (title.startsWith("AUTH:")) {
        try {
          const creds = JSON.parse(title.slice(5));
          win.close();
          resolve(creds);
        } catch {
          /* ignore */
        }
      } else if (title.startsWith("OPEN:")) {
        shell.openExternal(title.slice(5));
      }
    });

    win.on("closed", () => resolve(null));
  });
}

/**
 * Disconnect a runtime and remove its persisted credentials.
 * @param {string} name
 * @returns {Promise<void>}
 */
async function disconnectRuntime(name) {
  const runtime = _requireRuntime(name);
  await runtime.disconnect();
  db.skillAuthDelete(name);
}

// ── Tools ─────────────────────────────────────────────────────────

/**
 * Execute a tool on the named runtime, with middleware, timeouts, and error normalization.
 * @param {string} runtimeName
 * @param {string} toolName
 * @param {object} params
 * @returns {Promise<unknown>}
 */
async function executeTool(runtimeName, toolName, params) {
  const runtime = _requireRuntime(runtimeName);

  if (runtime.status !== "connected") {
    throw new SkillError(
      `Runtime '${runtimeName}' is not connected (status: ${runtime.status})`,
      {
        runtime: runtimeName,
        tool: toolName,
        code: "NOT_CONNECTED",
      },
    );
  }

  const context = { runtimeName, toolName, params, startedAt: Date.now() };

  // Run before middleware
  for (const mw of _middleware) {
    if (mw.before) await mw.before(context);
  }

  let result;
  try {
    result = await _executeWithTimeout(runtime, toolName, params);
  } catch (err) {
    throw _normalizeError(err, runtimeName, toolName);
  }

  // Run after middleware
  for (const mw of _middleware) {
    if (mw.after) await mw.after(context, result);
  }

  return result;
}

/**
 * Return tool definitions for the named runtime.
 * @param {string} name
 * @returns {Array<{ name: string, description: string, parameters: object }>}
 */
function getToolsForRuntime(name) {
  const runtime = _requireRuntime(name);
  return runtime.getTools();
}

// ── Shutdown ────────────────────────────────────────────────────

/**
 * Gracefully destroy all registered runtimes.
 * Call this on app quit.
 */
async function destroyAll() {
  const promises = [];
  for (const runtime of runtimes.values()) {
    promises.push(
      runtime.destroy().catch((err) => {
        console.error(
          `[skill-runtime-manager] Error destroying '${runtime.name}':`,
          err.message,
        );
      }),
    );
  }
  await Promise.all(promises);
  runtimes.clear();
  _toolIndex.clear();
}

// ── IPC setup ────────────────────────────────────────────────────

/**
 * Register all IPC handlers for the skill runtime system.
 * @param {Electron.IpcMain} ipcMain
 * @param {Electron.BrowserWindow} mainWindow
 */
function setupSkillRuntimeIPC(ipcMain, mainWindow) {
  _mainWindow = mainWindow;

  ipcMain.handle("skill-runtime:list", () => {
    return listRuntimes();
  });

  ipcMain.handle("skill-runtime:status", (_event, name) => {
    const rt = runtimes.get(name);
    if (!rt) return null;
    return { name: rt.name, status: rt.status };
  });

  ipcMain.handle(
    "skill-runtime:authenticate",
    async (_event, name, credentials) => {
      try {
        return await authenticateRuntime(name, credentials);
      } catch (err) {
        console.error(`[skill-runtime] authenticate ${name}:`, err.message);
        return { ok: false, error: err.message };
      }
    },
  );

  ipcMain.handle("skill-runtime:disconnect", async (_event, name) => {
    await disconnectRuntime(name);
    return { ok: true };
  });

  ipcMain.handle(
    "skill-runtime:executeTool",
    async (_event, runtimeName, toolName, params) => {
      return executeTool(runtimeName, toolName, params);
    },
  );

  ipcMain.handle("skill-runtime:getTools", (_event, name) => {
    return getToolsForRuntime(name);
  });

  ipcMain.handle("skill-runtime:getSkillDocs", (_event, opts) => {
    return getAllSkillDocs(opts);
  });
}

// ── Internal helpers ─────────────────────────────────────────────

function _requireRuntime(name) {
  const runtime = runtimes.get(name);
  if (!runtime) {
    throw new SkillError(`Unknown runtime: '${name}'`, {
      runtime: name,
      code: "TOOL_NOT_FOUND",
    });
  }
  return runtime;
}

async function _executeWithTimeout(runtime, toolName, params) {
  const timeoutMs = runtime.getToolTimeout(toolName) || DEFAULT_TIMEOUT_MS;

  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new SkillError(`Tool '${toolName}' timed out after ${timeoutMs}ms`, {
            runtime: runtime.name,
            tool: toolName,
            code: "TIMEOUT",
          }),
        ),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([
      runtime.executeTool(toolName, params),
      timeoutPromise,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function _normalizeError(err, runtimeName, toolName) {
  if (err instanceof SkillError) return err;

  // Map known error types
  const { ValidationError } = require("./base-runtime");
  if (err instanceof ValidationError) {
    return new SkillError(err.message, {
      runtime: runtimeName,
      tool: toolName,
      code: "VALIDATION",
      cause: err,
    });
  }

  if (err.message && err.message.includes("401")) {
    return new SkillError(err.message, {
      runtime: runtimeName,
      tool: toolName,
      code: "AUTH_EXPIRED",
      cause: err,
    });
  }

  return new SkillError(err.message || "Unknown error", {
    runtime: runtimeName,
    tool: toolName,
    code: "EXECUTION_ERROR",
    cause: err,
  });
}

async function _persistAuth(runtime) {
  const tokenCreds =
    typeof runtime.getCredentials === "function"
      ? runtime.getCredentials()
      : null;
  const oauthConfig =
    typeof runtime.getConfig === "function" ? runtime.getConfig() : {};
  const merged = tokenCreds ? { ...oauthConfig, ...tokenCreds } : null;
  db.skillAuthSave(
    runtime.name,
    merged ? JSON.stringify(merged) : null,
    oauthConfig,
    runtime.status,
  );
}

async function _restoreAuth(runtime) {
  const row = db.skillAuthGet(runtime.name);
  if (!row || !row.credentials) return;

  let credentials;
  try {
    credentials = JSON.parse(row.credentials);
  } catch {
    console.warn(
      `[skill-runtime-manager] Corrupted credentials for '${runtime.name}', skipping restore`,
    );
    return;
  }

  try {
    await runtime.authenticate(credentials, { silent: true });
    verbose &&
      console.log(
        `[skill-runtime-manager] Restored auth for '${runtime.name}'`,
      );
  } catch (err) {
    console.warn(
      `[skill-runtime-manager] Auth restore failed for '${runtime.name}': ${err.message}`,
    );
    try {
      const config =
        typeof runtime.getConfig === "function" ? runtime.getConfig() : {};
      db.skillAuthSave(runtime.name, row.credentials, config, "error");
    } catch {
      /* best effort */
    }
  }
}

function _pushEventToRenderer(runtimeName, eventType, data) {
  // Forward to the trigger engine so skill events can fire triggers
  try {
    const triggerEngine = require("../triggers/trigger-engine");
    triggerEngine.evaluateSkillEvent({ type: eventType, data });
  } catch {
    /* trigger engine may not be initialized yet */
  }

  if (_mainWindow && !_mainWindow.isDestroyed()) {
    _mainWindow.webContents.send("skill-runtime:event", {
      runtimeName,
      eventType,
      data,
    });
  }
}

module.exports = {
  SkillError,
  discoverAndRegister,
  registerRuntime,
  getRuntime,
  resolveToolRuntime,
  listRuntimes,
  use,
  authenticateRuntime,
  disconnectRuntime,
  executeTool,
  getToolsForRuntime,
  getSkillDoc,
  getAllSkillDocs,
  destroyAll,
  setupSkillRuntimeIPC,
};
