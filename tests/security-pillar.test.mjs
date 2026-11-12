import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import securityBench, {
  evaluateCsp,
  evaluateHeaders,
  evaluateCookies,
  evaluateCors,
  scanSecrets,
  scanClientCode,
  scanServerCode,
  collectDependencies,
  queryOsv,
  evaluateDependencies,
  scoreSecurityChecks,
} from '../src/benchmarks/security.bench.mjs';
import { BENCHMARK_PLUGINS } from '../src/benchmarks/registry.mjs';
import { loadBenchmarkConfig } from '../src/util/env.mjs';

const byId = (checks, id) => checks.find((c) => c.id === id);

describe('Security pillar: individual checks', () => {
  it('grades a Content Security Policy directive by directive', () => {
    const none = evaluateCsp({});
    assert.ok(none.every((c) => c.status === 'fail'));

    const weak = evaluateCsp({ headerValue: "default-src *; script-src 'self' 'unsafe-inline' 'unsafe-eval' https:" });
    assert.equal(byId(weak, 'csp-present').status, 'pass');
    assert.equal(byId(weak, 'csp-no-unsafe-inline').status, 'fail');
    assert.equal(byId(weak, 'csp-no-unsafe-eval').status, 'fail');
    assert.equal(byId(weak, 'csp-no-wildcard-sources').status, 'fail');

    const strict = evaluateCsp({ metaValue: "script-src 'nonce-abc' 'strict-dynamic' 'unsafe-inline' https:; object-src 'none'; base-uri 'none'" });
    assert.ok(strict.every((c) => c.status === 'pass'), JSON.stringify(strict.filter((c) => c.status !== 'pass')));
  });

  it('does not blame static files for headers only a server can send', () => {
    const stat = evaluateHeaders({}, { ownsServer: false, html: '<meta name="referrer" content="strict-origin-when-cross-origin">' });
    assert.equal(byId(stat, 'nosniff').status, 'na');
    assert.equal(byId(stat, 'clickjacking-protection').status, 'na');
    assert.equal(byId(stat, 'referrer-policy').status, 'pass');

    const srv = evaluateHeaders({ 'X-Powered-By': 'Express', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' }, { ownsServer: true });
    assert.equal(byId(srv, 'nosniff').status, 'pass');
    assert.equal(byId(srv, 'clickjacking-protection').status, 'pass');
    assert.equal(byId(srv, 'no-version-disclosure').status, 'fail');
    assert.equal(byId(srv, 'permissions-policy').status, 'fail');
  });

  it('checks cookie flags and credentialed CORS', () => {
    assert.ok(evaluateCookies([]).every((c) => c.status === 'na'));
    const bad = evaluateCookies(['sid=abc; Path=/', 'theme=dark; Path=/; SameSite=Lax']);
    assert.equal(byId(bad, 'cookie-httponly').status, 'fail');
    assert.deepEqual(byId(bad, 'cookie-httponly').evidence, ['sid']);
    assert.equal(byId(bad, 'cookie-samesite').status, 'fail');
    const good = evaluateCookies(['sid=abc; Path=/; HttpOnly; SameSite=Lax']);
    assert.ok(good.every((c) => c.status === 'pass'));

    const cors = evaluateCors([{ path: '/api/me', headers: { 'access-control-allow-origin': 'https://attacker.example', 'access-control-allow-credentials': 'true' } }]);
    assert.equal(cors[0].status, 'fail');
    assert.equal(evaluateCors([{ path: '/', headers: { 'access-control-allow-origin': '*' } }])[0].status, 'pass');
  });

  it('finds real-looking secrets and ignores placeholders', () => {
    const fake = (prefix, n) => prefix + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0'.slice(0, n);
    const hits = scanSecrets([
      { path: 'app.js', name: 'app.js', text: `const k = "${fake('sk_live_', 30)}";\n` },
      { path: 'server.js', name: 'server.js', text: 'const JWT_SECRET = process.env.JWT_SECRET || "super-secret-signing-key";\n' },
      { path: 'config.js', name: 'config.js', text: 'const apiKey = "YOUR_API_KEY_HERE";\nconst session_secret = process.env.SESSION_SECRET;\n' },
      { path: '.env.example', name: '.env.example', text: 'JWT_SECRET="changeme-please-12345"\n' },
    ]);
    assert.deepEqual(hits.map((h) => `${h.file}:${h.rule}`).sort(), ['app.js:stripe-secret', 'server.js:hardcoded-secret']);
    assert.ok(!JSON.stringify(hits).includes(fake('sk_live_', 30)), 'findings must not echo the secret');
  });

  it('flags unescaped HTML building, eval, inline handlers and unpinned CDN scripts', () => {
    const html = '<html><body onload="init()"><script src="https://cdn.jsdelivr.net/npm/lodash@4.17.15/lodash.min.js"></script><form action="http://example.com/post"><input type="password"></form></body></html>';
    const files = [
      { path: 'app.js', name: 'app.js', ext: '.js', text: 'list.innerHTML = items.map((i) => `<li>${i.name}</li>`).join("");\nsetTimeout("tick()", 10);\n' },
      { path: 'safe.js', name: 'safe.js', ext: '.js', text: 'const escapeHtml = (s) => s;\nlist.innerHTML = `<li>${escapeHtml(n)}</li>`;\nel.innerHTML = "";\n' },
    ];
    const checks = scanClientCode({ html, files });
    assert.equal(byId(checks, 'no-unescaped-html-sinks').status, 'fail');
    assert.equal(byId(checks, 'no-unescaped-html-sinks').evidence.length, 1);
    assert.equal(byId(checks, 'no-unescaped-html-sinks').confidence, 'heuristic');
    assert.equal(byId(checks, 'no-eval').status, 'fail');
    assert.equal(byId(checks, 'no-inline-event-handlers').status, 'fail');
    assert.equal(byId(checks, 'third-party-sri').status, 'fail');
    assert.equal(byId(checks, 'no-insecure-urls').status, 'fail');
    assert.equal(byId(checks, 'password-autocomplete').status, 'fail');

    const clean = scanClientCode({ html: '<a href="http://example.com">x</a><script src="/app.js"></script>', files: [files[1]] });
    assert.ok(clean.every((c) => c.status === 'pass'), JSON.stringify(clean.filter((c) => c.status !== 'pass')));
  });

  it('reads server code for SQL building, password hashing and shell use', () => {
    const insecure = scanServerCode([
      {
        path: 'server.js', name: 'server.js', ext: '.js',
        text: [
          "const express = require('express'); const crypto = require('crypto'); const { exec } = require('child_process');",
          "app.post('/login', (req, res) => {",
          "  const hash = crypto.createHash('md5').update(req.body.password).digest('hex');",
          "  db.get(`SELECT * FROM users WHERE email = '${req.body.email}'`, (err, u) => { if (err) res.send(err.stack); });",
          '  exec(`convert ${req.query.file} out.png`);',
          '});',
        ].join('\n'),
      },
    ]);
    assert.equal(byId(insecure, 'no-sql-string-building').status, 'fail');
    assert.equal(byId(insecure, 'password-hashing').status, 'fail');
    assert.equal(byId(insecure, 'no-shell-injection').status, 'fail');
    assert.equal(byId(insecure, 'no-stack-traces-to-client').status, 'fail');

    const secure = scanServerCode([
      { path: 'server.js', name: 'server.js', ext: '.js', text: "import express from 'express'; import bcrypt from 'bcrypt';\napp.post('/login', async (req, res) => { const u = db.prepare('SELECT * FROM users WHERE email = ?').get(req.body.email); await bcrypt.compare(req.body.password, u.hash); });\n" },
    ]);
    assert.ok(secure.every((c) => c.status === 'pass'), JSON.stringify(secure.filter((c) => c.status !== 'pass')));
    assert.ok(scanServerCode([{ path: 'app.js', name: 'app.js', ext: '.js', text: 'document.title = "x";' }]).every((c) => c.status === 'na'));
  });

  it('looks up dependency advisories and degrades to "not applicable" when offline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sec-deps-'));
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { lodash: '^4.17.15', express: '4.19.2' } }));
      const info = collectDependencies(dir, '<script src="https://unpkg.com/jquery@3.4.0/dist/jquery.js"></script>');
      assert.deepEqual(info.deps.map((d) => `${d.name}@${d.version}`), ['lodash@4.17.15', 'express@4.19.2', 'jquery@3.4.0']);
      assert.equal(info.hasLockfile, false);

      const fetchImpl = async (url, init) => {
        const { queries } = JSON.parse(init.body);
        return { ok: true, json: async () => ({ results: queries.map((q) => (q.package.name === 'lodash' ? { vulns: [{ id: 'GHSA-test-1' }] } : {})) }) };
      };
      const osv = await queryOsv(info.deps, { fetchImpl });
      const checks = evaluateDependencies(info, osv);
      assert.equal(byId(checks, 'no-known-vulnerable-dependencies').status, 'fail');
      assert.match(byId(checks, 'no-known-vulnerable-dependencies').evidence[0], /lodash@4\.17\.15.*GHSA-test-1/);
      assert.equal(byId(checks, 'dependencies-locked').status, 'fail');

      const down = await queryOsv(info.deps, { fetchImpl: async () => { throw new Error('offline'); } });
      assert.equal(byId(evaluateDependencies(info, down), 'no-known-vulnerable-dependencies').status, 'na');
      assert.equal(byId(evaluateDependencies({ deps: [], hasManifest: false, hasLockfile: false }, { ok: true, vulnerable: [] }), 'no-known-vulnerable-dependencies').status, 'pass');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('weights by severity, skips "not applicable" and caps the score on a critical failure', () => {
    const mk = (id, severity, status, group = 'headers') => ({ id, group, severity, status, weight: { critical: 10, high: 6, medium: 3, low: 1 }[severity] });
    const s = scoreSecurityChecks([mk('a', 'high', 'pass'), mk('b', 'medium', 'fail'), mk('c', 'low', 'na'), mk('d', 'low', 'pass', 'client')]);
    assert.equal(s.overall, 70);
    assert.equal(s.notApplicable, 1);
    assert.equal(s.groups.find((g) => g.id === 'headers').score, 66.7);
    assert.equal(s.groups.find((g) => g.id === 'server').score, null);
    const capped = scoreSecurityChecks([mk('a', 'high', 'pass'), mk('b', 'high', 'pass'), mk('c', 'high', 'pass'), mk('x', 'critical', 'fail', 'secrets')]);
    assert.equal(capped.overall, 50);
    assert.deepEqual(capped.criticalFailures, ['x']);
    assert.equal(scoreSecurityChecks([mk('a', 'low', 'na')]).overall, null);
  });
});

describe('Security pillar: end to end against a generated server', () => {
  let server;
  let url;
  let cellDir;
  const prevOffline = process.env.BENCH_OFFLINE;

  before(async () => {
    process.env.BENCH_OFFLINE = '1';
    cellDir = mkdtempSync(join(tmpdir(), 'sec-cell-'));
    const ws = join(cellDir, 'agent-workspace');
    mkdirSync(join(ws, 'public'), { recursive: true });
    writeFileSync(join(ws, 'package.json'), JSON.stringify({ dependencies: { express: '4.19.2' } }));
    writeFileSync(join(ws, '.env'), 'DB_PASSWORD=hunter2hunter2\n');
    writeFileSync(join(ws, 'server.js'), "const express = require('express');\nconst SESSION_SECRET = 'keyboard-cat-keyboard-cat';\napp.get('/api/items', (req, res) => res.json([]));\n");
    writeFileSync(join(ws, 'public', 'app.js'), "fetch('/api/items').then((r) => r.json()).then((items) => { list.innerHTML = items.map((i) => `<li>${i.name}</li>`).join(''); });\n");
    const html = '<!doctype html><html><head><title>Shop</title></head><body><ul id="list"></ul><script src="/app.js"></script></body></html>';
    server = http.createServer((req, res) => {
      if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html', 'x-powered-by': 'Express', 'set-cookie': 'sid=abc123; Path=/' });
        res.end(html);
      } else if (req.url === '/api/items') {
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': req.headers.origin || '*', 'access-control-allow-credentials': 'true' });
        res.end('[]');
      } else if (req.url === '/.env') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('DB_PASSWORD=hunter2hunter2\n');
      } else {
        // SPA-style fallback: every unknown path returns the app shell with 200
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(html);
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((r) => server.close(r));
    rmSync(cellDir, { recursive: true, force: true });
    if (prevOffline === undefined) delete process.env.BENCH_OFFLINE;
    else process.env.BENCH_OFFLINE = prevOffline;
  });

  it('reports each test with evidence and rolls them up by group', async () => {
    const out = await securityBench.run({
      url,
      cellDir,
      materialization: { serverArchitecture: 'production-server', runtimeDirRel: 'agent-workspace' },
      serverHandle: { serverArchitecture: 'production-server' },
      config: {},
    });
    const c = (id) => byId(out.checks, id);
    assert.equal(c('csp-present').status, 'fail');
    assert.equal(c('no-version-disclosure').status, 'fail');
    assert.equal(c('cookie-httponly').status, 'fail');
    assert.equal(c('cors-no-credentialed-wildcard').status, 'fail');
    assert.deepEqual(out.scope.apiPathsChecked, ['/api/items']);
    assert.equal(c('no-unescaped-html-sinks').status, 'fail');
    assert.equal(c('no-sensitive-files-served').status, 'fail');
    assert.deepEqual(c('no-sensitive-files-served').evidence, ['/.env (environment file)']);
    assert.equal(c('no-manifest-served').status, 'pass', 'an SPA fallback page is not a leaked manifest');
    assert.equal(c('no-hardcoded-secrets').status, 'fail');
    assert.equal(c('no-secrets-in-client-files').status, 'pass');
    assert.equal(c('no-known-vulnerable-dependencies').status, 'na');
    assert.equal(c('third-party-sri').status, 'pass');
    assert.ok(out.score <= 50, `critical failure should cap the score, got ${out.score}`);
    assert.ok(out.criticalFailures.includes('no-sensitive-files-served'));
    assert.equal(out.groups.length, 7);
    assert.equal(out.scope.activeProbes.ran, true);
    const probes = out.checks.filter((x) => x.group === 'probes');
    assert.equal(probes.length, 11);
    assert.deepEqual(probes.filter((x) => x.status === 'fail').map((x) => x.id), [], 'an SPA fallback shell is not a probe finding');
    assert.equal(c('probe-stays-up').status, 'pass');
    assert.ok(out.checks.every((x) => x.id && x.group && x.title && x.severity && x.detail && ['pass', 'fail', 'na'].includes(x.status)));
    assert.ok(!JSON.stringify(out).includes('keyboard-cat-keyboard-cat'), 'results must not contain the secret value');

    const saved = JSON.parse(readFileSync(join(cellDir, 'results', 'security.json'), 'utf8'));
    assert.equal(securityBench.score(saved).overall, out.score);
  });

  it('treats the same files served statically as a static site', async () => {
    const out = await securityBench.run({ url, cellDir, materialization: { serverArchitecture: 'static-harness' }, serverHandle: { serverArchitecture: 'static-harness' }, config: {} });
    assert.equal(byId(out.checks, 'nosniff').status, 'na');
    assert.equal(byId(out.checks, 'cookie-httponly').status, 'na');
    assert.ok(out.checks.filter((x) => x.group === 'probes').every((x) => x.status === 'na'), 'static builds are not probed');
    const scored = BENCHMARK_PLUGINS.filter((p) => p.id !== 'outside-in');
    assert.equal(scored.at(-1).id, 'security', 'probes dirty the app, so security runs after every other scored benchmark');
    assert.equal(byId(out.checks, 'csp-present').status, 'fail', 'a static site can still ship a <meta> policy');
  });
});

describe('Security pillar: scoring', () => {
  it('is registered and counted in the composite, with weights that sum to 1', () => {
    assert.ok(BENCHMARK_PLUGINS.some((p) => p.id === 'security'));
    const w = loadBenchmarkConfig().scoring.weights;
    assert.equal(w.security, 0.12);
    assert.equal(Math.round(Object.values(w).reduce((a, b) => a + b, 0) * 1000) / 1000, 1);
  });
});

describe('Security pillar: SQL heuristics', () => {
  it('separates injected values from structural interpolation', async () => {
    const { findSqlStringBuilding } = await import('../src/benchmarks/security.bench.mjs');
    assert.equal(findSqlStringBuilding("db.all(`SELECT * FROM items WHERE name LIKE '%${q}%'`)").length, 1);
    assert.equal(findSqlStringBuilding('db.all("SELECT * FROM items WHERE id = " + req.params.id)').length, 1);
    assert.equal(findSqlStringBuilding('db.prepare(`SELECT * FROM items WHERE id IN (${placeholders})`).all(...ids)').length, 0);
    assert.equal(findSqlStringBuilding("db.prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = ?`).run(...vals)").length, 0);
    assert.equal(findSqlStringBuilding("db.prepare('SELECT * FROM items WHERE id = ?').get(id)").length, 0);
    assert.equal(findSqlStringBuilding('console.log(`Please SELECT a plan, ${name}`)').length, 0);
  });
});
