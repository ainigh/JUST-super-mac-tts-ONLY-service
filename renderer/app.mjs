// The character's page: TalkingHead draws it (head to toes, on a transparent canvas) and moves it;
// HeadTTS makes the voice (Kokoro, in the page: WebGPU, else WASM), with the timing of every word
// and viseme, so the lips follow the words exactly. Each sentence gets a mood, an expression, a
// gesture and a head movement: what was asked, the cues written in the text, and what the director
// reads in the sentences themselves (no model), and the way it faces, sentence by sentence. While
// the assistant works it out, it gets down to it (kneeling, sitting or bent over the work, turned
// away; to the page, for the browser), and stands and faces the user again the moment they talk or
// it speaks. Its hands are kept out of
// its head (keep-clear.mjs). The ears (ears.mjs) listen here too. The main process sends commands (speak, stop,
// express, tts, ears, settings) and is told how it goes; a click on the character opens the chat.

import { TalkingHead } from 'talkinghead';
import { HeadTTS } from 'headtts';
import { EXPRESSIONS } from '/src/shared/catalog.mjs';
import { characterOf } from '/src/shared/characters.mjs';
import { directOn, merge } from '/src/shared/director.mjs';
import { parse, sentences } from '/src/shared/text.mjs';
import { Ears } from './ears.mjs';
import { bothHands } from './gestures.mjs';
import { keepClear } from './keep-clear.mjs';

const RATE = 24000; // Kokoro's: 24 kHz mono

const $ = (id) => document.getElementById(id);
const bridge = window.face || (await import('./dev-bridge.mjs')).bridge();
window.faceStarted = true; // the modules are in: from here on, failures are reported below
const abs = (p) => new URL(p, location.href).href;

let cfg = await bridge.getSettings();
let head; // TalkingHead
let clear = null; // keeps the hands out of the head, for the avatar shown
let tts; // HeadTTS
let backend = null;
let ttsState = { state: 'loading' };
let avatarState = 'loading';
let avatarMessage = '';
let ready; // resolves once the avatar and the voice are both ready
let gpuInfo = 'not asked';
let voiceErrors = null; // while the voice is starting: what its worker says went wrong

/** Something went wrong: it goes to the main process, for the chat's Errors tab (and a report to copy). */
function problem(source, message, detail = '') {
  bridge.event({ type: 'error', source, message: String(message).slice(0, 500), detail: String(detail || '').slice(0, 8000) });
}

// What goes wrong inside the voice's worker (voice-glue.mjs) is heard here.
// While the voice is starting, it goes into that try's one entry; after, each is an entry of its own.
new BroadcastChannel('superface-errors').onmessage = ({ data }) => {
  if (voiceErrors) voiceErrors.push([data.message, data.detail].filter(Boolean).join('\n'));
  else problem(data.source || 'worker', data.message, data.detail);
};
addEventListener('error', (e) => {
  // The voice's worker giving up on purpose (voice-glue.mjs): already said, with its reason.
  if (String(e.filename || '').includes('voice-glue.mjs')) return;
  problem('page', e.message || 'an error on the page', e.error?.stack || `${e.filename || ''}:${e.lineno || ''}`);
});
addEventListener('unhandledrejection', (e) => problem('page', String(e.reason?.message || e.reason), e.reason?.stack || ''));
const readyNow = new Promise((r) => (ready = r));

// ---------------------------------------------------------------- state, for the main process

function report() {
  bridge.event({ type: 'state', state: { avatar: avatarState, tts: ttsState, backend, message: avatarMessage, gpu: gpuInfo, userAgent: navigator.userAgent } });
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
    update: onFrame, // each frame, once the body is posed
  });
  bothHands(head); // "wide" and "bothup", for both hands at once
  window.head = head; // handy in the developer tools
}

/** Each frame, once the body is posed: a hand in the head is moved out of it, and the head kept over the middle. */
function onFrame(dt) {
  try {
    clear?.update();
  } catch (err) {
    console.warn('Keeping the hands clear of the head failed, so it stopped:', err);
    clear = null;
  }
  keepCentred(dt);
}

// Kneeling or sitting and turned, the body swings round its feet and the head goes off to one side
// of the narrow window: the whole body is slid back (smoothly) to keep the head over the middle.
// Standing, the head is near enough over the feet, and nothing moves.
const centre = { base: 0, head: null };
const OFF_CENTRE = 0.05; // m the head may be off the middle before the body is slid back

function keepCentred(dt) {
  const body = head?.armature;
  if (!body || !centre.head) return;
  if (!clear?.arms) body.updateMatrixWorld(true); // else the hands' check just did
  const off = centre.head.matrixWorld.elements[12] - body.position.x; // the head, from the feet
  const over = Math.sign(off) * Math.max(0, Math.abs(off) - OFF_CENTRE);
  body.position.x += (centre.base - over - body.position.x) * Math.min(1, dt / 250);
}

let avatarLoaded = Promise.resolve(); // settles once the avatar being loaded is in (or isn't)

async function loadAvatar() {
  if (busy.on) endBusy();
  let done;
  avatarLoaded = new Promise((r) => (done = r));
  avatarState = 'loading';
  report();
  const c = characterOf(cfg.avatar);
  clear = null;
  centre.head = null;
  try {
    await head.showAvatar({ url: `./avatars/${c.file}`, body: c.body, avatarMood: cfg.mood, lipsyncLang: 'en', ...(c.baseline ? { baseline: c.baseline } : {}) });
    head.setView(cfg.view);
    clear = keepClear(head.armature);
    centre.base = head.armature.position.x;
    centre.head = head.armature.getObjectByName('Head');
    avatarState = 'ready';
  } catch (err) {
    console.error('The avatar didn’t load:', err);
    avatarState = 'failed';
    avatarMessage = err?.message || String(err);
    problem('avatar', `${c.name} didn’t load: ${avatarMessage}`, err?.stack || '');
  }
  report();
  done();
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
    // transformers.js through the glue: what goes wrong in the worker is heard here (voice-glue.mjs).
    transformersModule: abs('/renderer/voice-glue.mjs'),
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
  // WebGPU only when there's a GPU to be had (a page can see navigator.gpu with no adapter).
  let gpu = false;
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    gpu = !!adapter;
    gpuInfo = adapter ? [adapter.info?.vendor, adapter.info?.architecture, adapter.info?.description].filter(Boolean).join(' ') || 'yes' : 'no adapter';
  } catch (err) {
    gpuInfo = `failed: ${err?.message || err}`;
  }
  const endpoints = gpu ? ['webgpu', 'wasm'] : ['wasm'];
  const why = {}; // endpoint → why it didn't start, the last time
  // Twice round: what the first try downloaded is cached, so a second goes quicker.
  for (let round = 1; round <= 2 && !tts; round++) {
    for (const endpoint of endpoints) {
      const heard = []; // what the worker said went wrong
      voiceErrors = heard;
      const started = performance.now();
      const t = new HeadTTS(options(endpoint));
      t.onmessage = () => {};
      t.onerror = (e) => heard.push(String(e?.message || e));
      try {
        // A start that fails is reported to onerror, not thrown: it's connected, or it isn't.
        await t.connect(null, onprogress);
        if (!t.isConnected) throw new Error('it didn’t start');
        tts = t;
        backend = endpoint;
        break;
      } catch (err) {
        const seconds = Math.round((performance.now() - started) / 100) / 10;
        await new Promise((r) => setTimeout(r, 400)); // what the worker said may still be on its way
        // What the worker said, the most telling first (its real error, not HeadTTS's "failed to start").
        const said = [...new Set(heard)].filter((h) => !/^HeadTTS connection failed/.test(h));
        const detail = [...said, ...heard.filter((h) => /^HeadTTS connection failed/.test(h))].join('\n\n') || String(err?.message || err);
        const cause = said.map((h) => h.match(/(TypeError|Error|RangeError|SyntaxError): [^\n]+/)?.[0]).find((m) => m && !/Loading models failed/.test(m));
        why[endpoint] = cause || (said.length ? said[0].split('\n')[0] : `no answer from the voice's worker (after ${seconds}s)`);
        console.warn(`HeadTTS on ${endpoint} didn’t start (try ${round}):`, detail);
        problem('voice', `The voice didn’t start on ${endpoint === 'webgpu' ? 'the GPU (WebGPU)' : 'the CPU (WebAssembly)'}, try ${round} of 2, after ${seconds}s: ${why[endpoint]}`, detail);
        try {
          t.clear();
          t.ww?.terminate();
        } catch {
          /* already gone */
        }
      } finally {
        voiceErrors = null;
      }
    }
  }
  clearTimeout(slow);
  ttsState = tts
    ? { state: 'ready' }
    : { state: 'failed', message: `the voice model didn’t start (${Object.entries(why).map(([e, m]) => `${e}: ${m}`).join('; ')})` };
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

function playExpression(name, seconds) {
  const e = EXPRESSIONS[name];
  if (e) head.playGesture(e.emoji, Math.max(1.2, Math.min(seconds, 4)));
}

/** Which way it faces as it talks, in radians about the vertical (as the user sees it: left is negative). */
const TURN = { user: 0, left: -0.42, right: 0.42 };

/** Shows `d` (mood, expression, gesture, head, pose, look, turn) now. */
function show(d, seconds = 3) {
  if (d.mood && d.mood !== head.getMood()) head.setMood(d.mood);
  if (d.pose) head.playPose(d.pose, null, 30);
  if (d.expression) playExpression(d.expression, d.duration || seconds);
  if (d.head) head.playGesture(d.head);
  if (d.gesture) head.playGesture(d.gesture, d.duration || Math.min(3, Math.max(1.5, seconds)), Math.random() < 0.5);
  if (d.turn in TURN) turnTo(TURN[d.turn] * between(0.8, 1.15), 900);
  if (d.look === 'camera') head.lookAtCamera(2000);
  else if (d.look === 'ahead') head.lookAhead(2000);
  else if (d.look === 'away') head.lookAhead(3500);
  else if (d.look === 'down') head.lookAt(null, innerHeight * 1.3, 1500);
}

// ---------------------------------------------------------------- busy: while it works it out

// While the assistant thinks or a tool runs, and nothing is being said, the character gets down to
// it: it kneels, crouches, sits or bends over its work (never upright, and never looking up), turned
// away from the user, and keeps at it: reading, glancing aside, frowning in thought, counting
// things off, weighing something up, shaking its head at a dead end, a small "got it", shifting
// how it sits, swaying. Working in the browser, it turns to the page (towards the middle of the
// screen, where the page will be) and now and then to the side. A soft pip every so often says
// it's busy, not gone. The moment the user talks, or it has something to say, it stands, turns
// back and faces them, and the pips stop.

const BUSY_TURN = 0.75; // radians: turned well away, the face still in view
const PAGE_TURN = 1.85; // to the page: mostly its back to the user
const SIDE_TURN = 1.3; // side on to the user
const BUSY_AFTER = 700; // ms of working before it gets down to it (a quick answer doesn't)
/** The tools that work in the browser (by name): for them it turns to the page. */
const BROWSER = /browser|chrome|safari|straw|web|fetch|url|page|site|search|navigate|click|scrape|google/i;
/** How it gets down to work, by how much of it the window shows: low down when all of it shows. */
const LOW_POSES = { full: ['kneel', 'oneknee', 'sitting', 'bend'], mid: ['bend'], upper: ['bend'], head: [] };
const busy = { wanted: false, hearing: false, on: false, side: 1, eye: null, timers: [], startTimer: 0, turn: 0, browser: false, page: 0, toPage: true, pose: null };

/** Turns the whole body to `angle` (radians about the vertical) over `ms`, eased. */
function turnTo(angle, ms) {
  cancelAnimationFrame(busy.turn);
  const body = head?.armature;
  if (!body) return;
  const from = body.rotation.y;
  if (!ms || Math.abs(from - angle) < 0.001) {
    body.rotation.y = angle;
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - start) / ms);
    const ease = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    body.rotation.y = from + (angle - from) * ease;
    if (k < 1) busy.turn = requestAnimationFrame(step);
  };
  busy.turn = requestAnimationFrame(step);
}

const later = (ms, fn) => busy.timers.push(setTimeout(fn, ms));
const between = (a, b) => a + Math.random() * (b - a);
const oneOf = (list) => list[Math.floor(Math.random() * list.length)];

/** Gets down to work in one of the low poses the window shows (a different one from the last). */
function getDown() {
  const poses = LOW_POSES[cfg.view] || LOW_POSES.full;
  const choices = poses.filter((p) => p !== busy.pose);
  if (!choices.length) return;
  busy.pose = oneOf(choices);
  head.playPose(busy.pose, null, 600);
}

/** Which way it faces while it works: the page (or the side, now and then) for the browser, else turned away. */
function workAngle() {
  if (!busy.browser) return busy.side * BUSY_TURN * between(0.85, 1.15);
  const toward = busy.page || busy.side;
  return toward * (busy.toPage ? PAGE_TURN : SIDE_TURN) * between(0.92, 1.06);
}

/** Looks down at the work, never up: `deep` how far down (1 straight ahead, 2 well down). */
const lookDown = (deep, ms) => head.lookAt(null, innerHeight * deep, ms);

/** What it does next while it works, weighted; never the same twice running. */
const BEATS = [
  [4, 'read', () => lookDown(between(1.3, 1.9), 3200)], // head down, reading
  [2, 'aside', () => head.lookAhead(2600)], // a look along the way it faces
  [2, 'serious', () => playExpression(oneOf(['thinking', 'pensive', 'unamused']), 2.5)],
  [1, 'glance', () => playExpression('glance', 1.6)],
  [1, 'count', () => head.playGesture('index', 1.8, busy.side < 0)], // counting things off
  [1, 'weigh', () => head.playGesture('side', 1.8, Math.random() < 0.5)], // weighing it up
  [1, 'got it', () => (head.playGesture('ok', 1.6, busy.side > 0), playExpression('smile', 1.4))],
  [1, 'nod', () => (lookDown(1.4, 1800), head.playGesture('yes'))], // that checks out
  [1, 'not that', () => (playExpression('thinking', 1.5), head.playGesture('no'))], // a dead end
  [1, 'shift', () => getDown()], // sits another way
  [1, 'sway', () => turnTo(workAngle() + between(-0.25, 0.25), 1500)],
];
let lastBeat = '';

function beat() {
  if (!busy.on) return;
  const choices = BEATS.filter(([, name]) => name !== lastBeat);
  let r = Math.random() * choices.reduce((n, [w]) => n + w, 0);
  const [, name, act] = choices.find(([w]) => (r -= w) < 0) || choices[0];
  lastBeat = name;
  try {
    act();
  } catch (err) {
    console.warn('A busy beat failed:', err);
  }
  later(between(1800, 3800), beat);
}

// The busy tone. A pip is shorter than the ears take for speech (250 ms), and the pips are further
// apart than the pause that ends a phrase (750 ms), so its own ears drop them as clicks.
const PIP_EVERY = 1600; // ms
const PIP_SECONDS = 0.14;

function pip() {
  const ctx = head?.audioCtx;
  if (!ctx || ctx.state !== 'running') return;
  const t = ctx.currentTime;
  const tone = ctx.createOscillator();
  const level = ctx.createGain();
  tone.type = 'sine';
  tone.frequency.value = 740;
  level.gain.setValueAtTime(0.0001, t);
  level.gain.exponentialRampToValueAtTime(0.05, t + 0.012);
  level.gain.exponentialRampToValueAtTime(0.0001, t + PIP_SECONDS);
  tone.connect(level).connect(ctx.destination);
  tone.start(t);
  tone.stop(t + PIP_SECONDS + 0.02);
}

/** A pip every so often while it's busy (when the tone is on: it's read each time). */
function pips() {
  if (!busy.on) return;
  if (cfg.busyTone !== false) pip();
  later(PIP_EVERY, pips);
}

/** Now and then it shifts: to the other side, or, at the browser, from the page to the side and back. */
function swapSides() {
  if (!busy.on) return;
  if (busy.browser) busy.toPage = !busy.toPage;
  else busy.side = -busy.side;
  head.lookAhead(1600);
  turnTo(workAngle(), 1600);
  later(busy.browser ? between(5000, 9000) : between(8000, 13000), swapSides);
}

function startBusy() {
  busy.on = true;
  busy.side = -busy.side; // not always the same way round
  busy.toPage = true;
  busy.eye = head.opt.avatarIdleEyeContact;
  head.opt.avatarIdleEyeContact = 0; // it isn't looking at the user now
  getDown();
  turnTo(workAngle(), 1100);
  lookDown(1.5, 2500);
  later(900, beat);
  later(300, pips);
  later(between(6000, 10000), swapSides);
}

/** Back to the user: it stands, turns and looks at them (quickly when they've started talking). */
function endBusy() {
  busy.on = false;
  busy.timers.forEach(clearTimeout);
  busy.timers = [];
  if (busy.eye !== null) head.opt.avatarIdleEyeContact = busy.eye;
  busy.eye = null;
  if (!head?.armature) return;
  try {
    head.stopGesture(400);
  } catch {
    /* none playing */
  }
  if (busy.pose) head.playPose(oneOf(['straight', 'side']), null, 5);
  busy.pose = null;
  turnTo(0, busy.hearing ? 450 : 700);
  head.lookAtCamera(busy.hearing ? 2500 : 1800);
}

/** At the browser or not: it turns to the page, or back from it, as the tool changes. */
function setBrowser(on, page) {
  busy.page = page || 0;
  if (busy.browser === on) return;
  busy.browser = on;
  busy.toPage = true;
  if (busy.on) turnTo(workAngle(), 1200);
}

/** Busy only while it works, nobody is talking, and nothing is being said. */
const shouldBeBusy = () => busy.wanted && !busy.hearing && !inFlight.size && !queue.length && avatarState === 'ready' && !!head;

function updateBusy() {
  const should = shouldBeBusy();
  if (should && !busy.on) {
    busy.startTimer ||= setTimeout(() => {
      busy.startTimer = 0;
      if (shouldBeBusy() && !busy.on) startBusy();
    }, BUSY_AFTER);
    return;
  }
  clearTimeout(busy.startTimer);
  busy.startTimer = 0;
  if (!should && busy.on) endBusy();
}

// ---------------------------------------------------------------- speaking

const queue = []; // utterances not started
const inFlight = new Map(); // id → utterance being made or playing
/** What the director's reading of the last utterance left (its mood, what it last showed), for the next of the same speaker. */
let carried = null; // { state, source, who, until }
let generation = 0;
let pumping = false;

function speak(u) {
  queue.push(u);
  updateBusy(); // something to say: it faces the user to say it
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
        problem('speech', `Couldn’t say “${String(u.text).slice(0, 60)}”: ${err.message || err}`);
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
  // Another character being put on (it was just picked): what's to be said waits for it.
  if (avatarState === 'loading') await avatarLoaded;
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
  // What the words show, sentence by sentence, read from the whole utterance at once; carrying on
  // from the one before when it's the same speaker going on (an answer said as it's written).
  const auto = cfg.expressions !== 'off' && u.auto !== false;
  const goingOn = carried && carried.source === u.source && carried.who === u.who && (inFlight.size > 1 || performance.now() < carried.until);
  const { directions, state } = auto ? directOn(list.map((s) => s.text), { mood: cfg.mood, from: goingOn ? carried.state : null }) : { directions: [], state: null };
  carried = state && { state, source: u.source, who: u.who, until: Infinity };
  const asked = { mood: u.mood, expression: u.expression, gesture: u.gesture, head: u.head, pose: u.pose };
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
    const d = merge({ asked: i === 0 ? asked : {}, auto: directions[i] || null, cues: list[i].cues });
    const seconds = audio.ms / 1000;
    const markers = [];
    const mtimes = [];
    const first = i === 0;
    markers.push(() => {
      if (first) bridge.event({ type: 'started', id: u.id });
      bridge.event({ type: 'sentence', id: u.id, text: list[i].text, duration: seconds });
      caption(list[i].text);
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
    if (!queue.length && !inFlight.size) {
      // Nothing more to say: back to the resting mood, facing the user; a sentence soon after still carries on.
      if (head.getMood() !== cfg.mood) head.setMood(cfg.mood);
      if (!busy.on) turnTo(0, 800);
      if (carried) {
        Object.assign(carried.state, { mood: cfg.mood, facing: 'user', squareOn: 0 });
        carried.until = performance.now() + 3000;
      }
    }
    caption(document.getElementById('caption').textContent, 2500);
    bridge.event({ type: 'ended', id: u.id });
    updateBusy(); // said, and still working: back to it
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
  carried = null;
  head.stopSpeaking();
  tts.clear();
  const again = [...inFlight.values()].filter((u) => !drop.has(u.id));
  inFlight.clear();
  queue.unshift(...again);
  caption('');
  if (!queue.length) {
    head.setMood(cfg.mood);
    turnTo(0, 600);
  }
  updateBusy();
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
  /** The voice, started again (after it failed), without reloading the character. */
  retryVoice: async () => {
    if (tts || !head) return { ok: !!tts };
    await connectVoice();
    return { ok: !!tts, message: ttsState.message };
  },
  ears: async ({ on, paused }) => {
    if (paused !== undefined) ears.pause(paused);
    if (on !== undefined) {
      await readyNow;
      ears.turn(on && avatarState === 'ready');
    }
  },
  /** What the assistant is doing, on the body: at work while it thinks or a tool runs (`tool`, by name; `page`, which way the page is). */
  attend: async ({ state, tool, page }) => {
    await avatarLoaded; // the voice may still be downloading: the body needn't wait for it
    if (avatarState !== 'ready') return;
    busy.wanted = state === 'thinking' || state === 'tool';
    setBrowser(state === 'tool' && BROWSER.test(tool || ''), page);
    if (state === 'thinking' && !inFlight.size && !busy.on) playExpression('thinking', 2.5);
    if (state === 'listening') head.lookAtCamera(1500);
    updateBusy();
  },
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
    drag = { x: e.screenX, y: e.screenY, at: performance.now(), moved: false };
    stage.setPointerCapture(e.pointerId);
    bridge.dragStart();
    head?.audioCtx.resume();
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.screenX - drag.x;
    const dy = e.screenY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    if (drag.moved) bridge.dragMove(dx, dy);
  });
  const end = (e) => {
    if (!drag) return;
    const click = !drag.moved && performance.now() - drag.at < 600 && e.type === 'pointerup';
    drag = null;
    bridge.dragEnd();
    // A click (not a drag) on the character shows or hides the chat.
    if (click) bridge.toggleChat();
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    bridge.showMenu();
  });
}

// ---------------------------------------------------------------- the ears

const ears = new Ears({
  transformers: abs('/renderer/ort-local.mjs'),
  onError: (message, detail) => problem('ears', message, detail),
  onState: (state) => {
    bridge.event({ type: 'ears', state });
    document.body.dataset.ears = state.state;
    // Someone's talking: it stops what it's doing, stands, turns, and looks at them.
    busy.hearing = state.state === 'hearing';
    updateBusy();
    if (busy.hearing && avatarState === 'ready' && !inFlight.size) {
      head.lookAtCamera(2000);
      turnTo(0, 450);
    }
  },
  onHeard: (p) => bridge.event({ type: 'heard', ...p }),
});

// ---------------------------------------------------------------- go

wireInput();
try {
  createHead();
} catch (err) {
  // No WebGL (or no audio): nothing can be shown or said, and the main process is told why.
  console.error('The avatar couldn’t start:', err);
  avatarState = 'failed';
  avatarMessage = `the 3D view couldn’t start (${err?.message || err})`;
  problem('avatar', avatarMessage, err?.stack || '');
  ttsState = { state: 'failed', message: 'the avatar couldn’t start' };
}
if (head) await Promise.all([loadAvatar(), connectVoice()]);
report();
ready();
