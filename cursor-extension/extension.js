const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// Cross-platform temp directory helper
function getTempPath(filename) {
    // Use /tmp/ for macOS and Linux, system temp for Windows
    if (process.platform === 'win32') {
        return path.join(os.tmpdir(), filename);
    } else {
        return path.join('/tmp', filename);
    }
}

let chatPanel = null;
let chatViewProvider = null;
let feedbackGateWatcher = null;
let outputChannel = null;
let mcpStatus = false;
let statusCheckInterval = null;
let currentTriggerData = null;
let currentRecording = null;
let boundMcpPid = null;
let usePanelView = true;
let feedbackGateEnabled = true;
let statusBarItem = null;

function getActiveWebview() {
    if (usePanelView && chatViewProvider && chatViewProvider._view && chatViewProvider._view.webview) {
        return chatViewProvider._view.webview;
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
    if (chatViewProvider) {
        chatViewProvider._pendingMessages.push(message);
    }
    return false;
}

class FeedbackGatePanelProvider {
    constructor(context) {
        this._context = context;
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
                const currentTriggerId = (currentTriggerData && currentTriggerData.trigger_id) || null;
                switch (webviewMessage.command) {
                    case 'send': {
                        const eventType = this._mcpIntegration ? 'MCP_RESPONSE' : 'FEEDBACK_SUBMITTED';
                        logUserInput(webviewMessage.text, eventType, currentTriggerId, webviewMessage.attachments || []);
                        handleFeedbackMessage(webviewMessage.text, webviewMessage.attachments, currentTriggerId, this._mcpIntegration, this._currentSpecialHandling);
                        break;
                    }
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
                    case 'startRecording':
                        logUserInput('User started speech recording', 'SPEECH_START', currentTriggerId);
                        startNodeRecording(currentTriggerId);
                        break;
                    case 'stopRecording':
                        logUserInput('User stopped speech recording', 'SPEECH_STOP', currentTriggerId);
                        stopNodeRecording(currentTriggerId);
                        break;
                    case 'showError':
                        vscode.window.showErrorMessage(webviewMessage.message);
                        break;
                    case 'ready':
                        if (this._pendingMessages.length > 0) {
                            webviewView.webview.postMessage({
                                command: 'updateMcpStatus',
                                active: true
                            });
                            for (const msg of this._pendingMessages) {
                                webviewView.webview.postMessage(msg);
                            }
                            this._pendingMessages = [];
                        }
                        break;
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
            await vscode.commands.executeCommand('feedbackGate.chatView.focus');
            return true;
        } catch (e) {
            console.log(`Failed to focus panel view: ${e.message}`);
            return false;
        }
    }
}

function updateStatusBarItem() {
    if (!statusBarItem) return;
    if (feedbackGateEnabled) {
        statusBarItem.text = "$(check) RG";
        statusBarItem.tooltip = "Feedback Gate: 已启用 (点击切换)";
        statusBarItem.backgroundColor = undefined;
    } else {
        statusBarItem.text = "$(x) RG";
        statusBarItem.tooltip = "Feedback Gate: 已禁用 - 自动放行 (点击切换)";
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
}

function activate(context) {
    console.log('Feedback Gate extension is now active in Cursor for MCP integration!');
    
    // Create output channel for logging
    outputChannel = vscode.window.createOutputChannel('Feedback Gate');
    context.subscriptions.push(outputChannel);
    
    // Silent activation - only log to console, not output channel
    console.log('Feedback Gate extension activated for Cursor MCP integration by Lakshman Turlapati');

    // Register command to open Feedback Gate manually
    let disposable = vscode.commands.registerCommand('feedbackGate.openChat', () => {
        openFeedbackGatePopup(context, {
            message: "欢迎使用 Feedback Gate！请提供你的审查反馈。",
            title: "Feedback Gate"
        });
    });

    context.subscriptions.push(disposable);

    // Register bottom panel WebviewViewProvider (primary UI)
    try {
        chatViewProvider = new FeedbackGatePanelProvider(context);
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

    // Restore persisted toggle state
    feedbackGateEnabled = context.globalState.get('feedbackGateEnabled', true);

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
            if (!feedbackGateEnabled && currentTriggerData && currentTriggerData.trigger_id) {
                const triggerId = currentTriggerData.trigger_id;
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
                currentTriggerData = null;
            }
        })
    );

    // Start MCP status monitoring immediately
    startMcpStatusMonitoring(context);

    // Start Feedback Gate integration immediately
    startFeedbackGateIntegration(context);
    
    vscode.window.showInformationMessage('Feedback Gate 已激活！使用 Cmd+Shift+R 或等待 MCP 工具调用。');
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

function logUserInput(inputText, eventType = 'MESSAGE', triggerId = null, attachments = []) {
    const timestamp = new Date().toISOString();
    const logMsg = `[${timestamp}] ${eventType}: ${inputText}`;
    console.log(`FEEDBACK GATE USER INPUT: ${inputText}`);
    
    if (outputChannel) {
        outputChannel.appendLine(logMsg);
    }
    
    // Write to file for external monitoring
    try {
        const logFile = getTempPath('feedback_gate_user_inputs.log');
        fs.appendFileSync(logFile, `${logMsg}\n`);
        
        // Write response file for MCP server integration if we have a trigger ID
        if (triggerId && eventType === 'MCP_RESPONSE') {
            // Write multiple response file patterns for better compatibility
            const responsePatterns = [
                getTempPath(`feedback_gate_response_${triggerId}.json`),
                getTempPath('feedback_gate_response.json'),  // Fallback generic response
                getTempPath(`mcp_response_${triggerId}.json`),  // Alternative pattern
                getTempPath('mcp_response.json')  // Generic MCP response
            ];
            
            const responseData = {
                timestamp: timestamp,
                trigger_id: triggerId,
                user_input: inputText,
                response: inputText,  // Also provide as 'response' field
                message: inputText,   // Also provide as 'message' field
                attachments: attachments,  // Include image attachments
                event_type: eventType,
                source: 'feedback_gate_extension'
            };
            
            const responseJson = JSON.stringify(responseData, null, 2);
            
            // Write to all response file patterns
            responsePatterns.forEach(responseFile => {
                try {
                    fs.writeFileSync(responseFile, responseJson);
                    logMessage(`MCP response written: ${responseFile}`);
                } catch (writeError) {
                    logMessage(`Failed to write response file ${responseFile}: ${writeError.message}`);
                }
            });
        }
        
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
        // Check if MCP server log exists and is recent
        const mcpLogPath = getTempPath('feedback_gate_v2.log');
        if (fs.existsSync(mcpLogPath)) {
            const stats = fs.statSync(mcpLogPath);
            const now = Date.now();
            const fileAge = now - stats.mtime.getTime();
            
            // Consider MCP active if log file was modified within last 30 seconds
            const wasActive = mcpStatus;
            mcpStatus = fileAge < 30000;
            
            if (wasActive !== mcpStatus) {
                // Silent status change - only update UI
                updateChatPanelStatus();
            }
        } else {
            if (mcpStatus) {
                mcpStatus = false;
                updateChatPanelStatus();
            }
        }
    } catch (error) {
        if (mcpStatus) {
            mcpStatus = false;
            updateChatPanelStatus();
        }
    }
}

function updateChatPanelStatus() {
    if (chatPanel) {
        chatPanel.webview.postMessage({
            command: 'updateMcpStatus',
            active: mcpStatus
        });
    }
}

function discoverMcpPid() {
    /**
     * Discover the MCP server PID that belongs to THIS Cursor window.
     *
     * The MCP server is spawned by the extension-host process (our process.pid).
     * The MCP writes a PID file containing its own PID and its PPID (the extension-host).
     * We match by: PID-file.ppid === process.pid (exact parent match).
     *
     * Fallback: if no PPID match (old PID files without ppid), pick the newest alive process.
     */
    try {
        const tempDir = process.platform === 'win32' ? os.tmpdir() : '/tmp';
        const files = fs.readdirSync(tempDir).filter(f => f.startsWith('feedback_gate_mcp_') && f.endsWith('.pid'));
        
        if (files.length === 0) return null;
        
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
        
        // Primary: find the MCP whose parent is this extension-host process
        for (const entry of entries) {
            if (entry.ppid === myPid) {
                try {
                    process.kill(entry.pid, 0);
                    console.log(`Feedback Gate: matched MCP PID ${entry.pid} via PPID ${myPid}`);
                    return entry.pid;
                } catch {
                    try { fs.unlinkSync(entry.fullPath); } catch {}
                }
            }
        }
        
        // Fallback: old PID files without ppid field — pick newest alive process
        const sorted = entries
            .filter(e => !e.ppid)
            .sort((a, b) => b.mtime - a.mtime);
        
        for (const entry of sorted) {
            try {
                process.kill(entry.pid, 0);
                console.log(`Feedback Gate: fallback bound to MCP PID ${entry.pid} (no PPID in file)`);
                return entry.pid;
            } catch {
                try { fs.unlinkSync(entry.fullPath); } catch {}
            }
        }
    } catch (e) {
        console.log(`MCP PID discovery error: ${e.message}`);
    }
    return null;
}

function startFeedbackGateIntegration(context) {
    // Discover the MCP server PID for this instance
    boundMcpPid = discoverMcpPid();
    if (boundMcpPid) {
        console.log(`Feedback Gate bound to MCP PID: ${boundMcpPid}`);
    }
    
    const pollInterval = setInterval(() => {
        // Re-discover PID periodically in case MCP server restarted
        if (!boundMcpPid) {
            boundMcpPid = discoverMcpPid();
            if (boundMcpPid) {
                console.log(`Feedback Gate discovered MCP PID: ${boundMcpPid}`);
            }
        }
        
        if (boundMcpPid) {
            // Primary: check PID-namespaced trigger file (instance-isolated)
            checkTriggerFile(context, getTempPath(`feedback_gate_trigger_pid${boundMcpPid}.json`));
            for (let i = 0; i < 3; i++) {
                checkTriggerFile(context, getTempPath(`feedback_gate_trigger_pid${boundMcpPid}_${i}.json`));
            }
        }
        
        // Fallback: check legacy trigger file but only consume if PID matches
        checkTriggerFile(context, getTempPath('feedback_gate_trigger.json'));
        for (let i = 0; i < 3; i++) {
            checkTriggerFile(context, getTempPath(`feedback_gate_trigger_${i}.json`));
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
    
    // Immediate check on startup
    setTimeout(() => {
        boundMcpPid = discoverMcpPid();
        if (boundMcpPid) {
            checkTriggerFile(context, getTempPath(`feedback_gate_trigger_pid${boundMcpPid}.json`));
        }
        checkTriggerFile(context, getTempPath('feedback_gate_trigger.json'));
    }, 100);
    
    vscode.window.showInformationMessage('Feedback Gate MCP 集成就绪！正在监听 Cursor Agent 工具调用…');
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
            
            if (triggerData.system && triggerData.system !== 'feedback-gate-v2') {
                return;
            }
            
            // Instance isolation: only consume triggers that belong to this Cursor window.
            // Match by PPID (the MCP's parent process should be our extension-host PID),
            // or by boundMcpPid if already established.
            const triggerPid = triggerData.pid;
            const triggerPpid = triggerData.ppid;
            const isPidNamespaced = filePath.includes('_pid');
            const myPid = process.pid;
            
            // If trigger has PPID info, use it for precise matching
            if (triggerPpid && triggerPpid !== myPid) {
                // This trigger belongs to a different Cursor window — leave it alone
                return;
            }
            
            if (boundMcpPid && triggerPid && triggerPid !== boundMcpPid) {
                if (!isPidNamespaced) {
                    // Legacy file with wrong PID — skip without deleting
                }
                return;
            }
            
            // If we have no bound PID yet, try to bind via PPID match or process check
            if (!boundMcpPid && triggerPid) {
                if (triggerPpid === myPid) {
                    boundMcpPid = triggerPid;
                    console.log(`Feedback Gate auto-bound to MCP PID: ${boundMcpPid} (PPID match)`);
                } else {
                    try {
                        process.kill(triggerPid, 0);
                        boundMcpPid = triggerPid;
                        console.log(`Feedback Gate auto-bound to MCP PID: ${boundMcpPid} (legacy)`);
                    } catch {
                        try { fs.unlinkSync(filePath); } catch {}
                        return;
                    }
                }
            }
            
            console.log(`Feedback Gate triggered: ${triggerData.data.tool} (PID: ${triggerPid})`);
            
            // Auto-passthrough when disabled
            if (!feedbackGateEnabled) {
                const triggerId = triggerData.data && triggerData.data.trigger_id;
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
            
            // Store current trigger data for response handling
            currentTriggerData = triggerData.data;
            
            handleFeedbackGateToolCall(context, triggerData.data);
            
            // Clean up trigger file immediately
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

function handleFeedbackGateToolCall(context, toolData) {
    // Silent tool call processing
    
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
                message: `Cursor Agent received text input and needs your feedback:\n\n**Text Content:** ${toolData.text_content}\n**Source:** ${toolData.source}\n**Context:** ${toolData.context || 'None'}\n**Processing Mode:** ${toolData.processing_mode}\n\n请审查并提供反馈：`,
                title: toolData.title || "Feedback Gate - Text Input",
                autoFocus: true,
                toolData: toolData,
                mcpIntegration: true
            };
            break;
            
        case 'shutdown_mcp':
            popupOptions = {
                message: `Cursor Agent is requesting to shutdown the MCP server:\n\n**Reason:** ${toolData.reason}\n**Immediate:** ${toolData.immediate ? 'Yes' : 'No'}\n**Cleanup:** ${toolData.cleanup ? 'Yes' : 'No'}\n\nType 'CONFIRM' to proceed with shutdown, or provide alternative instructions:`,
                title: toolData.title || "Feedback Gate - Shutdown Confirmation",
                autoFocus: true,
                toolData: toolData,
                mcpIntegration: true,
                specialHandling: 'shutdown_mcp'
            };
            break;
            
        case 'file_feedback':
            popupOptions = {
                message: toolData.instruction || "Cursor Agent needs you to select files:",
                title: toolData.title || "Feedback Gate - File Feedback",
                autoFocus: true,
                toolData: toolData,
                mcpIntegration: true
            };
            break;
            
        default:
            popupOptions = {
                message: toolData.message || toolData.prompt || toolData.instruction || "Cursor Agent needs your input. Please provide your response:",
                title: toolData.title || "Feedback Gate - General Input",
                autoFocus: true,
                toolData: toolData,
                mcpIntegration: true
            };
    }
    
    // Add trigger ID to popup options
    popupOptions.triggerId = toolData.trigger_id;
    console.log(`🔍 DEBUG: Setting popup triggerId to: ${toolData.trigger_id}`);
    
    // Force consistent title regardless of tool call
    popupOptions.title = "Feedback Gate";
    
    // Immediately open Feedback Gate popup when tools are triggered by Cursor Agent
    openFeedbackGatePopup(context, popupOptions);
    
    // FIXED: Send acknowledgement to MCP server that popup was activated
    sendExtensionAcknowledgement(toolData.trigger_id, toolData.tool);
    
    // Show appropriate notification
    const toolDisplayName = toolData.tool.replace('_', ' ').toUpperCase();
    vscode.window.showInformationMessage(`Cursor Agent triggered "${toolDisplayName}" - Feedback Gate popup opened for your input!`);
}

function sendExtensionAcknowledgement(triggerId, toolType) {
    try {
        const timestamp = new Date().toISOString();
        const ackData = {
            acknowledged: true,
            timestamp: timestamp,
            trigger_id: triggerId,
            tool_type: toolType,
            extension: 'feedback-gate-v2',
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
        specialHandling = null
    } = options;
    
    if (triggerId) {
        currentTriggerData = { ...toolData, trigger_id: triggerId };
    }

    // --- Primary: use bottom panel WebviewView ---
    if (usePanelView && chatViewProvider) {
        if (chatPanel) {
            try { chatPanel.dispose(); } catch {}
            chatPanel = null;
        }
        if (chatViewProvider._view) {
            chatViewProvider._mcpIntegration = mcpIntegration;
            chatViewProvider._currentSpecialHandling = specialHandling;
            if (mcpIntegration) {
                setTimeout(() => {
                    postToWebview({ command: 'updateMcpStatus', active: true });
                }, 100);
            }
            if (mcpIntegration && message) {
                setTimeout(() => {
                    postToWebview({
                        command: 'newMessage',
                        text: message,
                        type: 'system',
                        toolData: toolData,
                        mcpIntegration: mcpIntegration
                    });
                }, 150);
            }
            chatViewProvider.focusView();
            if (autoFocus) {
                setTimeout(() => { postToWebview({ command: 'focus' }); }, 200);
            }
            return;
        }
        // View not yet resolved — try to focus it (triggers resolveWebviewView)
        chatViewProvider._mcpIntegration = mcpIntegration;
        chatViewProvider._currentSpecialHandling = specialHandling;
        if (mcpIntegration) {
            chatViewProvider._pendingMessages.push({ command: 'updateMcpStatus', active: true });
        }
        if (mcpIntegration && message) {
            chatViewProvider._pendingMessages.push({
                command: 'newMessage',
                text: message,
                type: 'system',
                toolData: toolData,
                mcpIntegration: mcpIntegration
            });
        }
        chatViewProvider.focusView().then(ok => {
            if (!ok) {
                console.log('Feedback Gate: bottom panel focus failed, falling back to editor tab');
                usePanelView = false;
                chatViewProvider._pendingMessages = [];
                openFeedbackGatePopup(context, options);
            }
        });
        return;
    }

    // --- Fallback: use editor tab WebviewPanel (old behavior) ---

    if (chatPanel) {
        chatPanel.reveal(vscode.ViewColumn.One);
        chatPanel.title = "Feedback Gate";
        
        if (mcpIntegration) {
            setTimeout(() => {
                postToWebview({
                    command: 'updateMcpStatus',
                    active: true
                });
            }, 100);
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
            const currentTriggerId = (currentTriggerData && currentTriggerData.trigger_id) || triggerId;
            console.log(`🔍 DEBUG: Speech command - currentTriggerData:`, currentTriggerData);
            console.log(`🔍 DEBUG: Speech command - triggerId:`, triggerId);
            console.log(`🔍 DEBUG: Speech command - currentTriggerId:`, currentTriggerId);
            
            switch (webviewMessage.command) {
                case 'send':
                    
                    // Log the user input and write response file for MCP integration
                    const eventType = mcpIntegration ? 'MCP_RESPONSE' : 'FEEDBACK_SUBMITTED';
                    logUserInput(webviewMessage.text, eventType, currentTriggerId, webviewMessage.attachments || []);
                    
                    handleFeedbackMessage(webviewMessage.text, webviewMessage.attachments, currentTriggerId, mcpIntegration, specialHandling);
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
                case 'startRecording':
                    logUserInput('User started speech recording', 'SPEECH_START', currentTriggerId);
                    startNodeRecording(currentTriggerId);
                    break;
                case 'stopRecording':
                    logUserInput('User stopped speech recording', 'SPEECH_STOP', currentTriggerId);
                    stopNodeRecording(currentTriggerId);
                    break;
                case 'showError':
                    vscode.window.showErrorMessage(webviewMessage.message);
                    break;
                case 'ready':
                    // Send initial MCP status
                    // For MCP integrations, show as active when waiting for input
                    postToWebview({
                        command: 'updateMcpStatus',
                        active: mcpIntegration ? true : mcpStatus
                    });
                    // Only send welcome message for manual opens, not MCP tool calls
                    // This prevents duplicate messages from repeated tool calls
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
        },
        undefined,
        context.subscriptions
    );

    // Clean up when panel is closed
    chatPanel.onDidDispose(
        () => {
            chatPanel = null;
            currentTriggerData = null;
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

function getFeedbackGateHTML(title = "Feedback Gate", mcpIntegration = false) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            margin: 0;
            padding: 0;
            height: 100vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        
        .review-container {
            height: 100vh;
            display: flex;
            flex-direction: column;
            max-width: 600px;
            margin: 0 auto;
            width: 100%;
            animation: slideIn 0.3s ease-out;
        }
        
        @keyframes slideIn {
            from {
                opacity: 0;
                transform: translateY(20px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }
        
        .review-header {
            flex-shrink: 0;
            padding: 16px 20px 12px 20px;
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            align-items: center;
            gap: 8px;
            background: var(--vscode-editor-background);
        }
        
        .review-title {
            font-size: 18px;
            font-weight: 600;
            color: var(--vscode-foreground);
        }
        
        .review-author {
            font-size: 12px;
            opacity: 0.7;
            margin-left: auto;
        }
        
        .status-indicator {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: var(--vscode-charts-orange);
            animation: pulse 2s infinite;
            transition: background-color 0.3s ease;
            margin-right: 4px;
        }
        
        .status-indicator.active {
            background: var(--vscode-charts-green);
        }
        
        @keyframes pulse {
            0% { opacity: 1; }
            50% { opacity: 0.5; }
            100% { opacity: 1; }
        }
        
        .messages-container {
            flex: 1;
            overflow-y: auto;
            padding: 16px 20px;
            display: flex;
            flex-direction: column;
            gap: 12px;
        }
        
        .message {
            display: flex;
            gap: 8px;
            animation: messageSlide 0.3s ease-out;
        }
        
        @keyframes messageSlide {
            from {
                opacity: 0;
                transform: translateY(10px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }
        
        .message.user {
            justify-content: flex-end;
        }
        
        .message-bubble {
            max-width: 70%;
            padding: 12px 16px;
            border-radius: 18px;
            word-wrap: break-word;
            white-space: pre-wrap;
        }
        
        .message.system .message-bubble {
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            border-bottom-left-radius: 6px;
        }
        
        .message.user .message-bubble {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border-bottom-right-radius: 6px;
        }
        
        .message.system.plain {
            justify-content: center;
            margin: 8px 0;
        }
        
        .message.system.plain .message-content {
            background: none;
            padding: 8px 16px;
            border-radius: 0;
            font-size: 13px;
            opacity: 0.8;
            font-style: italic;
            text-align: center;
            border: none;
            color: var(--vscode-foreground);
        }
        
        /* Speech error message styling */
        .message.system.plain .message-content[data-speech-error] {
            background: rgba(255, 107, 53, 0.1);
            border: 1px solid rgba(255, 107, 53, 0.3);
            color: var(--vscode-errorForeground);
            font-weight: 500;
            opacity: 1;
            padding: 12px 16px;
            border-radius: 8px;
        }
        
        .message-time {
            font-size: 11px;
            opacity: 0.6;
            margin-top: 4px;
        }
        
        .input-container {
            flex-shrink: 0;
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 16px 20px 20px 20px;
            border-top: 1px solid var(--vscode-panel-border);
            background: var(--vscode-editor-background);
        }
        
        .input-container.disabled {
            opacity: 0.5;
            pointer-events: none;
        }
        
        .input-wrapper {
            flex: 1;
            display: flex;
            align-items: center;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 20px;
            padding: 8px 12px;
            transition: all 0.2s ease;
            position: relative;
        }
        
        .mic-icon {
            position: absolute;
            left: 16px;
            top: 50%;
            transform: translateY(-50%);
            color: var(--vscode-input-placeholderForeground);
            font-size: 14px;
            pointer-events: none;
            opacity: 0.7;
            transition: all 0.2s ease;
        }
        
        .mic-icon.active {
            color: #ff6b35;
            opacity: 1;
            pointer-events: auto;
            cursor: pointer;
        }
        
        .mic-icon.recording {
            color: #ff3333;
            animation: pulse 1.5s infinite;
        }
        
        .mic-icon.processing {
            color: #ff6b35;
            animation: spin 1s linear infinite;
        }
        
        @keyframes spin {
            0% { transform: translateY(-50%) rotate(0deg); }
            100% { transform: translateY(-50%) rotate(360deg); }
        }
        
        .input-wrapper:focus-within {
            border-color: transparent;
            box-shadow: 0 0 0 2px rgba(255, 165, 0, 0.4), 0 0 8px rgba(255, 165, 0, 0.2);
        }
        
        .message-input {
            flex: 1;
            background: transparent;
            border: none !important;
            outline: none !important;
            box-shadow: none !important;
            color: var(--vscode-input-foreground);
            resize: none;
            min-height: 20px;
            max-height: 120px;
            font-family: inherit;
            font-size: 14px;
            line-height: 1.4;
            padding-left: 24px; /* Make room for mic icon */
        }
        
        .message-input:focus {
            border: none !important;
            outline: none !important;
            box-shadow: none !important;
        }
        
        .message-input:focus-visible {
            border: none !important;
            outline: none !important;
            box-shadow: none !important;
        }
        
        .message-input::placeholder {
            color: var(--vscode-input-placeholderForeground);
        }
        
        .message-input:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        
        .message-input.paste-highlight {
            box-shadow: 0 0 0 2px rgba(0, 123, 255, 0.4) !important;
            transition: box-shadow 0.2s ease;
        }
        
        .attach-button {
            background: none;
            border: none;
            color: var(--vscode-foreground);
            cursor: pointer;
            font-size: 14px;
            padding: 4px;
            border-radius: 50%;
            width: 28px;
            height: 28px;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s ease;
        }
        
        .attach-button:hover {
            background: var(--vscode-button-hoverBackground);
            transform: scale(1.1);
        }
        
        .attach-button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
            transform: none;
        }
        
        .send-button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 50%;
            width: 36px;
            height: 36px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s ease;
            font-size: 14px;
        }
        
        .send-button:hover {
            background: var(--vscode-button-hoverBackground);
            transform: scale(1.05);
        }
        
        .send-button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
            transform: none;
        }
        
        .typing-indicator {
            display: none;
            align-items: center;
            gap: 8px;
            padding: 8px 16px;
            font-size: 12px;
            opacity: 0.7;
        }
        
        .typing-dots {
            display: flex;
            gap: 2px;
        }
        
        .typing-dot {
            width: 4px;
            height: 4px;
            background: var(--vscode-foreground);
            border-radius: 50%;
            animation: typingDot 1.4s infinite ease-in-out;
        }
        
        .typing-dot:nth-child(1) { animation-delay: -0.32s; }
        .typing-dot:nth-child(2) { animation-delay: -0.16s; }
        
        @keyframes typingDot {
            0%, 80%, 100% { transform: scale(0); }
            40% { transform: scale(1); }
        }
        
        .mcp-status {
            font-size: 11px;
            opacity: 0.6;
            margin-left: 4px;
        }
        
        /* Drag and drop styling */
        body.drag-over {
            background: rgba(0, 123, 255, 0.05);
        }
        
        body.drag-over::before {
            content: 'Drop images here to attach them';
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 16px 24px 16px 48px;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 500;
            z-index: 1000;
            pointer-events: none;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
            font-family: var(--vscode-font-family);
        }
        
        body.drag-over::after {
            content: '\\f093';
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%) translate(-120px, 0);
            color: var(--vscode-badge-foreground);
            font-size: 16px;
            z-index: 1001;
            pointer-events: none;
            font-family: 'Font Awesome 6 Free';
            font-weight: 900;
        }
        
        /* Image preview styling */
        .image-preview {
            position: relative;
        }
        
        .image-container {
            position: relative;
        }
        
        .image-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
        }
        
        .image-filename {
            font-size: 12px;
            font-weight: 500;
            opacity: 0.9;
            flex: 1;
            margin-right: 8px;
            word-break: break-all;
        }
        
        .remove-image-btn {
            background: rgba(255, 59, 48, 0.1);
            border: 1px solid rgba(255, 59, 48, 0.3);
            color: #ff3b30;
            border-radius: 50%;
            width: 20px;
            height: 20px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 10px;
            transition: all 0.2s ease;
            flex-shrink: 0;
        }
        
        .remove-image-btn:hover {
            background: rgba(255, 59, 48, 0.2);
            border-color: rgba(255, 59, 48, 0.5);
            transform: scale(1.1);
        }
        
        .remove-image-btn:active {
            transform: scale(0.95);
        }
    </style>
</head>
<body>
    <div class="review-container">
        <div class="review-header">
            <div class="review-title">${title}</div>
            <div class="status-indicator" id="statusIndicator"></div>
            <div class="mcp-status" id="mcpStatus">等待 Agent 调用</div>
            <div class="review-author">by chenrong</div>
        </div>
        
        <div class="messages-container" id="messages">
            <!-- Messages will be added here -->
        </div>
        
        <div class="typing-indicator" id="typingIndicator">
            <span>Processing review</span>
            <div class="typing-dots">
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
            </div>
        </div>
        
        <div class="input-container" id="inputContainer">
            <div class="input-wrapper">
                <i id="micIcon" class="fas fa-microphone mic-icon active" title="点击说话"></i>
                <textarea id="messageInput" class="message-input" placeholder="${mcpIntegration ? 'Cursor Agent 正在等待你的回复…' : '请输入你的审查反馈…'}" rows="1"></textarea>
                <button id="attachButton" class="attach-button" title="Upload image">
                    <i class="fas fa-image"></i>
                </button>
            </div>
            <button id="sendButton" class="send-button" title="${mcpIntegration ? '发送回复给 Agent' : '发送审查'}">
                <i class="fas fa-arrow-up"></i>
            </button>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        
        const messagesContainer = document.getElementById('messages');
        const messageInput = document.getElementById('messageInput');
        const sendButton = document.getElementById('sendButton');
        const attachButton = document.getElementById('attachButton');
        const micIcon = document.getElementById('micIcon');
        const typingIndicator = document.getElementById('typingIndicator');
        const statusIndicator = document.getElementById('statusIndicator');
        const mcpStatus = document.getElementById('mcpStatus');
        const inputContainer = document.getElementById('inputContainer');
        
        let messageCount = 0;
        let mcpActive = true; // Default to true for better UX
        let mcpIntegration = ${mcpIntegration};
        let attachedImages = []; // Store uploaded images
        let isRecording = false;
        let mediaRecorder = null;
        
        function updateMcpStatus(active) {
            mcpActive = active;
            
            if (active) {
                statusIndicator.classList.add('active');
                mcpStatus.textContent = 'MCP 已激活';
                inputContainer.classList.remove('disabled');
                messageInput.disabled = false;
                sendButton.disabled = false;
                attachButton.disabled = false;
                messageInput.placeholder = mcpIntegration ? 'Cursor Agent 正在等待你的回复…' : '请输入你的审查反馈…';
            } else {
                statusIndicator.classList.remove('active');
                mcpStatus.textContent = 'MCP 未激活';
                inputContainer.classList.add('disabled');
                messageInput.disabled = true;
                sendButton.disabled = true;
                attachButton.disabled = true;
                messageInput.placeholder = 'MCP 服务未启动，请先启动服务以启用输入。';
            }
        }
        
        function addMessage(text, type = 'user', toolData = null, plain = false, isError = false) {
            messageCount++;
            const messageDiv = document.createElement('div');
            messageDiv.className = \`message \${type}\${plain ? ' plain' : ''}\`;
            
            const contentDiv = document.createElement('div');
            contentDiv.className = plain ? 'message-content' : 'message-bubble';
            contentDiv.textContent = text;
            
            // Add special styling for speech errors
            if (isError && plain) {
                contentDiv.setAttribute('data-speech-error', 'true');
            }
            
            messageDiv.appendChild(contentDiv);
            
            // Only add timestamp for non-plain messages
            if (!plain) {
                const timeDiv = document.createElement('div');
                timeDiv.className = 'message-time';
                timeDiv.textContent = new Date().toLocaleTimeString();
                messageDiv.appendChild(timeDiv);
            }
            
            messagesContainer.appendChild(messageDiv);
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }
        
        function addSpeechError(errorMessage) {
            // Add prominent error message with special styling
            addMessage('🎤 Speech Error: ' + errorMessage, 'system', null, true, true);
            
            // Add helpful troubleshooting tips based on error type
            let tip = '';
            if (errorMessage.includes('permission') || errorMessage.includes('Permission')) {
                tip = '💡 Grant microphone access in system settings';
            } else if (errorMessage.includes('busy') || errorMessage.includes('device')) {
                tip = '💡 Close other recording apps and try again';
            } else if (errorMessage.includes('SoX') || errorMessage.includes('sox')) {
                tip = '💡 SoX audio tool may need to be installed or updated';
            } else if (errorMessage.includes('timeout')) {
                tip = '💡 Try speaking more clearly or check microphone connection';
            } else if (errorMessage.includes('Whisper') || errorMessage.includes('transcription')) {
                tip = '💡 Speech-to-text service may be unavailable';
            } else {
                tip = '💡 Check microphone permissions and try again';
            }
            
            if (tip) {
                setTimeout(() => {
                    addMessage(tip, 'system', null, true);
                }, 500);
            }
        }
        
        function showTyping() {
            typingIndicator.style.display = 'flex';
        }
        
        function hideTyping() {
            typingIndicator.style.display = 'none';
        }
        
        function simulateResponse(userMessage) {
            // Don't simulate response - the backend handles acknowledgments now
            // This avoids duplicate messages
            hideTyping();
        }
        
        function sendMessage() {
            const text = messageInput.value.trim();
            if (!text && attachedImages.length === 0) return;
            
            // Create message with text and images
            let displayMessage = text;
            if (attachedImages.length > 0) {
                displayMessage += (text ? '\\n\\n' : '') + \`[\${attachedImages.length} image(s) attached]\`;
            }
            
            addMessage(displayMessage, 'user');
            
            // Send to extension with images
            vscode.postMessage({
                command: 'send',
                text: text,
                attachments: attachedImages,
                timestamp: new Date().toISOString(),
                mcpIntegration: mcpIntegration
            });
            
            messageInput.value = '';
            attachedImages = []; // Clear attached images
            adjustTextareaHeight();
            
            // Ensure mic icon is visible after sending message
            toggleMicIcon();
            
            simulateResponse(displayMessage);
        }
        
        function adjustTextareaHeight() {
            messageInput.style.height = 'auto';
            messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
        }
        
        function handleImageUploaded(imageData) {
            // Add image to attachments with unique ID
            const imageId = 'img_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            imageData.id = imageId;
            attachedImages.push(imageData);
            
            // Show image preview in messages with remove button
            const imagePreview = document.createElement('div');
            imagePreview.className = 'message system image-preview';
            imagePreview.setAttribute('data-image-id', imageId);
            imagePreview.innerHTML = \`
                <div class="message-bubble image-container">
                    <div class="image-header">
                        <span class="image-filename">\${imageData.fileName}</span>
                        <button class="remove-image-btn" onclick="removeImage('\${imageId}')" title="Remove image">
                            <i class="fas fa-times"></i>
                        </button>
                    </div>
                    <img src="\${imageData.dataUrl}" style="max-width: 200px; max-height: 200px; border-radius: 8px; margin-top: 8px;" alt="Uploaded image">
                    <div style="margin-top: 8px; font-size: 12px; opacity: 0.7;">Image ready to send (\${(imageData.size / 1024).toFixed(1)} KB)</div>
                </div>
                <div class="message-time">\${new Date().toLocaleTimeString()}</div>
            \`;
            messagesContainer.appendChild(imagePreview);
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
            
            updateImageCounter();
        }
        
        // Remove image function
        function removeImage(imageId) {
            // Remove from attachments array
            attachedImages = attachedImages.filter(img => img.id !== imageId);
            
            // Remove from DOM
            const imagePreview = document.querySelector(\`[data-image-id="\${imageId}"]\`);
            if (imagePreview) {
                imagePreview.remove();
            }
            
            updateImageCounter();
            
            // Log removal
            console.log(\`🗑️ Image removed: \${imageId}\`);
            vscode.postMessage({
                command: 'logImageRemoved',
                imageId: imageId
            });
        }
        
        // Update image counter in input placeholder
        function updateImageCounter() {
            const count = attachedImages.length;
            const baseText = mcpIntegration ? 'Cursor Agent 正在等待你的回复' : '请输入你的审查反馈';
            
            if (count > 0) {
                messageInput.placeholder = \`\${baseText}… 已附加 \${count} 张图片\`;
            } else {
                messageInput.placeholder = \`\${baseText}…\`;
            }
        }
        
        // Handle paste events for images with debounce to prevent duplicates
        let lastPasteTime = 0;
        function handlePaste(e) {
            const now = Date.now();
            // Prevent duplicate pastes within 500ms
            if (now - lastPasteTime < 500) {
                return;
            }
            
            const clipboardData = e.clipboardData || window.clipboardData;
            if (!clipboardData) return;
            
            const items = clipboardData.items;
            if (!items) return;
            
            // Look for image items in clipboard
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                
                if (item.type.indexOf('image') !== -1) {
                    e.preventDefault(); // Prevent default paste behavior for images
                    lastPasteTime = now; // Update last paste time
                    
                    const file = item.getAsFile();
                    if (file) {
                        processPastedImage(file);
                    }
                    break;
                }
            }
        }
        
        // Process pasted image file
        function processPastedImage(file) {
            const reader = new FileReader();
            
            reader.onload = function(e) {
                const dataUrl = e.target.result;
                const base64Data = dataUrl.split(',')[1];
                
                // Generate a filename with timestamp
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const extension = file.type.split('/')[1] || 'png';
                const fileName = \`pasted-image-\${timestamp}.\${extension}\`;
                
                const imageData = {
                    fileName: fileName,
                    filePath: 'clipboard', // Indicate this came from clipboard
                    mimeType: file.type,
                    base64Data: base64Data,
                    dataUrl: dataUrl,
                    size: file.size,
                    source: 'paste' // Mark as pasted image
                };
                
                console.log(\`📋 Image pasted: \${fileName} (\${file.size} bytes)\`);
                
                // Log the pasted image for MCP integration
                vscode.postMessage({
                    command: 'logPastedImage',
                    fileName: fileName,
                    size: file.size,
                    mimeType: file.type
                });
                
                // Add to attachments and show preview
                handleImageUploaded(imageData);
            };
            
            reader.onerror = function() {
                console.error('Error reading pasted image');
                addMessage('❌ Error processing pasted image', 'system', null, true);
            };
            
            reader.readAsDataURL(file);
        }
        
        // Drag and drop handlers
        let dragCounter = 0;
        
        function handleDragEnter(e) {
            e.preventDefault();
            dragCounter++;
            if (hasImageFiles(e.dataTransfer)) {
                document.body.classList.add('drag-over');
                messageInput.classList.add('paste-highlight');
            }
        }
        
        function handleDragLeave(e) {
            e.preventDefault();
            dragCounter--;
            if (dragCounter <= 0) {
                document.body.classList.remove('drag-over');
                messageInput.classList.remove('paste-highlight');
                dragCounter = 0;
            }
        }
        
        function handleDragOver(e) {
            e.preventDefault();
            if (hasImageFiles(e.dataTransfer)) {
                e.dataTransfer.dropEffect = 'copy';
            }
        }
        
        function handleDrop(e) {
            e.preventDefault();
            dragCounter = 0;
            document.body.classList.remove('drag-over');
            messageInput.classList.remove('paste-highlight');
            
            const files = e.dataTransfer.files;
            if (files && files.length > 0) {
                // Process files with a small delay to prevent conflicts with paste events
                setTimeout(() => {
                    for (let i = 0; i < files.length; i++) {
                        const file = files[i];
                        if (file.type.startsWith('image/')) {
                            // Log drag and drop action
                            vscode.postMessage({
                                command: 'logDragDropImage',
                                fileName: file.name,
                                size: file.size,
                                mimeType: file.type
                            });
                            processPastedImage(file);
                        }
                    }
                }, 50);
            }
        }
        
        function hasImageFiles(dataTransfer) {
            if (dataTransfer.types) {
                for (let i = 0; i < dataTransfer.types.length; i++) {
                    if (dataTransfer.types[i] === 'Files') {
                        return true; // We'll check for images on drop
                    }
                }
            }
            return false;
        }
        
        // Hide/show mic icon based on input
        function toggleMicIcon() {
            // Don't toggle if we're currently recording or processing
            if (isRecording || micIcon.classList.contains('processing')) {
                return;
            }
            
            if (messageInput.value.trim().length > 0) {
                micIcon.style.opacity = '0';
                micIcon.style.pointerEvents = 'none';
            } else {
                // Always ensure mic is visible and clickable when input is empty
                micIcon.style.opacity = '0.7';
                micIcon.style.pointerEvents = 'auto';
                // Ensure proper mic icon state
                if (!micIcon.classList.contains('fa-microphone')) {
                    micIcon.className = 'fas fa-microphone mic-icon active';
                }
            }
        }
        
        // Check if speech recording is available
        function isSpeechAvailable() {
            return (
                navigator.mediaDevices && 
                navigator.mediaDevices.getUserMedia && 
                typeof MediaRecorder !== 'undefined'
            );
        }
        
        // Speech recording functions - using Node.js backend
        function startRecording() {
            // Start recording via extension backend
            vscode.postMessage({
                command: 'startRecording',
                timestamp: new Date().toISOString()
            });
            
            isRecording = true;
            // Change icon to stop icon and add recording state
            micIcon.className = 'fas fa-stop mic-icon recording';
            micIcon.title = '录音中… 点击停止';
            console.log('🎤 Recording started - UI updated to stop icon');
        }
        
        function stopRecording() {
            // Stop recording via extension backend
            vscode.postMessage({
                command: 'stopRecording',
                timestamp: new Date().toISOString()
            });
            
            isRecording = false;
            // Change to processing state
            micIcon.className = 'fas fa-spinner mic-icon processing';
            micIcon.title = '正在处理语音…';
            messageInput.placeholder = '正在处理语音… 请稍候';
            console.log('🔄 Recording stopped - processing speech...');
        }
        
        function resetMicIcon() {
            // Reset to normal microphone state
            isRecording = false; // Ensure recording flag is cleared
            micIcon.className = 'fas fa-microphone mic-icon active';
            micIcon.title = '点击说话';
            messageInput.placeholder = mcpIntegration ? 'Cursor Agent 正在等待你的回复…' : '请输入你的审查反馈…';
            
            // Force visibility based on input state
            if (messageInput.value.trim().length === 0) {
                micIcon.style.opacity = '0.7';
                micIcon.style.pointerEvents = 'auto';
            } else {
                micIcon.style.opacity = '0';
                micIcon.style.pointerEvents = 'none';
            }
            
            console.log('🎤 Mic icon reset to normal state');
        }
        
        // Event listeners
        messageInput.addEventListener('input', () => {
            adjustTextareaHeight();
            toggleMicIcon();
        });
        
        messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                sendMessage();
            }
        });
        
        // Add paste event listener for images
        messageInput.addEventListener('paste', handlePaste);
        document.addEventListener('paste', handlePaste);
        
        // Add drag and drop support for images
        document.addEventListener('dragover', handleDragOver);
        document.addEventListener('drop', handleDrop);
        document.addEventListener('dragenter', handleDragEnter);
        document.addEventListener('dragleave', handleDragLeave);
        
        sendButton.addEventListener('click', () => {
            sendMessage();
        });
        
        attachButton.addEventListener('click', () => {
            vscode.postMessage({ command: 'uploadImage' });
        });
        
        micIcon.addEventListener('click', () => {
            if (isRecording) {
                stopRecording();
            } else {
                startRecording();
            }
        });
        
        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            
            switch (message.command) {
                case 'addMessage':
                    addMessage(message.text, message.type || 'system', message.toolData, message.plain || false);
                    break;
                case 'newMessage':
                    addMessage(message.text, message.type || 'system', message.toolData, message.plain || false);
                    if (message.mcpIntegration) {
                        mcpIntegration = true;
                        messageInput.placeholder = 'Cursor Agent 正在等待你的回复…';
                    }
                    break;
                case 'focus':
                    messageInput.focus();
                    break;
                case 'updateMcpStatus':
                    updateMcpStatus(message.active);
                    break;
                case 'imageUploaded':
                    handleImageUploaded(message.imageData);
                    break;
                case 'recordingStarted':
                    console.log('✅ Recording confirmation received from backend');
                    break;
                case 'speechTranscribed':
                    // Handle speech-to-text result
                    console.log('📝 Speech transcription received:', message);
                    if (message.transcription && message.transcription.trim()) {
                        messageInput.value = message.transcription.trim();
                        adjustTextareaHeight();
                        messageInput.focus();
                        console.log('✅ Text injected into input:', message.transcription.trim());
                        // Reset mic icon after successful transcription
                        resetMicIcon();
                    } else if (message.error) {
                        console.error('❌ Speech transcription error:', message.error);
                        
                        // Show prominent error message in chat
                        addSpeechError(message.error);
                        
                        // Also show in placeholder briefly
                        const originalPlaceholder = messageInput.placeholder;
                        messageInput.placeholder = '语音识别失败 - 请重试';
                        setTimeout(() => {
                            messageInput.placeholder = originalPlaceholder;
                            resetMicIcon();
                        }, 3000);
                    } else {
                        console.log('⚠️ Empty transcription received');
                        
                        // Show helpful message in chat
                        addMessage('🎤 未检测到语音 - 请清晰说话后重试', 'system', null, true);
                        
                        const originalPlaceholder = messageInput.placeholder;
                        messageInput.placeholder = '未检测到语音 - 请重试';
                        setTimeout(() => {
                            messageInput.placeholder = originalPlaceholder;
                            resetMicIcon();
                        }, 3000);
                    }
                    break;
            }
        });
        
        // Initialize speech availability - now using SoX directly
        function initializeSpeech() {
            // Always available since we're using SoX directly
            micIcon.style.opacity = '0.7';
            micIcon.style.pointerEvents = 'auto';
            micIcon.title = '点击说话（SoX 录音）';
            micIcon.classList.add('active');
            console.log('Speech recording available via SoX direct recording');
            
            // Ensure mic icon visibility on initialization
            if (messageInput.value.trim().length === 0) {
                micIcon.style.opacity = '0.7';
                micIcon.style.pointerEvents = 'auto';
            }
        }
        
        // Make removeImage globally accessible for onclick handlers
        window.removeImage = removeImage;
        
        // Initialize
        vscode.postMessage({ command: 'ready' });
        initializeSpeech();
        
        // Focus input immediately
        setTimeout(() => {
            messageInput.focus();
        }, 100);
    </script>
</body>
</html>`;
}

function handleFeedbackMessage(text, attachments, triggerId, mcpIntegration, specialHandling) {
    const funnyResponses = [
        "已发送 — 坐稳了，等 Agent 再次敲门！🎢",
        "消息已送达！Agent 正在全力处理中… ⚡",
        "您的智慧已传送到 AI 总部！🤖",
        "反馈已发射 — 即将产生 Agent 魔法！✨",
        "审查门已关闭 — Agent 正在消化你的输入！🍕",
        "消息已收到，归档为「大概很重要」！📁",
        "你的意见已纳入 Agent 的总规划！🧠",
        "反馈已送达 — Agent 欠你一个人情！🤝",
        "成功！你的想法将在 Agent 的梦中萦绕！👻",
        "比周五晚上的外卖还快送达！🍕"
    ];
    
    // Silent message processing
    
    // Handle special cases for different tool types
    if (specialHandling === 'shutdown_mcp') {
        if (text.toUpperCase().includes('CONFIRM') || text.toUpperCase() === 'YES') {
            logUserInput(`SHUTDOWN CONFIRMED: ${text}`, 'SHUTDOWN_CONFIRMED', triggerId);
            
            setTimeout(() => {
                postToWebview({
                    command: 'addMessage',
                    text: `🛑 关闭已确认: "${text}"\n\n用户已批准 MCP 服务器关闭。\n\nCursor Agent 将执行优雅关闭。`,
                    type: 'system'
                });
                setTimeout(() => { postToWebview({ command: 'updateMcpStatus', active: false }); }, 1000);
            }, 500);
        } else {
            logUserInput(`SHUTDOWN ALTERNATIVE: ${text}`, 'SHUTDOWN_ALTERNATIVE', triggerId);
            
            setTimeout(() => {
                postToWebview({
                    command: 'addMessage',
                    text: `💡 替代指令: "${text}"\n\n你的指令已发送给 Cursor Agent，替代关闭确认。\n\nAgent 将处理你的替代请求。`,
                    type: 'system'
                });
                setTimeout(() => { postToWebview({ command: 'updateMcpStatus', active: false }); }, 1000);
            }, 500);
        }
    } else if (specialHandling === 'ingest_text') {
        logUserInput(`TEXT FEEDBACK: ${text}`, 'TEXT_FEEDBACK', triggerId);
        
        setTimeout(() => {
            postToWebview({
                command: 'addMessage',
                text: `🔄 文本输入已处理: "${text}"\n\n你的反馈已发送给 Cursor Agent。\n\nAgent 将基于你的输入继续处理。`,
                type: 'system'
            });
            setTimeout(() => { postToWebview({ command: 'updateMcpStatus', active: false }); }, 1000);
        }, 500);
    } else {
        // Standard handling for other tools
        // Log to output channel for persistence
        outputChannel.appendLine(`${mcpIntegration ? 'MCP RESPONSE' : 'REVIEW'} SUBMITTED: ${text}`);
        
        setTimeout(() => {
            const randomResponse = funnyResponses[Math.floor(Math.random() * funnyResponses.length)];
            postToWebview({
                command: 'addMessage',
                text: randomResponse,
                type: 'system',
                plain: true
            });
            setTimeout(() => { postToWebview({ command: 'updateMcpStatus', active: false }); }, 1000);
        }, 500);
    }
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
            
            if (getActiveWebview()) {
                postToWebview({
                    command: 'addMessage',
                    text: `Files attached for review:\n${fileNames.map(name => '• ' + name).join('\n')}\n\nPaths:\n${filePaths.map(fp => '• ' + fp).join('\n')}`,
                    type: 'system'
                });
            }
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
                    
                    // Send image data to webview
                    if (getActiveWebview()) {
                        postToWebview({
                            command: 'imageUploaded',
                            imageData: imageData
                        });
                    }
                    
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

function getMimeType(fileName) {
    const ext = path.extname(fileName).toLowerCase();
    const mimeTypes = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.bmp': 'image/bmp',
        '.webp': 'image/webp'
    };
    return mimeTypes[ext] || 'image/jpeg';
}

async function handleSpeechToText(audioData, triggerId, isFilePath = false) {
    try {
        let tempAudioPath;
        
        if (isFilePath) {
            // Audio data is already a file path
            tempAudioPath = audioData;
            console.log(`Using existing audio file for transcription: ${tempAudioPath}`);
        } else {
            // Convert base64 audio data to buffer (legacy webview approach)
            const base64Data = audioData.split(',')[1];
            const audioBuffer = Buffer.from(base64Data, 'base64');
            
            // Save audio to temp file
            tempAudioPath = getTempPath(`feedback_gate_audio_${triggerId}_${Date.now()}.wav`);
            fs.writeFileSync(tempAudioPath, audioBuffer);
            
            console.log(`Audio saved for transcription: ${tempAudioPath}`);
        }
        
        // Send to MCP server for transcription
        const transcriptionRequest = {
            timestamp: new Date().toISOString(),
            system: "feedback-gate-v2",
            editor: "cursor",
            data: {
                tool: "speech_to_text",
                audio_file: tempAudioPath,
                trigger_id: triggerId,
                format: "wav"
            },
            mcp_integration: true
        };
        
        const triggerFile = getTempPath(`feedback_gate_speech_trigger_${triggerId}.json`);
        fs.writeFileSync(triggerFile, JSON.stringify(transcriptionRequest, null, 2));
        
        console.log(`Speech-to-text request sent: ${triggerFile}`);
        
        // Poll for transcription result
        const maxWaitTime = 30000; // 30 seconds
        const pollInterval = 500; // 500ms
        let waitTime = 0;
        
        const pollForResult = setInterval(() => {
            const resultFile = getTempPath(`feedback_gate_speech_response_${triggerId}.json`);
            
            if (fs.existsSync(resultFile)) {
                try {
                    const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
                    
                    if (result.transcription) {
                        // Send transcription back to webview
                        if (getActiveWebview()) {
                            postToWebview({
                                command: 'speechTranscribed',
                                transcription: result.transcription
                            });
                        }
                        
                        console.log(`Speech transcribed: ${result.transcription}`);
                        logUserInput(`Speech transcribed: ${result.transcription}`, 'SPEECH_TRANSCRIBED', triggerId);
                    }
                    
                    // Cleanup - let MCP server handle audio file cleanup to avoid race conditions
                    try {
                        fs.unlinkSync(resultFile);
                        console.log('✅ Cleaned up speech response file');
                    } catch (e) {
                        console.log(`Could not clean up response file: ${e.message}`);
                    }
                    
                    try {
                        fs.unlinkSync(triggerFile);
                        console.log('✅ Cleaned up speech trigger file');
                    } catch (e) {
                        console.log(`Could not clean up trigger file: ${e.message}`);
                    }
                    
                    // Note: Audio file cleanup is handled by MCP server to avoid race conditions
                    
                } catch (error) {
                    console.log(`Error reading transcription result: ${error.message}`);
                }
                
                clearInterval(pollForResult);
            }
            
            waitTime += pollInterval;
            if (waitTime >= maxWaitTime) {
                console.log('Speech-to-text timeout');
                if (getActiveWebview()) {
                    postToWebview({
                        command: 'speechTranscribed',
                        transcription: '' // Empty transcription on timeout
                    });
                }
                clearInterval(pollForResult);
                
                // Cleanup on timeout - only clean up trigger file
                try {
                    fs.unlinkSync(triggerFile);
                    console.log('✅ Cleaned up trigger file on timeout');
                } catch (e) {
                    console.log(`Could not clean up trigger file on timeout: ${e.message}`);
                }
                // Note: Audio file cleanup handled by MCP server or OS temp cleanup
            }
        }, pollInterval);
        
    } catch (error) {
        console.log(`Speech-to-text error: ${error.message}`);
        if (getActiveWebview()) {
            postToWebview({
                command: 'speechTranscribed',
                transcription: '' // Empty transcription on error
            });
        }
    }
}

async function validateSoxSetup() {
    /**
     * Validate SoX installation and microphone access
     * Returns: {success: boolean, error: string}
     */
    return new Promise((resolve) => {
        try {
            // Test if sox command exists
            const testProcess = spawn('sox', ['--version'], { stdio: 'pipe' });
            
            let soxVersion = '';
            testProcess.stdout.on('data', (data) => {
                soxVersion += data.toString();
            });
            
            testProcess.on('close', (code) => {
                if (code !== 0) {
                    resolve({ success: false, error: 'SoX command not found or failed' });
                    return;
                }
                
                console.log(`✅ SoX found: ${soxVersion.trim()}`);
                
                // Test microphone access with a very short recording
                const testFile = getTempPath(`feedback_gate_test_${Date.now()}.wav`);
                const micTestProcess = spawn('sox', ['-d', '-r', '16000', '-c', '1', testFile, 'trim', '0', '0.1'], { stdio: 'pipe' });
                
                let testError = '';
                micTestProcess.stderr.on('data', (data) => {
                    testError += data.toString();
                });
                
                micTestProcess.on('close', (testCode) => {
                    // Clean up test file
                    try {
                        if (fs.existsSync(testFile)) {
                            fs.unlinkSync(testFile);
                        }
                    } catch (e) {}
                    
                    if (testCode !== 0) {
                        let errorMsg = 'Microphone access failed';
                        if (testError.includes('Permission denied')) {
                            errorMsg = 'Microphone permission denied - please allow microphone access in system settings';
                        } else if (testError.includes('No such device')) {
                            errorMsg = 'No microphone device found';
                        } else if (testError.includes('Device or resource busy')) {
                            errorMsg = 'Microphone is busy - close other recording applications';
                        } else if (testError) {
                            errorMsg = `Microphone test failed: ${testError.substring(0, 100)}`;
                        }
                        resolve({ success: false, error: errorMsg });
                    } else {
                        console.log('✅ Microphone access test successful');
                        resolve({ success: true, error: null });
                    }
                });
                
                // Timeout for microphone test
                setTimeout(() => {
                    try {
                        micTestProcess.kill('SIGTERM');
                        resolve({ success: false, error: 'Microphone test timed out' });
                    } catch (e) {}
                }, 3000);
            });
            
            testProcess.on('error', (error) => {
                resolve({ success: false, error: `SoX not installed: ${error.message}` });
            });
            
            // Timeout for version check
            setTimeout(() => {
                try {
                    testProcess.kill('SIGTERM');
                    resolve({ success: false, error: 'SoX version check timed out' });
                } catch (e) {}
            }, 2000);
            
        } catch (error) {
            resolve({ success: false, error: `SoX validation error: ${error.message}` });
        }
    });
}

async function startNodeRecording(triggerId) {
    try {
        if (currentRecording) {
            console.log('Recording already in progress');
            // Send feedback to webview
            if (getActiveWebview()) {
                postToWebview({
                    command: 'speechTranscribed',
                    transcription: '',
                    error: '录音正在进行中'
                });
            }
            return;
        }
        
        // Validate SoX setup before recording
        console.log('🔍 Validating SoX and microphone setup...');
        const validation = await validateSoxSetup();
        if (!validation.success) {
            console.log(`❌ SoX validation failed: ${validation.error}`);
            if (getActiveWebview()) {
                postToWebview({
                    command: 'speechTranscribed',
                    transcription: '',
                    error: validation.error
                });
            }
            return;
        }
        console.log('✅ SoX validation successful - proceeding with recording');
        
        const timestamp = Date.now();
        const audioFile = getTempPath(`feedback_gate_audio_${triggerId}_${timestamp}.wav`);
        
        console.log(`🎤 Starting SoX recording: ${audioFile}`);
        
        // Use sox directly to record audio
        // sox -d -r 16000 -c 1 output.wav (let SoX auto-detect bit depth)
        const soxArgs = [
            '-d',           // Use default input device (microphone)
            '-r', '16000',  // Sample rate 16kHz
            '-c', '1',      // Mono (1 channel)
            audioFile       // Output file
        ];
        
        console.log(`🎤 Starting sox with args:`, soxArgs);
        
        // Spawn sox process
        currentRecording = spawn('sox', soxArgs);
        
        // Store metadata
        currentRecording.audioFile = audioFile;
        currentRecording.triggerId = triggerId;
        currentRecording.startTime = Date.now();
        
        // Handle sox process events
        currentRecording.on('error', (error) => {
            console.log(`❌ SoX process error: ${error.message}`);
            if (getActiveWebview()) {
                postToWebview({
                    command: 'speechTranscribed',
                    transcription: '',
                    error: `录音失败: ${error.message}`
                });
            }
            currentRecording = null;
        });
        
        currentRecording.stderr.on('data', (data) => {
            console.log(`SoX stderr: ${data}`);
        });
        
        console.log(`✅ SoX recording started: PID ${currentRecording.pid}, file: ${audioFile}`);
        
        // Send confirmation to webview that recording has started
        if (getActiveWebview()) {
            postToWebview({
                command: 'recordingStarted',
                audioFile: audioFile
            });
        }
        
    } catch (error) {
        console.log(`❌ Failed to start SoX recording: ${error.message}`);
        if (getActiveWebview()) {
            postToWebview({
                command: 'speechTranscribed',
                transcription: '',
                error: `录音失败: ${error.message}`
            });
        }
        currentRecording = null;
    }
}

function stopNodeRecording(triggerId) {
    try {
        if (!currentRecording) {
            console.log('No recording in progress');
            if (getActiveWebview()) {
                postToWebview({
                    command: 'speechTranscribed',
                    transcription: '',
                    error: 'No recording in progress'
                });
            }
            return;
        }
        
        const audioFile = currentRecording.audioFile;
        const recordingPid = currentRecording.pid;
        console.log(`🛑 Stopping SoX recording: PID ${recordingPid}, file: ${audioFile}`);
        
        // Stop the sox process by sending SIGTERM
        currentRecording.kill('SIGTERM');
        
        // Wait for process to exit and file to be finalized
        currentRecording.on('exit', (code, signal) => {
            console.log(`📝 SoX process exited with code: ${code}, signal: ${signal}`);
            
            // Give a moment for file system to sync
            setTimeout(() => {
                console.log(`📝 Checking for audio file: ${audioFile}`);
                
                if (fs.existsSync(audioFile)) {
                    const stats = fs.statSync(audioFile);
                    console.log(`✅ Audio file created: ${audioFile} (${stats.size} bytes)`);
                    
                    // Check minimum file size (more generous for SoX)
                    if (stats.size > 500) {
                        console.log(`🎤 Audio file ready for transcription: ${audioFile} (${stats.size} bytes)`);
                        // Send to MCP server for transcription
                        handleSpeechToText(audioFile, triggerId, true);
                    } else {
                        console.log('⚠️ Audio file too small, probably no speech detected');
                        if (getActiveWebview()) {
                            postToWebview({
                                command: 'speechTranscribed',
                                transcription: '',
                                error: '未检测到语音 - 请靠近麦克风并提高音量重试'
                            });
                        }
                        // Clean up small file
                        try {
                            fs.unlinkSync(audioFile);
                        } catch (e) {
                            console.log(`Could not clean up small file: ${e.message}`);
                        }
                    }
                } else {
                    console.log('❌ Audio file was not created');
                    if (getActiveWebview()) {
                        postToWebview({
                            command: 'speechTranscribed',
                            transcription: '',
                            error: '录音失败 - 未生成音频文件'
                        });
                    }
                }
                
                currentRecording = null;
            }, 1000); // Wait 1 second for file system sync
        });
        
        // Set a timeout in case the process doesn't exit gracefully
        setTimeout(() => {
            if (currentRecording && currentRecording.pid) {
                console.log(`⚠️ Force killing SoX process: ${currentRecording.pid}`);
                try {
                    currentRecording.kill('SIGKILL');
                } catch (e) {
                    console.log(`Could not force kill: ${e.message}`);
                }
                currentRecording = null;
            }
        }, 3000);
        
    } catch (error) {
        console.log(`❌ Failed to stop SoX recording: ${error.message}`);
        currentRecording = null;
        if (getActiveWebview()) {
            postToWebview({
                command: 'speechTranscribed',
                transcription: '',
                error: `停止录音失败: ${error.message}`
            });
        }
    }
}

function deactivate() {
    // Silent deactivation
    
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