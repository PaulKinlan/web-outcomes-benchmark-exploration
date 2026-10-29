import {
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
            await client.Runtime.evaluate({
              expression: `(() => {
                const el = document.querySelector(${JSON.stringify(op.selector)});
                if (el && ('value' in el)) el.value = '';
              })()`,
            });
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
    } else if (semanticStep) {
      const fallbackRes = await executeSemanticStep(client, semanticStep);
      executedOps = fallbackRes.resolvedOps.length;
    }

    // Wait for next animation frame so presentation completes inside step window
    await client.Runtime.evaluate({
      expression: `new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`,
      awaitPromise: true,
    });

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
