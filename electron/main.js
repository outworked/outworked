const {
  app,
  BrowserWindow,
  Menu,
  shell,
  session,
  ipcMain,
  dialog,
  Notification,
  powerSaveBlocker,
  net,
  protocol,
} = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, execSync, execFileSync } = require("child_process");
const crypto = require("crypto");
const { autoUpdater } = require("electron-updater");
const extractZip = require("extract-zip");
const sdkBridge = require("./sdk-bridge");

// Set the app name early so macOS notifications show "Outworked" instead of "Electron"
app.setName("Outworked");

const verbose = process.env.VERBOSE_LOGGING === "true";
let mainWindow = null;

/**
 * Broadcast an IPC message to ALL open application windows (main + popout).
 * Use this for events that any renderer might need (shell, claude-code,
 * file-watcher, updater, etc.).
 */
function broadcast(channel, ...args) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, ...args);
    }
  }
}

// ─── Preview window ─────────────────────────────────────────────
// A separate BrowserWindow that shows detected local dev-server URLs.
let previewWindow = null;

// Matches common local dev-server URLs in terminal output
const LOCAL_URL_RE =
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}/gi;

// Cooldown to avoid opening the same URL repeatedly (ms)
const PREVIEW_COOLDOWN_MS = 5_000;
let lastPreviewUrl = "";
let lastPreviewTime = 0;

/**
 * Open (or reuse) the preview window and navigate to the given URL.
 * Normalises 0.0.0.0 → localhost so the browser can actually connect.
 */
function openPreviewWindow(rawUrl) {
  const url = rawUrl.replace("0.0.0.0", "localhost");

  // Cooldown: skip if same URL was opened very recently
  const now = Date.now();
  if (url === lastPreviewUrl && now - lastPreviewTime < PREVIEW_COOLDOWN_MS) {
    return;
  }
  lastPreviewUrl = url;
  lastPreviewTime = now;

  if (previewWindow && !previewWindow.isDestroyed()) {
    previewWindow.loadURL(url);
    previewWindow.focus();
    return;
  }

  previewWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    title: "Outworked — Preview",
    backgroundColor: "#ffffff",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  previewWindow.loadURL(url);

  previewWindow.on("closed", () => {
    previewWindow = null;
  });

  // Notify the renderer that a preview was opened
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("preview:opened", url);
  }
}

/**
 * Scan a chunk of text for local dev-server URLs and open a preview.
 */
function detectAndPreview(text) {
  const matches = text.match(LOCAL_URL_RE);
  if (matches && matches.length > 0) {
    // Use the last match — typically the one the server prints as "ready"
    openPreviewWindow(matches[matches.length - 1]);
  }
}

// ─── Popout chat window ─────────────────────────────────────────
// A separate BrowserWindow that renders just the chat panel for an agent.
let popoutWindow = null;

function setupPopoutIPC() {
  ipcMain.handle("popout:open", (_event, agentId) => {
    if (popoutWindow && !popoutWindow.isDestroyed()) {
      popoutWindow.focus();
      return { ok: true, reused: true };
    }

    const iconPath = path.join(__dirname, "..", "build", "icon.png");
    const indexPath = path.join(__dirname, "..", "dist-renderer", "index.html");

    popoutWindow = new BrowserWindow({
      width: 520,
      height: 750,
      minWidth: 380,
      minHeight: 450,
      title: "Outworked — Panel",
      icon: iconPath,
      backgroundColor: "#0d0d1a",
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        autoplayPolicy: "no-user-gesture-required",
        additionalArguments: [`--homedir=${require("os").homedir()}`],
      },
    });

    // Load the same app with a popout query param
    popoutWindow.loadFile(indexPath, {
      query: { mode: "popout", agentId: agentId || "" },
    });

    popoutWindow.on("closed", () => {
      popoutWindow = null;
      // Notify the main window that popout was closed
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("popout:closed");
      }
    });

    return { ok: true, reused: false };
  });

  ipcMain.handle("popout:close", () => {
    if (popoutWindow && !popoutWindow.isDestroyed()) {
      popoutWindow.close();
    }
    return { ok: true };
  });

  // Relay state from main window → popout window
  ipcMain.on("popout:pushState", (_event, data) => {
    if (popoutWindow && !popoutWindow.isDestroyed()) {
      popoutWindow.webContents.send("popout:stateUpdate", data);
    }
  });

  // Relay actions from popout window → main window (e.g. send message, select agent)
  ipcMain.on("popout:sendAction", (_event, action) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("popout:action", action);
    }
  });

  ipcMain.handle("popout:isOpen", () => {
    return !!(popoutWindow && !popoutWindow.isDestroyed());
  });

  // Popout signals it's ready to receive state — relay to main window
  ipcMain.on("popout:ready", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("popout:ready");
    }
  });
}

// ─── Permission helpers ─────────────────────────────────────────
// Set a permissive umask so directories and files created by Electron
// (and inherited by Claude Code child processes) are owner+group
// read/write/execute.  Electron launched from Finder/Dock may inherit
// a restrictive umask (e.g. 0o077) that prevents Claude Code from
// writing to directories we create and vice-versa.
process.umask(0o022); // dirs → 755, files → 644

const DIR_MODE = 0o755;
const FILE_MODE = 0o644;

/**
 * Ensure a directory exists AND is writable by the current user.
 * If the directory exists but isn't writable, attempt to repair.
 */
function ensureDirWritable(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true, mode: DIR_MODE });
  } catch (err) {
    // EEXIST is fine; anything else is a real problem
    if (err.code !== "EEXIST") throw err;
  }
  // Verify we can actually write
  try {
    fs.accessSync(dirPath, fs.constants.W_OK | fs.constants.R_OK);
  } catch {
    // Attempt to repair permissions
    try {
      fs.chmodSync(dirPath, DIR_MODE);
    } catch (chmodErr) {
      console.error(
        `Cannot repair permissions on ${dirPath}:`,
        chmodErr.message,
      );
    }
  }
}

/**
 * Walk a directory tree and fix any directories/files that aren't
 * read+write accessible by the current user.  Non-recursive by default
 * (depth = 1); pass a higher depth for full repair.
 */
function repairPermissions(rootDir, maxDepth = 10) {
  const issues = [];
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      // Can't even read the directory — try to fix it
      try {
        fs.chmodSync(dir, DIR_MODE);
        issues.push({ path: dir, fixed: true, type: "dir" });
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        issues.push({
          path: dir,
          fixed: false,
          type: "dir",
          error: err.message,
        });
        return;
      }
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) {
          try {
            fs.accessSync(
              full,
              fs.constants.W_OK | fs.constants.R_OK | fs.constants.X_OK,
            );
          } catch {
            fs.chmodSync(full, DIR_MODE);
            issues.push({ path: full, fixed: true, type: "dir" });
          }
          walk(full, depth + 1);
        } else {
          try {
            fs.accessSync(full, fs.constants.W_OK | fs.constants.R_OK);
          } catch {
            fs.chmodSync(full, FILE_MODE);
            issues.push({ path: full, fixed: true, type: "file" });
          }
        }
      } catch (err) {
        issues.push({
          path: full,
          fixed: false,
          type: entry.isDirectory() ? "dir" : "file",
          error: err.message,
        });
      }
    }
  }
  walk(rootDir, 0);
  return issues;
}

// Detect available shell — prefer $SHELL, then zsh, bash, sh
function getShellCmd() {
  if (process.platform === "win32") return "cmd.exe";
  const candidates = [
    process.env.SHELL,
    "/bin/zsh",
    "/bin/bash",
    "/usr/bin/bash",
    "/bin/sh",
  ].filter(Boolean);
  for (const sh of candidates) {
    try {
      fs.accessSync(sh, fs.constants.X_OK);
      return sh;
    } catch {
      /* not available or not executable */
    }
  }
  return "sh"; // bare name — let the OS resolve via PATH
}

const SHELL_CMD = getShellCmd();

// Augment PATH with common locations where `claude` may be installed.
// Electron launched from Finder/Dock inherits a minimal PATH that
// often doesn't include ~/.local/bin or ~/.claude/bin even when the
// user's .zshrc adds them.
function augmentedEnv(extra) {
  const home = process.env.HOME || "";
  const extraPaths = [
    path.join(home, ".local", "bin"),
    path.join(home, ".claude", "bin"),
    path.join(home, "bin"),
    "/usr/local/bin",
  ].filter(Boolean);
  const currentPath = process.env.PATH || "";
  const newPath = [...extraPaths, currentPath].join(path.delimiter);
  return { ...process.env, PATH: newPath, ...(extra || {}) };
}

// GitHub token injected by renderer after loading API keys
let githubToken = "";

// ─── Shell process management ─────────────────────────────────────
const shells = new Map(); // id → { proc, cwd }
// SDK bridge manages active sessions (replaces the old claudeProcs Map)

// Kill a shell process and its entire process tree (child servers like vite, npx serve, etc.)
function killShellTree(proc) {
  if (!proc || proc.killed) return;
  const pid = proc.pid;
  if (!pid) {
    proc.kill();
    return;
  }
  try {
    // Kill the entire process group — on Unix, passing -pid kills all children
    process.kill(-pid, "SIGTERM");
  } catch {
    // Fallback: kill just the shell process (e.g. if not a process group leader)
    try {
      proc.kill("SIGTERM");
    } catch {
      /* already dead */
    }
  }
}

// Kill all tracked shells and their child process trees
function killAllShells() {
  for (const [, entry] of shells) {
    killShellTree(entry.proc);
  }
  shells.clear();
}

// ─── Caffeinate: prevent sleep while tasks are in flight ──────────
let caffeinateBlockerId = null;
let caffeinateType = null; // "prevent-app-suspension" | "prevent-display-sleep"

function caffeineStart(type) {
  if (caffeinateBlockerId !== null) {
    // Already blocking — upgrade to stronger type if needed
    if (
      type === "prevent-display-sleep" &&
      caffeinateType !== "prevent-display-sleep"
    ) {
      caffeineStop();
    } else {
      return;
    }
  }
  caffeinateType = type;
  caffeinateBlockerId = powerSaveBlocker.start(type);
  verbose &&
    console.log(
      `[caffeinate] started power-save blocker id=${caffeinateBlockerId} type=${type}`,
    );
}

function caffeineStop() {
  if (caffeinateBlockerId === null) return;
  if (powerSaveBlocker.isStarted(caffeinateBlockerId)) {
    powerSaveBlocker.stop(caffeinateBlockerId);
    verbose &&
      console.log(
        `[caffeinate] stopped power-save blocker id=${caffeinateBlockerId}`,
      );
  }
  caffeinateBlockerId = null;
  caffeinateType = null;
}

/** Call after adding/removing sessions to sync caffeinate state. */
function syncCaffeinate() {
  const hasChannels = _hasConnectedChannels();
  const hasSessions = sdkBridge.hasActiveSessions();
  const hasScheduled = _hasEnabledScheduledTasks();
  if (hasSessions) {
    // Active sessions need the stronger blocker to keep display on
    caffeineStart("prevent-display-sleep");
  } else if (hasChannels || hasScheduled) {
    caffeineStart("prevent-app-suspension");
  } else {
    caffeineStop();
  }
}

/** Check if any scheduled tasks are enabled and pending. */
function _hasEnabledScheduledTasks() {
  try {
    const tasks = db.schedulerList();
    return tasks.some((t) => t.enabled);
  } catch {
    return false;
  }
}

/** Check if any registered channel is currently connected. */
function _hasConnectedChannels() {
  try {
    const channelManager = require("./channels/channel-manager");
    return channelManager.getChannels().some((ch) => ch.status === "connected");
  } catch {
    return false;
  }
}

function setupPreviewIPC() {
  ipcMain.handle("preview:open", (_event, url) => {
    if (!url || typeof url !== "string") return false;
    openPreviewWindow(url);
    return true;
  });

  ipcMain.handle("preview:close", () => {
    if (previewWindow && !previewWindow.isDestroyed()) {
      previewWindow.close();
      previewWindow = null;
    }
    return true;
  });
}

function setupShellIPC() {
  // Spawn a new shell session
  ipcMain.handle("shell:spawn", (_event, cwd) => {
    const id = crypto.randomUUID();
    const safeCwd = validateDir(cwd || process.env.HOME);
    const isWin = process.platform === "win32";
    const proc = isWin
      ? spawn("cmd.exe", [], {
          cwd: safeCwd,
          env: augmentedEnv({ TERM: "xterm-256color" }),
        })
      : spawn(SHELL_CMD, ["-l"], {
          cwd: safeCwd,
          env: augmentedEnv({ TERM: "xterm-256color" }),
          detached: true,
        });
    // Unref so the shell doesn't prevent the app from exiting
    proc.unref();
    shells.set(id, { proc, cwd: safeCwd });

    proc.stdout.on("data", (data) => {
      const text = data.toString();
      broadcast("shell:stdout", id, text);
      detectAndPreview(text);
    });

    proc.stderr.on("data", (data) => {
      broadcast("shell:stderr", id, data.toString());
    });

    proc.on("error", (err) => {
      console.error(`Shell ${id} error:`, err.message);
      shells.delete(id);
      broadcast("shell:stderr", id, `[shell error] ${err.message}\n`);
      broadcast("shell:exit", id, -1);
    });

    proc.on("exit", (code) => {
      shells.delete(id);
      broadcast("shell:exit", id, code);
    });

    return id;
  });

  // Write to a shell's stdin
  ipcMain.handle("shell:write", (_event, id, data) => {
    const entry = shells.get(id);
    if (entry && entry.proc && !entry.proc.killed) {
      entry.proc.stdin.write(data);
      return true;
    }
    return false;
  });

  // Kill a shell and all its child processes (dev servers, etc.)
  ipcMain.handle("shell:kill", (_event, id) => {
    const entry = shells.get(id);
    if (entry && entry.proc) {
      killShellTree(entry.proc);
      shells.delete(id);
      return true;
    }
    return false;
  });

  // Run a single command and return stdout/stderr (for agent tool use)
  ipcMain.handle("shell:exec", (_event, command, cwd, timeoutMs) => {
    return new Promise((resolve) => {
      if (!command || typeof command !== "string") {
        resolve({
          ok: false,
          stdout: "",
          stderr: "",
          error: "No command provided",
          code: -1,
        });
        return;
      }

      let execCwd;
      try {
        execCwd = validateDir(cwd || process.env.HOME);
      } catch (err) {
        resolve({
          ok: false,
          stdout: "",
          stderr: "",
          error: err.message,
          code: -1,
        });
        return;
      }

      // Ensure the working directory exists and is writable before spawning
      try {
        ensureDirWritable(execCwd);
      } catch {
        /* best-effort */
      }

      // Only inject GitHub token for git/gh commands, not arbitrary commands
      const needsToken = githubToken && /^(git|gh)\b/.test(command.trim());
      const extraEnv = needsToken
        ? { GH_TOKEN: githubToken, GITHUB_TOKEN: githubToken }
        : {};

      // Use the user's login shell so PATH from .zprofile / .zshenv is available
      const isWin = process.platform === "win32";
      const proc = isWin
        ? spawn(command, {
            cwd: execCwd,
            env: augmentedEnv({ TERM: "dumb", ...extraEnv }),
            timeout: timeoutMs || 30000,
            shell: true,
          })
        : spawn(SHELL_CMD, ["-l", "-c", command], {
            cwd: execCwd,
            env: augmentedEnv({ TERM: "dumb", ...extraEnv }),
            timeout: timeoutMs || 30000,
          });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });
      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("error", (err) => {
        resolve({ ok: false, stdout, stderr, error: err.message, code: -1 });
      });

      proc.on("close", (code) => {
        resolve({
          ok: code === 0,
          stdout,
          stderr,
          code: code ?? -1,
          ...(code === null
            ? { error: "Process timed out or was killed" }
            : {}),
        });
      });
    });
  });

  // Set GitHub token for use in git/gh commands
  ipcMain.handle("shell:setGithubToken", (_event, token) => {
    githubToken = typeof token === "string" ? token : "";
  });

  // ─── Claude Code integration ──────────────────────────────────
  // Runs `claude -p` (print mode) with streaming stdout chunks sent
  // to the renderer so onThought can update incrementally.
  // Prompt is piped via stdin to avoid shell-escaping pitfalls.
  // System prompt is passed via an env var to avoid quoting issues.

  // claude-code:start — basic mode, routed through SDK bridge
  ipcMain.handle(
    "claude-code:start",
    (_event, prompt, systemPrompt, cwd, timeoutMs) => {
      const reqId = crypto.randomUUID();
      const execCwd = cwd || process.env.HOME;
      try {
        ensureDirWritable(execCwd);
      } catch {
        /* best-effort */
      }

      verbose &&
        console.log(`[claude-code:start] reqId=${reqId} cwd=${execCwd}`);
      syncCaffeinate();

      sdkBridge.startSession(
        reqId,
        {
          prompt,
          cwd: execCwd,
          systemPrompt: systemPrompt || undefined,
          timeoutMs: timeoutMs || undefined,
        },
        {
          onMessage: (id, message) => {
            broadcast("claude-code:event", id, message);
          },
          onHeartbeat: (id) => {
            broadcast("claude-code:heartbeat", id);
          },
          onDone: (id, code, error) => {
            syncCaffeinate();
            broadcast("claude-code:done", id, code, error);
          },
        },
      );

      return reqId;
    },
  );

  ipcMain.handle("claude-code:abort", (_event, reqId) => {
    const aborted = sdkBridge.abortSession(reqId);
    if (aborted) syncCaffeinate();
    return aborted;
  });

  // ─── Advanced Claude Code integration (via SDK) ─────────────────
  // Uses @anthropic-ai/claude-agent-sdk instead of spawning the CLI.
  // SDK messages are JSON-stringified and sent over the existing
  // claude-code:chunk IPC channel for backward compatibility.

  ipcMain.handle("claude-code:startAdvanced", (_event, options) => {
    const reqId = crypto.randomUUID();
    const execCwd = options.cwd || process.env.HOME;
    try {
      ensureDirWritable(execCwd);
    } catch {
      /* best-effort */
    }

    verbose &&
      console.log(
        `[claude-code:startAdvanced] reqId=${reqId} cwd=${execCwd} model=${options.model || "default"}`,
      );

    syncCaffeinate();

    // Pass GitHub token through options so sdk-bridge can inject it into env
    const sessionOptions = { ...options, cwd: execCwd };
    if (githubToken) {
      sessionOptions.githubToken = githubToken;
    }

    sdkBridge.startSession(reqId, sessionOptions, {
      onMessage: (id, message) => {
        broadcast("claude-code:event", id, message);
        // Scan assistant text and tool results for local dev-server URLs
        const scanText =
          message.content || message.result || message.output || "";
        if (typeof scanText === "string") {
          detectAndPreview(scanText);
        }
      },
      onHeartbeat: (id) => {
        broadcast("claude-code:heartbeat", id);
      },
      onStderr: (id, data) => {
        broadcast("claude-code:stderr", id, data);
      },
      onPermissionRequest: (id, request) => {
        broadcast("claude-code:permission-request", id, request);
      },
      onDone: (id, code, error, result) => {
        syncCaffeinate();
        // Emit a synthetic result event as a fallback if the generator
        // ended before streaming the result message.
        if (result) {
          broadcast("claude-code:event", id, {
            type: "result",
            subtype:
              result.subtype ||
              (code === 0 ? "success" : "error_during_execution"),
            result: result.text || "",
            session_id: result.sessionId,
            total_cost_usd: result.cost,
            usage: result.usage,
            is_error: code !== 0,
            errors: error ? [error] : [],
            duration_ms: result.durationMs,
            duration_api_ms: result.durationApiMs,
            num_turns: result.numTurns,
            stop_reason: result.stopReason,
            modelUsage: result.modelUsage,
            permission_denials: result.permissionDenials,
            structured_output: result.structuredOutput,
          });
        }
        broadcast("claude-code:done", id, code, error);
      },
    });

    return reqId;
  });

  // Send input to a running Claude Code session (legacy — no-op with SDK).
  ipcMain.handle("claude-code:sendInput", (_event, _reqId, _text) => {
    return false;
  });

  // Resolve a pending permission request from the renderer.
  ipcMain.handle("claude-code:resolvePermission", (_event, permId, allow) => {
    const result = sdkBridge.resolvePermission(permId, allow);
    // Broadcast to all windows so both main and popout clear their pending state
    broadcast("claude-code:permission-resolved", permId, allow);
    return result;
  });

  // Broadcast stop request so the main window's ChatWindow can abort
  ipcMain.on("claude-code:stop-agent", (_event, agentId) => {
    broadcast("claude-code:stop-agent", agentId);
  });

  // List available subagents from the claude CLI
  ipcMain.handle("claude-code:listAgents", (_event, cwd) => {
    return new Promise((resolve) => {
      const execCwd = cwd || process.env.HOME;
      const isWin = process.platform === "win32";
      const cmd = "claude agents";
      const proc = isWin
        ? spawn("cmd.exe", ["/c", cmd], {
            cwd: execCwd,
            env: augmentedEnv({ TERM: "dumb" }),
            timeout: 15000,
          })
        : spawn(SHELL_CMD, ["-l", "-c", cmd], {
            cwd: execCwd,
            env: augmentedEnv({ TERM: "dumb" }),
            timeout: 15000,
          });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d) => {
        stdout += d.toString();
      });
      proc.stderr.on("data", (d) => {
        stderr += d.toString();
      });
      proc.on("error", (err) =>
        resolve({ ok: false, error: err.message, stdout: "", stderr: "" }),
      );
      proc.on("close", (code) =>
        resolve({ ok: code === 0, stdout, stderr, code }),
      );
    });
  });

  // Check if claude CLI is installed and get version
  ipcMain.handle("claude-code:version", (_event) => {
    return new Promise((resolve) => {
      const isWin = process.platform === "win32";
      const cmd = "claude --version";
      const proc = isWin
        ? spawn("cmd.exe", ["/c", cmd], {
            env: augmentedEnv({ TERM: "dumb" }),
            timeout: 10000,
          })
        : spawn(SHELL_CMD, ["-l", "-c", cmd], {
            env: augmentedEnv({ TERM: "dumb" }),
            timeout: 10000,
          });
      let stdout = "";
      proc.stdout.on("data", (d) => {
        stdout += d.toString();
      });
      proc.on("error", () => resolve(null));
      proc.on("close", (code) => resolve(code === 0 ? stdout.trim() : null));
    });
  });

  // Check Claude Code auth / login status
  // Returns { installed, version, authenticated, accountInfo, error }
  ipcMain.handle("claude-code:authStatus", (_event) => {
    return new Promise((resolve) => {
      const result = {
        installed: false,
        version: null,
        authenticated: false,
        accountInfo: null,
        error: null,
      };
      const isWin = process.platform === "win32";
      const home = process.env.HOME || process.env.USERPROFILE || "";

      // Step 1: check version via CLI
      const vCmd = "claude --version";
      const vProc = isWin
        ? spawn("cmd.exe", ["/c", vCmd], {
            env: augmentedEnv({ TERM: "dumb" }),
            timeout: 10000,
          })
        : spawn(SHELL_CMD, ["-l", "-c", vCmd], {
            env: augmentedEnv({ TERM: "dumb" }),
            timeout: 10000,
          });
      let vOut = "",
        vErr = "";
      vProc.stdout.on("data", (d) => {
        vOut += d.toString();
      });
      vProc.stderr.on("data", (d) => {
        vErr += d.toString();
      });
      vProc.on("error", () => resolve(result));
      vProc.on("close", (code) => {
        if (code !== 0) {
          // Not installed or not in PATH
          result.error = vErr.trim().split("\n")[0] || "claude CLI not found";
          resolve(result);
          return;
        }
        result.installed = true;
        result.version = vOut.trim();

        // Step 2: check auth by looking for credential/config files
        // Claude Code stores auth in ~/.claude/ directory
        const claudeDir = path.join(home, ".claude");
        const credentialFiles = [
          path.join(claudeDir, ".credentials.json"),
          path.join(claudeDir, "credentials.json"),
          path.join(claudeDir, "config.json"),
          path.join(claudeDir, "settings.json"),
        ];

        // Check if .claude directory exists at all
        if (!fs.existsSync(claudeDir)) {
          result.error = "Not logged in. Run `claude login` in your terminal.";
          resolve(result);
          return;
        }

        // Check for any credential/config files
        let hasCredentials = false;
        for (const credFile of credentialFiles) {
          try {
            if (fs.existsSync(credFile)) {
              const content = fs.readFileSync(credFile, "utf-8");
              if (content.trim().length > 2) {
                // not empty {}
                hasCredentials = true;
                // Try to extract account info
                try {
                  const parsed = JSON.parse(content);
                  if (parsed.claudeAiOauth)
                    result.accountInfo = "OAuth (claude.ai)";
                  else if (parsed.apiKey || parsed.api_key)
                    result.accountInfo = "API key";
                  else if (parsed.primary_account?.email)
                    result.accountInfo = parsed.primary_account.email;
                } catch {
                  /* not JSON */
                }
                break;
              }
            }
          } catch {
            /* skip unreadable files */
          }
        }

        // Also check for any files in .claude that suggest auth happened
        if (!hasCredentials) {
          try {
            const dirContents = fs.readdirSync(claudeDir);
            // If there are files beyond just settings, likely authenticated
            const authIndicators = dirContents.filter(
              (f) =>
                f.includes("credential") ||
                f.includes("oauth") ||
                f.includes("auth") ||
                f.includes("session") ||
                f.includes("token") ||
                f === "statsig" ||
                f === "statsig_lcut",
            );
            hasCredentials = authIndicators.length > 0;
            if (hasCredentials && !result.accountInfo) {
              result.accountInfo = "session active";
            }
          } catch {
            /* skip */
          }
        }

        if (hasCredentials) {
          result.authenticated = true;
        } else {
          result.error = "Not logged in. Run `claude login` in your terminal.";
        }
        resolve(result);
      });
    });
  });

  // Read subagent .md files from ~/.claude/agents/ and <cwd>/.claude/agents/
  ipcMain.handle("claude-code:readAgentFiles", (_event, cwd) => {
    const home = process.env.HOME || "";
    const userDir = path.join(home, ".claude", "agents");
    const results = [];
    const dirs = [{ dir: userDir, scope: "user" }];
    if (cwd) {
      const projectDir = path.join(cwd, ".claude", "agents");
      // Avoid duplicate if cwd is home
      if (path.resolve(projectDir) !== path.resolve(userDir)) {
        dirs.push({ dir: projectDir, scope: "project" });
      }
    }
    for (const { dir, scope } of dirs) {
      try {
        if (!fs.existsSync(dir)) continue;
        const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
        for (const file of files) {
          const content = fs.readFileSync(path.join(dir, file), "utf-8");
          results.push({
            file,
            path: path.join(dir, file),
            content,
            scope,
          });
        }
      } catch {
        /* skip unreadable dirs */
      }
    }
    return results;
  });

  // Write a subagent .md file
  ipcMain.handle("claude-code:writeAgentFile", (_event, filePath, content) => {
    try {
      // Validate: only allow writing to .claude/agents/ directories
      // Allow both project-scope and user-scope (~/.claude/agents/)
      const resolved = path.resolve(filePath);
      const projectAgentsDir = path.join(workspaceDir, ".claude", "agents");
      const userAgentsDir = path.join(
        require("os").homedir(),
        ".claude",
        "agents",
      );
      const inProject =
        resolved.startsWith(projectAgentsDir + path.sep) ||
        resolved === projectAgentsDir;
      const inUser =
        resolved.startsWith(userAgentsDir + path.sep) ||
        resolved === userAgentsDir;
      if (!inProject && !inUser) {
        return {
          ok: false,
          error: "Can only write to .claude/agents/ directories",
        };
      }
      ensureDirWritable(path.dirname(resolved));
      fs.writeFileSync(resolved, content, {
        encoding: "utf-8",
        mode: FILE_MODE,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Delete a subagent file
  ipcMain.handle("claude-code:deleteAgentFile", (_event, filePath) => {
    try {
      const resolved = path.resolve(filePath);
      const projectAgentsDir = path.join(workspaceDir, ".claude", "agents");
      const userAgentsDir = path.join(
        require("os").homedir(),
        ".claude",
        "agents",
      );
      const inProject =
        resolved.startsWith(projectAgentsDir + path.sep) ||
        resolved === projectAgentsDir;
      const inUser =
        resolved.startsWith(userAgentsDir + path.sep) ||
        resolved === userAgentsDir;
      if (!inProject && !inUser) {
        return {
          ok: false,
          error: "Can only delete from .claude/agents/ directories",
        };
      }
      if (fs.existsSync(resolved)) {
        fs.unlinkSync(resolved);
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ─── Auto-watch agent directories ───────────────────────────────
  // Watch ~/.claude/agents/ for changes and notify the renderer.
  const agentWatchers = [];
  const userAgentDir = path.join(process.env.HOME || "", ".claude", "agents");

  function notifyAgentsChanged() {
    broadcast("claude-code:agents-changed");
  }

  // Debounce to avoid rapid-fire events from editors saving files
  let watchTimer = null;
  function debouncedNotify() {
    if (watchTimer) clearTimeout(watchTimer);
    watchTimer = setTimeout(notifyAgentsChanged, 500);
  }

  function watchAgentDir(dir) {
    try {
      ensureDirWritable(dir);
      const watcher = fs.watch(
        dir,
        { persistent: false },
        (eventType, filename) => {
          if (filename && filename.endsWith(".md")) {
            debouncedNotify();
          }
        },
      );
      agentWatchers.push(watcher);
    } catch {
      /* directory may not exist yet — that's ok */
    }
  }

  // Always watch user-level agents
  watchAgentDir(userAgentDir);

  // Watch project-level agents when workspace dir changes
  let projectAgentWatcher = null;
  ipcMain.on("claude-code:watchProjectAgents", (_event, projectDir) => {
    // Close previous project watcher
    if (projectAgentWatcher) {
      try {
        projectAgentWatcher.close();
      } catch {
        /* ignore */
      }
      const idx = agentWatchers.indexOf(projectAgentWatcher);
      if (idx !== -1) agentWatchers.splice(idx, 1);
      projectAgentWatcher = null;
    }
    if (!projectDir) return;
    const dir = path.join(projectDir, ".claude", "agents");
    if (path.resolve(dir) === path.resolve(userAgentDir)) return;
    try {
      ensureDirWritable(dir);
      projectAgentWatcher = fs.watch(
        dir,
        { persistent: false },
        (eventType, filename) => {
          if (filename && filename.endsWith(".md")) {
            debouncedNotify();
          }
        },
      );
      agentWatchers.push(projectAgentWatcher);
    } catch {
      /* directory may not exist yet — that's ok */
    }
  });

  // Clean up watchers on quit
  app.on("before-quit", () => {
    for (const w of agentWatchers) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
  });
}

// Clean up child processes and tunnels on quit
app.on("before-quit", () => {
  killAllShells();
  sdkBridge.abortAll();
  try {
    require("./skills/skill-runtime-manager").destroyAll();
  } catch {
    /* best effort */
  }
  try {
    require("./mcp/mcp-server").stopAllTunnels();
  } catch {
    /* mcp server may not be loaded */
  }
  caffeineStop();
});

// ─── Filesystem IPC ───────────────────────────────────────────────
let workspaceDir = path.join(process.env.HOME || "", "outworked-workspace");

function ensureDir(dirPath) {
  ensureDirWritable(dirPath);
}

function resolveSafe(relativePath) {
  // Prevent path traversal outside workspace
  const resolved = path.resolve(workspaceDir, relativePath);
  if (
    resolved !== workspaceDir &&
    !resolved.startsWith(workspaceDir + path.sep)
  ) {
    throw new Error("Path escapes workspace");
  }
  return resolved;
}

/**
 * Validate that a directory path is a real directory and not a
 * system-critical location. Returns the resolved absolute path.
 */
function validateDir(dir) {
  const resolved = path.resolve(dir);
  const blockedRoots = [
    "/",
    "/etc",
    "/usr",
    "/bin",
    "/sbin",
    "/var",
    "/System",
    "/Library",
  ];
  if (blockedRoots.includes(resolved)) {
    throw new Error(`Refusing to operate in system directory: ${resolved}`);
  }
  return resolved;
}

function setupFilesystemIPC() {
  // Get / set workspace directory
  ipcMain.handle("fs:getWorkspace", () => workspaceDir);

  ipcMain.handle("fs:setWorkspace", (_event, dir) => {
    // Kill all running shells (and their child servers) when switching projects
    killAllShells();
    sdkBridge.abortAll();
    // Validate: must be an absolute path and not a system-critical directory
    const resolved = path.resolve(dir);
    const blockedRoots = [
      "/",
      "/etc",
      "/usr",
      "/bin",
      "/sbin",
      "/var",
      "/System",
      "/Library",
    ];
    if (blockedRoots.includes(resolved)) {
      throw new Error(`Cannot set workspace to system directory: ${resolved}`);
    }
    workspaceDir = resolved;
    ensureDir(workspaceDir);
    // Verify the workspace is fully accessible after switching
    try {
      fs.accessSync(workspaceDir, fs.constants.W_OK | fs.constants.R_OK);
    } catch {
      repairPermissions(workspaceDir, 1);
    }
    return workspaceDir;
  });

  ipcMain.handle("fs:pickWorkspace", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory", "createDirectory"],
      title: "Choose workspace folder",
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    // Kill all running shells (and their child servers) when switching projects
    killAllShells();
    sdkBridge.abortAll();
    workspaceDir = result.filePaths[0];
    return workspaceDir;
  });

  // Write a file (creates parent dirs as needed)
  ipcMain.handle("fs:writeFile", (_event, relPath, content) => {
    const abs = resolveSafe(relPath);
    ensureDir(path.dirname(abs));
    fs.writeFileSync(abs, content, { encoding: "utf-8", mode: FILE_MODE });
    return { ok: true, bytes: Buffer.byteLength(content, "utf-8") };
  });

  // Read a file
  ipcMain.handle("fs:readFile", (_event, relPath) => {
    const abs = resolveSafe(relPath);
    if (!fs.existsSync(abs)) return { ok: false, error: "File not found" };
    return { ok: true, content: fs.readFileSync(abs, "utf-8") };
  });

  // Delete a file
  ipcMain.handle("fs:deleteFile", (_event, relPath) => {
    const abs = resolveSafe(relPath);
    if (!fs.existsSync(abs)) return { ok: false, error: "File not found" };
    fs.unlinkSync(abs);
    return { ok: true };
  });

  // List files recursively
  ipcMain.handle("fs:listFiles", (_event, relDir) => {
    const abs = relDir ? resolveSafe(relDir) : workspaceDir;
    ensureDir(abs);
    const results = [];
    const SKIP_LIST = new Set([
      "node_modules",
      ".git",
      ".hg",
      ".svn",
      "dist",
      "build",
      "out",
      ".next",
      ".nuxt",
      ".cache",
      "__pycache__",
      ".tox",
      ".venv",
      "venv",
      ".gradle",
      ".idea",
      ".vs",
      "coverage",
      "target",
      "bin",
      "obj",
      ".turbo",
      ".parcel-cache",
      ".webpack",
    ]);
    function walk(dir, prefix) {
      if (results.length >= 5000) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= 5000) return;
        const rel = prefix ? prefix + "/" + entry.name : entry.name;
        if (entry.isDirectory()) {
          if (SKIP_LIST.has(entry.name) || entry.name.startsWith(".")) continue;
          walk(path.join(dir, entry.name), rel);
        } else {
          const stat = fs.statSync(path.join(dir, entry.name));
          results.push({ path: rel, size: stat.size, updatedAt: stat.mtimeMs });
        }
      }
    }
    walk(abs, relDir || "");
    return results;
  });

  // Directories to skip during recursive walks
  const SKIP_DIRS = new Set([
    "node_modules",
    ".git",
    ".hg",
    ".svn",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".cache",
    "__pycache__",
    ".tox",
    ".venv",
    "venv",
    ".gradle",
    ".idea",
    ".vs",
    "coverage",
    "target",
    "bin",
    "obj",
    ".turbo",
    ".parcel-cache",
    ".webpack",
  ]);
  const MAX_FILES = 5000;
  const MAX_DEPTH = 20;

  // List all files (metadata only — no content) for the file browser
  ipcMain.handle("fs:listAllFiles", () => {
    ensureDir(workspaceDir);
    const results = [];
    function walk(dir, prefix, depth) {
      if (depth > MAX_DEPTH || results.length >= MAX_FILES) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= MAX_FILES) return;
        const rel = prefix ? prefix + "/" + entry.name : entry.name;
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
          walk(path.join(dir, entry.name), rel, depth + 1);
        } else {
          try {
            const stat = fs.statSync(path.join(dir, entry.name));
            results.push({
              path: rel,
              size: stat.size,
              updatedAt: stat.mtimeMs,
            });
          } catch {
            /* skip unreadable */
          }
        }
      }
    }
    walk(workspaceDir, "", 0);
    return results;
  });

  // Get all files with content (for file browser panel)
  ipcMain.handle("fs:getAllFiles", () => {
    ensureDir(workspaceDir);
    const results = [];
    function walk(dir, prefix, depth) {
      if (depth > MAX_DEPTH || results.length >= MAX_FILES) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= MAX_FILES) return;
        const rel = prefix ? prefix + "/" + entry.name : entry.name;
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
          walk(path.join(dir, entry.name), rel, depth + 1);
        } else {
          const abs = path.join(dir, entry.name);
          let stat;
          try {
            stat = fs.statSync(abs);
          } catch {
            continue;
          }
          // Skip binary / huge files
          if (stat.size > 512 * 1024) continue;
          try {
            const content = fs.readFileSync(abs, "utf-8");
            results.push({ path: rel, content, updatedAt: stat.mtimeMs });
          } catch {
            // skip unreadable files
          }
        }
      }
    }
    walk(workspaceDir, "", 0);
    return results;
  });

  // Search file contents by keywords — returns matching file paths with snippets
  ipcMain.handle("fs:searchFiles", (_event, keywords, maxResults = 50) => {
    ensureDir(workspaceDir);
    if (!Array.isArray(keywords) || keywords.length === 0) return [];

    // Build a case-insensitive pattern from keywords
    const patterns = keywords.map(
      (k) => new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
    );
    const results = [];
    const MAX_FILE_SIZE_SEARCH = 256 * 1024; // 256KB max for search

    function walk(dir, prefix, depth) {
      if (depth > MAX_DEPTH || results.length >= maxResults) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= maxResults) return;
        const rel = prefix ? prefix + "/" + entry.name : entry.name;
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
          walk(path.join(dir, entry.name), rel, depth + 1);
        } else {
          const abs = path.join(dir, entry.name);
          let stat;
          try {
            stat = fs.statSync(abs);
          } catch {
            continue;
          }
          if (stat.size > MAX_FILE_SIZE_SEARCH) continue;

          // First check filename matches
          const nameMatches = patterns.some((p) => p.test(entry.name));

          // Then check content if needed
          let contentMatches = false;
          let matchSnippet = "";
          if (!nameMatches) {
            try {
              const content = fs.readFileSync(abs, "utf-8");
              for (const pat of patterns) {
                const match = content.match(pat);
                if (match) {
                  contentMatches = true;
                  // Extract a snippet around the match
                  const idx = match.index || 0;
                  const start = Math.max(0, idx - 40);
                  const end = Math.min(
                    content.length,
                    idx + match[0].length + 40,
                  );
                  matchSnippet = content.slice(start, end).replace(/\n/g, " ");
                  break;
                }
              }
            } catch {
              continue;
            }
          }

          if (nameMatches || contentMatches) {
            results.push({
              path: rel,
              size: stat.size,
              updatedAt: stat.mtimeMs,
              matchType: nameMatches ? "filename" : "content",
              snippet: matchSnippet,
            });
          }
        }
      }
    }
    walk(workspaceDir, "", 0);
    return results;
  });
}

// ─── File Watcher IPC ─────────────────────────────────────────────

/** Directories to ignore when watching for file-system changes. */
const WATCH_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
  ".turbo",
]);

/** Single active FSWatcher instance – only one workspace watched at a time. */
let activeWatcher = null;

/**
 * Returns true if any path segment of `relPath` is in WATCH_SKIP_DIRS.
 * @param {string} relPath - relative path returned by fs.watch filename arg
 */
function shouldSkipWatchPath(relPath) {
  if (!relPath) return false;
  // Allow the top-level .git directory itself (e.g. from `git init`) so the
  // tree-changed event fires, but still skip anything inside .git/.
  if (relPath === ".git") return false;
  const parts = relPath.split(path.sep);
  return parts.some((p) => WATCH_SKIP_DIRS.has(p));
}

/**
 * Register IPC handlers for workspace file watching.
 * Channels:
 *   fs:watchWorkspace   (_event, dir) → void
 *   fs:unwatchWorkspace ()            → void
 * Emitted to renderer:
 *   fs:fileChanged      { eventType, filename }
 *   fs:fileTreeChanged  (no payload)
 */
function setupFileWatcherIPC() {
  // Start watching a workspace directory for file changes.
  ipcMain.on("fs:watchWorkspace", (_event, dir) => {
    // Close any existing watcher before starting a new one.
    if (activeWatcher) {
      try {
        activeWatcher.close();
      } catch {
        /* ignore */
      }
      activeWatcher = null;
    }

    const watchDir = dir || workspaceDir;
    if (!fs.existsSync(watchDir)) return;

    // Debounce timers: keyed by filename for per-file debounce, and a single
    // timer for the coarser "tree changed" notification.
    const fileTimers = new Map();
    let treeTimer = null;

    try {
      activeWatcher = fs.watch(
        watchDir,
        { recursive: true },
        (eventType, filename) => {
          if (!filename || shouldSkipWatchPath(filename)) return;

          // Per-file debounce – 300 ms
          if (fileTimers.has(filename)) {
            clearTimeout(fileTimers.get(filename));
          }
          fileTimers.set(
            filename,
            setTimeout(() => {
              fileTimers.delete(filename);
              broadcast("fs:fileChanged", { eventType, filename });
            }, 300),
          );

          // Coarser tree-changed notification – 500 ms
          if (treeTimer) clearTimeout(treeTimer);
          treeTimer = setTimeout(() => {
            treeTimer = null;
            broadcast("fs:fileTreeChanged");
          }, 500);
        },
      );

      activeWatcher.on("error", (err) => {
        console.error("[fs:watchWorkspace] watcher error:", err.message);
      });
    } catch (err) {
      console.error(
        "[fs:watchWorkspace] failed to start watcher:",
        err.message,
      );
    }
  });

  // Stop watching the current workspace.
  ipcMain.on("fs:unwatchWorkspace", () => {
    if (activeWatcher) {
      try {
        activeWatcher.close();
      } catch {
        /* ignore */
      }
      activeWatcher = null;
    }
  });
}

// ─── Git IPC ──────────────────────────────────────────────────────

/**
 * Register IPC handlers for git operations in the workspace.
 * All handlers accept an optional `dir` as their first argument (after
 * _event) and fall back to `workspaceDir` when omitted.
 *
 * Channels:
 *   git:status    (_event, dir)                → { ok, files[] }
 *   git:diff      (_event, dir, ref?, filepath?) → { ok, diff }
 *   git:diffStat  (_event, dir)                → { ok, stat }
 *   git:log       (_event, dir)                → { ok, log }
 *   git:stashRef  (_event, dir)                → { ok, ref }
 */
function setupGitIPC() {
  const EXEC_OPTS = { encoding: "utf-8", timeout: 10000 };

  /**
   * Run a git/gh command in `cwd`, returning stdout as a trimmed string.
   * Uses execFileSync with argument arrays to prevent command injection.
   * @param {string[]} args - Array of arguments (first element can be "git" or "gh")
   * @param {string} cwd - Working directory
   */
  function git(args, cwd) {
    const safeCwd = validateDir(cwd);
    const [binary, ...rest] = args;
    const env = githubToken
      ? { ...process.env, GH_TOKEN: githubToken, GITHUB_TOKEN: githubToken }
      : process.env;
    return execFileSync(binary, rest, {
      ...EXEC_OPTS,
      cwd: safeCwd,
      env,
    }).trimEnd();
  }

  // Check if a directory is inside a git repository.
  ipcMain.handle("git:isRepo", (_event, dir) => {
    const cwd = dir || workspaceDir;
    try {
      const safeCwd = validateDir(cwd);
      execFileSync("git", ["rev-parse", "--git-dir"], {
        ...EXEC_OPTS,
        cwd: safeCwd,
        stdio: "pipe",
      });
      return { ok: true, isRepo: true };
    } catch {
      return { ok: true, isRepo: false };
    }
  });

  // Parse `git status --porcelain` output into a structured array.
  ipcMain.handle("git:status", (_event, dir) => {
    const cwd = dir || workspaceDir;
    try {
      const raw = git(["git", "status", "--porcelain"], cwd);
      const files = raw
        .split("\n")
        .filter(Boolean)
        .map((line) => ({
          status: line.slice(0, 2).trim(),
          path: line.slice(3),
        }));
      return { ok: true, files };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Return unified diff, optionally scoped to a ref and/or a single file.
  ipcMain.handle("git:diff", (_event, dir, ref, filepath) => {
    const cwd = dir || workspaceDir;
    try {
      const args = ["git", "diff"];
      if (ref) args.push(ref);
      if (filepath) args.push("--", filepath);
      const diff = git(args, cwd);
      return { ok: true, diff };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Return a short diffstat summary.
  ipcMain.handle("git:diffStat", (_event, dir) => {
    const cwd = dir || workspaceDir;
    try {
      const stat = git(["git", "diff", "--stat"], cwd);
      return { ok: true, stat };
    } catch (err) {
      // No commits yet — diff --stat has nothing to compare against
      if (/unknown revision|does not have any commits/i.test(err.message)) {
        return { ok: true, stat: "" };
      }
      return { ok: false, error: err.message };
    }
  });

  // Return the most recent 20 commits in oneline format.
  ipcMain.handle("git:log", (_event, dir) => {
    const cwd = dir || workspaceDir;
    try {
      const log = git(["git", "log", "--oneline", "-20"], cwd);
      return { ok: true, log };
    } catch (err) {
      // Empty repo (no commits yet) — not an error, just no history
      if (/does not have any commits/i.test(err.message)) {
        return { ok: true, log: "" };
      }
      return { ok: false, error: err.message };
    }
  });

  // Create a stash ref (without actually stashing) for session-start baseline.
  // Uses `git stash create` which returns a commit hash if there are staged/
  // unstaged changes, or an empty string when the tree is clean.  In the
  // clean-tree case we fall back to HEAD.
  ipcMain.handle("git:stashRef", (_event, dir) => {
    const cwd = dir || workspaceDir;
    try {
      const ref = git(["git", "stash", "create"], cwd);
      if (ref) return { ok: true, ref };
      // No local changes – use HEAD as the baseline.
      const head = git(["git", "rev-parse", "HEAD"], cwd);
      return { ok: true, ref: head };
    } catch (err) {
      // No commits yet — no baseline available
      if (/unknown revision|does not have any commits/i.test(err.message)) {
        return { ok: true, ref: "" };
      }
      return { ok: false, error: err.message };
    }
  });

  // Return current branch name and list of local branches.
  ipcMain.handle("git:branchInfo", (_event, dir) => {
    const cwd = dir || workspaceDir;
    try {
      let current = "";
      try {
        current = git(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd);
      } catch (e) {
        // No commits yet — HEAD doesn't resolve. Read branch name from symbolic ref.
        if (/unknown revision|does not have any commits/i.test(e.message)) {
          try {
            const symRef = git(["git", "symbolic-ref", "--short", "HEAD"], cwd);
            current = symRef || "main";
          } catch {
            current = "main";
          }
          return {
            ok: true,
            current,
            branches: [current],
            remote: "",
            ahead: 0,
            behind: 0,
          };
        }
        throw e;
      }
      const raw = git(["git", "branch", "--format=%(refname:short)"], cwd);
      const branches = raw.split("\n").filter(Boolean);
      // Try to get remote tracking info
      let remote = "";
      let ahead = 0;
      let behind = 0;
      try {
        remote = git(
          ["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
          cwd,
        );
        const counts = git(
          ["git", "rev-list", "--left-right", "--count", "HEAD...@{u}"],
          cwd,
        );
        const [a, b] = counts.split(/\s+/);
        ahead = parseInt(a, 10) || 0;
        behind = parseInt(b, 10) || 0;
      } catch {
        /* no remote tracking */
      }
      return { ok: true, current, branches, remote, ahead, behind };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Stage files (git add).
  ipcMain.handle("git:stage", (_event, dir, files) => {
    const cwd = dir || workspaceDir;
    try {
      if (!files || files.length === 0) {
        git(["git", "add", "-A"], cwd);
      } else {
        git(["git", "add", "--", ...files], cwd);
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Unstage files (git reset HEAD).
  ipcMain.handle("git:unstage", (_event, dir, files) => {
    const cwd = dir || workspaceDir;
    try {
      if (!files || files.length === 0) {
        git(["git", "reset", "HEAD"], cwd);
      } else {
        git(["git", "reset", "HEAD", "--", ...files], cwd);
      }
      return { ok: true };
    } catch (err) {
      // No commits yet — use "git rm --cached" to unstage in an empty repo
      if (/unknown revision|does not have any commits/i.test(err.message)) {
        try {
          if (!files || files.length === 0) {
            git(["git", "rm", "--cached", "-r", "."], cwd);
          } else {
            git(["git", "rm", "--cached", "--", ...files], cwd);
          }
          return { ok: true };
        } catch (e2) {
          return { ok: false, error: e2.message };
        }
      }
      return { ok: false, error: err.message };
    }
  });

  // Get staged diff separately.
  ipcMain.handle("git:diffStaged", (_event, dir, filepath) => {
    const cwd = dir || workspaceDir;
    try {
      const args = ["git", "diff", "--cached"];
      if (filepath) args.push("--", filepath);
      const diff = git(args, cwd);
      return { ok: true, diff };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Commit staged changes.
  ipcMain.handle("git:commit", (_event, dir, message) => {
    const cwd = dir || workspaceDir;
    try {
      if (!message || !message.trim()) {
        return { ok: false, error: "Commit message is required" };
      }
      // Pass message as a separate argument — no shell escaping needed
      const output = git(["git", "commit", "-m", message], cwd);
      return { ok: true, output };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Create and switch to a new branch.
  ipcMain.handle("git:createBranch", (_event, dir, branchName) => {
    const cwd = dir || workspaceDir;
    try {
      if (!branchName || !branchName.trim()) {
        return { ok: false, error: "Branch name is required" };
      }
      const safe = branchName.trim().replace(/[^a-zA-Z0-9._\-\/]/g, "-");
      git(["git", "checkout", "-b", safe], cwd);
      return { ok: true, branch: safe };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Switch to an existing branch.
  ipcMain.handle("git:checkoutBranch", (_event, dir, branchName) => {
    const cwd = dir || workspaceDir;
    try {
      if (!branchName || typeof branchName !== "string") {
        return { ok: false, error: "Branch name is required" };
      }
      // Sanitize: only allow valid git branch name characters
      const safe = branchName.trim().replace(/[^a-zA-Z0-9._\-\/]/g, "");
      if (!safe) return { ok: false, error: "Invalid branch name" };
      git(["git", "checkout", safe], cwd);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Push current branch to remote.
  ipcMain.handle("git:push", (_event, dir, setUpstream) => {
    const cwd = dir || workspaceDir;
    try {
      const branch = git(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd);
      const args = ["git", "push"];
      if (setUpstream) args.push("-u", "origin", branch);
      const output = git(args, cwd);
      return { ok: true, output };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Create a pull request using gh CLI.
  ipcMain.handle("git:createPr", (_event, dir, title, body, baseBranch) => {
    const cwd = dir || workspaceDir;
    try {
      // Pass title/body as separate arguments — no shell escaping needed
      const args = [
        "gh",
        "pr",
        "create",
        "--title",
        title,
        "--body",
        body || "",
      ];
      if (baseBranch) args.push("--base", baseBranch);
      const output = git(args, cwd);
      return { ok: true, output, url: output.trim() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Get status with separate staged/unstaged tracking.
  ipcMain.handle("git:statusDetailed", (_event, dir) => {
    const cwd = dir || workspaceDir;
    try {
      const raw = git(["git", "status", "--porcelain"], cwd);
      const staged = [];
      const unstaged = [];
      const untracked = [];
      for (const line of raw.split("\n").filter(Boolean)) {
        const x = line[0]; // index status
        const y = line[1]; // worktree status
        const filepath = line.slice(3);
        if (x === "?" && y === "?") {
          untracked.push({ status: "??", path: filepath });
        } else {
          if (x !== " " && x !== "?") {
            staged.push({ status: x, path: filepath });
          }
          if (y !== " " && y !== "?") {
            unstaged.push({ status: y, path: filepath });
          }
        }
      }
      return { ok: true, staged, unstaged, untracked };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

// ─── Music IPC ────────────────────────────────────────────────────
function getBundledMusicDir() {
  return path.join(__dirname, "..", "dist-renderer", "music");
}

function getUserMusicDir() {
  return path.join(os.homedir(), ".outworked", "music");
}

/** Minimal ID3 tag parser – extracts title from ID3v2 (TIT2) or ID3v1 */
function readTitle(filePath) {
  try {
    const fd = fs.openSync(filePath, "r");
    const stat = fs.fstatSync(fd);

    // Try ID3v2 header (at start of file)
    const header = Buffer.alloc(10);
    fs.readSync(fd, header, 0, 10, 0);
    if (header.toString("ascii", 0, 3) === "ID3") {
      const size =
        ((header[6] & 0x7f) << 21) |
        ((header[7] & 0x7f) << 14) |
        ((header[8] & 0x7f) << 7) |
        (header[9] & 0x7f);
      const tagBuf = Buffer.alloc(Math.min(size, 4096));
      fs.readSync(fd, tagBuf, 0, tagBuf.length, 10);

      // Search for TIT2 frame
      for (let i = 0; i < tagBuf.length - 10; i++) {
        if (tagBuf.toString("ascii", i, i + 4) === "TIT2") {
          const frameSize =
            (tagBuf[i + 4] << 24) |
            (tagBuf[i + 5] << 16) |
            (tagBuf[i + 6] << 8) |
            tagBuf[i + 7];
          if (frameSize > 0 && frameSize < 1024) {
            // Skip 2 flag bytes + 1 encoding byte
            const textStart = i + 11;
            const encoding = tagBuf[i + 10];
            let title;
            if (encoding === 1 || encoding === 2) {
              // UTF-16
              title = tagBuf
                .toString("utf16le", textStart, i + 10 + frameSize)
                .replace(/\0/g, "")
                .trim();
            } else {
              title = tagBuf
                .toString("utf8", textStart, i + 10 + frameSize)
                .replace(/\0/g, "")
                .trim();
            }
            if (title) {
              fs.closeSync(fd);
              return title;
            }
          }
          break;
        }
      }
    }

    // Fallback: ID3v1 (last 128 bytes)
    if (stat.size >= 128) {
      const tail = Buffer.alloc(128);
      fs.readSync(fd, tail, 0, 128, stat.size - 128);
      if (tail.toString("ascii", 0, 3) === "TAG") {
        const title = tail.toString("ascii", 3, 33).replace(/\0/g, "").trim();
        if (title) {
          fs.closeSync(fd);
          return title;
        }
      }
    }

    fs.closeSync(fd);
  } catch {
    // ignore unreadable files
  }
  return null;
}

// ─── Permissions IPC ──────────────────────────────────────────────
function setupPermissionsIPC() {
  // Check if a path is writable
  ipcMain.handle("permissions:check", (_event, dirPath) => {
    try {
      const resolved = path.resolve(dirPath);
      if (!fs.existsSync(resolved)) {
        return { ok: false, exists: false, writable: false, readable: false };
      }
      let writable = false;
      let readable = false;
      try {
        fs.accessSync(resolved, fs.constants.W_OK);
        writable = true;
      } catch {
        /* not writable */
      }
      try {
        fs.accessSync(resolved, fs.constants.R_OK);
        readable = true;
      } catch {
        /* not readable */
      }
      return { ok: true, exists: true, writable, readable };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Repair permissions on a directory tree (workspace or agent dirs)
  ipcMain.handle("permissions:repair", (_event, dirPath) => {
    try {
      const resolved = path.resolve(dirPath);
      if (!fs.existsSync(resolved)) {
        ensureDirWritable(resolved);
        return { ok: true, issues: [], created: true };
      }
      const issues = repairPermissions(resolved);
      return { ok: true, issues, created: false };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Ensure a specific directory exists and is writable
  ipcMain.handle("permissions:ensureDir", (_event, dirPath) => {
    try {
      const resolved = path.resolve(dirPath);
      ensureDirWritable(resolved);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ─── Claude Code settings.json management ────────────────────────

  // Read Claude settings.json (global or project-level)
  // scope: 'global' → ~/.claude/settings.json
  // scope: 'project' → <workspace>/.claude/settings.json
  ipcMain.handle("claude-settings:read", (_event, scope) => {
    try {
      const home = process.env.HOME || "";
      const filePath =
        scope === "project"
          ? path.join(workspaceDir, ".claude", "settings.json")
          : path.join(home, ".claude", "settings.json");
      if (!fs.existsSync(filePath)) {
        return { ok: true, settings: {}, exists: false };
      }
      const content = fs.readFileSync(filePath, "utf-8");
      return { ok: true, settings: JSON.parse(content), exists: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Write Claude settings.json
  ipcMain.handle("claude-settings:write", (_event, scope, settings) => {
    try {
      const home = process.env.HOME || "";
      const filePath =
        scope === "project"
          ? path.join(workspaceDir, ".claude", "settings.json")
          : path.join(home, ".claude", "settings.json");
      ensureDirWritable(path.dirname(filePath));
      fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), {
        encoding: "utf-8",
        mode: FILE_MODE,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ─── CLAUDE.md management ────────────────────────────────────────

  // Read CLAUDE.md from workspace root
  ipcMain.handle("claude-settings:readClaudeMd", () => {
    try {
      const filePath = path.join(workspaceDir, "CLAUDE.md");
      if (!fs.existsSync(filePath)) {
        return { ok: true, content: "", exists: false };
      }
      return {
        ok: true,
        content: fs.readFileSync(filePath, "utf-8"),
        exists: true,
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Write CLAUDE.md to workspace root
  ipcMain.handle("claude-settings:writeClaudeMd", (_event, content) => {
    try {
      const filePath = path.join(workspaceDir, "CLAUDE.md");
      fs.writeFileSync(filePath, content, {
        encoding: "utf-8",
        mode: FILE_MODE,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

function setupMusicIPC() {
  // Ensure ~/.outworked/music exists
  const userMusicDir = getUserMusicDir();
  fs.mkdirSync(userMusicDir, { recursive: true });

  // Register protocol to serve user tracks from ~/.outworked/music
  protocol.handle("user-music", (request) => {
    // Parse raw URL to avoid hostname lowercasing / space issues
    const raw = request.url.replace(/^user-music:\/\//, "");
    const relParts = raw.split("/").filter(Boolean).map(decodeURIComponent);
    const filePath = path.join(getUserMusicDir(), ...relParts);
    return net.fetch(require("url").pathToFileURL(filePath).href);
  });

  const AUDIO_RE = /\.(mp3|wav|ogg|m4a|flac)$/i;
  const MAX_DEPTH = 4;

  function scanDir(baseDir, makeSrc, isUser) {
    if (!fs.existsSync(baseDir)) return [];
    const results = [];
    function walk(dir, depth) {
      if (depth > MAX_DEPTH) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (AUDIO_RE.test(entry.name)) {
          const rel = path.relative(baseDir, full);
          const id3Title = readTitle(full);
          const fallback = entry.name
            .replace(/\.[^.]+$/i, "")
            .replace(/[-_]/g, " ");
          results.push({
            file: entry.name,
            title: id3Title || fallback,
            src: makeSrc(rel),
            user: isUser,
          });
        }
      }
    }
    walk(baseDir, 0);
    return results.sort((a, b) => a.title.localeCompare(b.title));
  }

  ipcMain.handle("music:listTracks", () => {
    const bundled = scanDir(
      getBundledMusicDir(),
      (rel) => `./music/${rel}`,
      false,
    );
    const user = scanDir(
      getUserMusicDir(),
      (rel) =>
        `user-music://${rel.split(path.sep).map(encodeURIComponent).join("/")}`,
      true,
    );
    return [...bundled, ...user];
  });

  ipcMain.handle("music:getReadme", () => {
    const mdPath = path.join(__dirname, "music", "music.md");
    if (!fs.existsSync(mdPath)) return "";
    return fs.readFileSync(mdPath, "utf-8");
  });

  ipcMain.handle("music:openFolder", () => {
    const dir = getUserMusicDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
  });
}

// ─── Asset Packs IPC ─────────────────────────────────────────────

function getAssetsDir() {
  return path.join(os.homedir(), ".outworked", "assets");
}

function setupAssetsIPC() {
  // Ensure ~/.outworked/assets exists
  const assetsDir = getAssetsDir();
  fs.mkdirSync(assetsDir, { recursive: true });

  // Install bundled default pack on first launch
  const defaultPackDest = path.join(assetsDir, "outworked-default");
  if (!fs.existsSync(defaultPackDest)) {
    const bundledPack = app.isPackaged
      ? path.join(
          process.resourcesPath,
          "app.asar",
          "dist-renderer",
          "assets",
          "outworked-default",
        )
      : path.join(__dirname, "..", "public", "assets", "outworked-default");
    if (fs.existsSync(bundledPack)) {
      try {
        fs.cpSync(bundledPack, defaultPackDest, { recursive: true });
        console.log("[assets] Installed bundled default pack");
      } catch (err) {
        console.warn("[assets] Failed to install default pack:", err.message);
      }
    }
  }

  // Register protocol to serve asset files from ~/.outworked/assets
  protocol.handle("user-assets", (request) => {
    // Parse raw URL to avoid hostname lowercasing / space issues
    const raw = request.url.replace(/^user-assets:\/\//, "");
    const relParts = raw.split("/").filter(Boolean).map(decodeURIComponent);
    const filePath = path.join(getAssetsDir(), ...relParts);
    return net.fetch(require("url").pathToFileURL(filePath).href);
  });

  const PNG_RE = /\.png$/i;

  /**
   * Build a manifest from a directory that has no manifest.json.
   * Scans for PNGs — if found at top level or in an employees/ subfolder,
   * auto-generates an employees category with those sheets.
   * Returns null if no usable PNGs are found.
   */
  function inferManifest(packDir, packName) {
    const sheets = {};

    // Check employees/ subfolder first
    const empDir = path.join(packDir, "employees");
    if (fs.existsSync(empDir) && fs.statSync(empDir).isDirectory()) {
      for (const f of fs.readdirSync(empDir)) {
        if (PNG_RE.test(f)) {
          const key = f.replace(/\.png$/i, "").toLowerCase();
          sheets[key] = `employees/${f}`;
        }
      }
    }

    // Also check top-level PNGs (flat layout: just drop PNGs in the folder)
    for (const f of fs.readdirSync(packDir)) {
      if (!PNG_RE.test(f)) continue;
      const full = path.join(packDir, f);
      if (!fs.statSync(full).isFile()) continue;
      const key = f.replace(/\.png$/i, "").toLowerCase();
      // Don't overwrite if employees/ already provided this key
      if (!sheets[key]) sheets[key] = f;
    }

    // Scan furniture/ subfolder
    const furnitureItems = {};
    const furDir = path.join(packDir, "furniture");
    if (fs.existsSync(furDir) && fs.statSync(furDir).isDirectory()) {
      for (const f of fs.readdirSync(furDir)) {
        if (PNG_RE.test(f)) {
          const key = f.replace(/\.png$/i, "").toLowerCase();
          const isDesk =
            key === "desk" ||
            key.startsWith("desk_") ||
            key.startsWith("desk-");
          furnitureItems[key] = { file: `furniture/${f}`, desk: isDesk };
        }
      }
    }

    // Detect background image (background.png at top level or in pack dir)
    let backgroundFile = null;
    for (const name of ["background.png", "bg.png"]) {
      const bgPath = path.join(packDir, name);
      if (fs.existsSync(bgPath)) {
        backgroundFile = name;
        break;
      }
    }

    // Detect custom font (.ttf, .woff, .woff2 at top level)
    const FONT_RE = /\.(ttf|woff2?|otf)$/i;
    let fontFile = null;
    for (const f of fs.readdirSync(packDir)) {
      if (FONT_RE.test(f) && fs.statSync(path.join(packDir, f)).isFile()) {
        fontFile = f;
        break;
      }
    }

    const hasSheets = Object.keys(sheets).length > 0;
    const hasFurniture = Object.keys(furnitureItems).length > 0;
    if (!hasSheets && !hasFurniture && !backgroundFile && !fontFile)
      return null;

    // If no "default" sheet, pick the first one as default
    if (hasSheets && !sheets["default"]) {
      const first = Object.keys(sheets)[0];
      sheets["default"] = sheets[first];
    }

    const categories = {};
    if (hasSheets) categories.employees = { sheets };
    if (hasFurniture) categories.furniture = { items: furnitureItems };
    if (backgroundFile) categories.background = { file: backgroundFile };
    if (fontFile) categories.font = { file: fontFile };

    return {
      name: packName,
      categories,
    };
  }

  // Scan ~/.outworked/assets/ for packs (with or without manifest.json)
  ipcMain.handle("assets:listPacks", () => {
    const dir = getAssetsDir();
    if (!fs.existsSync(dir)) return [];
    const results = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const packDir = path.join(dir, entry.name);
      const manifestPath = path.join(packDir, "manifest.json");

      let manifest = null;
      if (fs.existsSync(manifestPath)) {
        try {
          const raw = fs.readFileSync(manifestPath, "utf-8");
          manifest = JSON.parse(raw);
          if (!manifest.name || !manifest.categories) manifest = null;
        } catch {
          // invalid JSON — fall through to auto-detection
        }
      }

      // No valid manifest — try to infer one from PNGs
      if (!manifest) {
        manifest = inferManifest(packDir, entry.name);
      }

      if (manifest) {
        results.push({ id: entry.name, manifest });
      }
    }
    return results;
  });

  // Active pack stored in app_settings via db
  ipcMain.handle("assets:getActivePack", () => {
    return db.settingGet("activeAssetPack") ?? null;
  });

  // Import a pack from a user-selected folder
  ipcMain.handle("assets:importPack", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile", "openDirectory"],
      title: "Select an asset pack folder or zip file",
      filters: [
        { name: "Zip Archives", extensions: ["zip"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    const srcPath = result.filePaths[0];
    const isZip = srcPath.toLowerCase().endsWith(".zip");

    const folderName = path.basename(srcPath, isZip ? ".zip" : "");
    const destDir = path.join(getAssetsDir(), folderName);

    // Don't overwrite existing packs silently — append a number if needed
    let finalDest = destDir;
    let counter = 1;
    while (fs.existsSync(finalDest)) {
      finalDest = `${destDir}-${counter++}`;
    }

    try {
      if (isZip) {
        fs.mkdirSync(finalDest, { recursive: true });
        await extractZip(srcPath, { dir: finalDest });

        // Remove macOS metadata folders that sneak into zips
        const macOSDir = path.join(finalDest, "__MACOSX");
        if (fs.existsSync(macOSDir)) {
          fs.rmSync(macOSDir, { recursive: true });
        }

        // If the zip contains a single top-level folder, unwrap it
        const entries = fs.readdirSync(finalDest);
        if (
          entries.length === 1 &&
          fs.statSync(path.join(finalDest, entries[0])).isDirectory()
        ) {
          const innerDir = path.join(finalDest, entries[0]);
          for (const item of fs.readdirSync(innerDir)) {
            fs.renameSync(
              path.join(innerDir, item),
              path.join(finalDest, item),
            );
          }
          fs.rmdirSync(innerDir);
        }
      } else {
        fs.cpSync(srcPath, finalDest, { recursive: true });
      }
      return path.basename(finalDest);
    } catch (err) {
      console.error("[assets] Import failed:", err.message);
      return null;
    }
  });

  ipcMain.handle("assets:setActivePack", (_event, packId) => {
    if (packId === null || packId === undefined) {
      db.settingDelete("activeAssetPack");
    } else {
      db.settingSet("activeAssetPack", packId);
    }
  });

  ipcMain.handle("assets:openFolder", () => {
    shell.openPath(getAssetsDir());
  });

  ipcMain.handle("assets:getReadme", () => {
    const mdPath = path.join(__dirname, "assets", "assets.md");
    if (!fs.existsSync(mdPath)) return "";
    return fs.readFileSync(mdPath, "utf-8");
  });
}

// ─── Session persistence ──────────────────────────────────────────
const SESSIONS_DIR = path.join(os.homedir(), ".outworked", "sessions");

/**
 * Sanitize a session/agent ID to prevent path traversal.
 * Only allows alphanumeric, hyphens, underscores, and dots.
 */
function sanitizeId(id) {
  if (!id || typeof id !== "string") throw new Error("Invalid ID");
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, "");
  if (!safe || safe === "." || safe === "..") throw new Error("Invalid ID");
  return safe;
}

function setupSessionIPC() {
  // Save a full session to disk
  ipcMain.handle("session:save", (_event, session) => {
    try {
      const safeAgentId = sanitizeId(session.agentId);
      const safeSessionId = sanitizeId(session.id);
      const dir = path.join(SESSIONS_DIR, safeAgentId);
      fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
      const filePath = path.join(dir, `${safeSessionId}.json`);
      fs.writeFileSync(filePath, JSON.stringify(session, null, 2), {
        encoding: "utf8",
        mode: FILE_MODE,
      });
      return { ok: true };
    } catch (err) {
      console.error("[session:save]", err.message);
      return { ok: false, error: err.message };
    }
  });

  // Load a single session
  ipcMain.handle("session:load", (_event, agentId, sessionId) => {
    try {
      const filePath = path.join(
        SESSIONS_DIR,
        sanitizeId(agentId),
        `${sanitizeId(sessionId)}.json`,
      );
      if (!fs.existsSync(filePath)) return { ok: false, error: "not found" };
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return { ok: true, session: data };
    } catch (err) {
      console.error("[session:load]", err.message);
      return { ok: false, error: err.message };
    }
  });

  // List all sessions for an agent (metadata only, sorted by updatedAt desc)
  ipcMain.handle("session:list", (_event, agentId) => {
    try {
      const dir = path.join(SESSIONS_DIR, sanitizeId(agentId));
      if (!fs.existsSync(dir)) return [];
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .reverse();
      const metas = [];
      for (const file of files) {
        try {
          const data = JSON.parse(
            fs.readFileSync(path.join(dir, file), "utf8"),
          );
          metas.push({
            id: data.id,
            agentId: data.agentId,
            claudeSessionId: data.claudeSessionId,
            title: data.title,
            createdAt: data.createdAt,
            updatedAt: data.updatedAt,
            messageCount: data.messageCount,
            totalCostUsd: data.totalCostUsd,
          });
        } catch {
          /* skip corrupt files */
        }
      }
      // Sort by updatedAt descending
      metas.sort((a, b) => b.updatedAt - a.updatedAt);
      return metas;
    } catch (err) {
      console.error("[session:list]", err.message);
      return [];
    }
  });

  // Delete a session
  ipcMain.handle("session:delete", (_event, agentId, sessionId) => {
    try {
      const filePath = path.join(
        SESSIONS_DIR,
        sanitizeId(agentId),
        `${sanitizeId(sessionId)}.json`,
      );
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return { ok: true };
    } catch (err) {
      console.error("[session:delete]", err.message);
      return { ok: false, error: err.message };
    }
  });

  // Search sessions by title or message content
  ipcMain.handle("session:search", (_event, agentId, query) => {
    try {
      const dir = path.join(SESSIONS_DIR, sanitizeId(agentId));
      if (!fs.existsSync(dir)) return [];
      const q = query.toLowerCase();
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
      const results = [];
      for (const file of files) {
        try {
          const data = JSON.parse(
            fs.readFileSync(path.join(dir, file), "utf8"),
          );
          const titleMatch = (data.title || "").toLowerCase().includes(q);
          const msgMatch =
            !titleMatch &&
            (data.messages || []).some((m) =>
              (m.content || "").toLowerCase().includes(q),
            );
          if (titleMatch || msgMatch) {
            results.push({
              id: data.id,
              agentId: data.agentId,
              claudeSessionId: data.claudeSessionId,
              title: data.title,
              createdAt: data.createdAt,
              updatedAt: data.updatedAt,
              messageCount: data.messageCount,
              totalCostUsd: data.totalCostUsd,
            });
          }
        } catch {
          /* skip */
        }
      }
      results.sort((a, b) => b.updatedAt - a.updatedAt);
      return results;
    } catch (err) {
      console.error("[session:search]", err.message);
      return [];
    }
  });
}

// ─── Database IPC ────────────────────────────────────────────────
const db = require("./db/database");

function setupDatabaseIPC() {
  // Wraps a db function so IPC errors are returned to the renderer
  // instead of crashing the handler or leaving it hanging.
  const safe =
    (fn) =>
    async (_event, ...args) => {
      try {
        return await fn(...args);
      } catch (err) {
        console.error(`[db-ipc] ${fn.name || "unknown"} failed:`, err);
        throw err;
      }
    };

  // App settings
  ipcMain.handle("db:setting:get", safe(db.settingGet));
  ipcMain.handle("db:setting:set", safe(db.settingSet));
  ipcMain.handle("db:setting:delete", safe(db.settingDelete));
  ipcMain.handle("db:setting:list", safe(db.settingList));

  // Memory
  ipcMain.handle("db:memory:set", safe(db.memorySet));
  ipcMain.handle("db:memory:get", safe(db.memoryGet));
  ipcMain.handle("db:memory:search", safe(db.memorySearch));
  ipcMain.handle("db:memory:list", safe(db.memoryList));
  ipcMain.handle("db:memory:delete", safe(db.memoryDelete));

  // Cost records
  ipcMain.handle("db:cost:addRecord", safe(db.costAddRecord));
  ipcMain.handle("db:cost:getAll", safe(db.costGetAll));
  ipcMain.handle("db:cost:getByAgent", safe(db.costGetByAgent));
  ipcMain.handle("db:cost:getSince", safe(db.costGetSince));
  ipcMain.handle("db:cost:clear", safe(db.costClear));
  ipcMain.handle("db:cost:getCumulative", safe(db.costGetCumulative));
  ipcMain.handle("db:cost:setCumulative", safe(db.costSetCumulative));
  ipcMain.handle("db:cost:deleteCumulative", safe(db.costDeleteCumulative));
  ipcMain.handle("db:cost:getBudgets", safe(db.costGetBudgets));
  ipcMain.handle("db:cost:setBudget", safe(db.costSetBudget));
  ipcMain.handle("db:cost:recordDelta", safe(db.costRecordDelta));

  // Triggers
  ipcMain.handle("db:trigger:create", safe(db.triggerCreate));
  ipcMain.handle("db:trigger:list", safe(db.triggerList));
  ipcMain.handle("db:trigger:update", safe(db.triggerUpdate));
  ipcMain.handle("db:trigger:delete", safe(db.triggerDelete));

  // Channel configs
  ipcMain.handle("db:channel:configSave", safe(db.channelConfigSave));
  ipcMain.handle("db:channel:configList", safe(db.channelConfigList));
  ipcMain.handle("db:channel:configDelete", safe(db.channelConfigDelete));

  // Channel messages
  ipcMain.handle("db:channel:messageSave", safe(db.channelMessageSave));
  ipcMain.handle("db:channel:messageList", safe(db.channelMessageList));

  // Skill auth
  ipcMain.handle("db:skill:authGet", safe(db.skillAuthGet));
  ipcMain.handle("db:skill:authSave", safe(db.skillAuthSave));
  ipcMain.handle("db:skill:authDelete", safe(db.skillAuthDelete));

  // Custom skills
  ipcMain.handle("db:customSkill:create", safe(db.customSkillCreate));
  ipcMain.handle("db:customSkill:list", safe(db.customSkillList));
  ipcMain.handle("db:customSkill:get", safe(db.customSkillGet));
  ipcMain.handle("db:customSkill:update", safe(db.customSkillUpdate));
  ipcMain.handle("db:customSkill:delete", safe(db.customSkillDelete));
}

// ─── Auto-updater ───────────────────────────────────────────────
function setupAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  // autoUpdater.allowPrerelease = true;
  // autoUpdater.forceDevUpdateConfig = !app.isPackaged;

  autoUpdater.on("update-available", (info) => {
    broadcast("updater:update-available", {
      version: info.version,
      releaseNotes: info.releaseNotes,
    });
  });

  autoUpdater.on("update-not-available", () => {
    broadcast("updater:update-not-available");
  });

  autoUpdater.on("download-progress", (progress) => {
    broadcast("updater:download-progress", {
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    broadcast("updater:update-downloaded", { version: info.version });
  });

  autoUpdater.on("error", (err) => {
    broadcast("updater:error", err.message);
  });

  // IPC handlers
  ipcMain.handle("updater:check", () => autoUpdater.checkForUpdates());
  ipcMain.handle("updater:download", () => autoUpdater.downloadUpdate());
  ipcMain.handle("updater:install", () => autoUpdater.quitAndInstall());
  ipcMain.handle("updater:getVersion", () => app.getVersion());

  // Check for updates 3 seconds after launch
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 3000);
}

function createWindow() {
  // Allow renderer to reach the AI provider APIs
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self' file:; " +
            "script-src 'self' blob:; " +
            "style-src 'self' 'unsafe-inline'; " +
            "font-src 'self' user-assets:; " +
            "connect-src 'self' https://api.openai.com https://api.anthropic.com user-assets:; " +
            "img-src 'self' data: blob: user-assets:; " +
            "media-src 'self' user-music:; " +
            "worker-src 'self' blob:;",
        ],
      },
    });
  });

  const iconPath = path.join(__dirname, "..", "build", "icon.png");

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: "Outworked — AI Agent HQ",
    icon: iconPath,
    backgroundColor: "#0d0d1a",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: "no-user-gesture-required",
      additionalArguments: [`--homedir=${require("os").homedir()}`],
    },
  });

  // Load the Vite build output
  const indexPath = path.join(__dirname, "..", "dist-renderer", "index.html");
  mainWindow.loadFile(indexPath);

  // Open external links in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // When the renderer reloads (Cmd-R, navigation, HMR full reload), abort all
  // active SDK sessions. Without this, the renderer loses its IPC listeners
  // and in-flight sessions become orphaned — agents appear "working" forever.
  mainWindow.webContents.on(
    "did-start-navigation",
    (_event, _url, isInPlace) => {
      if (sdkBridge.hasActiveSessions()) {
        verbose &&
          console.log(
            "[main] renderer navigating — aborting orphaned SDK sessions",
          );
        sdkBridge.abortAll();
        syncCaffeinate();
      }
    },
  );

  mainWindow.on("closed", () => {
    // Close the popout window when the main window closes
    if (popoutWindow && !popoutWindow.isDestroyed()) {
      popoutWindow.close();
    }
    mainWindow = null;
  });
}

function setupNotificationIPC() {
  ipcMain.handle("notification:show", (_event, title, body, options = {}) => {
    if (!Notification.isSupported())
      return { ok: false, error: "Notifications not supported" };
    const notif = new Notification({
      title,
      body,
      silent: options.silent ?? true, // We handle sounds in the renderer
      urgency: options.urgency ?? "normal",
    });
    notif.show();
    // When clicked, focus the main window
    notif.on("click", () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    });
    return { ok: true };
  });
}

// Allow user-music:// to stream audio and be fetched from the renderer
protocol.registerSchemesAsPrivileged([
  { scheme: "user-music", privileges: { stream: true, supportFetchAPI: true } },
  { scheme: "user-assets", privileges: { supportFetchAPI: true } },
]);

app.whenReady().then(() => {
  // Set an explicit application menu to suppress macOS
  // "representedObject is not a WeakPtrToElectronMenuModelAsNSObject" warnings
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: "about" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "forceReload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      {
        label: "Window",
        submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }],
      },
    ]),
  );

  setupPopoutIPC();
  setupPreviewIPC();
  setupShellIPC();
  setupFilesystemIPC();
  setupFileWatcherIPC();
  setupGitIPC();
  setupPermissionsIPC();
  setupMusicIPC();
  setupAssetsIPC();
  setupSessionIPC();
  setupDatabaseIPC();
  setupNotificationIPC();
  setupAutoUpdater();
  createWindow();

  // ─── Initialize channel manager, skill runtimes ──
  try {
    const channelManager = require("./channels/channel-manager");
    channelManager.setOnStatusChange(syncCaffeinate);
    channelManager.setupChannelIPC(ipcMain, mainWindow);
  } catch (err) {
    console.error("[channels] Failed to initialize:", err.message);
  }

  // ─── Skill runtimes + MCP Server ────────────────────────────────
  const skillManager = require("./skills/skill-runtime-manager");
  const mcpServer = require("./mcp/mcp-server");
  skillManager
    .discoverAndRegister()
    .then(() => skillManager.setupSkillRuntimeIPC(ipcMain, mainWindow))
    .catch((err) =>
      console.error("[skill-runtimes] Failed to initialize:", err.message),
    );
  mcpServer.setSkillManager(skillManager);
  mcpServer.start();

  // Clean up any stale outworked-skills entry from Claude Code's settings.json.
  // MCP is now injected per-session via SDK options as an HTTP server.
  try {
    const home = process.env.HOME || "";
    const settingsPath = path.join(home, ".claude", "settings.json");
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      if (settings.mcpServers && settings.mcpServers["outworked-skills"]) {
        delete settings.mcpServers["outworked-skills"];
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), {
          encoding: "utf-8",
          mode: FILE_MODE,
        });
        console.log("[mcp] Removed stale outworked-skills from settings.json");
      }
    }
  } catch (err) {
    console.error("[mcp] Failed to clean settings:", err.message);
  }

  try {
    const { triggerEngine, WebhookServer } = require("./triggers");
    triggerEngine.setWindow(mainWindow);
    triggerEngine.refreshPatterns();
    triggerEngine.setupTriggerIPC(ipcMain);

    // Refresh trigger engine patterns after UI/tool mutations
    ipcMain.handle("trigger:refreshPatterns", () => {
      triggerEngine.refreshPatterns();
      return { ok: true };
    });

    // Serve triggers.md documentation
    ipcMain.handle("trigger:docs", () => {
      const fs = require("fs");
      const path = require("path");
      try {
        return fs.readFileSync(
          path.join(__dirname, "triggers", "triggers.md"),
          "utf-8",
        );
      } catch {
        return null;
      }
    });

    // Scheduled tasks for the triggers UI
    ipcMain.handle("scheduler:list", () => {
      try {
        return db.schedulerList();
      } catch {
        return [];
      }
    });
    ipcMain.handle("scheduler:delete", (_event, id) => {
      try {
        db.schedulerDelete(id);
        syncCaffeinate();
        return { ok: true };
      } catch {
        return { ok: false };
      }
    });

    const webhookServer = new WebhookServer();
    webhookServer.start();
  } catch (err) {
    console.error("[triggers] Failed to initialize:", err.message);
  }

  // Sync caffeinate for any pre-existing scheduled tasks, and re-sync
  // periodically so one-time tasks that auto-disable release the blocker.
  syncCaffeinate();
  setInterval(syncCaffeinate, 30_000);

  // On startup, ensure the default workspace is accessible
  try {
    ensureDirWritable(workspaceDir);
  } catch (err) {
    console.error("Failed to ensure workspace permissions:", err.message);
  }
});

app.on("window-all-closed", () => {
  if (activeWatcher) {
    try {
      activeWatcher.close();
    } catch {
      /* ignore */
    }
    activeWatcher = null;
  }
  // Close SQLite database cleanly
  try {
    db.close();
  } catch {
    /* ignore */
  }
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
