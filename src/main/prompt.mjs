// What the model is told: that it's a helpful assistant, in a group chat of three (the user, the
// model by its own name, and Peter, Tool Mac Agent, who does things on the Mac and the web); a
// small example of how that goes; and a short explanation. No persona, and nothing about how to
// talk to Peter beyond plain words: Peter does the translating. He keeps no conversation, and it's
// this prompt that says so (his answers don't). The model has no tools: every answer is addressed, "@user …" (said
// aloud) or "@peter …" (to Peter), and Peter answers in the same chat, "@<the model> …", as the
// user does. The harness adds the rest at the moments it matters (a nudge when words promise work
// no message asks for, a look at what went wrong when Peter didn't do it). What the user's
// standing instructions and its playbook say is read from its own space in Storage Spaces
// (./notes.mjs) and comes last, with the day. How the character moves is read from its words
// afterwards (src/shared/director.mjs).

/** The model's name in the chat: "@qwen3" for qwen3:8b. */
export function handleOf(model) {
  const m = String(model || '').trim();
  if (!m) return 'model';
  return m.split(':')[0].split('/').pop().replace(/[^\w.-]/g, '') || 'model';
}

/**
 * The system prompt. What comes first stays the same from one message to the next (so Ollama
 * reuses what it has read); what changes (the notes, the day) comes last, and each message
 * carries its exact time.
 */
export function systemPrompt({ character, model = '', peter = null, notes, now = Date.now(), typedOnly = false }) {
  const me = handleOf(model);
  const p = [];
  p.push(`You are ${character.name}, a helpful assistant the user talks to on their Mac${typedOnly ? '' : ', out loud or typed'}. In this chat you are @${me}.`);
  p.push(`For example:
[the user] @${me} is the walmart on ben white in austin still open?
You: @user Let me check.
@peter Is the Walmart on East Ben White Blvd in Austin, TX open right now, and until when?
[Peter] @${me} Yes: the Walmart Supercenter at 710 E Ben White Blvd is open until 11pm tonight (walmart.com).
You: @user Yes, it's open until 11 tonight.
[the user] @${me} remind me to call Sam in 20 minutes
You: @peter Remind me in 20 minutes to tell the user it's time to call Sam.
[Peter] @${me} Set for today at 15:40 (in 20 minutes): a reminder: tell the user it's time to call Sam. I'll tell you then.
You: @user Sure, I'll remind you at 15:40.`);
  p.push(`Start every answer with @user (said aloud: short spoken sentences, no markdown, lists or emojis) or @peter (a message to Peter), or both, with the one to Peter last. Before Peter answers, tell the user only what you're doing ("Let me check."), never how it turned out. Peter does things on this Mac and the web (searching, reading pages, Chrome, the user's scripts, notes, reminders, memory); you can't. He remembers nothing: each message is all he has, so make it whole, with every detail (never "yes", "the second one" or "as before"), and when he needs something, send the whole request again with it. A message for someone else goes to him in the exact words to send. What waits for the user to click Run on the Mac is asked for, not done: he tells you how it went when it's over. Answer from what you know when that's enough. For anything to do or look up, ask Peter, and tell the user only what he reports, in your own words. Not sure he can? Ask him "how would I ask you to …?". If only the user knows something you need, ask the user. When the user says how to do things from now on, ask Peter to add it, word for word, to Super Face's instructions, saying in brackets what it refers to when the words alone don't (which store, which person); something about themselves, ask him to remember it about the user. What you hear may be misheard: take the likely meaning, and if it wasn't meant for you, answer only: @user nothing${
    peter && !peter.reachable ? `\n\nPeter isn't answering right now (${peter.error || "he isn't open"}): if the user asks for something only he could do, tell them Peter (Tool Mac Agent) needs to be open.` : ''
  }`);
  const learned = notes?.prompt();
  if (learned) p.push(learned);
  p.push(`Today is ${longDay(now)}.`);
  return p.join('\n\n');
}

/** "Friday 24 October 2026". */
export function longDay(ms) {
  const d = new Date(ms);
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

/** "Friday 24 October 2026, 15:20:31 (UTC+01:00)". */
export function stamp(ms) {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const tz = `UTC${off >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(off) / 60)).padStart(2, '0')}:${String(Math.abs(off) % 60).padStart(2, '0')}`;
  const time = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
  return `${longDay(ms)}, ${time} (${tz})`;
}

/** A message from the user, as the model gets it: who, when, how (heard or typed), to whom. */
export function userMessage(text, { at = Date.now(), how = 'said', model = '' } = {}) {
  return `[the user, ${how === 'said' ? 'said aloud' : how}, ${stamp(at)}] @${handleOf(model)} ${text}`;
}

/** Peter's answer (or his news, come in by itself), as the model gets it: as the user's are. */
export function peterMessage(text, { at = Date.now(), model = '' } = {}) {
  return `[Peter, ${stamp(at)}] @${handleOf(model)} ${text}`;
}

// ---------------------------------------------------------------- the harness's notes, at the moments they matter

export const NOTE = {
  json: 'Note from the app (not the user, not Peter): there are no tools to call with JSON, so nothing happened. Ask Peter in words instead: a line that starts with @peter, then what you want.',
  empty: () => 'Note from the app (not the user, not Peter): your message to Peter was empty. Write what you want after @peter.',
  promised:
    "Note from the app (not the user, not Peter): you said you'd do something, but didn't ask Peter, so nothing is happening. If the user asked for something, ask him now: a line that starts with @peter, then what you want. If not, answer again without promising.",
  cannot:
    "Note from the app (not the user, not Peter): you said you can't, or don't know, but Peter may well do it (he reaches the web, files, apps, the schedule and the Mac). Ask him now, in your own words, with @peter; only if he can't, tell the user plainly.",
  outOfRounds: (n) => `Note from the app (not the user, not Peter): that's ${n} messages to Peter for this one request, as many as one gets. Answer the user now (@user) with what you have, saying what's left undone.`,
  onlyFirst: () => 'Note from the app (not the user, not Peter): only your first message to Peter was sent: one per answer. Send the next one now if it\'s still wanted.',
  /** After Peter didn't do it: the critic's moment. */
  review:
    "Note from the app (not the user, not Peter): Peter didn't do that. Look at why first. If he needs something you know, ask him again with the whole request; if only the user knows it, ask the user; otherwise tell the user plainly what went wrong and what would fix it. Don't send the same thing again unchanged.",
};

/** The answer promises work ("let me check", "I'll remind you") without the call that does it. */
export function promisesWork(answer) {
  const a = String(answer).toLowerCase().replace(/’/g, "'");
  return (
    /\b(i'?ll|i will|i'm going to|let me|lemme|i'll go ahead and)\s+(just\s+)?(check|look|find|see|search|run|open|read|get|fetch|pull|grab|remind|schedule|set|save|note|add|write|start|play|send|look up|find out|figure)\b/.test(a) ||
    /^\W*(one (moment|sec|second)|just a (moment|sec|second)|hang on|hold on|checking|looking (it|that) up|on it)\b/.test(a)
  );
}

/** The answer says it can't, has no access, or doesn't know. */
export function claimsInability(answer) {
  const a = String(answer).toLowerCase().replace(/’/g, "'");
  return /\b(i (can't|cannot|can not|am unable to|'m unable to|am not able to|'m not able to|don't have|do not have|have no)( currently| really| actually)? (access|browse|search|check|look|see|open|read|run|tell|find|get|reach|fetch|retrieve|real[- ]time)|as an ai\b|i don't have (the ability|any way|real[- ]time)|real[- ]time (data|information|access))/.test(
    a,
  );
}
