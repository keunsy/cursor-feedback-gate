#!/usr/bin/env python3
"""
Feedback Gate - MCP Server with Cursor Integration
Provides popup chat for AI agent feedback collection in Cursor IDE.

Requirements:
- mcp>=1.9.2
- Python 3.8+
"""

import asyncio
import contextvars
import json
import sys
import logging
import math
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

# Per-coroutine trigger ID — avoids cross-trigger interference when multiple
# tool calls run concurrently in the same asyncio event loop.
_current_trigger_var: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    '_current_trigger_var', default=None
)

_FEEDBACK_REPLY_SUFFIX = (
    "\n\n[This is a feedback reply, NOT a new task. "
    "Continue current work. Do NOT re-answer earlier requests.]"
)

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
        # F1/F2 delayed-reply stash: {session_id: [{text, ts, origin_trigger_id}]}.
        # Replies that were consumed but never delivered (cancelled tool call,
        # evicted trigger) are kept here and delivered — clearly marked — on the
        # next call for the same session.
        self._delayed_replies = {}
        self._ancestor_pids_cache: list[int] | None = None
        self._session_to_eh_pid: dict[str, int] = {}
        self._session_to_workspace: dict[str, str] = {}
        self._last_response_eh_pid: int | None = None
        self._last_response_workspace: str | None = None
        
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
                "feedback_gate_trigger_fg_*.json",
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

    @staticmethod
    def _get_ancestor_pids(start_pid: int, max_depth: int = 10) -> list[int]:
        """Walk the process tree upward from start_pid, returning [parent, grandparent, ...].
        
        Stops at PID 1 (init/launchd) or when the process no longer exists.
        Used so the extension can match its own process.pid against any ancestor
        of this MCP server — not just the direct parent — which handles the case
        where Cursor routes MCP through an intermediate `mcp-process` helper.
        """
        ancestors: list[int] = []
        current = start_pid
        try:
            import subprocess
            for _ in range(max_depth):
                result = subprocess.run(
                    ["ps", "-o", "ppid=", "-p", str(current)],
                    capture_output=True, text=True, timeout=2,
                )
                ppid_str = result.stdout.strip()
                if not ppid_str:
                    break
                ppid = int(ppid_str)
                if ppid <= 1:
                    break
                ancestors.append(ppid)
                current = ppid
        except Exception as e:
            logger.debug(f"Ancestor PID walk stopped: {e}")
        return ancestors

    async def _ancestor_pids_async(self) -> list[int]:
        """Non-blocking, cached variant of _get_ancestor_pids (F6). The ancestor
        chain never changes during the process lifetime, so compute it once —
        off the event loop — and reuse. Previously every trigger write ran up
        to ten synchronous `ps` subprocesses directly on the event loop."""
        if self._ancestor_pids_cache is None:
            self._ancestor_pids_cache = await asyncio.to_thread(self._get_ancestor_pids, self._server_pid)
        return self._ancestor_pids_cache

    def _write_pid_file(self):
        """Write a PID-specific marker file so the extension can identify its MCP server instance.
        
        Includes PPID, ancestor_pids chain, and workspace_folders so the extension
        can match via multiple strategies:
        1. Direct PPID match (extension-host spawned MCP directly)
        2. Ancestor chain match (rare, but possible)
        3. Sibling match (same Cursor main process parent)
        """
        try:
            pid_file = Path(get_temp_path(f"feedback_gate_mcp_{self._server_pid}.pid"))
            if self._ancestor_pids_cache is None:
                self._ancestor_pids_cache = self._get_ancestor_pids(self._server_pid)
            ancestors = self._ancestor_pids_cache
            # NOTE: WORKSPACE_FOLDER_PATHS reflects the window that started the
            # MCP, not necessarily the window whose agent calls tools.  Stored
            # here for debugging only; trigger routing must NOT rely on it.
            workspace_paths = os.environ.get("WORKSPACE_FOLDER_PATHS", "") or os.getcwd()
            pid_data = {
                "pid": self._server_pid,
                "ppid": os.getppid(),
                "ancestor_pids": ancestors,
                "workspace_folders": workspace_paths,
                "timestamp": datetime.now().isoformat(),
                "system": "feedback-gate"
            }
            pid_file.write_text(json.dumps(pid_data))
            logger.info(f"📝 PID file written: {pid_file} (PPID: {os.getppid()}, ancestors: {ancestors}, workspace: {workspace_paths})")
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
                                "description": "Short summary (≤100 chars) shown in the popup. Put detailed results in your main Cursor chat reply, NOT here. Example: '已完成数据库迁移。需要调整吗？'",
                                "maxLength": 200,
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
                            },
                            "workspace_path": {
                                "type": "string",
                                "description": "Absolute path of the current workspace/project root. Used for multi-window routing — ensures the popup opens in the correct Cursor window. Pass the workspace root path (e.g. '/Users/me/my-project').",
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
                # Use per-coroutine trigger ID to avoid cross-trigger interference.
                cancelled_trigger = _current_trigger_var.get(None) or self._pending_trigger_id
                logger.warning(f"⚠️ [DIAG] Tool call CANCELLED for {name} | trigger={cancelled_trigger} | pending_trigger={self._pending_trigger_id} | This means Cursor IDE aborted the MCP call (possible IDE-level timeout or user Stop)")
                _log_event("CANCELLED", f"tool={name} trigger={cancelled_trigger}")
                if cancelled_trigger:
                    response_file = Path(get_temp_path(f"feedback_gate_response_{cancelled_trigger}.json"))
                    if response_file.exists():
                        logger.info(f"⚠️ [DIAG] Response file exists on cancel for trigger {cancelled_trigger} — marking for next-call delivery (NOT consuming now to avoid data loss)")
                        _log_event("CANCEL_RESPONSE_PENDING", f"trigger={cancelled_trigger}")
                    else:
                        logger.info(f"🔒 [DIAG] PRESERVING pending trigger {cancelled_trigger} — no response file yet, popup is still alive")
                raise
            except Exception as e:
                logger.error(f"💥 Tool call error for {name}: {e}")
                # F7: only clean up the trigger THIS coroutine owns (contextvar set).
                # The old fallback to the shared _pending_trigger_id could evict a live
                # trigger belonging to another concurrent conversation mid-wait.
                error_trigger = _current_trigger_var.get(None)
                if error_trigger:
                    logger.warning(f"🧹 Clearing trigger {error_trigger} due to exception")
                    self._active_triggers.pop(error_trigger, None)
                    if self._pending_trigger_id == error_trigger:
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

    # ── Delayed-reply stash (F1/F2) ────────────────────────────────────────
    _DELAYED_REPLY_TTL = 3600  # seconds; older stashed replies are dropped

    def _stash_delayed_reply(self, session_id: str, text: str, origin_trigger_id: str):
        if not session_id or not text:
            return
        self._delayed_replies.setdefault(session_id, []).append({
            "text": text,
            "ts": time.time(),
            "origin_trigger_id": origin_trigger_id or "",
        })
        logger.info(f"📦 Stashed delayed reply for session {session_id[:8]}... (origin trigger ...{(origin_trigger_id or '')[-12:]})")
        _log_event("STASH_DELAYED_REPLY", f"session={session_id} trigger={origin_trigger_id}")

    def _remove_stashed_reply(self, session_id: str, trigger_id: str):
        """Called on normal delivery: the reply reached Cursor, drop the safety copy."""
        entries = self._delayed_replies.get(session_id)
        if not entries:
            return
        self._delayed_replies[session_id] = [e for e in entries if e.get("origin_trigger_id") != trigger_id]
        if not self._delayed_replies[session_id]:
            del self._delayed_replies[session_id]

    def _pop_delayed_replies(self, session_id: str) -> list:
        entries = self._delayed_replies.pop(session_id, [])
        if not entries:
            return []
        # P1-1 (hardened): every stashed entry — fresh or TTL-expired — proves
        # its origin trigger's response was consumed and the popup closed.
        # Remove those triggers BEFORE the TTL filter drops the evidence,
        # otherwise a stale zombie survives and a later call waits on it
        # (up to 24h) for a response file that can never appear.
        for _se in entries:
            _otid = _se.get("origin_trigger_id") or ""
            if _otid and _otid in self._active_triggers:
                logger.info(f"🧹 Removing spent origin trigger {_otid} (reply consumed → popup closed)")
                _log_event("ZOMBIE_TRIGGER_REMOVED", f"trigger={_otid} session={session_id[:8]}")
                del self._active_triggers[_otid]
                if self._pending_trigger_id == _otid:
                    self._clear_trigger_state(responded=True)
        now = time.time()
        fresh = [e for e in entries if (now - e.get("ts", 0)) <= self._DELAYED_REPLY_TTL]
        dropped = len(entries) - len(fresh)
        if dropped:
            logger.info(f"🗑️ Dropped {dropped} expired delayed reply(ies) for session {session_id[:8]}...")
        return fresh

    def _drain_response_to_stash(self, trigger_id: str, session_id: str):
        """Rescue an already-written response BEFORE its trigger record is evicted.
        Without this, a reply that lands moments after eviction becomes an orphan
        file that nobody consumes (F2)."""
        if not session_id or not trigger_id:
            return
        response_file = Path(get_temp_path(f"feedback_gate_response_{trigger_id}.json"))
        if not response_file.exists():
            return
        user_input = self._read_and_consume_response(response_file)
        if user_input:
            logger.warning(f"📦 Eviction of trigger ...{trigger_id[-12:]} found an undelivered reply — stashing for session {session_id[:8]}...")
            self._stash_delayed_reply(session_id, user_input, trigger_id)

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
                if file_content.startswith('{'):
                    eh_pid = data.get("extension_host_pid")
                    if eh_pid:
                        self._last_response_eh_pid = int(eh_pid)
                    ws = data.get("workspace_folders")
                    if ws:
                        self._last_response_workspace = ws
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
                    img_data = attachment.get('base64Data') or ''
                    if not img_data or img_data == '[TOO_LARGE_FOR_QUEUE]':
                        # P2 (flow audit): the queue downgrades >5MB images to a
                        # placeholder — never send it as image data. Surface it
                        # visibly instead (mirrors the file-content guard below).
                        response_content.append(TextContent(
                            type="text",
                            text=f"⚠️ Image '{attachment.get('fileName', 'unknown')}' exceeded the 5MB delivery limit and could not be sent. Ask the user to re-share a smaller image or provide its file path."
                        ))
                        continue
                    try:
                        response_content.append(ImageContent(
                            type="image",
                            data=img_data,
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
    _IDE_WAIT_SECONDS = int(os.environ.get("FEEDBACK_GATE_IDE_WAIT_SECONDS", "300"))
    _IDE_MAX_TOTAL_SECONDS = 3600  # 1h max total wait for IDE

    # Heartbeat config file for dynamic (no-restart) configuration.
    # Falls back to env vars, then defaults.
    _HEARTBEAT_CONFIG_PATH = os.path.join(
        os.path.expanduser("~"), ".cursor", "feedback-gate-config.json"
    )

    @classmethod
    def _load_heartbeat_config(cls) -> tuple[str, str, int | None, int | None, int | None]:
        """Read heartbeat mode, reply, optional wait_seconds, stale_seconds, and max_total_seconds from config file.
        Config file is re-read on every heartbeat so changes take effect
        without restarting the MCP server.
        Returns (mode, reply, wait_seconds_override_or_None, stale_seconds_override_or_None, max_total_seconds_override_or_None)."""
        mode = os.environ.get("FEEDBACK_GATE_HEARTBEAT_MODE", "waiting").lower()
        reply = os.environ.get("FEEDBACK_GATE_HEARTBEAT_REPLY", "当前时间")
        wait_override: int | None = None
        stale_override: int | None = None
        max_total_override: int | None = None
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
                if "max_total_seconds" in cfg:
                    max_total_override = int(cfg["max_total_seconds"])
        except Exception as e:
            logger.debug(f"Failed to read heartbeat config: {e}")
        return mode, reply, wait_override, stale_override, max_total_override

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
        mode, reply, _, _, _ = self._load_heartbeat_config()
        if mode == "user_response":
            logger.info(f"💓 Heartbeat using user_response mode: '{reply}'")
            return f"User Response: {reply}{_FEEDBACK_REPLY_SUFFIX}"
        return self._build_heartbeat_message(count, elapsed_min, session_id=session_id)

    async def _handle_feedback_gate_chat(self, args: dict) -> list[TextContent]:
        """Handle Feedback Gate chat popup and wait for user input with 5 minute timeout"""
        message = args.get("message", "请提供你的反馈：")
        title = args.get("title", "Feedback Gate")
        context = args.get("context", "")
        urgent = args.get("urgent", False)
        session_id = args.get("session_id", "").strip()
        workspace_path = args.get("workspace_path", "").strip()

        # Store workspace from tool call for precise multi-window routing.
        if session_id and workspace_path:
            self._session_to_workspace[session_id] = workspace_path
            logger.info(f"📍 Workspace from tool call: session={session_id[:8]}... ws={workspace_path}")
        
        self._last_attachments = []
        self._last_files = []
        
        call_entry_time = time.time()
        logger.info(f"📥 [DIAG] feedback_gate_chat ENTERED at {datetime.now().isoformat()} | pending_trigger={self._pending_trigger_id} | heartbeat_count={self._heartbeat_count} | session_id={session_id or 'none'} | msg_preview={message[:80]}...")
        _log_event("ENTERED", f"trigger={self._pending_trigger_id} hb={self._heartbeat_count} sid={session_id or 'none'} msg={message[:60]}")
        
        # F1/F2: deliver replies that were consumed but never reached the agent
        # for this session (cancelled tool call / evicted trigger). They come back
        # clearly marked; afterwards this call proceeds normally (fresh popup for
        # the current question on the next invocation).
        if session_id:
            _delayed = self._pop_delayed_replies(session_id)
            if _delayed:
                _parts = []
                for _e in _delayed:
                    _origin = (_e.get("origin_trigger_id") or "")[-12:]
                    _parts.append(
                        f"[DELAYED REPLY — the user answered a PREVIOUS request (trigger ...{_origin}) "
                        f"that was cancelled or expired before delivery. It is NOT the answer to the "
                        f"current question.]\n{_e.get('text', '')}"
                    )
                _combined = "\n\n---\n\n".join(_parts)
                self._last_trigger_responded_at = time.time()
                self._last_responded_by_session[session_id or "__global__"] = time.time()
                logger.info(f"📬 Delivering {len(_delayed)} delayed reply(ies) for session {session_id[:8]}...")
                _log_event("DELIVER_DELAYED_REPLY", f"session={session_id} count={len(_delayed)}")
                return [TextContent(type="text", text=f"User Response: {_combined}{_FEEDBACK_REPLY_SUFFIX}")]

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
            for tid, info in list(self._active_triggers.items()):
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
        
        # Evict ALL other triggers for the same session_id when entering.
        # This prevents a stale trigger's heartbeat re-enter from interfering
        # with a newer trigger created for the same session (the bug where
        # trigger A times out, Agent re-calls creating trigger B, but trigger A's
        # heartbeat re-enter races and corrupts shared state).
        if session_id and my_trigger_id:
            same_session_stale = [
                tid for tid, info in self._active_triggers.items()
                if tid != my_trigger_id and info.get("session_id") == session_id
            ]
            for tid in same_session_stale:
                logger.warning(f"🧹 Evicting same-session stale trigger {tid} (session={session_id}, keeping={my_trigger_id})")
                _log_event("EVICT_SAME_SESSION", f"evicted={tid} kept={my_trigger_id} session={session_id}")
                self._drain_response_to_stash(tid, session_id)
                del self._active_triggers[tid]
                if self._pending_trigger_id == tid:
                    self._clear_trigger_state(responded=False)
        
        # Clean up stale triggers (skip the one we just matched)
        stale_limit = self._STALE_TRIGGER_SECONDS_CLI if is_remote else self._STALE_TRIGGER_SECONDS_IDE
        if not is_remote:
            _, _, _, stale_override, _ = self._load_heartbeat_config()
            if stale_override is not None:
                stale_limit = stale_override
        stale_ids = [tid for tid, info in self._active_triggers.items()
                     if tid != my_trigger_id and (now - info.get("created_at", 0)) > stale_limit]
        for tid in stale_ids:
            logger.warning(f"🧹 Clearing stale trigger {tid}")
            _log_event("TRIGGER_EXPIRED", f"trigger={tid}")
            self._drain_response_to_stash(tid, (self._active_triggers.get(tid) or {}).get("session_id") or "")
            del self._active_triggers[tid]
        
        _MAX_ACTIVE_TRIGGERS = 20
        if len(self._active_triggers) >= _MAX_ACTIVE_TRIGGERS:
            evict_candidates = [t for t in self._active_triggers if t != my_trigger_id]
            if evict_candidates:
                oldest_tid = min(evict_candidates, key=lambda t: self._active_triggers[t].get("created_at", 0))
                logger.warning(f"🧹 Evicting oldest trigger {oldest_tid} (cap={_MAX_ACTIVE_TRIGGERS})")
                self._drain_response_to_stash(oldest_tid, (self._active_triggers.get(oldest_tid) or {}).get("session_id") or "")
                del self._active_triggers[oldest_tid]
                if self._pending_trigger_id == oldest_tid:
                    self._clear_trigger_state(responded=False)
        
        _SESSION_COOLDOWN_TTL = 3600
        stale_sessions = [k for k, t in self._last_responded_by_session.items()
                          if (now - t) > _SESSION_COOLDOWN_TTL]
        for k in stale_sessions:
            del self._last_responded_by_session[k]
        _stale_reply_keys = [k for k, entries in self._delayed_replies.items()
                             if not entries or (now - max(e.get("ts", 0) for e in entries)) > self._DELAYED_REPLY_TTL]
        for k in _stale_reply_keys:
            del self._delayed_replies[k]
        
        if self._pending_trigger_id and self._pending_trigger_id not in self._active_triggers:
            stale_age = now - self._pending_trigger_created_at if self._pending_trigger_created_at else float('inf')
            if stale_age > stale_limit:
                self._clear_trigger_state(responded=False)
        
        if my_trigger_id:
            _current_trigger_var.set(my_trigger_id)
            # Same conversation re-entering — check for ready response
            response_file = Path(get_temp_path(f"feedback_gate_response_{my_trigger_id}.json"))
            if response_file.exists():
                self._last_response_eh_pid = None
                self._last_response_workspace = None
                ready_input = self._read_and_consume_response(response_file)
                if ready_input:
                    _resp_sid = (my_trigger_info or {}).get("session_id", "") or session_id
                    if _resp_sid and self._last_response_eh_pid:
                        self._session_to_eh_pid[_resp_sid] = self._last_response_eh_pid
                    if _resp_sid and self._last_response_workspace:
                        self._session_to_workspace[_resp_sid] = self._last_response_workspace
                    del self._active_triggers[my_trigger_id]
                    if self._pending_trigger_id == my_trigger_id:
                        self._clear_trigger_state(responded=True)
                    else:
                        self._last_trigger_responded_at = time.time()
                    self._last_responded_by_session[_resp_sid or "__global__"] = time.time()
                    logger.info(f"✅ Found ready response for trigger {my_trigger_id}: {ready_input[:100]}...")
                    _log_event("USER_RESPONSE", f"path=ready-file trigger={my_trigger_id} input={ready_input[:60]}")
                    result = [TextContent(type="text", text=f"User Response: {ready_input}{_FEEDBACK_REPLY_SUFFIX}")]
                    self._append_media_to_response(result)
                    return result
            
            # Re-enter wait loop for this trigger
            wait_secs = self._REMOTE_WAIT_SECONDS if is_remote else self._IDE_WAIT_SECONDS
            _, _, wait_override, _, max_total_override = self._load_heartbeat_config()
            if wait_override is not None and not is_remote:
                wait_secs = wait_override
            max_secs = self._REMOTE_MAX_TOTAL_SECONDS if is_remote else self._IDE_MAX_TOTAL_SECONDS
            if max_total_override is not None and not is_remote:
                max_secs = max_total_override
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
                if my_trigger_id not in self._active_triggers:
                    logger.warning(f"⚠️ RE-ENTER trigger {my_trigger_id} was evicted during wait, but got input — delivering anyway")
                else:
                    del self._active_triggers[my_trigger_id]
                _resp_sid = (my_trigger_info or {}).get("session_id", "") or session_id
                # P1 (flow audit): mirror of the first-wait path — the wait loop
                # stashed a safety copy of this reply; it was just delivered, so
                # drop it, or the NEXT call re-delivers the same reply as
                # [DELAYED REPLY].
                if _resp_sid:
                    self._remove_stashed_reply(_resp_sid, my_trigger_id)
                if _resp_sid and self._last_response_eh_pid:
                    self._session_to_eh_pid[_resp_sid] = self._last_response_eh_pid
                if _resp_sid and self._last_response_workspace:
                    self._session_to_workspace[_resp_sid] = self._last_response_workspace
                if self._pending_trigger_id == my_trigger_id:
                    self._clear_trigger_state(responded=True)
                else:
                    self._last_trigger_responded_at = time.time()
                self._last_responded_by_session[_resp_sid or "__global__"] = time.time()
                wall_elapsed = time.time() - call_entry_time
                logger.info(f"✅ RE-ENTER got feedback for {my_trigger_id} after {wall_elapsed:.1f}s | input={user_input[:100]}...")
                _log_event("USER_RESPONSE", f"path=re-enter trigger={my_trigger_id} wall={wall_elapsed:.1f}s input={user_input[:60]}")
                result = [TextContent(type="text", text=f"User Response: {user_input}{_FEEDBACK_REPLY_SUFFIX}")]
                self._append_media_to_response(result)
                return result
            else:
                # Trigger was evicted (replaced by a newer trigger for same session)
                # — silently exit so we don't send a stale heartbeat that competes
                # with the new trigger's response.
                if my_trigger_id not in self._active_triggers:
                    logger.info(f"🚫 RE-ENTER trigger {my_trigger_id} was evicted — suppressing heartbeat to avoid interfering with newer trigger")
                    _log_event("HEARTBEAT_SUPPRESSED", f"trigger={my_trigger_id} reason=evicted")
                    return [TextContent(type="text", text=f"SKIP: This feedback request ({my_trigger_id[:20]}...) has been superseded by a newer request. Do NOT re-call — the newer request is already active.")]
                
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
                await self._rewrite_trigger_for_recovery(my_trigger_id, my_trigger_info)
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
            "workspace_path": workspace_path,
            "timestamp": datetime.now().isoformat(),
            "immediate_activation": True
        })
        
        if success:
            # Evict any existing triggers for the same session before registering
            # the new one. This is the second defense line (the first is at the top
            # of _handle_feedback_gate_chat) — needed because the code path to here
            # skips the session-match block above (my_trigger_id was None).
            if session_id:
                old_session_triggers = [
                    tid for tid, info in self._active_triggers.items()
                    if info.get("session_id") == session_id
                ]
                for tid in old_session_triggers:
                    logger.warning(f"🧹 Evicting old trigger {tid} before registering new trigger {trigger_id} (session={session_id})")
                    _log_event("EVICT_ON_NEW_TRIGGER", f"evicted={tid} new={trigger_id} session={session_id}")
                    self._drain_response_to_stash(tid, session_id)
                    del self._active_triggers[tid]
                    if self._pending_trigger_id == tid:
                        self._clear_trigger_state(responded=False)
            
            # Register in both legacy state and new per-trigger tracking
            _current_trigger_var.set(trigger_id)
            self._pending_trigger_id = trigger_id
            self._pending_trigger_created_at = time.time()
            self._pending_trigger_message = message
            self._heartbeat_count = 0
            self._active_triggers[trigger_id] = {
                "session_id": session_id,
                "message": message,
                "created_at": time.time(),
                "heartbeat_count": 0,
                "workspace_path": workspace_path,
                "title": title,
                "context": context,
            }
            logger.info(f"🔥 POPUP TRIGGERED - waiting for user input (trigger_id: {trigger_id}, session_id={session_id or 'none'}, active_triggers={len(self._active_triggers)})")
            _log_event("NEW_TRIGGER", f"trigger={trigger_id} active={len(self._active_triggers)} msg={message[:60]}")
            
            # Quick check: is the extension alive?
            # Check the per-trigger file first (concurrency-safe), fall back to PID file.
            my_trigger_file = Path(get_temp_path(f"feedback_gate_trigger_fg_{trigger_id}.json")) if trigger_id else None
            pid_trigger_file = Path(get_temp_path(f"feedback_gate_trigger_pid{self._server_pid}.json"))
            check_file = my_trigger_file or pid_trigger_file
            # F3: consumption window is configurable via FEEDBACK_GATE_TRIGGER_TIMEOUT
            # (seconds, default 5). CLI/remote-control setups can extend it because
            # their extension may poll more slowly. Keeps the default behaviour intact.
            try:
                _consume_timeout = float(os.environ.get("FEEDBACK_GATE_TRIGGER_TIMEOUT", "5"))
            except (TypeError, ValueError):
                _consume_timeout = 5.0
            if not math.isfinite(_consume_timeout):
                logger.warning(f"⚠️ FEEDBACK_GATE_TRIGGER_TIMEOUT non-finite ({_consume_timeout!r}) — using default 5s")
                _consume_timeout = 5.0
            _consume_deadline = time.time() + max(_consume_timeout, 0.5)
            extension_alive = False
            while time.time() < _consume_deadline:
                await asyncio.sleep(0.5)
                if not check_file.exists():
                    extension_alive = True
                    break
            if not extension_alive:
                logger.warning("⚠️ Trigger file not consumed — no Feedback Gate extension detected")
                self._active_triggers.pop(trigger_id, None)
                self._clear_trigger_state(responded=False)
                try:
                    if my_trigger_file:
                        my_trigger_file.unlink(missing_ok=True)
                    pid_trigger_file.unlink(missing_ok=True)
                    Path(get_temp_path("feedback_gate_trigger.json")).unlink(missing_ok=True)
                except Exception:
                    pass
                return [TextContent(type="text", text="SKIP: Feedback Gate extension is not active (no GUI detected). Continuing without user feedback.")]
            
            ack_data = await self._wait_for_extension_acknowledgement(trigger_id, timeout=15)
            if ack_data:
                # Learn which window claimed this trigger for future routing.
                ack_eh_pid = ack_data.get("extension_host_pid")
                ack_ws = ack_data.get("workspace_folders", "")
                if session_id and ack_eh_pid:
                    self._session_to_eh_pid[session_id] = int(ack_eh_pid)
                if session_id and ack_ws:
                    self._session_to_workspace[session_id] = ack_ws
                logger.info(f"📨 Extension acknowledged (eh_pid={ack_eh_pid}, ws={ack_ws})")
            else:
                logger.warning("⚠️ No extension acknowledgement received — but trigger was consumed, proceeding")
            
            wait_secs = self._REMOTE_WAIT_SECONDS if is_remote else self._IDE_WAIT_SECONDS
            _, _, wait_override, _, max_total_override = self._load_heartbeat_config()
            if wait_override is not None and not is_remote:
                wait_secs = wait_override
            max_secs = self._REMOTE_MAX_TOTAL_SECONDS if is_remote else self._IDE_MAX_TOTAL_SECONDS
            if max_total_override is not None and not is_remote:
                max_secs = max_total_override
            label = "CLI" if is_remote else "IDE"
            logger.info(f"⏳ Waiting for user input (timeout={wait_secs}s, {label})...")
            
            self._last_response_eh_pid = None
            self._last_response_workspace = None
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
                if session_id:
                    self._remove_stashed_reply(session_id, trigger_id)
                if session_id and self._last_response_eh_pid:
                    self._session_to_eh_pid[session_id] = self._last_response_eh_pid
                if session_id and self._last_response_workspace:
                    self._session_to_workspace[session_id] = self._last_response_workspace
                if self._pending_trigger_id == trigger_id:
                    self._clear_trigger_state(responded=True)
                else:
                    self._last_trigger_responded_at = time.time()
                self._last_responded_by_session[session_id or "__global__"] = time.time()
                wall_elapsed = time.time() - call_entry_time
                logger.info(f"✅ Got feedback for {trigger_id} after {wall_elapsed:.1f}s | input={user_input[:100]}...")
                _log_event("USER_RESPONSE", f"path=first-wait trigger={trigger_id} wall={wall_elapsed:.1f}s input={user_input[:60]}")
                result = [TextContent(type="text", text=f"User Response: {user_input}{_FEEDBACK_REPLY_SUFFIX}")]
                self._append_media_to_response(result)
                return result
            else:
                trigger_info = self._active_triggers.get(trigger_id)
                if trigger_info is None:
                    # F8: the trigger was evicted while we waited (a newer trigger for
                    # the same session replaced it). Suppress the heartbeat exactly like
                    # the re-enter path does, so this stale coroutine stops competing
                    # with the newer trigger's response loop.
                    logger.info(f"🚫 first-wait trigger {trigger_id} was evicted during wait — suppressing heartbeat")
                    _log_event("HEARTBEAT_SUPPRESSED", f"trigger={trigger_id} reason=evicted path=first-wait")
                    return [TextContent(type="text", text=f"SKIP: This feedback request ({trigger_id[:20]}...) has been superseded by a newer request. Do NOT re-call — the newer request is already active.")]
                trigger_info["heartbeat_count"] = trigger_info.get("heartbeat_count", 0) + 1
                hb_count = trigger_info["heartbeat_count"]
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
                if trigger_info:
                    await self._rewrite_trigger_for_recovery(trigger_id, trigger_info)
                logger.info(f"⏳ {label} heartbeat #{hb_count} | trigger={trigger_id} | {wait_secs}s | ~{elapsed_min:.1f}min cumulative")
                _log_event("HEARTBEAT", f"#{hb_count} trigger={trigger_id} wall={wall_elapsed:.1f}s cumul={elapsed_min:.1f}min")
                return [TextContent(type="text", text=self._build_heartbeat_response(hb_count, elapsed_min, session_id=session_id))]
        else:
            response = f"ERROR: Failed to trigger Feedback Gate popup"
            logger.error("❌ Failed to trigger Feedback Gate popup")
            return [TextContent(type="text", text=response)]


    async def _rewrite_trigger_for_recovery(self, trigger_id: str, trigger_info: dict) -> bool:
        """Re-create trigger file when the claiming EH appears dead.
        
        After a heartbeat timeout, the EH that originally claimed the trigger
        may have restarted (PID changed).  The new EH has no knowledge of the
        pending trigger because the canonical file was already deleted by the
        old EH.  Re-writing the trigger file gives the new EH a chance to
        claim and display the popup.
        
        We intentionally clear target_extension_host_pid so that the new EH
        (different PID) isn't filtered out by the routing logic.
        """
        sid = trigger_info.get("session_id", "")
        cached_eh_pid = self._session_to_eh_pid.get(sid) if sid else None
        if not cached_eh_pid:
            return False
        
        eh_alive = False
        try:
            os.kill(cached_eh_pid, 0)
            eh_alive = True
        except (OSError, ProcessLookupError):
            pass
        
        if eh_alive:
            return False
        
        logger.info(f"🔄 RECOVERY: EH {cached_eh_pid} is dead for trigger {trigger_id} — rewriting trigger file")
        
        if sid:
            del self._session_to_eh_pid[sid]
        
        ws = trigger_info.get("workspace_path", "")
        if not ws and sid:
            ws = self._session_to_workspace.get(sid, "")
        
        data = {
            "tool": "feedback_gate_chat",
            "message": trigger_info.get("message", ""),
            "title": trigger_info.get("title", "Feedback Gate"),
            "context": trigger_info.get("context", ""),
            "urgent": False,
            "trigger_id": trigger_id,
            "session_id": sid,
            "workspace_path": ws,
            "timestamp": datetime.now().isoformat(),
            "immediate_activation": True,
        }
        
        trigger_data = {
            "timestamp": datetime.now().isoformat(),
            "system": "feedback-gate",
            "editor": "cursor",
            "data": data,
            "pid": self._server_pid,
            "ppid": os.getppid(),
            "ancestor_pids": await self._ancestor_pids_async(),
            "target_extension_host_pid": None,
            "workspace_folders": ws,
            "active_window": True,
            "mcp_integration": True,
            "immediate_activation": True,
            "recovery": True,
        }
        
        trigger_json = json.dumps(trigger_data, indent=2)
        per_trigger_file = Path(get_temp_path(f"feedback_gate_trigger_fg_{trigger_id}.json"))
        pid_trigger_file = Path(get_temp_path(f"feedback_gate_trigger_pid{self._server_pid}.json"))
        legacy_trigger_file = Path(get_temp_path("feedback_gate_trigger.json"))
        
        try:
            for target in [per_trigger_file, pid_trigger_file, legacy_trigger_file]:
                tmp = target.with_suffix('.json.tmp')
                tmp.write_text(trigger_json)
                tmp.replace(target)
            logger.info(f"🔄 RECOVERY: trigger file rewritten for {trigger_id} (ws={ws}, eh_pid=cleared)")
            _log_event("TRIGGER_RECOVERY", f"trigger={trigger_id} dead_eh={cached_eh_pid} ws={ws}")
            return True
        except Exception as e:
            logger.error(f"❌ RECOVERY: failed to rewrite trigger {trigger_id}: {e}")
            return False

    async def _wait_for_extension_acknowledgement(self, trigger_id: str, timeout: int = 30) -> dict | None:
        """Wait for extension acknowledgement that popup was activated.
        Returns the ack data dict on success, None on timeout."""
        ack_file = Path(get_temp_path(f"feedback_gate_ack_{trigger_id}.json"))
        
        logger.info(f"🔍 Monitoring for extension acknowledgement: {ack_file}")
        
        start_time = time.time()
        check_interval = 0.1
        
        while time.time() - start_time < timeout:
            try:
                if ack_file.exists():
                    data = json.loads(ack_file.read_text())
                    ack_status = data.get("acknowledged", False)
                    
                    try:
                        ack_file.unlink()
                    except Exception:
                        pass
                    
                    if ack_status:
                        logger.info(f"📨 EXTENSION ACKNOWLEDGED popup activation for trigger {trigger_id}")
                        return data
                    
                await asyncio.sleep(check_interval)
                
            except Exception as e:
                logger.error(f"❌ Error reading acknowledgement file: {e}")
                await asyncio.sleep(0.5)
        
        logger.warning(f"⏰ TIMEOUT waiting for extension acknowledgement (trigger_id: {trigger_id})")
        return None

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
        # W4: after a window reload/restart the claiming EH is replaced by a new
        # PID that never saw the trigger file. The recovery rewrite used to run
        # only at heartbeat boundaries (up to wait_secs apart — minutes), leaving
        # the popup gone while the user stares at nothing. Probe every 10s; the
        # rewrite is a no-op while the holder EH is alive.
        _last_recovery_probe = start_time
        
        while time.time() - start_time < timeout:
            try:
                if primary_response.exists():
                    user_input = self._read_and_consume_response(primary_response)
                    if user_input:
                        # F1 recovery stash: the response FILE is already consumed at this
                        # point. If the coroutine is cancelled between here and the tool
                        # result reaching Cursor, the reply would vanish. Keep a safety copy
                        # keyed by session; the normal completion path removes it, while a
                        # cancellation leaves it behind for next-call delivery.
                        _stash_sid = (self._active_triggers.get(trigger_id) or {}).get("session_id") or ""
                        if _stash_sid:
                            self._stash_delayed_reply(_stash_sid, user_input, trigger_id)
                        logger.info(f"🎉 RECEIVED USER INPUT for trigger {trigger_id}: {user_input[:100]}...")
                        return user_input
                    else:
                        logger.warning(f"⚠️ Empty or unreadable response file for trigger {trigger_id}")
                
                if time.time() - _last_recovery_probe >= 10:
                    _last_recovery_probe = time.time()
                    _tinfo = self._active_triggers.get(trigger_id)
                    if _tinfo:
                        await self._rewrite_trigger_for_recovery(trigger_id, _tinfo)

                await asyncio.sleep(check_interval)
                
            except Exception as e:
                logger.error(f"❌ Error in wait loop: {e}")
                await asyncio.sleep(0.5)
        
        actual_elapsed = time.time() - start_time
        logger.warning(f"⏰ [DIAG] TIMEOUT waiting for user input | trigger={trigger_id} | config_timeout={timeout}s | actual_elapsed={actual_elapsed:.1f}s")
        return None

    async def _trigger_cursor_popup_immediately(self, data: dict) -> bool:
        """Create trigger file for Cursor extension with immediate activation and instance isolation.
        
        Uses per-trigger unique filenames (feedback_gate_trigger_fg_{trigger_id}.json) so that
        concurrent conversations from the same MCP process don't overwrite each other's triggers.
        Also writes the PID-namespaced and legacy files for backward compatibility / alive detection.
        """
        try:
            trigger_id = data.get("trigger_id", "")
            # Primary: per-trigger unique file — safe for concurrent conversations
            per_trigger_file = Path(get_temp_path(f"feedback_gate_trigger_fg_{trigger_id}.json")) if trigger_id else None
            # Backward compat: PID-namespaced + legacy (may be overwritten by concurrent calls)
            pid_trigger_file = Path(get_temp_path(f"feedback_gate_trigger_pid{self._server_pid}.json"))
            legacy_trigger_file = Path(get_temp_path("feedback_gate_trigger.json"))
            
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
            
            # Resolve target window for routing.
            # Priority: tool-call workspace_path > session cache > nothing.
            # The tool-call workspace_path is always the most accurate because
            # it comes from the agent's current window, while the session cache
            # may be stale (e.g. agent switched windows or session_id was reused).
            _sid = data.get("session_id", "")
            _call_workspace = (data.get("workspace_path") or "").strip()
            _cached_workspace = self._session_to_workspace.get(_sid) if _sid else None
            _target_workspace = _call_workspace or _cached_workspace or ""
            _target_eh_pid = self._session_to_eh_pid.get(_sid) if _sid else None
            # If workspace changed from what was cached, the cached eh_pid may
            # point to the wrong window — clear it to avoid mis-routing.
            if _target_eh_pid and _call_workspace and _cached_workspace and _call_workspace != _cached_workspace:
                logger.info(f"🔄 Workspace changed for session {_sid[:8]}...: {_cached_workspace} → {_call_workspace}, clearing cached eh_pid {_target_eh_pid}")
                _target_eh_pid = None
            
            trigger_data = {
                "timestamp": datetime.now().isoformat(),
                "system": "feedback-gate",
                "editor": "cursor",
                "data": data,
                "pid": self._server_pid,
                "ppid": os.getppid(),
                "ancestor_pids": await self._ancestor_pids_async(),
                "target_extension_host_pid": _target_eh_pid,
                "workspace_folders": _target_workspace or "",
                "active_window": True,
                "mcp_integration": True,
                "immediate_activation": True,
            }
            if routing:
                trigger_data["routing"] = routing
            
            logger.info(f"🎯 CREATING trigger (id={trigger_id}, ws={_target_workspace or 'none'}, eh_pid={_target_eh_pid or 'none'}, call_ws={_call_workspace or 'none'}, cached_ws={_cached_workspace or 'none'})")
            
            trigger_json = json.dumps(trigger_data, indent=2)
            file_size = len(trigger_json.encode('utf-8'))
            
            targets = [pid_trigger_file, legacy_trigger_file]
            if per_trigger_file:
                targets.insert(0, per_trigger_file)
            for target in targets:
                tmp = target.with_suffix('.json.tmp')
                tmp.write_text(trigger_json)
                tmp.replace(target)
            
            logger.info(f"🔥 Trigger created: {per_trigger_file or pid_trigger_file} ({file_size} bytes)")
            
            await asyncio.sleep(0.05)
            
            return True
            
        except Exception as e:
            logger.error(f"❌ CRITICAL: Failed to create Feedback Gate trigger: {e}")
            import traceback
            logger.error(f"🔍 Full traceback: {traceback.format_exc()}")
            await asyncio.sleep(1.0)
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
        
        # Clean up any temporary files (PID-namespaced, per-trigger, and legacy)
        try:
            temp_files = [
                get_temp_path(f"feedback_gate_trigger_pid{self._server_pid}.json"),
                get_temp_path(f"feedback_gate_mcp_{self._server_pid}.pid"),
                get_temp_path("feedback_gate_trigger.json"),
            ]
            # Also clean per-trigger files for active triggers
            for tid in list(self._active_triggers.keys()):
                temp_files.append(get_temp_path(f"feedback_gate_trigger_fg_{tid}.json"))
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