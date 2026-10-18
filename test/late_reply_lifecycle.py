"""Run: python -m unittest discover -s test -p late_reply_lifecycle.py -v"""

import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

from late_reply_harness import load_server, ROOT
from feedback_gate_lifecycle import WaitRegistry, handle_hook, install_hooks, uninstall_hooks

ARGS = {'session_id': 'repro-session', 'message': 'Wait for the user'}


class PendingReplyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='fg-pending-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.server, self.events, self.updates = load_server(self.root)
        self.env = mock.patch.dict(os.environ, {'FEEDBACK_GATE_ROUTING_FILE': '',
            'FEEDBACK_GATE_MODEL': '', 'FEEDBACK_GATE_PROGRESS_KEEPALIVE': '1'})
        self.env.start()
        self.addCleanup(self.env.stop)

    def reply(self, text='late user reply'):
        path = self.root / 'feedback_gate_response_repro-trigger.json'
        path.write_text(json.dumps({'user_input': text}), encoding='utf-8')
        return path

    async def test_fresh_popup_ack_and_late_reply_keep_one_call_pending(self):
        self.server._active_triggers = {}
        self.server._pending_trigger_id = None
        async def gate_side():
            while not list(self.root.glob('feedback_gate_trigger_fg_*.json')):
                await asyncio.sleep(0.01)
            trigger = next(self.root.glob('feedback_gate_trigger_fg_*.json'))
            payload = json.loads(trigger.read_text(encoding='utf-8'))
            trigger_id = payload['data']['trigger_id']
            trigger.unlink()
            (self.root / f'feedback_gate_ack_{trigger_id}.json').write_text(
                json.dumps({'acknowledged': True, 'extension_host_pid': os.getpid()}), encoding='utf-8')
            await asyncio.sleep(1)
            (self.root / f'feedback_gate_response_{trigger_id}.json').write_text(
                json.dumps({'user_input': 'fresh late reply'}), encoding='utf-8')
        gate = asyncio.create_task(gate_side())
        call = asyncio.create_task(self.server._handle_feedback_gate_chat(dict(ARGS, session_id='fresh-session')))
        try:
            await asyncio.sleep(0.8)
            self.assertFalse(call.done())
            result = await asyncio.wait_for(call, timeout=2)
            self.assertTrue(result[0].text.startswith('User Response: fresh late reply'))
        finally:
            gate.cancel()
            call.cancel()
            await asyncio.gather(gate, call, return_exceptions=True)

    async def test_late_reply_returns_to_original_pending_call(self):
        call = asyncio.create_task(self.server._handle_feedback_gate_chat(ARGS))
        try:
            await asyncio.sleep(0.45)  # More than four old heartbeat windows.
            self.assertFalse(call.done(), 'No final tool result before the user replies')
            response = self.reply()
            result = await asyncio.wait_for(call, timeout=1)
            self.assertTrue(result[0].text.startswith('User Response: late user reply'))
            self.assertFalse(response.exists())
            self.assertGreaterEqual(len(self.updates), 3)
            self.assertTrue(all(item['progress_token'] == 0 for item in self.updates))
            self.assertEqual([item['progress'] for item in self.updates],
                             sorted(item['progress'] for item in self.updates))
            self.assertEqual(self.server._wait_registry.read('wait', 'repro-session')['state'], 'answered')
        finally:
            call.cancel()
            await asyncio.gather(call, return_exceptions=True)

    async def test_legacy_heartbeat_stop_hook_renews_exact_conversation(self):
        self.server.server.request_context.meta = None
        registry = self.server._wait_registry
        registry.bind_conversation('conversation-a', ARGS)
        result = await self.server._handle_feedback_gate_chat(ARGS)
        self.assertTrue(result[0].text.startswith('[WAITING]'))
        self.assertFalse(registry.read('wait', 'repro-session')['call_active'])
        self.reply()
        followup = handle_hook({'hook_event_name': 'stop', 'status': 'completed',
                               'conversation_id': 'conversation-a'}, registry)
        renewed_args = json.loads(followup['followup_message'].split('Arguments: ', 1)[1])
        self.assertEqual(renewed_args, ARGS)
        result = await self.server._handle_feedback_gate_chat(renewed_args)
        self.assertTrue(result[0].text.startswith('User Response: late user reply'))
        self.assertEqual(registry.on_stop({'status': 'completed', 'conversation_id': 'conversation-a'}), {})

    async def test_cancelled_request_preserves_reply_for_completed_stop_recovery(self):
        registry = self.server._wait_registry
        registry.bind_conversation('conversation-a', ARGS)
        call = asyncio.create_task(self.server._handle_feedback_gate_chat(ARGS))
        await asyncio.sleep(0.1)
        call.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await call
        count = len(self.updates)
        await asyncio.sleep(0.1)
        self.assertEqual(len(self.updates), count, 'Cancellation leaves no keepalive task behind')
        self.reply()
        self.assertIn('followup_message', registry.on_stop({'status': 'completed', 'conversation_id': 'conversation-a'}))
        result = await self.server._handle_feedback_gate_chat(ARGS)
        self.assertIn('late user reply', result[0].text)

    async def test_total_expiry_uses_wall_clock(self):
        self.server._active_triggers['repro-trigger']['created_at'] -= 3
        self.server._IDE_PERSISTENT_WAIT_CAP_SECONDS = 0.1
        type(self.server)._IDE_PERSISTENT_WAIT_CAP_SECONDS = 0.1
        (self.root / 'heartbeat.json').write_text(json.dumps({'wait_seconds': 1, 'max_total_seconds': 1}), encoding='utf-8')
        result = await self.server._handle_feedback_gate_chat(ARGS)
        self.assertTrue(result[0].text.startswith('TIMEOUT:'))

    async def test_failed_progress_falls_back_to_short_renewal(self):
        async def broken(**kwargs):
            raise OSError('test transport cannot send progress')
        self.server.server.request_context.session.send_progress_notification = broken
        result = await self.server._handle_feedback_gate_chat(ARGS)
        self.assertTrue(result[0].text.startswith('[WAITING]'))
        self.assertEqual(self.server._get_wait_policy(False)[0], 0.1)

    async def test_preserved_reply_survives_server_restart_and_keeps_session(self):
        original = self.reply('reply received before the server restarted')
        registry = self.server._wait_registry
        registry.preserve_response('repro-session', 'repro-trigger', original)
        self.assertFalse(original.exists())
        self.assertEqual(registry.read('reply', 'unrelated-session'), {})
        restarted, events, _ = load_server(self.root)
        restarted._active_triggers = {}
        restarted._pending_trigger_id = None
        result = await asyncio.wait_for(restarted._handle_feedback_gate_chat(ARGS), timeout=0.5)
        self.assertIn('reply received before the server restarted', result[0].text)
        self.assertIn('PREVIOUS request', result[0].text)
        self.assertNotIn('NEW_TRIGGER', events)
        self.assertEqual(registry.read('reply', 'repro-session'), {})
        self.assertEqual(registry.read('wait', 'repro-session')['state'], 'answered')


class StopHookTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='fg-hook-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.registry = WaitRegistry(self.root)
        self.registry.bind_conversation('conversation-a', ARGS)
        self.registry.begin_wait('repro-session', 'call-a', time.time(), 86400)
        self.registry.finish_wait('repro-session', 'call-a', 'waiting')
        self.completed = {'hook_event_name': 'stop', 'status': 'completed', 'conversation_id': 'conversation-a'}

    def test_completed_stop_resumes_once_per_actual_call(self):
        self.assertIn('followup_message', handle_hook(self.completed, self.registry))
        self.assertEqual(handle_hook(self.completed, self.registry), {})
        self.registry.begin_wait('repro-session', 'call-b', time.time(), 86400)
        self.registry.finish_wait('repro-session', 'call-b', 'waiting')
        self.assertIn('followup_message', handle_hook(self.completed, self.registry))

    def test_concurrent_stop_callbacks_claim_one_continuation(self):
        barrier = threading.Barrier(3)
        read = self.registry.read
        def simultaneous_read(kind, key):
            value = read(kind, key)
            if kind == 'conversation':
                barrier.wait(timeout=3)
            return value
        with mock.patch.object(self.registry, 'read', side_effect=simultaneous_read):
            with ThreadPoolExecutor(max_workers=3) as pool:
                results = list(pool.map(lambda _: handle_hook(self.completed, self.registry), range(3)))
        self.assertEqual(sum('followup_message' in result for result in results), 1)

    def test_user_stop_marker_survives_racing_wait_state_update(self):
        handle_hook(dict(self.completed, status='aborted'), self.registry)
        self.registry.begin_wait('repro-session', 'racing-call', time.time(), 86400)
        self.registry.finish_wait('repro-session', 'racing-call', 'waiting')
        self.assertEqual(handle_hook(self.completed, self.registry), {})

    def test_user_stop_never_auto_resumes(self):
        aborted = dict(self.completed, status='aborted')
        self.assertEqual(handle_hook(aborted, self.registry), {})
        self.assertEqual(handle_hook(self.completed, self.registry), {})
        self.assertEqual(self.registry.read('wait', 'repro-session')['state'], 'cancelled_by_user')

    def test_error_stop_does_not_auto_resume(self):
        self.assertEqual(handle_hook(dict(self.completed, status='error'), self.registry), {})

    def test_answered_or_expired_session_is_not_resumed(self):
        self.registry.finish_wait('repro-session', 'call-a', 'answered')
        self.assertEqual(handle_hook(self.completed, self.registry), {})
        self.registry.begin_wait('repro-session', 'call-b', time.time() - 10, 1)
        self.registry.finish_wait('repro-session', 'call-b', 'waiting')
        self.assertEqual(handle_hook(self.completed, self.registry), {})

    def test_unrelated_conversation_and_tools_are_ignored(self):
        self.assertEqual(handle_hook(dict(self.completed, conversation_id='other'), self.registry), {})
        payload = {'hook_event_name': 'beforeMCPExecution', 'tool_name': 'feedback_gate_chat',
                   'mcp_server_name': 'another-server', 'conversation_id': 'other', 'tool_input': ARGS}
        self.assertEqual(handle_hook(payload, self.registry), {'permission': 'allow'})
        self.assertEqual(self.registry.read('conversation', 'other'), {})

    def test_before_mcp_binds_only_exact_arguments(self):
        payload = {'hook_event_name': 'beforeMCPExecution', 'tool_name': 'feedback_gate_chat',
                   'mcp_server_name': 'feedback-gate', 'conversation_id': 'conversation-b',
                   'tool_input': json.dumps(dict(ARGS, session_id='session-b'))}
        self.assertEqual(handle_hook(payload, self.registry), {'permission': 'allow'})
        self.assertEqual(self.registry.read('conversation', 'conversation-b')['session_id'], 'session-b')

    def test_old_call_cannot_finish_new_wait(self):
        self.registry.begin_wait('repro-session', 'call-new', time.time(), 86400)
        self.registry.finish_wait('repro-session', 'call-a', 'answered')
        self.assertEqual(self.registry.read('wait', 'repro-session')['call_id'], 'call-new')
        self.assertTrue(self.registry.read('wait', 'repro-session')['call_active'])

    def test_hook_cli_reads_real_cursor_payload_and_returns_ascii_json(self):
        result = subprocess.run([sys.executable, str(ROOT / 'feedback_gate_lifecycle.py')],
            input=json.dumps(self.completed).encode('utf-8'), capture_output=True, check=True,
            env=dict(os.environ, FEEDBACK_GATE_STATE_DIR=str(self.root)))
        self.assertIn('followup_message', json.loads(result.stdout))

    def test_hook_install_preserves_existing_configuration_and_is_idempotent(self):
        path = self.root / 'hooks.json'
        old = {'version': 1, 'hooks': {'preToolUse': [{'command': 'rtk hook cursor', 'matcher': 'Shell'}],
                                    'stop': [{'command': 'existing-hook'}]}}
        path.write_text(json.dumps(old), encoding='utf-8')
        install_hooks(path)
        install_hooks(path)
        config = json.loads(path.read_text(encoding='utf-8'))
        self.assertEqual(config['hooks']['preToolUse'], old['hooks']['preToolUse'])
        self.assertEqual(config['hooks']['stop'][0], old['hooks']['stop'][0])
        self.assertEqual(len(config['hooks']['stop']), 2)
        self.assertEqual(len(config['hooks']['beforeMCPExecution']), 1)
        self.assertIsNone(config['hooks']['stop'][1]['loop_limit'])

    def test_configured_hook_command_works_with_windows_shell_stdin(self):
        path = self.root / 'hooks.json'
        install_hooks(path)
        config = json.loads(path.read_text(encoding='utf-8'))
        command = config['hooks']['stop'][0]['command']
        result = subprocess.run(command, shell=True, input=json.dumps(self.completed).encode('utf-8'),
            capture_output=True, check=True, env=dict(os.environ, FEEDBACK_GATE_STATE_DIR=str(self.root)))
        self.assertIn('followup_message', json.loads(result.stdout))

    def test_uninstall_removes_only_feedback_gate_hooks(self):
        path = self.root / 'hooks.json'
        old = {'version': 1, 'hooks': {'stop': [{'command': 'keep-other-hook'}]}}
        path.write_text(json.dumps(old), encoding='utf-8')
        install_hooks(path)
        uninstall_hooks(path)
        uninstall_hooks(path)
        self.assertEqual(json.loads(path.read_text(encoding='utf-8')), old)


if __name__ == '__main__':
    unittest.main()
