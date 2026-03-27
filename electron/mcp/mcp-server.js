// ─── Outworked MCP Server (Streamable HTTP) ─────────────────────
// Single always-running MCP server that exposes memory,
// channel, and skill tools to Claude Code agents over HTTP.
// Runs in the Electron main process on localhost:7823.
//
// Agents connect with: { type: "http", url: "http://127.0.0.1:7823/mcp" }

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execFileSync } = require("child_process");
const db = require("../db/database");
const verbose = process.env.VERBOSE_LOGGING === "true";

// ─── Cloudflared tunnel management ──────────────────────────────
// Active tunnels: key (port or url) → { proc, publicUrl }
const _tunnels = new Map();

// Path where we store the cloudflared binary
const CLOUDFLARED_DIR = path.join(os.homedir(), ".outworked", "bin");
const CLOUDFLARED_BIN = path.join(
  CLOUDFLARED_DIR,
  process.platform === "win32" ? "cloudflared.exe" : "cloudflared",
);

/**
 * Return the download URL for the current platform/arch from Cloudflare's
 * GitHub releases (latest stable).
 */
function getCloudflaredDownloadUrl() {
  const plat = process.platform;
  const arch = process.arch;

  if (plat === "darwin") {
    // Universal binary works on both Intel and Apple Silicon
    return "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz";
  }
  if (plat === "linux") {
    if (arch === "x64") {
      return "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64";
    }
    if (arch === "arm64") {
      return "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64";
    }
  }
  if (plat === "win32") {
    if (arch === "x64") {
      return "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";
    }
  }
  return null;
}

/**
 * Follow redirects and download a URL to a file. Returns a promise.
 */
function downloadFile(url, dest, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error("Too many redirects"));
    const mod = url.startsWith("https") ? https : http;
    mod
      .get(url, (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          // Follow redirect
          return downloadFile(
            res.headers.location,
            dest,
            maxRedirects - 1,
          ).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
        file.on("error", reject);
      })
      .on("error", reject);
  });
}

/**
 * Ensure cloudflared binary is available. Downloads it on first use.
 * Returns the path to the binary.
 */
async function ensureCloudflared() {
  // Check if already downloaded
  try {
    fs.accessSync(CLOUDFLARED_BIN, fs.constants.X_OK);
    return CLOUDFLARED_BIN;
  } catch {
    // Not found — download it
  }

  // Check if system-installed
  try {
    const systemPath = execFileSync("which", ["cloudflared"], {
      encoding: "utf8",
      timeout: 3000,
    }).trim();
    if (systemPath) return systemPath;
  } catch {
    // not on PATH
  }

  const url = getCloudflaredDownloadUrl();
  if (!url) {
    throw new Error(
      `No cloudflared binary available for ${process.platform}/${process.arch}`,
    );
  }

  verbose && console.log(`[mcp] Downloading cloudflared from ${url}...`);
  fs.mkdirSync(CLOUDFLARED_DIR, { recursive: true });

  if (url.endsWith(".tgz")) {
    // macOS: download .tgz, extract the binary
    const tgzPath = path.join(CLOUDFLARED_DIR, "cloudflared.tgz");
    await downloadFile(url, tgzPath);
    // Extract using tar (available on macOS and Linux)
    execFileSync("tar", ["-xzf", tgzPath, "-C", CLOUDFLARED_DIR], {
      timeout: 30_000,
    });
    try {
      fs.unlinkSync(tgzPath);
    } catch {
      /* ignore */
    }
  } else {
    // Linux/Windows: direct binary download
    await downloadFile(url, CLOUDFLARED_BIN);
  }

  // Make executable
  fs.chmodSync(CLOUDFLARED_BIN, 0o755);
  verbose && console.log(`[mcp] cloudflared installed at ${CLOUDFLARED_BIN}`);
  return CLOUDFLARED_BIN;
}

const PORT = 7823;
let _skillManager = null;
let _server = null;

function setSkillManager(manager) {
  _skillManager = manager;
}

// ─── Tool definitions ───────────────────────────────────────────

const BUILTIN_TOOLS = [
  {
    name: "remember",
    description:
      'Store a fact in persistent memory. Scopes: "global" (all agents), "agent:<id>" (private), "project:<path>" (workspace).',
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", description: "Memory scope" },
        key: { type: "string", description: "Short key for this memory" },
        value: { type: "string", description: "The information to remember" },
      },
      required: ["scope", "key", "value"],
    },
  },
  {
    name: "recall",
    description: "Retrieve memories from persistent storage.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", description: "Memory scope to search" },
        query: { type: "string", description: "Optional search query" },
      },
      required: ["scope"],
    },
  },
  {
    name: "forget",
    description: "Delete a memory entry.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", description: "Memory scope" },
        key: { type: "string", description: "Key to delete" },
      },
      required: ["scope", "key"],
    },
  },
  {
    name: "send_message",
    description:
      'Send a message through a connected messaging channel (iMessage, Slack, etc). Use list_channels first to discover available channels. For Slack threads, use "CHANNEL_ID:THREAD_TS" as the conversationId.',
    inputSchema: {
      type: "object",
      properties: {
        channelId: {
          type: "string",
          description: "ID of the channel to send through (from list_channels)",
        },
        conversationId: {
          type: "string",
          description:
            'Recipient — phone number/email for iMessage, Slack channel ID, or "CHANNEL_ID:THREAD_TS" for threaded replies',
        },
        content: { type: "string", description: "Message text to send" },
      },
      required: ["channelId", "conversationId", "content"],
    },
  },
  {
    name: "list_channels",
    description:
      "List all configured messaging channels and their connection status. Use this to discover available channels before sending messages.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_channel_messages",
    description: "Read recent messages from a messaging channel.",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string", description: "Channel ID to read from" },
        limit: {
          type: "number",
          description: "Max messages to return (default 20)",
        },
      },
      required: ["channelId"],
    },
  },
  {
    name: "tunnel_start",
    description:
      "Start a cloudflared tunnel to expose a local port to the internet. Returns a public URL that anyone can use to access the local server. Useful for sharing websites, previews, or demos with others. Cloudflared is automatically downloaded on first use.",
    inputSchema: {
      type: "object",
      properties: {
        port: {
          type: "number",
          description: "Local port to tunnel (e.g. 3000, 8080)",
        },
        url: {
          type: "string",
          description:
            'Full local URL to tunnel (e.g. "http://localhost:3000"). If provided, port is ignored.',
        },
      },
      required: [],
    },
  },
  {
    name: "tunnel_stop",
    description: "Stop a running cloudflared tunnel.",
    inputSchema: {
      type: "object",
      properties: {
        port: {
          type: "number",
          description: "The port of the tunnel to stop",
        },
      },
      required: ["port"],
    },
  },
  {
    name: "tunnel_list",
    description: "List all active cloudflared tunnels and their public URLs.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_skills",
    description:
      "List all available skills with their documentation and connection status. Use this to discover what capabilities (tools) are available to you and how to use them.",
    inputSchema: { type: "object", properties: {} },
  },
];

// ─── Skill documentation ─────────────────────────────────────────

/**
 * Return available skills with their SKILL.md documentation.
 * Used by the list_skills MCP tool so agents can self-discover capabilities.
 */
function getSkillDocs() {
  if (!_skillManager) return [];
  return _skillManager.getAllSkillDocs();
}

// ─── Skill tool discovery ───────────────────────────────────────

function getSkillTools() {
  verbose && console.log("[mcp] Discovering skill tools...");
  if (!_skillManager) return [];
  const tools = [];
  for (const runtime of _skillManager.listRuntimes()) {
    const r = _skillManager.getRuntime(runtime.name);
    if (r && r.status === "connected") {
      for (const t of r.getTools()) {
        tools.push({
          name: t.name,
          description: t.description,
          inputSchema: t.parameters || { type: "object", properties: {} },
        });
      }
    }
  }
  return tools;
}

// ─── Tool execution ─────────────────────────────────────────────

async function executeTool(name, args) {
  verbose && console.log(`[mcp] Executing tool: ${name} with args:`, args);
  switch (name) {
    case "remember": {
      db.memorySet(args.scope, args.key, args.value);
      return `Remembered: [${args.scope}] ${args.key}`;
    }
    case "recall": {
      const memories = db.memorySearch(args.scope, args.query);
      if (!memories || memories.length === 0) {
        return `No memories found in scope "${args.scope}"${args.query ? ` matching "${args.query}"` : ""}`;
      }
      return memories
        .map((m) => `[${m.key}] ${m.value.slice(0, 500)}`)
        .join("\n\n");
    }
    case "forget": {
      const deleted = db.memoryDelete(args.scope, args.key);
      return deleted
        ? `Forgot: [${args.scope}] ${args.key}`
        : `Not found: [${args.scope}] ${args.key}`;
    }
    case "send_message": {
      const channelManager = require("../channels/channel-manager");
      await channelManager.sendMessage(
        args.channelId,
        args.conversationId,
        args.content,
      );
      return `Message sent via ${args.channelId} to ${args.conversationId}`;
    }
    case "list_channels": {
      const channelManager = require("../channels/channel-manager");
      const channels = channelManager.getChannels();
      if (!channels || channels.length === 0) {
        return "No messaging channels configured.";
      }
      return channels
        .map(
          (ch) =>
            `[${ch.id}] ${ch.name} (${ch.type}) — ${ch.status}${ch.errorMessage ? ` (${ch.errorMessage})` : ""}`,
        )
        .join("\n");
    }
    case "read_channel_messages": {
      const limit = args.limit || 20;
      const msgs = db.channelMessageList(args.channelId, limit);
      if (!msgs || msgs.length === 0) {
        return `No messages found for channel ${args.channelId}`;
      }
      return msgs
        .map(
          (m) =>
            `[${m.direction}] ${m.sender ? m.sender + ": " : ""}${m.content.slice(0, 300)}${m.content.length > 300 ? "…" : ""} (${new Date(m.timestamp).toLocaleString()})`,
        )
        .join("\n");
    }
    case "tunnel_start": {
      const localUrl = args.url || `http://localhost:${args.port}`;
      const port = args.port || parseInt(localUrl.match(/:(\d+)/)?.[1], 10);
      const key = port || localUrl;

      // Reuse existing tunnel for this port
      if (_tunnels.has(key)) {
        const existing = _tunnels.get(key);
        return `Tunnel already running: ${existing.publicUrl}`;
      }

      // Kill any other active tunnels before starting a new one
      stopAllTunnels();

      // Ensure cloudflared is available (downloads on first use)
      let cloudflaredPath;
      try {
        cloudflaredPath = await ensureCloudflared();
      } catch (err) {
        return `Error setting up cloudflared: ${err.message}`;
      }

      // Spawn cloudflared
      let proc;
      try {
        proc = spawn(cloudflaredPath, ["tunnel", "--url", localUrl], {
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        return `Error starting cloudflared: ${err.message}`;
      }

      // Parse the public URL from cloudflared's stderr output
      const publicUrl = await new Promise((resolve, reject) => {
        let output = "";
        const timeout = setTimeout(() => {
          reject(
            new Error("Timed out waiting for cloudflared tunnel URL (15s)"),
          );
        }, 15_000);

        const onData = (data) => {
          output += data.toString();
          // cloudflared prints the URL to stderr like:
          // |  https://random-name.trycloudflare.com |
          const match = output.match(
            /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i,
          );
          if (match) {
            clearTimeout(timeout);
            resolve(match[0]);
          }
        };

        proc.stderr.on("data", onData);
        proc.stdout.on("data", onData);

        proc.on("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        });

        proc.on("exit", (code) => {
          if (code !== null && code !== 0) {
            clearTimeout(timeout);
            reject(
              new Error(
                `cloudflared exited with code ${code}. Output: ${output.slice(0, 500)}`,
              ),
            );
          }
        });
      });

      _tunnels.set(key, { proc, publicUrl, localUrl });

      // Clean up on process exit
      proc.on("exit", () => {
        _tunnels.delete(key);
      });

      return `Tunnel started!\nPublic URL: ${publicUrl}\nLocal: ${localUrl}\n\nAnyone with this link can access the local server while the tunnel is running.`;
    }
    case "tunnel_stop": {
      const stopKey = args.port;
      const tunnel = _tunnels.get(stopKey);
      if (!tunnel) {
        return `No active tunnel found for port ${args.port}`;
      }
      tunnel.proc.kill();
      _tunnels.delete(stopKey);
      return `Tunnel for port ${args.port} stopped.`;
    }
    case "tunnel_list": {
      if (_tunnels.size === 0) return "No active tunnels.";
      const lines = [];
      for (const [key, t] of _tunnels) {
        lines.push(`[port ${key}] ${t.publicUrl} → ${t.localUrl}`);
      }
      return lines.join("\n");
    }
    case "list_skills": {
      const sections = [];

      // Runtime-backed skills (with tools)
      const skills = getSkillDocs();
      for (const s of skills) {
        const statusTag = s.status === "connected" ? "✅ connected" : `⚠️ ${s.status}`;
        const doc = s.doc || "(no documentation)";
        sections.push(`## ${s.name} [${statusTag}]\n\n${doc}`);
      }

      // Custom skills (documentation-only, from DB)
      const customSkills = db.customSkillList();
      for (const cs of customSkills) {
        const emoji = cs.emoji ? `${cs.emoji} ` : "";
        sections.push(`## ${emoji}${cs.name} [📄 custom]\n\n${cs.content || cs.description || "(no documentation)"}`);
      }

      if (sections.length === 0) {
        return "No skills available.";
      }
      return sections.join("\n\n---\n\n");
    }
    default: {
      // Skill tools — resolve via tool index
      if (!_skillManager) return `Error: skill runtime manager not available`;
      const resolvedRuntime = _skillManager.resolveToolRuntime(name);
      if (!resolvedRuntime) return `Unknown tool: ${name}`;
      try {
        const result = await _skillManager.executeTool(
          resolvedRuntime,
          name,
          args,
        );
        return typeof result === "string"
          ? result
          : JSON.stringify(result, null, 2);
      } catch (err) {
        return `Error executing ${name}: ${err.message}`;
      }
    }
  }
}

// ─── MCP JSON-RPC handler ───────────────────────────────────────

async function handleMcpRequest(msg, agentId = null) {
  const { id, method, params } = msg;

  verbose &&
    console.log(`[mcp] Received request: ${method} with params:`, params);

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "outworked-skills", version: "0.2.0" },
        },
      };

    case "notifications/initialized":
      // No response needed for notifications
      return null;

    case "tools/list": {
      const skillTools = getSkillTools();
      return {
        jsonrpc: "2.0",
        id,
        result: { tools: [...BUILTIN_TOOLS, ...skillTools] },
      };
    }

    case "tools/call": {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      // Inject agentId from the session URL if not explicitly provided
      if (agentId && !toolArgs.agentId) {
        toolArgs.agentId = agentId;
      }
      try {
        const result = await executeTool(toolName, toolArgs);

        // Tools can return structured MCP content (e.g. images) via __mcp_content
        let content;
        if (result && typeof result === "object" && result.__mcp_content) {
          content = result.__mcp_content;
        } else {
          content = [
            {
              type: "text",
              text:
                typeof result === "string"
                  ? result
                  : JSON.stringify(result, null, 2),
            },
          ];
        }

        return {
          jsonrpc: "2.0",
          id,
          result: { content },
        };
      } catch (err) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: `Error: ${err.message}` }],
            isError: true,
          },
        };
      }
    }

    default:
      if (id !== undefined) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
      }
      return null;
  }
}

// ─── Streamable HTTP transport ──────────────────────────────────
// POST /mcp — receives JSON-RPC, responds with SSE or JSON
// GET  /mcp — SSE stream for server-initiated notifications (not used yet)
// DELETE /mcp — close session (no-op, stateless)

function start() {
  if (_server) return;

  _server = http.createServer(async (req, res) => {
    // CORS for local connections
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const reqUrl = new URL(req.url, "http://127.0.0.1");
    if (reqUrl.pathname !== "/mcp") {
      res.writeHead(404);
      res.end();
      return;
    }
    const _reqAgentId = reqUrl.searchParams.get("agentId") || null;

    if (req.method === "DELETE") {
      // Session termination — we're stateless so just acknowledge
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.method === "GET") {
      // SSE endpoint for server-initiated notifications
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      // Keep alive until client disconnects; no server notifications yet
      req.on("close", () => res.end());
      return;
    }

    if (req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        let msg;
        try {
          msg = JSON.parse(body);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32700, message: "Parse error" },
            }),
          );
          return;
        }

        const response = await handleMcpRequest(msg, _reqAgentId);

        if (!response) {
          // Notification — no response body, just 202
          res.writeHead(202);
          res.end();
          return;
        }

        // Respond as SSE (Streamable HTTP spec)
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        });
        res.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
        res.end();
      });
      return;
    }

    res.writeHead(405);
    res.end();
  });

  _server.listen(PORT, "127.0.0.1", () => {
    verbose &&
      console.log(`[mcp] MCP server listening on http://127.0.0.1:${PORT}/mcp`);
  });

  _server.on("error", (err) => {
    console.error(`[mcp] Server error: ${err.message}`);
  });
}

function stop() {
  if (_server) {
    _server.close();
    _server = null;
  }
}

/**
 * Kill all active cloudflared tunnels (call on app quit).
 */
function stopAllTunnels() {
  for (const [key, t] of _tunnels) {
    try {
      t.proc.kill();
    } catch {
      /* ignore */
    }
  }
  _tunnels.clear();
}

module.exports = { start, stop, setSkillManager, stopAllTunnels, PORT };
