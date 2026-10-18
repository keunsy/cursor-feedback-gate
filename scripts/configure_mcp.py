"""Write platform-native MCP paths without interpolating shell paths into Python."""

import json
import os
from pathlib import Path
import sys


def configure_mcp(config_file: Path, install_dir: Path) -> None:
    config = {}
    if config_file.exists():
        config = json.loads(config_file.read_text(encoding="utf-8"))

    venv_python = install_dir / "venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    config.setdefault("mcpServers", {})["feedback-gate"] = {
        "command": str(venv_python),
        "args": [str(install_dir / "feedback_gate_mcp.py")],
        "env": {
            "PYTHONPATH": str(install_dir),
            "PYTHONUNBUFFERED": "1",
            "PYTHONUTF8": "1",
            "PYTHONIOENCODING": "utf-8",
            "FEEDBACK_GATE_MODE": "cursor_integration",
            "FEEDBACK_GATE_IDE_WAIT_SECONDS": "90",
            "FEEDBACK_GATE_PROGRESS_KEEPALIVE": "1",
        },
    }
    config_file.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: configure_mcp.py <mcp.json> <install-directory>")
    configure_mcp(Path(sys.argv[1]), Path(sys.argv[2]))
