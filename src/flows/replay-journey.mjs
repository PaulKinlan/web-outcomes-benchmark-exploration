import {
  withTimeout,
  dispatchRealClick,
  dispatchRealType,
  dispatchNamedKey,
} from '../benchmarks/cdp-helpers.mjs';
import {
  inspectPageInteractives,
  scrollSelectorIntoCenter,
  executeSemanticStep,
} from './compile-flow.mjs';
import { sleep } from '../util/env.mjs';

/**
 * Replays a compiled flow deterministically using real Chromium Input events,
 * measuring per-step wall-clock latency and state transitions.
 */
export async function replayCompiledJourney(client, compiledFlow, promptEntry) {
  const stepTimings = [];

  for (let idx = 0; idx < (compiledFlow?.steps || []).length; idx++) {
    const compiledStep = compiledFlow.steps[idx];
    const semanticStep = promptEntry?.canonicalJourney?.[idx];
    const t0 = performance.now();
    let executedOps = 0;

    try {
      await withTimeout(
        (async () => {
          if (compiledStep.resolvedOps && compiledStep.resolvedOps.length > 0) {
            for (const op of compiledStep.resolvedOps) {
              if (op.op === 'click') {
                const freshPos = await scrollSelectorIntoCenter(client, op.selector);
                const x = freshPos?.x ?? op.x;
                const y = freshPos?.y ?? op.y;
                await sleep(25);
                await dispatchRealClick(client, x, y);
                executedOps++;
                await sleep(220);
              } else if (op.op === 'type') {
                const freshPos = await scrollSelectorIntoCenter(client, op.selector);
                if (freshPos) {
                  await dispatchRealClick(client, freshPos.x, freshPos.y);
                  await withTimeout(
                    client.Runtime.evaluate({
                      expression: `(() => {
                        const el = document.querySelector(${JSON.stringify(op.selector)});
                        if (el && ('value' in el)) el.value = '';
                      })()`,
                      timeout: 2000,
                    }),
                    2500,
                    'replay clear input'
                  ).catch(() => {});
                  await dispatchRealType(client, op.value);
                  executedOps++;
                  await sleep(160);
                }
              } else if (op.op === 'key') {
                await dispatchNamedKey(client, op.key);
                executedOps++;
                await sleep(100);
              }
            }
          } else if (semanticStep && !compiledStep.timedOut) {
            const fallbackRes = await executeSemanticStep(client, semanticStep);
            executedOps = fallbackRes.resolvedOps.length;
          }

          // Bounded animation-frame settle so presentation completes without hanging if main thread stalls
          await withTimeout(
            client.Runtime.evaluate({
              expression: `new Promise(r => { const t = setTimeout(r, 350); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(t); r(); })); })`,
              awaitPromise: true,
              timeout: 2000,
            }),
            2500,
            'replay rAF settle'
          ).catch(() => {});
        })(),
        8000,
        `replay step "${compiledStep.stepId}"`
      );
    } catch {
      // Continue or finish step timing cleanly even if an event handler blocked
    }

    const stepDurationMs = Math.round(performance.now() - t0);
    stepTimings.push({
      stepId: compiledStep.stepId,
      label: compiledStep.label,
      executedOps,
      durationMs: stepDurationMs,
    });
  }

  return stepTimings;
}

/**
 * Executes one reversible `do -> undo` cycle for MemLab 10x leak testing.
 */
export async function executeReversibleCycle(client, leakLoop) {
  const doStep = {
    id: 'leak-do',
    label: 'Trigger UI state',
    action: 'click',
    patterns: leakLoop?.doPatterns || ['open', 'view', 'details', 'add', 'book', 'forum'],
  };
  await executeSemanticStep(client, doStep);
  await sleep(140);

  // Try Escape key first if a modal/dialog opened, plus undo button patterns
  const state = await inspectPageInteractives(client);
  if (state.hasDialogOpen) {
    await dispatchNamedKey(client, 'Escape');
    await sleep(120);
  }

  const undoStep = {
    id: 'leak-undo',
    label: 'Revert UI state',
    action: 'click',
    patterns: leakLoop?.undoPatterns || ['close', 'cancel', 'back', 'all', '×', '✕'],
  };
  await executeSemanticStep(client, undoStep);
  await sleep(140);
}
