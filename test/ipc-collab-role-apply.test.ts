/**
 * `POST /api/collab/apply-chat-role` — the peer daemon's side of role readiness.
 *
 * Driven through the REAL bound IPC route against a real role-profile directory
 * and a real role file, because the whole point is what lands ON DISK and what
 * the receipt claims about it. A mocked role store would let exactly the bug
 * this route exists to prevent (receipt says ok, file says otherwise) pass.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  setIpcAuthSecret,
  setLarkAppId,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import * as registry from '../src/bot-registry.js';
import {
  COLLAB_CALLER_APP_HEADER,
  COLLAB_ROLE_APPLY_ROUTE,
  COLLAB_ROLE_PROTOCOL,
  hashRoleContent,
} from '../src/core/collab-role-protocol.js';
import { resolveRoleFile } from '../src/core/role-resolver.js';

const APP = 'cli_collab_peer01';
const CHAT = 'oc_collab_chat_0001';
const PROFILE = 'dev-pair';
const REQ = 'a1b2c3d4e5f60718';
const ROLE = '你是 Reviewer，负责复核实现。';
const HASH = hashRoleContent(ROLE)!;

const HOST_SECRET = 'collab-role-apply-host-secret';

let handle: IpcServerHandle | undefined;
let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-collab-ipc-'));
  process.env.SESSION_DATA_DIR = dataDir;
  setLarkAppId(APP);
  setIpcAuthSecret(HOST_SECRET);
  vi.spyOn(registry, 'getBot').mockReturnValue({
    config: { larkAppId: APP, larkAppSecret: 'test', cliId: 'claude-code' },
  } as ReturnType<typeof registry.getBot>);
  mkdirSync(join(dataDir, 'role-profiles', PROFILE), { recursive: true });
});

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  setIpcAuthSecret(null);
  vi.restoreAllMocks();
  rmSync(dataDir, { recursive: true, force: true });
});

function writeEntry(content: string): void {
  writeFileSync(join(dataDir, 'role-profiles', PROFILE, `${APP}.md`), content);
}

function writeChatRole(content: string): void {
  mkdirSync(join(dataDir, 'roles', APP), { recursive: true });
  writeFileSync(join(dataDir, 'roles', APP, `${CHAT}.md`), content);
}

/** Signed host request (the caller a real peer daemon would be). */
async function post(
  body: unknown,
  auth: 'host' | 'untrusted' = 'host',
): Promise<{ status: number; body: Record<string, unknown> }> {
  handle ??= await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth === 'host') {
    const signed = daemonIpcAuthHeaders({
      secret: HOST_SECRET,
      port: handle.port,
      method: 'POST',
      path: COLLAB_ROLE_APPLY_ROUTE,
    });
    signed.forEach((value, key) => { headers[key] = value; });
  }
  const response = await fetch(`http://127.0.0.1:${handle.port}${COLLAB_ROLE_APPLY_ROUTE}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function applyRequest(overrides: Record<string, unknown> = {}) {
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

describe('collab role apply route', () => {
  it('refuses without host authority', async () => {
    // Loopback is connectivity, not identity: an untrusted caller (a CLI in a
    // sandbox that reached 127.0.0.1) must not be able to rewrite a chat role.
    writeEntry(ROLE);
    const result = await post(applyRequest(), 'untrusted');
    // The server-wide gate rejects an unsigned loopback caller before the route
    // ever runs — the route's own guard is the second line for narrow-auth routes.
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.body.ok).toBe(false);
    expect(resolveRoleFile(APP, CHAT)).toBeNull();
  });

  it('writes the profile entry as the chat role and reports the on-disk hash', async () => {
    writeEntry(ROLE);
    const result = await post(applyRequest());
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      protocol: COLLAB_ROLE_PROTOCOL,
      requestId: REQ,
      configFingerprint: 'sha256:cfg',
      chatId: CHAT,
      appliedHash: HASH,
      changed: true,
      overwrote: false,
    });
    expect(resolveRoleFile(APP, CHAT)).toBe(ROLE);
  });

  it('refuses when the profile has no entry, and leaves the chat role untouched', async () => {
    const result = await post(applyRequest());
    expect(result.body).toMatchObject({ ok: false, reason: 'missing_entry' });
    expect(resolveRoleFile(APP, CHAT)).toBeNull();
  });

  it('refuses when the entry changed after the caller hashed it', async () => {
    writeEntry('完全不同的角色');
    const result = await post(applyRequest());
    expect(result.body).toMatchObject({ ok: false, reason: 'entry_changed' });
    expect(resolveRoleFile(APP, CHAT)).toBeNull();
  });

  it('refuses to overwrite an existing different chat role unless forced', async () => {
    writeEntry(ROLE);
    writeChatRole('人工设置的角色');
    expect((await post(applyRequest())).body).toMatchObject({ ok: false, reason: 'chat_role_conflict' });
    expect(resolveRoleFile(APP, CHAT)).toBe('人工设置的角色');

    const forced = await post(applyRequest({ force: true }));
    expect(forced.body).toMatchObject({ ok: true, overwrote: true });
    expect(resolveRoleFile(APP, CHAT)).toBe(ROLE);
  });

  it('is idempotent when the same role is already applied', async () => {
    writeEntry(ROLE);
    writeChatRole(ROLE);
    const result = await post(applyRequest());
    expect(result.body).toMatchObject({ ok: true, changed: false, overwrote: false });
  });

  it('rejects a malformed request, an invalid chat id and an invalid profile id', async () => {
    writeEntry(ROLE);
    expect((await post({ ...applyRequest(), protocol: 'v0' })).body).toMatchObject({ ok: false, reason: 'invalid_request' });
    expect((await post(applyRequest({ chatId: 'not-a-chat' }))).body).toMatchObject({ ok: false, reason: 'invalid_chat_id' });
    expect((await post(applyRequest({ profileId: '../escape' }))).body).toMatchObject({ ok: false, reason: 'invalid_profile_id' });
  });

  it('readback reports the chat role and entry hashes as they are now', async () => {
    writeEntry(ROLE);
    writeChatRole(ROLE);
    const result = await post({ op: 'readback', chatId: CHAT, profileId: PROFILE });
    expect(result.body).toMatchObject({
      ok: true,
      protocol: COLLAB_ROLE_PROTOCOL,
      chatId: CHAT,
      chatRoleHash: HASH,
      entryHash: HASH,
    });
  });

  it('readback reports a null chat-role hash when no role is set', async () => {
    writeEntry(ROLE);
    const result = await post({ op: 'readback', chatId: CHAT, profileId: PROFILE });
    expect(result.body).toMatchObject({ ok: true, chatRoleHash: null, entryHash: HASH });
  });

  it('readback surfaces a later human edit, which is what makes readiness re-checkable', async () => {
    writeEntry(ROLE);
    writeChatRole(ROLE);
    writeChatRole('人改成了别的');
    const result = await post({ op: 'readback', chatId: CHAT, profileId: PROFILE });
    expect(result.body.chatRoleHash).toBe(hashRoleContent('人改成了别的'));
  });
});

describe('peer report identity binding', () => {
  it('rejects a report whose declared bot does not match the caller', async () => {
    // The host secret proves "a trusted process on this machine", not "the bot
    // this report names". Without this check any daemon could forge a member's
    // progress and release a downstream stage early.
    seedLiveJournal();
    const result = await postRaw('/api/collab/turn-started', {
      protocol: COLLAB_ROLE_PROTOCOL,
      requestId: REQ,
      chatId: CHAT,
      larkAppId: 'cli_victim0001',
      turnId: 'forged-turn',
    }, { caller: APP });
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ ok: false, reason: 'caller_identity_mismatch' });
  });

  it('rejects a terminal report with no caller identity at all', async () => {
    seedLiveJournal();
    const result = await postRaw('/api/collab/turn-report', {
      protocol: COLLAB_ROLE_PROTOCOL,
      requestId: REQ,
      chatId: CHAT,
      larkAppId: APP,
      turnId: 'turn-1',
      status: 'completed',
    }, { caller: '' });
    expect(result.status).toBe(403);
  });

  it('accepts a report whose caller matches the declared bot', async () => {
    seedLiveJournal();
    const result = await postRaw('/api/collab/turn-started', {
      protocol: COLLAB_ROLE_PROTOCOL,
      requestId: REQ,
      chatId: CHAT,
      larkAppId: APP,
      turnId: 'turn-1',
    }, { caller: APP });
    expect(result.status).toBe(200);
    // It parses and reaches the owner handler; the exact stage result depends
    // on journal state, which is covered by the orchestrator tests.
    expect(result.body.ok === true || result.body.reason === 'no_matching_stage').toBe(true);
  });
});

function seedLiveJournal(): void {
  mkdirSync(join(dataDir, 'collab-bootstrap', 'chats'), { recursive: true });
  writeFileSync(join(dataDir, 'collab-bootstrap', `${REQ}.json`), JSON.stringify({
    version: 1,
    requestId: REQ,
    ownerLarkAppId: APP,
    config: { enabled: true, profileId: PROFILE, members: [{ larkAppId: 'cli_peer0001' }] },
    configFingerprint: 'sha256:cfg',
    sourceChatId: 'oc_dm',
    sourceMessageId: 'om_src',
    ownerOpenId: 'ou_owner',
    chatId: CHAT,
    createdAt: 1,
    updatedAt: 1,
    status: 'running',
    members: {
      cli_peer0001: {
        larkAppId: 'cli_peer0001',
        join: { state: 'joined' },
        role: { state: 'confirmed' },
        start: { state: 'sent' },
      },
    },
    taskText: 't',
    attempts: 0,
  }));
  // The lookup reads the per-chat index first (O(1) on the message path).
  writeFileSync(join(dataDir, 'collab-bootstrap', 'chats', `${CHAT}.json`), JSON.stringify({
    version: 1, requestId: REQ, ownerLarkAppId: APP, status: 'running', updatedAt: 1,
  }));
}

async function postRaw(
  path: string,
  body: unknown,
  opts: { caller: string },
): Promise<{ status: number; body: Record<string, unknown> }> {
  handle ??= await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.caller) headers[COLLAB_CALLER_APP_HEADER] = opts.caller;
  const signed = daemonIpcAuthHeaders({
    secret: HOST_SECRET, port: handle.port, method: 'POST', path,
  });
  signed.forEach((value, key) => { headers[key] = value; });
  const response = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
