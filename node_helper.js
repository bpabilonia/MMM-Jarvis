const NodeHelper = require("node_helper");
const fs = require("fs");
const path = require("path");
const { spawn, exec } = require("child_process");

// Lazy load dependencies to prevent crash on load if missing
let OpenAI = null;
let Porcupine = null;
let BuiltinKeyword = null;
let recorder = null;
let WebSocket = null;

module.exports = NodeHelper.create({
  start: function () {
    console.log("MMM-Jarvis: node_helper started!");
    this.porcupine = null;
    this.micStream = null;
    this.isListening = false;
    this.audioBuffer = [];
    this.conversationHistory = []; // Store conversation context
    this.pendingRecording = null; // Track active recording process
    
    // Realtime API state
    this.realtimeWs = null;
    this.realtimeConnected = false;
    this.realtimeAudioBuffer = [];
    this.realtimeStreamingMic = null;
    this.audioPlayer = null;
    this.audioChunks = [];
    this.responseInProgress = false; // Track if a response is actively being generated
    
    // Attempt to load dependencies
    try {
        OpenAI = require("openai");
        const PorcupineModule = require("@picovoice/porcupine-node");
        Porcupine = PorcupineModule.Porcupine;
        BuiltinKeyword = PorcupineModule.BuiltinKeyword;
        recorder = require("node-record-lpcm16");
        WebSocket = require("ws");
        console.log("MMM-Jarvis: Dependencies loaded successfully.");
    } catch (e) {
        console.error("MMM-Jarvis: Failed to load dependencies. Make sure to run 'npm install' in the module directory.", e);
    }
  },

  socketNotificationReceived: function (notification, payload) {
    if (notification === "INIT") {
      console.log("MMM-Jarvis: Received INIT configuration");
      this.config = payload;
      this.initialize();
    }
  },

  initialize: function () {
    if (!OpenAI || !Porcupine || !recorder) {
        console.error("MMM-Jarvis: Cannot initialize, dependencies are missing.");
        return;
    }

    if (!this.config.openaiKey || !this.config.picovoiceKey) {
      console.error("MMM-Jarvis: Missing OpenAI or Picovoice API Key");
      return;
    }

    // Check WebSocket availability if realtime mode is requested
    if (this.config.useRealtimeAPI && !WebSocket) {
      console.error("MMM-Jarvis: Cannot use Realtime API, WebSocket dependency is missing. Run 'npm install' to install the 'ws' package.");
      return;
    }

    try {
        this.openai = new OpenAI({ apiKey: this.config.openaiKey });
        this.useRealtimeAPI = this.config.useRealtimeAPI || false;
        this.realtimeModel = this.config.realtimeModel || "gpt-4o-realtime-preview-2024-12-17";
        this.realtimeVoice = this.config.realtimeVoice || "ash";
        
        console.log(`MMM-Jarvis: Mode - ${this.useRealtimeAPI ? 'Realtime API' : 'Standard API'}`);
        
        this.initPorcupine();
        this.startWakeWordListener();
    } catch (e) {
        console.error("MMM-Jarvis: Initialization error", e);
    }
  },

  initPorcupine: function () {
    try {
      // Check if BuiltinKeyword is available, otherwise fallback or check structure
      let keywordPath = null;
      
      // Try standard v3 structure
      if (BuiltinKeyword && BuiltinKeyword.JARVIS) {
           keywordPath = BuiltinKeyword.JARVIS;
      } 
      // Fallback for some environments where it might be different
      else if (Porcupine.BUILTIN_KEYWORDS && Porcupine.BUILTIN_KEYWORDS.JARVIS) {
           keywordPath = Porcupine.BUILTIN_KEYWORDS.JARVIS;
      }

      if (!keywordPath) {
          console.log("MMM-Jarvis: BuiltinKeyword.JARVIS not found. Checking valid keywords:", Object.keys(BuiltinKeyword || {}));
          console.error("MMM-Jarvis: Error - Could not find 'Jarvis' keyword in Porcupine SDK.");
          return; 
      }

      this.porcupine = new Porcupine(
        this.config.picovoiceKey,
        [keywordPath],
        [0.5]
      );
      console.log("MMM-Jarvis: Porcupine initialized");
    } catch (e) {
      console.error("MMM-Jarvis: Porcupine Error", e);
    }
  },

  startWakeWordListener: function () {
    if (this.micStream) {
        this.micStream.stop();
    }

    console.log("MMM-Jarvis: Listening for wake word...");
    this.conversationHistory = []; // Reset history on new wake word session
    
    try {
        this.micStream = recorder.record({
          sampleRate: 16000,
          threshold: 0,
          verbose: true, 
          recordProgram: "rec", 
          silence: "1.0",
        });
    
        const stream = this.micStream.stream();
        
        stream.on("data", (chunk) => {
            if (!this.porcupine) return; 

            if (this.isListening) return; 

            let frameLength = this.porcupine.frameLength;
            
            // Accumulate buffer
            for (let i = 0; i < chunk.length; i += 2) {
                let val = chunk.readInt16LE(i);
                this.audioBuffer.push(val);
                
                if (this.audioBuffer.length >= frameLength) {
                    const frame = new Int16Array(this.audioBuffer.slice(0, frameLength));
                    this.processFrame(frame);
                    this.audioBuffer = this.audioBuffer.slice(frameLength);
                }
            }
        });
        
        stream.on("error", (err) => {
            console.error("MMM-Jarvis: Mic stream error", err);
        });
        
        if (this.micStream.process) {
             this.micStream.process.on('close', (code) => {
                 // console.log(`MMM-Jarvis: Audio recording process exited with code ${code}`);
             });
        }

    } catch (err) {
        console.error("MMM-Jarvis: Failed to start mic recording", err);
    }
  },

  processFrame: function (frame) {
    if (this.isListening) return;

    const index = this.porcupine.process(frame);
    if (index !== -1) {
      console.log("MMM-Jarvis: Wake word detected!");
      this.isListening = true;
      
      // Immediately notify UI - before stopping mic for faster feedback
      this.sendSocketNotification("STATUS_UPDATE", { status: "LISTENING" });
      
      // Play acknowledgment sound for immediate feedback (non-blocking)
      this.playAckSound();
      
      this.micStream.stop(); 
      
      // Use Realtime API or standard flow
      if (this.useRealtimeAPI) {
          this.startRealtimeSession();
      } else {
          this.recordCommand();
      }
    }
  },
  
  playAckSound: function() {
    // Quick audio feedback - a short beep/ding sound
    // Uses system command for speed (afplay on macOS, aplay on Linux)
    const ackSoundPath = path.join(__dirname, "ack.wav");
    
    // Check if custom sound exists, otherwise use system beep
    if (fs.existsSync(ackSoundPath)) {
      const cmd = process.platform === "darwin" ? "afplay" : "aplay";
      spawn(cmd, [ackSoundPath], { detached: true, stdio: 'ignore' }).unref();
    } else {
      // Fallback: generate a quick beep using sox/play
      const beepCmd = spawn("play", ["-n", "synth", "0.1", "sine", "880"], { 
        detached: true, 
        stdio: 'ignore' 
      });
      beepCmd.unref();
    }
  },

  // ============================================
  // REALTIME API IMPLEMENTATION
  // ============================================
  
  startRealtimeSession: function() {
    console.log("MMM-Jarvis: Starting Realtime API session...");
    
    const url = `wss://api.openai.com/v1/realtime?model=${this.realtimeModel}`;
    
    this.realtimeWs = new WebSocket(url, {
      headers: {
        "Authorization": `Bearer ${this.config.openaiKey}`,
        "OpenAI-Beta": "realtime=v1"
      }
    });
    
    this.realtimeWs.on("open", () => {
      console.log("MMM-Jarvis: Realtime WebSocket connected");
      this.realtimeConnected = true;
      
      // Configure the session
      this.sendRealtimeEvent({
        type: "session.update",
        session: {
          modalities: ["text", "audio"],
          instructions: "You are Jarvis, a helpful AI assistant on a Magic Mirror. Keep responses brief (1-3 sentences) and natural for spoken output. Avoid lists, markdown, or special formatting. Be conversational and friendly.",
          voice: this.realtimeVoice,
          input_audio_format: "pcm16",
          output_audio_format: "pcm16",
          input_audio_transcription: {
            model: "whisper-1"
          },
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500
          }
        }
      });
      
      // Start streaming microphone audio
      this.startRealtimeAudioStream();
    });
    
    this.realtimeWs.on("message", (data) => {
      try {
        const event = JSON.parse(data.toString());
        this.handleRealtimeEvent(event);
      } catch (e) {
        console.error("MMM-Jarvis: Failed to parse Realtime event", e);
      }
    });
    
    this.realtimeWs.on("error", (err) => {
      // Only log the error here - cleanup will happen in the close handler
      // which always fires after an error event
      console.error("MMM-Jarvis: Realtime WebSocket error", err);
    });
    
    this.realtimeWs.on("close", (code, reason) => {
      console.log(`MMM-Jarvis: Realtime WebSocket closed. Code: ${code}, Reason: ${reason}`);
      // Only perform cleanup if this wasn't triggered by our own cleanupRealtimeSession() call
      // When we initiate cleanup, realtimeWs is set to null before the close event fires
      if (this.realtimeWs !== null) {
        this.realtimeConnected = false;
        // Perform full cleanup for unexpected closes (server disconnect, timeout, etc.)
        this.cleanupRealtimeSession();
        this.reset();
      }
    });
  },
  
  sendRealtimeEvent: function(event) {
    if (this.realtimeWs && this.realtimeConnected) {
      this.realtimeWs.send(JSON.stringify(event));
    }
  },
  
  startRealtimeAudioStream: function() {
    console.log("MMM-Jarvis: Starting audio stream to Realtime API...");
    
    try {
      this.realtimeStreamingMic = recorder.record({
        sampleRate: 24000, // Realtime API uses 24kHz
        threshold: 0,
        verbose: false,
        recordProgram: "rec",
        silence: "0",
        channels: 1,
        audioType: "raw"
      });
      
      const stream = this.realtimeStreamingMic.stream();
      
      stream.on("data", (chunk) => {
        if (this.realtimeConnected) {
          // Send audio as base64
          const base64Audio = chunk.toString("base64");
          this.sendRealtimeEvent({
            type: "input_audio_buffer.append",
            audio: base64Audio
          });
        }
      });
      
      stream.on("error", (err) => {
        console.error("MMM-Jarvis: Realtime mic stream error", err);
        this.cleanupRealtimeSession();
        this.reset();
      });
      
    } catch (err) {
      console.error("MMM-Jarvis: Failed to start Realtime audio stream", err);
      this.cleanupRealtimeSession();
      this.reset();
    }
  },
  
  handleRealtimeEvent: function(event) {
    const eventType = event.type;
    
    switch (eventType) {
      case "session.created":
        console.log("MMM-Jarvis: Realtime session created");
        break;
        
      case "session.updated":
        console.log("MMM-Jarvis: Realtime session updated");
        break;
        
      case "input_audio_buffer.speech_started":
        console.log("MMM-Jarvis: Speech detected");
        this.sendSocketNotification("STATUS_UPDATE", { status: "LISTENING" });
        // Interrupt any ongoing audio playback
        this.stopAudioPlayback();
        break;
        
      case "input_audio_buffer.speech_stopped":
        console.log("MMM-Jarvis: Speech ended");
        this.sendSocketNotification("STATUS_UPDATE", { status: "PROCESSING" });
        break;
        
      case "conversation.item.input_audio_transcription.completed":
        const transcription = event.transcript || "";
        console.log(`MMM-Jarvis: Transcription: ${transcription}`);
        if (transcription.trim()) {
          this.sendSocketNotification("TRANSCRIPTION", { text: transcription });
          
          // Check for exit phrases
          const lowerText = transcription.toLowerCase().trim();
          if (lowerText.includes("stop conversation") || 
              lowerText.includes("thank you jarvis") ||
              lowerText.includes("goodbye jarvis") ||
              lowerText.includes("that's all")) {
            this.cleanupRealtimeSession();
            this.reset();
            return;
          }
        }
        break;
        
      case "response.created":
        console.log("MMM-Jarvis: Response started");
        this.responseInProgress = true;
        this.sendSocketNotification("RESPONSE_START");
        this.audioChunks = [];
        break;
        
      case "response.text.delta":
        const textDelta = event.delta || "";
        if (textDelta) {
          this.sendSocketNotification("RESPONSE_CHUNK", { text: textDelta });
        }
        break;
        
      case "response.audio_transcript.delta":
        const transcriptDelta = event.delta || "";
        if (transcriptDelta) {
          this.sendSocketNotification("RESPONSE_CHUNK", { text: transcriptDelta });
        }
        break;
        
      case "response.audio.delta":
        // Collect audio chunks
        if (event.delta) {
          const audioData = Buffer.from(event.delta, "base64");
          this.audioChunks.push(audioData);
          
          // Start playback if no player is active (first chunk or after player failure)
          if (!this.audioPlayer) {
            this.sendSocketNotification("STATUS_UPDATE", { status: "SPEAKING" });
            this.startAudioPlayback();
          }
        }
        break;
        
      case "response.audio.done":
        console.log("MMM-Jarvis: Audio response complete");
        break;
        
      case "response.done":
        console.log("MMM-Jarvis: Response complete");
        this.responseInProgress = false;
        // Audio playback will continue, then we'll be ready for next input
        break;
        
      case "error":
        console.error("MMM-Jarvis: Realtime API error:", event.error);
        this.sendSocketNotification("STATUS_UPDATE", { status: "ERROR" });
        // Clean up and reset on API errors, consistent with standard mode behavior
        this.cleanupRealtimeSession();
        this.reset();
        break;
        
      case "rate_limits.updated":
        // Rate limit info, can be logged if needed
        break;
        
      default:
        if (this.config.debug) {
          console.log(`MMM-Jarvis: Unhandled event type: ${eventType}`);
        }
    }
  },
  
  startAudioPlayback: function() {
    // Create a streaming audio player for PCM16 24kHz mono
    // Use sox to convert raw PCM to playable audio
    const playCmd = process.platform === "darwin" ? "play" : "aplay";
    const playArgs = process.platform === "darwin" 
      ? ["-t", "raw", "-r", "24000", "-e", "signed-integer", "-b", "16", "-c", "1", "-"]
      : ["-f", "S16_LE", "-r", "24000", "-c", "1", "-"];
    
    this.audioPlayer = spawn(playCmd, playArgs);
    
    this.audioPlayer.stdin.on("error", (err) => {
      if (err.code !== "EPIPE") {
        console.error("MMM-Jarvis: Audio player stdin error", err);
      }
    });
    
    this.audioPlayer.on("close", (code) => {
      console.log("MMM-Jarvis: Audio playback finished");
      this.audioPlayer = null;
      // Clear the flush interval so a new one can be created for the next response
      if (this.audioFlushInterval) {
        clearInterval(this.audioFlushInterval);
        this.audioFlushInterval = null;
      }
      // Ready for next utterance
      this.sendSocketNotification("STATUS_UPDATE", { status: "LISTENING" });
    });
    
    this.audioPlayer.on("error", (err) => {
      console.error("MMM-Jarvis: Audio player error", err);
      this.audioPlayer = null;
      // Clear the flush interval on error as well
      if (this.audioFlushInterval) {
        clearInterval(this.audioFlushInterval);
        this.audioFlushInterval = null;
      }
      // Clear pending audio chunks
      this.audioChunks = [];
      // Update status so user isn't stuck waiting
      this.sendSocketNotification("STATUS_UPDATE", { status: "LISTENING" });
    });
    
    // Start writing buffered audio
    this.flushAudioBuffer();
  },
  
  flushAudioBuffer: function() {
    if (!this.audioPlayer || !this.audioPlayer.stdin.writable) return;
    
    while (this.audioChunks.length > 0) {
      const chunk = this.audioChunks.shift();
      try {
        this.audioPlayer.stdin.write(chunk);
      } catch (e) {
        break;
      }
    }
    
    // Set up interval to flush new chunks as they arrive
    if (!this.audioFlushInterval) {
      this.audioFlushInterval = setInterval(() => {
        if (this.audioChunks.length > 0 && this.audioPlayer && this.audioPlayer.stdin.writable) {
          while (this.audioChunks.length > 0) {
            const chunk = this.audioChunks.shift();
            try {
              this.audioPlayer.stdin.write(chunk);
            } catch (e) {
              break;
            }
          }
        }
      }, 50);
    }
  },
  
  stopAudioPlayback: function() {
    if (this.audioFlushInterval) {
      clearInterval(this.audioFlushInterval);
      this.audioFlushInterval = null;
    }
    
    if (this.audioPlayer) {
      try {
        this.audioPlayer.stdin.end();
        this.audioPlayer.kill();
      } catch (e) {
        // Ignore errors when stopping
      }
      this.audioPlayer = null;
    }
    
    this.audioChunks = [];
    
    // Cancel any in-progress response (only if one is actually active)
    if (this.realtimeConnected && this.responseInProgress) {
      this.sendRealtimeEvent({ type: "response.cancel" });
      this.responseInProgress = false;
    }
  },
  
  cleanupRealtimeSession: function() {
    console.log("MMM-Jarvis: Cleaning up Realtime session...");
    
    // Stop audio streaming
    if (this.realtimeStreamingMic) {
      try {
        this.realtimeStreamingMic.stop();
      } catch (e) {}
      this.realtimeStreamingMic = null;
    }
    
    // Stop audio playback
    this.stopAudioPlayback();
    
    // Close WebSocket
    if (this.realtimeWs) {
      try {
        this.realtimeWs.close();
      } catch (e) {}
      this.realtimeWs = null;
    }
    
    this.realtimeConnected = false;
    this.responseInProgress = false;
    
    if (this.audioFlushInterval) {
      clearInterval(this.audioFlushInterval);
      this.audioFlushInterval = null;
    }
  },

  // ============================================
  // STANDARD API IMPLEMENTATION (Original)
  // ============================================

  recordCommand: function () {
    console.log("MMM-Jarvis: Recording command...");
    const filePath = path.join(__dirname, "command.wav");
    
    // Optimized silence detection:
    // - Start recording immediately (no initial silence wait)
    // - Shorter end silence threshold: 0.8s instead of 1.5s
    // - Lower noise floor: 2% for more responsive cutoff
    const args = [
        "-r", "16000",
        "-c", "1", 
        "-b", "16",
        filePath,
        "silence", "1", "0.05", "2%",  // Start: 0.05s of sound above 2% to trigger
        "1", "0.8", "2%"                // End: 0.8s of silence below 2% to stop
    ];
    
    let recordCmd = "rec";
    const recording = spawn(recordCmd, args);
    this.pendingRecording = recording;
    
    const startTime = Date.now();
    
    recording.on("close", (code) => {
        const duration = Date.now() - startTime;
        console.log(`MMM-Jarvis: Recording finished in ${duration}ms. Code: ${code}`);
        this.pendingRecording = null;
        this.sendSocketNotification("STATUS_UPDATE", { status: "PROCESSING" });
        this.processAudio(filePath);
    });
    
    recording.on("error", (err) => {
        console.error("MMM-Jarvis: Recording error", err);
        this.pendingRecording = null;
        this.reset();
    });

    // Safety timeout - reduced from 7s to 5s for faster failover
    setTimeout(() => {
        // Only kill if this is still the same recording (not a new one)
        if (this.pendingRecording === recording) {
            console.log("MMM-Jarvis: Recording timeout reached");
            recording.kill();
        }
    }, 5000); 
  },

  processAudio: async function (filePath) {
    const processStart = Date.now();
    
    try {
      // 1. Whisper STT - use smaller response format for speed
      console.log("MMM-Jarvis: Transcribing...");
      const transcription = await this.openai.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model: "whisper-1",
        response_format: "text", // Faster than JSON
      });

      // response_format: "text" returns plain string
      const text = typeof transcription === 'string' ? transcription : transcription.text;
      const sttTime = Date.now() - processStart;
      console.log(`MMM-Jarvis: Transcription (${sttTime}ms):`, text);
      this.sendSocketNotification("TRANSCRIPTION", { text });

      // If silence or empty, end conversation
      if (!text || text.trim().length === 0) {
          console.log("MMM-Jarvis: No speech detected, ending conversation.");
          this.reset();
          return;
      }
      
      const lowerText = text.toLowerCase().trim();
      
      // Filter out noise/very short transcriptions that are likely mic artifacts
      // Common false positives: "You", "Hmm", "Uh", single words from ambient noise
      const noisePatterns = ["you", "you.", "hmm", "uh", "um", "ah", "oh", "the", "a", "i"];
      if (text.trim().length < 4 || noisePatterns.includes(lowerText)) {
          console.log(`MMM-Jarvis: Filtering noise transcription: "${text}"`);
          // Continue listening instead of resetting
          this.continueConversation();
          return;
      }
      
      // Check for exit phrases
      if (lowerText.includes("stop conversation") || 
          lowerText.includes("thank you jarvis") ||
          lowerText.includes("goodbye jarvis") ||
          lowerText.includes("that's all")) {
           this.reset();
           return;
      }

      // 2. GPT-4o-mini Streaming with Context
      const gptStart = Date.now();
      console.log("MMM-Jarvis: Getting response from GPT-4o-mini...");
      
      // Add user message to history
      this.conversationHistory.push({ role: "user", content: text });
      
      // Prepare messages payload with optimized system prompt
      const messages = [
          { 
            role: "system", 
            content: "You are Jarvis, a helpful AI assistant on a Magic Mirror. Keep responses brief (1-3 sentences) and natural for spoken output. Avoid lists, markdown, or special formatting."
          },
          ...this.conversationHistory
      ];

      const stream = await this.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: messages,
        stream: true,
        max_tokens: 150, // Limit for faster responses
      });

      // Don't send SPEAKING status yet - wait until TTS actually starts playing
      this.sendSocketNotification("RESPONSE_START");
      let fullResponse = "";
      let firstChunkTime = null;
      let sentenceBuffer = "";

      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || "";
        if (content) {
            if (!firstChunkTime) {
                firstChunkTime = Date.now() - gptStart;
                console.log(`MMM-Jarvis: First GPT chunk in ${firstChunkTime}ms`);
            }
            fullResponse += content;
            sentenceBuffer += content;
            this.sendSocketNotification("RESPONSE_CHUNK", { text: content });
        }
      }

      const totalGptTime = Date.now() - gptStart;
      console.log(`MMM-Jarvis: Full response (${totalGptTime}ms):`, fullResponse);
      
      // Add assistant response to history
      this.conversationHistory.push({ role: "assistant", content: fullResponse });
      
      // Limit history to last 10 turns to prevent token overflow
      if (this.conversationHistory.length > 20) {
          this.conversationHistory = this.conversationHistory.slice(-20);
      }
      
      // 3. TTS - Start immediately after GPT completes
      this.streamTTS(fullResponse);

    } catch (e) {
      console.error("MMM-Jarvis: API Error", e);
      this.sendSocketNotification("STATUS_UPDATE", { status: "ERROR" });
      this.reset();
    }
  },

  streamTTS: async function (text) {
    const ttsStart = Date.now();
    
    try {
        console.log("MMM-Jarvis: Generating speech...");
        
        // Use tts-1 (fastest) with speed boost for more natural conversation pace
        const mp3 = await this.openai.audio.speech.create({
            model: "tts-1", // tts-1 is faster than tts-1-hd
            voice: "onyx",
            input: text,
            speed: 1.1, // Slightly faster for more natural conversation
        });
        
        const genTime = Date.now() - ttsStart;
        console.log(`MMM-Jarvis: TTS generated in ${genTime}ms, starting playback...`);
        
        // Start player immediately - mpg123 is efficient for streaming
        let command = "mpg123";
        let args = ["-q", "-"]; // -q for quiet (no status), - for stdin
        
        // On macOS, afplay doesn't support stdin, so stick with mpg123
        const player = spawn(command, args);

        const bufferStream = mp3.body;
        
        // Send SPEAKING status now that we're about to play audio
        this.sendSocketNotification("STATUS_UPDATE", { status: "SPEAKING" });
        console.log(`MMM-Jarvis: Audio playback starting (${Date.now() - ttsStart}ms from TTS start)`);
        
        // Stream audio data to player
        if (bufferStream.pipe) {
            bufferStream.pipe(player.stdin);
        } else {
            for await (const chunk of bufferStream) {
                player.stdin.write(Buffer.from(chunk));
            }
            player.stdin.end();
        }
        
        player.on("close", (code) => {
            const totalTime = Date.now() - ttsStart;
            console.log(`MMM-Jarvis: Playback complete (${totalTime}ms total TTS time)`);
            // Continue conversation loop instead of resetting
            this.continueConversation();
        });
        
        player.on("error", (err) => {
            console.error("MMM-Jarvis: Audio player error", err);
            this.reset();
        });
        
        player.stdin.on("error", (err) => {
            // Ignore EPIPE errors - player may close before we finish writing
            if (err.code !== 'EPIPE') {
                console.error("MMM-Jarvis: Player stdin error", err);
            }
        });

    } catch (e) {
        console.error("MMM-Jarvis: TTS Error", e);
        this.reset();
    }
  },
  
  continueConversation: function() {
      // Start recording again for the next turn without waiting for wake word
      console.log("MMM-Jarvis: Continuing conversation...");
      this.sendSocketNotification("STATUS_UPDATE", { status: "LISTENING" });
      
      // No beep here - it gets picked up by the mic and causes feedback loops
      // User already knows they're in a conversation
      
      // Delay to ensure TTS audio is fully stopped before mic opens
      setTimeout(() => {
          this.recordCommand();
      }, 250);
  },

  reset: function () {
    // Cleanup Realtime session if active
    if (this.useRealtimeAPI) {
      this.cleanupRealtimeSession();
    }
    
    this.isListening = false;
    this.conversationHistory = []; // Clear history on full reset
    this.sendSocketNotification("RESPONSE_END"); // Signal UI to go IDLE and clear text
    this.startWakeWordListener(); // Resume wake word listening
    this.sendSocketNotification("STATUS_UPDATE", { status: "IDLE" });
  }
});
