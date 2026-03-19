import { useState, useEffect, useCallback } from 'react';
import { getClaudeCodeAuthStatus, isElectron, writeClaudeSettings } from '../lib/terminal';

type Step = 'welcome' | 'claude-code' | 'permissions' | 'ready';

const RECOMMENDED_PERMISSIONS = {
  allow: [
    'Read',
    'Edit',
    'Write',
    'Glob',
    'Grep',
    'Bash(git *)',
    'Bash(npm test *)',
    'Bash(npm run *)',
    'Bash(npx *)',
    'Bash(node *)',
    'Bash(ls *)',
    'Bash(cat *)',
    'Bash(mkdir *)',
    'Bash(cp *)',
    'Bash(mv *)',
    'WebFetch',
    'WebSearch',
  ],
  deny: [
    'Bash(rm -rf /)',
    'Bash(git push --force *)',
    'Bash(curl * | bash)',
    'Bash(wget * | bash)',
  ],
};

interface Props {
  onComplete: () => void;
  onOpenPerms: () => void;
  permsModalOpen?: boolean;
}

export default function OnboardingModal({ onComplete, onOpenPerms, permsModalOpen }: Props) {
  const [step, setStep] = useState<Step>('welcome');
  const [ccInstalled, setCcInstalled] = useState(false);
  const [ccAuthed, setCcAuthed] = useState(false);
  const [checking, setChecking] = useState(false);
  const [applyingPerms, setApplyingPerms] = useState(false);
  const [permsApplied, setPermsApplied] = useState(false);

  const checkClaude = useCallback(async () => {
    if (!isElectron()) return;
    setChecking(true);
    try {
      const status = await getClaudeCodeAuthStatus();
      setCcInstalled(!!status.installed);
      setCcAuthed(!!(status.installed && status.authenticated));
    } catch { /* noop */ }
    setChecking(false);
  }, []);

  useEffect(() => {
    if (step === 'claude-code') checkClaude();
  }, [step, checkClaude]);

  const applyRecommended = useCallback(async () => {
    setApplyingPerms(true);
    try {
      const ok = await writeClaudeSettings('project', { permissions: RECOMMENDED_PERMISSIONS });
      setPermsApplied(ok);
    } catch { /* noop */ }
    setApplyingPerms(false);
  }, []);

  // Hide onboarding when the permissions editor is open so it doesn't cover it
  if (permsModalOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[60]">
      <div className="bg-slate-800 border border-slate-600 rounded-xl w-[520px] shadow-2xl overflow-hidden">
        {/* Progress bar */}
        <div className="flex h-1 bg-slate-700">
          {(['welcome', 'claude-code', 'permissions', 'ready'] as Step[]).map((s, i) => (
            <div
              key={s}
              className="flex-1 transition-colors duration-300"
              style={{
                backgroundColor:
                  i <= ['welcome', 'claude-code', 'permissions', 'ready'].indexOf(step)
                    ? '#6366f1'
                    : 'transparent',
              }}
            />
          ))}
        </div>

        <div className="p-6">
          {step === 'welcome' && (
            <div className="text-center">
              <div className="text-4xl mb-4">🏢</div>
              <h2 className="text-lg font-pixel text-white mb-2">Welcome to Outworked</h2>
              <p className="text-sm text-slate-300 mb-1">Your AI Agent Headquarters</p>
              <p className="text-xs text-slate-400 mb-6 max-w-sm mx-auto">
                Outworked lets you hire, manage, and orchestrate AI agents that work on your codebase.
                Each agent is a Claude Code subagent with its own role and personality.
              </p>
              <div className="bg-slate-900/60 rounded-lg p-4 mb-6 text-left space-y-2">
                <p className="text-[11px] font-pixel text-indigo-300">Quick setup — 3 steps:</p>
                <div className="flex items-center gap-2 text-xs text-slate-300">
                  <span className="w-5 h-5 rounded-full bg-indigo-600 flex items-center justify-center text-[10px] font-bold shrink-0">1</span>
                  Install & authenticate Claude Code CLI
                </div>
                <div className="flex items-center gap-2 text-xs text-slate-300">
                  <span className="w-5 h-5 rounded-full bg-indigo-600 flex items-center justify-center text-[10px] font-bold shrink-0">2</span>
                  Set up permissions for your project
                </div>
                <div className="flex items-center gap-2 text-xs text-slate-300">
                  <span className="w-5 h-5 rounded-full bg-indigo-600 flex items-center justify-center text-[10px] font-bold shrink-0">3</span>
                  Talk to The Boss to start working
                </div>
              </div>
              <button
                onClick={() => setStep('claude-code')}
                className="btn-pixel bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-2 text-sm"
              >
                Let's Go
              </button>
            </div>
          )}

          {step === 'claude-code' && (
            <div>
              <h2 className="text-lg font-pixel text-white mb-1">Step 1: Claude Code CLI</h2>
              <p className="text-xs text-slate-400 mb-5">
                Outworked uses Claude Code under the hood to power your agents. You need it installed and authenticated.
              </p>

              <div className="space-y-3 mb-6">
                {/* Install check */}
                <div className={`rounded-lg border p-3 ${ccInstalled ? 'bg-emerald-950/30 border-emerald-700/40' : 'bg-slate-900/60 border-slate-700'}`}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm">{ccInstalled ? '✅' : '⬜'}</span>
                    <span className="text-xs font-pixel text-slate-200">CLI Installed</span>
                  </div>
                  {!ccInstalled && (
                    <div className="ml-6">
                      <p className="text-[11px] text-slate-400 mb-1.5">Run this in your terminal:</p>
                      <code className="block bg-slate-950 rounded px-3 py-1.5 text-[11px] font-mono text-amber-300 select-all">
                        curl -fsSL https://claude.ai/install.sh | bash
                      </code>
                    </div>
                  )}
                </div>

                {/* Auth check */}
                <div className={`rounded-lg border p-3 ${ccAuthed ? 'bg-emerald-950/30 border-emerald-700/40' : 'bg-slate-900/60 border-slate-700'}`}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm">{ccAuthed ? '✅' : '⬜'}</span>
                    <span className="text-xs font-pixel text-slate-200">Authenticated</span>
                  </div>
                  {ccInstalled && !ccAuthed && (
                    <div className="ml-6">
                      <p className="text-[11px] text-slate-400 mb-1.5">Log in to your Anthropic account:</p>
                      <code className="block bg-slate-950 rounded px-3 py-1.5 text-[11px] font-mono text-amber-300 select-all">
                        claude login
                      </code>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-between">
                <button
                  onClick={checkClaude}
                  disabled={checking}
                  className="btn-pixel bg-slate-700 hover:bg-slate-600 text-slate-200 text-[11px] px-3 py-1.5 disabled:opacity-50"
                >
                  {checking ? '⏳ Checking…' : '🔄 Recheck'}
                </button>
                <button
                  onClick={() => setStep('permissions')}
                  className={`btn-pixel text-sm px-5 py-2 ${
                    ccAuthed
                      ? 'bg-indigo-600 hover:bg-indigo-500 text-white'
                      : 'bg-slate-700 hover:bg-slate-600 text-slate-300'
                  }`}
                >
                  {ccAuthed ? 'Next' : 'Skip for Now'}
                </button>
              </div>
            </div>
          )}

          {step === 'permissions' && (
            <div>
              <h2 className="text-lg font-pixel text-white mb-1">Step 2: Permissions</h2>
              <p className="text-xs text-slate-400 mb-5">
                Set up allow/deny rules so your agents know what tools they're allowed to use — file edits,
                terminal commands, etc. This keeps things safe and avoids constant approval prompts.
              </p>

              <div className={`rounded-lg border p-4 mb-4 ${permsApplied ? 'bg-emerald-950/30 border-emerald-700/40' : 'bg-slate-900/60 border-slate-700'}`}>
                <div className="flex items-center justify-between mb-3">
                  <p className="text-[11px] font-pixel text-slate-300">Recommended starter permissions:</p>
                  {permsApplied && <span className="text-[10px] text-emerald-400 font-pixel">Applied</span>}
                </div>
                <div className="space-y-1.5 text-[11px] font-mono text-slate-400 mb-4">
                  <p><span className="text-emerald-400">Allow:</span> Read, Edit, Write, Glob, Grep</p>
                  <p><span className="text-emerald-400">Allow:</span> Bash(git *), Bash(npm run *), Bash(node *)</p>
                  <p><span className="text-emerald-400">Allow:</span> WebFetch, WebSearch</p>
                  <p><span className="text-red-400">Deny:</span> Bash(rm -rf /), Bash(git push --force *)</p>
                </div>
                <button
                  onClick={applyRecommended}
                  disabled={applyingPerms || permsApplied}
                  className={`btn-pixel text-[11px] px-4 py-1.5 w-full ${
                    permsApplied
                      ? 'bg-emerald-800 text-emerald-200 cursor-default'
                      : 'bg-indigo-600 hover:bg-indigo-500 text-white'
                  } disabled:opacity-70`}
                >
                  {applyingPerms ? 'Applying...' : permsApplied ? 'Recommended Permissions Applied' : 'Apply Recommended Permissions'}
                </button>
              </div>

              <div className="flex items-center justify-between">
                <button
                  onClick={onOpenPerms}
                  className="btn-pixel bg-slate-700 hover:bg-slate-600 text-slate-200 text-[11px] px-3 py-1.5"
                >
                  Customize Manually
                </button>
                <button
                  onClick={() => setStep('ready')}
                  className="btn-pixel bg-indigo-600 hover:bg-indigo-500 text-white text-sm px-5 py-2"
                >
                  Next
                </button>
              </div>
            </div>
          )}

          {step === 'ready' && (
            <div className="text-center">
              <div className="text-4xl mb-4">🎉</div>
              <h2 className="text-lg font-pixel text-white mb-2">You're All Set!</h2>
              <p className="text-xs text-slate-400 mb-6 max-w-sm mx-auto">
                Click on <span className="text-indigo-300 font-pixel">The Boss</span> in the office and start chatting.
                Tell them what you need done and they'll delegate tasks to your team.
              </p>

              <div className="bg-slate-900/60 rounded-lg p-4 mb-6 text-left space-y-2 max-w-sm mx-auto">
                <p className="text-[11px] font-pixel text-indigo-300 mb-2">Tips:</p>
                <div className="flex items-start gap-2 text-[11px] text-slate-300">
                  <span className="text-indigo-400 mt-0.5 shrink-0">▸</span>
                  <span><span className="font-pixel text-slate-200">Hire agents</span> — click + in the sidebar to add specialists</span>
                </div>
                <div className="flex items-start gap-2 text-[11px] text-slate-300">
                  <span className="text-indigo-400 mt-0.5 shrink-0">▸</span>
                  <span><span className="font-pixel text-slate-200">Teams mode</span> — enable it to let The Boss delegate across multiple agents</span>
                </div>
                <div className="flex items-start gap-2 text-[11px] text-slate-300">
                  <span className="text-indigo-400 mt-0.5 shrink-0">▸</span>
                  <span><span className="font-pixel text-slate-200">Files & Git</span> — use the right panel tabs to browse your project</span>
                </div>
              </div>

              <button
                onClick={onComplete}
                className="btn-pixel bg-emerald-600 hover:bg-emerald-500 text-white px-6 py-2 text-sm"
              >
                Start Working
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
