import { Agent, AgentSkill, ApiKeys, Message, ToolCall } from './types';
import { AGENT_TOOLS, ToolDefinition, executeTool } from './tools';
import { getWorkspace } from './filesystem';
import { runClaudeCode, runClaudeCodeAdvanced, ClaudeCodeAdvancedOptions, ClaudeCodeStreamCallbacks, PermissionRequest } from './terminal';

function buildToolPreamble(workspace: string): string {
  return `

## Workspace
Your working directory is: ${workspace}
All file operations and shell commands run in this directory by default.

## Tools
You have access to the local filesystem, sandboxed code execution, and a local terminal.
- write_file: Save code/content to a file in the workspace
- read_file: Read an existing file from the workspace
- list_files: List files in the workspace directory
- execute_code: Run JavaScript and see output
- delete_file: Remove a file from the workspace
- run_command: Run a shell command (npm install, git, ls, etc.) — runs in workspace by default
- update_todos: Create/update your task checklist (call at START of any non-trivial task)
- assign_task: (Boss only) Delegate a task to an employee — they will execute it autonomously

Workflow: For multi-step tasks, ALWAYS call update_todos first to plan, then work through each step, updating todo statuses as you go. When coding: 1) plan with update_todos, 2) write files, 3) run_command to test, 4) mark todos done.
When writing code for a website, always start the frontend in dev mode to present it to the user right away, then iterate based on feedback. 
You can have multiple files open at once, but only one terminal command running at a time. Use the terminal for any command you would normally run in a shell, including starting dev servers, git commands, and npm installs.
`;
}

function buildSystemPrompt(agent: Agent, withTools: boolean, workspace = '', skills: AgentSkill[] = []): string {
  let prompt = agent.personality;
  // Combine app-level skills + any agent-level skills (legacy)
  const allSkills = [...skills, ...agent.skills];
  if (allSkills.length > 0) {
    prompt += '\n\n## Skills\n';
    for (const skill of allSkills) {
      prompt += `\n### ${skill.name}\n${skill.content}\n`;
    }
  }
  if (withTools) prompt += buildToolPreamble(workspace);
  return prompt;
}

export interface SendOptions {
  onToolCall?: (call: ToolCall) => void;
  useTools?: boolean; // default true
  skills?: AgentSkill[]; // app-level skills injected into all agents
  extraTools?: ToolDefinition[]; // additional tools (e.g. assign_task for boss)
  extraSystemPrompt?: string; // appended to the system prompt
  customToolExecutor?: (name: string, args: Record<string, unknown>) => Promise<string | null>; // return string to override default executeTool, null to use default
  onClaudeCodeEvent?: (event: { type: string; toolName?: string; toolInput?: Record<string, unknown>; text?: string }) => void;
  onPermissionRequest?: (request: PermissionRequest) => void;
  onStderr?: (text: string) => void;
}

export async function sendMessage(
  agent: Agent,
  userMessage: string,
  keys: ApiKeys,
  onThought: (text: string) => void,
  signal?: AbortSignal,
  options?: SendOptions,
): Promise<string> {
  const useTools = options?.useTools !== false;
  const workspace = useTools ? await getWorkspace() : '';
  let systemPrompt = buildSystemPrompt(agent, useTools, workspace, options?.skills);
  if (options?.extraSystemPrompt) systemPrompt += options.extraSystemPrompt;
  const messages: Message[] = [
    ...agent.history,
    { role: 'user', content: userMessage, timestamp: Date.now() },
  ];

  // Currently only Claude Code is supported — API-key-based providers are disabled
  if (agent.provider === 'claude-code') {
    return callClaudeCode(systemPrompt, messages, onThought, signal, agent, options?.onClaudeCodeEvent, options?.onPermissionRequest, options?.onStderr);
  } else {
    throw new Error(`Provider "${agent.provider}" is disabled. Only Claude Code (local) is supported. Switch this agent to Claude Code in the editor.`);
  }

  /* === API-key-based providers (commented out) ===
  if (agent.provider === 'openai') {
    return callOpenAI(agent.model, systemPrompt, messages, keys.openai, onThought, signal, useTools, options?.onToolCall, options?.extraTools, options?.customToolExecutor);
  } else if (agent.provider === 'google') {
    return callGemini(agent.model, systemPrompt, messages, keys.gemini, onThought, signal, useTools, options?.onToolCall, options?.extraTools, options?.customToolExecutor);
  } else {
    return callAnthropic(agent.model, systemPrompt, messages, keys.anthropic, onThought, signal, useTools, options?.onToolCall, options?.extraTools, options?.customToolExecutor);
  }
  */
}

// ─── Helpers ──────────────────────────────────────────────────────

function toolLabel(name: string, args: Record<string, unknown>): string {
  const p = (args.path as string) ?? '';
  switch (name) {
    case 'write_file': return `📁 Writing ${p}…`;
    case 'read_file': return `📖 Reading ${p}…`;
    case 'execute_code': return '▶️ Running code…';
    case 'list_files': return '📂 Listing files…';
    case 'delete_file': return `🗑️ Deleting ${p}…`;
    case 'run_command': return `💻 $ ${(args.command as string) ?? ''}…`;
    case 'update_todos': return `📋 Updating task list…`;
    case 'assign_task': return `📋 Assigning task to ${(args.employeeName as string) ?? 'employee'}…`;
    case 'git_status': return `🌿 Git status…`;
    case 'git_create_branch': return `🌿 Creating branch ${(args.branch as string) ?? ''}…`;
    case 'git_commit': return `💾 Committing: ${(args.message as string) ?? ''}…`;
    case 'git_push': return `🚀 Pushing to origin…`;
    case 'git_create_pr': return `🔀 Creating PR: ${(args.title as string) ?? ''}…`;
    default: return `🔧 ${name}…`;
  }
}

// ─── Claude Code CLI ──────────────────────────────────────────────
// Uses the locally-installed `claude` CLI.
// For subagent-backed agents, uses runClaudeCodeAdvanced with stream-json
// for full event visibility (tool calls, subagent activity, session metadata).
// For regular claude-code agents, falls back to the simpler runClaudeCode.

async function callClaudeCode(
  system: string,
  messages: Message[],
  onThought: (text: string) => void,
  signal?: AbortSignal,
  agent?: Agent,
  onClaudeCodeEvent?: SendOptions['onClaudeCodeEvent'],
  onPermissionRequest?: SendOptions['onPermissionRequest'],
  onStderr?: SendOptions['onStderr'],
): Promise<string> {
  // Build a single prompt from conversation history
  let prompt = '';
  for (const msg of messages) {
    if (msg.role === 'user') prompt += `Human: ${msg.content}\n\n`;
    else if (msg.role === 'assistant') prompt += `Assistant: ${msg.content}\n\n`;
  }

  const workspace = await getWorkspace();

  // Use advanced mode for subagent-backed agents (or any who have subagentDef)
  if (agent?.subagentDef) {
    return callClaudeCodeAdvanced(prompt, system, workspace, onThought, signal, agent, onClaudeCodeEvent, onPermissionRequest, onStderr);
  }

  // Fallback: simple mode for regular claude-code agents
  let fullText = '';
  onThought('🤖 Claude Code is thinking...');

  const output = await runClaudeCode(
    prompt,
    system,
    workspace,
    (chunk) => {
      fullText += chunk;
      onThought(fullText);
    },
    signal,
  );

  if (!fullText) {
    fullText = output;
    onThought(fullText);
  }

  return fullText;
}

/**
 * Advanced Claude Code invocation with stream-json parsing.
 * Used for subagent-backed agents for rich tool/event visibility.
 */
async function callClaudeCodeAdvanced(
  prompt: string,
  system: string,
  workspace: string,
  onThought: (text: string) => void,
  signal?: AbortSignal,
  agent?: Agent,
  onClaudeCodeEvent?: SendOptions['onClaudeCodeEvent'],
  onPermissionRequest?: SendOptions['onPermissionRequest'],
  onStderr?: SendOptions['onStderr'],
): Promise<string> {
  const subDef = agent?.subagentDef;

  const options: ClaudeCodeAdvancedOptions = {
    prompt,
    cwd: workspace,
    systemPrompt: system,
    outputFormat: 'stream-json',
    verbose: true,
    model: subDef?.model || undefined,
    allowedTools: subDef?.tools,
    disallowedTools: subDef?.disallowedTools,
    maxTurns: subDef?.maxTurns,
    permissionMode: (subDef?.permissionMode as ClaudeCodeAdvancedOptions['permissionMode']) || 'acceptEdits',
    mcpServers: subDef?.mcpServers,
    continueSession: !!agent?.sessionId,
    resumeSessionId: agent?.sessionId,
  };

  let fullText = '';
  onThought('🤖 Claude Code is thinking...');

  const callbacks: ClaudeCodeStreamCallbacks = {
    onTextDelta: (text) => {
      fullText += text;
      onThought(fullText);
    },
    onToolUse: (name, input) => {
      const label = claudeCodeToolLabel(name, input);
      if (fullText && !fullText.endsWith('\n')) fullText += '\n';
      fullText += `\n${label}\n`;
      onThought(fullText);
      onClaudeCodeEvent?.({ type: 'tool_use', toolName: name, toolInput: input });
    },
    onEvent: (event) => {
      onClaudeCodeEvent?.({ type: event.type, text: typeof event.result === 'string' ? event.result : undefined });
    },
    onStderr: onStderr,
    onPermissionRequest: onPermissionRequest,
  };

  const result = await runClaudeCodeAdvanced(options, callbacks, signal);

  // Store session ID on the agent for continuity
  if (agent && result.sessionId) {
    agent.sessionId = result.sessionId;
  }

  return result.result || fullText;
}

function claudeCodeToolLabel(name: string, args: Record<string, unknown>): string {
  const p = (args.file_path ?? args.path ?? args.command ?? '') as string;
  switch (name) {
    case 'Write': return `📁 Writing ${p}…`;
    case 'Edit': return `✏️ Editing ${p}…`;
    case 'Read': return `📖 Reading ${p}…`;
    case 'Bash': return `💻 $ ${p.slice(0, 80)}…`;
    case 'Glob': return `🔍 Searching files…`;
    case 'Grep': return `🔎 Grepping ${(args.pattern as string) ?? ''}…`;
    case 'WebFetch': return `🌐 Fetching ${p}…`;
    case 'WebSearch': return `🔍 Searching: ${(args.query as string) ?? ''}…`;
    case 'Agent': return `🤖 Delegating to subagent…`;
    case 'TodoWrite': return `📋 Updating task list…`;
    case 'TaskCreate': return `📋 Creating task…`;
    default: return `🔧 ${name} ${p ? `(${p.slice(0, 40)})` : ''}…`;
  }
}

/* === API-key-based providers (commented out) ===

// ─── OpenAI Responses API ─────────────────────────────────────────

function getOpenAITools(extraTools?: ToolDefinition[]) {
  const allTools = extraTools ? [...AGENT_TOOLS, ...extraTools] : AGENT_TOOLS;
  return allTools.map(t => ({
    type: 'function' as const,
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

async function callOpenAI(
  model: string,
  system: string,
  messages: Message[],
  apiKey: string,
  onThought: (text: string) => void,
  signal?: AbortSignal,
  useTools = true,
  onToolCall?: (call: ToolCall) => void,
  extraTools?: ToolDefinition[],
  customToolExecutor?: (name: string, args: Record<string, unknown>) => Promise<string | null>,
): Promise<string> {
  if (!apiKey) throw new Error('OpenAI API key not set. Click the key icon to add it.');

  const openaiTools = getOpenAITools(extraTools);

  // Build input for Responses API
  const input: Record<string, unknown>[] = messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role, content: m.content }));

  let fullText = '';
  const MAX_ROUNDS = 15;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const body: Record<string, unknown> = {
      model,
      instructions: system,
      input,
      stream: true,
    };
    if (useTools) body.tools = openaiTools;

    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenAI error ${res.status}: ${err}`);
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Track function calls by output_index
    const fnCalls = new Map<number, { id: string; callId: string; name: string; args: string }>();
    let gotFnCalls = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (!raw || raw === '[DONE]') continue;

        let evt: Record<string, unknown>;
        try { evt = JSON.parse(raw); } catch { continue; }
        const type = evt.type as string;

        // Text delta
        if (type === 'response.output_text.delta') {
          const delta = (evt.delta as string) ?? '';
          if (delta) {
            fullText += delta;
            onThought(fullText);
          }
        }

        // Function call started
        if (type === 'response.output_item.added') {
          const item = evt.item as Record<string, unknown> | undefined;
          if (item?.type === 'function_call') {
            fnCalls.set(evt.output_index as number, {
              id: item.id as string,
              callId: item.call_id as string,
              name: item.name as string,
              args: '',
            });
            gotFnCalls = true;
          }
        }

        // Function call arguments delta
        if (type === 'response.function_call_arguments.delta') {
          const fc = fnCalls.get(evt.output_index as number);
          if (fc) fc.args += (evt.delta as string) ?? '';
        }
      }
    }

    // Execute function calls and loop
    if (gotFnCalls) {
      for (const [, fc] of fnCalls) {
        let parsedArgs: Record<string, string> = {};
        try { parsedArgs = JSON.parse(fc.args); } catch { // empty }

        // Show status
        if (fullText && !fullText.endsWith('\n')) fullText += '\n';
        fullText += `\n${toolLabel(fc.name, parsedArgs)}\n`;
        onThought(fullText);

        const result = (customToolExecutor && await customToolExecutor(fc.name, parsedArgs)) ?? await executeTool(fc.name, parsedArgs);
        onToolCall?.({ name: fc.name, args: parsedArgs, result });

        // Add to input for next round
        input.push({
          type: 'function_call',
          id: fc.id,
          call_id: fc.callId,
          name: fc.name,
          arguments: fc.args,
        });
        input.push({
          type: 'function_call_output',
          call_id: fc.callId,
          output: result,
        });
      }
      continue;
    }

    break; // No function calls — done
  }

  return fullText;
}

// ─── Anthropic Messages API (with tool_use) ───────────────────────

function getAnthropicTools(extraTools?: ToolDefinition[]) {
  const allTools = extraTools ? [...AGENT_TOOLS, ...extraTools] : AGENT_TOOLS;
  return allTools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

async function callAnthropic(
  model: string,
  system: string,
  messages: Message[],
  apiKey: string,
  onThought: (text: string) => void,
  signal?: AbortSignal,
  useTools = true,
  onToolCall?: (call: ToolCall) => void,
  extraTools?: ToolDefinition[],
  customToolExecutor?: (name: string, args: Record<string, unknown>) => Promise<string | null>,
): Promise<string> {
  if (!apiKey) throw new Error('Anthropic API key not set. Click the key icon to add it.');

  const anthropicTools = getAnthropicTools(extraTools);

  // Build messages (Anthropic format)
  const apiMessages: Record<string, unknown>[] = messages
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    }));

  let fullText = '';
  const MAX_ROUNDS = 15;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const body: Record<string, unknown> = {
      model,
      max_tokens: 8192,
      stream: true,
      system,
      messages: apiMessages,
    };
    if (useTools) body.tools = anthropicTools;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Anthropic error ${res.status}: ${err}`);
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Track content blocks
    interface ContentBlock {
      type: string;
      id?: string;
      name?: string;
      text?: string;
      inputJson?: string;
    }
    const contentBlocks: ContentBlock[] = [];
    let stopReason = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (!raw) continue;

        let evt: Record<string, unknown>;
        try { evt = JSON.parse(raw); } catch { continue; }
        const type = evt.type as string;

        if (type === 'content_block_start') {
          const block = evt.content_block as Record<string, unknown>;
          const idx = evt.index as number;
          if (block.type === 'text') {
            contentBlocks[idx] = { type: 'text', text: '' };
          } else if (block.type === 'tool_use') {
            contentBlocks[idx] = {
              type: 'tool_use',
              id: block.id as string,
              name: block.name as string,
              inputJson: '',
            };
          }
        }

        if (type === 'content_block_delta') {
          const idx = evt.index as number;
          const delta = evt.delta as Record<string, unknown>;
          if (delta.type === 'text_delta') {
            const text = delta.text as string;
            if (contentBlocks[idx]) contentBlocks[idx].text = (contentBlocks[idx].text ?? '') + text;
            fullText += text;
            onThought(fullText);
          } else if (delta.type === 'input_json_delta') {
            const json = delta.partial_json as string;
            if (contentBlocks[idx]) contentBlocks[idx].inputJson = (contentBlocks[idx].inputJson ?? '') + json;
          }
        }

        if (type === 'message_delta') {
          const delta = evt.delta as Record<string, unknown>;
          if (delta.stop_reason) stopReason = delta.stop_reason as string;
        }
      }
    }

    // Handle tool calls
    const toolUseBlocks = contentBlocks.filter(b => b.type === 'tool_use');

    if (stopReason === 'tool_use' && toolUseBlocks.length > 0) {
      // Build assistant content for API continuation
      const assistantContent: Record<string, unknown>[] = [];
      for (const block of contentBlocks) {
        if (block.type === 'text' && block.text) {
          assistantContent.push({ type: 'text', text: block.text });
        } else if (block.type === 'tool_use') {
          let parsedInput = {};
          try { parsedInput = JSON.parse(block.inputJson ?? '{}'); } catch { // empty }
          assistantContent.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: parsedInput,
          });
        }
      }

      apiMessages.push({ role: 'assistant', content: assistantContent });

      // Execute tools and build results
      const toolResults: Record<string, unknown>[] = [];
      for (const block of toolUseBlocks) {
        let parsedArgs: Record<string, string> = {};
        try { parsedArgs = JSON.parse(block.inputJson ?? '{}'); } catch { // empty }

        if (fullText && !fullText.endsWith('\n')) fullText += '\n';
        fullText += `\n${toolLabel(block.name!, parsedArgs)}\n`;
        onThought(fullText);

        const result = (customToolExecutor && await customToolExecutor(block.name!, parsedArgs)) ?? await executeTool(block.name!, parsedArgs);
        onToolCall?.({ name: block.name!, args: parsedArgs, result });

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result,
        });
      }

      apiMessages.push({ role: 'user', content: toolResults });
      continue;
    }

    break; // No tool calls — done
  }

  return fullText;
}

// ─── Google Gemini API ────────────────────────────────────────────

function getGeminiTools(extraTools?: ToolDefinition[]) {
  const allTools = extraTools ? [...AGENT_TOOLS, ...extraTools] : AGENT_TOOLS;
  return [{
    functionDeclarations: allTools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
  }];
}

async function callGemini(
  model: string,
  system: string,
  messages: Message[],
  apiKey: string,
  onThought: (text: string) => void,
  signal?: AbortSignal,
  useTools = true,
  onToolCall?: (call: ToolCall) => void,
  extraTools?: ToolDefinition[],
  customToolExecutor?: (name: string, args: Record<string, unknown>) => Promise<string | null>,
): Promise<string> {
  if (!apiKey) throw new Error('Gemini API key not set. Click the key icon to add it.');

  const geminiTools = getGeminiTools(extraTools);

  // Convert messages to Gemini contents format
  const contents: Record<string, unknown>[] = messages
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

  let fullText = '';
  const MAX_ROUNDS = 15;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const body: Record<string, unknown> = {
      contents,
      systemInstruction: { parts: [{ text: system }] },
      generationConfig: { maxOutputTokens: 8192 },
    };
    if (useTools) body.tools = geminiTools;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Gemini error ${res.status}: ${err}`);
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const functionCalls: { name: string; args: Record<string, unknown> }[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (!raw || raw === '[DONE]') continue;

        let chunk: Record<string, unknown>;
        try { chunk = JSON.parse(raw); } catch { continue; }

        const candidates = chunk.candidates as Record<string, unknown>[] | undefined;
        if (!candidates?.length) continue;
        const parts = (candidates[0].content as Record<string, unknown> | undefined)?.parts as Record<string, unknown>[] | undefined;
        if (!parts) continue;

        for (const part of parts) {
          if (typeof part.text === 'string') {
            fullText += part.text;
            onThought(fullText);
          } else if (part.functionCall) {
            const fc = part.functionCall as Record<string, unknown>;
            functionCalls.push({
              name: fc.name as string,
              args: (fc.args ?? {}) as Record<string, unknown>,
            });
          }
        }
      }
    }

    if (functionCalls.length > 0) {
      // Append model turn with function calls to contents
      contents.push({
        role: 'model',
        parts: functionCalls.map(fc => ({
          functionCall: { name: fc.name, args: fc.args },
        })),
      });

      // Execute each tool and collect responses
      const responseParts: Record<string, unknown>[] = [];
      for (const fc of functionCalls) {
        if (fullText && !fullText.endsWith('\n')) fullText += '\n';
        fullText += `\n${toolLabel(fc.name, fc.args as Record<string, string>)}\n`;
        onThought(fullText);

        const result = (customToolExecutor && await customToolExecutor(fc.name, fc.args as Record<string, string>)) ?? await executeTool(fc.name, fc.args as Record<string, string>);
        onToolCall?.({ name: fc.name, args: fc.args, result });

        responseParts.push({
          functionResponse: {
            name: fc.name,
            response: { output: result },
          },
        });
      }

      contents.push({ role: 'user', parts: responseParts });
      continue;
    }

    break; // No function calls — done
  }

  return fullText;
}

=== end commented-out API providers === */
