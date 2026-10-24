// The microphone, for the ears: its sound (with the browser's echo cancellation, so the
// character's own voice is mostly taken out, and noise suppression) at 16 kHz, in 32 ms frames,
// handed to the ears' worker (ears-worker.mjs), which tells speech from silence and writes down
// each phrase. The microphone is open only while the ears are on.

const TAP = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(512); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === 512) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('tap', Tap);
`;

export class Ears {
  /**
   * @param {object} o
   * @param {string} o.transformers - transformers.js's module URL
   * @param {(state: object) => void} o.onState - { state: 'off'|'loading'|'listening'|'hearing'|'writing'|'paused'|'failed', … }
   * @param {(p: {text: string, at: number, seconds: number}) => void} o.onHeard
   */
  constructor({ transformers, onState, onHeard }) {
    this.transformers = transformers;
    this.onState = onState;
    this.onHeard = onHeard;
    this.worker = null;
    this.modelReady = null; // resolves once the models are loaded
    this.stream = null;
    this.ctx = null;
    this.on = false;
    this.paused = false;
    this.state = 'off';
  }

  set(state, extra = {}) {
    this.state = state;
    this.onState({ state, ...extra });
  }

  /** The models, loaded once (the first time the ears go on). */
  load(model) {
    if (this.modelReady) return this.modelReady;
    this.worker = new Worker(new URL('./ears-worker.mjs', import.meta.url), { type: 'module' });
    this.modelReady = new Promise((resolve, reject) => {
      this.worker.onmessage = ({ data: m }) => {
        if (m.type === 'ready') {
          this.device = m.device;
          resolve();
        } else if (m.type === 'failed') {
          reject(new Error(m.message));
        } else if (m.type === 'progress') {
          if (this.on) this.set('loading', { progress: m.progress });
        } else if (m.type === 'state') {
          if (this.on && !this.paused && m.state !== 'loading') this.set(m.state);
        } else if (m.type === 'heard') {
          if (this.on && m.text) this.onHeard({ text: m.text, at: m.at, seconds: m.seconds });
        } else if (m.type === 'error') {
          console.warn('Ears:', m.message);
        }
      };
      this.worker.onerror = (e) => reject(new Error(e.message || 'the ears could not start'));
    });
    this.worker.postMessage({ type: 'init', transformers: this.transformers, model });
    this.modelReady.catch(() => {
      this.worker?.terminate();
      this.worker = null;
      this.modelReady = null;
    });
    return this.modelReady;
  }

  /** On: the microphone opens and phrases are written down. Off: it's closed. */
  async turn(on, { model } = {}) {
    if (on === this.on) return;
    this.on = on;
    if (!on) {
      this.close();
      this.set('off');
      return;
    }
    this.set('loading');
    try {
      await this.open();
      if (!this.on) return this.close();
      await this.load(model);
      if (!this.on) return;
      this.worker.postMessage({ type: 'reset' });
      this.set(this.paused ? 'paused' : 'listening', { device: this.device });
    } catch (err) {
      this.close();
      this.on = false;
      const denied = /denied|not allowed|permission/i.test(err?.message || '') || err?.name === 'NotAllowedError';
      const none = err?.name === 'NotFoundError';
      this.set('failed', {
        message: denied ? 'the microphone isn’t allowed: System Settings › Privacy & Security › Microphone' : none ? 'there’s no microphone' : err?.message || String(err),
      });
    }
  }

  /** Paused: the microphone stays open but nothing is written down (while it talks, if so set). */
  pause(paused) {
    if (paused === this.paused) return;
    this.paused = paused;
    if (!this.on || this.state === 'loading' || this.state === 'failed') return;
    if (!paused) this.worker?.postMessage({ type: 'reset' });
    this.set(paused ? 'paused' : 'listening');
  }

  async open() {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    this.ctx = new AudioContext({ sampleRate: 16000 });
    const url = URL.createObjectURL(new Blob([TAP], { type: 'text/javascript' }));
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const source = this.ctx.createMediaStreamSource(this.stream);
    const tap = new AudioWorkletNode(this.ctx, 'tap');
    tap.port.onmessage = ({ data }) => {
      if (this.on && !this.paused && this.worker) this.worker.postMessage({ type: 'frame', frame: data }, [data.buffer]);
    };
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    source.connect(tap).connect(mute).connect(this.ctx.destination);
    await this.ctx.resume();
  }

  close() {
    for (const t of this.stream?.getTracks() || []) t.stop();
    this.stream = null;
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
