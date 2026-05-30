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
    mags: new Float32Array((F >> 1) + 1),
    env: new Float32Array((F >> 1) + 1),
    phases: new Float32Array((F >> 1) + 1),
    master: new Int32Array((F >> 1) + 1),
  };
}

function analyzeFrame(s, F, win) {
  const { re, im, inputRing, inputPos, mags } = s;
  const half = F >> 1;
  for (let i = 0; i < F; i++) {
    re[i] = inputRing[(inputPos - F + i + F * 4) % F] * win[i];
    im[i] = 0;
  }
  fft(re, im, false);
  for (let k = 0; k <= half; k++) {
    mags[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
  }
}

// 🚀 UPGRADED: Added masterState parameter for Stereo Linking
function processFrame(s, F, H, win, pf, expAdvTable, preserveFormants, masterState = null) {
  const { re, im, inputRing, inputPos, lastInputPhase, lastOutputPhase, outputRing, oR, oI, mags, env, phases, master } = s;
  const half = F >> 1;

  for (let i = 0; i < F; i++) {
    re[i] = inputRing[(inputPos - F + i + F * 4) % F] * win[i];
    im[i] = 0; oR[i] = 0; oI[i] = 0;
  }

  fft(re, im, false);

  for (let k = 0; k <= half; k++) {
    mags[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    phases[k] = Math.atan2(im[k], re[k]);
  }

  // 🚀 MASTER CHANNEL (Left): Do the heavy math
  if (!masterState) {
    let lastValley = 0;
    for (let k = 1; k < half; k++) {
      if (mags[k] < mags[k - 1] && mags[k] <= mags[k + 1]) {
        let maxMag = -1; let peakIdx = lastValley;
        for (let i = lastValley; i <= k; i++) {
          if (mags[i] > maxMag) { maxMag = mags[i]; peakIdx = i; }
        }
        for (let i = lastValley; i <= k; i++) master[i] = peakIdx;
        lastValley = k + 1;
      }
    }
    let maxMag = -1; let peakIdx = lastValley;
    for (let i = lastValley; i <= half; i++) {
      if (mags[i] > maxMag) { maxMag = mags[i]; peakIdx = i; }
    }
    for (let i = lastValley; i <= half; i++) master[i] = peakIdx;

    for (let k = 0; k <= half; k++) {
      if (master[k] === k) {
        const phase = phases[k];
        const expAdv = expAdvTable[k];
        const trueFreq = expAdv + wrapPhase(phase - lastInputPhase[k] - expAdv);
        lastOutputPhase[k] += trueFreq * pf;
      }
    }
  }

  if (preserveFormants === 1.0) {
    const w = 16;
    let sum = 0;
    for (let i = 0; i <= w && i <= half; i++) sum += mags[i];
    for (let k = 0; k <= half; k++) {
      env[k] = sum / (Math.min(half, k + w) - Math.max(0, k - w) + 1);
      if (k + w + 1 <= half) sum += mags[k + w + 1];
      if (k - w >= 0) sum -= mags[k - w];
    }
  }

  // 🚀 RENDER: Apply phase locks
  for (let k = 0; k <= half; k++) {
    let outPhase;

    if (!masterState) {
      // LEFT CHANNEL: Calculate standard outputs
      const p = master[k];
      if (p === k) outPhase = lastOutputPhase[k];
      else {
        outPhase = lastOutputPhase[p] + (phases[k] - phases[p]);
        lastOutputPhase[k] = outPhase;
      }
    } else {
      // RIGHT CHANNEL (SLAVE): Perfectly preserve original Stereo Width!
      const phaseDiff = phases[k] - masterState.phases[k];
      outPhase = masterState.lastOutputPhase[k] + phaseDiff;
      lastOutputPhase[k] = outPhase;
    }

    lastInputPhase[k] = phases[k];

    const tk = Math.round(k * pf);
    if (tk >= 0 && tk <= half) {
      let finalMag = mags[k];

      // Energy compensation for bin remapping:
      // Upward shifts discard bins above Nyquist → energy loss of ~1/pf → compensate with sqrt(pf).
      // Downward shifts accumulate multiple bins per target → energy is preserved via random-phase
      // addition → no compensation needed (gain = 1.0).
      const energyGain = pf > 1.0 ? Math.sqrt(pf) : 1.0;

      if (preserveFormants === 1.0) {
        const formantScale = env[tk] / (env[k] + 1e-6);
        const safeScale = Math.max(0.1, Math.min(formantScale, 5.0));
        finalMag = mags[k] * safeScale * energyGain;
      } else {
        finalMag *= energyGain;
      }

      oR[tk] += finalMag * Math.cos(outPhase);
      oI[tk] += finalMag * Math.sin(outPhase);

      if (tk > 0 && tk < half) {
        oR[F - tk] = oR[tk];
        oI[F - tk] = -oI[tk];
      }
    }
  }

  fft(oR, oI, true);

  const scale = (F / H) * 0.375;
  const rLen = outputRing.length;
  const ws = s.outputWritePos;
  for (let i = 0; i < F; i++) outputRing[(ws + i) % rLen] += (oR[i] * win[i]) / scale;
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
    this.frameCounter = 0;

    this.expAdvTable = new Float32Array((this.F >> 1) + 1);

    // 🚀 UPGRADED: Fractional Binning Arrays
    this.binWeights = new Float32Array((this.F >> 1) + 1);
    this.binPitch1 = new Int32Array((this.F >> 1) + 1);
    this.binPitch2 = new Int32Array((this.F >> 1) + 1);

    for (let k = 0; k <= (this.F >> 1); k++) {
      this.expAdvTable[k] = TWO_PI * k * this.H / this.F;

      if (k > 0) {
        const freq = k * sampleRate / this.F;
        const note = 12 * Math.log2(freq / 440.0) + 69;

        const lowerNote = Math.floor(note);
        const frac = note - lowerNote; // A value between 0.0 and 1.0

        let p1 = lowerNote % 12;
        let p2 = (lowerNote + 1) % 12;
        if (p1 < 0) p1 += 12;
        if (p2 < 0) p2 += 12;

        this.binPitch1[k] = p1;
        this.binPitch2[k] = p2;
        this.binWeights[k] = frac; // Weight for the higher note
      }
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
          if (--st.samplesUntilHop <= 0) {
            st.samplesUntilHop = this.H;
            analyzeFrame(st, this.F, this.win);
          }
          st.outputRing[st.outputReadPos] = 0;
          st.outputReadPos = (st.outputReadPos + 1) % rLen;
          st.outputWritePos = (st.outputReadPos + this.F) % rLen;
        } else {
          if (--st.samplesUntilHop <= 0) {
            st.samplesUntilHop = this.H;

            // 🚀 UPGRADED: Pass the Left Channel as the Master for Stereo Linking
            const masterState = (c === 0) ? null : this.ch[0];
            processFrame(st, this.F, this.H, this.win, pf, this.expAdvTable, formants, masterState);
          }
          od[i] = st.outputRing[st.outputReadPos];
          st.outputRing[st.outputReadPos] = 0;
          st.outputReadPos = (st.outputReadPos + 1) % rLen;
        }
      }
    }

    // Key Detection Broadcaster
    this.frameCounter++;
    if (this.frameCounter % 20 === 0) {
      let totalChroma = new Float32Array(12);
      const minBin = Math.floor(100 * this.F / sampleRate);
      const maxBin = Math.floor(3000 * this.F / sampleRate);

      for (let c = 0; c < this.ch.length; c++) {
        for (let k = minBin; k <= maxBin; k++) {
          const compressedMag = Math.pow(this.ch[c].mags[k], 0.5);

          // 🚀 UPGRADED: Distribute energy based on how close the frequency is to A440
          const w = this.binWeights[k];
          totalChroma[this.binPitch1[k]] += compressedMag * (1.0 - w);
          totalChroma[this.binPitch2[k]] += compressedMag * w;
        }
      }
      this.port.postMessage({ type: 'chroma', data: totalChroma });
    }
    return true;
  }
}
registerProcessor('pitch-shifter', PitchShifterProcessor);