# MMM-Jarvis

A Magic Mirror module that acts as a voice assistant using the "Jarvis" wake word and OpenAI's powerful APIs.

## Features

- **Wake Word:** Activates when you say "Jarvis" (powered by Picovoice Porcupine).
- **Speech to Text:** Uses OpenAI Whisper API for accurate transcription.
- **Contextual Intelligence:** Uses OpenAI GPT-4o-mini for fast, smart responses.
- **Text to Speech:** Uses OpenAI TTS (Onyx voice) for high-quality audio responses.
- **Streaming:** Real-time text updates on the mirror.
- **Visuals:** Jarvis-style circular animation.

## Prerequisites

### System Dependencies

You need to install `sox` (for recording) and `mpg123` (for playback) on your system.

**Raspberry Pi / Linux:**
```bash
sudo apt-get install sox libsox-fmt-all mpg123
```

**macOS:**
```bash
brew install sox mpg123
```

### API Keys

1. **OpenAI API Key:** Get one from [OpenAI Platform](https://platform.openai.com/).
2. **Picovoice Access Key:** Get a free Access Key from [Picovoice Console](https://console.picovoice.ai/).

## Installation

1. Navigate to your MagicMirror modules folder:
   ```bash
   cd ~/MagicMirror/modules
   ```
2. Clone this repository:
   ```bash
   git clone https://github.com/bpabilonia/MMM-Jarvis.git
   ```
3. Enter the folder:
   ```bash
   cd MMM-Jarvis
   ```
4. Install dependencies:
   ```bash
   npm install
   ```

## Configuration

Add the following to your `config/config.js` file in MagicMirror:

```javascript
{
    module: "MMM-Jarvis",
    position: "top_center",
    config: {
        openaiKey: "YOUR_OPENAI_API_KEY",
        picovoiceKey: "YOUR_PICOVOICE_ACCESS_KEY",
        wakeWord: "Jarvis" // Optional, defaults to Jarvis
    }
}
```

## Notes

- The module uses `node-record-lpcm16` which relies on `sox`. Ensure your microphone is configured correctly as the default input device.
- The module uses `mpg123` for audio playback. Ensure your speakers are configured as the default output device.

