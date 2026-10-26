// Everything but the windows: the assistant and what it works with (the model, and Peter, who does
// everything on the Mac and the web and keeps the schedule), what's heard and what's done with
// it, and the actions the chat window and the API share. The Electron main process and the
// browser dev server both build one.

import fs from 'node:fs';
import path from 'node:path';
import { Assistant } from './assistant.mjs';
import { Notes } from './notes.mjs';
import { Ollama } from './model.mjs';
import { Peter } from './peter.mjs';
import { NOTE, systemPrompt } from './prompt.mjs';
import { Trace } from './trace.mjs';
import { CHARACTERS, SIZES, characterOf, resolveCharacter } from '../shared/characters.mjs';
import { words } from '../shared/text.mjs';

/** Said alone, these stop it talking (and any answer still being written); a run carries on. */
const HUSH = /^(stop|stop talking|stop it|quiet|be quiet|hush|shush|shut up|silence|enough|that's enough|ok(ay)? stop|thanks,? stop)$/;
/** Said alone, these call off whatever it's doing: the answer, a run, what's waiting. */
const CANCEL = /^(cancel|cancel (it|that|this|everything|the run)|never ?mind|stop everything|stop (it|that) all|abort|forget it|forget about it|scratch that)$/;
const NEW_CHAT = /^(new chat|start over|start a new chat|fresh start|new conversation)$/;
/** Said alone, these wipe the chat: the conversation, and what the window shows of it. */
const CLEAR_CHAT = /^(clear (the )?(chat|conversation|screen)|clear it all)$/;
/** What speech recognition makes of a cough or a breath. */
const NOISE = new Set(['uh', 'um', 'umm', 'hmm', 'mm', 'mhm', 'ah', 'oh', 'eh', 'huh', 'you', 'the', 'a', 'thank you', 'bye']);
/** A phrase ending like this isn't over: the rest is waited for a moment. */
const UNFINISHED = /(\b(and|but|or|so|because|then|the|a|an|to|of|with|for|that|my|your|is|are|if|when|about|like)|,)\s*$/i;

const MAX_ERRORS = 200;

export function createCore({ settings, speech, dataDir, host = {}, fetch: f = globalThis.fetch, now = Date.now }) {
  const listeners = new Set();
  const errors = []; // what went wrong, newest last: { id, at, source, message, detail, count }
  let nextError = 1;
  const seenErrorEntries = new Set();
  const emit = (ev) => {
    // The assistant's own errors (no model, Ollama down…) go to the error log too.
    if (ev.type === 'entry' && ev.entry.kind === 'error' && !seenErrorEntries.has(ev.entry.id)) {
      seenErrorEntries.add(ev.entry.id);
      reportError({ source: 'model', message: ev.entry.text });
    }
    for (const fn of listeners) {
      try {
        fn(ev);
      } catch {
        /* one listener gone wrong doesn't stop the others */
      }
    }
  };
  const file = (name) => (dataDir ? path.join(dataDir, name) : null);
  const character = () => characterOf(settings.get().avatar);

  // What went to the model and came back: the Model tab.
  const traces = { model: new Trace({ name: 'model', keep: 40, emit, now }) };
  const model = new Ollama({ current: () => ({ url: settings.get().ollamaUrl, model: settings.get().model, think: settings.get().think }), fetch: f, trace: traces.model });
  // Peter (Tool Mac Agent), talked to in words; he says how a run went, and what's due, at POST /api/peter here.
  const peter = new Peter({ url: () => settings.get().peterUrl, replyTo: () => (settings.get().port ? `http://127.0.0.1:${settings.get().port}/api/peter` : null), fetch: f });
  // The user's standing instructions and its playbook: read from its own space in Storage Spaces
  // (Peter writes them, when the model asks him to keep something).
  const notes = new Notes({ url: () => settings.get().storageUrl, fetch: f });

  /** Says `text` in the character's voice; its face follows the words (and the cues in them). */
  function speakAs(text) {
    const c = character();
    const s = settings.get();
    host.show?.();
    return speech.enqueue({ text, voice: c.voice, speed: s.speed, auto: true, source: 'assistant', who: c.name });
  }

  const assistant = new Assistant({
    model,
    peter,
    notes,
    character,
    speak: speakAs,
    stopSpeaking: () => speech.stop('assistant'),
    // A message to Peter, or from him: a tone of its own each way (never his words).
    tone: (which) => emit({ type: 'tone', which }),
    emit,
    file: file('chat.json'),
    now,
  });

  // ---------------------------------------------------------------- hearing

  let ears = { state: 'off' };
  let held = null; // { text, at, timer }: a phrase that sounded unfinished

  /**
   * A phrase the ears wrote down. It's dropped when it's the character's own voice coming back
   * (what was heard is compared with what it said, word for word); said over the character, it
   * cuts in; "stop", "cancel" and "new chat" are done here; anything else goes to the assistant.
   */
  function heard({ text, at = now(), seconds = 0 }) {
    const t = String(text ?? '').replace(/\s+/g, ' ').trim();
    const w = words(t);
    if (!w.length || NOISE.has(w.join(' '))) return { dropped: 'noise' };
    const echo = speech.echo(t, { at, seconds: Math.min(60, seconds + 1.5) });
    if (echo.echo) {
      emit({ type: 'heard', text: t, dropped: 'echo' });
      return { dropped: 'echo' };
    }
    const said = echo.rest || t;
    const plain = words(said).join(' ');
    emit({ type: 'heard', text: said });
    if (speech.speaking || speech.queued) {
      if (!settings.get().listenWhileSpeaking) return { dropped: 'speaking' };
      speech.stop(); // cut in
    }
    if (HUSH.test(plain)) {
      if (assistant.turn && !assistant.turn.toolRunning) assistant.cancel();
      speech.stop();
      return { command: 'hush' };
    }
    if (CANCEL.test(plain)) {
      const had = assistant.cancel();
      if (had) speakAs('Okay, cancelled.');
      return { command: 'cancel' };
    }
    if (NEW_CHAT.test(plain)) {
      assistant.newChat();
      speakAs('Okay, a fresh start.');
      return { command: 'new_chat' };
    }
    if (CLEAR_CHAT.test(plain)) {
      assistant.clear();
      speakAs('Okay, cleared.');
      return { command: 'clear_chat' };
    }
    if (held) {
      clearTimeout(held.timer);
      held.text += ` ${said}`;
    } else held = { text: said, at };
    if (UNFINISHED.test(held.text) && held.text.length < 400) {
      held.timer = setTimeout(release, 1600);
      return { held: true };
    }
    release();
    return { said };
  }

  function release() {
    if (!held) return;
    const h = held;
    held = null;
    clearTimeout(h.timer);
    assistant.say(h.text, { how: 'said', at: h.at });
  }

  // ---------------------------------------------------------------- what went wrong

  /** Something went wrong, anywhere (the character's page, its workers, the model, the app): kept for the Errors tab. */
  function reportError({ source = 'app', message, detail = '' }) {
    const msg = String(message ?? '').trim();
    if (!msg) return null;
    const last = errors.at(-1);
    // The same thing again, straight after: counted, not listed twice.
    if (last && last.source === source && last.message === msg && now() - last.at < 60_000) {
      last.count++;
      last.at = now();
      if (detail && !last.detail) last.detail = String(detail);
    } else {
      errors.push({ id: nextError++, at: now(), source, message: msg.slice(0, 1000), detail: String(detail || '').slice(0, 8000), count: 1 });
      if (errors.length > MAX_ERRORS) errors.splice(0, errors.length - MAX_ERRORS);
    }
    emit({ type: 'errors', errors });
    return errors.at(-1);
  }

  /** Everything worth knowing to report a problem, as text to paste. */
  function errorReport() {
    const about = host.about?.() || {};
    const face = host.face?.() || {};
    const s = settings.get();
    const a = assistant.state();
    const p = peter.health;
    const time = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
    const lines = [
      `Super Face ${about.version || '?'}, report made ${time(now())} UTC`,
      `System: ${about.os || process.platform} · Electron ${about.electron || '?'} · Chrome ${about.chrome || '?'} · ${about.arch || process.arch}`,
      `GPU (WebGPU): ${face.gpu || 'unknown'}`,
      `Character: ${character().name} (${s.avatar}), avatar ${face.avatar || '?'}${face.message ? `: ${face.message}` : ''}`,
      `Voice: ${face.tts?.state || '?'}${face.tts?.message ? `: ${face.tts.message}` : ''}${face.backend ? ` (on ${face.backend})` : ''}`,
      `Ears: ${s.listening ? ears.state : 'off (not listening)'}${ears.message ? `: ${ears.message}` : ''}${ears.device ? ` (on ${ears.device})` : ''}`,
      `Model: ${a.model || '(the best Ollama has)'} at ${s.ollamaUrl}${a.error ? `: ${a.error}` : ''}`,
      `Peter: ${p.reachable ? `${p.version || '?'}${p.toolMac ? `, Tool Mac Tool Run with ${p.scripts} scripts and ${p.flows} flows` : ''}${p.model ? `, his model ${p.model}` : ''}${p.error ? ` (${p.error})` : ''}` : `not available (${p.error || 'not asked'})`} at ${s.peterUrl}`,
      ...(face.userAgent ? [`Page: ${face.userAgent}`] : []),
      '',
      errors.length ? `Errors (${errors.length}, oldest first):` : 'No errors.',
    ];
    for (const e of errors) {
      lines.push(`[${time(e.at)}] ${e.source}: ${e.message}${e.count > 1 ? ` (×${e.count})` : ''}`);
      if (e.detail) lines.push(...e.detail.split('\n').slice(0, 40).map((l) => `    ${l}`));
    }
    return lines.join('\n');
  }

  /** The prompts as they stand now: what the model is told, and the notes the app adds when they're due. */
  function prompts() {
    return [
      {
        id: 'system',
        title: 'The assistant (system prompt)',
        when: 'Sent with every message, built fresh each time: who it is, a small example of the chat (the user, the model, Peter), a short explanation, your standing instructions and its playbook (from its space in Storage Spaces, written by Peter), and the day.',
        text: systemPrompt({ character: character(), model: model.current().model || model.picked || '', peter: peter.health, notes, now: now() }),
      },
      { id: 'promised', title: 'Words that promise work, with no message to Peter', when: 'Sent back once when an answer says it will do something but asks no one.', text: NOTE.promised },
      { id: 'json', title: 'A tool call written as JSON', when: 'Sent back once when an answer writes a JSON tool call (there are none) instead of asking Peter.', text: NOTE.json },
      { id: 'cannot', title: '“I can’t”, when Peter could', when: 'Sent back once when an answer says it can’t, or has no access, while Peter is there.', text: NOTE.cannot },
      { id: 'review', title: 'The critic: after Peter didn’t do it', when: 'Added to Peter’s answer when he didn’t do it (he needs something, or can’t), twice per request at most.', text: NOTE.review },
      { id: 'onlyFirst', title: 'More than one message to Peter in an answer', when: 'Added to Peter’s answer when the model wrote several: only the first is sent.', text: NOTE.onlyFirst() },
      { id: 'outOfRounds', title: 'Ten messages for one request', when: 'Added to the tenth answer of Peter’s for one request.', text: NOTE.outOfRounds(10) },
      { id: 'empty', title: 'An empty message', when: 'The answer to "@peter" with nothing after it.', text: NOTE.empty() },
    ];
  }

  // ---------------------------------------------------------------- what the chat and the API can do

  function status() {
    const s = settings.get();
    const c = character();
    return {
      character: { id: c.id, name: c.name, voice: c.voice },
      characters: CHARACTERS.map((x) => ({ id: x.id, name: x.name, voice: x.voice, body: x.body, looks: x.looks })),
      size: s.size,
      sizes: Object.keys(SIZES),
      assistant: assistant.state(),
      ears,
      listening: s.listening,
      listenWhileSpeaking: s.listenWhileSpeaking,
      busyTone: s.busyTone,
      model: s.model,
      think: s.think,
      speaking: speech.speaking,
      peter: { reachable: peter.health.reachable, error: peter.health.error, toolMac: !!peter.health.toolMac },
      face: (({ avatar, tts, backend, message } = {}) => ({ avatar, tts, backend, message }))(host.face?.()),
      errors: errors.length,
    };
  }

  /** Whether Peter answers (asked now and then, and for the status). */
  async function checkPeter() {
    const before = peter.health.reachable;
    await peter.check();
    if (peter.health.reachable !== before) emit({ type: 'status', status: status() });
    return peter.health;
  }

  /** The actions, by name: what the chat window calls (over IPC, or HTTP in the browser). */
  const actions = {
    status,
    log: () => assistant.log.filter((e) => !e.hidden),
    send: ({ text }) => {
      host.show?.();
      const e = assistant.say(text, { how: 'typed' });
      return { ok: !!e, id: e?.id };
    },
    cancel: () => ({ ok: assistant.cancel() }),
    cancelTool: ({ id }) => ({ ok: assistant.cancelTool(id) }),
    /** Peter's news: a run this app asked him for is over, or something scheduled is due. */
    peterNews: ({ text, entries }) => {
      if (!String(text ?? '').trim()) throw new Error('missing text: what Peter says');
      host.show?.();
      const e = assistant.news(String(text), Array.isArray(entries) ? entries : []);
      return { ok: !!e, id: e?.id };
    },
    hush: () => {
      speech.stop();
      return { ok: true };
    },
    newChat: () => {
      assistant.newChat();
      return { ok: true };
    },
    clearChat: () => {
      assistant.clear();
      return { ok: true };
    },
    trace: ({ log }) => {
      if (!traces[log]) throw new Error(`no log called ${log}: model`);
      return { items: traces[log].list() };
    },
    clearTrace: ({ log }) => {
      if (!traces[log]) throw new Error(`no log called ${log}: model`);
      traces[log].clear();
      return { ok: true };
    },
    setSize: ({ size }) => {
      if (!SIZES[size]) throw new Error(`no size called ${size}: ${Object.keys(SIZES).join(', ')}`);
      host.resize ? host.resize(size) : settings.set({ size });
      return { size };
    },
    peter: checkPeter,
    models: async () => {
      try {
        return { models: await model.models(), current: settings.get().model || model.picked || '' };
      } catch (err) {
        return { models: [], current: settings.get().model, error: err.message };
      }
    },
    setCharacter: ({ id }) => {
      const c = resolveCharacter(id);
      if (!c) throw new Error(`no character called ${id}`);
      settings.set({ avatar: c.id, voice: c.voice });
      return status();
    },
    errors: () => ({ errors, report: errorReport() }),
    clearErrors: () => {
      errors.length = 0;
      emit({ type: 'errors', errors });
      return { ok: true };
    },
    /** The report, on the clipboard (the app's, when there is one; else it's handed back to copy). */
    copyReport: () => {
      const text = errorReport();
      const copied = !!host.copy?.(text);
      return { ok: true, copied, text };
    },
    copy: ({ text }) => ({ ok: true, copied: !!host.copy?.(String(text ?? '')) }),
    /**
     * Back to how it was installed: everything stopped and forgotten (the chat, the logs, the
     * errors, the settings). In the app, its whole folder of data (the downloaded voice
     * and ears too) goes to the Trash and it starts again; without the app (the browser dev
     * server), its files go and it carries on from the defaults. What it learned (and what's
     * scheduled) is kept by Peter and Tool Mac Tool Run.
     */
    factoryReset: () => {
      assistant.cancel();
      assistant.clear();
      traces.model.clear();
      errors.length = 0;
      emit({ type: 'errors', errors });
      if (host.factoryReset) {
        // A moment for this answer to get back, then the app's folder goes and it starts again.
        setTimeout(() => host.factoryReset(), 300);
        return { ok: true, relaunching: true };
      }
      for (const name of ['chat.json', 'schedule.json', 'memory.json', 'memory.json.moved']) {
        const f = file(name);
        if (f) fs.rmSync(f, { force: true });
      }
      settings.reset?.();
      emit({ type: 'status', status: status() });
      return { ok: true, relaunching: false };
    },
    reportError: ({ source, message, detail }) => ({ ok: !!reportError({ source: source || 'chat', message, detail }) }),
    retryVoice: async () => {
      if (!host.retryVoice) throw new Error('the voice can only be started again in the app');
      return host.retryVoice();
    },
    prompts,
    set: (patch = {}) => {
      const allowed = {};
      if ('model' in patch) {
        allowed.model = String(patch.model || '');
        model.picked = '';
      }
      if ('think' in patch) allowed.think = !!patch.think;
      if ('listening' in patch) allowed.listening = !!patch.listening;
      if ('listenWhileSpeaking' in patch) allowed.listenWhileSpeaking = !!patch.listenWhileSpeaking;
      if ('busyTone' in patch) allowed.busyTone = !!patch.busyTone;
      settings.set(allowed);
      return status();
    },
  };

  function setEars(state) {
    ears = { ...ears, ...state };
    emit({ type: 'ears', ears });
  }

  return {
    assistant,
    model,
    peter,
    notes,
    actions,
    heard,
    speakAs,
    setEars,
    reportError,
    errorReport,
    prompts,
    status,
    checkPeter,
    character,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    start() {
      checkPeter();
      // Whether Peter answers is asked again now and then (he may be opened, or quit).
      const timer = setInterval(checkPeter, 60_000);
      timer.unref?.();
      settings.onChange((s, before) => {
        if (s.avatar !== before.avatar || s.size !== before.size || s.model !== before.model || s.listening !== before.listening || s.think !== before.think) emit({ type: 'status', status: status() });
      });
    },
    stop() {},
  };
}
