// The memory gardener (2026-11-25): looks over everything Lyra remembers and suggests clean-ups. It changes nothing
// itself: each suggestion waits on the Memory garden page (/memory-garden.html) for Chris to accept or dismiss.
// No language model and no requests: near-duplicates are found by comparing the memories' fingerprints (the same
// vectors her recall uses), vague and personal ones by simple word rules. It looks again once a day on its own.
//   duplicate: two or more memories saying the same thing about one person -> keep the fullest, remove the rest
//   vague:     says nothing usable ("worked on something, the context is unclear") -> remove
//   personal:  health, money, benefits, family trouble... -> keep (it's fine) or remove (rather not)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { activity } from './events.js';
import { allMemoriesWithVectors, forget } from './memory.js';

const FILE = path.join(DATA_DIR, 'garden.json');
const DAY = 86_400_000;
const SAME = 0.9; // fingerprints this close: the same memory said twice
const VAGUE = /\b(context (of [\w ]+ )?is unclear|unclear from (this|the) (excerpt|conversation)|has worked on something|something unspecified|some(thing| kind of thing)\b[^.]{0,20}\bunclear|not sure what|is cut off|was cut off|interrupted before|mentioned something|talked about something|said something about)\b/i;
const PERSONAL = /\b(disab\w*|adhd|autis\w*|diagnos\w*|illness|sick|medication|medicine|therap\w*|depress\w*|anxiety|mental health|hospital|benefits?|debt|loan|salary|income|bank|stocks?|shares|crypto|invest\w*|money|rent|divorce|breakup|pregnan\w*|religio\w*|politic\w*|sexual\w*|password|address|phone number)\b/i;

const load = () => { try { return { suggestions: [], dismissed: [], scannedAt: 0, ...JSON.parse(readFileSync(FILE, 'utf8')) }; } catch { return { suggestions: [], dismissed: [], scannedAt: 0 }; } };
const save = (g) => { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(FILE, JSON.stringify(g, null, 1)); };
const cosine = (a, b) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return d / (Math.sqrt(x * y) || 1); };
const words = (s) => (String(s).match(/[\p{L}\p{N}']+/gu) || []).length;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export function scanGarden() {
  const g = load();
  const mems = allMemoriesWithVectors();
  const byId = new Map(mems.map((m) => [m.id, m]));
  const done = new Set(g.dismissed.map((k) => String(k)));
  // suggestions still waiting stay; ones whose memories are gone are dropped
  const keep = g.suggestions.filter((s) => s.status === 'pending' && s.memories.every((id) => byId.has(id)));
  const taken = new Set(keep.flatMap((s) => s.memories));
  let next = g.suggestions.reduce((m, s) => Math.max(m, s.id), 0) + 1;
  const fresh = [];
  const sug = (kind, memories, extra) => {
    const key = `${kind}:${memories.slice().sort((a, b) => a - b).join(',')}`;
    if (done.has(key) || memories.some((id) => taken.has(id))) return;
    memories.forEach((id) => taken.add(id));
    const first = byId.get(memories[0]);
    fresh.push({ id: next++, key, kind, person: first?.name || 'someone', memories, at: Date.now(), status: 'pending', ...extra });
  };

  // duplicates, per person
  const byUser = {};
  for (const m of mems) if (m.v) (byUser[m.user_id] ??= []).push(m);
  for (const list of Object.values(byUser)) {
    const seen = new Set();
    for (let i = 0; i < list.length; i++) {
      if (seen.has(list[i].id)) continue;
      const group = [list[i]];
      for (let j = i + 1; j < list.length; j++) if (!seen.has(list[j].id) && cosine(list[i].v, list[j].v) >= SAME) group.push(list[j]);
      if (group.length < 2) continue;
      group.forEach((m) => seen.add(m.id));
      const best = group.slice().sort((a, b) => words(b.content) - words(a.content) || b.created_at - a.created_at)[0];
      sug('duplicate', [best.id, ...group.filter((m) => m !== best).map((m) => m.id)], { keepId: best.id, why: `${group.length} memories say the same thing. Keep the fullest one, remove the others.` });
    }
  }
  // vague and personal
  for (const m of mems) {
    if (taken.has(m.id)) continue;
    // (short is fine: "Chris made Lyra." says plenty; only wording that admits it says nothing, or a stub)
    if (VAGUE.test(m.content) || words(m.content) < 3) sug('vague', [m.id], { why: "It doesn't say anything she could use." });
    else if (PERSONAL.test(m.content)) sug('personal', [m.id], { why: `Personal (${m.content.match(PERSONAL)[0].toLowerCase()}). Fine to keep if you're happy for her to remember it.` });
  }
  g.suggestions = [...g.suggestions.filter((s) => s.status !== 'pending'), ...keep, ...fresh].slice(-500);
  g.scannedAt = Date.now();
  save(g);
  if (fresh.length) activity('memory', { message: `Memory gardener: ${fresh.length} new suggestion${fresh.length > 1 ? 's' : ''} to look at` });
  return { ok: true, message: fresh.length ? `Found ${fresh.length} new thing${fresh.length > 1 ? 's' : ''} to look at.` : 'Nothing new to tidy.' };
}

// accept: do what it suggests (remove memories); dismiss: leave them, and don't suggest it again
export function decide(id, act) {
  const g = load();
  const s = g.suggestions.find((x) => x.id === id);
  if (!s) throw fail('No such suggestion.', 404);
  if (s.status !== 'pending') throw fail(`Already ${s.status}.`, 409);
  const mems = new Map(allMemoriesWithVectors().map((m) => [m.id, m]));
  let removed = 0;
  if (act === 'accept') {
    const gone = s.kind === 'duplicate' ? s.memories.filter((x) => x !== s.keepId) : s.memories;
    for (const mid of gone) { const m = mems.get(mid); if (m) removed += forget(m.user_id, mid); }
    s.status = 'accepted';
    activity('memory', { message: `Memory gardener: removed ${removed} memor${removed === 1 ? 'y' : 'ies'} (${s.kind}), with Chris's OK` });
  } else {
    s.status = 'dismissed';
    g.dismissed = [...new Set([...g.dismissed, s.key])].slice(-2000);
  }
  s.decidedAt = Date.now();
  save(g);
  return { ok: true, message: act === 'accept' ? `Done: removed ${removed} memor${removed === 1 ? 'y' : 'ies'}.` : (s.kind === 'personal' ? 'Kept.' : 'Left as it is.') };
}

export function gardenSnapshot() {
  let g = load();
  if (Date.now() - g.scannedAt > DAY) { try { scanGarden(); g = load(); } catch {} } // once a day on its own
  const mems = new Map(allMemoriesWithVectors().map((m) => [m.id, m]));
  const pending = g.suggestions.filter((s) => s.status === 'pending').map((s) => ({
    ...s, items: s.memories.map((id) => ({ id, text: mems.get(id)?.content || '(already gone)', at: mems.get(id)?.created_at, keep: s.kind === 'duplicate' ? id === s.keepId : s.kind === 'personal' })),
  }));
  const decided = g.suggestions.filter((s) => s.status !== 'pending').slice(-20).reverse();
  return { scannedAt: g.scannedAt, total: mems.size, pending, recent: decided.map((s) => ({ kind: s.kind, person: s.person, status: s.status, at: s.decidedAt })) };
}
