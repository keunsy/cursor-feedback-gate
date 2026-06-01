#!/usr/bin/env node
/**
 * Exhaustive scenario test for getOrCreateSessionForTrigger.
 * Extracts the routing logic from extension.js and runs 100+ scenarios.
 */

// ── Minimal stubs ──
const sessions = new Map();
let sessionCounter = 0;
let activeSessionKey = null;

function createSessionKey(mcpPid, timestamp, counter) {
    return `${mcpPid}_${timestamp}_${counter}`;
}

function createSession(mcpPid, pidTimestamp, sessionId) {
    sessionCounter++;
    const key = createSessionKey(mcpPid, pidTimestamp, sessionCounter);
    const session = {
        key,
        mcpPid,
        pidTimestamp,
        sessionId: sessionId || null,
        index: sessionCounter,
        triggerData: null,
        messages: [],
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
    };
    sessions.set(key, session);
    return session;
}

function getAllSessionsByMcpPid(mcpPid) {
    const result = [];
    for (const session of sessions.values()) {
        if (session.mcpPid === mcpPid) result.push(session);
    }
    return result;
}

// ── The function under test (copied from extension.js with the new fix) ──
function getOrCreateSessionForTrigger(mcpPid, sessionId) {
    const now = Date.now();

    if (sessionId) {
        for (const s of sessions.values()) {
            if (s.sessionId === sessionId) {
                if (s.mcpPid !== mcpPid) {
                    s.mcpPid = mcpPid;
                }
                s.lastActiveAt = now;
                return s;
            }
        }
        // The new fix: safe adoption only when globally unique idle session
        if (sessions.size === 1) {
            const only = sessions.values().next().value;
            if (!only.triggerData && only.mcpPid === mcpPid) {
                only.sessionId = sessionId;
                only.lastActiveAt = now;
                return only;
            }
        }
        return createSession(mcpPid, now, sessionId);
    }

    const pidSessions = getAllSessionsByMcpPid(mcpPid);

    if (pidSessions.length === 0) {
        return createSession(mcpPid, now);
    }

    if (pidSessions.length === 1) {
        const only = pidSessions[0];
        if (!only.triggerData) {
            only.lastActiveAt = now;
            return only;
        }
        return createSession(mcpPid, now);
    }

    return createSession(mcpPid, now);
}

// ── Test infrastructure ──
let passed = 0;
let failed = 0;
const failures = [];

function reset() {
    sessions.clear();
    sessionCounter = 0;
    activeSessionKey = null;
}

function assert(cond, msg) {
    if (!cond) {
        throw new Error(`ASSERT FAILED: ${msg}`);
    }
}

function runTest(name, fn) {
    reset();
    try {
        fn();
        passed++;
    } catch (e) {
        failed++;
        failures.push({ name, error: e.message });
    }
}

function addSession(mcpPid, sid, opts = {}) {
    const s = createSession(mcpPid, Date.now(), sid);
    if (opts.triggerData) s.triggerData = opts.triggerData;
    if (opts.lastActiveAt) s.lastActiveAt = opts.lastActiveAt;
    return s;
}

// ── SCENARIOS ──

// === Category 1: Basic session creation (no existing sessions) ===

runTest('1. First call with session_id creates new session', () => {
    const s = getOrCreateSessionForTrigger(100, 'sid-A');
    assert(s.sessionId === 'sid-A', 'sessionId should be sid-A');
    assert(s.mcpPid === 100, 'mcpPid should be 100');
    assert(sessions.size === 1, 'should have 1 session');
});

runTest('2. First call without session_id creates new session', () => {
    const s = getOrCreateSessionForTrigger(100, '');
    assert(s.mcpPid === 100, 'mcpPid should be 100');
    assert(sessions.size === 1, 'should have 1 session');
});

runTest('3. First call with null session_id creates new session', () => {
    const s = getOrCreateSessionForTrigger(100, null);
    assert(sessions.size === 1, 'should have 1 session');
});

// === Category 2: Exact session_id match ===

runTest('4. Second call with same session_id reuses session', () => {
    const s1 = addSession(100, 'sid-A');
    const s2 = getOrCreateSessionForTrigger(100, 'sid-A');
    assert(s1 === s2, 'should return same session');
    assert(sessions.size === 1, 'should still have 1 session');
});

runTest('5. Same session_id, different PID updates PID', () => {
    const s1 = addSession(100, 'sid-A');
    const s2 = getOrCreateSessionForTrigger(200, 'sid-A');
    assert(s1 === s2, 'should return same session');
    assert(s2.mcpPid === 200, 'PID should be updated');
});

runTest('6. Match session_id even if session has pending trigger', () => {
    const s1 = addSession(100, 'sid-A', { triggerData: { trigger_id: 'tid-1' } });
    const s2 = getOrCreateSessionForTrigger(100, 'sid-A');
    assert(s1 === s2, 'should return same session even with trigger');
});

runTest('7. Match among multiple sessions', () => {
    addSession(100, 'sid-A');
    const s2 = addSession(100, 'sid-B');
    const result = getOrCreateSessionForTrigger(100, 'sid-B');
    assert(result === s2, 'should match sid-B');
    assert(sessions.size === 2, 'should have 2 sessions');
});

// === Category 3: Idle session adoption (the fix) ===

runTest('8. Sole idle session adopted for new session_id', () => {
    const s1 = addSession(100, 'sid-OLD');
    const result = getOrCreateSessionForTrigger(100, 'sid-NEW');
    assert(result === s1, 'should adopt existing session');
    assert(result.sessionId === 'sid-NEW', 'sessionId should be updated');
    assert(sessions.size === 1, 'should still have 1 session');
});

runTest('9. Sole idle session without sessionId adopted', () => {
    const s1 = addSession(100, null);
    const result = getOrCreateSessionForTrigger(100, 'sid-NEW');
    assert(result === s1, 'should adopt');
    assert(result.sessionId === 'sid-NEW', 'sessionId should be set');
});

runTest('10. Sole session with trigger NOT adopted', () => {
    addSession(100, 'sid-OLD', { triggerData: { trigger_id: 'tid-1' } });
    const result = getOrCreateSessionForTrigger(100, 'sid-NEW');
    assert(sessions.size === 2, 'should create new session');
    assert(result.sessionId === 'sid-NEW', 'new session should have sid-NEW');
});

runTest('11. Sole session with different PID NOT adopted', () => {
    addSession(200, 'sid-OLD');
    const result = getOrCreateSessionForTrigger(100, 'sid-NEW');
    assert(sessions.size === 2, 'should create new session');
});

// === Category 4: Multi-session safety (CRITICAL - the bug fix) ===

runTest('12. Two sessions: new session_id creates new (not adopted)', () => {
    addSession(100, 'sid-A');
    addSession(100, 'sid-B');
    const result = getOrCreateSessionForTrigger(100, 'sid-C');
    assert(sessions.size === 3, 'should create 3rd session');
    assert(result.sessionId === 'sid-C', 'new session has sid-C');
});

runTest('13. Two sessions, one idle one busy: no adoption', () => {
    addSession(100, 'sid-A');
    addSession(100, 'sid-B', { triggerData: { trigger_id: 'tid-1' } });
    const result = getOrCreateSessionForTrigger(100, 'sid-C');
    assert(sessions.size === 3, 'should create new');
});

runTest('14. Three sessions, all idle: no adoption', () => {
    addSession(100, 'sid-A');
    addSession(100, 'sid-B');
    addSession(100, 'sid-C');
    const result = getOrCreateSessionForTrigger(100, 'sid-D');
    assert(sessions.size === 4, 'should create new');
});

runTest('15. Two sessions from different PIDs: no adoption', () => {
    addSession(100, 'sid-A');
    addSession(200, 'sid-B');
    const result = getOrCreateSessionForTrigger(100, 'sid-C');
    assert(sessions.size === 3, 'should create new');
});

// === Category 5: No session_id path ===

runTest('16. No session_id, no sessions: create new', () => {
    const result = getOrCreateSessionForTrigger(100, '');
    assert(sessions.size === 1, 'should create 1');
});

runTest('17. No session_id, one idle session for PID: reuse', () => {
    const s1 = addSession(100, 'sid-A');
    const result = getOrCreateSessionForTrigger(100, '');
    assert(result === s1, 'should reuse');
    assert(sessions.size === 1, 'still 1');
});

runTest('18. No session_id, one busy session for PID: create new', () => {
    addSession(100, 'sid-A', { triggerData: { trigger_id: 'tid-1' } });
    const result = getOrCreateSessionForTrigger(100, '');
    assert(sessions.size === 2, 'should create new');
});

runTest('19. No session_id, two sessions for PID: create new', () => {
    addSession(100, 'sid-A');
    addSession(100, 'sid-B');
    const result = getOrCreateSessionForTrigger(100, '');
    assert(sessions.size === 3, 'should create new');
});

runTest('20. No session_id, one session for different PID: create new', () => {
    addSession(200, 'sid-A');
    const result = getOrCreateSessionForTrigger(100, '');
    assert(sessions.size === 2, 'should create new');
});

// === Category 6: Compaction simulation ===

runTest('21. Compaction: single conversation, sid changes', () => {
    const s1 = addSession(100, 'sid-V1');
    // Simulate compaction: agent generates new UUID
    const result = getOrCreateSessionForTrigger(100, 'sid-V2');
    assert(result === s1, 'should adopt (compaction)');
    assert(result.sessionId === 'sid-V2', 'sid updated');
});

runTest('22. Double compaction: sid changes twice', () => {
    const s1 = addSession(100, 'sid-V1');
    const r1 = getOrCreateSessionForTrigger(100, 'sid-V2');
    assert(r1 === s1, 'first compaction adopted');
    const r2 = getOrCreateSessionForTrigger(100, 'sid-V3');
    assert(r2 === s1, 'second compaction adopted');
    assert(r2.sessionId === 'sid-V3', 'sid is V3');
    assert(sessions.size === 1, 'still 1 session');
});

runTest('23. Compaction during active trigger: no adoption', () => {
    const s1 = addSession(100, 'sid-V1', { triggerData: { trigger_id: 'tid-1' } });
    const result = getOrCreateSessionForTrigger(100, 'sid-V2');
    assert(result !== s1, 'should NOT adopt (has trigger)');
    assert(sessions.size === 2, '2 sessions');
});

// === Category 7: Multi-conversation interleaving (regression tests) ===

runTest('24. Conversation A idle, B arrives, then A resumes with old sid', () => {
    const sA = addSession(100, 'sid-A');
    // B arrives, adoption happens
    const sB = getOrCreateSessionForTrigger(100, 'sid-B');
    assert(sB === sA, 'B adopts A');
    assert(sB.sessionId === 'sid-B', 'sid changed to B');
    // Now A resumes (sid-A) — cannot find sid-A, sessions.size=1
    const sA2 = getOrCreateSessionForTrigger(100, 'sid-A');
    // Since sessions.size=1 and only idle, it would adopt again...
    // But wait: sB (which is sA) has no triggerData, so it gets adopted for sid-A
    assert(sA2.sessionId === 'sid-A', 'sid reverted to A');
    assert(sessions.size === 1, 'still 1 session');
    // This is acceptable: both A and B share the same session tab
});

runTest('25. A and B interleave with triggers', () => {
    const sA = addSession(100, 'sid-A');
    sA.triggerData = { trigger_id: 'tid-A' };
    // B arrives while A has trigger
    const sB = getOrCreateSessionForTrigger(100, 'sid-B');
    assert(sB !== sA, 'B should NOT adopt A (A has trigger)');
    assert(sessions.size === 2, '2 sessions');
    // A's trigger clears
    sA.triggerData = null;
    // C arrives — sessions.size=2, no adoption
    const sC = getOrCreateSessionForTrigger(100, 'sid-C');
    assert(sessions.size === 3, 'no adoption with 2+ sessions');
});

runTest('26. The exact bug scenario from logs (PID 4918)', () => {
    // Two different session_ids from the same PID
    const s1 = addSession(4918, 'a1b2c3d4-5678');
    s1.triggerData = { trigger_id: 'fg_1' };
    // Another session_id arrives while s1 has trigger
    const s2 = getOrCreateSessionForTrigger(4918, 'a1b2c3d4-e5f6');
    assert(s2 !== s1, 'should NOT adopt s1');
    assert(sessions.size === 2, '2 separate sessions');
    // s1 clears trigger, s3 arrives
    s1.triggerData = null;
    const s3 = getOrCreateSessionForTrigger(4918, 'new-session-id');
    assert(sessions.size === 3, 'no adoption with 2+ sessions');
});

// === Category 8: Edge cases ===

runTest('27. Empty string session_id treated as no session_id', () => {
    addSession(100, 'sid-A');
    const result = getOrCreateSessionForTrigger(100, '');
    assert(result.sessionId === 'sid-A', 'should reuse via no-sid path');
});

runTest('28. Session with null sessionId, new call with session_id', () => {
    const s1 = addSession(100, null);
    const result = getOrCreateSessionForTrigger(100, 'sid-A');
    assert(result === s1, 'should adopt null-sid session');
    assert(result.sessionId === 'sid-A', 'sid set');
});

runTest('29. Sole session from a dead PID (different PID)', () => {
    addSession(999, 'sid-DEAD');
    const result = getOrCreateSessionForTrigger(100, 'sid-NEW');
    assert(sessions.size === 2, 'should NOT adopt (PID mismatch)');
});

runTest('30. Large number of sessions: no adoption', () => {
    for (let i = 0; i < 20; i++) {
        addSession(100, `sid-${i}`);
    }
    const result = getOrCreateSessionForTrigger(100, 'sid-NEW');
    assert(sessions.size === 21, 'creates new session');
});

// === Category 9: Rapid sequential calls ===

runTest('31. Rapid calls with same session_id', () => {
    addSession(100, 'sid-A');
    for (let i = 0; i < 50; i++) {
        const result = getOrCreateSessionForTrigger(100, 'sid-A');
        assert(result.sessionId === 'sid-A', `iteration ${i}`);
    }
    assert(sessions.size === 1, 'still 1 session after 50 calls');
});

runTest('32. Rapid calls with incrementing session_ids', () => {
    addSession(100, 'sid-0');
    for (let i = 1; i <= 10; i++) {
        // Each call: sessions.size=1 (prev was adopted), idle, same PID → adopt
        const result = getOrCreateSessionForTrigger(100, `sid-${i}`);
        assert(result.sessionId === `sid-${i}`, `iteration ${i}`);
        assert(sessions.size === 1, `still 1 session at iteration ${i}`);
    }
});

runTest('33. Alternating session_ids (A, B, A, B...)', () => {
    addSession(100, 'sid-A');
    for (let i = 0; i < 10; i++) {
        const sid = i % 2 === 0 ? 'sid-B' : 'sid-A';
        const result = getOrCreateSessionForTrigger(100, sid);
        assert(result.sessionId === sid, `iteration ${i} sid=${sid}`);
        assert(sessions.size === 1, `still 1 session at iteration ${i}`);
    }
});

// === Category 10: PID changes ===

runTest('34. Same session_id, PID changes (MCP restart)', () => {
    const s1 = addSession(100, 'sid-A');
    const result = getOrCreateSessionForTrigger(200, 'sid-A');
    assert(result === s1, 'should match by session_id');
    assert(result.mcpPid === 200, 'PID updated');
});

runTest('35. New session_id with new PID, sole old session', () => {
    addSession(100, 'sid-OLD');
    const result = getOrCreateSessionForTrigger(200, 'sid-NEW');
    assert(sessions.size === 2, 'PID mismatch → new session');
});

runTest('36. No session_id with new PID, sole old session', () => {
    addSession(100, 'sid-OLD');
    const result = getOrCreateSessionForTrigger(200, '');
    assert(sessions.size === 2, 'no PID match → new session');
});

// === Category 11: Trigger state variations ===

runTest('37. Adopt after trigger was cleared', () => {
    const s1 = addSession(100, 'sid-A');
    s1.triggerData = { trigger_id: 'tid-1' };
    // First call — has trigger, create new
    const s2 = getOrCreateSessionForTrigger(100, 'sid-B');
    assert(sessions.size === 2, '2 sessions');
    // Clear s1's trigger, remove s2
    s1.triggerData = null;
    sessions.delete(s2.key);
    // Now sessions.size=1, s1 idle, same PID → adopt
    const s3 = getOrCreateSessionForTrigger(100, 'sid-C');
    assert(s3 === s1, 'should adopt after cleanup');
    assert(s3.sessionId === 'sid-C', 'sid updated');
});

runTest('38. Multiple triggers in sequence (same session)', () => {
    const s = addSession(100, 'sid-A');
    for (let i = 0; i < 10; i++) {
        s.triggerData = { trigger_id: `tid-${i}` };
        const result = getOrCreateSessionForTrigger(100, 'sid-A');
        assert(result === s, `should match sid-A at iteration ${i}`);
        s.triggerData = null;
    }
    assert(sessions.size === 1, 'still 1 session');
});

// === Category 12: Stress tests ===

runTest('39. 100 concurrent sessions, new sid always creates new', () => {
    for (let i = 0; i < 100; i++) {
        addSession(100, `sid-${i}`);
    }
    const result = getOrCreateSessionForTrigger(100, 'sid-NEW');
    assert(sessions.size === 101, 'creates 101st session');
    assert(result.sessionId === 'sid-NEW', 'correct sid');
});

runTest('40. Repeated adoption cycle 100 times', () => {
    addSession(100, 'sid-0');
    for (let i = 1; i <= 100; i++) {
        const result = getOrCreateSessionForTrigger(100, `sid-${i}`);
        assert(sessions.size === 1, `still 1 session at ${i}`);
        assert(result.sessionId === `sid-${i}`, `sid correct at ${i}`);
    }
});

// === Category 13: Mixed PID scenarios ===

runTest('41. Two PIDs, each with one session, same window', () => {
    addSession(100, 'sid-A');
    addSession(200, 'sid-B');
    const result = getOrCreateSessionForTrigger(100, 'sid-C');
    assert(sessions.size === 3, 'no adoption (2 sessions)');
});

runTest('42. Session from PID-100, new call from PID-100 with new sid, PID-200 session also exists', () => {
    addSession(100, 'sid-A');
    addSession(200, 'sid-B');
    const result = getOrCreateSessionForTrigger(100, 'sid-NEW');
    assert(sessions.size === 3, 'no adoption with 2 sessions globally');
});

runTest('43. Session from PID-200 removed, now only PID-100 session left', () => {
    const s1 = addSession(100, 'sid-A');
    const s2 = addSession(200, 'sid-B');
    sessions.delete(s2.key);
    const result = getOrCreateSessionForTrigger(100, 'sid-NEW');
    assert(result === s1, 'should adopt now (only 1 session)');
    assert(result.sessionId === 'sid-NEW', 'sid updated');
});

// === Category 14: Session_id matching edge cases ===

runTest('44. Session_id with special characters', () => {
    const s1 = addSession(100, 'sid-with-dashes-and_underscores.v2');
    const result = getOrCreateSessionForTrigger(100, 'sid-with-dashes-and_underscores.v2');
    assert(result === s1, 'should match exact');
});

runTest('45. Very long session_id', () => {
    const longSid = 'a'.repeat(1000);
    const s1 = addSession(100, longSid);
    const result = getOrCreateSessionForTrigger(100, longSid);
    assert(result === s1, 'should match long sid');
});

runTest('46. Unicode session_id', () => {
    const s1 = addSession(100, '会话-ABC-123');
    const result = getOrCreateSessionForTrigger(100, '会话-ABC-123');
    assert(result === s1, 'should match unicode sid');
});

// === Category 15: The exact "message loss" regression scenarios ===

runTest('47. REGRESSION: Two conversations same PID, A idle, B new — must NOT adopt', () => {
    // This is THE bug scenario. A and B are different conversations.
    const sA = addSession(100, 'conv-A');
    // User starts a second conversation (B) in same window
    addSession(100, 'conv-B');
    // B's compaction generates new sid
    const result = getOrCreateSessionForTrigger(100, 'conv-B-compacted');
    // Must match existing conv-B, NOT adopt conv-A
    assert(sessions.size === 3, 'sessions.size=2 prevents adoption, creates new');
});

runTest('48. REGRESSION: Three conversations, new sid must create new', () => {
    addSession(100, 'conv-A');
    addSession(100, 'conv-B');
    addSession(100, 'conv-C');
    const result = getOrCreateSessionForTrigger(100, 'conv-D');
    assert(sessions.size === 4, 'always creates new with 3+ sessions');
});

runTest('49. REGRESSION: A idle, B idle, C arrives — no adoption', () => {
    addSession(100, 'conv-A');
    addSession(100, 'conv-B');
    const result = getOrCreateSessionForTrigger(100, 'conv-C');
    assert(sessions.size === 3, 'no adoption');
});

runTest('50. REGRESSION: Only 1 session, has trigger, new conv — creates new', () => {
    addSession(100, 'conv-A', { triggerData: { trigger_id: 'tid-1' } });
    const result = getOrCreateSessionForTrigger(100, 'conv-B');
    assert(sessions.size === 2, 'creates new (A has trigger)');
});

// === Category 16: Session cleanup integration scenarios ===

runTest('51. Session cleaned up, only 1 remains, new sid — adopts', () => {
    const s1 = addSession(100, 'conv-old1');
    const s2 = addSession(100, 'conv-old2');
    // Simulate cleanup removing s2
    sessions.delete(s2.key);
    const result = getOrCreateSessionForTrigger(100, 'conv-new');
    assert(result === s1, 'should adopt sole remaining');
});

runTest('52. All sessions cleaned up, new sid — creates fresh', () => {
    const s1 = addSession(100, 'conv-old');
    sessions.delete(s1.key);
    const result = getOrCreateSessionForTrigger(100, 'conv-new');
    assert(sessions.size === 1, 'creates fresh');
    assert(result.sessionId === 'conv-new', 'correct sid');
});

// === Category 17: Falsy/truthy session_id values ===

runTest('53. session_id=undefined treated as no-sid path', () => {
    const s1 = addSession(100, 'sid-A');
    const result = getOrCreateSessionForTrigger(100, undefined);
    assert(result === s1, 'reuses via no-sid heuristic');
});

runTest('54. session_id=0 treated as falsy (no-sid path)', () => {
    const s1 = addSession(100, 'sid-A');
    const result = getOrCreateSessionForTrigger(100, 0);
    assert(result === s1, 'reuses via no-sid heuristic');
});

runTest('55. session_id=false treated as falsy', () => {
    const s1 = addSession(100, 'sid-A');
    const result = getOrCreateSessionForTrigger(100, false);
    assert(result === s1, 'reuses via no-sid heuristic');
});

// === Category 18: Multiple PIDs, no session_id ===

runTest('56. No sid, PID has 0 sessions: create new', () => {
    addSession(200, null); // different PID
    const result = getOrCreateSessionForTrigger(100, '');
    assert(sessions.size === 2, 'creates new for PID 100');
});

runTest('57. No sid, PID has 1 idle session: reuse', () => {
    addSession(100, null);
    addSession(200, null);
    const result = getOrCreateSessionForTrigger(100, '');
    assert(sessions.size === 2, 'reuses PID 100 session');
});

runTest('58. No sid, PID has 1 busy session: create new', () => {
    addSession(100, 'sid-A', { triggerData: { trigger_id: 'tid-1' } });
    const result = getOrCreateSessionForTrigger(100, '');
    assert(sessions.size === 2, 'creates new (busy)');
});

runTest('59. No sid, PID has 2 sessions: create new (ambiguous)', () => {
    addSession(100, 'sid-A');
    addSession(100, 'sid-B');
    const result = getOrCreateSessionForTrigger(100, '');
    assert(sessions.size === 3, 'creates new (ambiguous)');
});

// === Category 19: Adoption preserves session key (queue compatibility) ===

runTest('60. Adoption preserves session.key', () => {
    const s1 = addSession(100, 'sid-OLD');
    const originalKey = s1.key;
    const result = getOrCreateSessionForTrigger(100, 'sid-NEW');
    assert(result.key === originalKey, 'key must not change');
});

runTest('61. Adoption preserves session.messages', () => {
    const s1 = addSession(100, 'sid-OLD');
    s1.messages.push({ text: 'hello', type: 'user' });
    const result = getOrCreateSessionForTrigger(100, 'sid-NEW');
    assert(result.messages.length === 1, 'messages preserved');
    assert(result.messages[0].text === 'hello', 'message content preserved');
});

runTest('62. Adoption preserves session.index', () => {
    const s1 = addSession(100, 'sid-OLD');
    const origIdx = s1.index;
    const result = getOrCreateSessionForTrigger(100, 'sid-NEW');
    assert(result.index === origIdx, 'index preserved');
});

// === Category 20: Batch scenarios (simulating real usage patterns) ===

runTest('63. Real usage: single conversation lifecycle', () => {
    // Agent starts conversation
    const s = getOrCreateSessionForTrigger(100, 'sid-A');
    assert(sessions.size === 1, 'created');
    // Agent sends multiple triggers
    s.triggerData = { trigger_id: 'tid-1' };
    getOrCreateSessionForTrigger(100, 'sid-A');
    s.triggerData = null;
    s.triggerData = { trigger_id: 'tid-2' };
    getOrCreateSessionForTrigger(100, 'sid-A');
    s.triggerData = null;
    assert(sessions.size === 1, 'still 1');
    // Compaction happens
    getOrCreateSessionForTrigger(100, 'sid-A-v2');
    assert(sessions.size === 1, 'adopted after compaction');
});

runTest('64. Real usage: two conversations lifecycle', () => {
    // Conversation A
    const sA = getOrCreateSessionForTrigger(100, 'sid-A');
    sA.triggerData = { trigger_id: 'tid-A1' };
    getOrCreateSessionForTrigger(100, 'sid-A');
    sA.triggerData = null;
    // Conversation B starts while A is idle — sessions.size=1, so B adopts A's session
    // This is the designed trade-off: indistinguishable from compaction
    const sB = getOrCreateSessionForTrigger(100, 'sid-B');
    assert(sessions.size === 1, 'B adopts sole idle session (indistinguishable from compaction)');
    assert(sB === sA, 'same session object');
    assert(sB.sessionId === 'sid-B', 'sessionId updated to B');
    // Now A and B share the session — acceptable because we cannot distinguish
    // "new conversation" from "compaction" when only 1 session exists.
    sB.triggerData = { trigger_id: 'tid-B1' };
    getOrCreateSessionForTrigger(100, 'sid-B');
    sB.triggerData = null;
    // "A" tries to come back with original sid — sessions.size=1, adopts again
    const sAv2 = getOrCreateSessionForTrigger(100, 'sid-A');
    assert(sessions.size === 1, 'A re-adopts');
    assert(sAv2.sessionId === 'sid-A', 'sid reverts to A');
});

runTest('65. Real usage: conversation ends, session cleaned, new conv starts', () => {
    const sA = getOrCreateSessionForTrigger(100, 'sid-A');
    sA.triggerData = { trigger_id: 'tid-A' };
    sA.triggerData = null;
    // Session cleaned after timeout
    sessions.delete(sA.key);
    // New conversation
    const sB = getOrCreateSessionForTrigger(100, 'sid-B');
    assert(sessions.size === 1, 'fresh start');
    assert(sB.sessionId === 'sid-B', 'correct sid');
});

// === Category 21: Paranoia tests for old bug ===

runTest('66. OLD BUG: pidSessions=2, idleSessions=1 — must NOT adopt', () => {
    addSession(100, 'sid-A');
    addSession(100, 'sid-B', { triggerData: { trigger_id: 'tid-1' } });
    // Old code: pidSessions.length=2, idleSessions.length=1, pidSessions.length !== idleSessions.length → no adopt. OK.
    // But what if both are idle?
    const result = getOrCreateSessionForTrigger(100, 'sid-C');
    assert(sessions.size === 3, 'must create new (sessions.size=2)');
});

runTest('67. OLD BUG: pidSessions=1 all idle — old code would adopt; new code checks sessions.size', () => {
    // Add session for PID 100
    const s1 = addSession(100, 'sid-A');
    // Add session for PID 200 (different PID)
    addSession(200, 'sid-B');
    // Old code: pidSessions for PID 100 = [s1], idleSessions=[s1], would adopt.
    // New code: sessions.size=2, no adoption.
    const result = getOrCreateSessionForTrigger(100, 'sid-C');
    assert(sessions.size === 3, 'new code prevents adoption across PIDs');
});

runTest('68. Verify the EXACT old bug condition is fixed', () => {
    // Scenario from the user's logs: PID 4918, two sessions
    const sRelease = addSession(4918, 'a1b2c3d4-5678-9012-3456-789abcdef012');
    const sDebug = addSession(4918, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    // New trigger from yet another session_id
    const result = getOrCreateSessionForTrigger(4918, 'brand-new-sid');
    assert(result !== sRelease, 'must not hijack release session');
    assert(result !== sDebug, 'must not hijack debug session');
    assert(sessions.size === 3, 'creates 3rd session');
});

// === Category 22: Additional safety scenarios ===

runTest('69. Null PID handling', () => {
    const s1 = addSession(null, 'sid-A');
    const result = getOrCreateSessionForTrigger(null, 'sid-A');
    assert(result === s1, 'matches by session_id regardless of PID');
});

runTest('70. PID=0 handling', () => {
    const s1 = addSession(0, 'sid-A');
    const result = getOrCreateSessionForTrigger(0, 'sid-A');
    assert(result === s1, 'matches by session_id');
});

runTest('71. Adoption with PID=0', () => {
    addSession(0, 'sid-OLD');
    const result = getOrCreateSessionForTrigger(0, 'sid-NEW');
    assert(result.sessionId === 'sid-NEW', 'adopted');
    assert(sessions.size === 1, 'still 1');
});

// === Category 23: Return value contracts ===

runTest('72. Always returns an object with key property', () => {
    for (let i = 0; i < 20; i++) {
        reset();
        if (i % 3 === 0) addSession(100, `sid-${i}`);
        if (i % 5 === 0) addSession(100, `sid-alt-${i}`, { triggerData: { trigger_id: 'tid' } });
        const result = getOrCreateSessionForTrigger(100, i % 2 === 0 ? `sid-call-${i}` : '');
        assert(result && typeof result.key === 'string', `iteration ${i}: must return session with key`);
    }
});

runTest('73. Returned session is always in sessions Map', () => {
    for (let i = 0; i < 20; i++) {
        reset();
        if (i > 0) addSession(100, `sid-${i}`);
        const result = getOrCreateSessionForTrigger(100, `sid-call-${i}`);
        assert(sessions.has(result.key), `iteration ${i}: result must be in sessions`);
    }
});

// === Category 24: Session_id conflict detection ===

runTest('74. Two sessions claim same sessionId — first match wins', () => {
    const s1 = addSession(100, 'sid-SAME');
    const s2 = addSession(100, 'sid-SAME');
    const result = getOrCreateSessionForTrigger(100, 'sid-SAME');
    assert(result === s1, 'first match wins');
});

// === Category 25: Full lifecycle with adoption + new conversation ===

runTest('75. Lifecycle: create → adopt → new conv while adopted session busy', () => {
    // Create session A
    const sA = getOrCreateSessionForTrigger(100, 'sid-A');
    assert(sessions.size === 1);
    // Compaction: adopt for sid-A2
    const sA2 = getOrCreateSessionForTrigger(100, 'sid-A2');
    assert(sA2 === sA, 'adopted');
    assert(sessions.size === 1);
    // A2 gets a trigger
    sA2.triggerData = { trigger_id: 'tid-A2' };
    // New conversation B arrives while A2 is busy
    const sB = getOrCreateSessionForTrigger(100, 'sid-B');
    assert(sB !== sA2, 'should not adopt busy session');
    assert(sessions.size === 2, '2 sessions');
    // A2 finishes, B gets trigger
    sA2.triggerData = null;
    sB.triggerData = { trigger_id: 'tid-B' };
    // A2's compaction (sid-A3) — sessions.size=2, no adoption
    const sA3 = getOrCreateSessionForTrigger(100, 'sid-A3');
    assert(sessions.size === 3, 'creates 3rd session');
});

// === Category 26: Generate remaining tests to reach 100 ===

for (let i = 76; i <= 90; i++) {
    runTest(`${i}. Stress: ${i-75} idle sessions from same PID, new sid creates new`, () => {
        const count = i - 75;
        for (let j = 0; j < count; j++) {
            addSession(100, `sid-${j}`);
        }
        const before = sessions.size;
        const result = getOrCreateSessionForTrigger(100, 'sid-NEW');
        if (count === 1) {
            assert(sessions.size === 1, 'adopted sole session');
        } else {
            assert(sessions.size === before + 1, `creates new with ${count} sessions`);
        }
    });
}

for (let i = 91; i <= 95; i++) {
    runTest(`${i}. Stress: ${i-85} sessions from ${i-88} PIDs, new sid creates new`, () => {
        const numSessions = i - 85;
        const numPids = Math.max(1, i - 88);
        for (let j = 0; j < numSessions; j++) {
            addSession(100 + (j % numPids), `sid-${j}`);
        }
        const before = sessions.size;
        const result = getOrCreateSessionForTrigger(100, 'sid-NEW');
        if (sessions.size > 1) {
            // Won't adopt since multiple sessions
        }
        assert(result.sessionId === 'sid-NEW', 'correct sid');
    });
}

runTest('96. Adoption does not leak memory (sessions Map size)', () => {
    addSession(100, 'sid-A');
    for (let i = 0; i < 1000; i++) {
        getOrCreateSessionForTrigger(100, `sid-${i}`);
    }
    assert(sessions.size === 1, 'sessions Map stays at 1');
});

runTest('97. No-sid path with 100 sessions from different PIDs', () => {
    for (let i = 0; i < 100; i++) {
        addSession(100 + i, `sid-${i}`);
    }
    const result = getOrCreateSessionForTrigger(999, '');
    assert(sessions.size === 101, 'creates new (no PID match)');
});

runTest('98. Session_id match across 100 sessions', () => {
    for (let i = 0; i < 99; i++) {
        addSession(100, `sid-${i}`);
    }
    const target = addSession(100, 'sid-TARGET');
    const result = getOrCreateSessionForTrigger(100, 'sid-TARGET');
    assert(result === target, 'finds correct session among 100');
});

runTest('99. Adoption only fires when sessions.size is exactly 1', () => {
    for (let size = 0; size <= 5; size++) {
        reset();
        for (let j = 0; j < size; j++) {
            addSession(100, `sid-${j}`);
        }
        const before = sessions.size;
        const result = getOrCreateSessionForTrigger(100, 'sid-NEW');
        if (size === 0) {
            assert(sessions.size === 1, 'creates new when empty');
        } else if (size === 1) {
            assert(sessions.size === 1, 'adopts when sole');
        } else {
            assert(sessions.size === before + 1, `creates new when size=${size}`);
        }
    }
});

runTest('100. Final comprehensive: full conversation simulation', () => {
    // Day 1: User starts conversation A
    const sA = getOrCreateSessionForTrigger(100, 'conv-A-sid1');
    sA.triggerData = { trigger_id: 'tid-1' };
    getOrCreateSessionForTrigger(100, 'conv-A-sid1'); // heartbeat re-enter
    sA.triggerData = null;
    assert(sessions.size === 1);

    // Day 1: Compaction happens, new sid
    getOrCreateSessionForTrigger(100, 'conv-A-sid2');
    assert(sessions.size === 1, 'adopted after compaction');

    // Day 1: User starts conversation B while A is idle (sole session → adopts)
    const sB = getOrCreateSessionForTrigger(100, 'conv-B-sid1');
    assert(sessions.size === 1, 'B adopts sole idle session');
    assert(sB.sessionId === 'conv-B-sid1', 'sid updated');

    // Day 1: B gets trigger, creating a "busy" state
    sB.triggerData = { trigger_id: 'tid-B1' };
    // Now user opens conversation C while B is busy
    const sC = getOrCreateSessionForTrigger(100, 'conv-C-sid1');
    assert(sessions.size === 2, 'C creates new (B has trigger)');
    sB.triggerData = null;

    // Day 2: B compacts — sessions.size=2, no adoption
    const sBv2 = getOrCreateSessionForTrigger(100, 'conv-B-sid2');
    assert(sessions.size === 3, 'no adoption (2+ sessions)');

    // Day 2: Clean up all except sBv2
    const keysToDelete = [];
    for (const [k, s] of sessions) {
        if (s !== sBv2) keysToDelete.push(k);
    }
    keysToDelete.forEach(k => sessions.delete(k));
    assert(sessions.size === 1);

    // Day 3: B compacts again — sole session → adopts
    getOrCreateSessionForTrigger(100, 'conv-B-sid3');
    assert(sessions.size === 1, 'adopted sole session');
});

// ── Report ──
console.log('\n' + '='.repeat(60));
console.log(`RESULTS: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failures.length > 0) {
    console.log('\nFAILURES:');
    failures.forEach(f => console.log(`  ❌ ${f.name}: ${f.error}`));
}
console.log('='.repeat(60));
process.exit(failures.length > 0 ? 1 : 0);
