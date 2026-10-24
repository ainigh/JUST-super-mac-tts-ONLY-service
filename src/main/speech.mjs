// What's been asked to be said, and what has been: each utterance's state (queued, speaking, done,
// stopped, failed), callers waiting on one, the log of what was said and when (for the ears'
// "was that me?"), and the live events for /api/events. The renderer does the speaking; this is
// the record of it. No Electron in here, so it's tested on its own.

import { randomUUID } from 'node:crypto';
import { around, compare } from '../shared/echo.mjs';

const KEEP_RECORDS = 200;
const KEEP_SAID_MS = 5 * 60 * 1000;

export class Speech {
  /**
   * @param {object} o
   * @param {(type: string, data: object) => void} o.send - to the renderer
   * @param {() => number} [o.now]
   */
  constructor({ send, now = Date.now }) {
    this.send = send;
    this.now = now;
    /** @type {Map<string, object>} */ this.records = new Map();
    this.order = []; // ids still to finish, in order
    this.lines = []; // what was said: { id, text, start, end, source, who }
    this.waiters = new Map(); // id → [resolve]
    this.listeners = new Set();
    this.current = null; // the id being said
  }

  get speaking() {
    return this.current !== null;
  }

  get queued() {
    return this.order.length;
  }

  /** Queues `u` (already checked: text, voice, speed…): its record. */
  enqueue(u) {
    if (u.interrupt) this.stop();
    const id = u.id || randomUUID();
    const rec = { ...u, id, state: 'queued', queuedAt: this.now(), source: u.source || '', who: u.who || '' };
    delete rec.interrupt;
    this.records.set(id, rec);
    this.order.push(id);
    this.trim();
    this.send('speak', rec);
    this.emit({ type: 'queued', id, text: rec.text, source: rec.source, who: rec.who });
    return rec;
  }

  /** Resolves with the record once it's over (done, stopped, failed), or after `timeout` ms as it stands. */
  wait(id, timeout = 10 * 60 * 1000) {
    const rec = this.records.get(id);
    if (!rec) return Promise.resolve(null);
    if (isOver(rec.state)) return Promise.resolve(rec);
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(rec), timeout);
      const finish = (r) => {
        clearTimeout(timer);
        resolve(r);
      };
      if (!this.waiters.has(id)) this.waiters.set(id, []);
      this.waiters.get(id).push(finish);
    });
  }

  /** Stops what's said and queued (only `source`'s, when given): how many were dropped. */
  stop(source) {
    const ids = this.order.filter((id) => !source || this.records.get(id)?.source === source);
    if (!ids.length) return 0;
    this.send('stop', { ids });
    for (const id of ids) this.finish(id, 'stopped');
    return ids.length;
  }

  /** The renderer says how it's going. */
  event(e) {
    const rec = this.records.get(e.id);
    switch (e.type) {
      case 'started':
        if (!rec || isOver(rec.state)) return;
        rec.state = 'speaking';
        rec.startedAt = this.now();
        this.current = e.id;
        this.emit({ type: 'started', id: e.id, text: rec.text, source: rec.source, who: rec.who });
        break;
      case 'sentence': {
        const start = this.now();
        const line = { id: e.id, text: e.text, start, end: start + (e.duration || 0) * 1000, source: rec?.source || '', who: rec?.who || '' };
        this.lines.push(line);
        this.lines = this.lines.filter((l) => l.end > start - KEEP_SAID_MS);
        this.emit({ type: 'sentence', id: e.id, text: e.text, duration: e.duration, source: line.source, who: line.who });
        break;
      }
      case 'ended':
        this.finish(e.id, e.error ? 'failed' : 'done', e.error);
        break;
      default:
        this.emit(e);
    }
  }

  finish(id, state, error) {
    const rec = this.records.get(id);
    if (!rec || isOver(rec.state)) return;
    rec.state = state;
    rec.endedAt = this.now();
    if (error) rec.error = error;
    this.order = this.order.filter((x) => x !== id);
    if (this.current === id) this.current = null;
    // A line cut short ends now, not when it would have.
    if (state === 'stopped') for (const l of this.lines) if (l.id === id && l.end > rec.endedAt) l.end = rec.endedAt;
    for (const w of this.waiters.get(id) || []) w(rec);
    this.waiters.delete(id);
    this.emit({ type: state === 'done' ? 'ended' : state, id, source: rec.source, who: rec.who, ...(error ? { error } : {}) });
  }

  /** What was said in the last `seconds`. */
  said(seconds = 30) {
    const from = this.now() - seconds * 1000;
    return this.lines.filter((l) => l.end >= from);
  }

  /** Was `heard` (heard `seconds` long, ending at `at`) the voice coming back? */
  echo(heard, { at = this.now(), seconds = 10 } = {}) {
    const lines = around(this.lines, { at, seconds });
    const playing = this.current && this.records.get(this.current);
    const texts = lines.map((l) => l.text);
    // What's being said now counts in full (the line playing was logged as it started).
    const result = compare(heard, texts);
    return { ...result, speaking: !!playing, lines: lines.length };
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e) {
    const ev = { ...e, at: this.now() };
    for (const fn of this.listeners) {
      try {
        fn(ev);
      } catch {
        /* a listener gone wrong doesn't stop the others */
      }
    }
  }

  get(id) {
    return this.records.get(id) || null;
  }

  trim() {
    if (this.records.size <= KEEP_RECORDS) return;
    for (const [id, rec] of this.records) {
      if (this.records.size <= KEEP_RECORDS) break;
      if (isOver(rec.state)) this.records.delete(id);
    }
  }
}

export const isOver = (state) => state === 'done' || state === 'stopped' || state === 'failed';

/** An utterance as the API shows it. */
export function recordJSON(r) {
  if (!r) return null;
  const out = { id: r.id, state: r.state, text: r.text, voice: r.voice, source: r.source, who: r.who };
  if (r.error) out.error = r.error;
  if (r.startedAt && r.endedAt) out.seconds = Math.round((r.endedAt - r.startedAt) / 10) / 100;
  return out;
}
