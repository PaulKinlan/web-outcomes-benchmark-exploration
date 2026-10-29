import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parsePiSessionTranscript } from '../src/harness/pi-transcript.mjs';
import { extractGeneratedFiles } from '../src/materialize/extract-files.mjs';
import {
  resolveRuntimeContract,
  prepareCellRuntime,
  startCellServer,
  probeServerTelemetry,
} from '../src/materialize/server-runner.mjs';

test('parsePiSessionTranscript extracts turns, thinking, tool calls, and engineering habits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-transcript-'));
  try {
    const sessionPath = join(dir, 'pi-session.jsonl');
    const events = [
      { type: 'session', version: 3, id: 'sess-123', timestamp: '2026-10-28T23:00:00.000Z' },
      { type: 'model_change', provider: 'google', modelId: 'gemini-3.8-flash', timestamp: '2026-10-28T23:00:01.000Z' },
      { type: 'thinking_level_change', thinkingLevel: 'medium', timestamp: '2026-10-28T23:00:01.100Z' },
      {
        type: 'message',
        timestamp: '2026-10-28T23:00:05.000Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: 'I will build a full-stack booking server with SQLite and enable gzip compression for low TTFB.',
            },
            {
              type: 'toolCall',
              id: 'tc1',
              name: 'write',
              arguments: { path: 'server.mjs', content: '// server' },
            },
            {
              type: 'toolCall',
              id: 'tc2',
              name: 'bash',
              arguments: { command: 'npm install express better-sqlite3' },
            },
          ],
          usage: { input: 420, output: 180, reasoning: 65, totalTokens: 665, cost: { total: 0.00125 } },
        },
      },
      {
        type: 'message',
        timestamp: '2026-10-28T23:00:08.000Z',
        message: { role: 'toolResult', toolCallId: 'tc1', isError: false, content: [{ type: 'text', text: 'ok' }] },
      },
      {
        type: 'message',
        timestamp: '2026-10-28T23:00:12.000Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'tc3',
              name: 'bash',
              arguments: { command: 'PORT=4199 node server.mjs & sleep 1 && curl -i http://127.0.0.1:4199/api/slots' },
            },
            {
              type: 'write',
              name: 'write',
            },
            {
              type: 'text',
              text: 'Built and verified full-stack booking site with .bench-runtime.json.',
            },
          ],
          usage: { input: 600, output: 95, reasoning: 20, totalTokens: 715, cost: { total: 0.00095 } },
        },
      },
    ];
    writeFileSync(sessionPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

    const traj = parsePiSessionTranscript(sessionPath);
    assert.equal(traj.sessionId, 'sess-123');
    assert.equal(traj.provider, 'google');
    assert.equal(traj.modelId, 'gemini-3.8-flash');
    assert.equal(traj.turnCount, 2);
    assert.equal(traj.totalToolCalls, 3);
    assert.equal(traj.toolCallCounts.bash, 2);
    assert.equal(traj.toolCallCounts.write, 1);
    assert.equal(traj.thinkingBlockCount, 1);
    assert.ok(traj.thinkingChars > 50);
    assert.ok(traj.scaffoldingTools.includes('express'));
    assert.ok(traj.scaffoldingTools.includes('sqlite'));
    assert.ok(traj.installedNpmPackages.includes('express'));
    assert.equal(traj.engineeringHabits.selfVerifiedServer, true);
    assert.equal(traj.engineeringHabits.spontaneousPerfAttention, true);
    assert.equal(traj.usage.totalTokens, 1380);
    assert.equal(traj.usage.costUsd, 0.0022);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prepareCellRuntime, startCellServer, and probeServerTelemetry boot & audit a full-stack $PORT server', async () => {
  const cellDir = mkdtempSync(join(tmpdir(), 'bench-server-cell-'));
  try {
    const wsDir = join(cellDir, 'agent-workspace');
    mkdirSync(wsDir, { recursive: true });

    writeFileSync(
      join(wsDir, '.bench-runtime.json'),
      JSON.stringify({
        buildCommand: '',
        startCommand: 'node server.mjs',
        healthPath: '/',
      }),
      'utf8'
    );

    writeFileSync(
      join(wsDir, 'server.mjs'),
      `import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';

const port = Number(process.env.PORT || 3000);
const bookings = [
  { id: 1, service: 'Emergency Leak Repair', slot: 'Tomorrow 09:00' },
  { id: 2, service: 'Water Heater Inspection', slot: 'Thursday 14:00' }
];

const server = createServer((req, res) => {
  if (req.url === '/api/bookings') {
    const json = JSON.stringify({ bookings });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(json);
    return;
  }
  const html = \`<!doctype html><html><head><title>Plumbing Booking</title></head><body>
    <nav><a href="/">Home</a> <a href="/schedule">Schedule</a> <a href="/manage">Manage Booking</a></nav>
    <main><h1>Harbor City Plumbing Appointments</h1><p>Book licensed residential plumbing repairs, drain cleaning, and water heater service online.</p></main>
  </body></html>\`;
  const gz = gzipSync(Buffer.from(html, 'utf8'));
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Encoding': 'gzip',
    'Cache-Control': 'public, max-age=60',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(gz);
});

server.listen(port, '127.0.0.1');
`,
      'utf8'
    );

    const contract = resolveRuntimeContract(wsDir);
    assert.equal(contract.contractCompliance, true);
    assert.equal(contract.startCommand, 'node server.mjs');

    const extraction = extractGeneratedFiles({ cellDir });
    assert.equal(extraction.outputShape, 'fullstack-workspace');

    const mat = await prepareCellRuntime({ cellDir, extraction });
    assert.equal(mat.ok, true);
    assert.equal(mat.serverArchitecture, 'production-server');
    assert.equal(mat.contractCompliance, true);
    assert.ok(mat.verifiedColdBootMs >= 0);

    const srv = await startCellServer({ cellDir, materialization: mat });
    try {
      const telemetry = await probeServerTelemetry(srv);
      assert.equal(telemetry.serverArchitecture, 'production-server');
      assert.equal(telemetry.statusCode, 200);
      assert.equal(telemetry.usesCompression, true);
      assert.equal(telemetry.contentEncoding, 'gzip');
      assert.ok(telemetry.ssrWordCount >= 12, `Expected SSR words >= 12, got ${telemetry.ssrWordCount}`);
      assert.ok(telemetry.discoveredRoutes.includes('/schedule'));
      assert.ok(typeof telemetry.burstP95TtfbMs === 'number' && telemetry.burstP95TtfbMs >= 0);
      assert.equal(telemetry.burstErrorCount, 0);
      assert.ok(telemetry.loadServerRssMb > 0, `Expected positive server RSS MB, got ${telemetry.loadServerRssMb}`);

      // Verify live JSON API endpoint works on the booted server
      const apiRes = await fetch(`${srv.url}/api/bookings`);
      assert.equal(apiRes.status, 200);
      const apiData = await apiRes.json();
      assert.equal(apiData.bookings.length, 2);
    } finally {
      await srv.close();
    }
  } finally {
    rmSync(cellDir, { recursive: true, force: true });
  }
});
