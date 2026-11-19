/**
 * Role-readiness protocol for DM-born collaboration groups (issue #3588).
 *
 * The gap this closes: `group-creator` sends `/role profile apply <id>` into
 * the new chat and records "the message was sent". A message is an INPUT to the
 * peer bot's daemon — accepted is not applied. The peer may be offline, may have
 * no entry for the profile, may already have a different role in that chat, or
 * may apply it and then have a human overwrite it a second later.
 *
 * So readiness is proven by a signed loopback round trip against the peer's OWN
 * daemon (the same host-secret channel workflow handoff and exact-chat-grant
 * use), and every receipt is fenced on the request that asked for it:
 *
 *   request  : { requestId, configFingerprint, chatId, profileId, expectedHash }
 *   receipt  : { ok, appliedHash, appliedAt, requestId, configFingerprint }
 *
 * A receipt is only accepted when
 *   1. its `requestId` is THIS request's (a late receipt from an earlier,
 *      cancelled or superseded attempt must never start a turn), and
 *   2. its `configFingerprint` is THIS request's (the config may have been
 *      edited mid-flight; the old request must not keep working), and
 *   3. its `appliedHash` equals the hash the caller computed from the profile
 *      entry (proves the peer wrote the content we asked for, not its default),
 *   4. and a readback still returns the same hash (someone may have rewritten
 *      the chat role between the write and our read).
 *
 * Everything in this file is pure: hashing, parsing and the decision table. The
 * IPC transport and the disk writes live in the daemon route and the store, so
 * this protocol can be exercised exhaustively with no Lark, no disk, no daemon.
 */

import { createHash } from 'node:crypto';

/** Wire protocol version. Bumped when the request/receipt shape changes; an
 *  older peer daemon answering a newer request is a hard "not ready". */
export const COLLAB_ROLE_PROTOCOL = 'v1';

export const COLLAB_ROLE_APPLY_ROUTE = '/api/collab/apply-chat-role';

/**
 * Peer → owner: "a turn I was given in your collaboration group finished".
 *
 * Necessary because a peer bot's turn terminal happens in the PEER's daemon,
 * while the journal lives in the OWNER's. Without this the owner would have to
 * infer completion from anything it can observe — message ordering, screen
 * polling, elapsed time — and every one of those is exactly what the issue
 * rules out as a stand-in for "the upstream stage is done".
 *
 * Scoped to the request: the owner only advances a member whose journal entry
 * names this request, this chat and this peer.
 */
export const COLLAB_TURN_REPORT_ROUTE = '/api/collab/turn-report';

/**
 * Peer → owner: "the kickoff turn you posted was admitted by my CLI".
 *
 * Same necessity as the terminal report: admission happens in the PEER's
 * daemon, but the stage state lives in the OWNER's journal. Without it a peer
 * stage stays `sent` forever, and because a terminal only settles a `running`
 * stage, its dependents never start.
 */
export const COLLAB_TURN_STARTED_ROUTE = '/api/collab/turn-started';

export interface CollabTurnStartedReport {
  protocol: typeof COLLAB_ROLE_PROTOCOL;
  requestId: string;
  chatId: string;
  larkAppId: string;
  turnId?: string;
}

/**
 * Why the caller's own app id is part of every peer report.
 *
 * The IPC secret is host-wide, so holding it proves "a trusted process on this
 * machine", NOT "the bot this report claims to be". A report whose `larkAppId`
 * is only self-declared lets any daemon on the host forge another member's
 * start/completion and release a downstream stage early.
 *
 * The caller therefore sends its OWN app id in a separate field, populated from
 * its own configuration — never from the report body — and the receiver
 * requires the two to agree.
 */
export const COLLAB_CALLER_APP_HEADER = 'x-botmux-collab-caller';

export interface CollabTurnReport {
  protocol: typeof COLLAB_ROLE_PROTOCOL;
  /** The bootstrap request the kickoff belonged to. */
  requestId: string;
  chatId: string;
  /** The reporting bot — the member whose turn finished. */
  larkAppId: string;
  turnId?: string;
  status: 'completed' | 'failed' | 'cancelled' | 'ambiguous';
}

export function parseCollabTurnStartedReport(raw: unknown): CollabTurnStartedReport | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (v.protocol !== COLLAB_ROLE_PROTOCOL) return null;
  if (!isValidCollabRequestId(v.requestId)) return null;
  if (typeof v.chatId !== 'string' || !v.chatId) return null;
  if (typeof v.larkAppId !== 'string' || !v.larkAppId) return null;
  return {
    protocol: COLLAB_ROLE_PROTOCOL,
    requestId: v.requestId,
    chatId: v.chatId,
    larkAppId: v.larkAppId,
    ...(typeof v.turnId === 'string' && v.turnId ? { turnId: v.turnId } : {}),
  };
}

export function parseCollabTurnReport(raw: unknown): CollabTurnReport | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (v.protocol !== COLLAB_ROLE_PROTOCOL) return null;
  if (!isValidCollabRequestId(v.requestId)) return null;
  if (typeof v.chatId !== 'string' || !v.chatId) return null;
  if (typeof v.larkAppId !== 'string' || !v.larkAppId) return null;
  if (!['completed', 'failed', 'cancelled', 'ambiguous'].includes(v.status as string)) return null;
  return {
    protocol: COLLAB_ROLE_PROTOCOL,
    requestId: v.requestId,
    chatId: v.chatId,
    larkAppId: v.larkAppId,
    ...(typeof v.turnId === 'string' && v.turnId ? { turnId: v.turnId } : {}),
    status: v.status as CollabTurnReport['status'],
  };
}

export interface CollabRoleApplyRequest {
  protocol: typeof COLLAB_ROLE_PROTOCOL;
  requestId: string;
  configFingerprint: string;
  chatId: string;
  profileId: string;
  /** sha256 of the profile entry the caller expects to be applied. */
  expectedHash: string;
  /** Overwrite an existing, different chat role. Off by default: a conflict is
   *  a real signal (a human set that role on purpose), not noise to bulldoze. */
  force: boolean;
}

export type CollabRoleApplyFailure =
  | 'invalid_request'
  | 'invalid_chat_id'
  | 'invalid_profile_id'
  | 'protocol_unsupported'
  /** The peer has no entry for this profile — do NOT fall back to its default
   *  role and start working anyway. */
  | 'missing_entry'
  /** The peer's entry no longer matches the hash the caller expects. */
  | 'entry_changed'
  /** This chat already has a different role and `force` was not set. */
  | 'chat_role_conflict';

export interface CollabRoleApplySuccess {
  ok: true;
  protocol: typeof COLLAB_ROLE_PROTOCOL;
  requestId: string;
  configFingerprint: string;
  chatId: string;
  appliedHash: string;
  appliedAt: number;
  /** False when the content was already in place (idempotent re-apply). */
  changed: boolean;
  /** True when an existing, different chat role was replaced. */
  overwrote: boolean;
}

export interface CollabRoleApplyError {
  ok: false;
  reason: CollabRoleApplyFailure;
  /** Present for `chat_role_conflict` / `entry_changed`: what IS there now, so
   *  the card can say what it found instead of only that it failed. */
  actualHash?: string;
  message?: string;
}

export type CollabRoleApplyReceipt = CollabRoleApplySuccess | CollabRoleApplyError;

/** Readback operation result — the second half of readiness. */
export interface CollabRoleReadbackRequest {
  protocol: typeof COLLAB_ROLE_PROTOCOL;
  chatId: string;
  profileId: string;
}

export interface CollabRoleReadbackResult {
  ok: true;
  protocol: typeof COLLAB_ROLE_PROTOCOL;
  chatId: string;
  /** Hash of the chat role file currently on disk (null = no chat role). */
  chatRoleHash: string | null;
  /** Hash of the profile entry currently on disk (null = no entry). */
  entryHash: string | null;
}

/** Normalize role text the same way the writers do (trim), then hash. Both
 *  sides must hash the SAME normalization or a trailing newline reads as a
 *  mismatch — the writers store `content.trim()`. */
export function hashRoleContent(content: string | null | undefined): string | null {
  if (content === null || content === undefined) return null;
  const normalized = content.trim();
  if (!normalized) return null;
  return `sha256:${createHash('sha256').update(normalized, 'utf-8').digest('hex')}`;
}

/**
 * A request's config fingerprint: the exact configuration the birthing daemon
 * froze for this request. Recomputed from the live config on every retry so an
 * edited config cannot continue an old initialization.
 */
export function collabConfigFingerprint(input: {
  profileId: string;
  startPolicy: 'staged' | 'all';
  /**
   * Whether collaboration is still ENABLED.
   *
   * Part of the fingerprint on purpose: turning the block off is an operator
   * decision that must make an in-flight request stale. Without it the value is
   * identical before and after a disable, and the old request keeps applying
   * roles and kicking off stages for a feature that is now off.
   */
  enabled?: boolean;
  members: ReadonlyArray<{ larkAppId: string; stage?: string; role?: string; prompt?: string; dependsOn?: readonly string[] }>;
}): string {
  // Stable serialization: members in their configured order, dependencies
  // sorted, no optional key emitted when absent. Anything less and a pure
  // reordering of `dependsOn` would look like a config change.
  const body = {
    enabled: input.enabled !== false,
    profileId: input.profileId,
    startPolicy: input.startPolicy,
    members: input.members.map(m => ({
      larkAppId: m.larkAppId,
      stage: m.stage ?? '',
      role: m.role ?? '',
      prompt: m.prompt ?? '',
      dependsOn: [...(m.dependsOn ?? [])].sort(),
    })),
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(body), 'utf-8').digest('hex')}`;
}

export function isValidCollabRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{8,64}$/.test(value);
}

/** Parse an untrusted request body (peer daemon side). Returns null when the
 *  shape is unusable — the caller answers `invalid_request`. */
export function parseCollabRoleApplyRequest(raw: unknown): CollabRoleApplyRequest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (v.protocol !== COLLAB_ROLE_PROTOCOL) return null;
  if (!isValidCollabRequestId(v.requestId)) return null;
  if (typeof v.configFingerprint !== 'string' || !v.configFingerprint) return null;
  if (typeof v.chatId !== 'string' || !v.chatId) return null;
  if (typeof v.profileId !== 'string' || !v.profileId) return null;
  if (typeof v.expectedHash !== 'string' || !v.expectedHash.startsWith('sha256:')) return null;
  return {
    protocol: COLLAB_ROLE_PROTOCOL,
    requestId: v.requestId,
    configFingerprint: v.configFingerprint,
    chatId: v.chatId,
    profileId: v.profileId,
    expectedHash: v.expectedHash,
    force: v.force === true,
  };
}

/**
 * The peer-side decision table: given what is on disk and what the request asks
 * for, what should happen?
 *
 * Kept separate from the route so every branch — including the ones that only
 * differ by "who wrote the file last" — is testable without a daemon.
 */
export type CollabRolePlan =
  | { action: 'write'; overwrote: boolean }
  | { action: 'noop' }
  | { action: 'refuse'; reason: CollabRoleApplyFailure; actualHash?: string };

export function planCollabRoleApply(input: {
  entryContent: string | null;
  chatRoleContent: string | null;
  expectedHash: string;
  force: boolean;
}): CollabRolePlan {
  const entryHash = hashRoleContent(input.entryContent);
  if (entryHash === null) {
    // No entry (or an empty one, which writers normalize away). An empty entry
    // would CLEAR the chat role — never something to do silently while starting
    // work, and never a reason to fall back to the bot's default role.
    return { action: 'refuse', reason: 'missing_entry' };
  }
  if (entryHash !== input.expectedHash) {
    return { action: 'refuse', reason: 'entry_changed', actualHash: entryHash };
  }
  const chatHash = hashRoleContent(input.chatRoleContent);
  if (chatHash === null) return { action: 'write', overwrote: false };
  if (chatHash === entryHash) return { action: 'noop' };
  if (!input.force) return { action: 'refuse', reason: 'chat_role_conflict', actualHash: chatHash };
  return { action: 'write', overwrote: true };
}

export type CollabRoleVerdict =
  | { ready: true; appliedHash: string }
  | { ready: false; reason: string };

/**
 * Caller-side acceptance: is this receipt proof that the member is ready?
 *
 * Deliberately strict on all four fences. Every one of them has a concrete
 * failure it prevents, and "it looked fine" is exactly the judgment this
 * function exists to remove.
 */
export function acceptCollabRoleReceipt(input: {
  receipt: CollabRoleApplyReceipt | null | undefined;
  requestId: string;
  configFingerprint: string;
  chatId: string;
  expectedHash: string;
  readback: CollabRoleReadbackResult | null | undefined;
}): CollabRoleVerdict {
  const r = input.receipt;
  if (!r) return { ready: false, reason: 'no_receipt' };
  if (!r.ok) return { ready: false, reason: r.reason };
  if (r.protocol !== COLLAB_ROLE_PROTOCOL) return { ready: false, reason: 'protocol_mismatch' };
  if (r.requestId !== input.requestId) return { ready: false, reason: 'stale_receipt' };
  if (r.configFingerprint !== input.configFingerprint) {
    return { ready: false, reason: 'config_changed' };
  }
  if (r.chatId !== input.chatId) return { ready: false, reason: 'wrong_chat' };
  if (r.appliedHash !== input.expectedHash) return { ready: false, reason: 'applied_hash_mismatch' };
  const back = input.readback;
  if (!back) return { ready: false, reason: 'no_readback' };
  if (!back.ok) return { ready: false, reason: 'readback_failed' };
  if (back.chatRoleHash !== input.expectedHash) {
    // Someone changed the chat role between the peer's write and our read.
    // The receipt was true when issued; it is not true now.
    return { ready: false, reason: 'role_changed_after_apply' };
  }
  if (back.entryHash !== null && back.entryHash !== undefined && back.entryHash !== input.expectedHash) {
    // The PROFILE ENTRY itself moved after the apply (someone edited the
    // profile). The chat role still holds the old content, so the group is now
    // running a role that no longer matches its source of truth — every retry
    // and every page would disagree with what is actually applied.
    return { ready: false, reason: 'entry_changed' };
  }
  return { ready: true, appliedHash: r.appliedHash };
}
