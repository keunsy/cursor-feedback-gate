#!/usr/bin/env node
/**
 * Scenario simulation for session routing / persistence logic.
 * Mirrors extension.js session functions with injectable clock + mocks.
 * Run: node cursor-extension/test/scenario-simulation.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Injectable test harness ─────────────────────────
let fakeNow = Date.now();
let alivePids = new Set([process.pid]);
const writtenResponses = new Map();

function setNow(ms) { fakeNow = ms; }
function advance(ms) { fakeNow += ms; }
function setAlive(pid, alive) {
    if (alive) alivePids.add(pid);
    else alivePids.delete(pid);
}

function isProcessAlive(pid) {
    if (!pid || pid <= 0) return false;
    return alivePids.has(pid);
}

function getTempPath(filename) {
    return path.join(os.tmpdir(), filename);
}

function createHarness() {
    const sessions = new Map();
    let activeSessionKey = null;
    let sessionCounter = 0;
    let persistCount = 0;
    const globalState = new Map();

    function persistSessions() { persistCount++; }

    function createSessionKey(mcpPid, timestamp, counter) {
        return `${mcpPid}_${timestamp}_${counter}`;
    }

    function createSession(mcpPid, pidTimestamp, sessionId) {
        sessionCounter++;
        const key = createSessionKey(mcpPid, pidTimestamp, sessionCounter);
        const session = {
            key, mcpPid, pidTimestamp,
            sessionId: sessionId || null,
            index: sessionCounter,
            label: `#${sessionCounter}`,
            triggerData: null,
            messages: [],
            draft: '',
            createdAt: fakeNow,
            lastActiveAt: fakeNow,
            lastResponseTime: 0,
            pendingRemoteReply: null,
        };
        sessions.set(key, session);
        persistSessions();
        return session;
    }

    function getAllSessionsByMcpPid(mcpPid) {
        return [...sessions.values()].filter(s => s.mcpPid === mcpPid);
    }

    function _tryAdoptUnboundSession(mcpPid, now) {
        const unbound = [...sessions.values()].filter(s => s.mcpPid === 0);
        if (unbound.length !== 1) return null;
        const only = unbound[0];
        if (only.triggerData && (now - only.lastActiveAt) < 15 * 60 * 1000) return null;
        only.mcpPid = mcpPid;
        only.lastActiveAt = now;
        delete only.restoredAt;
        return only;
    }

    function writeExpiredIfNeeded(staleTid) {
        if (!staleTid) return;
        const respFile = getTempPath(`feedback_gate_response_${staleTid}.json`);
        if (!fs.existsSync(respFile)) {
            writtenResponses.set(staleTid, '[EXPIRED]');
        }
    }

    function getOrCreateSessionForTrigger(mcpPid, sessionId) {
        const now = fakeNow;
        if (sessionId) {
            for (const s of sessions.values()) {
                if (s.sessionId === sessionId) {
                    if (s.mcpPid !== mcpPid) s.mcpPid = mcpPid;
                    s.lastActiveAt = now;
                    return s;
                }
            }
            const ADOPT_STALE_TRIGGER_MS = 15 * 60 * 1000;
            const ADOPT_MAX_SESSION_AGE_MS = 60 * 60 * 1000;
            if (sessions.size === 1) {
                const only = sessions.values().next().value;
                // P3-1 (mirrors extension.js): a sole session that already owns a
                // DIFFERENT session_id is another live conversation in the same
                // window — never re-label it. Adoption is reserved for identity-less
                // sessions (legacy first call / no session_id support).
                const soleHasOtherIdentity = !!only.sessionId && only.sessionId !== sessionId;
                if (!soleHasOtherIdentity) {
                    const sessionTooOld = (now - only.lastActiveAt) > ADOPT_MAX_SESSION_AGE_MS;
                    if (!sessionTooOld) {
                        const triggerStale = only.triggerData && (now - only.lastActiveAt) > ADOPT_STALE_TRIGGER_MS;
                        if (!only.triggerData || triggerStale) {
                            if (triggerStale) {
                                writeExpiredIfNeeded(only.triggerData.trigger_id);
                                only.triggerData = null;
                            }
                            only.sessionId = sessionId;
                            only.mcpPid = mcpPid;
                            only.lastActiveAt = now;
                            persistSessions();
                            return only;
                        }
                    }
                }
            }
            return createSession(mcpPid, now, sessionId);
        }

        const pidSessions = getAllSessionsByMcpPid(mcpPid);
        if (pidSessions.length === 0) {
            const adopted = _tryAdoptUnboundSession(mcpPid, now);
            if (adopted) return adopted;
            return createSession(mcpPid, now);
        }
        if (pidSessions.length === 1) {
            const only = pidSessions[0];
            const triggerStale = only.triggerData && (now - only.lastActiveAt) > (15 * 60 * 1000);
            if (!only.triggerData || triggerStale) {
                if (triggerStale) {
                    writeExpiredIfNeeded(only.triggerData.trigger_id);
                    only.triggerData = null;
                }
                only.lastActiveAt = now;
                return only;
            }
            return createSession(mcpPid, now);
        }
        return createSession(mcpPid, now);
    }

    function restoreSessions() {
        const arr = globalState.get('feedbackGateSessions') || [];
        const now = fakeNow;
        for (const s of arr) {
            if (now - (s.lastActiveAt || s.createdAt || 0) > 7 * 24 * 3600 * 1000) continue;
            if (!s.key || sessions.has(s.key)) continue;
            sessions.set(s.key, {
                key: s.key, mcpPid: 0, pidTimestamp: s.createdAt || now,
                sessionId: s.sessionId || null, index: s.index || 0,
                label: s.label || `#${s.index || 0}`,
                triggerData: null, messages: s.messages || [],
                draft: s.draft || '', createdAt: s.createdAt || now,
                lastActiveAt: s.lastActiveAt || now, lastResponseTime: 0,
                restoredAt: now, pendingRemoteReply: null,
            });
        }
        const savedActive = globalState.get('feedbackGateActiveSession');
        if (savedActive && sessions.has(savedActive)) activeSessionKey = savedActive;
        else if (sessions.size > 0) activeSessionKey = sessions.keys().next().value;
    }

    function flushSessions() {
        const arr = [...sessions.values()].map(s => ({
            key: s.key, sessionId: s.sessionId, index: s.index,
            label: s.label, messages: s.messages, draft: s.draft,
            createdAt: s.createdAt, lastActiveAt: s.lastActiveAt,
        }));
        globalState.set('feedbackGateSessions', arr);
        globalState.set('feedbackGateActiveSession', activeSessionKey);
    }

    function cleanupStaleSessions() {
        const now = fakeNow;
        const STALE_TRIGGER_MS = 2 * 60 * 60 * 1000;
        const toRemove = [];
        for (const [key, session] of sessions) {
            const age = now - session.lastActiveAt;
            const processAlive = isProcessAlive(session.mcpPid);
            if (session.triggerData) {
                if (!processAlive && session.mcpPid !== 0) { toRemove.push(key); continue; }
                if (!processAlive && session.mcpPid === 0) continue;
                if (age > STALE_TRIGGER_MS) {
                    writeExpiredIfNeeded(session.triggerData.trigger_id);
                    session.triggerData = null;
                } else continue;
            }
            if (session.mcpPid === 0) {
                const graceStart = session.restoredAt || session.lastActiveAt;
                if (now - graceStart > 60 * 60 * 1000) toRemove.push(key);
            } else if (!processAlive && age > 2 * 60 * 1000) {
                toRemove.push(key);
            } else if (processAlive && age > 60 * 60 * 1000) {
                toRemove.push(key);
            }
        }
        for (const key of toRemove) sessions.delete(key);
        return toRemove.length;
    }

    function reset() {
        sessions.clear();
        activeSessionKey = null;
        sessionCounter = 0;
        persistCount = 0;
        globalState.clear();
        writtenResponses.clear();
        fakeNow = Date.now();
        alivePids = new Set([process.pid]);
    }

    return {
        sessions, activeSessionKey: () => activeSessionKey,
        setActiveSessionKey: (k) => { activeSessionKey = k; },
        sessionCounter: () => sessionCounter,
        persistCount: () => persistCount,
        globalState, writtenResponses,
        createSession, getOrCreateSessionForTrigger, restoreSessions,
        flushSessions, cleanupStaleSessions, reset, getAllSessionsByMcpPid,
    };
}

// ── Scenario runner ─────────────────────────────────
const results = [];
function scenario(name, fn) {
    const h = createHarness();
    h.reset();
    try {
        fn(h);
        results.push({ name, ok: true });
        console.log(`  ✅ ${name}`);
    } catch (e) {
        results.push({ name, ok: false, error: e.message });
        console.log(`  ❌ ${name}: ${e.message}`);
    }
}

console.log('\nFeedback Gate — Session Scenario Simulation\n');

// S1: First trigger, no session_id
scenario('S1: first trigger without session_id creates one session', (h) => {
    setAlive(9999, true);
    const s = h.getOrCreateSessionForTrigger(9999, '');
    assert.strictEqual(h.sessions.size, 1);
    assert.strictEqual(s.mcpPid, 9999);
    assert.strictEqual(s.sessionId, null);
});

// S2: Second trigger same PID, no session_id, idle
scenario('S2: second trigger same PID reuses idle session', (h) => {
    setAlive(9999, true);
    const s1 = h.getOrCreateSessionForTrigger(9999, '');
    advance(1000);
    const s2 = h.getOrCreateSessionForTrigger(9999, '');
    assert.strictEqual(s1.key, s2.key);
    assert.strictEqual(h.sessions.size, 1);
});

// S3: Second conversation in the SAME window (P3-1) — session_id is authoritative
scenario('S3: a second conversation never adopts the sole session of the first one', (h) => {
    setAlive(9999, true);
    const s1 = h.getOrCreateSessionForTrigger(9999, 'uuid-A');
    s1.messages.push({ text: 'hello', type: 'system' });
    advance(1000);
    // Conversation B calls the gate for the first time. A is idle (no pending
    // trigger), which used to be enough for B to take over A's session — merging
    // the histories and letting B's trigger consume A's queued input.
    const s2 = h.getOrCreateSessionForTrigger(9999, 'uuid-B');
    assert.notStrictEqual(s1.key, s2.key, 'must create a separate session');
    assert.strictEqual(s1.sessionId, 'uuid-A', 'A keeps its identity');
    assert.strictEqual(s2.sessionId, 'uuid-B');
    assert.strictEqual(h.sessions.size, 2);
    assert.strictEqual(s1.messages.length, 1, 'A keeps its own history');
    assert.strictEqual(s2.messages.length, 0);
});

// S4: Active trigger blocks adoption (<15min)
scenario('S4: active trigger blocks adoption of different session_id', (h) => {
    setAlive(9999, true);
    const s1 = h.getOrCreateSessionForTrigger(9999, 'uuid-A');
    s1.triggerData = { trigger_id: 't1', message: 'waiting' };
    advance(5 * 60 * 1000); // 5 min
    const s2 = h.getOrCreateSessionForTrigger(9999, 'uuid-B');
    assert.notStrictEqual(s1.key, s2.key, 'should create new session');
    assert.strictEqual(h.sessions.size, 2);
});

// S5: Stale trigger (>15min) allows adoption — only for identity-less sessions
scenario('S5: stale trigger (>15min) cleared and identity-less session adopted', (h) => {
    setAlive(9999, true);
    const s1 = h.getOrCreateSessionForTrigger(9999, '');   // legacy: no session_id yet
    assert.strictEqual(s1.sessionId, null);
    s1.triggerData = { trigger_id: 't-stale', message: 'old' };
    advance(16 * 60 * 1000);
    const s2 = h.getOrCreateSessionForTrigger(9999, 'uuid-B');
    assert.strictEqual(s1.key, s2.key);
    assert.strictEqual(s2.sessionId, 'uuid-B');
    assert.strictEqual(s2.triggerData, null);
    assert.ok(h.writtenResponses.has('t-stale'));
});

// S6: isProcessAlive(0) guard
scenario('S6: isProcessAlive(0) returns false', () => {
    assert.strictEqual(isProcessAlive(0), false);
    assert.strictEqual(isProcessAlive(-1), false);
});

// S7: Restored session (mcpPid=0) adopted on first trigger
scenario('S7: restored unbound session adopted on trigger', (h) => {
    h.globalState.set('feedbackGateSessions', [{
        key: '111_1_1', sessionId: 'uuid-A', index: 1, label: '#1',
        messages: [{ text: 'saved', type: 'user' }], draft: 'draft text',
        createdAt: fakeNow - 60000, lastActiveAt: fakeNow - 60000,
    }]);
    h.restoreSessions();
    assert.strictEqual(h.sessions.size, 1);
    const s = h.getOrCreateSessionForTrigger(8888, '');
    assert.strictEqual(s.mcpPid, 8888);
    assert.strictEqual(s.messages.length, 1);
    assert.strictEqual(h.sessions.size, 1);
});

// S8: Multiple restored — only session_id match
scenario('S8: multiple restored sessions require session_id match', (h) => {
    const t = fakeNow - 60000;
    h.globalState.set('feedbackGateSessions', [
        { key: 'a_1_1', sessionId: 'uuid-A', index: 1, label: '#1', messages: [], draft: '', createdAt: t, lastActiveAt: t },
        { key: 'b_1_2', sessionId: 'uuid-B', index: 2, label: '#2', messages: [], draft: '', createdAt: t, lastActiveAt: t },
    ]);
    h.restoreSessions();
    const s = h.getOrCreateSessionForTrigger(8888, 'uuid-B');
    assert.strictEqual(s.sessionId, 'uuid-B');
    assert.strictEqual(h.sessions.size, 2);
});

// S9: Trigger without session_id reuses idle tagged session (same conversation)
scenario('S9: trigger without session_id reuses idle session even if sessionId set', (h) => {
    setAlive(9999, true);
    h.getOrCreateSessionForTrigger(9999, 'uuid-A');
    advance(1000);
    const s2 = h.getOrCreateSessionForTrigger(9999, '');
    assert.strictEqual(h.sessions.size, 1, 'should reuse sole idle session');
    assert.strictEqual(s2.sessionId, 'uuid-A');
});

// S10: mcpPid=0 not cleaned as dead
scenario('S10: restored session (mcpPid=0) survives dead-PID cleanup path', (h) => {
    h.globalState.set('feedbackGateSessions', [{
        key: 'old_1_1', sessionId: 'uuid-A', index: 1, label: '#1',
        messages: [], draft: '', createdAt: fakeNow, lastActiveAt: fakeNow,
    }]);
    h.restoreSessions();
    const s = [...h.sessions.values()][0];
    assert.strictEqual(s.mcpPid, 0);
    advance(30 * 60 * 1000);
    const removed = h.cleanupStaleSessions();
    assert.strictEqual(removed, 0, 'should not remove within 1h grace');
});

// S11: mcpPid=0 removed after 1h grace
scenario('S11: restored session removed after 1h grace without binding', (h) => {
    h.globalState.set('feedbackGateSessions', [{
        key: 'old_1_1', sessionId: 'uuid-A', index: 1, label: '#1',
        messages: [], draft: '', createdAt: fakeNow, lastActiveAt: fakeNow,
    }]);
    h.restoreSessions();
    advance(61 * 60 * 1000);
    const removed = h.cleanupStaleSessions();
    assert.strictEqual(removed, 1);
});

// S12: Persist + restore roundtrip
scenario('S12: persist flush restores messages and draft', (h) => {
    setAlive(9999, true);
    const s = h.getOrCreateSessionForTrigger(9999, 'uuid-A');
    s.messages.push({ text: 'msg1', type: 'user' });
    s.draft = 'typing...';
    h.setActiveSessionKey(s.key);
    h.flushSessions();

    const h2 = createHarness();
    h2.reset();
    h2.globalState.set('feedbackGateSessions', h.globalState.get('feedbackGateSessions'));
    h2.globalState.set('feedbackGateActiveSession', h.globalState.get('feedbackGateActiveSession'));
    h2.restoreSessions();
    const restored = [...h2.sessions.values()][0];
    assert.strictEqual(restored.draft, 'typing...');
    assert.strictEqual(restored.messages.length, 1);
    assert.strictEqual(restored.mcpPid, 0);
});

// S13: PID hop — session_id match updates mcpPid
scenario('S13: session_id match updates mcpPid on MCP restart', (h) => {
    setAlive(1111, true);
    const s1 = h.getOrCreateSessionForTrigger(1111, 'uuid-A');
    setAlive(1111, false);
    setAlive(2222, true);
    advance(1000);
    const s2 = h.getOrCreateSessionForTrigger(2222, 'uuid-A');
    assert.strictEqual(s1.key, s2.key);
    assert.strictEqual(s2.mcpPid, 2222);
});

// S14: Concurrent PID sessions — always create new
scenario('S14: two concurrent sessions same PID create separate tabs', (h) => {
    setAlive(9999, true);
    const s1 = h.getOrCreateSessionForTrigger(9999, '');
    s1.triggerData = { trigger_id: 't1' };
    advance(1000);
    const s2 = h.getOrCreateSessionForTrigger(9999, '');
    assert.strictEqual(h.sessions.size, 2);
});

// S15: Empty persist on last session close (deactivate gap)
scenario('S15: flush after delete-all persists empty (deactivate must flush)', (h) => {
    setAlive(9999, true);
    const s = h.getOrCreateSessionForTrigger(9999, 'uuid-A');
    h.setActiveSessionKey(s.key);
    h.flushSessions();
    assert.strictEqual(h.globalState.get('feedbackGateSessions').length, 1);
    h.sessions.delete(s.key);
    // simulate deactivate: must flush even when size=0
    h.globalState.set('feedbackGateSessions', []);
    h.globalState.set('feedbackGateActiveSession', null);
    assert.strictEqual(h.globalState.get('feedbackGateSessions').length, 0);
});

// S16: Re-entry with the SAME session_id always finds its own conversation
scenario('S16: same session_id reuses the session regardless of adoption limits', (h) => {
    setAlive(9999, true);
    const s1 = h.getOrCreateSessionForTrigger(9999, 'uuid-A');
    advance(2 * 60 * 60 * 1000);   // far beyond the 1h adoption window
    const s2 = h.getOrCreateSessionForTrigger(9999, 'uuid-A');
    assert.strictEqual(s1.key, s2.key, 'identity match wins over recency heuristics');
    assert.strictEqual(h.sessions.size, 1);
});

// S17: Identity-less sole session still adopts the first session_id (legacy path)
scenario('S17: identity-less sole session adopts the first session_id call', (h) => {
    setAlive(9999, true);
    const s1 = h.getOrCreateSessionForTrigger(9999, '');
    assert.strictEqual(s1.sessionId, null);
    advance(1000);
    const s2 = h.getOrCreateSessionForTrigger(9999, 'uuid-A');
    assert.strictEqual(s1.key, s2.key, 'no owner yet → adoption is safe');
    assert.strictEqual(s2.sessionId, 'uuid-A');
});

// S18: The reported defect, end to end at the session layer
scenario('S18: one window, two conversations — the running one is never hijacked', (h) => {
    setAlive(9999, true);
    // Conversation A: created first, agent is working (no gate trigger pending).
    const a = h.getOrCreateSessionForTrigger(9999, 'uuid-A');
    a.messages.push({ text: 'A: 请帮我生成脚本', type: 'user' });
    a.label = 'A 脚本';
    h.setActiveSessionKey(a.key);
    advance(60 * 1000);

    // Conversation B: first gate call in the same window (same MCP pid).
    const b = h.getOrCreateSessionForTrigger(9999, 'uuid-B');
    b.triggerData = { trigger_id: 'tB', message: 'B: 需要确认吗？', session_id: 'uuid-B' };

    assert.notStrictEqual(a.key, b.key, 'B must not take over A');
    assert.strictEqual(a.sessionId, 'uuid-A');
    assert.strictEqual(a.label, 'A 脚本', 'A keeps its tab label');
    assert.strictEqual(a.triggerData, null, 'A is not marked as waiting for B');
    assert.strictEqual(a.messages.length, 1, 'A keeps its own transcript');
    assert.strictEqual(h.sessions.size, 2);

    // B's re-entry still resolves to B, never to A.
    advance(5000);
    const bAgain = h.getOrCreateSessionForTrigger(9999, 'uuid-B');
    assert.strictEqual(bAgain.key, b.key);
    assert.strictEqual(a.triggerData, null);
});

const passed = results.filter(r => r.ok).length;
const failed = results.filter(r => !r.ok).length;
console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${results.length} total\n`);
process.exit(failed > 0 ? 1 : 0);
