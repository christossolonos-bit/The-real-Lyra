// What key a voice sang in (sing.js: her voice picks its own melody, so the band has to come to her, not the other
// way round). Pure: 16 kHz mono PCM16 in, a key out. The pitch of each stretch is found by autocorrelation (the lag at
// which the sound best repeats itself); each pitched stretch counts toward its note's pitch class, weighted by how
// loud and how clearly pitched it was; the twelve counts are then matched against the Krumhansl-Kessler profiles of
// every major and minor key, and the closest wins.

const RATE = 16000;
const FRAME = 1024, HOP = 512;
const MIN_HZ = 80, MAX_HZ = 1000;
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

// The pitch of one frame in Hz, and how clearly it's pitched (0..1); null when it isn't (breath, consonants, quiet).
// minHz: the lowest pitch looked for (80 by default; her own voice goes lower, so following it asks for less: retune.js).
// minClarity: how well a frame has to repeat itself to count as pitched (0.6 by default).
export function framePitch(x, rate = RATE, { minHz = MIN_HZ, minClarity = 0.6 } = {}) {
  let energy = 0;
  for (let i = 0; i < x.length; i++) energy += x[i] * x[i];
  if (energy / x.length < 1e-5) return null;
  const minLag = Math.floor(rate / MAX_HZ), maxLag = Math.min(x.length - 1, Math.ceil(rate / minHz));
  const rs = new Float64Array(maxLag + 2);
  let best = -1, bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let num = 0, a = 0, b = 0;
    for (let i = 0; i + lag < x.length; i++) { num += x[i] * x[i + lag]; a += x[i] * x[i]; b += x[i + lag] * x[i + lag]; }
    const r = num / Math.sqrt(a * b || 1);
    rs[lag] = r;
    if (r > best) { best = r; bestLag = lag; }
  }
  if (best < minClarity || !bestLag) return null;
  // A sound that repeats every period also repeats every two and four: the period is the shortest lag that matches
  // nearly as well as the best, not whichever multiple happened to score a hair higher (that reads an octave low).
  for (let lag = minLag + 1; lag < bestLag; lag++) {
    if (rs[lag] >= best * 0.95 && rs[lag] >= rs[lag - 1] && rs[lag] >= rs[lag + 1]) { best = rs[lag]; bestLag = lag; break; }
  }
  return { hz: rate / bestLag, clarity: best, energy: Math.sqrt(energy / x.length) };
}

// The twelve pitch-class weights of a stretch of singing.
export function pitchClasses(pcm, rate = RATE) {
  const n = Math.floor(pcm.length / 2);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = pcm.readInt16LE(i * 2) / 32768;
  const hist = new Array(12).fill(0);
  for (let at = 0; at + FRAME <= n; at += HOP) {
    const p = framePitch(x.subarray(at, at + FRAME), rate);
    if (!p) continue;
    const midi = 69 + 12 * Math.log2(p.hz / 440);
    hist[((Math.round(midi) % 12) + 12) % 12] += p.clarity * p.energy;
  }
  return hist;
}

const pearson = (a, b) => {
  const ma = a.reduce((s, v) => s + v, 0) / a.length, mb = b.reduce((s, v) => s + v, 0) / b.length;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : 0;
};

// The key closest to a pitch-class weighting: { name: 'D minor', tonic: 'D', mode, score }, or null with nothing sung.
export function keyOf(hist) {
  if (!hist.some((v) => v > 0)) return null;
  let best = null;
  for (let t = 0; t < 12; t++) {
    for (const [mode, profile] of [['major', MAJOR], ['minor', MINOR]]) {
      const rotated = profile.map((_, i) => profile[(i - t + 12) % 12]);
      const score = pearson(hist, rotated);
      if (!best || score > best.score) best = { name: `${NAMES[t]} ${mode}`, tonic: NAMES[t], mode, score: +score.toFixed(3) };
    }
  }
  return best;
}
