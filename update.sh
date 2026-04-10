#!/bin/bash

# Feedback Gate - 更新脚本
# 拉取最新代码、更新 MCP 服务和 Cursor 扩展

set -e

C_RED='\033[0;31m' C_GREEN='\033[0;32m' C_YELLOW='\033[1;33m'
C_BLUE='\033[0;34m' C_CYAN='\033[0;36m' C_NC='\033[0m'

log()  { echo -e "${C_CYAN}→ $1${C_NC}"; }
ok()   { echo -e "${C_GREEN}✓ $1${C_NC}"; }
warn() { echo -e "${C_YELLOW}⚠ $1${C_NC}"; }
err()  { echo -e "${C_RED}✗ $1${C_NC}"; }

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
INSTALL_DIR="$HOME/cursor-extensions/feedback-gate"

echo -e "${C_BLUE}Feedback Gate - 更新${C_NC}"
echo -e "${C_BLUE}=====================${C_NC}"
echo ""

# --- 检查安装目录 ---
if [[ ! -d "$INSTALL_DIR" ]]; then
    err "未找到安装目录 $INSTALL_DIR"
    echo -e "  ${C_YELLOW}请先运行 ./install.sh 完成首次安装${C_NC}"
    exit 1
fi

# --- 记录当前版本 ---
cd "$SCRIPT_DIR"
OLD_HEAD=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")

# --- 检查本地修改 ---
if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
    warn "检测到本地修改，先暂存..."
    git stash -q
    STASHED=true
else
    STASHED=false
fi

# --- 拉取最新代码 ---
log "拉取最新代码..."
if git pull origin main 2>&1; then
    NEW_HEAD=$(git rev-parse --short HEAD)
    if [[ "$OLD_HEAD" == "$NEW_HEAD" ]]; then
        ok "已是最新版本 ($NEW_HEAD)"
    else
        ok "代码已更新: $OLD_HEAD → $NEW_HEAD"
        echo ""
        echo -e "${C_BLUE}更新日志:${C_NC}"
        git log --oneline "${OLD_HEAD}..${NEW_HEAD}" | head -20
        echo ""
    fi
else
    err "git pull 失败"
    if [[ "$STASHED" == true ]]; then
        git stash pop -q 2>/dev/null || true
    fi
    exit 1
fi

# --- 恢复本地修改 ---
if [[ "$STASHED" == true ]]; then
    if git stash pop -q 2>/dev/null; then
        ok "已恢复本地修改"
    else
        warn "本地修改恢复有冲突，请手动处理: git stash pop"
    fi
fi

# --- 更新 MCP Python 文件 ---
log "更新 MCP 服务..."
cp "$SCRIPT_DIR/feedback_gate_mcp.py" "$INSTALL_DIR/"
ok "MCP 服务已更新"

# --- 更新 Python 依赖（如果需要） ---
if [[ -d "$INSTALL_DIR/venv" ]]; then
    log "检查 Python 依赖..."
    PIP_LOG=$(mktemp)
    if "$INSTALL_DIR/venv/bin/pip" install -q "mcp>=1.9.2" "Pillow>=10.0.0" "typing-extensions>=4.14.0" 2>"$PIP_LOG"; then
        ok "Python 依赖已更新"
    else
        warn "Python 依赖更新失败（不影响已安装版本）"
    fi
    rm -f "$PIP_LOG"
fi

# --- 打包并安装 Cursor 扩展 ---
EXT_DIR="$SCRIPT_DIR/cursor-extension"
if command -v npx &> /dev/null && [[ -d "$EXT_DIR" ]]; then
    log "打包 Cursor 扩展..."
    rm -f "$EXT_DIR/"*.vsix 2>/dev/null || true
    if (cd "$EXT_DIR" && npx @vscode/vsce package --no-dependencies 2>&1 | tail -1); then
        VSIX_FILE=$(find "$EXT_DIR" -name "*.vsix" -print -quit 2>/dev/null)
        if [[ -n "$VSIX_FILE" ]]; then
            ok "扩展打包成功: $(basename "$VSIX_FILE")"
            cp "$VSIX_FILE" "$INSTALL_DIR/"

            CURSOR_BIN=""
            if [[ "$OSTYPE" == "darwin"* ]]; then
                CURSOR_BIN="/Applications/Cursor.app/Contents/Resources/app/bin/cursor"
            else
                CURSOR_BIN=$(command -v cursor 2>/dev/null || echo "")
            fi

            if [[ -n "$CURSOR_BIN" && -x "$CURSOR_BIN" ]]; then
                log "安装扩展..."
                if "$CURSOR_BIN" --install-extension "$VSIX_FILE" --force >/dev/null 2>&1; then
                    ok "扩展安装成功"
                else
                    warn "自动安装失败，请手动安装: $VSIX_FILE"
                fi
            else
                warn "未找到 Cursor CLI，请手动安装扩展: $VSIX_FILE"
            fi
        fi
    else
        warn "扩展打包失败"
    fi
else
    warn "未找到 npx 或扩展目录，跳过扩展更新"
fi

# --- 更新规则文件 ---
if [[ -f "$SCRIPT_DIR/FeedbackGate.mdc" ]]; then
    CURSOR_RULES_DIR="$HOME/.cursor/rules"
    mkdir -p "$CURSOR_RULES_DIR"
    cp "$SCRIPT_DIR/FeedbackGate.mdc" "$CURSOR_RULES_DIR/"
    ok "规则已更新"
fi

# --- 完成 ---
echo ""
echo -e "${C_GREEN}✓ Feedback Gate 更新完成！${C_NC}"
echo ""
echo -e "${C_BLUE}下一步:${C_NC}"
echo "  重新加载 Cursor（Cmd+Shift+P → Reload Window）"
echo ""
