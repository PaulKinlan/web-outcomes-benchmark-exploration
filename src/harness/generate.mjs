import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, rmSync, cpSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { resolvePiBin } from './pi-loader.mjs';
import { buildPiCliEnv } from './pi-auth-bridge.mjs';
import { exportPiTranscriptHtml, saveTrajectorySummary } from './pi-transcript.mjs';
import { PROJECT_ROOT, sleep } from '../util/env.mjs';

let cachedPiVersion = null;
export function detectPiVersion() {
  if (cachedPiVersion !== null) return cachedPiVersion;
  try {
    const piBin = resolvePiBin();
    if (!piBin) return 'unavailable';
    cachedPiVersion = execFileSync(piBin, ['--version'], { encoding: 'utf8', timeout: 4000 }).trim();
    return cachedPiVersion;
  } catch {
    cachedPiVersion = 'unknown';
    return cachedPiVersion;
  }
}

export const AGENT_CLEAN_ROOM_FLAGS = [
  '--no-skills',
  '--no-extensions',
  '--no-prompt-templates',
  '--no-themes',
  '--no-context-files',
  '--tools',
  'read,bash,edit,write',
];

export const ONESHOT_CLI_CLEAN_ROOM_FLAGS = [
  '--no-tools',
  '--no-session',
  '--no-skills',
  '--no-extensions',
  '--no-prompt-templates',
  '--no-themes',
  '--no-context-files',
];

const IMAGE_MIME_MAP = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export function normalizeHarnessMode(mode) {
  if (!mode || mode === 'agent') return 'agent';
  if (mode === 'oneshot' || mode === 'api') return 'oneshot';
  if (mode === 'both') return 'both';
  return 'agent';
}

export function buildCanonicalPromptAndEnvMetadata(gen = {}, promptEntry = null, config = {}) {
  const mode = gen?.mode === 'agent' ? 'agent' : 'oneshot';
  const userPrompt = gen?.exactPrompt?.userPrompt || promptEntry?.prompt || '';
  const refImages = gen?.exactPrompt?.referenceImages || promptEntry?.referenceImages || [];
  const visualNote =
    refImages.length > 0 ? `\n\n${config.generation?.visualReferenceInstruction || ''}` : '';

  if (mode === 'agent') {
    const contract = gen?.exactPrompt?.workspaceContract ?? config.generation?.agentWorkspaceContract ?? '';
    const fullDispatchedPrompt =
      gen?.exactPrompt?.fullDispatchedPrompt || `${userPrompt}${visualNote}\n\n---\n${contract}`;
    return {
      exactPrompt: {
        mode: 'agent',
        userPrompt,
        systemPrompt: '(pi default coding-agent system prompt — zero custom overrides)',
        workspaceContract: contract,
        fullDispatchedPrompt,
        referenceImages: refImages,
      },
      harnessEnvironment: gen?.harnessEnvironment || {
        mode: 'agent',
        piVersion: detectPiVersion(),
        isolationFlags: [
          '-p',
          '-a',
          ...AGENT_CLEAN_ROOM_FLAGS,
          '--thinking',
          gen?.thinkingLevel || config.generation?.thinkingLevel || 'low',
        ],
        skillsLoaded: 0,
        extensionsLoaded: 0,
        promptTemplatesLoaded: 0,
        themesLoaded: 0,
        contextFilesLoaded: 0,
        mcpServersLoaded: 0,
        enabledTools: ['read', 'bash', 'edit', 'write'],
        cleanRoomVerified: true,
      },
    };
  }

  const systemPrompt = gen?.exactPrompt?.systemPrompt ?? config.generation?.neutralSystemPrompt ?? '';
  return {
    exactPrompt: {
      mode: 'oneshot',
      userPrompt,
      systemPrompt,
      workspaceContract: null,
      fullDispatchedPrompt: `${userPrompt}${visualNote}`,
      referenceImages: refImages,
    },
    harnessEnvironment: gen?.harnessEnvironment || {
      mode: 'oneshot',
      piVersion: detectPiVersion(),
      isolationFlags: ONESHOT_CLI_CLEAN_ROOM_FLAGS,
      skillsLoaded: 0,
      extensionsLoaded: 0,
      promptTemplatesLoaded: 0,
      themesLoaded: 0,
      contextFilesLoaded: 0,
      mcpServersLoaded: 0,
      enabledTools: [],
      cleanRoomVerified: true,
    },
  };
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
    // already exited
  }
}

function runPiCli(args, { cwd, env, timeoutMs = 420000 } = {}) {
  const piBin = resolvePiBin();
  if (!piBin) throw new Error('pi CLI binary not found');

  return new Promise((resolve, reject) => {
    const child = spawn(piBin, args, {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env || { ...process.env, PI_CODING_AGENT: 'true' },
    });

    let stdout = '';
    let stderr = '';
    let firstByteMs = null;
    const started = performance.now();

    const timer = setTimeout(async () => {
      await killProcessGroupSafe(child.pid);
      reject(new Error(`pi CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (firstByteMs === null) firstByteMs = Math.round(performance.now() - started);
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', async (err) => {
      clearTimeout(timer);
      await killProcessGroupSafe(child.pid);
      reject(err);
    });
    child.on('close', async (code) => {
      clearTimeout(timer);
      // Reap any stray background processes spawned inside the agent's process group
      await killProcessGroupSafe(child.pid);
      resolve({
        code,
        stdout,
        stderr,
        ttftMs: firstByteMs,
        durationMs: Math.round(performance.now() - started),
      });
    });
  });
}

function parsePiJsonOutput(stdout) {
  let textParts = [];
  let usage = { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } };
  let stopReason = 'stop';

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const evt = JSON.parse(trimmed);
      if (evt.type === 'message_end' && evt.message?.role === 'assistant') {
        const blocks = evt.message.content || [];
        textParts = blocks.filter((b) => b.type === 'text').map((b) => b.text);
        if (evt.message.usage) usage = evt.message.usage;
        if (evt.message.stopReason) stopReason = evt.message.stopReason;
      } else if (evt.role === 'assistant' && Array.isArray(evt.content)) {
        textParts = evt.content.filter((b) => b.type === 'text').map((b) => b.text);
        if (evt.usage) usage = evt.usage;
      }
    } catch {
      // ignore non-JSON line
    }
  }

  return {
    text: textParts.length > 0 ? textParts.join('\n') : stdout,
    usage,
    stopReason,
  };
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.bench-reference',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.astro',
  '__pycache__',
  '.venv',
  'venv',
  'target',
]);

export function listWorkspaceFiles(dir, base = dir) {
  const results = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      results.push(...listWorkspaceFiles(full, base));
    } else {
      results.push(full.slice(base.length + 1));
    }
  }
  return results;
}

function resolveReferenceImageFiles(promptEntry) {
  const refs = Array.isArray(promptEntry?.referenceImages) ? promptEntry.referenceImages : [];
  const resolved = [];
  for (const r of refs) {
    if (!r?.path) continue;
    const abs = join(PROJECT_ROOT, r.path);
    if (existsSync(abs) && statSync(abs).isFile()) {
      const ext = extname(abs).toLowerCase();
      const mimeType = IMAGE_MIME_MAP[ext] || 'image/png';
      resolved.push({ ...r, absPath: abs, filename: basename(abs), mimeType });
    }
  }
  return resolved;
}

/**
 * Generates a website for one (model x prompt x mode) cell using either:
 *  - mode="agent" (PRIMARY DEFAULT): Goal-oriented autonomous `pi` coding loop with thinking + core tools
 *    in a strict clean-room (`--no-skills --no-extensions --no-prompt-templates --no-themes --no-context-files`),
 *    building a realistic multi-route web app + real backend server on $PORT and saving
 *    both `pi-session.jsonl`, `pi-transcript.html`, and `trajectory.json`.
 *  - mode="oneshot": Zero-tool single-shot @earendil-works/pi-ai completion returning one self-contained HTML document.
 */
export async function generateWebsite({
  runtime,
  modelEntry,
  promptEntry,
  cellDir,
  config,
  mode = config.generation.defaultMode || 'agent',
  onProgress = () => {},
}) {
  const normalizedMode = normalizeHarnessMode(mode);
  mkdirSync(cellDir, { recursive: true });
  const route = modelEntry.activeRoute;
  if (!route) {
    throw new Error(`Model "${modelEntry.key}" has no authenticated provider route.`);
  }

  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const resolvedRefImages = resolveReferenceImageFiles(promptEntry);
  const visualPromptSuffix =
    resolvedRefImages.length > 0 ? `\n\n${config.generation.visualReferenceInstruction || ''}` : '';

  if (normalizedMode === 'agent') {
    const workspaceDir = join(cellDir, 'agent-workspace');
    const sessionPath = join(cellDir, 'pi-session.jsonl');
    const transcriptHtmlPath = join(cellDir, 'pi-transcript.html');
    const trajectoryJsonPath = join(cellDir, 'trajectory.json');

    // Clean any prior workspace/session so --force starts from a pristine zero-bias directory
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(sessionPath, { force: true });
    rmSync(transcriptHtmlPath, { force: true });
    rmSync(trajectoryJsonPath, { force: true });
    mkdirSync(workspaceDir, { recursive: true });

    const piFileAttachments = [];
    if (resolvedRefImages.length > 0) {
      const refDir = join(workspaceDir, '.bench-reference');
      mkdirSync(refDir, { recursive: true });
      for (const img of resolvedRefImages) {
        cpSync(img.absPath, join(refDir, img.filename));
        piFileAttachments.push(`@.bench-reference/${img.filename}`);
      }
    }

    const thinkingLevel = config.generation.thinkingLevel || 'low';
    const childEnv = await buildPiCliEnv(runtime, route.provider);

    onProgress({
      stage: 'generating',
      detail: `Running clean-room pi agent loop (${route.provider}/${route.modelId}, thinking=${thinkingLevel}, 0 skills/extensions)`,
    });

    const contract = config.generation.agentWorkspaceContract || '';
    const agentPrompt = `${promptEntry.prompt}${visualPromptSuffix}\n\n---\n${contract}`;

    const cliArgs = [
      '-p',
      '-a',
      '--session',
      sessionPath,
      ...AGENT_CLEAN_ROOM_FLAGS,
      '--thinking',
      thinkingLevel,
      '--provider',
      route.provider,
      '--model',
      route.modelId,
      '--',
      ...piFileAttachments,
      agentPrompt,
    ];

    const exactPrompt = {
      mode: 'agent',
      userPrompt: promptEntry.prompt,
      systemPrompt: '(pi default coding-agent system prompt — zero custom overrides)',
      workspaceContract: contract,
      fullDispatchedPrompt: agentPrompt,
      referenceImages: resolvedRefImages.map(({ path, label, caption }) => ({ path, label, caption })),
    };

    const harnessEnvironment = {
      mode: 'agent',
      piVersion: detectPiVersion(),
      isolationFlags: ['-p', '-a', ...AGENT_CLEAN_ROOM_FLAGS, '--thinking', thinkingLevel],
      skillsLoaded: 0,
      extensionsLoaded: 0,
      promptTemplatesLoaded: 0,
      themesLoaded: 0,
      contextFilesLoaded: 0,
      mcpServersLoaded: 0,
      enabledTools: ['read', 'bash', 'edit', 'write'],
      cleanRoomVerified: true,
    };

    try {
      const res = await runPiCli(cliArgs, {
        cwd: workspaceDir,
        env: childEnv,
        timeoutMs: config.generation.agentTimeoutMs || 600000,
      });

      const createdFiles = listWorkspaceFiles(workspaceDir);
      const rawText = res.stdout || '';
      writeFileSync(join(cellDir, 'raw-output.md'), rawText, 'utf8');

      // Parse structured trajectory metrics & export interactive HTML session viewer
      const trajectory = saveTrajectorySummary(sessionPath, trajectoryJsonPath);
      const hasTranscriptHtml = await exportPiTranscriptHtml(sessionPath, transcriptHtmlPath);

      const meta = {
        modelKey: modelEntry.key,
        modelLabel: modelEntry.label,
        family: modelEntry.family,
        promptId: promptEntry.id,
        category: promptEntry.category,
        mode: 'agent',
        provider: route.provider,
        modelId: route.modelId,
        via: route.via,
        thinkingLevel,
        exactPrompt,
        harnessEnvironment,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: res.durationMs,
        ttftMs: res.ttftMs,
        exitCode: res.code,
        createdFiles,
        outputChars: rawText.length,
        hasSessionJsonl: existsSync(sessionPath),
        hasTranscriptHtml,
        turnCount: trajectory?.turnCount ?? null,
        totalToolCalls: trajectory?.totalToolCalls ?? null,
        usage: trajectory?.usage || null,
        costUsd: trajectory?.usage?.costUsd ?? null,
        error: res.code !== 0 && createdFiles.length === 0 ? (res.stderr || `pi exited ${res.code}`).slice(0, 600) : null,
      };
      writeFileSync(join(cellDir, 'generation.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');
      return meta;
    } catch (err) {
      // Still salvage partial session transcript if pi timed out mid-loop!
      const createdFiles = listWorkspaceFiles(workspaceDir);
      const trajectory = saveTrajectorySummary(sessionPath, trajectoryJsonPath);
      const hasTranscriptHtml = await exportPiTranscriptHtml(sessionPath, transcriptHtmlPath);
      const durationMs = Math.round(performance.now() - t0);

      const meta = {
        modelKey: modelEntry.key,
        modelLabel: modelEntry.label,
        family: modelEntry.family,
        promptId: promptEntry.id,
        category: promptEntry.category,
        mode: 'agent',
        provider: route.provider,
        modelId: route.modelId,
        via: route.via,
        thinkingLevel,
        exactPrompt,
        harnessEnvironment,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs,
        ttftMs: null,
        exitCode: 124,
        createdFiles,
        outputChars: 0,
        hasSessionJsonl: existsSync(sessionPath),
        hasTranscriptHtml,
        turnCount: trajectory?.turnCount ?? null,
        totalToolCalls: trajectory?.totalToolCalls ?? null,
        usage: trajectory?.usage || null,
        costUsd: trajectory?.usage?.costUsd ?? null,
        error: createdFiles.length > 0 ? null : err.message || String(err),
        warning: createdFiles.length > 0 ? err.message || String(err) : null,
      };
      writeFileSync(join(cellDir, 'generation.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');
      return meta;
    }
  }

  // normalizedMode === "oneshot"
  const systemPrompt = config.generation.neutralSystemPrompt;
  const dispatchedUserText = `${promptEntry.prompt}${visualPromptSuffix}`;
  const exactPrompt = {
    mode: 'oneshot',
    userPrompt: promptEntry.prompt,
    systemPrompt,
    workspaceContract: null,
    fullDispatchedPrompt: dispatchedUserText,
    referenceImages: resolvedRefImages.map(({ path, label, caption }) => ({ path, label, caption })),
  };
  const harnessEnvironment = {
    mode: 'oneshot',
    piVersion: detectPiVersion(),
    isolationFlags: ONESHOT_CLI_CLEAN_ROOM_FLAGS,
    skillsLoaded: 0,
    extensionsLoaded: 0,
    promptTemplatesLoaded: 0,
    themesLoaded: 0,
    contextFilesLoaded: 0,
    mcpServersLoaded: 0,
    enabledTools: [],
    cleanRoomVerified: true,
  };

  if (route.transport === 'pi-cli') {
    const childEnv = await buildPiCliEnv(runtime, route.provider);
    onProgress({ stage: 'generating', detail: `Calling clean-room 1-shot ${route.provider}/${route.modelId} via pi --no-tools` });
    const fileArgs = resolvedRefImages.map((img) => `@${img.absPath}`);
    const res = await runPiCli(
      [
        '-p',
        ...ONESHOT_CLI_CLEAN_ROOM_FLAGS,
        '--mode',
        'json',
        '--provider',
        route.provider,
        '--model',
        route.modelId,
        '--system-prompt',
        systemPrompt,
        '--',
        ...fileArgs,
        dispatchedUserText,
      ],
      { cwd: cellDir, env: childEnv, timeoutMs: config.generation.timeoutMs }
    );

    const parsed = parsePiJsonOutput(res.stdout);
    writeFileSync(join(cellDir, 'raw-output.md'), parsed.text, 'utf8');
    const meta = {
      modelKey: modelEntry.key,
      modelLabel: modelEntry.label,
      family: modelEntry.family,
      promptId: promptEntry.id,
      category: promptEntry.category,
      mode: 'oneshot',
      provider: route.provider,
      modelId: route.modelId,
      via: route.via,
      exactPrompt,
      harnessEnvironment,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: res.durationMs,
      ttftMs: res.ttftMs,
      stopReason: parsed.stopReason,
      outputChars: parsed.text.length,
      usage: parsed.usage,
      costUsd: parsed.usage?.cost?.total ?? null,
      error: res.code !== 0 && !parsed.text.trim() ? (res.stderr || `pi exited ${res.code}`) : null,
    };
    writeFileSync(join(cellDir, 'generation.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');
    return meta;
  }

  // Direct @earendil-works/pi-ai streamSimple call
  onProgress({ stage: 'generating', detail: `Streaming clean-room 1-shot ${route.provider}/${route.modelId} via pi-ai` });
  const maxTokens = Math.min(config.generation.maxTokens || 32768, route.piModel.maxTokens || 32768);
  const modelSupportsVision = Array.isArray(route.piModel?.input) && route.piModel.input.includes('image');

  const userContent =
    resolvedRefImages.length > 0 && modelSupportsVision
      ? [
          ...resolvedRefImages.map((img) => ({
            type: 'image',
            data: readFileSync(img.absPath).toString('base64'),
            mimeType: img.mimeType,
          })),
          { type: 'text', text: dispatchedUserText },
        ]
      : dispatchedUserText;

  const context = {
    systemPrompt,
    messages: [
      {
        role: 'user',
        content: userContent,
        timestamp: Date.now(),
      },
    ],
  };

  let ttftMs = null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('Generation timeout')), config.generation.timeoutMs || 240000);

  try {
    const streamOpts = {
      maxTokens,
      signal: ac.signal,
    };
    if (route.piModel.reasoning) {
      streamOpts.reasoning = 'low';
    }
    const stream = runtime.piModels.streamSimple(route.piModel, context, streamOpts);

    for await (const evt of stream) {
      if (ttftMs === null && (evt.type === 'text_delta' || evt.type === 'thinking_delta')) {
        ttftMs = Math.round(performance.now() - t0);
      }
    }

    const assistantMsg = await stream.result();
    clearTimeout(timer);

    const text = Array.isArray(assistantMsg.content)
      ? runtime.piAi.contentText(assistantMsg.content) || ''
      : '';
    const durationMs = Math.round(performance.now() - t0);
    let cost = assistantMsg.usage?.cost;
    if ((!cost || !cost.total) && assistantMsg.usage) {
      try {
        cost = runtime.piAi.calculateCost(route.piModel, assistantMsg.usage);
      } catch {
        // leave default
      }
    }

    writeFileSync(join(cellDir, 'raw-output.md'), text, 'utf8');

    const isError = assistantMsg.stopReason === 'error' || assistantMsg.stopReason === 'aborted';
    const meta = {
      modelKey: modelEntry.key,
      modelLabel: modelEntry.label,
      family: modelEntry.family,
      promptId: promptEntry.id,
      category: promptEntry.category,
      mode: 'oneshot',
      provider: route.provider,
      modelId: route.modelId,
      via: route.via,
      exactPrompt,
      harnessEnvironment: {
        ...harnessEnvironment,
        visionAttached: resolvedRefImages.length > 0 && modelSupportsVision,
      },
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs,
      ttftMs,
      stopReason: assistantMsg.stopReason,
      outputChars: text.length,
      usage: assistantMsg.usage || null,
      costUsd: cost?.total ?? null,
      error: isError ? (assistantMsg.errorMessage || `Stopped with ${assistantMsg.stopReason}`) : null,
    };
    writeFileSync(join(cellDir, 'generation.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');
    return meta;
  } catch (err) {
    clearTimeout(timer);
    const durationMs = Math.round(performance.now() - t0);
    const meta = {
      modelKey: modelEntry.key,
      modelLabel: modelEntry.label,
      family: modelEntry.family,
      promptId: promptEntry.id,
      category: promptEntry.category,
      mode: 'oneshot',
      provider: route.provider,
      modelId: route.modelId,
      via: route.via,
      exactPrompt,
      harnessEnvironment,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs,
      ttftMs,
      stopReason: 'error',
      outputChars: 0,
      usage: null,
      costUsd: null,
      error: err.message || String(err),
    };
    writeFileSync(join(cellDir, 'generation.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');
    return meta;
  }
}
