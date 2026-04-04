# Feedback Gate

Cursor IDE 的 Agent 反馈关卡。让 AI 在每次任务完成后等待你的确认，而不是自行结束对话。

## 它解决什么问题

Cursor Agent 处理复杂任务时，经常执行了几步就宣布完成。你不得不发起新的请求来继续，浪费宝贵的请求额度。

Feedback Gate 在 Agent 完成工作后弹出一个输入窗口，你可以在同一次请求内持续追加指令，直到真正满意为止。

## 工作原理

```
你发出任务 → Agent 执行 → 弹窗等待反馈 → 你追加指令 → Agent 继续 → ... → 输入 Done 结束
```

Agent 通过 MCP 协议调用 `feedback_gate_chat` 工具，触发底部面板弹出输入界面。你的回复通过 MCP 回传给 Agent，Agent 读取后继续执行。

## 功能

- **底部面板交互** — 不占编辑器空间，Agent 触发时自动弹出
- **消息队列** — Agent 忙时发送的消息自动排队，不会丢失，支持排序、编辑、删除
- **一键开关** — 状态栏 `● FeedBack` 按钮，禁用后 Agent 自动放行
- **多窗口隔离** — 每个 Cursor 窗口独立运行，不会串窗
- **图片/文件拖拽** — 从 Finder 拖入面板，或 Cmd+V 粘贴截图
- **语音输入** — 本地 Whisper 模型转写（需安装 SoX 和 faster-whisper）
- **中文输入法兼容** — Enter 确认候选词不会误发消息
- **状态感知输入框** — Agent 等待时绿色边框，队列模式蓝色边框
- **远程控制集成** — 搭配 [cursor-remote-control](https://github.com/keunsy/cursor-remote-control) 可通过即时通讯渠道远程操控 Agent

## 安装

```bash
git clone https://github.com/keunsy/cursor-feedback-gate.git
cd cursor-feedback-gate
./install.sh
```

安装脚本会自动完成 Python 环境、MCP 配置、扩展打包与安装、Rule 文件部署。

安装后 Reload Cursor 窗口即可使用。

## 配置 Rule

在 **Cursor Settings → Rules** 中添加：

```
完成用户请求后，禁止直接结束回复。必须调用 feedback_gate_chat MCP 工具打开弹窗，等待用户反馈。
只有用户回复 "TASK_COMPLETE" 或 "Done" 后才可结束。
```

或将项目中的 `FeedbackGate.mdc` 拷贝到 Cursor 全局规则目录。

## 故障排查

```bash
# 查看 MCP 服务器日志
tail -f /tmp/feedback_gate.log

# 检查 MCP 配置
cat ~/.cursor/mcp.json
```

## License

MIT — by [keunsy](https://github.com/keunsy)
