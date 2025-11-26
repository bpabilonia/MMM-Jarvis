const NodeHelper = require("node_helper");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// Lazy load dependencies to prevent crash on load if missing
let OpenAI = null;
let Porcupine = null;
let BuiltinKeyword = null;
let recorder = null;

module.exports = NodeHelper.create({
  start: function () {
    console.log("MMM-Jarvis: node_helper started!");
    this.porcupine = null;
    this.micStream = null;
    this.isListening = false;
    this.audioBuffer = [];
    this.conversationHistory = []; // Store conversation context
    
    // Attempt to load dependencies
    try {
        OpenAI = require("openai");
        const PorcupineModule = require("@picovoice/porcupine-node");
        Porcupine = PorcupineModule.Porcupine;
        BuiltinKeyword = PorcupineModule.BuiltinKeyword;
        recorder = require("node-record-lpcm16");
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

    try {
        this.openai = new OpenAI({ apiKey: this.config.openaiKey });
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
      this.micStream.stop(); 
      this.sendSocketNotification("STATUS_UPDATE", { status: "LISTENING" });
      this.recordCommand();
    }
  },

  recordCommand: function () {
    console.log("MMM-Jarvis: Recording command...");
    const filePath = path.join(__dirname, "command.wav");
    
    const args = [
        "-r", "16000",
        "-c", "1",
        "-b", "16",
        filePath,
        "silence", "1", "0.1", "3%", "1", "1.5", "3%" 
    ];
    
    let recordCmd = "rec";
    const recording = spawn(recordCmd, args);
    
    recording.on("close", (code) => {
        console.log("MMM-Jarvis: Recording finished. Code:", code);
        this.sendSocketNotification("STATUS_UPDATE", { status: "PROCESSING" });
        this.processAudio(filePath);
    });
    
    recording.on("error", (err) => {
        console.error("MMM-Jarvis: Recording error", err);
        this.reset();
    });

    // Safety timeout
    setTimeout(() => {
        recording.kill();
    }, 7000); 
  },

  processAudio: async function (filePath) {
    try {
      // 1. Whisper STT
      console.log("MMM-Jarvis: Transcribing...");
      const transcription = await this.openai.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model: "whisper-1",
      });

      const text = transcription.text;
      console.log("MMM-Jarvis: Transcription:", text);
      this.sendSocketNotification("TRANSCRIPTION", { text });

      // If silence or empty, end conversation
      if (!text || text.trim().length === 0) {
          console.log("MMM-Jarvis: No speech detected, ending conversation.");
          this.reset();
          return;
      }
      
      // Check for exit phrases
      if (text.toLowerCase().includes("stop conversation") || text.toLowerCase().includes("thank you jarvis")) {
           this.reset();
           return;
      }

      // 2. GPT-4o-mini Streaming with Context
      console.log("MMM-Jarvis: Getting response from GPT-4o-mini...");
      
      // Add user message to history
      this.conversationHistory.push({ role: "user", content: text });
      
      // Prepare messages payload
      const messages = [
          { role: "system", content: "You are Jarvis, a helpful AI assistant on a Magic Mirror. You are in a continuous conversation. Keep answers concise and conversational." },
          ...this.conversationHistory
      ];

      const stream = await this.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: messages,
        stream: true,
      });

      this.sendSocketNotification("RESPONSE_START");
      let fullResponse = "";

      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || "";
        if (content) {
            fullResponse += content;
            this.sendSocketNotification("RESPONSE_CHUNK", { text: content });
        }
      }

      console.log("MMM-Jarvis: Full response:", fullResponse);
      
      // Add assistant response to history
      this.conversationHistory.push({ role: "assistant", content: fullResponse });
      
      // Limit history to last 10 turns to prevent token overflow
      if (this.conversationHistory.length > 20) {
          this.conversationHistory = this.conversationHistory.slice(this.conversationHistory.length - 20);
      }
      
      // 3. TTS Streaming (Onyx)
      this.streamTTS(fullResponse);

    } catch (e) {
      console.error("MMM-Jarvis: API Error", e);
      this.sendSocketNotification("STATUS_UPDATE", { status: "ERROR" });
      this.reset();
    }
  },

  streamTTS: async function (text) {
    try {
        console.log("MMM-Jarvis: Generating speech...");
        const mp3 = await this.openai.audio.speech.create({
            model: "tts-1",
            voice: "onyx",
            input: text,
        });
        
        console.log("MMM-Jarvis: Streaming audio playback...");
        
        let command = "mpg123";
        let args = ["-"]; // Read from stdin
        
        if (process.platform === "darwin") {
            command = "mpg123";
            args = ["-"];
        }

        const player = spawn(command, args);

        const bufferStream = mp3.body;
        
        if (bufferStream.pipe) {
            bufferStream.pipe(player.stdin);
        } else {
            for await (const chunk of bufferStream) {
                player.stdin.write(Buffer.from(chunk));
            }
            player.stdin.end();
        }
        
        player.on("close", (code) => {
            // Continue conversation loop instead of resetting
            this.continueConversation();
        });
        
        player.on("error", (err) => {
            console.error("Audio player error", err);
            this.reset();
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
      
      // Small delay to ensure audio output is fully cleared/stopped before mic opens
      setTimeout(() => {
          this.recordCommand();
      }, 300);
  },

  reset: function () {
    this.isListening = false;
    this.conversationHistory = []; // Clear history on full reset
    this.sendSocketNotification("RESPONSE_END"); // Signal UI to go IDLE and clear text
    this.startWakeWordListener(); // Resume wake word listening
    this.sendSocketNotification("STATUS_UPDATE", { status: "IDLE" });
  }
});
