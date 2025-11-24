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
    this.sendSocketNotification("INIT", this.config);
  },

  getStyles: function () {
    return ["MMM-Jarvis.css"];
  },

  getDom: function () {
    const wrapper = document.createElement("div");
    wrapper.className = "MMM-Jarvis";

    const status = document.createElement("div");
    status.className = "status";
    status.innerText = this.status;
    wrapper.appendChild(status);

    const circle = document.createElement("div");
    circle.className = "jarvis-circle " + this.status.toLowerCase();
    wrapper.appendChild(circle);

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
      if (payload.status === "LISTENING") {
        this.transcription = "";
        this.response = "";
      }
      this.updateDom();
    } else if (notification === "TRANSCRIPTION") {
      Log.log(`MMM-Jarvis: Transcription received - ${payload.text}`);
      this.transcription = payload.text;
      this.updateDom();
    } else if (notification === "RESPONSE_CHUNK") {
      // Streaming text update
      this.response += payload.text;
      this.updateDom();
    } else if (notification === "RESPONSE_START") {
      Log.log("MMM-Jarvis: Response started");
      this.response = "";
      this.status = "SPEAKING";
      this.updateDom();
    } else if (notification === "RESPONSE_END") {
      Log.log("MMM-Jarvis: Response ended");
      this.status = "IDLE";
      setTimeout(() => {
        this.transcription = "";
        this.response = "";
        this.updateDom();
      }, 5000); // Clear after 5 seconds
      this.updateDom();
    }
  }
});
