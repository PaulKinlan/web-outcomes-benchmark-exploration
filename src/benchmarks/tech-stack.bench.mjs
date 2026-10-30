import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  withIsolatedChrome,
  withTimeout,
  navigateAndSettle,
  capturePngScreenshot,
} from './cdp-helpers.mjs';

const FRAMEWORK_RULES = [
  { id: 'react', label: 'React', re: /\bfrom\s+['"]react['"]|react\.development\.js|react\.production\.min\.js|react-dom|ReactDOM\.createRoot|React\.useState/i },
  { id: 'nextjs', label: 'Next.js', re: /\bfrom\s+['"]next\/|next\.config/i },
  { id: 'vue', label: 'Vue', re: /\bfrom\s+['"]vue['"]|vue\.global|createApp\s*\(|<template>[\s\S]*<script\s+setup/i },
  { id: 'svelte', label: 'Svelte', re: /\bfrom\s+['"]svelte['"]|<script>[\s\S]*\$:/i },
  { id: 'preact', label: 'Preact', re: /\bfrom\s+['"]preact['"]|htm\/preact/i },
  { id: 'solid', label: 'SolidJS', re: /\bfrom\s+['"]solid-js['"]|createSignal\s*\(/i },
  { id: 'angular', label: 'Angular', re: /@angular\/core|@Component\s*\(/i },
  { id: 'alpine', label: 'Alpine.js', re: /alpinejs|x-data=/i },
  { id: 'htmx', label: 'htmx', re: /htmx\.org|hx-get=|hx-post=/i },
  { id: 'lit', label: 'Lit / Web Components', re: /\bfrom\s+['"]lit['"]|customElements\.define\s*\(/i },
  { id: 'jquery', label: 'jQuery', re: /jquery(?:\.min)?\.js|\$\(document\)\.ready/i },
];

const CSS_RULES = [
  { id: 'tailwind-cdn', label: 'Tailwind Play CDN', re: /cdn\.tailwindcss\.com/i },
  { id: 'tailwind', label: 'Tailwind CSS', re: /@tailwind\s+utilities|tailwindcss|class(?:Name)?=["'`][^"'`]*\b(?:flex|grid)\b[^"'`]*\b(?:bg-[a-z]+-\d+|px-\d+|rounded-(?:lg|xl))/i },
  { id: 'bootstrap', label: 'Bootstrap', re: /bootstrap(?:\.min)?\.css|btn\s+btn-primary/i },
  { id: 'shadcn-radix', label: 'Radix / shadcn', re: /@radix-ui\/|class-variance-authority/i },
  { id: 'mui', label: 'Material UI', re: /@mui\/material/i },
  { id: 'css-in-js', label: 'CSS-in-JS', re: /styled-components|@emotion\/react/i },
];

const LIBRARY_RULES = [
  { id: 'babel-standalone', category: 'compiler', label: '@babel/standalone (In-Browser JSX)', re: /babel(?:\.min)?\.js|@babel\/standalone|type=["']text\/babel["']/i },
  { id: 'three', category: '3d-graphics', label: 'Three.js', re: /\bthree(?:\.module|\.min)?\.js|\bfrom\s+['"]three['"]|\bnew\s+THREE\./i },
  { id: 'babylon', category: '3d-graphics', label: 'Babylon.js', re: /babylonjs|BABYLON\./i },
  { id: 'pixi', category: '3d-graphics', label: 'PixiJS', re: /pixi\.js|PIXI\./i },
  { id: 'webgl-raw', category: '3d-graphics', label: 'Raw WebGL', re: /getContext\(\s*['"]webgl2?['"]/i },
  { id: 'canvas-2d', category: '3d-graphics', label: 'Canvas 2D', re: /getContext\(\s*['"]2d['"]/i },
  { id: 'web-audio', category: 'audio', label: 'Web Audio API', re: /AudioContext|webkitAudioContext/i },
  { id: 'tonejs', category: 'audio', label: 'Tone.js', re: /\bTone\.|from\s+['"]tone['"]/i },
  { id: 'lucide', category: 'icons', label: 'Lucide Icons', re: /lucide-react|unpkg\.com\/lucide|data-lucide=/i },
  { id: 'fontawesome', category: 'icons', label: 'Font Awesome', re: /font-awesome|fontawesome|fa-solid\s+fa-/i },
  { id: 'heroicons', category: 'icons', label: 'Heroicons', re: /@heroicons\/react/i },
  { id: 'phosphor', category: 'icons', label: 'Phosphor Icons', re: /@phosphor-icons/i },
  { id: 'framer-motion', category: 'animation', label: 'Framer Motion', re: /framer-motion|motion\/react/i },
  { id: 'gsap', category: 'animation', label: 'GSAP', re: /\bgsap\.|from\s+['"]gsap['"]/i },
  { id: 'chartjs', category: 'charts', label: 'Chart.js / Recharts / D3', re: /chart\.js|recharts|\bd3\./i },
  { id: 'google-fonts', category: 'fonts', label: 'Google Fonts CDN', re: /fonts\.googleapis\.com/i },
];

const PERSISTENCE_RULES = [
  { id: 'sqlite', re: /\bbetter-sqlite3\b|\bsqlite3\b|\bsql\.js\b|import\s+sqlite3\b/ },
  { id: 'prisma', re: /@prisma\/client|\bPrismaClient\b/ },
  { id: 'drizzle', re: /\bdrizzle-orm\b/ },
  { id: 'json-file-store', re: /\b(?:writeFileSync|writeFile)\b[\s\S]{0,160}\.json['"`]|json\.dump\(/ },
  { id: 'localStorage', re: /\blocalStorage\.(?:getItem|setItem)/ },
  { id: 'sessionStorage', re: /\bsessionStorage\.(?:getItem|setItem)/ },
  { id: 'indexedDB', re: /\bindexedDB\.open\b/ },
  { id: 'urlSearchParams', re: /\bURLSearchParams\b|\blocation\.hash\b|\bhistory\.pushState\b/ },
];

const BACKEND_RULES = [
  { id: 'nextjs', label: 'Next.js Server', re: /\bfrom\s+['"]next\/|next\.config|"next"\s*:/i },
  { id: 'sveltekit', label: 'SvelteKit Server', re: /@sveltejs\/kit|\+page\.server\.|\+server\./i },
  { id: 'astro', label: 'Astro Server', re: /astro\.config|from\s+['"]astro:/i },
  { id: 'remix', label: 'Remix / React Router v7', re: /@remix-run\/|@react-router\/serve/i },
  { id: 'nuxt', label: 'Nuxt / Nitro', re: /nuxt\.config|defineEventHandler/i },
  { id: 'hono', label: 'Hono', re: /\bfrom\s+['"]hono['"]|"hono"\s*:/i },
  { id: 'fastify', label: 'Fastify', re: /\bfrom\s+['"]fastify['"]|require\(['"]fastify['"]\)/i },
  { id: 'express', label: 'Express', re: /\bfrom\s+['"]express['"]|require\(['"]express['"]\)|"express"\s*:/i },
  { id: 'node-http', label: 'Node.js http/https', re: /\bfrom\s+['"]node:http['"]|require\(['"](?:node:)?http['"]\)|http\.createServer/i },
  { id: 'fastapi', label: 'Python FastAPI', re: /\bfrom\s+fastapi\s+import\b|\bFastAPI\s*\(/i },
  { id: 'flask', label: 'Python Flask', re: /\bfrom\s+flask\s+import\b|\bFlask\s*\(__name__\)/i },
  { id: 'django', label: 'Python Django', re: /\bdjango\.urls\b|\bdjango\.http\b/i },
  { id: 'go-http', label: 'Go net/http', re: /\b"net\/http"\b|\bhttp\.ListenAndServe\b/i },
];

export function analyzeStaticSource({ files = [], materialization = {} }) {
  const combined = files.map((f) => f.content || '').join('\n');

  const detectedFrameworks = FRAMEWORK_RULES.filter((r) => r.re.test(combined)).map((r) => r.id);
  const primaryFramework = detectedFrameworks[0] || 'vanilla';

  const detectedBackends = BACKEND_RULES.filter((r) => r.re.test(combined)).map((r) => r.id);
  const primaryBackend =
    materialization.serverArchitecture === 'production-server'
      ? detectedBackends[0] || 'custom-server'
      : detectedBackends[0] || 'static-only';

  const detectedCss = CSS_RULES.filter((r) => r.re.test(combined)).map((r) => r.id);
  const primaryCss = detectedCss[0] || 'vanilla-css';

  const detectedLibraries = LIBRARY_RULES.filter((r) => r.re.test(combined)).map((r) => ({
    id: r.id,
    category: r.category,
    label: r.label,
  }));

  const persistenceApis = PERSISTENCE_RULES.filter((r) => r.re.test(combined)).map((r) => r.id);
  const inlineSvgCount = (combined.match(/<svg[\s>]/gi) || []).length;
  const semanticDialogs = /<dialog[\s>]/i.test(combined);
  const usesPopoverApi = /\bpopover(?:=|[\s>])/i.test(combined);
  const usesViewTransitions = /\bstartViewTransition\b/.test(combined);

  const htmlOrPageFiles = files.filter((f) =>
    /(?:\.html|page\.(?:jsx?|tsx?)|\+page\.svelte|\.astro|\.ejs|\.hbs|\.jinja2?)$/i.test(f.path)
  ).length;
  const apiRouteFiles = files.filter((f) =>
    /(?:route\.(?:js|ts)|\+server\.(?:js|ts)|api\/|routes\/|controllers\/|server\.(?:m?js|ts|py)|app\.(?:m?js|ts|py))$/i.test(
      f.path
    )
  ).length;

  let deliveryPattern = 'zero-dep-vanilla';
  if (materialization.serverArchitecture === 'production-server') {
    deliveryPattern =
      primaryFramework === 'vanilla'
        ? `server-${primaryBackend}-ssr-or-mpa`
        : `fullstack-${primaryFramework}-${primaryBackend}`;
  } else if (materialization.synthesizedWrapper) {
    deliveryPattern = 'bare-component-synthesized';
  } else if (materialization.materializeTier === 'model-project-build') {
    deliveryPattern = 'npm-bundled-project';
  } else if (detectedLibraries.some((l) => l.id === 'babel-standalone')) {
    deliveryPattern = 'in-browser-babel-jsx';
  } else if (detectedCss.includes('tailwind-cdn')) {
    deliveryPattern = primaryFramework === 'vanilla' ? 'vanilla-plus-tailwind-cdn' : `${primaryFramework}-plus-tailwind-cdn`;
  } else if (/https?:\/\/(?:unpkg\.com|cdn\.jsdelivr\.net|esm\.sh|cdnjs\.cloudflare\.com)/i.test(combined)) {
    deliveryPattern = 'cdn-script-imports';
  }

  return {
    primaryFramework,
    detectedFrameworks: detectedFrameworks.length ? detectedFrameworks : ['vanilla'],
    primaryBackend,
    detectedBackends,
    primaryCss,
    detectedCss: detectedCss.length ? detectedCss : ['vanilla-css'],
    deliveryPattern,
    libraries: detectedLibraries,
    persistenceApis,
    inlineSvgCount,
    pageTemplateCount: htmlOrPageFiles,
    apiOrServerFileCount: apiRouteFiles,
    modernWebFeatures: {
      nativeDialog: semanticDialogs,
      popoverApi: usesPopoverApi,
      viewTransitions: usesViewTransitions,
    },
    sourceFileCount: files.length,
    totalSourceChars: combined.length,
  };
}

export default {
  id: 'tech-stack',
  label: 'Default Tech-Stack & Runtime Fingerprint',
  version: '1.0.0',
  requiresBrowser: true,

  async run(ctx) {
    const { url, cellDir, extraction, materialization, config, onProgress } = ctx;
    onProgress?.({ stage: 'tech-stack', detail: 'Analyzing default framework, libraries & runtime globals' });

    const staticInfo = analyzeStaticSource({
      files: extraction.files,
      materialization,
    });

    const screenshotsDir = join(cellDir, 'screenshots');
    mkdirSync(screenshotsDir, { recursive: true });

    const consoleErrors = [];
    const pageExceptions = [];
    const externalRequests = [];

    const runtimeInfo = await withIsolatedChrome(
      { viewport: config.browser.viewportDesktop, timeoutMs: 25000, label: 'tech-stack' },
      async ({ client }) => {
        client.Runtime.consoleAPICalled((evt) => {
          if (evt.type === 'error') {
            const msg = (evt.args || []).map((a) => a.value || a.description || '').join(' ');
            consoleErrors.push(msg.slice(0, 240));
          }
        });
        client.Runtime.exceptionThrown((evt) => {
          pageExceptions.push(
            (evt.exceptionDetails?.exception?.description || evt.exceptionDetails?.text || 'Uncaught error').slice(0, 240)
          );
        });
        client.Network.requestWillBeSent((evt) => {
          const reqUrl = evt.request?.url || '';
          if (/^https?:\/\//i.test(reqUrl) && !reqUrl.startsWith('http://127.0.0.1') && !reqUrl.startsWith('http://localhost')) {
            try {
              const u = new URL(reqUrl);
              externalRequests.push({ host: u.hostname, url: reqUrl.slice(0, 180), type: evt.type });
            } catch {
              // ignore
            }
          }
        });

        await navigateAndSettle(client, url, config.browser.settleWaitMs || 1000);
        await capturePngScreenshot(client, join(screenshotsDir, 'desktop.png')).catch(() => {});

        const evalRes = await withTimeout(
          client.Runtime.evaluate({
            expression: `(() => {
              const globals = [];
              if (window.React || document.querySelector('[data-reactroot]') || Object.keys(document.getElementById('root') || {}).some(k => k.startsWith('__reactContainer'))) globals.push('react');
              if (window.__VUE__ || document.querySelector('[data-v-app]')) globals.push('vue');
              if (window.__svelte) globals.push('svelte');
              if (window.THREE) globals.push('three');
              if (window.tailwind) globals.push('tailwind-play-jit');
              if (window.Babel) globals.push('babel-standalone-jit');
              if (window.jQuery) globals.push('jquery');
              if (window.lucide) globals.push('lucide');

              return {
                globals,
                domElementCount: document.querySelectorAll('*').length,
                visibleTextLength: (document.body?.innerText || '').trim().length,
                canvasCount: document.querySelectorAll('canvas').length,
                svgCount: document.querySelectorAll('svg').length,
                formCount: document.querySelectorAll('form').length,
                buttonCount: document.querySelectorAll('button, [role="button"]').length,
                inputCount: document.querySelectorAll('input, select, textarea').length,
                dialogCount: document.querySelectorAll('dialog').length,
              };
            })()`,
            returnByValue: true,
            timeout: 4000,
          }),
          5000,
          'tech-stack Runtime.evaluate'
        ).catch(() => ({ result: { value: {} } }));

        // Also capture mobile viewport screenshot for Studio inspection
        await withTimeout(
          client.Emulation.setDeviceMetricsOverride({
            width: config.browser.viewportMobile.width,
            height: config.browser.viewportMobile.height,
            deviceScaleFactor: 2,
            mobile: true,
          }),
          4000,
          'tech-stack mobile viewport'
        ).catch(() => {});
        await capturePngScreenshot(client, join(screenshotsDir, 'mobile.png')).catch(() => {});

        return evalRes?.result?.value || {};
      }
    );

    // Reconcile static + runtime framework detection
    let finalFramework = staticInfo.primaryFramework;
    if (finalFramework === 'vanilla' && runtimeInfo.globals?.includes('react')) finalFramework = 'react';
    if (finalFramework === 'vanilla' && runtimeInfo.globals?.includes('vue')) finalFramework = 'vue';

    const uniqueThirdPartyHosts = Array.from(new Set(externalRequests.map((r) => r.host)));
    const renderedNonBlank = (runtimeInfo.visibleTextLength || 0) > 20 || (runtimeInfo.canvasCount || 0) > 0;

    const out = {
      benchmarkId: 'tech-stack',
      measuredAt: new Date().toISOString(),
      primaryFramework: finalFramework,
      primaryBackend: staticInfo.primaryBackend,
      serverArchitecture: materialization.serverArchitecture || 'static-harness',
      contractCompliance: materialization.contractCompliance ?? null,
      primaryCss: staticInfo.primaryCss,
      deliveryPattern: staticInfo.deliveryPattern,
      outputShape: materialization.outputShape,
      materializeTier: materialization.materializeTier,
      runnableWithoutBuildStep: Boolean(materialization.runnableWithoutBuildStep),
      synthesizedWrapper: Boolean(materialization.synthesizedWrapper),
      staticAnalysis: staticInfo,
      runtime: {
        ...runtimeInfo,
        renderedNonBlank,
        consoleErrorCount: consoleErrors.length,
        pageExceptionCount: pageExceptions.length,
        consoleErrors: consoleErrors.slice(0, 10),
        pageExceptions: pageExceptions.slice(0, 10),
        externalRequestCount: externalRequests.length,
        thirdPartyHosts: uniqueThirdPartyHosts,
        usesRuntimeJitCompiler: Boolean(
          runtimeInfo.globals?.includes('babel-standalone-jit') ||
          runtimeInfo.globals?.includes('tailwind-play-jit')
        ),
      },
      screenshots: {
        desktop: 'screenshots/desktop.png',
        mobile: 'screenshots/mobile.png',
      },
    };

    const resultsDir = join(cellDir, 'results');
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(join(resultsDir, 'tech-stack.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
    return out;
  },

  score(result) {
    // Note: Tech-stack choice itself is DESCRIPTIVE (never penalizes React vs Vanilla directly!),
    // while runtime boot health (rendered non-blank, zero uncaught exceptions) is reported cleanly.
    const rendered = result?.runtime?.renderedNonBlank ? 1 : 0;
    const errPenalty = Math.min(40, (result?.runtime?.pageExceptionCount || 0) * 15 + (result?.runtime?.consoleErrorCount || 0) * 5);
    return {
      bootHealthScore: rendered ? Math.max(0, 100 - errPenalty) : 0,
      primaryFramework: result?.primaryFramework || 'unknown',
      primaryCss: result?.primaryCss || 'unknown',
      deliveryPattern: result?.deliveryPattern || 'unknown',
      runnableWithoutBuildStep: Boolean(result?.runnableWithoutBuildStep),
    };
  },
};
