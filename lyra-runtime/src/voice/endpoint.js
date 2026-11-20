// When has someone finished talking? Not after every pause.
// Chris (2026-11-20): "I'd like to be able to finish my sentences even if I pause."
// Each pause still ends a piece of speech, but the words are held for a moment: a short beat if the sentence
// sounds finished, longer if it sounds cut off ("and...", "so...", "the..."). Speaking again within that time
// joins the same turn. The same rules live in companion/ears/ears.py for the PC mic.
import { config } from '../config.js';

// words people pause after when they haven't finished
const TRAILING = /\b(and|but|so|or|because|cause|cuz|um+|uh+|er+|like|the|a|an|to|of|with|for|from|in|on|at|if|when|while|that|which|who|what|my|your|our|their|his|her|i|i'm|im|it's|is|was|are|were|then|also|just|maybe|actually|well|about|into|than|as|not|really|very|kind of|sort of|you know|i mean|let me|i think|i want|i need)[,.…-]*$/i;

export function soundsUnfinished(text) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  if (/(\.\.\.|…|,|-|–)$/.test(t)) return true;           // trailing off
  if (TRAILING.test(t)) return true;                        // ends on a connecting word or a filler
  if (!/[.!?]["')]*$/.test(t)) return true;                 // no closing punctuation from the transcriber
  return false;
}

// how long to keep listening after this piece of speech
export function waitFor(text) {
  return soundsUnfinished(text) ? config.voice.thinkMs : config.voice.graceMs;
}
