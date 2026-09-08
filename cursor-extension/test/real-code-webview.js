#!/usr/bin/env node
/**
 * Real-code harness for the WEBVIEW half of the intra-window defect (P3-2 / P3-3 / P3-4).
 *
 * Like test/real-code-intrawindow.js, this does NOT mirror logic: it renders the
 * real cursor-extension/webview-template.js HTML, extracts the shipped inner
 * <script>, evaluates it verbatim (plus an appended test seam) against a minimal
 * DOM shim, and then drives it the way the extension does — through the real
 * `window.addEventListener('message', …)` router and the real input listeners.
 *
 * Verified behaviours (contract §11 IW5–IW11):
 *   • composition state is reported to the extension with the session the user is
 *     typing in (that is what lets the extension suppress an auto tab switch),
 *   • a broadcast tagged with another conversation is never rendered here,
 *   • typed text + attachments survive a tab switch and come back on return,
 *   • a send always carries the pinned sessionKey, not whichever tab is active.
 *
 * Run: node cursor-extension/test/real-code-webview.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const EXT_DIR = path.join(__dirname, '..');

let passed = 0;
let failed = 0;
const failures = [];
const report = [];

async function scenario(name, fn) {
    try {
        await fn();
        passed++;
        report.push(`  ✓ ${name}`);
    } catch (e) {
        failed++;
        failures.push({ name, message: e.message });
        report.push(`  ✗ ${name}\n      ${e.message}`);
    }
}

// ── minimal DOM shim ──────────────────────────────────────────────────────────
class FakeElement {
    constructor(id, tag) {
        this.id = id || '';
        this.tagName = String(tag || 'div').toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.value = '';
        this.textContent = '';
        this.innerHTML = '';
        this.className = '';
        this.disabled = false;
        this.style = {};
        this.dataset = {};
        this.scrollTop = 0;
        this.scrollHeight = 0;
        this.clientHeight = 0;
        this._listeners = {};
        this._attrs = {};
        this._classes = new Set(String(this.className).split(/\s+/).filter(Boolean));
        const self = this;
        this.classList = {
            add: (...c) => c.forEach(x => self._classes.add(x)),
            remove: (...c) => c.forEach(x => self._classes.delete(x)),
            contains: (c) => self._classes.has(c),
            toggle: (c) => (self._classes.has(c) ? self._classes.delete(c) : self._classes.add(c)),
        };
    }
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
    removeEventListener(type, fn) {
        this._listeners[type] = (this._listeners[type] || []).filter(f => f !== fn);
    }
    dispatch(type, ev = {}) {
        const event = Object.assign({
            target: this, currentTarget: this,
            preventDefault() {}, stopPropagation() {},
            clipboardData: { items: [], files: [], getData: () => '' },
            key: '', ctrlKey: false, metaKey: false, shiftKey: false,
        }, ev);
        (this._listeners[type] || []).slice().forEach(fn => fn(event));
        return event;
    }
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
    insertBefore(child) { this.children.unshift(child); child.parentNode = this; return child; }
    removeChild(child) { this.children = this.children.filter(c => c !== child); return child; }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    setAttribute(k, v) { this._attrs[k] = String(v); }
    getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; }
    removeAttribute(k) { delete this._attrs[k]; }
    hasAttribute(k) { return k in this._attrs; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    closest() { return null; }
    contains() { return false; }
    focus() { this._focused = true; }
    blur() { this._focused = false; }
    click() { this.dispatch('click'); }
    scrollIntoView() {}
    setSelectionRange() {}
    get firstChild() { return this.children[0] || null; }
    get lastChild() { return this.children[this.children.length - 1] || null; }
}

function buildDom() {
    const byId = new Map();
    const messageHandlers = [];
    const documentShim = {
        hidden: false,
        getElementById(id) {
            if (!byId.has(id)) byId.set(id, new FakeElement(id, 'div'));
            return byId.get(id);
        },
        createElement(tag) { return new FakeElement('', tag); },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        addEventListener(type, fn) {
            if (type === 'message') messageHandlers.push(fn);
        },
    };
    documentShim.body = new FakeElement('body', 'body');
    const windowShim = {
        innerWidth: 1200,
        innerHeight: 800,
        devicePixelRatio: 1,
        addEventListener(type, fn) {
            if (type === 'message') messageHandlers.push(fn);
        },
        open() {},
        requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
    };
    return { byId, messageHandlers, documentShim, windowShim };
}

// ── load the REAL webview script ──────────────────────────────────────────────
function loadRealWebview() {
    const { getFeedbackGateHTML } = require(path.join(EXT_DIR, 'webview-template.js'));
    const html = getFeedbackGateHTML('realcode-test', true);
    const m = html.match(/<script>([\s\S]*)<\/script>/);
    assert.ok(m, 'webview template produced no <script> block');
    const script = m[1];

    const dom = buildDom();
    const posted = [];

    const sandbox = {
        document: dom.documentShim,
        window: dom.windowShim,
        navigator: { userAgent: 'node', clipboard: { writeText: async () => {} } },
        acquireVsCodeApi: () => ({
            postMessage: (msg) => { posted.push(Object.assign({}, msg)); },
            setState: () => {}, getState: () => null,
        }),
        console: { log() {}, warn() {}, error() {}, info() {} },
        setTimeout, clearTimeout, setInterval, clearInterval,
        Date, Math, JSON, Object, Array, String, Number, Boolean, Map, Set, WeakMap, Promise, RegExp, Error,
        encodeURIComponent, decodeURIComponent, escape: global.escape, unescape: global.unescape,
        URL, Blob: class Blob {}, FileReader: class FileReader { readAsDataURL() {} },
        location: { href: 'vscode-webview://test' },
        alert() {},
        globalThis: null,
    };
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;

    const seam = `
;globalThis.__seam = {
    getState: () => ({
        currentSessionKey: currentSessionKey,
        inputSessionKey: inputSessionKey,
        inputValue: messageInput.value,
        attachedImages: attachedImages.map(i => i.fileName),
        attachedFiles: attachedFiles.map(f => f.fileName),
        codeReferences: codeReferences.map(c => c.filePath),
        renderedMessages: messagesContainer.children.length,
        inputDisabled: !!messageInput.disabled,
    }),
    setInput: (v) => { messageInput.value = v; },
    dispatchInput: () => { (messageInput._listeners['input'] || []).forEach(fn => fn({ target: messageInput, preventDefault() {} })); },
    dispatchKeydown: (key, opts) => {
        (messageInput._listeners['keydown'] || []).forEach(fn => fn(Object.assign(
            { key: key, target: messageInput, preventDefault() {}, stopPropagation() {} }, opts || {})));
    },
    sendMessage: sendMessage,
    isForeignSessionMessage: isForeignSessionMessage,
    reportComposition: reportComposition,
    stashComposition: stashComposition,
    restoreComposition: restoreComposition,
    handleImageUploaded: handleImageUploaded,
    messageInput: messageInput,
    messagesContainer: messagesContainer,
};
`;
    vm.createContext(sandbox);
    vm.runInContext(script + seam, sandbox, { filename: 'webview-inner-script.js' });
    const seamApi = sandbox.__seam;
    assert.ok(seamApi, 'webview seam did not load — the shipped script could not be evaluated');

    // drive the webview exactly like the extension does
    const fire = (message) => {
        dom.messageHandlers.slice().forEach(h => h({ data: message }));
    };
    return { seam: seamApi, fire, posted, dom };
}

// ── main ─────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let webview = null;

async function main() {
try {
    webview = loadRealWebview();
    const { seam, fire, posted } = webview;
    const lastPost = (command) => {
        for (let i = posted.length - 1; i >= 0; i--) if (posted[i].command === command) return posted[i];
        return null;
    };
    const countPosts = (command) => posted.filter(p => p.command === command).length;

    await scenario('WV-1: loadSession puts the webview on that conversation', () => {
        fire({ command: 'loadSession', sessionKey: 'sess_A', label: '#1 A 脚本', messages: [], draft: '', hasPendingTrigger: false });
        assert.strictEqual(seam.getState().currentSessionKey, 'sess_A');
    });

    await scenario('WV-2 (P3-2): typing reports compositionChanged with the session being typed in', () => {
        seam.setInput('帮我把这个脚本改成 Python');
        seam.dispatchInput();
        const msg = lastPost('compositionChanged');
        assert.ok(msg, 'a compositionChanged message was posted');
        assert.strictEqual(msg.sessionKey, 'sess_A', 'reported against the conversation being typed in');
        assert.strictEqual(msg.hasText, true);
    });

    await scenario('WV-3 (P3-2): clearing the box reports hasText=false', () => {
        seam.setInput('');
        seam.dispatchInput();
        const msg = lastPost('compositionChanged');
        assert.strictEqual(msg.hasText, false, 'the extension may auto-switch again');
    });

    await scenario('WV-4 (P3-3): a broadcast tagged with another conversation is NOT rendered', () => {
        const before = seam.getState().renderedMessages;
        fire({ command: 'addMessage', sessionKey: 'sess_B', text: 'B 的问题（不该出现在 A 里）', type: 'system' });
        fire({ command: 'newMessage', sessionKey: 'sess_B', text: 'B 的问题（不该出现在 A 里）' });
        assert.strictEqual(seam.getState().renderedMessages, before, 'foreign message dropped');
        assert.ok(seam.isForeignSessionMessage({ sessionKey: 'sess_B' }), 'the shipped predicate flags it');
        assert.ok(!seam.isForeignSessionMessage({ sessionKey: 'sess_A' }), 'own message is not foreign');
        assert.ok(!seam.isForeignSessionMessage({}), 'untagged legacy message is not foreign');
    });

    await scenario('WV-5 (P3-3): own and legacy broadcasts ARE rendered', () => {
        const before = seam.getState().renderedMessages;
        fire({ command: 'addMessage', sessionKey: 'sess_A', text: 'A 自己的系统消息', type: 'system' });
        assert.strictEqual(seam.getState().renderedMessages, before + 1, 'own message rendered');
        fire({ command: 'addMessage', text: '无 sessionKey 的历史消息', type: 'system' });
        assert.strictEqual(seam.getState().renderedMessages, before + 2, 'legacy message still rendered');
    });

    await scenario('WV-6 (P3-3): an extension-initiated switch keeps text + attachments for later', () => {
        seam.setInput('A 的未发送草稿');
        seam.dispatchInput();
        fire({ command: 'imageUploaded', imageData: { fileName: 'a-screenshot.png', dataUrl: 'data:image/png;base64,AAAA', size: 4 } });
        fire({ command: 'fileAttached', fileData: { fileName: 'notes.md', filePath: '/tmp/notes.md', isDirectory: false } });
        let st = seam.getState();
        assert.strictEqual(st.inputSessionKey, 'sess_A', 'typing pinned the send target to A');
        assert.strictEqual(JSON.stringify(st.attachedImages), JSON.stringify(['a-screenshot.png']));
        assert.strictEqual(JSON.stringify(st.attachedFiles), JSON.stringify(['notes.md']));

        // the extension flips the tab to B on its own; the router must stash A first
        fire({ command: 'loadSession', sessionKey: 'sess_B', label: '#2 B 脚本', messages: [], draft: 'B 的草稿', hasPendingTrigger: true });
        st = seam.getState();
        assert.strictEqual(st.currentSessionKey, 'sess_B');
        assert.strictEqual(st.inputValue, 'B 的草稿', 'B shows its own draft');
        assert.strictEqual(JSON.stringify(st.attachedImages), '[]', 'A\'s attachment is not shown in B');

        // …and back to A
        fire({ command: 'loadSession', sessionKey: 'sess_A', label: '#1 A 脚本', messages: [], draft: '', hasPendingTrigger: false });
        st = seam.getState();
        assert.strictEqual(st.currentSessionKey, 'sess_A');
        assert.strictEqual(st.inputValue, 'A 的未发送草稿', 'A\'s typed text came back');
        assert.strictEqual(JSON.stringify(st.attachedImages), JSON.stringify(['a-screenshot.png']), 'A\'s image came back');
        assert.strictEqual(JSON.stringify(st.attachedFiles), JSON.stringify(['notes.md']), 'A\'s file came back');
        assert.strictEqual(st.inputSessionKey, 'sess_A', 'the send target is re-pinned to A');
    });

    await scenario('WV-7 (P3-3): the tab-click stash path round-trips too', () => {
        seam.setInput('A 的第二段草稿');
        seam.stashComposition('sess_A');          // exactly what the tab click handler does
        fire({ command: 'loadSession', sessionKey: 'sess_B', label: '#2 B 脚本', messages: [], draft: '', hasPendingTrigger: false });
        assert.strictEqual(seam.getState().inputValue, 'B 的草稿',
            'B gets its own stashed draft back — the router stashes whichever conversation is left');
        fire({ command: 'loadSession', sessionKey: 'sess_A', label: '#1 A 脚本', messages: [], draft: 'server-draft', hasPendingTrigger: false });
        assert.strictEqual(seam.getState().inputValue, 'A 的第二段草稿',
            'the client-side stash beats the text-only server draft');
    });

    await scenario('WV-8 (P3-4): a send always carries a sessionKey — pinned first, visible tab second', async () => {
        fire({ command: 'loadSession', sessionKey: 'sess_A', label: '#1 A 脚本', messages: [], draft: '', hasPendingTrigger: false });
        seam.setInput('A 的回复内容');
        seam.dispatchInput();
        let postsBefore = countPosts('send');
        seam.sendMessage();
        assert.strictEqual(countPosts('send'), postsBefore + 1, 'a send was posted');
        let sent = lastPost('send');
        assert.strictEqual(sent.sessionKey, 'sess_A', 'attributed to the conversation being typed in');
        assert.strictEqual(sent.text, 'A 的回复内容');

        // the shipped 300ms send lock swallows an immediate double-send
        seam.setInput('手抖又按了一次');
        seam.sendMessage();
        assert.strictEqual(countPosts('send'), postsBefore + 1, 'double-send is still locked out');
        await sleep(320);

        // on B with no prior typing, the visible tab decides (and it is never '')
        fire({ command: 'loadSession', sessionKey: 'sess_B', label: '#2 B 脚本', messages: [], draft: '', hasPendingTrigger: true });
        seam.setInput('B 的回复内容');
        postsBefore = countPosts('send');
        seam.sendMessage();
        assert.strictEqual(countPosts('send'), postsBefore + 1, 'a send was posted for B');
        sent = lastPost('send');
        assert.strictEqual(sent.sessionKey, 'sess_B', 'attributed to B');
        assert.ok(sent.sessionKey !== '', 'never an empty sessionKey while two conversations exist');
    });

    await scenario('WV-9: sending clears the composition and its stash entry', () => {
        const st = seam.getState();
        assert.strictEqual(st.inputValue, '', 'input cleared after send');
        assert.strictEqual(st.inputSessionKey, null, 'pin released after send');
        assert.strictEqual(JSON.stringify(st.attachedImages), '[]', 'attachments cleared after send');
        // switching away and back must not resurrect the already-sent text
        fire({ command: 'loadSession', sessionKey: 'sess_A', label: '#1 A 脚本', messages: [], draft: '', hasPendingTrigger: false });
        fire({ command: 'loadSession', sessionKey: 'sess_B', label: '#2 B 脚本', messages: [], draft: '', hasPendingTrigger: false });
        assert.strictEqual(seam.getState().inputValue, '', 'sent text is not restored');
    });

    await scenario('WV-10: syncTabs from the extension does not disturb the composition', () => {
        fire({ command: 'loadSession', sessionKey: 'sess_A', label: '#1 A 脚本', messages: [], draft: '', hasPendingTrigger: false });
        seam.setInput('正在输入的新内容');
        seam.dispatchInput();
        fire({
            command: 'syncTabs',
            activeKey: 'sess_A',
            tabs: [
                { key: 'sess_A', label: '#1 A 脚本', hasPendingTrigger: false, isActive: true, lastMessage: '' },
                { key: 'sess_B', label: '#2 B 脚本', hasPendingTrigger: true, isActive: false, lastMessage: '' },
            ],
        });
        assert.strictEqual(seam.getState().inputValue, '正在输入的新内容', 'typing survives a tab-bar refresh');
        assert.strictEqual(seam.getState().currentSessionKey, 'sess_A');
    });

} catch (e) {
    report.push(`  ✗ harness bootstrap\n      ${e.stack || e.message}`);
    failed++;
    failures.push({ name: 'harness bootstrap', message: e.message });
}
}

function printReport() {
console.log('\n🔬 Real-code webview harness (drives the shipped webview-template.js script)\n');
report.forEach(line => console.log(line));
console.log('\n───────────────────────────────────────────────────────');
console.log(`Real-code webview: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(`  • ${f.name}: ${f.message}`));
}
console.log('');
process.exit(failed > 0 ? 1 : 0);
}

main().then(printReport, printReport);
