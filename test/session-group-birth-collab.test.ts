/**
 * `maybeBirthSessionGroup`: the collaboration branch vs the legacy branch.
 *
 * The compatibility contract is "unconfigured ⟹ byte-identical legacy
 * behaviour", and the collaboration contract is "configured ⟹ peer Agents, no
 * turn re-homed unless the bootstrap actually reached ready". Both are pinned
 * here by driving the real function with the group-creation service mocked —
 * nothing here asserts on source text.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const mocks = vi.hoisted(() => ({
  createGroupWithBots: vi.fn(),
  deleteChat: vi.fn(async () => ({ ok: true })),
  unbindOncall: vi.fn(async () => ({ ok: true })),
  registerSessionGroup: vi.fn(),
  scheduleSessionGroupTitle: vi.fn(),
  tagSessionGroup: vi.fn(async () => undefined),
  applySessionGroupAvatar: vi.fn(async () => undefined),
  sendMessage: vi.fn(async () => 'om_sent'),
  replyMessage: vi.fn(async () => 'om_reply'),
  forwardMessage: vi.fn(async () => 'om_fwd'),
  getMessageDetail: vi.fn(async () => null),
  birthCollab: vi.fn(),
}));

vi.mock('../src/services/group-creator.js', () => ({
  createGroupWithBots: (...args: unknown[]) => mocks.createGroupWithBots(...args),
}));
vi.mock('../src/services/groups-store.js', () => ({
  deleteChat: (...args: unknown[]) => mocks.deleteChat(...args),
}));
vi.mock('../src/services/oncall-store.js', () => ({
  unbindOncall: (...args: unknown[]) => mocks.unbindOncall(...args),
}));
vi.mock('../src/services/session-groups-store.js', () => ({
  registerSessionGroup: (...args: unknown[]) => mocks.registerSessionGroup(...args),
  isSessionGroup: () => false,
  getSessionGroup: () => undefined,
}));
vi.mock('../src/services/session-group-title.js', () => ({
  scheduleSessionGroupTitle: (...args: unknown[]) => mocks.scheduleSessionGroupTitle(...args),
}));
vi.mock('../src/services/feed-group-tagger.js', () => ({
  tagSessionGroup: (...args: unknown[]) => mocks.tagSessionGroup(...args),
}));
vi.mock('../src/services/session-group-avatar.js', () => ({
  applySessionGroupAvatar: (...args: unknown[]) => mocks.applySessionGroupAvatar(...args),
}));
vi.mock('../src/im/lark/client.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/client.js');
  return {
    ...actual,
    sendMessage: (...args: unknown[]) => mocks.sendMessage(...args),
    replyMessage: (...args: unknown[]) => mocks.replyMessage(...args),
    forwardMessage: (...args: unknown[]) => mocks.forwardMessage(...args),
    getMessageDetail: (...args: unknown[]) => mocks.getMessageDetail(...args),
  };
});
vi.mock('../src/services/collab-birth.js', async () => {
  const actual = await vi.importActual<any>('../src/services/collab-birth.js');
  return {
    ...actual,
    birthCollabSessionGroup: (...args: unknown[]) => mocks.birthCollab(...args),
  };
});

const APP = 'cli_selfbot0001';
const PEER = 'cli_peer000001';
const DM_CHAT = 'oc_dm_source_chat';
const NEW_CHAT = 'oc_new_group_chat';
const OWNER = 'ou_owner';
const MSG = 'om_source_dm_message';

let dataDir: string;

async function loadBirth() {
  return import('../src/core/session-group-birth.js');
}

function dmEvent() {
  return {
    sender: { sender_id: { open_id: OWNER }, sender_type: 'user' },
    message: {
      message_id: MSG,
      chat_id: DM_CHAT,
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: '把这条任务做完' }),
      create_time: String(Date.now()),
    },
  };
}

function ctx() {
  return {
    larkAppId: APP,
    chatId: DM_CHAT,
    messageId: MSG,
    chatType: 'p2p' as const,
    scope: 'thread' as const,
    anchor: MSG,
    replyRootId: undefined,
  };
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-collab-birth-'));
  process.env.SESSION_DATA_DIR = dataDir;
  process.env.BOTS_CONFIG = join(dataDir, 'bots.json');
  for (const fn of Object.values(mocks)) {
    if (typeof fn === 'function' && 'mockClear' in fn) (fn as any).mockClear();
  }
  mocks.sendMessage.mockResolvedValue('om_sent');
  mocks.replyMessage.mockResolvedValue('om_reply');
  mocks.forwardMessage.mockResolvedValue('om_fwd');
  mocks.createGroupWithBots.mockResolvedValue({
    ok: true,
    chatId: NEW_CHAT,
    creator: APP,
    invalidBotIds: [],
    invalidUserIds: [],
    invalidOwnerUnionIds: [],
    ownerTransferredTo: null,
    transferError: null,
    managersAdded: [OWNER],
    managerError: null,
    notifyMessageId: null,
    notifyError: null,
    shareLink: null,
    shareLinkError: null,
    oncallBindings: [{ larkAppId: APP, ok: true }],
    roleProfileBootstrapMessageId: null,
    roleProfileBootstrapError: null,
    kickoffMessageId: null,
    kickoffError: null,
  });

  const { registerBot, __testOnly_resetBotRegistry } = await import('../src/bot-registry.js');
  __testOnly_resetBotRegistry();
  mkdirSync(dataDir, { recursive: true });
  registerBot({
    larkAppId: APP,
    larkAppSecret: 'secret',
    cliId: 'claude-code',
    p2pMode: 'group',
  } as any);
});

async function withCollab(collab: unknown) {
  const { getBot } = await import('../src/bot-registry.js');
  (getBot(APP).config as any).sessionGroup = { collab };
}

describe('maybeBirthSessionGroup — legacy compatibility', () => {
  it('invites only itself and takes the legacy path when collaboration is not configured', async () => {
    const { maybeBirthSessionGroup } = await loadBirth();
    await withCollab(undefined);
    const reborn = await maybeBirthSessionGroup(dmEvent(), ctx() as any);

    expect(mocks.birthCollab).not.toHaveBeenCalled();
    expect(mocks.createGroupWithBots).toHaveBeenCalledTimes(1);
    expect(mocks.createGroupWithBots.mock.calls[0][0].larkAppIds).toEqual([APP]);
    expect(reborn?.chatId).toBe(NEW_CHAT);
    expect(reborn?.sessionGroupBirth).toBe(true);
  });

  it('also stays legacy when the block exists but is explicitly disabled', async () => {
    const { maybeBirthSessionGroup } = await loadBirth();
    await withCollab({ enabled: false, members: [{ larkAppId: PEER }] });
    await maybeBirthSessionGroup(dmEvent(), ctx() as any);
    expect(mocks.birthCollab).not.toHaveBeenCalled();
    expect(mocks.createGroupWithBots).toHaveBeenCalledTimes(1);
  });

  it('never births a group for a slash command, collaboration or not', async () => {
    const { maybeBirthSessionGroup } = await loadBirth();
    await withCollab({ enabled: true, profileId: 'p', members: [{ larkAppId: PEER }] });
    const event = dmEvent();
    event.message.content = JSON.stringify({ text: '/help' });
    const reborn = await maybeBirthSessionGroup(event, ctx() as any);
    expect(reborn).toBeNull();
    expect(mocks.birthCollab).not.toHaveBeenCalled();
    expect(mocks.createGroupWithBots).not.toHaveBeenCalled();
  });
});

describe('maybeBirthSessionGroup — collaboration branch', () => {
  beforeEach(async () => {
    await withCollab({
      enabled: true,
      profileId: 'dev-pair',
      members: [{ larkAppId: PEER, stage: 'builder', prompt: '实现 {task}' }],
    });
  });

  it('delegates to the collaboration bootstrap instead of the single-bot path', async () => {
    mocks.birthCollab.mockResolvedValue({ chatId: NEW_CHAT, status: 'ready', requestId: 'a1b2c3d4e5f60718' });
    const { maybeBirthSessionGroup } = await loadBirth();
    await maybeBirthSessionGroup(dmEvent(), ctx() as any);

    expect(mocks.createGroupWithBots).not.toHaveBeenCalled();
    expect(mocks.birthCollab).toHaveBeenCalledTimes(1);
    const arg = mocks.birthCollab.mock.calls[0][0] as any;
    expect(arg).toMatchObject({
      larkAppId: APP,
      dmChatId: DM_CHAT,
      messageId: MSG,
      ownerOpenId: OWNER,
      taskText: '把这条任务做完',
    });
  });

  it('re-homes the turn into the new group only when the bootstrap reached ready', async () => {
    mocks.birthCollab.mockResolvedValue({ chatId: NEW_CHAT, status: 'ready', requestId: 'a1b2c3d4e5f60718' });
    const { maybeBirthSessionGroup } = await loadBirth();
    const reborn = await maybeBirthSessionGroup(dmEvent(), ctx() as any);
    expect(reborn?.chatId).toBe(NEW_CHAT);
    expect(reborn?.chatType).toBe('group');
    expect(reborn?.scope).toBe('chat');
    // The group is registered with the DM's authorization provenance, exactly
    // like the legacy path — a collaboration group must not mint new quota.
    expect(mocks.registerSessionGroup).toHaveBeenCalledWith(NEW_CHAT, expect.objectContaining({
      ownerOpenId: OWNER,
      originChatId: DM_CHAT,
    }));
  });

  it('does NOT re-home the turn when a member could not be made ready', async () => {
    // Half-ready groups must not start working: the card and DM receipt say
    // why, and the DM turn falls back instead of spawning a CLI in that group.
    mocks.birthCollab.mockResolvedValue({
      chatId: NEW_CHAT,
      status: 'failed',
      requestId: 'a1b2c3d4e5f60718',
      failureReason: 'builder: profile 里没有这个 Bot 的角色条目',
    });
    const { maybeBirthSessionGroup } = await loadBirth();
    const reborn = await maybeBirthSessionGroup(dmEvent(), ctx() as any);
    expect(reborn).toBeNull();
    expect(mocks.registerSessionGroup).toHaveBeenCalledTimes(1);
  });

  it('registers the group BEFORE the bootstrap finishes, so the gate can hold messages', async () => {
    // Regression: registering only after the bootstrap returned left the whole
    // initialization window unregistered, and a message arriving in that window
    // walked straight into the normal CLI path with unconfirmed roles.
    let registeredDuringBootstrap = false;
    mocks.birthCollab.mockImplementation(async (arg: any) => {
      arg.onChatReady?.(NEW_CHAT);
      registeredDuringBootstrap = mocks.registerSessionGroup.mock.calls.length > 0;
      return { chatId: NEW_CHAT, status: 'ready', requestId: 'a1b2c3d4e5f60718' };
    });
    const { maybeBirthSessionGroup } = await loadBirth();
    await maybeBirthSessionGroup(dmEvent(), ctx() as any);
    expect(registeredDuringBootstrap).toBe(true);
    // …and it is not registered twice.
    expect(mocks.registerSessionGroup).toHaveBeenCalledTimes(1);
  });

  it('does not re-home a cancelled bootstrap either', async () => {
    mocks.birthCollab.mockResolvedValue({
      chatId: NEW_CHAT, status: 'cancelled', requestId: 'a1b2c3d4e5f60718',
    });
    const { maybeBirthSessionGroup } = await loadBirth();
    expect(await maybeBirthSessionGroup(dmEvent(), ctx() as any)).toBeNull();
  });
});
