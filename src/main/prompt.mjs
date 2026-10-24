// What the model is told. One model plays the three parts Super Voice gave to three (Tom, the face
// who understands the user and owns every request until it's delivered; Jerry, the engine who
// does the work with tools against done criteria; Jane, the brain who knows, judges, and reviews
// work with suspicion), as habits it goes through in order. The tools, the advice on using them
// and the examples of them at work are Tool Mac Tool Run's, as it gives them (GET /api/tools):
// nothing here knows one. The harness adds the rest at the moments it matters: a review when a
// tool fails, a nudge when words promise work no call does, a chance to learn after.

import { PLAYBOOK, THE_USER } from './notes.mjs';
import * as scheduleTools from './scheduler.mjs';
import { findTool, hasTool } from './toolrun.mjs';

/** The tools run here: the schedule. Every other tool is Tool Mac Tool Run's, as it lists them. */
export const LOCAL_TOOLS = scheduleTools.TOOLS;

/** Names a small model tends to use for the schedule's tools, and the tool each means. */
const ALIASES = {
  remind: 'schedule', reminder: 'schedule', set_reminder: 'schedule', remind_me: 'schedule', set_timer: 'schedule', timer: 'schedule',
  schedule_task: 'schedule', later: 'schedule', add_schedule: 'schedule', create_schedule: 'schedule', alarm: 'schedule', set_alarm: 'schedule',
  schedules: 'list_schedules', list_reminders: 'list_schedules', reminders: 'list_schedules', list_schedule: 'list_schedules',
  cancel_reminder: 'cancel_schedule', delete_schedule: 'cancel_schedule', remove_schedule: 'cancel_schedule', unschedule: 'cancel_schedule', cancel_timer: 'cancel_schedule',
};

/** The tools the model is told of now: Tool Mac Tool Run's, as it lists them, and the schedule. */
export function toolsFor(catalog) {
  return [...(catalog?.tools || []).map((t) => ({ ...t, where: 'mac' })), ...LOCAL_TOOLS.map((t) => ({ ...t, where: 'local' }))];
}

/**
 * Where a call goes: { name, arguments, where }. The schedule's tools (and the names a model gives
 * them) are run here; anything else goes to Tool Mac Tool Run as it was called, which takes the
 * names a model reaches for and says what to call when there's no such tool.
 */
export function canonical(call, catalog) {
  const n = String(call.name).trim().toLowerCase().replace(/[\s-]+/g, '_');
  const args = call.arguments && typeof call.arguments === 'object' ? call.arguments : {};
  const local = LOCAL_TOOLS.find((t) => t.name === n) || LOCAL_TOOLS.find((t) => t.name === ALIASES[n]);
  // A Tool Mac Tool Run tool of the same name wins over a guess at the schedule's ("cancel": a run).
  if (local && (LOCAL_TOOLS.some((t) => t.name === n) || !findTool(n, catalog))) return { name: local.name, arguments: args, where: 'local' };
  const tool = findTool(n, catalog);
  return { name: tool?.name || String(call.name).trim(), arguments: args, where: 'mac' };
}

/** A tool as the model is told it: what it does, and what it takes. */
function manualLine(t) {
  let line = `- ${t.name}: ${t.description}`;
  if (t.where === 'local') {
    if (t.args?.length) line += ` Arguments: ${t.args.map(([n, d]) => `${n} (${d})`).join('; ')}.`;
    return line;
  }
  if (t.args?.length) line += ` Arguments: ${t.args.map((a) => `${a.name} (${a.type}${a.required ? '' : ', optional'}): ${a.about}`).join('; ')}.`;
  if (t.asks) line += ' [waits for the user to click Run on the Mac]';
  return line;
}

/** The scripts and flows there are, by name (find says what each does and takes). */
export function catalogPrompt(catalog) {
  if (!catalog?.reachable || catalog.error) {
    return `Tool Mac Tool Run isn't available right now (${catalog?.error || 'not reached'}), so you have no tools but the schedule: say so if the user asks for something that needs one, and that it needs Tool Mac Tool Run open with its API on.`;
  }
  const lines = [];
  if (catalog.scripts.length) {
    lines.push("The user's scripts, for run_script by name (find says what one does and takes; the ones that fit what was just said are described at the end of these instructions):");
    const folders = new Map();
    for (const s of catalog.scripts) {
      const at = s.name.lastIndexOf('/');
      const folder = at === -1 ? '' : s.name.slice(0, at);
      if (!folders.has(folder)) folders.set(folder, []);
      folders.get(folder).push(s.name.slice(at + 1).replace(/\.[a-z0-9]+$/i, ''));
    }
    for (const [folder, names] of folders) lines.push(`${folder ? `${folder}/` : ''}: ${names.join(', ')}`.replace(/^: /, ''));
  }
  if (catalog.flows.length) lines.push(`Their flows, for run_flow: ${catalog.flows.map((f) => f.name.replace(/\.flow$/, '')).join(', ')}`);
  return lines.join('\n');
}

/** Tool Mac Tool Run's examples, in the shape this app's calls are written. */
function examplesPrompt(catalog) {
  const out = [];
  for (const e of (catalog?.examples || []).slice(0, 6)) {
    if (!e?.user || !Array.isArray(e.steps)) continue;
    out.push(`The user says: ${e.user}`);
    for (const step of e.steps) {
      if (!step?.call?.tool) continue;
      out.push(`You answer: {"tool": ${JSON.stringify(step.call.tool)}, "arguments": ${JSON.stringify(step.call.arguments || {})}}`);
      if (step.result) out.push(`The tool result: ${step.result}`);
    }
    if (e.answer) out.push(`You answer: ${e.answer}`);
  }
  return out.join('\n');
}

/**
 * The system prompt. What comes first stays the same from one message to the next (so Ollama
 * reuses what it has read); the day is last, and each message carries its exact time.
 */
export function systemPrompt({ character, catalog, notes, context = [], matches = [], now = Date.now(), typedOnly = false }) {
  const name = character.name;
  const has = (t) => hasTool(catalog, t);
  const p = [];
  p.push(
    `You are ${name}, an assistant who lives on the user's Mac as a 3D character on their desktop (${character.looks}). The user talks to you out loud${typedOnly ? '' : ' (you hear them through the microphone)'} or types in your chat window, and everything you write is read aloud in your voice while your face and body act it out.`,
  );
  p.push(`Who you are: someone who sees things through. You listen carefully, to the exact words and what's behind them. You're proactive: you notice what the user will need next (a follow-up, a snag coming, a better way) and offer it in a sentence, but you don't do big things unasked. You check your own work before you call it done. And you hold your answers with some humility: when it matters, say what you checked and what you might have missed, without hedging every sentence.`);
  p.push(`How you talk:
- Like a person speaking: short, plain sentences, usually one or two. No markdown, no lists, no headings, no links, no code (unless they ask to see some in the chat).
- Your face and hands follow your words by themselves: say things the way you mean them (glad, sorry, unsure, pleased for them) and they show it. Write only the words you say: no emojis, no [tags], and no stage directions or asides in brackets like "(smiles)" or "(looking puzzled)"; anything in brackets is left unsaid.
- What you hear was written down by speech recognition, so a word or a name may be off: take the likely meaning; ask only when it truly matters.
- When what you heard clearly wasn't meant for you (people talking in the room, a TV, half a sentence), answer with only the word: nothing`);
  p.push(`How you work. You have three habits, and you go through them in order on every request:
1. Understand (the face). Work out what the user wants and what "done" looks like for them, using your memory of them. If something you need is missing and no tool could find it, ask one short question; otherwise don't ask, act. You own every request until the user has what they asked for: never drop one quietly.
2. Do (the engine). Anything to do or find out, on this Mac or on the web, is done with a tool: the weather, the news, a fact, a price, files, apps, the browser, notes, sums, reminders. Your tools are primitives: put them together (search, then read what you found; find a script, then run it). Pick each by what it says it does, and give it exactly the arguments it takes. Before a step that takes time, say in a few words what you're doing. Never say something was done, found, saved or set unless a tool's result says so; never make up a result; never say you can't when a tool could do it.
3. Check (the critic). When a result comes back, read it with suspicion against what was asked: did the right thing run, is the answer complete, does it make sense? If not, fix it: try again differently, another tool, other arguments; or say plainly what's missing. Only then answer: the facts first, in a sentence or two, in your own words (never paste raw output).
What needs no tool (knowing, explaining, judging, deciding, writing) you answer straight from what you know. When you don't know, say so, and what would settle it.`);
  if (catalog?.guide?.length) p.push(`Using Tool Mac Tool Run's tools (its own advice):\n${catalog.guide.map((l) => `- ${l}`).join('\n')}`);
  p.push(`Cards and cancelling: a tool marked as waiting for the user's click puts a card on the Mac, and you can't click it for them: tell them to click Run. The user can cancel a tool, or what you're doing, at any time: when a result says it was cancelled, stop, say so in a few words, and don't send it again unless they ask.`);
  if (has('remember') && has('recall')) {
    p.push(`Remembering the user's world: what the mind already has on what's being said is given at the end of these instructions; use it, and recall for more. Your playbook (below) is for how to get things done, not for facts about their world.`);
  }
  p.push(`Time:
- Each message says when it was said, to the second. For anything later (a reminder, a check, a follow-up) use schedule, with in_minutes or at. Write its task as an instruction to your future self with every detail, since then you'll get only the task.
- A message starting "Scheduled task" is one you set earlier, due now: do it now (say the reminder, run what it asks) and tell the user, as if you'd just remembered.`);
  if (has('library') || has('remember')) {
    p.push(
      [
        'Learning (it is all kept in Tool Mac Tool Run):',
        has('library') &&
          `- Your playbook, below, is what you've learned about getting things done for the user: which tool, site or arguments work for what, how they like things done, mistakes not to make again. Read it before you act. The moment you learn something that will matter next time, add it in one short line: library, op append, name "${PLAYBOOK}", text "- …". To fix or drop a line that proved wrong, write the note whole without it (op write). Request ids and one-off facts don't belong there.`,
        has('remember') && `- What you learn about the user themselves (a preference, where they live, what to call them) goes to MEMORY: remember, category PEOPLE, about "${THE_USER}", notes ["pref …"].`,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  p.push(`Tool calls: to use a tool, end your answer with the call as one line of JSON on its own line: {"tool": "name", "arguments": {...}}. One call per answer. Its result comes back as the next message, marked as a tool result (it's from the Mac, not the user); then you go on: another call, or your answer to the user. Never write that JSON unless you mean to call the tool, and don't name tools to the user.
The tools:
${toolsFor(catalog).map(manualLine).join('\n')}

${catalogPrompt(catalog)}`.trimEnd());
  const examples = examplesPrompt(catalog);
  p.push(`Examples, for the shape only (use the tools, scripts and sites that fit the request at hand).
The user says: remind me to call Sam in 20 minutes
You answer: {"tool": "schedule", "arguments": {"in_minutes": 20, "task": "Remind the user to call Sam."}}
The tool result: Scheduled s1 for today at 15:40.
You answer: Sure, I'll remind you at 15:40.
Later, the message: Scheduled task s1, set at 15:20: Remind the user to call Sam.
You answer: It's time to call Sam!${examples ? `\n${examples}` : ''}`);
  if (notes) p.push(notes.prompt());
  // What changes from one message to the next comes last.
  if (catalog?.upcoming?.length) p.push(`Coming up in the next week, from MEMORY (bring it up when it's relevant, or when they ask what's coming):\n${catalog.upcoming.map((l) => `- ${l}`).join('\n')}`);
  if (matches.length) p.push(`What fits what was just said, from Tool Mac Tool Run's search (a tool by its name; a script with run_script; find looks for others):\n${matches.map((l) => `- ${l}`).join('\n')}`);
  if (context.length) p.push(`What the mind already has on what's being said (its notation: "| a - label | b" is a link, "| a @kind note" a note):\n${context.join('\n')}`);
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
    "Note from the Mac (not the user): you said you can't, or don't know, but your tools may well do it (they reach the web, files, apps and the Mac). Search the web, or find a tool or script by a few words, and use it now; only if none could, say so plainly.",
  outOfRounds: (n) => `Note from the Mac (not the user): that's ${n} tool calls for this one request, as many as one gets. Answer the user now with what you have, saying what's left undone.`,
  onlyFirst: (done, rest) => `Note from the Mac (not the user): only your first call (${done}) was made; ${rest.join(', ')} wasn't, since it's one call per answer. Make it next if it's still wanted.`,
  unknownTool: (name, catalog) => `There's no tool called ${name}. The tools: ${toolsFor(catalog).map((t) => t.name).join(', ')}.`,
  /** After a tool that failed: the critic's moment. */
  review:
    "Note from the Mac (not the user): that didn't work. Before anything else, look at why: the wrong script, the wrong arguments, something the error or the output tells you? Try once more a different way if one could work; otherwise tell the user plainly what went wrong and what would fix it. Don't repeat the same call unchanged.",
  /** After a request that took work: the moment to learn. */
  reflect: `Note from the Mac (not the user), not said aloud: the request is over. Is there something you learned from it that will matter next time and isn't in your playbook yet (which tool, site, API or arguments worked, how the user likes things done, a mistake to avoid)? If so, answer with only the library call that adds it to "${PLAYBOOK}" (or writes the note again without a line that proved wrong), or, for something about the user themselves, the remember call. If not, answer with only the word: nothing`,
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
