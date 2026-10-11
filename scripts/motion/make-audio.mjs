/** Writes the sound for the light "Waiting for you" film (waiting-for-you.html): spacious, warm and major, with a
 * slow pad, a few soft plucked notes, and quiet, clean sounds for what happens on screen. The three teammates have
 * their own notes (Nova C, Pixel E, Scout G): when all three have landed you hear a C major chord, and each cheer is
 * a little rising phrase. Everything is synthesised here (scripts/motion/synth.mjs), so nothing is licensed or downloaded.
 *
 *   node scripts/motion/make-audio.mjs out.wav
 *
 * The cue times match waiting-for-you.html; change both together. */
import { createSynth } from "./synth.mjs";

const DURATION = 31.4;
const a = createSynth(DURATION);
const { music, sfx, wetMusic, wetSfx, midi, note, put, pad, pluck, bell, click, thud, sweep, tick, boop } = a;
const hz = (name) => midi(note(name));

// ---- the music: one soft chord per scene, plus a few plucked notes ----
const chords = [
  { from: 0.0, to: 4.0, notes: ["C3", "G3", "D4", "E4"], root: "C2", loud: 0.5 },
  { from: 4.0, to: 9.0, notes: ["F2", "C3", "E3", "A3"], root: "F1", loud: 0.8 },
  { from: 9.0, to: 13.5, notes: ["A2", "E3", "G3", "C4"], root: "A1", loud: 0.85 },
  { from: 13.5, to: 18.0, notes: ["F2", "C3", "E3", "A3", "G3"], root: "F1", loud: 0.9 },
  { from: 18.0, to: 21.9, notes: ["E2", "B2", "D3", "G3"], root: "E1", loud: 0.85 },
  { from: 21.9, to: 26.0, notes: ["F2", "A2", "C3", "E3", "G3"], root: "F1", loud: 0.9 },
  { from: 26.0, to: 31.4, notes: ["C2", "G2", "E3", "B3", "D4"], root: "C1", loud: 1.0 },
];
for (const chord of chords) {
  const seconds = chord.to - chord.from;
  chord.notes.forEach((name, k) => put(music, wetMusic, chord.from - 0.6, pad(hz(name), seconds + 0.6, 1.6, 2.0), 0.075 * chord.loud, (k - 2) * 0.25, 0.55));
  put(music, wetMusic, chord.from, pad(hz(chord.root) * 2, seconds, 0.8, 1.2), 0.13 * chord.loud, 0, 0.1);
}
// a few soft plucked notes, two to a bar: never busy
const beat = 60 / 72;
const melody = [[0, 2, 4], [1, 3, 2], [0, 4, 3], [2, 4, 1]];
chords.slice(1).forEach((chord, ci) => {
  const tones = chord.notes.map((n) => note(n) + 24);
  let bar = 0;
  for (let t = Math.ceil(chord.from / (beat * 2)) * beat * 2; t < chord.to - 0.5; t += beat * 2, bar++) {
    const pat = melody[(ci + bar) % melody.length];
    pat.forEach((idx, k) => put(music, wetMusic, t + k * beat * 0.5, pluck(midi(tones[idx % tones.length]), 1.6, 0.5), 0.13 * (k === 0 ? 1 : 0.7), (k - 1) * 0.35, 0.6));
  }
});

// ---- the teammates' notes: Nova C, Pixel E, Scout G ----
const voice = { nova: [330, 440], pixel: [660, 880], scout: [495, 660] };
const notes = { nova: "C5", pixel: "E5", scout: "G5" };
for (const [who, t] of [["nova", 0.97], ["pixel", 1.32], ["scout", 1.67]]) {
  put(sfx, wetSfx, t, thud(110, 0.22), 0.12, 0, 0.2);                       // landing
  put(sfx, wetSfx, t + 0.02, boop(...voice[who], 0.18), 0.1, who === "nova" ? -0.5 : who === "scout" ? 0.5 : 0, 0.3);
  put(sfx, wetSfx, t + 0.04, bell(hz(notes[who]), 2.4), 0.1, who === "nova" ? -0.4 : who === "scout" ? 0.4 : 0, 0.55);
}
put(sfx, wetSfx, 1.7, bell(hz("C6"), 3.0), 0.05, 0, 0.6);                    // the chord is complete

// ---- the effects: one soft cue for each thing that happens on screen ----
const heads = [1.9, 4.6, 9.0, 13.5, 18.1, 21.9, 26.6];                        // each headline arrives
for (const t of heads) put(sfx, wetSfx, t - 0.05, sweep(0.8, 500, 3200), 0.035, 0, 0.3);
put(sfx, wetSfx, 4.0, sweep(1.0, 260, 1400, 1.2, "swell"), 0.045, 0, 0.3);  // they walk to the bottom
put(sfx, wetSfx, 5.0, thud(160, 0.25), 0.12, 0, 0.3); put(sfx, wetSfx, 5.2, tick(1200), 0.09, 0, 0.4);
put(sfx, wetSfx, 5.3, boop(500, 640, 0.1), 0.05, -0.3, 0.3); put(sfx, wetSfx, 5.34, boop(800, 1000, 0.1), 0.05, 0.1, 0.3); put(sfx, wetSfx, 5.38, boop(620, 780, 0.1), 0.05, 0.4, 0.3);   // they look up
put(sfx, wetSfx, 6.4, sweep(2.6, 300, 1500, 1.4, "swell"), 0.03, 0, 0.2);   // the list scrolls
put(sfx, wetSfx, 9.4, thud(150, 0.25), 0.12, 0, 0.3);                       // the reply card
put(sfx, wetSfx, 10.82, click(), 0.22, -0.2, 0.15);                          // Save draft
put(sfx, wetSfx, 10.95, bell(hz("E5"), 1.8), 0.1, 0, 0.5); put(sfx, wetSfx, 11.06, bell(hz("B5"), 2.0), 0.09, 0.2, 0.5);
[["E5", 10.98], ["G5", 11.16], ["C6", 11.34]].forEach(([n, t], i) => put(sfx, wetSfx, t, boop(hz(n) * 0.98, hz(n), 0.2), 0.07, -0.1 + i * 0.1, 0.4));   // Pixel cheers
put(sfx, wetSfx, 11.25, thud(120, 0.22), 0.1, 0, 0.3);
[14.0, 14.2, 14.4, 14.6, 14.8].forEach((t, i) => put(sfx, wetSfx, t + 0.1, tick(620 + i * 120), 0.13, (i - 2) * 0.2, 0.3));   // five approvals
put(sfx, wetSfx, 15.3, thud(150, 0.25), 0.12, 0, 0.3);                      // the offer
put(sfx, wetSfx, 16.5, click(), 0.22, -0.2, 0.15);                           // Yes, do these automatically
put(sfx, wetSfx, 16.65, bell(hz("G5"), 1.8), 0.1, 0, 0.5); put(sfx, wetSfx, 16.78, bell(hz("D6"), 2.0), 0.08, 0.2, 0.5);
[["G5", 16.78], ["B5", 16.96], ["D6", 17.14]].forEach(([n, t], i) => put(sfx, wetSfx, t, boop(hz(n) * 0.98, hz(n), 0.2), 0.07, 0.1 + i * 0.1, 0.4));   // Scout cheers
put(sfx, wetSfx, 17.05, tick(1100), 0.09, -0.2, 0.3); put(sfx, wetSfx, 17.25, tick(1300), 0.09, 0.2, 0.3);   // the two reassurances
put(sfx, wetSfx, 18.6, thud(150, 0.25), 0.12, 0, 0.3);                      // the row
put(sfx, wetSfx, 19.75, click(), 0.22, 0.2, 0.15);                           // Undo
put(sfx, wetSfx, 19.8, sweep(1.2, 2200, 260, 1.4, "swell"), 0.05, 0, 0.3);  // the rewind
put(sfx, wetSfx, 20.9, boop(660, 330, 0.3), 0.06, -0.4, 0.3);                // Nova lands
put(sfx, wetSfx, 22.4, thud(150, 0.25), 0.12, 0, 0.3);                      // the list
[22.7, 22.85, 23.0, 23.15, 23.3].forEach((t, i) => put(sfx, wetSfx, t + 0.05, tick(700 + i * 80), 0.1, 0, 0.2));
for (let i = 0; i < 26; i++) put(sfx, wetSfx, 23.52 + i * 0.056, tick(500 + i * 36), 0.05 + i * 0.002, 0, 0.15);      // the total counts up
put(sfx, wetSfx, 25.0, bell(hz("A5"), 2.0), 0.1, 0, 0.5); put(sfx, wetSfx, 25.12, bell(hz("E6"), 2.2), 0.08, 0.2, 0.5);
[["nova", 25.0], ["pixel", 25.1], ["scout", 25.2]].forEach(([w, t]) => put(sfx, wetSfx, t, boop(...voice[w], 0.12), 0.05, 0, 0.3));
put(sfx, wetSfx, 26.0, sweep(1.2, 260, 1600, 1.2, "swell"), 0.05, 0, 0.3);  // they come back to the middle
[["nova", 27.4], ["pixel", 27.6], ["scout", 27.8]].forEach(([w, t]) => { put(sfx, wetSfx, t, boop(...voice[w], 0.18), 0.09, w === "nova" ? -0.5 : w === "scout" ? 0.5 : 0, 0.3); put(sfx, wetSfx, t + 0.02, bell(hz(notes[w]), 2.8), 0.08, w === "nova" ? -0.4 : w === "scout" ? 0.4 : 0, 0.55); });
put(sfx, wetSfx, 28.9, sweep(1.0, 500, 3400, 1.3, "swell"), 0.04, 0, 0.3);
put(sfx, wetSfx, 29.0, bell(hz("C6"), 3.6), 0.07, 0, 0.6); put(sfx, wetSfx, 29.6, bell(hz("G6"), 3.0), 0.05, 0.2, 0.6);

a.write(process.argv[2] || "film-audio.wav", { musicGain: 0.9, reverbMusic: 0.6, sfxGain: 1.0, reverbSfx: 0.5, fadeOut: 2.6, target: 0.75 });
