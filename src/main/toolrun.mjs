// Tool Mac Tool Run (http://127.0.0.1:8768): everything the model does on the Mac and the web
// beyond its schedule. Tool Mac Tool Run says what its tools are (GET /api/tools: each one's
// name, what it's for, its arguments, whether it waits for Run on the Mac, and a guide and
// examples for the model's instructions) and runs them (POST /api/tools/{name}). This only hands
// the list to the model and passes its calls through: it knows no tool, route or op of its own,
// so what Tool Mac Tool Run adds or changes is there the day it ships. A tool that runs something
// is streamed, so it can be cancelled at any point: while its card waits (hanging up takes the
// card away) or while it runs (it's stopped).

export const DEFAULT_URL = 'http://127.0.0.1:8768';
export const CLIENT = 'Super Face';
const MAX_OUTPUT = 12_000;
const MAX_EVENTS = 400; // stream events noted for one request (the Calls tab)

export class ToolRun {
  /**
   * @param {object} o
   * @param {() => string} o.url - read fresh for every call
   * @param {typeof fetch} [o.fetch]
   * @param {import('./trace.mjs').Trace} [o.trace] - where each request and its answer are noted
   */
  constructor({ url, fetch: f = globalThis.fetch, trace = null }) {
    this.urlOf = url;
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
   * Runs one of the model's calls: { text, failed, cancelled }, the text for the model.
   * `onStatus(s)` hears how a run is going: { state: 'sending' | 'waiting' | 'running' | 'done', request, run, output }.
   */
  async run(name, args = {}, { signal, onStatus = () => {}, log } = {}) {
    const tool = findTool(name, this.catalog);
    const why = str(args?.why) || 'You asked for it';
    // A tool that runs something (or a name Tool Mac Tool Run may take for a script) is followed live.
    const live = tool ? tool.stream : true;
    const path = `/api/tools/${encodeURIComponent(String(name).trim())}`;
    try {
      if (live) return await this.stream(path, { arguments: args, why }, { signal, onStatus, log, label: labelOf(name, args) });
      onStatus({ state: 'sending', label: labelOf(name, args) });
      const [status, json] = await this.call('POST', path, { arguments: args, why }, { signal, log, timeout: tool?.asks ? 150_000 : 30_000 });
      onStatus({ state: 'done', label: labelOf(name, args) });
      return answer(status, json);
    } catch (err) {
      if (signal?.aborted) return { text: 'Cancelled by the user.', failed: true, cancelled: true };
      return { text: err.message || String(err), failed: true };
    }
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
   * What fits some text best (the request at hand): the tools, scripts and flows Tool Mac Tool
   * Run's search gives, a line each as it writes them, or [] when nothing fits or it doesn't
   * answer in time.
   */
  async matches(text, { signal, limit = 6 } = {}) {
    const q = String(text ?? '').trim().slice(-300);
    if (!this.catalog.tools.length || !q) return [];
    const log = this.trace?.open({ kind: 'context', name: 'What fits the request', state: 'working' });
    const started = Date.now();
    let lines = [];
    try {
      const p = new URLSearchParams({ q, in: 'tools,scripts,flows', limit: String(limit), next: 'false' });
      const [status, json] = await this.call('GET', `/api/search?${p}`, null, { signal, log, timeout: 1500 });
      if (status >= 200 && status < 300 && Array.isArray(json.lines)) lines = json.lines.map(String).slice(0, limit);
    } catch {
      /* not this time */
    }
    this.trace?.change(log, { state: 'done', result: lines.length ? lines.join('\n') : '(nothing)', ms: Date.now() - started }, { final: true });
    return lines;
  }

  /** A call that runs something, streamed (see the API's "Streaming"), cancellable all the way through. */
  async stream(path, body, { signal, onStatus, log, label }) {
    if (signal?.aborted) return { text: 'Cancelled by the user before it was sent.', failed: true, cancelled: true };
    const started = Date.now();
    const sent = { client: CLIENT, ...body, stream: true };
    const n = this.note(log, { method: 'POST', url: this.url + path, body: sent, state: 'sending', events: [] });
    const events = n.rec.events || [];
    const noteEvent = (ev) => {
      if (events.length < MAX_EVENTS) events.push(ev);
      else if (ev.type !== 'output') events.push(ev);
      n.set({});
    };
    try {
      return await this.streamed(path, sent, { signal, onStatus, log, label, noteEvent, n });
    } finally {
      n.set({ state: n.rec.state === 'sending' || n.rec.state === 'streaming' ? 'done' : n.rec.state, ms: Date.now() - started }, true);
    }
  }

  async streamed(path, sent, { signal, onStatus, log, label, noteEvent, n }) {
    const ctrl = new AbortController();
    let request = null;
    let runId = null;
    let output = '';
    let cancelled = false;
    const onAbort = () => {
      cancelled = true;
      // Running: it's stopped on the Mac. Waiting: hanging up takes the card away.
      if (runId) this.call('POST', `/api/runs/${encodeURIComponent(runId)}/stop`, { why: 'The user cancelled it' }, { log }).catch(() => {});
      ctrl.abort();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    onStatus({ state: 'sending', label });
    try {
      let res;
      try {
        res = await this.fetch(this.url + path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Client': CLIENT },
          body: JSON.stringify(sent),
          signal: ctrl.signal,
        });
      } catch (err) {
        n.set({ state: cancelled ? 'cancelled' : 'failed', error: err.message });
        if (cancelled) return { text: 'Cancelled by the user before it was sent.', failed: true, cancelled: true };
        throw new Error(`Tool Mac Tool Run isn't answering at ${this.url}. Is it running, with its API on?`);
      }
      request = res.headers.get('x-request-id');
      const type = res.headers.get('content-type') || '';
      n.set({ status: res.status, request: request || undefined, state: 'streaming' });
      if (!type.includes('ndjson')) {
        // An answer at once: a tool that runs nothing, or an error before anything was asked (no
        // such script, a Flow mistake…).
        let json = {};
        try {
          json = await res.json();
        } catch {
          /* empty */
        }
        n.set({ response: json, request: request || json.request || undefined });
        onStatus({ state: 'done', request, ok: res.ok && json.ok !== false });
        return answer(res.status, json);
      }
      let buf = '';
      const decoder = new TextDecoder();
      try {
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
            request = ev.request || request;
            noteEvent(ev);
            switch (ev.type) {
              case 'waiting':
                onStatus({ state: 'waiting', request, label });
                break;
              case 'started':
                runId = ev.id || runId;
                onStatus({ state: 'running', request, run: runId, label });
                break;
              case 'output':
                output += ev.text || '';
                if (output.length > 2 * MAX_OUTPUT) output = output.slice(-MAX_OUTPUT);
                onStatus({ state: 'running', request, run: runId, output: output.slice(-2000), label });
                break;
              case 'denied':
                onStatus({ state: 'done', request, ok: false, label });
                return { text: trouble(403, ev), failed: true };
              case 'done':
                onStatus({ state: 'done', request, ok: ev.ok === true, label });
                return { text: outcome(ev), failed: ev.ok !== true };
              case 'error':
                onStatus({ state: 'done', request, ok: false, label });
                return { text: `It didn't work: ${ev.message || 'Tool Mac Tool Run reported an error'}.`, failed: true };
            }
          }
        }
      } catch (err) {
        if (!cancelled) throw err;
      }
      if (cancelled) {
        n.set({ state: 'cancelled' });
        onStatus({ state: 'done', request, ok: false, cancelled: true, label });
        const text = runId
          ? `Cancelled by the user while it was running: it was stopped.${output.trim() ? ` What it printed before:\n${tail(output)}` : ''}`
          : 'Cancelled by the user before it ran: the card on the Mac was taken away, and nothing ran.';
        return { text, failed: true, cancelled: true };
      }
      onStatus({ state: 'done', request, ok: false, label });
      return { text: 'The connection to Tool Mac Tool Run ended before the run did.' + (runId ? ` Its run id is ${runId}: the runs tool (op read) tells how it went.` : ''), failed: true };
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }
}


const EMPTY = { reachable: false, folder: null, tools: [], guide: [], examples: [], scripts: [], flows: [], upcoming: [], fetched: 0, error: null };

/** A tool there is, by its name or another it's known by; null when it isn't one listed. */
export function findTool(name, catalog) {
  const n = String(name ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const tools = catalog?.tools || [];
  return tools.find((t) => t.name === n) || tools.find((t) => t.aliases.includes(n)) || null;
}

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

/** What a tool's card shows while it works: the script, the address, the words. */
function labelOf(name, args = {}) {
  const what = [args.script, args.flow, args.url, args.q, args.name, args.op].find((v) => typeof v === 'string' && v.trim());
  return what ? `${name}: ${what}`.slice(0, 80) : String(name);
}

/** A tool's answer, for the model: a run's outcome, or its JSON without what's only for programs. */
function answer(status, json) {
  if (status < 200 || status >= 300) return { text: trouble(status, json), failed: true };
  if (json.state && ('output' in json || 'code' in json)) return { text: outcome(json), failed: json.ok === false };
  const { request: _, client: __, next: ___, tool: ____, ...rest } = json;
  return { text: clip(JSON.stringify(brief(rest))), failed: false };
}

/**
 * An answer that says itself in `lines` (a search, recall, the mind's, Chrome's find) is given as
 * those lines and its small fields: its nested objects say the same at many times the length.
 */
function brief(json) {
  if (!Array.isArray(json.lines)) return json;
  const out = {};
  for (const [k, v] of Object.entries(json)) {
    if (k === 'lines') out[k] = v.slice(0, 80);
    else if (typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 2000)) out[k] = v;
    else if (Array.isArray(v) && v.length <= 20 && v.every((x) => typeof x === 'string')) out[k] = v;
  }
  if (json.lines.length > 80) out.more = `${json.lines.length - 80} more lines`;
  return out;
}

/** Long JSON cut to what the model can read. */
const clip = (s) => (s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}… (cut short: ${s.length} characters in all; ask for less, e.g. find with words, a max or a limit)` : s);

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

/** How a run went, for the model: its state, exit code, time, and what it printed. */
export function outcome(r) {
  const name = r.name || 'the run';
  const state = r.state || 'unknown';
  let head = `${name}: ${state}`;
  if (Number.isFinite(r.code)) head += ` (exit code ${r.code})`;
  if (Number.isFinite(r.seconds)) head += `, ${Math.round(r.seconds * 100) / 100} seconds`;
  if (r.id) head += `, run id ${r.id}`;
  const lines = [head + '.'];
  if (r.problem) lines.push(`Problem: ${r.problem}`);
  if (Array.isArray(r.steps) && r.steps.length) lines.push(`Steps: ${r.steps.map((s) => `${s.name || '?'} ${s.state || '?'}`).join('; ')}.`);
  const out = String(r.output ?? '').trim();
  if (out) lines.push(`It printed:\n${tail(out)}`);
  else if (state !== 'running') lines.push('It printed nothing.');
  return lines.join('\n');
}

const tail = (s) => (s.length > MAX_OUTPUT ? '…' + s.slice(-MAX_OUTPUT) : s.trim());

function mistake(json) {
  let s = 'The Flow code has a mistake';
  if (json.line) s += ` on line ${json.line}`;
  s += `: ${json.message || json.error || 'unknown'}.`;
  if (json.fix) s += ` Fix: ${json.fix}`;
  return s;
}

/** What the model is told when a call didn't go through: what Tool Mac Tool Run said, its fix, and what to call instead. */
export function trouble(status, json = {}) {
  if (status >= 200 && status < 300) return null;
  const error = json.error || `status ${status}`;
  switch (json.code) {
    case 'denied':
      return "It didn't run: the user clicked Don't Run on their Mac. Don't send it again unless they ask.";
    case 'not_answered':
      return "It didn't run: no one clicked Run on the Mac within two minutes. Ask the user before sending it again.";
    case 'flow_mistake':
      return mistake(json);
    case 'straw_mistake':
      return mistake(json).replace('Flow', 'Straw');
  }
  const lines = [`Tool Mac Tool Run said ${status}${json.code ? ` (${json.code})` : ''}: ${error}${json.fix ? ` Fix: ${json.fix}` : ''}`];
  if (json.takes) lines.push(`${json.tool || 'The tool'} takes: ${json.takes}`);
  if (Array.isArray(json.tools) && json.tools.length) lines.push('What fits instead:', ...json.tools.map((t) => `- ${t}`));
  return lines.join('\n');
}

const str = (v) => (typeof v === 'string' ? (v.trim() ? v : null) : typeof v === 'number' ? String(v) : null);
