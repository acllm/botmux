/**
 * Birth-side wiring for collaboration groups (issue #3588).
 *
 * `maybeBirthSessionGroup` stays the decision point ("does this DM birth a
 * group?"); this module owns the collaboration branch's real dependencies so
 * the birth file keeps reading as a narrative. Design:
 * docs/design/2026-11-20-dm-collab-group-bootstrap.md.
 *
 * Two things are deliberate here:
 *
 *  - The progress card and the DM receipt are the USER's only window into a
 *    multi-minute, multi-daemon initialization. They are rendered from the
 *    journal, so what the card says and what the resume path will do can never
 *    disagree.
 *  - `onTurnTerminal` re-enters the orchestrator. A dependent stage starts when
 *    its upstream's turn COMPLETES, which is a different call stack entirely;
 *    pretending otherwise (e.g. "sent the kickoff, therefore it ran") is the
 *    exact bug the issue describes.
 */
import { config } from '../config.js';
import { getBot } from '../bot-registry.js';
import type { CollabGroupConfig } from '../bot-registry.js';
import { createGroupWithBots } from './group-creator.js';
import { deleteChat } from './groups-store.js';
import { unbindOncall } from './oncall-store.js';
import { listChatBotMembers, sendMessage, updateMessage, replyMessage } from '../im/lark/client.js';
import { readRoleProfileEntry } from './role-profile-store.js';
import { COLLAB_ROLE_PROTOCOL, hashRoleContent, type CollabTurnReport } from '../core/collab-role-protocol.js';
import { loadDaemonIpcSecret } from '../core/daemon-ipc-auth.js';
import { findOnlineDaemon } from '../utils/daemon-discovery.js';
import { createCollabPeerClient, readbackPeerRole, reportCollabTurnStarted, reportCollabTurnTerminal, requestPeerRoleApply } from './collab-peer-client.js';
import { runCollabBootstrap, collabMemberStatusLine, collabRolesReady, type CollabBootstrapDeps } from './collab-bootstrap.js';
import {
  createCollabJournal,
  drainCollabQueue,
  enqueueCollabMessage,
  findLiveCollabJournalForChat,
  listCollabJournals,
  lookupLiveCollabForChat,
  listResumableCollabJournals,
  readCollabJournal,
  updateCollabJournal,
  type CollabBootstrapJournal,
} from './collab-bootstrap-store.js';
import { collabConfigFingerprint } from '../core/collab-role-protocol.js';
import { DEFAULT_COLLAB_INIT_TIMEOUT_MS, collabConfigActive } from './collab-group-config.js';
import { logger } from '../utils/logger.js';
import { randomBytes } from 'node:crypto';

const STATUS_LABEL: Record<CollabBootstrapJournal['status'], string> = {
  pending: '初始化中',
  running: '初始化中',
  ready: '协作已就绪',
  failed: '初始化失败',
  cancelled: '已取消',
};

/**
 * Short, stable marker embedded in the group name.
 *
 * Group creation is the one irreversible side effect, and its result can be
 * UNKNOWN: `chat.create` may succeed while the response is lost, leaving no
 * local chatId. The marker is the second channel that makes such a group
 * findable again — without it a retry either orphans the first group or creates
 * a second one.
 */
export function collabRequestMarker(requestId: string): string {
  return `#${requestId.slice(0, 8)}`;
}

/** Group name carrying the request marker (truncated title, intact marker). */
export function collabGroupName(base: string, requestId: string): string {
  const marker = collabRequestMarker(requestId);
  const room = 50 - marker.length - 1;
  const trimmed = base.trim();
  const head = trimmed.length > room ? `${trimmed.slice(0, Math.max(0, room - 1))}…` : trimmed;
  return head ? `${head} ${marker}` : marker;
}

/**
 * Find a group this request already created, by its name marker.
 *
 * Exactly one hit = ours; claim it. Several = refuse (we cannot tell which is
 * the real one, and guessing would split the conversation). None = create.
 */
export async function findCollabGroupByMarker(
  larkAppId: string,
  marker: string,
): Promise<{ state: 'none' } | { state: 'found'; chatId: string } | { state: 'ambiguous'; chatIds: string[] }> {
  const { getBotClient } = await import('../bot-registry.js');
  const { larkGet } = await import('../im/lark/lark-get.js');
  const hits: string[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const json = await larkGet(getBotClient(larkAppId), '/open-apis/im/v1/chats', {
      page_size: 100,
      ...(pageToken ? { page_token: pageToken } : {}),
    }, { timeoutMs: 15_000 });
    const items: any[] = json?.data?.items ?? [];
    for (const item of items) {
      if (typeof item?.name === 'string' && item.name.includes(marker) && typeof item.chat_id === 'string') {
        hits.push(item.chat_id);
      }
    }
    pageToken = json?.data?.page_token;
    if (!json?.data?.has_more || !pageToken) break;
  }
  if (hits.length === 0) return { state: 'none' };
  if (hits.length === 1) return { state: 'found', chatId: hits[0] };
  return { state: 'ambiguous', chatIds: hits };
}

/** Progress card body. Rendered from the journal only — no live Lark reads, so
 *  a card refresh can never itself fail the bootstrap. */
export function renderCollabProgressCard(journal: CollabBootstrapJournal): string {
  const members = journal.config.members ?? [];
  const lines = members.map(m => collabMemberStatusLine(m, journal.members[m.larkAppId]));
  const head = `**${STATUS_LABEL[journal.status]}**`;
  const reason = journal.failureReason ? `\n原因：${journal.failureReason}` : '';
  return `${head}\n${lines.join('\n')}${reason}`;
}

export interface CollabBirthResult {
  chatId: string;
  status: 'ready' | 'failed' | 'cancelled';
  requestId: string;
  failureReason?: string;
}

export interface CollabBirthInput {
  larkAppId: string;
  dmChatId: string;
  messageId: string;
  ownerOpenId: string;
  taskText: string;
  name: string;
  workingDir?: string;
  /**
   * Called the instant the chat exists and its journal carries `chatId`,
   * BEFORE any invite/role/kickoff work.
   *
   * The caller registers the session group here. Registration must not wait for
   * the bootstrap to return: for the whole multi-minute initialization the
   * group is already live in Feishu, and a message arriving in it must be held
   * by the readiness gate. Registering only at the end leaves a window where
   * the group is not a session group yet and a CLI starts in it immediately.
   */
  onChatReady?: (chatId: string) => void;
}

/**
 * Run a fresh collaboration bootstrap for one DM message.
 *
 * Called instead of the legacy single-bot path when the bot has an active
 * `sessionGroup.collab` block. Returns the outcome so the caller can decide
 * whether to re-home the turn into the new group.
 */
export async function birthCollabSessionGroup(input: CollabBirthInput): Promise<CollabBirthResult> {
  const botCfg = getBot(input.larkAppId).config;
  const collab = botCfg.sessionGroup?.collab as CollabGroupConfig;
  const dataDir = config.session.dataDir;
  const requestId = randomBytes(16).toString('hex');
  const startPolicy = collab.startPolicy ?? 'staged';
  const fingerprint = collabConfigFingerprint({
    enabled: collabConfigActive(collab),
    profileId: collab.profileId ?? '',
    startPolicy,
    members: collab.members ?? [],
  });

  const members: Record<string, CollabBootstrapJournal['members'][string]> = {};
  for (const m of collab.members ?? []) {
    members[m.larkAppId] = {
      larkAppId: m.larkAppId,
      join: { state: 'pending' },
      role: { state: 'pending' },
      start: { state: 'pending' },
    };
  }

  const journal = createCollabJournal(dataDir, {
    requestId,
    ownerLarkAppId: input.larkAppId,
    config: collab,
    configFingerprint: fingerprint,
    sourceChatId: input.dmChatId,
    sourceMessageId: input.messageId,
    ownerOpenId: input.ownerOpenId,
    createdAt: Date.now(),
    status: 'pending',
    members,
    taskText: input.taskText,
    // ABSOLUTE and frozen here. Recomputing `now + budget` on every pass would
    // let each daemon restart hand the request a fresh budget, so a stuck peer
    // could keep it alive forever.
    deadlineAt: Date.now() + (collab.onInitTimeoutMs ?? DEFAULT_COLLAB_INIT_TIMEOUT_MS),
  });

  const deps = buildCollabDeps(input.larkAppId);
  // Register as soon as the chatId is durable. `runCollabBootstrap` writes it
  // inside `onChatCreated`; we hook the same moment by watching the journal.
  if (input.onChatReady) {
    const watched = watchFirstChatId(dataDir, requestId, input.onChatReady);
    try {
      return await runAndReport(deps, input, journal, watched);
    } finally {
      watched.stop();
    }
  }
  const outcome = await runCollabBootstrap(deps, {
    journal,
    name: input.name,
    ownerOpenId: input.ownerOpenId,
    ...(input.workingDir ? { workingDir: input.workingDir } : {}),
  });
  return {
    chatId: outcome.chatId,
    status: outcome.status,
    requestId,
    ...(outcome.failureReason ? { failureReason: outcome.failureReason } : {}),
  };
}

/**
 * Fire `onReady` the first time the journal gains a `chatId`.
 *
 * A poll rather than a callback because the write happens inside the
 * orchestrator's `onChatCreated`, which is deliberately a plain synchronous
 * store call — threading a second callback through it would give the
 * orchestrator two ways to signal the same event, and the store write is the
 * one that is actually durable.
 */
function watchFirstChatId(dataDir: string, requestId: string, onReady: (chatId: string) => void): { stop(): void } {
  let done = false;
  const tick = (): void => {
    if (done) return;
    try {
      const journal = readCollabJournal(dataDir, requestId);
      if (journal?.chatId) {
        done = true;
        onReady(journal.chatId);
      }
    } catch { /* keep watching; the run itself surfaces real errors */ }
  };
  const timer = setInterval(tick, 25);
  timer.unref?.();
  return {
    stop(): void { done = true; clearInterval(timer); },
  };
}

async function runAndReport(
  deps: CollabBootstrapDeps,
  input: CollabBirthInput,
  journal: CollabBootstrapJournal,
  watched: { stop(): void },
): Promise<CollabBirthResult> {
  try {
    const outcome = await runCollabBootstrap(deps, {
      journal,
      // The marker rides the NAME, so an unknown-result creation is findable.
      name: collabGroupName(input.name, journal.requestId),
      ownerOpenId: input.ownerOpenId,
      liveConfigFingerprint: liveCollabFingerprint(input.larkAppId),
      ...(input.workingDir ? { workingDir: input.workingDir } : {}),
    });
    // A group that reached a terminal state on its FIRST pass may already have
    // queued messages (they arrived while roles were being applied). Announce
    // them here too — the resume path does, and a message queued during the
    // very first pass would otherwise never be reported.
    await announceCollabQueueDrained(journal.requestId);
    return {
      chatId: outcome.chatId,
      status: outcome.status,
      requestId: journal.requestId,
      ...(outcome.failureReason ? { failureReason: outcome.failureReason } : {}),
    };
  } finally {
    watched.stop();
  }
}

/**
 * Re-enter an in-flight bootstrap (daemon restart, or a dependency clearing).
 *
 * Reuses the persisted journal verbatim: same chat, same frozen config, same
 * per-member step states. Never creates a second group, never re-kicks a member
 * whose start is already recorded.
 */
export async function resumeCollabBootstrap(journal: CollabBootstrapJournal): Promise<void> {
  if (journal.status !== 'pending' && journal.status !== 'running') return;
  if (!selfAppIdHint) {
    logger.warn(`[collab] resume ${journal.requestId} skipped: self app id not bound`);
    return;
  }
  const deps = buildCollabDeps(requireSelfAppId());
  try {
    await runCollabBootstrap(deps, {
      journal,
      name: journal.chatId ? '' : '协作会话',
      ownerOpenId: journal.ownerOpenId,
      liveConfigFingerprint: liveCollabFingerprint(requireSelfAppId()),
    });
    await announceCollabQueueDrained(journal.requestId);
  } catch (err) {
    logger.error(`[collab] resume ${journal.requestId} failed: ${err}`);
  }
}

/**
 * The bot whose daemon OWNS the boot-resume sweep.
 *
 * Every journal also carries its own `ownerLarkAppId`; this process-wide value
 * exists so the sweep can ask the store "which of MY requests are unfinished"
 * without reading every journal the fleet has ever written. Bound once at boot
 * because one daemon serves exactly one bot.
 */
let selfAppIdHint: string | undefined;

/** Bind the running daemon's own app id (called once at daemon boot). */
export function setCollabSelfAppId(larkAppId: string): void {
  selfAppIdHint = larkAppId;
}

/**
 * Peer client bound to THIS daemon's identity.
 *
 * `selfLarkAppId` comes from the process binding, never from a report body: it
 * is what lets a receiver check that the caller really is the bot it claims.
 */
function peerClientForSelf(): ReturnType<typeof createCollabPeerClient> {
  return createCollabPeerClient({
    dataDir: config.session.dataDir,
    secret: () => loadDaemonIpcSecret(),
    selfLarkAppId: () => requireSelfAppId(),
  });
}

/**
 * Recompute the fingerprint from the bot's CURRENT collab config.
 *
 * The journal's frozen fingerprint is compared against this before every
 * external side effect, so an operator editing the roster/profile mid-flight
 * makes the old request stop instead of finishing work from a config nobody is
 * looking at any more.
 */
function liveCollabFingerprint(larkAppId: string): () => string {
  return () => {
    try {
      const collab = getBot(larkAppId).config.sessionGroup?.collab as CollabGroupConfig | undefined;
      if (!collab) return 'disabled';
      return collabConfigFingerprint({
        // `enabled` rides the fingerprint: turning the feature OFF must make an
        // in-flight request stale instead of letting it keep kicking off.
        enabled: collabConfigActive(collab),
        profileId: collab.profileId ?? '',
        startPolicy: collab.startPolicy ?? 'staged',
        members: collab.members ?? [],
      });
    } catch {
      // Cannot read the live config: treat it as drifted so the request stops
      // rather than continuing on a snapshot we can no longer validate.
      return 'unreadable';
    }
  };
}

function requireSelfAppId(): string {
  if (!selfAppIdHint) throw new Error('collab self app id is not bound');
  return selfAppIdHint;
}

/** Journals THIS daemon should pick up after a restart. */
export function listCollabResumeCandidates(): CollabBootstrapJournal[] {
  if (!selfAppIdHint) return [];
  return listResumableCollabJournals(config.session.dataDir, selfAppIdHint);
}

/**
 * Owner side: apply a peer's turn report and resume the bootstrap so that
 * member's dependents can start.
 *
 * Rejects a report that does not name this daemon's own journal: the dataDir is
 * shared by the fleet, so without the `ownerLarkAppId` fence any daemon could
 * advance any request.
 */
export async function applyCollabTurnReport(
  ownerLarkAppId: string,
  report: CollabTurnReport,
): Promise<{ ok: boolean; reason?: string }> {
  const journal = findLiveCollabJournalForChat(config.session.dataDir, report.chatId, ownerLarkAppId);
  if (!journal) return { ok: false, reason: 'no_live_bootstrap' };
  if (journal.ownerLarkAppId !== ownerLarkAppId) return { ok: false, reason: 'wrong_owner' };
  if (journal.requestId !== report.requestId) return { ok: false, reason: 'stale_request' };
  const { applyCollabTurnTerminal } = await import('./collab-bootstrap.js');
  let changed = false;
  const updated = updateCollabJournal(config.session.dataDir, journal.requestId, j => {
    if (j.status !== 'pending' && j.status !== 'running') return false;
    const outcome = applyCollabTurnTerminal(j, {
      larkAppId: report.larkAppId,
      ...(report.turnId ? { turnId: report.turnId } : {}),
      status: report.status,
    });
    if (!outcome.changed) return false;
    changed = true;
  });
  if (!changed || !updated) return { ok: false, reason: 'no_matching_stage' };
  logger.info(
    `[collab] ${report.larkAppId} reported ${report.status} for ${report.requestId}; resuming`,
  );
  await resumeCollabBootstrap(updated);
  await announceCollabQueueDrained(updated.requestId);
  return { ok: true };
}

/**
 * After a bootstrap reaches a terminal state, tell the group how many messages
 * it queued while initializing.
 *
 * The queue is deliberately NOT auto-replayed. Replaying would start CLI turns
 * for messages the user typed against a group that was still being built — and
 * on a FAILED bootstrap those turns would run in a group whose roles were never
 * confirmed, which is precisely the failure the issue rules out. The user keeps
 * the explicit choice: send again in a ready group, or retry the bootstrap.
 */
export async function announceCollabQueueDrained(requestId: string): Promise<void> {
  const journal = listCollabJournals(config.session.dataDir).find(j => j.requestId === requestId);
  if (!journal || !journal.chatId) return;
  if (journal.status === 'pending' || journal.status === 'running') return;
  const drained = drainCollabQueue(config.session.dataDir, requestId);
  if (drained.corrupt) {
    // Keep the file (drain already did) and say so: "0 queued" would contradict
    // what the group told the user while initializing.
    await sendMessage(journal.ownerLarkAppId, journal.chatId,
      '⚠️ 协作群初始化期间的排队记录已损坏，无法确认哪些消息未执行。记录已保留以便排查。', 'text')
      .catch(err => logger.warn(`[collab] corrupt-queue notice failed: ${err}`));
    return;
  }
  const queued = drained.entries;
  if (queued.length === 0) return;
  const text = journal.status === 'ready'
    ? `✅ 协作群已就绪。初始化期间有 ${queued.length} 条消息被排队，请重新发送以开始处理。`
    : `⚠️ 协作初始化未成功，初始化期间排队的 ${queued.length} 条消息未执行。请修复后重试。`;
  await sendMessage(journal.ownerLarkAppId, journal.chatId, text, 'text')
    .catch(err => logger.warn(`[collab] queue notice failed: ${err}`));
}

/**
 * Owner side: apply a peer's "my CLI took the turn" report.
 *
 * Advances the stage `sent` → `running`, which is what makes a later terminal
 * able to settle it and release the next stage.
 */
export async function applyCollabTurnStarted(
  ownerLarkAppId: string,
  report: { requestId: string; chatId: string; larkAppId: string; turnId?: string },
): Promise<{ ok: boolean; reason?: string }> {
  const journal = findLiveCollabJournalForChat(config.session.dataDir, report.chatId, ownerLarkAppId);
  if (!journal) return { ok: false, reason: 'no_live_bootstrap' };
  if (journal.requestId !== report.requestId) return { ok: false, reason: 'stale_request' };
  const { markCollabStageRunning: mark } = await import('./collab-bootstrap.js');
  let changed = false;
  updateCollabJournal(config.session.dataDir, journal.requestId, j => {
    if (j.status !== 'pending' && j.status !== 'running') return false;
    if (!mark(j, {
      larkAppId: report.larkAppId,
      ...(report.turnId ? { turnId: report.turnId } : {}),
    }).changed) return false;
    changed = true;
  });
  if (!changed) return { ok: false, reason: 'no_matching_stage' };
  logger.info(`[collab] ${report.larkAppId} reported started for ${report.requestId}`);
  return { ok: true };
}

/**
 * Peer side: report a finished turn to the bootstrap owner.
 *
 * Called from the peer's own turn-terminal path. The journal lookup tells us
 * which request/owner this chat belongs to; `null` means the chat is not a
 * collaboration group (the common case) and there is nothing to report.
 */
export async function reportCollabTurnIfOwned(input: {
  chatId: string;
  larkAppId: string;
  turnId?: string;
  status: 'completed' | 'failed' | 'cancelled' | 'ambiguous';
}): Promise<void> {
  // No owner filter on the LOOKUP: this normally runs in the PEER's daemon,
  // which is looking for a journal it does not own.
  const journal = findLiveCollabJournalForChat(config.session.dataDir, input.chatId);
  if (!journal) return;
  if (journal.ownerLarkAppId === input.larkAppId) {
    // The owner's own bot finishing a turn in its group is not a peer report:
    // it has no stage in its own journal (members never include the owner).
    // Apply it LOCALLY instead of reporting to itself over IPC — the owner
    // could not answer its own route (it requires trusted-host authority it
    // does not have for a self-call), so the old code dropped this silently.
    await applyCollabTurnReport(input.larkAppId, {
      protocol: COLLAB_ROLE_PROTOCOL,
      requestId: journal.requestId,
      chatId: input.chatId,
      larkAppId: input.larkAppId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      status: input.status,
    });
    return;
  }
  const slot = journal.members[input.larkAppId];
  if (!slot) return;
  const peerClient = peerClientForSelf();
  const delivered = await reportCollabTurnTerminal(peerClient, {
    ownerLarkAppId: journal.ownerLarkAppId,
    report: {
      protocol: COLLAB_ROLE_PROTOCOL,
      requestId: journal.requestId,
      chatId: input.chatId,
      larkAppId: input.larkAppId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      status: input.status,
    },
  });
  if (!delivered) {
    logger.warn(
      `[collab] turn report to owner ${journal.ownerLarkAppId} failed for ${journal.requestId}; `
      + 'the owner will reconcile on its next resume',
    );
  }
}

/**
 * Owner side: a kickoff turn was actually admitted to a CLI.
 *
 * Only the OWNER holds the journal, so this is a local write; a peer daemon
 * looking at the same chat simply has no journal and does nothing.
 */
export async function markCollabStageRunning(input: {
  chatId: string;
  larkAppId: string;
  turnId?: string;
}): Promise<void> {
  if (!selfAppIdHint) return;
  // The stage state lives in the OWNER's journal, but admission happens in the
  // PEER's daemon. An owner-filtered lookup here is why a peer stage used to
  // stay `sent` forever (and, since only `running` can settle, its dependents
  // never started). Peers report over the same signed channel as terminals.
  const lookup = lookupLiveCollabForChat(config.session.dataDir, input.chatId);
  if (lookup.state !== 'live') return;
  const journal = lookup.journal;
  if (journal.ownerLarkAppId !== selfAppIdHint) {
    const slot = journal.members[input.larkAppId];
    if (!slot) return;
    const delivered = await reportCollabTurnStarted(
      peerClientForSelf(),
      {
        ownerLarkAppId: journal.ownerLarkAppId,
        report: {
          protocol: COLLAB_ROLE_PROTOCOL,
          requestId: journal.requestId,
          chatId: input.chatId,
          larkAppId: input.larkAppId,
          ...(input.turnId ? { turnId: input.turnId } : {}),
        },
      },
    );
    if (!delivered) {
      logger.warn(`[collab] turn-started report to owner ${journal.ownerLarkAppId} failed for ${journal.requestId}`);
    }
    return;
  }
  const slot = journal.members[input.larkAppId];
  if (!slot || slot.start.state !== 'sent') return;
  const { markCollabStageRunning: mark } = await import('./collab-bootstrap.js');
  let changed = false;
  updateCollabJournal(config.session.dataDir, journal.requestId, j => {
    if (j.status !== 'pending' && j.status !== 'running') return false;
    if (!mark(j, { larkAppId: input.larkAppId, ...(input.turnId ? { turnId: input.turnId } : {}) }).changed) {
      return false;
    }
    changed = true;
  });
  if (changed) {
    logger.info(`[collab] ${input.larkAppId} stage is running in ${input.chatId.substring(0, 12)}`);
  }
}

/**
 * Fail requests whose deadline passed with nothing left to wake them.
 *
 * A persisted deadline is only a NUMBER until something reads it. Without this
 * sweep a request whose terminal/started reports were both lost sits at
 * `running` forever: the card says "initializing", the gate holds messages, and
 * only an unrelated message or a restart ever notices. The sweep is the clock.
 */
export async function sweepExpiredCollabBootstraps(now: () => number = Date.now): Promise<number> {
  if (!selfAppIdHint) return 0;
  let expired = 0;
  for (const journal of listResumableCollabJournals(config.session.dataDir, selfAppIdHint)) {
    // The initialization deadline covers READINESS, not execution. Once every
    // member's role is confirmed the group is usable and a long builder turn is
    // normal work, not a stall — killing it would reject that turn's own
    // terminal (the journal would already be terminal) and strand the
    // dependent stage forever.
    if (collabRolesReady(journal) && !hasUnsettledDependencyWait(journal)) continue;
    const deadline = journal.deadlineAt;
    if (deadline === undefined || now() <= deadline) {
      // No deadline recorded (older journal): give it one now rather than
      // letting it live forever.
      if (deadline === undefined) {
        updateCollabJournal(config.session.dataDir, journal.requestId, j => {
          if (j.deadlineAt !== undefined) return false;
          j.deadlineAt = now() + (j.config.onInitTimeoutMs ?? DEFAULT_COLLAB_INIT_TIMEOUT_MS);
        });
      }
      continue;
    }
    const failed = updateCollabJournal(config.session.dataDir, journal.requestId, j => {
      if (j.status !== 'pending' && j.status !== 'running') return false;
      j.status = 'failed';
      j.failureReason = j.failureReason ?? 'timeout';
      for (const member of Object.values(j.members)) {
        if (member.start.state === 'pending' || member.start.state === 'sent') {
          member.start = { ...member.start, state: 'failed', error: member.start.error ?? 'timeout' };
        }
      }
    });
    if (!failed) continue;
    expired += 1;
    logger.warn(`[collab] ${journal.requestId} exceeded its deadline; marked failed`);
    await announceCollabQueueDrained(journal.requestId);
  }
  return expired;
}

/**
 * Is some stage still waiting on an upstream that has not completed?
 *
 * That wait — not the whole initialization — is what the dependency deadline
 * governs. A stage that is already `running` is executing, not waiting.
 */
function hasUnsettledDependencyWait(journal: CollabBootstrapJournal): boolean {
  return Object.values(journal.members).some(m => m.start.state === 'pending');
}

/** Build the production dependency set for one bot's daemon. */
export function buildCollabDeps(larkAppId: string): CollabBootstrapDeps {
  const dataDir = config.session.dataDir;
  const peerClient = createCollabPeerClient({
    dataDir,
    secret: () => loadDaemonIpcSecret(),
    selfLarkAppId: () => larkAppId,
  });

  return {
    async createGroup(opts) {
      // The creator keeps chat ownership (AI title + lifecycle need it) and
      // grants the initiating user manager rights — same contract as the legacy
      // birth path. Peer bots go through `larkAppIds`; the service batches them
      // 5 at a time and reports rejects in `invalidBotIds`.
      const result = await createGroupWithBots({
        creatorLarkAppId: larkAppId,
        larkAppIds: opts.larkAppIds,
        name: opts.name,
        userOpenIds: opts.userOpenIds,
        managerUserIds: opts.managerUserIds,
        ...(opts.bindWorkingDir ? { bindWorkingDir: opts.bindWorkingDir } : {}),
        // Without the talk-grant matrix a kickoff from this bot is REJECTED by
        // a peer's talk gate (different owner, no existing trust), so no CLI
        // turn ever starts and the stage looks stuck. Same helper the CLI
        // create-group path uses; pairs already trusting this bot as a
        // same-owner sibling need no grant.
        ensureBotCollaboration: async (chatId, joined) => {
          if (joined.length < 2) return;
          const { trustsSameOwnerSiblingApp } = await import('../im/lark/event-dispatcher.js');
          const { ensureBotChatGrantMatrix } = await import('../cli/exact-chat-grant-client.js');
          await ensureBotChatGrantMatrix(chatId, joined, {
            findDaemon: (appId) => findOnlineDaemon(appId, dataDir),
            secret: () => loadDaemonIpcSecret(),
            needsGrant: (receiver, subject) => !trustsSameOwnerSiblingApp(dataDir, receiver, subject),
          });
        },
        onChatCreated: opts.onChatCreated,
      });
      return {
        chatId: result.chatId,
        invalidBotIds: result.invalidBotIds,
        invalidUserIds: result.invalidUserIds,
        // Bindings are surfaced, not swallowed: a peer that failed to bind the
        // explicit working dir would run in its own default directory, i.e. in
        // the wrong repository — silently.
        oncallBindings: result.oncallBindings,
        collaborationError: result.collaborationError ?? null,
      };
    },

    async disbandGroup(chatId) {
      await deleteChat(larkAppId, chatId);
      await unbindOncall(larkAppId, chatId).catch(() => undefined);
    },

    findGroupByMarker(marker) {
      return findCollabGroupByMarker(larkAppId, marker);
    },

    async listChatBots(chatId) {
      const members = await listChatBotMembers(larkAppId, chatId);
      return members.map(m => ({ larkAppId: m.larkAppId, openId: m.openId, mentionable: m.mentionable }));
    },

    readProfileEntryHash(profileId, peerLarkAppId) {
      return hashRoleContent(readRoleProfileEntry(dataDir, profileId, peerLarkAppId));
    },

    requestRoleApply({ peerLarkAppId, request }) {
      return requestPeerRoleApply(peerClient, { peerLarkAppId, request });
    },

    readbackRole({ peerLarkAppId, chatId, profileId }) {
      return readbackPeerRole(peerClient, { peerLarkAppId, chatId, profileId });
    },

    async kickoff({ chatId, peerOpenId, prompt }) {
      return sendMessage(larkAppId, chatId, `<at user_id="${peerOpenId}"></at> ${prompt}`, 'text');
    },

    async updateProgressCard({ chatId, cardMessageId, journal }) {
      const body = renderCollabProgressCard(journal);
      if (cardMessageId) {
        await updateMessage(larkAppId, cardMessageId, body).catch(() => undefined);
        return cardMessageId;
      }
      return sendMessage(larkAppId, chatId, body, 'text');
    },

    async updateDmReceipt({ chatId, sourceMessageId, journal }) {
      const link = `https://applink.feishu.cn/client/chat/open?openChatId=${chatId}`;
      const text = `${STATUS_LABEL[journal.status]}：${link}`;
      return replyMessage(larkAppId, sourceMessageId, text, 'text').catch(() => undefined);
    },

    mutateJournal(requestId, mutate) {
      return updateCollabJournal(dataDir, requestId, mutate);
    },

    log(level, message) {
      if (level === 'error') logger.error(message);
      else if (level === 'warn') logger.warn(message);
      else logger.info(message);
    },
  };
}

/**
 * A message arrived in a group whose bootstrap is not ready yet.
 *
 * Three properties matter, and each one was a separate bug:
 *
 *  - It must run for EVERY daemon that can receive a message in that chat, not
 *    only the owner. A session-group registry entry only exists for the bot
 *    that birthed the group, so keying the gate on `isSessionGroup` let an
 *    invited peer answer (and start a CLI) while roles were unconfirmed.
 *  - It must read a TRI-state. An unreadable journal means "cannot prove there
 *    is no bootstrap", which is not the same as "no bootstrap".
 *  - The live check and the enqueue must be one decision. Otherwise a terminal
 *    state can drain the (empty) queue between the two, and the message is
 *    promised a slot that is then never drained.
 *
 * Returns true when the message was held back (the caller must not start a CLI).
 */
export async function holdCollabMessageIfNotReady(input: {
  larkAppId: string;
  chatId: string;
  messageId: string;
  replyRootId?: string;
}): Promise<boolean> {
  // No owner filter: any participating daemon must hold, not just the birther.
  const lookup = lookupLiveCollabForChat(config.session.dataDir, input.chatId);
  if (lookup.state === 'none') return false;

  if (lookup.state === 'unknown') {
    // Fail closed and SAY SO. Starting a CLI here would run a turn in a group
    // whose readiness we cannot even read; the visible notice tells the user
    // something is wrong instead of pretending the group is normal.
    logger.warn(`[collab] gate for ${input.chatId.substring(0, 12)} is unreadable: ${lookup.reason}`);
    await notifyCollabGate(input, '⚠️ 协作群初始化状态不可读，这条消息暂未处理。请稍后重试或联系维护者。');
    return true;
  }

  const journal = lookup.journal;
  // Roles confirmed = the group may accept normal messages, even if a dependent
  // stage is still waiting for its upstream. The gate is about READINESS, not
  // about the request having finished.
  if (collabRolesReady(journal)) return false;

  const queued = enqueueCollabMessage(config.session.dataDir, journal.requestId, {
    messageId: input.messageId,
    at: Date.now(),
    reason: journal.status,
  });
  if (!queued.ok && queued.reason === 'terminal') {
    // The request finished between our lookup and the append, and its drain
    // already ran. Do not promise a slot nothing will drain: fall through to
    // normal routing (the group is now ready or definitively failed).
    return false;
  }
  if (!queued.ok) {
    // We could not take the message (corrupt backlog). Still HOLD: falling
    // through would start a CLI in a group whose roles are unconfirmed, which is
    // the failure this whole gate exists to prevent. Say what happened so the
    // user knows why nothing runs.
    await notifyCollabGate(input, '⚠️ 协作群的排队记录不可读，这条消息暂未处理。请稍后重试。');
    return true;
  }
  await notifyCollabGate(input, `⏳ 协作群还在${STATUS_LABEL[journal.status]}，这条消息已排队，就绪后请重新发送。`);
  logger.info(
    `[collab] held message ${input.messageId.substring(0, 12)} in ${input.chatId.substring(0, 12)} `
    + `(bootstrap ${journal.requestId} is ${journal.status})`,
  );
  return true;
}

async function notifyCollabGate(
  input: { larkAppId: string; chatId: string; messageId: string; replyRootId?: string },
  text: string,
): Promise<void> {
  try {
    if (input.replyRootId) await replyMessage(input.larkAppId, input.replyRootId, text, 'text');
    else await sendMessage(input.larkAppId, input.chatId, text, 'text');
  } catch (err) {
    logger.warn(`[collab] queue notice failed for ${input.chatId}: ${err}`);
  }
}

/** Queue entries for a request (used by the resume path to replay in order). */
export { findLiveCollabJournalForChat };
