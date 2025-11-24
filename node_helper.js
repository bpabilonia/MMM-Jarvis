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
    this.micStream = recorder.record({
      sampleRate: 16000,
      threshold: 0,
      verbose: false,
      recordProgram: "rec", // Try 'rec' (sox) or 'arecord'
      silence: "1.0",
    });

    const stream = this.micStream.stream();
    
    let frameLength = this.porcupine.frameLength;
    let buffer = new Int16Array(frameLength);
    let bufferIndex = 0;

    stream.on("data", (chunk) => {
      if (this.isListening) return; // Ignore if already handling a command

      // Convert buffer to Int16Array for Porcupine
      // Chunk is likely Buffer (uint8), need to view as Int16
      // We assume input is 16-bit linear PCM
      
      for (let i = 0; i < chunk.length; i += 2) {
        if (bufferIndex >= frameLength) {
            // Process frame
            this.processFrame(buffer);
            bufferIndex = 0;
        }
        // Read Int16 little endian
        let val = chunk.readInt16LE(i);
        buffer[bufferIndex++] = val;
      }
    });
    
    stream.on("error", (err) => {
        console.error("MMM-Jarvis: Mic stream error", err);
    });
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
    const fileStream = fs.createWriteStream(filePath, { encoding: "binary" });

    const recording = recorder.record({
      sampleRate: 16000,
      threshold: 0.5, // Stop on silence
      thresholdStart: null,
      thresholdEnd: null,
      silence: "2.0", // Stop after 2.0 seconds of silence
      verbose: false,
      recordProgram: "rec"
    });

    recording.stream().pipe(fileStream);

    // Safety timeout in case silence detection fails
    setTimeout(() => {
        recording.stop();
    }, 6000); // 6 seconds max

    recording.stream().on("end", () => {
        console.log("MMM-Jarvis: Recording finished.");
        this.sendSocketNotification("STATUS_UPDATE", { status: "PROCESSING" });
        this.processAudio(filePath);
    });
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

        // OpenAI Node SDK .body is a web stream in some contexts, or node stream. 
        // We need to handle it.
        // In Node.js, mp3.body is likely a node stream or has .pipe.
        // If not, we convert.
        
        const bufferStream = mp3.body;
        
        if (bufferStream.pipe) {
            bufferStream.pipe(player.stdin);
        } else {
            // If it's a Web ReadableStream (undici), we iterate
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
            // Fallback or reset
            this.reset();
        });

    } catch (e) {
        console.error("MMM-Jarvis: TTS Error", e);
        this.reset();
    }
  },
  

  reset: function () {
    this.isListening = false;
    this.startWakeWordListener(); // Resume wake word listening
    this.sendSocketNotification("STATUS_UPDATE", { status: "IDLE" });
  }
});

