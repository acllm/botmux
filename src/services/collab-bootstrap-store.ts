/**
 * Durable journal for one DM-born collaboration bootstrap (issue #3588).
 *
 * The whole reason this file exists: group creation is an IRREVERSIBLE external
 * side effect, and the daemon can die at any point after it. Every step
 * therefore has a persisted state that a restart can resume from, and the
 * single most important field is `chatId` — written synchronously inside
 * `createGroupWithBots`' `onChatCreated` hook, i.e. BEFORE any invite, role or
 * kickoff work. Once it is on disk, retrying must reuse that chat and never
 * create a second one.
 *
 * Storage: one JSON file per request under
 * `{dataDir}/collab-bootstrap/<requestId>.json`, written atomically and
 * durably (0600), with a cross-process file lock around read-modify-write. One
 * file per request — not one shared map — because a read-modify-write of a
 * shared map loses updates when two writers (daemon + dashboard) touch
 * different requests concurrently. Same rationale as bot-profile-store.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';
import type { CollabGroupConfig } from '../bot-registry.js';
import { isValidCollabRequestId } from '../core/collab-role-protocol.js';
import { logger } from '../utils/logger.js';

/** Bounded history: a bootstrap is short-lived, and an unbounded directory is a
 *  slow disk leak on a machine that births many groups. Oldest are pruned first. */
export const MAX_COLLAB_JOURNALS = 200;

export type CollabMemberJoinState = 'pending' | 'joined' | 'failed';
export type CollabMemberRoleState = 'pending' | 'requested' | 'confirmed' | 'failed';
export type CollabMemberStartState = 'pending' | 'sent' | 'running' | 'completed' | 'failed';

export interface CollabMemberJournal {
  larkAppId: string;
  join: { state: CollabMemberJoinState; at?: number; error?: string };
  role: {
    state: CollabMemberRoleState;
    at?: number;
    confirmedAt?: number;
    appliedHash?: string;
    error?: string;
  };
  start: {
    state: CollabMemberStartState;
    at?: number;
    turnId?: string;
    error?: string;
    /** The kickoff message id, recorded only after the send succeeded. */
    kickoffMessageId?: string;
    /** In-flight send claim; expires so a crashed send is retried. */
    claim?: { at: number; ttlMs: number };
    /**
     * A terminal that arrived BEFORE we knew this stage's turnId.
     *
     * started and terminal are two independent IPC calls and can be reordered
     * in flight; a short turn can finish before its own "started" report lands.
     * At that moment the stage is `sent` with no turnId, so the fail-closed
     * identity check has nothing to match against — and dropping the terminal
     * loses the only proof the stage ever finished. Buffer it here and let the
     * later "started" report settle it.
     */
    pendingTerminal?: { turnId: string; status: 'completed' | 'failed' | 'cancelled' | 'ambiguous'; at: number };
  };
}

export type CollabBootstrapStatus = 'pending' | 'running' | 'ready' | 'failed' | 'cancelled';

export interface CollabBootstrapJournal {
  version: 1;
  requestId: string;
  /**
   * The bot whose daemon OWNS this bootstrap: it created the chat, it reads the
   * profile entries, and it is the only daemon allowed to resume the request.
   *
   * Required, not derived: every bot's daemon shares one dataDir, so a resume
   * sweep without an owner would have every daemon in the fleet try to run every
   * journal — each of them re-kicking stages in a chat it does not host.
   */
  ownerLarkAppId: string;
  /** The configuration this request froze. Later steps read THIS, not live
   *  config, so an edit mid-flight cannot change what an in-flight request does
   *  (it makes the request stale instead — see configFingerprint). */
  config: CollabGroupConfig;
  configFingerprint: string;
  sourceChatId: string;
  sourceMessageId: string;
  ownerOpenId: string;
  /** Written once, in onChatCreated. Presence = "never create a group again". */
  chatId?: string;
  createdAt: number;
  updatedAt: number;
  status: CollabBootstrapStatus;
  /** Why the request stopped. Set exactly when status is failed/cancelled. */
  failureReason?: string;
  members: Record<string, CollabMemberJournal>;
  cardMessageId?: string;
  dmReceiptMessageId?: string;
  /** The DM task text, kept so a retry after a restart can re-render prompts. */
  taskText: string;
  /**
   * ABSOLUTE epoch-ms deadline for the whole initialization, frozen when the
   * request is created.
   *
   * Absolute and persisted, not "now + budget" recomputed per pass: a recomputed
   * deadline would let every daemon restart grant the request a fresh budget,
   * so a stuck peer could keep it alive forever. Optional only for journals
   * written by an older build.
   */
  deadlineAt?: number;
  /** Absolute epoch-ms deadline for a dependent stage waiting on its upstream. */
  dependencyDeadlineAt?: number;
  /**
   * Single-flight claim over GROUP CREATION.
   *
   * Group creation is the one irreversible side effect, and two passes can
   * reach it concurrently (a resume sweep racing a turn report, or two daemons
   * after a restart). Both would see "no chatId" and each create a group. The
   * claim is taken inside the journal lock, so exactly one pass wins; a stale
   * claim (holder crashed) expires by `at + ttlMs`.
   */
  createClaim?: { at: number; ttlMs: number; by: string };
  attempts: number;
  /** Epoch ms before which no retry may run (backoff across restarts). */
  nextRetryAt?: number;
  /** Set when the progress card was cancelled by a human. */
  cancelledBy?: string;
}

export interface CollabQueueEntry {
  messageId: string;
  at: number;
  /** Which gate the message arrived through, for the visible status line. */
  reason: string;
}

export interface CollabBootstrapQueue {
  version: 1;
  requestId: string;
  entries: CollabQueueEntry[];
}

function rootDir(dataDir: string): string {
  return join(dataDir, 'collab-bootstrap');
}

export function collabJournalPath(dataDir: string, requestId: string): string {
  if (!isValidCollabRequestId(requestId)) throw new Error(`invalid collab request id: ${requestId}`);
  return join(rootDir(dataDir), `${requestId}.json`);
}

function queuePath(dataDir: string, requestId: string): string {
  if (!isValidCollabRequestId(requestId)) throw new Error(`invalid collab request id: ${requestId}`);
  return join(rootDir(dataDir), `${requestId}.queue.json`);
}

function chatsDir(dataDir: string): string {
  return join(rootDir(dataDir), 'chats');
}

/**
 * Per-chat index file: `collab-bootstrap/chats/<chatId>.json`.
 *
 * The message gate needs an O(1) answer for "is there a live bootstrap in THIS
 * chat?" on every inbound message of every group in the fleet. Deriving that
 * from a directory scan has two defects that no amount of caching fixes:
 *
 *  - blast radius: one unreadable historical journal makes "we cannot prove
 *    there is none" true for EVERY chat, freezing every group's message path;
 *  - staleness: a cache keyed on stat metadata can be defeated by a rewrite
 *    that preserves the tuple, so a terminal transition could stay invisible.
 *
 * A per-chat file answers exactly the chat being asked about, needs no scan and
 * no cache, and confines a corrupt record to its own chat.
 */
export function collabChatIndexPath(dataDir: string, chatId: string): string {
  // chat ids are `oc_…`; the regex keeps a malformed id from escaping the dir.
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(chatId)) throw new Error(`invalid chat id: ${chatId}`);
  return join(chatsDir(dataDir), `${chatId}.json`);
}

export interface CollabChatIndexEntry {
  version: 1;
  requestId: string;
  ownerLarkAppId: string;
  status: CollabBootstrapStatus;
  updatedAt: number;
}

function writeChatIndex(
  dataDir: string,
  chatId: string,
  requestId: string,
  ownerLarkAppId: string,
  status: CollabBootstrapStatus,
  now: number,
): void {
  const path = collabChatIndexPath(dataDir, chatId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const entry: CollabChatIndexEntry = { version: 1, requestId, ownerLarkAppId, status, updatedAt: now };
  atomicWriteFileSync(path, JSON.stringify(entry), { mode: 0o600, durable: true, followTargetSymlink: false });
}

function readChatIndex(dataDir: string, chatId: string): CollabChatIndexEntry | null | { corrupt: string } {
  const path = collabChatIndexPath(dataDir, chatId);
  if (!existsSync(path)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (!isRecord(raw) || raw.version !== 1 || !isValidCollabRequestId(raw.requestId)
      || typeof raw.ownerLarkAppId !== 'string' || !raw.ownerLarkAppId
      || !STATUSES.includes(raw.status as CollabBootstrapStatus)) {
      return { corrupt: 'invalid chat index' };
    }
    return {
      version: 1,
      requestId: raw.requestId,
      ownerLarkAppId: raw.ownerLarkAppId,
      status: raw.status as CollabBootstrapStatus,
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
    };
  } catch (err) {
    return { corrupt: String((err as Error)?.message ?? err) };
  }
}

/**
 * Keep the per-chat index in step with its journal.
 *
 * Written on the same code path as the journal itself, so there is no window
 * where one is updated and the other is not. A terminal status REMOVES the
 * index: after that the chat is an ordinary group again, and leaving a stale
 * `running` marker behind would keep the gate closed forever.
 */
function syncChatIndex(dataDir: string, journal: CollabBootstrapJournal, now: number): void {
  if (!journal.chatId) return;
  // The index is written for TERMINAL statuses too, never deleted.
  //
  // That is what makes "no index file" mean exactly one thing: this chat has
  // never had a bootstrap. Deleting on terminal would make a hand-deleted or
  // half-written index indistinguishable from "never configured", which is how
  // a live journal could silently stop holding its chat's messages.
  writeChatIndex(dataDir, journal.chatId, journal.requestId, journal.ownerLarkAppId, journal.status, now);
}

/**
 * Rebuild missing/incorrect per-chat indices from the authoritative journals.
 *
 * Runs once at daemon boot, NOT per message: the index can be lost (manual
 * delete, half-written atomic replace, a restored data dir), and without this
 * repair a live journal would silently stop holding its chat's messages. Doing
 * it per message would put a directory scan on the hot path, which is the whole
 * thing the index exists to avoid.
 */
export function reconcileCollabChatIndices(dataDir: string): number {
  let repaired = 0;
  const scan = scanCollabJournals(dataDir);
  for (const journal of scan.journals) {
    if (!journal.chatId) continue;
    const index = readChatIndex(dataDir, journal.chatId);
    const expected = journal.status;
    const actual = index && !('corrupt' in index) ? index.status : undefined;
    const sameRequest = index && !('corrupt' in index) ? index.requestId === journal.requestId : false;
    if (actual === expected && sameRequest) continue;
    try {
      writeChatIndex(dataDir, journal.chatId, journal.requestId, journal.ownerLarkAppId, journal.status, Date.now());
      repaired += 1;
    } catch (err) {
      logger.warn(`[collab] index repair for ${journal.chatId} failed: ${err}`);
    }
  }
  if (repaired > 0) logger.info(`[collab] repaired ${repaired} chat indices from journals`);
  return repaired;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const JOIN_STATES: readonly CollabMemberJoinState[] = ['pending', 'joined', 'failed'];
const ROLE_STATES: readonly CollabMemberRoleState[] = ['pending', 'requested', 'confirmed', 'failed'];
const START_STATES: readonly CollabMemberStartState[] = ['pending', 'sent', 'running', 'completed', 'failed'];
const STATUSES: readonly CollabBootstrapStatus[] = ['pending', 'running', 'ready', 'failed', 'cancelled'];

/**
 * Validate a journal read back from disk.
 *
 * A corrupt journal must NOT be silently treated as "no request": that would
 * let a retry create a SECOND group for a task that already has one. Callers
 * get `null` only for a genuinely absent file; anything unparseable throws, and
 * the caller fails the request loudly (the group, if any, stays in the chat for
 * a human to look at).
 */
function parseJournal(raw: unknown): CollabBootstrapJournal | null {
  if (!isRecord(raw)) return null;
  if (raw.version !== 1) return null;
  if (!isValidCollabRequestId(raw.requestId)) return null;
  if (typeof raw.ownerLarkAppId !== 'string' || !raw.ownerLarkAppId) return null;
  if (typeof raw.sourceChatId !== 'string' || typeof raw.sourceMessageId !== 'string') return null;
  if (typeof raw.ownerOpenId !== 'string') return null;
  if (typeof raw.createdAt !== 'number' || typeof raw.updatedAt !== 'number') return null;
  if (!STATUSES.includes(raw.status as CollabBootstrapStatus)) return null;
  if (typeof raw.configFingerprint !== 'string' || !raw.configFingerprint) return null;
  if (typeof raw.taskText !== 'string') return null;
  if (!isRecord(raw.config)) return null;
  if (!isRecord(raw.members)) return null;
  if (raw.chatId !== undefined && typeof raw.chatId !== 'string') return null;
  if (raw.attempts !== undefined && typeof raw.attempts !== 'number') return null;
  if (raw.deadlineAt !== undefined && typeof raw.deadlineAt !== 'number') return null;
  if (raw.dependencyDeadlineAt !== undefined && typeof raw.dependencyDeadlineAt !== 'number') return null;
  if (raw.createClaim !== undefined) {
    const c = raw.createClaim;
    if (!isRecord(c) || typeof c.at !== 'number' || typeof c.ttlMs !== 'number' || typeof c.by !== 'string') return null;
  }

  const members: Record<string, CollabMemberJournal> = {};
  for (const [id, value] of Object.entries(raw.members)) {
    if (!isRecord(value)) return null;
    const joinState = value.join;
    const roleState = value.role;
    const startState = value.start;
    if (!isRecord(joinState) || !JOIN_STATES.includes(joinState.state as CollabMemberJoinState)) return null;
    if (!isRecord(roleState) || !ROLE_STATES.includes(roleState.state as CollabMemberRoleState)) return null;
    if (!isRecord(startState) || !START_STATES.includes(startState.state as CollabMemberStartState)) return null;
    members[id] = {
      larkAppId: typeof value.larkAppId === 'string' ? value.larkAppId : id,
      join: {
        state: joinState.state as CollabMemberJoinState,
        ...(typeof joinState.at === 'number' ? { at: joinState.at } : {}),
        ...(typeof joinState.error === 'string' ? { error: joinState.error } : {}),
      },
      role: {
        state: roleState.state as CollabMemberRoleState,
        ...(typeof roleState.at === 'number' ? { at: roleState.at } : {}),
        ...(typeof roleState.confirmedAt === 'number' ? { confirmedAt: roleState.confirmedAt } : {}),
        ...(typeof roleState.appliedHash === 'string' ? { appliedHash: roleState.appliedHash } : {}),
        ...(typeof roleState.error === 'string' ? { error: roleState.error } : {}),
      },
      start: {
        state: startState.state as CollabMemberStartState,
        ...(typeof startState.at === 'number' ? { at: startState.at } : {}),
        ...(typeof startState.turnId === 'string' ? { turnId: startState.turnId } : {}),
        ...(typeof startState.error === 'string' ? { error: startState.error } : {}),
        ...(typeof startState.kickoffMessageId === 'string' ? { kickoffMessageId: startState.kickoffMessageId } : {}),
        ...(isRecord(startState.claim) && typeof startState.claim.at === 'number' && typeof startState.claim.ttlMs === 'number'
          ? { claim: { at: startState.claim.at, ttlMs: startState.claim.ttlMs } }
          : {}),
        ...(isRecord(startState.pendingTerminal)
          && typeof startState.pendingTerminal.turnId === 'string'
          && typeof startState.pendingTerminal.at === 'number'
          && ['completed', 'failed', 'cancelled', 'ambiguous'].includes(startState.pendingTerminal.status as string)
          ? {
            pendingTerminal: {
              turnId: startState.pendingTerminal.turnId,
              status: startState.pendingTerminal.status as 'completed' | 'failed' | 'cancelled' | 'ambiguous',
              at: startState.pendingTerminal.at,
            },
          }
          : {}),
      },
    };
  }

  return {
    version: 1,
    requestId: raw.requestId,
    ownerLarkAppId: raw.ownerLarkAppId,
    config: raw.config as unknown as CollabGroupConfig,
    configFingerprint: raw.configFingerprint,
    sourceChatId: raw.sourceChatId,
    sourceMessageId: raw.sourceMessageId,
    ownerOpenId: raw.ownerOpenId,
    ...(typeof raw.chatId === 'string' ? { chatId: raw.chatId } : {}),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    status: raw.status as CollabBootstrapStatus,
    ...(typeof raw.failureReason === 'string' ? { failureReason: raw.failureReason } : {}),
    members,
    ...(typeof raw.cardMessageId === 'string' ? { cardMessageId: raw.cardMessageId } : {}),
    ...(typeof raw.dmReceiptMessageId === 'string' ? { dmReceiptMessageId: raw.dmReceiptMessageId } : {}),
    taskText: raw.taskText,
    ...(typeof raw.deadlineAt === 'number' ? { deadlineAt: raw.deadlineAt } : {}),
    ...(typeof raw.dependencyDeadlineAt === 'number' ? { dependencyDeadlineAt: raw.dependencyDeadlineAt } : {}),
    ...(isRecord(raw.createClaim)
      ? { createClaim: raw.createClaim as unknown as CollabBootstrapJournal['createClaim'] }
      : {}),
    attempts: typeof raw.attempts === 'number' ? raw.attempts : 0,
    ...(typeof raw.nextRetryAt === 'number' ? { nextRetryAt: raw.nextRetryAt } : {}),
    ...(typeof raw.cancelledBy === 'string' ? { cancelledBy: raw.cancelledBy } : {}),
  };
}

function writeJournalFile(path: string, journal: CollabBootstrapJournal): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(path, JSON.stringify(journal), { mode: 0o600, durable: true, followTargetSymlink: false });
}

/** Read one journal. `null` = absent. Throws on a corrupt file (see parseJournal). */
export function readCollabJournal(dataDir: string, requestId: string): CollabBootstrapJournal | null {
  const path = collabJournalPath(dataDir, requestId);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    // Unparseable is a DIFFERENT failure from absent: absent means "create the
    // request", corrupt means "a request existed and we can no longer tell what
    // it did". Collapsing the two is how a retry creates a second group.
    throw new Error(`corrupt collab journal: ${path} (${(err as Error)?.message ?? err})`);
  }
  const parsed = parseJournal(raw);
  if (!parsed) throw new Error(`corrupt collab journal: ${path}`);
  return parsed;
}

/**
 * Read-modify-write one journal under the file lock.
 *
 * `mutate` returns `false` to abort without writing (e.g. the request was
 * cancelled between the caller's decision and this write) — the caller then
 * gets `null` and must NOT proceed with the side effect it was about to make.
 * This is the fence that stops a cancelled request from kicking off a turn.
 */
export function updateCollabJournal(
  dataDir: string,
  requestId: string,
  mutate: (journal: CollabBootstrapJournal) => boolean | void,
  now: () => number = Date.now,
): CollabBootstrapJournal | null {
  const path = collabJournalPath(dataDir, requestId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return withFileLockSync(path, () => {
    const journal = readCollabJournal(dataDir, requestId);
    if (!journal) return null;
    if (mutate(journal) === false) return null;
    journal.updatedAt = now();
    writeJournalFile(path, journal);
    syncChatIndex(dataDir, journal, now());
    invalidateCollabJournalListing();
    return journal;
  });
}

export function createCollabJournal(
  dataDir: string,
  journal: Omit<CollabBootstrapJournal, 'version' | 'updatedAt' | 'attempts'> & { attempts?: number },
  now: () => number = Date.now,
): CollabBootstrapJournal {
  const path = collabJournalPath(dataDir, journal.requestId);
  const full: CollabBootstrapJournal = {
    ...journal,
    version: 1,
    updatedAt: journal.createdAt,
    attempts: journal.attempts ?? 0,
  } as CollabBootstrapJournal;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  withFileLockSync(path, () => writeJournalFile(path, full));
  syncChatIndex(dataDir, full, full.createdAt);
  invalidateCollabJournalListing();
  pruneCollabJournals(dataDir);
  return full;
}

/**
 * Per-FILE parse cache.
 *
 * Two hard requirements pull in opposite directions here:
 *
 *  - `findLiveCollabJournalForChat` runs on every inbound message of every
 *    session group, so parsing up to MAX_COLLAB_JOURNALS files per message is
 *    not acceptable.
 *  - The cache must never answer from a stale generation. A whole-directory
 *    cache keyed on the directory's mtime does exactly that: rewriting an
 *    EXISTING journal in place (a terminal transition, a human edit, corruption)
 *    does not change the directory's mtime, so a cached `pending` would outlive
 *    the real `failed` — keeping the gate closed forever and hiding the terminal
 *    from the resume sweep.
 *
 * So: cache per file, keyed on its own `mtimeMs:size`, and never cache a parse
 * FAILURE as "absent" — a corrupt file is remembered as corrupt so the gate can
 * fail closed instead of reading it as "no bootstrap here".
 */
interface JournalFileCacheEntry {
  signature: string;
  journal?: CollabBootstrapJournal;
  /** Present exactly when the file exists but does not parse/validate. */
  corrupt?: string;
}
const journalFileCache = new Map<string, JournalFileCacheEntry>();

/** Drop all memoized parses (also called after our own writes). */
export function invalidateCollabJournalListing(): void {
  journalFileCache.clear();
}

function fileSignature(path: string): string | null {
  try {
    const st = statSync(path);
    return `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch {
    return null;
  }
}

function readJournalCached(path: string): JournalFileCacheEntry {
  const signature = fileSignature(path);
  if (signature === null) return { signature: 'absent' };
  const hit = journalFileCache.get(path);
  if (hit && hit.signature === signature) return hit;
  let entry: JournalFileCacheEntry;
  try {
    const parsed = parseJournal(JSON.parse(readFileSync(path, 'utf-8')));
    entry = parsed
      ? { signature, journal: parsed }
      : { signature, corrupt: 'invalid journal shape' };
  } catch (err) {
    entry = { signature, corrupt: String((err as Error)?.message ?? err) };
  }
  journalFileCache.set(path, entry);
  return entry;
}

/** Request ids present on disk, newest filename order. Cheap: names only. */
function listJournalIds(dataDir: string): string[] {
  let names: string[];
  try { names = readdirSync(rootDir(dataDir)); } catch { return []; }
  const out: string[] = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name.endsWith('.queue.json')) continue;
    const requestId = name.slice(0, -'.json'.length);
    if (isValidCollabRequestId(requestId)) out.push(requestId);
  }
  return out;
}

export interface CollabJournalScan {
  journals: CollabBootstrapJournal[];
  /** Request ids whose file exists but cannot be read. */
  corruptRequestIds: string[];
}

/**
 * Scan every journal, newest first, reporting corrupt files instead of hiding
 * them. Callers that make a SAFETY decision (the message gate, the resume
 * sweep) must use {@link scanCollabJournals} so an unreadable record cannot be
 * mistaken for "no request".
 */
export function scanCollabJournals(dataDir: string): CollabJournalScan {
  const journals: CollabBootstrapJournal[] = [];
  const corruptRequestIds: string[] = [];
  for (const requestId of listJournalIds(dataDir)) {
    const entry = readJournalCached(collabJournalPath(dataDir, requestId));
    if (entry.journal) journals.push(entry.journal);
    else if (entry.corrupt) {
      corruptRequestIds.push(requestId);
      logger.warn(`[collab] unreadable journal ${requestId}: ${entry.corrupt}`);
    }
  }
  journals.sort((a, b) => b.createdAt - a.createdAt);
  return { journals, corruptRequestIds };
}

/** Every journal currently on disk, newest first. Corrupt files are skipped
 *  here; use {@link scanCollabJournals} when the answer drives a safety gate. */
export function listCollabJournals(dataDir: string): CollabBootstrapJournal[] {
  return scanCollabJournals(dataDir).journals;
}

/**
 * Requests a restarted daemon must pick back up: anything not terminal AND
 * owned by THIS bot. Ownership matters because the dataDir is shared by the
 * whole fleet — without it every daemon would resume every journal.
 */
export function listResumableCollabJournals(
  dataDir: string,
  ownerLarkAppId: string,
): CollabBootstrapJournal[] {
  return listCollabJournals(dataDir).filter(j =>
    j.ownerLarkAppId === ownerLarkAppId && (j.status === 'pending' || j.status === 'running'));
}

/**
 * Result of asking "is there a live bootstrap for this chat?".
 *
 * THREE states, not two. `unknown` is a real answer: a journal file for this
 * chat exists but cannot be read. Collapsing that into `none` is how an
 * unreadable record lets a not-yet-ready group start a CLI — "we do not know"
 * must never be treated as "there is nothing to wait for".
 */
export type LiveCollabLookup =
  | { state: 'none' }
  | { state: 'live'; journal: CollabBootstrapJournal }
  | { state: 'unknown'; reason: string };

/**
 * Is there a live bootstrap for this chat?
 *
 * Answered from the PER-CHAT INDEX, not from a directory scan, for three
 * reasons that are each a bug the scan had:
 *
 *  - O(1) on the hot path. This runs on every inbound message of every group in
 *    the fleet; a scan is a directory walk plus N parses per message.
 *  - No blast radius. An unreadable historical journal for ANOTHER chat cannot
 *    make this chat's answer "unknown", so one bad file cannot freeze every
 *    group's message path.
 *  - No staleness window. There is no cache to be defeated by a rewrite that
 *    preserves stat metadata; the index is read fresh and written on the same
 *    code path as the journal.
 *
 * `unknown` still exists — but only when THIS chat's own record is unreadable,
 * which is genuinely "cannot prove there is no bootstrap here".
 */
export function lookupLiveCollabForChat(
  dataDir: string,
  chatId: string,
  ownerLarkAppId?: string,
): LiveCollabLookup {
  let index: ReturnType<typeof readChatIndex>;
  try {
    index = readChatIndex(dataDir, chatId);
  } catch (err) {
    return { state: 'unknown', reason: `invalid chat id: ${(err as Error)?.message ?? err}` };
  }
  if (index === null) {
    // No index file. Indices are written for terminal statuses too and repaired
    // from journals at boot, so "absent" means exactly one thing: this chat has
    // never had a bootstrap. Answering `none` here is therefore safe AND keeps
    // an unreadable journal for some OTHER chat from freezing this one.
    return { state: 'none' };
  }
  if ('corrupt' in index) {
    return { state: 'unknown', reason: `unreadable index for ${chatId}: ${index.corrupt}` };
  }
  if (ownerLarkAppId !== undefined && index.ownerLarkAppId !== ownerLarkAppId) {
    return { state: 'none' };
  }
  // The index is a pointer; the journal is the authority. Read it so a caller
  // gets the current step states (and so a terminal journal whose index was not
  // yet cleared cannot hold a group hostage).
  let journal: CollabBootstrapJournal | null;
  try {
    journal = readCollabJournal(dataDir, index.requestId);
  } catch (err) {
    return { state: 'unknown', reason: `unreadable journal ${index.requestId}: ${(err as Error)?.message ?? err}` };
  }
  if (!journal) return { state: 'none' };
  if (journal.chatId !== chatId) {
    // Index points at a journal for a different chat: the index is wrong, and
    // we cannot prove there is no bootstrap here.
    return { state: 'unknown', reason: `index/journal chat mismatch for ${chatId}` };
  }
  if (journal.status !== 'pending' && journal.status !== 'running') return { state: 'none' };
  return { state: 'live', journal };
}

/**
 * Backwards-compatible thin wrapper: the journal, or undefined when there is
 * provably none. Callers that gate a side effect must use
 * {@link lookupLiveCollabForChat} — this one cannot express `unknown`.
 */
export function findLiveCollabJournalForChat(
  dataDir: string,
  chatId: string,
  ownerLarkAppId?: string,
): CollabBootstrapJournal | undefined {
  const r = lookupLiveCollabForChat(dataDir, chatId, ownerLarkAppId);
  return r.state === 'live' ? r.journal : undefined;
}

/**
 * Move an unreadable journal out of the live directory into `quarantine/`.
 *
 * Kept, not deleted: a corrupt record is the only evidence of a request whose
 * outcome is unknown, and deleting it is how "we cannot tell" becomes "nothing
 * happened". Moving it keeps the live directory scannable and stops the same
 * file from being re-warned on every create.
 */
function quarantineCorrupt(dataDir: string, requestId: string): void {
  const from = collabJournalPath(dataDir, requestId);
  const dir = join(rootDir(dataDir), 'quarantine');
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const to = join(dir, `${requestId}.json`);
    if (existsSync(to)) unlinkSync(to);
    renameSync(from, to);
    journalFileCache.delete(from);
    logger.warn(`[collab] quarantined unreadable journal ${requestId} -> ${to}`);
  } catch (err) {
    logger.warn(`[collab] quarantine of ${requestId} failed: ${err}`);
  }
}

function pruneCollabJournals(dataDir: string): void {
  const scan = scanCollabJournals(dataDir);
  // Corrupt files are quarantined first: they are neither live nor prunable, and
  // leaving them in place both hides them from the cap and re-warns forever.
  for (const requestId of scan.corruptRequestIds) quarantineCorrupt(dataDir, requestId);
  const all = scan.journals;
  if (all.length <= MAX_COLLAB_JOURNALS) return;
  // Only TERMINAL requests are prunable. A live one may be waiting on a long
  // turn: deleting it would lose the journal, the queue and the ability to
  // resume — the group would look initialized while a stage never started, and
  // the terminal report would have nowhere to land.
  const prunable = all.filter(j => j.status !== 'pending' && j.status !== 'running');
  const overflow = all.length - MAX_COLLAB_JOURNALS;
  for (const stale of prunable.slice(-overflow)) {
    try {
      unlinkSync(collabJournalPath(dataDir, stale.requestId));
      journalFileCache.delete(collabJournalPath(dataDir, stale.requestId));
      const q = queuePath(dataDir, stale.requestId);
      if (existsSync(q)) unlinkSync(q);
    } catch (err) {
      logger.warn(`[collab] prune ${stale.requestId} failed: ${err}`);
    }
  }
  const live = all.length - prunable.length;
  if (live > MAX_COLLAB_JOURNALS) {
    // Never delete live state to satisfy a history cap; say so instead of
    // silently growing or silently dropping work.
    logger.warn(`[collab] ${live} live bootstraps exceed the ${MAX_COLLAB_JOURNALS} history cap; none were pruned`);
  }
}

// ─── Message queue for a not-yet-ready group ────────────────────────────────
//
// While a group's bootstrap is not `ready`, inbound messages are QUEUED rather
// than dropped: a silent drop in Feishu reads as "the bot ignored me", which is
// worse than an explicit "initializing, your message is queued" notice.

export interface CollabQueueRead {
  queue: CollabBootstrapQueue;
  /** Set when the file exists but cannot be parsed — callers must NOT write. */
  corrupt?: string;
}

/**
 * Read a queue, distinguishing "empty" from "unreadable".
 *
 * A corrupt queue read as empty is data loss: the next enqueue would atomically
 * REPLACE the file, silently dropping every message the group already told the
 * user it had queued.
 */
export function readCollabQueueState(dataDir: string, requestId: string): CollabQueueRead {
  const path = queuePath(dataDir, requestId);
  if (!existsSync(path)) return { queue: { version: 1, requestId, entries: [] } };
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.entries)) {
      return { queue: { version: 1, requestId, entries: [] }, corrupt: 'invalid queue shape' };
    }
    const entries: CollabQueueEntry[] = [];
    for (const e of raw.entries) {
      if (!isRecord(e) || typeof e.messageId !== 'string') {
        return { queue: { version: 1, requestId, entries: [] }, corrupt: 'invalid queue entry' };
      }
      entries.push({
        messageId: e.messageId,
        at: typeof e.at === 'number' ? e.at : 0,
        reason: typeof e.reason === 'string' ? e.reason : 'initializing',
      });
    }
    return { queue: { version: 1, requestId, entries } };
  } catch (err) {
    return { queue: { version: 1, requestId, entries: [] }, corrupt: String((err as Error)?.message ?? err) };
  }
}

/** Convenience read that treats corruption as empty — for DISPLAY only. */
export function readCollabQueue(dataDir: string, requestId: string): CollabBootstrapQueue {
  return readCollabQueueState(dataDir, requestId).queue;
}

/**
 * Append one message, refusing to overwrite an unreadable queue.
 *
 * Returns `false` when nothing was written, so the caller can fall through to
 * normal routing instead of promising a queue slot it did not get.
 */
export type CollabEnqueueResult =
  /** Appended (or already present — idempotent on messageId). */
  | { ok: true; alreadyPresent: boolean }
  /** The request reached a terminal state before we could take the message. */
  | { ok: false; reason: 'terminal' }
  /** The backlog exists but cannot be read; nothing was written. */
  | { ok: false; reason: 'corrupt' };

/**
 * Append one message, atomically with respect to the request's terminal state.
 *
 * The gate reads the journal, decides "not ready", then appends. A terminal
 * transition can land between those two steps, drain the (empty) queue, and the
 * append then succeeds — promising the user a queue slot that nothing will ever
 * drain. So the append re-checks the journal INSIDE the queue lock and refuses
 * if the request already finished; the caller then treats the message as
 * un-held instead of silently stranding it.
 */
export function enqueueCollabMessage(
  dataDir: string,
  requestId: string,
  entry: CollabQueueEntry,
): CollabEnqueueResult {
  const path = queuePath(dataDir, requestId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return withFileLockSync(path, () => {
    // Re-read the authority under the lock: this is the TOCTOU fence.
    let journal: CollabBootstrapJournal | null = null;
    try {
      journal = readCollabJournal(dataDir, requestId);
    } catch {
      return { ok: false, reason: 'corrupt' };
    }
    if (!journal) return { ok: false, reason: 'terminal' };
    if (journal.status !== 'pending' && journal.status !== 'running') {
      return { ok: false, reason: 'terminal' };
    }
    const read = readCollabQueueState(dataDir, requestId);
    if (read.corrupt) {
      logger.warn(`[collab] queue ${requestId} is unreadable (${read.corrupt}); refusing to append`);
      return { ok: false, reason: 'corrupt' };
    }
    // Idempotent on messageId: a redelivered event must not queue twice.
    if (read.queue.entries.some(e => e.messageId === entry.messageId)) {
      return { ok: true, alreadyPresent: true };
    }
    read.queue.entries.push(entry);
    atomicWriteFileSync(path, JSON.stringify(read.queue), { mode: 0o600, durable: true, followTargetSymlink: false });
    return { ok: true, alreadyPresent: false };
  });
}

export interface CollabQueueDrain {
  entries: CollabQueueEntry[];
  /** Set when the backlog could not be read; the file is LEFT IN PLACE. */
  corrupt?: string;
}

/**
 * Take and clear the queue, in arrival order.
 *
 * A corrupt backlog is NOT deleted. The group already told the user those
 * messages were queued, so silently unlinking the file destroys both the work
 * and the evidence — and reports "0 queued" while the user remembers otherwise.
 * The caller announces the corruption instead.
 */
export function drainCollabQueue(dataDir: string, requestId: string): CollabQueueDrain {
  const path = queuePath(dataDir, requestId);
  if (!existsSync(path)) return { entries: [] };
  return withFileLockSync(path, () => {
    const read = readCollabQueueState(dataDir, requestId);
    if (read.corrupt) {
      logger.warn(`[collab] queue ${requestId} is unreadable (${read.corrupt}); keeping it for recovery`);
      return { entries: [], corrupt: read.corrupt };
    }
    try { unlinkSync(path); } catch { /* already gone */ }
    return { entries: read.queue.entries };
  });
}

/** Drop a queued request's backlog (cancelled / failed bootstrap). */
export function clearCollabQueue(dataDir: string, requestId: string): void {
  const path = queuePath(dataDir, requestId);
  try { unlinkSync(path); } catch { /* already gone */ }
}
