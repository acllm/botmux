/**
 * Idempotency store — durable dispatch-lease keyed by a caller-provided
 * `options.idempotencyKey` (scoped per owning bot), so a retried `/api/trigger`
 * with the same key returns the SAME session instead of dispatching the turn a
 * second time.
 *
 * Why this exists: an async caller (e.g. the riff task runner) that loses the
 * `/api/trigger` HTTP response — the daemon already created the session, but the
 * ACK never arrived — retries. Without idempotency the retry builds a brand new
 * session and the turn runs twice (duplicate external side effects). The caller's
 * own dedup can't help: the first session is genuinely already executing.
 *
 * SEMANTICS (at-most-once). This is a lease with an explicit dispatch state, NOT
 * a "session row exists → reuse" map — the latter would suppress a turn that
 * crashed BEFORE dispatch forever (permanent `running`). States:
 *   - reserved:   key claimed, NO dispatch attempted yet. Only the claim owner
 *                 (this boot) may advance it. A `reserved` record left by an
 *                 OLDER boot is provably pre-dispatch (we always CAS→attempting
 *                 before any fork/IPC side effect), so it is safe to take over.
 *   - attempting: durably written BEFORE any fork/worker IPC side effect. Once
 *                 here the turn is commit-unknown: `forkWorker` returning is NOT
 *                 proof the CLI didn't start, so a crash in `attempting` must
 *                 NEVER auto-redispatch. Completion is proven out-of-band via the
 *                 async-trigger store (final_output → recordCompleted); if that
 *                 proof is absent after the owning boot is gone, the turn
 *                 resolves to the terminal `dispatch_unknown` (never rerun).
 *   - terminal:   settled to `dispatch_unknown` (ambiguous crash). Completed
 *                 turns are NOT stored here — completion lives in async-trigger
 *                 store; callers derive `completed` from there.
 *
 * Ownership: (ownerLarkAppId, key) scoping + `ownerBootId` (this daemon process)
 * + a monotonic `revision` for CAS. A request routed to daemon A carrying bot
 * B's key is rejected fail-closed via the stamped owner.
 *
 * requestHash binds the key to its business payload: a same-key retry with a
 * DIFFERENT payload is a caller bug and must 409, never silently join the old
 * turn. Hash excludes the key itself and the daemon-generated session/chat ids.
 *
 * Persistence mirrors async-trigger-store: {dataDir}/idempotency/{h}.json where
 * h = sha256(ownerLarkAppId \0 key) — hashing keeps arbitrary caller key bytes
 * out of the filesystem path. FAIL-CLOSED: any I/O or corruption error on the
 * claim path throws (the caller rolls back the just-created session and returns
 * 5xx before dispatch) — never best-effort, which would fail-open to a double
 * dispatch.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, linkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export type IdempotencyState = 'reserved' | 'attempting' | 'terminal';
export type IdempotencyOutcome = 'dispatch_unknown';

export interface IdempotencyRecord {
  ownerLarkAppId: string;
  sessionId: string;
  triggerId: string;
  requestHash: string;
  /** The daemon boot (process) that owns the in-flight advance of this lease. */
  ownerBootId: string;
  /** Monotonic CAS token — every durable transition bumps it. */
  revision: number;
  state: IdempotencyState;
  /** Set only when state==='terminal'. */
  outcome?: IdempotencyOutcome;
  createdAt: number;
  updatedAt: number;
}

/** Result of a claim attempt. `won` = we created a fresh reserved lease (caller
 *  proceeds to dispatch). `existing` = a live record already owns this key
 *  (caller reuses it — never dispatches). Any ambiguous I/O error THROWS instead
 *  of resolving to either, so the caller fail-closes before dispatch. */
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

/** Read + validate a record. Returns undefined only when the file is ABSENT.
 *  A present-but-corrupt/unreadable file THROWS — on the claim path an
 *  unreadable existing record is NOT provably absent, so treating it as absent
 *  would fail-open to a double dispatch. */
function readRecord(fp: string): IdempotencyRecord | undefined {
  if (!existsSync(fp)) return undefined;
  const raw = readFileSync(fp, 'utf-8'); // ENOENT race → throw (fail-closed)
  const data = JSON.parse(raw) as IdempotencyRecord; // corrupt JSON → throw
  if (
    !data || typeof data !== 'object'
    || typeof data.ownerLarkAppId !== 'string'
    || typeof data.sessionId !== 'string'
    || typeof data.triggerId !== 'string'
    || typeof data.requestHash !== 'string'
    || typeof data.ownerBootId !== 'string'
    || typeof data.revision !== 'number'
    || (data.state !== 'reserved' && data.state !== 'attempting' && data.state !== 'terminal')
  ) {
    throw new Error(`corrupt idempotency record: ${fp}`);
  }
  return data;
}

/** Best-effort read for NON-claim paths (boot reconcile enumeration): a corrupt
 *  file is logged and skipped rather than throwing, so one bad file can't abort
 *  the whole reconcile sweep. */
function readRecordLenient(fp: string): IdempotencyRecord | undefined {
  try { return readRecord(fp); }
  catch (err) { logger.warn(`[idempotency] skipping unreadable record ${fp}: ${err}`); return undefined; }
}

/** Public lookup for the trigger path. Owner mismatch → undefined (fail-closed:
 *  another bot's record is never reused). Corrupt file THROWS (see readRecord). */
export function lookup(ownerLarkAppId: string, key: string): IdempotencyRecord | undefined {
  const rec = readRecord(fileFor(ownerLarkAppId, key));
  if (!rec) return undefined;
  if (rec.ownerLarkAppId !== ownerLarkAppId) return undefined;
  return rec;
}

/** Atomically write a record to a fresh path via wx-temp + link(2). `expectNew`
 *  true → the link MUST create (EEXIST = someone else won). false → an existing
 *  file is replaced (used for CAS transitions, which first re-read + verify). */
function writeAtomic(fp: string, rec: IdempotencyRecord, expectNew: boolean): 'written' | 'exists' {
  ensureDir();
  const tmp = `${fp}.${process.pid}.${createHash('sha256').update(String(rec.updatedAt)).update(rec.sessionId).update(String(rec.revision)).digest('hex').slice(0, 12)}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(rec, null, 2), { encoding: 'utf-8', flag: 'wx' });
    if (expectNew) {
      try { linkSync(tmp, fp); return 'written'; }
      catch (err: any) { if (err?.code === 'EEXIST') return 'exists'; throw err; }
    }
    // Replace: unlink existing then link. The whole claim path is serialized
    // per-key by an in-process mutex (one daemon = one bot), so this is not a
    // cross-process CAS — link EEXIST on the fresh-claim path is the only
    // cross-process race guard we rely on.
    try { if (existsSync(fp)) unlinkSync(fp); } catch { /* re-link will surface */ }
    linkSync(tmp, fp);
    return 'written';
  } finally {
    try { unlinkSync(tmp); } catch { /* already gone */ }
  }
}

/**
 * Claim (owner, key) for a fresh reserved lease, or return the existing record.
 * Throws on any ambiguous I/O/corruption error (fail-closed). Throws
 * IdempotencyConflictError when an existing record's requestHash differs.
 *
 * Caller contract: on `won`, proceed to dispatch (transition to attempting
 * FIRST, via markAttempting). On `existing`, NEVER dispatch — resolve from the
 * record's state.
 */
export function claim(input: {
  ownerLarkAppId: string;
  sessionId: string;
  triggerId: string;
  requestHash: string;
  ownerBootId: string;
  key: string;
  now: number;
}): ClaimResult {
  const fp = fileFor(input.ownerLarkAppId, input.key);
  const existing = readRecord(fp); // throws on corrupt (fail-closed)
  if (existing) {
    if (existing.ownerLarkAppId !== input.ownerLarkAppId) {
      // Filename collision across owners is cryptographically implausible, but
      // an owner-stamp mismatch is unattributable → fail-closed.
      throw new Error('idempotency record owner mismatch');
    }
    if (existing.requestHash !== input.requestHash) {
      throw new IdempotencyConflictError(existing);
    }
    return { kind: 'existing', record: existing };
  }
  const rec: IdempotencyRecord = {
    ownerLarkAppId: input.ownerLarkAppId,
    sessionId: input.sessionId,
    triggerId: input.triggerId,
    requestHash: input.requestHash,
    ownerBootId: input.ownerBootId,
    revision: 1,
    state: 'reserved',
    createdAt: input.now,
    updatedAt: input.now,
  };
  const outcome = writeAtomic(fp, rec, /*expectNew*/ true);
  if (outcome === 'exists') {
    // Lost the create race — read the winner (throws if now corrupt).
    const winner = readRecord(fp);
    if (!winner) throw new Error('idempotency claim race: winner vanished');
    if (winner.requestHash !== input.requestHash) throw new IdempotencyConflictError(winner);
    return { kind: 'existing', record: winner };
  }
  return { kind: 'won', record: rec };
}

/** CAS a record to a new state. Re-reads and verifies the on-disk revision
 *  matches `from.revision` before writing (rejects a stale writer). Returns the
 *  written record, or throws on mismatch/IO error. */
export function transition(
  ownerLarkAppId: string,
  key: string,
  from: IdempotencyRecord,
  patch: { state: IdempotencyState; outcome?: IdempotencyOutcome; ownerBootId?: string; now: number },
): IdempotencyRecord {
  const fp = fileFor(ownerLarkAppId, key);
  const current = readRecord(fp);
  if (!current) throw new Error('idempotency transition: record vanished');
  if (current.revision !== from.revision) {
    throw new Error(`idempotency CAS conflict: on-disk revision ${current.revision} != expected ${from.revision}`);
  }
  const next: IdempotencyRecord = {
    ...current,
    state: patch.state,
    outcome: patch.outcome,
    ownerBootId: patch.ownerBootId ?? current.ownerBootId,
    revision: current.revision + 1,
    updatedAt: patch.now,
  };
  writeAtomic(fp, next, /*expectNew*/ false);
  return next;
}

/** Take over an older-boot `reserved` lease for a fresh dispatch: overwrite it
 *  with a NEW reserved lease owned by this boot (new session/trigger). Safe only
 *  because a reserved record is provably pre-dispatch (attempting is written
 *  before any side effect). Verifies the on-disk record is still the same
 *  reserved revision before replacing. */
export function takeover(input: {
  ownerLarkAppId: string;
  key: string;
  from: IdempotencyRecord;
  sessionId: string;
  triggerId: string;
  requestHash: string;
  ownerBootId: string;
  now: number;
}): IdempotencyRecord {
  const fp = fileFor(input.ownerLarkAppId, input.key);
  const current = readRecord(fp);
  if (!current) {
    // Vanished between lookup and takeover → fall back to a fresh claim.
    const res = claim({ ...input, now: input.now });
    return res.record;
  }
  if (current.revision !== input.from.revision || current.state !== 'reserved') {
    throw new Error('idempotency takeover: lease changed under us');
  }
  const rec: IdempotencyRecord = {
    ownerLarkAppId: input.ownerLarkAppId,
    sessionId: input.sessionId,
    triggerId: input.triggerId,
    requestHash: input.requestHash,
    ownerBootId: input.ownerBootId,
    revision: current.revision + 1,
    state: 'reserved',
    createdAt: current.createdAt,
    updatedAt: input.now,
  };
  writeAtomic(fp, rec, /*expectNew*/ false);
  return rec;
}

/** Remove a mapping (used on rollback of a lease we created but abandoned, and
 *  by boot reconcile for pre-dispatch orphans). Idempotent. */
export function remove(ownerLarkAppId: string, key: string): void {
  try { const fp = fileFor(ownerLarkAppId, key); if (existsSync(fp)) unlinkSync(fp); }
  catch { /* ignore */ }
}

/** Enumerate every stored record for boot reconcile. Best-effort per file. */
export function listAll(): Array<{ file: string; record: IdempotencyRecord }> {
  const dir = getDir();
  if (!existsSync(dir)) return [];
  const out: Array<{ file: string; record: IdempotencyRecord }> = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const fp = join(dir, name);
    const rec = readRecordLenient(fp);
    if (rec) out.push({ file: fp, record: rec });
  }
  return out;
}

/** Reconcile-only: rewrite a record in place by its file path (the plaintext key
 *  isn't recoverable from the hashed filename, and reconcile already holds the
 *  path from listAll). */
export function writeAtomicByPath(fp: string, rec: IdempotencyRecord): void {
  ensureDir();
  const tmp = `${fp}.${process.pid}.${createHash('sha256').update(String(rec.updatedAt)).update(rec.sessionId).update(String(rec.revision)).digest('hex').slice(0, 12)}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(rec, null, 2), { encoding: 'utf-8', flag: 'wx' });
    try { if (existsSync(fp)) unlinkSync(fp); } catch { /* re-link surfaces */ }
    linkSync(tmp, fp);
  } finally {
    try { unlinkSync(tmp); } catch { /* gone */ }
  }
}

/** Reconcile-only: delete a record by file path. */
export function removeByPath(fp: string): void {
  try { if (existsSync(fp)) unlinkSync(fp); } catch { /* ignore */ }
}
