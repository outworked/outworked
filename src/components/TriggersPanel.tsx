// ─── Triggers Panel ─────────────────────────────────────────────
// UI for managing event triggers that fire prompts to agents.
// Supports message-pattern, skill-event, webhook, and schedule types.

import { useState, useEffect, useCallback } from "react";
import { Trigger, TriggerMatchMode } from "../lib/types";
import MarkdownMessage from "./MarkdownMessage";

interface Agent {
  id: string;
  name: string;
  color?: string;
  isBoss?: boolean;
}

interface ScheduledTaskRow {
  id: string;
  name: string;
  type: string; // "cron" | "interval" | "one-time"
  schedule: string;
  agent_id: string | null;
  prompt: string;
  enabled: number;
  last_run_at: number | null;
  next_run_at: number | null;
  run_count: number;
  created_at: number;
}

interface TriggersAPI {
  triggerCreate: (trigger: Partial<Trigger>) => Promise<unknown>;
  triggerList: () => Promise<Trigger[]>;
  triggerUpdate: (id: string, updates: Partial<Trigger>) => Promise<unknown>;
  triggerDelete: (id: string) => Promise<unknown>;
  triggerDocs: () => Promise<string | null>;
  triggerTest: (id: string) => Promise<{ ok: boolean; error?: string }>;
  triggerRefreshPatterns: () => Promise<unknown>;
  schedulerList: () => Promise<ScheduledTaskRow[]>;
  schedulerDelete: (id: string) => Promise<{ ok: boolean }>;
}

function getDb(): TriggersAPI | null {
  const w = window as unknown as { electronAPI?: { db?: TriggersAPI } };
  return w.electronAPI?.db ?? null;
}

const TRIGGER_TYPES = [
  {
    value: "message-pattern",
    label: "Message Pattern",
    color: "blue",
    description: "Fires when a channel message matches a regex pattern",
  },
  // For future expansion - needs testing:
  // {
  //   value: "skill-event",
  //   label: "Skill Event",
  //   color: "purple",
  //   description: "Fires when a skill emits a specific event type",
  // },
  // {
  //   value: "webhook",
  //   label: "Webhook",
  //   color: "green",
  //   description: "Fires via HTTP POST to localhost:7891/trigger/<id>",
  // },
  // {
  //   value: "schedule",
  //   label: "Schedule",
  //   color: "amber",
  //   description: "Fires on a cron schedule (use the Scheduler skill)",
  // },
] as const;

type TriggerType = Trigger["type"];

const typeColors: Record<
  string,
  { badge: string; border: string; bg: string }
> = {
  "message-pattern": {
    badge: "text-blue-400",
    border: "border-blue-600/30",
    bg: "bg-blue-950/20",
  },
  "skill-event": {
    badge: "text-purple-400",
    border: "border-purple-600/30",
    bg: "bg-purple-950/20",
  },
  webhook: {
    badge: "text-green-400",
    border: "border-green-600/30",
    bg: "bg-green-950/20",
  },
  schedule: {
    badge: "text-amber-400",
    border: "border-amber-600/30",
    bg: "bg-amber-950/20",
  },
};

type View = "list" | "create" | "edit";

interface TriggersProps {
  agents?: Agent[];
}

export default function TriggersPanel({ agents = [] }: TriggersProps) {
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [view, setView] = useState<View>("list");
  const [editingTrigger, setEditingTrigger] = useState<Trigger | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [docsContent, setDocsContent] = useState<string | null>(null);
  const [showDocs, setShowDocs] = useState(false);
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTaskRow[]>([]);
  const [showScheduled, setShowScheduled] = useState(true);

  const loadTriggers = useCallback(async () => {
    const db = getDb();
    if (!db) return;
    try {
      const list = await db.triggerList();
      setTriggers(list || []);
    } catch {
      setError("Failed to load triggers");
    }
  }, []);

  const loadScheduledTasks = useCallback(async () => {
    const db = getDb();
    if (!db) return;
    try {
      const tasks = await db.schedulerList();
      setScheduledTasks(tasks || []);
    } catch {
      // scheduler may not be initialized
    }
  }, []);

  useEffect(() => {
    loadTriggers();
    loadScheduledTasks();
  }, [loadTriggers, loadScheduledTasks]);

  const handleToggle = useCallback(async (id: string, enabled: boolean) => {
    const db = getDb();
    if (!db) return;
    await db.triggerUpdate(id, { enabled });
    await db.triggerRefreshPatterns().catch(() => {});
    setTriggers((prev) =>
      prev.map((t) => (t.id === id ? { ...t, enabled } : t)),
    );
  }, []);

  const handleDelete = useCallback(
    async (id: string) => {
      const db = getDb();
      if (!db) return;
      await db.triggerDelete(id);
      await db.triggerRefreshPatterns().catch(() => {});
      setTriggers((prev) => prev.filter((t) => t.id !== id));
      if (editingTrigger?.id === id) {
        setEditingTrigger(null);
        setView("list");
      }
    },
    [editingTrigger],
  );

  const handleTestFire = useCallback(async (id: string) => {
    const db = getDb();
    if (!db) return;
    const result = await db.triggerTest(id);
    if (!result.ok) {
      setError(result.error || "Test fire failed");
    }
  }, []);

  const handleShowDocs = useCallback(async () => {
    if (docsContent) {
      setShowDocs(true);
      return;
    }
    const db = getDb();
    if (!db) return;
    const docs = await db.triggerDocs();
    if (docs) {
      setDocsContent(docs);
      setShowDocs(true);
    }
  }, [docsContent]);

  return (
    <div className="p-4 text-slate-200 flex flex-col gap-4 h-full overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        {view !== "list" && (
          <button
            onClick={() => {
              setView("list");
              setEditingTrigger(null);
              setError(null);
            }}
            className="text-slate-400 hover:text-white text-xs mr-2"
          >
            &larr; Back
          </button>
        )}
        <h3 className="text-sm font-pixel text-white flex-1">
          {view === "list" && "Triggers"}
          {view === "create" && "New Trigger"}
          {view === "edit" && `Edit: ${editingTrigger?.name || "Trigger"}`}
        </h3>
        <button
          onClick={handleShowDocs}
          className="text-[10px] font-pixel text-slate-400 hover:text-indigo-400 transition-colors"
        >
          ? Guide
        </button>
      </div>

      {error && (
        <div className="bg-red-900/60 border border-red-700/50 rounded px-3 py-2 text-xs text-red-200">
          <p>{error}</p>
          <button
            onClick={() => setError(null)}
            className="text-[9px] text-red-400 hover:text-red-200 mt-1"
          >
            dismiss
          </button>
        </div>
      )}

      {/* ── Trigger List ─────────────────────────────────────── */}
      {view === "list" && (
        <>
          {triggers.length === 0 ? (
            <div className="text-center text-slate-500 text-xs py-8">
              No triggers configured yet.
            </div>
          ) : (
            <div className="flex flex-col gap-2 max-h-[400px] overflow-y-auto">
              {triggers.map((trigger) => (
                <TriggerCard
                  key={trigger.id}
                  trigger={trigger}
                  agents={agents}
                  onToggle={(enabled) => handleToggle(trigger.id, enabled)}
                  onEdit={() => {
                    setEditingTrigger(trigger);
                    setView("edit");
                    setError(null);
                  }}
                  onDelete={() => handleDelete(trigger.id)}
                  onTestFire={() => handleTestFire(trigger.id)}
                />
              ))}
            </div>
          )}

          {/* ── Scheduled Tasks ───────────────────────────────── */}
          {scheduledTasks.length > 0 && (
            <div className="border-t border-slate-700 pt-3">
              <button
                onClick={() => setShowScheduled((p) => !p)}
                className="flex items-center gap-1.5 w-full text-left mb-2"
              >
                <span className="text-[9px] text-slate-500 font-pixel uppercase tracking-wider flex-1">
                  Scheduled Tasks ({scheduledTasks.length})
                </span>
                <span className="text-[9px] text-slate-600">
                  {showScheduled ? "▾" : "▸"}
                </span>
              </button>
              {showScheduled && (
                <div className="flex flex-col gap-1.5">
                  {scheduledTasks.map((task) => (
                    <ScheduledTaskCard
                      key={task.id}
                      task={task}
                      agents={agents}
                      onDelete={async () => {
                        const db = getDb();
                        if (!db) return;
                        await db.schedulerDelete(task.id);
                        setScheduledTasks((prev) =>
                          prev.filter((t) => t.id !== task.id),
                        );
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="border-t border-slate-700 pt-3 mt-auto">
            <button
              onClick={() => {
                setView("create");
                setError(null);
              }}
              className="w-full py-2.5 text-[10px] font-pixel text-slate-500 hover:text-indigo-400 border border-dashed border-slate-700 hover:border-indigo-600/50 rounded transition-colors"
            >
              + New Trigger
            </button>
          </div>
        </>
      )}

      {/* ── Create Trigger ───────────────────────────────────── */}
      {view === "create" && (
        <TriggerForm
          agents={agents}
          onSave={async (data) => {
            const db = getDb();
            if (!db) return;
            const id = `trigger-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            await db.triggerCreate({
              id,
              ...data,
              createdAt: Date.now(),
              triggerCount: 0,
            });
            await db.triggerRefreshPatterns().catch(() => {});
            await loadTriggers();
            setView("list");
          }}
          onCancel={() => setView("list")}
          onError={setError}
        />
      )}

      {/* ── Edit Trigger ─────────────────────────────────────── */}
      {view === "edit" && editingTrigger && (
        <TriggerForm
          initial={editingTrigger}
          agents={agents}
          onSave={async (data) => {
            const db = getDb();
            if (!db) return;
            await db.triggerUpdate(editingTrigger.id, data);
            await db.triggerRefreshPatterns().catch(() => {});
            await loadTriggers();
            setView("list");
            setEditingTrigger(null);
          }}
          onCancel={() => {
            setView("list");
            setEditingTrigger(null);
          }}
          onDelete={() => handleDelete(editingTrigger.id)}
          onError={setError}
        />
      )}

      {/* ── Docs Modal ───────────────────────────────────────── */}
      {showDocs && docsContent && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[60]"
          onClick={() => setShowDocs(false)}
        >
          <div
            className="bg-slate-900 border border-slate-600 rounded-lg w-[520px] max-h-[80vh] shadow-2xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
              <h3 className="text-sm font-pixel text-white">
                Triggers Setup Guide
              </h3>
              <button
                onClick={() => setShowDocs(false)}
                className="text-slate-400 hover:text-white text-lg leading-none cursor-pointer font-pixel uppercase"
              >
                X
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-3 text-xs text-slate-300 leading-relaxed">
              <MarkdownMessage
                content={docsContent
                  .replace(/<details>[\s\S]*?<\/details>/g, "")
                  .trim()}
              />
            </div>
            <div className="px-4 py-3 border-t border-slate-700">
              <button
                onClick={() => setShowDocs(false)}
                className="w-full btn-pixel bg-indigo-600 hover:bg-indigo-500 text-[11px]"
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Scheduled Task Card ───────────────────────────────────────

function ScheduledTaskCard({
  task,
  agents,
  onDelete,
}: {
  task: ScheduledTaskRow;
  agents: Agent[];
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const enabled = !!task.enabled;
  const targetAgent = task.agent_id
    ? agents.find((a) => a.id === task.agent_id)
    : null;

  const scheduleTypeColors: Record<
    string,
    { badge: string; border: string; bg: string }
  > = {
    cron: {
      badge: "text-amber-400",
      border: "border-amber-600/30",
      bg: "bg-amber-950/20",
    },
    interval: {
      badge: "text-cyan-400",
      border: "border-cyan-600/30",
      bg: "bg-cyan-950/20",
    },
    "one-time": {
      badge: "text-pink-400",
      border: "border-pink-600/30",
      bg: "bg-pink-950/20",
    },
  };
  const colors = scheduleTypeColors[task.type] || scheduleTypeColors.cron;

  const nextRunLabel = task.next_run_at
    ? formatRelativeTime(task.next_run_at)
    : "—";

  const isLongPrompt = !!task.prompt && task.prompt.length > 80;

  return (
    <div
      className={`rounded-lg border px-3 py-2 ${colors.border} ${colors.bg} ${
        !enabled ? "opacity-50" : ""
      }`}
    >
      <div className="flex items-center gap-2 mb-0.5">
        <span className="text-[10px] text-white font-medium flex-1 truncate">
          {task.name}
        </span>
        <span className={`text-[8px] font-pixel ${colors.badge}`}>
          {task.type}
        </span>
        {!enabled && (
          <span className="text-[8px] font-pixel text-slate-500">disabled</span>
        )}
      </div>
      <div className="flex items-center gap-2 text-[9px] text-slate-400">
        <span className="font-mono">{task.schedule}</span>
        <span className="text-slate-600">·</span>
        {enabled && task.next_run_at ? (
          <span>next: {nextRunLabel}</span>
        ) : (
          <span>{task.run_count}x run</span>
        )}
        {targetAgent && (
          <>
            <span className="text-slate-600">·</span>
            <span style={{ color: targetAgent.color || "#94a3b8" }}>
              {targetAgent.name}
            </span>
          </>
        )}
      </div>
      <div className="flex items-center mt-1.5">
        {task.prompt && (
          <button
            onClick={() => isLongPrompt && setExpanded((p) => !p)}
            className={`text-[9px] text-slate-500 text-left flex-1 ${
              isLongPrompt ? "cursor-pointer hover:text-slate-400" : ""
            } ${expanded ? "" : "truncate"}`}
          >
            {expanded ? "" : (
              <>
                {task.prompt.slice(0, 80)}
                {isLongPrompt ? "..." : ""}
              </>
            )}
          </button>
        )}
        <button
          onClick={onDelete}
          className="btn-pixel text-[10px] bg-red-900/60 hover:bg-red-800 text-red-300 px-2 py-0.5 ml-auto shrink-0"
        >
          Delete
        </button>
      </div>
      {expanded && task.prompt && (
        <pre className="text-[9px] text-slate-400 mt-1.5 whitespace-pre-wrap break-words bg-slate-900/50 rounded px-2 py-1.5 border border-slate-700/30 max-h-[200px] overflow-y-auto">
          {task.prompt}
        </pre>
      )}
    </div>
  );
}

function formatRelativeTime(ts: number): string {
  const now = Date.now();
  const diff = ts - now;
  if (diff < 0) return "overdue";
  if (diff < 60_000) return "< 1m";
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m`;
  if (diff < 86400_000) return `${Math.round(diff / 3600_000)}h`;
  return `${Math.round(diff / 86400_000)}d`;
}

// ─── Trigger Card ──────────────────────────────────────────────

function TriggerCard({
  trigger,
  agents,
  onToggle,
  onEdit,
  onDelete,
  onTestFire,
}: {
  trigger: Trigger;
  agents: Agent[];
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  onTestFire: () => void;
}) {
  const colors = typeColors[trigger.type] || typeColors.webhook;
  const targetAgent = agents.find((a) => a.id === trigger.agentId);

  return (
    <div
      className={`rounded-lg border px-3 py-2.5 ${colors.border} ${colors.bg}`}
    >
      <div className="flex items-center gap-2 mb-1">
        <input
          type="checkbox"
          checked={trigger.enabled}
          onChange={(e) => onToggle(e.target.checked)}
          className="accent-indigo-500 shrink-0"
        />
        <span className="text-xs text-white font-medium flex-1 truncate">
          {trigger.name}
        </span>
        <span className={`text-[9px] font-pixel ${colors.badge}`}>
          {trigger.type}
        </span>
      </div>

      {trigger.pattern && (
        <p className="text-[10px] text-slate-400 ml-6 mb-1 font-mono truncate">
          {trigger.matchMode === "regex"
            ? `/${trigger.pattern}/`
            : trigger.matchMode === "starts-with"
              ? `starts with "${trigger.pattern}"`
              : trigger.matchMode === "exact"
                ? `exactly "${trigger.pattern}"`
                : `contains "${trigger.pattern}"`}
        </p>
      )}

      <div className="flex items-center gap-2 ml-6 mb-1.5">
        {targetAgent && (
          <span
            className="text-[9px] px-1.5 py-0.5 rounded bg-slate-700/50 border border-slate-600/50"
            style={{ color: targetAgent.color || "#94a3b8" }}
          >
            {targetAgent.name}
          </span>
        )}
        <span className="text-[9px] text-slate-500">
          {trigger.triggerCount}x fired
          {trigger.lastTriggeredAt &&
            ` · ${new Date(trigger.lastTriggeredAt).toLocaleDateString()}`}
        </span>
      </div>

      <div className="flex gap-1.5 ml-6">
        <button
          onClick={onTestFire}
          disabled={!trigger.enabled}
          className="btn-pixel text-[10px] bg-indigo-800 hover:bg-indigo-700 text-indigo-100 px-2 py-0.5 disabled:opacity-40"
        >
          Test
        </button>
        <button
          onClick={onEdit}
          className="btn-pixel text-[10px] bg-slate-700 hover:bg-slate-600 text-slate-200 px-2 py-0.5"
        >
          Edit
        </button>
        <button
          onClick={onDelete}
          className="btn-pixel text-[10px] bg-red-900/60 hover:bg-red-800 text-red-300 px-2 py-0.5 ml-auto"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

// ─── Trigger Form (create / edit) ──────────────────────────────

function TriggerForm({
  initial,
  agents,
  onSave,
  onCancel,
  onDelete,
  onError,
}: {
  initial?: Trigger;
  agents: Agent[];
  onSave: (data: Partial<Trigger>) => Promise<void>;
  onCancel: () => void;
  onDelete?: () => void;
  onError: (err: string) => void;
}) {
  const [name, setName] = useState(initial?.name || "");
  const [type, setType] = useState<TriggerType>(
    initial?.type || "message-pattern",
  );
  const [matchMode, setMatchMode] = useState<TriggerMatchMode>(
    initial?.matchMode || "contains",
  );
  const [pattern, setPattern] = useState(initial?.pattern || "");
  const [channelId, setChannelId] = useState(initial?.channelId || "");
  const [senderAllowlist, setSenderAllowlist] = useState(
    initial?.senderAllowlist?.join(", ") || "*",
  );
  const [agentId, setAgentId] = useState(initial?.agentId || "");
  const [prompt, setPrompt] = useState(initial?.prompt || "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [saving, setSaving] = useState(false);

  const isNew = !initial;
  const typeMeta = TRIGGER_TYPES.find((t) => t.value === type);

  const handleSubmit = async () => {
    if (!name.trim() || !prompt.trim()) {
      onError("Name and prompt are required");
      return;
    }
    if (
      (type === "message-pattern" || type === "skill-event") &&
      !pattern.trim()
    ) {
      onError("Pattern is required for this trigger type");
      return;
    }

    // Validate regex for message-pattern with regex match mode
    if (type === "message-pattern" && matchMode === "regex" && pattern.trim()) {
      try {
        new RegExp(pattern.trim(), "i");
      } catch (e) {
        onError(`Invalid regex: ${(e as Error).message}`);
        return;
      }
    }

    setSaving(true);
    try {
      const allowlist = senderAllowlist
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      // Find boss agent ID as fallback when no agent is selected
      const resolvedAgentId =
        agentId || agents.find((a) => a.isBoss)?.id || undefined;

      await onSave({
        name: name.trim(),
        type,
        pattern: pattern.trim() || undefined,
        matchMode: type === "message-pattern" ? matchMode : undefined,
        channelId: channelId.trim() || undefined,
        senderAllowlist: allowlist.length > 0 ? allowlist : undefined,
        agentId: resolvedAgentId,
        prompt: prompt.trim(),
        enabled,
      });
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to save trigger");
    }
    setSaving(false);
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Type selector */}
      <div>
        <label className="text-[10px] text-slate-400 font-pixel block mb-1.5">
          Trigger Type
        </label>
        <div className="grid grid-cols-2 gap-1.5">
          {TRIGGER_TYPES.map((t) => {
            const colors = typeColors[t.value];
            const selected = type === t.value;
            return (
              <button
                key={t.value}
                onClick={() => setType(t.value)}
                className={`text-[10px] font-pixel px-2 py-1.5 rounded border transition-colors text-left ${
                  selected
                    ? `${colors.border} ${colors.bg} ${colors.badge}`
                    : "border-slate-700/50 bg-slate-800/30 text-slate-500 hover:text-slate-300"
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </div>
        {typeMeta && (
          <p className="text-[9px] text-slate-500 mt-1">
            {typeMeta.description}
          </p>
        )}
      </div>

      {/* Name */}
      <label className="text-[10px] text-slate-400 font-pixel">
        Name
        <input
          className="input-mono w-full mt-1"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Deploy watcher"
        />
      </label>

      {/* Match mode + Pattern — for message-pattern */}
      {type === "message-pattern" && (
        <>
          <div>
            <label className="text-[10px] text-slate-400 font-pixel block mb-1.5">
              Match Mode
            </label>
            <div className="grid grid-cols-4 gap-1">
              {(
                [
                  { value: "contains", label: "Contains" },
                  { value: "starts-with", label: "Starts with" },
                  { value: "exact", label: "Exact" },
                  { value: "regex", label: "Regex" },
                ] as const
              ).map((m) => (
                <button
                  key={m.value}
                  onClick={() => setMatchMode(m.value)}
                  className={`text-[9px] font-pixel px-1.5 py-1 rounded border transition-colors ${
                    matchMode === m.value
                      ? "border-blue-600/50 bg-blue-950/30 text-blue-400"
                      : "border-slate-700/50 bg-slate-800/30 text-slate-500 hover:text-slate-300"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
          <label className="text-[10px] text-slate-400 font-pixel">
            {matchMode === "regex" ? "Regex Pattern" : "Match Text"}
            <span className="text-red-400 ml-0.5">*</span>
            <input
              className="input-mono w-full mt-1"
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              placeholder={
                matchMode === "contains"
                  ? "e.g. deploy, help, urgent"
                  : matchMode === "starts-with"
                    ? "e.g. /deploy, hey bot"
                    : matchMode === "exact"
                      ? "e.g. status"
                      : "e.g. deploy (.+) to (staging|prod)"
              }
            />
            <span className="text-[9px] text-slate-500 mt-0.5 block">
              {matchMode === "contains" &&
                "Fires when the message contains this text (case-insensitive)"}
              {matchMode === "starts-with" &&
                "Fires when the message starts with this text"}
              {matchMode === "exact" &&
                "Fires only on an exact match (case-insensitive)"}
              {matchMode === "regex" &&
                "Capture groups become $1, $2, ... in the prompt template"}
            </span>
          </label>
        </>
      )}

      {/* Pattern — for skill-event */}
      {type === "skill-event" && (
        <label className="text-[10px] text-slate-400 font-pixel">
          Event Type
          <span className="text-red-400 ml-0.5">*</span>
          <input
            className="input-mono w-full mt-1"
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            placeholder="e.g. scheduler:task_fired"
          />
        </label>
      )}

      {/* Channel ID — for message-pattern */}
      {type === "message-pattern" && (
        <label className="text-[10px] text-slate-400 font-pixel">
          Channel ID (optional)
          <input
            className="input-mono w-full mt-1"
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
            placeholder="Scope to a specific channel (leave blank for all)"
          />
        </label>
      )}

      {/* Sender allowlist — for message-pattern */}
      {type === "message-pattern" && (
        <label className="text-[10px] text-slate-400 font-pixel">
          Sender Allowlist
          <input
            className="input-mono w-full mt-1"
            value={senderAllowlist}
            onChange={(e) => setSenderAllowlist(e.target.value)}
            placeholder="* for anyone, or comma-separated names"
          />
          <span className="text-[9px] text-slate-500 mt-0.5 block">
            * = any sender. Comma-separate to restrict.
          </span>
        </label>
      )}

      {/* Webhook hint */}
      {type === "webhook" && (
        <div className="bg-green-950/30 border border-green-700/30 rounded px-3 py-2 text-[10px] text-green-300">
          <p className="font-pixel mb-1">Webhook URL (after saving):</p>
          <code className="text-[9px] text-green-400 break-all">
            POST http://127.0.0.1:7891/trigger/
            {initial?.id || "<trigger-id>"}
          </code>
          <p className="text-[9px] text-slate-400 mt-1">
            JSON body keys become {"{{key}}"} placeholders in the prompt.
          </p>
        </div>
      )}

      {/* Target Agent */}
      <label className="text-[10px] text-slate-400 font-pixel">
        Target Agent
        <select
          className="input-mono w-full mt-1"
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
        >
          <option value="">Boss (default)</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <span className="text-[9px] text-slate-500 mt-0.5 block">
          Which agent receives the prompt when this trigger fires
        </span>
      </label>

      {/* Prompt template */}
      <label className="text-[10px] text-slate-400 font-pixel">
        Prompt Template
        <span className="text-red-400 ml-0.5">*</span>
        <textarea
          className="input-mono w-full mt-1 min-h-[80px] resize-y"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={
            type === "message-pattern"
              ? matchMode === "regex"
                ? 'e.g. A user said: "$1". Please respond appropriately.'
                : "e.g. Handle this message and respond helpfully."
              : type === "webhook"
                ? "e.g. Deploy {{repo}} branch {{branch}} to {{env}}"
                : "What should the agent do when this fires?"
          }
          rows={4}
        />
        <span className="text-[9px] text-slate-500 mt-0.5 block">
          {type === "message-pattern"
            ? matchMode === "regex"
              ? "Use $1, $2 for regex capture groups"
              : "The matched message will be included automatically as context"
            : type === "webhook"
              ? "Use {{key}} for JSON body values"
              : "Plain text prompt sent to the target agent"}
        </span>
      </label>

      {/* Enabled toggle */}
      <label className="flex items-center gap-2 text-[10px] text-slate-400 font-pixel">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="accent-indigo-500"
        />
        Enabled
      </label>

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        {onDelete && (
          <button
            onClick={() => {
              if (confirm("Delete this trigger?")) onDelete();
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
          onClick={handleSubmit}
          disabled={saving || !name.trim() || !prompt.trim()}
          className="btn-pixel bg-indigo-600 hover:bg-indigo-500 text-[10px] disabled:opacity-50"
        >
          {saving ? "Saving..." : isNew ? "Create Trigger" : "Save Changes"}
        </button>
      </div>
    </div>
  );
}
