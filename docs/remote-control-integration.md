# Feedback Gate × cursor-remote-control 集成方案

## 背景

cursor-remote-control 通过 IM（飞书/钉钉/企微/微信）远程控制 Cursor Agent CLI。
CLI 运行时会自动调用 `feedback_gate_chat` MCP 工具（因全局 mcp.json + rules），
但 CLI 环境没有 VS Code 扩展监听，导致 feedback gate 超时。

本方案让 cursor-remote-control 接管 feedback gate 的反馈流程，
通过 IM 向用户收集反馈，再写 response 文件给 Python MCP 端。

## 交互流程

```
IM 用户           cursor-remote-control       Agent CLI           feedback-gate MCP
  │                      │                      │                      │
  │ ① 发送消息            │                      │                      │
  │─────────────────────>│                      │                      │
  │                      │ ② spawn agent CLI    │                      │
  │                      │─────────────────────>│                      │
  │                      │                      │ (执行任务...)          │
  │ ④ 进度卡片            │ ③ onProgress         │                      │
  │<─ ─ ─ ─ ─ ─ ─ ─ ─ ─│<─ ─ ─ ─ ─ ─ ─ ─ ─ ─│                      │
  │                      │                      │                      │
  │                      │                      │ ⑤ 调用               │
  │                      │                      │ feedback_gate_chat   │
  │                      │                      │─────────────────────>│
  │                      │                      │                      │ ⑥ 写 trigger 文件
  │                      │                      │                      │
  │                      │ ⑦ 轮询发现 trigger     │                      │
  │                      │ 写 ack 文件 ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─>│ ⑧ 读到 ack
  │                      │                      │                      │
  │ ⑨ 发 IM 消息          │                      │                      │
  │ "Agent 请求反馈:..."   │                      │                      │
  │<─────────────────────│                      │                      │
  │                      │                      │                      │
  │ ⑩ 用户 IM 回复        │                      │                      │
  │─────────────────────>│                      │                      │
  │                      │ ⑪ 写 response 文件 ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─>│ ⑫ 读到 response
  │                      │                      │                      │
  │                      │                      │<─────────────────────│ ⑬ 返回用户回复
  │                      │                      │ ⑭ Agent 继续执行      │
```

## 需要修改的文件

### 1. shared/agent-executor.ts (~80 行)

新增 `TriggerFileWatcher`：
- Agent 进程启动后，并行轮询 `/tmp/feedback_gate_trigger_pid*.json`（每 500ms）
- 匹配当前 agent 进程相关的 MCP PID
- 读取 trigger 文件中的 message/title/context
- 写 ack 文件（通知 Python 端有人在处理）
- 调用 `onFeedbackRequested` 回调

新增 `AgentExecutorOptions` 字段：
```typescript
onFeedbackRequested?: (data: FeedbackRequest) => Promise<string>;

interface FeedbackRequest {
    triggerId: string;
    message: string;
    title: string;
    context: string;
    toolType: string;
}
```

### 2. 各 IM server.ts (~60 行/平台)

新增 `pendingFeedbackGates: Map<chatId, FeedbackGateInfo>`：
- 收到 `onFeedbackRequested` → 发 IM 消息/卡片给用户
- 在消息处理中检查是否有 pending feedback gate
- 用户回复 → resolve Promise → agent-executor 写 response 文件
- 超时处理（如 10 分钟无回复 → 自动回复 TASK_COMPLETE）

**关键：插入位置**

feedback gate 检查必须在 `busySessions` 检查**之前**，否则用户的反馈回复
会被当作新任务排队。在 `handleInner()` 中的位置：

```
handleInner() {
  1. pendingProjectSwitches 检查    ← 已有
  2. 媒体附件处理                     ← 已有
  3. 命令路由 commandHandler.route()  ← 已有
  4. ★ pendingFeedbackGate 检查     ← 新增（在命令之后、排队之前）
  5. busySessions / 排队逻辑         ← 已有
  6. runAgent                         ← 已有
}
```

代码模板：
```typescript
// feishu/server.ts handleInner() 中，命令路由之后、busySessions检查之前
const feedbackPending = pendingFeedbackGates.get(chatId);
if (feedbackPending && !prompt.startsWith('/')) {
    // 用户的普通消息作为 feedback 回复
    writeFeedbackResponse(feedbackPending.triggerId, text, feedbackPending.triggerPid);
    pendingFeedbackGates.delete(chatId);
    if (cardId) {
        await updateCard(cardId, `✅ 反馈已发送\n\n> ${text.slice(0, 100)}`);
    } else {
        await replyCard(messageId, `✅ 反馈已发送给 Agent`, { color: "green" });
    }
    return;  // 不进入 busySessions/runAgent 流程
}
```

**注意**：命令（如 /终止、/状态）会绕过 feedback gate 检查，正常执行。

### 3. feedback_gate_mcp.py

调整 SKIP 超时时间：
- 当前 5 秒无人消费 trigger → 返回 SKIP
- 改为通过环境变量控制：`FEEDBACK_GATE_TRIGGER_TIMEOUT`
- 默认 5 秒（VS Code 场景），设为 30 秒（CLI + remote-control 场景）

或更好的方案：只要 trigger 文件被删除（ack 已写），就继续等待，不 SKIP。

## trigger 文件格式

```json
{
    "timestamp": "2026-04-02T12:00:00",
    "system": "feedback-gate-v2",
    "editor": "cursor",
    "data": {
        "tool": "feedback_gate_chat",
        "message": "已完成代码重构，请检查以下修改...",
        "title": "Feedback Gate",
        "context": "工作摘要",
        "trigger_id": "chat_1712023456789"
    },
    "pid": 12345,
    "ppid": 67890
}
```

## response 文件格式

```json
{
    "timestamp": "2026-04-02T12:01:00",
    "trigger_id": "chat_1712023456789",
    "user_input": "不错，继续下一步",
    "response": "不错，继续下一步",
    "message": "不错，继续下一步",
    "event_type": "MCP_RESPONSE",
    "source": "feedback_gate_remote_control"
}
```

## ack 文件格式

```json
{
    "acknowledged": true,
    "timestamp": "2026-04-02T12:00:01",
    "trigger_id": "chat_1712023456789",
    "extension": "cursor-remote-control",
    "popup_activated": true
}
```

## 多渠道多对话隔离

### 问题

当多个 IM 渠道/会话同时运行 Agent 时，trigger 文件缺少会话信息，
无法区分 feedback 应该发给哪个 IM 用户/群。

### 解决方案：环境变量注入

在 `agent-executor.ts` spawn 时注入会话标识：
```typescript
const env: AgentEnv = {
    ...process.env,
    FEEDBACK_GATE_CHAT_ID: options.chatId,       // IM 会话 ID
    FEEDBACK_GATE_PLATFORM: options.platform,     // 平台标识
    FEEDBACK_GATE_USER_ID: options.userId,        // 用户 ID
};
```

Python MCP 读取环境变量并写入 trigger 文件：
```python
trigger_data = {
    "data": data,
    "pid": self._server_pid,
    "routing": {
        "chat_id": os.environ.get("FEEDBACK_GATE_CHAT_ID", ""),
        "platform": os.environ.get("FEEDBACK_GATE_PLATFORM", ""),
        "user_id": os.environ.get("FEEDBACK_GATE_USER_ID", ""),
    }
}
```

cursor-remote-control 的 watcher 根据 routing 信息匹配正确的 IM 会话：
```typescript
// 只消费属于自己会话的 trigger
if (triggerData.routing?.chat_id === myChatId &&
    triggerData.routing?.platform === myPlatform) {
    // 处理此 feedback gate
}
```

### 隔离矩阵

| 场景 | 隔离依据 | 说明 |
|------|----------|------|
| 多平台 | `platform` | 飞书/钉钉/企微/微信各自独立 |
| 同平台多群 | `chat_id` | 每个群/对话有唯一 ID |
| 同群多任务 | `trigger_id` + agent PID | 每次 feedback gate 有唯一 trigger_id |
| 单用户多 workspace | `chat_id` + `trigger_id` | 同一用户不同 workspace 的任务分开 |

## 异常处理

| 场景 | 处理 |
|------|------|
| trigger 5s 无人消费 | Python 返回 SKIP（无 VS Code 也无 remote-control） |
| 用户 IM 长时间不回复 | 可配置超时（默认 10 分钟），超时后自动回复 TASK_COMPLETE |
| Agent 进程被 /终止 | trigger 文件残留，watcher 随进程结束停止，下次启动时清理 |
| 多个 workspace 并发 | 每个 agent 进程有独立的 MCP PID + routing 信息，不冲突 |
| 多渠道并发 | 通过 platform + chat_id 精确匹配，不会串话 |

## 已审查的潜在问题

### 1. trigger 文件竞争（VS Code 扩展 vs remote-control）
**风险**：两者同时运行时会抢同一个 trigger 文件。
**方案**：通过 `routing` 字段区分。有 routing 信息（chat_id/platform）的 trigger 由 remote-control 消费；没有 routing 的由 VS Code 扩展消费。Python MCP 根据环境变量决定是否写 routing。

### 2. MCP PID 获取
**问题**：remote-control 不知道 MCP 服务器的 PID，trigger 文件名包含 PID。
**方案**：用 glob 扫描 `/tmp/feedback_gate_trigger_pid*.json`，读每个文件检查 routing 信息匹配。

### 3. trigger 文件清理
**规则**：remote-control 消费 trigger 后**必须删除**。这样 Python MCP 的
"5 秒文件是否消失"检测才能正常工作。

### 4. response 文件格式
Python MCP 期望的最简格式：
```json
{
    "trigger_id": "chat_xxx",
    "user_input": "用户回复",
    "response": "用户回复"
}
```
支持可选字段：`attachments`、`files`、`message`、`event_type`、`source`。

### 5. Promise 链正确性
`runAgent` → `agentExecutor.execute()` 在 Agent CLI 进程结束时才 resolve。
feedback 回复直接写文件，不经过 runAgent/busySessions，无死锁风险。

### 6. busySessions 拦截问题（已记录修复方案）
feedback gate 检查必须在 busySessions 之前，见上方"关键：插入位置"。

### 7. IDLE_TIMEOUT 问题
agent-executor 的 5 分钟无输出超时会 kill 等待 feedback 的 Agent。
需要在 feedback gate 活跃时持续刷新 `lastOutputTime`。

### 8. withSessionLock
同一 workspace 同时只有一个 Agent 运行。feedback 回复不走 lock，
新任务会排队。无死锁但用户需知道新任务要等当前 Agent 结束。

## cursor-remote-control 兼容性审查结论

### 无冲突项
- 无 `FEEDBACK_GATE_*` 环境变量
- 无 `/tmp/feedback_gate_*` 文件操作
- 无 MCP 文件 watcher
- `AgentExecutor` 的 timer 结构清晰，加新轮询不影响现有逻辑
- `processLine()` 已有 `tool_call` 分支，扩展自然

### 需要注意的差异
1. **四个平台的消息处理结构不同**：
   - 飞书：`handleInner()` 函数 + `withSessionLock`
   - 钉钉：内联处理 + `withSessionLock`
   - 企微/微信：while 循环等待 `busySessions`
   - 每个平台的 feedback gate 集成需要适配
2. **精确插入点**：在命令路由、新闻调度、路由检测全部完成之后，`busySessions` 检查之前（飞书约第 2557 行之后）
3. **`pendingFeedbackGates` 应该用内存 Map**，不持久化（与 `pendingProjectSwitches` 不同）
4. **`bridge.ts`** 是另一个 Agent 路径，有不同的 idle timeout（10 分钟），需要单独考虑

### 不影响现有逻辑的保证
- 所有新增代码都是**追加式的**，不修改现有函数签名
- `AgentExecutorOptions` 新增的字段都是可选的
- 环境变量注入在现有 env 构建块之后追加
- feedback gate 检查是新的代码块，不修改已有的命令路由/排队逻辑
- 如果没有 `FEEDBACK_GATE_*` 环境变量，整个 feedback gate 路径不会被触发

## 实施进度

### 已完成（飞书平台）

| 文件 | 修改内容 | 状态 |
|------|---------|------|
| `feedback_gate_mcp.py` | 添加 routing 字段（从 FEEDBACK_GATE_CHAT_ID/PLATFORM 环境变量）；添加 FEEDBACK_GATE_MODEL 模型门控 | ✅ |
| `cursor-extension/extension.js` | 跳过带 routing 字段的 trigger 文件（避免 VS Code 和 remote-control 竞争） | ✅ |
| `shared/agent-executor.ts` | FeedbackGateRequest 接口；feedbackGate 配置注入环境变量；TriggerFileWatcher（500ms 轮询 /tmp）；feedbackGateActive 豁免 idle timeout；导出 writeFeedbackGateResponse/Ack 函数 | ✅ |
| `feishu/server.ts` | pendingFeedbackGates Map；onFeedbackRequested 回调（发飞书卡片+注册 pending）；handleInner 中拦截用户回复写 response 文件；execAgent/execAgentWithFallback/runAgent 传递 feedback gate 参数 | ✅ |

### 待完成

| 任务 | 说明 |
|------|------|
| 其他平台 server.ts | 钉钉/企微/微信的 feedback gate 适配（结构不同，需单独处理） |
| bridge.ts | 另一个 Agent 路径，有 10 分钟 idle timeout，需单独考虑 |
| 端到端测试 | 飞书环境实际测试 |

## 工作量估计

- ~~agent-executor.ts 改造（含 trigger watcher + idle 续命）：~2.5 小时~~ ✅
- ~~飞书 server.ts（pending + 卡片）：~1.5 小时~~ ✅
- ~~Python MCP 调整（routing + 环境变量）：~1 小时~~ ✅
- 其他平台 server.ts（需适配不同结构）：~1 小时/平台
- 测试：~1.5 小时
- **总计（仅飞书）：已完成代码，待测试**
- **总计（全平台）：约 4-5 小时（剩余）**
