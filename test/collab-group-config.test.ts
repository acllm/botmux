/**
 * Collaboration-group config: parse, validate, preflight, ordering.
 *
 * These are the rules the dashboard save path and the birth path BOTH rely on,
 * so a regression here means either "the page accepted a config the daemon
 * silently ignores" or "a hand-edited bots.json took a bot's daemon down".
 */
import { describe, it, expect } from 'vitest';
import {
  CollabConfigError,
  collabConfigActive,
  findDependencyCycle,
  MAX_COLLAB_MEMBERS,
  normalizeCollabConfig,
  orderCollabMembers,
  preflightCollabConfig,
  renderCollabPrompt,
} from '../src/services/collab-group-config.js';

const SELF = 'cli_selfbot0001';
const A = 'cli_builder0001';
const B = 'cli_reviewer001';

describe('normalizeCollabConfig', () => {
  it('returns undefined for an absent block so bots.json stays clean', () => {
    expect(normalizeCollabConfig(undefined)).toBeUndefined();
    expect(normalizeCollabConfig(null)).toBeUndefined();
  });

  it('keeps an explicit opt-out distinct from "never configured"', () => {
    // An explicit `enabled: false` is a persisted decision; dropping it would
    // make the dashboard unable to show "you turned this off".
    expect(normalizeCollabConfig({ enabled: false })).toEqual({});
  });

  it('accepts a staged builder/reviewer pair', () => {
    const out = normalizeCollabConfig({
      enabled: true,
      profileId: 'dev-pair',
      members: [
        { larkAppId: A, stage: 'builder', prompt: '实现 {task}' },
        { larkAppId: B, stage: 'reviewer', prompt: '复核 {upstream}', dependsOn: [A] },
      ],
    }, { selfLarkAppId: SELF });
    expect(out).toEqual({
      enabled: true,
      profileId: 'dev-pair',
      members: [
        { larkAppId: A, stage: 'builder', prompt: '实现 {task}' },
        { larkAppId: B, stage: 'reviewer', prompt: '复核 {upstream}', dependsOn: [A] },
      ],
    });
  });

  it('drops blank optional strings instead of persisting empty tombstones', () => {
    const out = normalizeCollabConfig({
      enabled: true,
      profileId: '   ',
      members: [{ larkAppId: A, stage: '  ', prompt: '   ' }],
    });
    expect(out).toEqual({ enabled: true, members: [{ larkAppId: A }] });
  });

  it('rejects listing the birthing bot itself', () => {
    // It is already the creator; a user who lists it believes that entry does
    // something, and it cannot.
    expect(() => normalizeCollabConfig(
      { enabled: true, members: [{ larkAppId: SELF }] },
      { selfLarkAppId: SELF },
    )).toThrow(/must not list the birthing bot/);
  });

  it('rejects a local_* identity, which has no Lark transport at all', () => {
    expect(() => normalizeCollabConfig({ enabled: true, members: [{ larkAppId: 'local_thing' }] }))
      .toThrow(CollabConfigError);
  });

  it('rejects duplicates', () => {
    expect(() => normalizeCollabConfig({
      enabled: true,
      members: [{ larkAppId: A }, { larkAppId: A }],
    })).toThrow(/repeats/);
  });

  it('rejects a self-dependency and an unknown dependency', () => {
    expect(() => normalizeCollabConfig({
      enabled: true,
      members: [{ larkAppId: A, dependsOn: [A] }],
    })).toThrow(/depends on itself/);
    expect(() => normalizeCollabConfig({
      enabled: true,
      members: [{ larkAppId: A, dependsOn: [B] }],
    })).toThrow(/not a member/);
  });

  it('rejects a dependency cycle', () => {
    // A cycle would leave both stages waiting forever while the group reads
    // "initializing" — indistinguishable from a hang.
    expect(() => normalizeCollabConfig({
      enabled: true,
      members: [
        { larkAppId: A, dependsOn: [B] },
        { larkAppId: B, dependsOn: [A] },
      ],
    })).toThrow(/dependency cycle/);
  });

  it('rejects enabling with no members', () => {
    expect(() => normalizeCollabConfig({ enabled: true, members: [] })).toThrow(/at least one member/);
    expect(() => normalizeCollabConfig({ enabled: true })).toThrow(/at least one member/);
  });

  it('bounds the member count and the timeout range', () => {
    const many = Array.from({ length: MAX_COLLAB_MEMBERS + 1 }, (_, i) => ({ larkAppId: `cli_x${String(i).padStart(4, '0')}x` }));
    expect(() => normalizeCollabConfig({ enabled: true, members: many })).toThrow(/exceeds/);
    expect(() => normalizeCollabConfig({ enabled: true, onInitTimeoutMs: 1, members: [{ larkAppId: A }] })).toThrow(/onInitTimeoutMs/);
    expect(normalizeCollabConfig({ enabled: true, onInitTimeoutMs: 60_000, members: [{ larkAppId: A }] }))
      .toMatchObject({ onInitTimeoutMs: 60_000 });
  });

  it('rejects unknown keys so a typo cannot be silently ignored', () => {
    expect(() => normalizeCollabConfig({ enabled: true, memeber: [] })).toThrow(/Unknown sessionGroup.collab option/);
  });

  it('rejects a bad startPolicy instead of falling back', () => {
    expect(() => normalizeCollabConfig({ enabled: true, startPolicy: 'sometimes', members: [{ larkAppId: A }] }))
      .toThrow(/startPolicy/);
    expect(normalizeCollabConfig({ enabled: true, startPolicy: 'all', members: [{ larkAppId: A }] }))
      .toMatchObject({ startPolicy: 'all' });
  });
});

describe('collabConfigActive', () => {
  it('is the single predicate the birth path branches on', () => {
    expect(collabConfigActive(undefined)).toBe(false);
    expect(collabConfigActive({})).toBe(false);
    // enabled but empty cannot come from the writer, only from a hand edit —
    // and it must still not flip the birth path onto the collaboration branch.
    expect(collabConfigActive({ enabled: true })).toBe(false);
    expect(collabConfigActive({ enabled: true, members: [{ larkAppId: A }] })).toBe(true);
  });
});

describe('findDependencyCycle', () => {
  it('returns null for a DAG and the path for a cycle', () => {
    expect(findDependencyCycle([{ larkAppId: A }, { larkAppId: B, dependsOn: [A] }])).toBeNull();
    expect(findDependencyCycle([
      { larkAppId: A, dependsOn: [B] },
      { larkAppId: B, dependsOn: [A] },
    ])).toEqual([A, B, A]);
  });
});

describe('orderCollabMembers', () => {
  it('puts every dependency before its dependent', () => {
    const ordered = orderCollabMembers(
      [{ larkAppId: B, dependsOn: [A] }, { larkAppId: A }],
      'staged',
    );
    expect(ordered.map(m => m.larkAppId)).toEqual([A, B]);
  });

  it('keeps config order under startPolicy=all, because dependencies are ignored', () => {
    const ordered = orderCollabMembers(
      [{ larkAppId: B, dependsOn: [A] }, { larkAppId: A }],
      'all',
    );
    expect(ordered.map(m => m.larkAppId)).toEqual([B, A]);
  });

  it('still returns unreachable members instead of dropping them', () => {
    // A cycle is rejected at write time, but a partial config must not lose a
    // row: the user needs to SEE the member that cannot start.
    const ordered = orderCollabMembers(
      [{ larkAppId: A, dependsOn: [B] }, { larkAppId: B, dependsOn: [A] }],
      'staged',
    );
    expect(ordered).toHaveLength(2);
  });
});

describe('preflightCollabConfig', () => {
  const known = [
    { larkAppId: A },
    { larkAppId: B },
    { larkAppId: 'cli_apionly001', apiOnly: true },
  ];

  it('blocks on a missing profile entry — a role that cannot be applied', () => {
    const result = preflightCollabConfig({
      collab: { enabled: true, profileId: 'p', members: [{ larkAppId: A }] },
      selfLarkAppId: SELF,
      knownBots: known,
      onlineBots: new Set([A]),
      profileEntries: new Set<string>(),
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual({ code: 'missing_profile_entry', larkAppId: A });
  });

  it('blocks on an apiOnly bot, which cannot be invited or @-mentioned', () => {
    const result = preflightCollabConfig({
      collab: { enabled: true, profileId: 'p', members: [{ larkAppId: 'cli_apionly001' }] },
      selfLarkAppId: SELF,
      knownBots: known,
      onlineBots: new Set(),
      profileEntries: new Set(['cli_apionly001']),
    });
    expect(result.errors).toContainEqual({ code: 'bot_not_mentionable', larkAppId: 'cli_apionly001' });
  });

  it('reports an offline member as a warning, not a blocker', () => {
    // Its daemon may come back before the birth; blocking the save on a
    // temporarily stopped bot would make the config unmaintainable.
    const result = preflightCollabConfig({
      collab: { enabled: true, profileId: 'p', members: [{ larkAppId: A }] },
      selfLarkAppId: SELF,
      knownBots: known,
      onlineBots: new Set(),
      profileEntries: new Set([A]),
    });
    expect(result.ok).toBe(true);
    expect(result.warnings).toContainEqual({ code: 'bot_offline', larkAppId: A });
  });

  it('reports a missing profileId as a blocker', () => {
    const result = preflightCollabConfig({
      collab: { enabled: true, members: [{ larkAppId: A }] },
      selfLarkAppId: SELF,
      knownBots: known,
      onlineBots: new Set([A]),
      profileEntries: new Set([A]),
    });
    expect(result.errors).toContainEqual({ code: 'profile_missing' });
  });

  it('reports disabled config without pretending it is ready', () => {
    const result = preflightCollabConfig({
      collab: undefined,
      selfLarkAppId: SELF,
      knownBots: known,
      onlineBots: new Set(),
      profileEntries: new Set(),
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([{ code: 'collab_disabled' }]);
  });
});

describe('renderCollabPrompt', () => {
  it('substitutes the task and upstream summary, leaving unknown tokens literal', () => {
    expect(renderCollabPrompt('实现 {task}｜上游：{upstream}｜{unknown}', {
      task: '修 bug',
      upstream: 'builder 已完成',
    })).toBe('实现 修 bug｜上游：builder 已完成｜{unknown}');
  });
});
