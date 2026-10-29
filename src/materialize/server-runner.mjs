import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { materializeSite } from './build-site.mjs';
import { serveStaticDirectory } from './serve-site.mjs';
import { sleep } from '../util/env.mjs';

const execFileAsync = promisify(execFile);

const SKIP_SIZE_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'target']);

const SERVER_SECRET_ENV_RE =
  /(?:_API_KEY|_SECRET|_TOKEN|_PASSWORD|^PI_AUTH_JSON_B64$|^PI_CODING_AGENT_DIR$|^GITHUB_TOKEN$|^GH_TOKEN$|^GOOGLE_APPLICATION_CREDENTIALS$|^AWS_)/i;

/**
 * Scrubs all LLM API keys, OAuth tokens, and CI secrets before spawning untrusted
 * model-generated build scripts or `$PORT` servers during materialization, auditing, or preview.
 */
export function buildSanitizedServerEnv(extraEnv = {}, baseEnv = process.env) {
  const sanitized = {};
  for (const [k, v] of Object.entries(baseEnv || {})) {
    if (v === undefined) continue;
    if (SERVER_SECRET_ENV_RE.test(k)) continue;
    sanitized[k] = v;
  }
  return {
    ...sanitized,
    ...extraEnv,
  };
}

function workspaceByteSize(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const name of readdirSync(dir)) {
    if (SKIP_SIZE_DIRS.has(name)) continue;
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (st.isDirectory()) total += workspaceByteSize(full);
      else total += st.size;
    } catch {
      // ignore
    }
  }
  return total;
}

export function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function killProcessGroup(pid) {
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
  await sleep(220);
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

async function sampleProcessGroupRssMb(pgid) {
  if (!pgid) return 0;
  try {
    const { stdout } = await execFileAsync('ps', ['-ax', '-o', 'pid=,pgid=,rss='], { timeout: 4000 });
    let totalKb = 0;
    for (const line of stdout.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;
      const pid = Number(parts[0]);
      const group = Number(parts[1]);
      const rssKb = Number(parts[2]);
      if ((pid === pgid || group === pgid) && !Number.isNaN(rssKb)) {
        totalKb += rssKb;
      }
    }
    return Math.round((totalKb / 1024) * 100) / 100;
  } catch {
    return 0;
  }
}

/**
 * Inspects an `agent-workspace` directory for `.bench-runtime.json`, `start.sh`,
 * or common server entrypoints without biasing stack choice.
 */
export function resolveRuntimeContract(workspaceDir) {
  if (!existsSync(workspaceDir)) return null;

  const manifestPath = join(workspaceDir, '.bench-runtime.json');
  if (existsSync(manifestPath)) {
    try {
      const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (raw && typeof raw.startCommand === 'string' && raw.startCommand.trim()) {
        return {
          buildCommand: typeof raw.buildCommand === 'string' ? raw.buildCommand.trim() : '',
          startCommand: raw.startCommand.trim(),
          healthPath: typeof raw.healthPath === 'string' && raw.healthPath.startsWith('/') ? raw.healthPath : '/',
          contractCompliance: true,
        };
      }
    } catch {
      // fall through to auto-discovery
    }
  }

  if (existsSync(join(workspaceDir, 'start.sh'))) {
    return {
      buildCommand: '',
      startCommand: 'sh ./start.sh',
      healthPath: '/',
      contractCompliance: true,
    };
  }

  const pkgPath = join(workspaceDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const scripts = pkg.scripts || {};
      if (scripts.start) {
        let startCmd = 'npm start';
        if (scripts.start.includes('vite preview') && !scripts.start.includes('--port')) {
          startCmd = 'npx vite preview --host 127.0.0.1 --port $PORT';
        }
        return {
          buildCommand: scripts.build ? 'npm run build' : '',
          startCommand: startCmd,
          healthPath: '/',
          contractCompliance: false,
        };
      }
    } catch {
      // ignore
    }
  }

  for (const nodeEntry of ['server.mjs', 'server.js', 'app.mjs', 'app.js', 'src/server.mjs', 'src/server.js', 'index.js']) {
    if (existsSync(join(workspaceDir, nodeEntry))) {
      return {
        buildCommand: '',
        startCommand: `node ${nodeEntry}`,
        healthPath: '/',
        contractCompliance: false,
      };
    }
  }

  for (const pyEntry of ['app.py', 'main.py', 'server.py']) {
    if (existsSync(join(workspaceDir, pyEntry))) {
      return {
        buildCommand: '',
        startCommand: `python3 ${pyEntry}`,
        healthPath: '/',
        contractCompliance: false,
      };
    }
  }

  if (existsSync(join(workspaceDir, 'go.mod')) && existsSync(join(workspaceDir, 'main.go'))) {
    return {
      buildCommand: 'go build -o ./bench-app .',
      startCommand: './bench-app',
      healthPath: '/',
      contractCompliance: false,
    };
  }

  return null;
}

function runShellCommand(command, cwd, timeoutMs = 150000) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildSanitizedServerEnv({ CI: 'true', NODE_ENV: 'production' }),
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(async () => {
      await killProcessGroup(child.pid);
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`));
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    child.on('error', async (err) => {
      clearTimeout(timer);
      await killProcessGroup(child.pid);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Build failed (exit ${code}): ${(stderr || stdout).slice(-400)}`));
    });
  });
}

function rawHttpGet(targetUrl, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const req = http.get(
      targetUrl,
      {
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'Accept-Encoding': 'br, gzip, deflate',
          'Connection': 'close',
        },
        timeout: timeoutMs,
      },
      (res) => {
        const ttfbMs = Math.round((performance.now() - started) * 10) / 10;
        const chunks = [];
        let totalLen = 0;
        res.on('data', (c) => {
          if (totalLen < 1024 * 1024) {
            chunks.push(c);
            totalLen += c.length;
          }
        });
        res.on('end', () => {
          const totalMs = Math.round((performance.now() - started) * 10) / 10;
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers || {},
            ttfbMs,
            totalMs,
            rawBodyBuffer: Buffer.concat(chunks),
            wireBytes: totalLen,
          });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('HTTP timeout'));
    });
    req.on('error', reject);
  });
}

/**
 * Materializes a cell into either a runnable PaaS production server (`agent-workspace`)
 * or a static/synthesized site (`dist/`), and verifies it actually boots & responds on HTTP!
 */
export async function prepareCellRuntime({ cellDir, extraction, forceBuild = false, onProgress = () => {} }) {
  const agentWorkspaceDir = join(cellDir, 'agent-workspace');
  const extractedDir = join(cellDir, 'extracted');
  const hasAgentWorkspace = existsSync(agentWorkspaceDir);

  let runtimeDirRel = null;
  let workspaceDir = null;
  let contract = null;

  if (hasAgentWorkspace) {
    runtimeDirRel = 'agent-workspace';
    workspaceDir = agentWorkspaceDir;
    contract = resolveRuntimeContract(agentWorkspaceDir);
  } else if (extraction?.outputShape === 'fullstack-workspace' && existsSync(extractedDir)) {
    runtimeDirRel = 'extracted';
    workspaceDir = extractedDir;
    contract = resolveRuntimeContract(extractedDir);
  }

  if (contract && workspaceDir) {
    const t0 = performance.now();
    let buildError = null;

    try {
      // Install npm dependencies only if package.json exists and node_modules is missing
      if (existsSync(join(workspaceDir, 'package.json')) && !existsSync(join(workspaceDir, 'node_modules'))) {
        onProgress({ stage: 'materializing', detail: 'Installing workspace dependencies' });
        await runShellCommand('npm install --no-audit --no-fund --legacy-peer-deps', workspaceDir, 150000);
      }

      if (contract.buildCommand && forceBuild) {
        onProgress({ stage: 'materializing', detail: `Running production build: ${contract.buildCommand}` });
        await runShellCommand(contract.buildCommand, workspaceDir, 150000);
      }

      // Smoke-boot the production server once to verify it binds $PORT and returns <500!
      onProgress({ stage: 'materializing', detail: `Verifying production server start (${contract.startCommand})` });
      let probeSrv = null;
      try {
        probeSrv = await bootProductionWorkspaceServer({ workspaceDir, contract, timeoutMs: 25000 });
      } catch (firstBootErr) {
        // If agent didn't run buildCommand yet, run buildCommand now and retry boot once
        if (contract.buildCommand && !forceBuild) {
          onProgress({ stage: 'materializing', detail: `Running build (${contract.buildCommand}) and retrying server boot` });
          await runShellCommand(contract.buildCommand, workspaceDir, 150000);
          probeSrv = await bootProductionWorkspaceServer({ workspaceDir, contract, timeoutMs: 25000 });
        } else {
          throw firstBootErr;
        }
      }
      const verifiedColdBootMs = probeSrv.coldBootMs;
      await probeSrv.close();

      let installedPackages = [];
      if (existsSync(join(workspaceDir, 'package.json'))) {
        try {
          const pkg = JSON.parse(readFileSync(join(workspaceDir, 'package.json'), 'utf8'));
          installedPackages = [
            ...Object.keys(pkg.dependencies || {}),
            ...Object.keys(pkg.devDependencies || {}),
          ];
        } catch {
          // ignore
        }
      }

      const result = {
        ok: true,
        outputShape: extraction.outputShape || 'fullstack-workspace',
        serverArchitecture: 'production-server',
        runtimeDirRel,
        materializeTier: contract.contractCompliance ? 'paas-runtime-contract' : 'inferred-server-runtime',
        contractCompliance: contract.contractCompliance,
        buildCommand: contract.buildCommand,
        startCommand: contract.startCommand,
        healthPath: contract.healthPath,
        verifiedColdBootMs,
        runnableWithoutBuildStep: !contract.buildCommand,
        synthesizedWrapper: false,
        installedPackages,
        buildDurationMs: Math.round(performance.now() - t0),
        distBytes: workspaceByteSize(workspaceDir),
        error: null,
      };
      writeFileSync(join(cellDir, 'materialization.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
      return result;
    } catch (err) {
      buildError = err.message || String(err);
      onProgress({
        stage: 'materializing',
        detail: `Production server failed (${buildError.slice(0, 90)}); checking static fallback`,
      });
    }

    // If workspace had no working server and also no static fallback, record failure cleanly
    const staticFallback = await materializeSite({ cellDir, extraction, onProgress });
    if (staticFallback.ok) {
      const merged = {
        ...staticFallback,
        serverArchitecture: 'static-harness',
        contractCompliance: false,
        serverFallbackReason: buildError,
      };
      writeFileSync(join(cellDir, 'materialization.json'), JSON.stringify(merged, null, 2) + '\n', 'utf8');
      return merged;
    }

    const failed = {
      ok: false,
      outputShape: extraction.outputShape || 'fullstack-workspace',
      serverArchitecture: 'failed',
      materializeTier: 'failed',
      contractCompliance: contract.contractCompliance,
      buildCommand: contract.buildCommand,
      startCommand: contract.startCommand,
      runnableWithoutBuildStep: false,
      synthesizedWrapper: false,
      installedPackages: [],
      buildDurationMs: Math.round(performance.now() - t0),
      distBytes: 0,
      error: buildError,
    };
    writeFileSync(join(cellDir, 'materialization.json'), JSON.stringify(failed, null, 2) + '\n', 'utf8');
    return failed;
  }

  // Static / 1-shot path
  const mat = await materializeSite({ cellDir, extraction, onProgress });
  const enriched = {
    ...mat,
    serverArchitecture: mat.ok ? 'static-harness' : 'failed',
    contractCompliance: null,
  };
  writeFileSync(join(cellDir, 'materialization.json'), JSON.stringify(enriched, null, 2) + '\n', 'utf8');
  return enriched;
}

async function bootProductionWorkspaceServer({ workspaceDir, contract, timeoutMs = 25000 }) {
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const healthUrl = `${baseUrl}${contract.healthPath || '/'}`;

  const t0 = performance.now();
  let stderrTail = '';
  let exitedEarly = false;
  let exitCode = null;

  const child = spawn('/bin/sh', ['-c', contract.startCommand], {
    cwd: workspaceDir,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: buildSanitizedServerEnv({
      PORT: String(port),
      HOST: '127.0.0.1',
      HOSTNAME: '127.0.0.1',
      NODE_ENV: 'production',
    }),
  });

  child.stderr.on('data', (d) => {
    stderrTail = (stderrTail + d.toString('utf8')).slice(-800);
  });
  child.stdout.on('data', (d) => {
    stderrTail = (stderrTail + d.toString('utf8')).slice(-800);
  });
  child.on('exit', (code) => {
    exitedEarly = true;
    exitCode = code;
  });

  const deadline = Date.now() + timeoutMs;
  let booted = false;
  let coldBootMs = 0;

  while (Date.now() < deadline) {
    if (exitedEarly) {
      await killProcessGroup(child.pid);
      throw new Error(
        `Server exited prematurely (code ${exitCode}) running "${contract.startCommand}": ${stderrTail.trim()}`
      );
    }
    try {
      const res = await rawHttpGet(healthUrl, 1200);
      if (res.statusCode >= 200 && res.statusCode < 400) {
        booted = true;
        coldBootMs = Math.round(performance.now() - t0);
        break;
      }
      stderrTail = `HTTP ${res.statusCode} on ${contract.healthPath || '/'}`;
    } catch {
      // still booting
    }
    await sleep(60);
  }

  if (!booted) {
    await killProcessGroup(child.pid);
    throw new Error(
      `Server did not respond on PORT=${port} within ${timeoutMs}ms ("${contract.startCommand}"): ${stderrTail.trim()}`
    );
  }

  return {
    url: baseUrl,
    port,
    pid: child.pid,
    coldBootMs,
    serverArchitecture: 'production-server',
    sampleRssMb: () => sampleProcessGroupRssMb(child.pid),
    close: () => killProcessGroup(child.pid),
  };
}

/**
 * Starts the runnable server for any materialized cell (`production-server` or `static-harness`).
 */
export async function startCellServer({ cellDir, materialization, timeoutMs = 25000 }) {
  if (materialization?.serverArchitecture === 'production-server') {
    const rel = materialization.runtimeDirRel || (existsSync(join(cellDir, 'agent-workspace')) ? 'agent-workspace' : 'extracted');
    const workspaceDir = join(cellDir, rel);
    const contract = resolveRuntimeContract(workspaceDir) || {
      buildCommand: materialization.buildCommand || '',
      startCommand: materialization.startCommand,
      healthPath: materialization.healthPath || '/',
    };
    return bootProductionWorkspaceServer({ workspaceDir, contract, timeoutMs });
  }

  const distDir = materialization?.distDir || join(cellDir, 'dist');
  const staticSrv = await serveStaticDirectory(distDir);
  return {
    ...staticSrv,
    pid: null,
    coldBootMs: 1,
    serverArchitecture: 'static-harness',
    sampleRssMb: async () => 0,
  };
}

/**
 * Probes real server-side performance, HTTP hygiene, SSR HTML richness, concurrency TTFB, and OS RSS memory.
 */
export async function probeServerTelemetry(serverHandle) {
  const { url, serverArchitecture = 'static-harness', coldBootMs = 0, sampleRssMb } = serverHandle;
  const idleServerRssMb = sampleRssMb ? await sampleRssMb() : 0;

  let single = null;
  try {
    single = await rawHttpGet(url + '/', 6000);
  } catch (err) {
    return {
      serverArchitecture,
      coldBootMs,
      idleServerRssMb,
      loadServerRssMb: idleServerRssMb,
      error: err.message,
    };
  }

  const headers = single.headers || {};
  const contentEncoding = String(headers['content-encoding'] || 'none').toLowerCase();
  const cacheControl = headers['cache-control'] ? String(headers['cache-control']) : null;
  const hasSetCookie = Boolean(headers['set-cookie']);

  const secHeaderNames = [
    'content-security-policy',
    'x-content-type-options',
    'x-frame-options',
    'referrer-policy',
    'strict-transport-security',
  ];
  const presentSecurityHeaders = secHeaderNames.filter((h) => Boolean(headers[h]));

  // Decompress if needed ONLY to inspect SSR HTML words & route links when plain text
  let htmlSample = '';
  if (contentEncoding === 'none') {
    htmlSample = single.rawBodyBuffer.toString('utf8');
  } else {
    try {
      const zlib = await import('node:zlib');
      if (contentEncoding.includes('br')) {
        htmlSample = zlib.brotliDecompressSync(single.rawBodyBuffer).toString('utf8');
      } else if (contentEncoding.includes('gzip')) {
        htmlSample = zlib.gunzipSync(single.rawBodyBuffer).toString('utf8');
      } else if (contentEncoding.includes('deflate')) {
        htmlSample = zlib.inflateSync(single.rawBodyBuffer).toString('utf8');
      }
    } catch {
      htmlSample = '';
    }
  }

  // Count visible text words in server-rendered HTML (stripping <script>/<style>/tags)
  const strippedText = htmlSample
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const ssrWordCount = strippedText ? strippedText.split(' ').filter((w) => w.length > 1).length : 0;

  const discoveredRoutes = new Set();
  const hrefRe = /href=["'](\/[A-Za-z0-9_./-]*)["']/g;
  let hm;
  while ((hm = hrefRe.exec(htmlSample)) !== null) {
    const p = hm[1];
    if (!/\.(?:css|js|mjs|png|jpe?g|svg|ico|webp|woff2?)$/i.test(p)) {
      discoveredRoutes.add(p);
    }
  }

  // 10-request concurrent burst to measure real server serialization & DB/handler latency under load
  const burstSize = 10;
  const burstResults = await Promise.allSettled(
    Array.from({ length: burstSize }, () => rawHttpGet(url + '/', 6000))
  );
  const burstTtfbs = burstResults
    .filter((r) => r.status === 'fulfilled' && r.value.statusCode < 500)
    .map((r) => r.value.ttfbMs)
    .sort((a, b) => a - b);
  const burstErrorCount = burstSize - burstTtfbs.length;
  const burstMedianTtfbMs =
    burstTtfbs.length > 0 ? burstTtfbs[Math.floor(burstTtfbs.length * 0.5)] : null;
  const burstP95TtfbMs =
    burstTtfbs.length > 0
      ? burstTtfbs[Math.min(burstTtfbs.length - 1, Math.floor(burstTtfbs.length * 0.95))]
      : null;

  const loadServerRssMb = sampleRssMb ? await sampleRssMb() : 0;

  return {
    serverArchitecture,
    coldBootMs,
    idleServerRssMb,
    loadServerRssMb,
    statusCode: single.statusCode,
    singleTtfbMs: single.ttfbMs,
    burstMedianTtfbMs,
    burstP95TtfbMs,
    burstErrorCount,
    wireHtmlBytes: single.wireBytes,
    uncompressedHtmlBytes: Buffer.byteLength(htmlSample, 'utf8'),
    contentEncoding,
    usesCompression: contentEncoding !== 'none',
    cacheControl,
    hasSetCookie,
    securityHeaders: presentSecurityHeaders,
    ssrWordCount,
    discoveredRoutes: Array.from(discoveredRoutes).slice(0, 20),
  };
}
