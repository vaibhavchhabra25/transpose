# PitchShift — Chrome Extension v1.1

**Real-time high-definition audio transposition for the modern web.** Built for musicians, singers, and students who need to adjust playback to their specific key without sacrificing audio quality. PitchShift implements a professional-grade **Phase-Locked Vocoder** that outperforms standard browser pitch shifting.

---

## 🎵 Why PitchShift? (Motivation)

Standard browser pitch shifting (the `playbackRate` method) is designed for speed, not musicality. It creates significant metallic artifacts, timing issues, and "chipmunk" effects. 

**PitchShift** was engineered to solve these problems by:
* **Maintaining Audio Fidelity:** Uses a 4096-point FFT for professional-grade frequency resolution.
* **Preserving Stereo Image:** Unlike most shifters that collapse audio to mono, our **Stereo Phase-Locking** maintains the original soundstage width.
* **AI-Powered Insights:** Real-time key detection helps musicians identify the current tonality of any track instantly.
* **Bypassing Platform Restrictions:** Specifically designed to penetrate the complex audio graphs and Shadow DOM sandboxes used by **YouTube**, **Spotify**, and **SoundCloud**.

---

## 🚀 Key Features

* **Stereo Phase-Locked Algorithm:** Upgraded "Master/Slave" DSP engine ensures left/right phase coherence, keeping the audio wide and immersive.
* **AI Key Detection:** Dynamic real-time analysis of musical keys using a modified Krumhansl-Schmuckler algorithm with transient-noise filtering.
* **Dynamic Makeup Gain:** Automatically compensates for psychoacoustic volume loss when pitching up, ensuring consistent loudness.
* **Formant Preservation:** Toggleable "Natural Voice" mode that shifts pitch while preserving the original resonance of the vocal tract.
* **Identity Phase-Locking:** Minimizes "watery" artifacts by locking harmonics to their fundamental peaks.
* **Domain Isolation:** Settings are saved per-website. Your Spotify pitch stays on Spotify, while YouTube remains independent.

---

## ⌨️ Keyboard Shortcuts (v1.1 Layout)

### Global Shortcuts (Anywhere on the page)

| Command | Shortcut | Action |
|:--- |:--- |:--- |
| **Increase Pitch** | `Alt + =` | Coarse tune up (+1.0 semitone) |
| **Decrease Pitch** | `Alt + -` | Coarse tune down (-1.0 semitone) |
| **Fine Tune Up** | `Alt + Shift + =` | Micro-tune (+0.1 semitone) |
| **Fine Tune Down** | `Alt + Shift + -` | Micro-tune (-0.1 semitone) |
| **Reset to Original** | `Alt + 0` | Instantly return to 0.0 |
| **Toggle Formants** | `Alt + P` | Preserve original vocal timbre |

### Popup Shortcuts (When focused)
* `+` / `-` : Coarse adjustment (±1.0)
* `←` / `→` : Fine-tuning (±0.1)
* `Alt + 0` : Reset

---

## 🛠 Project Structure

```
pitch-shifter-extension/
├── manifest.json               # Chrome MV3 manifest
├── content/
│   ├── content.js              # Domain setting manager & relay
│   ├── injected.js             # Main-world AudioContext proxy & Key Detection
│   └── pitch-processor.js      # DSP Core: Phase-Locked Vocoder & Chroma Extraction
├── popup/
│   ├── popup.html              # Amber-themed UI with Key-Badge
│   └── popup.js                # State mirroring & shortcut sync
└── icons/                      # Extension icons (16, 32, 48, 128px)
```

---

## ⚖️ Key Highlights and Technical Notes

### Highlights
* **HD Resolution:** 4096 FFT size provides superior chord and vocal clarity.
* **True Stereo:** Phase-coherent processing prevents mono-collapse.
* **Hardware Optimized:** Uses pre-allocated memory pools to prevent browser crashes.

### Technical Notes
* **Initial Analysis:** Key detection requires ~4-5 seconds of audio to lock onto the global song key.
* **True Bypass:** When set to 0.0, the engine uses a zero-latency direct route but continues frequency analysis in the background.
* **DRM Limits:** Cannot process hardware-encrypted streams (e.g., Netflix) due to browser security.