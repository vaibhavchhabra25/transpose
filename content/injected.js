// content/injected.js  —  world: "MAIN"
// Runs in the PAGE's own JS context before any site scripts.
// Owns the entire audio pipeline so we never need to pass DOM element
// references across JS worlds (structured-clone drops them silently).

(function () {
  'use strict';
  if (window.__pitchShiftInjected) return;
  window.__pitchShiftInjected = true;

  // ── Processor code embedded as a string → loaded via Blob URL ─────────────
  // This avoids chrome-extension:// CSP issues on strict sites like SoundCloud.

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
  };
}
function processFrame(s, F, H, win, pf) {
  const { re, im, inputRing, inputPos, lastInputPhase, lastOutputPhase, outputRing } = s;
  const half = F >> 1;
  for (let i = 0; i < F; i++) {
    re[i] = inputRing[(inputPos - F + i + F*4) % F] * win[i]; im[i] = 0;
  }
  fft(re, im, false);
  const oR = new Float32Array(F), oI = new Float32Array(F);
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
    this.F = 2048; this.H = 512;
    this.win = hannWindow(this.F); this.ch = [];
  }
  process(inputs, outputs, params) {
    const inp = inputs[0], out = outputs[0];
    if (!inp?.length || !out?.length) return true;
    const pf = params.pitchFactor[0] ?? 1;
    while (this.ch.length < inp.length) this.ch.push(createChannelState(this.F, this.H));
    for (let c = 0; c < inp.length; c++) {
      const id = inp[c], od = out[c], st = this.ch[c], rLen = st.outputRing.length;
      for (let i = 0; i < id.length; i++) {
        st.inputRing[st.inputPos % this.F] = id[i];
        st.inputPos = (st.inputPos+1) % this.F;
        if (--st.samplesUntilHop <= 0) {
          st.samplesUntilHop = this.H;
          if (pf !== 1) {
            processFrame(st, this.F, this.H, this.win, pf);
          } else {
            const n = this.F, ws = st.outputWritePos;
            for (let j = 0; j < n; j++) {
              const v = st.inputRing[(st.inputPos-n+j+n*4)%n];
              st.outputRing[(ws+j)%rLen] += v*st.win[j]/((n/this.H)/2);
            }
            st.outputWritePos = (ws+this.H)%rLen;
          }
        }
        od[i] = st.outputRing[st.outputReadPos];
        st.outputRing[st.outputReadPos] = 0;
        st.outputReadPos = (st.outputReadPos+1) % rLen;
      }
    }
    return true;
  }
}
registerProcessor('pitch-shifter', PitchShifterProcessor);
`;

  // ── Audio state (all in MAIN world, no cross-world transfers needed) ───────

  let audioCtx = null;
  let workletReady = false;
  let currentFactor = 1.0;

  // Map<HTMLMediaElement, AudioWorkletNode> — iterable for pitch updates
  const elementMap = new Map();
  // WeakSet for O(1) "already hooked?" check
  const hookedSet = new WeakSet();
  // WeakSet for elements created before src was set
  const pendingSet = new WeakSet();

  // ── AudioContext + worklet ────────────────────────────────────────────────

  async function getCtx() {
    if (audioCtx) return audioCtx;
    audioCtx = new AudioContext();
    return audioCtx;
  }

  async function ensureWorklet(ctx) {
    if (workletReady) return;
    const blob = new Blob([PROCESSOR_CODE], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    await ctx.audioWorklet.addModule(blobUrl);
    URL.revokeObjectURL(blobUrl);
    workletReady = true;
  }

  // ── Hook one element ──────────────────────────────────────────────────────

  async function hookElement(el) {
    if (!(el instanceof HTMLMediaElement)) return;
    if (hookedSet.has(el)) return;

    const hasSrc = !!(el.src || el.currentSrc);
    const isReady = el.readyState >= 1;
    if (!hasSrc && !isReady) {
      pendingSet.add(el);
      return;
    }

    hookedSet.add(el); // claim before any await to prevent races

    try {
      const ctx = await getCtx();
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
      await ensureWorklet(ctx);

      const source = ctx.createMediaElementSource(el);
      const shifter = new AudioWorkletNode(ctx, 'pitch-shifter', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      shifter.parameters.get('pitchFactor').value = currentFactor;
      source.connect(shifter);
      shifter.connect(ctx.destination);
      elementMap.set(el, shifter);

      console.info('[PitchShift] Hooked', el.tagName, el.src || el.currentSrc || '(MSE)');
      broadcastState();
    } catch (err) {
      hookedSet.delete(el);
      console.warn('[PitchShift] Hook failed:', err.message);
    }
  }

  function retryAll() {
    document.querySelectorAll('audio, video').forEach(el => {
      if (!hookedSet.has(el)) hookElement(el);
    });
  }

  // ── Pitch update ─────────────────────────────────────────────────────────

  function applyPitch(semitones) {
    currentFactor = Math.pow(2, semitones / 12);
    for (const [, shifter] of elementMap) {
      shifter.parameters.get('pitchFactor').value = currentFactor;
    }
  }

  // ── Talk back to content.js via CustomEvent (plain data only) ─────────────

  function broadcastState() {
    document.dispatchEvent(new CustomEvent('__pitchshift:state', {
      detail: { hookedCount: elementMap.size },
    }));
  }

  // ── Listen for commands from content.js ───────────────────────────────────

  document.addEventListener('__pitchshift:set', (e) => {
    applyPitch(e.detail.semitones);
    retryAll();
    broadcastState();
  });

  document.addEventListener('__pitchshift:getstate', () => {
    broadcastState();
  });

  // ── Intercept 1: new Audio() ──────────────────────────────────────────────
  const NativeAudio = window.Audio;
  function PatchedAudio(...args) {
    const el = new NativeAudio(...args);
    hookElement(el);
    return el;
  }
  PatchedAudio.prototype = NativeAudio.prototype;
  Object.setPrototypeOf(PatchedAudio, NativeAudio);
  window.Audio = PatchedAudio;

  // ── Intercept 2: document.createElement('audio'/'video') ─────────────────
  const nativeCreate = Document.prototype.createElement;
  Document.prototype.createElement = function (tag, opts) {
    const el = nativeCreate.call(this, tag, opts);
    if (typeof tag === 'string') {
      const t = tag.toLowerCase();
      if (t === 'audio' || t === 'video') hookElement(el);
    }
    return el;
  };

  // ── Intercept 3: element.src = '...' (SoundCloud sets src post-creation) ──
  const srcDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
  if (srcDesc?.set) {
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
      get: srcDesc.get,
      set(val) {
        srcDesc.set.call(this, val);
        if (!hookedSet.has(this)) hookElement(this);
      },
      configurable: true,
    });
  }

  // ── Intercept 4: .play() — final safety net ────────────────────────────────
  const nativePlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    hookElement(this);
    return nativePlay.call(this);
  };

  // ── Intercept 5: loadstart event — fires when src resolves ────────────────
  document.addEventListener('loadstart', (e) => {
    if (e.target instanceof HTMLMediaElement) hookElement(e.target);
  }, true);

  retryAll();
  console.info('[PitchShift] MAIN world ready.');
})();