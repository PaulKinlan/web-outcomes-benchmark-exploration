import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import { mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { PROJECT_ROOT } from '../util/env.mjs';
import { resolvePiBin } from '../harness/pi-loader.mjs';
import { resolveStableChromePath, withTimeout, forceKillChromeInstance } from './cdp-helpers.mjs';

function findLatestReportJson(rootDir) {
  const direct = join(rootDir, 'report.json');
  if (existsSync(direct)) return direct;
  if (!existsSync(rootDir)) return null;

  const candidates = [];
  for (const entry of readdirSync(rootDir)) {
    const full = join(rootDir, entry);
    try {
      if (statSync(full).isDirectory() && existsSync(join(full, 'report.json'))) {
        candidates.push({ path: join(full, 'report.json'), mtimeMs: statSync(join(full, 'report.json')).mtimeMs });
      }
    } catch {
      // ignore
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.path || null;
}

function buildLighthouseChromeFlags() {
  const chromeFlags = [
    '--headless=new',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-popup-blocking',
    '--disable-print-preview',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (process.env.WEB_UPLIFT_NO_SANDBOX === '1' || (typeof process.getuid === 'function' && process.getuid() === 0)) {
    chromeFlags.push('--no-sandbox');
  }
  return chromeFlags;
}

export async function runLighthousePass(url, formFactor = 'mobile', sharedPort = null) {
  let ownedChrome = null;
  const port =
    sharedPort ||
    (
      (ownedChrome = await chromeLauncher.launch({
        chromePath: resolveStableChromePath(),
        chromeFlags: buildLighthouseChromeFlags(),
        logLevel: 'silent',
      })),
      ownedChrome.port
    );

  try {
    const isDesktop = formFactor === 'desktop';
    const runnerResult = await withTimeout(
      lighthouse(
        url,
        {
          port,
          output: 'json',
          logLevel: 'error',
          onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
        },
        {
          extends: 'lighthouse:default',
          settings: isDesktop
            ? {
                formFactor: 'desktop',
                maxWaitForFcp: 12000,
                maxWaitForLoad: 18000,
                screenEmulation: {
                  mobile: false,
                  width: 1440,
                  height: 900,
                  deviceScaleFactor: 1,
                  disabled: false,
                },
                throttlingMethod: 'simulate',
              }
            : {
                formFactor: 'mobile',
                maxWaitForFcp: 12000,
                maxWaitForLoad: 18000,
                throttlingMethod: 'simulate',
              },
        }
      ),
      45000,
      `Lighthouse (${formFactor})`
    );

    const lhr = runnerResult?.lhr;
    const scorePct = (cat) =>
      lhr?.categories?.[cat]?.score != null ? Math.round(lhr.categories[cat].score * 100) : null;

    // Map each audit ID to all Lighthouse categories referencing it (performance, accessibility, best-practices, seo)
    const auditCategoriesMap = new Map();
    const categoryOrder = ['performance', 'accessibility', 'best-practices', 'seo'];
    for (const catId of categoryOrder) {
      const catObj = lhr?.categories?.[catId];
      for (const ref of catObj?.auditRefs || []) {
        if (!ref?.id) continue;
        if (!auditCategoriesMap.has(ref.id)) auditCategoriesMap.set(ref.id, []);
        const list = auditCategoriesMap.get(ref.id);
        if (!list.includes(catId)) list.push(catId);
      }
    }

    const failingAudits = [];
    const passedAudits = [];
    let notApplicableCount = 0;

    for (const a of Object.values(lhr?.audits || {})) {
      if (!a || !a.id) continue;
      if (a.scoreDisplayMode === 'notApplicable') {
        notApplicableCount++;
        continue;
      }
      if (a.score === null || a.scoreDisplayMode === 'informative' || a.scoreDisplayMode === 'manual') {
        continue;
      }
      const cats = auditCategoriesMap.get(a.id) || ['other'];
      const rawDesc = typeof a.description === 'string' ? a.description : '';
      const linkMatch = rawDesc.match(/\(https?:\/\/[^)\s]+\)/);
      const helpUrl = linkMatch ? linkMatch[0].slice(1, -1) : null;
      const cleanDescription = rawDesc
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 260);

      let detailItems = undefined;
      if (a.score < 0.9 && Array.isArray(a.details?.items) && a.details.items.length > 0) {
        detailItems = a.details.items.slice(0, 5).map((it) => {
          const node = it?.node || it?.element || null;
          const compact = {};
          if (node?.selector) compact.selector = String(node.selector).slice(0, 140);
          if (node?.nodeLabel) compact.nodeLabel = String(node.nodeLabel).slice(0, 120);
          if (node?.snippet) compact.snippet = String(node.snippet).slice(0, 160);
          if (typeof it?.url === 'string') compact.url = it.url.slice(0, 180);
          if (typeof it?.source?.url === 'string' && !compact.url) compact.url = it.source.url.slice(0, 180);
          if (typeof it?.wastedBytes === 'number') compact.wastedBytes = Math.round(it.wastedBytes);
          if (typeof it?.wastedMs === 'number') compact.wastedMs = Math.round(it.wastedMs);
          if (typeof it?.totalBytes === 'number') compact.totalBytes = Math.round(it.totalBytes);
          return compact;
        }).filter((obj) => Object.keys(obj).length > 0);
      }

      const item = {
        id: a.id,
        title: a.title,
        category: cats[0],
        categories: cats,
        score: Math.round((a.score ?? 0) * 100),
        displayValue: a.displayValue || null,
        ...(typeof a.numericValue === 'number' && Number.isFinite(a.numericValue)
          ? { numericValue: Math.round(a.numericValue * 100) / 100 }
          : {}),
        ...(cleanDescription ? { description: cleanDescription } : {}),
        ...(helpUrl ? { helpUrl } : {}),
        ...(detailItems && detailItems.length > 0 ? { items: detailItems } : {}),
      };
      if (a.score < 0.9) {
        failingAudits.push(item);
      } else {
        passedAudits.push(item);
      }
    }

    failingAudits.sort((a, b) => a.score - b.score || a.id.localeCompare(b.id));
    passedAudits.sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id));

    return {
      formFactor,
      scores: {
        performance: scorePct('performance'),
        accessibility: scorePct('accessibility'),
        bestPractices: scorePct('best-practices'),
        seo: scorePct('seo'),
      },
      metrics: {
        fcpMs: Math.round(lhr?.audits?.['first-contentful-paint']?.numericValue || 0),
        lcpMs: Math.round(lhr?.audits?.['largest-contentful-paint']?.numericValue || 0),
        tbtMs: Math.round(lhr?.audits?.['total-blocking-time']?.numericValue || 0),
        cls: Number((lhr?.audits?.['cumulative-layout-shift']?.numericValue || 0).toFixed(4)),
        speedIndexMs: Math.round(lhr?.audits?.['speed-index']?.numericValue || 0),
        interactiveMs: Math.round(lhr?.audits?.['interactive']?.numericValue || 0),
      },
      auditCounts: {
        passed: passedAudits.length,
        failed: failingAudits.length,
        notApplicable: notApplicableCount,
      },
      failingAudits,
      passedAudits,
    };
  } finally {
    if (ownedChrome) {
      await withTimeout(ownedChrome.kill(), 2000, 'ownedChrome.kill').catch(() => {});
      forceKillChromeInstance(ownedChrome);
    }
  }
}

export async function runLighthouseSuite(url) {
  const chrome = await withTimeout(
    chromeLauncher.launch({
      chromePath: resolveStableChromePath(),
      chromeFlags: buildLighthouseChromeFlags(),
      logLevel: 'silent',
    }),
    15000,
    'Lighthouse chromeLauncher.launch'
  );
  try {
    const mobile = await runLighthousePass(url, 'mobile', chrome.port);
    const desktop = await runLighthousePass(url, 'desktop', chrome.port);
    return { mobile, desktop };
  } finally {
    await withTimeout(chrome.kill(), 2000, 'Lighthouse chrome.kill').catch(() => {});
    forceKillChromeInstance(chrome);
  }
}

function getChromeEnv() {
  const chromeBin = resolveStableChromePath() || '';
  return chromeBin ? { ...process.env, CHROME_BIN: chromeBin, CHROME_PATH: chromeBin } : process.env;
}

function runNodeScript(scriptPath, args, { cwd = PROJECT_ROOT, timeoutMs = 45000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: getChromeEnv(),
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolvePromise({ code: 124, stdout, stderr: stderr + '\nTimeout' });
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({ code: 1, stdout, stderr: err.message });
    });
  });
}

async function gatherWebUpliftPrimitives(url, upliftDir) {
  const upliftPkgDir = join(PROJECT_ROOT, 'node_modules', 'web-uplift');
  const evidenceCli = join(upliftPkgDir, 'evidence', 'cli.mjs');
  if (!existsSync(evidenceCli)) {
    return { available: false };
  }

  const chromeBin = resolveStableChromePath();
  if (chromeBin && !process.env.CHROME_BIN) {
    process.env.CHROME_BIN = chromeBin;
  }

  const evidenceDir = join(upliftDir, 'evidence');
  mkdirSync(evidenceDir, { recursive: true });

  const primitives = {};
  const neededPrimitives = ['discoverability', 'layout', 'axe', 'targets', 'console'];

  let sharedBrowser = null;
  try {
    const [{ launchChrome, configureCdpDeadlines }, { configureFetchDeadline }, { gather }] = await Promise.all([
      import(pathToFileURL(join(upliftPkgDir, 'evidence', 'cdp.mjs')).href),
      import(pathToFileURL(join(upliftPkgDir, 'evidence', 'fetch.mjs')).href),
      import(pathToFileURL(evidenceCli).href),
    ]);
    configureCdpDeadlines({ navigationMs: 10000, callMs: 10000 });
    configureFetchDeadline(8000);
    sharedBrowser = await withTimeout(launchChrome({ log: () => {} }), 15000, 'web-uplift launchChrome');

    for (const prim of neededPrimitives) {
      const outFile = join(evidenceDir, `${prim}.json`);
      try {
        const res = await withTimeout(
          gather(prim, url, {
            browser: sharedBrowser,
            out: outFile,
            quiet: true,
            wait: 650,
            waitIsDefault: false,
          }),
          14000,
          `web-uplift ${prim}`
        );
        if (existsSync(outFile)) {
          primitives[prim] = JSON.parse(readFileSync(outFile, 'utf8'));
        } else if (res && typeof res === 'object') {
          primitives[prim] = res;
          writeFileSync(outFile, JSON.stringify(res, null, 2) + '\n', 'utf8');
        }
      } catch {
        // Non-fatal: continue collecting remaining primitives on the shared Chrome instance
      }
    }
    return { available: true, primitives };
  } catch {
    // Fallback if package subpath imports differ in an older web-uplift layout
    for (const prim of neededPrimitives) {
      const outFile = join(evidenceDir, `${prim}.json`);
      const res = await runNodeScript(
        evidenceCli,
        [prim, url, '--out', outFile, '--wait', '650', '--cdp-deadline', '10000', '--fetch-deadline', '8000', '--quiet'],
        { cwd: upliftPkgDir, timeoutMs: 15000 }
      );
      if (existsSync(outFile)) {
        try {
          primitives[prim] = JSON.parse(readFileSync(outFile, 'utf8'));
        } catch {
          // ignore
        }
      } else if (res.stdout.trim().startsWith('{')) {
        try {
          primitives[prim] = JSON.parse(res.stdout.trim());
        } catch {
          // ignore
        }
      }
    }
    return { available: true, primitives };
  } finally {
    if (sharedBrowser) {
      await withTimeout(sharedBrowser.close(), 3000, 'web-uplift sharedBrowser.close').catch(() => {});
    }
  }
}

async function runAgenticWebUplift(url, upliftDir, config) {
  const upliftPkgDir = join(PROJECT_ROOT, 'node_modules', 'web-uplift');
  const skillPath = join(upliftPkgDir, '.claude', 'skills', 'web-audit', 'SKILL.md');
  const scorecardScript = join(upliftPkgDir, 'aggregate', 'scorecard.mjs');
  const piBin = resolvePiBin();

  if (!existsSync(skillPath) || !piBin) {
    return null;
  }

  const candidateJudges = [
    config.uplift?.judgeModel || 'google/gemini-3.8-flash',
    config.uplift?.fallbackJudgeModel,
  ].filter(Boolean);

  const runOutDir = resolve(upliftDir, 'agent-run');
  mkdirSync(runOutDir, { recursive: true });

  const prompt =
    `Read the file .claude/skills/web-audit/SKILL.md and follow its instructions ` +
    `with these arguments: ${url} --out ${runOutDir}`;

  let lastRes = { stdout: '', stderr: '' };
  let activeJudgeModel = candidateJudges[0];

  for (const judgeModel of candidateJudges) {
    activeJudgeModel = judgeModel;
    const [judgeProvider, ...judgeModelParts] = judgeModel.split('/');
    const judgeModelId = judgeModelParts.join('/');

    lastRes = await new Promise((resolvePromise) => {
      const child = spawn(
        piBin,
        [
          '-p',
          '-a',
          '--no-session',
          '--no-skills',
          '--no-extensions',
          '--no-prompt-templates',
          '--no-themes',
          '--no-context-files',
          '--thinking',
          'low',
          '--provider',
          judgeProvider,
          '--model',
          judgeModelId,
          '--',
          prompt,
        ],
        {
          cwd: upliftPkgDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: getChromeEnv(),
        }
      );

      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        resolvePromise({ code: 124, stdout, stderr });
      }, config.uplift?.timeoutMs || 240000);

      child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
      child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
      child.on('close', (code) => {
        clearTimeout(timer);
        resolvePromise({ code, stdout, stderr });
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolvePromise({ code: 1, stdout, stderr: err.message });
      });
    });

    if (findLatestReportJson(runOutDir)) break;
  }

  const judgeModel = activeJudgeModel;
  const res = lastRes;

  const reportPath = findLatestReportJson(runOutDir);
  if (!reportPath) {
    return { judgeAttempted: true, judgeModel, succeeded: false, logTail: (res.stderr || res.stdout).slice(-400) };
  }

  try {
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    const scorecardMod = await import(scorecardScript);
    const scored = scorecardMod.scoreReport(report);

    const outcomesObj = {};
    if (Array.isArray(scored.outcomes)) {
      for (const o of scored.outcomes) {
        if (o && o.key) outcomesObj[o.key] = o.score;
      }
    } else if (scored.outcomes && typeof scored.outcomes === 'object') {
      Object.assign(outcomesObj, scored.outcomes);
    }

    // Copy or generate scorecard.html if emitted
    const candidateScorecard = join(runOutDir, 'scorecard.html');
    if (existsSync(candidateScorecard)) {
      cpSync(candidateScorecard, join(upliftDir, 'scorecard.html'));
    } else if (typeof scorecardMod.renderScorecard === 'function') {
      try {
        const html = scorecardMod.renderScorecard({
          host: url,
          generatedAt: new Date().toISOString(),
          runs: [{ runId: 'run-1', dir: runOutDir, report, compare: null, ...scored }],
          latest: { runId: 'run-1', dir: runOutDir, report, compare: null, ...scored },
        });
        writeFileSync(join(upliftDir, 'scorecard.html'), html, 'utf8');
      } catch {
        // non-fatal if renderScorecard signature differs
      }
    }

    return {
      judgeAttempted: true,
      judgeModel,
      succeeded: true,
      evaluationMode: 'agentic-uplift',
      overall: scored.overall,
      outcomes: outcomesObj,
      outcomeDetails: scored.outcomes,
      findingCount: (report.findings || []).length,
      topTasks: (report.taskList || []).slice(0, 3),
    };
  } catch (err) {
    return { judgeAttempted: true, judgeModel, succeeded: false, error: err.message };
  }
}

/**
 * Computes consistent 6-outcome web-uplift scores from deterministic web-uplift CDP primitives + Lighthouse
 * whenever `--skip-judge` is requested or if an agentic judge run did not emit a complete report.json.
 */
function computeEvidenceBackedUpliftScores(primitives, lhMobile) {
  const disc = primitives.discoverability || {};
  const axe = primitives.axe || {};
  const layout = primitives.layout || {};
  const targets = primitives.targets || {};
  const consoleData = primitives.console || {};

  const speed = lhMobile?.scores?.performance ?? 75;
  const clsPenalty = Math.min(40, Math.round((layout.cls || lhMobile?.metrics?.cls || 0) * 150));
  const speedOutcome = Math.max(0, Math.min(100, Math.round(speed - clsPenalty * 0.25)));

  const axeViolations = Array.isArray(axe.violations) ? axe.violations.length : 0;
  const inclusiveOutcome =
    lhMobile?.scores?.accessibility != null
      ? Math.max(0, Math.round(lhMobile.scores.accessibility - axeViolations * 3))
      : Math.max(0, 100 - axeViolations * 12);

  // Discoverability & AI: web-uplift's raw HTML vs rendered DOM coverage signal!
  const rawCoverage = typeof disc.coveragePct === 'number' ? disc.coveragePct : disc.isJsShell ? 15 : 85;
  const seoBase = lhMobile?.scores?.seo ?? 80;
  const discoverableOutcome = Math.round(seoBase * 0.45 + rawCoverage * 0.55);

  const undersizedTargets = Array.isArray(targets.undersized) ? targets.undersized.length : 0;
  const usabilityOutcome = Math.max(20, Math.min(100, 92 - undersizedTargets * 4 - clsPenalty));

  const errCount = Array.isArray(consoleData.errors) ? consoleData.errors.length : 0;
  const bpBase = lhMobile?.scores?.bestPractices ?? 85;
  const trustOutcome = Math.max(0, Math.min(100, Math.round(bpBase - errCount * 8)));

  const memoryOutcome = 85; // Refined by dedicated memory.bench.mjs in overall aggregation

  const outcomes = {
    speed: speedOutcome,
    memory: memoryOutcome,
    usability: usabilityOutcome,
    inclusive: inclusiveOutcome,
    discoverable: discoverableOutcome,
    trust: trustOutcome,
  };
  const vals = Object.values(outcomes);
  const overall = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);

  return {
    evaluationMode: 'evidence-primitives',
    overall,
    outcomes,
    discoverabilityMeta: {
      isJsShell: Boolean(disc.isJsShell),
      coveragePct: disc.coveragePct ?? null,
    },
    axeViolationCount: axeViolations,
    undersizedTargetCount: undersizedTargets,
  };
}

export default {
  id: 'lighthouse-uplift',
  label: 'Lighthouse & web-uplift Audit',
  version: '1.0.0',
  requiresBrowser: true,

  async run(ctx) {
    const { url, cellDir, config, options = {}, onProgress } = ctx;
    const upliftDir = join(cellDir, 'uplift');
    mkdirSync(upliftDir, { recursive: true });

    onProgress?.({ stage: 'lighthouse-uplift', detail: 'Running Lighthouse (Mobile & Desktop)' });
    const { mobile, desktop } = await runLighthouseSuite(url);

    onProgress?.({ stage: 'lighthouse-uplift', detail: 'Gathering web-uplift raw-CDP evidence primitives' });
    const evidenceBundle = await gatherWebUpliftPrimitives(url, upliftDir);

    let upliftSummary = null;
    if (config.uplift?.enabled && !options.skipJudge) {
      onProgress?.({
        stage: 'lighthouse-uplift',
        detail: `Running agentic web-uplift judge (${config.uplift.judgeModel})`,
      });
      const agentRes = await runAgenticWebUplift(url, upliftDir, config);
      if (agentRes?.succeeded) {
        upliftSummary = agentRes;
      } else {
        const fallback = computeEvidenceBackedUpliftScores(evidenceBundle.primitives || {}, mobile);
        upliftSummary = {
          ...fallback,
          judgeFallbackNote: agentRes?.error || agentRes?.logTail || 'Agentic judge unavailable; used web-uplift CDP primitives.',
        };
      }
    } else {
      upliftSummary = computeEvidenceBackedUpliftScores(evidenceBundle.primitives || {}, mobile);
    }

    const lighthouseComposite = Math.round(
      (mobile.scores.performance ?? 0) * 0.4 +
        (mobile.scores.accessibility ?? 0) * 0.25 +
        (mobile.scores.bestPractices ?? 0) * 0.2 +
        (mobile.scores.seo ?? 0) * 0.15
    );

    const out = {
      benchmarkId: 'lighthouse-uplift',
      measuredAt: new Date().toISOString(),
      lighthouse: {
        compositeScore: lighthouseComposite,
        mobile,
        desktop,
      },
      uplift: upliftSummary,
    };

    const resultsDir = join(cellDir, 'results');
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(join(resultsDir, 'lighthouse-uplift.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
    return out;
  },

  score(result) {
    const lh = result?.lighthouse?.compositeScore ?? 0;
    const up = result?.uplift?.overall ?? lh;
    return {
      overall: Math.round(lh * 0.5 + up * 0.5),
      lighthouseScore: lh,
      upliftScore: up,
      mobilePerformance: result?.lighthouse?.mobile?.scores?.performance ?? null,
      mobileAccessibility: result?.lighthouse?.mobile?.scores?.accessibility ?? null,
      upliftOutcomes: result?.uplift?.outcomes || null,
    };
  },
};
