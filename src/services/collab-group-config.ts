/**
 * DM-born collaboration groups — configuration parsing and preflight.
 *
 * See docs/design/2026-11-20-dm-collab-group-bootstrap.md.
 *
 * Everything here is pure: no Lark call, no disk read, no daemon. The
 * dashboard (authoring + preflight preview) and the birthing daemon (execution)
 * both call the SAME `normalizeCollabConfig` / `preflightCollabConfig`, so a
 * config the page accepts is exactly a config the birth path will run — a
 * second, slightly different validator on either side is how "the page said it
 * was fine" becomes "the group silently did half the work".
 *
 * Two rules the shape enforces:
 *  - identity is the stable `larkAppId`; display names are never compared;
 *  - the birthing bot is implicit. Listing it as a member is an error, not a
 *    silent skip: a user who lists themselves believes that entry does
 *    something, and it cannot.
 */

import type { CollabGroupConfig, CollabMemberConfig } from '../bot-registry.js';

/** Members beyond this are almost certainly a copy/paste accident; also bounds
 *  the group's bot count (Feishu's chat-member batch limit is 5 per call). */
export const MAX_COLLAB_MEMBERS = 8;

/** Per-member prompt ceiling, matching the other prompt-shaped bot settings. */
export const MAX_COLLAB_PROMPT_CHARS = 4000;

export const DEFAULT_COLLAB_INIT_TIMEOUT_MS = 180_000;

const MIN_INIT_TIMEOUT_MS = 10_000;
const MAX_INIT_TIMEOUT_MS = 1_800_000;

const LARK_APP_ID_RE = /^cli_[A-Za-z0-9]{4,64}$/;

export class CollabConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CollabConfigError';
  }
}

function fail(message: string): never {
  throw new CollabConfigError(message);
}

function trimString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeMember(raw: unknown, index: number): CollabMemberConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`members[${index}] must be an object`);
  }
  const v = raw as Record<string, unknown>;
  const larkAppId = trimString(v.larkAppId);
  if (!larkAppId) fail(`members[${index}].larkAppId is required`);
  if (!LARK_APP_ID_RE.test(larkAppId)) {
    // `local_*` identities are apiOnly bots: they have no Lark transport, so
    // they can never join a chat, apply a role, or be @-mentioned. Accepting
    // them here would produce a group that silently lacks a member.
    fail(`members[${index}].larkAppId is not a Feishu app id: ${larkAppId}`);
  }
  const stage = trimString(v.stage);
  const role = trimString(v.role);
  const prompt = typeof v.prompt === 'string' ? v.prompt.trim() : undefined;
  if (prompt !== undefined && prompt.length > MAX_COLLAB_PROMPT_CHARS) {
    fail(`members[${index}].prompt exceeds ${MAX_COLLAB_PROMPT_CHARS} characters`);
  }
  let dependsOn: string[] | undefined;
  if (v.dependsOn !== undefined) {
    if (!Array.isArray(v.dependsOn) || v.dependsOn.some(x => typeof x !== 'string')) {
      fail(`members[${index}].dependsOn must be a list of app ids`);
    }
    const list = [...new Set((v.dependsOn as string[]).map(x => x.trim()).filter(Boolean))];
    for (const dep of list) {
      if (!LARK_APP_ID_RE.test(dep)) fail(`members[${index}].dependsOn has an invalid app id: ${dep}`);
      if (dep === larkAppId) fail(`members[${index}] depends on itself`);
    }
    if (list.length) dependsOn = list;
  }
  return {
    larkAppId,
    ...(stage ? { stage } : {}),
    ...(role ? { role } : {}),
    ...(prompt ? { prompt } : {}),
    ...(dependsOn ? { dependsOn } : {}),
  };
}

/**
 * Parse + validate a `sessionGroup.collab` block.
 *
 * Throws {@link CollabConfigError} on anything structurally wrong. Returns
 * `undefined` for an absent block so bots.json stays clean, and `{ enabled:
 * false }` for an explicit opt-out — the difference matters because an explicit
 * `false` is a persisted decision while an absent block just means "never
 * configured".
 */
export function normalizeCollabConfig(
  value: unknown,
  opts: { selfLarkAppId?: string } = {},
): CollabGroupConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) fail('sessionGroup.collab must be an object');
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (!['enabled', 'profileId', 'members', 'startPolicy', 'onInitTimeoutMs'].includes(key)) {
      fail(`Unknown sessionGroup.collab option: ${key}`);
    }
  }

  const enabled = v.enabled === true;
  const profileId = trimString(v.profileId);
  if (profileId && !/^[A-Za-z0-9._-]{1,64}$/.test(profileId)) {
    fail(`sessionGroup.collab.profileId is invalid: ${profileId}`);
  }

  let members: CollabMemberConfig[] | undefined;
  if (v.members !== undefined) {
    if (!Array.isArray(v.members)) fail('sessionGroup.collab.members must be a list');
    const parsed = (v.members as unknown[]).map((m, i) => normalizeMember(m, i));
    const seen = new Set<string>();
    for (const m of parsed) {
      if (seen.has(m.larkAppId)) fail(`sessionGroup.collab.members repeats ${m.larkAppId}`);
      seen.add(m.larkAppId);
    }
    const self = opts.selfLarkAppId?.trim();
    if (self && seen.has(self)) {
      fail(`sessionGroup.collab.members must not list the birthing bot itself (${self})`);
    }
    if (parsed.length > MAX_COLLAB_MEMBERS) {
      fail(`sessionGroup.collab.members exceeds ${MAX_COLLAB_MEMBERS} entries`);
    }
    if (parsed.length) members = parsed;
  }

  const startPolicy = v.startPolicy === 'all' ? 'all' : v.startPolicy === 'staged' ? 'staged' : undefined;
  if (v.startPolicy !== undefined && !startPolicy) {
    fail('sessionGroup.collab.startPolicy must be staged or all');
  }

  let onInitTimeoutMs: number | undefined;
  if (v.onInitTimeoutMs !== undefined) {
    const n = typeof v.onInitTimeoutMs === 'number' ? v.onInitTimeoutMs : Number.NaN;
    if (!Number.isInteger(n) || n < MIN_INIT_TIMEOUT_MS || n > MAX_INIT_TIMEOUT_MS) {
      fail(`sessionGroup.collab.onInitTimeoutMs must be an integer between ${MIN_INIT_TIMEOUT_MS} and ${MAX_INIT_TIMEOUT_MS}`);
    }
    onInitTimeoutMs = n;
  }

  // A dangling dependency edge is a config error, not a runtime warning: the
  // member it names will never complete, so the dependent member would wait
  // forever and the group would look "initializing" indefinitely.
  const ids = new Set((members ?? []).map(m => m.larkAppId));
  for (const m of members ?? []) {
    for (const dep of m.dependsOn ?? []) {
      if (!ids.has(dep)) fail(`${m.larkAppId} depends on ${dep}, which is not a member`);
    }
  }
  const cycle = findDependencyCycle(members ?? []);
  if (cycle) fail(`sessionGroup.collab.members has a dependency cycle: ${cycle.join(' -> ')}`);

  // An enabled block with no peers and no profile does nothing; persisting it
  // would flip the birth path onto a collaboration branch that then reports
  // "ready" without a single extra Agent in the room.
  if (enabled && (members ?? []).length === 0) {
    fail('sessionGroup.collab.enabled requires at least one member');
  }

  return {
    ...(enabled ? { enabled: true } : {}),
    ...(profileId ? { profileId } : {}),
    ...(members ? { members } : {}),
    ...(startPolicy ? { startPolicy } : {}),
    ...(onInitTimeoutMs ? { onInitTimeoutMs } : {}),
  };
}

/** Depth-first cycle detection; returns the cycle path (first id repeated last). */
export function findDependencyCycle(members: readonly CollabMemberConfig[]): string[] | null {
  const edges = new Map<string, string[]>();
  for (const m of members) edges.set(m.larkAppId, [...(m.dependsOn ?? [])]);
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const walk = (id: string): string[] | null => {
    const s = state.get(id);
    if (s === 'done') return null;
    if (s === 'visiting') {
      const start = stack.indexOf(id);
      return [...stack.slice(start === -1 ? 0 : start), id];
    }
    state.set(id, 'visiting');
    stack.push(id);
    for (const next of edges.get(id) ?? []) {
      const found = walk(next);
      if (found) return found;
    }
    stack.pop();
    state.set(id, 'done');
    return null;
  };

  for (const id of edges.keys()) {
    const found = walk(id);
    if (found) return found;
  }
  return null;
}

/**
 * Is collaboration actually configured to run? One predicate, called by the
 * birth path, so "enabled but empty" (rejected at write time) can never sneak
 * in through a hand-edited bots.json.
 */
export function collabConfigActive(collab: CollabGroupConfig | undefined): boolean {
  return collab?.enabled === true && (collab.members?.length ?? 0) > 0;
}

// ─── Preflight (what the page shows before saving) ──────────────────────────

export interface CollabPreflightInput {
  collab: CollabGroupConfig | undefined;
  selfLarkAppId: string;
  /** Bot configs this deployment knows about (bots.json, apiOnly included). */
  knownBots: ReadonlyArray<{ larkAppId: string; apiOnly?: boolean; displayName?: string }>;
  /** Bots whose daemon currently answers a heartbeat. */
  onlineBots: ReadonlySet<string>;
  /** Which app ids have an entry in the referenced role profile. */
  profileEntries: ReadonlySet<string>;
}

export type CollabPreflightIssue =
  | { code: 'collab_disabled' }
  | { code: 'profile_missing' }
  | { code: 'unknown_bot'; larkAppId: string }
  | { code: 'bot_not_mentionable'; larkAppId: string }
  | { code: 'bot_offline'; larkAppId: string }
  | { code: 'missing_profile_entry'; larkAppId: string }
  | { code: 'duplicate_member'; larkAppId: string }
  | { code: 'self_in_members'; larkAppId: string }
  | { code: 'dependency_cycle'; path: string[] }
  | { code: 'unknown_dependency'; larkAppId: string; dependsOn: string };

export interface CollabPreflightResult {
  /** True when nothing blocks a birth; warnings alone still allow saving. */
  ok: boolean;
  /** Blocking problems. */
  errors: CollabPreflightIssue[];
  /** Things that will work but deserve a second look (e.g. a member offline now). */
  warnings: CollabPreflightIssue[];
}

/**
 * Preflight runs on RAW config (pre-normalization) so the page can show what is
 * wrong instead of an opaque parse failure. It deliberately re-implements the
 * structural checks the normalizer enforces rather than catching its error
 * message: the page needs per-member rows, not one sentence.
 */
export function preflightCollabConfig(input: CollabPreflightInput): CollabPreflightResult {
  const errors: CollabPreflightIssue[] = [];
  const warnings: CollabPreflightIssue[] = [];
  const collab = input.collab;
  if (!collabConfigActive(collab)) {
    errors.push({ code: 'collab_disabled' });
    return { ok: false, errors, warnings };
  }
  const members = collab!.members ?? [];
  if (!collab!.profileId) {
    // Without a profile there is nothing to apply, so "role confirmed" could
    // never become true for any member.
    errors.push({ code: 'profile_missing' });
  }

  const known = new Map(input.knownBots.map(b => [b.larkAppId, b]));
  const seen = new Set<string>();
  for (const m of members) {
    if (seen.has(m.larkAppId)) errors.push({ code: 'duplicate_member', larkAppId: m.larkAppId });
    seen.add(m.larkAppId);
    if (m.larkAppId === input.selfLarkAppId) {
      errors.push({ code: 'self_in_members', larkAppId: m.larkAppId });
      continue;
    }
    const bot = known.get(m.larkAppId);
    if (!bot) {
      errors.push({ code: 'unknown_bot', larkAppId: m.larkAppId });
      continue;
    }
    if (bot.apiOnly) {
      // apiOnly bots have no Lark transport: they cannot be invited, cannot be
      // @-mentioned and cannot answer a role-apply IPC.
      errors.push({ code: 'bot_not_mentionable', larkAppId: m.larkAppId });
      continue;
    }
    if (collab!.profileId && !input.profileEntries.has(m.larkAppId)) {
      errors.push({ code: 'missing_profile_entry', larkAppId: m.larkAppId });
    }
    if (!input.onlineBots.has(m.larkAppId)) {
      warnings.push({ code: 'bot_offline', larkAppId: m.larkAppId });
    }
  }

  const ids = new Set(members.map(m => m.larkAppId));
  for (const m of members) {
    for (const dep of m.dependsOn ?? []) {
      if (!ids.has(dep)) errors.push({ code: 'unknown_dependency', larkAppId: m.larkAppId, dependsOn: dep });
    }
  }
  const cycle = findDependencyCycle(members);
  if (cycle) errors.push({ code: 'dependency_cycle', path: cycle });

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Order members so that every dependency is satisfied by an earlier entry.
 * `startPolicy: 'all'` returns the config order (dependencies are ignored at
 * runtime too, so a reordering would only confuse the progress card).
 */
export function orderCollabMembers(
  members: readonly CollabMemberConfig[],
  startPolicy: CollabGroupConfig['startPolicy'],
): CollabMemberConfig[] {
  if (startPolicy === 'all') return [...members];
  const byId = new Map(members.map(m => [m.larkAppId, m]));
  const out: CollabMemberConfig[] = [];
  const done = new Set<string>();
  // Iterate to a fixed point rather than recursing: a cycle cannot reach here
  // (the normalizer rejects it), and a fixed point keeps a partially-valid
  // config from producing an infinite loop if one ever slipped through.
  let progressed = true;
  while (progressed && out.length < members.length) {
    progressed = false;
    for (const m of members) {
      if (done.has(m.larkAppId)) continue;
      if ((m.dependsOn ?? []).every(dep => done.has(dep) && byId.has(dep))) {
        out.push(m);
        done.add(m.larkAppId);
        progressed = true;
      }
    }
  }
  // Anything left is unreachable; append in config order so the caller still
  // sees every member (and its own failure row) instead of a silent drop.
  for (const m of members) if (!done.has(m.larkAppId)) out.push(m);
  return out;
}

/** Render a member's first-round prompt. Unknown placeholders stay literal. */
export function renderCollabPrompt(
  template: string,
  vars: { task: string; upstream: string; stage?: string },
): string {
  return template
    .replace(/\{task\}/g, vars.task)
    .replace(/\{upstream\}/g, vars.upstream)
    .replace(/\{stage\}/g, vars.stage ?? '');
}
