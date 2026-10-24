// What the character says while it's still working something out, so a pause doesn't feel like
// it went away. No model: each line is picked from the shape of the request, with FillerLab's
// techniques (https://github.com/ainigh/FillerLab): saying the topic back, naming the shape of the
// task ("two things"), confirming a correction, acknowledging a feeling, a delay signal, a check.
// They're said in the voice of someone who sees things through, listens to the exact words, and
// checks their work before calling it done. A line never claims a result (it says what it's
// doing, never what it found), never comes twice running, and what needs no filler ("thanks",
// "ok", "hi") gets none.

/** Words that can't be said back as a topic: the request turns on them. */
const TRICKY = /["“”‘]|\b(not|no|never|don'?t|doesn'?t|isn'?t|aren'?t|won'?t|can'?t|without|unless|except|if|whether|instead)\b|n't\b/i;

const SOCIAL = /^(what'?s up|how are you( doing)?|how'?s it going|how are things|hi|hey|hello|hiya|yo|thanks|thank you|thank you so much|cheers|ta|ok|okay|k|cool|nice|great|good|perfect|yes|yeah|yep|no|nope|sure|right|fine|bye|goodbye|good (morning|afternoon|evening|night)|morning|night|lol|ha+|wow|oh|hmm+|got it|never ?mind)\b[\s!.,?]*(there|then|again|you|so much|a lot|thanks|thank you|mate|buddy)?[\s!.,?]*$/i;

/** My, me, I → your, you, you: the request said back to the one who asked it. */
const SWAP = { my: 'your', me: 'you', i: 'you', mine: 'yours', myself: 'yourself', our: 'your', ours: 'yours', us: 'you', "i'm": "you're", 'im': "you're", "i've": "you've", am: 'are' };
const swap = (words) => words.map((w) => SWAP[w.toLowerCase()] ?? w).join(' ');
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Asking for something to be done, by its verb: what's said back, and how ("Let me check …"). */
const DOING = [
  [/^(?:check|check on)$/i, 'check'],
  [/^(?:find|find out)$/i, 'find'],
  [/^(?:look up|look into)$/i, 'look into'],
  [/^(?:look for|search for|search)$/i, 'look for'],
  [/^(?:get|fetch|grab)$/i, 'get'],
  [/^(?:show me|pull up)$/i, 'pull up'],
  [/^(?:tell me about|explain)$/i, 'think about'],
  [/^(?:open)$/i, 'open'],
  [/^(?:play|put on)$/i, 'put on'],
  [/^(?:summarize|summarise)$/i, 'go through'],
  [/^(?:write|draft)$/i, 'write'],
];
const DOING_RE = /^(?:(?:hey|ok|okay|so|please|now)[,]?\s+)*(?:(?:can|could|would|will) you\s+(?:please\s+)?|please\s+|i (?:need|want) you to\s+)?(check on|check|find out|find|look up|look into|look for|search for|search|get|fetch|grab|show me|pull up|tell me about|explain|open|play|put on|summarize|summarise|write|draft)\s+(.+)$/i;
const WHAT_RE = /^(?:(?:hey|ok|okay|so)[,]?\s+)*(?:what(?:'s| is| are|'re)|whats|how(?:'s| is| are)) (.+)$/i;

/** The first lines, by the kind of request: each a list to rotate through. */
const OPENING = {
  repair: ['Fair enough. Let me look at that again.', "Okay. Let me find where I went wrong.", "Right, I'll take another look.", "Thanks for catching that. Checking again."],
  feeling: ["I'm with you. Give me a moment.", 'I hear you. One moment.', "Okay. I'm here."],
  care: ["Okay. Let me get you something useful, quickly.", "Right. Let me pull together what to do."],
  rule: ['Got it.', "Understood. I'll keep to that.", 'Okay, noted.'],
  several: ["A few things there. I'll take them one at a time.", "Okay, more than one thing. I'll go in order.", "Right. Let me work through those in turn."],
  keep: ['Noted. Let me keep that.', 'Okay, let me make a note of that.', "Got it. I'll keep that."],
  later: ['Okay, let me set that up.', "Sure. Let me get that in the diary.", 'Right, setting that up.'],
  question: ['Hm. Let me check rather than guess.', 'Let me think that through.', 'Let me make sure before I answer.', 'Okay, let me look properly.', 'Hm, let me see.'],
  task: ['On it.', 'Okay. Leave it with me.', 'Right, let me get that done.', 'Sure. On it.', "Okay. I'll see it through."],
  unclear: ["Hm, I didn't quite catch all of that. Let me try."],
};

/** Said once it has taken a while: the first few in turn, then the last, once. */
const PROGRESS = [
  ['Still on it.', 'Still with it.', 'Still working on it.'],
  ["I'd rather get this right than rush it.", "Bear with me. I'm double-checking.", 'Nearly there. Just checking my work.'],
  ["Taking longer than I'd like, but I haven't lost track of it.", "Still going. I want to be sure I haven't missed anything."],
  ["Still working on it. If you'd rather I stopped, just say so."],
];

/** While a run it asked for is running, and while its card waits for the click. */
const RUNNING = ["It's still running. I'll tell you the moment it's back.", "Still running. I'm keeping an eye on it.", "Still going. I'll let you know how it turns out."];
const WAITING = ["It's waiting for you to click Run on your Mac.", 'Whenever you are ready: it needs your click on Run, on your Mac.'];

/** The kind of request, from its shape, and a topic to say back when one can be said safely. */
export function readRequest(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  const plain = t.replace(/[’‘]/g, "'").replace(/[.!?…]+$/, '').trim();
  const words = plain.split(' ').filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (words.length <= 1 || (words.length <= 6 && SOCIAL.test(plain))) return { kind: 'none' };
  const l = plain.toLowerCase();
  if (/^(no\b|nope\b|wrong\b|that's (not|wrong)|that is (not|wrong)|you('re| are| were| got)\b.*\b(wrong|mistaken|off)\b|not (what|quite)|i (said|meant)\b|actually,? (i|it|no)\b)/.test(l)) return { kind: 'repair' };
  if (/^(?:(?:can|could|would) you (?:please )?not|please don't|don't|do not|stop|no more|never)\b/.test(l) && !/\b(just|instead|but)\b/.test(l)) return { kind: 'rule' };
  if (/\b(fever|bleeding|chest pain|can't breathe|emergency|ambulance|overdose|allergic reaction|poisoned|fainted|unconscious|choking)\b/.test(l)) return { kind: 'care' };
  if (/\bi(?:'m| am| feel| have been| ve been|'ve been)\s+(?:so |really |very |feeling |a bit |quite )*(sad|down|low|stressed|worried|anxious|scared|lonely|upset|tired|exhausted|overwhelmed|hurt|angry|frustrated|lost)\b|\bnobody (cares|loves)\b/.test(l)) return { kind: 'feeling' };
  if (/\b(and then|then also|after that|and also|as well as)\b|, then\b|;/.test(l) || (l.match(/\band\b/g) || []).length >= 2) return { kind: 'several' };
  if (/\b(remind me|wake me|in \d+ (minutes?|mins?|hours?)|tomorrow at|at \d{1,2}(:\d\d)?\s*(am|pm)?\b.*\b(remind|tell|call)|set (an? )?(alarm|timer|reminder))\b/.test(l)) return { kind: 'later' };
  if (/^(remember|note|keep in mind|don't forget|for the record)\b|\b(my \w+(?: \w+)?'s birthday is|my \w+ is called)\b/.test(l)) return { kind: 'keep' };
  const topic = topicOf(plain);
  const asks = /\?\s*$/.test(t) || /^(what|who|where|when|why|how|which|is|are|was|were|do|does|did|can|could|should|would|will)\b/.test(l);
  if (topic) return { kind: asks ? 'question' : 'task', topic };
  if (words.length >= 3 && !/[aeiouy]/i.test(words.join(''))) return { kind: 'unclear' };
  return { kind: asks ? 'question' : 'task' };
}

/** "check the weather in Lagos" → {verb: "check", object: "the weather in Lagos"}; "what's my schedule" → {object: "your schedule"}. */
function topicOf(plain) {
  if (TRICKY.test(plain)) return null;
  const said = (rest) => {
    const words = rest.replace(/[?!.,]+$/, '').split(' ');
    if (words.length < 2 || words.length > 7) return null;
    return swap(words);
  };
  const doing = plain.match(DOING_RE);
  if (doing) {
    const verb = DOING.find(([re]) => re.test(doing[1]))?.[1];
    const object = said(doing[2]);
    return verb && object ? { verb, object } : null;
  }
  const what = plain.match(WHAT_RE);
  if (what && !/^(up|new|happening|going on|it going|you|that|this|it)\b/i.test(what[1])) {
    const object = said(what[1]);
    // "what's the weather in Lagos": a topic needs a determiner or a possessive to be said back.
    if (object && /^(the|your|a|an|this|that|today's|tomorrow's)\b/i.test(object)) return { object };
  }
  return null;
}

/**
 * The fillers for one character: it remembers what it said lately, so a line isn't said again
 * soon. `random` is for tests.
 */
export class Fillers {
  constructor({ random = Math.random } = {}) {
    this.random = random;
    this.recent = [];
  }

  /** From a list, one not said lately (the least lately, when all have been). */
  pick(list) {
    const fresh = list.filter((l) => !this.recent.includes(l));
    const from = fresh.length ? fresh : [...list].sort((a, b) => this.recent.indexOf(a) - this.recent.indexOf(b));
    const line = from[Math.floor(this.random() * (fresh.length ? from.length : 1))];
    this.recent = [line, ...this.recent.filter((l) => l !== line)].slice(0, 12);
    return line;
  }

  /** The first thing said while it works on `text`; null when it needs nothing. */
  opening(text) {
    const r = readRequest(text);
    if (r.kind === 'none') return null;
    if (r.topic) {
      const { verb, object } = r.topic;
      const lines = verb
        ? [`Let me ${verb} ${object}.`, `Okay, ${object}. Let me ${verb === 'think about' ? 'think' : 'see'}.`]
        : [`${capital(object)}. Let me see.`, `Hm, ${object}. Let me check.`];
      return this.pick(lines);
    }
    return this.pick(OPENING[r.kind] || OPENING.task);
  }

  /** The `n`th progress line (0 first) for one request. */
  progress(n) {
    return this.pick(PROGRESS[Math.min(n, PROGRESS.length - 1)]);
  }

  running() {
    return this.pick(RUNNING);
  }

  waiting() {
    return this.pick(WAITING);
  }
}
