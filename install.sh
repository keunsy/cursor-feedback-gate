#!/bin/bash

# Feedback Gate - One-Click Installation Script
# Installs Feedback Gate globally for Cursor IDE (macOS / Linux)

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
WHITE='\033[1;37m'
CYAN='\033[0;36m'
NC='\033[0m'

log_error()    { echo -e "${RED}ERROR: $1${NC}"; }
log_success()  { echo -e "${GREEN}SUCCESS: $1${NC}"; }
log_info()     { echo -e "${YELLOW}INFO: $1${NC}"; }
log_progress() { echo -e "${CYAN}PROGRESS: $1${NC}"; }
log_warning()  { echo -e "${YELLOW}WARNING: $1${NC}"; }
log_step()     { echo -e "${WHITE}$1${NC}"; }

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"

echo -e "${BLUE}Feedback Gate - One-Click Installation${NC}"
echo -e "${BLUE}=========================================${NC}"
echo ""

# --- Detect OS ---
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    OS="linux"
elif [[ "$OSTYPE" == "darwin"* ]]; then
    OS="macos"
else
    log_error "Unsupported OS: $OSTYPE (Linux and macOS only)"
    exit 1
fi
log_success "Detected OS: $OS"

# --- Check Python 3 ---
if ! command -v python3 &> /dev/null; then
    log_error "Python 3 is required but not installed"
    exit 1
fi
log_success "Python 3 found: $(python3 --version)"

# --- Optional: install SoX for speech-to-text ---
log_progress "Checking SoX (for speech-to-text, optional)..."
if command -v sox &> /dev/null; then
    log_success "SoX already installed"
else
    if [[ "$OS" == "macos" ]]; then
        if command -v brew &> /dev/null; then
            brew install sox 2>/dev/null || log_warning "SoX install failed — speech features disabled"
        else
            log_warning "Homebrew not found — skipping SoX (speech features disabled)"
        fi
    else
        sudo apt-get update -qq && sudo apt-get install -y -qq sox 2>/dev/null || log_warning "SoX install failed — speech features disabled"
    fi
fi

# --- Create installation directory ---
INSTALL_DIR="$HOME/cursor-extensions/feedback-gate"
log_progress "Installing to $INSTALL_DIR ..."
mkdir -p "$INSTALL_DIR"

cp "$SCRIPT_DIR/feedback_gate_mcp.py" "$INSTALL_DIR/"

# --- Python venv ---
log_progress "Creating Python virtual environment..."
if [[ "$OS" == "linux" ]]; then
    dpkg -s python3-venv >/dev/null 2>&1 || sudo apt-get install -y python3-venv
fi

if [[ ! -d "$INSTALL_DIR/venv" ]]; then
    python3 -m venv "$INSTALL_DIR/venv"
fi
source "$INSTALL_DIR/venv/bin/activate"
pip install --upgrade pip -q

log_progress "Installing Python dependencies..."
pip install -q "mcp>=1.9.2" "Pillow>=10.0.0" "typing-extensions>=4.14.0"

if pip install -q "faster-whisper>=1.0.0" 2>/dev/null; then
    log_success "faster-whisper installed (speech-to-text enabled)"
else
    log_warning "faster-whisper install failed — speech-to-text disabled"
fi

deactivate
log_success "Python environment ready"

# --- MCP configuration ---
CURSOR_MCP_FILE="$HOME/.cursor/mcp.json"
log_progress "Configuring MCP..."
mkdir -p "$HOME/.cursor"

if [[ -f "$CURSOR_MCP_FILE" ]]; then
    cp "$CURSOR_MCP_FILE" "$CURSOR_MCP_FILE.backup.$(date +%Y%m%d_%H%M%S)"
    log_info "Existing MCP config backed up"
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
log_success "MCP configuration updated: $CURSOR_MCP_FILE"

# --- Build & Install Cursor extension ---
VSIX_FILE=$(find "$SCRIPT_DIR/cursor-extension" -name "*.vsix" -print -quit 2>/dev/null)

if [[ -z "$VSIX_FILE" ]]; then
    log_progress "No .vsix found, building extension..."
    if command -v npx &> /dev/null; then
        (cd "$SCRIPT_DIR/cursor-extension" && npx @vscode/vsce package --no-dependencies 2>/dev/null)
        VSIX_FILE=$(find "$SCRIPT_DIR/cursor-extension" -name "*.vsix" -print -quit 2>/dev/null)
        if [[ -n "$VSIX_FILE" ]]; then
            log_success "Extension built: $(basename "$VSIX_FILE")"
        else
            log_warning "Extension build failed — install manually later"
        fi
    else
        log_warning "npx not found — cannot build extension automatically"
        log_info "Install Node.js, then run: cd cursor-extension && npx @vscode/vsce package --no-dependencies"
    fi
fi

if [[ -n "$VSIX_FILE" ]]; then
    log_progress "Installing Cursor extension..."
    cp "$VSIX_FILE" "$INSTALL_DIR/"

    INSTALLED=false
    if [[ "$OS" == "macos" ]]; then
        CURSOR_BIN="/Applications/Cursor.app/Contents/Resources/app/bin/cursor"
    else
        CURSOR_BIN=$(command -v cursor 2>/dev/null || echo "")
    fi
    if [[ -n "$CURSOR_BIN" && -x "$CURSOR_BIN" ]]; then
        if "$CURSOR_BIN" --install-extension "$VSIX_FILE" --force >/dev/null 2>&1; then
            log_success "Extension installed automatically"
            INSTALLED=true
        fi
    fi

    if [[ "$INSTALLED" == false ]]; then
        echo ""
        echo -e "${BLUE}Manual extension installation:${NC}"
        log_step "  1. Open Cursor → Cmd+Shift+P → 'Extensions: Install from VSIX'"
        log_step "  2. Select: $VSIX_FILE"
        log_step "  3. Reload Window"
    fi
fi

# --- Install Cursor Rule ---
if [[ -f "$SCRIPT_DIR/FeedbackGate.mdc" ]]; then
    CURSOR_RULES_DIR="$HOME/.cursor/rules"
    mkdir -p "$CURSOR_RULES_DIR"
    cp "$SCRIPT_DIR/FeedbackGate.mdc" "$CURSOR_RULES_DIR/"
    log_success "Rule installed to: $CURSOR_RULES_DIR/FeedbackGate.mdc"
fi

# --- Clean up stale temp files ---
rm -f /tmp/feedback_gate_* /tmp/mcp_response* 2>/dev/null || true

# --- Done ---
echo ""
log_success "Feedback Gate Installation Complete!"
echo -e "${GREEN}=========================================${NC}"
echo ""
log_step "  MCP Server : $INSTALL_DIR"
log_step "  MCP Config : $CURSOR_MCP_FILE"
echo ""
echo -e "${BLUE}Next steps:${NC}"
log_step "  1. Reload Cursor (Cmd+Shift+P → Reload Window)"
log_step "  2. Check status bar for green 'FeedBack' indicator"
log_step "  3. Add Feedback Gate rule to Cursor Settings → Rules"
echo ""
