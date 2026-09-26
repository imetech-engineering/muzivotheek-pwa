// Metronoom met Web Audio: klikken worden vooruit ingepland, dus strak in de maat.

import { settings } from "./settings.js";

let ctx = null;
function audio() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

export class Metronome {
  constructor() {
    this.bpm = 100;
    this.beats = settings().metroBeats || 4;
    this.running = false;
    this.onBeat = null; // (beatIndex) => void
    this._timer = null;
    this._next = 0;
    this._beat = 0;
    this._taps = [];
  }

  setBpm(v) {
    this.bpm = Math.max(20, Math.min(300, Math.round(v)));
  }

  start() {
    if (this.running) return;
    const a = audio();
    this.running = true;
    this._beat = 0;
    this._next = a.currentTime + 0.06;
    this._timer = setInterval(() => this._schedule(), 25);
    this._schedule();
  }

  stop() {
    this.running = false;
    clearInterval(this._timer);
    this._timer = null;
  }

  toggle() {
    this.running ? this.stop() : this.start();
    return this.running;
  }

  _schedule() {
    const a = audio();
    while (this._next < a.currentTime + 0.12) {
      const beat = this._beat;
      const accent = settings().metroAccent && this.beats > 1 && beat === 0;
      if (settings().metroSound) this._click(this._next, accent);
      const delay = Math.max(0, (this._next - a.currentTime) * 1000);
      setTimeout(() => this.running && this.onBeat && this.onBeat(beat, accent), delay);
      this._next += 60 / this.bpm;
      this._beat = (beat + 1) % Math.max(1, this.beats);
    }
  }

  _click(t, accent) {
    const a = audio();
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.frequency.value = accent ? 1760 : 1100;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(accent ? 0.9 : 0.55, t + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    osc.connect(gain).connect(a.destination);
    osc.start(t);
    osc.stop(t + 0.06);
  }

  // Tik het tempo in. Geeft het nieuwe BPM terug (of null bij de eerste tik).
  tap() {
    const now = performance.now();
    this._taps = this._taps.filter((t) => now - t < 2500);
    this._taps.push(now);
    if (this._taps.length < 2) return null;
    const gaps = [];
    for (let i = 1; i < this._taps.length; i++) gaps.push(this._taps[i] - this._taps[i - 1]);
    const avg = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    this.setBpm(60000 / avg);
    return this.bpm;
  }
}

export function tempoName(bpm) {
  if (bpm < 60) return "Largo";
  if (bpm < 76) return "Adagio";
  if (bpm < 108) return "Andante";
  if (bpm < 120) return "Moderato";
  if (bpm < 156) return "Allegro";
  if (bpm < 176) return "Vivace";
  return "Presto";
}

export { audio as audioContext };
