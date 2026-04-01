import {
  useEffect,
  useState,
  useCallback,
  useRef,
  lazy,
  Suspense,
} from "react";
import {
  Agent,
  AgentSkill,
  AgentStatus,
  BackgroundTask,
  SubagentDef,
} from "./lib/types";
import {
  loadSkills,
  saveSkills,
  loadGlobalSkillIds,
  saveGlobalSkillIds,
  createAgent,
  createClaudeAgentFile,
  generateAgentWithAI,
  resetProject,
  parseSubagentFrontmatter,
  loadAgentsFromDisk,
  saveAgentToDisk,
  migrateLocalStorageAgents,
} from "./lib/storage";
import { migrateHistoryToSession, loadSession } from "./lib/sessions";
import {
  getClaudeCodeAuthStatus,
  isElectron,
  onClaudeAgentsChanged,
  watchProjectAgents,
  readClaudeSettings,
  deleteClaudeAgentFile,
} from "./lib/terminal";
import { getWorkspace, setWorkspace } from "./lib/filesystem";
import AgentList from "./components/AgentList";
import AgentEditor from "./components/AgentEditor";
import ChatWindow, { OrchestrationDoneEvent } from "./components/ChatWindow";
import TerminalPanel from "./components/TerminalPanel";
import { InstructionRun } from "./components/OfficeInstructions";
import AgentTasks from "./components/AgentTasks";
import MusicPlayer from "./components/music";
import ClaudeCodeStatus from "./components/ClaudeCodeStatus";
import UpdateBanner from "./components/UpdateBanner";
import WorkspacePicker from "./components/WorkspacePicker";
import PermissionsPanel, {
  PermissionsBanner,
} from "./components/PermissionsPanel";
import WorkspacePanel from "./components/WorkspacePanel";
import GitPanel from "./components/GitPanel";
import CostDashboard from "./components/CostDashboard";
import ChannelsPanel from "./components/ChannelsPanel";
import TriggersPanel from "./components/TriggersPanel";
import NotificationCenter, {
  NotificationToast,
} from "./components/NotificationCenter";
import OnboardingModal from "./components/OnboardingModal";
import AssetsModal from "./components/AssetsModal";
import {
  getActivePack,
  listAssetPacks,
  applyCustomFont,
} from "./lib/assetPack";
import { AppNotification, showDesktopNotification } from "./lib/notifications";
import {
  getSetting,
  setSetting,
  getSettingJSON,
  setSettingJSON,
} from "./lib/settings";
import {
  playTaskComplete,
  playApprovalNeeded,
  playAgentStuck,
  playOrchestrationComplete,
  playOrchestrationWarning,
  getSoundsEnabled,
  initSoundSettings,
} from "./lib/sounds";
import { resolveClaudePermission, PermissionRequest } from "./lib/terminal";

const OfficeCanvas = lazy(() => import("./components/OfficeCanvas"));

type RightPanel =
  | "chat"
  | "editor"
  | "terminal"
  | "workspace"
  | "git"
  | "instructions"
  | "tasks";

/** Ephemeral fields that should NOT trigger a disk write */
const EPHEMERAL_KEYS = new Set<keyof Agent>([
  "status",
  "currentThought",
  "todos",
  "history",
  "currentSessionId",
  "sessionId",
  "collaboratingWith",
  "position",
  "liveStreamText",
  "liveToolCalls",
  "liveThinking",
]);

/**
 * Merge ephemeral runtime state from `prev` onto `fresh` agents loaded from disk.
 * Matches by agent id (outworked-id in frontmatter). Any agent in `fresh` that
 * exists in `prev` gets its ephemeral fields carried over.
 */
function mergeRuntimeState(prev: Agent[], fresh: Agent[]): Agent[] {
  const prevById = new Map(prev.map((a) => [a.id, a]));
  const freshIds = new Set(fresh.map((a) => a.id));
  const merged = fresh.map((f) => {
    const p = prevById.get(f.id);
    if (!p) return f;
    return {
      ...f,
      // Preserve in-memory spriteSheet when disk version is missing (write may be pending)
      spriteSheet: f.spriteSheet ?? p.spriteSheet,
      status: p.status,
      currentThought: p.currentThought,
      todos: p.todos,
      history: p.history,
      currentSessionId: p.currentSessionId,
      sessionId: p.sessionId,
      collaboratingWith: p.collaboratingWith,
      liveStreamText: p.liveStreamText,
      liveToolCalls: p.liveToolCalls,
      liveThinking: p.liveThinking,
    };
  });
  // Keep any prev agents not yet on disk (optimistic adds awaiting file write)
  for (const p of prev) {
    if (!freshIds.has(p.id)) {
      merged.push(p);
    }
  }
  return merged;
}

// Detect popout mode from URL query params
const IS_POPOUT = (() => {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get("mode") === "popout";
  } catch {
    return false;
  }
})();

const POPOUT_INITIAL_AGENT_ID = (() => {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get("agentId") || null;
  } catch {
    return null;
  }
})();

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(
    IS_POPOUT ? POPOUT_INITIAL_AGENT_ID : null,
  );
  const [rightPanel, setRightPanel] = useState<RightPanel>("chat");
  const [popoutOpen, setPopoutOpen] = useState(false);
  const [skills, setSkills] = useState<AgentSkill[]>([]);
  const [instructionRuns, setInstructionRuns] = useState<InstructionRun[]>([]);
  const [agentTeamsEnabled, setAgentTeamsEnabled] = useState(false);
  const [permissionPromptsEnabled, setPermissionPromptsEnabled] =
    useState(true);
  const [autoApproveAll, setAutoApproveAll] = useState(false);
  const [claudeReady, setClaudeReady] = useState(false);
  const [workspaceDir, setWorkspaceDir] = useState<string | null>(null);
  const workspaceDirRef = useRef<string | null>(null);
  const [showWorkspacePicker, setShowWorkspacePicker] = useState(false);
  const [startupDone, setStartupDone] = useState(false);
  const [hirePrompt, setHirePrompt] = useState<{
    resolve: (value: string | null) => void;
  } | null>(null);
  const [showPermsModal, setShowPermsModal] = useState(false);
  const [showCostsModal, setShowCostsModal] = useState(false);
  const [showChannelsModal, setShowChannelsModal] = useState(false);
  const [showTriggersModal, setShowTriggersModal] = useState(false);
  const [showAssetsModal, setShowAssetsModal] = useState(false);
  const [permsEmpty, setPermsEmpty] = useState(false);
  const [permsDismissed, setPermsDismissed] = useState(false);
  const [debugMode, setDebugMode] = useState(false);
  const [orchToast, setOrchToast] = useState<OrchestrationDoneEvent | null>(
    null,
  );
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [latestToast, setLatestToast] = useState<AppNotification | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [backgroundTasks, setBackgroundTasks] = useState<BackgroundTask[]>([]);
  const [furnitureLayout, setFurnitureLayout] = useState<
    import("./phaser/OfficeScene").FurnitureItem[] | null
  >(null);

  useEffect(() => {
    async function init() {
      // Popout receives all state from main window — only load font
      if (IS_POPOUT) {
        try {
          const activePackId = await getActivePack();
          if (activePackId) {
            const packs = await listAssetPacks();
            const pack = packs.find(
              (p: { id: string }) => p.id === activePackId,
            );
            if (pack) await applyCustomFont(pack);
          }
        } catch {
          /* non-critical */
        }
        setStartupDone(true);
        return;
      }

      // Load persisted settings from SQLite
      const [
        savedWs,
        savedTeams,
        savedPerms,
        savedDebug,
        savedOnboarding,
        savedFurniture,
        savedAutoApprove,
      ] = await Promise.all([
        getSetting("outworked_workspace_dir"),
        getSetting("outworked_agent_teams"),
        getSetting("outworked_permission_prompts"),
        getSetting("outworked_debug"),
        getSetting("outworked_onboarding_done"),
        getSettingJSON<import("./phaser/OfficeScene").FurnitureItem[] | null>(
          "outworked_furniture_layout",
          null,
        ),
        getSetting("outworked_auto_approve_all"),
      ]);
      setAgentTeamsEnabled(savedTeams === "1");
      setPermissionPromptsEnabled(savedPerms !== "0");
      setAutoApproveAll(savedAutoApprove === "1");
      // setDebugMode(savedDebug === "1");
      setDebugMode(false); // Force debug mode off for now, to avoid accidentally enabling it in production
      setShowOnboarding(!savedOnboarding);
      setFurnitureLayout(savedFurniture);
      await initSoundSettings();

      // Apply custom font from active asset pack
      try {
        const activePackId = await getActivePack();
        if (activePackId) {
          const packs = await listAssetPacks();
          const pack = packs.find((p) => p.id === activePackId);
          if (pack) await applyCustomFont(pack);
        }
      } catch {
        // Font loading is non-critical
      }

      setSkills(await loadSkills());

      // Check Claude Code availability
      let ccReady = false;
      if (isElectron()) {
        try {
          const authStatus = await getClaudeCodeAuthStatus();
          ccReady = !!(authStatus.installed && authStatus.authenticated);
        } catch {
          /* not available */
        }
      }
      setClaudeReady(ccReady);

      // Migrate any agents previously stored in localStorage to .md files
      const wsDir =
        savedWs || (isElectron() ? await getWorkspace() : undefined);
      await migrateLocalStorageAgents(wsDir || undefined);

      // Load agents from disk (.md files are the single source of truth)
      const diskAgents = await loadAgentsFromDisk(wsDir || undefined);
      setAgents(diskAgents);

      // Load workspace dir — show picker if none saved
      if (isElectron()) {
        if (savedWs) {
          setWorkspaceDir(savedWs);
          workspaceDirRef.current = savedWs;
          await setWorkspace(savedWs);
          watchProjectAgents(savedWs);
        } else {
          const defaultDir = await getWorkspace();
          setWorkspaceDir(defaultDir);
          workspaceDirRef.current = defaultDir;
          watchProjectAgents(defaultDir);
          setShowWorkspacePicker(true);
        }
      }

      // Migrate any existing in-memory history to sessions (one-time)
      const migrated = await getSetting("outworked_sessions_migrated");
      if (!migrated) {
        const rawAgents = await (async () => {
          try {
            const r = await getSetting("outworked_agents");
            return r ? JSON.parse(r) : [];
          } catch {
            return [];
          }
        })();
        for (const raw of rawAgents) {
          if (raw.history && raw.history.length > 0 && !raw.currentSessionId) {
            const session = await migrateHistoryToSession(
              raw.id,
              raw.history,
              raw.sessionId,
            );
            if (session) {
              setAgents((prev) =>
                prev.map((a) =>
                  a.id === raw.id
                    ? {
                        ...a,
                        currentSessionId: session.id,
                        history: session.messages,
                      }
                    : a,
                ),
              );
            }
          }
        }
        await setSetting("outworked_sessions_migrated", "1");
      }

      setStartupDone(true);

      // Check whether any permission rules exist
      const wsDir2 =
        savedWs || (isElectron() ? await getWorkspace() : undefined);
      if (wsDir2) {
        const { settings } = await readClaudeSettings("project");
        const perms = settings.permissions || { allow: [], deny: [] };
        const empty =
          (!perms.allow || perms.allow.length === 0) &&
          (!perms.deny || perms.deny.length === 0);
        setPermsEmpty(empty);
      }
    }
    init();
  }, []);

  // Auto-reload when Claude Code agent files change on disk
  useEffect(() => {
    const unsub = onClaudeAgentsChanged(async () => {
      const wsDir = (await getSetting("outworked_workspace_dir")) || undefined;
      const fresh = await loadAgentsFromDisk(wsDir);
      setAgents((prev) => mergeRuntimeState(prev, fresh));
    });
    return unsub;
  }, []);

  const selectedAgent = agents.find((a) => a.id === selectedAgentId) ?? null;

  // ── Popout chat window state sync ─────────────────────────────
  const popoutAPI = (
    window as unknown as {
      electronAPI?: { popout?: import("./lib/terminal").PopoutAPI };
    }
  ).electronAPI?.popout;

  // Counter bumped when popout signals ready — triggers a state push
  const [popoutReady, setPopoutReady] = useState(0);

  // Main window: listen for popout close, ready, and relayed actions
  useEffect(() => {
    if (IS_POPOUT || !popoutAPI) return;
    const unsubClosed = popoutAPI.onClosed(() => setPopoutOpen(false));
    const unsubReady = popoutAPI.onReady(() => setPopoutReady((n) => n + 1));
    const unsubAction = popoutAPI.onAction((action: unknown) => {
      const a = action as {
        type: string;
        agentId?: string;
        text?: string;
        nonce?: string;
        panel?: RightPanel;
        agent?: Agent;
      };
      if (a.type === "selectAgent") {
        setSelectedAgentId(a.agentId || null);
      } else if ((a.type === "sendMessage" || a.type === "sendBackgroundMessage") && a.agentId && a.text) {
        setSelectedAgentId(a.agentId);
        setRightPanel("chat");
        setPendingMessage({
          text: a.text,
          nonce: a.nonce || crypto.randomUUID(),
          background: a.type === "sendBackgroundMessage" || undefined,
        });
      } else if (a.type === "setPanel" && a.panel) {
        setRightPanel(a.panel);
      } else if (a.type === "saveAgent" && a.agent) {
        handleSaveAgent(a.agent);
      } else if (a.type === "deleteAgent" && a.agentId) {
        handleDeleteAgent(a.agentId);
      }
    });
    return () => {
      unsubClosed();
      unsubReady();
      unsubAction();
    };
  }, [popoutAPI]);

  // Main window: push full state to popout whenever it changes
  // (popoutReady ensures the first push lands after the listener is registered)
  useEffect(() => {
    if (IS_POPOUT || !popoutOpen || !popoutAPI) return;
    popoutAPI.pushState({
      agents,
      selectedAgentId,
      rightPanel,
      skills,
      agentTeamsEnabled,
      debugMode,
      autoApproveAll,
      backgroundTasks,
      workspaceDir,
    });
  }, [
    agents,
    selectedAgentId,
    rightPanel,
    popoutOpen,
    popoutReady,
    skills,
    agentTeamsEnabled,
    debugMode,
    autoApproveAll,
    backgroundTasks,
    workspaceDir,
  ]);

  // Popout: receive state from main window, then signal ready
  useEffect(() => {
    if (!IS_POPOUT || !popoutAPI) return;
    const unsub = popoutAPI.onStateUpdate((data: unknown) => {
      const d = data as {
        agents?: Agent[];
        selectedAgentId?: string | null;
        rightPanel?: RightPanel;
        skills?: AgentSkill[];
        agentTeamsEnabled?: boolean;
        debugMode?: boolean;
        autoApproveAll?: boolean;
        backgroundTasks?: BackgroundTask[];
        workspaceDir?: string | null;
      };
      if (d.agents) setAgents(d.agents as Agent[]);
      if (d.selectedAgentId !== undefined)
        setSelectedAgentId(d.selectedAgentId);
      if (d.rightPanel) setRightPanel(d.rightPanel);
      if (d.agentTeamsEnabled !== undefined)
        setAgentTeamsEnabled(d.agentTeamsEnabled);
      if (d.debugMode !== undefined) setDebugMode(d.debugMode);
      if (d.autoApproveAll !== undefined) setAutoApproveAll(d.autoApproveAll);
      if (d.skills) setSkills(d.skills);
      if (d.backgroundTasks) setBackgroundTasks(d.backgroundTasks);
      if (d.workspaceDir !== undefined) setWorkspaceDir(d.workspaceDir);
    });
    // Signal ready so main window re-pushes state now that listener is active
    popoutAPI.signalReady();
    return unsub;
  }, [popoutAPI]);

  // ── Trigger / channel-message listener ──────────────────────────
  const [pendingMessage, setPendingMessage] = useState<{
    text: string;
    nonce: string;
    forceNewSession?: boolean;
    background?: boolean;
  } | null>(null);

  useEffect(() => {
    if (!isElectron()) return;
    const w = window as unknown as {
      electronAPI?: {
        db?: {
          onTriggerFire?: (
            cb: (data: {
              triggerId: string;
              triggerName: string;
              agentId: string | null;
              prompt: string;
              context?: { scheduled?: boolean; taskId?: string };
            }) => void,
          ) => () => void;
        };
      };
    };
    const unsub = w.electronAPI?.db?.onTriggerFire?.((data) => {
      // Find the target agent, fall back to boss
      const targetAgent =
        (data.agentId && agents.find((a) => a.id === data.agentId)) ||
        agents.find((a) => a.isBoss);

      if (!targetAgent) {
        console.warn(
          "[Trigger] No target agent found for trigger:",
          data.triggerName,
          "| looking for agentId:",
          data.agentId,
          "| available agents:",
          agents.map((a) => ({ id: a.id, name: a.name })),
        );
        return;
      }

      // Select the target agent and inject the prompt
      setSelectedAgentId(targetAgent.id);
      setRightPanel("chat");
      setPendingMessage({
        text: data.prompt,
        nonce: crypto.randomUUID(),
        forceNewSession: !!data.context?.scheduled,
      });

      // Update agent status to show it's handling a channel message
      setAgents((prev) =>
        prev.map((a) =>
          a.id === targetAgent.id
            ? {
                ...a,
                status: "channel-message" as AgentStatus,
                currentThought: `📨 ${data.triggerName}`,
              }
            : a,
        ),
      );

      // Safety net: if agent is still in channel-message after 10s, reset to idle.
      // This catches cases where the auto-send failed silently.
      const agentId = targetAgent.id;
      setTimeout(() => {
        setAgents((prev) =>
          prev.map((a) =>
            a.id === agentId && a.status === "channel-message"
              ? { ...a, status: "idle" as AgentStatus, currentThought: "" }
              : a,
          ),
        );
      }, 10_000);
    });
    return unsub;
  }, [agents]);

  // Hydrate session from disk when selecting an agent with a saved session but empty history
  useEffect(() => {
    if (!selectedAgent?.currentSessionId || selectedAgent.history.length > 0)
      return;
    loadSession(selectedAgent.id, selectedAgent.currentSessionId).then(
      (session) => {
        if (session) {
          setAgents((prev) =>
            prev.map((a) =>
              a.id === selectedAgent.id
                ? {
                    ...a,
                    history: session.messages,
                    sessionId: session.claudeSessionId,
                  }
                : a,
            ),
          );
        }
      },
    );
  }, [selectedAgentId]); // eslint-disable-line react-hooks/exhaustive-deps

  const agentsRef = useRef(agents);
  agentsRef.current = agents;

  const updateAgent = useCallback((updated: Agent) => {
    // Check for persistent changes against the current state (via ref)
    const old = agentsRef.current.find((a) => a.id === updated.id);
    const hasPersistentChange =
      old &&
      (Object.keys(updated) as (keyof Agent)[]).some(
        (k) => !EPHEMERAL_KEYS.has(k) && updated[k] !== old[k],
      );

    setAgents((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));

    // Disk write outside the state updater — safe from StrictMode double-fire
    if (hasPersistentChange) {
      saveAgentToDisk(updated, workspaceDirRef.current || undefined);
    }
  }, []);

  const pushNotification = useCallback(
    (notif: Omit<AppNotification, "id" | "timestamp" | "read">) => {
      const full: AppNotification = {
        ...notif,
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        read: false,
      };
      setNotifications((prev) => [full, ...prev].slice(0, 100)); // Keep max 100
      setLatestToast(full);
    },
    [],
  );

  // Track previous agent statuses to detect changes
  const prevStatusRef = useRef<Record<string, AgentStatus>>({});

  useEffect(() => {
    for (const agent of agents) {
      const prev = prevStatusRef.current[agent.id];
      if (prev === agent.status) continue;

      // Agent just became stuck
      if (agent.status === "stuck" && prev !== "stuck") {
        pushNotification({
          type: "agent-stuck",
          title: `${agent.name} is stuck`,
          body: agent.currentThought || "No progress detected",
          agentName: agent.name,
          agentColor: agent.color,
        });
        if (getSoundsEnabled()) playAgentStuck();
        showDesktopNotification(
          `${agent.name} is stuck`,
          agent.currentThought || "No progress detected",
        );
      }

      // Agent finished (went from working/thinking/speaking to idle)
      if (
        agent.status === "idle" &&
        (prev === "working" || prev === "thinking" || prev === "speaking")
      ) {
        pushNotification({
          type: "task-complete",
          title: `${agent.name} finished`,
          body: agent.currentThought || "Task complete",
          agentName: agent.name,
          agentColor: agent.color,
        });
        if (getSoundsEnabled()) playTaskComplete();
        showDesktopNotification(
          `${agent.name} finished`,
          agent.currentThought || "Task complete",
        );
      }

      prevStatusRef.current[agent.id] = agent.status;
    }
  }, [agents, pushNotification]);

  const handleAgentClick = useCallback((agent: Agent) => {
    setSelectedAgentId(agent.id);
    setRightPanel("chat");
  }, []);

  const handleAgentMove = useCallback(
    (agentId: string, x: number, y: number) => {
      setAgents((prev) =>
        prev.map((a) => (a.id === agentId ? { ...a, position: { x, y } } : a)),
      );
    },
    [],
  );

  const handleFurnitureMove = useCallback(
    (items: import("./phaser/OfficeScene").FurnitureItem[]) => {
      setSettingJSON("outworked_furniture_layout", items);
    },
    [],
  );

  function handleAddAgent() {
    if (claudeReady) {
      // Show the hire prompt modal — the rest happens in the callback
      new Promise<string | null>((resolve) => {
        setHirePrompt({ resolve });
      }).then((description) => {
        setHirePrompt(null);
        if (description !== null) finishHire(description);
      });
    } else {
      finishHire(null);
    }
  }

  async function finishHire(description: string | null) {
    const agent = createAgent(
      {
        role: description || undefined,
        position: {
          x: Math.floor(Math.random() * 10) + 2,
          y: Math.floor(Math.random() * 6) + 2,
        },
      },
      claudeReady,
    );

    if (claudeReady && !description) {
      // No AI generation — create the .md file immediately
      const filePath = await createClaudeAgentFile(
        agent,
        workspaceDir || undefined,
      );
      if (filePath) {
        agent.subagentFile = filePath;
        agent.subagentDef = { description: agent.role };
      }
    }

    const next = [...agents, agent];
    setAgents(next);
    setSelectedAgentId(agent.id);
    setRightPanel("editor");

    if (claudeReady && description) {
      // AI-generate a full agent .md from the description
      updateAgent({
        ...agent,
        status: "thinking",
        currentThought: "Being onboarded by AI...",
      });
      generateAgentWithAI(description, {
        workspaceDir: workspaceDir || undefined,
        skipWrite: true,
      }).then(async (result) => {
        if (result) {
          const parsed = parseSubagentFrontmatter(result.content);
          const name =
            parsed.def["outworked-name"] || parsed.def.name || agent.name;
          const role =
            parsed.def["outworked-role"] ||
            parsed.def.description ||
            agent.role;

          const updatedAgent: Agent = {
            ...agent,
            name,
            role,
            personality: parsed.body || agent.personality,
            subagentFile: result.filePath,
            subagentDef: { description: role, ...parsed.def } as SubagentDef,
            status: "idle",
            currentThought: "",
          };

          // Re-write the file with the correct outworked-id and metadata
          await saveAgentToDisk(updatedAgent, workspaceDir || undefined);
          updateAgent(updatedAgent);
        } else {
          // AI failed — fall back to creating a bare stub
          const filePath = await createClaudeAgentFile(
            agent,
            workspaceDir || undefined,
          );
          updateAgent({
            ...agent,
            subagentFile: filePath || undefined,
            subagentDef: filePath ? { description: agent.role } : undefined,
            status: "idle",
            currentThought: "",
          });
        }
      });
    }
  }

  function handleSaveAgent(updated: Agent) {
    updateAgent(updated);
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
    setSelectedAgentId(null);
  }

  const handleAddDynamicAgent = useCallback((agent: Agent) => {
    setAgents((prev) => {
      // Dedup: the file watcher may have already added this agent from disk
      if (prev.some((a) => a.id === agent.id)) return prev;
      return [...prev, agent];
    });
  }, []);

  const handleSaveAutoAgent = useCallback((agentId: string) => {
    setAgents((prev) => {
      const agent = prev.find((a) => a.id === agentId);
      if (!agent) return prev;
      const saved = { ...agent, autoCreated: false };
      const next = prev.map((a) => (a.id === agentId ? saved : a));
      // Rewrite the .md file without the outworked-auto-created flag
      saveAgentToDisk(saved, workspaceDirRef.current || undefined);
      return next;
    });
  }, []);

  const handleUpdateSkills = useCallback((updated: AgentSkill[]) => {
    setSkills(updated);
    saveSkills(updated);
  }, []);

  const toggleDebug = useCallback(() => {
    setDebugMode((prev) => {
      const next = !prev;
      setSetting("outworked_debug", next ? "1" : "0");
      return next;
    });
  }, []);

  const handleOrchestrationDone = useCallback(
    (event: OrchestrationDoneEvent) => {
      setOrchToast(event);
      setTimeout(() => setOrchToast(null), 8000);

      // Push notification
      const allSuccess = event.failed === 0;
      pushNotification({
        type: "orchestration-done",
        title: allSuccess
          ? "All tasks complete!"
          : "Tasks finished with issues",
        body: `${event.success} succeeded, ${event.failed} failed — ${event.plan}`,
      });
      if (getSoundsEnabled()) {
        if (allSuccess) playOrchestrationComplete();
        else playOrchestrationWarning();
      }
      showDesktopNotification(
        allSuccess ? "All tasks complete!" : "Tasks finished",
        `${event.success}/${event.success + event.failed} tasks succeeded`,
      );
    },
    [pushNotification],
  );

  const handleStartBackgroundTask = useCallback(
    (
      task: BackgroundTask,
      execute: () => Promise<{ reply: string; agent: Agent }>,
    ) => {
      // Add to background task list
      setBackgroundTasks((prev) => [...prev, task]);

      // Run the task — don't await, it runs in the background
      execute()
        .then(({ agent: finalAgent }) => {
          // Update agent with results
          updateAgent(finalAgent);
          // Mark task as done
          setBackgroundTasks((prev) =>
            prev.map((t) =>
              t.id === task.id
                ? {
                    ...t,
                    status: "done" as const,
                    completedAt: Date.now(),
                    result: finalAgent.currentThought,
                  }
                : t,
            ),
          );
          // Notification
          pushNotification({
            type: "task-complete",
            title: `${task.agentName} finished background task`,
            body: task.prompt.slice(0, 80),
            agentName: task.agentName,
            agentColor: agents.find((a) => a.id === task.agentId)?.color,
          });
          if (getSoundsEnabled()) playTaskComplete();
          showDesktopNotification(
            `${task.agentName} finished`,
            task.prompt.slice(0, 80),
          );
        })
        .catch((err) => {
          const errorMsg = err instanceof Error ? err.message : "Unknown error";
          // Update agent to idle on error
          const agentNow = agents.find((a) => a.id === task.agentId);
          if (agentNow) {
            updateAgent({ ...agentNow, status: "idle", currentThought: "" });
          }
          // Mark task as error
          setBackgroundTasks((prev) =>
            prev.map((t) =>
              t.id === task.id
                ? {
                    ...t,
                    status: "error" as const,
                    completedAt: Date.now(),
                    error: errorMsg,
                  }
                : t,
            ),
          );
          pushNotification({
            type: "agent-stuck",
            title: `${task.agentName} background task failed`,
            body: errorMsg,
            agentName: task.agentName,
            agentColor: agents.find((a) => a.id === task.agentId)?.color,
          });
        });
    },
    [agents, updateAgent, pushNotification],
  );

  const handlePermissionNotification = useCallback(
    (agentName: string, request: PermissionRequest) => {
      pushNotification({
        type: "approval",
        title: `${agentName} needs approval`,
        body: `${request.tool}: ${request.description}`,
        agentName,
        agentColor: agents.find((a) => a.name === agentName)?.color,
        permissionReqId: request.reqId,
        permissionPermId: request.permId,
        permissionTool: request.tool,
        permissionDesc: request.description,
      });
      if (getSoundsEnabled()) playApprovalNeeded();
      showDesktopNotification(
        `${agentName} needs approval`,
        `${request.tool}: ${request.description}`,
      );
    },
    [agents, pushNotification],
  );

  function handleNewProject() {
    if (
      !window.confirm(
        "Start a new project? This will clear all chat history, tasks, and working context. Agents and skills will be kept.",
      )
    )
      return;
    const cleared = resetProject(agents);

    setAgents(cleared);
    setSelectedAgentId(null);
    setInstructionRuns([]);
    setRightPanel("chat");
    // Prompt for a new working directory
    setShowWorkspacePicker(true);
  }

  async function handleWorkspaceSelected(dir: string) {
    setWorkspaceDir(dir);
    workspaceDirRef.current = dir;
    setSetting("outworked_workspace_dir", dir);
    await setWorkspace(dir);
    watchProjectAgents(dir);
    setShowWorkspacePicker(false);
    // Drop auto-created agents when switching projects and delete their .md files
    const autoAgents = agents.filter((a) => a.autoCreated);
    for (const a of autoAgents) {
      if (a.subagentFile) deleteClaudeAgentFile(a.subagentFile);
    }
    const withoutAuto = agents.filter((a) => !a.autoCreated);
    setAgents(withoutAuto);
    // Reload from disk to pick up project-level agents for the new workspace
    const fresh = await loadAgentsFromDisk(dir);
    setAgents(fresh);
    // Clear stale permission/notification badges from the previous workspace
    setNotifications([]);
    // Re-check permissions for the new workspace
    setPermsDismissed(false);
    try {
      const { settings } = await readClaudeSettings("project");
      const perms = settings.permissions || { allow: [], deny: [] };
      const empty =
        (!perms.allow || perms.allow.length === 0) &&
        (!perms.deny || perms.deny.length === 0);
      setPermsEmpty(empty);
    } catch {
      setPermsEmpty(true);
    }
  }

  // ── Popout mode: full right panel with real ChatWindow ───────────
  // The popout runs the real ChatWindow so the UI matches exactly.
  // Agent state changes are relayed back to the main window to keep
  // both sides in sync.
  if (IS_POPOUT) {
    return (
      <PopoutPanel
        agents={agents}
        selectedAgent={selectedAgent}
        selectedAgentId={selectedAgentId}
        rightPanel={rightPanel}
        workspaceDir={workspaceDir}
        skills={skills}
        agentTeamsEnabled={agentTeamsEnabled}
        autoApproveAll={autoApproveAll}
        debugMode={debugMode}
        backgroundTasks={backgroundTasks}
        onSelectAgent={(id) => {
          popoutAPI?.sendAction({ type: "selectAgent", agentId: id });
        }}
        onSetRightPanel={(panel) => {
          popoutAPI?.sendAction({ type: "setPanel", panel });
        }}
        onInterceptSend={(text, options) => {
          if (!selectedAgent) return;
          popoutAPI?.sendAction({
            type: options?.background ? "sendBackgroundMessage" : "sendMessage",
            agentId: selectedAgent.id,
            text,
            nonce: crypto.randomUUID(),
          });
        }}
        onSaveAgent={(agent) => {
          popoutAPI?.sendAction({ type: "saveAgent", agent });
        }}
        onDeleteAgent={(agentId) => {
          popoutAPI?.sendAction({ type: "deleteAgent", agentId });
        }}
      />
    );
  }

  return (
    <div className="flex h-screen bg-slate-950 text-slate-100 overflow-hidden">
      <div className="sr-only" aria-live="polite">
        Workspace loaded
      </div>
      <aside className="w-56 shrink-0 border-r border-slate-700 flex flex-col bg-slate-900/95">
        <div className="px-3 py-3 border-b border-gray-800 flex items-center justify-between">
          <div>
            <h1 className="text-xs font-pixel text-indigo-300">Outworked</h1>
            <p className="text-[10px] font-pixel text-slate-400 mt-1">
              AI Agent HQ
            </p>
          </div>
          <button
            onClick={() => setShowAssetsModal(true)}
            className="text-slate-500 hover:text-slate-300 transition-colors cursor-pointer items-center flex flex-col"
            title="Asset Packs"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="3" width="7" height="7" />
              <rect x="14" y="3" width="7" height="7" />
              <rect x="3" y="14" width="7" height="7" />
              <rect x="14" y="14" width="7" height="7" />
            </svg>
            <div className="text-[8px] font-pixel">customize</div>
          </button>
        </div>
        {/* Update banner */}
        <UpdateBanner />
        {/* Claude Code status + sync */}
        <ClaudeCodeStatus />
        {/* Working directory display */}
        {workspaceDir && (
          <button
            onClick={() => setShowWorkspacePicker(true)}
            className="px-2 py-1 border-b border-gray-800 text-left hover:bg-slate-800/50 transition-colors group cursor-pointer"
          >
            <p className="text-[9px] font-pixel text-slate-500 group-hover:text-slate-400">
              📂 Project Dir
            </p>
            <p className="text-[10px] font-mono text-slate-400 group-hover:text-slate-300 truncate">
              {workspaceDir}
            </p>
          </button>
        )}
        <div className="flex-1 overflow-y-auto">
          <AgentList
            agents={agents}
            selectedAgentId={selectedAgentId}
            onSelect={handleAgentClick}
            onAdd={handleAddAgent}
            backgroundTasks={backgroundTasks}
            onSaveAgent={handleSaveAutoAgent}
          />
        </div>
        <div className="px-2 py-1.5 border-t border-gray-800">
          <MusicPlayer />
        </div>
        <div className="px-3 py-2 border-t border-gray-800 flex flex-col gap-1.5 overflow-hidden">
          {/* <button
            onClick={() => {
              const next = !agentTeamsEnabled;
              setAgentTeamsEnabled(next);
              setSetting("outworked_agent_teams", next ? "1" : "0");
            }}
            className={`w-full btn-pixel text-[10px] ${agentTeamsEnabled ? "bg-indigo-700 hover:bg-indigo-600 text-indigo-50" : "bg-slate-700 hover:bg-slate-600 text-slate-200"}`}
          >
            {agentTeamsEnabled ? "Teams ON" : "Teams OFF"}
          </button> */}
          <button
            onClick={() => {
              const next = !permissionPromptsEnabled;
              setPermissionPromptsEnabled(next);
              setSetting("outworked_permission_prompts", next ? "1" : "0");
            }}
            className={`w-full btn-pixel text-[10px] ${!permissionPromptsEnabled ? "bg-amber-700 hover:bg-amber-600 text-amber-50" : "bg-slate-700 hover:bg-slate-600 text-slate-200"}`}
          >
            {permissionPromptsEnabled ? "🔒 Auto Edit OFF" : "🔓 Auto Edit ON"}
          </button>
          <button
            onClick={() => {
              const next = !autoApproveAll;
              setAutoApproveAll(next);
              setSetting("outworked_auto_approve_all", next ? "1" : "0");
            }}
            className={`w-full btn-pixel text-[10px] ${autoApproveAll ? "bg-amber-700 hover:bg-amber-600 text-amber-50" : "bg-slate-700 hover:bg-slate-600 text-slate-200"}`}
          >
            {autoApproveAll ? "⚡ Auto Approve ON" : "🔒 Auto Approve OFF"}
          </button>
          <NotificationCenter
            notifications={notifications}
            onDismiss={(id) =>
              setNotifications((prev) =>
                prev.map((n) => (n.id === id ? { ...n, read: true } : n)),
              )
            }
            onDismissAll={() => setNotifications([])}
            onApprovalResponse={async (notifId, permId, allow) => {
              await resolveClaudePermission(permId, allow);
              setNotifications((prev) =>
                prev.map((n) => (n.id === notifId ? { ...n, read: true } : n)),
              );
            }}
            onNavigateToAgent={(name) => {
              const a = agents.find((ag) => ag.name === name);
              if (a) {
                setSelectedAgentId(a.id);
                setRightPanel("chat");
              }
            }}
          />
          <div className="flex gap-1.5">
            <button
              onClick={() => setShowPermsModal(true)}
              className={`flex-1 min-w-0 btn-pixel text-[10px] ${permsEmpty && !permsDismissed ? "bg-amber-700 hover:bg-amber-600 text-amber-50 animate-pulse" : "bg-slate-700 hover:bg-slate-600 text-slate-200"}`}
            >
              🔒 Perms
            </button>
            <button
              onClick={() => setShowCostsModal(true)}
              className="flex-1 min-w-0 btn-pixel text-[10px] bg-slate-700 hover:bg-slate-600 text-slate-200"
            >
              💰 Costs
            </button>
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={() => setShowChannelsModal(true)}
              className="flex-1 min-w-0 btn-pixel text-[10px] bg-slate-700 hover:bg-slate-600 text-slate-200"
            >
              💬 Channels
            </button>
            <button
              onClick={() => setShowTriggersModal(true)}
              className="flex-1 min-w-0 btn-pixel text-[10px] bg-slate-700 hover:bg-slate-600 text-slate-200"
            >
              ⚡ Triggers
            </button>
          </div>
          <div className="flex gap-1.5">
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
              onAgentMove={handleAgentMove}
              onFurnitureMove={handleFurnitureMove}
              furnitureLayout={furnitureLayout}
            />
          </Suspense>
          {/* Orchestration complete toast */}
          {orchToast && (
            <div
              className={`absolute top-3 left-1/2 -translate-x-1/2 z-20 rounded-lg border shadow-xl px-4 py-3 max-w-sm backdrop-blur-sm transition-all ${
                orchToast.failed === 0
                  ? "bg-emerald-950/90 border-emerald-500/50"
                  : "bg-amber-950/90 border-amber-500/50"
              }`}
            >
              <div className="flex items-start gap-3">
                <span className="text-2xl mt-0.5">
                  {orchToast.failed === 0 ? "✅" : "⚠️"}
                </span>
                <div className="flex-1 min-w-0">
                  <p
                    className={`text-[12px] font-pixel ${orchToast.failed === 0 ? "text-emerald-200" : "text-amber-200"}`}
                  >
                    {orchToast.failed === 0
                      ? `All ${orchToast.success} task${orchToast.success !== 1 ? "s" : ""} complete!`
                      : `${orchToast.success}/${orchToast.success + orchToast.failed} tasks complete`}
                  </p>
                  <p className="text-[10px] text-slate-400 mt-0.5 truncate">
                    {orchToast.plan}
                  </p>
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {orchToast.agents.map((name) => (
                      <span
                        key={name}
                        className="text-[9px] font-pixel px-1.5 py-0.5 rounded bg-slate-800/80 text-slate-300 border border-slate-700/50"
                      >
                        {name}
                      </span>
                    ))}
                  </div>
                </div>
                <button
                  onClick={() => setOrchToast(null)}
                  className="text-slate-500 hover:text-white text-xs shrink-0 cursor-pointer font-pixel uppercase"
                >
                  X
                </button>
              </div>
            </div>
          )}
          <NotificationToast
            notification={latestToast}
            onDismiss={() => setLatestToast(null)}
          />
          <div className="absolute bottom-0 left-0 right-0 px-3 py-2 bg-slate-950/90 backdrop-blur-sm border-t border-slate-700 flex flex-col gap-1">
            {/* Attention-needed agents (slow / stuck / waiting) */}
            {agents.filter(
              (a) =>
                a.status === "slow" ||
                a.status === "stuck" ||
                a.status === "waiting-input" ||
                a.status === "waiting-approval",
            ).length > 0 && (
              <div className="flex gap-3 overflow-x-auto">
                {agents
                  .filter(
                    (a) =>
                      a.status === "slow" ||
                      a.status === "stuck" ||
                      a.status === "waiting-input" ||
                      a.status === "waiting-approval",
                  )
                  .map((a) => (
                    <button
                      key={a.id}
                      onClick={() => handleAgentClick(a)}
                      className={`flex items-center gap-1.5 shrink-0 px-2 py-0.5 rounded text-[10px] font-pixel border transition-colors ${
                        a.status === "stuck"
                          ? "bg-red-900/40 border-red-700/50 text-red-300 animate-pulse hover:bg-red-900/60"
                          : a.status === "slow"
                            ? "bg-yellow-900/40 border-yellow-700/50 text-yellow-300 hover:bg-yellow-900/60"
                            : a.status === "waiting-approval"
                              ? "bg-amber-900/40 border-amber-700/50 text-amber-300 animate-pulse hover:bg-amber-900/60"
                              : "bg-orange-900/40 border-orange-700/50 text-orange-300 animate-pulse hover:bg-orange-900/60"
                      }`}
                    >
                      <span>
                        {a.status === "stuck"
                          ? "⚠"
                          : a.status === "slow"
                            ? "🐢"
                            : a.status === "waiting-approval"
                              ? "🔒"
                              : "⏸"}
                      </span>
                      <span style={{ color: a.color }}>{a.name}</span>
                      <span className="text-[9px] opacity-80">
                        {a.status === "stuck"
                          ? "Stuck"
                          : a.status === "slow"
                            ? "Slow"
                            : a.status === "waiting-approval"
                              ? "Needs approval"
                              : "Needs input"}
                      </span>
                    </button>
                  ))}
              </div>
            )}
            {/* Active agents ticker */}
            <div className="overflow-hidden w-full">
              <div className="flex gap-4 w-max animate-marquee-agents">
                {/* Render items twice for seamless marquee loop */}
                {[0, 1].map((pass) => {
                  const active = agents.filter(
                    (a) =>
                      a.status !== "idle" &&
                      a.status !== "slow" &&
                      a.status !== "stuck" &&
                      a.status !== "waiting-input" &&
                      a.status !== "waiting-approval",
                  );
                  if (active.length === 0 && pass === 0) {
                    return (
                      <span
                        key="empty"
                        className="text-[10px] font-pixel text-slate-400 shrink-0"
                      >
                        Click an employee to chat!
                      </span>
                    );
                  }
                  if (active.length === 0) return null;
                  return active.map((a) => (
                    <button
                      key={`${pass}-${a.id}`}
                      onClick={() => handleAgentClick(a)}
                      className="flex items-center gap-1.5 shrink-0 group hover:bg-slate-800/50 rounded px-1.5 py-0.5 transition-colors"
                    >
                      <span className="relative flex h-2 w-2">
                        <span
                          className={`${a.status === "background" ? "" : "animate-ping"} absolute inline-flex h-full w-full rounded-full opacity-75`}
                          style={{
                            backgroundColor:
                              a.status === "background" ? "#6366f1" : a.color,
                          }}
                        />
                        <span
                          className="relative inline-flex rounded-full h-2 w-2"
                          style={{
                            backgroundColor:
                              a.status === "background" ? "#6366f1" : a.color,
                          }}
                        />
                      </span>
                      <span className="text-[10px] font-pixel text-slate-300 whitespace-nowrap">
                        {a.status === "background" && (
                          <span className="text-indigo-400 mr-1">[BG]</span>
                        )}
                        <span style={{ color: a.color }}>{a.name}</span>
                        {a.currentThought && (
                          <>
                            <span className="text-slate-600 mx-1">·</span>
                            <span className="text-slate-400">
                              {a.currentThought.slice(0, 60)}
                              {a.currentThought.length > 60 ? "..." : ""}
                            </span>
                          </>
                        )}
                      </span>
                    </button>
                  ));
                })}
              </div>
            </div>
          </div>
        </main>

        {/* Collapsed dock strip when popout is open */}
        {popoutOpen && (
          <aside className="w-10 shrink-0 border-l border-slate-700 flex flex-col items-center bg-slate-900/95 py-3 gap-3">
            <button
              onClick={async () => {
                await popoutAPI?.close();
                setPopoutOpen(false);
              }}
              title="Close popout & restore panel"
              className="text-indigo-400 hover:text-indigo-300 cursor-pointer transition-colors"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="2" y="3" width="20" height="18" rx="2" />
                <line x1="15" y1="3" x2="15" y2="21" />
                <polyline points="9 10 12 13 9 16" />
              </svg>
            </button>
          </aside>
        )}
        {/* Right panel — always mounted to preserve ChatWindow streaming state.
            Hidden (zero-width + invisible) when popout is open so the components
            stay alive but don't occupy layout space. */}
        <aside
          className={`shrink-0 border-l border-slate-700 flex flex-col bg-slate-900/95 overflow-hidden ${popoutOpen ? "w-0 invisible" : "w-80"}`}
        >
          <PermissionsBanner workspace={workspaceDir} />
          <div className="border-b border-gray-800">
            {/* Row 1: global tabs — always visible */}
            <div className="flex">
              {(["chat", "workspace", "git", "terminal"] as const).map(
                (key) => {
                  const label =
                    key === "workspace"
                      ? "Files"
                      : key === "terminal"
                        ? "Term"
                        : key === "git"
                          ? "Git"
                          : "Chat";
                  return (
                    <button
                      key={key}
                      onClick={() => setRightPanel(key)}
                      className={`flex-1 py-2 text-[10px] font-pixel cursor-pointer leading-relaxed transition-colors ${rightPanel === key ? "text-white border-b-2 border-indigo-500 bg-gray-800" : "text-gray-500 hover:text-gray-300"}`}
                    >
                      {label}
                    </button>
                  );
                },
              )}
              {/* Popout button */}
              {popoutAPI && (
                <button
                  onClick={async () => {
                    await popoutAPI.open(selectedAgentId || undefined);
                    setPopoutOpen(true);
                  }}
                  title="Open panel in new window"
                  className="px-2 py-2 text-[10px] cursor-pointer transition-colors text-gray-500 hover:text-gray-300"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="15 3 21 3 21 9" />
                    <line x1="10" y1="14" x2="21" y2="3" />
                    <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
                  </svg>
                </button>
              )}
            </div>
            {/* Row 2: agent-contextual tabs — only when an agent is selected */}
            {selectedAgent && (
              <div className="flex items-center border-t border-gray-800/50">
                <span
                  className="text-[10px] font-pixel text-slate-400 pl-2 pr-1 py-1.5 shrink-0 truncate max-w-[40%]"
                  style={{ color: selectedAgent.color }}
                >
                  {selectedAgent.name}
                </span>
                {(["editor", "tasks"] as const).map((key) => {
                  const label = key === "editor" ? "Config" : "Tasks";
                  return (
                    <button
                      key={key}
                      onClick={() => setRightPanel(key)}
                      className={`flex-1 py-1.5 text-[10px] font-pixel leading-relaxed cursor-pointer transition-colors ${rightPanel === key ? "text-white border-b-2 border-indigo-500 bg-gray-800" : "text-gray-500 hover:text-gray-300"}`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div className="flex-1 overflow-hidden relative">
            {/* ChatWindow — always mounted to preserve streaming state; hidden when not active */}
            <div
              className={`absolute inset-0 ${rightPanel === "chat" ? "" : "invisible pointer-events-none"}`}
            >
              <ChatWindow
                agent={selectedAgent}
                agents={agents}
                skills={skills}
                onUpdateAgent={updateAgent}
                onAddAgent={handleAddDynamicAgent}
                agentTeamsEnabled={agentTeamsEnabled}
                autoApprovePermissions={autoApproveAll}
                onOrchestrationDone={handleOrchestrationDone}
                onPermissionNotification={handlePermissionNotification}
                debugMode={debugMode}
                backgroundTasks={backgroundTasks}
                onStartBackgroundTask={handleStartBackgroundTask}
                pendingMessage={pendingMessage}
                onPendingMessageConsumed={() => setPendingMessage(null)}
              />
            </div>
            {/* Editor and Tasks — conditionally rendered (no persistent state to preserve) */}
            {rightPanel === "editor" && selectedAgent && (
              <div className="absolute inset-0">
                <AgentEditor
                  agent={selectedAgent}
                  workspaceDir={workspaceDir || undefined}
                  onSave={handleSaveAgent}
                  onDelete={handleDeleteAgent}
                  onClose={() => setRightPanel("chat")}
                />
              </div>
            )}
            {rightPanel === "tasks" && (
              <div className="absolute inset-0">
                <AgentTasks agent={selectedAgent} onUpdateAgent={updateAgent} />
              </div>
            )}
            {/* Workspace panel — always mounted to preserve watcher; hidden when not active */}
            <div
              className={`absolute inset-0 ${rightPanel === "workspace" ? "" : "invisible pointer-events-none"}`}
            >
              <WorkspacePanel workspaceDir={workspaceDir} />
            </div>
            {/* Git panel — always mounted to preserve state; hidden when not active */}
            <div
              className={`absolute inset-0 ${rightPanel === "git" ? "" : "invisible pointer-events-none"}`}
            >
              <GitPanel workspaceDir={workspaceDir} />
            </div>
            {/* Terminal is always mounted to preserve shell session; hidden when not active */}
            <div
              className={`absolute inset-0 ${rightPanel === "terminal" ? "" : "invisible pointer-events-none"}`}
            >
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
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
          onClick={() => setShowPermsModal(false)}
        >
          <div
            className="bg-slate-800 border border-slate-600 rounded-lg w-[480px] max-h-[80vh] shadow-xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
              <h3 className="text-sm font-pixel text-white">
                🔒 Permissions & Config
              </h3>
              <button
                onClick={() => setShowPermsModal(false)}
                className="text-slate-400 hover:text-white text-sm cursor-pointer font-pixel uppercase"
              >
                X
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              <PermissionsPanel
                workspace={workspaceDir}
                onSaved={() => setPermsEmpty(false)}
              />
            </div>
          </div>
        </div>
      )}

      {showCostsModal && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
          onClick={() => setShowCostsModal(false)}
        >
          <div
            className="bg-slate-800 border border-slate-600 rounded-lg w-[480px] max-h-[80vh] shadow-xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
              <h3 className="text-sm font-pixel text-white">
                💰 Cost & Token Dashboard
              </h3>
              <button
                onClick={() => setShowCostsModal(false)}
                className="text-slate-400 hover:text-white text-sm cursor-pointer font-pixel uppercase"
              >
                X
              </button>
            </div>
            <div
              className="flex-1 overflow-y-auto"
              style={{ minHeight: "400px" }}
            >
              <CostDashboard agents={agents} />
            </div>
          </div>
        </div>
      )}

      {showChannelsModal && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
          onClick={() => setShowChannelsModal(false)}
        >
          <div
            className="bg-slate-800 border border-slate-600 rounded-lg w-[480px] max-h-[80vh] shadow-xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
              <h3 className="text-sm font-pixel text-white">
                💬 Messaging Channels
              </h3>
              <button
                onClick={() => setShowChannelsModal(false)}
                className="text-slate-400 hover:text-white text-sm cursor-pointer font-pixel uppercase"
              >
                X
              </button>
            </div>
            <div
              className="flex-1 overflow-y-auto"
              style={{ minHeight: "400px" }}
            >
              <ChannelsPanel />
            </div>
          </div>
        </div>
      )}

      {showTriggersModal && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
          onClick={() => setShowTriggersModal(false)}
        >
          <div
            className="bg-slate-800 border border-slate-600 rounded-lg w-[480px] max-h-[80vh] shadow-xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
              <h3 className="text-sm font-pixel text-white">⚡ Triggers</h3>
              <button
                onClick={() => setShowTriggersModal(false)}
                className="text-slate-400 hover:text-white text-sm cursor-pointer font-pixel uppercase"
              >
                X
              </button>
            </div>
            <div
              className="flex-1 overflow-y-auto"
              style={{ minHeight: "400px" }}
            >
              <TriggersPanel agents={agents} />
            </div>
          </div>
        </div>
      )}

      {showAssetsModal && (
        <AssetsModal onClose={() => setShowAssetsModal(false)} />
      )}

      {showOnboarding && startupDone && (
        <OnboardingModal
          onComplete={async () => {
            setSetting("outworked_onboarding_done", "1");
            // Seed browser & scheduler as default global skills on first launch
            const existing = await loadGlobalSkillIds();
            if (existing.length === 0) {
              await saveGlobalSkillIds([
                "bundled:browser",
                "bundled:scheduler",
              ]);
              window.dispatchEvent(new Event("global-skills-changed"));
            }
            setShowOnboarding(false);
          }}
          onOpenPerms={() => setShowPermsModal(true)}
          permsModalOpen={showPermsModal}
        />
      )}

      {permsEmpty && !permsDismissed && !showPermsModal && workspaceDir && (
        <div className="fixed bottom-4 left-4 z-40 bg-amber-900/95 border border-amber-600/60 rounded-lg p-3 shadow-lg max-w-xs animate-slide-up">
          <div className="flex items-start gap-2">
            <span className="text-amber-400 text-sm mt-0.5">⚠</span>
            <div className="flex-1">
              <p className="text-[11px] font-pixel text-amber-100">
                No permissions configured
              </p>
              <p className="text-[10px] text-amber-300/70 mt-0.5">
                Set up allow/deny rules so Claude Code knows what tools it can
                use.
              </p>
              <div className="flex gap-2 mt-2">
                <button
                  onClick={() => {
                    setShowPermsModal(true);
                    setPermsDismissed(true);
                  }}
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

function HirePromptModal({
  onSubmit,
  onCancel,
}: {
  onSubmit: (desc: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={onCancel}
    >
      <div
        className="bg-slate-800 border border-slate-600 rounded-lg p-5 w-[420px] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-pixel text-white mb-1">
          Hire New Employee
        </h3>
        <p className="text-[11px] text-slate-400 mb-3">
          Describe the role and AI will generate a full agent definition.
        </p>
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && value.trim()) onSubmit(value.trim());
            if (e.key === "Escape") onCancel();
          }}
          placeholder='e.g. "frontend React developer", "DevOps engineer"'
          className="w-full input-mono text-[12px] mb-3"
        />
        <div className="flex gap-2 justify-end">
          {/* <button onClick={onCancel} className="btn-pixel bg-slate-700 hover:bg-slate-600 text-[11px]">Skip</button> */}
          <button
            onClick={() => (value.trim() ? onSubmit(value.trim()) : onCancel())}
            className="btn-pixel bg-emerald-700 hover:bg-emerald-600 text-[11px]"
          >
            ✨ Generate
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Popout panel — pure mirror of the main window's right panel.
 * All state comes from props (pushed by main window). User actions
 * relay back to the main window via callbacks.
 */
function PopoutPanel({
  agents,
  selectedAgent,
  selectedAgentId,
  rightPanel,
  workspaceDir,
  skills,
  agentTeamsEnabled,
  autoApproveAll,
  debugMode,
  backgroundTasks,
  onSelectAgent,
  onSetRightPanel,
  onInterceptSend,
  onSaveAgent,
  onDeleteAgent,
}: {
  agents: Agent[];
  selectedAgent: Agent | null;
  selectedAgentId: string | null;
  rightPanel: RightPanel;
  workspaceDir: string | null;
  skills: AgentSkill[];
  agentTeamsEnabled: boolean;
  autoApproveAll: boolean;
  debugMode: boolean;
  backgroundTasks: BackgroundTask[];
  onSelectAgent: (id: string) => void;
  onSetRightPanel: (panel: RightPanel) => void;
  onInterceptSend: (text: string, options?: { background?: boolean }) => void;
  onSaveAgent: (agent: Agent) => void;
  onDeleteAgent: (agentId: string) => void;
}) {
  return (
    <div className="flex flex-col h-screen bg-slate-950 text-slate-100 overflow-hidden">
      {/* Agent selector bar */}
      <div className="shrink-0 border-b border-slate-700 bg-slate-900/95 px-3 py-1.5 flex items-center gap-2">
        <span className="text-[10px] font-pixel text-slate-500 shrink-0">
          Agent:
        </span>
        <div className="flex gap-1 overflow-x-auto flex-1">
          {agents.map((a) => (
            <button
              key={a.id}
              onClick={() => onSelectAgent(a.id)}
              className={`px-2 py-1 rounded text-[10px] font-pixel cursor-pointer transition-colors shrink-0 ${
                selectedAgentId === a.id
                  ? "bg-slate-700 text-white"
                  : "text-slate-400 hover:text-slate-200 hover:bg-slate-800"
              }`}
              style={
                selectedAgentId === a.id
                  ? { borderBottom: `2px solid ${a.color}` }
                  : undefined
              }
            >
              <span style={{ color: a.color }}>{a.name}</span>
              {a.status !== "idle" && (
                <span
                  className="ml-1 inline-block w-1.5 h-1.5 rounded-full animate-pulse"
                  style={{ backgroundColor: a.color }}
                />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Tab bar */}
      <div className="border-b border-gray-800 shrink-0">
        <div className="flex">
          {(["chat", "workspace", "git", "terminal"] as const).map((key) => {
            const label =
              key === "workspace"
                ? "Files"
                : key === "terminal"
                  ? "Term"
                  : key === "git"
                    ? "Git"
                    : "Chat";
            return (
              <button
                key={key}
                onClick={() => onSetRightPanel(key)}
                className={`flex-1 py-2 text-[10px] font-pixel cursor-pointer leading-relaxed transition-colors ${rightPanel === key ? "text-white border-b-2 border-indigo-500 bg-gray-800" : "text-gray-500 hover:text-gray-300"}`}
              >
                {label}
              </button>
            );
          })}
        </div>
        {selectedAgent && (
          <div className="flex items-center border-t border-gray-800/50">
            <span
              className="text-[10px] font-pixel text-slate-400 pl-2 pr-1 py-1.5 shrink-0 truncate max-w-[40%]"
              style={{ color: selectedAgent.color }}
            >
              {selectedAgent.name}
            </span>
            {(["editor", "tasks"] as const).map((key) => {
              const label = key === "editor" ? "Config" : "Tasks";
              return (
                <button
                  key={key}
                  onClick={() => onSetRightPanel(key)}
                  className={`flex-1 py-1.5 text-[10px] font-pixel leading-relaxed cursor-pointer transition-colors ${rightPanel === key ? "text-white border-b-2 border-indigo-500 bg-gray-800" : "text-gray-500 hover:text-gray-300"}`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Panel content */}
      <div className="flex-1 overflow-hidden relative">
        {/* ChatWindow — real component with send intercepted */}
        <div
          className={`absolute inset-0 ${rightPanel === "chat" ? "" : "invisible pointer-events-none"}`}
        >
          <ChatWindow
            agent={selectedAgent}
            agents={agents}
            skills={skills}
            onUpdateAgent={() => {}}
            onAddAgent={() => {}}
            agentTeamsEnabled={agentTeamsEnabled}
            autoApprovePermissions={autoApproveAll}
            debugMode={debugMode}
            backgroundTasks={backgroundTasks}
            onStartBackgroundTask={() => {}}
            onInterceptSend={onInterceptSend}
          />
        </div>
        {/* Workspace */}
        <div
          className={`absolute inset-0 ${rightPanel === "workspace" ? "" : "invisible pointer-events-none"}`}
        >
          <WorkspacePanel workspaceDir={workspaceDir} />
        </div>
        {/* Git */}
        <div
          className={`absolute inset-0 ${rightPanel === "git" ? "" : "invisible pointer-events-none"}`}
        >
          <GitPanel workspaceDir={workspaceDir} />
        </div>
        {/* Terminal */}
        <div
          className={`absolute inset-0 ${rightPanel === "terminal" ? "" : "invisible pointer-events-none"}`}
        >
          <TerminalPanel agents={agents} workspaceDir={workspaceDir} />
        </div>
        {/* Editor */}
        {rightPanel === "editor" && selectedAgent && (
          <div className="absolute inset-0">
            <AgentEditor
              agent={selectedAgent}
              workspaceDir={workspaceDir || undefined}
              onSave={onSaveAgent}
              onDelete={onDeleteAgent}
              onClose={() => onSetRightPanel("chat")}
            />
          </div>
        )}
        {/* Tasks — read-only */}
        {rightPanel === "tasks" && (
          <div className="absolute inset-0">
            <AgentTasks agent={selectedAgent} onUpdateAgent={() => {}} />
          </div>
        )}
      </div>
    </div>
  );
}
