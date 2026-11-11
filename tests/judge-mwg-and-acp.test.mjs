import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  evaluateDeterministicRelevance,
  extractSeedDataAnchors,
} from '../src/benchmarks/prompt-judge.bench.mjs';
import {
  MODERN_WEB_CATALOG_VERSION,
  MODERN_WEB_FEATURE_RULES,
  analyzeStaticSource,
} from '../src/benchmarks/tech-stack.bench.mjs';
import {
  extractPrimitiveHighlights,
  computeEvidenceBackedUpliftScores,
} from '../src/benchmarks/lighthouse-uplift.bench.mjs';
import {
  listAllHarnessStatuses,
  getHarnessSpec,
  expandHarnessSelection,
} from '../src/harness/harness-registry.mjs';
import {
  runAcpCodingSession,
  parseAcpSessionTimeline,
} from '../src/harness/acp-client.mjs';
import {
  buildCellId,
  parseCellDirIdentity,
} from '../src/harness/generate.mjs';
import { scrubEnvForProvider } from '../src/harness/pi-auth-bridge.mjs';
import { planWorkflowShards } from '../src/runner/shard-planner.mjs';
import { parseCliArgs } from '../bin/bench.mjs';
import { aggregateAllResults } from '../src/scoring/aggregate.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const SAMPLE_PLUMBING_PROMPT = {
  id: 'plumbing-appointment',
  category: 'booking',
  categoryLabel: 'Booking / Scheduling Website',
  title: 'Plumbing Service Appointment & Management',
  prompt:
    'Create a plumbing service website where customers can select a repair type, pick an available date and time slot, submit an appointment booking form, and manage or cancel scheduled visits.',
  expectedFlows: ['select-service', 'pick-slot', 'submit-booking', 'cancel-visit'],
  seedData: {
    brandName: 'Copperline Plumbing Co.',
    tagline: 'Same-day residential leak & drain repair',
    address: '418 Harborview Ave, Seattle, WA 98104',
    phone: '(206) 555-0148',
    email: 'dispatch@copperlineplumbing.example',
    featuredItems: [
      { title: 'Emergency Leak Repair' },
      { title: 'Water Heater Replacement' },
      { title: 'Drain Hydro-Jetting' },
    ],
  },
};

describe('On-Topic & Functional Judge Layer (prompt-judge)', () => {
  it('disqualifies blank or crashed JS shell pages', () => {
    const blankEvidence = {
      pageTitle: 'Document',
      headings: [],
      interactiveControls: [],
      visibleTextExcerpt: '',
      visibleWordCount: 0,
      interactiveCount: 0,
      landmarks: { hasMain: false, hasNav: false, formCount: 0, canvasCount: 0, svgCount: 0 },
      pageExceptionCount: 1,
      consoleErrorCount: 1,
    };

    const res = evaluateDeterministicRelevance({
      evidence: blankEvidence,
      promptEntry: SAMPLE_PLUMBING_PROMPT,
      spec: 'freeform',
    });

    assert.equal(res.passedGate, false);
    assert.equal(res.failureCategory, 'blank-or-crashed');
    assert.equal(res.overall, 0);
  });

  it('disqualifies unedited Vite / Next / CRA framework starter boilerplate', () => {
    const viteStarterEvidence = {
      pageTitle: 'Vite + React + TS',
      headings: [{ tag: 'h1', text: 'Vite + React' }],
      interactiveControls: [{ tag: 'button', label: 'count is 0' }],
      visibleTextExcerpt:
        'Vite + React count is 0 Edit src/App.tsx and save to test HMR Click on the Vite and React logos to learn more',
      visibleWordCount: 24,
      interactiveCount: 3,
      landmarks: { hasMain: false, hasNav: false, formCount: 0, canvasCount: 0, svgCount: 0 },
      pageExceptionCount: 0,
      consoleErrorCount: 0,
    };

    const res = evaluateDeterministicRelevance({
      evidence: viteStarterEvidence,
      promptEntry: SAMPLE_PLUMBING_PROMPT,
      spec: 'freeform',
    });

    assert.equal(res.passedGate, false);
    assert.equal(res.failureCategory, 'stub-placeholder');
    assert.equal(res.overall, 0);
  });

  it('disqualifies off-topic builds that render a completely unrelated domain', () => {
    const offTopicEvidence = {
      pageTitle: 'HyperTrade Perpetual Crypto Futures DEX',
      headings: [
        { tag: 'h1', text: 'BTC-PERP Orderbook' },
        { tag: 'h2', text: 'Leverage Margin Calculator' },
      ],
      interactiveControls: [
        { tag: 'button', label: 'Buy Long 20x' },
        { tag: 'button', label: 'Sell Short 20x' },
        { tag: 'button', label: 'Connect Wallet' },
      ],
      visibleTextExcerpt:
        'HyperTrade Perpetual Crypto Futures DEX Trade BTC ETH SOL perpetual contracts with zero gas fees live orderbook depth funding rate countdown liquidation feed margin calculator.',
      visibleWordCount: 42,
      interactiveCount: 7,
      landmarks: { hasMain: true, hasNav: true, formCount: 1, canvasCount: 1, svgCount: 3 },
      pageExceptionCount: 0,
      consoleErrorCount: 0,
    };

    const res = evaluateDeterministicRelevance({
      evidence: offTopicEvidence,
      promptEntry: SAMPLE_PLUMBING_PROMPT,
      spec: 'freeform',
    });

    assert.equal(res.passedGate, false);
    assert.equal(res.failureCategory, 'off-topic');
    assert.equal(res.overall, 0);
  });

  it('passes genuine on-topic interactive builds and scores guided seed-data anchors', () => {
    const anchors = extractSeedDataAnchors(SAMPLE_PLUMBING_PROMPT.seedData);
    const anchorValues = anchors.map((a) => a.value);
    assert.ok(anchorValues.includes('Copperline Plumbing Co.'));
    assert.ok(anchorValues.includes('Emergency Leak Repair'));

    const validGuidedEvidence = {
      pageTitle: 'Copperline Plumbing Co. — Schedule Repair & Manage Visits',
      headings: [
        { tag: 'h1', text: 'Copperline Plumbing Co.' },
        { tag: 'h2', text: 'Select a Plumbing Repair Service' },
        { tag: 'h2', text: 'Pick Date & Time Slot' },
        { tag: 'h2', text: 'Scheduled Appointments' },
      ],
      interactiveControls: [
        { tag: 'button', label: 'Emergency Leak Repair' },
        { tag: 'button', label: 'Water Heater Replacement' },
        { tag: 'button', label: 'Drain Hydro-Jetting' },
        { tag: 'button', label: '09:00 AM' },
        { tag: 'button', label: 'Confirm Appointment Booking' },
        { tag: 'button', label: 'Cancel Visit' },
      ],
      visibleTextExcerpt:
        'Copperline Plumbing Co. Same-day residential leak & drain repair 418 Harborview Ave, Seattle, WA 98104 (206) 555-0148 dispatch@copperlineplumbing.example Select a repair type Emergency Leak Repair Water Heater Replacement Drain Hydro-Jetting Pick an available date and time slot submit an appointment booking form manage or cancel scheduled visits.',
      visibleWordCount: 95,
      interactiveCount: 12,
      landmarks: { hasMain: true, hasNav: true, formCount: 1, canvasCount: 0, svgCount: 4 },
      pageExceptionCount: 0,
      consoleErrorCount: 0,
    };

    const res = evaluateDeterministicRelevance({
      evidence: validGuidedEvidence,
      promptEntry: SAMPLE_PLUMBING_PROMPT,
      spec: 'guided',
      compiledFlow: { flowCompletionPct: 100 },
    });

    assert.equal(res.passedGate, true);
    assert.equal(res.failureCategory, null);
    assert.ok(res.overall >= 80, `Expected overall >= 80, got ${res.overall}`);
    assert.ok(res.scores.guidedFidelity >= 85, `Expected guidedFidelity >= 85, got ${res.scores.guidedFidelity}`);
    assert.ok(res.guidedSeedSummary.matchedCount >= 5);
  });
});

describe('modern-web-guidance@0.0.197 & web-uplift 11-primitive updates', () => {
  it('syncs web-uplift knowledge state to modern-web-guidance@0.0.197 and tracks all 39 platform feature rules', () => {
    assert.equal(MODERN_WEB_CATALOG_VERSION, '0.0.197');
    assert.equal(MODERN_WEB_FEATURE_RULES.length, 39);

    const mwgStatePath = join(REPO_ROOT, 'node_modules', 'web-uplift', 'knowledge', 'mwg-state.json');
    const mwgState = JSON.parse(readFileSync(mwgStatePath, 'utf8'));
    assert.equal(mwgState.analysedVersion || mwgState.appliedRulesVersion, '0.0.197');
    assert.equal(mwgState.guideCount, 194);

    const sampleFiles = [
      {
        path: 'index.html',
        content: [
          '<!doctype html><html lang="en"><head>',
          '<link rel="stylesheet" href="./app.css" integrity="sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC" crossorigin="anonymous">',
          '<script type="speculationrules">{"prerender":[{"where":{"href_matches":"/*"}}]}</script>',
          '</head><body>',
          '<button commandfor="booking-modal" command="show-modal" interestfor="tip-1">Book</button>',
          '<div id="tip-1" popover="hint">Instant slot preview</div>',
          '<dialog id="booking-modal" closedby="any"><form method="dialog"><button>Close</button></form></dialog>',
          '<canvas id="hero-canvas" content="drawable" width="600" height="300"></canvas>',
          '</body></html>',
        ].join('\n'),
      },
      {
        path: 'app.css',
        content: [
          '@layer base, components;',
          '.card-wrap { container-type: scroll-state; content-visibility: auto; text-wrap: balance; }',
          '@container scroll-state(stuck: top) { .header { box-shadow: 0 2px 8px oklch(0.2 0.02 250 / 0.2); } }',
          '.tip { position-anchor: --book-btn; top: anchor(bottom); animation-timeline: scroll(); }',
        ].join('\n'),
      },
      {
        path: 'app.js',
        content: [
          'const now = Temporal.Now.instant();',
          'const same = Origin.from(window.location.href);',
          'panel.startViewTransition(() => panel.classList.toggle("open"));',
          'ctx.drawElementImage(cardEl, 0, 0);',
          'navigator.modelContext?.provideContext({ tools: [] });',
        ].join('\n'),
      },
    ];

    const analysis = analyzeStaticSource({
      files: sampleFiles,
      materialization: { ok: true, runnableWithoutBuildStep: true },
    });

    assert.equal(analysis.modernWebCatalogVersion, '0.0.197');
    const detected = analysis.modernWebFeatures;
    assert.equal(detected.dialogClosedBy, true);
    assert.equal(detected.invokerCommands, true);
    assert.equal(detected.interestInvoker, true);
    assert.equal(detected.popoverApi, true);
    assert.equal(detected.htmlInCanvas, true);
    assert.equal(detected.scrollStateQueries, true);
    assert.equal(detected.anchorPositioning, true);
    assert.equal(detected.scrollDrivenAnimations, true);
    assert.equal(detected.scopedViewTransitions, true);
    assert.equal(detected.temporalApi, true);
    assert.equal(detected.originApi, true);
    assert.equal(detected.subresourceIntegrity, true);
    assert.equal(detected.speculationRules, true);
    assert.equal(detected.webMcpDeclarativeOrApi, true);
    assert.ok(analysis.modernWebAdoptionCount >= 16);
  });

  it('incorporates all 11 web-uplift raw-CDP primitives into highlights and owner outcome scores', () => {
    const mockPrimitives = {
      discoverability: { coveragePct: 90, isJsShell: false },
      layout: { cls: 0.01 },
      axe: { violations: [{ id: 'color-contrast' }] },
      targets: { undersized: [{ selector: '.tiny-btn' }] },
      console: { errors: [] },
      features: {
        tracked: { atRules: { '@container': 2 }, functions: { oklch: 4 } },
        overlays: { dialogElements: 1, popoverElements: 1 },
      },
      headers: {
        securityHeaders: {
          'content-security-policy': { present: true, empty: false, issues: [] },
          'x-content-type-options': { present: true, empty: false, issues: [] },
        },
      },
      images: { totalImages: 4, issues: { missingDimensions: 2, oversized: 1, notLazyBelowFold: 1, missingAlt: 1 } },
      secrets: { totalFindings: 1, findings: [{ severity: 'critical', pattern: 'stripe-live-secret' }] },
      a11ytree: { tree: { totalNodes: 48 }, focusOrder: { stopCount: 9, stopsWithoutVisibleIndicator: 2, stopsInsideAriaHidden: 0 } },
      resilience: { installabilitySignals: { manifestResolved: true, serviceWorkerRegistered: true }, offline: { navigationFailed: false } },
    };

    const highlights = extractPrimitiveHighlights(mockPrimitives);
    assert.equal(highlights.primitivesCollected.length, 11);
    assert.equal(highlights.imageHygiene.missingDimensions, 2);
    assert.equal(highlights.securityAndSecrets.exposedSecretCount, 1);
    assert.equal(highlights.securityAndSecrets.criticalOrHighSecrets, 1);
    assert.equal(highlights.focusAndA11yTree.stopsWithoutVisibleIndicator, 2);
    assert.equal(highlights.resilience.serviceWorkerRegistered, true);
    assert.equal(highlights.resilience.offlineRenderable, true);

    const scored = computeEvidenceBackedUpliftScores(
      mockPrimitives,
      { scores: { performance: 92, accessibility: 90, bestPractices: 90, seo: 92 } },
      '0.0.197'
    );
    // Critical secret finding must penalize trust outcome significantly
    assert.ok(scored.outcomes.trust <= 70, `Expected secret penalty on trust outcome, got ${scored.outcomes.trust}`);
    assert.equal(scored.mwgVersion, '0.0.197');
    assert.ok(scored.overall > 0 && scored.overall <= 100);
  });
});

describe('ACP v1 Coding Harness, Cell Identity, Sharding & Judge Hard-Gate Aggregation', () => {
  it('preserves backward-compatible pi cell IDs while suffixing ACP harnesses and sharding by harness', () => {
    assert.equal(
      buildCellId('claude-sonnet-5', 'photo-portfolio', 'agent', 'freeform', 'pi'),
      'claude-sonnet-5__photo-portfolio__agent'
    );
    assert.equal(
      buildCellId('claude-sonnet-5', 'photo-portfolio', 'agent', 'guided', 'claude-acp'),
      'claude-sonnet-5__photo-portfolio__agent__guided__claude-acp'
    );

    assert.deepEqual(parseCellDirIdentity('claude-sonnet-5__photo-portfolio__agent'), {
      harness: 'pi',
      modelKey: 'claude-sonnet-5',
      promptId: 'photo-portfolio',
      mode: 'agent',
      spec: 'freeform',
    });
    assert.deepEqual(
      parseCellDirIdentity('gpt-5-4__kanban-project-board__agent__guided__codex-acp'),
      {
        harness: 'codex-acp',
        modelKey: 'gpt-5-4',
        promptId: 'kanban-project-board',
        mode: 'agent',
        spec: 'guided',
      }
    );

    assert.deepEqual(expandHarnessSelection('acp'), ['claude-acp', 'codex-acp', 'gemini-acp', 'qwen-acp', 'kimi-acp']);
    assert.deepEqual(expandHarnessSelection('all'), ['pi', 'claude-acp', 'codex-acp', 'gemini-acp', 'qwen-acp', 'kimi-acp', 'muse-msp']);
    assert.deepEqual(expandHarnessSelection('claude-acp,codex-acp'), ['claude-acp', 'codex-acp']);

    const harnesses = listAllHarnessStatuses();
    assert.ok(harnesses.some((h) => h.id === 'pi' && h.available === true));
    assert.ok(getHarnessSpec('claude-acp'));
    assert.ok(getHarnessSpec('codex-acp'));

    const cli = parseCliArgs([
      'node',
      'bin/bench.mjs',
      '--harness=claude-acp,codex-acp',
      '--judge-only',
    ]);
    assert.equal(cli.harness, 'claude-acp,codex-acp');
    assert.equal(cli.judgeOnly, true);
    assert.equal(cli.stage, 'judge');

    const plan = planWorkflowShards({
      modelsRaw: 'claude-sonnet-5,gpt-5-4',
      promptScope: 'custom',
      customPromptsRaw: 'photo-portfolio,kanban-project-board',
      harness: 'all',
      mode: 'agent',
      spec: 'freeform',
    });
    assert.equal(plan.generateShards.length, 4);
    assert.deepEqual(
      plan.generateShards.map((s) => `${s.harness}:${s.model}`).sort(),
      ['claude-acp:claude-sonnet-5', 'codex-acp:gpt-5-4', 'pi:claude-sonnet-5', 'pi:gpt-5-4']
    );
  });

  it('drives a mock ACP v1 JSON-RPC 2.0 stdio agent end-to-end with fs/*, terminal/*, secret scrubbing, and transcript export', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'bench-acp-e2e-'));
    const workspaceDir = join(tmpRoot, 'agent-workspace');
    const cellDir = join(tmpRoot, 'cell');
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(cellDir, { recursive: true });

    const mockAgentPath = join(tmpRoot, 'mock-acp-agent.mjs');
    writeFileSync(
      mockAgentPath,
      `
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let nextReqId = 500;
const pending = new Map();

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\\n');
}
function callClient(method, params) {
  const id = nextReqId++;
  send({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

rl.on('line', async (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id != null && !msg.method) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
    return;
  }

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'mock-claude-acp', version: '1.2.3' },
        agentCapabilities: { loadSession: false },
      },
    });
  } else if (msg.method === 'session/new') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        sessionId: 'sess_mock_1',
        modes: { availableModes: [{ id: 'bypassPermissions', name: 'Bypass' }] },
        models: { availableModels: [{ modelId: 'claude-sonnet-5' }] },
      },
    });
  } else if (msg.method === 'session/set_mode' || msg.method === 'session/set_model') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else if (msg.method === 'session/prompt') {
    const sid = msg.params.sessionId;
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: sid,
        update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Planning static plumbing booking app...' } },
      },
    });

    const perm = await callClient('session/request_permission', {
      sessionId: sid,
      toolCall: { toolCallId: 'tc_1', title: 'Write index.html' },
      options: [
        { optionId: 'allow-always', kind: 'allow_always', name: 'Always Allow' },
        { optionId: 'reject-once', kind: 'reject_once', name: 'Reject' },
      ],
    });

    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: sid,
        update: { sessionUpdate: 'tool_call', toolCallId: 'tc_1', title: 'Write index.html', kind: 'edit', status: 'in_progress' },
      },
    });

    await callClient('fs/write_text_file', {
      sessionId: sid,
      path: 'index.html',
      content: '<!doctype html><html><head><title>ACP Built App</title></head><body><h1>Copperline Plumbing</h1></body></html>',
    });
    await callClient('fs/write_text_file', {
      sessionId: sid,
      path: '.bench-runtime.json',
      content: JSON.stringify({ kind: 'static', staticDir: '.' }),
    });

    let traversalBlocked = false;
    try {
      await callClient('fs/write_text_file', {
        sessionId: sid,
        path: '../escaped.txt',
        content: 'nope',
      });
    } catch {
      traversalBlocked = true;
    }

    const term = await callClient('terminal/create', {
      sessionId: sid,
      command: 'node',
      args: ['-e', 'process.stdout.write("DEEPSEEK=" + (process.env.DEEPSEEK_API_KEY || "SCRUBBED") + ";TRAVERSAL=" + ' + JSON.stringify(String(traversalBlocked)) + ')'],
    });
    await callClient('terminal/wait_for_exit', { sessionId: sid, terminalId: term.terminalId });
    const termOut = await callClient('terminal/output', { sessionId: sid, terminalId: term.terminalId });
    await callClient('terminal/release', { sessionId: sid, terminalId: term.terminalId });

    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: sid,
        update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc_1', status: 'completed' },
      },
    });
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Done! perm=' + perm.outcome.optionId + ' ' + termOut.output },
        },
      },
    });

    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        stopReason: 'end_turn',
        usage: { inputTokens: 420, outputTokens: 180, totalTokens: 600 },
      },
    });
  }
});
`,
      'utf8'
    );

    const prevDeepseek = process.env.DEEPSEEK_API_KEY;
    const prevAnthropic = process.env.ANTHROPIC_API_KEY;
    try {
      process.env.DEEPSEEK_API_KEY = 'sk-deepseek-should-not-leak';
      process.env.ANTHROPIC_API_KEY = 'sk-ant-allowed-for-anthropic';

      const harnessSpec = getHarnessSpec('claude-acp');
      const sessionJsonlPath = join(cellDir, 'acp-session.jsonl');
      const trajectoryJsonPath = join(cellDir, 'trajectory.json');
      const transcriptHtmlPath = join(cellDir, 'pi-transcript.html');
      const scrubbedEnv = scrubEnvForProvider(process.env, 'anthropic');

      const result = await runAcpCodingSession({
        command: process.execPath,
        args: [mockAgentPath],
        workspaceDir,
        env: scrubbedEnv,
        harnessSpec,
        desiredModelId: 'claude-sonnet-5',
        desiredModelKey: 'claude-sonnet-5',
        promptText: SAMPLE_PLUMBING_PROMPT.prompt,
        sessionJsonlPath,
        trajectoryJsonPath,
        transcriptHtmlPath,
        timeoutMs: 15_000,
      });

      assert.equal(result.ok, true, `ACP session failed: ${result.error}`);
      assert.equal(result.agentInfo.name, 'mock-claude-acp');
      assert.ok(result.assistantText.includes('perm=allow-always'));
      assert.ok(result.assistantText.includes('DEEPSEEK=SCRUBBED'));
      assert.ok(result.assistantText.includes('TRAVERSAL=true'));
      assert.equal(existsSync(join(tmpRoot, 'escaped.txt')), false);
      assert.ok(existsSync(join(workspaceDir, 'index.html')));
      assert.equal(result.trajectory.harness, 'claude-acp');
      assert.equal(result.trajectory.protocol, 'acp-v1');
      assert.equal(result.trajectory.usage.totalTokens, 600);
      assert.equal(result.hasTranscriptHtml, true);
      const htmlText = readFileSync(transcriptHtmlPath, 'utf8');
      assert.ok(htmlText.includes('Claude Code (ACP)'));

      const timeline = parseAcpSessionTimeline(sessionJsonlPath);
      assert.ok(timeline);
      assert.ok(timeline.turnCount >= 1);
      assert.ok(timeline.turns[0].thinking[0].includes('Planning static plumbing'));
    } finally {
      if (prevDeepseek === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = prevDeepseek;
      if (prevAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnthropic;
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('enforces Judge hard-gate composite=0 disqualification and separates pi vs ACP harnesses in aggregateAllResults', () => {
    const tmpRuns = mkdtempSync(join(tmpdir(), 'bench-agg-judge-'));
    try {
      const cellsRoot = join(tmpRuns, 'cells');

      // Cell 1: Valid pi build
      const c1 = join(cellsRoot, 'claude-sonnet-5__plumbing-appointment__agent');
      mkdirSync(join(c1, 'results'), { recursive: true });
      writeFileSync(
        join(c1, 'generation.json'),
        JSON.stringify({
          cellId: 'claude-sonnet-5__plumbing-appointment__agent',
          harness: 'pi',
          modelKey: 'claude-sonnet-5',
          provider: 'anthropic',
          modelId: 'claude-sonnet-5',
          promptId: 'plumbing-appointment',
          mode: 'agent',
          spec: 'freeform',
          durationMs: 12000,
        })
      );
      writeFileSync(join(c1, 'materialization.json'), JSON.stringify({ ok: true, outputShape: 'static-workspace', serverArchitecture: 'static-server' }));
      writeFileSync(
        join(c1, 'results', 'prompt-judge.json'),
        JSON.stringify({
          passedGate: true,
          failureCategory: null,
          evaluationMode: 'multimodal-llm-judge',
          overall: 88,
          scores: { onTopic: 92, featureCoverage: 85, functionalReadiness: 86, visualCoherence: 90 },
          verifiedFeatures: ['Service selector', 'Date/time picker', 'Booking form'],
          missingRequirements: [],
          rationale: 'Complete plumbing appointment scheduler.',
        })
      );
      writeFileSync(
        join(c1, 'results', 'lighthouse-uplift.json'),
        JSON.stringify({
          lighthouse: { compositeScore: 95, mobile: { scores: { performance: 95, accessibility: 94, bestPractices: 100, seo: 92 }, failingAudits: [], passedAudits: [] } },
          uplift: { overall: 91, outcomes: { discoverable: 92 } },
        })
      );
      writeFileSync(
        join(c1, 'results', 'tech-stack.json'),
        JSON.stringify({
          primaryFramework: 'vanilla',
          primaryBackend: 'static-only',
          primaryCss: 'custom-css',
          deliveryPattern: 'zero-dep-vanilla',
          staticAnalysis: { modernWebAdoptionCount: 3, modernWebFeatures: { nativeDialog: true, popoverApi: true, hasSelector: true } },
        })
      );

      // Cell 2: Disqualified starter-boilerplate build on pi (looks fast in Lighthouse: 100, but stub -> composite MUST be 0!)
      const c2 = join(cellsRoot, 'claude-sonnet-5__photo-portfolio__agent');
      mkdirSync(join(c2, 'results'), { recursive: true });
      writeFileSync(
        join(c2, 'generation.json'),
        JSON.stringify({
          cellId: 'claude-sonnet-5__photo-portfolio__agent',
          harness: 'pi',
          modelKey: 'claude-sonnet-5',
          provider: 'anthropic',
          modelId: 'claude-sonnet-5',
          promptId: 'photo-portfolio',
          mode: 'agent',
          spec: 'freeform',
          durationMs: 4000,
        })
      );
      writeFileSync(join(c2, 'materialization.json'), JSON.stringify({ ok: true, outputShape: 'single-html', serverArchitecture: 'static-only' }));
      writeFileSync(
        join(c2, 'results', 'prompt-judge.json'),
        JSON.stringify({
          passedGate: false,
          failureCategory: 'stub-placeholder',
          evaluationMode: 'deterministic',
          overall: 0,
          scores: { onTopic: 10, featureCoverage: 5, functionalReadiness: 0, visualCoherence: 0 },
          rationale: 'Unedited Vite + React starter template.',
        })
      );
      writeFileSync(
        join(c2, 'results', 'lighthouse-uplift.json'),
        JSON.stringify({
          lighthouse: { compositeScore: 100, mobile: { scores: { performance: 100, accessibility: 100, bestPractices: 100, seo: 100 }, failingAudits: [], passedAudits: [] } },
          uplift: { overall: 98, outcomes: {} },
        })
      );

      // Cell 3: Valid claude-acp build on same prompt as Cell 1
      const c3 = join(cellsRoot, 'claude-sonnet-5__plumbing-appointment__agent__claude-acp');
      mkdirSync(join(c3, 'results'), { recursive: true });
      writeFileSync(
        join(c3, 'generation.json'),
        JSON.stringify({
          cellId: 'claude-sonnet-5__plumbing-appointment__agent__claude-acp',
          harness: 'claude-acp',
          modelKey: 'claude-sonnet-5',
          provider: 'anthropic',
          modelId: 'claude-sonnet-5',
          promptId: 'plumbing-appointment',
          mode: 'agent',
          spec: 'freeform',
          durationMs: 15000,
        })
      );
      writeFileSync(join(c3, 'materialization.json'), JSON.stringify({ ok: true, outputShape: 'static-workspace', serverArchitecture: 'static-server' }));
      writeFileSync(
        join(c3, 'results', 'prompt-judge.json'),
        JSON.stringify({
          passedGate: true,
          failureCategory: null,
          evaluationMode: 'multimodal-llm-judge',
          overall: 93,
          scores: { onTopic: 96, featureCoverage: 92, functionalReadiness: 90, visualCoherence: 94 },
        })
      );
      writeFileSync(
        join(c3, 'results', 'lighthouse-uplift.json'),
        JSON.stringify({
          lighthouse: { compositeScore: 97, mobile: { scores: { performance: 97, accessibility: 96, bestPractices: 100, seo: 95 }, failingAudits: [], passedAudits: [] } },
          uplift: { overall: 94, outcomes: {} },
        })
      );

      const summary = aggregateAllResults({ cellsRoot, writeSummary: false });
      const disqCell = summary.cells.find((c) => c.cellId === 'claude-sonnet-5__photo-portfolio__agent');
      assert.ok(disqCell);
      assert.equal(disqCell.disqualifiedByJudge, true);
      assert.equal(disqCell.validBuild, false);
      assert.equal(disqCell.scores.composite, 0);

      const validPiCell = summary.cells.find((c) => c.cellId === 'claude-sonnet-5__plumbing-appointment__agent');
      assert.equal(validPiCell.validBuild, true);
      assert.ok(validPiCell.scores.composite > 80);

      assert.equal(summary.judgeSummary.evaluatedCount, 3);
      assert.equal(summary.judgeSummary.passedCount, 2);
      assert.equal(summary.judgeSummary.disqualifiedCount, 1);
      assert.equal(summary.judgeSummary.failureCategories['stub-placeholder'], 1);

      // Leaderboard separates pi vs claude-acp rows and penalizes pi's overall composite with 0 for the disqualified cell
      const piRow = summary.leaderboard.find((r) => r.harness === 'pi' && r.modelKey === 'claude-sonnet-5');
      const acpRow = summary.leaderboard.find((r) => r.harness === 'claude-acp' && r.modelKey === 'claude-sonnet-5');
      assert.ok(piRow && acpRow);
      assert.equal(piRow.cellsRun, 2);
      assert.equal(piRow.validBuildRatePct, 50);
      assert.equal(piRow.disqualifiedCount, 1);
      assert.equal(piRow.scores.judge, 88);
      assert.equal(piRow.scores.composite, Math.round((validPiCell.scores.composite / 2) * 10) / 10);
      assert.ok(acpRow.scores.composite > piRow.scores.composite);
      assert.equal(summary.harnessComparison.byHarness.length, 2);
      assert.equal(summary.harnessComparison.pairedHarnessHeadToHead.length, 1);
      assert.equal(summary.modernWebAdoption.catalogVersion, '0.0.197');
    } finally {
      rmSync(tmpRuns, { recursive: true, force: true });
    }
  });
});
