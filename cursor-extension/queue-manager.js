const fs = require('fs');
const { getTempPath } = require('./utils');

let messageQueue = [];
let _vscode = null;
let _postToWebview = null;
let _idCounter = 0;
let _activeSessionKey = '';

function init(vscode, postToWebviewFn) {
    _vscode = vscode;
    _postToWebview = postToWebviewFn;
}

function getQueueFilePath() {
    const workspaceId = _vscode && _vscode.workspace.workspaceFolders
        ? _vscode.workspace.workspaceFolders[0].uri.fsPath.replace(/[^a-zA-Z0-9]/g, '_').slice(-40)
        : 'default';
    return getTempPath(`feedback_gate_queue_${workspaceId}_pid${process.pid}.json`);
}

function loadQueue() {
    try {
        const queueFile = getQueueFilePath();
        if (fs.existsSync(queueFile)) {
            const data = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
            messageQueue = data.items || [];
            messageQueue.forEach(m => {
                if (m.status === 'processing') {
                    m.status = 'pending';
                    delete m.processingAt;
                }
            });
            messageQueue = messageQueue.filter(m => m.status !== 'done');
            saveQueue();
        }
    } catch (e) {
        console.log(`Failed to load queue: ${e.message}`);
        messageQueue = [];
    }
}

function saveQueue() {
    try {
        const queueFile = getQueueFilePath();
        fs.writeFileSync(queueFile, JSON.stringify({ items: messageQueue }, null, 2));
    } catch (e) {
        console.log(`Failed to save queue: ${e.message}`);
    }
}

function setActiveSessionKey(key) {
    _activeSessionKey = key || '';
}

function syncToWebview(sessionKey) {
    if (_postToWebview) {
        const filterKey = sessionKey !== undefined ? sessionKey : _activeSessionKey;
        let items = messageQueue.filter(m => m.status === 'pending' || m.status === 'processing');
        if (filterKey) {
            items = items.filter(m => m.sessionKey === filterKey);
        } else {
            items = items.filter(m => !m.sessionKey);
        }
        _postToWebview({
            command: 'syncQueue',
            items,
            pendingCount: items.filter(m => m.status === 'pending').length
        });
    }
}

function generateId() {
    const now = Date.now();
    _idCounter++;
    return now * 1000 + (_idCounter % 1000);
}

const QUEUE_IMAGE_MAX_B64_LEN = 5 * 1024 * 1024;

function enqueueMessage(text, attachments, files, meta) {
    const safeAttachments = (attachments || []).map(att => {
        const largeField = att.base64Data || att.dataUrl || att.data;
        if (largeField && largeField.length > QUEUE_IMAGE_MAX_B64_LEN) {
            const cleaned = { ...att, originalSize: largeField.length };
            if (att.base64Data) cleaned.base64Data = '[TOO_LARGE_FOR_QUEUE]';
            if (att.dataUrl) cleaned.dataUrl = '[TOO_LARGE_FOR_QUEUE]';
            if (att.data) cleaned.data = '[TOO_LARGE_FOR_QUEUE]';
            return cleaned;
        }
        return att;
    });

    const item = {
        id: generateId(),
        text: text,
        attachments: safeAttachments,
        files: files || [],
        status: 'pending',
        timestamp: new Date().toISOString(),
        source: meta?.source || 'local',
        sourceLabel: meta?.sourceLabel || '',
        chatId: meta?.chatId || '',
        sessionKey: meta?.sessionKey || '',
    };
    messageQueue.push(item);
    saveQueue();
    syncToWebview(meta?.sessionKey);
    return item;
}

function dequeueMessage(sessionKey) {
    recoverStaleProcessing();
    const idx = messageQueue.findIndex(m => {
        if (m.status !== 'pending') return false;
        if (sessionKey) {
            return m.sessionKey === sessionKey;
        }
        return !m.sessionKey;
    });
    if (idx === -1) return null;
    messageQueue[idx].status = 'processing';
    messageQueue[idx].processingAt = Date.now();
    saveQueue();
    syncToWebview(sessionKey);
    return messageQueue[idx];
}

function recoverStaleProcessing() {
    const STALE_MS = 10000;
    let changed = false;
    messageQueue.forEach(m => {
        if (m.status === 'processing' && m.processingAt && (Date.now() - m.processingAt > STALE_MS)) {
            m.status = 'pending';
            delete m.processingAt;
            changed = true;
        }
    });
    if (changed) saveQueue();
}

function markQueueItemDone(id) {
    const item = messageQueue.find(m => m.id === id);
    if (item) {
        const sk = item.sessionKey;
        item.status = 'done';
        messageQueue = messageQueue.filter(m => m.status !== 'done');
        saveQueue();
        syncToWebview(sk);
    }
}

function removeQueueItem(id) {
    const item = messageQueue.find(m => m.id === id);
    const sk = item ? item.sessionKey : undefined;
    messageQueue = messageQueue.filter(m => m.id !== id);
    saveQueue();
    syncToWebview(sk);
}

function moveQueueItem(id, direction) {
    const pendingItems = messageQueue.filter(m => m.status === 'pending');
    const idx = pendingItems.findIndex(m => m.id === id);
    if (idx === -1) return;
    
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= pendingItems.length) return;
    
    const actualIdx = messageQueue.indexOf(pendingItems[idx]);
    const actualTarget = messageQueue.indexOf(pendingItems[targetIdx]);
    
    [messageQueue[actualIdx], messageQueue[actualTarget]] = [messageQueue[actualTarget], messageQueue[actualIdx]];
    saveQueue();
    syncToWebview();
}

function pinQueueItem(id) {
    const pendingItems = messageQueue.filter(m => m.status === 'pending');
    const idx = pendingItems.findIndex(m => m.id === id);
    if (idx <= 0) return;

    const item = pendingItems[idx];
    const actualIdx = messageQueue.indexOf(item);
    const firstPendingActualIdx = messageQueue.indexOf(pendingItems[0]);

    messageQueue.splice(actualIdx, 1);
    messageQueue.splice(firstPendingActualIdx, 0, item);
    saveQueue();
    syncToWebview();
}

function editQueueItem(id, newText) {
    const item = messageQueue.find(m => m.id === id && m.status === 'pending');
    if (item) {
        item.text = newText;
        saveQueue();
        syncToWebview();
    }
}

function reorderQueue(orderedIds) {
    const pendingMap = new Map();
    messageQueue.filter(m => m.status === 'pending').forEach(m => pendingMap.set(m.id, m));
    
    const nonPending = messageQueue.filter(m => m.status !== 'pending');
    const reordered = orderedIds.map(id => pendingMap.get(id)).filter(Boolean);
    
    messageQueue = [...nonPending, ...reordered];
    saveQueue();
    syncToWebview();
}

function getPendingQueueCount(sessionKey) {
    recoverStaleProcessing();
    let pending = messageQueue.filter(m => m.status === 'pending');
    if (sessionKey) {
        pending = pending.filter(m => m.sessionKey === sessionKey);
    } else {
        pending = pending.filter(m => !m.sessionKey);
    }
    return pending.length;
}

module.exports = {
    init,
    loadQueue,
    enqueueMessage,
    dequeueMessage,
    markQueueItemDone,
    removeQueueItem,
    moveQueueItem,
    pinQueueItem,
    editQueueItem,
    reorderQueue,
    getPendingQueueCount,
    syncToWebview,
    setActiveSessionKey,
};
