// The assistant against a stand-in for Tool Mac Tool Run (a real HTTP server, streaming as the real
// one does) and a scripted model: runs, cards refused, cancelling while a card waits and while a
// run runs, the loop, the nudges, the schedule, interruptions.
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { Assistant, display, isFailure } from '../src/main/assistant.mjs';
import { Memory } from '../src/main/memory.mjs';
import { Scheduler } from '../src/main/scheduler.mjs';
import { ToolRun, hasLibrary, otherGroups } from '../src/main/toolrun.mjs';
import { canonical, systemPrompt } from '../src/main/prompt.mjs';
import { Trace } from '../src/main/trace.mjs';
import { Ollama } from '../src/main/model.mjs';
import { CHARACTERS } from '../src/shared/characters.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A stand-in for Tool Mac Tool Run. */
async function fakeToolRun() {
  const seen = { closedWhileWaiting: 0, stopped: [], runs: [] };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const b = body ? JSON.parse(body) : {};
    const url = new URL(req.url, 'http://x');
    const json = (status, o) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(o));
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
    if (url.pathname === '/api/endpoints') {
      const route = (method, path, summary, asks = false) => ({ method, path, summary, asks_on_the_mac: asks });
      return json(200, {
        groups: [
          { id: 'about', title: 'About the API', about: '', routes: [route('GET', '/api/health', 'is it up')] },
          { id: 'scripts', title: 'Scripts and flows', about: '', routes: [route('POST', '/api/run', 'run a script', true)] },
          { id: 'library', title: 'File library', about: 'The notes', switch: 'library', on: true, routes: [route('POST', '/api/library', 'any operation')] },
          { id: 'straw', title: 'Straw', about: 'Chrome', routes: [route('GET', '/api/straw', "Straw's words"), route('POST', '/api/straw/run', 'run Straw code', true)] },
          { id: 'memory', title: 'Memory', about: 'MEMORY', switch: 'memory', on: true, routes: [route('POST', '/api/memory/remember', 'remember'), route('GET', '/api/memory/files/{name}', 'one memory file')] },
          { id: 'mind', title: 'The mind', about: 'links', switch: 'mind', on: true, routes: [route('POST', '/api/mind', 'any op'), route('POST', '/api/mind/context', 'context')] },
          { id: 'screen', title: 'Show and copy', about: '', switch: 'screen', on: true, routes: [route('POST', '/api/present', 'show'), route('POST', '/api/clipboard', 'copy')] },
          { id: 'browser', title: "Chrome's page", about: '', switch: 'browser', on: false, routes: [route('GET', '/api/browser/find', 'where a thing is')] },
          // A group this app has never heard of: there for call_api the day it ships.
          { id: 'calendar', title: 'Calendar', about: 'What is on', routes: [route('GET', '/api/calendar/today', "today's events")] },
          { id: 'runs', title: 'Runs and requests', about: '', switch: 'runs', on: true, routes: [route('GET', '/api/runs', 'the latest runs')] },
        ],
      });
    }
    if (url.pathname === '/api/library') {
      seen.library = b;
      if (b.name === 'Ghost') return json(404, { error: 'no note called Ghost', code: 'not_found', fix: 'There is Groceries', request: 'L2' });
      return res.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-Id': 'L1' }).end(JSON.stringify({ request: 'L1', name: b.name, action: 'appended' }));
    }
    if (url.pathname === '/api/straw/run') {
      seen.straw = b;
      return json(200, { request: 'S1', state: 'succeeded', ok: true, stdout: 'Compute\n' });
    }
    if (url.pathname === '/api/memory/files/PEOPLE') return json(200, { name: 'PEOPLE', text: '- Sam: my brother' });
    if (url.pathname === '/api/calendar/today') return json(200, { events: ['Dentist at 3'] });
    if (url.pathname === '/api/memory') {
      (seen.memory ||= []).push(b);
      if (b.op === 'upcoming') return json(200, { request: 'M0', days: b.days, lines: ['2026-10-27 (in 3 days): birthday 10-27 — ada'] });
      if (b.op === 'recall') return json(200, { request: 'M1', name: b.name, found: true, categories: ['PEOPLE'], nodes: [{ name: 'ada', scope: '', links: 1 }], about: [{ node: 'ada', links: [{ node: 'gardening', direction: 'out', labels: ['likes'] }] }], lines: ['| PEOPLE | ada', '| ada - likes | gardening'] });
      if (b.op === 'remember') return json(200, { request: 'M2', file: b.category, node: String(b.about).toLowerCase(), added_to_file: `- ${b.about}: ${b.text || ''}` });
      return json(400, { error: `no memory op ${b.op}`, code: 'bad_name' });
    }
    if (url.pathname === '/api/mind') {
      (seen.mind ||= []).push(b);
      return json(200, { request: 'N1', added: [`| ${b.from} - ${b.label} | ${b.to}`] });
    }
    if (url.pathname === '/api/mind/context') {
      (seen.context ||= []).push(b);
      return json(200, { request: 'C1', lines: /ada/i.test(b.text) ? ['| PEOPLE | ada', '| ada - likes | gardening'] : [] });
    }
    if (url.pathname === '/api/present') {
      seen.present = b;
      return json(200, { request: 'P1', shown: true, title: b.title });
    }
    const stop = url.pathname.match(/^\/api\/runs\/(.+)\/stop$/);
    if (stop) {
      seen.stopped.push(stop[1]);
      return json(200, { ok: true, stopping: true });
    }
    if (url.pathname === '/api/run') {
      seen.runs.push(b);
      if (!['hello.sh', 'utilities/weather.py', 'slow.sh', 'long.sh', 'nope.sh'].includes(b.script)) return json(404, { error: `no script called ${b.script}`, code: 'unknown_script' });
      assert.equal(b.stream, true);
      assert.equal(b.client, 'Super Face');
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'X-Request-Id': 'REQ1' });
      const line = (o) => res.write(JSON.stringify(o) + '\n');
      line({ type: 'waiting', request: 'REQ1', message: 'Waiting for Run' });
      if (b.script === 'slow.sh') {
        req.on('close', () => seen.closedWhileWaiting++);
        res.on('close', () => seen.closedWhileWaiting++);
        return;
      }
      await wait(20);
      if (b.script === 'nope.sh') return res.end(JSON.stringify({ type: 'denied', code: 'denied', message: 'Don\'t Run' }) + '\n');
      line({ type: 'started', id: 'RUN7', request: 'REQ1', name: b.script });
      line({ type: 'output', stream: 'out', text: b.script === 'utilities/weather.py' ? 'Leeds: 12°C, rain\n' : `Hello, ${(b.args || ['world'])[0]}!\n` });
      if (b.script === 'long.sh') return;
      await wait(10);
      res.end(JSON.stringify({ type: 'done', name: b.script, state: 'succeeded', ok: true, code: 0, seconds: 0.03, id: 'RUN7', output: b.script === 'utilities/weather.py' ? 'Leeds: 12°C, rain\n' : `Hello, ${(b.args || ['world'])[0]}!\n` }) + '\n');
      return;
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
  const memory = new Memory();
  const model = scriptedModel(steps);
  const a = new Assistant({
    model,
    toolrun,
    scheduler,
    memory,
    character: () => CHARACTERS[0],
    speak: (t) => said.push(t),
    stopSpeaking: () => stops++,
    emit: (e) => events.push(e),
  });
  const idle = async () => {
    for (let i = 0; i < 400 && (a.busy || a.inbox.length || a.reflecting); i++) await wait(5);
  };
  return { a, model, said, events, scheduler, memory, toolrun, idle, stops: () => stops };
}

test('the scripts are fetched for the prompt and the chat; Tool Mac Tool Run not running is said plainly', async () => {
  const fake = await fakeToolRun();
  try {
    const t = new ToolRun({ url: () => fake.url });
    const c = await t.refresh();
    assert.equal(c.reachable, true);
    assert.deepEqual(c.scripts[0], { name: 'hello.sh', group: 'scripts', language: 'Bash', summary: 'Says hello', dangers: [], asksForInput: false, inputs: [{ prompt: 'Who', kind: 'argument', optional: true }] });
    assert.equal(c.flows[0].name, 'morning.flow');
    const off = new ToolRun({ url: () => 'http://127.0.0.1:9' });
    assert.match((await off.refresh()).error, /isn't answering/);
    assert.match(await off.run('run_script', { script: 'a.sh' }), /isn't answering/);
  } finally {
    fake.close();
  }
});

test('the routes are fetched too: the library is a tool of its own, the rest (what ships later too) go to call_api', async () => {
  const fake = await fakeToolRun();
  try {
    const t = new ToolRun({ url: () => fake.url });
    const c = await t.refresh();
    assert.ok(hasLibrary(c));
    assert.deepEqual(otherGroups(c).map((g) => g.id), ['straw', 'browser', 'calendar'], "a group a tool covers isn't call_api's; one that's off is listed as off");
    const p = systemPrompt({ character: CHARACTERS[0], catalog: c, memory: new Memory() });
    assert.match(p, /^- library: /m);
    assert.match(p, /^- call_api: /m);
    for (const tool of ['remember', 'recall', 'memory', 'mind', 'show', 'copy']) assert.match(p, new RegExp(`^- ${tool}: `, 'm'), tool);
    assert.doesNotMatch(p, /^- browser: /m, "Chrome's page is off in Tool Mac Tool Run");
    assert.match(p, /^Chrome's page: turned off in Tool Mac Tool Run right now$/m);
    assert.match(p, /^- GET \/api\/calendar\/today: today's events$/m);
    assert.doesNotMatch(p, /\/api\/memory\/files/, 'the memory tools cover MEMORY');
    assert.match(p, /recall it first/);
    assert.match(p, /^Coming up in the next week, from MEMORY[^\n]*\n- 2026-10-27 \(in 3 days\): birthday 10-27 — ada$/m);
    assert.match(p, /^- POST \/api\/straw\/run: run Straw code \[asks on the Mac\]$/m);
    assert.doesNotMatch(p, /^- POST \/api\/run:/m, 'run_script covers it');
    assert.match(p, /use library: the user's notes/);
    // An older Tool Mac Tool Run, without the route list: neither tool is offered.
    const old = systemPrompt({ character: CHARACTERS[0], catalog: { ...c, groups: null }, memory: new Memory() });
    assert.doesNotMatch(old, /^- (library|call_api): /m);
  } finally {
    fake.close();
  }
});

test('library: one op, answered at once; call_api: a listed route, never another server', async () => {
  const fake = await fakeToolRun();
  try {
    const t = new ToolRun({ url: () => fake.url });
    await t.refresh();
    const out = await t.run('library', { op: 'append', name: 'Shopping', text: '- eggs' });
    assert.deepEqual(JSON.parse(out), { name: 'Shopping', action: 'appended' });
    assert.deepEqual(fake.seen.library, { client: 'Super Face', op: 'append', name: 'Shopping', text: '- eggs' });
    assert.match(await t.run('library', { op: 'read', name: 'Ghost' }), /no note called Ghost.*Fix: There is Groceries/);
    assert.match(await t.run('library', { op: 'shred' }), /no library op called shred/);
    assert.match(await t.run('call_api', { method: 'GET', path: '/api/calendar/today' }), /^GET \/api\/calendar\/today: 200\n.*Dentist at 3/);
    assert.match(await t.run('call_api', { method: 'POST', path: '/api/straw/run', body: { source: 'open cloudflare.com' }, why: 'Find Compute' }), /: 200\n.*Compute/);
    assert.equal(fake.seen.straw.why, 'Find Compute', 'a route that asks on the Mac carries the why');
    assert.match(await t.run('call_api', { path: 'https://example.com/api/x' }), /only reaches Tool Mac Tool Run/);
    assert.match(await t.run('call_api', { path: '/etc/passwd' }), /routes under \/api\//);
    assert.match(await t.run('call_api', { path: '/api/nowhere' }), /isn't one listed/);
  } finally {
    fake.close();
  }
});

test("MEMORY, the mind, and showing: each a tool, its arguments as Tool Mac Tool Run takes them", async () => {
  const fake = await fakeToolRun();
  try {
    const t = new ToolRun({ url: () => fake.url });
    await t.refresh();
    const out = JSON.parse(await t.run('remember', { category: 'people', about: 'Ada', text: "The user's sister", notes: 'birthday 03-14', links: ['Acme'] }));
    assert.deepEqual(out, { file: 'PEOPLE', node: 'ada', added_to_file: "- Ada: The user's sister" }, 'the request id is left out');
    assert.deepEqual(fake.seen.memory.at(-1), { client: 'Super Face', op: 'remember', category: 'PEOPLE', about: 'Ada', text: "The user's sister", links: [{ to: 'Acme' }], notes: ['birthday 03-14'] });
    assert.deepEqual(JSON.parse(await t.run('recall', { name: 'Ada' })), { name: 'Ada', found: true, categories: ['PEOPLE'], lines: ['| PEOPLE | ada', '| ada - likes | gardening'] }, 'its lines, not the same again as objects');
    assert.match(await t.run('recall', {}), /^Say whose/);
    assert.match(await t.run('memory', { op: 'upcoming', days: 7 }), /birthday 10-27/);
    assert.match(await t.run('memory', { op: 'compact' }), /no memory op called compact/);
    await t.run('mind', { from: 'ada', label: 'works at', to: 'acme' });
    assert.equal(fake.seen.mind.at(-1).op, 'add', 'a link with a label is an add');
    assert.match(await t.run('mind', { op: 'compact' }), /no mind op called compact/, "compacting the log is the person's");
    await t.run('show', { title: 'Steps', text: '1. Open it' });
    assert.deepEqual(fake.seen.present, { client: 'Super Face', title: 'Steps', text: '1. Open it', why: 'You asked for it' });
    assert.match(await t.run('show', {}), /^Give the text to show/);
    assert.deepEqual(await t.context('What should I get Ada?'), ['| PEOPLE | ada', '| ada - likes | gardening']);
    assert.deepEqual(await new ToolRun({ url: () => fake.url }).context('Ada'), [], 'no mind listed (not fetched yet): nothing asked');
    // What a small model may call them, and the old remember (the assistant's own notes).
    const c = t.catalog;
    assert.deepEqual(canonical({ name: 'link', arguments: { from: 'a', label: 'b', to: 'c' } }, c), { name: 'mind', arguments: { op: 'add', from: 'a', label: 'b', to: 'c' } });
    assert.deepEqual(canonical({ name: 'upcoming', arguments: {} }, c), { name: 'memory', arguments: { op: 'upcoming' } });
    assert.equal(canonical({ name: 'remember', arguments: { section: 'user', note: 'Celsius' } }, c).name, 'learn');
    assert.equal(canonical({ name: 'remember', arguments: { category: 'PEOPLE', about: 'Ada' } }, c).name, 'remember');
    assert.deepEqual(canonical({ name: 'remember', arguments: { about: 'Ada', text: 'my sister' } }, { groups: [] }), { name: 'learn', arguments: { section: 'user', note: 'Ada: my sister' } }, 'without MEMORY, a fact goes in its own notes');
  } finally {
    fake.close();
  }
});

test('what the mind has on what is being said is given to the model with its instructions, once a request', async () => {
  const fake = await fakeToolRun();
  try {
    const { a, model, idle, toolrun } = await setup(['{"tool": "recall", "arguments": {"name": "Ada"}}', 'Ada likes gardening.'], fake);
    await toolrun.refresh();
    a.say('what should I get Ada?');
    await idle();
    const system = model.asked[0][0].content;
    assert.match(system, /^What the mind already has on what's being said[^\n]*\n\| PEOPLE \| ada\n\| ada - likes \| gardening$/m);
    assert.equal(fake.seen.context.length, 1, 'asked once, not every round');
    assert.match(fake.seen.context[0].text, /what should I get Ada\?/);
    assert.equal(a.log.find((e) => e.kind === 'tool').state, 'done');
    assert.equal(a.log.at(-1).text, 'Ada likes gardening.');
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
    assert.deepEqual(trace.list()[0].http.map((h) => h.url.replace(fake.url, '')), ['/api/scripts', '/api/flows', '/api/endpoints', '/api/memory']);
    const log = trace.open({ kind: 'tool', name: 'run_script' });
    await t.run('run_script', { script: 'hello.sh', args: ['Sam'] }, { log });
    const h = log.http[0];
    assert.equal(h.url, `${fake.url}/api/run`);
    assert.equal(h.body.script, 'hello.sh');
    assert.equal(h.status, 200);
    assert.equal(h.request, 'REQ1');
    assert.deepEqual(h.events.map((e) => e.type), ['waiting', 'started', 'output', 'done']);
    const lib = trace.open({ kind: 'tool', name: 'library' });
    await t.run('library', { op: 'append', name: 'Shopping', text: '- eggs' }, { log: lib });
    assert.equal(lib.http[0].request, 'L1');
    assert.deepEqual(lib.http[0].response, { request: 'L1', name: 'Shopping', action: 'appended' });
  } finally {
    fake.close();
  }
});

test('a run: the card waits, it runs, what it printed comes back', async () => {
  const fake = await fakeToolRun();
  try {
    const t = new ToolRun({ url: () => fake.url });
    const states = [];
    const out = await t.run('run_script', { script: 'hello.sh', args: ['Sam'], why: 'You asked' }, { onStatus: (s) => states.push(s.state) });
    assert.match(out, /hello\.sh: succeeded \(exit code 0\)/);
    assert.match(out, /Hello, Sam!/);
    assert.deepEqual([...new Set(states)], ['sending', 'waiting', 'running', 'done']);
    assert.equal(fake.seen.runs[0].why, 'You asked');
    assert.match(await t.run('run_script', { script: 'nope.sh' }), /clicked Don't Run/);
    assert.match(await t.run('run_script', { script: 'ghost.sh' }), /no script called ghost\.sh/);
    assert.equal(await t.run('nothing_like_it', {}), null);
  } finally {
    fake.close();
  }
});

test('cancelled while the card waits: the connection is closed (the card goes), nothing ran', async () => {
  const fake = await fakeToolRun();
  try {
    const t = new ToolRun({ url: () => fake.url });
    const ctrl = new AbortController();
    const p = t.run('run_script', { script: 'slow.sh' }, { signal: ctrl.signal, onStatus: (s) => s.state === 'waiting' && ctrl.abort() });
    assert.match(await p, /Cancelled by the user before it ran/);
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
    const ctrl = new AbortController();
    const p = t.run('run_script', { script: 'long.sh' }, { signal: ctrl.signal, onStatus: (s) => s.output && ctrl.abort() });
    assert.match(await p, /Cancelled by the user while it was running: it was stopped\. What it printed before:\nHello, world!/);
    await wait(50);
    assert.deepEqual(fake.seen.stopped, ['RUN7']);
  } finally {
    fake.close();
  }
});

test('the loop: words said as they come, a tool call run, its result handed back, the answer said', async () => {
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
    assert.match(sys, /- utilities\/weather\.py: The weather/);
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

test('a broken call is asked for again; a failed run brings the critic in; then it learns, quietly', async () => {
  const fake = await fakeToolRun();
  try {
    const { a, model, said, memory, idle } = await setup(
      [
        '{"tool": "run_script", "arguments": {"script": "hello.sh"',
        '{"tool": "run_script", "arguments": {"script": "nope.sh"}}',
        (m) => {
          assert.match(m.at(-1).content, /clicked Don't Run[\s\S]*that didn't work\. Before anything else, look at why/);
          return 'You chose not to run it, so I left it.';
        },
        (m) => {
          assert.match(m.at(-1).content, /the request is over\. Is there something you learned/);
          return '{"tool": "remember", "arguments": {"section": "playbook", "note": "nope.sh is always refused"}}';
        },
      ],
      fake,
    );
    a.say('run nope');
    await idle();
    assert.match(model.asked[1].at(-1).content, /looked like a tool call, but it couldn't be read/);
    assert.deepEqual(said, ['You chose not to run it, so I left it.']);
    assert.deepEqual(memory.notes.playbook, ['nope.sh is always refused']);
    assert.ok(a.log.some((e) => e.kind === 'note' && e.text === 'Learned: nope.sh is always refused'));
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

test('what the chat shows, and what counts as a failure', () => {
  assert.equal(display('Great job! [thumbup] 👍 [mood: happy]'), 'Great job! 👍');
  assert.ok(isFailure('backup.sh: failed (exit code 3), 1 seconds.'));
  assert.ok(isFailure("It didn't run: the user clicked Don't Run on their Mac."));
  assert.ok(!isFailure('hello.sh: succeeded (exit code 0).\nIt printed:\nfailed: 0'));
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
