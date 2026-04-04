// Auto-extracted from extension.js - Webview HTML/CSS/JS template
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
            padding: 10px 16px;
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            align-items: center;
            gap: 10px;
            background: var(--vscode-editor-background);
        }
        
        .review-title {
            font-size: 15px;
            font-weight: 600;
            color: var(--vscode-foreground);
            letter-spacing: 0.3px;
        }
        
        .review-author {
            font-size: 11px;
            opacity: 0.45;
        }
        
        .status-capsule {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 3px 10px 3px 8px;
            border-radius: 12px;
            background: rgba(59, 130, 246, 0.1);
            border: 1px solid rgba(59, 130, 246, 0.2);
            margin-left: auto;
            transition: all 0.3s ease;
        }
        
        .status-capsule.active {
            background: rgba(76, 175, 80, 0.1);
            border-color: rgba(76, 175, 80, 0.25);
        }
        
        .status-capsule.inactive {
            background: rgba(128, 128, 128, 0.08);
            border-color: rgba(128, 128, 128, 0.15);
        }
        
        .status-indicator {
            width: 7px;
            height: 7px;
            border-radius: 50%;
            background: rgba(59, 130, 246, 0.8);
            animation: pulse 2s infinite;
            transition: background-color 0.3s ease;
        }
        
        .status-indicator.active {
            background: var(--vscode-charts-green);
        }
        
        .status-indicator.inactive {
            background: rgba(128, 128, 128, 0.5);
            animation: none;
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
            flex-direction: column;
            gap: 4px;
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
            align-items: flex-end;
        }
        
        .message-bubble {
            max-width: 70%;
            padding: 12px 16px;
            border-radius: 18px;
            word-wrap: break-word;
            white-space: pre-wrap;
        }
        
        .message.system .message-bubble {
            background: var(--vscode-editorWidget-background, var(--vscode-badge-background));
            color: var(--vscode-editorWidget-foreground, var(--vscode-badge-foreground));
            border: 1px solid var(--vscode-editorWidget-border, rgba(255,255,255,0.1));
            border-bottom-left-radius: 6px;
            font-size: 12px;
            padding: 8px 12px;
        }
        
        .message.user .message-bubble {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border-bottom-right-radius: 6px;
        }
        
        .message.system.plain {
            align-items: center;
            margin: 8px 0;
        }
        
        .message.system.plain .message-content {
            background: none;
            padding: 4px 12px;
            border-radius: 0;
            font-size: 11px;
            opacity: 0.6;
            font-style: normal;
            text-align: center;
            border: none;
            color: var(--vscode-foreground);
        }
        
        .message-time {
            font-size: 11px;
            opacity: 0.5;
            order: -1;
            text-align: center;
            align-self: center;
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
        
        .input-wrapper:focus-within {
            border-color: transparent;
            box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.5), 0 0 8px rgba(59, 130, 246, 0.25);
        }
        
        .input-wrapper.agent-active:focus-within {
            box-shadow: 0 0 0 2px rgba(76, 175, 80, 0.5), 0 0 8px rgba(76, 175, 80, 0.25);
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
            padding-left: 4px;
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
            transition: all 0.15s ease;
            padding: 0;
            flex-shrink: 0;
        }
        
        .send-button svg {
            width: 16px;
            height: 16px;
            stroke: currentColor;
            stroke-width: 2;
            fill: none;
        }
        
        .send-button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        
        .send-button:disabled {
            opacity: 0.35;
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
            opacity: 0.85;
            white-space: nowrap;
        }
        
        /* Drag and drop styling */
        body.drag-over {
            background: rgba(0, 123, 255, 0.05);
        }
        
        body.drag-over::before {
            content: '松开以附加文件';
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
        
        .queue-container {
            flex-shrink: 0;
            max-height: 140px;
            overflow-y: auto;
            padding: 8px 20px;
            border-top: 1px solid var(--vscode-panel-border);
            background: var(--vscode-editor-background);
        }
        
        .queue-container.empty { display: none; }
        
        
        
        .queue-header {
            font-size: 11px;
            font-weight: 600;
            opacity: 0.6;
            margin-bottom: 6px;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        
        .queue-badge {
            background: rgba(255, 165, 0, 0.2);
            color: #ffa500;
            padding: 1px 6px;
            border-radius: 8px;
            font-size: 10px;
            font-weight: 700;
        }
        
        .queue-item {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 4px 8px;
            border-radius: 6px;
            font-size: 12px;
            margin: 2px 0;
            background: rgba(255, 255, 255, 0.03);
            animation: messageSlide 0.2s ease-out;
            transition: transform 0.15s ease, opacity 0.15s ease, background 0.15s ease;
        }
        
        .queue-item:hover { background: rgba(255, 255, 255, 0.06); }
        
        .queue-item-arrows {
            display: flex;
            flex-direction: column;
            gap: 1px;
            margin-right: 4px;
        }
        
        .queue-arrow {
            background: none;
            border: none;
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
            font-size: 8px;
            line-height: 1;
            padding: 1px 2px;
            opacity: 0.5;
            transition: opacity 0.15s;
        }
        
        .queue-arrow:hover:not(:disabled) { opacity: 1; }
        .queue-arrow:disabled { opacity: 0.15; cursor: default; }
        
        .queue-item-num {
            width: 18px;
            height: 18px;
            line-height: 18px;
            text-align: center;
            border-radius: 50%;
            background: rgba(255, 165, 0, 0.15);
            color: #ffa500;
            font-size: 10px;
            font-weight: 700;
            flex-shrink: 0;
        }
        
        .queue-item-text {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            opacity: 0.8;
            cursor: text;
            border-radius: 3px;
            padding: 1px 4px;
            margin: -1px -4px;
            transition: background 0.15s;
        }
        
        .queue-item-text:hover { background: rgba(255, 255, 255, 0.05); }
        
        .queue-item-text-edit {
            flex: 1;
            background: var(--vscode-input-background);
            border: 1px solid rgba(255, 165, 0, 0.4);
            border-radius: 3px;
            color: var(--vscode-input-foreground);
            font-size: inherit;
            font-family: inherit;
            padding: 1px 4px;
            margin: -1px -4px;
            outline: none;
        }
        
        .queue-item-actions {
            display: flex;
            gap: 2px;
            flex-shrink: 0;
            align-items: center;
        }
        
        .queue-item-remove {
            background: none;
            border: none;
            color: var(--vscode-foreground);
            opacity: 0.3;
            cursor: pointer;
            font-size: 10px;
            padding: 2px 4px;
            border-radius: 4px;
            transition: all 0.2s;
        }
        
        .queue-item-remove:hover { opacity: 0.8; background: rgba(255, 59, 48, 0.15); color: #ff3b30; }
    </style>
</head>
<body>
    <div class="review-container">
        <div class="review-header">
            <div class="review-title">${title}</div>
            <div class="review-author">by keunsy</div>
            <div class="status-capsule inactive" id="statusCapsule">
                <div class="status-indicator inactive" id="statusIndicator"></div>
                <div class="mcp-status" id="mcpStatus">MCP 未激活</div>
            </div>
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
        
        <div class="queue-container empty" id="queueContainer">
            <div class="queue-header">
                <span>📋 待处理队列</span>
                <span class="queue-badge" id="queueBadge">0</span>
            </div>
            <div id="queueList"></div>
        </div>
        
        <div class="input-container disabled" id="inputContainer">
            <div class="input-wrapper" id="inputWrapper">
                <textarea id="messageInput" class="message-input" placeholder="等待 MCP 连接…" rows="1" disabled></textarea>
                <button id="attachButton" class="attach-button" title="Upload image" disabled>
                    <i class="fas fa-image"></i>
                </button>
            </div>
            <button id="sendButton" class="send-button" title="${mcpIntegration ? '发送回复给 Agent' : '发送审查'}" disabled>
                <svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
            </button>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        
        const messagesContainer = document.getElementById('messages');
        const messageInput = document.getElementById('messageInput');
        const sendButton = document.getElementById('sendButton');
        const attachButton = document.getElementById('attachButton');
        const typingIndicator = document.getElementById('typingIndicator');
        const statusIndicator = document.getElementById('statusIndicator');
        const statusCapsule = document.getElementById('statusCapsule');
        const mcpStatus = document.getElementById('mcpStatus');
        const inputContainer = document.getElementById('inputContainer');
        const inputWrapper = document.getElementById('inputWrapper');
        const queueContainer = document.getElementById('queueContainer');
        const queueList = document.getElementById('queueList');
        const queueBadge = document.getElementById('queueBadge');
        
        let messageCount = 0;
        let mcpActive = false;
        let mcpIntegration = ${mcpIntegration};
        let attachedImages = []; // Store uploaded images
        
        function updateMcpStatus(active, hasPendingTrigger) {
            mcpActive = active;
            
            if (active && hasPendingTrigger) {
                statusIndicator.className = 'status-indicator active';
                statusCapsule.className = 'status-capsule active';
                mcpStatus.textContent = 'Agent 等待回复';
                inputContainer.classList.remove('disabled');
                inputWrapper.classList.add('agent-active');
                messageInput.disabled = false;
                sendButton.disabled = false;
                attachButton.disabled = false;
                messageInput.placeholder = 'Cursor Agent 正在等待你的回复…';
            } else if (active) {
                statusIndicator.className = 'status-indicator';
                statusCapsule.className = 'status-capsule';
                mcpStatus.textContent = '等待 Agent 调用';
                inputContainer.classList.remove('disabled');
                inputWrapper.classList.remove('agent-active');
                messageInput.disabled = false;
                sendButton.disabled = false;
                attachButton.disabled = false;
                messageInput.placeholder = '输入消息将自动加入队列…';
            } else {
                statusIndicator.className = 'status-indicator inactive';
                statusCapsule.className = 'status-capsule inactive';
                mcpStatus.textContent = 'MCP 未激活';
                inputContainer.classList.add('disabled');
                inputWrapper.classList.remove('agent-active');
                messageInput.disabled = true;
                sendButton.disabled = true;
                attachButton.disabled = true;
                messageInput.placeholder = '等待 MCP 连接…';
            }
        }
        
        function addMessage(text, type = 'user', toolData = null, plain = false, _unused = false, attachments = [], files = []) {
            messageCount++;
            const messageDiv = document.createElement('div');
            messageDiv.className = \`message \${type}\${plain ? ' plain' : ''}\`;
            
            const contentDiv = document.createElement('div');
            contentDiv.className = plain ? 'message-content' : 'message-bubble';
            contentDiv.textContent = text;
            
            messageDiv.appendChild(contentDiv);
            
            if (attachments && attachments.length > 0) {
                const gallery = document.createElement('div');
                gallery.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;padding:0 4px;';
                attachments.forEach(img => {
                    const src = img.base64Data || img.dataUrl || img.data || '';
                    if (!src) return;
                    const thumb = document.createElement('img');
                    thumb.src = src;
                    thumb.style.cssText = 'max-width:120px;max-height:80px;border-radius:6px;cursor:pointer;object-fit:cover;border:1px solid var(--vscode-panel-border);';
                    thumb.title = img.fileName || '图片';
                    thumb.onclick = () => { window.open(src); };
                    gallery.appendChild(thumb);
                });
                messageDiv.appendChild(gallery);
            }
            
            if (files && files.length > 0) {
                const fileList = document.createElement('div');
                fileList.style.cssText = 'margin-top:4px;padding:0 4px;font-size:12px;opacity:0.8;';
                files.forEach(f => {
                    const name = f.name || f.fileName || '';
                    const fPath = f.path || f.filePath || '';
                    const display = name || fPath.split('/').pop() || fPath.split('\\\\').pop() || '文件';
                    const row = document.createElement('div');
                    row.style.cssText = 'padding:2px 0;';
                    row.textContent = '📎 ' + display + (fPath && name ? ' (' + fPath + ')' : '');
                    fileList.appendChild(row);
                });
                messageDiv.appendChild(fileList);
            }
            
            if (!plain) {
                const timeDiv = document.createElement('div');
                timeDiv.className = 'message-time';
                timeDiv.textContent = new Date().toLocaleTimeString();
                messageDiv.appendChild(timeDiv);
            }
            
            messagesContainer.appendChild(messageDiv);
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
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
        
        let _sendLock = false;
        function sendMessage() {
            const text = messageInput.value.trim();
            if (!text && attachedImages.length === 0 && attachedFiles.length === 0) return;
            if (_sendLock) return;
            _sendLock = true;
            setTimeout(() => { _sendLock = false; }, 300);
            
            const sentImages = [...attachedImages];
            const sentFiles = [...attachedFiles];
            
            vscode.postMessage({
                command: 'send',
                text: text,
                attachments: sentImages,
                files: sentFiles,
                timestamp: new Date().toISOString(),
                mcpIntegration: mcpIntegration
            });
            
            addMessage(text || (sentImages.length > 0 ? '图片' : '文件'), 'user', null, false, false, sentImages, sentFiles);
            
            messageInput.value = '';
            attachedImages = [];
            attachedFiles = [];
            document.querySelectorAll('[data-file-id]').forEach(el => el.remove());
            document.querySelectorAll('[data-image-id]').forEach(el => el.remove());
            adjustTextareaHeight();
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
        let attachedFiles = [];
        
        function handleDragEnter(e) {
            e.preventDefault();
            dragCounter++;
            document.body.classList.add('drag-over');
            messageInput.classList.add('paste-highlight');
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
            e.dataTransfer.dropEffect = 'copy';
        }
        
        function handleDrop(e) {
            e.preventDefault();
            dragCounter = 0;
            document.body.classList.remove('drag-over');
            messageInput.classList.remove('paste-highlight');
            
            const uriList = e.dataTransfer.getData('text/uri-list');
            const plainText = e.dataTransfer.getData('text/plain');
            
            if (uriList) {
                const uris = uriList.split('\\n').filter(u => u.trim() && !u.startsWith('#'));
                uris.forEach(uri => {
                    let filePath = uri.trim();
                    if (filePath.startsWith('file://')) {
                        filePath = decodeURIComponent(filePath.replace('file://', ''));
                    }
                    if (filePath) {
                        vscode.postMessage({
                            command: 'dropFile',
                            filePath: filePath
                        });
                    }
                });
                return;
            }
            
            if (plainText && (plainText.startsWith('/') || plainText.startsWith('file://'))) {
                let filePath = plainText.trim();
                if (filePath.startsWith('file://')) {
                    filePath = decodeURIComponent(filePath.replace('file://', ''));
                }
                vscode.postMessage({
                    command: 'dropFile',
                    filePath: filePath
                });
                return;
            }
            
            // Fallback: handle native file drops (images etc.)
            const files = e.dataTransfer.files;
            if (files && files.length > 0) {
                setTimeout(() => {
                    for (let i = 0; i < files.length; i++) {
                        const file = files[i];
                        if (file.type.startsWith('image/')) {
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
        
        function addFileAttachment(fileData) {
            const fileId = 'file_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            fileData.id = fileId;
            attachedFiles.push(fileData);
            
            const filePreview = document.createElement('div');
            filePreview.className = 'message system';
            filePreview.setAttribute('data-file-id', fileId);
            filePreview.innerHTML = \`
                <div class="message-bubble" style="max-width: 90%;">
                    <div class="image-header">
                        <span class="image-filename" style="font-family: monospace;"><i class="fas fa-file-code" style="margin-right: 4px; color: var(--vscode-charts-orange);"></i>\${fileData.fileName}</span>
                        <button class="remove-image-btn" onclick="removeFile('\${fileId}')" title="Remove file">
                            <i class="fas fa-times"></i>
                        </button>
                    </div>
                    <div style="margin-top: 4px; font-size: 11px; opacity: 0.6;">\${fileData.filePath}</div>
                </div>
            \`;
            messagesContainer.appendChild(filePreview);
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }
        
        function removeFile(fileId) {
            attachedFiles = attachedFiles.filter(f => f.id !== fileId);
            const preview = document.querySelector(\`[data-file-id="\${fileId}"]\`);
            if (preview) preview.remove();
        }
        
        window.removeFile = removeFile;
        
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
        
        // Event listeners
        messageInput.addEventListener('input', () => {
            adjustTextareaHeight();
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
        
        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            
            switch (message.command) {
                case 'addMessage':
                    addMessage(message.text, message.type || 'system', message.toolData, message.plain || false, false, message.attachments, message.files);
                    break;
                case 'newMessage':
                    addMessage(message.text, message.type || 'system', message.toolData, message.plain || false, false, message.attachments, message.files);
                    if (message.mcpIntegration) {
                        mcpIntegration = true;
                        messageInput.placeholder = 'Cursor Agent 正在等待你的回复…';
                    }
                    break;
                case 'focus':
                    messageInput.focus();
                    break;
                case 'updateMcpStatus':
                    updateMcpStatus(message.active, message.hasPendingTrigger);
                    break;
                case 'imageUploaded':
                    handleImageUploaded(message.imageData);
                    break;
                case 'fileAttached':
                    addFileAttachment(message.fileData);
                    break;
                case 'syncQueue':
                    renderQueue(message.items, message.pendingCount);
                    break;
            }
        });
        
        function renderQueue(items, pendingCount) {
            if (!items || items.length === 0) {
                queueContainer.classList.add('empty');
                queueList.innerHTML = '';
                queueBadge.textContent = '0';
                return;
            }
            queueContainer.classList.remove('empty');
            queueBadge.textContent = pendingCount;
            
            const pendingItems = items.filter(it => it.status === 'pending');
            queueList.innerHTML = items.map((item, i) => {
                const isPending = item.status === 'pending';
                const pi = isPending ? pendingItems.findIndex(p => p.id === item.id) : -1;
                const imgCount = (item.attachments || []).length;
                const fileCount = (item.files || []).length;
                const badges = [
                    item.sourceLabel ? \`<span style="font-size:10px;opacity:0.6;margin-right:3px;">📨\${item.sourceLabel}</span>\` : '',
                    imgCount ? \`<span style="font-size:10px;opacity:0.6;margin-right:3px;" title="\${imgCount}张图片">🖼️\${imgCount > 1 ? imgCount : ''}</span>\` : '',
                    fileCount ? \`<span style="font-size:10px;opacity:0.6;margin-right:3px;" title="\${(item.files||[]).map(f=>f.name||f.path||'文件').join(', ')}">📎\${fileCount > 1 ? fileCount : ''}</span>\` : '',
                ].filter(Boolean).join('');
                return \`
                <div class="queue-item" data-queue-id="\${item.id}">
                    \${isPending && pendingItems.length > 1 ? \`
                        <span class="queue-item-arrows">
                            <button class="queue-arrow" \${pi === 0 ? 'disabled' : ''} onclick="moveQueueItemUp(\${item.id})" title="上移">▲</button>
                            <button class="queue-arrow" \${pi === pendingItems.length - 1 ? 'disabled' : ''} onclick="moveQueueItemDown(\${item.id})" title="下移">▼</button>
                        </span>
                    \` : ''}
                    <span class="queue-item-num">\${i + 1}</span>
                    <span class="queue-item-text" \${isPending ? \`onclick="startEditQueueItem(this, \${item.id})" title="点击编辑"\` : ''}>\${badges}\${item.text || (imgCount ? '图片' : '文件')}</span>
                    \${isPending ? \`
                        <span class="queue-item-actions">
                            <button class="queue-item-remove" onclick="removeQueueItem(\${item.id})" title="移除">✕</button>
                        </span>
                    \` : \`<span style="font-size:10px;opacity:0.5;">⏳</span>\`}
                </div>
            \`}).join('');
            
        }
        
        function removeQueueItem(itemId) {
            vscode.postMessage({ command: 'removeQueueItem', itemId: itemId });
        }
        
        function moveQueueItemUp(itemId) {
            vscode.postMessage({ command: 'moveQueueItem', itemId: itemId, direction: 'up' });
        }
        
        function moveQueueItemDown(itemId) {
            vscode.postMessage({ command: 'moveQueueItem', itemId: itemId, direction: 'down' });
        }
        
        function startEditQueueItem(span, itemId) {
            if (span.tagName === 'INPUT') return;
            const currentText = span.textContent;
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'queue-item-text-edit';
            input.value = currentText;
            span.replaceWith(input);
            input.focus();
            input.select();
            
            function commitEdit() {
                const newText = input.value.trim();
                if (newText && newText !== currentText) {
                    vscode.postMessage({ command: 'editQueueItem', itemId: itemId, newText: newText });
                } else {
                    const newSpan = document.createElement('span');
                    newSpan.className = 'queue-item-text';
                    newSpan.textContent = currentText;
                    newSpan.onclick = () => startEditQueueItem(newSpan, itemId);
                    newSpan.title = '点击编辑';
                    input.replaceWith(newSpan);
                }
            }
            
            input.addEventListener('blur', commitEdit);
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
                if (e.key === 'Escape') { input.value = currentText; input.blur(); }
            });
        }
        
        window.startEditQueueItem = startEditQueueItem;
        window.removeQueueItem = removeQueueItem;
        window.moveQueueItemUp = moveQueueItemUp;
        window.moveQueueItemDown = moveQueueItemDown;
        
        // Make removeImage globally accessible for onclick handlers
        window.removeImage = removeImage;
        
        // Initialize
        vscode.postMessage({ command: 'ready' });
        
        // Focus input immediately
        setTimeout(() => {
            messageInput.focus();
        }, 100);
    </script>
</body>
</html>`;
}

module.exports = { getFeedbackGateHTML };
