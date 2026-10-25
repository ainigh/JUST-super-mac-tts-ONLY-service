// The character's page: TalkingHead draws it (head to toes, on a transparent canvas) and moves it;
// HeadTTS makes the voice (Kokoro, in the page: WebGPU, else WASM), with the timing of every word
// and viseme, so the lips follow the words exactly. Each sentence gets a mood, an expression, a
// gesture and a head movement: what was asked, the cues written in the text, and what the director
// reads in the sentences themselves (no model), and the way it faces, sentence by sentence. Its
// stance says how things stand: sitting about when there's nothing to do, on one knee with its face
// down and hands busy while it works, standing with its hands together while it waits on the Mac,
// standing and talking with its hands and head when it reports back. Its hands are kept out of its
// head (keep-clear.mjs). The ears (ears.mjs) listen here too. The main process sends commands
// (speak, stop, express, tts, ears, attend, tone, settings) and is told how it goes; a click on the
// character opens the chat.

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
    cameraView: 'full', // always head to toes: its stance says how things stand
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
  bothHands(head); // "wide", "bothup", "clasp", "hold" and "wring", for both hands at once
  // Its stance sets its pose (below): the moods don't change it on their own (some would kneel).
  for (const m of Object.values(head.animMoods)) m.anims = m.anims.filter((a) => a.name !== 'pose');
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
  resetStance();
  let done;
  avatarLoaded = new Promise((r) => (done = r));
  avatarState = 'loading';
  report();
  const c = characterOf(cfg.avatar);
  clear = null;
  centre.head = null;
  try {
    await head.showAvatar({ url: `./avatars/${c.file}`, body: c.body, avatarMood: cfg.mood, lipsyncLang: 'en', ...(c.baseline ? { baseline: c.baseline } : {}) });
    head.setView('full');
    clear = keepClear(head.armature);
    centre.base = head.armature.position.x;
    centre.head = head.armature.getObjectByName('Head');
    avatarState = 'ready';
    updateStance();
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

// ---------------------------------------------------------------- its stance: how things stand, head to toes

// Its whole body says how things stand, so a look at it is enough (always head to toes):
//   idle     nothing to do: it sits on the floor, hands at rest, and idles about: looks round, up,
//            at the user now and then, tilts its head, sways, shifts how it sits, rolls its neck,
//            sighs, yawns now and then
//   working  the assistant thinks, or a tool runs: down on one knee, face down at the work, turned
//            partly away (side on to the page, at the browser), hands busy: counting things off,
//            weighing them up, pointing, turning them over, "got it"; a soft pip every so often
//   waiting  runs on the Mac it asked for aren't over (waiting for Run, or running): it stands with
//            its hands together in front (clasped low, held at the waist, pressed, rubbed, palms
//            together), looks at the user and aside, and shifts its weight
//   talking  it's saying something (reporting back): it stands, faces the user, and its hands and
//            head go with the words: hands out and about, nods, tilts, a look aside and back
// The first that holds, in that order from talking up. A new stance is taken once it has held a
// moment (a quick answer doesn't kneel, a pause between sentences doesn't sit). When the user
// talks, it stops what it's doing and looks up at them, facing them, as it is.

/** ms a new stance must hold before it's taken. */
const SETTLE = { talking: 0, working: 700, waiting: 1200, idle: 2500 };
/** How much it looks at the user while it isn't talking. */
const EYE_CONTACT = { idle: 0.15, working: 0, waiting: 0.7, talking: 0.5 };
const WORK_TURN = 0.75; // radians: turned partly away, its face and hands still in view
const PAGE_TURN = 1.2; // side on to the page, at the browser
/** The tools that work in the browser (by name): for them it turns to the page. */
const BROWSER = /browser|chrome|safari|straw|web|fetch|url|page|site|search|navigate|click|scrape|google/i;

const stance = { now: null, want: null, timer: 0, timers: [], turn: 0, last: '', phase: 'idle', pending: 0, hearing: false, browser: false, page: 0, side: 1, hands: null };

/** Turns the whole body to `angle` (radians about the vertical) over `ms`, eased. */
function turnTo(angle, ms) {
  cancelAnimationFrame(stance.turn);
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
    if (k < 1) stance.turn = requestAnimationFrame(step);
  };
  stance.turn = requestAnimationFrame(step);
}

const later = (ms, fn) => stance.timers.push(setTimeout(fn, ms));
const between = (a, b) => a + Math.random() * (b - a);
const oneOf = (list) => list[Math.floor(Math.random() * list.length)];
const either = () => Math.random() < 0.5;
const standing = () => !!head.poseTarget?.template?.standing;

/** Looks down, never up: `deep` how far down (1 straight ahead, 2 well down). */
const lookDown = (deep, ms) => head.lookAt(null, innerHeight * deep, ms);
/** Looks somewhere about the window: `x`, `y` shares of its width and height (far aside turns the whole body). */
const lookAbout = (x, y, ms) => head.lookAt(innerWidth * x, innerHeight * y, ms);

// Head and body movements of its own, played as TalkingHead plays a nod (its yes and no turn to
// the camera first, which a face kept down at the work mustn't).
let moves = 0;
function move(dt, vs) {
  head.animQueue.push(head.animFactory({ name: `move${++moves}`, dt, vs }));
}
const nod = (k = 1) => move([[150, 250], [150, 250], [150, 300]], { headRotateX: [0.12 * k, 0.03 * k, 0] });
const shake = () => move([[150, 250], [200, 300], [200, 300], [150, 250]], { headRotateY: [-0.08, 0.08, -0.05, 0] });
function tilt(k = 1) {
  const z = between(0.1, 0.22) * k * oneOf([-1, 1]);
  move([[300, 600], [1200, 2600], [400, 800]], { headRotateZ: [z, z, 0] });
}
const neckRoll = () => move([[600, 900], [700, 1000], [600, 900]], { headRotateZ: [0.2, -0.2, 0], headRotateX: [-0.1, 0.06, 0] });
const sigh = () => move([[900, 1300], [500, 800], [1200, 1600]], { chestInhale: [1, 1, 0] });

/** Which way it faces at work: turned partly away (to one side, then the other), or side on to the page at the browser. */
function workAngle() {
  if (!stance.browser) return stance.side * WORK_TURN * between(0.85, 1.15);
  return (stance.page || stance.side) * PAGE_TURN * between(0.92, 1.06);
}

/** A hand gesture at work, the face kept down at it. */
function atWork(name, mirror = either()) {
  head.playGesture(name, between(1.2, 2.2), mirror, 600);
  lookDown(between(1.4, 1.9), 2600);
}

/** Its hands held together in front (until another gesture), for waiting. */
function together(name, ms = 700) {
  stance.hands = name;
  head.playGesture(name, null, false, ms);
}

/** Rubbing its hands: from held to pressed and back, a few times. */
function rub() {
  let n = 0;
  const step = () => {
    together(n % 2 ? 'hold' : 'wring', 260);
    if (++n < 6) later(300, step);
  };
  step();
}

const STANCES = {
  idle: {
    enter() {
      head.stopGesture(800);
      head.playPose('sitting');
      turnTo(between(-0.25, 0.25), 1500);
      head.lookAhead(2000);
    },
    angle: () => between(-0.25, 0.25),
    every: [1300, 3000],
    beats: [
      [3, 'about', () => lookAbout(between(0, 1), between(0.15, 0.7), between(1500, 3500))],
      [2, 'ahead', () => head.lookAhead(between(2000, 4000))],
      [1, 'user', () => head.lookAtCamera(1500)],
      [1, 'up', () => lookAbout(between(0.1, 0.9), 0, 2500)],
      [2, 'tilt', () => tilt()],
      [2, 'sway', () => turnTo(between(-0.35, 0.35), between(1500, 2500))],
      [1, 'shift', () => head.playPose('sitting')], // the other way round
      [1, 'neck', neckRoll],
      [1, 'sigh', sigh],
      [1, 'yawn', () => playExpression('sleepy', 2.5)],
      [1, 'face', () => playExpression(oneOf(['neutral', 'smile', 'glance']), 1.8)],
    ],
  },
  working: {
    enter() {
      head.stopGesture(500);
      stance.side = -stance.side; // not always the same way round
      head.playPose('oneknee');
      turnTo(workAngle(), 1100);
      lookDown(1.6, 2500);
      later(300, pips);
      later(between(6000, 10000), swapSides);
    },
    angle: workAngle,
    every: [1100, 2200],
    beats: [
      [3, 'count', () => atWork('index', stance.side < 0)], // counting things off
      [2, 'weigh', () => atWork('side')], // weighing it up
      [2, 'turn over', () => atWork('handup')], // turning it over
      [1, 'got it', () => atWork('ok', stance.side > 0)],
      [1, 'that one', () => atWork('thumbup')],
      [1, 'all of it', () => atWork('wide', false)],
      [2, 'read', () => lookDown(between(1.5, 2), 3000)],
      [1, 'checks out', () => (nod(), lookDown(1.6, 2000))],
      [1, 'not that', () => (shake(), lookDown(1.6, 2000))],
      [1, 'frown', () => (playExpression(oneOf(['thinking', 'pensive', 'unamused']), 2.2), lookDown(1.6, 2500))],
      [1, 'shift', () => (head.playPose('oneknee'), lookDown(1.6, 2500))], // the other knee
      [1, 'sway', () => turnTo(workAngle() + between(-0.2, 0.2), 1500)],
    ],
  },
  waiting: {
    enter() {
      if (!standing()) head.playPose(oneOf(['straight', 'side']));
      turnTo(0, 800);
      head.lookAtCamera(1800);
      together(oneOf(['hold', 'clasp']), 900);
    },
    angle: () => 0,
    every: [1400, 2800],
    beats: [
      [3, 'hold', () => together(stance.hands === 'clasp' ? 'hold' : 'clasp')],
      [2, 'rub', rub],
      [1, 'palms', () => together('namaste')],
      [2, 'user', () => head.lookAtCamera(2500)],
      [2, 'aside', () => lookAbout(oneOf([0.1, 0.9]), between(0.2, 0.4), 1500)],
      [1, 'tilt', () => tilt()],
      [1, 'weight', () => head.playPose(oneOf(['straight', 'side']))], // the hands stay together
      [1, 'glance', () => playExpression('glance', 1.6)],
      [1, 'nod', () => nod(0.6)],
    ],
  },
  talking: {
    enter() {
      head.stopGesture(600);
      if (!standing()) head.playPose(oneOf(['straight', 'side']));
      turnTo(0, 700);
      head.lookAtCamera(1500);
    },
    angle: () => 0,
    every: [800, 1600],
    // The hands move only when nothing is held (what the words show comes first).
    beats: [
      [3, 'hands', () => head.gesture || head.speakWithHands(0, 1)],
      [2, 'open', () => head.gesture || head.playGesture(oneOf(['side', 'index', 'handup']), between(1.2, 2), either(), 600)],
      [1, 'both', () => head.gesture || head.playGesture('wide', 1.6, false, 600)],
      [2, 'nod', () => nod(between(0.5, 1))],
      [2, 'tilt', () => tilt(0.8)],
      [1, 'aside', () => (lookAbout(oneOf([0.15, 0.85]), between(0.2, 0.35), 900), later(1100, () => head.lookAtCamera(1500)))],
      [1, 'turn', () => turnTo(between(-0.2, 0.2), 900)],
    ],
  },
};

/** What it should be doing now. */
function wanted() {
  if (queue.length || inFlight.size) return 'talking';
  if (stance.phase === 'thinking' || stance.phase === 'tool') return 'working';
  if (stance.pending > 0) return 'waiting';
  return 'idle';
}

/** Takes the stance wanted, once it has held (at once the first time). */
function updateStance() {
  if (avatarState !== 'ready' || !head?.armature) return;
  const want = wanted();
  if (want === stance.want) return; // taken, or on its way
  clearTimeout(stance.timer);
  stance.want = want;
  if (want === stance.now) return;
  stance.timer = setTimeout(() => {
    stance.timer = 0;
    if (stance.want === want) enter(want);
  }, stance.now ? SETTLE[want] : 0);
}

function enter(name) {
  stance.timers.forEach(clearTimeout);
  stance.timers = [];
  stance.now = name;
  stance.last = '';
  document.body.dataset.stance = name;
  head.opt.avatarIdleEyeContact = EYE_CONTACT[name];
  try {
    STANCES[name].enter();
  } catch (err) {
    console.warn(`Taking the ${name} stance failed:`, err);
  }
  later(900, beat);
}

/** Forgets the stance (another avatar is put on): the next is taken at once. */
function resetStance() {
  clearTimeout(stance.timer);
  stance.timers.forEach(clearTimeout);
  stance.timers = [];
  stance.timer = 0;
  stance.now = stance.want = null;
}

/** What it does next in its stance, weighted; never the same twice running (nothing while the user talks). */
function beat() {
  const s = STANCES[stance.now];
  if (!s) return;
  if (!stance.hearing) {
    const choices = s.beats.filter(([, name]) => name !== stance.last);
    let r = Math.random() * choices.reduce((n, [w]) => n + w, 0);
    const [, name, act] = choices.find(([w]) => (r -= w) < 0) || choices[0];
    stance.last = name;
    try {
      act();
    } catch (err) {
      console.warn('A beat failed:', err);
    }
  }
  later(between(...s.every), beat);
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

// A message to Peter, and one back from him: never said, a tone each instead. Two quick notes,
// rising for one to him, falling for his answer: each shorter than the ears take for speech.
const TONES = { 'to-peter': [587, 880], 'from-peter': [880, 587] };

function tone(which) {
  const notes = TONES[which];
  const ctx = head?.audioCtx;
  if (!notes || !ctx || ctx.state !== 'running') return;
  const t0 = ctx.currentTime;
  notes.forEach((hz, i) => {
    const t = t0 + i * 0.11;
    const osc = ctx.createOscillator();
    const level = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = hz;
    level.gain.setValueAtTime(0.0001, t);
    level.gain.exponentialRampToValueAtTime(0.07, t + 0.012);
    level.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    osc.connect(level).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.12);
  });
}

/** A pip every so often while it works (when the tone is on: it's read each time). */
function pips() {
  if (stance.now !== 'working') return;
  if (cfg.busyTone !== false) pip();
  later(PIP_EVERY, pips);
}

/** Now and then, at work, it turns to its other side (at the browser, the page stays where it is). */
function swapSides() {
  if (stance.now !== 'working') return;
  if (!stance.browser) stance.side = -stance.side;
  if (!stance.hearing) turnTo(workAngle(), 1600);
  later(between(8000, 13000), swapSides);
}

/** At the browser or not: at work, it turns to the page, or back from it, as the tool changes. */
function setBrowser(on, page) {
  stance.page = page || 0;
  if (stance.browser === on) return;
  stance.browser = on;
  if (stance.now === 'working' && !stance.hearing) turnTo(workAngle(), 1200);
}

/** The user talking, or not: it looks up at them and faces them; after, back to what it was doing. */
function setHearing(on) {
  if (stance.hearing === on) return;
  stance.hearing = on;
  if (avatarState !== 'ready' || !head?.armature || inFlight.size) return;
  if (on) {
    head.lookAtCamera(2000);
    turnTo(0, 450);
  } else if (STANCES[stance.now]) turnTo(STANCES[stance.now].angle(), 900);
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
  updateStance(); // something to say: it stands up to say it
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
      if (carried) {
        Object.assign(carried.state, { mood: cfg.mood, facing: 'user', squareOn: 0 });
        carried.until = performance.now() + 3000;
      }
    }
    caption(document.getElementById('caption').textContent, 2500);
    bridge.event({ type: 'ended', id: u.id });
    updateStance(); // said: back to work, waiting or sitting about, as things stand
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
  if (!queue.length) head.setMood(cfg.mood);
  updateStance();
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
  /**
   * What the assistant is doing, for its stance: its phase (at work while it thinks or a tool
   * runs; `tool`, by name; `page`, which way the page is), and `pending`, the runs on the Mac it
   * waits on.
   */
  attend: async ({ state, tool, page, pending }) => {
    stance.phase = state;
    stance.pending = pending || 0;
    await avatarLoaded; // the voice may still be downloading: the body needn't wait for it
    if (avatarState !== 'ready') return;
    setBrowser(state === 'tool' && BROWSER.test(tool || ''), page);
    updateStance();
  },
  /** A message to Peter, or from him: its tone. */
  tone: ({ which }) => tone(which),
  settings: async (patch) => {
    const before = cfg;
    cfg = { ...cfg, ...patch };
    if (!head) return;
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
    // Someone's talking: it stops what it's doing, turns, and looks up at them.
    setHearing(state.state === 'hearing');
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
