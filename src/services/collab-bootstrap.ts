/**
 * Collaboration-group bootstrap orchestrator (issue #3588).
 *
 * Turns one DM message into a ready collaboration group:
 *
 *   1. create the chat (with the peers)          ← durable boundary: chatId
 *   2. verify every peer is ACTUALLY a member    ← live roster read
 *   3. apply each peer's per-chat role            ← signed IPC to its daemon
 *   4. confirm readiness                          ← receipt + readback
 *   5. start members by dependency               ← kickoff, then turn terminal
 *
 * Design: docs/design/2026-11-20-dm-collab-group-bootstrap.md.
 *
 * Every effect is injected. That is not test-tidiness: the difference between
 * "the message was sent" and "the role is applied" is exactly what this module
 * has to prove, so the unit that proves it must be runnable against a peer that
 * lies, stalls, or answers late. No Lark, no disk, no daemon here.
 *
 * The orchestrator is ALSO the resume path. `runCollabBootstrap` is idempotent
 * per step: a restart re-enters it with the persisted journal and skips every
 * step already marked done. It never creates a second chat once `chatId` is on
 * disk, and never kicks off a member twice.
 */

import type { CollabGroupConfig, CollabMemberConfig } from '../bot-registry.js';
import {
  DEFAULT_COLLAB_INIT_TIMEOUT_MS,
  orderCollabMembers,
  renderCollabPrompt,
} from './collab-group-config.js';
import {
  COLLAB_ROLE_PROTOCOL,
  acceptCollabRoleReceipt,
  type CollabRoleApplyReceipt,
  type CollabRoleReadbackResult,
} from '../core/collab-role-protocol.js';
import type {
  CollabBootstrapJournal,
  CollabMemberJournal,
} from './collab-bootstrap-store.js';

export interface CollabBootstrapDeps {
  /** Create the chat with these bots. Returns the chatId, or throws. Must call
   *  `onChatCreated` synchronously the instant the chat exists. */
  createGroup(input: {
    larkAppIds: string[];
    name: string;
    userOpenIds: string[];
    managerUserIds: string[];
    bindWorkingDir?: string;
    onChatCreated: (chatId: string) => void;
  }): Promise<{
    chatId: string;
    invalidBotIds: string[];
    invalidUserIds: string[];
    /** Per-bot working-dir binding outcomes, when an explicit dir was requested. */
    oncallBindings?: Array<{ larkAppId: string; ok: boolean; error?: string }>;
    /** Best-effort talk-grant matrix outcome; non-null means it did not complete. */
    collaborationError?: string | null;
  }>;
  /** Disband a chat this bootstrap created and cannot use (invitee rejected). */
  disbandGroup(chatId: string): Promise<void>;
  /**
   * Find a group this request may already have created, by its name marker.
   *
   * Group creation's result can be UNKNOWN (the API succeeded, the response was
   * lost). Recreating in that case orphans the first group and duplicates the
   * task; assuming failure is just as wrong. The marker is the only evidence
   * that survives a lost response.
   */
  findGroupByMarker?(marker: string): Promise<
    | { state: 'none' }
    | { state: 'found'; chatId: string }
    | { state: 'ambiguous'; chatIds: string[] }
  >;
  /** Live roster of bots in the chat, from the birthing bot's viewpoint. */
  listChatBots(chatId: string): Promise<Array<{ larkAppId: string; openId: string; mentionable: boolean }>>;
  /** This bot's own view of a peer's profile entry hash (the caller computes
   *  the expected hash from ITS copy of the profile). */
  readProfileEntryHash(profileId: string, larkAppId: string): string | null;
  /** Ask the peer's daemon to apply this bot's entry as its per-chat role. */
  requestRoleApply(input: {
    peerLarkAppId: string;
    request: {
      protocol: typeof COLLAB_ROLE_PROTOCOL;
      requestId: string;
      configFingerprint: string;
      chatId: string;
      profileId: string;
      expectedHash: string;
      force: boolean;
    };
  }): Promise<CollabRoleApplyReceipt | null>;
  /** Read back the peer's current chat-role hash (the second readiness fence). */
  readbackRole(input: {
    peerLarkAppId: string;
    chatId: string;
    profileId: string;
  }): Promise<CollabRoleReadbackResult | null>;
  /** Post the @-mention kickoff for one member. Returns the messageId. */
  kickoff(input: {
    chatId: string;
    peerLarkAppId: string;
    peerOpenId: string;
    prompt: string;
  }): Promise<string>;
  /** Post/refresh the in-group progress card. `null` card = nothing to show. */
  updateProgressCard(input: {
    chatId: string;
    cardMessageId: string | undefined;
    journal: CollabBootstrapJournal;
  }): Promise<string | undefined>;
  /** Post the DM receipt/receipt-update linking the group. */
  updateDmReceipt(input: {
    chatId: string;
    dmChatId: string;
    sourceMessageId: string;
    messageId: string | undefined;
    journal: CollabBootstrapJournal;
  }): Promise<string | undefined>;
  /** Persist a journal mutation (returns null when the write was fenced off,
   *  e.g. the request was cancelled meanwhile — the caller MUST stop). */
  mutateJournal(
    requestId: string,
    mutate: (journal: CollabBootstrapJournal) => boolean | void,
  ): CollabBootstrapJournal | null;
  /** Read one member's journal slot without a full journal object. */
  log(level: 'info' | 'warn' | 'error', message: string): void;
  now?(): number;
}

/** How long a creation claim is honoured before another pass may retry. */
export const CREATE_CLAIM_TTL_MS = 120_000;

/**
 * How long a kickoff SEND claim is honoured before another pass may retry.
 *
 * Short: the send is one Lark API call. Long enough to cover a retry storm,
 * short enough that a crash before delivery recovers on the next resume rather
 * than stalling the stage for minutes.
 */
export const SEND_CLAIM_TTL_MS = 30_000;

export interface CollabBootstrapArgs {
  journal: CollabBootstrapJournal;
  /** Identifies this pass in the creation claim (diagnostics only). */
  claimBy?: string;
  /**
   * The LIVE configuration fingerprint, recomputed from current bot config.
   *
   * The journal froze a snapshot at creation. Re-reading the live value before
   * every external side effect is what makes "config edited mid-flight ⟹ the
   * old request stops" true: without it a request keeps kicking off stages from
   * a profile the operator already replaced.
   */
  liveConfigFingerprint?: () => string;
  /** Template working dir for the new chat, if the bot has one configured. */
  workingDir?: string;
  /** Placeholder chat name (same two-phase naming the legacy path uses). */
  name: string;
  ownerOpenId: string;
}

export interface CollabBootstrapOutcome {
  chatId: string;
  /** 'ready' = every member is joined + role-confirmed (and started, per policy). */
  status: 'ready' | 'failed' | 'cancelled';
  failureReason?: string;
}

const DEFAULT_TIMEOUT_MS = DEFAULT_COLLAB_INIT_TIMEOUT_MS;

function memberSlots(config: CollabGroupConfig): CollabMemberConfig[] {
  return config.members ?? [];
}

function memberOf(journal: CollabBootstrapJournal, larkAppId: string): CollabMemberJournal | undefined {
  return journal.members[larkAppId];
}

/**
 * Is every member's start step terminal?
 *
 * `pending` = waiting for an upstream that has not completed; `sent`/`running`
 * = a turn is in flight. Only `completed`/`failed` are settled, so a journal
 * with any of the former must stay resumable.
 */
export function allStagesSettled(journal: CollabBootstrapJournal): boolean {
  return Object.values(journal.members)
    .every(m => m.start.state === 'completed' || m.start.state === 'failed');
}

/**
 * Every stage COMPLETED (nothing failed, nothing pending).
 *
 * Distinct from {@link allStagesSettled}: a settled request with a failed stage
 * is FINISHED but not successful, so it must never be reported `ready` — a
 * group whose reviewer never ran is not a working collaboration, and `ready` is
 * what the card, the DM receipt and the resume sweep all read.
 */
export function allStagesCompleted(journal: CollabBootstrapJournal): boolean {
  return Object.values(journal.members).every(m => m.start.state === 'completed');
}

/**
 * May a normal message in this group start a CLI yet?
 *
 * This is the issue's "初始化未就绪时群内新任务也不能绕过门槛" gate, and the
 * condition is ROLE READINESS — every member joined and role-confirmed — not
 * the request's lifecycle status. Keying it on `status === 'ready'` conflated
 * the two: a group whose roles were all confirmed but whose reviewer was still
 * waiting for the builder read as "not ready", and a group that had merely
 * kicked off its first wave read as "ready".
 */
export function collabRolesReady(journal: CollabBootstrapJournal): boolean {
  return Object.values(journal.members)
    .every(m => m.join.state === 'joined' && m.role.state === 'confirmed');
}

/** Human-facing stage label for cards/logs. Falls back to a shortened app id. */
export function collabMemberLabel(member: CollabMemberConfig): string {
  return member.stage?.trim() || member.larkAppId.slice(0, 12);
}

function failureText(reason: string): string {
  switch (reason) {
    case 'missing_entry': return 'profile 里没有这个 Bot 的角色条目';
    case 'entry_changed': return 'profile 条目在途中被修改';
    case 'chat_role_conflict': return '本群已有不同的角色，未覆盖';
    case 'no_receipt': return '没有收到角色应用回执';
    case 'stale_receipt': return '回执属于另一次初始化请求';
    case 'config_changed': return '配置在途中被修改';
    case 'wrong_chat': return '回执指向另一个群';
    case 'applied_hash_mismatch': return '应用的角色内容与预期不一致';
    case 'no_readback': return '没有完成角色回读确认';
    case 'readback_failed': return '角色回读失败';
    case 'role_changed_after_apply': return '角色应用后又被改写';
    case 'not_joined': return 'Bot 未成功入群';
    case 'upstream_timeout': return '等待上游完成超时';
    case 'timeout': return '初始化超时';
    default: return reason;
  }
}

/**
 * Run (or resume) one bootstrap.
 *
 * Failure is terminal for the request but never destructive: the group stays,
 * the journal records exactly which step failed and why, and the card shows it.
 * A retry is a NEW request with a NEW config fingerprint, so an old journal can
 * never be quietly resumed into a different configuration.
 */
export async function runCollabBootstrap(
  deps: CollabBootstrapDeps,
  args: CollabBootstrapArgs,
): Promise<CollabBootstrapOutcome> {
  const now = deps.now ?? Date.now;
  const { journal } = args;
  const config = journal.config;
  const timeoutMs = config.onInitTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Absolute, from the journal. A journal written by an older build has none;
  // freezing one here keeps the "a restart must not extend the budget" property
  // for it too, from this pass onward.
  const deadline = journal.deadlineAt ?? (now() + timeoutMs);

  /**
   * Has the live config drifted from the frozen snapshot?
   *
   * Checked immediately before each external side effect (create, role apply,
   * kickoff). A drift makes the request stale: it must stop, not finish work
   * under a configuration nobody is looking at any more.
   */
  const configDrifted = (): string | null => {
    const live = args.liveConfigFingerprint?.();
    if (!live || live === journal.configFingerprint) return null;
    return 'config_changed';
  };

  const cancelled = (): CollabBootstrapOutcome => ({
    chatId: journal.chatId ?? '',
    status: 'cancelled',
    failureReason: 'cancelled',
  });
  const failed = (chatId: string, reason: string): CollabBootstrapOutcome => ({
    chatId,
    status: 'failed',
    failureReason: reason,
  });

  // ── 1. create the chat (skipped once chatId is persisted) ────────────────
  let chatId = journal.chatId;
  if (!chatId) {
    // Single-flight: take the creation claim INSIDE the journal lock. Two
    // concurrent passes (a resume sweep racing a turn report, or two daemons
    // after a restart) both see "no chatId"; without this claim each of them
    // creates a group, and the second becomes an orphan nobody can find.
    const claimed = deps.mutateJournal(journal.requestId, j => {
      if (j.chatId) return false;
      if (j.status !== 'pending' && j.status !== 'running') return false;
      const held = j.createClaim;
      if (held && now() < held.at + held.ttlMs) return false;
      j.createClaim = { at: now(), ttlMs: CREATE_CLAIM_TTL_MS, by: args.claimBy ?? 'owner' };
    });
    if (!claimed) {
      // Someone else is creating (or already created). Do not create; just
      // report the current state so the caller stops instead of duplicating.
      deps.log('info', `[collab] create claim held elsewhere for ${journal.requestId}`);
      const currentChat = journal.chatId ?? '';
      return { chatId: currentChat, status: 'failed', failureReason: 'create_in_progress' };
    }
    const driftBeforeCreate = configDrifted();
    if (driftBeforeCreate) {
      deps.log('info', `[collab] ${journal.requestId} stopped before create: config changed`);
      deps.mutateJournal(journal.requestId, j => {
        j.status = 'failed';
        j.failureReason = driftBeforeCreate;
      });
      return failed('', driftBeforeCreate);
    }

    // Before creating, ask whether a previous attempt already made this group.
    // A lost `chat.create` response leaves no local chatId, so without this the
    // retry either orphans that group or creates a second one.
    if (deps.findGroupByMarker) {
      const marker = `#${journal.requestId.slice(0, 8)}`;
      let found: Awaited<ReturnType<NonNullable<CollabBootstrapDeps['findGroupByMarker']>>>;
      try {
        found = await deps.findGroupByMarker(marker);
      } catch (err) {
        // Cannot prove either way: fail closed rather than risk a duplicate.
        deps.log('warn', `[collab] marker lookup failed for ${journal.requestId}: ${err}`);
        found = { state: 'ambiguous', chatIds: [] };
      }
      if (found.state === 'ambiguous') {
        deps.log('error', `[collab] ${found.chatIds.length} groups carry marker ${marker}; refusing to guess`);
        deps.mutateJournal(journal.requestId, j => {
          j.status = 'failed';
          j.failureReason = found.chatIds.length
            ? `ambiguous_group: ${found.chatIds.join(',')}`
            : 'group_lookup_unavailable';
        });
        return { chatId: '', status: 'failed', failureReason: 'ambiguous_group' };
      }
      if (found.state === 'found') {
        const claimed = deps.mutateJournal(journal.requestId, j => {
          j.chatId = found.chatId;
          delete j.createClaim;
        });
        if (!claimed) return cancelled();
        deps.log('info', `[collab] claimed existing group ${found.chatId} for ${journal.requestId}`);
        return runCollabBootstrap(deps, { ...args, journal: claimed });
      }
    }

    const peers = memberSlots(config).map(m => m.larkAppId);
    let created: string | undefined;
    let result: Awaited<ReturnType<CollabBootstrapDeps['createGroup']>>;
    try {
      result = await deps.createGroup({
        larkAppIds: peers,
        name: args.name,
        userOpenIds: [args.ownerOpenId],
        managerUserIds: [args.ownerOpenId],
        ...(args.workingDir ? { bindWorkingDir: args.workingDir } : {}),
        onChatCreated: (id) => {
          created = id;
          // The durable boundary. Written BEFORE invites/roles/kickoff, so a
          // crash right here resumes into THIS chat instead of creating a second
          // one. A fenced-off write (request cancelled meanwhile) is logged by
          // the caller; the chat still exists and stays for a human.
          deps.mutateJournal(journal.requestId, j => { j.chatId = id; });
        },
      });
    } catch (err) {
      // `created` set + throw means the chat exists and only a LATER step
      // failed. Do not rebuild: resume from the persisted chatId.
      const message = String((err as Error)?.message ?? err);
      if (created) {
        deps.log('warn', `[collab] chat ${created} created but init threw: ${message}`);
        const resumed = deps.mutateJournal(journal.requestId, j => { j.chatId = created; });
        if (!resumed) return cancelled();
        return runCollabBootstrap(deps, { ...args, journal: resumed });
      }
      deps.log('error', `[collab] create failed for ${journal.requestId}: ${message}`);
      deps.mutateJournal(journal.requestId, j => {
        j.status = 'failed';
        j.failureReason = 'group_create_failed';
      });
      return failed('', 'group_create_failed');
    }

    chatId = result.chatId || created;
    if (!chatId) {
      deps.mutateJournal(journal.requestId, j => {
        j.status = 'failed';
        j.failureReason = 'no_chat_id';
      });
      return failed('', 'no_chat_id');
    }
    // An explicit working dir that did not bind for a participating bot means
    // that bot would run in its OWN default directory — the wrong repository,
    // silently. The legacy birth path already refuses this; the collaboration
    // path must too.
    if (args.workingDir && result.oncallBindings) {
      const bindFailures = result.oncallBindings.filter(b => !b.ok);
      if (bindFailures.length > 0) {
        const detail = bindFailures.map(b => `${b.larkAppId}: ${b.error ?? 'bind failed'}`).join('; ');
        deps.log('error', `[collab] working-dir binding failed for ${detail}`);
        deps.mutateJournal(journal.requestId, j => {
          j.status = 'failed';
          j.failureReason = `working_dir_bind_failed: ${detail}`;
        });
        return failed(chatId, 'working_dir_bind_failed');
      }
    }
    // A kickoff from this bot is rejected by a peer whose talk gate does not
    // trust it, and no CLI turn ever starts. Without the grant matrix the whole
    // collaboration silently produces nothing.
    if (result.collaborationError) {
      deps.log('error', `[collab] bot talk-grant matrix failed: ${result.collaborationError}`);
      deps.mutateJournal(journal.requestId, j => {
        j.status = 'failed';
        j.failureReason = `collaboration_grants_failed: ${result.collaborationError}`;
      });
      return failed(chatId, 'collaboration_grants_failed');
    }

    if (result.invalidUserIds.includes(args.ownerOpenId)) {
      // The group exists but the person it is FOR could not join — useless as a
      // conversation home, and leaving it behind creates an orphan bot-owned
      // chat nobody will ever find. Same cleanup the legacy path does.
      await deps.disbandGroup(chatId).catch(err =>
        deps.log('warn', `[collab] disband ${chatId} failed: ${err}`));
      deps.mutateJournal(journal.requestId, j => {
        j.status = 'failed';
        j.failureReason = 'owner_invite_rejected';
      });
      return failed(chatId, 'owner_invite_rejected');
    }
    const afterCreate = deps.mutateJournal(journal.requestId, j => {
      j.chatId = chatId;
      delete j.createClaim;
    });
    if (!afterCreate) return cancelled();
    journal.chatId = chatId;
  }

  // Re-read once: another writer (cancel button, resume sweep) may have moved
  // the request while we were creating. Never work off a stale snapshot.
  const reloaded = deps.mutateJournal(journal.requestId, j => {
    // Never overwrite a terminal state. `ready` is also terminal: a second
    // pass on an already-finished request must not reopen it.
    if (j.status !== 'pending' && j.status !== 'running') return false;
    j.status = 'running';
  });
  if (!reloaded) return cancelled();
  const live = reloaded;
  chatId = live.chatId!;

  const ordered = orderCollabMembers(memberSlots(config), config.startPolicy ?? 'staged');

  // ── 2. membership ────────────────────────────────────────────────────────
  let roster: Awaited<ReturnType<CollabBootstrapDeps['listChatBots']>>;
  try {
    roster = await deps.listChatBots(chatId);
  } catch (err) {
    deps.log('warn', `[collab] roster read failed for ${chatId}: ${err}`);
    roster = [];
  }
  const rosterById = new Map(roster.map(m => [m.larkAppId, m]));
  for (const member of ordered) {
    const slot = memberOf(live, member.larkAppId);
    if (!slot || slot.join.state === 'joined' || slot.join.state === 'failed') continue;
    if (!rosterById.has(member.larkAppId)) {
      deps.mutateJournal(live.requestId, j => {
        const s = j.members[member.larkAppId];
        if (!s) return;
        s.join = { state: 'failed', at: now(), error: 'not_joined' };
      });
      continue;
    }
    deps.mutateJournal(live.requestId, j => {
      const s = j.members[member.larkAppId];
      if (!s) return;
      s.join = { state: 'joined', at: now() };
    });
  }

  // ── 3+4. role apply + readiness confirm ──────────────────────────────────
  //
  // Re-read after the join pass: `mutateJournal` returns a FRESH copy on every
  // write, so the snapshot taken before the loop no longer reflects what the
  // join pass just recorded. Reading a stale `live` here is how every member
  // would look "not joined" and the whole request would fail for no reason.
  let current = deps.mutateJournal(live.requestId, () => undefined) ?? live;
  const profileId = config.profileId?.trim();
  const roleFailures: string[] = [];
  for (const member of ordered) {
    current = deps.mutateJournal(live.requestId, () => undefined) ?? current;
    const slot = memberOf(current, member.larkAppId);
    if (!slot) continue;
    if (slot.join.state !== 'joined') {
      roleFailures.push(`${collabMemberLabel(member)}: ${failureText('not_joined')}`);
      continue;
    }
    if (slot.role.state === 'confirmed') continue;
    if (now() > deadline) {
      deps.mutateJournal(live.requestId, j => {
        const s = j.members[member.larkAppId];
        if (s) s.role = { ...s.role, state: 'failed', at: now(), error: 'timeout' };
      });
      roleFailures.push(`${collabMemberLabel(member)}: ${failureText('timeout')}`);
      continue;
    }

    if (!profileId) {
      deps.mutateJournal(live.requestId, j => {
        const s = j.members[member.larkAppId];
        if (s) s.role = { ...s.role, state: 'failed', at: now(), error: 'missing_entry' };
      });
      roleFailures.push(`${collabMemberLabel(member)}: ${failureText('missing_entry')}`);
      continue;
    }

    // The expected hash comes from THIS bot's copy of the profile entry. A
    // missing entry is decided here, before any IPC: there is nothing to ask a
    // peer to apply, and falling back to its default role is precisely what the
    // issue forbids.
    const expectedHash = deps.readProfileEntryHash(profileId, member.larkAppId);
    if (!expectedHash) {
      deps.mutateJournal(live.requestId, j => {
        const s = j.members[member.larkAppId];
        if (s) s.role = { ...s.role, state: 'failed', at: now(), error: 'missing_entry' };
      });
      roleFailures.push(`${collabMemberLabel(member)}: ${failureText('missing_entry')}`);
      continue;
    }

    const driftBeforeRole = configDrifted();
    if (driftBeforeRole) {
      deps.log('info', `[collab] ${journal.requestId} stopped before role apply: config changed`);
      deps.mutateJournal(live.requestId, j => {
        j.status = 'failed';
        j.failureReason = driftBeforeRole;
      });
      return failed(chatId, driftBeforeRole);
    }

    // Fence BEFORE the external call: a cancel that landed while we were
    // preparing must stop here, not be overtaken by the IPC we are about to
    // send.
    const fenced = deps.mutateJournal(live.requestId, j => {
      if (j.status === 'cancelled' || j.status === 'failed') return false;
      const s = j.members[member.larkAppId];
      if (!s) return false;
      s.role = { state: 'requested', at: now() };
    });
    if (!fenced) return cancelled();
    current = fenced;

    let receipt: CollabRoleApplyReceipt | null = null;
    try {
      receipt = await deps.requestRoleApply({
        peerLarkAppId: member.larkAppId,
        request: {
          protocol: COLLAB_ROLE_PROTOCOL,
          requestId: live.requestId,
          configFingerprint: live.configFingerprint,
          chatId,
          profileId,
          expectedHash,
          // NEVER force. A conflict is a signal that a human set that role on
          // purpose, and `role.state === 'requested'` does NOT prove we
          // successfully wrote it — it only proves we were about to. Forcing on
          // that basis would overwrite a role someone set while our IPC was in
          // flight. A genuine resume does not need force: the peer's
          // `planCollabRoleApply` already returns `noop` when the content it
          // holds is exactly what we ask for, and refuses when it differs.
          force: false,
        },
      });
    } catch (err) {
      deps.log('warn', `[collab] role apply to ${member.larkAppId} threw: ${err}`);
      receipt = null;
    }

    // Re-read after the IPC: the request may have been cancelled (or failed)
    // while the peer was answering. A successful receipt must NOT revive it —
    // that is exactly how a cancelled initialization used to keep working.
    const afterIpc = deps.mutateJournal(live.requestId, () => undefined);
    if (!afterIpc || afterIpc.status === 'cancelled' || afterIpc.status === 'failed') {
      deps.log('info', `[collab] ${member.larkAppId} role reply discarded: request is ${afterIpc?.status ?? 'gone'}`);
      return cancelled();
    }
    current = afterIpc;

    let readback: CollabRoleReadbackResult | null = null;
    if (receipt?.ok) {
      try {
        readback = await deps.readbackRole({ peerLarkAppId: member.larkAppId, chatId, profileId });
      } catch (err) {
        deps.log('warn', `[collab] readback from ${member.larkAppId} threw: ${err}`);
        readback = null;
      }
    }

    if (now() > deadline) {
      // The IPC itself ate the budget. Confirming readiness from a reply that
      // arrived after the deadline would start work under an expired request.
      deps.mutateJournal(live.requestId, j => {
        const s2 = j.members[member.larkAppId];
        if (s2) s2.role = { ...s2.role, state: 'failed', at: now(), error: 'timeout' };
      });
      roleFailures.push(`${collabMemberLabel(member)}: ${failureText('timeout')}`);
      continue;
    }

    const verdict = acceptCollabRoleReceipt({
      receipt,
      requestId: live.requestId,
      configFingerprint: live.configFingerprint,
      chatId,
      expectedHash,
      readback,
    });
    if (verdict.ready) {
      deps.mutateJournal(live.requestId, j => {
        const s = j.members[member.larkAppId];
        if (!s) return;
        s.role = {
          state: 'confirmed',
          at: now(),
          confirmedAt: now(),
          appliedHash: verdict.appliedHash,
        };
      });
    } else {
      deps.mutateJournal(live.requestId, j => {
        const s = j.members[member.larkAppId];
        if (!s) return;
        s.role = { ...s.role, state: 'failed', at: now(), error: verdict.reason };
      });
      roleFailures.push(`${collabMemberLabel(member)}: ${failureText(verdict.reason)}`);
    }
  }

  // Any member that could not join or confirm blocks the WHOLE request: the
  // issue is explicit that a half-ready collaboration must not start working.
  if (roleFailures.length > 0) {
    const reason = roleFailures.join('; ');
    deps.mutateJournal(live.requestId, j => {
      j.status = 'failed';
      j.failureReason = reason;
    });
    const snapshot = deps.mutateJournal(live.requestId, j => { j.status = 'failed'; }) ?? live;
    await deps.updateProgressCard({ chatId, cardMessageId: snapshot.cardMessageId, journal: snapshot })
      .then(id => { if (id) deps.mutateJournal(live.requestId, j => { j.cardMessageId = id; }); })
      .catch(err => deps.log('warn', `[collab] progress card failed: ${err}`));
    await deps.updateDmReceipt({
      chatId,
      dmChatId: live.sourceChatId,
      sourceMessageId: live.sourceMessageId,
      messageId: live.dmReceiptMessageId,
      journal: snapshot,
    }).catch(err => deps.log('warn', `[collab] dm receipt failed: ${err}`));
    return failed(chatId, reason);
  }

  // ── 5. start, honouring dependency edges ────────────────────────────────
  // Freeze the dependency budget the first time we are actually able to start.
  // Absolute + persisted for the same reason as the request deadline.
  if (!current.dependencyDeadlineAt) {
    const withDep = deps.mutateJournal(live.requestId, j => {
      if (j.dependencyDeadlineAt !== undefined) return false;
      j.dependencyDeadlineAt = now() + (config.onInitTimeoutMs ?? DEFAULT_TIMEOUT_MS);
    });
    if (withDep) current = withDep;
  }
  const startPolicy = config.startPolicy ?? 'staged';
  const started = await startReadyMembers(deps, {
    journal: deps.mutateJournal(live.requestId, j => {
      if (j.status !== 'pending' && j.status !== 'running') return false;
      j.status = 'running';
    }) ?? current,
    chatId,
    rosterById,
    ordered,
    startPolicy,
    now,
    configDrifted,
  });
  if (started.cancelled) return cancelled();
  if (started.failure) {
    const snapshot = deps.mutateJournal(live.requestId, j => {
      j.status = 'failed';
      j.failureReason = started.failure;
    }) ?? live;
    await deps.updateProgressCard({ chatId, cardMessageId: snapshot.cardMessageId, journal: snapshot })
      .catch(err => deps.log('warn', `[collab] progress card failed: ${err}`));
    return failed(chatId, started.failure!);
  }

  // The request is only `ready` — i.e. terminal — once EVERY stage has settled.
  // Setting it as soon as the first wave was kicked off is the bug that closed
  // the gate and the live-journal lookup while a dependent stage was still
  // waiting for its upstream: the group then looked "initialized" with a
  // reviewer that never started, and the turn report had nowhere to land.
  const settled = deps.mutateJournal(live.requestId, j => {
    if (!allStagesSettled(j)) return false;
    if (allStagesCompleted(j)) {
      j.status = 'ready';
      return;
    }
    // Settled with a failure: the request is OVER, but it did not succeed.
    // Marking it `ready` would tell every reader the collaboration works.
    j.status = 'failed';
    j.failureReason = j.failureReason
      ?? Object.entries(j.members)
        .filter(([, m]) => m.start.state === 'failed')
        .map(([id, m]) => `${id}: ${failureText(m.start.error ?? 'failed')}`)
        .join('; ');
  }) ?? live;
  const cardId = await deps.updateProgressCard({ chatId, cardMessageId: settled.cardMessageId, journal: settled })
    .catch(err => { deps.log('warn', `[collab] progress card failed: ${err}`); return undefined; });
  if (cardId) deps.mutateJournal(live.requestId, j => { j.cardMessageId = cardId; });
  const dmId = await deps.updateDmReceipt({
    chatId,
    dmChatId: settled.sourceChatId,
    sourceMessageId: settled.sourceMessageId,
    messageId: settled.dmReceiptMessageId,
    journal: settled,
  }).catch(err => { deps.log('warn', `[collab] dm receipt failed: ${err}`); return undefined; });
  if (dmId) deps.mutateJournal(live.requestId, j => { j.dmReceiptMessageId = dmId; });

  // The GROUP is usable either way (roles are confirmed), but a request whose
  // stages settled with a failure must not be reported as a success: the caller
  // uses this outcome to decide whether to re-home the turn and to render the
  // DM receipt.
  if (settled.status === 'failed') {
    return { chatId, status: 'failed', failureReason: settled.failureReason ?? 'stage_failed' };
  }
  // Still 'running' here means a dependent stage is waiting on its upstream —
  // that is the healthy mid-flight state, not a failure.
  return { chatId, status: 'ready' };
}

/**
 * Kick off every member whose dependencies are already `completed`.
 *
 * Deliberately returns instead of looping on a wait: the terminal that unblocks
 * a dependent arrives on a completely different call stack (the worker's
 * `turn_terminal`), so the resume path is the same function called again from
 * that callback. That is also why "completed" is a persisted journal state and
 * not an in-memory promise — a restart between two stages must not lose the
 * fact that the first stage finished.
 */
async function startReadyMembers(
  deps: CollabBootstrapDeps,
  input: {
    journal: CollabBootstrapJournal;
    chatId: string;
    rosterById: Map<string, { larkAppId: string; openId: string; mentionable: boolean }>;
    ordered: CollabMemberConfig[];
    startPolicy: 'staged' | 'all';
    now(): number;
    /** Live-config drift probe; see {@link CollabBootstrapArgs.liveConfigFingerprint}. */
    configDrifted(): string | null;
  },
): Promise<{ cancelled?: boolean; failure?: string }> {
  const { journal, chatId, rosterById, ordered, startPolicy, now, configDrifted } = input;
  const task = journal.taskText;
  const dependencyDeadline = journal.dependencyDeadlineAt
    ?? (journal.deadlineAt ?? (now() + (journal.config.onInitTimeoutMs ?? DEFAULT_TIMEOUT_MS)));

  for (const member of ordered) {
    const slot = journal.members[member.larkAppId];
    if (!slot) continue;
    if (slot.start.state === 'sent' || slot.start.state === 'running'
      || slot.start.state === 'completed' || slot.start.state === 'failed') continue;

    // No prompt = join + apply the role, but do not start a turn. Recorded as
    // completed so a dependent is not blocked by a stage that never runs.
    if (!member.prompt?.trim()) {
      deps.mutateJournal(journal.requestId, j => {
        const s = j.members[member.larkAppId];
        if (s) s.start = { state: 'completed', at: now() };
      });
      continue;
    }

    if (startPolicy === 'staged') {
      const edges = (member.dependsOn ?? [])
        .map(dep => ({ dep, up: journal.members[dep] }))
        .filter((e): e is { dep: string; up: CollabMemberJournal } => !!e.up);
      // A dependency that FAILED must not silently hold its dependent in
      // "pending" forever: the request has already failed, and a pending row
      // reads as "still initializing". Report it as failed with the real cause.
      const brokenDep = edges.find(e => e.up.start.state === 'failed');
      if (brokenDep) {
        deps.log('warn', `[collab] ${member.larkAppId} blocked by failed upstream ${brokenDep.dep}`);
        deps.mutateJournal(journal.requestId, j => {
          const s = j.members[member.larkAppId];
          if (s) s.start = { state: 'failed', at: now(), error: 'upstream_failed' };
        });
        continue;
      }
      const blocked = edges.filter(e => e.up.start.state !== 'completed');
      if (blocked.length > 0) {
        // A dependent must not wait forever: an upstream turn that never
        // reports leaves the group reading "initializing" indefinitely, with no
        // failure anyone can act on. The budget is per-request and absolute, so
        // restarts cannot extend it.
        if (now() > dependencyDeadline) {
          deps.log('warn', `[collab] ${member.larkAppId} waited too long on ${blocked.map(e => e.dep).join(',')}`);
          deps.mutateJournal(journal.requestId, j => {
            const s2 = j.members[member.larkAppId];
            if (s2) s2.start = { state: 'failed', at: now(), error: 'upstream_timeout' };
          });
          return { failure: `${collabMemberLabel(member)}: ${failureText('upstream_timeout')}` };
        }
        continue;
      }
    }

    const peer = rosterById.get(member.larkAppId);
    if (!peer || !peer.mentionable) {
      deps.mutateJournal(journal.requestId, j => {
        const s = j.members[member.larkAppId];
        if (s) s.start = { state: 'failed', at: now(), error: 'not_mentionable' };
      });
      return { failure: `${collabMemberLabel(member)}: 无法 @ 到该 Bot` };
    }

    const upstream = (member.dependsOn ?? [])
      .map(dep => journal.members[dep])
      .filter((s): s is CollabMemberJournal => !!s)
      .map(s => {
        const cfg = ordered.find(m => m.larkAppId === s.larkAppId);
        return `${cfg ? collabMemberLabel(cfg) : s.larkAppId} 已完成`;
      })
      .join('、');

    const prompt = renderCollabPrompt(member.prompt, {
      task,
      upstream: upstream || '无',
      ...(member.stage ? { stage: member.stage } : {}),
    });

    const driftBeforeKickoff = configDrifted();
    if (driftBeforeKickoff) {
      deps.log('info', `[collab] ${journal.requestId} stopped before kickoff: config changed`);
      deps.mutateJournal(journal.requestId, j => {
        j.status = 'failed';
        j.failureReason = driftBeforeKickoff;
      });
      return { failure: driftBeforeKickoff };
    }

    // Claim the SEND before the external side effect, but with a recoverable
    // marker: `pending` + a claim, NOT `sent`.
    //
    // Writing `sent` first and then crashing before the send leaves a stage
    // that every later pass skips — permanently silent, with no kickoff ever
    // delivered. The claim instead says "a send is in flight"; a later pass
    // re-sends once the claim expires, and a successful send is recorded by the
    // write AFTER it. A cancel that landed while we were computing still stops
    // here.
    const claimed = deps.mutateJournal(journal.requestId, j => {
      if (j.status === 'cancelled' || j.status === 'failed') return false;
      const s = j.members[member.larkAppId];
      if (!s || s.start.state !== 'pending') return false;
      const held = s.start.claim;
      if (held && now() < held.at + held.ttlMs) return false;
      s.start = { ...s.start, claim: { at: now(), ttlMs: SEND_CLAIM_TTL_MS } };
    });
    if (!claimed) {
      // Either the request is terminal, the stage already advanced, or another
      // pass is mid-send. None of those is ours to duplicate.
      return { cancelled: journal.status === 'cancelled' };
    }

    try {
      const messageId = await deps.kickoff({
        chatId,
        peerLarkAppId: member.larkAppId,
        peerOpenId: peer.openId,
        prompt,
      });
      // Record success only now. A crash before this point leaves `pending`
      // with an expiring claim, so the next pass retries the send instead of
      // skipping the stage forever.
      deps.mutateJournal(journal.requestId, j => {
        const s = j.members[member.larkAppId];
        if (!s) return;
        s.start = { state: 'sent', at: now(), kickoffMessageId: messageId };
      });
      deps.log('info', `[collab] kicked off ${member.larkAppId} in ${chatId} (msg ${messageId.slice(0, 12)})`);
    } catch (err) {
      deps.mutateJournal(journal.requestId, j => {
        const s = j.members[member.larkAppId];
        if (s) s.start = { state: 'failed', at: now(), error: String((err as Error)?.message ?? err) };
      });
      return { failure: `${collabMemberLabel(member)}: 启动消息发送失败` };
    }
  }
  return {};
}

/**
 * Record that a member's turn finished, and re-run the start step so its
 * dependents can begin.
 *
 * `turnId` is matched against the journal's recorded kickoff turn so a terminal
 * from an unrelated turn in the same chat cannot satisfy a dependency. When the
 * daemon could not learn the turn id, the member still advances on ANY completed
 * turn from that bot in that chat — the alternative is a dependency that never
 * clears, which looks identical to a hang.
 */
/**
 * Mark a started stage as actually RUNNING.
 *
 * Called from the daemon when the kickoff turn for this chat is admitted to the
 * CLI (the same evidence the durable-primary path uses). It is the bridge
 * between "we posted the kickoff" and "a turn is really executing", which is
 * what makes a later terminal meaningful.
 */
export function markCollabStageRunning(
  journal: CollabBootstrapJournal,
  input: { larkAppId: string; turnId?: string },
): { changed: boolean } {
  const slot = journal.members[input.larkAppId];
  if (!slot || slot.start.state !== 'sent') return { changed: false };
  // No turnId means we cannot later correlate a terminal to THIS stage. Record
  // the transition but keep the stage uncorrelated, so `applyCollabTurnTerminal`
  // refuses to settle it (see the fail-closed rule there) instead of letting any
  // completed turn in the same chat stand in for it.
  const pending = slot.start.pendingTerminal;
  // Spread the existing step so `kickoffMessageId` (and any future field)
  // survives the transition; only the state and the correlation id change.
  slot.start = {
    ...slot.start,
    state: 'running',
    ...(input.turnId ? { turnId: input.turnId } : {}),
  };
  delete slot.start.claim;
  if (pending && input.turnId && pending.turnId === input.turnId) {
    // The terminal already arrived for THIS turn (reordered delivery). Settle
    // immediately instead of waiting for a second report that will never come.
    slot.start = {
      ...slot.start,
      state: pending.status === 'completed' ? 'completed' : 'failed',
      ...(pending.status !== 'completed' ? { error: pending.status } : {}),
    };
    delete slot.start.pendingTerminal;
  }
  return { changed: true };
}

export function applyCollabTurnTerminal(
  journal: CollabBootstrapJournal,
  input: { larkAppId: string; turnId?: string; status: 'completed' | 'failed' | 'cancelled' | 'ambiguous' },
): { changed: boolean; state?: 'completed' | 'failed' } {
  const slot = journal.members[input.larkAppId];
  if (!slot) return { changed: false };
  // A terminal settles a stage that is `running` — OR one still at `sent`,
  // PROVIDED the terminal carries the matching turnId. The two reports
  // (started, terminal) are independent IPC calls and can arrive out of order;
  // a short turn can finish before its own "started" report lands. Rejecting
  // the terminal then leaves the stage stuck at `running` forever once the
  // started report arrives, with the completion evidence already discarded.
  //
  // Safety is unchanged: the turnId must still match BOTH sides (below), so an
  // unrelated turn in the same chat cannot settle this stage — the only thing
  // that relaxes is WHICH step state may be settled, not the identity check.
  if (slot.start.state === 'sent') {
    // Reordering case: the terminal beat the started report, so this stage has
    // no turnId yet. Buffer the terminal instead of dropping it — the later
    // "started" report (or the next resume) settles it from here. Dropping it
    // was a real stall: the stage stays `sent`, `markCollabStageRunning` moves
    // it to `running`, and the completion proof is already gone.
    if (!input.turnId) return { changed: false };
    const held = slot.start.pendingTerminal;
    if (held && held.turnId !== input.turnId) {
      // A DIFFERENT turn already finished here. Keep the first one: it is the
      // one whose started report we are still waiting for.
      return { changed: false };
    }
    if (held && held.status === input.status) return { changed: false };
    slot.start = {
      ...slot.start,
      pendingTerminal: { turnId: input.turnId, status: input.status, at: Date.now() },
    };
    return { changed: true };
  }
  if (slot.start.state !== 'running') return { changed: false };
  // FAIL CLOSED on identity. A terminal may only settle the stage it belongs to,
  // and the only evidence of "belongs to" is a matching turnId on BOTH sides.
  // Accepting a missing id would let any completed turn from the same bot in the
  // same chat release a downstream stage that its own kickoff never triggered —
  // the exact "message ordering standing in for completion" the issue forbids.
  // A stage that never learned its turnId therefore stays `running` until the
  // request times out (visible on the card), instead of silently racing ahead.
  if (!slot.start.turnId || !input.turnId || slot.start.turnId !== input.turnId) {
    return { changed: false };
  }
  const next = input.status === 'completed' ? 'completed' : 'failed';
  slot.start = {
    ...slot.start,
    state: next,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(next === 'failed' ? { error: input.status } : {}),
  };
  return { changed: true, state: next };
}

/** Status line for one member, used by the progress card. */
export function collabMemberStatusLine(member: CollabMemberConfig, slot: CollabMemberJournal | undefined): string {
  const label = collabMemberLabel(member);
  if (!slot) return `${label}: 未记录`;
  if (slot.join.state === 'failed') return `${label}: ❌ ${failureText(slot.join.error ?? 'not_joined')}`;
  if (slot.join.state === 'pending') return `${label}: ⏳ 等待入群`;
  if (slot.role.state === 'failed') return `${label}: ❌ ${failureText(slot.role.error ?? 'unknown')}`;
  if (slot.role.state === 'pending') return `${label}: ⏳ 等待应用角色`;
  if (slot.role.state === 'requested') return `${label}: ⏳ 角色应用中`;
  if (slot.start.state === 'completed') return `${label}: ✅ 已完成`;
  if (slot.start.state === 'failed') return `${label}: ❌ ${failureText(slot.start.error ?? 'unknown')}`;
  if (slot.start.state === 'sent' || slot.start.state === 'running') return `${label}: ▶️ 进行中`;
  if (slot.role.state === 'confirmed') return `${label}: ✅ 角色就绪`;
  return `${label}: ⏳ 初始化中`;
}
