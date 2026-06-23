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
            let changed = false;
            messageQueue.forEach(m => {
                if (m.status === 'processing') {
                    m.status = 'pending';
                    delete m.processingAt;
                    changed = true;
                }
                // On reload, stale sessionKeys would prevent messages from being
                // consumed since no in-memory session can match them.  Clear them
                // so the next trigger for this PID can pick them up.
                if (m.sessionKey) {
                    m._prevSessionKey = m.sessionKey;
                    m.sessionKey = '';
                    changed = true;
                }
            });
            messageQueue = messageQueue.filter(m => m.status !== 'done');
            if (changed || messageQueue.length !== (data.items || []).length) {
                saveQueue();
            }
        }
    } catch (e) {
        console.log(`Failed to load queue: ${e.message}`);
        if (messageQueue.length === 0) {
            messageQueue = [];
        }
    }
}

function saveQueue() {
    try {
        const queueFile = getQueueFilePath();
        const tmpFile = queueFile + '.tmp';
        fs.writeFileSync(tmpFile, JSON.stringify({ items: messageQueue }, null, 2));
        fs.renameSync(tmpFile, queueFile);
    } catch (e) {
        console.log(`Failed to save queue: ${e.message}`);
    }
}

function setActiveSessionKey(key) {
    _activeSessionKey = key || '';
}

function migrateSessionKey(fromKey, toKey) {
    let changed = false;
    messageQueue.forEach(m => {
        if (m.sessionKey === fromKey) {
            m.sessionKey = toKey;
            changed = true;
        }
    });
    if (changed) saveQueue();
}

function migrateOrphanSessionKeys(validKeys) {
    let changed = false;
    messageQueue.forEach(m => {
        if (m.sessionKey && !validKeys.has(m.sessionKey)) {
            m._prevSessionKey = m.sessionKey;
            m.sessionKey = '';
            changed = true;
        }
    });
    if (changed) {
        saveQueue();
        console.log('Feedback Gate queue: migrated orphan items to untagged');
    }
}

function syncToWebview(sessionKey) {
    if (_postToWebview) {
        const filterKey = sessionKey !== undefined ? sessionKey : _activeSessionKey;
        let items = messageQueue.filter(m => (m.status === 'pending' || m.status === 'processing') && !m._displayed);
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
        sessionKey: (meta?.sessionKey != null ? meta.sessionKey : _activeSessionKey) || '',
    };
    messageQueue.push(item);
    saveQueue();
    syncToWebview(item.sessionKey);
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

function requeueItem(id) {
    const item = messageQueue.find(m => m.id === id);
    if (item && item.status === 'processing') {
        item.status = 'pending';
        delete item.processingAt;
        saveQueue();
        syncToWebview(item.sessionKey);
    }
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
    const item = messageQueue.find(m => m.id === id);
    if (!item) return;
    const sk = item.sessionKey || '';
    const pendingItems = messageQueue.filter(m => m.status === 'pending' && (m.sessionKey || '') === sk);
    const idx = pendingItems.findIndex(m => m.id === id);
    if (idx === -1) return;
    
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= pendingItems.length) return;
    
    const actualIdx = messageQueue.indexOf(pendingItems[idx]);
    const actualTarget = messageQueue.indexOf(pendingItems[targetIdx]);
    
    [messageQueue[actualIdx], messageQueue[actualTarget]] = [messageQueue[actualTarget], messageQueue[actualIdx]];
    saveQueue();
    syncToWebview(sk);
}

function pinQueueItem(id) {
    const item = messageQueue.find(m => m.id === id);
    if (!item) return;
    const sk = item.sessionKey || '';
    const pendingItems = messageQueue.filter(m => m.status === 'pending' && (m.sessionKey || '') === sk);
    const idx = pendingItems.findIndex(m => m.id === id);
    if (idx <= 0) return;

    const actualIdx = messageQueue.indexOf(pendingItems[idx]);
    const firstPendingActualIdx = messageQueue.indexOf(pendingItems[0]);

    messageQueue.splice(actualIdx, 1);
    messageQueue.splice(firstPendingActualIdx, 0, item);
    saveQueue();
    syncToWebview(sk);
}

function editQueueItem(id, newText) {
    const item = messageQueue.find(m => m.id === id && m.status === 'pending');
    if (item) {
        item.text = newText;
        saveQueue();
        syncToWebview(item.sessionKey);
    }
}

function reorderQueue(orderedIds) {
    const sk = _activeSessionKey || '';
    const pendingInSession = messageQueue.filter(m => m.status === 'pending' && (m.sessionKey || '') === sk);
    const pendingMap = new Map();
    pendingInSession.forEach(m => pendingMap.set(m.id, m));

    const idSet = new Set(orderedIds);
    const reordered = orderedIds.map(id => pendingMap.get(id)).filter(Boolean);
    const rest = pendingInSession.filter(m => !idSet.has(m.id));

    const others = messageQueue.filter(m => !(m.status === 'pending' && (m.sessionKey || '') === sk));
    messageQueue = [...others, ...reordered, ...rest];
    saveQueue();
    syncToWebview(sk);
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
    saveQueue,
    enqueueMessage,
    dequeueMessage,
    requeueItem,
    markQueueItemDone,
    removeQueueItem,
    moveQueueItem,
    pinQueueItem,
    editQueueItem,
    reorderQueue,
    getPendingQueueCount,
    syncToWebview,
    setActiveSessionKey,
    migrateSessionKey,
    migrateOrphanSessionKeys,
};
