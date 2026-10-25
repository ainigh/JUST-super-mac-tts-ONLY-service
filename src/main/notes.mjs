// What the assistant has learned about working with the user, kept in its own space in Storage
// Spaces (http://127.0.0.1:8771): the user's standing instructions (SUPER/PROMPT, the note
// "instructions") and its playbook (SUPER/MEMORY, the note "playbook": which way works for what,
// how the user likes things done, mistakes not to make again). This reads them for its prompt at
// the start of every request, straight from there: no model, no Peter, so it's quick. Writing is
// Peter's: the model asks him to keep something, word for word, and he writes it (his tool
// space_notes). What's known about the user themselves is in MEMORY: the model asks Peter for it
// when it needs it.

export const DEFAULT_URL = 'http://127.0.0.1:8771';
/** Who this app is to Storage Spaces: it may read and write its own space, SUPER. */
export const CLIENT = 'Super Face';
/** Where each note is, in SUPER. */
export const WHERE = {
  instructions: { store: 'prompt', name: 'instructions', said: "Super Face's instructions (SUPER/PROMPT, the note instructions)" },
  playbook: { store: 'memory', name: 'playbook', said: "Super Face's playbook (SUPER/MEMORY, the note playbook)" },
};

const MAX_LINES = 80; // of the playbook, in the prompt

export class Notes {
  /**
   * @param {object} o
   * @param {() => string} [o.url] - Storage Spaces' address, read fresh for every call
   * @param {typeof fetch} [o.fetch]
   */
  constructor({ url = () => DEFAULT_URL, fetch: f = globalThis.fetch } = {}) {
    this.urlOf = url;
    this.fetch = f;
    this.playbook = []; // its lines ("- …")
    this.instructions = '';
    this.error = 'not read yet';
  }

  get url() {
    let s = String(this.urlOf() || DEFAULT_URL).trim();
    if (!/^https?:/i.test(s)) s = `http://${s}`;
    return s.replace(/\/+$/, '');
  }

  /** Reads both again (at once). What couldn't be read stays as it was. */
  async refresh({ signal } = {}) {
    const [instructions, playbook] = await Promise.all([this.read(WHERE.instructions, signal), this.read(WHERE.playbook, signal)]);
    if (instructions !== undefined) this.instructions = instructions;
    if (playbook !== undefined) this.playbook = lines(playbook).slice(-MAX_LINES);
    this.error = instructions === undefined || playbook === undefined ? `Storage Spaces isn't answering at ${this.url}: is it open?` : null;
    return this;
  }

  /** A note's text ('' when it isn't written yet); undefined when Storage Spaces didn't answer. */
  async read({ store, name }, signal) {
    const timeout = AbortSignal.timeout(3000);
    try {
      const res = await this.fetch(`${this.url}/api/spaces/super/${store}/files/${encodeURIComponent(name)}?format=text`, {
        headers: { 'X-Client': CLIENT },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (res.status === 404) return '';
      if (!res.ok) return undefined;
      return bodyOf(await res.text());
    } catch {
      return undefined;
    }
  }

  /** What the model reads with every request (nothing, when both are empty). */
  prompt() {
    const p = [];
    if (this.instructions.trim()) p.push(`The user's standing instructions (follow them):\n${this.instructions.trim()}`);
    if (this.playbook.length) p.push(`What you've learned about getting things done for the user:\n${this.playbook.join('\n')}`);
    return p.join('\n\n');
  }

  json() {
    return { playbook: this.playbook, instructions: this.instructions, error: this.error, from: this.url, where: { instructions: WHERE.instructions.said, playbook: WHERE.playbook.said } };
  }
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
