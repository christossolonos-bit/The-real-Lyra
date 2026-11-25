import { config } from './config.js';

// Her eyes on a show in her theater (theater.js): what the picture shows, read from storyboards
// (theater-audio.js) by a vision model. Default on this stack: NVIDIA NIM VL. 'off' turns eyes off.

const SIGHT_PROMPT = (frames, from, to) => {
  const gap = Math.max(1, Math.round((to - from) / frames));
  return `These are ${frames} frames from a video, ${gap} second${gap === 1 ? '' : 's'} apart, in order: left to right, then top to bottom. `
    + 'Say what happens across them, in order, as events: who does what, what changes, and what faces and bodies show (fear, shock, joy, crying, reaching out). '
    + 'Anything striking happening to a person or thing comes first: vanishing, dissolving into particles, glowing, breaking, falling, transforming, a sudden new place. '
    + 'Describe people by how they look (for example "a man with curly hair and glasses", "a glowing blue woman"). If there is writing on screen, say what it says. '
    + 'Tell it as one scene going on, the way you would tell what happened in a film; never mention frames, panels or a grid. Don\'t list things that stay the same. Only what the frames show. Three to five sentences.';
};

async function readBoardOllama({ jpeg, frames, from, to, host, model, call }) {
  const res = await call(`${host.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, stream: false, think: false, keep_alive: '10m', options: { num_predict: 350, temperature: 0.2 },
      messages: [{ role: 'user', content: SIGHT_PROMPT(frames, from, to), images: [Buffer.from(jpeg).toString('base64')] }],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(`${model} on the local model server (${host}) didn't read the picture: ${data.error ?? `HTTP ${res.status}`}. Fix: ${/not found|pull/i.test(String(data.error)) ? `pull it (ollama pull ${model}) or set THEATER_SIGHT_MODEL` : 'check that Ollama is running'}`);
  }
  const text = String(data.message?.content ?? '').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error(`${model} read the picture but said nothing about it`);
  return text.slice(0, 900);
}

// 'nvidia': her eyes' model (Nano Omni), and the 120B if it fails (2026-11-25)
async function readBoardNvidia({ jpeg, frames, from, to, model, call }) {
  if (model !== 'nvidia') return readBoardNvidiaWith(model, { jpeg, frames, from, to, call });
  const ids = [config.nvidia.visionModel, config.nvidia.visionFallback].filter((m, i, a) => m && a.indexOf(m) === i);
  let last;
  for (const id of ids) {
    try { return await readBoardNvidiaWith(id, { jpeg, frames, from, to, call }); } catch (err) { last = err; }
  }
  throw last;
}
async function readBoardNvidiaWith(id, { jpeg, frames, from, to, call }) {
  if (!config.nvidia.apiKey) throw new Error('THEATER_SIGHT_MODEL is nvidia, but NVIDIA_API_KEY is empty in .env');
  const res = await call(`${config.nvidia.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.nvidia.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: id,
      temperature: 0.2,
      max_tokens: 400,
      chat_template_kwargs: { enable_thinking: false },
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: SIGHT_PROMPT(frames, from, to) },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${Buffer.from(jpeg).toString('base64')}` } },
        ],
      }],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(`NVIDIA sight (${id}) failed: ${data.error?.message ?? data.error ?? `HTTP ${res.status}`}`);
  }
  const msg = data.choices?.[0]?.message ?? {};
  let text = String(msg.content ?? '').replace(/\s+/g, ' ').trim();
  // Some NIM VL builds put the answer only under reasoning / thinking fields.
  if (!text) text = String(msg.reasoning_content ?? msg.reasoning ?? data.choices?.[0]?.text ?? '').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error(`NVIDIA sight (${id}) read the picture but said nothing`);
  return text.slice(0, 900);
}

export async function readBoard({
  jpeg, frames, from, to,
  host = config.ollama.host,
  model = config.theaterSight.model,
  call = fetch,
} = {}) {
  if (!model || model === 'off') throw new Error('her eyes are off (THEATER_SIGHT_MODEL=off)');
  if (model === 'nvidia' || /^nvidia\//i.test(model) || (config.brain === 'nvidia' && !model.includes(':'))) {
    return readBoardNvidia({ jpeg, frames, from, to, model: model === 'nvidia' ? 'nvidia' : model, call });
  }
  return readBoardOllama({ jpeg, frames, from, to, host, model, call });
}
