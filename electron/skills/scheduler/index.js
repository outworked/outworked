// ─── Scheduler Runtime ───────────────────────────────────────────
// Manages scheduled tasks with cron, interval, and one-time execution.
// Emits trigger events when tasks fire, making scheduling composable
// with the agent trigger/automation system.

const BaseRuntime = require("../base-runtime");
const db = require("../../db/database");
const verbose = process.env.VERBOSE_LOGGING === "true";

const CHECK_INTERVAL_MS = 10_000; // Check for due tasks every 10s

class SchedulerRuntime extends BaseRuntime {
  constructor() {
    super("scheduler");

    this._checkTimer = null;

    // ── Register tools ────────────────────────────────────────────

    this.registerTool(
      "scheduler:create",
      {
        name: "scheduler:create",
        description:
          "Create a scheduled task that runs on a cron schedule, interval, or at a specific time.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Task name" },
            type: {
              type: "string",
              description: 'Schedule type: "cron", "interval", or "one-time"',
            },
            schedule: {
              type: "string",
              description:
                'For cron: expression like "0 9 * * *". For interval: duration like "5m", "2h", "30s", or ms. For one-time: ISO datetime, or relative like "+5m", "in 2 hours", "+120s".',
            },
            agentId: {
              type: "string",
              description:
                "Agent ID to run the task (optional — omit to use the current agent)",
            },
            prompt: {
              type: "string",
              description:
                "Prompt/instruction for the agent when the task fires",
            },
          },
          required: ["name", "type", "schedule", "prompt"],
        },
      },
      this._create,
    );

    this.registerTool(
      "scheduler:list",
      {
        name: "scheduler:list",
        description: "List all scheduled tasks.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      this._list,
    );

    this.registerTool(
      "scheduler:get",
      {
        name: "scheduler:get",
        description: "Get details of a specific scheduled task.",
        parameters: {
          type: "object",
          properties: {
            taskId: { type: "string", description: "Task ID" },
          },
          required: ["taskId"],
        },
      },
      this._get,
    );

    this.registerTool(
      "scheduler:update",
      {
        name: "scheduler:update",
        description:
          "Update a scheduled task (enable/disable, change schedule, etc.).",
        parameters: {
          type: "object",
          properties: {
            taskId: { type: "string", description: "Task ID" },
            enabled: {
              type: "boolean",
              description: "Enable or disable the task",
            },
            schedule: {
              type: "string",
              description: "New schedule (cron/interval/datetime)",
            },
            prompt: { type: "string", description: "New prompt for the agent" },
            name: { type: "string", description: "New task name" },
          },
          required: ["taskId"],
        },
      },
      this._update,
    );

    this.registerTool(
      "scheduler:delete",
      {
        name: "scheduler:delete",
        description: "Delete a scheduled task.",
        parameters: {
          type: "object",
          properties: {
            taskId: { type: "string", description: "Task ID" },
          },
          required: ["taskId"],
        },
      },
      this._delete,
    );

    this.registerTool(
      "scheduler:run_now",
      {
        name: "scheduler:run_now",
        description:
          "Immediately trigger a scheduled task (runs it now regardless of schedule).",
        parameters: {
          type: "object",
          properties: {
            taskId: {
              type: "string",
              description: "Task ID to run immediately",
            },
          },
          required: ["taskId"],
        },
      },
      this._runNow,
    );

    this.registerTool(
      "scheduler:clear_all",
      {
        name: "scheduler:clear_all",
        description: "Delete all scheduled tasks.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      this._clearAll,
    );
  }

  // ── Auth ──────────────────────────────────────────────────────

  // No auth needed — scheduler is a local service
  async authenticate() {
    this.status = "connected";
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  async init() {
    this.status = "connected";
    this._startChecking();
    verbose &&
      console.log(
        `[scheduler] Initialized, checking every ${CHECK_INTERVAL_MS / 1000}s`,
      );
  }

  async destroy() {
    this._stopChecking();
    this.status = "disconnected";
  }

  getTriggerTypes() {
    return ["scheduler:task_fired"];
  }

  // ── Tool implementations ──────────────────────────────────────

  async _create({ name, type, schedule, agentId, prompt }) {
    const crypto = require("crypto");
    const id = crypto.randomUUID();
    const now = Date.now();

    let nextRunAt;
    if (type === "one-time") {
      nextRunAt = _parseOneTimeSchedule(schedule, now);
    } else if (type === "interval") {
      const ms = _parseIntervalMs(schedule);
      nextRunAt = now + ms;
    } else if (type === "cron") {
      nextRunAt = _nextCronRun(schedule, now);
    } else {
      throw new Error(
        `Unknown schedule type: '${type}'. Use "cron", "interval", or "one-time".`,
      );
    }

    if (!nextRunAt || isNaN(nextRunAt) || nextRunAt <= 0) {
      throw new Error(
        `Invalid schedule: could not parse "${schedule}" for type "${type}"`,
      );
    }

    db.schedulerCreate({
      id,
      name,
      type,
      schedule,
      agentId: agentId || null,
      prompt,
      enabled: true,
      nextRunAt,
      createdAt: now,
      updatedAt: now,
    });

    return {
      id,
      name,
      type,
      schedule,
      nextRunAt: new Date(nextRunAt).toISOString(),
    };
  }

  async _list() {
    const tasks = db.schedulerList();
    if (!tasks || tasks.length === 0) return [];
    return tasks.map(_formatTask);
  }

  async _get({ taskId }) {
    const task = db.schedulerGet(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return _formatTask(task);
  }

  async _update({ taskId, enabled, schedule, prompt, name }) {
    const task = db.schedulerGet(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const updates = { updatedAt: Date.now() };
    if (enabled !== undefined) updates.enabled = enabled;
    if (name !== undefined) updates.name = name;
    if (prompt !== undefined) updates.prompt = prompt;
    if (schedule !== undefined) {
      updates.schedule = schedule;
      if (task.type === "one-time") {
        updates.nextRunAt = new Date(schedule).getTime();
      } else if (task.type === "interval") {
        updates.nextRunAt = Date.now() + _parseIntervalMs(schedule);
      } else if (task.type === "cron") {
        updates.nextRunAt = _nextCronRun(schedule, Date.now());
      }
    }

    db.schedulerUpdate(taskId, updates);
    return { ok: true, taskId };
  }

  async _delete({ taskId }) {
    db.schedulerDelete(taskId);
    return { ok: true, deleted: taskId };
  }

  async _runNow({ taskId }) {
    const task = db.schedulerGet(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    this._fireDueTask(task);

    return { ok: true, taskId, fired: true };
  }

  async _clearAll() {
    const tasks = db.schedulerList();
    if (!tasks || tasks.length === 0) return { ok: true, deleted: 0 };
    for (const task of tasks) {
      db.schedulerDelete(task.id);
    }
    return { ok: true, deleted: tasks.length };
  }

  /**
   * Send a due task directly to the renderer as a trigger:fire event.
   * This reuses the same IPC channel that the trigger engine uses,
   * so App.tsx picks it up and dispatches to the right agent.
   */
  _fireDueTask(task) {
    const { BrowserWindow } = require("electron");
    const windows = BrowserWindow.getAllWindows();
    const mainWindow = windows.length > 0 ? windows[0] : null;

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("trigger:fire", {
        triggerId: `scheduler:${task.id}`,
        triggerName: task.name,
        agentId: task.agentId,
        prompt: task.prompt,
        context: { taskId: task.id, scheduled: true },
      });
    }

    // Also emit the skill event for any trigger-engine listeners
    this._emit("scheduler:task_fired", {
      taskId: task.id,
      taskName: task.name,
      agentId: task.agentId,
      prompt: task.prompt,
    });
  }

  // ── Task checking loop ─────────────────────────────────────────

  _startChecking() {
    if (this._checkTimer) return;
    this._checkTimer = setInterval(
      () => this._checkDueTasks(),
      CHECK_INTERVAL_MS,
    );
  }

  _stopChecking() {
    if (this._checkTimer) {
      clearInterval(this._checkTimer);
      this._checkTimer = null;
    }
  }

  _checkDueTasks() {
    try {
      const now = Date.now();
      const tasks = db.schedulerList();
      if (!tasks || tasks.length === 0) return;
      verbose &&
        console.log(
          `[scheduler] Checking ${tasks.length} tasks at ${new Date(now).toISOString()}`,
        );

      for (const task of tasks) {
        if (!task.enabled) continue;
        if (!task.nextRunAt || task.nextRunAt > now) {
          verbose &&
            console.log(
              `[scheduler] Task "${task.name}" not due yet (nextRunAt: ${new Date(task.nextRunAt).toISOString()}, now: ${new Date(now).toISOString()})`,
            );
          continue;
        }

        verbose &&
          console.log(`[scheduler] Firing task "${task.name}" (${task.id})`);
        // Task is due — fire directly to renderer as a trigger
        this._fireDueTask(task);

        // Calculate next run
        const updates = {
          lastRunAt: now,
          runCount: (task.runCount || 0) + 1,
          updatedAt: now,
        };

        if (task.type === "one-time") {
          updates.enabled = false; // Disable after single execution
        } else if (task.type === "interval") {
          updates.nextRunAt = now + _parseIntervalMs(task.schedule);
        } else if (task.type === "cron") {
          updates.nextRunAt = _nextCronRun(task.schedule, now);
        }

        db.schedulerUpdate(task.id, updates);
      }
    } catch (err) {
      console.error("[scheduler] Error checking due tasks:", err.message);
    }
  }
}

// ── Time Parsing ────────────────────────────────────────────────

/**
 * Parse a one-time schedule value into a timestamp.
 * Supports:
 *   - ISO 8601 datetime: "2026-03-25T14:00:00Z"
 *   - Relative offset:   "+120s", "+5m", "+2h", "+1d", "in 5 minutes"
 *   - Unix timestamp ms: "1742920800000"
 */
function _parseOneTimeSchedule(schedule, now) {
  const s = schedule.trim();

  // Relative: "+120s", "+5m", "+2h", "+1d"
  const relMatch = s.match(
    /^\+?\s*(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?|ms)?$/i,
  );
  if (relMatch) {
    const val = parseInt(relMatch[1], 10);
    const unit = (relMatch[2] || "ms").toLowerCase();
    const ms = _unitToMs(unit, val);
    if (ms > 0) return now + ms;
  }

  // Relative: "in 5 minutes", "in 2 hours"
  const inMatch = s.match(
    /^in\s+(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?|ms)$/i,
  );
  if (inMatch) {
    const val = parseInt(inMatch[1], 10);
    const unit = inMatch[2].toLowerCase();
    const ms = _unitToMs(unit, val);
    if (ms > 0) return now + ms;
  }

  // Pure number > 1e12 — treat as unix timestamp in ms
  if (/^\d{13,}$/.test(s)) {
    const ts = parseInt(s, 10);
    if (ts > now - 86400000) return ts; // sanity: not more than 1 day in the past
  }

  // Pure number < 1e12 — treat as seconds from now
  if (/^\d+$/.test(s)) {
    const val = parseInt(s, 10);
    if (val <= 0) return NaN;
    // If it looks like seconds (< 1e8), treat as seconds from now
    if (val < 1e8) return now + val * 1000;
    // Otherwise treat as unix timestamp in seconds
    return val * 1000;
  }

  // ISO 8601 or any Date-parseable string
  const ts = new Date(s).getTime();
  if (!isNaN(ts) && ts > now - 86400000) return ts;

  return NaN;
}

/**
 * Parse an interval value into milliseconds.
 * Supports: "300000", "5m", "2h", "30s", "1d"
 */
function _parseIntervalMs(schedule) {
  const s = schedule.trim();

  const match = s.match(
    /^(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?|ms)?$/i,
  );
  if (match) {
    const val = parseInt(match[1], 10);
    const unit = (match[2] || "ms").toLowerCase();
    return _unitToMs(unit, val);
  }

  // Bare number — assume milliseconds
  const n = parseInt(s, 10);
  return isNaN(n) || n <= 0 ? NaN : n;
}

function _unitToMs(unit, val) {
  switch (unit) {
    case "ms":
      return val;
    case "s":
    case "sec":
    case "second":
    case "seconds":
      return val * 1000;
    case "m":
    case "min":
    case "minute":
    case "minutes":
      return val * 60_000;
    case "h":
    case "hr":
    case "hour":
    case "hours":
      return val * 3600_000;
    case "d":
    case "day":
    case "days":
      return val * 86400_000;
    default:
      return val;
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function _formatTask(t) {
  return {
    id: t.id,
    name: t.name,
    type: t.type,
    schedule: t.schedule,
    enabled: !!t.enabled,
    agentId: t.agentId,
    prompt: t.prompt,
    runCount: t.runCount || 0,
    lastRunAt: t.lastRunAt ? new Date(t.lastRunAt).toISOString() : null,
    nextRunAt: t.nextRunAt ? new Date(t.nextRunAt).toISOString() : null,
  };
}

/**
 * Simple cron next-run calculator.
 * Supports standard 5-field cron: minute hour day-of-month month day-of-week.
 * Returns the next timestamp in ms after `afterMs`.
 */
function _nextCronRun(cronExpr, afterMs) {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) {
    // Fallback: run in 60 seconds if we can't parse
    return afterMs + 60_000;
  }

  const [minF, hourF, domF, monF, dowF] = fields;
  const start = new Date(afterMs + 60_000); // Start checking from next minute
  start.setSeconds(0, 0);

  // Brute-force search: check each minute for the next 48 hours
  const limit = 48 * 60;
  for (let i = 0; i < limit; i++) {
    const candidate = new Date(start.getTime() + i * 60_000);
    if (
      _cronFieldMatches(minF, candidate.getMinutes()) &&
      _cronFieldMatches(hourF, candidate.getHours()) &&
      _cronFieldMatches(domF, candidate.getDate()) &&
      _cronFieldMatches(monF, candidate.getMonth() + 1) &&
      _cronFieldMatches(dowF, candidate.getDay())
    ) {
      return candidate.getTime();
    }
  }

  // If nothing found in 48h, default to 1 hour from now
  return afterMs + 3600_000;
}

function _cronFieldMatches(field, value) {
  if (field === "*") return true;

  // Handle step values: */5, */10
  if (field.startsWith("*/")) {
    const step = parseInt(field.slice(2), 10);
    return value % step === 0;
  }

  // Handle ranges: 1-5
  if (field.includes("-")) {
    const [lo, hi] = field.split("-").map(Number);
    return value >= lo && value <= hi;
  }

  // Handle lists: 1,3,5
  if (field.includes(",")) {
    return field.split(",").map(Number).includes(value);
  }

  // Exact match
  return parseInt(field, 10) === value;
}

module.exports = SchedulerRuntime;
