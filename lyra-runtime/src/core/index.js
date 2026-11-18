// Lyra Core for the running runtime: one store in the data folder (data/core.db, never committed).
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { createCore } from './core.js';

export const core = createCore({ file: path.join(DATA_DIR, 'core.db') });

// Consolidation runs when she falls asleep (index.js wires it), and at least once a day regardless.
const DAY = 86_400_000;
export function consolidateIfDue(log = () => {}) {
  const last = core.stats().lastConsolidation ?? 0;
  if (Date.now() - last < DAY) return null;
  const r = core.consolidate();
  log(r);
  return r;
}
