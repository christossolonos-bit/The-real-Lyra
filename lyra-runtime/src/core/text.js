// Lyra Core: plain text tools. No language model anywhere in here, just counting and comparing words.

const STOP = new Set(('a an the and or but so to of in on at for with from by is are was were be been am i you he she it we they me my your ' +
  'his her its our their this that these those do does did have has had just really very too also not no yes oh well ' +
  'what who how why when where which there here then than can could would should will shall may might must about up out').split(' '));

export const stripTags = (s) => String(s ?? '').replace(/\[\[[^\]]*\]\]/g, '').replace(/\s+/g, ' ').trim();

// a light stemmer: enough that "talking", "talked" and "talks" count as the same word
export function stem(w) {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

export const words = (s) => String(s ?? '').toLowerCase().replace(/’/g, "'").match(/[a-z0-9']+/g) ?? [];
// content words, stemmed, unique: the "meaning" of a line for comparing
export const keyWords = (s) => [...new Set(words(s).filter((w) => !STOP.has(w) && w.length > 1).map(stem))];

// 64-bit similarity fingerprint (two 32-bit halves): near-identical lines get near-identical prints.
// 16 characters per line instead of a 1,000-number vector.
function fnv(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}
export function fingerprint(toks) {
  const v = new Array(64).fill(0);
  for (const t of toks) {
    const a = fnv(t, 2166136261), b = fnv(t, 3323198485);
    for (let i = 0; i < 32; i++) { v[i] += (a >>> i) & 1 ? 1 : -1; v[32 + i] += (b >>> i) & 1 ? 1 : -1; }
  }
  let hi = 0, lo = 0;
  for (let i = 0; i < 32; i++) { if (v[i] > 0) lo |= 1 << i; if (v[32 + i] > 0) hi |= 1 << i; }
  return (hi >>> 0).toString(16).padStart(8, '0') + (lo >>> 0).toString(16).padStart(8, '0');
}
const pop = (x) => { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0xf0f0f0f) * 0x1010101) >>> 24; };
export function hamming(a, b) {
  if (!a || !b) return 64;
  return pop((parseInt(a.slice(0, 8), 16) ^ parseInt(b.slice(0, 8), 16)) >>> 0) + pop((parseInt(a.slice(8), 16) ^ parseInt(b.slice(8), 16)) >>> 0);
}

export function jaccard(a, b) {
  if (!a.length && !b.length) return 1;
  const A = new Set(a); let n = 0;
  for (const x of b) if (A.has(x)) n++;
  return n / (A.size + b.length - n || 1);
}

export const sentences = (s) => (stripTags(s).match(/[^.!?…]+[.!?…]*["')\]]*/g) ?? []).map((x) => x.trim()).filter((x) => x.length > 1);

// what job a sentence does in a reply
export function role(s) {
  const l = s.toLowerCase();
  if (/^(hi|hey|hello|hiya|yo|morning|good (morning|afternoon|evening)|evening|welcome back)\b/.test(l)) return 'greet';
  if (/\b(good ?night|see you|bye|talk (to you )?later|sleep well|take care)\b/.test(l)) return 'bye';
  if (/^(ha(ha)+|lol|heh)\b/.test(l)) return 'laugh';
  if (/\b(sorry|that sounds (hard|rough|tough)|i hear you|must be|i'm here)\b/.test(l)) return 'care';
  if (/\b(thank(s| you)|appreciate)\b/.test(l)) return 'thanks';
  if (/\?["')]*$/.test(s)) return 'ask';
  return 'say';
}
export const shapeOf = (reply) => sentences(reply).map(role).join('+') || 'say';

// names become slots, so "Morning, Chris" can be reused for anyone she knows
export function toTemplate(s, name) {
  if (!name) return s;
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return s.replace(new RegExp(`\\b${n}\\b`, 'g'), '{name}');
}
export const fill = (s, name) => s.replace(/\{name\}/g, name || 'you');

// How close her own draft is to the teacher's reply, 0-1: shared meaning, the same shape, a similar length.
export function closeness(draft, teacher) {
  if (!draft || !teacher) return 0;
  const a = keyWords(draft), b = keyWords(teacher);
  const shared = b.filter((w) => a.includes(w)).length;
  const p = a.length ? shared / a.length : 0, r = b.length ? shared / b.length : 0;
  const f1 = p + r ? (2 * p * r) / (p + r) : 0;
  const sa = shapeOf(draft).split('+'), sb = shapeOf(teacher).split('+');
  let same = 0; for (let i = 0; i < Math.min(sa.length, sb.length); i++) if (sa[i] === sb[i]) same++;
  const shape = same / Math.max(sa.length, sb.length);
  const la = draft.length, lb = teacher.length, len = Math.min(la, lb) / Math.max(la, lb);
  return Math.round((0.6 * f1 + 0.25 * shape + 0.15 * len) * 1000) / 1000;
}

// How someone reacted to what she said last, -1..1 (her reward signal).
const POS = /\b(ha(ha)+|lol|lmao|thanks?|thank you|love (it|that|you)|nice|great|perfect|exactly|yes+|yeah|cool|awesome|amazing|good (one|girl|job)|right|true|cute|beautiful|wow)\b|😂|❤|😊|👍/i;
const NEG = /\b(no+|nope|wrong|not (what|true|right)|that's not|stop|shut up|boring|weird|annoying|what\?|huh|you already said|you said that|that makes no sense|don't)\b|👎/i;
export function reaction(text) {
  const t = String(text ?? '');
  const p = POS.test(t), n = NEG.test(t);
  return p && !n ? 1 : n && !p ? -1 : p && n ? -0.2 : 0;
}
