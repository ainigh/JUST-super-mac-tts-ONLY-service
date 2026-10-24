// What the assistant has learned about working with the user, kept in Tool Mac Tool Run, not
// here: its playbook (which script and arguments work for what, how the user likes things done,
// mistakes not to make again) and the user's standing instructions are two notes in the library,
// and what it knows of the user themselves (preferences, where they live) is MEMORY's, as notes
// on "the user". The model writes them with the tools it has for those (library, remember); this
// reads them back for its prompt at the start of every request, for the chat's Mind tab, and
// moves what an older version kept in memory.json over, once.

import fs from 'node:fs';
import { hasGroup } from './toolrun.mjs';

export const PLAYBOOK = 'Super Face playbook';
export const INSTRUCTIONS = 'Super Face instructions';
/** The node in MEMORY (and the mind) that what's learned about the user is noted on. */
export const THE_USER = 'the user';

const PLAYBOOK_HEAD = `# ${PLAYBOOK}\n\nWhat Super Face has learned about getting things done for you, a line each. It reads this before every request; change it as you like.\n`;
const INSTRUCTIONS_HEAD = `# ${INSTRUCTIONS}\n\nWhat Super Face should always do or keep in mind, in your words. It reads this before every request.\n`;
const MAX_LINES = 80; // of the playbook, in the prompt

export class Notes {
  /**
   * @param {object} o
   * @param {import('./toolrun.mjs').ToolRun} o.toolrun
   * @param {string|null} [o.oldFile] - memory.json, from before: moved over once, then renamed
   * @param {(json: object) => void} [o.onChange]
   */
  constructor({ toolrun, oldFile = null, onChange = () => {} }) {
    Object.assign(this, { toolrun, oldFile, onChange });
    this.playbook = []; // its lines ("- …")
    this.instructions = '';
    this.aboutUser = []; // MEMORY's lines on the user
    this.error = 'not read yet';
  }

  get library() {
    return hasGroup(this.toolrun.catalog, 'library');
  }

  get memory() {
    return hasGroup(this.toolrun.catalog, 'memory');
  }

  /** Reads them all again (the two notes in one call, MEMORY's in another, at once). */
  async refresh({ signal } = {}) {
    if (!this.library && !this.memory) {
      this.error = this.toolrun.catalog.reachable ? "Tool Mac Tool Run's library and MEMORY are turned off" : "Tool Mac Tool Run isn't reachable";
      this.emit();
      return this;
    }
    const [notes, about] = await Promise.all([this.library ? this.read(signal) : null, this.memory ? this.recall(signal) : null]);
    if (notes) {
      this.playbook = lines(bodyOf(notes[PLAYBOOK] ?? '', PLAYBOOK_HEAD)).slice(-MAX_LINES);
      this.instructions = bodyOf(notes[INSTRUCTIONS] ?? '', INSTRUCTIONS_HEAD);
    }
    if (about) this.aboutUser = about;
    this.error = notes === undefined || about === undefined ? 'Tool Mac Tool Run did not answer in time' : null;
    this.emit();
    return this;
  }

  /** The two notes' texts by name ({} when neither is written yet); undefined when it didn't answer. */
  async read(signal) {
    try {
      const [status, json] = await this.toolrun.call('POST', '/api/library', { op: 'read_many', names: [PLAYBOOK, INSTRUCTIONS] }, { signal, timeout: 2000 });
      if (status < 200 || status >= 300) return undefined;
      return Object.fromEntries((json.notes || []).map((n) => [String(n.name).toLowerCase() === PLAYBOOK.toLowerCase() ? PLAYBOOK : INSTRUCTIONS, String(n.text ?? '')]));
    } catch {
      return undefined;
    }
  }

  /** MEMORY's lines on the user ([] when there are none); undefined when it didn't answer. */
  async recall(signal) {
    try {
      const [status, json] = await this.toolrun.call('POST', '/api/memory', { op: 'recall', name: THE_USER }, { signal, timeout: 2000 });
      if (status < 200 || status >= 300) return undefined;
      return json.found === false ? [] : (json.lines || []).map(String).slice(0, 40);
    } catch {
      return undefined;
    }
  }

  /** A line out of the playbook (from the Mind tab): the note written again without it. */
  async forget(line) {
    if (!this.library) return "The playbook is in Tool Mac Tool Run's library, which isn't on.";
    await this.refresh();
    const key = String(line ?? '').trim().toLowerCase().replace(/^-\s*/, '');
    const kept = this.playbook.filter((l) => l.toLowerCase().replace(/^-\s*/, '') !== key);
    if (kept.length === this.playbook.length) return 'No line says that.';
    const result = await this.write(PLAYBOOK, PLAYBOOK_HEAD, kept.join('\n'));
    await this.refresh();
    return result;
  }

  /** The standing instructions, written whole (from the Mind tab). */
  async setInstructions(text) {
    if (!this.library) return "The standing instructions are in Tool Mac Tool Run's library, which isn't on.";
    const result = await this.write(INSTRUCTIONS, INSTRUCTIONS_HEAD, String(text ?? '').trim().slice(0, 4000));
    await this.refresh();
    return result;
  }

  async write(name, head, body) {
    const [status, json] = await this.toolrun.call('POST', '/api/library', { op: 'write', name, text: `${head}\n${body}\n` });
    return status >= 200 && status < 300 ? 'Saved.' : json.error || `Tool Mac Tool Run said ${status}`;
  }

  /**
   * What an older version kept in memory.json goes to Tool Mac Tool Run, once: the playbook and
   * mistakes to the playbook, the standing instructions to theirs (unless there are some), what
   * it knew of the user to MEMORY (or the playbook, without it). Then the file is renamed.
   */
  async moveOld() {
    if (!this.oldFile || !this.library || !fs.existsSync(this.oldFile)) return false;
    let old;
    try {
      old = JSON.parse(fs.readFileSync(this.oldFile, 'utf8'));
    } catch {
      return false;
    }
    await this.refresh();
    const notes = old.notes || {};
    const have = new Set(this.playbook.map((l) => l.toLowerCase()));
    const add = [...(notes.playbook || []), ...(notes.mistakes || []).map((n) => `Mistake: ${n}`), ...(this.memory ? [] : (notes.user || []).map((n) => `About the user: ${n}`))]
      .map((n) => `- ${String(n).trim()}`)
      .filter((l) => l.length > 2 && !have.has(l.toLowerCase()));
    if (add.length) await this.write(PLAYBOOK, PLAYBOOK_HEAD, [...this.playbook, ...add].join('\n'));
    if (this.memory && notes.user?.length) {
      await this.toolrun.call('POST', '/api/memory', { op: 'remember', category: 'PEOPLE', about: THE_USER, notes: notes.user.map((n) => `pref ${n}`) });
    }
    if (typeof old.instructions === 'string' && old.instructions.trim() && !this.instructions) await this.write(INSTRUCTIONS, INSTRUCTIONS_HEAD, old.instructions.trim());
    try {
      fs.renameSync(this.oldFile, `${this.oldFile}.moved`);
    } catch {
      /* moved again next time: nothing is added twice */
    }
    await this.refresh();
    return true;
  }

  /** What the model reads with every request. */
  prompt() {
    const p = [];
    if (this.library) {
      p.push(`Your playbook (the library note "${PLAYBOOK}": what you've learned about getting things done for the user):\n${this.playbook.length ? this.playbook.join('\n') : '(nothing yet)'}`);
    } else {
      p.push("You can't keep a playbook right now: Tool Mac Tool Run's library isn't on.");
    }
    if (this.aboutUser.length) p.push(`What MEMORY has on the user themselves (its notation: "| a @pref x" is a note on a):\n${this.aboutUser.join('\n')}`);
    if (this.instructions.trim()) p.push(`The user's standing instructions (follow them):\n${this.instructions.trim()}`);
    return p.join('\n\n');
  }

  json() {
    return { playbook: this.playbook, instructions: this.instructions, aboutUser: this.aboutUser, library: this.library, memory: this.memory, error: this.error, names: { playbook: PLAYBOOK, instructions: INSTRUCTIONS, user: THE_USER } };
  }

  emit() {
    this.onChange(this.json());
  }
}

/** A note's text without the head it was written with; edited, without its "# " title alone. */
function bodyOf(text, head) {
  const t = String(text ?? '').replace(/\r\n/g, '\n');
  return (t.startsWith(head) ? t.slice(head.length) : t.replace(/^# [^\n]*(\n|$)/, '')).trim();
}

/** The lines of a playbook: each "- …" (any other line that says something gets its "- "). */
function lines(body) {
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /[\p{L}\p{N}]/u.test(l) && !l.startsWith('#'))
    .map((l) => (/^[-*]\s/.test(l) ? `- ${l.slice(2).trim()}` : `- ${l}`));
}
