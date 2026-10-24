// The avatar's page: TalkingHead draws the avatar (head to toes, on a transparent canvas) and moves
// it; HeadTTS makes the voice (Kokoro, in the page: WebGPU, else WASM), with the timing of every
// word and viseme, so the lips follow the words exactly. Each sentence gets a mood, an expression,
// a gesture and a head movement from the director (what was asked, Super Voice's model, rules).
// The main process sends commands (speak, stop, express, tts, settings) and is told how it goes.

import { TalkingHead } from 'talkinghead';
import { HeadTTS } from 'headtts';
import { EXPRESSIONS } from '/src/shared/catalog.mjs';
import { merge, modelRequest, readAnswer, rules } from '/src/shared/director.mjs';
import { parse, sentences } from '/src/shared/text.mjs';

const RATE = 24000; // Kokoro's: 24 kHz mono
const AVATARS = {
  brunette: { url: './avatars/brunette.glb', body: 'F' },
  david: { url: './avatars/david.glb', body: 'M' },
};

const $ = (id) => document.getElementById(id);
const bridge = window.face || (await import('./dev-bridge.mjs')).bridge();
window.faceStarted = true; // the modules are in: from here on, failures are reported below
const abs = (p) => new URL(p, location.href).href;

let cfg = await bridge.getSettings();
let head; // TalkingHead
let tts; // HeadTTS
let backend = null;
let ttsState = { state: 'loading' };
let avatarState = 'loading';
let avatarMessage = '';
let ready; // resolves once the avatar and the voice are both ready
const readyNow = new Promise((r) => (ready = r));

// ---------------------------------------------------------------- state, for the main process

function report() {
  bridge.event({ type: 'state', state: { avatar: avatarState, tts: ttsState, backend, message: avatarMessage } });
  const problem = avatarState === 'failed' || ttsState.state === 'failed';
  if (problem) document.body.dataset.problem = 'true';
  else delete document.body.dataset.problem;
  document.body.dataset.state = avatarState === 'ready' && ttsState.state === 'ready' ? 'idle' : 'loading';
  $('status').textContent =
    avatarState === 'failed'
      ? `The avatar didn’t load: ${avatarMessage || 'unknown error'}. Right-click › Reload the avatar.`
      : ttsState.state === 'failed'
        ? `The voice didn’t load: ${ttsState.message}`
        : avatarState !== 'ready'
          ? 'Loading the avatar…'
          : ttsState.state === 'downloading'
            ? `Getting the voices ready… ${Math.round((ttsState.progress || 0) * 100)}%`
            : ttsState.state !== 'ready'
              ? 'Loading the voice…'
              : '';
}

let captionTimer = 0;
function caption(text, hold = 0) {
  clearTimeout(captionTimer);
  const el = $('caption');
  if (!cfg.captions || !text) {
    el.hidden = true;
    return;
  }
  el.textContent = text;
  el.hidden = false;
  if (hold) captionTimer = setTimeout(() => (el.hidden = true), hold);
}

// ---------------------------------------------------------------- the avatar

function createHead() {
  head = new TalkingHead($('stage'), {
    ttsEndpoint: '', // the voice comes from HeadTTS
    lipsyncModules: [], // the visemes come with the voice
    pcmSampleRate: RATE,
    cameraView: cfg.view,
    cameraRotateEnable: false,
    cameraPanEnable: false,
    cameraZoomEnable: false,
    mixerGainSpeech: 1.5,
    avatarMood: cfg.mood,
    avatarIdleEyeContact: 0.3,
    avatarSpeakingEyeContact: 0.7,
    modelFPS: 30,
  });
  window.head = head; // handy in the developer tools
}

async function loadAvatar() {
  avatarState = 'loading';
  report();
  const a = AVATARS[cfg.avatar] || AVATARS.brunette;
  try {
    await head.showAvatar({ url: a.url, body: a.body, avatarMood: cfg.mood, lipsyncLang: 'en' });
    head.setView(cfg.view);
    avatarState = 'ready';
  } catch (err) {
    console.error('The avatar didn’t load:', err);
    avatarState = 'failed';
    avatarMessage = err?.message || String(err);
  }
  report();
}

// ---------------------------------------------------------------- the voice

async function connectVoice() {
  ttsState = { state: 'loading' };
  report();
  // After a few seconds still loading, it's downloading (the first time): callers are told to
  // come back, rather than kept waiting for minutes.
  const slow = setTimeout(() => {
    if (ttsState.state === 'loading') {
      ttsState = { state: 'downloading', progress: ttsState.progress || 0 };
      report();
    }
  }, 5000);
  const options = (endpoint) => ({
    endpoints: [endpoint],
    audioCtx: head.audioCtx,
    workerModule: abs('/node_modules/@met4citizen/headtts/modules/worker-tts.mjs'),
    transformersModule: abs('/node_modules/@huggingface/transformers/dist/transformers.min.js'),
    dictionaryURL: abs('/node_modules/@met4citizen/headtts/dictionaries/'),
    voices: [cfg.voice],
    splitSentences: false, // it's cut into sentences here, each with its own direction
    defaultVoice: cfg.voice,
    defaultSpeed: cfg.speed,
    defaultAudioEncoding: 'pcm',
  });
  const onprogress = (ev) => {
    if (!ev.lengthComputable || !ev.total) return;
    ttsState = { ...ttsState, progress: Math.round((ev.loaded / ev.total) * 100) / 100 };
    report();
  };
  let lastError = null;
  // WebGPU only when there's a GPU to be had (a page can see navigator.gpu with no adapter).
  let gpu = false;
  try {
    gpu = !!(await navigator.gpu?.requestAdapter());
  } catch {
    /* no WebGPU */
  }
  for (const endpoint of gpu ? ['webgpu', 'wasm'] : ['wasm']) {
    const t = new HeadTTS(options(endpoint));
    t.onmessage = () => {};
    t.onerror = (e) => console.error('HeadTTS:', e);
    try {
      // A start that fails is reported to onerror, not thrown: it's connected, or it isn't.
      await t.connect(null, onprogress);
      if (!t.isConnected) throw new Error(`the voice model didn’t start on ${endpoint}`);
      tts = t;
      backend = endpoint;
      break;
    } catch (err) {
      lastError = err;
      console.warn(`HeadTTS on ${endpoint} didn’t start:`, err);
      try {
        t.clear();
        t.ww?.terminate();
      } catch {
        /* already gone */
      }
    }
  }
  clearTimeout(slow);
  ttsState = tts ? { state: 'ready' } : { state: 'failed', message: String(lastError?.message || lastError || 'no backend') };
  report();
}

/** One sentence (or any short text) → its audio (PCM bytes) and timing. */
async function synthesize(text) {
  // HeadTTS waits for ever if its worker has gone: a sentence gets a minute.
  const msgs = await Promise.race([
    tts.synthesize({ input: text }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('the voice took too long')), 60_000)),
  ]);
  const audio = msgs.filter((m) => m.type === 'audio' && m.data);
  if (!audio.length) {
    const err = msgs.find((m) => m.type === 'error');
    throw new Error(err?.data?.error || 'the voice made nothing');
  }
  // Normally one; joined, with the timing moved along, if HeadTTS cut it up.
  const out = { words: [], wtimes: [], wdurations: [], visemes: [], vtimes: [], vdurations: [], chunks: [], ms: 0 };
  for (const m of audio) {
    const d = m.data;
    const shift = out.ms;
    out.words.push(...(d.words || []));
    out.wtimes.push(...(d.wtimes || []).map((t) => t + shift));
    out.wdurations.push(...(d.wdurations || []));
    out.visemes.push(...(d.visemes || []));
    out.vtimes.push(...(d.vtimes || []).map((t) => t + shift));
    out.vdurations.push(...(d.vdurations || []));
    const buf = d.audio instanceof ArrayBuffer ? d.audio : d.audio?.buffer;
    if (buf) {
      out.chunks.push(buf);
      out.ms += (buf.byteLength / 2 / RATE) * 1000;
    }
  }
  return out;
}

// ---------------------------------------------------------------- what it shows

let modelDownUntil = 0;

/** The model's direction for every sentence, through Super Voice (null when off or unreachable). */
async function askModel(texts, u) {
  if (cfg.expressions !== 'model' || u.auto === false || Date.now() < modelDownUntil || !texts.length) return null;
  try {
    const res = await fetch(`${cfg.superVoiceUrl}/api/model/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(modelRequest(texts, { who: u.who })),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Super Voice ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return readAnswer(data.message?.content ?? data.content, texts.length);
  } catch (err) {
    // Not running, no model, too slow: rules for a minute, then it's asked again.
    console.warn('Expressions from the model: none this time:', err.message);
    modelDownUntil = Date.now() + 60_000;
    return null;
  }
}

/** Whatever answers first: the promise, or `fallback` after `ms`. */
function within(promise, ms, fallback = null) {
  return Promise.race([promise, new Promise((r) => setTimeout(() => r(fallback), ms))]);
}

function playExpression(name, seconds) {
  const e = EXPRESSIONS[name];
  if (e) head.playGesture(e.emoji, Math.max(1.2, Math.min(seconds, 4)));
}

/** Shows `d` (mood, expression, gesture, head, pose, look) now. */
function show(d, seconds = 3) {
  if (d.mood && d.mood !== head.getMood()) head.setMood(d.mood);
  if (d.pose) head.playPose(d.pose, null, 30);
  if (d.expression) playExpression(d.expression, d.duration || seconds);
  if (d.head) head.playGesture(d.head);
  if (d.gesture) head.playGesture(d.gesture, d.duration || Math.min(3, Math.max(1.5, seconds)), Math.random() < 0.5);
  if (d.look === 'camera') head.lookAtCamera(2000);
  else if (d.look === 'ahead') head.lookAhead(2000);
  else if (d.look === 'away') head.lookAhead(3500);
}

// ---------------------------------------------------------------- speaking

const queue = []; // utterances not started
const inFlight = new Map(); // id → utterance being made or playing
let generation = 0;
let pumping = false;

function speak(u) {
  queue.push(u);
  pump();
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    await readyNow;
    while (queue.length) {
      const u = queue.shift();
      inFlight.set(u.id, u);
      try {
        await perform(u, generation);
      } catch (err) {
        console.error('Couldn’t say it:', err);
        inFlight.delete(u.id);
        bridge.event({ type: 'ended', id: u.id, error: err.message || String(err) });
      }
    }
  } finally {
    pumping = false;
  }
}

/**
 * Makes and queues the whole utterance (each sentence is played as soon as it's made, while the
 * next is being made); resolves once it's all queued, so the next utterance is made meanwhile.
 */
async function perform(u, gen) {
  if (avatarState !== 'ready') throw new Error('the avatar didn’t load');
  if (!tts) throw new Error(`the voice didn’t load: ${ttsState.message || ''}`);
  const { sentences: list } = parse(u.text);
  if (!list.length) {
    inFlight.delete(u.id);
    bridge.event({ type: 'started', id: u.id });
    bridge.event({ type: 'ended', id: u.id });
    return;
  }
  tts.setup({ voice: u.voice, speed: u.speed, audioEncoding: 'pcm' });
  const made = list.map((s) => synthesize(s.text));
  made.forEach((p) => p.catch(() => {})); // reported in turn
  const fromModel = askModel(list.map((s) => s.text), u);
  const started = performance.now();
  const asked = { mood: u.mood, expression: u.expression, gesture: u.gesture, head: u.head, pose: u.pose };
  let moodChanged = false;
  let failures = 0;

  for (let i = 0; i < list.length; i++) {
    let audio;
    try {
      audio = await made[i];
    } catch (err) {
      if (gen !== generation) return;
      failures++;
      console.error('A sentence couldn’t be said:', err);
      if (failures === list.length) throw err;
      continue;
    }
    if (gen !== generation) return;
    // The model has until the first sentence is ready plus a moment; later ones, a moment more.
    const wait = i === 0 ? Math.max(150, 1200 - (performance.now() - started)) : 250;
    const model = await within(fromModel, wait);
    const auto = cfg.expressions !== 'off' && u.auto !== false;
    const d = merge({
      asked: i === 0 ? asked : {},
      model: auto && model ? model[i] : null,
      rule: auto && !model ? rules(list[i].text) : {},
      cues: list[i].cues,
    });
    if (gen !== generation) return;
    const seconds = audio.ms / 1000;
    const markers = [];
    const mtimes = [];
    const first = i === 0;
    markers.push(() => {
      if (first) bridge.event({ type: 'started', id: u.id });
      bridge.event({ type: 'sentence', id: u.id, text: list[i].text, duration: seconds });
      caption(list[i].text);
      if (d.mood) moodChanged = moodChanged || d.mood !== cfg.mood;
      const { timed: _t, ...now } = d;
      show(now, seconds);
    });
    mtimes.push(0);
    for (const c of d.timed) {
      markers.push(() => show(c, Math.max(1.5, seconds * (1 - c.at))));
      mtimes.push(Math.round(c.at * audio.ms));
    }
    head.speakAudio({
      audio: audio.chunks,
      words: audio.words,
      wtimes: audio.wtimes,
      wdurations: audio.wdurations,
      visemes: audio.visemes,
      vtimes: audio.vtimes,
      vdurations: audio.vdurations,
      markers,
      mtimes,
    });
  }
  head.speakMarker(() => {
    if (gen !== generation) return;
    inFlight.delete(u.id);
    if (moodChanged && !queue.length) head.setMood(cfg.mood);
    caption(document.getElementById('caption').textContent, 2500);
    bridge.event({ type: 'ended', id: u.id });
  });
}

/** Stops the utterances named (all when none are): the rest carry on. */
function stop(ids) {
  const drop = new Set(ids || [...inFlight.keys(), ...queue.map((u) => u.id)]);
  for (let i = queue.length - 1; i >= 0; i--) if (drop.has(queue[i].id)) queue.splice(i, 1);
  const hit = [...inFlight.keys()].some((id) => drop.has(id));
  if (!hit) return;
  // What's been made and queued in TalkingHead can't be taken out one by one: everything stops,
  // and what wasn't to be stopped is said again from its start.
  generation++;
  head.stopSpeaking();
  tts.clear();
  const again = [...inFlight.values()].filter((u) => !drop.has(u.id));
  inFlight.clear();
  queue.unshift(...again);
  caption('');
  if (!queue.length) head.setMood(cfg.mood);
  pump();
}

/** Text → audio and timing, without saying it (POST /api/tts). */
async function textToSpeech({ text, voice, speed }) {
  await readyNow;
  if (!tts) throw new Error(`the voice didn’t load: ${ttsState.message || ''}`);
  tts.setup({ voice, speed, audioEncoding: 'pcm' });
  const parts = await Promise.all(sentences(parse(text).text).map((s) => synthesize(s)));
  const out = { sampleRate: RATE, words: [], wtimes: [], wdurations: [], visemes: [], vtimes: [], vdurations: [] };
  let ms = 0;
  const chunks = [];
  for (const p of parts) {
    out.words.push(...p.words);
    out.wtimes.push(...p.wtimes.map((t) => Math.round(t + ms)));
    out.wdurations.push(...p.wdurations);
    out.visemes.push(...p.visemes);
    out.vtimes.push(...p.vtimes.map((t) => Math.round(t + ms)));
    out.vdurations.push(...p.vdurations);
    chunks.push(...p.chunks);
    ms += p.ms;
  }
  const pcm = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let o = 0;
  for (const c of chunks) {
    pcm.set(new Uint8Array(c), o);
    o += c.byteLength;
  }
  out.pcm = pcm.buffer;
  return out;
}

// ---------------------------------------------------------------- commands from the main process

const COMMANDS = {
  speak: (u) => speak(u),
  stop: ({ ids }) => stop(ids),
  express: async (d) => {
    await readyNow;
    if (avatarState !== 'ready') throw new Error('the avatar didn’t load');
    show(d, d.duration || 3);
  },
  tts: (d) => textToSpeech(d),
  settings: async (patch) => {
    const before = cfg;
    cfg = { ...cfg, ...patch };
    if (!head) return;
    if (patch.view) head.setView(patch.view);
    if (patch.mood && !inFlight.size) head.setMood(patch.mood);
    if (patch.avatar && patch.avatar !== before.avatar) await loadAvatar();
    if (patch.captions === false) caption('');
  },
};

bridge.onCommand(async ({ id, type, data }) => {
  try {
    const result = await COMMANDS[type]?.(data);
    bridge.reply(id, true, result ?? null);
  } catch (err) {
    bridge.reply(id, false, null, err.message || String(err));
  }
});

// ---------------------------------------------------------------- moving the window, the menu

function wireInput() {
  const stage = $('stage');
  let drag = null;
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { x: e.screenX, y: e.screenY };
    stage.setPointerCapture(e.pointerId);
    bridge.dragStart();
    head?.audioCtx.resume();
  });
  stage.addEventListener('pointermove', (e) => drag && bridge.dragMove(e.screenX - drag.x, e.screenY - drag.y));
  const end = () => {
    if (!drag) return;
    drag = null;
    bridge.dragEnd();
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    bridge.showMenu();
  });
}

// ---------------------------------------------------------------- go

wireInput();
try {
  createHead();
} catch (err) {
  // No WebGL (or no audio): nothing can be shown or said, and the main process is told why.
  console.error('The avatar couldn’t start:', err);
  avatarState = 'failed';
  avatarMessage = `the 3D view couldn’t start (${err?.message || err})`;
  ttsState = { state: 'failed', message: 'the avatar couldn’t start' };
}
if (head) await Promise.all([loadAvatar(), connectVoice()]);
report();
ready();
