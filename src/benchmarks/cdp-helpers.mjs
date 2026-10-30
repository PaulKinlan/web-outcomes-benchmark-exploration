import * as chromeLauncher from 'chrome-launcher';
import CDP from 'chrome-remote-interface';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PROJECT_ROOT, sleep } from '../util/env.mjs';

export const PINNED_CHROME_POINTER = join(PROJECT_ROOT, '.browsers', 'chrome-path.txt');

export function resolveStableChromePath() {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  if (existsSync(PINNED_CHROME_POINTER)) {
    const pinned = readFileSync(PINNED_CHROME_POINTER, 'utf8').trim();
    if (pinned && existsSync(pinned)) return pinned;
  }
  const installs = chromeLauncher.Launcher.getInstallations();
  return installs.find((p) => !p.includes('Canary')) || installs[0] || undefined;
}

export function withTimeout(promise, timeoutMs, label = 'CDP operation') {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    Promise.resolve(promise).then(
      (val) => {
        clearTimeout(timer);
        resolvePromise(val);
      },
      (err) => {
        clearTimeout(timer);
        rejectPromise(err);
      }
    );
  });
}

const ACTIVE_BROWSERS = new Set();

export function forceKillChromeInstance(chrome) {
  if (!chrome) return;
  const pid = chrome.pid || chrome.process?.pid;
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // not a process group leader
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already exited
  }
}

async function cleanupBrowserRecord(record) {
  if (!record || record.cleaned) return;
  record.cleaned = true;
  ACTIVE_BROWSERS.delete(record);

  const { client, chrome } = record;
  if (client) {
    try {
      client._ws?.terminate?.();
    } catch {
      // ignore
    }
    await withTimeout(client.close(), 1200, 'CDP client.close').catch(() => {});
  }
  if (chrome) {
    await withTimeout(chrome.kill(), 2000, 'chrome.kill').catch(() => {});
    forceKillChromeInstance(chrome);
  }
}

export async function killAllActiveChromes() {
  const pending = Array.from(ACTIVE_BROWSERS);
  await Promise.allSettled(pending.map((rec) => cleanupBrowserRecord(rec)));
}

const HEADLESS_DIALOG_GUARD_SCRIPT = `(() => {
  try {
    window.print = function () {};
    window.alert = function () {};
    window.confirm = function () { return true; };
    window.prompt = function (_msg, defaultVal) { return defaultVal || 'Sample Item'; };
    window.onbeforeunload = null;
    if (typeof HTMLInputElement !== 'undefined' && HTMLInputElement.prototype.click) {
      const origClick = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function (...args) {
        if (String(this.type || '').toLowerCase() === 'file') return;
        return origClick.apply(this, args);
      };
    }
    if (typeof window.showOpenFilePicker === 'function') {
      window.showOpenFilePicker = async function () { return []; };
    }
    if (typeof window.showSaveFilePicker === 'function') {
      window.showSaveFilePicker = async function () { throw new DOMException('Aborted', 'AbortError'); };
    }
  } catch {}
})();`;

export async function withIsolatedChrome(options = {}, fn) {
  const {
    headless = true,
    viewport = { width: 1440, height: 900, mobile: false, deviceScaleFactor: 1 },
    timeoutMs = 65000,
    label = 'withIsolatedChrome',
  } = options;

  const chromeFlags = [
    ...(headless ? ['--headless=new'] : []),
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-popup-blocking',
    '--disable-print-preview',
    '--disable-hang-monitor',
    '--disable-prompt-on-repost',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--enable-precise-memory-info',
    '--js-flags=--expose-gc',
    `--window-size=${viewport.width},${viewport.height}`,
  ];

  if (process.env.WEB_UPLIFT_NO_SANDBOX === '1' || (typeof process.getuid === 'function' && process.getuid() === 0)) {
    chromeFlags.push('--no-sandbox');
  }

  const chrome = await withTimeout(
    chromeLauncher.launch({
      chromePath: resolveStableChromePath(),
      chromeFlags,
      logLevel: 'silent',
    }),
    25000,
    `${label}: chromeLauncher.launch`
  );

  const record = { chrome, client: null, cleaned: false };
  ACTIVE_BROWSERS.add(record);

  try {
    const client = await withTimeout(CDP({ port: chrome.port }), 10000, `${label}: CDP connect`);
    record.client = client;

    const { Page, Runtime, DOM, Network, Emulation, Performance } = client;
    await withTimeout(
      Promise.all([
        Page.enable(),
        Runtime.enable(),
        DOM.enable(),
        Network.enable(),
        Performance.enable(),
      ]),
      10000,
      `${label}: CDP domain enable`
    );

    // Auto-dismiss any native browser dialogs (alert / confirm / prompt / beforeunload)
    // and intercept native OS file choosers so generated apps never block headless Chrome!
    Page.javascriptDialogOpening(({ type, defaultPrompt }) => {
      Page.handleJavaScriptDialog({
        accept: true,
        promptText: type === 'prompt' ? defaultPrompt || 'Sample Item' : undefined,
      }).catch(() => {});
    });
    Page.setInterceptFileChooserDialog?.({ enabled: true }).catch(() => {});

    await withTimeout(
      Page.addScriptToEvaluateOnNewDocument({ source: HEADLESS_DIALOG_GUARD_SCRIPT }),
      5000,
      `${label}: dialog guard init`
    ).catch(() => {});

    await withTimeout(
      Emulation.setDeviceMetricsOverride({
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: viewport.deviceScaleFactor || (viewport.mobile ? 2 : 1),
        mobile: Boolean(viewport.mobile),
      }),
      5000,
      `${label}: setDeviceMetricsOverride`
    );

    return await withTimeout(fn({ chrome, client, port: chrome.port }), timeoutMs, label);
  } finally {
    await cleanupBrowserRecord(record);
  }
}

export async function applyDesktopBroadbandShaping(client, throttleConfig) {
  const { Emulation, Network } = client;
  const cpu = throttleConfig?.cpuSlowdownMultiplier || 1;
  const latency = throttleConfig?.latencyMs ?? 28;
  const downBytesPerSec = ((throttleConfig?.downloadThroughputKbps || 20480) * 1024) / 8;
  const upBytesPerSec = ((throttleConfig?.uploadThroughputKbps || 8192) * 1024) / 8;

  if (cpu > 1) {
    await Emulation.setCPUThrottlingRate({ rate: cpu });
  }
  await Network.emulateNetworkConditions({
    offline: false,
    latency,
    downloadThroughput: downBytesPerSec,
    uploadThroughput: upBytesPerSec,
  });
}

export async function applyMobileThrottling(client, throttleConfig) {
  const { Emulation, Network } = client;
  const cpu = throttleConfig?.cpuSlowdownMultiplier || 4;
  const latency = throttleConfig?.latencyMs ?? 150;
  const downBytesPerSec = ((throttleConfig?.downloadThroughputKbps || 1638.4) * 1024) / 8;
  const upBytesPerSec = ((throttleConfig?.uploadThroughputKbps || 750) * 1024) / 8;

  await Emulation.setCPUThrottlingRate({ rate: cpu });
  await Network.emulateNetworkConditions({
    offline: false,
    latency,
    downloadThroughput: downBytesPerSec,
    uploadThroughput: upBytesPerSec,
  });
}

export async function navigateAndSettle(client, url, settleMs = 1000, timeoutMs = 10000) {
  const { Page } = client;
  let onLoad = null;
  const loadPromise = new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (onLoad) client.removeListener?.('Page.loadEventFired', onLoad);
      resolve();
    }, timeoutMs);
    onLoad = () => {
      clearTimeout(timer);
      if (onLoad) client.removeListener?.('Page.loadEventFired', onLoad);
      resolve();
    };
    Page.loadEventFired(onLoad);
  });

  await withTimeout(Page.navigate({ url }), timeoutMs, 'Page.navigate').catch(() => {});
  await loadPromise;
  if (settleMs > 0) await sleep(settleMs);
}

export async function capturePngScreenshot(client, outPath, { fullPage = false } = {}) {
  mkdirSync(dirname(outPath), { recursive: true });
  const { Page } = client;
  let clip;
  if (fullPage) {
    const metrics = await withTimeout(Page.getLayoutMetrics(), 6000, 'Page.getLayoutMetrics');
    const content = metrics.cssContentSize || metrics.contentSize;
    if (content) {
      clip = {
        x: 0,
        y: 0,
        width: Math.min(content.width, 1920),
        height: Math.min(content.height, 4000),
        scale: 1,
      };
    }
  }
  const { data } = await withTimeout(
    Page.captureScreenshot({
      format: 'png',
      ...(clip ? { clip } : {}),
    }),
    10000,
    'Page.captureScreenshot'
  );
  writeFileSync(outPath, Buffer.from(data, 'base64'));
  return outPath;
}

export async function dispatchRealClick(client, x, y) {
  const { Input } = client;
  await withTimeout(
    Input.dispatchMouseEvent({
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
    }),
    3500,
    'Input.dispatchMouseEvent(mouseMoved)'
  );
  await withTimeout(
    Input.dispatchMouseEvent({
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    }),
    3500,
    'Input.dispatchMouseEvent(mousePressed)'
  );
  await sleep(25);
  await withTimeout(
    Input.dispatchMouseEvent({
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    }),
    3500,
    'Input.dispatchMouseEvent(mouseReleased)'
  );
}

export async function dispatchRealType(client, text) {
  const { Input } = client;
  for (const ch of String(text)) {
    await withTimeout(
      Input.dispatchKeyEvent({
        type: 'keyDown',
        text: ch,
        unmodifiedText: ch,
        key: ch,
      }),
      3000,
      'Input.dispatchKeyEvent(keyDown)'
    );
    await withTimeout(
      Input.dispatchKeyEvent({
        type: 'keyUp',
        key: ch,
      }),
      3000,
      'Input.dispatchKeyEvent(keyUp)'
    );
    await sleep(12);
  }
}

export async function dispatchNamedKey(client, keyName) {
  const { Input } = client;
  const KEY_DEFS = {
    Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
    Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
    Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32 },
    Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
    KeyW: { key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 },
    KeyA: { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 },
    KeyS: { key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 },
    KeyD: { key: 'd', code: 'KeyD', windowsVirtualKeyCode: 68 },
    Digit1: { key: '1', code: 'Digit1', windowsVirtualKeyCode: 49 },
    Digit2: { key: '2', code: 'Digit2', windowsVirtualKeyCode: 50 },
    Digit3: { key: '3', code: 'Digit3', windowsVirtualKeyCode: 51 },
  };
  const def = KEY_DEFS[keyName] || { key: keyName, code: keyName, windowsVirtualKeyCode: 0 };
  await withTimeout(Input.dispatchKeyEvent({ type: 'rawKeyDown', ...def }), 3000, 'Input.dispatchKeyEvent(rawKeyDown)');
  await sleep(30);
  await withTimeout(Input.dispatchKeyEvent({ type: 'keyUp', ...def }), 3000, 'Input.dispatchKeyEvent(keyUp)');
}
