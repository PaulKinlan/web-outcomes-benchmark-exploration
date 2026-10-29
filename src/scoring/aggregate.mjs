import {
  existsSync,
  readdirSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT, loadBenchmarkConfig } from '../util/env.mjs';
import { loadPromptRegistry } from '../registry/prompts.mjs';
import { loadModelRegistryConfig } from '../harness/model-registry.mjs';
import { getPiRuntimeInfo } from '../harness/pi-loader.mjs';
import { listProviderBridges } from '../harness/provider-bridges.mjs';
import { BENCHMARK_PLUGINS } from '../benchmarks/registry.mjs';
import { loadLatestCanary } from '../benchmarks/canary.mjs';

export const CELLS_ROOT = join(PROJECT_ROOT, 'runs', 'cells');
export const SUMMARY_OUT_PATH = join(PROJECT_ROOT, 'data', 'summary.json');

function safeReadJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function avg(nums) {
  const valid = nums.filter((n) => typeof n === 'number' && !Number.isNaN(n));
  if (valid.length === 0) return null;
  return Math.round((valid.reduce((a, b) => a + b, 0) / valid.length) * 10) / 10;
}

function normalizeCellMode(rawMode, dirName) {
  if (rawMode === 'agent' || dirName.endsWith('__agent')) return 'agent';
  return 'oneshot';
}

export function aggregateAllResults({ customWeights = null } = {}) {
  const config = loadBenchmarkConfig();
  const weights = customWeights || config.scoring?.weights || {
    lighthouse: 0.25,
    uplift: 0.25,
    deepPerf: 0.25,
    memory: 0.15,
    functionalFlow: 0.10,
  };

  const promptReg = loadPromptRegistry();
  const modelReg = loadModelRegistryConfig();
  const promptMap = new Map(promptReg.prompts.map((p) => [p.id, p]));
  const modelMap = new Map(modelReg.models.map((m) => [m.key, m]));

  const cells = [];
  if (existsSync(CELLS_ROOT)) {
    const dirs = readdirSync(CELLS_ROOT).sort();
    for (const dirName of dirs) {
      const cellDir = join(CELLS_ROOT, dirName);
      const generation = safeReadJson(join(cellDir, 'generation.json'));
      if (!generation) continue;

      const mode = normalizeCellMode(generation.mode, dirName);
      const materialization = safeReadJson(join(cellDir, 'materialization.json'));
      // Skip cells whose generation was cached before a job cancellation and haven't been materialized yet
      if (!materialization && !generation.error) continue;
      const compiledFlow = safeReadJson(join(cellDir, 'compiled-flow.json'));
      const trajectory = safeReadJson(join(cellDir, 'trajectory.json'));

      const rawBenchmarks = {};
      const pillarScores = {};
      for (const plugin of BENCHMARK_PLUGINS) {
        const res = safeReadJson(join(cellDir, 'results', `${plugin.id}.json`));
        if (res) {
          rawBenchmarks[plugin.id] = res;
          pillarScores[plugin.id] = plugin.score(res);
        }
      }

      const buildSucceeded = Boolean(materialization?.ok);
      const lhScore = pillarScores['lighthouse-uplift']?.lighthouseScore ?? null;
      const upliftScore = pillarScores['lighthouse-uplift']?.upliftScore ?? null;
      const deepPerfScore = pillarScores['deep-perf']?.overall ?? null;
      const memoryScore = pillarScores['memory']?.overall ?? null;
      const functionalFlowScore = compiledFlow?.flowCompletionPct ?? (buildSucceeded ? 50 : 0);

      let compositeScore = 0;
      if (buildSucceeded) {
        let weightedSum = 0;
        let totalW = 0;
        const pairs = [
          [lhScore, weights.lighthouse],
          [upliftScore, weights.uplift],
          [deepPerfScore, weights.deepPerf],
          [memoryScore, weights.memory],
          [functionalFlowScore, weights.functionalFlow],
        ];
        for (const [val, w] of pairs) {
          if (typeof val === 'number' && typeof w === 'number') {
            weightedSum += val * w;
            totalW += w;
          }
        }
        compositeScore = totalW > 0 ? Math.round((weightedSum / totalW) * 10) / 10 : 0;
        const brokenAssets =
          rawBenchmarks['deep-perf']?.mobileLoad?.network?.brokenCriticalSubresourceCount || 0;
        if (brokenAssets > 0) {
          compositeScore = Math.max(
            0,
            Math.round((compositeScore - Math.min(24, brokenAssets * 12)) * 10) / 10
          );
        }
      }

      const promptInfo = promptMap.get(generation.promptId);
      const modelInfo = modelMap.get(generation.modelKey);
      const tech = rawBenchmarks['tech-stack'];
      const dp = rawBenchmarks['deep-perf'];
      const mem = rawBenchmarks['memory'];
      const lhu = rawBenchmarks['lighthouse-uplift'];
      const srv = dp?.serverTelemetry || null;

      cells.push({
        cellId: dirName,
        modelKey: generation.modelKey,
        modelLabel: modelInfo?.label || generation.modelLabel || generation.modelKey,
        family: modelInfo?.family || generation.family || 'Other',
        promptId: generation.promptId,
        promptTitle: promptInfo?.title || generation.promptId,
        category: promptInfo?.category || generation.category || 'other',
        categoryLabel: promptInfo?.categoryLabel || generation.category || 'Other',
        mode,
        provider: generation.provider,
        modelId: generation.modelId,
        generatedAt: generation.completedAt,
        generationMs: generation.durationMs,
        ttftMs: generation.ttftMs,
        costUsd: generation.costUsd ?? trajectory?.usage?.costUsd ?? null,
        outputChars: generation.outputChars,
        generationError: generation.error || null,

        buildSucceeded,
        outputShape: materialization?.outputShape || 'unknown',
        serverArchitecture: materialization?.serverArchitecture || tech?.serverArchitecture || 'static-harness',
        contractCompliance: materialization?.contractCompliance ?? null,
        materializeTier: materialization?.materializeTier || 'unknown',
        runnableWithoutBuildStep: Boolean(materialization?.runnableWithoutBuildStep),
        synthesizedWrapper: Boolean(materialization?.synthesizedWrapper),
        distBytes: materialization?.distBytes || 0,

        scores: {
          composite: compositeScore,
          lighthouse: lhScore,
          uplift: upliftScore,
          deepPerf: deepPerfScore,
          memory: memoryScore,
          functionalFlow: functionalFlowScore,
        },

        techStack: tech
          ? {
              primaryFramework: tech.primaryFramework,
              primaryBackend: tech.primaryBackend || 'static-only',
              serverArchitecture: tech.serverArchitecture || materialization?.serverArchitecture || 'static-harness',
              primaryCss: tech.primaryCss,
              deliveryPattern: tech.deliveryPattern,
              libraries: (tech.staticAnalysis?.libraries || []).map((l) => l.id),
              persistenceApis: tech.staticAnalysis?.persistenceApis || [],
              pageTemplateCount: tech.staticAnalysis?.pageTemplateCount ?? 0,
              apiOrServerFileCount: tech.staticAnalysis?.apiOrServerFileCount ?? 0,
              sourceFileCount: tech.staticAnalysis?.sourceFileCount ?? 1,
              modernWebFeatures: tech.staticAnalysis?.modernWebFeatures || {},
              usesRuntimeJitCompiler: Boolean(tech.runtime?.usesRuntimeJitCompiler),
              thirdPartyHostCount: (tech.runtime?.thirdPartyHosts || []).length,
              consoleErrorCount: tech.runtime?.consoleErrorCount || 0,
              pageExceptionCount: tech.runtime?.pageExceptionCount || 0,
            }
          : null,

        serverTelemetry: srv
          ? {
              serverArchitecture: srv.serverArchitecture,
              coldBootMs: srv.coldBootMs ?? null,
              singleTtfbMs: srv.singleTtfbMs ?? null,
              burstMedianTtfbMs: srv.burstMedianTtfbMs ?? null,
              burstP95TtfbMs: srv.burstP95TtfbMs ?? null,
              idleServerRssMb: srv.idleServerRssMb ?? null,
              loadServerRssMb: srv.loadServerRssMb ?? null,
              usesCompression: Boolean(srv.usesCompression),
              contentEncoding: srv.contentEncoding || 'none',
              cacheControl: srv.cacheControl || null,
              ssrWordCount: srv.ssrWordCount ?? 0,
              discoveredRouteCount: (srv.discoveredRoutes || []).length,
            }
          : null,

        trajectory: trajectory
          ? {
              turnCount: trajectory.turnCount,
              totalToolCalls: trajectory.totalToolCalls,
              toolCallCounts: trajectory.toolCallCounts,
              toolErrorCount: trajectory.toolErrorCount,
              thinkingBlockCount: trajectory.thinkingBlockCount,
              thinkingChars: trajectory.thinkingChars,
              filesTouchedCount: trajectory.filesTouchedCount,
              bashCommandCount: trajectory.bashCommandCount,
              scaffoldingTools: trajectory.scaffoldingTools || [],
              installedNpmPackages: trajectory.installedNpmPackages || [],
              engineeringHabits: trajectory.engineeringHabits || {},
              totalTokens: trajectory.usage?.totalTokens ?? null,
              costUsd: trajectory.usage?.costUsd ?? null,
            }
          : null,

        keyMetrics: {
          mobileLcpMs: dp?.mobileLoad?.vitals?.lcpMs ?? lhu?.lighthouse?.mobile?.metrics?.lcpMs ?? null,
          mobileFcpMs: dp?.mobileLoad?.vitals?.fcpMs ?? lhu?.lighthouse?.mobile?.metrics?.fcpMs ?? null,
          mobileTbtMs: dp?.mobileLoad?.vitals?.tbtMs ?? lhu?.lighthouse?.mobile?.metrics?.tbtMs ?? null,
          cls: dp?.mobileLoad?.vitals?.cls ?? lhu?.lighthouse?.mobile?.metrics?.cls ?? null,
          inpMs: dp?.journey?.inpMs ?? null,
          inpBreakdown: dp?.journey?.inpBreakdown || null,
          loafCount: dp?.journey?.loafCount ?? null,
          worstLoafMs: dp?.journey?.worstLoafMs ?? null,
          unusedJsPct: dp?.mobileLoad?.coverage?.unusedJsPct ?? null,
          transferredKb: dp?.mobileLoad?.network?.transferredBytes
            ? Math.round(dp.mobileLoad.network.transferredBytes / 1024)
            : null,
          apiWaterfallCount: dp?.mobileLoad?.network?.apiWaterfallCount ?? 0,
          brokenCriticalSubresourceCount:
            dp?.mobileLoad?.network?.brokenCriticalSubresourceCount ?? 0,
          journeyApiRequestCount: dp?.journey?.journeyApiRequestCount ?? 0,
          avgFps: dp?.journey?.framePacing?.avgFps ?? null,
          coldBootMs: srv?.coldBootMs ?? materialization?.verifiedColdBootMs ?? null,
          burstP95TtfbMs: srv?.burstP95TtfbMs ?? srv?.singleTtfbMs ?? null,
          serverRssMb: srv?.loadServerRssMb || srv?.idleServerRssMb || null,
          baselineHeapMb: mem?.idleDrift?.t0s?.jsHeapUsedBytes
            ? Math.round((mem.idleDrift.t0s.jsHeapUsedBytes / (1024 * 1024)) * 100) / 100
            : null,
          retainedGrowthKb: mem?.interactionLeakTest?.heapGrowthAfterCyclesBytes != null
            ? Math.round(mem.interactionLeakTest.heapGrowthAfterCyclesBytes / 1024)
            : null,
          detachedDomDelta: mem?.interactionLeakTest?.snapshotDiff?.detachedDomDelta ?? null,
          listenerLeakDelta: mem?.interactionLeakTest?.listenerDelta ?? null,
          memlabLeaks: mem?.interactionLeakTest?.memlab?.leakClusterCount ?? null,
          suspectedRunawayLoop: Boolean(mem?.idleDrift?.suspectedRunawayLoop),
          upliftOutcomes: lhu?.uplift?.outcomes || null,
          lhMobileCategories: lhu?.lighthouse?.mobile?.scores || null,
          lhDesktopCategories: lhu?.lighthouse?.desktop?.scores || null,
          lhPassedCount: lhu?.lighthouse?.mobile?.auditCounts?.passed ?? (lhu?.lighthouse?.mobile?.passedAudits || []).length,
          lhFailedCount: lhu?.lighthouse?.mobile?.auditCounts?.failed ?? (lhu?.lighthouse?.mobile?.failingAudits || []).length,
        },

        lighthouseAudits: lhu?.lighthouse?.mobile
          ? {
              passedCount:
                lhu.lighthouse.mobile.auditCounts?.passed ??
                (lhu.lighthouse.mobile.passedAudits || []).length,
              failedCount:
                lhu.lighthouse.mobile.auditCounts?.failed ??
                (lhu.lighthouse.mobile.failingAudits || []).length,
              failingAudits: (lhu.lighthouse.mobile.failingAudits || []).slice(0, 40),
              passedAudits: (lhu.lighthouse.mobile.passedAudits || []).slice(0, 120),
            }
          : null,

        journeySteps: compiledFlow?.steps?.map((s, i) => ({
          stepId: s.stepId,
          label: s.label,
          succeeded: s.succeeded,
          mutated: s.mutated,
          durationMs: dp?.journey?.stepTimings?.[i]?.durationMs ?? null,
        })) || [],

        hasDesktopScreenshot: existsSync(join(cellDir, 'screenshots', 'desktop.png')),
        hasMobileScreenshot: existsSync(join(cellDir, 'screenshots', 'mobile.png')),
        hasUpliftScorecard: existsSync(join(cellDir, 'uplift', 'scorecard.html')),
        hasPiTranscript: existsSync(join(cellDir, 'pi-transcript.html')),
        hasPiSession: existsSync(join(cellDir, 'pi-session.jsonl')),
      });
    }
  }

  // 1. Leaderboard Aggregation by (modelKey + mode) so Agent vs 1-Shot tracks are cleanly ranked & filterable
  const byModelMode = new Map();
  for (const c of cells) {
    const groupKey = `${c.modelKey}__${c.mode}`;
    if (!byModelMode.has(groupKey)) byModelMode.set(groupKey, []);
    byModelMode.get(groupKey).push(c);
  }

  const leaderboard = [];
  for (const [groupKey, mCells] of byModelMode.entries()) {
    const first = mCells[0];
    const modelKey = first.modelKey;
    const mode = first.mode;
    const modelMeta = modelMap.get(modelKey) || {};
    const built = mCells.filter((c) => c.buildSucceeded);

    const fwCounts = {};
    const backendCounts = {};
    for (const c of mCells) {
      const fw = c.techStack?.primaryFramework || (c.buildSucceeded ? 'vanilla' : 'failed');
      fwCounts[fw] = (fwCounts[fw] || 0) + 1;
      const be = c.techStack?.primaryBackend || 'static-only';
      backendCounts[be] = (backendCounts[be] || 0) + 1;
    }

    const domFw = Object.entries(fwCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'vanilla';
    const domBe = Object.entries(backendCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'static-only';
    const dominantStack = domBe !== 'static-only' ? `${domFw} + ${domBe}` : domFw;

    const categoryScores = {};
    for (const cat of promptReg.categories) {
      const inCat = mCells.filter((c) => c.category === cat.id);
      if (inCat.length > 0) {
        categoryScores[cat.id] = avg(inCat.map((c) => c.scores.composite));
      }
    }

    const reactCount = fwCounts.react || 0;
    const vanillaCount = fwCounts.vanilla || 0;
    const prodServerCount = mCells.filter((c) => c.serverArchitecture === 'production-server').length;

    leaderboard.push({
      rowId: groupKey,
      modelKey,
      mode,
      label: modelMeta.label || first?.modelLabel || modelKey,
      family: modelMeta.family || first?.family || 'Other',
      tier: modelMeta.tier || 'standard',
      cellsRun: mCells.length,
      buildSuccessRatePct: Math.round((built.length / mCells.length) * 1000) / 10,
      productionServerPct: Math.round((prodServerCount / mCells.length) * 1000) / 10,
      runnableWithoutBuildPct: Math.round(
        (mCells.filter((c) => c.runnableWithoutBuildStep).length / mCells.length) * 1000
      ) / 10,
      dominantStack,
      scores: {
        composite: avg(mCells.map((c) => c.scores.composite)) ?? 0,
        lighthouse: avg(built.map((c) => c.scores.lighthouse)),
        uplift: avg(built.map((c) => c.scores.uplift)),
        deepPerf: avg(built.map((c) => c.scores.deepPerf)),
        memory: avg(built.map((c) => c.scores.memory)),
        functionalFlow: avg(mCells.map((c) => c.scores.functionalFlow)),
      },
      averages: {
        mobileLcpMs: avg(built.map((c) => c.keyMetrics.mobileLcpMs)),
        inpMs: avg(built.map((c) => c.keyMetrics.inpMs)),
        mobileTbtMs: avg(built.map((c) => c.keyMetrics.mobileTbtMs)),
        burstP95TtfbMs: avg(built.map((c) => c.keyMetrics.burstP95TtfbMs)),
        serverRssMb: avg(built.map((c) => c.keyMetrics.serverRssMb).filter((x) => x > 0)),
        unusedJsPct: avg(built.map((c) => c.keyMetrics.unusedJsPct)),
        baselineHeapMb: avg(built.map((c) => c.keyMetrics.baselineHeapMb)),
        detachedDomDelta: avg(built.map((c) => c.keyMetrics.detachedDomDelta)),
        generationMs: avg(mCells.map((c) => c.generationMs)),
        avgTurns: avg(mCells.map((c) => c.trajectory?.turnCount).filter((x) => x != null)),
        avgToolCalls: avg(mCells.map((c) => c.trajectory?.totalToolCalls).filter((x) => x != null)),
        avgCostUsd: (() => {
          const priced = mCells.map((c) => c.costUsd).filter((x) => typeof x === 'number' && x > 0);
          return priced.length > 0
            ? Math.round((priced.reduce((a, b) => a + b, 0) / priced.length) * 10000) / 10000
            : null;
        })(),
        totalCostUsd: Math.round(mCells.reduce((s, c) => s + (c.costUsd || 0), 0) * 10000) / 10000,
      },
      techDefaults: {
        frameworkCounts: fwCounts,
        backendCounts,
        reactSharePct: Math.round((reactCount / mCells.length) * 1000) / 10,
        vanillaSharePct: Math.round((vanillaCount / mCells.length) * 1000) / 10,
      },
      categoryScores,
    });
  }

  leaderboard.sort((a, b) => (b.scores.composite || 0) - (a.scores.composite || 0));

  // 2. Cohort Analytics (Frontend Framework, Backend Stack, Delivery Pattern, and Agent vs 1-Shot Mode!)
  const byFramework = new Map();
  const byBackend = new Map();
  const byDelivery = new Map();
  const byMode = new Map();

  for (const c of cells.filter((x) => x.buildSucceeded)) {
    if (!byMode.has(c.mode)) byMode.set(c.mode, []);
    byMode.get(c.mode).push(c);

    if (c.techStack) {
      const fw = c.techStack.primaryFramework;
      if (!byFramework.has(fw)) byFramework.set(fw, []);
      byFramework.get(fw).push(c);

      const be = c.techStack.primaryBackend || 'static-only';
      if (!byBackend.has(be)) byBackend.set(be, []);
      byBackend.get(be).push(c);

      const dp = c.techStack.deliveryPattern;
      if (!byDelivery.has(dp)) byDelivery.set(dp, []);
      byDelivery.get(dp).push(c);
    }
  }

  function summarizeCohort(entriesMap, keyName) {
    const rows = [];
    for (const [k, list] of entriesMap.entries()) {
      rows.push({
        [keyName]: k,
        count: list.length,
        sharePct: cells.length > 0 ? Math.round((list.length / cells.length) * 1000) / 10 : 0,
        avgComposite: avg(list.map((c) => c.scores.composite)),
        avgLighthouse: avg(list.map((c) => c.scores.lighthouse)),
        avgUplift: avg(list.map((c) => c.scores.uplift)),
        avgDeepPerf: avg(list.map((c) => c.scores.deepPerf)),
        avgMemory: avg(list.map((c) => c.scores.memory)),
        avgFlowCompletion: avg(list.map((c) => c.scores.functionalFlow)),
        avgMobileLcpMs: avg(list.map((c) => c.keyMetrics.mobileLcpMs)),
        avgInpMs: avg(list.map((c) => c.keyMetrics.inpMs)),
        avgMobileTbtMs: avg(list.map((c) => c.keyMetrics.mobileTbtMs)),
        avgBurstTtfbMs: avg(list.map((c) => c.keyMetrics.burstP95TtfbMs)),
        avgServerRssMb: avg(list.map((c) => c.keyMetrics.serverRssMb).filter((x) => x > 0)),
        avgUnusedJsPct: avg(list.map((c) => c.keyMetrics.unusedJsPct)),
        avgHeapMb: avg(list.map((c) => c.keyMetrics.baselineHeapMb)),
        avgDetachedDomLeaks: avg(list.map((c) => c.keyMetrics.detachedDomDelta)),
      });
    }
    return rows.sort((a, b) => b.count - a.count);
  }

  // Paired head-to-head comparison where BOTH agent & oneshot exist for the exact same (modelKey, promptId)
  const pairedMap = new Map();
  for (const c of cells.filter((x) => x.buildSucceeded)) {
    const pk = `${c.modelKey}__${c.promptId}`;
    if (!pairedMap.has(pk)) pairedMap.set(pk, {});
    pairedMap.get(pk)[c.mode] = c;
  }
  const pairedHeadToHead = [];
  for (const [pk, pair] of pairedMap.entries()) {
    if (pair.agent && pair.oneshot) {
      pairedHeadToHead.push({
        pairKey: pk,
        modelKey: pair.agent.modelKey,
        modelLabel: pair.agent.modelLabel,
        promptId: pair.agent.promptId,
        promptTitle: pair.agent.promptTitle,
        agentComposite: pair.agent.scores.composite,
        oneshotComposite: pair.oneshot.scores.composite,
        deltaComposite: Math.round((pair.agent.scores.composite - pair.oneshot.scores.composite) * 10) / 10,
        agentStack: `${pair.agent.techStack?.primaryFramework || 'vanilla'} + ${pair.agent.techStack?.primaryBackend || 'server'}`,
        oneshotStack: pair.oneshot.techStack?.primaryFramework || 'vanilla',
        agentLcpMs: pair.agent.keyMetrics.mobileLcpMs,
        oneshotLcpMs: pair.oneshot.keyMetrics.mobileLcpMs,
        agentInpMs: pair.agent.keyMetrics.inpMs,
        oneshotInpMs: pair.oneshot.keyMetrics.inpMs,
        agentTurns: pair.agent.trajectory?.turnCount ?? null,
      });
    }
  }

  const agentCellsCount = cells.filter((c) => c.mode === 'agent').length;
  const oneshotCellsCount = cells.filter((c) => c.mode === 'oneshot').length;

  // 3. Corpus-wide Lighthouse Audit Pass / Failure Telemetry
  const lhFailureFreq = new Map();
  const lhPassFreq = new Map();
  let lhCellsAudited = 0;

  for (const c of cells) {
    if (!c.lighthouseAudits) continue;
    lhCellsAudited++;
    for (const f of c.lighthouseAudits.failingAudits || []) {
      const prev = lhFailureFreq.get(f.id) || {
        id: f.id,
        title: f.title,
        category: f.category || 'other',
        failCount: 0,
        passCount: 0,
        scores: [],
        failingCells: [],
      };
      prev.failCount++;
      prev.scores.push(f.score);
      if (prev.failingCells.length < 12) {
        prev.failingCells.push({ cellId: c.cellId, modelLabel: c.modelLabel, mode: c.mode, promptTitle: c.promptTitle, score: f.score, displayValue: f.displayValue });
      }
      lhFailureFreq.set(f.id, prev);
    }
    for (const p of c.lighthouseAudits.passedAudits || []) {
      const prev = lhPassFreq.get(p.id) || {
        id: p.id,
        title: p.title,
        category: p.category || 'other',
        passCount: 0,
      };
      prev.passCount++;
      lhPassFreq.set(p.id, prev);
      if (lhFailureFreq.has(p.id)) {
        lhFailureFreq.get(p.id).passCount++;
      }
    }
  }

  for (const [id, failEntry] of lhFailureFreq.entries()) {
    const pEntry = lhPassFreq.get(id);
    if (pEntry) failEntry.passCount = pEntry.passCount;
  }

  const topFailingAudits = Array.from(lhFailureFreq.values())
    .map((item) => ({
      id: item.id,
      title: item.title,
      category: item.category,
      failCount: item.failCount,
      passCount: item.passCount,
      failRatePct: lhCellsAudited > 0 ? Math.round((item.failCount / lhCellsAudited) * 1000) / 10 : 0,
      avgFailScore: avg(item.scores),
      failingCells: item.failingCells,
    }))
    .sort((a, b) => b.failCount - a.failCount || (a.avgFailScore ?? 0) - (b.avgFailScore ?? 0));

  const topPassingAudits = Array.from(lhPassFreq.values())
    .filter((p) => !lhFailureFreq.has(p.id))
    .map((item) => ({
      id: item.id,
      title: item.title,
      category: item.category,
      passCount: item.passCount,
      failCount: 0,
      passRatePct: lhCellsAudited > 0 ? Math.round((item.passCount / lhCellsAudited) * 1000) / 10 : 100,
    }))
    .sort((a, b) => b.passCount - a.passCount || a.id.localeCompare(b.id));

  const piInfo = getPiRuntimeInfo();
  const bridgesSummary = listProviderBridges().map((b) => ({
    id: b.id,
    label: b.label,
    providers: b.providers,
    packageName: b.packageName,
    installed: b.installed,
    portable: b.portable,
    source: b.source,
    version: b.version,
    builtInAuthSupported: Boolean(b.builtInAuthSupported),
  }));

  const summary = {
    generatedAt: new Date().toISOString(),
    weights,
    canary: loadLatestCanary(),
    environment: {
      piVersion: piInfo.version,
      piSource: piInfo.source,
      piPortable: piInfo.portable,
      declaredPiPackage: `${piInfo.declaredSpec?.package}@${piInfo.declaredSpec?.version}`,
      providerBridges: bridgesSummary,
    },
    totals: {
      cells: cells.length,
      agentCells: agentCellsCount,
      oneshotCells: oneshotCellsCount,
      modelsWithRuns: new Set(cells.map((c) => c.modelKey)).size,
      categoriesCovered: new Set(cells.map((c) => c.category)).size,
      promptsCovered: new Set(cells.map((c) => c.promptId)).size,
    },
    leaderboard,
    modeComparison: {
      byMode: summarizeCohort(byMode, 'mode'),
      pairedHeadToHead,
    },
    techObservatory: {
      byFramework: summarizeCohort(byFramework, 'framework'),
      byBackend: summarizeCohort(byBackend, 'backend'),
      byDeliveryPattern: summarizeCohort(byDelivery, 'deliveryPattern'),
    },
    lighthouseAuditBreakdown: {
      cellsAudited: lhCellsAudited,
      topFailingAudits,
      universalPassingAudits: topPassingAudits.slice(0, 30),
    },
    categories: promptReg.categories,
    cells,
  };

  mkdirSync(join(PROJECT_ROOT, 'data'), { recursive: true });
  writeFileSync(SUMMARY_OUT_PATH, JSON.stringify(summary, null, 2) + '\n', 'utf8');
  return summary;
}
