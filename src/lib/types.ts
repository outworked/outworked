export type ModelId = "claude-code";

export type Provider = "claude-code";

export interface SkillMetadata {
  emoji?: string;
  description?: string;
  requires?: {
    bins?: string[];
    anyBins?: string[];
    config?: string[];
  };
  install?: {
    id: string;
    kind: string;
    formula?: string;
    package?: string;
    module?: string;
    bins?: string[];
    label: string;
  }[];
  os?: string[];
  // Active skill fields — skills with a runtime backend
  runtime?: string; // backend module name (e.g. 'gmail', 'browser')
  auth?: {
    type: "oauth2" | "api-key" | "token";
    provider?: string;
    scopes?: string[];
  };
  tools?: string[]; // tool names this skill provides (e.g. ['gmail:send'])
  triggers?: string[]; // event types this skill can emit
}

export interface AgentSkill {
  id: string;
  name: string;
  content: string; // markdown content
  description?: string;
  homepage?: string;
  metadata?: SkillMetadata;
  authStatus?: "connected" | "disconnected" | "expired" | "error"; // for active skills
}

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
}

export interface Session {
  id: string;
  agentId: string;
  claudeSessionId?: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  totalCostUsd?: number;
  messages: Message[];
}

export interface SessionMeta {
  id: string;
  agentId: string;
  claudeSessionId?: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  totalCostUsd?: number;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  result: string;
}

export type AgentStatus =
  | "idle"
  | "thinking"
  | "working"
  | "speaking"
  | "collaborating"
  | "waiting-input"
  | "waiting-approval"
  | "slow"
  | "stuck"
  | "background"
  | "channel-message"
  | "browsing"
  | "scheduled-task";

export interface BackgroundTask {
  id: string;
  agentId: string;
  agentName: string;
  prompt: string;
  status: "running" | "done" | "error";
  startedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
}

export type AgentScope = "user" | "project";

export interface AgentTodo {
  id: string;
  text: string;
  status: "pending" | "in-progress" | "done" | "error";
  result?: string;
  error?: string;
  timestamp: number;
}

export interface McpServerInline {
  type: "stdio" | "http" | "sse" | "ws";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface HookCommand {
  type: "command";
  command: string;
}

export interface HookMatcher {
  matcher?: string;
  hooks: HookCommand[];
}

export interface SubagentDef {
  description: string;
  prompt?: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: "sonnet" | "opus" | "haiku" | "inherit" | string;
  permissionMode?: string;
  maxTurns?: number;
  skills?: string[];
  memory?: "user" | "project" | "local";
  background?: boolean;
  isolation?: "worktree";
  mcpServers?: (string | Record<string, McpServerInline>)[];
  excludeGlobalSkills?: string[];
  hooks?: Record<string, HookMatcher[]>;
  criticalSystemReminder?: string;
  thinking?: "adaptive" | "enabled" | "disabled";
  thinkingBudget?: number;
  effort?: "low" | "medium" | "high" | "max";
}

export interface Agent {
  id: string;
  name: string;
  role: string; // job title shown under their sprite
  personality: string; // system prompt
  model: ModelId;
  provider: Provider;
  skills: AgentSkill[];
  position: { x: number; y: number }; // tile position in office grid
  status: AgentStatus;
  currentThought: string;
  spriteKey: string; // which 8-bit character to use
  history: Message[]; // conversation history
  color: string; // accent color for the employee card
  todos: AgentTodo[]; // per-agent task checklist
  isBoss?: boolean; // boss character — cannot be deleted
  // Claude Code subagent integration
  subagentFile?: string; // path to the .md file this agent was synced from
  subagentDef?: SubagentDef; // parsed subagent definition
  agentScope?: AgentScope; // 'user' (~/.claude/agents/) or 'project' (.claude/agents/)
  sessionId?: string; // Claude Code session ID for continuity
  currentSessionId?: string; // active Outworked session ID (for persistence)
  collaboratingWith?: string; // id of agent being consulted (ephemeral, drives walk animation)
  autoCreated?: boolean; // true if created automatically by the orchestrator
  // Ephemeral streaming state — allows viewing an agent's live work from any tab
  liveStreamText?: string; // partial response text being generated
  liveToolCalls?: { name: string; args: string; timestamp: number }[]; // tool calls in progress
  liveThinking?: string; // current thinking preview
}

// ─── Messaging Channels ─────────────────────────────────────────

export interface ChannelMessage {
  id?: number;
  channelId: string;
  direction: "inbound" | "outbound";
  conversationId?: string;
  sender?: string;
  content: string;
  metadata?: Record<string, unknown>;
  timestamp: number;
}

export interface ChannelConfig {
  id: string;
  type: string; // 'imessage', 'slack'
  name: string;
  config: Record<string, unknown> & {
    /** Phone numbers / emails / user IDs allowed to message this channel. Empty or ['*'] = allow all. */
    allowedSenders?: string[];
  };
  status: "connected" | "disconnected" | "error";
  createdAt: number;
  updatedAt: number;
}

// ─── Scheduled Tasks ────────────────────────────────────────────

export interface ScheduledTask {
  id: string;
  name: string;
  type: "one-time" | "interval" | "cron";
  schedule: string; // ISO timestamp, ms interval, or cron expression
  agentId: string;
  prompt: string;
  enabled: boolean;
  lastRunAt?: number;
  nextRunAt: number;
  runCount: number;
  maxRuns?: number;
  createdAt: number;
  updatedAt: number;
}

export interface TaskRunLog {
  id: number;
  taskId: string;
  agentId: string;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  status: "running" | "completed" | "error";
  result?: string;
  error?: string;
}

// ─── Triggers ───────────────────────────────────────────────────

export interface Trigger {
  id: string;
  name: string;
  enabled: boolean;
  type: "message-pattern" | "skill-event" | "webhook" | "schedule";
  pattern?: string;
  channelId?: string;
  senderAllowlist?: string[];
  agentId: string;
  prompt: string;
  createdAt: number;
  lastTriggeredAt?: number;
  triggerCount: number;
}

// ─── Memory ─────────────────────────────────────────────────────

export interface MemoryEntry {
  id: string;
  scope: string;
  key: string;
  value: string;
  createdAt: number;
  updatedAt: number;
}

// ─── Skill Tools ────────────────────────────────────────────────

export interface SkillTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  skillId: string;
}

// ─── Active Orchestrations ─────────────────────────────────────

export interface OrchestrationAssignment {
  agentId: string;
  agentName: string;
  task: string;
  subtasks: string[];
  group: number;
  status: "pending" | "running" | "done" | "error";
  result?: string;
}

export interface ActiveOrchestration {
  id: string;
  plan: string;
  assignments: OrchestrationAssignment[];
  startedAt: number;
  /** If triggered by a channel message, store context for the reply */
  channelContext?: {
    channelId: string;
    conversationId?: string;
    sender?: string;
    originalMessage: string;
  };
  /** Progress text shown during orchestration */
  progressText: string;
}

export interface AgentMessage {
  id: string;
  fromAgentId: string;
  fromAgentName: string;
  toAgentId: string;
  toAgentName: string;
  question: string;
  response?: string;
  timestamp: number;
}

export interface ApiKeys {
  openai: string;
  anthropic: string;
  gemini: string;
  github: string;
}

export const MODELS: { id: ModelId; label: string; provider: Provider }[] = [
  { id: "claude-code", label: "Claude Code (local)", provider: "claude-code" },
];

export const SPRITE_KEYS = [
  "char_blue",
  "char_red",
  "char_green",
  "char_yellow",
  "char_purple",
  "char_orange",
  "char_pink",
  "char_teal",
  "char_cyan",
  "char_lime",
  "char_rose",
  "char_amber",
];

export const AGENT_COLORS = [
  "#6366f1", // indigo
  "#ef4444", // red
  "#22c55e", // green
  "#eab308", // yellow
  "#a855f7", // purple
  "#f97316", // orange
  "#ec4899", // pink
  "#14b8a6", // teal
  "#06b6d4", // cyan
  "#84cc16", // lime
  "#f43f5e", // rose
  "#f59e0b", // amber
];
