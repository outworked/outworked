import { useState, useRef, useEffect, useCallback } from "react";
import {
  ActiveOrchestration,
  Agent,
  AgentSkill,
  AgentStatus,
  AgentTodo,
  BackgroundTask,
  Message,
  MODELS,
  OrchestrationAssignment,
  SessionMeta,
  ToolCall,
} from "../lib/types";
import { sendMessage } from "../lib/ai";
import { addCumulativeCost } from "../lib/costs";
import {
  executeTask,
  routeTasks,
  routeTasksViaClaudeCode,
} from "../lib/orchestrator";
import type { AgentTeamCallbacks } from "../lib/orchestrator";
import { createAgent, createClaudeAgentFile } from "../lib/storage";
import { resolveClaudePermission, PermissionRequest } from "../lib/terminal";
import {
  createSession,
  saveSession,
  loadSession,
  listSessions,
  deleteSession,
  searchSessions,
} from "../lib/sessions";
import { addExchange, clearExchanges, parseAskRequests } from "../lib/agentBus";
import { getSetting } from "../lib/settings";
import PermissionModal from "./PermissionModal";
import MarkdownMessage from "./MarkdownMessage";

/** Extract the last meaningful snippet from cumulative streaming text for thought bubbles. */
function tailThought(text: string, maxLen = 70): string {
  // Grab the last non-empty line (streaming text accumulates with newlines)
  const lines = text.split("\n").filter((l) => l.trim());
  const last = lines.length > 0 ? lines[lines.length - 1].trim() : text.trim();
  if (last.length <= maxLen) return last;
  return "..." + last.slice(last.length - maxLen + 3);
}

export interface OrchestrationDoneEvent {
  success: number;
  failed: number;
  plan: string;
  agents: string[];
}

interface ChatWindowProps {
  agent: Agent | null;
  agents: Agent[];
  skills: AgentSkill[];
  onUpdateAgent: (agent: Agent) => void;
  onAddAgent: (agent: Agent) => void;
  agentTeamsEnabled?: boolean;
  onOrchestrationDone?: (event: OrchestrationDoneEvent) => void;
  onPermissionNotification?: (
    agentName: string,
    request: PermissionRequest,
  ) => void;
  debugMode: boolean;
  backgroundTasks: BackgroundTask[];
  onStartBackgroundTask: (
    task: BackgroundTask,
    execute: () => Promise<{ reply: string; agent: Agent }>,
  ) => void;
  autoApprovePermissions?: boolean;
  /** Programmatically injected message (e.g. from a trigger). Consumed once. */
  pendingMessage?: { text: string; nonce: string } | null;
  onPendingMessageConsumed?: () => void;
}

const EMPTY_KEYS = { openai: "", anthropic: "", gemini: "", github: "" };

const STATUS_COLORS: Record<string, string> = {
  idle: "#6b7280",
  thinking: "#f59e0b",
  working: "#22c55e",
  speaking: "#3b82f6",
  "waiting-input": "#f97316",
  "waiting-approval": "#eab308",
  slow: "#eab308",
  stuck: "#ef4444",
  collaborating: "#8b5cf6",
  background: "#6366f1",
};

const STATUS_LABELS: Record<string, string> = {
  idle: "Idle",
  thinking: "Thinking…",
  working: "Working…",
  speaking: "Responding…",
  collaborating: "Collaborating…",
  "waiting-input": "Needs input",
  "waiting-approval": "Needs approval",
  slow: "Slow",
  stuck: "Stuck",
  background: "Running in background",
};

function formatElapsed(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m ${s}s`;
}

/** Collapsible card for a single agent's task result inside the boss summary. */
function BossTaskCard({
  agentName,
  success,
  reply,
  agents,
}: {
  agentName: string;
  success: boolean;
  reply: string;
  agents: Agent[];
}) {
  const [expanded, setExpanded] = useState(false);
  const agentColor =
    agents.find((a) => a.name === agentName)?.color || "#94a3b8";
  const preview =
    reply.split("\n").filter(Boolean)[0]?.slice(0, 120) || reply.slice(0, 120);

  return (
    <div className="group">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-slate-800/40 transition-colors"
      >
        <span className="mt-0.5 shrink-0 text-[11px]">
          {success ? "✅" : "❌"}
        </span>
        <div
          className="w-2 h-2 rounded-full mt-1.5 shrink-0"
          style={{ backgroundColor: agentColor }}
        />
        <div className="flex-1 min-w-0">
          <span className="text-[11px] font-pixel text-white">{agentName}</span>
          {!expanded && (
            <p className="text-[10px] text-slate-400 truncate mt-0.5">
              {preview}
            </p>
          )}
        </div>
        <span className="text-[10px] text-slate-500 shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          {expanded ? "▲" : "▼"}
        </span>
      </button>
      {expanded && (
        <div className="px-3 pb-2 pl-10 text-[11px] leading-relaxed text-slate-300 max-h-64 overflow-y-auto">
          <MarkdownMessage content={reply} />
        </div>
      )}
    </div>
  );
}

export default function ChatWindow({
  agent,
  agents,
  skills,
  onUpdateAgent,
  onAddAgent,
  agentTeamsEnabled,
  onOrchestrationDone,
  onPermissionNotification,
  autoApprovePermissions,
  debugMode,
  backgroundTasks,
  onStartBackgroundTask,
  pendingMessage,
  onPendingMessageConsumed,
}: ChatWindowProps) {
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingAgentId, setStreamingAgentId] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState("");
  const [pendingPermission, setPendingPermission] =
    useState<PermissionRequest | null>(null);
  const [permissionLog, setPermissionLog] = useState<
    { tool: string; description: string; agentName?: string; timestamp: number; autoApproved: boolean }[]
  >([]);
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const [showDebug, setShowDebug] = useState(false);
  const [toolCalls, setToolCalls] = useState<
    { name: string; args: string; timestamp: number }[]
  >([]);
  const [thinkingPreview, setThinkingPreview] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [sessionList, setSessionList] = useState<SessionMeta[]>([]);
  const [sessionSearch, setSessionSearch] = useState("");
  const [workStartedAt, setWorkStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const debugBottomRef = useRef<HTMLDivElement>(null);
  const pendingNonceRef = useRef<string | null>(null);
  const activeOrchestrationRef = useRef<ActiveOrchestration | null>(null);
  // Always-current agents ref for background closures that outlive the render
  const agentsRef = useRef(agents);
  agentsRef.current = agents;

  // Auto-send programmatically injected messages (e.g. from triggers).
  // Uses a ref to pass the text directly to handleSend instead of relying
  // on DOM button clicks which can silently fail.
  const pendingAutoSendRef = useRef<string | null>(null);

  useEffect(() => {
    if (
      pendingMessage &&
      pendingMessage.nonce !== pendingNonceRef.current &&
      agent &&
      // Allow messages through when boss has an active orchestration (employees
      // are working but the boss is free to respond to channel messages)
      (!isStreaming || (agent.isBoss && activeOrchestrationRef.current))
    ) {
      pendingNonceRef.current = pendingMessage.nonce;
      pendingAutoSendRef.current = pendingMessage.text;
      setInput(pendingMessage.text);
      onPendingMessageConsumed?.();
      // Defer to next tick so input state is set before handleSend reads it
      setTimeout(() => {
        const sendBtn = document.getElementById("chat-send-btn");
        if (sendBtn) {
          sendBtn.click();
        } else {
          // Fallback: reset agent status if we can't send
          console.warn("[ChatWindow] Could not find send button for auto-send");
          pendingAutoSendRef.current = null;
        }
      }, 100);
    }
  }, [pendingMessage, agent, isStreaming]); // eslint-disable-line react-hooks/exhaustive-deps

  function addDebug(line: string) {
    const ts = new Date().toISOString().slice(11, 23);
    setDebugLog((prev) => [...prev.slice(-500), `[${ts}] ${line}`]);
  }

  // Auto-show debug panel when debug mode is turned on
  useEffect(() => {
    if (debugMode) setShowDebug(true);
  }, [debugMode]);

  // Elapsed timer — ticks every second while streaming or background task is running
  const hasRunningBgTask = agent
    ? backgroundTasks.some(
        (t) => t.agentId === agent.id && t.status === "running",
      )
    : false;
  useEffect(() => {
    if (!workStartedAt && !hasRunningBgTask) {
      setElapsed(0);
      return;
    }
    const interval = setInterval(() => {
      if (workStartedAt) {
        setElapsed(Math.floor((Date.now() - workStartedAt) / 1000));
      } else {
        // Force re-render for background task timer
        setElapsed((prev) => prev + 1);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [workStartedAt, hasRunningBgTask]);

  // Load session list when history panel opens or agent changes
  const refreshSessionList = useCallback(async () => {
    if (!agent) return;
    const list = sessionSearch
      ? await searchSessions(agent.id, sessionSearch)
      : await listSessions(agent.id);
    setSessionList(list);
  }, [agent?.id, sessionSearch]);

  useEffect(() => {
    if (showHistory && agent) refreshSessionList();
  }, [showHistory, agent?.id, refreshSessionList]);

  // Debounced search
  useEffect(() => {
    if (!showHistory) return;
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => refreshSessionList(), 300);
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [sessionSearch, showHistory, refreshSessionList]);

  // Save current session to disk
  async function persistSession(agentState: Agent) {
    if (!agentState.currentSessionId || agentState.history.length === 0) return;
    await saveSession({
      id: agentState.currentSessionId,
      agentId: agentState.id,
      claudeSessionId: agentState.sessionId,
      title:
        agentState.history
          .find((m) => m.role === "user")
          ?.content.slice(0, 50) || "Conversation",
      createdAt: agentState.history[0]?.timestamp || Date.now(),
      updatedAt: Date.now(),
      messageCount: agentState.history.length,
      messages: agentState.history,
    });
  }

  // Start a new chat (save current, clear history)
  async function handleNewChat() {
    if (!agent) return;
    await persistSession(agent);
    onUpdateAgent({
      ...agent,
      history: [],
      currentSessionId: undefined,
      sessionId: undefined,
      currentThought: "",
    });
    setShowHistory(false);
  }

  // Resume a past session
  async function handleResumeSession(meta: SessionMeta) {
    if (!agent) return;
    // Save current session first
    await persistSession(agent);
    // Load the selected session
    const session = await loadSession(meta.agentId, meta.id);
    if (!session) return;
    onUpdateAgent({
      ...agent,
      history: session.messages,
      currentSessionId: session.id,
      sessionId: session.claudeSessionId,
    });
    setShowHistory(false);
  }

  // Delete a session from history
  async function handleDeleteSession(meta: SessionMeta) {
    await deleteSession(meta.agentId, meta.id);
    // If we just deleted the active session, clear it
    if (agent?.currentSessionId === meta.id) {
      onUpdateAgent({
        ...agent,
        history: [],
        currentSessionId: undefined,
        sessionId: undefined,
      });
    }
    refreshSessionList();
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [
    agent?.history,
    streamingText,
    thinkingPreview,
    toolCalls,
    agent?.liveStreamText,
    agent?.liveToolCalls,
    agent?.liveThinking,
  ]);

  useEffect(() => {
    debugBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [debugLog]);

  if (!agent) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-4 gap-3">
        <div className="text-4xl">🖥️</div>
        <p className="text-xs font-pixel text-slate-300">
          Click on an employee in the office to start chatting
        </p>
      </div>
    );
  }

  async function handleSend() {
    if (!input.trim() || !agent) return;
    // Allow sending when boss has active orchestration (employees working, boss is free)
    if (isStreaming && !(agent.isBoss && activeOrchestrationRef.current))
      return;
    const userText = input.trim();
    setInput("");
    setWorkStartedAt(Date.now());
    setIsStreaming(true);
    setStreamingAgentId(agent.id);
    setStreamingText("");
    setToolCalls([]);
    setPermissionLog([]);
    setThinkingPreview("");

    const userMsg: Message = {
      role: "user",
      content: userText,
      timestamp: Date.now(),
    };

    // Create a new session if this is the first message
    let sessionId = agent.currentSessionId;
    if (!sessionId) {
      const session = createSession(agent.id, userText);
      sessionId = session.id;
    }

    const updatedWithUser: Agent = {
      ...agent,
      history: [...agent.history, userMsg],
      status: "thinking",
      currentThought: "Thinking...",
      currentSessionId: sessionId,
    };
    onUpdateAgent(updatedWithUser);

    abortRef.current = new AbortController();

    const isBoss = !!agent.isBoss;
    if (debugMode) {
      setDebugLog([]);
      setShowDebug(true);
      addDebug(
        `--- New message to ${agent.name} (${isBoss ? "boss" : "agent"}) ---`,
      );
      addDebug(`User: ${userText.slice(0, 200)}`);
    }

    // Boss orchestration updates todos during execution (Step 4 & 6).
    // Capture them here so the final agent update doesn't overwrite them
    // with the stale pre-orchestration updatedWithUser.
    let orchestrationTodos: AgentTodo[] | undefined;
    // Similarly, capture the Claude Code sessionId so follow-up messages
    // can resume the same session and retain full conversation context.
    // Only set when the inner handler provides a new sessionId.
    let bossSessionId: string | undefined;

    try {
      let reply: string;

      // ── Boss with active orchestration: answer with context about in-flight work ──
      if (isBoss && activeOrchestrationRef.current) {
        const orch = activeOrchestrationRef.current;
        const statusLines = orch.assignments
          .map((a) => {
            const emoji =
              a.status === "done"
                ? "✅"
                : a.status === "running"
                  ? "🔄"
                  : a.status === "error"
                    ? "❌"
                    : "⏳";
            return `${emoji} **${a.agentName}**: ${a.task} — *${a.status}*${a.result ? ` (done: ${a.result.slice(0, 100)}...)` : ""}`;
          })
          .join("\n");
        const contextPrompt =
          `You are the office manager. While your team is working, you received a new message.\n\n` +
          `**Current orchestration in progress** (started ${Math.round((Date.now() - orch.startedAt) / 1000)}s ago):\n` +
          `Plan: ${orch.plan}\n\n${statusLines}\n\n` +
          `**New message:** ${userText}\n\n` +
          `Respond naturally. If they're asking about what the office is working on, summarize the current tasks and progress. ` +
          `If it's a separate question, answer it directly. Keep it concise.`;
        reply = await handleRegularChat(updatedWithUser, contextPrompt);
      } else if (isBoss && agentTeamsEnabled) {
        // Agent Teams mode: let Claude Code handle orchestration natively
        reply = await handleBossAgentTeams(updatedWithUser, userText);
      } else if (isBoss) {
        // Custom orchestrator: plan tasks, then dispatch to employees in background
        reply = await handleBossOrchestrate(updatedWithUser, userText);
      } else {
        // Regular agent: direct chat with tools
        reply = await handleRegularChat(updatedWithUser, userText);
      }

      // If this was a channel message and no active orchestration is running,
      // give the boss a follow-up turn with tools to send the reply back via send_message.
      // (When orchestration is active, the completion handler sends the reply instead.)
      const wasChannelMessage = updatedWithUser.status === "channel-message";
      if (wasChannelMessage && isBoss && !activeOrchestrationRef.current) {
        onUpdateAgent({
          ...updatedWithUser,
          status: "working",
          currentThought: "📤 Sending reply...",
        });
        const sendPrompt =
          `Here is the result of the tasks you orchestrated:\n\n${reply}\n\n` +
          `Now send a concise summary of these results back to the person who messaged you. ` +
          `Use the send_message tool with the channelId and conversationId from the original message above. ` +
          `Keep the reply short and helpful.`;
        try {
          await handleRegularChat(updatedWithUser, sendPrompt);
        } catch {
          // Best-effort — don't fail the whole orchestration if send fails
          console.warn("[boss] Failed to send channel reply");
        }
      }

      const assistantMsg: Message = {
        role: "assistant",
        content: reply,
        timestamp: Date.now(),
      };
      // When the boss delegates in background mode, the orchestration has already
      // set up todos on the boss. Use the current agent state (via agentsRef) to
      // avoid overwriting those with the stale pre-orchestration updatedWithUser.
      const currentState = agentsRef.current.find((a) => a.id === updatedWithUser.id) || updatedWithUser;
      const finalAgent: Agent = {
        ...currentState,
        // Preserve orchestration todos — updatedWithUser has stale pre-orchestration state
        ...(orchestrationTodos && { todos: orchestrationTodos }),
        // Preserve Claude Code sessionId so follow-ups resume the same session
        ...(bossSessionId && { sessionId: bossSessionId }),
        history: [...updatedWithUser.history, assistantMsg],
        status: "idle",
        currentThought: tailThought(reply, 80),
      };
      onUpdateAgent(finalAgent);
      // Persist session to disk
      persistSession(finalAgent);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      if (errorMsg !== "AbortError") {
        const errMsg: Message = {
          role: "assistant",
          content: `⚠️ Error: ${errorMsg}`,
          timestamp: Date.now(),
        };
        onUpdateAgent({
          ...updatedWithUser,
          history: [...updatedWithUser.history, errMsg],
          status: "idle",
          currentThought: "",
        });
      } else {
        onUpdateAgent({
          ...updatedWithUser,
          status: "idle",
          currentThought: "",
        });
      }
    } finally {
      setIsStreaming(false);
      setStreamingText("");
      setWorkStartedAt(null);
      abortRef.current = null;
    }

    // ── Collaboration visual: show agent consulting with another ──
    // Triggers the walk-to-agent animation and waits for it to be visible
    // before continuing. Used between sequential task handoffs and for
    // explicit [ASK:Name] requests.
    async function showCollaboration(
      fromAgent: Agent,
      toAgent: Agent,
      thought: string,
      durationMs = 2500,
    ): Promise<void> {
      if (debugMode)
        addDebug(
          `[collab] ${fromAgent.name} → ${toAgent.name}: ${thought.slice(0, 80)}`,
        );

      // Set collaborating state — triggers Phaser walk animation
      onUpdateAgent({
        ...fromAgent,
        status: "collaborating" as AgentStatus,
        collaboratingWith: toAgent.id,
        currentThought: thought,
      });
      onUpdateAgent({
        ...toAgent,
        status: "speaking",
        currentThought: `Talking with ${fromAgent.name}`,
      });

      // Hold the visual for the duration so users can see it
      await new Promise((resolve) => setTimeout(resolve, durationMs));

      // Reset
      onUpdateAgent({
        ...fromAgent,
        status: "working",
        collaboratingWith: undefined,
        currentThought: "",
      });
      onUpdateAgent({ ...toAgent, status: "idle", currentThought: "" });
    }

    // ── Post-step collaboration handler ─────────────────────────
    // Scans reply for [ASK:Name] patterns, sends question to colleague,
    // and returns their answer as context.
    async function handleCollaborationRequests(
      askingAgent: Agent,
      reply: string,
      availableAgents: Agent[],
    ): Promise<string> {
      const asks = parseAskRequests(reply);
      if (asks.length === 0) return "";

      const answers: string[] = [];
      for (const ask of asks) {
        const target = availableAgents.find(
          (a) =>
            a.name.toLowerCase() === ask.agentName.toLowerCase() &&
            a.id !== askingAgent.id,
        );
        if (!target) {
          answers.push(
            `[${ask.agentName} not found — no colleague with that name]`,
          );
          continue;
        }

        // Visual: asking agent walks to target
        onUpdateAgent({
          ...askingAgent,
          status: "collaborating" as AgentStatus,
          collaboratingWith: target.id,
          currentThought: `💬 Asking ${target.name}...`,
        });
        onUpdateAgent({
          ...target,
          status: "thinking",
          currentThought: `${askingAgent.name} asked: ${ask.question.slice(0, 60)}`,
        });

        try {
          const { text: response } = await sendMessage(
            { ...target, history: [] },
            `[COLLEAGUE QUESTION from ${askingAgent.name}]: ${ask.question}\n\nPlease answer this question from your colleague concisely.`,
            EMPTY_KEYS,
            (partial) =>
              onUpdateAgent({
                ...target,
                status: "working",
                currentThought: tailThought(partial, 80),
              }),
            abortRef.current?.signal,
            { useTools: true, skills },
          );

          addExchange(
            askingAgent.id,
            askingAgent.name,
            target.id,
            target.name,
            ask.question,
            response,
          );
          answers.push(`[${target.name} replied]: ${response}`);
        } catch (err) {
          answers.push(
            `[Error asking ${target.name}: ${err instanceof Error ? err.message : "Unknown error"}]`,
          );
        } finally {
          onUpdateAgent({ ...target, status: "idle", currentThought: "" });
          onUpdateAgent({
            ...askingAgent,
            status: "working",
            collaboratingWith: undefined,
            currentThought: "Processing colleague input...",
          });
        }
      }

      return "\n\nColleague responses:\n" + answers.join("\n");
    }

    // ── Boss Agent Teams flow (native Claude Code orchestration) ──
    // Claude Code itself coordinates the teammates — we just wire up
    // callbacks so the UI stays in sync. The boss returns immediately
    // and stays responsive while employees work in the background.
    async function handleBossAgentTeams(
      bossAgent: Agent,
      userText: string,
    ): Promise<string> {
      clearExchanges();

      onUpdateAgent({
        ...bossAgent,
        status: "working",
        currentThought: "Delegating via Agent Teams...",
      });
      setStreamingText("Delegating via Agent Teams...\n");
      if (debugMode) addDebug(`[teams] Starting Agent Teams orchestration`);

      // Track per-agent state for todos, collaboration, and completion
      const agentTodos = new Map<string, AgentTodo>();
      const bossTodos: AgentTodo[] = [];
      const agentStatuses = new Map<string, "working" | "done" | "error">();
      let lastCompletedAgent: { name: string; timestamp: number } | null = null;

      // Create orchestration so the boss stays responsive during background work
      const wasChannelMessage = bossAgent.status === "channel-message";
      const orchestration: ActiveOrchestration = {
        id: crypto.randomUUID(),
        plan: "Agent Teams orchestration",
        assignments: [],
        startedAt: Date.now(),
        channelContext: wasChannelMessage ? extractChannelContext(userText) : undefined,
        progressText: "Delegating via Agent Teams...",
      };
      activeOrchestrationRef.current = orchestration;

      const teamCallbacks: AgentTeamCallbacks = {
        onTeamEvent: (event) => {
          if (event.type === "text" && event.text) {
            setStreamingText((s) => s + event.text);
          }
          if (event.type === "tool_use" && event.text) {
            if (debugMode) addDebug(`[teams] ${event.text}`);
          }
        },
        onAgentDelegation: (agentName, task) => {
          // Create boss todo for this delegation
          const bossTodo: AgentTodo = {
            id: `teams-boss-${Date.now()}-${agentName}`,
            text: `→ ${agentName}: ${task}`,
            status: "in-progress",
            timestamp: Date.now(),
          };
          bossTodos.push(bossTodo);
          onUpdateAgent({
            ...bossAgent,
            todos: [...(bossAgent.todos || []), ...bossTodos],
          });

          // Create todo on the target employee
          const emp = agents.find(
            (a) => a.name.toLowerCase() === agentName.toLowerCase(),
          );
          if (emp) {
            const empTodo: AgentTodo = {
              id: `teams-emp-${Date.now()}-${agentName}`,
              text: task,
              status: "in-progress",
              timestamp: Date.now(),
            };
            agentTodos.set(agentName.toLowerCase(), empTodo);
            onUpdateAgent({
              ...emp,
              todos: [...(emp.todos ?? []), empTodo],
            });
          }

          // Dynamically populate orchestration assignments for boss-busy guard
          orchestration.assignments.push({
            agentId: emp?.id ?? "",
            agentName,
            task,
            subtasks: [],
            group: 1,
            status: "running",
          });

          // Collaboration visual: sequential handoff
          if (lastCompletedAgent && Date.now() - lastCompletedAgent.timestamp < 5000) {
            const fromEmp = agents.find(
              (a) => a.name.toLowerCase() === lastCompletedAgent!.name.toLowerCase(),
            );
            if (fromEmp && emp && fromEmp.id !== emp.id) {
              showCollaboration(emp, fromEmp, `Getting context from ${fromEmp.name}`, 2000);
            }
          }
        },
        onAgentStatus: (agentName, status, thought) => {
          const emp = agents.find(
            (a) => a.name.toLowerCase() === agentName.toLowerCase(),
          );

          if (status === "done") {
            agentStatuses.set(agentName.toLowerCase(), "done");
            lastCompletedAgent = { name: agentName, timestamp: Date.now() };

            // Mark todos as done
            const empTodo = agentTodos.get(agentName.toLowerCase());
            if (empTodo && emp) {
              empTodo.status = "done";
              onUpdateAgent({
                ...emp,
                todos: (emp.todos ?? []).map((t) =>
                  t.id === empTodo.id ? { ...t, status: "done" as const } : t,
                ),
              });
            }
            const bossTodo = bossTodos.find((t) =>
              t.text.toLowerCase().startsWith(`→ ${agentName.toLowerCase()}`),
            );
            if (bossTodo) {
              bossTodo.status = "done";
            }

            // Update orchestration assignment status
            const assignment = orchestration.assignments.find(
              (a) => a.agentName.toLowerCase() === agentName.toLowerCase(),
            );
            if (assignment) assignment.status = "done";
          }

          if (emp) {
            onUpdateAgent({
              ...emp,
              status:
                status === "working"
                  ? "working"
                  : status === "done"
                    ? "idle"
                    : status === "waiting-input"
                      ? "thinking"
                      : status === "waiting-approval"
                        ? "thinking"
                        : status === "slow"
                          ? "slow"
                          : status === "stuck"
                            ? "stuck"
                            : emp.status,
              currentThought: thought || "",
              // Clear live streaming state when agent completes
              ...(status === "done" ? { liveStreamText: "", liveToolCalls: [], liveThinking: "" } : {}),
            });
          }
          if (debugMode)
            addDebug(`[teams] ${agentName} → ${status}: ${thought || ""}`);
        },
        onAgentStreamDelta: (agentName, delta, fullText) => {
          const emp = agents.find(
            (a) => a.name.toLowerCase() === agentName.toLowerCase(),
          );
          if (emp) {
            onUpdateAgent({
              ...emp,
              liveStreamText: fullText,
              currentThought: tailThought(delta),
            });
          }
        },
        onAgentToolUse: (agentName, toolName, input) => {
          const emp = agents.find(
            (a) => a.name.toLowerCase() === agentName.toLowerCase(),
          );
          if (emp) {
            const label = `${toolName}${(input as Record<string, unknown>).file_path ? ` ${(input as Record<string, unknown>).file_path}` : ""}`;
            onUpdateAgent({
              ...emp,
              liveToolCalls: [
                ...(emp.liveToolCalls ?? []),
                { name: toolName, args: label, timestamp: Date.now() },
              ],
              currentThought: label,
            });
          }
        },
        onNewAgent: (agentName, description) => {
          if (debugMode)
            addDebug(
              `[teams] New agent requested: ${agentName} — ${description}`,
            );
          const existing = agents.find(
            (a) => a.name.toLowerCase() === agentName.toLowerCase(),
          );
          if (!existing) {
            const newAgent = createAgent(
              {
                name: agentName,
                role: description,
                personality: description,
                position: {
                  x: Math.floor(Math.random() * 10) + 2,
                  y: Math.floor(Math.random() * 6) + 2,
                },
                autoCreated: true,
              },
              true,
            );
            onAddAgent(newAgent);
          }
        },
        onPermissionRequest: (agentName, tool, description, reqId, permId) => {
          const request: PermissionRequest = {
            tool,
            description,
            reqId: reqId ?? 0,
            permId: permId ?? "",
            agentName,
          };
          handleIncomingPermission(request, agentName || bossAgent.name);
        },
      };

      // Fire-and-forget: boss returns immediately, employees work in background
      runAgentTeamsInBackground(
        orchestration,
        bossAgent,
        userText,
        teamCallbacks,
        bossTodos,
        agentStatuses,
      );

      // Boss goes idle and can handle new messages
      onUpdateAgent({
        ...bossAgent,
        status: "idle",
        currentThought: "Team is working on it",
      });

      return "Delegating via Agent Teams... employees are working.";
    }

    /** Run Agent Teams orchestration in background — boss stays responsive */
    async function runAgentTeamsInBackground(
      orchestration: ActiveOrchestration,
      bossAgent: Agent,
      userText: string,
      teamCallbacks: AgentTeamCallbacks,
      bossTodos: AgentTodo[],
      agentStatuses: Map<string, "working" | "done" | "error">,
    ) {
      try {
        const result = await routeTasksViaClaudeCode(
          userText,
          agents,
          teamCallbacks,
          abortRef.current?.signal,
          debugMode ? (line) => addDebug(line) : undefined,
          bossAgent.sessionId,
          true, // enableAgentTeams
        );

        // Persist session for resume
        if (result.sessionId) {
          bossSessionId = result.sessionId;
        }

        // Per-agent cost tracking
        if (result.agentCosts) {
          for (const [agentNameLower, costs] of Object.entries(result.agentCosts)) {
            const emp = agents.find(
              (a) => a.name.toLowerCase() === agentNameLower,
            );
            if (emp && costs.cost > 0) {
              addCumulativeCost(
                emp.id,
                emp.name,
                costs.cost,
                costs.inputTokens,
                costs.outputTokens,
                emp.id,
              );
            }
          }
        } else if (result.cost && result.cost > 0) {
          // Fallback: attribute total cost to boss
          addCumulativeCost(
            bossAgent.id,
            bossAgent.name,
            result.cost,
            result.inputTokens || 0,
            result.outputTokens || 0,
            bossAgent.id,
          );
        }

        // Mark all boss todos as done
        for (const todo of bossTodos) {
          if (todo.status !== "done") todo.status = "done";
        }

        // Compile structured results
        const delegated = result.delegatedAgents || [];
        const successCount = [...agentStatuses.values()].filter((s) => s === "done").length;
        const failCount = [...agentStatuses.values()].filter((s) => s === "error").length;
        const statusLine =
          failCount === 0
            ? `All ${successCount || delegated.length} task${(successCount || delegated.length) !== 1 ? "s" : ""} completed successfully!`
            : `${successCount}/${successCount + failCount} tasks completed. ${failCount} failed.`;

        const structuredResults = delegated.map((name) => ({
          agent: name,
          success: agentStatuses.get(name.toLowerCase()) === "done",
          reply: "",
        }));

        const finalText =
          `${orchestration.progressText}\n\n---\n\n` +
          `**Results:**\n<!--TASK_RESULTS:${JSON.stringify(structuredResults)}:END_TASK_RESULTS-->\n\n` +
          `---\n${failCount === 0 ? "✅" : "⚠️"} **${statusLine}**\n\n` +
          (result.text || "");

        // Append completion message to boss history
        const completionMsg: Message = {
          role: "assistant",
          content: finalText,
          timestamp: Date.now(),
        };
        onUpdateAgent({
          ...bossAgent,
          sessionId: bossSessionId,
          todos: [
            ...(bossAgent.todos || []).filter(
              (t) => !bossTodos.some((bt) => bt.id === t.id),
            ),
            ...bossTodos,
          ],
          history: [...bossAgent.history, completionMsg],
          status: "idle",
          currentThought: "",
        });

        // Reset employee statuses
        for (const emp of agents.filter((a) => !a.isBoss)) {
          onUpdateAgent({
            ...emp,
            status: "idle",
            currentThought: "",
            liveStreamText: "",
            liveToolCalls: [],
            liveThinking: "",
          });
        }

        // Clear orchestration tracking
        activeOrchestrationRef.current = null;

        // Notify parent
        onOrchestrationDone?.({
          success: successCount || delegated.length,
          failed: failCount,
          plan: "Agent Teams orchestration",
          agents: delegated,
        });

        // If triggered by a channel message, send results back
        if (orchestration.channelContext?.channelId) {
          try {
            onUpdateAgent({
              ...bossAgent,
              status: "working",
              currentThought: "Sending reply...",
            });
            const sendPrompt =
              `Here are the results from the tasks you delegated:\n\n${finalText}\n\n` +
              `Now send a concise summary of these results back to the person who messaged you. ` +
              `Use the send_message tool with the channelId and conversationId from the original message. ` +
              `Original message context: ${orchestration.channelContext.originalMessage.slice(0, 500)}\n` +
              `Keep the reply short and helpful.`;
            await handleRegularChat(bossAgent, sendPrompt);
          } catch {
            console.warn("[boss] Failed to send channel reply after Agent Teams");
          } finally {
            onUpdateAgent({
              ...bossAgent,
              status: "idle",
              currentThought: "",
            });
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "Unknown error";
        if (debugMode) addDebug(`[teams] Error: ${errMsg}`);
        activeOrchestrationRef.current = null;
        onUpdateAgent({
          ...bossAgent,
          status: "idle",
          currentThought: "",
        });
        // Reset employee statuses on error too
        for (const emp of agents.filter((a) => !a.isBoss)) {
          onUpdateAgent({ ...emp, status: "idle", currentThought: "" });
        }
      }
    }

    // ── Boss orchestrator flow ───────────────────────────────────
    // The Boss ALWAYS delegates: plans tasks via JSON, then dispatches
    // each task to the assigned employee as a separate Claude Code process.
    async function handleBossOrchestrate(
      bossAgent: Agent,
      userText: string,
    ): Promise<string> {
      clearExchanges(); // Reset inter-agent message log for this run
      const employees = agents.filter((a) => !a.isBoss);

      // ── Step 1: Plan ──
      onUpdateAgent({
        ...bossAgent,
        status: "thinking",
        currentThought: "🧠 Planning task assignments...",
      });
      setStreamingText("🧠 Analyzing the request and creating a plan...\n");
      if (debugMode)
        addDebug(`[boss] Planning with ${employees.length} employees`);

      const routerModel = {
        model: bossAgent.model,
        provider: bossAgent.provider,
      };

      // Include recent conversation history so the router has context about
      // previous tasks and can handle follow-up questions properly.
      let instructionWithContext = userText;
      if (bossAgent.history.length > 0) {
        const recentMessages = bossAgent.history.slice(-10); // last 10 messages
        const historyLines = recentMessages
          .map((m) => {
            const prefix = m.role === "user" ? "User" : "Boss";
            // Trim long messages but keep enough for context
            const content =
              m.content.length > 500
                ? m.content.slice(0, 500) + "..."
                : m.content;
            return `${prefix}: ${content}`;
          })
          .join("\n\n");
        instructionWithContext = `## Recent conversation history\n${historyLines}\n\n## Current instruction\n${userText}`;
      }

      const result = await routeTasks(
        instructionWithContext,
        employees,
        EMPTY_KEYS,
        routerModel,
        abortRef.current?.signal,
        (text) => {
          setStreamingText(text);
        },
        (request) => {
          handleIncomingPermission(request, bossAgent.name);
        },
      );

      // Track boss planning cost
      if (result.cost && result.cost > 0) {
        addCumulativeCost(
          bossAgent.id,
          bossAgent.name,
          result.cost,
          result.inputTokens || 0,
          result.outputTokens || 0,
          bossAgent.id,
        );
      }

      // Check abort after planning
      if (abortRef.current?.signal.aborted) {
        onUpdateAgent({ ...bossAgent, status: "idle", currentThought: "" });
        setStreamingText("");
        return "Stopped.";
      }

      // If the boss answered directly (simple question), return immediately
      if (result.directAnswer) {
        if (debugMode)
          addDebug(`[boss] Answered directly — no delegation needed`);
        onUpdateAgent({ ...bossAgent, status: "idle", currentThought: "" });
        setStreamingText("");
        return result.directAnswer;
      }

      if (debugMode)
        addDebug(
          `[boss] Plan: ${result.plan}, ${result.assignments.length} assignments, ${result.newAgents.length} new agents`,
        );

      // ── Step 2: Create new agents if needed ──
      const newAgents: Agent[] = [];
      const wsDir = (await getSetting("outworked_workspace_dir")) || undefined;
      for (const spec of result.newAgents) {
        if (
          employees.find(
            (a) => a.name.toLowerCase() === spec.name.toLowerCase(),
          )
        )
          continue;
        if (
          newAgents.find(
            (a) => a.name.toLowerCase() === spec.name.toLowerCase(),
          )
        )
          continue;
        const newAgent = createAgent(
          {
            name: spec.name,
            role: spec.role,
            personality: spec.personality,
            position: {
              x: Math.floor(Math.random() * 10) + 2,
              y: Math.floor(Math.random() * 6) + 2,
            },
            autoCreated: true,
          },
          true,
        );
        // Set subagentFile BEFORE adding to state to prevent sync duplication
        const filePath = await createClaudeAgentFile(newAgent, wsDir);
        if (filePath) {
          newAgent.subagentFile = filePath;
        }
        newAgents.push(newAgent);
        onAddAgent(newAgent);
      }

      const allEmployees = [...employees, ...newAgents];

      // ── Step 3: Resolve assignments ──
      const assignments = result.assignments
        .map((a) => {
          const match = allEmployees.find(
            (ag) => ag.name.toLowerCase() === a.agentName.toLowerCase(),
          );
          return { ...a, agentId: match?.id ?? "" };
        })
        .filter((a) => a.agentId);

      if (assignments.length === 0) {
        // No tasks to delegate — answer the user directly instead of failing
        if (debugMode)
          addDebug(`[boss] No assignments — falling back to direct answer`);
        onUpdateAgent({
          ...bossAgent,
          status: "thinking",
          currentThought: "Answering directly...",
        });
        setStreamingText("");
        const directReply = await handleRegularChat(bossAgent, userText);
        return directReply;
      }

      // Check abort before execution
      if (abortRef.current?.signal.aborted) {
        onUpdateAgent({ ...bossAgent, status: "idle", currentThought: "" });
        setStreamingText("");
        return "Stopped.";
      }

      // ── Step 4: Create todos on Boss ──
      const bossTodos: AgentTodo[] = assignments.map((a, i) => ({
        id: `boss-${Date.now()}-${i}`,
        text: `→ ${a.agentName}: ${a.task}`,
        status: "pending" as const,
        timestamp: Date.now(),
      }));
      onUpdateAgent({
        ...bossAgent,
        todos: [...(bossAgent.todos || []), ...bossTodos],
        status: "working",
        currentThought: `📋 ${assignments.length} tasks to delegate`,
      });

      // ── Show plan ──
      const maxGroup = Math.max(...assignments.map((a) => a.group ?? 1));
      const hasParallel = assignments.some(
        (a, _, arr) =>
          arr.filter((b) => (b.group ?? 1) === (a.group ?? 1)).length > 1,
      );
      let progress = `📝 **Plan:** ${result.plan}\n`;
      if (newAgents.length > 0) {
        progress += `👥 **New hires:** ${newAgents.map((a) => `${a.name} (${a.role})`).join(", ")}\n`;
      }
      if (hasParallel) {
        progress += `⚡ **Parallel execution enabled** — ${maxGroup} group${maxGroup > 1 ? "s" : ""}\n`;
      }
      progress += `\n**Tasks:**\n${assignments
        .map((a) => {
          const prefix = hasParallel ? `[G${a.group ?? 1}] ` : "";
          const subtaskList =
            a.subtasks.length > 1
              ? "\n" + a.subtasks.map((st) => `  - ${st}`).join("\n")
              : "";
          return `- ${prefix}**${a.agentName}**: ${a.task}${subtaskList}`;
        })
        .join("\n")}\n\n⏳ Delegated — employees are working...\n`;
      setStreamingText(progress);

      // ── Track active orchestration so the boss can respond to messages while employees work ──
      const wasChannelMessage = bossAgent.status === "channel-message";
      const orchAssignments: OrchestrationAssignment[] = assignments.map(
        (a) => ({
          agentId: a.agentId,
          agentName: a.agentName,
          task: a.task,
          subtasks: a.subtasks,
          group: a.group ?? 1,
          status: "pending" as const,
        }),
      );
      const orchestration: ActiveOrchestration = {
        id: crypto.randomUUID(),
        plan: result.plan,
        assignments: orchAssignments,
        startedAt: Date.now(),
        channelContext: wasChannelMessage
          ? extractChannelContext(userText)
          : undefined,
        progressText: progress,
      };
      activeOrchestrationRef.current = orchestration;

      // ── Step 5: Execute tasks in background ──
      // Fire-and-forget: the boss returns to idle and can handle new messages
      // while employees work. Completion is handled asynchronously.
      runOrchestrationInBackground(
        orchestration,
        bossAgent,
        assignments,
        allEmployees,
        bossTodos,
        progress,
        result.plan,
      ).catch((err) => {
        console.error("[boss] Background orchestration failed:", err);
        activeOrchestrationRef.current = null;
        // Reset any employees that were set to working
        for (const a of allEmployees) {
          onUpdateAgent({ ...a, status: "idle", currentThought: "" });
        }
        onUpdateAgent({
          ...bossAgent,
          status: "idle",
          currentThought: `Orchestration error: ${err?.message || err}`,
        });
      });

      // Boss is now free — return the plan as the immediate reply
      onUpdateAgent({
        ...bossAgent,
        todos: [...(bossAgent.todos || []), ...bossTodos],
        status: "idle",
        currentThought: "Team is working on it",
      });

      return progress;
    }

    /** Extract channel context from the trigger prompt for later reply */
    function extractChannelContext(
      prompt: string,
    ): ActiveOrchestration["channelContext"] {
      // Trigger prompts typically contain channelId and conversationId
      const channelMatch = prompt.match(/channelId[:\s]*["']?([^"'\s,]+)/i);
      const convMatch = prompt.match(/conversationId[:\s]*["']?([^"'\s,]+)/i);
      const senderMatch = prompt.match(
        /(?:from|sender)[:\s]*["']?([^"'\s,]+)/i,
      );
      return {
        channelId: channelMatch?.[1] || "",
        conversationId: convMatch?.[1],
        sender: senderMatch?.[1],
        originalMessage: prompt,
      };
    }

    /** Run orchestration execution in background — employees work while boss is free */
    async function runOrchestrationInBackground(
      orchestration: ActiveOrchestration,
      bossAgent: Agent,
      assignments: {
        agentId: string;
        agentName: string;
        task: string;
        subtasks: string[];
        group?: number;
      }[],
      allEmployees: Agent[],
      bossTodos: AgentTodo[],
      progress: string,
      plan: string,
    ) {
      const taskResults: {
        agentName: string;
        success: boolean;
        reply: string;
      }[] = new Array(assignments.length);

      // Group assignments by their parallel group number
      const groupMap = new Map<
        number,
        { assignment: (typeof assignments)[0]; idx: number }[]
      >();
      for (let idx = 0; idx < assignments.length; idx++) {
        const g = assignments[idx].group ?? 1;
        if (!groupMap.has(g)) groupMap.set(g, []);
        groupMap.get(g)!.push({ assignment: assignments[idx], idx });
      }
      const sortedGroups = [...groupMap.keys()].sort((a, b) => a - b);

      // Track results from previous group for context passing
      let prevGroupResults: { agentName: string; reply: string }[] = [];

      for (const groupNum of sortedGroups) {
        const groupTasks = groupMap.get(groupNum)!;
        const isParallel = groupTasks.length > 1;

        if (isParallel) {
          if (debugMode)
            addDebug(
              `[boss] ⚡ Group ${groupNum}: running ${groupTasks.length} tasks in PARALLEL`,
            );
        }

        // Execute a single agent's task (used both for parallel and sequential)
        async function executeAgentTask(
          assignment: (typeof assignments)[0],
          idx: number,
          prevContext?: string,
        ): Promise<void> {
          const emp = allEmployees.find((a) => a.id === assignment.agentId);
          if (!emp) {
            taskResults[idx] = {
              agentName: assignment.agentName,
              success: false,
              reply: "Agent not found",
            };
            return;
          }

          // Update orchestration tracking
          orchestration.assignments[idx].status = "running";

          // Mark boss todo in-progress
          bossTodos[idx] = { ...bossTodos[idx], status: "in-progress" };
          const bossNow = agentsRef.current.find((a) => a.id === bossAgent.id) || bossAgent;
          onUpdateAgent({
            ...bossNow,
            todos: [
              ...(bossNow.todos || []).filter(
                (t) => !bossTodos.some((bt) => bt.id === t.id),
              ),
              ...bossTodos,
            ],
          });

          // Build subtask todos so the agent's panel shows a checklist
          const subtaskTodos: AgentTodo[] = assignment.subtasks.map((st) => ({
            id: crypto.randomUUID(),
            text: st,
            status: "pending" as const,
            timestamp: Date.now(),
          }));
          let currentAgent: Agent = {
            ...emp,
            // Clear local history — Claude Code session already has it.
            // This avoids re-sending the full conversation on each task.
            history: emp.sessionId ? [] : emp.history,
            todos: [...(emp.todos ?? []), ...subtaskTodos],
          };
          onUpdateAgent({
            ...currentAgent,
            status: "working",
            currentThought: `Working: ${assignment.task.slice(0, 60)}...`,
            liveStreamText: "",
            liveToolCalls: [],
            liveThinking: "",
          });
          if (debugMode)
            addDebug(
              `[boss] ${emp.name} executing: ${assignment.task.slice(0, 100)} (${subtaskTodos.length} subtasks)`,
            );

          // Mark all subtasks in-progress (the agent handles them in one shot)
          currentAgent = {
            ...currentAgent,
            todos: currentAgent.todos.map((t) =>
              subtaskTodos.some((st) => st.id === t.id)
                ? { ...t, status: "in-progress" as const }
                : t,
            ),
          };
          onUpdateAgent(currentAgent);

          try {
            // Format as a numbered checklist so the agent works through them systematically
            const checklist = assignment.subtasks
              .map((st, si) => `${si + 1}. ${st}`)
              .join("\n");
            let taskPrompt = `${assignment.task}\n\n## Steps\n${checklist}`;
            if (prevContext) {
              taskPrompt += `\n\nContext from previous group's work:\n${prevContext}`;
            }

            // Add the task instruction to the agent's chat history immediately
            // so it's visible when clicking on the agent while they work
            const taskUserMsg: Message = {
              role: "user",
              content: `**Task from Boss:** ${assignment.task}\n\n${checklist}`,
              timestamp: Date.now(),
            };
            currentAgent = {
              ...currentAgent,
              history: [...currentAgent.history, taskUserMsg],
            };
            onUpdateAgent(currentAgent);

            const {
              agent: updatedAgent,
              reply,
              cost,
              inputTokens,
              outputTokens,
            } = await executeTask(
              currentAgent,
              taskPrompt,
              EMPTY_KEYS,
              (partial) =>
                onUpdateAgent({
                  ...currentAgent,
                  status: "working",
                  currentThought: tailThought(partial),
                  liveStreamText: partial,
                }),
              abortRef.current?.signal,
              skills,
              undefined,
              undefined,
              allEmployees
                .filter((a) => a.id !== currentAgent.id)
                .map((a) => ({ name: a.name, role: a.role })),
              // Stream tool calls into the agent's live state
              (call) => {
                const toolLabel =
                  call.name +
                  (call.args.file_path
                    ? ` ${call.args.file_path}`
                    : call.args.command
                      ? ` ${call.args.command}`
                      : "");
                onUpdateAgent({
                  ...currentAgent,
                  status: "working",
                  currentThought: toolLabel,
                  liveToolCalls: [
                    ...(currentAgent.liveToolCalls ?? []),
                    { name: call.name, args: toolLabel, timestamp: Date.now() },
                  ],
                });
                // Keep currentAgent in sync for subsequent calls
                currentAgent = {
                  ...currentAgent,
                  liveToolCalls: [
                    ...(currentAgent.liveToolCalls ?? []),
                    { name: call.name, args: toolLabel, timestamp: Date.now() },
                  ],
                };
              },
              // Stream Claude Code events into the agent's live state
              (event) => {
                if (event.type === "tool_use" && event.toolName) {
                  const label = `${event.toolName}${event.toolInput?.file_path ? ` ${event.toolInput.file_path}` : ""}`;
                  onUpdateAgent({
                    ...currentAgent,
                    status: "working",
                    currentThought: label,
                    liveToolCalls: [
                      ...(currentAgent.liveToolCalls ?? []),
                      {
                        name: event.toolName,
                        args: label,
                        timestamp: Date.now(),
                      },
                    ],
                  });
                  currentAgent = {
                    ...currentAgent,
                    liveToolCalls: [
                      ...(currentAgent.liveToolCalls ?? []),
                      {
                        name: event.toolName,
                        args: label,
                        timestamp: Date.now(),
                      },
                    ],
                  };
                } else if (event.type === "assistant" && event.text) {
                  const preview = event.text.slice(0, 100).replace(/\n/g, " ");
                  if (preview.trim()) {
                    onUpdateAgent({
                      ...currentAgent,
                      status: "thinking",
                      currentThought:
                        preview + (event.text.length > 100 ? "..." : ""),
                      liveThinking:
                        preview + (event.text.length > 100 ? "..." : ""),
                    });
                  }
                }
              },
              // Slow warning (5 min): soft banner, no abort
              (agentName) => {
                onUpdateAgent({
                  ...currentAgent,
                  status: "slow",
                  currentThought: `No progress for 5 minutes — may be running a long operation`,
                });
              },
              // Stuck detection (10 min): enables abort
              (agentName) => {
                onUpdateAgent({
                  ...currentAgent,
                  status: "stuck",
                  currentThought: `No progress for 10 minutes`,
                });
              },
              // Permission requests — surface to UI
              (request) => {
                handleIncomingPermission(request, currentAgent.name);
              },
            );

            // Track cost for boss-delegated tasks
            if (cost !== undefined && cost > 0) {
              addCumulativeCost(
                currentAgent.id,
                currentAgent.name,
                cost,
                inputTokens || 0,
                outputTokens || 0,
                currentAgent.id,
              );
            }

            const collabContext = await handleCollaborationRequests(
              currentAgent,
              reply,
              allEmployees,
            );
            const fullReply = reply + collabContext;

            const subtaskIds = new Set(subtaskTodos.map((st) => st.id));
            // Build final history: our display-friendly task message + the assistant reply
            const assistantReplyMsg: Message = {
              role: "assistant",
              content: fullReply,
              timestamp: Date.now(),
            };
            currentAgent = {
              ...updatedAgent,
              history: [taskUserMsg, assistantReplyMsg],
              todos: updatedAgent.todos.map((t) =>
                subtaskIds.has(t.id) ? { ...t, status: "done" as const } : t,
              ),
            };
            onUpdateAgent({
              ...currentAgent,
              status: "idle",
              currentThought: "",
              liveStreamText: undefined,
              liveToolCalls: undefined,
              liveThinking: undefined,
            });

            // Update orchestration tracking
            orchestration.assignments[idx].status = "done";
            orchestration.assignments[idx].result = fullReply.slice(0, 200);

            bossTodos[idx] = { ...bossTodos[idx], status: "done" };
            taskResults[idx] = {
              agentName: assignment.agentName,
              success: true,
              reply: fullReply,
            };
            if (debugMode) addDebug(`[boss] ${emp.name} completed task`);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : "Unknown error";
            const subtaskIds = new Set(subtaskTodos.map((st) => st.id));
            currentAgent = {
              ...currentAgent,
              todos: currentAgent.todos.map((t) =>
                subtaskIds.has(t.id)
                  ? { ...t, status: "error" as const, error: errMsg }
                  : t,
              ),
            };
            onUpdateAgent({
              ...currentAgent,
              status: "idle",
              currentThought: "",
              liveStreamText: undefined,
              liveToolCalls: undefined,
              liveThinking: undefined,
            });

            // Update orchestration tracking
            orchestration.assignments[idx].status = "error";

            bossTodos[idx] = { ...bossTodos[idx], status: "error" };
            taskResults[idx] = {
              agentName: assignment.agentName,
              success: false,
              reply: `Error: ${errMsg}`,
            };
            if (debugMode) addDebug(`[boss] ${emp.name} failed: ${errMsg}`);
          }
        }

        // Build context from previous group results
        const prevContext =
          prevGroupResults.length > 0
            ? prevGroupResults
                .map((r) => `${r.agentName}: ${r.reply.slice(0, 300)}`)
                .join("\n")
            : undefined;

        if (isParallel) {
          // Run all tasks in this group concurrently
          await Promise.allSettled(
            groupTasks.map(({ assignment, idx }) =>
              executeAgentTask(assignment, idx, prevContext),
            ),
          );
        } else {
          // Single task in group — run sequentially (with collaboration handoff if applicable)
          const { assignment, idx } = groupTasks[0];
          const emp = allEmployees.find((a) => a.id === assignment.agentId);

          // Show collaboration with previous group's agents
          if (prevGroupResults.length > 0 && emp) {
            const prevAgentName =
              prevGroupResults[prevGroupResults.length - 1].agentName;
            const prevEmp = allEmployees.find((a) => a.name === prevAgentName);
            if (prevEmp && prevEmp.id !== emp.id) {
              await showCollaboration(
                emp,
                prevEmp,
                `💬 Getting context from ${prevEmp.name}`,
                2000,
              );
            }
          }

          await executeAgentTask(assignment, idx, prevContext);
        }

        // Collect this group's results for the next group's context
        prevGroupResults = groupTasks
          .map(({ idx }) => taskResults[idx])
          .filter(
            (r): r is { agentName: string; success: boolean; reply: string } =>
              !!r && r.success,
          );
      }

      // ── Step 6: Orchestration complete — compile results ──
      activeOrchestrationRef.current = null;

      // Use agentsRef to get the CURRENT boss state — bossAgent from the
      // closure is stale and would overwrite history/todos added since then.
      const currentBoss = agentsRef.current.find((a) => a.id === bossAgent.id) || bossAgent;

      const finalBossTodos = [
        ...(currentBoss.todos || []).filter(
          (t) => !bossTodos.some((bt) => bt.id === t.id),
        ),
        ...bossTodos,
      ];

      const successCount = taskResults.filter((t) => t?.success).length;
      const failCount = taskResults.filter((t) => t && !t.success).length;

      const structuredResults = taskResults
        .filter(
          (tr): tr is { agentName: string; success: boolean; reply: string } =>
            !!tr,
        )
        .map((tr) => ({
          agent: tr.agentName,
          success: tr.success,
          reply: tr.reply,
        }));
      const statusLine =
        failCount === 0
          ? `All ${successCount} task${successCount !== 1 ? "s" : ""} completed successfully!`
          : `${successCount}/${successCount + failCount} tasks completed. ${failCount} failed.`;
      const finalText = `${progress}\n---\n\n**Results:**\n<!--TASK_RESULTS:${JSON.stringify(structuredResults)}:END_TASK_RESULTS-->\n\n---\n${failCount === 0 ? "✅" : "⚠️"} **${statusLine}**`;

      // Append the completion summary to boss's chat history
      const completionMsg: Message = {
        role: "assistant",
        content: finalText,
        timestamp: Date.now(),
      };
      onUpdateAgent({
        ...currentBoss,
        todos: finalBossTodos,
        history: [...currentBoss.history, completionMsg],
        status: "idle",
        currentThought: "",
      });

      // Notify parent so it can show a toast over the office
      onOrchestrationDone?.({
        success: successCount,
        failed: failCount,
        plan,
        agents: assignments.map((a) => a.agentName),
      });

      // If this was triggered by a channel message, send the results back
      if (orchestration.channelContext?.channelId) {
        try {
          const bossThen = agentsRef.current.find((a) => a.id === bossAgent.id) || bossAgent;
          onUpdateAgent({
            ...bossThen,
            status: "working",
            currentThought: "📤 Sending reply...",
          });
          const sendPrompt =
            `Here are the results from the tasks you delegated:\n\n${finalText}\n\n` +
            `Now send a concise summary of these results back to the person who messaged you. ` +
            `Use the send_message tool with the channelId and conversationId from the original message. ` +
            `Original message context: ${orchestration.channelContext.originalMessage.slice(0, 500)}\n` +
            `Keep the reply short and helpful.`;
          await handleRegularChat(bossThen, sendPrompt);
        } catch {
          console.warn(
            "[boss] Failed to send channel reply after orchestration",
          );
        } finally {
          const bossNow = agentsRef.current.find((a) => a.id === bossAgent.id) || bossAgent;
          onUpdateAgent({
            ...bossNow,
            status: "idle",
            currentThought: "",
          });
        }
      }
    }

    // ── Regular agent chat flow ──────────────────────────────────
    async function handleRegularChat(
      agentState: Agent,
      userText: string,
    ): Promise<string> {
      const otherAgents = agents.filter(
        (a) => a.id !== agentState.id && !a.isBoss,
      );
      const result = await sendMessage(
        agentState,
        userText,
        EMPTY_KEYS,
        (partial) => {
          setStreamingText(partial);
          onUpdateAgent({
            ...agentState,
            status: "speaking",
            currentThought: tailThought(partial, 80),
          });
        },
        abortRef.current!.signal,
        {
          skills,
          onToolCall: (call) => {
            // Handle todo updates directly
            if (call.name === "update_todos") {
              const raw = call.args.todos as AgentTodo[];
              if (Array.isArray(raw)) {
                const todos: AgentTodo[] = raw.map((t: AgentTodo) => ({
                  id: String(t.id),
                  text: t.text,
                  status: t.status,
                  timestamp: Date.now(),
                }));
                onUpdateAgent({
                  ...agentState,
                  todos,
                  status: "working",
                  currentThought: `📋 Planning ${todos.length} tasks`,
                });
              }
              return;
            }

            const toolLabel =
              call.name === "run_command"
                ? `$ ${call.args.command}`
                : call.name === "write_file"
                  ? `Writing ${call.args.path}`
                  : call.name === "read_file"
                    ? `Reading ${call.args.path}`
                    : call.name === "delete_file"
                      ? `Deleting ${call.args.path}`
                      : call.name === "execute_code"
                        ? "Running code"
                        : call.name === "list_files"
                          ? "Listing files"
                          : call.name;
            setToolCalls((prev) => [
              ...prev,
              { name: call.name, args: toolLabel, timestamp: Date.now() },
            ]);
            setThinkingPreview(toolLabel);
            onUpdateAgent({
              ...agentState,
              status: "working",
              currentThought: `🔧 ${toolLabel}`,
            });
            if (debugMode)
              addDebug(
                `[event] tool_call: ${call.name} ${JSON.stringify(call.args).slice(0, 200)}`,
              );
          },
          // Claude Code stream events for subagent employees
          onClaudeCodeEvent: agentState.subagentDef
            ? (event) => {
                if (event.type === "tool_use" && event.toolName) {
                  const label = `${event.toolName}${event.toolInput?.file_path ? ` ${event.toolInput.file_path}` : ""}`;
                  setToolCalls((prev) => [
                    ...prev,
                    {
                      name: event.toolName!,
                      args: label,
                      timestamp: Date.now(),
                    },
                  ]);
                  onUpdateAgent({
                    ...agentState,
                    status: "working",
                    currentThought: `🔧 ${label}`,
                  });
                } else if (event.type === "assistant" && event.text) {
                  // Stream thinking/text updates — show a preview in currentThought and activity feed
                  const preview = event.text.slice(0, 100).replace(/\n/g, " ");
                  if (preview.trim()) {
                    setThinkingPreview(
                      preview + (event.text.length > 100 ? "…" : ""),
                    );
                    onUpdateAgent({
                      ...agentState,
                      status: "thinking",
                      currentThought:
                        preview + (event.text.length > 100 ? "…" : ""),
                    });
                  }
                }
              }
            : undefined,
          onPermissionRequest: (request) => {
            handleIncomingPermission(request, agentState.name);
          },
          onStderr: debugMode
            ? (text) => addDebug(`[stderr] ${text.trim()}`)
            : undefined,
          colleagues: otherAgents.map((a) => ({ name: a.name, role: a.role })),
        },
      );

      const reply = result.text;

      // Track cost (delta from cumulative total_cost_usd)
      if (result.cost !== undefined && result.cost > 0) {
        addCumulativeCost(
          agentState.id,
          agentState.name,
          result.cost,
          result.inputTokens || 0,
          result.outputTokens || 0,
          agentState.id,
        );
      }

      // Warn if tools were denied — agent may have produced incomplete results
      if (result.permissionDenials && result.permissionDenials.length > 0) {
        const toolNames = [
          ...new Set(result.permissionDenials.map((d) => d.tool_name)),
        ];
        addDebug(
          `[permissions] ${result.permissionDenials.length} tool use(s) denied: ${toolNames.join(", ")}`,
        );
      }

      // Handle any [ASK:Name] collaboration requests in the reply
      const collabContext = await handleCollaborationRequests(
        agentState,
        reply,
        agents,
      );
      if (collabContext) {
        // Send a follow-up with the colleague responses so the agent can incorporate them
        const followUpResult = await sendMessage(
          {
            ...agentState,
            history: [
              ...agentState.history,
              { role: "user", content: userText, timestamp: Date.now() },
              { role: "assistant", content: reply, timestamp: Date.now() },
            ],
          },
          `Here are the responses from your colleagues:\n${collabContext}\n\nPlease incorporate their input and provide your updated response.`,
          EMPTY_KEYS,
          (partial) => {
            setStreamingText(partial);
            onUpdateAgent({
              ...agentState,
              status: "speaking",
              currentThought: tailThought(partial, 80),
            });
          },
          abortRef.current!.signal,
          {
            skills,
            useTools: true,
            colleagues: otherAgents.map((a) => ({
              name: a.name,
              role: a.role,
            })),
          },
        );
        if (followUpResult.cost !== undefined && followUpResult.cost > 0) {
          addCumulativeCost(
            agentState.id,
            agentState.name,
            followUpResult.cost,
            followUpResult.inputTokens || 0,
            followUpResult.outputTokens || 0,
            agentState.id,
          );
        }
        return followUpResult.text;
      }

      return reply;
    }
  }

  function handleSendBackground() {
    if (!input.trim() || isStreaming || !agent || agent.isBoss) return;
    const userText = input.trim();
    setInput("");

    const userMsg: Message = {
      role: "user",
      content: userText,
      timestamp: Date.now(),
    };

    // Create a new session if needed
    let sessionId = agent.currentSessionId;
    if (!sessionId) {
      const session = createSession(agent.id, userText);
      sessionId = session.id;
    }

    const updatedWithUser: Agent = {
      ...agent,
      history: [...agent.history, userMsg],
      status: "background" as AgentStatus,
      currentThought: `🔄 Background: ${userText.slice(0, 50)}...`,
      currentSessionId: sessionId,
    };
    onUpdateAgent(updatedWithUser);

    const taskId = crypto.randomUUID();
    const bgTask: BackgroundTask = {
      id: taskId,
      agentId: agent.id,
      agentName: agent.name,
      prompt: userText,
      status: "running",
      startedAt: Date.now(),
    };

    // Create the execution function — App will run it and handle completion
    const execute = async (): Promise<{ reply: string; agent: Agent }> => {
      const otherAgents = agents.filter(
        (a) => a.id !== updatedWithUser.id && !a.isBoss,
      );
      const result = await sendMessage(
        updatedWithUser,
        userText,
        EMPTY_KEYS,
        (partial) => {
          onUpdateAgent({
            ...updatedWithUser,
            status: "background" as AgentStatus,
            currentThought: `🔄 ${tailThought(partial, 60)}`,
          });
        },
        undefined, // no abort signal for background tasks
        {
          skills,
          onClaudeCodeEvent: updatedWithUser.subagentDef
            ? (event) => {
                if (event.type === "tool_use" && event.toolName) {
                  const label = `${event.toolName}${event.toolInput?.file_path ? ` ${event.toolInput.file_path}` : ""}`;
                  onUpdateAgent({
                    ...updatedWithUser,
                    status: "background" as AgentStatus,
                    currentThought: `🔄 ${label}`,
                  });
                }
              }
            : undefined,
          onPermissionRequest: (request) => {
            handleIncomingPermission(request, updatedWithUser.name);
          },
          colleagues: otherAgents.map((a) => ({ name: a.name, role: a.role })),
        },
      );

      const reply = result.text;
      const assistantMsg: Message = {
        role: "assistant",
        content: reply,
        timestamp: Date.now(),
      };
      const finalAgent: Agent = {
        ...updatedWithUser,
        history: [...updatedWithUser.history, assistantMsg],
        status: "idle",
        currentThought: tailThought(reply, 80),
      };
      return { reply, agent: finalAgent };
    };

    onStartBackgroundTask(bgTask, execute);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  // Agent is busy if it's in a non-idle working state (e.g. background task from boss)
  const agentBusy =
    !!agent &&
    !agent.isBoss &&
    agent.status !== "idle" &&
    agent.status !== "stuck" &&
    agent.status !== "waiting-input" &&
    agent.status !== "waiting-approval";

  function handleStop() {
    if (abortRef.current) {
      abortRef.current.abort();
    } else if (agent && agentBusy) {
      // Background agent with no abort controller — reset to idle
      onUpdateAgent({
        ...agent,
        status: "idle",
        currentThought: "",
        liveStreamText: "",
        liveToolCalls: [],
        liveThinking: "",
      });
    }
  }

  // Handle an incoming permission request: log to chat, auto-approve if enabled, or show modal
  function handleIncomingPermission(request: PermissionRequest, agentName?: string) {
    // Stream the tool request description into the chat log (lightweight, no agent state mutation)
    setPermissionLog((prev) => [
      ...prev,
      {
        tool: request.tool,
        description: request.description,
        agentName: request.agentName || agentName,
        timestamp: Date.now(),
        autoApproved: !!autoApprovePermissions,
      },
    ]);

    // Auto-approve if the setting is enabled
    if (autoApprovePermissions) {
      resolveClaudePermission(request.permId, true);
      return;
    }

    // Show modal
    setPendingPermission(request);
    onPermissionNotification?.(agentName || agent?.name || "Unknown", request);
  }

  async function handlePermissionResponse(allow: boolean) {
    if (!pendingPermission) return;
    const { permId } = pendingPermission;
    setPendingPermission(null);
    if (!permId) {
      console.error(
        "[ChatWindow] No permId on pending permission — cannot resolve",
      );
      return;
    }
    // Resolve the permission request via the SDK's canUseTool handler
    await resolveClaudePermission(permId, allow);
  }

  const model = MODELS.find((m) => m.id === agent.model);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-600 bg-slate-900">
        <div
          className="w-3 h-3 rounded-full shrink-0"
          style={{ backgroundColor: agent.color }}
        />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-pixel text-white truncate">
            {agent.name}{" "}
            <span className="text-slate-500 font-normal">· {agent.role}</span>
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={handleNewChat}
            className="text-[9px] px-1.5 py-0.5 rounded font-pixel bg-slate-800 text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
            title="Start new conversation"
          >
            +
          </button>
          <button
            onClick={() => {
              setShowHistory(!showHistory);
              if (!showHistory) refreshSessionList();
            }}
            className={`text-[9px] px-1.5 py-0.5 rounded font-pixel transition-colors ${
              showHistory
                ? "bg-indigo-700 text-indigo-100"
                : "bg-slate-800 text-slate-400 hover:text-white hover:bg-slate-700"
            }`}
            title="Session history"
          >
            ⏱
          </button>
        </div>
      </div>

      {/* Session history drawer */}
      {showHistory && (
        <div className="border-b border-slate-600 bg-slate-950/95 max-h-52 flex flex-col">
          <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-slate-800/60">
            <input
              type="text"
              value={sessionSearch}
              onChange={(e) => setSessionSearch(e.target.value)}
              placeholder="Search…"
              className="flex-1 bg-slate-800/60 border border-slate-700/50 rounded px-2 py-0.5 text-[10px] font-mono text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
            />
            <button
              onClick={handleNewChat}
              className="text-[9px] px-2 py-0.5 rounded font-pixel bg-indigo-700 hover:bg-indigo-600 text-white transition-colors shrink-0"
            >
              New chat
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {sessionList.length === 0 && (
              <p className="text-[10px] font-pixel text-slate-500 text-center py-3">
                {sessionSearch ? "No matches" : "No past conversations"}
              </p>
            )}
            {sessionList.map((meta) => (
              <button
                key={meta.id}
                className={`w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-slate-800/60 border-b border-slate-800/30 group transition-colors ${
                  agent?.currentSessionId === meta.id
                    ? "bg-indigo-950/30 border-l-2 border-l-indigo-500"
                    : "border-l-2 border-l-transparent"
                }`}
                onClick={() => handleResumeSession(meta)}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] font-mono text-slate-300 truncate">
                    {meta.title}
                  </p>
                  <p className="text-[9px] text-slate-500">
                    {new Date(meta.updatedAt).toLocaleDateString()} ·{" "}
                    {meta.messageCount} msg{meta.messageCount !== 1 ? "s" : ""}
                  </p>
                </div>
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteSession(meta);
                  }}
                  className="text-[9px] text-slate-700 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer shrink-0 px-1"
                  title="Delete"
                >
                  ✕
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Background task banner */}
      {(() => {
        const bgTask = backgroundTasks.find(
          (t) => t.agentId === agent.id && t.status === "running",
        );
        if (!bgTask) return null;
        // Uses the elapsed state which ticks every second when workStartedAt is set,
        // but for background tasks we compute from bgTask.startedAt directly
        const bgElapsed = Math.floor((Date.now() - bgTask.startedAt) / 1000);
        return (
          <div className="px-3 py-2 border-b border-slate-600 bg-indigo-900/30 border-indigo-700/40">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-400" />
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-[11px] font-pixel text-indigo-300">
                  Running in background
                </p>
                <p className="text-[10px] font-mono text-slate-400 truncate mt-0.5">
                  {bgTask.prompt.slice(0, 80)}
                </p>
              </div>
              <span className="text-[10px] font-mono text-slate-500 shrink-0">
                {formatElapsed(bgElapsed)}
              </span>
            </div>
          </div>
        );
      })()}

      {/* Status — enhanced for waiting/slow/stuck states */}
      {(agent.status === "slow" ||
        agent.status === "stuck" ||
        agent.status === "waiting-input" ||
        agent.status === "waiting-approval") && (
        <div
          className={`px-3 py-2 border-b border-slate-600 ${
            agent.status === "stuck"
              ? "bg-red-900/30 border-red-700/40"
              : agent.status === "slow"
                ? "bg-yellow-900/30 border-yellow-700/40"
                : agent.status === "waiting-approval"
                  ? "bg-amber-900/30 border-amber-700/40"
                  : "bg-orange-900/30 border-orange-700/40"
          }`}
        >
          <div className="flex items-center gap-2">
            <span
              className={`text-sm ${agent.status === "stuck" ? "animate-pulse" : ""}`}
            >
              {agent.status === "stuck"
                ? "⚠️"
                : agent.status === "slow"
                  ? "🐢"
                  : agent.status === "waiting-approval"
                    ? "🔒"
                    : "⏸️"}
            </span>
            <div className="flex-1 min-w-0">
              <p
                className={`text-[11px] font-pixel ${
                  agent.status === "stuck"
                    ? "text-red-300"
                    : agent.status === "slow"
                      ? "text-yellow-300"
                      : agent.status === "waiting-approval"
                        ? "text-amber-300"
                        : "text-orange-300"
                }`}
              >
                {agent.status === "stuck"
                  ? "Agent appears stuck — no progress for 5 minutes"
                  : agent.status === "slow"
                    ? "Agent may be running a long operation"
                    : agent.status === "waiting-approval"
                      ? "Waiting for permission approval"
                      : "Waiting for more instructions"}
              </p>
              {agent.currentThought && (
                <p className="text-[10px] font-mono text-slate-400 truncate mt-0.5">
                  {agent.currentThought}
                </p>
              )}
            </div>
            {agent.status === "stuck" && (
              <button
                onClick={() => {
                  // Abort the hung task so the agent goes idle
                  abortRef.current?.abort();
                  onUpdateAgent({
                    ...agent,
                    status: "idle",
                    currentThought: "",
                    liveStreamText: "",
                    liveToolCalls: [],
                    liveThinking: "",
                  });
                }}
                className="btn-pixel text-[9px] bg-red-700 hover:bg-red-600 text-white px-2 py-0.5 shrink-0"
              >
                Unstick
              </button>
            )}
            {agent.status === "waiting-input" && (
              <button
                onClick={() => {
                  const textarea = document.querySelector("textarea");
                  textarea?.focus();
                }}
                className="btn-pixel text-[9px] bg-orange-700 hover:bg-orange-600 text-white px-2 py-0.5 shrink-0"
              >
                Reply
              </button>
            )}
          </div>
        </div>
      )}
      {/* Status bar removed — status now shown inline in the chat stream */}

      {/* Messages */}
      <div className="flex-1 font-mono overflow-y-auto px-3 py-2 space-y-2">
        {agent.isBoss && (
          <div className="text-center pt-4">
            <p className="text-[11px] font-pixel text-slate-400">
              Boss will assign tasks to the right agents. Just tell Boss what
              you need.
            </p>
          </div>
        )}

        {agent.history.length === 0 && (
          <div className="text-center pt-4">
            <p className="text-[11px] font-pixel text-slate-400">
              Say hi to {agent.name}!
            </p>
          </div>
        )}

        {agent.history.map((msg, i) => {
          // Detect boss orchestration results for special rendering
          const isBossResult =
            msg.role === "assistant" &&
            agent.isBoss &&
            msg.content.includes("**Results:**");
          const allSucceeded =
            isBossResult &&
            msg.content.includes("All") &&
            msg.content.includes("completed successfully");

          if (isBossResult) {
            // Try to parse structured task results from the message
            const taskMatch = msg.content.match(
              /<!--TASK_RESULTS:([\s\S]*?):END_TASK_RESULTS-->/,
            );
            let parsedTasks:
              | { agent: string; success: boolean; reply: string }[]
              | null = null;
            try {
              if (taskMatch) parsedTasks = JSON.parse(taskMatch[1]);
            } catch {
              /* fall back to markdown */
            }

            // Extract the plan/header portion (everything before the results block)
            const headerText =
              msg.content.split(/\n---\n\n\*\*Results:\*\*/)[0] || "";
            // Extract the status line (after the last ---)
            const statusMatch = msg.content.match(/\n---\n([✅⚠️].+)$/);
            const statusText = statusMatch?.[1] || "";

            return (
              <div key={i} className="flex justify-start">
                <div
                  className={`max-w-[95%] w-full rounded-lg border overflow-hidden ${
                    allSucceeded
                      ? "border-emerald-600/40 bg-emerald-950/30"
                      : "border-amber-600/40 bg-amber-950/20"
                  }`}
                >
                  {/* Header */}
                  <div
                    className={`px-3 py-1.5 border-b ${
                      allSucceeded
                        ? "bg-emerald-900/30 border-emerald-700/30"
                        : "bg-amber-900/20 border-amber-700/30"
                    }`}
                  >
                    <span
                      className="text-[11px] font-pixel"
                      style={{ color: allSucceeded ? "#34d399" : "#fbbf24" }}
                    >
                      {allSucceeded ? "✅ Tasks Complete" : "⚠️ Tasks Finished"}
                    </span>
                  </div>

                  {/* Plan summary */}
                  {headerText.trim() && (
                    <div className="px-3 py-2 text-[11px] leading-relaxed text-slate-300 border-b border-slate-700/30">
                      <MarkdownMessage content={headerText.trim()} />
                    </div>
                  )}

                  {/* Task result cards */}
                  {parsedTasks ? (
                    <div className="divide-y divide-slate-700/30">
                      {parsedTasks.map((tr, ti) => (
                        <BossTaskCard
                          key={ti}
                          agentName={tr.agent}
                          success={tr.success}
                          reply={tr.reply}
                          agents={agents}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="px-3 py-2 text-[12px] leading-relaxed text-gray-100">
                      <MarkdownMessage content={msg.content} />
                    </div>
                  )}

                  {/* Status footer */}
                  {statusText && (
                    <div
                      className={`px-3 py-1.5 border-t text-[11px] font-pixel ${
                        allSucceeded
                          ? "bg-emerald-900/20 border-emerald-700/30 text-emerald-400"
                          : "bg-amber-900/10 border-amber-700/30 text-amber-400"
                      }`}
                    >
                      {statusText}
                    </div>
                  )}
                </div>
              </div>
            );
          }

          return (
            <div
              key={i}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              {msg.role === "user" ? (
                <div className="max-w-[85%] px-2.5 py-1.5 rounded text-[12px] font-mono leading-7 whitespace-pre-wrap break-words bg-indigo-600 text-white">
                  {msg.content}
                </div>
              ) : (
                <div className="max-w-[85%] px-2.5 py-1.5 rounded text-[12px] leading-relaxed bg-slate-700 text-gray-100">
                  <MarkdownMessage content={msg.content} />
                </div>
              )}
            </div>
          );
        })}
        {isStreaming && streamingAgentId === agent.id && (
          <div className="flex justify-start">
            <div className="max-w-[90%] w-full rounded-lg overflow-hidden bg-slate-700/80 border border-slate-600/40">
              {/* Live streaming header */}
              <div className="flex items-center justify-between px-2.5 py-1.5 bg-slate-800/60 border-b border-slate-600/30">
                <div className="flex items-center gap-2">
                  <span className="relative flex h-2 w-2 shrink-0">
                    <span
                      className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
                      style={{
                        backgroundColor:
                          STATUS_COLORS[agent.status] ?? "#f59e0b",
                      }}
                    ></span>
                    <span
                      className="relative inline-flex rounded-full h-2 w-2"
                      style={{
                        backgroundColor:
                          STATUS_COLORS[agent.status] ?? "#f59e0b",
                      }}
                    ></span>
                  </span>
                  <span className="text-[10px] font-pixel text-slate-300">
                    {toolCalls.length > 0 ? "Working" : "Thinking"}
                  </span>
                </div>
                <span className="text-[10px] font-mono text-slate-500">
                  {formatElapsed(elapsed)}
                </span>
              </div>

              {/* Thinking preview — shown before tools start or between tool calls */}
              {thinkingPreview && !streamingText && (
                <div className="px-2.5 py-1.5 text-[11px] font-mono text-slate-300 border-b border-slate-600/20 leading-relaxed">
                  {thinkingPreview}
                  <span className="inline-block w-1.5 h-3 bg-slate-400 ml-0.5 animate-pulse align-middle" />
                </div>
              )}

              {/* Tool call feed */}
              {toolCalls.length > 0 && (
                <div className="max-h-36 overflow-y-auto border-b border-slate-600/20">
                  {toolCalls.map((tc, i) => {
                    const isLatest = i === toolCalls.length - 1;
                    return (
                      <div
                        key={i}
                        className={`flex items-center gap-2 px-2.5 py-1 border-b border-slate-700/20 last:border-b-0 ${isLatest ? "bg-slate-600/20" : ""}`}
                      >
                        {isLatest ? (
                          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" />
                        ) : (
                          <span className="w-1.5 h-1.5 rounded-full bg-slate-500 shrink-0" />
                        )}
                        <span
                          className={`text-[10px] font-mono truncate ${isLatest ? "text-slate-300" : "text-slate-500"}`}
                        >
                          {tc.args}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Bouncing dots when nothing else to show */}
              {toolCalls.length === 0 && !streamingText && !thinkingPreview && (
                <div className="px-2.5 py-2 flex items-center gap-2">
                  <div className="flex gap-1 shrink-0">
                    <span
                      className="w-1 h-1 rounded-full bg-amber-400 animate-bounce"
                      style={{ animationDelay: "0ms" }}
                    />
                    <span
                      className="w-1 h-1 rounded-full bg-amber-400 animate-bounce"
                      style={{ animationDelay: "150ms" }}
                    />
                    <span
                      className="w-1 h-1 rounded-full bg-amber-400 animate-bounce"
                      style={{ animationDelay: "300ms" }}
                    />
                  </div>
                  <span className="text-[10px] font-mono text-slate-400">
                    Processing request…
                  </span>
                </div>
              )}

              {/* Streaming response text */}
              {streamingText && (
                <div
                  className={`px-2.5 py-1.5 text-[12px] leading-relaxed ${
                    streamingText.includes("completed successfully")
                      ? "bg-emerald-950/20 text-gray-100"
                      : "text-gray-100"
                  }`}
                >
                  <MarkdownMessage content={streamingText} />
                  {!streamingText.includes("completed successfully") &&
                    !streamingText.includes("tasks completed") && (
                      <span className="inline-block w-1.5 h-3 bg-gray-400 ml-0.5 animate-pulse align-middle" />
                    )}
                </div>
              )}
            </div>
          </div>
        )}
        {/* Live agent work view — shown when viewing an agent being orchestrated by Boss */}
        {!(isStreaming && streamingAgentId === agent.id) &&
          agent.status !== "idle" &&
          agent.status !== "stuck" &&
          agent.status !== "waiting-input" &&
          agent.status !== "waiting-approval" &&
          (agent.liveStreamText ||
            agent.liveToolCalls?.length ||
            agent.liveThinking ||
            agent.currentThought) && (
            <div className="flex justify-start">
              <div className="max-w-[90%] w-full rounded-lg overflow-hidden bg-slate-700/80 border border-slate-600/40">
                {/* Header */}
                <div className="flex items-center justify-between px-2.5 py-1.5 bg-slate-800/60 border-b border-slate-600/30">
                  <div className="flex items-center gap-2">
                    <span className="relative flex h-2 w-2 shrink-0">
                      <span
                        className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
                        style={{
                          backgroundColor:
                            STATUS_COLORS[agent.status] ?? "#f59e0b",
                        }}
                      ></span>
                      <span
                        className="relative inline-flex rounded-full h-2 w-2"
                        style={{
                          backgroundColor:
                            STATUS_COLORS[agent.status] ?? "#f59e0b",
                        }}
                      ></span>
                    </span>
                    <span className="text-[10px] font-pixel text-slate-300">
                      {(agent.liveToolCalls?.length ?? 0) > 0
                        ? "Working"
                        : "Thinking"}
                    </span>
                  </div>
                  <span
                    className="text-[10px] font-mono"
                    style={{ color: STATUS_COLORS[agent.status] ?? "#f59e0b" }}
                  >
                    {STATUS_LABELS[agent.status] || "Working…"}
                  </span>
                </div>

                {/* Thinking preview */}
                {agent.liveThinking && !agent.liveStreamText && (
                  <div className="px-2.5 py-1.5 text-[11px] font-mono text-slate-300 border-b border-slate-600/20 leading-relaxed">
                    {agent.liveThinking}
                    <span className="inline-block w-1.5 h-3 bg-slate-400 ml-0.5 animate-pulse align-middle" />
                  </div>
                )}

                {/* Tool call feed */}
                {(agent.liveToolCalls?.length ?? 0) > 0 && (
                  <div className="max-h-36 overflow-y-auto border-b border-slate-600/20">
                    {agent.liveToolCalls!.map((tc, i) => {
                      const isLatest = i === agent.liveToolCalls!.length - 1;
                      return (
                        <div
                          key={i}
                          className={`flex items-center gap-2 px-2.5 py-1 border-b border-slate-700/20 last:border-b-0 ${isLatest ? "bg-slate-600/20" : ""}`}
                        >
                          {isLatest ? (
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" />
                          ) : (
                            <span className="w-1.5 h-1.5 rounded-full bg-slate-500 shrink-0" />
                          )}
                          <span
                            className={`text-[10px] font-mono truncate ${isLatest ? "text-slate-300" : "text-slate-500"}`}
                          >
                            {tc.args}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* No data yet — show current thought as fallback */}
                {!agent.liveToolCalls?.length &&
                  !agent.liveStreamText &&
                  !agent.liveThinking &&
                  agent.currentThought && (
                    <div className="px-2.5 py-2 flex items-center gap-2">
                      <div className="flex gap-1 shrink-0">
                        <span
                          className="w-1 h-1 rounded-full bg-amber-400 animate-bounce"
                          style={{ animationDelay: "0ms" }}
                        />
                        <span
                          className="w-1 h-1 rounded-full bg-amber-400 animate-bounce"
                          style={{ animationDelay: "150ms" }}
                        />
                        <span
                          className="w-1 h-1 rounded-full bg-amber-400 animate-bounce"
                          style={{ animationDelay: "300ms" }}
                        />
                      </div>
                      <span className="text-[10px] font-mono text-slate-400 truncate">
                        {agent.currentThought}
                      </span>
                    </div>
                  )}

                {/* Streaming response text */}
                {agent.liveStreamText && (
                  <div className="px-2.5 py-1.5 text-[12px] leading-relaxed text-gray-100">
                    <MarkdownMessage content={agent.liveStreamText} />
                    <span className="inline-block w-1.5 h-3 bg-gray-400 ml-0.5 animate-pulse align-middle" />
                  </div>
                )}
              </div>
            </div>
          )}
        {/* Permission log entries streamed into chat */}
        {permissionLog.map((entry, i) => (
          <div
            key={`perm-${i}`}
            className="mx-auto max-w-[90%] bg-amber-900/20 border border-amber-700/30 rounded px-3 py-1.5 animate-slide-up"
          >
            <div className="flex items-center gap-2">
              <span className="text-[10px]">
                {entry.autoApproved ? "⚡" : "🔒"}
              </span>
              <span className="text-[10px] font-mono text-amber-300 font-bold">
                {entry.tool}
              </span>
              {entry.agentName && (
                <span className="text-[9px] text-amber-400/50">
                  {entry.agentName}
                </span>
              )}
              {entry.autoApproved && (
                <span className="text-[9px] text-emerald-400/70 ml-auto">
                  auto-approved
                </span>
              )}
            </div>
            <p className="text-[9px] text-amber-200/50 mt-0.5 truncate">
              {entry.description}
            </p>
          </div>
        ))}

        {/* Permission modal rendered at top level via portal-like z-50 */}
        {pendingPermission && (
          <PermissionModal
            request={pendingPermission}
            onRespond={handlePermissionResponse}
          />
        )}
        <div ref={bottomRef} />
      </div>

      {/* Debug log panel */}
      {debugMode && showDebug && debugLog.length > 0 && (
        <div className="border-t border-amber-800/50 bg-slate-950 max-h-40 overflow-y-auto">
          <div className="flex items-center justify-between px-2 py-1 bg-amber-900/30 border-b border-amber-800/40 sticky top-0">
            <span className="text-[9px] font-pixel text-amber-400">
              🐛 Debug Log ({debugLog.length})
            </span>
            <div className="flex gap-1">
              <button
                onClick={() => setDebugLog([])}
                className="text-[9px] text-slate-500 hover:text-amber-300 px-1"
              >
                Clear
              </button>
              <button
                onClick={() => setShowDebug(false)}
                className="text-[9px] text-slate-500 hover:text-amber-300 px-1"
              >
                Hide
              </button>
            </div>
          </div>
          <div className="px-2 py-1 space-y-0">
            {debugLog.map((line, i) => (
              <pre
                key={i}
                className={`text-[9px] font-mono leading-tight whitespace-pre-wrap break-all ${
                  line.includes("[stderr]")
                    ? "text-red-400/80"
                    : line.includes("[raw]")
                      ? "text-cyan-400/60"
                      : line.includes("[team]")
                        ? "text-amber-400/70"
                        : line.includes("[event]")
                          ? "text-purple-400/70"
                          : "text-slate-500"
                }`}
              >
                {line}
              </pre>
            ))}
            <div ref={debugBottomRef} />
          </div>
        </div>
      )}

      {/* Input */}
      <div className="px-3 py-2 border-t border-slate-600 bg-slate-900">
        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`Message ${agent.name}...`}
            disabled={isStreaming || agentBusy}
            rows={2}
            className="input-mono flex-1 bg-slate-800 border border-gray-600 rounded-md px-3 py-2 text-sm font-sans text-white placeholder-slate-400 resize-none focus:outline-none focus:border-indigo-500 disabled:opacity-50"
          />
          {isStreaming || agentBusy ? (
            <button
              onClick={handleStop}
              className="px-2 py-1 bg-red-600 hover:bg-red-500 text-white text-[11px] font-pixel rounded transition-colors cursor-pointer"
            >
              stop
            </button>
          ) : (
            <div className="flex flex-col gap-1">
              <button
                id="chat-send-btn"
                onClick={handleSend}
                disabled={!input.trim()}
                className="px-2 py-1 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-[11px] font-pixel rounded transition-colors cursor-pointer"
              >
                send
              </button>
              {!agent.isBoss && (
                <button
                  onClick={handleSendBackground}
                  disabled={
                    !input.trim() ||
                    backgroundTasks.some(
                      (t) => t.agentId === agent.id && t.status === "running",
                    )
                  }
                  className="px-2 py-0.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-30 text-slate-300 text-[9px] font-pixel rounded transition-colors cursor-pointer"
                  title="Run in background — continue working while this agent processes"
                >
                  bg
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
