/** daemon.ts owns the worker-pool callback wiring and is not safe to start in
 * a unit-test process. Pin the synchronous store→fence ordering in source; the
 * store's double-callback result and recovery controller are tested behaviorally
 * in their dedicated suites. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const daemonSource = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');

describe('VC meeting worker-exit recovery wiring', () => {
  it('arms every exact recovery ref in the onWorkerExit callback', () => {
    const start = daemonSource.indexOf('onWorkerExit(ds, context)');
    const end = daemonSource.indexOf('onReceiverResetReady(_ds, context)', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const callback = daemonSource.slice(start, end);

    const reconcile = callback.indexOf('handleVcMeetingWorkerGenerationExit(context');
    const refs = callback.indexOf('for (const ref of result.recoveryRefs)');
    const arm = callback.indexOf('vcMeetingRuntimeLeaseRecovery.arm(ref, cfg.larkAppId)', refs);
    expect(reconcile).toBeGreaterThanOrEqual(0);
    expect(refs).toBeGreaterThan(reconcile);
    expect(arm).toBeGreaterThan(refs);
  });

  it('does not arm teardown from onCliExit, whose managed CLI exit is already authoritative', () => {
    const start = daemonSource.indexOf('onCliExit(ds, context)');
    const end = daemonSource.indexOf('onWorkerExit(ds, context)', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(daemonSource.slice(start, end)).not.toContain('vcMeetingRuntimeLeaseRecovery.arm');
  });

  it('BOTH onCliExit and onWorkerExit converge an incomplete idempotent async turn (managed CLI exit inside a live worker still fires only onCliExit)', () => {
    // codex #776 round-6 finding #1 spans both exit paths: a Node worker death
    // (onWorkerExit) AND a managed CLI exit inside a still-live worker (onCliExit,
    // where onWorkerExit never fires). Both must call the convergence, or the
    // codex-app/persistent-pane path polls `running`/reuses forever.
    const cliStart = daemonSource.indexOf('onCliExit(ds, context)');
    const cliEnd = daemonSource.indexOf('onWorkerExit(ds, context)', cliStart);
    const workerStart = cliEnd;
    const workerEnd = daemonSource.indexOf('onReceiverResetReady(_ds, context)', workerStart);
    expect(daemonSource.slice(cliStart, cliEnd)).toContain('convergeIdempotentAsyncTurnOnWorkerExit(ds, context.workerGeneration)');
    expect(daemonSource.slice(workerStart, workerEnd)).toContain('convergeIdempotentAsyncTurnOnWorkerExit(ds, context.workerGeneration)');
  });
});
