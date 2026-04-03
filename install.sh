#!/bin/bash

# Feedback Gate - One-Click Installation Script
# Installs Feedback Gate globally for Cursor IDE (macOS / Linux)

set -e

C_RED='\033[0;31m' C_GREEN='\033[0;32m' C_YELLOW='\033[1;33m'
C_BLUE='\033[0;34m' C_CYAN='\033[0;36m' C_NC='\033[0m'

log()     { echo -e "${C_CYAN}→ $1${C_NC}"; }
ok()      { echo -e "${C_GREEN}✓ $1${C_NC}"; }
warn()    { echo -e "${C_YELLOW}⚠ $1${C_NC}"; }
err()     { echo -e "${C_RED}✗ $1${C_NC}"; }

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"

echo -e "${C_BLUE}Feedback Gate - One-Click Installation${C_NC}"
echo -e "${C_BLUE}=========================================${C_NC}"
echo ""

# --- Detect OS ---
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    OS="linux"
elif [[ "$OSTYPE" == "darwin"* ]]; then
    OS="macos"
else
    err "Unsupported OS: $OSTYPE (Linux and macOS only)"
    exit 1
fi
ok "Detected OS: $OS"

# --- Check Python 3 ---
if ! command -v python3 &> /dev/null; then
    err "Python 3 is required but not installed"
    exit 1
fi
ok "Python 3 found: $(python3 --version)"

# --- Optional: install SoX for speech-to-text ---
log "Checking SoX (for speech-to-text, optional)..."
if command -v sox &> /dev/null; then
    ok "SoX already installed"
else
    if [[ "$OS" == "macos" ]]; then
        if command -v brew &> /dev/null; then
            brew install sox 2>/dev/null || warn "SoX install failed — speech features disabled"
        else
            warn "Homebrew not found — skipping SoX (speech features disabled)"
        fi
    else
        sudo apt-get update -qq && sudo apt-get install -y -qq sox 2>/dev/null || warn "SoX install failed — speech features disabled"
    fi
fi

# --- Create installation directory ---
INSTALL_DIR="$HOME/cursor-extensions/feedback-gate"
log "Installing to $INSTALL_DIR ..."
mkdir -p "$INSTALL_DIR"

cp "$SCRIPT_DIR/feedback_gate_mcp.py" "$INSTALL_DIR/"

# --- Python venv ---
log "Setting up Python virtual environment..."
if [[ "$OS" == "linux" ]]; then
    dpkg -s python3-venv >/dev/null 2>&1 || sudo apt-get install -y python3-venv
fi

if [[ ! -d "$INSTALL_DIR/venv" ]]; then
    python3 -m venv "$INSTALL_DIR/venv"
fi
source "$INSTALL_DIR/venv/bin/activate"
pip install --upgrade pip -q

log "Installing Python dependencies..."
pip install -q "mcp>=1.9.2" "Pillow>=10.0.0" "typing-extensions>=4.14.0"

if pip install -q "faster-whisper>=1.0.0" 2>/dev/null; then
    ok "faster-whisper installed (speech-to-text enabled)"
else
    warn "faster-whisper install failed — speech-to-text disabled"
fi

deactivate
ok "Python environment ready"

# --- MCP configuration ---
CURSOR_MCP_FILE="$HOME/.cursor/mcp.json"
log "Configuring MCP..."
mkdir -p "$HOME/.cursor"

if [[ -f "$CURSOR_MCP_FILE" ]]; then
    cp "$CURSOR_MCP_FILE" "$CURSOR_MCP_FILE.backup.$(date +%Y%m%d_%H%M%S)"
    warn "Existing MCP config backed up"
fi

python3 -c "
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
ok "MCP configuration updated: $CURSOR_MCP_FILE"

# --- Build & Install Cursor extension ---
VSIX_FILE=$(find "$SCRIPT_DIR/cursor-extension" -name "*.vsix" -print -quit 2>/dev/null)

if [[ -z "$VSIX_FILE" ]]; then
    log "No .vsix found, building extension..."
    if command -v npx &> /dev/null; then
        (cd "$SCRIPT_DIR/cursor-extension" && npx @vscode/vsce package --no-dependencies 2>/dev/null)
        VSIX_FILE=$(find "$SCRIPT_DIR/cursor-extension" -name "*.vsix" -print -quit 2>/dev/null)
        if [[ -n "$VSIX_FILE" ]]; then
            ok "Extension built: $(basename "$VSIX_FILE")"
        else
            warn "Extension build failed — install manually later"
        fi
    else
        warn "npx not found — cannot build extension automatically"
        echo -e "  ${C_YELLOW}Install Node.js, then run: cd cursor-extension && npx @vscode/vsce package --no-dependencies${C_NC}"
    fi
fi

if [[ -n "$VSIX_FILE" ]]; then
    log "Installing Cursor extension..."
    cp "$VSIX_FILE" "$INSTALL_DIR/"

    INSTALLED=false
    if [[ "$OS" == "macos" ]]; then
        CURSOR_BIN="/Applications/Cursor.app/Contents/Resources/app/bin/cursor"
    else
        CURSOR_BIN=$(command -v cursor 2>/dev/null || echo "")
    fi
    if [[ -n "$CURSOR_BIN" && -x "$CURSOR_BIN" ]]; then
        if "$CURSOR_BIN" --install-extension "$VSIX_FILE" --force >/dev/null 2>&1; then
            ok "Extension installed automatically"
            INSTALLED=true
        fi
    fi

    if [[ "$INSTALLED" == false ]]; then
        echo ""
        warn "Auto-install failed. Manual steps:"
        echo "  1. Open Cursor → Cmd+Shift+P → 'Extensions: Install from VSIX'"
        echo "  2. Select: $VSIX_FILE"
        echo "  3. Reload Window"
    fi
fi

# --- Install Cursor Rule ---
if [[ -f "$SCRIPT_DIR/FeedbackGate.mdc" ]]; then
    CURSOR_RULES_DIR="$HOME/.cursor/rules"
    mkdir -p "$CURSOR_RULES_DIR"
    cp "$SCRIPT_DIR/FeedbackGate.mdc" "$CURSOR_RULES_DIR/"
    ok "Rule installed to: $CURSOR_RULES_DIR/FeedbackGate.mdc"
fi

# --- Clean up stale temp files ---
rm -f /tmp/feedback_gate_* /tmp/mcp_response* 2>/dev/null || true

# --- Done ---
echo ""
echo -e "${C_GREEN}✓ Feedback Gate Installation Complete!${C_NC}"
echo ""
echo "  MCP Server : $INSTALL_DIR"
echo "  MCP Config : $CURSOR_MCP_FILE"
echo ""
echo -e "${C_BLUE}Next steps:${C_NC}"
echo "  1. Reload Cursor (Cmd+Shift+P → Reload Window)"
echo "  2. Check status bar for green 'FeedBack' indicator"
echo ""
