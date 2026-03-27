import { useEffect, useRef, useState } from "react";
import { Agent, AgentSkill, McpServerInline, SPRITE_KEYS, AGENT_COLORS, SubagentDef } from "../lib/types";
import {
  writeClaudeAgentFile,
  deleteClaudeAgentFile,
  getHomedir,
  readClaudeSettings,
} from "../lib/terminal";
import {
  buildSubagentMd,
  generateAgentWithAI,
  loadGlobalSkillIds,
  parseSubagentFrontmatter,
} from "../lib/storage";
import { fetchSkill } from "../lib/bundled-skills";
import SkillsModal from "./SkillsModal";
import McpServersModal from "./McpServersModal";

// ─── Main component ──────────────────────────────────────────────

interface AgentEditorProps {
  agent: Agent;
  workspaceDir?: string;
  onSave: (agent: Agent) => void;
  onDelete: (agentId: string) => void;
  onClose: () => void;
}

export default function AgentEditor({
  agent,
  workspaceDir,
  onSave,
  onDelete,
  onClose,
}: AgentEditorProps) {
  const [draft, setDraft] = useState<Agent>({ ...agent });
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generatePrompt, setGeneratePrompt] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showSkillsModal, setShowSkillsModal] = useState(false);
  const [showMcpModal, setShowMcpModal] = useState(false);
  const [globalSkills, setGlobalSkills] = useState<AgentSkill[]>([]);
  const [globalMcpNames, setGlobalMcpNames] = useState<Set<string>>(new Set());

  // Load global skills and MCP servers
  useEffect(() => {
    loadGlobalSkillIds().then(async (ids) => {
      if (ids.length === 0) return;
      const skills = (await Promise.all(ids.map((id) => fetchSkill(id)))).filter(
        (s): s is AgentSkill => s !== undefined,
      );
      setGlobalSkills(skills);
    });
    readClaudeSettings("global").then(({ settings }) => {
      const names = Object.keys(settings.mcpServers || {});
      if (names.length > 0) setGlobalMcpNames(new Set(names));
    });
  }, []);

  // Sync draft when the agent prop's persistent fields change externally
  const prevAgentRef = useRef(agent);
  useEffect(() => {
    const prev = prevAgentRef.current;
    if (
      prev.name !== agent.name ||
      prev.role !== agent.role ||
      prev.personality !== agent.personality ||
      prev.subagentFile !== agent.subagentFile ||
      prev.subagentDef !== agent.subagentDef ||
      prev.agentScope !== agent.agentScope
    ) {
      setDraft({ ...agent });
      prevAgentRef.current = agent;
    }
  }, [agent]);

  function update<K extends keyof Agent>(key: K, value: Agent[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function updateDef(partial: Partial<SubagentDef>) {
    setDraft((prev) => ({
      ...prev,
      subagentDef: { ...(prev.subagentDef || { description: "" }), ...partial },
    }));
  }

  async function saveToFile(defOverride?: SubagentDef) {
    const defToSave = defOverride || draft.subagentDef;
    if (!draft.subagentFile || !defToSave) return;
    setSaving(true);
    try {
      const slug =
        draft.subagentFile.split("/").pop()?.replace(/\.md$/, "") || draft.name;
      const content = buildSubagentMd(
        { ...draft, subagentDef: defToSave },
        slug,
      );
      const scope = draft.agentScope || "user";
      let targetPath: string;
      if (scope === "project" && workspaceDir) {
        targetPath = `${workspaceDir}/.claude/agents/${slug}.md`;
      } else {
        targetPath = `${getHomedir()}/.claude/agents/${slug}.md`;
      }
      await writeClaudeAgentFile(targetPath, content);
      if (targetPath !== draft.subagentFile) {
        await deleteClaudeAgentFile(draft.subagentFile);
        setDraft((prev) => ({ ...prev, subagentFile: targetPath }));
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleGenerate(description: string) {
    setGenerating(true);
    setGeneratePrompt(null);
    try {
      const result = await generateAgentWithAI(description, {
        name: draft.name !== "New Employee" ? draft.name : undefined,
        scope: draft.agentScope || "user",
        workspaceDir: workspaceDir || undefined,
      });
      if (result) {
        const parsed = parseSubagentFrontmatter(result.content);
        const name =
          parsed.def["outworked-name"] || parsed.def.name || draft.name;
        const role =
          parsed.def["outworked-role"] || parsed.def.description || draft.role;
        if (draft.subagentFile && result.filePath !== draft.subagentFile) {
          await deleteClaudeAgentFile(draft.subagentFile);
        }
        setDraft((prev) => ({
          ...prev,
          name,
          role,
          personality: parsed.body || prev.personality,
          subagentFile: result.filePath,
          subagentDef: { description: role, ...parsed.def } as SubagentDef,
        }));
      }
    } finally {
      setGenerating(false);
    }
  }

  const def = draft.subagentDef || { description: "" };

  return (
    <div className="flex flex-col h-full bg-slate-900 text-white">
      {/* Header */}
      <div
        className="flex items-center gap-2 px-4 py-3 border-b border-slate-600"
        style={{ borderLeftColor: draft.color, borderLeftWidth: 3 }}
      >
        <div className="flex-1 min-w-0">
          <h2 className="text-xs font-pixel text-white truncate">
            Edit: {draft.name}
          </h2>
          <p
            className="text-[11px] font-pixel mt-0.5"
            style={{ color: draft.color }}
          >
            {draft.role}
          </p>
        </div>
        <button
          onClick={onClose}
          className="text-slate-300 hover:text-white text-xs font-pixel transition-colors px-1"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {/* ── AI Generate ──────────────────────────────────── */}
        {generatePrompt !== null ? (
          <div className="bg-emerald-900/30 border border-emerald-700/50 rounded p-2 space-y-2">
            <label className="text-[10px] font-pixel text-emerald-300 block">
              Describe what this agent should do:
            </label>
            <input
              autoFocus
              value={generatePrompt}
              onChange={(e) => setGeneratePrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && generatePrompt.trim())
                  handleGenerate(generatePrompt.trim());
                if (e.key === "Escape") setGeneratePrompt(null);
              }}
              placeholder='e.g. "frontend React developer"'
              className="w-full input-mono text-[10px]"
            />
            <div className="flex gap-2">
              <button
                onClick={() => setGeneratePrompt(null)}
                className="flex-1 btn-pixel bg-slate-700 hover:bg-slate-600 text-[10px]"
              >
                Cancel
              </button>
              <button
                onClick={() =>
                  generatePrompt.trim() && handleGenerate(generatePrompt.trim())
                }
                className="flex-1 btn-pixel bg-emerald-700 hover:bg-emerald-600 text-[10px]"
              >
                Generate
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() =>
              setGeneratePrompt(draft.role || def.description || "")
            }
            disabled={saving || generating}
            className="w-full btn-pixel bg-emerald-700 hover:bg-emerald-600 text-[10px] disabled:opacity-50"
          >
            {generating ? "Generating..." : "✨ Generate with AI"}
          </button>
        )}

        {/* ── Core Fields ──────────────────────────────────── */}
        <Field label="Name">
          <input
            value={draft.name}
            onChange={(e) => update("name", e.target.value)}
            className="input-mono"
          />
        </Field>

        <Field label="Role">
          <input
            value={draft.role}
            onChange={(e) => {
              update("role", e.target.value);
              updateDef({ description: e.target.value });
            }}
            className="input-mono"
            placeholder="e.g. Frontend Developer"
          />
        </Field>

        <Field label="System Prompt">
          <textarea
            value={draft.personality}
            onChange={(e) => update("personality", e.target.value)}
            rows={5}
            className="input-mono resize-none"
            disabled={draft.isBoss}
            placeholder="Instructions for this agent..."
          />
        </Field>

        <Field label="Scope">
          <div className="flex gap-2">
            {(["user", "project"] as const).map((s) => (
              <button
                key={s}
                onClick={() => update("agentScope" as keyof Agent, s as any)}
                className={`flex-1 py-1.5 text-[10px] font-pixel rounded border transition-colors ${
                  (draft.agentScope || "user") === s
                    ? s === "project"
                      ? "border-cyan-600 bg-cyan-900/40 text-cyan-200"
                      : "border-amber-600 bg-amber-900/40 text-amber-200"
                    : "border-slate-700 bg-slate-800/50 text-slate-400 hover:text-slate-300"
                }`}
              >
                {s === "user" ? "User (~/.claude/)" : "Project (.claude/)"}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Model">
          <select
            value={def.model || "inherit"}
            onChange={(e) => {
              const newModel =
                e.target.value === "inherit" ? undefined : e.target.value;
              updateDef({ model: newModel });
              saveToFile({ ...def, model: newModel });
            }}
            className="input-mono"
          >
            <option value="inherit">inherit (parent model)</option>
            <option value="sonnet">sonnet</option>
            <option value="opus">opus</option>
            <option value="haiku">haiku</option>
          </select>
        </Field>

        <Field label="Appearance">
          <div className="flex gap-2 flex-wrap">
            {SPRITE_KEYS.map((key, i) => (
              <button
                key={key}
                onClick={() =>
                  setDraft((prev) => ({
                    ...prev,
                    spriteKey: key,
                    color: AGENT_COLORS[i],
                  }))
                }
                className={`w-6 h-6 rounded border-2 transition-all ${draft.spriteKey === key ? "scale-125" : "opacity-60 hover:opacity-100"}`}
                style={{
                  backgroundColor: AGENT_COLORS[i],
                  borderColor: draft.spriteKey === key ? "#fff" : "transparent",
                }}
              />
            ))}
          </div>
        </Field>

        {/* ── Skills (compact) ─────────────────────────────── */}
        <Field label="Skills">
          {(() => {
            const excludeSet = new Set(draft.subagentDef?.excludeGlobalSkills || []);
            const inheritedSkills = globalSkills.filter((s) => !excludeSet.has(s.id));
            const inheritedIds = new Set(inheritedSkills.map((s) => s.id));
            const allBadges = [
              ...inheritedSkills.map((s) => ({ ...s, inherited: true })),
              ...draft.skills
                .filter((s) => !inheritedIds.has(s.id))
                .map((s) => ({ ...s, inherited: false })),
            ];
            return (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {allBadges.length === 0 && (
                    <span className="text-[10px] font-pixel text-slate-500">
                      No skills assigned
                    </span>
                  )}
                  {allBadges.map((s) => (
                    <span
                      key={s.id}
                      className={`text-[10px] font-pixel px-2 py-0.5 rounded border ${
                        s.inherited
                          ? "bg-slate-800/40 text-slate-400 border-slate-600/50"
                          : "bg-indigo-900/40 text-indigo-300 border-indigo-700/50"
                      }`}
                    >
                      {s.name}
                      {s.inherited && (
                        <span className="text-[8px] text-slate-500 ml-1">
                          (global)
                        </span>
                      )}
                    </span>
                  ))}
                </div>
                <button
                  onClick={() => setShowSkillsModal(true)}
                  className="mt-1.5 w-full py-1.5 text-[10px] font-pixel text-slate-400 hover:text-slate-200 border border-dashed border-slate-700 hover:border-slate-500 rounded transition-colors"
                >
                  Manage Skills...
                </button>
              </>
            );
          })()}
        </Field>

        {/* ── MCP Servers ──────────────────────────────────── */}
        <Field label="MCP Servers">
          {(() => {
            const agentServerNames = new Set(
              (def.mcpServers || []).map((e) =>
                typeof e === "string" ? e : Object.keys(e)[0] || "",
              ),
            );
            const allBadges = [
              // Global servers not also defined per-agent
              ...[...globalMcpNames]
                .filter((n) => !agentServerNames.has(n))
                .map((n) => ({ name: n, isGlobal: true })),
              // Per-agent servers
              ...(def.mcpServers || []).map((entry) => ({
                name:
                  typeof entry === "string"
                    ? entry
                    : Object.keys(entry)[0] || "?",
                isGlobal: false,
              })),
            ];
            return (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {allBadges.length === 0 && (
                    <span className="text-[10px] font-pixel text-slate-500">
                      No servers configured
                    </span>
                  )}
                  {allBadges.map((s) => (
                    <span
                      key={s.name}
                      className={`text-[10px] font-pixel px-2 py-0.5 rounded border ${
                        s.isGlobal
                          ? "bg-slate-800/40 text-slate-400 border-slate-600/50"
                          : "bg-purple-900/40 text-purple-300 border-purple-700/50"
                      }`}
                    >
                      {s.name}
                      {s.isGlobal && (
                        <span className="text-[8px] text-slate-500 ml-1">
                          (global)
                        </span>
                      )}
                    </span>
                  ))}
                </div>
                <button
                  onClick={() => setShowMcpModal(true)}
                  className="mt-1.5 w-full py-1.5 text-[10px] font-pixel text-slate-400 hover:text-slate-200 border border-dashed border-slate-700 hover:border-slate-500 rounded transition-colors"
                >
                  Manage MCP Servers...
                </button>
              </>
            );
          })()}
        </Field>

        {/* ── Advanced ─────────────────────────────────────── */}
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="w-full flex items-center justify-between py-2 text-[10px] font-pixel text-slate-400 hover:text-slate-200 transition-colors"
        >
          <span>Advanced Settings</span>
          <span className="text-[12px]">{showAdvanced ? "▾" : "▸"}</span>
        </button>

        {showAdvanced && (
          <div className="space-y-3 border-l-2 border-slate-700 pl-3">
            <Field label="Allowed Tools (comma-separated)">
              <ToolsInput
                value={def.tools}
                onChange={(tools) => updateDef({ tools })}
                placeholder="Read, Write, Bash, Glob, Grep, Agent(worker)..."
              />
            </Field>

            <Field label="Disallowed Tools (comma-separated)">
              <ToolsInput
                value={def.disallowedTools}
                onChange={(disallowedTools) => updateDef({ disallowedTools })}
                placeholder="Write, Edit..."
              />
            </Field>

            <Field label="Max Turns">
              <input
                type="number"
                value={def.maxTurns ?? ""}
                onChange={(e) =>
                  updateDef({
                    maxTurns: e.target.value
                      ? parseInt(e.target.value)
                      : undefined,
                  })
                }
                placeholder="default"
                className="input-mono"
                min={1}
              />
            </Field>

            <Field label="Thinking">
              <select
                value={def.thinking || "adaptive"}
                onChange={(e) => {
                  const val = e.target.value === "adaptive" ? undefined : e.target.value;
                  updateDef({ thinking: val as SubagentDef["thinking"] });
                  saveToFile({ ...def, thinking: val as SubagentDef["thinking"] });
                }}
                className="input-mono"
              >
                <option value="adaptive">adaptive (auto)</option>
                <option value="enabled">enabled (fixed budget)</option>
                <option value="disabled">disabled</option>
              </select>
            </Field>

            {def.thinking === "enabled" && (
              <Field label="Thinking Budget (tokens)">
                <input
                  type="number"
                  value={def.thinkingBudget ?? ""}
                  onChange={(e) => {
                    const val = e.target.value ? parseInt(e.target.value) : undefined;
                    updateDef({ thinkingBudget: val });
                    saveToFile({ ...def, thinkingBudget: val });
                  }}
                  placeholder="default"
                  className="input-mono"
                  min={1024}
                  step={1024}
                />
              </Field>
            )}

            <Field label="Effort">
              <select
                value={def.effort || "default"}
                onChange={(e) => {
                  const val = e.target.value === "default" ? undefined : e.target.value;
                  updateDef({ effort: val as SubagentDef["effort"] });
                  saveToFile({ ...def, effort: val as SubagentDef["effort"] });
                }}
                className="input-mono"
              >
                <option value="default">default (high)</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
                <option value="max">max</option>
              </select>
            </Field>

            <Field label="Permission Mode">
              <select
                value={def.permissionMode || "default"}
                onChange={(e) =>
                  updateDef({
                    permissionMode:
                      e.target.value === "default" ? undefined : e.target.value,
                  })
                }
                className="input-mono"
              >
                <option value="default">default</option>
                <option value="acceptEdits">acceptEdits</option>
                <option value="dontAsk">dontAsk</option>
                <option value="bypassPermissions">bypassPermissions</option>
                <option value="plan">plan (read-only)</option>
              </select>
            </Field>

            <Field label="Memory">
              <select
                value={def.memory || "none"}
                onChange={(e) =>
                  updateDef({
                    memory:
                      e.target.value === "none"
                        ? undefined
                        : (e.target.value as SubagentDef["memory"]),
                  })
                }
                className="input-mono"
              >
                <option value="none">none</option>
                <option value="user">user (cross-project)</option>
                <option value="project">project (shared via VCS)</option>
                <option value="local">local (project, not in VCS)</option>
              </select>
            </Field>

            <Field label="Isolation">
              <select
                value={def.isolation || "none"}
                onChange={(e) =>
                  updateDef({
                    isolation:
                      e.target.value === "none"
                        ? undefined
                        : (e.target.value as "worktree"),
                  })
                }
                className="input-mono"
              >
                <option value="none">none</option>
                <option value="worktree">worktree (git worktree)</option>
              </select>
            </Field>

            <Field label="">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={def.background || false}
                  onChange={(e) =>
                    updateDef({ background: e.target.checked || undefined })
                  }
                  className="accent-purple-500"
                />
                <span className="text-[11px] font-pixel text-slate-300">
                  Run as background task
                </span>
              </label>
            </Field>

            <Field label="Hooks (JSON)">
              <HooksField def={def} updateDef={updateDef} />
            </Field>

            {/* History */}
            <HistorySection draft={draft} setDraft={setDraft} />
          </div>
        )}

        {/* Subagent file info */}
        {draft.subagentFile && (
          <div className="bg-slate-800/50 border border-slate-700/50 rounded p-2">
            <p className="text-[9px] font-mono text-slate-500 truncate">
              {draft.subagentFile}
            </p>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-slate-600 flex gap-2">
        <button
          onClick={async () => {
            onSave(draft);
            if (draft.subagentFile && draft.subagentDef) {
              const slug =
                draft.subagentFile.split("/").pop()?.replace(/\.md$/, "") ||
                draft.name;
              const content = buildSubagentMd(draft, slug);
              const scope = draft.agentScope || "user";
              const targetPath =
                scope === "project" && workspaceDir
                  ? `${workspaceDir}/.claude/agents/${slug}.md`
                  : `${getHomedir()}/.claude/agents/${slug}.md`;
              await writeClaudeAgentFile(targetPath, content);
              if (targetPath !== draft.subagentFile) {
                await deleteClaudeAgentFile(draft.subagentFile);
              }
            }
          }}
          className="btn-pixel bg-indigo-600 hover:bg-indigo-500 flex-1"
        >
          Save
        </button>
        {!agent.isBoss && (
          <button
            onClick={() => {
              if (confirm(`Delete ${agent.name}?`)) onDelete(agent.id);
            }}
            className="btn-pixel bg-red-800 hover:bg-red-700"
          >
            Delete
          </button>
        )}
      </div>

      {/* Skills Modal */}
      {showSkillsModal && (
        <SkillsModal
          agentSkills={draft.skills}
          globalSkillIds={new Set(globalSkills.map((s) => s.id))}
          excludedGlobalSkillIds={new Set(draft.subagentDef?.excludeGlobalSkills || [])}
          onToggleGlobalSkill={(skillId, include) => {
            setDraft((prev) => {
              const currentExcludes =
                prev.subagentDef?.excludeGlobalSkills || [];
              const newExcludes = include
                ? currentExcludes.filter((id) => id !== skillId)
                : [...currentExcludes, skillId];
              return {
                ...prev,
                subagentDef: {
                  ...(prev.subagentDef || { description: prev.role || "" }),
                  excludeGlobalSkills:
                    newExcludes.length > 0 ? newExcludes : undefined,
                } as SubagentDef,
              };
            });
          }}
          onUpdate={(skills) => setDraft((prev) => ({ ...prev, skills }))}
          onClose={() => {
            setShowSkillsModal(false);
            // Save the agent with the latest draft (use functional form to get latest state)
            setDraft((current) => {
              onSave(current);
              return current;
            });
          }}
        />
      )}

      {/* MCP Servers Modal */}
      {showMcpModal && (
        <McpServersModal
          mcpServers={
            (draft.subagentDef as SubagentDef | undefined)?.mcpServers
          }
          onUpdate={(servers) =>
            setDraft((prev) => ({
              ...prev,
              subagentDef: {
                ...(prev.subagentDef || { description: prev.role || "" }),
                mcpServers: servers,
              } as SubagentDef,
            }))
          }
          onClose={() => {
            setShowMcpModal(false);
            setDraft((current) => {
              onSave(current);
              return current;
            });
          }}
        />
      )}
    </div>
  );
}

// ─── Shared field wrapper ─────────────────────────────────────

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      {label && (
        <label className="text-[11px] font-pixel text-slate-300 block">
          {label}
        </label>
      )}
      {children}
    </div>
  );
}

// ─── Comma-separated list input ───────────────────────────────

function ToolsInput({
  value,
  onChange,
  placeholder,
}: {
  value?: string[];
  onChange: (v: string[] | undefined) => void;
  placeholder: string;
}) {
  const [text, setText] = useState((value || []).join(", "));

  const prevValue = useRef(value);
  useEffect(() => {
    if (prevValue.current !== value) {
      setText((value || []).join(", "));
      prevValue.current = value;
    }
  }, [value]);

  return (
    <input
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const items = e.target.value
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
        onChange(items.length > 0 ? items : undefined);
      }}
      placeholder={placeholder}
      className="input-mono"
    />
  );
}

// (MCP servers field replaced by McpServersModal)

// ─── Hooks field ──────────────────────────────────────────────

function HooksField({
  def,
  updateDef,
}: {
  def: SubagentDef | { description: string };
  updateDef: (partial: Partial<SubagentDef>) => void;
}) {
  const fullDef = def as SubagentDef;
  const [hooksText, setHooksText] = useState(() =>
    serializeHooks(fullDef.hooks),
  );

  const prevDef = useRef(fullDef.hooks);
  useEffect(() => {
    if (prevDef.current !== fullDef.hooks) {
      setHooksText(serializeHooks(fullDef.hooks));
      prevDef.current = fullDef.hooks;
    }
  }, [fullDef.hooks]);

  return (
    <textarea
      value={hooksText}
      onChange={(e) => {
        setHooksText(e.target.value);
        try {
          const parsed = JSON.parse(e.target.value || "{}");
          if (typeof parsed === "object" && !Array.isArray(parsed)) {
            updateDef({
              hooks: Object.keys(parsed).length > 0 ? parsed : undefined,
            });
          }
        } catch {
          /* invalid JSON, don't update */
        }
      }}
      rows={3}
      placeholder={
        '{\n  "PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "./validate.sh"}]}]\n}'
      }
      className="input-mono resize-none text-[10px]"
    />
  );
}

// ─── History section ──────────────────────────────────────────

function HistorySection({
  draft,
  setDraft,
}: {
  draft: Agent;
  setDraft: React.Dispatch<React.SetStateAction<Agent>>;
}) {
  return (
    <div className="space-y-2">
      <div className="flex justify-between items-center">
        <span className="text-[11px] font-pixel text-slate-300">
          History ({draft.history.length} messages)
        </span>
        {draft.history.length > 0 && (
          <button
            onClick={() =>
              setDraft((prev) => ({ ...prev, history: [], currentThought: "" }))
            }
            className="text-[11px] font-pixel text-red-400 hover:text-red-300"
          >
            Clear
          </button>
        )}
      </div>
      {draft.history.length === 0 && (
        <p className="text-[11px] font-pixel text-slate-400 text-center py-2">
          No conversation history.
        </p>
      )}
      {draft.history.slice(-5).map((msg, i) => (
        <div
          key={i}
          className={`text-[11px] font-mono rounded p-2 ${msg.role === "user" ? "bg-indigo-900/50 text-indigo-200" : "bg-slate-800 text-slate-200"}`}
        >
          <span className="text-[12px] text-slate-400 block mb-1">
            {msg.role}
          </span>
          <p className="whitespace-pre-wrap break-words line-clamp-3">
            {msg.content}
          </p>
        </div>
      ))}
      {draft.history.length > 5 && (
        <p className="text-[10px] font-pixel text-slate-500 text-center">
          ...and {draft.history.length - 5} older messages
        </p>
      )}
    </div>
  );
}

/** Serialize hooks to JSON for editing */
function serializeHooks(hooks?: SubagentDef["hooks"]): string {
  if (!hooks || Object.keys(hooks).length === 0) return "";
  return JSON.stringify(hooks, null, 2);
}
