// Filesystem layer — uses real local filesystem via Electron IPC,
// falls back to in-memory (localStorage) when running in browser (npm run dev)

export interface FileEntry {
  path: string;
  content: string;
  updatedAt: number;
}

export interface FileMeta {
  path: string;
  size: number;
  updatedAt: number;
}

// ─── Electron bridge types ────────────────────────────────────────

export interface SearchResult {
  path: string;
  size: number;
  updatedAt: number;
  matchType: 'filename' | 'content';
  snippet: string;
}

interface ElectronFsAPI {
  getWorkspace: () => Promise<string>;
  setWorkspace: (dir: string) => Promise<string>;
  pickWorkspace: () => Promise<string | null>;
  writeFile: (path: string, content: string) => Promise<{ ok: boolean; bytes: number }>;
  readFile: (path: string) => Promise<{ ok: boolean; content?: string; error?: string }>;
  deleteFile: (path: string) => Promise<{ ok: boolean; error?: string }>;
  listFiles: (dir?: string) => Promise<{ path: string; size: number; updatedAt: number }[]>;
  listAllFiles: () => Promise<FileMeta[]>;
  getAllFiles: () => Promise<FileEntry[]>;
  searchFiles: (keywords: string[], maxResults?: number) => Promise<SearchResult[]>;
}

interface PermissionsAPI {
  check: (dirPath: string) => Promise<{ ok: boolean; exists?: boolean; writable?: boolean; readable?: boolean; error?: string }>;
  repair: (dirPath: string) => Promise<{ ok: boolean; issues?: { path: string; fixed: boolean; type: string; error?: string }[]; created?: boolean; error?: string }>;
  ensureDir: (dirPath: string) => Promise<{ ok: boolean; error?: string }>;
}

function getElectronFs(): ElectronFsAPI | null {
  const w = window as unknown as { electronAPI?: { isElectron: boolean; fs: ElectronFsAPI } };
  return w.electronAPI?.isElectron ? w.electronAPI.fs : null;
}

function getPermissionsAPI(): PermissionsAPI | null {
  const w = window as unknown as { electronAPI?: { isElectron: boolean; permissions: PermissionsAPI } };
  return w.electronAPI?.isElectron ? w.electronAPI.permissions : null;
}

export function isRealFs(): boolean {
  return getElectronFs() !== null;
}

// ─── Workspace helpers ────────────────────────────────────────────

export async function getWorkspace(): Promise<string> {
  const api = getElectronFs();
  if (!api) return '(in-memory)';
  return api.getWorkspace();
}

export async function setWorkspace(dir: string): Promise<string> {
  const api = getElectronFs();
  if (!api) return '(in-memory)';
  return api.setWorkspace(dir);
}

export async function pickWorkspace(): Promise<string | null> {
  const api = getElectronFs();
  if (!api) return null;
  return api.pickWorkspace();
}

// ─── Core file operations ─────────────────────────────────────────

export async function writeFile(path: string, content: string): Promise<string> {
  const api = getElectronFs();
  if (api) {
    const result = await api.writeFile(path, content);
    return `Wrote ${result.bytes} bytes to ${path}`;
  }
  // Browser fallback
  fallbackWrite(path, content);
  return `Wrote ${content.length} bytes to ${path}`;
}

export async function readFile(path: string): Promise<string> {
  const api = getElectronFs();
  if (api) {
    const result = await api.readFile(path);
    if (!result.ok) return `Error: ${result.error}`;
    return result.content!;
  }
  return fallbackRead(path);
}

export async function listFiles(directory?: string): Promise<string> {
  const api = getElectronFs();
  if (api) {
    const entries = await api.listFiles(directory);
    const paths = entries.map(e => e.path).sort();
    return paths.length > 0 ? paths.join('\n') : directory ? `No files in ${directory}` : 'No files yet';
  }
  return fallbackList(directory);
}

export async function deleteFile(path: string): Promise<string> {
  const api = getElectronFs();
  if (api) {
    const result = await api.deleteFile(path);
    if (!result.ok) return `Error: ${result.error}`;
    return `Deleted ${path}`;
  }
  return fallbackDelete(path);
}

export async function getAllFiles(): Promise<FileEntry[]> {
  const api = getElectronFs();
  if (api) {
    return api.getAllFiles();
  }
  return fallbackGetAll();
}

export async function listAllFiles(): Promise<FileMeta[]> {
  const api = getElectronFs();
  if (api) {
    return api.listAllFiles();
  }
  // Browser fallback: derive metadata from stored entries
  return fallbackGetAll().map(f => ({ path: f.path, size: f.content.length, updatedAt: f.updatedAt }));
}

export async function searchFiles(keywords: string[], maxResults = 50): Promise<SearchResult[]> {
  const api = getElectronFs();
  if (api) {
    return api.searchFiles(keywords, maxResults);
  }
  // Browser fallback: search in-memory files
  const files = fallbackGetAll();
  const patterns = keywords.map(k => new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  const results: SearchResult[] = [];
  for (const f of files) {
    if (results.length >= maxResults) break;
    const nameMatch = patterns.some(p => p.test(f.path.split('/').pop() || ''));
    if (nameMatch) {
      results.push({ path: f.path, size: f.content.length, updatedAt: f.updatedAt, matchType: 'filename', snippet: '' });
      continue;
    }
    for (const pat of patterns) {
      const match = f.content.match(pat);
      if (match) {
        const idx = match.index || 0;
        const start = Math.max(0, idx - 40);
        const end = Math.min(f.content.length, idx + match[0].length + 40);
        results.push({ path: f.path, size: f.content.length, updatedAt: f.updatedAt, matchType: 'content', snippet: f.content.slice(start, end) });
        break;
      }
    }
  }
  return results;
}

// ─── Browser fallback (localStorage) ──────────────────────────────

const STORAGE_KEY = 'outworked_files';

function fallbackLoad(): Map<string, FileEntry> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Map();
    const arr: FileEntry[] = JSON.parse(raw);
    return new Map(arr.map(f => [f.path, f]));
  } catch {
    return new Map();
  }
}

function fallbackPersist(files: Map<string, FileEntry>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...files.values()]));
}

function fallbackWrite(p: string, content: string) {
  const files = fallbackLoad();
  files.set(p, { path: p, content, updatedAt: Date.now() });
  fallbackPersist(files);
}

function fallbackRead(p: string): string {
  const file = fallbackLoad().get(p);
  return file ? file.content : `Error: File not found: ${p}`;
}

function fallbackList(directory?: string): string {
  let paths = [...fallbackLoad().keys()].sort();
  if (directory) {
    const prefix = directory.endsWith('/') ? directory : directory + '/';
    paths = paths.filter(p => p.startsWith(prefix));
  }
  return paths.length > 0 ? paths.join('\n') : directory ? `No files in ${directory}` : 'No files yet';
}

function fallbackDelete(p: string): string {
  const files = fallbackLoad();
  if (!files.has(p)) return `Error: File not found: ${p}`;
  files.delete(p);
  fallbackPersist(files);
  return `Deleted ${p}`;
}

function fallbackGetAll(): FileEntry[] {
  return [...fallbackLoad().values()].sort((a, b) => a.path.localeCompare(b.path));
}

// ─── Permissions ──────────────────────────────────────────────────

export async function checkPermissions(dirPath: string) {
  const api = getPermissionsAPI();
  if (!api) return { ok: true, exists: true, writable: true, readable: true };
  return api.check(dirPath);
}

export async function repairPermissions(dirPath: string) {
  const api = getPermissionsAPI();
  if (!api) return { ok: true, issues: [] };
  return api.repair(dirPath);
}

export async function ensureDirectory(dirPath: string) {
  const api = getPermissionsAPI();
  if (!api) return { ok: true };
  return api.ensureDir(dirPath);
}
