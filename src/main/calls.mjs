// Tool calls, hand-rolled: the model writes a line of JSON, {"tool": "name", "arguments": {…}}, in
// its answer, and the result goes back to it as the next message. Not Ollama's tool calling, so any
// model can do it. This reads the calls out of an answer, and the words around them.

/** Where the JSON object starting at `from` ends (the index of its "}"), or -1 if it doesn't. */
function objectEnd(s, from) {
  let depth = 0;
  let inString = false;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Every outermost JSON object in the text, with where it is: [{ value, start, end }]. */
export function objects(text) {
  const s = String(text ?? '');
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    const end = objectEnd(s, i);
    if (end === -1) continue;
    try {
      const value = JSON.parse(s.slice(i, end + 1));
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        out.push({ value, start: i, end: end + 1 });
        i = end;
      }
    } catch {
      /* not JSON: carry on from the next brace */
    }
  }
  return out;
}

const NAME_KEYS = ['tool', 'name', 'function', 'tool_name'];
const ARG_KEYS = ['arguments', 'args', 'parameters', 'input', 'params'];

function isCall(o) {
  return NAME_KEYS.some((k) => typeof o[k] === 'string' && o[k].trim());
}

/**
 * The calls in an answer, in order: [{ name, arguments, start, end }]. A call is any JSON object
 * with a "tool" (or "name", "function") key, bare, in a code fence, or among other words.
 */
export function calls(text) {
  const out = [];
  for (const { value: o, start, end } of objects(text)) {
    if (!isCall(o)) continue;
    // {"name": "Sam", "age": 3} isn't a call: "name" counts only beside arguments, or alone.
    const key = typeof o.tool === 'string' ? 'tool' : typeof o.tool_name === 'string' ? 'tool_name' : typeof o.function === 'string' ? 'function' : 'name';
    if (key === 'name' && !ARG_KEYS.some((k) => k in o) && Object.keys(o).length > 1) continue;
    let args = ARG_KEYS.map((k) => o[k]).find((v) => v !== undefined);
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = { value: args };
      }
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      // Arguments beside the name: {"tool": "list_runs", "limit": 5}.
      args = Object.fromEntries(Object.entries(o).filter(([k]) => !NAME_KEYS.includes(k) && !ARG_KEYS.includes(k)));
    }
    out.push({ name: o[key].trim(), arguments: args, start, end });
  }
  return out;
}

/** The words of an answer: everything but its tool calls (and the code fences around them). */
export function words(text) {
  let s = String(text ?? '');
  const found = calls(s);
  for (let i = found.length - 1; i >= 0; i--) s = s.slice(0, found[i].start) + s.slice(found[i].end);
  return s
    .replace(/```(?:json)?\s*```/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The part of an answer still being written that is safe to say: everything before anything that
 * might become a tool call (a "{", or a code fence).
 */
export function sayable(partial) {
  const s = String(partial ?? '');
  const cut = [s.indexOf('{'), s.indexOf('```')].filter((i) => i !== -1);
  return cut.length ? s.slice(0, Math.min(...cut)) : s;
}

/** It looks like a call that couldn't be read: "tool" or "arguments" keys, but no call parsed. */
export function looksBroken(text) {
  if (calls(text).length) return false;
  const s = String(text ?? '').replace(/'/g, '"');
  return /"(tool|arguments)"\s*:/.test(s) || /^\s*\{\s*"/m.test(s) && /"\s*:/.test(s) && !/\}\s*$/.test(s.trim());
}

/** The answer says nothing is to be said: "(nothing)", "[silence]". */
export function isSilent(text) {
  return /^[([]?\s*(nothing|silence|silent|no reply|no answer|no response|none|nothing to (say|add))\s*[)\]]?[.!]?$/i.test(String(text ?? '').trim());
}
