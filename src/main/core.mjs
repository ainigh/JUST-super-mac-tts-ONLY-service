// Everything but the windows: the assistant and what it works with (the model, Tool Mac Tool Run,
// the schedule, memory), what's heard and what's done with it, and the actions the chat window
// and the API share. The Electron main process and the browser dev server both build one.

import path from 'node:path';
import { Assistant } from './assistant.mjs';
import { Memory } from './memory.mjs';
import { Ollama } from './model.mjs';
import { Scheduler, fromNow, longTime } from './scheduler.mjs';
import { ToolRun } from './toolrun.mjs';
import { CHARACTERS, SIZES, characterOf, nextSize, resolveCharacter } from '../shared/characters.mjs';
import { modelRequest } from '../shared/director.mjs';
import { words } from '../shared/text.mjs';

/** Said alone, these stop it talking (and any answer still being written); a run carries on. */
const HUSH = /^(stop|stop talking|stop it|quiet|be quiet|hush|shush|shut up|silence|enough|that's enough|ok(ay)? stop|thanks,? stop)$/;
/** Said alone, these call off whatever it's doing: the answer, a run, what's waiting. */
const CANCEL = /^(cancel|cancel (it|that|this|everything|the run)|never ?mind|stop everything|stop (it|that) all|abort|forget it|forget about it|scratch that)$/;
const NEW_CHAT = /^(new chat|start over|start a new chat|fresh start|clear the chat|new conversation)$/;
/** What speech recognition makes of a cough or a breath. */
const NOISE = new Set(['uh', 'um', 'umm', 'hmm', 'mm', 'mhm', 'ah', 'oh', 'eh', 'huh', 'you', 'the', 'a', 'thank you', 'bye']);
/** A phrase ending like this isn't over: the rest is waited for a moment. */
const UNFINISHED = /(\b(and|but|or|so|because|then|the|a|an|to|of|with|for|that|my|your|is|are|if|when|about|like)|,)\s*$/i;

export function createCore({ settings, speech, dataDir, host = {}, fetch: f = globalThis.fetch, now = Date.now }) {
  const listeners = new Set();
  const emit = (ev) => {
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

  const model = new Ollama({ current: () => ({ url: settings.get().ollamaUrl, model: settings.get().model, think: settings.get().think }), fetch: f });
  const toolrun = new ToolRun({ url: () => settings.get().toolRunUrl, fetch: f });
  const memory = new Memory({ file: file('memory.json'), onChange: (m) => emit({ type: 'memory', memory: m }) });
  const scheduler = new Scheduler({
    file: file('schedule.json'),
    now,
    onChange: () => emit({ type: 'schedules', schedules: schedules() }),
    onFire: (t, late) => {
      // It shows itself (if it wasn't showing) and does what it set itself to do.
      host.show?.();
      const set = longTime(t.created, now());
      assistant.say(`Scheduled task ${t.id}, set ${set}: ${t.task}${late ? ` (It was due ${longTime(t.due, now())}, while the app wasn't running: say it's late.)` : ''}`, { how: 'scheduled' });
    },
  });

  /** Says `text` in the character's voice; its face follows the words (and the cues in them). */
  function speakAs(text) {
    const c = character();
    const s = settings.get();
    host.show?.();
    return speech.enqueue({ text, voice: c.voice, speed: s.speed, auto: true, director: 'rules', source: 'assistant', who: c.name });
  }

  const assistant = new Assistant({
    model,
    toolrun,
    scheduler,
    memory,
    character,
    speak: speakAs,
    stopSpeaking: () => speech.stop('assistant'),
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

  // ---------------------------------------------------------------- what the chat and the API can do

  function schedules() {
    const n = now();
    return scheduler.list().map((t) => ({ ...t, when: longTime(t.due, n), fromNow: fromNow(t.due, n) }));
  }

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
      model: s.model,
      think: s.think,
      speaking: speech.speaking,
      tools: { reachable: toolrun.catalog.reachable && !toolrun.catalog.error, scripts: toolrun.catalog.scripts.length, flows: toolrun.catalog.flows.length, error: toolrun.catalog.error },
      schedules: scheduler.list().length,
    };
  }

  async function refreshTools() {
    await toolrun.refresh();
    const t = assistant.tools();
    emit({ type: 'tools', tools: t });
    return t;
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
    hush: () => {
      speech.stop();
      return { ok: true };
    },
    newChat: () => {
      assistant.newChat();
      return { ok: true };
    },
    tools: () => assistant.tools(),
    refreshTools,
    schedules,
    cancelSchedule: ({ id }) => ({ ok: scheduler.cancel(id).length > 0 }),
    memory: () => memory.json(),
    forget: ({ section, note }) => ({ result: memory.forget(section, note) }),
    instructions: ({ text }) => {
      memory.setInstructions(text);
      return { ok: true };
    },
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
    cycleSize: ({ step = 1 } = {}) => {
      const name = nextSize(settings.get().size, step < 0 ? -1 : 1);
      host.resize ? host.resize(name) : settings.set({ size: name });
      return { size: name };
    },
    set: (patch = {}) => {
      const allowed = {};
      if ('model' in patch) {
        allowed.model = String(patch.model || '');
        model.picked = '';
      }
      if ('think' in patch) allowed.think = !!patch.think;
      if ('listening' in patch) allowed.listening = !!patch.listening;
      if ('listenWhileSpeaking' in patch) allowed.listenWhileSpeaking = !!patch.listenWhileSpeaking;
      settings.set(allowed);
      return status();
    },
  };

  /** The model's direction for a client's sentences (POST /api/speak with expressions from the model). */
  async function direct(texts, who) {
    const req = modelRequest(texts, { who });
    return model.chat(req.messages, { format: req.format, temperature: 0, think: false, signal: AbortSignal.timeout(10_000) });
  }

  function setEars(state) {
    ears = { ...ears, ...state };
    emit({ type: 'ears', ears });
  }

  return {
    assistant,
    model,
    toolrun,
    scheduler,
    memory,
    actions,
    heard,
    direct,
    speakAs,
    setEars,
    status,
    refreshTools,
    character,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    start() {
      scheduler.start();
      refreshTools();
      // What there is to run is asked again now and then (scripts come and go).
      const timer = setInterval(refreshTools, 5 * 60_000);
      timer.unref?.();
      settings.onChange((s, before) => {
        if (s.avatar !== before.avatar || s.size !== before.size || s.model !== before.model || s.listening !== before.listening || s.think !== before.think) emit({ type: 'status', status: status() });
      });
    },
    stop() {
      scheduler.stop();
    },
  };
}
