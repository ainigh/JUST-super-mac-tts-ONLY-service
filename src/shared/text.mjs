// Text in, sentences out: what is said aloud (markdown, links and code taken out), cut into
// sentences, with the cues written into it (emojis, [tags]) taken out and kept, each at the point
// in its sentence where it was written.

import { EMOJI, expressionName, gestureName, headName, moodName, poseName } from './catalog.mjs';

/** Markdown and the like, made fit to be read aloud. Emojis and [tags] are left for `parse`. */
export function speakable(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
    .replace(/\[([^\]]+)\]\((?:https?:|mailto:|\/|#)[^)]*\)/g, '$1') // links → their text
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/^\s*(#{1,6}|[-*•]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(^|\s)[*_](\S.*?\S|\S)[*_](?=\s|[.,!?;:]|$)/g, '$1$2')
    .replace(/^>\s?/gm, '')
    .replace(/[#*_~]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** A [tag] written in the text: what it asks for, or null when it's just brackets. */
export function tagCue(inner) {
  const s = String(inner).trim();
  const m = s.match(/^(mood|expression|face|gesture|hand|hands|head|pose)\s*[:=]\s*(.+)$/i);
  if (m) {
    const kind = m[1].toLowerCase();
    const v = m[2].trim();
    if (kind === 'mood') return moodName(v) && { mood: moodName(v) };
    if (kind === 'expression' || kind === 'face') return expressionName(v) && { expression: expressionName(v) };
    if (kind === 'gesture' || kind === 'hand' || kind === 'hands') return gestureName(v) && { gesture: gestureName(v) };
    if (kind === 'head') return headCue(v);
    if (kind === 'pose') return poseName(v) && { pose: poseName(v) };
    return null;
  }
  if (moodName(s)) return { mood: moodName(s) };
  if (expressionName(s)) return { expression: expressionName(s) };
  if (gestureName(s)) return { gesture: gestureName(s) };
  const h = headCue(s);
  if (h) return h;
  if (poseName(s)) return { pose: poseName(s) };
  return null;
}

function headCue(v) {
  const k = String(v).trim().toLowerCase();
  if (k === 'nod') return { head: 'yes' };
  if (k === 'shake') return { head: 'no' };
  return headName(k) ? { head: headName(k) } : null;
}

// Emojis (with their modifiers and joiners) and [tags].
const CUE = /\[([^\]\n]{1,40})\]|(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|[♀♂]️?|\p{Emoji_Modifier})*|☝️|☹️)/gu;

/**
 * The text with its cues taken out: `text` to say, and `cues`, each with `at`, where it was
 * written (a character offset into `text`).
 */
export function extractCues(input) {
  const cues = [];
  let out = '';
  let last = 0;
  const s = String(input ?? '');
  for (const m of s.matchAll(CUE)) {
    let cue = null;
    if (m[1] !== undefined) cue = tagCue(m[1]);
    else {
      const e = m[2];
      cue = EMOJI[e] || EMOJI[e.replace(/️/g, '')] || EMOJI[`${e.replace(/️/g, '')}️`] || null;
      if (!cue) cue = {}; // an emoji we have nothing for is still not read out
    }
    if (!cue) continue; // brackets that aren't a cue stay in the text
    out += s.slice(last, m.index);
    last = m.index + m[0].length;
    if (Object.keys(cue).length) {
      cues.push({ ...cue, at: out.replace(/\s+/g, ' ').trimStart().length, ...(m[2] !== undefined ? { emoji: true } : {}) });
    }
  }
  out += s.slice(last);
  return { text: out, cues };
}

// A sentence ends at . ! ? … (plus closing quotes and brackets) and a space, or at a line break.
const END = /[.!?…]+["'”’)\]]*(?=\s|$)|\n+/g;

/** The text cut into sentences (a very long one is cut again at a comma or a space). */
export function sentences(text) {
  const s = String(text ?? '');
  const parts = [];
  let start = 0;
  for (const m of s.matchAll(END)) {
    const end = m.index + m[0].length;
    parts.push(s.slice(start, end));
    start = end;
  }
  parts.push(s.slice(start));
  const out = [];
  for (let p of parts.map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean)) {
    while (p.length > 300) {
      const cut = Math.max(p.lastIndexOf(', ', 280), p.lastIndexOf('; ', 280));
      const at = cut > 60 ? cut + 1 : p.lastIndexOf(' ', 280) > 60 ? p.lastIndexOf(' ', 280) : 280;
      out.push(p.slice(0, at).trim());
      p = p.slice(at).trim();
    }
    if (p) out.push(p);
  }
  // A fragment with nothing to say ("..." or a stray mark) joins the sentence before it.
  return out.filter((x) => /[\p{L}\p{N}]/u.test(x));
}

/**
 * Everything to say, ready for the voice: sentences, each with the cues written in it, at a
 * fraction (0 to 1) of the way through it. Cues after the last word go on the last sentence's end.
 */
export function parse(input) {
  const { text, cues } = extractCues(speakable(input));
  const flat = text.replace(/\s+/g, ' ').trim();
  const list = sentences(flat);
  // Where each sentence starts in the text; a cue goes with the sentence it falls in (before the
  // first, with the first; after the last, at the end of the last).
  const starts = [];
  let offset = 0;
  for (const sentence of list) {
    const at = flat.indexOf(sentence, offset);
    starts.push(at === -1 ? offset : at);
    offset = starts.at(-1) + sentence.length;
  }
  const result = list.map((t) => ({ text: t, cues: [] }));
  for (const { at, emoji, ...cue } of cues) {
    if (!result.length) break;
    let i = 0;
    while (i + 1 < starts.length && at >= starts[i + 1]) i++;
    // An emoji written after a sentence ("Sorry. 😔") is how that sentence is said: from its start.
    if (emoji) {
      if (i > 0 && at === starts[i]) i--;
      if (at >= starts[i] + list[i].length) {
        result[i].cues.push({ ...cue, at: 0 });
        continue;
      }
    }
    const len = list[i].length || 1;
    result[i].cues.push({ ...cue, at: Math.min(1, Math.max(0, (at - starts[i]) / len)) });
  }
  return { sentences: result, cues: cues.map(({ emoji: _e, ...c }) => c), text: flat };
}

/** Words, lower-cased, for comparing what was heard with what was said. */
export function words(text) {
  return (
    String(text ?? '')
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      .match(/[\p{L}\p{N}']+/gu) || []
  )
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter(Boolean);
}
