// content/injected.js  —  world: "MAIN"
// Runs in the PAGE's own JS context before any site scripts.

(function () {
    'use strict';
    if (window.__pitchShiftInjected) return;
    window.__pitchShiftInjected = true;

    let currentSemitones = 0;
    let currentFactor = 1.0;
    const elementMap = new Map();
    const hookedSet = new WeakSet();
    const readyContexts = new WeakSet();
    let fallbackCtx = null;

    let toastTimer;
    function showToast(semitones) {
        // 1. Find or create the toast element
        let toast = document.getElementById('pitchshift-osd-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'pitchshift-osd-toast';

            // 2. Apply bulletproof inline styles so it looks good on ALL websites
            Object.assign(toast.style, {
                position: 'fixed',
                bottom: '15%',
                left: '50%',
                transform: 'translateX(-50%)',
                backgroundColor: 'rgba(0, 0, 0, 0.85)',
                color: '#ffffff',
                padding: '12px 24px',
                borderRadius: '12px',
                fontFamily: 'system-ui, -apple-system, sans-serif',
                fontSize: '28px',
                fontWeight: 'bold',
                zIndex: '2147483647', // Maximum possible z-index in CSS
                pointerEvents: 'none', // Lets clicks pass through it
                transition: 'opacity 0.2s ease-in-out',
                opacity: '0',
                backdropFilter: 'blur(4px)'
            });
            document.body.appendChild(toast);
        }

        // 3. Format the text (e.g., "+2 st", "-1 st", "0 st")
        const sign = semitones > 0 ? '+' : '';
        toast.textContent = `Pitch: ${sign}${semitones} st`;
        toast.style.opacity = '1';

        // 4. Reset the fade-out timer every time the user presses a key
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
            toast.style.opacity = '0';
        }, 1500);
    }

    async function ensureWorklet(ctx) {
        if (readyContexts.has(ctx)) return;

        // Fetch the trusted, CSP-compliant extension URL
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

    function applyPitch(semitones) {
        let parsedSemitones = parseFloat(semitones);
        if (isNaN(parsedSemitones)) parsedSemitones = 0;

        currentSemitones = parsedSemitones;
        currentFactor = Math.pow(2, parsedSemitones / 12);

        for (const [el, shifter] of elementMap) {
            try {
                if (shifter && shifter.parameters && shifter.parameters.has('pitchFactor')) {
                    const param = shifter.parameters.get('pitchFactor');
                    if (shifter.context.state === 'suspended') {
                        param.value = currentFactor;
                    } else {
                        param.setTargetAtTime(currentFactor, shifter.context.currentTime, 0.05);
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
                detail: { hookedCount: elementMap.size },
            }));
        }, 150);
    }

    // ── Keyboard Shortcuts (Alt + Shift + Up/Down/0) ──
    window.addEventListener('keydown', (e) => {
        if (e.altKey && e.shiftKey) {
            if (e.key === 'ArrowUp') {
                applyPitch(Math.min(12, currentSemitones + 1));
            } else if (e.key === 'ArrowDown') {
                applyPitch(Math.max(-12, currentSemitones - 1));
            } else if (e.key === '0') {
                applyPitch(0);
            } else {
                return;
            }
            e.preventDefault();

            // --> TRIGGER THE VISUAL INDICATOR HERE <--
            showToast(currentSemitones);

            // Tell content.js to save this value so the popup UI updates
            document.dispatchEvent(new CustomEvent('__pitchshift:save', {
                detail: { semitones: currentSemitones }
            }));
        }
    });

    document.addEventListener('__pitchshift:set', (e) => {
        applyPitch(e.detail.semitones);
        broadcastState();
    });

    document.addEventListener('__pitchshift:getstate', () => {
        broadcastState();
    });

    // ── Global Wake-Up Event for YouTube Autoplay Policies ──
    const resumeContexts = () => {
        if (fallbackCtx && fallbackCtx.state === 'suspended') fallbackCtx.resume();
        for (const [, shifter] of elementMap) {
            if (shifter.context && shifter.context.state === 'suspended') {
                shifter.context.resume();
            }
        }
    };
    // Wake up on mousedown/touchstart as well (fires faster than click)
    window.addEventListener('mousedown', resumeContexts, true);
    window.addEventListener('touchstart', resumeContexts, true);
    window.addEventListener('keydown', resumeContexts, true);
    window.addEventListener('play', resumeContexts, true);

    // ── Intercept 1: The AudioContext Proxy (Spotify / SoundCloud) ──
    const NativeAudioContext = window.AudioContext || window.webkitAudioContext;
    if (NativeAudioContext) {
        const origCreateMediaElementSource = NativeAudioContext.prototype.createMediaElementSource;

        NativeAudioContext.prototype.createMediaElementSource = function (mediaElement) {
            if (this.state === 'closed') return origCreateMediaElementSource.call(this, mediaElement);

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

            sourceNode.connect = function (...args) {
                return proxyNode.connect(...args);
            };
            sourceNode.disconnect = function (...args) {
                proxyNode.disconnect(...args);
            };

            ensureWorklet(this).then(() => {
                const shifter = new AudioWorkletNode(this, 'pitch-shifter', {
                    numberOfInputs: 1,
                    numberOfOutputs: 1,
                    outputChannelCount: [2],
                });

                const param = shifter.parameters.get('pitchFactor');
                if (param) {
                    if (this.state === 'suspended') param.value = currentFactor;
                    else param.setTargetAtTime(currentFactor, this.currentTime, 0.05);
                }

                elementMap.set(mediaElement, shifter);

                origDisconnect.call(sourceNode);
                origConnect.call(sourceNode, shifter);
                shifter.connect(proxyNode);
                broadcastState();
            }).catch(err => console.warn(err));

            return sourceNode;
        };
    }

    // ── Intercept 2: Fallback (YouTube / YouTube Music) ──
    async function hookElement(el) {
        if (!(el instanceof HTMLMediaElement)) return;
        if (hookedSet.has(el)) return;
        hookedSet.add(el);

        try {
            if (!fallbackCtx) {
                fallbackCtx = new (window.AudioContext || window.webkitAudioContext)();
            }

            // REMOVED THE DEADLOCK HERE! We no longer await .resume(). 
            // We just let the graph build, and the global click/key listeners will wake it up naturally.
            await ensureWorklet(fallbackCtx);

            const source = fallbackCtx.createMediaElementSource(el);
            const shifter = new AudioWorkletNode(fallbackCtx, 'pitch-shifter', {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [2],
            });

            const param = shifter.parameters.get('pitchFactor');
            if (param) param.value = currentFactor;

            source.connect(shifter);
            shifter.connect(fallbackCtx.destination);
            elementMap.set(el, shifter);
            broadcastState();

        } catch (err) {
            // THE FIX: If it failed because it wasn't ready, remove it from the set so we can retry!
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

    // ── Intercept 3: Gentle SPA Scanner ──
    function scanForMedia(root) {
        if (!root) return;

        // 1. Check the node itself
        if (root instanceof HTMLMediaElement && !hookedSet.has(root)) {
            hookElement(root);
        }

        // 2. Query inside the normal DOM
        if (root.querySelectorAll) {
            root.querySelectorAll('video, audio').forEach(el => {
                if (!hookedSet.has(el)) hookElement(el);
            });
        }

        // 3. Drill down into Web Components (Shadow DOM) - CRITICAL FOR YOUTUBE
        if (root.shadowRoot) {
            scanForMedia(root.shadowRoot);
        }

        // 4. Recursively check all children for nested Shadow DOMs
        const children = root.children;
        if (children) {
            for (let i = 0; i < children.length; i++) {
                if (children[i].shadowRoot) {
                    scanForMedia(children[i].shadowRoot);
                }
            }
        }
    }

    // Scan every second. Uses negligible CPU because it only processes elements once.
    setInterval(() => {
        scanForMedia(document.body);
    }, 1000);

    // Initial scan on load
    scanForMedia(document.body);

    console.info('[PitchShift] MAIN world ready.');
})();