# Web Generation & Performance Benchmark (`performance-benchmark`)

Evaluates modern LLMs across **10 real-world website categories (37 multi-flow functional prompts)** without hinting at speed, accessibility, memory, or technology stack — comparing **autonomous `pi` agentic web development (`--mode=agent`, building multi-route full-stack websites with real `$PORT` HTTP servers and stored `pi` session transcripts)** side-by-side against **1-shot stream generation (`--mode=oneshot`)**.

## Dual-Track Generation Modes

1. **Autonomous `pi` Agent Loop + Real `$PORT` Server (`--mode=agent`, Default)**:
   - Runs `pi` autonomously with thinking + `read`/`bash`/`edit`/`write` tools in an isolated `agent-workspace/` driven solely by the neutral user prompt plus a language-neutral PaaS runtime handoff (`.bench-runtime.json` with `{ "buildCommand", "startCommand", "healthPath" }` or `./start.sh` binding `$PORT` on `127.0.0.1`).
   - Archives the complete `pi` v3 session (`pi-session.jsonl`), self-contained interactive HTML transcript (`pi-transcript.html`), and parsed engineering habits (`trajectory.json`: turns, thinking volume, scaffolding tools, whether the agent self-tested its server via `curl`, and whether it *spontaneously* configured compression/caching/CWV without being asked).
2. **Single-Shot Stream (`--mode=oneshot`)**:
   - Calls `@earendil-works/pi-ai` `streamSimple` in a single pass with zero tool loop for controlled `Agent vs. 1-Shot` comparison (`--mode=both` runs both tracks on the exact same slice).

## 4 Benchmark Pillars

1. **Default Tech-Stack & Full-Stack Telemetry (`tech-stack`)**: Static + runtime detection of UI frameworks (`React`, `Vanilla`, `Vue`, `Svelte`, `Three.js`, etc.), backend servers (`Express`, `Fastify`, `Hono`, `Next.js`, `Node http`, `FastAPI`/`Flask`, `Go`), persistence stores (`SQLite`, `Prisma`/`Drizzle`, `IndexedDB`, `localStorage`), delivery patterns, and runtime console/page errors.
2. **Lighthouse + `web-uplift` Audit (`lighthouse-uplift`)**: Programmatic Mobile & Desktop Lighthouse paired with [`paulkinlan/web-uplift`](https://github.com/PaulKinlan/web-uplift) across all 6 owner outcomes (*Speed & Stability, Memory Health, Usability & UX, Inclusivity & Reach, Discoverability & AI, Trust & Resilience*).
3. **Deep Performance, WAN Shaping & Server Telemetry (`deep-perf`)**:
   - **Production Server Probe**: `coldBootMs`, OS process-group `serverRssMb` (idle & under load), `singleTtfbMs`, 10-request concurrent `burstP95TtfbMs`, `Content-Encoding` (`br`/`gzip`/`none`), `Cache-Control`, and `ssrWordCount`.
   - **Realistic WAN + CPU Shaping**: Desktop Broadband (`28ms` RTT, `20 Mbps` down / `8 Mbps` up) and Mobile Slow-4G (`150ms` RTT, `1.6 Mbps` down, `4×` CPU), plus **Consistent Multi-Step User Journey Replay** capturing **W3C INP** (`inputDelay + processingDuration + presentationDelay`), **Long Animation Frames (LoAF)**, `/api` waterfalls, and unused JS/CSS bytes.
4. **Memory Usage & Leak Detection (`memory`)**: Idle heap/DOM/listener drift (`0s → 3s → 10s`) plus V8 `.heapsnapshot` detached DOM (`detachedness === 2`) diffing and **`memlab`** 3-snapshot leak cluster analysis over **10× repeat/revert cycles**.

## Quick Start

```sh
npm install

# Validate zero-bias prompt & contract neutrality, journeys, and model registry
npm run validate
npm test

# Sync live provider + OpenRouter model catalogs
npm run sync:models

# Run an autonomous pi Agent full-stack benchmark slice (default --mode=agent)
npm run bench -- --mode=agent --models=gemini-3-8-flash,deepseek-flash --prompts=plumbing-appointment

# Run both Agent Loop and 1-Shot tracks head-to-head
npm run bench -- --mode=both --models=gemini-3-8-flash --prompts=plumbing-appointment

# Launch the interactive Studio with live $PORT server preview & pi transcript viewer (http://127.0.0.1:4321)
npm run studio

# Export a standalone static report site to dist-report/
npm run export
```
