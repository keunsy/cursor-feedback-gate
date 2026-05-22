#!/usr/bin/env python3
"""
Feedback Gate - MCP Server with Cursor Integration
Provides popup chat for AI agent feedback collection in Cursor IDE.

Requirements:
- mcp>=1.9.2
- Python 3.8+
"""

import asyncio
import json
import sys
import logging
import os
import time
import uuid
import glob
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional, Sequence

from mcp.server import Server
from mcp.server.models import InitializationOptions
from mcp.server.stdio import stdio_server
from mcp.types import (
    CallToolRequest,
    ListToolsRequest,
    TextContent,
    Tool,
    CallToolResult,
    Resource,
    ImageContent,
    EmbeddedResource,
)

# Cross-platform temp directory helper
def get_temp_path(filename: str) -> str:
    """Get cross-platform temporary file path"""
    # Use /tmp/ for macOS and Linux, system temp for Windows
    if os.name == 'nt':  # Windows
        temp_dir = tempfile.gettempdir()
    else:  # macOS and Linux
        temp_dir = '/tmp'
    return os.path.join(temp_dir, filename)

# Configure logging with immediate flush
log_file_path = get_temp_path('feedback_gate.log')

# Backward compat: old extension checks feedback_gate_v2.log for MCP status
_legacy_log = get_temp_path('feedback_gate_v2.log')
try:
    if os.path.islink(_legacy_log) or not os.path.exists(_legacy_log):
        if os.path.islink(_legacy_log):
            os.unlink(_legacy_log)
        os.symlink(log_file_path, _legacy_log)
except OSError:
    pass

from logging.handlers import RotatingFileHandler

handlers = []
try:
    file_handler = RotatingFileHandler(
        log_file_path, mode='a', encoding='utf-8',
        maxBytes=10 * 1024 * 1024,  # 10 MB per file
        backupCount=3,               # keep 3 rotated files
    )
    file_handler.setLevel(logging.INFO)
    handlers.append(file_handler)
except Exception as e:
    print(f"Warning: Could not create log file: {e}", file=sys.stderr)

stderr_handler = logging.StreamHandler(sys.stderr)
stderr_handler.setLevel(logging.INFO)
handlers.append(stderr_handler)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - [PID:%(process)d] %(message)s',
    handlers=handlers
)
logger = logging.getLogger(__name__)
logger.info(f"🔧 Log file path: {log_file_path}")

# Force immediate log flushing
for handler in logger.handlers:
    if hasattr(handler, 'flush'):
        handler.flush()

# === Compact event log for request-time correlation ===
_event_log_path = get_temp_path('feedback_gate_events.log')
_event_logger = logging.getLogger('fg_events')
_event_logger.setLevel(logging.INFO)
_event_logger.propagate = False
try:
    _evt_handler = RotatingFileHandler(
        _event_log_path, mode='a', encoding='utf-8',
        maxBytes=2 * 1024 * 1024, backupCount=1,
    )
    _evt_handler.setFormatter(logging.Formatter('%(asctime)s | %(message)s', datefmt='%Y-%m-%d %H:%M:%S'))
    _event_logger.addHandler(_evt_handler)
except Exception:
    pass

_last_entered_time: float = 0.0
_last_event_time: float = 0.0

def _log_event(event_type: str, detail: str = ""):
    """Write a single-line event to the compact event log.
    For ENTERED events, also logs the gap since last ENTERED/HEARTBEAT/CANCELLED
    to help distinguish same-turn re-calls from new requests."""
    global _last_entered_time, _last_event_time
    pid = os.getpid()
    now = time.time()
    gap_info = ""
    if event_type == "ENTERED":
        if _last_event_time > 0:
            gap = now - _last_event_time
            if gap < 1.5:
                gap_info = f" gap={gap:.2f}s(same-turn)"
            elif gap < 15:
                gap_info = f" gap={gap:.1f}s(maybe-new-req)"
            else:
                gap_info = f" gap={gap:.0f}s(new-req)"
        _last_entered_time = now
    _last_event_time = now
    _event_logger.info(f"PID:{pid} | {event_type} | {detail}{gap_info}")
    for h in _event_logger.handlers:
        h.flush()

class FeedbackGateServer:
    def __init__(self):
        self.server = Server("feedback-gate")
        self.setup_handlers()
        self.shutdown_requested = False
        self.shutdown_reason = ""
        self._last_attachments = []
        self._last_files = []
        self._server_pid = os.getpid()
        self._active_triggers = {}
        self._last_responded_by_session = {}
        
        # Clean up stale files from dead MCP instances before writing our own PID
        self._cleanup_stale_files()
        
        # Write PID file so the extension can discover which MCP server belongs to it
        self._write_pid_file()
        
        logger.info(f"🚀 Feedback Gate 2.0 server initialized (PID: {self._server_pid}) for Cursor integration")
        # Ensure log is written immediately
        for handler in logger.handlers:
            if hasattr(handler, 'flush'):
                handler.flush()

    def _find_routing_file(self) -> Optional[Path]:
        """Find the routing file for Feedback Gate.
        
        cursor-remote-control writes session-specific routing files and passes their path
        via FEEDBACK_GATE_ROUTING_FILE env var. Only the MCP instance spawned by that
        specific Agent CLI will have this env var, preventing cross-instance pollution.
        
        No legacy fallback — Cursor IDE MCP instances must not read stale routing files.
        """
        # Only set by cursor-remote-control for this specific Agent CLI session.
        # No legacy fallback — prevents Cursor IDE MCP from being
        # misidentified as remote mode when a stale routing file exists.
        rf_env = os.environ.get("FEEDBACK_GATE_ROUTING_FILE", "")
        if rf_env:
            p = Path(rf_env)
            if p.exists():
                return p
        
        return None

    def _cleanup_stale_files(self):
        """Remove temp files from dead MCP instances only.
        
        For files containing a PID (in filename or content), verify the process
        is dead before deleting.  For generic files without PID info, only delete
        if the file is older than 10 minutes to avoid racing with live instances.
        """
        temp_dir = get_temp_path("")
        cleaned = 0
        stale_threshold = time.time() - 600  # 10 minutes
        
        def _extract_pid_from_filename(filepath):
            """Extract PID from filenames like feedback_gate_trigger_pid12345.json"""
            import re
            m = re.search(r'_pid(\d+)', os.path.basename(filepath))
            return int(m.group(1)) if m else None
        
        def _is_pid_alive(pid):
            if pid is None or pid == self._server_pid:
                return True
            try:
                os.kill(pid, 0)
                return True
            except OSError:
                return False
        
        try:
            for pattern in [
                "feedback_gate_mcp_*.pid",
                "feedback_gate_trigger_pid*.json",
                "feedback_gate_trigger.json",
                "feedback_gate_response_*.json",
                "feedback_gate_response.json",
                "feedback_gate_ack_*.json",
                "feedback_gate_queue_*.json",
                "mcp_response_fg_*.json",
                "mcp_response_*.json",
            ]:
                for filepath in glob.glob(os.path.join(temp_dir, pattern)):
                    try:
                        if pattern.endswith(".pid"):
                            data = json.loads(Path(filepath).read_text())
                            if _is_pid_alive(data.get("pid")):
                                continue
                        else:
                            pid_in_name = _extract_pid_from_filename(filepath)
                            if pid_in_name is not None:
                                if _is_pid_alive(pid_in_name):
                                    continue
                            else:
                                mtime = os.path.getmtime(filepath)
                                if mtime > stale_threshold:
                                    continue
                        Path(filepath).unlink()
                        cleaned += 1
                    except Exception:
                        pass
            if cleaned:
                logger.info(f"🧹 Startup cleanup: removed {cleaned} stale files from {temp_dir}")
        except Exception as e:
            logger.warning(f"⚠️ Startup cleanup error: {e}")

    def _write_pid_file(self):
        """Write a PID-specific marker file so the extension can identify its MCP server instance.
        
        Includes PPID (parent process ID) which is the extension-host process that launched
        this MCP server. The extension can match its own process.pid against this PPID to
        bind to the correct MCP instance in multi-window setups.
        """
        try:
            pid_file = Path(get_temp_path(f"feedback_gate_mcp_{self._server_pid}.pid"))
            pid_data = {
                "pid": self._server_pid,
                "ppid": os.getppid(),
                "timestamp": datetime.now().isoformat(),
                "system": "feedback-gate"
            }
            pid_file.write_text(json.dumps(pid_data))
            logger.info(f"📝 PID file written: {pid_file} (PPID: {os.getppid()})")
        except Exception as e:
            logger.error(f"❌ Failed to write PID file: {e}")

    def setup_handlers(self):
        """Set up MCP request handlers"""
        
        @self.server.list_tools()
        async def list_tools():
            """List available Feedback Gate tools for Cursor Agent"""
            logger.info("🔧 Cursor Agent requesting available tools")
            tools = [
                Tool(
                    name="feedback_gate_chat",
                    description="Open Feedback Gate chat popup in Cursor for feedback. Use this when you need user input, feedback, or feedback from the human user. The popup will appear in Cursor and wait for user response. IMPORTANT: If the tool returns a [WAITING] status, you MUST immediately re-call this tool with the same message AND the same session_id — the user is still being waited on and the request is active. Keep re-calling until you receive a 'User Response:' reply. WARNING: If you are a subagent (launched via Task tool), DO NOT call this tool — it will hang and block the main Agent. Return your result directly instead.",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "message": {
                                "type": "string",
                                "description": "The message to display in the Feedback Gate popup - this is what the user will see",
                                "default": "请提供你的反馈："
                            },
                            "title": {
                                "type": "string", 
                                "description": "Title for the Feedback Gate popup window",
                                "default": "Feedback Gate"
                            },
                            "context": {
                                "type": "string",
                                "description": "Additional context about what needs feedback (code, implementation, etc.)",
                                "default": ""
                            },
                            "urgent": {
                                "type": "boolean",
                                "description": "Whether this is an urgent feedback request",
                                "default": False
                            },
                            "session_id": {
                                "type": "string",
                                "description": "Unique session identifier for this conversation. Generate a random UUID on your FIRST call and reuse the SAME value for all subsequent re-entry calls (when you receive [WAITING]). This ensures multiple conversations can use Feedback Gate simultaneously without interference.",
                                "default": ""
                            }
                        }
                    }
                )
            ]
            logger.info(f"✅ Listed {len(tools)} Feedback Gate tools for Cursor Agent")
            return tools

        @self.server.call_tool()
        async def call_tool(name: str, arguments: dict):
            """Handle tool calls from Cursor Agent with immediate activation"""
            logger.info(f"🎯 CURSOR AGENT CALLED TOOL: {name}")
            logger.info(f"📋 Tool arguments: {arguments}")
            
            logger.info(f"⚙️ Processing tool call: {name}")
            
            try:
                if name == "feedback_gate_chat":
                    return await self._handle_feedback_gate_chat(arguments)
                else:
                    logger.error(f"❌ Unknown tool: {name}")
                    await asyncio.sleep(1.0)
                    raise ValueError(f"Unknown tool: {name}")
            except asyncio.CancelledError:
                logger.warning(f"⚠️ [DIAG] Tool call CANCELLED for {name} | pending_trigger={self._pending_trigger_id} | This means Cursor IDE aborted the MCP call (possible IDE-level timeout or user Stop)")
                _log_event("CANCELLED", f"tool={name} trigger={self._pending_trigger_id}")
                if self._pending_trigger_id:
                    response_file = Path(get_temp_path(f"feedback_gate_response_{self._pending_trigger_id}.json"))
                    if response_file.exists():
                        logger.info(f"⚠️ [DIAG] Response file exists on cancel for trigger {self._pending_trigger_id} — marking for next-call delivery (NOT consuming now to avoid data loss)")
                        _log_event("CANCEL_RESPONSE_PENDING", f"trigger={self._pending_trigger_id}")
                    else:
                        logger.info(f"🔒 [DIAG] PRESERVING pending trigger {self._pending_trigger_id} — no response file yet, popup is still alive")
                raise
            except Exception as e:
                logger.error(f"💥 Tool call error for {name}: {e}")
                if self._pending_trigger_id:
                    logger.warning(f"🧹 Clearing pending trigger {self._pending_trigger_id} due to exception")
                    self._active_triggers.pop(self._pending_trigger_id, None)
                    self._clear_trigger_state(responded=False)
                await asyncio.sleep(1.0)
                return [TextContent(type="text", text=f"ERROR: Tool {name} failed: {str(e)}")]

    _pending_trigger_id: str | None = None
    _pending_trigger_created_at: float = 0
    _pending_trigger_message: str = ""
    _last_trigger_responded_at: float = 0
    _heartbeat_count: int = 0
    _STALE_TRIGGER_SECONDS_CLI: int = 120
    _STALE_TRIGGER_SECONDS_IDE: int = 86400

    def _clear_trigger_state(self, responded: bool = False):
        """Reset all trigger tracking fields consistently.
        
        Args:
            responded: True if user actually responded (sets cooldown),
                      False if timeout/error/stale (no cooldown).
        """
        self._pending_trigger_id = None
        self._pending_trigger_created_at = 0
        self._pending_trigger_message = ""
        self._heartbeat_count = 0
        self._last_trigger_responded_at = time.time() if responded else 0

    def _read_and_consume_response(self, response_file: Path) -> str | None:
        """Read a response JSON file, populate _last_attachments/_last_files, delete the file.
        Returns user_input string or None if parsing failed.
        IMPORTANT: file is only deleted when valid content is extracted — if content
        is empty/unreadable, the file is left intact so the caller can retry later."""
        try:
            file_content = response_file.read_text().strip()
            if not file_content:
                return None

            user_input = ""
            if file_content.startswith('{'):
                data = json.loads(file_content)
                raw = data.get("user_input") or data.get("response") or data.get("message") or ""
                user_input = str(raw).strip()
                attachments = data.get("attachments", [])
                files = data.get("files", [])

                if attachments:
                    self._last_attachments = attachments
                    descs = [f"Image: {a.get('fileName', 'unknown')}" for a in attachments if a.get('mimeType', '').startswith('image/')]
                    if descs:
                        user_input += f"\n\nAttached: {', '.join(descs)}"
                else:
                    self._last_attachments = []

                if files:
                    self._last_files = files
                    file_descs = [f"File: {f.get('fileName', 'unknown')} ({f.get('filePath', '')})" for f in files]
                    if file_descs:
                        user_input += f"\n\nAttached files:\n" + "\n".join(file_descs)
                else:
                    self._last_files = []
            else:
                user_input = file_content
                self._last_attachments = []
                self._last_files = []

            if user_input:
                response_file.unlink(missing_ok=True)
                return user_input
            return None
        except json.JSONDecodeError as e:
            logger.warning(f"⚠️ Response file has invalid JSON (may still be writing): {e}")
            return None
        except Exception as e:
            logger.error(f"❌ Error reading response file {response_file}: {e}")
            self._last_attachments = []
            self._last_files = []
            return None

    def _append_media_to_response(self, response_content: list):
        """Append attachments (images) and file references to a response, then clear state."""
        if self._last_attachments:
            for attachment in self._last_attachments:
                if attachment.get('mimeType', '').startswith('image/'):
                    try:
                        response_content.append(ImageContent(
                            type="image",
                            data=attachment['base64Data'],
                            mimeType=attachment['mimeType']
                        ))
                        logger.info(f"📸 Added image to response: {attachment.get('fileName', 'unknown')}")
                    except Exception as e:
                        logger.error(f"❌ Error adding image to response: {e}")
            self._last_attachments = []

        if self._last_files:
            for file_ref in self._last_files:
                name = file_ref.get('fileName', 'unknown')
                fpath = file_ref.get('filePath', '')
                content = file_ref.get('content', '')
                if content and content not in ('[TOO_LARGE_FOR_QUEUE]', '') and not content.startswith('[File too large'):
                    response_content.append(TextContent(
                        type="text",
                        text=f"--- File: {name} ({fpath}) ---\n{content}"
                    ))
                    logger.info(f"📁 Added file content to response: {name}")
                elif fpath:
                    response_content.append(TextContent(
                        type="text",
                        text=f"--- File reference: {name} ({fpath}) ---"
                    ))
                    logger.info(f"📁 Added file reference to response: {name}")
            self._last_files = []

    # Agent CLI has a hardcoded ~60s MCP tool timeout.  We use 50s as the wait
    # ceiling so there is comfortable margin.
    _REMOTE_WAIT_SECONDS = 50
    _REMOTE_MAX_TOTAL_SECONDS = 86400  # 24h max total wait for CLI

    # Cursor IDE aborts MCP tool calls after exactly 1 hour (3600s).  After 2
    # consecutive aborts the Agent model gives up entirely.  We return a heartbeat
    # every N minutes so the call never hits the 1h limit.
    # Override with FEEDBACK_GATE_IDE_WAIT_SECONDS env var.
    _IDE_WAIT_SECONDS = int(os.environ.get("FEEDBACK_GATE_IDE_WAIT_SECONDS", "600"))
    _IDE_MAX_TOTAL_SECONDS = 86400  # 24h max total wait for IDE

    # Heartbeat config file for dynamic (no-restart) configuration.
    # Falls back to env vars, then defaults.
    _HEARTBEAT_CONFIG_PATH = os.path.join(
        os.path.expanduser("~"), ".cursor", "feedback-gate-config.json"
    )

    @classmethod
    def _load_heartbeat_config(cls) -> tuple[str, str, int | None, int | None]:
        """Read heartbeat mode, reply, optional wait_seconds, and optional stale_seconds from config file.
        Config file is re-read on every heartbeat so changes take effect
        without restarting the MCP server.
        Returns (mode, reply, wait_seconds_override_or_None, stale_seconds_override_or_None)."""
        mode = os.environ.get("FEEDBACK_GATE_HEARTBEAT_MODE", "waiting").lower()
        reply = os.environ.get("FEEDBACK_GATE_HEARTBEAT_REPLY", "当前时间")
        wait_override: int | None = None
        stale_override: int | None = None
        try:
            cfg_path = Path(cls._HEARTBEAT_CONFIG_PATH)
            if cfg_path.exists():
                cfg = json.loads(cfg_path.read_text())
                mode = cfg.get("heartbeat_mode", mode).lower()
                reply = cfg.get("heartbeat_reply", reply)
                if "wait_seconds" in cfg:
                    wait_override = int(cfg["wait_seconds"])
                if "stale_seconds" in cfg:
                    stale_override = int(cfg["stale_seconds"])
        except Exception as e:
            logger.debug(f"Failed to read heartbeat config: {e}")
        return mode, reply, wait_override, stale_override

    @staticmethod
    def _build_heartbeat_message(count: int, elapsed_min: float, session_id: str = "") -> str:
        """Build a varied heartbeat message so the Agent doesn't give up after
        seeing the same text repeatedly.  The core instruction (re-call the tool)
        stays identical; only the preamble rotates."""
        preambles = [
            "The user hasn't responded yet.",
            f"Still waiting for the user's reply (~{elapsed_min:.0f} min elapsed).",
            "No reply from the user so far — this is normal, they may be busy.",
            f"Heartbeat #{count}: the feedback request is still active.",
            "The user may take a while to respond — keep the channel open.",
            f"~{elapsed_min:.0f} minutes have passed. The user is expected to reply eventually.",
            "Continuing to hold for user feedback.",
            f"Waiting cycle #{count}. The user has been notified and will reply when ready.",
        ]
        preamble = preambles[(count - 1) % len(preambles)]
        sid_instruction = f' Use session_id="{session_id}".' if session_id else ""
        return (
            f"[WAITING] {preamble} "
            "You MUST immediately call feedback_gate_chat again with the same message "
            f"and the same session_id to continue waiting.{sid_instruction} "
            "Do NOT end your response or summarize — just call the tool again now."
        )

    def _build_heartbeat_response(self, count: int, elapsed_min: float, session_id: str = "") -> str:
        """Return heartbeat text based on configured mode (re-reads config file).
        - 'waiting' (default): [WAITING] + re-call instruction
        - 'user_response': fake User Response to keep a normal Agent cycle
        """
        mode, reply, _, _ = self._load_heartbeat_config()
        if mode == "user_response":
            logger.info(f"💓 Heartbeat using user_response mode: '{reply}'")
            return f"User Response: {reply}"
        return self._build_heartbeat_message(count, elapsed_min, session_id=session_id)

    async def _handle_feedback_gate_chat(self, args: dict) -> list[TextContent]:
        """Handle Feedback Gate chat popup and wait for user input with 5 minute timeout"""
        message = args.get("message", "请提供你的反馈：")
        title = args.get("title", "Feedback Gate")
        context = args.get("context", "")
        urgent = args.get("urgent", False)
        session_id = args.get("session_id", "").strip()
        
        self._last_attachments = []
        self._last_files = []
        
        call_entry_time = time.time()
        logger.info(f"📥 [DIAG] feedback_gate_chat ENTERED at {datetime.now().isoformat()} | pending_trigger={self._pending_trigger_id} | heartbeat_count={self._heartbeat_count} | session_id={session_id or 'none'} | msg_preview={message[:80]}...")
        _log_event("ENTERED", f"trigger={self._pending_trigger_id} hb={self._heartbeat_count} sid={session_id or 'none'} msg={message[:60]}")
        
        is_remote = bool(self._find_routing_file())
        
        # --- Multi-conversation support ---
        # Match existing trigger by session_id (preferred) or message content (fallback).
        # session_id: agent generates a UUID on first call and reuses on re-entry.
        # message fallback: for agents that don't support session_id yet.
        #
        # _active_triggers: { trigger_id: { session_id, message, created_at, heartbeat_count } }
        
        # Session match FIRST, then cleanup (so we never evict the re-entering trigger)
        now = time.time()
        my_trigger_id = None
        my_trigger_info = None
        if session_id:
            for tid, info in self._active_triggers.items():
                if info.get("session_id") == session_id:
                    my_trigger_id = tid
                    my_trigger_info = info
                    break
        if not my_trigger_id and not session_id:
            if len(self._active_triggers) == 1:
                tid, info = next(iter(self._active_triggers.items()))
                my_trigger_id = tid
                my_trigger_info = info
            elif len(self._active_triggers) > 1:
                logger.warning(f"⚠️ Multiple active triggers ({len(self._active_triggers)}) without session_id — cannot safely match, creating new trigger")
        
        # Clean up stale triggers (skip the one we just matched)
        stale_limit = self._STALE_TRIGGER_SECONDS_CLI if is_remote else self._STALE_TRIGGER_SECONDS_IDE
        if not is_remote:
            _, _, _, stale_override = self._load_heartbeat_config()
            if stale_override is not None:
                stale_limit = stale_override
        stale_ids = [tid for tid, info in self._active_triggers.items()
                     if tid != my_trigger_id and (now - info.get("created_at", 0)) > stale_limit]
        for tid in stale_ids:
            logger.warning(f"🧹 Clearing stale trigger {tid}")
            _log_event("TRIGGER_EXPIRED", f"trigger={tid}")
            del self._active_triggers[tid]
        
        _MAX_ACTIVE_TRIGGERS = 20
        if len(self._active_triggers) >= _MAX_ACTIVE_TRIGGERS:
            evict_candidates = [t for t in self._active_triggers if t != my_trigger_id]
            if evict_candidates:
                oldest_tid = min(evict_candidates, key=lambda t: self._active_triggers[t].get("created_at", 0))
                logger.warning(f"🧹 Evicting oldest trigger {oldest_tid} (cap={_MAX_ACTIVE_TRIGGERS})")
                del self._active_triggers[oldest_tid]
                if self._pending_trigger_id == oldest_tid:
                    self._clear_trigger_state(responded=False)
        
        _SESSION_COOLDOWN_TTL = 3600
        stale_sessions = [k for k, t in self._last_responded_by_session.items()
                          if (now - t) > _SESSION_COOLDOWN_TTL]
        for k in stale_sessions:
            del self._last_responded_by_session[k]
        
        if self._pending_trigger_id and self._pending_trigger_id not in self._active_triggers:
            stale_age = now - self._pending_trigger_created_at if self._pending_trigger_created_at else float('inf')
            if stale_age > stale_limit:
                self._clear_trigger_state(responded=False)
        
        if my_trigger_id:
            # Same conversation re-entering — check for ready response
            response_file = Path(get_temp_path(f"feedback_gate_response_{my_trigger_id}.json"))
            if response_file.exists():
                ready_input = self._read_and_consume_response(response_file)
                if ready_input:
                    _resp_sid = (my_trigger_info or {}).get("session_id", "") or session_id
                    del self._active_triggers[my_trigger_id]
                    if self._pending_trigger_id == my_trigger_id:
                        self._clear_trigger_state(responded=True)
                    else:
                        self._last_trigger_responded_at = time.time()
                    self._last_responded_by_session[_resp_sid or "__global__"] = time.time()
                    logger.info(f"✅ Found ready response for trigger {my_trigger_id}: {ready_input[:100]}...")
                    _log_event("USER_RESPONSE", f"path=ready-file trigger={my_trigger_id} input={ready_input[:60]}")
                    result = [TextContent(type="text", text=f"User Response: {ready_input}")]
                    self._append_media_to_response(result)
                    return result
            
            # Re-enter wait loop for this trigger
            wait_secs = self._REMOTE_WAIT_SECONDS if is_remote else self._IDE_WAIT_SECONDS
            _, _, wait_override, _ = self._load_heartbeat_config()
            if wait_override is not None and not is_remote:
                wait_secs = wait_override
            max_secs = self._REMOTE_MAX_TOTAL_SECONDS if is_remote else self._IDE_MAX_TOTAL_SECONDS
            label = "CLI" if is_remote else "IDE"
            
            hb_count = my_trigger_info.get("heartbeat_count", 0)
            logger.info(f"🔄 Re-entering wait for trigger {my_trigger_id} (hb={hb_count}, {label}, {wait_secs}s)")
            
            local_wait_task = asyncio.ensure_future(
                self._wait_for_user_input(my_trigger_id, timeout=wait_secs)
            )
            try:
                user_input = await local_wait_task
            except asyncio.CancelledError:
                local_wait_task.cancel()
                try:
                    await local_wait_task
                except (asyncio.CancelledError, Exception):
                    pass
                raise
            
            if user_input:
                _resp_sid = (my_trigger_info or {}).get("session_id", "") or session_id
                del self._active_triggers[my_trigger_id]
                if self._pending_trigger_id == my_trigger_id:
                    self._clear_trigger_state(responded=True)
                else:
                    self._last_trigger_responded_at = time.time()
                self._last_responded_by_session[_resp_sid or "__global__"] = time.time()
                wall_elapsed = time.time() - call_entry_time
                logger.info(f"✅ RE-ENTER got feedback for {my_trigger_id} after {wall_elapsed:.1f}s | input={user_input[:100]}...")
                _log_event("USER_RESPONSE", f"path=re-enter trigger={my_trigger_id} wall={wall_elapsed:.1f}s input={user_input[:60]}")
                result = [TextContent(type="text", text=f"User Response: {user_input}")]
                self._append_media_to_response(result)
                return result
            else:
                hb_count += 1
                my_trigger_info["heartbeat_count"] = hb_count
                elapsed_total = hb_count * wait_secs
                elapsed_min = elapsed_total / 60
                wall_elapsed = time.time() - call_entry_time
                if elapsed_total >= max_secs:
                    del self._active_triggers[my_trigger_id]
                    if self._pending_trigger_id == my_trigger_id:
                        self._clear_trigger_state(responded=False)
                    max_hours = max_secs / 3600
                    logger.warning(f"⏰ RE-ENTER {label} wait exceeded {max_hours:.0f}h ({elapsed_min:.0f}min) for {my_trigger_id}")
                    return [TextContent(type="text", text=f"TIMEOUT: No user input received within {max_hours:.0f} hours ({label} limit). Stopping wait.")]
                logger.info(f"⏳ RE-ENTER heartbeat #{hb_count} | trigger={my_trigger_id} | {wait_secs}s | ~{elapsed_min:.1f}min cumulative")
                _log_event("HEARTBEAT", f"#{hb_count} trigger={my_trigger_id} wall={wall_elapsed:.1f}s cumul={elapsed_min:.1f}min")
                trigger_sid = my_trigger_info.get("session_id", "") if my_trigger_info else ""
                return [TextContent(type="text", text=self._build_heartbeat_response(hb_count, elapsed_min, session_id=trigger_sid))]
        
        # Brief per-session cooldown: avoid rapid re-trigger right after receiving a response.
        # Uses session_id when available; falls back to global only when no session_id is given
        # (single-conversation mode).  With session_id, never fall back to global — that would
        # let conversation A's cooldown block conversation B.
        _cooldown_key = session_id or "__global__"
        _cooldown_last = self._last_responded_by_session.get(_cooldown_key, 0)
        if not _cooldown_last and not session_id:
            _cooldown_last = self._last_responded_by_session.get("__global__", 0)
        if _cooldown_last and (time.time() - _cooldown_last) < 2:
            logger.info(f"⏭️ Feedback Gate skipped: brief cooldown after recent response (key={_cooldown_key})")
            return [TextContent(type="text", text="SKIP: Processing recent feedback. You MUST call feedback_gate_chat again in 2 seconds. Do NOT end your turn.")]
        
        # Model gate: only activate for specific model if FEEDBACK_GATE_MODEL is set
        required_model = os.environ.get("FEEDBACK_GATE_MODEL", "")
        if not required_model:
            routing_file = self._find_routing_file()
            if routing_file and routing_file.exists():
                try:
                    routing_data = json.loads(routing_file.read_text())
                    required_model = routing_data.get("model", "")
                except Exception:
                    pass
        if required_model:
            current_model = os.environ.get("CURSOR_MODEL", "")
            if current_model and current_model.lower() != required_model.lower():
                logger.info(f"⏭️ Feedback Gate skipped: model={current_model}, required={required_model}")
                return [TextContent(type="text", text=f"SKIP: Feedback Gate only enabled for model '{required_model}' (current: '{current_model}'). Continuing without user feedback.")]
        
        logger.info(f"💬 ACTIVATING Feedback Gate chat popup IMMEDIATELY for Cursor Agent")
        logger.info(f"📝 Title: {title}")
        logger.info(f"📄 Message: {message}")
        
        # Create trigger file for Cursor extension IMMEDIATELY
        trigger_id = f"fg_{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}"
        
        # Force immediate trigger creation with enhanced debugging
        success = await self._trigger_cursor_popup_immediately({
            "tool": "feedback_gate_chat",
            "message": message,
            "title": title,
            "context": context,
            "urgent": urgent,
            "trigger_id": trigger_id,
            "session_id": session_id,
            "timestamp": datetime.now().isoformat(),
            "immediate_activation": True
        })
        
        if success:
            # Register in both legacy state and new per-trigger tracking
            self._pending_trigger_id = trigger_id
            self._pending_trigger_created_at = time.time()
            self._pending_trigger_message = message
            self._heartbeat_count = 0
            self._active_triggers[trigger_id] = {
                "session_id": session_id,
                "message": message,
                "created_at": time.time(),
                "heartbeat_count": 0,
            }
            logger.info(f"🔥 POPUP TRIGGERED - waiting for user input (trigger_id: {trigger_id}, session_id={session_id or 'none'}, active_triggers={len(self._active_triggers)})")
            _log_event("NEW_TRIGGER", f"trigger={trigger_id} active={len(self._active_triggers)} msg={message[:60]}")
            
            # Quick check: is the extension alive?
            # The extension polls every 250ms and deletes trigger files immediately.
            # We only check the PID-namespaced file since that's what we actually write.
            pid_trigger_file = Path(get_temp_path(f"feedback_gate_trigger_pid{self._server_pid}.json"))
            extension_alive = False
            for _ in range(10):
                await asyncio.sleep(0.5)
                if not pid_trigger_file.exists():
                    extension_alive = True
                    break
            
            if not extension_alive:
                logger.warning("⚠️ Trigger file not consumed — no Feedback Gate extension detected")
                self._active_triggers.pop(trigger_id, None)
                self._clear_trigger_state(responded=False)
                try:
                    pid_trigger_file.unlink(missing_ok=True)
                    Path(get_temp_path("feedback_gate_trigger.json")).unlink(missing_ok=True)
                except Exception:
                    pass
                return [TextContent(type="text", text="SKIP: Feedback Gate extension is not active (no GUI detected). Continuing without user feedback.")]
            
            ack_received = await self._wait_for_extension_acknowledgement(trigger_id, timeout=15)
            if ack_received:
                logger.info("📨 Extension acknowledged popup activation")
            else:
                logger.warning("⚠️ No extension acknowledgement received — but trigger was consumed, proceeding")
            
            wait_secs = self._REMOTE_WAIT_SECONDS if is_remote else self._IDE_WAIT_SECONDS
            _, _, wait_override, _ = self._load_heartbeat_config()
            if wait_override is not None and not is_remote:
                wait_secs = wait_override
            max_secs = self._REMOTE_MAX_TOTAL_SECONDS if is_remote else self._IDE_MAX_TOTAL_SECONDS
            label = "CLI" if is_remote else "IDE"
            logger.info(f"⏳ Waiting for user input (timeout={wait_secs}s, {label})...")
            
            local_wait_task = asyncio.ensure_future(
                self._wait_for_user_input(trigger_id, timeout=wait_secs)
            )
            try:
                user_input = await local_wait_task
            except asyncio.CancelledError:
                local_wait_task.cancel()
                try:
                    await local_wait_task
                except (asyncio.CancelledError, Exception):
                    pass
                raise
            
            if user_input:
                self._active_triggers.pop(trigger_id, None)
                if self._pending_trigger_id == trigger_id:
                    self._clear_trigger_state(responded=True)
                else:
                    self._last_trigger_responded_at = time.time()
                self._last_responded_by_session[session_id or "__global__"] = time.time()
                wall_elapsed = time.time() - call_entry_time
                logger.info(f"✅ Got feedback for {trigger_id} after {wall_elapsed:.1f}s | input={user_input[:100]}...")
                _log_event("USER_RESPONSE", f"path=first-wait trigger={trigger_id} wall={wall_elapsed:.1f}s input={user_input[:60]}")
                result = [TextContent(type="text", text=f"User Response: {user_input}")]
                self._append_media_to_response(result)
                return result
            else:
                trigger_info = self._active_triggers.get(trigger_id)
                if trigger_info:
                    trigger_info["heartbeat_count"] = trigger_info.get("heartbeat_count", 0) + 1
                    hb_count = trigger_info["heartbeat_count"]
                else:
                    hb_count = 1
                elapsed_total = hb_count * wait_secs
                elapsed_min = elapsed_total / 60
                wall_elapsed = time.time() - call_entry_time
                if elapsed_total >= max_secs:
                    self._active_triggers.pop(trigger_id, None)
                    if self._pending_trigger_id == trigger_id:
                        self._clear_trigger_state(responded=False)
                    max_hours = max_secs / 3600
                    logger.warning(f"⏰ {label} wait exceeded {max_hours:.0f}h ({elapsed_min:.0f}min) for {trigger_id}")
                    return [TextContent(type="text", text=f"TIMEOUT: No user input received within {max_hours:.0f} hours ({label} limit). Stopping wait.")]
                logger.info(f"⏳ {label} heartbeat #{hb_count} | trigger={trigger_id} | {wait_secs}s | ~{elapsed_min:.1f}min cumulative")
                _log_event("HEARTBEAT", f"#{hb_count} trigger={trigger_id} wall={wall_elapsed:.1f}s cumul={elapsed_min:.1f}min")
                return [TextContent(type="text", text=self._build_heartbeat_response(hb_count, elapsed_min, session_id=session_id))]
        else:
            response = f"ERROR: Failed to trigger Feedback Gate popup"
            logger.error("❌ Failed to trigger Feedback Gate popup")
            return [TextContent(type="text", text=response)]

    async def _handle_get_user_input(self, args: dict) -> list[TextContent]:
        """Retrieve user input from any available response files"""
        timeout = args.get("timeout", 10)
        
        logger.info(f"🔍 CHECKING for user input (timeout: {timeout}s)")
        
        response_patterns = [
            os.path.join(tempfile.gettempdir(), "feedback_gate_response_*.json"),
            get_temp_path("feedback_gate_response.json"),
        ]
        
        start_time = time.time()
        
        while time.time() - start_time < timeout:
            try:
                # Check all response patterns
                for pattern in response_patterns:
                    matching_files = glob.glob(pattern)
                    for response_file_path in matching_files:
                        response_file = Path(response_file_path)
                        if response_file.exists():
                            try:
                                file_content = response_file.read_text().strip()
                                logger.info(f"📄 Found response file {response_file}: {file_content[:200]}...")
                                
                                # Handle JSON format
                                if file_content.startswith('{'):
                                    data = json.loads(file_content)
                                    raw = data.get("user_input") or data.get("response") or data.get("message") or ""
                                    user_input = str(raw).strip()
                                # Handle plain text format
                                else:
                                    user_input = file_content
                                
                                if user_input:
                                    # Clean up all response file patterns written by the extension
                                    cleanup_patterns = [
                                        response_file,
                                        Path(get_temp_path("feedback_gate_response.json")),
                                    ]
                                    for cf in cleanup_patterns:
                                        try:
                                            cf.unlink(missing_ok=True)
                                        except Exception:
                                            pass
                                    logger.info(f"🧹 Response files cleaned up")
                                    
                                    logger.info(f"✅ RETRIEVED USER INPUT: {user_input[:100]}...")
                                    
                                    result_message = f"✅ User Input Retrieved\n\n"
                                    result_message += f"💬 User Response: {user_input}\n"
                                    result_message += f"📁 Source File: {response_file.name}\n"
                                    result_message += f"⏰ Retrieved at: {datetime.now().isoformat()}\n\n"
                                    result_message += f"🎯 User input successfully captured from Feedback Gate."
                                    
                                    return [TextContent(type="text", text=result_message)]
                                    
                            except json.JSONDecodeError as e:
                                logger.error(f"❌ JSON decode error in {response_file}: {e}")
                            except Exception as e:
                                logger.error(f"❌ Error processing response file {response_file}: {e}")
                
                await asyncio.sleep(0.2)
                
            except Exception as e:
                logger.error(f"❌ Error in get_user_input loop: {e}")
                await asyncio.sleep(1)
        
        # No input found within timeout
        no_input_message = f"⏰ No user input found within {timeout} seconds\n\n"
        no_input_message += f"🔍 Checked patterns: {', '.join(response_patterns)}\n"
        no_input_message += f"💡 User may not have provided input yet, or the popup may not be active.\n\n"
        no_input_message += f"🎯 Try calling this tool again after the user provides input."
        
        logger.warning(f"⏰ No user input found within {timeout} seconds")
        return [TextContent(type="text", text=no_input_message)]

    async def _handle_quick_feedback(self, args: dict) -> list[TextContent]:
        """Handle quick feedback request and wait for response with immediate activation"""
        prompt = args.get("prompt", "Quick feedback needed:")
        context = args.get("context", "")
        
        logger.info(f"⚡ ACTIVATING Quick Feedback IMMEDIATELY for Cursor Agent: {prompt}")
        
        # Create trigger for quick input IMMEDIATELY
        trigger_id = f"quick_{int(time.time() * 1000)}"
        success = await self._trigger_cursor_popup_immediately({
            "tool": "quick_feedback",
            "prompt": prompt,
            "context": context,
            "title": "Quick Feedback - Feedback Gate",
            "trigger_id": trigger_id,
            "timestamp": datetime.now().isoformat(),
            "immediate_activation": True
        })
        
        if success:
            logger.info(f"🔥 QUICK POPUP TRIGGERED - waiting for user input (trigger_id: {trigger_id})")
            
            # Wait for quick user input
            user_input = await self._wait_for_user_input(trigger_id, timeout=90)  # 1.5 minute timeout for quick feedback
            
            if user_input:
                # Return user input directly to MCP client
                logger.info(f"✅ RETURNING QUICK FEEDBACK TO MCP CLIENT: {user_input}")
                return [TextContent(type="text", text=user_input)]
            else:
                response = f"TIMEOUT: No quick feedback input received within 1.5 minutes"
                logger.warning("⚠️ Quick feedback timed out")
                return [TextContent(type="text", text=response)]
        else:
            response = f"ERROR: Failed to trigger quick feedback popup"
            return [TextContent(type="text", text=response)]

    async def _handle_file_feedback(self, args: dict) -> list[TextContent]:
        """Handle file feedback request and wait for file selection with immediate activation"""
        instruction = args.get("instruction", "Please select file(s) for feedback:")
        file_types = args.get("file_types", ["*"])
        
        logger.info(f"📁 ACTIVATING File Feedback IMMEDIATELY for Cursor Agent: {instruction}")
        
        # Create trigger for file picker IMMEDIATELY
        trigger_id = f"file_{int(time.time() * 1000)}"
        success = await self._trigger_cursor_popup_immediately({
            "tool": "file_feedback",
            "instruction": instruction,
            "file_types": file_types,
            "title": "File Feedback - Feedback Gate",
            "trigger_id": trigger_id,
            "timestamp": datetime.now().isoformat(),
            "immediate_activation": True
        })
        
        if success:
            logger.info(f"🔥 FILE POPUP TRIGGERED - waiting for selection (trigger_id: {trigger_id})")
            
            # Wait for file selection
            user_input = await self._wait_for_user_input(trigger_id, timeout=90)  # 1.5 minute timeout
            
            if user_input:
                response = f"📁 File Feedback completed!\n\n**Selected Files:** {user_input}\n\n**Instruction:** {instruction}\n**Allowed Types:** {', '.join(file_types)}\n\nYou can now proceed to analyze the selected files."
                logger.info(f"✅ FILES SELECTED: {user_input}")
            else:
                response = f"⏰ File Feedback timed out.\n\n**Instruction:** {instruction}\n\nNo files selected within 1.5 minutes. Try again or proceed with current workspace files."
                logger.warning("⚠️ File feedback timed out")
        else:
            response = f"⚠️ File Feedback trigger failed. Manual activation may be needed."
        
        logger.info("🏁 File feedback processing complete")
        return [TextContent(type="text", text=response)]

    async def _handle_ingest_text(self, args: dict) -> list[TextContent]:
        """
        Handle text ingestion with immediate activation and user input capture
        """
        text_content = args.get("text_content", "")
        source = args.get("source", "extension")
        context = args.get("context", "")
        processing_mode = args.get("processing_mode", "immediate")
        
        logger.info(f"🚀 ACTIVATING ingest_text IMMEDIATELY for Cursor Agent: {text_content[:100]}...")
        logger.info(f"📍 Source: {source}, Context: {context}, Mode: {processing_mode}")
        
        # Create trigger for ingest_text IMMEDIATELY (consistent with other tools)
        trigger_id = f"ingest_{int(time.time() * 1000)}"
        success = await self._trigger_cursor_popup_immediately({
            "tool": "ingest_text",
            "text_content": text_content,
            "source": source,
            "context": context,
            "processing_mode": processing_mode,
            "title": "Text Ingestion - Feedback Gate",
            "message": f"Text to process: {text_content}",
            "trigger_id": trigger_id,
            "timestamp": datetime.now().isoformat(),
            "immediate_activation": True
        })
        
        if success:
            logger.info(f"🔥 INGEST POPUP TRIGGERED - waiting for user input (trigger_id: {trigger_id})")
            
            user_input = await self._wait_for_user_input(trigger_id, timeout=120)  # 2 minute timeout
            
            if user_input:
                # Return the user input for further processing
                result_message = f"✅ Text ingestion completed!\n\n"
                result_message += f"📝 Original Text: {text_content}\n"
                result_message += f"💬 User Response: {user_input}\n"
                result_message += f"📍 Source: {source}\n"
                result_message += f"💭 Context: {context}\n"
                result_message += f"⚙️ Processing Mode: {processing_mode}\n\n"
                result_message += f"🎯 The text has been processed and user feedback collected successfully."
                
                logger.info(f"✅ INGEST SUCCESS: User provided feedback for text ingestion")
                return [TextContent(type="text", text=result_message)]
            else:
                result_message = f"⏰ Text ingestion timed out.\n\n"
                result_message += f"📝 Text Content: {text_content}\n"
                result_message += f"📍 Source: {source}\n\n"
                result_message += f"No user response received within 2 minutes. The text content is noted but no additional processing occurred."
                
                logger.warning("⚠️ Text ingestion timed out")
                return [TextContent(type="text", text=result_message)]
        else:
            result_message = f"⚠️ Text ingestion trigger failed.\n\n"
            result_message += f"📝 Text Content: {text_content}\n"
            result_message += f"Manual activation may be needed."
            
            logger.error("❌ Failed to trigger text ingestion popup")
            return [TextContent(type="text", text=result_message)]

    async def _handle_shutdown_mcp(self, args: dict) -> list[TextContent]:
        """Handle shutdown_mcp request and wait for confirmation with immediate activation"""
        reason = args.get("reason", "Task completed successfully")
        immediate = args.get("immediate", False)
        cleanup = args.get("cleanup", True)
        
        logger.info(f"🛑 ACTIVATING shutdown_mcp IMMEDIATELY for Cursor Agent: {reason}")
        
        # Create trigger for shutdown_mcp IMMEDIATELY
        trigger_id = f"shutdown_{int(time.time() * 1000)}"
        success = await self._trigger_cursor_popup_immediately({
            "tool": "shutdown_mcp",
            "reason": reason,
            "immediate": immediate,
            "cleanup": cleanup,
            "title": "Shutdown - Feedback Gate",
            "trigger_id": trigger_id,
            "timestamp": datetime.now().isoformat(),
            "immediate_activation": True
        })
        
        if success:
            logger.info(f"🛑 SHUTDOWN TRIGGERED - waiting for confirmation (trigger_id: {trigger_id})")
            
            # Wait for confirmation
            user_input = await self._wait_for_user_input(trigger_id, timeout=60)  # 1 minute timeout for shutdown confirmation
            
            if user_input:
                # Check if user confirmed shutdown
                if user_input.upper().strip() in ['CONFIRM', 'YES', 'Y', 'SHUTDOWN', 'PROCEED']:
                    self.shutdown_requested = True
                    self.shutdown_reason = f"User confirmed: {user_input.strip()}"
                    response = f"🛑 shutdown_mcp CONFIRMED!\n\n**User Confirmation:** {user_input}\n\n**Reason:** {reason}\n**Immediate:** {immediate}\n**Cleanup:** {cleanup}\n\n✅ MCP server will now shut down gracefully..."
                    logger.info(f"✅ SHUTDOWN CONFIRMED BY USER: {user_input[:100]}...")
                    logger.info(f"🛑 Server shutdown initiated - reason: {self.shutdown_reason}")
                else:
                    response = f"💡 shutdown_mcp CANCELLED - Alternative instructions received!\n\n**User Response:** {user_input}\n\n**Original Reason:** {reason}\n\nShutdown cancelled. User provided alternative instructions instead of confirmation."
                    logger.info(f"💡 SHUTDOWN CANCELLED - user provided alternative: {user_input[:100]}...")
            else:
                response = f"⏰ shutdown_mcp timed out.\n\n**Reason:** {reason}\n\nNo response received within 1 minute. Shutdown cancelled due to timeout."
                logger.warning("⚠️ Shutdown timed out - shutdown cancelled")
        else:
            response = f"⚠️ shutdown_mcp trigger failed. Manual activation may be needed."
        
        logger.info("🏁 shutdown_mcp processing complete")
        return [TextContent(type="text", text=response)]

    async def _wait_for_extension_acknowledgement(self, trigger_id: str, timeout: int = 30) -> bool:
        """Wait for extension acknowledgement that popup was activated"""
        ack_file = Path(get_temp_path(f"feedback_gate_ack_{trigger_id}.json"))
        
        logger.info(f"🔍 Monitoring for extension acknowledgement: {ack_file}")
        
        start_time = time.time()
        check_interval = 0.1  # Check every 100ms for fast response
        
        while time.time() - start_time < timeout:
            try:
                if ack_file.exists():
                    data = json.loads(ack_file.read_text())
                    ack_status = data.get("acknowledged", False)
                    
                    # Clean up acknowledgement file immediately
                    try:
                        ack_file.unlink()
                        logger.info(f"🧹 Acknowledgement file cleaned up")
                    except Exception:
                        pass
                    
                    if ack_status:
                        logger.info(f"📨 EXTENSION ACKNOWLEDGED popup activation for trigger {trigger_id}")
                        return True
                    
                # Check frequently for faster response
                await asyncio.sleep(check_interval)
                
            except Exception as e:
                logger.error(f"❌ Error reading acknowledgement file: {e}")
                await asyncio.sleep(0.5)
        
        logger.warning(f"⏰ TIMEOUT waiting for extension acknowledgement (trigger_id: {trigger_id})")
        return False

    async def _wait_for_user_input(self, trigger_id: str, timeout: int = 3300) -> Optional[str]:
        """Wait for user input — only check the trigger-ID-specific response file.
        
        Previously we also polled generic fallback files (feedback_gate_response.json,
        mcp_response.json) which caused cross-session pollution and infinite mismatch loops.
        Now we only watch the exact file that matches our trigger_id.
        """
        primary_response = Path(get_temp_path(f"feedback_gate_response_{trigger_id}.json"))
        
        logger.info(f"👁️ Monitoring response file: {primary_response}")
        logger.info(f"🔍 Trigger ID: {trigger_id}")
        
        start_time = time.time()
        check_interval = 0.25
        
        while time.time() - start_time < timeout:
            try:
                if primary_response.exists():
                    user_input = self._read_and_consume_response(primary_response)
                    if user_input:
                        logger.info(f"🎉 RECEIVED USER INPUT for trigger {trigger_id}: {user_input[:100]}...")
                        return user_input
                    else:
                        logger.warning(f"⚠️ Empty or unreadable response file for trigger {trigger_id}")
                
                await asyncio.sleep(check_interval)
                
            except Exception as e:
                logger.error(f"❌ Error in wait loop: {e}")
                await asyncio.sleep(0.5)
        
        actual_elapsed = time.time() - start_time
        logger.warning(f"⏰ [DIAG] TIMEOUT waiting for user input | trigger={trigger_id} | config_timeout={timeout}s | actual_elapsed={actual_elapsed:.1f}s")
        return None

    async def _trigger_cursor_popup_immediately(self, data: dict) -> bool:
        """Create trigger file for Cursor extension with immediate activation and instance isolation"""
        try:
            # PID-namespaced trigger file for multi-instance isolation.
            # The extension polls for feedback_gate_trigger_pid*.json — only this
            # and the legacy file are consumed; per-trigger files would become orphans.
            trigger_file = Path(get_temp_path(f"feedback_gate_trigger_pid{self._server_pid}.json"))
            legacy_trigger_file = Path(get_temp_path("feedback_gate_trigger.json"))
            
            # Build routing info: try env vars first, then fall back to routing file.
            # cursor-remote-control writes a session-specific routing file
            # (feedback_gate_routing_{session}.json) so that IDE MCP instances don't
            # accidentally pick up remote-control routing via the generic filename.
            routing = {}
            fg_chat_id = os.environ.get("FEEDBACK_GATE_CHAT_ID", "")
            fg_platform = os.environ.get("FEEDBACK_GATE_PLATFORM", "")
            fg_session = os.environ.get("FEEDBACK_GATE_SESSION", "")
            if not fg_chat_id:
                routing_file = self._find_routing_file()
                if routing_file and routing_file.exists():
                    try:
                        routing_data = json.loads(routing_file.read_text())
                        fg_chat_id = routing_data.get("chat_id", "")
                        fg_platform = routing_data.get("platform", "") or fg_platform
                        fg_session = routing_data.get("session", "") or fg_session
                        logger.info(f"📋 Routing loaded from {routing_file.name}: chat_id={fg_chat_id[:10]}... platform={fg_platform} session={fg_session[:8] if fg_session else 'none'}")
                    except Exception as e:
                        logger.warning(f"⚠️ Failed to read routing file: {e}")
            if fg_chat_id:
                routing["chat_id"] = fg_chat_id
            if fg_platform:
                routing["platform"] = fg_platform
            if fg_session:
                routing["session"] = fg_session
            
            trigger_data = {
                "timestamp": datetime.now().isoformat(),
                "system": "feedback-gate",
                "editor": "cursor",
                "data": data,
                "pid": self._server_pid,
                "ppid": os.getppid(),
                "active_window": True,
                "mcp_integration": True,
                "immediate_activation": True,
            }
            if routing:
                trigger_data["routing"] = routing
            
            trigger_id = data.get("trigger_id", "")
            logger.info(f"🎯 CREATING trigger files (PID: {self._server_pid}, trigger_id: {trigger_id})")
            
            trigger_json = json.dumps(trigger_data, indent=2)
            trigger_file.write_text(trigger_json)
            legacy_trigger_file.write_text(trigger_json)
            
            # Verify file was written successfully
            if not trigger_file.exists():
                logger.error(f"❌ Failed to create trigger file: {trigger_file}")
                return False
                
            try:
                file_size = trigger_file.stat().st_size
                if file_size == 0:
                    logger.error(f"❌ Trigger file is empty: {trigger_file}")
                    return False
            except FileNotFoundError:
                # File may have been consumed by the extension already - this is OK
                logger.info(f"✅ Trigger file was consumed immediately by extension: {trigger_file}")
                file_size = len(json.dumps(trigger_data, indent=2))
            
            # Flush trigger file to disk (single-file flush, not full os.sync())
            try:
                fd = os.open(str(trigger_file), os.O_RDONLY)
                try:
                    os.fsync(fd)
                finally:
                    os.close(fd)
            except FileNotFoundError:
                pass
            except Exception as sync_error:
                logger.debug(f"fsync skipped: {sync_error}")
            
            logger.info(f"🔥 Trigger created: {trigger_file} ({file_size} bytes)")
            
            await asyncio.sleep(0.05)
            
            return True
            
        except Exception as e:
            logger.error(f"❌ CRITICAL: Failed to create Feedback Gate trigger: {e}")
            import traceback
            logger.error(f"🔍 Full traceback: {traceback.format_exc()}")
            # Wait before returning failure
            await asyncio.sleep(1.0)  # Wait 1 second before confirming failure
            return False

    async def run(self):
        """Run the Feedback Gate server with immediate activation capability and shutdown monitoring"""
        logger.info("🚀 Starting Feedback Gate 2.0 MCP Server for IMMEDIATE Cursor integration...")
        
        
        async with stdio_server() as (read_stream, write_stream):
            logger.info("✅ Feedback Gate server ACTIVE on stdio transport for Cursor")
            
            # Create server run task
            server_task = asyncio.create_task(
                self.server.run(
                    read_stream,
                    write_stream,
                    self.server.create_initialization_options()
                )
            )
            
            # Create shutdown monitor task
            shutdown_task = asyncio.create_task(self._monitor_shutdown())
            
            # Create heartbeat task to keep log file fresh for extension status monitoring
            heartbeat_task = asyncio.create_task(self._heartbeat_logger())
            
            # Wait for either server completion or shutdown request
            done, pending = await asyncio.wait(
                [server_task, shutdown_task, heartbeat_task],
                return_when=asyncio.FIRST_COMPLETED
            )
            
            # Cancel any pending tasks
            for task in pending:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
            
            if self.shutdown_requested:
                logger.info(f"🛑 Feedback Gate server shutting down: {self.shutdown_reason}")
            else:
                logger.info("🏁 Feedback Gate server completed normally")

    async def _heartbeat_logger(self):
        """Periodically update log file to keep MCP status active in extension.
        
        Extension checks log mtime < 30s to determine if MCP is alive,
        so we must write at least every 20s.  To reduce log noise, only
        write an INFO line every 5 minutes; other cycles just flush handlers
        (which updates mtime without adding content).
        """
        logger.info("💓 Starting heartbeat logger for extension status monitoring")
        heartbeat_count = 0
        
        while not self.shutdown_requested:
            try:
                await asyncio.sleep(20)
                heartbeat_count += 1
                
                if heartbeat_count % 15 == 0:
                    logger.info(f"💓 MCP heartbeat #{heartbeat_count} - Server is active and ready")
                
                # Touch log file to update mtime — extension checks mtime < 30s.
                # On non-INFO cycles we skip the log line but still need mtime updated.
                try:
                    Path(log_file_path).touch(exist_ok=True)
                except Exception:
                    pass
                
                for handler in logger.handlers:
                    if hasattr(handler, 'flush'):
                        handler.flush()
                        
            except Exception as e:
                logger.error(f"❌ Heartbeat error: {e}")
                await asyncio.sleep(5)
        
        logger.info("💔 Heartbeat logger stopped")
    
    async def _monitor_shutdown(self):
        """Monitor for shutdown requests in a separate task"""
        while not self.shutdown_requested:
            await asyncio.sleep(1)  # Check every second
        
        # Cleanup operations before shutdown
        logger.info("🧹 Performing cleanup operations before shutdown...")
        
        # Clean up any temporary files (both PID-namespaced and legacy)
        try:
            temp_files = [
                get_temp_path(f"feedback_gate_trigger_pid{self._server_pid}.json"),
                get_temp_path(f"feedback_gate_mcp_{self._server_pid}.pid"),
                get_temp_path("feedback_gate_trigger.json"),
            ]
            for temp_file in temp_files:
                if Path(temp_file).exists():
                    Path(temp_file).unlink()
                    logger.info(f"🗑️ Cleaned up: {os.path.basename(temp_file)}")
                    
        except Exception as e:
            logger.warning(f"⚠️ Cleanup warning: {e}")
        
        logger.info("✅ Cleanup completed - shutdown ready")
        return True

async def main():
    """Main entry point for Feedback Gate MCP Server"""
    logger.info("🎬 STARTING Feedback Gate MCP Server...")
    _log_event("SERVER_START", f"pid={os.getpid()} python={sys.version.split()[0]}")
    logger.info(f"Python version: {sys.version}")
    logger.info(f"Platform: {sys.platform}")
    logger.info(f"OS name: {os.name}")
    logger.info(f"Working directory: {os.getcwd()}")
    
    try:
        server = FeedbackGateServer()
        await server.run()
    except Exception as e:
        logger.error(f"❌ Fatal error in MCP server: {e}")
        import traceback
        logger.error(traceback.format_exc())
        raise

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        _log_event("SERVER_STOP", "reason=KeyboardInterrupt")
        logger.info("🛑 Server stopped by user")
    except Exception as e:
        _log_event("SERVER_STOP", f"reason=crash error={e}")
        logger.error(f"❌ Server crashed: {e}")
        sys.exit(1) 