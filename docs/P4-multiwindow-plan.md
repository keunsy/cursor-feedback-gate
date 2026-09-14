# P4 方案（v2·已按证据收敛）：窗口重载后的孤儿 trigger 与孤儿队列项

> 状态：**设计待审**（未动任何生产代码，未碰用户 `/tmp` 现场）
> 证据采集：2026-09-10 12:00 / 14:21 / 15:0x，用户机器现场（3 个 Cursor 窗口 + 1 个共享 MCP 进程 58301）
> 前置：P3 波次修的是「同一窗口内多对话跨投」（IW1–IW13，`test/real-code-intrawindow.js` 14/14、`test/real-code-webview.js` 10/10，对**已打包发布代码**取证 + 变异测试）。本文处理的是另一条路径。

---

## 修订记录

### v2（本版）——撤回三条结论，方案大幅缩小

v1 我下了三个判断，其中**两个是错的**，特此撤回并记录取证过程，避免以后再被同样的假象骗到：

| v1 结论 | v2 处置 | 推翻它的证据 |
|---|---|---|
| **E2「跨窗口错投」**：taoguba 的提问被 feat-230-game 窗口回答 | **撤回**。不存在错投 | ① `CREATING trigger (id=fg_1789012619216_a0cc6255, ws=/Users/user/work/features/feat-230-game, eh_pid=25959, call_ws=同上)` → 该 trigger **本来就属于** feat-230 窗口，25959 作答是正确的；② 响应是 `USER_RESPONSE path=first-wait`（= 创建者自己等到了），不是 `path=re-enter`（= 别人代取）；③ 我被 `ENTERED \| trigger=fg_1789012619216_a0cc6255 sid=b8f1e3c2 msg=金健米业…` 骗了——那一行的 trigger 字段取自**全局单值** `self._pending_trigger_id`（`mcp.py:710-711`），并发下必然指向别的对话的 trigger。**这是日志缺陷，不是投递缺陷。** |
| **R2「sid 跨窗口撞车导致归属失效」** | **撤回**（降级为"潜在风险 R8"） | 15 个 sid 前缀中，**0 个**对应多个 workspace（`Workspace from tool call` 592 条全查）；`Multiple active triggers … without session_id` 0 次；`Workspace changed for session` 0 次。sid 虽然被 agent 编造/轮换（一天 20+ 个，含 `a1b2c3d4-e5f6-7890-abcd-ef1234567890` 这类手写模式），但**没有发生跨窗口碰撞**。 |
| **R5「工作区线索失效（逗号串/wsPrecise）」** | **撤回** | `workspace_folders` 在新建 trigger 时写的是 `_target_workspace = _call_workspace or _cached_workspace`（`mcp.py:1350-1369`），即 **agent 本次调用传入的单一路径**；我看到的逗号串在 **pid 文件**里（`WORKSPACE_FOLDER_PATHS`，只用于 MCP 发现，不参与路由），两者被我混为一谈。且 `call_ws=none` 出现 **0 次 / 412 次** → 路由信号一直是健康的。 |

**v2 新增的重要定性纠正**：这两个症状的主因是 **窗口重载（扩展宿主重启）**，不是"多窗口"本身。多窗口只是让它更容易触发、更难被发现——**单窗口在提问挂起期间 Reload Window，同样会卡满 1 小时、同样会丢队列**。所以修复重点从"跨窗口路由"改为"**重载后的孤儿接管与不静默丢弃**"。

**v2 砍掉的设计**（回应"为什么要这么大改"）：sid 服务端发号、`(eh_pid, workspace)` 降级复合身份、**跨窗口队列交接**、workspace 字段优先级改造 —— 全部不做。跨窗口搬队列尤其错：它会把 v1 误判的"错投"制度化，而用户的要求恰恰相反（**跨窗口、跨 tab 都不许投**）。

---

## 0. TL;DR

| 症状 | 已证实的根因 | 位置 |
|---|---|---|
| 早的那次调用一直卡着（实测吊满 **1 小时**后静默返回） | 孤儿 trigger 的判活依据是 `_session_to_eh_pid[sid]`——**"这个会话还有没有活着的窗口"**；而窗口重载后新 EH 会把这个映射刷新成"活着"，于是判活永远通过，可真正显示过这个提问的 webview 早已随旧 EH 消失 | `mcp.py:1148-1161`（判活）、`:831/885/1052`（刷新来源） |
| 排队消息不消费，而且**最终丢失、零日志** | 重载后旧 EH 的队列文件被迁移，但迁移时 `sessionKey` 被清空成 untagged；untagged 项只能靠"同一 sessionId 的 trigger 再次到来"时的领养谓词复活；若该对话此后换了 sid（agent 在编造 sid）或没再来，就永远没人消费，2 小时空闲清理时被**静默丢弃** | `queue-manager.js:78-79`（清空）、`extension.js:561-620`（2h 清理，无丢弃日志） |
| （次要）排障被误导 | `ENTERED` / `[DIAG]` 日志打的是全局 `_pending_trigger_id`，并发下指向无关 trigger | `mcp.py:710-711` |
| （潜在）服务端按 sid 全局匹配 trigger，不校验工作区 | 今天没出事（0 次碰撞），但一旦两个窗口的 agent 编出同一个 sid（LLM 很容易收敛到 `a1b2c3d4-…` 这类"漂亮"UUID），B 窗口的调用就会走 re-enter 路径把 A 窗口的回答取走 | `mcp.py:746-752` |

---

## 1. 已证实的现场证据

### 1.1 进程拓扑：一个 MCP 服务多窗口，且窗口反复重载

```
MCP: 58301（Sep 9 10:56 启动，今天全部事件的 PID 都是它）

taoguba 窗口的扩展宿主更替史（来自 CREATING 日志的 eh_pid）:
  5564 → 26127 → 46325（11:13:58）→ 68383（14:xx 起）
其他窗口:
  25959  feat-230-game（11:02:20）
  46014  feat-230-game-entry-config（11:13:48）
```

→ 一个上午 taoguba 窗口至少重载 3 次。**每次重载都会制造一批孤儿 trigger 和孤儿队列项。**

### 1.2 E1：孤儿 trigger 吊满 1 小时（完整链条，全部来自日志/文件原文）

```
11:00:32  CREATING trigger (id=fg_1789009232569_5c93f1d8, ws=/Users/user/work/cursor/taoguba,
                            eh_pid=5564, call_ws=同上, cached_ws=同上)
11:00:32  NEW_TRIGGER trigger=fg_1789009232569_5c93f1d8 active=3 msg=金健米业深度分析完成…
11:02:34  🔄 RECOVERY: EH 5564 is dead for trigger fg_1789009232569_5c93f1d8 — rewriting trigger file
11:02:34  🔄 RECOVERY: trigger file rewritten (ws=/Users/user/work/cursor/taoguba, eh_pid=cleared)
11:02:34  ack 文件: acknowledged=true, extension_host_pid=26127   ← 26127 接管并弹窗
（此后 26127 也死了；_session_to_eh_pid[b8f1e3c2] 被后续响应刷新成新的活 EH）
11:05:33…11:57:23  HEARTBEAT #1…#11  wall=300.x s  cumul=5.0 → 55.0 min   ← 再无任何 RECOVERY
12:02 前后 触到 _IDE_MAX_TOTAL_SECONDS = 3600 → 静默返回
```

参数核对：`_IDE_WAIT_SECONDS = 300`（与 wall=300s 一致）、`_IDE_MAX_TOTAL_SECONDS = 3600`（`mcp.py:621-622`）。
恢复探针：`_wait_for_user_input` 内每 10s 调一次 `_rewrite_trigger_for_recovery`（`mcp.py:1271, 1291-1294`），所以"不恢复"不是没探测，而是**探测的判据永远为真**：

```python
sid = trigger_info.get("session_id", "")                      # 1148
cached_eh_pid = self._session_to_eh_pid.get(sid) if sid else None   # 1149  ← 按 sid 查，不是按"谁 ack 过这个 trigger"
if not cached_eh_pid: return False                            # 1150-1151
os.kill(cached_eh_pid, 0) 成功 → return False                  # 1153-1161 ← 新 EH 活着 ⇒ 永不恢复
```

而 `_session_to_eh_pid[sid]` 会被**任何**一次该 sid 的 ack/响应刷新（`:1052` ack、`:831/:885` 响应）。窗口重载后新 EH 一答话，映射就指向活进程 → 旧 trigger 永远"看起来有人管"。

> 推论（可验证）：**单窗口**在提问挂起时 Reload Window，同样会吊满 1 小时。这不是多窗口专属缺陷。

### 1.3 E3：排队消息被静默丢弃（用户输入丢失，零日志）

```
/tmp/feedback_gate_queue__Users_user_work_cursor_taoguba_pid46325.json（11:29 写入）
  { id: 1789010952657001, text: "当前有什么可买的标的么", status: "pending",
    sessionKey: "58301_1789008940269_9", sessionId: "b8f1e3c2-4d5a-7f09-8a1b-2c3d4e5f6a7b" }

/tmp/feedback_gate_user_inputs.log
  [2026-09-10T03:29:12.667Z] QUEUED: Queued: 当前有什么可买的标的么
  ← 全文再无第二次出现：没有 MCP_RESPONSE，也没有任何 DISCARDED 记录

14:21 复查：该文件已变成 {"items": []}
```

正常路径对照（同一天，说明"排队即投递"是常态）：

```
[06:17:34.728Z] QUEUED: 临时看个问题我cursor配置的这个模型不能用么
[06:17:34.745Z] MCP_RESPONSE: 临时看个问题…        ← 17 ms
[06:18:19.717Z] QUEUED: 前面不是生成了一份qa测试工具文档么…
[06:18:19.720Z] MCP_RESPONSE: 前面不是生成了一份…   ← 3 ms
```

机制（代码级）：

1. `queue-manager.js:22-23` 队列文件按 `(workspaceId, EH pid)` 分片 → 重载后新 EH 读不到旧文件；
2. `queue-manager.js:38-60` `_migrateOldPidQueues()` 只在 `init()` 时跑一次（`:126`），且**跳过仍活着的 pid**（`if (_isProcessAlive(filePid)) continue;`）→ 旧 EH 未死透时不迁移；
3. 迁移成功时 `queue-manager.js:78-79`：`m._prevSessionKey = m.sessionKey; m.sessionKey = '';` → 项变成 **untagged**（`sessionId` 按 P3-1b 注释刻意保留）；
4. `dequeueMessage(sessionKey)` 是**精确匹配**，untagged 项只能靠 P3-1c 的领养谓词（`setCurrentTriggerData` 里 `migrateSessionKey('', key, queueItemBelongsToConversation)`）复活，而这要求**同一 sessionId 的 trigger 再次到来**；
5. agent 在编造/轮换 sid（1.5 节）→ 下一次来的 trigger 带的是**另一个** sid → 领养谓词不通过 → 该项永远 pending；
6. `extension.js:561-620` `cleanupStaleSessions()` 2h 空闲清理把它丢掉，**且不写任何日志/事件** → 用户看到的就是"队列有内容也不消费，然后没了"。

### 1.4 sid 被编造/轮换（不构成本次事故根因，但是 1.3 第 5 步的放大器）

今天 events.log 的 sid 计数（前 8）：

```
128  f47ac10b-58cc-4372-a567-0e02b2c3d479
108  d3f8a2c1-7e4b-4a9d-b5c6-1234abcd5678     ← 手写模式
 97  f8a3c2e1-7b4d-4e9f-a1c6-5d8e2f3b9a0c
 95  d2c8e5a0-4f31-4a1b-9b3e-f1a5c8d9e012     ← 顺序 hex
 95  b7e2c9a1-3f54-4d8e-a1b2-6c7d8e9f0a1b     ← 顺序 hex
 89  a1b2c3d4-e5f6-7890-abcd-ef1234567890     ← 教科书式占位 UUID
 83  f3a7b1c2-9d4e-4f8a-a5b6-c7d8e9f01234     ← 顺序 hex
 77  b2f7c4e1-9a83-4d5f-b612-3e8f1a2d7c09
```

3 个窗口 / 一天 20+ 个 sid，说明 `FeedbackGate.mdc` 的"复用 session_id"没被遵守。**但**：每个 sid 前缀只对应一个 workspace（0 例跨窗口碰撞），所以它没有造成错投，只造成了 1.3 第 5 步的"领养失配"。

### 1.5 顺带观测：trigger 堆积（本波次只加观测，不改行为）

```
14:17:50  ENTERED      trigger=fg_1789021038686_ae3300b5 …      ← 全局字段，噪声
14:17:50  NEW_TRIGGER  trigger=fg_1789021070565_763ad2ca active=3
14:18:19  USER_RESPONSE path=first-wait trigger=fg_1789021038686_ae3300b5 wall=61.2s
14:19:48  NEW_TRIGGER  trigger=fg_1789021188789_c3f4a016 active=3
14:19:49  USER_RESPONSE path=first-wait trigger=fg_1789021188789_c3f4a016 wall=0.6s
```

`active=3` 长期保持：每次 agent 重入都可能新建 trigger，旧的仍留在 `_active_triggers`（`_MAX_ACTIVE_TRIGGERS = 20`，`_STALE_TRIGGER_SECONDS_IDE = 86400` = 24h 才清）。`wall=0.6s` 说明队列消费在健康路径下是即时的。

---

## 2. 完整调用链（带 file:line，v2 已校正）

### 2.1 MCP 侧

```
feedback_gate_chat(session_id, message, workspace_path, …)
├─ 699-704   workspace_path = args["workspace_path"]；_session_to_workspace[sid] = workspace_path
│            （实测 412/412 次调用都带了 workspace_path，值都是真实单路径）
├─ 710-711   ENTERED 事件 ← ★ 打的是全局 self._pending_trigger_id（并发下误导，见 R7）
├─ 746-752   my_trigger_id 解析：在**服务器全局** _active_triggers 里按 sid 精确匹配，第一个命中即用
│            ← ★ 不校验 workspace（R8 潜在跨窗口取件）
├─ 770-778   EVICT_SAME_SESSION（同 sid 旧 trigger 驱逐，响应转 stash）
├─ 780-792   stale 清理：_STALE_TRIGGER_SECONDS_IDE = 86400（24h）→ TRIGGER_EXPIRED
├─ 794-801   _MAX_ACTIVE_TRIGGERS = 20
├─ 815-823   【re-enter 路径】读 feedback_gate_response_<my_tid>.json
│            ├─ 831/833  从响应学习 _session_to_eh_pid[sid] / _session_to_workspace[sid]  ← ★ 判活污染源
│            └─ 895      USER_RESPONSE path=re-enter
├─ 921-922   HEARTBEAT #n（wait_secs=300s 一轮；累计 > 3600s 放弃）
├─ 999       _active_triggers[tid] = {session_id, message, created_at, workspace_path…}
├─ 1013-1041 写 trigger 到 3 个路径（canonical fg_<tid> / pid<server_pid> / legacy）
├─ 1046-1055 等 ack（15s）→ _session_to_eh_pid[sid] = ack.extension_host_pid   ← ★ 唯一的"谁在显示"信息，但只存进 sid 映射，没存进 trigger_info
├─ 1059-1072 【first-wait 路径】_wait_for_user_input(tid, timeout=300)
│            ├─ 1259   只盯 feedback_gate_response_<tid>.json
│            ├─ 1271/1291-1294  每 10s → _rewrite_trigger_for_recovery
│            └─ 1305   超时返回 None
├─ 1089-1099 收到响应 → 学习 EH/ws → USER_RESPONSE path=first-wait
└─ 1350-1369 新建 trigger 的路由决策：
             _target_workspace = _call_workspace or _cached_workspace     ← 单路径，健康
             _target_eh_pid    = _session_to_eh_pid.get(sid)              ← sid 变了就是 None
             若 call_ws != cached_ws → 清空 _target_eh_pid（:1356-1358，防错路由，已存在）

_rewrite_trigger_for_recovery(tid, trigger_info)   # 1136-1215
├─ 1148-1151  sid → _session_to_eh_pid；无映射 → return False      ← ★ R1
├─ 1153-1161  os.kill 成功 → return False                          ← ★ R1（新 EH 活着即"有人在管"）
├─ 1166/1170  删映射；ws 回退取 trigger_info["workspace_path"] 或 _session_to_workspace[sid]
├─ 1193       target_extension_host_pid = None（放开路由过滤）
├─ 1202-1210  重写 3 个 trigger 文件（recovery: true）
└─ 1212       TRIGGER_RECOVERY 事件
```

### 2.2 扩展侧（认领路由，v2 结论：**今天是健康的**）

```
startFeedbackGateIntegration()  # extension.js:1905
└─ 轮询：1909 discoverMcpPids → 1921 pid trigger → 1923 legacy → 1929-1932 扫 fg_* → 1934 checkIdeQueueFile
   1940-1950 cleanupStaleSessions()（2h，:596 写 [EXPIRED] 响应）

checkTriggerFile()  # 1994
├─ 2000-2014  editor/system/routing 过滤
├─ 2016-2031  实例隔离（ppid / ancestor / sibling）
├─ 2033-2062  Signal 0.5  sessionLease.isHeldElsewhere(sid, myPid) → 让位，≤3s（P1-2）
├─ 2046-2048  triggerWorkspace = workspace_folders || data.workspace_path   ← 实测取到的是单路径，wsPrecise=true
├─ 2066-2107  Signal 1  target_extension_host_pid：活着→return；死了→own sid 者认领；
│             无人 own 时 E10：age≥2s 且本窗口 focused → 采纳
├─ 2110-2112  wsPrecise / wsMatch
├─ 2114-2170  Signal 2  sid 所有权 + 工作区亲和（own&&!match→让位3s；!own&&match→竞争；
│             !own&&!match→return；!wsPrecise→竞争）
└─ 2200-2234  ★ 原子抢占：unlink canonical fg_<tid>.json，成功者 CLAIMED

作答：writeResponseForTrigger()  # 1395-1428（写 per-trigger 响应 + legacy 全局副本；含 extension_host_pid）
ack： 2713  写 feedback_gate_ack_<tid>.json（含 extension_host_pid）  ← ★ P4-1 要用的"谁在显示"
```

### 2.3 队列侧（v2 重点）

```
queue-manager.js
├─ 16-23   getQueueFilePath() = /tmp/feedback_gate_queue_<wsId>_pid<process.pid>.json
├─ 38-60   _migrateOldPidQueues()：同 wsId 前缀；**跳过活 pid**；rename → .migrating.<pid> 原子声明
├─ 78-79   ★ 迁移后 m._prevSessionKey = m.sessionKey; m.sessionKey = '';   → 变 untagged
├─ 82-86   sessionId 刻意保留（P3-1b 注释：它是唯一能跨 PID 存活的会话身份）
├─ 126     仅在 init() 调用一次
├─ 163-167 removeItemsForSession(key)：按 sessionKey 与 _prevSessionKey 双条件删
├─ 181-182 migrateSessionKey(from,to,predicate) 里同样会清空 sessionKey
└─ dequeueMessage(sessionKey)：**精确匹配** → untagged 项无法被直接取出
extension.js
├─ setCurrentTriggerData → migrateSessionKey('', key, queueItemBelongsToConversation)   ← P3-1c 领养唯一入口
├─ 2343 / 2483 / 3117  三个消费点，都要先拿到 sessionKey
└─ 561-620 cleanupStaleSessions：2h 空闲 → 清 triggerData、写 [EXPIRED] 响应、丢队列项（★ 无日志）
```

---

## 3. 根因清单（v2）

| ID | 根因 | 证据 | 影响 |
|---|---|---|---|
| **R1** | 孤儿 trigger 判活用 `_session_to_eh_pid[sid]`（"会话有没有活窗口"），而不是"**ack 过这个 trigger 的 EH** 还活着吗"；窗口重载后新 EH 刷新映射 → 判活永远通过 | 1.2；`mcp.py:1148-1161` + `:831/885/1052` | 调用吊满 1h；单窗口重载即可复现 |
| **R3** | 队列项跨重载后 `sessionKey` 被清空 → 只能靠"同 sessionId 的 trigger 再来一次"领养；agent 换 sid 就永远领养不上 | 1.3；`queue-manager.js:78-79` + `dequeueMessage` 精确匹配 | 用户输入永不消费 |
| **R4** | 丢弃 pending 队列项的路径**零日志零事件** | 1.3（`user_inputs.log` 只有 QUEUED，无 DISCARDED） | 数据丢失不可诊断、不可追责 |
| **R6** | 恢复无重试上限、放弃时无快速失败；1h 后静默返回，agent 收不到明确语义 | `mcp.py:1252-1305` | 用户感知"卡死" |
| **R7** | `ENTERED`/`[DIAG]` 打全局 `_pending_trigger_id` | `mcp.py:710-711`；v1 就是被它骗的 | 排障误导（已实际造成一次误判） |
| **R8**（潜在） | `my_trigger_id` 按 sid 在**服务器全局** `_active_triggers` 匹配，不校验 workspace | `mcp.py:746-752`；今天 0 次碰撞 | 若两窗口 agent 编出同一 sid → B 窗口 re-enter 取走 A 窗口的回答（正是用户明令禁止的跨窗口投递） |

---

## 4. 修复设计（v2，只剩 4 条，都很小）

### P4-1　孤儿 trigger：按「ack 过这个 trigger 的 EH」判活 + 快速失败　（修 R1、R6）

1. `_active_triggers[tid]` 增记 `ack_eh_pid` / `acked_at` / `recovery_count`。数据来源现成：`mcp.py:1046-1055` 已经读到 `ack_eh_pid`，只是没存进 trigger_info。
2. `_rewrite_trigger_for_recovery` 判活顺序改为：
   - ① `trigger_info["ack_eh_pid"]`（**真正显示过这个提问的进程**）死了 → 恢复；
   - ② 无 ack 记录时才回退 `_session_to_eh_pid[sid]`（保持向后兼容）；
   - ③ 两者都无：canonical 文件已消失（= 被认领过）且 trigger 年龄 > `ORPHAN_GRACE`（默认 20s）→ 也恢复，**不再 `return False`**。
3. 恢复上限：`recovery_count >= MAX_RECOVERY`（默认 3，配 10s 探针 ≈ 30s）仍无人 ack → 写 `[EXPIRED-ORPHAN]` 响应让调用**立即返回**，文案明确「提问所在窗口已关闭/重载，请重新调用」，并记 `TRIGGER_ORPHAN_GIVEUP`。
   > 用户在评审中已选定：**快速失败 ~30s**，不再等 1h。
4. `HEARTBEAT` 事件补 `ack_eh=<pid> eh_alive=<bool> recovery=<n>`。

**风险**：重写 trigger 会让窗口重新弹窗——但只在"ack EH 已死"时发生，语义正确；`MAX_RECOVERY=3` 在慢机器上可能误杀，可配置化（`~/.cursor/feedback-gate-config.json` 已有热读机制，`mcp.py:626-655`）。
**回滚**：三处改动（存字段 / 判据 / 上限）彼此独立，可单独回退。
**验证**：MW-1（ack EH 被 kill → 10s 内重写并被接管）；MW-2（**复现 1.2**：ack EH 死后，同 sid 由新 EH 应答一次刷新映射 → 仍必须恢复）；MW-3（连续 3 次恢复失败 → ~30s 返回 `[EXPIRED-ORPHAN]`，不吊 1h）。变异测试：把判据改回 `_session_to_eh_pid[sid]` → MW-2 必须转红。

### P4-2　队列项跨重载必须可消费，且**永不静默丢弃**　（修 R3、R4）

1. **保留 untagged 迁移语义**（P3-1b/P3-1c 的隔离设计不动），但补上"领养不上"的出口：
   - 迁移后的 untagged 项在新 EH 里挂到**按 sessionId 索引的待领养表**；当任意 trigger 到来且其 `sessionId` 相等 → 领养（现状）；
   - 若 `ORPHAN_QUEUE_GRACE`（默认 10min）内没有任何 trigger 领养它 → **不丢弃**，改为：把文本**退回输入框**（若该 session 的 webview 存在）或作为系统消息明示「上一条排队消息未能投递，已退回，请重新发送」，同时写 `QUEUE_ITEM_ORPHANED` 事件 + `user_inputs.log` 一行 `ORPHANED:`。
2. **所有**丢弃 pending 项的路径（2h 清理 `extension.js:561-620`、`removeItemsForSession`、`loadQueue` 的 `status==='done'` 过滤等）统一走一个 `discardQueueItem(item, reason)`，必须写 `QUEUE_ITEM_DISCARDED`（含 id、sessionId、文本前 60 字、reason、源文件）。
   > 硬要求：**E3 那种"消息凭空消失"以后不允许再发生。**
3. `_migrateOldPidQueues` 增加一次**延迟重扫**（init 后 ~30s 再跑一次），覆盖"旧 EH 尚未死透、迁移被跳过"的窗口（`queue-manager.js:38-60` 的 `_isProcessAlive` 跳过分支）。

**明确不做**：跨窗口/跨工作区搬运队列项（用户要求"跨 tab 都不要"，跨窗口更不行）。队列项只在**同一 workspaceId** 内跨 PID（即同一窗口重载前后）流转，这与现状一致，只是补上了失败出口。
**验证**：MW-4（重载后同 sessionId 的 trigger 到来 → 领养并投递，`MCP_RESPONSE` 出现）；MW-5（重载后 sid 变了 → 10min 后退回输入框 + 留痕，**不**静默消失）；MW-6（2h 清理 → 必须有 `QUEUE_ITEM_DISCARDED`）。变异测试：去掉退回/留痕 → MW-5、MW-6 转红。

### P4-3　服务端 sid 匹配加工作区校验（防 R8，兑现"跨窗口都不要"）

`mcp.py:746-752` 的匹配条件从"sid 相等"收紧为"sid 相等 **且** 工作区相容"：

```python
if info.get("session_id") == session_id:
    _tw = (info.get("workspace_path") or "").strip()
    if _tw and workspace_path and _tw != workspace_path:
        continue          # 同 sid 但不同工作区 → 不是同一个对话，不得取件
    my_trigger_id = tid; break
```

命中该分支时记 `SESSION_ID_COLLISION` 事件（含两个 workspace 与 tid），把潜在碰撞变成可观测事实。
**风险**：极低——只在"sid 相同但工作区不同"时改变行为，而这本来就不该匹配。**收益**：即使将来 agent 编出同一个 sid，也不可能出现 B 窗口取走 A 窗口回答。
**验证**：MW-7（两个虚拟窗口用同一 sid、不同 workspace → 各自新建 trigger、各自取自己的响应；`SESSION_ID_COLLISION` 记 1 次）。变异测试：去掉工作区校验 → MW-7 转红。

### P4-4　诊断修正（修 R7）

1. `ENTERED` / `[DIAG]` 改为在 `my_trigger_id` 解析**之后**记录，并同时给出两个字段：`pending_global=<_pending_trigger_id> matched=<my_trigger_id or 'none'>`（保留旧字段便于对比历史日志，但不再让它单独承担"这是谁的 trigger"的语义）。
2. `USER_RESPONSE` 增记 `resp_eh=<extension_host_pid> resp_ws=<workspace_folders>`，与 trigger 的 `eh_pid/ws` 并列 → 以后一眼能看出是否跨窗口作答（今天需要交叉 4 个文件才能确认，还确认错了）。

**风险**：无（纯日志）。**收益**：本次 v1 误判的直接成因被消除。

### 明确砍掉（v1 → v2）

| v1 项 | 处置 | 理由 |
|---|---|---|
| P4-3 跨窗口队列交接 | **删除** | 用户明确反对；且其唯一依据 E2 已被撤回。它会把错投制度化 |
| P4-4a sid 服务端发号 + `.mdc` 强制回填 | **删除** | 改动面大（改 agent 契约）；今天 0 次碰撞，收益不成立。sid 编造的真实危害只在 P4-2 第 1 步里被兜住 |
| P4-4b `(eh_pid, workspace)` 降级复合身份 | **删除** | 同上；P4-3 的工作区校验已覆盖唯一现实风险 |
| P4-2 workspace 字段优先级改造 | **删除** | R5 撤回：`_target_workspace` 已经优先取 `call_ws`，412/412 都有值 |
| P4-5 作答窗口校验（拒绝/告警） | **缩为 P4-4 的日志** | 没有观测到错投，先只加可观测性，不引入拒绝策略 |

---

## 5. 验证方案

沿用 P3-5 波次原则：**只测已打包发布的代码，不测逻辑镜像**。

新增 `cursor-extension/test/real-code-multiwindow.js`（v2 范围已缩小）：

- **拓扑**：2–3 个真实子进程，各加载一份带 seam 的真实 `extension.js`（seam 手法同 `real-code-intrawindow.js`：复制到 `cursor-extension/debug_realcode_mw_<n>.js`，gitignored `debug_*`；追加 `module.exports.__seam`；临时 `cursor-extension/node_modules/vscode/` 桩；**绝不调用 `activate()`**）+ 1 个真实 `feedback_gate_mcp.py` 子进程（复现"多窗口共享一个 MCP"）。
- **前置改造（唯一的生产改动）**：`utils.getTempPath()` 与 MCP `get_temp_path()` 支持 `FEEDBACK_GATE_TMPDIR` 注入，**默认值仍为 `/tmp`** → 生产行为零变化，harness 用独立沙箱，绝不触碰用户真实 `/tmp`。
- **"窗口重载"的模拟**：直接 kill 子进程再起新的（PID 变化 = 真实重载语义），不需要伪造。
- **场景**：MW-1…MW-7（见各 P4 条目），每条都要有变异测试（把守卫改回旧行为 → 该场景必须转红 → 恢复 → 转绿），结果写进 `test/BEHAVIOR_CONTRACT.md`（新增 MW 系列行 + §11 套件清单）。
- **回归基线**：现有 6 个套件必须全绿（`scenario-simulation.js` 18、`queue-display-simulation.js` 100、`integration-scenarios.js` 157、`real-code-intrawindow.js` 14、`real-code-webview.js` 10、`test/mcp-scenarios.py` 50 = **349 passed / 0 failed**）。

---

## 6. 交付顺序与工作量（v2）

| 步骤 | 内容 | 量 |
|---|---|---|
| 1 | `FEEDBACK_GATE_TMPDIR` 注入（扩展 + MCP），默认不变 | 小 |
| 2 | harness 骨架 + **先跑出 MW-2 / MW-5 的红色复现**（证明能重现 1.2 与 1.3） | 中 |
| 3 | **P4-1**（ack EH 判活 + 3 次上限 + 快速失败）→ MW-1/2/3 绿 + 变异测试 | 小-中 |
| 4 | **P4-2**（领养不上就退回/留痕 + 统一 discard 日志 + 延迟重扫）→ MW-4/5/6 绿 | 中 |
| 5 | **P4-3**（sid 匹配加工作区校验）+ **P4-4**（日志修正）→ MW-7 绿 | 小 |
| 6 | 契约文档、版本 1.4.3、重打包 VSIX、`./install.sh`、提示 Reload Window | 小 |

步骤 3+4 就能消灭用户报的两个症状；5 是防御 + 可诊断性。总量比 v1 小很多（v1 的 6 项砍到 4 项，且没有一项改 agent 契约）。

---

## 7. 临时缓解（不改代码，现在就能用）

1. **解开正卡住的调用**：写 `/tmp/feedback_gate_response_fg_<tid>.json` = `{"response":"[EXPIRED] …","auto_response":true,"trigger_id":"<tid>"}` → MCP 立即返回（等价于系统 2h 后本来会做的事，只是提前）。
2. **捞回被搁置的排队消息**：把 `feedback_gate_queue_<wsId>_pid<旧EH>.json` 里的 pending 项，复制进当前 EH 的同名队列文件（保留 `sessionId`，`sessionKey` 留空即可走领养路径），然后在该对话里让 agent 再调一次 gate。
3. **习惯规避**：提问挂起期间**不要 Reload Window**；确需重载，重载后手动做一次第 2 步。
4. 我可以把 1、2 写成 `tools/unstick.sh`（只读现场 + 需显式确认才写），但**默认不做**——它会触碰用户现场状态。

---

## 8. 评审结论（2026-09-10，用户）

| 问题 | 用户答复 | v2 落实 |
|---|---|---|
| Q1 sid 是否服务端发号 | 「为什么要这么大改」 | **砍掉** P4-4a/4b |
| Q2 队列是否允许跨窗口交接 | 「队列为什么会跨窗口？跨 tab 都不要」 | **砍掉**跨窗口交接；P4-2 明确"只在同 workspaceId 内跨 PID 流转"；并新增 P4-3 从服务端堵死跨窗口取件 |
| Q3 孤儿 trigger 收尾 | 选定「快速失败 ~30s 返回 `[EXPIRED-ORPHAN]`」 | P4-1 第 3 点 |
| 开工范围 | 「先别开工，我再审文档」 | 本文档 v2；**未动任何代码** |
