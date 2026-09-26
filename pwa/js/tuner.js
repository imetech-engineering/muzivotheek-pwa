// Stemapparaat: toonhoogte uit de microfoon (autocorrelatie).

import { audioContext } from "./metronome.js";

const NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];

export class Tuner {
  constructor() {
    this.stream = null;
    this.analyser = null;
    this.buf = null;
    this.raf = 0;
    this.onPitch = null; // ({freq, note, octave, cents} | null) => void
    this.ref = 440;
    this.transpose = 0;
  }

  async start() {
    const a = audioContext();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const src = a.createMediaStreamSource(this.stream);
    this.analyser = a.createAnalyser();
    this.analyser.fftSize = 4096;
    let last = 0;
    src.connect(this.analyser);
    this.buf = new Float32Array(this.analyser.fftSize);
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      const now = performance.now();
      if (now - last < 80) return; // ~12x per seconde is genoeg en spaart de accu
      last = now;
      this.analyser.getFloatTimeDomainData(this.buf);
      const f = detect(this.buf, a.sampleRate);
      this.onPitch && this.onPitch(f ? this.describe(f) : null);
    };
    loop();
  }

  stop() {
    cancelAnimationFrame(this.raf);
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  describe(freq) {
    const midi = 69 + 12 * Math.log2(freq / this.ref);
    const round = Math.round(midi);
    const cents = Math.round((midi - round) * 100);
    // Transponerend instrument: toon de genoteerde noot (bv. Bes-instrument +2).
    const written = round + this.transpose;
    return {
      freq,
      note: NAMES[((written % 12) + 12) % 12],
      octave: Math.floor(written / 12) - 1,
      cents,
    };
  }
}

function detect(buf, rate) {
  const n = buf.length;
  let rms = 0;
  for (let i = 0; i < n; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / n);
  if (rms < 0.01) return null;

  const minLag = Math.floor(rate / 1500);
  const maxLag = Math.floor(rate / 50);
  const size = n - maxLag;
  let best = -1;
  let bestLag = -1;
  const corr = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    let e1 = 0;
    let e2 = 0;
    for (let i = 0; i < size; i++) {
      sum += buf[i] * buf[i + lag];
      e1 += buf[i] * buf[i];
      e2 += buf[i + lag] * buf[i + lag];
    }
    const c = sum / Math.sqrt(e1 * e2 || 1);
    corr[lag] = c;
    if (c > best) {
      best = c;
      bestLag = lag;
    }
  }
  if (best < 0.9) return null;
  // Eerste piek die bijna zo hoog is als de beste: voorkomt octaaffouten.
  for (let lag = minLag + 1; lag < bestLag; lag++) {
    if (corr[lag] > best * 0.97 && corr[lag] >= corr[lag - 1] && corr[lag] >= corr[lag + 1]) {
      bestLag = lag;
      break;
    }
  }
  // Parabolische interpolatie rond de piek.
  const y0 = corr[bestLag - 1] || 0;
  const y1 = corr[bestLag];
  const y2 = corr[bestLag + 1] || 0;
  const shift = (y2 - y0) / (2 * (2 * y1 - y2 - y0) || 1);
  return rate / (bestLag + shift);
}
