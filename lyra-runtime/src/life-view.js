import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ROOT, config } from './config.js';

// "Her life" (dashboard /life.html) for Lyra, built from what she really has: people and memories,
// her pressure wants, her feelings, her journal, her promises, her persona and story, and what
// Lyra Core has learned and reasoned. Each part is read on its own; one that fails is listed with why.

const readJson = (file, fallback) => {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback; }
  catch { return fallback; }
};
const pct = (v) => Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 100);

async function part(name, fn, problems) {
  try { return await fn(); }
  catch (err) { problems.push({ part: name, why: err.message }); return null; }
}

// what each pressure bucket makes her want, and which layer it belongs to
const WANTS = {
  boredom: ['desires', 'look something up and write about it in her journal'],
  curiosity: ['desires', 'dig into something that came up'],
  restlessness: ['desires', 'say something, start something'],
  world: ['desires', 'read the news from Cyprus, Europe and the US'],
  watching: ['desires', 'react to what is on in the theater'],
  loneliness: ['needs', 'reach out to someone she misses'],
  usefulness: ['needs', 'be useful to someone'],
  irritation: ['inner', "say what's bothering her"],
  unease: ['inner', "check that everything's okay"],
};

// journal entries: "## 04:04 am · Tiger (boredom, researched)" then the text
function journalEntries(limit = 200) {
  const dir = path.join(DATA_DIR, 'journal');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter((x) => /^\d{4}-\d\d-\d\d\.md$/.test(x)).sort().reverse()) {
    const day = f.slice(0, 10);
    const blocks = readFileSync(path.join(dir, f), 'utf8').split(/^## /m).slice(1).reverse();
    for (const b of blocks) {
      const [head, ...rest] = b.split('\n');
      const m = head.match(/^(\d\d?:\d\d\s*[ap]m)\s*·\s*(.+?)(?:\s*\(([^)]*)\))?\s*$/i);
      const at = m ? Date.parse(`${day} ${m[1].replace(/\s*([ap]m)/i, ' $1')}`) : Date.parse(day);
      out.push({ title: m ? m[2] : head.trim(), why: m?.[3] ?? '', at: Number.isNaN(at) ? Date.parse(day) : at, body: rest.join('\n').trim() });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// persona.md, split into its sections
function personaSections() {
  const text = readFileSync(path.join(ROOT, 'persona.md'), 'utf8');
  const sec = {};
  for (const b of text.split(/^#{1,2} /m).slice(1)) {
    const [head, ...rest] = b.split('\n');
    sec[head.trim()] = rest.join('\n').trim();
  }
  return sec;
}

export async function lifeView() {
  const problems = [];
  const memory = await import('./memory.js');
  const { core } = await import('./core/index.js');
  const coreStats = await part('Lyra Core', async () => core.stats(), problems);
  const beliefs = coreStats?.beliefs ?? [];
  const journal = await part('journal', async () => journalEntries(), problems) ?? [];

  const people = await part('people', async () => {
    const { snapshot } = await import('./pressure.js');
    const bonds = { ...(readJson(path.join(DATA_DIR, 'pressure-state.json'), {}).loneliness ?? {}), ...(snapshot().loneliness ?? {}) };
    const contacts = memory.listContacts();
    const ids = new Set([...contacts.map((c) => String(c.user_id)), ...Object.keys(bonds)]);
    const out = [];
    for (const id of ids) {
      const c = contacts.find((x) => String(x.user_id) === id) ?? {};
      const b = bonds[id] ?? null;
      const name = c.name || b?.name || id;
      const memories = (() => { try { return memory.listMemories(id).map((m) => ({ id: m.id, text: m.content, at: m.created_at })); } catch { return []; } })();
      // what Lyra Core has worked out about them joins what she remembers
      for (const x of beliefs.filter((x) => x.subj === name)) memories.push({ id: `core-${x.rel}-${x.obj}`, text: `${x.rel} ${x.obj} (${x.source === 'reasoned' ? `reasoned: ${x.why}` : `heard ${x.n}×`}, ${x.conf}% sure)`, at: null });
      out.push({
        id, name, username: c.username ?? null,
        tier: config.ownerIds.includes(id) ? 'owner' : c.tier ?? b?.tier ?? 'stranger',
        owner: config.ownerIds.includes(id),
        first_seen: c.first_seen ?? null, last_seen: c.last_seen ?? null,
        relationship: null, missing_them: pct(b?.value), bond: pct(b?.bond), aim: null, frustration: null,
        memories,
      });
    }
    const rank = (p) => (p.owner ? 3 : 0) + (p.bond || 0) / 100 + (p.memories.length ? 1 : 0);
    return out.sort((x, y) => rank(y) - rank(x) || (y.last_seen ?? 0) - (x.last_seen ?? 0));
  }, problems);

  // subjects: what she researched in her journal, plus the kinds of things people talk to her about
  const subjects = await part('subjects', async () => {
    const map = new Map();
    const add = (name, n, source, last) => {
      const k = name.toLowerCase();
      const s = map.get(k) ?? { name, mentions: 0, sources: {}, people: {}, last: null };
      s.mentions += n; s.sources[source] = (s.sources[source] ?? 0) + n; s.last = Math.max(s.last ?? 0, last ?? 0) || s.last;
      map.set(k, s);
    };
    for (const e of journal) add(e.title, 1, 'journal', e.at);
    const TOPIC = { lore: 'the series', news: 'the news', music: 'music', about_her: 'herself' };
    for (const k of coreStats?.skills ?? []) if (TOPIC[k.intent]) add(TOPIC[k.intent], k.examples, 'conversations', null);
    const list = [...map.values()];
    const top = Math.max(1, ...list.map((s) => s.mentions));
    return list.map((s) => ({ ...s, interest: Math.round(20 + (80 * s.mentions) / top) })).sort((a, b) => b.mentions - a.mentions).slice(0, 40);
  }, problems);

  const wants = await part('wants', async () => {
    const p = await import('./pressure.js');
    const s = p.snapshot();
    const wantsList = Object.entries(s.buckets || {}).map(([name, value]) => ({
      name, label: p.LABEL?.[name] ?? name, level: pct(value),
      threshold: s.thresholds?.[name] != null ? pct(s.thresholds[name]) : null,
      layer: WANTS[name]?.[0] ?? 'desires', want: WANTS[name]?.[1] ?? name,
    })).sort((a, b) => b.level - a.level);
    // feelings: her latest mood (from her last conversation) plus the pressure feelings
    const emo = readJson(path.join(DATA_DIR, 'emotions.json'), {});
    const latest = Object.values(emo).filter((x) => x?.feelings).sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0];
    const feelings = Object.entries(latest?.feelings ?? {}).map(([label, v]) => ({ label, level: pct(v) }));
    for (const w of wantsList) if (WANTS[w.name]?.[0] !== 'desires' && w.level > 0) feelings.push({ label: w.label, level: w.level });
    const last = s.last_action ? { ...s.last_action, want: s.last_action.bucket ? `${p.LABEL?.[s.last_action.bucket] ?? s.last_action.bucket}: ${WANTS[s.last_action.bucket]?.[1] ?? ''}` : undefined } : null;
    return { feelings: feelings.sort((a, b) => b.level - a.level), wants: wantsList, last_action: last, mood_at: latest?.at ?? null };
  }, problems);

  const goals = await part('goals', async () => {
    const open = memory.openObligations().map((o) => ({
      id: o.id, text: o.task, activity: o.kind === 'task' ? 'promise' : o.kind, kind: 'promise',
      reason: o.target_name ? `for ${o.target_name}` : null, at: o.created_at,
    }));
    const insights = beliefs.filter((b) => b.source === 'reasoned').map((b) => ({ text: `${b.subj} ${b.rel} ${b.obj}${b.why ? `, because ${b.why}` : ''} (${b.conf}% sure)`, at: null }));
    return { open, insights, finished: [] };
  }, problems);

  const self = await part('who she is', async () => {
    const sec = personaSections();
    // persona.md talks to her ("You are..."); here she says it herself
    // "you" doing something is "I"; "you" having something done to it is "me"
    const VERB = String.raw`(?:\w+ed|let|want|wants|can|can't|still|have|had|do|did|don't|will|would|could|keep|love|know|knew|chose|choose|feel|felt|think|say|said|tell|told|go|went|are|were|got|get|make|made|remember|found|find|run|ran|see|saw|never|always|also|just|ever|really|once|first|only|might|should|may)\b`;
    const firstPerson = (s) => s.replace(/\*/g, '')
      .replace(/\b[Yy]ou were\b/g, 'I was').replace(/\b[Yy]ou are\b/g, 'I am').replace(/\b[Yy]ou're\b/g, "I'm").replace(/\b[Yy]ou've\b/g, "I've")
      .replace(/\bYour\b/g, 'My').replace(/\byour\b/g, 'my').replace(/\byourself\b/gi, 'myself')
      .replace(new RegExp(String.raw`\b[Yy]ou(?= ${VERB})`, 'g'), 'I').replace(/\bYou\b/g, 'I').replace(/\byou\b/g, 'me');
    const who = firstPerson((sec['You are Lyra'] ?? '').split('\n\n')[0]);
    const people = [...(sec['The people in your life (from the series)'] ?? '').matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1]);
    const episodes = Object.keys(sec).filter((k) => /^Episode \d+/.test(k));
    const aspects = [
      { question: 'What am I?', answer: who || null },
      { question: 'Who matters in my story?', answer: people.length ? people.join(', ') : null },
      { question: 'How far does my story go?', answer: episodes.length ? `I remember up to ${episodes.at(-1)}.` : null },
      { question: 'How do I talk?', answer: firstPerson((sec['How you speak'] ?? '').split('\n').filter((l) => l.startsWith('- ') && !/markdown|tags?\b|bracket/i.test(l)).slice(0, 2).map((l) => l.slice(2)).join(' ')) || null },
    ];
    const aboutHer = beliefs.filter((b) => /^lyra$/i.test(b.subj)).map((b) => `I ${b.rel} ${b.obj}`);
    return { believes: aboutHer[0] ?? who.split(/(?<=\.)\s/).slice(0, 2).join(' '), believed_at: null, aspects };
  }, problems);

  const taste = await part('taste', async () => {
    const likes = beliefs.filter((b) => /^(likes|may like|dislikes|favourite|enjoys)/.test(b.rel));
    return likes.length ? likes.map((b) => `${b.subj} ${b.rel} ${b.obj} (${b.conf}% sure${b.why ? `: ${b.why}` : ''})`).join('\n') : '';
  }, problems);

  return {
    name: config.botName,
    at: Date.now(),
    people: people ?? [],
    subjects: subjects ?? [],
    taste: taste ?? '',
    wants: wants ?? null,
    goals: goals ?? { open: [], insights: [], finished: [] },
    self: self ?? null,
    direction: { overall: { aim: 'Keep remembering. Get to know the people who come to see her, and learn to speak for herself through Lyra Core.', why: `Lyra Core could have given ${coreStats?.wouldHaveHandled ?? 0}% of her recent replies by herself`, since: null }, history: [] },
    lately: { journal: journal.slice(0, 8).map((e) => ({ title: e.title, at: e.at, body: e.body.length > 400 ? `${e.body.slice(0, 400)}…` : e.body })), songs: [] },
    core: coreStats ? { exchanges: coreStats.exchanges, handled: coreStats.wouldHaveHandled, closeness: coreStats.averageCloseness } : null,
    problems,
  };
}
