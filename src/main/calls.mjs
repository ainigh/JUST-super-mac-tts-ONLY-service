// Messages to Peter (and the Clock), hand-rolled: the model ends its answer with a line that
// starts "@peter" and says, in plain words, what it wants done; what Peter says back goes to it as
// the next message. No tool names, arguments or JSON, so any model can do it, and a small one
// most easily: it's how people ask each other for things in a chat. This reads the message out of
// an answer, and the words before it (the only part that's said).

import { tagCue } from '../shared/text.mjs';

/** Who the model can ask: Peter (Tool Mac Tool Run, everything on the Mac and the web), and the Clock (the schedule). */
export const HANDLES = ['peter', 'clock'];

// "@peter", "@Peter:", "@peter_the_worker,": not part of an address (sam@peter.com).
const HANDLE = /(?<![\w@])@(peter|clock)\w*[:,]?/gi;

/**
 * The messages in an answer, in order: [{ to, text, start }]. The first "@peter" (or "@clock")
 * anywhere starts one, and what follows it is the message; another starts only at the beginning
 * of a line. A code fence around a message is dropped.
 */
export function messages(text) {
  const s = String(text ?? '');
  const found = [];
  for (const m of s.matchAll(HANDLE)) {
    const before = s.slice(0, m.index);
    const lineStart = /(^|\n)[ \t>*`-]*$/.test(before);
    if (found.length && !lineStart) continue;
    found.push({ to: m[1].toLowerCase(), start: fenceStart(s, m.index), from: m.index + m[0].length });
  }
  return found.map((f, i) => ({ to: f.to, start: f.start, text: unfence(s.slice(f.from, i + 1 < found.length ? found[i + 1].start : s.length)) }));
}

/** Where a message starts: at its handle, or at the code fence just before it. */
function fenceStart(s, at) {
  const m = s.slice(0, at).match(/```[\w-]*[ \t]*\n?[ \t]*$/);
  return m ? at - m[0].length : at;
}

/** A message without the code fences around it (or around its lines), and without the blank lines at its ends. */
function unfence(t) {
  return String(t)
    .replace(/^[ \t]*```[\w-]*[ \t]*$/gm, '')
    .replace(/^\s*\n/, '')
    .replace(/\s+$/, '')
    .replace(/^[ \t]+(?=\S)/, '');
}

/** The words of an answer: everything before its first message (the rest isn't said or shown as words). */
export function words(text) {
  const s = String(text ?? '');
  const first = messages(s)[0];
  return (first ? s.slice(0, first.start) : s)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** It looks like a tool call written as JSON (out of habit): there are none to make. */
export function looksLikeCall(text) {
  return !messages(text).length && /"(tool|function|tool_name)"\s*:/.test(String(text ?? '').replace(/'/g, '"'));
}

/**
 * The words without the asides written in brackets: stage directions like "(smiles)", "(looking
 * puzzled)", "[pause]", "(nothing)". They're never meant to be said. What the face plays ([smile],
 * [nod]) stays for it, and so do code and links, whose brackets are part of them.
 */
export function withoutAsides(text) {
  return String(text ?? '')
    .split(/(```[\s\S]*?```|`[^`\n]*`|\[[^[\]\n]*\]\([^()\s]*\))/)
    .map((part, i) => {
      if (i % 2) return part; // code, or a link
      for (let before; before !== part; ) {
        before = part;
        part = part.replace(/\([^()]*\)/g, '').replace(/\[([^[\]\n]*)\]/g, (all, inner) => (tagCue(inner) ? all : ''));
      }
      return part;
    })
    .join('');
}

/** Where an aside has begun and not yet ended (an "(" or "[" with no close after it), or -1. */
function openAside(text) {
  let depth = 0;
  let from = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[') {
      if (!depth++) from = i;
    } else if ((c === ')' || c === ']') && depth) depth--;
  }
  return depth ? from : -1;
}

/**
 * The part of an answer that is to be said: everything before its first message, without its
 * asides. While it's still being written, it stops where a message or an aside may be beginning
 * (an "@", a "`", an open bracket), as there's no telling yet what it will be.
 */
export function sayable(partial, { final = false } = {}) {
  let s = words(partial);
  // A tool call written as JSON out of habit is never said (it's sent back).
  if (s.includes('{"')) s = s.slice(0, s.indexOf('{"'));
  if (!final) {
    const held = s.search(/(^|\s)@\w*$|`+$/);
    if (held !== -1) s = s.slice(0, held);
    if (/```/.test(s)) s = s.slice(0, s.indexOf('```'));
  }
  const prose = withoutAsides(s);
  const open = final ? -1 : openAside(prose);
  return open === -1 ? prose : prose.slice(0, open);
}

const SILENT = ['nothing', 'silence', 'silent', 'no reply', 'no answer', 'no response', 'none', 'nothing to say', 'nothing to add'];

/** What's been written so far could still be the start of saying nothing is to be said. */
export function maySayNothing(text) {
  const s = String(text ?? '').trim().toLowerCase();
  return SILENT.some((w) => w.startsWith(s));
}

/** The answer says nothing is to be said: "nothing", "(nothing)", "(looking puzzled) (nothing)", "[silence]". */
export function isSilent(text) {
  const s = String(text ?? '').trim();
  const left = withoutAsides(s).trim();
  if (s && /^[\s.,;:!?…-]*$/.test(left)) return true; // only asides
  return /^(nothing|silence|silent|no reply|no answer|no response|none|nothing to (say|add))[.!]?$/i.test(left);
}
