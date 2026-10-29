import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

let cachedPiAi = null;
let cachedPiBin = undefined;

export function resolvePiBin() {
  if (cachedPiBin !== undefined) return cachedPiBin;
  const candidates = [
    process.env.PI_BIN,
    '/Users/paulkinlan/.local/bin/pi',
    join(dirname(process.execPath), 'pi'),
  ].filter(Boolean);

  for (const c of candidates) {
    if (existsSync(c)) {
      cachedPiBin = c;
      return c;
    }
  }

  try {
    const out = execFileSync('which', ['pi'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (out && existsSync(out)) {
      cachedPiBin = out;
      return out;
    }
  } catch {
    // ignore
  }
  cachedPiBin = null;
  return null;
}

export async function loadPiAi() {
  if (cachedPiAi) return cachedPiAi;

  const searchPaths = [];
  if (process.env.PI_AI_PATH) {
    searchPaths.push(resolve(process.env.PI_AI_PATH));
  }

  // 1. Try standard package resolution if installed locally
  try {
    cachedPiAi = await import('@earendil-works/pi-ai');
    return cachedPiAi;
  } catch {
    // Fallback to global pi installation
  }

  // 2. Locate relative to `pi` binary or node prefix
  const piBin = resolvePiBin();
  if (piBin) {
    try {
      const realPi = realpathSync(piBin);
      // e.g. .../lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js
      const pkgRoot = resolve(dirname(realPi), '..', '..');
      searchPaths.push(join(pkgRoot, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'index.js'));
      searchPaths.push(resolve(pkgRoot, '..', 'pi-ai', 'dist', 'index.js'));
    } catch {
      // ignore
    }
  }

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
    'Unable to locate @earendil-works/pi-ai. Ensure `pi` (@earendil-works/pi-coding-agent) is installed or set PI_AI_PATH.'
  );
}
