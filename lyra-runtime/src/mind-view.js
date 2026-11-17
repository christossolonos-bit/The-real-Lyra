import { config } from './config.js';
import { bus } from './events.js';

// Her mind page's camera, by voice (owner, 2026-11-13: "I'm looking at this through a shared screen over Discord, so
// I've got to tell her how to navigate and change screens and do all that stuff by voice"). Each command goes live to
// every open mind page (dashboard/public/mind.html, through /api/avatar/live), which reports back how many pages got it.
// Changing screens is her browser's job (it opens these addresses); this only steers the mind page itself.

export const REGIONS = ['hearing', 'intake', 'memory', 'curiosity', 'pressure', 'feelings', 'taste', 'intuition', 'thoughts', 'hands', 'voice', 'body', 'presence', 'architect', 'sleep', 'faults'];
const dash = () => `http://127.0.0.1:${config.dashboard.port}`;
// Her screens, for her browser: what each one is.
export const SCREENS = {
  mind: ['/mind.html', 'her mind: the 3D brain, neurons firing as she hears, thinks, wants and acts'],
  graph: ['/mind-graph.html', 'her knowledge graph: everything she knows and how it connects'],
  studio: ['/avatar.html', 'the Avatar Studio: her 3D body'],
  theater: ['/theater.html', 'her theater'],
  dashboard: ['/index.html', 'her dashboard'],
};
export const screenUrl = (name) => { const s = SCREENS[String(name ?? '').toLowerCase().trim()]; return s ? `${dash()}${s[0]}` : null; };

let viewers = 0;
export const mindViewers = () => viewers;
export const mindPageOpened = () => { viewers++; return () => { viewers = Math.max(0, viewers - 1); }; };

// One command for the page. Returns what will happen, in words, or throws saying what's wrong.
export function mindCommand({ action, target, amount } = {}) {
  const a = String(action ?? '').toLowerCase().trim();
  const t = String(target ?? '').trim();
  let cmd;
  if (a === 'follow' || a === 'orbit') cmd = { mode: a };
  else if (a === 'bigger' || a === 'smaller') cmd = { big: a === 'bigger' };
  else if (a === 'focus') { if (!t) throw new Error('Say what to fly to (target): a part of her mind (' + REGIONS.join(', ') + ') or something she knows, by name.'); cmd = { focus: t }; }
  else if (a === 'zoom_in' || a === 'zoom_out') cmd = { zoom: a === 'zoom_in' ? -1 : 1, steps: Math.max(1, Math.min(5, Number(amount) || 1)) };
  else if (['left', 'right', 'up', 'down'].includes(a)) cmd = { turn: a, steps: Math.max(1, Math.min(6, Number(amount) || 1)) };
  else if (a === 'spin' || a === 'stop_spin') cmd = { spin: a === 'spin' };
  else if (a === 'reset') cmd = { reset: true };
  else throw new Error(`There's no mind view action called ${action}.`);
  bus.emit('mind-view', cmd);
  return cmd;
}
