// The power in her singing voice (owner, 2026-11-15: "she still doesn't have the singing power in her voice… It sounds
// like she is very timid and not putting any power behind her voice. I want her to do full-fledged like rock songs,
// ballads, rap songs, and be really, really energetic with her voice").
//
// What was measured that day on her real voice, one line voiced 33 times with different tags:
//  - asked for "belted and high", "full voice, strong", "loud and fierce", her voice came back no different from
//    speaking it: around 100 to 120 Hz, -27 dB, with 12 dB less above 2 kHz than below 1 kHz. Those words do nothing.
//  - told [shouting] ahead of the [singing…] tag, with "full power" inside it, about half the takes came back with
//    real effort in them: 155 to 390 Hz, 3 to 6 dB louder, up to 9 dB brighter. The other half came back timid again.
//    The same tag gives a different take every time.
//  - a line came out of the mix at whatever level her voice happened to give it (a spread of 18 dB between its loud
//    and quiet moments), uncompressed, dry, in mono, under the band.
// So power is three things here, and she sets it herself, line by line, with one number in her score (power, 1 to 5):
//  1. the take: a strong line is asked for at full power and voiced more than once, and the take with the most
//     effort in it (measured: how loud, how high, how bright) is the one that's kept;
//  2. the voice chain: every line is brought to one level, then pressed, lifted where effort lives (around 3 kHz)
//     and warmed, more the stronger the line; the strongest lines are doubled left and right;
//  3. the mix: her voice sits in front of the band (the band is measured and set under her, and gives way a little
//     while she's singing), in a room of its own.
// She can also put her own voice over a line a third above or below (harmony), which is hers alone.
// Pure, apart from the filter strings, which are ffmpeg's.

export const POWER = 3; // a line whose power wasn't written: a full singing voice

// The power she wrote for a line, as a whole number from 1 to 5.
export function readPower(v) {
  const n = Number(v);
  return Number.isFinite(n) && String(v ?? '').trim() !== '' ? Math.max(1, Math.min(5, Math.round(n))) : POWER;
}

// What her voice is told ahead of a strong line, and inside its tag (see the measurements above: these are the words
// that came back with effort in them; the words in `how` alone never did).
export const effortTags = (power) => (power >= 4 ? { ahead: '[shouting] ', inside: 'full power' } : { ahead: '', inside: '' });

// How many times a line is voiced so the strongest take can be kept: once for a soft or full line, twice at 4,
// three times at 5 (about half of the takes asked for at full power come back with it).
export const takesFor = (power) => Math.max(1, power - 2);

const dB = (v) => 10 * Math.log10(Math.max(v, 1e-12));

// How loud a stretch of her voice is while she's sounding (the mean square of its 20 ms frames that aren't silence),
// in dB; null for silence.
export function soundingLevel(x, rate) {
  const n = Math.max(1, Math.round(rate * 0.02));
  let peak = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > peak) peak = a; }
  if (!(peak > 0)) return null;
  let sum = 0, frames = 0;
  for (let at = 0; at + n <= x.length; at += n) {
    let sq = 0;
    for (let i = at; i < at + n; i++) sq += x[i] * x[i];
    if (Math.sqrt(sq / n) > peak * 0.05) { sum += sq / n; frames++; }
  }
  return frames ? dB(sum / frames) : null;
}

// How much effort is in a take: { level (dB), pitch (the middle of her pitch, MIDI), bright (dB: what's above 2 kHz
// against what's below 1 kHz), voiced (frames), effort }. A voice that's pushed is louder, higher and brighter, and
// a decibel, a semitone and two decibels of brightness count the same. x: mono samples; track: her pitch through it.
export function effortOf(x, rate, track) {
  const level = soundingLevel(x, rate);
  if (level === null) return null;
  const a1 = 1 - Math.exp((-2 * Math.PI * 1000) / rate), a2 = 1 - Math.exp((-2 * Math.PI * 2000) / rate);
  let l1 = 0, l2 = 0, lo = 0, hi = 0;
  for (let i = 0; i < x.length; i++) { l1 += a1 * (x[i] - l1); l2 += a2 * (x[i] - l2); lo += l1 * l1; hi += (x[i] - l2) * (x[i] - l2); }
  const bright = dB(hi / Math.max(lo, 1e-12));
  const notes = track.filter((f) => f.midi !== null).map((f) => f.midi).sort((p, q) => p - q);
  const pitch = notes.length ? notes[notes.length >> 1] : 0;
  return { level: +level.toFixed(1), pitch: +pitch.toFixed(1), bright: +bright.toFixed(1), voiced: notes.length, effort: +(level + pitch + bright / 2).toFixed(1) };
}

// Which of a line's takes is kept: the one with the most effort in it, among those that are really voiced (a take
// that came back mostly breath isn't the strong one, however loud). efforts: effortOf of each (null for silence).
export function strongest(efforts) {
  const most = Math.max(0, ...efforts.map((e) => e?.voiced ?? 0));
  let best = -1;
  efforts.forEach((e, i) => { if (e && e.voiced >= most * 0.6 && (best < 0 || e.effort > efforts[best].effort)) best = i; });
  return Math.max(0, best);
}

// Every line is brought to one level before the chain (-20 dB while sounding), so the chain presses a timid take as
// hard as a strong one. In place; returns the gain used.
export const LINE_LEVEL = -20;
export function levelLine(x, rate, to = LINE_LEVEL) {
  const level = soundingLevel(x, rate);
  if (level === null) return 1;
  const gain = Math.max(0.1, Math.min(16, 10 ** ((to - level) / 20)));
  for (let i = 0; i < x.length; i++) x[i] *= gain;
  return gain;
}

const f = (v) => +v.toFixed(2);
// How far along power is, from the softest line (0) to the strongest (1).
const along = (power) => (Math.max(1, Math.min(5, power)) - 1) / 4;

// The chain one line of her voice goes through, as an ffmpeg filter (mono in, mono out), for a line already at
// LINE_LEVEL. Stronger lines are pressed harder (so every word is as loud as the loudest), lose more of the low
// murk, get more of the 3 kHz a pushed voice has, a little air, and a soft rounding of their peaks that thickens
// them without breaking up; then they're simply louder: 2 dB a step.
// Owner, 2026-11-16: "her words are very distorted sometimes... She needs to sound beautiful and coherent and fluid."
// It used to drive strong lines into a tanh clipper and lift 3.2 kHz by up to 6 dB; measured that day on real lines at
// full power, that chain alone turned "match your smile" into "my true smile". Now a strong line is pressed a little
// harder and brought forward a little, its esses are tamed, and nothing in it distorts on purpose.
export function vocalChain(power) {
  const u = along(power);
  return [
    'highpass=f=80',
    `equalizer=f=280:t=q:w=1.2:g=${f(-1 - 2 * u)}`,
    `acompressor=threshold=0.06:ratio=${f(2 + 2 * u)}:attack=8:release=150:knee=6:makeup=${f(1.3 + 0.6 * u)}`,
    `equalizer=f=3000:t=o:w=1.5:g=${f(0.5 + 2.5 * u)}`,
    'deesser=i=0.4:m=0.5:f=0.5:s=o',
    `highshelf=f=10000:g=${f(1 + 1.5 * u)}`,
    `volume=${f(2 * (power - 3))}dB`,
  ].join(',');
}

// The strongest lines are doubled: her voice again on the left and on the right, a hair sharp and a hair flat and a
// moment late, quieter than the one in the middle. { level (of each side, against the middle), cents, ms } or null.
export const doublesFor = (power) => (power >= 4 ? { level: f(power >= 5 ? 0.42 : 0.3), cents: 10, ms: [13, 21] } : null);

// How deep her vibrato is on a held note (semitones either side): wider the more she's putting into it.
export const vibratoFor = (power) => f(0.2 + 0.08 * power);

// The note a harmony sings against a written note: two notes of the key above it (a third), or below. scale: the
// key's pitch classes.
export function harmonyNote(midi, scale, way = 'high') {
  const step = way === 'low' ? -1 : 1;
  let m = midi;
  for (let found = 0; found < 2;) { m += step; if (scale.includes(((m % 12) + 12) % 12)) found++; }
  return m;
}
// A line's score for the harmony over it: the same syllables and lengths, every note a third above or below in the
// key. When the part above would be out of her reach (top: the highest note she can be moved to, as written), it's
// sung an octave down instead, which is the same harmony underneath.
export function harmonyScore(score, scale, way, top = Infinity) {
  const syllables = score.syllables.map((s) => ({ ...s, notes: s.notes.map((n) => ({ ...n, midi: n.midi === null ? null : harmonyNote(n.midi, scale, way) })) }));
  const highest = Math.max(...syllables.flatMap((s) => s.notes.map((n) => n.midi ?? -Infinity)));
  if (highest > top) for (const s of syllables) for (const n of s.notes) if (n.midi !== null) n.midi -= 12;
  return { ...score, syllables };
}

// ---- the mix ----

export const BAND_UNDER = 6;  // dB the band sits under a full-voiced line of hers while both are sounding
export const MASTER_LEVEL = -16; // dB the finished track sounds at (while sounding)

// One line of her voice into the mix: the chain, then the middle and (doubled) the two sides, laid in at its moment.
// input: ffmpeg's label for the line ("3:a"); out: the label it leaves as; at: seconds into the song; rate: of the
// line's samples; gain: against a lead line (a harmony sits under the line it's over); pan: -1 left to 1 right.
export function lineFilter({ input, out, power, at, rate, gain = 1, pan = 0 }) {
  const ms = Math.max(0, Math.round(at * 1000));
  const left = f(gain * Math.min(1, 1 - pan)), right = f(gain * Math.min(1, 1 + pan));
  const head = `[${input}]${vocalChain(power)},aresample=48000`;
  const place = (l, r, late) => `pan=stereo|c0=${l}*c0|c1=${r}*c0,adelay=${ms + late}|${ms + late}`;
  const d = doublesFor(power);
  if (!d || gain !== 1) return `${head},${place(left, right, 0)}[${out}]`;
  const off = 2 ** (d.cents / 1200);
  return [
    `${head},asplit=3[${out}c][${out}l][${out}r]`,
    `[${out}c]${place(1, 1, 0)}[${out}m]`,
    `[${out}l]asetrate=${Math.round(48000 * off)},aresample=48000,${place(d.level, f(d.level * 0.3), d.ms[0])}[${out}a]`,
    `[${out}r]asetrate=${Math.round(48000 / off)},aresample=48000,${place(f(d.level * 0.3), d.level, d.ms[1])}[${out}b]`,
    `[${out}m][${out}a][${out}b]amix=inputs=3:normalize=0:dropout_transition=0[${out}]`,
  ].join(';');
}

// The room her voice is put in, as an ffmpeg filter over the voice itself: a handful of early echoes and one late
// one, quiet enough that it's heard as space, not as an echo.
export const ROOM = 'aecho=1:1:29|43|67|101|149|211:0.1|0.085|0.07|0.055|0.04|0.03,aecho=1:1:331:0.05';

// The whole mix as an ffmpeg filter graph. Input 0 is the band; lines: [{ input, power, at, gain?, pan? }] (her
// voice, each a mono stream at `rate`); bandGain: what the band is multiplied by so it sits BAND_UNDER her (bandGainFor).
// Her lines are summed, put in a room (early echoes and a short tail, kept out of the lows), and the band gives way
// a little while she's singing. Leaves [out].
export function mixGraph({ lines, rate, bandGain }) {
  const parts = lines.map((l, i) => lineFilter({ ...l, out: `v${i}`, rate }));
  const sum = lines.length > 1 ? `${lines.map((_, i) => `[v${i}]`).join('')}amix=inputs=${lines.length}:normalize=0:dropout_transition=0` : '[v0]anull';
  return [
    ...parts,
    `${sum},asplit=3[dry][wet][key]`,
    '[wet]highpass=f=300,lowpass=f=6500,aecho=1:1:29|43|67|101|149|211:0.42|0.36|0.3|0.24|0.18|0.13,aecho=1:1:331:0.3,volume=0.2[room]',
    `[0:a]aresample=48000,aformat=channel_layouts=stereo,volume=${f(bandGain)}[band]`,
    '[band][key]sidechaincompress=threshold=0.06:ratio=2:attack=20:release=300[under]',
    '[under][dry][room]amix=inputs=3:normalize=0:dropout_transition=0[out]',
  ].join(';');
}

// What the band is multiplied by so it sits BAND_UNDER a full-voiced line. bandLevel: soundingLevel of the band as
// rendered (null for a silent one, which is left as it is). A full line leaves the chain about 2 dB over LINE_LEVEL.
export function bandGainFor(bandLevel) {
  if (bandLevel === null) return 1;
  return Math.max(0.05, Math.min(8, 10 ** ((LINE_LEVEL + 2 - BAND_UNDER - bandLevel) / 20)));
}
// What the finished mix is multiplied by to sound at MASTER_LEVEL (a limiter after it catches the peaks).
export const masterGainFor = (mixLevel) => (mixLevel === null ? 1 : Math.max(0.1, Math.min(12, 10 ** ((MASTER_LEVEL - mixLevel) / 20))));
