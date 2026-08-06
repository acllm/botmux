/**
 * Idempotency store — durably maps a caller-provided `options.idempotencyKey`
 * (scoped per owning bot) to the botmux sessionId + triggerId that first served
 * it, so a retried `/api/trigger` with the same key returns the SAME session
 * instead of creating a new one and re-dispatching the turn.
 *
 * Why this exists: an async caller (e.g. the riff task runner) that loses the
 * `/api/trigger` HTTP response — the daemon already created the session, but the
 * ACK never arrived — will retry. Without idempotency the retry builds a brand
 * new session and the turn runs twice (duplicate external side effects: two
 * messages sent, a migration run twice, etc.). The caller's own dedup can't
 * prevent this because the first session is genuinely already executing.
 *
 * Contract: the key is scoped to (ownerLarkAppId, key) so two bots' identical
 * keys never collide, and a request routed to daemon A carrying bot B's key is
 * rejected fail-closed via the stamped owner (mirrors async-trigger-store).
 *
 * On-disk shape mirrors async-trigger-store: atomic tmp+rename under
 * {dataDir}/idempotency/{sha256(ownerLarkAppId\0key)}.json. Hashing the filename
 * keeps arbitrary caller key bytes out of the filesystem path (path traversal /
 * length / illegal chars) while staying a pure function of (owner, key).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export interface IdempotencyRecord {
  /** botmux sessionId that first served this key. */
  sessionId: string;
  /** triggerId of that first dispatch (stable — reused on every hit). */
  triggerId: string;
  /** Owning bot's larkAppId — stamps the record so a cross-bot lookup for the
   *  same key is rejected (an unstamped record is un-attributable). */
  ownerLarkAppId: string;
  createdAt: number;
}

function getDir(): string {
  return join(config.session.dataDir, 'idempotency');
}

/** Filename is sha256 of (owner \0 key) — a pure function of the pair that never
 *  lets caller bytes reach the path. NUL separator prevents (a,bc) colliding
 *  with (ab,c). */
function getFilePath(ownerLarkAppId: string, key: string): string {
  const digest = createHash('sha256').update(ownerLarkAppId).update('\0').update(key).digest('hex');
  return join(getDir(), `${digest}.json`);
}

function ensureDir(): void {
  const dir = getDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Read the record for (owner, key), or undefined if none / unreadable /
 *  owner-mismatch. Owner mismatch is treated as absent (fail-closed): a stored
 *  record whose stamped owner isn't this bot must never be reused. */
export function lookup(ownerLarkAppId: string, key: string): IdempotencyRecord | undefined {
  const fp = getFilePath(ownerLarkAppId, key);
  if (!existsSync(fp)) return undefined;
  try {
    const data = JSON.parse(readFileSync(fp, 'utf-8')) as IdempotencyRecord;
    if (!data || typeof data !== 'object' || typeof data.sessionId !== 'string' || typeof data.triggerId !== 'string') {
      return undefined;
    }
    if (data.ownerLarkAppId !== ownerLarkAppId) return undefined; // cross-bot: treat as absent
    return data;
  } catch (err) {
    logger.debug(`Failed to load idempotency record: ${err}`);
    return undefined;
  }
}

/**
 * Atomically claim (owner, key) for a record. Uses link(2) with O_EXCL semantics
 * (writeFileSync flag:'wx' to a temp, then linkSync) so that if two concurrent
 * dispatches race the SAME key, exactly one wins the create; the loser reads the
 * winner's record and reuses it. Returns the record actually in force after the
 * call — the freshly-claimed one on win, or the existing one on loss.
 *
 * The caller MUST treat a returned record whose sessionId != the one it was
 * about to create as "someone else won — reuse theirs, abandon mine".
 */
export function claim(record: IdempotencyRecord, key: string): IdempotencyRecord {
  ensureDir();
  const fp = getFilePath(record.ownerLarkAppId, key);
  // Fast path: already claimed.
  const existing = lookup(record.ownerLarkAppId, key);
  if (existing) return existing;
  const tmp = `${fp}.${process.pid}.${createHash('sha256').update(String(record.createdAt)).update(record.sessionId).digest('hex').slice(0, 12)}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(record, null, 2), { encoding: 'utf-8', flag: 'wx' });
    try {
      linkSync(tmp, fp); // atomic; EEXIST if a concurrent writer won
      return record;
    } catch {
      // Lost the race (EEXIST) or link failed — prefer the persisted winner.
      const raced = lookup(record.ownerLarkAppId, key);
      return raced ?? record;
    }
  } catch (err) {
    // wx temp collision or write failure — fall back to whatever is on disk, else
    // our own record (best-effort: a failed persist only loses cross-restart dedup).
    logger.debug(`Failed to claim idempotency record: ${err}`);
    return lookup(record.ownerLarkAppId, key) ?? record;
  } finally {
    try { unlinkSync(tmp); } catch { /* already gone / never created */ }
  }
}

/** Remove the mapping for (owner, key) — called when the mapped session closes,
 *  so keys don't accumulate unbounded. Idempotent. */
export function remove(ownerLarkAppId: string, key: string): void {
  const fp = getFilePath(ownerLarkAppId, key);
  try { if (existsSync(fp)) unlinkSync(fp); } catch { /* ignore */ }
}
