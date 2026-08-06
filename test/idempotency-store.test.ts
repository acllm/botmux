/**
 * Unit tests for idempotency-store: the at-most-once dispatch lease
 * (reserved → attempting → terminal) with fail-closed I/O, CAS transitions,
 * older-boot takeover, requestHash conflict, and reconcile enumeration.
 *
 * Uses a real temp dir + vi.mock to redirect config.session.dataDir, mirroring
 * async-trigger-store.test.ts.
 *
 * Run:  pnpm vitest run test/idempotency-store.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string;

vi.mock('../src/config.js', () => ({
  config: { session: { get dataDir() { return tempDir; } } },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  claim, transition, takeover, lookup, compareAndRemove, listAll, removeByPathLocked,
  IdempotencyConflictError,
  type IdempotencyRecord,
} from '../src/services/idempotency-store.js';

const base = (over: Partial<Parameters<typeof claim>[0]> = {}) => ({
  ownerLarkAppId: 'cli_a', sessionId: 'sess-1', triggerId: 'trg_1',
  requestHash: 'sha256:h1', ownerBootId: 'boot-1', key: 'k1', now: 1000, ...over,
});

beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'idem-store-')); });
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

describe('claim', () => {
  it('wins a fresh key with a reserved lease', () => {
    const res = claim(base());
    expect(res.kind).toBe('won');
    expect(res.record.state).toBe('reserved');
    expect(res.record.revision).toBe(1);
    expect(lookup('cli_a', 'k1')?.sessionId).toBe('sess-1');
  });

  it('returns existing (same payload) on a second claim — no overwrite', () => {
    claim(base({ sessionId: 'sess-first', triggerId: 'trg_first' }));
    const res = claim(base({ sessionId: 'sess-second', triggerId: 'trg_second', now: 2000 }));
    expect(res.kind).toBe('existing');
    expect(res.record.sessionId).toBe('sess-first');
    expect(res.record.triggerId).toBe('trg_first');
  });

  it('throws IdempotencyConflictError on same key + different requestHash', () => {
    claim(base({ requestHash: 'sha256:AAA' }));
    expect(() => claim(base({ requestHash: 'sha256:BBB' }))).toThrow(IdempotencyConflictError);
  });

  it('cross-owner: same key under two bots are independent', () => {
    claim(base({ ownerLarkAppId: 'cli_a', sessionId: 'sess-a' }));
    claim(base({ ownerLarkAppId: 'cli_b', sessionId: 'sess-b' }));
    expect(lookup('cli_a', 'k1')?.sessionId).toBe('sess-a');
    expect(lookup('cli_b', 'k1')?.sessionId).toBe('sess-b');
  });

  it('FAIL-CLOSED: a corrupt existing record throws (never treated as absent)', () => {
    claim(base());
    // Corrupt the single stored file.
    const files = readdirSync(tempDir + '/idempotency').filter(f => f.endsWith('.json'));
    expect(files.length).toBe(1);
    writeFileSync(join(tempDir, 'idempotency', files[0]), '{ not json', 'utf-8');
    expect(() => claim(base())).toThrow();
    expect(() => lookup('cli_a', 'k1')).toThrow();
  });
});

describe('transition (CAS)', () => {
  it('advances reserved → attempting and bumps revision', () => {
    const { record } = claim(base()) as { record: IdempotencyRecord };
    const next = transition('cli_a', 'k1', record, { state: 'attempting', now: 2000 });
    expect(next.state).toBe('attempting');
    expect(next.revision).toBe(2);
    expect(lookup('cli_a', 'k1')?.state).toBe('attempting');
  });

  it('rejects a stale-revision writer (CAS conflict)', () => {
    const { record } = claim(base()) as { record: IdempotencyRecord };
    transition('cli_a', 'k1', record, { state: 'attempting', now: 2000 }); // rev→2
    // Second writer still holding rev-1 record must fail.
    expect(() => transition('cli_a', 'k1', record, { state: 'terminal', outcome: 'dispatch_unknown', now: 3000 }))
      .toThrow(/CAS conflict/);
  });
});

describe('takeover (older-boot reserved) — returns won|existing', () => {
  it('WON: replaces an older-boot reserved lease with a fresh one', () => {
    const { record } = claim(base({ ownerBootId: 'boot-OLD' })) as { record: IdempotencyRecord };
    const res = takeover({
      ownerLarkAppId: 'cli_a', key: 'k1', expect: record,
      sessionId: 'sess-NEW', triggerId: 'trg_NEW', requestHash: 'sha256:h1',
      ownerBootId: 'boot-NEW', now: 5000,
    });
    expect(res.kind).toBe('won');
    expect(res.record.sessionId).toBe('sess-NEW');
    expect(res.record.ownerBootId).toBe('boot-NEW');
    expect(res.record.state).toBe('reserved');
    expect(lookup('cli_a', 'k1')?.sessionId).toBe('sess-NEW');
  });

  it('EXISTING: does NOT seize if the lease advanced to attempting under us', () => {
    const { record } = claim(base({ ownerBootId: 'boot-OLD' })) as { record: IdempotencyRecord };
    transition('cli_a', 'k1', record, { state: 'attempting', now: 2000 }); // rev2 attempting
    const res = takeover({
      ownerLarkAppId: 'cli_a', key: 'k1', expect: record, // stale rev1 reserved
      sessionId: 'sess-NEW', triggerId: 'trg_NEW', requestHash: 'sha256:h1', ownerBootId: 'boot-NEW', now: 5000,
    });
    expect(res.kind).toBe('existing');
    expect(res.record.state).toBe('attempting');
    expect(res.record.sessionId).toBe('sess-1'); // original, not seized
  });

  it('EXISTING: a stale rev1 cannot clobber a fresh winner rev1 (the codex race)', () => {
    // old claim → remove → fresh winner claim(rev1); takeover(expect=old rev1) must NOT win.
    const { record: oldRec } = claim(base({ ownerBootId: 'boot-OLD', sessionId: 'sess-OLD' })) as { record: IdempotencyRecord };
    compareAndRemove('cli_a', 'k1', oldRec);
    const { record: freshWinner } = claim(base({ ownerBootId: 'boot-FRESH', sessionId: 'sess-FRESH' })) as { record: IdempotencyRecord };
    expect(freshWinner.revision).toBe(1); // revision restarts from 1
    const res = takeover({
      ownerLarkAppId: 'cli_a', key: 'k1', expect: oldRec, // same rev1, but different identity
      sessionId: 'sess-STALE', triggerId: 'trg_STALE', requestHash: 'sha256:h1', ownerBootId: 'boot-OLD', now: 9000,
    });
    expect(res.kind).toBe('existing');
    expect(lookup('cli_a', 'k1')?.sessionId).toBe('sess-FRESH'); // winner intact
  });

  it('conflict: takeover with a different payload throws', () => {
    const { record } = claim(base({ ownerBootId: 'boot-OLD', requestHash: 'sha256:AAA' })) as { record: IdempotencyRecord };
    expect(() => takeover({
      ownerLarkAppId: 'cli_a', key: 'k1', expect: record,
      sessionId: 'sess-NEW', triggerId: 'trg_NEW', requestHash: 'sha256:BBB', ownerBootId: 'boot-NEW', now: 5000,
    })).toThrow(IdempotencyConflictError);
  });
});

describe('reconcile enumeration', () => {
  it('listAll returns every stored lease with its file path', () => {
    claim(base({ key: 'k1', sessionId: 's1' }));
    claim(base({ key: 'k2', sessionId: 's2' }));
    const all = listAll();
    expect(all.length).toBe(2);
    expect(all.map(a => a.record.sessionId).sort()).toEqual(['s1', 's2']);
    expect(all.every(a => a.file.endsWith('.json'))).toBe(true);
  });

  it('removeByPathLocked drops a lease by its enumerated path', () => {
    claim(base());
    const { file } = listAll()[0];
    removeByPathLocked(file);
    expect(lookup('cli_a', 'k1')).toBeUndefined();
    expect(() => removeByPathLocked(file)).not.toThrow(); // idempotent
  });

  it('listAll skips (does not throw on) a corrupt file', () => {
    claim(base({ key: 'good', sessionId: 'sg' }));
    writeFileSync(join(tempDir, 'idempotency', 'deadbeef.json'), '{ corrupt', 'utf-8');
    const all = listAll();
    expect(all.length).toBe(1);
    expect(all[0].record.sessionId).toBe('sg');
  });
});

describe('compareAndRemove + weird keys', () => {
  it('compareAndRemove deletes only the exact expected lease; idempotent', () => {
    const { record } = claim(base()) as { record: IdempotencyRecord };
    // Stale expectation (wrong revision) → no-op.
    expect(compareAndRemove('cli_a', 'k1', { ...record, revision: 99 })).toBe(false);
    expect(lookup('cli_a', 'k1')).toBeDefined();
    // Exact match → removed.
    expect(compareAndRemove('cli_a', 'k1', record)).toBe(true);
    expect(lookup('cli_a', 'k1')).toBeUndefined();
    expect(compareAndRemove('cli_a', 'k1', record)).toBe(false); // already gone
  });

  it('tolerates path-traversal / NUL key bytes via hashed filename', () => {
    const nasty = '../../etc/passwd\0/x';
    claim(base({ key: nasty, sessionId: 'sn' }));
    expect(lookup('cli_a', nasty)?.sessionId).toBe('sn');
  });
});
