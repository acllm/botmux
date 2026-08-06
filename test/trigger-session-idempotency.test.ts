/**
 * Integration tests for the idempotency dispatch lease as consumed by
 * trigger-session: the at-most-once decision logic (resolveIdempotencyHit) and
 * the boot reconcile (reconcileIdempotencyLeasesOnBoot), against the REAL
 * idempotency-store + async-trigger-store (temp dir). Mocks only the daemon
 * boundaries the reconcile touches (closeSession) and the modules trigger-session
 * imports at load time.
 *
 * Covers codex's crash-point matrix: attempting-without-live-worker → terminal
 * (never re-dispatched), completed → reuse across restart, reserved same-boot →
 * reuse, reserved older-boot → takeover, and reconcile convergence.
 *
 * Run:  pnpm vitest run test/trigger-session-idempotency.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DaemonSession } from '../src/core/types.js';

let tempDir: string;

// Real config is used (trigger-session's import chain reads many config fields);
// config.session.dataDir is a getter over process.env.SESSION_DATA_DIR, so we
// point the real stores at a temp dir by setting the env var per test.
vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// closeSession is the only worker-pool symbol the reconcile path calls; stub the
// rest that trigger-session imports at load. getDaemonBootId returns a fixed id.
const mockCloseSession = vi.fn(async () => ({ ok: true, alreadyClosed: false, known: true }));
vi.mock('../src/core/worker-pool.js', () => ({
  closeSession: (...a: any[]) => mockCloseSession(...a),
  forkWorker: vi.fn(),
  getCurrentCliVersion: vi.fn(() => 'test'),
  sendWorkerInput: vi.fn(() => true),
  setActiveSessionIfActive: vi.fn(() => true),
  getDaemonBootId: () => 'boot-CURRENT',
}));

// session-store: only getSession is consulted by the decision/reconcile paths.
const sessionRows = new Map<string, any>();
vi.mock('../src/services/session-store.js', () => ({
  getSession: (id: string) => sessionRows.get(id),
  createSession: vi.fn(),
  updateSession: vi.fn(),
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
}));

import * as idempotencyStore from '../src/services/idempotency-store.js';
import * as asyncTriggerStore from '../src/services/async-trigger-store.js';
import { resolveIdempotencyHit, reconcileIdempotencyLeasesOnBoot } from '../src/core/trigger-session.js';

const OWNER = 'cli_bot';
function lease(over: Partial<idempotencyStore.IdempotencyRecord> = {}): idempotencyStore.IdempotencyRecord {
  return {
    ownerLarkAppId: OWNER, sessionId: 'sess-1', triggerId: 'trg_1', requestHash: 'sha256:h',
    ownerBootId: 'boot-CURRENT', revision: 1, state: 'reserved', createdAt: 1, updatedAt: 1, ...over,
  };
}

let prevDataDir: string | undefined;
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'trig-idem-'));
  prevDataDir = process.env.SESSION_DATA_DIR;
  process.env.SESSION_DATA_DIR = tempDir;
  sessionRows.clear();
  mockCloseSession.mockClear();
});
afterEach(() => {
  if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR; else process.env.SESSION_DATA_DIR = prevDataDir;
  rmSync(tempDir, { recursive: true, force: true });
});

describe('resolveIdempotencyHit (at-most-once decisions)', () => {
  const empty = new Map<string, DaemonSession>();

  it('completed async result → reuse (poll it), regardless of lease state', () => {
    asyncTriggerStore.recordCompleted('sess-1', 'trg_1', 'done', 100, OWNER);
    const d = resolveIdempotencyHit(lease({ state: 'attempting', ownerBootId: 'boot-OLD' }), 'boot-CURRENT', empty);
    expect(d.kind).toBe('reuse');
  });

  it('terminal lease → terminal (caller sees failed, never rerun)', () => {
    const d = resolveIdempotencyHit(lease({ state: 'terminal', outcome: 'dispatch_unknown' }), 'boot-CURRENT', empty);
    expect(d.kind).toBe('terminal');
  });

  it('attempting + owning boot alive → reuse (turn genuinely in flight)', () => {
    const d = resolveIdempotencyHit(lease({ state: 'attempting', ownerBootId: 'boot-CURRENT' }), 'boot-CURRENT', empty);
    expect(d.kind).toBe('reuse');
  });

  it('attempting + owning boot GONE + no completion → terminal (ambiguous crash, NO redispatch)', () => {
    const d = resolveIdempotencyHit(lease({ state: 'attempting', ownerBootId: 'boot-OLD' }), 'boot-CURRENT', empty);
    expect(d.kind).toBe('terminal');
  });

  it('attempting + owning boot gone but a LIVE worker exists → reuse (in flight)', () => {
    const live = new Map<string, DaemonSession>([['k', { session: { sessionId: 'sess-1' }, chatId: 'http_async_x' } as any]]);
    const d = resolveIdempotencyHit(lease({ state: 'attempting', ownerBootId: 'boot-OLD' }), 'boot-CURRENT', live);
    expect(d.kind).toBe('reuse');
  });

  it('reserved + same boot → reuse (owner advancing)', () => {
    const d = resolveIdempotencyHit(lease({ state: 'reserved', ownerBootId: 'boot-CURRENT' }), 'boot-CURRENT', empty);
    expect(d.kind).toBe('reuse');
  });

  it('reserved + older boot → takeover (provably pre-dispatch, safe to rerun)', () => {
    const d = resolveIdempotencyHit(lease({ state: 'reserved', ownerBootId: 'boot-OLD' }), 'boot-CURRENT', empty);
    expect(d.kind).toBe('takeover');
  });
});

describe('reconcileIdempotencyLeasesOnBoot (crash convergence)', () => {
  const empty = new Map<string, DaemonSession>();

  it('attempting orphan → terminal dispatch_unknown + closes the orphaned session', async () => {
    idempotencyStore.claim({ ownerLarkAppId: OWNER, sessionId: 'sess-att', triggerId: 'trg_att', requestHash: 'h', ownerBootId: 'boot-OLD', key: 'k-att', now: 1 });
    const { record } = idempotencyStore.claim({ ownerLarkAppId: OWNER, sessionId: 'sess-att', triggerId: 'trg_att', requestHash: 'h', ownerBootId: 'boot-OLD', key: 'k-att', now: 1 }) as any;
    idempotencyStore.transition(OWNER, 'k-att', record, { state: 'attempting', now: 2 });
    sessionRows.set('sess-att', { sessionId: 'sess-att', status: 'open' });

    await reconcileIdempotencyLeasesOnBoot(empty);

    expect(idempotencyStore.lookup(OWNER, 'k-att')?.state).toBe('terminal');
    expect(idempotencyStore.lookup(OWNER, 'k-att')?.outcome).toBe('dispatch_unknown');
    expect(mockCloseSession).toHaveBeenCalledWith('sess-att');
  });

  it('reserved orphan → lease removed + never-dispatched session closed', async () => {
    idempotencyStore.claim({ ownerLarkAppId: OWNER, sessionId: 'sess-res', triggerId: 'trg_res', requestHash: 'h', ownerBootId: 'boot-OLD', key: 'k-res', now: 1 });
    sessionRows.set('sess-res', { sessionId: 'sess-res', status: 'open' });

    await reconcileIdempotencyLeasesOnBoot(empty);

    expect(idempotencyStore.lookup(OWNER, 'k-res')).toBeUndefined();
    expect(mockCloseSession).toHaveBeenCalledWith('sess-res');
  });

  it('completed lease → kept intact, session NOT closed (retry reuses + polls)', async () => {
    const { record } = idempotencyStore.claim({ ownerLarkAppId: OWNER, sessionId: 'sess-ok', triggerId: 'trg_ok', requestHash: 'h', ownerBootId: 'boot-OLD', key: 'k-ok', now: 1 }) as any;
    idempotencyStore.transition(OWNER, 'k-ok', record, { state: 'attempting', now: 2 });
    asyncTriggerStore.recordCompleted('sess-ok', 'trg_ok', 'result', 100, OWNER);

    await reconcileIdempotencyLeasesOnBoot(empty);

    // completed → left as-is (still attempting on disk, but retry sees completed async result)
    expect(idempotencyStore.lookup(OWNER, 'k-ok')).toBeDefined();
    expect(mockCloseSession).not.toHaveBeenCalled();
  });
});
