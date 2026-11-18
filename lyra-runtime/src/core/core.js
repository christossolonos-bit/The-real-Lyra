// Lyra Core: her own learning and reasoning system. No language model inside.
//
// Nemotron is her teacher. On every real exchange, Core first drafts its own reply in secret (shadow
// mode), then sees what the teacher actually said, scores how close it came, and learns from it:
//   - phrases:  every sentence the teacher used, stored once (names become {name}), with how well it lands
//   - shapes:   how replies are built for each kind of moment ("greet+ask", "care+say+ask")
//   - cases:    the moment (kind, time of day, key words as a 64-bit fingerprint) -> which phrases answered it
//   - rewards:  how the person reacted next (laughed, thanked, corrected her) strengthens or weakens what she said
//   - beliefs:  small facts as links (Chris -likes-> sci-fi), with confidence, plus conclusions she reasons out
// No raw conversation text is stored here: moments are kept as key words and fingerprints, replies as
// phrase ids. While asleep she consolidates: merges duplicates, lets unused things fade, reasons new beliefs.
//
// v1 only learns. It never speaks for her; the scoreboard shows when a kind of moment is ready.
import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import {
  stripTags, keyWords, fingerprint, hamming, jaccard, sentences, role, shapeOf, toTemplate, fill, closeness, reaction,
} from './text.js';
import { intentOf, partOfDay, INTENTS } from './situation.js';

// kinds of moment that are real subjects (worth noticing habits and tastes about)
const TOPICS = new Set(['lore', 'about_her', 'news', 'music']);
const TOPIC_WORD = { lore: 'the series', about_her: 'you (Lyra)', news: 'the news', music: 'music' };
const READY_N = 25;      // examples of a kind of moment before it can be "ready"
const READY_SCORE = 0.6; // running closeness to the teacher needed
const EMA = 0.1;

export function createCore({ file, now = Date.now } = {}) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS phrases (id INTEGER PRIMARY KEY, text TEXT UNIQUE NOT NULL, role TEXT NOT NULL,
      uses INTEGER NOT NULL DEFAULT 0, score REAL NOT NULL DEFAULT 0.5, first INTEGER, last INTEGER);
    CREATE TABLE IF NOT EXISTS phrase_intents (phrase INTEGER NOT NULL, intent TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (phrase, intent));
    CREATE TABLE IF NOT EXISTS shapes (intent TEXT NOT NULL, shape TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (intent, shape));
    CREATE TABLE IF NOT EXISTS cases (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, speaker TEXT, intent TEXT NOT NULL, part TEXT,
      fp TEXT, toks TEXT, reply TEXT NOT NULL, weight INTEGER NOT NULL DEFAULT 1, reward REAL NOT NULL DEFAULT 0,
      draft TEXT, score REAL);
    CREATE INDEX IF NOT EXISTS cases_intent ON cases (intent, id);
    CREATE TABLE IF NOT EXISTS skill (intent TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0, ema REAL NOT NULL DEFAULT 0, best REAL NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS beliefs (id INTEGER PRIMARY KEY, subj TEXT NOT NULL, rel TEXT NOT NULL, obj TEXT NOT NULL,
      conf REAL NOT NULL, n INTEGER NOT NULL DEFAULT 1, first INTEGER, last INTEGER, source TEXT NOT NULL DEFAULT 'heard', why TEXT,
      UNIQUE (subj, rel, obj));
    CREATE TABLE IF NOT EXISTS moments (speaker TEXT NOT NULL, what TEXT NOT NULL, part TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (speaker, what, part));
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
  `);
  const q = (sql) => db.prepare(sql);
  const st = {
    phraseGet: q('SELECT id FROM phrases WHERE text = ?'),
    phraseAdd: q('INSERT INTO phrases (text, role, uses, first, last) VALUES (?, ?, 1, ?, ?)'),
    phraseUse: q('UPDATE phrases SET uses = uses + 1, last = ? WHERE id = ?'),
    phraseText: q('SELECT id, text, role, score FROM phrases WHERE id = ?'),
    phraseIntent: q('INSERT INTO phrase_intents (phrase, intent, n) VALUES (?, ?, 1) ON CONFLICT DO UPDATE SET n = n + 1'),
    phraseScore: q('UPDATE phrases SET score = MIN(1, MAX(0, score + ?)) WHERE id = ?'),
    bestPhrases: q(`SELECT p.id, p.text, p.role, p.score, pi.n FROM phrase_intents pi JOIN phrases p ON p.id = pi.phrase
      WHERE pi.intent = ? AND p.role = ? ORDER BY (p.score * 2 + MIN(pi.n, 10) / 10.0) DESC LIMIT 5`),
    shapeAdd: q('INSERT INTO shapes (intent, shape, n) VALUES (?, ?, 1) ON CONFLICT DO UPDATE SET n = n + 1'),
    topShape: q('SELECT shape, n FROM shapes WHERE intent = ? ORDER BY n DESC LIMIT 1'),
    caseAdd: q('INSERT INTO cases (ts, speaker, intent, part, fp, toks, reply, draft, score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    casesFor: q('SELECT id, speaker, part, fp, toks, reply, weight, reward FROM cases WHERE intent = ? ORDER BY id DESC LIMIT 400'),
    lastCase: q('SELECT id, reply FROM cases WHERE speaker = ? ORDER BY id DESC LIMIT 1'),
    caseReward: q('UPDATE cases SET reward = MIN(1, MAX(-1, reward + ?)) WHERE id = ?'),
    skillGet: q('SELECT n, ema, best FROM skill WHERE intent = ?'),
    skillSet: q('INSERT INTO skill (intent, n, ema, best) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET n = excluded.n, ema = excluded.ema, best = excluded.best'),
    beliefGet: q('SELECT id, conf, n FROM beliefs WHERE subj = ? AND rel = ? AND obj = ?'),
    beliefAdd: q('INSERT INTO beliefs (subj, rel, obj, conf, first, last, source, why) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    beliefBump: q('UPDATE beliefs SET conf = ?, n = n + 1, last = ?, why = COALESCE(?, why) WHERE id = ?'),
    beliefsSameRel: q('SELECT id, obj, conf FROM beliefs WHERE subj = ? AND rel = ? AND obj != ?'),
    beliefWeaken: q('UPDATE beliefs SET conf = conf * ? WHERE id = ?'),
    momentAdd: q('INSERT INTO moments (speaker, what, part, n) VALUES (?, ?, ?, 1) ON CONFLICT DO UPDATE SET n = n + 1'),
    metaGet: q('SELECT v FROM meta WHERE k = ?'),
    metaSet: q('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT DO UPDATE SET v = excluded.v'),
  };
  const meta = (k, v) => (v === undefined ? st.metaGet.get(k)?.v ?? null : st.metaSet.run(k, String(v)));

  // ---------- speaking: her own draft, built only from what she has learned ----------
  const replyFrom = (ids, name) => ids.split(',').map((id) => st.phraseText.get(Number(id))?.text).filter(Boolean).map((t) => fill(t, name)).join(' ');

  function draft(text, speaker = {}) {
    const intent = intentOf(text), toks = keyWords(text), fp = fingerprint(toks), part = partOfDay(new Date(now()));
    let best = null, bestScore = 0;
    for (const c of st.casesFor.all(intent)) {
      const ct = c.toks ? c.toks.split(' ') : [];
      const s = 0.55 * jaccard(toks, ct) + 0.25 * (1 - hamming(fp, c.fp) / 64) + 0.08 * (c.speaker === speaker.id) +
        0.05 * (c.part === part) + 0.07 * Math.max(-1, Math.min(1, c.reward));
      if (s > bestScore) { bestScore = s; best = c; }
    }
    if (best && bestScore >= 0.35) return { intent, text: replyFrom(best.reply, speaker.name), confidence: Math.round(bestScore * 100) / 100, from: 'memory of a similar moment' };
    // nothing close: build one from the usual shape for this kind of moment, with her best phrases
    const shape = st.topShape.get(intent)?.shape;
    if (!shape) return { intent, text: '', confidence: 0, from: 'nothing learned yet' };
    const used = new Set(), out = [];
    for (const r of shape.split('+')) {
      const p = st.bestPhrases.all(intent, r).find((x) => !used.has(x.id));
      if (p) { used.add(p.id); out.push(fill(p.text, speaker.name)); }
    }
    return { intent, text: out.join(' '), confidence: out.length ? 0.3 : 0, from: `the usual "${shape}" shape` };
  }

  // ---------- learning from one exchange with the teacher ----------
  function observe({ speaker = {}, text, reply, tools = [] }) {
    const teacher = stripTags(reply);
    if (!text || !teacher) return null;
    const t = now(), sid = speaker.id || speaker.name || 'someone', name = speaker.name;

    // 1. reward: how they reacted now to what she said last time
    const r = reaction(text), prev = st.lastCase.get(sid);
    if (prev && r) {
      st.caseReward.run(r * 0.5, prev.id);
      for (const id of prev.reply.split(',')) st.phraseScore.run(r * 0.08, Number(id));
    }

    // 2. shadow draft, made before looking at the teacher's answer
    const mine = draft(text, { id: sid, name });
    const usedTools = tools.length > 0; // tool turns (play music, search...) aren't about how she talks
    const score = mine.text ? closeness(mine.text, teacher) : 0;

    // 3. learn the teacher's reply: phrases once, the shape, and the moment
    const intent = mine.intent, ids = [];
    for (const s of sentences(teacher).slice(0, 8)) {
      const tpl = toTemplate(s, name).slice(0, 300);
      let id = st.phraseGet.get(tpl)?.id;
      if (id) st.phraseUse.run(t, id); else id = Number(st.phraseAdd.run(tpl, role(s), t, t).lastInsertRowid);
      st.phraseIntent.run(id, intent);
      ids.push(id);
    }
    if (!ids.length) return null;
    st.shapeAdd.run(intent, shapeOf(teacher));
    const toks = keyWords(text).slice(0, 40);
    st.caseAdd.run(t, sid, intent, partOfDay(new Date(t)), fingerprint(toks), toks.join(' '), ids.join(','), mine.text.slice(0, 400), score);

    // 4. skill: a running score of how close her drafts come, per kind of moment
    if (!usedTools) {
      const s = st.skillGet.get(intent) ?? { n: 0, ema: 0, best: 0 };
      const ema = s.n ? s.ema + EMA * (score - s.ema) : score;
      st.skillSet.run(intent, s.n + 1, ema, Math.max(s.best, score));
    }

    // 5. what she learns about the person, and when things happen
    learnFacts(sid, name, text, t);
    if (TOPICS.has(intent)) st.momentAdd.run(sid, `talks about ${TOPIC_WORD[intent] ?? intent}`, partOfDay(new Date(t)));
    return { intent, draft: mine.text, from: mine.from, score, reward: r };
  }

  // ---------- beliefs: small facts as links ----------
  const clean = (s) => String(s).split(/\b(?:and|but|so|because|cause|though|which|who)\b|[,.;!?]/i)[0].trim().slice(0, 40);
  const SINGLE = new Set(['is called', 'lives in', 'works at', 'birthday is']); // one true answer at a time
  function believe(subj, rel, obj, { t = now(), source = 'heard', why = null, strength = 0.5 } = {}) {
    obj = clean(obj);
    if (!/ is$/.test(rel)) obj = obj.toLowerCase(); // names keep their capitals
    if (!obj || obj.length < 2) return;
    const had = st.beliefGet.get(subj, rel, obj);
    if (had) st.beliefBump.run(1 - (1 - had.conf) * (1 - strength * 0.8), t, why, had.id);
    else {
      st.beliefAdd.run(subj, rel, obj, strength, t, t, source, why);
      // something new that contradicts an old single-answer fact makes the old one less sure
      if (SINGLE.has(rel) || / is$/.test(rel)) for (const o of st.beliefsSameRel.all(subj, rel, obj)) st.beliefWeaken.run(0.6, o.id);
    }
  }
  const FEEL = /^(tired|exhausted|sad|happy|stressed|bored|hungry|sick|busy|excited|lonely|angry|worried|fine|good|great|ok|okay)$/;
  function learnFacts(sid, name, text, t) {
    const who = name || sid, s = String(text);
    let m;
    const re = (r) => new RegExp(r, 'gi');
    for (m of s.matchAll(re(String.raw`\bi (?:really |absolutely )?(love|like|enjoy|adore)s? ([\w' -]{2,40})`))) believe(who, 'likes', m[2], { t });
    for (m of s.matchAll(re(String.raw`\bi (?:really )?(hate|dislike|can't stand)s? ([\w' -]{2,40})`))) believe(who, 'dislikes', m[2], { t });
    for (m of s.matchAll(re(String.raw`\bi (?:live|am living) in ([\w' -]{2,40})`))) believe(who, 'lives in', m[1], { t });
    for (m of s.matchAll(re(String.raw`\bi work (?:at|for|in) ([\w' -]{2,40})`))) believe(who, 'works at', m[1], { t });
    for (m of s.matchAll(re(String.raw`\bmy (dad|father|mom|mum|mother|brother|sister|wife|girlfriend|boyfriend|son|daughter|friend|dog|cat)(?:'s name)? is (?:called |named )?([\w'-]{2,20})`))) believe(who, `${m[1].toLowerCase()} is`, m[2].charAt(0).toUpperCase() + m[2].slice(1), { t });
    for (m of s.matchAll(re(String.raw`\bmy favou?rite ([\w ]{2,20}?) is ([\w' -]{2,40})`))) believe(who, `favourite ${m[1].toLowerCase()}`, m[2], { t });
    for (m of s.matchAll(re(String.raw`\bi(?:'m| am) (?:so |very |really |a bit |kinda )?([\w']{2,15})\b`))) {
      const w = m[1].toLowerCase();
      if (FEEL.test(w)) st.momentAdd.run(sid, `feels ${w}`, partOfDay(new Date(t)));
    }
  }

  // ---------- reasoning: new conclusions from what she knows (runs while she sleeps) ----------
  function reason() {
    const t = now(), made = [];
    // habits: something that keeps happening at the same time of day
    for (const m of q('SELECT speaker, what, part, n FROM moments WHERE n >= 3').all()) {
      const total = q('SELECT SUM(n) AS s FROM moments WHERE speaker = ? AND what = ?').get(m.speaker, m.what).s;
      if (m.n / total >= 0.5) {
        const who = nameOf(m.speaker);
        const rel = m.what.startsWith('feels') ? 'often ' + m.what : 'usually ' + m.what;
        believe(who, rel, `in the ${m.part}`, { t, source: 'reasoned', strength: Math.min(0.9, 0.3 + m.n * 0.05), why: `${m.n} of ${total} times it happened in the ${m.part}` });
        made.push(`${who} ${rel} in the ${m.part}`);
      }
    }
    // chains: A likes X, and X is a kind of Y  ->  A may like Y
    for (const a of q("SELECT subj, obj, conf FROM beliefs WHERE rel = 'likes' AND conf >= 0.4").all()) {
      for (const k of q("SELECT obj, conf FROM beliefs WHERE subj = ? AND rel = 'is a kind of'").all(a.obj)) {
        believe(a.subj, 'may like', k.obj, { t, source: 'reasoned', strength: a.conf * k.conf * 0.8, why: `likes ${a.obj}, and ${a.obj} is a kind of ${k.obj}` });
        made.push(`${a.subj} may like ${k.obj}`);
      }
    }
    // taste: what someone keeps reacting well to
    for (const r of q("SELECT speaker, intent, AVG(reward) AS avg, COUNT(*) AS n FROM cases GROUP BY speaker, intent HAVING n >= 5").all()) {
      if (r.avg >= 0.25 && TOPICS.has(r.intent)) { believe(nameOf(r.speaker), 'enjoys talking about', TOPIC_WORD[r.intent] ?? r.intent, { t, source: 'reasoned', strength: Math.min(0.9, r.avg), why: `reacted well ${Math.round(r.avg * 100)}% on average over ${r.n} times` }); made.push(`${nameOf(r.speaker)} enjoys ${r.intent}`); }
    }
    return made;
  }
  // moments are keyed by speaker id; beliefs read better with a name, so remember id -> name as she learns
  const nameOf = (sid) => meta(`name:${sid}`) ?? sid;

  // ---------- consolidation: keep it small, forever ----------
  function consolidate() {
    const t = now(), day = 86_400_000, before = sizeBytes();
    // merge moments that are the same (same kind, nearly the same words, same answer)
    let merged = 0;
    for (const intent of INTENTS) {
      const rows = q('SELECT id, speaker, fp, reply, weight, reward FROM cases WHERE intent = ? ORDER BY id').all(intent);
      const keep = [];
      for (const c of rows) {
        const twin = keep.find((k) => k.speaker === c.speaker && k.reply === c.reply && hamming(k.fp, c.fp) <= 4);
        if (twin) { q('UPDATE cases SET weight = weight + ?, reward = (reward + ?) / 2 WHERE id = ?').run(c.weight, c.reward, twin.id); q('DELETE FROM cases WHERE id = ?').run(c.id); merged++; }
        else keep.push(c);
      }
    }
    // forget: old moments that went badly, phrases nobody needs, beliefs that faded
    const forgotCases = Number(q('DELETE FROM cases WHERE ts < ? AND reward < -0.3').run(t - 30 * day).changes);
    q('UPDATE phrases SET score = score * 0.98 WHERE last < ?').run(t - 7 * day);
    const used = new Set(q('SELECT reply FROM cases').all().flatMap((c) => c.reply.split(',').map(Number)));
    let forgotPhrases = 0;
    for (const p of q('SELECT id FROM phrases WHERE uses <= 1 AND score < 0.35 AND last < ?').all(t - 30 * day)) {
      if (!used.has(p.id)) { q('DELETE FROM phrase_intents WHERE phrase = ?').run(p.id); q('DELETE FROM phrases WHERE id = ?').run(p.id); forgotPhrases++; }
    }
    q("UPDATE beliefs SET conf = conf * 0.95 WHERE source = 'reasoned' AND last < ?").run(t - 7 * day);
    const forgotBeliefs = Number(q('DELETE FROM beliefs WHERE conf < 0.15').run().changes);
    const concluded = reason();
    db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM;');
    meta('lastConsolidation', t);
    return { merged, forgotCases, forgotPhrases, forgotBeliefs, concluded, bytesBefore: before, bytesAfter: sizeBytes() };
  }

  function sizeBytes() {
    let n = 0;
    for (const f of [file, `${file}-wal`]) try { n += statSync(f).size; } catch {}
    return n;
  }

  // ---------- the scoreboard ----------
  function stats() {
    const count = (sql) => q(sql).get().n;
    const skills = q('SELECT intent, n, ema, best FROM skill ORDER BY n DESC').all().map((s) => ({
      intent: s.intent, examples: s.n, closeness: Math.round(s.ema * 100), best: Math.round(s.best * 100),
      ready: s.n >= READY_N && s.ema >= READY_SCORE,
    }));
    const recent = q('SELECT ts, intent, draft, reply, score FROM cases ORDER BY id DESC LIMIT 12').all()
      .map((c) => ({ ts: c.ts, intent: c.intent, core: c.draft || '', teacher: replyFrom(c.reply, '{name}'), closeness: Math.round((c.score ?? 0) * 100) }));
    const last200 = q('SELECT score FROM cases ORDER BY id DESC LIMIT 200').all();
    const close = last200.filter((c) => (c.score ?? 0) >= READY_SCORE).length;
    return {
      mode: 'learning (shadow): Core drafts in secret, Nemotron still speaks',
      exchanges: count('SELECT COUNT(*) AS n FROM cases'),
      wouldHaveHandled: last200.length ? Math.round((close / last200.length) * 100) : 0,
      averageCloseness: last200.length ? Math.round((last200.reduce((a, c) => a + (c.score ?? 0), 0) / last200.length) * 100) : 0,
      ready: { examples: READY_N, closeness: Math.round(READY_SCORE * 100) },
      skills,
      phrases: count('SELECT COUNT(*) AS n FROM phrases'),
      shapes: q('SELECT intent, shape, n FROM shapes ORDER BY n DESC LIMIT 12').all(),
      topPhrases: q('SELECT text, role, uses, score FROM phrases ORDER BY uses DESC, score DESC LIMIT 15').all(),
      beliefs: q('SELECT subj, rel, obj, conf, n, source, why FROM beliefs ORDER BY conf DESC, n DESC LIMIT 40').all()
        .map((b) => ({ ...b, conf: Math.round(b.conf * 100) })),
      recent,
      sizeBytes: sizeBytes(),
      lastConsolidation: Number(meta('lastConsolidation')) || null,
    };
  }

  function rememberName(id, name) { if (id && name) meta(`name:${id}`, name); }

  return { draft, observe: (x) => { rememberName(x?.speaker?.id, x?.speaker?.name); return observe(x); }, reason, consolidate, stats, believe, close: () => db.close() };
}
