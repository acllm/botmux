/**
 * Role-readiness protocol: hashing, the peer-side decision table, and the
 * caller-side acceptance fences.
 *
 * The whole point of this module is that "the message was sent" and "the role
 * is applied" are different facts. Each test below pins one of the ways a
 * receipt can look fine and still not be proof.
 */
import { describe, it, expect } from 'vitest';
import {
  COLLAB_ROLE_PROTOCOL,
  acceptCollabRoleReceipt,
  collabConfigFingerprint,
  hashRoleContent,
  isValidCollabRequestId,
  parseCollabRoleApplyRequest,
  parseCollabTurnReport,
  planCollabRoleApply,
  type CollabRoleApplyRequest,
} from '../src/core/collab-role-protocol.js';

const REQ = 'a1b2c3d4e5f60718';
const CHAT = 'oc_collab_chat_0001';
const PROFILE = 'dev-pair';
const ROLE = '你是 Reviewer，负责复核实现。';
const HASH = hashRoleContent(ROLE)!;

function request(overrides: Partial<CollabRoleApplyRequest> = {}): CollabRoleApplyRequest {
  return {
    protocol: COLLAB_ROLE_PROTOCOL,
    requestId: REQ,
    configFingerprint: 'sha256:cfg',
    chatId: CHAT,
    profileId: PROFILE,
    expectedHash: HASH,
    force: false,
    ...overrides,
  };
}

describe('hashRoleContent', () => {
  it('normalizes exactly like the role writers (trim) so a trailing newline is not a mismatch', () => {
    expect(hashRoleContent(`${ROLE}\n\n`)).toBe(HASH);
    expect(hashRoleContent(`  ${ROLE}  `)).toBe(HASH);
  });

  it('treats absent and empty content the same, because both mean "no role"', () => {
    expect(hashRoleContent(null)).toBeNull();
    expect(hashRoleContent('')).toBeNull();
    expect(hashRoleContent('   \n ')).toBeNull();
  });

  it('distinguishes different content', () => {
    expect(hashRoleContent('你是 Builder。')).not.toBe(HASH);
  });
});

describe('planCollabRoleApply (peer daemon side)', () => {
  it('writes when there is no chat role yet', () => {
    expect(planCollabRoleApply({
      entryContent: ROLE, chatRoleContent: null, expectedHash: HASH, force: false,
    })).toEqual({ action: 'write', overwrote: false });
  });

  it('is a noop when the role is already exactly this content', () => {
    // Idempotent re-apply: a retried bootstrap must not report a conflict
    // against its own earlier write.
    expect(planCollabRoleApply({
      entryContent: ROLE, chatRoleContent: ROLE, expectedHash: HASH, force: false,
    })).toEqual({ action: 'noop' });
  });

  it('refuses when the profile entry is missing — never falls back to the bot default', () => {
    expect(planCollabRoleApply({
      entryContent: null, chatRoleContent: null, expectedHash: HASH, force: false,
    })).toEqual({ action: 'refuse', reason: 'missing_entry' });
    expect(planCollabRoleApply({
      entryContent: '   ', chatRoleContent: null, expectedHash: HASH, force: false,
    })).toEqual({ action: 'refuse', reason: 'missing_entry' });
  });

  it('refuses when the entry changed since the caller computed its hash', () => {
    // This is the fence against an over-the-wire request that outlived the
    // configuration it was built from.
    const plan = planCollabRoleApply({
      entryContent: '完全不同的角色', chatRoleContent: null, expectedHash: HASH, force: false,
    });
    expect(plan).toMatchObject({ action: 'refuse', reason: 'entry_changed' });
    expect(plan).toHaveProperty('actualHash');
  });

  it('refuses to overwrite a different existing chat role unless forced', () => {
    const plan = planCollabRoleApply({
      entryContent: ROLE, chatRoleContent: '人工设置的角色', expectedHash: HASH, force: false,
    });
    expect(plan).toMatchObject({ action: 'refuse', reason: 'chat_role_conflict' });
    expect(plan).toHaveProperty('actualHash');
  });

  it('overwrites a conflicting role only when forced', () => {
    expect(planCollabRoleApply({
      entryContent: ROLE, chatRoleContent: '人工设置的角色', expectedHash: HASH, force: true,
    })).toEqual({ action: 'write', overwrote: true });
  });
});

describe('acceptCollabRoleReceipt (caller side)', () => {
  const receipt = {
    ok: true as const,
    protocol: COLLAB_ROLE_PROTOCOL,
    requestId: REQ,
    configFingerprint: 'sha256:cfg',
    chatId: CHAT,
    appliedHash: HASH,
    appliedAt: 1,
    changed: true,
    overwrote: false,
  };
  const readback = {
    ok: true as const,
    protocol: COLLAB_ROLE_PROTOCOL,
    chatId: CHAT,
    chatRoleHash: HASH,
    entryHash: HASH,
  };
  const base = {
    requestId: REQ,
    configFingerprint: 'sha256:cfg',
    chatId: CHAT,
    expectedHash: HASH,
  };

  it('accepts a receipt whose request, config, chat, hash and readback all line up', () => {
    expect(acceptCollabRoleReceipt({ ...base, receipt, readback }))
      .toEqual({ ready: true, appliedHash: HASH });
  });

  it('rejects a missing receipt', () => {
    expect(acceptCollabRoleReceipt({ ...base, receipt: null, readback }))
      .toEqual({ ready: false, reason: 'no_receipt' });
  });

  it('rejects a receipt from a previous request', () => {
    // A late receipt from an earlier (or cancelled) attempt must never start a
    // turn for the current one.
    expect(acceptCollabRoleReceipt({
      ...base, receipt: { ...receipt, requestId: 'ffffffffffffffff' }, readback,
    })).toEqual({ ready: false, reason: 'stale_receipt' });
  });

  it('rejects a receipt built from a different config version', () => {
    expect(acceptCollabRoleReceipt({
      ...base, receipt: { ...receipt, configFingerprint: 'sha256:other' }, readback,
    })).toEqual({ ready: false, reason: 'config_changed' });
  });

  it('rejects a receipt for another chat', () => {
    expect(acceptCollabRoleReceipt({
      ...base, receipt: { ...receipt, chatId: 'oc_elsewhere' }, readback,
    })).toEqual({ ready: false, reason: 'wrong_chat' });
  });

  it('rejects a receipt that applied different content than expected', () => {
    expect(acceptCollabRoleReceipt({
      ...base, receipt: { ...receipt, appliedHash: hashRoleContent('别的角色')! }, readback,
    })).toEqual({ ready: false, reason: 'applied_hash_mismatch' });
  });

  it('rejects when the readback shows the role changed after the write', () => {
    // The receipt was true when issued; a human may have rewritten the role a
    // second later. Readiness must reflect NOW.
    expect(acceptCollabRoleReceipt({
      ...base, receipt, readback: { ...readback, chatRoleHash: hashRoleContent('被人改了')! },
    })).toEqual({ ready: false, reason: 'role_changed_after_apply' });
  });

  it('rejects when the readback is missing or failed', () => {
    expect(acceptCollabRoleReceipt({ ...base, receipt, readback: null }))
      .toEqual({ ready: false, reason: 'no_readback' });
    expect(acceptCollabRoleReceipt({ ...base, receipt, readback: { ok: false } as any }))
      .toEqual({ ready: false, reason: 'readback_failed' });
  });

  it('surfaces the peer refusal reason verbatim so the card can name the cause', () => {
    expect(acceptCollabRoleReceipt({
      ...base, receipt: { ok: false, reason: 'missing_entry' }, readback,
    })).toEqual({ ready: false, reason: 'missing_entry' });
  });

  it('rejects a receipt from a peer speaking a different protocol version', () => {
    expect(acceptCollabRoleReceipt({
      ...base, receipt: { ...receipt, protocol: 'v0' as any }, readback,
    })).toEqual({ ready: false, reason: 'protocol_mismatch' });
  });
});

describe('parseCollabRoleApplyRequest', () => {
  it('accepts a well-formed request and defaults force to false', () => {
    expect(parseCollabRoleApplyRequest(request())).toEqual({ ...request(), force: false });
  });

  it('rejects a wrong protocol, a malformed request id and a non-sha expected hash', () => {
    expect(parseCollabRoleApplyRequest({ ...request(), protocol: 'v0' })).toBeNull();
    expect(parseCollabRoleApplyRequest({ ...request(), requestId: 'not-hex!' })).toBeNull();
    expect(parseCollabRoleApplyRequest({ ...request(), expectedHash: 'md5:abc' })).toBeNull();
  });

  it('rejects non-objects', () => {
    expect(parseCollabRoleApplyRequest(null)).toBeNull();
    expect(parseCollabRoleApplyRequest([])).toBeNull();
    expect(parseCollabRoleApplyRequest('x')).toBeNull();
  });
});

describe('parseCollabTurnReport', () => {
  it('accepts a completion report and keeps the optional turn id', () => {
    expect(parseCollabTurnReport({
      protocol: COLLAB_ROLE_PROTOCOL,
      requestId: REQ,
      chatId: CHAT,
      larkAppId: 'cli_builder0001',
      turnId: 'turn-1',
      status: 'completed',
    })).toEqual({
      protocol: COLLAB_ROLE_PROTOCOL,
      requestId: REQ,
      chatId: CHAT,
      larkAppId: 'cli_builder0001',
      turnId: 'turn-1',
      status: 'completed',
    });
  });

  it('rejects an unknown status and a malformed request id', () => {
    expect(parseCollabTurnReport({
      protocol: COLLAB_ROLE_PROTOCOL, requestId: REQ, chatId: CHAT, larkAppId: 'cli_a', status: 'done',
    })).toBeNull();
    expect(parseCollabTurnReport({
      protocol: COLLAB_ROLE_PROTOCOL, requestId: 'zz', chatId: CHAT, larkAppId: 'cli_a', status: 'completed',
    })).toBeNull();
  });
});

describe('collabConfigFingerprint', () => {
  it('is stable across a reordering of dependsOn but not across content changes', () => {
    const a = collabConfigFingerprint({
      profileId: PROFILE,
      startPolicy: 'staged',
      members: [{ larkAppId: 'cli_a', dependsOn: ['cli_b', 'cli_c'] }],
    });
    const b = collabConfigFingerprint({
      profileId: PROFILE,
      startPolicy: 'staged',
      members: [{ larkAppId: 'cli_a', dependsOn: ['cli_c', 'cli_b'] }],
    });
    expect(a).toBe(b);

    const c = collabConfigFingerprint({
      profileId: PROFILE,
      startPolicy: 'staged',
      members: [{ larkAppId: 'cli_a', dependsOn: ['cli_b', 'cli_c'], prompt: '改了' }],
    });
    expect(c).not.toBe(a);
  });

  it('changes when the start policy or profile changes', () => {
    const base = { profileId: PROFILE, members: [{ larkAppId: 'cli_a' }] } as const;
    expect(collabConfigFingerprint({ ...base, startPolicy: 'staged' }))
      .not.toBe(collabConfigFingerprint({ ...base, startPolicy: 'all' }));
    expect(collabConfigFingerprint({ ...base, profileId: 'other', startPolicy: 'staged' }))
      .not.toBe(collabConfigFingerprint({ ...base, startPolicy: 'staged' }));
  });
});

describe('isValidCollabRequestId', () => {
  it('only accepts lowercase hex of a plausible length', () => {
    expect(isValidCollabRequestId(REQ)).toBe(true);
    expect(isValidCollabRequestId('ABCDEF12')).toBe(false);
    expect(isValidCollabRequestId('short')).toBe(false);
    expect(isValidCollabRequestId(123)).toBe(false);
  });
});

describe('readback entry drift and enabled fingerprint', () => {
  it('rejects when the PROFILE ENTRY moved after the apply', () => {
    // The chat role still holds the old content, so the group runs a role that
    // no longer matches its source of truth.
    const receipt = {
      ok: true as const,
      protocol: COLLAB_ROLE_PROTOCOL,
      requestId: REQ,
      configFingerprint: 'sha256:cfg',
      chatId: CHAT,
      appliedHash: HASH,
      appliedAt: 1,
      changed: true,
      overwrote: false,
    };
    const verdict = acceptCollabRoleReceipt({
      receipt,
      requestId: REQ,
      configFingerprint: 'sha256:cfg',
      chatId: CHAT,
      expectedHash: HASH,
      readback: {
        ok: true,
        protocol: COLLAB_ROLE_PROTOCOL,
        chatId: CHAT,
        chatRoleHash: HASH,
        entryHash: hashRoleContent('完全不同的新条目')!,
      },
    });
    expect(verdict).toEqual({ ready: false, reason: 'entry_changed' });
  });

  it('includes `enabled` so turning collaboration off makes a request stale', () => {
    const on = collabConfigFingerprint({ enabled: true, profileId: PROFILE, startPolicy: 'staged', members: [] });
    const off = collabConfigFingerprint({ enabled: false, profileId: PROFILE, startPolicy: 'staged', members: [] });
    expect(on).not.toBe(off);
  });
});
