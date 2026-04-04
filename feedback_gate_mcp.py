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

# Speech-to-text imports
try:
    from faster_whisper import WhisperModel
    WHISPER_AVAILABLE = True
except ImportError:
    WHISPER_AVAILABLE = False

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
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=handlers
)
logger = logging.getLogger(__name__)
logger.info(f"🔧 Log file path: {log_file_path}")

# Force immediate log flushing
for handler in logger.handlers:
    if hasattr(handler, 'flush'):
        handler.flush()

class FeedbackGateServer:
    def __init__(self):
        self.server = Server("feedback-gate")
        self.setup_handlers()
        self.shutdown_requested = False
        self.shutdown_reason = ""
        self._last_attachments = []
        self._last_files = []
        self._whisper_model = None
        self._server_pid = os.getpid()
        
        # Clean up stale files from dead MCP instances before writing our own PID
        self._cleanup_stale_files()
        
        # Write PID file so the extension can discover which MCP server belongs to it
        self._write_pid_file()
        
        # Initialize Whisper model with comprehensive error handling
        self._whisper_error = None
        if WHISPER_AVAILABLE:
            self._whisper_model = self._initialize_whisper_model()
        else:
            logger.warning("⚠️ Faster-Whisper not available - speech-to-text will be disabled")
            logger.warning("💡 To enable speech features, install: pip install faster-whisper")
            self._whisper_error = "faster-whisper package not installed"
            
        # Start speech trigger monitoring
        self._start_speech_monitoring()
        
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

    def _initialize_whisper_model(self):
        """Initialize Whisper model with comprehensive error handling and fallbacks"""
        try:
            logger.info("🎤 Loading Faster-Whisper model for speech-to-text...")
            
            # Try different model configurations in order of preference
            model_configs = [
                {"model": "base", "device": "cpu", "compute_type": "int8"},
                {"model": "tiny", "device": "cpu", "compute_type": "int8"},
                {"model": "base", "device": "cpu", "compute_type": "float32"},
                {"model": "tiny", "device": "cpu", "compute_type": "float32"},
            ]
            
            for i, config in enumerate(model_configs):
                try:
                    logger.info(f"🔄 Attempting to load {config['model']} model (attempt {i+1}/{len(model_configs)})")
                    model = WhisperModel(config['model'], device=config['device'], compute_type=config['compute_type'])
                    
                    # Test the model with a quick inference to ensure it works
                    logger.info(f"✅ Successfully loaded {config['model']} model with {config['compute_type']}")
                    logger.info(f"📊 Model info - Device: {config['device']}, Compute: {config['compute_type']}")
                    return model
                    
                except Exception as model_error:
                    logger.warning(f"⚠️ Failed to load {config['model']} model: {model_error}")
                    if i == len(model_configs) - 1:
                        # This was the last attempt
                        raise model_error
                    continue
            
        except ImportError as import_error:
            error_msg = f"faster-whisper import failed: {import_error}"
            logger.error(f"❌ {error_msg}")
            self._whisper_error = error_msg
            return None
            
        except Exception as e:
            error_msg = f"Whisper model initialization failed: {e}"
            logger.error(f"❌ {error_msg}")
            
            # Check for common issues and provide specific guidance
            if "CUDA" in str(e):
                logger.error("💡 CUDA issue detected - make sure you have CPU-only version")
                logger.error("💡 Try: pip uninstall faster-whisper && pip install faster-whisper")
                error_msg += " (CUDA compatibility issue)"
            elif "Visual Studio" in str(e) or "MSVC" in str(e):
                logger.error("💡 Visual C++ issue detected on Windows")
                logger.error("💡 Install Visual Studio Build Tools or use pre-built wheels")
                error_msg += " (Visual C++ dependency missing)"
            elif "Permission" in str(e):
                logger.error("💡 Permission issue - check file access and antivirus")
                error_msg += " (Permission denied)"
            elif "disk space" in str(e).lower() or "no space" in str(e).lower():
                logger.error("💡 Disk space issue - whisper models require storage")
                error_msg += " (Insufficient disk space)"
            
            self._whisper_error = error_msg
            return None

    def setup_handlers(self):
        """Set up MCP request handlers"""
        
        @self.server.list_tools()
        async def list_tools():
            """List available Feedback Gate tools for Cursor Agent"""
            logger.info("🔧 Cursor Agent requesting available tools")
            tools = [
                Tool(
                    name="feedback_gate_chat",
                    description="Open Feedback Gate chat popup in Cursor for feedback. Use this when you need user input, feedback, or feedback from the human user. The popup will appear in Cursor and wait for user response. IMPORTANT: If the tool returns a [WAITING] status, you MUST immediately re-call this tool with the same message — the user is still being waited on and the request is active. Keep re-calling until you receive a 'User Response:' reply.",
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
                logger.warning(f"⚠️ Tool call cancelled for {name} (Agent turn aborted)")
                if self._pending_trigger_id:
                    logger.warning(f"🧹 Clearing pending trigger {self._pending_trigger_id} due to cancellation")
                    self._clear_trigger_state(responded=False)
                raise
            except Exception as e:
                logger.error(f"💥 Tool call error for {name}: {e}")
                if self._pending_trigger_id:
                    logger.warning(f"🧹 Clearing pending trigger {self._pending_trigger_id} due to exception")
                    self._clear_trigger_state(responded=False)
                await asyncio.sleep(1.0)
                return [TextContent(type="text", text=f"ERROR: Tool {name} failed: {str(e)}")]

    # Track whether a feedback gate trigger is currently pending
    _pending_trigger_id: str | None = None
    _pending_trigger_created_at: float = 0
    _last_trigger_responded_at: float = 0
    _heartbeat_count: int = 0
    _STALE_TRIGGER_SECONDS_CLI: int = 120   # 2min — stale for CLI mode (50s heartbeat)
    _STALE_TRIGGER_SECONDS_IDE: int = 4200  # 70min — stale for IDE mode (55min heartbeat)

    def _clear_trigger_state(self, responded: bool = False):
        """Reset all trigger tracking fields consistently.
        
        Args:
            responded: True if user actually responded (sets cooldown),
                      False if timeout/error/stale (no cooldown).
        """
        self._pending_trigger_id = None
        self._pending_trigger_created_at = 0
        self._heartbeat_count = 0
        self._last_trigger_responded_at = time.time() if responded else 0

    def _read_and_consume_response(self, response_file: Path) -> str | None:
        """Read a response JSON file, populate _last_attachments/_last_files, delete the file.
        Returns user_input string or None if parsing failed."""
        try:
            file_content = response_file.read_text().strip()
            if not file_content:
                return None

            user_input = ""
            if file_content.startswith('{'):
                data = json.loads(file_content)
                user_input = data.get("user_input", data.get("response", data.get("message", ""))).strip()
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

            response_file.unlink(missing_ok=True)
            return user_input if user_input else None
        except Exception as e:
            logger.error(f"❌ Error reading response file {response_file}: {e}")
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
    # every 55 minutes so the call never hits the 1h limit.
    _IDE_WAIT_SECONDS = 3300  # 55 minutes
    _IDE_MAX_TOTAL_SECONDS = 259200  # 72h max total wait for IDE

    @staticmethod
    def _build_heartbeat_message(count: int, elapsed_min: float) -> str:
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
        return (
            f"[WAITING] {preamble} "
            "You MUST immediately call feedback_gate_chat again with the same message "
            "to continue waiting. Do NOT end your response or summarize — just call "
            "the tool again now."
        )

    async def _handle_feedback_gate_chat(self, args: dict) -> list[TextContent]:
        """Handle Feedback Gate chat popup and wait for user input with 5 minute timeout"""
        message = args.get("message", "请提供你的反馈：")
        title = args.get("title", "Feedback Gate")
        context = args.get("context", "")
        urgent = args.get("urgent", False)
        
        is_remote = bool(self._find_routing_file())
        
        # If a previous trigger is still pending (no response yet), re-enter the
        # wait loop instead of creating a new trigger.  After the heartbeat ceiling
        # (50s for CLI, 55min for IDE) we return a WAITING message and the Agent
        # calls feedback_gate_chat again — we resume waiting here.
        if self._pending_trigger_id:
            stale_age = time.time() - self._pending_trigger_created_at if self._pending_trigger_created_at else float('inf')
            stale_limit = self._STALE_TRIGGER_SECONDS_CLI if is_remote else self._STALE_TRIGGER_SECONDS_IDE
            if stale_age > stale_limit:
                logger.warning(f"🧹 Clearing stale pending trigger {self._pending_trigger_id} (age: {stale_age:.0f}s)")
                self._clear_trigger_state(responded=False)
            else:
                response_file = Path(get_temp_path(f"feedback_gate_response_{self._pending_trigger_id}.json"))
                if response_file.exists():
                    ready_input = self._read_and_consume_response(response_file)
                    if ready_input:
                        self._clear_trigger_state(responded=True)
                        logger.info(f"✅ Found ready response for pending trigger: {ready_input[:100]}...")
                        result = [TextContent(type="text", text=f"User Response: {ready_input}")]
                        self._append_media_to_response(result)
                        return result
                    self._clear_trigger_state(responded=False)
                else:
                    wait_secs = self._REMOTE_WAIT_SECONDS if is_remote else self._IDE_WAIT_SECONDS
                    max_secs = self._REMOTE_MAX_TOTAL_SECONDS if is_remote else self._IDE_MAX_TOTAL_SECONDS
                    label = "CLI" if is_remote else "IDE"
                    logger.info(f"🔄 Re-entering wait for pending trigger {self._pending_trigger_id} ({label}, {wait_secs}s)")
                    user_input = await self._wait_for_user_input(
                        self._pending_trigger_id, timeout=wait_secs
                    )
                    if user_input:
                        self._clear_trigger_state(responded=True)
                        logger.info(f"✅ RETURNING USER FEEDBACK TO MCP CLIENT: {user_input[:100]}...")
                        result = [TextContent(type="text", text=f"User Response: {user_input}")]
                        self._append_media_to_response(result)
                        return result
                    else:
                        self._heartbeat_count += 1
                        elapsed_total = self._heartbeat_count * wait_secs
                        elapsed_min = elapsed_total / 60
                        if elapsed_total >= max_secs:
                            self._clear_trigger_state(responded=False)
                            max_hours = max_secs / 3600
                            logger.warning(f"⏰ {label} wait exceeded {max_hours:.0f}h limit ({elapsed_min:.0f}min)")
                            return [TextContent(type="text", text=f"TIMEOUT: No user input received within {max_hours:.0f} hours ({label} limit). Stopping wait.")]
                        logger.info(f"⏳ Still waiting for user reply (trigger {self._pending_trigger_id}, heartbeat #{self._heartbeat_count}, ~{elapsed_min:.1f}min, {label})")
                        return [TextContent(type="text", text=self._build_heartbeat_message(self._heartbeat_count, elapsed_min))]
        
        # Brief cooldown: avoid rapid re-trigger right after receiving a response.
        # Only 2 seconds — long enough to let Agent process feedback, short enough to
        # allow a quick follow-up feedback gate in the same turn.
        if self._last_trigger_responded_at and (time.time() - self._last_trigger_responded_at) < 2:
            logger.info("⏭️ Feedback Gate skipped: brief cooldown after recent response")
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
        trigger_id = f"fg_{int(time.time() * 1000)}"  # Use milliseconds for uniqueness
        
        # Force immediate trigger creation with enhanced debugging
        success = await self._trigger_cursor_popup_immediately({
            "tool": "feedback_gate_chat",
            "message": message,
            "title": title,
            "context": context,
            "urgent": urgent,
            "trigger_id": trigger_id,
            "timestamp": datetime.now().isoformat(),
            "immediate_activation": True
        })
        
        if success:
            self._pending_trigger_id = trigger_id
            self._pending_trigger_created_at = time.time()
            self._heartbeat_count = 0
            logger.info(f"🔥 POPUP TRIGGERED IMMEDIATELY - waiting for user input (trigger_id: {trigger_id})")
            
            # Quick check: is the extension alive?
            # The extension polls every 250ms and deletes trigger files immediately.
            # If the trigger file still exists after 5s, no extension is running.
            trigger_file = Path(get_temp_path(f"feedback_gate_trigger_pid{self._server_pid}.json"))
            extension_alive = False
            for _ in range(10):
                await asyncio.sleep(0.5)
                if not trigger_file.exists():
                    extension_alive = True
                    break
            
            if not extension_alive:
                logger.warning("⚠️ Trigger file not consumed — no Feedback Gate extension detected")
                self._clear_trigger_state(responded=False)
                try:
                    trigger_file.unlink(missing_ok=True)
                    Path(get_temp_path("feedback_gate_trigger.json")).unlink(missing_ok=True)
                except Exception:
                    pass
                return [TextContent(type="text", text="SKIP: Feedback Gate extension is not active (no GUI detected). Continuing without user feedback.")]
            
            # Wait for extension acknowledgement
            ack_received = await self._wait_for_extension_acknowledgement(trigger_id, timeout=15)
            if ack_received:
                logger.info("📨 Extension acknowledged popup activation")
            else:
                logger.warning("⚠️ No extension acknowledgement received — but trigger was consumed, proceeding")
            
            wait_secs = self._REMOTE_WAIT_SECONDS if is_remote else self._IDE_WAIT_SECONDS
            max_secs = self._REMOTE_MAX_TOTAL_SECONDS if is_remote else self._IDE_MAX_TOTAL_SECONDS
            label = "CLI" if is_remote else "IDE"
            logger.info(f"⏳ Waiting for user input (timeout={wait_secs}s, {label})...")
            user_input = await self._wait_for_user_input(trigger_id, timeout=wait_secs)
            
            if user_input:
                self._clear_trigger_state(responded=True)
                logger.info(f"✅ RETURNING USER FEEDBACK TO MCP CLIENT: {user_input[:100]}...")
                
                response_content = [TextContent(type="text", text=f"User Response: {user_input}")]
                
                self._append_media_to_response(response_content)
                
                return response_content
            else:
                self._heartbeat_count += 1
                elapsed_total = self._heartbeat_count * wait_secs
                elapsed_min = elapsed_total / 60
                if elapsed_total >= max_secs:
                    self._clear_trigger_state(responded=False)
                    max_hours = max_secs / 3600
                    logger.warning(f"⏰ {label} wait exceeded {max_hours:.0f}h limit ({elapsed_min:.0f}min)")
                    return [TextContent(type="text", text=f"TIMEOUT: No user input received within {max_hours:.0f} hours ({label} limit). Stopping wait.")]
                logger.info(f"⏳ {label} wait timed out, returning heartbeat (trigger {trigger_id}, heartbeat #{self._heartbeat_count}, ~{elapsed_min:.1f}min)")
                return [TextContent(type="text", text=self._build_heartbeat_message(self._heartbeat_count, elapsed_min))]
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
        
        import glob
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
                                    user_input = data.get("user_input", data.get("response", data.get("message", ""))).strip()
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
                                    logger.info(f"🧹 Response files cleaned up for trigger {trigger_id}")
                                    
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
                    except:
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
        
        logger.warning(f"⏰ TIMEOUT waiting for user input (trigger_id: {trigger_id})")
        return None

    async def _trigger_cursor_popup_immediately(self, data: dict) -> bool:
        """Create trigger file for Cursor extension with immediate activation and instance isolation"""
        try:
            # PID-namespaced trigger file for multi-instance isolation
            trigger_file = Path(get_temp_path(f"feedback_gate_trigger_pid{self._server_pid}.json"))
            # Also write legacy trigger for backward compatibility
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
            
            logger.info(f"🎯 CREATING PID-namespaced trigger file (PID: {self._server_pid})")
            
            # Write PID-namespaced trigger file
            trigger_file.write_text(json.dumps(trigger_data, indent=2))
            # Also write legacy trigger for backward compatibility
            legacy_trigger_file.write_text(json.dumps(trigger_data, indent=2))
            
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
            
            # Force file system sync with retry
            for attempt in range(3):
                try:
                    os.sync()
                    break
                except Exception as sync_error:
                    logger.warning(f"⚠️ Sync attempt {attempt + 1} failed: {sync_error}")
                    await asyncio.sleep(0.1)  # Wait 100ms between attempts
            
            logger.info(f"🔥 IMMEDIATE trigger created for Cursor: {trigger_file}")
            logger.info(f"📁 Trigger file path: {trigger_file.absolute()}")
            logger.info(f"📊 Trigger file size: {file_size} bytes")
            
            await asyncio.sleep(0.05)
            
            # Note: Trigger file may have been consumed by extension already, which is good!
            try:
                if trigger_file.exists():
                    logger.info(f"✅ Trigger file still exists: {trigger_file}")
                else:
                    logger.info(f"✅ Trigger file was consumed by extension: {trigger_file}")
                    logger.info(f"🎯 This is expected behavior - extension is working properly")
            except Exception as check_error:
                logger.info(f"✅ Cannot check trigger file status (likely consumed): {check_error}")
                logger.info(f"🎯 This is expected behavior - extension is working properly")
            
            # Check if extension might be watching
            log_file = Path(get_temp_path("feedback_gate.log"))
            if log_file.exists():
                logger.info(f"📝 MCP log file exists: {log_file}")
            else:
                logger.warning(f"⚠️ MCP log file missing: {log_file}")
            
            # Force log flush
            for handler in logger.handlers:
                if hasattr(handler, 'flush'):
                    handler.flush()
            
            return True
            
        except Exception as e:
            logger.error(f"❌ CRITICAL: Failed to create Feedback Gate trigger: {e}")
            import traceback
            logger.error(f"🔍 Full traceback: {traceback.format_exc()}")
            # Wait before returning failure
            await asyncio.sleep(1.0)  # Wait 1 second before confirming failure
            return False

    async def _create_backup_triggers(self, data: dict):
        """Create backup trigger files for better reliability (PID-namespaced)"""
        try:
            for i in range(3):
                backup_trigger = Path(get_temp_path(f"feedback_gate_trigger_pid{self._server_pid}_{i}.json"))
                backup_data = {
                    "backup_id": i,
                    "timestamp": datetime.now().isoformat(),
                    "system": "feedback-gate",
                    "data": data,
                    "pid": self._server_pid,
                    "ppid": os.getppid(),
                    "mcp_integration": True,
                    "immediate_activation": True
                }
                backup_trigger.write_text(json.dumps(backup_data, indent=2))
            
            logger.info(f"🔄 PID-namespaced backup triggers created (PID: {self._server_pid})")
            
        except Exception as e:
            logger.warning(f"⚠️ Backup trigger creation failed: {e}")

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
        """Periodically update log file to keep MCP status active in extension"""
        logger.info("💓 Starting heartbeat logger for extension status monitoring")
        heartbeat_count = 0
        
        while not self.shutdown_requested:
            try:
                # Update log every 10 seconds to keep file modification time fresh
                await asyncio.sleep(10)
                heartbeat_count += 1
                
                # Write heartbeat to log
                logger.info(f"💓 MCP heartbeat #{heartbeat_count} - Server is active and ready")
                
                # Force log flush to ensure file is updated
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
                    
            # Clean up any orphaned audio files (older than 5 minutes)
            import time
            current_time = time.time()
            temp_dir = get_temp_path("")
            audio_pattern = os.path.join(temp_dir, "feedback_gate_audio_*.wav")
            
            for audio_file in glob.glob(audio_pattern):
                try:
                    file_age = current_time - os.path.getmtime(audio_file)
                    if file_age > 300:  # 5 minutes
                        Path(audio_file).unlink()
                        logger.info(f"🗑️ Cleaned up old audio file: {os.path.basename(audio_file)}")
                except Exception as cleanup_error:
                    logger.warning(f"⚠️ Could not clean up audio file {audio_file}: {cleanup_error}")
                    
        except Exception as e:
            logger.warning(f"⚠️ Cleanup warning: {e}")
        
        logger.info("✅ Cleanup completed - shutdown ready")
        return True

    def _start_speech_monitoring(self):
        """Start monitoring for speech-to-text trigger files with enhanced error handling"""
        self._speech_monitoring_active = False
        self._speech_thread = None
        
        def monitor_speech_triggers():
            """Enhanced speech monitoring with health checks and better error handling"""
            monitor_start_time = time.time()
            processed_count = 0
            error_count = 0
            last_heartbeat = time.time()
            
            logger.info("🎤 Speech monitoring thread started successfully")
            self._speech_monitoring_active = True
            
            while not self.shutdown_requested:
                try:
                    current_time = time.time()
                    
                    # Heartbeat logging every 60 seconds
                    if current_time - last_heartbeat > 60:
                        uptime = int(current_time - monitor_start_time)
                        logger.info(f"💓 Speech monitor heartbeat - Uptime: {uptime}s, Processed: {processed_count}, Errors: {error_count}")
                        last_heartbeat = current_time
                    
                    # Look for speech trigger files using cross-platform temp path
                    temp_dir = get_temp_path("")
                    speech_triggers = glob.glob(os.path.join(temp_dir, "feedback_gate_speech_trigger_*.json"))
                    
                    for trigger_file in speech_triggers:
                        try:
                            # Validate file exists and is readable
                            if not os.path.exists(trigger_file):
                                continue
                                
                            with open(trigger_file, 'r', encoding='utf-8') as f:
                                trigger_data = json.load(f)
                            
                            if trigger_data.get('data', {}).get('tool') == 'speech_to_text':
                                logger.info(f"🎤 Processing speech-to-text request: {os.path.basename(trigger_file)}")
                                self._process_speech_request(trigger_data)
                                processed_count += 1
                                
                                # Clean up trigger file safely
                                try:
                                    Path(trigger_file).unlink()
                                    logger.debug(f"🗑️ Cleaned up trigger file: {os.path.basename(trigger_file)}")
                                except Exception as cleanup_error:
                                    logger.warning(f"⚠️ Could not clean up trigger file: {cleanup_error}")
                                
                        except json.JSONDecodeError as json_error:
                            logger.error(f"❌ Invalid JSON in speech trigger {trigger_file}: {json_error}")
                            error_count += 1
                            try:
                                Path(trigger_file).unlink()  # Remove invalid file
                            except:
                                pass
                                
                        except Exception as e:
                            logger.error(f"❌ Error processing speech trigger {trigger_file}: {e}")
                            error_count += 1
                            try:
                                Path(trigger_file).unlink()
                            except:
                                pass
                    
                    time.sleep(0.5)  # Check every 500ms
                    
                except Exception as e:
                    logger.error(f"❌ Critical speech monitoring error: {e}")
                    error_count += 1
                    time.sleep(2)  # Longer wait on critical errors
                    
                    # If too many errors, consider restarting
                    if error_count > 10:
                        logger.warning("⚠️ Too many speech monitoring errors - attempting recovery")
                        time.sleep(5)
                        error_count = 0  # Reset error count after recovery pause
            
            self._speech_monitoring_active = False
            logger.info("🛑 Speech monitoring thread stopped")
        
        try:
            # Start monitoring in background thread
            import threading
            self._speech_thread = threading.Thread(target=monitor_speech_triggers, daemon=True)
            self._speech_thread.name = "FeedbackGate-SpeechMonitor"
            self._speech_thread.start()
            
            # Verify thread started successfully
            time.sleep(0.1)  # Give thread time to start
            if self._speech_thread.is_alive():
                logger.info("✅ Speech-to-text monitoring started successfully")
            else:
                logger.error("❌ Speech monitoring thread failed to start")
                self._speech_monitoring_active = False
                
        except Exception as e:
            logger.error(f"❌ Failed to start speech monitoring thread: {e}")
            self._speech_monitoring_active = False

    def _process_speech_request(self, trigger_data):
        """Process speech-to-text request"""
        try:
            audio_file = trigger_data.get('data', {}).get('audio_file')
            trigger_id = trigger_data.get('data', {}).get('trigger_id')
            
            if not audio_file or not trigger_id:
                logger.error("❌ Invalid speech request - missing audio_file or trigger_id")
                return
            
            if not self._whisper_model:
                error_detail = self._whisper_error or "Whisper model not available"
                logger.error(f"❌ Whisper model not available: {error_detail}")
                self._write_speech_response(trigger_id, "", f"Speech-to-text unavailable: {error_detail}")
                return
            
            if not os.path.exists(audio_file):
                logger.error(f"❌ Audio file not found: {audio_file}")
                self._write_speech_response(trigger_id, "", "Audio file not found")
                return
            
            logger.info(f"🎤 Transcribing audio: {audio_file}")
            
            # Transcribe audio using Faster-Whisper
            segments, info = self._whisper_model.transcribe(audio_file, beam_size=5)
            transcription = " ".join(segment.text for segment in segments).strip()
            
            logger.info(f"✅ Speech transcribed: '{transcription}'")
            
            # Write response
            self._write_speech_response(trigger_id, transcription)
            
            # Clean up audio file (MCP server is responsible for this)
            try:
                # Small delay to ensure any pending file operations complete
                import time
                time.sleep(0.1)
                
                if Path(audio_file).exists():
                    Path(audio_file).unlink()
                    logger.info(f"🗑️ Cleaned up audio file: {os.path.basename(audio_file)}")
                else:
                    logger.debug(f"Audio file already cleaned up: {os.path.basename(audio_file)}")
            except Exception as e:
                logger.warning(f"⚠️ Could not clean up audio file: {e}")
                
        except Exception as e:
            logger.error(f"❌ Speech transcription failed: {e}")
            trigger_id = trigger_data.get('data', {}).get('trigger_id', 'unknown')
            self._write_speech_response(trigger_id, "", str(e))

    def _write_speech_response(self, trigger_id, transcription, error=None):
        """Write speech-to-text response"""
        try:
            response_data = {
                'timestamp': datetime.now().isoformat(),
                'trigger_id': trigger_id,
                'transcription': transcription,
                'success': error is None,
                'error': error,
                'source': 'feedback_gate_whisper'
            }
            
            response_file = get_temp_path(f"feedback_gate_speech_response_{trigger_id}.json")
            with open(response_file, 'w') as f:
                json.dump(response_data, f, indent=2)
            
            logger.info(f"📝 Speech response written: {response_file}")
            
        except Exception as e:
            logger.error(f"❌ Failed to write speech response: {e}")

    def get_speech_monitoring_status(self):
        """Get comprehensive status of speech monitoring system"""
        status = {
            "speech_monitoring_active": getattr(self, '_speech_monitoring_active', False),
            "speech_thread_alive": getattr(self, '_speech_thread', None) and self._speech_thread.is_alive(),
            "whisper_model_loaded": self._whisper_model is not None,
            "whisper_error": getattr(self, '_whisper_error', None),
            "faster_whisper_available": WHISPER_AVAILABLE
        }
        
        # Log status if there are issues
        if not status["speech_monitoring_active"]:
            logger.warning("⚠️ Speech monitoring is not active")
        if not status["speech_thread_alive"]:
            logger.warning("⚠️ Speech monitoring thread is not running")
        if not status["whisper_model_loaded"]:
            logger.warning(f"⚠️ Whisper model not loaded: {status['whisper_error']}")
        
        return status

async def main():
    """Main entry point for Feedback Gate MCP Server"""
    logger.info("🎬 STARTING Feedback Gate MCP Server...")
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
        logger.info("🛑 Server stopped by user")
    except Exception as e:
        logger.error(f"❌ Server crashed: {e}")
        sys.exit(1) 