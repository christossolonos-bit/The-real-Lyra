import { EventEmitter } from 'node:events';
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

// App-wide activity feed. The dashboard and mind view stream these live; the last few hundred are
// kept for page loads. Also written to data/activity.jsonl so the mind graph can replay activations
// after a restart (same as her other durable logs).
//   bus.emit('activity', { type, ...details })
export const bus = new EventEmitter();
bus.setMaxListeners(100);

const MAX = 300;
export const recentActivity = [];

const LOG = path.join(DATA_DIR, 'activity.jsonl');
const KEEP = 5000;
try {
  if (existsSync(LOG)) writeFileSync(LOG, readFileSync(LOG, 'utf8').split('\n').filter(Boolean).slice(-KEEP).join('\n') + '\n');
} catch {}

export function activity(type, details = {}) {
  const event = { type, time: Date.now(), ...details };
  recentActivity.push(event);
  if (recentActivity.length > MAX) recentActivity.shift();
  try {
    appendFileSync(LOG, JSON.stringify(event) + '\n');
  } catch {}
  bus.emit('activity', event);
  return event;
}
