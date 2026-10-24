// What the avatar does while it talks: for each sentence, a mood, an expression, a hand gesture, a
// head movement (any of them may be none). Three sources, in order:
//   1. what the caller asked for (fields on the request, emojis and [tags] in the text);
//   2. the model (Ollama's, the one the assistant thinks with): one question per
//      utterance, every sentence answered at once, with only the catalog's names allowed;
//   3. rules: words and punctuation, instant and offline (used while the model hasn't answered,
//      or when it's off or unreachable).

import { EXPRESSIONS, GESTURES, HEAD, MOODS, expressionName, gestureName, headName, moodName } from './catalog.mjs';
import { words } from './text.mjs';

// ---------------------------------------------------------------- rules

/** Words (or phrases) and what they show. Checked in order; the first of each kind wins. */
const RULES = [
  // greetings and goodbyes
  { re: /\b(hi|hello|hey|good (morning|afternoon|evening)|welcome|bye|goodbye|see you|farewell)\b/, gesture: 'handup', expression: 'grin', mood: 'happy' },
  // thanks, please, apologies
  { re: /\b(thank(s| you)|grateful|appreciate)\b/, gesture: 'namaste', expression: 'warm', mood: 'happy' },
  { re: /\b(sorry|apolog|unfortunately|sadly|i'm afraid|bad news|regret|condolence|passed away|lost)\b/, expression: 'pensive', mood: 'sad' },
  // big feelings
  { re: /\b(love|adore|sweet|lovely|dear|darling|cute)\b/, expression: 'adoring', mood: 'love' },
  { re: /\b(wow|amazing|incredible|awesome|fantastic|brilliant|unbelievable|stunning)\b/, expression: 'starstruck', mood: 'happy' },
  { re: /\b(great|excellent|well done|nice work|good job|congrat|perfect|nailed)\b/, gesture: 'thumbup', expression: 'beaming', mood: 'happy' },
  { re: /\b(haha|ha ha|lol|funny|hilarious|joke|kidding)\b/, expression: 'laughing', mood: 'happy' },
  { re: /\b(glad|happy|pleased|delighted|excited|yay|hooray|fun)\b/, expression: 'delighted', mood: 'happy' },
  { re: /\b(angry|furious|annoy|outrage|unacceptable|ridiculous|hate)\b/, expression: 'angry', mood: 'angry' },
  { re: /\b(scary|scared|afraid|frightening|terrif|danger|careful|warning|watch out|worried|nervous)\b/, expression: 'shocked', mood: 'fear' },
  { re: /\b(gross|disgust|yuck|eww|revolting|nasty)\b/, expression: 'grimace', mood: 'disgust' },
  { re: /\b(tired|sleepy|exhausted|yawn|bedtime|good night)\b/, expression: 'sleepy', mood: 'sleep' },
  { re: /\b(oops|awkward|embarrass|my bad|whoops)\b/, expression: 'embarrassed' },
  { re: /\b(sigh|ugh|seriously|whatever|obviously)\b/, expression: 'eyeroll' },
  { re: /\b(oh no|terrible|awful|horrible|disaster|failed|broken|crash)/, expression: 'disappointed', mood: 'sad' },
  { re: /\b(wink|secret|between us|just saying)\b/, expression: 'wink' },
  // knowing and not knowing
  { re: /\b(i don't know|not sure|no idea|who knows|hard to say|depends)\b/, gesture: 'shrug', expression: 'thinking' },
  { re: /\b(hmm|let me think|i think|maybe|perhaps|possibly|might|wonder|guess)\b/, expression: 'thinking' },
  // pointing and presenting
  { re: /\b(this one|here|look at|over there|first(ly)?|second(ly)?|note that|the key|important)\b/, gesture: 'index' },
  { re: /\b(on the other hand|alternatively|however|whereas|instead)\b/, gesture: 'side' },
  { re: /\b(ok(ay)?|all set|done|sorted|ready|got it|no problem)\b/, gesture: 'ok', expression: 'smile' },
  { re: /\b(bad idea|thumbs down|not good|no good|don't do)\b/, gesture: 'thumbdown', expression: 'frown' },
  // yes and no
  { re: /^(yes|yeah|yep|sure|absolutely|definitely|exactly|right|correct|of course|indeed|agreed)\b/, head: 'yes' },
  { re: /^(no|nope|not really|never|not at all)\b/, head: 'no' },
];

/** What the words of a sentence show, by the rules: { mood, expression, gesture, head }. */
export function rules(sentence) {
  const s = words(sentence).join(' ');
  const out = {};
  for (const r of RULES) {
    if (!r.re.test(s)) continue;
    for (const k of ['mood', 'expression', 'gesture', 'head']) if (r[k] && !out[k]) out[k] = r[k];
  }
  const t = String(sentence).trim();
  if (!out.expression && /\?\s*$/.test(t)) out.expression = 'thinking';
  if (!out.expression && /!\s*$/.test(t)) out.expression = 'grin';
  return out;
}

// ---------------------------------------------------------------- the model

const list = (o) => Object.entries(o).map(([k, v]) => `- ${k}: ${typeof v === 'string' ? v : v.means}`).join('\n');

/** The question for the model: the system message (the catalog, the same every time, so it's cached). */
export const SYSTEM = [
  'You direct the body language of a 3D avatar that is reading lines aloud.',
  'For each numbered sentence, choose what the avatar shows while saying it:',
  'a mood (its face at rest, kept until changed), an expression (a moment on the face),',
  'a hand gesture and a head movement. Use "none" for anything that does not clearly fit.',
  'Most sentences need no gesture and no head movement; keep the mood unless the feeling changes.',
  'Answer with JSON only.',
  '',
  '## mood',
  list(MOODS),
  '',
  '## expression',
  list(EXPRESSIONS),
  '',
  '## gesture',
  list(GESTURES),
  '',
  '## head',
  list(HEAD),
].join('\n');

/** The JSON schema for an answer about `n` sentences: only the catalog's names are allowed. */
export function schema(n) {
  const choice = (names) => ({ type: 'string', enum: ['none', ...names] });
  return {
    type: 'object',
    properties: {
      sentences: {
        type: 'array',
        minItems: n,
        maxItems: n,
        items: {
          type: 'object',
          properties: {
            mood: choice(Object.keys(MOODS)),
            expression: choice(Object.keys(EXPRESSIONS)),
            gesture: choice(Object.keys(GESTURES)),
            head: choice(Object.keys(HEAD)),
          },
          required: ['mood', 'expression', 'gesture', 'head'],
        },
      },
    },
    required: ['sentences'],
  };
}

/** The question for the model (messages, and the answer's JSON schema). */
export function modelRequest(texts, { context = '', who = '' } = {}) {
  const lines = texts.map((t, i) => `${i + 1}. ${t}`).join('\n');
  const intro = [who && `The avatar is ${who}.`, context && `Just before this: "${context}"`].filter(Boolean).join(' ');
  return {
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `${intro ? intro + '\n' : ''}Sentences:\n${lines}` },
    ],
    format: schema(texts.length),
    temperature: 0,
    think: false,
  };
}

/** The model's answer, read: one direction per sentence, unknown names dropped. */
export function readAnswer(content, n) {
  let o;
  try {
    o = typeof content === 'string' ? JSON.parse(content) : content;
  } catch {
    return null;
  }
  const items = Array.isArray(o?.sentences) ? o.sentences : Array.isArray(o) ? o : null;
  if (!items) return null;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = items[i] || {};
    out.push(clean({ mood: moodName(a.mood), expression: expressionName(a.expression), gesture: gestureName(a.gesture), head: headName(a.head) }));
  }
  return out;
}

function clean(d) {
  return Object.fromEntries(Object.entries(d).filter(([, v]) => v));
}

/**
 * One sentence's direction, from what was asked (the request, the text's cues), what the model
 * said and what the rules say, in that order of precedence. `cues` that are written in the text
 * are played where they were written, so they're kept apart: `timed`.
 */
export function merge({ asked = {}, model = null, rule = {}, cues = [] }) {
  const out = {};
  for (const k of ['mood', 'expression', 'gesture', 'head', 'pose']) {
    const fromCue = cues.find((c) => c[k]);
    if (asked[k]) out[k] = asked[k];
    else if (fromCue) continue; // played at its own time
    else if (model && k in model) out[k] = model[k];
    else if (!model && rule[k]) out[k] = rule[k];
  }
  return { ...out, timed: cues };
}
