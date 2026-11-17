import path from 'node:path';
import { pipeline, env } from '@huggingface/transformers';
import { ROOT, config } from '../config.js';
import { activity } from '../events.js';

// Models download once (from Hugging Face) into ./models, then run fully offline on this PC.
env.cacheDir = path.join(ROOT, 'models');

let loading = null;
let queue = Promise.resolve();

// Loads Whisper on the GPU (DirectML) if possible, otherwise on the CPU.
export function loadWhisper() {
  loading ??= (async () => {
    const started = Date.now();
    const devices = config.whisper.device === 'auto' ? ['dml', 'cpu'] : [config.whisper.device];
    let lastError;
    for (const device of devices) {
      try {
        const asr = await pipeline('automatic-speech-recognition', config.whisper.model, { device });
        activity('ready', { message: `Whisper ${config.whisper.model} loaded on ${device} in ${((Date.now() - started) / 1000).toFixed(1)}s` });
        return asr;
      } catch (err) {
        lastError = err;
      }
    }
    loading = null; // let the next utterance retry
    throw new Error(`Could not load Whisper: ${lastError?.message}`);
  })();
  return loading;
}

// Takes 48kHz mono 16-bit PCM (what the voice receiver produces) and returns the transcript.
export function transcribeLocal(pcm48k, { timestamps = false } = {}) {
  // One transcription at a time so overlapping speakers don't fight over the CPU/GPU.
  const job = queue.then(async () => {
    const asr = await loadWhisper();
    const options = {};
    const multilingual = !config.whisper.model.endsWith('.en');
    if (multilingual && config.fish.language) {
      options.language = config.fish.language;
      options.task = 'transcribe';
    }
    if (timestamps) options.return_timestamps = true;
    const result = await asr(downsample(pcm48k), options);
    if (!timestamps) return clean(result.text);
    const chunks = Array.isArray(result.chunks) ? result.chunks : [];
    if (chunks.length) {
      return chunks.map((c) => {
        const [start, end] = Array.isArray(c.timestamp) ? c.timestamp : [0, 0];
        return {
          start: Math.max(0, Number(start) || 0),
          end: Math.max(Number(start) || 0, Number(end) || Number(start) || 0),
          text: clean(c.text),
        };
      }).filter((l) => l.text);
    }
    const text = clean(result.text);
    const dur = pcm48k.length / 2 / 48000;
    return text ? [{ start: 0, end: dur, text }] : [];
  });
  queue = job.catch(() => {});
  return job;
}

// 48kHz int16 -> 16kHz float32, averaging each group of 3 samples (a cheap low-pass).
function downsample(pcm) {
  const samples = Math.floor(pcm.length / 2 / 3);
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const o = i * 6;
    out[i] = (pcm.readInt16LE(o) + pcm.readInt16LE(o + 2) + pcm.readInt16LE(o + 4)) / (3 * 32768);
  }
  return out;
}

// Whisper "hears" these in background noise and silence.
const HALLUCINATIONS = /^(thank you|thanks for watching|thank you for watching|you|bye|okay|so|uh|um|hmm)[.!?]*$/i;

export function clean(text = '') {
  const t = text
    .replace(/\[[^\]]*\]|\([^)]*\)/g, '') // [BLANK_AUDIO], (music), ...
    .replace(/\s+/g, ' ')
    .trim();
  return HALLUCINATIONS.test(t) || !/[a-z0-9]/i.test(t) ? '' : t;
}
