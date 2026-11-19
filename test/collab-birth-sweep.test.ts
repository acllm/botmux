/**
 * Deadline sweep semantics.
 *
 * The sweep is the clock behind a persisted deadline. Its hard requirement is
 * the opposite of "kill anything old": it must FAIL a request that never became
 * ready, and must LEAVE ALONE a request whose roles are confirmed and whose
 * stages are legitimately running — a long builder turn is work, not a stall,
 * and killing it would reject that turn's own terminal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const mocks = vi.hoisted(() => ({
  dataDir: '',
  selfAppId: 'cli_owner00001',
}));

vi.mock('../src/config.js', () => ({
  config: { session: { get dataDir() { return mocks.dataDir; } } },
}));
vi.mock('../src/im/lark/client.js', () => ({
  sendMessage: vi.fn(async () => 'om'),
  updateMessage: vi.fn(async () => undefined),
  replyMessage: vi.fn(async () => 'om'),
  listChatBotMembers: vi.fn(async () => []),
}));
vi.mock('../src/bot-registry.js', () => ({
  getBot: () => ({ config: { larkAppId: mocks.selfAppId, sessionGroup: {} } }),
}));

let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'botmux-collab-sweep-'));
  mocks.dataDir = dir;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const OWNER = 'cli_owner00001';
const PEER = 'cli_peer000001';
const CHAT = 'oc_sweep_chat_0001';

async function seed(status: 'pending' | 'running', members: Record<string, any>) {
  const store = await import('../src/services/collab-bootstrap-store.js');
  const birth = await import('../src/services/collab-birth.js');
  birth.setCollabSelfAppId(OWNER);
  store.createCollabJournal(dir, {
    requestId: 'aaaaaaaaaaaaaaaa',
    ownerLarkAppId: OWNER,
    config: { enabled: true, profileId: 'p', members: [{ larkAppId: PEER }] },
    configFingerprint: 'sha256:cfg',
    sourceChatId: 'oc_dm',
    sourceMessageId: 'om_src',
    ownerOpenId: 'ou_owner',
    createdAt: 1,
    status,
    chatId: CHAT,
    taskText: 't',
    members,
  });
  return store;
}

function member(overrides: Record<string, any> = {}) {
  return {
    [PEER]: {
      larkAppId: PEER,
      join: { state: 'joined' },
      role: { state: 'confirmed' },
      start: { state: 'pending' },
      ...overrides,
    },
  };
}

describe('sweepExpiredCollabBootstraps', () => {
  it('fails a request that never reached readiness', async () => {
    const store = await seed('running', {
      [PEER]: {
        larkAppId: PEER,
        join: { state: 'pending' },
        role: { state: 'pending' },
        start: { state: 'pending' },
      },
    });
    // Freeze a deadline in the past.
    store.updateCollabJournal(dir, 'aaaaaaaaaaaaaaaa', j => { j.deadlineAt = 0; });
    const birth = await import('../src/services/collab-birth.js');
    expect(await birth.sweepExpiredCollabBootstraps(() => 10_000)).toBe(1);
    expect(store.readCollabJournal(dir, 'aaaaaaaaaaaaaaaa')?.status).toBe('failed');
  });

  it('leaves a ready group with a long-running stage alone', async () => {
    // Roles confirmed + a stage actually running = normal work, not a stall.
    // Killing it would reject that turn's own terminal (the journal would be
    // terminal) and strand every dependent stage.
    const store = await seed('running', member({
      start: { state: 'running', turnId: 'turn-1' },
    }));
    store.updateCollabJournal(dir, 'aaaaaaaaaaaaaaaa', j => { j.deadlineAt = 0; });
    const birth = await import('../src/services/collab-birth.js');
    expect(await birth.sweepExpiredCollabBootstraps(() => 10_000)).toBe(0);
    expect(store.readCollabJournal(dir, 'aaaaaaaaaaaaaaaa')?.status).toBe('running');
    expect(store.readCollabJournal(dir, 'aaaaaaaaaaaaaaaa')?.members[PEER].start.state).toBe('running');
  });

  it('still fails a ready group whose stage is waiting on an upstream past the deadline', async () => {
    const store = await seed('running', member({ start: { state: 'pending' } }));
    store.updateCollabJournal(dir, 'aaaaaaaaaaaaaaaa', j => {
      j.deadlineAt = 0;
      j.dependencyDeadlineAt = 0;
    });
    const birth = await import('../src/services/collab-birth.js');
    expect(await birth.sweepExpiredCollabBootstraps(() => 10_000)).toBe(1);
  });
});
