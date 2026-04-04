# /ide 指令入队方案

## 概述

在 cursor-remote-control 的 IM 端（飞书/钉钉等）新增 `/ide` 指令，允许用户从 IM 直接向 Cursor IDE 的 Feedback Gate 队列投递消息。Agent 下次调用 `feedback_gate_chat` 时自动出队处理。

## 动机

当前使用 Feedback Gate 的两种场景：
1. **IDE 本地** — 用户在 Cursor 界面直接输入
2. **IM 远程** — 用户通过飞书/钉钉发消息，经 Agent CLI 处理

缺少的场景：**用户在 IM 端向本地 IDE 的 Agent 发送追加指令**。例如在飞书看到 Agent 正在工作，想追加一条"顺便看下性能"，但当前只能切到 IDE 手动输入。

## 架构

```
飞书/钉钉用户
       │
       │  "/ide 帮我检查代码"
       ▼
┌──────────────────────────┐
│  cursor-remote-control   │
│  CommandHandler.route()  │
│  匹配 /ide 指令          │
└──────────┬───────────────┘
           │
           │ 追加写入 (append)
           ▼
  /tmp/feedback_gate_ide_queue.jsonl     ← 全局 IDE 队列，JSONL 格式
           │
           │    Extension 250ms 轮询
           ▼
┌──────────────────────────────────┐
│  Cursor Extension                │
│  检测到 ide_queue → rename 为    │
│  .processing（原子操作）         │
│  → 逐行解析                     │
│  → queue.enqueueMessage()        │
│  → 删除 .processing             │
│  → UI 显示入队通知              │
└──────────┬───────────────────────┘
           │
           │  等 Agent 调用 feedback_gate_chat
           ▼
┌──────────────────────────────────┐
│  Agent 触发 → 队列非空           │
│  → 自动出队 → 写 response       │
│  → MCP 返回给 Agent             │
└──────────────────────────────────┘
```

## IDE 队列文件设计

### 路径

```
/tmp/feedback_gate_ide_queue_{pid}.jsonl     ← PID-specific 队列（推荐）
/tmp/feedback_gate_ide_queue.jsonl           ← 全局队列（向后兼容）
/tmp/feedback_gate_session_{pid}.json        ← Extension 会话注册文件
```

### 格式

JSONL（每行一条 JSON），支持多进程安全追加：

```jsonl
{"id":"inbox_1775302000123","text":"帮我检查代码","source":"feishu","chatId":"oc_xxx","ts":"2026-04-04T19:45:00.000Z"}
{"id":"inbox_1775302005456","text":"顺便看下性能","source":"feishu","chatId":"oc_xxx","ts":"2026-04-04T19:45:05.000Z"}
```

### 字段说明

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| id | string | 是 | 唯一标识，格式 `inbox_{timestamp_ms}` |
| text | string | 是 | 消息内容 |
| source | string | 是 | 来源平台：feishu / dingtalk / wecom / wechat |
| chatId | string | 否 | IM 会话 ID，用于回执 |
| ts | string | 是 | ISO 8601 时间戳 |

### 为什么用 JSONL

- **追加安全**：`fs.appendFileSync` 对短行（< 4KB）在大多数 OS 上是原子的
- **无读-改-写竞争**：不需要先读取 JSON 数组再追加
- **消费简单**：rename → 逐行读取 → 删除

## 指令设计

### 语法

```
/ide                          显示帮助 + 活跃实例列表
/ide <消息内容>                投递到唯一实例（多实例时提示选择）
/ide #序号 <消息内容>          按序号指定窗口投递
/ide #PID <消息内容>           按 PID 指定窗口投递
```

### IM 回复

投递前通过检测 `/tmp/feedback_gate_mcp_*.pid` 文件并验证对应进程是否存活（`process.kill(pid, 0)`），判断是否有活跃的 Feedback Gate MCP 进程。**无活跃进程时拒绝写入，从源头避免无效消息积压。**

投递成功（显示项目名和 PID）：
```
✅ 已投递到 IDE 队列

📝 帮我检查代码
🕐 19:45:00
🖥️ cursor-feedback-gate (PID 12345)

当 Agent 下次调用时将自动出队处理
```

多实例未指定目标（提示选择）：
```
⚠️ 检测到多个活跃实例，请指定目标:

🖥️ 活跃实例:
  1. cursor-feedback-gate (PID 12345)
  2. my-project (PID 67890)

用法: /ide #序号 帮我检查代码
```

无活跃 Feedback Gate（拒绝写入）：
```
❌ 当前没有活跃的 Feedback Gate，消息未投递

请先在 Cursor 中启动 Feedback Gate 后再试
```

无参数（显示帮助 + 实例列表）：
```
📋 /ide 指令用法

/ide <消息> — 投递到唯一实例或选择
/ide #序号 <消息> — 指定窗口
/ide #PID <消息> — 按 PID 指定

🖥️ 活跃实例:
  1. cursor-feedback-gate (PID 12345)
```

## 多窗口行为

### PID 路由（已实现）

每个 Extension 实例使用独立的 PID-specific 队列文件（`feedback_gate_ide_queue_{pid}.jsonl`），消除多窗口竞争。

**会话注册**：Extension 启动时写 `/tmp/feedback_gate_session_{pid}.json`：
```json
{"pid": 12345, "project": "my-project", "cwd": "/home/user/projects/my-project", "ts": "2026-04-04T12:00:00Z"}
```

**消息路由**：`cursor-remote-control` 读取所有 session 文件获取活跃实例列表，用户通过 `#序号` 或 `#PID` 指定目标。

**向后兼容**：Extension 同时轮询全局文件 `feedback_gate_ide_queue.jsonl`，确保旧版本的消息也能被消费。

**消费逻辑**：
1. 检测 PID-specific 队列文件和全局队列文件
2. `fs.renameSync` 原子重命名抢占消费权
3. 逐行读取，过滤掉 Extension 启动前的旧消息（`extensionActivatedAt` 时间戳）
4. 入队 + 删除 processing 文件

**清理**：Extension 停止时清理 session 文件和 PID-specific 队列文件。

## 改动范围

### cursor-remote-control

**文件**: `shared/command-handler.ts`

新增 `/ide` 指令匹配和处理：

注意：`PlatformAdapter` 接口只有 `reply()`、`replyStream?()`、`sendFile?()` 方法，没有 `chatId` 和 `platform` 属性。`platform` 在 `CommandContext` 上（`this.ctx.platform`），`chatId` 需要从各平台 server 传入。

**方案**：`route()` 方法签名增加可选 `options` 参数：

```typescript
// route() 签名修改
async route(
    text: string,
    updateSessionCallback?: (sessionId: string) => void,
    options?: { chatId?: string }
): Promise<boolean> {
    // ...
}

// 各平台调用时传入 chatId
const handled = await commandHandler.route(text, (newSessionId) => { ... }, { chatId });

// route() 中新增匹配
if (/^\/ide\b/i.test(text)) {
    return this.handleIde(text, options?.chatId);
}

// 新方法
private async handleIde(text: string, chatId?: string): Promise<boolean> {
    const content = text.replace(/^\/ide\s*/i, '').trim();
    if (!content) {
        await this.adapter.reply('📋 /ide 指令用法\n\n/ide <消息> — 投递消息到 IDE 队列');
        return true;
    }
    
    const tmpDir = process.platform === 'win32'
        ? (process.env.TEMP || process.env.TMP || 'C:\\Temp')
        : '/tmp';
	const ideQueuePath = resolve(tmpDir, 'feedback_gate_ide_queue.jsonl');
    
    const entry = JSON.stringify({
        id: `inbox_${Date.now()}`,
        text: content,
        source: this.ctx.platform,
        chatId: chatId || '',
        ts: new Date().toISOString()
    });
    
    try {
        appendFileSync(ideQueuePath, entry + '\n');
        
        // 检测是否有活跃的 Feedback Gate MCP 进程
        const hasMcp = readdirSync(tmpDir).some(
            f => f.startsWith('feedback_gate_mcp_') && f.endsWith('.pid')
        );
        
        if (hasMcp) {
            await this.adapter.reply(`✅ 已投递到 IDE 队列\n\n📝 ${content}\n\n当 Agent 下次调用时将自动出队处理`);
        } else {
            await this.adapter.reply(`⚠️ 已投递到 IDE 队列，但当前未检测到活跃的 Feedback Gate\n\n📝 ${content}\n\n消息已保存，打开 Cursor 后会自动入队`);
        }
    } catch (e) {
        await this.adapter.reply(`❌ IDE 队列投递失败: ${(e as Error).message}`);
    }
    return true;
}
```

### cursor-feedback-gate

**文件**: `cursor-extension/extension.js`

在 `startFeedbackGateIntegration` 的 250ms 轮询中增加 IDE 队列检测：

```javascript
// 在现有 checkTriggerFile 之后增加
checkIdeQueueFile();
```

新增 `checkIdeQueueFile` 函数和启动恢复逻辑：

```javascript
const IDE_QUEUE_PATH = getTempPath('feedback_gate_ide_queue.jsonl');
const IDE_QUEUE_PROCESSING_PATH = IDE_QUEUE_PATH + '.processing';

// 来源标签映射
const SOURCE_LABELS = {
    feishu: '飞书',
    dingtalk: '钉钉',
    wecom: '企微',
    wechat: '微信',
};

// 在 activate() 中调用，恢复 Extension 崩溃后的残留 .processing 文件
function recoverIdeQueueProcessing() {
    try {
        if (fs.existsSync(IDE_QUEUE_PROCESSING_PATH)) {
            consumeIdeQueueFile(IDE_QUEUE_PROCESSING_PATH);
        }
    } catch {}
}

// 在 250ms 轮询中调用
function checkIdeQueueFile() {
    try {
        if (!fs.existsSync(IDE_QUEUE_PATH)) return;
        
        // 原子抢占：rename 成功则获得消费权
        fs.renameSync(IDE_QUEUE_PATH, IDE_QUEUE_PROCESSING_PATH);
    } catch {
        return; // 文件不存在或被其他窗口抢走了
    }
    
    consumeIdeQueueFile(IDE_QUEUE_PROCESSING_PATH);
}

function consumeIdeQueueFile(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n').filter(l => l.trim());
        let count = 0;
        
        for (const line of lines) {
            try {
                const item = JSON.parse(line);
                if (item.text) {
                    // 入队时携带来源信息，用于 UI 显示
                    enqueueMessage(item.text, [], [], {
                        source: item.source,
                        sourceLabel: SOURCE_LABELS[item.source] || item.source
                    });
                    count++;

                    // 入队时在面板显示来源标识
                    const label = SOURCE_LABELS[item.source] || item.source || '远程';
                    postToWebview({
                        command: 'addMessage',
                        text: `📨 来自${label}的消息已入队: ${item.text}`,
                        type: 'system',
                        plain: true
                    });
                }
            } catch {}
        }
        
        fs.unlinkSync(filePath);
    } catch (e) {
        try { fs.unlinkSync(filePath); } catch {}
    }
}
```

**queue-manager.js 改动**：`enqueueMessage` 增加可选的 `meta` 参数，保存来源信息到队列 item：

```javascript
function enqueueMessage(text, attachments, files, meta) {
    // ... 现有逻辑 ...
    const item = {
        id: generateId(),
        text: text,
        attachments: safeAttachments,
        files: files || [],
        status: 'pending',
        timestamp: new Date().toISOString(),
        // 来源信息（来自 /ide 入队时携带）
        source: meta?.source || 'local',
        sourceLabel: meta?.sourceLabel || ''
    };
    // ...
}
```

**出队时显示来源**：在 `checkTriggerFile` 的队列自动出队部分，显示来源标识：

```javascript
// 替换现有的 "⚡ 已从队列自动发送"
const sourceTag = queueItem.sourceLabel
    ? `⚡ 已从队列自动发送（来自${queueItem.sourceLabel}）`
    : '⚡ 已从队列自动发送';
postToWebview({
    command: 'addMessage',
    text: sourceTag,
    type: 'system',
    plain: true
});
```

**效果**：

```
面板显示:
  📨 来自飞书的消息已入队: 帮我检查代码
  ...
  ⚡ 已从队列自动发送（来自飞书）
  Agent: 代码检查完毕...

面板本地输入:
  ⚡ 已从队列自动发送          ← 无来源标记
```

**文件**: `feedback_gate_mcp.py`

无需改动。

### 改动量估算

| 文件 | 新增行数 | 修改行数 |
|------|----------|----------|
| command-handler.ts | ~40 | ~5（route 签名加 options 参数） |
| extension.js | ~55 | ~8（轮询加调用 + 出队来源标记 + activate 加恢复） |
| queue-manager.js | ~3 | ~2（enqueueMessage 加 meta 参数） |
| 各平台 server.ts (×4) | 0 | ~4（route 调用加 chatId） |
| **总计** | **~98** | **~19** |

## 异常场景

| 场景 | 行为 |
|------|------|
| Cursor 未运行 | 检测到无存活的 pid 进程，拒绝写入，IM 提示"当前没有活跃的 Feedback Gate" |
| pid 文件残留（进程已死） | 通过 `process.kill(pid, 0)` 验证进程存活，死进程的 pid 文件不计入活跃判断 |
| Extension Reload 后存在历史积压 | Extension 记录启动时间戳 `extensionActivatedAt`，消费时丢弃早于该时间戳的消息 |
| 多窗口竞争 | rename 原子操作，只有一个窗口成功 |
| Extension 消费到一半崩溃 | .processing 文件残留，下次启动时重新消费 |
| IDE 队列文件过大 | 极端情况，每条约 200 字节，1000 条 = 200KB，不会有问题 |
| Agent 未在运行 | 消息入队等待，Agent 下次调用时出队 |
| macOS 重启 | /tmp 清理，IDE 队列丢失（无害，只是待投递消息） |
| 日志写入失败 | catch 后静默跳过，不影响主流程 |

## 不涉及的改动

- `feedback_gate_mcp.py` — 不改
- `queue-manager.js` 核心逻辑 — 不改
- trigger/response 文件通信 — 不改
- 现有 IM Feedback Gate 回调 — 不改
- 队列 UI 渲染 — 不改（入队消息在 UI 中与手动输入的一样显示）

## V2：双向反馈方案

### 目标

Agent 在 IDE 处理完 `/ide` 投递的消息后，将结果回传到发起者的 IM 会话。

### 核心思路

Extension 在读取 Agent 触发文件时已经知道两件事：
1. Agent 的回复内容（触发文件里的 message）
2. 最近出队消息的来源（queue item 的 source/chatId）

因此可以直接在 Extension 层判断并写 IDE reply 文件，**不需要改 MCP**。

### 架构

```
飞书用户              remote-control              Extension                Agent
  │                        │                          │                    │
  │  /ide 检查代码          │                          │                    │
  │─────────────────────► │                          │                    │
  │                        │ 写 ide_queue.jsonl       │                    │
  │  ✅ 已投递              │────────────────────────►│                    │
  │◄─────────────────────  │                          │ 入队 (带 chatId)   │
  │                        │                          │                    │
  │                        │                          │ Agent 调用          │
  │                        │                          │◄───────────────────│
  │                        │                          │ 出队 → response    │
  │                        │                          │ 记住来源 chatId    │
  │                        │                          │────────────────────►│
  │                        │                          │                    │
  │                        │                          │ Agent 回复结果      │
  │                        │                          │◄───────────────────│
  │                        │                          │ 有远程来源？→ 写   │
  │                        │                          │ ide_reply.jsonl     │
  │                        │ 轮询 ide_reply            │                    │
  │  📝 Agent: 没问题       │◄────────────────────────│                    │
  │◄─────────────────────  │                          │                    │
```

### IDE reply 文件设计

**路径**: `/tmp/feedback_gate_ide_reply.jsonl`

**格式**: JSONL，Extension 在 Agent 回复时追加：

```jsonl
{"chatId":"oc_xxx","platform":"feishu","agentMessage":"代码没问题，逻辑正确","ts":"2026-04-04T20:00:00Z"}
{"chatId":"oc_xxx","platform":"feishu","agentMessage":"已修复并提交","ts":"2026-04-04T20:02:00Z"}
```

### Extension 改动

**核心变量**：

```javascript
// 记录最近出队的远程消息来源，用于 Agent 回复时写 IDE reply
let pendingRemoteReply = null; // { chatId, source, enqueuedAt }
const IDE_REPLY_PATH = getTempPath('feedback_gate_ide_reply.jsonl');
```

**出队时记录来源**（修改 `checkTriggerFile` 中的队列自动出队部分）：

```javascript
const queueItem = dequeueMessage();
if (queueItem) {
    // 记录来源信息用于 V2 双向反馈
    if (queueItem.source && queueItem.source !== 'local' && queueItem.chatId) {
        pendingRemoteReply = {
            chatId: queueItem.chatId,
            source: queueItem.source,
            enqueuedAt: Date.now()
        };
    } else {
        pendingRemoteReply = null;
    }
    // ... 现有出队逻辑 ...
}
```

**Agent 回复时写 IDE reply**（在 `handleFeedbackGateToolCall` 或触发文件处理中）：

```javascript
function maybeWriteOutbox(agentMessage) {
    if (!pendingRemoteReply) return;
    if (!agentMessage || agentMessage.length < 10) return;
    
    // 截断：IM 消息长度限制
    const MAX_LEN = 500;
    const truncated = agentMessage.length > MAX_LEN
        ? agentMessage.slice(0, MAX_LEN) + '\n\n...（在 IDE 中查看完整内容）'
        : agentMessage;
    
    try {
        const entry = JSON.stringify({
            chatId: pendingRemoteReply.chatId,
            platform: pendingRemoteReply.source,
            agentMessage: truncated,
            ts: new Date().toISOString()
        });
        fs.appendFileSync(IDE_REPLY_PATH, entry + '\n');
    } catch {}
}

// 在触发文件处理中调用
// openFeedbackGatePopup 里 message 就是 Agent 的回复
maybeWriteOutbox(message);
```

**清除来源的时机**：

```javascript
// 用户本地输入时清除
case 'send':
    pendingRemoteReply = null;
    // ...

// 超时清除（30 分钟无新的远程出队）
if (pendingRemoteReply && Date.now() - pendingRemoteReply.enqueuedAt > 30 * 60 * 1000) {
    pendingRemoteReply = null;
}
```

### remote-control 改动

**文件**: 独立模块或集成到现有服务

轮询 IDE reply 文件，将 Agent 消息转发到 IM：

```typescript
import { watchFile, openSync, readSync, closeSync, existsSync } from 'fs';

class IdeReplyWatcher {
    private lastSize = 0;
    
    start(adapterFactory: (platform: string, chatId: string) => PlatformAdapter | null) {
        const replyPath = '/tmp/feedback_gate_ide_reply.jsonl';
        
        watchFile(replyPath, { interval: 3000 }, (curr) => {
            if (!existsSync(replyPath)) { this.lastSize = 0; return; }
            if (curr.size <= this.lastSize) {
                if (curr.size < this.lastSize) this.lastSize = 0;
                return;
            }
            
            const fd = openSync(replyPath, 'r');
            const buf = Buffer.alloc(curr.size - this.lastSize);
            readSync(fd, buf, 0, buf.length, this.lastSize);
            closeSync(fd);
            this.lastSize = curr.size;
            
            const lines = buf.toString().split('\n').filter(l => l.trim());
            for (const line of lines) {
                try {
                    const entry = JSON.parse(line);
                    const adapter = adapterFactory(entry.platform, entry.chatId);
                    if (adapter) {
                        adapter.reply(`🤖 Agent 回复:\n\n${entry.agentMessage}`);
                    }
                } catch {}
            }
        });
    }
}
```

### MCP 改动

**无需改动。** 与之前的事件文件方案不同，V2 完全在 Extension 层处理。

### 关键设计决策

**1. 来源追踪 — 从 queue item 读取**

每个 queue item 携带 `source` 和 `chatId` 字段。出队时设置 `pendingRemoteReply`，下次 Agent 回复时检查并写 IDE reply 文件。

来源清除时机：
- 本地消息出队时
- 用户在面板手动输入时
- 超时 30 分钟

**2. 混合队列处理**

```
队列: [远程A(feishu), 本地B, 远程C(dingtalk)]

A 出队 → pendingRemoteReply = { chatId: A.chatId, source: 'feishu' }
  Agent 回复 → 写 ide_reply → 飞书收到

B 出队 → pendingRemoteReply = null
  Agent 回复 → 不写 ide_reply

C 出队 → pendingRemoteReply = { chatId: C.chatId, source: 'dingtalk' }
  Agent 回复 → 写 ide_reply → 钉钉收到
```

**3. 不节流 — 每次回复都转发**

Agent 每次调用 `feedback_gate_chat` 都会在面板生成一个气泡。IDE reply 写入频率与气泡频率完全一致，IM 端收到的消息与面板显示一一对应。

不做节流的原因：用户主动发送 `/ide` 就是想在 IM 端看到结果，跳过中间气泡会丢失信息。

**4. 截断 — 500 字符**

Agent 回复超过 500 字符时截断，提示"在 IDE 中查看完整内容"。

**5. IDE reply 文件清理**

ide_reply.jsonl 可能持续增长。清理策略：
- remote-control 消费后可定期 truncate（例如每天清空一次）
- 或 Extension 启动时清空
- 或使用日期后缀

### 改动量估算

| 文件 | 新增行数 | 修改行数 |
|------|----------|----------|
| extension.js | ~40 | ~10（出队记录来源 + 触发时写 ide_reply + 本地输入清除来源） |
| remote-control 独立模块 | ~40 | 0 |
| queue-manager.js | 0 | 0（V1 已加 source 字段） |
| **总计** | **~80** | **~10** |

### IM 回复效果

```
用户: /ide 帮我检查下代码有没有安全问题

Feedback Gate: ✅ 已投递到 IDE 队列

... (Agent 在 IDE 中处理) ...

Feedback Gate: 🤖 Agent 回复:

检查完毕。发现 2 个潜在问题：
1. SQL 拼接未参数化（line 45）
2. 用户输入未转义（line 72）

已修复并提交。

...（在 IDE 中查看完整内容）
```

### 与 V1 的关系

V2 完全建立在 V1 基础上：
- V1 的 IDE 队列 + 队列入队 + 来源标记是 V2 的前提
- V2 增加 IDE reply + 来源追踪 + remote-control 轮询
- 可独立部署，V1 不受 V2 影响

## 其他未来扩展

1. **项目路由**：`/ide #projectName xxx` 精确投递到指定窗口
2. **状态查询**：`/ide` 无参数时列出所有活跃窗口和队列状态
3. **附件支持**：支持从 IM 发送图片/文件到 IDE 队列
4. **Agent 完成通知**：Agent 发出 TASK_COMPLETE 信号时通知 IM 发起者
