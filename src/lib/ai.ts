import { Agent, AgentSkill, ApiKeys, Message, SubagentDef, ToolCall } from "./types";
import { AGENT_TOOLS, ToolDefinition, executeTool } from "./tools";
import { getWorkspace } from "./filesystem";
import { getSetting } from "./settings";
import {
  runClaudeCode,
  ClaudeCodeAdvancedOptions,
  ClaudeCodeStreamCallbacks,
  PermissionRequest,
} from "./terminal";
import { fetchSkill, fetchAvailableSkills } from "./bundled-skills";
import { loadGlobalSkillIds } from "./storage";

async function buildThinkingConfig(
  subDef?: SubagentDef,
): Promise<ClaudeCodeAdvancedOptions["thinking"]> {
  const thinking = subDef?.thinking || (await getSetting("outworked_default_thinking")) || "adaptive";
  if (thinking === "adaptive") return undefined;
  if (thinking === "disabled") return { type: "disabled" };
  // "enabled" with optional budget
  const budget = subDef?.thinkingBudget
    || parseInt((await getSetting("outworked_default_thinking_budget")) || "0")
    || 0;
  return budget
    ? { type: "enabled", budgetTokens: budget }
    : { type: "enabled" };
}

function buildToolPreamble(workspace: string): string {
  return `

## Workspace
Your working directory is: ${workspace}
All file operations and shell commands run in this directory by default.

## Asking Colleagues
If you need information or expertise from a colleague, include this exact format in your response:
[ASK:ColleagueName] Your question here
The system will route your question and provide their answer before your next step. Only ask when you genuinely need their input.
`;
}

async function buildSystemPrompt(
  agent: Agent,
  withTools: boolean,
  workspace = "",
  skills: AgentSkill[] = [],
): Promise<string> {
  let prompt = agent.personality;
  // Resolve per-agent skill names (from subagentDef) into actual skill objects
  const agentDefSkillResults = await Promise.all(
    (agent.subagentDef?.skills || []).map((name) => fetchSkill(name)),
  );
  const agentDefSkills = agentDefSkillResults.filter(
    (s): s is AgentSkill => s !== undefined,
  );
  // Combine: app-level skills + agent-level skills from subagentDef + legacy agent.skills
  const allSkills = [...skills, ...agentDefSkills, ...agent.skills];
  // Deduplicate by id
  const seen = new Set<string>();
  const uniqueSkills = allSkills.filter((s) => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
  if (uniqueSkills.length > 0) {
    prompt += "\n\n## Skills\n";
    for (const skill of uniqueSkills) {
      prompt += `\n### ${skill.name}\n${skill.content}\n`;
    }
  }
  if (withTools) prompt += buildToolPreamble(workspace);
  return prompt;
}

export interface SendOptions {
  onToolCall?: (call: ToolCall) => void;
  useTools?: boolean; // default true
  skills?: AgentSkill[]; // app-level skills injected into all agents
  extraTools?: ToolDefinition[]; // additional tools (e.g. assign_task for boss)
  extraSystemPrompt?: string; // appended to the system prompt
  customToolExecutor?: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<string | null>; // return string to override default executeTool, null to use default
  colleagues?: { name: string; role: string }[]; // other agents available for ask_agent
  onClaudeCodeEvent?: (event: {
    type: string;
    toolName?: string;
    toolInput?: Record<string, unknown>;
    text?: string;
  }) => void;
  onPermissionRequest?: (request: PermissionRequest) => void;
  onStderr?: (text: string) => void;
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
  thinking?: ClaudeCodeAdvancedOptions["thinking"];
}

export interface SendMessageResult {
  text: string;
  cost?: number;
  inputTokens?: number;
  outputTokens?: number;
  permissionDenials?: Array<{ tool_name: string; tool_use_id: string; tool_input: Record<string, unknown> }>;
  structuredOutput?: unknown;
}

export async function sendMessage(
  agent: Agent,
  userMessage: string,
  keys: ApiKeys,
  onThought: (text: string) => void,
  signal?: AbortSignal,
  options?: SendOptions,
): Promise<SendMessageResult> {
  const useTools = options?.useTools !== false;
  const workspace = useTools ? await getWorkspace() : "";

  // Merge global skills with app-level skills, respecting per-agent exclusions
  const globalSkillIds = await loadGlobalSkillIds();
  const excludeSet = new Set(agent.subagentDef?.excludeGlobalSkills || []);
  const filteredGlobalIds = globalSkillIds.filter((id) => !excludeSet.has(id));
  const globalSkills = (
    await Promise.all(filteredGlobalIds.map((id) => fetchSkill(id)))
  ).filter((s): s is AgentSkill => s !== undefined);
  const mergedSkills = [...(options?.skills || []), ...globalSkills];

  let systemPrompt = await buildSystemPrompt(
    agent,
    useTools,
    workspace,
    mergedSkills,
  );
  if (options?.colleagues && options.colleagues.length > 0) {
    systemPrompt +=
      "\n\n## Colleagues\nYou can ask these colleagues questions using [ASK:Name] format:\n";
    for (const c of options.colleagues) {
      systemPrompt += `- **${c.name}** — ${c.role}\n`;
    }
  }
  if (options?.extraSystemPrompt) systemPrompt += options.extraSystemPrompt;
  const messages: Message[] = [
    ...agent.history,
    { role: "user", content: userMessage, timestamp: Date.now() },
  ];

  // Currently only Claude Code is supported — API-key-based providers are disabled
  if (agent.provider !== "claude-code") {
    throw new Error(
      `Provider "${agent.provider}" is disabled. Only Claude Code (local) is supported. Switch this agent to Claude Code in the editor.`,
    );
  }

  // When resuming a session, only send the latest user message — Claude Code
  // already has the conversation history from the session.
  let prompt = "";
  if (agent.sessionId && messages.length > 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        prompt = messages[i].content;
        break;
      }
    }
  } else {
    for (const msg of messages) {
      if (msg.role === "user") prompt += `Human: ${msg.content}\n\n`;
      else if (msg.role === "assistant")
        prompt += `Assistant: ${msg.content}\n\n`;
    }
  }

  // Collect allowed skill runtime names from the agent's resolved skills
  // so the MCP server only exposes tools for skills this agent has access to.
  // Re-resolve agent.skills by ID via fetchSkill to get full metadata (including
  // runtime), since agent.skills loaded from .md files may lack metadata.
  const agentSkillsResolved = (
    await Promise.all(agent.skills.map((s) => fetchSkill(s.id)))
  ).filter((s): s is AgentSkill => s !== undefined);
  const agentDefSkillResults = (
    await Promise.all(
      (agent.subagentDef?.skills || []).map((name) => fetchSkill(name)),
    )
  ).filter((s): s is AgentSkill => s !== undefined);
  const allResolvedSkills = [
    ...mergedSkills,
    ...agentDefSkillResults,
    ...agentSkillsResolved,
  ];
  const allowedRuntimes = [
    ...new Set(
      allResolvedSkills
        .map((s) => s.metadata?.runtime)
        .filter((r): r is string => !!r),
    ),
  ];

  return invokeClaudeCode({
    prompt,
    systemPrompt: systemPrompt,
    agent,
    useTools,
    allowedRuntimes,
    onThought,
    signal,
    onClaudeCodeEvent: options?.onClaudeCodeEvent,
    onPermissionRequest: options?.onPermissionRequest,
    onStderr: options?.onStderr,
    outputFormat: options?.outputFormat,
    thinking: options?.thinking,
  });
}


// ─── Claude Code invocation ──────────────────────────────────────
// Single entry point for all Claude Code SDK calls.

interface InvokeOptions {
  prompt: string;
  systemPrompt: string;
  agent?: Agent;
  useTools?: boolean;
  allowedRuntimes?: string[];
  onThought: (text: string) => void;
  signal?: AbortSignal;
  onClaudeCodeEvent?: SendOptions["onClaudeCodeEvent"];
  onPermissionRequest?: SendOptions["onPermissionRequest"];
  onStderr?: SendOptions["onStderr"];
  outputFormat?: SendOptions["outputFormat"];
  thinking?: ClaudeCodeAdvancedOptions["thinking"];
}

async function invokeClaudeCode(opts: InvokeOptions): Promise<SendMessageResult> {
  const { prompt, systemPrompt, agent, onThought, signal,
    onClaudeCodeEvent, onPermissionRequest, onStderr, outputFormat, thinking, allowedRuntimes } = opts;
  const useTools = opts.useTools !== false;
  const subDef = agent?.subagentDef;
  const isResume = !!agent?.sessionId;
  const workspace = await getWorkspace();

  // Build MCP servers list — include user-configured ones plus the always-running
  // outworked-skills server. Skip MCP when tools are disabled (e.g. router calls).
  let mcpServers = subDef?.mcpServers
    ? subDef.mcpServers.filter(
        (s) => !(typeof s === "object" && s !== null && "outworked-skills" in s),
      )
    : [];
  if (useTools) {
    const qsParts: string[] = [];
    if (agent?.id) qsParts.push(`agentId=${encodeURIComponent(agent.id)}`);
    if (allowedRuntimes) {
      qsParts.push(`runtimes=${encodeURIComponent(allowedRuntimes.join(","))}`);
    }
    const qs = qsParts.length > 0 ? `?${qsParts.join("&")}` : "";
    mcpServers.push({
      "outworked-skills": {
        type: "http" as const,
        url: `http://127.0.0.1:7823/mcp${qs}`,
      },
    });
  }

  // If the agent has an allowlist, ensure our MCP server tools are permitted.
  // Claude Code prefixes MCP tools with "mcp__<serverName>__<toolName>".
  let allowedTools = subDef?.tools ? [...subDef.tools] : undefined;
  if (allowedTools) {
    const mcpToolPattern = "mcp__outworked-skills__*";
    if (!allowedTools.includes(mcpToolPattern)) {
      allowedTools.push(mcpToolPattern);
    }
  }

  const options: ClaudeCodeAdvancedOptions = {
    prompt,
    cwd: workspace,
    // Skip system prompt on resumed sessions — Claude Code already has it
    // from the initial session. Re-sending it wastes input tokens.
    ...(isResume ? {} : { systemPrompt }),
    model: subDef?.model || (await getSetting("outworked_default_model")) || undefined,
    // When useTools is false (e.g. router/planning calls), block all tools,
    // force maxTurns: 1, use low effort, and don't persist the session.
    allowedTools: useTools ? allowedTools : [],
    disallowedTools: useTools ? subDef?.disallowedTools : undefined,
    maxTurns: useTools ? subDef?.maxTurns : 1,
    effort: useTools
      ? (subDef?.effort || (await getSetting("outworked_default_effort")) as ClaudeCodeAdvancedOptions["effort"] || undefined)
      : "low",
    persistSession: useTools ? undefined : false,
    permissionMode:
      (subDef?.permissionMode as ClaudeCodeAdvancedOptions["permissionMode"]) ||
      ((await getSetting("outworked_permission_prompts")) !== "0"
        ? "default"
        : "acceptEdits"),
    mcpServers: mcpServers.length > 0 ? mcpServers : undefined,
    // Use resume when we have an explicit session ID — don't also set continue,
    // which resumes the *most recent* session and may not be ours.
    ...(agent?.sessionId ? { resumeSessionId: agent.sessionId } : {}),
    outputFormat,
    thinking: thinking || (useTools ? await buildThinkingConfig(subDef) : { type: "disabled" as const }),
  };

  let fullText = "";
  onThought("🤖 Claude Code is thinking...");

  const callbacks: ClaudeCodeStreamCallbacks = {
    onTextDelta: (text) => {
      fullText += text;
      onThought(fullText);
    },
    onToolUse: (name, input) => {
      const label = claudeCodeToolLabel(name, input);
      if (fullText && !fullText.endsWith("\n")) fullText += "\n";
      fullText += `\n${label}\n`;
      onThought(fullText);
      onClaudeCodeEvent?.({
        type: "tool_use",
        toolName: name,
        toolInput: input,
      });
    },
    onEvent: (event) => {
      // Surface assistant-level errors (rate limit, billing, auth, etc.)
      if (event.type === "assistant" && event.error) {
        onClaudeCodeEvent?.({
          type: "assistant_error",
          text: event.error,
        });
      }
      // Extract text from assistant messages for thinking previews
      let eventText: string | undefined;
      if (event.type === "result" && typeof event.result === "string") {
        eventText = event.result;
      } else if (event.type === "assistant" && event.message?.content) {
        const content = event.message.content;
        if (typeof content === "string") {
          eventText = content;
        } else if (Array.isArray(content)) {
          eventText = content
            .filter((b) => b.type === "text" && b.text)
            .map((b) => b.text)
            .join("");
        }
      }
      onClaudeCodeEvent?.({
        type: event.type,
        text: eventText,
      });
    },
    onStderr: onStderr,
    onPermissionRequest: onPermissionRequest,
  };

  const result = await runClaudeCode(options, callbacks, signal);

  // Store session ID on the agent for continuity
  if (agent && result.sessionId) {
    agent.sessionId = result.sessionId;
  }

  return {
    text: result.result || fullText,
    cost: result.cost,
    inputTokens: result.usage?.input_tokens,
    outputTokens: result.usage?.output_tokens,
    permissionDenials: result.permissionDenials,
    structuredOutput: result.structuredOutput,
  };
}

function claudeCodeToolLabel(
  name: string,
  args: Record<string, unknown>,
): string {
  const p = (args.file_path ?? args.path ?? args.command ?? "") as string;
  switch (name) {
    case "Write":
      return `📁 Writing ${p}…`;
    case "Edit":
      return `✏️ Editing ${p}…`;
    case "Read":
      return `📖 Reading ${p}…`;
    case "Bash":
      return `💻 $ ${p.slice(0, 80)}…`;
    case "Glob":
      return `🔍 Searching files…`;
    case "Grep":
      return `🔎 Grepping ${(args.pattern as string) ?? ""}…`;
    case "WebFetch":
      return `🌐 Fetching ${p}…`;
    case "WebSearch":
      return `🔍 Searching: ${(args.query as string) ?? ""}…`;
    case "Agent":
      return `🤖 Delegating to subagent…`;
    case "TodoWrite":
      return `📋 Updating task list…`;
    case "TaskCreate":
      return `📋 Creating task…`;
    default:
      return `🔧 ${name} ${p ? `(${p.slice(0, 40)})` : ""}…`;
  }
}
