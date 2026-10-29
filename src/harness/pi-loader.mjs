import { existsSync, realpathSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { PROJECT_ROOT } from '../util/env.mjs';

export const PI_RUNTIME_DIR = join(PROJECT_ROOT, '.pi-runtime');

let cachedPiAi = null;
let cachedPiInfo = undefined;

export function resetPiLoaderCache() {
  cachedPiAi = null;
  cachedPiInfo = undefined;
}

function readDeclaredPiRuntimeSpec() {
  try {
    const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'));
    const rt = pkg.piRuntime || {};
    return {
      package: rt.package || '@earendil-works/pi-coding-agent',
      aiPackage: rt.aiPackage || '@earendil-works/pi-ai',
      version: rt.version || '0.85.1',
      chromeChannel: rt.chromeChannel || 'stable',
    };
  } catch {
    return {
      package: '@earendil-works/pi-coding-agent',
      aiPackage: '@earendil-works/pi-ai',
      version: '0.85.1',
      chromeChannel: 'stable',
    };
  }
}

export function resolvePiBinInfo({ skipCache = false } = {}) {
  if (!skipCache && cachedPiInfo !== undefined) return cachedPiInfo;

  const spec = readDeclaredPiRuntimeSpec();
  const candidates = [
    process.env.PI_BIN
      ? { path: resolve(process.env.PI_BIN), source: 'env-override', portable: true }
      : null,
    {
      path: join(PROJECT_ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'pi.cmd' : 'pi'),
      source: 'local-npm',
      portable: true,
    },
    {
      path: join(PROJECT_ROOT, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js'),
      source: 'local-npm',
      portable: true,
    },
    {
      path: join(PI_RUNTIME_DIR, 'node_modules', '.bin', process.platform === 'win32' ? 'pi.cmd' : 'pi'),
      source: 'local-npm-runtime',
      portable: true,
    },
    {
      path: join(PI_RUNTIME_DIR, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js'),
      source: 'local-npm-runtime',
      portable: true,
    },
    {
      path: join(homedir(), '.local', 'bin', 'pi'),
      source: 'global-fallback',
      portable: false,
    },
    {
      path: join(dirname(process.execPath), 'pi'),
      source: 'global-fallback',
      portable: false,
    },
  ].filter(Boolean);

  for (const c of candidates) {
    if (existsSync(c.path)) {
      cachedPiInfo = {
        binPath: c.path,
        source: c.source,
        portable: c.portable,
        declaredSpec: spec,
      };
      return cachedPiInfo;
    }
  }

  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, ['pi'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\r?\n/)[0]
      ?.trim();
    if (out && existsSync(out)) {
      cachedPiInfo = {
        binPath: out,
        source: 'global-fallback',
        portable: false,
        declaredSpec: spec,
      };
      return cachedPiInfo;
    }
  } catch {
    // ignore
  }

  cachedPiInfo = {
    binPath: null,
    source: 'missing',
    portable: false,
    declaredSpec: spec,
  };
  return cachedPiInfo;
}

export function resolvePiBin(opts) {
  return resolvePiBinInfo(opts).binPath;
}

export function getPiRuntimeInfo({ skipCache = false } = {}) {
  const info = resolvePiBinInfo({ skipCache });
  let version = 'unavailable';
  if (info.binPath) {
    try {
      version = execFileSync(info.binPath, ['--version'], {
        encoding: 'utf8',
        timeout: 4000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      version = 'unknown';
    }
  }
  return {
    ...info,
    version,
  };
}

export async function loadPiAi() {
  if (cachedPiAi) return cachedPiAi;

  const searchPaths = [];
  if (process.env.PI_AI_PATH) {
    searchPaths.push(resolve(process.env.PI_AI_PATH));
  }

  // 1. Try direct project node_modules resolution if installed directly
  try {
    cachedPiAi = await import('@earendil-works/pi-ai');
    return cachedPiAi;
  } catch {
    // Check portable .pi-runtime and fallback paths next
  }

  // 2. Check portable .pi-runtime directory installed by `npm run setup:vm`
  searchPaths.push(
    join(PI_RUNTIME_DIR, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'index.js'),
    join(
      PI_RUNTIME_DIR,
      'node_modules',
      '@earendil-works',
      'pi-coding-agent',
      'node_modules',
      '@earendil-works',
      'pi-ai',
      'dist',
      'index.js'
    )
  );

  // 3. Locate relative to resolved `pi` binary
  const piBin = resolvePiBin();
  if (piBin) {
    try {
      const realPi = realpathSync(piBin);
      const pkgRoot = resolve(dirname(realPi), '..', '..');
      searchPaths.push(join(pkgRoot, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'index.js'));
      searchPaths.push(resolve(pkgRoot, '..', 'pi-ai', 'dist', 'index.js'));
    } catch {
      // ignore
    }
  }

  // 4. Node prefix global fallback
  const nodePrefixLib = resolve(dirname(process.execPath), '..', 'lib', 'node_modules');
  searchPaths.push(
    join(nodePrefixLib, '@earendil-works', 'pi-coding-agent', 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'index.js'),
    join(nodePrefixLib, '@earendil-works', 'pi-ai', 'dist', 'index.js')
  );

  for (const candidate of searchPaths) {
    if (existsSync(candidate)) {
      const indexMod = await import(pathToFileURL(candidate).href);
      const allProvidersPath = join(dirname(candidate), 'providers', 'all.js');
      const allMod = existsSync(allProvidersPath)
        ? await import(pathToFileURL(allProvidersPath).href)
        : {};
      cachedPiAi = { ...indexMod, ...allMod };
      return cachedPiAi;
    }
  }

  throw new Error(
    'Unable to locate @earendil-works/pi-ai. Run `npm run setup:vm` to bootstrap the portable pi runtime into `.pi-runtime/`, or set PI_AI_PATH.'
  );
}
