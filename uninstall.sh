#!/bin/bash

# Feedback Gate - Uninstaller

set -e

C_RED='\033[0;31m' C_GREEN='\033[0;32m' C_YELLOW='\033[1;33m'
C_BLUE='\033[0;34m' C_NC='\033[0m'

ok()   { echo -e "${C_GREEN}✓ $1${C_NC}"; }
warn() { echo -e "${C_YELLOW}⚠ $1${C_NC}"; }

echo -e "${C_BLUE}Feedback Gate - Uninstaller${C_NC}"
echo ""

read -p "$(echo -e ${C_YELLOW}Uninstall Feedback Gate? [y/N]: ${C_NC})" -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    warn "Cancelled"
    exit 0
fi

INSTALL_DIR="$HOME/cursor-extensions/feedback-gate"
MCP_FILE="$HOME/.cursor/mcp.json"

# --- Remove installation directory ---
if [[ -d "$INSTALL_DIR" ]]; then
    rm -rf "$INSTALL_DIR"
    ok "Removed: $INSTALL_DIR"
else
    warn "Installation directory not found, skipping"
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
    ok "Removed feedback-gate from MCP config"
fi

# --- Remove Cursor Rule ---
CURSOR_RULES_DIR="$HOME/.cursor/rules"
if [[ -f "$CURSOR_RULES_DIR/FeedbackGate.mdc" ]]; then
    rm -f "$CURSOR_RULES_DIR/FeedbackGate.mdc"
    ok "Removed rule: $CURSOR_RULES_DIR/FeedbackGate.mdc"
fi

# --- Clean up temp files ---
rm -f /tmp/feedback_gate_* /tmp/mcp_response* 2>/dev/null || true
TEMP_DIR=$(python3 -c 'import tempfile; print(tempfile.gettempdir())' 2>/dev/null || echo "/tmp")
rm -f "$TEMP_DIR"/feedback_gate_* "$TEMP_DIR"/mcp_response* 2>/dev/null || true
ok "Cleaned up temporary files"

# --- Remove Cursor extension ---
if [[ "$OSTYPE" == "darwin"* ]]; then
    CURSOR_BIN="/Applications/Cursor.app/Contents/Resources/app/bin/cursor"
else
    CURSOR_BIN=$(command -v cursor 2>/dev/null || echo "")
fi
if [[ -n "$CURSOR_BIN" && -x "$CURSOR_BIN" ]]; then
    if "$CURSOR_BIN" --uninstall-extension keunsy.cursor-feedback-gate >/dev/null 2>&1; then
        ok "Extension removed"
    else
        warn "Manual step: Cursor → Extensions → 'Feedback Gate' → Uninstall"
    fi
else
    warn "Manual step: Cursor → Extensions → 'Feedback Gate' → Uninstall"
fi

echo ""
ok "Feedback Gate uninstalled!"
echo ""
