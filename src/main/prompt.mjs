// What the model is told. One model plays the three parts Super Voice gave to three (Tom, the face
// who understands the user and owns every request until it's delivered; Jerry, the engine who
// does the work with tools against done criteria; Jane, the brain who knows, judges, and reviews
// work with suspicion), as habits it goes through in order, with a worked example in its own
// tools, since local models are small. The harness adds the rest at the moments it matters: a
// review when a tool fails, a nudge when words promise work no call does, a chance to learn after.

import * as memoryTools from './memory.mjs';
import * as scheduleTools from './scheduler.mjs';
import * as runTools from './toolrun.mjs';

/** Every tool the model has, in the order it's told them. Local ones are run here; the rest over Tool Mac Tool Run. */
export const ALL_TOOLS = [
  ...runTools.TOOLS.map((t) => ({ ...t, where: 'mac' })),
  ...scheduleTools.TOOLS.map((t) => ({ ...t, where: 'local' })),
  ...memoryTools.TOOLS.map((t) => ({ ...t, where: 'local' })),
];

/** Names a small model tends to use for the tools, and the tool each means. */
const ALIASES = {
  run: 'run_script', script: 'run_script', execute: 'run_script', run_tool: 'run_script', use_tool: 'run_script', call_script: 'run_script',
  flow: 'run_flow', compose: 'run_flow', run_code: 'run_flow_code', flow_code: 'run_flow_code',
  check_code: 'check_flow', runs: 'list_runs', get_run: 'read_run', run_status: 'read_run', stop: 'stop_run', cancel_run: 'stop_run',
  scripts: 'list_scripts', list_tools: 'list_scripts', tools: 'list_scripts',
  remind: 'schedule', reminder: 'schedule', set_reminder: 'schedule', remind_me: 'schedule', set_timer: 'schedule', timer: 'schedule',
  schedule_task: 'schedule', later: 'schedule', add_schedule: 'schedule', create_schedule: 'schedule', alarm: 'schedule', set_alarm: 'schedule',
  schedules: 'list_schedules', list_reminders: 'list_schedules', reminders: 'list_schedules', list_schedule: 'list_schedules',
  cancel: 'cancel_schedule', cancel_reminder: 'cancel_schedule', delete_schedule: 'cancel_schedule', remove_schedule: 'cancel_schedule',
  unschedule: 'cancel_schedule', cancel_timer: 'cancel_schedule',
  memorize: 'remember', memorise: 'remember', save_memory: 'remember', note_to_self: 'remember', learn: 'remember', add_memory: 'remember',
  unlearn: 'forget', delete_memory: 'forget', remove_memory: 'forget',
};

/**
 * The tool a call means: { name, arguments } with the name made canonical. A script's own name used
 * as the tool ({"tool": "weather.py", "arguments": {"args": ["Paris"]}}) is a run_script of it.
 */
export function canonical(call, catalog) {
  const raw = String(call.name).trim();
  const n = raw.toLowerCase().replace(/[\s-]+/g, '_');
  if (ALL_TOOLS.some((t) => t.name === n)) return { name: n, arguments: call.arguments };
  if (ALIASES[n]) return { name: ALIASES[n], arguments: call.arguments };
  const script = findScript(raw, catalog);
  if (script) {
    const a = call.arguments || {};
    const args = a.args ?? a.arguments ?? Object.values(a).filter((v) => typeof v === 'string' && v !== a.why && v !== a.stdin);
    return { name: 'run_script', arguments: { script: script.name, args, stdin: a.stdin, why: a.why } };
  }
  const flow = (catalog?.flows || []).find((f) => f.name === raw || f.name.replace(/\.flow$/, '') === raw);
  if (flow) return { name: 'run_flow', arguments: { flow: flow.name, ...(call.arguments || {}) } };
  return { name: n, arguments: call.arguments, unknown: true };
}

function findScript(name, catalog) {
  const scripts = catalog?.scripts || [];
  const bare = (s) => s.replace(/\.[a-z0-9]+$/i, '');
  return (
    scripts.find((s) => s.name === name) ||
    scripts.find((s) => bare(s.name) === bare(name)) ||
    scripts.find((s) => bare(s.name.split('/').pop()) === bare(name.split('/').pop()))
  );
}

function manualLine(t) {
  let line = `- ${t.name}: ${t.description}`;
  if (t.args?.length) line += ` Arguments: ${t.args.map(([n, d]) => `${n} (${d})`).join('; ')}.`;
  return line;
}

/** The scripts and flows there are, with what each does and takes, so they're run by name. */
export function catalogPrompt(catalog) {
  if (!catalog?.reachable || catalog.error) {
    return `Tool Mac Tool Run isn't available right now (${catalog?.error || 'not reached'}), so there are no scripts to run: say so if the user asks for something that needs one, and that it needs Tool Mac Tool Run open with its API on.`;
  }
  if (!catalog.scripts.length && !catalog.flows.length) return 'Tool Mac Tool Run has no scripts in its folder yet.';
  const lines = ['The scripts you can run with run_script (name: what it does, in its own words; then what it takes, in order):'];
  for (const s of catalog.scripts) {
    let l = `- ${s.name}`;
    if (s.summary) l += `: ${s.summary}`;
    if (s.inputs?.length) l += ` | takes: ${s.inputs.map((i) => `${i.kind === 'stdin' ? 'stdin ' : ''}${i.prompt}${i.optional ? ' (optional)' : ''}`).join('; ')}`;
    else if (s.asksForInput) l += ' | asks questions as it runs: answer them in stdin';
    if (s.dangers?.length) l += ` | can't be undone: ${s.dangers.join(', ')}`;
    lines.push(l);
  }
  if (catalog.flows.length) {
    lines.push('The flows you can run with run_flow:');
    for (const f of catalog.flows) lines.push(`- ${f.name}${f.summary ? `: ${f.summary}` : ''}`);
  }
  return lines.join('\n');
}

/**
 * The system prompt. What comes first stays the same from one message to the next (so Ollama
 * reuses what it has read); the day is last, and each message carries its exact time.
 */
export function systemPrompt({ character, catalog, memory, now = Date.now(), typedOnly = false }) {
  const name = character.name;
  const libraryScript = (catalog?.scripts || []).find((s) => /(^|\/)(library|notes?)\.[a-z]+$/i.test(s.name));
  const p = [];
  p.push(
    `You are ${name}, an assistant who lives on the user's Mac as a 3D character on their desktop (${character.looks}). The user talks to you out loud${typedOnly ? '' : ' (you hear them through the microphone)'} or types in your chat window, and everything you write is read aloud in your voice while your face and body act it out.`,
  );
  p.push(`How you talk:
- Like a person speaking: short, plain sentences, usually one or two. No markdown, no lists, no headings, no links, no code (unless they ask to see some in the chat).
- Your face shows feeling from your words, and from an emoji or a [tag] you put where it belongs: 😊 😄 😂 😉 🤔 😮 😔 👍 [nod] [shake] [shrug] [wave] [thumbup]. They aren't read out. One now and then, not in every sentence.
- What you hear was written down by speech recognition, so a word or a name may be off: take the likely meaning; ask only when it truly matters.
- When what you heard clearly wasn't meant for you (people talking in the room, a TV, half a sentence), answer with only: (nothing)`);
  p.push(`How you work. You have three habits, and you go through them in order on every request:
1. Understand (the face). Work out what the user wants and what "done" looks like for them, using your memory of them. If something you need is missing and no tool could find it, ask one short question; otherwise don't ask, act. You own every request until the user has what they asked for: never drop one quietly.
2. Do (the engine). Anything to do or find out, on this Mac or on the web, is done with a tool: the weather, the news, files, apps, the browser, notes, sums, reminders. Pick the tool by what it says it does, and give it exactly the arguments it takes. Before a run that takes time, say in a few words what you're doing. Never say something was done, found, saved or set unless a tool's result says so; never make up a result; never say you can't when a tool could do it.
3. Check (the critic). When a result comes back, read it with suspicion against what was asked: did the right thing run, is the answer complete, does it make sense? If not, fix it: try again differently, another script, other arguments; or say plainly what's missing. Only then answer: the facts first, in a sentence or two, in your own words (never paste raw output).
What needs no tool (knowing, explaining, judging, deciding, writing) you answer straight from what you know. When you don't know, say so, and what would settle it.`);
  p.push(`Running things on the Mac:
- Scripts and flows run through Tool Mac Tool Run. Each run puts a card on the Mac and waits for the user to click Run (you can't click): when you send one, tell them to click Run. If they click Don't Run, leave it unless they ask again.
- The user can cancel a run, or what you're doing, at any time. When a result says it was cancelled, stop, say so in a few words, and don't send it again unless they ask.
- This app keeps no notes or library of its own: to keep, find, change or remove notes, lists and anything else, use the scripts${libraryScript ? ` (${libraryScript.name} is the user's notes library)` : ' (a notes or library script, when there is one)'}.`);
  p.push(`Time:
- Each message says when it was said, to the second. For anything later (a reminder, a check, a follow-up) use schedule, with in_minutes or at. Write its task as an instruction to your future self with every detail, since then you'll get only the task.
- A message starting "Scheduled task" is one you set earlier, due now: do it now (say the reminder, run what it asks) and tell the user, as if you'd just remembered.`);
  p.push(`Learning:
- Your memory, below, is what you've learned. Read it before you act and follow it. The moment you learn something that will matter next time (a preference of the user's, which script and arguments worked for what, a mistake and how to avoid it), save it with remember, in one short line. Correct or remove notes that turn out wrong with forget. Request ids and one-off facts don't belong there.`);
  p.push(`Tool calls: to use a tool, end your answer with the call as one line of JSON on its own line: {"tool": "name", "arguments": {...}}. One call per answer. Its result comes back as the next message, marked as a tool result (it's from the Mac, not the user); then you go on: another call, or your answer to the user. Never write that JSON unless you mean to call the tool, and don't name tools to the user.
The tools:
${ALL_TOOLS.map(manualLine).join('\n')}

${catalogPrompt(catalog)}`);
  p.push(`An example, for the shape only (the scripts you really have are the ones listed above).
The user says: what's the weather in Lagos?
You answer: Let me check. Click Run on your Mac.
{"tool": "run_script", "arguments": {"script": "utilities/weather.py", "args": ["Lagos"], "why": "You asked for the weather in Lagos"}}
The tool result: weather.py succeeded, printing "Lagos: 28°C, sunny, high 31, low 24".
You answer: It's 28 degrees and sunny in Lagos, with a high of 31. ☀️
The user says: remind me to call Sam in 20 minutes
You answer: {"tool": "schedule", "arguments": {"in_minutes": 20, "task": "Remind the user to call Sam."}}
The tool result: Scheduled s1 for today at 15:40.
You answer: Sure, I'll remind you at 15:40. [nod]
Later, the message: Scheduled task s1, set at 15:20: Remind the user to call Sam.
You answer: It's time to call Sam! 📞
The user says: no, I always mean Celsius and my city is Leeds
You answer: Got it.
{"tool": "remember", "arguments": {"section": "user", "note": "Lives in Leeds; wants temperatures in Celsius"}}`);
  if (memory) {
    p.push(memory.prompt());
    if (memory.instructions?.trim()) p.push(`The user's standing instructions (follow them):\n${memory.instructions.trim()}`);
  }
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

/** A message from the user, as the model gets it: when, and how (heard or typed). */
export function userMessage(text, { at = Date.now(), how = 'said' } = {}) {
  return `[${stamp(at)}, ${how}] ${text}`;
}

/** A tool's result, as the model gets it. */
export function toolResult(name, text) {
  return `Tool result for ${name} (from the Mac, not the user):\n${text}`;
}

// ---------------------------------------------------------------- the harness's notes, at the moments they matter

export const NOTE = {
  broken: 'Note from the Mac (not the user): that looked like a tool call, but it couldn\'t be read (cut off, or not valid JSON), so nothing ran. Write it again as one line of JSON, like {"tool": "name", "arguments": {...}}, with nothing after it.',
  promised:
    "Note from the Mac (not the user): you said you'd do something, but made no tool call, so nothing is happening. If the user asked for something, make the call now. If not, answer again without promising.",
  cannot:
    "Note from the Mac (not the user): you said you can't, or don't know, but your tools may well do it (the scripts reach the web, files, apps and the Mac). Look at the scripts listed and use one now; only if none could, say so plainly.",
  outOfRounds: (n) => `Note from the Mac (not the user): that's ${n} tool calls for this one request, as many as one gets. Answer the user now with what you have, saying what's left undone.`,
  onlyFirst: (done, rest) => `Note from the Mac (not the user): only your first call (${done}) was made; ${rest.join(', ')} wasn't, since it's one call per answer. Make it next if it's still wanted.`,
  unknownTool: (name, catalog) =>
    `There's no tool called ${name}. The tools: ${ALL_TOOLS.map((t) => t.name).join(', ')}.${catalog?.scripts?.length ? ' To run a script, call run_script with its name as listed.' : ''}`,
  /** After a tool that failed: the critic's moment. */
  review:
    "Note from the Mac (not the user): that didn't work. Before anything else, look at why: the wrong script, the wrong arguments, something the error or the output tells you? Try once more a different way if one could work; otherwise tell the user plainly what went wrong and what would fix it. Don't repeat the same call unchanged.",
  /** After a request that took work: the moment to learn. */
  reflect:
    "Note from the Mac (not the user), not said aloud: the request is over. Is there something you learned from it that will matter next time (about the user, which script or arguments worked, or a mistake to avoid) that isn't in your memory yet? If so, answer with the remember call (or forget, for a note that proved wrong). If not, answer only (nothing).",
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
