# PitchShift — Chrome Extension

Real-time audio transposition for any webpage. Built for musicians and singers
who want to adjust playback to their key — works on YouTube, SoundCloud,
Spotify Web, Bandcamp, and most HTML5 audio/video platforms.

---

## Project Structure

```
pitch-shifter-extension/
├── manifest.json               # Chrome MV3 manifest
├── background/
│   └── service-worker.js       # Relays popup ↔ content messages
├── content/
│   ├── content.js              # Intercepts media elements, manages AudioContext
│   └── pitch-processor.js      # AudioWorklet: phase vocoder pitch shifter
├── popup/
│   ├── popup.html              # Extension UI
│   ├── popup.css               # Dark minimal styling
│   └── popup.js                # UI logic + messaging
└── icons/                      # Add icon16.png, icon48.png, icon128.png
```

---

## How It Works

### 1. Content Script (`content.js`)
Injected at `document_start` on every page. It:
- Scans for `<audio>` and `<video>` elements
- Watches for dynamically added elements via `MutationObserver`
- Intercepts the `play` event to catch lazy-loaded media (SPAs like YouTube)
- Calls `createMediaElementSource()` to take over audio routing
- Builds an AudioContext pipeline: **Source → PitchShifter → Destination**

### 2. AudioWorklet Processor (`pitch-processor.js`)
Runs in the browser's audio rendering thread (real-time, off the main thread).
Implements a **Phase Vocoder** algorithm:

```
Input samples → Ring buffer
                     ↓ (every HOP_SIZE samples)
             Windowed FFT frame (Hann window)
                     ↓
         Phase deviation analysis per bin
                     ↓
        Pitch shift: remap bins by pitchFactor
                     ↓
              IFFT + Overlap-Add
                     ↓
              Output ring buffer
```

Key parameters:
- `FFT_SIZE = 2048` — ~46ms analysis window at 44.1kHz
- `HOP_SIZE = 512` — 75% overlap for smooth reconstruction
- `pitchFactor` — AudioParam (k-rate), range 0.25–4.0

### 3. Popup (`popup.js`)
Minimal UI. Sends `SET_SEMITONES` message → background → content script.
Converts semitones to pitch factor: `factor = 2^(semitones/12)`

---

## Loading into Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select this folder (`pitch-shifter-extension/`)
5. Navigate to a page with audio/video, press play, then open the extension

> **Note:** You need placeholder icon files or Chrome will warn. Create three
> simple PNG files named `icon16.png`, `icon48.png`, `icon128.png` in `icons/`.

---

## Known Limitations & Next Steps

### Platform Compatibility
| Platform | Status | Notes |
|---|---|---|
| YouTube | ⚠️ Partial | YouTube creates its own AudioContext early; hook catches via `play` event |
| SoundCloud | ✅ Works | Standard HTML5 audio |
| Bandcamp | ✅ Works | Standard HTML5 audio |
| Spotify Web | ⚠️ Partial | Uses complex MSE/EME — may need `AudioContext` patching |
| Netflix/Disney+ | ❌ Blocked | DRM (EME) prevents audio graph manipulation |

### Planned Improvements

**Phase 2 — Better Compatibility**
- [ ] Patch `AudioContext` constructor early (via injected script) to intercept
      platforms that create their own AudioContext (YouTube, Spotify)
- [ ] Handle `MediaSource` / `SourceBuffer` audio (MSE-based players)

**Phase 3 — Algorithm Quality**
- [ ] Increase FFT_SIZE to 4096 for better frequency resolution
- [ ] Add psychoacoustic formant preservation (avoid "chipmunk" effect)
- [ ] Implement WSOLA fallback for smoother transients

**Phase 4 — UX**
- [ ] Key detection (show what musical key the content is in)
- [ ] Preset slots (save favourite transpositions per domain)
- [ ] Fine-tuning in cents (±50 cents = ±0.5 semitones)
- [ ] Visual pitch indicator / VU meter

**Phase 5 — YouTube-specific Fix**
YouTube intercepts AudioContext. The fix is to inject a script at `document_start`
(before YouTube's JS runs) that patches `window.AudioContext`:

```js
// injected-early.js (inject via chrome.scripting or <script> tag)
const OriginalAudioContext = window.AudioContext;
window.AudioContext = function(...args) {
  const ctx = new OriginalAudioContext(...args);
  window.dispatchEvent(new CustomEvent('pitchshift:audiocontext', { detail: ctx }));
  return ctx;
};
```

Then content.js listens for that event and reuses the existing context.

---

## Contributing / Building On

The codebase is intentionally kept in plain JS with no build step so you can
iterate fast. When the project grows, consider:

- **Bundler**: Vite or esbuild (for tree-shaking, TypeScript)
- **Testing**: Vitest for the FFT and pitch math
- **Better FFT**: Replace the hand-rolled FFT with a WASM port of FFTW for
  ~10× speed, enabling larger FFT_SIZE with lower latency
