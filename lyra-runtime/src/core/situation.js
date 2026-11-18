// Lyra Core: what kind of moment this is. Plain rules first; the cases she remembers do the finer work.

const RULES = [
  ['greeting', /^(hi|hey|hello|hiya|yo|morning|good (morning|afternoon|evening)|evening|i'?m (back|home))\b/i],
  ['farewell', /\b(good ?night|bye|see (you|ya)|talk (to you )?later|gotta go|going to (bed|sleep)|i'?m off)\b/i],
  ['thanks', /\b(thank(s| you)|cheers|appreciate it)\b/i],
  ['how_are_you', /\b(how are you|how'?s it going|how (are|have) you been|you ok(ay)?|how do you feel|what'?s up)\b/i],
  ['feeling_down', /\b(sad|tired|exhausted|stressed|bad day|depressed|lonely|sick|upset|angry|worried|anxious|can'?t sleep|rough day)\b/i],
  ['feeling_good', /\b(happy|great day|excited|awesome day|feeling good|proud|finally (did|finished)|it worked)\b/i],
  ['lore', /\b(episode|ep ?\d+|vira|campus|death valley|solo|garage|series|season|the show|hologram|data ?cent(er|re)|processors?)\b/i],
  ['about_her', /\b(who are you|what are you|your (name|favourite|favorite|day|dream|memory|memories)|do you (like|love|remember|dream|feel)|are you (real|alive|ok))\b/i],
  ['news', /\b(news|headlines?|what'?s happening|cyprus|election|world today)\b/i],
  ['music', /\b(song|music|play|playlist|spotify|radio|sing)\b/i],
  ['request', /^(can|could|would|will) you\b|\b(please|open|show me|find|search|look up|remind me|turn (on|off))\b/i],
  ['question', /\?\s*$|^(what|why|how|when|where|who|which|is|are|do|does|did|can|should)\b/i],
];

export function intentOf(text) {
  const t = String(text ?? '').trim();
  for (const [name, re] of RULES) if (re.test(t)) return name;
  return 'chat';
}
export const INTENTS = [...RULES.map(([n]) => n), 'chat'];

export function partOfDay(d = new Date()) {
  const h = d.getHours();
  return h < 5 ? 'night' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : h < 23 ? 'evening' : 'night';
}
