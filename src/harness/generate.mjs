import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, rmSync, cpSync, realpathSync } from 'node:fs';
import { join, basename, extname, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolvePiBin, getPiRuntimeInfo } from './pi-loader.mjs';
import { buildPiCliEnv } from './pi-auth-bridge.mjs';
import { resolveBridgeForProvider } from './provider-bridges.mjs';
import { exportPiTranscriptHtml, saveTrajectorySummary } from './pi-transcript.mjs';
import {
  normalizeHarnessId,
  getHarnessSpec,
  resolveAcpHarnessBinInfo,
  installAcpHarnessAdapter,
  resolvePiExtensionHarness,
  installPiExtensionHarness,
  getTrackForCell,
} from './harness-registry.mjs';
import { runAcpCodingSession } from './acp-client.mjs';
import { resolveLiveRoute } from './model-id-resolver.mjs';
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

/** Sample 1 keeps the plain cell id; repeat samples (2, 3, …) of the same cell get a `__s<N>` suffix. */
export function normalizeSampleIndex(sample) {
  const n = Math.floor(Number(sample));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 9) : 1;
}

export function buildCellId(modelKey, promptId, mode = 'agent', spec = 'freeform', harness = 'pi', sample = 1) {
  const sampleIndex = normalizeSampleIndex(sample);
  if (sampleIndex > 1) return `${buildCellId(modelKey, promptId, mode, spec, harness)}__s${sampleIndex}`;
  const cleanMode = mode === 'agent' ? 'agent' : 'oneshot';
  const cleanSpec = spec === 'guided' ? 'guided' : 'freeform';
  const cleanHarness = normalizeHarnessId(harness);
  const base =
    cleanSpec === 'guided'
      ? `${modelKey}__${promptId}__${cleanMode}__guided`
      : `${modelKey}__${promptId}__${cleanMode}`;
  return cleanHarness !== 'pi' ? `${base}__${cleanHarness}` : base;
}

let cachedPiPromptBuilder;

/**
 * Where pi's `buildSystemPrompt` module can live for a given `pi` binary. The published package points its bin at
 * `dist/bundle/cli.js`, older and source checkouts at `dist/cli.js`, so walk up from the real binary to the package
 * root rather than assuming one layout. The project-local runtime is only a last resort: capturing its prompt when a
 * different pi was actually selected would publish the wrong text.
 */
export function piSystemPromptModuleCandidates(piBin) {
  const out = [];
  if (piBin) {
    let real = piBin;
    try {
      real = realpathSync(piBin);
    } catch {
      // keep the unresolved path
    }
    let dir = dirname(real);
    for (let i = 0; i < 6; i++) {
      if (existsSync(join(dir, 'package.json'))) {
        out.push(join(dir, 'dist', 'core', 'system-prompt.js'));
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  const local = join(PROJECT_ROOT, '.pi-runtime', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'core', 'system-prompt.js');
  if (!out.includes(local)) out.push(local);
  return out;
}
/**
 * Reconstructs the system prompt the clean-room pi agent sends, using pi's own `buildSystemPrompt`, so the
 * "direct agent" baseline is published rather than described. Tool one-liners registered at runtime are not
 * included, which the `source` field states.
 */
export async function capturePiSystemPrompt(cwd) {
  try {
    if (cachedPiPromptBuilder === undefined) {
      const candidates = piSystemPromptModuleCandidates(resolvePiBin()).filter((c) => existsSync(c));
      cachedPiPromptBuilder = candidates.length
        ? (await import(pathToFileURL(candidates[0]).href)).buildSystemPrompt || null
        : null;
    }
    if (!cachedPiPromptBuilder) return null;
    const text = cachedPiPromptBuilder({ cwd, selectedTools: ['read', 'bash', 'edit', 'write'] });
    const stable = text.replaceAll(String(cwd).replace(/\\/g, '/'), '<workspace>');
    return {
      text: stable,
      sha256: createHash('sha256').update(stable).digest('hex'),
      source: `reconstructed with pi ${detectPiVersion()} buildSystemPrompt (tools read/bash/edit/write; runtime tool one-liners omitted)`,
    };
  } catch {
    return null;
  }
}

const KNOWN_NON_PI_HARNESS_RE = /^(?:[a-z0-9-]+-(?:acp|msp))$/i;

export function parseCellDirIdentity(dirName, generation = null) {
  const sampleMatch = String(dirName || '').match(/__s([2-9])$/);
  const base = parseCellDirIdentityBase(sampleMatch ? String(dirName).slice(0, sampleMatch.index) : dirName, generation);
  return sampleMatch ? { ...base, sample: Number(sampleMatch[1]) } : base;
}

function parseCellDirIdentityBase(dirName, generation = null) {
  const raw = String(dirName || '');
  const parts = raw.split('__');
  let dirHarness = null;
  if (parts.length >= 4 && KNOWN_NON_PI_HARNESS_RE.test(parts[parts.length - 1])) {
    dirHarness = normalizeHarnessId(parts.pop());
  }
  const harness = dirHarness || normalizeHarnessId(generation?.harness || 'pi');

  if (parts.length >= 4 && parts[parts.length - 1] === 'guided') {
    const modePart = parts[parts.length - 2];
    return {
      modelKey: generation?.modelKey || parts[0] || '',
      promptId: generation?.promptId || parts.slice(1, parts.length - 2).join('__') || '',
      mode: generation?.mode === 'agent' || modePart === 'agent' ? 'agent' : 'oneshot',
      spec: 'guided',
      harness,
    };
  }
  const modePart = parts[2] || '';
  return {
    modelKey: generation?.modelKey || parts[0] || '',
    promptId: generation?.promptId || parts[1] || '',
    mode: generation?.mode === 'agent' || modePart === 'agent' || parts[parts.length - 1] === 'agent' ? 'agent' : 'oneshot',
    spec: generation?.spec === 'guided' || generation?.exactPrompt?.spec === 'guided' ? 'guided' : 'freeform',
    harness,
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
  const harness = normalizeHarnessId(gen?.harness || 'pi');
  const harnessSpec = getHarnessSpec(harness);
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
        harness,
        userPrompt,
        systemPrompt:
          harness !== 'pi'
            ? `(${harnessSpec?.label || harness} native system prompt over ACP v1 — zero MCP servers / zero ambient project files)`
            : '(pi default coding-agent system prompt — zero custom overrides)',
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
        harness,
        harnessLabel: harnessSpec?.label || harness,
        protocol: harness !== 'pi' ? 'acp-v1' : 'pi-cli',
        piVersion: detectPiVersion(),
        isolationFlags:
          harness !== 'pi'
            ? ['acp-v1-stdio', 'mcpServers=[]', 'isolated-cwd']
            : [
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

/** True when the agent process was killed (SIGTERM/SIGKILL) rather than finishing on its own. */
export function wasCutOff(res) {
  return Boolean(res) && (res.signal === 'SIGTERM' || res.signal === 'SIGKILL' || res.code === 143 || res.code === 137);
}

export function cutOffMessage(res, createdFiles = [], trajectory = null) {
  const secs = Math.round((res?.durationMs || 0) / 1000);
  return `Stopped by the time limit after ${secs}s before the agent finished (${createdFiles.length} files written, ${trajectory?.turnCount ?? '?'} turns, ${trajectory?.totalToolCalls ?? '?'} tool calls). The site is incomplete.`;
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
    child.on('close', async (code, signal) => {
      clearTimeout(timer);
      await killProcessGroupSafe(child.pid);
      resolve({
        code,
        signal: signal || null,
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
  harness = config.generation.defaultHarness || 'pi',
  designDoc = null,
  onProgress = () => {},
}) {
  const normalizedMode = normalizeHarnessMode(mode);
  const normalizedSpec = spec === 'guided' ? 'guided' : 'freeform';
  const normalizedHarness = normalizeHarnessId(harness);
  const harnessSpec = getHarnessSpec(normalizedHarness) || getHarnessSpec('pi');
  mkdirSync(cellDir, { recursive: true });
  const route = harnessSpec.protocol === 'pi' ? await resolveLiveRoute(modelEntry, modelEntry.activeRoute) : modelEntry.activeRoute;
  if (!route && harnessSpec.protocol === 'pi') {
    throw new Error(`Model "${modelEntry.key}" has no authenticated provider route.`);
  }
  if (route?.modelIdResolution?.method === 'not-listed') {
    // Fail with the ids the key can actually use, rather than an opaque 404 from the provider.
    throw new Error(
      `Provider "${route.provider}" does not list model "${route.modelId}" for this API key. Available: ${route.modelIdResolution.availableModelIds.join(', ')}`
    );
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
    const acpSessionPath = join(cellDir, 'acp-session.jsonl');
    const transcriptHtmlPath = join(cellDir, 'pi-transcript.html');
    const trajectoryJsonPath = join(cellDir, 'trajectory.json');

    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(sessionPath, { force: true });
    rmSync(acpSessionPath, { force: true });
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

    const contract = config.generation.agentWorkspaceContract || '';
    const agentPrompt = `${composedUserPrompt}\n\n---\n${contract}`;

    // --- ACP Harness Path (claude-acp, codex-acp, custom-acp) ---
    if (harnessSpec.protocol === 'acp') {
      const targetProvider = harnessSpec.provider || route?.provider || 'anthropic';
      const childEnv = await buildPiCliEnv(runtime, targetProvider);
      let binInfo = resolveAcpHarnessBinInfo(normalizedHarness);
      if (!binInfo.available) {
        onProgress({
          stage: 'generating',
          detail: `Installing ACP adapter ${harnessSpec.packageName}@${harnessSpec.version || 'latest'} into .acp-runtime/...`,
        });
        binInfo = installAcpHarnessAdapter(normalizedHarness);
      }

      const desiredModelId =
        modelEntry.routes?.find((r) => r.provider === targetProvider)?.modelId ||
        route?.modelId ||
        modelEntry.key;

      // Pin the model through the adapter's own env var too (e.g. ANTHROPIC_MODEL for Claude Code), so the
      // agent starts on the requested model even before session/set_model is negotiated.
      if (harnessSpec.modelEnvVar && desiredModelId) {
        childEnv[harnessSpec.modelEnvVar] = desiredModelId;
      }
      // Vendor CLIs that read differently named variables (e.g. Qwen Code reads OPENAI_API_KEY for DashScope):
      // copy the first configured source key across, plus any static endpoint settings.
      for (const [target, sources] of Object.entries(harnessSpec.envFrom || {})) {
        const hit = (Array.isArray(sources) ? sources : [sources]).find((v) => childEnv[v] || process.env[v]);
        if (hit && !childEnv[target]) childEnv[target] = childEnv[hit] || process.env[hit];
      }
      for (const [k, v] of Object.entries(harnessSpec.env || {})) {
        if (!childEnv[k]) childEnv[k] = v;
      }

      const customArgs =
        normalizedHarness === 'custom-acp' && process.env.ACP_CUSTOM_ARGS
          ? process.env.ACP_CUSTOM_ARGS.split(/\s+/).filter(Boolean)
          : Array.isArray(harnessSpec.args)
            ? harnessSpec.args
            : [];

      onProgress({
        stage: 'generating',
        detail: `Running ${harnessSpec.label} over ACP v1 (${desiredModelId}, spec=${normalizedSpec})`,
      });

      const acpRes = await runAcpCodingSession({
        command: binInfo.binPath,
        args: customArgs,
        workspaceDir,
        env: childEnv,
        harnessSpec,
        desiredModelId,
        desiredModelKey: modelEntry.key,
        promptText: agentPrompt,
        referenceImages: resolvedRefImages,
        allowedReadPaths: resolvedRefImages.map((img) => img.absPath),
        sessionJsonlPath: acpSessionPath,
        trajectoryJsonPath,
        transcriptHtmlPath,
        timeoutMs: config.generation.agentTimeoutMs || 900000,
        onProgress,
      });

      const createdFiles = listWorkspaceFiles(workspaceDir);
      writeFileSync(join(cellDir, 'raw-output.md'), acpRes.assistantText || '', 'utf8');

      const exactPrompt = {
        mode: 'agent',
        spec: normalizedSpec,
        harness: normalizedHarness,
        userPrompt: promptEntry.prompt,
        systemPrompt: `(${harnessSpec.label} native system prompt over ACP v1 — zero MCP servers / zero ambient project files)`,
        workspaceContract: contract,
        fullDispatchedPrompt: agentPrompt,
        referenceImages: resolvedRefImages.map(({ path, label, caption }) => ({ path, label, caption })),
        seedData: normalizedSpec === 'guided' ? seedData : null,
        hasDesignDoc: Boolean(normalizedSpec === 'guided' && designDocText),
      };

      const harnessEnvironment = {
        mode: 'agent',
        spec: normalizedSpec,
        harness: normalizedHarness,
        harnessLabel: harnessSpec.label,
        protocol: 'acp-v1',
        acpAdapterPackage: harnessSpec.packageName || null,
        acpAdapterVersion: acpRes.agentInfo?.version || harnessSpec.version || null,
        acpAgentTitle: acpRes.agentInfo?.title || harnessSpec.label,
        acpSource: binInfo.source,
        harnessVersion: acpRes.agentInfo?.version || harnessSpec.version || null,
        systemPromptSource: 'harness-native (set by the vendor agent; not exposed over ACP)',
        selectedModelId: acpRes.selectedModelId || desiredModelId,
        selectedModeId: acpRes.selectedModeId || null,
        modelSelection: acpRes.modelSelection || null,
        isolationFlags: ['acp-v1-stdio', 'mcpServers=[]', 'settingSources=[]'],
        skillsLoaded: 0,
        ambientExtensionsLoaded: 0,
        extensionsLoaded: 0,
        promptTemplatesLoaded: 0,
        themesLoaded: 0,
        contextFilesLoaded: 0,
        mcpServersLoaded: 0,
        enabledTools: ['read', 'bash', 'edit', 'write'],
        secretScrubbed: true,
        cleanRoomVerified: true,
      };

      const meta = {
        modelKey: modelEntry.key,
        modelLabel: modelEntry.label,
        family: modelEntry.family,
        promptId: promptEntry.id,
        category: promptEntry.category,
        mode: 'agent',
        spec: normalizedSpec,
        harness: normalizedHarness,
        harnessLabel: harnessSpec.label,
        track: getTrackForCell(normalizedHarness, 'agent'),
        harnessVersion: acpRes.agentInfo?.version || harnessSpec.version || null,
        protocol: 'acp-v1',
        provider: targetProvider,
        modelId: acpRes.selectedModelId || desiredModelId,
        requestedModelId: desiredModelId,
        modelVerified: acpRes.modelSelection?.verified ?? null,
        via: `${harnessSpec.label} (ACP v1 stdio)`,
        exactPrompt,
        harnessEnvironment,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: acpRes.durationMs,
        ttftMs: acpRes.ttftMs,
        stopReason: acpRes.stopReason,
        exitCode: acpRes.ok ? 0 : 1,
        createdFiles,
        outputChars: (acpRes.assistantText || '').length,
        hasSessionJsonl: existsSync(acpSessionPath),
        hasTranscriptHtml: acpRes.hasTranscriptHtml,
        turnCount: acpRes.trajectory?.turnCount ?? null,
        totalToolCalls: acpRes.trajectory?.totalToolCalls ?? null,
        usage: acpRes.trajectory?.usage || null,
        costUsd: acpRes.trajectory?.usage?.costUsd ?? null,
        error: !acpRes.ok && createdFiles.length === 0 ? (acpRes.error || acpRes.stderrTail || 'ACP session failed').slice(0, 600) : null,
        warning: !acpRes.ok && createdFiles.length > 0 ? (acpRes.error || '').slice(0, 400) : null,
      };
      writeFileSync(join(cellDir, 'generation.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');
      return meta;
    }

    const thinkingLevel = config.generation.thinkingLevel || 'low';

    // --- Vendor agent host driven through a pi provider extension (e.g. muse-msp -> `muse serve`) ---
    let piProvider = route?.provider;
    let piModelId = route?.modelId;
    let piVia = route?.via;
    let extHarness = null;
    if (harnessSpec.protocol === 'pi-extension') {
      extHarness = resolvePiExtensionHarness(normalizedHarness);
      if (!extHarness.entrypoints?.length) {
        onProgress({ stage: 'generating', detail: `Installing ${harnessSpec.extensionPackage} into .acp-runtime/...` });
        try {
          extHarness = installPiExtensionHarness(normalizedHarness);
        } catch (err) {
          extHarness = { ...extHarness, installError: err.message };
        }
      }
      piProvider = harnessSpec.piProvider;
      piModelId =
        modelEntry.routes?.find((r) => r.provider === harnessSpec.provider)?.modelId || route?.modelId || modelEntry.key;
      piVia = `${harnessSpec.label} (pi extension ${harnessSpec.extensionPackage})`;
      if (!extHarness.available) {
        const meta = {
          modelKey: modelEntry.key,
          modelLabel: modelEntry.label,
          family: modelEntry.family,
          promptId: promptEntry.id,
          category: promptEntry.category,
          mode: 'agent',
          spec: normalizedSpec,
          harness: normalizedHarness,
          harnessLabel: harnessSpec.label,
          track: getTrackForCell(normalizedHarness, 'agent'),
          protocol: 'pi-extension',
          provider: piProvider,
          modelId: piModelId,
          via: piVia,
        modelIdResolution: route?.modelIdResolution || null,
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: 0,
          exitCode: 127,
          createdFiles: [],
          outputChars: 0,
          error: `Harness "${normalizedHarness}" is not runnable here: missing ${(extHarness.missing || []).join(' and ')}.${extHarness.installError ? ` ${extHarness.installError.slice(0, 300)}` : ''}`,
        };
        writeFileSync(join(cellDir, 'generation.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');
        return meta;
      }
    }
    if (!piProvider) {
      throw new Error(`Model "${modelEntry.key}" has no authenticated provider route.`);
    }

    const childEnv = await buildPiCliEnv(runtime, extHarness ? harnessSpec.provider : piProvider);
    const activeBridge = extHarness
      ? {
          id: normalizedHarness,
          packageName: harnessSpec.extensionPackage,
          version: extHarness.extensionVersion,
          source: extHarness.source,
          entrypoints: extHarness.entrypoints,
          cliFlags: extHarness.cliFlags,
        }
      : resolveBridgeForProvider(piProvider);
    const piInfo = getPiRuntimeInfo();
    const metaHarness = extHarness ? normalizedHarness : 'pi';
    const metaHarnessLabel = extHarness ? harnessSpec.label : 'Clean-Room pi';
    const metaProtocol = extHarness ? 'pi-extension' : 'pi-cli';
    const metaTrack = getTrackForCell(metaHarness, 'agent');
    const piSystemPrompt = extHarness ? null : await capturePiSystemPrompt(workspaceDir);

    onProgress({
      stage: 'generating',
      detail: `Running clean-room pi agent loop (${piProvider}/${piModelId}, spec=${normalizedSpec}, thinking=${thinkingLevel}${activeBridge ? `, bridge=${activeBridge.id}` : ', 0 skills/extensions'})`,
    });

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
      piProvider,
      '--model',
      piModelId,
      '--',
      ...piFileAttachments,
      agentPrompt,
    ];

    const exactPrompt = {
      mode: 'agent',
      spec: normalizedSpec,
      userPrompt: promptEntry.prompt,
      systemPrompt: extHarness
        ? `(${harnessSpec.agentProduct || harnessSpec.label} native system prompt — owned by the vendor agent host)`
        : piSystemPrompt?.text || '(pi default coding-agent system prompt — zero custom overrides)',
      systemPromptSha256: piSystemPrompt?.sha256 || null,
      systemPromptSource: extHarness
        ? 'harness-native (set by the vendor agent host; not exposed to the benchmark)'
        : piSystemPrompt?.source || 'pi default (text not captured)',
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
        harness: metaHarness,
        harnessLabel: metaHarnessLabel,
        track: metaTrack,
        harnessVersion: extHarness ? extHarness.extensionVersion : piInfo.version || null,
        protocol: metaProtocol,
        provider: piProvider,
        modelId: piModelId,
        via: piVia,
        modelIdResolution: route?.modelIdResolution || null,
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
        // A run that was stopped from outside (shard time budget, runner shutdown) leaves a half-written
        // workspace. That is an incomplete generation, not a site the model chose to hand in.
        cutOff: wasCutOff(res),
        error: wasCutOff(res)
          ? cutOffMessage(res, createdFiles, trajectory)
          : res.code !== 0 && createdFiles.length === 0
            ? (res.stderr || `pi exited ${res.code}`).slice(0, 600)
            : null,
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
        harness: metaHarness,
        harnessLabel: metaHarnessLabel,
        track: metaTrack,
        harnessVersion: extHarness ? extHarness.extensionVersion : piInfo.version || null,
        protocol: metaProtocol,
        provider: piProvider,
        modelId: piModelId,
        via: piVia,
        modelIdResolution: route?.modelIdResolution || null,
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
      harness: 'pi',
      track: 'direct-oneshot',
      harnessLabel: 'Clean-Room pi',
      protocol: 'pi-ai',
      provider: route.provider,
      modelId: route.modelId,
      via: route.via,
      modelIdResolution: route.modelIdResolution || null,
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
      harness: 'pi',
      track: 'direct-oneshot',
      harnessLabel: 'Clean-Room pi',
      protocol: 'pi-ai',
      provider: route.provider,
      modelId: route.modelId,
      via: route.via,
      modelIdResolution: route.modelIdResolution || null,
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
      harness: 'pi',
      track: 'direct-oneshot',
      harnessLabel: 'Clean-Room pi',
      protocol: 'pi-ai',
      provider: route.provider,
      modelId: route.modelId,
      via: route.via,
      modelIdResolution: route.modelIdResolution || null,
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
