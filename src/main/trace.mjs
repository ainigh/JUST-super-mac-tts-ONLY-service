// What went to the model and what came back, and every tool call with the HTTP requests it made:
// the latest few, kept in memory only, for the chat's Model and Calls tabs. An item changing fast
// (an answer streaming in, a run printing) is sent on at most every so often, and once more at the end.

const EVERY = 400; // ms between updates of one item

export class Trace {
  /**
   * @param {object} o
   * @param {string} o.name - which log: 'model' or 'calls'
   * @param {number} [o.keep] - items kept
   * @param {(ev: object) => void} [o.emit]
   * @param {() => number} [o.now]
   */
  constructor({ name, keep = 60, emit = () => {}, now = Date.now }) {
    Object.assign(this, { name, keep, emit, now });
    this.items = [];
    this.nextId = 1;
    this.timers = new Map(); // item → its pending update
    this.sent = new Map(); // item → when it was last sent
  }

  /** A new item, sent at once; changed later with change(). */
  open(item) {
    const rec = { id: `${this.name[0]}${this.nextId++}`, at: this.now(), ...item };
    this.items.push(rec);
    while (this.items.length > this.keep) this.forget(this.items.shift());
    this.send(rec);
    return rec;
  }

  /** `rec` changed (by `patch`, or in place): sent now, or soon when it was just sent. `final`: now. */
  change(rec, patch, { final = false } = {}) {
    if (!rec) return;
    if (patch) Object.assign(rec, patch);
    if (!this.items.includes(rec)) return;
    const wait = EVERY - (this.now() - (this.sent.get(rec) || 0));
    if (final || wait <= 0) return this.send(rec);
    if (!this.timers.has(rec)) {
      const t = setTimeout(() => this.send(rec), wait);
      t.unref?.();
      this.timers.set(rec, t);
    }
  }

  send(rec) {
    clearTimeout(this.timers.get(rec));
    this.timers.delete(rec);
    this.sent.set(rec, this.now());
    this.emit({ type: 'trace', log: this.name, item: rec });
  }

  forget(rec) {
    clearTimeout(this.timers.get(rec));
    this.timers.delete(rec);
    this.sent.delete(rec);
  }

  list() {
    return this.items;
  }

  clear() {
    for (const rec of this.items) this.forget(rec);
    this.items = [];
    this.emit({ type: 'trace', log: this.name, cleared: true });
  }
}
