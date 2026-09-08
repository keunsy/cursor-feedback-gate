#!/usr/bin/env node
/**
 * Real-code harness for the intra-window defect (P3 wave).
 *
 * Every other suite in this repo MIRRORS pieces of extension.js, so a mirror can
 * stay green while the shipped code is wrong. This file closes that gap: it loads
 * the ACTUAL cursor-extension/extension.js source (byte-for-byte, plus an appended
 * test seam exposing module-internal functions) behind a minimal `vscode` stub and
 * the real queue-manager, then drives the exact reported scenario:
 *
 *   one Cursor window → one MCP process → two conversations.
 *   A is running (no pending trigger) with the user's replies queued,
 *   B fires its first trigger.
 *
 * Expected (contract §11): B gets its own session, nothing of A is consumed,
 * A's transcript/label/identity are untouched, and an automatic tab switch never
 * steals the input box while the user is composing in A.
 *
 * Run: node cursor-extension/test/real-code-intrawindow.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const EXT_DIR = path.join(__dirname, '..');
const SEAM_FILE = path.join(EXT_DIR, 'debug_realcode_seam.js'); // matches .gitignore debug_*
const VSCODE_STUB_DIR = path.join(EXT_DIR, 'node_modules', 'vscode');
const TEST_WS = `/tmp/fg-realcode-${process.pid}`;

let passed = 0;
let failed = 0;
const failures = [];
// console.log is captured while the real code runs (we assert on its diagnostics),
// so the human-readable report is buffered and printed after the capture ends.
const report = [];

function scenario(name, fn) {
    try {
        fn();
        passed++;
        report.push(`  ✓ ${name}`);
    } catch (e) {
        failed++;
        failures.push({ name, message: e.message });
        report.push(`  ✗ ${name}\n      ${e.message}`);
    }
}

// ── vscode stub ───────────────────────────────────────────────────────────────
function buildVscodeStub() {
    const noopDisposable = { dispose() {} };
    return {
        workspace: {
            workspaceFolders: [{ uri: { fsPath: TEST_WS } }],
            getConfiguration: () => ({ get: (_k, dflt) => dflt, update: async () => {} }),
        },
        window: {
            state: { focused: true },
            activeTextEditor: undefined,
            createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, clear() {}, dispose() {} }),
            createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {}, text: '', tooltip: '', command: '' }),
            createWebviewPanel: () => null,
            registerWebviewViewProvider: () => noopDisposable,
            showInformationMessage: (..._a) => Promise.resolve(undefined),
            showWarningMessage: (..._a) => Promise.resolve(undefined),
            showErrorMessage: (..._a) => Promise.resolve(undefined),
            showOpenDialog: () => Promise.resolve(undefined),
        },
        commands: {
            registerCommand: () => noopDisposable,
            executeCommand: () => Promise.resolve(undefined),
        },
        StatusBarAlignment: { Left: 1, Right: 2 },
        ViewColumn: { One: 1, Two: 2 },
        ThemeColor: class ThemeColor { constructor(id) { this.id = id; } },
        Uri: { file: (p) => ({ fsPath: p }) },
    };
}

// ── load the REAL extension.js with an appended seam ──────────────────────────
function loadRealExtension(stub) {
    const stubWasAbsent = !fs.existsSync(VSCODE_STUB_DIR);
    if (stubWasAbsent) {
        fs.mkdirSync(VSCODE_STUB_DIR, { recursive: true });
        fs.writeFileSync(path.join(VSCODE_STUB_DIR, 'package.json'),
            JSON.stringify({ name: 'vscode', version: '0.0.0-stub', main: 'index.js' }, null, 2));
        fs.writeFileSync(path.join(VSCODE_STUB_DIR, 'index.js'),
            'module.exports = global.__FG_REALCODE_VSCODE_STUB__;\n');
    }
    global.__FG_REALCODE_VSCODE_STUB__ = stub;

    const src = fs.readFileSync(path.join(EXT_DIR, 'extension.js'), 'utf8');
    const seam = `
// ── appended by test/real-code-intrawindow.js (test seam, never shipped) ──
module.exports.__seam = {
    sessions,
    getActiveSessionKey: () => activeSessionKey,
    getOrCreateSessionForTrigger,
    setCurrentTriggerData,
    clearSessionTrigger,
    switchToSession,
    noteComposition,
    isComposingElsewhere,
    resolveSendSession,
    queueItemBelongsToConversation,
    addMessageToSession,
    enqueueMessage,
    dequeueMessage,
    getPendingQueueCount,
    processQueueForPendingTrigger,
};
`;
    fs.writeFileSync(SEAM_FILE, src + seam);
    return { mod: require(SEAM_FILE), stubWasAbsent };
}

// ── capture the real console diagnostics ──────────────────────────────────────
const logs = [];
function startCapture() {
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a) => { logs.push(a.join(' ')); };
    console.error = (...a) => { logs.push(a.join(' ')); };
    return () => { console.log = origLog; console.error = origErr; };
}
function sawLog(needle, since = 0) {
    return logs.slice(since).some(l => l.includes(needle));
}

// ── main ─────────────────────────────────────────────────────────────────────
const stub = buildVscodeStub();
let stopCapture = null;
let seam = null;
let queueMod = null;
let stubWasAbsent = true;
const createdTmpFiles = [];

function queueFileName() {
    const wsId = TEST_WS.replace(/[^a-zA-Z0-9]/g, '_').slice(-40);
    return `/tmp/feedback_gate_queue_${wsId}_pid${process.pid}.json`;
}

try {
    const loaded = loadRealExtension(stub);
    seam = loaded.mod.__seam;
    stubWasAbsent = loaded.stubWasAbsent;
    assert.ok(seam, 'test seam failed to load — extension.js could not be evaluated');

    // The seam and this test must share ONE queue-manager instance.
    queueMod = require(path.join(EXT_DIR, 'queue-manager.js'));
    queueMod.init(stub, () => {});
    createdTmpFiles.push(queueFileName());

    stopCapture = startCapture();

    // ── Phase 1: untagged adoption must skip foreign leftovers (P3-1c / IW12) ──
    let soleKey = null;
    scenario('RC-1: sole-session adoption takes identity-less leftovers only', () => {
        queueMod.enqueueMessage('legacy leftover', [], [], { sessionKey: '' });
        queueMod.enqueueMessage('属于 rc-Z 的排队消息', [], [], { sessionKey: '', sessionId: 'rc-Z' });
        assert.strictEqual(seam.getPendingQueueCount(''), 2);

        const s = seam.setCurrentTriggerData(
            { trigger_id: 'rc-t-u', session_id: 'rc-U', message: 'U 的第一个问题' }, 5952);
        assert.ok(s, 'session created for the first trigger');
        soleKey = s.key;
        assert.strictEqual(seam.getPendingQueueCount(s.key), 1, 'only the identity-less item was adopted');
        assert.strictEqual(seam.getPendingQueueCount(''), 1, 'the rc-Z item stayed untagged');
        assert.ok(sawLog('left untagged (foreign session_id)'), 'adoption logged the skipped foreign item');
    });

    scenario('RC-2: phase-1 state cleared, window back to zero conversations', () => {
        const junk = seam.dequeueMessage('');
        assert.strictEqual(junk.sessionId, 'rc-Z', 'the leftover is still the rc-Z one');
        queueMod.removeQueueItem(junk.id);
        queueMod.removeItemsForSession(soleKey);
        seam.sessions.delete(soleKey);
        assert.strictEqual(seam.getPendingQueueCount(''), 0);
        assert.strictEqual(seam.sessions.size, 0);
    });

    // ── Phase 2: the reported defect ────────────────────────────────────────
    let A = null;
    let B = null;
    let aLabelAfterFirstTrigger = null;
    const A_TEXT_1 = '帮我生成一个类似 meigui 这样淘股吧博主的分析';
    const A_TEXT_2 = '再补充一点：只要情绪周期部分';

    scenario('RC-3: conversation A is created, asks, gets answered, and keeps running', () => {
        A = seam.getOrCreateSessionForTrigger(5952, 'rc-A');
        assert.strictEqual(A.sessionId, 'rc-A');
        seam.setCurrentTriggerData({ trigger_id: 'rc-t-a1', session_id: 'rc-A', message: 'A 的第一个问题' }, 5952);
        seam.addMessageToSession(A.key, { text: 'A 的第一个问题', type: 'system' });
        aLabelAfterFirstTrigger = A.label;
        assert.strictEqual(A.messages.length, 1);
        // user answered A → A is now running again with NO pending trigger
        seam.clearSessionTrigger(A.key);
        assert.strictEqual(A.triggerData, null);
    });

    scenario('RC-4: two replies queued for A while A runs', () => {
        seam.enqueueMessage(A_TEXT_1, [], [], { sessionKey: A.key, sessionId: 'rc-A' });
        seam.enqueueMessage(A_TEXT_2, [], [], { sessionKey: A.key, sessionId: 'rc-A' });
        assert.strictEqual(seam.getPendingQueueCount(A.key), 2);
    });

    scenario('RC-5 (P3-1): B\'s first trigger never takes over A', () => {
        const before = seam.sessions.size;
        B = seam.setCurrentTriggerData(
            { trigger_id: 'rc-t-b1', session_id: 'rc-B', message: 'B 的问题' }, 5952);

        assert.ok(B, 'B got a session');
        assert.notStrictEqual(B.key, A.key, 'B must NOT reuse A\'s session key');
        assert.strictEqual(seam.sessions.size, before + 1, 'a second conversation = a second session');
        assert.ok(sawLog('SESSION_ID_ISOLATION'), 'the isolation guard logged its refusal');

        assert.strictEqual(A.sessionId, 'rc-A', 'A keeps its own conversation identity');
        assert.strictEqual(A.label, aLabelAfterFirstTrigger, 'A keeps its tab label');
        assert.strictEqual(A.messages.length, 1, 'A keeps its transcript');
        assert.strictEqual(A.triggerData, null, 'B did not plant a trigger on A');
        assert.strictEqual(B.sessionId, 'rc-B');
        assert.strictEqual(B.triggerData.trigger_id, 'rc-t-b1');
    });

    scenario('RC-6 (P3-1b): B\'s bucket is empty and A\'s queued input is untouched', () => {
        assert.strictEqual(seam.getPendingQueueCount(B.key), 0, 'B inherits nothing');
        assert.strictEqual(seam.getPendingQueueCount(A.key), 2, 'A still holds both replies');
        const first = seam.dequeueMessage(A.key);
        assert.strictEqual(first.text, A_TEXT_1, 'FIFO order preserved for A');
        assert.strictEqual(first.sessionId, 'rc-A');
        queueMod.requeueItem(first.id);
        assert.strictEqual(seam.getPendingQueueCount(A.key), 2, 'put back for A');
    });

    scenario('RC-7 (P3-1b): the drain guard refuses a foreign item planted in B\'s bucket', () => {
        const mark = logs.length;
        // a stale response file from an earlier run must not decide this assertion
        try { fs.unlinkSync('/tmp/feedback_gate_response_rc-t-b1.json'); } catch {}
        seam.enqueueMessage('误投到 B 的 A 消息', [], [], { sessionKey: B.key, sessionId: 'rc-A' });
        assert.strictEqual(seam.getPendingQueueCount(B.key), 1);
        seam.processQueueForPendingTrigger(true, B.key);
        assert.strictEqual(seam.getPendingQueueCount(B.key), 1, 'rejected and requeued, not consumed');
        assert.ok(sawLog('QUEUE_SESSION_MISMATCH (drain)', mark), 'drain guard logged the mismatch');
        assert.strictEqual(fs.existsSync('/tmp/feedback_gate_response_rc-t-b1.json'), false,
            'no response was written for B\'s trigger');
        queueMod.removeItemsForSession(B.key);
        assert.strictEqual(seam.getPendingQueueCount(B.key), 0);
    });

    scenario('RC-8: A\'s own trigger consumes A\'s own reply', () => {
        const mark = logs.length;
        const respFile = '/tmp/feedback_gate_response_rc-t-a2.json';
        try { fs.unlinkSync(respFile); } catch {} // never assert on a stale artefact
        seam.setCurrentTriggerData({ trigger_id: 'rc-t-a2', session_id: 'rc-A', message: 'A 的第二个问题' }, 5952);
        seam.processQueueForPendingTrigger(true, A.key);
        assert.strictEqual(seam.getPendingQueueCount(A.key), 1, 'exactly one reply consumed');
        createdTmpFiles.push(respFile);
        assert.ok(fs.existsSync(respFile), 'response file written for A\'s trigger');
        const resp = JSON.parse(fs.readFileSync(respFile, 'utf8'));
        assert.strictEqual(resp.response, A_TEXT_1, 'A\'s reply went to A\'s trigger');
        assert.ok(!sawLog('QUEUE_SESSION_MISMATCH', mark), 'no ownership rejection on the happy path');
    });

    // ── Phase 3: the input box (P3-2 / P3-4) ────────────────────────────────
    scenario('RC-9 (P3-2): an automatic switch is suppressed while the user composes in A', () => {
        const mark = logs.length;
        seam.switchToSession(A.key, true);            // user is looking at A
        assert.strictEqual(seam.getActiveSessionKey(), A.key);
        seam.noteComposition(A.key, true);            // …and typing
        assert.strictEqual(seam.isComposingElsewhere(A.key), false, 'not "elsewhere" for A itself');
        assert.strictEqual(seam.isComposingElsewhere(B.key), true, 'B is a different conversation');

        const switched = seam.switchToSession(B.key, false); // B's trigger wants the tab
        assert.strictEqual(switched, false, 'auto-switch refused');
        assert.strictEqual(seam.getActiveSessionKey(), A.key, 'still on A — the input box was not stolen');
        assert.ok(sawLog('SUPPRESSED — user is composing in', mark), 'the suppression was logged');
    });

    scenario('RC-10 (P3-2): a manual tab click always wins', () => {
        const switched = seam.switchToSession(B.key, true);
        assert.strictEqual(switched, true, 'manual switch allowed');
        assert.strictEqual(seam.getActiveSessionKey(), B.key);
        seam.switchToSession(A.key, true);
        assert.strictEqual(seam.getActiveSessionKey(), A.key);
    });

    scenario('RC-11 (P3-2): once the user stops composing, the auto-switch is allowed again', () => {
        seam.noteComposition(A.key, false);           // box cleared
        const switched = seam.switchToSession(B.key, false);
        assert.strictEqual(switched, true, 'nothing is being composed → auto-switch allowed');
        assert.strictEqual(seam.getActiveSessionKey(), B.key);
    });

    scenario('RC-12 (P3-4): a send without a sessionKey lands on the composing conversation', () => {
        // active tab is B…
        seam.noteComposition(A.key, true);            // …but the user is typing in A
        const target = seam.resolveSendSession('');
        assert.ok(target, 'resolved to a session');
        assert.strictEqual(target.key, A.key, 'attributed to the composing conversation, not the active tab');
        assert.strictEqual(seam.resolveSendSession(B.key).key, B.key, 'an explicit key is never re-attributed');
        seam.noteComposition('', false);
        assert.strictEqual(seam.resolveSendSession(''), null, 'no key + no composition → caller falls back');
    });

    scenario('RC-13: the ownership predicate shipped to all three consumers', () => {
        assert.strictEqual(seam.queueItemBelongsToConversation({ sessionId: 'rc-A' }, 'rc-A'), true);
        assert.strictEqual(seam.queueItemBelongsToConversation({ sessionId: 'rc-A' }, 'rc-B'), false);
        assert.strictEqual(seam.queueItemBelongsToConversation({ sessionId: '' }, 'rc-B'), true, 'legacy item');
        assert.strictEqual(seam.queueItemBelongsToConversation({ sessionId: 'rc-A' }, ''), true, 'legacy trigger');
        assert.strictEqual(seam.queueItemBelongsToConversation(null, 'rc-A'), false);
    });

    scenario('RC-14: no duplicate session_id invariant was violated at any point', () => {
        assert.ok(!sawLog('DUPLICATE_SESSION_ID'), 'two conversations never shared one session_id');
        assert.ok(!sawLog('SESSION_ID_MISMATCH!'), 'no session was ever re-labelled to a foreign identity');
    });

} catch (e) {
    if (stopCapture) stopCapture();
    console.error(`\n💥 harness error: ${e.stack || e.message}\n`);
    failed++;
    failures.push({ name: 'harness bootstrap', message: e.message });
} finally {
    if (stopCapture) stopCapture();
    for (const f of createdTmpFiles) { try { fs.unlinkSync(f); } catch {} }
    for (const tid of ['rc-t-u', 'rc-t-a1', 'rc-t-a2', 'rc-t-b1']) {
        try { fs.unlinkSync(`/tmp/feedback_gate_response_${tid}.json`); } catch {}
    }
    for (const sid of ['rc-U', 'rc-Z', 'rc-A', 'rc-B']) {
        try { fs.unlinkSync(`/tmp/feedback_gate_lease_${sid}.json`); } catch {}
    }
    try { fs.unlinkSync(SEAM_FILE); } catch {}
    if (stubWasAbsent) { try { fs.rmSync(VSCODE_STUB_DIR, { recursive: true, force: true }); } catch {} }
    delete global.__FG_REALCODE_VSCODE_STUB__;
}

console.log('\n🔬 Real-code intra-window harness (drives the shipped extension.js)\n');
report.forEach(line => console.log(line));
console.log('\n───────────────────────────────────────────────────────');
console.log(`Real-code intra-window: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(`  • ${f.name}: ${f.message}`));
}
console.log('');
process.exit(failed > 0 ? 1 : 0);
