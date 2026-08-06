/**
 * Unit tests for idempotency-store: claim, lookup, remove — the durable
 * (ownerLarkAppId, key) → {sessionId, triggerId} mapping that lets a retried
 * /api/trigger return the SAME session instead of re-dispatching.
 *
 * Uses a real temp directory with vi.mock to redirect config.session.dataDir,
 * mirroring async-trigger-store.test.ts / frozen-card-store.test.ts.
 *
 * Run:  pnpm vitest run test/idempotency-store.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string;

vi.mock('../src/config.js', () => ({
  config: {
    session: {
      get dataDir() { return tempDir; },
    },
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { claim, lookup, remove, type IdempotencyRecord } from '../src/services/idempotency-store.js';

const rec = (over: Partial<IdempotencyRecord> = {}): IdempotencyRecord => ({
  sessionId: 'sess-1',
  triggerId: 'trg_abc',
  ownerLarkAppId: 'cli_bot_a',
  createdAt: 1000,
  ...over,
});

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'idempotency-store-test-'));
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('claim + lookup', () => {
  it('returns undefined for an unknown key', () => {
    expect(lookup('cli_bot_a', 'never-seen')).toBeUndefined();
  });

  it('claims a fresh key and reads it back', () => {
    const out = claim(rec(), 'key-1');
    expect(out.sessionId).toBe('sess-1');
    expect(out.triggerId).toBe('trg_abc');
    const back = lookup('cli_bot_a', 'key-1');
    expect(back?.sessionId).toBe('sess-1');
    expect(back?.triggerId).toBe('trg_abc');
    expect(back?.ownerLarkAppId).toBe('cli_bot_a');
  });

  it('is idempotent: a second claim of the SAME key returns the FIRST winner (no overwrite)', () => {
    claim(rec({ sessionId: 'sess-first', triggerId: 'trg_first' }), 'key-race');
    // A concurrent/retried dispatch tries to claim the same key with a different
    // freshly-created session — must get the first winner back, not overwrite.
    const out = claim(rec({ sessionId: 'sess-second', triggerId: 'trg_second', createdAt: 2000 }), 'key-race');
    expect(out.sessionId).toBe('sess-first');
    expect(out.triggerId).toBe('trg_first');
    // Disk still holds the winner.
    expect(lookup('cli_bot_a', 'key-race')?.sessionId).toBe('sess-first');
  });
});

describe('cross-bot isolation', () => {
  it('same key under two different bots maps to independent records', () => {
    claim(rec({ ownerLarkAppId: 'cli_bot_a', sessionId: 'sess-a' }), 'shared-key');
    claim(rec({ ownerLarkAppId: 'cli_bot_b', sessionId: 'sess-b' }), 'shared-key');
    expect(lookup('cli_bot_a', 'shared-key')?.sessionId).toBe('sess-a');
    expect(lookup('cli_bot_b', 'shared-key')?.sessionId).toBe('sess-b');
  });

  it('lookup with the wrong owner returns undefined (fail-closed, never cross-bot leak)', () => {
    claim(rec({ ownerLarkAppId: 'cli_bot_a', sessionId: 'sess-a' }), 'key-x');
    // Bot B asking for bot A's key sees nothing.
    expect(lookup('cli_bot_b', 'key-x')).toBeUndefined();
  });

  it('key prefix/suffix cannot collide across owners (NUL-separated hash)', () => {
    // (owner="a", key="bc") vs (owner="ab", key="c") must be distinct files.
    claim(rec({ ownerLarkAppId: 'a', sessionId: 'sess-abc-1' }), 'bc');
    claim(rec({ ownerLarkAppId: 'ab', sessionId: 'sess-abc-2' }), 'c');
    expect(lookup('a', 'bc')?.sessionId).toBe('sess-abc-1');
    expect(lookup('ab', 'c')?.sessionId).toBe('sess-abc-2');
  });
});

describe('remove', () => {
  it('deletes a mapping and is idempotent', () => {
    claim(rec(), 'key-del');
    expect(lookup('cli_bot_a', 'key-del')).toBeDefined();
    remove('cli_bot_a', 'key-del');
    expect(lookup('cli_bot_a', 'key-del')).toBeUndefined();
    // Second remove doesn't throw.
    expect(() => remove('cli_bot_a', 'key-del')).not.toThrow();
  });
});

describe('durability shape', () => {
  it('survives a fresh module read (persisted to disk, not in-memory)', () => {
    claim(rec({ sessionId: 'sess-persist' }), 'key-persist');
    // lookup re-reads the file each call (no in-memory cache), so this proves disk persistence.
    expect(lookup('cli_bot_a', 'key-persist')?.sessionId).toBe('sess-persist');
  });

  it('tolerates weird key bytes (path traversal / slashes) via hashed filename', () => {
    const nasty = '../../etc/passwd\0/../x';
    const out = claim(rec({ sessionId: 'sess-nasty' }), nasty);
    expect(out.sessionId).toBe('sess-nasty');
    expect(lookup('cli_bot_a', nasty)?.sessionId).toBe('sess-nasty');
  });
});
