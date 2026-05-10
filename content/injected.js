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
        let toast = document.getElementById('pitchshift-osd-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'pitchshift-osd-toast';

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
                zIndex: '2147483647',
                pointerEvents: 'none',
                transition: 'opacity 0.2s ease-in-out',
                opacity: '0',
                backdropFilter: 'blur(4px)'
            });
            document.body.appendChild(toast);
        }

        // Format to 1 decimal place for the Toast UI
        const sign = semitones > 0 ? '+' : '';
        toast.textContent = `Pitch: ${sign}${Number(semitones).toFixed(1)} st`;
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

    // ── Keyboard Shortcuts (Alt + Shift + Up/Down/Left/Right/0) ──
    window.addEventListener('keydown', (e) => {
        if (e.altKey && e.shiftKey) {
            let newPitch = currentSemitones;

            if (e.key === 'ArrowUp') {
                newPitch += 1;
            } else if (e.key === 'ArrowDown') {
                newPitch -= 1;
            } else if (e.key === 'ArrowRight') {
                newPitch += 0.1; // Fine tune UP
            } else if (e.key === 'ArrowLeft') {
                newPitch -= 0.1; // Fine tune DOWN
            } else if (e.key === '0') {
                newPitch = 0;
            } else {
                return;
            }
            e.preventDefault();

            // Clamp between -12 and 12, and fix floating point precision
            newPitch = Math.max(-12, Math.min(12, newPitch));
            newPitch = Math.round(newPitch * 10) / 10;

            applyPitch(newPitch);
            showToast(newPitch);

            document.dispatchEvent(new CustomEvent('__pitchshift:save', {
                detail: { semitones: newPitch }
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

    const resumeContexts = () => {
        if (fallbackCtx && fallbackCtx.state === 'suspended') fallbackCtx.resume();
        for (const [, shifter] of elementMap) {
            if (shifter.context && shifter.context.state === 'suspended') {
                shifter.context.resume();
            }
        }
    };
    
    window.addEventListener('mousedown', resumeContexts, true);
    window.addEventListener('touchstart', resumeContexts, true);
    window.addEventListener('keydown', resumeContexts, true);
    window.addEventListener('play', resumeContexts, true);

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

    async function hookElement(el) {
        if (!(el instanceof HTMLMediaElement)) return;
        if (hookedSet.has(el)) return;
        hookedSet.add(el);

        try {
            if (!fallbackCtx) {
                fallbackCtx = new (window.AudioContext || window.webkitAudioContext)();
            }

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

        if (root instanceof HTMLMediaElement && !hookedSet.has(root)) {
            hookElement(root);
        }

        if (root.querySelectorAll) {
            root.querySelectorAll('video, audio').forEach(el => {
                if (!hookedSet.has(el)) hookElement(el);
            });
        }

        if (root.shadowRoot) {
            scanForMedia(root.shadowRoot);
        }

        const children = root.children;
        if (children) {
            for (let i = 0; i < children.length; i++) {
                if (children[i].shadowRoot) {
                    scanForMedia(children[i].shadowRoot);
                }
            }
        }
    }

    setInterval(() => {
        scanForMedia(document.body);
    }, 1000);

    scanForMedia(document.body);

    console.info('[PitchShift] MAIN world ready.');
})();