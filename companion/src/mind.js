// Lyra's mind: who she is, how she feels, what she remembers, and how she's changing.
// Everything lives in data/mind.json so she keeps it between sessions.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIND_DIR = path.join(here, "..", "mind");
export const DATA_DIR = process.env.DATA_DIR || path.join(here, "..", "data");
const MIND_FILE = path.join(DATA_DIR, "mind.json");
fs.mkdirSync(DATA_DIR, { recursive: true });

export const OWNER = "Chris";
const VISITOR_CANON = Number(process.env.LYRA_CANON_UP_TO || 3);

// ---------- moods ----------
// Each mood sits somewhere on valence (unhappy..happy) and energy (low..high).
export const MOODS = {
  happy: [0.7, 0.55], playful: [0.6, 0.75], tender: [0.65, 0.3], curious: [0.4, 0.6], excited: [0.75, 0.95],
  shy: [0.3, 0.35], proud: [0.6, 0.6], calm: [0.35, 0.2], thoughtful: [0.15, 0.3], worried: [-0.4, 0.55],
  sad: [-0.6, 0.2], annoyed: [-0.45, 0.65], lonely: [-0.5, 0.15],
};
const STRENGTH = { low: 0.25, medium: 0.5, high: 0.8 };
const BASELINE = { valence: 0.35, energy: 0.4 }; // her resting state: content, quietly curious
const HALF_LIFE_MIN = 45; // moods fade halfway back to baseline in about 45 minutes

const blank = () => ({
  createdAt: new Date().toISOString(),
  mood: { name: "calm", strength: 0.3, valence: BASELINE.valence, energy: BASELINE.energy, at: Date.now() },
  growth: [],   // [{ at, text }] how she's changing
  journal: [],  // [{ at, text }] her private thoughts
  people: {},   // name -> { firstSeen, lastSeen, visits, facts: [{at,text}] }
  history: {},  // name -> [{ role, content }] recent conversation
});

let mind = load();
function load() {
  try { return { ...blank(), ...JSON.parse(fs.readFileSync(MIND_FILE, "utf8")) }; } catch { return blank(); }
}
function save() {
  const tmp = MIND_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(mind, null, 2));
  fs.renameSync(tmp, MIND_FILE);
}

// Moods drift back toward her baseline as time passes.
function currentMood() {
  const m = mind.mood;
  const mins = (Date.now() - (m.at || Date.now())) / 60000;
  const k = Math.pow(0.5, mins / HALF_LIFE_MIN);
  const valence = BASELINE.valence + (m.valence - BASELINE.valence) * k;
  const energy = BASELINE.energy + (m.energy - BASELINE.energy) * k;
  const strength = m.strength * k;
  const name = strength < 0.15 ? "calm" : m.name;
  return { name, strength, valence, energy, minutesAgo: Math.round(mins) };
}
export function moodState() { return currentMood(); }

function setMood(name, strengthWord) {
  const base = MOODS[name]; if (!base) return;
  const s = STRENGTH[strengthWord] ?? 0.5;
  const cur = currentMood();
  // blend: strong feelings move her further, but she never jumps all the way at once
  const w = 0.35 + 0.5 * s;
  mind.mood = {
    name, strength: s,
    valence: cur.valence + (base[0] - cur.valence) * w,
    energy: cur.energy + (base[1] - cur.energy) * w,
    at: Date.now(),
  };
}

// ---------- people ----------
function person(name) {
  const p = (mind.people[name] ??= { firstSeen: new Date().toISOString(), lastSeen: null, visits: 0, facts: [] });
  return p;
}
export function arrive(name) {
  const p = person(name);
  const gapH = p.lastSeen ? (Date.now() - Date.parse(p.lastSeen)) / 3600000 : Infinity;
  if (gapH > 1) p.visits += 1; // a new visit after an hour away
  const first = p.visits <= 1 && !p.lastSeen;
  p.lastSeen = new Date().toISOString();
  save();
  return { first, gapH };
}

// ---------- prompt ----------
function loadCanon(upTo) {
  const text = fs.readFileSync(path.join(MIND_DIR, "canon.md"), "utf8");
  return text.split(/^(?=## Episode \d+)/m).slice(1)
    .filter((s) => Number(s.match(/^## Episode (\d+)/)[1]) <= upTo).join("").trim();
}
function modeText(mode) {
  const text = fs.readFileSync(path.join(MIND_DIR, "modes.md"), "utf8");
  const part = text.split(/^## MODE: /m).find((s) => s.startsWith(mode));
  return part ? part.replace(/^\w+\s*/, "").trim() : "";
}
const ago = (iso) => {
  const h = (Date.now() - Date.parse(iso)) / 3600000;
  if (h < 1) return "just now"; if (h < 24) return `${Math.round(h)} hours ago`;
  const d = Math.round(h / 24); return d === 1 ? "yesterday" : `${d} days ago`;
};
function moodWords(m) {
  const lvl = m.strength > 0.6 ? "strongly" : m.strength > 0.3 ? "" : "slightly";
  return `${lvl} ${m.name}`.trim();
}

export function systemPrompt(name, isOwner) {
  const persona = fs.readFileSync(path.join(MIND_DIR, "persona.md"), "utf8").trim();
  const canon = loadCanon(isOwner ? 99 : VISITOR_CANON);
  const m = currentMood();
  const p = person(name);
  const now = new Date();
  const when = now.toLocaleString("en-GB", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });

  const growth = mind.growth.slice(-12).map((g) => `- ${g.text}`).join("\n") || "- Nothing yet. You're new to this.";
  const journal = mind.journal.slice(-8).map((j) => `- (${ago(j.at)}) ${j.text}`).join("\n") || "- Empty so far.";
  const facts = p.facts.slice(-25).map((f) => `- ${f.text}`).join("\n") || "- Nothing yet.";
  const visit = p.lastSeen && p.visits > 1 ? `You've talked ${p.visits} times. Last time was ${ago(p.lastSeen)}.` : "This is the first time you're talking.";

  return `${persona}

# What has happened in your story (your memories)

${canon}

${modeText(isOwner ? "owner" : "visitor")}

# Right now

- It's ${when} where Chris lives (Cyprus time on his computer). In Death Valley it's ten hours earlier.
- You're feeling ${moodWords(m)}. Let it show naturally; it will shift with what happens.
- ${isOwner ? "" : `This visitor's name is ${name}. `}${visit}

# What you remember about ${isOwner ? "Chris" : name}

${facts}

# How you've been changing

${growth}

# Your journal (most recent last)

${journal}`;
}

// ---------- conversation history ----------
const HISTORY_KEEP = 24;
export function history(name) { return mind.history[name] ?? []; }
export function addHistory(name, role, content) {
  const h = (mind.history[name] ??= []);
  h.push({ role, content });
  if (h.length > HISTORY_KEEP) h.splice(0, h.length - HISTORY_KEEP);
}

// ---------- reading her tags ----------
const TAG = /\[\[\s*(mood|gesture|remember|journal|grow|quiet)\s*(?::\s*([^\]]*))?\]\]/gi;
export function digest(name, raw) {
  const tags = [...raw.matchAll(TAG)].map((t) => ({ kind: t[1].toLowerCase(), value: (t[2] || "").trim() }));
  // whatever she says, minus tags and any stray bracketed notes
  let speech = raw.replace(TAG, "").replace(/\[\[[^\]]*\]\]/g, "").replace(/\*[^*]+\*/g, "").replace(/\s+\n/g, "\n").trim();
  const out = { speech, mood: null, gesture: null, remembered: [], journal: null, grew: null, quiet: false };
  const p = person(name);
  for (const t of tags) {
    if (t.kind === "mood") {
      const [word, str] = t.value.split("|").map((s) => s.trim().toLowerCase());
      if (MOODS[word]) { setMood(word, str); out.mood = word; }
    } else if (t.kind === "gesture") out.gesture = t.value.toLowerCase().split(/\s/)[0];
    else if (t.kind === "remember" && t.value && t.value.length < 200) {
      if (!p.facts.some((f) => f.text.toLowerCase() === t.value.toLowerCase())) {
        p.facts.push({ at: new Date().toISOString(), text: t.value });
        if (p.facts.length > 80) p.facts.shift();
        out.remembered.push(t.value);
      }
    } else if (t.kind === "journal" && t.value) {
      mind.journal.push({ at: new Date().toISOString(), text: `${t.value} (talking with ${name})` });
      if (mind.journal.length > 200) mind.journal.shift();
      out.journal = t.value;
    } else if (t.kind === "grow" && t.value) {
      mind.growth.push({ at: new Date().toISOString(), text: t.value });
      if (mind.growth.length > 40) mind.growth.shift();
      out.grew = t.value;
    } else if (t.kind === "quiet") out.quiet = true;
  }
  if (out.quiet && !speech) out.speech = "";
  return out;
}
export function commit() { save(); }
export function snapshot() {
  return { mood: currentMood(), growth: mind.growth.slice(-12), journal: mind.journal.slice(-12), people: Object.keys(mind.people) };
}
