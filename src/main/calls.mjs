// Who an answer is to, hand-rolled. The chat is a group chat of three: the user, the model, and
// Peter, who does things. Every answer of the model's is addressed: "@user …" is said aloud to the
// user, "@peter …" is a message to Peter (never said; a tone plays instead), and an answer may do
// both ("@user Let me check." then "@peter search the web for …"). Words addressed to no one are
// the user's. No tool names, arguments or JSON, so any model can do it, and a small one most
// easily: it's how people ask each other for things in a chat. This reads the parts out of an
// answer: what's to be said, and the message to Peter.

import { tagCue } from '../shared/text.mjs';

/** Who an answer can be to: Peter (who does things on the Mac and the web), and the user (said aloud). */
export const HANDLES = ['peter', 'user'];

// "@peter", "@Peter:", "@user,": not part of an address (sam@peter.com).
const HANDLE = /(?<![\w@])@(peter|user)\b[:,]?/gi;

/**
 * The addressed parts of an answer, in order: [{ to, text, start }]. The first "@peter" (or
 * "@user") anywhere starts one, and what follows it is its text; another starts only at the
 * beginning of a line. A code fence around a part is dropped. Words before the first part are
 * the user's (to: 'user', unaddressed).
 */
export function parts(text) {
  const s = String(text ?? '');
  const found = [];
  for (const m of s.matchAll(HANDLE)) {
    const before = s.slice(0, m.index);
    const lineStart = /(^|\n)[ \t>*`-]*$/.test(before);
    if (found.length && !lineStart) continue;
    found.push({ to: m[1].toLowerCase(), start: fenceStart(s, m.index), from: m.index + m[0].length });
  }
  const out = [];
  const lead = found.length ? s.slice(0, found[0].start) : s;
  if (lead.trim()) out.push({ to: 'user', start: 0, text: unfence(lead), unaddressed: true });
  found.forEach((f, i) => out.push({ to: f.to, start: f.start, text: unfence(s.slice(f.from, i + 1 < found.length ? found[i + 1].start : s.length)) }));
  return out;
}

/** Where a part starts: at its handle, or at the code fence just before it. */
function fenceStart(s, at) {
  const m = s.slice(0, at).match(/```[\w-]*[ \t]*\n?[ \t]*$/);
  return m ? at - m[0].length : at;
}

/** A part without the code fences around it (or around its lines), and without the blank lines at its ends. */
function unfence(t) {
  return String(t)
    .replace(/^[ \t]*```[\w-]*[ \t]*$/gm, '')
    .replace(/^\s*\n/, '')
    .replace(/\s+$/, '')
    .replace(/^[ \t]+(?=\S)/, '');
}

/** The messages to Peter in an answer: [{ to: 'peter', text, start }]. */
export function messages(text) {
  return parts(text).filter((p) => p.to === 'peter');
}

/** The words of an answer that are the user's (said aloud): every part to the user, joined. */
export function words(text) {
  return parts(text)
    .filter((p) => p.to === 'user')
    .map((p) => p.text)
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** It looks like a tool call written as JSON (out of habit): there are none to make. */
export function looksLikeCall(text) {
  return !messages(text).length && /"(tool|function|tool_name)"\s*:/.test(String(text ?? '').replace(/'/g, '"'));
}

/** Whether the answer says who it's to (it should: "@user" or "@peter"). */
export function addressed(text) {
  return parts(text).some((p) => !p.unaddressed);
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
 * The part of an answer that is to be said: its parts to the user, without their asides. While
 * it's still being written, it stops where a handle or an aside may be beginning (an "@", a "`",
 * an open bracket), as there's no telling yet what it will be. It only grows as the answer does
 * (a part to Peter in between adds nothing), so what's been said stays said.
 */
export function sayable(partial, { final = false } = {}) {
  let s = words(partial);
  // A tool call written as JSON out of habit is never said (it's sent back).
  if (s.includes('{"')) s = s.slice(0, s.indexOf('{"'));
  if (!final) {
    const held = s.search(/(^|\s)@\w*$|`+$/);
    if (held !== -1) s = s.slice(0, held);
    if (/```/.test(s)) s = s.slice(0, s.indexOf('```'));
    if (/(^|\n)[ \t]*@\w*$/.test(String(partial))) s = s.replace(/\s+$/, '');
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
