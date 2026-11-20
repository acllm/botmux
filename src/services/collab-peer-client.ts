/**
 * Calling a peer bot's daemon for collaboration-group role readiness.
 *
 * The channel is the trusted host loopback IPC (HMAC over method + path + port,
 * secret = `~/.botmux/.dashboard-secret`, unreadable inside a sandbox) — the
 * same one workflow handoff, exact-chat-grant and dispatch use. Reusing it means
 * the peer answers only a caller that already holds host authority, and the
 * request can never be forged by a CLI running as the bot.
 *
 * Design: docs/design/2026-11-20-dm-collab-group-bootstrap.md §4.3.
 */
import { fetchDaemonIpc } from '../core/daemon-ipc-auth.js';
import { findOnlineDaemon } from '../utils/daemon-discovery.js';
import {
  COLLAB_ROLE_APPLY_ROUTE,
  COLLAB_ROLE_PROTOCOL,
  COLLAB_TURN_REPORT_ROUTE,
  COLLAB_CALLER_APP_HEADER,
  COLLAB_TURN_STARTED_ROUTE,
  type CollabRoleApplyReceipt,
  type CollabRoleApplyRequest,
  type CollabRoleReadbackResult,
  type CollabTurnReport,
  type CollabTurnStartedReport,
} from '../core/collab-role-protocol.js';

export interface CollabPeerClientDeps {
  /** Daemon IPC port for a bot, or null when its daemon is offline. */
  findPort(larkAppId: string): number | null;
  /** Host-only IPC secret. Sandboxed callers fail closed here. */
  secret(): string;
  /**
   * This daemon's OWN app id.
   *
   * Sent as a separate header, never taken from the report body, so the
   * receiver can require "the caller is the bot it claims to be". The shared
   * host secret alone proves only "a trusted process on this machine".
   */
  selfLarkAppId(): string;
  /** Transport, injectable for tests. Defaults to the signed host fetch. */
  post?(
    port: number,
    path: string,
    body: unknown,
    secret: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; body: unknown }>;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

async function defaultPost(
  port: number,
  path: string,
  body: unknown,
  secret: string,
  headers: Record<string, string> = {},
) {
  const response = await fetchDaemonIpc(port, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  }, secret);
  const parsed: unknown = await response.json().catch(() => ({}));
  return { status: response.status, body: parsed };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Ask a peer daemon to materialize this bot's profile entry as its per-chat
 * role.
 *
 * Returns a receipt shaped by the protocol. Transport failures and offline
 * peers collapse to `null` — the orchestrator treats that as "not ready" with a
 * reason, which is the correct outcome: an unreachable peer has NOT applied
 * anything, and guessing otherwise is how a half-ready group starts working.
 */
export async function requestPeerRoleApply(
  deps: CollabPeerClientDeps,
  input: { peerLarkAppId: string; request: CollabRoleApplyRequest },
): Promise<CollabRoleApplyReceipt | null> {
  const port = deps.findPort(input.peerLarkAppId);
  if (!port) return null;
  const post = deps.post ?? defaultPost;
  let result: { status: number; body: unknown };
  try {
    result = await post(port, COLLAB_ROLE_APPLY_ROUTE, input.request, deps.secret(),
      { [COLLAB_CALLER_APP_HEADER]: deps.selfLarkAppId() });
  } catch {
    return null;
  }
  if (result.status !== 200) return null;
  const body = asRecord(result.body);
  if (!body) return null;
  if (body.ok === true) {
    if (body.protocol !== COLLAB_ROLE_PROTOCOL) return null;
    if (typeof body.appliedHash !== 'string' || typeof body.chatId !== 'string') return null;
    if (typeof body.requestId !== 'string' || typeof body.configFingerprint !== 'string') return null;
    return {
      ok: true,
      protocol: COLLAB_ROLE_PROTOCOL,
      requestId: body.requestId,
      configFingerprint: body.configFingerprint,
      chatId: body.chatId,
      appliedHash: body.appliedHash,
      appliedAt: typeof body.appliedAt === 'number' ? body.appliedAt : Date.now(),
      changed: body.changed === true,
      overwrote: body.overwrote === true,
    };
  }
  const reason = typeof body.reason === 'string' ? body.reason : 'invalid_request';
  return {
    ok: false,
    reason: reason as any,
    ...(typeof body.actualHash === 'string' ? { actualHash: body.actualHash } : {}),
    ...(typeof body.message === 'string' ? { message: body.message } : {}),
  };
}

/** Re-read the peer's on-disk chat role after it reported success. */
export async function readbackPeerRole(
  deps: CollabPeerClientDeps,
  input: { peerLarkAppId: string; chatId: string; profileId: string },
): Promise<CollabRoleReadbackResult | null> {
  const port = deps.findPort(input.peerLarkAppId);
  if (!port) return null;
  const post = deps.post ?? defaultPost;
  let result: { status: number; body: unknown };
  try {
    result = await post(port, COLLAB_ROLE_APPLY_ROUTE, {
      op: 'readback',
      chatId: input.chatId,
      profileId: input.profileId,
    }, deps.secret(), { [COLLAB_CALLER_APP_HEADER]: deps.selfLarkAppId() });
  } catch {
    return null;
  }
  if (result.status !== 200) return null;
  const body = asRecord(result.body);
  if (!body || body.ok !== true) return null;
  if (body.protocol !== COLLAB_ROLE_PROTOCOL) return null;
  if (typeof body.chatId !== 'string') return null;
  return {
    ok: true,
    protocol: COLLAB_ROLE_PROTOCOL,
    chatId: body.chatId,
    chatRoleHash: typeof body.chatRoleHash === 'string' ? body.chatRoleHash : null,
    entryHash: typeof body.entryHash === 'string' ? body.entryHash : null,
  };
}

/**
 * Production wiring for a daemon: peer ports come from the heartbeat
 * descriptors other daemons publish, and the secret is the host IPC secret.
 *
 * `dataDir` is threaded through so the probe and the caller's stores always
 * read the SAME directory — a data dir resolved differently in two places
 * would silently look like "every peer is offline".
 */
export function createCollabPeerClient(
  opts: {
    dataDir: string;
    secret: () => string;
    selfLarkAppId: () => string;
    post?: CollabPeerClientDeps['post'];
  },
): CollabPeerClientDeps {
  return {
    findPort: (larkAppId) => {
      const daemon = findOnlineDaemon(larkAppId, opts.dataDir);
      return daemon?.ipcPort ?? null;
    },
    secret: opts.secret,
    selfLarkAppId: opts.selfLarkAppId,
    ...(opts.post ? { post: opts.post } : {}),
  };
}

/**
 * Peer side: tell the OWNER daemon that a turn it kicked off in its
 * collaboration group finished.
 *
 * Best-effort by design. A lost report does NOT strand the bootstrap: the owner
 * retries the resume path (its journal is idempotent) and a member whose turn
 * already completed is not re-kicked. Returning false lets the caller log; it
 * must never throw into the terminal path.
 */
export async function reportCollabTurnTerminal(
  deps: CollabPeerClientDeps,
  input: { ownerLarkAppId: string; report: CollabTurnReport },
): Promise<boolean> {
  const port = deps.findPort(input.ownerLarkAppId);
  if (!port) return false;
  const post = deps.post ?? defaultPost;
  try {
    const result = await post(port, COLLAB_TURN_REPORT_ROUTE, input.report, deps.secret(),
      { [COLLAB_CALLER_APP_HEADER]: deps.selfLarkAppId() });
    if (result.status !== 200) return false;
    // A 200 with `ok:false` is the owner REJECTING the report (wrong request,
    // no matching stage, stale). Counting that as delivered would swallow the
    // only signal that a stage will never be released, so it must read as a
    // failed delivery and be logged.
    const body = asRecord(result.body);
    return body?.ok === true;
  } catch {
    return false;
  }
}

/** Peer side: the kickoff turn was admitted by this bot's CLI. */
export async function reportCollabTurnStarted(
  deps: CollabPeerClientDeps,
  input: { ownerLarkAppId: string; report: CollabTurnStartedReport },
): Promise<boolean> {
  const port = deps.findPort(input.ownerLarkAppId);
  if (!port) return false;
  const post = deps.post ?? defaultPost;
  try {
    const result = await post(port, COLLAB_TURN_STARTED_ROUTE, input.report, deps.secret(),
      { [COLLAB_CALLER_APP_HEADER]: deps.selfLarkAppId() });
    if (result.status !== 200) return false;
    return asRecord(result.body)?.ok === true;
  } catch {
    return false;
  }
}
