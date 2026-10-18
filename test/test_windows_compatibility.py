"""Exercise production MCP methods without starting a server or touching user files.

Run: python -m unittest discover -s test -p test_windows_compatibility.py -v
"""

import ast
import asyncio
from datetime import datetime
import glob
import io
import json
import logging
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]


def load_server():
    # Execute the shipped class, not a simulated implementation. Avoid the
    # module's logging setup and the server constructor's real temp-file cleanup.
    tree = ast.parse((ROOT / "feedback_gate_mcp.py").read_text(encoding="utf-8"))
    nodes = [ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0)]
    nodes.extend(node for node in tree.body if isinstance(node, ast.ClassDef)
                 and node.name == "FeedbackGateServer")
    namespace = dict(asyncio=asyncio, datetime=datetime, glob=glob, json=json,
                     logger=logging.getLogger("windows-compatibility-tests"),
                     os=os, Path=Path, time=time, _log_event=lambda *args: None)
    exec(compile(ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[])),
                 str(ROOT / "feedback_gate_mcp.py"), "exec"), namespace)
    return namespace


class WindowsCompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fg-compat-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.namespace = load_server()
        self.namespace["get_temp_path"] = lambda name: str(self.root / name)
        self.cls = self.namespace["FeedbackGateServer"]
        self.server = self.cls.__new__(self.cls)
        self.server._server_pid = os.getpid()
        self.server._session_to_eh_pid = {}
        self.server._session_to_workspace = {}
        self.server._ancestor_pids_cache = []

    def sleeping_child(self):
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 creationflags=(subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW)
                                 if os.name == "nt" else 0)
        def stop_child():
            if child.poll() is None:
                child.terminate()
            child.wait(timeout=5)
        self.addCleanup(stop_child)
        return child

    def assert_still_running(self, child):
        with self.assertRaises(subprocess.TimeoutExpired,
                               msg="A liveness check must not terminate the process"):
            child.wait(timeout=0.15)

    @unittest.skipUnless(os.name == "nt", "Native Windows process API")
    def test_reports_real_parent_and_respects_depth(self):
        ancestors = self.cls._get_ancestor_pids(os.getpid())
        self.assertTrue(ancestors, "Windows must not depend on the POSIX ps command")
        self.assertEqual(ancestors[0], os.getppid())
        self.assertEqual(self.cls._get_ancestor_pids(os.getpid(), max_depth=1), [os.getppid()])
        self.assertEqual(self.cls._get_ancestor_pids(os.getpid(), max_depth=0), [])

    @unittest.skipUnless(os.name == "nt", "Native Windows process API")
    def test_reports_child_ancestor(self):
        child = self.sleeping_child()
        self.assertEqual(self.cls._get_ancestor_pids(child.pid, max_depth=1), [os.getpid()])

    @unittest.skipUnless(os.name == "nt", "Native Windows process API")
    def test_startup_cleanup_preserves_live_mcp_process(self):
        child = self.sleeping_child()
        pid_file = self.root / f"feedback_gate_mcp_{child.pid}.pid"
        pid_file.write_text(json.dumps({"pid": child.pid}), encoding="utf-8")
        # Never let a regressed implementation send CTRL_C_EVENT (signal 0
        # on Windows) to the test console. The fixed path queries the real PID.
        with mock.patch.object(os, "kill") as send_signal:
            self.server._cleanup_stale_files()
        send_signal.assert_not_called()
        self.assert_still_running(child)
        self.assertTrue(pid_file.exists())

    @unittest.skipUnless(os.name == "nt", "Native Windows process API")
    def test_recovery_preserves_live_extension_host(self):
        child = self.sleeping_child()
        self.server._session_to_eh_pid["session"] = child.pid
        with mock.patch.object(os, "kill") as send_signal:
            result = asyncio.run(self.server._rewrite_trigger_for_recovery(
                "trigger", {"session_id": "session"}))
        send_signal.assert_not_called()
        self.assertFalse(result)
        self.assert_still_running(child)

    @unittest.skipUnless(os.name == "nt", "Native Windows process API")
    def test_cleanup_removes_dead_mcp_state(self):
        child = self.sleeping_child()
        child.terminate()
        child.wait(timeout=5)
        pid_file = self.root / f"feedback_gate_mcp_{child.pid}.pid"
        pid_file.write_text(json.dumps({"pid": child.pid}), encoding="utf-8")
        self.server._cleanup_stale_files()
        self.assertFalse(pid_file.exists())

    @unittest.skipUnless(os.name == "nt", "Native Windows process API")
    def test_recovery_rewrites_dead_extension_host_trigger(self):
        child = self.sleeping_child()
        child.terminate()
        child.wait(timeout=5)
        self.server._session_to_eh_pid["session"] = child.pid
        self.assertTrue(asyncio.run(self.server._rewrite_trigger_for_recovery(
            "trigger", {"session_id": "session", "message": "Continue"})))
        trigger = json.loads((self.root / "feedback_gate_trigger_fg_trigger.json").read_text(encoding="utf-8"))
        self.assertIsNone(trigger["target_extension_host_pid"])
        self.assertNotIn("session", self.server._session_to_eh_pid)

    def legacy_text_io(self):
        original_open = io.open
        def legacy_open(file, mode="r", buffering=-1, encoding=None, *args, **kwargs):
            if "b" not in mode and encoding in (None, "locale"):
                encoding = "cp1252"
            return original_open(file, mode, buffering, encoding, *args, **kwargs)
        return mock.patch("io.open", side_effect=legacy_open)

    def test_utf8_reply_survives_non_utf8_default_encoding(self):
        response = self.root / "response.json"
        feedback = "用户反馈 🪟 café"
        response.write_text(json.dumps({"user_input": feedback}, ensure_ascii=False), encoding="utf-8")
        with self.legacy_text_io():
            self.assertEqual(self.server._read_and_consume_response(response), feedback)
        self.assertFalse(response.exists())

    def test_utf8_heartbeat_config_survives_non_utf8_default_encoding(self):
        config = self.root / "config.json"
        reply = "请继续 🪟"
        config.write_text(json.dumps({"heartbeat_reply": reply}, ensure_ascii=False), encoding="utf-8")
        self.cls._HEARTBEAT_CONFIG_PATH = str(config)
        with self.legacy_text_io():
            self.assertEqual(self.cls._load_heartbeat_config()[1], reply)

    @unittest.skipUnless(os.name == "nt", "Windows path semantics")
    def test_equivalent_workspace_keeps_cached_window(self):
        self.server._session_to_eh_pid["session"] = 12345
        self.server._session_to_workspace["session"] = r"C:\Work\Project"
        data = {"trigger_id": "trigger", "session_id": "session", "workspace_path": "c:/work/project/"}
        with mock.patch.dict(os.environ, {"FEEDBACK_GATE_CHAT_ID": "", "FEEDBACK_GATE_ROUTING_FILE": ""}):
            self.assertTrue(asyncio.run(self.server._trigger_cursor_popup_immediately(data)))
        trigger = json.loads((self.root / "feedback_gate_trigger_fg_trigger.json").read_text(encoding="utf-8"))
        self.assertEqual(trigger["target_extension_host_pid"], 12345)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fg-install-")
        self.addCleanup(self.temp.cleanup)
        self.profile = Path(self.temp.name) / "Windows User's 文件"
        self.config = self.profile / ".cursor" / "mcp.json"
        self.config.parent.mkdir(parents=True)
        self.install = self.profile / "cursor-extensions" / "feedback-gate"
        self.existing = {"mcpServers": {"existing": {"command": "keep-me"}}, "metadata": "保留"}
        self.config.write_text(json.dumps(self.existing, ensure_ascii=False), encoding="utf-8")

    def git_bash(self):
        git = shutil.which("git")
        bash = Path(git).parents[1] / "bin" / "bash.exe" if git else None
        if not bash or not bash.exists():
            self.skipTest("Git Bash is not installed")
        return str(bash)

    def assert_config(self):
        config = json.loads(self.config.read_text(encoding="utf-8"))
        self.assertEqual(config["metadata"], self.existing["metadata"])
        self.assertEqual(config["mcpServers"]["existing"], self.existing["mcpServers"]["existing"])
        server = config["mcpServers"]["feedback-gate"]
        python_path = self.install / "venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        self.assertEqual(server["command"], str(python_path))
        self.assertEqual(server["args"], [str(self.install / "feedback_gate_mcp.py")])
        self.assertEqual(server["env"]["PYTHONIOENCODING"], "utf-8")

    def test_native_config_paths_and_existing_servers(self):
        subprocess.run([sys.executable, str(ROOT / "scripts" / "configure_mcp.py"),
                        str(self.config), str(self.install)], check=True)
        self.assert_config()

    def test_malformed_config_is_not_overwritten(self):
        original = "{invalid json"
        self.config.write_text(original, encoding="utf-8")
        result = subprocess.run([sys.executable, str(ROOT / "scripts" / "configure_mcp.py"),
                                 str(self.config), str(self.install)], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.config.read_text(encoding="utf-8"), original)

    @unittest.skipUnless(os.name == "nt", "Windows Git Bash installer")
    def test_git_bash_config_block_handles_spaces_and_apostrophes(self):
        installer = (ROOT / "install.sh").read_text(encoding="utf-8")
        start = installer.index('CONFIG_SCRIPT=')
        end = installer.index('\nok "MCP 配置已更新', start)
        env = dict(os.environ, OS="windows", SCRIPT_DIR=ROOT.as_posix(),
                   CURSOR_MCP_FILE=str(self.config), INSTALL_DIR=str(self.install),
                   VENV_PY=Path(sys.executable).as_posix())
        subprocess.run([self.git_bash(), "-c", installer[start:end]], env=env, check=True)
        self.assert_config()

    @unittest.skipUnless(os.name == "nt", "Windows Git Bash installer")
    def test_python_launcher_path_with_spaces_and_crlf(self):
        runtime = self.profile / "Python Runtime"
        subprocess.run([sys.executable, "-m", "venv", "--without-pip", str(runtime)], check=True)
        python = runtime / "Scripts" / "python.exe"
        installer = (ROOT / "install.sh").read_text(encoding="utf-8")
        start = installer.index("find_suitable_python() {")
        end = installer.index("\n}\n", start) + 3
        script = ('set -e\nPATH=/usr/bin\npy() { "$TEST_PYTHON" -c \'import sys; print(sys.executable)\'; }\n'
                  + installer[start:end]
                  + '\nfind_suitable_python\n"$PYTHON_CMD" -c \'import json, sys; print(json.dumps(sys.executable))\'\n')
        result = subprocess.run([self.git_bash(), "-c", script],
                                env=dict(os.environ, OS="windows", TEST_PYTHON=str(python)),
                                capture_output=True, check=True)
        self.assertEqual(Path(json.loads(result.stdout)), python)


if __name__ == "__main__":
    unittest.main()
