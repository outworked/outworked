import {
  Agent,
  AgentSkill,
  AgentTodo,
  ApiKeys,
  Message,
  SubagentDef,
} from "./types";
import { sendMessage } from "./ai";
import { PermissionRequest } from "./terminal";
import { getSetting } from "./settings";
import {
  listFiles,
  listAllFiles,
  readFile,
  writeFile,
  searchFiles,
} from "./filesystem";
import {
  runClaudeCode,
  ClaudeCodeAdvancedOptions,
  ClaudeCodeStreamCallbacks,
} from "./terminal";
import { getWorkspace } from "./filesystem";

/** Extract the last meaningful snippet from cumulative streaming text for thought bubbles. */
function tailThought(text: string, maxLen = 70): string {
  const lines = text.split("\n").filter((l) => l.trim());
  const last = lines.length > 0 ? lines[lines.length - 1].trim() : text.trim();
  if (last.length <= maxLen) return last;
  return "..." + last.slice(last.length - maxLen + 3);
}

export interface NewAgentSpec {
  name: string;
  role: string;
  personality: string;
}

export interface TaskAssignment {
  agentId: string;
  agentName: string;
  task: string;
  subtasks: string[]; // concrete action items that break down the task
  group?: number; // tasks in same group run in parallel; groups execute sequentially (1, then 2, etc.)
}

export interface OrchestrationResult {
  assignments: TaskAssignment[];
  plan: string;
  newAgents: NewAgentSpec[];
  workingDirectory: string;
  directAnswer?: string;
  cost?: number;
  inputTokens?: number;
  outputTokens?: number;
}

// If one of the existing directories matches the prompt (e.g. same project name or topic), reuse it as the workingDirectory.
// You might be in a situation where the instruction is related to the current directory (e.g. "Improve the recipe-api") — in that case, work in the current directory as the workingDirectory and assign tasks accordingly.
// Otherwise, pick a short, descriptive slug for a NEW workingDirectory (lowercase, hyphens, no spaces — like "recipe-api" or "landing-page").

const ROUTER_SYSTEM = `You are the Office Manager. You receive high-level instructions and break them into tasks assigned to specific employees.

You will be given a list of current employees with their names, roles, and what they're good at. Given the user's instruction, decide which employee(s) should handle which part of the work. Not every employee needs to be assigned a task — only assign relevant ones.

HIRING NEW SPECIALISTS — this is critical:
- If a task requires expertise that no current employee's role covers well, you MUST create a new specialist agent for it. Do NOT force-fit tasks onto employees whose roles don't match.
- Role fit matters: a "UX Designer" should not be assigned backend API work. A "Frontend Engineer" should not be assigned database schema design. If the match is poor, hire someone new.
- Examples of when to hire: the task needs a backend engineer but you only have frontend/design people; the task needs a data scientist but you only have engineers; the task involves DevOps but no one has that role.
- When in doubt about fit, prefer creating a specialist over assigning to a mismatched employee. Specialists produce better results.

You will also be given:
- A list of existing project directories in the workspace
- A file tree showing ALL files in the workspace (paths + sizes only)
- The contents of relevant files (config files + files matching the instruction's keywords)
Use the file tree for orientation and the file contents to understand what already exists — this is critical for making informed routing decisions. For example, if the project already has a package.json, you know the tech stack; if it has certain source files, you can assign tasks that build on them rather than starting from scratch.


IMPORTANT: If the instruction is a simple question, informational request, or something you can answer directly from the file tree and file contents provided (e.g. "how do I run this?", "what does X do?", "explain Y", "what tech stack is this?"), respond with a direct answer instead of delegating. Use this format:
{
  "directAnswer": "Your helpful answer here. You can use markdown formatting.",
  "plan": "Answered directly",
  "workingDirectory": "",
  "newAgents": [],
  "assignments": []
}

For implementation tasks (writing code, creating files, building features, fixing bugs), delegate to employees. RESPOND in this exact JSON format and nothing else:
{
  "plan": "Brief summary of the plan",
  "workingDirectory": "short-slug",
  "newAgents": [
    { "name": "UniqueFirstName", "role": "Job Title", "personality": "Detailed system prompt for this specialist" }
  ],
  "assignments": [
    { "agentName": "ExactEmployeeName", "task": "Specific task description for this employee", "subtasks": ["First concrete step", "Second concrete step"], "group": 1 }
  ]
}

Rules:
- Create new specialist agents whenever the task needs skills that existing employees' roles don't cover. Each new agent must have a distinct name, a clear role, and a detailed personality prompt that defines their expertise.
- "newAgents" should be empty ONLY when existing employees' roles are a genuinely good fit for every part of the task
- You may create up to 5 new employees per instruction
- You may assign tasks to both existing AND newly created employees
- Use EXACT employee names (existing or newly created) in assignments
- NEVER assign tasks to yourself (the Office Manager / Boss). You plan and coordinate — employees execute.
- Each assignment should be a clear, actionable task
- Each assignment MUST include a "subtasks" array: 2-5 short, concrete action items that break down the task
- You may assign multiple tasks to one employee or spread across employees
- All employees share the same project working directory — coordinate their work so they don't overwrite each other
- The workingDirectory should be reused if an existing directory is relevant, or a new short slug if not

PARALLEL EXECUTION — "group" field:
- Each assignment MUST have a "group" number (integer starting at 1)
- Tasks with the SAME group number run IN PARALLEL (simultaneously)
- Groups execute in ascending order: all group 1 tasks finish before group 2 starts, etc.
- If tasks are independent (e.g. frontend + backend, different files), put them in the SAME group
- If task B depends on the output of task A, put A in a LOWER group number than B
- If ALL tasks are independent, put them ALL in group 1
- Maximize parallelism — only use sequential groups when there's a real dependency

WEB PREVIEW — serving and sharing websites:
- When a task involves creating a website, landing page, or any HTML/frontend project, the FINAL subtask for the responsible agent MUST be to start a local web server (e.g. "npx serve ." or "npx serve dist" or "npm run dev") so the user can preview the result.
- The app will automatically detect the local server URL and open a preview window for the user.
- Do NOT tell the agent to open a browser — just start the server. The preview is handled automatically.
- To share the site with someone externally, the agent should use the tunnel_start tool to get a public URL, then use send_message to share the link via iMessage or Slack.

TUNNEL HOST CONFIG — IMPORTANT when using tunnel_start:
- Tunnels expose local servers via a public URL with a different hostname. Dev servers like Vite and Next.js block requests from unknown hosts by default, so the tunnel will show errors unless you configure them first.
- For Vite projects: before starting the dev server, ensure vite.config.ts/js has server.allowedHosts set to true (e.g. server: { host: true, allowedHosts: true }).
- For Next.js projects (v15+): ensure next.config.js/ts has allowedDevOrigins: ['*.trycloudflare.com'] (or a wildcard that covers the tunnel domain).
- For plain "npx serve" or static file servers: no configuration needed — they accept all hosts.
- The agent MUST apply these config changes BEFORE starting the dev server, not after.`;

/**
 * Extract and parse a JSON object from an LLM reply that may contain
 * markdown fences, preamble text, or trailing commas.
 */
function extractJson(reply: string): Record<string, unknown> {
  let jsonStr = reply;

  // Try markdown code block first
  const codeBlockMatch = reply.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  } else {
    // Find the outermost { … }
    const firstBrace = reply.indexOf("{");
    const lastBrace = reply.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      jsonStr = reply.slice(firstBrace, lastBrace + 1);
    }
  }

  // Strip trailing commas before } or ] (common LLM mistake)
  jsonStr = jsonStr.replace(/,\s*([}\]])/g, "$1");

  return JSON.parse(jsonStr);
}

/** JSON Schema for the router's structured output — matches OrchestrationResult */
const ROUTER_OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    plan: { type: "string", description: "Brief summary of the plan" },
    workingDirectory: { type: "string", description: "Short slug for the working directory" },
    directAnswer: { type: "string", description: "Direct answer if no delegation needed" },
    newAgents: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          role: { type: "string" },
          personality: { type: "string" },
        },
        required: ["name", "role", "personality"],
      },
    },
    assignments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          agentName: { type: "string" },
          task: { type: "string" },
          subtasks: { type: "array", items: { type: "string" } },
          group: { type: "number" },
        },
        required: ["agentName", "task", "subtasks", "group"],
      },
    },
  },
  required: ["plan", "workingDirectory", "newAgents", "assignments"],
};

export async function routeTasks(
  instruction: string,
  agents: Agent[],
  keys: ApiKeys,
  routerModel: { model: Agent["model"]; provider: Agent["provider"] },
  signal?: AbortSignal,
  onStream?: (text: string) => void,
  onPermissionRequest?: (request: PermissionRequest) => void,
): Promise<OrchestrationResult> {
  const employeeList = agents
    .map((a) => `- ${a.name} (${a.role}): ${a.personality.slice(0, 120)}`)
    .join("\n");

  // List top-level directories in the workspace so the router can reuse one
  const existingDirs = await listFiles();
  const dirList = existingDirs
    .split("\n")
    .filter((p) => p.endsWith("/"))
    .map((p) => p.replace(/\/$/, ""))
    .filter(Boolean);
  const dirsSection =
    dirList.length > 0
      ? `## Existing project directories\n${dirList.map((d) => `- ${d}`).join("\n")}`
      : "## Existing project directories\n(none)";

  // ─── Selective file reading ──────────────────────────────────────
  // Instead of reading the entire codebase, we:
  // 1. Always include the file tree (metadata only) for orientation
  // 2. Always read key config files (package.json, tsconfig, etc.)
  // 3. Search for files relevant to the instruction by keyword
  // 4. Only read matched files, within a budget
  const MAX_FILE_SIZE = 12_000;
  const MAX_TOTAL_CHARS = 60_000;
  const allFiles = await listAllFiles();

  // Build compact file tree (paths + sizes) — cheap context for the router
  const fileTree = allFiles.map((f) => `  ${f.path} (${f.size}b)`).join("\n");
  const treeSection =
    allFiles.length > 0
      ? `## File tree (${allFiles.length} files)\n${fileTree}`
      : "## File tree\n(empty workspace)";

  // Key config files the router should always see
  const CONFIG_PATTERNS = [
    "package.json",
    "tsconfig.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "Gemfile",
    "requirements.txt",
    "Makefile",
    "Dockerfile",
    "docker-compose.yml",
    "docker-compose.yaml",
    ".env.example",
    "README.md",
    "readme.md",
  ];
  const configPaths = new Set(
    allFiles
      .filter((f) =>
        CONFIG_PATTERNS.some((p) => f.path === p || f.path.endsWith("/" + p)),
      )
      .map((f) => f.path),
  );

  // Extract keywords from the instruction for targeted search
  const keywords = extractKeywords(instruction);

  // Search for files matching those keywords
  const searchResults =
    keywords.length > 0 ? await searchFiles(keywords, 30) : [];

  // Merge config files + search results, deduplicated
  const filesToRead = new Set<string>([...configPaths]);
  for (const r of searchResults) {
    filesToRead.add(r.path);
  }

  // Read selected files within budget
  let totalChars = 0;
  const fileContents: string[] = [];
  const allFileMap = new Map(allFiles.map((f) => [f.path, f]));

  for (const filePath of filesToRead) {
    const meta = allFileMap.get(filePath);
    if (!meta) continue;
    if (meta.size > MAX_FILE_SIZE) {
      fileContents.push(
        `### ${meta.path}\n(skipped — ${meta.size} bytes, too large)`,
      );
      continue;
    }
    if (totalChars + meta.size > MAX_TOTAL_CHARS) {
      fileContents.push(`### ${meta.path}\n(skipped — context budget reached)`);
      continue;
    }
    const content = await readFile(meta.path);
    if (content.startsWith("Error:")) {
      fileContents.push(`### ${meta.path}\n(could not read)`);
      continue;
    }
    fileContents.push(`### ${meta.path}\n\`\`\`\n${content}\n\`\`\``);
    totalChars += content.length;
  }

  const filesSection =
    fileContents.length > 0
      ? `## Relevant files (${fileContents.length} of ${allFiles.length} total)\n${fileContents.join("\n\n")}`
      : "## Workspace files\n(no relevant files found)";

  const prompt = `## Employees\n${employeeList}\n\n${dirsSection}\n\n${treeSection}\n\n${filesSection}\n\n## Instruction\n${instruction}`;

  // Create a temporary "router" agent
  const routerAgent: Agent = {
    id: "__router__",
    name: "Office Manager",
    role: "Router",
    personality: ROUTER_SYSTEM,
    model: routerModel.model,
    provider: routerModel.provider,
    skills: [],
    position: { x: 0, y: 0 },
    status: "thinking",
    currentThought: "",
    spriteKey: "",
    history: [],
    color: "#888",
    todos: [],
  };

  const MAX_ROUTE_ATTEMPTS = 2;
  let lastErr: unknown;
  let lastRawReply = "";
  let routerCost = 0;
  let routerInputTokens = 0;
  let routerOutputTokens = 0;

  for (let attempt = 0; attempt < MAX_ROUTE_ATTEMPTS; attempt++) {
    const result = await sendMessage(
      routerAgent,
      attempt === 0
        ? prompt
        : `${prompt}\n\nIMPORTANT: Respond ONLY with a valid JSON object. No markdown, no explanation — just the raw JSON.`,
      keys,
      onStream ?? (() => {}),
      signal,
      {
        useTools: true,
        onPermissionRequest,
        outputFormat: { type: "json_schema", schema: ROUTER_OUTPUT_SCHEMA },
      },
    );
    // Prefer structuredOutput (validated JSON from SDK) over freeform text
    const reply = result.structuredOutput
      ? JSON.stringify(result.structuredOutput)
      : result.text;
    if (result.cost) routerCost = result.cost;
    if (result.inputTokens) routerInputTokens = result.inputTokens;
    if (result.outputTokens) routerOutputTokens = result.outputTokens;
    lastRawReply = reply;

    // If the reply has no JSON structure at all, treat it as a direct answer
    // immediately instead of retrying.
    if (!result.structuredOutput && !reply.includes("{")) {
      return {
        assignments: [],
        plan: "Answered directly",
        newAgents: [],
        workingDirectory: "",
        directAnswer: reply,
        cost: routerCost,
        inputTokens: routerInputTokens,
        outputTokens: routerOutputTokens,
      };
    }

    try {
      // Use structured output directly if available (pre-validated by SDK),
      // otherwise fall back to extracting JSON from freeform text.
      const parsed = result.structuredOutput
        ? (result.structuredOutput as Record<string, unknown>)
        : extractJson(reply);

      // Parse new agent specs
      const newAgents: NewAgentSpec[] = ((parsed.newAgents || []) as Array<{ name: string; role: string; personality: string }>).map(
        (a: { name: string; role: string; personality: string }) => ({
          name: a.name,
          role: a.role,
          personality: a.personality,
        }),
      );

      const assignments: TaskAssignment[] = ((parsed.assignments || []) as Array<{
          agentName: string;
          task: string;
          subtasks?: string[];
          group?: number;
        }>).map(
        (a) => {
          const agent = agents.find(
            (ag) => ag.name.toLowerCase() === a.agentName.toLowerCase(),
          );
          return {
            agentId: agent?.id ?? "", // empty string means it's a new agent — resolved after creation
            agentName: a.agentName,
            task: a.task,
            subtasks:
              Array.isArray(a.subtasks) && a.subtasks.length > 0
                ? a.subtasks.map(String)
                : [a.task], // fallback: use the whole task as a single subtask
            group: typeof a.group === "number" ? a.group : 1,
          };
        },
      );

      // If the boss answered directly, return immediately without needing a working directory.
      // The LLM may use various keys: directAnswer, response, answer, message, reply, etc.
      const directText = (parsed.directAnswer ?? parsed.response ?? parsed.answer ?? parsed.message ?? parsed.reply) as string | undefined;
      if (directText && assignments.length === 0) {
        return {
          assignments: [],
          plan: (parsed.plan as string) || "Answered directly",
          newAgents: [],
          workingDirectory: "",
          directAnswer: directText,
          cost: routerCost,
          inputTokens: routerInputTokens,
          outputTokens: routerOutputTokens,
        };
      }

      // Ensure the working directory exists
      const workDir = sanitizeSlug((parsed.workingDirectory as string) || "project");
      await ensureWorkingDirectory(workDir);

      return {
        assignments,
        plan: (parsed.plan as string) || "",
        newAgents,
        workingDirectory: workDir,
        cost: routerCost,
        inputTokens: routerInputTokens,
        outputTokens: routerOutputTokens,
      };
    } catch (err) {
      lastErr = err;
      console.warn(
        `[orchestrator] Route attempt ${attempt + 1} failed:`,
        err,
        "\nRaw reply:",
        reply.slice(0, 500),
      );
      // Loop will retry
    }
  }

  // All attempts failed — the LLM likely replied in plain text (e.g. answering
  // a simple question directly instead of producing JSON).  Treat the raw reply
  // as a direct answer so the boss can respond without delegating.
  console.warn("[orchestrator] All route attempts failed. Using raw reply as direct answer.");
  return {
    plan: "Answered directly",
    assignments: [],
    newAgents: [],
    workingDirectory: "",
    directAnswer: lastRawReply || "I wasn't able to process that request. Could you try rephrasing?",
    cost: routerCost,
    inputTokens: routerInputTokens,
    outputTokens: routerOutputTokens,
  };
}

/**
 * Extract meaningful keywords from an instruction for targeted file search.
 * Filters out common stop words and short words, returns unique terms.
 */
function extractKeywords(instruction: string): string[] {
  const STOP_WORDS = new Set([
    "a",
    "an",
    "the",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "could",
    "should",
    "may",
    "might",
    "can",
    "shall",
    "to",
    "of",
    "in",
    "for",
    "on",
    "with",
    "at",
    "by",
    "from",
    "as",
    "into",
    "through",
    "during",
    "before",
    "after",
    "above",
    "below",
    "between",
    "out",
    "off",
    "over",
    "under",
    "again",
    "further",
    "then",
    "once",
    "here",
    "there",
    "when",
    "where",
    "why",
    "how",
    "all",
    "each",
    "every",
    "both",
    "few",
    "more",
    "most",
    "other",
    "some",
    "such",
    "no",
    "not",
    "only",
    "same",
    "so",
    "than",
    "too",
    "very",
    "just",
    "because",
    "but",
    "and",
    "or",
    "if",
    "while",
    "about",
    "up",
    "this",
    "that",
    "these",
    "those",
    "it",
    "its",
    "i",
    "me",
    "my",
    "we",
    "our",
    "you",
    "your",
    "he",
    "she",
    "they",
    "them",
    "what",
    "which",
    "who",
    "whom",
    "make",
    "create",
    "build",
    "add",
    "update",
    "change",
    "fix",
    "implement",
    "write",
    "use",
    "get",
    "set",
    "new",
    "also",
    "like",
    "need",
    "want",
    "please",
    "help",
  ]);

  // Extract words, camelCase splits, and quoted/path-like terms
  const words = instruction
    .replace(/[^a-zA-Z0-9_./\-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  const keywords: string[] = [];
  const seen = new Set<string>();

  for (const word of words) {
    // Split camelCase: "userProfile" → ["user", "profile"]
    const parts = word
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/\s+/);

    for (const part of parts) {
      if (part.length < 3) continue;
      if (STOP_WORDS.has(part)) continue;
      if (seen.has(part)) continue;
      seen.add(part);
      keywords.push(part);
    }

    // Also keep the original word if it looks like a path or compound term
    const lower = word.toLowerCase();
    if (
      (word.includes("/") ||
        word.includes(".") ||
        word.includes("-") ||
        word.includes("_")) &&
      !seen.has(lower)
    ) {
      seen.add(lower);
      keywords.push(lower);
    }
  }

  // Limit to top 10 keywords to keep search focused
  return keywords.slice(0, 10);
}

/**
 * Sanitise a router-suggested directory name into a safe slug.
 */
function sanitizeSlug(raw: string): string {
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 64) || "project"
  );
}

/**
 * Create the working directory if it doesn't already exist.
 * Uses writeFile with a marker file since the filesystem auto-creates parent dirs.
 */
async function ensureWorkingDirectory(dir: string): Promise<void> {
  const listing = await listFiles(dir);
  // If the directory already has files, it exists — nothing to do
  if (!listing.startsWith("No files")) return;
  // Create an empty marker so the directory is created
  await writeFile(
    `${dir}/.outworked`,
    `# Working directory created ${new Date().toISOString()}\n`,
  );
}

/**
 * Execute a task assignment by sending it to the agent's chat
 */
export async function executeTask(
  agent: Agent,
  task: string,
  keys: ApiKeys,
  onThought: (text: string) => void,
  signal?: AbortSignal,
  skills?: AgentSkill[],
  workingDirectory?: string,
  customToolExecutor?: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<string | null>,
  colleagues?: { name: string; role: string }[],
  onToolCall?: (call: { name: string; args: Record<string, unknown> }) => void,
  onClaudeCodeEvent?: (event: { type: string; toolName?: string; toolInput?: Record<string, unknown>; text?: string }) => void,
  onSlow?: (agentName: string) => void,
  onStuck?: (agentName: string) => void,
  onPermissionRequest?: (request: PermissionRequest) => void,
): Promise<{
  agent: Agent;
  reply: string;
  cost?: number;
  inputTokens?: number;
  outputTokens?: number;
}> {
  // Two-tier stuck detection:
  // - "slow" at 5 minutes: soft warning, no abort
  // - "stuck" at 10 minutes: enables abort
  const SLOW_TIMEOUT_MS = 300_000;
  const STUCK_TIMEOUT_MS = 600_000;
  let lastActivity = Date.now();
  let slowFired = false;
  let stuckFired = false;

  const stuckCheckInterval = (onSlow || onStuck)
    ? setInterval(() => {
        const elapsed = Date.now() - lastActivity;
        if (!slowFired && elapsed > SLOW_TIMEOUT_MS) {
          slowFired = true;
          onSlow?.(agent.name);
        }
        if (!stuckFired && elapsed > STUCK_TIMEOUT_MS) {
          stuckFired = true;
          onStuck?.(agent.name);
        }
      }, 15_000)
    : null;

  // Wrap callbacks to track activity timestamps
  const resetActivity = () => {
    lastActivity = Date.now();
    slowFired = false;
    stuckFired = false;
  };
  const wrappedOnThought = (text: string) => {
    resetActivity();
    onThought(text);
  };
  const wrappedOnToolCall = onToolCall
    ? (call: { name: string; args: Record<string, unknown> }) => {
        resetActivity();
        onToolCall(call);
      }
    : undefined;
  const wrappedOnClaudeCodeEvent = onClaudeCodeEvent
    ? (event: { type: string; toolName?: string; toolInput?: Record<string, unknown>; text?: string }) => {
        resetActivity();
        onClaudeCodeEvent(event);
      }
    : undefined;

  // Build a strong system-level directive so agents respect the working directory
  const extraSystemPrompt = workingDirectory
    ? `\n\n## IMPORTANT — Project Directory\nThis project's root is "${workingDirectory}/". You MUST:\n- Prefix EVERY file path with "${workingDirectory}/" (e.g. "${workingDirectory}/src/index.js", NOT "src/index.js")\n- Pass cwd: "${workingDirectory}" to every run_command call\n- NEVER write files to paths outside "${workingDirectory}/"\nViolating this will break the project structure.`
    : undefined;

  const userMsg: Message = {
    role: "user",
    content: `[OFFICE TASK] ${task}\n\nComplete each step in order. If you need to write code, include it in code blocks. Explain what you did briefly.${workingDirectory ? ` Remember: all files go under ${workingDirectory}/.` : ""}`,
    timestamp: Date.now(),
  };

  // When resuming a Claude Code session, the session already holds the full
  // conversation history.  Passing the local history array again just doubles
  // the input tokens.  Keep only the new user message on the JS side — the
  // ai layer will detect the sessionId and send only the latest prompt.
  const trimmedHistory = agent.sessionId ? [] : agent.history;

  const updatedAgent: Agent = {
    ...agent,
    history: [...trimmedHistory, userMsg],
    status: "working",
    currentThought: "Working on task...",
  };

  try {
    const result = await sendMessage(
      updatedAgent,
      userMsg.content,
      keys,
      wrappedOnThought,
      signal,
      {
        skills,
        extraSystemPrompt,
        customToolExecutor,
        colleagues,
        onToolCall: wrappedOnToolCall,
        onClaudeCodeEvent: wrappedOnClaudeCodeEvent,
        onPermissionRequest,
      },
    );

    const assistantMsg: Message = {
      role: "assistant",
      content: result.text,
      timestamp: Date.now(),
    };

    return {
      agent: {
        ...updatedAgent,
        // Only keep the latest exchange in local history — the full
        // conversation lives in the Claude Code session.
        history: agent.sessionId
          ? [userMsg, assistantMsg]
          : [...updatedAgent.history, assistantMsg],
        status: "idle",
        currentThought: tailThought(result.text, 80),
      },
      reply: result.text,
      cost: result.cost,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };
  } catch (err) {
    // Attach an agent snapshot with idle status so callers can recover
    // the agent state without manually resetting it.
    const error = err instanceof Error ? err : new Error(String(err));
    (error as Error & { agent?: Agent }).agent = {
      ...updatedAgent,
      status: "idle",
      currentThought: "",
    };
    throw error;
  } finally {
    if (stuckCheckInterval) clearInterval(stuckCheckInterval);
  }
}

/**
 * Ask the agent to break a task into a checklist of to-do items.
 */
// ─── Claude Code Agent Teams orchestration ────────────────────

export interface AgentTeamCallbacks {
  onTeamEvent?: (event: {
    agentName?: string;
    type: string;
    text?: string;
  }) => void;
  onAgentStatus?: (
    agentName: string,
    status: "working" | "done" | "waiting-input" | "waiting-approval" | "slow" | "stuck",
    thought?: string,
  ) => void;
  /** Called when the boss delegates to a specific agent with a task */
  onAgentDelegation?: (agentName: string, task: string) => void;
  /** Called when the boss delegates to an agent name not in the roster — allows dynamic creation */
  onNewAgent?: (agentName: string, description: string) => void;
  /** Per-agent text streaming — routes text deltas to the active agent */
  onAgentStreamDelta?: (agentName: string, delta: string, fullText: string) => void;
  /** Per-agent tool use — fires when an agent (not the boss) uses a tool */
  onAgentToolUse?: (agentName: string, toolName: string, input: Record<string, unknown>) => void;
  /** Called when a permission request event is received for the team */
  onPermissionRequest?: (
    agentName: string | undefined,
    tool: string,
    description: string,
    reqId?: number,
    permId?: string,
  ) => void;
}

/**
 * Route tasks through Claude Code Agent Teams.
 * The Boss becomes the team lead, and all subagent-backed employees
 * become teammates. Claude Code handles the orchestration natively.
 *
 * If Claude Code delegates to an agent not in the existing roster,
 * the `onNewAgent` callback fires so the UI can create the employee.
 */
export async function routeTasksViaClaudeCode(
  instruction: string,
  agents: Agent[],
  callbacks: AgentTeamCallbacks,
  signal?: AbortSignal,
  onDebug?: (line: string) => void,
  sessionId?: string,
  enableAgentTeams?: boolean,
): Promise<{
  text: string;
  sessionId?: string;
  cost?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Per-agent cost breakdown (time-proportional distribution of total cost) */
  agentCosts?: Record<string, { cost: number; inputTokens: number; outputTokens: number }>;
  /** Names of agents that were delegated to */
  delegatedAgents?: string[];
}> {
  const workspace = await getWorkspace();

  // Build subagent definitions from all subagent-backed employees
  const agentDefs: Record<string, SubagentDef> = {};
  const knownNames = new Set<string>();
  const bossAgent = agents.find((a) => a.isBoss);
  const bossName = bossAgent?.name?.toLowerCase() || "boss";
  for (const a of agents) {
    if (a.isBoss) continue;
    knownNames.add(a.name.toLowerCase());
    if (a.subagentDef) {
      agentDefs[a.name] = a.subagentDef;
    } else {
      // Create a synthetic subagent def from the regular agent's personality
      agentDefs[a.name] = {
        description: a.role,
        prompt: a.personality,
      };
    }
  }

  // Track dynamically-created agents so we only fire onNewAgent once per name
  const createdAgents = new Set<string>();

  // Build a system prompt that tells the boss to delegate to its team
  const agentNames = Object.keys(agentDefs);
  const agentRoster = agentNames
    .map((name) => {
      const def = agentDefs[name];
      return `- **${name}** (use agent="${name}"): ${def.description}${def.prompt ? ` — ${def.prompt.slice(0, 150)}` : ""}`;
    })
    .join("\n");

  const hasTeam = agentNames.length > 0;

  const systemPrompt = `You are the Boss. You manage a team of employees and coordinate their work.

## Team
${agentRoster || "(No employees yet)"}

## Rules
${
  hasTeam
    ? `- For simple questions, informational requests, or quick answers (e.g. "how do I run this?", "what does X do?", "explain Y"), respond directly yourself. You have full context of the project workspace and can read files to answer questions.
- For implementation tasks (writing code, creating files, building features, fixing bugs), delegate to the appropriate employee(s) via the Agent tool. NEVER do implementation yourself.
- Break complex tasks into subtasks and delegate to the right employee.
- Delegate to multiple agents in parallel when subtasks are independent.
- After delegations complete, provide a brief summary.
- ALWAYS prefer delegating to agents listed in the Team section above. Use their EXACT names.
- If you need expertise that no current employee has, you may create a new agent via the Agent tool — give it a clear, unique name and a descriptive prompt. But ALWAYS prefer existing employees when possible.
- NEVER delegate to yourself (the Boss). You coordinate — employees do the work. Your name is NOT in the team roster for a reason.
- NEVER use the Agent tool to spawn "helper" or "general-purpose" sub-agents for yourself. Every delegation must target a specific employee (existing or new).
- Keep delegations focused — do NOT chain agents (an agent delegating to another agent). Each agent should complete its own task independently.`
    : `- No employees yet. Tell the user to hire employees first, or answer the question yourself.`
}`;

  const options: ClaudeCodeAdvancedOptions = {
    prompt: instruction,
    cwd: workspace,
    // Only send systemPrompt on new sessions — Claude Code already has it
    // when resuming. Re-sending via appendSystemPrompt wastes input tokens.
    ...(sessionId ? {} : { systemPrompt }),
    agents: Object.keys(agentDefs).length > 0 ? agentDefs : undefined,
    enableAgentTeams: !!enableAgentTeams,
    // When permission prompts are enabled, 'default' mode routes unapproved
    // tools through the canUseTool callback which prompts the user via the UI.
    // When disabled, 'acceptEdits' auto-approves most operations.
    permissionMode:
      (await getSetting("outworked_permission_prompts")) !== "0"
        ? "default"
        : "acceptEdits",
    // Use resume when we have an explicit session ID — don't also set continue,
    // which resumes the *most recent* session and may not be ours.
    ...(sessionId ? { resumeSessionId: sessionId } : {}),
  };

  onDebug?.(
    `[orchestrator] options: ${JSON.stringify({ ...options, agents: Object.keys(agentDefs) })}`,
  );

  let fullText = "";
  // Two-tier stuck detection per agent
  const agentLastActivity = new Map<string, number>();
  const agentSlowFired = new Set<string>();
  const SLOW_TIMEOUT_MS = 300_000; // 5 minutes = soft warning
  const STUCK_TIMEOUT_MS = 600_000; // 10 minutes = likely stuck

  // ── Per-agent tracking ──
  // Map toolUseId → agentName so we can attribute nested events to agents
  const toolUseIdToAgent = new Map<string, string>();
  // Per-agent accumulated stream text
  const agentStreamText = new Map<string, string>();
  // Track which agent is "active" (last delegated to) as a fallback
  // when parent_tool_use_id is not available on events
  let currentActiveAgent: string | null = null;
  // Per-agent wall-clock time for cost distribution
  const agentStartTime = new Map<string, number>();
  const agentTotalTime = new Map<string, number>();
  // Track all delegated agent names (in delegation order)
  const delegatedAgentNames: string[] = [];

  const stuckCheckInterval = setInterval(() => {
    const now = Date.now();
    for (const [name, ts] of agentLastActivity) {
      const elapsed = now - ts;
      if (!agentSlowFired.has(name) && elapsed > SLOW_TIMEOUT_MS) {
        agentSlowFired.add(name);
        callbacks.onAgentStatus?.(name, "slow", "No progress for 5 minutes");
      }
      if (elapsed > STUCK_TIMEOUT_MS) {
        callbacks.onAgentStatus?.(name, "stuck", "No progress for 10 minutes");
      }
    }
  }, 15_000);

  /** Resolve which agent an event belongs to via parent_tool_use_id or fallback stack */
  function resolveAgent(parentToolUseId?: string | null): string | null {
    if (parentToolUseId && toolUseIdToAgent.has(parentToolUseId)) {
      return toolUseIdToAgent.get(parentToolUseId)!;
    }
    return currentActiveAgent;
  }

  /** Mark an agent as done and record its active time */
  function markAgentDone(agentName: string) {
    const start = agentStartTime.get(agentName.toLowerCase());
    if (start) {
      const elapsed = Date.now() - start;
      agentTotalTime.set(
        agentName.toLowerCase(),
        (agentTotalTime.get(agentName.toLowerCase()) || 0) + elapsed,
      );
      agentStartTime.delete(agentName.toLowerCase());
    }
    if (currentActiveAgent?.toLowerCase() === agentName.toLowerCase()) {
      currentActiveAgent = null;
    }
    callbacks.onAgentStatus?.(agentName, "done");
  }

  // Fix: streamCallbacks must be defined before use in catch block
  let streamCallbacks: ClaudeCodeStreamCallbacks = {
    onTextDelta: (text) => {
      fullText += text;
      // Route text to the active agent if one exists
      const agent = currentActiveAgent;
      if (agent) {
        const prev = agentStreamText.get(agent) || "";
        const updated = prev + text;
        agentStreamText.set(agent, updated);
        callbacks.onAgentStreamDelta?.(agent, text, updated);
      }
      callbacks.onTeamEvent?.({ type: "text", text, agentName: agent || undefined });
    },
    onToolUse: (name, input, toolUseId) => {
      onDebug?.(
        `[event] tool_use: ${name} ${JSON.stringify(input).slice(0, 300)}`,
      );

      if (name === "Agent") {
        const agentName = (input.agent ?? input.name ?? "") as string;
        const taskDesc = ((input.prompt ?? input.task ?? "") as string).slice(
          0,
          80,
        );

        // Detect self-delegation — boss trying to delegate to itself
        if (agentName && agentName.toLowerCase() === bossName) {
          onDebug?.(
            `[orchestrator] WARNING: Boss tried to delegate to itself (${agentName}). This will likely cause a deadlock.`,
          );
        }

        if (agentName) {
          // If a previous agent was active (sequential delegation), mark it done
          if (currentActiveAgent && currentActiveAgent.toLowerCase() !== agentName.toLowerCase()) {
            markAgentDone(currentActiveAgent);
          }

          // Track this delegation
          currentActiveAgent = agentName;
          agentStreamText.set(agentName, "");
          agentLastActivity.set(agentName.toLowerCase(), Date.now());
          agentSlowFired.delete(agentName.toLowerCase());

          // Record start time for cost distribution
          if (!agentStartTime.has(agentName.toLowerCase())) {
            agentStartTime.set(agentName.toLowerCase(), Date.now());
          }

          // Map tool_use ID to agent name for parent_tool_use_id tracking
          if (toolUseId) {
            toolUseIdToAgent.set(toolUseId, agentName);
          }

          // Track delegated agents (no duplicates)
          if (!delegatedAgentNames.includes(agentName)) {
            delegatedAgentNames.push(agentName);
          }
        }
        if (
          agentName &&
          !knownNames.has(agentName.toLowerCase()) &&
          !createdAgents.has(agentName.toLowerCase())
        ) {
          createdAgents.add(agentName.toLowerCase());
          const desc = (input.description ??
            input.role ??
            taskDesc ??
            "Specialist") as string;
          onDebug?.(
            `[orchestrator] Boss created new agent "${agentName}" (not in roster). This runs as a blocking subprocess.`,
          );
          callbacks.onNewAgent?.(agentName, desc);
        }
        callbacks.onAgentStatus?.(
          agentName,
          "working",
          `Working on: ${taskDesc}`,
        );
        callbacks.onAgentDelegation?.(agentName, taskDesc);
      } else {
        // Non-Agent tool call — attribute to the current active agent
        const ownerAgent = currentActiveAgent;
        if (ownerAgent) {
          agentLastActivity.set(ownerAgent.toLowerCase(), Date.now());
          agentSlowFired.delete(ownerAgent.toLowerCase());
          callbacks.onAgentToolUse?.(ownerAgent, name, input as Record<string, unknown>);
        }
      }
      callbacks.onTeamEvent?.({
        type: "tool_use",
        agentName: (input.agent ?? "") as string,
        text: `${name}: ${JSON.stringify(input).slice(0, 200)}`,
      });
    },
    onEvent: (event) => {
      onDebug?.(`[raw] ${JSON.stringify(event).slice(0, 500)}`);

      // Use parent_tool_use_id to route events to the right agent
      const parentId = event.parent_tool_use_id;
      const ownerAgent = resolveAgent(parentId);

      // Detect agent completion via result events
      if (event.type === "result" && event.subtype === "tool_result" && ownerAgent) {
        markAgentDone(ownerAgent);
      }

      callbacks.onTeamEvent?.({ type: event.type, agentName: ownerAgent || undefined });
      if (event.type === "permission_request") {
        const ev = event as unknown as Record<string, unknown>;
        const toolName =
          (ev.tool_name as string) ||
          ((ev.tool as Record<string, unknown>)?.name as string) ||
          "unknown";
        const desc =
          (ev.description as string) ||
          (ev.message as string) ||
          `Wants to use ${toolName}`;
        const agentName = (ev.agent_name as string) || ownerAgent || undefined;
        const permId = ev.perm_id as string | undefined;
        callbacks.onPermissionRequest?.(agentName, toolName, desc, undefined, permId);
        if (agentName) {
          callbacks.onAgentStatus?.(
            agentName,
            "waiting-approval",
            `Needs approval: ${toolName}`,
          );
        }
      }
    },
    onStderr: onDebug
      ? (text) => {
          onDebug(`[stderr] ${text.trim()}`);
        }
      : undefined,
    onPermissionRequest: (request) => {
      callbacks.onPermissionRequest?.(
        request.agentName,
        request.tool,
        request.description,
        request.reqId,
        request.permId,
      );
    },
  };

  /** Distribute total cost across agents proportionally by wall-clock time */
  function buildAgentCosts(
    totalCost: number | undefined,
    totalInput: number | undefined,
    totalOutput: number | undefined,
  ): Record<string, { cost: number; inputTokens: number; outputTokens: number }> | undefined {
    // Finalize any still-running agents' time
    for (const [name, start] of agentStartTime) {
      const elapsed = Date.now() - start;
      agentTotalTime.set(name, (agentTotalTime.get(name) || 0) + elapsed);
    }
    agentStartTime.clear();

    if (!totalCost || agentTotalTime.size === 0) return undefined;
    const totalTimeMs = [...agentTotalTime.values()].reduce((a, b) => a + b, 0);
    if (totalTimeMs === 0) return undefined;

    const costs: Record<string, { cost: number; inputTokens: number; outputTokens: number }> = {};
    for (const [name, timeMs] of agentTotalTime) {
      const ratio = timeMs / totalTimeMs;
      costs[name] = {
        cost: totalCost * ratio,
        inputTokens: Math.round((totalInput || 0) * ratio),
        outputTokens: Math.round((totalOutput || 0) * ratio),
      };
    }
    return costs;
  }

  try {
    const result = await runClaudeCode(
      options,
      streamCallbacks,
      signal,
    );
    return {
      text: result.result || fullText,
      sessionId: result.sessionId,
      cost: result.cost,
      inputTokens: result.usage?.input_tokens,
      outputTokens: result.usage?.output_tokens,
      agentCosts: buildAgentCosts(result.cost, result.usage?.input_tokens, result.usage?.output_tokens),
      delegatedAgents: delegatedAgentNames.length > 0 ? delegatedAgentNames : undefined,
    };
  } catch (err) {
    // If resume failed because the session no longer exists, retry as a fresh session
    const msg = (err as Error)?.message || "";
    if (sessionId && /no conversation found|session.*not found/i.test(msg)) {
      onDebug?.(
        `[orchestrator] Stale session ${sessionId}, retrying as new session`,
      );
      fullText = "";
      const freshOptions: ClaudeCodeAdvancedOptions = {
        ...options,
        systemPrompt: systemPrompt,
        appendSystemPrompt: undefined,
        continueSession: false,
        resumeSessionId: undefined,
      };
      const result = await runClaudeCode(
        freshOptions,
        streamCallbacks,
        signal,
      );
      return {
        text: result.result || fullText,
        sessionId: result.sessionId,
        cost: result.cost,
        inputTokens: result.usage?.input_tokens,
        outputTokens: result.usage?.output_tokens,
        agentCosts: buildAgentCosts(result.cost, result.usage?.input_tokens, result.usage?.output_tokens),
        delegatedAgents: delegatedAgentNames.length > 0 ? delegatedAgentNames : undefined,
      };
    }
    throw err;
  } finally {
    clearInterval(stuckCheckInterval);
  }
}
