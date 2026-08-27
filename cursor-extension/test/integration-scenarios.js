#!/usr/bin/env node
/**
 * Integration scenario tests — covers critical paths NOT covered by existing tests:
 * 1. Trigger routing (workspace match, focus, atomic claim)
 * 2. Remote control (maybeWriteOutbox, consumeIdeQueueFile routing, recovery filter)
 * 3. Dead-PID cleanup with sessionId protection (S1 fix)
 * 4. MCP status detection
 * 5. Message ordering (agent msg before queue consumption)
 *
 * Run: node cursor-extension/test/integration-scenarios.js
 */

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

// ── Shared state ─────────────────────────────────
let fakeNow = Date.now();
let alivePids = new Set([process.pid]);

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

// ── Test runner ──────────────────────────────────
const results = [];
function scenario(name, fn) {
    fakeNow = Date.now();
    alivePids = new Set([process.pid]);
    try {
        fn();
        results.push({ name, ok: true });
    } catch (e) {
        results.push({ name, ok: false, error: e.message });
        console.error(`  ❌ ${name}: ${e.message}`);
    }
}

// ═══════════════════════════════════════════════════════════════
// SECTION 1: Trigger Routing Logic
// ═══════════════════════════════════════════════════════════════

function createRoutingHarness() {
    const sessions = new Map();
    let activeSessionKey = null;
    let sessionCounter = 0;
    const claimedTriggers = [];

    function createSession(mcpPid, sessionId) {
        sessionCounter++;
        const key = `${mcpPid}_${fakeNow}_${sessionCounter}`;
        const session = {
            key, mcpPid, sessionId,
            triggerData: null, messages: [],
            lastActiveAt: fakeNow,
        };
        sessions.set(key, session);
        return session;
    }

    /**
     * Simulates the trigger routing decision logic from extension.js checkTriggerFile.
     * Returns: { claimed: boolean, reason: string }
     */
    function routeTrigger(triggerData, windowState) {
        const { workspacePath, isFocused } = windowState;
        const triggerSessionId = triggerData.data && triggerData.data.session_id;
        const triggerWorkspace = triggerData.data && triggerData.data.workspace_path;
        const targetEhPid = triggerData.targetEhPid;

        // Signal 0.5: multi-window session lease (mirrors extension.js)
        if (triggerSessionId && windowState.isLeaseHeldElsewhere
            && windowState.isLeaseHeldElsewhere(triggerSessionId)) {
            return { claimed: false, reason: 'session lease held elsewhere' };
        }

        // Signal 0: targetEhPid (skip if not us)
        if (targetEhPid && targetEhPid !== process.pid) {
            if (windowState.targetAlive !== false) {
                return { claimed: false, reason: 'targetEhPid mismatch' };
            }
            // Target EH dead (E10 mirror): the session owner claims; when NO
            // window owns the session, the focused window adopts the trigger
            // after a grace period instead of letting it strand forever.
            if (triggerSessionId) {
                let weOwnSession = false;
                for (const s of sessions.values()) {
                    if (s.sessionId === triggerSessionId) { weOwnSession = true; break; }
                }
                if (!weOwnSession) {
                    const triggerAgeMs = triggerData.timestamp ? Date.now() - new Date(triggerData.timestamp).getTime() : 0;
                    if (!(triggerAgeMs >= 15000 && isFocused)) {
                        return { claimed: false, reason: 'dead target, no owner, adoption not yet allowed' };
                    }
                }
            }
        }

        // Signal 1: session_id ownership
        if (triggerSessionId) {
            let weOwnSession = false;
            for (const s of sessions.values()) {
                if (s.sessionId === triggerSessionId) { weOwnSession = true; break; }
            }

            // Signal 2: workspace path matching
            const wsPrecise = !!(triggerWorkspace && workspacePath);
            const wsMatch = wsPrecise && triggerWorkspace === workspacePath;

            if (weOwnSession && wsPrecise && !wsMatch) {
                const triggerAgeMs = triggerData.timestamp ? Date.now() - new Date(triggerData.timestamp).getTime() : 0;
                if (triggerAgeMs < 3000) {
                    return { claimed: false, reason: 'workspace mismatch overrides session ownership' };
                }
                return { claimed: true, reason: 'session owner reclaim after yield timeout' };
            }
            if (weOwnSession) {
                claimedTriggers.push(triggerData);
                return { claimed: true, reason: 'session ownership' };
            }
            if (wsPrecise && !wsMatch) {
                return { claimed: false, reason: 'workspace mismatch' };
            }
            if (wsPrecise && wsMatch) {
                claimedTriggers.push(triggerData);
                return { claimed: true, reason: 'workspace match (new session)' };
            }
            // No owner, no workspace hint.  Windows with existing sessions
            // participate immediately; focused-but-empty windows defer; others skip.
            const hasAnySessions = sessions.size > 0;
            if (!hasAnySessions && !isFocused) {
                return { claimed: false, reason: 'no sessions, not focused' };
            }
            if (!hasAnySessions) {
                const triggerAgeMs = triggerData.timestamp ? Date.now() - new Date(triggerData.timestamp).getTime() : 0;
                if (triggerAgeMs < 1500) {
                    return { claimed: false, reason: 'focused but empty window defers' };
                }
            }
            claimedTriggers.push(triggerData);
            return { claimed: true, reason: hasAnySessions ? 'window with sessions races' : 'focused empty window claims after defer' };
        }

        // No session_id — use workspace + focus
        const wsPreciseNoSid = !!(triggerWorkspace && workspacePath);
        const wsMatchNoSid = wsPreciseNoSid && triggerWorkspace === workspacePath;
        if (wsPreciseNoSid && !wsMatchNoSid) {
            return { claimed: false, reason: 'workspace mismatch (no sessionId)' };
        }
        if (wsPreciseNoSid && wsMatchNoSid) {
            claimedTriggers.push(triggerData);
            return { claimed: true, reason: 'workspace match (no sessionId)' };
        }
        if (!isFocused) {
            return { claimed: false, reason: 'not focused, no workspace hint' };
        }
        claimedTriggers.push(triggerData);
        return { claimed: true, reason: 'focused fallback' };
    }

    return { sessions, createSession, routeTrigger, claimedTriggers,
        setActiveSessionKey: (k) => { activeSessionKey = k; },
        activeSessionKey: () => activeSessionKey };
}

scenario('TR-1: workspace match claims trigger even if not focused', () => {
    const h = createRoutingHarness();
    const result = h.routeTrigger(
        { data: { session_id: 'uuid-1', workspace_path: '/projects/foo' } },
        { workspacePath: '/projects/foo', isFocused: false }
    );
    assert.strictEqual(result.claimed, true);
    assert.strictEqual(result.reason, 'workspace match (new session)');
});

scenario('TR-2: workspace mismatch rejects trigger', () => {
    const h = createRoutingHarness();
    const result = h.routeTrigger(
        { data: { session_id: 'uuid-1', workspace_path: '/projects/foo' } },
        { workspacePath: '/projects/bar', isFocused: true }
    );
    assert.strictEqual(result.claimed, false);
    assert.strictEqual(result.reason, 'workspace mismatch');
});

scenario('TR-3: session ownership yields when workspace hint mismatches (fresh trigger)', () => {
    const h = createRoutingHarness();
    h.createSession(9999, 'uuid-1');
    const result = h.routeTrigger(
        { timestamp: new Date().toISOString(), data: { session_id: 'uuid-1', workspace_path: '/projects/other' } },
        { workspacePath: '/projects/mine', isFocused: false }
    );
    assert.strictEqual(result.claimed, false);
    assert.strictEqual(result.reason, 'workspace mismatch overrides session ownership');
});

scenario('TR-3c: session owner reclaims after yield grace period expires', () => {
    const h = createRoutingHarness();
    h.createSession(9999, 'uuid-1');
    const staleTimestamp = new Date(Date.now() - 4000).toISOString();
    const result = h.routeTrigger(
        { timestamp: staleTimestamp, data: { session_id: 'uuid-1', workspace_path: '/projects/other' } },
        { workspacePath: '/projects/mine', isFocused: false }
    );
    assert.strictEqual(result.claimed, true);
    assert.strictEqual(result.reason, 'session owner reclaim after yield timeout');
});

scenario('TR-3b: session ownership claims when workspace matches', () => {
    const h = createRoutingHarness();
    h.createSession(9999, 'uuid-1');
    const result = h.routeTrigger(
        { data: { session_id: 'uuid-1', workspace_path: '/projects/mine' } },
        { workspacePath: '/projects/mine', isFocused: false }
    );
    assert.strictEqual(result.claimed, true);
    assert.strictEqual(result.reason, 'session ownership');
});

scenario('TR-3c: session ownership claims when no workspace hint', () => {
    const h = createRoutingHarness();
    h.createSession(9999, 'uuid-1');
    const result = h.routeTrigger(
        { data: { session_id: 'uuid-1' } },
        { workspacePath: '/projects/mine', isFocused: false }
    );
    assert.strictEqual(result.claimed, true);
    assert.strictEqual(result.reason, 'session ownership');
});

scenario('TR-4: no session_id + no workspace → only focused claims', () => {
    const h = createRoutingHarness();
    const result = h.routeTrigger(
        { data: {} },
        { workspacePath: '', isFocused: true }
    );
    assert.strictEqual(result.claimed, true);
    assert.strictEqual(result.reason, 'focused fallback');
});

scenario('TR-5: no session_id + no workspace + not focused → rejected', () => {
    const h = createRoutingHarness();
    const result = h.routeTrigger(
        { data: {} },
        { workspacePath: '', isFocused: false }
    );
    assert.strictEqual(result.claimed, false);
});

scenario('TR-7: new session_id, no owner, no ws — window with sessions races', () => {
    const h = createRoutingHarness();
    h.createSession(9999, 'uuid-old');
    const result = h.routeTrigger(
        { timestamp: new Date().toISOString(), data: { session_id: 'uuid-new' } },
        { workspacePath: '/projects/mine', isFocused: false }
    );
    assert.strictEqual(result.claimed, true);
    assert.strictEqual(result.reason, 'window with sessions races');
});

scenario('TR-8: new session_id, no owner, no ws — empty focused window defers on fresh trigger', () => {
    const h = createRoutingHarness();
    const result = h.routeTrigger(
        { timestamp: new Date().toISOString(), data: { session_id: 'uuid-new' } },
        { workspacePath: '/projects/mine', isFocused: true }
    );
    assert.strictEqual(result.claimed, false);
    assert.strictEqual(result.reason, 'focused but empty window defers');
});

scenario('TR-9: new session_id, no owner, no ws — empty non-focused window rejected', () => {
    const h = createRoutingHarness();
    const result = h.routeTrigger(
        { timestamp: new Date().toISOString(), data: { session_id: 'uuid-new' } },
        { workspacePath: '/projects/mine', isFocused: false }
    );
    assert.strictEqual(result.claimed, false);
    assert.strictEqual(result.reason, 'no sessions, not focused');
});

scenario('TR-10: new session_id, no owner, no ws — empty focused window claims after defer timeout', () => {
    const h = createRoutingHarness();
    const staleTs = new Date(Date.now() - 2000).toISOString();
    const result = h.routeTrigger(
        { timestamp: staleTs, data: { session_id: 'uuid-new' } },
        { workspacePath: '/projects/mine', isFocused: true }
    );
    assert.strictEqual(result.claimed, true);
    assert.strictEqual(result.reason, 'focused empty window claims after defer');
});

scenario('TR-6: targetEhPid mismatch rejects immediately', () => {
    const h = createRoutingHarness();
    const result = h.routeTrigger(
        { targetEhPid: 99999, data: { session_id: 'uuid-1', workspace_path: '/projects/foo' } },
        { workspacePath: '/projects/foo', isFocused: true }
    );
    assert.strictEqual(result.claimed, false);
    assert.strictEqual(result.reason, 'targetEhPid mismatch');
});

scenario('TR-7: targetEhPid matches process.pid → continues routing', () => {
    const h = createRoutingHarness();
    const result = h.routeTrigger(
        { targetEhPid: process.pid, data: { session_id: 'uuid-1', workspace_path: '/projects/foo' } },
        { workspacePath: '/projects/foo', isFocused: false }
    );
    assert.strictEqual(result.claimed, true);
});

scenario('TR-8b: session_id present but no workspace hint + not focused + no sessions → rejected', () => {
    const h = createRoutingHarness();
    const result = h.routeTrigger(
        { timestamp: new Date().toISOString(), data: { session_id: 'uuid-new' } },
        { workspacePath: '/projects/foo', isFocused: false }
    );
    assert.strictEqual(result.claimed, false);
    assert.strictEqual(result.reason, 'no sessions, not focused');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 2: Remote Control — maybeWriteOutbox
// ═══════════════════════════════════════════════════════════════

function createOutboxHarness() {
    let globalPendingRemoteReply = null;
    const writtenEntries = [];

    function maybeWriteOutbox(agentMessage, session) {
        const rr = (session && session.pendingRemoteReply) || globalPendingRemoteReply;
        if (!rr) return;
        if (!agentMessage || agentMessage.trim().length < 1) return;

        const MAX_LEN = 500;
        const truncated = agentMessage.length > MAX_LEN
            ? agentMessage.slice(0, MAX_LEN) + '\n\n...（在 IDE 中查看完整内容）'
            : agentMessage;

        const entry = {
            chatId: rr.chatId,
            platform: rr.source,
            originalText: rr.originalText || '',
            agentMessage: truncated,
            ts: new Date().toISOString()
        };
        writtenEntries.push(entry);

        if (session && session.pendingRemoteReply) session.pendingRemoteReply = null;
        else globalPendingRemoteReply = null;
    }

    return {
        maybeWriteOutbox, writtenEntries,
        setGlobalReply: (rr) => { globalPendingRemoteReply = rr; },
        getGlobalReply: () => globalPendingRemoteReply,
    };
}

scenario('RO-1: session.pendingRemoteReply used when present', () => {
    const h = createOutboxHarness();
    const session = { pendingRemoteReply: { chatId: 'c1', source: 'feishu', originalText: 'hi' } };
    h.maybeWriteOutbox('reply text', session);
    assert.strictEqual(h.writtenEntries.length, 1);
    assert.strictEqual(h.writtenEntries[0].chatId, 'c1');
    assert.strictEqual(h.writtenEntries[0].platform, 'feishu');
    assert.strictEqual(session.pendingRemoteReply, null);
});

scenario('RO-2: falls back to global when session has no pendingRemoteReply', () => {
    const h = createOutboxHarness();
    h.setGlobalReply({ chatId: 'g1', source: 'wechat', originalText: 'global' });
    const session = { pendingRemoteReply: null };
    h.maybeWriteOutbox('reply', session);
    assert.strictEqual(h.writtenEntries.length, 1);
    assert.strictEqual(h.writtenEntries[0].chatId, 'g1');
    assert.strictEqual(h.getGlobalReply(), null);
});

scenario('RO-3: no-op when both session and global are null', () => {
    const h = createOutboxHarness();
    h.maybeWriteOutbox('reply', { pendingRemoteReply: null });
    assert.strictEqual(h.writtenEntries.length, 0);
});

scenario('RO-4: no-op when agentMessage is empty/whitespace', () => {
    const h = createOutboxHarness();
    h.setGlobalReply({ chatId: 'c1', source: 'feishu', originalText: '' });
    h.maybeWriteOutbox('   ', null);
    assert.strictEqual(h.writtenEntries.length, 0);
    assert.ok(h.getGlobalReply() !== null, 'should not clear on no-op');
});

scenario('RO-5: message truncated at 500 chars', () => {
    const h = createOutboxHarness();
    h.setGlobalReply({ chatId: 'c1', source: 'dingtalk', originalText: '' });
    const longMsg = 'A'.repeat(600);
    h.maybeWriteOutbox(longMsg, null);
    assert.strictEqual(h.writtenEntries.length, 1);
    assert.ok(h.writtenEntries[0].agentMessage.length < 600);
    assert.ok(h.writtenEntries[0].agentMessage.includes('...（在 IDE 中查看完整内容）'));
});

scenario('RO-6: session null → uses global', () => {
    const h = createOutboxHarness();
    h.setGlobalReply({ chatId: 'g2', source: 'wecom', originalText: '' });
    h.maybeWriteOutbox('hello', null);
    assert.strictEqual(h.writtenEntries.length, 1);
    assert.strictEqual(h.writtenEntries[0].chatId, 'g2');
});

scenario('RO-7: session.pendingRemoteReply prioritized over global', () => {
    const h = createOutboxHarness();
    h.setGlobalReply({ chatId: 'global', source: 'wechat', originalText: '' });
    const session = { pendingRemoteReply: { chatId: 'session', source: 'feishu', originalText: '' } };
    h.maybeWriteOutbox('msg', session);
    assert.strictEqual(h.writtenEntries[0].chatId, 'session');
    assert.ok(h.getGlobalReply() !== null, 'global should remain untouched');
});

scenario('RO-8: consecutive writes consume reply one at a time', () => {
    const h = createOutboxHarness();
    h.setGlobalReply({ chatId: 'c1', source: 'feishu', originalText: '' });
    h.maybeWriteOutbox('first', null);
    h.maybeWriteOutbox('second', null);
    assert.strictEqual(h.writtenEntries.length, 1, 'second call no-op after reply consumed');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 3: consumeIdeQueueFile — routing + recovery filter
// ═══════════════════════════════════════════════════════════════

function createIdeQueueHarness() {
    const sessions = new Map();
    let activeSessionKey = null;
    const enqueuedMessages = [];

    function createSession(key, hasTrigger) {
        const session = {
            key, triggerData: hasTrigger ? { trigger_id: 'trig-' + key } : null,
            messages: [],
        };
        sessions.set(key, session);
        return session;
    }

    function findNextPendingSession() {
        for (const s of sessions.values()) {
            if (s.triggerData && s.triggerData.trigger_id) return s;
        }
        return null;
    }

    function consumeIdeQueueFile(lines, isRecovery, extensionActivatedAt) {
        let count = 0;
        let stale = 0;
        for (const line of lines) {
            const item = JSON.parse(line);
            if (!item.text) continue;
            if (!isRecovery && item.ts && new Date(item.ts).getTime() < extensionActivatedAt) {
                stale++;
                continue;
            }
            const activeSession = activeSessionKey ? sessions.get(activeSessionKey) : null;
            const preferActive = activeSession && activeSession.triggerData;
            const pendingSession = preferActive ? activeSession : findNextPendingSession();
            const remoteSessionKey = pendingSession ? pendingSession.key : (activeSessionKey || '');
            enqueuedMessages.push({ text: item.text, sessionKey: remoteSessionKey, source: item.source });
            count++;
        }
        return { count, stale };
    }

    return {
        sessions, createSession, consumeIdeQueueFile, enqueuedMessages,
        setActiveSessionKey: (k) => { activeSessionKey = k; },
    };
}

scenario('IQ-1: recovery=true bypasses ts stale filter', () => {
    const h = createIdeQueueHarness();
    const extensionActivatedAt = fakeNow;
    const oldTs = new Date(fakeNow - 60000).toISOString();
    const lines = [JSON.stringify({ text: 'old msg', ts: oldTs, source: 'feishu' })];
    const result = h.consumeIdeQueueFile(lines, true, extensionActivatedAt);
    assert.strictEqual(result.count, 1);
    assert.strictEqual(result.stale, 0);
});

scenario('IQ-2: recovery=false filters stale messages', () => {
    const h = createIdeQueueHarness();
    const extensionActivatedAt = fakeNow;
    const oldTs = new Date(fakeNow - 60000).toISOString();
    const lines = [JSON.stringify({ text: 'old msg', ts: oldTs, source: 'feishu' })];
    const result = h.consumeIdeQueueFile(lines, false, extensionActivatedAt);
    assert.strictEqual(result.count, 0);
    assert.strictEqual(result.stale, 1);
});

scenario('IQ-3: fresh messages pass ts filter normally', () => {
    const h = createIdeQueueHarness();
    const extensionActivatedAt = fakeNow - 10000;
    const freshTs = new Date(fakeNow).toISOString();
    const lines = [JSON.stringify({ text: 'fresh', ts: freshTs, source: 'dingtalk' })];
    const result = h.consumeIdeQueueFile(lines, false, extensionActivatedAt);
    assert.strictEqual(result.count, 1);
});

scenario('IQ-4: routes to active session when it has pending trigger', () => {
    const h = createIdeQueueHarness();
    h.createSession('s1', true);
    h.createSession('s2', true);
    h.setActiveSessionKey('s1');
    const lines = [JSON.stringify({ text: 'msg', ts: new Date().toISOString(), source: 'feishu' })];
    h.consumeIdeQueueFile(lines, false, fakeNow - 10000);
    assert.strictEqual(h.enqueuedMessages[0].sessionKey, 's1');
});

scenario('IQ-5: routes to any pending session when active has no trigger', () => {
    const h = createIdeQueueHarness();
    h.createSession('s1', false);
    h.createSession('s2', true);
    h.setActiveSessionKey('s1');
    const lines = [JSON.stringify({ text: 'msg', ts: new Date().toISOString(), source: 'feishu' })];
    h.consumeIdeQueueFile(lines, false, fakeNow - 10000);
    assert.strictEqual(h.enqueuedMessages[0].sessionKey, 's2');
});

scenario('IQ-6: fallback to activeSessionKey when no pending sessions', () => {
    const h = createIdeQueueHarness();
    h.createSession('s1', false);
    h.setActiveSessionKey('s1');
    const lines = [JSON.stringify({ text: 'msg', ts: new Date().toISOString(), source: 'feishu' })];
    h.consumeIdeQueueFile(lines, false, fakeNow - 10000);
    assert.strictEqual(h.enqueuedMessages[0].sessionKey, 's1');
});

scenario('IQ-7: no sessions → empty sessionKey', () => {
    const h = createIdeQueueHarness();
    const lines = [JSON.stringify({ text: 'msg', ts: new Date().toISOString(), source: 'feishu' })];
    h.consumeIdeQueueFile(lines, false, fakeNow - 10000);
    assert.strictEqual(h.enqueuedMessages[0].sessionKey, '');
});

scenario('IQ-8: multiple lines processed in order', () => {
    const h = createIdeQueueHarness();
    h.createSession('s1', true);
    h.setActiveSessionKey('s1');
    const lines = [
        JSON.stringify({ text: 'first', ts: new Date().toISOString(), source: 'a' }),
        JSON.stringify({ text: 'second', ts: new Date().toISOString(), source: 'b' }),
        JSON.stringify({ text: 'third', ts: new Date().toISOString(), source: 'c' }),
    ];
    h.consumeIdeQueueFile(lines, false, fakeNow - 10000);
    assert.strictEqual(h.enqueuedMessages.length, 3);
    assert.strictEqual(h.enqueuedMessages[0].text, 'first');
    assert.strictEqual(h.enqueuedMessages[2].text, 'third');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 4: Dead-PID Cleanup with sessionId protection (S1 fix)
// ═══════════════════════════════════════════════════════════════

function createCleanupHarness() {
    const sessions = new Map();

    function createSession(key, mcpPid, sessionId) {
        sessions.set(key, { key, mcpPid, sessionId, triggerData: null, lastActiveAt: fakeNow });
    }

    /**
     * Simulates the dead-PID cleanup logic from checkTriggerFile (with S1 fix).
     * triggerData: the incoming trigger being routed.
     * triggerPid: PID of the MCP process that wrote the trigger.
     */
    function cleanDeadSessions(triggerData, triggerPid) {
        const triggerSessionId = triggerData.data && triggerData.data.session_id;
        const cleaned = [];
        for (const [sKey, s] of sessions) {
            if (s.mcpPid === 0 || s.mcpPid === triggerPid) continue;
            if (triggerSessionId && s.sessionId === triggerSessionId) continue;
            if (!isProcessAlive(s.mcpPid)) {
                cleaned.push(sKey);
            }
        }
        for (const key of cleaned) sessions.delete(key);
        return cleaned;
    }

    return { sessions, createSession, cleanDeadSessions };
}

scenario('DC-1: dead PID session gets cleaned', () => {
    const h = createCleanupHarness();
    setAlive(1111, false);
    setAlive(2222, true);
    h.createSession('old', 1111, 'uuid-old');
    const cleaned = h.cleanDeadSessions({ data: { session_id: 'uuid-new' } }, 2222);
    assert.deepStrictEqual(cleaned, ['old']);
    assert.strictEqual(h.sessions.size, 0);
});

scenario('DC-2: session with matching sessionId is PROTECTED from cleanup', () => {
    const h = createCleanupHarness();
    setAlive(1111, false);
    setAlive(2222, true);
    h.createSession('hop', 1111, 'uuid-same');
    const cleaned = h.cleanDeadSessions({ data: { session_id: 'uuid-same' } }, 2222);
    assert.deepStrictEqual(cleaned, []);
    assert.strictEqual(h.sessions.size, 1);
});

scenario('DC-3: mcpPid=0 (restored) sessions skip cleanup', () => {
    const h = createCleanupHarness();
    setAlive(2222, true);
    h.createSession('restored', 0, 'uuid-r');
    const cleaned = h.cleanDeadSessions({ data: { session_id: 'uuid-new' } }, 2222);
    assert.deepStrictEqual(cleaned, []);
});

scenario('DC-4: same PID as trigger → skip cleanup', () => {
    const h = createCleanupHarness();
    setAlive(2222, true);
    h.createSession('same-pid', 2222, 'uuid-s');
    const cleaned = h.cleanDeadSessions({ data: { session_id: 'uuid-new' } }, 2222);
    assert.deepStrictEqual(cleaned, []);
});

scenario('DC-5: multiple dead sessions, one protected by sessionId', () => {
    const h = createCleanupHarness();
    setAlive(1111, false);
    setAlive(3333, false);
    setAlive(5555, true);
    h.createSession('dead1', 1111, 'uuid-dead');
    h.createSession('protect', 3333, 'uuid-target');
    h.createSession('dead2', 1111, 'uuid-other');
    const cleaned = h.cleanDeadSessions({ data: { session_id: 'uuid-target' } }, 5555);
    assert.strictEqual(cleaned.length, 2);
    assert.ok(!cleaned.includes('protect'));
    assert.strictEqual(h.sessions.size, 1);
    assert.ok(h.sessions.has('protect'));
});

scenario('DC-6: alive PID sessions are never cleaned', () => {
    const h = createCleanupHarness();
    setAlive(1111, true);
    setAlive(2222, true);
    h.createSession('alive', 1111, 'uuid-a');
    const cleaned = h.cleanDeadSessions({ data: { session_id: 'uuid-new' } }, 2222);
    assert.deepStrictEqual(cleaned, []);
});

scenario('DC-7: no triggerSessionId → all dead PIDs cleaned (no protection)', () => {
    const h = createCleanupHarness();
    setAlive(1111, false);
    setAlive(2222, true);
    h.createSession('dead', 1111, 'uuid-x');
    const cleaned = h.cleanDeadSessions({ data: {} }, 2222);
    assert.deepStrictEqual(cleaned, ['dead']);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 5: MCP Status Detection
// ═══════════════════════════════════════════════════════════════

function createMcpStatusHarness() {
    const boundMcpPids = new Set();
    let mcpStatus = false;

    function checkMcpStatus(logAge) {
        let active = false;
        if (logAge !== null && logAge < 30000) {
            active = true;
        }
        if (!active) {
            for (const pid of boundMcpPids) {
                if (isProcessAlive(pid)) { active = true; break; }
            }
        }
        mcpStatus = active;
    }

    return { boundMcpPids, checkMcpStatus, getStatus: () => mcpStatus };
}

scenario('MS-1: recent log → active', () => {
    const h = createMcpStatusHarness();
    h.checkMcpStatus(5000);
    assert.strictEqual(h.getStatus(), true);
});

scenario('MS-2: old log + no alive PIDs → inactive', () => {
    const h = createMcpStatusHarness();
    h.checkMcpStatus(60000);
    assert.strictEqual(h.getStatus(), false);
});

scenario('MS-3: old log + alive PID → active', () => {
    const h = createMcpStatusHarness();
    setAlive(7777, true);
    h.boundMcpPids.add(7777);
    h.checkMcpStatus(60000);
    assert.strictEqual(h.getStatus(), true);
});

scenario('MS-4: no log (null) + dead PID → inactive', () => {
    const h = createMcpStatusHarness();
    setAlive(8888, false);
    h.boundMcpPids.add(8888);
    h.checkMcpStatus(null);
    assert.strictEqual(h.getStatus(), false);
});

scenario('MS-5: log at exactly 30s → inactive (boundary)', () => {
    const h = createMcpStatusHarness();
    h.checkMcpStatus(30000);
    assert.strictEqual(h.getStatus(), false);
});

scenario('MS-6: log at 29999ms → active (boundary)', () => {
    const h = createMcpStatusHarness();
    h.checkMcpStatus(29999);
    assert.strictEqual(h.getStatus(), true);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 6: Message Ordering — agent msg before queue consumption
// ═══════════════════════════════════════════════════════════════

function createOrderingHarness() {
    const sessions = new Map();
    const messageLog = [];

    function createSession(key) {
        const session = { key, triggerData: null, messages: [] };
        sessions.set(key, session);
        return session;
    }

    function addMessageToSession(sessionKey, msg) {
        const session = sessions.get(sessionKey);
        if (!session) return;
        session.messages.push(msg);
        messageLog.push({ sessionKey, ...msg });
    }

    /**
     * Simulates auto-consume: when a trigger arrives and queue has pending messages.
     * Critical: agent message MUST appear BEFORE user's queued message.
     */
    function autoConsumeWithAgentMsg(sessionKey, agentMsg, queueItem) {
        const session = sessions.get(sessionKey);
        if (!session) return;

        if (agentMsg) {
            addMessageToSession(sessionKey, { text: agentMsg, type: 'system' });
        }
        if (queueItem && !queueItem._displayed) {
            addMessageToSession(sessionKey, { text: queueItem.text, type: 'user' });
        }
        session.triggerData = null;
    }

    return { sessions, createSession, addMessageToSession, autoConsumeWithAgentMsg, messageLog };
}

scenario('MO-1: agent message appears before queued user message', () => {
    const h = createOrderingHarness();
    h.createSession('s1');
    const queueItem = { text: 'user question B', _displayed: false };
    h.autoConsumeWithAgentMsg('s1', 'Agent reply to A', queueItem);
    assert.strictEqual(h.messageLog.length, 2);
    assert.strictEqual(h.messageLog[0].type, 'system');
    assert.strictEqual(h.messageLog[0].text, 'Agent reply to A');
    assert.strictEqual(h.messageLog[1].type, 'user');
    assert.strictEqual(h.messageLog[1].text, 'user question B');
});

scenario('MO-2: no agent message → only user message shown', () => {
    const h = createOrderingHarness();
    h.createSession('s1');
    const queueItem = { text: 'user msg', _displayed: false };
    h.autoConsumeWithAgentMsg('s1', '', queueItem);
    assert.strictEqual(h.messageLog.length, 1);
    assert.strictEqual(h.messageLog[0].type, 'user');
});

scenario('MO-3: already displayed queue item → no duplicate', () => {
    const h = createOrderingHarness();
    h.createSession('s1');
    const queueItem = { text: 'already shown', _displayed: true };
    h.autoConsumeWithAgentMsg('s1', 'agent reply', queueItem);
    assert.strictEqual(h.messageLog.length, 1);
    assert.strictEqual(h.messageLog[0].type, 'system');
});

scenario('MO-4: multiple sequential auto-consumes maintain order', () => {
    const h = createOrderingHarness();
    h.createSession('s1');
    h.autoConsumeWithAgentMsg('s1', 'Reply 1', { text: 'Q2', _displayed: false });
    h.autoConsumeWithAgentMsg('s1', 'Reply 2', { text: 'Q3', _displayed: false });
    assert.strictEqual(h.messageLog.length, 4);
    assert.strictEqual(h.messageLog[0].text, 'Reply 1');
    assert.strictEqual(h.messageLog[1].text, 'Q2');
    assert.strictEqual(h.messageLog[2].text, 'Reply 2');
    assert.strictEqual(h.messageLog[3].text, 'Q3');
});

scenario('MO-5: agent message + no queue item → only agent shown', () => {
    const h = createOrderingHarness();
    h.createSession('s1');
    h.autoConsumeWithAgentMsg('s1', 'standalone reply', null);
    assert.strictEqual(h.messageLog.length, 1);
    assert.strictEqual(h.messageLog[0].text, 'standalone reply');
});

// ═══════════════════════════════════════════════════════════════
// SECTION 7: Queue send behavior — no display when no trigger
// (Validates the fix that prevents out-of-order display)
// ═══════════════════════════════════════════════════════════════

function createSendBehaviorHarness() {
    const sessions = new Map();
    const messageQueue = [];
    const webviewMessages = [];
    let _idCounter = 0;

    function createSession(key, hasTrigger) {
        const session = { key, triggerData: hasTrigger ? { trigger_id: 'trig-' + key } : null, messages: [] };
        sessions.set(key, session);
        return session;
    }

    function enqueueMessage(text, sessionKey) {
        const item = { id: ++_idCounter, text, sessionKey, status: 'pending', _displayed: false };
        messageQueue.push(item);
        return item;
    }

    /**
     * Simulates the fixed case 'send' behavior:
     * - If trigger active → processQueue (immediate consume)
     * - If no trigger → queue only, NO display to webview
     */
    function handleSend(text, sessionKey) {
        const session = sessions.get(sessionKey);
        const item = enqueueMessage(text, sessionKey);

        const trigger = session ? session.triggerData : null;
        if (trigger && trigger.trigger_id) {
            webviewMessages.push({ text, type: 'user', source: 'processQueue' });
            item._displayed = true;
            session.triggerData = null;
        }
        // else: NO webview message — this is the critical fix
        return item;
    }

    return { sessions, createSession, handleSend, messageQueue, webviewMessages };
}

scenario('SB-1: send with trigger → message shown in webview', () => {
    const h = createSendBehaviorHarness();
    h.createSession('s1', true);
    h.handleSend('with trigger', 's1');
    assert.strictEqual(h.webviewMessages.length, 1);
    assert.strictEqual(h.webviewMessages[0].text, 'with trigger');
});

scenario('SB-2: send without trigger → NO message in webview', () => {
    const h = createSendBehaviorHarness();
    h.createSession('s1', false);
    h.handleSend('no trigger', 's1');
    assert.strictEqual(h.webviewMessages.length, 0);
});

scenario('SB-3: send without trigger → message stays in queue as pending', () => {
    const h = createSendBehaviorHarness();
    h.createSession('s1', false);
    const item = h.handleSend('queued', 's1');
    assert.strictEqual(item.status, 'pending');
    assert.strictEqual(item._displayed, false);
});

scenario('SB-4: multiple sends without trigger → none shown in webview', () => {
    const h = createSendBehaviorHarness();
    h.createSession('s1', false);
    for (let i = 0; i < 5; i++) {
        h.handleSend(`msg-${i}`, 's1');
    }
    assert.strictEqual(h.webviewMessages.length, 0);
    assert.strictEqual(h.messageQueue.length, 5);
});

scenario('SB-5: first send consumes trigger, second goes to queue only', () => {
    const h = createSendBehaviorHarness();
    h.createSession('s1', true);
    h.handleSend('first', 's1');
    h.handleSend('second', 's1');
    assert.strictEqual(h.webviewMessages.length, 1);
    assert.strictEqual(h.webviewMessages[0].text, 'first');
    assert.strictEqual(h.messageQueue[1]._displayed, false);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 8: End-to-End Daily Usage Flows
// ═══════════════════════════════════════════════════════════════

function createE2EHarness() {
    const sessions = new Map();
    let activeSessionKey = null;
    let sessionCounter = 0;
    const messageQueue = [];
    const responseFiles = [];
    const webviewLog = [];
    let _idCounter = 0;

    function createSession(mcpPid, sessionId) {
        sessionCounter++;
        const key = `${mcpPid}_${fakeNow}_${sessionCounter}`;
        const session = {
            key, mcpPid, sessionId,
            triggerData: null, messages: [], draft: '',
            lastActiveAt: fakeNow, pendingRemoteReply: null,
        };
        sessions.set(key, session);
        activeSessionKey = key;
        return session;
    }

    function enqueueMessage(text, sessionKey) {
        const item = { id: ++_idCounter, text, sessionKey, status: 'pending', _displayed: false };
        messageQueue.push(item);
        return item;
    }

    function dequeueMessage(sessionKey) {
        const idx = messageQueue.findIndex(m => m.status === 'pending' && m.sessionKey === sessionKey);
        if (idx === -1) return null;
        messageQueue[idx].status = 'processing';
        return messageQueue[idx];
    }

    function markDone(id) {
        const idx = messageQueue.findIndex(m => m.id === id);
        if (idx !== -1) messageQueue.splice(idx, 1);
    }

    function writeResponse(triggerId, text) {
        responseFiles.push({ triggerId, text, ts: fakeNow });
    }

    // Simulates full trigger arrival → process
    function triggerArrives(session, triggerId, agentMessage) {
        session.triggerData = { trigger_id: triggerId, message: agentMessage };
        session.lastActiveAt = fakeNow;
        if (agentMessage) {
            session.messages.push({ text: agentMessage, type: 'system' });
            webviewLog.push({ type: 'system', text: agentMessage, sessionKey: session.key });
        }
        // Auto-consume if queue has pending
        const pending = messageQueue.find(m => m.status === 'pending' && m.sessionKey === session.key);
        if (pending) {
            pending.status = 'processing';
            if (!pending._displayed) {
                session.messages.push({ text: pending.text, type: 'user' });
                webviewLog.push({ type: 'user', text: pending.text, sessionKey: session.key });
            }
            writeResponse(triggerId, pending.text);
            markDone(pending.id);
            session.triggerData = null;
            return { autoConsumed: true, text: pending.text };
        }
        webviewLog.push({ type: 'triggerWaiting', triggerId, sessionKey: session.key });
        return { autoConsumed: false };
    }

    // Simulates user typing + send while trigger is active
    function userReplies(session, text) {
        if (!session.triggerData) {
            enqueueMessage(text, session.key);
            return { queued: true, consumed: false };
        }
        const triggerId = session.triggerData.trigger_id;
        session.messages.push({ text, type: 'user' });
        webviewLog.push({ type: 'user', text, sessionKey: session.key });
        writeResponse(triggerId, text);
        session.triggerData = null;
        return { queued: false, consumed: true };
    }

    function switchSession(key) {
        activeSessionKey = key;
    }

    function getSession(key) { return sessions.get(key); }
    function getPendingCount(sessionKey) {
        return messageQueue.filter(m => m.status === 'pending' && m.sessionKey === sessionKey).length;
    }

    return {
        sessions, createSession, enqueueMessage, triggerArrives, userReplies,
        switchSession, getSession, getPendingCount, webviewLog, responseFiles,
        messageQueue, activeSessionKey: () => activeSessionKey,
    };
}

// E2E-1: Normal flow — trigger arrives, user replies directly
scenario('E2E-1: AI sends trigger → user replies → response written', () => {
    const h = createE2EHarness();
    setAlive(9999, true);
    const s = h.createSession(9999, 'uuid-1');

    const result = h.triggerArrives(s, 't1', '请确认代码变更');
    assert.strictEqual(result.autoConsumed, false);
    assert.strictEqual(s.messages.length, 1);
    assert.strictEqual(s.messages[0].text, '请确认代码变更');

    const reply = h.userReplies(s, 'LGTM');
    assert.strictEqual(reply.consumed, true);
    assert.strictEqual(h.responseFiles.length, 1);
    assert.strictEqual(h.responseFiles[0].text, 'LGTM');
    assert.strictEqual(s.triggerData, null);
});

// E2E-2: User types first, trigger arrives later → auto-consume
scenario('E2E-2: User types before trigger → auto-consumed on arrival', () => {
    const h = createE2EHarness();
    setAlive(9999, true);
    const s = h.createSession(9999, 'uuid-1');

    h.userReplies(s, '先输入的内容');
    assert.strictEqual(h.getPendingCount(s.key), 1);
    assert.strictEqual(s.triggerData, null);

    const result = h.triggerArrives(s, 't1', 'Agent 消息');
    assert.strictEqual(result.autoConsumed, true);
    assert.strictEqual(result.text, '先输入的内容');
    assert.strictEqual(h.responseFiles.length, 1);
    assert.strictEqual(h.responseFiles[0].text, '先输入的内容');
    assert.strictEqual(s.messages[0].text, 'Agent 消息');
    assert.strictEqual(s.messages[1].text, '先输入的内容');
});

// E2E-3: Multiple questions queued → triggers consume in order
scenario('E2E-3: 3 questions queued → consumed one-by-one in FIFO order', () => {
    const h = createE2EHarness();
    setAlive(9999, true);
    const s = h.createSession(9999, 'uuid-1');

    h.userReplies(s, 'Q1');
    h.userReplies(s, 'Q2');
    h.userReplies(s, 'Q3');
    assert.strictEqual(h.getPendingCount(s.key), 3);

    h.triggerArrives(s, 't1', 'Reply to prev');
    assert.strictEqual(h.responseFiles[0].text, 'Q1');
    h.triggerArrives(s, 't2', 'Reply2');
    assert.strictEqual(h.responseFiles[1].text, 'Q2');
    h.triggerArrives(s, 't3', 'Reply3');
    assert.strictEqual(h.responseFiles[2].text, 'Q3');
    assert.strictEqual(h.getPendingCount(s.key), 0);
});

// E2E-4: Message ordering in session.messages is correct
scenario('E2E-4: Message order: agent→user→agent→user (alternating)', () => {
    const h = createE2EHarness();
    setAlive(9999, true);
    const s = h.createSession(9999, 'uuid-1');

    h.triggerArrives(s, 't1', 'A1');
    h.userReplies(s, 'U1');
    h.triggerArrives(s, 't2', 'A2');
    h.userReplies(s, 'U2');

    assert.strictEqual(s.messages.length, 4);
    assert.strictEqual(s.messages[0].text, 'A1');
    assert.strictEqual(s.messages[0].type, 'system');
    assert.strictEqual(s.messages[1].text, 'U1');
    assert.strictEqual(s.messages[1].type, 'user');
    assert.strictEqual(s.messages[2].text, 'A2');
    assert.strictEqual(s.messages[3].text, 'U2');
});

// E2E-5: Tab switch doesn't lose messages
scenario('E2E-5: Switch tabs → messages preserved per session', () => {
    const h = createE2EHarness();
    setAlive(9999, true);
    const s1 = h.createSession(9999, 'uuid-1');
    const s2 = h.createSession(9999, 'uuid-2');

    h.triggerArrives(s1, 't1', 'Msg for S1');
    h.userReplies(s1, 'Reply S1');
    h.triggerArrives(s2, 't2', 'Msg for S2');
    h.userReplies(s2, 'Reply S2');

    h.switchSession(s1.key);
    assert.strictEqual(h.getSession(s1.key).messages.length, 2);
    assert.strictEqual(h.getSession(s1.key).messages[0].text, 'Msg for S1');

    h.switchSession(s2.key);
    assert.strictEqual(h.getSession(s2.key).messages.length, 2);
    assert.strictEqual(h.getSession(s2.key).messages[0].text, 'Msg for S2');
});

// E2E-6: Multi-tab isolation — trigger only consumed by its session
scenario('E2E-6: Trigger for S1 does not touch S2 queue', () => {
    const h = createE2EHarness();
    setAlive(9999, true);
    const s1 = h.createSession(9999, 'uuid-1');
    const s2 = h.createSession(9999, 'uuid-2');

    h.userReplies(s1, 'S1 question');
    h.userReplies(s2, 'S2 question');

    h.triggerArrives(s1, 't1', 'Reply to S1');
    assert.strictEqual(h.responseFiles[0].text, 'S1 question');
    assert.strictEqual(h.getPendingCount(s2.key), 1, 'S2 untouched');
});

// E2E-7: Draft preserved across tab switch
scenario('E2E-7: Draft preserved when switching tabs', () => {
    const h = createE2EHarness();
    setAlive(9999, true);
    const s1 = h.createSession(9999, 'uuid-1');
    const s2 = h.createSession(9999, 'uuid-2');

    s1.draft = '正在输入...';
    h.switchSession(s2.key);
    h.switchSession(s1.key);
    assert.strictEqual(h.getSession(s1.key).draft, '正在输入...');
});

// E2E-8: Trigger with empty message → no system message added
scenario('E2E-8: Trigger with empty message → no system msg, just waiting', () => {
    const h = createE2EHarness();
    setAlive(9999, true);
    const s = h.createSession(9999, 'uuid-1');

    const result = h.triggerArrives(s, 't1', '');
    assert.strictEqual(result.autoConsumed, false);
    assert.strictEqual(s.messages.length, 0);
    assert.strictEqual(s.triggerData.trigger_id, 't1');
});

// E2E-9: Rapid trigger-reply cycle (simulates fast AI conversation)
scenario('E2E-9: 10 rapid trigger-reply cycles', () => {
    const h = createE2EHarness();
    setAlive(9999, true);
    const s = h.createSession(9999, 'uuid-1');

    for (let i = 0; i < 10; i++) {
        h.triggerArrives(s, `t${i}`, `Agent ${i}`);
        h.userReplies(s, `User ${i}`);
    }
    assert.strictEqual(s.messages.length, 20);
    assert.strictEqual(h.responseFiles.length, 10);
    for (let i = 0; i < 10; i++) {
        assert.strictEqual(s.messages[i * 2].text, `Agent ${i}`);
        assert.strictEqual(s.messages[i * 2 + 1].text, `User ${i}`);
    }
});

// E2E-10: Queue + direct reply mixed (user queues, then replies directly on next trigger)
scenario('E2E-10: Queued msg auto-consumed, then direct reply on next trigger', () => {
    const h = createE2EHarness();
    setAlive(9999, true);
    const s = h.createSession(9999, 'uuid-1');

    h.userReplies(s, 'Pre-queued');
    h.triggerArrives(s, 't1', 'First agent msg');
    assert.strictEqual(h.responseFiles[0].text, 'Pre-queued');

    h.triggerArrives(s, 't2', 'Second agent msg');
    h.userReplies(s, 'Direct reply');
    assert.strictEqual(h.responseFiles[1].text, 'Direct reply');
    assert.strictEqual(s.messages.length, 4);
});

// E2E-11: Session restore after reload — messages survive
scenario('E2E-11: Session messages survive simulated reload', () => {
    const h = createE2EHarness();
    setAlive(9999, true);
    const s = h.createSession(9999, 'uuid-1');

    h.triggerArrives(s, 't1', 'Before reload');
    h.userReplies(s, 'User msg');

    // Simulate reload: session persisted with messages, restored with mcpPid=0
    const savedMessages = [...s.messages];
    const savedSessionId = s.sessionId;
    const savedKey = s.key;

    // Clear and restore
    h.sessions.clear();
    const restored = { key: savedKey, mcpPid: 0, sessionId: savedSessionId,
        triggerData: null, messages: savedMessages, draft: '', lastActiveAt: fakeNow };
    h.sessions.set(savedKey, restored);

    assert.strictEqual(restored.messages.length, 2);
    assert.strictEqual(restored.messages[0].text, 'Before reload');
    assert.strictEqual(restored.messages[1].text, 'User msg');
    assert.strictEqual(restored.mcpPid, 0);
});

// E2E-12: MCP restart (PID hop) — new trigger rebinds session
scenario('E2E-12: MCP PID change → session rebound, history preserved', () => {
    const h = createE2EHarness();
    setAlive(1111, true);
    const s = h.createSession(1111, 'uuid-1');

    h.triggerArrives(s, 't1', 'Old PID msg');
    h.userReplies(s, 'Reply');

    // MCP restarts with new PID
    setAlive(1111, false);
    setAlive(2222, true);
    s.mcpPid = 2222; // simulates getOrCreateSessionForTrigger rebinding

    h.triggerArrives(s, 't2', 'New PID msg');
    h.userReplies(s, 'Reply 2');

    assert.strictEqual(s.mcpPid, 2222);
    assert.strictEqual(s.messages.length, 4);
    assert.strictEqual(h.responseFiles.length, 2);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 9: syncToWebview sessionKey filtering (Issue #3)
// ═══════════════════════════════════════════════════════════════

function createSyncFilterHarness() {
    let messageQueue = [];
    let _activeSessionKey = '';
    let _idCounter = 0;
    let lastSyncedItems = null;

    function postToWebview(msg) {
        if (msg.command === 'syncQueue') {
            lastSyncedItems = msg.items;
        }
    }

    function syncToWebview(sessionKey) {
        const filterKey = sessionKey !== undefined ? sessionKey : _activeSessionKey;
        let items = messageQueue.filter(m => (m.status === 'pending' || m.status === 'processing') && !m._displayed);
        if (filterKey) {
            items = items.filter(m => m.sessionKey === filterKey);
        } else {
            items = items.filter(m => !m.sessionKey);
        }
        postToWebview({ command: 'syncQueue', items, pendingCount: items.filter(m => m.status === 'pending').length });
    }

    function enqueueMessage(text, meta) {
        const item = {
            id: ++_idCounter,
            text,
            status: 'pending',
            sessionKey: (meta?.sessionKey != null ? meta.sessionKey : _activeSessionKey) || '',
        };
        messageQueue.push(item);
        syncToWebview(item.sessionKey);
        return item;
    }

    function editQueueItem(id, newText) {
        const item = messageQueue.find(m => m.id === id && m.status === 'pending');
        if (item) {
            item.text = newText;
            syncToWebview(item.sessionKey);
        }
    }

    function enqueueMessageBroken(text, meta) {
        const item = {
            id: ++_idCounter,
            text,
            status: 'pending',
            sessionKey: (meta?.sessionKey != null ? meta.sessionKey : _activeSessionKey) || '',
        };
        messageQueue.push(item);
        syncToWebview(); // BUG: no sessionKey passed
        return item;
    }

    return {
        enqueueMessage, enqueueMessageBroken, editQueueItem, syncToWebview,
        setActiveSessionKey: (k) => { _activeSessionKey = k; },
        getLastSynced: () => lastSyncedItems,
        get queue() { return messageQueue; },
    };
}

scenario('SF-1: enqueue with sessionKey → synced items include the new message', () => {
    const h = createSyncFilterHarness();
    h.enqueueMessage('hello', { sessionKey: 'sess_1' });
    const synced = h.getLastSynced();
    assert.strictEqual(synced.length, 1);
    assert.strictEqual(synced[0].text, 'hello');
    assert.strictEqual(synced[0].sessionKey, 'sess_1');
});

scenario('SF-2: old broken enqueue (no sessionKey arg) → message filtered out when _activeSessionKey empty', () => {
    const h = createSyncFilterHarness();
    h.enqueueMessageBroken('invisible', { sessionKey: 'sess_1' });
    const synced = h.getLastSynced();
    assert.strictEqual(synced.length, 0, 'broken enqueue should filter out message');
});

scenario('SF-3: enqueue multiple messages → all visible for same session', () => {
    const h = createSyncFilterHarness();
    h.enqueueMessage('msg1', { sessionKey: 'sess_1' });
    h.enqueueMessage('msg2', { sessionKey: 'sess_1' });
    h.enqueueMessage('msg3', { sessionKey: 'sess_1' });
    const synced = h.getLastSynced();
    assert.strictEqual(synced.length, 3);
});

scenario('SF-4: enqueue for different sessions → only matching session items synced', () => {
    const h = createSyncFilterHarness();
    h.enqueueMessage('for-s1', { sessionKey: 'sess_1' });
    h.enqueueMessage('for-s2', { sessionKey: 'sess_2' });
    const synced = h.getLastSynced();
    assert.strictEqual(synced.length, 1);
    assert.strictEqual(synced[0].sessionKey, 'sess_2');
});

scenario('SF-5: editQueueItem → UI refreshes with correct session filter', () => {
    const h = createSyncFilterHarness();
    const item = h.enqueueMessage('original', { sessionKey: 'sess_1' });
    h.editQueueItem(item.id, 'edited');
    const synced = h.getLastSynced();
    assert.strictEqual(synced.length, 1);
    assert.strictEqual(synced[0].text, 'edited');
});

scenario('SF-6: enqueue without meta.sessionKey falls back to _activeSessionKey', () => {
    const h = createSyncFilterHarness();
    h.setActiveSessionKey('active_sess');
    h.enqueueMessage('fallback msg', {});
    const synced = h.getLastSynced();
    assert.strictEqual(synced.length, 1);
    assert.strictEqual(synced[0].sessionKey, 'active_sess');
});

// ═══════════════════════════════════════════════════════════════
// QM: Queue Migration across PIDs (unit-level, file-system tests)
// ═══════════════════════════════════════════════════════════════

const qmTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-qm-test-'));
const qmWorkspaceSlug = 'rs_user_work_cursor_cursor_feedback_gate';

function writeOldPidQueueFile(pid, items) {
    const filePath = path.join(qmTmpDir, `feedback_gate_queue_${qmWorkspaceSlug}_pid${pid}.json`);
    fs.writeFileSync(filePath, JSON.stringify({ items }));
    return filePath;
}

function clearQmTmpDir() {
    for (const f of fs.readdirSync(qmTmpDir)) {
        try { fs.unlinkSync(path.join(qmTmpDir, f)); } catch {}
    }
}

function freshQueueModule(fakePid) {
    const modulePath = require.resolve('../queue-manager.js');
    delete require.cache[modulePath];
    const utilsPath = require.resolve('../utils.js');
    const origGetTempPath = require(utilsPath).getTempPath;
    require(utilsPath).getTempPath = (f) => path.join(qmTmpDir, f);

    const origPid = process.pid;
    Object.defineProperty(process, 'pid', { value: fakePid, writable: true, configurable: true });

    const qm = require(modulePath);
    const mockVscode = {
        workspace: { workspaceFolders: [{ uri: { fsPath: `/Users/user/work/cursor/cursor-feedback-gate` } }] },
    };
    let lastSync = null;
    qm.init(mockVscode, (msg) => { if (msg.command === 'syncQueue') lastSync = msg; });

    function cleanup() {
        Object.defineProperty(process, 'pid', { value: origPid, writable: true, configurable: true });
        require(utilsPath).getTempPath = origGetTempPath;
        delete require.cache[modulePath];
    }
    return { qm, lastSync: () => lastSync, cleanup };
}

scenario('QM-1: loadQueue migrates pending messages from old PID files', () => {
    clearQmTmpDir();
    writeOldPidQueueFile(99990, [
        { id: 1, text: 'old msg 1', status: 'pending', sessionKey: 'old_sess', timestamp: new Date().toISOString() },
        { id: 2, text: 'old msg 2', status: 'pending', sessionKey: '', timestamp: new Date().toISOString() },
    ]);
    const { qm, cleanup } = freshQueueModule(99991);
    try {
        qm.loadQueue();
        const count = qm.getPendingQueueCount('');
        assert.strictEqual(count, 2, 'both messages migrated with cleared sessionKey');
        const oldFile = path.join(qmTmpDir, `feedback_gate_queue_${qmWorkspaceSlug}_pid99990.json`);
        assert.ok(!fs.existsSync(oldFile), 'old PID file should be deleted');
    } finally { cleanup(); }
});

scenario('QM-2: old PID file with done items — only pending/processing migrated', () => {
    clearQmTmpDir();
    writeOldPidQueueFile(99992, [
        { id: 1, text: 'done msg', status: 'done', sessionKey: '' },
        { id: 2, text: 'pending msg', status: 'pending', sessionKey: 'sess_x' },
        { id: 3, text: 'processing msg', status: 'processing', sessionKey: '', processingAt: Date.now() },
    ]);
    const { qm, cleanup } = freshQueueModule(99993);
    try {
        qm.loadQueue();
        assert.strictEqual(qm.getPendingQueueCount(''), 2, 'pending + processing migrated, done skipped');
    } finally { cleanup(); }
});

scenario('QM-3: multiple old PID files merged', () => {
    clearQmTmpDir();
    writeOldPidQueueFile(88880, [{ id: 1, text: 'file1', status: 'pending', sessionKey: 'a' }]);
    writeOldPidQueueFile(88881, [{ id: 2, text: 'file2', status: 'pending', sessionKey: 'b' }]);
    const { qm, cleanup } = freshQueueModule(88882);
    try {
        qm.loadQueue();
        assert.strictEqual(qm.getPendingQueueCount(''), 2, 'messages from both old files merged');
    } finally { cleanup(); }
});

scenario('QM-4: migrated messages have sessionKey cleared + _prevSessionKey set', () => {
    clearQmTmpDir();
    writeOldPidQueueFile(77770, [{ id: 1, text: 'tagged', status: 'pending', sessionKey: 'old_sk' }]);
    const { qm, cleanup } = freshQueueModule(77771);
    try {
        qm.loadQueue();
        const item = qm.dequeueMessage('');
        assert.ok(item, 'item dequeued with empty sessionKey');
        assert.strictEqual(item.sessionKey, '', 'sessionKey cleared');
        assert.strictEqual(item._prevSessionKey, 'old_sk', '_prevSessionKey preserved');
    } finally { cleanup(); }
});

scenario('QM-5: no old PID files — loadQueue works normally', () => {
    clearQmTmpDir();
    const { qm, cleanup } = freshQueueModule(66660);
    try {
        qm.loadQueue();
        assert.strictEqual(qm.getPendingQueueCount(''), 0);
    } finally { cleanup(); }
});

scenario('QM-6: reload keeps session tags on own-PID queue file (E2)', () => {
    clearQmTmpDir();
    writeOldPidQueueFile(66670, [
        { id: 1, text: 'tagged survives reload', status: 'pending', sessionKey: 'sess_alive' },
        { id: 2, text: 'untagged stays', status: 'pending', sessionKey: '' },
    ]);
    const { qm, cleanup } = freshQueueModule(66670);
    try {
        qm.loadQueue();
        assert.strictEqual(qm.getPendingQueueCount('sess_alive'), 1, 'tagged item keeps its session across reload');
        assert.strictEqual(qm.getPendingQueueCount(''), 1, 'untagged item stays untagged');
    } finally { cleanup(); }
});

scenario('QM-7: migrateOrphanSessionKeys de-tags only vanished sessions (E2)', () => {
    clearQmTmpDir();
    writeOldPidQueueFile(66680, [
        { id: 1, text: 'live', status: 'pending', sessionKey: 'sess_alive' },
        { id: 2, text: 'gone', status: 'pending', sessionKey: 'sess_gone' },
    ]);
    const { qm, cleanup } = freshQueueModule(66680);
    try {
        qm.loadQueue();
        assert.strictEqual(qm.getPendingQueueCount('sess_gone'), 1, 'tags intact right after load');
        qm.migrateOrphanSessionKeys(new Set(['sess_alive']));
        assert.strictEqual(qm.getPendingQueueCount('sess_alive'), 1, 'live session keeps its message');
        assert.strictEqual(qm.getPendingQueueCount('sess_gone'), 0, 'orphan tag dropped');
        assert.strictEqual(qm.getPendingQueueCount(''), 1, 'orphan message now in untagged pool');
    } finally { cleanup(); }
});

try { fs.rmSync(qmTmpDir, { recursive: true }); } catch {}

// ═══════════════════════════════════════════════════════════════
// AD: Adoption recency (N4) — long-idle sessions must not be resurrected
// ═══════════════════════════════════════════════════════════════

function createAdoptionHarness() {
    // Mirrors getOrCreateSessionForTrigger / _tryAdoptUnboundSession in extension.js
    const ADOPT_STALE_TRIGGER_MS = 15 * 60 * 1000;
    const ADOPT_MAX_SESSION_AGE_MS = 60 * 60 * 1000;

    // Decision when a trigger arrives with an UNKNOWN sessionId and exactly one
    // existing session: adopt the sole session or create a new one.
    function decideAdoption(onlySession, incomingSessionId, now) {
        const hasDifferentActiveSession = onlySession.sessionId && onlySession.sessionId !== incomingSessionId
            && onlySession.triggerData && (now - onlySession.lastActiveAt) < ADOPT_STALE_TRIGGER_MS;
        const sessionTooOld = (now - onlySession.lastActiveAt) > ADOPT_MAX_SESSION_AGE_MS;
        if (hasDifferentActiveSession || sessionTooOld) return 'create';
        const triggerStale = onlySession.triggerData && (now - onlySession.lastActiveAt) > ADOPT_STALE_TRIGGER_MS;
        if (!onlySession.triggerData || triggerStale) return 'adopt';
        return 'create';
    }

    // Mirrors _tryAdoptUnboundSession for triggers WITHOUT session_id.
    function decideUnboundAdopt(onlySession, now) {
        if (onlySession.triggerData && (now - onlySession.lastActiveAt) < ADOPT_STALE_TRIGGER_MS) return false;
        if ((now - onlySession.lastActiveAt) > ADOPT_MAX_SESSION_AGE_MS) return false;
        return true;
    }

    return { decideAdoption, decideUnboundAdopt };
}

scenario('AD-1: recent sole session is adopted on context compaction (new sessionId)', () => {
    const h = createAdoptionHarness();
    const now = Date.now();
    const s = { sessionId: 'old-uuid', triggerData: null, lastActiveAt: now - 5 * 60 * 1000 };
    assert.strictEqual(h.decideAdoption(s, 'new-uuid', now), 'adopt');
});

scenario('AD-2: sole session idle >1h → new session created, old conversation not resurrected', () => {
    const h = createAdoptionHarness();
    const now = Date.now();
    const s = { sessionId: 'old-uuid', triggerData: null, lastActiveAt: now - 61 * 60 * 1000 };
    assert.strictEqual(h.decideAdoption(s, 'new-uuid', now), 'create');
});

scenario('AD-3: boundary — session idle for exactly 1h is still adoptable', () => {
    const h = createAdoptionHarness();
    const now = Date.now();
    const s = { sessionId: 'old-uuid', triggerData: null, lastActiveAt: now - 60 * 60 * 1000 };
    assert.strictEqual(h.decideAdoption(s, 'new-uuid', now), 'adopt');
});

scenario('AD-4: unbound restored session idle >1h is NOT bound to a no-sessionId trigger', () => {
    const h = createAdoptionHarness();
    const now = Date.now();
    const s = { triggerData: null, lastActiveAt: now - 2 * 60 * 60 * 1000 };
    assert.strictEqual(h.decideUnboundAdopt(s, now), false);
});

scenario('AD-5: recently restored unbound session is still bound', () => {
    const h = createAdoptionHarness();
    const now = Date.now();
    const s = { triggerData: null, lastActiveAt: now - 10 * 60 * 1000 };
    assert.strictEqual(h.decideUnboundAdopt(s, now), true);
});

scenario('AD-6: sole session with a different ACTIVE conversation stays protected', () => {
    const h = createAdoptionHarness();
    const now = Date.now();
    const s = { sessionId: 'other-uuid', triggerData: { trigger_id: 't1' }, lastActiveAt: now - 60 * 1000 };
    assert.strictEqual(h.decideAdoption(s, 'new-uuid', now), 'create');
});

// ═══════════════════════════════════════════════════════════════
// CL: Close-session guard feedback (N6)
// ═══════════════════════════════════════════════════════════════

function decideClose(session, now) {
    // Mirrors closeSessionByKey in extension.js. Returns { allowed, warned }.
    if (session.triggerData) {
        const triggerAge = now - session.lastActiveAt;
        if (triggerAge < 2 * 60 * 1000) {
            return { allowed: false, warned: true };
        }
    }
    return { allowed: true, warned: false };
}

scenario('CL-1: closing a session with a fresh trigger is blocked WITH a warning', () => {
    const now = Date.now();
    const r = decideClose({ triggerData: { trigger_id: 't' }, lastActiveAt: now - 30 * 1000 }, now);
    assert.strictEqual(r.allowed, false);
    assert.strictEqual(r.warned, true, 'user must be told why the close failed');
});

scenario('CL-2: closing a session with a stale (>2min) trigger is allowed', () => {
    const now = Date.now();
    const r = decideClose({ triggerData: { trigger_id: 't' }, lastActiveAt: now - 3 * 60 * 1000 }, now);
    assert.strictEqual(r.allowed, true);
});

scenario('CL-3: closing a session without a trigger is allowed silently', () => {
    const r = decideClose({ triggerData: null, lastActiveAt: Date.now() }, Date.now());
    assert.strictEqual(r.allowed, true);
    assert.strictEqual(r.warned, false);
});

// ═══════════════════════════════════════════════════════════════
// LW: Session lease arbitration (N1/N3/C3 — multi-window ownership)
// ═══════════════════════════════════════════════════════════════

const lwTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-lw-test-'));

function freshLeaseModule() {
    const modulePath = require.resolve('../session-lease.js');
    delete require.cache[modulePath];
    const utilsPath = require.resolve('../utils.js');
    const origGetTempPath = require(utilsPath).getTempPath;
    require(utilsPath).getTempPath = (f) => path.join(lwTmpDir, f);
    const lease = require(modulePath);
    const cleanup = () => {
        require(utilsPath).getTempPath = origGetTempPath;
        delete require.cache[modulePath];
    };
    return { lease, cleanup };
}

function clearLwTmpDir() {
    for (const f of fs.readdirSync(lwTmpDir)) {
        try { fs.unlinkSync(path.join(lwTmpDir, f)); } catch {}
    }
}

const LW_MY_PID = process.pid;
const LW_OTHER_PID = 987654;

scenario('LW-1: fresh lease held by another LIVE window → defer', () => {
    clearLwTmpDir();
    const { lease, cleanup } = freshLeaseModule();
    try {
        lease._setAliveProbe((pid) => pid === LW_OTHER_PID);
        lease.writeLease('sid-1', LW_OTHER_PID, 'key_a');
        assert.strictEqual(lease.isHeldElsewhere('sid-1', LW_MY_PID), true);
    } finally { lease._setAliveProbe(null); cleanup(); }
});

scenario('LW-2: lease held by a DEAD window → claimable', () => {
    clearLwTmpDir();
    const { lease, cleanup } = freshLeaseModule();
    try {
        lease._setAliveProbe(() => false);
        lease.writeLease('sid-2', LW_OTHER_PID, 'key_a');
        assert.strictEqual(lease.isHeldElsewhere('sid-2', LW_MY_PID), false);
    } finally { lease._setAliveProbe(null); cleanup(); }
});

scenario('LW-3: stale lease (>60s) → claimable even if holder alive', () => {
    clearLwTmpDir();
    const { lease, cleanup } = freshLeaseModule();
    try {
        lease._setAliveProbe(() => true);
        lease.writeLease('sid-3', LW_OTHER_PID, 'key_a');
        const staleNow = Date.now() + lease.LEASE_MAX_AGE_MS + 1000;
        assert.strictEqual(lease.isHeldElsewhere('sid-3', LW_MY_PID, staleNow), false);
    } finally { lease._setAliveProbe(null); cleanup(); }
});

scenario('LW-4: own lease → not held elsewhere', () => {
    clearLwTmpDir();
    const { lease, cleanup } = freshLeaseModule();
    try {
        lease._setAliveProbe(() => true);
        lease.writeLease('sid-4', LW_MY_PID, 'key_a');
        assert.strictEqual(lease.isHeldElsewhere('sid-4', LW_MY_PID), false);
    } finally { lease._setAliveProbe(null); cleanup(); }
});

scenario('LW-5: removeOwnLease removes own lease but never another window\'s', () => {
    clearLwTmpDir();
    const { lease, cleanup } = freshLeaseModule();
    try {
        lease._setAliveProbe(() => true);
        lease.writeLease('sid-5', LW_MY_PID, 'key_a');
        lease.writeLease('sid-6', LW_OTHER_PID, 'key_b');
        lease.removeOwnLease('sid-5', LW_MY_PID);
        lease.removeOwnLease('sid-6', LW_MY_PID);
        assert.strictEqual(fs.existsSync(path.join(lwTmpDir, 'feedback_gate_lease_sid-5.json')), false, 'own lease removed');
        assert.strictEqual(fs.existsSync(path.join(lwTmpDir, 'feedback_gate_lease_sid-6.json')), true, 'foreign lease untouched');
    } finally { lease._setAliveProbe(null); cleanup(); }
});

scenario('LW-6: cleanStaleLeases removes dead-holder files, keeps live ones', () => {
    clearLwTmpDir();
    const { lease, cleanup } = freshLeaseModule();
    try {
        lease._setAliveProbe((pid) => pid === LW_MY_PID);
        lease.writeLease('sid-live', LW_MY_PID, 'k1');
        lease.writeLease('sid-dead', LW_OTHER_PID, 'k2');
        lease.cleanStaleLeases(Date.now());
        assert.strictEqual(fs.existsSync(path.join(lwTmpDir, 'feedback_gate_lease_sid-live.json')), true);
        assert.strictEqual(fs.existsSync(path.join(lwTmpDir, 'feedback_gate_lease_sid-dead.json')), false);
    } finally { lease._setAliveProbe(null); cleanup(); }
});

scenario('LW-7: corrupt lease file → readLease null, never throws', () => {
    clearLwTmpDir();
    const { lease, cleanup } = freshLeaseModule();
    try {
        fs.writeFileSync(path.join(lwTmpDir, 'feedback_gate_lease_sid-bad.json'), '{not json');
        assert.strictEqual(lease.readLease('sid-bad'), null);
        assert.strictEqual(lease.isHeldElsewhere('sid-bad', LW_MY_PID), false);
    } finally { cleanup(); }
});

scenario('LW-8: routing defers when another window holds the session lease', () => {
    const h = createRoutingHarness();
    h.createSession(9999, 'uuid-shared'); // local restored copy exists
    const result = h.routeTrigger(
        { timestamp: new Date().toISOString(), data: { session_id: 'uuid-shared' } },
        { workspacePath: '', isFocused: true, isLeaseHeldElsewhere: (sid) => sid === 'uuid-shared' }
    );
    assert.strictEqual(result.claimed, false);
    assert.strictEqual(result.reason, 'session lease held elsewhere');
});

scenario('LW-9: no lease → existing ownership semantics unchanged', () => {
    const h = createRoutingHarness();
    h.createSession(9999, 'uuid-shared');
    const result = h.routeTrigger(
        { timestamp: new Date().toISOString(), data: { session_id: 'uuid-shared' } },
        { workspacePath: '', isFocused: false, isLeaseHeldElsewhere: () => false }
    );
    assert.strictEqual(result.claimed, true);
    assert.strictEqual(result.reason, 'session ownership');
});

scenario('LW-10: lease for a DIFFERENT session does not block this one', () => {
    const h = createRoutingHarness();
    h.createSession(9999, 'uuid-mine');
    const result = h.routeTrigger(
        { timestamp: new Date().toISOString(), data: { session_id: 'uuid-mine' } },
        { workspacePath: '', isFocused: true, isLeaseHeldElsewhere: (sid) => sid === 'uuid-other' }
    );
    assert.strictEqual(result.claimed, true);
});

try { fs.rmSync(lwTmpDir, { recursive: true }); } catch {}
// ═══════════════════════════════════════════════════════════════
// WF: Cross-window forwarding via the holder's IDE queue (wave 1c)
// ═══════════════════════════════════════════════════════════════

// Mirrors the routing block of consumeIdeQueueFile after wave 1c.
function mirrorIdeRouting(item, sessionsMap, activeSessionKey) {
    let remoteSessionKey = '';
    if (item.targetSessionId) {
        for (const s of sessionsMap.values()) {
            if (s.sessionId === item.targetSessionId) { remoteSessionKey = s.key; break; }
        }
        if (!remoteSessionKey && item.targetSessionKey && sessionsMap.has(item.targetSessionKey)) {
            remoteSessionKey = item.targetSessionKey;
        }
    }
    if (!remoteSessionKey) {
        const activeSession = activeSessionKey ? sessionsMap.get(activeSessionKey) : null;
        const preferActive = activeSession && activeSession.triggerData;
        let pendingSession = null;
        if (preferActive) {
            pendingSession = activeSession;
        } else {
            for (const session of sessionsMap.values()) {
                if (session.triggerData && session.key !== activeSessionKey) { pendingSession = session; break; }
            }
        }
        remoteSessionKey = pendingSession ? pendingSession.key : (activeSessionKey || '');
    }
    return remoteSessionKey;
}

const wfTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-wf-test-'));

function clearWfTmpDir() {
    for (const f of fs.readdirSync(wfTmpDir)) {
        try { fs.unlinkSync(path.join(wfTmpDir, f)); } catch {}
    }
}

// Mirrors forwardMessageToLeaseHolder's entry construction + file choice.
function mirrorForward(session, lease, text) {
    if (!lease || lease.eh_pid === process.pid) return null;
    return {
        file: `feedback_gate_ide_queue_${lease.eh_pid}.jsonl`,
        entry: {
            text,
            ts: new Date().toISOString(),
            source: 'window-forward',
            targetSessionId: session.sessionId,
            targetSessionKey: lease.session_key || '',
            attachments: [],
            files: [],
        },
    };
}

scenario('WF-1: forwarded message with targetSessionId routes to that session even if another is active', () => {
    const sessionsMap = new Map([
        ['k1', { key: 'k1', sessionId: 'sid-A', triggerData: { trigger_id: 't' } }],
        ['k2', { key: 'k2', sessionId: 'sid-B', triggerData: { trigger_id: 't2' } }],
    ]);
    const key = mirrorIdeRouting(
        { text: 'hi', source: 'window-forward', targetSessionId: 'sid-B' },
        sessionsMap, 'k1'
    );
    assert.strictEqual(key, 'k2', 'must land in the target session, not the active one');
});

scenario('WF-2: unknown targetSessionId falls back to targetSessionKey when the session exists', () => {
    const sessionsMap = new Map([
        ['k1', { key: 'k1', sessionId: 'sid-A', triggerData: { trigger_id: 't' } }],
    ]);
    const key = mirrorIdeRouting(
        { text: 'hi', source: 'window-forward', targetSessionId: 'sid-gone', targetSessionKey: 'k1' },
        sessionsMap, ''
    );
    assert.strictEqual(key, 'k1');
});

scenario('WF-3: entries without targetSessionId keep legacy routing (active with trigger first)', () => {
    const sessionsMap = new Map([
        ['k1', { key: 'k1', sessionId: 'sid-A', triggerData: { trigger_id: 't' } }],
        ['k2', { key: 'k2', sessionId: 'sid-B', triggerData: null }],
    ]);
    const key = mirrorIdeRouting({ text: 'hi', source: 'feishu' }, sessionsMap, 'k1');
    assert.strictEqual(key, 'k1', 'active session with pending trigger keeps priority');
});

scenario('WF-4: entries without targetSessionId keep legacy routing (non-active pending fallback)', () => {
    const sessionsMap = new Map([
        ['k1', { key: 'k1', sessionId: 'sid-A', triggerData: null }],
        ['k2', { key: 'k2', sessionId: 'sid-B', triggerData: { trigger_id: 't' } }],
    ]);
    const key = mirrorIdeRouting({ text: 'hi', source: 'feishu' }, sessionsMap, 'k1');
    assert.strictEqual(key, 'k2');
});

scenario('WF-5: forward writes a window-forward entry into the holder\'s IDE queue file', () => {
    clearWfTmpDir();
    const holderPid = 876543;
    const fwd = mirrorForward(
        { sessionId: 'sid-X' },
        { eh_pid: holderPid, session_key: 'holder_key', ts: Date.now() },
        '回复内容'
    );
    assert.ok(fwd, 'must forward when another window holds the lease');
    assert.strictEqual(fwd.file, `feedback_gate_ide_queue_${holderPid}.jsonl`);
    assert.strictEqual(fwd.entry.source, 'window-forward');
    assert.strictEqual(fwd.entry.targetSessionId, 'sid-X');
    assert.strictEqual(fwd.entry.targetSessionKey, 'holder_key');
    // Round-trip through the actual file the holder polls.
    const filePath = path.join(wfTmpDir, fwd.file);
    fs.appendFileSync(filePath, JSON.stringify(fwd.entry) + '\n');
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8').trim());
    assert.strictEqual(parsed.text, '回复内容');
});

scenario('WF-6: no forwarding when this window holds the lease itself', () => {
    const fwd = mirrorForward(
        { sessionId: 'sid-Y' },
        { eh_pid: process.pid, session_key: 'mine', ts: Date.now() },
        'hello'
    );
    assert.strictEqual(fwd, null);
});

try { fs.rmSync(wfTmpDir, { recursive: true }); } catch {}
// ═══════════════════════════════════════════════════════════════
// EC: Queue auto-consume write failure must not drop the trigger (E1)
// ═══════════════════════════════════════════════════════════════

// Mirrors the pre-route auto-consume decision in checkTriggerFile.
// The trigger is ALREADY claimed (canonical unlink done) before this point,
// so a failed response write must requeue the item and fall through to the
// popup route instead of returning (which would hang the agent).
function mirrorAutoConsume(writeOk) {
    const queueItem = { id: 1, text: 'queued reply', status: 'processing', processingAt: Date.now() };
    let queueWriteOk = true;
    let claimedTriggerConsumed = false; // true = we responded and returned
    let fellThroughToPopup = false;     // true = normal route binds the trigger

    queueWriteOk = writeOk;
    if (!queueWriteOk) {
        queueItem.status = 'pending';
        delete queueItem.processingAt;
    }
    if (queueWriteOk) {
        claimedTriggerConsumed = true; // success path returns
    } else {
        fellThroughToPopup = true;     // failure path falls through
    }
    return { queueItem, claimedTriggerConsumed, fellThroughToPopup };
}

scenario('EC-1: response write succeeds → trigger consumed, no popup fallthrough', () => {
    const r = mirrorAutoConsume(true);
    assert.strictEqual(r.claimedTriggerConsumed, true);
    assert.strictEqual(r.fellThroughToPopup, false);
});

scenario('EC-2: response write FAILS → item requeued + trigger routed to popup (not dropped)', () => {
    const r = mirrorAutoConsume(false);
    assert.strictEqual(r.claimedTriggerConsumed, false, 'must NOT pretend the trigger was answered');
    assert.strictEqual(r.fellThroughToPopup, true, 'trigger must reach the popup route');
    assert.strictEqual(r.queueItem.status, 'pending', 'message must be requeued, not lost');
    assert.strictEqual(r.queueItem.processingAt, undefined);
});
// ═══════════════════════════════════════════════════════════════
// TG: Toggle-disable must not orphan pending triggers (E3)
// ═══════════════════════════════════════════════════════════════

// Mirrors the feedbackGate.toggle disable branch: for each pending trigger,
// attempt to write a TASK_COMPLETE response (per-item try/catch); clear the
// session's triggerData ONLY when a response actually exists. A failed write
// must keep the popup alive so the trigger is not orphaned.
function mirrorToggleDisable(pendingTriggers, opts) {
    const failIds = new Set(opts.failIds || []);
    const existingResponses = new Set(opts.existingResponses || []);
    let uncaught = null;
    const cleared = [];
    const kept = [];
    try {
        for (const triggerId of pendingTriggers) {
            let responded = existingResponses.has(triggerId);
            if (!responded) {
                try {
                    if (failIds.has(triggerId)) throw new Error('disk full');
                    responded = true; // write succeeded
                } catch (e) { /* per-item swallow */ }
            }
            if (responded) cleared.push(triggerId); else kept.push(triggerId);
        }
    } catch (e) { uncaught = e; }
    return { cleared, kept, uncaught };
}

scenario('TG-1: all writes succeed → every pending trigger cleared', () => {
    const r = mirrorToggleDisable(['t1', 't2'], {});
    assert.deepStrictEqual(r.cleared, ['t1', 't2']);
    assert.deepStrictEqual(r.kept, []);
    assert.strictEqual(r.uncaught, null);
});

scenario('TG-2: one write fails → that popup stays, others cleared, no throw', () => {
    const r = mirrorToggleDisable(['t1', 't2', 't3'], { failIds: ['t2'] });
    assert.deepStrictEqual(r.cleared, ['t1', 't3']);
    assert.deepStrictEqual(r.kept, ['t2'], 'failed trigger must keep its popup');
    assert.strictEqual(r.uncaught, null, 'failure must not abort the loop');
});

scenario('TG-3: pre-existing response counts as answered → cleared', () => {
    const r = mirrorToggleDisable(['t1'], { existingResponses: ['t1'] });
    assert.deepStrictEqual(r.cleared, ['t1']);
});

// ═══════════════════════════════════════════════════════════════
// DP: Disabled auto-passthrough must survive a write failure (E3)
// ═══════════════════════════════════════════════════════════════

// Mirrors the disabled-passthrough branch in checkTriggerFile. The trigger is
// ALREADY claimed before this runs, so a failed write must fall through to the
// popup route instead of returning.
function mirrorDisabledPassthrough(writeOk, hasTriggerId) {
    if (!hasTriggerId) return { consumed: true, fellThrough: false };
    if (writeOk) return { consumed: true, fellThrough: false };
    return { consumed: false, fellThrough: true };
}

scenario('DP-1: disabled passthrough write succeeds → consumed', () => {
    const r = mirrorDisabledPassthrough(true, true);
    assert.strictEqual(r.consumed, true);
    assert.strictEqual(r.fellThrough, false);
});

scenario('DP-2: disabled passthrough write FAILS → falls through to popup (trigger not dropped)', () => {
    const r = mirrorDisabledPassthrough(false, true);
    assert.strictEqual(r.consumed, false);
    assert.strictEqual(r.fellThrough, true);
});

scenario('DP-3: legacy trigger without id → consumed via filePath unlink', () => {
    const r = mirrorDisabledPassthrough(false, false);
    assert.strictEqual(r.consumed, true);
});

// ═══════════════════════════════════════════════════════════════
// B1: IDE-queue drain must prefer the session that received the message
// ═══════════════════════════════════════════════════════════════

// Mirrors the post-consume drain selection in consumeIdeQueueFile.
// Old behaviour used findNextPendingSession() which SKIPS the active
// session, so a message drained into the active session's queue was never
// sent when another session also waited.
function mirrorIdeDrainSelection(lastTargetSession, sessionsMap, activeSessionKey) {
    if (lastTargetSession && lastTargetSession.triggerData && lastTargetSession.triggerData.trigger_id) {
        return { key: lastTargetSession.key, via: 'routed-target' };
    }
    const active = activeSessionKey ? sessionsMap.get(activeSessionKey) : null;
    let pending = null;
    for (const s of sessionsMap.values()) {
        if (s.triggerData && s.key !== activeSessionKey) { pending = s; break; }
    }
    if (pending && pending.triggerData && pending.triggerData.trigger_id) {
        return { key: pending.key, via: 'pending' };
    }
    const activeTrigger = active ? active.triggerData : null;
    if (activeTrigger && activeTrigger.trigger_id) {
        return { key: activeSessionKey, via: 'active-trigger' };
    }
    return null;
}

scenario('B1-1: message routed to ACTIVE session with trigger → active is drained', () => {
    const sessionsMap = new Map([
        ['k1', { key: 'k1', triggerData: { trigger_id: 'tA' } }],
        ['k2', { key: 'k2', triggerData: { trigger_id: 'tB' } }],
    ]);
    const r = mirrorIdeDrainSelection(sessionsMap.get('k1'), sessionsMap, 'k1');
    assert.strictEqual(r.key, 'k1');
    assert.strictEqual(r.via, 'routed-target', 'must not skip the active session');
});

scenario('B1-2: message routed to non-active session wins over active trigger', () => {
    const sessionsMap = new Map([
        ['k1', { key: 'k1', triggerData: { trigger_id: 'tA' } }],
        ['k2', { key: 'k2', triggerData: { trigger_id: 'tB' } }],
    ]);
    const r = mirrorIdeDrainSelection(sessionsMap.get('k2'), sessionsMap, 'k1');
    assert.strictEqual(r.key, 'k2');
});

scenario('B1-3: no routed target → legacy non-active pending fallback', () => {
    const sessionsMap = new Map([
        ['k1', { key: 'k1', triggerData: null }],
        ['k2', { key: 'k2', triggerData: { trigger_id: 'tB' } }],
    ]);
    const r = mirrorIdeDrainSelection(null, sessionsMap, 'k1');
    assert.strictEqual(r.key, 'k2');
    assert.strictEqual(r.via, 'pending');
});

scenario('B1-4: nothing pending anywhere → active-trigger fallback', () => {
    const sessionsMap = new Map([
        ['k1', { key: 'k1', triggerData: { trigger_id: 'tA' } }],
    ]);
    const r = mirrorIdeDrainSelection(null, sessionsMap, 'k1');
    assert.strictEqual(r.key, 'k1');
    assert.strictEqual(r.via, 'active-trigger');
});
// ═══════════════════════════════════════════════════════════════
// NX: expired triggers must be announced in the UI (N5)
// ═══════════════════════════════════════════════════════════════

// Mirrors the cleanupStaleSessions 2h trigger cleanup: clearing a stale
// trigger must ALSO emit a user-visible system message, so users understand
// why the popup no longer accepts an answer to the old question.
function mirrorStaleCleanup(session, ageMs, STALE_TRIGGER_MS) {
    const events = [];
    if (session.triggerData && ageMs > STALE_TRIGGER_MS) {
        session.triggerData = null;
        events.push('trigger-cleared');
        events.push('system-message');
    }
    return events;
}

scenario('NX-1: 2h-stale trigger cleared WITH a visible system notification', () => {
    const s = { triggerData: { trigger_id: 't' } };
    const events = mirrorStaleCleanup(s, 2.5 * 3600 * 1000, 2 * 3600 * 1000);
    assert.deepStrictEqual(events, ['trigger-cleared', 'system-message']);
});

scenario('NX-2: fresh trigger untouched, no notification', () => {
    const s = { triggerData: { trigger_id: 't' } };
    const events = mirrorStaleCleanup(s, 60 * 1000, 2 * 3600 * 1000);
    assert.deepStrictEqual(events, []);
    assert.ok(s.triggerData);
});
// ═══════════════════════════════════════════════════════════════
// RD: Wave-3 extension fixes (E4 ready status / E5 successor /
//     E9 sessionless dispose / E10 orphan trigger adoption)
// ═══════════════════════════════════════════════════════════════

scenario('RD-1: E10 — dead target EH + no owner + focused >15s → adopted', () => {
    const h = createRoutingHarness();
    const oldTs = new Date(Date.now() - 20000).toISOString();
    const result = h.routeTrigger(
        { targetEhPid: 424242, timestamp: oldTs, data: { session_id: 'uuid-orphan' } },
        { workspacePath: '', isFocused: true, targetAlive: false }
    );
    assert.strictEqual(result.claimed, true, 'focused window must adopt the orphaned trigger');
});

scenario('RD-2: E10 — dead target EH + no owner + NOT focused → still rejected', () => {
    const h = createRoutingHarness();
    const oldTs = new Date(Date.now() - 20000).toISOString();
    const result = h.routeTrigger(
        { targetEhPid: 424242, timestamp: oldTs, data: { session_id: 'uuid-orphan' } },
        { workspacePath: '', isFocused: false, targetAlive: false }
    );
    assert.strictEqual(result.claimed, false);
});

scenario('RD-3: E10 — dead target EH + no owner + within grace period → rejected', () => {
    const h = createRoutingHarness();
    const freshTs = new Date(Date.now() - 3000).toISOString();
    const result = h.routeTrigger(
        { targetEhPid: 424242, timestamp: freshTs, data: { session_id: 'uuid-orphan' } },
        { workspacePath: '', isFocused: true, targetAlive: false }
    );
    assert.strictEqual(result.claimed, false);
});

scenario('RD-4: dead target EH but session owner alive → owner claims as before', () => {
    const h = createRoutingHarness();
    h.createSession(9999, 'uuid-owned');
    const result = h.routeTrigger(
        { targetEhPid: 424242, timestamp: new Date().toISOString(), data: { session_id: 'uuid-owned' } },
        { workspacePath: '', isFocused: false, targetAlive: false }
    );
    assert.strictEqual(result.claimed, true);
    assert.strictEqual(result.reason, 'session ownership');
});

function mirrorSuccessorOnDelete(sessionsMap, deletedKey) {
    // Mirrors the E5 fix in the preemptive dead-session cleanup.
    sessionsMap.delete(deletedKey);
    let next = null;
    for (const s of sessionsMap.values()) { if (s.triggerData) { next = s; break; } }
    if (!next && sessionsMap.size > 0) next = sessionsMap.values().next().value;
    return next ? next.key : null;
}

scenario('RD-5: E5 — deleting the active session picks a successor', () => {
    const sessionsMap = new Map([
        ['dead', { key: 'dead', triggerData: null }],
        ['alive', { key: 'alive', triggerData: { trigger_id: 't' } }],
    ]);
    assert.strictEqual(mirrorSuccessorOnDelete(sessionsMap, 'dead'), 'alive');
});

scenario('RD-5b: E5 — deleting the last session yields null successor', () => {
    const sessionsMap = new Map([['dead', { key: 'dead', triggerData: null }]]);
    assert.strictEqual(mirrorSuccessorOnDelete(sessionsMap, 'dead'), null);
});

function mirrorSessionlessDispose(currentTriggerData, responseExists) {
    // Mirrors chatPanel.onDidDispose in sessionless mode (E9).
    const tid = currentTriggerData && currentTriggerData.trigger_id;
    let wroteClosed = false;
    if (tid && !responseExists) wroteClosed = true;
    return { wroteClosed, cleared: true };
}

scenario('RD-6: E9 — disposing sessionless popup answers [CLOSED]', () => {
    const r = mirrorSessionlessDispose({ trigger_id: 't-legacy' }, false);
    assert.strictEqual(r.wroteClosed, true);
    assert.strictEqual(r.cleared, true);
});

scenario('RD-6b: E9 — existing response is never overwritten on dispose', () => {
    const r = mirrorSessionlessDispose({ trigger_id: 't-legacy' }, true);
    assert.strictEqual(r.wroteClosed, false);
});

function mirrorReadyStatus(hasPendingMessages, mcpStatus) {
    // Mirrors the provider 'ready' handler after the E4 fix: the active flag
    // must reflect mcpStatus even when pending messages are flushed.
    return { active: mcpStatus };
}

scenario('RD-7: E4 — ready with buffered messages reports real MCP status', () => {
    assert.strictEqual(mirrorReadyStatus(true, false).active, false);
    assert.strictEqual(mirrorReadyStatus(true, true).active, true);
});
// ═══════════════════════════════════════════════════════════════
// E7: pending webview message buffer must stay bounded
// ═══════════════════════════════════════════════════════════════

scenario('E7-1: pending message buffer is capped at 500 (oldest dropped first)', () => {
    // Mirrors the broadcast helpers' cap: if a webview never becomes ready,
    // buffered messages must not grow without bound.
    const buf = [];
    for (let i = 0; i < 600; i++) {
        buf.push({ id: i });
        if (buf.length > 500) buf.shift();
    }
    assert.strictEqual(buf.length, 500);
    assert.strictEqual(buf[0].id, 100, 'oldest entries dropped first');
});

// ═══════════════════════════════════════════════════════════════
// Results
// ═══════════════════════════════════════════════════════════════

const passed = results.filter(r => r.ok).length;
const failed = results.filter(r => !r.ok).length;
console.log(`\n${'─'.repeat(55)}`);
console.log(`Integration Scenarios: ${passed} passed, ${failed} failed, ${results.length} total`);
if (failed > 0) {
    console.log('\nFailed:');
    results.filter(r => !r.ok).forEach(r => console.log(`  ❌ ${r.name}: ${r.error}`));
}
console.log();
process.exit(failed > 0 ? 1 : 0);
