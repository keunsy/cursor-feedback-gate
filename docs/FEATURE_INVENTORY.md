# Feedback Gate — 功能点全清单（重新确认用）

> 生成方式：从**代码 + 契约 + readme + .mdc** 反推，不依赖记忆。所有位置都给 `file:line`，所有阈值都给实测常量。
> 版本：扩展 `1.4.2`（`cursor-extension/package.json`）／MCP `feedback_gate_mcp.py` 1536 行／extension.js 3471 行／webview-template.js 1759 行。
> 用途：**请你逐节确认或纠正**。标 ❓ 的是我无法从代码判定意图、需要你拍板的；标 ⚠️ 的是已有现场证据的缺陷。

## 图例

| 标记 | 含义 |
|---|---|
| ✅ | 有**执行发布代码**的测试（`real-code-intrawindow.js` / `real-code-webview.js`），且通过变异测试 |
| 🟡 | 只有**镜像测试**（测试文件里另写了一份平行逻辑），绿了不等于发布代码对 |
| ❓ | **无任何测试覆盖** |
| ⚠️ | 已有现场证据的缺陷（见 `docs/P4-multiwindow-plan.md`） |
| 📝 | 文档/readme 与实现不符，或参数无实际效果 |

---

## 0. 先说覆盖度真相（这决定了下面每一行的可信度）

6 个测试套件，**只有 2 个真正执行发布代码**：

| 套件 | 条数 | 性质 | 证据 |
|---|---|---|---|
| `cursor-extension/test/real-code-intrawindow.js` | 14 | ✅ **真实代码**：把 `extension.js` 原样复制成 seam 后 `require`，并加载真实 `queue-manager.js`（`:151`） | 已做 4 组变异测试 |
| `cursor-extension/test/real-code-webview.js` | 10 | ✅ **真实代码**：用 `vm` 执行 `webview-template.js` 产出的内联脚本 | 已做 3 组变异测试 |
| `cursor-extension/test/scenario-simulation.js` | 18 | 🟡 镜像：自带 `createHarness()`（`:34`）、自写 `isProcessAlive`/`getTempPath` | 不 require 任何发布文件 |
| `cursor-extension/test/queue-display-simulation.js` | 100 | 🟡 镜像：自带 `createQueueManager()`（`:11`）、`createExtension()`（`:97`） | 同上 |
| `cursor-extension/test/integration-scenarios.js` | 157 | 🟡 镜像：自带 `createRoutingHarness()`（`:51`）等 76 个自定义函数 | 同上 |
| `test/mcp-scenarios.py` | 50 | 🟡 镜像：747 行里定义 `MockFeedbackGateState`，重写 `create_trigger`/`match_trigger_by_session`/`respond_to_trigger`/`heartbeat`/`clean_stale_triggers`/`evict_cap` | **全文没有 import 真实 `feedback_gate_mcp.py`**（该文件名只出现在第 3 行的注释里） |

由此得到三个必须承认的空白：

1. **`feedback_gate_mcp.py`（1536 行）真实代码覆盖率 = 0。** 今天已证的 R1 缺陷（孤儿 trigger 吊满 1 小时）就在这个文件里（`:1148-1161`），而 50 条 "M1–M10" 测试跑的是测试文件自己写的那份逻辑。
2. **多窗口 / 多进程维度真实代码覆盖率 = 0。** 路由（TR-*）、实例隔离（DC-*）、租约（P1-2）全是镜像；`session-lease.js` **连真实代码套件都没加载它**。
3. 所以"349 passed / 0 failed"证明的是**镜像自洽**，不是发布代码正确。这正是 v1 会误判 E2、R1 能长期存活的制度性原因。

> 这条也解释了 P4 方案里为什么坚持要建 `real-code-multiwindow.js`（真实 EH 子进程 + 真实 MCP 子进程）而不是再加镜像用例。

---

## A. Agent 接口层（MCP 工具）

工具只有**一个**：`feedback_gate_chat`（`mcp.py:341-380`）。

| # | 功能点 | 行为 | 位置 | 契约 | 状态 |
|---|---|---|---|---|---|
| A1 | `message` | 弹窗正文；`.mdc` 要求 ≤100 字（仅约定，代码不校验） | `mcp.py:355+` | — | 🟡 |
| A2 | `title` | 弹窗标题，默认 `Feedback Gate` | schema `:368-371` | — | ❓ |
| A3 | `context` | 附加上下文，"用于内部追踪，不展示给用户" | schema `:372-376` | — | ❓ **需确认：是否真的完全没展示？** |
| A4 | `urgent` | 📝 **被接收（`:697`）并写进 trigger（`:967`），但 extension.js / webview-template.js 里 0 次读取** → 传 true 无任何效果；recovery 重写时还会被硬置回 `False`（`:1177`） | `mcp.py:363-366` | — | 📝 **建议：要么实现（如高亮/置顶/通知），要么从 schema 删掉** |
| A5 | `session_id` | 对话身份；agent 首次生成 UUID、之后必须复用（`.mdc:62-72`） | `mcp.py:377-381` | S3/S7/S8 | ✅(扩展侧) 🟡(MCP侧) |
| A6 | `workspace_path` | 多窗口路由；实测 **412/412 次调用都带了值**，且都是真实单路径 | `mcp.py:382-386`, `:699-704` | R1/R2 | 🟡 |
| A7 | 返回用户文本 | 正常路径 | `mcp.py:1089-1099` | F3/F4 | 🟡 |
| A8 | 返回 `[WAITING]` | 一轮心跳超时后让 agent 重入 | `mcp.py:921-922` | M7/HB | 🟡 |
| A9 | 返回 `TASK_COMPLETE` | ①一键禁用时放行（`extension.js:2252`）②面板关闭时自动结束（`:1330`） | — | — | 🟡 |
| A10 | 返回 `[EXPIRED] …(2h cleanup)` | 扩展侧 2h 空闲清理写入 | `extension.js:596` | C16 | 🟡 |
| A11 | ⚠️ 缺少 `[EXPIRED-ORPHAN]` | 孤儿场景现在**静默返回**，agent 拿不到明确语义 | `mcp.py:1305` | — | ⚠️ R6（P4-1 待做） |
| A12 | 重入匹配 | 在**服务器全局** `_active_triggers` 里按 sid 精确匹配，第一个命中即用 | `mcp.py:746-752` | M-* | ⚠️ R8：**不校验 workspace**（今天 0 次碰撞，属潜在） |
| A13 | 同 sid 旧 trigger 驱逐 | `EVICT_SAME_SESSION`，响应转 stash | `mcp.py:770-778` | M-* | 🟡 |
| A14 | 延迟回复 stash / deliver | `_DELAYED_REPLY_TTL = 3600s`，超时丢弃 | `mcp.py:449` | STASH/DELIVER 事件 | 🟡 |
| A15 | 会话冷却 | `_SESSION_COOLDOWN_TTL = 3600` | `mcp.py:805` | CD1/CD2 | 🟡 |
| A16 | 活跃 trigger 上限 | `_MAX_ACTIVE_TRIGGERS = 20`，超限驱逐最旧 | `mcp.py:794`, `:794-801` | M-* | 🟡 |
| A17 | stale trigger 清理 | IDE `86400s`(24h) / CLI `120s` | `mcp.py:432-433` | M-* | 🟡 |
| A18 | 智能心跳 | 每 `wait_seconds`(默认 300s) 一轮；模式 `waiting`(继续等) / `user_response`(伪装用户回复，默认文案「当前时间」) | `mcp.py:621`, `:636-637` | M7/HB1-4 | 🟡 |
| A19 | 最大总等待 | IDE `3600s`(1h)；remote/CLI `86400s`(24h) | `mcp.py:622`, `:614-615` | M-* | 🟡 |
| A20 | remote/CLI 模式自动切换 | 检测到 routing file → `wait=50s`, `max=24h` | `mcp.py:184`, `:614-615`, `:735` | — | 🟡 |
| A21 | trigger 文件三写 | canonical `feedback_gate_trigger_fg_<tid>.json` + `…_pid<server_pid>.json` + legacy `feedback_gate_trigger.json` | `mcp.py:1013-1041` | F1 | 🟡 |
| A22 | ack 等待 | 15s；ack 里带 `extension_host_pid` → 学进 `_session_to_eh_pid[sid]` | `mcp.py:1046-1055` | M-* | ⚠️ R1 的污染源（P4-1 要把 ack pid 存进 trigger_info） |
| A23 | 消费窗口可配 | `FEEDBACK_GATE_TRIGGER_TIMEOUT`（秒，默认 **5**） | `mcp.py:1016-1020` | F1 | 🟡 |
| A24 | 配置热读 | `~/.cursor/feedback-gate-config.json` 每轮心跳重读，无需重启 | `mcp.py:626-655` | — | 🟡 |
| A25 | 调用取消处理 | `asyncio.CancelledError` → 记 CANCELLED 日志；`_current_trigger_var` 优先，避免误驱逐活 trigger | `mcp.py:400-425` | — | ❓ |
| A26 | pid 文件（供扩展发现 MCP） | 写 PPID / ancestor pids / `WORKSPACE_FOLDER_PATHS` | `mcp.py:319-329` | — | 🟡 |
| A27 | ⚠️ `ENTERED` 日志打全局 `_pending_trigger_id` | 并发下指向无关 trigger（v1 就是被它骗的） | `mcp.py:710-711` | — | ⚠️ R7（P4-4） |

---

## B. 弹窗与显示位置

| # | 功能点 | 行为 | 位置 | 状态 |
|---|---|---|---|---|
| B1 | 底部面板 panel（默认） | 与 Terminal 同级；`viewsContainers.panel` | `package.json` contributes | 🟡 |
| B2 | 侧边栏 sidebar | Activity Bar 图标入口（`sidebar-icon.svg`） | 同上 | 🟡 |
| B3 | 编辑器标签页 editor | 作为 editor tab 打开 | 同上 | 🟡 |
| B4 | 默认位置可配 | `feedbackGate.defaultLocation`：`panel`/`sidebar`/`editor`（enum + 中文说明） | `package.json` configuration | 🟡 |
| B5 | 触发时自动跳转 | Agent 触发 → reveal 到配置的默认位置 | `extension.js:876` | 🟡 |
| B6 | panel 注册失败降级 | → editor tab fallback（有日志） | `extension.js:1258` | ❓ |
| B7 | 手动打开命令 | `feedbackGate.openChat`（"Open Feedback Gate"，在命令面板） | `extension.js:1197` | ❓ |
| B8 | 多 webview 同步广播 | `broadcastToAllWebviews`：panel/sidebar/editor 同时开着时保持一致 | 多处 | 🟡 |
| B9 | MCP 连接状态指示 | `updateMcpStatus` → 未连接时输入框禁用 | `webview-template.js` router | 🟡 |
| B10 | webview ready 握手 | `ready` 消息 + 状态回放 | `extension.js` onDidReceiveMessage | ❓ |

---

## C. 对话与 Tab（会话身份）

| # | 功能点 | 行为 | 位置 | 契约 | 状态 |
|---|---|---|---|---|---|
| C1 | 多 Tab 并发对话 | 同窗口多个 agent 对话，各自独立 tab | `webview-template.js` tab UI | S4 | 🟡 |
| C2 | Tab 切换 | `switchSession`（webview→extension）+ `switchToSession` | `extension.js:428` 附近 | S-* | ✅ |
| C3 | Tab 关闭 | `closeSession` | router case | — | ❓ |
| C4 | Tab 同步 | `syncTabs`（标题、未读标记） | webview router | — | ✅ |
| C5 | 未读提示 + 抑制自动切换 | 用户正在别的 tab 打字时**不自动切走**，改为红点 + 节流通知「查看该对话」 | `extension.js:436`, `MANUAL_SWITCH_GUARD_MS=10s` | IW-* | ✅ |
| C6 | 新对话必开新 tab | `SESSION_ID_ISOLATION`：**绝不接管**已有对话（即使它无 pending trigger、刚刚活跃过） | `extension.js:307-330` | S7 | ✅ |
| C7 | sid 身份优先于新鲜度启发式 | 压缩后 agent 复用同 sid → 命中原 session，无 1h 限制 | — | S8/S16 | 🟡 |
| C8 | 无 sid 向后兼容 adopt | 旧式调用 + 唯一 session 尚无身份 → 可 adopt | `extension.js:307-330` | S9/AD-1 | 🟡 |
| C9 | 跨窗口同 sid 租约 | `session-lease.js`：持有者 30s 刷新、60s 过期；他窗让位 ≤3s | `session-lease.js:23-24` | P1-2 | ❓ **真实代码零覆盖** |
| C10 | 会话空闲 2h 休眠 | 全局无任何 trigger 达 2h → 注销 IDE 会话 + 系统消息「会话已闲置 2 小时自动休眠」 | `extension.js:27`, `:1948-1960` | S-* | 🟡 |
| C11 | trigger-less session 1h 清理 | 无 trigger 且 `age > 1h` → 移除 session | `extension.js:620-660` | S17 | 🟡 |
| C12 | 带 trigger 的 session 2h 清理 | 进程活着但 trigger 挂 2h → 写 `[EXPIRED]` 响应 + 系统消息 + 清 triggerData | `extension.js:563`, `:596` | S-* | 🟡 |
| C13 | 会话持久化 | globalState：每 session ≤200 条消息、≤30 个 session、≤7 天 | `extension.js:46-48` | S5 | 🟡 |
| C14 | reload 恢复 | session 恢复为 `mcpPid=0`（restored），等绑定 | — | S5/S12 | 🟡 |
| C15 | MCP 重启后重绑 | 按 sid 重新绑定新 PID | — | S6/DC-2 | 🟡 |
| C16 | 恢复态不误清 | `mcpPid=0` 有 1h 宽限（`restoredAt`） | `extension.js:620-628` | DC-3 | 🟡 |
| C17 | 未绑定 MCP 的 session 保护 | `age < 1h` 且 pid 不在 `boundMcpPids` → 跳过清理（可能属于别的窗口） | `extension.js:571-575` | — | ❓ |

---

## D. 输入与发送

| # | 功能点 | 行为 | 位置 | 状态 |
|---|---|---|---|---|
| D1 | Enter 发送 / Shift+Enter 换行 | `if (e.key === 'Enter' && !e.shiftKey && !e.isComposing)` | `webview-template.js:1364` | ✅(部分) |
| D2 | 中文输入法兼容 | 同上 `!e.isComposing`；候选词 Enter 不误发 | `:1364`, `:1565` | ✅ |
| D3 | 跨对话输入隔离 | `noteComposition` / `isComposingElsewhere`：别的对话正在打字时不抢发送 | `extension.js:436`, `COMPOSITION_STALE_MS=90s` | ✅ |
| D4 | 输入框状态色 | Agent 等待=绿边框；队列模式=蓝边框；MCP 未连接=禁用 | readme:44 + webview CSS | 🟡 |
| D5 | 草稿保存 | `saveDraft`（webview→extension） | router case | ❓ |
| D6 | 切 tab 时草稿暂存/恢复 | `_compositionStash`，**上限 8 条**，超限淘汰最旧；恢复时附件重新渲染为新 id | `webview-template.js:1586` | ✅ |
| D7 | 发送归属 | 消息携带 `sessionKey` → `resolveSendSession` 决定归属，不用"当前活动 tab"兜底 | `extension.js` send case | ✅ |
| D8 | 防重复发送 | `_sendLock` **300ms** | webview | ✅ |
| D9 | 外来会话消息过滤 | `isForeignSessionMessage`：不属于本 tab 的消息不渲染 | webview | ✅ |
| D10 | `inputSessionKey` 固定 | 输入框绑定到具体 session，不随活动 tab 漂移 | webview | ✅ |
| D11 | 📝 **没有"撤回/编辑已发消息"** | 代码里 `撤回` 0 命中 | — | 📝 确认：是否需要？ |

---

## E. 消息队列

| # | 功能点 | 行为 | 位置 | 契约 | 状态 |
|---|---|---|---|---|---|
| E1 | 无 trigger 时输入 → 只入队不显示 | 不在聊天区渲染 | `queue-manager.js:221` | Q1 | 🟡 |
| E2 | trigger 到达 → auto-consume | agent 消息先显示，再显示队列消息 | `extension.js:2343/2483/3117` | Q2 | 🟡 |
| E3 | FIFO 逐条消费 | 多条排队按序被逐个 trigger 消费 | — | Q3 | 🟡 |
| E4 | 已显示不重复 | `_displayed` 标记 | — | Q4 | 🟡 |
| E5 | 队列可视化 | `syncQueue` + `.queue-item`（20 处样式/结构） | webview | SB-* | 🟡 |
| E6 | 移动排序 | `moveQueueItem` / `reorderQueue` | router case | — | ❓ |
| E7 | 置顶 | `pinQueueItem` | router case | — | ❓ |
| E8 | 编辑队列项 | `editQueueItem` / `cancelEditQueueItem`（内联编辑器，Enter 提交见 `:1565`） | router case | — | ❓ |
| E9 | 删除队列项 | `removeQueueItem` | `queue-manager.js` | — | ❓ |
| E10 | 队列持久化分片 | `/tmp/feedback_gate_queue_<wsId>_pid<EH pid>.json` | `queue-manager.js:16-23` | Q6 | 🟡 |
| E11 | reload 迁移 | 仅迁移**已退出进程**的旧 PID 文件、仅同 wsId 前缀；`rename` → `.migrating.<pid>` 原子声明；**活 PID 跳过** | `queue-manager.js:38-60` | Q6 | 🟡 |
| E12 | 迁移后 untagged | `m._prevSessionKey = m.sessionKey; m.sessionKey = ''`；`sessionId` **刻意保留**（P3-1b 注释：唯一能跨 PID 存活的身份） | `queue-manager.js:78-86` | Q6/IW | ✅ |
| E13 | 消费按 sessionKey 精确匹配 | `dequeueMessage(sessionKey)` → untagged 项取不出，只能靠领养 | `queue-manager.js` | Q5 | ✅ |
| E14 | untagged 领养 | `migrateSessionKey('', key, queueItemBelongsToConversation)`：仅当本窗口没有别的对话在等输入时才领养 | `extension.js` setCurrentTriggerData | IW1-3 | ✅ |
| E15 | processing 卡死恢复 | `STALE_MS = 10s` → 回退 pending | `queue-manager.js:276` | QM-* | 🟡 |
| E16 | 附件随队列项持久化 | `enqueueMessage(text, attachments, files, meta)`，图片 base64 上限 **5MB** | `queue-manager.js:219-237` | — | ❓ |
| E17 | 等 trigger 再排空 | `waitForTriggerAndDrain`：30 次 × 500ms = 15s | `extension.js:3060-3070` | — | ❓ |
| E18 | ⚠️ **领养失败即静默丢弃** | 2h 清理丢掉 pending 项，**零日志零事件**（现场已丢一条真实用户输入） | `extension.js:561-620` | — | ⚠️ R3+R4（P4-2） |
| E19 | ⚠️ 迁移只在 init 跑一次 | 旧 EH 未死透时被跳过，且**不会重试** | `queue-manager.js:126` | — | ⚠️（P4-2 第 3 点：加 30s 延迟重扫） |

---

## F. 附件与代码引用

| # | 功能点 | 行为 | 位置 | 状态 |
|---|---|---|---|---|
| F1 | Cmd+V 粘贴截图 | → base64 内联；记 `IMAGE_PASTED` / `logPastedImage` | `extension.js:3395` 附近 | 🟡 |
| F2 | 拖入图片/文件/文件夹（Finder） | `dropFile` / `logDragDropImage` | router case | ❓ |
| F3 | Shift 从 Cursor 文件树拖入 | readme:41 声称支持 | — | ❓ **需确认真实可用** |
| F4 | 支持图片格式 | `.png .jpg .jpeg .gif .bmp .webp` | `extension.js:3395` | ❓ |
| F5 | 文件内联上限 **100KB** | 超限 → `[File too large: N KB]` 占位；拖拽超限记 `FILE_DROP_TOO_LARGE` | `extension.js:1437-1440`, `:3415-3417` | 🟡 |
| F6 | 附件移除 | `logImageRemoved` | router case | ❓ |
| F7 | 代码引用 | 选中代码 → 右键 "Add to Feedback Gate" / **`Cmd+Shift+G`**（`editorTextFocus && editorHasSelection`）→ 附文件路径+行号 | `extension.js:1209`, `package.json` menus+keybindings | ❓ |
| F8 | 附件在 webview 回显 | `imageUploaded` / `fileAttached` 推送 | extension→webview commands | ✅(部分) |

---

## G. 多窗口路由与认领

| # | 功能点 | 行为 | 位置 | 契约 | 状态 |
|---|---|---|---|---|---|
| G1 | 实例隔离 | ppid / ancestor / sibling 判定，非本实例的 trigger 直接跳过 | `extension.js:2016-2031` | DC-* | 🟡 |
| G2 | Signal 0.5 租约让位 | 他窗持有活租约 → 让位，**最长 3s**（防僵尸持有者） | `extension.js:2033-2062` | P1-2 | ❓ |
| G3 | Signal 1 目标 EH | `target_extension_host_pid` 活着 → 拒绝认领；死了 → 拥有该 sid 的窗口认领 | `extension.js:2066-2107` | R5/TR-6 | 🟡 |
| G4 | E10 聚焦窗口孤儿采纳 | 无人 own 且 `triggerAge ≥ 2s` 且本窗口当前聚焦 → 采纳 | `extension.js:2066-2107` | E10 | 🟡 |
| G5 | Signal 2 sid 所有权 | own && ws 不匹配 → 让位 3s 后重新认领；!own && ws 匹配 → 参与竞争；!own && !match → 拒绝 | `extension.js:2114-2170` | R3 | 🟡 |
| G6 | 工作区亲和 | `wsPrecise = triggerWorkspace && !includes(',')`；精确匹配可**不聚焦**认领 | `extension.js:2110-2112` | R1/R2 | 🟡 |
| G7 | 无 ws + 无 sid | **只有聚焦窗口**认领 | `extension.js:2114-2170` | R4b/TR-4,5 | 🟡 |
| G8 | 无 ws + 有 sid | 有已存 session 的窗口参与 race；空窗口延迟 **4s** 后参与 | `extension.js:2148-2155` | R4/TR-7..10 | 🟡 |
| G9 | **原子抢占（唯一去重点）** | `fs.unlinkSync(canonicalPath)` 成功者独占 → `CLAIMED` | `extension.js:2200-2234` | — | 🟡 |
| G10 | MCP PID 绑定 | `boundMcpPids`：pid 文件 + legacy 兜底（无 PPID 时 fallback 绑定） | `extension.js:1643`, `:2172-2192` | — | 🟡 |
| G11 | ⚠️ **零真实多窗口测试** | 上面 G1–G10 全部只有镜像覆盖 | — | — | ⚠️（P4-5 harness） |
| G12 | ⚠️ 服务端 sid 匹配不校验 workspace | 若两窗口 agent 编出同一 sid → B 窗口 re-enter 取走 A 窗口回答 | `mcp.py:746-752` | — | ⚠️ R8（P4-3，今天 0 次碰撞） |

---

## H. 孤儿、恢复与超时兜底

| # | 功能点 | 行为 | 位置 | 状态 |
|---|---|---|---|---|
| H1 | ack 文件 | 认领后写 `feedback_gate_ack_<tid>.json`（含 `extension_host_pid`） | `extension.js:2713` | 🟡 |
| H2 | 孤儿 trigger 重写 | 每 10s 探测；EH 死 → 清 `target_extension_host_pid`、重写 3 个 trigger 文件（`recovery: true`）、记 `TRIGGER_RECOVERY` | `mcp.py:1136-1215`, `:1271/1291-1294` | 🟡 |
| H3 | ⚠️ **判活依据错** | 问的是"这个**会话**还有活窗口吗"（`_session_to_eh_pid[sid]`），不是"**显示过这个提问的进程**还活着吗"；窗口重载后新 EH 把映射刷成活的 → **永不恢复** | `mcp.py:1148-1161` + `:831/885/1052` | ⚠️ R1（现场吊满 1h，P4-1） |
| H4 | ⚠️ 无恢复上限、无快速失败 | 一直重试到 `max_total_seconds` 才静默返回 | `mcp.py:1252-1305` | ⚠️ R6（P4-1：3 次≈30s → `[EXPIRED-ORPHAN]`） |
| H5 | 扩展侧 2h 兜底 | 写 `[EXPIRED]` + 系统消息（见 C12） | `extension.js:563-612` | 🟡 |
| H6 | MCP 侧 24h 兜底 | `TRIGGER_EXPIRED`（IDE 模式） | `mcp.py:432`, `:780-792` | 🟡 |
| H7 | 僵尸 trigger 移除 | `ZOMBIE_TRIGGER_REMOVED` 事件 | events 日志 | ❓ |
| H8 | ❓ 无 trigger 堆积观测 | 现场 `active=3` 长期保持，无 `TRIGGER_PILEUP` 类事件 | — | ❓（P4-6 可选） |

---

## I. 远程控制（IM）集成

依赖外部项目 [cursor-remote-control](https://github.com/keunsy/cursor-remote-control)；`/ide` 指令本身在那边实现，本项目负责**消费与回传**。

| # | 功能点 | 行为 | 位置 | 契约 | 状态 |
|---|---|---|---|---|---|
| I1 | remote 模式自动识别 | 存在 routing file → 心跳 50s / 上限 24h | `mcp.py:184`, `:614-615`, `:735` | — | 🟡 |
| I2 | IDE 队列文件 | `feedback_gate_ide_queue_<EH pid>.jsonl` + 全局 `feedback_gate_ide_queue.jsonl` | `extension.js:778-779` | IQ-* | 🟡 |
| I3 | 按租约精确投递到指定窗口 | 写 `feedback_gate_ide_queue_<lease.eh_pid>.jsonl` → readme 的"PID 路由，不串窗" | `extension.js:278` | IQ-* | ❓ |
| I4 | 过期保护 | 正常模式丢弃 `ts < extensionActivatedAt` 的消息；**recovery 模式跳过该过滤**（不丢消息） | `extension.js:1697` | IQ1/IQ2 | 🟡 |
| I5 | 路由优先级 | active session 有 trigger → 它；无 trigger → 任意 pending session；都没有 → `activeSessionKey` | `extension.js:1697-1760` | IQ3/IQ4/IQ5 | 🟡 |
| I6 | 会话注册/注销 | `registerIdeSession()`（认领 trigger 时）/ `unregisterIdeSession()`（2h 空闲、deactivate） | `extension.js:1834`, `:1856`, `:2241`, `:1953`, `:3452` | — | ❓ |
| I7 | IM 回传（outbox） | `session.pendingRemoteReply` 优先 → global 降级；**一次消费**后清空 | `extension.js:1811-1830` | RM1/RM2/RM5 | 🟡 |
| I8 | 回传内容截断 | agent 消息 > **500 字** → 截断 + 省略提示；空消息不写 outbox | `extension.js:1815-1816` | RM3/RM4 | 🟡 |
| I9 | 回传状态过期 | `pendingRemoteReply` **30 分钟**未用即丢弃 | `extension.js:1935-1937` | — | ❓ |
| I10 | 路由元信息透传 | `FEEDBACK_GATE_CHAT_ID` / `_PLATFORM` / `_SESSION` / `_MODEL` | `mcp.py:1323-1325`, `:938` | — | ❓ |

---

## J. 开关与状态栏

| # | 功能点 | 行为 | 位置 | 状态 |
|---|---|---|---|---|
| J1 | 状态栏指示 | 启用 `$(circle-filled) FeedBack` / 禁用 `$(circle-outline) FeedBack`（右对齐，priority 100） | `extension.js:1170-1176`, `:1297` | 🟡 |
| J2 | 点击一键开关 | `feedbackGate.toggle` → 取反 + 持久化 + 提示"已启用/已禁用（自动放行模式）" | `extension.js:1304-1310` | 🟡 |
| J3 | 📝 该命令**不在命令面板** | `feedbackGate.toggle` 已 `registerCommand` 但**未写进 `contributes.commands`** → 只能点状态栏 | `package.json` vs `extension.js:1304` | 📝 确认：是否要加进命令面板？ |
| J4 | 禁用时直接放行 | 不弹窗，写 `TASK_COMPLETE` 让 agent 继续 | `extension.js:2249-2260` | 🟡 |
| J5 | ⚠️ **未文档化：每月 1 号自动重新启用** | `getDate()===1 && getHours()>=12 && !enabled` → 强制启用 + 弹提示「Feedback Gate 已自动启用（每月 1 号定时恢复）」，按 `YYYY-M` 去重（每月一次） | `extension.js:1279-1295` | 📝 **readme 完全没提。确认：保留 / 删除 / 写进文档？** |
| J6 | ❓ 禁用期间的排队行为 | 禁用时用户输入是否仍入队、恢复后是否补投——代码未见明确处理 | — | ❓ 需确认预期 |

---

## K. 持久化与恢复

| # | 功能点 | 行为 | 位置 | 状态 |
|---|---|---|---|---|
| K1 | session 持久化到 globalState | ≤200 消息/session、≤30 session、≤7 天 | `extension.js:46-48` | 🟡 |
| K2 | reload 后恢复为 restored | `mcpPid=0`，1h 宽限，等待重新绑定 | `extension.js:620-628` | 🟡 |
| K3 | 队列跨 PID 迁移 | 见 E11/E12 | `queue-manager.js:38-86` | ✅/🟡 |
| K4 | ⚠️ trigger 不跨 reload 恢复 | 重载后旧 trigger 的 webview 状态消失，只能靠 MCP 侧重写（而 H3 让它失效） | — | ⚠️ R1 |

---

## L. 配置项与环境变量

| # | 名称 | 默认 | 作用 | 位置 |
|---|---|---|---|---|
| L1 | `feedbackGate.defaultLocation` | `panel` | 显示位置（panel/sidebar/editor） | `package.json` |
| L2 | `heartbeat_mode` | `waiting` | `waiting`=继续等；`user_response`=伪装用户回复 | `~/.cursor/feedback-gate-config.json`，`mcp.py:636` |
| L3 | `heartbeat_reply` | `当前时间` | `user_response` 模式的回复文案 | 同上 `:637` |
| L4 | `wait_seconds` | `300` | 单轮等待秒数（readme 建议 ≤3300） | `mcp.py:621` |
| L5 | `max_total_seconds` | `3600` | 跨心跳累计上限 | `mcp.py:622` |
| L6 | `stale_seconds` | IDE 86400 / CLI 120 | stale trigger 清理阈值 | `mcp.py:432-433` |
| L7 | `FEEDBACK_GATE_IDE_WAIT_SECONDS` | — | 环境变量覆盖 L4（**配置文件优先级更高**） | `mcp.py:620` |
| L8 | `FEEDBACK_GATE_HEARTBEAT_MODE` / `_REPLY` | — | 环境变量覆盖 L2/L3 | `mcp.py:636-637` |
| L9 | `FEEDBACK_GATE_TRIGGER_TIMEOUT` | `5`(秒) | 扩展消费 trigger 的窗口；CLI/远程可调大 | `mcp.py:1016-1020` |
| L10 | `FEEDBACK_GATE_ROUTING_FILE` | — | 远程/CLI 模式路由文件 | `mcp.py:184` |
| L11 | `FEEDBACK_GATE_CHAT_ID` / `_PLATFORM` / `_SESSION` / `_MODEL` | — | IM 回传路由元信息 | `mcp.py:1323-1325`, `:938` |
| L12 | ❓ `FEEDBACK_GATE_TMPDIR` | **不存在** | P4 拟新增：测试沙箱注入，默认仍 `/tmp`（生产零变化） | 待做 |

---

## M. 日志与诊断

| # | 文件/通道 | 内容 |
|---|---|---|
| M1 | `/tmp/feedback_gate.log` | MCP 全量日志，含 `🎯 CREATING trigger (id/ws/eh_pid/call_ws/cached_ws)`、`📍 Workspace from tool call`、`📥 [DIAG] ENTERED`、`🔄 RECOVERY` |
| M2 | `/tmp/feedback_gate_events.log` | 结构化事件 13 种：`ENTERED, NEW_TRIGGER, EVICT_ON_NEW_TRIGGER, EVICT_SAME_SESSION, HEARTBEAT, HEARTBEAT_SUPPRESSED, USER_RESPONSE, STASH_DELAYED_REPLY, DELIVER_DELAYED_REPLY, ZOMBIE_TRIGGER_REMOVED, TRIGGER_RECOVERY, TRIGGER_EXPIRED` |
| M3 | `/tmp/feedback_gate_user_inputs.log` | 用户侧：`QUEUED / MCP_RESPONSE / IMAGE_PASTED / FILE_DROPPED / FILE_DROP_TOO_LARGE`，**UTC**（本地 = UTC+8） |
| M4 | 扩展 Output 通道 | `⚠️ SESSION_ID_MISMATCH!`、`⚠️ DUPLICATE_SESSION_ID!`、`SESSION_ID_ISOLATION`、`⚠️ QUEUE_SESSION_MISMATCH`(±`(drain)`/`(post-route)`)、`⚠️ SEND_WITHOUT_SESSION_KEY`(±`(panel)`)、`auto-switch … SUPPRESSED`、`migrated N untagged message(s)`、`switched to session <key> (<label>) [manual\|auto]`、`CLAIMED trigger …`、`ROUTE sid=… own=… wsPrecise=… wsMatch=…`、`lease yield expired …` |
| M5 | ⚠️ 缺口 | 队列项被丢弃**无任何记录**（R4）；`ENTERED` 的 trigger 字段误导（R7）；`USER_RESPONSE` 不带 `resp_eh/resp_ws`，判断是否跨窗口作答要交叉 4 个文件 |

---

## N. 安装与分发

| # | 功能点 | 行为 | 状态 |
|---|---|---|---|
| N1 | `install.sh` | venv + 依赖 + `~/.cursor/mcp.json` 配置 + 删旧 VSIX + `vsce package --no-dependencies` + `cursor --install-extension --force` + 部署 `.mdc` 到 `~/.cursor/rules/` | ✅ 本机已装 1.4.2（`extensions.json` 校验过；`.mdc` 与 MCP 文件与仓库字节一致） |
| N2 | ⚠️ 装完必须 Reload Window | 扩展宿主与 MCP 进程都会保留旧代码；不 reload = 白装（曾导致"修了还有问题"的误判） | 📝 readme 只说"Reload Cursor 窗口即可使用"，未强调**必须** |
| N3 | ⚠️ `update.sh` 在本分支禁用 | 第 45 行 `git pull origin main` 会冲掉 `fix/feedback-gate-reliability` | 📝 需在文档里标注 |
| N4 | `uninstall.sh` | 卸载 | ❓ 未验证 |
| N5 | VSIX 产物 | `cursor-feedback-gate-1.4.2.vsix`（15 files, 116.46 KB），`*.vsix` 已 gitignore | ✅ |
| N6 | 📝 readme 版本号过期 | readme:25 写"当前版本（v1.2.x）"，实际 1.4.2；且"稳定性说明"仍建议"不需要多 Tab 就用早期稳定版本" | 📝 需更新 |

---

## O. 阈值总表（全部实测常量，便于确认"多久算超时"）

| 值 | 含义 | 位置 |
|---|---|---|
| 300ms | webview `_sendLock` 防重复发送 | webview |
| 500ms × 30 | `waitForTriggerAndDrain` 轮询（合计 15s） | `extension.js:3062-3063` |
| **5s** | MCP 等待扩展消费 trigger 的窗口（可配） | `mcp.py:1016-1020` |
| **10s** | ①孤儿恢复探测间隔 ②`recoverStaleProcessing` 回退阈值 ③手动切换保护 `MANUAL_SWITCH_GUARD_MS` | `mcp.py:1291`；`queue-manager.js:276`；`extension.js:428` |
| **15s** | 等 ack 超时 | `mcp.py:1046` |
| **2s** | E10 聚焦窗口采纳孤儿 trigger 的最小年龄 | `extension.js:2066-2107` |
| **3s** | 租约让位上限（Signal 0.5 / own-but-ws-mismatch） | `extension.js:2033-2062` |
| **4s** | 空窗口参与 race 前的延迟 | `extension.js:2148-2155` |
| **30s** | 租约刷新间隔 | `session-lease.js:24` |
| **60s** | ①租约过期 ②`cleanupStaleSessions` 节流 | `session-lease.js:23`；`extension.js` |
| **90s** | 跨对话 composition 过期 `COMPOSITION_STALE_MS` | `extension.js:436` |
| **120s** | CLI 模式 stale trigger | `mcp.py:432` |
| **300s** | IDE 单轮等待（心跳周期） | `mcp.py:621` |
| **30min** | `pendingRemoteReply` 过期 | `extension.js:1936` |
| **50s** | remote/CLI 单轮等待 | `mcp.py:614` |
| **1h** | ①`max_total_seconds`(IDE 总上限) ②trigger-less session 清理 ③restored session 宽限 ④`ADOPT_MAX_SESSION_AGE_MS` ⑤session cooldown TTL ⑥延迟回复 TTL | `mcp.py:622/805/449`；`extension.js:308/620-628` |
| **15min** | `ADOPT_STALE_TRIGGER_MS`（无 sid 时采纳陈旧 trigger 的门槛） | `extension.js:307` |
| **2h** | ①带 trigger 的 session 清理并写 `[EXPIRED]` ②全局空闲休眠 ③IDE 会话注销 | `extension.js:27/563/1948-1960` |
| **24h** | ①IDE stale trigger ②remote 总上限 | `mcp.py:433/615` |
| **7天** | 持久化 session 最长时间 | `extension.js:48` |
| 8 | 草稿暂存条数上限 | `webview-template.js:1586` |
| 20 | ①`_MAX_ACTIVE_TRIGGERS` ②每 session 持久化消息上限(200)/session 上限(30) 见 K1 | `mcp.py:794`；`extension.js:46-47` |
| 500 字 | IM 回传截断 | `extension.js:1815` |
| 100KB | 文件内联上限 | `extension.js:1437`, `:3415` |
| 5MB | 队列图片 base64 上限 | `queue-manager.js:219` |

---

## P. 文档承诺 vs 实测（**必须修正的 4 处**）

| readme 原文 | 实测 | 处置建议 |
|---|---|---|
| 「**多窗口隔离** — 每个 Cursor 窗口独立运行，**不会串窗**」(readme:40) | 串窗今天没有证据（0 次 sid 碰撞、0 次错投）；但**窗口重载后提问会吊满 1 小时**（R1，已现场复现），这条承诺给人的安全感是错的 | 改为"多窗口路由 + 已知限制（重载挂起）"，或等 P4-1 修完再保留原话 |
| 「**消息队列** — Agent 忙时发送的消息自动排队，**不会丢失**」(readme:37) | ⚠️ **已丢过**：`当前有什么可买的标的么`（11:29 入队，只有 `QUEUED`、永无 `MCP_RESPONSE`，14:21 文件已空，零日志） | P4-2 修完（退回输入框 + 留痕）之前，这句必须加限定 |
| 「当前版本（**v1.2.x**）」+「如果你不需要多 Tab 支持，建议使用**早期稳定版本**」(readme:25-30) | 实际 `1.4.2`；多 Tab 已由 P3 波次做了真实代码验证（RC/WV 24 条） | 更新版本号与稳定性说明 |
| 「安装后 **Reload Cursor 窗口即可使用**」(readme:57) | Reload 是**强制**步骤，不是"即可"——不 reload 会继续跑旧代码（已造成过一次"修了还有问题"的误判） | 改成"必须 Reload Window（或重启 Cursor），否则扩展宿主与 MCP 仍运行旧代码" |

另外 `update.sh` 会 `git pull origin main`（`:45`），在当前分支上等于自毁——readme 未提，建议在 N3 位置加警告。

---

## Q. 需要你拍板的 9 个问题

| # | 问题 | 我的建议 |
|---|---|---|
| Q1 | `urgent` 参数（A4）**完全没实现**，留还是删？ | 删掉，或实现为"弹窗标题加 🔴 + 系统通知" |
| Q2 | `context` 参数（A3）是否真的完全不展示给用户？ | 需要你确认原始意图 |
| Q3 | **每月 1 号 12:00 后自动重新启用**（J5）是你有意加的吗？它会覆盖用户的一键关闭 | 若无明确理由 → 删除；若保留 → 写进 readme |
| Q4 | `feedbackGate.toggle` 要不要进命令面板（J3）？ | 建议进（便于键盘党），一行 `contributes.commands` |
| Q5 | 禁用期间的输入应不应该入队、恢复后补投（J6）？ | 建议：禁用时**不入队**并明确提示，避免"以为发了其实没发" |
| Q6 | Shift 从 Cursor 文件树拖入（F3）现在还能用吗？ | 需要你实测确认；不能用就从 readme 删 |
| Q7 | 队列的排序/置顶/编辑/删除（E6–E9）**零测试**，要不要纳入本轮真实代码覆盖？ | 建议至少纳入删除+置顶（数据丢失风险最高） |
| Q8 | readme 的 4 处不符（P 节）现在就改，还是等 P4 修完一起改？ | 建议**现在改**（诚实优先），P4 修完再改回正面表述 |
| Q9 | MCP 侧真实代码测试（0 覆盖）要不要作为 P4 的一部分补上？ | **强烈建议**：`real-code-mcp.js`/`pytest` 直接驱动真实 `feedback_gate_mcp.py` 子进程，否则 R1 这类缺陷还会再来 |

---

## R. 与 P4 方案的对应关系

| 已证缺陷 | 影响的功能点 | P4 条目 |
|---|---|---|
| R1 判活依据错 | H2/H3/K4/A22 | **P4-1** |
| R3 领养失败即丢 | E12–E14/E18 | **P4-2** |
| R4 丢弃零日志 | E18/M5 | **P4-2** |
| R6 无快速失败 | A11/H4 | **P4-1**（你已选 ~30s `[EXPIRED-ORPHAN]`） |
| R7 日志误导 | A27/M5 | **P4-4** |
| R8 sid 全局匹配 | A12/G12 | **P4-3** |
| 覆盖度空白（§0） | 全部 🟡/❓ 行 | **P4-5**（多窗口真实代码 harness）+ Q9（MCP 真实代码套件） |
