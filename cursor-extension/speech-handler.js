const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getTempPath } = require('./utils');

let _postToWebview = null;
let _outputChannel = null;
let currentRecording = null;

function init(postToWebviewFn, outputChannel) {
    _postToWebview = postToWebviewFn;
    _outputChannel = outputChannel;
}

function postToWebview(msg) {
    if (_postToWebview) _postToWebview(msg);
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


module.exports = { init, handleSpeechToText, validateSoxSetup, startNodeRecording, stopNodeRecording };
