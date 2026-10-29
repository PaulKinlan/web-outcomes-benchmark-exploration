import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractGeneratedFiles } from '../src/materialize/extract-files.mjs';
import { materializeSite } from '../src/materialize/build-site.mjs';
import { analyzeStaticSource } from '../src/benchmarks/tech-stack.bench.mjs';

test('extractGeneratedFiles + materializeSite + analyzeStaticSource handle vanilla single-HTML and multi-file static', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bench-mat-vanilla-'));
  try {
    const cell1 = join(root, 'cell-single');
    const rawSingle = [
      '```html',
      '<!doctype html><html><head><title>Coffee</title></head><body><dialog id="d"><button popovertarget="p">Close</button></dialog><script>localStorage.setItem("k","1");</script></body></html>',
      '```',
    ].join('\n');

    const ext1 = extractGeneratedFiles({ cellDir: cell1, rawMarkdown: rawSingle });
    assert.equal(ext1.outputShape, 'single-html');
    const mat1 = await materializeSite({ cellDir: cell1, extraction: ext1 });
    assert.equal(mat1.ok, true);
    assert.equal(mat1.materializeTier, 'native-static');
    assert.equal(mat1.runnableWithoutBuildStep, true);

    const static1 = analyzeStaticSource({ files: ext1.files, materialization: mat1 });
    assert.equal(static1.primaryFramework, 'vanilla');
    assert.equal(static1.deliveryPattern, 'zero-dep-vanilla');
    assert.equal(static1.modernWebFeatures.nativeDialog, true);
    assert.ok(static1.persistenceApis.includes('localStorage'));

    // Multi-file static without explicit <link>/<script> tags gets gently wired
    const cell2 = join(root, 'cell-multi');
    const rawMulti = [
      '```html index.html',
      '<!doctype html><html><head><title>Multi</title></head><body><h1>Hello</h1></body></html>',
      '```',
      '```css styles.css',
      'body { background: #fafafa; }',
      '```',
      '```js app.js',
      'console.log("loaded");',
      '```',
    ].join('\n');

    const ext2 = extractGeneratedFiles({ cellDir: cell2, rawMarkdown: rawMulti });
    assert.equal(ext2.outputShape, 'multi-file-static');
    const mat2 = await materializeSite({ cellDir: cell2, extraction: ext2 });
    assert.equal(mat2.ok, true);
    const builtHtml = readFileSync(join(mat2.distDir, 'index.html'), 'utf8');
    assert.ok(builtHtml.includes('styles.css'));
    assert.ok(builtHtml.includes('app.js'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('detects in-browser Babel JSX + Tailwind CDN and synthesizes Vite bundle for bare React JSX components', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bench-mat-react-'));
  try {
    // Case A: Single HTML using React UMD + @babel/standalone + Tailwind Play CDN
    const cellBabel = join(root, 'cell-babel');
    const rawBabel = [
      '```html',
      '<!doctype html><html><head>',
      '<script src="https://cdn.tailwindcss.com"></script>',
      '<script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>',
      '<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>',
      '</head><body><div id="root"></div><script type="text/babel">function App(){return <div className="flex bg-slate-900 px-4 rounded-lg">Hi</div>}</script></body></html>',
      '```',
    ].join('\n');
    const extBabel = extractGeneratedFiles({ cellDir: cellBabel, rawMarkdown: rawBabel });
    const matBabel = await materializeSite({ cellDir: cellBabel, extraction: extBabel });
    const staticBabel = analyzeStaticSource({ files: extBabel.files, materialization: matBabel });
    assert.equal(staticBabel.primaryFramework, 'react');
    assert.equal(staticBabel.primaryCss, 'tailwind-cdn');
    assert.equal(staticBabel.deliveryPattern, 'in-browser-babel-jsx');

    // Case B: Bare App.jsx emitted without index.html or package.json -> Tier 3 synthesized Vite bundler
    const cellBare = join(root, 'cell-bare-jsx');
    const rawBare = [
      '```jsx src/App.jsx',
      'import React, { useState } from "react";',
      'export default function App() {',
      '  const [count, setCount] = useState(0);',
      '  return <main className="flex px-6 py-4 bg-indigo-600 rounded-xl"><button onClick={() => setCount(c => c + 1)}>Count: {count}</button></main>;',
      '}',
      '```',
    ].join('\n');
    const extBare = extractGeneratedFiles({ cellDir: cellBare, rawMarkdown: rawBare });
    assert.equal(extBare.outputShape, 'bare-component');
    const matBare = await materializeSite({ cellDir: cellBare, extraction: extBare });
    assert.equal(matBare.ok, true, `Bare JSX build failed: ${matBare.error}`);
    assert.equal(matBare.materializeTier, 'synthesized-bundler');
    assert.equal(matBare.runnableWithoutBuildStep, false);
    assert.equal(matBare.synthesizedWrapper, true);
    assert.ok(existsSync(join(matBare.distDir, 'index.html')));

    const staticBare = analyzeStaticSource({ files: extBare.files, materialization: matBare });
    assert.equal(staticBare.primaryFramework, 'react');
    assert.equal(staticBare.deliveryPattern, 'bare-component-synthesized');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('extractGeneratedFiles recovers unclosed trailing fences, strips DSML leaks, reads preceding text-fence filenames, and rewrites root-relative assets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bench-mat-edgecases-'));
  try {
    // 1. Unclosed trailing CSS fence + DSML leak + root-relative `/styles.css` in index.html
    const cellUnclosed = join(root, 'cell-unclosed');
    const rawUnclosed = [
      '```html',
      '<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head><body><h1>Plumbing</h1></body></html>',
      '```',
      '```css',
      ':root { --blue: #0b5c8a; }',
      'body { background: var(--blue); color: #fff; }',
      '</｜｜DSML｜｜ parameter>',
      '</｜｜DSML｜｜ invoke>',
    ].join('\n');

    const extUnclosed = extractGeneratedFiles({ cellDir: cellUnclosed, rawMarkdown: rawUnclosed });
    assert.deepEqual(
      extUnclosed.files.map((f) => f.path),
      ['index.html', 'styles.css']
    );
    assert.ok(!extUnclosed.files[1].content.includes('DSML'));
    const matUnclosed = await materializeSite({ cellDir: cellUnclosed, extraction: extUnclosed });
    assert.equal(matUnclosed.ok, true);
    const rewrittenHtml = readFileSync(join(matUnclosed.distDir, 'index.html'), 'utf8');
    assert.ok(rewrittenHtml.includes('href="./styles.css"'), `Expected relative ./styles.css, got: ${rewrittenHtml}`);

    // 2. Preceding ```text\npath/to/file\n``` filename labels + Express fullstack-workspace classification
    const cellLabeled = join(root, 'cell-labeled');
    const rawLabeled = [
      '```text',
      'package.json',
      '```',
      '```json',
      '{"name":"demo","scripts":{"start":"node server.js"},"dependencies":{"express":"^4.19.2"}}',
      '```',
      '```text',
      'server.js',
      '```',
      '```javascript',
      'const express = require("express"); const app = express(); app.listen(process.env.PORT || 3000);',
      '```',
      '```text',
      'views/index.ejs',
      '```',
      '```html',
      '<h1>Hello <%= title %></h1>',
      '```',
    ].join('\n');

    const extLabeled = extractGeneratedFiles({ cellDir: cellLabeled, rawMarkdown: rawLabeled });
    assert.deepEqual(
      extLabeled.files.map((f) => f.path),
      ['package.json', 'server.js', 'views/index.ejs']
    );
    assert.equal(extLabeled.outputShape, 'fullstack-workspace');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
