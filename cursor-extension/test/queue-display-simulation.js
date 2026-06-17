#!/usr/bin/env node
/**
 * 100-scenario simulation for queue _displayed logic and message deduplication.
 * Tests the exact code paths modified in extension.js and queue-manager.js.
 * Run: node cursor-extension/test/queue-display-simulation.js
 */

const assert = require('assert');

// ── Mock queue-manager ─────────────────────────
function createQueueManager() {
    let messageQueue = [];
    let _idCounter = 0;
    let _activeSessionKey = '';

    function generateId() { return Date.now() * 1000 + (++_idCounter % 1000); }

    function enqueueMessage(text, attachments, files, meta) {
        const item = {
            id: generateId(),
            text,
            attachments: attachments || [],
            files: files || [],
            status: 'pending',
            timestamp: new Date().toISOString(),
            source: meta?.source || 'local',
            sessionKey: (meta?.sessionKey != null ? meta.sessionKey : _activeSessionKey) || '',
        };
        messageQueue.push(item);
        return item;
    }

    function dequeueMessage(sessionKey) {
        const idx = messageQueue.findIndex(m => {
            if (m.status !== 'pending') return false;
            if (sessionKey) return m.sessionKey === sessionKey;
            return !m.sessionKey;
        });
        if (idx === -1) return null;
        messageQueue[idx].status = 'processing';
        return messageQueue[idx];
    }

    function markQueueItemDone(id) {
        messageQueue = messageQueue.filter(m => m.id !== id);
    }

    function requeueItem(id) {
        const item = messageQueue.find(m => m.id === id);
        if (item) { item.status = 'pending'; }
    }

    function getPendingQueueCount(sessionKey) {
        let pending = messageQueue.filter(m => m.status === 'pending');
        if (sessionKey) pending = pending.filter(m => m.sessionKey === sessionKey);
        else pending = pending.filter(m => !m.sessionKey);
        return pending.length;
    }

    function getVisibleQueueItems(sessionKey) {
        let items = messageQueue.filter(m => (m.status === 'pending' || m.status === 'processing') && !m._displayed);
        if (sessionKey) items = items.filter(m => m.sessionKey === sessionKey);
        else items = items.filter(m => !m.sessionKey);
        return items;
    }

    function migrateSessionKey(from, to) {
        messageQueue.forEach(m => { if (m.sessionKey === from) m.sessionKey = to; });
    }

    function saveQueue() { /* no-op in test */ }

    function loadAndClearSessionKeys() {
        messageQueue.forEach(m => {
            if (m.sessionKey) { m._prevSessionKey = m.sessionKey; m.sessionKey = ''; }
        });
    }

    return {
        enqueueMessage, dequeueMessage, markQueueItemDone, requeueItem,
        getPendingQueueCount, getVisibleQueueItems, migrateSessionKey,
        saveQueue, loadAndClearSessionKeys,
        get items() { return messageQueue; },
    };
}

// ── Mock extension logic (mirrors the modified code paths) ─────────────────────────
function createExtension() {
    const queue = createQueueManager();
    const sessions = new Map();
    let sessionCounter = 0;
    const messagesDisplayed = []; // track what got shown to UI

    function createSession(key, sessionId) {
        sessionCounter++;
        const session = {
            key, sessionId, triggerData: null, messages: [],
            label: `#${sessionCounter}`,
        };
        sessions.set(key, session);
        return session;
    }

    function addMessageToSession(sessionKey, msg) {
        const session = sessions.get(sessionKey);
        if (!session) return;
        session.messages.push(msg);
        messagesDisplayed.push({ sessionKey, ...msg });
    }

    // Simulates case 'send' (provider path) — matches current extension.js behavior:
    // With trigger → processQueue (immediate). Without trigger → queue only, no display.
    function handleSend(text, sessionKey) {
        const sendSession = sessions.get(sessionKey) || null;
        const enqueuedItem = queue.enqueueMessage(text, [], [], { sessionKey: sessionKey || '' });

        const sendTrigger = sendSession ? sendSession.triggerData : null;
        if (sendTrigger && sendTrigger.trigger_id) {
            processQueueForPendingTrigger(true, sendSession.key);
        }
        // No active trigger → message stays in queue only, NOT displayed yet.
        return enqueuedItem;
    }

    // Simulates processQueueForPendingTrigger
    function processQueueForPendingTrigger(directSend, targetSessionKey) {
        const targetSession = sessions.get(targetSessionKey);
        const activeTrigger = targetSession ? targetSession.triggerData : null;
        if (!activeTrigger || !activeTrigger.trigger_id) return false;
        if (queue.getPendingQueueCount(targetSessionKey) === 0) return false;

        const queueItem = queue.dequeueMessage(targetSessionKey);
        if (!queueItem) return false;

        // Simulate writeResponseForTrigger success
        queue.markQueueItemDone(queueItem.id);

        if (!queueItem._displayed) {
            if (targetSession) {
                addMessageToSession(targetSession.key, { text: queueItem.text, type: 'user' });
            }
        }
        if (targetSession) {
            targetSession.triggerData = null; // consumed
        }
        return true;
    }

    // Simulates auto-consume on trigger arrival
    function autoConsume(triggerData, sessionKey) {
        const session = sessions.get(sessionKey);
        if (!session) return false;
        session.triggerData = triggerData;

        if (queue.getPendingQueueCount(sessionKey) > 0) {
            const queueItem = queue.dequeueMessage(sessionKey);
            if (queueItem) {
                queue.markQueueItemDone(queueItem.id);
                if (!queueItem._displayed) {
                    addMessageToSession(session.key, { text: queueItem.text, type: 'user' });
                }
                session.triggerData = null;
                return true;
            }
        }
        return false;
    }

    function setTrigger(sessionKey, triggerId) {
        const session = sessions.get(sessionKey);
        if (session) session.triggerData = { trigger_id: triggerId };
    }

    function clearTrigger(sessionKey) {
        const session = sessions.get(sessionKey);
        if (session) session.triggerData = null;
    }

    return {
        queue, sessions, createSession, addMessageToSession,
        handleSend, processQueueForPendingTrigger, autoConsume,
        setTrigger, clearTrigger, messagesDisplayed,
    };
}

// ── Test runner ─────────────────────────
const results = [];
function scenario(name, fn) {
    try {
        fn();
        results.push({ name, ok: true });
    } catch (e) {
        results.push({ name, ok: false, error: e.message });
        console.error(`  ✗ ${name}: ${e.message}`);
    }
}

// ═══════════════════════════════════════════════════════════════
// SCENARIOS
// ═══════════════════════════════════════════════════════════════

// --- Group 1: Basic send with trigger (no change from original) ---
for (let i = 1; i <= 10; i++) {
    scenario(`G1-${i}: Send with active trigger shows message once`, () => {
        const ext = createExtension();
        const s = ext.createSession('s1', 'uuid-1');
        ext.setTrigger('s1', `trigger-${i}`);
        ext.handleSend(`msg-${i}`, 's1');
        assert.strictEqual(s.messages.length, 1, `should have 1 message, got ${s.messages.length}`);
        assert.strictEqual(s.messages[0].text, `msg-${i}`);
        assert.strictEqual(ext.queue.getPendingQueueCount('s1'), 0);
    });
}

// --- Group 2: Send without trigger → queue only, no immediate display ---
for (let i = 1; i <= 10; i++) {
    scenario(`G2-${i}: Send without trigger goes to queue only`, () => {
        const ext = createExtension();
        const s = ext.createSession('s1', 'uuid-1');
        ext.handleSend(`no-trigger-${i}`, 's1');
        assert.strictEqual(s.messages.length, 0, 'should NOT display without trigger');
        assert.strictEqual(ext.queue.getPendingQueueCount('s1'), 1);
    });
}

// --- Group 3: Trigger arrives → auto-consume shows queued message exactly once ---
for (let i = 1; i <= 10; i++) {
    scenario(`G3-${i}: Trigger auto-consumes queued message (shown once)`, () => {
        const ext = createExtension();
        const s = ext.createSession('s1', 'uuid-1');
        ext.handleSend(`dedup-${i}`, 's1');
        assert.strictEqual(s.messages.length, 0, 'not shown yet');

        // Trigger arrives → auto-consume
        const consumed = ext.autoConsume({ trigger_id: `t-${i}` }, 's1');
        assert.strictEqual(consumed, true);
        assert.strictEqual(s.messages.length, 1, 'shown exactly once via auto-consume');
        assert.strictEqual(s.messages[0].text, `dedup-${i}`);
    });
}

// --- Group 4: Multiple sends without trigger → all queued, none displayed ---
for (let i = 1; i <= 10; i++) {
    scenario(`G4-${i}: ${i} messages without trigger all queued only`, () => {
        const ext = createExtension();
        const s = ext.createSession('s1', 'uuid-1');
        for (let j = 0; j < i; j++) {
            ext.handleSend(`multi-${j}`, 's1');
        }
        assert.strictEqual(s.messages.length, 0, 'none displayed without trigger');
        assert.strictEqual(ext.queue.getPendingQueueCount('s1'), i);
    });
}

// --- Group 5: Queue visibility — items without trigger remain visible in queue UI ---
for (let i = 1; i <= 10; i++) {
    scenario(`G5-${i}: Queued items visible in queue UI (not displayed in chat)`, () => {
        const ext = createExtension();
        ext.createSession('s1', 'uuid-1');
        ext.handleSend(`queue-vis-${i}`, 's1');
        const visible = ext.queue.getVisibleQueueItems('s1');
        assert.strictEqual(visible.length, 1, 'visible in queue UI since not _displayed');
        assert.strictEqual(ext.queue.getPendingQueueCount('s1'), 1);
    });
}

// --- Group 6: Send with trigger failure → requeue ---
for (let i = 1; i <= 5; i++) {
    scenario(`G6-${i}: Failed write requeues without display`, () => {
        const ext = createExtension();
        const s = ext.createSession('s1', 'uuid-1');
        ext.setTrigger('s1', `trigger-fail-${i}`);
        const item = ext.queue.enqueueMessage(`fail-${i}`, [], [], { sessionKey: 's1' });
        // Simulate dequeue + write failure
        const dequeued = ext.queue.dequeueMessage('s1');
        ext.queue.requeueItem(dequeued.id);
        assert.strictEqual(s.messages.length, 0, 'should not display on failure');
        assert.strictEqual(ext.queue.getPendingQueueCount('s1'), 1);
    });
}

// --- Group 7: Multi-session isolation (queued, not displayed) ---
for (let i = 1; i <= 10; i++) {
    scenario(`G7-${i}: Messages queued per-session, not cross-contaminated`, () => {
        const ext = createExtension();
        ext.createSession('s1', 'uuid-1');
        ext.createSession('s2', 'uuid-2');
        ext.handleSend(`s1-msg-${i}`, 's1');
        ext.handleSend(`s2-msg-${i}`, 's2');
        assert.strictEqual(ext.queue.getPendingQueueCount('s1'), 1);
        assert.strictEqual(ext.queue.getPendingQueueCount('s2'), 1);
        const s1 = ext.sessions.get('s1');
        const s2 = ext.sessions.get('s2');
        assert.strictEqual(s1.messages.length, 0, 'not displayed without trigger');
        assert.strictEqual(s2.messages.length, 0, 'not displayed without trigger');
    });
}

// --- Group 8: Trigger on one session doesn't consume other session ---
for (let i = 1; i <= 10; i++) {
    scenario(`G8-${i}: Trigger consumes only its own session's queue`, () => {
        const ext = createExtension();
        ext.createSession('s1', 'uuid-1');
        ext.createSession('s2', 'uuid-2');
        ext.handleSend(`s1-${i}`, 's1');
        ext.handleSend(`s2-${i}`, 's2');
        ext.setTrigger('s1', `t-${i}`);
        const consumed = ext.processQueueForPendingTrigger(true, 's1');
        assert.strictEqual(consumed, true);
        assert.strictEqual(ext.queue.getPendingQueueCount('s2'), 1, 's2 queue untouched');
    });
}

// --- Group 9: Reload simulation (sessionKey cleared, _displayed not set without trigger) ---
for (let i = 1; i <= 10; i++) {
    scenario(`G9-${i}: Queue item sessionKey cleared on reload, _displayed stays false`, () => {
        const ext = createExtension();
        ext.createSession('s1', 'uuid-1');
        ext.handleSend(`reload-${i}`, 's1');
        const items = ext.queue.items;
        assert.strictEqual(items[0]._displayed, undefined, 'not displayed (no trigger)');
        ext.queue.loadAndClearSessionKeys();
        assert.strictEqual(items[0].sessionKey, '');
    });
}

// --- Group 10: Mixed scenario - some with trigger, some without ---
for (let i = 1; i <= 10; i++) {
    scenario(`G10-${i}: Mixed trigger/no-trigger sequence`, () => {
        const ext = createExtension();
        const s = ext.createSession('s1', 'uuid-1');
        // First send with trigger → immediate consume
        ext.setTrigger('s1', `t1-${i}`);
        ext.handleSend(`with-trigger-${i}`, 's1');
        assert.strictEqual(s.messages.length, 1);
        // Trigger consumed, now send without → queue only
        ext.handleSend(`no-trigger-${i}`, 's1');
        assert.strictEqual(s.messages.length, 1, 'second msg not displayed');
        // New trigger arrives, auto-consumes the queued message
        const consumed = ext.autoConsume({ trigger_id: `t2-${i}` }, 's1');
        assert.strictEqual(consumed, true);
        assert.strictEqual(s.messages.length, 2, 'now shown via auto-consume');
        assert.strictEqual(s.messages[1].text, `no-trigger-${i}`);
    });
}

// --- Group 11: Rapid sends (stress test) ---
for (let i = 1; i <= 5; i++) {
    scenario(`G11-${i}: Rapid ${i * 10} sends without trigger → all queued`, () => {
        const ext = createExtension();
        const s = ext.createSession('s1', 'uuid-1');
        const count = i * 10;
        for (let j = 0; j < count; j++) {
            ext.handleSend(`rapid-${j}`, 's1');
        }
        assert.strictEqual(s.messages.length, 0, 'none displayed without trigger');
        assert.strictEqual(ext.queue.getPendingQueueCount('s1'), count);
        assert.strictEqual(ext.queue.getVisibleQueueItems('s1').length, count, 'all visible in queue');
    });
}

// ═══════════════════════════════════════════════════════════════
// Results
// ═══════════════════════════════════════════════════════════════
const passed = results.filter(r => r.ok).length;
const failed = results.filter(r => !r.ok).length;
console.log(`\n${'─'.repeat(50)}`);
console.log(`Queue Display Simulation: ${passed} passed, ${failed} failed, ${results.length} total`);
if (failed > 0) {
    console.log('\nFailed scenarios:');
    results.filter(r => !r.ok).forEach(r => console.log(`  ✗ ${r.name}: ${r.error}`));
}
console.log();
process.exit(failed > 0 ? 1 : 0);
