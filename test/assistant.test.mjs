// The assistant against a stand-in for Tool Mac Tool Run (a real HTTP server, answering in words
// at /api/say as the real one does, offering templates, taking on runs and following them) and a
// scripted model: messages to Peter sent as written, his answers handed back, runs that don't hold
// the conversation up and whose news comes in later, cancelling, the Clock, the nudges, learning,
// interruptions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import { Assistant, display, learning } from '../src/main/assistant.mjs';
import { Notes, PLAYBOOK, INSTRUCTIONS } from '../src/main/notes.mjs';
import { Scheduler } from '../src/main/scheduler.mjs';
import { ToolRun } from '../src/main/toolrun.mjs';
import { Trace } from '../src/main/trace.mjs';
import { Ollama } from '../src/main/model.mjs';
import { CHARACTERS } from '../src/shared/characters.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const arg = (name, about, required = false, type = 'string') => ({ name, type, required, about });
/** The tools the stand-in lists (for the chat's list, and the notes this app reads for itself). */
const TOOLS = [
  { name: 'web_search', description: 'Searches the web from this Mac, at once.', args: [arg('q', 'what to search for', true)], aliases: [] },
  { name: 'library', description: "The person's notes.", args: [arg('op', 'read, append, write…', true), arg('name', "the note's name")], aliases: [] },
  { name: 'remember', description: 'Keeps something the person told you.', args: [arg('category', 'PEOPLE…', true), arg('about', 'who', true)], aliases: [] },
  { name: 'recall', description: "What's remembered about a name.", args: [arg('name', 'as said', true)], aliases: [] },
  { name: 'memory', description: 'The rest of MEMORY.', args: [arg('op', 'upcoming…', true)], aliases: [] },
  { name: 'mind', description: 'What links to what.', args: [arg('op', 'about, add…', true)], aliases: [] },
];

/** A template filled in as lines: its title, then "- label: value" each. */
function lines(text) {
  const [title, ...rest] = text.split('\n');
  const out = { title: title.trim() };
  for (const l of rest) {
    const m = l.match(/^\s*-\s*([^:]+):\s*(.*)$/);
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

/** A stand-in for Tool Mac Tool Run, answering in words. `old`: one from before it could. */
async function fakeToolRun({ old = false } = {}) {
  const seen = { said: [], log: [], stopped: [], calls: [], notes: {}, waiting: 0 };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const url = new URL(req.url, 'http://x');
    const json = (status, o) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(o));
    const text = (t, status = 200) => res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`${t}\n`);
    if (url.pathname === '/api/tools') return json(200, { ok: true, tools: TOOLS });
    if (url.pathname === '/api/scripts') return json(200, { folder: '/Users/sam/Scripts', scripts: [{ name: 'utilities/weather.py', group: 'utilities', summary: 'The weather', dangers: [] }] });
    if (url.pathname === '/api/flows') return json(200, { flows: [] });
    if (url.pathname === '/api/mind/context') return json(200, { lines: /ada/i.test(JSON.parse(body).text) ? ['| PEOPLE | ada'] : [] });
    if (url.pathname === '/api/say/forms') {
      (seen.forms ||= []).push(url.searchParams.get('q'));
      return json(200, { forms: /weather|rain/i.test(url.searchParams.get('q')) ? [{ template: 'search the web for {what to look for}' }, { template: "what's the weather in {a place}" }] : [] });
    }
    if (url.pathname === '/api/say/log') return json(200, { ok: true, entries: [...seen.log].reverse() });
    if (url.pathname === '/api/say/stop') {
      const { number } = JSON.parse(body);
      seen.stopped.push(number);
      const e = seen.log.find((x) => x.number === number);
      if (e) e.state = 'withdrawn';
      return json(200, { ok: true, message: "Taken back: the nightly backup won't run." });
    }
    if (url.pathname === '/api/say') {
      if (old) return json(404, { error: 'no such route', code: 'not_found' });
      seen.said.push({ text: body, client: req.headers['x-client'], replyTo: req.headers['x-reply-to'], type: req.headers['content-type'] });
      const t = body.trim();
      const l = lines(t);
      if (/^search the web for /i.test(t)) return text(`The web has these for "${t.slice(19)}":\n1. Leeds weather\n   https://weather.example/leeds\n   Rain today`);
      if (/^read the page at /i.test(t)) return text('The page at https://weather.example/leeds:\nLeeds today: 12°C and rain, clearing by 6pm.');
      if (/^what's the weather in /i.test(t)) return text('Leeds: 12°C, rain.');
      if (/weather/i.test(t)) return text("These can do that:\n1. Search the web\n     search the web for {what to look for}\n2. The weather\n     what's the weather in {a place}\nFill one in and say it back.");
      if (/^run the nightly backup$/i.test(t)) {
        const n = seen.log.length + 1;
        seen.log.push({ number: n, asked: new Date().toISOString(), said: t, what: 'the nightly backup', state: 'waiting', waits_for_the_mac: true, request: `REQ${n}` });
        return text("Asked for the nightly backup. I'll tell you how it goes.\n\nYou can also say: what happened to {something you asked for}");
      }
      if (/^take your time$/i.test(t)) {
        // Never answers: the request is still with Peter when it's called off.
        seen.waiting++;
        res.on('close', () => seen.waiting--);
        return;
      }
      if (/^add to a note$/i.test(l.title)) {
        seen.notes[l.name] = `${seen.notes[l.name] ?? ''}${l.text}\n`;
        return text(`Added that to the end of the note ${l.name}.`);
      }
      return text("I don't know how to do that yet.\n\nYou can also say: what can you do");
    }
    const call = url.pathname.match(/^\/api\/tools\/([^/]+)$/);
    if (call) {
      const name = decodeURIComponent(call[1]);
      const a = JSON.parse(body || '{}').arguments || {};
      seen.calls.push({ name, arguments: a });
      switch (name) {
        case 'library': {
          const notes = seen.notes;
          if (a.op === 'read_many') return json(200, { notes: a.names.filter((n) => n in notes).map((n) => ({ name: n, text: notes[n] })), missing: a.names.filter((n) => !(n in notes)) });
          if (a.op === 'write') notes[a.name] = a.text;
          return json(200, { name: a.name });
        }
        case 'remember':
          (seen.memory ||= []).push({ op: 'remember', ...a });
          return json(200, { file: a.category });
        case 'recall':
          return json(200, seen.aboutUser ? { found: true, lines: seen.aboutUser } : { found: false, lines: [] });
        case 'memory':
          return json(200, { days: a.days, lines: ['2026-10-27 (in 3 days): birthday 10-27 — ada'] });
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

async function setup(steps, fake, { trace = null } = {}) {
  const toolrun = new ToolRun({ url: () => fake?.url || 'http://127.0.0.1:9', replyTo: () => 'http://127.0.0.1:8769/api/peter', trace });
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
    trace,
  });
  const idle = async () => {
    for (let i = 0; i < 400 && (a.busy || a.inbox.length || a.reflecting); i++) await wait(5);
  };
  return { a, model, said, events, scheduler, notes, toolrun, idle, stops: () => stops };
}

test('the model asks Peter in words: what it wrote after @peter is sent as it is, his answer comes back, the answer is said', async () => {
  const fake = await fakeToolRun();
  try {
    const { a, model, said, idle } = await setup(
      [
        "Let me check.\n@peter search the web for Leeds weather today",
        (m) => {
          assert.match(m.at(-1).content, /^Peter \(to you; the user doesn't see this\):\nThe web has these for "Leeds weather today":\n1\. Leeds weather/);
          return '@peter read the page at https://weather.example/leeds';
        },
        (m) => {
          assert.match(m.at(-1).content, /12°C and rain/);
          return "It's 12 degrees and raining in Leeds, clearing by six. [shrug]";
        },
      ],
      fake,
    );
    a.say("what's the weather in Leeds?", { how: 'said' });
    await idle();
    assert.deepEqual(said, ['Let me check.', "It's 12 degrees and raining in Leeds, clearing by six. [shrug]"], 'what was written after @peter is never said');
    assert.deepEqual(fake.seen.said.map((x) => x.text), ['search the web for Leeds weather today', 'read the page at https://weather.example/leeds']);
    assert.deepEqual(
      fake.seen.said.map((x) => [x.client, x.replyTo, x.type]),
      Array(2).fill(['Super Face', 'http://127.0.0.1:8769/api/peter', 'text/plain; charset=utf-8']),
      'as plain text, saying who it is and where to tell it how a run went',
    );
    const sys = model.asked[0][0].content;
    assert.match(sys, /You are Ivy/);
    assert.match(sys, /Peter's templates that fit what was just said[^\n]*\nsearch the web for \{what to look for\}\n\nwhat's the weather in \{a place\}/);
    assert.deepEqual(fake.seen.forms, ["what's the weather in Leeds?"], 'asked for once a request');
    assert.match(model.asked[0][1].content, /^\[\w+day \d+ \w+ \d{4}, \d\d:\d\d:\d\d \(UTC[+-]\d\d:\d\d\), said\] what's the weather in Leeds\?$/);
    const kinds = a.log.filter((e) => !e.hidden).map((e) => [e.kind, e.kind === 'tool' ? `${e.name} ${e.state}: ${e.said}` : e.text]);
    assert.deepEqual(kinds, [
      ['user', "what's the weather in Leeds?"],
      ['assistant', 'Let me check.'],
      ['tool', 'Peter done: search the web for Leeds weather today'],
      ['tool', 'Peter done: read the page at https://weather.example/leeds'],
      ['assistant', "It's 12 degrees and raining in Leeds, clearing by six."],
    ]);
    assert.match(a.log.find((e) => e.kind === 'tool').result, /^The web has these/);
  } finally {
    fake.close();
  }
});

test("an offer of Peter's is filled in and said back; once the request is over, his offers are folded to a line", async () => {
  const fake = await fakeToolRun();
  try {
    const { a, model, said, idle } = await setup(
      [
        '@peter I need to know about the weather in Leeds',
        (m) => {
          assert.match(m.at(-1).content, /These can do that:\n1\. Search the web/);
          return "@peter\n```\nwhat's the weather in Leeds\n```";
        },
        '12 degrees and rain.',
        'nothing', // it took work: a moment to learn, and nothing to learn
        (m) => {
          const offer = m.find((x) => /^Peter \(to you/.test(x.content) && /offered/.test(x.content));
          assert.equal(offer?.content, "Peter (to you; the user doesn't see this):\nPeter offered: Search the web, The weather.");
          assert.ok(m.some((x) => /Leeds: 12°C, rain\./.test(x.content)), 'what came of it stays');
          return 'You are welcome.';
        },
      ],
      fake,
    );
    a.say('weather in Leeds?');
    await idle();
    assert.equal(fake.seen.said[1].text, "what's the weather in Leeds", 'the fence around it is not sent');
    a.say('thanks');
    await idle();
    assert.equal(model.asked.length, 5);
    assert.deepEqual(said, ['12 degrees and rain.', 'You are welcome.']);
  } finally {
    fake.close();
  }
});

test("a run doesn't hold the conversation up: asked for, its card follows it, and its news comes in as a message of its own", async () => {
  const fake = await fakeToolRun();
  try {
    const { a, model, said, idle } = await setup(
      [
        "I'll ask for it.\n@peter run the nightly backup",
        (m) => {
          assert.match(m.at(-1).content, /Asked for the nightly backup\. I'll tell you how it goes\./);
          return "It's asked for. I'll tell you when it's done.";
        },
        (m) => {
          assert.match(m.at(-1).content, /^\[[^\]]+, from Peter, not the user\] Meanwhile: The nightly backup finished \(it worked\)\.$/);
          return "Your backup's done, and it worked.";
        },
      ],
      fake,
    );
    a.say('back up my documents');
    await idle();
    const card = a.log.find((e) => e.kind === 'tool');
    assert.equal(card.state, 'waiting', 'on the Mac, waiting for Run: the turn is over all the same');
    assert.equal(card.number, 1);
    assert.equal(card.request, 'REQ1');
    assert.ok(!a.busy);
    // Tool Mac Tool Run calls back once it's over.
    a.news('Meanwhile: The nightly backup finished (it worked).', [{ number: 1, state: 'worked', result: 'Backed up 3 files.' }]);
    assert.equal(card.state, 'done');
    assert.equal(card.output, 'Backed up 3 files.');
    await idle();
    assert.equal(model.asked.length, 3);
    assert.deepEqual(said, ["I'll ask for it.", "It's asked for.", "I'll tell you when it's done.", "Your backup's done, and it worked."]);
    assert.deepEqual(a.log.filter((e) => e.kind === 'news').map((e) => e.text), ['Meanwhile: The nightly backup finished (it worked).']);
  } finally {
    fake.close();
  }
});

test('cancel: a run Peter is following is taken back, and the model is not asked again', async () => {
  const fake = await fakeToolRun();
  try {
    const { a, model, idle } = await setup(['@peter run the nightly backup', 'Asked for it.'], fake);
    a.say('back up my documents');
    await idle();
    const card = a.log.find((e) => e.kind === 'tool');
    assert.equal(card.state, 'waiting');
    assert.ok(a.cancel());
    for (let i = 0; i < 100 && card.state !== 'cancelled'; i++) await wait(5);
    assert.equal(card.state, 'cancelled');
    assert.deepEqual(fake.seen.stopped, [1]);
    assert.match(card.result, /Cancelled: Taken back/);
    assert.equal(model.asked.length, 2);
    // A card's own Cancel does the same for one.
    assert.equal(a.cancelTool(card.id), false, 'over already');
  } finally {
    fake.close();
  }
});

test('cancel while Peter is answering: the request is dropped, and the model is not asked again', async () => {
  const fake = await fakeToolRun();
  try {
    const { a, model, idle, stops } = await setup(['On it.\n@peter take your time'], fake);
    a.say('do the slow thing');
    for (let i = 0; i < 200 && !fake.seen.waiting; i++) await wait(5);
    assert.equal(a.state().phase, 'tool');
    assert.ok(a.cancel());
    await idle();
    assert.equal(model.asked.length, 1);
    assert.equal(a.log.find((e) => e.kind === 'tool').state, 'cancelled');
    assert.match(a.history.at(-1).content, /Cancelled by the user before Peter answered/);
    assert.ok(stops() >= 1);
    await wait(30);
    assert.equal(fake.seen.waiting, 0, 'hung up');
  } finally {
    fake.close();
  }
});

test('clear while Peter is answering: nothing of it is left in the chat or the conversation', async () => {
  const fake = await fakeToolRun();
  try {
    const { a, model, events, idle } = await setup(['On it.\n@peter take your time'], fake);
    a.say('do the slow thing');
    for (let i = 0; i < 200 && !fake.seen.waiting; i++) await wait(5);
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

test('words that promise work with no message are sent back once; "(nothing)" is never said', async () => {
  const { a, model, said, idle } = await setup(["I'll check that for you.", "@clock what's scheduled", 'Nothing is scheduled. 🙂', '(nothing)']);
  a.say('anything on later?');
  await idle();
  assert.match(model.asked[1].at(-1).content, /you said you'd do something, but didn't ask Peter/);
  assert.equal(model.asked[2].at(-1).content, "Clock (to you; the user doesn't see this):\nNothing is scheduled.");
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

test('JSON out of habit is sent back; what Peter can\'t do brings the critic in; then it learns, quietly', async () => {
  const fake = await fakeToolRun();
  try {
    const { a, model, said, notes, idle } = await setup(
      [
        '{"tool": "run_script", "arguments": {"script": "teleport.sh"}}',
        '@peter teleport me to Paris',
        (m) => {
          assert.match(m.at(-1).content, /I don't know how to do that yet\.[\s\S]*that didn't work\. Before anything else, look at why/);
          return "Sorry, that's beyond what I can do.";
        },
        (m) => {
          assert.match(m.at(-1).content, /the request is over\. Is there something you learned/);
          return `@peter\nAdd to a note\n- name: ${PLAYBOOK}\n- text: - Peter can't teleport anyone`;
        },
      ],
      fake,
    );
    a.say('teleport me to Paris');
    await idle();
    assert.match(model.asked[1].at(-1).content, /there are no tools to call with JSON/);
    assert.deepEqual(said, ["Sorry, that's beyond what I can do."]);
    assert.equal(fake.seen.notes[PLAYBOOK], "- Peter can't teleport anyone\n");
    assert.deepEqual(notes.playbook, ["- Peter can't teleport anyone"], 'read back once it is written');
    assert.ok(a.log.some((e) => e.kind === 'note' && e.text === "Learned: Peter can't teleport anyone"));
  } finally {
    fake.close();
  }
});

test('while it learns, only its playbook and notes on the user may be written', () => {
  assert.equal(learning({ to: 'peter', text: `Add to a note\n- name: ${PLAYBOOK}\n- text: - weather.py takes the city first` }), 'Learned: weather.py takes the city first');
  assert.equal(learning({ to: 'peter', text: `Write a note\n- name: ${PLAYBOOK}\n- text: - a\n- b` }), 'Rewrote its playbook.');
  assert.equal(learning({ to: 'peter', text: 'Remember something\n- category: PEOPLE\n- about: the user\n- fact: likes Celsius' }), 'Learned about you: likes Celsius');
  assert.equal(learning({ to: 'peter', text: 'Add to a note\n- name: Groceries\n- text: - eggs' }), null);
  assert.equal(learning({ to: 'peter', text: 'run the nightly backup' }), null);
  assert.equal(learning({ to: 'clock', text: '- in minutes: 5\n- task: x' }), null);
});

test("a Tool Mac Tool Run too old to be talked to in words is said plainly", async () => {
  const fake = await fakeToolRun({ old: true });
  try {
    const { a, model, idle } = await setup(['@peter search the web for x', "My helper needs updating."], fake);
    a.say('look up x');
    await idle();
    assert.match(model.asked[1].at(-1).content, /this Tool Mac Tool Run is too old \(it has no \/api\/say\)/);
    const { a: b, model: m2, idle: idle2 } = await setup(['@peter search the web for x', 'It is not running.']);
    b.say('look up x');
    await idle2();
    assert.match(m2.asked[1].at(-1).content, /Peter isn't answering: Tool Mac Tool Run isn't reachable/);
    assert.match(m2.asked[0][0].content, /Peter isn't available right now/);
  } finally {
    fake.close();
  }
});

test('every message to Peter is noted for the Calls tab: what was said, the request, what came back', async () => {
  const fake = await fakeToolRun();
  try {
    const trace = new Trace({ name: 'calls' });
    const { a, idle } = await setup(['@peter search the web for rain', 'Rain.'], fake, { trace });
    a.say('rain?');
    await idle();
    const rec = trace.list().find((x) => x.kind === 'tool');
    assert.equal(rec.name, '@peter');
    assert.deepEqual(rec.args, { said: 'search the web for rain' });
    assert.equal(rec.where, 'mac');
    assert.equal(rec.state, 'done');
    assert.equal(rec.http[0].method, 'POST');
    assert.equal(rec.http[0].url, `${fake.url}/api/say`);
    assert.equal(rec.http[0].body, 'search the web for rain');
    assert.equal(rec.http[0].status, 200);
    assert.match(rec.http[0].response, /^The web has these for "rain"/);
    assert.match(rec.result, /^The web has these/);
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
    assert.match(system, /ask Peter to add it to the note "Super Face playbook"/);
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

test('a schedule set through the Clock comes due as a request of its own', async () => {
  const { a, scheduler, model, said, idle } = await setup([
    '@clock\n- in minutes: 0.001\n- task: Remind the user to stretch.',
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
  assert.equal(a.log.find((e) => e.kind === 'tool').name, 'Clock');
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
