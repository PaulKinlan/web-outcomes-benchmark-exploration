import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
};

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
  if (!input || input === 'pi') return ['pi'];
  if (input === 'all') return ['pi', 'claude-acp', 'codex-acp'];
  if (input === 'acp') return ['claude-acp', 'codex-acp'];

  const parts = input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const out = [];
  for (const p of parts) {
    if (p === 'all') {
      for (const h of ['pi', 'claude-acp', 'codex-acp']) {
        if (!out.includes(h)) out.push(h);
      }
    } else if (p === 'acp') {
      for (const h of ['claude-acp', 'codex-acp']) {
        if (!out.includes(h)) out.push(h);
      }
    } else {
      const norm = normalizeHarnessId(p);
      if (!out.includes(norm)) out.push(norm);
    }
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
