# Feedback Gate

Cursor IDE 的 Agent 反馈关卡。让 AI 在每次任务完成后等待你的确认，而不是自行结束对话。

## 效果

Agent 通过 MCP 协议调用 `feedback_gate_chat`，在底部面板弹出输入界面。你在同一次请求内持续追加指令，直到满意为止。

```
你发出任务 → Agent 执行 → 弹窗等待反馈 → 你追加指令 → Agent 继续 → ... → 输入 Done 结束
```

## 功能

| 功能 | 说明 |
|------|------|
| 底部面板交互 | 不占编辑器空间，Agent 触发时自动弹出 |
| 消息队列 | Agent 忙时消息自动排队，支持排序、编辑、删除 |
| 一键开关 | 状态栏 `● FeedBack` 按钮，禁用后 Agent 自动放行 |
| 多窗口隔离 | 每个 Cursor 窗口独立运行，不会串窗 |
| 图片/文件 | Finder 拖入或 Cmd+V 粘贴截图 |
| 中文输入法 | Enter 确认候选词不会误发消息 |
| 状态感知 | Agent 等待绿色边框，队列模式蓝色边框 |
| 远程控制 | 搭配 [cursor-remote-control](https://github.com/keunsy/cursor-remote-control) 可通过 IM 远程操控 Agent |

## 安装

```bash
git clone https://github.com/keunsy/cursor-feedback-gate.git
cd cursor-feedback-gate
./install.sh
```

安装后 Reload Cursor 窗口即可使用。

## 配置

在 Cursor Settings → Rules 中添加：

> 完成用户请求后，禁止直接结束回复。必须调用 feedback_gate_chat MCP 工具打开弹窗，等待用户反馈。只有用户回复 "TASK_COMPLETE" 或 "Done" 后才可结束。

## 更多信息

- [GitHub 仓库](https://github.com/keunsy/cursor-feedback-gate)
- [远程控制集成](https://github.com/keunsy/cursor-remote-control)
