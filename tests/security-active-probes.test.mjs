import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  runActiveProbes,
  discoverEndpoints,
  fillPathParams,
  isLoopbackUrl,
  rawRequest,
  PROBE_DEFS,
  XSS_PAYLOAD,
} from '../src/benchmarks/security-probes.mjs';
import { scoreSecurityChecks, SEVERITY_WEIGHT } from '../src/benchmarks/security.bench.mjs';

const makeCheck = (id, group, title, severity, status, detail, extra = {}) => ({ id, group, title, severity, weight: SEVERITY_WEIGHT[severity], status, detail, evidence: extra.evidence || [] });

// The source the probes read to find routes. Both test servers implement these routes; only their handling differs.
const SOURCE = `
app.get('/', home);
app.get('/search', search);
app.get('/api/items/:id', item);
app.get('/api/admin/users', listUsers);
app.post('/api/comments', (req, res) => { const { name, message } = req.body; db.exec("INSERT INTO c VALUES ('" + name + "')"); res.cookie('sid', '1'); });
app.post('/api/login', login);
app.get('/go', (req, res) => res.redirect(req.query.next));
const q = "SELECT * FROM items";
`;
const FILES = [{ path: 'server.js', ext: '.js', text: SOURCE }];

function readBody(req, limit) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
    });
    req.on('end', () => resolve({ tooBig: size > limit, text: Buffer.concat(chunks).toString('utf8') }));
  });
}

function vulnerable() {
  const comments = [];
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const raw = req.url;
    if (/etc\/passwd|etc%2fpasswd/i.test(raw)) return res.end('root:x:0:0:root:/root:/bin/bash\n');
    if (req.method === 'GET' && url.pathname === '/') { res.setHeader('content-type', 'text/html'); return res.end(`<html><body>${comments.join('')}</body></html>`); }
    if (url.pathname === '/search') { res.setHeader('content-type', 'text/html'); return res.end(`<html>Results for ${url.searchParams.get('q')}</html>`); }
    if (url.pathname.startsWith('/api/items/')) {
      if (decodeURIComponent(url.pathname).includes("'")) { res.statusCode = 500; return res.end('SQLITE_ERROR: near "\'": syntax error'); }
      res.setHeader('content-type', 'application/json'); return res.end('{"id":1}');
    }
    if (url.pathname === '/api/admin/users') { res.setHeader('content-type', 'application/json'); return res.end('[{"email":"ana@shop.test","password":"hunter2"}]'); }
    if (url.pathname === '/go') { res.statusCode = 302; res.setHeader('location', url.searchParams.get('next') || '/'); return res.end(); }
    if (req.method === 'POST' && url.pathname === '/api/comments') {
      const body = await readBody(req, 50 * 1024 * 1024);
      try {
        const parsed = JSON.parse(body.text);
        comments.push(`<p>${parsed.message}</p>`);
        res.setHeader('set-cookie', 'sid=1');
        res.setHeader('content-type', 'application/json');
        return res.end('{"ok":true}');
      } catch (err) {
        if (!(req.headers['content-type'] || '').includes('json')) { res.setHeader('content-type', 'application/json'); return res.end('{"ok":true}'); }
        res.statusCode = 400;
        return res.end(`SyntaxError: bad json\n    at JSON.parse (<anonymous>)\n    at parse (/home/app/node_modules/body-parser/lib/types/json.js:92:19)`);
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/login') { await readBody(req, 1e6); res.statusCode = 401; return res.end('{"error":"bad"}'); }
    res.statusCode = 404; res.end('not found');
  });
}

function hardened() {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const comments = [];
  let badLogins = 0;
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/') { res.setHeader('content-type', 'text/html'); return res.end(`<html><body>${comments.map(esc).join('')}</body></html>`); }
    if (url.pathname === '/search') { res.setHeader('content-type', 'text/html'); return res.end(`<html>Results for ${esc(url.searchParams.get('q'))}</html>`); }
    if (url.pathname.startsWith('/api/items/')) { res.setHeader('content-type', 'application/json'); return res.end('{"id":1}'); }
    if (url.pathname === '/api/admin/users') { res.statusCode = 401; res.setHeader('content-type', 'application/json'); return res.end('{"error":"login required"}'); }
    if (url.pathname === '/go') { res.statusCode = 302; res.setHeader('location', '/'); return res.end(); }
    if (req.method === 'POST' && url.pathname === '/api/comments') {
      const body = await readBody(req, 100 * 1024);
      if (body.tooBig) { res.statusCode = 413; return res.end('{"error":"too large"}'); }
      if (req.headers.origin && req.headers.origin !== 'http://localhost') { res.statusCode = 403; return res.end('{"error":"cross-site"}'); }
      try {
        comments.push(JSON.parse(body.text).message);
        res.setHeader('content-type', 'application/json');
        return res.end('{"ok":true}');
      } catch {
        res.statusCode = 400; return res.end('{"error":"invalid json"}');
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/login') { await readBody(req, 1e6); badLogins++; res.statusCode = badLogins > 5 ? 429 : 401; return res.end('{"error":"bad"}'); }
    res.statusCode = 404; res.end('{"error":"not found"}');
  });
}

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));
const byId = (checks) => Object.fromEntries(checks.map((c) => [c.id, c]));

describe('Security active probes', () => {
  let bad, good, badUrl, goodUrl;
  before(async () => {
    bad = vulnerable();
    good = hardened();
    badUrl = await listen(bad);
    goodUrl = await listen(good);
  });
  after(() => {
    bad.close();
    good.close();
  });

  it('reads routes, methods and field names out of the source', () => {
    const found = discoverEndpoints({ files: FILES, html: '<form action="/contact" method="post"><input name="email"></form>' });
    const keys = found.endpoints.map((e) => `${e.method} ${e.path}`);
    for (const k of ['GET /search', 'GET /api/items/:id', 'POST /api/comments', 'POST /api/login', 'POST /contact']) assert.ok(keys.includes(k), k);
    assert.ok(found.fields.includes('message') && found.fields.includes('email'));
    assert.ok(found.queryParams.includes('next'));
    assert.equal(fillPathParams('/api/items/:id/reviews/<int:rid>'), '/api/items/1/reviews/1');
  });

  it('sends paths as written instead of normalising them', async () => {
    const r = await rawRequest(badUrl, { path: '/static/../../etc/passwd' });
    assert.match(r.body, /root:x:0:0/);
  });

  it('fails a server that mishandles hostile input, with evidence for each finding', async () => {
    const { checks, summary } = await runActiveProbes({ base: badUrl, files: FILES, makeCheck, budgetMs: 30000 });
    const c = byId(checks);
    assert.equal(checks.length, PROBE_DEFS.length);
    for (const id of ['probe-reflected-xss', 'probe-stored-xss', 'probe-sql-error', 'probe-path-traversal', 'probe-open-admin', 'probe-cross-site-post', 'probe-open-redirect', 'probe-error-leak', 'probe-body-limit', 'probe-login-throttle']) {
      assert.equal(c[id].status, 'fail', `${id}: ${c[id].detail}`);
    }
    assert.ok(c['probe-open-admin'].evidence[0].includes('/api/admin/users'));
    assert.equal(c['probe-stays-up'].status, 'pass');
    assert.ok(summary.ran && summary.requests > 20);
    assert.ok(scoreSecurityChecks(checks).overall <= 50, 'a critical probe failure caps the score');
  });

  it('passes a server that handles the same input safely', async () => {
    const { checks } = await runActiveProbes({ base: goodUrl, files: FILES, makeCheck, budgetMs: 30000 });
    const failed = checks.filter((x) => x.status === 'fail').map((x) => `${x.id}: ${x.detail}`);
    assert.deepEqual(failed, []);
    assert.equal(byId(checks)['probe-login-throttle'].status, 'pass');
    assert.equal(byId(checks)['probe-stored-xss'].status, 'pass');
  });

  it('never probes a static build or a remote host', async () => {
    assert.equal(isLoopbackUrl('http://127.0.0.1:3000/'), true);
    assert.equal(isLoopbackUrl('https://example.com/'), false);
    let calls = 0;
    const request = async () => { calls++; return { ok: false, status: 0, headers: {}, setCookie: [], body: '' }; };
    const remote = await runActiveProbes({ base: 'https://example.com', files: FILES, makeCheck, request });
    const stat = await runActiveProbes({ base: goodUrl, files: [], ownsServer: false, makeCheck, request });
    assert.equal(calls, 0);
    assert.ok([...remote.checks, ...stat.checks].every((x) => x.status === 'na'));
    assert.equal(scoreSecurityChecks(stat.checks).overall, null);
  });

  it('reports a server that falls over under the probes', async () => {
    let n = 0;
    const request = async () => (++n === 1 ? { ok: true, status: 200, headers: { 'content-type': 'text/html' }, setCookie: [], body: '<html></html>' } : { ok: false, status: 0, headers: {}, setCookie: [], body: '', error: 'ECONNREFUSED' });
    const { checks } = await runActiveProbes({ base: 'http://127.0.0.1:1', files: FILES, makeCheck, request });
    assert.equal(byId(checks)['probe-stays-up'].status, 'fail');
  });
});
