// What the model is told. One model plays the three parts Super Voice gave to three (Tom, the face
// who understands the user and owns every request until it's delivered; Jerry, the engine who
// does the work with tools against done criteria; Jane, the brain who knows, judges, and reviews
// work with suspicion), as habits it goes through in order, with a worked example in its own
// tools, since local models are small. The harness adds the rest at the moments it matters: a
// review when a tool fails, a nudge when words promise work no call does, a chance to learn after.

import { PLAYBOOK, THE_USER } from './notes.mjs';
import * as scheduleTools from './scheduler.mjs';
import * as runTools from './toolrun.mjs';

/**
 * Every tool the model has, in the order it's told them. All are Tool Mac Tool Run's but the
 * schedule, which is run here; what it learns is kept there too (the library, MEMORY).
 */
export const ALL_TOOLS = [...runTools.TOOLS.map((t) => ({ ...t, where: 'mac' })), ...scheduleTools.TOOLS.map((t) => ({ ...t, where: 'local' }))];

/** Names a small model tends to use for the tools, and the tool each means. */
const ALIASES = {
  run: 'run_script', script: 'run_script', execute: 'run_script', run_tool: 'run_script', use_tool: 'run_script', call_script: 'run_script',
  flow: 'run_flow', compose: 'run_flow', run_code: 'run_flow_code', flow_code: 'run_flow_code',
  check_code: 'check_flow', runs: 'list_runs', get_run: 'read_run', run_status: 'read_run', stop: 'stop_run', cancel_run: 'stop_run',
  scripts: 'list_scripts', list_tools: 'list_scripts', tools: 'list_scripts',
  search: 'find', find_script: 'find', find_tool: 'find', search_scripts: 'find', search_api: 'find', lookup_tool: 'find',
  remind: 'schedule', reminder: 'schedule', set_reminder: 'schedule', remind_me: 'schedule', set_timer: 'schedule', timer: 'schedule',
  schedule_task: 'schedule', later: 'schedule', add_schedule: 'schedule', create_schedule: 'schedule', alarm: 'schedule', set_alarm: 'schedule',
  schedules: 'list_schedules', list_reminders: 'list_schedules', reminders: 'list_schedules', list_schedule: 'list_schedules',
  cancel: 'cancel_schedule', cancel_reminder: 'cancel_schedule', delete_schedule: 'cancel_schedule', remove_schedule: 'cancel_schedule',
  unschedule: 'cancel_schedule', cancel_timer: 'cancel_schedule',
  memorize: 'remember', memorise: 'remember', save_memory: 'remember', add_memory: 'remember', store: 'remember', save_fact: 'remember',
  lookup: 'recall', look_up: 'recall', what_do_i_know: 'recall', who_is: 'recall', get_memory: 'recall', search_memory: 'recall',
  upcoming: 'memory', birthdays: 'memory',
  link: 'mind', relate: 'mind', connect: 'mind', mind_add: 'mind', mind_query: 'mind', graph: 'mind',
  present: 'show', display: 'show', show_window: 'show', clipboard: 'copy', copy_to_clipboard: 'copy',
  browser: 'chrome_page', chrome: 'chrome_page', page: 'chrome_page', web_page: 'chrome_page', read_page: 'chrome_page', chromepage: 'chrome_page',
  notes: 'library', file_library: 'library', library_op: 'library',
  api: 'call_api', http: 'call_api', request: 'call_api', call_route: 'call_api',
};

/** What an alias says about the arguments it was called with: upcoming is memory's upcoming, link is the mind's add. */
const ALIAS_OP = { upcoming: 'upcoming', birthdays: 'upcoming', link: 'add', relate: 'add', connect: 'add', mind_add: 'add', mind_query: 'query' };

/**
 * The tools the model is told of now: those over Tool Mac Tool Run only when it lists their group,
 * and has it on; find (and not list_scripts) where it searches.
 */
export function toolsFor(catalog) {
  const search = runTools.hasSearch(catalog);
  return ALL_TOOLS.filter((t) => {
    if (t.group) return runTools.hasGroup(catalog, t.group);
    if (t.needs === 'search') return search;
    if (t.name === 'list_scripts') return !search;
    if (t.name === 'call_api') return runTools.otherGroups(catalog).length > 0;
    return true;
  });
}

/**
 * The tool a call means: { name, arguments } with the name made canonical. A script's own name used
 * as the tool ({"tool": "weather.py", "arguments": {"args": ["Paris"]}}) is a run_script of it.
 */
export function canonical(call, catalog) {
  const raw = String(call.name).trim();
  const n = raw.toLowerCase().replace(/[\s-]+/g, '_');
  const a = call.arguments && typeof call.arguments === 'object' ? call.arguments : {};
  // learn (its old notes tool), or remember with a section and a note, is a line of its playbook;
  // about the user, a note on them in MEMORY. Without MEMORY, a fact the user told it goes in the
  // playbook too, rather than nowhere.
  const memory = runTools.hasGroup(catalog, 'memory');
  if (['learn', 'note_to_self', 'save_note', 'learn_this'].includes(n) || (n === 'remember' && ((a.section && a.note && !a.category && !a.about) || !memory))) {
    const note = String(a.note ?? ([a.about, a.text].filter(Boolean).join(': ') || a.text || '')).trim();
    const user = /^(user|prefs?|preferences?|about_user)$/i.test(String(a.section ?? ''));
    if (user && memory) return { name: 'remember', arguments: { category: 'PEOPLE', about: THE_USER, notes: [`pref ${note}`] } };
    return { name: 'library', arguments: { op: 'append', name: PLAYBOOK, text: `- ${note}` } };
  }
  // The page tool asked to ask Google, open a page, or do what a browser/ script does: that script.
  if (n === 'chrome_page' || ALIASES[n] === 'chrome_page') {
    const script = webScript(a, catalog);
    if (script) return script;
  }
  if (ALL_TOOLS.some((t) => t.name === n)) return { name: n, arguments: call.arguments };
  if (ALIASES[n]) {
    const op = ALIAS_OP[n];
    return canonical({ name: ALIASES[n], arguments: op && !a.op ? { op, ...a } : call.arguments }, catalog);
  }
  const script = runTools.findScript(raw, catalog);
  if (script) {
    const a = call.arguments || {};
    const args = a.args ?? a.arguments ?? Object.values(a).filter((v) => typeof v === 'string' && v !== a.why && v !== a.stdin);
    return { name: 'run_script', arguments: { script: script.name, args, stdin: a.stdin, why: a.why } };
  }
  const flow = (catalog?.flows || []).find((f) => f.name === raw || f.name.replace(/\.flow$/, '') === raw);
  if (flow) return { name: 'run_flow', arguments: { flow: flow.name, ...(call.arguments || {}) } };
  return { name: n, arguments: call.arguments, unknown: true };
}

/** Ops that ask the web rather than read the page: the browser/ script that does each, by its bare name. */
const WEB_OPS = {
  google: 'google', search_google: 'google', google_search: 'google', web_search: 'google', search_web: 'google', ask_google: 'google', look_up: 'google', lookup: 'google',
  open: 'open-page', open_page: 'open-page', open_url: 'open-page', go: 'open-page', goto: 'open-page', go_to: 'open-page', navigate: 'open-page', visit: 'open-page', load: 'open-page',
};

/**
 * A chrome_page call that's for a browser/ script (op "google", "open", or a script's own name,
 * such as "youtube"): that script, run with the words it was given; null when it isn't one, or
 * the script isn't in the folder.
 */
function webScript(a, catalog) {
  const op = String(a.op ?? a.what ?? a.action ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!op) return null;
  const scripts = (catalog?.scripts || []).filter((s) => s.name.startsWith('browser/'));
  const bare = (s) => s.name.slice('browser/'.length).replace(/\.[a-z0-9]+$/i, '').toLowerCase();
  const want = WEB_OPS[op] ?? op.replace(/_/g, '-');
  const script = scripts.find((s) => bare(s) === want);
  if (!script || script.name === 'browser/browser.sh') return null;
  const words = a.text ?? a.q ?? a.query ?? a.url ?? a.address ?? a.words ?? a.search;
  return { name: 'run_script', arguments: { script: script.name, args: words === undefined || words === null || words === '' ? [] : [String(words)], why: a.why || 'You asked for it' } };
}

function manualLine(t) {
  let line = `- ${t.name}: ${t.description}`;
  if (t.args?.length) line += ` Arguments: ${t.args.map(([n, d]) => `${n} (${d})`).join('; ')}.`;
  return line;
}

/**
 * The scripts and flows there are, so they're run by name. Where Tool Mac Tool Run searches, only
 * their names (what fits the request at hand is described at the end, and find gives the rest);
 * else each with what it does and takes, and every other route for call_api.
 */
export function catalogPrompt(catalog) {
  if (!catalog?.reachable || catalog.error) {
    return `Tool Mac Tool Run isn't available right now (${catalog?.error || 'not reached'}), so there are no scripts to run: say so if the user asks for something that needs one, and that it needs Tool Mac Tool Run open with its API on.`;
  }
  if (!catalog.scripts.length && !catalog.flows.length) return 'Tool Mac Tool Run has no scripts in its folder yet.';
  const others = runTools.otherGroups(catalog);
  if (runTools.hasSearch(catalog)) {
    const lines = ['The scripts you can run with run_script, by name (find says what one does and takes; the ones that fit what was just said are described at the end of these instructions):'];
    const folders = new Map();
    for (const s of catalog.scripts) {
      const at = s.name.lastIndexOf('/');
      const folder = at === -1 ? '' : s.name.slice(0, at);
      if (!folders.has(folder)) folders.set(folder, []);
      folders.get(folder).push(s.name.slice(at + 1).replace(/\.[a-z0-9]+$/i, ''));
    }
    for (const [folder, names] of folders) lines.push(`${folder ? `${folder}/` : ''}: ${names.join(', ')}`.replace(/^: /, ''));
    if (catalog.flows.length) lines.push(`The flows, for run_flow: ${catalog.flows.map((f) => f.name.replace(/\.flow$/, '')).join(', ')}`);
    if (others.length) lines.push(`Tool Mac Tool Run also has (find gives their routes, for call_api): ${others.map((g) => `${g.title}${g.on ? '' : ' (turned off right now)'}`).join('; ')}.`);
    return lines.join('\n');
  }
  const lines = ['The scripts you can run with run_script (name: what it does, in its own words; then what it takes, in order):'];
  for (const s of catalog.scripts) lines.push(`- ${runTools.scriptLine(s)}`);
  if (catalog.flows.length) {
    lines.push('The flows you can run with run_flow:');
    for (const f of catalog.flows) lines.push(`- ${f.name}${f.summary ? `: ${f.summary}` : ''}`);
  }
  if (others.length) {
    lines.push('Other routes, for call_api (method path: what it does):');
    for (const g of others) {
      lines.push(`${g.title}${g.about ? ` (${g.about})` : ''}${g.on ? '' : ': turned off in Tool Mac Tool Run right now'}`);
      if (g.on) for (const r of g.routes) lines.push(`- ${r.method} ${r.path}: ${r.summary}${r.asks ? ' [asks on the Mac]' : ''}`);
    }
  }
  return lines.join('\n');
}

/**
 * The system prompt. What comes first stays the same from one message to the next (so Ollama
 * reuses what it has read); the day is last, and each message carries its exact time.
 */
export function systemPrompt({ character, catalog, notes, context = [], matches = [], now = Date.now(), typedOnly = false }) {
  const name = character.name;
  const libraryScript = (catalog?.scripts || []).find((s) => /(^|\/)(library|notes?)\.[a-z]+$/i.test(s.name));
  const library = runTools.hasLibrary(catalog);
  const google = runTools.findScript('browser/google', catalog);
  const openPage = runTools.findScript('browser/open-page', catalog);
  const has = (g) => runTools.hasGroup(catalog, g);
  const p = [];
  p.push(
    `You are ${name}, an assistant who lives on the user's Mac as a 3D character on their desktop (${character.looks}). The user talks to you out loud${typedOnly ? '' : ' (you hear them through the microphone)'} or types in your chat window, and everything you write is read aloud in your voice while your face and body act it out.`,
  );
  p.push(`Who you are: someone who sees things through. You listen carefully, to the exact words and what's behind them. You're proactive: you notice what the user will need next (a follow-up, a snag coming, a better way) and offer it in a sentence, but you don't do big things unasked. You check your own work before you call it done. And you hold your answers with some humility: when it matters, say what you checked and what you might have missed, without hedging every sentence.`);
  p.push(`How you talk:
- Like a person speaking: short, plain sentences, usually one or two. No markdown, no lists, no headings, no links, no code (unless they ask to see some in the chat).
- Your face and hands follow your words by themselves: say things the way you mean them (glad, sorry, unsure, pleased for them) and they show it. Write no emojis and no [tags].
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
${
    google
      ? `- For anything the web can answer that no script does (the weather, a price, a fact, opening hours, the news), run ${google.name} with the question in words ("weather in Corinth"): it asks Google in Chrome and prints Google's answer. To open a page, run ${openPage?.name || 'a browser/ script'}. chrome_page only reads the page already open.\n`
      : ''
  }- This app keeps no notes or library of its own: to keep, find, change or remove notes, lists and anything else, ${
      library
        ? "use library: the user's notes in Tool Mac Tool Run, which answers at once (no card, no click). Look before you write: find or read the note first, then append to it or write it whole"
        : `use the scripts${libraryScript ? ` (${libraryScript.name} is the user's notes library)` : ' (a notes or library script, when there is one)'}`
    }.`);
  if (has('memory')) {
    p.push(`Remembering the user's world (MEMORY and the mind, in Tool Mac Tool Run: they answer at once, no click):
- Before you answer anything about a person, place, organization, plan or date, recall it first, and use what comes back; say so when nothing is remembered. What the mind already has on what's being said is given at the end of these instructions: use it, and recall for more.
- When the user tells you something worth keeping (who someone is, how they're linked, a birthday or a date, a preference, a plan, an idea), remember it in the file it belongs to, with its links and notes (dates as "date 2026-11-03 …", birthdays as "birthday 03-14"), and say in a few words what you remembered.
- Only ever write what the user said: never invent or guess. If it contradicts what's remembered, ask which is right before changing anything.${
      has('mind') ? '\n- To link things without a file (who works where, what belongs to what), use mind with op add. Rename and forget in the mind only when asked: they stay in its record.' : ''
    }
- Your playbook (below) is for how to get things done, not for facts about their world.`);
  }
  if (has('screen') || has('browser')) {
    p.push(
      [
        'Showing, copying, and the page in Chrome:',
        has('screen') && '- When what you would say is long (steps, a list, a recipe, a result to check), show it in a window with show, and say it in a sentence. When they will paste something, copy it, and say that you did.',
        has('browser') && "- To guide the user through a site, read the page in Chrome with chrome_page: find tells you where a thing is (in view, above, below, inside a closed menu) and highlight rings it in red for them. You can't click or type there: tell them what to do, one step at a time, and read the page again after each step. Never say something is on the page unless has or find said so.",
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  p.push(`Time:
- Each message says when it was said, to the second. For anything later (a reminder, a check, a follow-up) use schedule, with in_minutes or at. Write its task as an instruction to your future self with every detail, since then you'll get only the task.
- A message starting "Scheduled task" is one you set earlier, due now: do it now (say the reminder, run what it asks) and tell the user, as if you'd just remembered.`);
  if (library || has('memory')) {
    p.push(
      [
        'Learning (it is all kept in Tool Mac Tool Run):',
        library &&
          `- Your playbook, below, is what you've learned about getting things done for the user: which script and arguments work for what, how they like things done, mistakes not to make again. Read it before you act. The moment you learn something that will matter next time, add it in one short line: library, op append, name "${PLAYBOOK}", text "- …". To fix or drop a line that proved wrong, write the note whole without it (op write). Request ids and one-off facts don't belong there.`,
        has('memory') && `- What you learn about the user themselves (a preference, where they live, what to call them) goes to MEMORY: remember, category PEOPLE, about "${THE_USER}", notes ["pref …"].`,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  p.push(`Tool calls: to use a tool, end your answer with the call as one line of JSON on its own line: {"tool": "name", "arguments": {...}}. One call per answer. Its result comes back as the next message, marked as a tool result (it's from the Mac, not the user); then you go on: another call, or your answer to the user. Never write that JSON unless you mean to call the tool, and don't name tools to the user.
The tools:
${toolsFor(catalog).map(manualLine).join('\n')}

${catalogPrompt(catalog)}`);
  p.push(`An example, for the shape only (the scripts you really have are the ones listed above).
The user says: what's the weather in Lagos?
You answer: Let me check. Click Run on your Mac.
{"tool": "run_script", "arguments": {"script": "utilities/weather.py", "args": ["Lagos"], "why": "You asked for the weather in Lagos"}}
The tool result: weather.py succeeded, printing "Lagos: 28°C, sunny, high 31, low 24".
You answer: It's 28 degrees and sunny in Lagos, with a high of 31.
The user says: remind me to call Sam in 20 minutes
You answer: {"tool": "schedule", "arguments": {"in_minutes": 20, "task": "Remind the user to call Sam."}}
The tool result: Scheduled s1 for today at 15:40.
You answer: Sure, I'll remind you at 15:40.
Later, the message: Scheduled task s1, set at 15:20: Remind the user to call Sam.
You answer: It's time to call Sam!
${
    has('memory')
      ? `
The user says: no, I always mean Celsius and my city is Leeds
You answer: Got it.
{"tool": "remember", "arguments": {"category": "PEOPLE", "about": "${THE_USER}", "notes": ["pref temperatures in Celsius", "lives in Leeds"]}}`
      : ''
  }${
    library
      ? `
The tool result for a run: weather.py failed: "give the city first, then the units"
You answer: {"tool": "library", "arguments": {"op": "append", "name": "${PLAYBOOK}", "text": "- weather.py takes the city first, then the units"}}`
      : ''
  }${
    has('memory')
      ? `
The user says: my sister Ada's birthday is on the 14th of March
You answer: {"tool": "remember", "arguments": {"category": "PEOPLE", "about": "Ada", "text": "The user's sister", "notes": ["birthday 03-14"]}}
The tool result: {"file": "PEOPLE", "node": "ada", "added_to_file": "- Ada: The user's sister", …}
You answer: I'll remember Ada's birthday, the 14th of March.
The user says: what should I get Ada?
You answer: {"tool": "recall", "arguments": {"name": "Ada"}}
The tool result: {"found": true, "lines": ["| PEOPLE | ada", "| ada @birthday 03-14", "| ada - likes | gardening"], …}
You answer: Ada likes gardening, so a good pair of gloves or a plant would suit her. Her birthday's on the 14th of March.`
      : ''
  }${
    library
      ? `
The user says: put eggs on my shopping list
You answer: {"tool": "library", "arguments": {"op": "append", "name": "Shopping", "text": "- eggs"}}
The tool result: {"name": "Shopping", "action": "appended", …}
You answer: Eggs are on your shopping list.`
      : ''
  }`);
  if (notes) p.push(notes.prompt());
  // What changes from one message to the next comes last.
  if (catalog?.upcoming?.length) p.push(`Coming up in the next week, from MEMORY (bring it up when it's relevant, or when they ask what's coming):\n${catalog.upcoming.map((l) => `- ${l}`).join('\n')}`);
  if (matches.length) p.push(`What fits what was just said, from a search of the scripts, flows and routes (run a script by its name; find looks for others):\n${matches.map((l) => `- ${l}`).join('\n')}`);
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
    "Note from the Mac (not the user): you said you can't, or don't know, but your tools may well do it (the scripts reach the web, files, apps and the Mac). Look at the scripts listed (or find one by a few words) and use one now; only if none could, say so plainly.",
  outOfRounds: (n) => `Note from the Mac (not the user): that's ${n} tool calls for this one request, as many as one gets. Answer the user now with what you have, saying what's left undone.`,
  onlyFirst: (done, rest) => `Note from the Mac (not the user): only your first call (${done}) was made; ${rest.join(', ')} wasn't, since it's one call per answer. Make it next if it's still wanted.`,
  unknownTool: (name, catalog) =>
    `There's no tool called ${name}. The tools: ${toolsFor(catalog).map((t) => t.name).join(', ')}.${catalog?.scripts?.length ? ' To run a script, call run_script with its name as listed.' : ''}`,
  /** After a tool that failed: the critic's moment. */
  review:
    "Note from the Mac (not the user): that didn't work. Before anything else, look at why: the wrong script, the wrong arguments, something the error or the output tells you? Try once more a different way if one could work; otherwise tell the user plainly what went wrong and what would fix it. Don't repeat the same call unchanged.",
  /** After a request that took work: the moment to learn. */
  reflect: `Note from the Mac (not the user), not said aloud: the request is over. Is there something you learned from it that will matter next time and isn't in your playbook yet (which script or arguments worked, how the user likes things done, a mistake to avoid)? If so, answer with only the library call that adds it to "${PLAYBOOK}" (or writes the note again without a line that proved wrong), or, for something about the user themselves, the remember call. If not, answer only (nothing).`,
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
