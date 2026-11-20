// Lyra Core for the running runtime: one store in the data folder (data/core.db, never committed).
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { createCore } from './core.js';

export const core = createCore({ file: path.join(DATA_DIR, 'core.db') });

// Her night work runs on Cyprus time (time.js / config.js): when she falls asleep (index.js wires it), or in the
// Cyprus small hours (2-5 am) once a night, or after 30 hours at the latest. First she takes in the feelings
// from the day's memories ("Chris seemed stressed: Tuesday night"), so she reasons with them too.
const HOUR = 3_600_000;
export function consolidateIfDue(log = () => {}) {
  const last = core.stats().lastConsolidation ?? 0;
  const h = new Date().getHours();
  const night = h >= 2 && h < 5 && Date.now() - last > 12 * HOUR;
  if (!night && Date.now() - last < 30 * HOUR) return null;
  return nightWork(log);
}

export async function learnFeelings() {
  const { listContacts, listMemories } = await import('../memory.js');
  const since = Number(core.meta('feelingsSince')) || 0;
  let n = 0, newest = since;
  for (const c of listContacts()) {
    const name = c.name || c.username;
    if (!name) continue;
    for (const m of listMemories(c.user_id)) {
      if (!m.feeling || m.created_at <= since) continue;
      // what it was about: the memory without the person's name, short
      const topic = String(m.content)
        .replace(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}('s)?\\s*`, 'i'), '')       // "Chris's dad..." -> "dad..."
        .replace(/^(told|said to|asked|showed|admitted to)\s+\w+(\s+that)?\s*/i, '')                       // "told Lyra (that) ..."
        .replace(/^(he|she|they)\s+/i, '').replace(/^(is|was|has|had|have)\s+/i, '')
        .split(/[,.;]/)[0].split(/\s+/).slice(0, 9).join(' ');
      // moments are recalled whole with their feeling; for them Core only notes the mood and the time of day
      core.noteFeeling(name, m.feeling, m.kind === 'moment' ? null : topic, m.created_at);
      n++;
      newest = Math.max(newest, m.created_at);
    }
  }
  core.meta('feelingsSince', newest);
  return n;
}

export async function nightWork(log = () => {}) {
  let feelings = 0;
  try { feelings = await learnFeelings(); } catch {}
  const r = core.consolidate();
  r.feelings = feelings;
  log(r);
  return r;
}
