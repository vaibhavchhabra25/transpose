// content/injected.js  —  world: "MAIN"
// Runs in the PAGE's own JS context before any site scripts.

(function () {
    'use strict';
    if (window.__pitchShiftInjected) return;
    window.__pitchShiftInjected = true;

    const PROCESSOR_CODE = `
function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wBR = Math.cos(ang), wBI = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wR = 1, wI = 0;
      for (let j = 0; j < len / 2; j++) {
        const uR = re[i+j], uI = im[i+j];
        const vR = re[i+j+len/2]*wR - im[i+j+len/2]*wI;
        const vI = re[i+j+len/2]*wI + im[i+j+len/2]*wR;
        re[i+j] = uR+vR; im[i+j] = uI+vI;
        re[i+j+len/2] = uR-vR; im[i+j+len/2] = uI-vI;
        const nR = wR*wBR - wI*wBI; wI = wR*wBI + wI*wBR; wR = nR;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
function wrapPhase(p) {
  while (p >  Math.PI) p -= 2*Math.PI;
  while (p < -Math.PI) p += 2*Math.PI;
  return p;
}
function hannWindow(size) {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5*(1-Math.cos(2*Math.PI*i/size));
  return w;
}
function createChannelState(F, H) {
  return {
    inputRing: new Float32Array(F), inputPos: 0, samplesUntilHop: H,
    outputRing: new Float32Array(F*4), outputReadPos: 0, outputWritePos: F,
    lastInputPhase: new Float32Array(F), lastOutputPhase: new Float32Array(F),
    re: new Float32Array(F), im: new Float32Array(F),
    oR: new Float32Array(F), oI: new Float32Array(F) 
  };
}
function processFrame(s, F, H, win, pf) {
  const { re, im, inputRing, inputPos, lastInputPhase, lastOutputPhase, outputRing, oR, oI } = s;
  const half = F >> 1;
  for (let i = 0; i < F; i++) {
    re[i] = inputRing[(inputPos - F + i + F*4) % F] * win[i]; im[i] = 0;
    oR[i] = 0; oI[i] = 0; 
  }
  fft(re, im, false);
  for (let k = 0; k <= half; k++) {
    const mag = Math.sqrt(re[k]*re[k]+im[k]*im[k]);
    const phase = Math.atan2(im[k], re[k]);
    const expAdv = 2*Math.PI*k*H/F;
    const trueFreq = expAdv + wrapPhase(phase - lastInputPhase[k] - expAdv);
    lastInputPhase[k] = phase;
    const tk = Math.round(k*pf);
    if (tk >= 0 && tk <= half) {
      lastOutputPhase[tk] += trueFreq*pf;
      oR[tk] += mag*Math.cos(lastOutputPhase[tk]);
      oI[tk] += mag*Math.sin(lastOutputPhase[tk]);
      if (tk > 0 && tk < half) { oR[F-tk] = oR[tk]; oI[F-tk] = -oI[tk]; }
    }
  }
  fft(oR, oI, true);
  const scale = (F/H)/2, rLen = outputRing.length, ws = s.outputWritePos;
  for (let i = 0; i < F; i++) outputRing[(ws+i)%rLen] += (oR[i]*win[i])/scale;
  s.outputWritePos = (ws+H)%rLen;
}

class PitchShifterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name:'pitchFactor', defaultValue:1, minValue:0.25, maxValue:4, automationRate:'k-rate' }];
  }
  constructor() {
    super();
    this.F = 2048; 
    this.H = 512;
    this.win = hannWindow(this.F); this.ch = [];
  }
  process(inputs, outputs, params) {
    if (!inputs || !outputs) return true;
    const inp = inputs[0];
    const out = outputs[0];
    if (!inp || !out || inp.length === 0 || out.length === 0) return true;
    
    let pf = 1.0;
    if (params && params.pitchFactor && params.pitchFactor.length > 0) pf = params.pitchFactor[0];

    while (this.ch.length < inp.length) this.ch.push(createChannelState(this.F, this.H));

    for (let c = 0; c < inp.length; c++) {
      const id = inp[c], od = out[c];
      if (!id || !od) continue;
      
      const st = this.ch[c];
      const rLen = st.outputRing.length;

      for (let i = 0; i < id.length; i++) {
        st.inputRing[st.inputPos % this.F] = id[i];
        st.inputPos = (st.inputPos+1) % this.F;
        
        if (pf === 1.0) {
          od[i] = id[i];
          if (--st.samplesUntilHop <= 0) st.samplesUntilHop = this.H;
          st.outputRing[st.outputReadPos] = 0;
          st.outputReadPos = (st.outputReadPos+1) % rLen;
          st.outputWritePos = (st.outputReadPos + this.F) % rLen; 
        } else {
          if (--st.samplesUntilHop <= 0) {
            st.samplesUntilHop = this.H;
            processFrame(st, this.F, this.H, this.win, pf);
          }
          od[i] = st.outputRing[st.outputReadPos];
          st.outputRing[st.outputReadPos] = 0;
          st.outputReadPos = (st.outputReadPos+1) % rLen;
        }
      }
    }
    return true;
  }
}
registerProcessor('pitch-shifter', PitchShifterProcessor);
`;

    let currentSemitones = 0;
    let currentFactor = 1.0;
    const elementMap = new Map();
    const hookedSet = new WeakSet();
    const readyContexts = new WeakSet();
    let fallbackCtx = null;

    async function ensureWorklet(ctx) {
        if (readyContexts.has(ctx)) return;
        const blob = new Blob([PROCESSOR_CODE], { type: 'application/javascript' });
        const blobUrl = URL.createObjectURL(blob);
        await ctx.audioWorklet.addModule(blobUrl);
        URL.revokeObjectURL(blobUrl);
        readyContexts.add(ctx);
    }

    function applyPitch(semitones) {
        let parsedSemitones = parseFloat(semitones);
        if (isNaN(parsedSemitones)) parsedSemitones = 0;

        currentSemitones = parsedSemitones; // Keep local state updated
        currentFactor = Math.pow(2, parsedSemitones / 12);

        for (const [el, shifter] of elementMap) {
            try {
                if (shifter && shifter.parameters && shifter.parameters.has('pitchFactor')) {
                    const param = shifter.parameters.get('pitchFactor');

                    // THE YOUTUBE CLOCK FIX:
                    // If suspended, time is frozen. Do not use setTargetAtTime.
                    if (shifter.context.state === 'suspended') {
                        param.value = currentFactor;
                    } else {
                        param.setTargetAtTime(currentFactor, shifter.context.currentTime, 0.05);
                    }
                }
            } catch (err) {
                console.warn('[PitchShift] Pruning dead element');
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
    // Wake up on any click or keypress
    window.addEventListener('click', resumeContexts, true);
    window.addEventListener('keydown', resumeContexts, true);
    window.addEventListener('play', resumeContexts, true);


    // ── Intercept 1: The AudioContext Proxy (Spotify / SoundCloud) ──
    const NativeAudioContext = window.AudioContext || window.webkitAudioContext;
    if (NativeAudioContext) {
        const origCreateMediaElementSource = NativeAudioContext.prototype.createMediaElementSource;

        NativeAudioContext.prototype.createMediaElementSource = function (mediaElement) {
            if (this.state === 'closed') return origCreateMediaElementSource.call(this, mediaElement);

            console.info("[PitchShift] Intercepting website's AudioContext");
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

                console.info('[PitchShift] Successfully injected into website audio graph!');
                broadcastState();
            }).catch(err => {
                console.warn('[PitchShift] Failed to load worklet:', err);
            });

            return sourceNode;
        };
    }

    // ── Intercept 2: Fallback (YouTube / Standard Media) ──
    async function hookElement(el) {
        if (!(el instanceof HTMLMediaElement)) return;
        if (hookedSet.has(el)) return;
        hookedSet.add(el);

        try {
            if (!fallbackCtx) {
                fallbackCtx = new (window.AudioContext || window.webkitAudioContext)();
            }

            if (fallbackCtx.state === 'suspended') {
                await fallbackCtx.resume();
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
            console.info('[PitchShift] Hooked element via fallback context.');
        } catch (err) {
            // Fails silently if it was already hooked by the website
        }
    }

    const nativePlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
        if (!hookedSet.has(this)) setTimeout(() => hookElement(this), 500);
        return nativePlay.call(this);
    };

    // ── Intercept 3: Gentle SPA Scanner ──
    setInterval(() => {
        document.querySelectorAll('video, audio').forEach(el => {
            if (!hookedSet.has(el)) hookElement(el);
        });
    }, 1000);

    document.querySelectorAll('video, audio').forEach(el => hookElement(el));

    console.info('[PitchShift] MAIN world ready.');
})();