import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { sleep } from '../util/env.mjs';

export const ACP_PROTOCOL_VERSION = 1;

const SCAFFOLD_PATTERNS = [
  { id: 'create-next-app', re: /\bcreate-next-app\b/i },
  { id: 'create-vite', re: /\b(?:npm\s+create\s+vite|create-vite)\b/i },
  { id: 'astro', re: /\bcreate\s+astro\b|\bastro\b/i },
  { id: 'sveltekit', re: /\bsv\s+create\b|\bcreate-svelte\b/i },
  { id: 'remix', re: /\bcreate-remix\b/i },
  { id: 'express', re: /\bnpm\s+i(?:nstall)?\b[^\n]*\bexpress\b/i },
  { id: 'fastify', re: /\bnpm\s+i(?:nstall)?\b[^\n]*\bfastify\b/i },
  { id: 'hono', re: /\bnpm\s+i(?:nstall)?\b[^\n]*\bhono\b/i },
  { id: 'sqlite', re: /\b(?:better-sqlite3|sqlite3|sql\.js|python3[^\n]*sqlite)\b/i },
  { id: 'prisma-drizzle', re: /\b(?:prisma|drizzle-orm)\b/i },
  { id: 'python-web', re: /\b(?:pip\s+install|uv\s+add)[^\n]*\b(?:fastapi|flask|django|uvicorn)\b/i },
  { id: 'go-mod', re: /\bgo\s+mod\s+init\b/i },
];

const SPONTANEOUS_PERF_PATTERNS = [
  { id: 'http-compression', label: 'Configured HTTP gzip/brotli compression', re: /\b(?:compression|gzip|brotli|Content-Encoding)\b/i },
  { id: 'cache-headers', label: 'Configured Cache-Control / ETag headers', re: /\b(?:Cache-Control|max-age|immutable|ETag)\b/i },
  { id: 'code-splitting-lazy', label: 'Used lazy-loading or dynamic import()', re: /\b(?:loading=["']lazy["']|React\.lazy|defineAsyncComponent)\b/i },
  { id: 'asset-optimization', label: 'Mentioned WebP/AVIF or font preconnect/swap', re: /\b(?:font-display:\s*swap|\.webp|\.avif)\b/i },
  { id: 'db-indexing', label: 'Added SQL/store indexes', re: /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i },
  { id: 'perf-reasoning', label: 'Reasoned about latency/bundle/CWV in thinking', re: /\b(?:Core Web Vitals|LCP|INP|CLS|TTFB|bundle size|minimize|render-blocking)\b/i },
];

function redactCommand(cmd = '') {
  return String(cmd)
    .replace(/(?:KEY|TOKEN|SECRET|PASSWORD)=[^\s]+/gi, '[REDACTED_ENV]')
    .trim()
    .slice(0, 260);
}

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function killProcessGroupSafe(pid) {
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return;
    }
  }
  await sleep(250);
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already exited
    }
  }
}

function resolveWorkspaceSafePath(workspaceDir, requestedPath, { allowReadOutside = false, allowedReadPaths = [] } = {}) {
  const root = resolve(workspaceDir);
  const resolved = resolve(root, String(requestedPath || ''));
  if (resolved === root || resolved.startsWith(root + '/')) {
    return resolved;
  }
  if (allowReadOutside) {
    for (const extra of allowedReadPaths) {
      const absExtra = resolve(extra);
      if (resolved === absExtra || resolved.startsWith(absExtra + '/')) {
        return resolved;
      }
    }
  }
  throw new Error(`Path "${requestedPath}" is outside the benchmark workspace boundary.`);
}

function isPermissionSafeForWorkspace(workspaceDir, params) {
  const rawInputStr = JSON.stringify(params?.toolCall?.rawInput || '');
  // Guard against obvious destructive system paths outside workspace
  if (/(?:\/etc\/passwd|\/etc\/shadow|~\/\.ssh|\brm\s+-rf\s+\/(?:\s|$|"|'))/i.test(rawInputStr)) {
    return false;
  }
  return true;
}

function pickAllowPermissionOption(options = []) {
  if (!Array.isArray(options) || options.length === 0) return null;
  const byKind = (k) => options.find((o) => o?.kind === k);
  return (
    options.find((o) => o?.optionId === 'acceptEdits') ||
    byKind('allow_always') ||
    byKind('allow_once') ||
    options.find((o) => String(o?.kind || '').startsWith('allow')) ||
    options.find((o) => /allow|accept|default/i.test(String(o?.optionId || ''))) ||
    null
  );
}

function pickRejectPermissionOption(options = []) {
  if (!Array.isArray(options) || options.length === 0) return null;
  return (
    options.find((o) => o?.kind === 'reject_once') ||
    options.find((o) => String(o?.kind || '').startsWith('reject')) ||
    options[options.length - 1]
  );
}

function matchDesiredModel(availableModels = [], desiredModelId = '', desiredKey = '') {
  if (!Array.isArray(availableModels) || availableModels.length === 0) return null;
  const targets = [desiredModelId, desiredKey]
    .map((s) => String(s || '').trim().toLowerCase())
    .filter(Boolean);
  if (targets.length === 0) return null;

  for (const t of targets) {
    const slugT = t.replace(/[./\s]+/g, '-');
    const exact = availableModels.find((m) => {
      const id = String(m.modelId || m.id || m.value || '').toLowerCase();
      return id === t || id.replace(/[./\s]+/g, '-') === slugT;
    });
    if (exact) return exact.modelId || exact.id || exact.value;

    const prefixHit = availableModels.find((m) => {
      const id = String(m.modelId || m.id || m.value || '').toLowerCase();
      // Only accept longer ids that extend the target (dated snapshots such as `<id>-20261001`). The reverse
      // (`claude-sonnet-5-5`.startsWith(`claude-sonnet-5`)) would silently pick an older model.
      return id.startsWith(`${t}-`) || id.startsWith(`${t}@`);
    });
    if (prefixHit) return prefixHit.modelId || prefixHit.id || prefixHit.value;
  }
  return null;
}

/**
 * Renders a self-contained HTML transcript viewer from an ACP session timeline (`acp-session.jsonl` / in-memory events)
 * so Benchmark Studio's "Agent Transcript" modal works identically across `pi`, `claude-acp`, and `codex-acp`.
 */
export function renderAcpTranscriptHtml({
  harnessLabel,
  agentInfo,
  modelId,
  stopReason,
  durationMs,
  timeline = [],
  planEntries = [],
}) {
  const itemsHtml = timeline
    .map((item) => {
      if (item.kind === 'thought') {
        return `<details class="block thought"><summary>Thinking (${item.text.length} chars)</summary><pre>${escapeHtml(item.text)}</pre></details>`;
      }
      if (item.kind === 'message') {
        return `<div class="block assistant"><div class="role">Assistant</div><pre>${escapeHtml(item.text)}</pre></div>`;
      }
      if (item.kind === 'tool') {
        const statusCls = item.status === 'failed' ? 'err' : 'ok';
        const inputSnippet = item.rawInput ? `\nInput: ${JSON.stringify(item.rawInput, null, 2).slice(0, 1200)}` : '';
        const outputSnippet = item.output ? `\nOutput:\n${String(item.output).slice(0, 1600)}` : '';
        return `<details class="block tool ${statusCls}"><summary>[${escapeHtml(item.toolKind || 'tool')}] ${escapeHtml(item.title || item.toolCallId)} — <strong>${escapeHtml(item.status || 'completed')}</strong></summary><pre>${escapeHtml((inputSnippet + outputSnippet).trim())}</pre></details>`;
      }
      return '';
    })
    .join('\n');

  const planHtml =
    planEntries.length > 0
      ? `<div class="block plan"><div class="role">ACP Agent Plan</div><ul>${planEntries
          .map((p) => `<li>[${escapeHtml(p.status || 'pending')}] ${escapeHtml(p.content || '')}</li>`)
          .join('')}</ul></div>`
      : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>ACP Session Transcript — ${escapeHtml(harnessLabel)}</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #0d1117; color: #e6edf3; margin: 0; padding: 20px; line-height: 1.5; }
  header { border-bottom: 1px solid #30363d; padding-bottom: 12px; margin-bottom: 18px; }
  h1 { font-size: 16px; margin: 0 0 6px; }
  .meta { font-size: 12px; color: #8b949e; display: flex; gap: 14px; flex-wrap: wrap; }
  .block { border: 1px solid #30363d; border-radius: 8px; padding: 10px 14px; margin-bottom: 10px; background: #161b22; }
  .thought { border-color: #388bfd55; }
  .tool.ok { border-color: #2ea04366; }
  .tool.err { border-color: #f8514988; }
  .role, summary { font-size: 12px; font-weight: 600; color: #79c0ff; cursor: pointer; }
  pre { white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; margin: 8px 0 0; color: #c9d1d9; }
</style>
</head>
<body>
  <header>
    <h1>${escapeHtml(harnessLabel)} — Agent Client Protocol (ACP v1) Session</h1>
    <div class="meta">
      <span>Agent: ${escapeHtml(agentInfo?.title || agentInfo?.name || harnessLabel)} ${escapeHtml(agentInfo?.version || '')}</span>
      <span>Model: ${escapeHtml(modelId || 'default')}</span>
      <span>Stop: ${escapeHtml(stopReason || 'end_turn')}</span>
      <span>Duration: ${((durationMs || 0) / 1000).toFixed(1)}s</span>
    </div>
  </header>
  ${planHtml}
  ${itemsHtml || '<p class="meta">No ACP session updates recorded.</p>'}
</body>
</html>\n`;
}

/**
 * Executes a full autonomous coding session over Agent Client Protocol (ACP v1, JSON-RPC 2.0 over stdio).
 * Supports `@zed-industries/claude-code-acp`, `@zed-industries/codex-acp`, and any compliant ACP v1 binary.
 */
export function isAcpAuthRequiredError(err) {
  return err?.code === -32000 || /auth(?:entication)? required|not authenticated|unauthenticated|please log ?in/i.test(String(err?.message || ''));
}

/**
 * Orders the auth methods an ACP agent advertises so a headless run can pick one: the harness spec's own
 * preference first, then anything that looks like an API-key method. Interactive logins are never chosen.
 */
export function pickAcpAuthMethods(authMethods, preferredIds = []) {
  const offered = (Array.isArray(authMethods) ? authMethods : []).map((m) => m?.id).filter(Boolean);
  const out = [];
  for (const id of preferredIds || []) if (offered.includes(id) && !out.includes(id)) out.push(id);
  for (const id of offered) {
    if (out.includes(id)) continue;
    if (/oauth|login|chatgpt|browser|personal|device/i.test(id)) continue;
    if (/api[-_]?key|apikey|^openai$|token/i.test(id)) out.push(id);
  }
  return out;
}

export async function runAcpCodingSession({
  command,
  args = [],
  workspaceDir,
  env,
  harnessSpec,
  desiredModelId = null,
  desiredModelKey = null,
  promptText,
  referenceImages = [],
  allowedReadPaths = [],
  sessionJsonlPath = null,
  trajectoryJsonPath = null,
  transcriptHtmlPath = null,
  timeoutMs = 900000,
  onProgress = () => {},
}) {
  mkdirSync(workspaceDir, { recursive: true });
  if (sessionJsonlPath) {
    mkdirSync(dirname(sessionJsonlPath), { recursive: true });
    writeFileSync(sessionJsonlPath, '', 'utf8');
  }

  const t0 = performance.now();
  let ttftMs = null;

  const child = spawn(command, args, {
    cwd: workspaceDir,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });

  let stderrTail = '';
  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000);
  });

  const pendingRequests = new Map();
  const activeTerminals = new Map();
  let nextRpcId = 1;
  let nextTerminalSeq = 1;
  let closed = false;

  // Telemetry accumulators
  let agentInfo = null;
  let negotiatedProtocolVersion = ACP_PROTOCOL_VERSION;
  let activeSessionId = null;
  let selectedModelId = null;
  let selectedModeId = null;
  let stopReason = null;

  let assistantText = '';
  let currentMessageBuffer = '';
  let currentThoughtBuffer = '';
  let turnCount = 0;
  let lastEventWasToolOrStart = true;
  let thinkingBlockCount = 0;
  let thinkingChars = 0;
  const thinkingExcerpts = [];
  const toolCallsById = new Map();
  const toolCallCounts = {};
  let toolErrorCount = 0;
  const filesWritten = new Set();
  const bashCommands = [];
  let planEntries = [];
  let permissionGrants = 0;
  let usageTotals = null;
  const timeline = [];

  function logSessionEvent(evt) {
    if (!sessionJsonlPath) return;
    try {
      appendFileSync(
        sessionJsonlPath,
        JSON.stringify({ timestamp: new Date().toISOString(), ...evt }) + '\n',
        'utf8'
      );
    } catch {
      // non-fatal
    }
  }

  function flushMessageAndThoughtBuffers() {
    if (currentThoughtBuffer.trim()) {
      thinkingBlockCount++;
      thinkingChars += currentThoughtBuffer.length;
      if (thinkingExcerpts.length < 6 && currentThoughtBuffer.trim().length > 20) {
        thinkingExcerpts.push(currentThoughtBuffer.trim().slice(0, 320));
      }
      timeline.push({ kind: 'thought', text: currentThoughtBuffer });
      currentThoughtBuffer = '';
    }
    if (currentMessageBuffer.trim()) {
      timeline.push({ kind: 'message', text: currentMessageBuffer });
      currentMessageBuffer = '';
    }
  }

  function sendJsonLine(payload) {
    if (closed || !child.stdin.writable) return;
    child.stdin.write(JSON.stringify(payload) + '\n');
  }

  function sendRequest(method, params = {}, reqTimeoutMs = timeoutMs) {
    return new Promise((resolveReq, rejectReq) => {
      if (closed) {
        rejectReq(new Error(`ACP connection closed before calling ${method}`));
        return;
      }
      const id = nextRpcId++;
      const timer = setTimeout(() => {
        pendingRequests.delete(id);
        rejectReq(new Error(`ACP request "${method}" timed out after ${reqTimeoutMs}ms`));
      }, reqTimeoutMs);

      pendingRequests.set(id, { resolve: resolveReq, reject: rejectReq, timer, method });
      logSessionEvent({ direction: 'client->agent', type: 'request', id, method });
      sendJsonLine({ jsonrpc: '2.0', id, method, params });
    });
  }

  function sendResponse(id, result) {
    sendJsonLine({ jsonrpc: '2.0', id, result });
  }

  function sendErrorResponse(id, code, message) {
    sendJsonLine({ jsonrpc: '2.0', id, error: { code, message: String(message || 'ACP client error') } });
  }

  async function handleIncomingAgentRequest(msg) {
    const { id, method, params = {} } = msg;
    logSessionEvent({ direction: 'agent->client', type: 'request', id, method });

    try {
      if (method === 'session/request_permission') {
        const safe = isPermissionSafeForWorkspace(workspaceDir, params);
        const chosen = safe
          ? pickAllowPermissionOption(params.options)
          : pickRejectPermissionOption(params.options);

        if (chosen) {
          if (safe) permissionGrants++;
          sendResponse(id, {
            outcome: {
              outcome: 'selected',
              optionId: chosen.optionId,
            },
          });
        } else {
          sendResponse(id, { outcome: { outcome: 'cancelled' } });
        }
        return;
      }

      if (method === 'fs/read_text_file') {
        const targetPath = resolveWorkspaceSafePath(workspaceDir, params.path, {
          allowReadOutside: true,
          allowedReadPaths,
        });
        if (!existsSync(targetPath)) {
          sendErrorResponse(id, -32001, `File not found: ${params.path}`);
          return;
        }
        const fullText = readFileSync(targetPath, 'utf8');
        let content = fullText;
        if (typeof params.line === 'number' || typeof params.limit === 'number') {
          const allLines = fullText.split(/\r?\n/);
          const startIdx = Math.max(0, (Number(params.line) || 1) - 1);
          const endIdx =
            typeof params.limit === 'number' && params.limit > 0
              ? startIdx + Number(params.limit)
              : allLines.length;
          content = allLines.slice(startIdx, endIdx).join('\n');
        }
        toolCallCounts.read = (toolCallCounts.read || 0) + 1;
        sendResponse(id, { content });
        return;
      }

      if (method === 'fs/write_text_file') {
        const targetPath = resolveWorkspaceSafePath(workspaceDir, params.path);
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, String(params.content ?? ''), 'utf8');
        filesWritten.add(relative(workspaceDir, targetPath) || params.path);
        toolCallCounts.write = (toolCallCounts.write || 0) + 1;
        sendResponse(id, {});
        return;
      }

      if (method === 'terminal/create') {
        const termCwd = params.cwd
          ? resolveWorkspaceSafePath(workspaceDir, params.cwd)
          : workspaceDir;
        const termEnv = { ...env };
        if (Array.isArray(params.env)) {
          for (const pair of params.env) {
            if (pair?.name && typeof pair.value === 'string') {
              termEnv[pair.name] = pair.value;
            }
          }
        }

        const cmdStr = String(params.command || '');
        const cmdArgs = Array.isArray(params.args) ? params.args.map(String) : null;
        const displayCmd = cmdArgs ? `${cmdStr} ${cmdArgs.join(' ')}`.trim() : cmdStr;
        bashCommands.push(redactCommand(displayCmd));
        toolCallCounts.bash = (toolCallCounts.bash || 0) + 1;

        const maxBytes = Math.max(16384, Number(params.outputByteLimit) || 262144);
        const terminalId = `term-${nextTerminalSeq++}`;

        const proc = cmdArgs
          ? spawn(cmdStr, cmdArgs, { cwd: termCwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: termEnv })
          : spawn(existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh', ['-lc', cmdStr], {
              cwd: termCwd,
              detached: true,
              stdio: ['ignore', 'pipe', 'pipe'],
              env: termEnv,
            });

        const termRecord = {
          terminalId,
          proc,
          output: '',
          truncated: false,
          exitStatus: null,
          exitPromise: null,
        };

        const appendOut = (chunk) => {
          const str = chunk.toString('utf8');
          if (termRecord.output.length + str.length > maxBytes) {
            const keep = str.slice(-maxBytes);
            termRecord.output = (termRecord.output + keep).slice(-maxBytes);
            termRecord.truncated = true;
          } else {
            termRecord.output += str;
          }
        };

        proc.stdout.on('data', appendOut);
        proc.stderr.on('data', appendOut);
        termRecord.exitPromise = new Promise((resExit) => {
          proc.on('close', (code, sig) => {
            termRecord.exitStatus = {
              exitCode: typeof code === 'number' ? code : null,
              signal: sig || null,
            };
            resExit(termRecord.exitStatus);
          });
          proc.on('error', (err) => {
            appendOut(Buffer.from(`\nSpawn error: ${err.message}\n`));
            termRecord.exitStatus = { exitCode: 1, signal: null };
            resExit(termRecord.exitStatus);
          });
        });

        activeTerminals.set(terminalId, termRecord);
        sendResponse(id, { terminalId });
        return;
      }

      if (method === 'terminal/output') {
        const rec = activeTerminals.get(params.terminalId);
        if (!rec) {
          sendErrorResponse(id, -32002, `Unknown terminalId: ${params.terminalId}`);
          return;
        }
        sendResponse(id, {
          output: rec.output,
          truncated: rec.truncated,
          ...(rec.exitStatus ? { exitStatus: rec.exitStatus } : {}),
        });
        return;
      }

      if (method === 'terminal/wait_for_exit') {
        const rec = activeTerminals.get(params.terminalId);
        if (!rec) {
          sendErrorResponse(id, -32002, `Unknown terminalId: ${params.terminalId}`);
          return;
        }
        const status = await rec.exitPromise;
        sendResponse(id, status);
        return;
      }

      if (method === 'terminal/kill') {
        const rec = activeTerminals.get(params.terminalId);
        if (rec?.proc?.pid && !rec.exitStatus) {
          await killProcessGroupSafe(rec.proc.pid);
        }
        sendResponse(id, {});
        return;
      }

      if (method === 'terminal/release') {
        const rec = activeTerminals.get(params.terminalId);
        if (rec) {
          if (rec.proc?.pid && !rec.exitStatus) {
            await killProcessGroupSafe(rec.proc.pid);
          }
          activeTerminals.delete(params.terminalId);
        }
        sendResponse(id, {});
        return;
      }

      if (method === 'elicitation/create') {
        sendResponse(id, { action: 'cancel' });
        return;
      }

      sendErrorResponse(id, -32601, `Unsupported ACP client method: ${method}`);
    } catch (err) {
      sendErrorResponse(id, -32000, err.message || String(err));
    }
  }

  function handleSessionUpdateNotification(params = {}) {
    const upd = params.update || {};
    const kind = upd.sessionUpdate;
    logSessionEvent({ direction: 'agent->client', type: 'session/update', sessionUpdate: kind, update: upd });

    if (ttftMs === null && (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk' || kind === 'tool_call')) {
      ttftMs = Math.round(performance.now() - t0);
    }

    if (kind === 'agent_message_chunk') {
      if (lastEventWasToolOrStart) {
        turnCount++;
        lastEventWasToolOrStart = false;
      }
      const chunkText = upd.content?.type === 'text' ? upd.content.text || '' : '';
      assistantText += chunkText;
      currentMessageBuffer += chunkText;
      return;
    }

    if (kind === 'agent_thought_chunk') {
      if (lastEventWasToolOrStart) {
        turnCount++;
        lastEventWasToolOrStart = false;
      }
      const thoughtText = upd.content?.type === 'text' ? upd.content.text || '' : '';
      currentThoughtBuffer += thoughtText;
      return;
    }

    if (kind === 'tool_call') {
      flushMessageAndThoughtBuffers();
      lastEventWasToolOrStart = true;

      const id = upd.toolCallId || `tc-${toolCallsById.size + 1}`;
      const toolKind = upd.kind || 'other';
      toolCallCounts[toolKind] = (toolCallCounts[toolKind] || 0) + 1;

      if (Array.isArray(upd.locations)) {
        for (const loc of upd.locations) {
          if (loc?.path && (toolKind === 'edit' || toolKind === 'write')) {
            try {
              const rel = relative(workspaceDir, resolve(workspaceDir, loc.path));
              if (!rel.startsWith('..')) filesWritten.add(rel || loc.path);
            } catch {
              // ignore
            }
          }
        }
      }
      if (upd.rawInput && typeof upd.rawInput === 'object') {
        const cmd = upd.rawInput.command || upd.rawInput.cmd;
        if (typeof cmd === 'string' && cmd.trim()) {
          bashCommands.push(redactCommand(cmd));
        }
        const fpath = upd.rawInput.file_path || upd.rawInput.path;
        if (typeof fpath === 'string' && (toolKind === 'edit' || toolKind === 'write')) {
          try {
            const rel = relative(workspaceDir, resolve(workspaceDir, fpath));
            if (!rel.startsWith('..')) filesWritten.add(rel || fpath);
          } catch {
            // ignore
          }
        }
      }

      const rec = {
        kind: 'tool',
        toolCallId: id,
        toolKind,
        title: upd.title || toolKind,
        status: upd.status || 'in_progress',
        rawInput: upd.rawInput || null,
        output: '',
      };
      toolCallsById.set(id, rec);
      timeline.push(rec);
      return;
    }

    if (kind === 'tool_call_update') {
      const id = upd.toolCallId;
      const rec = id ? toolCallsById.get(id) : null;
      if (rec) {
        if (upd.status) rec.status = upd.status;
        if (upd.title) rec.title = upd.title;
        if (upd.rawInput && !rec.rawInput) rec.rawInput = upd.rawInput;
        if (Array.isArray(upd.content)) {
          const textParts = upd.content
            .map((c) => {
              if (c?.type === 'content' && c.content?.type === 'text') return c.content.text;
              if (c?.type === 'diff' && c.path) return `[diff ${c.path}]`;
              return '';
            })
            .filter(Boolean);
          if (textParts.length > 0) {
            rec.output = (rec.output + '\n' + textParts.join('\n')).trim().slice(0, 4000);
          }
        }
      }
      if (upd.status === 'failed') {
        toolErrorCount++;
      }
      return;
    }

    if (kind === 'plan' && Array.isArray(upd.entries)) {
      planEntries = upd.entries;
      return;
    }

    if (kind === 'current_mode_update' && upd.currentModeId) {
      selectedModeId = upd.currentModeId;
      return;
    }

    if (kind === 'usage_update' && upd.usage) {
      usageTotals = upd.usage;
    }
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }

    // Response to one of our requests
    if (msg.id !== undefined && msg.method === undefined) {
      const pending = pendingRequests.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingRequests.delete(msg.id);
      if (msg.error) {
        const err = new Error(msg.error.message || `ACP error ${msg.error.code}`);
        err.code = msg.error.code;
        err.data = msg.error.data;
        pending.reject(err);
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // Notification from agent
    if (msg.id === undefined && msg.method) {
      if (msg.method === 'session/update') {
        handleSessionUpdateNotification(msg.params);
      }
      return;
    }

    // Request from agent -> client
    if (msg.id !== undefined && msg.method) {
      handleIncomingAgentRequest(msg);
    }
  });

  child.on('close', (code) => {
    closed = true;
    for (const [, pending] of pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(
        new Error(
          `ACP agent exited unexpectedly (code ${code}) during "${pending.method}". ${stderrTail.slice(-400)}`
        )
      );
    }
    pendingRequests.clear();
  });

  const overallTimer = setTimeout(async () => {
    if (activeSessionId && !closed) {
      try {
        sendJsonLine({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: activeSessionId } });
      } catch {
        // ignore
      }
    }
    await sleep(400);
    closed = true;
    for (const [, pending] of pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`ACP session timed out after ${timeoutMs}ms`));
    }
    pendingRequests.clear();
    await killProcessGroupSafe(child.pid);
  }, timeoutMs);

  let sessionError = null;
  let modelSelection = null;
  let authMethodUsed = null;
  try {
    // 1. ACP initialize handshake
    const initRes = await sendRequest(
      'initialize',
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientInfo: {
          name: 'performance-benchmark',
          title: 'Web Outcomes Benchmark ACP Driver',
          version: '2.2.0',
        },
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
          terminal: true,
        },
      },
      30000
    );

    negotiatedProtocolVersion = initRes?.protocolVersion ?? ACP_PROTOCOL_VERSION;
    agentInfo = initRes?.agentInfo || null;

    // 2. Create isolated ACP session in workspaceDir with zero MCP servers.
    // Agents such as codex-acp answer "Authentication required" until the client picks one of the advertised
    // auth methods, even when the API key is already in the environment. Pick an API-key method (never an
    // interactive login) and retry once per candidate.
    const newSessionParams = {
      cwd: workspaceDir,
      mcpServers: [],
      ...(harnessSpec?.sessionMeta && Object.keys(harnessSpec.sessionMeta).length > 0
        ? { _meta: harnessSpec.sessionMeta }
        : {}),
    };
    let sessionRes = null;
    try {
      sessionRes = await sendRequest('session/new', newSessionParams, 45000);
    } catch (err) {
      const candidates = pickAcpAuthMethods(initRes?.authMethods, harnessSpec?.authMethodIds);
      if (!isAcpAuthRequiredError(err) || candidates.length === 0) {
        if (isAcpAuthRequiredError(err)) {
          const offered = (initRes?.authMethods || []).map((m) => m.id).join(', ') || 'none';
          throw new Error(`${err.message} (agent offered auth methods: ${offered}; none usable without a login)`);
        }
        throw err;
      }
      let lastErr = err;
      for (const methodId of candidates) {
        try {
          await sendRequest('authenticate', { methodId }, 30000);
          sessionRes = await sendRequest('session/new', newSessionParams, 45000);
          authMethodUsed = methodId;
          break;
        } catch (authErr) {
          lastErr = authErr;
        }
      }
      if (!sessionRes) {
        throw new Error(`${lastErr.message} (tried auth methods: ${candidates.join(', ')})`);
      }
    }

    activeSessionId = sessionRes?.sessionId;
    if (!activeSessionId) {
      throw new Error('ACP session/new did not return a sessionId.');
    }

    // 3. Configure autonomous permission mode if advertised by the ACP adapter
    const availableModes = sessionRes?.modes?.availableModes || [];
    selectedModeId = sessionRes?.modes?.currentModeId || null;
    const preferredModes = harnessSpec?.preferredModeIds || ['bypassPermissions', 'acceptEdits', 'full-auto'];
    for (const candidateMode of preferredModes) {
      if (availableModes.some((m) => m.id === candidateMode) && candidateMode !== selectedModeId) {
        try {
          await sendRequest('session/set_mode', { sessionId: activeSessionId, modeId: candidateMode }, 15000);
          selectedModeId = candidateMode;
          break;
        } catch {
          // continue; session/request_permission handler still auto-approves workspace tools
        }
      }
    }

    // 4. Select requested model via ACP configOptions or models list when supported.
    // Adapters such as claude-code-acp advertise CLI aliases (`default`, `sonnet`, `opus`) rather than full
    // model ids, so a requested id that is not listed is still sent via session/set_model (which those
    // adapters pass straight through). If the adapter then still reports a different model, the cell fails
    // instead of silently benchmarking the adapter's default model under the requested model's name.
    const requestedModelId = desiredModelId || desiredModelKey || null;
    let modelSelectionMethod = null;
    let reportedModelId = null;
    const configOptions = Array.isArray(sessionRes?.configOptions) ? sessionRes.configOptions : [];
    const modelConfigOpt = configOptions.find((o) => o.category === 'model' || o.id === 'model');
    const listedModels = Array.isArray(sessionRes?.models?.availableModels) ? sessionRes.models.availableModels : null;

    if (requestedModelId && (modelConfigOpt || listedModels)) {
      reportedModelId =
        (modelConfigOpt ? modelConfigOpt.currentValue ?? modelConfigOpt.value : null) ??
        sessionRes?.models?.currentModelId ??
        null;
      selectedModelId = reportedModelId;

      // a) ACP config option (session/set_config_option) when the adapter lists the model there.
      if (modelConfigOpt) {
        const flatOpts = (modelConfigOpt.options || []).flatMap((item) =>
          Array.isArray(item.options) ? item.options : [item]
        );
        const matchedVal = matchDesiredModel(
          flatOpts.map((o) => ({ modelId: o.value, name: o.name })),
          desiredModelId,
          desiredModelKey
        );
        if (matchedVal && matchedVal === reportedModelId) {
          modelSelectionMethod = 'already-current';
        } else if (matchedVal) {
          try {
            await sendRequest(
              'session/set_config_option',
              { sessionId: activeSessionId, configId: modelConfigOpt.id, value: matchedVal },
              15000
            );
            selectedModelId = matchedVal;
            modelSelectionMethod = 'config-option';
          } catch {
            // fall through to session/set_model below
          }
        }
      }

      // b) session/set_model with a listed match, then the exact requested id (passed through by adapters
      //    such as claude-code-acp that only list aliases).
      if (!modelSelectionMethod) {
        const matchedModelId = listedModels ? matchDesiredModel(listedModels, desiredModelId, desiredModelKey) : null;
        const candidates = [];
        if (matchedModelId) candidates.push({ id: matchedModelId, method: 'listed-model' });
        if (desiredModelId && desiredModelId !== matchedModelId) {
          candidates.push({ id: desiredModelId, method: 'passthrough-model-id' });
        }
        for (const cand of candidates) {
          if (cand.id === reportedModelId) {
            modelSelectionMethod = 'already-current';
            break;
          }
          try {
            await sendRequest('session/set_model', { sessionId: activeSessionId, modelId: cand.id }, 15000);
            selectedModelId = cand.id;
            modelSelectionMethod = cand.method;
            break;
          } catch {
            // try the next candidate; unsupported adapters fall through to the verification below
          }
        }
      }

      // c) Adapters such as codex-acp list only a few presets and have no session/set_model, but accept any
      //    model id through the model config option. Only trusted when the adapter echoes it back as current.
      if (!modelSelectionMethod && modelConfigOpt && desiredModelId) {
        try {
          const res = await sendRequest(
            'session/set_config_option',
            { sessionId: activeSessionId, configId: modelConfigOpt.id, value: desiredModelId },
            15000
          );
          const echoed = (res?.configOptions || []).find((o) => o.id === modelConfigOpt.id);
          if ((echoed?.currentValue ?? echoed?.value) === desiredModelId) {
            selectedModelId = desiredModelId;
            modelSelectionMethod = 'config-option-passthrough';
          }
        } catch {
          // the adapter refused the id; the strict check below reports it
        }
      }

      // d) CLIs configured entirely through environment variables (Kimi Code with KIMI_MODEL_*) expose one
      //    placeholder entry meaning "the model named in the environment". Accept it only when we set that
      //    variable to the requested id ourselves.
      if (
        !modelSelectionMethod &&
        desiredModelId &&
        harnessSpec?.envModelPlaceholder &&
        harnessSpec?.modelEnvVar &&
        (selectedModelId || reportedModelId) === harnessSpec.envModelPlaceholder &&
        env?.[harnessSpec.modelEnvVar] === desiredModelId
      ) {
        selectedModelId = desiredModelId;
        modelSelectionMethod = 'env-model';
      }
    } else {
      selectedModelId = desiredModelId || null;
      modelSelectionMethod = requestedModelId ? 'unverifiable' : null;
    }

    const adapterExposesModels = Boolean(modelConfigOpt || listedModels);
    const modelVerified = adapterExposesModels
      ? Boolean(modelSelectionMethod && modelSelectionMethod !== 'unverifiable')
      : null;
    modelSelection = {
      requested: requestedModelId,
      reportedAtSessionStart: reportedModelId,
      selected: selectedModelId,
      method: modelSelectionMethod,
      verified: modelVerified,
    };
    if (requestedModelId && modelVerified === false && harnessSpec?.strictModelSelection !== false) {
      throw new Error(
        `ACP adapter did not accept requested model "${requestedModelId}" (adapter reports "${selectedModelId || 'unknown'}"). ` +
          'Refusing to run so results are not attributed to the wrong model.'
      );
    }

    onProgress({
      stage: 'generating',
      detail: `ACP session active (${agentInfo?.title || harnessSpec?.label || 'ACP'}, model=${selectedModelId || 'default'}, mode=${selectedModeId || 'auto'})`,
    });

    // 5. Build multimodal ACP prompt blocks
    const promptSupportsImages = initRes?.agentCapabilities?.promptCapabilities?.image !== false;
    const promptBlocks = [];
    if (promptSupportsImages && Array.isArray(referenceImages)) {
      for (const img of referenceImages) {
        if (img?.absPath && existsSync(img.absPath)) {
          promptBlocks.push({
            type: 'image',
            data: readFileSync(img.absPath).toString('base64'),
            mimeType: img.mimeType || 'image/jpeg',
          });
        }
      }
    }
    promptBlocks.push({ type: 'text', text: promptText });

    const promptRes = await sendRequest(
      'session/prompt',
      {
        sessionId: activeSessionId,
        prompt: promptBlocks,
      },
      timeoutMs
    );

    stopReason = promptRes?.stopReason || 'end_turn';
    if (promptRes?.usage) {
      usageTotals = promptRes.usage;
    }
  } catch (err) {
    sessionError = err;
    stopReason = 'error';
  } finally {
    clearTimeout(overallTimer);
    flushMessageAndThoughtBuffers();
    rl.close();
    closed = true;

    for (const [, term] of activeTerminals) {
      if (term?.proc?.pid && !term.exitStatus) {
        await killProcessGroupSafe(term.proc.pid);
      }
    }
    activeTerminals.clear();
    await killProcessGroupSafe(child.pid);
  }

  const durationMs = Math.round(performance.now() - t0);
  const combinedHistoryText = `${thinkingExcerpts.join('\n')}\n${bashCommands.join('\n')}`;
  const scaffoldingTools = SCAFFOLD_PATTERNS.filter((p) => p.re.test(combinedHistoryText)).map((p) => p.id);

  const installedNpmPackages = [];
  const npmInstallRe = /\bnpm\s+(?:install|i|add)\s+([^\n;&|]+)/gi;
  for (const cmd of bashCommands) {
    let m;
    while ((m = npmInstallRe.exec(cmd)) !== null) {
      const tokens = m[1]
        .split(/\s+/)
        .map((t) => t.trim())
        .filter((t) => t && !t.startsWith('-') && !t.startsWith('.'));
      for (const tok of tokens) {
        const cleanPkg = tok.replace(/@[\d^~>=<.*]+$/, '');
        if (cleanPkg && !installedNpmPackages.includes(cleanPkg)) {
          installedNpmPackages.push(cleanPkg);
        }
      }
    }
  }

  const totalToolCalls = Object.values(toolCallCounts).reduce((a, b) => a + b, 0);
  const trajectory = {
    harness: harnessSpec?.id || 'acp',
    protocol: 'acp-v1',
    sessionId: activeSessionId,
    provider: harnessSpec?.provider || null,
    modelId: selectedModelId,
    turnCount: Math.max(turnCount, totalToolCalls > 0 ? 1 : 0),
    totalToolCalls,
    toolCallCounts,
    toolErrorCount,
    thinkingBlockCount,
    thinkingChars,
    thinkingExcerpts,
    filesTouchedCount: filesWritten.size,
    filesWritten: Array.from(filesWritten).slice(0, 60),
    bashCommandCount: bashCommands.length,
    bashCommands: bashCommands.slice(0, 40),
    scaffoldingTools,
    installedNpmPackages: installedNpmPackages.slice(0, 30),
    engineeringHabits: {
      usedScaffoldingCli: scaffoldingTools.length > 0,
      ranTestsOrCurlVerification: /\b(?:curl|wget|fetch|vitest|jest|node\s+--test|pytest)\b/i.test(combinedHistoryText),
      spontaneousPerformanceSignals: SPONTANEOUS_PERF_PATTERNS.filter((p) => p.re.test(combinedHistoryText)).map(
        (p) => p.id
      ),
    },
    acpMeta: {
      protocolVersion: negotiatedProtocolVersion,
      agentInfo,
      selectedModelId,
      selectedModeId,
      modelSelection,
      authMethodUsed,
      permissionGrants,
      planEntryCount: planEntries.length,
      planEntries: planEntries.slice(0, 20),
    },
    usage: usageTotals
      ? {
          inputTokens: usageTotals.inputTokens ?? usageTotals.input_tokens ?? 0,
          outputTokens: usageTotals.outputTokens ?? usageTotals.output_tokens ?? 0,
          totalTokens:
            usageTotals.totalTokens ??
            (usageTotals.inputTokens || 0) + (usageTotals.outputTokens || 0),
          costUsd: usageTotals.costUsd ?? usageTotals.cost ?? null,
        }
      : null,
  };

  if (trajectoryJsonPath) {
    mkdirSync(dirname(trajectoryJsonPath), { recursive: true });
    writeFileSync(trajectoryJsonPath, JSON.stringify(trajectory, null, 2) + '\n', 'utf8');
  }

  let hasTranscriptHtml = false;
  if (transcriptHtmlPath) {
    try {
      const html = renderAcpTranscriptHtml({
        harnessLabel: harnessSpec?.label || 'ACP Agent',
        agentInfo,
        modelId: selectedModelId,
        stopReason,
        durationMs,
        timeline,
        planEntries,
      });
      mkdirSync(dirname(transcriptHtmlPath), { recursive: true });
      writeFileSync(transcriptHtmlPath, html, 'utf8');
      hasTranscriptHtml = true;
    } catch {
      hasTranscriptHtml = false;
    }
  }

  return {
    ok: !sessionError,
    error: sessionError ? sessionError.message || String(sessionError) : null,
    stderrTail,
    durationMs,
    ttftMs,
    stopReason,
    assistantText,
    agentInfo,
    selectedModelId,
    selectedModeId,
    modelSelection,
    trajectory,
    hasTranscriptHtml,
  };
}

/**
 * Parses `acp-session.jsonl` into the same `{ initialUserPrompt, turnCount, turns }` timeline shape
 * as `parsePiSessionTimeline`, so Benchmark Studio renders turn-by-turn ACP sessions seamlessly.
 */
export function parseAcpSessionTimeline(sessionPath, { maxToolOutputChars = 2400, maxThinkingChars = 4000 } = {}) {
  if (!existsSync(sessionPath)) return null;
  const lines = readFileSync(sessionPath, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let initialUserPrompt = '';
  const turns = [];
  let activeTurn = null;
  let thoughtBuf = '';
  let textBuf = '';
  const toolMap = new Map();

  function ensureTurn(ts = null) {
    if (!activeTurn) {
      activeTurn = {
        turn: turns.length + 1,
        timestamp: ts,
        thinking: [],
        text: [],
        toolCalls: [],
        usage: null,
      };
      turns.push(activeTurn);
    }
    return activeTurn;
  }

  function flushBuffers() {
    if (thoughtBuf.trim() && activeTurn) {
      activeTurn.thinking.push(thoughtBuf.trim().slice(0, maxThinkingChars));
      thoughtBuf = '';
    }
    if (textBuf.trim() && activeTurn) {
      activeTurn.text.push(textBuf.trim().slice(0, 4000));
      textBuf = '';
    }
  }

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.method === 'session/prompt' && Array.isArray(entry.params?.prompt)) {
      const promptTxt = entry.params.prompt
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      if (!initialUserPrompt && promptTxt.trim()) {
        initialUserPrompt = promptTxt.trim();
      }
      continue;
    }

    if (entry.type !== 'session/update' || !entry.update) continue;
    const upd = entry.update;
    const kind = upd.sessionUpdate;

    if (kind === 'agent_thought_chunk') {
      ensureTurn(entry.timestamp || null);
      if (upd.content?.type === 'text') thoughtBuf += upd.content.text || '';
    } else if (kind === 'agent_message_chunk') {
      ensureTurn(entry.timestamp || null);
      if (upd.content?.type === 'text') textBuf += upd.content.text || '';
    } else if (kind === 'tool_call') {
      const turn = ensureTurn(entry.timestamp || null);
      flushBuffers();
      const rawIn = upd.rawInput && typeof upd.rawInput === 'object' ? upd.rawInput : {};
      const summary =
        rawIn.command ||
        rawIn.cmd ||
        rawIn.file_path ||
        rawIn.path ||
        upd.title ||
        JSON.stringify(rawIn).slice(0, 140);
      const callRec = {
        id: upd.toolCallId || `${turn.turn}-${turn.toolCalls.length}`,
        name: upd.kind || 'tool',
        summary: redactCommand(String(summary || '')),
        contentPreview: upd.title && upd.title !== summary ? String(upd.title).slice(0, 140) : null,
        resultPreview: '',
        isError: upd.status === 'failed',
      };
      turn.toolCalls.push(callRec);
      if (upd.toolCallId) toolMap.set(upd.toolCallId, callRec);
      // Next message/thought starts a fresh logical turn after tool execution
      activeTurn = null;
    } else if (kind === 'tool_call_update') {
      const target = upd.toolCallId ? toolMap.get(upd.toolCallId) : null;
      if (target) {
        if (upd.status === 'failed') target.isError = true;
        if (Array.isArray(upd.content)) {
          const outParts = upd.content
            .map((c) => {
              if (c?.type === 'content' && c.content?.type === 'text') return c.content.text;
              if (c?.type === 'diff' && c.path) return `[diff ${c.path}]`;
              return '';
            })
            .filter(Boolean);
          if (outParts.length > 0) {
            target.resultPreview = redactCommand((target.resultPreview + '\n' + outParts.join('\n')).trim()).slice(
              0,
              maxToolOutputChars
            );
          }
        }
      }
    }
  }

  flushBuffers();
  return {
    initialUserPrompt,
    turnCount: turns.length,
    turns,
  };
}
