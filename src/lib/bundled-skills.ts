// Skills — dynamically fetched from skill-runtime-manager via IPC,
// with static fallback for builds without Electron.

import browserRaw from "../../electron/skills/browser/SKILL.md?raw";
import schedulerRaw from "../../electron/skills/scheduler/SKILL.md?raw";

import { AgentSkill } from "./types";
import { parseSkill } from "./skill-parser";

// ── Static fallback (used when IPC is unavailable) ───────────────

const STATIC_RAW: Record<string, string> = {
  browser: browserRaw,
  scheduler: schedulerRaw,
};

let _staticCache: AgentSkill[] | null = null;

function getStaticSkills(): AgentSkill[] {
  if (_staticCache) return _staticCache;
  _staticCache = Object.entries(STATIC_RAW).map(([slug, raw]) => {
    const skill = parseSkill(raw);
    skill.id = `bundled:${slug}`;
    return skill;
  });
  return _staticCache;
}

// ── Dynamic skill fetching (IPC to main process) ────────────────

interface SkillDocEntry {
  name: string;
  status: string;
  doc: string | null;
}

let _dynamicCache: AgentSkill[] | null = null;
let _dynamicCacheTime = 0;
const CACHE_TTL_MS = 5_000; // refresh every 5s

function getElectronAPI(): { skillRuntimeGetDocs?: (opts?: { connectedOnly?: boolean }) => Promise<SkillDocEntry[]> } | null {
  const w = window as unknown as { electronAPI?: Record<string, unknown> };
  return (w.electronAPI as ReturnType<typeof getElectronAPI>) ?? null;
}

/**
 * Fetch all available skills dynamically from the skill-runtime-manager.
 * Falls back to static bundled skills if IPC is unavailable.
 */
export async function fetchAvailableSkills(): Promise<AgentSkill[]> {
  const api = getElectronAPI();
  if (!api?.skillRuntimeGetDocs) {
    return getStaticSkills();
  }

  // Use cached result if fresh
  if (_dynamicCache && Date.now() - _dynamicCacheTime < CACHE_TTL_MS) {
    return _dynamicCache;
  }

  try {
    const docs = await api.skillRuntimeGetDocs();
    const skills: AgentSkill[] = [];

    for (const entry of docs) {
      if (!entry.doc) continue;
      const skill = parseSkill(entry.doc);
      skill.id = `bundled:${entry.name}`;
      skills.push(skill);
    }

    _dynamicCache = skills;
    _dynamicCacheTime = Date.now();
    return skills;
  } catch (err) {
    console.warn("[bundled-skills] Dynamic fetch failed, using static fallback:", err);
    return getStaticSkills();
  }
}

/**
 * Resolve a single skill by ID or slug.
 * Supports full IDs (e.g. "bundled:browser", "custom:uuid") and bare slugs.
 * Looks up bundled skills first, then custom skills from the database.
 */
export async function fetchSkill(idOrSlug: string): Promise<AgentSkill | undefined> {
  const skills = await fetchAvailableSkills();

  // Try exact ID match first
  const byId = skills.find((s) => s.id === idOrSlug);
  if (byId) return byId;

  // Try as bare slug (legacy: "browser" → "bundled:browser")
  const bySlug = skills.find((s) => s.id === `bundled:${idOrSlug}`);
  if (bySlug) return bySlug;

  // Try custom skills from DB
  if (idOrSlug.startsWith("custom:")) {
    try {
      const w = window as unknown as {
        electronAPI?: {
          db?: {
            customSkillGet?: (id: string) => Promise<{
              id: string; name: string; description: string;
              content: string; emoji?: string;
            } | null>;
          };
        };
      };
      const record = await w.electronAPI?.db?.customSkillGet?.(idOrSlug);
      if (record) {
        return {
          id: record.id,
          name: record.emoji ? `${record.emoji} ${record.name}` : record.name,
          content: record.content,
          description: record.description,
        };
      }
    } catch {
      // DB unavailable
    }
  }

  return undefined;
}
