// Peter (Tool Mac Agent, http://127.0.0.1:8770): the one this app asks to get anything done. He's
// a participant in the chat, not a tool: the model writes "@peter …" in plain words, Peter
// carries it out on the Mac (through Tool Mac Tool Run, which this app never calls itself) and
// answers in plain words. A run he asks for (a script or a flow, waiting for Run on the Mac), and
// anything scheduled through him, comes back by itself: he POSTs it to this app (reply_to: POST
// /api/peter here) the moment it's over, or due. GET /api/say/log says where each request stands,
// and POST /api/say/stop calls one off.

export const DEFAULT_URL = 'http://127.0.0.1:8770';
export const CLIENT = 'Super Face';

export class Peter {
  /**
   * @param {object} o
   * @param {() => string} o.url - read fresh for every call
   * @param {() => string|null} [o.replyTo] - where Peter tells this app a run is over (or something scheduled is due)
   * @param {typeof fetch} [o.fetch]
   */
  constructor({ url, replyTo = () => null, fetch: f = globalThis.fetch }) {
    this.urlOf = url;
    this.replyTo = replyTo;
    this.fetch = f;
    /** How Peter stood when last asked: whether he answers, and what he has behind him. */
    this.health = { reachable: false, error: 'not asked yet', checked: 0 };
  }

  get url() {
    let s = String(this.urlOf() || DEFAULT_URL).trim();
    if (!/^https?:/i.test(s)) s = `http://${s}`;
    return s.replace(/\/+$/, '');
  }

  /** Whether Peter answers, and whether Tool Mac Tool Run and his model do (GET /api/health). */
  async check({ timeout = 3000 } = {}) {
    try {
      const res = await this.fetch(`${this.url}/api/health`, { headers: { 'X-Client': CLIENT }, signal: AbortSignal.timeout(timeout) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.service !== 'peter') {
        this.health = { reachable: false, error: `something else answers at ${this.url}: is Peter (Tool Mac Agent) installed?`, checked: Date.now() };
      } else {
        const tm = j.tool_mac_tool_run || {};
        this.health = {
          reachable: true,
          error: tm.reachable ? null : "Peter is there, but Tool Mac Tool Run isn't answering him",
          version: j.version,
          toolMac: !!tm.reachable,
          scripts: tm.scripts || 0,
          flows: tm.flows || 0,
          model: j.model?.model || '',
          checked: Date.now(),
        };
      }
    } catch {
      this.health = { reachable: false, error: `Peter isn't answering at ${this.url}: is Peter (Tool Mac Agent) open?`, checked: Date.now() };
    }
    return this.health;
  }

  /**
   * Says something to Peter (POST /api/say): { text, failed, cancelled }, his answer for the model.
   * He's told where to say how a run went (reply_to). `exact`: only what fits one of his templates,
   * without his model (quick: for this app's own notes). `client`: who it's from (its own notes
   * are asked as another client, so the model's news isn't taken by them).
   */
  async say(text, { signal, timeout = 120_000, exact = false, client = CLIENT } = {}) {
    const url = `${this.url}/api/say${exact ? '?exact=true' : ''}`;
    const replyTo = client === CLIENT ? this.replyTo() : null;
    const headers = { 'Content-Type': 'text/plain; charset=utf-8', 'X-Client': client, ...(replyTo ? { 'X-Reply-To': replyTo } : {}) };
    let res;
    try {
      res = await this.fetch(url, { method: 'POST', headers, body: String(text), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) });
    } catch {
      if (signal?.aborted) return { text: 'Cancelled by the user before Peter answered.', failed: true, cancelled: true };
      this.health = { ...this.health, reachable: false, error: `Peter isn't answering at ${this.url}`, checked: Date.now() };
      return { text: `Peter isn't answering (he's Tool Mac Agent, at ${this.url}). Tell the user he needs to be open.`, failed: true };
    }
    const answer = (await res.text().catch(() => '')).trim();
    if (!this.health.reachable) this.health = { ...this.health, reachable: true, error: null };
    if (!res.ok) return { text: `Peter couldn't answer (${res.status}): ${errorOf(answer) || answer || 'no reason given'}`, failed: true };
    return { text: answer || '(Peter said nothing.)', failed: troubled(answer) };
  }

  /** What this app asked Peter for, and how each stands (GET /api/say/log): newest first, or [] when he doesn't answer. */
  async log({ signal } = {}) {
    try {
      const res = await this.fetch(`${this.url}/api/say/log`, { headers: { 'X-Client': CLIENT }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000) });
      const j = await res.json();
      return res.ok && Array.isArray(j.entries) ? j.entries : [];
    } catch {
      return [];
    }
  }

  /** Calls off something asked of Peter (by its number in his log): taken off the Mac while it waits for Run, stopped while it runs. The answer, in words. */
  async stop(number) {
    try {
      const res = await this.fetch(`${this.url}/api/say/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Client': CLIENT },
        body: JSON.stringify({ number }),
        signal: AbortSignal.timeout(10_000),
      });
      const j = await res.json().catch(() => ({}));
      return j.message || j.error || (res.ok ? 'Stopped.' : `It couldn't be stopped (${res.status}).`);
    } catch (err) {
      return `Peter isn't answering: ${err.message}`;
    }
  }
}

/** What Peter said was wrong, from his JSON. */
function errorOf(text) {
  try {
    const j = JSON.parse(text);
    return [j.error, j.fix].filter(Boolean).join(' ');
  } catch {
    return '';
  }
}

/** Peter's answer says it didn't go: for the critic, and for learning afterwards. */
export function troubled(answer) {
  return /\b(didn't work|couldn't (start|be)|isn't one of them|has no line called|I don't know how to do that|I can't tell which|There's no (script|tool|note)|Nothing came up|isn't answering|Nothing was done)\b/i.test(String(answer ?? ''));
}
