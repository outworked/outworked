import { useEffect, useState, useCallback, lazy, Suspense } from 'react';
import { Agent, AgentSkill, SubagentDef } from './lib/types';
import { loadAgents, saveAgents, loadSkills, saveSkills, createAgent, createClaudeAgentFile, generateAgentWithAI, resetProject, syncClaudeSubagents, upgradeAgentsToClaudeCode, parseSubagentFrontmatter } from './lib/storage';
import { migrateHistoryToSession, loadSession } from './lib/sessions';
import { getClaudeCodeAuthStatus, isElectron, onClaudeAgentsChanged, watchProjectAgents, readClaudeSettings, deleteClaudeAgentFile } from './lib/terminal';
import { getWorkspace, setWorkspace } from './lib/filesystem';
import AgentList from './components/AgentList';
import AgentEditor from './components/AgentEditor';
import ChatWindow, { OrchestrationDoneEvent } from './components/ChatWindow';
import TerminalPanel from './components/TerminalPanel';
import  { InstructionRun } from './components/OfficeInstructions';
import AgentTasks from './components/AgentTasks';
import SkillsPanel from './components/SkillsPanel';
import MusicPlayer from './components/MusicPlayer';
import ClaudeCodeStatus from './components/ClaudeCodeStatus';
import WorkspacePicker from './components/WorkspacePicker';
import PermissionsPanel, { PermissionsBanner } from './components/PermissionsPanel';
import WorkspacePanel from './components/WorkspacePanel';
import GitPanel from './components/GitPanel';

const OfficeCanvas = lazy(() => import('./components/OfficeCanvas'));

type RightPanel = 'chat' | 'editor' | 'terminal' | 'workspace' | 'git' | 'instructions' | 'tasks';

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [rightPanel, setRightPanel] = useState<RightPanel>('chat');
  const [skills, setSkills] = useState<AgentSkill[]>([]);
  const [instructionRuns, setInstructionRuns] = useState<InstructionRun[]>([]);
  const [agentTeamsEnabled, setAgentTeamsEnabled] = useState(() => localStorage.getItem('outworked_agent_teams') === '1');
  const [claudeReady, setClaudeReady] = useState(false);
  const [workspaceDir, setWorkspaceDir] = useState<string | null>(null);
  const [showWorkspacePicker, setShowWorkspacePicker] = useState(false);
  const [startupDone, setStartupDone] = useState(false);
  const [hirePrompt, setHirePrompt] = useState<{ resolve: (value: string | null) => void } | null>(null);
  const [showPermsModal, setShowPermsModal] = useState(false);
  const [permsEmpty, setPermsEmpty] = useState(false);
  const [permsDismissed, setPermsDismissed] = useState(false);
  const [debugMode, setDebugMode] = useState(() => localStorage.getItem('outworked_debug') === '1');
  const [orchToast, setOrchToast] = useState<OrchestrationDoneEvent | null>(null);

  useEffect(() => {
    async function init() {
      const initialAgents = loadAgents();
      setSkills(loadSkills());

      // Load saved workspace dir
      const savedWs = localStorage.getItem('outworked_workspace_dir');

      // Check Claude Code availability
      let ccReady = false;
      if (isElectron()) {
        try {
          const authStatus = await getClaudeCodeAuthStatus();
          ccReady = !!(authStatus.installed && authStatus.authenticated);
        } catch { /* not available */ }
      }
      setClaudeReady(ccReady);

      // If Claude Code is ready, upgrade all default agents to use it
      let currentAgents = initialAgents;
      if (ccReady) {
        currentAgents = upgradeAgentsToClaudeCode(currentAgents);
      }
      setAgents(currentAgents);

      // Sync Claude Code subagents (pass workspace for project scope)
      const wsDir = savedWs || (isElectron() ? await getWorkspace() : undefined);
      syncClaudeSubagents(currentAgents, wsDir || undefined).then((synced) => {
        if (synced !== currentAgents) {
          setAgents(synced);
        }
      });

      // Load workspace dir — show picker if none saved
      if (isElectron()) {
        if (savedWs) {
          setWorkspaceDir(savedWs);
          await setWorkspace(savedWs);
          watchProjectAgents(savedWs);
        } else {
          const defaultDir = await getWorkspace();
          setWorkspaceDir(defaultDir);
          watchProjectAgents(defaultDir);
          setShowWorkspacePicker(true);
        }
      }

      // Migrate any existing in-memory history to sessions (one-time)
      const migrated = localStorage.getItem('outworked_sessions_migrated');
      if (!migrated) {
        const rawAgents = (() => { try { const r = localStorage.getItem('outworked_agents'); return r ? JSON.parse(r) : []; } catch { return []; } })();
        for (const raw of rawAgents) {
          if (raw.history && raw.history.length > 0 && !raw.currentSessionId) {
            const session = await migrateHistoryToSession(raw.id, raw.history, raw.sessionId);
            if (session) {
              setAgents(prev => prev.map(a => a.id === raw.id ? { ...a, currentSessionId: session.id, history: session.messages } : a));
            }
          }
        }
        localStorage.setItem('outworked_sessions_migrated', '1');
      }

      setStartupDone(true);

      // Check whether any permission rules exist
      const wsDir2 = savedWs || (isElectron() ? await getWorkspace() : undefined);
      if (wsDir2) {
        const { settings } = await readClaudeSettings('project');
        const perms = settings.permissions || { allow: [], deny: [] };
        const empty = (!perms.allow || perms.allow.length === 0) && (!perms.deny || perms.deny.length === 0);
        setPermsEmpty(empty);
      }
    }
    init();
  }, []);

  // Auto-sync when Claude Code agent files change on disk
  useEffect(() => {
    const unsub = onClaudeAgentsChanged(() => {
      const wsDir = localStorage.getItem('outworked_workspace_dir') || undefined;
      setAgents((prev) => {
        syncClaudeSubagents(prev, wsDir).then((synced) => {
          if (synced !== prev) setAgents(synced);
        });
        return prev;
      });
    });
    return unsub;
  }, []);

  const selectedAgent = agents.find((a) => a.id === selectedAgentId) ?? null;

  // Hydrate session from disk when selecting an agent with a saved session but empty history
  useEffect(() => {
    if (!selectedAgent?.currentSessionId || selectedAgent.history.length > 0) return;
    loadSession(selectedAgent.id, selectedAgent.currentSessionId).then(session => {
      if (session) {
        setAgents(prev => prev.map(a =>
          a.id === selectedAgent.id
            ? { ...a, history: session.messages, sessionId: session.claudeSessionId }
            : a
        ));
      }
    });
  }, [selectedAgentId]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateAgent = useCallback((updated: Agent) => {
    setAgents((prev) => {
      const next = prev.map((a) => (a.id === updated.id ? updated : a));
      saveAgents(next);
      return next;
    });
  }, []);

  const handleAgentClick = useCallback((agent: Agent) => {
    setSelectedAgentId(agent.id);
    setRightPanel('chat');
  }, []);

  function handleAddAgent() {
    if (claudeReady) {
      // Show the hire prompt modal — the rest happens in the callback
      new Promise<string | null>((resolve) => {
        setHirePrompt({ resolve });
      }).then((description) => {
        setHirePrompt(null);
        finishHire(description);
      });
    } else {
      finishHire(null);
    }
  }

  function finishHire(description: string | null) {
    const agent = createAgent({
      position: { x: Math.floor(Math.random() * 10) + 2, y: Math.floor(Math.random() * 6) + 2 },
    }, claudeReady);
    const next = [...agents, agent];
    setAgents(next);
    saveAgents(next);
    setSelectedAgentId(agent.id);
    setRightPanel('editor');

    if (claudeReady && description) {
      // AI-generate a full agent .md from the description
      updateAgent({ ...agent, status: 'thinking', currentThought: 'Being onboarded by AI...' });
      generateAgentWithAI(description, {
        workspaceDir: workspaceDir || undefined,
      }).then((result) => {
        if (result) {
          const parsed = parseSubagentFrontmatter(result.content);
          const name = parsed.def['outworked-name'] || parsed.def.name || agent.name;
          const role = parsed.def['outworked-role'] || parsed.def.description || agent.role;
          updateAgent({
            ...agent,
            name,
            role,
            personality: parsed.body || agent.personality,
            subagentFile: result.filePath,
            subagentDef: { description: role, ...parsed.def } as SubagentDef,
            status: 'idle',
            currentThought: '',
          });
        } else {
          // Fallback: create a bare stub
          createClaudeAgentFile(agent, workspaceDir || undefined).then((filePath) => {
            if (filePath) {
              updateAgent({ ...agent, subagentFile: filePath, subagentDef: { description: agent.role }, status: 'idle', currentThought: '' });
            }
          });
        }
      });
    } else if (claudeReady) {
      // User cancelled the prompt — create a bare stub
      createClaudeAgentFile(agent, workspaceDir || undefined).then((filePath) => {
        if (filePath) {
          updateAgent({ ...agent, subagentFile: filePath, subagentDef: { description: agent.role } });
        }
      });
    }
  }

  function handleSaveAgent(updated: Agent) {
    updateAgent(updated);
    setRightPanel('chat');
  }

  function handleDeleteAgent(agentId: string) {
    const agent = agents.find((a) => a.id === agentId);
    if (agent?.isBoss) return; // boss cannot be deleted
    // Delete the .claude/agents/*.md file on disk so it doesn't get re-synced
    if (agent?.subagentFile) {
      deleteClaudeAgentFile(agent.subagentFile);
    }
    const next = agents.filter((a) => a.id !== agentId);
    setAgents(next);
    saveAgents(next);
    setSelectedAgentId(null);
  }

  const handleAddDynamicAgent = useCallback((agent: Agent) => {
    setAgents((prev) => {
      const next = [...prev, agent];
      saveAgents(next);
      return next;
    });
  }, []);

  const handleUpdateSkills = useCallback((updated: AgentSkill[]) => {
    setSkills(updated);
    saveSkills(updated);
  }, []);

  const toggleDebug = useCallback(() => {
    setDebugMode(prev => {
      const next = !prev;
      localStorage.setItem('outworked_debug', next ? '1' : '0');
      return next;
    });
  }, []);

  const handleOrchestrationDone = useCallback((event: OrchestrationDoneEvent) => {
    setOrchToast(event);
    setTimeout(() => setOrchToast(null), 8000);
  }, []);

  function handleNewProject() {
    if (!window.confirm('Start a new project? This will clear all chat history, tasks, and working context. Agents and skills will be kept.')) return;
    const cleared = resetProject(agents);
    
    setAgents(cleared);
    setSelectedAgentId(null);
    setInstructionRuns([]);
    setRightPanel('chat');
    // Prompt for a new working directory
    setShowWorkspacePicker(true);
  }

  async function handleWorkspaceSelected(dir: string) {
    setWorkspaceDir(dir);
    localStorage.setItem('outworked_workspace_dir', dir);
    await setWorkspace(dir);
    watchProjectAgents(dir);
    setShowWorkspacePicker(false);
    // Re-sync to pick up project-level agents
    const synced = await syncClaudeSubagents(agents, dir);
    if (synced !== agents) setAgents(synced);
  }

  return (
    <div className="flex h-screen bg-slate-950 text-slate-100 overflow-hidden">
      <div className="sr-only" aria-live="polite">Workspace loaded</div>
      <aside className="w-56 shrink-0 border-r border-slate-700 flex flex-col bg-slate-900/95">
        <div className="px-3 py-3 border-b border-gray-800">
          <h1 className="text-xs font-pixel text-indigo-300">Outworked</h1>
          <p className="text-[10px] font-pixel text-slate-400 mt-1">AI Agent HQ</p>
        </div>
        {/* Claude Code status + sync */}
        <ClaudeCodeStatus />
        {/* Working directory display */}
        {workspaceDir && (
          <button
            onClick={() => setShowWorkspacePicker(true)}
            className="px-2 py-1 border-b border-gray-800 text-left hover:bg-slate-800/50 transition-colors group"
          >
            <p className="text-[9px] font-pixel text-slate-500 group-hover:text-slate-400">📂 Project Dir</p>
            <p className="text-[10px] font-mono text-slate-400 group-hover:text-slate-300 truncate">{workspaceDir}</p>
          </button>
        )}
        <div className="flex-1 overflow-y-auto">
          <AgentList
            agents={agents}
            selectedAgentId={selectedAgentId}
            onSelect={handleAgentClick}
            onAdd={handleAddAgent}
          />
          <SkillsPanel skills={skills} onUpdate={handleUpdateSkills} />
        </div>
        <div className="px-2 py-1.5 border-t border-gray-800">
          <MusicPlayer />
        </div>
        <div className="px-3 py-2 border-t border-gray-800 flex flex-col gap-1.5">
          <button
            onClick={() => {
              const next = !agentTeamsEnabled;
              setAgentTeamsEnabled(next);
              localStorage.setItem('outworked_agent_teams', next ? '1' : '0');
            }}
            className={`w-full btn-pixel text-[10px] ${agentTeamsEnabled ? 'bg-indigo-700 hover:bg-indigo-600 text-indigo-50' : 'bg-slate-700 hover:bg-slate-600 text-slate-200'}`}
          >
            {agentTeamsEnabled ? '👥 Teams ON' : '👤 Teams OFF'}
          </button>
          <button
            onClick={() => setShowPermsModal(true)}
            className={`w-full btn-pixel text-[10px] ${permsEmpty && !permsDismissed ? 'bg-amber-700 hover:bg-amber-600 text-amber-50 animate-pulse' : 'bg-slate-700 hover:bg-slate-600 text-slate-200'}`}
          >
            🔒 Permissions
          </button>
          <div className="flex gap-1.5">
            <button
              onClick={toggleDebug}
              className={`flex-1 btn-pixel text-[10px] ${debugMode ? 'bg-amber-700 hover:bg-amber-600 text-amber-50' : 'bg-slate-700 hover:bg-slate-600 text-slate-200'}`}
            >
              🐛 Debug {debugMode ? 'ON' : 'OFF'}
            </button>
            <button
              onClick={handleNewProject}
              className="flex-1 btn-pixel text-[10px] bg-red-800 hover:bg-red-700 text-red-100"
            >
              New Project
            </button>
          </div>
        </div>
      </aside>

      {/* ── Office (unified — includes Claude Code subagent employees) ── */}
      <>
        <main className="flex-1 relative overflow-hidden bg-slate-950">
            <Suspense fallback={<div className="w-full h-full bg-gray-950" />}>
              <OfficeCanvas
                agents={agents}
                selectedAgentId={selectedAgentId}
                onAgentClick={handleAgentClick}
              />
            </Suspense>
            {/* Orchestration complete toast */}
            {orchToast && (
              <div
                className={`absolute top-3 left-1/2 -translate-x-1/2 z-20 rounded-lg border shadow-xl px-4 py-3 max-w-sm backdrop-blur-sm transition-all ${
                  orchToast.failed === 0
                    ? 'bg-emerald-950/90 border-emerald-500/50'
                    : 'bg-amber-950/90 border-amber-500/50'
                }`}
              >
                <div className="flex items-start gap-3">
                  <span className="text-2xl mt-0.5">{orchToast.failed === 0 ? '✅' : '⚠️'}</span>
                  <div className="flex-1 min-w-0">
                    <p className={`text-[12px] font-pixel ${orchToast.failed === 0 ? 'text-emerald-200' : 'text-amber-200'}`}>
                      {orchToast.failed === 0
                        ? `All ${orchToast.success} task${orchToast.success !== 1 ? 's' : ''} complete!`
                        : `${orchToast.success}/${orchToast.success + orchToast.failed} tasks complete`}
                    </p>
                    <p className="text-[10px] text-slate-400 mt-0.5 truncate">{orchToast.plan}</p>
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {orchToast.agents.map((name) => (
                        <span key={name} className="text-[9px] font-pixel px-1.5 py-0.5 rounded bg-slate-800/80 text-slate-300 border border-slate-700/50">
                          {name}
                        </span>
                      ))}
                    </div>
                  </div>
                  <button
                    onClick={() => setOrchToast(null)}
                    className="text-slate-500 hover:text-white text-xs shrink-0"
                  >
                    ✕
                  </button>
                </div>
              </div>
            )}
            <div className="absolute bottom-0 left-0 right-0 px-3 py-2 bg-slate-950/90 backdrop-blur-sm border-t border-slate-700 flex flex-col gap-1">
              {/* Attention-needed agents (stuck / waiting) */}
              {agents.filter((a) => a.status === 'stuck' || a.status === 'waiting-input' || a.status === 'waiting-approval').length > 0 && (
                <div className="flex gap-3 overflow-x-auto">
                  {agents.filter((a) => a.status === 'stuck' || a.status === 'waiting-input' || a.status === 'waiting-approval').map((a) => (
                    <button
                      key={a.id}
                      onClick={() => handleAgentClick(a)}
                      className={`flex items-center gap-1.5 shrink-0 px-2 py-0.5 rounded text-[10px] font-pixel border transition-colors ${
                        a.status === 'stuck'
                          ? 'bg-red-900/40 border-red-700/50 text-red-300 animate-pulse hover:bg-red-900/60'
                          : a.status === 'waiting-approval'
                          ? 'bg-amber-900/40 border-amber-700/50 text-amber-300 animate-pulse hover:bg-amber-900/60'
                          : 'bg-orange-900/40 border-orange-700/50 text-orange-300 animate-pulse hover:bg-orange-900/60'
                      }`}
                    >
                      <span>{a.status === 'stuck' ? '⚠' : a.status === 'waiting-approval' ? '🔒' : '⏸'}</span>
                      <span style={{ color: a.color }}>{a.name}</span>
                      <span className="text-[9px] opacity-80">
                        {a.status === 'stuck' ? 'Stuck' : a.status === 'waiting-approval' ? 'Needs approval' : 'Needs input'}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {/* Active agents */}
              <div className="flex gap-4 overflow-x-auto">
                {agents.filter((a) => a.status !== 'idle' && a.status !== 'stuck' && a.status !== 'waiting-input' && a.status !== 'waiting-approval' && a.currentThought).map((a) => (
                  <div key={a.id} className="flex items-center gap-1.5 shrink-0">
                    <div className="w-2 h-2 rounded-full animate-pulse" style={{ backgroundColor: a.color }} />
                    <span className="text-[10px] font-pixel text-slate-300">
                      <span style={{ color: a.color }}>{a.name}:</span>{' '}
                      {a.currentThought.slice(0, 50)}{a.currentThought.length > 50 ? '...' : ''}
                    </span>
                  </div>
                ))}
                {agents.every((a) => a.status === 'idle' || !a.currentThought) && (
                  <span className="text-[10px] font-pixel text-slate-400">
                    Click an employee to chat!
                  </span>
                )}
              </div>
            </div>
          </main>

      <aside className="w-80 shrink-0 border-l border-slate-700 flex flex-col bg-slate-900/95 overflow-hidden">
        <PermissionsBanner workspace={workspaceDir} />
        <div className="border-b border-gray-800">
          {/* Row 1: global tabs — always visible */}
          <div className="flex">
            {(['chat', 'workspace', 'git', 'terminal'] as const).map((key) => {
              const label = key === 'workspace' ? 'Files' : key === 'terminal' ? 'Term' : key === 'git' ? 'Git' : 'Chat';
              return (
                <button
                  key={key}
                  onClick={() => setRightPanel(key)}
                  className={`flex-1 py-2 text-[10px] font-pixel leading-relaxed transition-colors ${rightPanel === key ? 'text-white border-b-2 border-indigo-500 bg-gray-800' : 'text-gray-500 hover:text-gray-300'}`}
                >
                  {label}
                </button>
              );
            })}
          </div>
          {/* Row 2: agent-contextual tabs — only when an agent is selected */}
          {selectedAgent && (
            <div className="flex items-center border-t border-gray-800/50">
              <span className="text-[10px] font-pixel text-slate-400 pl-2 pr-1 py-1.5 shrink-0 truncate max-w-[40%]" style={{ color: selectedAgent.color }}>{selectedAgent.name}</span>
              {(['editor', 'tasks'] as const).map((key) => {
                const label = key === 'editor' ? 'Config' : 'Tasks';
                return (
                  <button
                    key={key}
                    onClick={() => setRightPanel(key)}
                    className={`flex-1 py-1.5 text-[10px] font-pixel leading-relaxed transition-colors ${rightPanel === key ? 'text-white border-b-2 border-indigo-500 bg-gray-800' : 'text-gray-500 hover:text-gray-300'}`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <div className="flex-1 overflow-hidden relative">
          {rightPanel !== 'terminal' && rightPanel !== 'workspace' && rightPanel !== 'git' && (
            rightPanel === 'chat' ? (
              <ChatWindow
                agent={selectedAgent}
                agents={agents}
                skills={skills}
                onUpdateAgent={updateAgent}
                onAddAgent={handleAddDynamicAgent}
                agentTeamsEnabled={agentTeamsEnabled}
                onOrchestrationDone={handleOrchestrationDone}
                debugMode={debugMode}
              />
            ) : rightPanel === 'editor' && selectedAgent ? (
              <AgentEditor
                agent={selectedAgent}
                workspaceDir={workspaceDir || undefined}
                onSave={handleSaveAgent}
                onDelete={handleDeleteAgent}
                onClose={() => setRightPanel('chat')}
              />
            ) : rightPanel === 'tasks' ? (
              <AgentTasks
                agent={selectedAgent}
                onUpdateAgent={updateAgent}
              />
            ) : null
          )}
          {/* Workspace panel — always mounted to preserve watcher; hidden when not active */}
          <div className={`absolute inset-0 ${rightPanel === 'workspace' ? '' : 'invisible pointer-events-none'}`}>
            <WorkspacePanel workspaceDir={workspaceDir} />
          </div>
          {/* Git panel — always mounted to preserve state; hidden when not active */}
          <div className={`absolute inset-0 ${rightPanel === 'git' ? '' : 'invisible pointer-events-none'}`}>
            <GitPanel workspaceDir={workspaceDir} />
          </div>
          {/* Terminal is always mounted to preserve shell session; hidden when not active */}
          <div className={`absolute inset-0 ${rightPanel === 'terminal' ? '' : 'invisible pointer-events-none'}`}>
            <TerminalPanel agents={agents} workspaceDir={workspaceDir} />
          </div>
        </div>
      </aside>
      </>

      {showWorkspacePicker && (
        <WorkspacePicker
          currentDir={workspaceDir ?? undefined}
          onSelect={handleWorkspaceSelected}
          onSkip={() => setShowWorkspacePicker(false)}
          showSkip={startupDone}
        />
      )}

      {hirePrompt && (
        <HirePromptModal
          onSubmit={(desc) => hirePrompt.resolve(desc)}
          onCancel={() => hirePrompt.resolve(null)}
        />
      )}

      {showPermsModal && workspaceDir && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setShowPermsModal(false)}>
          <div className="bg-slate-800 border border-slate-600 rounded-lg w-[480px] max-h-[80vh] shadow-xl flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
              <h3 className="text-sm font-pixel text-white">🔒 Permissions & Config</h3>
              <button onClick={() => setShowPermsModal(false)} className="text-slate-400 hover:text-white text-sm">✕</button>
            </div>
            <div className="flex-1 overflow-y-auto">
              <PermissionsPanel workspace={workspaceDir} onSaved={() => setPermsEmpty(false)} />
            </div>
          </div>
        </div>
      )}

      {permsEmpty && !permsDismissed && !showPermsModal && workspaceDir && (
        <div className="fixed bottom-4 left-4 z-40 bg-amber-900/95 border border-amber-600/60 rounded-lg p-3 shadow-lg max-w-xs animate-slide-up">
          <div className="flex items-start gap-2">
            <span className="text-amber-400 text-sm mt-0.5">⚠</span>
            <div className="flex-1">
              <p className="text-[11px] font-pixel text-amber-100">No permissions configured</p>
              <p className="text-[10px] text-amber-300/70 mt-0.5">Set up allow/deny rules so Claude Code knows what tools it can use.</p>
              <div className="flex gap-2 mt-2">
                <button
                  onClick={() => { setShowPermsModal(true); setPermsDismissed(true); }}
                  className="btn-pixel text-[10px] bg-amber-700 hover:bg-amber-600 text-white px-2 py-0.5"
                >
                  Set Up Now
                </button>
                <button
                  onClick={() => setPermsDismissed(true)}
                  className="text-[10px] text-amber-400/60 hover:text-amber-300 font-pixel"
                >
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function HirePromptModal({ onSubmit, onCancel }: { onSubmit: (desc: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState('');
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onCancel}>
      <div className="bg-slate-800 border border-slate-600 rounded-lg p-5 w-[420px] shadow-xl" onClick={e => e.stopPropagation()}>
        <h3 className="text-sm font-pixel text-white mb-1">Hire New Employee</h3>
        <p className="text-[11px] text-slate-400 mb-3">Describe the role and AI will generate a full agent definition.</p>
        <input
          autoFocus
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && value.trim()) onSubmit(value.trim()); if (e.key === 'Escape') onCancel(); }}
          placeholder='e.g. "frontend React developer", "DevOps engineer"'
          className="w-full input-mono text-[12px] mb-3"
        />
        <div className="flex gap-2 justify-end">
          <button onClick={onCancel} className="btn-pixel bg-slate-700 hover:bg-slate-600 text-[11px]">Skip</button>
          <button onClick={() => value.trim() ? onSubmit(value.trim()) : onCancel()} className="btn-pixel bg-emerald-700 hover:bg-emerald-600 text-[11px]">
            ✨ Generate
          </button>
        </div>
      </div>
    </div>
  );
}
