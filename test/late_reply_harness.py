"""Load the production MCP class with isolated I/O; optionally serve it over stdio."""

import ast
import asyncio
import contextvars
from datetime import datetime
import glob
import json
import logging
import math
import os
from pathlib import Path
import sys
import tempfile
import time
from types import SimpleNamespace
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from feedback_gate_lifecycle import WaitRegistry
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp import types


def load_server(root, progress=True, source=None):
    source = Path(source or os.environ.get('FEEDBACK_GATE_TEST_SOURCE') or ROOT / 'feedback_gate_mcp.py')
    tree = ast.parse(source.read_text(encoding='utf-8'))
    nodes = [ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0)]
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == 'FeedbackGateServer':
            nodes.append(node)
        elif isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == '_FEEDBACK_REPLY_SUFFIX' for t in node.targets):
            nodes.append(node)
    logger = logging.getLogger('late-reply-regression')
    logger.disabled = True
    events, updates = [], []
    namespace = dict(asyncio=asyncio, contextvars=contextvars, datetime=datetime, glob=glob,
                     json=json, logger=logger, math=math, os=os, Path=Path, time=time, uuid=uuid,
                     WaitRegistry=WaitRegistry, get_temp_path=lambda name: str(root / name),
                     _log_event=lambda event, detail='': events.append(event),
                     _current_trigger_var=contextvars.ContextVar('test-trigger', default=None))
    namespace.update({name: getattr(types, name) for name in (
        'TextContent', 'ImageContent', 'Tool', 'CallToolRequest', 'ListToolsRequest',
        'CallToolResult', 'Resource', 'EmbeddedResource')})
    exec(compile(ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[])), str(source), 'exec'), namespace)
    cls = namespace['FeedbackGateServer']
    cls._IDE_CALL_WAIT_CAP_SECONDS = 0.1
    cls._IDE_PERSISTENT_WAIT_CAP_SECONDS = 2
    cls._PROGRESS_INTERVAL_SECONDS = 0.05
    cls._HEARTBEAT_CONFIG_PATH = str(root / 'heartbeat.json')
    (root / 'heartbeat.json').write_text(json.dumps({'wait_seconds': 1, 'max_total_seconds': 86400}), encoding='utf-8')
    server = cls.__new__(cls)
    async def send_progress_notification(**kwargs):
        updates.append(kwargs)
        events.append('PROGRESS')
    server.server = SimpleNamespace(request_context=SimpleNamespace(
        meta=SimpleNamespace(progressToken=0) if progress else None,
        session=SimpleNamespace(send_progress_notification=send_progress_notification)))
    server._wait_registry = WaitRegistry(root / 'registry')
    server._server_pid = os.getpid()
    server._pending_trigger_id = 'repro-trigger'
    server._pending_trigger_created_at = time.time()
    server._pending_trigger_message = 'Wait for the user'
    server._heartbeat_count = 0
    server._last_trigger_responded_at = 0
    server._active_triggers = {'repro-trigger': {'session_id': 'repro-session',
        'message': 'Wait for the user', 'created_at': time.time(), 'heartbeat_count': 0}}
    server._last_responded_by_session = {}
    server._delayed_replies = {}
    server._session_to_eh_pid = {}
    server._session_to_workspace = {}
    server._last_response_eh_pid = None
    server._last_response_workspace = None
    server._last_attachments = []
    server._last_files = []
    server._ancestor_pids_cache = []
    return server, events, updates


async def serve_stdio():
    with tempfile.TemporaryDirectory(prefix='fg-stdio-reply-') as temp:
        root = Path(temp)
        gate, events, _ = load_server(root)
        gate.server = Server('feedback-gate-regression')
        gate.setup_handlers()
        async def late_reply():
            while 'ENTERED' not in events:
                await asyncio.sleep(0.01)
            await asyncio.sleep(0.7)
            (root / 'feedback_gate_response_repro-trigger.json').write_text(
                json.dumps({'user_input': 'late reply delivered over MCP stdio'}), encoding='utf-8')
        reply_task = asyncio.create_task(late_reply())
        try:
            async with stdio_server() as (reader, writer):
                await gate.server.run(reader, writer, gate.server.create_initialization_options())
        finally:
            reply_task.cancel()
            await asyncio.gather(reply_task, return_exceptions=True)


if __name__ == '__main__' and sys.argv[1:] == ['--stdio']:
    asyncio.run(serve_stdio())
