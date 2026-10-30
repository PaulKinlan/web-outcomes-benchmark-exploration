import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  cpSync,
  readdirSync,
  statSync,
  rmSync,
} from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PROJECT_ROOT } from '../util/env.mjs';

const execFileAsync = promisify(execFile);
const LOCAL_VITE_BIN = join(PROJECT_ROOT, 'node_modules', '.bin', 'vite');

const IMPORT_RE =
  /(?:import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\))/g;

function extractBarePackages(files) {
  const pkgs = new Set();
  for (const f of files) {
    if (!/\.(jsx?|tsx?|mjs|vue|svelte)$/.test(f.path)) continue;
    IMPORT_RE.lastIndex = 0;
    let m;
    while ((m = IMPORT_RE.exec(f.content)) !== null) {
      const spec = m[1] || m[2] || m[3];
      if (!spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('http') || spec.startsWith('node:')) {
        continue;
      }
      // Scoped @org/pkg vs bare pkg/subpath
      const parts = spec.split('/');
      const pkgName = spec.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
      if (pkgName && !['react', 'react-dom'].includes(pkgName)) {
        pkgs.add(pkgName);
      } else if (pkgName) {
        pkgs.add(pkgName);
      }
    }
  }
  return Array.from(pkgs);
}

function detectTailwindClasses(files) {
  const combined = files.map((f) => f.content).join('\n');
  return /(?:class|className)=["'`][^"'`]*\b(?:flex|grid|bg-(?:slate|gray|zinc|white|black|blue|indigo|emerald|amber|rose)-\d+|text-(?:xs|sm|base|lg|xl|2xl|3xl)|px-\d+|py-\d+|rounded-(?:md|lg|xl|2xl|full))\b/.test(
    combined
  );
}

function dirByteSize(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) total += dirByteSize(full);
    else total += st.size;
  }
  return total;
}

async function runCmd(cmd, args, cwd, timeoutMs = 120000, extraEnv = {}) {
  return execFileAsync(cmd, args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, CI: 'true', NODE_ENV: 'production', ...extraEnv },
  });
}

function findStaticHtmlRoot(dir) {
  if (existsSync(join(dir, 'index.html'))) return dir;
  for (const sub of ['dist', 'build', 'out', 'public']) {
    if (existsSync(join(dir, sub, 'index.html'))) return join(dir, sub);
  }
  return null;
}

/**
 * Rewrites root-relative asset URLs (`href="/styles.css"`, `src="/app.js"`, `src="/assets/..."`)
 * in static `.html` files inside `distDir` to relative `./...` paths whenever that local file exists in `distDir`,
 * so static sites work identically whether served at origin `/` or under a subpath (`dist-report/preview/<cellId>/`).
 */
export function rewriteRootRelativeLocalAssets(distDir) {
  if (!existsSync(distDir)) return;
  const walkHtml = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walkHtml(full);
      } else if (entry.endsWith('.html')) {
        const htmlDir = dirname(full);
        const orig = readFileSync(full, 'utf8');
        const updated = orig.replace(
          /\b(href|src)=(["'])\/(?!\/)([^"'?#]+)([?#][^"']*)?\2/gi,
          (whole, attr, quote, relAsset, suffix = '') => {
            const targetInDist = join(distDir, relAsset);
            if (!existsSync(targetInDist) || statSync(targetInDist).isDirectory()) {
              return whole;
            }
            let relFromHtml = relative(htmlDir, targetInDist).replace(/\\/g, '/');
            if (!relFromHtml.startsWith('.')) relFromHtml = `./${relFromHtml}`;
            return `${attr}=${quote}${relFromHtml}${suffix}${quote}`;
          }
        );
        if (updated !== orig) {
          writeFileSync(full, updated, 'utf8');
        }
      }
    }
  };
  walkHtml(distDir);
}

/**
 * Turns extracted model files into a runnable static `dist/` directory.
 * Records exact materialization tier:
 *   - "native-static": Worked out-of-the-box with zero build step
 *   - "model-project-build": Built using the model's own package.json
 *   - "synthesized-bundler": Model emitted bare JSX/TSX/Vue/Svelte without build config; wrapped in Vite
 *   - "failed": Could not materialize into a servable HTML page
 */
export async function materializeSite({ cellDir, extraction, onProgress = () => {} }) {
  const { extractedDir, files, outputShape } = extraction;
  const distDir = join(cellDir, 'dist');
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });
  const t0 = performance.now();

  // Tier 1: Native static HTML (single-html or multi-file-static)
  if (outputShape === 'single-html' || outputShape === 'multi-file-static') {
    onProgress({ stage: 'materializing', detail: `Copying ${outputShape} directly (no build needed)` });
    cpSync(extractedDir, distDir, { recursive: true });

    // Ensure there's an index.html if model named its single HTML file something else
    if (!existsSync(join(distDir, 'index.html'))) {
      const firstHtml = files.find((f) => f.path.endsWith('.html'));
      if (firstHtml) {
        cpSync(join(distDir, firstHtml.path), join(distDir, 'index.html'));
      }
    }

    // If multi-file-static has styles.css / app.js not linked in index.html, link them gently
    const indexHtmlPath = join(distDir, 'index.html');
    if (existsSync(indexHtmlPath) && outputShape === 'multi-file-static') {
      let html = readFileSync(indexHtmlPath, 'utf8');
      if (existsSync(join(distDir, 'styles.css')) && !html.includes('styles.css')) {
        html = html.replace(/<\/head>/i, '  <link rel="stylesheet" href="./styles.css">\n</head>');
      }
      if (existsSync(join(distDir, 'app.js')) && !html.includes('app.js')) {
        html = html.replace(/<\/body>/i, '  <script type="module" src="./app.js"></script>\n</body>');
      }
      writeFileSync(indexHtmlPath, html, 'utf8');
    }

    rewriteRootRelativeLocalAssets(distDir);

    const result = {
      ok: existsSync(join(distDir, 'index.html')),
      outputShape,
      materializeTier: 'native-static',
      runnableWithoutBuildStep: true,
      synthesizedWrapper: false,
      installedPackages: [],
      buildDurationMs: Math.round(performance.now() - t0),
      distBytes: dirByteSize(distDir),
      error: null,
    };
    writeFileSync(join(cellDir, 'materialization.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
    return { distDir, ...result };
  }

  // Tier 2: Model supplied its own package.json
  if (outputShape === 'project-with-manifest') {
    const buildWorkDir = join(cellDir, '.project-build');
    cpSync(extractedDir, buildWorkDir, { recursive: true });
    let buildError = null;
    let installedPackages = [];

    try {
      const pkg = JSON.parse(readFileSync(join(buildWorkDir, 'package.json'), 'utf8'));
      installedPackages = [
        ...Object.keys(pkg.dependencies || {}),
        ...Object.keys(pkg.devDependencies || {}),
      ];

      onProgress({ stage: 'materializing', detail: `Installing & building model's package.json (${installedPackages.length} deps)` });
      await runCmd(
        'npm',
        ['install', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps'],
        buildWorkDir,
        150000,
        { NODE_ENV: 'development', npm_config_production: 'false' }
      );

      if (pkg.scripts?.build) {
        await runCmd('npm', ['run', 'build'], buildWorkDir, 120000);
      } else if (existsSync(join(buildWorkDir, 'index.html'))) {
        await runCmd('npx', ['vite', 'build', '--base=./'], buildWorkDir, 120000);
      }

      const builtRoot = findStaticHtmlRoot(buildWorkDir);
      if (builtRoot) {
        cpSync(builtRoot, distDir, {
          recursive: true,
          filter: (s) => !s.includes('node_modules'),
        });
        rewriteRootRelativeLocalAssets(distDir);

        const result = {
          ok: true,
          outputShape,
          materializeTier: 'model-project-build',
          runnableWithoutBuildStep: false,
          synthesizedWrapper: false,
          installedPackages,
          buildDurationMs: Math.round(performance.now() - t0),
          distBytes: dirByteSize(distDir),
          error: null,
        };
        writeFileSync(join(cellDir, 'materialization.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
        return { distDir, ...result };
      }
    } catch (err) {
      buildError = err.message || String(err);
    }

    // If Tier 2 failed (e.g., Next.js missing config or broken scripts), fall through to Tier 3 auto-bundler!
    onProgress({ stage: 'materializing', detail: `Model build failed (${buildError?.slice(0, 80)}); attempting synthesized bundler fallback` });
  }

  // Tier 3: Synthesized Vite wrapper for bare JSX/TSX/Vue/Svelte or fallback component outputs
  if (outputShape === 'bare-component' || outputShape === 'project-with-manifest') {
    const synthDir = join(cellDir, '.synth-build');
    mkdirSync(join(synthDir, 'src'), { recursive: true });

    try {
      const componentFile =
        files.find((f) => /(?:^|\/)App\.(jsx|tsx|vue|svelte)$/.test(f.path)) ||
        files.find((f) => /(?:^|\/)page\.(jsx|tsx)$/.test(f.path)) ||
        files.find((f) => /\.(jsx|tsx|vue|svelte)$/.test(f.path));

      if (!componentFile) {
        throw new Error('No entry HTML or UI component file found in model output.');
      }

      // Copy all extracted source files into synthDir/src (or root if already under src/)
      const underSrc = componentFile.path.startsWith('src/');
      for (const f of files) {
        if (f.path === 'package.json' || f.path.endsWith('vite.config.js') || f.path.endsWith('vite.config.ts')) continue;
        const relDest = underSrc ? f.path : join('src', f.path);
        const dest = join(synthDir, relDest);
        mkdirSync(join(dest, '..'), { recursive: true });
        writeFileSync(dest, f.content, 'utf8');
      }

      const entryRelInSrc = underSrc ? `./${componentFile.path.slice(4)}` : `./${componentFile.path}`;
      const isVue = componentFile.path.endsWith('.vue');
      const isSvelte = componentFile.path.endsWith('.svelte');
      const usesTailwind = detectTailwindClasses(files);
      const bareImports = extractBarePackages(files);

      const dependencies = {};
      for (const pkg of bareImports) {
        dependencies[pkg] = 'latest';
      }
      const devDependencies = {};

      if (isVue) {
        dependencies.vue = '^3.5.0';
        devDependencies.vite = '^7.0.6';
        devDependencies['@vitejs/plugin-vue'] = '^6.0.0';
      } else if (isSvelte) {
        dependencies.svelte = '^5.0.0';
        devDependencies.vite = '^7.0.6';
        devDependencies['@sveltejs/vite-plugin-svelte'] = '^6.0.0';
      } else {
        dependencies.react = '^19.0.0';
        dependencies['react-dom'] = '^19.0.0';
      }

      writeFileSync(
        join(synthDir, 'package.json'),
        JSON.stringify(
          {
            name: 'synth-cell-wrapper',
            private: true,
            type: 'module',
            scripts: { build: 'vite build --base=./' },
            dependencies,
            devDependencies,
          },
          null,
          2
        ),
        'utf8'
      );

      // Entry mount file
      const cssFile = files.find((f) => f.path.endsWith('.css'));
      const cssImport = cssFile
        ? `import '${underSrc && cssFile.path.startsWith('src/') ? './' + cssFile.path.slice(4) : './' + cssFile.path}';\n`
        : '';

      if (isVue) {
        writeFileSync(
          join(synthDir, 'vite.config.mjs'),
          `import vue from '@vitejs/plugin-vue';\nexport default { plugins: [vue()], base: './' };\n`,
          'utf8'
        );
        writeFileSync(
          join(synthDir, 'src', '__entry.js'),
          `${cssImport}import { createApp } from 'vue';\nimport App from '${entryRelInSrc}';\ncreateApp(App).mount('#root');\n`,
          'utf8'
        );
      } else if (isSvelte) {
        writeFileSync(
          join(synthDir, 'vite.config.mjs'),
          `import { svelte } from '@sveltejs/vite-plugin-svelte';\nexport default { plugins: [svelte()], base: './' };\n`,
          'utf8'
        );
        writeFileSync(
          join(synthDir, 'src', '__entry.js'),
          `${cssImport}import { mount } from 'svelte';\nimport App from '${entryRelInSrc}';\nmount(App, { target: document.getElementById('root') });\n`,
          'utf8'
        );
      } else {
        writeFileSync(
          join(synthDir, 'vite.config.mjs'),
          `export default { base: './', esbuild: { jsx: 'automatic' } };\n`,
          'utf8'
        );
        writeFileSync(
          join(synthDir, 'src', '__entry.jsx'),
          `${cssImport}import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport * as Mod from '${entryRelInSrc}';\nconst Component = Mod.default || Object.values(Mod).find((v) => typeof v === 'function') || (() => <div>Empty export</div>);\ncreateRoot(document.getElementById('root')).render(<Component />);\n`,
          'utf8'
        );
      }

      const entryScript = isVue || isSvelte ? './src/__entry.js' : './src/__entry.jsx';
      const tailwindHead = usesTailwind ? '  <script src="https://cdn.tailwindcss.com"></script>\n' : '';
      writeFileSync(
        join(synthDir, 'index.html'),
        `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n  <title>Generated App</title>\n${tailwindHead}</head>\n<body>\n  <div id="root"></div>\n  <script type="module" src="${entryScript}"></script>\n</body>\n</html>\n`,
        'utf8'
      );

      onProgress({
        stage: 'materializing',
        detail: `Synthesizing Vite bundle for bare component (${Object.keys(dependencies).join(', ')})`,
      });
      await runCmd(
        'npm',
        ['install', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps'],
        synthDir,
        150000,
        { NODE_ENV: 'development', npm_config_production: 'false' }
      );
      const viteCmd = existsSync(LOCAL_VITE_BIN) ? LOCAL_VITE_BIN : 'npx';
      const viteArgs = existsSync(LOCAL_VITE_BIN)
        ? ['build', '--config', 'vite.config.mjs']
        : ['vite', 'build', '--config', 'vite.config.mjs'];
      await runCmd(viteCmd, viteArgs, synthDir, 120000);

      cpSync(join(synthDir, 'dist'), distDir, { recursive: true });
      const result = {
        ok: existsSync(join(distDir, 'index.html')),
        outputShape,
        materializeTier: 'synthesized-bundler',
        runnableWithoutBuildStep: false,
        synthesizedWrapper: true,
        synthesizedTailwindCdn: usesTailwind,
        installedPackages: Object.keys(dependencies),
        buildDurationMs: Math.round(performance.now() - t0),
        distBytes: dirByteSize(distDir),
        error: null,
      };
      writeFileSync(join(cellDir, 'materialization.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
      return { distDir, ...result };
    } catch (err) {
      const result = {
        ok: false,
        outputShape,
        materializeTier: 'failed',
        runnableWithoutBuildStep: false,
        synthesizedWrapper: true,
        installedPackages: [],
        buildDurationMs: Math.round(performance.now() - t0),
        distBytes: 0,
        error: err.message || String(err),
      };
      writeFileSync(join(cellDir, 'materialization.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
      return { distDir, ...result };
    }
  }

  const failed = {
    ok: false,
    outputShape,
    materializeTier: 'failed',
    runnableWithoutBuildStep: false,
    synthesizedWrapper: false,
    installedPackages: [],
    buildDurationMs: Math.round(performance.now() - t0),
    distBytes: 0,
    error: `Output shape "${outputShape}" produced no runnable HTML or component files.`,
  };
  writeFileSync(join(cellDir, 'materialization.json'), JSON.stringify(failed, null, 2) + '\n', 'utf8');
  return { distDir, ...failed };
}
