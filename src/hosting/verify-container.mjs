import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeCellContainerKit, CONTAINER_PORT } from './containerize.mjs';

/**
 * Proves the published container kit works: builds the image from the same Dockerfile and source archive
 * a reader would download, starts it, and asks it for the home page. The verdict is written next to the
 * cell as `container-check.json` and shown on the report, so "run this site yourself" is a tested claim.
 */

export const CONTAINER_CHECK_FILE = 'container-check.json';

/** Identifies exactly what was built: the Dockerfile text plus a digest of the workspace's file contents. */
export function kitFingerprint(kitDir, kit) {
  const h = createHash('sha256').update(readFileSync(join(kitDir, 'Dockerfile')));
  h.update(`\n${kit?.startCommand || ''}\n${kit?.buildCommand || ''}\n${kit?.sourceDigest || ''}`);
  return h.digest('hex');
}

/** A stored verdict counts only for the kit it was produced from. */
export function verdictMatchesKit(verdict, kitDir, kit) {
  if (!verdict) return false;
  try {
    return Boolean(verdict.kitFingerprint) && verdict.kitFingerprint === kitFingerprint(kitDir, kit);
  } catch {
    return false;
  }
}

function defaultRun(cmd, args, { timeoutMs = 60000 } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || (r.error ? r.error.message : ''), timedOut: r.error?.code === 'ETIMEDOUT' };
}

const tail = (s, n = 600) => String(s || '').trim().slice(-n);

export async function verifyCellContainer({ cellDir, materialization, hostPort = 18080, run = defaultRun, fetchImpl = globalThis.fetch, buildTimeoutMs = 8 * 60000, startTimeoutMs = 60000, pollMs = 1500, env = process.env }) {
  const out = { checkedAt: new Date().toISOString(), applicable: true, built: false, started: false, httpStatus: null, buildSeconds: null, startSeconds: null, imageBytes: null, error: null };
  const kitDir = mkdtempSync(join(tmpdir(), 'kit-verify-'));
  const ctxDir = mkdtempSync(join(tmpdir(), 'kit-ctx-'));
  const tag = `bench-cell-${createHash('sha256').update(cellDir).digest('hex').slice(0, 12)}`;
  let containerId = null;
  let buildAttempted = false;
  try {
    const kit = writeCellContainerKit({ cellDir, outDir: kitDir, materialization, env });
    if (!kit.ok) return { ...out, applicable: false, error: kit.reason };
    out.kitFingerprint = kitFingerprint(kitDir, kit);
    if (!kit.sourceIncluded) return { ...out, applicable: false, error: `source archive not published: ${kit.sourceOmittedReason}` };

    const untar = run('tar', ['-xzf', join(kitDir, 'source.tar.gz'), '-C', ctxDir]);
    if (untar.status !== 0) return { ...out, error: `could not unpack the source archive: ${tail(untar.stderr, 200)}` };
    cpSync(join(kitDir, 'Dockerfile'), join(ctxDir, 'Dockerfile'));
    cpSync(join(kitDir, 'dockerignore.txt'), join(ctxDir, '.dockerignore'));

    const t0 = Date.now();
    buildAttempted = true;
    const build = run('docker', ['build', '-t', tag, ctxDir], { timeoutMs: buildTimeoutMs });
    out.buildSeconds = Math.round((Date.now() - t0) / 1000);
    if (build.status !== 0) return { ...out, error: build.timedOut ? `image build took longer than ${Math.round(buildTimeoutMs / 60000)} minutes` : `image build failed: ${tail(build.stderr || build.stdout)}` };
    out.built = true;
    const size = run('docker', ['image', 'inspect', tag, '--format', '{{.Size}}']);
    if (size.status === 0 && Number(size.stdout.trim()) > 0) out.imageBytes = Number(size.stdout.trim());

    // Published on loopback only: this proves the image starts, it does not put the site on the network.
    const started = run('docker', ['run', '-d', '-p', `127.0.0.1:${hostPort}:${CONTAINER_PORT}`, tag]);
    if (started.status !== 0) return { ...out, error: `container did not start: ${tail(started.stderr, 300)}` };
    containerId = started.stdout.trim();

    const t1 = Date.now();
    let last = 'no response';
    while (Date.now() - t1 < startTimeoutMs) {
      try {
        const res = await fetchImpl(`http://127.0.0.1:${hostPort}/`, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
        out.httpStatus = res.status;
        if (res.status < 500) {
          out.started = true;
          out.startSeconds = Math.round((Date.now() - t1) / 100) / 10;
          return out;
        }
        last = `HTTP ${res.status}`;
      } catch (err) {
        last = err.message;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    const logs = run('docker', ['logs', '--tail', '20', containerId]);
    return { ...out, error: `the container never answered on port ${CONTAINER_PORT} within ${Math.round(startTimeoutMs / 1000)}s (${last}). ${tail(`${logs.stdout}\n${logs.stderr}`, 400)}`.trim() };
  } catch (err) {
    return { ...out, error: err.message };
  } finally {
    if (containerId) run('docker', ['rm', '-f', containerId]);
    if (buildAttempted) run('docker', ['rmi', '-f', tag]);
    rmSync(kitDir, { recursive: true, force: true });
    rmSync(ctxDir, { recursive: true, force: true });
  }
}

export function writeContainerCheck(cellDir, result) {
  if (!existsSync(cellDir)) return;
  writeFileSync(join(cellDir, CONTAINER_CHECK_FILE), JSON.stringify(result, null, 2) + '\n', 'utf8');
}
