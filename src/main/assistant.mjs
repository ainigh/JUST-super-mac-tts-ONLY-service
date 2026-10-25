// The assistant: one model, one conversation, and two to ask: Peter (Tool Mac Tool Run, in words)
// and the Clock (the schedule). What the user says (heard or typed), what comes due on the
// schedule and Peter's news (a run it asked for is over) become messages; the model answers, its
// words are said as they're written, and a message to Peter or the Clock at the end of its answer
// is sent and the answer handed back, until it answers in words. A run Peter takes on doesn't
// hold the conversation up: it's followed on its card, and its news comes in when it's over.
// Everything can be cancelled: the model mid-answer, a run waiting for its click or running. No
// Electron in here, so it's tested on its own.

import fs from 'node:fs';
import path from 'node:path';
import { isSilent, looksLikeCall, maySayNothing, messages, sayable, withoutAsides, words } from './calls.mjs';
import { PLAYBOOK, THE_USER } from './notes.mjs';
import { HELPERS, NOTE, claimsInability, newsMessage, promisesWork, reply, systemPrompt, userMessage } from './prompt.mjs';
import { clockSay } from './scheduler.mjs';
import { troubled } from './toolrun.mjs';

const MAX_ROUNDS = 10; // messages to Peter and the Clock for one request
const KEEP_LOG = 300; // chat entries kept
const KEEP_MESSAGES = 40; // messages the model sees, at most
const KEEP_CHARS = 32_000; // and their length, at most (the system prompt comes on top)
const WAITING_REMINDER = 20_000; // a card unclicked this long: said once
const KEEP_REPLY = 600; // a reply of Peter's from an earlier request, at most (offers are folded to a line)
/** Peter's log states, as a card shows them. */
const CARD_STATE = { waiting: 'waiting', running: 'running', worked: 'done', answered: 'done', done: 'done', failed: 'failed', denied: 'failed', not_answered: 'failed', could_not_start: 'failed', withdrawn: 'cancelled', stopped: 'cancelled' };

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
   * @param {{how?: 'said'|'typed'|'scheduled'|'api'|'peter', at?: number}} [o]
   */
  say(text, { how = 'typed', at = this.now() } = {}) {
    const t = String(text ?? '').trim();
    if (!t) return null;
    const kind = how === 'scheduled' ? 'schedule' : how === 'peter' ? 'news' : 'user';
    const entry = this.add({ kind, text: t, how, queued: !!this.turn });
    this.inbox.push({ text: t, how, at, entry });
    this.reflecting?.abort();
    if (this.turn && !this.turn.toolRunning && kind === 'user') {
      // Mid-answer: what was being said gives way to what's just been said.
      this.turn.interrupted = true;
      this.turn.ctrl.abort();
      if (this.turn.spoke) this.stopSpeaking();
    }
    this.pump();
    return entry;
  }

  /**
   * Peter's news (Tool Mac Tool Run calls back when a run it was asked for is over): the cards
   * it's about are brought up to date, and the model is told, as a message of its own.
   * @param {string} text - what Peter says ("Meanwhile: the nightly backup finished…")
   * @param {Array<{number: number, state: string, result?: string}>} [entries] - the requests it's about, as his log has them
   */
  news(text, entries = []) {
    this.followed(entries);
    return this.say(text, { how: 'peter' });
  }

  /** Stops everything: the model, Peter's runs (their cards taken away, or stopped), the voice, what's waiting. */
  cancel() {
    const open = this.log.filter((e) => e.kind === 'tool' && e.number && ['waiting', 'running'].includes(e.state));
    for (const e of open) this.stopRun(e);
    const had = !!this.turn || this.inbox.length > 0 || open.length > 0;
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
        // A scheduled task, or Peter's news, is a request of its own; what the user said, all together.
        const own = (x) => x.how === 'scheduled' || x.how === 'peter';
        const first = this.inbox[0];
        const batch = own(first) ? this.inbox.splice(0, 1) : this.inbox.splice(0, this.inbox.findIndex(own) >>> 0);
        for (const item of batch) this.update(item.entry, { queued: false });
        await this.work(batch);
      }
    } finally {
      this.pumping = false;
      this.emitState();
    }
  }

  /** One request, to its answer: model, Peter, model… */
  async work(batch) {
    const turn = { ctrl: new AbortController(), batch, calls: 0, failures: 0, spoke: false, nudged: new Set(), toolRunning: false, toolEntry: null };
    this.turn = turn;
    const content = batch.map((b) => (b.how === 'peter' ? newsMessage(b.text, b.at) : userMessage(b.text, b))).join('\n');
    this.fold();
    const mark = this.history.length;
    this.history.push({ role: 'user', content });
    this.emitState();
    let rounds = 0;
    try {
      for (;;) {
        const answer = await this.answer(turn);
        const found = messages(answer.text);
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
        const m = found[0];
        let { text, failed, cancelled } = await this.ask(turn, m);
        if (turn.cleared) break;
        if (found.length > 1) text += `\n\n${NOTE.onlyFirst(m.to)}`;
        rounds++;
        if (failed && !cancelled && turn.failures <= 2) text += `\n\n${NOTE.review}`;
        if (rounds >= MAX_ROUNDS) text += `\n\n${NOTE.outOfRounds(MAX_ROUNDS)}`;
        this.history.push({ role: 'user', content: reply(m.to, text) });
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
    // Once a request, at once: what the mind has on what's being said, and Peter's templates that
    // fit it, given to the model with its instructions.
    if (!turn.context) {
      const asked = turn.batch.map((b) => b.text).join('\n');
      const signal = turn.ctrl.signal;
      // Its playbook, the standing instructions and what MEMORY has on the user, read fresh too.
      [turn.context, turn.forms] = await Promise.all([this.toolrun.context(this.recent(), { signal }), this.toolrun.forms(asked, { signal }), this.notes?.refresh({ signal })]);
    }
    const system = systemPrompt({ character: this.character(), catalog: this.toolrun.catalog, notes: this.notes, context: turn.context, forms: turn.forms, now: this.now() });
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

  /** The latest of the conversation, as said (no answers of Peter's, no notes from the Mac): what the mind is asked about. */
  recent() {
    return this.history
      .slice(-6)
      .filter((m) => !/^((Peter|Clock) \(to you|Note from the Mac)/.test(m.content))
      .map((m) => (m.role === 'assistant' ? words(m.content) : m.content.replace(/^\[[^\]]*\]\s*/, '')))
      .filter(Boolean)
      .join('\n');
  }

  /** What the harness tells the model when its answer has words and no message where one was due. */
  nudgeFor(turn, text, said) {
    const once = (key, note) => (turn.nudged.has(key) ? null : (turn.nudged.add(key), note));
    if (looksLikeCall(text)) return once('json', NOTE.json);
    if (!turn.calls && !isSilent(said) && promisesWork(said) && !/\?\s*$/.test(said)) return once('promised', NOTE.promised);
    if (!turn.calls && this.toolrun.catalog.reachable && claimsInability(said)) return once('cannot', NOTE.cannot);
    return null;
  }

  // ---------------------------------------------------------------- Peter and the Clock

  /** Sends one message (to Peter, or the Clock): { text, failed, cancelled }, the answer for the model. */
  async ask(turn, m) {
    turn.calls++;
    const name = m.to === 'clock' ? 'Clock' : 'Peter';
    const entry = this.add({ kind: 'tool', name, said: m.text, state: 'working', startedAt: this.now() });
    const log = this.trace?.open({ kind: 'tool', name: `@${m.to}`, args: { said: m.text }, state: 'working', where: m.to === 'clock' ? 'local' : 'mac' });
    turn.toolEntry = entry;
    this.emitState();
    let text;
    let failed = false;
    try {
      if (!m.text) {
        text = NOTE.empty(m.to);
        failed = true;
      } else if (m.to === 'clock') {
        text = clockSay(this.scheduler, m.text, this.now());
        failed = /^(I didn't understand|I couldn't|Say |That time|There are already|Nothing scheduled has)/.test(text);
      } else {
        turn.toolRunning = true;
        this.emitState();
        const started = this.now();
        try {
          ({ text, failed } = await this.toolrun.say(m.text, { signal: turn.ctrl.signal, log }));
        } finally {
          turn.toolRunning = false;
        }
        // A run asked for: its card follows it on the Mac (waiting for Run, running, over).
        if (!failed && /\bAsked for\b/.test(text)) await this.follow(entry, started);
      }
    } catch (err) {
      text = `It didn't work: ${err.message || err}`;
      failed = true;
    }
    const cancelled = turn.ctrl.signal.aborted;
    if (failed && !cancelled) turn.failures++;
    if (!entry.number || cancelled) this.update(entry, { state: cancelled ? 'cancelled' : failed ? 'failed' : 'done', result: text, endedAt: this.now() });
    else this.update(entry, { result: text });
    this.trace?.change(log, { state: cancelled ? 'cancelled' : failed ? 'failed' : 'done', result: text, ms: this.now() - entry.startedAt }, { final: true });
    turn.toolEntry = null;
    this.emitState();
    return { text, failed, cancelled };
  }

  /**
   * A run Peter took on: the card is tied to it in his log (asked since `since`), shown waiting or
   * running, and if it's still waiting for its click a while later, the user is told once.
   */
  async follow(entry, since) {
    const entries = await this.toolrun.sayLog();
    const mine = entries.find((x) => x.waits_for_the_mac && ['waiting', 'running'].includes(x.state) && Date.parse(x.asked) >= since - 2000 && !this.log.some((e) => e.number === x.number));
    if (!mine) return;
    this.update(entry, { number: mine.number, request: mine.request, state: CARD_STATE[mine.state] });
    if (mine.state !== 'waiting') return;
    const timer = setTimeout(async () => {
      if (entry.state !== 'waiting') return;
      const now = (await this.toolrun.sayLog()).find((x) => x.number === entry.number);
      this.followed(now ? [now] : []);
      if (now?.state === 'waiting') this.speak("It's waiting for you to click Run on your Mac.");
    }, WAITING_REMINDER);
    timer.unref?.();
  }

  /** Cards brought up to date from Peter's log: [{ number, state, result }]. */
  followed(entries = []) {
    for (const x of entries) {
      const e = this.log.find((y) => y.kind === 'tool' && y.number === x.number);
      const state = CARD_STATE[x.state];
      if (!e || !state) continue;
      this.update(e, { state, ...(x.result ? { output: String(x.result).slice(-4000) } : {}), ...(x.news ? { news: x.news } : {}), ...(['waiting', 'running'].includes(state) ? {} : { endedAt: this.now() }) });
    }
    this.emitState();
  }

  /** A run Peter followed, called off: taken off the Mac while it waits, stopped while it runs. */
  async stopRun(e) {
    const said = await this.toolrun.stopSay(e.number, { request: e.request });
    this.update(e, { state: 'cancelled', result: `${e.result ? `${e.result}\n\n` : ''}Cancelled: ${said}`, endedAt: this.now() });
    return said;
  }

  /** Cancels one card (its Cancel in the chat): the message being answered, or a run Peter followed. */
  cancelTool(id) {
    const t = this.turn;
    if (t?.toolEntry && (!id || t.toolEntry.id === id)) {
      this.cancel();
      return true;
    }
    const e = this.log.find((x) => x.id === id && x.kind === 'tool' && x.number && ['waiting', 'running'].includes(x.state));
    if (!e) return false;
    this.stopRun(e);
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
      for (const m of messages(text).slice(0, 2)) {
        const what = learning(m);
        if (!what) continue; // only its playbook, and notes on the user, are written here
        const result = await this.toolrun.say(m.text, { signal: ctrl.signal });
        if (!result.failed && !/^(These can do that|Did you mean|Fill in the blanks|That needs)/m.test(result.text)) {
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

  /**
   * Peter's side of earlier requests, folded: a list of templates he offered is a line of their
   * titles, a long answer is cut short. What the model reads later is what was asked and what came
   * of it, not the back and forth. (The request at hand is left as it is.)
   */
  fold() {
    this.history = this.history.map((m) => {
      const head = m.content.match(/^(Peter|Clock) \(to you; the user doesn't see this\):\n/);
      if (m.role !== 'user' || !head) return m;
      const body = m.content.slice(head[0].length);
      if (/^(These can do that|More that can do that|Fill in the blanks|The Clock takes|I didn't understand)/m.test(body)) {
        const titles = [...body.matchAll(/^\s*\d+\. ([^\n]+)$/gm)].map((x) => x[1].trim());
        const folded = titles.length ? `${head[1]} offered: ${titles.join(', ')}.` : `${head[1]} said what he takes.`;
        return { ...m, content: head[0] + folded };
      }
      if (body.length > KEEP_REPLY) return { ...m, content: `${head[0]}${body.slice(0, KEEP_REPLY)}… (cut short)` };
      return m;
    });
  }

  /** What the model sees is kept short enough for its context: the latest messages, old answers of Peter's cut. */
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

  /** Who it asks, and what they can do, for the chat's list: Peter and the Clock, Tool Mac Tool Run's tools, and the user's scripts and flows. */
  tools() {
    const c = this.toolrun.catalog;
    return {
      builtin: HELPERS.map((h) => ({ name: h.handle, description: h.description, args: [] })),
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

/**
 * What a message sent while it reflects saves, said for the chat; null when it isn't one it may
 * send then (only to Peter, and only about its playbook or about the user).
 */
export function learning(m) {
  if (m.to !== 'peter') return null;
  const lines = Object.fromEntries(
    String(m.text)
      .split('\n')
      .map((l) => l.match(/^\s*[-*]?\s*([A-Za-z][A-Za-z ]{0,20}?)\s*:\s*(.*)$/))
      .filter(Boolean)
      .map((x) => [x[1].trim().toLowerCase(), x[2].trim()]),
  );
  const title = String(m.text).split('\n')[0].trim().toLowerCase();
  if (String(lines.name ?? '').toLowerCase() === PLAYBOOK.toLowerCase()) {
    if (/^write/.test(title)) return 'Rewrote its playbook.';
    if (lines.text) return `Learned: ${lines.text.replace(/^-\s*/, '').trim()}`;
  }
  if (String(lines.about ?? '').toLowerCase() === THE_USER && lines.fact) return `Learned about you: ${lines.fact}`;
  return null;
}
