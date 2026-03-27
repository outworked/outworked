import { useState, useEffect, useCallback } from "react";
import {
  ClaudeCodeAuthStatus,
  getClaudeCodeAuthStatus,
  isElectron,
  readClaudeSettings,
  writeClaudeSettings,
} from "../lib/terminal";
import { getSetting, setSetting } from "../lib/settings";
import { loadGlobalSkillIds, saveGlobalSkillIds } from "../lib/storage";
import { AgentSkill, McpServerInline, SubagentDef } from "../lib/types";
import { fetchSkill } from "../lib/bundled-skills";
import McpServersModal from "./McpServersModal";
import SkillsModal from "./SkillsModal";

// Global session defaults — used when an agent's SubagentDef doesn't specify these.
export interface GlobalSessionDefaults {
  model: string;
  thinking: "adaptive" | "enabled" | "disabled";
  thinkingBudget: number;
  effort: "" | "low" | "medium" | "high" | "max";
}

const SETTINGS_KEYS = {
  model: "outworked_default_model",
  thinking: "outworked_default_thinking",
  thinkingBudget: "outworked_default_thinking_budget",
  effort: "outworked_default_effort",
} as const;

export async function loadGlobalDefaults(): Promise<GlobalSessionDefaults> {
  const [model, thinking, thinkingBudget, effort] = await Promise.all([
    getSetting(SETTINGS_KEYS.model),
    getSetting(SETTINGS_KEYS.thinking),
    getSetting(SETTINGS_KEYS.thinkingBudget),
    getSetting(SETTINGS_KEYS.effort),
  ]);
  return {
    model: model || "",
    thinking: (thinking as GlobalSessionDefaults["thinking"]) || "adaptive",
    thinkingBudget: thinkingBudget ? parseInt(thinkingBudget) : 0,
    effort: (effort as GlobalSessionDefaults["effort"]) || "",
  };
}

// Convert settings.json Record format to McpServersModal array format
type McpEntry = string | Record<string, McpServerInline>;
function settingsToMcpArray(
  record: Record<string, Record<string, unknown>> | undefined,
): McpEntry[] {
  if (!record) return [];
  return Object.entries(record).map(([name, cfg]) => ({
    [name]: cfg as unknown as McpServerInline,
  }));
}

// Convert McpServersModal array format to settings.json Record format
function mcpArrayToSettings(
  arr: SubagentDef["mcpServers"],
): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  for (const entry of arr || []) {
    if (typeof entry === "string") {
      result[entry] = {};
    } else {
      for (const [name, cfg] of Object.entries(entry)) {
        result[name] = cfg as unknown as Record<string, unknown>;
      }
    }
  }
  return result;
}

export default function ClaudeCodeStatus() {
  const [status, setStatus] = useState<ClaudeCodeAuthStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [defaults, setDefaults] = useState<GlobalSessionDefaults>({
    model: "",
    thinking: "adaptive",
    thinkingBudget: 0,
    effort: "",
  });

  // Global MCP servers (synced with ~/.claude/settings.json)
  const [showMcpModal, setShowMcpModal] = useState(false);
  const [globalMcpServers, setGlobalMcpServers] = useState<McpEntry[]>([]);

  // Global skills (stored in app_settings)
  const [showSkillsModal, setShowSkillsModal] = useState(false);
  const [globalSkills, setGlobalSkills] = useState<AgentSkill[]>([]);

  const checkStatus = useCallback(async () => {
    setChecking(true);
    try {
      const result = await getClaudeCodeAuthStatus();
      setStatus(result);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (isElectron()) {
      checkStatus();
      loadGlobalDefaults().then(setDefaults);
      // Load global MCP servers from ~/.claude/settings.json
      readClaudeSettings("global").then(({ settings }) => {
        setGlobalMcpServers(settingsToMcpArray(settings.mcpServers));
      });
      // Load global skills from app_settings
      loadGlobalSkillIds().then(async (ids) => {
        const skills = (
          await Promise.all(ids.map((id) => fetchSkill(id)))
        ).filter((s): s is AgentSkill => s !== undefined);
        setGlobalSkills(skills);
      });
    } else {
      setStatus({
        installed: false,
        version: null,
        authenticated: false,
        accountInfo: null,
        error: "Not running in Electron",
      });
    }
  }, [checkStatus]);

  function updateDefault<K extends keyof GlobalSessionDefaults>(
    key: K,
    value: GlobalSessionDefaults[K],
  ) {
    setDefaults((prev) => ({ ...prev, [key]: value }));
    setSetting(SETTINGS_KEYS[key], String(value));
  }

  const statusLabel =
    checking && !status
      ? "Checking Claude Code…"
      : checking
        ? "Rechecking…"
        : !status?.installed
          ? "Claude Code not found"
          : !status?.authenticated
            ? "Claude Code needs login"
            : `Claude Code OK`.trim();

  return (
    <div className=" border-b border-gray-800">
      {/* Compact status bar — click to open settings modal */}
      <button
        onClick={() => setShowModal(true)}
        className="w-full h-full px-2 py-1.5 flex items-center gap-1.5 text-left hover:bg-slate-800/50 transition-colors"
      >
        <StatusDot status={status} checking={checking} />
        <span className="flex-1 text-[10px] font-pixel text-slate-300 truncate">
          {statusLabel}
        </span>
        <svg className="w-3.5 h-3.5 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
        </svg>
      </button>

      {/* Settings modal */}
      {showModal && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50"
          onClick={() => setShowModal(false)}
        >
          <div
            className="bg-slate-900 border border-slate-600 rounded-lg w-[420px] max-h-[80vh] flex flex-col shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
              <h2 className="text-xs font-pixel text-white">Settings</h2>
              <button
                onClick={() => setShowModal(false)}
                className="text-slate-400 hover:text-white text-xs font-pixel px-1"
              >
                X
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
              {/* Claude Code Status */}
              <section className="space-y-2">
                <p className="text-[9px] font-pixel text-slate-500 uppercase tracking-wider">
                  Claude Code
                </p>
                <Row
                  ok={!!status?.installed}
                  label="CLI installed"
                  detail={status?.version ?? "not found"}
                />
                <Row
                  ok={!!status?.authenticated}
                  label="Authenticated"
                  detail={
                    status?.authenticated
                      ? (status?.accountInfo ?? "logged in")
                      : (status?.error ?? "not logged in")
                  }
                />

                {status?.installed && status?.authenticated && (
                  <div className="text-[9px] font-pixel text-emerald-400/80">
                    Agents auto-sync from ~/.claude/agents/
                  </div>
                )}

                {!status?.installed && (
                  <HelpBox>
                    Install with:{" "}
                    <code className="bg-slate-700 px-1 rounded text-[10px]">
                      curl -fsSL https://claude.ai/install.sh | bash
                    </code>
                  </HelpBox>
                )}

                {status?.installed && !status?.authenticated && (
                  <HelpBox>
                    Run in your terminal:{" "}
                    <code className="bg-slate-700 px-1 rounded text-[10px]">
                      claude login
                    </code>
                  </HelpBox>
                )}

                <button
                  onClick={checkStatus}
                  disabled={checking}
                  className="w-full py-1 text-[10px] font-pixel rounded bg-slate-700 hover:bg-slate-600 text-slate-200 disabled:opacity-50 transition-colors"
                >
                  {checking ? "Checking…" : "Recheck"}
                </button>
              </section>

              {/* Session defaults */}
              {status?.installed && status?.authenticated && (
                <section className="space-y-1.5">
                  <p className="text-[9px] font-pixel text-slate-500 uppercase tracking-wider">
                    Session Defaults
                  </p>
                  <SettingSelect
                    label="Model"
                    value={defaults.model}
                    onChange={(v) => updateDefault("model", v)}
                    options={[
                      ["", "Default"],
                      ["sonnet", "Sonnet"],
                      ["opus", "Opus"],
                      ["haiku", "Haiku"],
                    ]}
                  />
                  <SettingSelect
                    label="Thinking"
                    value={defaults.thinking}
                    onChange={(v) =>
                      updateDefault(
                        "thinking",
                        v as GlobalSessionDefaults["thinking"],
                      )
                    }
                    options={[
                      ["adaptive", "Adaptive"],
                      ["enabled", "Enabled"],
                      ["disabled", "Disabled"],
                    ]}
                  />
                  {defaults.thinking === "enabled" && (
                    <div className="flex items-center gap-1.5">
                      <span className="text-[9px] text-slate-500 shrink-0 w-16">
                        Budget
                      </span>
                      <input
                        type="number"
                        value={defaults.thinkingBudget || ""}
                        onChange={(e) =>
                          updateDefault(
                            "thinkingBudget",
                            e.target.value ? parseInt(e.target.value) : 0,
                          )
                        }
                        placeholder="default"
                        step={1024}
                        min={0}
                        className="flex-1 px-1.5 py-0.5 text-[10px] bg-slate-800 border border-slate-700 rounded text-white font-mono"
                      />
                    </div>
                  )}
                  <SettingSelect
                    label="Effort"
                    value={defaults.effort}
                    onChange={(v) =>
                      updateDefault(
                        "effort",
                        v as GlobalSessionDefaults["effort"],
                      )
                    }
                    options={[
                      ["", "Default (high)"],
                      ["low", "Low"],
                      ["medium", "Medium"],
                      ["high", "High"],
                      ["max", "Max"],
                    ]}
                  />
                </section>
              )}

              {/* Global MCP & Skills */}
              {status?.installed && status?.authenticated && (
                <section className="space-y-1.5">
                  <p className="text-[9px] font-pixel text-slate-500 uppercase tracking-wider">
                    Global Defaults
                  </p>
                  <p className="text-[9px] text-slate-600">
                    Available to all agents unless excluded per-agent.
                  </p>
                  <button
                    onClick={() => setShowMcpModal(true)}
                    className="w-full flex items-center justify-between py-2 px-2.5 text-[10px] font-pixel text-slate-300 hover:text-slate-100 border border-slate-700 hover:border-slate-500 rounded transition-colors"
                  >
                    <span>MCP Servers</span>
                    <span className="text-[9px] text-slate-500">
                      {globalMcpServers.length > 0
                        ? `${globalMcpServers.length} configured`
                        : "none"}
                    </span>
                  </button>
                  <button
                    onClick={() => setShowSkillsModal(true)}
                    className="w-full flex items-center justify-between py-2 px-2.5 text-[10px] font-pixel text-slate-300 hover:text-slate-100 border border-slate-700 hover:border-slate-500 rounded transition-colors"
                  >
                    <span>Skills</span>
                    <span className="text-[9px] text-slate-500">
                      {globalSkills.length > 0
                        ? `${globalSkills.length} enabled`
                        : "none"}
                    </span>
                  </button>
                </section>
              )}
            </div>

            {/* Footer */}
            <div className="px-4 py-3 border-t border-slate-700">
              <button
                onClick={() => setShowModal(false)}
                className="w-full btn-pixel bg-slate-700 hover:bg-slate-600 text-[11px]"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Global MCP Servers Modal */}
      {showMcpModal && (
        <McpServersModal
          mcpServers={globalMcpServers}
          onUpdate={async (servers) => {
            setGlobalMcpServers(servers || []);
            // Write to ~/.claude/settings.json
            const { settings } = await readClaudeSettings("global");
            settings.mcpServers = mcpArrayToSettings(servers);
            await writeClaudeSettings("global", settings);
          }}
          onClose={() => setShowMcpModal(false)}
        />
      )}

      {/* Global Skills Modal */}
      {showSkillsModal && (
        <SkillsModal
          agentSkills={globalSkills}
          onUpdate={async (skills) => {
            setGlobalSkills(skills);
            await saveGlobalSkillIds(skills.map((s) => s.id));
          }}
          onClose={() => setShowSkillsModal(false)}
        />
      )}
    </div>
  );
}

function StatusDot({
  status,
  checking,
}: {
  status: ClaudeCodeAuthStatus | null;
  checking: boolean;
}) {
  let color = "#6b7280"; // gray default
  if (checking)
    color = "#f59e0b"; // amber
  else if (status?.installed && status?.authenticated)
    color = "#22c55e"; // green
  else if (status?.installed)
    color = "#f59e0b"; // amber — installed but not authed
  else color = "#ef4444"; // red — not installed

  return (
    <div
      className={`w-2 h-2 rounded-full shrink-0 ${checking ? "animate-pulse" : ""}`}
      style={{ backgroundColor: color }}
    />
  );
}

function Row({
  ok,
  label,
  detail,
}: {
  ok: boolean;
  label: string;
  detail: string;
}) {
  return (
    <div className="flex items-start gap-1.5">
      <span className="text-[10px] mt-px">{ok ? "✅" : "❌"}</span>
      <div className="min-w-0">
        <span className="text-[10px] font-pixel text-slate-300">{label}</span>
        <p className="text-[10px] font-mono text-slate-400 truncate">
          {detail}
        </p>
      </div>
    </div>
  );
}

function HelpBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-amber-900/30 border border-amber-700/40 rounded p-1.5">
      <p className="text-[10px] font-mono text-amber-300 break-words">
        {children}
      </p>
    </div>
  );
}

function SettingSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: [string, string][];
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[9px] text-slate-500 shrink-0 w-16">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 px-1.5 py-0.5 text-[10px] bg-slate-800 border border-slate-700 rounded text-white"
      >
        {options.map(([val, label]) => (
          <option key={val} value={val}>
            {label}
          </option>
        ))}
      </select>
    </div>
  );
}
