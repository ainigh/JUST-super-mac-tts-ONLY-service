// Tool Mac Tool Run (http://127.0.0.1:8768): everything the model does on the Mac and the web
// beyond its schedule. The model talks to it as Peter, in plain words: POST /api/say takes what it
// wants and answers in words, with the result or with the templates that would do it (GET
// /api/say/forms gives the ones that fit a request ahead of time). A run it asks for (a script or
// a flow, waiting for Run on the Mac) is followed by Tool Mac Tool Run, which calls this app back
// when it's over (reply_to: POST /api/peter here); GET /api/say/log says where each stands, and
// POST /api/say/stop calls one off. This app also reads the tools list (for the chat), the mind's
// context, and its own notes, for itself.

export const DEFAULT_URL = 'http://127.0.0.1:8768';
export const CLIENT = 'Super Face';

export class ToolRun {
  /**
   * @param {object} o
   * @param {() => string} o.url - read fresh for every call
   * @param {() => string|null} [o.replyTo] - where Tool Mac Tool Run tells this app a run is over
   * @param {typeof fetch} [o.fetch]
   * @param {import('./trace.mjs').Trace} [o.trace] - where each request and its answer are noted
   */
  constructor({ url, replyTo = () => null, fetch: f = globalThis.fetch, trace = null }) {
    this.urlOf = url;
    this.replyTo = replyTo;
    this.fetch = f;
    this.trace = trace;
    /** What Tool Mac Tool Run has, as last fetched: its tools, and the scripts and flows they run. */
    this.catalog = { ...EMPTY, error: 'not asked yet' };
  }


  /**
   * Notes one HTTP exchange for the Calls tab, under `parent` (the tool call it's for) or, with
   * none, as an item of its own. Gives back set(patch) to fill it in as it goes.
   */
  note(parent, item) {
    const t = this.trace;
    if (!t) return { set() {}, rec: {} };
    const rec = { at: Date.now(), ...item };
    if (!parent) {
      const own = t.open({ kind: 'http', ...rec });
      return { rec: own, set: (patch, final) => t.change(own, patch, { final }) };
    }
    (parent.http ||= []).push(rec);
    t.change(parent);
    return { rec, set: (patch, final) => (Object.assign(rec, patch), t.change(parent, null, { final })) };
  }

  get url() {
    let s = String(this.urlOf() || DEFAULT_URL).trim();
    if (!/^https?:/i.test(s)) s = `http://${s}`;
    return s.replace(/\/+$/, '');
  }

  /** A plain request: [status, json]. Throws only when nothing answers. `log`: the tool call it's for. */
  async call(method, path, body, { timeout = 15_000, signal, log } = {}) {
    const started = Date.now();
    const sent = body ? { client: CLIENT, ...body } : undefined;
    const n = this.note(log, { method, url: this.url + path, body: sent, state: 'sending' });
    let res;
    try {
      res = await this.fetch(this.url + path, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Client': CLIENT },
        body: sent ? JSON.stringify(sent) : undefined,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
      });
    } catch (err) {
      n.set({ state: signal?.aborted ? 'cancelled' : 'failed', error: err.message, ms: Date.now() - started }, true);
      if (signal?.aborted) throw err;
      throw new Error(`Tool Mac Tool Run isn't answering at ${this.url}. Is it running, with its API on?`);
    }
    let text = '';
    let json;
    try {
      text = await res.text();
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    n.set({ state: 'done', status: res.status, request: res.headers.get('x-request-id') || json?.request || undefined, response: json === undefined ? text : json, ms: Date.now() - started }, true);
    return [res.status, json && typeof json === 'object' ? json : {}];
  }

  /** Fetches the tools, the scripts and flows (for the prompt and the chat's list), and what's coming up. */
  async refresh() {
    const log = this.trace?.open({ kind: 'catalog', name: 'Fetching the tools, scripts and flows', state: 'working' });
    const started = Date.now();
    try {
      return await this.fetchCatalog(log);
    } finally {
      const c = this.catalog;
      this.trace?.change(log, { state: c.error ? 'failed' : 'done', result: c.error || `${c.tools.length} tools, ${c.scripts.length} scripts, ${c.flows.length} flows`, ms: Date.now() - started }, { final: true });
    }
  }

  async fetchCatalog(log) {
    try {
      const [status, manifest] = await this.call('GET', '/api/tools', null, { timeout: 5000, log });
      if (status === 404) {
        this.catalog = { ...EMPTY, reachable: true, fetched: Date.now(), error: 'this Tool Mac Tool Run is too old to say what its tools are (it has no /api/tools): update it (run its install line again)' };
        return this.catalog;
      }
      if (status < 200 || status >= 300) {
        this.catalog = { ...EMPTY, reachable: true, fetched: Date.now(), error: trouble(status, manifest) };
        return this.catalog;
      }
      const tools = (Array.isArray(manifest.tools) ? manifest.tools : []).filter((t) => t?.name && t.on !== false).map(toolJSON);
      // The scripts and flows, by name, for the prompt and the chat (without them, the tools still work).
      const [[ss, sj], [fs, fj]] = await Promise.all([
        this.call('GET', '/api/scripts', null, { timeout: 5000, log }).catch(() => [0, {}]),
        this.call('GET', '/api/flows', null, { timeout: 5000, log }).catch(() => [0, {}]),
      ]);
      this.catalog = {
        reachable: true,
        folder: sj.folder || null,
        tools,
        guide: (manifest.guide || []).map(String),
        examples: Array.isArray(manifest.examples) ? manifest.examples : [],
        scripts: ss >= 200 && ss < 300 ? (sj.scripts || []).filter((s) => s?.name).map(scriptJSON) : [],
        flows: fs >= 200 && fs < 300 ? (fj.flows || []).filter((f) => f?.name).map((f) => ({ name: f.name, summary: f.summary || '' })) : [],
        upcoming: [],
        fetched: Date.now(),
        error: null,
      };
      // What's coming up in the next week (birthdays, events), for the model to know of.
      if (hasTool(this.catalog, 'memory')) {
        const r = await this.tool('memory', { op: 'upcoming', days: 7 }, { timeout: 5000, log }).catch(() => null);
        if (r?.ok && Array.isArray(r.json.lines)) this.catalog.upcoming = r.json.lines.map(String).slice(0, 20);
      }
    } catch (err) {
      this.catalog = { ...EMPTY, fetched: Date.now(), error: err.message };
    }
    return this.catalog;
  }

  /** One tool called for the app itself (its playbook, MEMORY on the user): { ok, status, json }. */
  async tool(name, args, { signal, timeout = 15_000, log } = {}) {
    const [status, json] = await this.call('POST', `/api/tools/${encodeURIComponent(name)}`, { arguments: args }, { signal, timeout, log });
    return { ok: status >= 200 && status < 300, status, json };
  }

  /**
   * What the mind has on some text (the things named in it, one step out): lines for the model's
   * prompt, or [] when there's no mind, nothing in it, or it doesn't answer in time.
   */
  async context(text, { signal, limit = 60 } = {}) {
    if (!hasTool(this.catalog, 'mind') || !String(text ?? '').trim()) return [];
    const log = this.trace?.open({ kind: 'context', name: 'What the mind has on this', state: 'working' });
    const started = Date.now();
    let lines = [];
    try {
      const [status, json] = await this.call('POST', '/api/mind/context', { text: String(text).slice(-4000), limit }, { signal, log, timeout: 2000 });
      if (status >= 200 && status < 300 && Array.isArray(json.lines)) lines = json.lines.map(String).slice(0, limit);
    } catch {
      /* not this time */
    }
    this.trace?.change(log, { state: 'done', result: lines.length ? lines.join('\n') : '(nothing)', ms: Date.now() - started }, { final: true });
    return lines;
  }

  /**
   * Says something to Tool Mac Tool Run in words (POST /api/say): { text, failed, cancelled }, its
   * answer for the model. It's told where to say how a run went (reply_to).
   */
  async say(text, { signal, log, timeout = 60_000 } = {}) {
    const started = Date.now();
    const url = `${this.url}/api/say`;
    const replyTo = this.replyTo();
    const headers = { 'Content-Type': 'text/plain; charset=utf-8', 'X-Client': CLIENT, ...(replyTo ? { 'X-Reply-To': replyTo } : {}) };
    const n = this.note(log, { method: 'POST', url, body: String(text), headers, state: 'sending' });
    let res;
    try {
      res = await this.fetch(url, { method: 'POST', headers, body: String(text), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) });
    } catch (err) {
      n.set({ state: signal?.aborted ? 'cancelled' : 'failed', error: err.message, ms: Date.now() - started }, true);
      if (signal?.aborted) return { text: 'Cancelled by the user before Peter answered.', failed: true, cancelled: true };
      return { text: `Peter isn't answering: Tool Mac Tool Run isn't reachable at ${this.url}. Tell the user it needs to be open, with its API on.`, failed: true };
    }
    const answer = (await res.text().catch(() => '')).trim();
    n.set({ state: 'done', status: res.status, response: answer, ms: Date.now() - started }, true);
    if (res.status === 404) return { text: "Peter can't be talked to in words: this Tool Mac Tool Run is too old (it has no /api/say). Tell the user to update it (run its install line again).", failed: true };
    if (res.status === 403) return { text: `Peter isn't allowed to answer: ${errorOf(answer) || 'Tool Mac Tool Run turned this app away'}. Tell the user to check Tool Mac Tool Run's API settings.`, failed: true };
    if (!res.ok) return { text: `Peter couldn't answer (${res.status}): ${errorOf(answer) || answer || 'no reason given'}`, failed: true };
    return { text: answer || '(Peter said nothing.)', failed: troubled(answer) };
  }

  /**
   * Peter's templates that fit some text (the request at hand), the best first, as he writes
   * them; [] when none fit or he doesn't answer in time.
   */
  async forms(text, { signal, limit = 3 } = {}) {
    const q = String(text ?? '').trim().slice(-300);
    if (!q || !this.catalog.reachable) return [];
    const log = this.trace?.open({ kind: 'context', name: "Peter's templates that fit the request", state: 'working' });
    const started = Date.now();
    let forms = [];
    try {
      const p = new URLSearchParams({ q, format: 'json' });
      const [status, json] = await this.call('GET', `/api/say/forms?${p}`, null, { signal, log, timeout: 1500 });
      if (status >= 200 && status < 300 && Array.isArray(json.forms)) forms = json.forms.map((f) => String(f.template ?? '')).filter(Boolean).slice(0, limit);
    } catch {
      /* not this time */
    }
    this.trace?.change(log, { state: 'done', result: forms.length ? forms.join('\n\n') : '(nothing)', ms: Date.now() - started }, { final: true });
    return forms;
  }

  /** What this app asked Peter for, and how each stands (GET /api/say/log): its entries, newest first, or [] when he doesn't answer. */
  async sayLog({ signal } = {}) {
    try {
      const [status, json] = await this.call('GET', '/api/say/log', null, { signal, timeout: 3000 });
      return status >= 200 && status < 300 && Array.isArray(json.entries) ? json.entries : [];
    } catch {
      return [];
    }
  }

  /**
   * Calls off something asked of Peter (by its number in his log): taken off the Mac while it
   * waits for Run, stopped while it runs. An older Tool Mac Tool Run without /api/say/stop has the
   * request taken back by its id. The answer, in words.
   */
  async stopSay(number, { request, log } = {}) {
    try {
      const [status, json] = await this.call('POST', '/api/say/stop', { number }, { log });
      if (status !== 404 || !request) return json.message || json.error || (status < 300 ? 'Stopped.' : `It couldn't be stopped (${status}).`);
      const [s2, j2] = await this.call('DELETE', `/api/requests/${encodeURIComponent(request)}`, null, { log });
      return s2 < 300 ? 'Taken back.' : j2.error || `It couldn't be stopped (${s2}).`;
    } catch (err) {
      return err.message;
    }
  }
}

const EMPTY = { reachable: false, folder: null, tools: [], guide: [], examples: [], scripts: [], flows: [], upcoming: [], fetched: 0, error: null };

/** Whether Tool Mac Tool Run has a tool of that name now (and it's on). */
export function hasTool(catalog, name) {
  return !!catalog?.tools?.some((t) => t.name === name);
}

/** A tool as the model is told it. */
function toolJSON(t) {
  return {
    name: String(t.name),
    description: String(t.description || ''),
    args: (Array.isArray(t.args) ? t.args : []).filter((a) => a?.name).map((a) => ({ name: String(a.name), type: String(a.type || 'string'), required: !!a.required, about: String(a.about || '') })),
    asks: !!t.asks_on_the_mac,
    stream: !!t.stream,
    aliases: (t.aliases || []).map((a) => String(a).toLowerCase()),
  };
}

function scriptJSON(s) {
  return {
    name: s.name,
    group: s.group || 'scripts',
    language: s.language_name || s.language || '',
    summary: s.summary || '',
    dangers: s.dangers || [],
    inputs: (s.inputs || []).map((i) => ({ prompt: i.prompt || '', kind: i.kind === 'stdin' ? 'stdin' : 'argument', optional: !!i.optional })),
  };
}

/** What Tool Mac Tool Run said was wrong, from its JSON. */
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
  return /\b(didn't work|couldn't (start|be)|isn't one of them|has no line called|I don't know how to do that|I can't tell which|There's no (script|tool|note)|Nothing came up)\b/i.test(String(answer ?? ''));
}
