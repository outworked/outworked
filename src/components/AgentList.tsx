import { useState, useEffect, useRef } from 'react';
import { Agent } from '../lib/types';

interface AgentListProps {
  agents: Agent[];
  selectedAgentId: string | null;
  onSelect: (agent: Agent) => void;
  onAdd: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  idle: '#6b7280',
  thinking: '#f59e0b',
  working: '#22c55e',
  speaking: '#3b82f6',
  'waiting-input': '#f97316',
  'waiting-approval': '#eab308',
  stuck: '#ef4444',
  collaborating: '#8b5cf6',
};

const STATUS_LABELS: Record<string, string> = {
  idle: 'Idle',
  thinking: 'Thinking…',
  working: 'Working…',
  speaking: 'Responding…',
  collaborating: 'Collaborating…',
  'waiting-input': '⏸ Needs input',
  'waiting-approval': '🔒 Needs approval',
  stuck: '⚠ Stuck',
};

export default function AgentList({ agents, selectedAgentId, onSelect, onAdd }: AgentListProps) {
  const [now, setNow] = useState(Date.now());
  const statusStartRef = useRef<Record<string, number>>({});

  // Track when agents enter non-idle states
  useEffect(() => {
    for (const agent of agents) {
      if (agent.status !== 'idle' && !statusStartRef.current[agent.id]) {
        statusStartRef.current[agent.id] = Date.now();
      } else if (agent.status === 'idle') {
        delete statusStartRef.current[agent.id];
      }
    }
  }, [agents]);

  // Tick every second while any agent is non-idle
  useEffect(() => {
    const hasActive = agents.some(a => a.status !== 'idle');
    if (!hasActive) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [agents]);

  return (
    <div className="flex flex-col h-[45vh]">
      <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-slate-600">
        <span className="text-[11px] font-pixel text-slate-300 uppercase tracking-wider">Employees</span>
        <button
          onClick={onAdd}
          className="btn-pixel bg-indigo-700 hover:bg-indigo-600 text-[11px] "
        >
          + Hire
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {agents.map((agent) => (
          <button
            key={agent.id}
            onClick={() => onSelect(agent)}
            className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors border-l-2 hover:bg-slate-800 ${
              selectedAgentId === agent.id ? 'bg-slate-800' : 'bg-transparent'
            }`}
            style={{ borderLeftColor: selectedAgentId === agent.id ? agent.color : 'transparent' }}
          >
            {/* Avatar */}
            <div
              className="w-7 h-7 rounded flex items-center justify-center text-xs font-bold shrink-0"
              style={{ backgroundColor: agent.color + '33', color: agent.color, border: `1px solid ${agent.color}55` }}
            >
              {agent.name.charAt(0)}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[12px] font-pixel text-white truncate">
                {agent.name}
                {agent.subagentFile && <span className="text-[9px] text-purple-400 ml-1">⚡</span>}
                {agent.agentScope === 'project' && <span className="text-[8px] text-cyan-400 ml-1" title="Project agent">PRJ</span>}
                {agent.agentScope === 'user' && agent.subagentFile && <span className="text-[8px] text-amber-400 ml-1" title="User agent">USR</span>}
              </p>
              <p className="text-[12px] font-pixel truncate" style={{ color: agent.color + 'cc' }}>{agent.role}</p>
            </div>
            {/* Status dot + label for attention states */}
            <div className="flex items-center gap-1 shrink-0">
              {(agent.status === 'waiting-input' || agent.status === 'waiting-approval' || agent.status === 'stuck') && (
                <span
                  className={`text-[8px] font-pixel leading-none px-1 py-0.5 rounded ${agent.status === 'stuck' ? 'bg-red-900/60 text-red-300 animate-pulse' : 'bg-amber-900/60 text-amber-300 animate-pulse'}`}
                >
                  {STATUS_LABELS[agent.status]}
                </span>
              )}
              {(agent.status === 'thinking' || agent.status === 'working' || agent.status === 'speaking' || agent.status === 'collaborating') && statusStartRef.current[agent.id] && (
                <span className="text-[9px] font-mono text-slate-500">
                  {(() => {
                    const secs = Math.floor((now - statusStartRef.current[agent.id]) / 1000);
                    if (secs < 60) return `${secs}s`;
                    const m = Math.floor(secs / 60);
                    const s = secs % 60;
                    return `${m}m ${s}s`;
                  })()}
                </span>
              )}
              <div
                className={`w-2 h-2 rounded-full ${agent.status === 'waiting-input' || agent.status === 'waiting-approval' || agent.status === 'stuck' ? 'animate-pulse' : agent.status !== 'idle' ? 'animate-pulse' : ''}`}
                style={{ backgroundColor: STATUS_COLORS[agent.status] ?? '#6b7280' }}
                title={STATUS_LABELS[agent.status] ?? agent.status}
              />
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
