// Settings: a JSON file (~/Library/Application Support/Super Face/settings.json). Anything missing
// takes its default, so settings saved by an older version still load.

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULTS = {
  port: 8769,
  serving: true,
  avatar: 'brunette',
  voice: 'af_heart',
  speed: 1,
  mood: 'neutral',
  /** What the character shows while it talks, for what's left out: rules (read from the words), off (only what's asked). */
  expressions: 'rules',
  /** The one model: Ollama's. Empty: the best one Ollama has. */
  ollamaUrl: 'http://127.0.0.1:11434',
  model: '',
  /** Thinking before answering: better answers on hard questions, slower on every one. */
  think: false,
  /** Where Peter is (Tool Mac Agent): everything on the Mac and the web goes through him. */
  peterUrl: 'http://127.0.0.1:8770',
  /** Listening for what's said while the character is shown. */
  listening: true,
  /** Listening while it talks too, so it can be cut in on (its own voice is told apart by its words). */
  listenWhileSpeaking: true,
  /** A soft tone, now and then, while it works something out: it's busy, not gone. */
  busyTone: true,
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
    // Expressions came from the model once: they're read from the words now.
    if (this.value.expressions === 'model') this.value.expressions = 'rules';
    // The framing was a setting once: it's always head to toes now.
    delete this.value.view;
    // Tool Mac Tool Run was talked to directly once: Peter is, now.
    delete this.value.toolRunUrl;
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

  /** Back to how it comes: the file goes, and every setting is its default again. */
  reset() {
    const before = this.value;
    this.value = { ...DEFAULTS };
    try {
      fs.rmSync(this.file, { force: true });
    } catch (err) {
      console.error('Super Face: settings not reset:', err.message);
    }
    for (const fn of this.listeners) fn(this.value, before);
    return this.value;
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
