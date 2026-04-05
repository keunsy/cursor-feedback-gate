#!/bin/bash

# Feedback Gate - 一键安装脚本
# 支持 macOS / Linux

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
else
    err "不支持的操作系统: $OSTYPE（仅支持 macOS 和 Linux）"
    exit 1
fi
ok "操作系统: $OS"

# --- 检查 Python 3.10+ ---
PYTHON_CMD=""

find_suitable_python() {
    for cmd in python3.13 python3.12 python3.11 python3.10 python3; do
        if command -v "$cmd" &> /dev/null; then
            local ver_major ver_minor
            ver_major=$($cmd -c 'import sys; print(sys.version_info.major)' 2>/dev/null)
            ver_minor=$($cmd -c 'import sys; print(sys.version_info.minor)' 2>/dev/null)
            if [[ "$ver_major" -eq 3 ]] && [[ "$ver_minor" -ge 10 ]]; then
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
    else
        echo "    sudo apt-get install python3.12 python3.12-venv"
        echo "    或使用 pyenv: pyenv install 3.12 && pyenv global 3.12"
    fi
    exit 1
fi
ok "Python: $($PYTHON_CMD --version) [$(command -v $PYTHON_CMD)]"

# --- 创建安装目录 ---
INSTALL_DIR="$HOME/cursor-extensions/feedback-gate"
log "安装到 $INSTALL_DIR ..."
mkdir -p "$INSTALL_DIR"

cp "$SCRIPT_DIR/feedback_gate_mcp.py" "$INSTALL_DIR/"

# --- Python 虚拟环境 ---
log "配置 Python 虚拟环境..."
if [[ "$OS" == "linux" ]]; then
    PY_MINOR_VER=$($PYTHON_CMD -c 'import sys; print(sys.version_info.minor)')
    dpkg -s "python3.${PY_MINOR_VER}-venv" >/dev/null 2>&1 || \
        dpkg -s python3-venv >/dev/null 2>&1 || \
        sudo apt-get install -y "python3.${PY_MINOR_VER}-venv" || \
        sudo apt-get install -y python3-venv
fi

if [[ -d "$INSTALL_DIR/venv" ]]; then
    VENV_PY="$INSTALL_DIR/venv/bin/python"
    if [[ ! -x "$VENV_PY" ]] || ! "$VENV_PY" -c 'import sys; assert sys.version_info >= (3,10)' 2>/dev/null; then
        warn "旧虚拟环境 Python 版本不兼容，重建..."
        rm -rf "$INSTALL_DIR/venv"
    fi
fi

if [[ ! -d "$INSTALL_DIR/venv" ]]; then
    log "使用 $PYTHON_CMD 创建虚拟环境..."
    $PYTHON_CMD -m venv "$INSTALL_DIR/venv"
fi

source "$INSTALL_DIR/venv/bin/activate"

pip install --upgrade pip -q 2>/dev/null

log "安装 Python 依赖（首次安装需下载约 30MB）..."
PIP_LOG=$(mktemp)
if ! pip install -q "mcp>=1.9.2" "Pillow>=10.0.0" "typing-extensions>=4.14.0" 2>"$PIP_LOG"; then
    cat "$PIP_LOG"
    err "Python 依赖安装失败"
    echo ""
    echo -e "  ${C_YELLOW}调试信息:${C_NC}"
    echo "    系统 Python: $($PYTHON_CMD --version) [$(command -v $PYTHON_CMD)]"
    echo "    venv Python: $(python --version) [$(which python)]"
    echo "    pip: $(pip --version)"
    echo ""
    echo -e "  ${C_YELLOW}常见原因:${C_NC}"
    echo "    1. venv 内 Python < 3.10（删除 $INSTALL_DIR/venv 后重试）"
    echo "    2. 网络问题，请检查代理设置"
    echo ""
    echo -e "  ${C_YELLOW}手动修复:${C_NC}"
    echo "    rm -rf $INSTALL_DIR/venv"
    echo "    然后重新运行 ./install.sh"
    rm -f "$PIP_LOG"
    deactivate
    exit 1
fi
rm -f "$PIP_LOG"

deactivate
ok "Python 环境就绪"

# --- MCP 配置 ---
CURSOR_MCP_FILE="$HOME/.cursor/mcp.json"
log "配置 MCP..."
mkdir -p "$HOME/.cursor"

if [[ -f "$CURSOR_MCP_FILE" ]]; then
    cp "$CURSOR_MCP_FILE" "$CURSOR_MCP_FILE.backup.$(date +%Y%m%d_%H%M%S)"
    warn "已备份现有 MCP 配置"
fi

$PYTHON_CMD -c "
import json, os

config_file = '$CURSOR_MCP_FILE'
install_dir = '$INSTALL_DIR'

servers = {}
if os.path.exists(config_file):
    try:
        with open(config_file, 'r') as f:
            servers = json.load(f).get('mcpServers', {})
    except:
        pass

servers['feedback-gate'] = {
    'command': os.path.join(install_dir, 'venv/bin/python'),
    'args': [os.path.join(install_dir, 'feedback_gate_mcp.py')],
    'env': {
        'PYTHONPATH': install_dir,
        'PYTHONUNBUFFERED': '1',
        'FEEDBACK_GATE_MODE': 'cursor_integration'
    }
}

with open(config_file, 'w') as f:
    json.dump({'mcpServers': servers}, f, indent=2)
"
ok "MCP 配置已更新: $CURSOR_MCP_FILE"

# --- 构建并安装 Cursor 扩展 ---
VSIX_FILE=$(find "$SCRIPT_DIR/cursor-extension" -name "*.vsix" -print -quit 2>/dev/null)

if [[ -z "$VSIX_FILE" ]]; then
    log "未找到 .vsix，正在构建扩展..."
    if command -v npx &> /dev/null; then
        rm -f "$SCRIPT_DIR/cursor-extension/"*.vsix 2>/dev/null || true
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
    fi
fi

if [[ -n "$VSIX_FILE" ]]; then
    log "安装 Cursor 扩展..."
    cp "$VSIX_FILE" "$INSTALL_DIR/"

    INSTALLED=false
    if [[ "$OS" == "macos" ]]; then
        CURSOR_BIN="/Applications/Cursor.app/Contents/Resources/app/bin/cursor"
    else
        CURSOR_BIN=$(command -v cursor 2>/dev/null || echo "")
    fi
    if [[ -n "$CURSOR_BIN" && -x "$CURSOR_BIN" ]]; then
        if "$CURSOR_BIN" --install-extension "$VSIX_FILE" --force >/dev/null 2>&1; then
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
fi

# --- 清理临时文件 ---
rm -f /tmp/feedback_gate_* /tmp/mcp_response* 2>/dev/null || true

# --- 完成 ---
echo ""
echo -e "${C_GREEN}✓ Feedback Gate 安装完成！${C_NC}"
echo ""
echo "  MCP 服务器 : $INSTALL_DIR"
echo "  MCP 配置   : $CURSOR_MCP_FILE"
echo ""
echo -e "${C_BLUE}下一步:${C_NC}"
echo "  1. 重新加载 Cursor（Cmd+Shift+P → Reload Window）"
echo "  2. 检查状态栏是否有绿色 'FeedBack' 指示"
echo ""
