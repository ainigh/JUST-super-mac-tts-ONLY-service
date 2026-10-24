// The one model: Ollama's, on this Mac. Chats are streamed (the words are said as they come) and
// can be cancelled; thinking is off unless asked for, and any thinking is kept out of the answer.

export const CONTEXT_TOKENS = 16_384;

/** Models that do well with hand-rolled tool calls, best first: one of these is picked when none is chosen. */
const PREFERRED = ['qwen3', 'qwen2.5', 'gemma3', 'llama3.1', 'llama3.2', 'mistral', 'phi4', 'gpt-oss'];

export class ModelError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class Ollama {
  /**
   * @param {object} o
   * @param {() => {url: string, model: string, think?: boolean}} o.current - read fresh for every call
   * @param {typeof fetch} [o.fetch]
   * @param {import('./trace.mjs').Trace} [o.trace] - where each request and its answer are noted
   */
  constructor({ current, fetch: f = globalThis.fetch, trace = null }) {
    this.current = current;
    this.fetch = f;
    this.trace = trace;
    this.picked = '';
  }

  get url() {
    return String(this.current().url || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  }

  /** The models Ollama has, by name. */
  async models(signal) {
    let res;
    try {
      res = await this.fetch(`${this.url}/api/tags`, { signal: signal || AbortSignal.timeout(5000) });
    } catch (err) {
      if (err.name === 'AbortError' && signal?.aborted) throw err;
      throw new ModelError('unreachable', `Ollama isn't answering at ${this.url}. Is it running?`);
    }
    if (!res.ok) throw new ModelError('failed', `Ollama answered ${res.status}`);
    const data = await res.json();
    return (data.models || []).map((m) => m.name || m.model).filter(Boolean);
  }

  /** The model to use: the one chosen, else the best Ollama has. */
  async model(signal) {
    const chosen = this.current().model;
    if (chosen) return chosen;
    if (this.picked) return this.picked;
    const names = await this.models(signal);
    if (!names.length) throw new ModelError('no_model', 'Ollama has no model yet. In Terminal: ollama pull qwen3:8b');
    this.picked = pick(names);
    return this.picked;
  }

  /**
   * One answer to `messages`. With `onText`, it's streamed: onText(textSoFar) as it grows.
   * `purpose` names it in the trace (answer, learning).
   * @returns {Promise<string>} the answer, without any thinking
   */
  async chat(messages, { purpose = 'answer', ...o } = {}) {
    const started = Date.now();
    const rec = this.trace?.open({ purpose, model: this.current().model || this.picked || '', url: `${this.url}/api/chat`, messages: messages.map((m) => ({ role: m.role, content: m.content })), state: 'asking', text: '' });
    const note = (patch, final) => this.trace?.change(rec, { ms: Date.now() - started, ...patch }, { final });
    try {
      const text = await this.ask(messages, o, (patch) => note(patch));
      note({ state: 'done' }, true);
      return text;
    } catch (err) {
      note({ state: o.signal?.aborted ? 'cancelled' : 'failed', error: err.message || String(err) }, true);
      throw err;
    }
  }

  async ask(messages, { signal, onText, format, temperature, think } = {}, note = () => {}) {
    const model = await this.model(signal);
    const wantThink = think ?? !!this.current().think;
    const body = (sendThink) => {
      const b = { model, messages, stream: !!onText, keep_alive: '30m', options: { num_ctx: CONTEXT_TOKENS } };
      if (temperature !== undefined) b.options.temperature = temperature;
      if (format) b.format = format;
      if (sendThink) b.think = /gpt-oss/i.test(model) ? (wantThink ? 'medium' : 'low') : wantThink;
      return b;
    };
    const sent = ({ messages: _, ...rest }) => rest; // the request as sent, but for its messages (noted apart)
    note({ model, request: sent(body(true)) });
    let res = await this.post(body(true), signal);
    if (res.status === 400) {
      const text = await res.text();
      // Models that don't think say so when told not to: asked again without it.
      if (/think/i.test(text)) {
        note({ request: sent(body(false)) });
        res = await this.post(body(false), signal);
      } else throw new ModelError('failed', `Ollama: ${errorText(text)}`);
    }
    if (res.status === 404) {
      this.picked = '';
      throw new ModelError('no_model', `Ollama has no model called ${model}. In Terminal: ollama pull ${model}`);
    }
    if (!res.ok) throw new ModelError('failed', `Ollama answered ${res.status}: ${errorText(await res.text())}`);
    if (!onText) {
      const data = await res.json();
      note({ text: data.message?.content ?? '' });
      return stripThinking(data.message?.content ?? '');
    }
    let text = '';
    let buf = '';
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.error) throw new ModelError('failed', `Ollama: ${ev.error}`);
        const piece = ev.message?.content ?? '';
        if (piece) {
          text += piece;
          note({ text });
          onText(stripThinking(text, true));
        }
      }
    }
    return stripThinking(text);
  }

  async post(body, signal) {
    try {
      return await this.fetch(`${this.url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new ModelError('unreachable', `Ollama isn't answering at ${this.url}. Is it running?`);
    }
  }
}

/** The best of the models Ollama has, by PREFERRED (else the first; embedding models never). */
export function pick(names) {
  const usable = names.filter((n) => !/embed|bge|minilm|nomic/i.test(n));
  for (const p of PREFERRED) {
    const hit = usable.find((n) => n.toLowerCase().startsWith(p));
    if (hit) return hit;
  }
  return usable[0] || names[0] || '';
}

/** The answer without <think>…</think> (and, while streaming, without a <think> not closed yet). */
export function stripThinking(text, partial = false) {
  let s = String(text ?? '').replace(/<think>[\s\S]*?<\/think>/g, '');
  if (partial && s.includes('<think>')) s = s.slice(0, s.indexOf('<think>'));
  return partial ? s.replace(/^\s+/, '') : s.trim();
}

function errorText(text) {
  try {
    return JSON.parse(text).error || text;
  } catch {
    return String(text).slice(0, 200);
  }
}
