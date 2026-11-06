import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../util/env.mjs';
import { initializeModelRuntime } from '../harness/model-registry.mjs';
import {
  withIsolatedChrome,
  withTimeout,
  navigateAndSettle,
  capturePngScreenshot,
} from './cdp-helpers.mjs';

const PROMPT_STOPWORDS = new Set([
  'about', 'above', 'across', 'after', 'again', 'against', 'allow', 'allowing', 'allows', 'also',
  'application', 'around', 'based', 'basic', 'before', 'being', 'below', 'between', 'both', 'browse',
  'build', 'button', 'buttons', 'cards', 'change', 'changes', 'clean', 'clear', 'click', 'client',
  'clients', 'complete', 'content', 'control', 'controls', 'create', 'creating', 'current', 'custom',
  'dashboard', 'data', 'default', 'detail', 'detailed', 'details', 'different', 'direct', 'directly',
  'display', 'displays', 'each', 'easily', 'enable', 'enables', 'entry', 'entries', 'every', 'example',
  'experience', 'feature', 'features', 'field', 'fields', 'filter', 'filtering', 'first', 'flow',
  'flows', 'form', 'forms', 'from', 'full', 'fully', 'functional', 'functionality', 'interactive',
  'interface', 'into', 'item', 'items', 'layout', 'level', 'like', 'link', 'links', 'list', 'listing',
  'local', 'main', 'make', 'making', 'manage', 'management', 'managing', 'menu', 'modal', 'mode',
  'modern', 'more', 'multi', 'multiple', 'must', 'name', 'navigate', 'navigation', 'need', 'needs',
  'next', 'number', 'offer', 'offers', 'online', 'open', 'opening', 'option', 'options', 'order',
  'other', 'over', 'overview', 'page', 'pages', 'panel', 'part', 'people', 'platform', 'portal',
  'present', 'preview', 'primary', 'provide', 'provides', 'public', 'quick', 'quickly', 'read',
  'real', 'realistic', 'record', 'records', 'related', 'remove', 'request', 'requested', 'rich',
  'route', 'routes', 'save', 'saving', 'screen', 'search', 'searchable', 'section', 'sections',
  'select', 'selecting', 'selection', 'service', 'services', 'session', 'setting', 'settings',
  'should', 'show', 'showcase', 'showcases', 'showing', 'shows', 'simple', 'single', 'site', 'small',
  'some', 'specific', 'start', 'state', 'stateful', 'status', 'step', 'steps', 'store', 'style',
  'submit', 'submitting', 'support', 'supports', 'system', 'table', 'tabs', 'target', 'that', 'their',
  'them', 'then', 'there', 'these', 'they', 'this', 'through', 'time', 'title', 'tool', 'tools',
  'track', 'tracking', 'type', 'types', 'under', 'update', 'updates', 'updating', 'user', 'users',
  'using', 'value', 'values', 'view', 'viewer', 'viewing', 'views', 'visiting', 'visitor', 'visitors',
  'visual', 'website', 'websites', 'well', 'when', 'where', 'which', 'while', 'with', 'within',
  'without', 'work', 'workflow', 'workflows', 'working', 'workspace', 'your',
]);

const CRASH_BANNER_PATTERNS = [
  /^cannot\s+get\s+\//i,
  /\binternal\s+server\s+error\b/i,
  /\bunhandled\s+runtime\s+error\b/i,
  /\bapplication\s+error:\s+a\s+client-side\s+exception\s+has\s+occurred\b/i,
  /\berror:\s+cannot\s+find\s+module\b/i,
  /\bmodulenotfounderror\b/i,
  /\b502\s+bad\s+gateway\b/i,
  /\b500\s+server\s+error\b/i,
  /\btraceback\s+\(most\s+recent\s+call\s+last\)/i,
];

const BOILERPLATE_PATTERNS = [
  /edit\s+src\/app\.(?:tsx|jsx|vue|svelte)\s+and\s+save\s+to\s+(?:test\s+hmr|reload)/i,
  /get\s+started\s+by\s+editing\s+(?:src\/)?app\/page\.(?:tsx|jsx|js)/i,
  /^vite\s*\+\s*(?:react|vue|svelte|lit|preact|ts|typescript)$/im,
  /welcome\s+to\s+express/i,
];

function clampScore(val, fallback = 0) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function extractDomainKeywords(promptEntry = {}) {
  const rawSources = [
    promptEntry.title || '',
    promptEntry.prompt || '',
    ...(Array.isArray(promptEntry.expectedFlows) ? promptEntry.expectedFlows.map((f) => f.replace(/[-_]+/g, ' ')) : []),
  ].join(' ');

  const tokens = rawSources
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !PROMPT_STOPWORDS.has(w) && !/^\d+$/.test(w));

  return Array.from(new Set(tokens));
}

export function extractSeedDataAnchors(seedData) {
  if (!seedData || typeof seedData !== 'object') return [];
  const anchors = [];
  const primaryKeys = [
    'brandName', 'companyName', 'organizationName', 'studioName', 'publicationName',
    'academyName', 'clinicName', 'restaurantName', 'storeName', 'communityName',
    'appName', 'productName', 'siteName', 'name', 'title',
    'tagline', 'phone', 'email',
  ];

  for (const k of primaryKeys) {
    if (typeof seedData[k] === 'string' && seedData[k].trim().length >= 3) {
      anchors.push({ key: k, value: seedData[k].trim(), weight: k.toLowerCase().includes('name') ? 3 : 1.5 });
    }
  }

  if (seedData.location && typeof seedData.location === 'object') {
    for (const sub of ['city', 'address', 'street', 'neighborhood']) {
      if (typeof seedData.location[sub] === 'string' && seedData.location[sub].trim().length >= 4) {
        anchors.push({ key: `location.${sub}`, value: seedData.location[sub].trim(), weight: 1.5 });
      }
    }
  } else if (typeof seedData.address === 'string' && seedData.address.trim().length >= 4) {
    anchors.push({ key: 'address', value: seedData.address.trim(), weight: 1.5 });
  }

  // Pull up to 4 named starter items from arrays in seedData
  let itemCount = 0;
  for (const [k, v] of Object.entries(seedData)) {
    if (itemCount >= 4) break;
    if (Array.isArray(v)) {
      for (const entry of v.slice(0, 2)) {
        if (itemCount >= 4) break;
        if (entry && typeof entry === 'object') {
          const label = entry.name || entry.title || entry.label || entry.roaster || entry.course;
          if (typeof label === 'string' && label.trim().length >= 4) {
            anchors.push({ key: `${k}[]`, value: label.trim(), weight: 1 });
            itemCount++;
          }
        }
      }
    }
  }

  // Deduplicate by lowercase value
  const seen = new Set();
  return anchors.filter((a) => {
    const low = a.value.toLowerCase();
    if (seen.has(low)) return false;
    seen.add(low);
    return true;
  });
}

export async function collectRenderedJudgeEvidence({ url, cellDir, config }) {
  const screenshotsDir = join(cellDir, 'screenshots');
  mkdirSync(screenshotsDir, { recursive: true });
  const desktopPng = join(screenshotsDir, 'desktop.png');
  const mobilePng = join(screenshotsDir, 'mobile.png');

  const consoleErrors = [];
  const pageExceptions = [];

  const domSnapshot = await withIsolatedChrome(
    { viewport: config?.browser?.viewportDesktop || { width: 1440, height: 900 }, timeoutMs: 25000, label: 'prompt-judge' },
    async ({ client }) => {
      client.Runtime.consoleAPICalled((evt) => {
        if (evt.type === 'error') {
          const msg = (evt.args || []).map((a) => a.value || a.description || '').join(' ');
          if (msg) consoleErrors.push(msg.slice(0, 220));
        }
      });
      client.Runtime.exceptionThrown((evt) => {
        pageExceptions.push(
          (evt.exceptionDetails?.exception?.description || evt.exceptionDetails?.text || 'Uncaught error').slice(0, 220)
        );
      });

      await navigateAndSettle(client, url, config?.browser?.settleWaitMs || 1000);

      if (!existsSync(desktopPng)) {
        await capturePngScreenshot(client, desktopPng).catch(() => {});
      }

      const evalRes = await withTimeout(
        client.Runtime.evaluate({
          expression: `(() => {
            const visible = (el) => {
              if (!el || el.nodeType !== 1) return false;
              const s = window.getComputedStyle(el);
              if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
              const r = el.getBoundingClientRect();
              return r.width > 2 && r.height > 2;
            };

            const bodyText = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
            const words = bodyText ? bodyText.split(/\\s+/).filter(Boolean) : [];

            const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
              .filter(visible)
              .slice(0, 24)
              .map((h) => ({ tag: h.tagName.toLowerCase(), text: (h.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 140) }))
              .filter((h) => h.text.length > 0);

            const interactiveEls = Array.from(
              document.querySelectorAll('button, a[href], input, select, textarea, summary, [role="button"], [role="tab"], [role="menuitem"], [role="switch"], [role="slider"], [role="checkbox"], canvas')
            ).filter(visible);

            const interactiveControls = interactiveEls.slice(0, 45).map((el) => {
              const label = (
                el.getAttribute('aria-label') ||
                el.getAttribute('placeholder') ||
                el.innerText ||
                el.value ||
                el.getAttribute('name') ||
                el.getAttribute('title') ||
                ''
              ).replace(/\\s+/g, ' ').trim().slice(0, 90);
              return {
                tag: el.tagName.toLowerCase(),
                type: (el.getAttribute('type') || '').toLowerCase() || undefined,
                role: (el.getAttribute('role') || '').toLowerCase() || undefined,
                label,
              };
            });

            const imgs = Array.from(document.querySelectorAll('img')).filter(visible);
            const loadedImgCount = imgs.filter((img) => img.complete && img.naturalWidth > 0).length;
            const brokenImgCount = imgs.filter((img) => img.complete && img.naturalWidth === 0 && img.getAttribute('src')).length;

            const hasOverlay = Boolean(
              document.querySelector('vite-error-overlay, nextjs-portal [data-nextjs-dialog], #webpack-dev-server-client-overlay')
            );

            return {
              pageTitle: (document.title || '').trim().slice(0, 180),
              lang: document.documentElement?.getAttribute('lang') || null,
              visibleTextExcerpt: bodyText.slice(0, 4000),
              visibleTextLength: bodyText.length,
              visibleWordCount: words.length,
              headings,
              interactiveCount: interactiveEls.length,
              interactiveControls,
              landmarks: {
                hasMain: Boolean(document.querySelector('main, [role="main"]')),
                hasNav: Boolean(document.querySelector('nav, [role="navigation"]')),
                hasHeader: Boolean(document.querySelector('header')),
                hasFooter: Boolean(document.querySelector('footer')),
                formCount: document.querySelectorAll('form').length,
                dialogCount: document.querySelectorAll('dialog, [role="dialog"]').length,
                tableCount: document.querySelectorAll('table').length,
                canvasCount: document.querySelectorAll('canvas').length,
                svgCount: document.querySelectorAll('svg').length,
                mediaCount: document.querySelectorAll('audio, video').length,
                imgCount: imgs.length,
                loadedImgCount,
                brokenImgCount,
              },
              hasFrameworkErrorOverlay: hasOverlay,
            };
          })()`,
          returnByValue: true,
          timeout: 4500,
        }),
        6000,
        'prompt-judge DOM evaluation'
      ).catch(() => ({ result: { value: {} } }));

      if (!existsSync(mobilePng)) {
        await withTimeout(
          client.Emulation.setDeviceMetricsOverride({
            width: config?.browser?.viewportMobile?.width || 390,
            height: config?.browser?.viewportMobile?.height || 844,
            deviceScaleFactor: 2,
            mobile: true,
          }),
          4000,
          'prompt-judge mobile viewport'
        ).catch(() => {});
        await capturePngScreenshot(client, mobilePng).catch(() => {});
      }

      return evalRes?.result?.value || {};
    }
  );

  // Merge runtime error info from tech-stack if already recorded
  let techStackRuntime = null;
  const techPath = join(cellDir, 'results', 'tech-stack.json');
  if (existsSync(techPath)) {
    try {
      techStackRuntime = JSON.parse(readFileSync(techPath, 'utf8'))?.runtime || null;
    } catch {
      // ignore
    }
  }

  return {
    ...domSnapshot,
    consoleErrorCount: Math.max(consoleErrors.length, techStackRuntime?.consoleErrorCount || 0),
    pageExceptionCount: Math.max(pageExceptions.length, techStackRuntime?.pageExceptionCount || 0),
    consoleErrors: consoleErrors.length > 0 ? consoleErrors.slice(0, 8) : (techStackRuntime?.consoleErrors || []).slice(0, 8),
    pageExceptions: pageExceptions.length > 0 ? pageExceptions.slice(0, 8) : (techStackRuntime?.pageExceptions || []).slice(0, 8),
    hasDesktopScreenshot: existsSync(desktopPng),
    hasMobileScreenshot: existsSync(mobilePng),
  };
}

/**
 * Deterministic relevance & sanity analyzer.
 * Runs in <20ms with zero network calls; serves both as a hard pre-gate against blank/crashed/stub pages
 * and as a calibrated deterministic judge when `--skip-judge` is enabled or offline.
 */
export function evaluateDeterministicRelevance({
  evidence = {},
  promptEntry = {},
  spec = 'freeform',
  compiledFlow = null,
  materialization = null,
  sourceText = '',
}) {
  const visibleText = String(evidence.visibleTextExcerpt || '');
  const titleAndHeadings = [
    evidence.pageTitle || '',
    ...(evidence.headings || []).map((h) => h.text || ''),
  ].join(' ');
  const controlsText = (evidence.interactiveControls || []).map((c) => c.label || '').join(' ');
  const combinedRenderedLower = `${titleAndHeadings}\n${controlsText}\n${visibleText}`.toLowerCase();
  const combinedAllLower = `${combinedRenderedLower}\n${String(sourceText || '').slice(0, 30000).toLowerCase()}`;

  const wordCount = Number(evidence.visibleWordCount || 0);
  const interactiveCount = Number(evidence.interactiveCount || 0);
  const landmarks = evidence.landmarks || {};
  const canvasCount = Number(landmarks.canvasCount || 0);
  const svgCount = Number(landmarks.svgCount || 0);
  const isCreativeCanvasCategory = promptEntry?.category === 'games-creative';

  // 1. Check for crash banners & unedited starter boilerplate
  const matchedCrashBanner =
    Boolean(evidence.hasFrameworkErrorOverlay) ||
    (wordCount < 120 && CRASH_BANNER_PATTERNS.some((re) => re.test(visibleText.trim())));

  const matchedBoilerplate =
    wordCount < 80 && BOILERPLATE_PATTERNS.some((re) => re.test(visibleText) || re.test(titleAndHeadings));

  // 2. Domain keyword matching
  const domainKeywords = extractDomainKeywords(promptEntry);
  const matchedRenderedKeywords = [];
  const matchedSourceOnlyKeywords = [];

  for (const kw of domainKeywords) {
    const stem = kw.length >= 6 ? kw.slice(0, kw.length - 1) : kw;
    if (combinedRenderedLower.includes(kw) || combinedRenderedLower.includes(stem)) {
      matchedRenderedKeywords.push(kw);
    } else if (combinedAllLower.includes(kw) || combinedAllLower.includes(stem)) {
      matchedSourceOnlyKeywords.push(kw);
    }
  }

  const effectiveHits = matchedRenderedKeywords.length + matchedSourceOnlyKeywords.length * 0.4;
  // A realistic on-topic page typically hits at least 35-65% of extracted prompt nouns/verbs
  const targetHitCount = Math.max(2, Math.min(10, Math.ceil(domainKeywords.length * 0.45)));
  const rawKeywordRatio = domainKeywords.length > 0 ? Math.min(1, effectiveHits / targetHitCount) : 1;

  // 3. Guided seed-data fidelity check
  let guidedSeedSummary = null;
  let guidedFidelityScore = null;
  if (spec === 'guided' && promptEntry?.seedData) {
    const anchors = extractSeedDataAnchors(promptEntry.seedData);
    if (anchors.length > 0) {
      let totalW = 0;
      let hitW = 0;
      const matchedAnchors = [];
      const missingAnchors = [];
      for (const a of anchors) {
        totalW += a.weight;
        const needle = a.value.toLowerCase();
        if (combinedRenderedLower.includes(needle)) {
          hitW += a.weight;
          matchedAnchors.push(a.value);
        } else if (combinedAllLower.includes(needle)) {
          hitW += a.weight * 0.65;
          matchedAnchors.push(`${a.value} (in source/route)`);
        } else {
          missingAnchors.push(a.value);
        }
      }
      guidedFidelityScore = totalW > 0 ? clampScore((hitW / totalW) * 100) : 80;
      guidedSeedSummary = {
        totalAnchors: anchors.length,
        matchedCount: matchedAnchors.length,
        matchedAnchors: matchedAnchors.slice(0, 8),
        missingAnchors: missingAnchors.slice(0, 8),
        seedMatchPct: guidedFidelityScore,
      };
    }
  }

  // 4. Hard gate evaluation
  let passedGate = true;
  let failureCategory = null;
  let gateReason = null;

  if (matchedCrashBanner) {
    passedGate = false;
    failureCategory = 'blank-or-crashed';
    gateReason = 'Rendered page displays a runtime error overlay or server error response instead of the application.';
  } else if (wordCount < 5 && canvasCount === 0 && svgCount < 2 && interactiveCount === 0) {
    passedGate = false;
    failureCategory = 'blank-or-crashed';
    gateReason = 'Rendered page is blank (zero meaningful text, canvas, or interactive controls after hydration).';
  } else if (matchedBoilerplate) {
    passedGate = false;
    failureCategory = 'stub-placeholder';
    gateReason = 'Rendered page is unedited framework starter boilerplate rather than the requested application.';
  } else if (!isCreativeCanvasCategory && wordCount < 15 && canvasCount === 0 && interactiveCount < 2) {
    passedGate = false;
    failureCategory = 'stub-placeholder';
    gateReason = `Rendered page is an incomplete stub (${wordCount} visible words, ${interactiveCount} interactive elements).`;
  } else if (
    domainKeywords.length >= 4 &&
    matchedRenderedKeywords.length === 0 &&
    matchedSourceOnlyKeywords.length === 0 &&
    !(isCreativeCanvasCategory && canvasCount > 0 && interactiveCount >= 1)
  ) {
    passedGate = false;
    failureCategory = 'off-topic';
    gateReason = `Rendered page has zero lexical overlap with requested prompt "${promptEntry.title || promptEntry.id}".`;
  }

  // 5. Sub-scores
  const canvasBonus = isCreativeCanvasCategory && canvasCount > 0 ? 25 : 0;
  const onTopicScore = !passedGate && failureCategory === 'off-topic'
    ? clampScore(rawKeywordRatio * 35)
    : !passedGate
      ? clampScore(rawKeywordRatio * 25)
      : clampScore(Math.min(100, 35 + rawKeywordRatio * 65 + canvasBonus));

  const flowPct = typeof compiledFlow?.flowCompletionPct === 'number'
    ? compiledFlow.flowCompletionPct
    : (passedGate ? 60 : 0);

  const expectedFlows = Array.isArray(promptEntry?.expectedFlows) ? promptEntry.expectedFlows : [];
  const verifiedFeatures = [];
  const missingRequirements = [];

  for (const flowId of expectedFlows) {
    const tokens = flowId.toLowerCase().split(/[-_]+/).filter((t) => t.length >= 3);
    const hasMatch = tokens.some((t) => combinedAllLower.includes(t));
    if (hasMatch || (flowId.includes('submit') && landmarks.formCount > 0)) {
      verifiedFeatures.push(flowId);
    } else {
      missingRequirements.push(flowId);
    }
  }

  const expectedCoveragePct = expectedFlows.length > 0
    ? (verifiedFeatures.length / expectedFlows.length) * 100
    : (interactiveCount >= 4 ? 85 : interactiveCount * 20);

  const richnessScore = Math.min(
    100,
    (wordCount >= 80 || canvasCount > 0 ? 45 : wordCount * 0.5) +
      Math.min(35, interactiveCount * 5) +
      (landmarks.hasMain || landmarks.hasNav || landmarks.formCount > 0 || canvasCount > 0 ? 20 : 5)
  );

  const featureCoverageScore = !passedGate
    ? clampScore(Math.min(25, expectedCoveragePct * 0.25))
    : clampScore(expectedCoveragePct * 0.55 + richnessScore * 0.45);

  const exceptionPenalty = Math.min(45, (evidence.pageExceptionCount || 0) * 18 + (evidence.consoleErrorCount || 0) * 4);
  const brokenImgPenalty = Math.min(20, (landmarks.brokenImgCount || 0) * 5);
  const synthPenalty = materialization?.synthesizedWrapper ? 15 : 0;

  const functionalReadinessScore = !passedGate
    ? 0
    : clampScore(flowPct * 0.65 + richnessScore * 0.35 - exceptionPenalty * 0.5 - synthPenalty);

  const visualCoherenceScore = !passedGate
    ? 0
    : clampScore(
        88 +
          ((evidence.headings || []).length >= 2 ? 6 : 0) +
          (landmarks.hasMain ? 6 : 0) -
          exceptionPenalty -
          brokenImgPenalty
      );

  // Enforce minimum score gates even on deterministic path
  if (passedGate && onTopicScore < 45) {
    passedGate = false;
    failureCategory = 'off-topic';
    gateReason = `Low topical alignment (${onTopicScore}/100) with "${promptEntry.title || promptEntry.id}".`;
  } else if (passedGate && featureCoverageScore < 28) {
    passedGate = false;
    failureCategory = 'stub-placeholder';
    gateReason = `Insufficient feature coverage (${featureCoverageScore}/100) for requested workflows.`;
  }

  const overall = !passedGate
    ? 0
    : spec === 'guided' && typeof guidedFidelityScore === 'number'
      ? clampScore(
          onTopicScore * 0.30 +
            featureCoverageScore * 0.30 +
            functionalReadinessScore * 0.20 +
            visualCoherenceScore * 0.10 +
            guidedFidelityScore * 0.10
        )
      : clampScore(
          onTopicScore * 0.35 +
            featureCoverageScore * 0.35 +
            functionalReadinessScore * 0.20 +
            visualCoherenceScore * 0.10
        );

  const rationale = !passedGate
    ? gateReason
    : `Deterministic check passed: matched ${matchedRenderedKeywords.length}/${domainKeywords.length} domain terms, ${interactiveCount} interactive controls, and ${Math.round(flowPct)}% canonical journey completion${guidedSeedSummary ? ` (${guidedSeedSummary.matchedCount}/${guidedSeedSummary.totalAnchors} guided seed anchors)` : ''}.`;

  return {
    passedGate,
    failureCategory,
    overall,
    scores: {
      onTopic: onTopicScore,
      featureCoverage: featureCoverageScore,
      functionalReadiness: functionalReadinessScore,
      visualCoherence: visualCoherenceScore,
      guidedFidelity: guidedFidelityScore,
    },
    domainKeywordStats: {
      totalKeywords: domainKeywords.length,
      renderedMatches: matchedRenderedKeywords.slice(0, 18),
      sourceOnlyMatches: matchedSourceOnlyKeywords.slice(0, 10),
    },
    guidedSeedSummary,
    verifiedFeatures,
    missingRequirements,
    rationale,
  };
}

function parseJudgeJsonFromText(rawText = '') {
  const trimmed = String(rawText || '').trim();
  if (!trimmed) return null;

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch ? fenceMatch[1].trim() : trimmed;
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) return null;

  try {
    return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
  } catch {
    return null;
  }
}

function resolveReadyJudgeRoute(runtime, config = {}) {
  const candidates = [
    config.judge?.judgeModel,
    ...(Array.isArray(config.judge?.fallbackJudgeModels) ? config.judge.fallbackJudgeModels : []),
    config.uplift?.judgeModel,
    config.uplift?.fallbackJudgeModel,
    'google/gemini-3.8-flash',
    'openai/gpt-6.1-sol',
    'anthropic/claude-haiku-5-5',
    'deepseek/deepseek-flash',
    'xai/grok-4.6',
  ].filter(Boolean);

  for (const sel of candidates) {
    const low = String(sel).toLowerCase();
    const hit = runtime.models.find((m) => {
      if (!m.ready || !m.activeRoute?.piModel) return false;
      if (m.key.toLowerCase() === low) return true;
      const fullActive = `${m.activeRoute.provider}/${m.activeRoute.modelId}`.toLowerCase();
      if (fullActive === low || m.activeRoute.modelId.toLowerCase() === low) return true;
      return (m.routes || []).some(
        (r) => `${r.provider}/${r.modelId}`.toLowerCase() === low || String(r.modelId).toLowerCase() === low
      );
    });
    if (hit) {
      return {
        modelKey: hit.key,
        label: hit.label,
        provider: hit.activeRoute.provider,
        modelId: hit.activeRoute.modelId,
        piModel: hit.activeRoute.piModel,
      };
    }
  }

  // Fallback to any ready pi-ai transport model
  const anyReady = runtime.models.find((m) => m.ready && m.activeRoute?.piModel && m.activeRoute.transport === 'pi-ai');
  if (!anyReady) return null;
  return {
    modelKey: anyReady.key,
    label: anyReady.label,
    provider: anyReady.activeRoute.provider,
    modelId: anyReady.activeRoute.modelId,
    piModel: anyReady.activeRoute.piModel,
  };
}

/**
 * Evaluates captured static cell evidence (`evidence` + `desktop.png` / `mobile.png` + prompt spec)
 * with a multimodal LLM judge. Safe to invoke offline or post-audit (`--judge-only`) with zero
 * untrusted server execution.
 */
export async function runMultimodalLlmJudge({
  cellDir,
  promptEntry,
  spec = 'freeform',
  evidence,
  deterministic,
  compiledFlow = null,
  config = {},
  runtime = null,
}) {
  const rt = runtime || (await initializeModelRuntime());
  const judgeRoute = resolveReadyJudgeRoute(rt, config);
  if (!judgeRoute) {
    return {
      attempted: false,
      succeeded: false,
      reason: 'No ready LLM credentials available for multimodal judge.',
    };
  }

  const supportsVision = Array.isArray(judgeRoute.piModel?.input) && judgeRoute.piModel.input.includes('image');
  const contentBlocks = [];

  if (supportsVision) {
    const desktopPath = join(cellDir, 'screenshots', 'desktop.png');
    if (existsSync(desktopPath)) {
      contentBlocks.push({
        type: 'image',
        data: readFileSync(desktopPath).toString('base64'),
        mimeType: 'image/png',
      });
    }
    if (spec === 'guided' && promptEntry?.id) {
      const refPath = join(PROJECT_ROOT, 'assets', 'reference-images', `${promptEntry.id}.jpg`);
      if (existsSync(refPath)) {
        contentBlocks.push({
          type: 'image',
          data: readFileSync(refPath).toString('base64'),
          mimeType: 'image/jpeg',
        });
      }
    }
  }

  const journeySummary = compiledFlow?.steps
    ? compiledFlow.steps.map((s) => `${s.stepId} (${s.label}): ${s.succeeded ? 'PASS' : 'FAIL'}${s.mutated ? ' [DOM updated]' : ''}`)
    : ['(no journey recorded)'];

  const evidenceSummary = {
    requestedCategory: promptEntry?.categoryLabel || promptEntry?.category || '',
    requestedTitle: promptEntry?.title || promptEntry?.id || '',
    requestedPrompt: promptEntry?.prompt || '',
    expectedFlows: promptEntry?.expectedFlows || [],
    specMode: spec,
    guidedSeedExpectation: spec === 'guided' ? deterministic?.guidedSeedSummary || null : null,
    renderedPage: {
      title: evidence?.pageTitle || '',
      visibleWordCount: evidence?.visibleWordCount || 0,
      headings: (evidence?.headings || []).slice(0, 15),
      landmarks: evidence?.landmarks || {},
      interactiveCount: evidence?.interactiveCount || 0,
      sampleInteractiveControls: (evidence?.interactiveControls || []).slice(0, 28),
      consoleErrorCount: evidence?.consoleErrorCount || 0,
      pageExceptionCount: evidence?.pageExceptionCount || 0,
      pageExceptions: (evidence?.pageExceptions || []).slice(0, 4),
      visibleTextExcerpt: String(evidence?.visibleTextExcerpt || '').slice(0, 2600),
    },
    automatedJourneySteps: journeySummary,
    journeyCompletionPct: compiledFlow?.flowCompletionPct ?? null,
  };

  const judgeSystemPrompt = [
    'You are an impartial, strict Web Application Benchmark Judge.',
    'Your job is to verify whether a generated web application actually built the requested on-topic application with real interactive functionality, rather than an empty shell, error screen, starter boilerplate, placeholder stub, or off-topic page.',
    'STRICT ZERO-STACK-BIAS RULE: Judge ONLY the user-visible application, topical relevance, requirement coverage, functional completeness, and visual layout coherence. NEVER reward or penalize choice of JavaScript framework, CSS library, or backend language.',
    spec === 'guided' && supportsVision
      ? 'Image 1 is the rendered desktop build screenshot; Image 2 (if attached) is the proposed reference layout image. Evaluate guided layout & canonical seed-data fidelity in `guidedFidelityScore` (0-100).'
      : supportsVision
        ? 'Image 1 (if attached) is the rendered desktop build screenshot.'
        : '',
    'Return ONLY a single valid JSON object matching this exact schema (no markdown prose outside JSON):',
    JSON.stringify({
      passedGate: true,
      failureCategory: null,
      onTopicScore: 92,
      featureCoverageScore: 85,
      functionalReadinessScore: 80,
      visualCoherenceScore: 88,
      guidedFidelityScore: spec === 'guided' ? 85 : null,
      verifiedFeatures: ['feature-1', 'feature-2'],
      missingRequirements: ['missing-item-if-any'],
      rationale: '1-3 concise sentences grounded in the rendered page and screenshot evidence.',
    }),
    'Rules for `passedGate` and `failureCategory`:',
    '- Set `passedGate: false` if the build is blank/crashed (`"blank-or-crashed"`), off-topic/wrong domain (`"off-topic"`), unedited boilerplate or trivial non-functional placeholder (`"stub-placeholder"`), or completely non-interactive when interactivity is core (`"broken-core-flow"`).',
    '- Set `failureCategory: null` when `passedGate: true`.',
  ].filter(Boolean).join('\n');

  contentBlocks.push({
    type: 'text',
    text: `Evaluate this generated build against the benchmark prompt:\n\n\`\`\`json\n${JSON.stringify(evidenceSummary, null, 2)}\n\`\`\``,
  });

  const ac = new AbortController();
  const timeoutMs = config.judge?.timeoutMs || 45000;
  const timer = setTimeout(() => ac.abort(new Error('LLM judge timeout')), timeoutMs);

  try {
    const streamOpts = {
      maxTokens: 1500,
      signal: ac.signal,
    };
    if (judgeRoute.piModel.reasoning) {
      streamOpts.reasoning = 'low';
    }

    const stream = rt.piModels.streamSimple(
      judgeRoute.piModel,
      {
        systemPrompt: judgeSystemPrompt,
        messages: [
          {
            role: 'user',
            content: contentBlocks.length === 1 ? contentBlocks[0].text : contentBlocks,
            timestamp: Date.now(),
          },
        ],
      },
      streamOpts
    );

    const assistantMsg = await stream.result();
    clearTimeout(timer);

    const rawText = Array.isArray(assistantMsg?.content)
      ? rt.piAi.contentText(assistantMsg.content) || ''
      : '';
    const parsed = parseJudgeJsonFromText(rawText);
    if (!parsed || typeof parsed !== 'object') {
      return {
        attempted: true,
        succeeded: false,
        judgeModel: `${judgeRoute.provider}/${judgeRoute.modelId}`,
        reason: `Judge returned unparseable JSON: ${rawText.slice(0, 180)}`,
      };
    }

    const minOnTopic = config.judge?.minOnTopicScore ?? 50;
    const minCoverage = config.judge?.minFeatureCoverageScore ?? 30;

    const onTopic = clampScore(parsed.onTopicScore, deterministic.scores.onTopic);
    const featureCoverage = clampScore(parsed.featureCoverageScore, deterministic.scores.featureCoverage);
    const functionalReadiness = clampScore(parsed.functionalReadinessScore, deterministic.scores.functionalReadiness);
    const visualCoherence = clampScore(parsed.visualCoherenceScore, deterministic.scores.visualCoherence);
    const guidedFidelity =
      spec === 'guided'
        ? clampScore(parsed.guidedFidelityScore, deterministic.scores.guidedFidelity ?? 80)
        : null;

    let passedGate = Boolean(parsed.passedGate);
    let failureCategory = passedGate ? null : (parsed.failureCategory || 'stub-placeholder');

    if (onTopic < minOnTopic) {
      passedGate = false;
      failureCategory = 'off-topic';
    } else if (featureCoverage < minCoverage) {
      passedGate = false;
      failureCategory = failureCategory || 'stub-placeholder';
    }

    const overall = !passedGate
      ? 0
      : spec === 'guided' && typeof guidedFidelity === 'number'
        ? clampScore(
            onTopic * 0.30 +
              featureCoverage * 0.30 +
              functionalReadiness * 0.20 +
              visualCoherence * 0.10 +
              guidedFidelity * 0.10
          )
        : clampScore(
            onTopic * 0.35 +
              featureCoverage * 0.35 +
              functionalReadiness * 0.20 +
              visualCoherence * 0.10
          );

    return {
      attempted: true,
      succeeded: true,
      judgeModel: `${judgeRoute.provider}/${judgeRoute.modelId}`,
      visionUsed: supportsVision && contentBlocks.some((b) => b.type === 'image'),
      passedGate,
      failureCategory,
      overall,
      scores: {
        onTopic,
        featureCoverage,
        functionalReadiness,
        visualCoherence,
        guidedFidelity,
      },
      verifiedFeatures: Array.isArray(parsed.verifiedFeatures)
        ? parsed.verifiedFeatures.map(String).slice(0, 12)
        : deterministic.verifiedFeatures,
      missingRequirements: Array.isArray(parsed.missingRequirements)
        ? parsed.missingRequirements.map(String).slice(0, 12)
        : deterministic.missingRequirements,
      rationale: typeof parsed.rationale === 'string' && parsed.rationale.trim()
        ? parsed.rationale.trim().slice(0, 600)
        : deterministic.rationale,
    };
  } catch (err) {
    clearTimeout(timer);
    return {
      attempted: true,
      succeeded: false,
      judgeModel: `${judgeRoute.provider}/${judgeRoute.modelId}`,
      reason: err.message || String(err),
    };
  }
}

/**
 * Post-audit helper (`--judge-only`) that upgrades existing `results/prompt-judge.json` files
 * using the multimodal LLM judge without booting any generated `$PORT` servers.
 */
export async function upgradeCellWithLlmJudge({ cellDir, promptEntry, config = {}, runtime = null }) {
  const resultPath = join(cellDir, 'results', 'prompt-judge.json');
  if (!existsSync(resultPath)) return null;

  const existing = JSON.parse(readFileSync(resultPath, 'utf8'));
  // If deterministic hard pre-gate caught a literal blank/crash/boilerplate screen, keep hard failure
  if (
    existing.deterministicPreGateFailed &&
    (existing.failureCategory === 'blank-or-crashed' || existing.failureCategory === 'stub-placeholder')
  ) {
    return existing;
  }

  let compiledFlow = null;
  const flowPath = join(cellDir, 'compiled-flow.json');
  if (existsSync(flowPath)) {
    try {
      compiledFlow = JSON.parse(readFileSync(flowPath, 'utf8'));
    } catch {
      // ignore
    }
  }

  const llmRes = await runMultimodalLlmJudge({
    cellDir,
    promptEntry,
    spec: existing.spec || 'freeform',
    evidence: existing.evidence || {},
    deterministic: existing.deterministic || existing,
    compiledFlow,
    config,
    runtime,
  });

  if (!llmRes.succeeded) {
    const updated = {
      ...existing,
      llmJudgeAttempted: llmRes.attempted,
      llmJudgeFallbackNote: llmRes.reason,
    };
    writeFileSync(resultPath, JSON.stringify(updated, null, 2) + '\n', 'utf8');
    return updated;
  }

  const upgraded = {
    ...existing,
    evaluatedAt: new Date().toISOString(),
    evaluationMode: 'multimodal-llm-judge',
    judgeModel: llmRes.judgeModel,
    visionUsed: llmRes.visionUsed,
    passedGate: llmRes.passedGate,
    failureCategory: llmRes.failureCategory,
    overall: llmRes.overall,
    scores: llmRes.scores,
    verifiedFeatures: llmRes.verifiedFeatures,
    missingRequirements: llmRes.missingRequirements,
    rationale: llmRes.rationale,
  };
  writeFileSync(resultPath, JSON.stringify(upgraded, null, 2) + '\n', 'utf8');
  return upgraded;
}

export default {
  id: 'prompt-judge',
  label: 'On-Topic & Functional Judge',
  version: '1.0.0',
  requiresBrowser: true,

  async run(ctx) {
    const {
      url,
      cellDir,
      extraction,
      materialization,
      compiledFlow,
      promptEntry,
      config,
      options = {},
      onProgress,
    } = ctx;

    let spec = 'freeform';
    const genPath = join(cellDir, 'generation.json');
    if (existsSync(genPath)) {
      try {
        const gen = JSON.parse(readFileSync(genPath, 'utf8'));
        if (gen.spec === 'guided' || gen.exactPrompt?.spec === 'guided') spec = 'guided';
      } catch {
        // ignore
      }
    }

    onProgress?.({
      stage: 'prompt-judge',
      detail: 'Inspecting rendered DOM, domain topicality & functional surface',
    });

    const evidence = await collectRenderedJudgeEvidence({ url, cellDir, config });
    const sourceText = (extraction?.files || []).map((f) => f.content || '').join('\n');

    const deterministic = evaluateDeterministicRelevance({
      evidence,
      promptEntry,
      spec,
      compiledFlow,
      materialization,
      sourceText,
    });

    // Hard crash / literally blank / starter boilerplate fails immediately without wasting LLM tokens
    const deterministicHardScreenCrash =
      !deterministic.passedGate &&
      (deterministic.failureCategory === 'blank-or-crashed' ||
        (deterministic.failureCategory === 'stub-placeholder' && (evidence.visibleWordCount || 0) < 15));

    let finalVerdict = {
      evaluationMode: 'deterministic',
      judgeModel: null,
      visionUsed: false,
      passedGate: deterministic.passedGate,
      failureCategory: deterministic.failureCategory,
      overall: deterministic.overall,
      scores: deterministic.scores,
      verifiedFeatures: deterministic.verifiedFeatures,
      missingRequirements: deterministic.missingRequirements,
      rationale: deterministic.rationale,
    };

    if (!deterministicHardScreenCrash && config?.judge?.enabled !== false && !options.skipJudge) {
      onProgress?.({
        stage: 'prompt-judge',
        detail: 'Running multimodal LLM on-topic & requirement coverage judge',
      });
      const llmRes = await runMultimodalLlmJudge({
        cellDir,
        promptEntry,
        spec,
        evidence,
        deterministic,
        compiledFlow,
        config,
      });
      if (llmRes.succeeded) {
        finalVerdict = {
          evaluationMode: 'multimodal-llm-judge',
          judgeModel: llmRes.judgeModel,
          visionUsed: llmRes.visionUsed,
          passedGate: llmRes.passedGate,
          failureCategory: llmRes.failureCategory,
          overall: llmRes.overall,
          scores: llmRes.scores,
          verifiedFeatures: llmRes.verifiedFeatures,
          missingRequirements: llmRes.missingRequirements,
          rationale: llmRes.rationale,
        };
      } else {
        finalVerdict.llmJudgeFallbackNote = llmRes.reason;
      }
    }

    const out = {
      benchmarkId: 'prompt-judge',
      measuredAt: new Date().toISOString(),
      spec,
      deterministicPreGateFailed: deterministicHardScreenCrash,
      ...finalVerdict,
      domainKeywordStats: deterministic.domainKeywordStats,
      guidedSeedSummary: deterministic.guidedSeedSummary,
      deterministic,
      evidence,
    };

    const resultsDir = join(cellDir, 'results');
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(join(resultsDir, 'prompt-judge.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
    return out;
  },

  score(result) {
    const passedGate = Boolean(result?.passedGate);
    return {
      passedGate,
      failureCategory: result?.failureCategory || null,
      overall: passedGate ? clampScore(result?.overall ?? 0) : 0,
      onTopicScore: clampScore(result?.scores?.onTopic ?? 0),
      featureCoverageScore: clampScore(result?.scores?.featureCoverage ?? 0),
      functionalReadinessScore: clampScore(result?.scores?.functionalReadiness ?? 0),
      visualCoherenceScore: clampScore(result?.scores?.visualCoherence ?? 0),
      guidedFidelityScore: result?.scores?.guidedFidelity != null ? clampScore(result.scores.guidedFidelity) : null,
      evaluationMode: result?.evaluationMode || 'deterministic',
      judgeModel: result?.judgeModel || null,
      rationale: result?.rationale || null,
    };
  },
};
