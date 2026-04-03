#!/bin/bash

# Feedback Gate - 卸载脚本

set -e

C_RED='\033[0;31m' C_GREEN='\033[0;32m' C_YELLOW='\033[1;33m'
C_BLUE='\033[0;34m' C_NC='\033[0m'

ok()   { echo -e "${C_GREEN}✓ $1${C_NC}"; }
warn() { echo -e "${C_YELLOW}⚠ $1${C_NC}"; }

echo -e "${C_BLUE}Feedback Gate - 卸载${C_NC}"
echo ""

read -p "$(echo -e ${C_YELLOW}确认卸载 Feedback Gate？[y/N]: ${C_NC})" -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    warn "已取消"
    exit 0
fi

INSTALL_DIR="$HOME/cursor-extensions/feedback-gate"
MCP_FILE="$HOME/.cursor/mcp.json"

# --- 删除安装目录 ---
if [[ -d "$INSTALL_DIR" ]]; then
    rm -rf "$INSTALL_DIR"
    ok "已删除: $INSTALL_DIR"
else
    warn "安装目录不存在，跳过"
fi

# --- 从 MCP 配置中移除（保留其他服务） ---
if [[ -f "$MCP_FILE" ]]; then
    cp "$MCP_FILE" "$MCP_FILE.backup.$(date +%Y%m%d_%H%M%S)"
    python3 -c "
import json, os
config_file = '$MCP_FILE'
try:
    with open(config_file, 'r') as f:
        config = json.load(f)
    config.get('mcpServers', {}).pop('feedback-gate', None)
    with open(config_file, 'w') as f:
        json.dump(config, f, indent=2)
except:
    pass
" 2>/dev/null
    ok "已从 MCP 配置中移除 feedback-gate"
fi

# --- 删除 Cursor 规则 ---
CURSOR_RULES_DIR="$HOME/.cursor/rules"
if [[ -f "$CURSOR_RULES_DIR/FeedbackGate.mdc" ]]; then
    rm -f "$CURSOR_RULES_DIR/FeedbackGate.mdc"
    ok "已删除规则: $CURSOR_RULES_DIR/FeedbackGate.mdc"
fi

# --- 清理临时文件 ---
rm -f /tmp/feedback_gate_* /tmp/mcp_response* 2>/dev/null || true
TEMP_DIR=$(python3 -c 'import tempfile; print(tempfile.gettempdir())' 2>/dev/null || echo "/tmp")
rm -f "$TEMP_DIR"/feedback_gate_* "$TEMP_DIR"/mcp_response* 2>/dev/null || true
ok "已清理临时文件"

# --- 卸载 Cursor 扩展 ---
if [[ "$OSTYPE" == "darwin"* ]]; then
    CURSOR_BIN="/Applications/Cursor.app/Contents/Resources/app/bin/cursor"
else
    CURSOR_BIN=$(command -v cursor 2>/dev/null || echo "")
fi
if [[ -n "$CURSOR_BIN" && -x "$CURSOR_BIN" ]]; then
    if "$CURSOR_BIN" --uninstall-extension keunsy.cursor-feedback-gate >/dev/null 2>&1; then
        ok "扩展已卸载"
    else
        warn "请手动卸载: Cursor → 扩展 → 搜索 'Feedback Gate' → 卸载"
    fi
else
    warn "请手动卸载: Cursor → 扩展 → 搜索 'Feedback Gate' → 卸载"
fi

echo ""
ok "Feedback Gate 卸载完成！"
echo ""
