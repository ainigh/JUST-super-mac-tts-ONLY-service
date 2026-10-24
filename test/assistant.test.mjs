// The assistant against a stand-in for Tool Mac Tool Run (a real HTTP server, listing its tools
// and running them as the real one does, runs streamed) and a scripted model: the tools as Tool
// Mac Tool Run gives them, calls passed through, runs, cards refused, cancelling while a card waits
// and while a run runs, the loop, the nudges, the schedule, interruptions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import { Assistant, display } from '../src/main/assistant.mjs';
import { Notes, PLAYBOOK, INSTRUCTIONS } from '../src/main/notes.mjs';
import { Scheduler } from '../src/main/scheduler.mjs';
import { ToolRun, hasTool } from '../src/main/toolrun.mjs';
import { systemPrompt } from '../src/main/prompt.mjs';
import { Trace } from '../src/main/trace.mjs';
import { Ollama } from '../src/main/model.mjs';
import { CHARACTERS } from '../src/shared/characters.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const arg = (name, about, required = false, type = 'string') => ({ name, type, required, about });
/** The tools the stand-in lists, as Tool Mac Tool Run writes them (a few of them, and one this app has never heard of). */
const TOOLS = [
  { name: 'find', description: 'Finds the tools, scripts and flows for something by a few words.', args: [arg('q', 'a few words', true)], aliases: ['search'] },
  { name: 'run_script', description: "Runs one of the person's scripts by its name.", args: [arg('script', 'its name', true), arg('args', 'its inputs', false, 'list'), arg('why', 'shown on the card')], asks_on_the_mac: true, stream: true, aliases: ['run'] },
  { name: 'web_search', description: 'Searches the web from this Mac, at once.', args: [arg('q', 'what to search for', true)], aliases: ['google'] },
  { name: 'web_fetch', description: 'Reads any web address from this Mac, at once.', args: [arg('url', 'the address', true), arg('find', 'words')], aliases: ['fetch'] },
  { name: 'library', description: "The person's notes.", args: [arg('op', 'read, append, write…', true), arg('name', "the note's name")], aliases: ['notes'] },
  { name: 'remember', description: 'Keeps something the person told you.', args: [arg('category', 'PEOPLE…', true), arg('about', 'who', true)], aliases: [] },
  { name: 'recall', description: "What's remembered about a name.", args: [arg('name', 'as said', true)], aliases: [] },
  { name: 'memory', description: 'The rest of MEMORY.', args: [arg('op', 'upcoming…', true)], aliases: [] },
  { name: 'mind', description: 'What links to what.', args: [arg('op', 'about, add…', true)], aliases: [] },
  { name: 'teleport', description: 'A tool this app has never heard of: there the day it ships.', args: [], aliases: [] },
  { name: 'straw', description: 'Drives Chrome.', args: [], asks_on_the_mac: true, stream: true, aliases: [], on: false },
];

/** A stand-in for Tool Mac Tool Run. `old`: one from before it listed its tools. */
async function fakeToolRun({ old = false } = {}) {
  const seen = { closedWhileWaiting: 0, stopped: [], runs: [], calls: [], searches: [], notes: {} };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const b = body ? JSON.parse(body) : {};
    const url = new URL(req.url, 'http://x');
    const json = (status, o, headers = {}) => res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(o));
    if (url.pathname === '/api/scripts') {
      return json(200, {
        folder: '/Users/sam/Scripts',
        scripts: [
          { name: 'hello.sh', group: 'scripts', language_name: 'Bash', summary: 'Says hello', inputs: [{ prompt: 'Who', kind: 'argument', optional: true }], dangers: [] },
          { name: 'utilities/weather.py', group: 'utilities', language_name: 'Python', summary: 'The weather', dangers: [] },
          { name: 'slow.sh', summary: 'Waits for a click for ever', dangers: [] },
          { name: 'long.sh', summary: 'Runs for ever', dangers: [] },
          { name: 'nope.sh', summary: 'Always refused', dangers: [] },
        ],
      });
    }
    if (url.pathname === '/api/flows') return json(200, { flows: [{ name: 'morning.flow', summary: 'The day' }] });
    if (url.pathname === '/api/tools' && !old) {
      return json(200, { ok: true, tools: TOOLS, guide: ['Search the web, then read what you found.'], examples: [{ user: 'When does the Louvre open?', steps: [{ call: { tool: 'web_search', arguments: { q: 'Louvre hours' } }, result: '1. Louvre hours — https://louvre.fr/hours' }], answer: 'From 9 to 6.' }] });
    }
    if (url.pathname === '/api/search') {
      seen.searches.push(Object.fromEntries(url.searchParams));
      const q = url.searchParams.get('q');
      const lines = [];
      if (/weather|rain/i.test(q)) lines.push('tool web_search: Searches the web from this Mac, at once. | takes: q (string): what to search for', 'script utilities/weather.py: The weather | run_script runs it (it waits for Run on the Mac)');
      return json(200, { ok: true, q, count: lines.length, results: [], lines, next: [] });
    }
    if (url.pathname === '/api/mind/context') {
      (seen.context ||= []).push(b);
      return json(200, { request: 'C1', lines: /ada/i.test(b.text) ? ['| PEOPLE | ada', '| ada - likes | gardening'] : [] });
    }
    const stop = url.pathname.match(/^\/api\/runs\/(.+)\/stop$/);
    if (stop) {
      seen.stopped.push(stop[1]);
      return json(200, { ok: true, stopping: true });
    }
    const call = url.pathname.match(/^\/api\/tools\/([^/]+)$/);
    if (call && !old) {
      const name = decodeURIComponent(call[1]);
      const a = b.arguments || {};
      seen.calls.push({ name, ...b });
      assert.equal(b.client, 'Super Face');
      const tool = TOOLS.find((t) => t.name === name || t.aliases.includes(name));
      const script = ['hello.sh', 'utilities/weather.py', 'slow.sh', 'long.sh', 'nope.sh'].find((s) => s === name || s.replace(/^.*\//, '').replace(/\.\w+$/, '') === name);
      if (!tool && !script) {
        return json(404, { ok: false, code: 'unknown_tool', error: `there's no tool called ${name}. The tools: ${TOOLS.map((t) => t.name).join(', ')}.`, tools: ['tool web_search: Searches the web from this Mac, at once. | takes: q (string): what to search for'] });
      }
      const missing = tool?.args.find((x) => x.required && a[x.name] === undefined);
      if (missing) return json(400, { ok: false, tool: tool.name, code: 'missing_argument', error: `${tool.name} takes ${missing.name}: ${missing.about}.`, takes: tool.args.map((x) => x.name).join('; ') });
      switch (script ? 'run_script' : tool.name) {
        case 'run_script': {
          const s = script || a.script;
          seen.runs.push({ script: s, args: a.args, why: b.why, stream: b.stream });
          if (!['hello.sh', 'utilities/weather.py', 'slow.sh', 'long.sh', 'nope.sh'].includes(s)) return json(404, { ok: false, tool: 'run_script', error: `no script called ${s}`, code: 'unknown_script' });
          assert.equal(b.stream, true);
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'X-Request-Id': 'REQ1', 'X-Tool': 'run_script' });
          const line = (o) => res.write(JSON.stringify(o) + '\n');
          line({ type: 'waiting', request: 'REQ1', message: 'Waiting for Run' });
          if (s === 'slow.sh') {
            req.on('close', () => seen.closedWhileWaiting++);
            res.on('close', () => seen.closedWhileWaiting++);
            return;
          }
          await wait(20);
          if (s === 'nope.sh') return res.end(JSON.stringify({ type: 'denied', code: 'denied', message: "Don't Run" }) + '\n');
          const printed = s === 'utilities/weather.py' ? 'Leeds: 12°C, rain\n' : `Hello, ${(a.args || ['world'])[0]}!\n`;
          line({ type: 'started', id: 'RUN7', request: 'REQ1', name: s });
          line({ type: 'output', stream: 'out', text: printed });
          if (s === 'long.sh') return;
          await wait(10);
          return res.end(JSON.stringify({ type: 'done', name: s, state: 'succeeded', ok: true, code: 0, seconds: 0.03, id: 'RUN7', output: printed }) + '\n');
        }
        case 'web_search':
          return json(200, { ok: true, op: 'search', request: 'W1', tool: 'web_search', q: a.q, results: [{ title: 'Leeds weather', url: 'https://weather.example/leeds', snippet: 'Rain today' }], lines: ['1. Leeds weather — https://weather.example/leeds\n   Rain today'], next: [{ method: 'GET', path: '/api/web/fetch' }] });
        case 'web_fetch':
          return json(200, { ok: true, request: 'W2', tool: 'web_fetch', url: a.url, kind: 'page', title: 'Leeds weather', text: 'Leeds today: 12°C and rain, clearing by 6pm.', links: [{ text: 'Tomorrow', url: 'https://weather.example/leeds/tomorrow' }], next: [] });
        case 'library': {
          seen.library = a;
          const notes = seen.notes;
          if (a.name === 'Ghost') return json(404, { ok: false, tool: 'library', error: 'no note called Ghost', code: 'not_found', fix: 'There is Groceries', request: 'L2' });
          if (a.op === 'read_many') return json(200, { request: 'L3', notes: a.names.filter((n) => n in notes).map((n) => ({ name: n, text: notes[n] })), missing: a.names.filter((n) => !(n in notes)) });
          if (a.op === 'write') notes[a.name] = a.text;
          if (a.op === 'append') notes[a.name] = `${notes[a.name] ?? ''}${notes[a.name] && !notes[a.name].endsWith('\n') ? '\n' : ''}${a.text}\n`;
          return json(200, { request: 'L1', tool: 'library', name: a.name, action: 'appended', next: [{ method: 'GET', path: '/api/library/files/x' }] }, { 'X-Request-Id': 'L1' });
        }
        case 'remember':
          (seen.memory ||= []).push({ op: 'remember', ...a });
          return json(200, { request: 'M2', file: a.category, node: String(a.about).toLowerCase() });
        case 'recall':
          if (a.name === 'the user') return json(200, seen.aboutUser ? { request: 'M3', found: true, lines: seen.aboutUser } : { request: 'M3', found: false, lines: [] });
          return json(200, { request: 'M1', name: a.name, found: true, nodes: [{ name: 'ada' }], lines: ['| PEOPLE | ada', '| ada - likes | gardening'] });
        case 'memory':
          (seen.memory ||= []).push(a);
          if (a.op === 'upcoming') return json(200, { request: 'M0', days: a.days, lines: ['2026-10-27 (in 3 days): birthday 10-27 — ada'] });
          return json(400, { ok: false, error: `no memory op ${a.op}`, code: 'unknown_op' });
        default:
          return json(200, { ok: true, tool: tool.name, did: 'it' });
      }
    }
    json(404, { error: 'no such route', code: 'not_found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => (server.closeAllConnections(), server.close()) };
}

/** A model that answers from a script: each step a string, or a function of the messages. */
function scriptedModel(steps) {
  const asked = [];
  return {
    asked,
    picked: 'fake',
    current: () => ({ model: 'fake' }),
    async chat(messages, { signal, onText } = {}) {
      asked.push(messages);
      const step = steps.shift();
      if (step === undefined) throw new Error('the model was asked more than the test expected');
      const text = typeof step === 'function' ? await step(messages, signal) : step;
      if (onText) {
        // Streamed in pieces, as Ollama does.
        for (let i = 6; i < text.length; i += 6) {
          if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          onText(text.slice(0, i));
          await wait(1);
        }
        onText(text);
      }
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return text;
    },
  };
}

async function setup(steps, fake) {
  const toolrun = new ToolRun({ url: () => fake?.url || 'http://127.0.0.1:9' });
  await toolrun.refresh();
  const said = [];
  const events = [];
  let stops = 0;
  const scheduler = new Scheduler({ onFire: () => {} });
  const notes = new Notes({ toolrun });
  const model = scriptedModel(steps);
  const a = new Assistant({
    model,
    toolrun,
    scheduler,
    notes,
    character: () => CHARACTERS[0],
    speak: (t) => said.push(t),
    stopSpeaking: () => stops++,
    emit: (e) => events.push(e),
  });
  const idle = async () => {
    for (let i = 0; i < 400 && (a.busy || a.inbox.length || a.reflecting); i++) await wait(5);
  };
  return { a, model, said, events, scheduler, notes, toolrun, idle, stops: () => stops };
}

test("the tools are Tool Mac Tool Run's, as it lists them, with the scripts and flows; an old one, or none, is said plainly", async () => {
  const fake = await fakeToolRun();
  try {
    const t = new ToolRun({ url: () => fake.url });
    const c = await t.refresh();
    assert.equal(c.reachable, true);
    assert.equal(c.error, null);
    assert.deepEqual(c.tools.map((x) => x.name), ['find', 'run_script', 'web_search', 'web_fetch', 'library', 'remember', 'recall', 'memory', 'mind', 'teleport'], 'one that is off is left out');
    assert.deepEqual(c.tools[1], { name: 'run_script', description: "Runs one of the person's scripts by its name.", args: [{ name: 'script', type: 'string', required: true, about: 'its name' }, { name: 'args', type: 'list', required: false, about: 'its inputs' }, { name: 'why', type: 'string', required: false, about: 'shown on the card' }], asks: true, stream: true, aliases: ['run'] });
    assert.deepEqual(c.scripts[0], { name: 'hello.sh', group: 'scripts', language: 'Bash', summary: 'Says hello', dangers: [], inputs: [{ prompt: 'Who', kind: 'argument', optional: true }] });
    assert.equal(c.flows[0].name, 'morning.flow');
    assert.deepEqual(c.guide, ['Search the web, then read what you found.']);
    assert.deepEqual(c.upcoming, ['2026-10-27 (in 3 days): birthday 10-27 — ada'], "what's coming up, asked of the memory tool");
    assert.ok(hasTool(c, 'teleport'));
    const p = systemPrompt({ character: CHARACTERS[0], catalog: c });
    assert.match(p, /^- teleport: A tool this app has never heard of: there the day it ships\.$/m);
    assert.match(p, /^- run_script: [^\n]*\[waits for the user to click Run on the Mac\]$/m);
    assert.doesNotMatch(p, /^- straw: /m);
    assert.match(p, /^- Search the web, then read what you found\.$/m);
    assert.match(p, /^You answer: \{"tool": "web_search", "arguments": \{"q":"Louvre hours"\}\}$/m);
    assert.match(p, /^Coming up in the next week, from MEMORY[^\n]*\n- 2026-10-27 \(in 3 days\): birthday 10-27 — ada$/m);

    const old = await fakeToolRun({ old: true });
    try {
      const o = await new ToolRun({ url: () => old.url }).refresh();
      assert.match(o.error, /too old to say what its tools are[^\n]*update it/);
      assert.match(systemPrompt({ character: CHARACTERS[0], catalog: o }), /isn't available right now \(this Tool Mac Tool Run is too old/);
    } finally {
      old.close();
    }
    const off = new ToolRun({ url: () => 'http://127.0.0.1:9' });
    assert.match((await off.refresh()).error, /isn't answering/);
    assert.match((await off.run('run_script', { script: 'a.sh' })).text, /isn't answering/);
  } finally {
    fake.close();
  }
});

test('a call is passed through as it was made, and its answer given back without what is only for programs', async () => {
  const fake = await fakeToolRun();
  try {
    const t = new ToolRun({ url: () => fake.url });
    await t.refresh();
    const lib = await t.run('library', { op: 'append', name: 'Shopping', text: '- eggs' });
    assert.deepEqual(lib, { text: JSON.stringify({ name: 'Shopping', action: 'appended' }), failed: false }, 'no request id, no tool, no "next"');
    assert.deepEqual(fake.seen.calls.at(-1), { name: 'library', arguments: { op: 'append', name: 'Shopping', text: '- eggs' }, why: 'You asked for it', client: 'Super Face' });
    // An answer that says itself in lines is given as its lines.
    const found = await t.run('web_search', { q: 'weather in Leeds' });
    assert.deepEqual(JSON.parse(found.text), { op: 'search', q: 'weather in Leeds', lines: ['1. Leeds weather — https://weather.example/leeds\n   Rain today'], ok: true });
    // A tool this app has never heard of works the same; so does a name Tool Mac Tool Run takes for another.
    assert.equal((await t.run('teleport', {})).failed, false);
    assert.equal((await t.run('google', { q: 'x' })).failed, false);
    // A miss: what Tool Mac Tool Run said, its fix, what the tool takes, and what fits instead.
    const ghost = await t.run('library', { op: 'read', name: 'Ghost' });
    assert.equal(ghost.failed, true);
    assert.match(ghost.text, /^Tool Mac Tool Run said 404 \(not_found\): no note called Ghost Fix: There is Groceries/);
    const missing = await t.run('web_fetch', {});
    assert.match(missing.text, /missing_argument\): web_fetch takes url: the address\.\nweb_fetch takes: url; find/);
    const mars = await t.run('fly_to_mars', {});
    assert.equal(mars.failed, true);
    assert.match(mars.text, /unknown_tool\): there's no tool called fly_to_mars\.[^\n]*\nWhat fits instead:\n- tool web_search: /);
    // A script's own name as the tool: Tool Mac Tool Run runs it, and it's followed live.
    const sky = await t.run('weather', { args: ['Leeds'] });
    assert.match(sky.text, /utilities\/weather\.py: succeeded/);
    assert.equal(fake.seen.runs.at(-1).stream, true);
    assert.deepEqual(await t.context('What should I get Ada?'), ['| PEOPLE | ada', '| ada - likes | gardening']);
    assert.deepEqual(await new ToolRun({ url: () => fake.url }).context('Ada'), [], 'no mind listed (not fetched yet): nothing asked');
  } finally {
    fake.close();
  }
});

test('finding something out on the web: a search, then the page, then the answer, with no click', async () => {
  const fake = await fakeToolRun();
  try {
    const { a, model, said, idle } = await setup(
      [
        '{"tool": "web_search", "arguments": {"q": "weather in Leeds today"}}',
        (m) => {
          assert.match(m.at(-1).content, /^Tool result for web_search \(from the Mac, not the user\):\n.*Leeds weather — https:\/\/weather\.example\/leeds/);
          return '{"tool": "web_fetch", "arguments": {"url": "https://weather.example/leeds", "find": "today"}}';
        },
        (m) => {
          assert.match(m.at(-1).content, /12°C and rain, clearing by 6pm/);
          return "It's 12 degrees and raining in Leeds, clearing by six.";
        },
        '(nothing)',
      ],
      fake,
    );
    a.say("what's the weather in Leeds?", { how: 'said' });
    await idle();
    assert.deepEqual(said, ["It's 12 degrees and raining in Leeds, clearing by six."]);
    assert.deepEqual(fake.seen.calls.filter((c) => c.name.startsWith('web_')).map((c) => c.arguments), [{ q: 'weather in Leeds today' }, { url: 'https://weather.example/leeds', find: 'today' }]);
    assert.deepEqual(a.log.filter((e) => e.kind === 'tool').map((e) => [e.name, e.state]), [['web_search', 'done'], ['web_fetch', 'done']]);
    assert.match(model.asked[0][0].content, /^- web_fetch: Reads any web address/m);
  } finally {
    fake.close();
  }
});

test('the model is shown what Tool Mac Tool Run says when its call misses, and the critic comes in', async () => {
  const fake = await fakeToolRun();
  try {
    const { a, model, idle, toolrun } = await setup(['{"tool": "fly_to_mars", "arguments": {}}', 'I can search the web for trips instead.', '(nothing)'], fake);
    await toolrun.refresh();
    a.say('fly me to mars');
    await idle();
    const result = model.asked[1].at(-1).content;
    assert.match(result, /there's no tool called fly_to_mars/);
    assert.match(result, /What fits instead:\n- tool web_search/);
    assert.match(result, /that didn't work\. Before anything else, look at why/);
  } finally {
    fake.close();
  }
});

test('what fits the request is searched for once a request (tools, scripts and flows), beside the mind, and given to the model', async () => {
  const fake = await fakeToolRun();
  try {
    const { a, model, idle, toolrun } = await setup(['{"tool": "recall", "arguments": {"name": "Ada"}}', 'Ada likes gardening, and it may rain.'], fake);
    await toolrun.refresh();
    a.say('will it rain for Ada today?');
    await idle();
    const system = model.asked[0][0].content;
    assert.match(system, /^What fits what was just said[^\n]*\n- tool web_search: Searches the web[^\n]*\n- script utilities\/weather\.py: The weather/m);
    assert.match(system, /^What the mind already has on what's being said[^\n]*\n\| PEOPLE \| ada\n\| ada - likes \| gardening$/m);
    assert.equal(fake.seen.searches.length, 1, 'searched once, not every round');
    assert.deepEqual([fake.seen.searches[0].q, fake.seen.searches[0].in, fake.seen.searches[0].next], ['will it rain for Ada today?', 'tools,scripts,flows', 'false']);
    assert.equal(fake.seen.context.length, 1);
    assert.equal(a.log.at(-1).text, 'Ada likes gardening, and it may rain.');
  } finally {
    fake.close();
  }
});

test('every call is noted for the Calls tab: the tool, each request (address, body, status, request id), the stream, the result', async () => {
  const fake = await fakeToolRun();
  try {
    const trace = new Trace({ name: 'calls' });
    const t = new ToolRun({ url: () => fake.url, trace });
    await t.refresh();
    assert.equal(trace.list()[0].kind, 'catalog');
    assert.deepEqual(trace.list()[0].http.map((h) => h.url.replace(fake.url, '')), ['/api/tools', '/api/scripts', '/api/flows', '/api/tools/memory']);
    const log = trace.open({ kind: 'tool', name: 'run_script' });
    await t.run('run_script', { script: 'hello.sh', args: ['Sam'] }, { log });
    const h = log.http[0];
    assert.equal(h.url, `${fake.url}/api/tools/run_script`);
    assert.deepEqual(h.body.arguments, { script: 'hello.sh', args: ['Sam'] });
    assert.equal(h.status, 200);
    assert.equal(h.request, 'REQ1');
    assert.deepEqual(h.events.map((e) => e.type), ['waiting', 'started', 'output', 'done']);
    const lib = trace.open({ kind: 'tool', name: 'library' });
    await t.run('library', { op: 'append', name: 'Shopping', text: '- eggs' }, { log: lib });
    assert.equal(lib.http[0].request, 'L1');
    assert.equal(lib.http[0].response.action, 'appended');
  } finally {
    fake.close();
  }
});

test('a run: the card waits, it runs, what it printed comes back', async () => {
  const fake = await fakeToolRun();
  try {
    const t = new ToolRun({ url: () => fake.url });
    await t.refresh();
    const states = [];
    const out = await t.run('run_script', { script: 'hello.sh', args: ['Sam'], why: 'You asked' }, { onStatus: (s) => states.push(s.state) });
    assert.equal(out.failed, false);
    assert.match(out.text, /hello\.sh: succeeded \(exit code 0\)/);
    assert.match(out.text, /Hello, Sam!/);
    assert.deepEqual([...new Set(states)], ['sending', 'waiting', 'running', 'done']);
    assert.equal(fake.seen.runs[0].why, 'You asked');
    const nope = await t.run('run_script', { script: 'nope.sh' });
    assert.equal(nope.failed, true);
    assert.match(nope.text, /clicked Don't Run/);
    assert.match((await t.run('run_script', { script: 'ghost.sh' })).text, /no script called ghost\.sh/);
  } finally {
    fake.close();
  }
});

test('cancelled while the card waits: the connection is closed (the card goes), nothing ran', async () => {
  const fake = await fakeToolRun();
  try {
    const t = new ToolRun({ url: () => fake.url });
    await t.refresh();
    const ctrl = new AbortController();
    const out = await t.run('run_script', { script: 'slow.sh' }, { signal: ctrl.signal, onStatus: (s) => s.state === 'waiting' && ctrl.abort() });
    assert.equal(out.cancelled, true);
    assert.match(out.text, /Cancelled by the user before it ran/);
    await wait(50);
    assert.ok(fake.seen.closedWhileWaiting > 0);
    assert.deepEqual(fake.seen.stopped, []);
  } finally {
    fake.close();
  }
});

test('cancelled while it runs: it is stopped on the Mac', async () => {
  const fake = await fakeToolRun();
  try {
    const t = new ToolRun({ url: () => fake.url });
    await t.refresh();
    const ctrl = new AbortController();
    const out = await t.run('run_script', { script: 'long.sh' }, { signal: ctrl.signal, onStatus: (s) => s.output && ctrl.abort() });
    assert.match(out.text, /Cancelled by the user while it was running: it was stopped\. What it printed before:\nHello, world!/);
    await wait(50);
    assert.deepEqual(fake.seen.stopped, ['RUN7']);
  } finally {
    fake.close();
  }
});

test('the loop: words said as they come, a run, its result handed back, the answer said', async () => {
  const fake = await fakeToolRun();
  try {
    const { a, model, said, idle } = await setup(
      [
        'Let me check. Click Run on your Mac.\n{"tool": "run_script", "arguments": {"script": "utilities/weather.py", "args": ["Leeds"], "why": "You asked"}}',
        (messages) => {
          const last = messages.at(-1).content;
          assert.match(last, /^Tool result for run_script \(from the Mac, not the user\):\nutilities\/weather\.py: succeeded/);
          assert.match(last, /Leeds: 12°C, rain/);
          return "It's 12 degrees and raining in Leeds. [shrug]";
        },
      ],
      fake,
    );
    a.say("what's the weather in Leeds?", { how: 'said' });
    await idle();
    assert.deepEqual(said, ['Let me check.', 'Click Run on your Mac.', "It's 12 degrees and raining in Leeds. [shrug]"]);
    const sys = model.asked[0][0].content;
    assert.match(sys, /You are Ivy/);
    assert.match(sys, /^utilities\/: weather$/m);
    assert.match(model.asked[0][1].content, /^\[\w+day \d+ \w+ \d{4}, \d\d:\d\d:\d\d \(UTC[+-]\d\d:\d\d\), said\] what's the weather in Leeds\?$/);
    const kinds = a.log.filter((e) => !e.hidden).map((e) => [e.kind, e.kind === 'tool' ? e.state : e.text]);
    assert.deepEqual(kinds, [
      ['user', "what's the weather in Leeds?"],
      ['assistant', 'Let me check. Click Run on your Mac.'],
      ['tool', 'done'],
      ['assistant', "It's 12 degrees and raining in Leeds."],
    ]);
    assert.equal(a.log.find((e) => e.kind === 'tool').request, 'REQ1');
  } finally {
    fake.close();
  }
});

test('words that promise work with no call are sent back once; "(nothing)" is never said', async () => {
  const { a, model, said, idle } = await setup(['I\'ll check that for you.', '{"tool": "list_schedules", "arguments": {}}', 'Nothing is scheduled. 🙂', '(nothing)']);
  a.say('anything on later?');
  await idle();
  assert.match(model.asked[1].at(-1).content, /you said you'd do something, but made no tool call/);
  assert.match(model.asked[2].at(-1).content, /Nothing is scheduled\./);
  // The promise was never said: a sentence is said once the next begins, and this one was sent back first.
  assert.deepEqual(said, ['Nothing is scheduled. 🙂']);
  a.say('(the TV talking)');
  await idle();
  assert.equal(said.length, 1);
});

test('asides in brackets are neither said nor shown; an answer of only asides is no answer', async () => {
  const { a, said, idle } = await setup(['(looking puzzled) (nothing)', '(smiles) Sure, it is done. (nods) Anything else? [smile]', 'nothing']);
  a.say('(the TV talking)');
  await idle();
  assert.deepEqual(said, []);
  assert.ok(!a.log.some((e) => e.kind === 'assistant' && !e.hidden), 'nothing in the chat');
  a.say('is it done?');
  await idle();
  assert.deepEqual(said.join(' ').replace(/\s+/g, ' '), 'Sure, it is done. Anything else? [smile]', 'the cue is left for the face');
  assert.equal(a.log.filter((e) => e.kind === 'assistant').at(-1).text, 'Sure, it is done. Anything else?');
  a.say('(more TV)');
  await idle();
  assert.equal(a.log.filter((e) => e.kind === 'assistant' && !e.hidden && e.text).length, 1, '"nothing" never shows, even while it is written');
});

test('a broken call is asked for again; a refused run brings the critic in; then it learns, quietly', async () => {
  const fake = await fakeToolRun();
  try {
    const { a, model, said, notes, idle } = await setup(
      [
        '{"tool": "run_script", "arguments": {"script": "hello.sh"',
        '{"tool": "run_script", "arguments": {"script": "nope.sh"}}',
        (m) => {
          assert.match(m.at(-1).content, /clicked Don't Run[\s\S]*that didn't work\. Before anything else, look at why/);
          return 'You chose not to run it, so I left it.';
        },
        (m) => {
          assert.match(m.at(-1).content, /the request is over\. Is there something you learned/);
          return `{"tool": "library", "arguments": {"op": "append", "name": "${PLAYBOOK}", "text": "- nope.sh is always refused"}}`;
        },
      ],
      fake,
    );
    a.say('run nope');
    await idle();
    assert.match(model.asked[1].at(-1).content, /looked like a tool call, but it couldn't be read/);
    assert.deepEqual(said, ['You chose not to run it, so I left it.']);
    assert.equal(fake.seen.notes[PLAYBOOK], '- nope.sh is always refused\n');
    assert.deepEqual(notes.playbook, ['- nope.sh is always refused'], 'read back once it is written');
    assert.ok(a.log.some((e) => e.kind === 'note' && e.text === 'Learned: nope.sh is always refused'));
  } finally {
    fake.close();
  }
});

test('what it has learned is read from Tool Mac Tool Run with every request: its playbook, the standing instructions, MEMORY on the user', async () => {
  const fake = await fakeToolRun();
  try {
    // As the user may have left them after editing them in Tool Mac Tool Run: a title, the lines.
    fake.seen.notes[PLAYBOOK] = '# Super Face playbook\n\n- weather.py takes the city first\n';
    fake.seen.notes[INSTRUCTIONS] = '# Super Face instructions\n\nCall me Sam.\n';
    fake.seen.aboutUser = ['| PEOPLE | the user', '| the user @pref celsius'];
    const { a, model, idle, notes } = await setup(['Hello, Sam.'], fake);
    a.say('hi');
    await idle();
    const system = model.asked[0][0].content;
    assert.match(system, /^Your playbook \(the library note "Super Face playbook"[^\n]*\n- weather\.py takes the city first$/m);
    assert.match(system, /^What MEMORY has on the user themselves[^\n]*\n\| PEOPLE \| the user\n\| the user @pref celsius$/m);
    assert.match(system, /^The user's standing instructions \(follow them\):\nCall me Sam\.$/m);
    assert.match(system, /library, op append, name "Super Face playbook"/);
    assert.deepEqual(fake.seen.calls.filter((c) => c.name === 'library' || c.name === 'recall').map((c) => [c.name, c.arguments.op || c.arguments.name]), [['library', 'read_many'], ['recall', 'the user']], 'through its tools, as the model reads them');
    // The Mind tab: a line taken out, the instructions written.
    assert.equal(await notes.forget('- weather.py takes the city first'), 'Saved.');
    assert.doesNotMatch(fake.seen.notes[PLAYBOOK], /weather/);
    assert.match(fake.seen.notes[PLAYBOOK], /^# Super Face playbook\n/, 'its head kept');
    assert.equal(await notes.forget('not there'), 'No line says that.');
    await notes.setInstructions('Be brief.');
    assert.equal(notes.instructions, 'Be brief.');
    assert.deepEqual(notes.playbook, []);
  } finally {
    fake.close();
  }
});

test('what an older version kept in memory.json is moved to Tool Mac Tool Run once', async () => {
  const fake = await fakeToolRun();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-notes-'));
  const oldFile = path.join(dir, 'memory.json');
  fs.writeFileSync(oldFile, JSON.stringify({ notes: { user: ['Lives in Leeds'], playbook: ['weather.py takes a city'], mistakes: ['nope.sh is refused'] }, instructions: 'Call me Sam.' }));
  try {
    const toolrun = new ToolRun({ url: () => fake.url });
    await toolrun.refresh();
    const notes = new Notes({ toolrun, oldFile });
    assert.equal(await notes.moveOld(), true);
    assert.deepEqual(notes.playbook, ['- weather.py takes a city', '- Mistake: nope.sh is refused']);
    assert.equal(notes.instructions, 'Call me Sam.');
    assert.deepEqual(fake.seen.memory.find((m) => m.op === 'remember'), { op: 'remember', category: 'PEOPLE', about: 'the user', notes: ['pref Lives in Leeds'] });
    assert.ok(!fs.existsSync(oldFile) && fs.existsSync(`${oldFile}.moved`));
    assert.equal(await notes.moveOld(), false, 'once');
  } finally {
    fake.close();
  }
});

test('cancel: a run waiting for its click is called off, and the model is not asked again', async () => {
  const fake = await fakeToolRun();
  try {
    const { a, model, idle, stops } = await setup(['Sending it.\n{"tool": "run_script", "arguments": {"script": "slow.sh"}}'], fake);
    a.say('do the slow thing');
    for (let i = 0; i < 200 && a.log.find((e) => e.kind === 'tool')?.state !== 'waiting'; i++) await wait(5);
    assert.equal(a.state().phase, 'tool');
    assert.ok(a.cancel());
    await idle();
    assert.equal(model.asked.length, 1);
    assert.equal(a.log.find((e) => e.kind === 'tool').state, 'cancelled');
    assert.match(a.history.at(-1).content, /Cancelled by the user before it ran/);
    assert.ok(stops() >= 1);
    await wait(30);
    assert.ok(fake.seen.closedWhileWaiting > 0);
  } finally {
    fake.close();
  }
});

test('clear while a run waits: it is called off, and nothing of it is left in the chat or the conversation', async () => {
  const fake = await fakeToolRun();
  try {
    const { a, model, events, idle } = await setup(['Sending it.\n{"tool": "run_script", "arguments": {"script": "slow.sh"}}'], fake);
    a.say('do the slow thing');
    for (let i = 0; i < 200 && a.log.find((e) => e.kind === 'tool')?.state !== 'waiting'; i++) await wait(5);
    a.clear();
    const after = events.length;
    await idle();
    assert.equal(model.asked.length, 1);
    assert.deepEqual(a.log, []);
    assert.deepEqual(a.history, []);
    assert.ok(events.some((e) => e.type === 'cleared'));
    assert.ok(!events.slice(after).some((e) => e.type === 'entry'), 'nothing cleared comes back to the chat');
  } finally {
    fake.close();
  }
});

test('more said while it is still thinking is asked together, as one request', async () => {
  let release;
  const { a, model, said, idle } = await setup([
    (_m, signal) => new Promise((resolve, reject) => {
      release = resolve;
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
    'Paris, at nine tomorrow. Done.',
  ]);
  a.say('book a table');
  await wait(10);
  a.say('in Paris at nine tomorrow');
  await idle();
  assert.equal(model.asked.length, 2);
  const asked = model.asked[1].at(-1).content;
  assert.match(asked, /typed\] book a table\n\[.*\] in Paris at nine tomorrow$/);
  assert.equal(model.asked[1].filter((m) => m.role === 'user').length, 1);
  assert.deepEqual(said, ['Paris, at nine tomorrow.', 'Done.']);
  void release;
});

test('a schedule set by the model comes due as a request of its own', async () => {
  const { a, scheduler, model, said, idle } = await setup([
    '{"tool": "schedule", "arguments": {"in_minutes": 0.001, "task": "Remind the user to stretch."}}',
    "Sure, I'll remind you. [nod]",
    (m) => {
      assert.match(m.at(-1).content, /scheduled\] Scheduled task s1: Remind the user to stretch\.$/);
      return 'Time to stretch! 🙂';
    },
  ]);
  scheduler.onFire = (t) => a.say(`Scheduled task ${t.id}: ${t.task}`, { how: 'scheduled' });
  a.say('remind me to stretch in a moment');
  for (let i = 0; i < 100 && model.asked.length < 3; i++) await wait(10);
  await idle();
  assert.deepEqual(said, ["Sure, I'll remind you. [nod]", 'Time to stretch! 🙂']);
  assert.equal(model.asked.length, 3);
  assert.equal(a.log.at(-2).kind, 'schedule');
});

test('no model: said once, shown in the chat, and the question kept for next time', async () => {
  const { a, model, said, idle } = await setup([]);
  model.chat = async () => {
    throw Object.assign(new Error("Ollama isn't answering at http://127.0.0.1:11434. Is it running?"), { code: 'unreachable' });
  };
  a.say('hello');
  await idle();
  a.say('hello?');
  await idle();
  assert.deepEqual(said, ["I can't reach my model. Is Ollama running?"]);
  assert.equal(a.log.filter((e) => e.kind === 'error').length, 2);
  assert.match(a.state().error, /isn't answering/);
});

test('what the chat shows', () => {
  assert.equal(display('Great job! [thumbup] 👍 [mood: happy]'), 'Great job! 👍');
  assert.equal(display('(grins) Great job!'), 'Great job!');
});

test('every request to the model is noted for the Model tab: what was sent, and what came back as it streamed', async () => {
  const trace = new Trace({ name: 'model' });
  const lines = ['{"message":{"content":"<think>hm</think>Hel"}}', '{"message":{"content":"lo!"}}', '{"done":true}'].map((l) => l + '\n');
  const fetch = async (url, { body }) => {
    assert.equal(url, 'http://ollama/api/chat');
    assert.equal(JSON.parse(body).model, 'qwen3:8b');
    return new Response(new ReadableStream({ start: (c) => (lines.forEach((l) => c.enqueue(new TextEncoder().encode(l))), c.close()) }), { status: 200 });
  };
  const m = new Ollama({ current: () => ({ url: 'http://ollama', model: 'qwen3:8b' }), fetch, trace });
  const text = await m.chat([{ role: 'system', content: 'You are Ivy' }, { role: 'user', content: 'hi' }], { onText: () => {} });
  assert.equal(text, 'Hello!');
  const [rec] = trace.list();
  assert.equal(rec.purpose, 'answer');
  assert.equal(rec.state, 'done');
  assert.deepEqual(rec.messages, [{ role: 'system', content: 'You are Ivy' }, { role: 'user', content: 'hi' }]);
  assert.equal(rec.text, '<think>hm</think>Hello!', 'what came back, thinking and all');
  assert.equal(rec.request.model, 'qwen3:8b');
  assert.equal(rec.request.messages, undefined, 'the messages are noted apart');
  const failing = new Ollama({ current: () => ({ url: 'http://127.0.0.1:9', model: 'x' }), trace });
  await assert.rejects(failing.chat([{ role: 'user', content: 'hi' }], { purpose: 'learning' }));
  assert.equal(trace.list()[1].state, 'failed');
  assert.match(trace.list()[1].error, /isn't answering/);
});
