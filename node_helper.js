const NodeHelper = require("node_helper");
const OpenAI = require("openai");
const Porcupine = require("@picovoice/porcupine-node");
const fs = require("fs");
const path = require("path");
const recorder = require("node-record-lpcm16");
const { spawn } = require("child_process");

module.exports = NodeHelper.create({
  start: function () {
    console.log("Starting node_helper for MMM-Jarvis");
    this.porcupine = null;
    this.micStream = null;
    this.isListening = false;
    this.audioBuffer = [];
  },

  socketNotificationReceived: function (notification, payload) {
    if (notification === "INIT") {
      this.config = payload;
      this.initialize();
    }
  },

  initialize: function () {
    if (!this.config.openaiKey || !this.config.picovoiceKey) {
      console.error("MMM-Jarvis: Missing OpenAI or Picovoice API Key");
      return;
    }

    this.openai = new OpenAI({ apiKey: this.config.openaiKey });
    this.initPorcupine();
    this.startWakeWordListener();
  },

  initPorcupine: function () {
    try {
      this.porcupine = new Porcupine(
        this.config.picovoiceKey,
        [Porcupine.BUILTIN_KEYWORDS.JARVIS],
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
    
    // Check for microphone device. In production, you might need to specify device: 'plughw:1,0' etc.
    // For now, we rely on default.
    
    try {
        this.micStream = recorder.record({
          sampleRate: 16000,
          threshold: 0,
          verbose: false,
          recordProgram: "rec", 
          silence: "1.0",
        });
    
        const stream = this.micStream.stream();
        
        stream.on("data", (chunk) => {
            // DEBUG: Uncomment to see if data is flowing
            // console.log("Audio chunk received:", chunk.length);
            
            if (this.isListening) return; 

            // ... existing processing ...
            let frameLength = this.porcupine.frameLength;
            // We need to manage our own buffer because chunks come in random sizes
            // and Porcupine needs exactly frameLength (512)
            
            for (let i = 0; i < chunk.length; i += 2) {
                if (this.audioBuffer.length >= frameLength) {
                    // Process frame
                    const frame = new Int16Array(this.audioBuffer.slice(0, frameLength));
                    this.processFrame(frame);
                    
                    // Remove processed data
                    this.audioBuffer = this.audioBuffer.slice(frameLength);
                }
                
                // Read Int16 little endian and add to buffer
                let val = chunk.readInt16LE(i);
                this.audioBuffer.push(val);
            }
        });
        
        stream.on("error", (err) => {
            console.error("MMM-Jarvis: Mic stream error", err);
        });
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
      this.micStream.stop(); // Stop wake word listener
      this.sendSocketNotification("STATUS_UPDATE", { status: "LISTENING" });
      this.recordCommand();
    }
  },

  recordCommand: function () {
    console.log("MMM-Jarvis: Recording command...");
    const filePath = path.join(__dirname, "command.wav");
    
    // Using child_process to spawn 'rec' directly to record a WAV file with proper header
    // node-record-lpcm16 is great for raw streams, but Whisper likes valid WAV headers
    // 'rec' is from sox. 
    // rec -r 16000 -c 1 -b 16 command.wav silence 1 0.1 3% 1 2.0 3%
    // This records 16k, mono, 16bit, stops on silence.
    
    // Adjust silence parameters: 
    // silence 1 0.1 3% (start on sound > 3% for 0.1s - ignored since we start immediately)
    // 1 2.0 3% (stop after 2.0s of silence < 3%)
    
    const args = [
        "-r", "16000",
        "-c", "1",
        "-b", "16",
        filePath,
        "silence", "1", "0.1", "3%", "1", "1.5", "3%" // Trimmed to 1.5s silence
    ];
    
    let recordCmd = "rec";
    // On Raspberry Pi/Linux, 'rec' is standard from sox.
    // On macOS, we might need to use 'sox' with arguments if 'rec' isn't aliased, 
    // but usually installing sox provides rec.
    
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
    }, 7000); // 7 seconds max
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

      if (!text || text.trim().length === 0) {
          this.reset();
          return;
      }

      // 2. GPT-4o-mini Streaming
      console.log("MMM-Jarvis: Getting response from GPT-4o-mini...");
      const stream = await this.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
            { role: "system", content: "You are Jarvis, a helpful AI assistant on a Magic Mirror. Keep answers concise." },
            { role: "user", content: text }
        ],
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
            this.sendSocketNotification("RESPONSE_END");
            this.reset();
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
  
  playAudio: function(filePath) {
      let command = "mpg123";
      let args = [filePath];
      
      if (process.platform === "darwin") {
          command = "afplay";
          args = [filePath];
      }
      
      const player = spawn(command, args);
      
      player.on("close", (code) => {
          this.sendSocketNotification("RESPONSE_END");
          this.reset();
      });
      
      player.on("error", (err) => {
          console.error("Audio player error", err);
          this.reset();
      });
  },

  reset: function () {
    this.isListening = false;
    this.startWakeWordListener(); // Resume wake word listening
    this.sendSocketNotification("STATUS_UPDATE", { status: "IDLE" });
  }
});
