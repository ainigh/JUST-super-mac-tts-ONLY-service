// What the assistant has learned about working with the user: short notes in three sections, read
// into its prompt every turn and written by the model itself (learn, unlearn) as it learns. Facts
// about the user's world (people, places, dates, plans) go to MEMORY in Tool Mac Tool Run when
// it's there (remember, recall); these are its own know-how. Bounded, so it prunes rather than
// piles up; shown in the chat window, where the user can delete notes and add standing
// instructions of their own.

import fs from 'node:fs';
import path from 'node:path';

export const MAX_NOTES = 60;
export const MAX_NOTE = 200;

export const SECTIONS = [
  { id: 'user', title: 'About the user', about: "the user's preferences, habits, people, places and how they like things done" },
  { id: 'playbook', title: 'Playbook', about: 'how to get things done here: which script does what, the arguments that work, how long things take' },
  { id: 'mistakes', title: 'Mistakes', about: 'what went wrong and how not to do it again' },
];

const ALIASES = {
  prefs: 'user', preferences: 'user', preference: 'user', user_prefs: 'user', about_user: 'user', people: 'user', facts: 'user',
  how: 'playbook', howto: 'playbook', tools: 'playbook', scripts: 'playbook', tips: 'playbook', skills: 'playbook',
  mistake: 'mistakes', failures: 'mistakes', failure: 'mistakes', errors: 'mistakes', lessons: 'mistakes',
};

export class Memory {
  constructor({ file = null, onChange = () => {} } = {}) {
    this.file = file;
    this.onChange = onChange;
    this.notes = Object.fromEntries(SECTIONS.map((s) => [s.id, []]));
    this.instructions = '';
    try {
      if (file) {
        const o = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const s of SECTIONS) if (Array.isArray(o.notes?.[s.id])) this.notes[s.id] = o.notes[s.id].map(String).slice(0, MAX_NOTES);
        this.instructions = typeof o.instructions === 'string' ? o.instructions : '';
      }
    } catch {
      /* nothing learned yet */
    }
  }

  get count() {
    return Object.values(this.notes).reduce((n, l) => n + l.length, 0);
  }

  section(name) {
    const k = String(name ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (this.notes[k]) return k;
    const byTitle = SECTIONS.find((s) => s.title.toLowerCase().replace(/\s+/g, '_') === k);
    return byTitle?.id || ALIASES[k] || null;
  }

  remember(sectionName, note) {
    const id = this.section(sectionName ?? 'user');
    if (!id) return `No section called ${sectionName}. The sections: ${SECTIONS.map((s) => s.id).join(', ')}.`;
    let line = String(note ?? '').replace(/\s+/g, ' ').trim();
    if (!line) return 'Give the note to remember.';
    if (line.length > MAX_NOTE) line = line.slice(0, MAX_NOTE - 1) + '…';
    if (this.notes[id].some((n) => n.toLowerCase() === line.toLowerCase())) return `Already noted in ${id}.`;
    if (this.count >= MAX_NOTES) return `Your memory is full (${MAX_NOTES} notes). Forget something stale first, then remember this.`;
    this.notes[id].push(line);
    this.save();
    return `Noted in ${id} (${this.count} of ${MAX_NOTES} notes).`;
  }

  forget(sectionName, note) {
    const key = String(note ?? '').trim().toLowerCase();
    if (!key) return 'Say which note to forget (its words, or enough of them).';
    const ids = sectionName ? [this.section(sectionName)].filter(Boolean) : SECTIONS.map((s) => s.id);
    if (!ids.length) return `No section called ${sectionName}. The sections: ${SECTIONS.map((s) => s.id).join(', ')}.`;
    const hits = ids.flatMap((id) => this.notes[id].map((n, i) => ({ id, i, n }))).filter((h) => h.n.toLowerCase() === key);
    const loose = hits.length ? hits : ids.flatMap((id) => this.notes[id].map((n, i) => ({ id, i, n }))).filter((h) => h.n.toLowerCase().includes(key));
    if (!loose.length) return 'No note says that.';
    if (loose.length > 1 && !hits.length) return 'More than one note has those words; give more of the one to forget.';
    const h = loose[0];
    this.notes[h.id].splice(h.i, 1);
    this.save();
    return 'Forgotten.';
  }

  setInstructions(text) {
    this.instructions = String(text ?? '').slice(0, 4000);
    this.save();
  }

  /** The notes as the model reads them every turn. */
  prompt() {
    let p = `Your own notes (what you've learned so far about working with the user; ${this.count} of ${MAX_NOTES} notes):`;
    for (const s of SECTIONS) {
      p += `\n${s.id} (${s.about}):`;
      p += this.notes[s.id].length ? '\n' + this.notes[s.id].map((n) => `- ${n}`).join('\n') : ' (empty)';
    }
    return p;
  }

  json() {
    return { notes: this.notes, instructions: this.instructions, count: this.count, max: MAX_NOTES, sections: SECTIONS };
  }

  save() {
    if (this.file) {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify({ notes: this.notes, instructions: this.instructions }, null, 2));
      } catch (err) {
        console.error('Super Face: memory not saved:', err.message);
      }
    }
    this.onChange(this.json());
  }
}

export const TOOLS = [
  {
    name: 'learn',
    description:
      'Saves one short line to your own notes, which you read at the start of every turn and the user can see: how they like you to work (user: units, tone, habits), how to get something done here, such as which script and arguments worked (playbook), or a mistake and how to avoid it (mistakes). Nothing you already have, nothing that only matters now.',
    args: [
      ['section', 'string: user, playbook or mistakes'],
      ['note', 'string: the line, short and specific'],
    ],
  },
  {
    name: 'unlearn',
    description: 'Takes a line out of your own notes, when it is wrong or stale, or they are full.',
    args: [
      ['section', 'string, optional: user, playbook or mistakes'],
      ['note', 'string: the line, or enough of it to tell it apart'],
    ],
  },
];

export function runTool(memory, name, args = {}) {
  const note = args.note ?? args.text ?? args.line ?? args.content;
  const section = args.section ?? args.category ?? args.kind;
  if (name === 'learn') return memory.remember(section, note);
  if (name === 'unlearn') return memory.forget(section, note);
  return null;
}
