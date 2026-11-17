/**
 * Semantic body language + micro-expressions for the avatar studio.
 * Maps words/moods → Rocketbox clips the way a person would gesture while thinking or talking.
 */

/** @typedef {{ re: RegExp, label: string, clips: string[], gestures?: string[], micro?: string, fullBody?: boolean }} WordMotion */

/** @type {WordMotion[]} */
export const WORD_MOTIONS = [
  { re: /\b(dance|dancing|party|groove|boogie|rave|disco|club)\b/i, label: 'dancing it out', clips: ['f_dancing_silly', 'f_dancing_cool', 'f_dancing_neutral', 'f_dancing_affective'], gestures: ['laugh', 'nod'], micro: 'joy', fullBody: true },
  { re: /\b(music|song|spotify|youtube|radio|track|beat|melody)\b/i, label: 'feeling the music', clips: ['f_dancing_cool', 'f_headphones_idle', 'f_cheer_02', 'f_idle_shake_arms_01'], gestures: ['nod'], micro: 'excited', fullBody: true },
  { re: /\b(wave|hello|hi\b|hey\b|bye|goodbye|see you)\b/i, label: 'waving', clips: ['f_wave_01', 'f_wave_02'], gestures: ['nod'], micro: 'fond' },
  { re: /\b(laugh|funny|hilarious|lol|lmao|haha|joke)\b/i, label: 'laughing', clips: ['f_gestic_laugh_loud', 'f_gestic_laugh_low', 'f_gestic_laugh_extreme'], gestures: ['laugh'], micro: 'amused' },
  { re: /\b(cheer|yay|congrats|celebrate|woohoo|amazing)\b/i, label: 'cheering', clips: ['f_cheer_01', 'f_cheer_02', 'f_cheer_03', 'f_claphands_01'], gestures: ['laugh', 'nod'], micro: 'joy' },
  { re: /\b(clap|applause|bravo)\b/i, label: 'clapping', clips: ['f_claphands_01', 'f_claphands_02'], gestures: ['nod'], micro: 'joy' },
  { re: /\b(think|wonder|hmm+|ponder|figuring|maybe|consider|remember)\b/i, label: 'thoughtful', clips: ['f_gestic_thoughtful_01', 'f_idle_scratch_head_01', 'f_idle_look_around_02'], gestures: ['tilt'], micro: 'pensive' },
  { re: /\b(shrug|dunno|don't know|idk|whatever|not sure)\b/i, label: 'shrugging', clips: ['f_gestic_shrug_01', 'f_gestic_shrug_02'], gestures: ['shrug'], micro: 'skeptical' },
  { re: /\b(phone|text|message|sms|call me)\b/i, label: 'on her phone', clips: ['f_cell_phone_textmessage'], gestures: ['tilt'], micro: 'curious' },
  { re: /\b(drink|coffee|tea|wine|cheers|sip)\b/i, label: 'sipping', clips: ['f_drink_drinking', 'f_drink_idle'], gestures: ['tilt'], micro: 'calm' },
  { re: /\b(yawn|tired|sleepy|exhausted|bed)\b/i, label: 'yawning', clips: ['f_idle_yawn_01', 'f_idle_stretch_arms_01', 'f_idle_breathe_02'], gestures: ['sigh'], micro: 'tired' },
  { re: /\b(stretch|sore|stiff)\b/i, label: 'stretching', clips: ['f_idle_stretch_arms_01'], gestures: ['sigh'], micro: 'tired' },
  { re: /\b(angry|mad|furious|pissed|rage)\b/i, label: 'heated', clips: ['f_gestic_talk_angry_01', 'f_idle_angry_01', 'f_idle_shake_arms_01'], gestures: ['shake'], micro: 'angry' },
  { re: /\b(nervous|anxious|stressed|worry|worried)\b/i, label: 'nervous energy', clips: ['f_idle_nervous_01', 'f_idle_nervous_02', 'f_gestic_talk_nervous_01'], gestures: ['shrug', 'tilt'], micro: 'worried' },
  { re: /\b(sad|cry|upset|heartbroken|miss you)\b/i, label: 'heavy', clips: ['f_gestic_talk_sad_01', 'f_gestic_listen_sad_01', 'f_idle_breathe_02'], gestures: ['sigh'], micro: 'sad' },
  { re: /\b(explain|present|show you|look at|over here|check this)\b/i, label: 'presenting', clips: ['f_gestic_presentation_left_01', 'f_gestic_presentation_right_01', 'f_gestic_talk_self-assured_01'], gestures: ['nod'], micro: 'confident' },
  { re: /\b(deny|nope|no way|refuse|nah)\b/i, label: 'shutting it down', clips: ['f_gestic_listen_deny_01', 'f_gestic_listen_deny_02', 'f_gestic_shrug_01'], gestures: ['shake'], micro: 'skeptical' },
  { re: /\b(yes|yeah|agree|exactly|right|absolutely)\b/i, label: 'agreeing', clips: ['f_gestic_listen_accept_01', 'f_gestic_listen_accept_02', 'f_gestic_talk_relaxed_01'], gestures: ['nod'], micro: 'fond' },
  { re: /\b(flirt|kiss|cute|handsome|pretty|babe|sexy)\b/i, label: 'flirting', clips: ['f_idle_touch_hair_01', 'f_idle_touch_face_01', 'f_idle_roll_head_01'], gestures: ['wink', 'tilt'], micro: 'flirty' },
  { re: /\b(work|code|script|file|document|write|read)\b/i, label: 'in work mode', clips: ['f_work_mid', 'f_documents_note', 'f_documents_check'], gestures: ['nod'], micro: 'determined' },
  { re: /\b(photo|picture|camera|selfie)\b/i, label: 'camera ready', clips: ['f_take_picture', 'f_idle_touch_hair_01'], gestures: ['tilt'], micro: 'playful' },
  { re: /\b(knock|door|come in)\b/i, label: 'at the door', clips: ['f_knock_door', 'f_listen_door'], gestures: ['tilt'], micro: 'curious' },
  { re: /\b(cool|chill|relax|easy)\b/i, label: 'keeping cool', clips: ['f_gestic_talk_cool', 'f_gestic_talk_relaxed_01', 'f_idle_breathe_01'], gestures: ['tilt'], micro: 'calm' },
  { re: /\b(excited|hype|pumped|can't wait)\b/i, label: 'hyped', clips: ['f_gestic_talk_excited_01', 'f_gestic_talk_excited_02', 'f_cheer_02'], gestures: ['nod', 'laugh'], micro: 'excited' },
];

// Feeling fallbacks when no word hit (still expressive).
export const FEEL_MOTIONS = {
  excited: { label: 'buzzing', clips: ['f_dancing_silly', 'f_cheer_01', 'f_idle_shake_arms_01', 'f_idle_move_01'], gestures: ['nod', 'laugh'], fullBody: true },
  joy: { label: 'lighting up', clips: ['f_cheer_02', 'f_wave_01', 'f_dancing_cool', 'f_idle_move_01'], gestures: ['laugh'], fullBody: true },
  amused: { label: 'holding a laugh', clips: ['f_gestic_laugh_low', 'f_idle_roll_head_01', 'f_idle_move_01'], gestures: ['laugh', 'tilt'], fullBody: true },
  playful: { label: 'scheming', clips: ['f_idle_touch_hair_01', 'f_dancing_silly', 'f_idle_look_around_01', 'f_idle_shake_leg_01'], gestures: ['wink', 'tilt'], fullBody: true },
  flirty: { label: 'daydreaming', clips: ['f_idle_touch_hair_01', 'f_idle_roll_head_01', 'f_idle_move_01'], gestures: ['wink', 'tilt'], fullBody: true },
  fond: { label: 'softening', clips: ['f_idle_breathe_01', 'f_idle_touch_hair_01', 'f_idle_neutral_02'], gestures: ['tilt'], fullBody: true },
  curious: { label: 'wondering', clips: ['f_gestic_thoughtful_01', 'f_idle_look_around_01', 'f_idle_scratch_head_01', 'f_idle_move_01'], gestures: ['tilt'], fullBody: true },
  pensive: { label: 'thinking it through', clips: ['f_gestic_thoughtful_01', 'f_idle_scratch_head_01', 'f_idle_waiting_01', 'f_idle_move_01'], gestures: ['tilt'], fullBody: true },
  worried: { label: 'fidgeting', clips: ['f_idle_nervous_01', 'f_idle_shake_leg_01', 'f_gestic_talk_nervous_01'], gestures: ['shrug', 'sigh'], fullBody: true },
  annoyed: { label: 'side-eyeing', clips: ['f_idle_angry_01', 'f_idle_roll_head_01', 'f_gestic_listen_deny_01', 'f_idle_move_leg_01'], gestures: ['eyeroll', 'shake'], fullBody: true },
  angry: { label: 'stewing', clips: ['f_idle_angry_01', 'f_gestic_talk_angry_01', 'f_idle_shake_arms_01'], gestures: ['shake'], fullBody: true },
  sad: { label: 'sinking', clips: ['f_gestic_talk_sad_01', 'f_idle_breathe_02', 'f_idle_neutral_05'], gestures: ['sigh'], fullBody: true },
  bored: { label: 'zoning out', clips: ['f_idle_yawn_01', 'f_idle_stretch_arms_01', 'f_idle_shake_leg_01', 'f_idle_move_01'], gestures: ['sigh', 'eyeroll'], fullBody: true },
  tired: { label: 'dragging', clips: ['f_idle_yawn_01', 'f_idle_stretch_arms_01', 'f_idle_breathe_02'], gestures: ['sigh'], fullBody: true },
  surprised: { label: 'reeling', clips: ['f_idle_look_around_01', 'f_cheer_03', 'f_idle_move_01'], gestures: ['gasp', 'tilt'], fullBody: true },
  embarrassed: { label: 'flustered', clips: ['f_idle_touch_face_01', 'f_idle_touch_hair_01', 'f_idle_move_01'], gestures: ['tilt'], fullBody: true },
  skeptical: { label: 'not buying it', clips: ['f_gestic_shrug_01', 'f_idle_roll_head_01', 'f_idle_move_01'], gestures: ['eyeroll', 'shake'], fullBody: true },
  confident: { label: 'sure of it', clips: ['f_gestic_talk_self-assured_01', 'f_idle_waiting_01', 'f_idle_neutral_02'], gestures: ['nod'], fullBody: true },
  determined: { label: 'locking in', clips: ['f_gestic_talk_self-assured_02', 'f_idle_waiting_01', 'f_idle_move_01'], gestures: ['nod'], fullBody: true },
  calm: { label: 'taking her time', clips: ['f_idle_breathe_01', 'f_idle_neutral_01', 'f_gestic_talk_relaxed_01'], gestures: ['tilt'], fullBody: true },
};

export const DEFAULT_MOTION = {
  label: 'thinking',
  clips: ['f_gestic_thoughtful_01', 'f_idle_look_around_01', 'f_idle_waiting_01', 'f_idle_move_01'],
  gestures: ['tilt', 'nod'],
  fullBody: true,
};

/** All clip names we should prefetch for expression. */
export function expressClipNames() {
  const set = new Set(DEFAULT_MOTION.clips);
  for (const m of WORD_MOTIONS) m.clips.forEach((c) => set.add(c));
  for (const m of Object.values(FEEL_MOTIONS)) m.clips.forEach((c) => set.add(c));
  return [...set];
}

/**
 * Prefer word-associated Rocketbox motions; fall back to feeling, then default.
 * @returns {{ label: string, clips: string[], gestures: string[], fullBody?: boolean, source: string, hits: string[] }}
 */
export function resolveBodyLanguage(text, feeling) {
  const raw = String(text || '');
  const hits = WORD_MOTIONS.filter((m) => m.re.test(raw));
  if (hits.length) {
    // Strongest / first semantic hit wins; merge a second hit's clips for variety.
    const primary = hits[0];
    const clips = [...primary.clips];
    if (hits[1]) clips.push(...hits[1].clips.slice(0, 2));
    return {
      label: primary.label,
      clips,
      gestures: primary.gestures || ['tilt'],
      fullBody: Boolean(primary.fullBody || hits.some((h) => h.fullBody)),
      source: 'word',
      hits: hits.map((h) => h.label),
      micro: primary.micro || feeling || null,
    };
  }
  const feel = feeling && FEEL_MOTIONS[feeling];
  if (feel) return { ...feel, gestures: feel.gestures || ['tilt'], source: 'feel', hits: [feeling] };
  return { ...DEFAULT_MOTION, source: 'default', hits: [] };
}

/** Fleeting face shapes — kept soft so Blender-amplified ARKit deltas don't go cartoon. */
const MICRO_BY_MOOD = {
  joy: { mouthSmileLeft: 0.22, mouthSmileRight: 0.18, cheekSquintLeft: 0.18, cheekSquintRight: 0.14, browOuterUpLeft: 0.12, eyeSquintLeft: 0.1, eyeSquintRight: 0.08 },
  amused: { mouthSmileLeft: 0.26, mouthSmileRight: 0.12, eyeSquintLeft: 0.2, eyeSquintRight: 0.16, cheekSquintLeft: 0.2, browOuterUpLeft: 0.08 },
  excited: { browInnerUp: 0.16, browOuterUpLeft: 0.18, browOuterUpRight: 0.18, eyeWideLeft: 0.1, eyeWideRight: 0.1, mouthSmileLeft: 0.18, mouthSmileRight: 0.18, cheekSquintLeft: 0.1 },
  playful: { browOuterUpLeft: 0.22, mouthSmileLeft: 0.22, mouthSmileRight: 0.06, eyeSquintRight: 0.14, cheekSquintLeft: 0.1 },
  flirty: { eyeBlinkLeft: 0.12, mouthSmileLeft: 0.22, mouthSmileRight: 0.14, browOuterUpLeft: 0.14, cheekSquintLeft: 0.12, mouthDimpleLeft: 0.1 },
  fond: { mouthSmileLeft: 0.16, mouthSmileRight: 0.16, browInnerUp: 0.1, cheekSquintLeft: 0.08, cheekSquintRight: 0.08, eyeBlinkLeft: 0.06, eyeBlinkRight: 0.06 },
  curious: { browOuterUpLeft: 0.2, browInnerUp: 0.14, eyeWideLeft: 0.08, eyeWideRight: 0.06, mouthPucker: 0.05, mouthSmileLeft: 0.05 },
  pensive: { browDownLeft: 0.16, browInnerUp: 0.14, mouthPressLeft: 0.16, mouthRollLower: 0.1, eyeSquintLeft: 0.08 },
  worried: { browInnerUp: 0.24, browDownLeft: 0.1, browDownRight: 0.1, eyeWideLeft: 0.1, eyeWideRight: 0.1, mouthPressLeft: 0.14, mouthFrownLeft: 0.08 },
  annoyed: { browDownLeft: 0.24, browDownRight: 0.18, eyeSquintLeft: 0.2, mouthPressLeft: 0.2, noseSneerLeft: 0.1 },
  angry: { browDownLeft: 0.3, browDownRight: 0.3, noseSneerLeft: 0.16, noseSneerRight: 0.16, mouthPressLeft: 0.22, mouthPressRight: 0.22, eyeSquintLeft: 0.12, eyeSquintRight: 0.12 },
  sad: { browInnerUp: 0.24, mouthFrownLeft: 0.2, mouthFrownRight: 0.2, eyeBlinkLeft: 0.1, eyeBlinkRight: 0.1, cheekSquintLeft: 0.06 },
  tired: { eyeBlinkLeft: 0.22, eyeBlinkRight: 0.22, browInnerUp: 0.08, mouthFrownLeft: 0.08, mouthFrownRight: 0.06 },
  bored: { eyeBlinkLeft: 0.18, eyeBlinkRight: 0.14, mouthLeft: 0.12, browDownLeft: 0.1, mouthSmileRight: 0.03 },
  surprised: { browInnerUp: 0.22, browOuterUpLeft: 0.2, browOuterUpRight: 0.2, eyeWideLeft: 0.16, eyeWideRight: 0.16, mouthSmileLeft: 0.04, mouthSmileRight: 0.04 },
  embarrassed: { mouthSmileLeft: 0.16, mouthPressLeft: 0.16, browInnerUp: 0.14, eyeBlinkLeft: 0.1, eyeBlinkRight: 0.1, cheekSquintLeft: 0.12 },
  skeptical: { browDownLeft: 0.24, browOuterUpRight: 0.2, eyeSquintLeft: 0.2, mouthPressLeft: 0.16, mouthSmileRight: 0.05 },
  calm: { mouthSmileLeft: 0.08, mouthSmileRight: 0.08, browInnerUp: 0.04, cheekSquintLeft: 0.04 },
  confident: { mouthSmileLeft: 0.12, mouthSmileRight: 0.12, browDownLeft: 0.08, eyeSquintLeft: 0.08, eyeSquintRight: 0.06 },
  determined: { browDownLeft: 0.18, browDownRight: 0.18, mouthPressLeft: 0.16, mouthPressRight: 0.16, eyeSquintLeft: 0.08 },
};

const MICRO_FLICKERS = [
  { browOuterUpLeft: 0.14, browOuterUpRight: 0.04, mouthSmileLeft: 0.08 },
  { eyeSquintLeft: 0.14, mouthSmileLeft: 0.1, cheekSquintLeft: 0.1 },
  { browInnerUp: 0.12, mouthPressLeft: 0.1, eyeSquintLeft: 0.06 },
  { noseSneerLeft: 0.08, browDownLeft: 0.1, eyeSquintLeft: 0.08 },
  { cheekSquintLeft: 0.12, cheekSquintRight: 0.08, mouthSmileLeft: 0.1, mouthSmileRight: 0.06 },
  { eyeBlinkLeft: 0.28, mouthSmileLeft: 0.06 },
  { eyeBlinkRight: 0.28, mouthSmileRight: 0.06 },
  { browOuterUpRight: 0.16, mouthSmileRight: 0.1, eyeSquintRight: 0.08 },
  { browDownLeft: 0.12, browOuterUpRight: 0.12, mouthPressLeft: 0.08 },
  { mouthDimpleLeft: 0.14, mouthSmileLeft: 0.12, cheekSquintLeft: 0.08 },
];

export function pickMicroShapes(mood, talking) {
  if (mood && MICRO_BY_MOOD[mood] && Math.random() < (talking ? 0.35 : 0.48)) {
    return { ...MICRO_BY_MOOD[mood] };
  }
  return { ...MICRO_FLICKERS[Math.floor(Math.random() * MICRO_FLICKERS.length)] };
}

/** Envelope 0..1 for a micro that lives from born→until. */
export function microWeight(now, born, until) {
  const dur = Math.max(1, until - born);
  const t = (now - born) / dur;
  if (t <= 0 || t >= 1) return 0;
  if (t < 0.22) return t / 0.22;
  if (t > 0.68) return (1 - t) / 0.32;
  return 0.55 + 0.08 * Math.sin(t * Math.PI * 2);
}
