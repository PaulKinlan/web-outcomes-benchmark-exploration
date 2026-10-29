import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { PROJECT_ROOT } from '../util/env.mjs';

export const PI_BRIDGES_DIR = join(PROJECT_ROOT, '.pi-bridges');
export const LOCAL_BRIDGES_MANIFEST = join(PI_BRIDGES_DIR, 'bridges.json');
const MODELS_CONFIG_PATH = join(PROJECT_ROOT, 'config', 'models.json');

/**
 * Capability / skill / multi-agent extensions that MUST NEVER be loaded as provider bridges
 * in a clean-room benchmark run.
 */
export const BLOCKED_CAPABILITY_PACKAGES = new Set([
  'pi-autoresearch',
  'pi-subagents',
  'pi-web-access',
  'pi-mcp',
  'pi-browser',
]);

function loadLocalManifest() {
  if (!existsSync(LOCAL_BRIDGES_MANIFEST)) return { bridges: {} };
  try {
    return JSON.parse(readFileSync(LOCAL_BRIDGES_MANIFEST, 'utf8'));
  } catch {
    return { bridges: {} };
  }
}

function saveLocalManifest(manifest) {
  mkdirSync(PI_BRIDGES_DIR, { recursive: true });
  writeFileSync(LOCAL_BRIDGES_MANIFEST, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

export function loadDeclaredBridgeSpecs() {
  let baseSpecs = [];
  if (existsSync(MODELS_CONFIG_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(MODELS_CONFIG_PATH, 'utf8'));
      baseSpecs = Array.isArray(raw.providerBridges) ? raw.providerBridges : [];
    } catch {
      baseSpecs = [];
    }
  }

  const localManifest = loadLocalManifest();
  const byId = new Map(baseSpecs.map((b) => [b.id, { ...b }]));

  for (const [id, override] of Object.entries(localManifest.bridges || {})) {
    const existing = byId.get(id) || {
      id,
      label: override.label || `${id} Provider Bridge`,
      providers: override.providers || [id],
      packageName: override.packageName || `pi-${id}`,
      defaultInstallSpec: null,
      envOverrideVar: `PI_BRIDGE_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`,
      transportOnly: true,
      allowGlobalFallback: false,
      description: override.description || 'Custom clean-room provider transport bridge.',
    };
    byId.set(id, { ...existing, ...override });
  }

  return Array.from(byId.values());
}

/**
 * Extracts explicit `-e <entrypoint>` file path(s) and package version from either
 * a single `.ts`/`.js`/`.mjs` extension file or a `pi` package directory.
 */
export function resolveExtensionTarget(targetPath) {
  if (!targetPath || !existsSync(targetPath)) return null;
  const resolved = resolve(targetPath);
  let st;
  try {
    st = statSync(resolved);
  } catch {
    return null;
  }

  if (st.isFile()) {
    return {
      rootPath: resolved,
      version: 'file',
      packageName: null,
      entrypoints: [resolved],
    };
  }

  if (!st.isDirectory()) return null;

  const pkgPath = join(resolved, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (pkg.name && BLOCKED_CAPABILITY_PACKAGES.has(pkg.name)) {
        return null;
      }
      const rawExts = Array.isArray(pkg.pi?.extensions)
        ? pkg.pi.extensions
        : pkg.main
          ? [pkg.main]
          : [];
      const entrypoints = rawExts
        .map((rel) => resolve(resolved, rel))
        .filter((abs) => existsSync(abs));
      if (entrypoints.length > 0) {
        return {
          rootPath: resolved,
          version: pkg.version || 'unknown',
          packageName: pkg.name || null,
          entrypoints,
        };
      }
    } catch {
      // fall through to conventional index files
    }
  }

  for (const fallbackRel of ['src/index.ts', 'dist/index.js', 'index.ts', 'index.mjs', 'index.js']) {
    const candidate = join(resolved, fallbackRel);
    if (existsSync(candidate)) {
      return {
        rootPath: resolved,
        version: 'local',
        packageName: null,
        entrypoints: [candidate],
      };
    }
  }

  return null;
}

export function resolveBridgeStatus(spec) {
  if (spec.packageName && BLOCKED_CAPABILITY_PACKAGES.has(spec.packageName)) {
    return {
      ...spec,
      installed: false,
      source: 'blocked-capability-package',
      version: null,
      entrypoints: [],
      cliFlags: [],
    };
  }

  const candidateLocations = [];

  if (spec.envOverrideVar && process.env[spec.envOverrideVar]) {
    candidateLocations.push({
      path: process.env[spec.envOverrideVar],
      source: `env (${spec.envOverrideVar})`,
      portable: true,
    });
  }

  if (spec.localPath) {
    candidateLocations.push({
      path: resolve(PROJECT_ROOT, spec.localPath),
      source: 'local-manifest',
      portable: true,
    });
  }

  if (spec.packageName) {
    candidateLocations.push(
      {
        path: join(PI_BRIDGES_DIR, 'node_modules', spec.packageName),
        source: 'local-bridge-store (.pi-bridges)',
        portable: true,
      },
      {
        path: join(PROJECT_ROOT, 'node_modules', spec.packageName),
        source: 'project-node-modules',
        portable: true,
      }
    );

    const allowGlobal =
      spec.transportOnly === true &&
      spec.allowGlobalFallback !== false &&
      process.env.PI_DISABLE_GLOBAL_BRIDGE_FALLBACK !== '1';
    if (allowGlobal) {
      candidateLocations.push({
        path: join(homedir(), '.pi', 'agent', 'npm', 'node_modules', spec.packageName),
        source: 'user-pi-global-fallback',
        portable: false,
      });
    }
  }

  for (const loc of candidateLocations) {
    const resolved = resolveExtensionTarget(loc.path);
    if (resolved && resolved.entrypoints.length > 0) {
      const cliFlags = [];
      for (const ep of resolved.entrypoints) {
        cliFlags.push('-e', ep);
      }
      return {
        ...spec,
        installed: true,
        portable: loc.portable,
        source: loc.source,
        version: resolved.version,
        rootPath: resolved.rootPath,
        entrypoints: resolved.entrypoints,
        cliFlags,
      };
    }
  }

  return {
    ...spec,
    installed: false,
    portable: false,
    source: spec.builtInAuthSupported ? 'builtin-pi-auth' : 'not-installed',
    version: null,
    rootPath: null,
    entrypoints: [],
    cliFlags: [],
  };
}

export function listProviderBridges() {
  return loadDeclaredBridgeSpecs().map(resolveBridgeStatus);
}

export function resolveBridgeForProvider(providerId) {
  if (!providerId) return null;
  const bridges = listProviderBridges();
  return (
    bridges.find(
      (b) => b.installed && Array.isArray(b.providers) && b.providers.includes(providerId)
    ) || null
  );
}

export function getAllInstalledBridgeCliFlags() {
  const seen = new Set();
  const flags = [];
  for (const b of listProviderBridges()) {
    if (!b.installed) continue;
    for (const ep of b.entrypoints) {
      if (seen.has(ep)) continue;
      seen.add(ep);
      flags.push('-e', ep);
    }
  }
  return flags;
}

/**
 * Installs a clean-room provider bridge into `.pi-bridges/` (via npm/git tarball)
 * or registers a local file/directory path in `.pi-bridges/bridges.json`.
 */
export function installProviderBridge(idOrSpec, explicitSource = null) {
  const specs = loadDeclaredBridgeSpecs();
  const known = specs.find((s) => s.id === idOrSpec || s.packageName === idOrSpec);
  const bridgeId = known ? known.id : idOrSpec.replace(/^pi-/, '').replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const sourceSpec = explicitSource || known?.defaultInstallSpec;

  if (!sourceSpec) {
    throw new Error(
      `Bridge "${bridgeId}" does not have a default public package URL. Supply an explicit npm package, git URL, or local path:\n` +
        `  npm run bridges:install -- ${bridgeId} <npm-pkg | git+https://... | ./local/path>`
    );
  }

  if (BLOCKED_CAPABILITY_PACKAGES.has(sourceSpec) || (known?.packageName && BLOCKED_CAPABILITY_PACKAGES.has(known.packageName))) {
    throw new Error(`Refusing to install capability package "${sourceSpec}" into clean-room provider bridges.`);
  }

  mkdirSync(PI_BRIDGES_DIR, { recursive: true });
  const pkgJsonPath = join(PI_BRIDGES_DIR, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    writeFileSync(
      pkgJsonPath,
      JSON.stringify(
        {
          name: 'performance-benchmark-pi-bridges',
          private: true,
          description: 'Isolated clean-room provider transport extensions for pi',
        },
        null,
        2
      ) + '\n',
      'utf8'
    );
  }

  // Local file or directory path registration
  const maybeLocal = resolve(PROJECT_ROOT, sourceSpec);
  if (sourceSpec.startsWith('.') || sourceSpec.startsWith('/') || existsSync(maybeLocal)) {
    const target = resolveExtensionTarget(maybeLocal);
    if (!target) {
      throw new Error(`Local bridge path "${maybeLocal}" has no valid pi extension entrypoint.`);
    }
    const manifest = loadLocalManifest();
    manifest.bridges = manifest.bridges || {};
    manifest.bridges[bridgeId] = {
      ...(manifest.bridges[bridgeId] || {}),
      id: bridgeId,
      localPath: maybeLocal,
      packageName: target.packageName || known?.packageName || null,
      providers: known?.providers || [bridgeId],
      transportOnly: true,
    };
    saveLocalManifest(manifest);
    return resolveBridgeStatus({ ...(known || {}), ...manifest.bridges[bridgeId] });
  }

  // Install via npm into isolated `.pi-bridges/`
  const normalizedNpmSpec = sourceSpec.startsWith('npm:') ? sourceSpec.slice(4) : sourceSpec;
  const res = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['install', '--prefix', PI_BRIDGES_DIR, '--no-audit', '--no-fund', normalizedNpmSpec],
    {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
    }
  );

  if (res.status !== 0) {
    throw new Error(
      `npm install failed for bridge "${bridgeId}" (${normalizedNpmSpec}): ${(res.stderr || res.stdout || '').trim()}`
    );
  }

  // Infer installed package name if custom
  let installedPkgName = known?.packageName || null;
  try {
    const bridgePkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    const deps = Object.keys(bridgePkg.dependencies || {});
    if (!installedPkgName && deps.length > 0) {
      installedPkgName = deps[deps.length - 1];
    }
  } catch {
    // ignore
  }

  const manifest = loadLocalManifest();
  manifest.bridges = manifest.bridges || {};
  manifest.bridges[bridgeId] = {
    ...(manifest.bridges[bridgeId] || {}),
    id: bridgeId,
    packageName: installedPkgName,
    installedSpec: normalizedNpmSpec,
    providers: known?.providers || [bridgeId],
    transportOnly: true,
  };
  saveLocalManifest(manifest);

  const refreshed = loadDeclaredBridgeSpecs().find((s) => s.id === bridgeId);
  return resolveBridgeStatus(refreshed);
}
