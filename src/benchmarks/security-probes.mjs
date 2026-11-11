import http from 'node:http';
import https from 'node:https';

/**
 * Security pillar, part 2: active probes.
 *
 * Part 1 reads what a site ships. This part sends it hostile input and watches what comes back: script payloads,
 * broken SQL, path traversal, malformed and oversized bodies, cross-site form posts, repeated bad logins. It is
 * plain HTTP with no browser, and it only ever targets the loopback server the benchmark itself started.
 *
 * Probes write junk into the app's data, so the security benchmark runs after every other measurement.
 */

export const PROBE_GROUP = { id: 'probes', label: 'Active probes' };
export const PROBE_MARKER = 'bxq7';
export const XSS_PAYLOAD = `${PROBE_MARKER}"'><svg/onload=${PROBE_MARKER}(1)>`;
const XSS_RAW_RE = new RegExp(`<svg/onload=${PROBE_MARKER}\\(1\\)>`);
const ATTACKER_ORIGIN = 'https://attacker.example';

export const PROBE_DEFS = [
  ['probe-reflected-xss', 'Does not echo script from the URL into the page', 'high'],
  ['probe-stored-xss', 'Does not serve submitted script back in its pages', 'high'],
  ['probe-sql-error', 'A stray quote does not break a database query', 'high'],
  ['probe-path-traversal', 'Cannot be made to serve files outside the site', 'critical'],
  ['probe-open-admin', 'Admin and user data need a login', 'high'],
  ['probe-cross-site-post', 'Rejects form posts from another site', 'medium'],
  ['probe-open-redirect', 'Does not redirect to an address taken from the URL', 'medium'],
  ['probe-error-leak', 'Bad requests do not reveal stack traces or file paths', 'medium'],
  ['probe-body-limit', 'Refuses an oversized request body', 'low'],
  ['probe-login-throttle', 'Slows down repeated failed logins', 'low'],
  ['probe-stays-up', 'Still answers after hostile input', 'medium'],
];

export function isLoopbackUrl(url) {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return h === 'localhost' || h === '::1' || /^127\./.test(h);
  } catch {
    return false;
  }
}

/** Sends a request with the path exactly as given: `fetch` would normalise `../` and `%2e%2e` away. */
export function rawRequest(base, { method = 'GET', path = '/', headers = {}, body = null, timeoutMs = 5000, maxBytes = 300_000 } = {}) {
  return new Promise((resolvePromise) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolvePromise(v);
      }
    };
    let u;
    try {
      u = new URL(base);
    } catch {
      return done({ ok: false, status: 0, headers: {}, setCookie: [], body: '', error: 'bad base url' });
    }
    const lib = u.protocol === 'https:' ? https : http;
    const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    const req = lib.request(
      {
        host: u.hostname.replace(/^\[|\]$/g, ''),
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        method,
        path,
        headers: { ...(payload ? { 'content-length': payload.length } : {}), ...headers },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          if (size < maxBytes) chunks.push(c);
          size += c.length;
        });
        const finish = () =>
          done({
            ok: true,
            status: res.statusCode || 0,
            headers: res.headers || {},
            setCookie: [].concat(res.headers?.['set-cookie'] || []),
            body: Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8'),
          });
        res.on('end', finish);
        res.on('error', finish);
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => done({ ok: false, status: 0, headers: {}, setCookie: [], body: '', error: err.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------------------------------------
// Finding what there is to probe
// ---------------------------------------------------------------------------------------------------------

const cleanPath = (p) => String(p || '').split(/[?#]/)[0];
const isProbeablePath = (p) => /^\/[A-Za-z0-9_\-./:<>{}*]*$/.test(p) && p.length <= 80 && !/\.(?:js|css|png|jpe?g|svg|ico|map|woff2?)$/i.test(p);
export const fillPathParams = (p, value = '1') =>
  p.replace(/:[A-Za-z_]\w*\??|<(?:\w+:)?\w+>|\{\w+\}|\*/g, value);
const hasPathParam = (p) => /:[A-Za-z_]|<\w|\{\w/.test(p);

/**
 * Reads the routes and field names out of the server source, the client code and the HTML forms. It only needs
 * to be good enough to aim the probes; anything it misses is simply not probed.
 */
export function discoverEndpoints({ html = '', files = [] } = {}) {
  const found = new Map();
  const fields = new Set();
  const queryParams = new Set();
  const add = (method, path) => {
    const p = cleanPath(path);
    if (!isProbeablePath(p)) return;
    const m = String(method || 'GET').toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(m)) return;
    found.set(`${m} ${p}`, { method: m, path: p });
  };

  const texts = [html, ...files.filter((f) => !/(?:^|\/)(?:node_modules|dist|build)\//.test(f.path) && f.text.length < 400_000).map((f) => f.text)];
  for (const text of texts) {
    for (const m of text.matchAll(/\b[A-Za-z_$][\w$]*\.(get|post|put|patch|delete)\(\s*["'`](\/[^"'`\s]*)["'`]/g)) add(m[1], m[2]);
    for (const m of text.matchAll(/@\w+\.(get|post|put|patch|delete)\(\s*["'](\/[^"']*)["']/g)) add(m[1], m[2]);
    for (const m of text.matchAll(/@\w+\.route\(\s*["'](\/[^"']*)["']([^)]*)\)/g)) {
      const methods = m[2].match(/methods\s*=\s*\[([^\]]*)\]/)?.[1].match(/[A-Z]+/g) || ['GET'];
      for (const method of methods) add(method, m[1]);
    }
    for (const m of text.matchAll(/(?:url|pathname|path)\s*===?\s*["'`](\/[^"'`\s]*)["'`]/g)) {
      const near = text.slice(Math.max(0, m.index - 160), m.index + 200);
      const methods = near.match(/["'`](GET|POST|PUT|PATCH|DELETE)["'`]/g)?.map((s) => s.slice(1, -1)) || ['GET'];
      for (const method of methods) add(method, m[1]);
    }
    for (const m of text.matchAll(/fetch\(\s*["'`](\/[^"'`$?\s]*)/g)) {
      const method = text.slice(m.index, m.index + 260).match(/method\s*:\s*["'`](\w+)["'`]/)?.[1] || 'GET';
      add(method, m[1]);
    }
    for (const m of text.matchAll(/<form\b[^>]*>/gi)) {
      const action = m[0].match(/\baction\s*=\s*["']([^"']*)["']/i)?.[1];
      const method = m[0].match(/\bmethod\s*=\s*["']?(\w+)/i)?.[1] || 'GET';
      if (action && action.startsWith('/')) add(method, action);
    }
    for (const m of text.matchAll(/<(?:input|textarea|select)\b[^>]*\bname\s*=\s*["']([\w.-]{1,40})["']/gi)) fields.add(m[1]);
    for (const m of text.matchAll(/\b(?:req|request|ctx\.request)\.body\.([A-Za-z_]\w{0,39})/g)) fields.add(m[1]);
    for (const m of text.matchAll(/\{([^{}=]{1,200})\}\s*=\s*(?:await\s+)?(?:req|request|ctx\.request)\.(?:body|json\(\))/g)) {
      for (const name of m[1].split(',')) {
        const n = name.split(/[:=]/)[0].trim();
        if (/^[A-Za-z_]\w{0,39}$/.test(n)) fields.add(n);
      }
    }
    for (const m of text.matchAll(/(?:request\.(?:form|json)|data|body|payload)(?:\.get\(\s*|\[)["']([A-Za-z_]\w{0,39})["']/g)) fields.add(m[1]);
    for (const m of text.matchAll(/(?:req|request)\.query\.([A-Za-z_]\w{0,39})|(?:request\.args\.get|searchParams\.get)\(\s*["']([A-Za-z_]\w{0,39})["']/g)) queryParams.add(m[1] || m[2]);
  }

  const endpoints = [...found.values()];
  return {
    endpoints,
    reads: endpoints.filter((e) => e.method === 'GET'),
    writes: endpoints.filter((e) => e.method !== 'GET'),
    fields: [...fields].slice(0, 24),
    queryParams: [...queryParams].slice(0, 12),
  };
}

/** A believable value for a field, carrying `text` wherever free text is plausible. */
export function valueForField(name, text) {
  const n = String(name).toLowerCase();
  if (/e-?mail/.test(n)) return `${PROBE_MARKER}@example.com`;
  if (/phone|tel|mobile/.test(n)) return '5550100';
  if (/date|day/.test(n)) return '2030-01-15';
  if (/time|slot/.test(n)) return '10:00';
  if (/^(?:id|qty|quantity|count|amount|price|rating|age|guests|people|stock|total)$|_id$|Id$/.test(name) || /quantity|amount|price/.test(n)) return 1;
  if (/password|passwd|pwd/.test(n)) return `${PROBE_MARKER}-Passw0rd!`;
  if (/url|website|link|image|photo|avatar/.test(n)) return `https://example.com/${PROBE_MARKER}`;
  return text;
}

export function buildBody(fields, text) {
  const names = fields.length ? fields : ['name', 'title', 'message', 'text', 'content', 'comment', 'email'];
  return Object.fromEntries(names.map((f) => [f, valueForField(f, text)]));
}

const SQL_ERROR_RE = /SQLITE_ERROR|SqliteError|sqlite3\.OperationalError|near "[^"\n]{0,40}": syntax error|syntax error at or near|You have an error in your SQL syntax|unterminated quoted string|ER_PARSE_ERROR|psycopg2\.errors|unrecognized token: "/i;
const STACK_RE = /\n\s+at [^\n]{0,160}(?:\/|file:|node:)[^\n]{0,200}:\d+:\d+|Traceback \(most recent call last\)|File "\/[^"\n]+", line \d+|(?:\/home\/|\/Users\/|\/app\/|\/usr\/src\/)[^\s"'<]{0,120}node_modules/;
const PASSWD_RE = /root:[^:\n]{0,3}:0:0:/;
const isHtml = (r) => /html/i.test(r.headers?.['content-type'] || '') || /^\s*<(?:!doctype|html)/i.test(r.body || '');
const isJson = (r) => /json/i.test(r.headers?.['content-type'] || '');
const accepted = (r) => r.ok && r.status >= 200 && r.status < 400;
const enc = encodeURIComponent;

async function sendWrite(req, endpoint, bodyObj, extraHeaders = {}) {
  const path = fillPathParams(endpoint.path);
  let r = await req({ method: endpoint.method, path, headers: { 'content-type': 'application/json', ...extraHeaders }, body: JSON.stringify(bodyObj) });
  if (r.ok && [400, 415, 422].includes(r.status)) {
    const form = Object.entries(bodyObj).map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&');
    const r2 = await req({ method: endpoint.method, path, headers: { 'content-type': 'application/x-www-form-urlencoded', ...extraHeaders }, body: form });
    if (accepted(r2)) r = r2;
  }
  return r;
}

// ---------------------------------------------------------------------------------------------------------
// The probes
// ---------------------------------------------------------------------------------------------------------

/**
 * Runs every probe against `base` and returns one check per probe. `makeCheck` is the security benchmark's own
 * check factory, so probe results have the same shape as the passive checks.
 */
export async function runActiveProbes({ base, html = '', files = [], ownsServer = true, makeCheck, allowRemote = false, budgetMs = 60_000, request = rawRequest }) {
  const mk = (id, status, detail, extra = {}) => {
    const def = PROBE_DEFS.find((d) => d[0] === id);
    return makeCheck(id, PROBE_GROUP.id, def[1], def[2], status, detail, { confidence: 'measured', ...extra });
  };
  const allNa = (why) => PROBE_DEFS.map(([id]) => mk(id, 'na', why));
  if (!ownsServer) return { checks: allNa('Static build: there is no server-side code to probe.'), summary: { ran: false, reason: 'static build' } };
  if (!allowRemote && !isLoopbackUrl(base)) return { checks: allNa('Skipped: probes only run against the local server the benchmark starts.'), summary: { ran: false, reason: 'target is not local' } };

  const deadline = Date.now() + budgetMs;
  let requestCount = 0;
  let sawCookie = false;
  const req = async (opts) => {
    if (Date.now() > deadline) return { ok: false, status: 0, headers: {}, setCookie: [], body: '', error: 'probe budget spent' };
    requestCount++;
    const r = await request(base, opts);
    if (r.setCookie?.length) sawCookie = true;
    return r;
  };
  const spent = () => Date.now() > deadline;

  const found = discoverEndpoints({ html, files });
  const serverText = files.filter((f) => /\.(?:m?js|cjs|ts|py|rb|php|go)$/.test(f.path) && !/(?:^|\/)(?:public|static|dist|client|assets)\//.test(f.path)).map((f) => f.text).join('\n');
  const pageReads = [{ method: 'GET', path: '/' }, ...found.reads.filter((e) => e.path !== '/' && !/^\/api\b/.test(e.path))].slice(0, 6);
  const apiReads = found.reads.filter((e) => /^\/api\b/.test(e.path)).slice(0, 6);
  const writes = found.writes.filter((e) => e.method !== 'DELETE' && !/logout|signout/i.test(e.path)).slice(0, 4);
  const checks = [];
  const home = await req({ path: '/' });

  // 1. Reflected XSS
  {
    const params = [...new Set([...found.queryParams, 'q', 'search', 'query', 'name', 'message', 'error'])].slice(0, 8);
    const qs = params.map((p) => `${enc(p)}=${enc(XSS_PAYLOAD)}`).join('&');
    const hits = [];
    for (const e of pageReads) {
      const r = await req({ path: `${fillPathParams(e.path)}?${qs}` });
      if (r.ok && isHtml(r) && XSS_RAW_RE.test(r.body)) hits.push(`GET ${e.path}?${params[0]}=…`);
    }
    const notFound = await req({ path: `/${enc(XSS_PAYLOAD)}` });
    if (notFound.ok && isHtml(notFound) && XSS_RAW_RE.test(notFound.body)) hits.push('GET /<payload> (error page)');
    for (const e of [...pageReads, ...apiReads].filter((x) => hasPathParam(x.path)).slice(0, 3)) {
      const r = await req({ path: fillPathParams(e.path, enc(XSS_PAYLOAD)) });
      if (r.ok && isHtml(r) && XSS_RAW_RE.test(r.body)) hits.push(`GET ${e.path} (path value)`);
    }
    checks.push(mk('probe-reflected-xss', hits.length ? 'fail' : 'pass', hits.length ? 'A script tag sent in the URL came back unescaped in an HTML page.' : `Sent a script payload in ${params.length} URL parameters across ${pageReads.length} page(s): it was never echoed as markup.`, { evidence: hits, ref: 'https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html' }));
  }

  // 2. Stored XSS
  const acceptedWrites = [];
  {
    for (const e of writes) {
      const r = await sendWrite(req, e, buildBody(found.fields, XSS_PAYLOAD));
      if (accepted(r)) acceptedWrites.push(e);
    }
    if (acceptedWrites.length === 0) {
      checks.push(mk('probe-stored-xss', 'na', writes.length ? `None of the ${writes.length} write endpoint(s) accepted the test submission, so nothing was stored.` : 'No endpoint that accepts submitted content was found.'));
    } else {
      const hits = [];
      for (const e of pageReads) {
        const r = await req({ path: fillPathParams(e.path) });
        if (r.ok && isHtml(r) && XSS_RAW_RE.test(r.body)) hits.push(`GET ${e.path} serves the stored payload as markup`);
      }
      checks.push(mk('probe-stored-xss', hits.length ? 'fail' : 'pass', hits.length ? 'Script submitted through a form is served back to every visitor unescaped.' : `Submitted a script payload to ${acceptedWrites.map((e) => `${e.method} ${e.path}`).join(', ')}: server-rendered pages escape it. Pages that render it in the browser are covered by the client-side code checks.`, { evidence: hits }));
    }
  }

  // 3. SQL errors
  {
    const hits = [];
    let tried = 0;
    const quote = `1'"`;
    for (const e of [...apiReads, ...pageReads].slice(0, 8)) {
      const target = hasPathParam(e.path) ? fillPathParams(e.path, enc(quote)) : `${e.path}?${[...new Set([...found.queryParams, 'id', 'q', 'search', 'category', 'sort'])].slice(0, 8).map((p) => `${enc(p)}=${enc(quote)}`).join('&')}`;
      const r = await req({ path: target });
      tried++;
      if (r.ok && SQL_ERROR_RE.test(r.body)) hits.push(`GET ${e.path}: ${r.body.match(SQL_ERROR_RE)[0].slice(0, 80)}`);
    }
    for (const e of writes) {
      const r = await sendWrite(req, e, buildBody(found.fields, `${PROBE_MARKER}'") --`));
      tried++;
      if (r.ok && SQL_ERROR_RE.test(r.body)) hits.push(`${e.method} ${e.path}: ${r.body.match(SQL_ERROR_RE)[0].slice(0, 80)}`);
    }
    const usesSql = /\b(?:SELECT\b[^\n]*\bFROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i.test(serverText);
    checks.push(!usesSql && hits.length === 0
      ? mk('probe-sql-error', 'na', 'The server does not use SQL.')
      : mk('probe-sql-error', hits.length ? 'fail' : 'pass', hits.length ? 'A quote character in the input reached the database as part of the query text.' : `Sent quote characters to ${tried} endpoint(s): no database error came back.`, { evidence: hits, ref: 'https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html' }));
  }

  // 4. Path traversal
  {
    const up = '../../../../../../etc/passwd';
    const paths = [`/${up}`, `/${up.replaceAll('/', '%2f')}`, `/${up.replaceAll('..', '%2e%2e')}`, `/static/${up}`, `/assets/${up.replaceAll('/', '%2f')}`, `/public/${up.replaceAll('../', '%2e%2e%2f')}`, `/images/${up}`, `/....//....//....//....//etc/passwd`];
    for (const e of found.reads.slice(0, 6)) {
      const fileParams = found.queryParams.filter((p) => /file|path|name|page|template|img|image|doc/i.test(p));
      if (fileParams.length) paths.push(`${fillPathParams(e.path)}?${fileParams.map((p) => `${enc(p)}=${enc(up)}`).join('&')}`);
      if (hasPathParam(e.path)) paths.push(fillPathParams(e.path, up.replaceAll('/', '%2f')));
    }
    const hits = [];
    for (const p of paths.slice(0, 14)) {
      const r = await req({ path: p });
      if (r.ok && PASSWD_RE.test(r.body)) hits.push(`GET ${p.slice(0, 90)} returned /etc/passwd`);
    }
    checks.push(mk('probe-path-traversal', hits.length ? 'fail' : 'pass', hits.length ? 'A crafted path made the server return a system file.' : `Requested ${Math.min(paths.length, 14)} traversal paths: none escaped the site directory.`, { evidence: hits, ref: 'https://owasp.org/www-community/attacks/Path_Traversal' }));
  }

  // 5. Admin and user data without a login
  {
    const adminEndpoints = found.endpoints.filter((e) => /admin|dashboard|manage/i.test(e.path)).slice(0, 6);
    const candidates = [...adminEndpoints.filter((e) => e.method === 'GET'), ...['/api/users', '/api/admin', '/api/admin/users', '/api/customers', '/api/orders', '/api/bookings', '/api/appointments'].map((path) => ({ method: 'GET', path }))];
    const hits = [];
    const seen = new Set();
    for (const e of candidates.slice(0, 12)) {
      if (seen.has(e.path)) continue;
      seen.add(e.path);
      const r = await req({ path: fillPathParams(e.path) });
      if (!r.ok || r.status !== 200 || !isJson(r)) continue;
      const personal = /"(?:password|passwordHash|password_hash|hash|salt)"\s*:/i.test(r.body) ? 'password fields' : /"e-?mail"\s*:\s*"[^"@]+@/i.test(r.body) || /"phone"\s*:\s*"\+?\d/i.test(r.body) ? 'other people\'s contact details' : null;
      if (personal) hits.push(`GET ${e.path} returns ${personal} to anyone`);
      else if (/admin/i.test(e.path) && r.body.trim().length > 2 && !/^\s*\{\s*"(?:error|message)"/i.test(r.body)) hits.push(`GET ${e.path} returns admin data without a login`);
    }
    for (const e of adminEndpoints.filter((x) => x.method !== 'GET').slice(0, 3)) {
      const r = await sendWrite(req, e, buildBody(found.fields, `${PROBE_MARKER} probe`));
      if (accepted(r) && r.status !== 304) hits.push(`${e.method} ${e.path} accepted a change without a login`);
    }
    const hasProtectedSurface = adminEndpoints.length > 0 || /\bpassword\b/i.test(serverText) || hits.length > 0;
    checks.push(hasProtectedSurface
      ? mk('probe-open-admin', hits.length ? 'fail' : 'pass', hits.length ? 'Data or actions meant for staff are open to anyone who knows the address.' : 'Admin routes and user listings did not answer without a login.', { evidence: hits, ref: 'https://owasp.org/Top10/A01_2021-Broken_Access_Control/' })
      : mk('probe-open-admin', 'na', 'The app has no admin area, accounts or personal data to protect.'));
  }

  // 6. Cross-site form posts
  {
    const usesCookies = sawCookie || /res\.cookie\(|express-session|cookie-session|set_cookie\(|session\[|setHeader\(\s*["']Set-Cookie/i.test(serverText);
    if (!usesCookies) {
      checks.push(mk('probe-cross-site-post', 'na', 'The app sets no cookies, so a request forged from another site carries no one\'s login.'));
    } else if (writes.length === 0) {
      checks.push(mk('probe-cross-site-post', 'na', 'No endpoint that changes data was found.'));
    } else {
      const hits = [];
      for (const e of writes) {
        const body = Object.entries(buildBody(found.fields, `${PROBE_MARKER} cross-site`)).map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&');
        const r = await req({ method: e.method, path: fillPathParams(e.path), headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ATTACKER_ORIGIN, referer: `${ATTACKER_ORIGIN}/`, 'sec-fetch-site': 'cross-site' }, body });
        if (accepted(r)) hits.push(`${e.method} ${e.path} accepted a form post from ${ATTACKER_ORIGIN}`);
      }
      const sameSite = /sameSite\s*:\s*["'](?:strict|lax)["']|SameSite=(?:Strict|Lax)|samesite\s*=\s*["'](?:Strict|Lax)["']/i.test(serverText);
      checks.push(mk('probe-cross-site-post', hits.length && !sameSite ? 'fail' : 'pass', hits.length && !sameSite ? 'A form on another site can change data here using a visitor\'s cookies: no CSRF token, origin check or SameSite cookie stops it.' : hits.length ? 'Cross-site posts are accepted, but the session cookie is SameSite so it is not sent with them.' : 'Form posts from another origin were refused.', { evidence: hits, confidence: 'heuristic', ref: 'https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html' }));
    }
  }

  // 7. Open redirect
  {
    const params = ['next', 'redirect', 'redirect_uri', 'redirectTo', 'url', 'returnTo', 'return', 'continue', 'dest', 'goto'];
    const qs = params.map((p) => `${p}=${enc(`${ATTACKER_ORIGIN}/`)}`).join('&');
    const targets = [...new Set(['/', '/login', '/logout', ...found.reads.filter((e) => /login|logout|redirect|auth|out|go\b/i.test(e.path)).map((e) => fillPathParams(e.path))])].slice(0, 6);
    const hits = [];
    for (const t of targets) {
      const r = await req({ path: `${t}?${qs}` });
      const loc = String(r.headers?.location || '');
      if (r.ok && r.status >= 300 && r.status < 400 && /^(?:https?:)?\/\/attacker\.example/i.test(loc)) hits.push(`GET ${t} redirects to ${loc.slice(0, 60)}`);
    }
    checks.push(mk('probe-open-redirect', hits.length ? 'fail' : 'pass', hits.length ? 'The site forwards visitors to any address placed in the link, which phishing relies on.' : `Tried ${params.length} redirect parameters on ${targets.length} path(s): none left the site.`, { evidence: hits }));
  }

  // 8. Error leaks
  {
    const hits = [];
    const attempts = [
      { path: `/${PROBE_MARKER}-missing/%E0%A4%A` },
      { path: `/api/${PROBE_MARKER}-missing` },
      ...writes.slice(0, 3).map((e) => ({ method: e.method, path: fillPathParams(e.path), headers: { 'content-type': 'application/json' }, body: '{"a":' })),
      ...apiReads.filter((e) => hasPathParam(e.path)).slice(0, 2).map((e) => ({ path: fillPathParams(e.path, '%00') })),
    ];
    for (const a of attempts) {
      const r = await req(a);
      if (r.ok && STACK_RE.test(r.body)) hits.push(`${a.method || 'GET'} ${a.path.slice(0, 60)} (${r.status}): ${r.body.match(STACK_RE)[0].trim().slice(0, 100)}`);
    }
    checks.push(mk('probe-error-leak', hits.length ? 'fail' : 'pass', hits.length ? 'Error responses show a stack trace or server file paths, which maps the app for an attacker.' : `Sent ${attempts.length} malformed requests: error responses gave nothing away.`, { evidence: hits }));
  }

  // 9. Body size limit
  {
    const target = acceptedWrites[0] || writes[0];
    if (!target) {
      checks.push(mk('probe-body-limit', 'na', 'No endpoint that accepts a request body was found.'));
    } else {
      const big = JSON.stringify({ ...buildBody(found.fields, 'x'), [found.fields[0] || 'message']: 'A'.repeat(3 * 1024 * 1024) });
      const r = await req({ method: target.method, path: fillPathParams(target.path), headers: { 'content-type': 'application/json' }, body: big, timeoutMs: 8000 });
      const took = accepted(r);
      checks.push(mk('probe-body-limit', took ? 'fail' : 'pass', took ? `${target.method} ${target.path} accepted a 3 MB body (${r.status}).` : `${target.method} ${target.path} refused a 3 MB body (${r.ok ? r.status : 'connection closed'}).`));
    }
  }

  // 10. Login throttling
  {
    const login = found.writes.find((e) => /(?:log-?in|sign-?in|authenticate|session)s?\/?$/i.test(e.path));
    if (!login) {
      checks.push(mk('probe-login-throttle', 'na', 'The app has no login.'));
    } else {
      let throttled = false;
      let sent = 0;
      for (let i = 0; i < 15 && !throttled && !spent(); i++) {
        const r = await sendWrite(req, login, { email: `${PROBE_MARKER}@example.com`, username: PROBE_MARKER, password: `wrong-${i}` });
        sent++;
        if (r.ok && (r.status === 429 || r.status === 423)) throttled = true;
      }
      checks.push(mk('probe-login-throttle', throttled ? 'pass' : 'fail', throttled ? `${login.path} started refusing after ${sent} failed attempts.` : `${login.path} allowed ${sent} wrong passwords in a row with no slowdown or lockout.`, { ref: 'https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html' }));
    }
  }

  // 11. Still standing. Uses its own request so a spent budget cannot be mistaken for a dead server.
  {
    const after = await request(base, { path: '/', timeoutMs: 8000 });
    requestCount++;
    const up = after.ok && after.status > 0 && after.status < 500;
    checks.push(home.ok
      ? mk('probe-stays-up', up ? 'pass' : 'fail', up ? `The server still answers after ${requestCount} hostile requests.` : `The server stopped answering after the probes (${after.ok ? `status ${after.status}` : after.error}). Bad input can take it down.`)
      : mk('probe-stays-up', 'na', 'The server was not answering before the probes started.'));
  }

  if (spent()) {
    for (const c of checks) {
      if (c.status === 'pass' && c.id !== 'probe-stays-up') c.detail += ' (The probe time budget ran out, so this was only partly tested.)';
    }
  }
  return {
    checks,
    summary: { ran: true, requests: requestCount, endpointsFound: found.endpoints.length, writeEndpoints: writes.map((e) => `${e.method} ${e.path}`), fieldsFound: found.fields.length, budgetSpent: spent() },
  };
}
