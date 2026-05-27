const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const { getTempPath, getMimeType } = require('./utils');
const queue = require('./queue-manager');
const { getFeedbackGateHTML } = require('./webview-template');

function isProcessAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) {
        return e.code !== 'ESRCH';
    }
}

let chatPanel = null;
let chatViewProvider = null;
let sidebarViewProvider = null;
let feedbackGateWatcher = null;
let outputChannel = null;
let mcpStatus = false;
let firstTriggerReceived = false;
let lastTriggerTime = 0;
const SESSION_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
let statusCheckInterval = null;
let currentTriggerData = null;
let boundMcpPids = new Set();
let usePanelView = true;
let feedbackGateEnabled = true;
let statusBarItem = null;
const processedTriggerIds = new Set();

// ── Multi-conversation Session Management ──────────
// Cursor shares a single MCP process across conversations in the same window.
// We use PID + creation timestamp as the session key, and route new triggers to
// the correct session using a 3-phase heuristic (recent-reply > idle > new).
const sessions = new Map(); // sessionKey → SessionState
let activeSessionKey = null;
let sessionCounter = 0;

function createSessionKey(mcpPid, timestamp, counter) {
    return `${mcpPid}_${timestamp}_${counter}`;
}

function _buildTabLabel(index, text, attachments) {
    let content = '';
    if (text) {
        content = text.replace(/\n/g, ' ').slice(0, 20);
        if (text.length > 20) content += '…';
    } else if (attachments && attachments.length > 0) {
        content = attachments.length > 1 ? `📷 图片 ×${attachments.length}` : '📷 图片';
    }
    return content ? `#${index} ${content}` : `#${index}`;
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
        label: `#${sessionCounter}`,
        triggerData: null,
        messages: [],
        draft: '',
        attachedImages: [],
        attachedFiles: [],
        codeReferences: [],
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        lastResponseTime: 0,
        pendingRemoteReply: null,
    };
    sessions.set(key, session);
    console.log(`Feedback Gate: session created key=${key} index=#${sessionCounter} sessionId=${sessionId || 'none'}`);
    return session;
}

function getSessionByMcpPid(mcpPid) {
    for (const session of sessions.values()) {
        if (session.mcpPid === mcpPid) return session;
    }
    return null;
}

function getAllSessionsByMcpPid(mcpPid) {
    const result = [];
    for (const session of sessions.values()) {
        if (session.mcpPid === mcpPid) result.push(session);
    }
    return result;
}

function getOrCreateSessionForTrigger(mcpPid, sessionId) {
    const now = Date.now();

    // Phase 0: exact session_id + PID match
    if (sessionId) {
        for (const s of sessions.values()) {
            if (s.sessionId === sessionId && s.mcpPid === mcpPid) {
                s.lastActiveAt = now;
                return s;
            }
        }
        // Unknown session_id — always create a new session.
        // With the "one conversation = one session_id" rule, an unknown
        // session_id means a genuinely new conversation, not a rotation.
        // Idle-session adoption is reserved for the no-session_id legacy path.
        return createSession(mcpPid, now, sessionId);
    }

    // No session_id — only use heuristics when there's exactly ONE session for this PID.
    // Multiple sessions without session_id = ambiguous → always create new.
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
        // Single session but has pending trigger → new concurrent conversation
        return createSession(mcpPid, now);
    }

    // Multiple sessions without session_id → cannot safely route.
    // Create new session to avoid cross-talk.
    return createSession(mcpPid, now);
}

function getOrCreateSession(mcpPid) {
    let session = getSessionByMcpPid(mcpPid);
    if (session) {
        session.lastActiveAt = Date.now();
        return session;
    }
    let pidTimestamp = Date.now();
    try {
        const pidFile = getTempPath(`feedback_gate_mcp_${mcpPid}.pid`);
        if (fs.existsSync(pidFile)) {
            const data = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
            if (data.timestamp) pidTimestamp = new Date(data.timestamp).getTime();
        }
    } catch {}
    return createSession(mcpPid, pidTimestamp);
}

function getActiveSession() {
    if (!activeSessionKey) return null;
    return sessions.get(activeSessionKey) || null;
}

let lastManualSwitchAt = 0;
const MANUAL_SWITCH_GUARD_MS = 10000;

function switchToSession(sessionKey, isManual) {
    if (activeSessionKey === sessionKey) return;
    const session = sessions.get(sessionKey);
    if (!session) return;

    if (isManual) lastManualSwitchAt = Date.now();

    activeSessionKey = sessionKey;
    queue.setActiveSessionKey(sessionKey);
    session.lastActiveAt = Date.now();

    syncSessionToWebview(session);
    syncTabsToWebview();
    syncQueueToWebview(sessionKey);
    console.log(`Feedback Gate: switched to session ${sessionKey} (${session.label}) ${isManual ? '[manual]' : '[auto]'}`);
}

function syncSessionToWebview(session) {
    if (!session) return;
    broadcastToAllWebviews({
        command: 'loadSession',
        sessionKey: session.key,
        label: session.label,
        messages: session.messages,
        draft: session.draft,
        hasPendingTrigger: !!session.triggerData,
    });
}

function syncTabsToWebview() {
    const tabs = [];
    for (const s of sessions.values()) {
        tabs.push({
            key: s.key,
            label: s.label,
            hasPendingTrigger: !!s.triggerData,
            isActive: s.key === activeSessionKey,
            lastMessage: s.messages.length > 0
                ? s.messages[s.messages.length - 1].text.slice(0, 30)
                : '',
        });
    }
    broadcastToAllWebviews({ command: 'syncTabs', tabs, activeKey: activeSessionKey });
}

function cleanupStaleSessions() {
    const now = Date.now();
    const toRemove = [];
    for (const [key, session] of sessions) {
        const age = now - session.lastActiveAt;
        const processAlive = isProcessAlive(session.mcpPid);

        if (session.triggerData) {
            // Has pending trigger — only clean if MCP process is dead
            if (!processAlive) {
                toRemove.push(key);
            }
            // Process alive → conversation is still waiting, never clean
            continue;
        }

        // No pending trigger
        if (!processAlive && age > 2 * 60 * 1000) {
            // Process dead + 2 min grace → clean
            toRemove.push(key);
        } else if (processAlive && age > 60 * 60 * 1000) {
            // Process alive but 60 min idle without trigger → clean
            toRemove.push(key);
        }
    }
    for (const key of toRemove) {
        console.log(`Feedback Gate: cleaning stale session ${key}`);
        queue.migrateSessionKey(key, '');
        sessions.delete(key);
        if (activeSessionKey === key) {
            const next = findNextPendingSession();
            activeSessionKey = next ? next.key : (sessions.size > 0 ? sessions.keys().next().value : null);
            queue.setActiveSessionKey(activeSessionKey || '');
        }
    }
    if (toRemove.length > 0) syncTabsToWebview();
}

function findNextPendingSession() {
    for (const session of sessions.values()) {
        if (session.triggerData && session.key !== activeSessionKey) {
            return session;
        }
    }
    return null;
}

function addMessageToSession(sessionKey, msg) {
    const session = sessions.get(sessionKey);
    if (!session) return;
    session.messages.push(msg);
    // Cap messages at 200 per session
    if (session.messages.length > 200) {
        session.messages = session.messages.slice(-200);
    }
    // If this is the active session, also push to webview
    if (sessionKey === activeSessionKey) {
        broadcastToAllWebviews({
            command: 'addMessage',
            text: msg.text,
            type: msg.type,
            plain: msg.plain || false,
            attachments: msg.attachments,
            files: msg.files,
        });
    }
}

// Backward compat: get currentTriggerData from active session
function getCurrentTriggerData() {
    const session = getActiveSession();
    return session ? session.triggerData : currentTriggerData;
}

function setCurrentTriggerData(triggerData, mcpPid) {
    if (mcpPid) {
        const sessionId = (triggerData && triggerData.session_id) || '';
        const session = getOrCreateSessionForTrigger(mcpPid, sessionId);
        session.triggerData = triggerData;
        session.lastActiveAt = Date.now();
        if (sessionId && !session.sessionId) {
            session.sessionId = sessionId;
        }
        // Name the tab from the latest interaction content
        if (triggerData && triggerData.message) {
            session.label = _buildTabLabel(session.index, triggerData.message);
            session._labelSource = 'agent';
        }
        return session;
    }
    currentTriggerData = triggerData;
    return null;
}

function clearSessionTrigger(sessionKey) {
    const session = sessions.get(sessionKey);
    if (session) {
        const tid = session.triggerData && session.triggerData.trigger_id;
        session.triggerData = null;
        session.lastResponseTime = Date.now();
        session.lastActiveAt = Date.now();
        if (currentTriggerData && currentTriggerData.trigger_id === tid) {
            currentTriggerData = null;
        }
    } else {
        currentTriggerData = null;
    }
    syncTabsToWebview();
}

// ── IDE Queue (remote /ide messages) ───────────────
const EXTENSION_PID = process.pid;
const IDE_QUEUE_PATH = getTempPath(`feedback_gate_ide_queue_${EXTENSION_PID}.jsonl`);
const IDE_QUEUE_GLOBAL_PATH = getTempPath('feedback_gate_ide_queue.jsonl');
const IDE_QUEUE_GLOBAL_PROCESSING_PATH = IDE_QUEUE_GLOBAL_PATH + '.processing';
const IDE_SESSION_PATH = getTempPath(`feedback_gate_session_${EXTENSION_PID}.json`);
const extensionActivatedAt = Date.now();

const SOURCE_LABELS = {
    feishu: '飞书',
    dingtalk: '钉钉',
    wecom: '企微',
    wechat: '微信',
};

// ── IDE Reply (V2 bidirectional feedback) ──────────
const IDE_REPLY_PATH = getTempPath('feedback_gate_ide_reply.jsonl');
let pendingRemoteReply = null;

// Queue delegates — initialized in activate()
const enqueueMessage = (...args) => queue.enqueueMessage(...args);
const dequeueMessage = (sessionKey) => queue.dequeueMessage(sessionKey);
const markQueueItemDone = (id) => queue.markQueueItemDone(id);
const removeQueueItem = (id) => queue.removeQueueItem(id);
const moveQueueItem = (id, dir) => queue.moveQueueItem(id, dir);
const pinQueueItem = (id) => queue.pinQueueItem(id);
const editQueueItem = (id, t) => queue.editQueueItem(id, t);
const reorderQueue = (ids) => queue.reorderQueue(ids);
const getPendingQueueCount = (sessionKey) => queue.getPendingQueueCount(sessionKey);
const syncQueueToWebview = (sessionKey) => queue.syncToWebview(sessionKey);

function closeSessionByKey(key) {
    if (!key) return;
    const toClose = sessions.get(key);
    if (!toClose || toClose.triggerData) return;
    queue.migrateSessionKey(key, '');
    sessions.delete(key);
    if (activeSessionKey === key) {
        const next = findNextPendingSession() || (sessions.size > 0 ? sessions.values().next().value : null);
        activeSessionKey = next ? next.key : null;
        queue.setActiveSessionKey(activeSessionKey || '');
        if (next) syncSessionToWebview(next);
    }
    syncTabsToWebview();
    syncQueueToWebview(activeSessionKey || '');
}

function getPreferredLocation() {
    try {
        return vscode.workspace.getConfiguration('feedbackGate').get('defaultLocation', 'panel');
    } catch { return 'panel'; }
}

function getActiveWebview() {
    const pref = getPreferredLocation();
    if (pref === 'sidebar' && sidebarViewProvider && sidebarViewProvider._view && sidebarViewProvider._view.webview) {
        return sidebarViewProvider._view.webview;
    }
    if (pref === 'panel' && usePanelView && chatViewProvider && chatViewProvider._view && chatViewProvider._view.webview) {
        return chatViewProvider._view.webview;
    }
    if (chatViewProvider && chatViewProvider._view && chatViewProvider._view.webview) {
        return chatViewProvider._view.webview;
    }
    if (sidebarViewProvider && sidebarViewProvider._view && sidebarViewProvider._view.webview) {
        return sidebarViewProvider._view.webview;
    }
    if (chatPanel && chatPanel.webview) return chatPanel.webview;
    return null;
}

function postToWebview(message) {
    const webview = getActiveWebview();
    if (webview) {
        webview.postMessage(message);
        return true;
    }
    const pref = getPreferredLocation();
    const provider = (pref === 'sidebar' ? sidebarViewProvider : chatViewProvider) || sidebarViewProvider || chatViewProvider;
    if (provider) {
        provider._pendingMessages.push(message);
    }
    return false;
}

function broadcastToAllWebviews(message) {
    const cmd = message && message.command;
    const isChat = cmd === 'addMessage' || cmd === 'newMessage' || cmd === 'focus' || cmd === 'syncQueue';
    if (isChat) {
        return postToWebview(message);
    }

    let sent = false;
    if (chatViewProvider && chatViewProvider._view && chatViewProvider._view.webview) {
        chatViewProvider._view.webview.postMessage(message);
        sent = true;
    }
    if (sidebarViewProvider && sidebarViewProvider._view && sidebarViewProvider._view.webview) {
        sidebarViewProvider._view.webview.postMessage(message);
        sent = true;
    }
    if (chatPanel && chatPanel.webview) {
        chatPanel.webview.postMessage(message);
        sent = true;
    }
    if (!sent) {
        const pref = getPreferredLocation();
        const provider = (pref === 'sidebar' ? sidebarViewProvider : chatViewProvider) || sidebarViewProvider || chatViewProvider;
        if (provider) {
            provider._pendingMessages.push(message);
        }
    }
    return sent;
}

class FeedbackGatePanelProvider {
    constructor(context, viewId) {
        this._context = context;
        this._viewId = viewId;
        this._view = null;
        this._pendingMessages = [];
        this._mcpIntegration = true;
        this._currentSpecialHandling = null;
    }

    resolveWebviewView(webviewView) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true
        };

        webviewView.webview.html = getFeedbackGateHTML("Feedback Gate", false);

        webviewView.webview.onDidReceiveMessage(
            webviewMessage => {
                const activeSession = getActiveSession();
                const activeTrigger = activeSession ? activeSession.triggerData : currentTriggerData;
                const currentTriggerId = (activeTrigger && activeTrigger.trigger_id) || null;
                switch (webviewMessage.command) {
                    case 'send': {
                        const rawSessionKey = (webviewMessage.sessionKey != null ? webviewMessage.sessionKey : activeSessionKey) || '';
                        const sendSession = (rawSessionKey ? sessions.get(rawSessionKey) : null) || activeSession;
                        const sendSessionKey = sendSession ? sendSession.key : '';
                        if (sendSession) sendSession.pendingRemoteReply = null;
                        else if (activeSession) activeSession.pendingRemoteReply = null;
                        else pendingRemoteReply = null;
                        enqueueMessage(webviewMessage.text, webviewMessage.attachments, webviewMessage.files, {
                            sessionKey: sendSessionKey,
                        });
                        logUserInput(`Queued: ${webviewMessage.text}`, 'QUEUED', null);
                        const sendTrigger = sendSession ? sendSession.triggerData : null;
                        if (sendTrigger && sendTrigger.trigger_id) {
                            processQueueForPendingTrigger(true, sendSession.key);
                        }
                        break;
                    }
                    case 'switchSession':
                        if (webviewMessage.sessionKey) {
                            if (activeSession && webviewMessage.draft !== undefined) {
                                activeSession.draft = webviewMessage.draft || '';
                            }
                            switchToSession(webviewMessage.sessionKey, true);
                        }
                        break;
                    case 'closeSession':
                        closeSessionByKey(webviewMessage.sessionKey);
                        break;
                    case 'removeQueueItem':
                        removeQueueItem(webviewMessage.itemId);
                        break;
                    case 'editQueueItem':
                        editQueueItem(webviewMessage.itemId, webviewMessage.newText);
                        break;
                    case 'cancelEditQueueItem':
                        syncQueueToWebview(activeSessionKey || '');
                        break;
                    case 'saveDraft':
                        if (webviewMessage.sessionKey) {
                            const draftSession = sessions.get(webviewMessage.sessionKey);
                            if (draftSession) draftSession.draft = webviewMessage.draft || '';
                        }
                        break;
                    case 'moveQueueItem':
                        moveQueueItem(webviewMessage.itemId, webviewMessage.direction);
                        break;
                    case 'pinQueueItem':
                        pinQueueItem(webviewMessage.itemId);
                        break;
                    case 'reorderQueue':
                        reorderQueue(webviewMessage.orderedIds);
                        break;
                    case 'attach':
                        logUserInput('User clicked attachment button', 'ATTACHMENT_CLICK', currentTriggerId);
                        handleFileAttachment(currentTriggerId);
                        break;
                    case 'uploadImage':
                        logUserInput('User clicked image upload button', 'IMAGE_UPLOAD_CLICK', currentTriggerId);
                        handleImageUpload(currentTriggerId);
                        break;
                    case 'logPastedImage':
                        logUserInput(`Image pasted from clipboard: ${webviewMessage.fileName} (${webviewMessage.size} bytes, ${webviewMessage.mimeType})`, 'IMAGE_PASTED', currentTriggerId);
                        break;
                    case 'logDragDropImage':
                        logUserInput(`Image dropped from drag and drop: ${webviewMessage.fileName} (${webviewMessage.size} bytes, ${webviewMessage.mimeType})`, 'IMAGE_DROPPED', currentTriggerId);
                        break;
                    case 'logImageRemoved':
                        logUserInput(`Image removed: ${webviewMessage.imageId}`, 'IMAGE_REMOVED', currentTriggerId);
                        break;
                    case 'dropFile':
                        handleDroppedFile(webviewMessage.filePath, currentTriggerId);
                        break;
                    case 'showError':
                        vscode.window.showErrorMessage(webviewMessage.message);
                        break;
                    case 'ready': {
                        const hasAnyTrigger = [...sessions.values()].some(s => s.triggerData) || !!currentTriggerData;
                        if (this._pendingMessages.length > 0) {
                            webviewView.webview.postMessage({
                                command: 'updateMcpStatus',
                                active: true,
                                hasPendingTrigger: hasAnyTrigger
                            });
                            for (const msg of this._pendingMessages) {
                                webviewView.webview.postMessage(msg);
                            }
                            this._pendingMessages = [];
                        } else {
                            webviewView.webview.postMessage({
                                command: 'updateMcpStatus',
                                active: mcpStatus,
                                hasPendingTrigger: hasAnyTrigger
                            });
                        }
                        syncQueueToWebview(activeSessionKey || '');
                        syncTabsToWebview();
                        if (activeSessionKey) {
                            const s = sessions.get(activeSessionKey);
                            if (s) syncSessionToWebview(s);
                        }
                        break;
                    }
                }
            },
            undefined,
            this._context.subscriptions
        );

        webviewView.onDidDispose(() => {
            this._view = null;
        });
    }

    isReady() {
        return !!(this._view && this._view.webview);
    }

    async focusView() {
        try {
            await vscode.commands.executeCommand(`${this._viewId}.focus`);
            return true;
        } catch (e) {
            console.log(`Failed to focus view ${this._viewId}: ${e.message}`);
            return false;
        }
    }
}

function updateStatusBarItem() {
    if (!statusBarItem) return;
    if (feedbackGateEnabled) {
        statusBarItem.text = "$(circle-filled) FeedBack";
        statusBarItem.tooltip = "Feedback Gate: 已启用 (点击切换)";
        statusBarItem.color = "#4EC9B0";
        statusBarItem.backgroundColor = undefined;
    } else {
        statusBarItem.text = "$(circle-outline) FeedBack";
        statusBarItem.tooltip = "Feedback Gate: 已禁用 - 自动放行 (点击切换)";
        statusBarItem.color = undefined;
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
}

function activate(context) {
    console.log('Feedback Gate extension is now active in Cursor for MCP integration!');
    
    // Create output channel for logging
    outputChannel = vscode.window.createOutputChannel('Feedback Gate');
    context.subscriptions.push(outputChannel);
    
    console.log('Feedback Gate extension activated for Cursor MCP integration');
    console.log(`Feedback Gate: EXTENSION_PID=${EXTENSION_PID}, IDE_QUEUE_PATH=${IDE_QUEUE_PATH}`);

    // Register command to open Feedback Gate manually
    let disposable = vscode.commands.registerCommand('feedbackGate.openChat', () => {
        openFeedbackGatePopup(context, {
            message: "欢迎使用 Feedback Gate！请提供你的审查反馈。",
            title: "Feedback Gate"
        });
    });

    context.subscriptions.push(disposable);


    // Register command to add code reference from editor selection
    context.subscriptions.push(
        vscode.commands.registerCommand('feedbackGate.addCodeReference', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('没有活动的编辑器');
                return;
            }
            const selection = editor.selection;
            if (selection.isEmpty) {
                vscode.window.showWarningMessage('请先选中一段代码');
                return;
            }
            const document = editor.document;
            const workspaceFolders = vscode.workspace.workspaceFolders;
            const wsRoot = workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : '';
            let filePath = document.uri.fsPath;
            if (wsRoot && filePath.startsWith(wsRoot)) {
                filePath = filePath.slice(wsRoot.length).replace(/^[/\\]/, '');
            }

            const codeRef = {
                filePath: filePath,
                absolutePath: document.uri.fsPath,
                startLine: selection.start.line + 1,
                endLine: selection.end.line + 1,
                content: document.getText(selection),
                language: document.languageId,
            };

            broadcastToAllWebviews({
                command: 'addCodeReference',
                codeRef: codeRef,
            });

            const pref = getPreferredLocation();
            const provider = (pref === 'sidebar' ? sidebarViewProvider : chatViewProvider) || chatViewProvider || sidebarViewProvider;
            if (provider) provider.focusView();
        })
    );

    // Register bottom panel WebviewViewProvider
    try {
        chatViewProvider = new FeedbackGatePanelProvider(context, 'feedbackGate.chatView');
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider('feedbackGate.chatView', chatViewProvider, {
                webviewOptions: { retainContextWhenHidden: true }
            })
        );
        console.log('Feedback Gate: bottom panel view registered');
    } catch (e) {
        console.log(`Feedback Gate: bottom panel registration failed, using editor tab fallback: ${e.message}`);
        usePanelView = false;
    }

    // Register sidebar WebviewViewProvider (Activity Bar)
    try {
        sidebarViewProvider = new FeedbackGatePanelProvider(context, 'feedbackGate.sidebarView');
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider('feedbackGate.sidebarView', sidebarViewProvider, {
                webviewOptions: { retainContextWhenHidden: true }
            })
        );
        console.log('Feedback Gate: sidebar view registered');
    } catch (e) {
        console.log(`Feedback Gate: sidebar registration failed: ${e.message}`);
    }

    // Restore persisted toggle state
    feedbackGateEnabled = context.globalState.get('feedbackGateEnabled', true);

    // Auto-enable on the 1st of each month after 12:00
    function checkMonthlyAutoEnable() {
        const now = new Date();
        if (now.getDate() === 1 && now.getHours() >= 12 && !feedbackGateEnabled) {
            const lastAutoEnable = context.globalState.get('feedbackGateLastAutoEnable', '');
            const thisMonth = `${now.getFullYear()}-${now.getMonth()}`;
            if (lastAutoEnable !== thisMonth) {
                feedbackGateEnabled = true;
                context.globalState.update('feedbackGateEnabled', true);
                context.globalState.update('feedbackGateLastAutoEnable', thisMonth);
                updateStatusBarItem();
                vscode.window.showInformationMessage('Feedback Gate 已自动启用（每月 1 号定时恢复）');
                console.log('Feedback Gate: auto-enabled on monthly schedule');
            }
        }
    }
    checkMonthlyAutoEnable();

    // Status bar toggle button
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'feedbackGate.toggle';
    updateStatusBarItem();
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    context.subscriptions.push(
        vscode.commands.registerCommand('feedbackGate.toggle', () => {
            feedbackGateEnabled = !feedbackGateEnabled;
            context.globalState.update('feedbackGateEnabled', feedbackGateEnabled);
            updateStatusBarItem();
            vscode.window.showInformationMessage(
                feedbackGateEnabled ? 'Feedback Gate 已启用' : 'Feedback Gate 已禁用（自动放行模式）'
            );
            if (!feedbackGateEnabled) {
                const pendingTriggers = [];
                for (const session of sessions.values()) {
                    if (session.triggerData && session.triggerData.trigger_id) {
                        pendingTriggers.push(session.triggerData.trigger_id);
                        session.triggerData = null;
                    }
                }
                if (currentTriggerData && currentTriggerData.trigger_id) {
                    pendingTriggers.push(currentTriggerData.trigger_id);
                    currentTriggerData = null;
                }
                for (const triggerId of pendingTriggers) {
                    const responseFile = getTempPath(`feedback_gate_response_${triggerId}.json`);
                    if (!fs.existsSync(responseFile)) {
                        fs.writeFileSync(responseFile, JSON.stringify({
                            response: "TASK_COMPLETE",
                            auto_response: true,
                            feedback_gate_disabled: true,
                            timestamp: new Date().toISOString(),
                            trigger_id: triggerId
                        }, null, 2));
                        console.log(`Feedback Gate: auto-responded TASK_COMPLETE for pending trigger ${triggerId}`);
                    }
                }
                syncTabsToWebview();
                updateChatPanelStatus();
            }
        })
    );

    // Initialize modules
    queue.init(vscode, broadcastToAllWebviews);

    // Recover any leftover IDE queue .processing file from a previous crash
    recoverIdeQueueProcessing();

    // Start MCP status monitoring immediately
    startMcpStatusMonitoring(context);

    // Start Feedback Gate integration immediately
    startFeedbackGateIntegration(context);
    
    // Load persisted queue
    queue.loadQueue();
    
    vscode.window.showInformationMessage('Feedback Gate 已激活！等待 MCP 工具调用即可。');
}

function logMessage(message) {
    const timestamp = new Date().toISOString();
    const logMsg = `[${timestamp}] ${message}`;
    console.log(logMsg);
    if (outputChannel) {
        outputChannel.appendLine(logMsg);
        // Don't auto-show output channel to avoid stealing focus
    }
}

function writeResponseForTrigger(triggerId, queueItem, source) {
    const responseData = {
        timestamp: new Date().toISOString(),
        trigger_id: triggerId,
        user_input: queueItem.text,
        response: queueItem.text,
        message: queueItem.text,
        attachments: queueItem.attachments || [],
        files: enrichFiles(queueItem.files),
        event_type: 'MCP_RESPONSE',
        source,
        queue_item_id: queueItem.id
    };
    const responseJson = JSON.stringify(responseData, null, 2);
    let written = false;
    const primaryPath = getTempPath(`feedback_gate_response_${triggerId}.json`);
    const tmpPath = primaryPath + '.tmp';
    try {
        fs.writeFileSync(tmpPath, responseJson);
        fs.renameSync(tmpPath, primaryPath);
        written = true;
    } catch (e) {
        console.log(`Feedback Gate: CRITICAL response write failed for ${triggerId}: ${e.message}`);
        try { fs.unlinkSync(tmpPath); } catch {}
    }
    try {
        const fallbackPath = getTempPath('feedback_gate_response.json');
        const tmpFallback = fallbackPath + '.tmp';
        fs.writeFileSync(tmpFallback, responseJson);
        fs.renameSync(tmpFallback, fallbackPath);
    } catch (e) {}
    if (!written) {
        queueItem.status = 'pending';
        delete queueItem.processingAt;
        queue.saveQueue();
        processedTriggerIds.delete(triggerId);
        console.log(`Feedback Gate: recovered queue item "${queueItem.text}" — response write failed`);
    }
    return written;
}

function enrichFiles(files) {
    return (files || []).map(f => {
        try {
            if (f.filePath && fs.existsSync(f.filePath)) {
                const stats = fs.statSync(f.filePath);
                if (stats.size <= 100 * 1024) {
                    return { ...f, content: fs.readFileSync(f.filePath, 'utf8') };
                }
                return { ...f, content: `[File too large: ${(stats.size / 1024).toFixed(1)} KB]` };
            }
        } catch (e) { /* skip unreadable files */ }
        return f;
    });
}

function logUserInput(inputText, eventType = 'MESSAGE', triggerId = null, attachments = [], files = []) {
    const timestamp = new Date().toISOString();
    const logMsg = `[${timestamp}] ${eventType}: ${inputText}`;
    console.log(`FEEDBACK GATE USER INPUT: ${inputText}`);
    
    if (outputChannel) {
        outputChannel.appendLine(logMsg);
    }
    
    try {
        const logFile = getTempPath('feedback_gate_user_inputs.log');
        fs.appendFileSync(logFile, `${logMsg}\n`);
    } catch (error) {
        logMessage(`Could not write to Feedback Gate log file: ${error.message}`);
    }
}

function startMcpStatusMonitoring(context) {
    // Silent start - no logging to avoid focus stealing
    
    // Check MCP status every 2 seconds
    statusCheckInterval = setInterval(() => {
        checkMcpStatus();
    }, 2000);
    
    // Initial check
    checkMcpStatus();
    
    // Clean up on extension deactivation
    context.subscriptions.push({
        dispose: () => {
            if (statusCheckInterval) {
                clearInterval(statusCheckInterval);
            }
        }
    });
}

function checkMcpStatus() {
    try {
        const now = Date.now();
        let active = false;

        for (const logName of ['feedback_gate.log', 'feedback_gate_v2.log']) {
            const logPath = getTempPath(logName);
            if (fs.existsSync(logPath)) {
                const age = now - fs.statSync(logPath).mtime.getTime();
                if (age < 30000) { active = true; break; }
            }
        }

        if (!active) {
            for (const pid of boundMcpPids) {
                try {
                    process.kill(pid, 0);
                    active = true;
                    break;
                } catch {}
            }
        }

        const wasActive = mcpStatus;
        mcpStatus = active && firstTriggerReceived;
        if (wasActive !== mcpStatus) updateChatPanelStatus();
    } catch (error) {
        if (mcpStatus) {
            mcpStatus = false;
            updateChatPanelStatus();
        }
    }
}

function updateChatPanelStatus() {
    // Only report pending trigger for the currently active session, not any session.
    // Other sessions' pending state is shown via tab dots/glow, not the input box.
    const active = getActiveSession();
    const hasTrigger = active ? !!active.triggerData : !!currentTriggerData;
    const msg = {
        command: 'updateMcpStatus',
        active: mcpStatus,
        hasPendingTrigger: hasTrigger
    };
    // Broadcast status to all live views
    if (chatViewProvider && chatViewProvider._view && chatViewProvider._view.webview) {
        chatViewProvider._view.webview.postMessage(msg);
    }
    if (sidebarViewProvider && sidebarViewProvider._view && sidebarViewProvider._view.webview) {
        sidebarViewProvider._view.webview.postMessage(msg);
    }
    if (chatPanel && chatPanel.webview) {
        chatPanel.webview.postMessage(msg);
    }
}

function discoverMcpPids() {
    /**
     * Discover ALL MCP server PIDs that belong to THIS Cursor window.
     *
     * A single Cursor window can have multiple agent conversations, each spawning
     * its own MCP server process. All share the same extension-host parent (process.pid).
     * We return a Set of all alive MCP PIDs whose PPID matches ours.
     */
    const discovered = new Set();
    try {
        const tempDir = process.platform === 'win32' ? os.tmpdir() : '/tmp';
        const files = fs.readdirSync(tempDir).filter(f => f.startsWith('feedback_gate_mcp_') && f.endsWith('.pid'));
        
        if (files.length === 0) return discovered;
        
        const myPid = process.pid;
        const entries = files
            .map(f => {
                const fullPath = path.join(tempDir, f);
                try {
                    const stat = fs.statSync(fullPath);
                    const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
                    return { file: f, fullPath, pid: data.pid, ppid: data.ppid, mtime: stat.mtime.getTime() };
                } catch { return null; }
            })
            .filter(Boolean);
        
        for (const entry of entries) {
            if (entry.ppid === myPid) {
                try {
                    process.kill(entry.pid, 0);
                    discovered.add(entry.pid);
                } catch {
                    try { fs.unlinkSync(entry.fullPath); } catch {}
                }
            }
        }
        
        // Fallback: old PID files without ppid field — add newest alive process
        if (discovered.size === 0) {
            const sorted = entries
                .filter(e => !e.ppid)
                .sort((a, b) => b.mtime - a.mtime);
            
            for (const entry of sorted) {
                try {
                    process.kill(entry.pid, 0);
                    discovered.add(entry.pid);
                    console.log(`Feedback Gate: fallback bound to MCP PID ${entry.pid} (no PPID in file)`);
                    break;
                } catch {
                    try { fs.unlinkSync(entry.fullPath); } catch {}
                }
            }
        }
    } catch (e) {
        console.log(`MCP PID discovery error: ${e.message}`);
    }
    if (discovered.size > 0 && discovered.size !== boundMcpPids.size) {
        console.log(`Feedback Gate: discovered ${discovered.size} MCP PIDs: [${[...discovered].join(', ')}]`);
    }
    return discovered;
}

// ── IDE Queue processing ───────────────────────────

function recoverIdeQueueProcessing() {
    try {
        const dir = path.dirname(IDE_QUEUE_PATH);
        const base = path.basename(IDE_QUEUE_PATH);
        const procMarker = `${base}.processing`;
        let files = [];
        try {
            files = fs.readdirSync(dir);
        } catch {
            return;
        }
        for (const f of files) {
            if (f !== procMarker && !f.startsWith(`${procMarker}.`)) continue;
            const full = path.join(dir, f);
            let isFile = false;
            try {
                isFile = fs.statSync(full).isFile();
            } catch {
                continue;
            }
            if (!isFile) continue;
            console.log('Feedback Gate: recovering leftover IDE queue processing file', f);
            consumeIdeQueueFile(full);
        }
    } catch {}
}

function clearLegacyIdeQueueProcessingIfPresent() {
    try {
        if (fs.existsSync(IDE_QUEUE_GLOBAL_PROCESSING_PATH)) {
            console.log('Feedback Gate: clearing legacy IDE queue .processing file');
            consumeIdeQueueFile(IDE_QUEUE_GLOBAL_PROCESSING_PATH);
        }
    } catch {}
}

function checkIdeQueueFile() {
    clearLegacyIdeQueueProcessingIfPresent();
    consumeQueueIfExists(IDE_QUEUE_PATH);
    consumeQueueIfExists(IDE_QUEUE_GLOBAL_PATH);
}

function consumeQueueIfExists(queuePath) {
    let processingPath;
    try {
        if (!fs.existsSync(queuePath)) return;
        processingPath = `${queuePath}.processing.${EXTENSION_PID}.${Date.now()}.${Math.random().toString(36).slice(2, 9)}`;
        fs.renameSync(queuePath, processingPath);
    } catch (e) {
        console.log(`Feedback Gate: IDE queue rename failed for ${queuePath}: ${e.message}`);
        return;
    }
    console.log(`Feedback Gate: consuming IDE queue from ${path.basename(queuePath)}`);
    consumeIdeQueueFile(processingPath);
}

function consumeIdeQueueFile(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n').filter(l => l.trim());
        let count = 0;
        let stale = 0;

        for (const line of lines) {
            try {
                const item = JSON.parse(line);
                if (!item.text) continue;

                if (item.ts && new Date(item.ts).getTime() < extensionActivatedAt) {
                    stale++;
                    continue;
                }

                // Route remote messages to the session that's waiting for a reply,
                // falling back to the active session if none is waiting.
                const pendingSession = findNextPendingSession();
                const remoteSessionKey = pendingSession ? pendingSession.key : (activeSessionKey || '');
                enqueueMessage(item.text, [], [], {
                    source: item.source,
                    sourceLabel: SOURCE_LABELS[item.source] || item.source,
                    chatId: item.chatId,
                    sessionKey: remoteSessionKey,
                });
                count++;

                const label = SOURCE_LABELS[item.source] || item.source || '远程';
                broadcastToAllWebviews({
                    command: 'addMessage',
                    text: `📨 来自${label}的消息已入队: ${item.text}`,
                    type: 'system',
                    plain: true
                });
            } catch {}
        }

        fs.unlinkSync(filePath);
        if (count > 0 || stale > 0) {
            console.log(`Feedback Gate: consumed ${count} IDE queue message(s), discarded ${stale} stale`);
        }
        const pendingForQueue = findNextPendingSession();
        if (count > 0 && pendingForQueue && pendingForQueue.triggerData && pendingForQueue.triggerData.trigger_id) {
            processQueueForPendingTrigger(true, pendingForQueue.key);
        } else {
            const activeTrigger = getCurrentTriggerData();
            if (count > 0 && activeTrigger && activeTrigger.trigger_id) {
                processQueueForPendingTrigger(true);
            }
        }
    } catch (e) {
        try { fs.unlinkSync(filePath); } catch {}
    }
}

// ── IDE Reply (V2 bidirectional) ───────────────────

function maybeWriteOutbox(agentMessage) {
    if (!pendingRemoteReply) return;
    if (!agentMessage || agentMessage.trim().length < 1) return;

    const MAX_LEN = 500;
    const truncated = agentMessage.length > MAX_LEN
        ? agentMessage.slice(0, MAX_LEN) + '\n\n...（在 IDE 中查看完整内容）'
        : agentMessage;

    try {
        const entry = JSON.stringify({
            chatId: pendingRemoteReply.chatId,
            platform: pendingRemoteReply.source,
            originalText: pendingRemoteReply.originalText || '',
            agentMessage: truncated,
            ts: new Date().toISOString()
        });
        fs.appendFileSync(IDE_REPLY_PATH, entry + '\n');
        pendingRemoteReply = null;
    } catch {}
}

function registerIdeSession() {
    try {
        const folders = vscode.workspace.workspaceFolders;
        const project = folders && folders.length > 0
            ? path.basename(folders[0].uri.fsPath)
            : 'unknown';
        const cwd = folders && folders.length > 0
            ? folders[0].uri.fsPath
            : '';
        const data = {
            pid: EXTENSION_PID,
            project,
            cwd,
            ts: new Date().toISOString()
        };
        fs.writeFileSync(IDE_SESSION_PATH, JSON.stringify(data));
        console.log(`Feedback Gate: IDE session registered (pid=${EXTENSION_PID}, project=${project})`);
    } catch (e) {
        console.log(`Feedback Gate: failed to register IDE session: ${e.message}`);
    }
}

function unregisterIdeSession() {
    try { fs.unlinkSync(IDE_SESSION_PATH); } catch {}
    try { fs.unlinkSync(IDE_QUEUE_PATH); } catch {}
}

function cleanupOrphanPidFiles() {
    try {
        const dir = path.dirname(getTempPath('x'));
        const prefix = 'feedback_gate_mcp_';
        for (const f of fs.readdirSync(dir).filter(f => f.startsWith(prefix) && f.endsWith('.pid'))) {
            try {
                const fullPath = path.join(dir, f);
                const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
                if (data.ppid) {
                    try { process.kill(data.ppid, 0); } catch {
                        try {
                            process.kill(data.pid, 15);
                            fs.unlinkSync(fullPath);
                            console.log(`Feedback Gate: cleaned orphan MCP pid=${data.pid} (parent ${data.ppid} dead)`);
                        } catch {}
                    }
                }
            } catch {}
        }

        const sessionPrefix = 'feedback_gate_session_';
        const maxAge = 4 * 3600 * 1000;
        for (const f of fs.readdirSync(dir).filter(f => f.startsWith(sessionPrefix) && f.endsWith('.json'))) {
            try {
                const fullPath = path.join(dir, f);
                const pidMatch = f.match(/session_(\d+)\.json$/);
                if (!pidMatch) continue;
                const sessionPid = parseInt(pidMatch[1], 10);
                if (sessionPid === EXTENSION_PID) continue;
                try { process.kill(sessionPid, 0); } catch {
                    fs.unlinkSync(fullPath);
                    console.log(`Feedback Gate: cleaned stale session (pid=${sessionPid}, process dead)`);
                    continue;
                }
                const stat = fs.statSync(fullPath);
                if (Date.now() - stat.mtimeMs > maxAge) {
                    fs.unlinkSync(fullPath);
                    console.log(`Feedback Gate: cleaned expired session (pid=${sessionPid}, age>${maxAge/3600000}h)`);
                }
            } catch {}
        }
    } catch {}
}

function startFeedbackGateIntegration(context) {
    cleanupOrphanPidFiles();
    
    boundMcpPids = discoverMcpPids();
    if (boundMcpPids.size > 0) {
        console.log(`Feedback Gate bound to MCP PIDs: [${[...boundMcpPids].join(', ')}]`);
    }
    
    const pollInterval = setInterval(() => {
        // Re-discover all MCP PIDs belonging to this window on every poll cycle.
        // This is cheap (readdir + stat) and ensures we pick up new conversations
        // as well as prune dead ones.
        boundMcpPids = discoverMcpPids();
        
        for (const pid of boundMcpPids) {
            checkTriggerFile(context, getTempPath(`feedback_gate_trigger_pid${pid}.json`));
        }
        checkTriggerFile(context, getTempPath('feedback_gate_trigger.json'));
        checkIdeQueueFile();
        // Expire stale pendingRemoteReply (30 minutes)
        if (pendingRemoteReply && Date.now() - pendingRemoteReply.enqueuedAt > 30 * 60 * 1000) {
            pendingRemoteReply = null;
        }
        // Clean up stale conversation sessions periodically
        if (!cleanupStaleSessions._lastRun || Date.now() - cleanupStaleSessions._lastRun > 60000) {
            cleanupStaleSessions._lastRun = Date.now();
            cleanupStaleSessions();
        }
        // Expire idle session after 2h without any trigger
        if (firstTriggerReceived && lastTriggerTime > 0
            && ![...sessions.values()].some(s => s.triggerData) && !currentTriggerData
            && Date.now() - lastTriggerTime > SESSION_IDLE_TIMEOUT_MS) {
            firstTriggerReceived = false;
            lastTriggerTime = 0;
            unregisterIdeSession();
            mcpStatus = false;
            updateChatPanelStatus();
            console.log('Feedback Gate: session expired — idle for 2h');
        }
    }, 250);
    
    feedbackGateWatcher = pollInterval;
    
    context.subscriptions.push({
        dispose: () => {
            if (pollInterval) {
                clearInterval(pollInterval);
            }
        }
    });
    
    setTimeout(() => {
        boundMcpPids = discoverMcpPids();
        for (const pid of boundMcpPids) {
            checkTriggerFile(context, getTempPath(`feedback_gate_trigger_pid${pid}.json`));
        }
        checkTriggerFile(context, getTempPath('feedback_gate_trigger.json'));
    }, 100);
    
    vscode.window.showInformationMessage('Feedback Gate MCP 集成就绪！正在监听 Cursor 工具调用…');
}

function checkTriggerFile(context, filePath) {
    try {
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            const triggerData = JSON.parse(data);
            
            // Check if this is for Cursor and Feedback Gate
            if (triggerData.editor && triggerData.editor !== 'cursor') {
                return;
            }
            
            if (triggerData.system && triggerData.system !== 'feedback-gate' && triggerData.system !== 'feedback-gate-v2') {
                return;
            }
            
            // Skip triggers with routing info — those are for cursor-remote-control, not VS Code
            if (triggerData.routing && (triggerData.routing.chat_id || triggerData.routing.platform)) {
                return;
            }
            
            // Instance isolation: only consume triggers that belong to this Cursor window.
            // Match by PPID (the MCP's parent process should be our extension-host PID),
            // or by boundMcpPids set if already established.
            const triggerPid = triggerData.pid;
            const triggerPpid = triggerData.ppid;
            const myPid = process.pid;
            
            // If trigger has PPID info, use it for precise matching
            if (triggerPpid && triggerPpid !== myPid) {
                // This trigger belongs to a different Cursor window — leave it alone
                return;
            }
            
            if (triggerPid && !boundMcpPids.has(triggerPid)) {
                if (triggerPpid === myPid) {
                    boundMcpPids.add(triggerPid);
                    console.log(`Feedback Gate: added MCP PID ${triggerPid} (PPID match)`);
                } else if (boundMcpPids.size === 0) {
                    try {
                        process.kill(triggerPid, 0);
                        boundMcpPids.add(triggerPid);
                        console.log(`Feedback Gate: fallback added MCP PID ${triggerPid} (legacy)`);
                    } catch {
                        try { fs.unlinkSync(filePath); } catch {}
                        return;
                    }
                } else {
                    return;
                }
            }
            
            const triggerId = triggerData.data && triggerData.data.trigger_id;
            if (triggerId && processedTriggerIds.has(triggerId)) {
                try { fs.unlinkSync(filePath); } catch {}
                return;
            }
            
            lastTriggerTime = Date.now();
            if (!firstTriggerReceived) {
                firstTriggerReceived = true;
                updateChatPanelStatus();
            }
            registerIdeSession();
            console.log(`Feedback Gate triggered: ${triggerData.data.tool} (PID: ${triggerPid})`);
            
            // Auto-passthrough when disabled
            if (!feedbackGateEnabled) {
                if (triggerId) {
                    const responseFile = getTempPath(`feedback_gate_response_${triggerId}.json`);
                    fs.writeFileSync(responseFile, JSON.stringify({
                        response: "TASK_COMPLETE",
                        auto_response: true,
                        feedback_gate_disabled: true,
                        timestamp: new Date().toISOString(),
                        trigger_id: triggerId
                    }, null, 2));
                }
                try { fs.unlinkSync(filePath); } catch {}
                console.log('Feedback Gate disabled — auto-passthrough sent');
                return;
            }
            
            // Check queue first: if messages waiting, auto-respond with queue head.
            // Only match target session by session_id (precise) or single-session scenarios.
            // Never guess across multiple sessions — messages stay in their session queue.
            const targetSessionId = (triggerData.data && triggerData.data.session_id) || '';
            let targetSession = null;
            let targetMatchedBySessionId = false;
            if (targetSessionId) {
                for (const s of sessions.values()) { if (s.sessionId === targetSessionId && (!triggerPid || s.mcpPid === triggerPid)) { targetSession = s; targetMatchedBySessionId = true; break; } }
            }
            if (!targetSession && !targetSessionId && triggerPid) {
                const pidSessions = getAllSessionsByMcpPid(triggerPid);
                if (pidSessions.length === 1) {
                    targetSession = pidSessions[0];
                }
            }
            const targetSessionKey = targetSession ? targetSession.key : '';
            let shouldAutoConsume = false;
            if (targetSession && targetMatchedBySessionId) {
                shouldAutoConsume = getPendingQueueCount(targetSessionKey) > 0 && !targetSession.triggerData;
            } else if (targetSession && !targetSessionId) {
                // PID fallback (no session_id) — only safe when this is the sole session
                shouldAutoConsume = getPendingQueueCount(targetSessionKey) > 0 && !targetSession.triggerData;
            } else if (!targetSession && !targetSessionId) {
                // No session matched, no session_id — consume untagged messages only
                const anySessionHasTrigger = [...sessions.values()].some(s => s.triggerData);
                shouldAutoConsume = getPendingQueueCount('') > 0 && !anySessionHasTrigger && !currentTriggerData;
            } else if (!targetSession && targetSessionId) {
                // Has session_id but no matching session yet (first trigger or session was cleaned).
                // Check for untagged queue messages that were enqueued before any session existed.
                const anySessionHasTrigger = [...sessions.values()].some(s => s.triggerData);
                shouldAutoConsume = getPendingQueueCount('') > 0 && !anySessionHasTrigger && !currentTriggerData;
            }
            if (shouldAutoConsume) {
                const queueItem = dequeueMessage(targetSessionKey);
                if (queueItem) {
                    const session = targetSession || (triggerPid ? getOrCreateSessionForTrigger(triggerPid, targetSessionId) : null);
                    if (queueItem.source && queueItem.source !== 'local' && queueItem.chatId) {
                        const rr = { chatId: queueItem.chatId, source: queueItem.source, originalText: queueItem.text || '', enqueuedAt: Date.now() };
                        if (session) session.pendingRemoteReply = rr;
                        else pendingRemoteReply = rr;
                    } else {
                        if (session) session.pendingRemoteReply = null;
                        else pendingRemoteReply = null;
                    }

                    const qTriggerId = triggerData.data && triggerData.data.trigger_id;
                    if (qTriggerId) {
                        if (!writeResponseForTrigger(qTriggerId, queueItem, 'feedback_gate_queue')) {
                            return;
                        }
                        markQueueItemDone(queueItem.id);
                        sendExtensionAcknowledgement(qTriggerId, triggerData.data.tool);
                        
                        const agentMsg = triggerData.data.message || triggerData.data.prompt || '';
                        if (session) {
                            if (agentMsg) {
                                addMessageToSession(session.key, { text: agentMsg, type: 'system' });
                                maybeWriteOutbox(agentMsg);
                            }
                            addMessageToSession(session.key, { text: queueItem.text, type: 'user', attachments: queueItem.attachments, files: queueItem.files });
                            if (queueItem.text || (queueItem.attachments && queueItem.attachments.length > 0)) {
                                session.label = _buildTabLabel(session.index, queueItem.text, queueItem.attachments);
                                session._labelSource = 'user';
                            }
                            const sourceTag = queueItem.sourceLabel
                                ? `⚡ 已从队列自动发送（来自${queueItem.sourceLabel}）`
                                : '⚡ 已从队列自动发送';
                            addMessageToSession(session.key, { text: sourceTag, type: 'system', plain: true });
                        } else {
                            if (agentMsg) {
                                broadcastToAllWebviews({ command: 'newMessage', text: agentMsg, type: 'system', toolData: triggerData.data, mcpIntegration: false });
                                maybeWriteOutbox(agentMsg);
                            }
                            broadcastToAllWebviews({ command: 'addMessage', text: queueItem.text, type: 'user', attachments: queueItem.attachments, files: queueItem.files });
                            const sourceTag = queueItem.sourceLabel
                                ? `⚡ 已从队列自动发送（来自${queueItem.sourceLabel}）`
                                : '⚡ 已从队列自动发送';
                            broadcastToAllWebviews({ command: 'addMessage', text: sourceTag, type: 'system', plain: true });
                        }
                    } else {
                        if (!triggerPid) pendingRemoteReply = null;
                        queueItem.status = 'pending';
                        delete queueItem.processingAt;
                        queue.saveQueue();
                        console.log(`Feedback Gate: recovered queue item "${queueItem.text}" — no trigger_id, falling through to popup`);
                    }
                    if (triggerId) {
                        processedTriggerIds.add(triggerId);
                        if (processedTriggerIds.size > 50) {
                            const first = processedTriggerIds.values().next().value;
                            processedTriggerIds.delete(first);
                        }
                        try { fs.unlinkSync(filePath); } catch {}
                        console.log(`Feedback Gate: auto-consumed queue item "${queueItem.text}"`);
                        return;
                    }
                }
            }
            
            // Eagerly clean dead sessions before routing new trigger
            let cleaned = false;
            for (const [sKey, s] of sessions) {
                if (s.mcpPid === triggerPid) continue;
                if (!isProcessAlive(s.mcpPid)) {
                    console.log(`Feedback Gate: cleaning dead session ${sKey} (PID ${s.mcpPid} gone)`);
                    queue.migrateSessionKey(sKey, '');
                    sessions.delete(sKey);
                    if (activeSessionKey === sKey) {
                        activeSessionKey = null;
                        queue.setActiveSessionKey('');
                    }
                    cleaned = true;
                }
            }
            if (cleaned) syncTabsToWebview();
            
            // Route trigger to session (or legacy global)
            const session = triggerPid ? setCurrentTriggerData(triggerData.data, triggerPid) : null;
            if (!session) {
                currentTriggerData = triggerData.data;
            }
            
            // Post-route queue consumption: covers two cases the pre-route check misses:
            // 1. New session_id that didn't match any existing session (session was
            //    created or adopted after pre-route, inheriting queued messages).
            // 2. Session matched by session_id but already had a pending trigger
            //    (pre-route skipped due to !targetSession.triggerData being false;
            //    setCurrentTriggerData then overwrote triggerData with the new one).
            if (!shouldAutoConsume && session && session.triggerData) {
                let postRouteCount = getPendingQueueCount(session.key);
                // Also check untagged messages — they may have been enqueued before
                // this session existed (e.g. user typed before first trigger arrived).
                if (postRouteCount === 0) {
                    postRouteCount = getPendingQueueCount('');
                }
                if (postRouteCount > 0) {
                    const postItem = dequeueMessage(session.key) || dequeueMessage('');
                    if (postItem) {
                        if (postItem.source && postItem.source !== 'local' && postItem.chatId) {
                            session.pendingRemoteReply = { chatId: postItem.chatId, source: postItem.source, originalText: postItem.text || '', enqueuedAt: Date.now() };
                        } else {
                            session.pendingRemoteReply = null;
                        }
                        const postTriggerId = session.triggerData.trigger_id;
                        if (postTriggerId && writeResponseForTrigger(postTriggerId, postItem, 'feedback_gate_queue')) {
                            markQueueItemDone(postItem.id);
                            logUserInput(postItem.text, 'MCP_RESPONSE', postTriggerId, postItem.attachments || [], postItem.files || []);
                            sendExtensionAcknowledgement(postTriggerId, session.triggerData.tool || (triggerData.data && triggerData.data.tool));
                            const agentMsg = session.triggerData.message || session.triggerData.prompt || '';
                            if (agentMsg) {
                                addMessageToSession(session.key, { text: agentMsg, type: 'system' });
                                maybeWriteOutbox(agentMsg);
                            }
                            addMessageToSession(session.key, { text: postItem.text, type: 'user', attachments: postItem.attachments, files: postItem.files });
                            if (postItem.text || (postItem.attachments && postItem.attachments.length > 0)) {
                                session.label = _buildTabLabel(session.index, postItem.text, postItem.attachments);
                                session._labelSource = 'user';
                                syncTabsToWebview();
                            }
                            const sourceTag = postItem.sourceLabel
                                ? `⚡ 已从队列自动发送（来自${postItem.sourceLabel}）`
                                : '⚡ 已从队列自动发送';
                            addMessageToSession(session.key, { text: sourceTag, type: 'system', plain: true });
                            clearSessionTrigger(session.key);
                            if (session.key !== activeSessionKey) {
                                const recentManualSwitch = (Date.now() - lastManualSwitchAt) < MANUAL_SWITCH_GUARD_MS;
                                if (!recentManualSwitch) {
                                    switchToSession(session.key);
                                }
                            }
                            if (triggerId) {
                                processedTriggerIds.add(triggerId);
                                if (processedTriggerIds.size > 50) {
                                    const first = processedTriggerIds.values().next().value;
                                    processedTriggerIds.delete(first);
                                }
                            }
                            try { fs.unlinkSync(filePath); } catch {}
                            console.log(`Feedback Gate: post-route auto-consumed queue item "${postItem.text}" for session ${session.key}`);
                            return;
                        } else {
                            queue.requeueItem(postItem.id);
                        }
                    }
                }
            }
            
            // Auto-switch to the session that received the trigger, unless the
            // user manually switched tabs very recently (10s guard).
            if (session && session.key !== activeSessionKey) {
                const recentManualSwitch = (Date.now() - lastManualSwitchAt) < MANUAL_SWITCH_GUARD_MS;
                if (!recentManualSwitch) {
                    switchToSession(session.key);
                } else {
                    syncTabsToWebview();
                }
            }
            
            try {
                handleFeedbackGateToolCall(context, triggerData.data, triggerPid);
            } catch (handleError) {
                console.log(`Feedback Gate: handleFeedbackGateToolCall error: ${handleError.message}`);
            }
            
            if (triggerId) {
                processedTriggerIds.add(triggerId);
                if (processedTriggerIds.size > 50) {
                    const first = processedTriggerIds.values().next().value;
                    processedTriggerIds.delete(first);
                }
            }
            try {
                fs.unlinkSync(filePath);
            } catch (cleanupError) {
                console.log(`Could not clean trigger file: ${cleanupError.message}`);
            }
        }
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.log(`Error reading trigger file: ${error.message}`);
        }
    }
}

function handleFeedbackGateToolCall(context, toolData, mcpPid) {
    let popupOptions = {};
    
    switch (toolData.tool) {
        case 'feedback_gate':
            // UNIFIED: New unified tool that handles all modes
            const mode = toolData.mode || 'chat';
            let modeTitle = `Feedback Gate - ${mode.charAt(0).toUpperCase() + mode.slice(1)} Mode`;
            if (toolData.unified_tool) {
                modeTitle = `Feedback Gate - Unified (${mode})`;
            }
            
            popupOptions = {
                message: toolData.message || "Please provide your input:",
                title: toolData.title || modeTitle,
                autoFocus: true,
                toolData: toolData,
                mcpIntegration: true,
                specialHandling: `unified_${mode}`
            };
            break;
            
        case 'feedback_gate_chat':
            popupOptions = {
                message: toolData.message || "请提供你的反馈：",
                title: toolData.title || "Feedback Gate",
                autoFocus: true,
                toolData: toolData,
                mcpIntegration: true
            };
            break;
            
        case 'quick_feedback':
            popupOptions = {
                message: toolData.prompt || "Quick feedback needed:",
                title: toolData.title || "Feedback Gate - Quick Feedback",
                autoFocus: true,
                toolData: toolData,
                mcpIntegration: true,
                specialHandling: 'quick_feedback'
            };
            break;
            
        case 'ingest_text':
            popupOptions = {
                message: `Cursor received text input and needs your feedback:\n\n**Text Content:** ${toolData.text_content}\n**Source:** ${toolData.source}\n**Context:** ${toolData.context || 'None'}\n**Processing Mode:** ${toolData.processing_mode}\n\n请审查并提供反馈：`,
                title: toolData.title || "Feedback Gate - Text Input",
                autoFocus: true,
                toolData: toolData,
                mcpIntegration: true
            };
            break;
            
        case 'shutdown_mcp':
            popupOptions = {
                message: `Cursor is requesting to shutdown the MCP server:\n\n**Reason:** ${toolData.reason}\n**Immediate:** ${toolData.immediate ? 'Yes' : 'No'}\n**Cleanup:** ${toolData.cleanup ? 'Yes' : 'No'}\n\nType 'CONFIRM' to proceed with shutdown, or provide alternative instructions:`,
                title: toolData.title || "Feedback Gate - Shutdown Confirmation",
                autoFocus: true,
                toolData: toolData,
                mcpIntegration: true,
                specialHandling: 'shutdown_mcp'
            };
            break;
            
        case 'file_feedback':
            popupOptions = {
                message: toolData.instruction || "Cursor needs you to select files:",
                title: toolData.title || "Feedback Gate - File Feedback",
                autoFocus: true,
                toolData: toolData,
                mcpIntegration: true
            };
            break;
            
        default:
            popupOptions = {
                message: toolData.message || toolData.prompt || toolData.instruction || "Cursor needs your input. Please provide your response:",
                title: toolData.title || "Feedback Gate - General Input",
                autoFocus: true,
                toolData: toolData,
                mcpIntegration: true
            };
    }
    
    // Add trigger ID to popup options
    popupOptions.triggerId = toolData.trigger_id;
    // Force consistent title regardless of tool call
    popupOptions.title = "Feedback Gate";
    
    // V2: write Agent message to IDE reply for remote source
    const agentMsgForOutbox = toolData.message || toolData.prompt || '';
    if (agentMsgForOutbox) {
        maybeWriteOutbox(agentMsgForOutbox);
    }
    
    // Record agent message to session history (skip webview push for active session
    // since openFeedbackGatePopup will send newMessage to webview separately)
    if (mcpPid && popupOptions.message) {
        // Find the session that owns this trigger (may be one of several with same PID)
        const triggerId = toolData && toolData.trigger_id;
        let targetSession = null;
        if (triggerId) {
            for (const s of sessions.values()) {
                if (s.triggerData && s.triggerData.trigger_id === triggerId) {
                    targetSession = s;
                    break;
                }
            }
        }
        if (!targetSession) targetSession = getSessionByMcpPid(mcpPid);
        if (targetSession) {
            targetSession.messages.push({ text: popupOptions.message, type: 'system' });
            if (targetSession.messages.length > 200) targetSession.messages = targetSession.messages.slice(-200);
        }
    }
    
    // Only broadcast newMessage to webview if this trigger belongs to the active session.
    // Otherwise the message would appear in the wrong session's UI.
    const triggerBelongsToActive = (() => {
        const active = getActiveSession();
        if (!active) return true; // no sessions yet — safe to broadcast
        const tid = toolData && toolData.trigger_id;
        return active.triggerData && active.triggerData.trigger_id === tid;
    })();
    if (!triggerBelongsToActive) {
        popupOptions._skipNewMessage = true;
    }
    openFeedbackGatePopup(context, popupOptions);
    
    // FIXED: Send acknowledgement to MCP server that popup was activated
    sendExtensionAcknowledgement(toolData.trigger_id, toolData.tool);
    
    // Show appropriate notification
    const toolDisplayName = toolData.tool.replace('_', ' ').toUpperCase();
    vscode.window.showInformationMessage(`Cursor triggered "${toolDisplayName}" - Feedback Gate popup opened for your input!`);
}

function sendExtensionAcknowledgement(triggerId, toolType) {
    try {
        const timestamp = new Date().toISOString();
        const ackData = {
            acknowledged: true,
            timestamp: timestamp,
            trigger_id: triggerId,
            tool_type: toolType,
            extension: 'feedback-gate',
            popup_activated: true
        };
        
        const ackFile = getTempPath(`feedback_gate_ack_${triggerId}.json`);
        fs.writeFileSync(ackFile, JSON.stringify(ackData, null, 2));
        
        // Silent acknowledgement 
        
    } catch (error) {
        console.log(`Could not send extension acknowledgement: ${error.message}`);
    }
}

function openFeedbackGatePopup(context, options = {}) {
    const {
        message = "欢迎使用 Feedback Gate！请提供你的审查反馈。",
        title = "Feedback Gate",
        autoFocus = false,
        toolData = null,
        mcpIntegration = false,
        triggerId = null,
        specialHandling = null,
        _forceEditor = false,
        _skipNewMessage = false
    } = options;
    
    if (triggerId && sessions.size === 0) {
        currentTriggerData = { ...toolData, trigger_id: triggerId };
    }

    const pref = getPreferredLocation();

    // Build an ordered list of providers to try based on preference
    const providerCandidates = [];
    if (pref === 'sidebar') {
        if (sidebarViewProvider) providerCandidates.push(sidebarViewProvider);
        if (usePanelView && chatViewProvider) providerCandidates.push(chatViewProvider);
    } else if (pref === 'panel') {
        if (usePanelView && chatViewProvider) providerCandidates.push(chatViewProvider);
        if (sidebarViewProvider) providerCandidates.push(sidebarViewProvider);
    }
    // pref === 'editor' falls through to the editor tab path below

    if (!_forceEditor && pref !== 'editor' && providerCandidates.length > 0) {
        if (chatPanel) {
            try { chatPanel.dispose(); } catch {}
            chatPanel = null;
        }

        // Try each candidate in priority order
        for (const provider of providerCandidates) {
            if (provider._view) {
                provider._mcpIntegration = mcpIntegration;
                provider._currentSpecialHandling = specialHandling;
                if (mcpIntegration) {
                    setTimeout(() => {
                        broadcastToAllWebviews({ command: 'updateMcpStatus', active: true, hasPendingTrigger: true });
                    }, 100);
                }
                if (mcpIntegration && message && !_skipNewMessage) {
                    setTimeout(() => {
                        broadcastToAllWebviews({
                            command: 'newMessage',
                            text: message,
                            type: 'system',
                            toolData: toolData,
                            mcpIntegration: mcpIntegration
                        });
                    }, 150);
                }
                provider.focusView();
                if (autoFocus) {
                    setTimeout(() => { postToWebview({ command: 'focus' }); }, 200);
                }
                return;
            }
        }

        // None resolved yet — try to focus the preferred provider (triggers resolveWebviewView)
        const primary = providerCandidates[0];
        primary._mcpIntegration = mcpIntegration;
        primary._currentSpecialHandling = specialHandling;
        if (mcpIntegration) {
            primary._pendingMessages.push({ command: 'updateMcpStatus', active: true, hasPendingTrigger: true });
        }
        if (mcpIntegration && message && !_skipNewMessage) {
            primary._pendingMessages.push({
                command: 'newMessage',
                text: message,
                type: 'system',
                toolData: toolData,
                mcpIntegration: mcpIntegration
            });
        }
        primary.focusView().then(ok => {
            if (!ok && providerCandidates.length > 1) {
                const fallback = providerCandidates[1];
                console.log(`Feedback Gate: preferred view focus failed, trying fallback`);
                primary._pendingMessages = [];
                fallback._mcpIntegration = mcpIntegration;
                fallback._currentSpecialHandling = specialHandling;
                if (mcpIntegration) {
                    fallback._pendingMessages.push({ command: 'updateMcpStatus', active: true, hasPendingTrigger: true });
                }
                if (mcpIntegration && message && !_skipNewMessage) {
                    fallback._pendingMessages.push({
                        command: 'newMessage',
                        text: message,
                        type: 'system',
                        toolData: toolData,
                        mcpIntegration: mcpIntegration
                    });
                }
                fallback.focusView().then(ok2 => {
                    if (!ok2) {
                        console.log('Feedback Gate: all view providers failed, falling back to editor tab');
                        fallback._pendingMessages = [];
                        openFeedbackGatePopup(context, { ...options, _forceEditor: true });
                    }
                });
            } else if (!ok) {
                console.log('Feedback Gate: view focus failed, falling back to editor tab');
                primary._pendingMessages = [];
                usePanelView = false;
                openFeedbackGatePopup(context, { ...options, _forceEditor: true });
            }
        });
        return;
    }

    // --- Fallback: use editor tab WebviewPanel ---

    if (chatPanel) {
        chatPanel.reveal(vscode.ViewColumn.One);
        chatPanel.title = "Feedback Gate";
        
        if (mcpIntegration) {
            setTimeout(() => {
                broadcastToAllWebviews({
                    command: 'updateMcpStatus',
                    active: true,
                    hasPendingTrigger: true
                });
            }, 100);
        }

        if (mcpIntegration && message && !_skipNewMessage) {
            setTimeout(() => {
                broadcastToAllWebviews({
                    command: 'newMessage',
                    text: message,
                    type: 'system',
                    toolData: toolData,
                    mcpIntegration: mcpIntegration
                });
            }, 150);
        }
        
        if (autoFocus) {
            setTimeout(() => {
                postToWebview({
                    command: 'focus'
                });
            }, 200);
        }
        
        return;
    }

    chatPanel = vscode.window.createWebviewPanel(
        'feedbackGateChat',
        title,
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true
        }
    );

    // Set the HTML content
    chatPanel.webview.html = getFeedbackGateHTML(title, mcpIntegration);

    // Handle messages from webview
    chatPanel.webview.onDidReceiveMessage(
        webviewMessage => {
            // Get trigger ID from current trigger data or passed options
            const activeSession = getActiveSession();
            const activeTrigger = activeSession ? activeSession.triggerData : currentTriggerData;
            const currentTriggerId = (activeTrigger && activeTrigger.trigger_id) || triggerId;
            
            switch (webviewMessage.command) {
                case 'send': {
                    const rawSessionKey2 = (webviewMessage.sessionKey != null ? webviewMessage.sessionKey : activeSessionKey) || '';
                    const sendSession2 = (rawSessionKey2 ? sessions.get(rawSessionKey2) : null) || activeSession;
                    const sendSessionKey2 = sendSession2 ? sendSession2.key : '';
                    if (sendSession2) sendSession2.pendingRemoteReply = null;
                    else if (activeSession) activeSession.pendingRemoteReply = null;
                    else pendingRemoteReply = null;
                    enqueueMessage(webviewMessage.text, webviewMessage.attachments, webviewMessage.files, {
                        sessionKey: sendSessionKey2,
                    });
                    logUserInput(`Queued: ${webviewMessage.text}`, 'QUEUED', null);
                    const sendTrigger2 = sendSession2 ? sendSession2.triggerData : null;
                    if (sendTrigger2 && sendTrigger2.trigger_id) {
                        processQueueForPendingTrigger(true, sendSession2.key);
                    }
                    break;
                }
                case 'switchSession':
                    if (webviewMessage.sessionKey) {
                        if (activeSession && webviewMessage.draft !== undefined) {
                            activeSession.draft = webviewMessage.draft || '';
                        }
                        switchToSession(webviewMessage.sessionKey, true);
                    }
                    break;
                case 'closeSession':
                    closeSessionByKey(webviewMessage.sessionKey);
                    break;
                case 'removeQueueItem':
                    removeQueueItem(webviewMessage.itemId);
                    break;
                case 'editQueueItem':
                    editQueueItem(webviewMessage.itemId, webviewMessage.newText);
                    break;
                case 'cancelEditQueueItem':
                    syncQueueToWebview(activeSessionKey || '');
                    break;
                case 'saveDraft':
                    if (webviewMessage.sessionKey) {
                        const draftSession2 = sessions.get(webviewMessage.sessionKey);
                        if (draftSession2) draftSession2.draft = webviewMessage.draft || '';
                    }
                    break;
                case 'moveQueueItem':
                    moveQueueItem(webviewMessage.itemId, webviewMessage.direction);
                    break;
                case 'pinQueueItem':
                    pinQueueItem(webviewMessage.itemId);
                    break;
                case 'reorderQueue':
                    reorderQueue(webviewMessage.orderedIds);
                    break;
                case 'attach':
                    logUserInput('User clicked attachment button', 'ATTACHMENT_CLICK', currentTriggerId);
                    handleFileAttachment(currentTriggerId);
                    break;
                case 'uploadImage':
                    logUserInput('User clicked image upload button', 'IMAGE_UPLOAD_CLICK', currentTriggerId);
                    handleImageUpload(currentTriggerId);
                    break;
                case 'logPastedImage':
                    logUserInput(`Image pasted from clipboard: ${webviewMessage.fileName} (${webviewMessage.size} bytes, ${webviewMessage.mimeType})`, 'IMAGE_PASTED', currentTriggerId);
                    break;
                case 'logDragDropImage':
                    logUserInput(`Image dropped from drag and drop: ${webviewMessage.fileName} (${webviewMessage.size} bytes, ${webviewMessage.mimeType})`, 'IMAGE_DROPPED', currentTriggerId);
                    break;
                case 'logImageRemoved':
                    logUserInput(`Image removed: ${webviewMessage.imageId}`, 'IMAGE_REMOVED', currentTriggerId);
                    break;
                case 'dropFile':
                    handleDroppedFile(webviewMessage.filePath, currentTriggerId);
                    break;
                case 'showError':
                    vscode.window.showErrorMessage(webviewMessage.message);
                    break;
                case 'ready': {
                    const readySession = getActiveSession();
                    const hasTrigger = readySession ? !!readySession.triggerData : !!currentTriggerData;
                    postToWebview({
                        command: 'updateMcpStatus',
                        active: mcpIntegration ? true : mcpStatus,
                        hasPendingTrigger: mcpIntegration ? hasTrigger : false
                    });
                    syncTabsToWebview();
                    if (readySession) syncSessionToWebview(readySession);
                    syncQueueToWebview(activeSessionKey || '');
                    if (message && !mcpIntegration && !message.includes("I have completed")) {
                        postToWebview({
                            command: 'addMessage',
                            text: message,
                            type: 'system',
                            plain: true,
                            toolData: toolData,
                            mcpIntegration: mcpIntegration,
                            triggerId: triggerId,
                            specialHandling: specialHandling
                        });
                    }
                    break;
                }
            }
        },
        undefined,
        context.subscriptions
    );

    // Clean up when panel is closed
    chatPanel.onDidDispose(
        () => {
            chatPanel = null;
            if (sessions.size === 0) {
                currentTriggerData = null;
            }
        },
        null,
        context.subscriptions
    );

    // Auto-focus if requested
    if (autoFocus) {
        setTimeout(() => {
            postToWebview({
                command: 'focus'
            });
        }, 200);
    }
}


function processQueueForPendingTrigger(directSend, targetSessionKey) {
    // Use specified session if provided, otherwise fall back to active session
    const targetSession = targetSessionKey ? sessions.get(targetSessionKey) : getActiveSession();
    const activeTrigger = targetSession ? targetSession.triggerData : currentTriggerData;
    if (!activeTrigger || !activeTrigger.trigger_id) return;
    const sessionKey = targetSession ? targetSession.key : '';
    if (getPendingQueueCount(sessionKey) === 0) return;

    const queueItem = dequeueMessage(sessionKey);
    if (!queueItem) return;

    if (queueItem.source && queueItem.source !== 'local' && queueItem.chatId) {
        const rr = { chatId: queueItem.chatId, source: queueItem.source, originalText: queueItem.text || '', enqueuedAt: Date.now() };
        if (targetSession) targetSession.pendingRemoteReply = rr;
        else pendingRemoteReply = rr;
    } else {
        if (targetSession) targetSession.pendingRemoteReply = null;
        else pendingRemoteReply = null;
    }

    const triggerId = activeTrigger.trigger_id;

    if (!writeResponseForTrigger(triggerId, queueItem, directSend ? 'feedback_gate_direct' : 'feedback_gate_queue')) {
        queue.requeueItem(queueItem.id);
        return;
    }

    markQueueItemDone(queueItem.id);
    logUserInput(queueItem.text, 'MCP_RESPONSE', triggerId, queueItem.attachments || [], queueItem.files || []);

    if (targetSession) {
        addMessageToSession(targetSession.key, { text: queueItem.text, type: 'user', attachments: queueItem.attachments, files: queueItem.files });
        if (queueItem.text || (queueItem.attachments && queueItem.attachments.length > 0)) {
            targetSession.label = _buildTabLabel(targetSession.index, queueItem.text, queueItem.attachments);
            targetSession._labelSource = 'user';
            syncTabsToWebview();
        }
    } else {
        broadcastToAllWebviews({ command: 'addMessage', text: queueItem.text, type: 'user', attachments: queueItem.attachments, files: queueItem.files });
    }

    const isLocalDirect = directSend && (!queueItem.source || queueItem.source === 'local');
    if (!isLocalDirect) {
        const sourceTag = queueItem.sourceLabel
            ? `⚡ 已从队列自动发送（来自${queueItem.sourceLabel}）`
            : '⚡ 已从队列自动发送';
        if (targetSession) {
            addMessageToSession(targetSession.key, { text: sourceTag, type: 'system', plain: true });
        } else {
            broadcastToAllWebviews({ command: 'addMessage', text: sourceTag, type: 'system', plain: true });
        }
    }

    if (directSend) {
        handleFeedbackMessage(queueItem.text, queueItem.attachments, triggerId, true, null);
    } else {
        if (targetSession) {
            clearSessionTrigger(targetSession.key);
        } else {
            currentTriggerData = null;
        }
        const next = findNextPendingSession();
        if (next && (Date.now() - lastManualSwitchAt >= MANUAL_SWITCH_GUARD_MS)) {
            switchToSession(next.key);
        }
        setTimeout(() => {
            updateChatPanelStatus();
        }, 1000);
    }
}

function handleFeedbackMessage(text, attachments, triggerId, mcpIntegration, specialHandling) {
    // Clear trigger from the session that owns this triggerId, not just the active tab
    let cleared = false;
    if (triggerId) {
        for (const s of sessions.values()) {
            if (s.triggerData && s.triggerData.trigger_id === triggerId) {
                clearSessionTrigger(s.key);
                cleared = true;
                break;
            }
        }
    }
    if (!cleared && !triggerId) {
        const activeSession = getActiveSession();
        if (activeSession) clearSessionTrigger(activeSession.key);
        else currentTriggerData = null;
    }
    if (!cleared && triggerId && currentTriggerData && currentTriggerData.trigger_id === triggerId) {
        currentTriggerData = null;
    }
    
    const funnyResponses = [
        "Cursor 已读已回，正在疯狂敲键盘中 ⌨️",
        "你的需求比 P0 还 P0，Cursor 连夜赶工 🌙",
        "收到！Cursor 表示：「这活儿我熟」🫡",
        "消息已发，Cursor 已经在 996 了…",
        "指令已达！Cursor：「收到，这就卷」💪",
        "你的反馈价值一个亿，Cursor 搬砖去了 🧱",
        "Cursor 正在头秃中… 但你的需求它记住了 🧑‍🦲",
        "已阅已办！Cursor 正在用爱发电 ⚡",
        "需求已投喂，Cursor 消化中… 🍜",
        "Cursor 默默点了个赞，然后开始干活了 👍",
        "你说啥就是啥，Cursor 照单全收 📋",
        "消息已签收，顺丰都没这么快 🚀",
    ];
    
    // Silent message processing
    
    // Handle special cases for different tool types
    if (specialHandling === 'shutdown_mcp') {
        if (text.toUpperCase().includes('CONFIRM') || text.toUpperCase() === 'YES') {
            logUserInput(`SHUTDOWN CONFIRMED: ${text}`, 'SHUTDOWN_CONFIRMED', triggerId);
            
            setTimeout(() => {
                broadcastToAllWebviews({
                    command: 'addMessage',
                    text: `🛑 关闭已确认: "${text}"\n\n用户已批准 MCP 服务器关闭。\n\nCursor 将执行优雅关闭。`,
                    type: 'system'
                });
                setTimeout(() => { broadcastToAllWebviews({ command: 'updateMcpStatus', active: mcpStatus, hasPendingTrigger: false }); }, 1000);
            }, 500);
        } else {
            logUserInput(`SHUTDOWN ALTERNATIVE: ${text}`, 'SHUTDOWN_ALTERNATIVE', triggerId);
            
            setTimeout(() => {
                broadcastToAllWebviews({
                    command: 'addMessage',
                    text: `💡 替代指令: "${text}"\n\n你的指令已发送给 Cursor，替代关闭确认。\n\nCursor 将处理你的替代请求。`,
                    type: 'system'
                });
                setTimeout(() => { broadcastToAllWebviews({ command: 'updateMcpStatus', active: mcpStatus, hasPendingTrigger: false }); }, 1000);
            }, 500);
        }
    } else if (specialHandling === 'ingest_text') {
        logUserInput(`TEXT FEEDBACK: ${text}`, 'TEXT_FEEDBACK', triggerId);
        
            setTimeout(() => {
                broadcastToAllWebviews({
                    command: 'addMessage',
                    text: `🔄 文本输入已处理: "${text}"\n\n你的反馈已发送给 Cursor。\n\nCursor 将基于你的输入继续处理。`,
                    type: 'system'
                });
                setTimeout(() => { broadcastToAllWebviews({ command: 'updateMcpStatus', active: mcpStatus, hasPendingTrigger: false }); }, 1000);
            }, 500);
    } else {
        outputChannel.appendLine(`${mcpIntegration ? 'MCP RESPONSE' : 'REVIEW'} SUBMITTED: ${text}`);
        
        setTimeout(() => {
            const randomResponse = funnyResponses[Math.floor(Math.random() * funnyResponses.length)];
            broadcastToAllWebviews({
                command: 'addMessage',
                text: randomResponse,
                type: 'system',
                plain: true
            });
            setTimeout(() => { updateChatPanelStatus(); }, 1000);
        }, 500);
    }

    setTimeout(() => {
        const recentManualSwitch = (Date.now() - lastManualSwitchAt) < MANUAL_SWITCH_GUARD_MS;
        if (recentManualSwitch) {
            syncTabsToWebview();
            return;
        }
        const next = findNextPendingSession();
        if (next) {
            switchToSession(next.key);
        } else {
            syncTabsToWebview();
        }
    }, 1500);
}

function handleFileAttachment(triggerId) {
    logUserInput('User requested file attachment for review', 'FILE_ATTACHMENT', triggerId);
    
    vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: 'Select file(s) for review',
        filters: {
            'All files': ['*']
        }
    }).then(fileUris => {
        if (fileUris && fileUris.length > 0) {
            const filePaths = fileUris.map(uri => uri.fsPath);
            const fileNames = filePaths.map(fp => path.basename(fp));
            
            logUserInput(`Files selected for review: ${fileNames.join(', ')}`, 'FILE_SELECTED', triggerId);
            
            broadcastToAllWebviews({
                command: 'addMessage',
                text: `Files attached for review:\n${fileNames.map(name => '• ' + name).join('\n')}\n\nPaths:\n${filePaths.map(fp => '• ' + fp).join('\n')}`,
                type: 'system'
            });
        } else {
            logUserInput('No files selected for review', 'FILE_CANCELLED', triggerId);
        }
    });
}

function handleImageUpload(triggerId) {
    logUserInput('User requested image upload for review', 'IMAGE_UPLOAD', triggerId);
    
    vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: 'Select image(s) to upload',
        filters: {
            'Images': ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp']
        }
    }).then(fileUris => {
        if (fileUris && fileUris.length > 0) {
            fileUris.forEach(fileUri => {
                const filePath = fileUri.fsPath;
                const fileName = path.basename(filePath);
                
                
                try {
                    // Read the image file
                    const imageBuffer = fs.readFileSync(filePath);
                    const base64Data = imageBuffer.toString('base64');
                    const mimeType = getMimeType(fileName);
                    const dataUrl = `data:${mimeType};base64,${base64Data}`;
                    
                    const imageData = {
                        fileName: fileName,
                        filePath: filePath,
                        mimeType: mimeType,
                        base64Data: base64Data,
                        dataUrl: dataUrl,
                        size: imageBuffer.length
                    };
                    
                    logUserInput(`Image uploaded: ${fileName}`, 'IMAGE_UPLOADED', triggerId);
                    
                    broadcastToAllWebviews({
                        command: 'imageUploaded',
                        imageData: imageData
                    });
                    
                } catch (error) {
                    console.log(`Error processing image ${fileName}: ${error.message}`);
                    vscode.window.showErrorMessage(`Failed to process image: ${fileName}`);
                }
            });
        } else {
            logUserInput('No images selected for upload', 'IMAGE_CANCELLED', triggerId);
        }
    });
}

function handleDroppedFile(filePath, triggerId) {
    try {
        if (!filePath || !fs.existsSync(filePath)) {
            console.log(`Dropped file not found: ${filePath}`);
            return;
        }
        
        const stats = fs.statSync(filePath);
        if (stats.isDirectory()) {
            const dirName = path.basename(filePath);
            broadcastToAllWebviews({
                command: 'fileAttached',
                fileData: {
                    fileName: dirName + '/',
                    filePath: filePath,
                    size: 0,
                    isDirectory: true
                }
            });
            logUserInput(`Folder dropped: ${dirName} (${filePath})`, 'FOLDER_DROPPED', triggerId);
            return;
        }
        
        const fileName = path.basename(filePath);
        const ext = path.extname(fileName).toLowerCase();
        const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'];
        
        if (imageExts.includes(ext)) {
            const imageBuffer = fs.readFileSync(filePath);
            const base64Data = imageBuffer.toString('base64');
            const mimeType = getMimeType(fileName);
            const dataUrl = `data:${mimeType};base64,${base64Data}`;
            
            broadcastToAllWebviews({
                command: 'imageUploaded',
                imageData: {
                    fileName: fileName,
                    filePath: filePath,
                    mimeType: mimeType,
                    base64Data: base64Data,
                    dataUrl: dataUrl,
                    size: imageBuffer.length
                }
            });
        } else {
            const maxSize = 100 * 1024;
            if (stats.size > maxSize) {
                logUserInput(`File too large to attach inline: ${fileName} (${(stats.size / 1024).toFixed(1)} KB)`, 'FILE_DROP_TOO_LARGE', triggerId);
                broadcastToAllWebviews({
                    command: 'fileAttached',
                    fileData: {
                        fileName: fileName,
                        filePath: filePath,
                        size: stats.size,
                        truncated: true
                    }
                });
            } else {
                broadcastToAllWebviews({
                    command: 'fileAttached',
                    fileData: {
                        fileName: fileName,
                        filePath: filePath,
                        size: stats.size
                    }
                });
            }
        }
        
        logUserInput(`File dropped: ${fileName} (${filePath})`, 'FILE_DROPPED', triggerId);
    } catch (error) {
        console.log(`Error handling dropped file: ${error.message}`);
    }
}

function deactivate() {
    unregisterIdeSession();
    
    if (feedbackGateWatcher) {
        clearInterval(feedbackGateWatcher);
    }
    
    if (statusCheckInterval) {
        clearInterval(statusCheckInterval);
    }
    
    if (outputChannel) {
        outputChannel.dispose();
    }
}

module.exports = {
    activate,
    deactivate
}; 