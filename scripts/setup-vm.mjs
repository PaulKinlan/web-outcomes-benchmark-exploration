#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  realpathSync,
  chmodSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PROJECT_ROOT } from '../src/util/env.mjs';
import {
  PI_RUNTIME_DIR,
  getPiRuntimeInfo,
  resolvePiBinInfo,
  resetPiLoaderCache,
} from '../src/harness/pi-loader.mjs';
import { installProviderBridge, listProviderBridges } from '../src/harness/provider-bridges.mjs';
import { resolveStableChromePath, PINNED_CHROME_POINTER } from '../src/benchmarks/cdp-helpers.mjs';

function parseArgs(argv) {
  const opts = {
    withChrome: false,
    forcePi: false,
    bridges: [],
  };
  for (const arg of argv.slice(2)) {
    if (arg === '--with-chrome') opts.withChrome = true;
    else if (arg === '--force-pi') opts.forcePi = true;
    else if (arg.startsWith('--bridges=')) {
      opts.bridges = arg
        .slice('--bridges='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return opts;
}

function linkLocalInstalledPiIfPresent(existingBinPath) {
  try {
    const realCli = realpathSync(existingBinPath);
    const codingAgentRoot = resolve(dirname(realCli), '..', '..');
    if (!existsSync(join(codingAgentRoot, 'package.json'))) return false;

    const scopeDir = join(PI_RUNTIME_DIR, 'node_modules', '@earendil-works');
    const binDir = join(PI_RUNTIME_DIR, 'node_modules', '.bin');
    mkdirSync(scopeDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });

    const targetAgent = join(scopeDir, 'pi-coding-agent');
    rmSync(targetAgent, { recursive: true, force: true });
    symlinkSync(codingAgentRoot, targetAgent, 'dir');

    // Link sibling or nested @earendil-works/pi-ai if present on local disk
    const candidateAiDirs = [
      join(codingAgentRoot, 'node_modules', '@earendil-works', 'pi-ai'),
      resolve(codingAgentRoot, '..', 'pi-ai'),
    ];
    for (const aiDir of candidateAiDirs) {
      if (existsSync(join(aiDir, 'package.json'))) {
        const targetAi = join(scopeDir, 'pi-ai');
        rmSync(targetAi, { recursive: true, force: true });
        symlinkSync(aiDir, targetAi, 'dir');
        break;
      }
    }

    const binLink = join(binDir, 'pi');
    rmSync(binLink, { force: true });
    symlinkSync(realCli, binLink);
    try {
      chmodSync(realCli, 0o755);
    } catch {
      // ignore
    }
    return true;
  } catch {
    return false;
  }
}

async function ensurePortablePiRuntime({ forcePi = false } = {}) {
  const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'));
  const rtSpec = pkg.piRuntime || {};
  const codingPkg = rtSpec.package || '@earendil-works/pi-coding-agent';
  const aiPkg = rtSpec.aiPackage || '@earendil-works/pi-ai';
  const version = rtSpec.version || '0.85.1';

  const current = resolvePiBinInfo({ skipCache: true });
  if (!forcePi && current.portable && current.binPath) {
    return getPiRuntimeInfo({ skipCache: true });
  }

  mkdirSync(PI_RUNTIME_DIR, { recursive: true });
  writeFileSync(
    join(PI_RUNTIME_DIR, 'package.json'),
    JSON.stringify(
      {
        name: 'performance-benchmark-pi-runtime',
        private: true,
        description: 'Portable project-local pi coding agent runtime',
      },
      null,
      2
    ) + '\n',
    'utf8'
  );

  console.log(`[setup:vm] Installing portable ${codingPkg}@${version} + ${aiPkg}@${version} into .pi-runtime/...`);
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const installRes = spawnSync(
    npmCmd,
    [
      'install',
      '--prefix',
      PI_RUNTIME_DIR,
      '--no-audit',
      '--no-fund',
      '--save-exact',
      `${codingPkg}@${version}`,
      `${aiPkg}@${version}`,
    ],
    {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
    }
  );

  if (installRes.status !== 0) {
    // If default npm registry mirror does not mirror @earendil-works/*, link already-installed local host package if available
    if (current.binPath && linkLocalInstalledPiIfPresent(current.binPath)) {
      console.log(
        `[setup:vm] Configured npm registry did not serve ${codingPkg}@${version}; linked existing host installation into .pi-runtime/.`
      );
    } else {
      throw new Error(
        `Failed to install ${codingPkg}@${version} via npm:\n${(installRes.stderr || installRes.stdout || '').trim()}`
      );
    }
  }

  resetPiLoaderCache();
  return getPiRuntimeInfo({ skipCache: true });
}

async function ensureChromeForTesting({ forceInstall = false } = {}) {
  const existingChrome = resolveStableChromePath();
  if (!forceInstall && existingChrome) {
    return { chromePath: existingChrome, installedNow: false };
  }

  const browsersMod = await import('@puppeteer/browsers');
  const cacheDir = join(PROJECT_ROOT, '.browsers');
  mkdirSync(cacheDir, { recursive: true });

  const platform = browsersMod.detectBrowserPlatform();
  const buildId = await browsersMod.resolveBuildId(browsersMod.Browser.CHROME, platform, 'stable');
  console.log(`[setup:vm] Downloading pinned Chrome for Testing (${platform} @ ${buildId}) into .browsers/...`);

  const installed = await browsersMod.install({
    browser: browsersMod.Browser.CHROME,
    buildId,
    cacheDir,
  });

  writeFileSync(PINNED_CHROME_POINTER, `${installed.executablePath}\n`, 'utf8');
  return { chromePath: installed.executablePath, buildId, installedNow: true };
}

async function main() {
  const opts = parseArgs(process.argv);

  const piInfo = await ensurePortablePiRuntime({ forcePi: opts.forcePi });
  console.log(`[setup:vm] ✓ pi runtime ready: v${piInfo.version} (${piInfo.source} -> ${piInfo.binPath})`);

  for (const bridgeId of opts.bridges) {
    const b = installProviderBridge(bridgeId);
    console.log(`[setup:vm] ✓ provider bridge "${b.id}" ready (${b.version})`);
  }

  const chromeStatus = await ensureChromeForTesting({ forceInstall: opts.withChrome && !resolveStableChromePath() });
  if (opts.withChrome && !chromeStatus.installedNow && existsSync(PINNED_CHROME_POINTER) === false) {
    // Explicitly requested --with-chrome: install pinned Chrome for Testing into .browsers/ for deterministic CI parity
    const pinned = await ensureChromeForTesting({ forceInstall: true });
    console.log(`[setup:vm] ✓ pinned Chrome for Testing installed: ${pinned.chromePath}`);
  } else if (chromeStatus.chromePath) {
    console.log(`[setup:vm] ✓ Chrome binary ready: ${chromeStatus.chromePath}`);
  } else {
    console.warn(`[setup:vm] ! No Chrome found yet (run \`npm run setup:vm -- --with-chrome\` on Audit VMs).`);
  }

  const bridges = listProviderBridges();
  const activeBridges = bridges.filter((b) => b.installed);
  console.log(
    `[setup:vm] ✓ Clean-room provider bridges active: ${
      activeBridges.length > 0
        ? activeBridges.map((b) => `${b.id}@${b.version}`).join(', ')
        : 'none (built-in pi-ai / API keys only)'
    }`
  );
}

main().catch((err) => {
  console.error(`[setup:vm] Fatal: ${err.message}`);
  process.exit(1);
});
