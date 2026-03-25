import { useState, useEffect, useRef } from "react";
import { Agent, BackgroundTask } from "../lib/types";

interface AgentListProps {
  agents: Agent[];
  selectedAgentId: string | null;
  onSelect: (agent: Agent) => void;
  onAdd: () => void;
  backgroundTasks?: BackgroundTask[];
  onSaveAgent?: (agentId: string) => void;
}

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
  thinking: "Thinking...",
  working: "Working...",
  speaking: "Responding...",
  collaborating: "Collaborating...",
  "waiting-input": "Needs input",
  "waiting-approval": "Needs approval",
  slow: "Slow",
  stuck: "Stuck",
  background: "Background",
};

/** Strip emoji and other non-renderable unicode from text */
function stripEmoji(text: string): string {
  return text
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, "")
    .replace(/[\u{2600}-\u{27BF}]/gu, "")
    .replace(/[\u{FE00}-\u{FE0F}]/gu, "")
    .replace(/[\u{200D}]/gu, "")
    .replace(/[\u{20E3}]/gu, "")
    .replace(/[\u{E0020}-\u{E007F}]/gu, "")
    .replace(/^\s+/, "")
    .trim();
}

export default function AgentList({
  agents,
  selectedAgentId,
  onSelect,
  onAdd,
  backgroundTasks = [],
  onSaveAgent,
}: AgentListProps) {
  const [now, setNow] = useState(Date.now());
  const statusStartRef = useRef<Record<string, number>>({});
  const hasActiveRef = useRef(false);

  // Track when agents enter non-idle states
  useEffect(() => {
    for (const agent of agents) {
      if (agent.status !== "idle" && !statusStartRef.current[agent.id]) {
        statusStartRef.current[agent.id] = Date.now();
      } else if (agent.status === "idle") {
        delete statusStartRef.current[agent.id];
      }
    }
    hasActiveRef.current = agents.some((a) => a.status !== "idle");
  }, [agents]);

  // Stable 1s ticker — always runs, only updates state when agents are active
  useEffect(() => {
    const interval = setInterval(() => {
      if (hasActiveRef.current) {
        setNow(Date.now());
      }
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex flex-col h-[45vh]">
      <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-slate-600">
        <span className="text-[11px] font-pixel text-slate-300 uppercase tracking-wider">
          Employees
        </span>
        <button
          onClick={onAdd}
          className="btn-pixel bg-indigo-700 hover:bg-indigo-600 text-[11px] "
        >
          + Hire
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {agents
          .sort((a, b) => (a.isBoss === b.isBoss ? 0 : a.isBoss ? -1 : 1))
          .map((agent) => {
            return (
              <div
                key={agent.id}
                className={`transition-colors hover:bg-slate-800 ${
                  selectedAgentId === agent.id
                    ? "bg-slate-800"
                    : "bg-transparent"
                }`}
              >
                <button
                  key={agent.id}
                  onClick={() => onSelect(agent)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors border-l-2 hover:bg-slate-800 ${
                    selectedAgentId === agent.id
                      ? "bg-slate-800"
                      : "bg-transparent"
                  }`}
                  style={{
                    borderLeftColor:
                      selectedAgentId === agent.id
                        ? agent.color
                        : "transparent",
                  }}
                >
                  {/* Avatar */}
                  <div
                    className="w-7 h-7 rounded flex items-center justify-center text-xs font-bold shrink-0"
                    style={{
                      backgroundColor: agent.color + "33",
                      color: agent.color,
                      border: `1px solid ${agent.color}55`,
                    }}
                  >
                    {agent.name.charAt(0)}
                  </div>

                  <div className="flex-1 min-w-0">
                    <p className="text-[12px] font-pixel text-white truncate">
                      {agent.name}
                      {agent.autoCreated && (
                        <span
                          className="text-[8px] text-emerald-400 ml-1 border border-emerald-500/40 rounded px-0.5"
                          title="Temp hired by Boss"
                        >
                          TEMP
                        </span>
                      )}
                      {!agent.autoCreated && agent.agentScope === "project" && (
                        <span
                          className="text-[8px] text-cyan-400 ml-1"
                          title="Project agent"
                        >
                          PRJ
                        </span>
                      )}
                      {!agent.autoCreated &&
                        agent.agentScope === "user" &&
                        agent.subagentFile && (
                          <span
                            className="text-[8px] text-amber-400 ml-1"
                            title="User agent"
                          >
                            USR
                          </span>
                        )}
                    </p>
                    {agent.status !== "idle" && agent.currentThought ? (
                      <p
                        className="text-[10px] font-mono truncate"
                        style={{ color: STATUS_COLORS[agent.status] + "cc" }}
                        title={agent.currentThought}
                      >
                        {stripEmoji(agent.currentThought)}
                      </p>
                    ) : (
                      <p
                        className="text-[12px] font-pixel truncate"
                        style={{ color: agent.color + "cc" }}
                      >
                        {agent.role}
                      </p>
                    )}
                  </div>

                  {/* Status dot + elapsed */}
                  <div className="flex items-center gap-1.5 shrink-0 overflow-visible">
                    {agent.status === "background" && (
                      <span className="text-[8px] font-pixel leading-none px-1 py-0.5 rounded bg-indigo-900/60 text-indigo-300 animate-pulse">
                        BG
                      </span>
                    )}
                    {(agent.status === "waiting-input" ||
                      agent.status === "waiting-approval" ||
                      agent.status === "slow" ||
                      agent.status === "stuck") && (
                      <span
                        className={`text-[8px] font-pixel leading-none px-1 py-0.5 rounded ${agent.status === "stuck" ? "bg-red-900/60 text-red-300 animate-pulse" : agent.status === "slow" ? "bg-yellow-900/60 text-yellow-300" : "bg-amber-900/60 text-amber-300 animate-pulse"}`}
                      >
                        {STATUS_LABELS[agent.status]}
                      </span>
                    )}
                    {(agent.status === "thinking" ||
                      agent.status === "working" ||
                      agent.status === "speaking" ||
                      agent.status === "collaborating" ||
                      agent.status === "background") &&
                      statusStartRef.current[agent.id] && (
                        <span
                          className="text-[9px] font-mono tabular-nums"
                          style={{ color: STATUS_COLORS[agent.status] + "99" }}
                        >
                          {(() => {
                            const secs = Math.floor(
                              (now - statusStartRef.current[agent.id]) / 1000,
                            );
                            if (secs < 60) return `${secs}s`;
                            const m = Math.floor(secs / 60);
                            const s = secs % 60;
                            return `${m}m${s.toString().padStart(2, "0")}s`;
                          })()}
                        </span>
                      )}
                    <div
                      className={`w-2 h-2 rounded-full shrink-0 ${agent.status !== "idle" ? "animate-pulse" : ""}`}
                      style={{
                        backgroundColor:
                          STATUS_COLORS[agent.status] ?? "#6b7280",
                      }}
                      title={STATUS_LABELS[agent.status] ?? agent.status}
                    />
                  </div>
                </button>
                {agent.autoCreated && onSaveAgent && (
                  <div className="w-full flex items-center gap-2.5 px-3 pb-2 font-pixel">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onSaveAgent(agent.id);
                      }}
                      className="text-[8px] text-amber-400 ml-0.5 border border-amber-500/40 rounded px-0.5 hover:bg-amber-500/20 transition-colors"
                      title="Keep this agent permanently"
                    >
                      HIRE FULL TIME
                    </button>
                  </div>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}
