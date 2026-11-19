# 私聊专属群的协作配置、角色就绪确认与自动开工

对应 issue #3588。目标体验：**页面预配置 → 私聊发任务 → 自动建专属群 → 拉入额外 Agent →
分别应用本群 Role → 确认就绪 → 按分工自动开工**，用户不需要为每个任务再补 `/g`、`/role`
或逐个 @ 启动。

本文只覆盖**同部署多 Agent**的首期范围。跨部署（联邦、双方授权、回执协议）单独设计。

---

## 1. 现状与缺口

| 事实 | 位置 | 缺什么 |
| --- | --- | --- |
| 私聊专属群出生只邀请当前 bot | `core/session-group-birth.ts` 的 `larkAppIds: [larkAppId]` | 没有协作名单 |
| `/g` 的默认配置只有 `agents` / `tag` / `avatar` | `services/group-creation-options.ts` | 没有角色与启动策略 |
| 建群者自己的 Role 直接落盘；其它 bot 靠群里发 `/role profile apply` | `services/group-creator.ts` | 只记录「消息发出去了」，不是「角色已应用」 |
| `sessionGroup` 配置块 | `bot-registry.ts` 的 `SessionGroupConfig` | 无协作字段 |
| Role profile 存储 | `services/role-profile-store.ts` | 只有 content，没有「哪个 bot 该在哪个角色」的群级映射 |

三条硬约束决定了做法：

1. **不能把飞书消息发送成功当角色应用成功。** 消息是给对端 daemon 的输入，输入被接受不等于
   角色文件已落盘。要一个**回执**，而且要能证明「这次回执对应这次初始化请求」。
2. **不能只靠消息顺序表达任务依赖。** 「Builder 实现后 Reviewer 评审」如果只是「先发 A 的
   kickoff、再发 B 的 kickoff」，那么 A 挂掉、A 还没提交、A 还在跑，B 照样开工。
3. **不能重复建群、重复投递、重复启动。** 建群是一次不可逆的外部副作用，daemon 会在任意一步
   重启；所有跨步状态必须持久化，且**外部调用结果未知时按「可能已发生」处理**。

## 2. 设计总览

```
               ┌──────────────────────────────┐
  配置页 ─────▶│ bots.json: sessionGroup.collab│  (名单 + profile + 分工 + 启动策略)
               └──────────────┬───────────────┘
                              │ 读取（热更新）
   私聊消息 ──▶ maybeBirthSessionGroup
                              │
                              ▼
               ┌──────────────────────────────┐
               │ collab-bootstrap（编排器）    │
               │  1. 建群（含协作 bot）        │
               │  2. 逐个邀请 + 成员核对       │
               │  3. 逐个「角色应用请求」      │
               │  4. 逐个「回执确认」          │
               │  5. 按依赖启动               │
               └───────┬──────────────┬───────┘
                       │ IPC(签名)     │ 群内消息（@ + 命令）
                       ▼              ▼
               ┌───────────────┐  ┌────────────────┐
               │ peer daemon   │  │ 建群 bot daemon │
               │ 写角色文件     │  │ kickoff 投递    │
               │ 回执 + 代次    │  │ 依赖等待        │
               └───────────────┘  └────────────────┘
                       │
                       ▼
               ┌──────────────────────────────┐
               │ 持久化 journal（每请求一份）  │
               │  + 群内进度卡 + 私聊回执      │
               └──────────────────────────────┘
```

### 2.1 为什么角色应用走 IPC 而不是群消息

`/role profile apply` 是**给对端 daemon 的输入**。它的执行结果（写没写成本群 role）只在对端
daemon 的进程内可见，本机拿不到。三种可选通道：

| 通道 | 能否拿到「应用完成」 | 结论 |
| --- | --- | --- |
| 群内 `/role profile apply --quiet` + 轮询屏幕/文件 | 否（跨机不可见；屏幕轮询是 issue 明确排除的） | 淘汰 |
| 群内命令 + 对端主动回执消息 | 能，但回执要绑定本次请求，且消息可能丢/重复 | 可用但弱 |
| **签名 IPC 直连对端 daemon** | 能，同步返回结果 + 可回读 | 采用 |

对端 daemon 地址来自 `utils/daemon-discovery.ts` 的心跳描述符（`ipcPort`），调用走
`core/daemon-ipc-auth.ts` 的 `fetchDaemonIpc`（HMAC 绑定 method + path + port，密钥是
`~/.botmux/.dashboard-secret`，沙盒内不可读）。这是仓库里已有的**受信任本地通道**，
workflow handoff、exact-chat-grant、dispatch 都走它。

群内仍然发一条人类可读的「正在应用角色」消息（不带命令语义），让群里的人看得懂发生了什么；
但**就绪判定只看 IPC 回执**。

## 3. 配置模型

### 3.1 存储位置

沿用 `SessionGroupConfig`，新增 `collab` 块（bots.json 里，随 bot 配置走，热更新）：

```jsonc
"sessionGroup": {
  "collab": {
    "enabled": true,
    "profileId": "dev-pair",          // role-profiles/<profileId>/
    "members": [
      {
        "larkAppId": "cli_aaa",       // 稳定身份，不用展示名
        "stage": "builder",           // 本请求内的角色槽位（自由字符串，仅日志/卡片展示）
        "role": "builder",            // 取 profile 里本 bot 的 entry；缺省 = 用 bot 自己的 profileId 解析
        "prompt": "实现这条任务：{task}",
        "dependsOn": []               // 无依赖 = 建群后即可启动
      },
      {
        "larkAppId": "cli_bbb",
        "stage": "reviewer",
        "prompt": "复核 {upstream} 的实现并给出结论",
        "dependsOn": ["cli_aaa"]      // 等 cli_aaa 的回合完成
      }
    ],
    "onInitTimeoutMs": 180000,        // 单个成员等待就绪的上限
    "startPolicy": "staged"           // 'staged'（按依赖）| 'all'（全部同时）
  }
}
```

**身份一律按 `larkAppId` 寻址。** 展示名可以改、可以重名，不能当身份用。配置页的预检会把
「名单里的 appId 本机有没有」和「profile 里有没有这个 bot 的 entry」分开报，缺什么就显示什么。

**为什么 role 是字符串而不是直接内联 markdown**：Profile 页已经是角色的编辑面（`role-profiles/<id>/<appId>.md`），
内联会让同一份角色有两个真相源。`role` 字段只做「本群该套哪一份」的选择。

### 3.2 页面

- **Bot 默认设置页**（`bot-defaults-page.tsx`，`sessionGroup.*` 旁边）新增「协作开工」行：
  开关、profile 选择、成员列表（每个成员：bot 选择器 + stage + prompt + dependsOn 多选）、
  保存时预检结果。
- **Profiles 页**（`roles-page.tsx` 的 profiles tab）不变：它已经是「各 bot 在本 profile 的角色」
  的编辑面。协作配置只引用 profile id。
- 预检返回结构化缺失项，而不是一句「配置不完整」：
  `{ missingBots: [...], missingEntries: [...], offlineBots: [...], cyclicDeps: [...] }`。

## 4. 初始化协议

### 4.0 per-chat 索引

消息闸要在 fleet 里**每一条群消息**上回答「这个群有没有正在进行的 bootstrap」。从
journal 目录扫出来有两个怎么优化都修不掉的缺陷：

- **爆炸半径**：只要有一个读不出来的历史 journal，就再也无法证明「这个群没有 bootstrap」，
  于是**所有群**的消息入口一起熔断；
- **陈旧**：任何以 stat 元组为 key 的缓存都可能被「改写但保持 mtime/size/inode」绕过，
  终态转换看不见。

所以每个群一个索引文件 `collab-bootstrap/chats/<chatId>.json`（`requestId` /
`ownerLarkAppId` / `status`），**终态也写、从不删除**。由此「没有索引文件」= 确切的
「这个群从未配置过协作」，`none` 才安全；坏索引只影响它自己那个群；热路径只读一个小 JSON。

索引与 journal 在**同一条写入路径**上同步，没有「一个更新了另一个没更新」的窗口。
daemon 启动时 `reconcileCollabChatIndices` 从权威 journal 重建丢失/错位的索引（一次性，
不是每消息）。索引指向的 journal 属于别的 chat 时返回 `unknown`（无法证明这里没有
bootstrap），fail closed。

### 4.1 请求身份与持久化

每次私聊触发初始化生成一个 `requestId`（随机 32 hex）。journal 落在
`{dataDir}/collab-bootstrap/{requestId}.json`，字段：

```ts
interface CollabBootstrapJournal {
  version: 1;
  requestId: string;
  /** 配置快照 —— 后续步骤一律读它，不读实时配置。 */
  configFingerprint: string;
  config: CollabConfig;              // 冻结的那份
  sourceChatId: string;              // 私聊
  sourceMessageId: string;           // 原始任务消息
  ownerOpenId: string;
  chatId?: string;                   // 建群后写入（durable boundary）
  createdAt: number;
  status: 'pending' | 'running' | 'ready' | 'failed' | 'cancelled';
  /** 每个成员一格，步骤幂等由它自己的 step 字段决定。 */
  members: Record<string, {
    larkAppId: string;
    join: { state: 'pending' | 'joined' | 'failed'; at?: number; error?: string };
    role: { state: 'pending' | 'requested' | 'confirmed' | 'failed';
            requestId?: string; confirmedAt?: number; appliedHash?: string; error?: string };
    start: { state: 'pending' | 'sent' | 'running' | 'completed' | 'failed';
             at?: number; turnId?: string; error?: string };
  }>;
  /** 进度卡与私聊回执的消息 id，用于原地更新。 */
  cardMessageId?: string;
  dmReceiptMessageId?: string;
  attempts: number;
  nextRetryAt?: number;
}
```

写入用 `atomicWriteFileSync(..., { durable: true, mode: 0o600 })`，RMW 用 `withFileLock`。
**`chatId` 写入是 durable boundary**：在 `onChatCreated` 同步钩子里落盘，先于任何邀请/角色/
启动步骤。此后重试一律复用这个 chatId，绝不重新建群。

### 4.2 步骤与幂等

```
建群 ─▶ 成员入群核对 ─▶ 角色应用(IPC) ─▶ 启动(kickoff)
```

每一步都有「已完成就跳过」的判据，且判据都来自**回读**而不是「上次调用没抛异常」：

1. **建群**：journal 有 `chatId` 就跳过。没有 `chatId` 时按下面的顺序决定：
   - **先按群名 marker 找一遍**：群名带 `#<requestId 前 8 位>`（与 `issue-claim-flow` 的
     `claimMarker` 同一手法）。唯一命中 ⟹ durable 认领并继续；多命中 ⟹ `ambiguous_group`
     失败（**不猜**，猜错会把会话劈成两半）；查询失败 ⟹ 同样 fail closed。
   - 零命中才真正建群。marker 落在**群名**上，是「`chat.create` 成功但回包丢了」之后
     唯一能活下来的证据；没有它，重试要么留下孤儿群、要么建出第二个群。
   - 建群前还要在 journal 锁内拿 `createClaim`（TTL 120s）：两次并发 pass（resume sweep 与
     turn report 撞车、或重启后两个 daemon）都会看到「没有 chatId」，没有 claim 就各建一个群。
2. **入群**：用建群 bot 的 `listChatBotMembers` 核对实际成员。`invalidBotIds` 里的成员记为
   `failed`，不静默跳过。
3. **角色**：见 §4.3。
4. **启动**：`start.state` 为 `sent`/`running`/`completed`/`failed` 时不再投递。
   发 kickoff **之前**只写一个会过期的 `sendClaim`（TTL 30s），**成功之后**才写 `sent`：
   先写 `sent` 再崩，会让该 stage 被之后每一次 pass 永久跳过，而 kickoff 从未真正送达。
   claim 过期后重试，成功才落地。
5. **建群阶段的硬失败**：显式 `workingDir` 下任一参与 bot 的 oncall 绑定失败 ⟹
   `working_dir_bind_failed`；bot 间 talk grant matrix 未完成 ⟹ `collaboration_grants_failed`。
   两者都不 kickoff —— 前者会让该 bot 在自己的默认目录（错误的仓库）里开工，后者会让
   kickoff 被接收方 talk gate 拒掉、整个协作静默产出为零。legacy 路径对同类失败已有
   「解散并回退」的处理，协作路径必须至少同样严格。

### 4.3 角色就绪确认（核心）

新增 IPC 路由 `POST /api/collab/apply-chat-role`，只在 `isTrustedHostIpcRequest(req)` 为真时
工作（与 `WORKFLOW_HANDOFF_IDENTITY_CHECK_ROUTE` 同构）。请求体：

```jsonc
{
  "protocol": "v1",
  "requestId": "…",            // 发起方 journal 的 id
  "configFingerprint": "…",    // 配置版本
  "chatId": "oc_…",
  "profileId": "dev-pair",
  "expectedHash": "sha256:…",  // 发起方按 profile 内容算的摘要
  "force": false
}
```

回读走同一路由的 `{ op: "readback", chatId, profileId }`，返回 `chatRoleHash` /
`entryHash`。同一路由同一鉴权面，协议版本也只有一个。

接收方（对端 daemon）的处理：

1. 校验 `chatId` 合法、`profileId` 合法、`isValidRoleChatId`。
2. 读**自己** dataDir 下 `role-profiles/<profileId>/<selfAppId>.md`。
   - 不存在 → `{ ok: false, reason: 'missing_entry' }`。**不回落默认角色**（issue 明确要求）。
   - 内容 hash 与 `expectedHash` 不符 → `{ ok: false, reason: 'entry_changed' }`。
     这是「过期请求」的硬闸：配置在途中被改过，旧请求不能继续开工。
3. 读本群现有 chat role：
   - 没有 → 写。
   - 有且内容相同 → 视为已就绪（幂等），`changed: false`。
   - 有且内容不同 → `force: false` 时 `{ ok: false, reason: 'chat_role_conflict', existingHash }`；
     `force: true` 时覆盖并在回执里带 `overwrote: true`。
     **冲突默认失败**，不无条件覆盖（issue 要求「不得靠无条件覆盖掩盖冲突」）。
4. 回执带 `appliedHash`、`appliedAt`、`chatId`、`requestId`、`configFingerprint`。

发起方收到回执后：

- 校验 `requestId` 与 `configFingerprint` 逐字相等 —— **过期回执不能启动旧任务**。
- 校验 `appliedHash` 等于自己算的 `expectedHash` —— 证明对端落的确实是这份内容。
- 再**回读一次**（`POST` 同一路由的 `readback` 操作）确认 `chatRoleHash` 与 `entryHash`
  都仍是 `expectedHash` —— 前者挡住「回执发出后被人改了本群角色」，后者挡住「profile
  条目在 apply 之后被改」（那样本群跑的角色与它的事实源已经分叉，之后每次重试和每个
  页面都会与实际情况不符）。
- 四个条件都过才把 `role.state` 记为 `confirmed`。

**绝不 `force`。** 冲突是「有人故意设了这个角色」的信号。`role.state === 'requested'`
只证明我们**准备**写，不证明写成功，因此不授予覆盖权。真正的 resume 不需要 force：
对端 `planCollabRoleApply` 在内容相同的时候返回 `noop`，内容不同的时候返回
`chat_role_conflict`。

任何一步失败：`role.state = 'failed'`，记录 `reason`，**该成员及其下游不启动**，
群内进度卡与私聊回执写明原因。

**取消/终态的闸门**：每一次 await 返回之后都在锁内重读 journal，`status` 已是
`cancelled`/`failed` 就中止并丢弃这次回执 —— 否则一个在 IPC 途中被取消的请求会
被成功回执「复活」。`running` 也只允许从 `pending`/`running` 写，绝不覆盖终态。

### 4.4 启动与依赖

`startPolicy: 'staged'`（默认）：

- `dependsOn: []` 的成员，角色 `confirmed` 后立刻 kickoff。
- 有依赖的成员，等所有 `dependsOn` 成员 `start.state === 'completed'` 再 kickoff。

「完成」的证据是**上游 bot 那一轮的 turn terminal**，而不是「kickoff 消息发出去了」。

这里有个必须显式跨进程的点：被 @ 起来的那一轮跑在 **peer 的** daemon 里，而 journal 在
**owner 的** daemon 里。所以有**两条**回报，都由 peer 经签名 IPC 发给 owner：

| 路由 | 时机 | owner 侧效果 |
| --- | --- | --- |
| `POST /api/collab/turn-started` | peer 的 CLI 真正接走 kickoff 那一轮 | `sent` → `running` |
| `POST /api/collab/turn-report` | 那一轮 terminal | `running`/`sent` → `completed` / `failed` |

缺了 started，peer 的 stage 永远停在 `sent`，而 terminal 只在能证明身份时才结算，于是
下游永不启动。两条回报都是 **fire-and-forget 且无序**，所以 terminal 允许在 turnId
**双端匹配**的前提下直接结算 `sent`（短回合可能在 started 之前就结束）；身份校验没有
放松，放松的只是「哪个 step state 可被结算」。

**鉴权**：两条路由都用 host-secret 签名 IPC，但 host secret 是整机共享的，只能证明
「本机的一个受信进程」，不能证明「它是它自称的那个 bot」。因此请求额外带
`x-botmux-collab-caller`（由发送方**自己的配置**填充，绝不取自 report body），
owner 要求它与 `report.larkAppId` 一致，否则 403。没有这一条，同机任一 daemon 都能
伪造别人的进度、提前释放下游。

owner 只推进自己 journal 里 `ownerLarkAppId` 与 `requestId` 都对得上的那一格，
迟到、串群、别的请求的回报都落不了地。

回报是 best-effort：丢了不会把 bootstrap 永久卡死（owner 的重入路径幂等，已 `completed`
的 stage 不会被重踢，且 §4.7 的 deadline sweep 兜底），但会在日志里留痕。

> 依赖等待有超时（`onInitTimeoutMs` × 2）：超时后该成员记 `failed`、`reason: 'upstream_timeout'`，
> 卡片说明「等 X 完成超时」。**不自动降级成无依赖启动** —— 那正是 issue 说的「不能仅用两条消息
> 的发送顺序代替依赖完成」。

`startPolicy: 'all'`：全部成员角色就绪后一起 kickoff，依赖字段忽略（给不关心顺序的场景留出口）。

### 4.5 门槛：初始化未就绪时群内新消息怎么办

闸门判据是**角色就绪**（`collabRolesReady`：每个成员都 `joined` + `role.confirmed`），
不是请求的 `status`。两者混用会同时错两次：角色全确认但下游在等上游的群会被当成
「未就绪」，而只发出第一波 kickoff 的群会被当成「已就绪」。

它**不以 `isSessionGroup` 为前置**：会话群登记只写在建群那个 bot 的 registry 里，被拉进来
的 peer 看不到它，以它为条件会让 peer 在角色未确认时直接开工。闸自己按 chatId 查
per-chat 索引（O(1)，没有 bootstrap 时立刻返回）。

journal 里角色还没全确认的群，任何**非**初始化自身的群内消息都走
**排队**策略（`holdCollabMessageIfNotReady`，位置在 `handleNewTopic` 的斜杠命令之前）：

- 消息不丢，进 `{dataDir}/collab-bootstrap/{requestId}.queue.json`（有序，带 messageId，
  按 messageId 幂等，重投的事件不会排两次），群内回一条「初始化未完成，消息已排队」的
  可见提示；**不启动任何 CLI**。
- **查活与入队必须原子**：`enqueueCollabMessage` 在队列锁内**重读 journal**。否则
  「读到 live → 另一回调置终态并 drain 空队列 → 本条 append 成功」会让这条消息被承诺
  排队却永远不会被 drain。重读发现已终态时返回 `{ok:false,reason:'terminal'}`，调用方
  按「未 hold」走正常路由。
- 队列文件损坏时**仍然 hold**（返回 true + 可见提示）：半就绪群绝不能因为排队文件坏了
  就启动 CLI。损坏文件保留不删，供人工恢复。
- 初始化进入终态后，群内再发一条提示，说明排了多少条；若队列损坏则明说「无法确认」，
  不能报 0。

**队列不自动重放。** 这是刻意的：自动重放等于替用户在一个刚刚建好的群里补发 CLI 回合，
而 bootstrap **失败**时那些回合会跑在一个角色从未确认过的群里 —— 正是 issue 要求堵死的
形态。用户保留显式选择：在就绪的群里重发，或修好配置后重试初始化。

**也不做静默拒绝**：用户看不到结果的拒绝，在飞书里等于消息丢了。

### 4.6 取消与人工干预

**首期落地的部分**（本 PR）：

- 取消/失败的闸门是**写前判定**：每一次外部副作用（kickoff）之前都重新读一次 journal，
  `status` 已是 `cancelled`/`failed` 就返回 `false` 并中止 —— 取消落在「算完 prompt、正要发」
  这个窗口里，也拦得住。
- 迟到的角色回执按 `requestId` + `configFingerprint` 双重匹配，对不上直接丢弃，不会推进任何
  stage，也不会启动任何下游。
- 配置在途中被改 ⟹ 每次外部副作用（建群 / 角色应用 / kickoff）**前**都用
  `liveConfigFingerprint()` 重算当前配置的指纹并与 journal 的冻结值比对，不同即
  `config_changed` 失败。指纹包含 `enabled`：把协作关掉也是一次 operator 决定，必须让
  在途请求 stale。读不到 live config 时返回 `unreadable`，同样失败 —— 不继续跑在无法校验
  的快照上。

**首期明确未做**（后续 PR）：进度卡上的「取消」按钮与「重试」按钮本身。现在取消的唯一来源是
journal 被写成终态（daemon 侧），没有面向用户的入口。这一点在 PR 描述里如实标注，不假装已支持。

真正落地时按上面的形状接：按钮 → `requestId` 绑定 → journal `status: 'cancelled'`；
重试 → **新的** `requestId` + 新的配置快照，旧 journal 保持终态不动。

### 4.7 deadline 与 sweep

两个**绝对**时间戳持久化在 journal 里（不是每次 pass 重算 `now + budget`，否则每次重启
都会给请求续一份新预算）：

- `deadlineAt`：初始化（角色就绪）预算，建请求时冻结；
- `dependencyDeadlineAt`：依赖等待预算，第一次真正能开工时冻结。

**语义边界**：deadline 管的是**就绪**，不是**执行**。一旦所有成员角色都 `confirmed`
且没有 stage 在等上游，sweep 就跳过这个请求 —— 一个跑很久的 builder turn 是正常工作，
不是卡住；杀掉它会让它自己那轮的 terminal 因为 journal 已终态而被拒，下游永久停摆。

`sweepExpiredCollabBootstraps` 由 daemon 每 60s 跑一次。持久化的 deadline 本身只是个
数字，没有这个时钟，started 与 terminal 都丢的请求会永远停在 `running`。

## 5. 权限与额度归属

- 群仍由**建群 bot** 拥有，`origin*` provenance 与今天一致：群内对话按出生时私聊的那份授权
  结算（`evaluateSessionGroupTalk` 不动）。
- 额外 Agent 的**角色应用**是接收方 daemon 用自己 bot 身份做的本地文件写，不消耗任何人的额度。
- 额外 Agent 的**启动**是建群 bot 在群里 @ 它 —— 这是既有的 bot-to-bot 投递路径，授权与额度
  按**接收方 bot** 自己的策略结算（`isTrustedTeamBotSender` / `teamBot` 腿），不挂在发起人或
  建群 bot 的 owner 上。这是今天 `group-creator` kickoff 就有的语义，本次不改变。
- 不复制 `open_id`：跨 bot 的 @ 一律用 `listChatBotMembers` 在建群 bot 视角下解析出的
  `openId`（已有做法）。
- 同一 `requestId` 的重复通知/恢复/重试不会重复 kickoff（§4.2 第 4 步），因此不会重复结算。

## 6. 兼容性

- `sessionGroup.collab` 缺省/`enabled: false` ⟹ `maybeBirthSessionGroup` 走**原路径**，
  邀请名单、消息、命名、回执全部逐字不变。
- 协作路径复用 `createGroupWithBots`，只是在 `larkAppIds` 里多带了成员、多传了
  `ensureBotCollaboration`（talk-only grant matrix，CLI create-group 已经在用）。
- 不触碰话题会话、adopt/restore、其它 CLI/后端。

## 7. 影响面

| 模块 | 改动 |
| --- | --- |
| `bot-registry.ts` | `SessionGroupConfig.collab` 类型 + 解析/校验 |
| `services/collab-bootstrap-store.ts`（新） | journal 读写、锁、per-chat 索引、队列、隔离坏文件 |
| `services/collab-bootstrap.ts`（新） | 编排器（纯决策 + 注入副作用） |
| `services/collab-birth.ts`（新） | 生产装配：建群/成员/角色/启动/卡片，boot 恢复，turn 回报 |
| `services/collab-peer-client.ts`（新） | 对端 daemon 的签名 IPC 客户端（角色应用 / 回读 / 回合回报） |
| `dashboard/web/session-group-collab-row.tsx`（新） | Bot 配置页的「协作开工」编辑行 |
| `core/collab-role-protocol.ts`（新） | 请求/回执类型、hash 计算、回执校验（纯函数） |
| `core/session-group-birth.ts` | 协作配置存在时走编排器，否则原路径 |
| `core/dashboard-ipc-server.ts` | `POST /api/collab/apply-chat-role`（含 readback）、`POST /api/collab/turn-started`、`POST /api/collab/turn-report`、配置读写与预检路由 |
| `daemon.ts` | IPC 路由注册；`onPromptSubmittedInput` → stage running、`onTurnTerminal` → 回报；队列闸；启动时索引重建与 resume；60s deadline sweep |
| `dashboard/web/bot-defaults-page.tsx` | 「协作开工」配置行 |
| `dashboard.ts` | 聚合路由（多 daemon 的 profile entry 汇总已有，复用） |

跨平台：路径/进程/PTY 无关，Linux/macOS 同一套。跨 CLI：只涉及 bot 之间的投递与角色文件，
与具体 CLI 适配器无关；但**每个成员的 CLI 必须是能收群内 @ 的 bot**（apiOnly bot 无法入群，
预检直接报 `missingBots`/`notMentionable`）。

## 8. 验收映射

| issue 场景 | 本设计的落点 |
| --- | --- |
| 正常私聊发任务 | §4.2 全链路；无需任何补充命令 |
| Agent 离线/邀请失败/权限不足 | §4.2 第 2 步核对成员；§4.3 回执失败；卡片显示原因，不提前开工 |
| Profile 缺条目/应用失败/角色冲突 | §4.3 的 `missing_entry` / `entry_changed` / `chat_role_conflict` |
| 角色就绪前收到群内新任务 | §4.5 排队 + 可见提示 |
| 重复消息、超时、建群结果未知 | §4.2 第 1 步的群名标记 + 回读认领；journal 幂等 |
| 多步写入只完成一部分、daemon 重启 | journal 逐步状态；`chatId` 先落盘 |
| 人工取消/改角色/撤销授权 | §4.6 + §4.3 的 `configFingerprint` 与回读 |
| 重试与常规处理交叠 | journal 单请求单飞（文件锁 + `status` 判定）；依赖按 terminal 而非消息顺序 |
| 多 bot 权限与额度 | §5 |
| 未启用协作配置 | §6 |

## 9. 首期不做

- 跨部署（联邦）协作：双方授权、回执协议、代次对账都要单独设计。
- 通用工作流引擎：本设计只表达「同一请求内、有向无环的启动依赖」，不引入条件分支、循环、
  重试策略编排。
- 角色内容本身的分发：仍由各 bot 自己的 dataDir 持有 profile entry，配置页负责写入
  （已有 `PUT /api/role-profiles/:id/:larkAppId` 代理到对应 daemon）。
