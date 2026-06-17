#!/usr/bin/env python3
"""
Scenario tests for feedback_gate_mcp.py core logic.
Covers: trigger lifecycle, session matching, eviction, heartbeat, stale cleanup,
response handling, cooldown, and multi-session concurrency.

Run: python test/test_mcp_scenarios.py
     (or: cd /path/to/project && python -m test.test_mcp_scenarios)
"""

import time
import json
import os
import sys
import tempfile
from pathlib import Path

# ── Test harness: simulates FeedbackGateChat state without MCP/asyncio ──

class MockFeedbackGateState:
    """Mirrors the stateful logic of FeedbackGateChat without async/IO."""

    def __init__(self):
        self._active_triggers = {}
        self._last_responded_by_session = {}
        self._session_to_eh_pid = {}
        self._session_to_workspace = {}
        self._pending_trigger_id = None
        self._pending_trigger_created_at = None
        self._pending_trigger_message = None
        self._heartbeat_count = 0
        self._last_trigger_responded_at = 0
        self._STALE_TRIGGER_SECONDS_IDE = 86400  # 24h (matches actual code)
        self._STALE_TRIGGER_SECONDS_CLI = 120    # 2min (matches actual code)
        self._IDE_WAIT_SECONDS = 5 * 60
        self._IDE_MAX_TOTAL_SECONDS = 8 * 3600
        self._fake_now = time.time()
        self._trigger_counter = 0

    def _now(self):
        return self._fake_now

    def advance(self, seconds):
        self._fake_now += seconds

    def _clear_trigger_state(self, responded=False):
        if responded:
            self._last_trigger_responded_at = self._now()
        self._pending_trigger_id = None
        self._pending_trigger_created_at = None
        self._pending_trigger_message = None
        self._heartbeat_count = 0

    def create_trigger(self, session_id="", message="test"):
        """Simulates new trigger creation (success path after extension consumes file)."""
        self._trigger_counter += 1
        trigger_id = f"fg_test_{self._trigger_counter}"
        now = self._now()

        # Evict old same-session triggers
        if session_id:
            old = [tid for tid, info in self._active_triggers.items()
                   if info.get("session_id") == session_id]
            for tid in old:
                del self._active_triggers[tid]
                if self._pending_trigger_id == tid:
                    self._clear_trigger_state(responded=False)

        self._pending_trigger_id = trigger_id
        self._pending_trigger_created_at = now
        self._pending_trigger_message = message
        self._heartbeat_count = 0
        self._active_triggers[trigger_id] = {
            "session_id": session_id,
            "message": message,
            "created_at": now,
            "heartbeat_count": 0,
        }
        return trigger_id

    def match_trigger_by_session(self, session_id):
        """Simulates session-based trigger matching on re-entry."""
        if not session_id:
            if len(self._active_triggers) == 1:
                tid = next(iter(self._active_triggers))
                return tid, self._active_triggers[tid]
            return None, None
        for tid, info in self._active_triggers.items():
            if info.get("session_id") == session_id:
                return tid, info
        return None, None

    def respond_to_trigger(self, trigger_id, session_id="", eh_pid=None, workspace=None):
        """Simulates user responding to a trigger."""
        if trigger_id in self._active_triggers:
            info = self._active_triggers[trigger_id]
            sid = info.get("session_id", "") or session_id
            del self._active_triggers[trigger_id]
            if self._pending_trigger_id == trigger_id:
                self._clear_trigger_state(responded=True)
            else:
                self._last_trigger_responded_at = self._now()
            self._last_responded_by_session[sid or "__global__"] = self._now()
            if sid and eh_pid:
                self._session_to_eh_pid[sid] = eh_pid
            if sid and workspace:
                self._session_to_workspace[sid] = workspace
            return True
        return False

    def heartbeat(self, trigger_id):
        """Simulates heartbeat after wait timeout (no user input)."""
        if trigger_id not in self._active_triggers:
            return "EVICTED"
        info = self._active_triggers[trigger_id]
        info["heartbeat_count"] = info.get("heartbeat_count", 0) + 1
        self._heartbeat_count = info["heartbeat_count"]
        elapsed = info["heartbeat_count"] * self._IDE_WAIT_SECONDS
        if elapsed >= self._IDE_MAX_TOTAL_SECONDS:
            del self._active_triggers[trigger_id]
            if self._pending_trigger_id == trigger_id:
                self._clear_trigger_state(responded=False)
            return "TIMEOUT"
        return "WAITING"

    def clean_stale_triggers(self, is_remote=False, exclude_tid=None):
        """Simulates stale trigger cleanup."""
        now = self._now()
        limit = self._STALE_TRIGGER_SECONDS_CLI if is_remote else self._STALE_TRIGGER_SECONDS_IDE
        stale = [tid for tid, info in self._active_triggers.items()
                 if tid != exclude_tid and (now - info.get("created_at", 0)) > limit]
        for tid in stale:
            del self._active_triggers[tid]
            if self._pending_trigger_id == tid:
                self._clear_trigger_state(responded=False)
        return stale

    def check_cooldown(self, session_id=""):
        """Returns True if cooldown is active (should SKIP)."""
        key = session_id or "__global__"
        last = self._last_responded_by_session.get(key, 0)
        if not last and not session_id:
            last = self._last_responded_by_session.get("__global__", 0)
        if last and (self._now() - last) < 2:
            return True
        return False

    def evict_cap(self, max_triggers=20, protect_tid=None):
        """Simulates eviction when at capacity."""
        if len(self._active_triggers) >= max_triggers:
            candidates = [t for t in self._active_triggers if t != protect_tid]
            if candidates:
                oldest = min(candidates, key=lambda t: self._active_triggers[t].get("created_at", 0))
                del self._active_triggers[oldest]
                if self._pending_trigger_id == oldest:
                    self._clear_trigger_state(responded=False)
                return oldest
        return None


# ── Test runner ──────────────────────────────────────

results = []

def scenario(name):
    def decorator(fn):
        state = MockFeedbackGateState()
        try:
            fn(state)
            results.append((name, True, ""))
        except AssertionError as e:
            results.append((name, False, str(e)))
            print(f"  ❌ {name}: {e}")
        except Exception as e:
            results.append((name, False, f"EXCEPTION: {e}"))
            print(f"  ❌ {name}: EXCEPTION: {e}")
        return fn
    return decorator


# ═══════════════════════════════════════════════════
# Section 1: Trigger Lifecycle
# ═══════════════════════════════════════════════════

@scenario("TL-1: Create trigger registers in _active_triggers")
def _(s):
    tid = s.create_trigger(session_id="sid-1", message="hello")
    assert tid in s._active_triggers
    assert s._active_triggers[tid]["session_id"] == "sid-1"
    assert s._pending_trigger_id == tid

@scenario("TL-2: Respond removes trigger from active set")
def _(s):
    tid = s.create_trigger(session_id="sid-1")
    s.respond_to_trigger(tid, session_id="sid-1")
    assert tid not in s._active_triggers
    assert s._pending_trigger_id is None

@scenario("TL-3: Respond sets last_responded_by_session")
def _(s):
    tid = s.create_trigger(session_id="sid-1")
    s.respond_to_trigger(tid, session_id="sid-1")
    assert "sid-1" in s._last_responded_by_session

@scenario("TL-4: Respond to non-existent trigger returns False")
def _(s):
    result = s.respond_to_trigger("non-existent")
    assert result is False

@scenario("TL-5: Multiple triggers coexist")
def _(s):
    t1 = s.create_trigger(session_id="sid-1")
    t2 = s.create_trigger(session_id="sid-2")
    assert len(s._active_triggers) == 2
    assert t1 in s._active_triggers
    assert t2 in s._active_triggers


# ═══════════════════════════════════════════════════
# Section 2: Session Matching
# ═══════════════════════════════════════════════════

@scenario("SM-1: Match by session_id finds correct trigger")
def _(s):
    t1 = s.create_trigger(session_id="sid-1")
    s.create_trigger(session_id="sid-2")
    tid, info = s.match_trigger_by_session("sid-1")
    assert tid == t1

@scenario("SM-2: No match returns None")
def _(s):
    s.create_trigger(session_id="sid-1")
    tid, info = s.match_trigger_by_session("sid-99")
    assert tid is None

@scenario("SM-3: No session_id with single trigger → auto-match")
def _(s):
    t1 = s.create_trigger(session_id="sid-1")
    tid, info = s.match_trigger_by_session("")
    assert tid == t1

@scenario("SM-4: No session_id with multiple triggers → no match (ambiguous)")
def _(s):
    s.create_trigger(session_id="sid-1")
    s.create_trigger(session_id="sid-2")
    tid, info = s.match_trigger_by_session("")
    assert tid is None


# ═══════════════════════════════════════════════════
# Section 3: Eviction
# ═══════════════════════════════════════════════════

@scenario("EV-1: Same session_id evicts old trigger on new creation")
def _(s):
    t1 = s.create_trigger(session_id="sid-1", message="old")
    t2 = s.create_trigger(session_id="sid-1", message="new")
    assert t1 not in s._active_triggers
    assert t2 in s._active_triggers
    assert len(s._active_triggers) == 1

@scenario("EV-2: Different session_id does NOT evict")
def _(s):
    t1 = s.create_trigger(session_id="sid-1")
    t2 = s.create_trigger(session_id="sid-2")
    assert t1 in s._active_triggers
    assert t2 in s._active_triggers

@scenario("EV-3: Cap eviction removes oldest")
def _(s):
    triggers = []
    for i in range(20):
        tid = s.create_trigger(session_id=f"sid-{i}")
        triggers.append(tid)
        s.advance(1)
    # Now at capacity (20). Next should evict oldest.
    evicted = s.evict_cap(max_triggers=20, protect_tid=triggers[-1])
    assert evicted == triggers[0]

@scenario("EV-4: Cap eviction protects specified trigger")
def _(s):
    t1 = s.create_trigger(session_id="sid-1")
    s.advance(1)
    t2 = s.create_trigger(session_id="sid-2")
    # Manually fill to cap
    for i in range(18):
        s.create_trigger(session_id=f"fill-{i}")
        s.advance(0.1)
    evicted = s.evict_cap(max_triggers=20, protect_tid=t1)
    assert evicted != t1
    assert t1 in s._active_triggers


# ═══════════════════════════════════════════════════
# Section 4: Stale Cleanup
# ═══════════════════════════════════════════════════

@scenario("SC-1: Trigger within TTL not cleaned")
def _(s):
    t1 = s.create_trigger(session_id="sid-1")
    s.advance(60)  # 1 min
    cleaned = s.clean_stale_triggers(is_remote=False)
    assert len(cleaned) == 0
    assert t1 in s._active_triggers

@scenario("SC-2: Trigger beyond IDE TTL (24h) cleaned")
def _(s):
    t1 = s.create_trigger(session_id="sid-1")
    s.advance(86401)  # 24h + 1s
    cleaned = s.clean_stale_triggers(is_remote=False)
    assert t1 in cleaned
    assert t1 not in s._active_triggers

@scenario("SC-3: CLI mode uses shorter TTL (2min)")
def _(s):
    t1 = s.create_trigger(session_id="sid-1")
    s.advance(121)  # 2min + 1s → stale for CLI
    cleaned = s.clean_stale_triggers(is_remote=True)
    assert t1 in cleaned

@scenario("SC-3b: CLI trigger within 2min not cleaned")
def _(s):
    t1 = s.create_trigger(session_id="sid-1")
    s.advance(60)  # 1min — fresh for CLI
    cleaned = s.clean_stale_triggers(is_remote=True)
    assert len(cleaned) == 0

@scenario("SC-4: Excluded trigger not cleaned even if stale")
def _(s):
    t1 = s.create_trigger(session_id="sid-1")
    s.advance(90000)  # beyond 24h IDE limit
    cleaned = s.clean_stale_triggers(is_remote=False, exclude_tid=t1)
    assert len(cleaned) == 0


# ═══════════════════════════════════════════════════
# Section 5: Heartbeat
# ═══════════════════════════════════════════════════

@scenario("HB-1: First heartbeat returns WAITING")
def _(s):
    tid = s.create_trigger(session_id="sid-1")
    result = s.heartbeat(tid)
    assert result == "WAITING"
    assert s._active_triggers[tid]["heartbeat_count"] == 1

@scenario("HB-2: Heartbeat on evicted trigger returns EVICTED")
def _(s):
    tid = s.create_trigger(session_id="sid-1")
    del s._active_triggers[tid]
    result = s.heartbeat(tid)
    assert result == "EVICTED"

@scenario("HB-3: Heartbeat timeout after max_total (8h = 5760 * 5s loops)")
def _(s):
    s._IDE_WAIT_SECONDS = 300  # 5 min
    s._IDE_MAX_TOTAL_SECONDS = 600  # 10 min for quick test
    tid = s.create_trigger(session_id="sid-1")
    r1 = s.heartbeat(tid)  # 5min elapsed
    assert r1 == "WAITING"
    r2 = s.heartbeat(tid)  # 10min elapsed → timeout
    assert r2 == "TIMEOUT"
    assert tid not in s._active_triggers

@scenario("HB-4: Heartbeat increments count correctly")
def _(s):
    tid = s.create_trigger(session_id="sid-1")
    for i in range(5):
        s.heartbeat(tid)
    assert s._active_triggers[tid]["heartbeat_count"] == 5


# ═══════════════════════════════════════════════════
# Section 6: Cooldown
# ═══════════════════════════════════════════════════

@scenario("CD-1: Cooldown active immediately after response")
def _(s):
    tid = s.create_trigger(session_id="sid-1")
    s.respond_to_trigger(tid, session_id="sid-1")
    assert s.check_cooldown("sid-1") is True

@scenario("CD-2: Cooldown expires after 2 seconds")
def _(s):
    tid = s.create_trigger(session_id="sid-1")
    s.respond_to_trigger(tid, session_id="sid-1")
    s.advance(2.1)
    assert s.check_cooldown("sid-1") is False

@scenario("CD-3: Cooldown is per-session (sid-2 unaffected by sid-1)")
def _(s):
    t1 = s.create_trigger(session_id="sid-1")
    s.respond_to_trigger(t1, session_id="sid-1")
    assert s.check_cooldown("sid-2") is False

@scenario("CD-4: No session_id uses global cooldown")
def _(s):
    tid = s.create_trigger(session_id="")
    s.respond_to_trigger(tid, session_id="")
    assert s.check_cooldown("") is True


# ═══════════════════════════════════════════════════
# Section 7: Multi-Session Concurrency
# ═══════════════════════════════════════════════════

@scenario("MC-1: Two sessions can have active triggers simultaneously")
def _(s):
    t1 = s.create_trigger(session_id="sid-1", message="msg1")
    t2 = s.create_trigger(session_id="sid-2", message="msg2")
    assert len(s._active_triggers) == 2
    tid1, _ = s.match_trigger_by_session("sid-1")
    tid2, _ = s.match_trigger_by_session("sid-2")
    assert tid1 == t1
    assert tid2 == t2

@scenario("MC-2: Responding to one session doesn't affect another")
def _(s):
    t1 = s.create_trigger(session_id="sid-1")
    t2 = s.create_trigger(session_id="sid-2")
    s.respond_to_trigger(t1, session_id="sid-1")
    assert t2 in s._active_triggers
    assert t1 not in s._active_triggers

@scenario("MC-3: Re-entering same session replaces old trigger")
def _(s):
    t1 = s.create_trigger(session_id="sid-1", message="first")
    t2 = s.create_trigger(session_id="sid-1", message="second")
    assert len(s._active_triggers) == 1
    assert s._active_triggers[t2]["message"] == "second"

@scenario("MC-4: Workspace stored per session_id on trigger creation")
def _(s):
    # Simulate workspace assignment
    s._session_to_workspace["sid-1"] = "/project/a"
    s.create_trigger(session_id="sid-1")
    s.respond_to_trigger(s._pending_trigger_id, session_id="sid-1", workspace="/project/a")
    assert s._session_to_workspace["sid-1"] == "/project/a"

@scenario("MC-5: eh_pid stored per session on response")
def _(s):
    tid = s.create_trigger(session_id="sid-1")
    s.respond_to_trigger(tid, session_id="sid-1", eh_pid=12345)
    assert s._session_to_eh_pid["sid-1"] == 12345


# ═══════════════════════════════════════════════════
# Section 8: Trigger File Format (write/read validation)
# ═══════════════════════════════════════════════════

@scenario("TF-1: Trigger file JSON structure is valid")
def _(s):
    trigger_data = {
        "tool": "feedback_gate_chat",
        "message": "Test message",
        "title": "Feedback Gate",
        "trigger_id": "fg_12345_abc",
        "session_id": "uuid-test",
        "workspace_path": "/home/user/project",
        "timestamp": "2024-01-01T00:00:00",
        "immediate_activation": True,
    }
    serialized = json.dumps(trigger_data)
    parsed = json.loads(serialized)
    assert parsed["trigger_id"] == "fg_12345_abc"
    assert parsed["session_id"] == "uuid-test"
    assert parsed["workspace_path"] == "/home/user/project"
    assert parsed["immediate_activation"] is True

@scenario("TF-2: Response file JSON structure is valid")
def _(s):
    response_data = {
        "user_input": "LGTM",
        "trigger_id": "fg_12345_abc",
        "timestamp": "2024-01-01T00:01:00",
        "extension_host_pid": 54321,
        "workspace_path": "/home/user/project",
    }
    serialized = json.dumps(response_data)
    parsed = json.loads(serialized)
    assert parsed["user_input"] == "LGTM"
    assert parsed["extension_host_pid"] == 54321

@scenario("TF-3: ACK file JSON structure is valid")
def _(s):
    ack_data = {
        "trigger_id": "fg_12345_abc",
        "ack": True,
        "extension_host_pid": 54321,
        "timestamp": "2024-01-01T00:00:01",
    }
    serialized = json.dumps(ack_data)
    parsed = json.loads(serialized)
    assert parsed["ack"] is True


# ═══════════════════════════════════════════════════
# Section 9: End-to-End Scenarios
# ═══════════════════════════════════════════════════

@scenario("E2E-MCP-1: Full lifecycle — create, heartbeat, respond")
def _(s):
    tid = s.create_trigger(session_id="sid-1", message="Please confirm")
    assert s.heartbeat(tid) == "WAITING"
    assert s.heartbeat(tid) == "WAITING"
    result = s.respond_to_trigger(tid, session_id="sid-1")
    assert result is True
    assert tid not in s._active_triggers
    assert s.check_cooldown("sid-1") is True

@scenario("E2E-MCP-2: Trigger timeout → clean state")
def _(s):
    s._IDE_WAIT_SECONDS = 100
    s._IDE_MAX_TOTAL_SECONDS = 200
    tid = s.create_trigger(session_id="sid-1")
    s.heartbeat(tid)  # 100s
    r = s.heartbeat(tid)  # 200s → timeout
    assert r == "TIMEOUT"
    assert s._pending_trigger_id is None

@scenario("E2E-MCP-3: Rapid re-call same session → old evicted")
def _(s):
    t1 = s.create_trigger(session_id="sid-1", message="first")
    s.advance(0.5)
    t2 = s.create_trigger(session_id="sid-1", message="retry")
    assert t1 not in s._active_triggers
    assert t2 in s._active_triggers
    assert s._pending_trigger_id == t2

@scenario("E2E-MCP-4: Multi-session concurrent — respond independently")
def _(s):
    t1 = s.create_trigger(session_id="sid-1", message="Q1")
    t2 = s.create_trigger(session_id="sid-2", message="Q2")
    s.respond_to_trigger(t2, session_id="sid-2")
    assert t1 in s._active_triggers
    s.respond_to_trigger(t1, session_id="sid-1")
    assert len(s._active_triggers) == 0

@scenario("E2E-MCP-5: Stale cleanup during new trigger creation")
def _(s):
    t_old = s.create_trigger(session_id="sid-old")
    s.advance(90000)  # Over IDE 24h stale limit
    t_new = s.create_trigger(session_id="sid-new")
    cleaned = s.clean_stale_triggers(is_remote=False, exclude_tid=t_new)
    assert t_old in cleaned
    assert t_new in s._active_triggers


# ═══════════════════════════════════════════════════
# Results
# ═══════════════════════════════════════════════════

passed = sum(1 for _, ok, _ in results if ok)
failed = sum(1 for _, ok, _ in results if not ok)
print(f"\n{'─' * 55}")
print(f"MCP Server Scenarios: {passed} passed, {failed} failed, {len(results)} total")
if failed > 0:
    print("\nFailed:")
    for name, ok, err in results:
        if not ok:
            print(f"  ❌ {name}: {err}")
print()
sys.exit(1 if failed > 0 else 0)
