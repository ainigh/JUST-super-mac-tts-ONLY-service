import { TalkingHead } from 'talkinghead';
import { HeadAudio } from 'headaudio';
import { MotionEngine } from 'motion-engine';
import { AVATARS, DEFAULTS, isMaleVoice } from './config.js';
import { chatStream, listModels, ollamaClassifier } from './ollama.js';
import { Recorder, Speaker, transcribe, voiceHealth } from './voice.js';

const $ = (id) => document.getElementById(id);
const desk = window.desk;

let cfg; // DEFAULTS + saved settings
let head; // TalkingHead
let headaudio; // HeadAudio: lip-sync from the sound itself
let engine; // motion-engine: expressions and gestures
let speaker; // Super Voice TTS queue
const recorder = new Recorder();

let history = []; // chat messages, without the system prompt
let turn = null; // the reply being generated/spoken: { ctrl, reply, llmDone }
let captionTimer = 0;

// ---------------------------------------------------------------- status

const STATUS = {
  loading: 'Loading…',
  idle: 'Hold the mic or Space to talk',
  listening: 'Listening… let go to send',
  transcribing: 'Writing down what you said…',
  thinking: 'Thinking…',
  speaking: 'Speaking — talk to interrupt',
};

function setState(state, text) {
  document.body.dataset.state = state;
  $('status').textContent = text ?? STATUS[state] ?? '';
}

function showProblem(text) {
  document.body.dataset.problem = 'true';
  $('status').textContent = text;
}

function clearProblem() {
  delete document.body.dataset.problem;
}

function caption(text, { who = 'avatar', hold = 0 } = {}) {
  clearTimeout(captionTimer);
  const el = $('caption');
  el.textContent = text;
  el.dataset.who = who;
  el.hidden = !text;
  if (hold) captionTimer = setTimeout(() => (el.hidden = true), hold);
}

// ---------------------------------------------------------------- settings

async function loadSettings() {
  const saved = (await desk.getSettings()) || {};
  cfg = {
    ...DEFAULTS,
    ...saved,
    minConfidence: { ...DEFAULTS.minConfidence, ...(saved.minConfidence || {}) },
  };
}

const motionModel = () => cfg.motionModel || cfg.chatModel;

function systemPrompt() {
  return cfg.persona.replaceAll('{name}', cfg.name);
}

// ---------------------------------------------------------------- avatar

function createHead() {
  head = new TalkingHead($('avatar'), {
    ttsEndpoint: 'N/A', // speech comes from Super Voice, not TalkingHead's Google TTS
    lipsyncModules: [], // lip-sync comes from HeadAudio
    cameraView: cfg.cameraView,
    cameraRotateEnable: false,
    cameraPanEnable: false,
    cameraZoomEnable: false,
    mixerGainSpeech: 1,
    dracoEnabled: true,
    dracoDecoderPath: '/node_modules/three/examples/jsm/libs/draco/',
    avatarMood: 'neutral',
  });
  window.head = head; // handy in the developer tools
}

async function createHeadAudio() {
  await head.audioCtx.audioWorklet.addModule('/node_modules/@met4citizen/headaudio/dist/headworklet.min.mjs');
  headaudio = new HeadAudio(head.audioCtx, {
    parameterData: { speakerMeanHz: isMaleVoice(cfg.voice) ? 120 : 220 },
  });
  await headaudio.loadModel('/node_modules/@met4citizen/headaudio/dist/model-en-mixed.bin');

  // Speech → HeadAudio (lip-sync). Speech is delayed slightly on its way to the
  // speakers so the lips, which lag the analysis by 50–100 ms, line up with it.
  head.audioSpeechGainNode.connect(headaudio);
  const delay = new DelayNode(head.audioCtx, { delayTime: 0.08 });
  head.audioSpeechGainNode.disconnect(head.audioReverbNode);
  head.audioSpeechGainNode.connect(delay).connect(head.audioReverbNode);

  headaudio.onvalue = (key, value) => {
    const mt = head.mtAvatar?.[key];
    if (mt) Object.assign(mt, { newvalue: value, needsUpdate: true });
  };

  // Must be set before MotionEngine is created: it chains its own update after this one.
  head.opt.update = headaudio.update.bind(headaudio);

  let lastEnded = 0;
  headaudio.onended = () => (lastEnded = Date.now());
  headaudio.onstarted = () => {
    if (Date.now() - lastEnded > 150) {
      head.lookAtCamera(500);
      head.speakWithHands(); // does nothing while a motion-engine gesture is playing
    }
  };
}

async function loadAvatar() {
  const a = AVATARS[cfg.avatar] || AVATARS[DEFAULTS.avatar];
  setState('loading', 'Loading the avatar…');
  await head.showAvatar({ url: a.url, body: a.body, avatarMood: 'neutral', lipsyncLang: 'en' }, (ev) => {
    if (ev?.lengthComputable) setState('loading', `Loading the avatar… ${Math.round((ev.loaded / ev.total) * 100)}%`);
  });
}

function createEngine() {
  engine = new MotionEngine(head, {
    classify: cfg.chatModel ? makeClassifier() : null,
    director: { minConfidence: cfg.minConfidence },
  });
  engine.onDecision = (d) => {
    const played = d.actions.filter((a) => a.applied).map((a) => `${a.channel}:${a.name}`);
    console.debug(`[motion] ${d.speaker} “${d.text}” →`, played.join(' ') || '—', d.ms ? `${d.ms} ms` : '', d.error || d.skipped || '');
  };
  window.engine = engine;
}

function makeClassifier() {
  return ollamaClassifier({ baseUrl: cfg.ollamaUrl, model: motionModel(), thinking: cfg.thinking });
}

function createSpeaker() {
  speaker = new Speaker({
    ctx: head.audioCtx,
    output: head.audioAnalyzerNode, // analyzer → speech gain → (HeadAudio, delay → speakers)
    settings: () => ({ baseUrl: cfg.voiceUrl, voice: cfg.voice, speed: cfg.speed }),
  });

  speaker.onStart = ({ text }) => {
    head.isSpeaking = true; // motion-engine reads this
    setState('speaking');
    caption(text);
    // Each sentence goes to motion-engine as it starts playing, so the face and
    // gestures it picks land on the words they belong to.
    engine.feed(text, { speaker: 'avatar' });
  };

  speaker.onIdle = () => {
    head.isSpeaking = false;
    if (turn?.llmDone) finishTurn();
    else if (turn) setState('thinking');
  };

  speaker.onError = (err) => {
    if (err.code === 'model_loading') {
      showProblem(`Super Voice is getting the voices ready… ${Math.round((err.progress || 0) * 100)}%`);
    } else if (err.code === 'endpoint_off') {
      showProblem('Speech is turned off in Super Voice. Turn TTS on in its menu bar panel.');
    } else {
      showProblem(`Couldn’t speak: ${err.message}`);
    }
  };
}

// ---------------------------------------------------------------- conversation

// A sentence ends at . ! ? … (plus closing quotes/brackets) followed by a space, or at a line break.
const SENTENCE_END = /[.!?…]+["'”’)\]]*\s+|\n+/g;

function nextSentenceEnd(text) {
  SENTENCE_END.lastIndex = 0;
  let m;
  while ((m = SENTENCE_END.exec(text))) {
    const end = m.index + m[0].length;
    if (end >= 8) return end; // don't split off tiny fragments like "Hi. "
  }
  // A very long run without punctuation: break at the last comma or space.
  if (text.length > 240) {
    const cut = Math.max(text.lastIndexOf(', ', 220), text.lastIndexOf(' ', 220));
    if (cut > 40) return cut + 1;
  }
  return -1;
}

function speakable(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → their text
    .replace(/^\s*(#{1,6}|[-*•]|\d+[.)])\s+/gm, '')
    .replace(/[*_~#>]/g, '')
    .replace(/\p{Extended_Pictographic}\uFE0F?/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function respond(userText) {
  if (!cfg.chatModel) {
    showProblem('No Ollama model yet. Pull one (e.g. “ollama pull qwen3:8b”), then right-click › Reload.');
    return;
  }
  interrupt();
  clearProblem();

  history.push({ role: 'user', content: userText });
  history = history.slice(-24);
  engine.feed(userText, { speaker: 'user', final: true }); // a listening reaction
  setState('thinking');

  const me = { ctrl: new AbortController(), reply: '', llmDone: false };
  turn = me;
  let pending = '';

  try {
    const stream = chatStream({
      baseUrl: cfg.ollamaUrl,
      model: cfg.chatModel,
      thinking: cfg.thinking,
      messages: [{ role: 'system', content: systemPrompt() }, ...history],
      signal: me.ctrl.signal,
    });
    for await (const delta of stream) {
      if (turn !== me) return;
      me.reply += delta;
      pending += delta;
      let cut;
      while ((cut = nextSentenceEnd(pending)) > 0) {
        const sentence = speakable(pending.slice(0, cut));
        pending = pending.slice(cut);
        if (sentence) speaker.say(sentence);
      }
    }
    if (turn !== me) return;
    const rest = speakable(pending);
    if (rest) speaker.say(rest);
    me.llmDone = true;
    history.push({ role: 'assistant', content: me.reply.trim() });
    if (!speaker.busy) finishTurn();
  } catch (err) {
    if (err.name === 'AbortError' || turn !== me) return;
    turn = null;
    setState('idle');
    showProblem(
      err instanceof TypeError
        ? 'Can’t reach Ollama. Start it, then try again.'
        : `Ollama: ${err.message.replace(/^Ollama( \d+)?:\s*/, '')}`,
    );
  }
}

function finishTurn() {
  turn = null;
  engine.feed('', { speaker: 'avatar', final: true });
  setState('idle');
  caption($('caption').textContent, { hold: 2500 });
}

/** Stop the current reply: generation, speech and gestures. */
function interrupt() {
  if (turn) {
    turn.ctrl.abort();
    if (!turn.llmDone && turn.reply.trim()) {
      history.push({ role: 'assistant', content: `${turn.reply.trim()} …` });
    }
    turn = null;
  }
  speaker?.stop();
  if (head) head.isSpeaking = false;
  engine?.interrupt();
}

// ---------------------------------------------------------------- listening

let listenStartedAt = 0;

async function startListening() {
  if (recorder.recording) return;
  interrupt();
  clearProblem();
  try {
    await head.audioCtx.resume();
    await recorder.start();
  } catch (err) {
    showProblem('The microphone isn’t available. Allow it in System Settings › Privacy & Security › Microphone.');
    console.error(err);
    return;
  }
  listenStartedAt = performance.now();
  setState('listening');
  caption('');
  head.lookAtCamera(15000);
}

async function stopListening() {
  if (!recorder.recording) return;
  const rec = recorder.stop();
  $('mic').style.setProperty('--level', 0);
  if (rec.seconds < 0.35 || performance.now() - listenStartedAt < 350) {
    setState('idle');
    return;
  }
  setState('transcribing');
  try {
    const text = await transcribe(cfg.voiceUrl, rec);
    if (!text) {
      setState('idle');
      caption('I didn’t catch that.', { who: 'you', hold: 2500 });
      return;
    }
    caption(text, { who: 'you' });
    respond(text);
  } catch (err) {
    setState('idle');
    if (err.code === 'model_loading') {
      showProblem(`Super Voice is getting speech recognition ready… ${Math.round((err.progress || 0) * 100)}%`);
    } else if (err instanceof TypeError) {
      showProblem('Can’t reach Super Voice. Start it from your menu bar.');
    } else {
      showProblem(`Couldn’t transcribe: ${err.message}`);
    }
  }
}

function toggleListening() {
  if (recorder.recording) stopListening();
  else startListening();
}

recorder.onLevel = (rms) => {
  $('mic').style.setProperty('--level', Math.min(1, rms * 12).toFixed(3));
};

// ---------------------------------------------------------------- settings panel

function option(value, label, selected) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  o.selected = value === selected;
  return o;
}

async function openSettings() {
  const f = $('settings-form');
  f.avatar.replaceChildren(...Object.entries(AVATARS).map(([k, a]) => option(k, a.label, cfg.avatar)));

  let models = [];
  try {
    models = await listModels(cfg.ollamaUrl);
  } catch {
    /* Ollama not running: leave the lists with the saved values */
  }
  const withSaved = (v) => (v && !models.includes(v) ? [v, ...models] : models);
  f.chatModel.replaceChildren(...withSaved(cfg.chatModel).map((m) => option(m, m, cfg.chatModel)));
  f.motionModel.replaceChildren(
    option('', 'Same as conversation', cfg.motionModel || ''),
    ...withSaved(cfg.motionModel).map((m) => option(m, m, cfg.motionModel)),
  );

  let voices = [];
  try {
    voices = (await (await fetch(`${cfg.voiceUrl}/api/voices`)).json()).voices || [];
  } catch {
    voices = ['f1', 'f2', 'f3', 'm1', 'm2', 'm3'].map((alias) => ({ alias, name: alias }));
  }
  f.voice.replaceChildren(
    ...voices.map((v) =>
      option(v.alias, v.gender ? `${v.name} (${v.gender}, ${v.accent?.toUpperCase()})` : v.name, cfg.voice),
    ),
  );

  f.name.value = cfg.name;
  f.persona.value = cfg.persona;
  f.speed.value = cfg.speed;
  $('speed-value').textContent = `${Number(cfg.speed).toFixed(2)}×`;
  f.thinking.checked = cfg.thinking;
  f.ollamaUrl.value = cfg.ollamaUrl;
  f.voiceUrl.value = cfg.voiceUrl;
  $('settings').hidden = false;
  f.name.focus();
}

async function saveSettings(e) {
  e.preventDefault();
  const f = $('settings-form');
  const patch = {
    avatar: f.avatar.value,
    chatModel: f.chatModel.value,
    motionModel: f.motionModel.value,
    voice: f.voice.value,
    speed: Number(f.speed.value),
    name: f.name.value.trim() || DEFAULTS.name,
    persona: f.persona.value.trim() || DEFAULTS.persona,
    thinking: f.thinking.checked,
    ollamaUrl: f.ollamaUrl.value.trim().replace(/\/+$/, '') || DEFAULTS.ollamaUrl,
    voiceUrl: f.voiceUrl.value.trim().replace(/\/+$/, '') || DEFAULTS.voiceUrl,
  };
  const avatarChanged = patch.avatar !== cfg.avatar;
  await desk.saveSettings(patch);
  Object.assign(cfg, patch);
  $('settings').hidden = true;
  if (avatarChanged) {
    location.reload();
    return;
  }
  engine.useClassifier(cfg.chatModel ? makeClassifier() : null);
  headaudio.parameters.get('speakerMeanHz').value = isMaleVoice(cfg.voice) ? 120 : 220;
  clearProblem();
  setState('idle');
}

// ---------------------------------------------------------------- startup checks

async function checkServices() {
  const problems = [];

  try {
    const models = await listModels(cfg.ollamaUrl);
    if (!models.length) problems.push('Ollama has no models. Try “ollama pull qwen3:8b”.');
    else if (!cfg.chatModel || !models.includes(cfg.chatModel)) {
      cfg.chatModel = models[0];
      await desk.saveSettings({ chatModel: cfg.chatModel });
      engine.useClassifier(makeClassifier());
    }
  } catch {
    problems.push('Ollama isn’t running.');
  }

  try {
    const h = await voiceHealth(cfg.voiceUrl);
    if (!h.tts || !h.stt) problems.push('Turn on TTS and STT in Super Voice.');
  } catch {
    problems.push('Super Voice isn’t running.');
  }

  if (problems.length) showProblem(`${problems.join(' ')} Then right-click › Reload.`);
  else setState('idle');
}

// ---------------------------------------------------------------- input wiring

function wireInput() {
  // Hold the mic button to talk.
  const mic = $('mic');
  mic.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    mic.setPointerCapture(e.pointerId);
    startListening();
  });
  mic.addEventListener('pointerup', () => stopListening());
  mic.addEventListener('pointercancel', () => stopListening());

  // Or hold Space (when you're not typing).
  const typing = () => ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !e.repeat && !typing() && $('settings').hidden) {
      e.preventDefault();
      startListening();
    }
    if (e.key === 'Escape') {
      if (!$('settings').hidden) $('settings').hidden = true;
      else {
        interrupt();
        setState('idle');
      }
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && !typing()) stopListening();
  });

  // Or type.
  $('ask').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('message').value.trim();
    if (!text) return;
    $('message').value = '';
    $('message').blur();
    caption(text, { who: 'you' });
    head.audioCtx.resume();
    respond(text);
  });

  // Drag the avatar to move the window; right-click for the menu.
  const stage = $('stage');
  let drag = null;
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { x: e.screenX, y: e.screenY };
    stage.setPointerCapture(e.pointerId);
    desk.dragStart();
  });
  stage.addEventListener('pointermove', (e) => {
    if (drag) desk.dragMove(e.screenX - drag.x, e.screenY - drag.y);
  });
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    desk.dragEnd();
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    desk.showMenu();
  });

  $('settings-form').addEventListener('submit', saveSettings);
  $('settings-cancel').addEventListener('click', () => ($('settings').hidden = true));
  $('settings-form').speed.addEventListener('input', (e) => {
    $('speed-value').textContent = `${Number(e.target.value).toFixed(2)}×`;
  });

  desk.on('shortcut', (name) => {
    if (name === 'talk') toggleListening();
  });
  desk.on('click-through', (on) => document.body.classList.toggle('ghost', on));
  desk.on('menu', async (name, arg) => {
    if (name === 'settings') openSettings();
    if (name === 'clear') {
      interrupt();
      history = [];
      caption('');
      setState('idle');
    }
    if (name === 'view') {
      cfg.cameraView = arg;
      head.setView(arg);
      await desk.saveSettings({ cameraView: arg });
    }
  });
}

// ---------------------------------------------------------------- go

async function main() {
  await loadSettings();
  wireInput();
  createHead();
  try {
    await createHeadAudio();
    await loadAvatar();
  } catch (err) {
    console.error(err);
    showProblem(`The avatar didn’t load: ${err.message}. Did “npm install” download the avatars?`);
    return;
  }
  createEngine();
  createSpeaker();
  await checkServices();

  // A small hello.
  engine.face.play('happy');
  engine.body.play('wave');
  setTimeout(() => engine.face.play('neutral'), 2500);
}

main();
