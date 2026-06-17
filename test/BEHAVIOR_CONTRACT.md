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
| Q5 | 不同 session 的队列互相隔离 | Session A 的 trigger 不消费 Session B 的消息 | G7-*, G8-*, E2E-6 |

## 3. Session 管理

| # | 场景 | 期望行为 | 验证测试 |
|---|------|----------|----------|
| S1 | 首次 trigger（无 session_id） | 创建新 session | S1 |
| S2 | 相同 PID + 无 trigger = 空闲 | 复用已有 session | S2 |
| S3 | 有 session_id 匹配已有 session | 直接定位到该 session（即使 PID 变了） | S13 |
| S4 | Session 有活跃 trigger 时新请求到达 | 创建新 tab（多 tab 并发） | S4, S14 |
| S5 | Reload 后 | Session 持久化到 globalState，reload 后恢复（mcpPid=0） | S7, S12, E2E-11 |
| S6 | MCP 重启（PID 变更） | Session 通过 session_id 重新绑定新 PID | S13, DC-2, E2E-12 |

## 4. Trigger 路由（多窗口）

| # | 场景 | 期望行为 | 验证测试 |
|---|------|----------|----------|
| R1 | Workspace 精确匹配 | 即使不聚焦也能 claim trigger | TR-1 |
| R2 | Workspace 不匹配 | 拒绝 claim | TR-2 |
| R3 | Session ownership | 优先级最高，无视 workspace | TR-3 |
| R4 | 无 workspace hint + 无 session owner | 只有聚焦窗口 claim | TR-4, TR-5 |
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
| M5 | IDE stale limit (5min) | 超过 5min 未响应的 trigger 被清理 | SC-2 |
| M6 | CLI stale limit (30min) | 超过 30min 未响应的 trigger 被清理 | SC-3 |
| M7 | Cooldown (2s) | 响应后 2s 内重复调用返回 SKIP | CD-1, CD-2 |
| M8 | 多 session 互不影响 | 不同 session 的 trigger 可并存 | MC-1, MC-2 |
| M9 | _active_triggers 上限 (20) | 超限时驱逐最旧的 trigger | EV-3 |

## 9. MCP 状态检测

| # | 场景 | 期望行为 | 验证测试 |
|---|------|----------|----------|
| MS1 | Log 文件 < 30s | mcpStatus = active | MS-1 |
| MS2 | Log > 30s + 无活进程 | mcpStatus = inactive | MS-2 |
| MS3 | Log > 30s + 有活进程 | mcpStatus = active | MS-3 |

---

## 运行全部验证

```bash
node cursor-extension/test/scenario-simulation.js \
  && node cursor-extension/test/queue-display-simulation.js \
  && node cursor-extension/test/integration-scenarios.js \
  && python3 test/mcp-scenarios.py
```

全部通过 = 行为契约满足。任何修改后必须跑此命令。

---

## 变更规则

- 修改任何核心逻辑前，先确认相关行为测试存在
- 如果新行为需要改变上述契约，**必须先更新本文件**，再修改代码和测试
- 禁止为了让测试通过而弱化 assertion（必须修改代码而非测试）
