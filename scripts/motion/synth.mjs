import { writeFileSync } from "node:fs";

/** A tiny synthesiser for film soundtracks: instruments (pad, pluck, bell, boop, click, thud, sweep, tick), two buses
 * (music and effects) with their own reverb, and a mixdown to a WAV file. Everything is generated from scratch and
 * deterministic, so there is nothing to license and the result is identical every run.
 *
 *   const a = createSynth(28.4);  a.put(a.music, a.wetMusic, 3.2, a.pad(...), 0.1, 0, 0.5);  a.write("out.wav", opts) */
export function createSynth(DURATION) {
const SR = 48000;
const N = Math.floor(SR * DURATION);
// ---- tiny deterministic noise, so the audio is identical every run ----
let seed = 20261005;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const noise = () => rand() * 2 - 1;

// ---- buses: music and effects, each with its own reverb send ----
const music = [new Float32Array(N), new Float32Array(N)];
const sfx = [new Float32Array(N), new Float32Array(N)];
const wetMusic = [new Float32Array(N), new Float32Array(N)];
const wetSfx = [new Float32Array(N), new Float32Array(N)];

const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const note = (name) => { const m = /^([A-G])([#b]?)(\d)$/.exec(name); return 12 * (Number(m[3]) + 1) + NOTE[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0); };

/** Adds a mono signal to a bus at a time, panned (-1 left, 1 right), with a reverb send amount. */
function put(bus, wet, start, signal, gain, pan = 0, send = 0) {
  const at = Math.floor(start * SR), l = gain * Math.cos((pan + 1) * Math.PI / 4), r = gain * Math.sin((pan + 1) * Math.PI / 4);
  for (let i = 0; i < signal.length && at + i < N; i++) {
    if (at + i < 0) continue;
    const v = signal[i];
    bus[0][at + i] += v * l; bus[1][at + i] += v * r;
    if (send) { wet[0][at + i] += v * send; wet[1][at + i] += v * send; }
  }
}
const env = (t, a, d) => Math.min(1, t / a) * Math.exp(-t / d);

// ---- instruments ----
/** A soft pad: detuned saws and a sine under them, slow attack and release, warmed by a low-pass. */
function pad(freq, seconds, attack = 1.4, release = 1.8) {
  const n = Math.floor((seconds + release) * SR), s = new Float32Array(n);
  const detunes = [-7, 0, 7].map((c) => Math.pow(2, c / 1200));
  const ph = detunes.map(() => rand());
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = 0;
    detunes.forEach((d, k) => { ph[k] = (ph[k] + freq * d / SR) % 1; v += (ph[k] * 2 - 1) * 0.3; });
    v += Math.sin(2 * Math.PI * freq * t) * 0.5;
    const g = Math.min(1, t / attack) * (t < seconds ? 1 : Math.max(0, 1 - (t - seconds) / release));
    const cutoff = 0.05 + 0.04 * Math.sin(t * 0.35);
    lp += (v - lp) * cutoff;
    s[i] = lp * g;
  }
  return s;
}
/** A plucked string (Karplus-Strong): a short noise burst circulating in a delay line. */
function pluck(freq, seconds = 1.6, brightness = 0.5) {
  const n = Math.floor(seconds * SR), s = new Float32Array(n), len = Math.max(2, Math.round(SR / freq)), line = new Float32Array(len);
  let smooth = 0;
  for (let i = 0; i < len; i++) { smooth += (noise() - smooth) * 0.22; line[i] = smooth * brightness * 2.4; }   // a rounded burst, not a harsh one
  let p = 0, prev = 0, soft = 0;
  for (let i = 0; i < n; i++) {
    const cur = line[p];
    const next = (cur + prev) * 0.5 * 0.9975;
    line[p] = next; prev = cur; p = (p + 1) % len;
    soft += (cur - soft) * 0.3;                                       // and the top end taken off
    s[i] = soft * Math.min(1, i / 240);
  }
  return s;
}
/** A glassy bell: a few inharmonic partials with slow decay. */
function bell(freq, seconds = 2.4) {
  const n = Math.floor(seconds * SR), s = new Float32Array(n), partials = [[1, 1, 1.1], [2.76, 0.38, 0.55], [5.4, 0.16, 0.3], [8.9, 0.07, 0.18]];
  for (let i = 0; i < n; i++) { const t = i / SR; let v = 0; for (const [m, a, d] of partials) v += Math.sin(2 * Math.PI * freq * m * t) * a * Math.exp(-t / d); s[i] = v * Math.min(1, t / 0.003); }
  return s;
}
/** A friendly little character voice: a short sine that glides from one pitch to another. */
function boop(f0, f1, seconds = 0.16) {
  const n = Math.floor(seconds * SR), s = new Float32Array(n); let ph = 0;
  for (let i = 0; i < n; i++) { const t = i / n; const f = f0 + (f1 - f0) * (1 - Math.pow(1 - t, 2)); ph += 2 * Math.PI * f / SR; s[i] = (Math.sin(ph) + 0.25 * Math.sin(2 * ph)) * Math.sin(Math.PI * Math.pow(t, 0.55)) * 0.7; }
  return s;
}
function click() { const n = Math.floor(0.05 * SR), s = new Float32Array(n); let hp = 0; for (let i = 0; i < n; i++) { const t = i / SR; const x = noise(); hp = x - hp * 0.2; s[i] = (hp * 0.5 * Math.exp(-t / 0.004) + Math.sin(2 * Math.PI * 2600 * t) * 0.5 * Math.exp(-t / 0.012)); } return s; }
function thud(freq = 150, seconds = 0.28) { const n = Math.floor(seconds * SR), s = new Float32Array(n); let ph = 0; for (let i = 0; i < n; i++) { const t = i / SR; const f = freq * (1 + 1.4 * Math.exp(-t / 0.03)); ph += 2 * Math.PI * f / SR; s[i] = Math.sin(ph) * Math.exp(-t / 0.075) * 0.9 + noise() * Math.exp(-t / 0.006) * 0.25; } return s; }
/** Band-passed noise that sweeps from one frequency to another: a whoosh, or (rising) a rewind. */
function sweep(seconds, f0, f1, q = 1.6, shape = "swell") {
  const n = Math.floor(seconds * SR), s = new Float32Array(n);
  let y1 = 0, y2 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n, f = f0 * Math.pow(f1 / f0, t), w = 2 * Math.PI * f / SR, a = Math.sin(w) / (2 * q), b0 = a, a0 = 1 + a, a1 = -2 * Math.cos(w), a2 = 1 - a;
    const x = noise();
    const y = (b0 * x - b0 * 0 - a1 * y1 - a2 * y2) / a0; y2 = y1; y1 = y;
    const g = shape === "swell" ? Math.sin(Math.PI * Math.pow(t, 0.8)) : Math.pow(t, 1.5);
    s[i] = y * g * 3.2;
  }
  return s;
}
function tick(freq = 900) { const n = Math.floor(0.09 * SR), s = new Float32Array(n); for (let i = 0; i < n; i++) { const t = i / SR; s[i] = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t / 0.018) * Math.min(1, t / 0.001); } return s; }

// ---- reverb (a small Schroeder room, bright and short) ----
function reverb(input, size) {
  const combs = [1557, 1617, 1491, 1422].map((d) => Math.floor(d * size)), aps = [225, 556].map((d) => Math.floor(d * size));
  const result = [new Float32Array(N), new Float32Array(N)];
  for (const ch of [0, 1]) {
    const lines = combs.map((d) => ({ buf: new Float32Array(d + ch * 23), i: 0, lp: 0 }));
    const apb = aps.map((d) => ({ buf: new Float32Array(d + ch * 11), i: 0 }));
    for (let n = 0; n < N; n++) {
      let acc = 0;
      for (const c of lines) { const o = c.buf[c.i]; c.lp += (o - c.lp) * 0.32; c.buf[c.i] = input[ch][n] + c.lp * 0.84; c.i = (c.i + 1) % c.buf.length; acc += o; }
      let y = acc * 0.25;
      for (const a of apb) { const o = a.buf[a.i]; const x = y + o * 0.5; a.buf[a.i] = x; y = o - x * 0.5; a.i = (a.i + 1) % a.buf.length; }
      result[ch][n] = y;
    }
  }
  return result;
}
const rm = reverb(wetMusic, 1.5), rs = reverb(wetSfx, 0.8);


function write(out, { musicGain = 0.9, reverbMusic = 0.55, sfxGain = 1.0, reverbSfx = 0.5, fadeOut = 2.4, target = 0.8 } = {}) {
  const rm = reverb(wetMusic, 1.5), rs = reverb(wetSfx, 0.8);
  const pcm = new Int16Array(N * 2);
  let peak = 0;
  const mixed = [new Float32Array(N), new Float32Array(N)];
  for (const ch of [0, 1]) for (let n = 0; n < N; n++) {
    const t = n / SR;
    const fIn = Math.min(1, t / 0.6), fOut = t > DURATION - fadeOut ? Math.max(0, (DURATION - t) / fadeOut) : 1;
    const v = (music[ch][n] * musicGain + rm[ch][n] * reverbMusic + sfx[ch][n] * sfxGain + rs[ch][n] * reverbSfx) * fIn * fOut;
    mixed[ch][n] = v; if (Math.abs(v) > peak) peak = Math.abs(v);
  }
  const norm = Math.min(1.6, target / Math.max(peak, 1e-6));
  for (let n = 0; n < N; n++) for (const ch of [0, 1]) {
    const v = Math.tanh(mixed[ch][n] * norm * 1.05);
    pcm[n * 2 + ch] = Math.max(-32767, Math.min(32767, Math.round(v * 32767)));
  }
  const header = Buffer.alloc(44), dataBytes = pcm.length * 2;
  header.write("RIFF", 0); header.writeUInt32LE(36 + dataBytes, 4); header.write("WAVEfmt ", 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
  header.writeUInt32LE(SR, 24); header.writeUInt32LE(SR * 4, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(dataBytes, 40);
  writeFileSync(out, Buffer.concat([header, Buffer.from(pcm.buffer)]));
  console.log(`Wrote ${out} (${DURATION}s, peak before normalising ${peak.toFixed(2)}).`);
}
return { SR, N, music, sfx, wetMusic, wetSfx, midi, note, put, env, pad, pluck, bell, click, thud, sweep, tick, boop, noise, rand, write };
}
