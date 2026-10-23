// Super Voice (http://127.0.0.1:8767): text → speech and speech → text.

const TTS_RATE = 24000; // Super Voice's Kokoro output: 24 kHz, mono, 16-bit

async function voiceError(res) {
  const body = await res.json().catch(() => ({}));
  const err = new Error(body.error || `Super Voice ${res.status}`);
  err.code = body.code;
  err.progress = body.progress;
  return err;
}

/** Is Super Voice running, and which parts are on? */
export async function voiceHealth(baseUrl) {
  const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2000) });
  return res.json();
}

/**
 * Speaks sentences one after another. Each sentence is synthesized as soon as
 * it's queued (so the next one is ready while the current one plays) and played
 * into TalkingHead's speech path, where HeadAudio turns the sound into lip-sync.
 */
export class Speaker {
  /**
   * @param {object} o
   * @param {AudioContext} o.ctx
   * @param {AudioNode} o.output - where speech goes (TalkingHead's analyzer → speech gain)
   * @param {() => {baseUrl: string, voice: string, speed: number}} o.settings
   */
  constructor({ ctx, output, settings }) {
    this.ctx = ctx;
    this.output = output;
    this.settings = settings;
    this.queue = [];
    this.source = null;
    this.playing = false;
    this.gen = 0;
    /** @type {(item: {text: string}) => void} */ this.onStart = null;
    /** @type {() => void} */ this.onIdle = null;
    /** @type {(err: Error) => void} */ this.onError = null;
  }

  get busy() {
    return this.playing || this.queue.length > 0;
  }

  say(text) {
    const ctrl = new AbortController();
    const item = { text, ctrl, pcm: this._synthesize(text, ctrl.signal) };
    item.pcm.catch(() => {}); // reported when its turn comes
    this.queue.push(item);
    if (!this.playing) this._run(this.gen);
  }

  /** Stop talking now and forget everything queued. */
  stop() {
    this.gen++;
    for (const item of this.queue) item.ctrl.abort();
    this.queue = [];
    try {
      this.source?.stop();
    } catch {
      /* already stopped */
    }
    this.source = null;
    this.playing = false;
  }

  async _run(gen) {
    this.playing = true;
    while (this.queue.length && gen === this.gen) {
      const item = this.queue.shift();
      let samples;
      try {
        samples = await item.pcm;
      } catch (err) {
        if (gen !== this.gen) return;
        if (err.name !== 'AbortError') this.onError?.(err);
        continue;
      }
      if (gen !== this.gen) return;
      if (!samples.length) continue;
      this.onStart?.(item);
      await this._play(samples);
    }
    if (gen !== this.gen) return;
    this.playing = false;
    this.onIdle?.();
  }

  _play(samples) {
    return new Promise((resolve) => {
      const buffer = this.ctx.createBuffer(1, samples.length, TTS_RATE);
      buffer.copyToChannel(samples, 0);
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.output);
      src.onended = () => {
        src.disconnect();
        if (this.source === src) this.source = null;
        resolve();
      };
      this.source = src;
      src.start();
    });
  }

  async _synthesize(text, signal) {
    const { baseUrl, voice, speed } = this.settings();
    const res = await fetch(`${baseUrl}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice, speed, format: 'pcm' }),
      signal,
    });
    if (!res.ok) throw await voiceError(res);
    const bytes = await res.arrayBuffer();
    const pcm = new Int16Array(bytes, 0, bytes.byteLength >> 1);
    const out = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
    return out;
  }
}

/** Records the microphone while held, then asks Super Voice what was said. */
export class Recorder {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.node = null;
    this.chunks = [];
    /** @type {(rms: number) => void} */ this.onLevel = null;
  }

  get recording() {
    return !!this.stream;
  }

  async start() {
    if (this.stream) return;
    if (!this.ctx) {
      this.ctx = new AudioContext();
      await this.ctx.audioWorklet.addModule('./recorder-worklet.js');
    }
    if (this.ctx.state !== 'running') await this.ctx.resume();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.chunks = [];
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'recorder');
    this.node.port.onmessage = (e) => {
      this.chunks.push(e.data.samples);
      this.onLevel?.(e.data.rms);
    };
    // A silent path to the output keeps the worklet running.
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    src.connect(this.node).connect(mute).connect(this.ctx.destination);
    this._src = src;
    this._mute = mute;
  }

  /** @returns {{pcm: Int16Array, rate: number, seconds: number}} */
  stop() {
    if (!this.stream) return { pcm: new Int16Array(0), rate: 16000, seconds: 0 };
    this.stream.getTracks().forEach((t) => t.stop());
    this._src.disconnect();
    this.node.disconnect();
    this._mute.disconnect();
    this.node.port.onmessage = null;
    this.stream = null;

    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const pcm = new Int16Array(total);
    let o = 0;
    for (const c of this.chunks) {
      for (let i = 0; i < c.length; i++) {
        const s = Math.max(-1, Math.min(1, c[i]));
        pcm[o++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
    }
    this.chunks = [];
    return { pcm, rate: this.ctx.sampleRate, seconds: total / this.ctx.sampleRate };
  }

  /** Abandon a recording without sending it. */
  cancel() {
    this.stop();
  }
}

export async function transcribe(baseUrl, { pcm, rate }) {
  const res = await fetch(`${baseUrl}/api/stt?format=pcm&rate=${rate}&channels=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: pcm.buffer,
  });
  if (!res.ok) throw await voiceError(res);
  const { text = '' } = await res.json();
  return text.trim();
}
