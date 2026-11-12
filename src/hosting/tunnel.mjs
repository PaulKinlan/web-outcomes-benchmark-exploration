import { spawn } from 'node:child_process';

/**
 * A temporary public address for a local server, through a Cloudflare quick tunnel (no account, random
 * hostname, gone when the process exits). It lets tools that live outside the benchmark machine reach a
 * generated server while it is being audited.
 */

const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export async function openQuickTunnel(localUrl, { bin = process.env.CLOUDFLARED_BIN || 'cloudflared', startTimeoutMs = 30000, readyTimeoutMs = 45000, fetchImpl = globalThis.fetch, spawnImpl = spawn } = {}) {
  const child = spawnImpl(bin, ['tunnel', '--no-autoupdate', '--url', localUrl], { stdio: ['ignore', 'pipe', 'pipe'] });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
  };

  let url;
  try {
    url = await new Promise((resolvePromise, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error(`cloudflared gave no public address within ${startTimeoutMs}ms`)), startTimeoutMs);
      const onData = (d) => {
        buf = (buf + d.toString('utf8')).slice(-8000);
        const m = buf.match(TUNNEL_URL_RE);
        if (m) {
          clearTimeout(timer);
          resolvePromise(m[0]);
        }
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(err.code === 'ENOENT' ? `${bin} is not installed` : err.message));
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`cloudflared exited early (code ${code})`));
      });
    });
  } catch (err) {
    close();
    throw err;
  }

  // The hostname takes a few seconds to resolve and route.
  const deadline = Date.now() + readyTimeoutMs;
  let lastError = 'not tried';
  while (Date.now() < deadline) {
    try {
      const res = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
      if (res.status > 0 && res.status < 500) return { url, host: new URL(url).host, close };
      lastError = `status ${res.status}`;
    } catch (err) {
      lastError = err.message;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  close();
  throw new Error(`The tunnel address never became reachable (${lastError})`);
}
