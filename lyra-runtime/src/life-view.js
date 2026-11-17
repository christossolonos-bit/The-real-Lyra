import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, config } from './config.js';

// Soft "Her life" view for Luna: reads what she has without requiring student-only modules
// (relationship, direction, taste, reflections). Missing parts show as empty with a reason.

const readJson = (file, fallback) => {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback; }
  catch { return fallback; }
};
const pct = (v) => Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 100);

async function part(name, fn, problems) {
  try { return await fn(); }
  catch (err) { problems.push({ part: name, why: err.message }); return null; }
}

export async function lifeView() {
  const problems = [];
  const memory = await import('./memory.js');

  const people = await part('people', async () => {
    const { snapshot } = await import('./pressure.js');
    const bonds = { ...(readJson(path.join(DATA_DIR, 'pressure-state.json'), {}).loneliness ?? {}), ...(snapshot().loneliness ?? {}) };
    const contacts = memory.listContacts();
    const ids = new Set([...contacts.map((c) => String(c.user_id)), ...Object.keys(bonds)]);
    const out = [];
    for (const id of ids) {
      const c = contacts.find((x) => String(x.user_id) === id) ?? {};
      const b = bonds[id] ?? null;
      const memories = (() => { try { return memory.listMemories(id).map((m) => ({ id: m.id, text: m.content, at: m.created_at })); } catch { return []; } })();
      out.push({
        id,
        name: c.name || b?.name || id,
        username: c.username ?? null,
        tier: config.ownerIds.includes(id) ? 'owner' : c.tier ?? b?.tier ?? 'stranger',
        owner: config.ownerIds.includes(id),
        first_seen: c.first_seen ?? null,
        last_seen: c.last_seen ?? null,
        relationship: null,
        missing_them: pct(b?.value), bond: pct(b?.bond),
        aim: null,
        frustration: null,
        memories,
      });
    }
    const rank = (p) => (p.owner ? 3 : 0) + (p.bond || 0) / 100;
    return out.sort((x, y) => rank(y) - rank(x) || String(y.last_seen ?? '').localeCompare(String(x.last_seen ?? '')));
  }, problems);

  const subjects = await part('subjects', async () => {
    try {
      const { interests } = await import('./interests.js');
      return interests.top(40).map((t) => ({ name: t.name, interest: pct(t.interest), mentions: t.mentions ?? 0, last: t.last ?? null, sources: t.sources ?? {}, people: t.people ?? {} }));
    } catch {
      const topics = readJson(path.join(DATA_DIR, 'interests.json'), {})?.topics ?? [];
      return topics.slice(0, 40).map((t) => ({ name: t.name, interest: pct(t.interest), mentions: t.mentions ?? 0, last: t.last ?? null, sources: t.sources ?? {}, people: t.people ?? {} }));
    }
  }, problems);

  const taste = await part('taste', async () => '', problems);

  const wants = await part('wants', async () => {
    const p = await import('./pressure.js');
    const s = p.snapshot();
    const feelings = new Set(s.feelings ?? []);
    const buckets = p.state?.last_tick ? s.buckets : readJson(path.join(DATA_DIR, 'pressure-state.json'), {}).buckets ?? s.buckets;
    return {
      total: s.total, cap: s.cap, last_action: s.last_action ?? null,
      buckets: Object.entries(buckets || {}).map(([name, value]) => ({
        name, value: pct(value), feeling: feelings.has(name),
        label: p.LABEL?.[name] ?? name,
      })).sort((a, b) => b.value - a.value),
    };
  }, problems);

  const goals = await part('goals', async () => {
    try {
      const refl = await import('./reflections.js');
      const items = refl.reflections?.()?.list?.() ?? [];
      return items.filter((i) => i.kind === 'goal' || !i.kind).map((g) => ({ id: g.id, text: g.text, status: g.done ? 'done' : g.dropped ? 'dropped' : 'open', at: g.at }));
    } catch {
      return readJson(path.join(DATA_DIR, 'reflections.json'), {})?.items?.filter((i) => i.kind === 'goal') ?? [];
    }
  }, problems);

  return {
    name: config.botName,
    people: people ?? [],
    subjects: subjects ?? [],
    taste: taste ?? '',
    wants: wants ?? null,
    goals: goals ?? [],
    problems,
  };
}
