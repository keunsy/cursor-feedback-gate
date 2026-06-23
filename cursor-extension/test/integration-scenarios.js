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

        // Signal 0: targetEhPid (skip if not us)
        if (targetEhPid && targetEhPid !== process.pid) {
            return { claimed: false, reason: 'targetEhPid mismatch' };
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
                return { claimed: false, reason: 'workspace mismatch overrides session ownership' };
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
            if (!isFocused) {
                return { claimed: false, reason: 'not focused, no workspace hint' };
            }
            claimedTriggers.push(triggerData);
            return { claimed: true, reason: 'focused window claims' };
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

scenario('TR-3: session ownership yields when workspace hint mismatches', () => {
    const h = createRoutingHarness();
    h.createSession(9999, 'uuid-1');
    const result = h.routeTrigger(
        { data: { session_id: 'uuid-1', workspace_path: '/projects/other' } },
        { workspacePath: '/projects/mine', isFocused: false }
    );
    assert.strictEqual(result.claimed, false);
    assert.strictEqual(result.reason, 'workspace mismatch overrides session ownership');
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

scenario('TR-8: session_id present but no workspace hint + not focused → rejected', () => {
    const h = createRoutingHarness();
    const result = h.routeTrigger(
        { data: { session_id: 'uuid-new' } },
        { workspacePath: '/projects/foo', isFocused: false }
    );
    assert.strictEqual(result.claimed, false);
    assert.strictEqual(result.reason, 'not focused, no workspace hint');
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
