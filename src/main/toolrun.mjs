// Tool Mac Tool Run (http://127.0.0.1:8768): the user's scripts and flows, which reach everything
// on the Mac (the browser and the web, files, apps, notes). Every run puts a card on the Mac and
// waits for the user's click on Run. Runs are streamed, so one can be cancelled at any point:
// while the card waits (hanging up takes the card away) or while it runs (it's stopped). What
// answers at once, without a card, has a tool each: the file library, MEMORY (remember, recall),
// the mind (what links to what), showing and copying, and Chrome's page (read only). Each is
// offered when Tool Mac Tool Run lists its group (GET /api/endpoints) and has it on; any other
// route it lists is reached with call_api, so what it adds later is there the day it ships. Where
// it answers GET /api/search, the model isn't handed every script and route: it gets their names,
// what fits the request at hand, and find for the rest.

export const DEFAULT_URL = 'http://127.0.0.1:8768';
export const CLIENT = 'Super Face';
const MAX_OUTPUT = 12_000;
const MAX_EVENTS = 400; // stream events noted for one request (the Calls tab)
/** Route groups the run tools cover (always): call_api is told only of the others, and of no group a tool below covers. */
const ALWAYS_COVERED = ['about', 'scripts', 'runs'];
const LIBRARY_OPS = ['list', 'names', 'read', 'read_many', 'exists', 'write', 'create', 'append', 'rename', 'copy', 'delete', 'search', 'find', 'recent', 'outline', 'backlinks', 'stats', 'trash', 'restore', 'empty_trash'];
/** MEMORY's own operations, beside the library's (remember and recall have tools of their own). */
const MEMORY_OPS = ['upcoming', 'categories', 'members', ...LIBRARY_OPS.filter((o) => o !== 'empty_trash')];
/** The mind's: asking, and adding (compacting the log, and deleting a scope, are the person's). */
const MIND_OPS = ['about', 'find', 'path', 'neighbors', 'query', 'edges', 'notes', 'dates', 'nodes', 'stats', 'add', 'note', 'rename', 'forget', 'check', 'append', 'comment'];
const BROWSER_OPS = ['url', 'tabs', 'page', 'has', 'find', 'highlight', 'outline'];
/** What a model tends to call the browser's ops. */
const BROWSER_ALIASES = {
  read: 'page', text: 'page', content: 'page', read_page: 'page', get_page: 'page', get_text: 'page', page_text: 'page',
  title: 'url', address: 'url', current: 'url', current_url: 'url', get_url: 'url', tab: 'url',
  list_tabs: 'tabs', windows: 'tabs',
  contains: 'has', check: 'has', exists: 'has', is_there: 'has',
  search: 'find', locate: 'find', where: 'find', find_text: 'find', look_for: 'find',
  show: 'highlight', point: 'highlight', ring: 'highlight', mark: 'highlight', show_where: 'highlight',
  headings: 'outline', structure: 'outline', layout: 'outline',
  state: 'status', is_open: 'status', chrome: 'status',
};
/** What the browser tool can't do: it only reads. */
const BROWSER_ACTS = /^(click|press|tap|type|fill|enter|input|submit|scroll|open|go|goto|go_to|navigate|visit|load|close|select|choose|hover|back|forward|refresh|reload|download|upload)(_|$)/;
export const MEMORY_FILES = ['PEOPLE', 'ORGANIZATIONS', 'EVENT-DATES', 'BIRTHDAYS', 'LOCATIONS', 'IDEAS', 'LEVERAGE', 'STRATEGIES', 'OTHERS'];

/** The ops the model is told of (it may use any of the rest too; each answers with what it takes). */
const LIBRARY_SAID = ['read', 'find', 'search', 'list', 'recent', 'append', 'write', 'create', 'rename', 'copy', 'delete', 'restore'];
const MIND_SAID = ['about', 'find', 'query', 'path', 'neighbors', 'dates', 'add', 'note', 'rename', 'forget'];
const more = (said, all) => `${said.join(', ')}${all.length > said.length ? '…' : ''}`;

/** The tools over Tool Mac Tool Run, as the model is told them: short, since a small model reads them with every message. */
export const TOOLS = [
  {
    name: 'run_script',
    description: "Runs one of the user's scripts (listed below). It waits for their click on Run on the Mac, then comes back with what it printed (or that they didn't click Run, or cancelled).",
    args: [
      ['script', 'string: its name, as listed (e.g. utilities/weather)'],
      ['args', 'list of strings, optional: one per input it takes, in order'],
      ['stdin', 'string, optional: for an input marked stdin'],
      ['why', 'string: why the user wants it, in their words; shown on the card'],
    ],
  },
  {
    name: 'run_flow',
    description: "Runs one of the user's flows (listed below), once they click Run on the Mac.",
    args: [
      ['flow', 'string: its name'],
      ['args', 'list of strings, optional'],
      ['why', 'string: shown on the card'],
    ],
  },
  {
    name: 'run_flow_code',
    description: 'Runs Flow code you write to chain scripts (run "utilities/weather.py" ["Paris"] gives what it printed), once the user clicks Run. Check it with check_flow first.',
    args: [
      ['source', 'string: the Flow code'],
      ['name', 'string, optional'],
      ['why', 'string: shown on the card'],
    ],
  },
  { name: 'check_flow', description: 'Checks Flow code for mistakes, running nothing.', args: [['source', 'string: the Flow code']] },
  { name: 'list_scripts', description: 'Lists the scripts again, fresh (they are already listed below; only if one seems missing).' },
  {
    name: 'find',
    needs: 'search',
    description: 'Finds the scripts, flows and routes for something by a few words ("weather", "play a song", "run Straw code"), best first, each with what it does and takes. Use it when unsure which script fits or what it takes, and before ever saying you can\'t.',
    args: [
      ['q', 'string: a few words'],
      ['in', 'string, optional: scripts, flows or routes'],
    ],
  },
  { name: 'list_runs', description: 'The latest runs on the Mac, without their output.', args: [['limit', 'integer, optional (10)']] },
  { name: 'read_run', description: 'One run in full, with its output.', args: [['id', "string: the run's id"]] },
  { name: 'stop_run', description: 'Stops a run that is still going.', args: [['id', "string: the run's id"]] },
  {
    name: 'library',
    group: 'library',
    description: "The user's notes (Markdown, by name). Answers at once, no click. Delete goes to its Trash (restore brings it back).",
    args: [
      ['op', `string: ${more(LIBRARY_SAID, LIBRARY_OPS)}`],
      ['name', "string: the note's name"],
      ['text', 'string: for write (replaces it all), create, append (a line at the end)'],
      ['q', 'string: words, for find and search'],
      ['to', 'string: the new name, for rename and copy'],
    ],
  },
  {
    name: 'remember',
    group: 'memory',
    description: 'Keeps something the user told you about their world, in MEMORY and the mind. Answers at once. Only what they said.',
    args: [
      ['category', `string: ${MEMORY_FILES.join(', ')}`],
      ['about', 'string: who or what ("Ada", "the dentist")'],
      ['text', 'string, optional: what they said, briefly'],
      ['links', 'list, optional: each {"label": "works at", "to": "Acme", "category": "ORGANIZATIONS"}'],
      ['notes', 'list of strings, optional: "birthday 03-14", "date 2026-11-03 dentist", "pref mornings"'],
    ],
  },
  {
    name: 'recall',
    group: 'memory',
    description: "What's remembered about a name: links, notes, dates, the lines that mention it. Answers at once.",
    args: [['name', 'string: as the user says it']],
  },
  {
    name: 'memory',
    group: 'memory',
    description: "The rest of MEMORY: what's coming up, who is in a category, its files. Answers at once.",
    args: [
      ['op', `string: upcoming, members, read, search, append, write…`],
      ['days', 'integer, optional: for upcoming (30)'],
      ['name', 'string: a file (PEOPLE…)'],
      ['q', 'string: for search'],
      ['text', 'string: for append and write'],
    ],
  },
  {
    name: 'mind',
    group: 'mind',
    description: 'What links to what (people, places, things), only ever added to. Answers at once. Rename and forget only when asked.',
    args: [
      ['op', `string: ${more(MIND_SAID, MIND_OPS)}`],
      ['name', 'string: a node'],
      ['q', 'string: words for find; for query, lines in its notation ("| x - works at | acme": who works at Acme)'],
      ['from', 'string: for add and path'],
      ['label', 'string: for add, a short verb ("works at")'],
      ['to', 'string: for add, path, rename'],
      ['note', 'string: for note ("todo call back Friday")'],
    ],
  },
  {
    name: 'show',
    group: 'screen',
    description: 'Shows the user something in a window in front of everything, with copy buttons: text you write, a file, or what the mind knows of something. For anything long or to copy; then say it in a sentence.',
    args: [
      ['title', 'string'],
      ['text', 'string: Markdown'],
      ['mind', 'string, optional: a node of the mind, instead of text'],
      ['shelf', 'string, optional: library, memory or system-docs, with name: a file, instead of text'],
      ['name', 'string, optional: with shelf'],
      ['why', 'string: a line on why'],
    ],
  },
  {
    name: 'copy',
    group: 'screen',
    description: "Puts text on the user's clipboard, to paste. Say that you did.",
    args: [['text', 'string']],
  },
  {
    name: 'chrome_page',
    group: 'browser',
    description: "Reads the page already in front of Chrome, to guide the user through a site: what it says, whether words are on it, where a thing is, a red ring around it. It only reads: it never opens a page, searches the web or clicks (to ask Google or open a page, run the browser/ scripts, such as browser/google). Tell the user what to click, then read again.",
    args: [
      ['op', `string: ${BROWSER_OPS.join(', ')}`],
      ['text', 'string: for has, find and highlight'],
    ],
  },
  {
    name: 'call_api',
    description: 'Calls a route of Tool Mac Tool Run\'s API that no tool above covers: one find gave you, one listed below, or one a result\'s "next" names. One that "asks on the Mac" waits for the click, like a run.',
    args: [
      ['method', 'string: GET, POST, PUT or DELETE'],
      ['path', 'string: the route, {name} filled in, ?query added'],
      ['body', 'object, optional: the JSON it takes'],
      ['why', 'string: shown on the card when it asks'],
    ],
  },
];

export const TOOL_NAMES = TOOLS.map((t) => t.name);

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
    /** What there is to run, as last fetched; `groups` are its routes (null: it doesn't list them). */
    this.catalog = { reachable: false, folder: null, scripts: [], flows: [], groups: null, fetched: 0, error: 'not asked yet' };
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

  /** Fetches the scripts and flows, and the routes there are (for the model's prompt and the chat's tool list). */
  async refresh() {
    const log = this.trace?.open({ kind: 'catalog', name: 'Fetching the scripts, flows and routes', state: 'working' });
    const started = Date.now();
    try {
      return await this.fetchCatalog(log);
    } finally {
      this.trace?.change(log, { state: this.catalog.error ? 'failed' : 'done', result: this.catalog.error || `${this.catalog.scripts.length} scripts, ${this.catalog.flows.length} flows, ${this.catalog.groups ? `${this.catalog.groups.length} route groups` : 'no route list'}`, ms: Date.now() - started }, { final: true });
    }
  }

  async fetchCatalog(log) {
    try {
      const [status, scripts] = await this.call('GET', '/api/scripts', null, { timeout: 5000, log });
      if (status < 200 || status >= 300) {
        this.catalog = { ...this.catalog, reachable: status !== 0, scripts: [], flows: [], groups: null, fetched: Date.now(), error: trouble(status, scripts) };
        return this.catalog;
      }
      let flows = {};
      try {
        const [fs, fj] = await this.call('GET', '/api/flows', null, { timeout: 5000, log });
        if (fs >= 200 && fs < 300) flows = fj;
      } catch {
        /* scripts without flows */
      }
      let groups = null;
      try {
        const [es, ej] = await this.call('GET', '/api/endpoints', null, { timeout: 5000, log });
        if (es >= 200 && es < 300 && Array.isArray(ej.groups)) groups = ej.groups.filter((g) => g?.id && Array.isArray(g.routes)).map(groupJSON);
      } catch {
        /* an older Tool Mac Tool Run: no route list */
      }
      // What's coming up in the next week (birthdays, events), for the model to know of.
      let upcoming = [];
      if (groups?.some((g) => g.id === 'memory' && g.on)) {
        try {
          const [us, uj] = await this.call('POST', '/api/memory', { op: 'upcoming', days: 7 }, { timeout: 5000, log });
          if (us >= 200 && us < 300 && Array.isArray(uj.lines)) upcoming = uj.lines.map(String).slice(0, 20);
        } catch {
          /* not this time */
        }
      }
      this.catalog = {
        reachable: true,
        folder: scripts.folder || null,
        scripts: (scripts.scripts || []).filter((s) => s?.name).map(scriptJSON),
        flows: (flows.flows || []).filter((f) => f?.name).map((f) => ({ name: f.name, summary: f.summary || '', inputs: inputsOf(f.inputs) })),
        groups,
        upcoming,
        fetched: Date.now(),
        error: null,
      };
    } catch (err) {
      this.catalog = { reachable: false, folder: null, scripts: [], flows: [], groups: null, fetched: Date.now(), error: err.message };
    }
    return this.catalog;
  }

  /**
   * Runs a tool; the answer is text for the model. `onStatus(s)` hears how a run is going:
   * { state: 'sending' | 'waiting' | 'running' | 'done', request, run, output }.
   */
  async run(name, args = {}, { signal, onStatus = () => {}, log } = {}) {
    try {
      switch (name) {
        case 'list_scripts': {
          const c = await this.refresh();
          if (!c.reachable || c.error) return c.error || "Tool Mac Tool Run didn't answer.";
          if (!c.scripts.length) return `There are no scripts in the folder (${c.folder || 'no folder'}).`;
          return JSON.stringify(c.scripts.map((s) => ({ name: s.name, does: s.summary || undefined, takes: s.inputs.length ? s.inputs : undefined })));
        }
        case 'run_script': {
          const named = str(args.script ?? args.name);
          if (!named) return 'Say which script: its name, as listed.';
          const script = findScript(named, this.catalog)?.name || named;
          const body = { script };
          const a = list(args.args ?? args.arguments);
          if (a) body.args = a;
          const stdin = str(args.stdin ?? args.input);
          if (stdin) body.stdin = stdin;
          body.why = str(args.why ?? args.reason) || 'The user asked for it';
          return await this.stream('/api/run', body, { signal, onStatus, log, label: script });
        }
        case 'run_flow': {
          const flow = str(args.flow ?? args.name);
          if (!flow) return 'Say which flow: its name, as listed.';
          const body = { flow, why: str(args.why ?? args.reason) || 'The user asked for it' };
          const a = list(args.args ?? args.arguments);
          if (a) body.args = a;
          return await this.stream('/api/compose', body, { signal, onStatus, log, label: flow });
        }
        case 'run_flow_code': {
          const source = str(args.source ?? args.code);
          if (!source) return 'Give the Flow code as source.';
          const body = { source, why: str(args.why ?? args.reason) || 'The user asked for it' };
          const n = str(args.name);
          if (n) body.name = n;
          return await this.stream('/api/compose', body, { signal, onStatus, log, label: n || 'Flow code' });
        }
        case 'check_flow': {
          const source = str(args.source ?? args.code);
          if (!source) return 'Give the Flow code as source.';
          const [status, json] = await this.call('POST', '/api/check', { source }, { signal, log });
          if (json.ok === true) {
            const b = (json.bindings || []).map((x) => `${x.name}: ${x.type}`);
            return `The code is fine.${b.length ? ` It defines ${b.join(', ')}.` : ''}`;
          }
          return trouble(status, json) || mistake(json);
        }
        case 'list_runs': {
          const limit = Math.min(50, Math.max(1, Number(args.limit) || 10));
          const [status, json] = await this.call('GET', `/api/runs?limit=${limit}`, null, { signal, log });
          const t = trouble(status, json);
          if (t) return t;
          const runs = json.runs || [];
          if (!runs.length) return 'There are no runs yet.';
          return JSON.stringify(runs.map((r) => ({ id: r.id, name: r.name, state: r.state, started: r.started, seconds: r.seconds, requested_by: r.requested_by })));
        }
        case 'read_run': {
          const id = str(args.id ?? args.run);
          if (!id) return "Give the run's id.";
          const [status, json] = await this.call('GET', `/api/runs/${encodeURIComponent(id)}`, null, { signal, log });
          return trouble(status, json) || outcome(json);
        }
        case 'stop_run': {
          const id = str(args.id ?? args.run);
          if (!id) return "Give the run's id.";
          const [status, json] = await this.call('POST', `/api/runs/${encodeURIComponent(id)}/stop`, { why: str(args.why) || 'The user asked to stop it' }, { signal, log, timeout: 150_000 });
          return trouble(status, json) || (json.stopping ? 'Stopping it.' : 'It had already ended.');
        }
        case 'find': {
          const q = str(args.q ?? args.query ?? args.words ?? args.text ?? args.what);
          if (!q) return 'Say what to look for: q, a few words.';
          const search = (kinds) => this.call('GET', `/api/search?${searchQuery(q, kinds, 8)}`, null, { signal, log });
          let [status, json] = await search(args.in);
          const t = trouble(status, json);
          if (t) return t;
          let lines = this.describe(json.results);
          // Nothing of the kind asked for: everything, said so (what does it may be another kind).
          let wider = '';
          if (!lines.length && args.in) {
            [status, json] = await search(null);
            lines = trouble(status, json) ? [] : this.describe(json.results);
            if (lines.length) wider = `Nothing of that kind matched "${q}"; these are everything that did:\n`;
          }
          if (lines.length) return wider + lines.join('\n');
          return `Nothing matched "${q}". Try other words, or fewer of them.${findScript('browser/google', this.catalog) ? ' For something the web answers, run browser/google with the question.' : ''}`;
        }
        case 'library':
          return await this.library(args, { signal, log });
        case 'remember':
          return await this.answer('POST', '/api/memory', rememberBody(args), { signal, log });
        case 'recall': {
          const n = str(args.name ?? args.about ?? args.q ?? args.query);
          if (!n) return 'Say whose or what name to recall.';
          return await this.answer('POST', '/api/memory', { op: 'recall', name: n }, { signal, log });
        }
        case 'memory':
          return await this.opOn('/api/memory', 'memory', MEMORY_OPS, args, { signal, log });
        case 'mind':
          return await this.opOn('/api/mind', 'mind', MIND_OPS, mindArgs(args), { signal, log });
        case 'show': {
          const body = pick(args, ['title', 'text', 'format', 'shelf', 'name', 'mind', 'why', 'copy']);
          if (typeof body.text !== 'string' && !body.mind && body.mind !== '' && !(body.shelf && body.name)) return 'Give the text to show (or a shelf and name, or a node of the mind).';
          if (body.text !== undefined && typeof body.text !== 'string') body.text = JSON.stringify(body.text, null, 2);
          body.why ||= 'You asked for it';
          return await this.answer('POST', '/api/present', body, { signal, log });
        }
        case 'copy': {
          const body = pick(args, ['text', 'shelf', 'name', 'mind']);
          if (!str(body.text) && !(body.shelf && body.name) && !body.mind) return 'Give the text to copy.';
          return await this.answer('POST', '/api/clipboard', body, { signal, log });
        }
        case 'chrome_page':
          return await this.browser(args, { signal, log });
        case 'call_api':
          return await this.callApi(args, { signal, log, onStatus });
      }
      return null;
    } catch (err) {
      if (signal?.aborted) return 'Cancelled by the user.';
      return err.message || String(err);
    }
  }

  /** The file library: one operation, answered at once (nothing is asked on the Mac). */
  async library(args, { signal, log }) {
    const { op: rawOp, ...rest } = args || {};
    const op = str(rawOp)?.toLowerCase().replace(/[\s-]+/g, '_');
    if (!op) return `Say which op: ${LIBRARY_OPS.join(', ')}.`;
    if (!LIBRARY_OPS.includes(op)) return `There's no library op called ${op}. The ops: ${LIBRARY_OPS.join(', ')}.`;
    const [status, json] = await this.call('POST', '/api/library', { op, ...rest }, { signal, log });
    if (status >= 200 && status < 300) {
      const { request: _, client: __, next: ___, ...answer } = json;
      return clip(JSON.stringify(answer));
    }
    return trouble(status, json);
  }

  /** A call that answers at once: its JSON, for the model (or what went wrong, with its fix). */
  async answer(method, path, body, { signal, log, timeout }) {
    const [status, json] = await this.call(method, path, body, { signal, log, timeout });
    if (status >= 200 && status < 300) {
      // "next" names routes; the tool the model called is already the way to them.
      const { request: _, client: __, ok: ___, next: ____, ...rest } = json;
      return clip(JSON.stringify(brief(rest)));
    }
    return trouble(status, json);
  }

  /** One operation by name on an endpoint that takes {"op"} (MEMORY, the mind). */
  async opOn(path, what, ops, args, { signal, log }) {
    const { op: rawOp, ...rest } = args || {};
    const op = str(rawOp)?.toLowerCase().replace(/[\s-]+/g, '_').replace(/^neighbours$/, 'neighbors');
    if (!op) return `Say which op: ${ops.join(', ')}.`;
    if (!ops.includes(op)) return `There's no ${what} op called ${op}. The ops: ${ops.join(', ')}.`;
    return this.answer('POST', path, { op, ...rest }, { signal, log });
  }

  /** Chrome's page: reading it, never acting on it. */
  async browser(args, { signal, log }) {
    const text = str(args.text ?? args.q ?? args.query ?? args.words ?? args.find ?? args.label ?? args.search);
    const said = str(args.op ?? args.what ?? args.action)?.toLowerCase().replace(/[\s-]+/g, '_');
    const op = said ? (BROWSER_ALIASES[said] ?? said) : text ? 'find' : 'url';
    if (BROWSER_ACTS.test(op)) return `chrome_page only reads the page in front of Chrome: it can't ${said.replace(/_/g, ' ')}. To open a page or ask Google, run a browser/ script (browser/open-page, browser/google); on the page, tell the user what to do (find, then highlight, shows them where), then read it again.`;
    if (op === 'status') return this.answer('GET', '/api/browser', null, { signal, log });
    if (!BROWSER_OPS.includes(op)) return `There's no chrome_page op called ${said}. The ops: ${BROWSER_OPS.join(', ')}. (To ask Google or open a page, run a browser/ script, such as browser/google.)`;
    if (['has', 'find', 'highlight'].includes(op) && !text) return `Say what to look for: text (for ${op}).`;
    if (op === 'highlight') return this.answer('POST', '/api/browser/highlight', { text, ...(args.seconds ? { seconds: Number(args.seconds) } : {}) }, { signal, log });
    const q = new URLSearchParams();
    if (text) q.set('text', text);
    if (op === 'page') q.set('max', String(Math.max(500, Math.min(20_000, Number(args.max) || 6000))));
    if (op === 'tabs' && args.all) q.set('all', 'true');
    return this.answer('GET', `/api/browser/${op}${q.size ? `?${q}` : ''}`, null, { signal, log, timeout: 20_000 });
  }

  /**
   * What the mind has on some text (the things named in it, one step out): lines for the model's
   * prompt, or [] when there's no mind, nothing in it, or it doesn't answer in time.
   */
  async context(text, { signal, limit = 60 } = {}) {
    if (!hasGroup(this.catalog, 'mind') || !String(text ?? '').trim()) return [];
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
   * What fits some text best (the request at hand), from GET /api/search: lines for the model's
   * prompt, each a script, flow or route with what it does and takes, or [] when there's no search,
   * nothing fits, or it doesn't answer in time. Routes a tool covers are left out.
   */
  async matches(text, { signal, limit = 6 } = {}) {
    const q = String(text ?? '').trim().slice(-300);
    if (!hasSearch(this.catalog) || !q) return [];
    const log = this.trace?.open({ kind: 'context', name: 'What fits the request', state: 'working' });
    const started = Date.now();
    let lines = [];
    try {
      const [status, json] = await this.call('GET', `/api/search?${searchQuery(q, null, limit + 4)}`, null, { signal, log, timeout: 1500 });
      if (status >= 200 && status < 300) lines = this.describe(json.results, { onlyOthers: true }).slice(0, limit);
    } catch {
      /* not this time */
    }
    this.trace?.change(log, { state: 'done', result: lines.length ? lines.join('\n') : '(nothing)', ms: Date.now() - started }, { final: true });
    return lines;
  }

  /** Search results, a line each, as the model calls them (a script described as the catalog has it). */
  describe(results, { onlyOthers = false } = {}) {
    const covered = coveredGroups(this.catalog);
    const lines = [];
    for (const r of Array.isArray(results) ? results : []) {
      if (r?.kind === 'script' && r.name) {
        lines.push(`script ${scriptLine(findScript(r.name, this.catalog) || scriptJSON(r))}`);
      } else if (r?.kind === 'flow' && r.name) {
        lines.push(`flow ${r.name}${r.summary ? `: ${r.summary}` : ''}`);
      } else if (r?.kind === 'route' && r.method && r.path) {
        if (r.group === 'about' || (onlyOthers && covered.includes(r.group))) continue;
        const tool = TOOLS.find((t) => t.group && t.group === r.group)?.name;
        lines.push(`route ${r.method} ${r.path}: ${r.summary || ''}${r.asks_on_the_mac ? ' [asks on the Mac]' : ''}${tool && covered.includes(r.group) ? ` (the ${tool} tool does this)` : ''}`);
      }
    }
    return lines;
  }

  /** Any route Tool Mac Tool Run lists. One that asks on the Mac waits for the click (up to its two minutes). */
  async callApi(args, { signal, log, onStatus }) {
    const method = (str(args.method) || 'GET').toUpperCase();
    let p = str(args.path ?? args.route ?? args.url);
    if (!p) return 'Give the path of the route, as listed (e.g. /api/straw).';
    // A whole address on this server comes down to its path; another server's never.
    if (/^https?:/i.test(p)) {
      const u = new URL(p);
      if (u.origin !== new URL(this.url).origin) return `call_api only reaches Tool Mac Tool Run (${this.url}).`;
      p = u.pathname + u.search;
    }
    if (!p.startsWith('/')) p = `/${p}`;
    if (!p.startsWith('/api/') && p !== '/api') return 'call_api is for routes under /api/, as listed.';
    if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) return 'The method is GET, POST, PUT or DELETE.';
    const route = this.routeFor(method, p);
    const asks = !!route?.asks;
    let body = args.body ?? args.json ?? args.data;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        return 'body must be a JSON object.';
      }
    }
    if (body !== undefined && (typeof body !== 'object' || Array.isArray(body) || body === null)) return 'body must be a JSON object.';
    if (method === 'GET' || method === 'DELETE') body = undefined;
    else body = { ...(body || {}), ...(asks ? { why: str(body?.why ?? args.why) || 'The user asked for it' } : {}) };
    onStatus({ state: asks ? 'waiting' : 'sending', label: `${method} ${p}` });
    const [status, json] = await this.call(method, p, body ?? (method === 'GET' || method === 'DELETE' ? null : {}), { signal, log, timeout: asks ? 150_000 : 30_000 });
    onStatus({ state: 'done', label: `${method} ${p}` });
    const t = trouble(status, json);
    if (t) return route ? t : `${t}${status === 404 ? ` That route isn't one listed: ${hasSearch(this.catalog) ? 'find the right one by a few words.' : 'use one from the list.'}` : ''}`;
    const { client: _, ...answer } = json;
    return `${method} ${p}: ${status}\n${clip(JSON.stringify(answer))}`;
  }

  /** The listed route a request is for ({name} matching any one segment), or null. */
  routeFor(method, p) {
    const pathOnly = p.split('?')[0];
    for (const g of this.catalog.groups || []) {
      for (const r of g.routes) {
        if (r.method !== method) continue;
        const re = new RegExp(`^${r.path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{[^}]+\\?\}/g, '[^/]+')}$`);
        if (re.test(pathOnly)) return r;
      }
    }
    return null;
  }

  /** A run, streamed (see the API's "Streaming"), cancellable all the way through. */
  async stream(path, body, { signal, onStatus, log, label }) {
    if (signal?.aborted) return 'Cancelled by the user before it was sent.';
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
        if (cancelled) return 'Cancelled by the user before it was sent.';
        throw new Error(`Tool Mac Tool Run isn't answering at ${this.url}. Is it running, with its API on?`);
      }
      request = res.headers.get('x-request-id');
      const type = res.headers.get('content-type') || '';
      n.set({ status: res.status, request: request || undefined, state: 'streaming' });
      if (!type.includes('ndjson')) {
        // An error before anything was asked (no such script, a Flow mistake…), or an older
        // Tool Mac Tool Run that answers once it's over.
        let json = {};
        try {
          json = await res.json();
        } catch {
          /* empty */
        }
        n.set({ response: json, request: request || json.request || undefined });
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
        n.set({ state: 'cancelled' });
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

/** Whether a route group answers there, and is on (an older Tool Mac Tool Run lists fewer, or none). */
export function hasGroup(catalog, id) {
  return !!catalog?.groups?.some((g) => g.id === id && g.on);
}

export const hasLibrary = (catalog) => hasGroup(catalog, 'library');

/** Whether it finds scripts, flows and routes by a few words (GET /api/search). */
export function hasSearch(catalog) {
  return !!catalog?.groups?.some((g) => g.routes.some((r) => r.method === 'GET' && r.path === '/api/search'));
}

/** A search's query string: the words, what kinds of thing, how many. */
function searchQuery(q, kinds, limit) {
  const p = new URLSearchParams({ q, limit: String(limit), next: 'false' });
  const k = String(kinds ?? '').toLowerCase().split(/[\s,]+/).filter((x) => ['scripts', 'flows', 'routes'].includes(x));
  if (k.length) p.set('in', k.join(','));
  return p;
}

/** The script a name means: as listed, without its extension, or by its last part. */
export function findScript(name, catalog) {
  const scripts = catalog?.scripts || [];
  const bare = (s) => s.replace(/\.[a-z0-9]+$/i, '');
  return (
    scripts.find((s) => s.name === name) ||
    scripts.find((s) => bare(s.name) === bare(name)) ||
    scripts.find((s) => bare(s.name.split('/').pop()) === bare(name.split('/').pop()))
  );
}

/** A script for the model: its name, what it does, what it takes, what can't be undone. */
export function scriptLine(s) {
  let l = s.name;
  if (s.summary) l += `: ${s.summary}`;
  if (s.inputs?.length) l += ` | takes: ${s.inputs.map((i) => `${i.kind === 'stdin' ? 'stdin ' : ''}${i.prompt}${i.optional ? ' (optional)' : ''}`).join('; ')}`;
  else if (s.asksForInput) l += ' | asks questions as it runs: answer them in stdin';
  if (s.dangers?.length) l += ` | can't be undone: ${s.dangers.join(', ')}`;
  return l;
}

/** The route groups a tool covers now (call_api isn't told of them). */
export function coveredGroups(catalog) {
  return [...ALWAYS_COVERED, ...new Set(TOOLS.filter((t) => t.group && hasGroup(catalog, t.group)).map((t) => t.group))];
}

/** The route groups call_api is for: those no other tool covers. */
export function otherGroups(catalog) {
  const covered = coveredGroups(catalog);
  return (catalog?.groups || []).filter((g) => !covered.includes(g.id));
}

/**
 * An answer that says itself in `lines` (recall, the mind's, Chrome's find) is given as those
 * lines and its small fields: its nested objects say the same at many times the length.
 */
function brief(json) {
  if (!Array.isArray(json.lines)) return json;
  const out = {};
  for (const [k, v] of Object.entries(json)) {
    if (k === 'lines') out[k] = v.slice(0, 80);
    else if (typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 300)) out[k] = v;
    else if (Array.isArray(v) && v.length <= 20 && v.every((x) => typeof x === 'string')) out[k] = v;
  }
  if (json.lines.length > 80) out.more = `${json.lines.length - 80} more lines`;
  return out;
}

/** remember's body: the category as MEMORY names its files, links and notes as lists. */
function rememberBody(a) {
  const category = str(a.category ?? a.file ?? a.kind)?.toUpperCase().replace(/[\s_]+/g, '-').replace(/^ORGANISATIONS$/, 'ORGANIZATIONS');
  const links = (Array.isArray(a.links) ? a.links : a.links ? [a.links] : [])
    .map((l) => (typeof l === 'string' ? { to: l } : l && typeof l === 'object' ? l : null))
    .filter((l) => l && str(l.to));
  const notes = (Array.isArray(a.notes) ? a.notes : a.notes ?? a.note ? [a.notes ?? a.note] : []).map(String).filter((x) => x.trim());
  const body = { op: 'remember', category: category || 'OTHERS', about: str(a.about ?? a.name ?? a.who ?? a.what) };
  const text = str(a.text ?? a.fact ?? a.details);
  if (text) body.text = text;
  if (links.length) body.links = links;
  if (notes.length) body.notes = notes;
  return body;
}

/** A mind call's arguments: a lone link given as from/label/to, or several as facts, as it takes them. */
function mindArgs(a) {
  const out = { ...(a || {}) };
  if (!out.op && (out.from || out.facts)) out.op = out.to && !out.label && !out.facts ? 'path' : 'add';
  if (out.op === 'add' && typeof out.notes === 'string') out.notes = [out.notes];
  return out;
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined && o[k] !== null).map((k) => [k, o[k]]));

function groupJSON(g) {
  return {
    id: String(g.id),
    title: String(g.title || g.id),
    about: String(g.about || ''),
    on: g.on !== false,
    routes: g.routes.filter((r) => r?.method && r?.path).map((r) => ({ method: String(r.method).toUpperCase(), path: String(r.path), summary: String(r.summary || ''), asks: !!r.asks_on_the_mac })),
  };
}

/** Long JSON cut to what the model can read. */
const clip = (s) => (s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}… (cut short: ${s.length} characters in all; ask for less, e.g. a limit or one name)` : s);

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
    case 'straw_mistake':
      return mistake(json).replace('Flow', 'Straw');
    case 'unauthorized':
      return `Tool Mac Tool Run wants its token (${error}): it's shared on the network, and this address isn't this Mac's own.`;
    case 'unknown_script':
    case 'unknown_flow':
    case 'unknown_run':
    case 'unknown_request':
      return error;
  }
  return `Tool Mac Tool Run said ${status}: ${error}${json.fix ? ` Fix: ${json.fix}` : ''}`;
}

const str = (v) => (typeof v === 'string' ? (v.trim() ? v : null) : typeof v === 'number' ? String(v) : null);

function list(v) {
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : typeof x === 'number' || typeof x === 'boolean' ? String(x) : JSON.stringify(x)));
  if (typeof v === 'string' && v.trim()) return v;
  if (typeof v === 'number') return [String(v)];
  return null;
}
