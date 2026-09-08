# Feedback Gate — 正确行为验证清单 (Behavior Contract)

本文件定义 Feedback Gate 系统的**正确行为规范**。所有代码修改必须满足这些约束。
测试文件实现了对这些行为的自动化验证。

---

## 1. 核心交互流程

| # | 场景 | 期望行为 | 验证测试 |
|---|------|----------|----------|
| F1 | AI 调用 `feedback_gate_chat` | Trigger 文件写入 /tmp，extension 在 5s 内检测并消费 | E2E-1 |
| F2 | Extension 消费 trigger | 显示 agent 消息，UI 切换为"等待回复"状态 | E2E-1, MO-1 |
| F3 | 用户输入并发送 | Response 文件写入 /tmp，MCP 读取后返回给 AI | E2E-1, TF-2 |
| F4 | MCP 读取 response | trigger 从 `_active_triggers` 移除，session cooldown 启动 | TL-2, CD-1 |

## 2. 消息队列行为

| # | 场景 | 期望行为 | 验证测试 |
|---|------|----------|----------|
| Q1 | 用户在无 trigger 时输入 | 消息**只入队**，**不显示**在聊天区域 | G2-*, SB-2 |
| Q2 | Trigger 到达时队列有消息 | Auto-consume：agent 消息先显示，然后队列消息显示 | G3-*, MO-1 |
| Q3 | 多条消息排队 | 按 FIFO 顺序被逐个 trigger 消费 | E2E-3, G4-* |
| Q4 | 已显示的消息不重复显示 | `_displayed` 标记防止 auto-consume 二次添加 | MO-3, G10-* |
| Q5 | 不同 session 的队列互相隔离 | Session A 的 trigger 不消费 Session B 的消息；**同一窗口内以 `session_id` 为权威身份**（见 §11） | G7-*, G8-*, E2E-6, P3-1…P3-6, P3-19, QM-10…QM-12, **RC-1…RC-14（真实代码）** |
| Q6 | Reload/关闭后重开同 workspace | 仅迁移**已退出进程**的旧 PID 队列文件；pending 消息合并到新 PID，清空 sessionKey，删除旧文件；存活 PID 的文件不触碰 | QM-* |

## 3. Session 管理

| # | 场景 | 期望行为 | 验证测试 |
|---|------|----------|----------|
| S1 | 首次 trigger（无 session_id） | 创建新 session | S1 |
| S2 | 相同 PID + 无 trigger = 空闲 | 复用已有 session | S2 |
| S3 | 有 session_id 匹配已有 session | 直接定位到该 session（即使 PID 变了） | S13 |
| S4 | Session 有活跃 trigger 时新请求到达 | 创建新 tab（多 tab 并发） | S4, S14 |
| S5 | Reload 后 | Session 持久化到 globalState，reload 后恢复（mcpPid=0） | S7, S12, E2E-11 |
| S6 | MCP 重启（PID 变更） | Session 通过 session_id 重新绑定新 PID | S13, DC-2, E2E-12 |
| S7 | **同一窗口**第二个对话首次调用（已有 session 带 `session_id`） | 创建独立 session/tab，**绝不接管**已有对话（`SESSION_ID_ISOLATION`）；即使它没有 pending trigger、刚刚活跃过 | S3, S18, AD-7, AD-9 |
| S8 | 上下文压缩后 agent **复用同一** `session_id` | 命中原 session（身份匹配优先于任何新鲜度启发式，无 1h 限制） | S16 |
| S9 | 无 `session_id` 的旧式调用 + 唯一 session 尚无身份 | 仍可 adopt（向后兼容），stale trigger 照旧清理并写 `[EXPIRED]` | S5, S17, AD-1 |

## 4. Trigger 路由（多窗口）

| # | 场景 | 期望行为 | 验证测试 |
|---|------|----------|----------|
| R1 | Workspace 精确匹配 | 即使不聚焦也能 claim trigger | TR-1 |
| R2 | Workspace 不匹配 | 拒绝 claim | TR-2 |
| R3 | Session ownership | 优先级最高，**但当有精确 workspace 且不匹配时让出 3s；超时后 session owner 重新 claim** | TR-3, TR-3c |
| R4 | 无 workspace hint + 无 session owner（有 session_id） | 有已存 session 的窗口参与 race；空窗口延迟后参与 | TR-7, TR-8, TR-9, TR-10 |
| R4b | 无 workspace hint + 无 session owner（无 session_id） | 只有聚焦窗口 claim | TR-4, TR-5 |
| R5 | targetEhPid 不匹配 | 立即拒绝 | TR-6 |

## 5. Dead-PID 清理

| # | 场景 | 期望行为 | 验证测试 |
|---|------|----------|----------|
| D1 | 进程已死 + sessionId 不匹配 incoming trigger | 清理该 session | DC-1 |
| D2 | 进程已死 + sessionId **匹配** incoming trigger | **不清理**（保留给 PID hop） | DC-2 |
| D3 | mcpPid=0（恢复态） | 不清理（等待绑定） | DC-3 |
| D4 | 同 PID 为 trigger 发送方 | 不清理 | DC-4 |

## 6. Remote Control (IM 回复)

| # | 场景 | 期望行为 | 验证测试 |
|---|------|----------|----------|
| RM1 | session.pendingRemoteReply 存在 | 使用 session 级别的回复信息 | RO-1 |
| RM2 | session 无 reply，global 有 | 降级到 global | RO-2 |
| RM3 | agent 消息为空 | 不写入 outbox | RO-4 |
| RM4 | 消息超 500 字 | 截断 + 加省略提示 | RO-5 |
| RM5 | 写入后清空 reply 状态 | 一次消费原则 | RO-8 |

## 7. IDE Queue (远程消息路由)

| # | 场景 | 期望行为 | 验证测试 |
|---|------|----------|----------|
| IQ1 | Recovery 模式读取 | 跳过 ts 过滤（不丢消息） | IQ-1 |
| IQ2 | 正常模式 + ts < extensionActivatedAt | 丢弃为 stale | IQ-2 |
| IQ3 | Active session 有 trigger | 优先路由到 active session | IQ-4 |
| IQ4 | Active session 无 trigger | 路由到任意 pending session | IQ-5 |
| IQ5 | 无 pending session | 降级到 activeSessionKey | IQ-6 |

## 8. MCP Server 行为

| # | 场景 | 期望行为 | 验证测试 |
|---|------|----------|----------|
| M1 | 同 session 重复调用 | 旧 trigger 被驱逐，新 trigger 接管 | EV-1, MC-3, E2E-MCP-3 |
| M2 | Heartbeat 未超时 | 返回 WAITING，heartbeat_count++ | HB-1, HB-4 |
| M3 | Heartbeat 超过 max_total | 返回 TIMEOUT，清理 trigger | HB-3, E2E-MCP-2 |
| M4 | Trigger 被驱逐后心跳 | 返回 EVICTED（不再干扰新 trigger） | HB-2 |
| M4b | Heartbeat 发现 EH 已死 | 重写 trigger 文件（清除 target_eh_pid），让新 EH 有机会 claim | — (runtime) |
| M5 | IDE stale limit (24h) | 超过 24h 未响应的 trigger 被清理（可通过配置文件覆盖） | SC-2 |
| M6 | CLI stale limit (2min) | 超过 2min 未响应的 trigger 被清理 | SC-3 |
| M7 | Cooldown (2s) | 响应后 2s 内重复调用返回 SKIP | CD-1, CD-2 |
| M8 | 多 session 互不影响 | 不同 session 的 trigger 可并存 | MC-1, MC-2 |
| M9 | _active_triggers 上限 (20) | 超限时驱逐最旧的 trigger | EV-3 |

## 9. Queue UI 同步

| # | 场景 | 期望行为 | 验证测试 |
|---|------|----------|----------|
| SF1 | enqueueMessage 后 syncToWebview | 使用 item.sessionKey 过滤，新消息可见 | SF-1 |
| SF2 | 多条同 session 消息入队 | 全部在 syncToWebview 输出中可见 | SF-3 |
| SF3 | 不同 session 消息入队 | 仅最后入队的 session 消息在 sync 中可见 | SF-4 |
| SF4 | editQueueItem 后 syncToWebview | 使用编辑项的 sessionKey 过滤，更新后内容可见 | SF-5 |
| SF5 | enqueue 无 meta.sessionKey | 降级到 _activeSessionKey | SF-6 |

## 10. MCP 状态检测

| # | 场景 | 期望行为 | 验证测试 |
|---|------|----------|----------|
| MS1 | Log 文件 < 30s | mcpStatus = active | MS-1 |
| MS2 | Log > 30s + 无活进程 | mcpStatus = inactive | MS-2 |
| MS3 | Log > 30s + 有活进程 | mcpStatus = active | MS-3 |

## 11. 同一窗口多对话（Intra-Window Isolation, P3）

> 前提：**Cursor 每个窗口只运行一个 MCP 进程**，窗口内所有对话共享它。
> 因此 `mcpPid` / `triggerPid` **无法**区分同窗口的不同对话 —— `session_id`
> 是窗口内唯一的对话身份（`FeedbackGate.mdc`：一个对话 = 一个 session_id）。

| # | 场景 | 期望行为 | 验证测试 |
|---|------|----------|----------|
| IW1 | 对话 A 正在跑（无 pending trigger、输入在队列里），对话 B 首次 trigger 到达 | B 得到独立 session；A 的排队消息**一条都不许**被 B 消费；A 的 tab 标题/历史不变 | P3-19, AD-7, S18 |
| IW2 | 队列项带 `session_id`，与 trigger 的 `session_id` 不一致 | 拒绝消费 + `requeueItem` 归还给原对话，并打印 `⚠️ QUEUE_SESSION_MISMATCH`（auto-consume / post-route / drain 三条路径均生效） | P3-4, QM-12 |
| IW3 | 队列项或 trigger 缺 `session_id` | "无法证伪" → 允许消费（兼容旧队列项与不传 session_id 的 MCP 调用） | P3-1, P3-2, P3-3 |
| IW4 | 存在 untagged 残留消息，但另一对话仍有排队输入 | **不** auto-consume untagged（B 的首个 trigger 不许花掉无主残留） | P3-5, P3-6 |
| IW5 | 用户正在对话 A 输入，对话 B 的 trigger 到达 | **不自动切换 Tab**（`auto-switch … SUPPRESSED`），改为节流通知「查看该对话」，点击才切换；Tab 上的 pending 圆点照常显示 | P3-7, P3-9…P3-12 |
| IW6 | 用户手动点击 Tab | 始终允许切换（输入内容按 IW8 暂存） | P3-8 |
| IW7 | 发送时 webview 未带可用 `sessionKey` | 归属到**正在输入的对话**（`resolveSendSession`）；多 session 时打印 `⚠️ SEND_WITHOUT_SESSION_KEY` | P3-13…P3-15 |
| IW8 | 切换/关闭 Tab 时输入框有未发送内容 | 文本、图片附件、文件附件、代码引用**按对话**暂存并在切回时恢复（`_compositionStash`，上限 8 个对话，发送或关闭 Tab 即清除） | — (webview) |
| IW9 | 广播消息带 `sessionKey` 且不是当前可见对话 | webview **不渲染**（不串台）；无 `sessionKey` 的旧式广播仍然渲染 | P3-16…P3-18 |
| IW10 | 切换 Tab / 保存草稿 | 草稿归属"**离开的那个对话**"（`fromSessionKey`），而不是切换后的活动对话 | — (extension) |
| IW11 | 队列项入队 | 同时写入 `sessionKey`（窗口内 bucket）与 `sessionId`（对话身份），PID 队列迁移后 `sessionId` 必须保留 | QM-10, QM-11 |
| IW12 | 唯一 session 采纳 untagged 残留（`migrateSessionKey('', key)`） | 只采纳**无身份**或**身份一致**的残留；带其它对话 `session_id` 的残留保持 untagged，既不可见也不可被消费 | QM-13 |
| IW13 | 回复处理的晚期回调（P3-5） | `outputChannel` 只在 `activate()` 创建、`deactivate()` 释放；任何回复分支（含队列 drain 出来的回复）都不得因其为 null/已释放而抛错中断后续处理 | RC-8 |

> §11 的 IW1–IW13 由 `cursor-extension/test/real-code-intrawindow.js` 用**真实 `extension.js`**（附加测试 seam 后原样加载）驱动验证；IW5–IW11 的 webview 侧由 `cursor-extension/test/real-code-webview.js` 用**真实 `webview-template.js` 产出的内联脚本**（`vm` 原样执行 + 最小 DOM shim，经真实 `message` 路由驱动）验证。其余套件是逻辑镜像。改完必须全部跑。

---

## 运行全部验证

```bash
node cursor-extension/test/scenario-simulation.js \
  && node cursor-extension/test/queue-display-simulation.js \
  && node cursor-extension/test/integration-scenarios.js \
  && node cursor-extension/test/real-code-intrawindow.js \
  && node cursor-extension/test/real-code-webview.js \
  && python3 test/mcp-scenarios.py
```

全部通过 = 行为契约满足。任何修改后必须跑此命令。

`real-code-*.js` 与其它三个 JS 套件的区别：它们不复制逻辑，而是把线上文件**原样加载后驱动**——
`real-code-intrawindow.js` 加载 `extension.js`（附加测试 seam + 最小 `vscode` stub + 真实
`queue-manager`），直接调用 `setCurrentTriggerData` / `processQueueForPendingTrigger` /
`switchToSession` / `resolveSendSession`；`real-code-webview.js` 用 `vm` 执行
`webview-template.js` 产出的内联脚本，通过真实 `window.addEventListener('message')` 路由
投递 `loadSession` / `addMessage` / `syncTabs`，并触发真实 input 监听器。
两者都已通过**变异测试**：逐个关掉 P3-1 / P3-1b / P3-1c / P3-2 守卫（→ RC-1、RC-5~RC-9 变红）
与 webview 的 foreign 过滤 / 路由 stash / send 归属（→ WV-4、WV-6~WV-9 变红），
因此它们绿了才等于线上代码真的绿了。

---

## 变更规则

- 修改任何核心逻辑前，先确认相关行为测试存在
- 如果新行为需要改变上述契约，**必须先更新本文件**，再修改代码和测试
- 禁止为了让测试通过而弱化 assertion（必须修改代码而非测试）
