import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, statSync, rmSync } from 'node:fs';
import { join, dirname, normalize, extname } from 'node:path';

const FENCE_RE = /```([^\n`]*)\n([\s\S]*?)```/g;
const LEAKED_TOOL_MARKUP_RE = /\n?<\/?[｜|]+DSML[｜|]+[\s\S]*$/i;

function stripModelMarkupLeaks(text = '') {
  return text.replace(LEAKED_TOOL_MARKUP_RE, '').replace(/\n?<\/?tool_call>[\s\S]*$/i, '');
}

function sanitizeRelativePath(candidate) {
  if (!candidate) return null;
  let cleaned = candidate
    .trim()
    .replace(/^['"`*_]+|['"`*_:]+$/g, '')
    .replace(/^(?:file|filename|path)\s*[:=]\s*/i, '')
    .replace(/^\.?\//, '');
  if (
    !cleaned ||
    cleaned.length > 140 ||
    cleaned.includes('..') ||
    cleaned.startsWith('/') ||
    cleaned.includes('://') ||
    /\s/.test(cleaned)
  ) {
    return null;
  }
  const norm = normalize(cleaned);
  if (norm.startsWith('..') || norm.startsWith('/')) return null;
  return norm;
}

function isPlausibleFilePath(candidate) {
  const clean = sanitizeRelativePath(candidate);
  if (!clean) return null;
  if (/^(?:package\.json|Dockerfile|Makefile|Procfile)$/i.test(clean)) return clean;
  if (!/\.[A-Za-z0-9]{1,8}$/.test(clean)) return null;
  return clean;
}

function extractPrecedingProsePathHint(proseBeforeFence = '') {
  const lines = proseBeforeFence
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-3)
    .reverse();

  for (const line of lines) {
    // Match headings/labels like `### public/styles.css`, `**app.js**`, `` `src/App.tsx` ``, `1. index.html:`
    const m = line.match(
      /^(?:#{1,6}\s+|\d+[.)]\s+|[-*]\s+)?(?:file(?:name)?|path)?\s*[:=-]?\s*[`*_"]?([A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,8})[`*_"]?\s*:?\s*$/i
    );
    if (m) {
      const valid = isPlausibleFilePath(m[1]);
      if (valid) return valid;
    }
  }
  return null;
}

function inferFilenameFromHeaderOrBody(infoString, codeBody, index, seenPaths, precedingPathHint = null) {
  const parts = infoString.trim().split(/\s+/).filter(Boolean);
  const lang = (parts[0] || '').toLowerCase();

  // 1. Check info string tokens after language (e.g. ```tsx src/App.tsx or ```html title="index.html")
  for (const token of parts.slice(1)) {
    const titleMatch = token.match(/(?:title|file|filename|path)=["']?([^"'\s]+)["']?/i);
    const candidate = isPlausibleFilePath(titleMatch ? titleMatch[1] : token);
    if (candidate) return { lang, path: candidate };
  }
  // Sometimes first token itself is a filename like ```index.html or ```package.json
  if (parts[0] && parts[0].includes('.')) {
    const candidate = isPlausibleFilePath(parts[0]);
    if (candidate) return { lang: extname(candidate).slice(1), path: candidate };
  }

  // 2. Check explicit preceding path hint (from ```text\npath\n``` or markdown heading immediately above)
  if (precedingPathHint && !seenPaths.has(precedingPathHint)) {
    return { lang: lang || extname(precedingPathHint).slice(1), path: precedingPathHint };
  }

  // 3. Check leading comment line inside code block (e.g. // src/App.jsx or <!-- index.html -->)
  const firstLines = codeBody.split(/\r?\n/).slice(0, 3);
  for (const l of firstLines) {
    const commentMatch = l.match(
      /^\s*(?:\/\/|\/\*+|<!--|#)\s*(?:file(?:name)?:\s*)?([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)\s*(?:\*+\/|-->)?\s*$/i
    );
    if (commentMatch) {
      const candidate = isPlausibleFilePath(commentMatch[1]);
      if (candidate) return { lang, path: candidate };
    }
  }

  // 4. Infer canonical file name from language & content
  if (lang === 'json' && /"dependencies"|"devDependencies"|"scripts"/.test(codeBody) && !seenPaths.has('package.json')) {
    return { lang, path: 'package.json' };
  }
  if (lang === 'json') {
    return { lang, path: seenPaths.has('data.json') ? `data-${index}.json` : 'data.json' };
  }
  if (lang === 'ejs') {
    return { lang: 'ejs', path: seenPaths.has('views/index.ejs') ? `views/page-${index}.ejs` : 'views/index.ejs' };
  }
  if (lang === 'html' || /<!doctype html>|<html[\s>]/i.test(codeBody)) {
    return { lang: 'html', path: seenPaths.has('index.html') ? `page-${index}.html` : 'index.html' };
  }
  if (lang === 'css') {
    return { lang, path: seenPaths.has('styles.css') ? `styles-${index}.css` : 'styles.css' };
  }
  if (lang === 'tsx' || (lang === 'ts' && /<[A-Z][A-Za-z0-9]*|return\s*\(\s*</.test(codeBody))) {
    return { lang: 'tsx', path: seenPaths.has('App.tsx') ? `Component${index}.tsx` : 'App.tsx' };
  }
  if (lang === 'jsx' || ((lang === 'js' || lang === 'javascript' || !lang) && /import\s+.*from\s+['"]react['"]|export\s+default\s+function\s+[A-Z]/.test(codeBody))) {
    return { lang: 'jsx', path: seenPaths.has('App.jsx') ? `Component${index}.jsx` : 'App.jsx' };
  }
  if (lang === 'vue') {
    return { lang: 'vue', path: seenPaths.has('App.vue') ? `Component${index}.vue` : 'App.vue' };
  }
  if (lang === 'svelte') {
    return { lang: 'svelte', path: seenPaths.has('App.svelte') ? `Component${index}.svelte` : 'App.svelte' };
  }
  if (lang === 'js' || lang === 'javascript' || lang === 'mjs' || lang === 'cjs') {
    return { lang: 'js', path: seenPaths.has('app.js') ? `script-${index}.js` : 'app.js' };
  }
  if (lang === 'ts' || lang === 'typescript') {
    return { lang: 'ts', path: seenPaths.has('app.ts') ? `module-${index}.ts` : 'app.ts' };
  }
  if (lang === 'py' || lang === 'python') {
    return { lang: 'py', path: seenPaths.has('app.py') ? `module-${index}.py` : 'app.py' };
  }

  return null;
}

function classifyExtractedFiles(files) {
  if (files.length === 0) return 'unrunnable';
  const paths = new Set(files.map((f) => f.path));
  const hasPkg = paths.has('package.json');
  const hasHtml = Array.from(paths).some((p) => p.endsWith('index.html') || p.endsWith('.html'));
  const hasComponent = Array.from(paths).some((p) => /\.(jsx|tsx|vue|svelte)$/.test(p));
  const hasServerEntry = Array.from(paths).some((p) =>
    /^(?:server|app|main)\.(?:m?js|cjs|ts|py)$|^src\/server\.(?:m?js|ts)$/.test(p)
  );

  if (hasServerEntry && (hasPkg || Array.from(paths).some((p) => p.endsWith('.py')))) {
    return 'fullstack-workspace';
  }
  if (hasPkg) return 'project-with-manifest';
  if (hasHtml && files.length === 1 && !hasComponent) return 'single-html';
  if (hasHtml && !hasComponent) {
    // Check if HTML imports bare npm modules or JSX files
    const htmlFile = files.find((f) => f.path.endsWith('index.html')) || files.find((f) => f.path.endsWith('.html'));
    if (/\.(jsx|tsx|vue|svelte)['"]/.test(htmlFile.content)) return 'bare-component';
    return 'multi-file-static';
  }
  if (hasComponent) return 'bare-component';
  if (files.length === 1 && files[0].path.endsWith('.js')) {
    return 'bare-script';
  }
  return 'unrunnable';
}

const SKIP_SCAN_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.astro',
  '__pycache__',
  '.venv',
  'venv',
  'target',
]);

const BINARY_EXT_RE = /\.(?:png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|ogg|pdf|zip|tar|gz|db|sqlite3?|wasm)$/i;

function walkFiles(dir, base = dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP_SCAN_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...walkFiles(full, base));
    } else if (!BINARY_EXT_RE.test(name) && st.size <= 512 * 1024) {
      const rel = full.slice(base.length + 1);
      try {
        out.push({ path: rel, content: readFileSync(full, 'utf8') });
      } catch {
        // skip unreadable file
      }
    }
  }
  return out;
}

/**
 * Extracts code artifacts from either an agent workspace directory OR raw markdown output,
 * writing extracted files to `extractedDir` (for 1-shot markdown) and returning shape classification.
 */
export function extractGeneratedFiles({ cellDir, rawMarkdown = '' }) {
  const agentWorkspace = join(cellDir, 'agent-workspace');
  if (existsSync(agentWorkspace)) {
    const wsFiles = walkFiles(agentWorkspace);
    if (wsFiles.length > 0) {
      const hasRuntimeManifest =
        existsSync(join(agentWorkspace, '.bench-runtime.json')) ||
        existsSync(join(agentWorkspace, 'start.sh'));
      return {
        extractedDir: agentWorkspace,
        files: wsFiles,
        outputShape: hasRuntimeManifest ? 'fullstack-workspace' : classifyExtractedFiles(wsFiles),
      };
    }
  }

  const extractedDir = join(cellDir, 'extracted');
  rmSync(extractedDir, { recursive: true, force: true });
  mkdirSync(extractedDir, { recursive: true });

  const cleanedMarkdown = stripModelMarkupLeaks(rawMarkdown);
  const files = [];
  const seenPaths = new Set();
  let match;
  let idx = 0;
  let lastEndIndex = 0;
  let pendingTextBlockPathHint = null;
  FENCE_RE.lastIndex = 0;

  const processFence = (info, rawBody, proseBefore) => {
    idx++;
    const body = stripModelMarkupLeaks(rawBody || '');
    if (!body.trim()) return;

    const langToken = (info.trim().split(/\s+/)[0] || '').toLowerCase();
    const trimmedLines = body.trim().split(/\r?\n/);

    // Pattern used by models like DeepSeek V4 Pro: a single-line ```text\npath/to/file.ext\n``` label fence
    if (
      ['', 'text', 'plaintext', 'txt'].includes(langToken) &&
      trimmedLines.length === 1 &&
      trimmedLines[0].length <= 120
    ) {
      const pathOnly = isPlausibleFilePath(trimmedLines[0]);
      if (pathOnly) {
        pendingTextBlockPathHint = pathOnly;
        return;
      }
    }

    const proseHint = extractPrecedingProsePathHint(proseBefore);
    const activeHint = pendingTextBlockPathHint || proseHint;
    pendingTextBlockPathHint = null;

    const inferred = inferFilenameFromHeaderOrBody(info, body, idx, seenPaths, activeHint);
    if (!inferred) return;
    seenPaths.add(inferred.path);
    files.push({ path: inferred.path, lang: inferred.lang, content: body });
  };

  while ((match = FENCE_RE.exec(cleanedMarkdown)) !== null) {
    const proseBefore = cleanedMarkdown.slice(lastEndIndex, match.index);
    lastEndIndex = match.index + match[0].length;
    processFence(match[1] || '', match[2] || '', proseBefore);
  }

  // Handle unclosed trailing code fence when a 1-shot stream truncates or stops before closing ```
  const trailingSlice = cleanedMarkdown.slice(lastEndIndex);
  const unclosedMatch = trailingSlice.match(/(?:^|\n)```([^\n`]*)\n([\s\S]+)$/);
  if (unclosedMatch) {
    const proseBefore = trailingSlice.slice(0, unclosedMatch.index || 0);
    processFence(unclosedMatch[1] || '', unclosedMatch[2] || '', proseBefore);
  }

  // Fallback: if model returned raw HTML directly without markdown fences
  if (files.length === 0 && /<!doctype html>|<html[\s>]/i.test(cleanedMarkdown)) {
    const htmlStart = cleanedMarkdown.search(/<!doctype html>|<html[\s>]/i);
    const htmlContent = cleanedMarkdown.slice(htmlStart).trim();
    files.push({ path: 'index.html', lang: 'html', content: htmlContent });
  }

  for (const f of files) {
    const target = join(extractedDir, f.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.content, 'utf8');
  }

  const outputShape = classifyExtractedFiles(files);
  return {
    extractedDir,
    files,
    outputShape,
  };
}
