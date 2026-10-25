// What the assistant has learned about working with the user, kept on the Mac, not here: its
// playbook (which way works for what, how the user likes things done, mistakes not to make
// again) and the user's standing instructions are two notes in Tool Mac Tool Run's library, and
// what it knows of the user themselves (preferences, where they live) is MEMORY's, as notes on
// "the user". The model writes them by asking Peter, like anything else; this reads them back for
// its prompt at the start of every request, asking Peter too, in words he reads without his model
// (exact), as a client of its own (so the model's news from Peter isn't taken by it).

export const PLAYBOOK = 'Super Face playbook';
export const INSTRUCTIONS = 'Super Face instructions';
/** The node in MEMORY (and the mind) that what's learned about the user is noted on. */
export const THE_USER = 'the user';
/** Who reads the notes, to Peter. */
export const NOTES_CLIENT = 'Super Face (its notes)';

const MAX_LINES = 80; // of the playbook, in the prompt

export class Notes {
  /**
   * @param {object} o
   * @param {import('./peter.mjs').Peter} o.peter
   */
  constructor({ peter }) {
    this.peter = peter;
    this.playbook = []; // its lines ("- …")
    this.instructions = '';
    this.aboutUser = []; // MEMORY's lines on the user
    this.error = 'not read yet';
  }

  /** Reads them all again (at once, each a request to Peter). */
  async refresh({ signal } = {}) {
    const [playbook, instructions, about] = await Promise.all([this.read(PLAYBOOK, signal), this.read(INSTRUCTIONS, signal), this.recall(signal)]);
    if (playbook !== undefined) this.playbook = lines(playbook).slice(-MAX_LINES);
    if (instructions !== undefined) this.instructions = instructions;
    if (about !== undefined) this.aboutUser = about;
    this.error = playbook === undefined || about === undefined ? "Peter didn't answer" : null;
    return this;
  }

  /** A note's text ('' when it isn't written yet); undefined when Peter didn't answer as he does. */
  async read(name, signal) {
    const { text, failed } = await this.peter.say(`read the note ${name}`, { signal, exact: true, client: NOTES_CLIENT, timeout: 4000 });
    const t = withoutNews(text);
    const m = t.match(/^The note [^\n]*:\n([\s\S]*)$/);
    if (m) return bodyOf(m[1].replace(/\n\nYou can also say:[\s\S]*$/, ''));
    if (/^The note .* is empty\./.test(t) || /no note called/i.test(t)) return '';
    return failed ? undefined : '';
  }

  /** MEMORY's lines on the user ([] when there are none); undefined when Peter didn't answer as he does. */
  async recall(signal) {
    const { text } = await this.peter.say(`what do you know about ${THE_USER}`, { signal, exact: true, client: NOTES_CLIENT, timeout: 4000 });
    const t = withoutNews(text);
    const m = t.match(/^What's known about [^\n]*:\n([\s\S]*?)(\n\nYou can also say:[\s\S]*)?$/);
    if (m) return m[1].split('\n').map((l) => l.replace(/^-\s*/, '').trim()).filter(Boolean).slice(0, 40);
    if (/^Nothing is remembered about/.test(t)) return [];
    return undefined;
  }

  /** What the model reads with every request. */
  prompt() {
    const p = [];
    p.push(`Your playbook (the note "${PLAYBOOK}", kept by Peter: what you've learned about getting things done for the user):\n${this.playbook.length ? this.playbook.join('\n') : '(nothing yet)'}`);
    if (this.aboutUser.length) p.push(`What MEMORY has on the user themselves:\n${this.aboutUser.map((l) => `- ${l}`).join('\n')}`);
    if (this.instructions.trim()) p.push(`The user's standing instructions (follow them):\n${this.instructions.trim()}`);
    return p.join('\n\n');
  }

  json() {
    return { playbook: this.playbook, instructions: this.instructions, aboutUser: this.aboutUser, error: this.error, names: { playbook: PLAYBOOK, instructions: INSTRUCTIONS, user: THE_USER } };
  }
}

/** Peter's answer without news of other requests at its start ("Meanwhile: …"). */
function withoutNews(text) {
  return String(text ?? '').replace(/^Meanwhile:[\s\S]*?\n\n/, '').trim();
}

/** A note's text without its "# " title, as it was written. */
function bodyOf(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/^# [^\n]*(\n|$)/, '')
    .trim();
}

/** The lines of a playbook: each "- …" (any other line that says something gets its "- "). */
function lines(body) {
  return String(body)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /[\p{L}\p{N}]/u.test(l) && !l.startsWith('#'))
    .map((l) => (/^[-*]\s/.test(l) ? `- ${l.slice(2).trim()}` : `- ${l}`));
}
