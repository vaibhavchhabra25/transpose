// content/pitch-processor.js
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