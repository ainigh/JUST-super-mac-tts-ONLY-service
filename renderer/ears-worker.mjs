// The ears, off the page's thread: the microphone's sound comes in 32 ms frames (16 kHz); Silero
// VAD says which frames are speech; a phrase ends at a pause, and Moonshine writes it down. Both
// models run through transformers.js (the one HeadTTS uses for the voice): on the GPU when there
// is one, else the CPU. They download once, the first time.

const RATE = 16000;
const FRAME = 512; // 32 ms
const PRE_ROLL = 10; // frames kept from before speech starts (the first syllable)
const MIN_SPEECH_MS = 250; // shorter: a click or a cough
const MAX_PHRASE_MS = 25_000;

let T; // transformers.js
let vadModel = null;
let vadState;
let vadRate;
let asr = null;
let cfg = { pauseMs: 750, model: 'onnx-community/moonshine-base-ONNX' };
let ready = false;

let recording = false;
let phrase = [];
let preRoll = [];
let speechFrames = 0;
let silentFrames = 0;
let noiseFloor = -60; // for the energy fallback
let chain = Promise.resolve(); // frames, one after another
let writing = Promise.resolve(); // phrases being written down, one after another

const post = (m) => self.postMessage(m);

self.onmessage = ({ data }) => {
  if (data.type === 'init') return init(data);
  if (data.type === 'config') cfg = { ...cfg, ...data.config };
  if (data.type === 'reset') return reset();
  if (data.type === 'frame' && ready) chain = chain.then(() => frame(data.frame)).catch((err) => post({ type: 'error', message: String(err?.message || err) }));
};

async function init({ transformers, model, pauseMs }) {
  cfg = { ...cfg, ...(model ? { model } : {}), ...(pauseMs ? { pauseMs } : {}) };
  try {
    post({ type: 'state', state: 'loading' });
    T = await import(transformers);
    T.env.logLevel = T.LogLevel?.ERROR ?? T.env.logLevel;
    T.env.allowLocalModels = false;
    let gpu = false;
    try {
      gpu = !!(await navigator.gpu?.requestAdapter());
    } catch {
      /* no WebGPU */
    }
    const progress = {};
    const onProgress = (p) => {
      if (p.status !== 'progress' || !p.total) return;
      progress[p.file] = [p.loaded, p.total];
      const [l, t] = Object.values(progress).reduce((a, [x, y]) => [a[0] + x, a[1] + y], [0, 0]);
      post({ type: 'progress', progress: Math.round((l / t) * 100) / 100 });
    };
    try {
      vadModel = await T.AutoModel.from_pretrained('onnx-community/silero-vad', { config: { model_type: 'custom' }, dtype: 'fp32', progress_callback: onProgress });
      vadState = new T.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
      vadRate = new T.Tensor('int64', [RATE], []);
    } catch (err) {
      console.warn('Silero VAD did not load; telling speech by loudness instead:', err);
      vadModel = null;
    }
    const load = (device) =>
      T.pipeline('automatic-speech-recognition', cfg.model, {
        device,
        dtype: device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : { encoder_model: 'fp32', decoder_model_merged: 'q8' },
        progress_callback: onProgress,
      });
    let device = gpu ? 'webgpu' : 'wasm';
    try {
      asr = await load(device);
      // A first, silent phrase: the GPU's shaders are compiled now, not on the first thing said.
      await asr(new Float32Array(RATE / 2));
    } catch (err) {
      if (device !== 'webgpu') throw err;
      console.warn('Moonshine on the GPU failed; on the CPU instead:', err);
      device = 'wasm';
      asr = await load(device);
    }
    ready = true;
    post({ type: 'ready', device, vad: vadModel ? 'silero' : 'energy' });
  } catch (err) {
    post({ type: 'failed', message: String(err?.message || err) });
  }
}

function reset() {
  recording = false;
  phrase = [];
  preRoll = [];
  speechFrames = 0;
  silentFrames = 0;
  if (vadModel) vadState = new T.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
}

/** Is this frame speech? Silero's say, with a lower bar once a phrase has begun. */
async function isSpeech(f) {
  if (vadModel) {
    const { stateN, output } = await vadModel({ input: new T.Tensor('float32', f, [1, f.length]), sr: vadRate, state: vadState });
    vadState = stateN;
    const p = output.data[0];
    return p > 0.5 || (recording && p > 0.35);
  }
  let sum = 0;
  for (const s of f) sum += s * s;
  const db = 10 * Math.log10(sum / f.length + 1e-10);
  // The floor follows the room: down at once, up slowly.
  noiseFloor = db < noiseFloor ? db : noiseFloor + 0.02;
  return db > Math.max(-50, noiseFloor + (recording ? 9 : 14));
}

async function frame(f) {
  const speech = await isSpeech(f);
  if (!recording) {
    preRoll.push(f);
    if (preRoll.length > PRE_ROLL) preRoll.shift();
    if (!speech) return;
    recording = true;
    phrase = [...preRoll];
    preRoll = [];
    speechFrames = 1;
    silentFrames = 0;
    post({ type: 'state', state: 'hearing' });
    return;
  }
  phrase.push(f);
  if (speech) {
    speechFrames++;
    silentFrames = 0;
  } else silentFrames++;
  const ms = (n) => (n * FRAME * 1000) / RATE;
  if (ms(silentFrames) >= cfg.pauseMs || ms(phrase.length) >= MAX_PHRASE_MS) end();
}

function end() {
  const frames = phrase;
  const spoke = speechFrames;
  recording = false;
  phrase = [];
  speechFrames = 0;
  silentFrames = 0;
  if ((spoke * FRAME * 1000) / RATE < MIN_SPEECH_MS) {
    post({ type: 'state', state: 'listening' });
    return;
  }
  const at = Date.now();
  const audio = new Float32Array(frames.length * FRAME);
  frames.forEach((x, i) => audio.set(x, i * FRAME));
  post({ type: 'state', state: 'writing' });
  writing = writing.then(async () => {
    try {
      const out = await asr(audio);
      const text = String(out?.text ?? '').trim();
      post({ type: 'heard', text, at, seconds: audio.length / RATE });
    } catch (err) {
      post({ type: 'error', message: `couldn't write down what was said: ${err?.message || err}` });
    }
    post({ type: 'state', state: recording ? 'hearing' : 'listening' });
  });
}
