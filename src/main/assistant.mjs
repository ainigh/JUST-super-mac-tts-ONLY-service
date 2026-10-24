// The assistant: one model, one conversation, tools. What the user says (heard or typed) and what
// comes due on the schedule become messages; the model answers, its words are said as they're
// written, and a tool call in its answer is run (here, or over Tool Mac Tool Run) and the result
// handed back, until it answers in words. Everything can be cancelled: the model mid-answer, a
// run waiting for its click or running. No Electron in here, so it's tested on its own.

import fs from 'node:fs';
import path from 'node:path';
import { calls, isSilent, looksBroken, maySayNothing, sayable, withoutAsides, words } from './calls.mjs';
import { PLAYBOOK, THE_USER } from './notes.mjs';
import { NOTE, LOCAL_TOOLS, canonical, claimsInability, promisesWork, systemPrompt, toolResult, userMessage } from './prompt.mjs';
import * as scheduleTools from './scheduler.mjs';

const MAX_ROUNDS = 10; // tool calls for one request
const KEEP_LOG = 300; // chat entries kept
const KEEP_MESSAGES = 40; // messages the model sees, at most
const KEEP_CHARS = 32_000; // and their length, at most (the system prompt comes on top)
const WAITING_REMINDER = 20_000; // a card unclicked this long: said once

export class Assistant {
  /**
   * @param {object} o
   * @param {import('./model.mjs').Ollama} o.model
   * @param {import('./toolrun.mjs').ToolRun} o.toolrun
   * @param {import('./scheduler.mjs').Scheduler} o.scheduler
   * @param {import('./notes.mjs').Notes} o.notes - what it has learned, kept in Tool Mac Tool Run
   * @param {() => object} o.character - the character now (its name, looks)
   * @param {(text: string) => void} o.speak - says a sentence (or a few) in the character's voice
   * @param {() => void} o.stopSpeaking
   * @param {(ev: object) => void} [o.emit]
   * @param {string|null} [o.file] - where the chat is kept
   * @param {import('./trace.mjs').Trace} [o.trace] - where each tool call is noted, with what it sent and got
   * @param {() => number} [o.now]
   */
  constructor({ model, toolrun, scheduler, notes, character, speak, stopSpeaking, emit = () => {}, file = null, trace = null, now = Date.now }) {
    Object.assign(this, { model, toolrun, scheduler, notes, character, speak, stopSpeaking, emit, file, trace, now });
    this.history = []; // what the model sees: { role, content }
    this.log = []; // what the chat shows: entries
    this.inbox = []; // what's come in and not been answered: { text, how, at, entry }
    this.turn = null; // the request being worked on
    this.reflecting = null;
    this.nextId = 1;
    this.lastError = { code: null, at: 0 };
    this.saveTimer = null;
    this.load();
  }

  // ---------------------------------------------------------------- what comes in

  /**
   * Something for the assistant: what the user said or typed, or a scheduled task coming due.
   * Said while it's thinking, it's asked together with what came before (a second thought); while
   * a tool runs, it waits its turn.
   * @param {string} text
   * @param {{how?: 'said'|'typed'|'scheduled'|'api', at?: number}} [o]
   */
  say(text, { how = 'typed', at = this.now() } = {}) {
    const t = String(text ?? '').trim();
    if (!t) return null;
    const entry = this.add({ kind: how === 'scheduled' ? 'schedule' : 'user', text: t, how, queued: !!this.turn });
    this.inbox.push({ text: t, how, at, entry });
    this.reflecting?.abort();
    if (this.turn && !this.turn.toolRunning && how !== 'scheduled') {
      // Mid-answer: what was being said gives way to what's just been said.
      this.turn.interrupted = true;
      this.turn.ctrl.abort();
      if (this.turn.spoke) this.stopSpeaking();
    }
    this.pump();
    return entry;
  }

  /** Stops everything: the model, any tool (its card taken away, or its run stopped), the voice, what's waiting. */
  cancel() {
    const had = !!this.turn || this.inbox.length > 0;
    for (const item of this.inbox) this.update(item.entry, { queued: false, dropped: true });
    this.inbox = [];
    this.reflecting?.abort();
    if (this.turn) {
      this.turn.cancelled = true;
      this.turn.ctrl.abort();
    }
    this.stopSpeaking();
    return had;
  }

  /** Starts a fresh conversation (the chat window keeps what was said, behind a line). */
  newChat() {
    this.cancel();
    this.history = [];
    this.add({ kind: 'divider', text: 'New chat' });
    this.save();
  }

  /** Clears the chat: the conversation and all the window shows of it (what it has learned stays). */
  clear() {
    if (this.turn) this.turn.cleared = true;
    this.cancel();
    this.history = [];
    this.log = [];
    this.emit({ type: 'cleared' });
    this.save();
  }

  get busy() {
    return !!this.turn;
  }

  state() {
    const t = this.turn;
    return {
      busy: !!t,
      phase: t ? (t.toolRunning ? 'tool' : 'thinking') : this.reflecting ? 'learning' : 'idle',
      queued: this.inbox.length,
      tool: t?.toolEntry ? { id: t.toolEntry.id, name: t.toolEntry.name, state: t.toolEntry.state } : null,
      model: this.model.current().model || this.model.picked || '',
      error: this.lastError.code && this.now() - this.lastError.at < 120_000 ? this.lastError.message : null,
    };
  }

  // ---------------------------------------------------------------- the turns

  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.inbox.length) {
        // A scheduled task is a request of its own; what the user said, all together.
        const first = this.inbox[0];
        const batch = first.how === 'scheduled' ? this.inbox.splice(0, 1) : this.inbox.splice(0, this.inbox.findIndex((x) => x.how === 'scheduled') >>> 0);
        for (const item of batch) this.update(item.entry, { queued: false });
        await this.work(batch);
      }
    } finally {
      this.pumping = false;
      this.emitState();
    }
  }

  /** One request, to its answer: model, tools, model… */
  async work(batch) {
    const turn = { ctrl: new AbortController(), batch, calls: 0, failures: 0, spoke: false, nudged: new Set(), toolRunning: false, toolEntry: null };
    this.turn = turn;
    const content = batch.length === 1 ? userMessage(batch[0].text, batch[0]) : batch.map((b) => userMessage(b.text, b)).join('\n');
    const mark = this.history.length;
    this.history.push({ role: 'user', content });
    this.emitState();
    let rounds = 0;
    try {
      for (;;) {
        const answer = await this.answer(turn);
        const found = calls(answer.text);
        const said = words(answer.text);
        this.history.push({ role: 'assistant', content: answer.text });
        if (!found.length) {
          const nudge = this.nudgeFor(turn, answer.text, said);
          if (nudge) {
            this.retract(answer);
            this.history.push({ role: 'user', content: nudge });
            continue;
          }
          this.finishWords(answer, said);
          break;
        }
        this.finishWords(answer, said);
        const call = canonical(found[0], this.toolrun.catalog);
        let { text, failed, cancelled } = await this.execute(turn, call);
        if (turn.cleared) break;
        if (found.length > 1) text += `\n\n${NOTE.onlyFirst(call.name, found.slice(1).map((c) => c.name))}`;
        rounds++;
        if (failed && !cancelled && turn.failures <= 2) text += `\n\n${NOTE.review}`;
        if (rounds >= MAX_ROUNDS) text += `\n\n${NOTE.outOfRounds(MAX_ROUNDS)}`;
        this.history.push({ role: 'user', content: toolResult(call.name, text) });
        if (cancelled) {
          this.add({ kind: 'note', text: 'Cancelled.' });
          break;
        }
        if (rounds > MAX_ROUNDS) break;
      }
      this.lastError = { code: null, at: 0 };
    } catch (err) {
      if (turn.cleared) {
        // The chat was cleared under it: nothing of this request stays.
      } else if (turn.ctrl.signal.aborted) {
        if (turn.interrupted && !turn.cancelled && !turn.spoke && !turn.calls) {
          // Nothing said or done yet: asked again with what came after it, as one request.
          this.history.length = mark;
          this.inbox.unshift(...batch);
          for (const item of batch) this.update(item.entry, { queued: true });
        } else if (turn.cancelled) {
          this.history.push({ role: 'user', content: 'Note from the Mac (not the user): the user cancelled that request; drop it unless they ask again.' });
          this.add({ kind: 'note', text: 'Cancelled.' });
        } else {
          this.history.push({ role: 'user', content: 'Note from the Mac (not the user): the user cut in, so the rest of that answer was neither said nor done.' });
        }
      } else {
        this.failed(err);
        this.history.length = mark; // the question is asked again next time, with what follows
        this.history.push({ role: 'user', content }, { role: 'assistant', content: `(I couldn't answer: ${err.message})` });
      }
    } finally {
      this.turn = null;
      this.trim();
      this.save();
      this.emitState();
    }
    if (!turn.ctrl.signal.aborted && (turn.failures > 0 || turn.calls >= 2) && !this.inbox.length) this.reflect();
  }

  /** The model's answer, streamed: its words are said sentence by sentence as they come. */
  async answer(turn) {
    // Once a request, both at once: what the mind has on what's being said, and the scripts and
    // routes that fit it (the rest are only named), given to the model with its instructions.
    if (!turn.context) {
      const asked = turn.batch.map((b) => b.text).join('\n');
      const signal = turn.ctrl.signal;
      // Its playbook, the standing instructions and what MEMORY has on the user, read fresh too.
      [turn.context, turn.matches] = await Promise.all([this.toolrun.context(this.recent(), { signal }), this.toolrun.matches(asked, { signal }), this.notes?.refresh({ signal })]);
    }
    const system = systemPrompt({ character: this.character(), catalog: this.toolrun.catalog, notes: this.notes, context: turn.context, matches: turn.matches, now: this.now() });
    const messages = [{ role: 'system', content: system }, ...this.history];
    const out = { text: '', spokenTo: 0, entry: null, spokenAny: false };
    const flush = (final) => {
      const prose = sayable(out.text, { final });
      if (!final && maySayNothing(prose)) return; // "nothing" may be on its way
      if (isSilent(prose) || isSilent(words(out.text))) return;
      let upTo = out.spokenTo;
      if (final) upTo = prose.length;
      else {
        // A sentence is said once the next has begun (so an emoji or [tag] after it goes with it).
        const re = /(?:[.!?…]+["'”’)\]]*\s+|\n+)(?=[\p{L}\p{N}"'“‘(])/gu;
        re.lastIndex = out.spokenTo;
        for (let m; (m = re.exec(prose)); ) upTo = m.index + m[0].length;
      }
      const piece = prose.slice(out.spokenTo, upTo);
      out.spokenTo = upTo;
      if (/[\p{L}\p{N}]/u.test(piece)) {
        this.speak(piece.trim());
        out.spokenAny = true;
        turn.spoke = true;
      }
      const shown = display(final ? words(out.text) : prose);
      if (shown) {
        if (!out.entry) out.entry = this.add({ kind: 'assistant', text: shown, streaming: !final });
        else if (out.entry.text !== shown || final) this.update(out.entry, { text: shown, streaming: !final });
      }
    };
    out.text = await this.model.chat(messages, {
      signal: turn.ctrl.signal,
      onText: (t) => {
        out.text = t;
        flush(false);
      },
    });
    out.flush = flush;
    return out;
  }

  /** The words of an answer, said and shown in full. */
  finishWords(answer, said) {
    answer.flush(true);
    if (answer.entry && !display(said)) this.update(answer.entry, { text: '', hidden: true, streaming: false });
  }

  /** An answer that's being asked again (it's nudged): not shown, and not said (if it can still be helped). */
  retract(answer) {
    if (answer.entry) this.update(answer.entry, { hidden: true, streaming: false });
  }

  /** The latest of the conversation, as said (no tool results, no notes from the Mac): what the mind is asked about. */
  recent() {
    return this.history
      .slice(-6)
      .filter((m) => !/^(Tool result for|Note from the Mac)/.test(m.content))
      .map((m) => (m.role === 'assistant' ? words(m.content) : m.content.replace(/^\[[^\]]*\]\s*/, '')))
      .filter(Boolean)
      .join('\n');
  }

  /** What the harness tells the model when its answer has words and no call where one was due. */
  nudgeFor(turn, text, said) {
    const once = (key, note) => (turn.nudged.has(key) ? null : (turn.nudged.add(key), note));
    if (looksBroken(text)) return once('broken', NOTE.broken);
    if (!turn.calls && !isSilent(said) && promisesWork(said) && !/\?\s*$/.test(said)) return once('promised', NOTE.promised);
    if (!turn.calls && this.toolrun.catalog.reachable && claimsInability(said)) return once('cannot', NOTE.cannot);
    return null;
  }

  // ---------------------------------------------------------------- tools

  async execute(turn, call) {
    turn.calls++;
    const args = call.arguments && typeof call.arguments === 'object' ? call.arguments : {};
    const entry = this.add({ kind: 'tool', name: call.name, args, state: 'working', startedAt: this.now(), output: '' });
    const log = this.trace?.open({ kind: 'tool', name: call.name, args, state: 'working', where: call.where });
    turn.toolEntry = entry;
    this.emitState();
    let text;
    let failed = false;
    try {
      if (call.where === 'local') {
        text = scheduleTools.runTool(this.scheduler, call.name, args, this.now());
        failed = /^(I couldn't|Say |That time|There are already|Nothing scheduled has)/.test(text);
      } else if (!this.toolrun.catalog.tools.length) {
        text = `${NOTE.unknownTool(call.name, this.toolrun.catalog)} (Tool Mac Tool Run isn't available: ${this.toolrun.catalog.error || 'not reached'}.)`;
        failed = true;
      } else {
        turn.toolRunning = true;
        this.emitState();
        // A card left unclicked is said once; a long run needs no words (the busy tone says it's working).
        let reminder = null;
        try {
          ({ text, failed } = await this.toolrun.run(call.name, args, {
            signal: turn.ctrl.signal,
            log,
            onStatus: (s) => {
              const patch = { state: s.state === 'done' ? 'done' : s.state, label: s.label || entry.label };
              if (s.request) patch.request = s.request;
              if (s.run) patch.run = s.run;
              if (s.output !== undefined) patch.output = s.output;
              if (s.state === 'waiting' && !reminder) {
                reminder = setTimeout(() => entry.state === 'waiting' && this.speak("It's waiting for you to click Run on your Mac."), WAITING_REMINDER);
              }
              this.update(entry, patch);
              this.emitState();
            },
          }));
        } finally {
          clearTimeout(reminder);
          turn.toolRunning = false;
        }
      }
    } catch (err) {
      text = `It didn't work: ${err.message || err}`;
      failed = true;
    }
    const cancelled = turn.ctrl.signal.aborted;
    if (failed && !cancelled) turn.failures++;
    this.update(entry, { state: cancelled ? 'cancelled' : failed ? 'failed' : 'done', result: text, endedAt: this.now() });
    this.trace?.change(log, { state: cancelled ? 'cancelled' : failed ? 'failed' : 'done', result: text, ms: this.now() - entry.startedAt }, { final: true });
    turn.toolEntry = null;
    this.emitState();
    return { text, failed, cancelled };
  }

  /** Cancels one tool (from its card in the chat): the request carries on with "cancelled" as its result. */
  cancelTool(id) {
    const t = this.turn;
    if (!t || !t.toolEntry || (id && t.toolEntry.id !== id)) return false;
    this.cancel();
    return true;
  }

  // ---------------------------------------------------------------- learning

  /** After a request that took work: a quiet moment to save what it taught (nothing is said). */
  async reflect() {
    const ctrl = new AbortController();
    this.reflecting = ctrl;
    this.emitState();
    try {
      const system = systemPrompt({ character: this.character(), catalog: this.toolrun.catalog, notes: this.notes, now: this.now() });
      const text = await this.model.chat([{ role: 'system', content: system }, ...this.history, { role: 'user', content: NOTE.reflect }], { signal: ctrl.signal, purpose: 'learning' });
      let learned = false;
      for (const c of calls(text).slice(0, 3)) {
        const call = canonical(c, this.toolrun.catalog);
        const what = learning(call);
        if (!what) continue; // only its playbook, and notes on the user, are written here
        const result = await this.toolrun.run(call.name, call.arguments, { signal: ctrl.signal });
        if (!result.failed) {
          learned = true;
          this.add({ kind: 'note', text: what });
        }
      }
      if (learned) await this.notes?.refresh();
    } catch {
      /* cut short, or no model: nothing learned this time */
    } finally {
      if (this.reflecting === ctrl) this.reflecting = null;
      this.emitState();
    }
  }

  // ---------------------------------------------------------------- the record

  failed(err) {
    const code = err.code || 'failed';
    const message = err.message || String(err);
    const repeat = this.lastError.code === code && this.now() - this.lastError.at < 60_000;
    this.lastError = { code, message, at: this.now() };
    this.add({ kind: 'error', text: message });
    if (!repeat) {
      this.speak(
        code === 'unreachable'
          ? "I can't reach my model. Is Ollama running?"
          : code === 'no_model'
            ? "There's no model for me to think with yet. The chat says how to get one."
            : "Sorry, my model didn't answer that time.",
      );
    }
  }

  add(entry) {
    const e = { id: `e${this.nextId++}`, at: this.now(), ...entry };
    this.log.push(e);
    if (this.log.length > KEEP_LOG) this.log.splice(0, this.log.length - KEEP_LOG);
    this.emit({ type: 'entry', entry: e });
    this.save();
    return e;
  }

  update(entry, patch) {
    if (!entry || !this.log.includes(entry)) return; // cleared away
    Object.assign(entry, patch);
    this.emit({ type: 'entry', entry });
    this.save();
  }

  emitState() {
    this.emit({ type: 'assistant', state: this.state() });
  }

  /** What the model sees is kept short enough for its context: the latest messages, old tool results cut. */
  trim() {
    let h = this.history.slice(-KEEP_MESSAGES);
    const total = () => h.reduce((n, m) => n + m.content.length, 0);
    for (let i = 0; i < h.length - 2 && total() > KEEP_CHARS; i++) {
      if (h[i].content.length > 1500) h[i] = { ...h[i], content: h[i].content.slice(0, 1500) + '… (cut short)' };
    }
    while (total() > KEEP_CHARS && h.length > 2) h = h.slice(1);
    // It starts with something the user said, not halfway through an exchange.
    while (h.length && h[0].role !== 'user') h = h.slice(1);
    this.history = h;
  }

  load() {
    if (!this.file) return;
    try {
      const o = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.history = Array.isArray(o.history) ? o.history.filter((m) => m && typeof m.content === 'string') : [];
      this.log = Array.isArray(o.log) ? o.log.filter((e) => e && e.id) : [];
      for (const e of this.log) {
        if (e.kind === 'tool' && !['done', 'failed', 'cancelled'].includes(e.state)) e.state = 'cancelled';
        delete e.streaming;
        delete e.queued;
      }
      this.nextId = Math.max(1, ...this.log.map((e) => Number(String(e.id).slice(1)) + 1 || 1));
    } catch {
      /* a first chat */
    }
  }

  save() {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify({ history: this.history, log: this.log }));
      } catch (err) {
        console.error('Super Face: the chat was not saved:', err.message);
      }
    }, 1000);
    this.saveTimer.unref?.();
  }

  /** The tools there are, for the chat's list: built in, Tool Mac Tool Run's, and the user's scripts and flows. */
  tools() {
    const c = this.toolrun.catalog;
    return {
      builtin: LOCAL_TOOLS.map((t) => ({ name: t.name, description: t.description, args: (t.args || []).map(([n, d]) => ({ name: n, about: d })) })),
      mac: c.tools.map((t) => ({ name: t.name, description: t.description, asks: t.asks, args: t.args.map((a) => ({ name: a.name, about: a.about })) })),
      scripts: c.scripts,
      flows: c.flows,
      reachable: c.reachable && !c.error,
      folder: c.folder,
      error: c.error,
      fetched: c.fetched,
    };
  }
}

/** What the chat shows of the model's words: asides in brackets and [tags] taken out (emojis stay). */
export function display(text) {
  return withoutAsides(text)
    .replace(/\[(mood|expression|face|gesture|hand|hands|head|pose)\s*[:=][^\]\n]{1,30}\]/gi, '')
    .replace(/\[(nod|shake|shrug|wave|thumbup|thumbdown|ok|index|side|namaste|handup|yes|no|smile|grin|wink|thinking|happy|sad|angry|love|fear|neutral|warm|laughing|playful|frown|pensive|shocked|delighted|beaming|starstruck|adoring)\]/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** What a call made while it reflects saves, said for the chat; null when it isn't one it may make then. */
function learning(call) {
  const a = call.arguments || {};
  if (call.name === 'library' && String(a.name ?? '').trim().toLowerCase() === PLAYBOOK.toLowerCase()) {
    const op = String(a.op ?? '').toLowerCase();
    if (op === 'append') return `Learned: ${String(a.text ?? '').replace(/^-\s*/, '').trim()}`;
    if (op === 'write') return 'Rewrote its playbook.';
  }
  if (call.name === 'remember' && String(a.about ?? '').trim().toLowerCase() === THE_USER) {
    const notes = (Array.isArray(a.notes) ? a.notes : [a.notes ?? a.text]).filter(Boolean).map((n) => String(n).replace(/^pref\s+/, ''));
    return `Learned about you: ${notes.join('; ')}`;
  }
  return null;
}
