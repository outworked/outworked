import { useState, useEffect, useCallback, useRef } from 'react';
import { listAllFiles, FileMeta } from '../lib/filesystem';
import {
  isElectron,
  watchWorkspace,
  onFileTreeChanged,
  onFileChanged,
  gitIsRepo,
  gitStatus,
  gitDiff,
  gitDiffStat,
  GitStatusFile,
} from '../lib/terminal';

interface WorkspacePanelProps {
  workspaceDir: string | null;
}

type TabMode = 'files' | 'changes';

// ─── Tree helpers ────────────────────────────────────────────────

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
  meta?: FileMeta;
  gitStatus?: string; // M, A, D, ??, etc.
}

function buildTree(files: FileMeta[], gitFiles: Map<string, string>): TreeNode[] {
  const root: TreeNode = { name: '', path: '', isDir: true, children: [] };

  for (const file of files) {
    const parts = file.path.replace(/^\/+/, '').split('/');
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const childPath = parts.slice(0, i + 1).join('/');
      let child = current.children.find(c => c.name === part && c.isDir === !isLast);
      if (!child) {
        child = {
          name: part,
          path: childPath,
          isDir: !isLast,
          children: [],
          meta: isLast ? file : undefined,
          gitStatus: isLast ? gitFiles.get(childPath) : undefined,
        };
        current.children.push(child);
      }
      current = child;
    }
  }

  // Sort: directories first, then alphabetical
  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) if (n.isDir) sortNodes(n.children);
  };
  sortNodes(root.children);

  // Propagate git status to parent directories
  const propagateStatus = (nodes: TreeNode[]): boolean => {
    let hasChanges = false;
    for (const node of nodes) {
      if (node.isDir) {
        const childHasChanges = propagateStatus(node.children);
        if (childHasChanges) {
          node.gitStatus = 'M'; // directory contains changes
          hasChanges = true;
        }
      } else if (node.gitStatus) {
        hasChanges = true;
      }
    }
    return hasChanges;
  };
  propagateStatus(root.children);

  return root.children;
}

function fileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: '🟦', tsx: '⚛️', js: '🟨', jsx: '⚛️',
    json: '📋', md: '📝', css: '🎨', html: '🌐',
    py: '🐍', sh: '⚙️', yml: '📄', yaml: '📄',
    txt: '📄', toml: '📄', lock: '🔒', env: '🔑',
  };
  return map[ext] ?? '📄';
}

function statusBadge(status: string | undefined): string {
  if (!status) return '';
  switch (status) {
    case 'M': return 'M';
    case 'A': return 'A';
    case 'D': return 'D';
    case '??': return 'U';
    case 'R': return 'R';
    default: return status;
  }
}

function statusColor(status: string | undefined): string {
  if (!status) return '';
  switch (status) {
    case 'M': return 'text-amber-400';
    case 'A': return 'text-green-400';
    case 'D': return 'text-red-400';
    case '??': return 'text-emerald-400';
    case 'R': return 'text-blue-400';
    default: return 'text-slate-400';
  }
}

export default function WorkspacePanel({ workspaceDir }: WorkspacePanelProps) {
  const [mode, setMode] = useState<TabMode>('files');
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [gitFiles, setGitFiles] = useState<Map<string, string>>(new Map());
  const [changedFiles, setChangedFiles] = useState<GitStatusFile[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [selectedDiffFile, setSelectedDiffFile] = useState<string | null>(null);
  const [diffContent, setDiffContent] = useState<string>('');
  const [diffStatContent, setDiffStatContent] = useState<string>('');
  const [recentChanges, setRecentChanges] = useState<{ file: string; type: string; time: number }[]>([]);
  const [loading, setLoading] = useState(false);
  const isRepoRef = useRef<boolean | null>(null);
  const mountedRef = useRef(true);

  // Load files
  const refreshFiles = useCallback(async () => {
    const fileList = await listAllFiles();
    if (mountedRef.current) setFiles(fileList);
  }, []);

  // Load git status
  const refreshGitStatus = useCallback(async () => {
    if (!workspaceDir) return;
    if (isRepoRef.current === null) isRepoRef.current = await gitIsRepo(workspaceDir);
    if (!isRepoRef.current) return;
    const result = await gitStatus(workspaceDir);
    if (!mountedRef.current) return;
    if (result.ok && result.files) {
      const map = new Map<string, string>();
      for (const f of result.files) {
        map.set(f.path, f.status);
      }
      setGitFiles(map);
      setChangedFiles(result.files);
    }
  }, [workspaceDir]);

  // Load diff stat
  const refreshDiffStat = useCallback(async () => {
    if (!workspaceDir) return;
    if (isRepoRef.current === null) isRepoRef.current = await gitIsRepo(workspaceDir);
    if (!isRepoRef.current) return;
    const result = await gitDiffStat(workspaceDir);
    if (mountedRef.current && result.ok) {
      setDiffStatContent(result.stat || '');
    }
  }, [workspaceDir]);

  // Initial load + set up watcher
  useEffect(() => {
    mountedRef.current = true;
    isRepoRef.current = null; // reset cache on workspace change
    refreshFiles();
    refreshGitStatus();
    refreshDiffStat();

    if (isElectron() && workspaceDir) {
      watchWorkspace(workspaceDir);
    }

    return () => {
      mountedRef.current = false;
    };
  }, [workspaceDir, refreshFiles, refreshGitStatus, refreshDiffStat]);

  // Listen for file tree changes (debounced from main process)
  useEffect(() => {
    if (!isElectron()) return;
    const unsub = onFileTreeChanged(() => {
      refreshFiles();
      refreshGitStatus();
      refreshDiffStat();
    });
    return unsub;
  }, [refreshFiles, refreshGitStatus, refreshDiffStat]);

  // Listen for individual file change events (for the activity feed)
  useEffect(() => {
    if (!isElectron()) return;
    const unsub = onFileChanged((data) => {
      setRecentChanges(prev => {
        const next = [{ file: data.filename, type: data.eventType, time: Date.now() }, ...prev];
        return next.slice(0, 50); // keep last 50
      });
    });
    return unsub;
  }, []);

  const toggleDir = useCallback((path: string) => {
    setExpandedDirs(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // Load diff for a specific file
  const loadFileDiff = useCallback(async (filepath: string) => {
    if (!workspaceDir) return;
    setLoading(true);
    setSelectedDiffFile(filepath);
    const result = await gitDiff(workspaceDir, undefined, filepath);
    if (mountedRef.current) {
      setDiffContent(result.ok ? (result.diff || '(no diff — file may be untracked)') : (result.error || 'Error loading diff'));
      setLoading(false);
    }
  }, [workspaceDir]);

  const tree = buildTree(files, gitFiles);

  return (
    <div className="flex flex-col h-full bg-slate-950 text-gray-200">
      {/* Sub-tabs */}
      <div className="flex border-b border-slate-700 bg-slate-900">
        <button
          onClick={() => setMode('files')}
          className={`flex-1 py-1.5 text-[11px] font-pixel transition-colors ${mode === 'files' ? 'text-green-400 border-b-2 border-green-500 bg-slate-800' : 'text-slate-400 hover:text-slate-200'}`}
        >
          📁 Files ({files.length})
        </button>
        <button
          onClick={() => setMode('changes')}
          className={`flex-1 py-1.5 text-[11px] font-pixel transition-colors ${mode === 'changes' ? 'text-green-400 border-b-2 border-green-500 bg-slate-800' : 'text-slate-400 hover:text-slate-200'}`}
        >
          {changedFiles.length > 0 ? (
            <span className="text-amber-400">
              ● Changes ({changedFiles.length})
            </span>
          ) : (
            'Changes'
          )}
        </button>
      </div>

      {/* Activity ticker */}
      {recentChanges.length > 0 && (
        <div className="px-3 py-1 bg-slate-900/60 border-b border-slate-700/50 overflow-hidden">
          <div className="flex items-center gap-2">
            <span className="text-[9px] font-pixel text-emerald-500 shrink-0 animate-pulse">LIVE</span>
            <span className="text-[10px] font-mono text-slate-400 truncate">
              {recentChanges[0].file}
              <span className="text-slate-500 ml-1">
                ({recentChanges[0].type === 'rename' ? 'created/deleted' : 'modified'})
              </span>
            </span>
          </div>
        </div>
      )}

      {mode === 'files' ? (
        /* ─── Live File Tree ─── */
        <div className="flex-1 overflow-y-auto">
          {files.length === 0 ? (
            <div className="text-slate-400 text-[11px] font-mono text-center pt-8 px-3">
              No files yet.<br />
              Ask an agent to write code and files will appear here.
            </div>
          ) : (
            <div className="py-1">
              {tree.map(node => (
                <FileTreeNode
                  key={node.path}
                  node={node}
                  depth={0}
                  expandedDirs={expandedDirs}
                  toggleDir={toggleDir}
                />
              ))}
            </div>
          )}
        </div>
      ) : (
        /* ─── Git Changes ─── */
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Diff stat summary */}
          {diffStatContent && (
            <div className="px-3 py-2 bg-slate-900/50 border-b border-slate-700/50">
              <pre className="text-[10px] font-mono text-slate-400 whitespace-pre-wrap leading-relaxed">
                {diffStatContent}
              </pre>
            </div>
          )}

          {/* Changed files list */}
          <div className={`overflow-y-auto ${selectedDiffFile ? 'max-h-40 shrink-0' : 'flex-1'} border-b border-slate-700/50`}>
            {changedFiles.length === 0 ? (
              <div className="text-slate-400 text-[11px] font-mono text-center pt-8 px-3">
                No uncommitted changes.<br />
                Working tree is clean.
              </div>
            ) : (
              <div className="py-1">
                {changedFiles.map(f => (
                  <button
                    key={f.path}
                    onClick={() => loadFileDiff(f.path)}
                    className={`w-full flex items-center gap-2 py-[3px] px-3 hover:bg-slate-800/60 transition-colors text-left ${
                      selectedDiffFile === f.path ? 'bg-slate-800/80' : ''
                    }`}
                  >
                    <span className={`text-[11px] font-mono font-bold w-4 shrink-0 text-center ${statusColor(f.status)}`}>
                      {statusBadge(f.status)}
                    </span>
                    <span className="text-[12px] shrink-0">{fileIcon(f.path.split('/').pop() || '')}</span>
                    <span className={`text-[12px] font-mono truncate ${
                      selectedDiffFile === f.path ? 'text-green-400' : 'text-slate-300'
                    }`}>
                      {f.path}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Diff viewer */}
          {selectedDiffFile && (
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="flex items-center justify-between px-3 py-1.5 bg-slate-900 border-b border-slate-700">
                <span className="text-[11px] font-mono text-slate-300 truncate">
                  {selectedDiffFile}
                </span>
                <button
                  onClick={() => { setSelectedDiffFile(null); setDiffContent(''); }}
                  className="text-[10px] text-slate-400 hover:text-white shrink-0 ml-2"
                >
                  ✕
                </button>
              </div>
              <div className="flex-1 overflow-auto">
                {loading ? (
                  <div className="text-slate-400 text-[11px] font-mono text-center pt-4 animate-pulse">
                    Loading diff...
                  </div>
                ) : (
                  <pre className="px-3 py-2 text-[11px] font-mono leading-relaxed whitespace-pre-wrap break-all">
                    {diffContent.split('\n').map((line, i) => (
                      <div
                        key={i}
                        className={
                          line.startsWith('+') && !line.startsWith('+++')
                            ? 'text-green-400 bg-green-950/30'
                            : line.startsWith('-') && !line.startsWith('---')
                            ? 'text-red-400 bg-red-950/30'
                            : line.startsWith('@@')
                            ? 'text-cyan-400'
                            : line.startsWith('diff ') || line.startsWith('index ')
                            ? 'text-slate-500'
                            : 'text-slate-300'
                        }
                      >
                        {line}
                      </div>
                    ))}
                  </pre>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Recursive tree node component ──────────────────────────────

interface FileTreeNodeProps {
  node: TreeNode;
  depth: number;
  expandedDirs: Set<string>;
  toggleDir: (path: string) => void;
}

function FileTreeNode({ node, depth, expandedDirs, toggleDir }: FileTreeNodeProps) {
  const indent = depth * 16;
  const isOpen = expandedDirs.has(node.path);

  if (node.isDir) {
    return (
      <>
        <button
          onClick={() => toggleDir(node.path)}
          className="w-full flex items-center gap-1.5 py-[3px] hover:bg-slate-800/60 transition-colors text-left group"
          style={{ paddingLeft: `${8 + indent}px` }}
        >
          <span className="text-[11px] text-slate-400 w-3 text-center shrink-0">
            {isOpen ? '▾' : '▸'}
          </span>
          <span className="text-[12px] shrink-0">{isOpen ? '📂' : '📁'}</span>
          <span className="text-[12px] font-mono text-slate-200 truncate">{node.name}</span>
          {node.gitStatus && (
            <span className={`text-[9px] font-mono font-bold ml-1 ${statusColor(node.gitStatus)}`}>●</span>
          )}
          <span className="text-[12px] font-mono text-slate-400 ml-auto pr-3 opacity-0 group-hover:opacity-100 transition-opacity">
            {node.children.length}
          </span>
        </button>
        {isOpen && node.children.map(child => (
          <FileTreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            expandedDirs={expandedDirs}
            toggleDir={toggleDir}
          />
        ))}
      </>
    );
  }

  return (
    <button
      className="w-full flex items-center gap-1.5 py-[3px] hover:bg-slate-800/60 transition-colors text-left"
      style={{ paddingLeft: `${8 + indent + 16}px` }}
    >
      <span className="text-[12px] shrink-0">{fileIcon(node.name)}</span>
      <span className="text-[12px] font-mono text-slate-300 truncate">{node.name}</span>
      {node.gitStatus && (
        <span className={`text-[9px] font-mono font-bold ml-auto pr-3 ${statusColor(node.gitStatus)}`}>
          {statusBadge(node.gitStatus)}
        </span>
      )}
    </button>
  );
}
