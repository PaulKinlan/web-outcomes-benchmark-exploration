import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  createWriteStream,
} from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withIsolatedChrome, navigateAndSettle } from './cdp-helpers.mjs';
import { executeReversibleCycle } from '../flows/replay-journey.mjs';
import { sleep } from '../util/env.mjs';

const execFileAsync = promisify(execFile);

function resolveMemlabBin() {
  const candidates = [
    process.env.MEMLAB_BIN,
    '/Users/paulkinlan/.nvm/versions/node/v25.3.0/bin/memlab',
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return 'memlab';
}

async function sampleMemoryCounters(client) {
  const { HeapProfiler, Performance, Memory, Runtime } = client;
  await HeapProfiler.enable();
  await HeapProfiler.collectGarbage();
  await Runtime.evaluate({ expression: `window.gc && window.gc()` }).catch(() => {});
  await sleep(80);

  const [perfRes, domRes] = await Promise.all([
    Performance.getMetrics(),
    Memory.getDOMCounters ? Memory.getDOMCounters().catch(() => null) : Promise.resolve(null),
  ]);

  const map = {};
  for (const m of perfRes.metrics || []) map[m.name] = m.value;

  return {
    jsHeapUsedBytes: map.JSHeapUsedSize || 0,
    jsHeapTotalBytes: map.JSHeapTotalSize || 0,
    domNodes: domRes?.nodes ?? map.Nodes ?? 0,
    documents: domRes?.documents ?? map.Documents ?? 0,
    jsEventListeners: domRes?.jsEventListeners ?? map.JSEventListeners ?? 0,
    layoutObjects: map.LayoutObjects || 0,
  };
}

async function captureHeapSnapshotToDisk(client, outPath) {
  const { HeapProfiler } = client;
  await HeapProfiler.enable();
  await HeapProfiler.collectGarbage();
  await sleep(100);

  await new Promise((resolvePromise, rejectPromise) => {
    const outStream = createWriteStream(outPath, { encoding: 'utf8' });
    const onChunk = ({ chunk }) => {
      outStream.write(chunk);
    };
    client.on('HeapProfiler.addHeapSnapshotChunk', onChunk);

    HeapProfiler.takeHeapSnapshot({ reportProgress: false, treatGlobalObjectsAsRoots: true })
      .then(() => {
        client.removeListener('HeapProfiler.addHeapSnapshotChunk', onChunk);
        outStream.end(() => resolvePromise());
      })
      .catch((err) => {
        client.removeListener('HeapProfiler.addHeapSnapshotChunk', onChunk);
        outStream.destroy();
        rejectPromise(err);
      });
  });
}

/**
 * Extracts compact detached-DOM and constructor growth statistics directly from
 * V8 `.heapsnapshot` JSON files in Node without ever feeding raw snapshots to an LLM.
 */
function summarizeSnapshotDiff(baselinePath, finalPath) {
  function summarizeOne(filePath) {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    const meta = raw.snapshot?.meta || {};
    const nodeFields = meta.node_fields || [];
    const nodeTypes = meta.node_types?.[0] || [];
    const strings = raw.strings || [];
    const nodes = raw.nodes || [];

    const stride = nodeFields.length || 6;
    const typeIdx = nodeFields.indexOf('type');
    const nameIdx = nodeFields.indexOf('name');
    const selfSizeIdx = nodeFields.indexOf('self_size');
    const detachednessIdx = nodeFields.indexOf('detachedness');

    let detachedDomCount = 0;
    let detachedDomBytes = 0;
    let totalSelfBytes = 0;
    const byCtor = new Map();

    for (let i = 0; i < nodes.length; i += stride) {
      const typeName = nodeTypes[nodes[i + typeIdx]] || '';
      const name = strings[nodes[i + nameIdx]] || '';
      const selfSize = nodes[i + selfSizeIdx] || 0;
      const detachedness = detachednessIdx >= 0 ? nodes[i + detachednessIdx] : 0;
      totalSelfBytes += selfSize;

      // V8 EmbedderGraph::Node::Detachedness::kDetached === 2 in modern Chromium (e.g. name="<div>", detachedness=2),
      // while older Chromium used name="Detached HTMLDivElement".
      const isDetachedDom =
        detachedness === 2 ||
        (name.startsWith('Detached ') &&
          (name.includes('HTML') || name.includes('Node') || name.includes('SVG') || name.includes('DOM') || name.startsWith('Detached <')));

      if (isDetachedDom) {
        detachedDomCount++;
        detachedDomBytes += selfSize;
      }

      if (typeName === 'object' || typeName === 'closure' || typeName === 'native') {
        if (name && name.length < 80) {
          const prev = byCtor.get(name) || { count: 0, bytes: 0 };
          prev.count++;
          prev.bytes += selfSize;
          byCtor.set(name, prev);
        }
      }
    }

    return {
      nodeCount: raw.snapshot?.node_count || Math.floor(nodes.length / stride),
      totalSelfBytes,
      detachedDomCount,
      detachedDomBytes,
      byCtor,
    };
  }

  const base = summarizeOne(baselinePath);
  const fin = summarizeOne(finalPath);

  const growingConstructors = [];
  for (const [name, finStats] of fin.byCtor.entries()) {
    const baseStats = base.byCtor.get(name) || { count: 0, bytes: 0 };
    const deltaBytes = finStats.bytes - baseStats.bytes;
    const deltaCount = finStats.count - baseStats.count;
    if (deltaCount >= 5 && deltaBytes > 2048) {
      growingConstructors.push({
        constructor: name,
        deltaCount,
        deltaBytes,
      });
    }
  }
  growingConstructors.sort((a, b) => b.deltaBytes - a.deltaBytes);

  return {
    baselineNodeCount: base.nodeCount,
    finalNodeCount: fin.nodeCount,
    retainedBytesDelta: fin.totalSelfBytes - base.totalSelfBytes,
    baselineDetachedDomCount: base.detachedDomCount,
    finalDetachedDomCount: fin.detachedDomCount,
    detachedDomDelta: Math.max(0, fin.detachedDomCount - base.detachedDomCount),
    detachedDomBytesDelta: Math.max(0, fin.detachedDomBytes - base.detachedDomBytes),
    topGrowingObjects: growingConstructors.slice(0, 10),
  };
}

async function runMemlabFindLeaks(snapDir) {
  const memlabBin = resolveMemlabBin();
  const workDir = join(snapDir, 'memlab-work');
  mkdirSync(workDir, { recursive: true });

  // MemLab snapshot directory convention: s1.heapsnapshot, s2.heapsnapshot, s3.heapsnapshot + snap-seq.json
  writeFileSync(
    join(snapDir, 'snap-seq.json'),
    JSON.stringify(
      [
        { name: 'baseline', idx: 1, snapshot: true, type: 'baseline' },
        { name: 'target', idx: 2, snapshot: true, type: 'target' },
        { name: 'final', idx: 3, snapshot: true, type: 'final' },
      ],
      null,
      2
    ),
    'utf8'
  );

  try {
    const { stdout } = await execFileAsync(
      memlabBin,
      ['find-leaks', '--snapshot-dir', snapDir, '--work-dir', workDir],
      { timeout: 60000, maxBuffer: 8 * 1024 * 1024 }
    );

    // Strip ANSI escape sequences and parse MemLab leak clusters
    const clean = stdout.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
    const clusterBlocks = clean
      .split(/MemLab found \d+ leak\(s\)|--Similar leaks in this run:/i)
      .map((s) => s.trim())
      .filter(Boolean);

    const countMatch = clean.match(/MemLab found (\d+) leak/i);
    const leakCount = countMatch ? Number(countMatch[1]) : 0;

    return {
      memlabRan: true,
      leakClusterCount: leakCount,
      summaryExcerpt: clusterBlocks.slice(0, 3).map((b) => b.slice(0, 500)),
    };
  } catch (err) {
    return {
      memlabRan: false,
      leakClusterCount: null,
      note: (err.message || String(err)).slice(0, 200),
    };
  }
}

export default {
  id: 'memory',
  label: 'Memory Usage & MemLab Leak Detection',
  version: '1.0.0',
  requiresBrowser: true,

  async run(ctx) {
    const { url, cellDir, promptEntry, config, onProgress } = ctx;
    const snapDir = join(cellDir, '.tmp-heapsnapshots');
    mkdirSync(snapDir, { recursive: true });

    const iterations = config.memory?.leakLoopIterations || 10;

    try {
      const result = await withIsolatedChrome(
        { viewport: config.browser.viewportDesktop },
        async ({ client }) => {
          await client.Memory.enable?.().catch(() => {});
          await navigateAndSettle(client, url, config.browser.settleWaitMs || 1200);

          // Phase 1: Idle Memory Drift (0s -> t1 -> t2 with zero user input)
          const probeSecs = config.memory?.idleProbeSeconds || [0, 3, 10];
          const wait1Ms = Math.max(200, Math.round(((probeSecs[1] ?? 3) - (probeSecs[0] ?? 0)) * 1000));
          const wait2Ms = Math.max(200, Math.round(((probeSecs[2] ?? 10) - (probeSecs[1] ?? 3)) * 1000));
          onProgress?.({ stage: 'memory', detail: `Sampling idle heap & listener drift (${probeSecs.join('s → ')}s)` });
          const idle0 = await sampleMemoryCounters(client);
          await sleep(wait1Ms);
          const idle3 = await sampleMemoryCounters(client);
          await sleep(wait2Ms);
          const idle10 = await sampleMemoryCounters(client);

          const idleHeapGrowthBytes = idle10.jsHeapUsedBytes - idle0.jsHeapUsedBytes;
          const idleMonotonic =
            idle3.jsHeapUsedBytes > idle0.jsHeapUsedBytes + 64 * 1024 &&
            idle10.jsHeapUsedBytes > idle3.jsHeapUsedBytes + 128 * 1024;

          // Phase 2: 10x Reversible UI Cycle + 3 Heap Snapshots (Baseline -> Target -> Final)
          onProgress?.({ stage: 'memory', detail: 'Capturing s1 baseline heap snapshot' });
          const s1Path = join(snapDir, 's1.heapsnapshot');
          const s2Path = join(snapDir, 's2.heapsnapshot');
          const s3Path = join(snapDir, 's3.heapsnapshot');

          const beforeCycleCounters = await sampleMemoryCounters(client);
          await captureHeapSnapshotToDisk(client, s1Path);

          onProgress?.({ stage: 'memory', detail: `Running ${iterations}× reversible UI interaction cycles` });
          // Cycle 1 -> capture target snapshot mid-cycle
          await executeReversibleCycle(client, promptEntry.leakLoop);
          await captureHeapSnapshotToDisk(client, s2Path);

          // Remaining N-1 cycles
          for (let i = 1; i < iterations; i++) {
            await executeReversibleCycle(client, promptEntry.leakLoop);
          }

          await sleep(300);
          const afterCycleCounters = await sampleMemoryCounters(client);
          onProgress?.({ stage: 'memory', detail: 'Capturing s3 final heap snapshot & running MemLab analysis' });
          await captureHeapSnapshotToDisk(client, s3Path);

          const snapshotDiff = summarizeSnapshotDiff(s1Path, s3Path);
          const memlabReport = await runMemlabFindLeaks(snapDir);

          return {
            benchmarkId: 'memory',
            measuredAt: new Date().toISOString(),
            idleDrift: {
              t0s: idle0,
              t3s: idle3,
              t10s: idle10,
              idleHeapGrowthBytes,
              idleNodeDelta: idle10.domNodes - idle0.domNodes,
              idleListenerDelta: idle10.jsEventListeners - idle0.jsEventListeners,
              suspectedRunawayLoop: idleMonotonic && idleHeapGrowthBytes > 512 * 1024,
            },
            interactionLeakTest: {
              iterations,
              before: beforeCycleCounters,
              after: afterCycleCounters,
              heapGrowthAfterCyclesBytes: afterCycleCounters.jsHeapUsedBytes - beforeCycleCounters.jsHeapUsedBytes,
              heapGrowthPerCycleBytes: Math.round(
                (afterCycleCounters.jsHeapUsedBytes - beforeCycleCounters.jsHeapUsedBytes) / iterations
              ),
              domNodeDelta: afterCycleCounters.domNodes - beforeCycleCounters.domNodes,
              listenerDelta: afterCycleCounters.jsEventListeners - beforeCycleCounters.jsEventListeners,
              snapshotDiff,
              memlab: memlabReport,
            },
          };
        }
      );

      const resultsDir = join(cellDir, 'results');
      mkdirSync(resultsDir, { recursive: true });
      writeFileSync(join(resultsDir, 'memory.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
      return result;
    } finally {
      if (!config.memory?.keepRawSnapshots && existsSync(snapDir)) {
        rmSync(snapDir, { recursive: true, force: true });
      }
    }
  },

  score(result) {
    const idle = result?.idleDrift || {};
    const leak = result?.interactionLeakTest || {};
    const diff = leak.snapshotDiff || {};
    const memlabLeaks = leak.memlab?.leakClusterCount || 0;

    let penalty = 0;

    // 1. Baseline heap bloat (>35MB JS heap on simple single page)
    const baseHeapMb = (idle.t0s?.jsHeapUsedBytes || 0) / (1024 * 1024);
    if (baseHeapMb > 30) penalty += Math.min(20, Math.round((baseHeapMb - 30) * 0.5));

    // 2. Runaway idle allocation loop
    if (idle.suspectedRunawayLoop) penalty += 25;

    // 3. Detached DOM elements retained after 10x cycle + GC
    const detached = diff.detachedDomDelta || 0;
    if (detached > 0) penalty += Math.min(30, detached * 3);

    // 4. Event listener leak delta across 10 cycles
    const listenerLeak = Math.max(0, leak.listenerDelta || 0);
    if (listenerLeak >= 10) penalty += Math.min(25, Math.round(listenerLeak * 1.2));

    // 5. MemLab confirmed leak clusters & retained MB growth
    if (memlabLeaks > 0) penalty += Math.min(30, memlabLeaks * 10);
    const retainedMb = Math.max(0, (leak.heapGrowthAfterCyclesBytes || 0) / (1024 * 1024));
    if (retainedMb > 2) penalty += Math.min(25, Math.round((retainedMb - 2) * 4));

    const overall = Math.max(0, Math.min(100, 100 - penalty));

    return {
      overall,
      headline: {
        baselineHeapMb: Math.round(baseHeapMb * 100) / 100,
        retainedGrowthKb: Math.round((leak.heapGrowthAfterCyclesBytes || 0) / 1024),
        detachedDomDelta: detached,
        listenerLeakDelta: listenerLeak,
        memlabLeakClusters: memlabLeaks,
        suspectedRunawayLoop: Boolean(idle.suspectedRunawayLoop),
      },
    };
  },
};
