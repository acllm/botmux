/**
 * Idempotency dispatch lease keyed by a caller-provided `options.idempotencyKey`
 * (scoped per owning bot). The lease answers exactly ONE question: "may I
 * dispatch this turn?" — it does NOT define what a caller sees as the terminal
 * outcome. That terminal outcome lives in async-trigger-store (pending /
 * completed / failed:dispatch_unknown), which trigger-result reads directly.
 * Separating the two means correctness never depends on closeSession succeeding
 * or on a second tombstone file (see PR #776 review 4878071011).
 *
 * States: reserved (claimed, not yet dispatched) → attempting (durably written
 * BEFORE any fork/worker IPC side effect — commit-unknown). There is no
 * "dispatched"/"completed" lease state: completion is proven by async-trigger
 * store, and an attempting lease is a permanent "do-not-redispatch" fence.
 *
 * CONCURRENCY. rename(2) gives an atomic REPLACE, not a compare-and-swap. Every
 * mutation therefore runs inside withFileLockSync(recordPath) (cross-process,
 * per-key): read → verify full immutable identity + revision/state → durable
 * atomic write, all under the lock. `atomicWriteFileSync` (tmp+fsync+rename,
 * failure PRESERVES the old file) is used everywhere — never unlink→link, which
 * could erase the only commit-unknown fence on an I/O failure.
 *
 * OWNERSHIP. (ownerLarkAppId, key) scoping + `ownerBootId` (this daemon process)
 * + monotonic `revision`. Cross-bot reads are rejected fail-closed. Older-boot
 * takeover of a `reserved` lease is safe under the repo's "one daemon per bot"
 * invariant (daemon.ts): a different ownerBootId for the same bot means the
 * previous process, which cannot still be advancing this lease.
 *
 * FAIL-CLOSED. Any ambiguous I/O / corruption on the claim path THROWS — the
 * caller rolls back the just-created session and returns 5xx before dispatch.
 */
import { readFileSync, existsSync, mkdirSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export type IdempotencyState = 'reserved' | 'attempting';

export interface IdempotencyRecord {
  ownerLarkAppId: string;
  sessionId: string;
  triggerId: string;
  requestHash: string;
  ownerBootId: string;
  revision: number;
  state: IdempotencyState;
  createdAt: number;
  updatedAt: number;
}

export type ClaimResult =
  | { kind: 'won'; record: IdempotencyRecord }
  | { kind: 'existing'; record: IdempotencyRecord };

export class IdempotencyConflictError extends Error {
  constructor(public readonly existing: IdempotencyRecord) {
    super('idempotency key already used with a different request payload');
    this.name = 'IdempotencyConflictError';
  }
}

function getDir(): string {
  return join(config.session.dataDir, 'idempotency');
}

/** Filename = sha256(owner \0 key). NUL separator prevents (a,bc)/(ab,c) collision. */
function fileFor(ownerLarkAppId: string, key: string): string {
  const digest = createHash('sha256').update(ownerLarkAppId).update('\0').update(key).digest('hex');
  return join(getDir(), `${digest}.json`);
}

function ensureDir(): void {
  const dir = getDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Acquire the per-key file lock, ensuring the idempotency dir exists first so
 *  withFileLockSync can create its `<path>.lock` sibling. All mutators route
 *  through here so the lock and the record live in a materialized directory. */
function withKeyLock<T>(fp: string, fn: () => T): T {
  ensureDir();
  return withFileLockSync(fp, fn);
}

/** Read + validate. undefined only when ABSENT. Present-but-corrupt THROWS
 *  (on the claim path an unreadable record is NOT provably absent). */
function readRecord(fp: string): IdempotencyRecord | undefined {
  if (!existsSync(fp)) return undefined;
  const data = JSON.parse(readFileSync(fp, 'utf-8')) as IdempotencyRecord;
  if (
    !data || typeof data !== 'object'
    || typeof data.ownerLarkAppId !== 'string'
    || typeof data.sessionId !== 'string'
    || typeof data.triggerId !== 'string'
    || typeof data.requestHash !== 'string'
    || typeof data.ownerBootId !== 'string'
    || typeof data.revision !== 'number'
    || (data.state !== 'reserved' && data.state !== 'attempting')
  ) {
    throw new Error(`corrupt idempotency record: ${fp}`);
  }
  return data;
}

function writeRecord(fp: string, rec: IdempotencyRecord): void {
  ensureDir();
  atomicWriteFileSync(fp, JSON.stringify(rec, null, 2), { durable: true, followTargetSymlink: false });
}

/** True iff two records share the immutable identity fields (everything a CAS
 *  must pin besides the mutable state/revision/updatedAt). */
function sameIdentity(a: IdempotencyRecord, b: {
  ownerLarkAppId: string; sessionId: string; triggerId: string; requestHash: string; ownerBootId: string;
}): boolean {
  return a.ownerLarkAppId === b.ownerLarkAppId
    && a.sessionId === b.sessionId
    && a.triggerId === b.triggerId
    && a.requestHash === b.requestHash
    && a.ownerBootId === b.ownerBootId;
}

/** Non-locking read for the pre-check in trigger-session (a fast reject before
 *  creating a session). Owner mismatch → undefined. Corrupt → THROWS. The
 *  authoritative decision is always re-taken under the lock in claim/takeover. */
export function lookup(ownerLarkAppId: string, key: string): IdempotencyRecord | undefined {
  const rec = readRecord(fileFor(ownerLarkAppId, key));
  if (!rec) return undefined;
  if (rec.ownerLarkAppId !== ownerLarkAppId) return undefined;
  return rec;
}

/**
 * Claim (owner, key) for a fresh `reserved` lease, or return the existing one —
 * all inside the per-key lock (read → decide → durable write is atomic wrt other
 * daemons/boots). Throws on corrupt/IO (fail-closed) and on payload conflict.
 */
export function claim(input: {
  ownerLarkAppId: string; sessionId: string; triggerId: string;
  requestHash: string; ownerBootId: string; key: string; now: number;
}): ClaimResult {
  const fp = fileFor(input.ownerLarkAppId, input.key);
  return withKeyLock(fp, () => {
    const existing = readRecord(fp);
    if (existing) {
      if (existing.ownerLarkAppId !== input.ownerLarkAppId) throw new Error('idempotency record owner mismatch');
      if (existing.requestHash !== input.requestHash) throw new IdempotencyConflictError(existing);
      return { kind: 'existing', record: existing };
    }
    const rec: IdempotencyRecord = {
      ownerLarkAppId: input.ownerLarkAppId, sessionId: input.sessionId, triggerId: input.triggerId,
      requestHash: input.requestHash, ownerBootId: input.ownerBootId,
      revision: 1, state: 'reserved', createdAt: input.now, updatedAt: input.now,
    };
    writeRecord(fp, rec);
    return { kind: 'won', record: rec };
  });
}

/**
 * Take over an OLDER-boot `reserved` lease with a fresh reserved lease (new
 * session/trigger), OR return the existing record if it's no longer a takeover
 * target — all under the lock, re-reading current state (never trusting the
 * caller's stale `from`). Returns won|existing so the caller handles a loss like
 * a claim loss (close its new session, don't fork). Throws on conflict/IO.
 *
 *  - absent now → won (fresh claim).
 *  - present, still the SAME older-boot reserved (identity+revision match) → won (replace).
 *  - present, same payload but changed (attempting / newer revision / different
 *    boot) → existing (someone advanced it; reuse, don't take over).
 *  - present, different payload → conflict.
 */
export function takeover(input: {
  ownerLarkAppId: string; key: string; expect: IdempotencyRecord;
  sessionId: string; triggerId: string; requestHash: string; ownerBootId: string; now: number;
}): ClaimResult {
  const fp = fileFor(input.ownerLarkAppId, input.key);
  return withKeyLock(fp, () => {
    const current = readRecord(fp);
    if (!current) {
      const rec: IdempotencyRecord = {
        ownerLarkAppId: input.ownerLarkAppId, sessionId: input.sessionId, triggerId: input.triggerId,
        requestHash: input.requestHash, ownerBootId: input.ownerBootId,
        revision: 1, state: 'reserved', createdAt: input.now, updatedAt: input.now,
      };
      writeRecord(fp, rec);
      return { kind: 'won', record: rec };
    }
    if (current.ownerLarkAppId !== input.ownerLarkAppId) throw new Error('idempotency record owner mismatch');
    if (current.requestHash !== input.requestHash) throw new IdempotencyConflictError(current);
    // Only replace the EXACT older-boot reserved lease we saw. Anything else
    // (advanced to attempting, bumped revision, or now owned by a live boot) is
    // reused, not seized.
    const stillTakeoverTarget =
      current.state === 'reserved'
      && current.revision === input.expect.revision
      && current.ownerBootId === input.expect.ownerBootId
      && current.ownerBootId !== input.ownerBootId
      && sameIdentity(current, input.expect);
    if (!stillTakeoverTarget) {
      return { kind: 'existing', record: current };
    }
    const rec: IdempotencyRecord = {
      ownerLarkAppId: input.ownerLarkAppId, sessionId: input.sessionId, triggerId: input.triggerId,
      requestHash: input.requestHash, ownerBootId: input.ownerBootId,
      revision: current.revision + 1, state: 'reserved', createdAt: current.createdAt, updatedAt: input.now,
    };
    writeRecord(fp, rec);
    return { kind: 'won', record: rec };
  });
}

/** CAS a record to a new state under the lock. Verifies full identity + revision
 *  before writing (rejects a stale/foreign writer). Returns the written record. */
export function transition(
  ownerLarkAppId: string, key: string, from: IdempotencyRecord,
  patch: { state: IdempotencyState; now: number },
): IdempotencyRecord {
  const fp = fileFor(ownerLarkAppId, key);
  return withKeyLock(fp, () => {
    const current = readRecord(fp);
    if (!current) throw new Error('idempotency transition: record vanished');
    if (current.revision !== from.revision || !sameIdentity(current, from)) {
      throw new Error(`idempotency CAS conflict: on-disk record changed under expected revision ${from.revision}`);
    }
    const next: IdempotencyRecord = { ...current, state: patch.state, revision: current.revision + 1, updatedAt: patch.now };
    writeRecord(fp, next);
    return next;
  });
}

/** Compare-and-remove: delete the lease ONLY if it still matches `expect`
 *  (identity + revision + state) under the lock. Used to release a `reserved`
 *  lease we created but abandoned before dispatch. Returns true if removed. */
export function compareAndRemove(ownerLarkAppId: string, key: string, expect: IdempotencyRecord): boolean {
  const fp = fileFor(ownerLarkAppId, key);
  return withKeyLock(fp, () => {
    const current = readRecord(fp);
    if (!current) return false;
    if (current.revision !== expect.revision || current.state !== expect.state || !sameIdentity(current, expect)) {
      return false;
    }
    try { unlinkSync(fp); } catch { /* already gone */ }
    return true;
  });
}

/** Enumerate every stored lease (boot reconcile). Best-effort per file: a
 *  corrupt file is logged + skipped so it can't abort the sweep. */
export function listAll(): Array<{ file: string; record: IdempotencyRecord }> {
  const dir = getDir();
  if (!existsSync(dir)) return [];
  const out: Array<{ file: string; record: IdempotencyRecord }> = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const fp = join(dir, name);
    try {
      const rec = readRecord(fp);
      if (rec) out.push({ file: fp, record: rec });
    } catch (err) {
      logger.warn(`[idempotency] skipping unreadable lease ${fp}: ${err}`);
    }
  }
  return out;
}

/** Reconcile-only remove by path, under a lock keyed on that path. Used by boot
 *  reconcile to drop a pre-dispatch `reserved` lease. Best-effort. */
export function removeByPathLocked(fp: string): void {
  withKeyLock(fp, () => {
    try { if (existsSync(fp)) unlinkSync(fp); } catch { /* ignore */ }
  });
}
