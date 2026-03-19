import { Agent, AgentSkill, AgentTodo, ApiKeys, Message, SubagentDef } from './types';
import { sendMessage } from './ai';
import { listFiles, listAllFiles, readFile, writeFile, searchFiles } from './filesystem';
import { runClaudeCodeAdvanced, ClaudeCodeAdvancedOptions, ClaudeCodeStreamCallbacks } from './terminal';
import { getWorkspace } from './filesystem';

export interface NewAgentSpec {
  name: string;
  role: string;
  personality: string;
}

export interface TaskAssignment {
  agentId: string;
  agentName: string;
  task: string;
}

export interface OrchestrationResult {
  assignments: TaskAssignment[];
  plan: string;
  newAgents: NewAgentSpec[];
  workingDirectory: string;
}

// If one of the existing directories matches the prompt (e.g. same project name or topic), reuse it as the workingDirectory. 
// You might be in a situation where the instruction is related to the current directory (e.g. "Improve the recipe-api") — in that case, work in the current directory as the workingDirectory and assign tasks accordingly.
// Otherwise, pick a short, descriptive slug for a NEW workingDirectory (lowercase, hyphens, no spaces — like "recipe-api" or "landing-page").


const ROUTER_SYSTEM = `You are the Office Manager. You receive high-level instructions and break them into tasks assigned to specific employees.

You will be given a list of current employees with their names, roles, and what they're good at. Given the user's instruction, decide which employee(s) should handle which part of the work. Not Every employee needs to be assigned a task — only assign relevant ones. You can also create new employees if needed (see below).

IMPORTANT: If the task requires expertise that NO current employee has, you MUST create new employees with the right skills. For example, if the task needs a backend engineer but only a designer exists, create one.

You will also be given:
- A list of existing project directories in the workspace
- A file tree showing ALL files in the workspace (paths + sizes only)
- The contents of relevant files (config files + files matching the instruction's keywords)
Use the file tree for orientation and the file contents to understand what already exists — this is critical for making informed routing decisions. For example, if the project already has a package.json, you know the tech stack; if it has certain source files, you can assign tasks that build on them rather than starting from scratch.


RESPOND in this exact JSON format and nothing else:
{
  "plan": "Brief summary of the plan",
  "workingDirectory": "short-slug",
  "newAgents": [
    { "name": "UniqueFirstName", "role": "Job Title", "personality": "Detailed system prompt for this specialist" }
  ],
  "assignments": [
    { "agentName": "ExactEmployeeName", "task": "Specific task description for this employee" }
  ]
}

Rules:
- "newAgents" can be an empty array if existing employees are sufficient
- You may only add 5 new employees per instruction — be concise and only create what is necessary
- New agents should have distinct names, clear roles, and detailed personality prompts that define their expertise
- You may assign tasks to both existing AND newly created employees
- Use EXACT employee names (existing or newly created) in assignments
- Each assignment should be a clear, actionable task
- You may assign multiple tasks to one employee or spread across employees
- All employees share the same project working directory — coordinate their work so they don't overwrite each other
- The workingDirectory should be reused if an existing directory is relevant, or a new short slug if not`;

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
    const firstBrace = reply.indexOf('{');
    const lastBrace = reply.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      jsonStr = reply.slice(firstBrace, lastBrace + 1);
    }
  }

  // Strip trailing commas before } or ] (common LLM mistake)
  jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1');

  return JSON.parse(jsonStr);
}

export async function routeTasks(
  instruction: string,
  agents: Agent[],
  keys: ApiKeys,
  routerModel: { model: Agent['model']; provider: Agent['provider'] }
): Promise<OrchestrationResult> {
  const employeeList = agents
    .map((a) => `- ${a.name} (${a.role}): ${a.personality.slice(0, 120)}`)
    .join('\n');

  // List top-level directories in the workspace so the router can reuse one
  const existingDirs = await listFiles();
  const dirList = existingDirs
    .split('\n')
    .filter((p) => p.endsWith('/'))
    .map((p) => p.replace(/\/$/, ''))
    .filter(Boolean);
  const dirsSection = dirList.length > 0
    ? `## Existing project directories\n${dirList.map((d) => `- ${d}`).join('\n')}`
    : '## Existing project directories\n(none)';

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
  const fileTree = allFiles
    .map((f) => `  ${f.path} (${f.size}b)`)
    .join('\n');
  const treeSection = allFiles.length > 0
    ? `## File tree (${allFiles.length} files)\n${fileTree}`
    : '## File tree\n(empty workspace)';

  // Key config files the router should always see
  const CONFIG_PATTERNS = [
    'package.json', 'tsconfig.json', 'pyproject.toml', 'Cargo.toml',
    'go.mod', 'Gemfile', 'requirements.txt', 'Makefile', 'Dockerfile',
    'docker-compose.yml', 'docker-compose.yaml', '.env.example',
    'README.md', 'readme.md',
  ];
  const configPaths = new Set(
    allFiles
      .filter((f) => CONFIG_PATTERNS.some((p) => f.path === p || f.path.endsWith('/' + p)))
      .map((f) => f.path)
  );

  // Extract keywords from the instruction for targeted search
  const keywords = extractKeywords(instruction);

  // Search for files matching those keywords
  const searchResults = keywords.length > 0
    ? await searchFiles(keywords, 30)
    : [];

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
      fileContents.push(`### ${meta.path}\n(skipped — ${meta.size} bytes, too large)`);
      continue;
    }
    if (totalChars + meta.size > MAX_TOTAL_CHARS) {
      fileContents.push(`### ${meta.path}\n(skipped — context budget reached)`);
      continue;
    }
    const content = await readFile(meta.path);
    if (content.startsWith('Error:')) {
      fileContents.push(`### ${meta.path}\n(could not read)`);
      continue;
    }
    fileContents.push(`### ${meta.path}\n\`\`\`\n${content}\n\`\`\``);
    totalChars += content.length;
  }

  const filesSection = fileContents.length > 0
    ? `## Relevant files (${fileContents.length} of ${allFiles.length} total)\n${fileContents.join('\n\n')}`
    : '## Workspace files\n(no relevant files found)';

  const prompt = `## Employees\n${employeeList}\n\n${dirsSection}\n\n${treeSection}\n\n${filesSection}\n\n## Instruction\n${instruction}`;

  // Create a temporary "router" agent
  const routerAgent: Agent = {
    id: '__router__',
    name: 'Office Manager',
    role: 'Router',
    personality: ROUTER_SYSTEM,
    model: routerModel.model,
    provider: routerModel.provider,
    skills: [],
    position: { x: 0, y: 0 },
    status: 'thinking',
    currentThought: '',
    spriteKey: '',
    history: [],
    color: '#888',
    todos: [],
  };

  const MAX_ROUTE_ATTEMPTS = 2;
  let lastErr: unknown;
  let lastRawReply = '';

  for (let attempt = 0; attempt < MAX_ROUTE_ATTEMPTS; attempt++) {
    const reply = await sendMessage(
      routerAgent,
      attempt === 0
        ? prompt
        : `${prompt}\n\nIMPORTANT: Respond ONLY with a valid JSON object. No markdown, no explanation — just the raw JSON.`,
      keys,
      () => {},
      undefined,
      { useTools: false },
    );
    lastRawReply = reply;

    try {
      const parsed = extractJson(reply);

      // Parse new agent specs
      const newAgents: NewAgentSpec[] = (parsed.newAgents || []).map(
        (a: { name: string; role: string; personality: string }) => ({
          name: a.name,
          role: a.role,
          personality: a.personality,
        })
      );

      const assignments: TaskAssignment[] = (parsed.assignments || []).map(
        (a: { agentName: string; task: string }) => {
          const agent = agents.find(
            (ag) => ag.name.toLowerCase() === a.agentName.toLowerCase()
          );
          return {
            agentId: agent?.id ?? '', // empty string means it's a new agent — resolved after creation
            agentName: a.agentName,
            task: a.task,
          };
        }
      );

      // Ensure the working directory exists
      const workDir = sanitizeSlug(parsed.workingDirectory || 'project');
      await ensureWorkingDirectory(workDir);

      return { assignments, plan: parsed.plan || '', newAgents, workingDirectory: workDir };
    } catch (err) {
      lastErr = err;
      console.warn(`[orchestrator] Route attempt ${attempt + 1} failed:`, err, '\nRaw reply:', reply.slice(0, 500));
      // Loop will retry
    }
  }

  // All attempts failed — fallback: assign the whole thing to the first agent
  console.warn('[orchestrator] All route attempts failed. Using fallback.');
  const fallbackDir = 'project';
  await ensureWorkingDirectory(fallbackDir);
  return {
    plan: 'Could not parse routing — assigning to first available employee.',
    assignments: agents.length > 0
      ? [{ agentId: agents[0].id, agentName: agents[0].name, task: instruction }]
      : [],
    newAgents: [],
    workingDirectory: fallbackDir,
  };
}

/**
 * Extract meaningful keywords from an instruction for targeted file search.
 * Filters out common stop words and short words, returns unique terms.
 */
function extractKeywords(instruction: string): string[] {
  const STOP_WORDS = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
    'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over',
    'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when',
    'where', 'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more',
    'most', 'other', 'some', 'such', 'no', 'not', 'only', 'same', 'so',
    'than', 'too', 'very', 'just', 'because', 'but', 'and', 'or', 'if',
    'while', 'about', 'up', 'this', 'that', 'these', 'those', 'it', 'its',
    'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'they',
    'them', 'what', 'which', 'who', 'whom', 'make', 'create', 'build',
    'add', 'update', 'change', 'fix', 'implement', 'write', 'use', 'get',
    'set', 'new', 'also', 'like', 'need', 'want', 'please', 'help',
  ]);

  // Extract words, camelCase splits, and quoted/path-like terms
  const words = instruction
    .replace(/[^a-zA-Z0-9_./\-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const keywords: string[] = [];
  const seen = new Set<string>();

  for (const word of words) {
    // Split camelCase: "userProfile" → ["user", "profile"]
    const parts = word
      .replace(/([a-z])([A-Z])/g, '$1 $2')
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
    if ((word.includes('/') || word.includes('.') || word.includes('-') || word.includes('_')) && !seen.has(lower)) {
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
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64) || 'project';
}

/**
 * Create the working directory if it doesn't already exist.
 * Uses writeFile with a marker file since the filesystem auto-creates parent dirs.
 */
async function ensureWorkingDirectory(dir: string): Promise<void> {
  const listing = await listFiles(dir);
  // If the directory already has files, it exists — nothing to do
  if (!listing.startsWith('No files')) return;
  // Create an empty marker so the directory is created
  await writeFile(`${dir}/.outworked`, `# Working directory created ${new Date().toISOString()}\n`);
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
  customToolExecutor?: (name: string, args: Record<string, unknown>) => Promise<string | null>,
  colleagues?: { name: string; role: string }[],
): Promise<{ agent: Agent; reply: string }> {
  // Build a strong system-level directive so agents respect the working directory
  const extraSystemPrompt = workingDirectory
    ? `\n\n## IMPORTANT — Project Directory\nThis project's root is "${workingDirectory}/". You MUST:\n- Prefix EVERY file path with "${workingDirectory}/" (e.g. "${workingDirectory}/src/index.js", NOT "src/index.js")\n- Pass cwd: "${workingDirectory}" to every run_command call\n- NEVER write files to paths outside "${workingDirectory}/"\nViolating this will break the project structure.`
    : undefined;

  const userMsg: Message = {
    role: 'user',
    content: `[OFFICE TASK] ${task}\n\nPlease complete this task. If you need to write code, include it in code blocks. Explain what you did briefly.${workingDirectory ? ` Remember: all files go under ${workingDirectory}/.` : ''}`,
    timestamp: Date.now(),
  };

  const updatedAgent: Agent = {
    ...agent,
    history: [...agent.history, userMsg],
    status: 'working',
    currentThought: 'Working on task...',
  };

  const reply = await sendMessage(
    updatedAgent,
    userMsg.content,
    keys,
    onThought,
    signal,
    { skills, extraSystemPrompt, customToolExecutor, colleagues },
  );

  const assistantMsg: Message = {
    role: 'assistant',
    content: reply,
    timestamp: Date.now(),
  };

  return {
    agent: {
      ...updatedAgent,
      history: [...updatedAgent.history, assistantMsg],
      status: 'idle',
      currentThought: reply.slice(0, 80) + (reply.length > 80 ? '...' : ''),
    },
    reply,
  };
}

/**
 * Ask the agent to break a task into a checklist of to-do items.
 */
export async function generateTodoList(
  agent: Agent,
  task: string,
  keys: ApiKeys,
  skills?: AgentSkill[],
): Promise<AgentTodo[]> {
  const prompt = `Break down this task into a short checklist of 3-6 concrete action items. Respond ONLY with a JSON array of strings — no extra text.\n\nTask: ${task}`;

  const tempAgent: Agent = {
    ...agent,
    history: [],
  };

  const reply = await sendMessage(tempAgent, prompt, keys, () => {}, undefined, { useTools: false, skills });

  try {
    const jsonStr = reply.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const items: string[] = JSON.parse(jsonStr);
    if (!Array.isArray(items)) throw new Error('Not an array');
    return items.map((text) => ({
      id: crypto.randomUUID(),
      text: typeof text === 'string' ? text : String(text),
      status: 'pending' as const,
      timestamp: Date.now(),
    }));
  } catch {
    // Fallback: single todo with the whole task
    return [{
      id: crypto.randomUUID(),
      text: task,
      status: 'pending' as const,
      timestamp: Date.now(),
    }];
  }
}

// ─── Claude Code Agent Teams orchestration ────────────────────

export interface AgentTeamCallbacks {
  onTeamEvent?: (event: { agentName?: string; type: string; text?: string }) => void;
  onAgentStatus?: (agentName: string, status: 'working' | 'done' | 'waiting-input' | 'waiting-approval' | 'stuck', thought?: string) => void;
  /** Called when the boss delegates to an agent name not in the roster — allows dynamic creation */
  onNewAgent?: (agentName: string, description: string) => void;
  /** Called when a permission request event is received for the team */
  onPermissionRequest?: (agentName: string | undefined, tool: string, description: string, reqId?: number) => void;
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
): Promise<{ text: string; sessionId?: string }> {
  const workspace = await getWorkspace();

  // Build subagent definitions from all subagent-backed employees
  const agentDefs: Record<string, SubagentDef> = {};
  const knownNames = new Set<string>();
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
  const agentRoster = agentNames.map(name => {
    const def = agentDefs[name];
    return `- **${name}** (use agent="${name}"): ${def.description}${def.prompt ? ` — ${def.prompt.slice(0, 150)}` : ''}`;
  }).join('\n');

  const hasTeam = agentNames.length > 0;

  const systemPrompt = `You are the Boss. Delegate ALL tasks to employees via the Agent tool. NEVER do implementation yourself.

## Team
${agentRoster || '(No employees yet)'}

## Rules
${hasTeam ? `- Delegate ALL work. NEVER write code, edit files, or run commands yourself.
- Break complex tasks into subtasks and delegate to the right employee.
- Delegate to multiple agents in parallel when subtasks are independent.
- After delegations complete, provide a brief summary.` : `- No employees yet. Tell the user to hire employees first.`}`;

  const options: ClaudeCodeAdvancedOptions = {
    prompt: instruction,
    cwd: workspace,
    // Only send systemPrompt on new sessions — Claude Code already has it
    // when resuming. Re-sending via appendSystemPrompt wastes input tokens.
    ...(sessionId ? {} : { systemPrompt }),
    outputFormat: 'stream-json',
    agents: Object.keys(agentDefs).length > 0 ? agentDefs : undefined,
    enableAgentTeams: !!enableAgentTeams,
    // 'acceptEdits' auto-approves file-write operations without prompting.
    // This is intentional: because the Boss runs in -p mode, stdin is closed
    // after the initial prompt and interactive permission responses are
    // impossible. 'acceptEdits' ensures file edits are never blocked while
    // still requiring explicit approval for higher-risk tools (e.g. bash).
    permissionMode: 'acceptEdits',
    continueSession: !!sessionId,
    resumeSessionId: sessionId,
  };

  onDebug?.(`[orchestrator] options: ${JSON.stringify({ ...options, agents: Object.keys(agentDefs) })}`);

  let fullText = '';
  // Track time of last meaningful event per agent to detect stuck agents
  const agentLastActivity = new Map<string, number>();
  const STUCK_TIMEOUT_MS = 120_000; // 2 minutes of silence = stuck

  const stuckCheckInterval = setInterval(() => {
    const now = Date.now();
    for (const [name, ts] of agentLastActivity) {
      if (now - ts > STUCK_TIMEOUT_MS) {
        callbacks.onAgentStatus?.(name, 'stuck', 'No progress for 2 minutes');
      }
    }
  }, 15_000);

  // Fix: streamCallbacks must be defined before use in catch block
  let streamCallbacks: ClaudeCodeStreamCallbacks = {
    onTextDelta: (text) => {
      fullText += text;
      callbacks.onTeamEvent?.({ type: 'text', text });
    },
    onToolUse: (name, input) => {
      onDebug?.(`[event] tool_use: ${name} ${JSON.stringify(input).slice(0, 300)}`);
      if (name === 'Agent') {
        const agentName = (input.agent ?? input.name ?? '') as string;
        const taskDesc = ((input.prompt ?? input.task ?? '') as string).slice(0, 80);
        if (agentName) agentLastActivity.set(agentName.toLowerCase(), Date.now());
        if (agentName && !knownNames.has(agentName.toLowerCase()) && !createdAgents.has(agentName.toLowerCase())) {
          createdAgents.add(agentName.toLowerCase());
          const desc = (input.description ?? input.role ?? taskDesc ?? 'Specialist') as string;
          callbacks.onNewAgent?.(agentName, desc);
        }
        callbacks.onAgentStatus?.(agentName, 'working', `Working on: ${taskDesc}`);
      }
      callbacks.onTeamEvent?.({ type: 'tool_use', agentName: (input.agent ?? '') as string, text: `${name}: ${JSON.stringify(input).slice(0, 200)}` });
    },
    onEvent: (event) => {
      onDebug?.(`[raw] ${JSON.stringify(event).slice(0, 500)}`);
      callbacks.onTeamEvent?.({ type: event.type });
      if (event.type === 'permission_request') {
        const ev = event as unknown as Record<string, unknown>;
        const toolName = ev.tool_name as string
          || ((ev.tool as Record<string, unknown>)?.name as string)
          || 'unknown';
        const desc = ev.description as string
          || ev.message as string
          || `Wants to use ${toolName}`;
        const agentName = ev.agent_name as string | undefined;
        callbacks.onPermissionRequest?.(agentName, toolName, desc);
        if (agentName) {
          callbacks.onAgentStatus?.(agentName, 'waiting-approval', `Needs approval: ${toolName}`);
        }
      }
    },
    onStderr: onDebug ? (text) => {
      onDebug(`[stderr] ${text.trim()}`);
    } : undefined,
    onPermissionRequest: (request) => {
      callbacks.onPermissionRequest?.(undefined, request.tool, request.description, request.reqId);
    },
  };

  try {
    const result = await runClaudeCodeAdvanced(options, streamCallbacks, signal);
    return { text: result.result || fullText, sessionId: result.sessionId };
  } catch (err) {
    // If resume failed because the session no longer exists, retry as a fresh session
    const msg = (err as Error)?.message || '';
    if (sessionId && /no conversation found|session.*not found/i.test(msg)) {
      onDebug?.(`[orchestrator] Stale session ${sessionId}, retrying as new session`);
      fullText = '';
      const freshOptions: ClaudeCodeAdvancedOptions = {
        ...options,
        systemPrompt: systemPrompt,
        appendSystemPrompt: undefined,
        continueSession: false,
        resumeSessionId: undefined,
      };
      const result = await runClaudeCodeAdvanced(freshOptions, streamCallbacks, signal);
      return { text: result.result || fullText, sessionId: result.sessionId };
    }
    throw err;
  } finally {
    clearInterval(stuckCheckInterval);
  }
}
