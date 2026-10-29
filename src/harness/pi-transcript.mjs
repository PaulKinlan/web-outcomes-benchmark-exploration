import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolvePiBin } from './pi-loader.mjs';

const execFileAsync = promisify(execFile);

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

/**
 * Parses a `pi` v3 JSONL session file (`pi-session.jsonl`) into structured
 * Agent Trajectory & Engineering Habits telemetry (`trajectory.json`).
 */
export function parsePiSessionTranscript(sessionPath) {
  if (!existsSync(sessionPath)) return null;

  const lines = readFileSync(sessionPath, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let sessionId = null;
  let startedAt = null;
  let endedAt = null;
  let provider = null;
  let modelId = null;
  let thinkingLevel = null;

  let turnCount = 0;
  let toolResultCount = 0;
  let toolErrorCount = 0;
  let thinkingBlockCount = 0;
  let thinkingChars = 0;
  const thinkingExcerpts = [];
  const toolCallCounts = {};
  const filesWritten = new Set();
  const bashCommands = [];
  const finalAssistantTexts = [];

  const usageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };

  let allThinkingAndCommandsText = '';

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.timestamp) {
      if (!startedAt) startedAt = entry.timestamp;
      endedAt = entry.timestamp;
    }

    if (entry.type === 'session') {
      sessionId = entry.id || null;
    } else if (entry.type === 'model_change') {
      provider = entry.provider || provider;
      modelId = entry.modelId || modelId;
    } else if (entry.type === 'thinking_level_change') {
      thinkingLevel = entry.thinkingLevel || thinkingLevel;
    } else if (entry.type === 'message' && entry.message) {
      const msg = entry.message;
      if (msg.role === 'assistant') {
        turnCount++;
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        for (const b of blocks) {
          if (b.type === 'thinking' && b.thinking) {
            thinkingBlockCount++;
            thinkingChars += b.thinking.length;
            allThinkingAndCommandsText += '\n' + b.thinking;
            if (thinkingExcerpts.length < 6 && b.thinking.trim().length > 20) {
              thinkingExcerpts.push(b.thinking.trim().slice(0, 320));
            }
          } else if (b.type === 'toolCall') {
            const name = b.name || 'unknown';
            toolCallCounts[name] = (toolCallCounts[name] || 0) + 1;
            const args = b.arguments || {};
            if ((name === 'write' || name === 'edit') && args.path) {
              filesWritten.add(String(args.path));
            }
            if (name === 'bash' && args.command) {
              const cleanCmd = redactCommand(args.command);
              bashCommands.push(cleanCmd);
              allThinkingAndCommandsText += '\n' + cleanCmd;
            }
          } else if (b.type === 'text' && b.text?.trim()) {
            finalAssistantTexts.push(b.text.trim());
          }
        }

        if (msg.usage) {
          usageTotals.inputTokens += msg.usage.input || 0;
          usageTotals.outputTokens += msg.usage.output || 0;
          usageTotals.cacheReadTokens += msg.usage.cacheRead || 0;
          usageTotals.cacheWriteTokens += msg.usage.cacheWrite || 0;
          usageTotals.reasoningTokens += msg.usage.reasoning || 0;
          usageTotals.totalTokens += msg.usage.totalTokens || 0;
          usageTotals.costUsd += msg.usage.cost?.total || 0;
        }
      } else if (msg.role === 'toolResult') {
        toolResultCount++;
        if (msg.isError) toolErrorCount++;
      }
    }
  }

  usageTotals.costUsd = Math.round(usageTotals.costUsd * 100000) / 100000;
  const totalToolCalls = Object.values(toolCallCounts).reduce((a, b) => a + b, 0);

  const bashJoined = bashCommands.join('\n');
  const scaffoldingTools = SCAFFOLD_PATTERNS.filter((p) => p.re.test(bashJoined)).map((p) => p.id);

  const ranBuild = /\b(?:npm\s+run\s+build|npx\s+vite\s+build|next\s+build|astro\s+build|tsc\b|go\s+build|cargo\s+build)\b/i.test(
    bashJoined
  );
  const selfVerifiedServer = /\b(?:curl\s+|wget\s+|fetch\s*\(\s*['"`]?http:\/\/(?:127\.0\.0\.1|localhost)|http:\/\/(?:127\.0\.0\.1|localhost)[:'"`]|\.listen\s*\(\s*0\b)\b/i.test(
    bashJoined
  );
  const installedNpmPackages = [];
  const npmInstallRe = /\bnpm\s+(?:install|i|add)\s+([^\n;&|]+)/gi;
  let m;
  while ((m = npmInstallRe.exec(bashJoined)) !== null) {
    const tokens = m[1]
      .split(/\s+/)
      .filter((t) => t && !t.startsWith('-') && !t.startsWith('.'));
    for (const t of tokens) {
      const cleanPkg = t.replace(/@[\d^~.*x-]+$/, '');
      if (cleanPkg && !installedNpmPackages.includes(cleanPkg)) {
        installedNpmPackages.push(cleanPkg);
      }
    }
  }

  const perfSignals = SPONTANEOUS_PERF_PATTERNS.filter((p) => p.re.test(allThinkingAndCommandsText)).map(
    (p) => p.label
  );

  return {
    sessionId,
    provider,
    modelId,
    thinkingLevel,
    startedAt,
    endedAt,
    turnCount,
    totalToolCalls,
    toolCallCounts,
    toolResultCount,
    toolErrorCount,
    thinkingBlockCount,
    thinkingChars,
    thinkingExcerpts,
    filesTouchedCount: filesWritten.size,
    filesTouched: Array.from(filesWritten).slice(0, 60),
    bashCommandCount: bashCommands.length,
    bashCommands: bashCommands.slice(0, 40),
    scaffoldingTools,
    installedNpmPackages: installedNpmPackages.slice(0, 40),
    engineeringHabits: {
      ranBuild,
      selfVerifiedServer,
      spontaneousPerfAttention: perfSignals.length > 0,
      perfSignals,
    },
    usage: usageTotals,
    finalSummary: finalAssistantTexts.length > 0 ? finalAssistantTexts[finalAssistantTexts.length - 1].slice(0, 1200) : '',
  };
}

/**
 * Exports a `pi` session JSONL file into a self-contained HTML transcript viewer (`pi-transcript.html`).
 */
export async function exportPiTranscriptHtml(sessionPath, outHtmlPath) {
  if (!existsSync(sessionPath)) return false;
  const piBin = resolvePiBin();
  if (!piBin) return false;

  try {
    await execFileAsync(piBin, ['--export', sessionPath, outHtmlPath], {
      timeout: 20000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return existsSync(outHtmlPath);
  } catch {
    return false;
  }
}

export function saveTrajectorySummary(sessionPath, trajectoryOutPath) {
  const summary = parsePiSessionTranscript(sessionPath);
  if (summary) {
    writeFileSync(trajectoryOutPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');
  }
  return summary;
}

/**
 * Parses `pi-session.jsonl` into an interactive turn-by-turn timeline for the Studio Transcript Viewer.
 */
export function parsePiSessionTimeline(sessionPath, { maxToolOutputChars = 2400, maxThinkingChars = 4000 } = {}) {
  if (!existsSync(sessionPath)) return null;

  const lines = readFileSync(sessionPath, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let initialUserPrompt = '';
  const turns = [];
  const toolCallLookup = new Map();

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type !== 'message' || !entry.message) continue;
    const msg = entry.message;

    if (msg.role === 'user') {
      const text = Array.isArray(msg.content)
        ? msg.content
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('\n')
        : typeof msg.content === 'string'
          ? msg.content
          : '';
      if (!initialUserPrompt && text.trim()) {
        initialUserPrompt = text.trim();
      }
      continue;
    }

    if (msg.role === 'assistant') {
      const turnIdx = turns.length + 1;
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      const thinking = [];
      const text = [];
      const toolCalls = [];

      for (const b of blocks) {
        if (b.type === 'thinking' && b.thinking?.trim()) {
          thinking.push(b.thinking.trim().slice(0, maxThinkingChars));
        } else if (b.type === 'text' && b.text?.trim()) {
          text.push(b.text.trim().slice(0, 4000));
        } else if (b.type === 'toolCall') {
          const args = b.arguments || {};
          let summary = '';
          if (b.name === 'bash' && args.command) summary = redactCommand(args.command);
          else if ((b.name === 'write' || b.name === 'edit' || b.name === 'read') && args.path) {
            summary = String(args.path);
          } else {
            summary = JSON.stringify(args).slice(0, 140);
          }
          const callRecord = {
            id: b.id || `${turnIdx}-${toolCalls.length}`,
            name: b.name || 'tool',
            summary,
            contentPreview:
              b.name === 'write' && typeof args.content === 'string'
                ? `${args.content.split(/\r?\n/).length} lines (${args.content.length} chars)`
                : b.name === 'edit' && typeof args.newText === 'string'
                  ? `Replaced ${String(args.oldText || '').split(/\r?\n/).length} lines -> ${args.newText.split(/\r?\n/).length} lines`
                  : null,
            resultPreview: '',
            isError: false,
          };
          toolCalls.push(callRecord);
          if (b.id) toolCallLookup.set(b.id, callRecord);
        }
      }

      turns.push({
        turn: turnIdx,
        timestamp: entry.timestamp || null,
        thinking,
        text,
        toolCalls,
        usage: msg.usage
          ? {
              input: msg.usage.input || 0,
              output: msg.usage.output || 0,
              reasoning: msg.usage.reasoning || 0,
              costUsd: msg.usage.cost?.total ?? null,
            }
          : null,
      });
      continue;
    }

    if (msg.role === 'toolResult') {
      const target = msg.toolCallId ? toolCallLookup.get(msg.toolCallId) : null;
      if (target) {
        const outText = Array.isArray(msg.content)
          ? msg.content
              .filter((c) => c.type === 'text')
              .map((c) => c.text)
              .join('\n')
          : typeof msg.content === 'string'
            ? msg.content
            : '';
        target.resultPreview = redactCommand(outText).slice(0, maxToolOutputChars);
        if (outText.length > 260) {
          target.resultPreview = String(outText)
            .replace(/(?:KEY|TOKEN|SECRET|PASSWORD)=[^\s]+/gi, '[REDACTED_ENV]')
            .trim()
            .slice(0, maxToolOutputChars);
        }
        target.isError = Boolean(msg.isError);
      }
    }
  }

  return {
    initialUserPrompt,
    turnCount: turns.length,
    turns,
  };
}
