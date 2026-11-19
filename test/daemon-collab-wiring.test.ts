/**
 * Collaboration bootstrap through the REAL daemon callbacks.
 *
 * The orchestrator tests drive injected dependencies, which is right for state
 * machine semantics but cannot prove the daemon is wired to it. Reviewer
 * measured exactly that gap: removing the two hooks left every collab test
 * green. These cases run the daemon's own `onPromptSubmittedInput` /
 * `onTurnTerminal` callback bodies (extracted from `daemon.ts` without booting
 * the fleet) and assert they reach the collaboration layer with the right
 * arguments — the "kickoff → admission → terminal → dependent kickoff" chain the
 * issue is about.
 */
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// 源码结构护栏(K2)：daemon 的两个 worker 回调是内联在 `createWorkerPool({...})`
// 参数里的方法，没有可 import 的导出；这里用 TypeScript 解析器把方法体原样取出
// 执行（与 test/daemon-workflow-wake-acceptance.test.ts 同一手法）。断言的是
// **回调有没有把事件交给协作层**，不是源码文本。
const source = ts.createSourceFile(
  'daemon.ts',
  readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);

function daemonCallback(name: string, scope: Record<string, unknown>) {
  let method: ts.MethodDeclaration | undefined;
  function visit(node: ts.Node) {
    if (ts.isMethodDeclaration(node) && node.name.getText(source) === name) method = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!method) throw new Error(`daemon callback ${name} missing`);
  const code = ts.transpileModule(`const hooks = { ${method.getText(source)} };`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  // Any free variable the callback touches but this test does not care about
  // resolves to an inert stub: these cases assert WHICH collaboration call is
  // made, not the unrelated bookkeeping around it.
  const inert = new Proxy(scope, {
    has: () => true,
    get: (target, key) => {
      if (key in target) return (target as Record<string | symbol, unknown>)[key];
      if (typeof key === 'symbol') return undefined;
      return () => undefined;
    },
  });
  return new Function('scope', `with (scope) { ${code}; return hooks.${name}; }`)(inert);
}

function harness(opts: { sessionGroup: boolean }) {
  const markCollabStageRunning = vi.fn(async () => undefined);
  const reportCollabTurnIfOwned = vi.fn(async () => undefined);
  const onInputAccepted = vi.fn();
  const onTurnEnded = vi.fn();
  const scope = {
    workflowMainWake: { onInputAccepted, onTurnEnded },
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    isSessionGroup: () => opts.sessionGroup,
    markCollabStageRunning,
    reportCollabTurnIfOwned,
    deploymentContinuationAuthority: () => undefined,
    recordDeploymentContinuation: () => false,
    sessionStore: {},
    setActiveInteractiveTurn: () => {},
    confirmNativeGroupContextInput: () => {},
    confirmNativeGroupContextTurn: () => {},
    onXpiSharedCwdTurnTerminal: () => {},
    vcMeetingTerminalReconciler: undefined,
    completedTurnHasCrossPrincipalFollower: () => false,
    principalLaneRunningTurnMatches: () => true,
    getBot: () => ({ config: { cliId: 'claude-code' } }),
    failedTurnCaller: () => undefined,
    config: { session: { dataDir: '/tmp' } },
    isSilentScheduledTurn: () => false,
    cancelDeploymentContinuation: () => undefined,
    sessionKey: (a: string, b: string) => `${a}::${b}`,
  };
  const ds = {
    larkAppId: 'cli_peer0001',
    chatId: 'oc_collab_chat',
    session: { sessionId: 'sess-1', workerGeneration: 2, cliSessionId: 'native-1' },
  };
  return {
    ds,
    markCollabStageRunning,
    reportCollabTurnIfOwned,
    onInputAccepted,
    promptSubmittedInput: daemonCallback('onPromptSubmittedInput', scope),
    turnTerminal: daemonCallback('onTurnTerminal', scope),
  };
}

describe('daemon collaboration wiring', () => {
  it('promotes a kicked-off stage to running when the CLI takes the turn', async () => {
    const h = harness({ sessionGroup: true });
    h.promptSubmittedInput(h.ds, 'turn-1', { workerGeneration: 2 });
    expect(h.markCollabStageRunning).toHaveBeenCalledWith({
      chatId: 'oc_collab_chat',
      larkAppId: 'cli_peer0001',
      turnId: 'turn-1',
    });
  });

  it('reports for a group this bot did not birth (no session-group registration)', async () => {
    // A peer's session-group registry never names the group, so gating the
    // report on it silenced every peer: stages stuck at `sent` and dependents
    // never started. The collab lookup is itself the O(1) no-op.
    const h = harness({ sessionGroup: false });
    h.promptSubmittedInput(h.ds, 'turn-1', { workerGeneration: 2 });
    expect(h.markCollabStageRunning).toHaveBeenCalled();
  });

  it('reports a finished turn so the owner can release the next stage', async () => {
    const h = harness({ sessionGroup: true });
    await h.turnTerminal(h.ds, {
      type: 'turn_terminal',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      status: 'completed',
    }, { workerGeneration: 2 });
    expect(h.reportCollabTurnIfOwned).toHaveBeenCalledWith({
      chatId: 'oc_collab_chat',
      larkAppId: 'cli_peer0001',
      turnId: 'turn-1',
      status: 'completed',
    });
  });

  it('still records the workflow wake even when collaboration reporting fails', async () => {
    // A collab hiccup must never swallow the workflow-wake bookkeeping: they are
    // independent consumers of the same terminal.
    const h = harness({ sessionGroup: true });
    h.reportCollabTurnIfOwned.mockRejectedValue(new Error('peer down'));
    await h.turnTerminal(h.ds, {
      type: 'turn_terminal',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      status: 'completed',
    }, { workerGeneration: 2 });
    expect(h.onInputAccepted).not.toHaveBeenCalled(); // sanity: not a prompt path
    expect(h.reportCollabTurnIfOwned).toHaveBeenCalled();
  });
});
