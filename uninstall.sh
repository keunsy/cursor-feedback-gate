#!/bin/bash

# Feedback Gate - Uninstaller

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
WHITE='\033[1;37m'
NC='\033[0m'

log_error()    { echo -e "${RED}ERROR: $1${NC}"; }
log_success()  { echo -e "${GREEN}SUCCESS: $1${NC}"; }
log_info()     { echo -e "${YELLOW}INFO: $1${NC}"; }
log_progress() { echo -e "${BLUE}PROGRESS: $1${NC}"; }
log_step()     { echo -e "${WHITE}$1${NC}"; }

echo -e "${BLUE}Feedback Gate - Uninstaller${NC}"
echo -e "${BLUE}=============================${NC}"
echo ""

read -p "$(echo -e ${YELLOW}Uninstall Feedback Gate? [y/N]: ${NC})" -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    log_info "Cancelled"
    exit 0
fi

INSTALL_DIR="$HOME/cursor-extensions/feedback-gate"
MCP_FILE="$HOME/.cursor/mcp.json"

# --- Remove installation directory ---
if [[ -d "$INSTALL_DIR" ]]; then
    rm -rf "$INSTALL_DIR"
    log_success "Removed: $INSTALL_DIR"
else
    log_info "Installation directory not found, skipping"
fi

# --- Remove feedback-gate from MCP config (preserve other servers) ---
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
    log_success "Removed feedback-gate from MCP config (backup created)"
fi

# --- Clean up temp files ---
rm -f /tmp/feedback_gate_* /tmp/mcp_response* 2>/dev/null || true
TEMP_DIR=$(python3 -c 'import tempfile; print(tempfile.gettempdir())' 2>/dev/null || echo "/tmp")
rm -f "$TEMP_DIR"/feedback_gate_* "$TEMP_DIR"/mcp_response* 2>/dev/null || true
log_success "Cleaned up temporary files"

# --- Remove Cursor extension ---
CURSOR_BIN="/Applications/Cursor.app/Contents/Resources/app/bin/cursor"
if [[ -x "$CURSOR_BIN" ]]; then
    if "$CURSOR_BIN" --uninstall-extension keunsy.cursor-feedback-gate >/dev/null 2>&1; then
        log_success "Extension removed automatically"
    else
        echo ""
        log_step "  Manual step: Open Cursor → Extensions → find 'Feedback Gate' → Uninstall"
    fi
else
    echo ""
    log_step "  Manual step: Open Cursor → Extensions → find 'Feedback Gate' → Uninstall"
fi

echo ""
log_success "Feedback Gate uninstalled!"
echo ""
