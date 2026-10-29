import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { serveStaticDirectory } from '../src/materialize/serve-site.mjs';
import { compileCanonicalFlow } from '../src/flows/compile-flow.mjs';
import techStackBench from '../src/benchmarks/tech-stack.bench.mjs';
import deepPerfBench from '../src/benchmarks/deep-perf.bench.mjs';
import memoryBench from '../src/benchmarks/memory.bench.mjs';

const TEST_CONFIG = {
  browser: {
    viewportDesktop: { width: 1280, height: 800 },
    viewportMobile: { width: 390, height: 844 },
    mobileThrottle: {
      cpuSlowdownMultiplier: 4,
      latencyMs: 80,
      downloadThroughputKbps: 4000,
      uploadThroughputKbps: 1500,
    },
    settleWaitMs: 400,
  },
  memory: {
    idleProbeSeconds: [0, 0.3, 0.8],
    leakLoopIterations: 6,
    keepRawSnapshots: false,
  },
};

const TEST_PROMPT = {
  id: 'booking-fixture',
  category: 'booking-scheduling',
  title: 'Booking Fixture',
  prompt: 'Create an appointment booking page with member login and booking modal.',
  canonicalJourney: [
    {
      id: 'login',
      label: 'Log in with demo account',
      action: 'auth',
      triggerPatterns: ['sign in', 'member'],
      demoPatterns: ['demo login'],
    },
    {
      id: 'open-booking',
      label: 'Open booking modal',
      action: 'click',
      patterns: ['book appointment'],
    },
    {
      id: 'confirm-booking',
      label: 'Confirm reservation',
      action: 'form-submit',
      fields: { name: 'Alex Rivera' },
      submitPatterns: ['confirm booking'],
    },
  ],
  leakLoop: {
    doPatterns: ['book appointment'],
    undoPatterns: ['close modal'],
  },
};

const CLEAN_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Clean Plumbing Scheduler</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 2rem; color: #111; background: #fff; }
    button { padding: 12px 18px; margin: 6px; font-size: 16px; cursor: pointer; }
    dialog { padding: 24px; border: 1px solid #ccc; border-radius: 8px; }
  </style>
</head>
<body>
  <h1>Harbor Plumbing Appointments</h1>
  <p id="auth-status">Signed out</p>
  <button id="demo-btn" type="button">Demo Login</button>
  <button id="open-book-btn" type="button">Book Appointment</button>
  <div id="bookings-list"></div>

  <dialog id="book-modal">
    <h2>Reserve Time Slot</h2>
    <label for="cust-name">Customer Name</label>
    <input id="cust-name" name="name" placeholder="Name" />
    <div>
      <button id="confirm-btn" type="button">Confirm Booking</button>
      <button id="close-btn" type="button">Close Modal</button>
    </div>
  </dialog>

  <script>
    const modal = document.getElementById('book-modal');
    document.getElementById('demo-btn').addEventListener('click', () => {
      document.getElementById('auth-status').textContent = 'Signed in as Demo Member';
    });
    document.getElementById('open-book-btn').addEventListener('click', () => {
      modal.showModal();
    });
    document.getElementById('close-btn').addEventListener('click', () => {
      modal.close();
    });
    document.getElementById('confirm-btn').addEventListener('click', () => {
      const name = document.getElementById('cust-name').value || 'Guest';
      const item = document.createElement('p');
      item.textContent = 'Confirmed slot for ' + name;
      document.getElementById('bookings-list').appendChild(item);
      modal.close();
    });
  </script>
</body>
</html>`;

const SLOW_LEAKY_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Slow Leaky Scheduler</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 2rem; }
    button { padding: 12px 18px; margin: 6px; font-size: 16px; }
    .overlay { display: none; padding: 20px; border: 1px solid #444; }
    .overlay.open { display: block; }
  </style>
</head>
<body>
  <h1>Leaky Scheduler</h1>
  <p id="auth-status">Signed out</p>
  <button id="demo-btn" type="button">Demo Login</button>
  <button id="open-book-btn" type="button">Book Appointment</button>
  <div id="bookings-list"></div>

  <div id="overlay" class="overlay" role="dialog">
    <h2>Reserve Slot</h2>
    <input id="cust-name" name="name" placeholder="Name" />
    <button id="confirm-btn" type="button">Confirm Booking</button>
    <button id="close-btn" type="button">Close Modal</button>
  </div>

  <script>
    window.__retainedDetachedTrees = [];
    function burnMainThread(ms) {
      const end = performance.now() + ms;
      while (performance.now() < end) {}
    }

    document.getElementById('demo-btn').addEventListener('click', () => {
      burnMainThread(95);
      document.getElementById('auth-status').textContent = 'Signed in as Demo Member';
    });

    document.getElementById('open-book-btn').addEventListener('click', () => {
      burnMainThread(110);
      document.getElementById('overlay').classList.add('open');

      // Intentional memory & listener leak on every modal open/close cycle!
      const detachedRoot = document.createElement('div');
      for (let i = 0; i < 40; i++) {
        const child = document.createElement('section');
        child.textContent = 'leaked-payload-' + i + '-' + 'x'.repeat(512);
        detachedRoot.appendChild(child);
      }
      document.body.appendChild(detachedRoot);
      document.body.removeChild(detachedRoot); // Now detached from DOM!
      const leakedListener = () => console.log(detachedRoot.childNodes.length);
      window.addEventListener('resize', leakedListener);
      window.__retainedDetachedTrees.push({ detachedRoot, buf: new Array(8000).fill('leak') });
    });

    document.getElementById('close-btn').addEventListener('click', () => {
      document.getElementById('overlay').classList.remove('open');
    });

    document.getElementById('confirm-btn').addEventListener('click', () => {
      burnMainThread(90);
      const item = document.createElement('p');
      item.textContent = 'Booked for ' + (document.getElementById('cust-name').value || 'Guest');
      document.getElementById('bookings-list').appendChild(item);
      document.getElementById('overlay').classList.remove('open');
    });
  </script>
</body>
</html>`;

test('flow compiler, deep-perf (W3C INP), and memory leak detector distinguish clean vs slow/leaky sites', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bench-e2e-'));
  const cleanDist = join(root, 'clean-dist');
  const leakyDist = join(root, 'leaky-dist');
  const cleanCell = join(root, 'clean-cell');
  const leakyCell = join(root, 'leaky-cell');
  mkdirSync(cleanDist, { recursive: true });
  mkdirSync(leakyDist, { recursive: true });
  writeFileSync(join(cleanDist, 'index.html'), CLEAN_HTML, 'utf8');
  writeFileSync(join(leakyDist, 'index.html'), SLOW_LEAKY_HTML, 'utf8');

  const cleanSrv = await serveStaticDirectory(cleanDist);
  const leakySrv = await serveStaticDirectory(leakyDist);

  try {
    // 1. Compile canonical multi-step flow on both sites
    const cleanFlow = await compileCanonicalFlow({
      url: cleanSrv.url,
      promptEntry: TEST_PROMPT,
      cellDir: cleanCell,
      config: TEST_CONFIG,
    });
    const leakyFlow = await compileCanonicalFlow({
      url: leakySrv.url,
      promptEntry: TEST_PROMPT,
      cellDir: leakyCell,
      config: TEST_CONFIG,
    });

    assert.equal(cleanFlow.compiled.resolvedSteps, 3);
    assert.ok(cleanFlow.compiled.flowCompletionPct >= 80, `Clean flow completion was ${cleanFlow.compiled.flowCompletionPct}%`);
    assert.equal(leakyFlow.compiled.resolvedSteps, 3);

    // 2. Tech stack benchmark captures runtime DOM + screenshots
    const cleanTech = await techStackBench.run({
      url: cleanSrv.url,
      cellDir: cleanCell,
      extraction: { files: [{ path: 'index.html', content: CLEAN_HTML }] },
      materialization: { outputShape: 'single-html', materializeTier: 'native-static', runnableWithoutBuildStep: true },
      config: TEST_CONFIG,
    });
    assert.equal(cleanTech.primaryFramework, 'vanilla');
    assert.equal(cleanTech.runtime.renderedNonBlank, true);
    assert.ok(existsSync(join(cleanCell, 'screenshots', 'desktop.png')));

    // 3. Deep-perf benchmark measures real W3C EventTiming INP and ranks clean > slow
    const cleanPerf = await deepPerfBench.run({
      url: cleanSrv.url,
      cellDir: cleanCell,
      compiledFlow: cleanFlow.compiled,
      promptEntry: TEST_PROMPT,
      config: TEST_CONFIG,
    });
    const leakyPerf = await deepPerfBench.run({
      url: leakySrv.url,
      cellDir: leakyCell,
      compiledFlow: leakyFlow.compiled,
      promptEntry: TEST_PROMPT,
      config: TEST_CONFIG,
    });

    assert.ok(cleanPerf.journey.interactionCount >= 3, 'Expected real W3C EventTiming interactions');
    assert.ok(leakyPerf.journey.inpMs > cleanPerf.journey.inpMs + 80, `Expected leaky/slow INP (${leakyPerf.journey.inpMs}ms) >> clean INP (${cleanPerf.journey.inpMs}ms)`);

    // 4. Memory benchmark detects detached DOM nodes + listener leak on leaky site & cleans up raw snapshots
    const cleanMem = await memoryBench.run({
      url: cleanSrv.url,
      cellDir: cleanCell,
      promptEntry: TEST_PROMPT,
      config: TEST_CONFIG,
    });
    const leakyMem = await memoryBench.run({
      url: leakySrv.url,
      cellDir: leakyCell,
      promptEntry: TEST_PROMPT,
      config: TEST_CONFIG,
    });

    assert.equal(existsSync(join(leakyCell, '.tmp-heapsnapshots')), false, 'Raw .heapsnapshot files must be cleaned up');
    assert.ok(
      leakyMem.interactionLeakTest.listenerDelta >= 5,
      `Expected listener leak delta >= 5, got ${leakyMem.interactionLeakTest.listenerDelta}`
    );
    assert.ok(
      leakyMem.interactionLeakTest.snapshotDiff.detachedDomDelta > cleanMem.interactionLeakTest.snapshotDiff.detachedDomDelta,
      `Expected detached DOM delta (${leakyMem.interactionLeakTest.snapshotDiff.detachedDomDelta}) > clean (${cleanMem.interactionLeakTest.snapshotDiff.detachedDomDelta})`
    );

    const cleanMemScore = memoryBench.score(cleanMem).overall;
    const leakyMemScore = memoryBench.score(leakyMem).overall;
    assert.ok(cleanMemScore > leakyMemScore, `Expected clean memory score (${cleanMemScore}) > leaky score (${leakyMemScore})`);
  } finally {
    await cleanSrv.close();
    await leakySrv.close();
    rmSync(root, { recursive: true, force: true });
  }
});
