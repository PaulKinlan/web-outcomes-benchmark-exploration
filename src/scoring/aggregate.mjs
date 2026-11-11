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
import { getHarnessSpec, listAllHarnessStatuses, getTrackForCell, describeTrack } from '../harness/harness-registry.mjs';
import { parseCellDirIdentity } from '../harness/generate.mjs';
import { hasResolvableStaticPreview } from '../materialize/static-mirror.mjs';
import { listProviderBridges } from '../harness/provider-bridges.mjs';
import { BENCHMARK_PLUGINS } from '../benchmarks/registry.mjs';
import { MODERN_WEB_CATALOG_VERSION, MODERN_WEB_FEATURE_RULES } from '../benchmarks/tech-stack.bench.mjs';
import { LIBRARY_DETECTOR_ENGINE_VERSION } from '../benchmarks/library-signatures.mjs';
import { computeConsoleErrorScore } from '../benchmarks/console-errors.bench.mjs';
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

function percentile(nums, q = 0.5) {
  const valid = nums
    .filter((n) => typeof n === 'number' && Number.isFinite(n))
    .slice()
    .sort((a, b) => a - b);
  if (valid.length === 0) return null;
  const idx = Math.min(valid.length - 1, Math.max(0, Math.floor((valid.length - 1) * q)));
  return Math.round(valid[idx]);
}

function summarizeDurations(nums) {
  const valid = nums.filter((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0);
  if (valid.length === 0) {
    return { count: 0, minMs: null, medianMs: null, p95Ms: null, maxMs: null, totalMs: 0 };
  }
  return {
    count: valid.length,
    minMs: percentile(valid, 0),
    medianMs: percentile(valid, 0.5),
    p95Ms: percentile(valid, 0.95),
    maxMs: percentile(valid, 1),
    totalMs: Math.round(valid.reduce((a, b) => a + b, 0)),
  };
}

export function aggregateAllResults({
  customWeights = null,
  cellsRoot = CELLS_ROOT,
  writeSummary = true,
} = {}) {
  const config = loadBenchmarkConfig();
  const weights = customWeights || config.scoring?.weights || {
    judge: 0.20,
    lighthouse: 0.18,
    uplift: 0.18,
    deepPerf: 0.18,
    consoleErrors: 0.08,
    memory: 0.08,
    functionalFlow: 0.10,
  };
  const hardJudgeGate = config.judge?.hardGate !== false;

  const promptReg = loadPromptRegistry();
  const modelReg = loadModelRegistryConfig();
  const promptMap = new Map(promptReg.prompts.map((p) => [p.id, p]));
  const modelMap = new Map(modelReg.models.map((m) => [m.key, m]));

  const cells = [];
  if (existsSync(cellsRoot)) {
    const dirs = readdirSync(cellsRoot).sort();
    for (const dirName of dirs) {
      const cellDir = join(cellsRoot, dirName);
      const generation = safeReadJson(join(cellDir, 'generation.json'));
      if (!generation) continue;

      const parsedIdentity = parseCellDirIdentity(dirName, generation);
      const mode = parsedIdentity.mode;
      const spec = parsedIdentity.spec;
      const harness = parsedIdentity.harness || 'pi';
      const harnessSpec = getHarnessSpec(harness);
      const harnessLabel = harnessSpec?.label || generation.harnessLabel || harness;

      const materialization = safeReadJson(join(cellDir, 'materialization.json'));
      const auditTelemetry = safeReadJson(join(cellDir, 'audit-telemetry.json'));
      // Skip cells whose generation was cached before a job cancellation and haven't been materialized or attempted yet
      if (!materialization && !generation.error && !auditTelemetry) continue;
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
      const pj = rawBenchmarks['prompt-judge'] || null;
      const pjScoreObj = pillarScores['prompt-judge'] || null;
      const hasJudgeResult = Boolean(pj);
      const judgePassed = hasJudgeResult ? Boolean(pjScoreObj?.passedGate) : true;
      const disqualifiedByJudge = Boolean(buildSucceeded && hardJudgeGate && !judgePassed);
      const validBuild = Boolean(buildSucceeded && !disqualifiedByJudge);

      const promptInfo = promptMap.get(generation.promptId);
      const modelInfo = modelMap.get(generation.modelKey);
      const tech = rawBenchmarks['tech-stack'];
      const ce = rawBenchmarks['console-errors'] || null;
      const dp = rawBenchmarks['deep-perf'];
      const mem = rawBenchmarks['memory'];
      const lhu = rawBenchmarks['lighthouse-uplift'];
      const srv = dp?.serverTelemetry || null;

      let consoleAudit = null;
      let consoleErrorsScore = pillarScores['console-errors']?.overall ?? null;
      if (ce) {
        const ceScored = pillarScores['console-errors'] || computeConsoleErrorScore(ce.counts || {});
        consoleErrorsScore = ceScored.overall;
        consoleAudit = {
          evaluated: true,
          synthesizedFromLegacy: false,
          score: ceScored.overall,
          zeroErrors: Boolean(ceScored.zeroErrors),
          totalErrorCount: ceScored.totalErrorCount ?? ce.totalErrorCount ?? 0,
          counts: ce.counts || {},
        };
      } else if (buildSucceeded && (tech || dp)) {
        const legacyCounts = {
          pageExceptionCount: tech?.runtime?.pageExceptionCount || 0,
          consoleErrorCount: tech?.runtime?.consoleErrorCount || 0,
          consoleWarningCount: 0,
          browserLogErrorCount: 0,
          httpErrorCount: dp?.mobileLoad?.network?.brokenCriticalSubresourceCount || 0,
          criticalHttpErrorCount: dp?.mobileLoad?.network?.brokenCriticalSubresourceCount || 0,
          nonCriticalHttpErrorCount: 0,
          favicon404Count: 0,
          failedRequestCount: 0,
          loadErrorCount:
            (tech?.runtime?.pageExceptionCount || 0) +
            (tech?.runtime?.consoleErrorCount || 0) +
            (dp?.mobileLoad?.network?.brokenCriticalSubresourceCount || 0),
          journeyErrorCount: 0,
        };
        const legacyScored = computeConsoleErrorScore(legacyCounts);
        consoleErrorsScore = legacyScored.overall;
        consoleAudit = {
          evaluated: false,
          synthesizedFromLegacy: true,
          score: legacyScored.overall,
          zeroErrors: Boolean(legacyScored.zeroErrors),
          totalErrorCount: legacyScored.totalErrorCount,
          counts: legacyCounts,
        };
      }

      const judgeScore = hasJudgeResult ? (pjScoreObj?.overall ?? null) : null;
      const lhScore = pillarScores['lighthouse-uplift']?.lighthouseScore ?? null;
      const upliftScore = pillarScores['lighthouse-uplift']?.upliftScore ?? null;
      const deepPerfScore = pillarScores['deep-perf']?.overall ?? null;
      const memoryScore = pillarScores['memory']?.overall ?? null;
      const functionalFlowScore = compiledFlow?.flowCompletionPct ?? (buildSucceeded ? 50 : 0);

      let compositeScore = 0;
      if (validBuild) {
        let weightedSum = 0;
        let totalW = 0;
        const pairs = [
          [judgeScore, weights.judge],
          [lhScore, weights.lighthouse],
          [upliftScore, weights.uplift],
          [deepPerfScore, weights.deepPerf],
          [consoleErrorsScore, weights.consoleErrors],
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

      const detectedFeatureMap = tech?.staticAnalysis?.modernWebFeatures || {};
      const modernWebAdoptionCount =
        tech?.staticAnalysis?.modernWebAdoptionCount ??
        Object.values(detectedFeatureMap).filter(Boolean).length;

      cells.push({
        cellId: dirName,
        modelKey: generation.modelKey,
        modelLabel: modelInfo?.label || generation.modelLabel || generation.modelKey,
        family: modelInfo?.family || generation.family || 'Other',
        promptId: generation.promptId,
        promptTitle: promptInfo?.title || generation.promptId,
        category: promptInfo?.category || generation.category || 'other',
        categoryLabel: promptInfo?.categoryLabel || generation.category || 'Other',
        harness,
        harnessLabel,
        track: generation.track || getTrackForCell(harness, mode),
        trackLabel: describeTrack(generation.track || getTrackForCell(harness, mode)).label,
        harnessVersion: generation.harnessVersion || null,
        systemPromptSha256: generation.exactPrompt?.systemPromptSha256 || generation.systemPromptSha256 || null,
        systemPromptSource: generation.systemPromptSource || generation.exactPrompt?.systemPromptSource || null,
        mode,
        spec,
        provider: generation.provider,
        modelId: generation.modelId,
        generatedAt: generation.completedAt,
        generationMs: generation.durationMs,
        ttftMs: generation.ttftMs,
        costUsd: generation.costUsd ?? trajectory?.usage?.costUsd ?? null,
        outputChars: generation.outputChars,
        generationError: generation.error || null,

        buildSucceeded,
        validBuild,
        judgePassed,
        disqualifiedByJudge,
        judgeVerdict: pj
          ? {
              evaluated: true,
              evaluationMode: pj.evaluationMode || 'deterministic',
              judgeModel: pj.judgeModel || null,
              passedGate: Boolean(pj.passedGate),
              failureCategory: pj.failureCategory || null,
              overall: pjScoreObj?.overall ?? 0,
              scores: pj.scores || {},
              verifiedFeatures: (pj.verifiedFeatures || []).slice(0, 8),
              missingRequirements: (pj.missingRequirements || []).slice(0, 8),
              rationale: pj.rationale || null,
            }
          : null,

        auditTelemetry: auditTelemetry || null,
        outputShape: materialization?.outputShape || 'unknown',
        serverArchitecture: materialization?.serverArchitecture || tech?.serverArchitecture || 'static-harness',
        contractCompliance: materialization?.contractCompliance ?? null,
        materializeTier: materialization?.materializeTier || 'unknown',
        runnableWithoutBuildStep: Boolean(materialization?.runnableWithoutBuildStep),
        synthesizedWrapper: Boolean(materialization?.synthesizedWrapper),
        distBytes: materialization?.distBytes || 0,

        scores: {
          composite: compositeScore,
          judge: judgeScore,
          consoleErrors: consoleErrorsScore,
          lighthouse: lhScore,
          uplift: upliftScore,
          deepPerf: deepPerfScore,
          memory: memoryScore,
          functionalFlow: functionalFlowScore,
        },

        consoleAudit,

        techStack: tech
          ? {
              primaryFramework: tech.primaryFramework,
              primaryBackend: tech.primaryBackend || 'static-only',
              serverArchitecture: tech.serverArchitecture || materialization?.serverArchitecture || 'static-harness',
              primaryCss: tech.primaryCss,
              deliveryPattern: tech.deliveryPattern,
              libraries: (tech.detectedLibraries || tech.staticAnalysis?.libraries || []).map((l) => l.id),
              detectedLibraries:
                tech.detectedLibraries ||
                (tech.staticAnalysis?.libraries || []).map((l) => ({
                  id: l.id,
                  name: l.label || l.id,
                  category: l.category || 'library',
                  version: null,
                  signals: ['static-source'],
                })),
              persistenceApis: tech.staticAnalysis?.persistenceApis || [],
              pageTemplateCount: tech.staticAnalysis?.pageTemplateCount ?? 0,
              apiOrServerFileCount: tech.staticAnalysis?.apiOrServerFileCount ?? 0,
              sourceFileCount: tech.staticAnalysis?.sourceFileCount ?? 1,
              modernWebCatalogVersion: tech.staticAnalysis?.modernWebCatalogVersion || MODERN_WEB_CATALOG_VERSION,
              modernWebFeatures: detectedFeatureMap,
              modernWebFeatureList: tech.staticAnalysis?.modernWebFeatureList || [],
              modernWebAdoptionCount,
              usesRuntimeJitCompiler: Boolean(tech.runtime?.usesRuntimeJitCompiler),
              thirdPartyHostCount: (tech.runtime?.thirdPartyHosts || []).length,
              consoleErrorCount: consoleAudit?.counts?.consoleErrorCount ?? tech.runtime?.consoleErrorCount ?? 0,
              pageExceptionCount: consoleAudit?.counts?.pageExceptionCount ?? tech.runtime?.pageExceptionCount ?? 0,
            }
          : null,

        upliftHighlights: lhu?.uplift?.primitiveHighlights || null,
        mwgVersion: lhu?.uplift?.mwgVersion || null,

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
          totalErrorCount: consoleAudit?.totalErrorCount ?? 0,
          consoleErrorCount: consoleAudit?.counts?.consoleErrorCount ?? tech?.runtime?.consoleErrorCount ?? 0,
          pageExceptionCount: consoleAudit?.counts?.pageExceptionCount ?? tech?.runtime?.pageExceptionCount ?? 0,
          httpErrorCount: consoleAudit?.counts?.httpErrorCount ?? 0,
          failedRequestCount: consoleAudit?.counts?.failedRequestCount ?? 0,
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
        hasStaticPreview: Boolean(buildSucceeded && hasResolvableStaticPreview(cellDir)),
        hasUpliftScorecard: existsSync(join(cellDir, 'uplift', 'scorecard.html')),
        hasPiTranscript: existsSync(join(cellDir, 'pi-transcript.html')),
        hasPiSession: existsSync(join(cellDir, 'pi-session.jsonl')),
        hasAcpSession: existsSync(join(cellDir, 'acp-session.jsonl')),
      });
    }
  }

  // 1. Leaderboard Aggregation by (modelKey + mode + spec + harness) so Harnesses, Agent vs 1-Shot & Free-form vs Guided tracks are cleanly ranked & filterable
  const byModelMode = new Map();
  for (const c of cells) {
    const baseKey = c.spec === 'guided' ? `${c.modelKey}__${c.mode}__guided` : `${c.modelKey}__${c.mode}`;
    const groupKey = c.harness && c.harness !== 'pi' ? `${baseKey}__${c.harness}` : baseKey;
    if (!byModelMode.has(groupKey)) byModelMode.set(groupKey, []);
    byModelMode.get(groupKey).push(c);
  }

  const leaderboard = [];
  for (const [groupKey, mCells] of byModelMode.entries()) {
    const first = mCells[0];
    const modelKey = first.modelKey;
    const harness = first.harness || 'pi';
    const harnessLabel = first.harnessLabel || 'Clean-Room pi';
    const mode = first.mode;
    const spec = first.spec || 'freeform';
    const modelMeta = modelMap.get(modelKey) || {};
    const built = mCells.filter((c) => c.buildSucceeded);
    const validBuilt = mCells.filter((c) => c.validBuild);
    const disqualifiedCount = mCells.filter((c) => c.disqualifiedByJudge).length;

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
      harness,
      harnessLabel,
      track: first.track,
      trackLabel: first.trackLabel,
      mode,
      spec,
      label: modelMeta.label || first?.modelLabel || modelKey,
      family: modelMeta.family || first?.family || 'Other',
      tier: modelMeta.tier || 'standard',
      cellsRun: mCells.length,
      buildSuccessRatePct: Math.round((built.length / mCells.length) * 1000) / 10,
      validBuildRatePct: Math.round((validBuilt.length / mCells.length) * 1000) / 10,
      disqualifiedCount,
      productionServerPct: Math.round((prodServerCount / mCells.length) * 1000) / 10,
      runnableWithoutBuildPct: Math.round(
        (mCells.filter((c) => c.runnableWithoutBuildStep).length / mCells.length) * 1000
      ) / 10,
      zeroErrorPct:
        built.length > 0
          ? Math.round((built.filter((c) => c.consoleAudit?.zeroErrors).length / built.length) * 1000) / 10
          : 0,
      dominantStack,
      scores: {
        composite: avg(mCells.map((c) => c.scores.composite)) ?? 0,
        judge: avg(validBuilt.map((c) => c.scores.judge)),
        consoleErrors: avg(built.map((c) => c.scores.consoleErrors)),
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
        totalErrors: avg(built.map((c) => c.keyMetrics.totalErrorCount)),
        burstP95TtfbMs: avg(built.map((c) => c.keyMetrics.burstP95TtfbMs)),
        serverRssMb: avg(built.map((c) => c.keyMetrics.serverRssMb).filter((x) => x > 0)),
        unusedJsPct: avg(built.map((c) => c.keyMetrics.unusedJsPct)),
        baselineHeapMb: avg(built.map((c) => c.keyMetrics.baselineHeapMb)),
        detachedDomDelta: avg(built.map((c) => c.keyMetrics.detachedDomDelta)),
        modernWebFeatures: avg(built.map((c) => c.techStack?.modernWebAdoptionCount)),
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

  // 2. Cohort Analytics (Frontend Framework, Backend Stack, Delivery Pattern, Harness, Agent vs 1-Shot Mode, and Freeform vs Guided Spec!)
  const byFramework = new Map();
  const byBackend = new Map();
  const byDelivery = new Map();
  const byHarness = new Map();
  const byTrack = new Map();
  const byMode = new Map();
  const bySpec = new Map();

  for (const c of cells.filter((x) => x.buildSucceeded)) {
    const h = c.harness || 'pi';
    if (!byHarness.has(h)) byHarness.set(h, []);
    byHarness.get(h).push(c);

    if (!byTrack.has(c.track)) byTrack.set(c.track, []);
    byTrack.get(c.track).push(c);

    if (!byMode.has(c.mode)) byMode.set(c.mode, []);
    byMode.get(c.mode).push(c);

    const sp = c.spec || 'freeform';
    if (!bySpec.has(sp)) bySpec.set(sp, []);
    bySpec.get(sp).push(c);

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
        validCount: list.filter((c) => c.validBuild).length,
        disqualifiedCount: list.filter((c) => c.disqualifiedByJudge).length,
        sharePct: cells.length > 0 ? Math.round((list.length / cells.length) * 1000) / 10 : 0,
        avgComposite: avg(list.map((c) => c.scores.composite)),
        avgJudge: avg(list.filter((c) => c.validBuild).map((c) => c.scores.judge)),
        avgConsoleErrors: avg(list.map((c) => c.scores.consoleErrors)),
        avgTotalErrors: avg(list.map((c) => c.keyMetrics.totalErrorCount)),
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
        avgModernWebFeatures: avg(list.map((c) => c.techStack?.modernWebAdoptionCount)),
      });
    }
    return rows.sort((a, b) => b.count - a.count);
  }

  // Paired head-to-head comparison where BOTH agent & oneshot exist for the exact same (modelKey, promptId, spec) on pi
  const pairedMap = new Map();
  for (const c of cells.filter((x) => x.buildSucceeded && (x.harness || 'pi') === 'pi')) {
    const sp = c.spec || 'freeform';
    const pk = sp === 'guided' ? `${c.modelKey}__${c.promptId}__guided` : `${c.modelKey}__${c.promptId}`;
    if (!pairedMap.has(pk)) pairedMap.set(pk, { spec: sp });
    pairedMap.get(pk)[c.mode] = c;
  }
  const pairedHeadToHead = [];
  for (const [pk, pair] of pairedMap.entries()) {
    if (pair.agent && pair.oneshot) {
      pairedHeadToHead.push({
        pairKey: pk,
        spec: pair.spec || 'freeform',
        agentCellId: pair.agent.cellId,
        oneshotCellId: pair.oneshot.cellId,
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

  // Paired Harness head-to-head (`pi` vs `claude-acp` / `codex-acp`) on identical (modelKey, promptId, spec)
  const harnessPairedMap = new Map();
  for (const c of cells.filter((x) => x.buildSucceeded && x.mode === 'agent')) {
    const sp = c.spec || 'freeform';
    const hk = `${c.modelKey}__${c.promptId}__${sp}`;
    if (!harnessPairedMap.has(hk)) harnessPairedMap.set(hk, { spec: sp });
    harnessPairedMap.get(hk)[c.harness || 'pi'] = c;
  }
  const pairedHarnessHeadToHead = [];
  for (const [hk, group] of harnessPairedMap.entries()) {
    const piCell = group.pi;
    if (!piCell) continue;
    for (const [otherHarness, acpCell] of Object.entries(group)) {
      if (otherHarness === 'pi' || otherHarness === 'spec' || !acpCell?.cellId) continue;
      pairedHarnessHeadToHead.push({
        pairKey: `${hk}__${otherHarness}`,
        spec: group.spec || 'freeform',
        piCellId: piCell.cellId,
        acpCellId: acpCell.cellId,
        acpHarness: otherHarness,
        acpHarnessLabel: acpCell.harnessLabel || otherHarness,
        modelKey: piCell.modelKey,
        modelLabel: piCell.modelLabel,
        promptId: piCell.promptId,
        promptTitle: piCell.promptTitle,
        piComposite: piCell.scores.composite,
        acpComposite: acpCell.scores.composite,
        deltaComposite: Math.round((acpCell.scores.composite - piCell.scores.composite) * 10) / 10,
        piStack: `${piCell.techStack?.primaryFramework || 'vanilla'} + ${piCell.techStack?.primaryBackend || 'static-only'}`,
        acpStack: `${acpCell.techStack?.primaryFramework || 'vanilla'} + ${acpCell.techStack?.primaryBackend || 'static-only'}`,
        piLcpMs: piCell.keyMetrics.mobileLcpMs,
        acpLcpMs: acpCell.keyMetrics.mobileLcpMs,
        piTurns: piCell.trajectory?.turnCount ?? null,
        acpTurns: acpCell.trajectory?.turnCount ?? null,
      });
    }
  }

  // Paired Free-form vs Guided comparison where BOTH exist for the exact same (modelKey, promptId, mode, harness)
  const specPairedMap = new Map();
  for (const c of cells.filter((x) => x.buildSucceeded)) {
    const sk = `${c.modelKey}__${c.promptId}__${c.mode}__${c.harness || 'pi'}`;
    if (!specPairedMap.has(sk)) specPairedMap.set(sk, {});
    specPairedMap.get(sk)[c.spec || 'freeform'] = c;
  }
  const pairedSpecHeadToHead = [];
  for (const [sk, pair] of specPairedMap.entries()) {
    if (pair.freeform && pair.guided) {
      pairedSpecHeadToHead.push({
        pairKey: sk,
        mode: pair.guided.mode,
        harness: pair.guided.harness || 'pi',
        freeformCellId: pair.freeform.cellId,
        guidedCellId: pair.guided.cellId,
        modelKey: pair.guided.modelKey,
        modelLabel: pair.guided.modelLabel,
        promptId: pair.guided.promptId,
        promptTitle: pair.guided.promptTitle,
        freeformComposite: pair.freeform.scores.composite,
        guidedComposite: pair.guided.scores.composite,
        deltaComposite: Math.round((pair.guided.scores.composite - pair.freeform.scores.composite) * 10) / 10,
        freeformLcpMs: pair.freeform.keyMetrics.mobileLcpMs,
        guidedLcpMs: pair.guided.keyMetrics.mobileLcpMs,
        freeformInpMs: pair.freeform.keyMetrics.inpMs,
        guidedInpMs: pair.guided.keyMetrics.inpMs,
      });
    }
  }

  const agentCellsCount = cells.filter((c) => c.mode === 'agent').length;
  const oneshotCellsCount = cells.filter((c) => c.mode === 'oneshot').length;
  const freeformCellsCount = cells.filter((c) => (c.spec || 'freeform') === 'freeform').length;
  const guidedCellsCount = cells.filter((c) => c.spec === 'guided').length;
  const validCellsCount = cells.filter((c) => c.validBuild).length;
  const disqualifiedCellsCount = cells.filter((c) => c.disqualifiedByJudge).length;
  const acpCellsCount = cells.filter((c) => (c.harness || 'pi') !== 'pi').length;

  // 2b. On-Topic & Functional Judge Corpus Summary
  const judgeEvaluatedCells = cells.filter((c) => c.judgeVerdict?.evaluated);
  const judgeFailureCategories = {};
  const disqualifiedCellList = [];
  for (const c of cells) {
    if (c.disqualifiedByJudge || (c.judgeVerdict && !c.judgeVerdict.passedGate)) {
      const cat = c.judgeVerdict?.failureCategory || 'off-topic';
      judgeFailureCategories[cat] = (judgeFailureCategories[cat] || 0) + 1;
      if (disqualifiedCellList.length < 40) {
        disqualifiedCellList.push({
          cellId: c.cellId,
          modelKey: c.modelKey,
          modelLabel: c.modelLabel,
          harness: c.harness || 'pi',
          mode: c.mode,
          spec: c.spec || 'freeform',
          promptId: c.promptId,
          promptTitle: c.promptTitle,
          failureCategory: cat,
          onTopicScore: c.judgeVerdict?.scores?.onTopic ?? 0,
          featureCoverageScore: c.judgeVerdict?.scores?.featureCoverage ?? 0,
          rationale: c.judgeVerdict?.rationale || null,
        });
      }
    }
  }
  const judgeSummary = {
    evaluatedCount: judgeEvaluatedCells.length,
    passedCount: judgeEvaluatedCells.filter((c) => c.judgeVerdict?.passedGate).length,
    disqualifiedCount: disqualifiedCellsCount,
    passRatePct:
      judgeEvaluatedCells.length > 0
        ? Math.round(
            (judgeEvaluatedCells.filter((c) => c.judgeVerdict?.passedGate).length / judgeEvaluatedCells.length) *
              1000
          ) / 10
        : 100,
    failureCategories: judgeFailureCategories,
    disqualifiedCells: disqualifiedCellList,
  };

  // 2c. Modern Web Guidance 0.0.197 Feature Adoption Census
  const builtCellsForMwg = cells.filter((c) => c.buildSucceeded && c.techStack);
  const mwgFeaturesSummary = MODERN_WEB_FEATURE_RULES.map((rule) => {
    const count = builtCellsForMwg.filter((c) => Boolean(c.techStack?.modernWebFeatures?.[rule.id])).length;
    return {
      id: rule.id,
      category: rule.category,
      label: rule.label,
      count,
      adoptionPct:
        builtCellsForMwg.length > 0 ? Math.round((count / builtCellsForMwg.length) * 1000) / 10 : 0,
    };
  }).sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));

  let mwgUpliftSyncedVersion = cells.find((c) => c.mwgVersion)?.mwgVersion || null;
  if (!mwgUpliftSyncedVersion) {
    const mwgState = safeReadJson(join(PROJECT_ROOT, 'node_modules', 'web-uplift', 'knowledge', 'mwg-state.json'));
    mwgUpliftSyncedVersion =
      mwgState?.analysedVersion || mwgState?.appliedRulesVersion || mwgState?.syncedVersion || null;
  }

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
        prev.failingCells.push({
          cellId: c.cellId,
          modelLabel: c.modelLabel,
          harness: c.harness || 'pi',
          mode: c.mode,
          promptTitle: c.promptTitle,
          score: f.score,
          displayValue: f.displayValue,
        });
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
  const harnessesStatus = listAllHarnessStatuses().map((h) => ({
    id: h.id,
    label: h.label,
    shortLabel: h.shortLabel,
    protocol: h.protocol,
    packageName: h.packageName || null,
    version: h.version || null,
    available: Boolean(h.available),
    source: h.source,
  }));
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
    directAuthReady: Boolean(b.directAuthReady),
    configuredEnvVars: b.configuredEnvVars || [],
    directEnvVars: b.directEnvVars || [],
    nativeAcpHarness: b.nativeAcpHarness || null,
  }));

  // 3b. Library-Detector + Wappalyzer Multi-Signal Library Census & Console Error Summary
  const libraryCensusMap = new Map();
  for (const c of builtCellsForMwg) {
    for (const lib of c.techStack?.detectedLibraries || []) {
      const prev = libraryCensusMap.get(lib.id) || {
        id: lib.id,
        name: lib.name || lib.id,
        category: lib.category || 'library',
        count: 0,
        versions: new Set(),
        signals: new Set(),
      };
      prev.count++;
      if (lib.version) prev.versions.add(lib.version);
      for (const s of lib.signals || []) prev.signals.add(s);
      libraryCensusMap.set(lib.id, prev);
    }
  }
  const byLibrary = Array.from(libraryCensusMap.values())
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      category: entry.category,
      count: entry.count,
      sharePct:
        builtCellsForMwg.length > 0 ? Math.round((entry.count / builtCellsForMwg.length) * 1000) / 10 : 0,
      versions: Array.from(entry.versions).slice(0, 6),
      signals: Array.from(entry.signals),
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const builtCellsWithConsole = cells.filter((c) => c.buildSucceeded && c.consoleAudit);
  const zeroErrorCellsCount = builtCellsWithConsole.filter((c) => c.consoleAudit?.zeroErrors).length;
  const consoleErrorSummary = {
    auditedCells: builtCellsWithConsole.length,
    zeroErrorCells: zeroErrorCellsCount,
    zeroErrorRatePct:
      builtCellsWithConsole.length > 0
        ? Math.round((zeroErrorCellsCount / builtCellsWithConsole.length) * 1000) / 10
        : 100,
    totalPageExceptions: builtCellsWithConsole.reduce(
      (s, c) => s + (c.consoleAudit?.counts?.pageExceptionCount || 0),
      0
    ),
    totalConsoleErrors: builtCellsWithConsole.reduce(
      (s, c) => s + (c.consoleAudit?.counts?.consoleErrorCount || 0),
      0
    ),
    totalHttpErrors: builtCellsWithConsole.reduce(
      (s, c) => s + (c.consoleAudit?.counts?.httpErrorCount || 0),
      0
    ),
    totalFailedRequests: builtCellsWithConsole.reduce(
      (s, c) => s + (c.consoleAudit?.counts?.failedRequestCount || 0),
      0
    ),
  };

  // Pipeline Timing, Phase Breakdown & Sharded VM Fleet Observability
  const genDurations = cells.map((c) => c.generationMs).filter((n) => typeof n === 'number' && n > 0);
  const auditedCellsWithTelemetry = cells.filter((c) => typeof c.auditTelemetry?.totalAuditMs === 'number');
  const auditDurations = auditedCellsWithTelemetry.map((c) => c.auditTelemetry.totalAuditMs);

  const phaseMediansMs = {
    materializeMs: percentile(
      auditedCellsWithTelemetry.map((c) => c.auditTelemetry?.phasesMs?.materializeMs),
      0.5
    ),
    serverBootMs: percentile(
      auditedCellsWithTelemetry.map((c) => c.auditTelemetry?.phasesMs?.serverBootMs),
      0.5
    ),
    flowCompileMs: percentile(
      auditedCellsWithTelemetry.map((c) => c.auditTelemetry?.phasesMs?.flowCompileMs),
      0.5
    ),
    techStackMs: percentile(
      auditedCellsWithTelemetry.map((c) => c.auditTelemetry?.phasesMs?.benchmarks?.['tech-stack']),
      0.5
    ),
    promptJudgeMs: percentile(
      auditedCellsWithTelemetry.map((c) => c.auditTelemetry?.phasesMs?.benchmarks?.['prompt-judge']),
      0.5
    ),
    consoleErrorsMs: percentile(
      auditedCellsWithTelemetry.map((c) => c.auditTelemetry?.phasesMs?.benchmarks?.['console-errors']),
      0.5
    ),
    lighthouseUpliftMs: percentile(
      auditedCellsWithTelemetry.map((c) => c.auditTelemetry?.phasesMs?.benchmarks?.['lighthouse-uplift']),
      0.5
    ),
    deepPerfMs: percentile(
      auditedCellsWithTelemetry.map((c) => c.auditTelemetry?.phasesMs?.benchmarks?.['deep-perf']),
      0.5
    ),
    memoryMs: percentile(
      auditedCellsWithTelemetry.map((c) => c.auditTelemetry?.phasesMs?.benchmarks?.memory),
      0.5
    ),
  };

  const slowestCells = auditedCellsWithTelemetry
    .map((c) => {
      const p = c.auditTelemetry?.phasesMs || {};
      const b = p.benchmarks || {};
      const entries = [
        ['materialize', p.materializeMs || 0],
        ['flow-compile', p.flowCompileMs || 0],
        ['tech-stack', b['tech-stack'] || 0],
        ['prompt-judge', b['prompt-judge'] || 0],
        ['console-errors', b['console-errors'] || 0],
        ['lighthouse-uplift', b['lighthouse-uplift'] || 0],
        ['deep-perf', b['deep-perf'] || 0],
        ['memory', b.memory || 0],
      ].sort((x, y) => y[1] - x[1]);
      const [slowestPhase, slowestPhaseMs] = entries[0] || ['unknown', 0];
      return {
        cellId: c.cellId,
        harness: c.harness || 'pi',
        mode: c.mode,
        serverArchitecture: c.serverArchitecture,
        status: c.auditTelemetry?.status || 'ok',
        totalAuditMs: c.auditTelemetry.totalAuditMs,
        slowestPhase,
        slowestPhaseMs,
      };
    })
    .sort((a, b) => b.totalAuditMs - a.totalAuditMs)
    .slice(0, 8);

  const failedCells = cells
    .filter(
      (c) =>
        c.generationError ||
        !c.buildSucceeded ||
        c.disqualifiedByJudge ||
        (c.auditTelemetry && c.auditTelemetry.status !== 'ok')
    )
    .map((c) => ({
      cellId: c.cellId,
      harness: c.harness || 'pi',
      mode: c.mode,
      status: c.generationError
        ? 'generation_failed'
        : !c.buildSucceeded
          ? c.auditTelemetry?.status && c.auditTelemetry.status !== 'ok'
            ? c.auditTelemetry.status
            : 'materialization_failed'
          : c.disqualifiedByJudge
            ? `disqualified_${c.judgeVerdict?.failureCategory || 'off-topic'}`
            : c.auditTelemetry?.status || 'error',
      failedStage: c.disqualifiedByJudge
        ? 'prompt-judge'
        : c.auditTelemetry?.failedStage || (c.generationError ? 'generating' : 'materializing'),
      durationMs: c.auditTelemetry?.totalAuditMs ?? c.generationMs ?? null,
      error: (
        c.generationError ||
        (c.disqualifiedByJudge ? c.judgeVerdict?.rationale : null) ||
        c.auditTelemetry?.error ||
        'Build or runtime server verification failed'
      ).slice(0, 260),
    }));

  let vmCanaryFleet = null;
  const canariesDir = join(PROJECT_ROOT, 'runs', 'canaries');
  if (existsSync(canariesDir)) {
    const canaryEntries = readdirSync(canariesDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => safeReadJson(join(canariesDir, f)))
      .filter(Boolean);
    if (canaryEntries.length > 0) {
      const statusCounts = { stable: 0, warning: 0, noisy: 0 };
      for (const ce of canaryEntries) {
        const s = String(ce.status || '').toLowerCase();
        if (s in statusCounts) statusCounts[s]++;
      }
      vmCanaryFleet = {
        shardCount: canaryEntries.length,
        statusCounts,
        nodeCpuMs: summarizeDurations(canaryEntries.map((c) => c.nodeCpuComputeMs)),
        chromeMainThreadMs: summarizeDurations(canaryEntries.map((c) => c.browserMainThreadComputeMs)),
      };
    }
  }

  const observability = {
    generationTiming: summarizeDurations(genDurations),
    auditTiming: {
      ...summarizeDurations(auditDurations),
      phaseMediansMs,
    },
    slowestCells,
    failedCells,
    vmCanaryFleet,
  };

  const byHarnessRows = summarizeCohort(byHarness, 'harness').map((r) => ({
    ...r,
    harnessLabel: getHarnessSpec(r.harness)?.label || r.harness,
  }));

  // Tracks are the headline comparison: the same model run directly (one-shot, clean-room agent) and inside each
  // vendor harness, which adds its own system prompt and tools.
  const byTrackRows = summarizeCohort(byTrack, 'track').map((r) => {
    const info = describeTrack(r.track);
    const all = cells.filter((c) => c.track === r.track);
    return {
      ...r,
      trackLabel: info.label,
      kind: info.kind,
      vendor: info.vendor || null,
      cellsRun: all.length,
      failedCells: all.filter((c) => !c.buildSucceeded).length,
      harnessVersions: [...new Set(all.map((c) => c.harnessVersion).filter(Boolean))],
      systemPromptHashes: [...new Set(all.map((c) => c.systemPromptSha256).filter(Boolean))],
    };
  });

  const summary = {
    generatedAt: new Date().toISOString(),
    weights,
    canary: loadLatestCanary(),
    observability,
    environment: {
      piVersion: piInfo.version,
      piSource: piInfo.source,
      piPortable: piInfo.portable,
      declaredPiPackage: `${piInfo.declaredSpec?.package}@${piInfo.declaredSpec?.version}`,
      mwgCatalogVersion: MODERN_WEB_CATALOG_VERSION,
      libraryDetectorVersion: LIBRARY_DETECTOR_ENGINE_VERSION,
      webUpliftMwgVersion: mwgUpliftSyncedVersion,
      harnesses: harnessesStatus,
      providerBridges: bridgesSummary,
    },
    totals: {
      cells: cells.length,
      validCells: validCellsCount,
      disqualifiedCells: disqualifiedCellsCount,
      agentCells: agentCellsCount,
      oneshotCells: oneshotCellsCount,
      acpCells: acpCellsCount,
      freeformCells: freeformCellsCount,
      guidedCells: guidedCellsCount,
      modelsWithRuns: new Set(cells.map((c) => c.modelKey)).size,
      harnessesWithRuns: new Set(cells.map((c) => c.harness || 'pi')).size,
      categoriesCovered: new Set(cells.map((c) => c.category)).size,
      promptsCovered: new Set(cells.map((c) => c.promptId)).size,
    },
    leaderboard,
    judgeSummary,
    consoleErrorSummary,
    trackComparison: {
      byTrack: byTrackRows,
    },
    harnessComparison: {
      byHarness: byHarnessRows,
      pairedHarnessHeadToHead,
    },
    modeComparison: {
      byMode: summarizeCohort(byMode, 'mode'),
      pairedHeadToHead,
    },
    specComparison: {
      bySpec: summarizeCohort(bySpec, 'spec'),
      pairedSpecHeadToHead,
    },
    modernWebAdoption: {
      catalogVersion: MODERN_WEB_CATALOG_VERSION,
      webUpliftMwgVersion: mwgUpliftSyncedVersion,
      builtCellsInspected: builtCellsForMwg.length,
      features: mwgFeaturesSummary,
    },
    techObservatory: {
      byFramework: summarizeCohort(byFramework, 'framework'),
      byBackend: summarizeCohort(byBackend, 'backend'),
      byDeliveryPattern: summarizeCohort(byDelivery, 'deliveryPattern'),
      byLibrary,
    },
    lighthouseAuditBreakdown: {
      cellsAudited: lhCellsAudited,
      topFailingAudits,
      universalPassingAudits: topPassingAudits.slice(0, 30),
    },
    categories: promptReg.categories,
    cells,
  };

  if (writeSummary) {
    mkdirSync(join(PROJECT_ROOT, 'data'), { recursive: true });
    writeFileSync(SUMMARY_OUT_PATH, JSON.stringify(summary, null, 2) + '\n', 'utf8');
  }
  return summary;
}
