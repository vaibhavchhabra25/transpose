// content/pitch-processor.js
// AudioWorklet Processor — Phase Vocoder Pitch Shifter
// Runs in the audio rendering thread (high-priority, no DOM access)

// ─── FFT (Cooley-Tukey Radix-2 In-Place) ───────────────────────────────────

function fft(re, im, inverse = false) {
  const n = re.length;
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  // Butterfly operations
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wBaseRe = Math.cos(ang);
    const wBaseIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wRe = 1, wIm = 0;
      for (let j = 0; j < len / 2; j++) {
        const uRe = re[i + j], uIm = im[i + j];
        const vRe = re[i + j + len / 2] * wRe - im[i + j + len / 2] * wIm;
        const vIm = re[i + j + len / 2] * wIm + im[i + j + len / 2] * wRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + len / 2] = uRe - vRe;
        im[i + j + len / 2] = uIm - vIm;
        const nwRe = wRe * wBaseRe - wIm * wBaseIm;
        wIm = wRe * wBaseIm + wIm * wBaseRe;
        wRe = nwRe;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

// Wrap angle to [-π, π]
function wrapPhase(p) {
  while (p > Math.PI) p -= 2 * Math.PI;
  while (p < -Math.PI) p += 2 * Math.PI;
  return p;
}

// Create a Hann window
function hannWindow(size) {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / size));
  return w;
}

// ─── Per-channel state ──────────────────────────────────────────────────────

function createChannelState(fftSize, hopSize) {
  return {
    // Ring input buffer: holds last `fftSize` samples
    inputRing: new Float32Array(fftSize),
    inputPos: 0,
    samplesUntilHop: hopSize, // countdown to next frame

    // Output overlap-add buffer (double-length to avoid wrap issues)
    outputRing: new Float32Array(fftSize * 4),
    outputReadPos: 0,
    outputWritePos: fftSize, // write ahead of read to fill latency

    // Phase vocoder state
    lastInputPhase: new Float32Array(fftSize),
    lastOutputPhase: new Float32Array(fftSize),

    // Reusable FFT work buffers
    re: new Float32Array(fftSize),
    im: new Float32Array(fftSize),
  };
}

// ─── Phase Vocoder Frame Processing ────────────────────────────────────────

function processFrame(state, fftSize, hopSize, window, pitchFactor) {
  const { re, im, inputRing, inputPos, lastInputPhase, lastOutputPhase, outputRing } = state;
  const N = fftSize;
  const half = N >> 1;

  // Copy windowed input frame (newest `fftSize` samples from ring buffer)
  for (let i = 0; i < N; i++) {
    const idx = (inputPos - N + i + N * 4) % N;
    re[i] = inputRing[idx] * window[i];
    im[i] = 0;
  }

  // Analysis FFT
  fft(re, im, false);

  // Allocate output bins
  const outRe = new Float32Array(N);
  const outIm = new Float32Array(N);

  for (let k = 0; k <= half; k++) {
    const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    const phase = Math.atan2(im[k], re[k]);

    // Expected phase advance for bin k over one hop
    const expectedAdv = 2 * Math.PI * k * hopSize / N;

    // True instantaneous frequency (deviation from expected)
    const deviation = wrapPhase(phase - lastInputPhase[k] - expectedAdv);
    const trueFreq = expectedAdv + deviation;

    lastInputPhase[k] = phase;

    // Target bin after pitch shift
    const tk = Math.round(k * pitchFactor);
    if (tk >= 0 && tk <= half) {
      lastOutputPhase[tk] += trueFreq * pitchFactor;
      outRe[tk] += mag * Math.cos(lastOutputPhase[tk]);
      outIm[tk] += mag * Math.sin(lastOutputPhase[tk]);
      // Conjugate mirror
      if (tk > 0 && tk < half) {
        outRe[N - tk] = outRe[tk];
        outIm[N - tk] = -outIm[tk];
      }
    }
  }

  // Synthesis IFFT
  fft(outRe, outIm, true);

  // Overlap-add into output ring (scale by overlapFactor / 2 for Hann normalization)
  const scale = (N / hopSize) / 2;
  const ringLen = outputRing.length;
  const writeStart = state.outputWritePos;
  for (let i = 0; i < N; i++) {
    const idx = (writeStart + i) % ringLen;
    outputRing[idx] += (outRe[i] * window[i]) / scale;
  }
  state.outputWritePos = (writeStart + hopSize) % ringLen;
}

// ─── AudioWorklet Processor ─────────────────────────────────────────────────

class PitchShifterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: 'pitchFactor',
        defaultValue: 1.0,
        minValue: 0.25,  // -24 semitones (2 octaves down)
        maxValue: 4.0,   // +24 semitones (2 octaves up)
        automationRate: 'k-rate',
      },
    ];
  }

  constructor() {
    super();
    this.FFT_SIZE = 2048;   // ~46ms at 44.1kHz — balance between latency & quality
    this.HOP_SIZE = 512;    // 75% overlap — good phase vocoder quality
    this.window = hannWindow(this.FFT_SIZE);
    this.channelStates = [];

    this.port.onmessage = (_e) => { /* future messages */ };
  }

  _ensureChannels(count) {
    while (this.channelStates.length < count) {
      this.channelStates.push(createChannelState(this.FFT_SIZE, this.HOP_SIZE));
    }
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input?.length || !output?.length) return true;

    const pitchFactor = parameters.pitchFactor[0] ?? 1.0;
    const numCh = input.length;
    this._ensureChannels(numCh);

    for (let ch = 0; ch < numCh; ch++) {
      const inData = input[ch];
      const outData = output[ch];
      const state = this.channelStates[ch];
      const ringLen = state.outputRing.length;

      for (let i = 0; i < inData.length; i++) {
        // Write sample to input ring buffer
        state.inputRing[state.inputPos % this.FFT_SIZE] = inData[i];
        state.inputPos = (state.inputPos + 1) % this.FFT_SIZE;

        // Decrement hop countdown
        state.samplesUntilHop--;
        if (state.samplesUntilHop <= 0) {
          state.samplesUntilHop = this.HOP_SIZE;
          if (pitchFactor !== 1.0) {
            processFrame(state, this.FFT_SIZE, this.HOP_SIZE, this.window, pitchFactor);
          } else {
            // Bypass: copy directly to output ring (zero-latency passthrough)
            const n = this.FFT_SIZE, ws = state.outputWritePos;
            for (let j = 0; j < n; j++) {
              const idx = (ws + j) % ringLen;
              const inp = state.inputRing[(state.inputPos - n + j + n * 4) % n];
              state.outputRing[idx] += inp * this.window[j] / ((n / this.HOP_SIZE) / 2);
            }
            state.outputWritePos = (ws + this.HOP_SIZE) % ringLen;
          }
        }

        // Read from output ring
        outData[i] = state.outputRing[state.outputReadPos];
        state.outputRing[state.outputReadPos] = 0; // clear after read
        state.outputReadPos = (state.outputReadPos + 1) % ringLen;
      }
    }

    return true; // keep processor alive
  }
}

registerProcessor('pitch-shifter', PitchShifterProcessor);
