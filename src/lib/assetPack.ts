// ─── User-Configurable Asset Packs ─────────────────────────────
//
// Lets users drop sprite packs into ~/.outworked/assets/ to
// replace the default procedural characters (and eventually furniture).
// Uses the Electron IPC bridge; falls back gracefully in non-Electron.

import type { AnimState } from "../phaser/SpriteGen";

// ─── Types ─────────────────────────────────────────────────────

export interface EmployeeCategoryConfig {
  frameSize?: number; // shorthand for square frames (default: auto-detect)
  frameWidth?: number; // explicit frame width (default: auto-detect)
  frameHeight?: number; // explicit frame height (default: auto-detect)
  framesPerState?: number; // defaults to auto-detect from sheet dimensions
  /** Map animation state to row index in grid sheets (e.g. { idle: 0, walk: 2 }) */
  rows?: Partial<Record<AnimState, number>>;
  /**
   * Order of states in a horizontal strip (default: ["idle", "walk", "type", "think"]).
   * Use this to remap which section of your strip plays for which state.
   * E.g. ["idle", "idle", "walk", "think"] if your strip has no typing animation.
   */
  states?: AnimState[];
  /** Per-state frame rates (default: { idle: 2, walk: 5, type: 6, think: 2 }) */
  frameRates?: Partial<Record<AnimState, number>>;
  sheets: Record<string, string>; // role|"default" -> relative path to PNG
}

export interface FurnitureItemConfig {
  file: string; // relative path to PNG
  desk?: boolean; // true = agents can work here
  tilesWide?: number; // auto-detected from image if omitted
  tilesTall?: number; // auto-detected from image if omitted
}

export interface FurnitureCategoryConfig {
  items: Record<string, FurnitureItemConfig | string>;
  // string shorthand: just a file path, everything auto-detected
}

export interface BackgroundConfig {
  file: string; // relative path to PNG
  mode?: "stretch" | "tile" | "cover"; // default: "cover"
}

export interface FontConfig {
  file: string; // relative path to .ttf, .woff, or .woff2
  name?: string; // font family name (default: "CustomPixelFont")
}

export interface AssetPackManifest {
  name: string;
  author?: string;
  version?: string;
  categories: {
    employees?: EmployeeCategoryConfig;
    furniture?: FurnitureCategoryConfig;
    background?: BackgroundConfig | string; // string shorthand = file path
    font?: FontConfig | string; // string shorthand = file path
    [key: string]: unknown;
  };
}

export interface AssetPack {
  id: string; // directory name
  manifest: AssetPackManifest;
}

// ─── IPC API ───────────────────────────────────────────────────

function getAPI(): {
  listPacks: () => Promise<AssetPack[]>;
  getActivePack: () => Promise<string | null>;
  setActivePack: (packId: string | null) => Promise<void>;
  importPack: () => Promise<string | null>;
  openFolder: () => Promise<void>;
  getReadme: () => Promise<string>;
} | null {
  const w = window as unknown as {
    electronAPI?: { assets?: Record<string, unknown> };
  };
  return (w.electronAPI?.assets as ReturnType<typeof getAPI>) ?? null;
}

/** List all available asset packs in ~/.outworked/assets/ */
export async function listAssetPacks(): Promise<AssetPack[]> {
  const api = getAPI();
  if (api) return api.listPacks();
  return [];
}

/** Get the currently active pack ID, or null if using default procedural sprites. */
export async function getActivePack(): Promise<string | null> {
  const api = getAPI();
  if (api) return api.getActivePack();
  return null;
}

/** Set the active pack by ID, or null to revert to procedural sprites. */
export async function setActivePack(
  packId: string | null,
): Promise<void> {
  const api = getAPI();
  if (api) await api.setActivePack(packId);
}

/**
 * Open a native folder picker and copy the selected folder to ~/.outworked/assets/.
 * Returns the new pack folder name, or null if cancelled.
 */
export async function importAssetPack(): Promise<string | null> {
  const api = getAPI();
  if (api) return api.importPack();
  return null;
}

/** Get the assets.md documentation content. */
export async function getAssetsReadme(): Promise<string> {
  const api = getAPI();
  if (api) return api.getReadme();
  return "";
}

/** Open the ~/.outworked/assets/ folder in the native file manager. */
export async function openAssetsFolder(): Promise<void> {
  const api = getAPI();
  if (api) await api.openFolder();
}

/** Normalize a furniture item entry (string shorthand or full config). */
export function normalizeFurnitureItem(
  key: string,
  entry: FurnitureItemConfig | string,
): FurnitureItemConfig & { desk: boolean } {
  const config = typeof entry === "string" ? { file: entry } : entry;
  // Auto-detect desk from key/filename
  const name = key.toLowerCase();
  const isDesk =
    config.desk ??
    (name === "desk" || name.startsWith("desk_") || name.startsWith("desk-"));
  return { ...config, desk: isDesk };
}

/** Get the URL for a furniture item PNG. */
export function furnitureItemUrl(packId: string, config: FurnitureItemConfig): string {
  const encodedId = encodeURIComponent(packId);
  const encodedFile = config.file.split("/").map(encodeURIComponent).join("/");
  return `user-assets://${encodedId}/${encodedFile}`;
}

/**
 * Resolve the sprite sheet URL for a given agent role within a pack.
 * Tries to match the role name to a sheet key, falling back to "default".
 * Returns null if the pack has no employees category.
 */
export function resolveEmployeeSheetUrl(
  pack: AssetPack,
  agentRole: string,
): string | null {
  const employees = pack.manifest.categories.employees;
  if (!employees) return null;

  const role = agentRole.toLowerCase();
  const sheetPath = employees.sheets[role] ?? employees.sheets["default"];
  if (!sheetPath) return null;

  const encodedId = encodeURIComponent(pack.id);
  const encodedPath = sheetPath.split("/").map(encodeURIComponent).join("/");
  return `user-assets://${encodedId}/${encodedPath}`;
}

// ─── Custom Font ───────────────────────────────────────────────

let activeCustomFontStyle: HTMLStyleElement | null = null;

/**
 * Load and apply a custom font from the active asset pack.
 * Injects an @font-face rule and updates the --font-pixel CSS variable.
 * Call with null to revert to the default font.
 */
export async function applyCustomFont(
  pack: AssetPack | null,
): Promise<void> {
  // Remove previous custom font
  if (activeCustomFontStyle) {
    activeCustomFontStyle.remove();
    activeCustomFontStyle = null;
  }
  // Reset to default
  document.documentElement.style.removeProperty("--font-pixel");

  if (!pack) return;
  const fontCat = pack.manifest.categories.font;
  if (!fontCat) return;

  const config = typeof fontCat === "string" ? { file: fontCat } : fontCat;
  const fontName = config.name ?? "CustomPixelFont";
  const url = `user-assets://${encodeURIComponent(pack.id)}/${config.file.split("/").map(encodeURIComponent).join("/")}`;

  // Determine format from extension
  const ext = config.file.split(".").pop()?.toLowerCase();
  const format =
    ext === "woff2" ? "woff2" : ext === "woff" ? "woff" : "truetype";

  // Inject @font-face
  const style = document.createElement("style");
  style.textContent = `
    @font-face {
      font-family: "${fontName}";
      src: url("${url}") format("${format}");
      font-display: swap;
    }
  `;
  document.head.appendChild(style);
  activeCustomFontStyle = style;

  // Wait for the font to load
  try {
    await document.fonts.load(`10px "${fontName}"`);
  } catch {
    // Font may still work even if load() rejects
  }

  // Override the CSS variable
  document.documentElement.style.setProperty(
    "--font-pixel",
    `"${fontName}", "Courier New", monospace`,
  );
}
