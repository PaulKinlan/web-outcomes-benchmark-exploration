import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, rmSync, cpSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { spawn } from 'node:child_process';
import { resolvePiBin, getPiRuntimeInfo } from './pi-loader.mjs';
import { buildPiCliEnv } from './pi-auth-bridge.mjs';
import { resolveBridgeForProvider } from './provider-bridges.mjs';
import { exportPiTranscriptHtml, saveTrajectorySummary } from './pi-transcript.mjs';
import { loadDesignDoc } from '../registry/prompts.mjs';
import { PROJECT_ROOT, sleep } from '../util/env.mjs';

let cachedPiVersion = null;
export function detectPiVersion() {
  if (cachedPiVersion !== null) return cachedPiVersion;
  const info = getPiRuntimeInfo();
  cachedPiVersion = info.version || 'unavailable';
  return cachedPiVersion;
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

export function normalizeSpecMode(spec) {
  const s = String(spec || '').trim().toLowerCase();
  if (s === 'guided' || s === 'reference' || s === 'seeded') return 'guided';
  if (s === 'both' || s === 'all') return 'both';
  return 'freeform';
}

export function buildCellId(modelKey, promptId, mode = 'agent', spec = 'freeform') {
  const cleanMode = mode === 'agent' ? 'agent' : 'oneshot';
  const cleanSpec = spec === 'guided' ? 'guided' : 'freeform';
  return cleanSpec === 'guided'
    ? `${modelKey}__${promptId}__${cleanMode}__guided`
    : `${modelKey}__${promptId}__${cleanMode}`;
}

export function parseCellDirIdentity(dirName, generation = null) {
  const raw = String(dirName || '');
  const parts = raw.split('__');
  if (parts.length >= 4 && parts[parts.length - 1] === 'guided') {
    const modePart = parts[parts.length - 2];
    return {
      modelKey: generation?.modelKey || parts[0] || '',
      promptId: generation?.promptId || parts.slice(1, parts.length - 2).join('__') || '',
      mode: generation?.mode === 'agent' || modePart === 'agent' ? 'agent' : 'oneshot',
      spec: 'guided',
    };
  }
  const modePart = parts[2] || '';
  return {
    modelKey: generation?.modelKey || parts[0] || '',
    promptId: generation?.promptId || parts[1] || '',
    mode: generation?.mode === 'agent' || modePart === 'agent' || raw.endsWith('__agent') ? 'agent' : 'oneshot',
    spec: generation?.spec === 'guided' || generation?.exactPrompt?.spec === 'guided' ? 'guided' : 'freeform',
  };
}

function resolveReferenceImageList(refs) {
  const arr = Array.isArray(refs) ? refs : [];
  const resolved = [];
  for (const r of arr) {
    if (!r?.path) continue;
    const abs = join(PROJECT_ROOT, r.path);
    if (existsSync(abs) && statSync(abs).isFile()) {
      const ext = extname(abs).toLowerCase();
      const mimeType = IMAGE_MIME_MAP[ext] || 'image/jpeg';
      resolved.push({ ...r, absPath: abs, filename: basename(abs), mimeType });
    }
  }
  return resolved;
}

export function formatCanonicalSeedDataSection(seedData) {
  if (!seedData || typeof seedData !== 'object') return '';
  return [
    '## Canonical Brand & Content Seed Data',
    'Use the exact organization name, physical address, contact details, pricing, and starter records below so domain content is consistent across implementations:',
    '```json',
    JSON.stringify(seedData, null, 2),
    '```',
  ].join('\n');
}

export function composeSpecPromptMaterials({ promptEntry, spec = 'freeform', config = {}, designDoc = null }) {
  const cleanSpec = spec === 'guided' ? 'guided' : 'freeform';
  const basePrompt = promptEntry?.prompt || '';
  const visualInstruction =
    config.generation?.visualReferenceInstruction ||
    'Use the attached reference layout image as a reference for the proposed page layout, visual hierarchy, color palette, and component styling while implementing all requested functionality.';

  if (cleanSpec === 'freeform') {
    const resolvedRefImages = resolveReferenceImageList(promptEntry?.referenceImages || []);
    const visualSuffix = resolvedRefImages.length > 0 ? `\n\n${visualInstruction}` : '';
    return {
      spec: 'freeform',
      basePrompt,
      composedUserPrompt: `${basePrompt}${visualSuffix}`,
      resolvedRefImages,
      seedData: null,
      designDocText: null,
    };
  }

  // cleanSpec === 'guided'
  const candidateRefs =
    Array.isArray(promptEntry?.referenceImages) && promptEntry.referenceImages.length > 0
      ? promptEntry.referenceImages
      : Array.isArray(promptEntry?.guidedReferenceImages) && promptEntry.guidedReferenceImages.length > 0
        ? promptEntry.guidedReferenceImages
        : promptEntry?.id
          ? [
              {
                path: `assets/reference-images/${promptEntry.id}.jpg`,
                label: `${promptEntry.title || promptEntry.id} — Proposed Desktop Layout Reference`,
              },
            ]
          : [];

  const resolvedRefImages = resolveReferenceImageList(candidateRefs);
  const effectiveDesignDoc = (designDoc ?? loadDesignDoc() ?? '').trim();
  const seedData = promptEntry?.seedData || null;

  const sections = [basePrompt];
  if (resolvedRefImages.length > 0) {
    sections.push(visualInstruction);
  }
  if (seedData) {
    sections.push(formatCanonicalSeedDataSection(seedData));
  }
  if (effectiveDesignDoc) {
    sections.push(effectiveDesignDoc);
  }

  return {
    spec: 'guided',
    basePrompt,
    composedUserPrompt: sections.filter(Boolean).join('\n\n'),
    resolvedRefImages,
    seedData,
    designDocText: effectiveDesignDoc || null,
  };
}

export function buildCanonicalPromptAndEnvMetadata(gen = {}, promptEntry = null, config = {}) {
  const mode = gen?.mode === 'agent' ? 'agent' : 'oneshot';
  const spec = gen?.spec === 'guided' || gen?.exactPrompt?.spec === 'guided' ? 'guided' : 'freeform';
  const materials = composeSpecPromptMaterials({ promptEntry, spec, config });

  const userPrompt = gen?.exactPrompt?.userPrompt || materials.basePrompt || promptEntry?.prompt || '';
  const refImages =
    gen?.exactPrompt?.referenceImages ||
    materials.resolvedRefImages.map(({ path, label, caption }) => ({ path, label, caption }));
  const seedData = gen?.exactPrompt?.seedData ?? (spec === 'guided' ? materials.seedData : null);
  const hasDesignDoc = Boolean(gen?.exactPrompt?.hasDesignDoc ?? (spec === 'guided' && materials.designDocText));

  if (mode === 'agent') {
    const contract = gen?.exactPrompt?.workspaceContract ?? config.generation?.agentWorkspaceContract ?? '';
    const fullDispatchedPrompt =
      gen?.exactPrompt?.fullDispatchedPrompt || `${materials.composedUserPrompt}\n\n---\n${contract}`;
    return {
      exactPrompt: {
        mode: 'agent',
        spec,
        userPrompt,
        systemPrompt: '(pi default coding-agent system prompt — zero custom overrides)',
        workspaceContract: contract,
        fullDispatchedPrompt,
        referenceImages: refImages,
        seedData,
        hasDesignDoc,
        designDoc: spec === 'guided' ? materials.designDocText : null,
      },
      harnessEnvironment: gen?.harnessEnvironment || {
        mode: 'agent',
        spec,
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
  const fullDispatchedPrompt = gen?.exactPrompt?.fullDispatchedPrompt || materials.composedUserPrompt;
  return {
    exactPrompt: {
      mode: 'oneshot',
      spec,
      userPrompt,
      systemPrompt,
      workspaceContract: null,
      fullDispatchedPrompt,
      referenceImages: refImages,
      seedData,
      hasDesignDoc,
      designDoc: spec === 'guided' ? materials.designDocText : null,
    },
    harnessEnvironment: gen?.harnessEnvironment || {
      mode: 'oneshot',
      spec,
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

/**
 * Generates a website for one (model x prompt x mode x spec) cell:
 *  - spec="freeform": Open 1-sentence functional prompt only (unconstrained layout & content defaults)
 *  - spec="guided": Attaches gemini-nano-banana-2.1 layout reference image + canonical seedData + prompts/design.md
 */
export async function generateWebsite({
  runtime,
  modelEntry,
  promptEntry,
  cellDir,
  config,
  mode = config.generation.defaultMode || 'agent',
  spec = config.generation.defaultSpec || 'freeform',
  designDoc = null,
  onProgress = () => {},
}) {
  const normalizedMode = normalizeHarnessMode(mode);
  const normalizedSpec = spec === 'guided' ? 'guided' : 'freeform';
  mkdirSync(cellDir, { recursive: true });
  const route = modelEntry.activeRoute;
  if (!route) {
    throw new Error(`Model "${modelEntry.key}" has no authenticated provider route.`);
  }

  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const materials = composeSpecPromptMaterials({
    promptEntry,
    spec: normalizedSpec,
    config,
    designDoc,
  });
  const { resolvedRefImages, composedUserPrompt, seedData, designDocText } = materials;

  if (normalizedMode === 'agent') {
    const workspaceDir = join(cellDir, 'agent-workspace');
    const sessionPath = join(cellDir, 'pi-session.jsonl');
    const transcriptHtmlPath = join(cellDir, 'pi-transcript.html');
    const trajectoryJsonPath = join(cellDir, 'trajectory.json');

    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(sessionPath, { force: true });
    rmSync(transcriptHtmlPath, { force: true });
    rmSync(trajectoryJsonPath, { force: true });
    mkdirSync(workspaceDir, { recursive: true });

    const piFileAttachments = [];
    if (resolvedRefImages.length > 0 || normalizedSpec === 'guided') {
      const refDir = join(workspaceDir, '.bench-reference');
      mkdirSync(refDir, { recursive: true });
      for (const img of resolvedRefImages) {
        cpSync(img.absPath, join(refDir, img.filename));
        piFileAttachments.push(`@.bench-reference/${img.filename}`);
      }
      if (normalizedSpec === 'guided') {
        if (designDocText) {
          writeFileSync(join(refDir, 'design.md'), designDocText + '\n', 'utf8');
        }
        if (seedData) {
          writeFileSync(join(refDir, 'seed-data.json'), JSON.stringify(seedData, null, 2) + '\n', 'utf8');
        }
      }
    }

    const thinkingLevel = config.generation.thinkingLevel || 'low';
    const childEnv = await buildPiCliEnv(runtime, route.provider);
    const activeBridge = resolveBridgeForProvider(route.provider);
    const piInfo = getPiRuntimeInfo();

    onProgress({
      stage: 'generating',
      detail: `Running clean-room pi agent loop (${route.provider}/${route.modelId}, spec=${normalizedSpec}, thinking=${thinkingLevel}${activeBridge ? `, bridge=${activeBridge.id}` : ', 0 skills/extensions'})`,
    });

    const contract = config.generation.agentWorkspaceContract || '';
    const agentPrompt = `${composedUserPrompt}\n\n---\n${contract}`;

    const cliArgs = [
      '-p',
      '-a',
      '--session',
      sessionPath,
      ...AGENT_CLEAN_ROOM_FLAGS,
      ...(activeBridge ? activeBridge.cliFlags : []),
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
      spec: normalizedSpec,
      userPrompt: promptEntry.prompt,
      systemPrompt: '(pi default coding-agent system prompt — zero custom overrides)',
      workspaceContract: contract,
      fullDispatchedPrompt: agentPrompt,
      referenceImages: resolvedRefImages.map(({ path, label, caption }) => ({ path, label, caption })),
      seedData: normalizedSpec === 'guided' ? seedData : null,
      hasDesignDoc: Boolean(normalizedSpec === 'guided' && designDocText),
    };

    const harnessEnvironment = {
      mode: 'agent',
      spec: normalizedSpec,
      piVersion: piInfo.version || detectPiVersion(),
      piSource: piInfo.source,
      piPortable: piInfo.portable,
      isolationFlags: [
        '-p',
        '-a',
        ...AGENT_CLEAN_ROOM_FLAGS,
        ...(activeBridge ? ['-e', `<bridge:${activeBridge.id}>`] : []),
        '--thinking',
        thinkingLevel,
      ],
      skillsLoaded: 0,
      ambientExtensionsLoaded: 0,
      extensionsLoaded: activeBridge ? activeBridge.entrypoints.length : 0,
      providerBridge: activeBridge
        ? {
            id: activeBridge.id,
            packageName: activeBridge.packageName,
            version: activeBridge.version,
            source: activeBridge.source,
          }
        : null,
      promptTemplatesLoaded: 0,
      themesLoaded: 0,
      contextFilesLoaded: 0,
      mcpServersLoaded: 0,
      enabledTools: ['read', 'bash', 'edit', 'write'],
      secretScrubbed: true,
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

      const trajectory = saveTrajectorySummary(sessionPath, trajectoryJsonPath);
      const hasTranscriptHtml = await exportPiTranscriptHtml(sessionPath, transcriptHtmlPath);

      const meta = {
        modelKey: modelEntry.key,
        modelLabel: modelEntry.label,
        family: modelEntry.family,
        promptId: promptEntry.id,
        category: promptEntry.category,
        mode: 'agent',
        spec: normalizedSpec,
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
        spec: normalizedSpec,
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
  const dispatchedUserText = composedUserPrompt;
  const exactPrompt = {
    mode: 'oneshot',
    spec: normalizedSpec,
    userPrompt: promptEntry.prompt,
    systemPrompt,
    workspaceContract: null,
    fullDispatchedPrompt: dispatchedUserText,
    referenceImages: resolvedRefImages.map(({ path, label, caption }) => ({ path, label, caption })),
    seedData: normalizedSpec === 'guided' ? seedData : null,
    hasDesignDoc: Boolean(normalizedSpec === 'guided' && designDocText),
  };
  const piInfo = getPiRuntimeInfo();
  const activeBridge = route.transport === 'pi-cli' ? resolveBridgeForProvider(route.provider) : null;
  const harnessEnvironment = {
    mode: 'oneshot',
    spec: normalizedSpec,
    piVersion: piInfo.version || detectPiVersion(),
    piSource: piInfo.source,
    piPortable: piInfo.portable,
    isolationFlags: [
      ...ONESHOT_CLI_CLEAN_ROOM_FLAGS,
      ...(activeBridge ? ['-e', `<bridge:${activeBridge.id}>`] : []),
    ],
    skillsLoaded: 0,
    ambientExtensionsLoaded: 0,
    extensionsLoaded: activeBridge ? activeBridge.entrypoints.length : 0,
    providerBridge: activeBridge
      ? {
          id: activeBridge.id,
          packageName: activeBridge.packageName,
          version: activeBridge.version,
          source: activeBridge.source,
        }
      : null,
    promptTemplatesLoaded: 0,
    themesLoaded: 0,
    contextFilesLoaded: 0,
    mcpServersLoaded: 0,
    enabledTools: [],
    secretScrubbed: true,
    cleanRoomVerified: true,
  };

  if (route.transport === 'pi-cli') {
    const childEnv = await buildPiCliEnv(runtime, route.provider);
    onProgress({
      stage: 'generating',
      detail: `Calling clean-room 1-shot ${route.provider}/${route.modelId} (spec=${normalizedSpec}) via pi --no-tools`,
    });
    const fileArgs = resolvedRefImages.map((img) => `@${img.absPath}`);
    const res = await runPiCli(
      [
        '-p',
        ...ONESHOT_CLI_CLEAN_ROOM_FLAGS,
        ...(activeBridge ? activeBridge.cliFlags : []),
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
      spec: normalizedSpec,
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
  onProgress({
    stage: 'generating',
    detail: `Streaming clean-room 1-shot ${route.provider}/${route.modelId} (spec=${normalizedSpec}) via pi-ai`,
  });
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
      spec: normalizedSpec,
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
      spec: normalizedSpec,
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
