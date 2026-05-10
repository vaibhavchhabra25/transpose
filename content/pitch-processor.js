// content/pitch-processor.js
const TWO_PI = 2 * Math.PI;

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
    const ang = (inverse ? TWO_PI : -TWO_PI) / len;
    const wBR = Math.cos(ang), wBI = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wR = 1, wI = 0;
      for (let j = 0; j < len / 2; j++) {
        const idx1 = i + j;
        const idx2 = idx1 + len / 2;
        const uR = re[idx1], uI = im[idx1];
        const vR = re[idx2] * wR - im[idx2] * wI;
        const vI = re[idx2] * wI + im[idx2] * wR;
        re[idx1] = uR + vR;
        im[idx1] = uI + vI;
        re[idx2] = uR - vR;
        im[idx2] = uI - vI;
        const nR = wR * wBR - wI * wBI;
        wI = wR * wBI + wI * wBR;
        wR = nR;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

function wrapPhase(p) {
  return p - TWO_PI * Math.round(p / TWO_PI);
}

function hannWindow(size) {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 * (1 - Math.cos(TWO_PI * i / size));
  return w;
}

function createChannelState(F, H) {
  return {
    inputRing: new Float32Array(F), inputPos: 0, samplesUntilHop: H,
    outputRing: new Float32Array(F * 4), outputReadPos: 0, outputWritePos: F,
    lastInputPhase: new Float32Array(F), lastOutputPhase: new Float32Array(F),
    re: new Float32Array(F), im: new Float32Array(F),
    oR: new Float32Array(F), oI: new Float32Array(F),
    // Pre-allocated buffers for Formant Preservation to prevent GC crashes
    mags: new Float32Array((F >> 1) + 1),
    env: new Float32Array((F >> 1) + 1)
  };
}

function processFrame(s, F, H, win, pf, expAdvTable, preserveFormants) {
  const { re, im, inputRing, inputPos, lastInputPhase, lastOutputPhase, outputRing, oR, oI, mags, env } = s;
  const half = F >> 1;

  for (let i = 0; i < F; i++) {
    re[i] = inputRing[(inputPos - F + i + F * 4) % F] * win[i];
    im[i] = 0; oR[i] = 0; oI[i] = 0;
  }

  fft(re, im, false);

  // Pre-calculate magnitudes
  for (let k = 0; k <= half; k++) {
    mags[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
  }

  // 🚀 FAST SPECTRAL ENVELOPE ESTIMATOR (O(N) Moving Average)
  if (preserveFormants === 1.0) {
    const w = 16; // Envelope window size (smoothness)
    let sum = 0;
    // Initial sum
    for (let i = 0; i <= w && i <= half; i++) sum += mags[i];
    // Sliding window
    for (let k = 0; k <= half; k++) {
      env[k] = sum / (Math.min(half, k + w) - Math.max(0, k - w) + 1);
      if (k + w + 1 <= half) sum += mags[k + w + 1];
      if (k - w >= 0) sum -= mags[k - w];
    }
  }

  for (let k = 0; k <= half; k++) {
    const mag = mags[k];
    const phase = Math.atan2(im[k], re[k]);
    const expAdv = expAdvTable[k];
    const trueFreq = expAdv + wrapPhase(phase - lastInputPhase[k] - expAdv);
    lastInputPhase[k] = phase;

    const tk = Math.round(k * pf);
    if (tk >= 0 && tk <= half) {
      lastOutputPhase[tk] += trueFreq * pf;

      // 🚀 APPLY FORMANT PRESERVATION
      let finalMag = mag;
      if (preserveFormants === 1.0) {
        // Scale the shifted magnitude so it matches the Original Envelope at the NEW frequency
        finalMag = mag * (env[tk] / (env[k] + 1e-6));
      }

      oR[tk] += finalMag * Math.cos(lastOutputPhase[tk]);
      oI[tk] += finalMag * Math.sin(lastOutputPhase[tk]);
      if (tk > 0 && tk < half) {
        oR[F - tk] = oR[tk];
        oI[F - tk] = -oI[tk];
      }
    }
  }

  fft(oR, oI, true);

  // THE FIX: The true overlap-add sum of a squared Hann window at 75% overlap is 1.5.
  // Using 0.375 gives us exactly 1.5 (4 * 0.375), restoring 100% original volume!
  const scale = (F / H) * 0.375;
  const rLen = outputRing.length;
  const ws = s.outputWritePos;
  for (let i = 0; i < F; i++) {
    outputRing[(ws + i) % rLen] += (oR[i] * win[i]) / scale;
  }
  s.outputWritePos = (ws + H) % rLen;
}

class PitchShifterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'pitchFactor', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' },
      { name: 'preserveFormants', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ];
  }
  constructor() {
    super();
    this.F = 4096;
    this.H = 1024;
    this.win = hannWindow(this.F);
    this.ch = [];
    this.expAdvTable = new Float32Array((this.F >> 1) + 1);
    for (let k = 0; k <= (this.F >> 1); k++) {
      this.expAdvTable[k] = TWO_PI * k * this.H / this.F;
    }
  }
  process(inputs, outputs, params) {
    if (!inputs || !outputs) return true;
    const inp = inputs[0];
    const out = outputs[0];
    if (!inp || !out || inp.length === 0 || out.length === 0) return true;

    let pf = 1.0;
    let formants = 0.0;
    if (params.pitchFactor && params.pitchFactor.length > 0) pf = params.pitchFactor[0];
    if (params.preserveFormants && params.preserveFormants.length > 0) formants = params.preserveFormants[0];

    while (this.ch.length < inp.length) this.ch.push(createChannelState(this.F, this.H));

    for (let c = 0; c < inp.length; c++) {
      const id = inp[c], od = out[c];
      if (!id || !od) continue;

      const st = this.ch[c];
      const rLen = st.outputRing.length;

      for (let i = 0; i < id.length; i++) {
        st.inputRing[st.inputPos % this.F] = id[i];
        st.inputPos = (st.inputPos + 1) % this.F;

        if (pf === 1.0) {
          od[i] = id[i];
          if (--st.samplesUntilHop <= 0) st.samplesUntilHop = this.H;
          st.outputRing[st.outputReadPos] = 0;
          st.outputReadPos = (st.outputReadPos + 1) % rLen;
          st.outputWritePos = (st.outputReadPos + this.F) % rLen;
        } else {
          if (--st.samplesUntilHop <= 0) {
            st.samplesUntilHop = this.H;
            processFrame(st, this.F, this.H, this.win, pf, this.expAdvTable, formants);
          }
          od[i] = st.outputRing[st.outputReadPos];
          st.outputRing[st.outputReadPos] = 0;
          st.outputReadPos = (st.outputReadPos + 1) % rLen;
        }
      }
    }
    return true;
  }
}
registerProcessor('pitch-shifter', PitchShifterProcessor);