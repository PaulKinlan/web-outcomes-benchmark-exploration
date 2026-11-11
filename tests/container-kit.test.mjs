import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { buildDockerfile, detectRuntimeKind, writeCellContainerKit, CONTAINER_PORT } from '../src/hosting/containerize.mjs';

function makeCell(files) {
  const cellDir = mkdtempSync(join(tmpdir(), 'kit-cell-'));
  const ws = join(cellDir, 'agent-workspace');
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(ws, rel, '..'), { recursive: true });
    writeFileSync(join(ws, rel), text);
  }
  return { cellDir, ws };
}
const SERVER = { serverArchitecture: 'production-server', runtimeDirRel: 'agent-workspace' };

describe('Container kit for generated servers', () => {
  it('builds a Node Dockerfile from the start contract, with nested installs and the build step', () => {
    const { cellDir, ws } = makeCell({
      'package.json': JSON.stringify({ scripts: { start: 'node server.js', build: 'vite build' } }),
      'client/package.json': '{}',
      'server.js': '',
    });
    try {
      const df = buildDockerfile({ workspaceDir: ws });
      assert.match(df, /^FROM node:22-bookworm-slim$/m);
      assert.match(df, /^RUN npm install --include=dev/m);
      assert.match(df, /^RUN cd client && npm install/m);
      assert.match(df, /^RUN npm run build$/m);
      assert.match(df, new RegExp(`^EXPOSE ${CONTAINER_PORT}$`, 'm'));
      assert.match(df, /socat TCP-LISTEN:8080,fork,reuseaddr TCP:127\.0\.0\.1:8081 & exec npm start/);
      assert.ok(df.indexOf('ENV NODE_ENV=production PORT=8081') < df.indexOf('RUN npm run build'));
    } finally {
      rmSync(cellDir, { recursive: true, force: true });
    }
  });

  it('picks the runtime from what the workspace contains', () => {
    const py = makeCell({ 'app.py': '', 'requirements.txt': 'flask\n' });
    const go = makeCell({ 'go.mod': 'module x', 'main.go': '' });
    const mixed = makeCell({ 'package.json': '{"scripts":{"start":"node s.js"}}', 'requirements.txt': 'x' });
    try {
      assert.equal(detectRuntimeKind(py.ws, { startCommand: 'python3 app.py' }), 'python');
      assert.match(buildDockerfile({ workspaceDir: py.ws }), /FROM python:3\.12-slim-bookworm[\s\S]*pip install --no-cache-dir -r requirements\.txt/);
      assert.match(buildDockerfile({ workspaceDir: go.ws }), /FROM golang:1\.23-bookworm[\s\S]*RUN go build -o \.\/bench-app \./);
      assert.equal(detectRuntimeKind(mixed.ws, { startCommand: 'npm start' }), 'node+python');
    } finally {
      for (const c of [py, go, mixed]) rmSync(c.cellDir, { recursive: true, force: true });
    }
  });

  it('writes the Dockerfile, a source archive without node_modules, and run instructions', () => {
    const { cellDir } = makeCell({ 'package.json': '{"scripts":{"start":"node server.js"}}', 'server.js': 'console.log(1)', 'node_modules/x/index.js': 'big' });
    const outDir = join(cellDir, 'out');
    try {
      const kit = writeCellContainerKit({ cellDir, outDir, materialization: SERVER, env: {} });
      assert.equal(kit.ok, true);
      assert.equal(kit.sourceIncluded, true);
      assert.ok(kit.commands.some((c) => c.includes('{base}source.tar.gz')));
      const listing = spawnSync('tar', ['-tzf', join(outDir, 'source.tar.gz')], { encoding: 'utf8' }).stdout;
      assert.match(listing, /server\.js/);
      assert.doesNotMatch(listing, /node_modules/);
      assert.match(readFileSync(join(outDir, 'README.md'), 'utf8'), /docker run --rm -p 8080:8080 generated-site/);
      assert.ok(existsSync(join(outDir, 'Dockerfile')) && existsSync(join(outDir, 'dockerignore.txt')));
    } finally {
      rmSync(cellDir, { recursive: true, force: true });
    }
  });

  it('withholds the source when the workspace holds a credential from the build machine', () => {
    const secret = 'sk-live-0123456789abcdefXYZ';
    const { cellDir } = makeCell({ 'package.json': '{"scripts":{"start":"node server.js"}}', 'server.js': '', '.env': `OPENAI_API_KEY=${secret}\n` });
    const outDir = join(cellDir, 'out');
    try {
      const kit = writeCellContainerKit({ cellDir, outDir, materialization: SERVER, env: { OPENAI_API_KEY: secret, HOME: '/root' } });
      assert.equal(kit.ok, true);
      assert.equal(kit.sourceIncluded, false);
      assert.match(kit.sourceOmittedReason, /credential/);
      assert.equal(existsSync(join(outDir, 'source.tar.gz')), false);
    } finally {
      rmSync(cellDir, { recursive: true, force: true });
    }
  });

  it('skips static builds', () => {
    const { cellDir } = makeCell({ 'index.html': '<html></html>' });
    try {
      assert.equal(writeCellContainerKit({ cellDir, outDir: join(cellDir, 'out'), materialization: { serverArchitecture: 'static-harness' } }).ok, false);
    } finally {
      rmSync(cellDir, { recursive: true, force: true });
    }
  });
});
