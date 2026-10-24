// What the character does while it talks, worked out from the sentences themselves (no model, no
// waiting, the same every time for the same words). Each sentence is read for what kind of thing
// it is (hello, thanks, sorry, good or bad news, a question to the user, an offer, an instruction,
// not knowing, thinking it over, a warning, a joke, a yes, a no, the next point, a "but"…), where
// in it each kind is said, and what came before it in the same utterance. That gives it a mood
// (kept until the feeling changes), an expression, a hand gesture, a head movement, where to look
// and, in a long answer, a pose; what's said later in a sentence ("…, but it failed") is shown at
// that word. It's kept varied (the same gesture twice running is dropped) and quiet when the
// sentence is just facts.

import { STANDING_POSES } from './catalog.mjs';

// ---------------------------------------------------------------- the kinds of sentence

// Said at the start of a sentence, after a little "oh," or "well,".
const START = String.raw`^(?:(?:oh|ah|well|so|um|uh|and|now)[,!]?\s+)?`;
const any = (src) => new RegExp(String.raw`\b(?:${src})\b`, 'g');
const start = (src) => new RegExp(`${START}(?:${src})\\b`, 'g');

/**
 * Each kind: where it's found (`re`), how much it matters (`strength`: 3 always shows, 1 only when
 * the sentence before showed no gesture), and what it shows. A list is choices, picked by the
 * words (so the same words always look the same) and so as not to repeat the sentence before.
 * `valence`: +1 a good thing, -1 a bad one (said with "not" before it, it turns round).
 * Checked in order: once a stretch of words is one kind, no later kind reads it again.
 */
const KINDS = [
  // ---- hello, goodbye, thanks, sorry
  { kind: 'farewell', re: any(String.raw`good ?bye|bye(?: for now)?|see you(?: soon| later| tomorrow)?|take care|talk (?:to you )?(?:soon|later)|farewell|good night|have a (?:good|great|nice|lovely) (?:day|night|evening|weekend|one)|catch you later`), strength: 3, mood: 'happy', expression: ['warm', 'smile'], gesture: 'handup', look: 'camera' },
  { kind: 'greeting', re: start(String.raw`hi|hello|hey|hiya|howdy|greetings|good (?:morning|afternoon|evening|day)|welcome(?: back)?|nice to (?:meet|see) you`), strength: 3, mood: 'happy', expression: ['grin', 'beaming'], gesture: 'handup', look: 'camera' },
  { kind: 'welcome', re: any(String.raw`you'?re (?:very |most )?welcome|no problem(?: at all)?|not a problem|any ?time|my pleasure|happy to help|glad (?:i could|to) help|don'?t mention it`), strength: 2, mood: 'happy', expression: ['warm', 'smile'], head: 'yes', look: 'camera' },
  { kind: 'thanks', re: any(String.raw`thank(?:s| you)|many thanks|cheers|grateful|appreciate(?:d)?`), strength: 3, mood: 'happy', expression: ['warm', 'smile'], gesture: 'namaste', look: 'camera', valence: 1 },
  { kind: 'empathy', re: any(String.raw`(?:i'?m |i am )?(?:so |really |very )?sorry to hear|that (?:sounds|must be|must have been) (?:hard|tough|rough|awful|difficult|stressful|frustrating|painful|scary)|i (?:completely |totally )?(?:understand|hear you|get it)(?=,| how| that|\.|!|$)|poor (?:you|thing)|that'?s (?:hard|tough|rough)`), strength: 3, mood: 'sad', expression: ['pensive', 'pleading'], head: 'yes' },
  { kind: 'apology', re: any(String.raw`sorry|apologi[sz]e|apologies|my (?:bad|mistake|fault)|forgive me|i was wrong`), strength: 3, mood: 'sad', expression: ['pensive', 'embarrassed'], valence: -1 },
  { kind: 'please', re: start(String.raw`please|(?:could|would) you (?:please|kindly)|if you (?:could|would|don'?t mind)`), strength: 2, expression: 'smile', gesture: 'namaste', look: 'camera' },

  // ---- reassurance, before "worry" reads as fear
  { kind: 'reassure', re: any(String.raw`don'?t (?:you )?worry|no worries|nothing to worry about|it'?s (?:all )?(?:fine|okay|ok|alright)|it'?ll be (?:fine|okay|ok|alright)|you'?re (?:fine|okay|ok|all set)|all good|not a big deal|no harm done`), strength: 2, mood: 'happy', expression: ['warm', 'smile'], gesture: 'ok', head: 'yes' },

  // ---- good news, praise, joy
  { kind: 'praise', re: any(String.raw`well done|nice (?:work|job|one|going)|good (?:job|work|call|idea|choice|question)|great (?:job|work|idea|question|choice)|congrat\w*|bravo|nailed it|you did it|impressive|proud of you`), strength: 3, mood: 'happy', expression: ['beaming', 'delighted'], gesture: 'thumbup', valence: 1 },
  { kind: 'success', re: any(String.raw`(?:it'?s |that'?s |all |now )?(?:done|finished|complete|sorted|fixed)(?: now)?|all set|it(?: now)? works|it worked|that worked|(?:it'?s |now )?working(?: now| again)?|(?:it |that )?went (?:well|fine|through)|success(?:ful(?:ly)?)?|i'?ve (?:added|saved|set|sent|scheduled|booked|created|found|fixed|moved|written|updated|made|put|started|finished|turned)|(?:is|are|was|were) (?:now )?(?:saved|sent|added|ready|on (?:your|the) (?:\w+ )?list|booked|scheduled|set up)|here (?:it is|you go|you are)|found (?:it|them|one)`), strength: 2, mood: 'happy', expression: ['smile', 'grin'], gesture: 'ok', valence: 1 },
  { kind: 'awe', re: any(String.raw`wow|whoa|amazing|incredible|awesome|fantastic|unbelievable|stunning|spectacular|mind[- ]blowing|extraordinary`), strength: 3, mood: 'happy', expression: 'starstruck', valence: 1 },
  { kind: 'great', re: any(String.raw`great|excellent|perfect|brilliant|wonderful|superb|terrific|splendid|good news`), strength: 2, mood: 'happy', expression: ['beaming', 'grin'], gesture: 'thumbup', valence: 1 },
  { kind: 'joy', re: any(String.raw`glad|happy|pleased|delighted|excited|thrilled|yay|hooray|woo-?hoo|can'?t wait|looking forward|i love (?:it|that|this)|so much fun|fun`), strength: 2, mood: 'happy', expression: ['delighted', 'grin'], valence: 1 },
  { kind: 'love', re: any(String.raw`love|adore|sweet(?:heart)?|lovely|dear|darling|cute|adorable|miss(?:ed)? you|hugs?|kind of you`), strength: 2, mood: 'love', expression: ['adoring', 'warm'], valence: 1 },
  { kind: 'funny', re: any(String.raw`ha(?: ?ha)+|lol|lmao|funny|hilarious|that'?s a good one`), strength: 3, mood: 'happy', expression: 'laughing', valence: 1 },
  { kind: 'tease', re: any(String.raw`(?:just )?(?:kidding|joking|teasing)|cheeky|gotcha`), strength: 3, mood: 'happy', expression: ['playful', 'wink'] },
  { kind: 'secret', re: any(String.raw`wink|between (?:you and me|us)|our (?:little )?secret|don'?t tell (?:anyone|a soul)|just saying`), strength: 3, expression: ['wink', 'smirk'] },

  // ---- bad news, failure, warnings, feelings that hurt
  { kind: 'disaster', re: any(String.raw`oh no|disaster|terrible|awful|horrible|dreadful|catastroph\w*`), strength: 3, mood: 'sad', expression: ['shocked', 'disappointed'], valence: -1 },
  { kind: 'failure', re: any(String.raw`(?:didn'?t|doesn'?t|won'?t|isn'?t) (?:work|working|run|start|load|go through|answer)|not working|failed|fails?|failure|an? (?:error|problem|issue)|errors?|broken|crash(?:ed|es)?|went wrong|something'?s wrong|couldn'?t|can'?t (?:find|reach|open|connect|get|see|do)|no luck|unfortunately|sadly|bad news|i'?m afraid|denied|refused|missing|lost|timed out|didn'?t click`), strength: 2, mood: 'sad', expression: ['disappointed', 'pensive'], valence: -1 },
  { kind: 'warning', re: any(String.raw`careful|be aware|heads up|watch out|look out|warning|beware|danger(?:ous)?|risk(?:y)?|can'?t be undone|for good|permanently|irreversible|make sure|double[- ]check|don'?t forget`), strength: 2, expression: ['grimace', 'thinking'], gesture: 'index', look: 'camera' },
  { kind: 'fear', re: any(String.raw`scary|scared|afraid of|frighten\w*|terrif\w*|nervous|anxious|worried|worrying|panic\w*|yikes`), strength: 3, mood: 'fear', expression: ['grimace', 'shocked'] },
  { kind: 'anger', re: any(String.raw`angry|furious|annoy\w*|outrage\w*|unacceptable|ridiculous|infuriat\w*|hate|fed up|how dare`), strength: 3, mood: 'angry', expression: ['angry', 'frown'], valence: -1 },
  { kind: 'disgust', re: any(String.raw`gross|disgust\w*|yuck|eww+|revolting|nasty|vile`), strength: 3, mood: 'disgust', expression: 'grimace', valence: -1 },
  { kind: 'oops', re: any(String.raw`oops|whoops|awkward|embarrass\w*|silly me|my mistake`), strength: 3, expression: 'embarrassed' },
  { kind: 'exasperated', re: any(String.raw`sigh|ugh|seriously|whatever|obviously|yeah,? right|as if`), strength: 2, expression: ['eyeroll', 'unamused'] },
  { kind: 'tired', re: any(String.raw`tired|sleepy|exhausted|yawn\w*|bedtime|time for bed|worn out`), strength: 3, mood: 'sleep', expression: 'sleepy' },
  { kind: 'sad', re: any(String.raw`sad|unhappy|upset|heartbroken|miss (?:him|her|them|it)|passed away|died|condolences|grief|lonely`), strength: 3, mood: 'sad', expression: ['pensive', 'pleading'], valence: -1 },

  // ---- knowing and not knowing; working on it
  { kind: 'unsure', re: any(String.raw`i (?:don'?t|do not) know|not (?:quite |really |entirely )?sure|no idea|who knows|hard to (?:say|tell)|it depends|depends on|i can'?t (?:say|tell)|unclear|i'?m not certain`), strength: 3, expression: 'thinking', gesture: 'shrug' },
  { kind: 'wait', re: any(String.raw`one (?:moment|sec(?:ond)?|minute)|just a (?:moment|sec(?:ond)?|minute)|hang on|hold on|bear with me|give me a (?:moment|sec(?:ond)?)`), strength: 3, expression: 'smile', gesture: 'handup' },
  { kind: 'checking', re: any(String.raw`let me (?:check|look|see|find|have a look|take a look|think|try|run|ask|get)|i'?ll (?:check|look|find out|have a look|take a look|try|run|ask)|checking|looking (?:it |that )?(?:up|into)|i'?m (?:on it|looking|checking|working on)`), strength: 2, expression: 'thinking', look: 'away' },
  { kind: 'musing', re: start(String.raw`hmm+|let me think|i (?:think|guess|suppose|reckon|believe|wonder)|maybe|perhaps|possibly|probably|it (?:might|may|could) be|i'?d say`), strength: 1, expression: 'thinking', look: 'away' },
  { kind: 'understand', re: any(String.raw`i see|makes sense|that makes sense|got it|understood|fair enough|i hear you|good point`), strength: 2, expression: 'smile', head: 'yes' },

  // ---- yes and no, first thing in the sentence
  { kind: 'yes', re: start(String.raw`yes|yeah|yep|yup|sure(?: thing)?|absolutely|definitely|exactly|indeed|of course|certainly|correct|right(?!\s+(?:now|here|there|away|after|before|next|on|in|at|after)\b)|that'?s right|agreed|okay|ok|alright|all right|will do|sounds good|you bet`), strength: 2, expression: 'smile', head: 'yes' },
  { kind: 'no', re: start(String.raw`no|nope|nah|not really|not at all|never|i'?m afraid not|unfortunately not|not yet|that'?s not (?:right|true|it)`), strength: 2, head: 'no' },
  { kind: 'wrong', re: any(String.raw`that'?s (?:wrong|incorrect|not right|not true|false)|isn'?t (?:right|true|correct)|bad idea|not a good idea|i wouldn'?t|don'?t do (?:it|that)|thumbs down`), strength: 2, expression: 'frown', gesture: 'thumbdown', head: 'no', valence: -1 },

  // ---- making points: instructions, steps, what matters, the other side
  { kind: 'important', re: any(String.raw`important(?:ly)?|the key (?:thing|point|is)|key point|note that|keep in mind|bear in mind|crucial|essential|the thing is|the point is|remember (?:that|to)|you (?:must|need to|have to|should)`), strength: 2, gesture: 'index', look: 'camera' },
  { kind: 'reminder', re: any(String.raw`it'?s time (?:to|for)|time to|reminder|you asked me to remind|you wanted me to|don'?t forget`), strength: 2, expression: 'grin', gesture: 'index', look: 'camera' },
  { kind: 'instruct', re: start(String.raw`click|press|tap|open|close|go to|type|say|choose|pick|select|try|check|look at|put|move|drag|drop|enter|run|wait|copy|paste|save|send|turn (?:on|off)|switch|scroll|find|use|ask|tell|let me know`), strength: 1, gesture: 'index', look: 'camera' },
  { kind: 'step', re: start(String.raw`first(?:ly)?|second(?:ly)?|third(?:ly)?|next|then|after that|finally|lastly|last(?:ly)?|also|plus|another (?:thing|one)|step (?:one|two|three|\d+)|number (?:one|two|three|\d+)|one|two|three`), strength: 1, gesture: ['index', 'side'] },
  { kind: 'contrast', re: any(String.raw`but|however|on the other hand|alternatively|whereas|instead|although|though|still|then again|that said|even so`), strength: 1, gesture: 'side' },
  { kind: 'offer', re: start(String.raw`would you like|do you want|want me to|shall i|should i|can i|may i|how about|what about|if you (?:like|want)|i can (?:also )?|i could`), strength: 2, expression: ['smile', 'warm'], gesture: 'side', look: 'camera' },
  { kind: 'self', re: start(String.raw`i'?m [a-z]+,? your|my name is|i'?m your|this is [a-z]+ speaking|it'?s me`), strength: 2, expression: 'warm', gesture: 'side', look: 'camera' },
];

/** Words that turn what follows round: "not great", "not bad". */
const NEGATED = /\b(?:not|never|no|hardly|barely|isn'?t|aren'?t|wasn'?t|weren'?t|don'?t|doesn'?t|didn'?t|won'?t|can'?t|couldn'?t|shouldn'?t|wouldn'?t)\s+(?:\w+\s+)?$/;
/** Questions: an offer is told apart above; these are the rest. */
const TAG_QUESTION = /\b(?:right|isn'?t (?:it|that)|aren'?t (?:they|you)|don'?t you (?:think)?|wouldn'?t you say|no|yeah|eh)\?\s*$/;
const WH_QUESTION = new RegExp(`${START}(?:what|which|where|when|who|whom|whose|why|how)\\b`);

// ---------------------------------------------------------------- reading one sentence

const norm = (s) => String(s ?? '').toLowerCase().replace(/[’‘]/g, "'");

/** A number for the words, the same every time: for picking among choices. */
function seedOf(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Every kind said in `sentence`, in order, each with `at`: how far into the sentence (0 to 1). */
export function read(sentence) {
  const s = norm(sentence).trim();
  const len = Math.max(1, s.length);
  const taken = []; // [start, end) stretches already read as a kind
  const hits = [];
  for (const k of KINDS) {
    for (const m of s.matchAll(k.re)) {
      // A match anchored at the start may include the little "oh," before it: the kind starts after.
      const lead = m[0].match(/^\s*(?:(?:oh|ah|well|so|um|uh|and|now)[,!]?\s+)?/)?.[0].length || 0;
      const from = m.index + (k.re.source.startsWith('^') ? lead : 0);
      const to = m.index + m[0].length;
      if (to === from || taken.some(([a, b]) => from < b && to > a)) continue;
      taken.push([from, to]);
      let hit = { ...k, at: from / len, start: from };
      if (k.valence && NEGATED.test(s.slice(Math.max(0, from - 24), from))) {
        // "not great" is a small letdown; "not bad" a small smile.
        hit = k.valence > 0 ? { kind: `not ${k.kind}`, strength: 1, expression: 'disappointed', at: hit.at, start: from } : { kind: `not ${k.kind}`, strength: 1, expression: 'smile', at: hit.at, start: from };
      }
      hits.push(hit);
      break; // one of each kind a sentence
    }
  }
  return hits.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------- a whole utterance

const pick = (v, seed, avoid) => {
  if (!Array.isArray(v)) return v;
  const order = v.map((_, i) => v[(i + (seed % v.length)) % v.length]);
  return order.find((x) => x !== avoid) ?? order[0];
};

/**
 * What to show for each sentence of an utterance: [{ mood?, expression?, gesture?, head?, look?,
 * pose?, timed: [{ at, …the same }], kinds }]. `mood` is the resting mood the character starts
 * from and comes back to.
 */
export function direct(texts, o) {
  return directOn(texts, o).directions;
}

/**
 * The same, carrying on from `from` (the state the last utterance left: an answer said a sentence
 * or two at a time as it's written is read as one): { directions, state }.
 */
export function directOn(texts, { mood: resting = 'neutral', from = null } = {}) {
  const out = [];
  let mood = from?.mood ?? resting;
  let calm = from?.calm ?? 0; // sentences in a row that showed no feeling
  let prev = from?.prev ?? {}; // what the sentence before showed
  let said = from?.said ?? 0; // sentences said so far
  texts.forEach((text) => {
    const t = String(text ?? '').trim();
    const s = norm(t);
    const seed = seedOf(s);
    const hits = read(t);
    const d = { timed: [], kinds: hits.map((h) => h.kind) };

    // What leads: the strongest kind said early (in its first 40%); later ones are shown at their word.
    const early = hits.filter((h) => h.at <= 0.4);
    const lead = early.length ? early.reduce((a, b) => (b.strength > a.strength ? b : a)) : hits[0];
    const set = (target, h, k, avoid) => {
      if (h[k] === undefined) return false;
      target[k] = pick(h[k], seed, avoid);
      return true;
    };
    for (const h of [lead, ...early.filter((x) => x !== lead)].filter(Boolean)) {
      for (const k of ['mood', 'expression', 'gesture', 'head', 'look']) if (d[k] === undefined) set(d, h, k, prev[k]);
    }
    const carried = new Set(); // what a "but" already shows
    for (const h of hits.filter((x) => x.at > 0.4 && x !== lead).slice(0, 2)) {
      if (carried.has(h)) continue;
      // Later in the sentence: a turn of feeling ("…, but it failed"), a "but", or a strong kind, at its word.
      const turns = h.valence && Math.sign(h.valence) !== Math.sign(lead?.valence || 0);
      if (!turns && h.strength < 3 && h.kind !== 'contrast') continue;
      const c = { at: Math.round(Math.min(0.95, h.at) * 100) / 100 };
      for (const k of ['mood', 'expression', 'gesture', 'head']) if (h[k] !== undefined) c[k] = pick(h[k], seed, d[k] ?? prev[k]);
      if (Object.keys(c).length > 1) d.timed.push(c);
      // A "but …" carries the feeling of what follows it.
      if (h.kind === 'contrast') {
        const after = hits.find((x) => x.start > h.start && x.valence);
        if (after) {
          carried.add(after);
          for (const k of ['mood', 'expression']) if (after[k] !== undefined) c[k] = pick(after[k], seed, d[k]);
        }
      }
    }

    // How it ends: a question, an exclamation, trailing off.
    const question = /\?\s*["'”’)]*$/.test(t);
    if (question && !hits.some((h) => h.kind === 'offer')) {
      if (TAG_QUESTION.test(s)) {
        d.expression ??= 'smirk';
        d.head ??= 'yes';
      } else if (WH_QUESTION.test(s)) d.expression ??= 'thinking';
      else d.expression ??= 'smile';
      d.look ??= 'camera';
    }
    if (/!\s*["'”’)]*$/.test(t) && d.expression === undefined) d.expression = ['sad', 'fear', 'angry'].includes(d.mood ?? mood) ? 'shocked' : 'grin';
    if (/(?:\.\.\.|…)\s*$/.test(t) && d.expression === undefined) d.expression = (d.mood ?? mood) === 'sad' ? 'pensive' : 'thinking';

    // The mood: changed only when the feeling does, and back to rest after two calm sentences.
    const felt = d.mood ?? [...d.timed].reverse().find((c) => c.mood)?.mood;
    if (d.mood && d.mood === mood) delete d.mood;
    if (felt) {
      mood = felt;
      calm = 0;
    } else if (mood !== resting && ++calm >= 2) {
      d.mood = mood = resting;
      calm = 0;
    }

    // Kept varied, and not busy: no gesture or face twice running (unless it really matters), and
    // a small gesture only after a sentence without one.
    const strengthOf = (k) => Math.max(0, ...hits.filter((h) => h[k] !== undefined).map((h) => h.strength));
    if (d.gesture && (d.gesture === prev.gesture || (strengthOf('gesture') < 2 && prev.gesture))) delete d.gesture;
    if (d.expression && d.expression === prev.expression && strengthOf('expression') < 3) delete d.expression;
    if (d.head && d.head === prev.head && !hits.some((h) => h.head && h.at <= 0.1)) delete d.head;
    if (d.look && d.look === prev.look) delete d.look;

    // A long answer: a change of stance at its fourth sentence.
    if (++said === 4) d.pose = STANDING_POSES[1 + (seed % (STANDING_POSES.length - 1))];

    prev = d;
    out.push(clean(d));
  });
  return { directions: out, state: { mood, calm, prev, said } };
}

/** One sentence on its own: what it shows (as the first sentence of an utterance). */
export function rules(sentence, o) {
  return direct([sentence], o)[0];
}

function clean(d) {
  const o = Object.fromEntries(Object.entries(d).filter(([k, v]) => v !== undefined && k !== 'kinds' && k !== 'timed'));
  return { ...o, timed: d.timed, kinds: d.kinds };
}

/**
 * One sentence's direction, from what was asked (the request), the cues written in the text (an
 * emoji, a [tag]) and what the words show (`auto`, from direct), in that order of precedence.
 * Cues written in the text are played where they were written, so they're kept apart: `timed`;
 * what the words show at a later word is timed too, unless a written cue already shows that kind.
 */
export function merge({ asked = {}, auto = null, cues = [] }) {
  const out = {};
  for (const k of ['mood', 'expression', 'gesture', 'head', 'pose', 'look']) {
    if (asked[k]) out[k] = asked[k];
    else if (cues.some((c) => c[k])) continue; // played at its own time
    else if (auto && auto[k]) out[k] = auto[k];
  }
  const written = new Set(cues.flatMap((c) => Object.keys(c)));
  const later = (auto?.timed || [])
    .map((c) => Object.fromEntries(Object.entries(c).filter(([k]) => k === 'at' || (!written.has(k) && !asked[k]))))
    .filter((c) => Object.keys(c).length > 1);
  return { ...out, timed: [...cues, ...later].sort((a, b) => a.at - b.at) };
}
