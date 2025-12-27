# MMM-Jarvis

A Magic Mirror module that acts as a voice assistant using the "Jarvis" wake word and OpenAI's powerful APIs.

## Features

- **Wake Word:** Activates when you say "Jarvis" (powered by Picovoice Porcupine).
- **Speech to Text:** Uses OpenAI Whisper API for accurate transcription.
- **Contextual Intelligence:** Uses OpenAI GPT-4o-mini for fast, smart responses.
- **Text to Speech:** Uses OpenAI TTS (Onyx voice) for high-quality audio responses.
- **Streaming:** Real-time text updates on the mirror.
- **Visuals:** Jarvis-style circular animation.
- **Auto Brightness:** Automatically increases display brightness when wake word is detected or during voice interactions (Raspberry Pi only).

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

### Brightness Control (Raspberry Pi)

The module automatically increases display brightness when the wake word is detected or during voice interactions. The module supports multiple brightness control methods:

#### Supported Methods:

1. **sysfs** (`/sys/class/backlight/`) - For official Raspberry Pi touchscreen displays
2. **ddcutil** - For HDMI displays with DDC/CI support (can actually control brightness!)
3. **brightnessctl** - Common on modern Linux (Wayland and X11)
4. **wlr-randr** - For Wayland displays (wlroots-based compositors)
5. **xrandr** - For X11 displays
6. **vcgencmd** - For HDMI displays (can turn display on/off, but not control brightness levels)

#### For Official Pi Touchscreen (sysfs method):

**Option 1: Add user to video group (Recommended)**
```bash
sudo usermod -a -G video $USER
```
Then log out and log back in for the change to take effect.

**Option 2: Configure passwordless sudo (if Option 1 doesn't work)**
```bash
sudo visudo
```
Add this line (replace `pi` with your username):
```
pi ALL=(ALL) NOPASSWD: /bin/tee /sys/class/backlight/*/brightness
```

#### For HDMI Displays:

**Option 1: Install ddcutil for DDC/CI brightness control (Recommended)**

Many modern HDMI monitors support DDC/CI, which allows software brightness control. Install `ddcutil`:

```bash
sudo apt-get update
sudo apt-get install ddcutil
```

Enable I2C:
```bash
sudo raspi-config
# Navigate to: Interface Options → I2C → Enable
```

**Important:** Allow ddcutil to run without password prompts:
```bash
# Create sudoers rule for ddcutil (replace 'pi' with your username)
sudo bash -c 'echo "pi ALL=(ALL) NOPASSWD: /usr/bin/ddcutil" > /etc/sudoers.d/ddcutil'
sudo chmod 440 /etc/sudoers.d/ddcutil

# Reboot
sudo reboot
```

Test that it works without a dialog:
```bash
sudo ddcutil setvcp 10 90
```

**Option 2: Install brightnessctl (for Wayland/modern Linux)**

```bash
sudo apt-get install brightnessctl
```

**Option 3: Install wlr-randr (for Wayland)**

```bash
sudo apt-get install wlr-randr
```

**Option 4: If none of these work**

If your monitor doesn't support any of these methods, the module will fall back to `vcgencmd` which can only turn the display on/off (not control brightness). In this case, brightness must be controlled using the display's hardware buttons or menu.

**Note:** Check the MagicMirror logs to see which brightness control method was detected. The module will log which method is being used (or if none is available).

