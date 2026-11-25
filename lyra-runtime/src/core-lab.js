// The Core lab (2026-11-25): a baby mind that learns to talk by talking with Lyra, live.
//
// The baby is the same learning engine as Lyra's Core (core/core.js: no language model inside) but its own, separate
// memory (data/baby-mind.db), starting empty. Lyra's main Core is never touched. Like a baby, when it knows nothing
// it imitates (echoes a word or two of what Lyra just said); as it collects her sentences it answers with them.
//
// One exchange:
//   1. Lyra (Nemotron) says something short and simple to it, on a topic.
//   2. The baby answers with its own draft, built only from what it has learned (or a babble).
//   3. Lyra reacts (praises, gently corrects) and also gives the answer she'd have liked to her line. The baby
//      learns from that answer straight away (observe), and the page shows how close its own answer came.
// With a Discord voice call open, both speak in it: Lyra in her voice, the baby in its own (BABY_FISH_VOICE_ID).
// The pace is calm (one exchange every few seconds), and a session stops itself after MAX_EXCHANGES.
import path from 'node:path';
import { rmSync } from 'node:fs';
import { DATA_DIR, config } from './config.js';
import { activity } from './events.js';
import { createCore } from './core/core.js';
import { keyWords, words } from './core/text.js';

const FILE = path.join(DATA_DIR, 'baby-mind.db');
const MAX_EXCHANGES = 60;
const PAUSE_MS = 4000;          // between exchanges without voices (about 1 NVIDIA request each)
const BUDGET_PER_MIN = 20;      // of NVIDIA's ~40 free requests a minute, at most this many while the lab runs
let baby = createCore({ file: FILE, slots: true });
const lab = { running: false, topic: '', transcript: [], scores: [], exchanges: 0, started: 0, error: '', voice: false, voices: false, waiting: false, stopping: false };

// what it says when it has learned nothing that fits: imitation, like a baby repeating the last words it heard
function babble(line) {
  const all = words(line).filter((w) => w.length > 2);
  const keys = keyWords(line);
  const pick = all.filter((w) => keys.some((k) => w.startsWith(k))).slice(-2);
  const out = (pick.length ? pick : all.slice(-1)).join(' ');
  return out ? `${out[0].toUpperCase()}${out.slice(1)}...?` : '...';
}

const say = (who, text, extra = {}) => {
  lab.transcript.push({ who, text, at: Date.now(), ...extra });
  if (lab.transcript.length > 200) lab.transcript.splice(0, lab.transcript.length - 200);
};

// Growing up (2026-11-25): Lyra teaches longer answers as the baby knows more phrases, so its answers get longer
// over the sessions. Each stage sets how she talks to it and what a good answer from it looks like.
export const STAGES = [
  { name: 'baby', from: 0, length: '1 short sentence',
    lyra: 'Keep everything very short and simple: plain spoken English, 1 short sentence, one idea at a time, the kind of sentence you want it to say back.',
    better: 'one short, simple sentence, like a toddler ("I feel happy." or "Yes, I like rain.").' },
  { name: 'toddler', from: 40, length: '1 or 2 short sentences',
    lyra: 'Talk simply, 1 or 2 short sentences. Start asking "why" and "what happened" questions, and help it say a reason.',
    better: 'one or two short sentences, often with a reason ("I like rain because it sounds calm." or "I was sad. My toy broke.").' },
  { name: 'child', from: 120, length: '2 or 3 sentences',
    lyra: 'Talk like to a young child, 2 or 3 sentences. Ask it to tell you about things, to describe, to remember, and to ask you something back.',
    better: 'two or three sentences: a little story, a description or a feeling with a reason, sometimes ending with a question back to you ("I played with blocks today. I built a tall tower. Do you like towers, Lyra?").' },
  { name: 'big kid', from: 300, length: '3 to 5 sentences',
    lyra: 'Talk naturally, as to a bright older child. Ask what it thinks and why, ask it to compare things, imagine, and explain.',
    better: 'three to five sentences with its own opinion, a reason and an example; it can be curious and ask you questions.' },
];
export function stageOf(phrases = 0) {
  const i = STAGES.reduce((k, s, n) => (phrases >= s.from ? n : k), 0);
  const next = STAGES[i + 1];
  return { ...STAGES[i], level: i + 1, of: STAGES.length, next: next ? { name: next.name, at: next.from } : null };
}

// Lyra's side: her next line, and the answer she'd have liked to her previous line, written by the free small
// models in turn (the same free NVIDIA key as her replies)
async function lyraTurn(prevLine) {
  const { nvidiaJson } = await import('./llm.js');
  const recent = lab.transcript.slice(-12).map((t) => `${t.who === 'lyra' ? 'Lyra' : 'Baby'}: ${t.text}`).join('\n');
  const st = stageOf(baby.stats().phrases);
  const messages = [
    { role: 'system', content:
      `You are Lyra, a warm AI, teaching a young mind (the Baby) to talk. It is at the ${st.name.toUpperCase()} stage. The Baby has no language model: it learns ONLY by copying the exact sentences you use as good answers, and it reuses them later when a moment looks similar. ` +
      `${st.lyra} ` +
      'Each turn: react to what the Baby just said (praise any attempt, gently say how to say it better), then move on: a new simple question or thought' +
      `${lab.topic ? ` about ${lab.topic}` : ''}. Teach like a parent, not a drill: ask real questions in different ways ("How do you feel when…?", "What do you like…?", "Do you…?", "Why…?"), ` +
      'never "Can you say…" or "repeat after me". Every few turns, a new small situation (rain, a lost toy, a friend, food, bedtime…), and sometimes ask about something it learned earlier in a new way, to see if it can use it. Never say the same line twice. ' +
      `"better" is how the Baby should answer your line at this stage: ${st.better} Never use the real name of your creator or anything private.\n` +
      `Reply with JSON only: {"better": "<the answer you would have liked the Baby to give to your previous line, in first person as the Baby, ${st.length}; empty if there was no previous line>", "say": "<your next line to the Baby>"}` },
    { role: 'user', content: `${recent ? `The conversation so far:\n${recent}\n\n` : 'This is the very start: greet the Baby and ask it something simple.\n'}${prevLine ? `Your previous line was: "${prevLine}"` : ''}` },
  ];
  // the teacher this turn: the free small models in turn (Bolt, Lightning, Gemma), not Nemotron 120B (2026-11-25),
  // so the baby doesn't grow up on one model's style; the next one answers if one fails
  const { nextTeachers } = await import('./llm.js');
  for (const model of nextTeachers()) {
    try {
      const j = await nvidiaJson(messages, model, { timeoutMs: 20_000, maxTokens: 300, temperature: 0.7 });
      if (j && typeof j.say === 'string' && j.say.trim()) return { say: j.say.trim().slice(0, 300), better: String(j.better || '').trim().slice(0, 300), model };
    } catch {}
  }
  throw new Error("Lyra's models didn't answer (NVIDIA busy?)");
}

async function voiceSession() {
  try { const { sessions } = await import('./voice/session.js'); return [...sessions.values()].find((s) => !s.destroyed) || null; } catch { return null; }
}
async function speak(session, text, voiceId) {
  if (!session || !text) return;
  try { await session.speakAs(text, { voiceId }); } catch (err) { activity('error', { where: 'core lab voice', message: err.message }); }
}

async function run() {
  let prev = '';
  let babyVoice = process.env.BABY_FISH_VOICE_ID || '';
  try {
    const { nvidiaCallsLastMinute } = await import('./llm.js');
    while (lab.running && !lab.stopping && lab.exchanges < MAX_EXCHANGES) {
      // free NVIDIA limit is ~40 requests a minute: the lab waits while 20+ were used, so her replies always fit
      while (nvidiaCallsLastMinute() >= BUDGET_PER_MIN && lab.running && !lab.stopping) {
        lab.waiting = true;
        await new Promise((ok) => setTimeout(ok, 2000));
      }
      lab.waiting = false;
      if (!lab.running || lab.stopping) break;
      // voices cost Fish Audio credits: only when he turned them on and a call is open
      const session = lab.voices ? await voiceSession() : null;
      lab.voice = Boolean(session);
      // 1. Lyra: the answer she'd have liked to her last line (the baby learns it now), and her next line
      const turn = await lyraTurn(prev);
      lab.lastTurn = { ...turn, prev };
      if (prev && turn.better) {
        const before = stageOf(baby.stats().phrases).level;
        const learned = baby.observe({ speaker: { id: 'lyra', name: 'Lyra' }, text: prev, reply: turn.better });
        if (learned) {
          const score = Math.round((learned.score || 0) * 100);
          lab.scores.push(score);
          const last = [...lab.transcript].reverse().find((t) => t.who === 'baby');
          if (last) Object.assign(last, { closeness: score, better: turn.better });
        }
        const now = stageOf(baby.stats().phrases);
        if (now.level > before) {
          say('note', `🎉 The baby grew up: it's a ${now.name} now. Lyra will teach longer answers (${now.length}).`);
          activity('core', { message: `Core lab: the baby mind grew up to the ${now.name} stage` });
        }
      }
      if (!lab.running || lab.stopping) break;
      say('lyra', turn.say, { model: turn.model.split('/').pop() });
      await speak(session, turn.say);
      // 2. the baby answers from what it has learned, or babbles
      const d = baby.draft(turn.say, { id: 'lyra', name: 'Lyra' });
      const text = d.text?.trim() || babble(turn.say);
      say('baby', text, { from: d.text?.trim() ? d.from : 'imitating (nothing learned for this yet)', confidence: d.confidence || 0 });
      await speak(session, text, babyVoice || undefined);
      lab.exchanges++;
      prev = turn.say;
      await new Promise((ok) => setTimeout(ok, session ? 800 : PAUSE_MS));
    }
  } catch (err) {
    lab.error = err.message;
    activity('error', { where: 'core lab', message: err.message });
  } finally {
    lab.running = false;
    lab.stopping = false;
    activity('core', { message: `Core lab session ended after ${lab.exchanges} exchanges` });
  }
}

// ---------- the dashboard page (/core-lab.html) ----------
let nvidiaCallsNow = () => 0;
import('./llm.js').then((m) => { nvidiaCallsNow = m.nvidiaCallsLastMinute; }).catch(() => {});
// voices on or off while it runs (he can switch them mid-conversation)
export function labVoices(on) { lab.voices = Boolean(on); return { ok: true, message: on ? 'Voices on (in the Discord call).' : 'Voices off: text only.' }; }
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export function labStart({ topic = '', voices = false } = {}) {
  if (lab.running) throw fail('A conversation is already running.', 409);
  if (config.brain !== 'nvidia') throw fail('The Core lab needs the NVIDIA brain.', 409);
  Object.assign(lab, { running: true, stopping: false, voices: Boolean(voices), topic: String(topic).trim().slice(0, 80), exchanges: 0, started: Date.now(), error: '' });
  say('note', `Conversation started${lab.topic ? ` about ${lab.topic}` : ''}.`);
  activity('core', { message: `Core lab: Lyra is talking with the baby mind${lab.topic ? ` about ${lab.topic}` : ''}` });
  run();
  return { ok: true, message: 'Lyra is talking with the baby mind.' };
}
export function labStop() {
  if (!lab.running) return { ok: true, message: "They weren't talking." };
  lab.stopping = true;
  say('note', 'Stopping after this line…');
  return { ok: true, message: 'Stopping after this line.' };
}
export function labReset() {
  if (lab.running) throw fail('Stop the conversation first.', 409);
  baby.close();
  for (const f of [FILE, `${FILE}-wal`, `${FILE}-shm`]) rmSync(f, { force: true });
  baby = createCore({ file: FILE, slots: true });
  Object.assign(lab, { transcript: [], scores: [], exchanges: 0, error: '' });
  return { ok: true, message: 'The baby mind starts over, knowing nothing.' };
}
export function labSnapshot() {
  const s = baby.stats();
  return {
    running: lab.running, stopping: lab.stopping, topic: lab.topic, exchanges: lab.exchanges, max: MAX_EXCHANGES, error: lab.error,
    voice: lab.voice, voices: lab.voices, waiting: lab.waiting, babyVoice: Boolean(process.env.BABY_FISH_VOICE_ID),
    requestsLastMinute: nvidiaCallsNow(), budget: BUDGET_PER_MIN, lastTurn: lab.lastTurn || null,
    transcript: lab.transcript.slice(-60), scores: lab.scores.slice(-120),
    mind: { exchanges: s.exchanges, phrases: s.phrases, averageCloseness: s.averageCloseness, skills: s.skills.slice(0, 8), beliefs: s.beliefs.slice(0, 12), topPhrases: s.topPhrases.slice(0, 10), patterns: s.patterns || [], patternCount: s.patternCount || 0,
      stage: (({ name, level, of, next, length }) => ({ name, level, of, next, length }))(stageOf(s.phrases)) },
  };
}

// ---------- Lyra's own look at the lab (2026-11-25: asked to "check again", she said the baby needs "about 20
// phrases" to be a toddler; it's 40, and she had no way to look) ----------
function labReport() {
  const s = labSnapshot();
  const m = s.mind, st = m.stage;
  const last = s.scores.slice(-10);
  const close = last.length ? Math.round(last.reduce((a, b) => a + b, 0) / last.length) : null;
  return `The baby mind, right now: stage "${st.name}" (${st.level} of ${st.of}; answers ${st.length}). ` +
    `It knows ${m.phrases} phrases and ${m.patternCount} patterns, from ${m.exchanges} lessons. ` +
    (st.next ? `It grows into a ${st.next.name} at ${st.next.at} phrases: ${Math.max(0, st.next.at - m.phrases)} more to go. ` : 'It is fully grown for now. ') +
    (close !== null ? `Its last ${last.length} answers came ${close}% close on average. ` : '') +
    (s.running ? `A conversation is running now (${s.exchanges} of ${s.max} exchanges${s.topic ? `, about ${s.topic}` : ''}${s.voice ? ', in the Discord call' : ''}).` : 'No conversation is running.') +
    (m.topPhrases.length ? ` Phrases it uses most: ${m.topPhrases.slice(0, 4).map((p) => `"${p.text}"`).join(', ')}.` : '') +
    ' Use these exact numbers.';
}

export const CORE_LAB_TOOLS = {
  core_lab: {
    enabled: (ctx) => Boolean(ctx?.perms?.owner),
    definition: { type: 'function', function: {
      name: 'core_lab',
      description: 'The Core lab, where you teach the baby mind to talk. status = its real progress (stage, phrases, how many until the next stage, closeness, whether a lesson is running): check this before saying anything about it. ' +
        'start = begin a lesson (topic optional; voices = speak in the Discord call), only when Chris asks. stop = end the running lesson.',
      parameters: { type: 'object', properties: {
        action: { type: 'string', enum: ['status', 'start', 'stop'] },
        topic: { type: 'string' }, voices: { type: 'boolean' },
      }, required: ['action'] },
    } },
    run: async (a) => {
      try {
        if (a.action === 'status') return labReport();
        if (a.action === 'start') return `${labStart({ topic: a.topic || '', voices: Boolean(a.voices) }).message} ${labReport()}`;
        if (a.action === 'stop') return labStop().message;
        return 'Error: action must be status, start or stop.';
      } catch (err) { return `Error: ${err.message}`; }
    },
  },
};
