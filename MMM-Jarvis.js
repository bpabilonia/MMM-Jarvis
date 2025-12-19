Module.register("MMM-Jarvis", {
  defaults: {
    picovoiceKey: "", // Required for Porcupine
    openaiKey: "", // Required for OpenAI
    wakeWord: "Jarvis", // Porcupine keyword
    debug: true
  },

  start: function () {
    console.log("MMM-Jarvis: Module start() called");
    Log.info("MMM-Jarvis: Module started!");
    this.status = "IDLE"; // IDLE, LISTENING, PROCESSING, SPEAKING
    this.transcription = "";
    this.response = "";
    this.visualMode = "avatar"; // 'orb' or 'avatar'
    this.sendSocketNotification("INIT", this.config);
  },

  getStyles: function () {
    return ["MMM-Jarvis.css"];
  },

  getDom: function () {
    const wrapper = document.createElement("div");
    wrapper.className = "MMM-Jarvis " + this.status.toLowerCase();

    const status = document.createElement("div");
    status.className = "status " + this.status.toLowerCase();
    status.innerText = this.status;
    wrapper.appendChild(status);

    // Visual Container
    let visualContainer;
    
    if (this.visualMode === "avatar") {
        // AVATAR MODE
        visualContainer = document.createElement("div");
        visualContainer.className = "jarvis-avatar " + this.status.toLowerCase();
        
        const head = document.createElement("div");
        head.className = "avatar-head";
        
        const eyes = document.createElement("div");
        eyes.className = "avatar-eyes";
        
        const leftEye = document.createElement("div");
        leftEye.className = "avatar-eye left";
        const rightEye = document.createElement("div");
        rightEye.className = "avatar-eye right";
        
        eyes.appendChild(leftEye);
        eyes.appendChild(rightEye);
        
        const mouth = document.createElement("div");
        mouth.className = "avatar-mouth";
        
        head.appendChild(eyes);
        head.appendChild(mouth);
        visualContainer.appendChild(head);
        
    } else {
        // ORB MODE (Default)
        visualContainer = document.createElement("div");
        visualContainer.className = "jarvis-circle " + this.status.toLowerCase();
    }
    
    wrapper.appendChild(visualContainer);

    // Toggle Button
    const toggle = document.createElement("div");
    toggle.className = "visual-toggle";
    toggle.innerText = this.visualMode === "orb" ? "Switch to Avatar" : "Switch to Orb";
    toggle.addEventListener("click", () => {
        this.visualMode = this.visualMode === "orb" ? "avatar" : "orb";
        this.updateDom();
    });
    wrapper.appendChild(toggle);

    if (this.transcription) {
      const transcription = document.createElement("div");
      transcription.className = "transcription";
      transcription.innerText = `"${this.transcription}"`;
      wrapper.appendChild(transcription);
    }

    if (this.response) {
      const response = document.createElement("div");
      response.className = "response";
      response.innerText = this.response;
      wrapper.appendChild(response);
    }

    return wrapper;
  },

  socketNotificationReceived: function (notification, payload) {
    if (notification === "STATUS_UPDATE") {
      Log.log(`MMM-Jarvis: Status update - ${payload.status}`);
      this.status = payload.status;
      
      // Clear previous response when starting new listening phase (but keep for conversation context)
      if (payload.status === "LISTENING" && this.status !== "IDLE") {
        // Keep transcription visible briefly during continuous conversation
      }
      
      this.updateDom();
    } else if (notification === "TRANSCRIPTION") {
      Log.log(`MMM-Jarvis: Transcription received - ${payload.text}`);
      this.transcription = payload.text;
      this.response = ""; // Clear previous response when new transcription arrives
      this.updateDom();
    } else if (notification === "RESPONSE_CHUNK") {
      // Streaming text update - throttle DOM updates for performance
      this.response += payload.text;
      
      // Only update DOM every few characters to reduce jank
      if (!this._updatePending) {
        this._updatePending = true;
        requestAnimationFrame(() => {
          this._updatePending = false;
          this.updateDom();
        });
      }
    } else if (notification === "RESPONSE_START") {
      Log.log("MMM-Jarvis: Response started");
      this.response = "";
      this.status = "SPEAKING";
      this.updateDom();
    } else if (notification === "RESPONSE_END") {
      Log.log("MMM-Jarvis: Response ended");
      this.status = "IDLE";
      // Clear text after delay when conversation truly ends
      setTimeout(() => {
        if (this.status === "IDLE") { // Only clear if still idle
          this.transcription = "";
          this.response = "";
          this.updateDom();
        }
      }, 3000); // Reduced from 5s to 3s
      this.updateDom();
    }
  }
});
