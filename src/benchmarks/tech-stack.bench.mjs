import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  withIsolatedChrome,
  withTimeout,
  navigateAndSettle,
  capturePngScreenshot,
} from './cdp-helpers.mjs';
import {
  LIBRARY_DETECTOR_ENGINE_VERSION,
  BROWSER_LIBRARY_DETECTOR_EXPRESSION,
  reconcileDetectedLibraries,
} from './library-signatures.mjs';

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

export const MODERN_WEB_CATALOG_VERSION = '0.0.197';

export const MODERN_WEB_FEATURE_RULES = [
  // UI & Top-Layer (MWG 0.0.197)
  { id: 'nativeDialog', category: 'ui-top-layer', label: '<dialog> Modal/Non-Modal', re: /<dialog[\s>]/i },
  { id: 'dialogClosedBy', category: 'ui-top-layer', label: '<dialog closedby="any">', re: /\bclosedby\s*=\s*["'](?:any|closerequest|none)["']/i },
  { id: 'popoverApi', category: 'ui-top-layer', label: 'Popover API ([popover])', re: /\bpopover(?:=|[\s>])|:popover-open\b/i },
  { id: 'invokerCommands', category: 'ui-top-layer', label: 'Invoker Commands (commandfor/command)', re: /\bcommandfor\s*=|\bcommand\s*=\s*["'](?:show-modal|close|request-close|toggle-popover|show-popover|hide-popover|--)/i },
  { id: 'interestInvoker', category: 'ui-top-layer', label: 'Interest Invokers (interestfor)', re: /\binterestfor\s*=/i },
  { id: 'startingStyle', category: 'ui-top-layer', label: '@starting-style Entry Transitions', re: /@starting-style\b/i },
  { id: 'intrinsicSizeAnimation', category: 'ui-top-layer', label: 'interpolate-size / calc-size()', re: /\binterpolate-size\s*:\s*allow-keywords\b|\bcalc-size\s*\(/i },
  { id: 'anchorPositioning', category: 'ui-top-layer', label: 'CSS Anchor Positioning', re: /\banchor-name\s*:|\bposition-anchor\s*:|\bposition-area\s*:|\bposition-try(?:-fallbacks)?\s*:/i },

  // Layout & Modern CSS (MWG 0.0.197)
  { id: 'containerQueries', category: 'layout-css', label: '@container Queries', re: /@container\b|\bcontainer-type\s*:/i },
  { id: 'hasSelector', category: 'layout-css', label: ':has() Relational Selector', re: /:has\s*\(/ },
  { id: 'subgrid', category: 'layout-css', label: 'CSS Grid subgrid', re: /\bgrid-template-(?:columns|rows)\s*:\s*subgrid\b/i },
  { id: 'fluidTypography', category: 'layout-css', label: 'clamp() Fluid Sizing', re: /\bclamp\s*\(/i },
  { id: 'textWrapBalance', category: 'layout-css', label: 'text-wrap: balance / pretty', re: /\btext-wrap\s*:\s*(?:balance|pretty)\b/i },
  { id: 'lightDarkColor', category: 'layout-css', label: 'light-dark() / Dual color-scheme', re: /\blight-dark\s*\(|\bcolor-scheme\s*:\s*(?:light\s+dark|dark\s+light)\b/i },
  { id: 'modernColorSpaces', category: 'layout-css', label: 'oklch() / color-mix()', re: /\boklch\s*\(|\boklab\s*\(|\bcolor-mix\s*\(/i },
  { id: 'cascadeLayersOrScope', category: 'layout-css', label: '@layer / @scope', re: /@layer\b|@scope\b/i },

  // Forms & Semantic Controls (MWG 0.0.197)
  { id: 'userValidInvalid', category: 'forms-inputs', label: ':user-valid / :user-invalid', re: /:user-invalid\b|:user-valid\b/i },
  { id: 'fieldSizingContent', category: 'forms-inputs', label: 'field-sizing: content', re: /\bfield-sizing\s*:\s*content\b/i },
  { id: 'customizableSelect', category: 'forms-inputs', label: 'Customizable <select> (base-select)', re: /\bappearance\s*:\s*base-select\b|::picker\s*\(\s*select\s*\)/i },
  { id: 'searchElement', category: 'forms-inputs', label: 'Semantic <search> Landmark', re: /<search[\s>]/i },
  { id: 'autocompleteTokens', category: 'forms-inputs', label: 'Autofill autocomplete Tokens', re: /\bautocomplete\s*=\s*["'](?:name|email|tel|street-address|postal-code|cc-number|current-password|new-password|one-time-code|username)\b/i },

  // Motion, Navigation & CWV Performance (MWG 0.0.197)
  { id: 'viewTransitions', category: 'motion-perf', label: 'View Transitions API', re: /\bstartViewTransition\b|@view-transition\b|\bview-transition-name\s*:/ },
  { id: 'scopedViewTransitions', category: 'motion-perf', label: 'Element-Scoped View Transitions', re: /\bview-transition-name\s*:\s*match-element\b|\bview-transition-class\s*:|(?:el|element|container|card|panel)\.startViewTransition\s*\(/i },
  { id: 'scrollDrivenAnimations', category: 'motion-perf', label: 'Scroll-Driven Animations', re: /\banimation-timeline\s*:\s*(?:scroll|view)\b|\bscroll-timeline\b|\bview-timeline\b/i },
  { id: 'scrollStateQueries', category: 'motion-perf', label: 'CSS scroll-state() / scrollsnapchange', re: /scroll-state\s*\(|\bonscrollsnapchange\b|addEventListener\(\s*['"]scrollsnapchange/i },
  { id: 'htmlInCanvas', category: 'motion-perf', label: 'HTML-in-Canvas (<canvas content="drawable">)', re: /<canvas[^>]*\bcontent\s*=\s*["']drawable["']|\b(?:captureElementImage|drawElementImage|texElementSubImage2D)\s*\(/i },
  { id: 'contentVisibility', category: 'motion-perf', label: 'content-visibility: auto', re: /\bcontent-visibility\s*:\s*auto\b/i },
  { id: 'hiddenUntilFound', category: 'motion-perf', label: 'hidden="until-found"', re: /\bhidden\s*=\s*["']until-found["']|\bonbeforematch\b/i },
  { id: 'fetchPriority', category: 'motion-perf', label: 'fetchpriority Resource Hints', re: /\bfetchpriority\s*=\s*["'](?:high|low)["']/i },
  { id: 'speculationRules', category: 'motion-perf', label: 'Speculation Rules API', re: /type\s*=\s*["']speculationrules["']/i },
  { id: 'schedulerYield', category: 'motion-perf', label: 'scheduler.yield() / postTask()', re: /\bscheduler\.(?:yield|postTask)\s*\(/ },
  { id: 'moveBeforeDom', category: 'motion-perf', label: 'State-Preserving moveBefore()', re: /\.moveBefore\s*\(/ },
  { id: 'temporalApi', category: 'forms-inputs', label: 'Temporal API / Intl.DurationFormat', re: /\bTemporal\.(?:Instant|PlainDate|PlainTime|PlainYearMonth|PlainMonthDay|ZonedDateTime|Duration|Now)\b|\bIntl\.DurationFormat\b/ },

  // Security, Identity & Agentic Web (MWG 0.0.197)
  { id: 'sanitizerOrTrustedTypes', category: 'security-agentic', label: 'Sanitizer setHTML() / Trusted Types', re: /\.setHTML\s*\(|\btrustedTypes\.createPolicy\b/ },
  { id: 'subresourceIntegrity', category: 'security-agentic', label: 'Subresource Integrity (SRI / CSS integrity())', re: /\bintegrity\s*=\s*["']sha(?:256|384|512)-|\bintegrity\s*\(\s*["']sha(?:256|384|512)-/i },
  { id: 'originApi', category: 'security-agentic', label: 'Origin API (Origin.from / isSameOrigin)', re: /\bOrigin\.from\s*\(|\.isSameOrigin\s*\(|\.isSameSite\s*\(/ },
  { id: 'passkeysWebAuthn', category: 'security-agentic', label: 'Passkeys / WebAuthn / Immediate Mediation', re: /\bnavigator\.credentials\.(?:create|get)\b|\bPublicKeyCredential\b/ },
  { id: 'webMcpDeclarativeOrApi', category: 'security-agentic', label: 'WebMCP Agentic Tools', re: /\bnavigator\.modelContext\b|\btoolname\s*=|\btooldescription\s*=|\buseWebMCP\b/i },
  { id: 'builtInWebAi', category: 'security-agentic', label: 'Built-in Web AI (Prompt/Summarizer/Translator)', re: /\b(?:LanguageModel|Summarizer|Translator|LanguageDetector)\.(?:create|availability)\b/ },
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

  const modernWebFeatures = {};
  const modernWebFeatureList = [];
  const modernWebByCategory = {};

  for (const rule of MODERN_WEB_FEATURE_RULES) {
    const matched = rule.re.test(combined);
    modernWebFeatures[rule.id] = matched;
    if (matched) {
      modernWebFeatureList.push({
        id: rule.id,
        category: rule.category,
        label: rule.label,
      });
      modernWebByCategory[rule.category] = (modernWebByCategory[rule.category] || 0) + 1;
    }
  }

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
    modernWebCatalogVersion: MODERN_WEB_CATALOG_VERSION,
    modernWebFeatures,
    modernWebFeatureList,
    modernWebAdoptionCount: modernWebFeatureList.length,
    modernWebByCategory,
    sourceFileCount: files.length,
    totalSourceChars: combined.length,
  };
}

export default {
  id: 'tech-stack',
  label: 'Default Tech-Stack & Runtime Fingerprint',
  version: '1.2.0',
  requiresBrowser: true,

  async run(ctx) {
    const { url, cellDir, extraction, materialization, config, onProgress } = ctx;
    onProgress?.({ stage: 'tech-stack', detail: 'Analyzing default framework, Library-Detector/Wappalyzer signatures & MWG 0.0.197 features' });

    const staticInfo = analyzeStaticSource({
      files: extraction.files,
      materialization,
    });

    const screenshotsDir = join(cellDir, 'screenshots');
    mkdirSync(screenshotsDir, { recursive: true });

    const consoleErrors = [];
    const pageExceptions = [];
    const externalRequests = [];
    let documentResponseHeaders = {};

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
        client.Network.responseReceived((evt) => {
          if (evt.type === 'Document' && Object.keys(documentResponseHeaders).length === 0) {
            documentResponseHeaders = evt.response?.headers || {};
          }
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
            expression: BROWSER_LIBRARY_DETECTOR_EXPRESSION,
            returnByValue: true,
            timeout: 4500,
          }),
          5500,
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

    const detectedLibraries = reconcileDetectedLibraries({
      staticInfo,
      runtimeDetections: runtimeInfo.detections || [],
      responseHeaders: documentResponseHeaders,
      files: extraction.files,
    });

    // Reconcile static + runtime framework & CSS detection
    let finalFramework = staticInfo.primaryFramework;
    if (finalFramework === 'vanilla') {
      const rtFw = detectedLibraries.find(
        (d) => (d.category === 'meta-framework' || d.category === 'framework') && d.id !== 'jquery'
      );
      if (rtFw) finalFramework = rtFw.id;
    }

    let finalCss = staticInfo.primaryCss;
    if (finalCss === 'vanilla-css') {
      const rtCss = detectedLibraries.find((d) => d.category === 'css' || d.category === 'ui-kit');
      if (rtCss) finalCss = rtCss.id;
    }

    const uniqueThirdPartyHosts = Array.from(new Set(externalRequests.map((r) => r.host)));
    const renderedNonBlank = (runtimeInfo.visibleTextLength || 0) > 20 || (runtimeInfo.canvasCount || 0) > 0;

    const out = {
      benchmarkId: 'tech-stack',
      libraryDetectorVersion: LIBRARY_DETECTOR_ENGINE_VERSION,
      measuredAt: new Date().toISOString(),
      primaryFramework: finalFramework,
      primaryBackend: staticInfo.primaryBackend,
      serverArchitecture: materialization.serverArchitecture || 'static-harness',
      contractCompliance: materialization.contractCompliance ?? null,
      primaryCss: finalCss,
      deliveryPattern: staticInfo.deliveryPattern,
      outputShape: materialization.outputShape,
      materializeTier: materialization.materializeTier,
      runnableWithoutBuildStep: Boolean(materialization.runnableWithoutBuildStep),
      synthesizedWrapper: Boolean(materialization.synthesizedWrapper),
      detectedLibraries,
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
      modernWebAdoptionCount: result?.staticAnalysis?.modernWebAdoptionCount ?? 0,
    };
  },
};
