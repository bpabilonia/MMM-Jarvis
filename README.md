# MMM-Jarvis

A Magic Mirror module that acts as a voice assistant using the "Jarvis" wake word and OpenAI's powerful APIs.

## Features

- **Wake Word:** Activates when you say "Jarvis" (powered by Picovoice Porcupine).
- **Speech to Text:** Uses OpenAI Whisper API for accurate transcription.
- **Contextual Intelligence:** Uses OpenAI GPT-4o-mini for fast, smart responses.
- **Text to Speech:** Uses OpenAI TTS (Onyx voice) for high-quality audio responses.
- **Realtime API Support:** Optional ultra-low-latency mode using OpenAI's Realtime API for seamless speech-to-speech conversations.
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

### Standard Mode (Default)

Uses Whisper for transcription, GPT-4o-mini for responses, and TTS for speech synthesis:

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

### Realtime API Mode (Low Latency)

Uses OpenAI's Realtime API for ultra-low-latency speech-to-speech conversations:

```javascript
{
    module: "MMM-Jarvis",
    position: "top_center",
    config: {
        openaiKey: "YOUR_OPENAI_API_KEY",
        picovoiceKey: "YOUR_PICOVOICE_ACCESS_KEY",
        wakeWord: "Jarvis",
        useRealtimeAPI: true,
        realtimeModel: "gpt-realtime",
        realtimeVoice: "ash"
    }
}
```

## Configuration Options

| Option | Description | Default |
|--------|-------------|---------|
| `openaiKey` | Your OpenAI API key (required) | `""` |
| `picovoiceKey` | Your Picovoice access key (required) | `""` |
| `wakeWord` | Wake word to activate Jarvis | `"Jarvis"` |
| `debug` | Enable debug logging | `true` |
| `useRealtimeAPI` | Use OpenAI Realtime API for lower latency | `false` |
| `realtimeModel` | Realtime API model to use | `"gpt-4o-realtime-preview-2024-12-17"` |
| `realtimeVoice` | Voice for Realtime API | `"ash"` |

### Available Realtime Voices

- `alloy` - Neutral and balanced
- `ash` - Warm and conversational
- `ballad` - Expressive and dramatic
- `coral` - Clear and professional
- `echo` - Smooth and calm
- `sage` - Wise and measured
- `shimmer` - Bright and energetic
- `verse` - Versatile and adaptive

## Standard vs Realtime Mode

### Standard Mode
- **Latency:** ~2-4 seconds (Whisper → GPT → TTS)
- **Cost:** Lower cost per interaction
- **Conversation History:** Maintains context across turns
- **Best for:** General use, budget-conscious deployments

### Realtime Mode
- **Latency:** ~300-500ms (near real-time)
- **Cost:** Higher cost (audio token pricing)
- **Features:** Server VAD, natural interruption handling
- **Best for:** Natural, conversational interactions where low latency is critical

## Notes

- The module uses `node-record-lpcm16` which relies on `sox`. Ensure your microphone is configured correctly as the default input device.
- The module uses `mpg123` for audio playback in standard mode. Ensure your speakers are configured as the default output device.
- Realtime API mode uses raw PCM audio streaming for the lowest possible latency.
- Say "goodbye Jarvis", "thank you Jarvis", "stop conversation", or "that's all" to end the conversation.
