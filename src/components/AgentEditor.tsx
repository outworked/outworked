import { useMemo, useState } from 'react';
import { Agent, /* ApiKeys, */ MODELS, SPRITE_KEYS, AGENT_COLORS, SubagentDef, AgentScope } from '../lib/types';
import { writeClaudeAgentFile, deleteClaudeAgentFile, getHomedir } from '../lib/terminal';
import { buildSubagentMd, generateAgentWithAI, parseSubagentFrontmatter } from '../lib/storage';

interface AgentEditorProps {
  agent: Agent;
  workspaceDir?: string;
  onSave: (agent: Agent) => void;
  onDelete: (agentId: string) => void;
  onClose: () => void;
}

// API keys disabled — only Claude Code is available
// const PROVIDER_KEY_MAP: Record<string, keyof ApiKeys | null> = {
//   openai: 'openai',
//   anthropic: 'anthropic',
//   google: 'gemini',
//   'claude-code': null,
// };

export default function AgentEditor({ agent, workspaceDir, onSave, onDelete, onClose }: AgentEditorProps) {
  const [draft, setDraft] = useState<Agent>({ ...agent });
  const [tab, setTab] = useState<'profile' | 'subagent' | 'history'>('profile');
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generatePrompt, setGeneratePrompt] = useState<string | null>(null);

  // Only show Claude Code model (API-key-based providers disabled)
  const availableModels = useMemo(() =>
    MODELS.filter((m) => m.provider === 'claude-code'),
    [],
  );

  function update<K extends keyof Agent>(key: K, value: Agent[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
    // Auto-set provider based on model
    if (key === 'model') {
      const m = MODELS.find((m) => m.id === value);
      if (m) setDraft((prev) => ({ ...prev, model: value as Agent['model'], provider: m.provider }));
    }
  }

  function clearHistory() {
    setDraft((prev) => ({ ...prev, history: [], currentThought: '' }));
  }

  return (
    <div className="flex flex-col h-full bg-slate-900 text-white">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-600" style={{ borderLeftColor: draft.color, borderLeftWidth: 3 }}>
        <div className="flex-1 min-w-0">
          <h2 className="text-xs font-pixel text-white truncate">Edit: {draft.name}</h2>
          <p className="text-[11px] font-pixel mt-0.5" style={{ color: draft.color }}>{draft.role}</p>
        </div>
        <button onClick={onClose} className="text-slate-300 hover:text-white text-xs font-pixel transition-colors px-1">✕</button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-600">
        {(['profile', ...(draft.subagentFile ? ['subagent'] : []), 'history'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t as typeof tab)}
            className={`flex-1 py-2 text-[11px] font-pixel transition-colors ${tab === t ? 'text-white border-b-2' : 'text-slate-400 hover:text-slate-200'}`}
            style={tab === t ? { borderBottomColor: draft.color } : {}}
          >
            {t === 'subagent' ? '⚡ Agent' : t}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {tab === 'profile' && (
          <>
            <Field label="Name">
              <input
                value={draft.name}
                onChange={(e) => update('name', e.target.value)}
                className="input-mono"
              />
            </Field>

            <Field label="Job Title">
              <input
                value={draft.role}
                onChange={(e) => update('role', e.target.value)}
                className="input-mono"
              />
            </Field>

            <Field label="Model">
              <select
                value={draft.model}
                onChange={(e) => update('model', e.target.value as Agent['model'])}
                className="input-mono"
              >
                {availableModels.map((m) => (
                  <option key={m.id} value={m.id}>{m.label} ({m.provider})</option>
                ))}
              </select>
            </Field>

            <Field label="Personality (System Prompt)">
              <textarea
                value={draft.personality}
                onChange={(e) => update('personality', e.target.value)}
                rows={6}
                className="input-mono resize-none"
                disabled={draft.isBoss} // Boss personality is fixed
              />
            </Field>

            <Field label="Appearance">
              <div className="flex gap-2 flex-wrap">
                {SPRITE_KEYS.map((key, i) => (
                  <button
                    key={key}
                    onClick={() => setDraft((prev) => ({ ...prev, spriteKey: key, color: AGENT_COLORS[i] }))}
                    className={`w-6 h-6 rounded border-2 transition-all ${draft.spriteKey === key ? 'scale-125' : 'opacity-60 hover:opacity-100'}`}
                    style={{ backgroundColor: AGENT_COLORS[i], borderColor: draft.spriteKey === key ? '#fff' : 'transparent' }}
                  />
                ))}
              </div>
            </Field>
          </>
        )}

        {tab === 'subagent' && draft.subagentFile && (
          <SubagentTab
            agent={draft}
            onUpdate={(updated) => setDraft(prev => ({ ...prev, ...updated }))}
            onSaveToFile={async () => {
              if (!draft.subagentFile || !draft.subagentDef) return;
              setSaving(true);
              try {
                const slug = draft.subagentFile.split('/').pop()?.replace(/\.md$/, '') || draft.name;
                const content = buildSubagentMd(slug, draft.subagentDef, draft.personality, draft.name, draft.role);

                // Determine the correct target path based on current scope
                const scope = draft.agentScope || 'user';
                let targetPath: string;
                if (scope === 'project' && workspaceDir) {
                  targetPath = `${workspaceDir}/.claude/agents/${slug}.md`;
                } else {
                  targetPath = `${getHomedir()}/.claude/agents/${slug}.md`;
                }

                await writeClaudeAgentFile(targetPath, content);

                // If path changed (scope switch), delete the old file and update the reference
                if (targetPath !== draft.subagentFile) {
                  await deleteClaudeAgentFile(draft.subagentFile);
                  setDraft(prev => ({ ...prev, subagentFile: targetPath }));
                }
              } finally {
                setSaving(false);
              }
            }}
            onGenerate={async (description: string) => {
              setGenerating(true);
              setGeneratePrompt(null);
              try {
                const result = await generateAgentWithAI(description, {
                  name: draft.name !== 'New Employee' ? draft.name : undefined,
                  scope: draft.agentScope || 'user',
                  workspaceDir: workspaceDir || undefined,
                });
                if (result) {
                  const parsed = parseSubagentFrontmatter(result.content);
                  const name = parsed.def['outworked-name'] || parsed.def.name || draft.name;
                  const role = parsed.def['outworked-role'] || parsed.def.description || draft.role;
                  // Delete old file if the path changed
                  if (draft.subagentFile && result.filePath !== draft.subagentFile) {
                    await deleteClaudeAgentFile(draft.subagentFile);
                  }
                  setDraft(prev => ({
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
            }}
            onRequestGenerate={() => setGeneratePrompt(draft.role || draft.subagentDef?.description || '')}
            generatePrompt={generatePrompt}
            onCancelGenerate={() => setGeneratePrompt(null)}
            onUpdateGeneratePrompt={setGeneratePrompt}
            saving={saving}
            generating={generating}
          />
        )}

        {tab === 'history' && (
          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <span className="text-[11px] font-pixel text-slate-300">{draft.history.length} messages</span>
              {draft.history.length > 0 && (
                <button onClick={clearHistory} className="text-[11px] font-pixel text-red-400 hover:text-red-300">
                  Clear History
                </button>
              )}
            </div>
            {draft.history.length === 0 && (
              <p className="text-[11px] font-pixel text-slate-400 text-center py-4">No conversation history.</p>
            )}
            {draft.history.map((msg, i) => (
              <div key={i} className={`text-[11px] font-mono rounded p-2 ${msg.role === 'user' ? 'bg-indigo-900/50 text-indigo-200' : 'bg-slate-800 text-slate-200'}`}>
                <span className="text-[12px] text-slate-400 block mb-1">{msg.role}</span>
                <p className="whitespace-pre-wrap break-words line-clamp-4">{msg.content}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-slate-600 flex gap-2">
        <button
          onClick={() => onSave(draft)}
          className="btn-pixel bg-indigo-600 hover:bg-indigo-500 flex-1"
        >
          Save
        </button>
        {!agent.isBoss && (
          <button
            onClick={() => { if (confirm(`Delete ${agent.name}?`)) onDelete(agent.id); }}
            className="btn-pixel bg-red-800 hover:bg-red-700"
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-[11px] font-pixel text-slate-300 block">{label}</label>
      {children}
    </div>
  );
}

// ─── Subagent editor tab ─────────────────────────────────────

function SubagentTab({
  agent,
  onUpdate,
  onSaveToFile,
  onGenerate,
  onRequestGenerate,
  generatePrompt,
  onCancelGenerate,
  onUpdateGeneratePrompt,
  saving,
  generating,
}: {
  agent: Agent;
  onUpdate: (partial: Partial<Agent>) => void;
  onSaveToFile: () => void;
  onGenerate: (description: string) => void;
  onRequestGenerate: () => void;
  generatePrompt: string | null;
  onCancelGenerate: () => void;
  onUpdateGeneratePrompt: (value: string) => void;
  saving: boolean;
  generating: boolean;
}) {
  const def = agent.subagentDef || { description: '' };
  const [toolsText, setToolsText] = useState((def.tools || []).join(', '));
  const [disallowedToolsText, setDisallowedToolsText] = useState((def.disallowedTools || []).join(', '));
  const [skillsText, setSkillsText] = useState((def.skills || []).join(', '));
  const [mcpText, setMcpText] = useState(() => serializeMcpServers(def.mcpServers));
  const [hooksText, setHooksText] = useState(() => serializeHooks(def.hooks));

  function updateDef(partial: Partial<SubagentDef>) {
    onUpdate({ subagentDef: { ...def, ...partial } });
  }

  return (
    <div className="space-y-3">
      <div className="bg-purple-900/30 border border-purple-700/50 rounded p-2">
        <p className="text-[10px] font-pixel text-purple-300">
          ⚡ Claude Code Subagent
        </p>
        <div className="flex items-center gap-2 mt-1">
          <span
            className={`text-[9px] font-pixel px-1.5 py-0.5 rounded ${
              agent.agentScope === 'project'
                ? 'bg-cyan-900/50 text-cyan-300 border border-cyan-700/50'
                : 'bg-amber-900/50 text-amber-300 border border-amber-700/50'
            }`}
          >
            {agent.agentScope === 'project' ? 'PROJECT' : 'USER'}
          </span>
          <p className="text-[10px] font-mono text-purple-400/70 truncate flex-1">
            {agent.subagentFile}
          </p>
        </div>
      </div>

      <Field label="Scope">
        <select
          value={agent.agentScope || 'user'}
          onChange={(e) => onUpdate({ agentScope: e.target.value as AgentScope })}
          className="input-mono"
        >
          <option value="user">User (~/.claude/agents/)</option>
          <option value="project">Project (.claude/agents/)</option>
        </select>
      </Field>

      <Field label="Description">
        <input
          value={def.description}
          onChange={(e) => updateDef({ description: e.target.value })}
          className="input-mono"
        />
      </Field>

      <Field label="Allowed Tools (comma-separated)">
        <input
          value={toolsText}
          onChange={(e) => {
            setToolsText(e.target.value);
            const tools = e.target.value.split(',').map(t => t.trim()).filter(Boolean);
            updateDef({ tools: tools.length > 0 ? tools : undefined });
          }}
          placeholder="Read, Write, Bash, Glob, Grep, Agent(worker)…"
          className="input-mono"
        />
      </Field>

      <Field label="Disallowed Tools (comma-separated)">
        <input
          value={disallowedToolsText}
          onChange={(e) => {
            setDisallowedToolsText(e.target.value);
            const tools = e.target.value.split(',').map(t => t.trim()).filter(Boolean);
            updateDef({ disallowedTools: tools.length > 0 ? tools : undefined });
          }}
          placeholder="Write, Edit…"
          className="input-mono"
        />
      </Field>

      <Field label="Model Override">
        <select
          value={def.model || 'inherit'}
          onChange={(e) => updateDef({ model: e.target.value === 'inherit' ? undefined : e.target.value })}
          className="input-mono"
        >
          <option value="inherit">inherit (parent model)</option>
          <option value="sonnet">sonnet</option>
          <option value="opus">opus</option>
          <option value="haiku">haiku</option>
          <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
          <option value="claude-opus-4-6">claude-opus-4-6</option>
        </select>
      </Field>

      <Field label="Max Turns">
        <input
          type="number"
          value={def.maxTurns ?? ''}
          onChange={(e) => updateDef({ maxTurns: e.target.value ? parseInt(e.target.value) : undefined })}
          placeholder="default"
          className="input-mono"
          min={1}
        />
      </Field>

      <Field label="Permission Mode">
        <select
          value={def.permissionMode || 'default'}
          onChange={(e) => updateDef({ permissionMode: e.target.value === 'default' ? undefined : e.target.value })}
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
          value={def.memory || 'none'}
          onChange={(e) => updateDef({ memory: e.target.value === 'none' ? undefined : e.target.value as SubagentDef['memory'] })}
          className="input-mono"
        >
          <option value="none">none</option>
          <option value="user">user (cross-project)</option>
          <option value="project">project (shared via VCS)</option>
          <option value="local">local (project, not in VCS)</option>
        </select>
      </Field>

      <Field label="Skills (comma-separated)">
        <input
          value={skillsText}
          onChange={(e) => {
            setSkillsText(e.target.value);
            const skills = e.target.value.split(',').map(s => s.trim()).filter(Boolean);
            updateDef({ skills: skills.length > 0 ? skills : undefined });
          }}
          placeholder="api-conventions, error-handling…"
          className="input-mono"
        />
      </Field>

      <Field label="Isolation">
        <select
          value={def.isolation || 'none'}
          onChange={(e) => updateDef({ isolation: e.target.value === 'none' ? undefined : e.target.value as 'worktree' })}
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
            onChange={(e) => updateDef({ background: e.target.checked || undefined })}
            className="accent-purple-500"
          />
          <span className="text-[11px] font-pixel text-slate-300">Run as background task</span>
        </label>
      </Field>

      <Field label="MCP Servers (one per line: name or name:command or name:url)">
        <textarea
          value={mcpText}
          onChange={(e) => {
            setMcpText(e.target.value);
            updateDef({ mcpServers: parseMcpServersText(e.target.value) });
          }}
          rows={3}
          placeholder={"github\nplaywright: npx -y @playwright/mcp@latest\ncustom: https://mcp.example.com/sse"}
          className="input-mono resize-none text-[10px]"
        />
        <div className="flex flex-wrap gap-1 mt-1">
          {MCP_PRESETS.map((preset) => {
            const alreadyAdded = mcpText.split('\n').some(l => l.trim().startsWith(preset.name + ':') || l.trim() === preset.name);
            return (
              <button
                key={preset.name}
                onClick={() => {
                  if (alreadyAdded) return;
                  const newText = mcpText ? mcpText.trimEnd() + '\n' + preset.value : preset.value;
                  setMcpText(newText);
                  updateDef({ mcpServers: parseMcpServersText(newText) });
                }}
                disabled={alreadyAdded}
                className={`text-[9px] font-pixel px-1.5 py-0.5 rounded border ${
                  alreadyAdded
                    ? 'border-slate-700 text-slate-600 cursor-default'
                    : 'border-purple-700/50 text-purple-300 hover:bg-purple-900/30 cursor-pointer'
                }`}
                title={preset.description}
              >
                {alreadyAdded ? '✓ ' : '+ '}{preset.name}
              </button>
            );
          })}
        </div>
      </Field>

      <Field label="Hooks (JSON)">
        <textarea
          value={hooksText}
          onChange={(e) => {
            setHooksText(e.target.value);
            try {
              const parsed = JSON.parse(e.target.value || '{}');
              if (typeof parsed === 'object' && !Array.isArray(parsed)) {
                updateDef({ hooks: Object.keys(parsed).length > 0 ? parsed : undefined });
              }
            } catch { /* invalid JSON, don't update */ }
          }}
          rows={4}
          placeholder={'{\n  "PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "./validate.sh"}]}]\n}'}
          className="input-mono resize-none text-[10px]"
        />
      </Field>

      {generatePrompt !== null && (
        <div className="bg-emerald-900/30 border border-emerald-700/50 rounded p-2 space-y-2">
          <label className="text-[10px] font-pixel text-emerald-300 block">Describe what this agent should do:</label>
          <input
            autoFocus
            value={generatePrompt}
            onChange={e => onUpdateGeneratePrompt(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && generatePrompt.trim()) onGenerate(generatePrompt.trim()); if (e.key === 'Escape') onCancelGenerate(); }}
            placeholder='e.g. "frontend React developer"'
            className="w-full input-mono text-[10px]"
          />
          <div className="flex gap-2">
            <button onClick={onCancelGenerate} className="flex-1 btn-pixel bg-slate-700 hover:bg-slate-600 text-[10px]">Cancel</button>
            <button onClick={() => generatePrompt.trim() && onGenerate(generatePrompt.trim())} className="flex-1 btn-pixel bg-emerald-700 hover:bg-emerald-600 text-[10px]">Generate</button>
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <button
          onClick={onSaveToFile}
          disabled={saving || generating}
          className="flex-1 btn-pixel bg-purple-700 hover:bg-purple-600 text-[10px] disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save to .md File'}
        </button>
        <button
          onClick={onRequestGenerate}
          disabled={saving || generating || generatePrompt !== null}
          className="flex-1 btn-pixel bg-emerald-700 hover:bg-emerald-600 text-[10px] disabled:opacity-50"
        >
          {generating ? 'Generating…' : '✨ AI Generate'}
        </button>
      </div>
    </div>
  );
}

/** Common MCP server presets for quick-add buttons */
const MCP_PRESETS = [
  { name: 'github', value: 'github: npx -y @modelcontextprotocol/server-github', description: 'GitHub repos, issues, PRs' },
  { name: 'filesystem', value: 'filesystem: npx -y @modelcontextprotocol/server-filesystem', description: 'File system access' },
  { name: 'postgres', value: 'postgres: npx -y @modelcontextprotocol/server-postgres', description: 'PostgreSQL database' },
  { name: 'slack', value: 'slack: npx -y @anthropic/mcp-server-slack', description: 'Slack messages & channels' },
  { name: 'linear', value: 'linear: npx -y @anthropic/mcp-server-linear', description: 'Linear issues & projects' },
  { name: 'playwright', value: 'playwright: npx -y @playwright/mcp@latest', description: 'Browser automation & testing' },
  { name: 'memory', value: 'memory: npx -y @modelcontextprotocol/server-memory', description: 'Persistent key-value memory' },
  { name: 'fetch', value: 'fetch: npx -y @anthropic/mcp-server-fetch', description: 'HTTP fetching' },
];

/** Serialize mcpServers to a simple text format for editing */
function serializeMcpServers(servers?: SubagentDef['mcpServers']): string {
  if (!servers || servers.length === 0) return '';
  return servers.map(entry => {
    if (typeof entry === 'string') return entry;
    return Object.entries(entry).map(([name, cfg]) => {
      if (cfg.command) {
        const args = cfg.args ? ' ' + cfg.args.join(' ') : '';
        return `${name}: ${cfg.command}${args}`;
      }
      if (cfg.url) return `${name}: ${cfg.url}`;
      return name;
    }).join('\n');
  }).join('\n');
}

/** Parse the simple text format back to mcpServers */
function parseMcpServersText(text: string): SubagentDef['mcpServers'] | undefined {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return undefined;
  return lines.map(line => {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) return line; // string reference
    const name = line.slice(0, colonIdx).trim();
    const rest = line.slice(colonIdx + 1).trim();
    if (!rest) return name;
    // Check if it's a URL
    if (rest.startsWith('http://') || rest.startsWith('https://')) {
      return { [name]: { type: 'http' as const, url: rest } };
    }
    // Otherwise treat as command + args
    const parts = rest.split(/\s+/);
    const cmd = parts[0];
    const args = parts.length > 1 ? parts.slice(1) : undefined;
    return { [name]: { type: 'stdio' as const, command: cmd, args } };
  });
}

/** Serialize hooks to JSON for editing */
function serializeHooks(hooks?: SubagentDef['hooks']): string {
  if (!hooks || Object.keys(hooks).length === 0) return '';
  return JSON.stringify(hooks, null, 2);
}
