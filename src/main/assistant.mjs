// The assistant: one model, in a group chat of three. The user says something (heard or typed),
// shown as "@<the model> …"; the model answers, addressed: "@user …" is said aloud as it's
// written, "@peter …" goes to Peter (a tone plays; it's never said). Peter's answer comes back in
// the same chat, "@<the model> …", and goes to the model at once, as if the user had answered;
// and so does what Peter sends by himself (a run he took on is over, something scheduled is due).
// The model answers until it has nothing more for Peter. A run Peter takes on doesn't hold the
// conversation up. Everything can be cancelled: the model mid-answer, a run waiting for its click
// or running. No Electron in here, so it's tested on its own.

import fs from 'node:fs';
import path from 'node:path';
import { addressed, isSilent, looksLikeCall, maySayNothing, messages, sayable, withoutAsides, words } from './calls.mjs';
import { NOTE, claimsInability, handleOf, peterMessage, promisesWork, systemPrompt, userMessage } from './prompt.mjs';
import { asksHow, troubled } from './peter.mjs';

const MAX_ROUNDS = 10; // messages to Peter for one request
const KEEP_LOG = 300; // chat entries kept
const KEEP_MESSAGES = 40; // messages the model sees, at most
const KEEP_CHARS = 32_000; // and their length, at most (the system prompt comes on top)
const WAITING_REMINDER = 20_000; // a card unclicked this long: said once
const KEEP_REPLY = 600; // a reply of Peter's from an earlier request, at most
/** Peter's log states, as a message to him shows them. */
const RUN_STATE = { waiting: 'waiting', running: 'running', worked: 'done', answered: 'done', done: 'done', failed: 'failed', denied: 'failed', not_answered: 'failed', could_not_start: 'failed', withdrawn: 'cancelled', stopped: 'cancelled' };

export class Assistant {
  /**
   * @param {object} o
   * @param {import('./model.mjs').Ollama} o.model
   * @param {import('./peter.mjs').Peter} o.peter
   * @param {import('./notes.mjs').Notes} [o.notes] - the user's standing instructions and its playbook, in its space in Storage Spaces
   * @param {() => object} o.character - the character now (its name, looks)
   * @param {(text: string) => void} o.speak - says a sentence (or a few) in the character's voice
   * @param {() => void} o.stopSpeaking
   * @param {(which: 'to-peter'|'from-peter') => void} [o.tone] - the sound of a message to Peter, or from him
   * @param {(ev: object) => void} [o.emit]
   * @param {string|null} [o.file] - where the chat is kept
   * @param {() => number} [o.now]
   */
  constructor({ model, peter, notes = null, character, speak, stopSpeaking, tone = () => {}, emit = () => {}, file = null, now = Date.now }) {
    Object.assign(this, { model, peter, notes, character, speak, stopSpeaking, tone, emit, file, now });
    this.history = []; // what the model sees: { role, content }
    this.log = []; // what the chat shows: entries
    this.inbox = []; // what's come in and not been answered: { text, how, at, entry }
    this.turn = null; // the request being worked on
    this.nextId = 1;
    this.lastError = { code: null, at: 0 };
    this.saveTimer = null;
    this.load();
  }

  /** The model's name in the chat ("qwen3"): what the user and Peter address. */
  get handle() {
    return handleOf(this.model.current().model || this.model.picked || '');
  }

  // ---------------------------------------------------------------- what comes in

  /**
   * Something for the assistant: what the user said or typed, or what Peter sent by himself (a
   * run over, something scheduled due). What the user says while it's thinking (and nothing's
   * been said or done yet) is asked together with what came before; otherwise it waits its turn.
   * Peter's messages never wait on the user: they're answered as soon as the model is free.
   * @param {string} text
   * @param {{how?: 'said'|'typed'|'api'|'peter', at?: number}} [o]
   */
  say(text, { how = 'typed', at = this.now() } = {}) {
    const t = String(text ?? '').trim();
    if (!t) return null;
    const peter = how === 'peter';
    const entry = peter ? this.add({ kind: 'peter', text: t, from: 'Peter', to: this.handle, news: true }) : this.add({ kind: 'user', text: t, how, from: 'You', to: this.handle, queued: !!this.turn });
    this.inbox.push({ text: t, how, at, entry });
    const turn = this.turn;
    if (turn && !peter && !turn.toolRunning && !turn.calls) {
      // Mid-answer, nothing done yet: what was being said gives way to what's just been said.
      turn.interrupted = true;
      turn.ctrl.abort();
      if (turn.spoke) this.stopSpeaking();
    }
    this.pump();
    return entry;
  }

  /**
   * What Peter sends by himself (a run he took on is over, something scheduled is due): the
   * messages to him it's about are brought up to date, a tone plays, and the model is told.
   * @param {string} text - what Peter says ("Meanwhile: the nightly backup finished…")
   * @param {Array<{number: number, state: string, result?: string}>} [entries] - the requests it's about, as his log has them
   */
  news(text, entries = []) {
    this.followed(entries);
    this.tone('from-peter');
    return this.say(text, { how: 'peter' });
  }

  /** Stops everything: the model, Peter's runs (taken off the Mac, or stopped), the voice, what's waiting. */
  cancel() {
    const open = this.log.filter((e) => e.kind === 'to-peter' && e.number && ['waiting', 'running'].includes(e.state));
    for (const e of open) this.stopRun(e);
    const had = !!this.turn || this.inbox.length > 0 || open.length > 0;
    for (const item of this.inbox) this.update(item.entry, { queued: false, dropped: true });
    this.inbox = [];
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
      phase: t ? (t.toolRunning ? 'tool' : 'thinking') : 'idle',
      queued: this.inbox.length,
      /** Runs on the Mac it asked Peter for that aren't over yet (waiting for Run, or running): it waits on them. */
      pending: this.log.filter((e) => e.kind === 'to-peter' && e.number && ['waiting', 'running'].includes(e.state)).length,
      tool: t?.toolEntry ? { id: t.toolEntry.id, name: 'Peter', state: t.toolEntry.state } : null,
      model: this.model.current().model || this.model.picked || '',
      handle: this.handle,
      error: this.lastError.code && this.now() - this.lastError.at < 120_000 ? this.lastError.message : null,
    };
  }

  // ---------------------------------------------------------------- the turns

  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.inbox.length) {
        // Peter's message is a request of its own; what the user said, all together.
        const own = (x) => x.how === 'peter';
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
    const model = this.model.current().model || this.model.picked || '';
    const content = batch.map((b) => (b.how === 'peter' ? peterMessage(b.text, { at: b.at, model }) : userMessage(b.text, { at: b.at, how: b.how, model }))).join('\n');
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
          // Addressed to no one: taken as the user's, and kept as it should have been written, so the
          // model sees itself saying who each answer is to.
          if (said && !addressed(answer.text)) this.history[this.history.length - 1] = { role: 'assistant', content: `@user ${answer.text.trim()}` };
          break;
        }
        this.finishWords(answer, said);
        const m = found[0];
        const { text, failed, cancelled } = await this.ask(turn, m);
        if (turn.cleared) break;
        rounds++;
        // Peter's answer goes to the model as the user's do: a message in the chat. The app's notes
        // follow it, each a message of its own (so folding his answer later never cuts one).
        this.history.push({ role: 'user', content: peterMessage(text, { at: this.now(), model }) });
        if (found.length > 1) this.history.push({ role: 'user', content: NOTE.onlyFirst() });
        if (failed && !cancelled && turn.failures <= 2) this.history.push({ role: 'user', content: NOTE.review });
        if (rounds >= MAX_ROUNDS) this.history.push({ role: 'user', content: NOTE.outOfRounds(MAX_ROUNDS) });
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
          // Nothing said or done yet: asked again with what came after it, as one request. Peter's
          // news waits behind what the user has just said, so the user is answered first.
          this.history.length = mark;
          if (batch.every((b) => b.how === 'peter')) this.inbox.push(...batch);
          else this.inbox.unshift(...batch);
          for (const item of batch) this.update(item.entry, { queued: true });
        } else if (turn.cancelled) {
          this.history.push({ role: 'user', content: 'Note from the app (not the user, not Peter): the user cancelled that request; drop it unless they ask again.' });
          this.add({ kind: 'note', text: 'Cancelled.' });
        } else {
          this.history.push({ role: 'user', content: 'Note from the app (not the user, not Peter): the user cut in, so the rest of that answer was neither said nor done.' });
        }
      } else {
        this.failed(err);
        this.history.length = mark; // the question is asked again next time, with what follows
        this.history.push({ role: 'user', content }, { role: 'assistant', content: `@user (I couldn't answer: ${err.message})` });
      }
    } finally {
      this.turn = null;
      this.trim();
      this.save();
      this.emitState();
    }
  }

  /** The model's answer, streamed: its words to the user are said sentence by sentence as they come. */
  async answer(turn) {
    // Once a request, at once: the standing instructions and its playbook, read fresh from its
    // space in Storage Spaces (Peter writes them, when it asks him to).
    if (!turn.read) {
      turn.read = true;
      await this.notes?.refresh({ signal: turn.ctrl.signal }).catch(() => {});
    }
    const system = systemPrompt({ character: this.character(), model: this.model.current().model || this.model.picked || '', peter: this.peter.health, notes: this.notes, now: this.now() });
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
        if (!out.entry) out.entry = this.add({ kind: 'assistant', text: shown, from: this.handle, to: 'user', streaming: !final });
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

  /** What the harness tells the model when its answer has words and no message where one was due. */
  nudgeFor(turn, text, said) {
    const once = (key, note) => (turn.nudged.has(key) ? null : (turn.nudged.add(key), note));
    if (looksLikeCall(text)) return once('json', NOTE.json);
    if (!turn.calls && !isSilent(said) && promisesWork(said) && !/\?\s*$/.test(said)) return once('promised', NOTE.promised);
    if (!turn.calls && this.peter.health.reachable && claimsInability(said)) return once('cannot', NOTE.cannot);
    return null;
  }

  // ---------------------------------------------------------------- Peter

  /** Sends one message to Peter: { text, failed, cancelled }, his answer for the model. */
  async ask(turn, m) {
    turn.calls++;
    const entry = this.add({ kind: 'to-peter', text: m.text, from: this.handle, to: 'peter', state: 'working', startedAt: this.now() });
    turn.toolEntry = entry;
    this.emitState();
    let text;
    let failed = false;
    let outcome = '';
    try {
      if (!m.text) {
        text = NOTE.empty();
        failed = true;
      } else {
        this.tone('to-peter');
        turn.toolRunning = true;
        this.emitState();
        const started = this.now();
        try {
          ({ text, failed, outcome = '' } = await this.peter.say(m.text, { signal: turn.ctrl.signal }));
        } finally {
          turn.toolRunning = false;
        }
        if (!turn.ctrl.signal.aborted) this.tone('from-peter');
        // "How would I ask you to …?": the way to ask was what was wanted, nothing done is right.
        if (failed && outcome !== 'error' && asksHow(m.text)) failed = false;
        // A run asked for: its message follows it on the Mac (waiting for Run, running, over). Peter
        // says so in his outcome; one too old to say it, in his words.
        if (!failed && (outcome === 'asked' || (!outcome && /\bAsked for\b/i.test(text)))) await this.follow(entry, started);
      }
    } catch (err) {
      text = `It didn't work: ${err.message || err}`;
      failed = true;
    }
    const cancelled = turn.ctrl.signal.aborted;
    if (failed && !cancelled) turn.failures++;
    if (!entry.number || cancelled) this.update(entry, { state: cancelled ? 'cancelled' : failed ? 'failed' : 'done', endedAt: this.now() });
    if (!cancelled && !turn.cleared) this.add({ kind: 'peter', text, from: 'Peter', to: this.handle, failed });
    turn.toolEntry = null;
    this.emitState();
    return { text, failed, cancelled };
  }

  /**
   * A run Peter took on: the message is tied to it in his log (asked since `since`), shown
   * waiting or running, and if it's still waiting for its click a while later, the user is told once.
   */
  async follow(entry, since) {
    const entries = await this.peter.log();
    const mine = entries.find((x) => x.waits_for_the_mac && ['waiting', 'running'].includes(x.state) && Date.parse(x.asked) >= since - 2000 && !this.log.some((e) => e.number === x.number));
    if (!mine) return;
    this.update(entry, { number: mine.number, state: RUN_STATE[mine.state] });
    if (mine.state !== 'waiting') return;
    const timer = setTimeout(async () => {
      if (entry.state !== 'waiting') return;
      const now = (await this.peter.log()).find((x) => x.number === entry.number);
      this.followed(now ? [now] : []);
      if (now?.state === 'waiting') this.speak("It's waiting for you to click Run on your Mac.");
    }, WAITING_REMINDER);
    timer.unref?.();
  }

  /** Messages to Peter brought up to date from his log: [{ number, state }]. */
  followed(entries = []) {
    for (const x of entries) {
      const e = this.log.find((y) => y.kind === 'to-peter' && y.number === x.number);
      const state = RUN_STATE[x.state];
      if (!e || !state) continue;
      this.update(e, { state, ...(['waiting', 'running'].includes(state) ? {} : { endedAt: this.now() }) });
    }
    this.emitState();
  }

  /** A run Peter followed, called off: taken off the Mac while it waits, stopped while it runs. */
  async stopRun(e) {
    const said = await this.peter.stop(e.number);
    this.update(e, { state: 'cancelled', endedAt: this.now() });
    this.add({ kind: 'note', text: `Cancelled: ${said}` });
    this.emitState(); // one less to wait on
    return said;
  }

  /** Cancels one message to Peter (its Cancel in the chat): the one being answered, or a run he followed. */
  cancelTool(id) {
    const t = this.turn;
    if (t?.toolEntry && (!id || t.toolEntry.id === id)) {
      this.cancel();
      return true;
    }
    const e = this.log.find((x) => x.id === id && x.kind === 'to-peter' && x.number && ['waiting', 'running'].includes(x.state));
    if (!e) return false;
    this.stopRun(e);
    return true;
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
   * Peter's side of earlier requests, folded: a long answer is cut short. What the model reads
   * later is what was asked and what came of it. (The request at hand is left as it is.)
   */
  fold() {
    this.history = this.history.map((m) => {
      const head = m.content.match(/^\[Peter, [^\]]*\] @\S+ /);
      if (m.role !== 'user' || !head) return m;
      const body = m.content.slice(head[0].length);
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
    // It starts with something said to the model, not halfway through an exchange.
    while (h.length && h[0].role !== 'user') h = h.slice(1);
    this.history = h;
  }

  load() {
    if (!this.file) return;
    try {
      const o = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.history = Array.isArray(o.history) ? o.history.filter((m) => m && typeof m.content === 'string') : [];
      // Entries of an older version (cards of tools, the Clock) are shown as they now are.
      this.log = (Array.isArray(o.log) ? o.log.filter((e) => e && e.id) : []).map((e) => (e.kind === 'tool' ? { ...e, kind: 'to-peter', text: e.said || e.name || '' } : e.kind === 'news' || e.kind === 'schedule' ? { ...e, kind: 'peter' } : e));
      for (const e of this.log) {
        if (e.kind === 'to-peter' && !['done', 'failed', 'cancelled'].includes(e.state)) e.state = 'cancelled';
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
}

/** What the chat shows of the model's words: asides in brackets and [tags] taken out (emojis stay). */
export function display(text) {
  return withoutAsides(text)
    .replace(/\[(mood|expression|face|gesture|hand|hands|head|pose)\s*[:=][^\]\n]{1,30}\]/gi, '')
    .replace(/\[(nod|shake|shrug|wave|thumbup|thumbdown|ok|index|side|namaste|handup|yes|no|smile|grin|wink|thinking|happy|sad|angry|love|fear|neutral|warm|laughing|playful|frown|pensive|shocked|delighted|beaming|starstruck|adoring)\]/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Peter's answer says it didn't go (re-exported for the tests). */
export { troubled };
