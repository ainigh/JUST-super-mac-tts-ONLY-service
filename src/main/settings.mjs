// Settings: a JSON file (~/Library/Application Support/Super Face/settings.json). Anything missing
// takes its default, so settings saved by an older version still load.

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULTS = {
  port: 8769,
  serving: true,
  avatar: 'brunette',
  view: 'full',
  voice: 'af_heart',
  speed: 1,
  mood: 'neutral',
  /** For what clients send to /api/speak: model (the model picks expressions, rules until it answers), rules, off. */
  expressions: 'model',
  /** The one model: Ollama's. Empty: the best one Ollama has. */
  ollamaUrl: 'http://127.0.0.1:11434',
  model: '',
  /** Thinking before answering: better answers on hard questions, slower on every one. */
  think: false,
  /** Where the tools are: Tool Mac Tool Run's API. */
  toolRunUrl: 'http://127.0.0.1:8768',
  /** Listening for what's said while the character is shown. */
  listening: true,
  /** Listening while it talks too, so it can be cut in on (its own voice is told apart by its words). */
  listenWhileSpeaking: true,
  /** Showing the character as the app opens (on standby, listening). */
  showAtLaunch: true,
  captions: true,
  /** Seconds after it last spoke before it hides itself; 0: it stays. */
  hideAfter: 0,
  alwaysOnTop: true,
  size: 'Medium',
  /** Browser origins allowed besides this machine's pages. */
  origins: [],
  bounds: null,
};

export class Settings {
  constructor(file) {
    this.file = file;
    this.value = { ...DEFAULTS, ...read(file) };
    this.listeners = new Set();
  }

  get() {
    return this.value;
  }

  set(patch) {
    const before = this.value;
    this.value = { ...this.value, ...patch };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.value, null, 2));
    } catch (err) {
      console.error('Super Face: settings not saved:', err.message);
    }
    for (const fn of this.listeners) fn(this.value, before);
    return this.value;
  }

  onChange(fn) {
    this.listeners.add(fn);
  }
}

function read(file) {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}
