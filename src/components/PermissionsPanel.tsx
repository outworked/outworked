import { useState, useEffect, useCallback } from 'react';
import {
  readClaudeSettings,
  writeClaudeSettings,
  readClaudeMd,
  writeClaudeMd,
  type ClaudeSettingsJson,
} from '../lib/terminal';
import { checkPermissions, repairPermissions } from '../lib/filesystem';

// Well-known Claude Code tools for quick-add UI
const CLAUDE_TOOLS = [
  'Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob',
  'WebFetch', 'WebSearch', 'LSP', 'Skill', 'TodoWrite', 'Agent',
];

const RECOMMENDED_PERMISSIONS = {
  allow: [
    'Read', 'Edit', 'Write', 'Glob', 'Grep',
    'Bash(git *)', 'Bash(npm test *)', 'Bash(npm run *)',
    'Bash(npx *)', 'Bash(node *)', 'Bash(ls *)',
    'Bash(cat *)', 'Bash(mkdir *)', 'Bash(cp *)', 'Bash(mv *)',
    'WebFetch', 'WebSearch',
  ],
  deny: [
    'Bash(rm -rf /)', 'Bash(git push --force *)',
    'Bash(curl * | bash)', 'Bash(wget * | bash)',
  ],
};

// ─── Permission Rules Editor ──────────────────────────────────────

function RulesEditor({
  label,
  rules,
  onChange,
}: {
  label: string;
  rules: string[];
  onChange: (rules: string[]) => void;
}) {
  const [newRule, setNewRule] = useState('');

  function addRule() {
    const trimmed = newRule.trim();
    if (trimmed && !rules.includes(trimmed)) {
      onChange([...rules, trimmed]);
      setNewRule('');
    }
  }

  return (
    <div>
      <span className="text-[10px] font-pixel text-slate-400">{label}</span>
      <div className="mt-1 space-y-1">
        {rules.map((rule, i) => (
          <div key={i} className="flex items-center gap-1 group">
            <code className="flex-1 text-[10px] text-indigo-300 bg-slate-900 px-1.5 py-0.5 rounded font-mono truncate">
              {rule}
            </code>
            <button
              onClick={() => onChange(rules.filter((_, j) => j !== i))}
              className="text-[10px] text-slate-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
              title="Remove"
            >
              ✕
            </button>
          </div>
        ))}
        <div className="flex gap-1">
          <input
            value={newRule}
            onChange={(e) => setNewRule(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addRule())}
            placeholder='e.g. Bash(git *) or Read'
            className="flex-1 px-1.5 py-0.5 text-[10px] bg-slate-900 border border-slate-700 rounded text-white font-mono placeholder-slate-600"
          />
          <button
            onClick={addRule}
            disabled={!newRule.trim()}
            className="text-[10px] text-indigo-400 hover:text-indigo-300 disabled:text-slate-700 px-1"
          >
            + Add
          </button>
        </div>
        <div className="flex flex-wrap gap-1 mt-1">
          {CLAUDE_TOOLS.filter((t) => !rules.includes(t)).slice(0, 6).map((tool) => (
            <button
              key={tool}
              onClick={() => onChange([...rules, tool])}
              className="text-[9px] px-1 py-0.5 rounded bg-slate-800 text-slate-500 hover:text-indigo-300 hover:bg-slate-700 transition-colors"
            >
              +{tool}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Workspace Permissions Banner ─────────────────────────────────

export function PermissionsBanner({ workspace }: { workspace: string | null }) {
  const [status, setStatus] = useState<{ checked: boolean; ok: boolean; repairing: boolean; repaired: boolean }>({
    checked: false, ok: true, repairing: false, repaired: false,
  });

  useEffect(() => {
    if (!workspace) return;
    checkPermissions(workspace).then((result) => {
      setStatus((s) => ({ ...s, checked: true, ok: result.writable !== false }));
    });
  }, [workspace]);

  async function handleRepair() {
    if (!workspace) return;
    setStatus((s) => ({ ...s, repairing: true }));
    const result = await repairPermissions(workspace);
    setStatus((s) => ({ ...s, repairing: false, repaired: result.ok, ok: result.ok }));
  }

  if (!status.checked || status.ok) return null;

  return (
    <div className="px-3 py-2 bg-amber-900/40 border-b border-amber-700/50 flex items-center gap-2">
      <span className="text-amber-400 text-sm">⚠</span>
      <span className="text-[10px] text-amber-200 font-pixel flex-1">
        Workspace has permission issues — Claude Code may not be able to read/write files.
      </span>
      {status.repaired ? (
        <span className="text-[10px] text-emerald-400 font-pixel">Fixed ✓</span>
      ) : (
        <button
          onClick={handleRepair}
          disabled={status.repairing}
          className="text-[10px] font-pixel px-2 py-0.5 bg-amber-700 hover:bg-amber-600 text-white rounded disabled:opacity-50"
        >
          {status.repairing ? 'Fixing…' : 'Fix Permissions'}
        </button>
      )}
    </div>
  );
}

// ─── Main Permissions Panel ───────────────────────────────────────

export default function PermissionsPanel({ workspace, onSaved }: { workspace: string; onSaved?: () => void }) {
  const [scope, setScope] = useState<'global' | 'project'>('project');
  const [claudeSettings, setClaudeSettings] = useState<ClaudeSettingsJson>({});
  const [settingsExists, setSettingsExists] = useState(false);
  const [claudeMdContent, setClaudeMdContent] = useState('');
  const [claudeMdExists, setClaudeMdExists] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');

  // Workspace permission status
  const [wsPermOk, setWsPermOk] = useState(true);
  const [repairing, setRepairing] = useState(false);

  const loadAll = useCallback(async () => {
    const { settings, exists } = await readClaudeSettings(scope);
    setClaudeSettings(settings);
    setSettingsExists(exists);
  }, [scope]);

  useEffect(() => { loadAll(); }, [loadAll, workspace]);

  useEffect(() => {
    readClaudeMd().then(({ content, exists }) => {
      setClaudeMdContent(content);
      setClaudeMdExists(exists);
    });
  }, [workspace]);

  useEffect(() => {
    checkPermissions(workspace).then((r) => setWsPermOk(r.writable !== false));
  }, [workspace]);

  async function handleRepairWorkspace() {
    setRepairing(true);
    const result = await repairPermissions(workspace);
    setWsPermOk(result.ok);
    setRepairing(false);
  }

  async function saveSettingsJson() {
    setSaving(true);
    setSaveMsg('');
    const ok = await writeClaudeSettings(scope, claudeSettings);
    setSaveMsg(ok ? 'Saved ✓' : 'Error saving');
    if (ok) onSaved?.();
    setSaving(false);
    setTimeout(() => setSaveMsg(''), 2000);
  }

  async function saveClaudeMdFile() {
    setSaving(true);
    setSaveMsg('');
    const ok = await writeClaudeMd(claudeMdContent);
    if (ok) setClaudeMdExists(true);
    setSaveMsg(ok ? 'CLAUDE.md saved ✓' : 'Error saving');
    setSaving(false);
    setTimeout(() => setSaveMsg(''), 2000);
  }

  const perms = claudeSettings.permissions || { allow: [], deny: [] };

  function updatePermissions(field: 'allow' | 'deny', rules: string[]) {
    setClaudeSettings({
      ...claudeSettings,
      permissions: { ...perms, [field]: rules },
    });
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="p-3 space-y-4 flex-1">
        {/* ─── Workspace File Permissions ─── */}
        {!wsPermOk && (
          <div className="p-2 bg-amber-900/30 border border-amber-700/40 rounded space-y-1">
            <div className="flex items-center gap-1.5">
              <span className="text-amber-400">⚠</span>
              <span className="text-[10px] font-pixel text-amber-200">Workspace Permission Issue</span>
            </div>
            <p className="text-[10px] text-amber-300/70">
              The workspace directory isn't fully writable. Claude Code may fail to create or edit files.
            </p>
            <button
              onClick={handleRepairWorkspace}
              disabled={repairing}
              className="btn-pixel text-[10px] bg-amber-700 hover:bg-amber-600 px-2 py-0.5 disabled:opacity-50"
            >
              {repairing ? 'Repairing…' : 'Repair Permissions'}
            </button>
          </div>
        )}

        {/* ─── Permission Rules (settings.json) ─── */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-[11px] font-pixel text-slate-300">Permission Rules</h3>
            <div className="flex gap-1">
              {(['project', 'global'] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setScope(s)}
                  className={`text-[9px] px-2 py-0.5 rounded font-pixel transition-colors ${
                    scope === s
                      ? 'bg-indigo-700 text-white'
                      : 'bg-slate-800 text-slate-500 hover:text-slate-300'
                  }`}
                >
                  {s === 'project' ? '📁 Project' : '🌐 Global'}
                </button>
              ))}
            </div>
          </div>

          <p className="text-[10px] text-slate-600 mb-2">
            {scope === 'project'
              ? <><code className="text-slate-500">{workspace}/.claude/settings.json</code></>
              : <><code className="text-slate-500">~/.claude/settings.json</code></>}
            {settingsExists ? '' : ' — will be created'}
          </p>

          {/* Quick-apply recommended permissions */}
          {(perms.allow?.length === 0 && perms.deny?.length === 0) && (
            <button
              onClick={async () => {
                const updated = {
                  ...claudeSettings,
                  permissions: {
                    allow: [...RECOMMENDED_PERMISSIONS.allow],
                    deny: [...RECOMMENDED_PERMISSIONS.deny],
                  },
                };
                setClaudeSettings(updated);
                setSaving(true);
                const ok = await writeClaudeSettings(scope, updated);
                setSaveMsg(ok ? 'Saved ✓' : 'Error saving');
                if (ok) onSaved?.();
                setSaving(false);
                setTimeout(() => setSaveMsg(''), 2000);
              }}
              disabled={saving}
              className="w-full mb-3 btn-pixel text-[10px] bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 rounded disabled:opacity-50"
            >
              {saving ? 'Applying…' : 'Apply Recommended Permissions'}
            </button>
          )}

          <div className="space-y-3">
            <RulesEditor
              label="✅ Allow Rules"
              rules={perms.allow || []}
              onChange={(rules) => updatePermissions('allow', rules)}
            />
            <RulesEditor
              label="🚫 Deny Rules"
              rules={perms.deny || []}
              onChange={(rules) => updatePermissions('deny', rules)}
            />
          </div>

          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={saveSettingsJson}
              disabled={saving}
              className="btn-pixel text-[10px] bg-indigo-700 hover:bg-indigo-600 disabled:opacity-50 px-3 py-1"
            >
              {saving ? 'Saving…' : 'Save Rules'}
            </button>
            {saveMsg && (
              <span className={`text-[10px] ${saveMsg.includes('✓') ? 'text-emerald-400' : 'text-red-400'}`}>
                {saveMsg}
              </span>
            )}
          </div>

          <div className="mt-2 text-[10px] text-slate-600 leading-relaxed">
            <p>Glob patterns for tool arguments:</p>
            <code className="text-[9px] text-slate-500 block mt-0.5">Bash(git *) — allow git commands only</code>
            <code className="text-[9px] text-slate-500 block">Bash(rm *)  — deny rm commands</code>
          </div>
        </div>

        {/* ─── CLAUDE.md ─── */}
        <div className="border-t border-slate-800 pt-3">
          <h3 className="text-[11px] font-pixel text-slate-300 mb-1">CLAUDE.md</h3>
          <p className="text-[10px] text-slate-600 mb-2">
            Project instructions at workspace root.
            {claudeMdExists ? '' : ' Will be created on save.'}
          </p>
          <textarea
            value={claudeMdContent}
            onChange={(e) => setClaudeMdContent(e.target.value)}
            className="w-full px-2 py-1 text-xs bg-slate-900 border border-slate-700 rounded text-white font-mono h-28 resize-y"
            placeholder={'# Project Instructions\n\nTell Claude what this project is, what tools/patterns to prefer, what to avoid, etc.'}
          />
          <button
            onClick={saveClaudeMdFile}
            disabled={saving}
            className="mt-1 btn-pixel text-[10px] bg-indigo-700 hover:bg-indigo-600 disabled:opacity-50 px-3 py-1"
          >
            {saving ? 'Saving…' : 'Save CLAUDE.md'}
          </button>
        </div>

        {/* ─── Tool Reference ─── */}
        <div className="border-t border-slate-800 pt-3">
          <h3 className="text-[11px] font-pixel text-slate-300 mb-1">Claude Code Tools</h3>
          <div className="flex flex-wrap gap-1">
            {CLAUDE_TOOLS.map((tool) => (
              <span key={tool} className="text-[9px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-mono">
                {tool}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
