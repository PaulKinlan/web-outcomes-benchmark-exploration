import {
  existsSync,
  statSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  cpSync,
  rmSync,
} from 'node:fs';
import { join, dirname, relative, extname, resolve } from 'node:path';

const CANDIDATE_WORKSPACE_DIRS = [
  'dist',
  'build',
  'out',
  'client/dist',
  'client/build',
  'frontend/dist',
  'frontend/build',
  'web/dist',
  'public/dist',
  'public',
  'static',
  '.',
];

const SKIP_COPY_NAMES = new Set([
  'node_modules',
  '.git',
  '.bench-reference',
  '.tmp-heapsnapshots',
  '__pycache__',
  '.venv',
  'venv',
]);

function shouldCopyPath(srcPath) {
  const parts = srcPath.split(/[\\/]/);
  for (const part of parts) {
    if (SKIP_COPY_NAMES.has(part)) return false;
    if (part.startsWith('.tmp')) return false;
  }
  const lower = srcPath.toLowerCase();
  if (
    lower.endsWith('.heapsnapshot') ||
    lower.endsWith('.sqlite') ||
    lower.endsWith('.sqlite3') ||
    lower.endsWith('.sqlite-wal') ||
    lower.endsWith('.sqlite-shm') ||
    lower.endsWith('.db')
  ) {
    return false;
  }
  return true;
}

function isRunnableStaticIndexHtml(indexPath) {
  if (!existsSync(indexPath)) return false;
  try {
    const st = statSync(indexPath);
    if (!st.isFile() || st.size < 16) return false;
    const html = readFileSync(indexPath, 'utf8');
    // Unbuilt Vite/Parcel source index.html importing raw .jsx/.tsx/.ts modules cannot run without a build
    if (/<script\b[^>]*\bsrc=["'][^"']*\.(?:jsx|tsx|ts)(?:[?#][^"']*)?["']/i.test(html)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the best static directory containing a runnable `index.html` for a benchmark cell.
 * Works for 1-shot builds (`dist/`), mirrored full-stack agent servers (`static-preview/`),
 * and existing Vite/static agent builds (`agent-workspace/dist`, `agent-workspace/public`, etc.).
 */
export function resolveCellStaticPreviewSource(cellDir) {
  if (!cellDir || !existsSync(cellDir)) return null;

  const mirroredDir = join(cellDir, 'static-preview');
  if (isRunnableStaticIndexHtml(join(mirroredDir, 'index.html'))) {
    return { dir: mirroredDir, source: 'static-preview' };
  }

  const distDir = join(cellDir, 'dist');
  if (isRunnableStaticIndexHtml(join(distDir, 'index.html'))) {
    return { dir: distDir, source: 'dist' };
  }

  const wsDir = join(cellDir, 'agent-workspace');
  if (existsSync(wsDir)) {
    for (const rel of CANDIDATE_WORKSPACE_DIRS) {
      const candidate = rel === '.' ? wsDir : join(wsDir, rel);
      if (isRunnableStaticIndexHtml(join(candidate, 'index.html'))) {
        return { dir: candidate, source: `agent-workspace/${rel}` };
      }
    }
  }

  const extractedDir = join(cellDir, 'extracted');
  if (isRunnableStaticIndexHtml(join(extractedDir, 'index.html'))) {
    return { dir: extractedDir, source: 'extracted' };
  }

  return null;
}

export function hasResolvableStaticPreview(cellDir) {
  return Boolean(resolveCellStaticPreviewSource(cellDir));
}

async function fetchWithDeadline(url, timeoutMs = 3000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ac.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

function discoverLocalAssetPathsFromHtml(html) {
  const found = new Set();
  const attrRe = /\b(?:href|src|poster)=["'](\/(?!\/)[^"'#?]+)(?:[?#][^"']*)?["']/gi;
  let m;
  while ((m = attrRe.exec(html)) !== null) {
    const p = m[1];
    if (p === '/' || p.startsWith('/api/')) continue;
    found.add(p);
  }
  const relAttrRe = /\b(?:href|src|poster)=["'](?:\.\/)?([a-zA-Z0-9_.-][a-zA-Z0-9_./-]*\.(?:css|js|mjs|png|jpg|jpeg|webp|svg|gif|ico|woff2?|ttf|json|wasm))(?:[?#][^"']*)?["']/gi;
  while ((m = relAttrRe.exec(html)) !== null) {
    found.add('/' + m[1].replace(/^\.?\//, ''));
  }
  return Array.from(found).slice(0, 40);
}

function discoverCandidateApiGetPaths(cellDir, rootHtml = '', extraDir = null) {
  const found = new Set();
  const apiRe = /["'`](\/api\/[a-zA-Z0-9_/-]{1,80})["'`]/g;

  const scanText = (txt) => {
    let m;
    apiRe.lastIndex = 0;
    while ((m = apiRe.exec(txt)) !== null) {
      const clean = m[1].replace(/\/+$/, '');
      if (!clean || clean.includes(':') || clean.includes('${') || clean.includes('*')) continue;
      if (/\/(login|logout|auth|signin|signup|register|reset|delete|clear)\b/i.test(clean)) continue;
      found.add(clean);
      if (found.size >= 24) break;
    }
  };

  if (rootHtml) scanText(rootHtml);

  const walk = (dir, depth = 0) => {
    if (!dir || !existsSync(dir) || depth > 4 || found.size >= 24) return;
    let entries = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_COPY_NAMES.has(entry) || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full, depth + 1);
      } else if (st.size <= 250_000 && /\.(?:js|mjs|cjs|ts|tsx|jsx|vue|svelte|html)$/i.test(entry)) {
        try {
          scanText(readFileSync(full, 'utf8'));
        } catch {
          // ignore
        }
      }
    }
  };

  walk(join(cellDir, 'agent-workspace'), 0);
  if (extraDir) walk(extraDir, 0);

  return Array.from(found).slice(0, 24);
}

/**
 * Captures a self-contained static preview mirror (`cellDir/static-preview/`) from a running
 * cell server during Stage 2 auditing so full-stack `$PORT` apps remain viewable on GitHub Pages
 * while Stage 2 benchmarks still evaluate the real `$PORT` server.
 */
export async function captureStaticPreviewMirror({ serverUrl, cellDir, materialization, timeoutMs = 8000 }) {
  if (!serverUrl || !cellDir) return { ok: false };
  const deadline = Date.now() + timeoutMs;
  const outDir = join(cellDir, 'static-preview');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  let copiedFrom = null;
  const wsDir = join(cellDir, 'agent-workspace');
  if (existsSync(wsDir)) {
    // Copy static asset directories first (e.g. public/ or dist/)
    for (const rel of CANDIDATE_WORKSPACE_DIRS) {
      if (rel === '.') continue;
      const candidate = join(wsDir, rel);
      if (existsSync(candidate) && statSync(candidate).isDirectory()) {
        // Prefer built dist/ over public/, or copy public/ assets if dist/ absent
        if (isRunnableStaticIndexHtml(join(candidate, 'index.html'))) {
          cpSync(candidate, outDir, { recursive: true, filter: shouldCopyPath });
          copiedFrom = `agent-workspace/${rel}`;
          break;
        }
      }
    }
    if (!copiedFrom) {
      for (const assetSub of ['public', 'static']) {
        const subPath = join(wsDir, assetSub);
        if (existsSync(subPath) && statSync(subPath).isDirectory()) {
          cpSync(subPath, outDir, { recursive: true, filter: shouldCopyPath });
          copiedFrom = `agent-workspace/${assetSub}`;
        }
      }
    }
  } else if (existsSync(join(cellDir, 'dist'))) {
    cpSync(join(cellDir, 'dist'), outDir, { recursive: true, filter: shouldCopyPath });
    copiedFrom = 'dist';
  }

  let rootHtml = '';
  const outIndex = join(outDir, 'index.html');
  if (isRunnableStaticIndexHtml(outIndex)) {
    rootHtml = readFileSync(outIndex, 'utf8');
  }

  try {
    const resp = await fetchWithDeadline(new URL('/', serverUrl).href, Math.min(3500, Math.max(800, deadline - Date.now())));
    const ct = String(resp.headers.get('content-type') || '').toLowerCase();
    if (resp.ok && ct.includes('html')) {
      const liveHtml = await resp.text();
      if (!isRunnableStaticIndexHtml(outIndex) && liveHtml.trim().length > 16) {
        writeFileSync(outIndex, liveHtml, 'utf8');
        rootHtml = liveHtml;
        copiedFrom = copiedFrom ? `${copiedFrom}+ssr-index` : 'ssr-index';
      } else if (!rootHtml) {
        rootHtml = liveHtml;
      }
    }
  } catch {
    // Ignore if server root fetch timed out; static copy may still exist
  }

  if (!isRunnableStaticIndexHtml(outIndex)) {
    rmSync(outDir, { recursive: true, force: true });
    return { ok: false };
  }

  // Fetch any missing local subresources referenced by index.html from the live server
  const assetPaths = discoverLocalAssetPathsFromHtml(rootHtml);
  for (const assetPath of assetPaths) {
    if (Date.now() >= deadline) break;
    const safeRel = assetPath.replace(/^\/+/, '');
    if (!safeRel || safeRel.includes('..')) continue;
    const targetFile = resolve(outDir, safeRel);
    if (!targetFile.startsWith(resolve(outDir))) continue;
    if (existsSync(targetFile)) continue;

    try {
      const r = await fetchWithDeadline(
        new URL(assetPath, serverUrl).href,
        Math.min(1800, Math.max(400, deadline - Date.now()))
      );
      if (!r.ok) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 8 * 1024 * 1024) continue; // skip >8MB blobs
      mkdirSync(dirname(targetFile), { recursive: true });
      writeFileSync(targetFile, buf);
    } catch {
      // non-fatal
    }
  }

  // Probe discovered read-only GET /api/* routes to seed static GitHub Pages interactive previews
  const apiSeed = {};
  let totalSeedBytes = 0;
  if (materialization?.serverArchitecture === 'production-server') {
    const apiPaths = discoverCandidateApiGetPaths(cellDir, rootHtml, outDir);
    for (const apiPath of apiPaths) {
      if (Date.now() >= deadline || totalSeedBytes >= 384 * 1024) break;
      try {
        const r = await fetchWithDeadline(
          new URL(apiPath, serverUrl).href,
          Math.min(1200, Math.max(300, deadline - Date.now()))
        );
        if (!r.ok) continue;
        const ct = String(r.headers.get('content-type') || '').toLowerCase();
        if (!ct.includes('json')) continue;
        const raw = await r.text();
        if (raw.length > 65_536) continue;
        apiSeed[apiPath] = JSON.parse(raw);
        totalSeedBytes += raw.length;
      } catch {
        // non-fatal
      }
    }
  }

  if (Object.keys(apiSeed).length > 0) {
    writeFileSync(join(outDir, '_bench_api_seed.json'), JSON.stringify(apiSeed), 'utf8');
  }
  writeFileSync(
    join(outDir, '_bench_mirror_meta.json'),
    JSON.stringify({
      mirroredAt: new Date().toISOString(),
      source: copiedFrom || 'unknown',
      seededApiRoutes: Object.keys(apiSeed),
    }) + '\n',
    'utf8'
  );

  return { ok: true, outDir, source: copiedFrom, seededApiCount: Object.keys(apiSeed).length };
}

function buildStaticPreviewBootstrapScript(apiSeedObj = {}) {
  const serializedSeed = JSON.stringify(apiSeedObj || {}).replace(/<\//g, '<\\/');
  return `<script data-bench-static-shim="1">(function(){try{window.localStorage.length}catch(e){var mk=function(){var s=Object.create(null);return{getItem:function(k){return Object.prototype.hasOwnProperty.call(s,k)?s[k]:null},setItem:function(k,v){s[String(k)]=String(v)},removeItem:function(k){delete s[k]},clear:function(){s=Object.create(null)},key:function(i){return Object.keys(s)[i]||null},get length(){return Object.keys(s).length}}};try{Object.defineProperty(window,'localStorage',{value:mk(),configurable:true});Object.defineProperty(window,'sessionStorage',{value:mk(),configurable:true})}catch(_){}}var seed=${serializedSeed};if(typeof window.fetch==='function'){var origFetch=window.fetch.bind(window);var normApi=function(u){try{var p=new URL(u,window.location.href).pathname;var idx=p.indexOf('/api/');if(idx>=0)return p.slice(idx).replace(/\\/+$/,'');if(p.endsWith('/api'))return '/api'}catch(_){}return null};var jsonResp=function(obj,st){return new Response(JSON.stringify(obj),{status:st||200,headers:{'Content-Type':'application/json; charset=utf-8'}})};window.fetch=function(input,init){var urlStr=typeof input==='string'?input:(input&&input.url)||'';var apiKey=normApi(urlStr);if(!apiKey)return origFetch(input,init);var method=String((init&&init.method)||(typeof input==='object'&&input&&input.method)||'GET').toUpperCase();if(method!=='GET'&&method!=='HEAD'){var bodyObj={};try{if(init&&typeof init.body==='string')bodyObj=JSON.parse(init.body)}catch(_){}var created=Object.assign({id:'item-'+Date.now(),ok:true,success:true,status:'confirmed'},bodyObj);if(Array.isArray(seed[apiKey]))seed[apiKey]=seed[apiKey].concat([created]);return Promise.resolve(jsonResp(created,200))}if(Object.prototype.hasOwnProperty.call(seed,apiKey)){return Promise.resolve(jsonResp(seed[apiKey],200))}var baseKey=apiKey.replace(/\\/[^/]+$/,'');if(Array.isArray(seed[baseKey])){var slug=apiKey.slice(baseKey.length+1);var hit=seed[baseKey].find(function(x){return x&&String(x.id||x.slug||'')===slug});if(hit)return Promise.resolve(jsonResp(hit,200))}return origFetch(input,init).then(function(r){var ct=String(r.headers.get('content-type')||'');if(r.ok&&ct.indexOf('json')>=0)return r;return jsonResp([],200)}).catch(function(){return jsonResp([],200)})}}})();</script>`;
}

/**
 * Copies a resolved cell static source directory into `destPreview`, rewrites root-relative
 * Vite/static asset URLs (`/assets/...` -> `./assets/...`) so hosting under subpaths like
 * `/<repo>/preview/<cellId>/index.html` works without 404s, and injects storage + `/api` shims.
 */
export function prepareExportedStaticPreview(srcDir, destPreview) {
  mkdirSync(destPreview, { recursive: true });
  cpSync(srcDir, destPreview, {
    recursive: true,
    filter: shouldCopyPath,
  });

  const topEntries = new Set(readdirSync(destPreview));
  let apiSeed = {};
  const seedPath = join(destPreview, '_bench_api_seed.json');
  if (existsSync(seedPath)) {
    try {
      apiSeed = JSON.parse(readFileSync(seedPath, 'utf8'));
    } catch {
      apiSeed = {};
    }
  }
  const shim = buildStaticPreviewBootstrapScript(apiSeed);

  const hasMatchingTopEntry = (rawTarget) => {
    const clean = String(rawTarget || '').replace(/^\/+/, '');
    const firstSeg = clean.split(/[/?#]/)[0];
    return Boolean(firstSeg && topEntries.has(firstSeg));
  };

  const walkAndPatch = (dir) => {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      let st;
      try {
        st = statSync(fullPath);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walkAndPatch(fullPath);
        continue;
      }

      const ext = extname(entry).toLowerCase();
      if (ext !== '.html' && ext !== '.css' && ext !== '.js' && ext !== '.mjs') continue;
      if (st.size > 6 * 1024 * 1024) continue;

      const relToRoot = relative(dirname(fullPath), destPreview).replace(/\\/g, '/');
      const relPrefix = relToRoot ? `${relToRoot}/` : './';

      if (ext === '.html') {
        let html = readFileSync(fullPath, 'utf8');
        html = html.replace(
          /\b(href|src|poster)=(["'])\/(?!\/)([^"']+)\2/gi,
          (match, attr, quote, target) => {
            if (!hasMatchingTopEntry(target)) return match;
            return `${attr}=${quote}${relPrefix}${target}${quote}`;
          }
        );
        html = html.replace(
          /url\((['"]?)\/(?!\/)([^)'"]+)\1\)/gi,
          (match, quote, target) => {
            if (!hasMatchingTopEntry(target)) return match;
            return `url(${quote}${relPrefix}${target}${quote})`;
          }
        );
        if (!html.includes('data-bench-static-shim=')) {
          html = /<head[^>]*>/i.test(html)
            ? html.replace(/<head[^>]*>/i, (m) => `${m}\n${shim}`)
            : `${shim}\n${html}`;
        }
        writeFileSync(fullPath, html, 'utf8');
      } else if (ext === '.css') {
        let css = readFileSync(fullPath, 'utf8');
        const patched = css.replace(
          /url\((['"]?)\/(?!\/)([^)'"]+)\1\)/gi,
          (match, quote, target) => {
            if (!hasMatchingTopEntry(target)) return match;
            return `url(${quote}${relPrefix}${target}${quote})`;
          }
        );
        if (patched !== css) writeFileSync(fullPath, patched, 'utf8');
      } else if (ext === '.js' || ext === '.mjs') {
        let js = readFileSync(fullPath, 'utf8');
        let changed = false;

        // 1. ES module imports resolve relative to the JS module file itself
        const nextImports = js.replace(
          /(\bimport\s*\(\s*|\bfrom\s*)(["'])\/(?!\/)([^"']+)\2/g,
          (match, kw, quote, target) => {
            if (!hasMatchingTopEntry(target)) return match;
            changed = true;
            return `${kw}${quote}${relPrefix}${target}${quote}`;
          }
        );
        js = nextImports;

        // 2. Vite modulepreload URL helper (`return"/"+dep`) resolves relative to document
        if (topEntries.has('assets') && js.includes('return"/"+')) {
          js = js.replace(/return"\/"\+/g, 'return"./"+');
          changed = true;
        }

        // 3. String asset URLs fetched in DOM/fetch/Three.js resolve relative to document root (`./...`)
        const nextAssets = js.replace(
          /(["'])\/((?:assets|static|images|img|fonts|media|audio|textures|models|icons|data)\/[^"'\s<>]+)\1/g,
          (match, quote, target) => {
            if (!hasMatchingTopEntry(target)) return match;
            changed = true;
            return `${quote}./${target}${quote}`;
          }
        );
        js = nextAssets;

        if (changed) writeFileSync(fullPath, js, 'utf8');
      }
    }
  };

  walkAndPatch(destPreview);
}
