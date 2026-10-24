// Did the ears hear the mouth? Super Face knows exactly what it said and when, so whoever is
// listening (its own ears, or another app) can ask, for each phrase it heard: is this my own voice coming back
// through the microphone? It's the words that tell: what was heard, compared with what was said
// around that time. Nothing fancier.

import { words } from './text.mjs';

/** Said first and alone, these are the user cutting in, even when the voice said them too. */
const BARGE = new Set(['stop', 'wait', 'hold', 'quiet', 'pause', 'enough', 'cancel', 'hey', 'ivy', 'david', 'sofia', 'leo']);
/** Short words that tell nothing apart. */
const STOP = new Set(
  'a an the and or of to in on at for is it i my me be was are this that with by as so s you we he she they its im'.split(' '),
);

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** A word heard is one that was said: the same, or misheard by a letter or two. */
function said(word, saidWords, saidList) {
  if (saidWords.has(word)) return true;
  if (word.length < 4) return false;
  const most = word.length <= 6 ? 1 : 2;
  return saidList.some((w) => w.length >= 4 && w[0] === word[0] && editDistance(w, word) <= most);
}

/** The heard text from its `n`th word on. */
function fromWord(text, n) {
  let i = 0;
  for (const m of String(text).matchAll(/[\p{L}\p{N}’‘']+/gu)) {
    if (!/[\p{L}\p{N}]/u.test(m[0])) continue;
    if (i === n) return String(text).slice(m.index).trim();
    i++;
  }
  return '';
}

/**
 * The lines said around the time a phrase was heard: those that were playing, or had stopped less
 * than `tail` ms before, between `at - seconds` and `at`.
 */
export function around(lines, { at = Date.now(), seconds = 10, tail = 2500 } = {}) {
  const from = at - seconds * 1000;
  return lines.filter((l) => l.start <= at && (l.end ?? at) + tail >= from);
}

/**
 * Compare a phrase heard with what was said: `echo` is true when it's only the voice coming back;
 * `rest` is what the user said (the echo heard before it taken off), empty for an echo.
 * @param {string} heard
 * @param {string[]} saidTexts
 */
export function compare(heard, saidTexts) {
  const h = words(heard);
  const all = saidTexts.flatMap((t) => words(t));
  if (!h.length) return { echo: false, rest: '', matched: 0 };
  if (!all.length) return { echo: false, rest: String(heard).trim(), matched: 0 };
  const set = new Set(all);
  const list = [...set];
  const isSaid = (w) => said(w, set, list);

  // "Stop", "wait, no": short and first, it's the user, even if the voice had the word too.
  if (h.length <= 3 && BARGE.has(h[0])) return { echo: false, rest: String(heard).trim(), matched: 0 };

  const matched = h.filter(isSaid).length / h.length;
  // The echo before the user started.
  let start = 0;
  while (start < h.length && isSaid(h[start])) start++;
  if (start === h.length) return { echo: true, rest: '', matched: 1 };
  const rest = h.slice(start);
  if (BARGE.has(rest[0])) return { echo: false, rest: fromWord(heard, start), matched };
  const content = rest.filter((w) => !STOP.has(w));
  const fresh = content.filter((w) => !isSaid(w));
  // Nothing new, or a word or two new in what is mostly the voice: misheard echo.
  if (!fresh.length || (fresh.length < 3 && matched >= 0.6)) return { echo: true, rest: '', matched };
  return { echo: false, rest: fromWord(heard, start), matched };
}
