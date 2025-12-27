const NodeHelper = require("node_helper");
const fs = require("fs");
const path = require("path");
const { spawn, exec, execSync } = require("child_process");

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
    this.pendingRecording = null; // Track active recording process
    this.backlightPath = null; // Path to backlight brightness control
    this.maxBrightness = 255; // Default max brightness value
    this.brightnessMethod = null; // 'sysfs', 'vcgencmd', 'xrandr', or null
    this.initBrightnessControl(); // Initialize brightness control
    
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

  initBrightnessControl: function () {
    // Try multiple methods to find brightness control
    console.log("MMM-Jarvis: Initializing brightness control...");
    
    // Method 1: Try /sys/class/backlight (for official Pi touchscreen)
    const backlightDir = "/sys/class/backlight";
    if (fs.existsSync(backlightDir)) {
      try {
        const devices = fs.readdirSync(backlightDir);
        if (devices.length > 0) {
          const device = devices.find(d => 
            d.includes("rpi") || d.includes("raspberrypi") || d.includes("backlight")
          ) || devices[0];
          
          this.backlightPath = path.join(backlightDir, device);
          const brightnessFile = path.join(this.backlightPath, "brightness");
          const maxBrightnessFile = path.join(this.backlightPath, "max_brightness");
          
          if (fs.existsSync(brightnessFile) && fs.existsSync(maxBrightnessFile)) {
            const maxBrightnessContent = fs.readFileSync(maxBrightnessFile, "utf8").trim();
            this.maxBrightness = parseInt(maxBrightnessContent, 10) || 255;
            const currentBrightness = fs.readFileSync(brightnessFile, "utf8").trim();
            this.brightnessMethod = 'sysfs';
            console.log(`MMM-Jarvis: ✓ Brightness control initialized via sysfs (current: ${currentBrightness}, max: ${this.maxBrightness})`);
            return;
          }
        }
      } catch (e) {
        console.log(`MMM-Jarvis: sysfs method failed: ${e.message}`);
      }
    }
    
    // Method 2: Check for ddcutil (DDC/CI brightness control for HDMI displays)
    // This can actually control brightness on supported monitors
    try {
      execSync("which ddcutil", { stdio: 'ignore' });
      // ddcutil can be slow on first run, so we'll just check if it exists
      // and defer the actual test to when we try to use it
      this.brightnessMethod = 'ddcutil';
      console.log("MMM-Jarvis: ✓ Using ddcutil for brightness control (DDC/CI)");
      return;
    } catch (e) {
      // ddcutil not available
    }
    
    // Method 3: Check for /sys/class/leds/ (alternative backlight path)
    const ledsDir = "/sys/class/leds";
    if (fs.existsSync(ledsDir)) {
      try {
        const leds = fs.readdirSync(ledsDir);
        // Look for backlight-related LEDs
        const backlightLed = leds.find(l => 
          l.toLowerCase().includes("backlight") || 
          l.toLowerCase().includes("lcd") ||
          l.toLowerCase().includes("display")
        );
        
        if (backlightLed) {
          const brightnessFile = path.join(ledsDir, backlightLed, "brightness");
          const maxBrightnessFile = path.join(ledsDir, backlightLed, "max_brightness");
          
          if (fs.existsSync(brightnessFile) && fs.existsSync(maxBrightnessFile)) {
            this.backlightPath = path.join(ledsDir, backlightLed);
            const maxBrightnessContent = fs.readFileSync(maxBrightnessFile, "utf8").trim();
            this.maxBrightness = parseInt(maxBrightnessContent, 10) || 255;
            this.brightnessMethod = 'sysfs';
            console.log(`MMM-Jarvis: ✓ Using LED backlight control: ${backlightLed}`);
            return;
          }
        }
      } catch (e) {
        // LED method failed
      }
    }
    
    // Method 4: Check for brightnessctl (common on modern Linux/Wayland)
    try {
      execSync("which brightnessctl", { stdio: 'ignore' });
      // Test if it can actually get brightness
      try {
        execSync("brightnessctl get", { stdio: 'ignore', timeout: 2000 });
        this.brightnessMethod = 'brightnessctl';
        console.log("MMM-Jarvis: ✓ Using brightnessctl for brightness control");
        return;
      } catch (e) {
        console.log("MMM-Jarvis: brightnessctl found but no controllable device");
      }
    } catch (e) {
      // brightnessctl not available
    }
    
    // Method 5: Check for wlr-randr (Wayland displays - wlroots based)
    try {
      execSync("which wlr-randr", { stdio: 'ignore' });
      this.brightnessMethod = 'wlr-randr';
      console.log("MMM-Jarvis: ✓ Using wlr-randr for Wayland brightness control");
      return;
    } catch (e) {
      // wlr-randr not available
    }
    
    // Method 6: Check for xrandr (X11 displays)
    try {
      execSync("which xrandr", { stdio: 'ignore' });
      this.brightnessMethod = 'xrandr';
      console.log("MMM-Jarvis: ✓ Using xrandr for display control");
      return;
    } catch (e) {
      // xrandr not available
    }
    
    // Method 7: Check for vcgencmd (Raspberry Pi display power control)
    // Note: vcgencmd can turn display on/off but doesn't control brightness directly
    // This is a last resort since it can't actually control brightness
    try {
      execSync("which vcgencmd", { stdio: 'ignore' });
      this.brightnessMethod = 'vcgencmd';
      console.log("MMM-Jarvis: ⚠ Using vcgencmd (power on/off only, cannot control brightness)");
      return;
    } catch (e) {
      // vcgencmd not available
    }
    
    // If no method found
    if (!this.brightnessMethod) {
      console.log("MMM-Jarvis: ⚠ No brightness control method found");
      console.log("MMM-Jarvis:   This is normal for HDMI displays - brightness control may not be available");
      this.backlightPath = null;
    }
  },

  increaseBrightness: function () {
    if (!this.brightnessMethod) {
      // No brightness control available - silently skip (this is normal for HDMI displays)
      return;
    }
    
    // Route to appropriate method based on what was detected
    switch (this.brightnessMethod) {
      case 'sysfs':
        this.increaseBrightnessSysfs();
        break;
      case 'ddcutil':
        this.increaseBrightnessDdcutil();
        break;
      case 'brightnessctl':
        this.increaseBrightnessBrightnessctl();
        break;
      case 'wlr-randr':
        this.increaseBrightnessWlrRandr();
        break;
      case 'xrandr':
        this.increaseBrightnessXrandr();
        break;
      case 'vcgencmd':
        this.increaseBrightnessVcgencmd();
        // Also try ddcutil as fallback since vcgencmd can't control brightness
        this.increaseBrightnessDdcutil();
        break;
      default:
        console.log("MMM-Jarvis: No brightness control method available");
    }
  },

  increaseBrightnessSysfs: function () {
    if (!this.backlightPath) {
      return;
    }

    const brightnessFile = path.join(this.backlightPath, "brightness");
    const targetBrightness = Math.floor(this.maxBrightness * 0.9);
    
    try {
      const currentBrightness = parseInt(fs.readFileSync(brightnessFile, "utf8").trim(), 10);
      console.log(`MMM-Jarvis: Current brightness: ${currentBrightness}/${this.maxBrightness}, target: ${targetBrightness}`);
      
      if (currentBrightness < targetBrightness) {
        try {
          fs.writeFileSync(brightnessFile, targetBrightness.toString(), { encoding: 'utf8' });
          
          setTimeout(() => {
            try {
              const verifyBrightness = parseInt(fs.readFileSync(brightnessFile, "utf8").trim(), 10);
              if (verifyBrightness === targetBrightness || verifyBrightness >= targetBrightness * 0.95) {
                console.log(`MMM-Jarvis: ✓ Brightness increased from ${currentBrightness} to ${verifyBrightness}`);
              } else {
                console.warn(`MMM-Jarvis: ⚠ Brightness write may have failed (expected ${targetBrightness}, got ${verifyBrightness})`);
                this.increaseBrightnessWithSudo(targetBrightness);
              }
            } catch (verifyError) {
              this.increaseBrightnessWithSudo(targetBrightness);
            }
          }, 100);
        } catch (writeError) {
          console.error(`MMM-Jarvis: Direct write failed: ${writeError.message}`);
          this.increaseBrightnessWithSudo(targetBrightness);
        }
      } else {
        console.log(`MMM-Jarvis: Brightness already adequate (${currentBrightness} >= ${targetBrightness})`);
      }
    } catch (e) {
      console.error(`MMM-Jarvis: Error reading brightness: ${e.message}`);
      this.increaseBrightnessWithSudo(targetBrightness);
    }
  },

  increaseBrightnessBrightnessctl: function () {
    // Use brightnessctl to set brightness to 90%
    exec("brightnessctl set 90%", (error, stdout, stderr) => {
      if (error) {
        console.error(`MMM-Jarvis: brightnessctl failed: ${error.message}`);
        return;
      }
      console.log("MMM-Jarvis: ✓ Brightness set to 90% via brightnessctl");
    });
  },

  increaseBrightnessDdcutil: function () {
    // Use ddcutil to control brightness via DDC/CI (VCP code 10 = brightness)
    // Using sudo to bypass polkit authentication dialog
    console.log("MMM-Jarvis: Detecting display via ddcutil...");
    
    // First, detect the display to get the bus number
    exec("sudo ddcutil detect", { timeout: 15000 }, (detectError, detectStdout, detectStderr) => {
      if (detectError) {
        console.error(`MMM-Jarvis: ddcutil detect failed: ${detectError.message}`);
        return;
      }
      
      // Parse bus number from output like "I2C bus:  /dev/i2c-21"
      const busMatch = detectStdout.match(/I2C bus:\s*\/dev\/i2c-(\d+)/);
      const busNumber = busMatch ? busMatch[1] : null;
      
      if (!busNumber) {
        console.error("MMM-Jarvis: Could not detect I2C bus for display");
        return;
      }
      
      console.log(`MMM-Jarvis: Found display on I2C bus ${busNumber}`);
      
      // Get current brightness using sudo and the specific bus
      exec(`sudo ddcutil getvcp 10 --bus ${busNumber}`, { timeout: 10000 }, (error, stdout, stderr) => {
        if (error) {
          console.error(`MMM-Jarvis: ddcutil getvcp failed: ${error.message}`);
          return;
        }
        
        console.log(`MMM-Jarvis: ddcutil output: ${stdout.trim()}`);
        
        // Parse current brightness from output like:
        // "VCP code 0x10 (Brightness): current value = 75, max value = 100"
        const match = stdout.match(/current value\s*=\s*(\d+).*max value\s*=\s*(\d+)/i);
        if (match) {
          const currentBrightness = parseInt(match[1], 10);
          const maxBrightness = parseInt(match[2], 10);
          // Use 75% to avoid Dell "Energy Smart" confirmation dialog
          // Dell monitors show a prompt when setting brightness above 75%
          const targetBrightness = Math.floor(maxBrightness * 0.75);
          
          console.log(`MMM-Jarvis: Current: ${currentBrightness}, Max: ${maxBrightness}, Target: ${targetBrightness}`);
          
          if (currentBrightness < targetBrightness) {
            // Set brightness to 75% using sudo and the specific bus
            console.log(`MMM-Jarvis: Setting brightness to ${targetBrightness}...`);
            exec(`sudo ddcutil setvcp 10 ${targetBrightness} --bus ${busNumber}`, { timeout: 10000 }, (setError, setStdout, setStderr) => {
              if (setError) {
                console.error(`MMM-Jarvis: ddcutil setvcp failed: ${setError.message}`);
              } else {
                console.log(`MMM-Jarvis: ✓ Brightness set to ${targetBrightness}% via ddcutil`);
              }
            });
          } else {
            console.log(`MMM-Jarvis: Brightness already adequate (${currentBrightness} >= ${targetBrightness})`);
          }
        } else {
          console.error(`MMM-Jarvis: Could not parse ddcutil output: ${stdout}`);
        }
      });
    });
  },

  increaseBrightnessVcgencmd: function () {
    // vcgencmd can only turn display on/off, not control brightness
    // But we can ensure the display is powered on
    exec("vcgencmd display_power 1", (error, stdout, stderr) => {
      if (error) {
        console.error(`MMM-Jarvis: vcgencmd display_power failed: ${error.message}`);
      } else {
        console.log("MMM-Jarvis: ✓ Display powered on via vcgencmd");
      }
    });
  },

  increaseBrightnessXrandr: function () {
    // Get the connected display name first
    exec("xrandr --listmonitors | head -1 | awk '{print $4}'", (error, displayName, stderr) => {
      if (error || !displayName) {
        // Fallback: try to get primary display
        exec("xrandr | grep ' connected' | head -1 | awk '{print $1}'", (error2, displayName2, stderr2) => {
          if (!error2 && displayName2) {
            this.setXrandrBrightness(displayName2.trim());
          } else {
            console.error("MMM-Jarvis: Could not determine display name for xrandr");
          }
        });
      } else {
        this.setXrandrBrightness(displayName.trim());
      }
    });
  },

  increaseBrightnessWlrRandr: function () {
    // For Wayland displays using wlroots-based compositors (like labwc, sway, wayfire)
    // wlr-randr doesn't have a direct brightness control, but we can use it to ensure
    // the display is enabled. For actual brightness, we try multiple approaches.
    
    // First, try to ensure display is on
    exec("wlr-randr", (error, stdout, stderr) => {
      if (error) {
        console.error(`MMM-Jarvis: wlr-randr failed: ${error.message}`);
        return;
      }
      
      // Parse output to get display name
      const lines = stdout.split('\n');
      const displayLine = lines.find(l => !l.startsWith(' ') && l.trim().length > 0);
      
      if (displayLine) {
        const displayName = displayLine.trim();
        console.log(`MMM-Jarvis: Found Wayland display: ${displayName}`);
        
        // Try to enable the display (in case it was disabled)
        exec(`wlr-randr --output ${displayName} --on`, (enableError) => {
          if (enableError) {
            console.error(`MMM-Jarvis: wlr-randr enable failed: ${enableError.message}`);
          } else {
            console.log(`MMM-Jarvis: ✓ Display ${displayName} enabled via wlr-randr`);
          }
        });
        
        // Also try brightnessctl if available (works on some Wayland setups)
        exec("which brightnessctl", (bcError) => {
          if (!bcError) {
            exec("brightnessctl set 90%", (setError, setStdout, setStderr) => {
              if (setError) {
                console.log(`MMM-Jarvis: brightnessctl not available for this display`);
              } else {
                console.log(`MMM-Jarvis: ✓ Brightness set to 90% via brightnessctl`);
              }
            });
          }
        });
      }
    });
  },

  setXrandrBrightness: function (displayName) {
    // Set brightness to 0.9 (90%) using xrandr
    const cmd = `xrandr --output ${displayName} --brightness 0.9`;
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error(`MMM-Jarvis: xrandr brightness failed: ${error.message}`);
      } else {
        console.log(`MMM-Jarvis: ✓ Brightness set to 90% via xrandr on ${displayName}`);
      }
    });
  },

  increaseBrightnessWithSudo: function (targetBrightness) {
    // Fallback: use shell command to write brightness (more reliable on Raspberry Pi)
    const brightnessFile = path.join(this.backlightPath, "brightness");
    
    // Method 1: Try without sudo first (works if user is in video group)
    const cmd = `echo ${targetBrightness} > ${brightnessFile}`;
    
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        // Method 2: Try with sudo as fallback
        console.log(`MMM-Jarvis: Shell command failed, trying with sudo...`);
        const sudoCmd = `echo ${targetBrightness} | sudo tee ${brightnessFile} > /dev/null`;
        
        exec(sudoCmd, (sudoError, sudoStdout, sudoStderr) => {
          if (sudoError) {
            console.error(`MMM-Jarvis: ✗ All brightness methods failed`);
            console.error(`MMM-Jarvis: Shell error: ${error.message}`);
            console.error(`MMM-Jarvis: Sudo error: ${sudoError.message}`);
            console.error(`MMM-Jarvis: Note: You may need to:`);
            console.error(`MMM-Jarvis:   1. Add user to video group: sudo usermod -a -G video $USER`);
            console.error(`MMM-Jarvis:   2. Or configure passwordless sudo for brightness file`);
            return;
          }
          console.log(`MMM-Jarvis: ✓ Brightness set to ${targetBrightness} using sudo method`);
          
          // Verify the write worked
          setTimeout(() => {
            try {
              const verifyBrightness = parseInt(fs.readFileSync(brightnessFile, "utf8").trim(), 10);
              if (verifyBrightness === targetBrightness || verifyBrightness >= targetBrightness * 0.95) {
                console.log(`MMM-Jarvis: ✓ Verified brightness: ${verifyBrightness}`);
              } else {
                console.warn(`MMM-Jarvis: ⚠ Verification mismatch (expected ${targetBrightness}, got ${verifyBrightness})`);
              }
            } catch (verifyError) {
              console.error(`MMM-Jarvis: Error verifying brightness: ${verifyError.message}`);
            }
          }, 100);
        });
      } else {
        // Verify the write worked
        setTimeout(() => {
          try {
            const verifyBrightness = parseInt(fs.readFileSync(brightnessFile, "utf8").trim(), 10);
            if (verifyBrightness === targetBrightness || verifyBrightness >= targetBrightness * 0.95) {
              console.log(`MMM-Jarvis: ✓ Brightness set to ${verifyBrightness} using shell method`);
            } else {
              console.warn(`MMM-Jarvis: ⚠ Shell write may have failed (expected ${targetBrightness}, got ${verifyBrightness})`);
            }
          } catch (verifyError) {
            console.error(`MMM-Jarvis: Error verifying brightness after shell write: ${verifyError.message}`);
          }
        }, 100);
      }
    });
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
      
      // Increase brightness if screen is dimmed
      this.increaseBrightness();
      
      // Immediately notify UI - before stopping mic for faster feedback
      this.sendSocketNotification("STATUS_UPDATE", { status: "LISTENING" });
      
      // Play acknowledgment sound for immediate feedback (non-blocking)
      this.playAckSound();
      
      this.micStream.stop(); 
      this.recordCommand();
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

  recordCommand: function () {
    console.log("MMM-Jarvis: Recording command...");
    
    // Ensure brightness is up when starting to record (for continuous conversation)
    this.increaseBrightness();
    
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
    this.isListening = false;
    this.conversationHistory = []; // Clear history on full reset
    this.sendSocketNotification("RESPONSE_END"); // Signal UI to go IDLE and clear text
    this.startWakeWordListener(); // Resume wake word listening
    this.sendSocketNotification("STATUS_UPDATE", { status: "IDLE" });
  }
});
