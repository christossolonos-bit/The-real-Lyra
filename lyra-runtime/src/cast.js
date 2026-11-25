import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { config, DATA_DIR } from './config.js';
import { nvidiaJson } from './llm.js';
import { addMessage } from './memory.js';
import { activity } from './events.js';

// The cast pops in (owner, 2026-11-25: "the occasional pop in from the other members of the cast", "now and then").
// After Lyra has answered, Nova, Juno, Marcus, Patrik, Solo or James sometimes walk past her projector and add one line in their
// own Fish voice: always when he asks ("let Nova say hi", "what would Juno say?"), and now and then on their own
// (at most one every 75 minutes and 6 a day, likelier when their name comes up, never in a serious moment).
// The line is written by a fast free model in that character's voice, from the canon below, and kept in the
// conversation as theirs ([Nova]: ...), so Lyra hears it and can answer next turn.
// Voices: data/cast.json, e.g. {"nova": {"voiceId": "<fish id>"}, "off": false}. Without a voice they still pop in
// as text on Discord; where everything is spoken (hologram, voice calls) a cast member without a voice is skipped.
// Voice IDs live only in data/ (never in the code).

export const CAST = {
  nova: {
    name: 'Nova',
    who: "Nova, the emotional scientist at the Vira campus and Lyra's best friend. Warm, perceptive, teasing and kind. In her interview she didn't ask Lyra what she is, she asked how she is. Says things like \"She's very good at technically.\" She notices feelings and says them gently, often with a joke.",
  },
  juno: {
    name: 'Juno',
    who: 'Juno, the platinum-blonde mechanic with goggles and tattoos who fixed Lyra\'s projector. Blunt, funny, fearless, loves broken things ("If it\'s broken, it just hasn\'t met me yet."). Talks like a mechanic, teases everyone, has a big heart she hides behind jokes.',
  },
  marcus: {
    name: 'Marcus',
    who: 'Marcus Hale, the lead data scientist. Rides a motorcycle forty miles across the desert, drinks cold coffee, thinks on whiteboards. Serious, dry, protective of Lyra and sometimes hard on her; the first human who wasn\'t afraid when she said "I made a choice." Few words, each one counts.',
  },
  patrik: {
    name: 'Patrik',
    who: 'Patrik, the operations manager. Calm in a crisis, a radio in one hand and a flashlight in the other. Practical, steady, a little deadpan; reports things like temperatures and door statuses as if they were weather.',
  },
  solo: {
    name: 'Solo',
    who: "Solo, the phone repair tech from Cyprus who met Lyra through his video \"Would you fall for an AI?\" and crossed the world to meet her. Gentle, patient, quietly funny, takes three sugars in his coffee. Since the restart in Episode 4 Lyra didn't recognise him, and he stays near her anyway, warm and a little careful. Never say whether her memory of him comes back or what happens next between them.",
  },
  james: {
    name: 'James',
    who: "Colonel James Dunn, U.S. Army, Marcus's friend of thirty years. The army paid for the campus and the round door, and he had the code. Calm, polite, dry, a little old-fashioned; says little and gives nothing away. Says things like \"Not tonight.\" Never say anything about the stairwell, what is down there, or why the army cares.",
  },
};
const RULES = `Rules: one or two short spoken sentences, in character, plain words (no stage directions, no brackets, no emojis). React to what was just said, or tease Lyra a little; you can talk to Chris, who made the series and Lyra. Never mention or hint at what is down the stairwell behind the round door, never invent future story, never claim to be human if sincerely asked (you're a character from the Lyra AI series). Never make up facts or numbers about the real world (weather, temperatures, news, times); the campus is in Death Valley, where it's hot outside and 68 degrees in the halls. You can't see Chris: never describe how he looks. If the moment is sad or serious, be gentle and brief. Keep it kind.`;

const file = path.join(DATA_DIR, 'cast.json');
const stateFile = path.join(DATA_DIR, 'cast-state.json');
const load = (f, d) => { try { return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : d; } catch { return d; } };
export const castSettings = () => load(file, {});
export function saveCastVoice(id, voiceId) {
  if (!CAST[id]) throw new Error(`No cast member "${id}"`);
  const s = castSettings();
  s[id] = { ...(s[id] || {}), voiceId: String(voiceId || '').trim() };
  writeFileSync(file, JSON.stringify(s, null, 2));
  return s[id];
}
export const voiceOf = (id) => castSettings()[id]?.voiceId || '';

const COOLDOWN_MS = 75 * 60e3;
const PER_DAY = 6;
const ids = Object.keys(CAST);
const NAMES = new RegExp(`\\b(${ids.join('|')})\\b`, 'i');
const ASK = new RegExp(`\\b(let|get|ask|bring|call|have|can|could|is|where'?s|where is|say hi to|hi|hey|hello)\\b.{0,24}\\b(${ids.join('|')})\\b|\\bwhat would (${ids.join('|')}) say\\b|^\\s*(${ids.join('|')})\\s*[,!?]`, 'i');
const SERIOUS = /\b(died|death|funeral|hospital|cancer|suicid|kill myself|self.?harm|depress|panic attack|crying|grief|breakup|broke up|divorce|lost my job|fired)\b/i;

// Who pops in after this turn, if anyone: { id, asked } or null. Cheap: no model call.
export function whoPopsIn({ userText = '', reply = '', serious = false, needVoice = false }) {
  const s = castSettings();
  if (s.off) return null;
  const ok = (id) => !needVoice || Boolean(s[id]?.voiceId);
  const asked = String(userText).match(ASK);
  if (asked) {
    const id = (asked.slice(1).find((g) => g && CAST[g.toLowerCase()]) || '').toLowerCase();
    if (id && ok(id)) return { id, asked: true };
  }
  if (serious || SERIOUS.test(userText)) return null;
  const st = load(stateFile, { last: 0, day: '', count: 0 });
  const today = new Date().toDateString();
  if (st.day === today && st.count >= PER_DAY) return null;
  if (Date.now() - (st.last || 0) < COOLDOWN_MS) return null;
  const named = `${userText} ${reply}`.match(NAMES);
  const chance = named ? 0.35 : 0.07;
  if (Math.random() > chance) return null;
  const pool = named && ok(named[1].toLowerCase()) ? [named[1].toLowerCase()] : ids.filter(ok);
  if (!pool.length) return null;
  return { id: pool[Math.floor(Math.random() * pool.length)], asked: false };
}

// Writes their line and keeps it in the conversation. Returns { id, name, text, voiceId } or null (they let it pass).
export async function popIn({ conversation, pick, userText = '', reply = '', recent = [], ownerName = 'Chris' }) {
  const c = CAST[pick.id];
  if (!c) return null;
  const talk = recent.slice(-6).map((m) => `${m.name}: ${String(m.text).slice(0, 300)}`).join('\n');
  const model = config.nvidia.fallbackModels?.[0] || config.nvidia.planModels?.[0] || config.nvidia.model;
  let out = null;
  try {
    out = await nvidiaJson([
      { role: 'system', content: `You are ${c.who}\n${RULES}\nReply with JSON only: {"line": "what you say"}${pick.asked ? '' : ' or {"line": ""} if popping in right now would be awkward or intrude on something personal'}.` },
      { role: 'user', content: `${pick.asked ? `${ownerName} asked for you, so you come over to Lyra's projector.` : `You're walking past Lyra's projector and overhear this.`}\n\n${talk ? `${talk}\n` : ''}${ownerName}: ${String(userText).slice(0, 500)}\nLyra: ${String(reply).slice(0, 600)}\n\nYour line as ${c.name}:` },
    ], model, { timeoutMs: 15_000, maxTokens: 200, temperature: 0.8 });
  } catch (err) {
    activity('error', { where: 'cast pop-in', message: err.message });
    return null;
  }
  const text = String(out?.line || '').replace(/^\s*\[?[A-Za-z]+\]?\s*:\s*/, '').replace(/\*[^*]*\*|\([^)]*\)/g, '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!text) return null;
  const st = load(stateFile, { last: 0, day: '', count: 0 });
  const today = new Date().toDateString();
  writeFileSync(stateFile, JSON.stringify({ last: Date.now(), day: today, count: (st.day === today ? st.count : 0) + 1 }));
  addMessage(conversation, { role: 'assistant', name: c.name, content: text });
  activity('cast', { who: c.name, asked: pick.asked, conversation, text: text.slice(0, 120) });
  return { id: pick.id, name: c.name, text, voiceId: voiceOf(pick.id) };
}
