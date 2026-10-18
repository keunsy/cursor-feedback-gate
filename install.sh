#!/bin/bash

# Feedback Gate - 一键安装脚本
# 支持 macOS / Linux / Windows (Git Bash)

set -e

C_RED='\033[0;31m' C_GREEN='\033[0;32m' C_YELLOW='\033[1;33m'
C_BLUE='\033[0;34m' C_CYAN='\033[0;36m' C_NC='\033[0m'

log()     { echo -e "${C_CYAN}→ $1${C_NC}"; }
ok()      { echo -e "${C_GREEN}✓ $1${C_NC}"; }
warn()    { echo -e "${C_YELLOW}⚠ $1${C_NC}"; }
err()     { echo -e "${C_RED}✗ $1${C_NC}"; }

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"

echo -e "${C_BLUE}Feedback Gate - 一键安装${C_NC}"
echo -e "${C_BLUE}=========================${C_NC}"
echo ""

# --- 检测操作系统 ---
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    OS="linux"
elif [[ "$OSTYPE" == "darwin"* ]]; then
    OS="macos"
elif [[ "$OSTYPE" == "msys"* || "$OSTYPE" == "cygwin"* || "$OSTYPE" == "win32"* ]]; then
    OS="windows"
else
    err "不支持的操作系统: $OSTYPE（支持 macOS、Linux 和 Windows Git Bash）"
    exit 1
fi
ok "操作系统: $OS"

# --- 检查 Python 3.10+ ---
PYTHON_CMD=""

find_suitable_python() {
    local candidates=(python3.13 python3.12 python3.11 python3.10 python3 python)
    if [[ "$OS" == "windows" ]] && command -v py &> /dev/null; then
        local launcher_python
        launcher_python=$(PYTHONIOENCODING=utf-8 py -3 -c 'import sys; print(sys.executable)' 2>/dev/null | tr -d '\r')
        if [[ -n "$launcher_python" ]]; then
            if command -v cygpath &> /dev/null; then
                launcher_python=$(cygpath -u "$launcher_python")
            fi
            candidates+=("$launcher_python")
        fi
    fi
    for cmd in "${candidates[@]}"; do
        if command -v "$cmd" &> /dev/null; then
            if "$cmd" -c 'import os, sys; assert sys.version_info >= (3, 10); assert sys.argv[1] != "windows" or os.name == "nt"' "$OS" 2>/dev/null; then
                PYTHON_CMD="$cmd"
                return 0
            fi
        fi
    done
    return 1
}

if ! find_suitable_python; then
    err "需要 Python 3.10+，未找到合适的 Python"
    if command -v python3 &> /dev/null; then
        echo -e "  当前 python3: $(python3 --version)（版本过低）"
    fi
    echo ""
    echo -e "  ${C_YELLOW}请安装 Python 3.10+:${C_NC}"
    if [[ "$OSTYPE" == "darwin"* ]]; then
        echo "    brew install python@3.12"
    elif [[ "$OS" == "windows" ]]; then
        echo "    安装原生 Windows Python 3.10+，启用 Add Python to PATH 或 py 启动器"
    else
        echo "    sudo apt-get install python3.12 python3.12-venv"
        echo "    或使用 pyenv: pyenv install 3.12 && pyenv global 3.12"
    fi
    exit 1
fi
ok "Python: $("$PYTHON_CMD" --version) [$(command -v "$PYTHON_CMD")]"

# --- 创建安装目录 ---
INSTALL_DIR="$HOME/cursor-extensions/feedback-gate"
log "安装到 $INSTALL_DIR ..."
mkdir -p "$INSTALL_DIR"

cp "$SCRIPT_DIR/feedback_gate_mcp.py" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/feedback_gate_lifecycle.py" "$INSTALL_DIR/"

# --- Python 虚拟环境 ---
log "配置 Python 虚拟环境..."
if [[ "$OS" == "linux" ]]; then
    if ! "$PYTHON_CMD" -m venv --help >/dev/null 2>&1; then
        PY_MINOR_VER=$("$PYTHON_CMD" -c 'import sys; print(sys.version_info.minor)')
        if command -v apt-get &> /dev/null; then
            sudo apt-get install -y "python3.${PY_MINOR_VER}-venv" 2>/dev/null || \
                sudo apt-get install -y python3-venv
        elif command -v dnf &> /dev/null; then
            sudo dnf install -y "python3.${PY_MINOR_VER}-libs" 2>/dev/null || true
        elif command -v pacman &> /dev/null; then
            : # Arch includes venv in base python package
        else
            warn "无法自动安装 python3-venv，请手动安装后重试"
        fi
    fi
fi

if [[ "$OS" == "windows" ]]; then
    VENV_PY="$INSTALL_DIR/venv/Scripts/python.exe"
else
    VENV_PY="$INSTALL_DIR/venv/bin/python"
fi
if [[ -d "$INSTALL_DIR/venv" ]]; then
    if [[ ! -x "$VENV_PY" ]] || ! "$VENV_PY" -c 'import sys; assert sys.version_info >= (3,10)' 2>/dev/null; then
        warn "旧虚拟环境 Python 版本不兼容，重建..."
        rm -rf "$INSTALL_DIR/venv"
    fi
fi

if [[ ! -d "$INSTALL_DIR/venv" ]]; then
    log "使用 $PYTHON_CMD 创建虚拟环境..."
    "$PYTHON_CMD" -m venv "$INSTALL_DIR/venv"
fi

"$VENV_PY" -m pip install --no-user --upgrade pip -q 2>/dev/null

log "安装 Python 依赖（首次安装需下载约 30MB）..."
PIP_LOG=$(mktemp)
if ! "$VENV_PY" -m pip install --no-user -q "mcp>=1.9.2,<2.0.0" "Pillow>=10.0.0" "typing-extensions>=4.14.0" 2>"$PIP_LOG"; then
    cat "$PIP_LOG"
    err "Python 依赖安装失败"
    echo ""
    echo -e "  ${C_YELLOW}调试信息:${C_NC}"
    echo "    系统 Python: $("$PYTHON_CMD" --version) [$(command -v "$PYTHON_CMD")]"
    echo "    venv Python: $("$VENV_PY" --version) [$VENV_PY]"
    echo "    pip: $("$VENV_PY" -m pip --version)"
    echo ""
    echo -e "  ${C_YELLOW}常见原因:${C_NC}"
    echo "    1. venv 内 Python < 3.10（删除 $INSTALL_DIR/venv 后重试）"
    echo "    2. 网络问题，请检查代理设置"
    echo ""
    echo -e "  ${C_YELLOW}手动修复:${C_NC}"
    echo "    rm -rf $INSTALL_DIR/venv"
    echo "    然后重新运行 ./install.sh"
    rm -f "$PIP_LOG"
    exit 1
fi
rm -f "$PIP_LOG"

ok "Python 环境就绪"

# --- MCP 配置 ---
CURSOR_MCP_FILE="$HOME/.cursor/mcp.json"
log "配置 MCP..."
mkdir -p "$HOME/.cursor"

if [[ -f "$CURSOR_MCP_FILE" ]]; then
    cp "$CURSOR_MCP_FILE" "$CURSOR_MCP_FILE.backup.$(date +%Y%m%d_%H%M%S)"
    warn "已备份现有 MCP 配置"
fi

CONFIG_SCRIPT="$SCRIPT_DIR/scripts/configure_mcp.py"
MCP_CONFIG_ARG="$CURSOR_MCP_FILE"
INSTALL_DIR_ARG="$INSTALL_DIR"
if [[ "$OS" == "windows" ]] && command -v cygpath &> /dev/null; then
    CONFIG_SCRIPT=$(cygpath -w "$CONFIG_SCRIPT")
    MCP_CONFIG_ARG=$(cygpath -w "$MCP_CONFIG_ARG")
    INSTALL_DIR_ARG=$(cygpath -w "$INSTALL_DIR_ARG")
fi
"$VENV_PY" "$CONFIG_SCRIPT" "$MCP_CONFIG_ARG" "$INSTALL_DIR_ARG"
ok "MCP 配置已更新: $CURSOR_MCP_FILE"

LIFECYCLE_SCRIPT="$INSTALL_DIR/feedback_gate_lifecycle.py"
if [[ "$OS" == "windows" ]] && command -v cygpath &> /dev/null; then
    LIFECYCLE_SCRIPT=$(cygpath -w "$LIFECYCLE_SCRIPT")
fi
"$VENV_PY" "$LIFECYCLE_SCRIPT" --install-hooks
ok "Feedback Gate 等待续接钩子已安装（保留其他 hooks）"

# --- 构建并安装 Cursor 扩展 ---
log "构建扩展..."
rm -f "$SCRIPT_DIR/cursor-extension/"*.vsix 2>/dev/null || true
if command -v npx &> /dev/null; then
    (cd "$SCRIPT_DIR/cursor-extension" && npx @vscode/vsce package --no-dependencies)
    VSIX_FILE=$(find "$SCRIPT_DIR/cursor-extension" -name "*.vsix" -print -quit 2>/dev/null)
    if [[ -n "$VSIX_FILE" ]]; then
        ok "扩展构建成功: $(basename "$VSIX_FILE")"
    else
        warn "扩展构建失败 — 请手动安装"
    fi
else
    warn "未找到 npx — 无法自动构建扩展"
    echo -e "  ${C_YELLOW}请安装 Node.js 后执行: cd cursor-extension && npx @vscode/vsce package --no-dependencies${C_NC}"
    VSIX_FILE=""
fi

if [[ -n "$VSIX_FILE" ]]; then
    log "安装 Cursor 扩展..."
    cp "$VSIX_FILE" "$INSTALL_DIR/"

    VSIX_INSTALL_PATH="$VSIX_FILE"
    if [[ "$OS" == "windows" ]] && command -v cygpath &> /dev/null; then
        VSIX_INSTALL_PATH=$(cygpath -w "$VSIX_FILE")
    fi

    INSTALLED=false
    if [[ "$OS" == "macos" ]]; then
        CURSOR_BIN="/Applications/Cursor.app/Contents/Resources/app/bin/cursor"
    else
        CURSOR_BIN=$(command -v cursor 2>/dev/null || echo "")
    fi
    if [[ -n "$CURSOR_BIN" && -x "$CURSOR_BIN" ]]; then
        if "$CURSOR_BIN" --install-extension "$VSIX_INSTALL_PATH" --force >/dev/null 2>&1; then
            ok "扩展安装成功"
            INSTALLED=true
        fi
    fi

    if [[ "$INSTALLED" == false ]]; then
        echo ""
        warn "自动安装失败，请手动操作："
        echo "  1. 打开 Cursor → Cmd+Shift+P → 'Extensions: Install from VSIX'"
        echo "  2. 选择: $VSIX_FILE"
        echo "  3. 重新加载窗口"
    fi
fi

# --- 安装 Cursor 规则 ---
if [[ -f "$SCRIPT_DIR/FeedbackGate.mdc" ]]; then
    CURSOR_RULES_DIR="$HOME/.cursor/rules"
    mkdir -p "$CURSOR_RULES_DIR"
    cp "$SCRIPT_DIR/FeedbackGate.mdc" "$CURSOR_RULES_DIR/"
    ok "规则已安装: $CURSOR_RULES_DIR/FeedbackGate.mdc"
    echo ""
    echo -e "  ${C_YELLOW}建议：将规则内容也复制到 Cursor Settings → User Rules 中${C_NC}"
    echo -e "  ${C_YELLOW}（Cmd+Shift+P → 'Cursor Settings' → Rules → User Rules）${C_NC}"
    echo -e "  ${C_YELLOW}原因：~/.cursor/rules/ 下的规则文件可能因 Cursor 版本差异未被加载，${C_NC}"
    echo -e "  ${C_YELLOW}而 User Rules（设置项）是 Cursor 官方支持的全局规则入口，稳定生效。${C_NC}"
fi

# --- 清理临时文件（仅清理旧的 trigger 文件，保留可能正在使用的 response 文件） ---
find /tmp -name "feedback_gate_trigger_*.json" -mmin +5 -delete 2>/dev/null || true
rm -f /tmp/feedback_gate.log /tmp/feedback_gate_v2.log 2>/dev/null || true

# --- 完成 ---
echo ""
echo -e "${C_GREEN}✓ Feedback Gate 安装完成！${C_NC}"
echo ""
echo "  MCP 服务器 : $INSTALL_DIR"
echo "  MCP 配置   : $CURSOR_MCP_FILE"
echo ""
echo -e "${C_BLUE}下一步:${C_NC}"
echo "  1. 重新加载 Cursor（Cmd+Shift+P → Reload Window）"
echo "  2. 打开 Feedback Gate 面板（侧边栏 → Feedback Gate）"
echo "  3. 确认状态显示「等待 Cursor 调用」"
echo ""
