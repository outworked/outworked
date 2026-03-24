// Bridge to Electron shell APIs exposed via preload
// Falls back to no-ops when running in a regular browser (npm run dev)

import { SubagentDef } from './types';
export type { SubagentDef } from './types';

export interface ClaudeCodeAuthStatus {
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  accountInfo: string | null;
  error: string | null;
}

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
  code: number;
}

interface ClaudeCodeAPI {
  start: (prompt: string, systemPrompt: string, cwd?: string, timeoutMs?: number) => Promise<number>;
  startAdvanced: (options: ClaudeCodeAdvancedOptions) => Promise<number>;
  abort: (reqId: number) => Promise<boolean>;
  sendInput: (reqId: number, text: string) => Promise<boolean>;
  resolvePermission: (permId: string, allow: boolean) => Promise<boolean>;
  onPermissionRequest: (cb: (reqId: number, request: { permId: string; tool: string; input?: Record<string, unknown>; description: string; agentName?: string }) => void) => () => void;
  onChunk: (cb: (reqId: number, data: string) => void) => () => void;
  onEvent: (cb: (reqId: number, event: ClaudeCodeEvent) => void) => () => void;
  onStderr: (cb: (reqId: number, data: string) => void) => () => void;
  onDone: (cb: (reqId: number, code: number, error: string | null) => void) => () => void;
  version: () => Promise<string | null>;
  authStatus: () => Promise<ClaudeCodeAuthStatus>;
  listAgents: (cwd?: string) => Promise<{ ok: boolean; stdout: string; stderr: string; code?: number; error?: string }>;
  readAgentFiles: (cwd?: string) => Promise<AgentFileInfo[]>;
  writeAgentFile: (filePath: string, content: string) => Promise<{ ok: boolean; error?: string }>;
  deleteAgentFile: (filePath: string) => Promise<{ ok: boolean; error?: string }>;
  onAgentsChanged: (cb: () => void) => () => void;
  watchProjectAgents: (projectDir: string | null) => void;
}

export interface ClaudeCodeAdvancedOptions {
  prompt?: string;
  cwd?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  model?: string; // 'sonnet' | 'opus' | 'haiku' | full model ID
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  maxBudget?: number;
  continueSession?: boolean;
  resumeSessionId?: string;
  agents?: Record<string, SubagentDef>;
  permissionMode?: 'default' | 'acceptEdits' | 'dontAsk' | 'bypassPermissions' | 'plan';
  dangerouslySkipPermissions?: boolean;
  mcpServers?: SubagentDef['mcpServers'];
  tools?: string;
  enableAgentTeams?: boolean;
  teammateMode?: 'auto' | 'in-process' | 'tmux';
  timeoutMs?: number;
}

export interface AgentFileInfo {
  file: string;
  path: string;
  content: string;
  scope: 'user' | 'project';
}

// SDK message event from Claude Code (via @anthropic-ai/claude-agent-sdk).
// This is a union-friendly interface — each message has a `type` discriminator.
// See SDK docs for the full SDKMessage union type.
export interface ClaudeCodeEvent {
  type: string;
  subtype?: string;
  uuid?: string;
  session_id?: string;
  parent_tool_use_id?: string | null;
  // For assistant messages (type: "assistant")
  message?: {
    id?: string;
    role?: string;
    model?: string;
    content?: string | Array<{ type: string; text?: string; name?: string; input?: unknown; id?: string }>;
    stop_reason?: string | null;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  // For result messages (type: "result")
  result?: string;
  is_error?: boolean;
  errors?: string[];
  duration_ms?: number;
  total_cost_usd?: number;
  num_turns?: number;
  stop_reason?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  // For system messages (type: "system", subtype: "init")
  tools?: string[];
  model?: string;
  permissionMode?: string;
  // For stream_event (partial messages)
  event?: {
    type?: string;
    delta?: { type?: string; text?: string };
    content_block?: { type?: string; name?: string; id?: string; text?: string };
    message?: { id?: string; model?: string; usage?: { input_tokens?: number; output_tokens?: number } };
  };
}

interface ElectronAPI {
  isElectron: boolean;
  platform: string;
  homedir: string;
  shell: {
    spawn: (cwd?: string) => Promise<number>;
    write: (id: number, data: string) => Promise<boolean>;
    kill: (id: number) => Promise<boolean>;
    onStdout: (cb: (id: number, data: string) => void) => () => void;
    onStderr: (cb: (id: number, data: string) => void) => () => void;
    onExit: (cb: (id: number, code: number) => void) => () => void;
  };
  exec: (command: string, cwd?: string, timeoutMs?: number) => Promise<ExecResult>;
  claudeCode?: ClaudeCodeAPI;
  claudeSettings?: {
    read: (scope: 'global' | 'project') => Promise<{ ok: boolean; settings?: Record<string, unknown>; exists?: boolean; error?: string }>;
    write: (scope: 'global' | 'project', settings: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
    readClaudeMd: () => Promise<{ ok: boolean; content?: string; exists?: boolean; error?: string }>;
    writeClaudeMd: (content: string) => Promise<{ ok: boolean; error?: string }>;
  };
  watcher?: {
    watchWorkspace: (dir: string) => void;
    unwatchWorkspace: () => void;
    onFileChanged: (cb: (data: { eventType: string; filename: string }) => void) => () => void;
    onFileTreeChanged: (cb: () => void) => () => void;
  };
  git?: {
    isRepo: (cwd?: string) => Promise<{ ok: boolean; isRepo: boolean }>;
    status: (cwd?: string) => Promise<GitStatusResult>;
    statusDetailed: (cwd?: string) => Promise<GitStatusDetailedResult>;
    diff: (cwd?: string, ref?: string, filepath?: string) => Promise<GitDiffResult>;
    diffStaged: (cwd?: string, filepath?: string) => Promise<GitDiffResult>;
    diffStat: (cwd?: string) => Promise<{ ok: boolean; stat?: string; error?: string }>;
    log: (cwd?: string) => Promise<{ ok: boolean; log?: string; error?: string }>;
    stashRef: (cwd?: string) => Promise<{ ok: boolean; ref?: string; error?: string }>;
    branchInfo: (cwd?: string) => Promise<GitBranchInfoResult>;
    stage: (cwd?: string, files?: string[]) => Promise<{ ok: boolean; error?: string }>;
    unstage: (cwd?: string, files?: string[]) => Promise<{ ok: boolean; error?: string }>;
    commit: (cwd?: string, message?: string) => Promise<{ ok: boolean; output?: string; error?: string }>;
    createBranch: (cwd?: string, name?: string) => Promise<{ ok: boolean; branch?: string; error?: string }>;
    checkoutBranch: (cwd?: string, name?: string) => Promise<{ ok: boolean; error?: string }>;
    push: (cwd?: string, setUpstream?: boolean) => Promise<{ ok: boolean; output?: string; error?: string }>;
    createPr: (cwd?: string, title?: string, body?: string, baseBranch?: string) => Promise<{ ok: boolean; output?: string; url?: string; error?: string }>;
  };
}

function getAPI(): ElectronAPI | null {
  const w = window as unknown as { electronAPI?: ElectronAPI };
  return w.electronAPI?.isElectron ? w.electronAPI : null;
}

export function getHomedir(): string {
  const api = getAPI();
  return api?.homedir || '~';
}

export function onClaudeAgentsChanged(cb: () => void): () => void {
  const api = getAPI();
  if (!api?.claudeCode?.onAgentsChanged) return () => {};
  return api.claudeCode.onAgentsChanged(cb);
}

export function watchProjectAgents(projectDir: string | null): void {
  const api = getAPI();
  api?.claudeCode?.watchProjectAgents(projectDir);
}

export function isElectron(): boolean {
  return getAPI() !== null;
}

// ─── Interactive shell ────────────────────────────────────────────

export function spawnShell(cwd?: string): Promise<number> {
  const api = getAPI();
  if (!api) return Promise.resolve(-1);
  return api.shell.spawn(cwd);
}

export function writeShell(id: number, data: string): Promise<boolean> {
  const api = getAPI();
  if (!api) return Promise.resolve(false);
  return api.shell.write(id, data);
}

export function killShell(id: number): Promise<boolean> {
  const api = getAPI();
  if (!api) return Promise.resolve(false);
  return api.shell.kill(id);
}

export function onShellStdout(cb: (id: number, data: string) => void): () => void {
  const api = getAPI();
  if (!api) return () => {};
  return api.shell.onStdout(cb);
}

export function onShellStderr(cb: (id: number, data: string) => void): () => void {
  const api = getAPI();
  if (!api) return () => {};
  return api.shell.onStderr(cb);
}

export function onShellExit(cb: (id: number, code: number) => void): () => void {
  const api = getAPI();
  if (!api) return () => {};
  return api.shell.onExit(cb);
}

// ─── One-shot command execution (for agent tools) ─────────────────

export async function execCommand(
  command: string,
  cwd?: string,
  timeoutMs?: number,
): Promise<ExecResult> {
  const api = getAPI();
  if (!api) {
    return { ok: false, stdout: '', stderr: 'Not running in Electron', code: -1 };
  }
  return api.exec(command, cwd, timeoutMs);
}

// ─── Claude Code execution (streaming via SDK) ────────────────────

export async function runClaudeCode(
  prompt: string,
  systemPrompt: string,
  cwd?: string,
  onData?: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const result = await runClaudeCodeAdvanced(
    { prompt, systemPrompt, cwd },
    { onTextDelta: onData },
    signal,
  );
  return result.result;
}

// ─── Advanced Claude Code execution ───────────────────────────────
// Receives typed SDK messages via the claude-code:event IPC channel.

export interface PermissionRequest {
  reqId: number;
  permId: string;
  tool: string;
  input?: Record<string, unknown>;
  description: string;
  agentName?: string;
}

export interface ClaudeCodeStreamCallbacks {
  onTextDelta?: (text: string) => void;
  onToolUse?: (name: string, input: Record<string, unknown>) => void;
  onToolResult?: (content: string, isError: boolean) => void;
  onEvent?: (event: ClaudeCodeEvent) => void;
  onStderr?: (text: string) => void;
  onPermissionRequest?: (request: PermissionRequest) => void;
}

export async function runClaudeCodeAdvanced(
  options: ClaudeCodeAdvancedOptions,
  callbacks: ClaudeCodeStreamCallbacks,
  signal?: AbortSignal,
): Promise<{
  result: string;
  sessionId?: string;
  cost?: number;
  usage?: { input_tokens: number; output_tokens: number };
}> {
  const api = getAPI();
  if (!api?.claudeCode) {
    throw new Error('Claude Code requires the Electron app. Make sure `claude` CLI is installed.');
  }

  const reqId = await api.claudeCode.startAdvanced(options);

  if (signal) {
    const onAbort = () => api.claudeCode!.abort(reqId);
    signal.addEventListener('abort', onAbort, { once: true });
  }

  return new Promise((resolve, reject) => {
    let fullText = '';
    let stderrText = '';
    let resultErrors: string[] = [];
    let sessionId: string | undefined;
    let cost: number | undefined;
    let usage: { input_tokens: number; output_tokens: number } | undefined;

    // Receive typed SDK messages directly — no NDJSON parsing needed
    const removeEvent = api.claudeCode!.onEvent((id, event: ClaudeCodeEvent) => {
      if (id !== reqId) return;
      callbacks.onEvent?.(event);

      // Extract text from assistant messages
      if (event.type === 'assistant' && event.message?.content) {
        const content = event.message.content;
        let newText = '';
        if (typeof content === 'string') {
          newText = content;
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              newText += block.text;
            } else if (block.type === 'tool_use' && block.name) {
              callbacks.onToolUse?.(block.name, (block.input as Record<string, unknown>) || {});
            }
          }
        }
        // Only emit a delta for the new portion of text
        if (newText.length > fullText.length) {
          const delta = newText.slice(fullText.length);
          fullText = newText;
          callbacks.onTextDelta?.(delta);
        } else if (newText && newText !== fullText) {
          // Content was replaced (e.g. new turn)
          fullText = newText;
          callbacks.onTextDelta?.(newText);
        }
      }

      // Handle result message (final)
      if (event.type === 'result') {
        if (event.result) fullText = event.result;
        if (event.is_error && event.errors?.length) {
          resultErrors = event.errors;
        }
        sessionId = event.session_id;
        cost = event.total_cost_usd;
        if (event.usage) {
          usage = {
            input_tokens: event.usage.input_tokens || 0,
            output_tokens: event.usage.output_tokens || 0,
          };
        }
      }
    });

    const removeStderr = api.claudeCode!.onStderr((id, data) => {
      if (id !== reqId) return;
      stderrText += data;
      callbacks.onStderr?.(data);
    });

    // Listen for permission requests from the SDK's canUseTool handler
    const removePermission = api.claudeCode!.onPermissionRequest((id, raw) => {
      if (id !== reqId) return;
      callbacks.onPermissionRequest?.({
        reqId: id,
        permId: raw.permId,
        tool: raw.tool,
        input: raw.input,
        description: raw.description,
        agentName: raw.agentName,
      });
    });

    const removeDone = api.claudeCode!.onDone((id, code, error) => {
      if (id !== reqId) return;
      cleanup();

      if (error) {
        reject(new Error(`Claude Code error: ${error}${stderrText ? `\nstderr: ${stderrText.trim()}` : ''}`));
      } else if (code !== 0) {
        const detail = resultErrors.join('; ') || stderrText.trim() || fullText || '';
        reject(new Error(detail ? `Claude Code exited with code ${code}: ${detail}` : `Claude Code exited with code ${code}`));
      } else {
        resolve({ result: fullText, sessionId, cost, usage });
      }
    });

    function cleanup() {
      removeEvent();
      removeStderr();
      removePermission();
      removeDone();
    }
  });
}

// ─── Claude Code Utilities ────────────────────────────────────────

export async function getClaudeCodeVersion(): Promise<string | null> {
  const api = getAPI();
  if (!api?.claudeCode) return null;
  return api.claudeCode.version();
}

export async function getClaudeCodeAuthStatus(): Promise<ClaudeCodeAuthStatus> {
  const api = getAPI();
  if (!api?.claudeCode) {
    return { installed: false, version: null, authenticated: false, accountInfo: null, error: 'Not running in Electron' };
  }
  return api.claudeCode.authStatus();
}

export async function listClaudeAgents(cwd?: string): Promise<string | null> {
  const api = getAPI();
  if (!api?.claudeCode) return null;
  const result = await api.claudeCode.listAgents(cwd);
  return result.ok ? result.stdout : null;
}

export async function sendClaudeCodeInput(reqId: number, text: string): Promise<boolean> {
  const api = getAPI();
  if (!api?.claudeCode) return false;
  return api.claudeCode.sendInput(reqId, text);
}

export async function resolveClaudePermission(permId: string, allow: boolean): Promise<boolean> {
  const api = getAPI();
  if (!api?.claudeCode?.resolvePermission) {
    console.warn('[terminal] resolveClaudePermission: API not available');
    return false;
  }
  const result = await api.claudeCode.resolvePermission(permId, allow);
  return result;
}

export function onClaudePermissionRequest(cb: (reqId: number, request: PermissionRequest) => void): () => void {
  const api = getAPI();
  if (!api?.claudeCode?.onPermissionRequest) return () => {};
  return api.claudeCode.onPermissionRequest((reqId, raw) => {
    cb(reqId, {
      reqId,
      permId: raw.permId,
      tool: raw.tool,
      input: raw.input,
      description: raw.description,
      agentName: raw.agentName,
    });
  });
}

export async function readClaudeAgentFiles(cwd?: string): Promise<AgentFileInfo[]> {
  const api = getAPI();
  if (!api?.claudeCode) return [];
  return api.claudeCode.readAgentFiles(cwd);
}

export async function writeClaudeAgentFile(filePath: string, content: string): Promise<boolean> {
  const api = getAPI();
  if (!api?.claudeCode) return false;
  const result = await api.claudeCode.writeAgentFile(filePath, content);
  return result.ok;
}

export async function deleteClaudeAgentFile(filePath: string): Promise<boolean> {
  const api = getAPI();
  if (!api?.claudeCode) return false;
  const result = await api.claudeCode.deleteAgentFile(filePath);
  return result.ok;
}

export async function abortClaudeCode(reqId: number): Promise<boolean> {
  const api = getAPI();
  if (!api?.claudeCode) return false;
  return api.claudeCode.abort(reqId);
}

// ─── Claude Code Settings & Permissions Config ────────────────────

export interface ClaudePermissions {
  allow: string[];
  deny: string[];
}

export interface ClaudeSettingsJson {
  permissions?: ClaudePermissions;
  [key: string]: unknown;
}

export async function readClaudeSettings(scope: 'global' | 'project'): Promise<{ settings: ClaudeSettingsJson; exists: boolean }> {
  const api = getAPI();
  if (!api?.claudeSettings) return { settings: {}, exists: false };
  const result = await api.claudeSettings.read(scope);
  if (!result.ok) return { settings: {}, exists: false };
  return { settings: (result.settings || {}) as ClaudeSettingsJson, exists: result.exists ?? false };
}

export async function writeClaudeSettings(scope: 'global' | 'project', settings: ClaudeSettingsJson): Promise<boolean> {
  const api = getAPI();
  if (!api?.claudeSettings) return false;
  const result = await api.claudeSettings.write(scope, settings);
  return result.ok;
}

export async function readClaudeMd(): Promise<{ content: string; exists: boolean }> {
  const api = getAPI();
  if (!api?.claudeSettings) return { content: '', exists: false };
  const result = await api.claudeSettings.readClaudeMd();
  if (!result.ok) return { content: '', exists: false };
  return { content: result.content || '', exists: result.exists ?? false };
}

export async function writeClaudeMd(content: string): Promise<boolean> {
  const api = getAPI();
  if (!api?.claudeSettings) return false;
  const result = await api.claudeSettings.writeClaudeMd(content);
  return result.ok;
}

// ─── File Watcher ─────────────────────────────────────────────────

export function watchWorkspace(dir: string): void {
  const api = getAPI();
  api?.watcher?.watchWorkspace(dir);
}

export function unwatchWorkspace(): void {
  const api = getAPI();
  api?.watcher?.unwatchWorkspace();
}

export function onFileChanged(cb: (data: { eventType: string; filename: string }) => void): () => void {
  const api = getAPI();
  if (!api?.watcher?.onFileChanged) return () => {};
  return api.watcher.onFileChanged(cb);
}

export function onFileTreeChanged(cb: () => void): () => void {
  const api = getAPI();
  if (!api?.watcher?.onFileTreeChanged) return () => {};
  return api.watcher.onFileTreeChanged(cb);
}

// ─── Git ──────────────────────────────────────────────────────────

export interface GitStatusFile {
  status: string;
  path: string;
}

export interface GitStatusResult {
  ok: boolean;
  files?: GitStatusFile[];
  error?: string;
}

export interface GitDiffResult {
  ok: boolean;
  diff?: string;
  error?: string;
}

export async function gitIsRepo(cwd?: string): Promise<boolean> {
  const api = getAPI();
  if (!api?.git?.isRepo) return false;
  const res = await api.git.isRepo(cwd);
  return res?.isRepo === true;
}

export async function gitStatus(cwd?: string): Promise<GitStatusResult> {
  const api = getAPI();
  if (!api?.git) return { ok: false, error: 'Not in Electron' };
  return api.git.status(cwd);
}

export async function gitDiff(cwd?: string, ref?: string, filepath?: string): Promise<GitDiffResult> {
  const api = getAPI();
  if (!api?.git) return { ok: false, error: 'Not in Electron' };
  return api.git.diff(cwd, ref, filepath);
}

export async function gitDiffStat(cwd?: string): Promise<{ ok: boolean; stat?: string; error?: string }> {
  const api = getAPI();
  if (!api?.git) return { ok: false, error: 'Not in Electron' };
  return api.git.diffStat(cwd);
}

export async function gitLog(cwd?: string): Promise<{ ok: boolean; log?: string; error?: string }> {
  const api = getAPI();
  if (!api?.git) return { ok: false, error: 'Not in Electron' };
  return api.git.log(cwd);
}

export async function gitStashRef(cwd?: string): Promise<{ ok: boolean; ref?: string; error?: string }> {
  const api = getAPI();
  if (!api?.git) return { ok: false, error: 'Not in Electron' };
  return api.git.stashRef(cwd);
}

export interface GitBranchInfoResult {
  ok: boolean;
  current?: string;
  branches?: string[];
  remote?: string;
  ahead?: number;
  behind?: number;
  error?: string;
}

export interface GitStatusDetailedResult {
  ok: boolean;
  staged?: GitStatusFile[];
  unstaged?: GitStatusFile[];
  untracked?: GitStatusFile[];
  error?: string;
}

export async function gitStatusDetailed(cwd?: string): Promise<GitStatusDetailedResult> {
  const api = getAPI();
  if (!api?.git) return { ok: false, error: 'Not in Electron' };
  return api.git.statusDetailed(cwd);
}

export async function gitDiffStaged(cwd?: string, filepath?: string): Promise<GitDiffResult> {
  const api = getAPI();
  if (!api?.git) return { ok: false, error: 'Not in Electron' };
  return api.git.diffStaged(cwd, filepath);
}

export async function gitBranchInfo(cwd?: string): Promise<GitBranchInfoResult> {
  const api = getAPI();
  if (!api?.git) return { ok: false, error: 'Not in Electron' };
  return api.git.branchInfo(cwd);
}

export async function gitStage(cwd?: string, files?: string[]): Promise<{ ok: boolean; error?: string }> {
  const api = getAPI();
  if (!api?.git) return { ok: false, error: 'Not in Electron' };
  return api.git.stage(cwd, files);
}

export async function gitUnstage(cwd?: string, files?: string[]): Promise<{ ok: boolean; error?: string }> {
  const api = getAPI();
  if (!api?.git) return { ok: false, error: 'Not in Electron' };
  return api.git.unstage(cwd, files);
}

export async function gitCommit(cwd?: string, message?: string): Promise<{ ok: boolean; output?: string; error?: string }> {
  const api = getAPI();
  if (!api?.git) return { ok: false, error: 'Not in Electron' };
  return api.git.commit(cwd, message);
}

export async function gitCreateBranch(cwd?: string, name?: string): Promise<{ ok: boolean; branch?: string; error?: string }> {
  const api = getAPI();
  if (!api?.git) return { ok: false, error: 'Not in Electron' };
  return api.git.createBranch(cwd, name);
}

export async function gitCheckoutBranch(cwd?: string, name?: string): Promise<{ ok: boolean; error?: string }> {
  const api = getAPI();
  if (!api?.git) return { ok: false, error: 'Not in Electron' };
  return api.git.checkoutBranch(cwd, name);
}

export async function gitPush(cwd?: string, setUpstream?: boolean): Promise<{ ok: boolean; output?: string; error?: string }> {
  const api = getAPI();
  if (!api?.git) return { ok: false, error: 'Not in Electron' };
  return api.git.push(cwd, setUpstream);
}

export async function gitCreatePr(cwd?: string, title?: string, body?: string, baseBranch?: string): Promise<{ ok: boolean; output?: string; url?: string; error?: string }> {
  const api = getAPI();
  if (!api?.git) return { ok: false, error: 'Not in Electron' };
  return api.git.createPr(cwd, title, body, baseBranch);
}
