/**
 * Collaboration bootstrap orchestrator: the behaviour the issue asks for.
 *
 * Each case is one row of the issue's acceptance table, driven through the REAL
 * orchestrator with injected peers — including peers that lie, stall and answer
 * late, because "the message was sent" looking like success is the exact defect
 * this feature exists to remove.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  applyCollabTurnTerminal,
  collabMemberStatusLine,
  markCollabStageRunning,
  runCollabBootstrap,
  type CollabBootstrapDeps,
} from '../src/services/collab-bootstrap.js';
import type { CollabGroupConfig } from '../src/bot-registry.js';
import type { CollabBootstrapJournal } from '../src/services/collab-bootstrap-store.js';
import {
  COLLAB_ROLE_PROTOCOL,
  collabConfigFingerprint,
  hashRoleContent,
  type CollabRoleApplyReceipt,
} from '../src/core/collab-role-protocol.js';

const OWNER = 'cli_owner00001';
const BUILDER = 'cli_builder0001';
const REVIEWER = 'cli_reviewer001';
const CHAT = 'oc_collab_chat_0001';
const REQ = 'a1b2c3d4e5f60718';
const BUILDER_ROLE = '你是 Builder，负责实现。';
const REVIEWER_ROLE = '你是 Reviewer，负责复核。';
const HASHES: Record<string, string> = {
  [BUILDER]: hashRoleContent(BUILDER_ROLE)!,
  [REVIEWER]: hashRoleContent(REVIEWER_ROLE)!,
};

function config(overrides: Partial<CollabGroupConfig> = {}): CollabGroupConfig {
  return {
    enabled: true,
    profileId: 'dev-pair',
    members: [
      { larkAppId: BUILDER, stage: 'builder', prompt: '实现 {task}' },
      { larkAppId: REVIEWER, stage: 'reviewer', prompt: '复核 {upstream}', dependsOn: [BUILDER] },
    ],
    ...overrides,
  };
}

function journalFor(cfg: CollabGroupConfig, overrides: Partial<CollabBootstrapJournal> = {}): CollabBootstrapJournal {
  const members: CollabBootstrapJournal['members'] = {};
  for (const m of cfg.members ?? []) {
    members[m.larkAppId] = {
      larkAppId: m.larkAppId,
      join: { state: 'pending' },
      role: { state: 'pending' },
      start: { state: 'pending' },
    };
  }
  return {
    version: 1,
    requestId: REQ,
    ownerLarkAppId: OWNER,
    config: cfg,
    configFingerprint: collabConfigFingerprint({
      profileId: cfg.profileId ?? '',
      startPolicy: cfg.startPolicy ?? 'staged',
      members: cfg.members ?? [],
    }),
    sourceChatId: 'oc_dm_source',
    sourceMessageId: 'om_source',
    ownerOpenId: 'ou_owner',
    createdAt: 0,
    updatedAt: 0,
    status: 'pending',
    members,
    taskText: '把这条任务做完',
    attempts: 0,
    ...overrides,
  };
}

interface Harness {
  deps: CollabBootstrapDeps;
  journal: CollabBootstrapJournal;
  kicks: Array<{ peer: string; prompt: string }>;
  cards: CollabBootstrapJournal[];
  receipts: number;
  /** Late-answer control: when set, the next role apply resolves with this. */
  roleOverride?: (peer: string) => CollabRoleApplyReceipt | null;
  readbackHash?: (peer: string) => string | null;
  createCalls: number;
  clock: { now: number };
}

function harness(opts: {
  cfg?: CollabGroupConfig;
  journal?: Partial<CollabBootstrapJournal>;
  roster?: string[];
  entryHash?: (peer: string) => string | null;
  roleApply?: (peer: string) => CollabRoleApplyReceipt | null;
  readback?: (peer: string) => string | null;
  createThrowsAfterChat?: boolean;
  ownerInviteRejected?: boolean;
} = {}): Harness {
  const cfg = opts.cfg ?? config();
  let journal = opts.journal ? { ...journalFor(cfg), ...opts.journal } : journalFor(cfg);
  const h: Harness = {
    deps: undefined as unknown as CollabBootstrapDeps,
    journal,
    kicks: [],
    cards: [],
    receipts: 0,
    createCalls: 0,
    clock: { now: 1_000 },
  };
  const roster = new Set(opts.roster ?? [BUILDER, REVIEWER]);

  h.deps = {
    async createGroup(input) {
      h.createCalls += 1;
      input.onChatCreated(CHAT);
      if (opts.createThrowsAfterChat) throw new Error('invite step blew up');
      return {
        chatId: CHAT,
        invalidBotIds: [],
        invalidUserIds: opts.ownerInviteRejected ? ['ou_owner'] : [],
      };
    },
    async disbandGroup() { /* recorded via createCalls/disband count only */ },
    async listChatBots() {
      return [...roster].map(id => ({ larkAppId: id, openId: `ou_${id}`, mentionable: true }));
    },
    readProfileEntryHash(_profileId, peer) {
      return (opts.entryHash ?? (id => HASHES[id] ?? null))(peer);
    },
    async requestRoleApply({ peerLarkAppId, request }) {
      if (opts.roleApply) return opts.roleApply(peerLarkAppId);
      return {
        ok: true,
        protocol: COLLAB_ROLE_PROTOCOL,
        requestId: request.requestId,
        configFingerprint: request.configFingerprint,
        chatId: request.chatId,
        appliedHash: request.expectedHash,
        appliedAt: 1,
        changed: true,
        overwrote: false,
      };
    },
    async readbackRole({ peerLarkAppId, chatId }) {
      return {
        ok: true,
        protocol: COLLAB_ROLE_PROTOCOL,
        chatId,
        chatRoleHash: (opts.readback ?? (id => HASHES[id] ?? null))(peerLarkAppId),
        entryHash: HASHES[peerLarkAppId] ?? null,
      };
    },
    async kickoff({ peerLarkAppId, prompt }) {
      h.kicks.push({ peer: peerLarkAppId, prompt });
      return `om_kick_${peerLarkAppId}`;
    },
    async updateProgressCard({ cardMessageId, journal: j }) {
      h.cards.push(JSON.parse(JSON.stringify(j)));
      return cardMessageId ?? 'om_card';
    },
    async updateDmReceipt() {
      h.receipts += 1;
      return 'om_receipt';
    },
    mutateJournal(_requestId, mutate) {
      // The orchestrator always re-reads through this hook; the harness models
      // the store as a single in-memory journal plus a "declined" signal.
      const draft = JSON.parse(JSON.stringify(h.journal)) as CollabBootstrapJournal;
      if (mutate(draft) === false) return null;
      h.journal = draft;
      return draft;
    },
    log() { /* silent */ },
    now: () => h.clock.now,
  };
  return h;
}

describe('runCollabBootstrap — happy path', () => {
  it('creates one group, confirms both roles, and starts only the builder', async () => {
    const h = harness();
    const outcome = await runCollabBootstrap(h.deps, {
      journal: h.journal,
      name: '修 bug',
      ownerOpenId: 'ou_owner',
    });

    expect(outcome.status).toBe('ready');
    expect(h.createCalls).toBe(1);
    expect(h.journal.chatId).toBe(CHAT);
    expect(h.journal.members[BUILDER].role.state).toBe('confirmed');
    expect(h.journal.members[REVIEWER].role.state).toBe('confirmed');
    // Staged: the reviewer waits for the builder's turn to COMPLETE.
    expect(h.kicks.map(k => k.peer)).toEqual([BUILDER]);
    expect(h.kicks[0].prompt).toBe('实现 把这条任务做完');
    // The reviewer must NOT have been started just because its role is ready.
    expect(h.journal.members[REVIEWER].start.state).toBe('pending');
  });

  it('starts every member at once under startPolicy=all', async () => {
    const h = harness({ cfg: config({ startPolicy: 'all' }) });
    const outcome = await runCollabBootstrap(h.deps, { journal: h.journal, name: 'x', ownerOpenId: 'ou_owner' });
    expect(outcome.status).toBe('ready');
    expect(h.kicks.map(k => k.peer).sort()).toEqual([BUILDER, REVIEWER].sort());
  });

  it('treats an empty prompt as "join and apply role, but do not start"', async () => {
    const h = harness({
      cfg: config({ members: [{ larkAppId: BUILDER, stage: 'builder' }] }),
    });
    const outcome = await runCollabBootstrap(h.deps, { journal: h.journal, name: 'x', ownerOpenId: 'ou_owner' });
    expect(outcome.status).toBe('ready');
    expect(h.kicks).toEqual([]);
    expect(h.journal.members[BUILDER].start.state).toBe('completed');
  });
});

describe('runCollabBootstrap — role readiness is proven, not assumed', () => {
  it('fails the whole request when a peer has no profile entry, and starts nothing', async () => {
    // This is the issue's "消息已发送不等于角色已就绪" case.
    const h = harness({ entryHash: id => (id === BUILDER ? HASHES[BUILDER] : null) });
    const outcome = await runCollabBootstrap(h.deps, { journal: h.journal, name: 'x', ownerOpenId: 'ou_owner' });
    expect(outcome.status).toBe('failed');
    expect(outcome.failureReason).toContain('profile 里没有这个 Bot 的角色条目');
    expect(h.kicks).toEqual([]);
    expect(h.journal.members[BUILDER].start.state).toBe('pending');
  });

  it('fails when the peer refuses (chat role conflict) instead of overwriting', async () => {
    const h = harness({
      roleApply: peer => (peer === REVIEWER
        ? { ok: false, reason: 'chat_role_conflict', actualHash: hashRoleContent('人工角色')! }
        : {
            ok: true,
            protocol: COLLAB_ROLE_PROTOCOL,
            requestId: REQ,
            configFingerprint: collabConfigFingerprint({
              profileId: 'dev-pair', startPolicy: 'staged', members: config().members!,
            }),
            chatId: CHAT,
            appliedHash: HASHES[peer],
            appliedAt: 1,
            changed: true,
            overwrote: false,
          }),
    });
    const outcome = await runCollabBootstrap(h.deps, { journal: h.journal, name: 'x', ownerOpenId: 'ou_owner' });
    expect(outcome.status).toBe('failed');
    expect(outcome.failureReason).toContain('本群已有不同的角色，未覆盖');
    expect(h.kicks).toEqual([]);
  });

  it('fails when the receipt is for another request (a late answer from a cancelled attempt)', async () => {
    const h = harness({
      roleApply: peer => ({
        ok: true,
        protocol: COLLAB_ROLE_PROTOCOL,
        requestId: 'ffffffffffffffff',
        configFingerprint: h.journal.configFingerprint,
        chatId: CHAT,
        appliedHash: HASHES[peer],
        appliedAt: 1,
        changed: true,
        overwrote: false,
      }),
    });
    const outcome = await runCollabBootstrap(h.deps, { journal: h.journal, name: 'x', ownerOpenId: 'ou_owner' });
    expect(outcome.status).toBe('failed');
    expect(outcome.failureReason).toContain('回执属于另一次初始化请求');
    expect(h.kicks).toEqual([]);
  });

  it('never forces, even when a previous pass left the role at "requested"', async () => {
    // `requested` proves we were ABOUT to write, not that we succeeded — so it
    // must not grant overwrite rights. A genuine resume does not need force:
    // the peer answers `noop` when the content already matches, and refuses
    // when a human changed it. Forcing here would clobber that human's role.
    const h = harness({
      journal: {
        chatId: CHAT,
        status: 'running',
        members: {
          [BUILDER]: {
            larkAppId: BUILDER,
            join: { state: 'joined' },
            role: { state: 'requested', at: 5 },
            start: { state: 'pending' },
          },
          [REVIEWER]: {
            larkAppId: REVIEWER,
            join: { state: 'pending' },
            role: { state: 'pending' },
            start: { state: 'pending' },
          },
        },
      },
      // The peer reports the conflict a forced re-apply would have bypassed.
      roleApply: peer => (peer === BUILDER
        ? { ok: false, reason: 'chat_role_conflict', actualHash: HASHES[BUILDER] }
        : null),
    });
    const forces: boolean[] = [];
    const orig = h.deps.requestRoleApply;
    h.deps.requestRoleApply = async input => {
      forces.push(input.request.force);
      return orig(input);
    };
    const outcome = await runCollabBootstrap(h.deps, { journal: h.journal, name: 'x', ownerOpenId: 'ou_owner' });
    expect(forces[0]).toBe(false);
    expect(outcome.status).toBe('failed');
    expect(outcome.failureReason).toContain('本群已有不同的角色');
  });

  it('does not force when the role was never requested by this request', async () => {
    // A pre-existing chat role this request never wrote is a genuine conflict.
    const forces: boolean[] = [];
    const h = harness();
    const orig = h.deps.requestRoleApply;
    h.deps.requestRoleApply = async input => { forces.push(input.request.force); return orig(input); };
    await runCollabBootstrap(h.deps, { journal: h.journal, name: 'x', ownerOpenId: 'ou_owner' });
    expect(forces.every(f => f === false)).toBe(true);
  });

  it('fails when the peer is unreachable (null receipt)', async () => {
    const h = harness({ roleApply: () => null });
    const outcome = await runCollabBootstrap(h.deps, { journal: h.journal, name: 'x', ownerOpenId: 'ou_owner' });
    expect(outcome.status).toBe('failed');
    expect(outcome.failureReason).toContain('没有收到角色应用回执');
  });

  it('fails when the role changed between the peer write and the readback', async () => {
    const h = harness({ readback: () => hashRoleContent('被人改了')! });
    const outcome = await runCollabBootstrap(h.deps, { journal: h.journal, name: 'x', ownerOpenId: 'ou_owner' });
    expect(outcome.status).toBe('failed');
    expect(outcome.failureReason).toContain('角色应用后又被改写');
    expect(h.kicks).toEqual([]);
  });

  it('fails a member that never joined, and does not try to apply its role', async () => {
    const h = harness({ roster: [BUILDER] });
    const outcome = await runCollabBootstrap(h.deps, { journal: h.journal, name: 'x', ownerOpenId: 'ou_owner' });
    expect(outcome.status).toBe('failed');
    expect(outcome.failureReason).toContain('Bot 未成功入群');
    expect(h.journal.members[REVIEWER].role.state).toBe('pending');
  });
});

describe('runCollabBootstrap — durability and recovery', () => {
  it('never creates a second group once chatId is persisted', async () => {
    const h = harness({ journal: { chatId: CHAT } });
    await runCollabBootstrap(h.deps, { journal: h.journal, name: 'x', ownerOpenId: 'ou_owner' });
    expect(h.createCalls).toBe(0);
    expect(h.journal.chatId).toBe(CHAT);
  });

  it('resumes from the chat the create call managed to make before throwing', async () => {
    // The classic window: chat.create succeeded, a later invite step threw.
    // Rebuilding would leave an orphan group and a duplicated task.
    const h = harness({ createThrowsAfterChat: true });
    const outcome = await runCollabBootstrap(h.deps, { journal: h.journal, name: 'x', ownerOpenId: 'ou_owner' });
    expect(h.createCalls).toBe(1);
    expect(outcome.chatId).toBe(CHAT);
    expect(h.journal.chatId).toBe(CHAT);
    // …and the resumed pass completed the work in that same chat.
    expect(outcome.status).toBe('ready');
    expect(h.journal.members[BUILDER].role.state).toBe('confirmed');
  });

  it('disbands the group when the initiating user could not be invited', async () => {
    let disbanded: string | undefined;
    const h = harness({ ownerInviteRejected: true });
    const orig = h.deps.disbandGroup;
    h.deps.disbandGroup = async (chatId) => { disbanded = chatId; await orig(chatId); };
    const outcome = await runCollabBootstrap(h.deps, { journal: h.journal, name: 'x', ownerOpenId: 'ou_owner' });
    expect(outcome.status).toBe('failed');
    expect(disbanded).toBe(CHAT);
    expect(h.kicks).toEqual([]);
  });

  it('skips steps already marked done on re-entry', async () => {
    const h = harness({
      journal: {
        chatId: CHAT,
        status: 'running',
        members: {
          [BUILDER]: {
            larkAppId: BUILDER,
            join: { state: 'joined', at: 1 },
            role: { state: 'confirmed', at: 2, confirmedAt: 2, appliedHash: HASHES[BUILDER] },
            start: { state: 'pending' },
          },
          [REVIEWER]: {
            larkAppId: REVIEWER,
            join: { state: 'pending' },
            role: { state: 'pending' },
            start: { state: 'pending' },
          },
        },
      },
    });
    let applied = 0;
    const origApply = h.deps.requestRoleApply;
    h.deps.requestRoleApply = async (input) => { applied += 1; return origApply(input); };
    await runCollabBootstrap(h.deps, { journal: h.journal, name: 'x', ownerOpenId: 'ou_owner' });
    // Only the reviewer still needed a role apply.
    expect(applied).toBe(1);
  });

  it('stops when the request is cancelled before it may start work', async () => {
    // Model a cancel landing after the group exists but before any stage is
    // kicked off: the pass must stop and start nothing.
    const h = harness({ journal: { chatId: CHAT } });
    const original = h.deps.mutateJournal;
    h.deps.mutateJournal = (requestId, mutate) => {
      const result = original(requestId, mutate);
      // Once the group exists, cancel it behind the orchestrator's back.
      if (h.journal.status === 'running' && h.kicks.length === 0) {
        original(requestId, j => { j.status = 'cancelled'; });
      }
      return result;
    };
    const outcome = await runCollabBootstrap(h.deps, { journal: h.journal, name: 'x', ownerOpenId: 'ou_owner' });
    expect(outcome.status).toBe('cancelled');
    expect(h.kicks).toEqual([]);
  });

  it('stays resumable while a dependent stage is still waiting', async () => {
    // Regression for the blocking bug: marking the whole request `ready` as soon
    // as the first wave was kicked off closed the live-journal gate and the
    // turn-report lookup, stranding every dependent stage forever.
    const h = harness();
    const outcome = await runCollabBootstrap(h.deps, { journal: h.journal, name: 'x', ownerOpenId: 'ou_owner' });
    expect(outcome.status).toBe('ready');       // the GROUP is usable
    expect(h.journal.status).toBe('running');   // the REQUEST is not finished
    expect(h.journal.members[BUILDER].start.state).toBe('sent');
    expect(h.journal.members[REVIEWER].start.state).toBe('pending');
  });

  it('becomes terminal only once every stage has settled', async () => {
    const h = harness();
    await runCollabBootstrap(h.deps, { journal: h.journal, name: 'x', ownerOpenId: 'ou_owner' });
    markCollabStageRunning(h.journal, { larkAppId: BUILDER, turnId: 'turn-1' });
    applyCollabTurnTerminal(h.journal, { larkAppId: BUILDER, turnId: 'turn-1', status: 'completed' });
    await runCollabBootstrap(h.deps, { journal: h.journal, name: 'x', ownerOpenId: 'ou_owner' });
    // Reviewer was kicked off but has not finished: still running.
    expect(h.journal.status).toBe('running');
    markCollabStageRunning(h.journal, { larkAppId: REVIEWER, turnId: 'turn-2' });
    applyCollabTurnTerminal(h.journal, { larkAppId: REVIEWER, turnId: 'turn-2', status: 'completed' });
    await runCollabBootstrap(h.deps, { journal: h.journal, name: 'x', ownerOpenId: 'ou_owner' });
    expect(h.journal.status).toBe('ready');
  });

  it('fails a member that exceeded the readiness budget', async () => {
    // A peer that stalls past the budget must fail THAT member — and therefore
    // the request — rather than leaving the group "initializing" forever.
    const h = harness({ cfg: config({ onInitTimeoutMs: 10_000 }) });
    const realRead = h.deps.readProfileEntryHash.bind(h.deps);
    let first = true;
    h.deps.readProfileEntryHash = (profileId, peer) => {
      if (first) { first = false; h.clock.now += 20_000; }
      return realRead(profileId, peer);
    };
    const outcome = await runCollabBootstrap(h.deps, { journal: h.journal, name: 'x', ownerOpenId: 'ou_owner' });
    expect(outcome.status).toBe('failed');
    expect(outcome.failureReason).toContain('初始化超时');
    expect(h.kicks).toEqual([]);
  });
});

describe('applyCollabTurnTerminal', () => {
  function startedJournal(): CollabBootstrapJournal {
    const j = journalFor(config());
    j.chatId = CHAT;
    j.status = 'running';
    j.members[BUILDER].join = { state: 'joined' };
    j.members[BUILDER].role = { state: 'confirmed' };
    j.members[BUILDER].start = { state: 'sent', turnId: 'turn-1' };
    return j;
  }
  /** 'sent' → 'running' is the CLI actually taking the turn. */
  function runningJournal(): CollabBootstrapJournal {
    const j = startedJournal();
    expect(markCollabStageRunning(j, { larkAppId: BUILDER, turnId: 'turn-1' })).toEqual({ changed: true });
    return j;
  }

  it('completes the stage on a matching completed terminal', () => {
    const j = runningJournal();
    expect(applyCollabTurnTerminal(j, { larkAppId: BUILDER, turnId: 'turn-1', status: 'completed' }))
      .toEqual({ changed: true, state: 'completed' });
    expect(j.members[BUILDER].start.state).toBe('completed');
  });

  it('buffers (not settles) a terminal for a `sent` stage — see the reordering cases', () => {
    // A `sent` stage has no turnId yet, so there is nothing to verify the
    // terminal against. It is HELD, then settled when the started report
    // supplies the id. Settling immediately would accept an identity we never
    // checked; dropping it would lose the completion proof.
    const j = startedJournal();
    expect(applyCollabTurnTerminal(j, { larkAppId: BUILDER, turnId: 'turn-1', status: 'completed' }))
      .toEqual({ changed: true });
    expect(j.members[BUILDER].start.state).toBe('sent');
    expect(j.members[BUILDER].start.pendingTerminal).toMatchObject({ turnId: 'turn-1' });
  });

  it('keeps the first buffered terminal when a second turn reports too', () => {
    const j = startedJournal();
    applyCollabTurnTerminal(j, { larkAppId: BUILDER, turnId: 'turn-1', status: 'completed' });
    expect(applyCollabTurnTerminal(j, { larkAppId: BUILDER, turnId: 'turn-9', status: 'completed' }))
      .toEqual({ changed: false });
    expect(j.members[BUILDER].start.pendingTerminal).toMatchObject({ turnId: 'turn-1' });
  });

  it('ignores a terminal from a different turn', () => {
    const j = runningJournal();
    expect(applyCollabTurnTerminal(j, { larkAppId: BUILDER, turnId: 'turn-9', status: 'completed' }))
      .toEqual({ changed: false });
  });

  it('fails closed when the REPORT has no turnId', () => {
    // Without an id there is no evidence this terminal belongs to this stage.
    // Accepting it would let any completed turn from the same bot release a
    // downstream stage its own kickoff never triggered.
    const j = runningJournal();
    expect(applyCollabTurnTerminal(j, { larkAppId: BUILDER, status: 'completed' }))
      .toEqual({ changed: false });
    expect(j.members[BUILDER].start.state).toBe('running');
  });

  it('fails closed when the STAGE never learned its turnId', () => {
    const j = startedJournal();
    // A stage that was kicked off but whose admission never reported a turnId
    // has NO correlation id at all (the reducer refuses to invent one).
    j.members[BUILDER].start = { state: 'running', at: 1 };
    expect(j.members[BUILDER].start.turnId).toBeUndefined();
    expect(applyCollabTurnTerminal(j, { larkAppId: BUILDER, turnId: 'turn-1', status: 'completed' }))
      .toEqual({ changed: false });
    expect(j.members[BUILDER].start.state).toBe('running');
  });

  it('ignores a member that was never started', () => {
    const j = runningJournal();
    expect(applyCollabTurnTerminal(j, { larkAppId: REVIEWER, status: 'completed' }))
      .toEqual({ changed: false });
  });

  it('records a failed stage as failed, so a dependent is not started by it', () => {
    const j = runningJournal();
    expect(applyCollabTurnTerminal(j, { larkAppId: BUILDER, turnId: 'turn-1', status: 'failed' }))
      .toEqual({ changed: true, state: 'failed' });
  });

  it('does not re-mark a stage that was never kicked off', () => {
    const j = startedJournal();
    expect(markCollabStageRunning(j, { larkAppId: REVIEWER, turnId: 'turn-2' })).toEqual({ changed: false });
  });
});

describe('runCollabBootstrap — a completed upstream releases its dependent', () => {
  it('starts the reviewer only after the builder terminal is recorded', async () => {
    const h = harness({ journal: { chatId: CHAT, status: 'running' } });
    await runCollabBootstrap(h.deps, { journal: h.journal, name: 'x', ownerOpenId: 'ou_owner' });
    expect(h.kicks.map(k => k.peer)).toEqual([BUILDER]);

    // The CLI took the builder's turn, then that turn finished. Both facts
    // arrive on the owner's side and are recorded before the next stage may run.
    markCollabStageRunning(h.journal, { larkAppId: BUILDER, turnId: 'turn-1' });
    const outcome = applyCollabTurnTerminal(h.journal, {
      larkAppId: BUILDER, turnId: 'turn-1', status: 'completed',
    });
    expect(outcome.state).toBe('completed');

    await runCollabBootstrap(h.deps, { journal: h.journal, name: 'x', ownerOpenId: 'ou_owner' });
    expect(h.kicks.map(k => k.peer)).toEqual([BUILDER, REVIEWER]);
    expect(h.kicks[1].prompt).toContain('builder 已完成');
  });

  it('does not start the reviewer when the builder failed', async () => {
    const h = harness({ journal: { chatId: CHAT, status: 'running' } });
    await runCollabBootstrap(h.deps, { journal: h.journal, name: 'x', ownerOpenId: 'ou_owner' });
    markCollabStageRunning(h.journal, { larkAppId: BUILDER, turnId: 'turn-1' });
    applyCollabTurnTerminal(h.journal, { larkAppId: BUILDER, turnId: 'turn-1', status: 'failed' });
    await runCollabBootstrap(h.deps, { journal: h.journal, name: 'x', ownerOpenId: 'ou_owner' });
    expect(h.kicks.map(k => k.peer)).toEqual([BUILDER]);
    // The dependent must not be left silently "pending" — that reads as
    // "still initializing" forever.
    expect(h.journal.members[REVIEWER].start.state).toBe('failed');
    expect(h.journal.members[REVIEWER].start.error).toBe('upstream_failed');
  });
});

describe('collabMemberStatusLine', () => {
  it('names the actual blocking reason instead of a generic "initializing"', () => {
    const cfg = config();
    const j = journalFor(cfg);
    j.members[BUILDER].join = { state: 'failed', error: 'not_joined' };
    expect(collabMemberStatusLine(cfg.members![0], j.members[BUILDER])).toContain('Bot 未成功入群');

    j.members[BUILDER].join = { state: 'joined' };
    j.members[BUILDER].role = { state: 'failed', error: 'chat_role_conflict' };
    expect(collabMemberStatusLine(cfg.members![0], j.members[BUILDER])).toContain('本群已有不同的角色');

    j.members[BUILDER].role = { state: 'confirmed' };
    j.members[BUILDER].start = { state: 'sent' };
    expect(collabMemberStatusLine(cfg.members![0], j.members[BUILDER])).toContain('进行中');
  });
});

describe('collabRolesReady / allStagesSettled', () => {
  it('separates "the group may accept messages" from "the request is finished"', async () => {
    const { collabRolesReady, allStagesSettled } = await import('../src/services/collab-bootstrap.js');
    const h = harness();
    await runCollabBootstrap(h.deps, { journal: h.journal, name: 'x', ownerOpenId: 'ou_owner' });
    // Every role confirmed → the group is usable for normal messages…
    expect(collabRolesReady(h.journal)).toBe(true);
    // …but a stage is still in flight, so the request is NOT settled.
    expect(allStagesSettled(h.journal)).toBe(false);

    markCollabStageRunning(h.journal, { larkAppId: BUILDER, turnId: 't1' });
    applyCollabTurnTerminal(h.journal, { larkAppId: BUILDER, turnId: 't1', status: 'completed' });
    await runCollabBootstrap(h.deps, { journal: h.journal, name: 'x', ownerOpenId: 'ou_owner' });
    expect(collabRolesReady(h.journal)).toBe(true);
    expect(allStagesSettled(h.journal)).toBe(false);

    markCollabStageRunning(h.journal, { larkAppId: REVIEWER, turnId: 't2' });
    applyCollabTurnTerminal(h.journal, { larkAppId: REVIEWER, turnId: 't2', status: 'completed' });
    expect(allStagesSettled(h.journal)).toBe(true);
  });

  it('is not role-ready while a member is still unconfirmed', async () => {
    const { collabRolesReady } = await import('../src/services/collab-bootstrap.js');
    const j = journalFor(config());
    expect(j.members[REVIEWER].role.state).toBe('pending');
    expect(collabRolesReady(j)).toBe(false);
  });
});

describe('crash recovery and concurrency', () => {
  it('retries a kickoff whose send claim expired instead of skipping it forever', async () => {
    // Regression: the old code persisted `sent` BEFORE the send, so a crash in
    // that window left a stage every later pass skipped — permanently silent,
    // with no kickoff ever delivered.
    const h = harness({
      journal: {
        chatId: CHAT,
        status: 'running',
        members: {
          [BUILDER]: {
            larkAppId: BUILDER,
            join: { state: 'joined' },
            role: { state: 'confirmed' },
            // `pending` + an EXPIRED claim = "a send was attempted and never
            // confirmed". It must be retried, not skipped.
            start: { state: 'pending', claim: { at: 0, ttlMs: 1 } },
          },
          [REVIEWER]: {
            larkAppId: REVIEWER,
            join: { state: 'joined' },
            role: { state: 'confirmed' },
            start: { state: 'pending' },
          },
        },
      },
    });
    h.clock.now = 10_000;
    await runCollabBootstrap(h.deps, { journal: h.journal, name: 'x', ownerOpenId: 'ou_owner' });
    expect(h.kicks.map(k => k.peer)).toEqual([BUILDER]);
    expect(h.journal.members[BUILDER].start.state).toBe('sent');
  });

  it('does not duplicate a send while another pass holds an unexpired claim', async () => {
    const h = harness({
      journal: {
        chatId: CHAT,
        status: 'running',
        members: {
          [BUILDER]: {
            larkAppId: BUILDER,
            join: { state: 'joined' },
            role: { state: 'confirmed' },
            start: { state: 'pending', claim: { at: 1_000, ttlMs: 60_000 } },
          },
          [REVIEWER]: {
            larkAppId: REVIEWER,
            join: { state: 'joined' },
            role: { state: 'confirmed' },
            start: { state: 'pending' },
          },
        },
      },
    });
    h.clock.now = 2_000;
    await runCollabBootstrap(h.deps, { journal: h.journal, name: 'x', ownerOpenId: 'ou_owner' });
    expect(h.kicks).toEqual([]);
  });

  it('creates the group only once when two passes race', async () => {
    // Two passes both see "no chatId". Without a creation claim each creates a
    // group and the second becomes an orphan nobody can find.
    const h = harness();
    const original = h.deps.mutateJournal;
    let firstCreateDone = false;
    h.deps.createGroup = async (input) => {
      if (firstCreateDone) throw new Error('second create must not happen');
      firstCreateDone = true;
      input.onChatCreated(CHAT);
      return { chatId: CHAT, invalidBotIds: [], invalidUserIds: [] };
    };
    const originalMutate = original;
    h.deps.mutateJournal = (requestId, mutate) => {
      const r = originalMutate(requestId, mutate);
      return r;
    };
    // Simulate the race: a second pass starts from the SAME pre-claim snapshot.
    const stale = JSON.parse(JSON.stringify(h.journal)) as CollabBootstrapJournal;
    await runCollabBootstrap(h.deps, { journal: h.journal, name: 'x', ownerOpenId: 'ou_owner' });
    const second = await runCollabBootstrap(h.deps, { journal: stale, name: 'x', ownerOpenId: 'ou_owner' });
    // The second pass either resumes the same chat or reports the claim is
    // held — it never creates a second group.
    expect(second.chatId === CHAT || second.failureReason === 'create_in_progress').toBe(true);
    expect(firstCreateDone).toBe(true);
  });

  it('reports a settled-but-failed request as failed, never ready', async () => {
    // A group whose reviewer never ran is not a working collaboration, and
    // `ready` is what the card, the DM receipt and the resume sweep all read.
    const h = harness({
      journal: {
        chatId: CHAT,
        status: 'running',
        members: {
          [BUILDER]: {
            larkAppId: BUILDER,
            join: { state: 'joined' },
            role: { state: 'confirmed' },
            start: { state: 'failed', error: 'failed' },
          },
          [REVIEWER]: {
            larkAppId: REVIEWER,
            join: { state: 'joined' },
            role: { state: 'confirmed' },
            start: { state: 'pending' },
          },
        },
      },
    });
    const outcome = await runCollabBootstrap(h.deps, { journal: h.journal, name: 'x', ownerOpenId: 'ou_owner' });
    expect(h.journal.members[REVIEWER].start.state).toBe('failed');
    expect(outcome.status).toBe('failed');
    expect(h.journal.status).toBe('failed');
  });
});

describe('unknown creation result, index loss, caller identity, config drift', () => {
  it('claims an existing group found by its name marker instead of creating a second one', async () => {
    // `chat.create` can succeed while its response is lost. Without the marker
    // the retry orphans that group and duplicates the task.
    const h = harness();
    h.deps.findGroupByMarker = async () => ({ state: 'found', chatId: CHAT });
    let created = 0;
    const origCreate = h.deps.createGroup;
    h.deps.createGroup = async (input) => { created += 1; return origCreate(input); };
    const outcome = await runCollabBootstrap(h.deps, { journal: h.journal, name: 'x', ownerOpenId: 'ou_owner' });
    expect(created).toBe(0);
    expect(outcome.chatId).toBe(CHAT);
    expect(h.journal.chatId).toBe(CHAT);
  });

  it('refuses to guess when several groups carry the marker', async () => {
    const h = harness();
    h.deps.findGroupByMarker = async () => ({ state: 'ambiguous', chatIds: ['oc_a', 'oc_b'] });
    let created = 0;
    const origCreate = h.deps.createGroup;
    h.deps.createGroup = async (input) => { created += 1; return origCreate(input); };
    const outcome = await runCollabBootstrap(h.deps, { journal: h.journal, name: 'x', ownerOpenId: 'ou_owner' });
    expect(created).toBe(0);
    expect(outcome.status).toBe('failed');
    expect(h.journal.status).toBe('failed');
  });

  it('creates when no group carries the marker', async () => {
    const h = harness();
    h.deps.findGroupByMarker = async () => ({ state: 'none' });
    const outcome = await runCollabBootstrap(h.deps, { journal: h.journal, name: 'x', ownerOpenId: 'ou_owner' });
    expect(h.createCalls).toBe(1);
    expect(outcome.chatId).toBe(CHAT);
  });

  it('stops before creating when the live config already drifted', async () => {
    const h = harness();
    let created = 0;
    const origCreate = h.deps.createGroup;
    h.deps.createGroup = async (input) => { created += 1; return origCreate(input); };
    const outcome = await runCollabBootstrap(h.deps, {
      journal: h.journal,
      name: 'x',
      ownerOpenId: 'ou_owner',
      liveConfigFingerprint: () => 'sha256:different',
    });
    expect(created).toBe(0);
    expect(outcome.status).toBe('failed');
    expect(outcome.failureReason).toBe('config_changed');
  });

  it('stops before a kickoff when the config drifts after roles were confirmed', async () => {
    // The journal's own fingerprint is unchanged, so only a LIVE recomputation
    // can notice that the operator replaced the profile mid-flight.
    const h = harness({ journal: { chatId: CHAT } });
    let drifted = false;
    const outcome = await runCollabBootstrap(h.deps, {
      journal: h.journal,
      name: 'x',
      ownerOpenId: 'ou_owner',
      liveConfigFingerprint: () => {
        const live = drifted ? 'sha256:new' : h.journal.configFingerprint;
        return live;
      },
    });
    // No drift during that pass: it completed normally.
    expect(outcome.status).toBe('ready');

    drifted = true;
    h.journal.status = 'running';
    h.journal.members[BUILDER].start = { state: 'pending' };
    h.journal.members[REVIEWER].start = { state: 'pending' };
    const second = await runCollabBootstrap(h.deps, {
      journal: h.journal,
      name: 'x',
      ownerOpenId: 'ou_owner',
      liveConfigFingerprint: () => 'sha256:new',
    });
    expect(second.status).toBe('failed');
    expect(second.failureReason).toBe('config_changed');
    expect(h.kicks).toHaveLength(1); // only the first pass's kickoff
  });
});

describe('long turns, grants and working-dir bindings', () => {
  it('fails the request when an explicit working dir did not bind for a peer', async () => {
    // That peer would run in its own default directory — the wrong repository,
    // silently. The legacy birth path already refuses this.
    const h = harness();
    h.deps.createGroup = async (input) => {
      input.onChatCreated(CHAT);
      return {
        chatId: CHAT,
        invalidBotIds: [],
        invalidUserIds: [],
        oncallBindings: [
          { larkAppId: OWNER, ok: true },
          { larkAppId: BUILDER, ok: false, error: 'bind denied' },
        ],
      };
    };
    const outcome = await runCollabBootstrap(h.deps, {
      journal: h.journal, name: 'x', ownerOpenId: 'ou_owner', workingDir: '/repo',
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.failureReason).toBe('working_dir_bind_failed');
    expect(h.kicks).toEqual([]);
  });

  it('fails the request when the bot talk-grant matrix did not complete', async () => {
    // A kickoff from this bot would be rejected by the peer's talk gate, so no
    // CLI turn ever starts and the collaboration silently produces nothing.
    const h = harness();
    h.deps.createGroup = async (input) => {
      input.onChatCreated(CHAT);
      return {
        chatId: CHAT,
        invalidBotIds: [],
        invalidUserIds: [],
        collaborationError: 'receiver unreachable',
      };
    };
    const outcome = await runCollabBootstrap(h.deps, { journal: h.journal, name: 'x', ownerOpenId: 'ou_owner' });
    expect(outcome.status).toBe('failed');
    expect(outcome.failureReason).toBe('collaboration_grants_failed');
    expect(h.kicks).toEqual([]);
  });
});

describe('started / terminal reordering', () => {
  function sentJournal(): CollabBootstrapJournal {
    const j = journalFor(config());
    j.chatId = CHAT;
    j.status = 'running';
    j.members[BUILDER].join = { state: 'joined' };
    j.members[BUILDER].role = { state: 'confirmed' };
    j.members[BUILDER].start = { state: 'sent', kickoffMessageId: 'om_kick' };
    return j;
  }

  it('buffers a terminal that arrives BEFORE the started report', () => {
    // A short turn can finish before its own "started" report lands. At that
    // moment the stage is `sent` with no turnId, so the fail-closed identity
    // check has nothing to match — dropping the terminal would lose the only
    // proof the stage ever finished.
    const j = sentJournal();
    expect(applyCollabTurnTerminal(j, { larkAppId: BUILDER, turnId: 'turn-1', status: 'completed' }))
      .toEqual({ changed: true });
    expect(j.members[BUILDER].start.pendingTerminal).toMatchObject({ turnId: 'turn-1', status: 'completed' });
    expect(j.members[BUILDER].start.state).toBe('sent');
  });

  it('settles from the buffer when the started report finally arrives', () => {
    const j = sentJournal();
    applyCollabTurnTerminal(j, { larkAppId: BUILDER, turnId: 'turn-1', status: 'completed' });
    expect(markCollabStageRunning(j, { larkAppId: BUILDER, turnId: 'turn-1' })).toEqual({ changed: true });
    expect(j.members[BUILDER].start.state).toBe('completed');
    expect(j.members[BUILDER].start.pendingTerminal).toBeUndefined();
  });

  it('does not settle from a buffered terminal belonging to another turn', () => {
    const j = sentJournal();
    applyCollabTurnTerminal(j, { larkAppId: BUILDER, turnId: 'turn-9', status: 'completed' });
    markCollabStageRunning(j, { larkAppId: BUILDER, turnId: 'turn-1' });
    // Still running: the real terminal for turn-1 has not been seen.
    expect(j.members[BUILDER].start.state).toBe('running');
  });

  it('settles the normal in-order delivery too', () => {
    const j = sentJournal();
    markCollabStageRunning(j, { larkAppId: BUILDER, turnId: 'turn-1' });
    expect(applyCollabTurnTerminal(j, { larkAppId: BUILDER, turnId: 'turn-1', status: 'completed' }))
      .toEqual({ changed: true, state: 'completed' });
  });

  it('records a buffered FAILED terminal as failed, not completed', () => {
    const j = sentJournal();
    applyCollabTurnTerminal(j, { larkAppId: BUILDER, turnId: 'turn-1', status: 'failed' });
    markCollabStageRunning(j, { larkAppId: BUILDER, turnId: 'turn-1' });
    expect(j.members[BUILDER].start.state).toBe('failed');
  });

  it('ignores a terminal with no turnId at all while still `sent`', () => {
    const j = sentJournal();
    expect(applyCollabTurnTerminal(j, { larkAppId: BUILDER, status: 'completed' }))
      .toEqual({ changed: false });
    expect(j.members[BUILDER].start.pendingTerminal).toBeUndefined();
  });
});
