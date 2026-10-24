// Tool Mac Tool Run (http://127.0.0.1:8768): the user's scripts and flows, which reach everything
// on the Mac (the browser and the web, files, apps, notes). Every run puts a card on the Mac and
// waits for the user's click on Run. Runs are streamed, so one can be cancelled at any point:
// while the card waits (hanging up takes the card away) or while it runs (it's stopped).

export const DEFAULT_URL = 'http://127.0.0.1:8768';
export const CLIENT = 'Super Face';
const MAX_OUTPUT = 12_000;

/** The tools over Tool Mac Tool Run, as the model is told them. */
export const TOOLS = [
  {
    name: 'run_script',
    description:
      "Runs one of the user's scripts (listed below by name). A card on their Mac asks them first: the call waits for their click on Run, then for the script, and comes back with how it went and what it printed (or that they didn't click Run, or cancelled it).",
    args: [
      ['script', "string: its name, exactly as listed (e.g. utilities/weather.py)"],
      ['args', 'list of strings, optional: its arguments, one per input it takes, in order'],
      ['stdin', 'string, optional: text handed to it as input, for an input marked stdin'],
      ['why', 'string: why the user wants this, in their words; shown on the card they click'],
    ],
  },
  {
    name: 'run_flow',
    description: "Runs one of the user's flows (listed below), once they click Run on their Mac; comes back with how it went and what it printed.",
    args: [
      ['flow', 'string: its name, as listed'],
      ['args', 'list of strings, optional'],
      ['why', 'string: why the user wants this; shown on the card'],
    ],
  },
  {
    name: 'run_flow_code',
    description:
      'Runs Flow code you write, to chain scripts (run "utilities/weather.py" ["Paris"] gives what it printed), once the user clicks Run on their Mac, where the code is shown in full. Check it with check_flow first.',
    args: [
      ['source', 'string: the Flow code'],
      ['name', 'string, optional: what to call the run'],
      ['why', 'string: why the user wants this; shown on the card'],
    ],
  },
  { name: 'check_flow', description: 'Checks Flow code for mistakes without running anything (nothing is asked of the user).', args: [['source', 'string: the Flow code']] },
  { name: 'list_scripts', description: 'Lists the scripts again, fresh from Tool Mac Tool Run (they are already listed below; use it only if one seems missing).' },
  { name: 'list_runs', description: 'Lists the latest runs on the Mac, newest first, without their output.', args: [['limit', 'integer, optional: how many, default 10']] },
  { name: 'read_run', description: 'Reads one run in full, with its output.', args: [['id', "string: the run's id"]] },
  { name: 'stop_run', description: 'Stops a run that is still going (one the user started asks them first).', args: [['id', "string: the run's id"]] },
];

export const TOOL_NAMES = TOOLS.map((t) => t.name);

export class ToolRun {
  /**
   * @param {object} o
   * @param {() => string} o.url - read fresh for every call
   * @param {typeof fetch} [o.fetch]
   */
  constructor({ url, fetch: f = globalThis.fetch }) {
    this.urlOf = url;
    this.fetch = f;
    /** What there is to run, as last fetched. */
    this.catalog = { reachable: false, folder: null, scripts: [], flows: [], fetched: 0, error: 'not asked yet' };
  }

  get url() {
    let s = String(this.urlOf() || DEFAULT_URL).trim();
    if (!/^https?:/i.test(s)) s = `http://${s}`;
    return s.replace(/\/+$/, '');
  }

  /** A plain request: [status, json]. Throws only when nothing answers. */
  async call(method, path, body, { timeout = 15_000, signal } = {}) {
    let res;
    try {
      res = await this.fetch(this.url + path, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Client': CLIENT },
        body: body ? JSON.stringify({ client: CLIENT, ...body }) : undefined,
        signal: signal || AbortSignal.timeout(timeout),
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new Error(`Tool Mac Tool Run isn't answering at ${this.url}. Is it running, with its API on?`);
    }
    let json = {};
    try {
      json = await res.json();
    } catch {
      /* not JSON */
    }
    return [res.status, json];
  }

  /** Fetches the scripts and flows (for the model's prompt and the chat's tool list). */
  async refresh() {
    try {
      const [status, scripts] = await this.call('GET', '/api/scripts', null, { timeout: 5000 });
      if (status < 200 || status >= 300) {
        this.catalog = { ...this.catalog, reachable: status !== 0, scripts: [], flows: [], fetched: Date.now(), error: trouble(status, scripts) };
        return this.catalog;
      }
      let flows = {};
      try {
        const [fs, fj] = await this.call('GET', '/api/flows', null, { timeout: 5000 });
        if (fs >= 200 && fs < 300) flows = fj;
      } catch {
        /* scripts without flows */
      }
      this.catalog = {
        reachable: true,
        folder: scripts.folder || null,
        scripts: (scripts.scripts || []).filter((s) => s?.name).map(scriptJSON),
        flows: (flows.flows || []).filter((f) => f?.name).map((f) => ({ name: f.name, summary: f.summary || '', inputs: inputsOf(f.inputs) })),
        fetched: Date.now(),
        error: null,
      };
    } catch (err) {
      this.catalog = { reachable: false, folder: null, scripts: [], flows: [], fetched: Date.now(), error: err.message };
    }
    return this.catalog;
  }

  /**
   * Runs a tool; the answer is text for the model. `onStatus(s)` hears how a run is going:
   * { state: 'sending' | 'waiting' | 'running' | 'done', request, run, output }.
   */
  async run(name, args = {}, { signal, onStatus = () => {} } = {}) {
    try {
      switch (name) {
        case 'list_scripts': {
          const c = await this.refresh();
          if (!c.reachable || c.error) return c.error || "Tool Mac Tool Run didn't answer.";
          if (!c.scripts.length) return `There are no scripts in the folder (${c.folder || 'no folder'}).`;
          return JSON.stringify(c.scripts.map((s) => ({ name: s.name, does: s.summary || undefined, takes: s.inputs.length ? s.inputs : undefined })));
        }
        case 'run_script': {
          const script = str(args.script ?? args.name);
          if (!script) return 'Say which script: its name, as listed.';
          const body = { script };
          const a = list(args.args ?? args.arguments);
          if (a) body.args = a;
          const stdin = str(args.stdin ?? args.input);
          if (stdin) body.stdin = stdin;
          body.why = str(args.why ?? args.reason) || 'The user asked for it';
          return await this.stream('/api/run', body, { signal, onStatus, label: script });
        }
        case 'run_flow': {
          const flow = str(args.flow ?? args.name);
          if (!flow) return 'Say which flow: its name, as listed.';
          const body = { flow, why: str(args.why ?? args.reason) || 'The user asked for it' };
          const a = list(args.args ?? args.arguments);
          if (a) body.args = a;
          return await this.stream('/api/compose', body, { signal, onStatus, label: flow });
        }
        case 'run_flow_code': {
          const source = str(args.source ?? args.code);
          if (!source) return 'Give the Flow code as source.';
          const body = { source, why: str(args.why ?? args.reason) || 'The user asked for it' };
          const n = str(args.name);
          if (n) body.name = n;
          return await this.stream('/api/compose', body, { signal, onStatus, label: n || 'Flow code' });
        }
        case 'check_flow': {
          const source = str(args.source ?? args.code);
          if (!source) return 'Give the Flow code as source.';
          const [status, json] = await this.call('POST', '/api/check', { source }, { signal });
          if (json.ok === true) {
            const b = (json.bindings || []).map((x) => `${x.name}: ${x.type}`);
            return `The code is fine.${b.length ? ` It defines ${b.join(', ')}.` : ''}`;
          }
          return trouble(status, json) || mistake(json);
        }
        case 'list_runs': {
          const limit = Math.min(50, Math.max(1, Number(args.limit) || 10));
          const [status, json] = await this.call('GET', `/api/runs?limit=${limit}`, null, { signal });
          const t = trouble(status, json);
          if (t) return t;
          const runs = json.runs || [];
          if (!runs.length) return 'There are no runs yet.';
          return JSON.stringify(runs.map((r) => ({ id: r.id, name: r.name, state: r.state, started: r.started, seconds: r.seconds, requested_by: r.requested_by })));
        }
        case 'read_run': {
          const id = str(args.id ?? args.run);
          if (!id) return "Give the run's id.";
          const [status, json] = await this.call('GET', `/api/runs/${encodeURIComponent(id)}`, null, { signal });
          return trouble(status, json) || outcome(json);
        }
        case 'stop_run': {
          const id = str(args.id ?? args.run);
          if (!id) return "Give the run's id.";
          const [status, json] = await this.call('POST', `/api/runs/${encodeURIComponent(id)}/stop`, { why: str(args.why) || 'The user asked to stop it' }, { signal, timeout: 150_000 });
          return trouble(status, json) || (json.stopping ? 'Stopping it.' : 'It had already ended.');
        }
      }
      return null;
    } catch (err) {
      if (signal?.aborted) return 'Cancelled by the user.';
      return err.message || String(err);
    }
  }

  /** A run, streamed (see the API's "Streaming"), cancellable all the way through. */
  async stream(path, body, { signal, onStatus, label }) {
    if (signal?.aborted) return 'Cancelled by the user before it was sent.';
    const ctrl = new AbortController();
    let request = null;
    let runId = null;
    let output = '';
    let cancelled = false;
    const onAbort = () => {
      cancelled = true;
      // Running: it's stopped on the Mac. Waiting: hanging up takes the card away.
      if (runId) this.call('POST', `/api/runs/${encodeURIComponent(runId)}/stop`, { why: 'The user cancelled it' }).catch(() => {});
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
          body: JSON.stringify({ client: CLIENT, ...body, stream: true }),
          signal: ctrl.signal,
        });
      } catch (err) {
        if (cancelled) return 'Cancelled by the user before it was sent.';
        throw new Error(`Tool Mac Tool Run isn't answering at ${this.url}. Is it running, with its API on?`);
      }
      request = res.headers.get('x-request-id');
      const type = res.headers.get('content-type') || '';
      if (!type.includes('ndjson')) {
        // An error before anything was asked (no such script, a Flow mistake…), or an older
        // Tool Mac Tool Run that answers once it's over.
        let json = {};
        try {
          json = await res.json();
        } catch {
          /* empty */
        }
        onStatus({ state: 'done', request, ok: json.ok === true });
        return trouble(res.status, json) || outcome(json);
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
                return ev.code === 'not_answered'
                  ? "It didn't run: no one clicked Run on the Mac within two minutes. Ask the user before sending it again."
                  : "It didn't run: the user clicked Don't Run on their Mac. Don't send it again unless they ask.";
              case 'done':
                onStatus({ state: 'done', request, ok: ev.ok === true, label });
                return outcome(ev);
              case 'error':
                onStatus({ state: 'done', request, ok: false, label });
                return `It didn't work: ${ev.message || 'Tool Mac Tool Run reported an error'}.`;
            }
          }
        }
      } catch (err) {
        if (!cancelled) throw err;
      }
      if (cancelled) {
        onStatus({ state: 'done', request, ok: false, cancelled: true, label });
        return runId
          ? `Cancelled by the user while it was running: it was stopped.${output.trim() ? ` What it printed before:\n${tail(output)}` : ''}`
          : "Cancelled by the user before it ran: the card on the Mac was taken away, and nothing ran.";
      }
      onStatus({ state: 'done', request, ok: false, label });
      return 'The connection to Tool Mac Tool Run ended before the run did.' + (runId ? ` Its run id is ${runId}: read_run tells how it went.` : '');
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

function scriptJSON(s) {
  return {
    name: s.name,
    group: s.group || 'scripts',
    language: s.language_name || s.language || '',
    summary: s.summary || '',
    dangers: s.dangers || [],
    asksForInput: !!s.asks_for_input,
    inputs: inputsOf(s.inputs),
  };
}

function inputsOf(inputs) {
  return (inputs || []).map((i) => ({ prompt: i.prompt || '', kind: i.kind === 'stdin' ? 'stdin' : 'argument', optional: !!i.optional }));
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

/** What the model is told when a request didn't go through; null when it did. */
export function trouble(status, json = {}) {
  if (status >= 200 && status < 300) return null;
  const error = json.error || `status ${status}`;
  switch (json.code) {
    case 'denied':
      return "It didn't run: the user clicked Don't Run on their Mac.";
    case 'not_answered':
      return "It didn't run: no one clicked Run on the Mac within two minutes.";
    case 'endpoint_off':
      return `That's turned off in Tool Mac Tool Run on this Mac (${error}).`;
    case 'no_folder':
      return 'Tool Mac Tool Run has no scripts folder chosen yet; the user picks one in its panel.';
    case 'flow_mistake':
      return mistake(json);
    case 'unknown_script':
    case 'unknown_flow':
    case 'unknown_run':
    case 'unknown_request':
      return error;
  }
  return `Tool Mac Tool Run said ${status}: ${error}`;
}

const str = (v) => (typeof v === 'string' ? (v.trim() ? v : null) : typeof v === 'number' ? String(v) : null);

function list(v) {
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : typeof x === 'number' || typeof x === 'boolean' ? String(x) : JSON.stringify(x)));
  if (typeof v === 'string' && v.trim()) return v;
  if (typeof v === 'number') return [String(v)];
  return null;
}
