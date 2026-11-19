/**
 * Collaboration bootstrap journal: durability, fencing, ownership, queue.
 *
 * These pin the failure shapes the design calls out: a corrupt journal must not
 * read as "no request" (that would let a retry create a second group), and a
 * cancelled request must fence off the side effect that was about to happen.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  clearCollabQueue,
  collabJournalPath,
  createCollabJournal,
  drainCollabQueue,
  enqueueCollabMessage,
  findLiveCollabJournalForChat,
  listCollabJournals,
  listResumableCollabJournals,
  lookupLiveCollabForChat,
  collabChatIndexPath,
  reconcileCollabChatIndices,
  MAX_COLLAB_JOURNALS,
  readCollabJournal,
  readCollabQueue,
  readCollabQueueState,
  updateCollabJournal,
} from '../src/services/collab-bootstrap-store.js';
import type { CollabGroupConfig } from '../src/bot-registry.js';

const REQ = 'a1b2c3d4e5f60718';
const REQ2 = 'b1b2c3d4e5f60719';
const OWNER = 'cli_owner00001';
const PEER = 'cli_peer000001';
const CHAT = 'oc_collab_chat_0001';

const CONFIG: CollabGroupConfig = {
  enabled: true,
  profileId: 'dev-pair',
  members: [{ larkAppId: PEER, stage: 'builder', prompt: '实现 {task}' }],
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'botmux-collab-store-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seed(requestId = REQ, overrides: Partial<Parameters<typeof createCollabJournal>[1]> = {}) {
  return createCollabJournal(dir, {
    requestId,
    ownerLarkAppId: OWNER,
    config: CONFIG,
    configFingerprint: 'sha256:cfg',
    sourceChatId: 'oc_dm_source',
    sourceMessageId: 'om_source',
    ownerOpenId: 'ou_owner',
    createdAt: 1_000,
    status: 'pending',
    members: {
      [PEER]: {
        larkAppId: PEER,
        join: { state: 'pending' },
        role: { state: 'pending' },
        start: { state: 'pending' },
      },
    },
    taskText: '把这条任务做完',
    ...overrides,
  });
}

describe('collab journal', () => {
  it('round-trips every step state', () => {
    seed();
    const updated = updateCollabJournal(dir, REQ, j => {
      j.chatId = CHAT;
      j.members[PEER].join = { state: 'joined', at: 10 };
      j.members[PEER].role = { state: 'confirmed', at: 11, confirmedAt: 11, appliedHash: 'sha256:x' };
      j.members[PEER].start = { state: 'sent', at: 12, turnId: 'turn-1' };
      j.status = 'running';
    });
    expect(updated).not.toBeNull();
    const read = readCollabJournal(dir, REQ)!;
    expect(read.chatId).toBe(CHAT);
    expect(read.members[PEER]).toEqual({
      larkAppId: PEER,
      join: { state: 'joined', at: 10 },
      role: { state: 'confirmed', at: 11, confirmedAt: 11, appliedHash: 'sha256:x' },
      start: { state: 'sent', at: 12, turnId: 'turn-1' },
    });
  });

  it('persists chatId before any other step, which is what stops a second group', () => {
    // Simulate the crash window: chatId written, nothing else.
    seed();
    updateCollabJournal(dir, REQ, j => { j.chatId = CHAT; });
    const read = readCollabJournal(dir, REQ)!;
    expect(read.chatId).toBe(CHAT);
    expect(read.members[PEER].join.state).toBe('pending');
  });

  it('returns null (and does not write) when the mutator declines', () => {
    seed();
    expect(updateCollabJournal(dir, REQ, () => false)).toBeNull();
    expect(readCollabJournal(dir, REQ)!.status).toBe('pending');
  });

  it('throws on a corrupt journal instead of reading it as absent', () => {
    // Treating corrupt-as-absent is how a retry creates a SECOND group for a
    // task that already has one.
    seed();
    writeFileSync(collabJournalPath(dir, REQ), '{"version":1,"requestId":');
    expect(() => readCollabJournal(dir, REQ)).toThrow(/corrupt collab journal/);
  });

  it('throws on a structurally valid but invalid journal (not "absent")', () => {
    // Parseable JSON that fails validation is still a request that EXISTED.
    // Reading it as absent is the same bug as the unparseable case.
    seed();
    writeFileSync(collabJournalPath(dir, REQ), JSON.stringify({ version: 1, requestId: REQ }));
    expect(() => readCollabJournal(dir, REQ)).toThrow(/corrupt collab journal/);
  });

  it('rejects a journal missing the owner — the fence that keeps a fleet from cross-resuming', () => {
    seed();
    const path = collabJournalPath(dir, REQ);
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    delete raw.ownerLarkAppId;
    writeFileSync(path, JSON.stringify(raw));
    expect(() => readCollabJournal(dir, REQ)).toThrow();
  });

  it('lists only this owner\'s resumable requests', () => {
    seed(REQ);
    seed(REQ2, { ownerLarkAppId: 'cli_otherowner1' });
    expect(listResumableCollabJournals(dir, OWNER).map(j => j.requestId)).toEqual([REQ]);
    expect(listResumableCollabJournals(dir, 'cli_otherowner1').map(j => j.requestId)).toEqual([REQ2]);
  });

  it('excludes terminal requests from the resume sweep', () => {
    seed();
    updateCollabJournal(dir, REQ, j => { j.status = 'ready'; });
    expect(listResumableCollabJournals(dir, OWNER)).toEqual([]);
    expect(listCollabJournals(dir).map(j => j.status)).toEqual(['ready']);
  });

  it('answers "unknown" (not "none") when a journal is unreadable', () => {
    // The message gate must fail CLOSED on this: "we cannot read the record" is
    // not "there is nothing to wait for".
    seed();
    updateCollabJournal(dir, REQ, j => { j.chatId = CHAT; });
    writeFileSync(collabJournalPath(dir, REQ), '{broken');
    expect(lookupLiveCollabForChat(dir, CHAT)).toMatchObject({ state: 'unknown' });
    expect(findLiveCollabJournalForChat(dir, CHAT)).toBeUndefined();
  });

  it('sees an in-place rewrite by ANOTHER PROCESS (per-file signature, not dir mtime)', () => {
    // Simulate a second process (the dashboard, another daemon) rewriting this
    // journal in place: same directory mtime, same file name, new content. A
    // whole-directory cache would answer from the previous generation, keeping
    // the gate closed forever after a terminal transition.
    seed();
    updateCollabJournal(dir, REQ, j => { j.chatId = CHAT; });
    expect(lookupLiveCollabForChat(dir, CHAT)).toMatchObject({ state: 'live' });

    const path = collabJournalPath(dir, REQ);
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    raw.status = 'failed';
    raw.updatedAt = raw.updatedAt + 1;
    writeFileSync(path, JSON.stringify(raw));

    expect(lookupLiveCollabForChat(dir, CHAT)).toMatchObject({ state: 'none' });
  });

  it('finds the live journal for a chat and ignores terminal ones', () => {
    seed();
    updateCollabJournal(dir, REQ, j => { j.chatId = CHAT; });
    expect(findLiveCollabJournalForChat(dir, CHAT)?.requestId).toBe(REQ);
    updateCollabJournal(dir, REQ, j => { j.status = 'failed'; });
    expect(findLiveCollabJournalForChat(dir, CHAT)).toBeUndefined();
  });

  it('sees a journal written by another process without a restart', () => {
    // The listing is memoized on the hot receive path; a create made by the
    // dashboard (or a second daemon) must still show up on the next read, or a
    // message in a group whose bootstrap just started would slip past the gate.
    seed();
    expect(listCollabJournals(dir)).toHaveLength(1);
    writeFileSync(collabJournalPath(dir, REQ2), JSON.stringify({
      ...readCollabJournal(dir, REQ)!,
      requestId: REQ2,
      createdAt: 2_000,
    }));
    expect(listCollabJournals(dir).map(j => j.requestId).sort()).toEqual([REQ, REQ2].sort());
  });

  it('writes the journal with 0600 permissions', () => {
    seed();
    const { statSync } = require('node:fs') as typeof import('node:fs');
    const mode = statSync(collabJournalPath(dir, REQ)).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('collab message queue', () => {
  it('queues a message once even when the same event is redelivered', () => {
    seed();
    enqueueCollabMessage(dir, REQ, { messageId: 'om_1', at: 1, reason: 'pending' });
    enqueueCollabMessage(dir, REQ, { messageId: 'om_1', at: 2, reason: 'pending' });
    expect(readCollabQueue(dir, REQ).entries).toHaveLength(1);
  });

  it('drains in arrival order and removes the file', () => {
    seed();
    enqueueCollabMessage(dir, REQ, { messageId: 'om_1', at: 1, reason: 'pending' });
    enqueueCollabMessage(dir, REQ, { messageId: 'om_2', at: 2, reason: 'running' });
    expect(drainCollabQueue(dir, REQ).entries.map(e => e.messageId)).toEqual(['om_1', 'om_2']);
    expect(drainCollabQueue(dir, REQ).entries).toEqual([]);
    expect(existsSync(join(dir, 'collab-bootstrap', `${REQ}.queue.json`))).toBe(false);
  });

  it('keeps a corrupt backlog on drain instead of deleting the evidence', () => {
    // The group already told the user these were queued; unlinking the file
    // destroys both the work and the only record that it existed.
    seed();
    enqueueCollabMessage(dir, REQ, { messageId: 'om_1', at: 1, reason: 'pending' });
    const path = join(dir, 'collab-bootstrap', `${REQ}.queue.json`);
    writeFileSync(path, 'not json');
    const drained = drainCollabQueue(dir, REQ);
    expect(drained.corrupt).toBeTruthy();
    expect(drained.entries).toEqual([]);
    expect(existsSync(path)).toBe(true);
  });

  it('reports an unreadable queue as corrupt instead of as empty', () => {
    // Reading corruption as "empty" is data loss: the next enqueue would
    // atomically replace the file and drop messages the group already told the
    // user were queued.
    seed();
    enqueueCollabMessage(dir, REQ, { messageId: 'om_1', at: 1, reason: 'pending' });
    writeFileSync(join(dir, 'collab-bootstrap', `${REQ}.queue.json`), 'not json');
    const read = readCollabQueueState(dir, REQ);
    expect(read.corrupt).toBeTruthy();
    expect(read.queue.entries).toEqual([]);
  });

  it('refuses to append over a corrupt queue, so the old backlog survives', () => {
    seed();
    enqueueCollabMessage(dir, REQ, { messageId: 'om_old', at: 1, reason: 'pending' });
    const path = join(dir, 'collab-bootstrap', `${REQ}.queue.json`);
    writeFileSync(path, 'not json');
    expect(enqueueCollabMessage(dir, REQ, { messageId: 'om_new', at: 2, reason: 'pending' }))
      .toEqual({ ok: false, reason: 'corrupt' });
    // The unreadable file is untouched — a human can still recover it.
    expect(readFileSync(path, 'utf-8')).toBe('not json');
  });

  it('never prunes a live journal to satisfy the history cap', () => {
    // Deleting a running request loses the journal, the queue AND the ability
    // to resume: the group looks initialized while a stage never started.
    seed(REQ, { createdAt: 1 });              // oldest, still pending
    for (let i = 0; i < MAX_COLLAB_JOURNALS; i += 1) {
      const id = i.toString(16).padStart(16, '0');
      seed(id, { createdAt: 1_000 + i, status: 'failed' });
    }
    // The oldest live request must still be there…
    expect(readCollabJournal(dir, REQ)?.status).toBe('pending');
    // …and the cap was honoured by dropping a terminal one instead.
    expect(listCollabJournals(dir).length).toBeLessThanOrEqual(MAX_COLLAB_JOURNALS + 1);
  });

  it('clear removes the backlog of a cancelled request', () => {
    seed();
    enqueueCollabMessage(dir, REQ, { messageId: 'om_1', at: 1, reason: 'pending' });
    clearCollabQueue(dir, REQ);
    expect(readCollabQueue(dir, REQ).entries).toEqual([]);
  });

  it('keeps queue files out of the journal listing', () => {
    seed();
    enqueueCollabMessage(dir, REQ, { messageId: 'om_1', at: 1, reason: 'pending' });
    expect(readdirSync(join(dir, 'collab-bootstrap')).sort()).toEqual([`${REQ}.json`, `${REQ}.queue.json`]);
    expect(listCollabJournals(dir)).toHaveLength(1);
  });
});

describe('per-chat index', () => {
  it('never treats a lost index as "no bootstrap" when a live journal names the chat', () => {
    seed();
    updateCollabJournal(dir, REQ, j => { j.chatId = CHAT; });
    // Reconcile writes the index; simulate losing it.
    reconcileCollabChatIndices(dir);
    rmSync(collabChatIndexPath(dir, CHAT));
    // Boot repair restores it from the authority.
    expect(reconcileCollabChatIndices(dir)).toBe(1);
    expect(lookupLiveCollabForChat(dir, CHAT)).toMatchObject({ state: 'live' });
  });

  it('keeps a terminal index (status, not deletion) so "absent" means never configured', () => {
    seed();
    updateCollabJournal(dir, REQ, j => { j.chatId = CHAT; });
    updateCollabJournal(dir, REQ, j => { j.status = 'ready'; });
    // The file still exists — that is what makes absence meaningful.
    expect(existsSync(collabChatIndexPath(dir, CHAT))).toBe(true);
    expect(lookupLiveCollabForChat(dir, CHAT)).toMatchObject({ state: 'none' });
  });

  it('confines an unreadable index to its own chat', () => {
    // One bad record must not freeze the whole fleet's message path.
    seed();
    updateCollabJournal(dir, REQ, j => { j.chatId = CHAT; });
    writeFileSync(collabChatIndexPath(dir, CHAT), '{broken');
    expect(lookupLiveCollabForChat(dir, CHAT)).toMatchObject({ state: 'unknown' });
    expect(lookupLiveCollabForChat(dir, 'oc_some_other_chat')).toMatchObject({ state: 'none' });
  });

  it('reports unknown when the index points at a journal for another chat', () => {
    seed();
    updateCollabJournal(dir, REQ, j => { j.chatId = CHAT; });
    writeFileSync(collabChatIndexPath(dir, CHAT), JSON.stringify({
      version: 1, requestId: REQ, ownerLarkAppId: OWNER, status: 'running', updatedAt: 1,
    }));
    const other = 'oc_other_chat';
    updateCollabJournal(dir, REQ, j => { j.chatId = other; });
    expect(lookupLiveCollabForChat(dir, CHAT)).toMatchObject({ state: 'unknown' });
  });
});

describe('terminal-state TOCTOU fence', () => {
  it('refuses to append after the request reached a terminal state', () => {
    // The gate reads "not ready", then a terminal transition drains the (empty)
    // queue, then the append would succeed — promising a slot nothing drains.
    seed();
    updateCollabJournal(dir, REQ, j => { j.chatId = CHAT; });
    expect(enqueueCollabMessage(dir, REQ, { messageId: 'om_1', at: 1, reason: 'pending' }))
      .toEqual({ ok: true, alreadyPresent: false });
    updateCollabJournal(dir, REQ, j => { j.status = 'ready'; });
    expect(enqueueCollabMessage(dir, REQ, { messageId: 'om_late', at: 2, reason: 'ready' }))
      .toEqual({ ok: false, reason: 'terminal' });
    // The late message is NOT stranded in the queue.
    expect(readCollabQueue(dir, REQ).entries.map(e => e.messageId)).toEqual(['om_1']);
  });
});
