// Collects microphone samples (mono, float) and posts them in ~40 ms batches.
class Recorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.round(sampleRate * 0.04);
    this.buf = new Float32Array(this.size);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) {
      let i = 0;
      while (i < ch.length) {
        const take = Math.min(ch.length - i, this.size - this.n);
        this.buf.set(ch.subarray(i, i + take), this.n);
        this.n += take;
        i += take;
        if (this.n === this.size) {
          let sum = 0;
          for (let k = 0; k < this.size; k++) sum += this.buf[k] * this.buf[k];
          this.port.postMessage({ samples: this.buf, rms: Math.sqrt(sum / this.size) }, [this.buf.buffer]);
          this.buf = new Float32Array(this.size);
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('recorder', Recorder);
