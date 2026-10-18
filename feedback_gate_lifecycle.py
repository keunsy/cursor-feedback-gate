"""Bind pending Feedback Gate waits to Cursor conversations and resume them on stop.

This module also runs as the beforeMCPExecution/stop hook. It uses only stdlib,
does not read chat transcripts, and does not execute any tool arguments.
"""

import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import uuid
import shutil
import shlex
import subprocess


class WaitRegistry:
    def __init__(self, root=None):
        self.root = Path(root or os.environ.get("FEEDBACK_GATE_STATE_DIR")
                         or Path(tempfile.gettempdir()) / "feedback_gate_state")

    def _path(self, kind, key):
        digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
        return self.root / f"{kind}-{digest}.json"

    def read(self, kind, key):
        try:
            value = json.loads(self._path(kind, key).read_text(encoding="utf-8"))
            return value if isinstance(value, dict) else {}
        except (OSError, ValueError):
            return {}

    def write(self, kind, key, value):
        self.root.mkdir(parents=True, exist_ok=True)
        path = self._path(kind, key)
        temporary = path.with_suffix(f".{os.getpid()}.{uuid.uuid4().hex}.tmp")
        try:
            with temporary.open("w", encoding="utf-8") as stream:
                if os.name != "nt":
                    os.chmod(temporary, 0o600)
                json.dump(value, stream, ensure_ascii=False)
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)

    def response_path(self, session_id):
        return self._path('reply', session_id)

    def preserve_response(self, session_id, trigger_id, response_file):
        """Keep an unread reply across a controlled MCP restart, in its session."""
        if not session_id or not trigger_id:
            raise ValueError('A reply must have a session and trigger')
        response_file = Path(response_file)
        payload = json.loads(response_file.read_text(encoding='utf-8'))
        if not isinstance(payload, dict) or payload.get('trigger_id', trigger_id) != trigger_id:
            raise ValueError('Response does not match the specified trigger')
        if payload.get('session_id', session_id) != session_id:
            raise ValueError('Response belongs to a different session')
        if self.response_path(session_id).exists():
            raise FileExistsError('An unread reply is already preserved for this session')
        self.write('reply', session_id, dict(payload, session_id=session_id, trigger_id=trigger_id))
        # Delete only after the private durable copy has been written successfully.
        response_file.unlink()

    def begin_wait(self, session_id, call_id, started_at, max_total_seconds):
        self.write("wait", session_id, {
            "session_id": session_id, "call_id": call_id, "state": "waiting",
            "call_active": True, "started_at": started_at,
            "expires_at": started_at + max_total_seconds, "updated_at": time.time(),
        })

    def finish_wait(self, session_id, call_id, state):
        current = self.read("wait", session_id)
        if current.get("call_id") != call_id or current.get("state") == "cancelled_by_user":
            return
        current.update(state=state, call_active=False, updated_at=time.time())
        self.write("wait", session_id, current)

    def bind_conversation(self, conversation_id, arguments):
        session_id = arguments.get("session_id")
        if not isinstance(session_id, str) or not session_id.strip():
            return
        old = self.read("conversation", conversation_id)
        binding = {
            "conversation_id": conversation_id, "session_id": session_id.strip(),
            "arguments": {key: arguments[key] for key in
                          ("message", "title", "context", "urgent", "session_id", "workspace_path")
                          if key in arguments},
            "updated_at": time.time(),
        }
        if old.get("session_id") == binding["session_id"]:
            binding["last_resumed_call"] = old.get("last_resumed_call")
        self.write("conversation", conversation_id, binding)

    def on_stop(self, payload):
        conversation_id = payload.get("conversation_id")
        if not isinstance(conversation_id, str) or not conversation_id:
            return {}
        binding = self.read("conversation", conversation_id)
        session_id = binding.get("session_id")
        if not session_id:
            return {}
        wait = self.read("wait", session_id)
        if payload.get("status") == "aborted":
            binding['cancelled_by_user'] = True
            self.write('conversation', conversation_id, binding)
            if wait.get("state") in ("waiting", "interrupted"):
                wait.update(state="cancelled_by_user", call_active=False, updated_at=time.time())
                self.write("wait", session_id, wait)
            return {}
        if payload.get("status") != "completed":
            return {}
        if binding.get('cancelled_by_user'):
            return {}
        if wait.get("state") not in ("waiting", "interrupted") or wait.get("call_active"):
            return {}
        if not isinstance(wait.get("expires_at"), (int, float)) or time.time() >= wait["expires_at"]:
            return {}
        call_id = wait.get("call_id")
        if not call_id or binding.get("last_resumed_call") == call_id:
            return {}  # Do not spin if the model ignores the previous continuation.
        arguments = binding.get("arguments")
        if not isinstance(arguments, dict) or arguments.get("session_id", "").strip() != session_id:
            return {}
        # Two stop invocations must not both resume the same tool call.
        try:
            claim = os.open(self._path('resume', conversation_id + ':' + call_id),
                            os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            return {}
        os.close(claim)
        latest = self.read('wait', session_id)
        if latest.get('call_id') != call_id or latest.get('state') not in ('waiting', 'interrupted'):
            return {}
        binding["last_resumed_call"] = call_id
        binding["updated_at"] = time.time()
        self.write("conversation", conversation_id, binding)
        return {"followup_message": (
            "Feedback Gate is still waiting for my reply in this same conversation. "
            "Call feedback_gate_chat again now using the exact arguments below. "
            "A [WAITING] heartbeat is not a reply from me. Keep waiting; do not start "
            "a new task or give a final answer. Arguments: "
            + json.dumps(arguments, ensure_ascii=False)
        )}


def handle_hook(payload, registry=None):
    if not isinstance(payload, dict):
        return {}
    registry = registry or WaitRegistry()
    event = payload.get("hook_event_name")
    if event == "beforeMCPExecution":
        tool = payload.get("tool_name", "")
        server = payload.get("mcp_server_name", "")
        if isinstance(tool, str) and server in ("feedback-gate", "") and (
                tool == "feedback_gate_chat" or (server == "feedback-gate" and tool.endswith("feedback_gate_chat"))):
            arguments = payload.get("tool_input", {})
            if isinstance(arguments, str):
                try:
                    arguments = json.loads(arguments)
                except ValueError:
                    arguments = None
            conversation_id = payload.get("conversation_id")
            if isinstance(arguments, dict) and isinstance(conversation_id, str) and conversation_id:
                registry.bind_conversation(conversation_id, arguments)
        return {"permission": "allow"}
    if event == "stop":
        return registry.on_stop(payload)
    return {}


def install_hooks(config_file=None):
    config_file = Path(config_file or Path.home() / '.cursor' / 'hooks.json')
    config_file.parent.mkdir(parents=True, exist_ok=True)
    config = json.loads(config_file.read_text(encoding='utf-8')) if config_file.exists() else {'version': 1}
    if config_file.exists():
        shutil.copy2(config_file, config_file.with_name(f'hooks.json.feedback-gate-backup-{uuid.uuid4().hex[:8]}'))
    script = Path(__file__).resolve()
    arguments = [Path(sys.executable).as_posix(), '-u', script.as_posix()]
    command = subprocess.list2cmdline(arguments) if os.name == 'nt' else shlex.join(arguments)
    hooks = config.setdefault('hooks', {})
    for event in ('beforeMCPExecution', 'stop'):
        entries = hooks.setdefault(event, [])
        entries[:] = [entry for entry in entries if 'feedback_gate_lifecycle.py' not in entry.get('command', '')]
        entry = {'command': command, 'timeout': 10}
        if event == 'stop':
            entry['loop_limit'] = None  # The per-session expiry and call-id guard bound continuation.
        entries.append(entry)
    config.setdefault('version', 1)
    config_file.write_text(json.dumps(config, indent=2) + '\n', encoding='utf-8')
    return str(config_file)


def uninstall_hooks(config_file=None):
    config_file = Path(config_file or Path.home() / '.cursor' / 'hooks.json')
    if not config_file.exists():
        return str(config_file)
    config = json.loads(config_file.read_text(encoding='utf-8'))
    hooks = config.get('hooks', {})
    for event in ('beforeMCPExecution', 'stop'):
        if event in hooks:
            hooks[event] = [entry for entry in hooks[event]
                            if 'feedback_gate_lifecycle.py' not in entry.get('command', '')]
            if not hooks[event]:
                del hooks[event]
    config_file.write_text(json.dumps(config, indent=2) + '\n', encoding='utf-8')
    return str(config_file)


if __name__ == "__main__":
    if sys.argv[1:] == ['--install-hooks']:
        print(json.dumps({'configured': install_hooks()}))
        raise SystemExit(0)
    if sys.argv[1:] == ['--uninstall-hooks']:
        print(json.dumps({'configured': uninstall_hooks()}))
        raise SystemExit(0)
    try:
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8-sig"))
        result = handle_hook(payload)
    except (OSError, ValueError, TypeError, AttributeError):
        result = {"permission": "allow"} if locals().get("payload", {}).get("hook_event_name") == "beforeMCPExecution" else {}
    # ASCII JSON is robust when Cursor launches the hook from a legacy Windows console.
    print(json.dumps(result, ensure_ascii=True), flush=True)
