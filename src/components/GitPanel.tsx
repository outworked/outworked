import { useState, useEffect, useCallback, useRef } from 'react';
import {
  gitStatusDetailed,
  gitBranchInfo,
  gitDiff,
  gitDiffStaged,
  gitDiffStat,
  gitLog,
  gitStage,
  gitUnstage,
  gitCommit,
  gitCreateBranch,
  gitCheckoutBranch,
  gitPush,
  gitCreatePr,
  onFileTreeChanged,
  isElectron,
  GitStatusFile,
  GitBranchInfoResult,
} from '../lib/terminal';

interface GitPanelProps {
  workspaceDir: string | null;
}

type SubTab = 'status' | 'log' | 'pr';

function statusLabel(s: string): string {
  switch (s) {
    case 'M': return 'modified';
    case 'A': return 'added';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    case '??': return 'untracked';
    default: return s;
  }
}

function statusColor(s: string): string {
  switch (s) {
    case 'M': return 'text-amber-400';
    case 'A': return 'text-green-400';
    case 'D': return 'text-red-400';
    case '??': return 'text-emerald-400';
    case 'R': return 'text-blue-400';
    default: return 'text-slate-400';
  }
}

function fileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: '🟦', tsx: '⚛️', js: '🟨', jsx: '⚛️',
    json: '📋', md: '📝', css: '🎨', html: '🌐',
    py: '🐍', sh: '⚙️', yml: '📄', yaml: '📄',
  };
  return map[ext] ?? '📄';
}

export default function GitPanel({ workspaceDir }: GitPanelProps) {
  const [tab, setTab] = useState<SubTab>('status');
  const [branchInfo, setBranchInfo] = useState<GitBranchInfoResult>({ ok: false });
  const [staged, setStaged] = useState<GitStatusFile[]>([]);
  const [unstaged, setUnstaged] = useState<GitStatusFile[]>([]);
  const [untracked, setUntracked] = useState<GitStatusFile[]>([]);
  const [diffContent, setDiffContent] = useState('');
  const [diffFile, setDiffFile] = useState<string | null>(null);
  const [diffIsStaged, setDiffIsStaged] = useState(false);
  const [diffStat, setDiffStat] = useState('');
  const [logContent, setLogContent] = useState('');
  const [commitMsg, setCommitMsg] = useState('');
  const [newBranch, setNewBranch] = useState('');
  const [overlay, setOverlay] = useState<'branches' | 'new-branch' | null>(null);
  const [showPrForm, setShowPrForm] = useState(false);
  const [prTitle, setPrTitle] = useState('');
  const [prBody, setPrBody] = useState('');
  const [prBase, setPrBase] = useState('main');
  const [busy, setBusy] = useState('');
  const [toast, setToast] = useState<{ msg: string; type: 'ok' | 'err' } | null>(null);
  const mountedRef = useRef(true);
  const commitInputRef = useRef<HTMLTextAreaElement>(null);

  const flash = useCallback((msg: string, type: 'ok' | 'err' = 'ok') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  }, []);

  const refreshStatus = useCallback(async () => {
    if (!workspaceDir) return;
    const [statusRes, branchRes, statRes] = await Promise.all([
      gitStatusDetailed(workspaceDir),
      gitBranchInfo(workspaceDir),
      gitDiffStat(workspaceDir),
    ]);
    if (!mountedRef.current) return;
    if (statusRes.ok) {
      setStaged(statusRes.staged || []);
      setUnstaged(statusRes.unstaged || []);
      setUntracked(statusRes.untracked || []);
    }
    if (branchRes.ok) setBranchInfo(branchRes);
    if (statRes.ok) setDiffStat(statRes.stat || '');
  }, [workspaceDir]);

  const refreshLog = useCallback(async () => {
    if (!workspaceDir) return;
    const res = await gitLog(workspaceDir);
    if (mountedRef.current && res.ok) setLogContent(res.log || '');
  }, [workspaceDir]);

  useEffect(() => {
    mountedRef.current = true;
    refreshStatus();
    refreshLog();
    return () => { mountedRef.current = false; };
  }, [workspaceDir, refreshStatus, refreshLog]);

  useEffect(() => {
    if (!isElectron()) return;
    return onFileTreeChanged(() => { refreshStatus(); refreshLog(); });
  }, [refreshStatus, refreshLog]);

  // ─── Actions ────────────────────────────────────────────────────
  const handleStageFile = useCallback(async (filepath: string) => {
    if (!workspaceDir) return;
    setBusy('stage');
    await gitStage(workspaceDir, [filepath]);
    await refreshStatus();
    setBusy('');
  }, [workspaceDir, refreshStatus]);

  const handleUnstageFile = useCallback(async (filepath: string) => {
    if (!workspaceDir) return;
    setBusy('unstage');
    await gitUnstage(workspaceDir, [filepath]);
    await refreshStatus();
    setBusy('');
  }, [workspaceDir, refreshStatus]);

  const handleStageAll = useCallback(async () => {
    if (!workspaceDir) return;
    setBusy('stage-all');
    await gitStage(workspaceDir);
    await refreshStatus();
    setBusy('');
  }, [workspaceDir, refreshStatus]);

  const handleUnstageAll = useCallback(async () => {
    if (!workspaceDir) return;
    setBusy('unstage-all');
    await gitUnstage(workspaceDir);
    await refreshStatus();
    setBusy('');
  }, [workspaceDir, refreshStatus]);

  const handleCommit = useCallback(async () => {
    if (!workspaceDir || !commitMsg.trim()) return;
    setBusy('commit');
    const res = await gitCommit(workspaceDir, commitMsg.trim());
    if (res.ok) {
      flash('Committed successfully');
      setCommitMsg('');
      await refreshStatus();
      await refreshLog();
    } else {
      flash(res.error || 'Commit failed', 'err');
    }
    setBusy('');
  }, [workspaceDir, commitMsg, refreshStatus, refreshLog, flash]);

  const handleCreateBranch = useCallback(async () => {
    if (!workspaceDir || !newBranch.trim()) return;
    setBusy('branch');
    const res = await gitCreateBranch(workspaceDir, newBranch.trim());
    if (res.ok) {
      flash(`Switched to new branch: ${res.branch}`);
      setNewBranch('');
      setOverlay(null);
      await refreshStatus();
    } else {
      flash(res.error || 'Failed to create branch', 'err');
    }
    setBusy('');
  }, [workspaceDir, newBranch, refreshStatus, flash]);

  const handleCheckout = useCallback(async (branch: string) => {
    if (!workspaceDir) return;
    setBusy('checkout');
    const res = await gitCheckoutBranch(workspaceDir, branch);
    if (res.ok) {
      flash(`Switched to ${branch}`);
      setOverlay(null);
      await refreshStatus();
      await refreshLog();
    } else {
      flash(res.error || 'Checkout failed', 'err');
    }
    setBusy('');
  }, [workspaceDir, refreshStatus, refreshLog, flash]);

  const handlePush = useCallback(async () => {
    if (!workspaceDir) return;
    setBusy('push');
    const res = await gitPush(workspaceDir, !branchInfo.remote);
    if (res.ok) {
      flash('Pushed successfully');
      await refreshStatus();
    } else {
      flash(res.error || 'Push failed', 'err');
    }
    setBusy('');
  }, [workspaceDir, branchInfo, refreshStatus, flash]);

  const handleCreatePr = useCallback(async () => {
    if (!workspaceDir || !prTitle.trim()) return;
    setBusy('pr');
    const res = await gitCreatePr(workspaceDir, prTitle.trim(), prBody, prBase || undefined);
    if (res.ok) {
      flash(`PR created: ${res.url || 'success'}`);
      setShowPrForm(false);
      setPrTitle('');
      setPrBody('');
    } else {
      flash(res.error || 'Failed to create PR', 'err');
    }
    setBusy('');
  }, [workspaceDir, prTitle, prBody, prBase, flash]);

  const handleViewDiff = useCallback(async (filepath: string, isStaged: boolean) => {
    if (!workspaceDir) return;
    setDiffFile(filepath);
    setDiffIsStaged(isStaged);
    const res = isStaged
      ? await gitDiffStaged(workspaceDir, filepath)
      : await gitDiff(workspaceDir, undefined, filepath);
    if (mountedRef.current) {
      setDiffContent(res.ok ? (res.diff || '(no diff — file may be new/untracked)') : (res.error || 'Error'));
    }
  }, [workspaceDir]);

  const totalChanges = staged.length + unstaged.length + untracked.length;

  // Sync indicator string
  const syncInfo = branchInfo.remote
    ? (branchInfo.ahead ? `↑${branchInfo.ahead} ` : '') + (branchInfo.behind ? `↓${branchInfo.behind}` : '') || '✓ synced'
    : 'local';

  return (
    <div className="flex flex-col h-full bg-slate-950 text-gray-200 relative">
      {/* ─── Header: branch + tabs in one row ─── */}
      <div className="flex items-center border-b border-slate-700 bg-slate-900 shrink-0">
        {/* Branch selector (left side) */}
        <button
          onClick={() => setOverlay(overlay === 'branches' ? null : 'branches')}
          className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-mono text-indigo-300 hover:text-indigo-200 hover:bg-slate-800/60 transition-colors border-r border-slate-700 shrink-0"
          title={`Branch: ${branchInfo.current || '...'} (${syncInfo})`}
        >
          <span className="text-indigo-400 text-[10px]">⎇</span>
          <span className="max-w-[80px] truncate">{branchInfo.current || '...'}</span>
          <span className="text-[8px] text-slate-500">▾</span>
        </button>

        {/* Tab buttons (center) */}
        <button
          onClick={() => setTab('status')}
          className={`flex-1 py-1.5 text-[10px] font-pixel transition-colors ${tab === 'status' ? 'text-green-400 border-b-2 border-green-500 bg-slate-800' : 'text-slate-400 hover:text-slate-200'}`}
        >
          {totalChanges > 0 ? <span className="text-amber-400">●{totalChanges}</span> : 'Status'}
        </button>
        <button
          onClick={() => { setTab('log'); refreshLog(); }}
          className={`flex-1 py-1.5 text-[10px] font-pixel transition-colors ${tab === 'log' ? 'text-green-400 border-b-2 border-green-500 bg-slate-800' : 'text-slate-400 hover:text-slate-200'}`}
        >
          Log
        </button>
        <button
          onClick={() => setTab('pr')}
          className={`flex-1 py-1.5 text-[10px] font-pixel transition-colors ${tab === 'pr' ? 'text-green-400 border-b-2 border-green-500 bg-slate-800' : 'text-slate-400 hover:text-slate-200'}`}
        >
          PR
        </button>

        {/* Push button (right side) */}
        <button
          onClick={handlePush}
          disabled={!!busy}
          className="px-2 py-1.5 text-[10px] font-pixel text-indigo-300 hover:text-white hover:bg-indigo-800/60 transition-colors border-l border-slate-700 shrink-0 disabled:opacity-50"
          title="Push to remote"
        >
          {busy === 'push' ? '...' : '↑'}
        </button>
      </div>

      {/* ─── Branch picker overlay ─── */}
      {overlay === 'branches' && (
        <div className="absolute top-[33px] left-0 right-0 z-20 bg-slate-900 border-b border-slate-600 shadow-xl">
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-700/50">
            <span className="text-[9px] font-pixel text-slate-400">
              {syncInfo} · {branchInfo.branches?.length || 0} branches
            </span>
            <button
              onClick={() => setOverlay(overlay === 'new-branch' ? null : 'new-branch')}
              className="text-[9px] font-pixel text-indigo-400 hover:text-indigo-300"
            >
              + new
            </button>
          </div>
          {overlay === 'branches' && (
            <div className="max-h-40 overflow-y-auto">
              {branchInfo.branches?.map(b => (
                <button
                  key={b}
                  onClick={() => handleCheckout(b)}
                  disabled={!!busy}
                  className={`w-full text-left px-3 py-1 text-[11px] font-mono hover:bg-slate-800 transition-colors disabled:opacity-50 ${
                    b === branchInfo.current ? 'text-indigo-300 bg-slate-800/50' : 'text-slate-300'
                  }`}
                >
                  {b === branchInfo.current ? '● ' : '  '}{b}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ─── New branch overlay ─── */}
      {overlay === 'new-branch' && (
        <div className="absolute top-[33px] left-0 right-0 z-20 bg-slate-900 border-b border-slate-600 shadow-xl px-3 py-2">
          <div className="flex items-center gap-2">
            <input
              autoFocus
              value={newBranch}
              onChange={e => setNewBranch(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleCreateBranch(); if (e.key === 'Escape') setOverlay(null); }}
              placeholder="feature/my-branch"
              className="flex-1 bg-slate-800 border border-slate-600 rounded text-[11px] font-mono text-slate-200 px-2 py-1 focus:outline-none focus:border-indigo-500"
            />
            <button
              onClick={handleCreateBranch}
              disabled={!!busy || !newBranch.trim()}
              className="btn-pixel text-[9px] bg-emerald-700 hover:bg-emerald-600 text-white px-2 py-0.5 disabled:opacity-50"
            >
              Create
            </button>
            <button onClick={() => setOverlay(null)} className="text-slate-500 hover:text-white text-[10px]">✕</button>
          </div>
        </div>
      )}

      {/* Backdrop to close overlays */}
      {overlay && (
        <div className="absolute inset-0 top-[33px] z-10" onClick={() => setOverlay(null)} />
      )}

      {/* Toast */}
      {toast && (
        <div className={`px-3 py-1 text-[10px] font-pixel border-b shrink-0 ${
          toast.type === 'ok' ? 'bg-emerald-950/80 border-emerald-700/50 text-emerald-300' : 'bg-red-950/80 border-red-700/50 text-red-300'
        }`}>
          {toast.msg}
        </div>
      )}

      {/* ─── Tab content ─── */}
      {tab === 'status' ? (
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Diff stat (only when no file selected) */}
          {diffStat && !diffFile && (
            <div className="px-3 py-1 bg-slate-900/40 border-b border-slate-700/50 shrink-0">
              <pre className="text-[9px] font-mono text-slate-500 whitespace-pre-wrap leading-relaxed">{diffStat}</pre>
            </div>
          )}

          <div className={`overflow-y-auto ${diffFile ? 'max-h-44 shrink-0' : 'flex-1'}`}>
            {/* Staged */}
            <div className="border-b border-slate-700/50">
              <div className="flex items-center justify-between px-3 py-1 bg-slate-900/60">
                <span className="text-[10px] font-pixel text-green-400">Staged ({staged.length})</span>
                {staged.length > 0 && (
                  <button onClick={handleUnstageAll} disabled={!!busy} className="text-[9px] font-pixel text-slate-400 hover:text-amber-300 disabled:opacity-50">
                    Unstage All
                  </button>
                )}
              </div>
              {staged.map(f => (
                <FileRow key={`s-${f.path}`} file={f} isStaged selected={diffFile === f.path && diffIsStaged} onView={() => handleViewDiff(f.path, true)} onToggle={() => handleUnstageFile(f.path)} busy={!!busy} />
              ))}
            </div>

            {/* Unstaged */}
            <div className="border-b border-slate-700/50">
              <div className="flex items-center justify-between px-3 py-1 bg-slate-900/60">
                <span className="text-[10px] font-pixel text-amber-400">Changes ({unstaged.length})</span>
                {(unstaged.length > 0 || untracked.length > 0) && (
                  <button onClick={handleStageAll} disabled={!!busy} className="text-[9px] font-pixel text-slate-400 hover:text-green-300 disabled:opacity-50">
                    Stage All
                  </button>
                )}
              </div>
              {unstaged.map(f => (
                <FileRow key={`u-${f.path}`} file={f} isStaged={false} selected={diffFile === f.path && !diffIsStaged} onView={() => handleViewDiff(f.path, false)} onToggle={() => handleStageFile(f.path)} busy={!!busy} />
              ))}
            </div>

            {/* Untracked */}
            {untracked.length > 0 && (
              <div className="border-b border-slate-700/50">
                <div className="px-3 py-1 bg-slate-900/60">
                  <span className="text-[10px] font-pixel text-emerald-400">Untracked ({untracked.length})</span>
                </div>
                {untracked.map(f => (
                  <FileRow key={`t-${f.path}`} file={f} isStaged={false} selected={diffFile === f.path} onView={() => handleViewDiff(f.path, false)} onToggle={() => handleStageFile(f.path)} busy={!!busy} />
                ))}
              </div>
            )}

            {totalChanges === 0 && (
              <div className="text-slate-400 text-[11px] font-mono text-center pt-8 px-3">
                Working tree is clean.
              </div>
            )}
          </div>

          {/* Diff viewer */}
          {diffFile && (
            <div className="flex-1 flex flex-col overflow-hidden border-t border-slate-600">
              <div className="flex items-center justify-between px-3 py-1 bg-slate-900 border-b border-slate-700 shrink-0">
                <span className="text-[10px] font-mono text-slate-300 truncate">
                  <span className={diffIsStaged ? 'text-green-400' : 'text-amber-400'}>
                    {diffIsStaged ? '[staged] ' : '[unstaged] '}
                  </span>
                  {diffFile}
                </span>
                <button onClick={() => { setDiffFile(null); setDiffContent(''); }} className="text-[10px] text-slate-500 hover:text-white ml-2 shrink-0">✕</button>
              </div>
              <div className="flex-1 overflow-auto">
                <pre className="px-3 py-2 text-[10px] font-mono leading-relaxed whitespace-pre-wrap break-all">
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
              </div>
            </div>
          )}

          {/* Commit form */}
          {staged.length > 0 && (
            <div className="shrink-0 px-3 py-2 border-t border-slate-600 bg-slate-900">
              <textarea
                ref={commitInputRef}
                value={commitMsg}
                onChange={e => setCommitMsg(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && e.metaKey) handleCommit(); }}
                placeholder="Commit message..."
                rows={2}
                className="w-full bg-slate-800 border border-slate-600 rounded text-[11px] font-mono text-slate-200 px-2 py-1.5 focus:outline-none focus:border-indigo-500 resize-none"
              />
              <div className="flex items-center justify-between mt-1">
                <span className="text-[9px] font-pixel text-slate-500">
                  {staged.length} staged · ⌘↵
                </span>
                <button
                  onClick={handleCommit}
                  disabled={!!busy || !commitMsg.trim()}
                  className="btn-pixel text-[10px] bg-emerald-700 hover:bg-emerald-600 text-white px-3 py-0.5 disabled:opacity-50"
                >
                  {busy === 'commit' ? '...' : 'Commit'}
                </button>
              </div>
            </div>
          )}
        </div>
      ) : tab === 'log' ? (
        <div className="flex-1 overflow-y-auto px-3 py-2">
          {logContent ? (
            <div className="space-y-0.5">
              {logContent.split('\n').filter(Boolean).map((line, i) => {
                const hash = line.slice(0, 7);
                const msg = line.slice(8);
                return (
                  <div key={i} className="flex items-start gap-2 py-0.5">
                    <span className="text-[10px] font-mono text-indigo-400 shrink-0">{hash}</span>
                    <span className="text-[11px] font-mono text-slate-300">{msg}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-slate-400 text-[11px] font-mono text-center pt-8">No git history.</div>
          )}
        </div>
      ) : (
        /* ─── PR Tab ─── */
        <div className="flex-1 overflow-y-auto px-3 py-3">
          {!showPrForm ? (
            <div className="space-y-3">
              <div className="text-center">
                <p className="text-[11px] font-pixel text-slate-300 mb-1">Create a Pull Request</p>
                <p className="text-[10px] text-slate-500 mb-3">Push your branch and open a PR on GitHub.</p>
                <button
                  onClick={() => { setShowPrForm(true); setPrTitle(branchInfo.current || ''); }}
                  className="btn-pixel text-[11px] bg-indigo-700 hover:bg-indigo-600 text-white px-4 py-1"
                >
                  New Pull Request
                </button>
              </div>
              <div className="mt-4 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-pixel text-slate-500 w-14">Branch</span>
                  <span className="text-[11px] font-mono text-indigo-300">{branchInfo.current || '—'}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-pixel text-slate-500 w-14">Remote</span>
                  <span className="text-[11px] font-mono text-slate-400">{branchInfo.remote || 'none'}</span>
                </div>
                {(branchInfo.ahead ?? 0) > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-pixel text-slate-500 w-14">Ahead</span>
                    <span className="text-[11px] font-mono text-emerald-400">{branchInfo.ahead} commit{branchInfo.ahead !== 1 ? 's' : ''}</span>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div>
                <label className="text-[10px] font-pixel text-slate-400 block mb-0.5">Base branch</label>
                <input value={prBase} onChange={e => setPrBase(e.target.value)} className="w-full bg-slate-800 border border-slate-600 rounded text-[11px] font-mono text-slate-200 px-2 py-1 focus:outline-none focus:border-indigo-500" />
              </div>
              <div>
                <label className="text-[10px] font-pixel text-slate-400 block mb-0.5">Title</label>
                <input autoFocus value={prTitle} onChange={e => setPrTitle(e.target.value)} className="w-full bg-slate-800 border border-slate-600 rounded text-[11px] font-mono text-slate-200 px-2 py-1 focus:outline-none focus:border-indigo-500" />
              </div>
              <div>
                <label className="text-[10px] font-pixel text-slate-400 block mb-0.5">Description</label>
                <textarea value={prBody} onChange={e => setPrBody(e.target.value)} rows={4} placeholder="What does this PR do?" className="w-full bg-slate-800 border border-slate-600 rounded text-[11px] font-mono text-slate-200 px-2 py-1.5 focus:outline-none focus:border-indigo-500 resize-none" />
              </div>
              <div className="flex gap-2 justify-end">
                <button onClick={() => setShowPrForm(false)} className="btn-pixel text-[10px] bg-slate-700 hover:bg-slate-600 text-slate-200 px-3 py-0.5">Cancel</button>
                <button
                  onClick={async () => {
                    if (!branchInfo.remote) {
                      setBusy('push');
                      const pushRes = await gitPush(workspaceDir!, true);
                      if (!pushRes.ok) { flash(pushRes.error || 'Push failed', 'err'); setBusy(''); return; }
                    }
                    await handleCreatePr();
                  }}
                  disabled={!!busy || !prTitle.trim()}
                  className="btn-pixel text-[10px] bg-indigo-700 hover:bg-indigo-600 text-white px-3 py-0.5 disabled:opacity-50"
                >
                  {busy === 'push' ? 'Pushing...' : busy === 'pr' ? 'Creating...' : 'Push & Create PR'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── File Row ────────────────────────────────────────────────────

interface FileRowProps {
  file: GitStatusFile;
  isStaged: boolean;
  selected: boolean;
  onView: () => void;
  onToggle: () => void;
  busy: boolean;
}

function FileRow({ file, isStaged, selected, onView, onToggle, busy }: FileRowProps) {
  const filename = file.path.split('/').pop() || file.path;
  return (
    <div className={`flex items-center gap-1 py-[2px] px-3 hover:bg-slate-800/60 transition-colors ${selected ? 'bg-slate-800/80' : ''}`}>
      <button
        onClick={onToggle}
        disabled={busy}
        className={`text-[9px] w-3.5 h-3.5 flex items-center justify-center rounded border transition-colors shrink-0 disabled:opacity-50 ${
          isStaged
            ? 'border-green-600 bg-green-900/40 text-green-400 hover:bg-red-900/40 hover:border-red-600 hover:text-red-400'
            : 'border-slate-600 bg-slate-800 text-slate-400 hover:bg-green-900/40 hover:border-green-600 hover:text-green-400'
        }`}
        title={isStaged ? 'Unstage' : 'Stage'}
      >
        {isStaged ? '−' : '+'}
      </button>
      <button onClick={onView} className="flex-1 flex items-center gap-1 text-left min-w-0">
        <span className={`text-[9px] font-mono font-bold shrink-0 ${statusColor(file.status)}`}>
          {statusLabel(file.status)}
        </span>
        <span className="text-[10px] shrink-0">{fileIcon(filename)}</span>
        <span className={`text-[10px] font-mono truncate ${selected ? 'text-green-400' : 'text-slate-300'}`}>
          {file.path}
        </span>
      </button>
    </div>
  );
}
