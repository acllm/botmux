/**
 * End-to-end idempotency tests that drive the REAL triggerSessionTurn dispatch
 * path (not just the extracted helpers) for a fresh async virtual trigger, using
 * the REAL idempotency-store + async-trigger-store (temp SESSION_DATA_DIR).
 * Boundaries (lark client / session-store / worker-pool) are mocked so we can
 * make forkWorker throw and assert the barrier / fork-fault convergence codex
 * asked for: a synchronous dispatch throw must record a durable failed
 * (dispatch_unknown), close, and NOT leave the caller polling `running`; a
 * same-key retry must reuse (never double-fork).
 *
 * Run:  pnpm vitest run test/trigger-session-idempotency-e2e.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TriggerRequest } from '../src/services/trigger-types.js';

let tempDir: string;
let prevDataDir: string | undefined;

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Lark client — no real chat for a fresh async virtual trigger, but imported.
vi.mock('../src/im/lark/client.js', () => ({
  getMessageChatId: vi.fn(),
  getChatMode: vi.fn(async () => 'group'),
  sendMessage: vi.fn(async () => 'om_x'),
  replyMessage: vi.fn(async () => 'om_x'),
  listChatBotMembers: vi.fn(async () => []),
}));

const mockGetBot = vi.fn(() => ({ config: { cliId: 'codex-app', apiOnly: true } }));
vi.mock('../src/bot-registry.js', () => ({
  getBot: (...a: any[]) => mockGetBot(...a),
  effectiveDefaultWorkingDir: vi.fn(() => '/tmp'),
}));

vi.mock('../src/services/groups-store.js', () => ({ isInChat: vi.fn(async () => true) }));
vi.mock('../src/services/oncall-store.js', () => ({ getOncallStatus: vi.fn(() => undefined) }));

let sessionSeq = 0;
const createdSessions: any[] = [];
vi.mock('../src/services/session-store.js', () => ({
  createSession: vi.fn((chatId: string, anchor: string, title: string) => {
    const s = { sessionId: `sess-${++sessionSeq}`, chatId, rootMessageId: anchor, title, scope: 'chat', status: 'active', createdAt: '2026-06-01T00:00:00.000Z' };
    createdSessions.push(s);
    return s;
  }),
  updateSession: vi.fn(),
  getSession: vi.fn((id: string) => createdSessions.find(s => s.sessionId === id)),
  getOwnedSession: vi.fn((id: string) => createdSessions.find(s => s.sessionId === id)),
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
}));

vi.mock('../src/services/message-queue.js', () => ({ ensureQueue: vi.fn() }));
vi.mock('../src/core/session-manager.js', () => ({
  buildFollowUpContent: vi.fn((p: string) => p),
  buildFollowUpCliInput: vi.fn((p: string) => ({ content: p })),
  buildNewTopicPrompt: vi.fn((p: string) => p),
  buildNewTopicCliInput: vi.fn((p: string) => ({ content: p })),
  ensureSessionWhiteboard: vi.fn(),
  getAvailableBots: vi.fn(async () => []),
  rememberLastCliInput: vi.fn(),
}));
vi.mock('../src/services/default-worktree.js', () => ({ botAutoWorktreeEnabled: vi.fn(() => false) }));
vi.mock('../src/im/lark/card-handler.js', () => ({ runAutoWorktreeCommit: vi.fn(async () => {}) }));

// worker-pool: forkWorker is the dispatch side effect we make throw on demand.
let forkShouldThrow = false;
const mockForkWorker = vi.fn(() => { if (forkShouldThrow) throw new Error('injected fork failure'); });
const mockCloseSession = vi.fn(async () => ({ ok: true, alreadyClosed: false, known: true }));
vi.mock('../src/core/worker-pool.js', () => ({
  forkWorker: (...a: any[]) => mockForkWorker(...a),
  sendWorkerInput: vi.fn(() => true),
  getCurrentCliVersion: vi.fn(() => 'test'),
  setActiveSessionIfActive: (map: Map<string, any>, key: string, ds: any) => { map.set(key, ds); return true; },
  closeSession: (...a: any[]) => mockCloseSession(...a),
  getDaemonBootId: () => 'boot-CURRENT',
}));

import { triggerSessionTurn } from '../src/core/trigger-session.js';
import * as asyncTriggerStore from '../src/services/async-trigger-store.js';
import * as idempotencyStore from '../src/services/idempotency-store.js';

const APP = 'local_riff';
function freshAsyncReq(idempotencyKey: string, instruction = 'do the thing'): TriggerRequest {
  return {
    source: { type: 'webhook', sourceName: 'riff' } as any,
    target: { kind: 'turn', botId: APP },
    envelope: { format: 'text', sourceName: 'riff', trusted: false },
    instruction,
    options: { asyncReturnSessionId: true, idempotencyKey },
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'trig-idem-e2e-'));
  prevDataDir = process.env.SESSION_DATA_DIR;
  process.env.SESSION_DATA_DIR = tempDir;
  sessionSeq = 0; createdSessions.length = 0;
  forkShouldThrow = false;
  mockForkWorker.mockClear(); mockCloseSession.mockClear();
});
afterEach(() => {
  if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR; else process.env.SESSION_DATA_DIR = prevDataDir;
  rmSync(tempDir, { recursive: true, force: true });
});

describe('triggerSessionTurn — idempotency dispatch (real stores)', () => {
  it('first call: forks once, writes a reserved→attempting lease, returns idempotent:false', async () => {
    const res = await triggerSessionTurn(freshAsyncReq('k-1'), { larkAppId: APP, activeSessions: new Map() });
    expect(res.ok).toBe(true);
    expect(res.idempotent).toBe(false);
    expect(mockForkWorker).toHaveBeenCalledTimes(1);
    const lease = idempotencyStore.lookup(APP, 'k-1');
    expect(lease?.state).toBe('attempting'); // barrier crossed before fork
    expect(lease?.sessionId).toBe(res.target?.sessionId);
  });

  it('same key + same payload retry: reuses, does NOT fork again', async () => {
    const first = await triggerSessionTurn(freshAsyncReq('k-2'), { larkAppId: APP, activeSessions: new Map() });
    expect(mockForkWorker).toHaveBeenCalledTimes(1);
    const second = await triggerSessionTurn(freshAsyncReq('k-2'), { larkAppId: APP, activeSessions: new Map() });
    expect(second.idempotent).toBe(true);
    expect(second.target?.sessionId).toBe(first.target?.sessionId);
    expect(mockForkWorker).toHaveBeenCalledTimes(1); // still ONE fork
  });

  it('same key + DIFFERENT payload → 409 idempotency_conflict, no second fork', async () => {
    await triggerSessionTurn(freshAsyncReq('k-3', 'payload A'), { larkAppId: APP, activeSessions: new Map() });
    const conflict = await triggerSessionTurn(freshAsyncReq('k-3', 'payload B'), { larkAppId: APP, activeSessions: new Map() });
    expect(conflict.ok).toBe(false);
    expect(conflict.errorCode).toBe('idempotency_conflict');
    expect(mockForkWorker).toHaveBeenCalledTimes(1);
  });

  it('same key, same instruction, but DIFFERENT options.status → 409 (requestHash covers full options)', async () => {
    // codex #776 round-4: status firing→resolved changes the rendered prompt; the
    // hash must change too, else the resolved event silently reuses the firing turn.
    const firing: TriggerRequest = { ...freshAsyncReq('k-status'), options: { asyncReturnSessionId: true, idempotencyKey: 'k-status', status: 'firing' } };
    const resolved: TriggerRequest = { ...freshAsyncReq('k-status'), options: { asyncReturnSessionId: true, idempotencyKey: 'k-status', status: 'resolved' } };
    await triggerSessionTurn(firing, { larkAppId: APP, activeSessions: new Map() });
    const res = await triggerSessionTurn(resolved, { larkAppId: APP, activeSessions: new Map() });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('idempotency_conflict');
    expect(mockForkWorker).toHaveBeenCalledTimes(1);
  });

  it('fork throw AFTER the barrier → durable async failed(dispatch_unknown) + close, retry does NOT re-run', async () => {
    forkShouldThrow = true;
    const res = await triggerSessionTurn(freshAsyncReq('k-4'), { larkAppId: APP, activeSessions: new Map() });
    // The HTTP result reports a terminal failed (at-most-once), not queued.
    expect(res.state).toBe('failed');
    expect(res.errorCode).toBe('no_output');
    const sid = res.target!.sessionId!;
    // Authoritative durable failed evidence is written (so trigger-result converges).
    expect(asyncTriggerStore.lookup(sid, res.triggerId!)?.result.status).toBe('failed');
    expect(asyncTriggerStore.lookup(sid, res.triggerId!)?.result.reason).toBe('dispatch_unknown');
    expect(mockCloseSession).toHaveBeenCalledWith(sid);
    // Retry with the same key must NOT dispatch again — it resolves terminal.
    forkShouldThrow = false;
    const forkBefore = mockForkWorker.mock.calls.length;
    const retry = await triggerSessionTurn(freshAsyncReq('k-4'), { larkAppId: APP, activeSessions: new Map() });
    expect(retry.state).toBe('failed');
    expect(mockForkWorker.mock.calls.length).toBe(forkBefore); // no new fork
  });

  it('DOUBLE failure (fork throw + terminal write throw) → 5xx trigger_failed, NOT a phantom state:failed', async () => {
    forkShouldThrow = true;
    // Make recordFailedStrict's durable write fail: pre-create the async-triggers
    // target path for the next session (sess-1) as a DIRECTORY, so the atomic
    // rename onto it fails. The dispatch throws AND the terminal write throws →
    // we must NOT claim state:failed (the caller could never observe it).
    const asyncDir = join(tempDir, 'async-triggers');
    mkdirSync(join(asyncDir, 'sess-1.json'), { recursive: true }); // path is a dir → write fails
    const res = await triggerSessionTurn(freshAsyncReq('k-dbl'), { larkAppId: APP, activeSessions: new Map() });
    expect(res.ok).toBe(false);
    expect(res.state).not.toBe('failed');       // no phantom terminal
    expect(res.errorCode).toBe('trigger_failed'); // honest 5xx-class hard error
  });

  // ── codex #776 finding #1: attempt-barrier (transition reserved→attempting)
  //    fault. The barrier-fail release must genuinely CONVERGE the lease — not
  //    swallow a `changed`/EIO — so a same-boot retry does the right thing.
  //    Two disk states codex named: pre-rename (disk still reserved) and
  //    post-rename (disk landed attempting, then fsync threw).

  it('barrier PRE-rename fault (transition throws, disk still reserved) → 5xx; same-key retry starts FRESH (re-forks once)', async () => {
    const shared = new Map(); // real daemon shares ONE activeSessions map across calls
    // First call: make the barrier transition throw WITHOUT mutating disk (the
    // lease stays `reserved`). Barrier-fail release must cleanly compareAndRemove
    // it so the retry is not blocked by a same-boot reserved orphan.
    const spy = vi.spyOn(idempotencyStore, 'transition').mockImplementationOnce(() => { throw new Error('injected pre-rename barrier fault'); });
    const first = await triggerSessionTurn(freshAsyncReq('k-bpre'), { larkAppId: APP, activeSessions: shared });
    expect(first.ok).toBe(false);
    expect(first.errorCode).toBe('trigger_failed');
    expect(mockForkWorker).not.toHaveBeenCalled(); // barrier failed before fork
    // Lease was released (clean reserved removal) — no leftover blocking the key.
    expect(idempotencyStore.lookup(APP, 'k-bpre')).toBeUndefined();
    spy.mockRestore();
    // Retry: real transition now works → fresh claim + one fork + attempting lease.
    const retry = await triggerSessionTurn(freshAsyncReq('k-bpre'), { larkAppId: APP, activeSessions: shared });
    expect(retry.ok).toBe(true);
    expect(retry.idempotent).toBe(false);
    expect(mockForkWorker).toHaveBeenCalledTimes(1); // exactly one fork total
    expect(idempotencyStore.lookup(APP, 'k-bpre')?.state).toBe('attempting');
  });

  it('barrier POST-rename fault (disk landed attempting, then throw) → observable durable failed; same-key retry does NOT re-fork', async () => {
    // Simulate the rename landing (disk becomes attempting) THEN a post-rename
    // fsync throw: advance the real on-disk lease to attempting, then throw. The
    // barrier-fail release sees compareAndRemove→changed(attempting) and must
    // durably terminalize (never delete the crossed fence) AND report an
    // observable terminal (state:failed with the sessionId), not a bare 5xx.
    const realTransition = idempotencyStore.transition;
    const spy = vi.spyOn(idempotencyStore, 'transition').mockImplementationOnce((owner: any, key: any, from: any, patch: any) => {
      realTransition(owner, key, from, patch); // rename lands: disk now attempting
      throw new Error('injected post-rename barrier fault (fsync)');
    });
    const first = await triggerSessionTurn(freshAsyncReq('k-bpost'), { larkAppId: APP, activeSessions: new Map() });
    spy.mockRestore();
    expect(first.ok).toBe(false);
    expect(first.state).toBe('failed');            // observable terminal, not bare 5xx
    expect(first.errorCode).toBe('no_output');
    expect(mockForkWorker).not.toHaveBeenCalled(); // threw before fork
    const sid = first.target!.sessionId!;
    // The crossed fence was durably terminalized (dispatch_unknown), NOT deleted.
    expect(asyncTriggerStore.lookup(sid, first.triggerId!)?.result.status).toBe('failed');
    expect(asyncTriggerStore.lookup(sid, first.triggerId!)?.result.reason).toBe('dispatch_unknown');
    // Retry with the same key resolves TERMINAL (at-most-once) — never re-forks.
    const retry = await triggerSessionTurn(freshAsyncReq('k-bpost'), { larkAppId: APP, activeSessions: new Map() });
    expect(retry.state).toBe('failed');
    expect(mockForkWorker).not.toHaveBeenCalled(); // still zero forks
  });

  it('barrier release compareAndRemove EIO (unprovable) → 5xx; retry stays TERMINAL (not-live orphan, no reuse-forever)', async () => {
    // Barrier transition throws pre-rename (disk still reserved), but the release
    // compareAndRemove ALSO throws (EIO) → the lease state is unprovable. We must
    // NOT reuse-forever: resolveIdempotencyHit's not-live guard makes the retry
    // terminal (the still-reserved same-boot lease has no live worker in the
    // persistent map, which evicts on closeSession — modeled here by a fresh map).
    const tSpy = vi.spyOn(idempotencyStore, 'transition').mockImplementationOnce(() => { throw new Error('injected barrier fault'); });
    const rSpy = vi.spyOn(idempotencyStore, 'compareAndRemove').mockImplementationOnce(() => { throw new Error('injected EIO on release unlink'); });
    const first = await triggerSessionTurn(freshAsyncReq('k-beio'), { larkAppId: APP, activeSessions: new Map() });
    tSpy.mockRestore(); rSpy.mockRestore();
    expect(first.ok).toBe(false);
    expect(first.errorCode).toBe('trigger_failed');
    expect(mockForkWorker).not.toHaveBeenCalled();
    // The reserved lease is still on disk (release couldn't prove removal)…
    expect(idempotencyStore.lookup(APP, 'k-beio')?.state).toBe('reserved');
    // …but the session is not live (closed + persistent map evicts) → retry is
    // TERMINAL, never reused-forever.
    const retry = await triggerSessionTurn(freshAsyncReq('k-beio'), { larkAppId: APP, activeSessions: new Map() });
    expect(retry.state).toBe('failed');
    expect(retry.idempotent).toBe(true);
    expect(mockForkWorker).not.toHaveBeenCalled(); // no dispatch on the orphan
  });
});
