import { Agent, AgentSkill, ApiKeys, Message, ToolCall } from "./types";
import { AGENT_TOOLS, ToolDefinition, executeTool } from "./tools";
import { getWorkspace } from "./filesystem";
import {
  runClaudeCodeAdvanced,
  ClaudeCodeAdvancedOptions,
  ClaudeCodeStreamCallbacks,
  PermissionRequest,
} from "./terminal";
import { getBundledSkill } from "./bundled-skills";

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

function buildSystemPrompt(
  agent: Agent,
  withTools: boolean,
  workspace = "",
  skills: AgentSkill[] = [],
): string {
  let prompt = agent.personality;
  // Resolve per-agent skill names (from subagentDef) into actual skill objects
  const agentDefSkills: AgentSkill[] = (agent.subagentDef?.skills || [])
    .map((name) => getBundledSkill(name))
    .filter((s): s is AgentSkill => s !== undefined);
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
}

export interface SendMessageResult {
  text: string;
  cost?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export async function sendMessage(
  agent: Agent,
  userMessage: string,
  keys: ApiKeys,
  onThought: (text: string) => void,
  signal?: AbortSignal,
  options?: SendOptions,
): Promise<string> {
  const result = await sendMessageWithCost(
    agent,
    userMessage,
    keys,
    onThought,
    signal,
    options,
  );
  return result.text;
}

export async function sendMessageWithCost(
  agent: Agent,
  userMessage: string,
  keys: ApiKeys,
  onThought: (text: string) => void,
  signal?: AbortSignal,
  options?: SendOptions,
): Promise<SendMessageResult> {
  const useTools = options?.useTools !== false;
  const workspace = useTools ? await getWorkspace() : "";
  let systemPrompt = buildSystemPrompt(
    agent,
    useTools,
    workspace,
    options?.skills,
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
  if (agent.provider === "claude-code") {
    return callClaudeCode(
      systemPrompt,
      messages,
      onThought,
      signal,
      agent,
      options?.onClaudeCodeEvent,
      options?.onPermissionRequest,
      options?.onStderr,
    );
  } else {
    throw new Error(
      `Provider "${agent.provider}" is disabled. Only Claude Code (local) is supported. Switch this agent to Claude Code in the editor.`,
    );
  }

  /* === API-key-based providers (commented out) ===
  if (agent.provider === 'openai') {
    return callOpenAI(agent.model, systemPrompt, messages, keys.openai, onThought, signal, useTools, options?.onToolCall, options?.extraTools, options?.customToolExecutor);
  } else if (agent.provider === 'google') {
    return callGemini(agent.model, systemPrompt, messages, keys.gemini, onThought, signal, useTools, options?.onToolCall, options?.extraTools, options?.customToolExecutor);
  } else {
    return callAnthropic(agent.model, systemPrompt, messages, keys.anthropic, onThought, signal, useTools, options?.onToolCall, options?.extraTools, options?.customToolExecutor);
  }
  */
}

// ─── Helpers ──────────────────────────────────────────────────────

function toolLabel(name: string, args: Record<string, unknown>): string {
  const p = (args.path as string) ?? "";
  switch (name) {
    case "write_file":
      return `📁 Writing ${p}…`;
    case "read_file":
      return `📖 Reading ${p}…`;
    case "execute_code":
      return "▶️ Running code…";
    case "list_files":
      return "📂 Listing files…";
    case "delete_file":
      return `🗑️ Deleting ${p}…`;
    case "run_command":
      return `💻 $ ${(args.command as string) ?? ""}…`;
    case "update_todos":
      return `📋 Updating task list…`;
    case "assign_task":
      return `📋 Assigning task to ${(args.employeeName as string) ?? "employee"}…`;
    case "git_status":
      return `🌿 Git status…`;
    case "git_create_branch":
      return `🌿 Creating branch ${(args.branch as string) ?? ""}…`;
    case "git_commit":
      return `💾 Committing: ${(args.message as string) ?? ""}…`;
    case "git_push":
      return `🚀 Pushing to origin…`;
    case "git_create_pr":
      return `🔀 Creating PR: ${(args.title as string) ?? ""}…`;
    default:
      return `🔧 ${name}…`;
  }
}

// ─── Claude Code CLI ──────────────────────────────────────────────
// Uses the locally-installed `claude` CLI.
// Uses runClaudeCodeAdvanced with stream-json for full event visibility
// (tool calls, subagent activity, session metadata, cost tracking).

async function callClaudeCode(
  system: string,
  messages: Message[],
  onThought: (text: string) => void,
  signal?: AbortSignal,
  agent?: Agent,
  onClaudeCodeEvent?: SendOptions["onClaudeCodeEvent"],
  onPermissionRequest?: SendOptions["onPermissionRequest"],
  onStderr?: SendOptions["onStderr"],
): Promise<SendMessageResult> {
  // When resuming a session, only send the latest user message — Claude Code
  // already has the conversation history from the session.  Sending the full
  // history again doubles input tokens and significantly slows responses.
  let prompt = "";
  if (agent?.sessionId && messages.length > 0) {
    // Find the last user message
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

  const workspace = await getWorkspace();

  // Always use advanced mode so we get cost/usage data back
  return callClaudeCodeAdvanced(
    prompt,
    system,
    workspace,
    onThought,
    signal,
    agent,
    onClaudeCodeEvent,
    onPermissionRequest,
    onStderr,
  );
}

/**
 * Advanced Claude Code invocation with stream-json parsing.
 * Used for subagent-backed agents for rich tool/event visibility.
 */
async function callClaudeCodeAdvanced(
  prompt: string,
  system: string,
  workspace: string,
  onThought: (text: string) => void,
  signal?: AbortSignal,
  agent?: Agent,
  onClaudeCodeEvent?: SendOptions["onClaudeCodeEvent"],
  onPermissionRequest?: SendOptions["onPermissionRequest"],
  onStderr?: SendOptions["onStderr"],
): Promise<SendMessageResult> {
  const subDef = agent?.subagentDef;
  const isResume = !!agent?.sessionId;

  const options: ClaudeCodeAdvancedOptions = {
    prompt,
    cwd: workspace,
    // Skip system prompt on resumed sessions — Claude Code already has it
    // from the initial session. Re-sending it wastes input tokens.
    ...(isResume ? {} : { systemPrompt: system }),
    model: subDef?.model || undefined,
    allowedTools: subDef?.tools,
    disallowedTools: subDef?.disallowedTools,
    maxTurns: subDef?.maxTurns,
    permissionMode:
      (subDef?.permissionMode as ClaudeCodeAdvancedOptions["permissionMode"]) ||
      (localStorage.getItem("outworked_permission_prompts") !== "0"
        ? "default"
        : "acceptEdits"),
    mcpServers: subDef?.mcpServers,
    continueSession: isResume,
    resumeSessionId: agent?.sessionId,
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

  const result = await runClaudeCodeAdvanced(options, callbacks, signal);

  // Store session ID on the agent for continuity
  if (agent && result.sessionId) {
    agent.sessionId = result.sessionId;
  }

  return {
    text: result.result || fullText,
    cost: result.cost,
    inputTokens: result.usage?.input_tokens,
    outputTokens: result.usage?.output_tokens,
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
