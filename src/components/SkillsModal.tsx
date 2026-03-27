import { useEffect, useState } from "react";
import { AgentSkill } from "../lib/types";
import { fetchAvailableSkills } from "../lib/bundled-skills";
import { isSkillFormat, parseSkill } from "../lib/skill-parser";

// ─── Custom skill DB type ─────────────────────────────────────

export interface CustomSkillRecord {
  id: string;
  name: string;
  description: string;
  content: string;
  emoji?: string;
  createdAt: number;
  updatedAt: number;
}

interface CustomSkillAPI {
  customSkillCreate: (
    skill: Omit<CustomSkillRecord, "createdAt" | "updatedAt">,
  ) => Promise<CustomSkillRecord>;
  customSkillList: () => Promise<CustomSkillRecord[]>;
  customSkillUpdate: (
    id: string,
    updates: Partial<CustomSkillRecord>,
  ) => Promise<void>;
  customSkillDelete: (id: string) => Promise<void>;
}

interface SkillAuthAPI {
  skillRuntimeAuth: (
    runtime: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  skillRuntimeDisconnect: (runtime: string) => Promise<{ ok: boolean }>;
  skillRuntimeStatus: (
    runtime: string,
  ) => Promise<{ name: string; status: string } | null>;
}

function getCustomSkillAPI(): CustomSkillAPI | null {
  const w = window as unknown as { electronAPI?: { db?: CustomSkillAPI } };
  return w.electronAPI?.db ?? null;
}

function getSkillAuthAPI(): SkillAuthAPI | null {
  const w = window as unknown as { electronAPI?: { db?: SkillAuthAPI } };
  return w.electronAPI?.db ?? null;
}

export function customToAgentSkill(cs: CustomSkillRecord): AgentSkill {
  // If content is SKILL.md format, parse it for full metadata
  if (isSkillFormat(cs.content)) {
    const parsed = parseSkill(cs.content);
    return {
      ...parsed,
      id: cs.id, // preserve DB id
    };
  }
  return {
    id: cs.id,
    name: cs.emoji ? `${cs.emoji} ${cs.name}` : cs.name,
    content: cs.content,
    description: cs.description,
  };
}

/**
 * If raw content is SKILL.md format, extract name/description/emoji from frontmatter
 * so the DB record stays in sync with what the parser would produce.
 */
function extractSkillFields(raw: string): {
  name?: string;
  description?: string;
  emoji?: string;
} | null {
  if (!isSkillFormat(raw)) return null;
  const parsed = parseSkill(raw);
  // parsed.name may include emoji prefix like "🛵 ordercli" — split it back out
  const emojiMatch = parsed.name.match(
    /^(\p{Emoji_Presentation}|\p{Emoji}\uFE0F?)\s+(.+)$/u,
  );
  return {
    name: emojiMatch ? emojiMatch[2] : parsed.name,
    description: parsed.description || undefined,
    emoji: emojiMatch ? emojiMatch[1] : parsed.metadata?.emoji || undefined,
  };
}

// ─── Modal ────────────────────────────────────────────────────

interface SkillsModalProps {
  agentSkills: AgentSkill[];
  onUpdate: (skills: AgentSkill[]) => void;
  onClose: () => void;
  /** All global skill IDs (used to determine which skills are global) */
  globalSkillIds?: Set<string>;
  /** Global skill IDs that are currently excluded for this agent */
  excludedGlobalSkillIds?: Set<string>;
  /** Called when a global skill is toggled (true = include, false = exclude) */
  onToggleGlobalSkill?: (skillId: string, include: boolean) => void;
}

export default function SkillsModal({
  agentSkills,
  onUpdate,
  onClose,
  globalSkillIds,
  excludedGlobalSkillIds,
  onToggleGlobalSkill,
}: SkillsModalProps) {
  const [bundled, setBundled] = useState<AgentSkill[]>([]);
  const [customSkills, setCustomSkills] = useState<CustomSkillRecord[]>([]);
  const [authStatuses, setAuthStatuses] = useState<Record<string, string>>({});
  const [authenticating, setAuthenticating] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    fetchAvailableSkills().then(setBundled).catch(console.error);

    const csApi = getCustomSkillAPI();
    if (csApi)
      csApi.customSkillList().then(setCustomSkills).catch(console.error);
  }, []);

  useEffect(() => {
    if (bundled.length === 0) return;
    const authApi = getSkillAuthAPI();
    if (!authApi) return;
    (async () => {
      const statuses: Record<string, string> = {};
      for (const skill of bundled) {
        if (skill.metadata?.runtime) {
          try {
            const r = await authApi.skillRuntimeStatus(skill.metadata.runtime);
            statuses[skill.metadata.runtime] = r?.status || "disconnected";
          } catch {
            statuses[skill.metadata.runtime] = "disconnected";
          }
        }
      }
      setAuthStatuses(statuses);
    })();
  }, [bundled]);

  const toggleSkill = (skill: AgentSkill, enabled: boolean) => {
    if (enabled) {
      onUpdate([...agentSkills, skill]);
    } else {
      onUpdate(agentSkills.filter((s) => s.id !== skill.id));
    }
  };

  const handleConnect = async (runtime: string) => {
    const api = getSkillAuthAPI();
    if (!api) return;
    setAuthenticating(runtime);
    try {
      const result = await api.skillRuntimeAuth(runtime);
      if (result.ok)
        setAuthStatuses((prev) => ({ ...prev, [runtime]: "connected" }));
    } catch (err) {
      console.error(`[skill-auth] ${runtime}:`, err);
    } finally {
      setAuthenticating(null);
    }
  };

  const handleDisconnect = async (runtime: string) => {
    const api = getSkillAuthAPI();
    if (!api) return;
    try {
      await api.skillRuntimeDisconnect(runtime);
      setAuthStatuses((prev) => ({ ...prev, [runtime]: "disconnected" }));
    } catch (err) {
      console.error(`[skill-disconnect] ${runtime}:`, err);
    }
  };

  const handleCreateCustomSkill = async (data: {
    name: string;
    description: string;
    content: string;
  }) => {
    const api = getCustomSkillAPI();
    if (!api) return;
    const id = `custom:${crypto.randomUUID()}`;
    // If content is SKILL.md format, extract fields from frontmatter
    const parsed = extractSkillFields(data.content);
    const skillData = parsed
      ? {
          id,
          name: parsed.name || data.name,
          description: parsed.description || data.description,
          content: data.content,
          emoji: parsed.emoji,
        }
      : { id, ...data };
    const record = await api.customSkillCreate(skillData);
    setCustomSkills((prev) => [record, ...prev]);
    onUpdate([...agentSkills, customToAgentSkill(record)]);
    setCreating(false);
  };

  const handleUpdateCustomSkill = async (
    id: string,
    updates: {
      name?: string;
      description?: string;
      content?: string;
    },
  ) => {
    const api = getCustomSkillAPI();
    if (!api) return;
    // If updated content is SKILL.md format, re-extract fields
    const parsed = updates.content ? extractSkillFields(updates.content) : null;
    const finalUpdates: Partial<CustomSkillRecord> = parsed
      ? {
          ...updates,
          ...(parsed.name && { name: parsed.name }),
          ...(parsed.description && { description: parsed.description }),
          ...(parsed.emoji && { emoji: parsed.emoji }),
        }
      : updates;
    await api.customSkillUpdate(id, finalUpdates);
    setCustomSkills((prev) =>
      prev.map((s) => (s.id === id ? { ...s, ...finalUpdates } : s)),
    );
    if (agentSkills.some((s) => s.id === id)) {
      const updated = customSkills.find((s) => s.id === id);
      if (updated) {
        const merged = { ...updated, ...finalUpdates };
        onUpdate(
          agentSkills.map((s) =>
            s.id === id ? customToAgentSkill(merged as CustomSkillRecord) : s,
          ),
        );
      }
    }
    setEditingId(null);
  };

  const handleDeleteCustomSkill = async (id: string) => {
    const api = getCustomSkillAPI();
    if (!api) return;
    await api.customSkillDelete(id);
    setCustomSkills((prev) => prev.filter((s) => s.id !== id));
    onUpdate(agentSkills.filter((s) => s.id !== id));
    setEditingId(null);
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-slate-900 border border-slate-600 rounded-lg w-[420px] max-h-[80vh] flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
          <h2 className="text-xs font-pixel text-white">Manage Skills</h2>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white text-xs font-pixel px-1"
          >
            X
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          {creating ? (
            <SkillForm
              onSave={handleCreateCustomSkill}
              onCancel={() => setCreating(false)}
            />
          ) : editingId ? (
            (() => {
              const cs = customSkills.find((s) => s.id === editingId);
              if (!cs) return null;
              return (
                <SkillForm
                  key={cs.id}
                  initial={cs}
                  onSave={(u) => handleUpdateCustomSkill(cs.id, u)}
                  onCancel={() => setEditingId(null)}
                  onDelete={() => handleDeleteCustomSkill(cs.id)}
                />
              );
            })()
          ) : (
            <>
              {/* Built-in skills */}
              {bundled.length > 0 && (
                <section className="space-y-1.5">
                  <p className="text-[9px] font-pixel text-slate-500 uppercase tracking-wider">
                    Built-in
                  </p>
                  {bundled.map((skill) => {
                    const isGlobal = globalSkillIds?.has(skill.id) ?? false;
                    const isExcluded = excludedGlobalSkillIds?.has(skill.id) ?? false;
                    const isInherited = isGlobal && !isExcluded;
                    const isEnabled = isInherited || agentSkills.some(
                      (s) => s.id === skill.id,
                    );
                    const runtime = skill.metadata?.runtime;
                    const authStatus = runtime
                      ? authStatuses[runtime]
                      : undefined;
                    const needsAuth = !!skill.metadata?.auth;
                    const isConnected = authStatus === "connected";

                    return (
                      <div
                        key={skill.id}
                        className={`rounded border p-2.5 transition-colors ${
                          isEnabled
                            ? "border-indigo-600/50 bg-indigo-950/30"
                            : "border-slate-700/50 bg-slate-800/30"
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={isEnabled}
                            onChange={(e) => {
                              if (isGlobal) {
                                // Global skill: toggle exclude list
                                onToggleGlobalSkill?.(skill.id, e.target.checked);
                              } else {
                                // Agent-specific skill: toggle agent skill list
                                toggleSkill(skill, e.target.checked);
                              }
                            }}
                            className="accent-indigo-500 shrink-0"
                          />
                          <span className="text-[11px] font-pixel text-slate-200 flex-1 min-w-0 truncate">
                            {skill.name}
                          </span>
                          {isInherited && (
                            <span className="text-[8px] font-pixel px-1.5 py-0.5 rounded shrink-0 bg-slate-700/50 text-slate-400 border border-slate-600/50">
                              global
                            </span>
                          )}
                          {needsAuth && (
                            <span
                              className={`text-[9px] font-pixel px-1.5 py-0.5 rounded shrink-0 ${
                                isConnected
                                  ? "bg-emerald-900/50 text-emerald-300 border border-emerald-700/50"
                                  : "bg-amber-900/50 text-amber-300 border border-amber-700/50"
                              }`}
                            >
                              {isConnected ? "connected" : "not connected"}
                            </span>
                          )}
                        </div>
                        {skill.description && (
                          <p className="text-[9px] text-slate-500 mt-1 ml-6 line-clamp-2">
                            {skill.description}
                          </p>
                        )}
                        {isEnabled && needsAuth && (
                          <div className="mt-2 ml-6">
                            {isConnected ? (
                              <button
                                onClick={() =>
                                  runtime && handleDisconnect(runtime)
                                }
                                className="text-[10px] font-pixel px-2 py-1 rounded bg-red-900/50 text-red-300 border border-red-700/50 hover:bg-red-900/80 transition-colors"
                              >
                                Disconnect
                              </button>
                            ) : (
                              <button
                                onClick={() =>
                                  runtime && handleConnect(runtime)
                                }
                                disabled={authenticating === runtime}
                                className="text-[10px] font-pixel px-2 py-1 rounded bg-indigo-700 text-white border border-indigo-600 hover:bg-indigo-600 transition-colors disabled:opacity-50"
                              >
                                {authenticating === runtime
                                  ? "Authenticating..."
                                  : "Connect Account"}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </section>
              )}

              {/* Custom skills */}
              <section className="space-y-1.5">
                <p className="text-[9px] font-pixel text-slate-500 uppercase tracking-wider">
                  Custom Skills
                </p>

                {customSkills.map((cs) => {
                  const isGlobal = globalSkillIds?.has(cs.id) ?? false;
                  const isExcluded = excludedGlobalSkillIds?.has(cs.id) ?? false;
                  const isInherited = isGlobal && !isExcluded;
                  const isEnabled = isInherited || agentSkills.some((s) => s.id === cs.id);

                  return (
                    <div
                      key={cs.id}
                      className={`group rounded border p-2.5 transition-colors ${
                        isEnabled
                          ? "border-indigo-600/50 bg-indigo-950/30"
                          : "border-slate-700/50 bg-slate-800/30"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={isEnabled}
                          onChange={(e) => {
                            if (isGlobal) {
                              onToggleGlobalSkill?.(cs.id, e.target.checked);
                            } else {
                              toggleSkill(customToAgentSkill(cs), e.target.checked);
                            }
                          }}
                          className="accent-indigo-500 shrink-0"
                        />
                        <span className="text-[11px] font-pixel text-slate-200 flex-1 min-w-0 truncate">
                          {cs.name}
                        </span>
                        {isInherited && (
                          <span className="text-[8px] font-pixel px-1.5 py-0.5 rounded shrink-0 bg-slate-700/50 text-slate-400 border border-slate-600/50">
                            global
                          </span>
                        )}
                        <button
                          onClick={() => {
                            setEditingId(cs.id);
                            setCreating(false);
                          }}
                          className="text-[9px] font-pixel text-slate-600 group-hover:text-slate-400 hover:!text-indigo-400 shrink-0 transition-colors"
                        >
                          edit
                        </button>
                      </div>
                      {cs.description && (
                        <p className="text-[9px] text-slate-500 mt-1 ml-6 line-clamp-1">
                          {cs.description}
                        </p>
                      )}
                    </div>
                  );
                })}

                <button
                  onClick={() => {
                    setCreating(true);
                    setEditingId(null);
                  }}
                  className="w-full py-2.5 text-[10px] font-pixel text-slate-500 hover:text-indigo-400 border border-dashed border-slate-700 hover:border-indigo-600/50 rounded transition-colors"
                >
                  + New Custom Skill
                </button>
              </section>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-slate-700">
          <button
            onClick={onClose}
            className="w-full btn-pixel bg-indigo-600 hover:bg-indigo-500 text-[11px]"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Skill create/edit form ───────────────────────────────────

function SkillForm({
  initial,
  onSave,
  onCancel,
  onDelete,
}: {
  initial?: {
    name: string;
    description: string;
    content: string;
  };
  onSave: (data: {
    name: string;
    description: string;
    content: string;
  }) => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const [name, setName] = useState(initial?.name || "");
  const [description, setDescription] = useState(initial?.description || "");
  const [content, setContent] = useState(initial?.content || "");
  const isNew = !initial;
  const isSkillMd = isSkillFormat(content);

  const handleContentChange = (raw: string) => {
    setContent(raw);
    // Auto-fill name/description from SKILL.md frontmatter
    const parsed = extractSkillFields(raw);
    if (parsed) {
      if (parsed.name && (!name || name === initial?.name))
        setName(parsed.name);
      if (
        parsed.description &&
        (!description || description === initial?.description)
      )
        setDescription(parsed.description);
    }
  };

  return (
    <div className="rounded border border-indigo-600/50 bg-indigo-950/20 p-3 space-y-2.5">
      <div className="flex items-center gap-2">
        <p className="text-[10px] font-pixel text-indigo-300">
          {isNew ? "New Skill" : "Edit Skill"}
        </p>
        {isSkillMd && (
          <span className="text-[8px] font-pixel px-1.5 py-0.5 rounded bg-emerald-900/50 text-emerald-300 border border-emerald-700/50">
            SKILL.md detected
          </span>
        )}
      </div>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Skill name"
        className="input-mono"
      />
      <input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Short description (optional)"
        className="input-mono text-[10px]"
      />
      <div>
        <label className="text-[9px] font-pixel text-slate-500 block mb-1">
          {isSkillMd
            ? "SKILL.md content (frontmatter + instructions)"
            : "Instructions (injected into system prompt)"}
        </label>
        <textarea
          value={content}
          onChange={(e) => handleContentChange(e.target.value)}
          placeholder="Write markdown instructions or paste a SKILL.md..."
          rows={isSkillMd ? 8 : 5}
          className="input-mono resize-none text-[10px]"
        />
      </div>
      <div className="flex items-center gap-2 pt-1">
        {onDelete && (
          <button
            onClick={() => {
              if (
                confirm(
                  "Delete this skill? It will be removed from all agents.",
                )
              )
                onDelete();
            }}
            className="text-[10px] font-pixel text-red-400/70 hover:text-red-400 transition-colors"
          >
            Delete
          </button>
        )}
        <div className="flex-1" />
        <button
          onClick={onCancel}
          className="text-[10px] font-pixel text-slate-400 hover:text-slate-200 px-3 py-1 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={() => {
            if (!name.trim()) return;
            onSave({
              name: name.trim(),
              description: description.trim(),
              content: content.trim(),
            });
          }}
          disabled={!name.trim()}
          className="btn-pixel bg-indigo-600 hover:bg-indigo-500 text-[10px] disabled:opacity-50"
        >
          {isNew ? "Create" : "Save"}
        </button>
      </div>
    </div>
  );
}
