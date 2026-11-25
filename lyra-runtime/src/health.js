// Lyra's health at a glance (2026-11-25), for the dashboard's Health page. Most problems that week were invisible
// until Chris noticed something odd: the 120B quietly down, a model removed from NVIDIA, memory-saving failing, her
// saved settings overriding .env. This reads her activity log and settings and says plainly what works and what
// doesn't. checkModels() pings each model once, only when he asks (a handful of free requests).
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { config, DATA_DIR } from './config.js';

const HOUR = 3_600_000;
const short = (m) => String(m || '').split('/').pop();

function recentEvents(sinceMs) {
  try {
    const lines = readFileSync(path.join(DATA_DIR, 'activity.jsonl'), 'utf8').trim().split('\n');
    const out = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      let e; try { e = JSON.parse(lines[i]); } catch { continue; }
      if (e.time < sinceMs) break;
      out.push(e);
    }
    return out.reverse();
  } catch { return []; }
}
const envValue = (key) => {
  try { return (readFileSync(path.join(DATA_DIR, '..', '.env'), 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1] || '').trim(); } catch { return ''; }
};
const savedSetting = (key) => { try { return JSON.parse(readFileSync(path.join(DATA_DIR, 'settings.json'), 'utf8'))[key]; } catch { return undefined; } };

export async function healthSnapshot() {
  const now = Date.now();
  const ev = recentEvents(now - HOUR);
  const replies = ev.filter((e) => e.type === 'replied');
  const byModel = {};
  for (const r of replies) { const m = short(r.model || config.nvidia.model); byModel[m] = (byModel[m] || 0) + 1; }
  const fallbacks = ev.filter((e) => e.type === 'brain');
  const errors = ev.filter((e) => e.type === 'error');
  const errorGroups = {};
  for (const e of errors) {
    const k = e.where || 'other';
    errorGroups[k] ??= { where: k, count: 0, last: '', at: 0 };
    errorGroups[k].count++; errorGroups[k].last = String(e.message || '').slice(0, 160); errorGroups[k].at = e.time;
  }
  const avgMs = replies.length ? Math.round(replies.reduce((a, r) => a + (r.ms || 0), 0) / replies.length) : null;
  const last = (pred) => [...ev].reverse().find(pred);
  const checks = [];
  const add = (area, state, text) => checks.push({ area, state, text });

  // her brain
  const envModel = envValue('NVIDIA_MODEL'), saved = savedSetting('nvidiaModel');
  if (saved && envModel && saved !== envModel) add('Talking model', 'warn', `The dashboard Settings say ${short(saved)}, .env says ${short(envModel)}: the Settings win. She uses ${short(config.nvidia.model)}.`);
  const big = replies.filter((r) => !r.model || r.model === config.nvidia.model).length;
  if (!replies.length) add('Replies', 'idle', 'No replies in the last hour.');
  else if (big / replies.length < 0.5) add('Replies', 'warn', `Only ${big} of ${replies.length} replies came from ${short(config.nvidia.model)} in the last hour; the backup wrote the rest (it's probably slow or down).`);
  else add('Replies', 'ok', `${replies.length} replies in the last hour, ${big} from ${short(config.nvidia.model)}, about ${(avgMs / 1000).toFixed(1)} s each.`);
  // memory
  const remembered = ev.filter((e) => e.type === 'remembered').length;
  const memErr = (errorGroups['memory extraction']?.count || 0) + (errorGroups['memory recall']?.count || 0);
  add('Memory', memErr ? 'bad' : 'ok', memErr ? `${memErr} memory errors in the last hour: "${(errorGroups['memory extraction'] || errorGroups['memory recall']).last}"` : `Saving and recall working${remembered ? ` (${remembered} saves in the last hour)` : ''}.`);
  // hearing (2026-11-25: after a GPU driver reset every voice reply and voice message failed for hours)
  const GPU = /887A000|DmlExecutionProvider|CUDA failed|device instance has been suspended|readback failed/i;
  const deaf = errors.filter((e) => GPU.test(String(e.message)) && /voice reply|attachment|theater stt/.test(e.where || '')).length;
  const moved = errors.filter((e) => e.where === 'hearing').length;
  if (deaf >= 3) add('Hearing', 'bad', `${deaf} times she couldn't hear (voice calls or voice messages) because the graphics card stopped answering. Restart her with Start Lyra.bat.`);
  else if (moved) add('Hearing', 'warn', 'The graphics card stopped answering, so she hears on the CPU for now (a little slower); it tries the card again after 10 minutes.');
  else add('Hearing', 'ok', 'Voice calls and voice messages are being heard.');
  // eyes
  const eyesFail = fallbacks.filter((e) => /^eyes:/.test(e.message || '')).length + (errorGroups.attachment?.count || 0) - errors.filter((e) => e.where === 'attachment' && GPU.test(String(e.message))).length;
  add('Eyes', eyesFail ? 'warn' : 'ok', eyesFail ? `${eyesFail} photo problems in the last hour (the backup looked, or a photo couldn't be read).` : `Using ${short(config.nvidia.visionModel)}, backup ${short(config.nvidia.visionFallback)}.`);
  // YouTube
  try {
    const yt = await import('./yt-channel.js');
    const s = yt.youtubeSnapshot();
    const tok = (() => { try { return JSON.parse(readFileSync(path.join(DATA_DIR, 'youtube', 'token.json'), 'utf8')); } catch { return null; } })();
    if (!s.ready.client) add('YouTube', 'idle', 'Not set up.');
    else if (!s.ready.signedIn) add('YouTube', 'bad', 'Not signed in: run Sign in Lyra YouTube.bat.');
    else {
      const ytErr = errorGroups.youtube;
      // when she signed in (older sign-ins didn't record it: then when the token file was first made)
      let since = tok?.signedInAt || null;
      if (!since) { try { since = statSync(path.join(DATA_DIR, 'youtube', 'token.json')).birthtimeMs || null; } catch {} }
      const age = since ? (now - since) / 86_400_000 : null;
      if (ytErr && /expired|revoked|invalid_grant/i.test(ytErr.last)) add('YouTube', 'bad', 'Her YouTube sign-in expired: run Sign in Lyra YouTube.bat.');
      else if (age !== null && age > 6) add('YouTube', 'warn', `Signed in ${age.toFixed(0)} days ago: in Testing mode it expires after 7, so sign in again soon.`);
      else add('YouTube', 'ok', `Signed in as ${s.ready.me?.title || 'her channel'}${age !== null ? ` (${(7 - age).toFixed(0)} days left before it needs signing in again)` : ''}; ${s.drafts.filter((d) => d.status === 'pending').length} drafts waiting.`);
    }
  } catch {}
  // anything else that failed
  for (const g of Object.values(errorGroups)) {
    if (['memory extraction', 'memory recall', 'attachment', 'youtube', 'voice reply', 'hearing', 'theater stt timestamps'].includes(g.where) && (g.where !== 'voice reply' || GPU.test(g.last))) continue;
    add(`Errors: ${g.where}`, g.count >= 3 ? 'bad' : 'warn', `${g.count}× in the last hour, last: "${g.last}"`);
  }

  let requests = 0;
  try { requests = (await import('./llm.js')).nvidiaCallsLastMinute(); } catch {}
  return {
    at: now,
    overall: checks.some((c) => c.state === 'bad') ? 'bad' : checks.some((c) => c.state === 'warn') ? 'warn' : 'ok',
    checks,
    models: {
      talking: config.nvidia.model, backup: config.nvidia.fallbackModels, planning: config.nvidia.planModels,
      eyes: config.nvidia.visionModel, eyesBackup: config.nvidia.visionFallback, teachers: config.nvidia.teacherModels, memory: config.nvidia.embedModel,
    },
    lastHour: { replies: replies.length, byModel, avgMs, fallbacks: fallbacks.length, lastFallback: last((e) => e.type === 'brain')?.message || null, errors: errors.length },
    requestsLastMinute: requests,
    errorGroups: Object.values(errorGroups).sort((a, b) => b.at - a.at),
  };
}

// one tiny request to each model she uses (on demand): is it there, and how fast
const DOT = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
export async function checkModels() {
  const n = config.nvidia;
  const jobs = [
    ['Talking', n.model, 'chat'], ...n.fallbackModels.map((m) => ['Talking backup', m, 'chat']),
    ...n.planModels.map((m) => ['Planning', m, 'chat']), ...n.teacherModels.map((m) => ['Core teacher', m, 'chat']),
    ['Eyes', n.visionModel, 'vision'], ['Eyes backup', n.visionFallback, 'vision'], ['Memory search', n.embedModel, 'embed'],
  ];
  const seen = new Set();
  const out = [];
  for (const [role, model, kind] of jobs) {
    const key = `${model}|${kind}`;
    if (!model || seen.has(key)) { if (model) out.find((o) => o.model === model && o.kind === kind)?.roles.push(role); continue; }
    seen.add(key);
    const t = Date.now();
    let ok = false, note = '';
    try {
      const body = kind === 'embed'
        ? { model, input: ['hello'], input_type: 'query', encoding_format: 'float' }
        : { model, max_tokens: 5, temperature: 0, chat_template_kwargs: { enable_thinking: false },
          messages: [{ role: 'user', content: kind === 'vision' ? [{ type: 'text', text: 'Say ok.' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${DOT}` } }] : 'Say ok.' }] };
      const res = await fetch(`${n.baseUrl}/${kind === 'embed' ? 'embeddings' : 'chat/completions'}`, {
        method: 'POST', headers: { Authorization: `Bearer ${n.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
      });
      ok = res.ok;
      if (!ok) note = (await res.text()).replace(/\s+/g, ' ').slice(0, 140);
    } catch (err) { note = err.name === 'TimeoutError' ? 'no answer in 30 s' : err.message.slice(0, 100); }
    out.push({ roles: [role], model, kind, ok, ms: Date.now() - t, note });
  }
  return out;
}

export const healthFileExists = () => existsSync(path.join(DATA_DIR, 'activity.jsonl'));
