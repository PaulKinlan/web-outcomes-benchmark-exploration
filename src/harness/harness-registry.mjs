import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { PROJECT_ROOT } from '../util/env.mjs';

export const HARNESSES_CONFIG_PATH = join(PROJECT_ROOT, 'config', 'harnesses.json');
export const ACP_RUNTIME_DIR = join(PROJECT_ROOT, '.acp-runtime');

const HARNESS_ALIASES = {
  pi: 'pi',
  default: 'pi',
  cleanroom: 'pi',
  'clean-room': 'pi',
  'claude-acp': 'claude-acp',
  'claude-code-acp': 'claude-acp',
  'claude-code': 'claude-acp',
  claude: 'claude-acp',
  'codex-acp': 'codex-acp',
  codex: 'codex-acp',
  'gemini-acp': 'gemini-acp',
  'gemini-cli': 'gemini-acp',
  'qwen-acp': 'qwen-acp',
  'qwen-code': 'qwen-acp',
  'kimi-acp': 'kimi-acp',
  'kimi-cli': 'kimi-acp',
  'muse-msp': 'muse-msp',
  'muse-cli': 'muse-msp',
};

/** Selection groups accepted by `--harness=` / the workflow `harness` input. */
function harnessGroup(name) {
  const all = (loadHarnessesConfig().harnesses || []).map((h) => h);
  if (name === 'all') return all.map((h) => h.id);
  if (name === 'acp') return all.filter((h) => h.protocol === 'acp').map((h) => h.id);
  if (name === 'vendor' || name === 'harnesses') return all.filter((h) => h.id !== 'pi').map((h) => h.id);
  return null;
}

/**
 * A cell's track: `direct-oneshot` (bare model API call), `direct-agent` (thin clean-room pi tool loop),
 * or `harness:<id>` (the model inside a vendor's own coding agent with its native system prompt and tools).
 */
export function getTrackForCell(harnessId, mode) {
  const id = normalizeHarnessId(harnessId);
  if (id === 'pi') return mode === 'oneshot' ? 'direct-oneshot' : 'direct-agent';
  return `harness:${id}`;
}

export function describeTrack(track) {
  if (track === 'direct-oneshot') return { track, kind: 'direct', label: 'Direct · one-shot' };
  if (track === 'direct-agent') return { track, kind: 'direct', label: 'Direct · agent (clean-room pi)' };
  const id = String(track || '').replace(/^harness:/, '');
  const spec = getHarnessSpec(id);
  return { track, kind: 'vendor-harness', label: spec?.agentProduct || spec?.label || id, vendor: spec?.vendor || null };
}

export function loadHarnessesConfig() {
  if (!existsSync(HARNESSES_CONFIG_PATH)) {
    return {
      version: '1.0.0',
      defaultHarness: 'pi',
      harnesses: [
        {
          id: 'pi',
          label: 'Clean-Room pi',
          shortLabel: 'pi',
          protocol: 'pi',
          supportsModes: ['agent', 'oneshot'],
          compatibleFamilies: ['*'],
        },
      ],
    };
  }
  return JSON.parse(readFileSync(HARNESSES_CONFIG_PATH, 'utf8'));
}

export function normalizeHarnessId(raw) {
  const clean = String(raw || 'pi').trim().toLowerCase();
  if (!clean) return 'pi';
  if (HARNESS_ALIASES[clean]) return HARNESS_ALIASES[clean];
  // Support custom ACP binary spec via custom-acp if configured
  if (clean === 'custom-acp' && process.env.ACP_CUSTOM_BIN) return 'custom-acp';
  return clean;
}

/**
 * Expands a CLI/workflow `--harness=...` string (`pi`, `claude-acp`, `codex-acp`, `acp`, `all`, or comma-separated)
 * into a canonical deduplicated array of harness IDs.
 */
export function expandHarnessSelection(raw) {
  const input = String(raw || 'pi').trim().toLowerCase();
  if (!input) return ['pi'];
  const out = [];
  for (const p of input.split(',').map((x) => x.trim()).filter(Boolean)) {
    const ids = harnessGroup(p) || [normalizeHarnessId(p)];
    for (const id of ids) if (!out.includes(id)) out.push(id);
  }
  return out.length > 0 ? out : ['pi'];
}

export function getHarnessSpec(harnessId) {
  const norm = normalizeHarnessId(harnessId);
  const cfg = loadHarnessesConfig();
  const found = (cfg.harnesses || []).find((h) => h.id === norm);
  if (found) return found;
  if (norm === 'custom-acp' && process.env.ACP_CUSTOM_BIN) {
    return {
      id: 'custom-acp',
      label: process.env.ACP_CUSTOM_LABEL || 'Custom ACP Agent',
      shortLabel: 'custom-acp',
      protocol: 'acp',
      binName: process.env.ACP_CUSTOM_BIN,
      envOverrideVar: 'ACP_CUSTOM_BIN',
      provider: process.env.ACP_CUSTOM_PROVIDER || 'openai',
      compatibleFamilies: ['*'],
      supportsModes: ['agent'],
      preferredModeIds: ['bypassPermissions', 'acceptEdits', 'full-auto', 'default'],
      sessionMeta: {},
    };
  }
  return null;
}

export function isModelCompatibleWithHarness(modelEntry, harnessId) {
  const spec = getHarnessSpec(harnessId);
  if (!spec) return false;
  if (spec.id === 'pi' || (spec.compatibleFamilies || []).includes('*')) return true;

  const family = String(modelEntry?.family || '');
  if ((spec.compatibleFamilies || []).includes(family)) return true;
  // Vendor harnesses only run their own vendor's models: a Gemini model served through OpenRouter is still
  // not something Claude Code can drive.
  if (spec.track === 'vendor-harness' && !['anthropic', 'openai'].includes(spec.provider)) return false;

  const routes = Array.isArray(modelEntry?.routes) ? modelEntry.routes : [];
  if (spec.provider === 'anthropic') {
    return routes.some((r) => r.provider === 'anthropic' || r.provider === 'claude-bridge');
  }
  if (spec.provider === 'openai') {
    return routes.some((r) => r.provider === 'openai' || r.provider === 'openai-codex');
  }
  return routes.some((r) => r.provider === spec.provider);
}

export function resolveAcpHarnessBinInfo(harnessId) {
  const spec = getHarnessSpec(harnessId);
  if (!spec || spec.protocol !== 'acp') {
    return { harnessId, available: false, binPath: null, source: 'not-acp', spec };
  }

  if (spec.envOverrideVar && process.env[spec.envOverrideVar]) {
    const rawOverride = process.env[spec.envOverrideVar].trim();
    const absOverride = resolve(rawOverride);
    if (existsSync(absOverride)) {
      return { harnessId: spec.id, available: true, binPath: absOverride, source: 'env-override', spec };
    }
  }

  const isWin = process.platform === 'win32';
  const binFile = isWin ? `${spec.binName}.cmd` : spec.binName;
  const candidates = [
    { path: join(ACP_RUNTIME_DIR, 'node_modules', '.bin', binFile), source: 'local-acp-runtime' },
    { path: join(ACP_RUNTIME_DIR, 'py', 'bin', spec.binName), source: 'local-acp-runtime (python venv)' },
    { path: join(PROJECT_ROOT, 'node_modules', '.bin', binFile), source: 'local-npm' },
    { path: join(homedir(), '.local', 'bin', spec.binName), source: 'global-path' },
    { path: join(dirname(process.execPath), spec.binName), source: 'node-prefix' },
  ];

  for (const c of candidates) {
    if (existsSync(c.path)) {
      return { harnessId: spec.id, available: true, binPath: c.path, source: c.source, spec };
    }
  }

  try {
    const whichCmd = isWin ? 'where' : 'which';
    const out = execFileSync(whichCmd, [spec.binName], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\r?\n/)[0]
      ?.trim();
    if (out && existsSync(out)) {
      return { harnessId: spec.id, available: true, binPath: out, source: 'global-path', spec };
    }
  } catch {
    // ignore
  }

  return { harnessId: spec.id, available: false, binPath: null, source: 'missing', spec };
}

/**
 * Installs an ACP adapter package (`@zed-industries/claude-code-acp` or `@zed-industries/codex-acp`)
 * into the gitignored portable `.acp-runtime/` directory.
 */
export function installAcpHarnessAdapter(harnessId, { force = false } = {}) {
  const current = resolveAcpHarnessBinInfo(harnessId);
  if (!force && current.available && current.binPath) {
    return current;
  }

  const spec = current.spec;
  if (!spec || spec.protocol !== 'acp' || !spec.packageName) {
    throw new Error(`Unknown or non-installable ACP harness: ${harnessId}`);
  }

  mkdirSync(ACP_RUNTIME_DIR, { recursive: true });

  if (spec.installer === 'pip') {
    const venvDir = join(ACP_RUNTIME_DIR, 'py');
    const pySpec = spec.version ? `${spec.packageName}==${spec.version}` : spec.packageName;
    const pythons = [process.env.ACP_PYTHON, 'python3.13', 'python3.12', 'python3'].filter(Boolean);
    let pipErr = '';
    for (const py of pythons) {
      const venv = spawnSync(py, ['-m', 'venv', venvDir], { encoding: 'utf8', stdio: 'pipe', timeout: 120000 });
      if (venv.status !== 0) {
        pipErr = (venv.stderr || venv.error?.message || '').trim();
        continue;
      }
      const pip = spawnSync(join(venvDir, 'bin', 'pip'), ['install', '--quiet', '--disable-pip-version-check', pySpec], {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 300000,
      });
      if (pip.status === 0) {
        const updated = resolveAcpHarnessBinInfo(harnessId);
        if (updated.available) return updated;
      }
      pipErr = (pip.stderr || pip.stdout || '').trim();
    }
    throw new Error(
      `Failed to install ACP adapter ${pySpec} into .acp-runtime/py (needs Python >= ${spec.minPython || '3.10'}):\n${pipErr.slice(-600)}`
    );
  }

  const pkgJsonPath = join(ACP_RUNTIME_DIR, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    writeFileSync(
      pkgJsonPath,
      JSON.stringify(
        {
          name: 'performance-benchmark-acp-runtime',
          private: true,
          description: 'Portable Agent Client Protocol (ACP) adapter runtime',
        },
        null,
        2
      ) + '\n',
      'utf8'
    );
  }

  const pkgSpec = spec.version ? `${spec.packageName}@${spec.version}` : spec.packageName;
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  // Try public npm registry first (needed when a local corporate .npmrc lacks 3P ACP packages), then default npm config
  const registries = ['https://registry.npmjs.org', null];
  let lastErr = '';

  for (const reg of registries) {
    const args = [
      'install',
      '--prefix',
      ACP_RUNTIME_DIR,
      '--no-audit',
      '--no-fund',
      '--save-exact',
      ...(reg ? [`--registry=${reg}`] : []),
      pkgSpec,
    ];
    const res = spawnSync(npmCmd, args, {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 180000,
    });
    if (res.status === 0) {
      const updated = resolveAcpHarnessBinInfo(harnessId);
      if (updated.available) return updated;
    }
    lastErr = (res.stderr || res.stdout || '').trim();
  }

  throw new Error(`Failed to install ACP adapter ${pkgSpec} into .acp-runtime/:\n${lastErr.slice(-600)}`);
}

export function listAllHarnessStatuses() {
  const cfg = loadHarnessesConfig();
  return (cfg.harnesses || []).map((h) => {
    if (h.protocol === 'pi-extension') {
      const ext = resolvePiExtensionHarness(h.id);
      return { ...h, available: ext.available, source: ext.source, binPath: ext.binaryPath, missing: ext.missing };
    }
    if (h.protocol === 'pi') {
      return {
        ...h,
        available: true,
        source: 'pi-runtime',
        binPath: null,
      };
    }
    const info = resolveAcpHarnessBinInfo(h.id);
    return {
      ...h,
      available: info.available,
      source: info.source,
      binPath: info.binPath,
    };
  });
}

function whichBinary(name) {
  if (!name) return null;
  if (name.includes('/') || name.includes('\\')) return existsSync(name) ? resolve(name) : null;
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\r?\n/)[0]
      ?.trim();
    return out && existsSync(out) ? out : null;
  } catch {
    return null;
  }
}

/**
 * Resolves a `pi-extension` harness (e.g. `muse-msp`): a vendor agent host that pi drives through a provider
 * extension. Needs both the extension package (in `.acp-runtime/`) and the vendor's own CLI binary.
 */
export function resolvePiExtensionHarness(harnessId) {
  const spec = getHarnessSpec(harnessId);
  if (!spec || spec.protocol !== 'pi-extension') {
    return { harnessId, available: false, source: 'not-pi-extension', spec, missing: ['spec'] };
  }
  const pkgDir = join(ACP_RUNTIME_DIR, 'node_modules', spec.extensionPackage);
  let entrypoints = [];
  let version = null;
  try {
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    version = pkg.version || null;
    for (const rel of pkg.pi?.extensions || []) {
      const abs = resolve(pkgDir, rel);
      if (!existsSync(abs)) continue;
      if (statSync(abs).isDirectory()) {
        for (const f of readdirSync(abs)) {
          if (/\.(ts|mjs|js)$/.test(f)) entrypoints.push(join(abs, f));
        }
      } else {
        entrypoints.push(abs);
      }
    }
  } catch {
    entrypoints = [];
  }
  const binaryName = (spec.binaryEnvVar && process.env[spec.binaryEnvVar]) || spec.requiresBinary;
  const binaryPath = whichBinary(binaryName);
  const missing = [];
  if (entrypoints.length === 0) missing.push(`extension package ${spec.extensionPackage}`);
  if (spec.requiresBinary && !binaryPath) missing.push(`\`${spec.requiresBinary}\` CLI on PATH (or ${spec.binaryEnvVar})`);
  return {
    harnessId: spec.id,
    spec,
    available: missing.length === 0,
    source: missing.length === 0 ? 'local-acp-runtime' : 'missing',
    missing,
    entrypoints,
    extensionVersion: version,
    binaryPath,
    cliFlags: entrypoints.flatMap((ep) => ['-e', ep]),
  };
}

export function installPiExtensionHarness(harnessId) {
  const spec = getHarnessSpec(harnessId);
  if (!spec || spec.protocol !== 'pi-extension') throw new Error(`Not a pi-extension harness: ${harnessId}`);
  mkdirSync(ACP_RUNTIME_DIR, { recursive: true });
  const pkgSpec = spec.version ? `${spec.extensionPackage}@${spec.version}` : spec.extensionPackage;
  const res = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['install', '--prefix', ACP_RUNTIME_DIR, '--no-audit', '--no-fund', '--save-exact', '--legacy-peer-deps', '--registry=https://registry.npmjs.org', pkgSpec],
    { cwd: PROJECT_ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 180000 }
  );
  if (res.status !== 0) {
    throw new Error(`Failed to install ${pkgSpec} into .acp-runtime/:\n${(res.stderr || res.stdout || '').trim().slice(-600)}`);
  }
  return resolvePiExtensionHarness(harnessId);
}
