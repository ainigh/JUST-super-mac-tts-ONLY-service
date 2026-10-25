// Everything the avatar can show, by name, as TalkingHead has it: moods (the face's resting state,
// and how it moves while it talks), expressions (a few seconds on the face), hand gestures, head
// movements and body poses. The API, the rules and the model all pick from these lists, so nothing
// can be asked for that doesn't exist.

/** Moods: TalkingHead's animMoods. They last until changed. */
export const MOODS = {
  neutral: 'calm, matter-of-fact',
  happy: 'cheerful, pleased, upbeat',
  love: 'warm, tender, affectionate',
  sad: 'sorry, disappointed, sympathetic to bad news',
  fear: 'worried, nervous, alarmed',
  angry: 'annoyed, indignant, stern',
  disgust: 'grossed out, appalled',
  sleep: 'tired, drowsy',
};

/** Expressions: TalkingHead's animated emojis (face only), by a name each. */
export const EXPRESSIONS = {
  neutral: { emoji: '😐', means: 'a straight face' },
  smile: { emoji: '🙂', means: 'a small smile' },
  warm: { emoji: '😊', means: 'a warm, kind smile' },
  grin: { emoji: '😀', means: 'a big smile' },
  delighted: { emoji: '😃', means: 'wide-eyed joy' },
  beaming: { emoji: '😄', means: 'a beaming smile, eyes squinting' },
  laughing: { emoji: '😂', means: 'laughing at something funny' },
  playful: { emoji: '😜', means: 'joking, cheeky, tongue out' },
  wink: { emoji: '😉', means: 'a wink: a joke or a shared secret' },
  smirk: { emoji: '😏', means: 'a knowing, sly smile' },
  adoring: { emoji: '🥰', means: 'adoring, touched' },
  starstruck: { emoji: '😍', means: 'amazed, in awe, loving it' },
  kiss: { emoji: '😘', means: 'blowing a kiss' },
  thinking: { emoji: '🤔', means: 'thinking it over, unsure' },
  glance: { emoji: '👀', means: 'glancing aside' },
  eyeroll: { emoji: '🙄', means: 'rolling the eyes: exasperated, sarcastic' },
  unamused: { emoji: '😒', means: 'unimpressed, skeptical' },
  grimace: { emoji: '😬', means: 'awkward, yikes' },
  embarrassed: { emoji: '😳', means: 'embarrassed, flustered, caught out' },
  shocked: { emoji: '😱', means: 'shocked, horrified' },
  frown: { emoji: '☹️', means: 'a frown: displeased' },
  disappointed: { emoji: '😞', means: 'disappointed, let down' },
  pensive: { emoji: '😔', means: 'sad and thoughtful, regretful' },
  pleading: { emoji: '🥺', means: 'pleading, moved, almost tearful' },
  crying: { emoji: '😭', means: 'crying, heartbroken' },
  angry: { emoji: '😠', means: 'angry' },
  sleepy: { emoji: '😴', means: 'falling asleep' },
};

/** Hand gestures: TalkingHead's gesture templates, and five for both hands made of them (renderer/gestures.mjs). */
export const GESTURES = {
  handup: 'a hand raised: hello, goodbye, stop, or "one moment"',
  index: 'pointing with the index finger: "this", "here", "first", making a point',
  ok: 'the OK sign: "perfect", "done", "all good"',
  thumbup: 'a thumbs-up: "great", "well done", agreement',
  thumbdown: 'a thumbs-down: "bad", "no good", disapproval',
  side: 'a hand out to the side: "on the other hand", presenting',
  shrug: 'a shrug: "I don\'t know", "who knows", "whatever"',
  namaste: 'hands together: thanks, please, respect',
  wide: 'both arms open wide: "all", "everything", "huge", "we"',
  bothup: 'both hands up: "stop", "whoa", "hold it"',
  clasp: 'hands clasped low in front: waiting, patient',
  hold: 'hands held together at the waist: waiting, ready',
  wring: 'hands pressed together, rubbing: eager, anxious, "any moment now"',
};

/** Where it looks: at the user, ahead (the way it faces), away (thinking), or down. */
export const LOOKS = ['camera', 'ahead', 'away', 'down'];

/** Which way it faces: the user, or turned a little to its left or right (as the user sees it). */
export const TURNS = ['user', 'left', 'right'];

/** Head movements: TalkingHead's yes / no emoji animations. */
export const HEAD = {
  yes: 'a nod: yes, agreeing, "right"',
  no: 'a shake: no, disagreeing, "not at all"',
};

/** Body poses: TalkingHead's pose templates. The first five are standing poses. */
export const POSES = {
  straight: 'standing straight',
  side: 'standing, weight on one leg',
  hip: 'hand on hip',
  turn: 'turned a little to the side',
  wide: 'feet apart, confident',
  back: 'leaning back',
  bend: 'bending forward',
  oneknee: 'down on one knee',
  kneel: 'kneeling',
  sitting: 'sitting on the floor',
};

/** Poses the director picks from (it never kneels or sits on its own). */
export const STANDING_POSES = ['straight', 'side', 'hip', 'turn', 'wide'];

/** Emoji → expression or gesture, for emojis written into the text. */
export const EMOJI = (() => {
  const map = {};
  for (const [name, e] of Object.entries(EXPRESSIONS)) map[e.emoji] = { expression: name };
  Object.assign(map, {
    '😶': { expression: 'neutral' },
    '🙃': { expression: 'smile' },
    '😇': { expression: 'warm' },
    '😁': { expression: 'beaming' },
    '😆': { expression: 'laughing' },
    '🤣': { expression: 'laughing' },
    '😅': { expression: 'laughing' },
    '😋': { expression: 'playful' },
    '😛': { expression: 'playful' },
    '😝': { expression: 'playful' },
    '🤪': { expression: 'playful' },
    '😚': { expression: 'kiss' },
    '🤩': { expression: 'starstruck' },
    '😡': { expression: 'angry' },
    '🤬': { expression: 'angry' },
    '✋': { gesture: 'handup' },
    '🤚': { gesture: 'handup' },
    '👋': { gesture: 'handup' },
    '👍': { gesture: 'thumbup' },
    '👎': { gesture: 'thumbdown' },
    '👌': { gesture: 'ok' },
    '👉': { gesture: 'index' },
    '☝️': { gesture: 'index' },
    '🤷': { gesture: 'shrug' },
    '🤷‍♂️': { gesture: 'shrug' },
    '🤷‍♀️': { gesture: 'shrug' },
    '🙏': { gesture: 'namaste' },
  });
  return map;
})();

/** An expression asked for by name or by its emoji: its name, or null. */
export function expressionName(x) {
  if (!x) return null;
  const s = String(x).trim();
  if (EXPRESSIONS[s.toLowerCase()]) return s.toLowerCase();
  return EMOJI[s]?.expression || null;
}

/** A gesture asked for by name or by its emoji (or "wave"): its name, or null. */
export function gestureName(x) {
  if (!x) return null;
  const s = String(x).trim();
  const k = s.toLowerCase();
  if (GESTURES[k]) return k;
  if (k === 'wave' || k === 'hello' || k === 'hi') return 'handup';
  if (k === 'thumbsup' || k === 'thumbs_up') return 'thumbup';
  if (k === 'thumbsdown' || k === 'thumbs_down') return 'thumbdown';
  if (k === 'point') return 'index';
  return EMOJI[s]?.gesture || null;
}

export const moodName = (x) => (x && MOODS[String(x).trim().toLowerCase()] ? String(x).trim().toLowerCase() : null);
export const headName = (x) => (x && HEAD[String(x).trim().toLowerCase()] ? String(x).trim().toLowerCase() : null);
export const poseName = (x) => (x && POSES[String(x).trim().toLowerCase()] ? String(x).trim().toLowerCase() : null);

/** The whole catalog, as GET /api/catalog answers it. */
export function catalogJSON() {
  return {
    moods: MOODS,
    expressions: Object.fromEntries(Object.entries(EXPRESSIONS).map(([k, v]) => [k, v])),
    gestures: GESTURES,
    head: HEAD,
    poses: POSES,
    looks: LOOKS,
    turns: TURNS,
    emoji: EMOJI,
  };
}
