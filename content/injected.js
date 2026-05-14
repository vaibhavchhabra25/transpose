// content/injected.js  —  world: "MAIN"
// Runs in the PAGE's own JS context before any site scripts.

(function () {
    'use strict';
    if (window.__pitchShiftInjected) return;
    window.__pitchShiftInjected = true;

    let currentSemitones = 0;
    let currentFactor = 1.0;
    let currentFormants = 0; // NEW: 0 = Off, 1 = On

    // ── Key Detection State ──
    const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

    // 🚀 UPGRADED: Bipartite "Diatonic Penalty" Profiles
    // Notes in the scale get positive points. Notes OUTSIDE the scale get -2.0 penalties.
    // This mathematically destroys "Imposter" keys like B Major when the song is actually in E Major.
    const MAJOR_PROFILE = [5.0, -2.0, 2.5, -2.0, 4.0, 2.0, -2.0, 4.5, -2.0, 3.0, -2.0, 3.0];
    const MINOR_PROFILE = [5.0, -2.0, 2.5, 4.0, -2.0, 2.0, -2.0, 4.5, 3.0, -2.0, 2.0, -2.0];

    // Triad Chord Profiles
    const MAJOR_TRIAD = [1.0, 0.0, 0.0, 0.0, 0.7, 0.0, 0.0, 0.8, 0.0, 0.0, 0.0, 0.0];
    const MINOR_TRIAD = [1.0, 0.0, 0.0, 0.7, 0.0, 0.0, 0.0, 0.8, 0.0, 0.0, 0.0, 0.0];

    let accumulatedChroma = new Float32Array(12);
    let smoothedChordChroma = new Float32Array(12); // 🚀 NEW: Moving Average filter for chords
    let chromaFrames = 0;

    let detectedKeyIndex = -1;
    let detectedMode = '';
    let keyHistory = [];

    let currentChordIndex = -1;
    let currentChordMode = '';
    let chordHistory = []; // 🚀 NEW: Voting system for chords

    function getCorrelation(profile, testProfile) {
        let pMean = profile.reduce((a, b) => a + b) / 12;
        let tMean = testProfile.reduce((a, b) => a + b) / 12;
        let num = 0, den1 = 0, den2 = 0;
        for (let i = 0; i < 12; i++) {
            let pDiff = profile[i] - pMean;
            let tDiff = testProfile[i] - tMean;
            num += pDiff * tDiff;
            den1 += pDiff * pDiff;
            den2 += tDiff * tDiff;
        }
        return (den1 === 0 || den2 === 0) ? 0 : num / Math.sqrt(den1 * den2);
    }

    function calculateChord(chroma) {
        let maxScore = -1;
        let bestChord = -1;
        let bestMode = '';

        for (let i = 0; i < 12; i++) {
            let shiftedChroma = [];
            for (let j = 0; j < 12; j++) shiftedChroma.push(chroma[(j + i) % 12]);

            let majScore = getCorrelation(MAJOR_TRIAD, shiftedChroma);
            let minScore = getCorrelation(MINOR_TRIAD, shiftedChroma);

            if (majScore > maxScore) { maxScore = majScore; bestChord = i; bestMode = 'maj'; }
            if (minScore > maxScore) { maxScore = minScore; bestChord = i; bestMode = 'min'; }
        }

        if (maxScore > 0.75) {
            chordHistory.push({ key: bestChord, mode: bestMode });
            // 🚀 UPGRADE: Hold 8 frames (~0.5 seconds) for rock-solid chords
            if (chordHistory.length > 8) chordHistory.shift();

            let counts = {};
            let topCount = 0;
            let topHash = '';

            for (let h of chordHistory) {
                let hash = h.key + '|' + h.mode;
                counts[hash] = (counts[hash] || 0) + 1;
                if (counts[hash] > topCount) { topCount = counts[hash]; topHash = hash; }
            }

            // Require 5 out of 8 frames to agree before changing the UI
            if (topCount >= 5) {
                let parts = topHash.split('|');
                let newKey = parseInt(parts[0]);
                let newMode = parts[1];

                if (currentChordIndex !== newKey || currentChordMode !== newMode) {
                    currentChordIndex = newKey;
                    currentChordMode = newMode;
                    broadcastState();
                }
            }
        }
    }

    function calculateKey(chroma) {
        let cleanChroma = new Float32Array(12);
        for (let i = 0; i < 12; i++) cleanChroma[i] = chroma[i];

        for (let i = 0; i < 12; i++) {
            let fifth = (i + 7) % 12;
            cleanChroma[fifth] -= chroma[i] * 0.5;
        }
        for (let i = 0; i < 12; i++) {
            if (cleanChroma[i] < 0) cleanChroma[i] = 0;
        }

        let maxScore = -1;
        let bestKey = -1;
        let bestMode = '';

        for (let i = 0; i < 12; i++) {
            let shiftedChroma = [];
            for (let j = 0; j < 12; j++) shiftedChroma.push(cleanChroma[(j + i) % 12]);

            let majScore = getCorrelation(MAJOR_PROFILE, shiftedChroma);
            let minScore = getCorrelation(MINOR_PROFILE, shiftedChroma);

            if (detectedKeyIndex === i) {
                if (detectedMode === 'Major') majScore += 0.20;
                if (detectedMode === 'Minor') minScore += 0.20;
            }

            if (majScore > maxScore) { maxScore = majScore; bestKey = i; bestMode = 'Major'; }
            if (minScore > maxScore) { maxScore = minScore; bestKey = i; bestMode = 'Minor'; }
        }

        // 🚀 THE FIX: Removed the `if (maxScore > 0.50)` threshold block!
        keyHistory.push({ key: bestKey, mode: bestMode });
        if (keyHistory.length > 10) keyHistory.shift();

        let counts = {};
        let topCount = 0;
        let topHash = '';

        for (let h of keyHistory) {
            let hash = h.key + '|' + h.mode;
            counts[hash] = (counts[hash] || 0) + 1;
            if (counts[hash] > topCount) { topCount = counts[hash]; topHash = hash; }
        }

        if (topCount >= 6) {
            let parts = topHash.split('|');
            let newKey = parseInt(parts[0]);
            let newMode = parts[1];

            if (detectedKeyIndex !== newKey || detectedMode !== newMode) {
                detectedKeyIndex = newKey;
                detectedMode = newMode;
                broadcastState();
            }
        }
    }

    const elementMap = new Map();
    const hookedSet = new WeakSet();
    const readyContexts = new WeakSet();
    let fallbackCtx = null;

    let toastTimer;
    function showToast() {
        let toast = document.getElementById('pitchshift-osd-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'pitchshift-osd-toast';

            // Upgraded UI: Pill-shape, soft shadow, better glassmorphism
            Object.assign(toast.style, {
                all: 'initial',
                position: 'fixed',
                bottom: '12%',
                left: '50%',
                transform: 'translateX(-50%)',
                backgroundColor: 'rgba(28, 28, 30, 0.85)',
                color: '#ffffff',
                padding: '14px 28px',
                borderRadius: '50px', // Sleek pill shape
                fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
                fontSize: '22px',
                fontWeight: '600',
                letterSpacing: '0.3px',
                boxShadow: '0 10px 30px rgba(0, 0, 0, 0.4)', // Adds depth
                zIndex: '2147483647',
                pointerEvents: 'none',
                transition: 'opacity 0.2s cubic-bezier(0.2, 0.8, 0.2, 1)', // Snappier fade
                opacity: '0',
                backdropFilter: 'blur(12px)',
                WebkitBackdropFilter: 'blur(12px)',
                whiteSpace: 'pre' // Keeps the spacing clean
            });
            document.body.appendChild(toast);
        }

        // ── Text Improvements ──
        let text = '';
        const sign = currentSemitones > 0 ? '+' : '';

        // 1. Always show Pitch Shift first
        let pitchText = currentSemitones === 0
            ? '🎵 Original Pitch'
            : `🎵 Pitch: ${sign}${Number(currentSemitones).toFixed(1)} st`;

        // 2. Add Key Data
        if (detectedKeyIndex === -1) {
            text = `${pitchText}   •   Analyzing Key...`;
        } else {
            const exactNote = detectedKeyIndex + currentSemitones;
            let nearestNoteIndex = Math.round(exactNote) % 12;
            if (nearestNoteIndex < 0) nearestNoteIndex += 12;

            const cents = Math.round((exactNote - Math.round(exactNote)) * 100);
            const noteName = NOTE_NAMES[nearestNoteIndex];

            let centsStr = '';
            if (cents > 0) centsStr = ` (+${cents}c)`;
            if (cents < 0) centsStr = ` (${cents}c)`;

            text = `${pitchText}   •   Key: ${noteName} ${detectedMode}${centsStr}`;
        }

        // 3. Add Formants
        if (currentFormants === 1) {
            text += '   •   🗣️ On';
        }

        toast.textContent = text;
        toast.style.opacity = '1';

        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
            toast.style.opacity = '0';
        }, 1500);
    }

    async function ensureWorklet(ctx) {
        if (readyContexts.has(ctx)) return;

        const processorUrl = document.documentElement.dataset.processorUrl;

        if (!processorUrl) {
            console.error('[PitchShift] Processor URL not found! Make sure content.js is injecting it.');
            return;
        }

        try {
            await ctx.audioWorklet.addModule(processorUrl);
            readyContexts.add(ctx);
        } catch (err) {
            console.error('[PitchShift] Failed to load secure worklet:', err);
        }
    }

    function applyPitch(semitones, formants = currentFormants) {
        let parsedSemitones = parseFloat(semitones);
        if (isNaN(parsedSemitones)) parsedSemitones = 0;

        currentSemitones = parsedSemitones;
        currentFormants = formants;
        currentFactor = Math.pow(2, parsedSemitones / 12);

        for (const [el, shifter] of elementMap) {
            try {
                if (shifter && shifter.parameters) {
                    const pitchParam = shifter.parameters.get('pitchFactor');
                    const formantParam = shifter.parameters.get('preserveFormants');

                    if (formantParam) formantParam.value = currentFormants;

                    if (pitchParam) {
                        if (shifter.context.state === 'suspended') {
                            pitchParam.value = currentFactor;
                        } else {
                            pitchParam.setTargetAtTime(currentFactor, shifter.context.currentTime, 0.05);
                        }
                    }
                }
            } catch (err) {
                elementMap.delete(el);
            }
        }
    }

    let broadcastTimer;
    function broadcastState() {
        clearTimeout(broadcastTimer);
        broadcastTimer = setTimeout(() => {
            document.dispatchEvent(new CustomEvent('__pitchshift:state', {
                detail: {
                    hookedCount: elementMap.size,
                    semitones: currentSemitones,
                    formants: currentFormants,
                    baseKey: detectedKeyIndex,
                    baseMode: detectedMode,
                    chordKey: currentChordIndex, // 🚀 NEW
                    chordMode: currentChordMode  // 🚀 NEW
                },
            }));
        }, 150);
    }

    // ── Keyboard Shortcuts (Alt + Minus/Equal) ──
    window.addEventListener('keydown', (e) => {
        // Require Alt (Option on Mac) to be held down
        if (e.altKey) {
            let newPitch = currentSemitones;
            let newFormants = currentFormants;
            const isFineTuning = e.shiftKey; // Shift modifies it to 0.1 steps

            // We use e.code to grab the physical key location
            if (e.code === 'Equal') { // The '+' / '=' key
                newPitch += isFineTuning ? 0.1 : 1.0;
            } else if (e.code === 'Minus') { // The '-' / '_' key
                newPitch -= isFineTuning ? 0.1 : 1.0;
            } else if (e.code === 'Digit0' || e.code === 'Numpad0') {
                newPitch = 0; // Reset to original
            } else if (e.code === 'KeyP') {
                newFormants = currentFormants === 0 ? 1 : 0; // P for Preserve Formants
            } else {
                return; // Not our keys, let the browser handle it
            }

            e.preventDefault(); // Stop the browser from doing anything else

            newPitch = Math.max(-12, Math.min(12, newPitch));
            newPitch = Math.round(newPitch * 10) / 10;

            applyPitch(newPitch, newFormants);
            showToast();

            document.dispatchEvent(new CustomEvent('__pitchshift:save', {
                detail: { semitones: newPitch, formants: newFormants }
            }));
        }
    });

    document.addEventListener('__pitchshift:set', (e) => {
        const newFormants = e.detail.formants !== undefined ? e.detail.formants : currentFormants;
        applyPitch(e.detail.semitones, newFormants);
        broadcastState();
    });

    document.addEventListener('__pitchshift:getstate', () => {
        // 🚀 THE FIX: A 10ms micro-delay. 
        // This bypasses Chrome's security bug, allowing the CustomEvent 
        // to safely cross from the Main World back to the Isolated World!
        setTimeout(() => {
            document.dispatchEvent(new CustomEvent('__pitchshift:state', {
                detail: {
                    hookedCount: elementMap.size,
                    semitones: currentSemitones,
                    formants: currentFormants,
                    baseKey: detectedKeyIndex,
                    baseMode: detectedMode,
                    chordKey: currentChordIndex,
                    chordMode: currentChordMode
                },
            }));
        }, 10);
    });

    const resumeContexts = () => {
        if (fallbackCtx && fallbackCtx.state === 'suspended') {
            fallbackCtx.resume().catch(() => { }); // 🚀 Catch and ignore browser blocks
        }
        for (const [, shifter] of elementMap) {
            if (shifter.context && shifter.context.state === 'suspended') {
                shifter.context.resume().catch(() => { }); // 🚀 Catch and ignore browser blocks
            }
        }
    };

    window.addEventListener('mousedown', resumeContexts, true);
    window.addEventListener('touchstart', resumeContexts, true);
    window.addEventListener('keydown', resumeContexts, true);
    window.addEventListener('play', resumeContexts, true);

    const NativeAudioContext = window.AudioContext || window.webkitAudioContext;
    // ── 1. The Native Hook (Prioritizing Stability) ──
    if (NativeAudioContext) {
        const origCreateMediaElementSource = NativeAudioContext.prototype.createMediaElementSource;

        NativeAudioContext.prototype.createMediaElementSource = function (mediaElement) {
            if (this.state === 'closed') return origCreateMediaElementSource.call(this, mediaElement);

            // Mark and track
            mediaElement.__isNativeHooked = true;
            hookedSet.add(mediaElement);

            let sourceNode;
            try {
                sourceNode = origCreateMediaElementSource.call(this, mediaElement);
            } catch (err) {
                return this.createGain();
            }

            const proxyNode = this.createGain();
            const origConnect = sourceNode.connect;
            const origDisconnect = sourceNode.disconnect;

            origConnect.call(sourceNode, proxyNode);

            sourceNode.connect = function (...args) { return proxyNode.connect(...args); };
            sourceNode.disconnect = function (...args) { proxyNode.disconnect(...args); };

            ensureWorklet(this).then(() => {
                const shifter = new AudioWorkletNode(this, 'pitch-shifter', {
                    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
                });

                // Attach message listener for Key Detection
                shifter.port.onmessage = (e) => {
                    if (e.data.type === 'chroma') {
                        // 🚀 NEW: Exponential Moving Average to smooth out "filler" passing notes
                        for (let i = 0; i < 12; i++) {
                            smoothedChordChroma[i] = (smoothedChordChroma[i] * 0.6) + (e.data.data[i] * 0.4);
                        }

                        // 1. Live Chord Detection using the smoothed data
                        calculateChord(smoothedChordChroma);

                        // 2. Global Key Detection
                        for (let i = 0; i < 12; i++) accumulatedChroma[i] += e.data.data[i];
                        chromaFrames++;
                        if (chromaFrames > 15) {
                            calculateKey(accumulatedChroma);
                            for (let i = 0; i < 12; i++) accumulatedChroma[i] *= 0.85;
                            chromaFrames = 0;
                        }
                    }
                };

                const param = shifter.parameters.get('pitchFactor');
                if (param) param.value = currentFactor;

                elementMap.set(mediaElement, shifter);

                origDisconnect.call(sourceNode);
                origConnect.call(sourceNode, shifter);
                shifter.connect(proxyNode);
                broadcastState();
            }).catch(err => console.error('[PitchShift] Worklet Fail:', err));

            return sourceNode;
        };
    }

    async function hookElement(el) {
        if (!(el instanceof HTMLMediaElement)) return;
        if (el.__isNativeHooked || hookedSet.has(el)) return;

        // 🚀 NEW: Crucial for Spotify/Cross-domain audio
        if (!el.crossOrigin) {
            el.crossOrigin = "anonymous";
        }
        hookedSet.add(el);

        try {
            if (!fallbackCtx) {
                fallbackCtx = new (window.AudioContext || window.webkitAudioContext)();
            }

            await ensureWorklet(fallbackCtx);

            // Final check: did Spotify hook it while we were waiting for the worklet?
            if (el.__isNativeHooked) return;

            const source = fallbackCtx.createMediaElementSource(el);
            const shifter = new AudioWorkletNode(fallbackCtx, 'pitch-shifter', {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [2],
            });
            shifter.port.onmessage = (e) => {
                if (e.data.type === 'chroma') {
                    // 🚀 NEW: Exponential Moving Average to smooth out "filler" passing notes
                    for (let i = 0; i < 12; i++) {
                        smoothedChordChroma[i] = (smoothedChordChroma[i] * 0.6) + (e.data.data[i] * 0.4);
                    }

                    // 1. Live Chord Detection using the smoothed data
                    calculateChord(smoothedChordChroma);

                    // 2. Global Key Detection
                    for (let i = 0; i < 12; i++) accumulatedChroma[i] += e.data.data[i];
                    chromaFrames++;
                    if (chromaFrames > 15) {
                        calculateKey(accumulatedChroma);
                        for (let i = 0; i < 12; i++) accumulatedChroma[i] *= 0.85;
                        chromaFrames = 0;
                    }
                }
            };

            const param = shifter.parameters.get('pitchFactor');
            if (param) param.value = currentFactor;

            source.connect(shifter);
            shifter.connect(fallbackCtx.destination);
            elementMap.set(el, shifter);
            broadcastState();

        } catch (err) {
            if (!err.message || !err.message.includes('already connected')) {
                hookedSet.delete(el);
            }
        }
    }

    const nativePlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
        if (!hookedSet.has(this)) setTimeout(() => hookElement(this), 500);
        return nativePlay.call(this);
    };

    function scanForMedia(root) {
        if (!root) return;

        // 1. Find all potential audio/video tags
        const elements = root.querySelectorAll ? root.querySelectorAll('video, audio') : [];

        elements.forEach(el => {
            // Only attempt to hook if:
            // - It's not already hooked
            // - It hasn't been claimed by Spotify's native AudioContext
            // - It actually has audio data (src)
            if (!hookedSet.has(el) && !el.__isNativeHooked) {
                if (el.src || el.srcObject || el.querySelector('source')) {
                    hookElement(el);
                }
            }
        });

        // 2. Handle Shadow DOM (for sites like YouTube)
        if (root.shadowRoot) {
            scanForMedia(root.shadowRoot);
        }

        // 3. Recursive check for custom components
        const children = root.children;
        if (children) {
            for (let i = 0; i < children.length; i++) {
                if (children[i].shadowRoot) scanForMedia(children[i].shadowRoot);
            }
        }
    }

    const lastTimeMap = new Map();
    const disconnectionTimes = new Map(); // ⬅️ The missing variable!

    setInterval(() => {
        const now = Date.now();

        for (const [el, shifter] of elementMap) {
            // Check if the audio is actually "alive" (heartbeat check)
            const isPlaying = !el.paused && !el.ended && el.currentTime > 0;

            // Check for progress
            const lastTime = lastTimeMap.get(el) || 0;
            const isMoving = el.currentTime !== lastTime;
            if (isPlaying) lastTimeMap.set(el, el.currentTime);

            if (!el.isConnected) {
                // 🚀 THE ZOMBIE CHECK:
                // If it's disconnected from DOM but STILL playing music, 
                // DO NOT PRUNE. Spotify does this during track transitions.
                if (isPlaying && isMoving) {
                    continue;
                }

                if (!disconnectionTimes.has(el)) {
                    disconnectionTimes.set(el, now);
                }

                // Only prune if it's disconnected AND silent/paused for > 10 seconds
                if (now - disconnectionTimes.get(el) > 10000) {
                    console.info('[PitchShift] Pruning truly dead element.');
                    try { shifter.disconnect(); } catch (e) { }
                    elementMap.delete(el);
                    hookedSet.delete(el);
                    disconnectionTimes.delete(el);
                    lastTimeMap.delete(el);
                }
            } else {
                disconnectionTimes.delete(el);
            }
        }

        scanForMedia(document.body);
    }, 3000);

    scanForMedia(document.body);

    console.info('[PitchShift] MAIN world ready.');
})();