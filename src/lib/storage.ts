import {
  Agent,
  AgentSkill,
  SubagentDef,
  McpServerInline,
  AGENT_COLORS,
  SPRITE_KEYS,
} from "./types";
import {
  readClaudeAgentFiles,
  writeClaudeAgentFile,
  getHomedir,
  AgentFileInfo,
  runClaudeCode,
} from "./terminal";
import { v4 as uuidv4 } from "uuid";
import { getSetting, setSetting, getSettingJSON, setSettingJSON } from "./settings";

const SKILLS_KEY = "outworked_skills";
const GLOBAL_SKILLS_KEY = "outworked_global_skills";

/** Parse outworked-skills JSON from frontmatter back into AgentSkill[] */
function parseOutworkedSkills(raw: unknown): AgentSkill[] {
  if (!raw) return [];
  try {
    const str = typeof raw === "string" ? raw : JSON.stringify(raw);
    const arr = JSON.parse(str);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((s: any) => s && s.id && s.name)
      .map((s: any) => ({
        id: s.id,
        name: s.name,
        content: s.content || "",
        description: s.description || "",
      }));
  } catch {
    return [];
  }
}

export function createAgent(
  partial: Partial<Agent>,
  claudeCodeDefault?: boolean,
): Agent {
  const idx = Math.floor(Math.random() * SPRITE_KEYS.length);
  return {
    id: uuidv4(),
    name: makeAgentName(),
    role: "Assistant",
    personality: "You are a helpful AI assistant working in the office.",
    model: "claude-code" ,
    provider: "claude-code",
    skills: [],
    position: { x: 3, y: 3 },
    status: "idle",
    currentThought: "",
    spriteKey: SPRITE_KEYS[idx],
    history: [],
    color: AGENT_COLORS[idx],
    todos: [],
    ...partial,
  };
}

// ─── App-level skills ──────────────────────────────────────────

export async function loadSkills(): Promise<AgentSkill[]> {
  if (typeof window === "undefined") return [];
  return getSettingJSON<AgentSkill[]>(SKILLS_KEY, []);
}

export async function saveSkills(skills: AgentSkill[]): Promise<void> {
  if (typeof window === "undefined") return;
  await setSettingJSON(SKILLS_KEY, skills);
}

// ─── Global skills (available to all agents) ──────────────────

export async function loadGlobalSkillIds(): Promise<string[]> {
  if (typeof window === "undefined") return [];
  return getSettingJSON<string[]>(GLOBAL_SKILLS_KEY, []);
}

export async function saveGlobalSkillIds(ids: string[]): Promise<void> {
  if (typeof window === "undefined") return;
  await setSettingJSON(GLOBAL_SKILLS_KEY, ids);
}

export function resetProject(agents: Agent[]): Agent[] {
  const cleared = agents.map((a) => ({
    ...a,
    history: [],
    todos: [],
    status: "idle" as const,
    currentThought: "",
    currentSessionId: undefined,
    sessionId: undefined,
  }));
  return cleared;
}

// ─── Claude Code agent file helpers ────────────────────────────

/**
 * Build the markdown content for a Claude Code agent .md file.
 * Takes the full Agent object and generates all outworked-* frontmatter fields.
 */
export function buildSubagentMd(agent: Agent, slug: string): string {
  const def: SubagentDef = agent.subagentDef || {
    description: agent.role || "Office assistant",
  };
  const body = agent.personality || `You are ${agent.name}. ${def.description}`;

  let fm = "---\n";

  // Outworked metadata fields
  fm += `outworked-id: ${agent.id}\n`;
  fm += `outworked-name: ${agent.name}\n`;
  fm += `outworked-role: ${agent.role}\n`;
  fm += `outworked-position: ${agent.position.x},${agent.position.y}\n`;
  fm += `outworked-sprite: ${agent.spriteKey}\n`;
  fm += `outworked-color: ${agent.color}\n`;
  if (agent.autoCreated) fm += `outworked-auto-created: true\n`;
  if (agent.isBoss) fm += `outworked-boss: true\n`;
  if (agent.skills && agent.skills.length > 0) {
    const skillRefs = agent.skills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description || "",
      content: s.content,
    }));
    fm += `outworked-skills: ${JSON.stringify(skillRefs)}\n`;
  }

  // Claude Code fields from subagentDef
  fm += `name: ${slug}\n`;
  fm += `description: ${def.description}\n`;
  if (def.tools && def.tools.length > 0) {
    fm += "tools:\n";
    for (const t of def.tools) fm += `  - ${t}\n`;
  }
  if (def.disallowedTools && def.disallowedTools.length > 0) {
    fm += "disallowedTools:\n";
    for (const t of def.disallowedTools) fm += `  - ${t}\n`;
  }
  if (def.model) fm += `model: ${def.model}\n`;
  if (def.permissionMode) fm += `permissionMode: ${def.permissionMode}\n`;
  if (def.maxTurns) fm += `maxTurns: ${def.maxTurns}\n`;
  if (def.isolation) fm += `isolation: ${def.isolation}\n`;
  if (def.background) fm += `background: true\n`;
  if (def.memory) fm += `memory: ${def.memory}\n`;
  if (def.criticalSystemReminder)
    fm += `criticalSystemReminder_EXPERIMENTAL: ${JSON.stringify(def.criticalSystemReminder)}\n`;
  if (def.thinking && def.thinking !== "adaptive")
    fm += `thinking: ${def.thinking}\n`;
  if (def.thinkingBudget) fm += `thinkingBudget: ${def.thinkingBudget}\n`;
  if (def.effort) fm += `effort: ${def.effort}\n`;
  if (def.skills && def.skills.length > 0) {
    fm += "skills:\n";
    for (const s of def.skills) fm += `  - ${s}\n`;
  }
  if (def.mcpServers && def.mcpServers.length > 0) {
    fm += "mcpServers:\n";
    for (const entry of def.mcpServers) {
      if (typeof entry === "string") {
        fm += `  - ${entry}\n`;
      } else {
        for (const [srvName, cfg] of Object.entries(entry)) {
          fm += `  - ${srvName}:\n`;
          if (cfg.type) fm += `      type: ${cfg.type}\n`;
          if (cfg.command) fm += `      command: ${cfg.command}\n`;
          if (cfg.args && cfg.args.length > 0) {
            fm += `      args:\n`;
            for (const a of cfg.args) fm += `        - ${JSON.stringify(a)}\n`;
          }
          if (cfg.url) fm += `      url: ${cfg.url}\n`;
          if (cfg.env && Object.keys(cfg.env).length > 0) {
            fm += `      env:\n`;
            for (const [k, v] of Object.entries(cfg.env)) {
              fm += `        ${k}: ${JSON.stringify(v)}\n`;
            }
          }
          if (cfg.headers && Object.keys(cfg.headers).length > 0) {
            fm += `      headers:\n`;
            for (const [k, v] of Object.entries(cfg.headers)) {
              fm += `        ${k}: ${JSON.stringify(v)}\n`;
            }
          }
        }
      }
    }
  }
  if (def.excludeGlobalSkills && def.excludeGlobalSkills.length > 0) {
    fm += "excludeGlobalSkills:\n";
    for (const id of def.excludeGlobalSkills) fm += `  - ${JSON.stringify(id)}\n`;
  }
  if (def.hooks && Object.keys(def.hooks).length > 0) {
    fm += "hooks:\n";
    for (const [event, matchers] of Object.entries(def.hooks)) {
      fm += `  ${event}:\n`;
      for (const m of matchers) {
        if (m.matcher) fm += `    - matcher: ${JSON.stringify(m.matcher)}\n`;
        else fm += `    - hooks:\n`;
        if (m.matcher) fm += `      hooks:\n`;
        for (const h of m.hooks) {
          const prefix = m.matcher ? "        " : "        ";
          fm += `${prefix}- type: ${h.type}\n`;
          fm += `${prefix}  command: ${JSON.stringify(h.command)}\n`;
        }
      }
    }
  }
  fm += "---\n\n";
  fm += body;
  return fm;
}

/**
 * Create a new Claude Code agent .md file.
 * scope='user' → ~/.claude/agents/  (default)
 * scope='project' → <workspaceDir>/.claude/agents/
 * Returns the file path if successful, null otherwise.
 */
export async function createClaudeAgentFile(
  agent: Agent,
  workspaceDir?: string,
): Promise<string | null> {
  // Assign an id if the agent doesn't have one (for migration)
  if (!agent.id) {
    agent = { ...agent, id: uuidv4() };
  }
  const slug =
    agent.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "agent";
  const scope = agent.agentScope || "user";
  let basePath: string;
  if (scope === "project" && workspaceDir) {
    basePath = `${workspaceDir}/.claude/agents`;
  } else {
    basePath = `${getHomedir()}/.claude/agents`;
  }
  const filePath = `${basePath}/${slug}.md`;
  const content = buildSubagentMd(agent, slug);
  const ok = await writeClaudeAgentFile(filePath, content);
  return ok ? filePath : null;
}

/**
 * Use Claude Code CLI to AI-generate a full agent .md file from a description.
 * Returns the generated file content, or null on failure.
 */
export async function generateAgentWithAI(
  description: string,
  opts: {
    name?: string;
    scope?: "user" | "project";
    workspaceDir?: string;
    onProgress?: (chunk: string) => void;
    skipWrite?: boolean;
  } = {},
): Promise<{ content: string; filePath: string } | null> {
  const systemPrompt = `You are an expert at creating Claude Code agent definition files. Given a description of the desired agent, generate a complete .md file with YAML frontmatter and a detailed system prompt body.

The file MUST follow this exact format:
---
outworked-name: <Display Name for the office UI>
outworked-role: <Short role title, e.g. "Frontend Developer", "QA Engineer">
name: <kebab-case-slug>
description: "<1-2 sentence description of when to delegate to this agent, used by Claude Code for routing>"
model: sonnet
---

<Detailed system prompt that defines the agent's expertise, responsibilities, and operational approach. Be thorough — include specific domain knowledge, methodologies, and behavioral guidelines. Use markdown formatting with headers and bullet points.>

Rules:
- outworked-name should be a human first name that fits the role
- outworked-role is a short job title (2-4 words)
- name is a kebab-case slug derived from the role
- description is for Claude Code delegation routing — explain WHEN and WHY to use this agent
- The body should be 200-500 words of detailed expertise and instructions
- Do NOT use any tools — just output the raw .md file content as text
- Do NOT wrap the output in markdown code fences — output the raw .md content directly
- Do NOT include any explanation before or after the file content
- Your ENTIRE response must be the .md file content starting with --- and nothing else`;

  const prompt = opts.name
    ? `Create a Claude Code agent file for an employee named "${opts.name}" with this role/description: ${description}`
    : `Create a Claude Code agent file for this role/description: ${description}`;

  try {
    // Use maxTurns: 1 to prevent Claude from using tools and force text-only output
    let fullText = "";
    const result = await runClaudeCode(
      {
        prompt,
        systemPrompt,
        cwd: opts.workspaceDir,
        maxTurns: 1,
        effort: "low",
        persistSession: false,
      },
      {
        onTextDelta: (text) => {
          fullText += text;
          opts.onProgress?.(text);
        },
      },
    );
    const output = (result.result || fullText).trim();

    // Strip any accidental code fences the LLM might wrap around the output
    let content = output;
    if (content.startsWith("```")) {
      content = content
        .replace(/^```[a-z]*\n?/, "")
        .replace(/\n?```$/, "")
        .trim();
    }

    // Try to extract frontmatter content from within the response
    // (Claude may include preamble text before the --- block)
    if (!content.startsWith("---")) {
      const fmStart = content.indexOf("\n---\n");
      if (fmStart !== -1) {
        content = content.slice(fmStart + 1).trim();
      } else {
        const altStart = content.indexOf("---\n");
        if (altStart > 0) {
          content = content.slice(altStart).trim();
        }
      }
    }

    // Validate we got valid frontmatter
    if (!content.startsWith("---")) {
      console.warn(
        "[generateAgentWithAI] Output did not contain valid frontmatter, got:",
        output.slice(0, 200),
      );
      return null;
    }

    // Extract the slug from the generated frontmatter to determine filename
    const nameMatch = content.match(/^name:\s*(.+)$/m);
    const slug = nameMatch
      ? nameMatch[1].trim()
      : (opts.name || "agent")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/(^-|-$)/g, "");

    const scope = opts.scope || "user";
    let basePath: string;
    if (scope === "project" && opts.workspaceDir) {
      basePath = `${opts.workspaceDir}/.claude/agents`;
    } else {
      basePath = `${getHomedir()}/.claude/agents`;
    }
    const filePath = `${basePath}/${slug}.md`;

    if (opts.skipWrite) {
      return { content, filePath };
    }
    const ok = await writeClaudeAgentFile(filePath, content);
    return ok ? { content, filePath } : null;
  } catch (err) {
    console.error("[generateAgentWithAI]", err);
    return null;
  }
}

/**
 * Parse YAML frontmatter from a Claude Code subagent .md file.
 * Returns the parsed SubagentDef + the markdown body (prompt).
 */
export function parseSubagentFrontmatter(content: string): {
  def: Partial<SubagentDef> & {
    name?: string;
    description?: string;
    "outworked-id"?: string;
    "outworked-name"?: string;
    "outworked-role"?: string;
    "outworked-position"?: string;
    "outworked-sprite"?: string;
    "outworked-color"?: string;
    "outworked-auto-created"?: boolean;
    "outworked-boss"?: boolean;
    "outworked-skills"?: unknown;
  };
  body: string;
} {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) {
    return { def: {}, body: content };
  }
  const endIdx = trimmed.indexOf("\n---", 3);
  if (endIdx === -1) {
    return { def: {}, body: content };
  }
  const fmText = trimmed.slice(3, endIdx).trim();
  const body = trimmed.slice(endIdx + 4).trim();

  // Parse full YAML frontmatter using indentation-aware parser
  const raw = parseYamlBlock(fmText);

  // Extract mcpServers: list of strings or {name: {type,command,args,url}} objects
  let mcpServers: SubagentDef["mcpServers"] | undefined;
  if (Array.isArray(raw.mcpServers)) {
    mcpServers = (raw.mcpServers as unknown[]).map((entry) => {
      if (typeof entry === "string") return entry;
      if (typeof entry === "object" && entry !== null) {
        const obj = entry as Record<string, unknown>;
        const result: Record<string, McpServerInline> = {};
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v === "object" && v !== null) {
            const cfg = v as Record<string, unknown>;
            result[k] = {
              type: (cfg.type as McpServerInline["type"]) || "stdio",
              command: cfg.command as string | undefined,
              args: Array.isArray(cfg.args) ? cfg.args.map(String) : undefined,
              url: cfg.url as string | undefined,
              env: typeof cfg.env === "object" && cfg.env !== null
                ? cfg.env as Record<string, string>
                : undefined,
              headers: typeof cfg.headers === "object" && cfg.headers !== null
                ? cfg.headers as Record<string, string>
                : undefined,
            };
          }
        }
        return result;
      }
      return String(entry);
    });
  }

  // Extract hooks: Record<string, HookMatcher[]>
  let hooks: SubagentDef["hooks"] | undefined;
  if (
    typeof raw.hooks === "object" &&
    raw.hooks !== null &&
    !Array.isArray(raw.hooks)
  ) {
    hooks = {};
    const hooksObj = raw.hooks as Record<string, unknown>;
    for (const [event, matcherList] of Object.entries(hooksObj)) {
      if (!Array.isArray(matcherList)) continue;
      hooks[event] = matcherList.map((m: unknown) => {
        const mObj = m as Record<string, unknown>;
        const hookCmds = Array.isArray(mObj.hooks)
          ? (mObj.hooks as Record<string, unknown>[]).map((h) => ({
              type: "command" as const,
              command: String(h.command || ""),
            }))
          : [];
        return {
          matcher: mObj.matcher ? String(mObj.matcher) : undefined,
          hooks: hookCmds,
        };
      });
    }
  }

  return {
    def: {
      name: raw.name as string | undefined,
      description: raw.description as string | undefined,
      tools: Array.isArray(raw.tools) ? raw.tools.map(String) : undefined,
      disallowedTools: Array.isArray(raw.disallowedTools)
        ? raw.disallowedTools.map(String)
        : undefined,
      model: raw.model as string | undefined,
      permissionMode: raw.permissionMode as string | undefined,
      maxTurns: typeof raw.maxTurns === "number" ? raw.maxTurns : undefined,
      skills: Array.isArray(raw.skills) ? raw.skills.map(String) : undefined,
      memory: raw.memory as SubagentDef["memory"] | undefined,
      background: raw.background as boolean | undefined,
      isolation: raw.isolation as SubagentDef["isolation"] | undefined,
      mcpServers,
      excludeGlobalSkills: Array.isArray(raw.excludeGlobalSkills)
        ? raw.excludeGlobalSkills.map(String)
        : undefined,
      hooks,
      criticalSystemReminder: raw["criticalSystemReminder_EXPERIMENTAL"] as string | undefined,
      thinking: raw.thinking as SubagentDef["thinking"] | undefined,
      thinkingBudget: typeof raw.thinkingBudget === "number" ? raw.thinkingBudget : undefined,
      effort: raw.effort as SubagentDef["effort"] | undefined,
      "outworked-id": raw["outworked-id"] as string | undefined,
      "outworked-name": raw["outworked-name"] as string | undefined,
      "outworked-role": raw["outworked-role"] as string | undefined,
      "outworked-position": raw["outworked-position"] as string | undefined,
      "outworked-sprite": raw["outworked-sprite"] as string | undefined,
      "outworked-color": raw["outworked-color"] as string | undefined,
      "outworked-auto-created":
        raw["outworked-auto-created"] === true ||
        raw["outworked-auto-created"] === "true"
          ? true
          : undefined,
      "outworked-boss":
        raw["outworked-boss"] === true || raw["outworked-boss"] === "true"
          ? true
          : undefined,
      "outworked-skills": raw["outworked-skills"],
    },
    body,
  };
}

/**
 * Simple indentation-aware YAML parser supporting scalars, lists, and nested maps.
 * Handles the subset of YAML used in Claude Code agent frontmatter.
 */
function parseYamlBlock(text: string): Record<string, unknown> {
  const lines = text.split("\n");
  return parseYamlLines(lines, 0).value as Record<string, unknown>;
}

function getIndent(line: string): number {
  const match = line.match(/^(\s*)/);
  return match ? match[1].length : 0;
}

function parseYamlLines(
  lines: string[],
  startIdx: number,
  parentIndent = -1,
): { value: Record<string, unknown>; endIdx: number } {
  const result: Record<string, unknown> = {};
  let i = startIdx;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const indent = getIndent(line);
    if (indent <= parentIndent) break; // dedented past our level

    // List item: "  - something"
    const listMatch = line.match(/^(\s*)-\s+(.*)/);
    if (listMatch) {
      // This is a list item at the current level — handled by the caller
      break;
    }

    // Key-value: "key: value" or "key:"
    const kvMatch = line.match(/^(\s*)([a-zA-Z_][\w-]*):\s*(.*)/);
    if (kvMatch) {
      const key = kvMatch[2];
      const rawVal = kvMatch[3].trim();

      if (rawVal) {
        // Inline value
        result[key] = parseScalar(rawVal);
        i++;
      } else {
        // Check what follows: list or nested map
        if (i + 1 < lines.length) {
          const nextLine = lines[i + 1];
          const nextTrimmed = nextLine.trim();
          const nextIndent = getIndent(nextLine);
          if (nextIndent > indent && nextTrimmed.startsWith("-")) {
            // It's a list
            const { value, endIdx } = parseYamlList(lines, i + 1, indent);
            result[key] = value;
            i = endIdx;
          } else if (nextIndent > indent) {
            // It's a nested map
            const { value, endIdx } = parseYamlLines(lines, i + 1, indent);
            result[key] = value;
            i = endIdx;
          } else {
            result[key] = "";
            i++;
          }
        } else {
          result[key] = "";
          i++;
        }
      }
    } else {
      i++;
    }
  }

  return { value: result, endIdx: i };
}

function parseYamlList(
  lines: string[],
  startIdx: number,
  parentIndent: number,
): { value: unknown[]; endIdx: number } {
  const result: unknown[] = [];
  let i = startIdx;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const indent = getIndent(line);
    if (indent <= parentIndent) break;

    const listMatch = line.match(/^(\s*)-\s+(.*)/);
    if (!listMatch) break;

    const itemIndent = getIndent(line);
    const itemVal = listMatch[2].trim();

    // Check if this is "- key: value" (inline map start)
    const inlineKv = itemVal.match(/^([a-zA-Z_][\w-]*):\s*(.*)/);
    if (inlineKv) {
      const key = inlineKv[1];
      const val = inlineKv[2].trim();

      if (val) {
        // "- key: value" — check for nested content below
        const mapItem: Record<string, unknown> = { [key]: parseScalar(val) };
        i++;
        // Collect any sibling keys at the same item indent + 2
        while (i < lines.length) {
          const nextLine = lines[i];
          if (!nextLine.trim()) {
            i++;
            continue;
          }
          const nextIndent = getIndent(nextLine);
          if (nextIndent <= itemIndent) break;
          const sibKv = nextLine.match(/^(\s*)([a-zA-Z_][\w-]*):\s*(.*)/);
          if (sibKv && nextIndent > itemIndent) {
            mapItem[sibKv[2]] = parseScalar(sibKv[3].trim());
            i++;
          } else break;
        }
        result.push(mapItem);
      } else {
        // "- key:" — nested content follows
        i++;
        if (i < lines.length) {
          const nextLine = lines[i];
          const nextIndent = getIndent(nextLine);
          const nextTrimmed = nextLine.trim();
          if (nextIndent > itemIndent && nextTrimmed.startsWith("-")) {
            const { value, endIdx } = parseYamlList(lines, i, itemIndent);
            result.push({ [key]: value });
            i = endIdx;
          } else if (nextIndent > itemIndent) {
            const { value, endIdx } = parseYamlLines(lines, i, itemIndent);
            result.push({ [key]: value });
            i = endIdx;
          } else {
            result.push({ [key]: "" });
          }
        } else {
          result.push({ [key]: "" });
        }
      }
    } else if (itemVal) {
      // Simple scalar list item
      result.push(parseScalar(itemVal));
      i++;
    } else {
      i++;
    }
  }

  return { value: result, endIdx: i };
}

function parseScalar(val: string): string | number | boolean {
  if (val === "true") return true;
  if (val === "false") return false;
  if (/^\d+$/.test(val)) return parseInt(val, 10);
  return stripQuotes(val);
}

function stripQuotes(val: string): string {
  if (
    (val.startsWith('"') && val.endsWith('"')) ||
    (val.startsWith("'") && val.endsWith("'"))
  ) {
    return val.slice(1, -1);
  }
  return val;
}

// ─── Disk-based agent loading / saving ─────────────────────────

const DEFAULT_BOSS_PERSONALITY =
  "You are the Boss, the office manager. Your ONLY role is delegation — you NEVER do implementation work yourself. You assign every task to the right employee using the Agent tool. You break complex requests into subtasks and delegate each one. You speak with authority but are fair and encouraging.";

/**
 * Load all agents from Claude Code .md files on disk.
 * This is the single source of truth — localStorage is not used for agents.
 */
export async function loadAgentsFromDisk(
  workspaceDir?: string,
): Promise<Agent[]> {
  let files: AgentFileInfo[];
  try {
    files = await readClaudeAgentFiles(workspaceDir);
  } catch {
    files = [];
  }

  const agents: Agent[] = [];
  // Track which files were missing outworked-id so we can rewrite them
  const filesToRewrite: { agent: Agent; slug: string; filePath: string }[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const { def, body } = parseSubagentFrontmatter(file.content);

    // Resolve outworked display fields
    const name =
      def["outworked-name"] || def.name || file.file.replace(/\.md$/, "");
    const role =
      def["outworked-role"] || def.description || "Claude Code Subagent";
    const personality = body || `You are ${name}. ${role}`;
    const isBoss = !!def["outworked-boss"];
    const autoCreated = !!def["outworked-auto-created"];

    // Resolve id — generate one if missing
    const hadId = !!def["outworked-id"];
    const id = def["outworked-id"] || uuidv4();

    // Resolve position
    let position: { x: number; y: number };
    const posStr = def["outworked-position"];
    if (posStr && /^\d+,\d+$/.test(posStr)) {
      const [px, py] = posStr.split(",").map(Number);
      position = { x: px, y: py };
    } else {
      position = {
        x: Math.floor(Math.random() * 10) + 2,
        y: Math.floor(Math.random() * 6) + 2,
      };
    }

    // Resolve sprite and color — use index as fallback
    const idx = i % SPRITE_KEYS.length;
    const spriteKey = def["outworked-sprite"] || SPRITE_KEYS[idx];
    const color = def["outworked-color"] || AGENT_COLORS[idx];

    // Build subagentDef
    const subagentDef: SubagentDef = {
      description: role,
      prompt: body || undefined,
      tools: def.tools,
      disallowedTools: def.disallowedTools,
      model: def.model,
      permissionMode: def.permissionMode,
      maxTurns: def.maxTurns,
      skills: def.skills,
      memory: def.memory,
      background: def.background,
      isolation: def.isolation,
      mcpServers: def.mcpServers,
      excludeGlobalSkills: def.excludeGlobalSkills,
      hooks: def.hooks,
    };

    const agent: Agent = {
      id,
      name,
      role,
      personality,
      model: "claude-code",
      provider: "claude-code",
      skills: parseOutworkedSkills(def["outworked-skills"]),
      position,
      spriteKey,
      color,
      isBoss,
      autoCreated,
      subagentFile: file.path,
      subagentDef,
      agentScope: file.scope,
      // Ephemeral defaults
      status: "idle",
      currentThought: "",
      history: [],
      todos: [],
    };

    agents.push(agent);

    // Queue file rewrite if it was missing outworked-id
    if (!hadId) {
      const slug = def.name || file.file.replace(/\.md$/, "");
      filesToRewrite.push({ agent, slug, filePath: file.path });
    }
  }

  // Rewrite files that were missing outworked-id
  for (const { agent, slug, filePath } of filesToRewrite) {
    const content = buildSubagentMd(agent, slug);
    await writeClaudeAgentFile(filePath, content);
  }

  // Ensure there is exactly one Boss agent; create boss.md if none found
  const hasBoss = agents.some((a) => a.isBoss);
  if (!hasBoss) {
    const bossIdx = 3 % SPRITE_KEYS.length; // yellow by default
    const bossAgent: Agent = createAgent(
      {
        name: "Boss",
        role: "Office Manager",
        personality: DEFAULT_BOSS_PERSONALITY,
        model: "claude-code",
        provider: "claude-code",
        position: { x: 7, y: 1 },
        spriteKey: SPRITE_KEYS[bossIdx],
        color: AGENT_COLORS[bossIdx],
        isBoss: true,
        agentScope: "user",
      },
      true,
    );

    const bossFilePath = await createClaudeAgentFile(bossAgent, workspaceDir);
    if (bossFilePath) {
      agents.unshift({ ...bossAgent, subagentFile: bossFilePath });
    } else {
      // Even if writing failed, include the boss in memory
      agents.unshift(bossAgent);
    }
  }

  return agents;
}

/**
 * Save an agent back to its .md file on disk.
 * Uses agent.subagentFile for the path; falls back to createClaudeAgentFile() if not set.
 */
export async function saveAgentToDisk(
  agent: Agent,
  workspaceDir?: string,
): Promise<void> {
  if (!agent.subagentFile) {
    await createClaudeAgentFile(agent, workspaceDir);
    return;
  }

  const slug =
    agent.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "agent";
  const content = buildSubagentMd(agent, slug);
  await writeClaudeAgentFile(agent.subagentFile, content);
}

// ─── One-time localStorage migration ───────────────────────────

/**
 * Migrate agents from localStorage to .md files on disk.
 * Returns true if migration was performed, false if nothing to migrate.
 */
export async function migrateLocalStorageAgents(
  workspaceDir?: string,
): Promise<boolean> {
  if (typeof window === "undefined") return false;

  const raw = localStorage.getItem("outworked_agents");
  if (!raw) return false;

  let agents: Agent[];
  try {
    agents = JSON.parse(raw) as Agent[];
  } catch {
    localStorage.removeItem("outworked_agents");
    return false;
  }

  // Write a .md file for each agent that doesn't already have one
  for (const agent of agents) {
    if (!agent.subagentFile) {
      await createClaudeAgentFile(agent, workspaceDir);
    }
  }

  localStorage.removeItem("outworked_agents");
  return true;
}

export function makeAgentName() {
  const names = [
    "Alex",
    "Sam",
    "Charlie",
    "Taylor",
    "Jordan",
    "Morgan",
    "Casey",
    "Riley",
    "Jamie",
    "Drew",
  ];
  return names[Math.floor(Math.random() * names.length)];
}
