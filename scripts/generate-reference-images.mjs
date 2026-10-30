#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PROJECT_ROOT, loadDotEnv, sleep } from '../src/util/env.mjs';

loadDotEnv();

const MODEL_ID = process.env.REF_IMAGE_MODEL || 'gemini-nano-banana-2.1';
const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const OUT_DIR = join(PROJECT_ROOT, 'assets', 'reference-images');

function parseArgs(argv) {
  const opts = { force: false, prompts: null, concurrency: 4 };
  for (const arg of argv) {
    if (arg === '--force') opts.force = true;
    else if (arg.startsWith('--prompts=')) {
      opts.prompts = arg
        .slice('--prompts='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg.startsWith('--concurrency=')) {
      opts.concurrency = Math.max(1, Math.min(8, Number(arg.slice('--concurrency='.length)) || 4));
    }
  }
  return opts;
}

function hasSips() {
  try {
    execFileSync('sips', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const USE_SIPS = hasSips();

async function generateSingleReferenceImage(promptId, promptTitle, seedEntry) {
  const mockupSpec =
    seedEntry?.layoutMockupPrompt ||
    `Clean flat desktop website UI design mockup (1440x900 viewport, front-facing flat screen capture, no laptop bezel, no 3D tilt) for "${seedEntry?.brandName || promptTitle}".`;

  const fullImagePrompt = [
    mockupSpec,
    `Style rules: Crisp flat front-facing 16:10 desktop web application interface screenshot (no device frame, no browser chrome, no angled 3D mockup, no watermarks).`,
    `Brand & Palette: "${seedEntry?.brandName || promptTitle}" — ${seedEntry?.palette || 'modern editorial palette'}.`,
    `Typography & Hierarchy: Clean editorial typography, clear scannable navigation, generous 8px grid spacing, legible UI labels, realistic numbers and cards.`,
  ].join('\n');

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_ID}:generateContent?key=${encodeURIComponent(API_KEY)}`;

  let lastErr = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: fullImagePrompt }] }],
          generationConfig: {
            responseModalities: ['IMAGE'],
          },
        }),
      });

      if (!resp.ok) {
        const bodyText = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status}: ${bodyText.slice(0, 240)}`);
      }

      const payload = await resp.json();
      const parts = payload?.candidates?.[0]?.content?.parts || [];
      const imgPart = parts.find((p) => p?.inlineData?.data);
      if (!imgPart) {
        throw new Error(`No inlineData image returned (finishReason=${payload?.candidates?.[0]?.finishReason || 'unknown'})`);
      }

      const rawBuf = Buffer.from(imgPart.inlineData.data, 'base64');
      const mime = String(imgPart.inlineData.mimeType || 'image/jpeg').toLowerCase();
      const tmpExt = mime.includes('png') ? 'png' : 'jpg';
      const tmpPath = join(OUT_DIR, `.tmp-${promptId}.${tmpExt}`);
      const finalPath = join(OUT_DIR, `${promptId}.jpg`);

      writeFileSync(tmpPath, rawBuf);
      if (USE_SIPS) {
        try {
          execFileSync(
            'sips',
            ['-Z', '1440', '-s', 'format', 'jpeg', '-s', 'formatOptions', '78', tmpPath, '--out', finalPath],
            { stdio: 'ignore' }
          );
          if (existsSync(tmpPath)) unlinkSync(tmpPath);
        } catch {
          writeFileSync(finalPath, rawBuf);
          if (existsSync(tmpPath)) unlinkSync(tmpPath);
        }
      } else {
        writeFileSync(finalPath, rawBuf);
        if (existsSync(tmpPath) && tmpPath !== finalPath) unlinkSync(tmpPath);
      }

      const sizeKb = Math.round(statSync(finalPath).size / 1024);
      return { promptId, finalPath, sizeKb };
    } catch (err) {
      lastErr = err;
      if (attempt < 4) {
        const delayMs = 2000 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 500);
        console.warn(`  [retry ${attempt}/3] ${promptId}: ${err.message} (waiting ${delayMs}ms)`);
        await sleep(delayMs);
      }
    }
  }
  throw lastErr;
}

async function main() {
  if (!API_KEY) {
    console.error('[generate-refs] Missing GEMINI_API_KEY in environment or .env');
    process.exit(1);
  }

  const opts = parseArgs(process.argv.slice(2));
  mkdirSync(OUT_DIR, { recursive: true });

  const promptsIndex = JSON.parse(readFileSync(join(PROJECT_ROOT, 'prompts', 'index.json'), 'utf8'));
  const seedJson = JSON.parse(readFileSync(join(PROJECT_ROOT, 'prompts', 'seed-data.json'), 'utf8'));
  const seedMap = seedJson.prompts || seedJson;

  let list = promptsIndex.prompts || [];
  if (opts.prompts && opts.prompts.length > 0) {
    const wanted = new Set(opts.prompts);
    list = list.filter((p) => wanted.has(p.id));
  }

  const queue = [];
  let skipped = 0;
  for (const p of list) {
    const targetPath = join(OUT_DIR, `${p.id}.jpg`);
    if (!opts.force && existsSync(targetPath) && statSync(targetPath).size > 10_000) {
      skipped++;
      continue;
    }
    queue.push(p);
  }

  console.log(
    `[generate-refs] Model=${MODEL_ID} | Total=${list.length} | Generating=${queue.length} | Cached=${skipped} | Concurrency=${opts.concurrency}`
  );

  let idx = 0;
  let okCount = 0;
  const failures = [];

  async function worker() {
    while (idx < queue.length) {
      const current = queue[idx++];
      const n = idx;
      const seedEntry = seedMap[current.id] || null;
      const t0 = Date.now();
      try {
        const res = await generateSingleReferenceImage(current.id, current.title, seedEntry);
        okCount++;
        const sec = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`  [${n}/${queue.length}] ✓ ${current.id}.jpg (${res.sizeKb} KB in ${sec}s)`);
      } catch (err) {
        failures.push({ id: current.id, error: err.message });
        console.error(`  [${n}/${queue.length}] ✗ ${current.id}: ${err.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(opts.concurrency, Math.max(1, queue.length)) }, () => worker()));

  console.log(`[generate-refs] Done: ${okCount} generated, ${skipped} cached, ${failures.length} failed.`);
  if (failures.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[generate-refs] Fatal: ${err.message}`);
  process.exit(1);
});
