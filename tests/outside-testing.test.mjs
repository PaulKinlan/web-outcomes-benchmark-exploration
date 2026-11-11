import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openQuickTunnel } from '../src/hosting/tunnel.mjs';
import outsideInBench, { runOutsideIn, runObservatory, runPageSpeed } from '../src/benchmarks/outside-in.bench.mjs';
import { verifyCellContainer } from '../src/hosting/verify-container.mjs';
import { BENCHMARK_PLUGINS } from '../src/benchmarks/registry.mjs';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  return child;
}
const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });

describe('Temporary public address (quick tunnel)', () => {
  it('reads the public address from cloudflared output and waits until it answers', async () => {
    const child = fakeChild();
    let calls = 0;
    const p = openQuickTunnel('http://127.0.0.1:4010', {
      spawnImpl: (bin, args) => {
        assert.equal(bin, 'cloudflared');
        assert.deepEqual(args, ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:4010']);
        setImmediate(() => child.stderr.emit('data', Buffer.from('INF |  https://quiet-river-1234.trycloudflare.com  |\n')));
        return child;
      },
      fetchImpl: async () => {
        calls++;
        return { status: 200 };
      },
    });
    const t = await p;
    assert.equal(t.url, 'https://quiet-river-1234.trycloudflare.com');
    assert.equal(t.host, 'quiet-river-1234.trycloudflare.com');
    assert.equal(calls, 1);
    t.close();
    assert.equal(child.killed, true);
  });

  it('fails with a plain message when cloudflared is missing, and cleans up', async () => {
    const child = fakeChild();
    const p = openQuickTunnel('http://127.0.0.1:1', {
      spawnImpl: () => {
        setImmediate(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
        return child;
      },
    });
    await assert.rejects(p, /cloudflared is not installed/);
    assert.equal(child.killed, true);
  });
});

describe('Outside-in checks', () => {
  it('reports each outside service and always closes the tunnel', async () => {
    let closed = 0;
    const out = await runOutsideIn({
      localUrl: 'http://127.0.0.1:4010',
      openTunnel: async () => ({ url: 'https://x.trycloudflare.com', host: 'x.trycloudflare.com', close: () => closed++ }),
      fetchImpl: async () => ({ status: 200 }),
      services: {
        observatory: async (host) => ({ service: 'MDN HTTP Observatory', ok: true, grade: 'B', host }),
        pagespeed: async () => ({ service: 'PageSpeed Insights', ok: false, error: 'quota' }),
      },
    });
    assert.equal(out.tunnel.ok, true);
    assert.deepEqual(out.reachable, { ok: true, publicStatus: 200, localStatus: 200, https: true });
    assert.equal(out.services[0].host, 'x.trycloudflare.com');
    assert.equal(out.services[1].ok, false);
    assert.equal(closed, 1);
  });

  it('records a tunnel failure instead of throwing', async () => {
    const out = await runOutsideIn({ localUrl: 'http://127.0.0.1:1', openTunnel: async () => Promise.reject(new Error('cloudflared is not installed')) });
    assert.deepEqual(out.tunnel, { ok: false, error: 'cloudflared is not installed' });
    assert.deepEqual(out.services, []);
  });

  it('parses Observatory and PageSpeed answers, and their errors', async () => {
    const obs = await runObservatory('x.example', { fetchImpl: async (url, init) => (assert.equal(init.method, 'POST'), jsonRes(200, { grade: 'C+', score: 60, tests_passed: 7, tests_failed: 3, tests_quantity: 10 })) });
    assert.deepEqual([obs.ok, obs.grade, obs.score, obs.testsPassed, obs.testsTotal], [true, 'C+', 60, 7, 10]);
    const psi = await runPageSpeed('https://x.example/', {
      apiKey: '',
      fetchImpl: async (url) => {
        assert.ok(!url.includes('key='));
        return jsonRes(200, { lighthouseResult: { lighthouseVersion: '13', categories: { performance: { score: 0.91 }, accessibility: { score: 1 } }, audits: { 'largest-contentful-paint': { numericValue: 1834.4 }, 'cumulative-layout-shift': { numericValue: 0.0123 } } } });
      },
    });
    assert.deepEqual([psi.ok, psi.performance, psi.accessibility, psi.seo, psi.lcpMs, psi.cls], [true, 91, 100, null, 1834, 0.012]);
    const bad = await runPageSpeed('https://x.example/', { fetchImpl: async () => jsonRes(429, { error: { message: 'Quota exceeded' } }) });
    assert.deepEqual([bad.ok, bad.error], [false, 'Quota exceeded']);
  });

  it('is off by default, static-site builds never get a public address, and it is never scored', async () => {
    const prev = process.env.BENCH_PUBLIC_TUNNEL;
    try {
      delete process.env.BENCH_PUBLIC_TUNNEL;
      assert.equal(await outsideInBench.run({ url: 'http://127.0.0.1:1', materialization: { serverArchitecture: 'production-server' } }), null);
      process.env.BENCH_PUBLIC_TUNNEL = '1';
      assert.equal(await outsideInBench.run({ url: 'http://127.0.0.1:1', materialization: { serverArchitecture: 'static-hosted' } }), null);
    } finally {
      if (prev === undefined) delete process.env.BENCH_PUBLIC_TUNNEL;
      else process.env.BENCH_PUBLIC_TUNNEL = prev;
    }
    assert.deepEqual(outsideInBench.score({}), { overall: null });
    const ids = BENCHMARK_PLUGINS.map((p) => p.id);
    assert.ok(ids.indexOf('outside-in') < ids.indexOf('security'), 'security probes must still run last');
  });
});

describe('Container kit verification', () => {
  function makeCell() {
    const cellDir = mkdtempSync(join(tmpdir(), 'verify-cell-'));
    mkdirSync(join(cellDir, 'agent-workspace'), { recursive: true });
    writeFileSync(join(cellDir, 'agent-workspace', 'package.json'), '{"scripts":{"start":"node server.js"}}');
    writeFileSync(join(cellDir, 'agent-workspace', 'server.js'), '');
    return cellDir;
  }
  const SERVER = { serverArchitecture: 'production-server', runtimeDirRel: 'agent-workspace' };
  const fakeDocker = (calls, { buildStatus = 0 } = {}) => (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'tar') {
      assert.ok(existsSync(args[1]), 'the published archive is what gets built');
      writeFileSync(join(args[3], 'package.json'), '{}');
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'build') {
      assert.ok(existsSync(join(args[3], 'Dockerfile')) && existsSync(join(args[3], '.dockerignore')));
      return { status: buildStatus, stdout: '', stderr: buildStatus ? 'npm ERR! missing script: build' : '' };
    }
    if (args[0] === 'image') return { status: 0, stdout: '123456789\n', stderr: '' };
    if (args[0] === 'run') return { status: 0, stdout: 'abc123\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };

  it('builds the published kit, starts it on loopback, and cleans up', async () => {
    const cellDir = makeCell();
    const calls = [];
    try {
      const r = await verifyCellContainer({ cellDir, materialization: SERVER, hostPort: 18111, run: fakeDocker(calls), fetchImpl: async (u) => (assert.equal(u, 'http://127.0.0.1:18111/'), { status: 200 }), env: {} });
      assert.deepEqual([r.applicable, r.built, r.started, r.httpStatus, r.imageBytes, r.error], [true, true, true, 200, 123456789, null]);
      assert.ok(calls.some((c) => /^docker run -d -p 127\.0\.0\.1:18111:8080 bench-cell-/.test(c)));
      assert.ok(calls.some((c) => c === 'docker rm -f abc123'));
      assert.ok(calls.some((c) => c.startsWith('docker rmi -f bench-cell-')));
    } finally {
      rmSync(cellDir, { recursive: true, force: true });
    }
  });

  it('records a failed build with the reason and never starts a container', async () => {
    const cellDir = makeCell();
    const calls = [];
    try {
      const r = await verifyCellContainer({ cellDir, materialization: SERVER, run: fakeDocker(calls, { buildStatus: 1 }), fetchImpl: async () => assert.fail('must not fetch'), env: {} });
      assert.deepEqual([r.built, r.started], [false, false]);
      assert.match(r.error, /image build failed: npm ERR! missing script: build/);
      assert.ok(!calls.some((c) => c.startsWith('docker run')));
    } finally {
      rmSync(cellDir, { recursive: true, force: true });
    }
  });

  it('does not apply to static-site builds', async () => {
    const cellDir = makeCell();
    try {
      const r = await verifyCellContainer({ cellDir, materialization: { serverArchitecture: 'static-hosted' }, run: () => assert.fail('must not run docker'), env: {} });
      assert.equal(r.applicable, false);
    } finally {
      rmSync(cellDir, { recursive: true, force: true });
    }
  });
});
