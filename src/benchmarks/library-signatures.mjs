/**
 * Multi-signal Library & Framework Detection Engine
 * Combines:
 *   1. `Library-Detector-for-Chrome` (`johnmichel/Library-Detector-for-Chrome/library/libraries.js`)
 *      live in-page `window` globals, fiber/component roots, and runtime semver extraction
 *   2. Wappalyzer-style DOM attribute/selector signatures, CSS custom properties (`--tw-*`, `--bs-*`,
 *      `--mantine-*`, `--chakra-*`), `<meta name="generator">`, `<script src>` CDN semver URLs,
 *      and HTTP response headers (`x-powered-by`, `server`, `x-nextjs-*`)
 *   3. Workspace `package.json` dependency + static AST/regex source reconciliation
 */

export const LIBRARY_DETECTOR_ENGINE_VERSION = '2.0.0';

/**
 * Canonical catalog mapping npm package names and static IDs to normalized library metadata.
 */
export const CANONICAL_LIBRARY_CATALOG = [
  // UI Frameworks & Meta-Frameworks
  { id: 'react', name: 'React', category: 'framework', npmPackages: ['react', 'react-dom'] },
  { id: 'nextjs', name: 'Next.js', category: 'meta-framework', npmPackages: ['next'] },
  { id: 'vue', name: 'Vue.js', category: 'framework', npmPackages: ['vue'] },
  { id: 'nuxt', name: 'Nuxt', category: 'meta-framework', npmPackages: ['nuxt'] },
  { id: 'svelte', name: 'Svelte', category: 'framework', npmPackages: ['svelte'] },
  { id: 'sveltekit', name: 'SvelteKit', category: 'meta-framework', npmPackages: ['@sveltejs/kit'] },
  { id: 'preact', name: 'Preact', category: 'framework', npmPackages: ['preact'] },
  { id: 'solid', name: 'SolidJS', category: 'framework', npmPackages: ['solid-js'] },
  { id: 'angular', name: 'Angular', category: 'framework', npmPackages: ['@angular/core'] },
  { id: 'alpine', name: 'Alpine.js', category: 'framework', npmPackages: ['alpinejs'] },
  { id: 'htmx', name: 'htmx', category: 'framework', npmPackages: ['htmx.org'] },
  { id: 'lit', name: 'Lit', category: 'framework', npmPackages: ['lit', 'lit-element', 'lit-html'] },
  { id: 'astro', name: 'Astro', category: 'meta-framework', npmPackages: ['astro'] },
  { id: 'remix', name: 'Remix / React Router', category: 'meta-framework', npmPackages: ['@remix-run/react', 'react-router', 'react-router-dom'] },
  { id: 'jquery', name: 'jQuery', category: 'framework', npmPackages: ['jquery'] },

  // CSS & Design Systems
  { id: 'tailwind-cdn', name: 'Tailwind Play CDN', category: 'css', npmPackages: [] },
  { id: 'tailwind', name: 'Tailwind CSS', category: 'css', npmPackages: ['tailwindcss', '@tailwindcss/vite', '@tailwindcss/postcss'] },
  { id: 'bootstrap', name: 'Bootstrap', category: 'css', npmPackages: ['bootstrap'] },
  { id: 'shadcn-radix', name: 'Radix UI / shadcn', category: 'ui-kit', npmPackages: ['radix-ui', '@radix-ui/react-dialog', '@radix-ui/react-popover', '@radix-ui/react-select', 'class-variance-authority'] },
  { id: 'mui', name: 'Material UI', category: 'ui-kit', npmPackages: ['@mui/material'] },
  { id: 'chakra', name: 'Chakra UI', category: 'ui-kit', npmPackages: ['@chakra-ui/react'] },
  { id: 'mantine', name: 'Mantine', category: 'ui-kit', npmPackages: ['@mantine/core'] },
  { id: 'css-in-js', name: 'Styled Components / Emotion', category: 'css', npmPackages: ['styled-components', '@emotion/react'] },

  // 3D, Canvas & Graphics
  { id: 'three', name: 'Three.js', category: '3d-graphics', npmPackages: ['three', '@react-three/fiber'] },
  { id: 'babylon', name: 'Babylon.js', category: '3d-graphics', npmPackages: ['babylonjs', '@babylonjs/core'] },
  { id: 'pixi', name: 'PixiJS', category: '3d-graphics', npmPackages: ['pixi.js'] },
  { id: 'phaser', name: 'Phaser', category: '3d-graphics', npmPackages: ['phaser'] },
  { id: 'konva', name: 'Konva', category: '3d-graphics', npmPackages: ['konva', 'react-konva'] },

  // Data Visualization & Maps
  { id: 'd3', name: 'D3.js', category: 'charts', npmPackages: ['d3'] },
  { id: 'chartjs', name: 'Chart.js', category: 'charts', npmPackages: ['chart.js', 'react-chartjs-2'] },
  { id: 'recharts', name: 'Recharts', category: 'charts', npmPackages: ['recharts'] },
  { id: 'echarts', name: 'Apache ECharts', category: 'charts', npmPackages: ['echarts'] },
  { id: 'plotly', name: 'Plotly.js', category: 'charts', npmPackages: ['plotly.js', 'plotly.js-dist-min'] },
  { id: 'leaflet', name: 'Leaflet', category: 'maps', npmPackages: ['leaflet', 'react-leaflet'] },
  { id: 'mapbox-gl', name: 'Mapbox / MapLibre GL', category: 'maps', npmPackages: ['mapbox-gl', 'maplibre-gl'] },

  // Motion & Interaction
  { id: 'gsap', name: 'GSAP', category: 'animation', npmPackages: ['gsap'] },
  { id: 'framer-motion', name: 'Motion / Framer Motion', category: 'animation', npmPackages: ['motion', 'framer-motion'] },
  { id: 'animejs', name: 'Anime.js', category: 'animation', npmPackages: ['animejs'] },
  { id: 'lenis', name: 'Lenis Smooth Scroll', category: 'animation', npmPackages: ['lenis', '@studio-freight/lenis'] },
  { id: 'swiper', name: 'Swiper', category: 'ui-widget', npmPackages: ['swiper'] },
  { id: 'sortablejs', name: 'SortableJS / dnd-kit', category: 'ui-widget', npmPackages: ['sortablejs', '@dnd-kit/core'] },

  // Editors, Markdown & Highlighting
  { id: 'marked', name: 'Marked', category: 'markdown', npmPackages: ['marked'] },
  { id: 'prismjs', name: 'PrismJS', category: 'syntax', npmPackages: ['prismjs'] },
  { id: 'highlightjs', name: 'Highlight.js', category: 'syntax', npmPackages: ['highlight.js'] },
  { id: 'monaco', name: 'Monaco Editor', category: 'editor', npmPackages: ['monaco-editor', '@monaco-editor/react'] },
  { id: 'codemirror', name: 'CodeMirror', category: 'editor', npmPackages: ['codemirror', '@codemirror/view'] },
  { id: 'quill', name: 'Quill', category: 'editor', npmPackages: ['quill'] },
  { id: 'prosemirror-tiptap', name: 'TipTap / ProseMirror', category: 'editor', npmPackages: ['@tiptap/core', 'prosemirror-view'] },

  // Audio, Realtime, State & Compilers
  { id: 'tonejs', name: 'Tone.js', category: 'audio', npmPackages: ['tone'] },
  { id: 'howler', name: 'Howler.js', category: 'audio', npmPackages: ['howler'] },
  { id: 'socketio', name: 'Socket.IO', category: 'realtime', npmPackages: ['socket.io-client', 'socket.io'] },
  { id: 'zustand', name: 'Zustand', category: 'state', npmPackages: ['zustand'] },
  { id: 'tanstack-query', name: 'TanStack Query', category: 'state', npmPackages: ['@tanstack/react-query', '@tanstack/vue-query'] },
  { id: 'zod', name: 'Zod', category: 'validation', npmPackages: ['zod'] },
  { id: 'lodash', name: 'Lodash', category: 'utility', npmPackages: ['lodash', 'lodash-es'] },
  { id: 'date-lib', name: 'date-fns / Day.js / Moment', category: 'utility', npmPackages: ['date-fns', 'dayjs', 'moment'] },
  { id: 'babel-standalone', name: '@babel/standalone (In-Browser JSX)', category: 'compiler', npmPackages: ['@babel/standalone'] },

  // Icons & Fonts
  { id: 'lucide', name: 'Lucide Icons', category: 'icons', npmPackages: ['lucide', 'lucide-react', 'lucide-vue-next', 'lucide-svelte'] },
  { id: 'fontawesome', name: 'Font Awesome', category: 'icons', npmPackages: ['@fortawesome/fontawesome-free', '@fortawesome/react-fontawesome'] },
  { id: 'heroicons', name: 'Heroicons', category: 'icons', npmPackages: ['@heroicons/react'] },
  { id: 'phosphor', name: 'Phosphor Icons', category: 'icons', npmPackages: ['@phosphor-icons/react', '@phosphor-icons/web'] },

  // Build Tools & Backends (from package.json / headers)
  { id: 'vite', name: 'Vite', category: 'bundler', npmPackages: ['vite'] },
  { id: 'express', name: 'Express', category: 'backend', npmPackages: ['express'] },
  { id: 'fastify', name: 'Fastify', category: 'backend', npmPackages: ['fastify'] },
  { id: 'hono', name: 'Hono', category: 'backend', npmPackages: ['hono'] },
  { id: 'better-sqlite3', name: 'SQLite (better-sqlite3 / sqlite3)', category: 'database', npmPackages: ['better-sqlite3', 'sqlite3', 'sql.js'] },
];

const CATALOG_BY_ID = new Map(CANONICAL_LIBRARY_CATALOG.map((item) => [item.id, item]));

/**
 * Self-contained browser evaluation expression modeled directly on
 * `Library-Detector-for-Chrome/library/libraries.js` (`test(win)`) + Wappalyzer DOM/meta/script signatures.
 */
export const BROWSER_LIBRARY_DETECTOR_EXPRESSION = String.raw`(() => {
  const detections = [];
  const seen = new Map();

  function add(id, name, category, version, signal) {
    const cleanVer = version && typeof version === 'string'
      ? version.trim().replace(/^v/i, '').slice(0, 32)
      : (typeof version === 'number' ? String(version) : null);
    const existing = seen.get(id);
    if (existing) {
      if (!existing.version && cleanVer) existing.version = cleanVer;
      if (!existing.signals.includes(signal)) existing.signals.push(signal);
      return;
    }
    const entry = { id, name, category, version: cleanVer || null, signals: [signal] };
    seen.set(id, entry);
    detections.push(entry);
  }

  // 1. Library-Detector-for-Chrome style JS Global & Fiber Root Probes
  try {
    let reactVer = window.React?.version || null;
    if (!reactVer && window.__REACT_DEVTOOLS_GLOBAL_HOOK__?.renderers?.size) {
      for (const r of window.__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers.values()) {
        if (r?.version) { reactVer = r.version; break; }
      }
    }
    const rootCandidates = [
      document.getElementById('root'),
      document.getElementById('__next'),
      document.getElementById('app'),
      document.body?.firstElementChild,
    ].filter(Boolean);
    const hasReactFiber = Boolean(
      reactVer ||
      document.querySelector('[data-reactroot], [data-reactid]') ||
      rootCandidates.some((el) =>
        Object.keys(el).some((k) =>
          k.startsWith('__reactContainer$') ||
          k.startsWith('__reactFiber$') ||
          k === '_reactRootContainer'
        )
      )
    );
    if (hasReactFiber) add('react', 'React', 'framework', reactVer, reactVer ? 'runtime-global' : 'dom-fiber');
  } catch {}

  try {
    if (window.__NEXT_DATA__ || window.next || document.getElementById('__NEXT_DATA__')) {
      add('nextjs', 'Next.js', 'meta-framework', window.next?.version || null, 'runtime-global');
    }
  } catch {}

  try {
    let vueVer = window.Vue?.version || null;
    let hasVue = Boolean(vueVer || window.__VUE__ || document.querySelector('[data-v-app]'));
    if (!vueVer) {
      const vueRoot = document.querySelector('[data-v-app], #app, #__nuxt');
      if (vueRoot?.__vue_app__?.version) {
        vueVer = vueRoot.__vue_app__.version;
        hasVue = true;
      } else if (vueRoot?.__vue__) {
        hasVue = true;
      }
    }
    if (hasVue) add('vue', 'Vue.js', 'framework', vueVer, vueVer ? 'runtime-global' : 'dom-signature');
  } catch {}

  try {
    if (window.__NUXT__ || window.$nuxt || document.getElementById('__nuxt')) {
      add('nuxt', 'Nuxt', 'meta-framework', null, 'runtime-global');
    }
  } catch {}

  try {
    let svelteVer = null;
    if (window.__svelte?.v instanceof Set && window.__svelte.v.size > 0) {
      svelteVer = Array.from(window.__svelte.v)[0];
    }
    if (svelteVer || window.__svelte || document.querySelector('[class*="svelte-"]')) {
      add('svelte', 'Svelte', 'framework', svelteVer, svelteVer ? 'runtime-global' : 'dom-signature');
    }
  } catch {}

  try {
    const root = document.getElementById('app') || document.getElementById('root') || document.body?.firstElementChild;
    if (window.preact || (root && ('__k' in root || '_prevClass' in root))) {
      add('preact', 'Preact', 'framework', null, 'runtime-global');
    }
  } catch {}

  try {
    if (window._$HY || window.Solid$$) {
      add('solid', 'SolidJS', 'framework', null, 'runtime-global');
    }
  } catch {}

  try {
    const ngEl = document.querySelector('[ng-version]');
    if (ngEl || window.getAllAngularRootElements) {
      add('angular', 'Angular', 'framework', ngEl?.getAttribute('ng-version') || null, 'dom-signature');
    }
  } catch {}

  try {
    if (window.Alpine || document.querySelector('[x-data]')) {
      add('alpine', 'Alpine.js', 'framework', window.Alpine?.version || null, window.Alpine ? 'runtime-global' : 'dom-signature');
    }
  } catch {}

  try {
    if (window.htmx || document.querySelector('[hx-get], [hx-post], [hx-target], [data-hx-get]')) {
      add('htmx', 'htmx', 'framework', window.htmx?.version || null, window.htmx ? 'runtime-global' : 'dom-signature');
    }
  } catch {}

  try {
    const litVers = window.litElementVersions || window.litHtmlVersions;
    if ((Array.isArray(litVers) && litVers.length > 0) || window.litHtmlVersions) {
      add('lit', 'Lit', 'framework', Array.isArray(litVers) ? litVers[0] : null, 'runtime-global');
    }
  } catch {}

  try {
    if (document.querySelector('astro-island, astro-slot')) {
      add('astro', 'Astro', 'meta-framework', null, 'dom-signature');
    }
  } catch {}

  try {
    if (window.__remixContext || window.__reactRouterVersion) {
      add('remix', 'Remix / React Router', 'meta-framework', window.__reactRouterVersion || null, 'runtime-global');
    }
  } catch {}

  try {
    const jqVer = window.jQuery?.fn?.jquery || window.$?.fn?.jquery;
    if (jqVer) add('jquery', 'jQuery', 'framework', jqVer, 'runtime-global');
  } catch {}

  // 3D, Charts, Maps, Motion, Audio, Editors, Compilers
  try {
    if (window.THREE) {
      const rev = window.THREE.REVISION ? 'r' + window.THREE.REVISION : null;
      add('three', 'Three.js', '3d-graphics', rev, 'runtime-global');
    }
    if (window.BABYLON) add('babylon', 'Babylon.js', '3d-graphics', window.BABYLON.Engine?.Version || null, 'runtime-global');
    if (window.PIXI) add('pixi', 'PixiJS', '3d-graphics', window.PIXI.VERSION || null, 'runtime-global');
    if (window.Phaser) add('phaser', 'Phaser', '3d-graphics', window.Phaser.VERSION || null, 'runtime-global');
    if (window.Konva) add('konva', 'Konva', '3d-graphics', window.Konva.version || null, 'runtime-global');
    if (window.d3) add('d3', 'D3.js', 'charts', window.d3.version || null, 'runtime-global');
    if (window.Chart) add('chartjs', 'Chart.js', 'charts', window.Chart.version || null, 'runtime-global');
    if (document.querySelector('.recharts-wrapper, .recharts-surface')) add('recharts', 'Recharts', 'charts', null, 'dom-signature');
    if (window.echarts) add('echarts', 'Apache ECharts', 'charts', window.echarts.version || null, 'runtime-global');
    if (window.Plotly) add('plotly', 'Plotly.js', 'charts', window.Plotly.version || null, 'runtime-global');
    if (window.L?.version || document.querySelector('.leaflet-container')) {
      add('leaflet', 'Leaflet', 'maps', window.L?.version || null, window.L?.version ? 'runtime-global' : 'dom-signature');
    }
    if (window.mapboxgl || window.maplibregl || document.querySelector('.mapboxgl-map, .maplibregl-map')) {
      add('mapbox-gl', 'Mapbox / MapLibre GL', 'maps', window.mapboxgl?.version || window.maplibregl?.version || null, 'runtime-global');
    }
    if (window.gsap || window.TweenMax) {
      add('gsap', 'GSAP', 'animation', window.gsap?.version || window.TweenMax?.version || null, 'runtime-global');
    }
    if (document.querySelector('[data-projection-id]')) {
      add('framer-motion', 'Motion / Framer Motion', 'animation', null, 'dom-signature');
    }
    if (window.anime) add('animejs', 'Anime.js', 'animation', window.anime.version || null, 'runtime-global');
    if (window.Lenis || document.documentElement.classList.contains('lenis')) {
      add('lenis', 'Lenis Smooth Scroll', 'animation', null, 'dom-signature');
    }
    if (window.Swiper || document.querySelector('.swiper-wrapper')) {
      add('swiper', 'Swiper', 'ui-widget', null, 'dom-signature');
    }
    if (window.Sortable) add('sortablejs', 'SortableJS / dnd-kit', 'ui-widget', window.Sortable.version || null, 'runtime-global');
    if (window.marked) add('marked', 'Marked', 'markdown', null, 'runtime-global');
    if (window.Prism) add('prismjs', 'PrismJS', 'syntax', null, 'runtime-global');
    if (window.hljs) add('highlightjs', 'Highlight.js', 'syntax', window.hljs.versionString || null, 'runtime-global');
    if (window.monaco || document.querySelector('.monaco-editor')) add('monaco', 'Monaco Editor', 'editor', null, 'dom-signature');
    if (window.CodeMirror || document.querySelector('.cm-editor')) add('codemirror', 'CodeMirror', 'editor', window.CodeMirror?.version || null, 'dom-signature');
    if (window.Quill || document.querySelector('.ql-container')) add('quill', 'Quill', 'editor', window.Quill?.version || null, 'dom-signature');
    if (document.querySelector('.ProseMirror')) add('prosemirror-tiptap', 'TipTap / ProseMirror', 'editor', null, 'dom-signature');
    if (window.Tone) add('tonejs', 'Tone.js', 'audio', window.Tone.version || null, 'runtime-global');
    if (window.Howler) add('howler', 'Howler.js', 'audio', null, 'runtime-global');
    if (window.io?.protocol) add('socketio', 'Socket.IO', 'realtime', String(window.io.protocol), 'runtime-global');
    if (window._?.VERSION) add('lodash', 'Lodash', 'utility', window._.VERSION, 'runtime-global');
    if (window.moment?.version || window.dayjs) add('date-lib', 'date-fns / Day.js / Moment', 'utility', window.moment?.version || null, 'runtime-global');
    if (window.Babel) add('babel-standalone', '@babel/standalone (In-Browser JSX)', 'compiler', window.Babel.version || null, 'runtime-global');
    if (window.tailwind || document.querySelector('script[src*="cdn.tailwindcss.com"]')) {
      add('tailwind-cdn', 'Tailwind Play CDN', 'css', null, 'runtime-global');
    }
    if (window.lucide || document.querySelector('svg.lucide, [data-lucide]')) {
      add('lucide', 'Lucide Icons', 'icons', null, window.lucide ? 'runtime-global' : 'dom-signature');
    }
    if (document.querySelector('.fa-solid, .fas, .fab, link[href*="font-awesome"], link[href*="fontawesome"]')) {
      add('fontawesome', 'Font Awesome', 'icons', null, 'dom-signature');
    }
  } catch {}

  // 2. Wappalyzer-style CSS Custom Properties & Design System Signatures
  try {
    const rootStyle = getComputedStyle(document.documentElement);
    const bodyEl = document.body;
    if (window.bootstrap || rootStyle.getPropertyValue('--bs-blue') || rootStyle.getPropertyValue('--bs-body-bg')) {
      add('bootstrap', 'Bootstrap', 'css', window.bootstrap?.Tooltip?.VERSION || null, 'css-signature');
    }
    if (rootStyle.getPropertyValue('--chakra-colors-transparent')) {
      add('chakra', 'Chakra UI', 'ui-kit', null, 'css-signature');
    }
    if (document.documentElement.hasAttribute('data-mantine-color-scheme') || rootStyle.getPropertyValue('--mantine-color-body')) {
      add('mantine', 'Mantine', 'ui-kit', null, 'css-signature');
    }
    if (document.querySelector('[data-radix-popper-content-wrapper], [data-radix-collection-item], [data-radix-scroll-area-viewport]')) {
      add('shadcn-radix', 'Radix UI / shadcn', 'ui-kit', null, 'dom-signature');
    }
    if (document.querySelector('.MuiBox-root, .MuiButtonBase-root')) {
      add('mui', 'Material UI', 'ui-kit', null, 'dom-signature');
    }
    if (bodyEl) {
      const sampleEl = document.querySelector('.flex, .grid, [class*="bg-"], [class*="px-"]');
      if (sampleEl) {
        const cs = getComputedStyle(sampleEl);
        if (cs.getPropertyValue('--tw-ring-offset-width') || cs.getPropertyValue('--tw-border-style') || cs.getPropertyValue('--tw-translate-x')) {
          add('tailwind', 'Tailwind CSS', 'css', null, 'css-signature');
        }
      }
    }
  } catch {}

  // 3. Wappalyzer-style <meta name="generator"> & <script src> Semver URL Extraction
  try {
    const genMeta = document.querySelector('meta[name="generator"]')?.getAttribute('content') || '';
    if (genMeta) {
      const mAstro = genMeta.match(/Astro\s*v?([0-9][0-9A-Za-z.-]*)/i);
      if (mAstro) add('astro', 'Astro', 'meta-framework', mAstro[1], 'meta-generator');
      const mNext = genMeta.match(/Next\.js\s*v?([0-9][0-9A-Za-z.-]*)/i);
      if (mNext) add('nextjs', 'Next.js', 'meta-framework', mNext[1], 'meta-generator');
      const mNuxt = genMeta.match(/Nuxt\s*v?([0-9][0-9A-Za-z.-]*)/i);
      if (mNuxt) add('nuxt', 'Nuxt', 'meta-framework', mNuxt[1], 'meta-generator');
    }

    const scriptUrls = Array.from(document.querySelectorAll('script[src], link[rel="stylesheet"][href], link[rel="modulepreload"][href]'))
      .map((el) => el.getAttribute('src') || el.getAttribute('href') || '')
      .filter(Boolean);

    const urlRules = [
      { id: 'react', name: 'React', cat: 'framework', re: /react(?:@|[-/])([0-9]+\.[0-9]+\.[0-9]+)/i },
      { id: 'vue', name: 'Vue.js', cat: 'framework', re: /vue(?:@|[-/])([0-9]+\.[0-9]+\.[0-9]+)/i },
      { id: 'alpine', name: 'Alpine.js', cat: 'framework', re: /alpinejs(?:@|[-/])([0-9]+\.[0-9]+\.[0-9]+)/i },
      { id: 'htmx', name: 'htmx', cat: 'framework', re: /htmx(?:\.org)?(?:@|[-/])([0-9]+\.[0-9]+\.[0-9]+)/i },
      { id: 'three', name: 'Three.js', cat: '3d-graphics', re: /three(?:@|[-/])([0-9]+\.[0-9]+\.[0-9]+)/i },
      { id: 'd3', name: 'D3.js', cat: 'charts', re: /\bd3(?:@|[-/])([0-9]+\.[0-9]+\.[0-9]+)/i },
      { id: 'chartjs', name: 'Chart.js', cat: 'charts', re: /chart\.js(?:@|[-/])([0-9]+\.[0-9]+\.[0-9]+)/i },
      { id: 'gsap', name: 'GSAP', cat: 'animation', re: /gsap(?:@|[-/])([0-9]+\.[0-9]+\.[0-9]+)/i },
      { id: 'leaflet', name: 'Leaflet', cat: 'maps', re: /leaflet(?:@|[-/])([0-9]+\.[0-9]+\.[0-9]+)/i },
      { id: 'lucide', name: 'Lucide Icons', cat: 'icons', re: /lucide(?:@|[-/])([0-9]+\.[0-9]+\.[0-9]+)/i },
      { id: 'babel-standalone', name: '@babel/standalone (In-Browser JSX)', cat: 'compiler', re: /@babel\/standalone@([0-9]+\.[0-9]+\.[0-9]+)|babel-standalone\/([0-9]+\.[0-9]+\.[0-9]+)/i },
      { id: 'bootstrap', name: 'Bootstrap', cat: 'css', re: /bootstrap(?:@|[-/])([0-9]+\.[0-9]+\.[0-9]+)/i },
    ];
    for (const u of scriptUrls) {
      for (const r of urlRules) {
        const m = u.match(r.re);
        if (m) add(r.id, r.name, r.cat, m[1] || m[2] || null, 'script-url');
      }
    }
  } catch {}

  const globals = detections
    .filter((d) => d.signals.includes('runtime-global') || d.signals.includes('dom-fiber'))
    .map((d) => (d.id === 'tailwind-cdn' ? 'tailwind-play-jit' : d.id === 'babel-standalone' ? 'babel-standalone-jit' : d.id));

  return {
    detections,
    globals,
    metaGenerator: document.querySelector('meta[name="generator"]')?.getAttribute('content') || null,
    domElementCount: document.querySelectorAll('*').length,
    visibleTextLength: (document.body?.innerText || '').trim().length,
    canvasCount: document.querySelectorAll('canvas').length,
    svgCount: document.querySelectorAll('svg').length,
    formCount: document.querySelectorAll('form').length,
    buttonCount: document.querySelectorAll('button, [role="button"]').length,
    inputCount: document.querySelectorAll('input, select, textarea').length,
    dialogCount: document.querySelectorAll('dialog').length,
    closedByDialogCount: document.querySelectorAll('dialog[closedby]').length,
    popoverCount: document.querySelectorAll('[popover]').length,
    invokerButtonCount: document.querySelectorAll('button[commandfor], button[popovertarget]').length,
    searchLandmarkCount: document.querySelectorAll('search, [role="search"]').length,
  };
})()`;

function cleanSemverSpec(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '*' || trimmed === 'latest' || trimmed.startsWith('workspace:')) {
    return null;
  }
  const cleaned = trimmed.replace(/^[\^~>=<v\s]+/i, '').slice(0, 32);
  return /^[0-9]/.test(cleaned) ? cleaned : null;
}

export function extractPackageJsonDependencies(files = []) {
  const pkgFiles = files.filter((f) => /(?:^|\/)package\.json$/i.test(f.path || ''));
  const mergedDeps = new Map();
  for (const pf of pkgFiles) {
    try {
      const parsed = JSON.parse(pf.content || '{}');
      const all = {
        ...(parsed.devDependencies || {}),
        ...(parsed.dependencies || {}),
      };
      for (const [pkgName, verSpec] of Object.entries(all)) {
        const cleanVer = cleanSemverSpec(String(verSpec));
        if (!mergedDeps.has(pkgName) || (!mergedDeps.get(pkgName) && cleanVer)) {
          mergedDeps.set(pkgName, cleanVer);
        }
      }
    } catch {
      // ignore malformed package.json
    }
  }
  return mergedDeps;
}

/**
 * Reconciles `Library-Detector-for-Chrome` live JS/DOM detections, Wappalyzer HTTP headers / script URLs,
 * `package.json` dependency versions, and static source rules into a unified `detectedLibraries` list.
 */
export function reconcileDetectedLibraries({
  staticInfo = {},
  runtimeDetections = [],
  responseHeaders = {},
  files = [],
} = {}) {
  const byId = new Map();

  function upsert(id, { name, category, version = null, signal, confidence = 'high' }) {
    const catMeta = CATALOG_BY_ID.get(id);
    const resolvedName = name || catMeta?.name || id;
    const resolvedCategory = category || catMeta?.category || 'library';
    const existing = byId.get(id);
    if (existing) {
      if (!existing.version && version) existing.version = version;
      if (signal && !existing.signals.includes(signal)) existing.signals.push(signal);
      if (confidence === 'high') existing.confidence = 'high';
      return;
    }
    byId.set(id, {
      id,
      name: resolvedName,
      category: resolvedCategory,
      version: version || null,
      confidence,
      signals: signal ? [signal] : [],
    });
  }

  // 1. Live browser detections (highest priority for runtime version)
  for (const det of runtimeDetections || []) {
    if (!det?.id) continue;
    for (const sig of det.signals || ['runtime-global']) {
      upsert(det.id, {
        name: det.name,
        category: det.category,
        version: det.version || null,
        signal: sig,
        confidence: 'high',
      });
    }
  }

  // 2. Wappalyzer-style HTTP response header signatures
  const normHeaders = {};
  for (const [k, v] of Object.entries(responseHeaders || {})) {
    normHeaders[String(k).toLowerCase()] = String(v || '');
  }
  const poweredBy = normHeaders['x-powered-by'] || '';
  const serverHdr = normHeaders.server || '';
  if (/express/i.test(poweredBy)) {
    upsert('express', { name: 'Express', category: 'backend', signal: 'http-header', confidence: 'high' });
  }
  if (/next\.js/i.test(poweredBy) || normHeaders['x-nextjs-cache']) {
    const m = poweredBy.match(/next\.js\s*([0-9][0-9A-Za-z.-]*)/i);
    upsert('nextjs', { name: 'Next.js', category: 'meta-framework', version: m?.[1] || null, signal: 'http-header', confidence: 'high' });
  }
  if (/nuxt|nitro/i.test(poweredBy) || /nitro/i.test(serverHdr)) {
    upsert('nuxt', { name: 'Nuxt', category: 'meta-framework', signal: 'http-header', confidence: 'high' });
  }
  if (/fastify/i.test(poweredBy)) {
    upsert('fastify', { name: 'Fastify', category: 'backend', signal: 'http-header', confidence: 'high' });
  }
  if (/uvicorn|starlette|fastapi/i.test(serverHdr)) {
    upsert('fastapi', { name: 'Python FastAPI', category: 'backend', signal: 'http-header', confidence: 'high' });
  }

  // 3. Workspace package.json dependencies + semver versions
  const pkgDeps = extractPackageJsonDependencies(files);
  for (const catItem of CANONICAL_LIBRARY_CATALOG) {
    for (const npmPkg of catItem.npmPackages || []) {
      if (pkgDeps.has(npmPkg)) {
        upsert(catItem.id, {
          name: catItem.name,
          category: catItem.category,
          version: pkgDeps.get(npmPkg) || null,
          signal: 'package-json',
          confidence: 'high',
        });
      }
    }
  }

  // 4. Static source regex detections (frameworks, CSS, libraries)
  for (const fwId of staticInfo.detectedFrameworks || []) {
    if (fwId && fwId !== 'vanilla') {
      upsert(fwId, { signal: 'static-source', confidence: 'medium' });
    }
  }
  for (const cssId of staticInfo.detectedCss || []) {
    if (cssId && cssId !== 'vanilla-css') {
      upsert(cssId, { signal: 'static-source', confidence: 'medium' });
    }
  }
  for (const lib of staticInfo.libraries || []) {
    if (lib?.id) {
      upsert(lib.id, {
        name: lib.label,
        category: lib.category,
        signal: 'static-source',
        confidence: 'medium',
      });
    }
  }

  const categoryOrder = {
    'meta-framework': 1,
    framework: 2,
    css: 3,
    'ui-kit': 4,
    '3d-graphics': 5,
    charts: 6,
    maps: 7,
    animation: 8,
    editor: 9,
    audio: 10,
    realtime: 11,
    state: 12,
    icons: 13,
    compiler: 14,
    bundler: 15,
    backend: 16,
    database: 17,
  };

  return Array.from(byId.values()).sort((a, b) => {
    const oa = categoryOrder[a.category] || 50;
    const ob = categoryOrder[b.category] || 50;
    if (oa !== ob) return oa - ob;
    return a.name.localeCompare(b.name);
  });
}
