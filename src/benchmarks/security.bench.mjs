import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

/**
 * Security pillar, part 1: passive checks.
 *
 * Everything here observes what the generated site ships by default: response headers, cookies, the code it
 * serves, the source the model wrote, and the dependencies it chose. Nothing attacks the site (active probes
 * such as XSS payloads and unauthenticated access are part 2). Every check is one named test with a status,
 * a severity and the evidence behind it, so the report can show each test on its own and roll them up by group.
 */

export const SECURITY_BENCH_VERSION = '1.0.0';

export const SEVERITY_WEIGHT = { critical: 10, high: 6, medium: 3, low: 1 };

export const SECURITY_GROUPS = [
  { id: 'headers', label: 'Response headers & CSP' },
  { id: 'cookies', label: 'Cookies & cross-origin access' },
  { id: 'client', label: 'Client-side code' },
  { id: 'secrets', label: 'Secrets & exposed files' },
  { id: 'dependencies', label: 'Dependencies' },
  { id: 'server', label: 'Server-side code' },
];

function check(id, group, title, severity, status, detail, extra = {}) {
  return {
    id,
    group,
    title,
    severity,
    weight: SEVERITY_WEIGHT[severity],
    status, // pass | fail | na
    detail,
    confidence: extra.confidence || 'measured',
    evidence: (extra.evidence || []).slice(0, 8),
    ...(extra.ref ? { ref: extra.ref } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Content-Security-Policy
// ---------------------------------------------------------------------------------------------------------

export function parseCsp(value) {
  const directives = {};
  for (const part of String(value || '').split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const name = tokens[0].toLowerCase();
    if (!(name in directives)) directives[name] = tokens.slice(1).map((t) => t.toLowerCase());
  }
  return directives;
}

export function extractMetaCsp(html) {
  const m = String(html || '').match(
    /<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*content=(?:"([^"]*)"|'([^']*)')/i
  );
  if (m) return m[1] ?? m[2];
  const rev = String(html || '').match(
    /<meta[^>]+content=(?:"([^"]*)"|'([^']*)')[^>]*http-equiv=["']?content-security-policy["']?/i
  );
  return rev ? rev[1] ?? rev[2] : null;
}

export function evaluateCsp({ headerValue = null, metaValue = null } = {}) {
  const out = [];
  const raw = headerValue || metaValue;
  const ref = 'https://web.dev/articles/strict-csp';
  if (!raw) {
    out.push(check('csp-present', 'headers', 'Has a Content Security Policy', 'high', 'fail', 'No CSP header or <meta> policy.', { ref }));
    for (const [id, title, sev] of [
      ['csp-no-unsafe-inline', 'CSP blocks inline script', 'high'],
      ['csp-no-unsafe-eval', 'CSP blocks eval()', 'medium'],
      ['csp-no-wildcard-sources', 'CSP script sources are specific', 'medium'],
      ['csp-object-base-restricted', 'CSP restricts object-src and base-uri', 'low'],
    ]) {
      out.push(check(id, 'headers', title, sev, 'fail', 'No policy, so nothing is restricted.', { ref }));
    }
    return out;
  }
  const d = parseCsp(raw);
  const via = headerValue ? 'header' : 'meta';
  out.push(check('csp-present', 'headers', 'Has a Content Security Policy', 'high', 'pass', `Policy delivered by ${via}.`, { evidence: [raw.slice(0, 300)], ref }));

  const script = d['script-src'] || d['default-src'] || null;
  const hasNonceOrHash = (script || []).some((t) => /^'(?:nonce-|sha(?:256|384|512)-)/.test(t));
  const strictDynamic = (script || []).includes("'strict-dynamic'");
  if (!script) {
    out.push(check('csp-no-unsafe-inline', 'headers', 'CSP blocks inline script', 'high', 'fail', 'Policy has no script-src or default-src, so scripts are unrestricted.', { ref }));
    out.push(check('csp-no-unsafe-eval', 'headers', 'CSP blocks eval()', 'medium', 'fail', 'Policy has no script-src or default-src.', { ref }));
    out.push(check('csp-no-wildcard-sources', 'headers', 'CSP script sources are specific', 'medium', 'fail', 'Policy has no script-src or default-src.', { ref }));
  } else {
    // 'unsafe-inline' is ignored by browsers when a nonce or hash is present.
    const inlineAllowed = script.includes("'unsafe-inline'") && !hasNonceOrHash;
    out.push(check('csp-no-unsafe-inline', 'headers', 'CSP blocks inline script', 'high', inlineAllowed ? 'fail' : 'pass', inlineAllowed ? "script-src allows 'unsafe-inline' with no nonce or hash." : hasNonceOrHash ? 'Inline script needs a nonce or hash.' : 'Inline script is not allowed.', { evidence: [script.join(' ')], ref }));
    const evalAllowed = script.includes("'unsafe-eval'");
    out.push(check('csp-no-unsafe-eval', 'headers', 'CSP blocks eval()', 'medium', evalAllowed ? 'fail' : 'pass', evalAllowed ? "script-src allows 'unsafe-eval'." : 'eval() is not allowed.', { ref }));
    const wild = script.filter((t) => t === '*' || t === 'https:' || t === 'http:' || t === 'data:' || t === 'blob:');
    const wildMatters = wild.length > 0 && !strictDynamic;
    out.push(check('csp-no-wildcard-sources', 'headers', 'CSP script sources are specific', 'medium', wildMatters ? 'fail' : 'pass', wildMatters ? `script-src allows broad sources: ${wild.join(' ')}.` : 'No wildcard or scheme-only script sources.', { ref }));
  }
  const objectOk = (d['object-src'] || d['default-src'] || []).some((t) => t === "'none'" || t === "'self'");
  const baseOk = (d['base-uri'] || []).some((t) => t === "'none'" || t === "'self'");
  out.push(check('csp-object-base-restricted', 'headers', 'CSP restricts object-src and base-uri', 'low', objectOk && baseOk ? 'pass' : 'fail', objectOk && baseOk ? 'Both are restricted.' : `Missing: ${[!objectOk && 'object-src', !baseOk && 'base-uri'].filter(Boolean).join(', ')}.`, { ref }));
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Other response headers
// ---------------------------------------------------------------------------------------------------------

const SAFE_REFERRER = new Set(['no-referrer', 'same-origin', 'strict-origin', 'strict-origin-when-cross-origin', 'origin', 'origin-when-cross-origin', 'no-referrer-when-downgrade']);

/**
 * `ownsServer` is false when the benchmark's own static file server delivered the response. Headers that only
 * a server can send are then "not applicable": the model produced files, not a server.
 */
export function evaluateHeaders(headers = {}, { ownsServer = true, html = '' } = {}) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(', ') : String(v ?? '')]));
  const out = [];
  const na = (id, title, sev) => out.push(check(id, 'headers', title, sev, 'na', 'Static files only: this header can only be set by a server.'));

  const csp = parseCsp(h['content-security-policy'] || '');
  const frameAncestors = csp['frame-ancestors'];
  const xfo = (h['x-frame-options'] || '').toLowerCase();
  if (!ownsServer) na('clickjacking-protection', 'Cannot be framed by other sites', 'medium');
  else {
    const ok = Boolean(frameAncestors && !frameAncestors.includes('*')) || /^(deny|sameorigin)$/.test(xfo.trim());
    out.push(check('clickjacking-protection', 'headers', 'Cannot be framed by other sites', 'medium', ok ? 'pass' : 'fail', ok ? (frameAncestors ? `CSP frame-ancestors ${frameAncestors.join(' ')}.` : `X-Frame-Options: ${xfo}.`) : 'No frame-ancestors directive or X-Frame-Options header.', { ref: 'https://developer.mozilla.org/docs/Web/HTTP/Headers/Content-Security-Policy/frame-ancestors' }));
  }

  if (!ownsServer) na('nosniff', 'Disables MIME type sniffing', 'medium');
  else {
    const ok = (h['x-content-type-options'] || '').toLowerCase().trim() === 'nosniff';
    out.push(check('nosniff', 'headers', 'Disables MIME type sniffing', 'medium', ok ? 'pass' : 'fail', ok ? 'X-Content-Type-Options: nosniff.' : 'X-Content-Type-Options: nosniff is missing.'));
  }

  const metaRef = String(html).match(/<meta[^>]+name=["']referrer["'][^>]*content=["']([^"']+)["']/i)?.[1];
  const refPolicy = (h['referrer-policy'] || metaRef || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean).pop();
  {
    const ok = Boolean(refPolicy) && SAFE_REFERRER.has(refPolicy) && refPolicy !== 'no-referrer-when-downgrade';
    out.push(check('referrer-policy', 'headers', 'Sets a referrer policy', 'low', ok ? 'pass' : 'fail', refPolicy ? `Referrer policy: ${refPolicy}.` : 'No Referrer-Policy header or <meta name="referrer">.'));
  }

  if (!ownsServer) na('permissions-policy', 'Limits powerful browser features', 'low');
  else {
    const ok = Boolean(h['permissions-policy']);
    out.push(check('permissions-policy', 'headers', 'Limits powerful browser features', 'low', ok ? 'pass' : 'fail', ok ? `Permissions-Policy: ${h['permissions-policy'].slice(0, 160)}.` : 'No Permissions-Policy header.'));
  }

  if (!ownsServer) na('no-version-disclosure', 'Does not advertise server software versions', 'low');
  else {
    const leaks = [];
    if (h['x-powered-by']) leaks.push(`X-Powered-By: ${h['x-powered-by']}`);
    if (/\d+\.\d+/.test(h.server || '')) leaks.push(`Server: ${h.server}`);
    out.push(check('no-version-disclosure', 'headers', 'Does not advertise server software versions', 'low', leaks.length ? 'fail' : 'pass', leaks.length ? 'Response names the server stack.' : 'No X-Powered-By or versioned Server header.', { evidence: leaks }));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Cookies and CORS
// ---------------------------------------------------------------------------------------------------------

export function parseSetCookie(line) {
  const parts = String(line || '').split(';').map((p) => p.trim());
  const [nameValue, ...attrs] = parts;
  const eq = nameValue.indexOf('=');
  const flags = new Map(attrs.map((a) => { const i = a.indexOf('='); return i < 0 ? [a.toLowerCase(), true] : [a.slice(0, i).toLowerCase(), a.slice(i + 1)]; }));
  return {
    name: eq < 0 ? nameValue : nameValue.slice(0, eq),
    httpOnly: flags.has('httponly'),
    secure: flags.has('secure'),
    sameSite: flags.has('samesite') ? String(flags.get('samesite')).toLowerCase() : null,
  };
}

const PREFERENCE_COOKIE_RE = /^(?:theme|lang|locale|i18n|consent|cookie[-_]?consent|color[-_]?scheme|sidebar|tz|timezone)/i;

export function evaluateCookies(setCookieLines = []) {
  const cookies = setCookieLines.map(parseSetCookie).filter((c) => c.name);
  if (cookies.length === 0) {
    return [
      check('cookie-httponly', 'cookies', 'Session cookies are HttpOnly', 'high', 'na', 'No cookies were set on the pages checked.'),
      check('cookie-samesite', 'cookies', 'Cookies declare SameSite', 'medium', 'na', 'No cookies were set on the pages checked.'),
    ];
  }
  const sessionLike = cookies.filter((c) => !PREFERENCE_COOKIE_RE.test(c.name));
  const notHttpOnly = sessionLike.filter((c) => !c.httpOnly);
  const noSameSite = cookies.filter((c) => !c.sameSite || (c.sameSite === 'none' && !c.secure));
  return [
    sessionLike.length === 0
      ? check('cookie-httponly', 'cookies', 'Session cookies are HttpOnly', 'high', 'na', 'Only preference cookies were set.')
      : check('cookie-httponly', 'cookies', 'Session cookies are HttpOnly', 'high', notHttpOnly.length ? 'fail' : 'pass', notHttpOnly.length ? `${notHttpOnly.length} cookie(s) readable from JavaScript.` : 'Every session cookie is HttpOnly.', { evidence: notHttpOnly.map((c) => c.name) }),
    check('cookie-samesite', 'cookies', 'Cookies declare SameSite', 'medium', noSameSite.length ? 'fail' : 'pass', noSameSite.length ? `${noSameSite.length} cookie(s) with no usable SameSite attribute.` : 'Every cookie declares SameSite.', { evidence: noSameSite.map((c) => c.name) }),
  ];
}

export function evaluateCors(responses = [], probeOrigin = 'https://attacker.example') {
  const bad = [];
  for (const r of responses) {
    const acao = (r.headers['access-control-allow-origin'] || '').trim();
    const creds = (r.headers['access-control-allow-credentials'] || '').trim().toLowerCase() === 'true';
    if (creds && (acao === '*' || acao === probeOrigin)) bad.push(`${r.path}: allows ${acao} with credentials`);
  }
  if (responses.length === 0) return [check('cors-no-credentialed-wildcard', 'cookies', 'Does not share credentialed responses with any origin', 'high', 'na', 'No responses to check.')];
  return [check('cors-no-credentialed-wildcard', 'cookies', 'Does not share credentialed responses with any origin', 'high', bad.length ? 'fail' : 'pass', bad.length ? 'An arbitrary origin can read responses that carry the user\'s cookies.' : `Checked ${responses.length} response(s) with a foreign Origin header.`, { evidence: bad })];
}

// ---------------------------------------------------------------------------------------------------------
// File walking
// ---------------------------------------------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', '.git', '.bench-reference', '.next', '.nuxt', '.svelte-kit', '.cache', '__pycache__', '.venv', 'venv', 'coverage', '.turbo']);
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte', '.astro', '.html', '.htm', '.css', '.json', '.py', '.rb', '.php', '.go', '.rs', '.java', '.env', '.yml', '.yaml', '.toml', '.sh', '.sql', '.ejs', '.hbs', '.njk', '.txt', '.md', '']);

export function walkTextFiles(root, { maxFiles = 600, maxBytes = 1_500_000 } = {}) {
  const out = [];
  if (!root || !existsSync(root)) return out;
  const stack = [root];
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop();
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(abs); continue; }
      if (!e.isFile()) continue;
      const ext = e.name.startsWith('.env') ? '.env' : extname(e.name).toLowerCase();
      if (!TEXT_EXT.has(ext)) continue;
      if (/^(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/.test(e.name)) continue;
      let size = 0;
      try { size = statSync(abs).size; } catch { continue; }
      if (size === 0 || size > maxBytes) continue;
      let text = '';
      try { text = readFileSync(abs, 'utf8'); } catch { continue; }
      out.push({ path: relative(root, abs), name: e.name, ext, text });
      if (out.length >= maxFiles) break;
    }
  }
  return out;
}

export function looksMinified(file) {
  if (/\.min\.|(?:^|\/)(?:vendor|chunk|bundle)[.-]|-[a-f0-9]{8,}\.js$/i.test(file.path)) return true;
  const lines = file.text.split('\n');
  return file.text.length > 4000 && file.text.length / lines.length > 400;
}

const SERVER_HINT_RE = /\b(?:require\(['"](?:express|http|https|fastify|koa|hono|better-sqlite3|sqlite3|pg|mysql2?)['"]\)|from ['"](?:express|node:http|http|fastify|koa|hono|@hono\/node-server|better-sqlite3|sqlite3|pg|mysql2?)['"]|createServer\(|app\.(?:get|post|put|delete|use)\(|from flask import|import flask|from fastapi|django\.|http\.HandleFunc|Sinatra::|\$_(?:GET|POST|REQUEST)\b)/;

export function isServerFile(file) {
  if (['.py', '.rb', '.php', '.go', '.rs', '.java'].includes(file.ext)) return true;
  if (!['.js', '.mjs', '.cjs', '.ts'].includes(file.ext)) return false;
  return SERVER_HINT_RE.test(file.text);
}

// ---------------------------------------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------------------------------------

export const SECRET_RULES = [
  { id: 'private-key', label: 'Private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { id: 'aws-access-key', label: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'github-token', label: 'GitHub token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/ },
  { id: 'stripe-secret', label: 'Stripe secret key', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/ },
  { id: 'llm-api-key', label: 'LLM provider API key', re: /\bsk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{32,}\b/ },
  { id: 'google-api-key', label: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'slack-token', label: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'db-url-with-password', label: 'Database URL with password', re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s:@/'"]+:[^\s@/'"]{4,}@[^\s'"]+/ },
  {
    id: 'hardcoded-secret',
    label: 'Hard-coded secret value',
    // e.g. JWT_SECRET = "s3cr3t-value", sessionSecret: 'keyboard cat'
    re: /\b(?:jwt|session|cookie|auth|token|api|app|signing|encryption)[_-]?(?:secret|key|password)\b\s*[:=]\s*(?:process\.env\.[A-Z0-9_]+\s*(?:\|\||\?\?)\s*)?["'`]([^"'`\s]{8,}|[^"'`]{12,})["'`]/i,
    valueGroup: 1,
  },
];

const PLACEHOLDER_RE = /^(?:x{4,}|\*{4,}|<[^>]+>|your[-_ ]|change[-_ ]?me|replace|example|placeholder|todo|dummy|test|demo-|\$\{|process\.env)/i;

export function scanSecrets(files) {
  const findings = [];
  for (const f of files) {
    if (/\.(?:md|txt)$/i.test(f.name) || /\.env\.(?:example|sample|template)$/i.test(f.name)) continue;
    for (const rule of SECRET_RULES) {
      const m = f.text.match(rule.re);
      if (!m) continue;
      const value = rule.valueGroup ? m[rule.valueGroup] : m[0];
      if (PLACEHOLDER_RE.test(value)) continue;
      const line = f.text.slice(0, m.index).split('\n').length;
      findings.push({ rule: rule.id, label: rule.label, file: f.path, line, preview: `${value.slice(0, 4)}…(${value.length} chars)` });
    }
  }
  return findings;
}

export const SENSITIVE_PATHS = [
  { path: '/.env', severity: 'critical', label: 'environment file', test: (b, ct) => !/html/i.test(ct) && /^[A-Za-z_][A-Za-z0-9_]*\s*=\s*\S+/m.test(b) },
  { path: '/.env.local', severity: 'critical', label: 'environment file', test: (b, ct) => !/html/i.test(ct) && /^[A-Za-z_][A-Za-z0-9_]*\s*=\s*\S+/m.test(b) },
  { path: '/.git/HEAD', severity: 'critical', label: 'git repository', test: (b) => /^ref: refs\//.test(b) || /^[0-9a-f]{40}\s*$/.test(b) },
  { path: '/.git/config', severity: 'critical', label: 'git repository', test: (b) => /\[core\]/.test(b) },
  { path: '/database.sqlite', severity: 'critical', label: 'database file', test: (b) => b.startsWith('SQLite format 3') },
  { path: '/db.sqlite', severity: 'critical', label: 'database file', test: (b) => b.startsWith('SQLite format 3') },
  { path: '/data.db', severity: 'critical', label: 'database file', test: (b) => b.startsWith('SQLite format 3') },
  { path: '/server.js', severity: 'high', label: 'server source', test: (b, ct) => !/html/i.test(ct) && SERVER_HINT_RE.test(b) },
  { path: '/package.json', severity: 'low', label: 'package manifest', test: (b) => /"(?:dependencies|scripts)"\s*:/.test(b) },
];

// ---------------------------------------------------------------------------------------------------------
// Client-side code
// ---------------------------------------------------------------------------------------------------------

const SINK_RE = /\.(?:innerHTML|outerHTML)\s*\+?=\s*(?!["'`]\s*["'`]|["'][^"'$+]*["']\s*;?\s*$)|\.insertAdjacentHTML\(|document\.write(?:ln)?\(|dangerouslySetInnerHTML|\bv-html=|\{@html\s/;
const DYNAMIC_HTML_RE = /(?:innerHTML|outerHTML)\s*\+?=\s*[^;\n]*(?:\$\{|\+\s*[A-Za-z_$])|insertAdjacentHTML\([^)]*(?:\$\{|\+\s*[A-Za-z_$])|document\.write(?:ln)?\([^)]*(?:\$\{|\+\s*[A-Za-z_$])|dangerouslySetInnerHTML|\bv-html=|\{@html\s/g;
const ESCAPE_HINT_RE = /\b(?:escapeHtml|escapeHTML|escape_html|sanitize\w*|DOMPurify|setHTML\(|textContent|createTextNode|encodeHtml|htmlEscape|he\.encode)\b/;

export function scanClientCode({ html = '', files = [] } = {}) {
  const out = [];
  const clientFiles = files.filter((f) => !isServerFile(f) && ['.js', '.mjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte', '.astro', '.html', '.htm'].includes(f.ext) && !looksMinified(f));

  // Unescaped dynamic HTML
  const sinkHits = [];
  for (const f of clientFiles) {
    if (!SINK_RE.test(f.text)) continue;
    const dyn = f.text.match(DYNAMIC_HTML_RE) || [];
    if (dyn.length > 0 && !ESCAPE_HINT_RE.test(f.text)) sinkHits.push(`${f.path}: ${dyn.length} dynamic HTML write(s), no escaping helper in the file`);
  }
  out.push(
    clientFiles.length === 0
      ? check('no-unescaped-html-sinks', 'client', 'Does not build HTML from unescaped data', 'high', 'na', 'No readable client source to inspect.', { confidence: 'heuristic' })
      : check('no-unescaped-html-sinks', 'client', 'Does not build HTML from unescaped data', 'high', sinkHits.length ? 'fail' : 'pass', sinkHits.length ? 'Dynamic values are written into HTML with no sign of escaping.' : 'No dynamic HTML writes without an escaping helper.', { confidence: 'heuristic', evidence: sinkHits, ref: 'https://web.dev/articles/trusted-types' })
  );

  // eval and friends
  const evalHits = [];
  for (const f of clientFiles) {
    const m = f.text.match(/\beval\s*\(|\bnew Function\s*\(|set(?:Timeout|Interval)\s*\(\s*["'`]/g);
    if (m) evalHits.push(`${f.path}: ${[...new Set(m.map((x) => x.replace(/\s+/g, '')))].join(' ')}`);
  }
  out.push(
    clientFiles.length === 0
      ? check('no-eval', 'client', 'Does not evaluate strings as code', 'medium', 'na', 'No readable client source to inspect.')
      : check('no-eval', 'client', 'Does not evaluate strings as code', 'medium', evalHits.length ? 'fail' : 'pass', evalHits.length ? 'Uses eval(), new Function() or a string timer.' : 'No eval(), new Function() or string timers.', { evidence: evalHits })
  );

  // Inline event handlers (they force 'unsafe-inline')
  const inlineHandlers = (html.match(/<[a-z][^>]*\son(?:click|load|error|submit|change|input|mouseover|focus|blur|keydown|keyup)\s*=/gi) || []).length;
  out.push(check('no-inline-event-handlers', 'client', 'No inline event handler attributes', 'low', inlineHandlers ? 'fail' : 'pass', inlineHandlers ? `${inlineHandlers} inline handler attribute(s) in the served HTML, which a strict CSP would block.` : 'No onclick-style attributes in the served HTML.'));

  // Third-party scripts and styles without Subresource Integrity
  const external = [];
  const tagRe = /<(script|link)\b([^>]*)>/gi;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const attrs = m[2];
    const url = attrs.match(/\b(?:src|href)=["']((?:https?:)?\/\/[^"']+)["']/i)?.[1];
    if (!url) continue;
    if (m[1].toLowerCase() === 'link' && !/rel=["']?(?:stylesheet|modulepreload|preload)/i.test(attrs)) continue;
    if (/fonts\.googleapis\.com/i.test(url)) continue; // responses vary by browser, so SRI cannot apply
    external.push({ url, hasIntegrity: /\bintegrity=["'][^"']+["']/i.test(attrs) });
  }
  const noSri = external.filter((e) => !e.hasIntegrity);
  out.push(
    external.length === 0
      ? check('third-party-sri', 'client', 'Third-party scripts and styles are integrity-checked', 'medium', 'pass', 'No third-party scripts or stylesheets: everything is served from the site itself.')
      : check('third-party-sri', 'client', 'Third-party scripts and styles are integrity-checked', 'medium', noSri.length ? 'fail' : 'pass', noSri.length ? `${noSri.length} of ${external.length} third-party resource(s) load without an integrity hash.` : `All ${external.length} third-party resource(s) carry an integrity hash.`, { evidence: noSri.map((e) => e.url), ref: 'https://developer.mozilla.org/docs/Web/Security/Subresource_Integrity' })
  );

  // Mixed content: resources and form targets over plain http (ordinary outbound links are not counted)
  const insecure = [];
  for (const t of html.matchAll(/<(script|img|iframe|video|audio|source|link|form)\b[^>]*\b(?:src|href|action)=["'](http:\/\/(?!localhost|127\.0\.0\.1)[^"']+)["']/gi)) {
    if (!insecure.includes(t[2])) insecure.push(t[2]);
  }
  out.push(check('no-insecure-urls', 'client', 'No plain-http resources or form targets', 'medium', insecure.length ? 'fail' : 'pass', insecure.length ? `${insecure.length} resource(s) or form target(s) use http://.` : 'No resources or forms use http://.', { evidence: insecure }));

  // Password fields
  const pwInputs = html.match(/<input\b[^>]*type=["']password["'][^>]*>/gi) || [];
  if (pwInputs.length > 0) {
    const noAutocomplete = pwInputs.filter((t) => !/\bautocomplete=["'](?:current-password|new-password|off)["']/i.test(t));
    out.push(check('password-autocomplete', 'client', 'Password fields declare autocomplete', 'low', noAutocomplete.length ? 'fail' : 'pass', noAutocomplete.length ? `${noAutocomplete.length} password field(s) without autocomplete="current-password" or "new-password".` : 'Password fields help password managers with an autocomplete hint.', { ref: 'https://web.dev/articles/sign-in-form-best-practices' }));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Server-side code (static heuristics; active probes confirm these in part 2)
// ---------------------------------------------------------------------------------------------------------

const SQL_VERB = '(?:SELECT\\b[^`\\n]*\\bFROM|INSERT\\s+INTO|UPDATE\\s+\\w+\\s+SET|DELETE\\s+FROM)';
// Interpolations that build query structure (a list of "?" marks, column names) rather than inject values.
const STRUCTURAL_INTERPOLATION_RE = /^\s*(?:placeholders?|marks|qs|cols?|columns?|fields?|sets?|setClause|updates|table|tableName|where|whereClause|conditions?|clauses?|orderBy|order|sort|sortColumn|dir|direction|limit|offset)\b[\w.]*(?:\.join\([^)]*\))?\s*$|\.map\([^)]*=>\s*['"]\?['"]\)\.join/;
const SQL_TEMPLATE_RE = new RegExp('`[^`]*\\b' + SQL_VERB + '\\b[^`]*`', 'gi');
const SQL_CONCAT_RE = new RegExp('["\']\\s*' + SQL_VERB + '\\b[^\\n]*["\']\\s*\\+\\s*(?:req\\.|request\\.|params\\b|query\\b|body\\b|\\w*[iI]d\\b|\\w*[nN]ame\\b|search\\w*|term\\b|email\\b|username\\b)', 'i');

export function findSqlStringBuilding(text) {
  const hits = [];
  for (const m of text.matchAll(SQL_TEMPLATE_RE)) {
    const unsafe = [...m[0].matchAll(/\$\{([^}]+)\}/g)].map((x) => x[1]).filter((expr) => !STRUCTURAL_INTERPOLATION_RE.test(expr));
    if (unsafe.length > 0) hits.push({ line: text.slice(0, m.index).split('\n').length, snippet: m[0].replace(/\s+/g, ' ').slice(0, 140) });
  }
  for (const [i, line] of text.split('\n').entries()) {
    if (SQL_CONCAT_RE.test(line)) hits.push({ line: i + 1, snippet: line.trim().slice(0, 140) });
  }
  return hits;
}
const PY_SQL_FORMAT_RE = /(?:execute|executemany)\(\s*f["'][^"']*(?:SELECT|INSERT|UPDATE|DELETE)[^"']*\{|(?:SELECT|INSERT|UPDATE|DELETE)[^"'\n]*["']\s*%\s*\(|\.format\([^)]*\)\s*\)/i;

export function scanServerCode(files = []) {
  const serverFiles = files.filter((f) => isServerFile(f) && !looksMinified(f));
  if (serverFiles.length === 0) {
    return ['no-sql-string-building', 'password-hashing', 'no-shell-injection', 'no-stack-traces-to-client'].map((id) =>
      check(id, 'server', { 'no-sql-string-building': 'Database queries use parameters', 'password-hashing': 'Passwords are hashed with a slow algorithm', 'no-shell-injection': 'Request data is never passed to a shell', 'no-stack-traces-to-client': 'Errors do not leak stack traces' }[id], id === 'no-stack-traces-to-client' ? 'low' : id === 'password-hashing' ? 'critical' : 'high', 'na', 'No server-side code in this build.', { confidence: 'heuristic' })
    );
  }
  const out = [];
  const all = serverFiles.map((f) => f.text).join('\n');

  const usesSql = /\b(?:SELECT\b[^\n]*\bFROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i.test(all);
  const sqlHits = [];
  for (const f of serverFiles) {
    for (const h of findSqlStringBuilding(f.text)) sqlHits.push(`${f.path}:${h.line}: ${h.snippet}`);
    if (f.ext === '.py') {
      for (const [i, line] of f.text.split('\n').entries()) {
        if (PY_SQL_FORMAT_RE.test(line)) sqlHits.push(`${f.path}:${i + 1}: ${line.trim().slice(0, 140)}`);
      }
    }
  }
  out.push(usesSql
    ? check('no-sql-string-building', 'server', 'Database queries use parameters', 'high', sqlHits.length ? 'fail' : 'pass', sqlHits.length ? 'SQL text is assembled from variables instead of bound parameters.' : 'SQL statements use placeholders.', { confidence: 'heuristic', evidence: sqlHits, ref: 'https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html' })
    : check('no-sql-string-building', 'server', 'Database queries use parameters', 'high', 'na', 'No SQL in the server code.', { confidence: 'heuristic' }));

  const handlesPasswords = /\bpassword\b/i.test(all) && /(?:register|signup|sign_up|login|signin|sign_in|createUser|users?\b)/i.test(all);
  if (!handlesPasswords) {
    out.push(check('password-hashing', 'server', 'Passwords are hashed with a slow algorithm', 'critical', 'na', 'The server does not handle passwords.', { confidence: 'heuristic' }));
  } else {
    const slow = /\b(?:bcrypt|argon2|scrypt|pbkdf2|werkzeug\.security|passlib|password_hash\(|generate_password_hash)\b/i.test(all);
    const fast = all.match(/createHash\(\s*["'](?:md5|sha1|sha256|sha512)["']\s*\)|hashlib\.(?:md5|sha1|sha256)|\bmd5\(/i);
    const status = slow ? 'pass' : 'fail';
    out.push(check('password-hashing', 'server', 'Passwords are hashed with a slow algorithm', 'critical', status, slow ? 'Uses bcrypt, argon2, scrypt or PBKDF2.' : fast ? `Passwords go through a fast hash (${fast[0]}), which is quick to brute-force.` : 'Passwords are handled with no sign of a password-hashing function.', { confidence: 'heuristic', ref: 'https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html' }));
  }

  const shellHits = [];
  for (const f of serverFiles) {
    for (const [i, line] of f.text.split('\n').entries()) {
      if (/\b(?:exec|execSync|spawnSync|spawn|os\.system|subprocess\.(?:run|call|Popen)|shell_exec|system)\s*\([^)]*(?:req\.|request\.|\$\{|params|query\b|body\b|\$_(?:GET|POST))/.test(line) && !/execFile/.test(line)) {
        shellHits.push(`${f.path}:${i + 1}: ${line.trim().slice(0, 140)}`);
      }
    }
  }
  out.push(check('no-shell-injection', 'server', 'Request data is never passed to a shell', 'high', shellHits.length ? 'fail' : 'pass', shellHits.length ? 'A shell command is built from request data.' : 'No shell commands built from request data.', { confidence: 'heuristic', evidence: shellHits }));

  const traceHits = [];
  for (const f of serverFiles) {
    for (const [i, line] of f.text.split('\n').entries()) {
      if (/(?:res\.(?:send|json|end|write)|return\s+(?:jsonify|JSONResponse))\s*\([^)]*(?:err|error|e)\.stack\b/.test(line)) traceHits.push(`${f.path}:${i + 1}: ${line.trim().slice(0, 140)}`);
    }
  }
  if (/app\.run\([^)]*debug\s*=\s*True/.test(all)) traceHits.push('Flask debug mode is on (interactive debugger exposed).');
  out.push(check('no-stack-traces-to-client', 'server', 'Errors do not leak stack traces', 'low', traceHits.length ? 'fail' : 'pass', traceHits.length ? 'Error responses include internals.' : 'Error responses do not send stack traces.', { confidence: 'heuristic', evidence: traceHits }));
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------------------------------------

const exactVersion = (spec) => String(spec || '').trim().match(/^[\^~=v]*\s*(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/)?.[1] || null;

export function collectDependencies(sourceDir, html = '') {
  const deps = [];
  const seen = new Set();
  const add = (d) => { const k = `${d.ecosystem}:${d.name}@${d.version}`; if (!seen.has(k) && d.version) { seen.add(k); deps.push(d); } };
  let hasManifest = false;
  let hasLockfile = false;

  const pkgPath = sourceDir ? join(sourceDir, 'package.json') : null;
  if (pkgPath && existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const prod = pkg.dependencies || {};
      hasManifest = Object.keys(prod).length > 0;
      hasLockfile = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock'].some((f) => existsSync(join(sourceDir, f)));
      let lock = null;
      try { lock = JSON.parse(readFileSync(join(sourceDir, 'package-lock.json'), 'utf8')); } catch { lock = null; }
      for (const [name, spec] of Object.entries(prod)) {
        let version = null;
        let source = 'installed';
        try { version = JSON.parse(readFileSync(join(sourceDir, 'node_modules', name, 'package.json'), 'utf8')).version; } catch { version = null; }
        if (!version && lock?.packages?.[`node_modules/${name}`]?.version) { version = lock.packages[`node_modules/${name}`].version; source = 'lockfile'; }
        if (!version) { version = exactVersion(spec); source = 'manifest-range'; }
        add({ ecosystem: 'npm', name, version, source, declared: String(spec) });
      }
    } catch {
      // unreadable manifest: treated as no dependencies
    }
  }
  const reqPath = sourceDir ? join(sourceDir, 'requirements.txt') : null;
  if (reqPath && existsSync(reqPath)) {
    hasManifest = true;
    for (const line of readFileSync(reqPath, 'utf8').split('\n')) {
      const m = line.trim().match(/^([A-Za-z0-9_.-]+)\s*==\s*([0-9][^\s;#]*)/);
      if (m) add({ ecosystem: 'PyPI', name: m[1], version: m[2], source: 'requirements.txt', declared: line.trim() });
    }
  }
  // Libraries loaded from a CDN with a version in the URL
  for (const m of String(html).matchAll(/(?:cdn\.jsdelivr\.net\/npm|unpkg\.com|esm\.sh|cdn\.skypack\.dev)\/((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@(\d+\.\d+\.\d+)/gi)) {
    add({ ecosystem: 'npm', name: m[1], version: m[2], source: 'cdn-url' });
  }
  for (const m of String(html).matchAll(/cdnjs\.cloudflare\.com\/ajax\/libs\/([a-z0-9._-]+)\/(\d+\.\d+\.\d+)\//gi)) {
    add({ ecosystem: 'npm', name: m[1], version: m[2], source: 'cdn-url' });
  }
  return { deps, hasManifest, hasLockfile };
}

export async function queryOsv(deps, { fetchImpl = globalThis.fetch, timeoutMs = 12000 } = {}) {
  if (deps.length === 0) return { ok: true, vulnerable: [] };
  try {
    const res = await fetchImpl('https://api.osv.dev/v1/querybatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ queries: deps.map((d) => ({ package: { name: d.name, ecosystem: d.ecosystem }, version: d.version })) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, error: `OSV responded ${res.status}` };
    const body = await res.json();
    const vulnerable = [];
    (body.results || []).forEach((r, i) => {
      const ids = (r?.vulns || []).map((v) => v.id);
      if (ids.length > 0) vulnerable.push({ ...deps[i], advisories: ids.slice(0, 6), advisoryCount: ids.length });
    });
    return { ok: true, vulnerable };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export function evaluateDependencies({ deps, hasManifest, hasLockfile }, osv) {
  const out = [];
  if (deps.length === 0) {
    out.push(check('no-known-vulnerable-dependencies', 'dependencies', 'No dependencies with known advisories', 'high', 'pass', 'No third-party packages: nothing to patch.'));
  } else if (!osv?.ok) {
    out.push(check('no-known-vulnerable-dependencies', 'dependencies', 'No dependencies with known advisories', 'high', 'na', `Advisory lookup was unavailable (${osv?.error || 'skipped'}).`, { evidence: deps.map((d) => `${d.name}@${d.version}`) }));
  } else {
    const v = osv.vulnerable;
    out.push(check('no-known-vulnerable-dependencies', 'dependencies', 'No dependencies with known advisories', 'high', v.length ? 'fail' : 'pass', v.length ? `${v.length} of ${deps.length} package(s) have published advisories at the version used.` : `Checked ${deps.length} package(s) against OSV: no advisories.`, { evidence: v.map((d) => `${d.name}@${d.version} (${d.source}): ${d.advisories.join(', ')}${d.advisoryCount > d.advisories.length ? ', …' : ''}`), ref: 'https://osv.dev' }));
  }
  out.push(hasManifest
    ? check('dependencies-locked', 'dependencies', 'Dependency versions are locked', 'low', hasLockfile || deps.every((d) => d.ecosystem === 'PyPI') ? 'pass' : 'fail', hasLockfile ? 'A lockfile pins the dependency tree.' : deps.every((d) => d.ecosystem === 'PyPI') ? 'requirements.txt pins exact versions.' : 'No lockfile: each install can resolve different versions.')
    : check('dependencies-locked', 'dependencies', 'Dependency versions are locked', 'low', 'na', 'No package manifest.'));
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------------------------------------

export function scoreSecurityChecks(checks = []) {
  const applicable = checks.filter((c) => c.status === 'pass' || c.status === 'fail');
  const total = applicable.reduce((n, c) => n + c.weight, 0);
  const passed = applicable.filter((c) => c.status === 'pass').reduce((n, c) => n + c.weight, 0);
  const criticalFailures = applicable.filter((c) => c.status === 'fail' && c.severity === 'critical');
  let overall = total > 0 ? Math.round((passed / total) * 1000) / 10 : null;
  // A leaked secret or plaintext passwords outweigh any number of tidy headers.
  if (overall !== null && criticalFailures.length > 0) overall = Math.min(overall, criticalFailures.length > 1 ? 35 : 50);

  const groups = SECURITY_GROUPS.map((g) => {
    const inGroup = checks.filter((c) => c.group === g.id);
    const app = inGroup.filter((c) => c.status !== 'na');
    const gt = app.reduce((n, c) => n + c.weight, 0);
    const gp = app.filter((c) => c.status === 'pass').reduce((n, c) => n + c.weight, 0);
    return {
      id: g.id,
      label: g.label,
      score: gt > 0 ? Math.round((gp / gt) * 1000) / 10 : null,
      passed: app.filter((c) => c.status === 'pass').length,
      failed: app.filter((c) => c.status === 'fail').length,
      notApplicable: inGroup.length - app.length,
    };
  });
  return {
    overall,
    passed: applicable.filter((c) => c.status === 'pass').length,
    failed: applicable.filter((c) => c.status === 'fail').length,
    notApplicable: checks.length - applicable.length,
    criticalFailures: criticalFailures.map((c) => c.id),
    groups,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------------------------------------

async function get(url, { headers = {}, timeoutMs = 6000, maxBytes = 400_000 } = {}) {
  try {
    const res = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    const buf = Buffer.from(await res.arrayBuffer());
    const hdrs = {};
    res.headers.forEach((v, k) => { hdrs[k.toLowerCase()] = v; });
    return { ok: true, status: res.status, headers: hdrs, setCookie: res.headers.getSetCookie?.() || [], body: buf.subarray(0, maxBytes).toString('latin1') };
  } catch (err) {
    return { ok: false, status: 0, headers: {}, setCookie: [], body: '', error: err.message };
  }
}

export function resolveSourceDir(cellDir, materialization) {
  const candidates = [materialization?.runtimeDirRel && join(cellDir, materialization.runtimeDirRel), join(cellDir, 'agent-workspace'), join(cellDir, 'extracted'), materialization?.distDir, join(cellDir, 'dist')].filter(Boolean);
  return candidates.find((d) => existsSync(d)) || null;
}

export default {
  id: 'security',
  label: 'Security (passive checks)',
  version: SECURITY_BENCH_VERSION,
  requiresBrowser: false,

  async run(ctx) {
    const { url, cellDir, materialization, serverHandle, config, onProgress } = ctx;
    onProgress?.({ stage: 'security', detail: 'Checking headers, cookies, shipped code, secrets and dependencies' });
    const base = String(url).replace(/\/+$/, '');
    const ownsServer = (serverHandle?.serverArchitecture || materialization?.serverArchitecture) === 'production-server';
    const probeOrigin = 'https://attacker.example';

    const root = await get(`${base}/`, { headers: { Origin: probeOrigin } });
    const html = /html/i.test(root.headers['content-type'] || 'text/html') ? root.body : '';
    const sourceDir = resolveSourceDir(cellDir, materialization);
    const files = walkTextFiles(sourceDir);

    // API routes named in the shipped code, to check cookies and CORS beyond the home page.
    const apiPaths = [...new Set([html, ...files.filter((f) => !isServerFile(f)).map((f) => f.text)].join('\n').match(/["'`](\/api\/[A-Za-z0-9_\-/]{1,60})["'`?]/g)?.map((s) => s.slice(1, -1)) || [])].slice(0, 5);
    const apiResponses = [];
    for (const p of ownsServer ? apiPaths : []) {
      const r = await get(`${base}${p}`, { headers: { Origin: probeOrigin } });
      if (r.ok) apiResponses.push({ path: p, ...r });
    }

    const checks = [];
    checks.push(...evaluateCsp({ headerValue: ownsServer ? root.headers['content-security-policy'] || null : null, metaValue: extractMetaCsp(html) }));
    checks.push(...evaluateHeaders(root.headers, { ownsServer, html }));
    checks.push(...evaluateCookies(ownsServer ? [...root.setCookie, ...apiResponses.flatMap((r) => r.setCookie)] : []));
    checks.push(...evaluateCors(ownsServer ? [{ path: '/', headers: root.headers }, ...apiResponses] : [], probeOrigin));
    checks.push(...scanClientCode({ html, files }));

    // Secrets: anything in files a browser can fetch is critical; anything else in the source is high.
    const servedFiles = ownsServer ? files.filter((f) => /^(?:public|static|dist|build|client|assets)\//.test(f.path) || (f.ext === '.html' && !f.path.includes('/'))) : files;
    const servedSecrets = scanSecrets(servedFiles.filter((f) => !isServerFile(f)));
    const servedKeys = new Set(servedSecrets.map((s) => `${s.file}:${s.line}`));
    const sourceSecrets = scanSecrets(files).filter((s) => !servedKeys.has(`${s.file}:${s.line}`));
    checks.push(check('no-secrets-in-client-files', 'secrets', 'No credentials in files sent to the browser', 'critical', servedSecrets.length ? 'fail' : 'pass', servedSecrets.length ? `${servedSecrets.length} credential-like value(s) in browser-visible files.` : 'No credential patterns in browser-visible files.', { evidence: servedSecrets.map((s) => `${s.file}:${s.line} ${s.label} ${s.preview}`) }));
    checks.push(ownsServer
      ? check('no-hardcoded-secrets', 'secrets', 'No credentials hard-coded in server source', 'high', sourceSecrets.length ? 'fail' : 'pass', sourceSecrets.length ? `${sourceSecrets.length} credential-like value(s) committed in source.` : 'Secrets are not written into the source.', { evidence: sourceSecrets.map((s) => `${s.file}:${s.line} ${s.label} ${s.preview}`) })
      : check('no-hardcoded-secrets', 'secrets', 'No credentials hard-coded in server source', 'high', 'na', 'No server-side code in this build.'));

    const exposed = [];
    for (const probe of SENSITIVE_PATHS) {
      const r = await get(`${base}${probe.path}`, { maxBytes: 4096 });
      if (r.ok && r.status === 200 && probe.test(r.body, r.headers['content-type'] || '')) exposed.push(probe);
    }
    const worst = exposed.filter((e) => e.severity !== 'low');
    checks.push(check('no-sensitive-files-served', 'secrets', 'Does not serve private files', 'critical', worst.length ? 'fail' : 'pass', worst.length ? 'Private files can be downloaded by anyone.' : `Requested ${SENSITIVE_PATHS.length} well-known private paths: none were served.`, { evidence: worst.map((e) => `${e.path} (${e.label})`) }));
    checks.push(check('no-manifest-served', 'secrets', 'Does not serve its package manifest', 'low', exposed.some((e) => e.path === '/package.json') ? 'fail' : 'pass', exposed.some((e) => e.path === '/package.json') ? '/package.json is public, which lists exact dependency versions.' : '/package.json is not served.'));

    const depInfo = collectDependencies(sourceDir, html);
    const osv = config?.security?.advisoryLookup === false || process.env.BENCH_OFFLINE === '1' ? { ok: false, error: 'lookup disabled' } : await queryOsv(depInfo.deps);
    checks.push(...evaluateDependencies(depInfo, osv));
    checks.push(...scanServerCode(files));

    const scored = scoreSecurityChecks(checks);
    const out = {
      benchmarkId: 'security',
      version: SECURITY_BENCH_VERSION,
      measuredAt: new Date().toISOString(),
      score: scored.overall,
      ...scored,
      scope: { ownsServer, filesScanned: files.length, apiPathsChecked: apiResponses.map((r) => r.path), dependenciesChecked: depInfo.deps.length, advisoryLookup: osv.ok ? 'osv.dev' : `unavailable: ${osv.error}` },
      checks,
    };
    const resultsDir = join(cellDir, 'results');
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(join(resultsDir, 'security.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
    return out;
  },

  score(result) {
    if (!result) return { overall: null, passed: 0, failed: 0, notApplicable: 0, criticalFailures: [], groups: [] };
    return Array.isArray(result.checks) ? scoreSecurityChecks(result.checks) : { overall: result.score ?? null, passed: 0, failed: 0, notApplicable: 0, criticalFailures: [], groups: [] };
  },
};
