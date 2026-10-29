import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  withIsolatedChrome,
  navigateAndSettle,
  dispatchRealClick,
  dispatchRealType,
  dispatchNamedKey,
} from '../benchmarks/cdp-helpers.mjs';
import { sleep } from '../util/env.mjs';

/**
 * In-page probe function serialized into Runtime.evaluate.
 * Discovers visible interactive elements, accessible names, selectors, and viewport coordinates
 * without mutating application state.
 */
const PAGE_INTERACTIVES_SCRIPT = `(() => {
  function cssPath(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.id && /^[A-Za-z][A-Za-z0-9_-]*$/.test(el.id)) return '#' + CSS.escape(el.id);
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body && parts.length < 5) {
      let tag = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
        if (siblings.length > 1) {
          tag += ':nth-of-type(' + (siblings.indexOf(cur) + 1) + ')';
        }
      }
      parts.unshift(tag);
      cur = parent;
    }
    return parts.join(' > ');
  }

  function isVisible(el) {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 4 && r.height > 4 && r.bottom > 0 && r.right > 0;
  }

  function labelFor(el) {
    const aria = el.getAttribute('aria-label') || '';
    const placeholder = el.getAttribute('placeholder') || '';
    const name = el.getAttribute('name') || '';
    const title = el.getAttribute('title') || '';
    let assocLabel = '';
    if (el.id) {
      const lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lbl) assocLabel = lbl.innerText || lbl.textContent || '';
    }
    if (!assocLabel && el.closest('label')) {
      assocLabel = el.closest('label').innerText || '';
    }
    const text = (el.innerText || el.value || el.textContent || '').trim().slice(0, 140);
    return [text, aria, placeholder, assocLabel, name, title].filter(Boolean).join(' | ').toLowerCase();
  }

  const candidates = Array.from(document.querySelectorAll(
    'button, a[href], input, textarea, select, summary, [role="button"], [role="tab"], [role="link"], [role="menuitem"], [role="checkbox"], [role="option"], [onclick], canvas'
  ));

  const items = [];
  for (const el of candidates) {
    if (!isVisible(el)) continue;
    if (el.disabled) continue;
    // Scroll into view check / coordinates
    const r = el.getBoundingClientRect();
    items.push({
      tag: el.tagName.toLowerCase(),
      type: (el.getAttribute('type') || '').toLowerCase(),
      role: (el.getAttribute('role') || '').toLowerCase(),
      label: labelFor(el),
      selector: cssPath(el),
      inView: r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth,
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      width: Math.round(r.width),
      height: Math.round(r.height),
    });
  }

  return {
    url: location.href,
    title: document.title,
    textSignature: (document.body?.innerText || '').slice(0, 2000).length + ':' + document.querySelectorAll('*').length,
    hasDialogOpen: Boolean(document.querySelector('dialog[open], [role="dialog"], [aria-modal="true"]')),
    items,
  };
})()`;

export async function inspectPageInteractives(client) {
  const { result } = await client.Runtime.evaluate({
    expression: PAGE_INTERACTIVES_SCRIPT,
    returnByValue: true,
  });
  return result?.value || { items: [], textSignature: '0:0' };
}

export async function scrollSelectorIntoCenter(client, selector) {
  if (!selector) return null;
  const { result } = await client.Runtime.evaluate({
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), tag: el.tagName.toLowerCase() };
    })()`,
    returnByValue: true,
  });
  return result?.value || null;
}

function matchBestElement(items, patterns = [], { preferInputs = false, excludeInputs = false } = {}) {
  const normPatterns = patterns.map((p) => String(p).toLowerCase());
  let best = null;
  let bestScore = 0;

  for (const item of items) {
    const isInput = item.tag === 'input' || item.tag === 'textarea' || item.tag === 'select';
    if (preferInputs && !isInput) continue;
    if (excludeInputs && isInput && !['submit', 'button', 'checkbox', 'radio'].includes(item.type)) continue;
    if (item.tag === 'canvas' && !normPatterns.includes('canvas')) continue;

    let score = 0;
    for (let i = 0; i < normPatterns.length; i++) {
      const pat = normPatterns[i];
      if (item.label.includes(pat)) {
        // Earlier patterns carry slightly higher priority
        score += 20 - Math.min(i, 10);
        if (item.label.startsWith(pat)) score += 6;
      }
    }
    if (score > 0) {
      if (item.tag === 'button' || item.role === 'button' || item.type === 'submit') score += 4;
      if (item.inView) score += 2;
      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    }
  }
  return best;
}

/**
 * Executes a single semantic journey step on `client`, returning concrete resolved actions
 * so the compiled flow can be replayed deterministically during INP/LoAF & MemLab benchmarks.
 */
export async function executeSemanticStep(client, step) {
  const before = await inspectPageInteractives(client);
  const ops = [];

  async function clickTarget(target) {
    const pos = (await scrollSelectorIntoCenter(client, target.selector)) || { x: target.x, y: target.y };
    await sleep(40);
    await dispatchRealClick(client, pos.x, pos.y);
    ops.push({ op: 'click', selector: target.selector, label: target.label.slice(0, 80), x: pos.x, y: pos.y });
    await sleep(300);
  }

  async function fillInput(target, value) {
    const pos = (await scrollSelectorIntoCenter(client, target.selector)) || { x: target.x, y: target.y };
    await sleep(30);
    await dispatchRealClick(client, pos.x, pos.y);
    // Clear existing text safely via JS value + input event if needed, then type real keys for INP
    await client.Runtime.evaluate({
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(target.selector)});
        if (el && ('value' in el)) { el.value = ''; }
      })()`,
    });
    await dispatchRealType(client, String(value));
    ops.push({ op: 'type', selector: target.selector, value: String(value) });
    await sleep(180);
  }

  if (step.action === 'click') {
    let target = matchBestElement(before.items, step.patterns || [], { excludeInputs: true });
    if (!target && step.fallbackCanvas) {
      target = before.items.find((i) => i.tag === 'canvas') || before.items[0];
    }
    if (!target) {
      // Fallback to first visible button/tab/link not yet clicked
      target = before.items.find((i) => i.tag === 'button' || i.tag === 'a' || i.role === 'tab');
    }
    if (target) await clickTarget(target);
  } else if (step.action === 'type') {
    let input =
      matchBestElement(before.items, step.inputPatterns || ['search', 'filter'], { preferInputs: true }) ||
      before.items.find((i) => i.tag === 'input' && !['checkbox', 'radio', 'submit', 'button'].includes(i.type));
    if (input) {
      await fillInput(input, step.value || 'test');
      await dispatchNamedKey(client, 'Enter');
      ops.push({ op: 'key', key: 'Enter' });
      await sleep(250);
    }
  } else if (step.action === 'auth') {
    // 1. Check if a one-click Demo Login button is immediately visible
    let demoBtn = matchBestElement(before.items, step.demoPatterns || ['demo', 'guest', 'sample'], { excludeInputs: true });
    if (demoBtn) {
      await clickTarget(demoBtn);
    } else {
      // 2. Click Sign In / Log In trigger if form not yet visible
      const hasPasswordField = before.items.some((i) => i.type === 'password');
      if (!hasPasswordField) {
        const trigger = matchBestElement(before.items, step.triggerPatterns || ['sign in', 'log in', 'login', 'member'], {
          excludeInputs: true,
        });
        if (trigger) await clickTarget(trigger);
      }
      const mid = await inspectPageInteractives(client);
      demoBtn = matchBestElement(mid.items, step.demoPatterns || ['demo', 'guest', 'sample', 'one-click'], {
        excludeInputs: true,
      });
      if (demoBtn) {
        await clickTarget(demoBtn);
      } else {
        const creds = step.credentials || { email: 'demo@example.com', password: 'Password123!' };
        const emailField =
          matchBestElement(mid.items, ['email', 'user', 'login'], { preferInputs: true }) ||
          mid.items.find((i) => i.tag === 'input' && ['email', 'text', ''].includes(i.type));
        const passField =
          mid.items.find((i) => i.type === 'password') ||
          matchBestElement(mid.items, ['password', 'pass'], { preferInputs: true });
        if (emailField) await fillInput(emailField, creds.email);
        if (passField) await fillInput(passField, creds.password);
        const submitBtn =
          matchBestElement(mid.items, ['sign in', 'log in', 'login', 'continue', 'submit', 'unlock', 'enter'], {
            excludeInputs: true,
          }) || mid.items.find((i) => i.type === 'submit' || i.tag === 'button');
        if (submitBtn) await clickTarget(submitBtn);
      }
    }
  } else if (step.action === 'form-submit') {
    const fields = step.fields || {};
    let state = before;
    for (const [fieldKey, val] of Object.entries(fields)) {
      const fieldTarget =
        matchBestElement(state.items, [fieldKey], { preferInputs: true }) ||
        state.items.find(
          (i) =>
            (i.tag === 'input' || i.tag === 'textarea') &&
            !['checkbox', 'radio', 'submit', 'button', 'range', 'color'].includes(i.type) &&
            !ops.some((o) => o.selector === i.selector)
        );
      if (fieldTarget) {
        await fillInput(fieldTarget, val);
      }
    }
    state = await inspectPageInteractives(client);
    const submitBtn =
      matchBestElement(state.items, step.submitPatterns || ['submit', 'save', 'confirm', 'send', 'post'], {
        excludeInputs: true,
      }) || state.items.find((i) => i.type === 'submit');
    if (submitBtn) await clickTarget(submitBtn);
  } else if (step.action === 'quiz') {
    const openBtn = matchBestElement(before.items, step.openPatterns || ['quiz', 'practice', 'test'], {
      excludeInputs: true,
    });
    if (openBtn) await clickTarget(openBtn);
    const mid = await inspectPageInteractives(client);
    const radioOrOption =
      mid.items.find((i) => i.type === 'radio' || i.role === 'radio' || i.role === 'option') ||
      mid.items.find((i) => i.tag === 'button' && !/back|close|home/i.test(i.label));
    if (radioOrOption) await clickTarget(radioOrOption);
    const submitQuiz = matchBestElement(mid.items, step.submitPatterns || ['submit', 'check', 'grade'], {
      excludeInputs: true,
    });
    if (submitQuiz) await clickTarget(submitQuiz);
  } else if (step.action === 'canvas-click') {
    const canvas = before.items.find((i) => i.tag === 'canvas') || {
      selector: 'canvas',
      x: 520,
      y: 420,
      width: 300,
      height: 300,
    };
    const count = step.clicks || 3;
    for (let k = 0; k < count; k++) {
      const dx = (k - 1) * 28;
      const dy = (k % 2 === 0 ? 1 : -1) * 22;
      await dispatchRealClick(client, canvas.x + dx, canvas.y + dy);
      ops.push({ op: 'click', selector: canvas.selector || 'canvas', x: canvas.x + dx, y: canvas.y + dy });
      await sleep(120);
    }
  } else if (step.action === 'keys' || step.action === 'keys-or-click') {
    for (const k of step.keys || []) {
      await dispatchNamedKey(client, k);
      ops.push({ op: 'key', key: k });
      await sleep(90);
    }
    if (step.action === 'keys-or-click' && step.patterns) {
      const afterKey = await inspectPageInteractives(client);
      const btn = matchBestElement(afterKey.items, step.patterns, { excludeInputs: true });
      if (btn) await clickTarget(btn);
    }
  }

  await sleep(220);
  const after = await inspectPageInteractives(client);
  const mutated =
    ops.length > 0 &&
    (after.textSignature !== before.textSignature ||
      after.url !== before.url ||
      after.hasDialogOpen !== before.hasDialogOpen ||
      step.action === 'canvas-click' ||
      step.action === 'keys');

  return {
    stepId: step.id,
    label: step.label,
    action: step.action,
    resolvedOps: ops,
    mutated,
    succeeded: ops.length > 0,
  };
}

/**
 * Runs a pre-benchmark Flow Compilation pass in an isolated browser so both:
 *  - `deep-perf.bench.mjs` (for W3C INP + LoAF + step latency)
 *  - `memory.bench.mjs` (for 10x MemLab repeat/revert leak detection)
 *  - `web-uplift` (via flow definition)
 * have a verified, deterministic multi-step interaction plan.
 */
export async function compileCanonicalFlow({ url, promptEntry, cellDir, config }) {
  const compiled = await withIsolatedChrome(
    { viewport: config.browser.viewportDesktop },
    async ({ client }) => {
      await navigateAndSettle(client, url, config.browser.settleWaitMs || 1200);
      const initialSurface = await inspectPageInteractives(client);
      const stepResults = [];

      for (const step of promptEntry.canonicalJourney || []) {
        const res = await executeSemanticStep(client, step);
        stepResults.push(res);
      }

      const completedSteps = stepResults.filter((s) => s.succeeded).length;
      const mutatedSteps = stepResults.filter((s) => s.mutated).length;
      const totalSteps = stepResults.length || 1;

      return {
        promptId: promptEntry.id,
        category: promptEntry.category,
        compiledAt: new Date().toISOString(),
        initialInteractiveCount: initialSurface.items.length,
        totalSteps: stepResults.length,
        resolvedSteps: completedSteps,
        mutatedSteps,
        flowCompletionPct: Math.round(((completedSteps * 0.5 + mutatedSteps * 0.5) / totalSteps) * 100),
        steps: stepResults,
        leakLoop: promptEntry.leakLoop || null,
      };
    }
  );

  mkdirSync(cellDir, { recursive: true });
  const flowPath = join(cellDir, 'compiled-flow.json');
  writeFileSync(flowPath, JSON.stringify(compiled, null, 2) + '\n', 'utf8');
  return { flowPath, compiled };
}
