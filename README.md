# PitchShift — Chrome Extension

**Real-time high-definition audio transposition for the modern web.** Built for musicians, singers, and students who need to adjust playback to their specific key. PitchShift bypasses standard "robotic" browser pitch-shifting and implements a custom Phase Vocoder with high frequency resolution and formant preservation.

---

## 🎵 Why PitchShift? (Motivation)

Standard browser pitch shifting (the `playbackRate` method) is designed for speed, not musicality. It creates significant metallic artifacts, timing issues, and "chipmunk" effects. 

**PitchShift** was engineered to solve these problems by:
* **Maintaining Audio Fidelity:** Uses a 4096-point FFT for professional-grade frequency resolution.
* **Bypassing Platform Restrictions:** Specifically designed to penetrate the complex audio graphs and Shadow DOM sandboxes used by **YouTube**, **Spotify**, and **SoundCloud**.
* **Enabling Micro-tuning:** Supports 0.1 semitone precision for tuning to non-standard recordings or out-of-tune instruments.

---

## 🚀 Key Features

* **HD Algorithm:** Re-implemented Phase Vocoder with 75% overlap and branchless math for ultra-stable, artifacts-minimized playback.
* **Domain Isolation:** Settings are saved per-website. Your Spotify pitch stays on Spotify, while YouTube remains independent.
* **Formant Preservation:** Toggleable "Natural Voice" mode (`Alt+Shift+F`) that shifts pitch while preserving the original resonance of the vocal tract.
* **Keyboard Shortcuts & OSD:** Adjust pitch instantly with a sleek glassmorphic On-Screen Display (OSD) toast.
* **Zero-Latency Bypass:** When set to 0.0, the extension enters a true-bypass mode that skips all mathematical processing for 100% original quality.

---

## ⌨️ Keyboard Shortcuts

| Command | Action |
|:--- |:--- |
| `Alt + Shift + Up` | Increase Pitch (+1.0 semitone) |
| `Alt + Shift + Down` | Decrease Pitch (-1.0 semitone) |
| `Alt + Shift + Right` | Fine Tune Up (+0.1 semitone) |
| `Alt + Shift + Left` | Fine Tune Down (-0.1 semitone) |
| `Alt + Shift + F` | **Toggle Formant Preservation** |
| `Alt + Shift + 0` | Reset to Original Pitch |

---

## ⚖️ Key Highlights and Limitations

### Key Highlights
* **HD Resolution:** 4096 FFT size provides superior chord and vocal clarity.
* **Universal Compatibility:** Works on YouTube (Shadow DOM support), Spotify (MSE/EME), and SoundCloud.
* **Hardware Optimized:** Uses pre-allocated memory pools to prevent browser crashes and memory leaks.

### Limitations
* **Initial "Warm-up":** Due to the heavy math, the browser's JIT compiler needs 2-3 seconds of playback to fully optimize the thread performance.
* **Mono Conversion:** Complex stereo-widening effects may be slightly narrowed due to phase reconstruction.
* **DRM Limits:** Cannot process protected content on platforms like Netflix or Disney+ due to browser-level hardware encryption.

---

## 🛠 Project Structure

```
pitch-shifter-extension/
├── manifest.json               # Chrome MV3 manifest
├── content/
│   ├── content.js              # Domain setting manager & relay
│   ├── injected.js             # Main-world AudioContext proxy
│   └── pitch-processor.js      # The DSP Math Core (AudioWorklet)
├── popup/
│   ├── popup.html              # Dynamic UI with micro-tuning
│   └── popup.js                # UI State Mirroring logic
└── icons/                      # Extension icons
```