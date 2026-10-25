// The assistant against a stand-in for Peter (a real HTTP server, answering in words at /api/say
// as Peter does, offering templates, taking on runs and following them) and a scripted model: a
// chat of three, every answer addressed (@user said, @peter sent, never said), Peter's answers
// back in the chat as the user's are, a tone each way, runs that don't hold the conversation up
// and whose news comes in later, cancelling, the nudges, learning, interruptions.
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { Assistant, display, learning } from '../src/main/assistant.mjs';
import { NOTES_CLIENT, Notes, PLAYBOOK, INSTRUCTIONS } from '../src/main/notes.mjs';
import { Peter } from '../src/main/peter.mjs';
import { Trace } from '../src/main/trace.mjs';
import { Ollama } from '../src/main/model.mjs';
import { CHARACTERS } from '../src/shared/characters.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** A stand-in for Peter, answering in words. */
async function fakePeter() {
  const seen = { said: [], log: [], stopped: [], notes: {}, waiting: 0, aboutUser: null };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const url = new URL(req.url, 'http://x');
    const json = (status, o) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(o));
    const text = (t, status = 200) => res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`${t}\n`);
    if (url.pathname === '/api/health') return json(200, { ok: true, service: 'peter', version: '0.1.9', tool_mac_tool_run: { reachable: true, scripts: 3, flows: 1 }, model: { model: 'qwen3:8b' } });
    if (url.pathname === '/api/say/log') return json(200, { ok: true, entries: [...seen.log].reverse() });
    if (url.pathname === '/api/say/stop') {
      const { number } = JSON.parse(body);
      seen.stopped.push(number);
      const e = seen.log.find((x) => x.number === number);
      if (e) e.state = 'withdrawn';
      return json(200, { ok: true, message: "Taken back: the nightly backup won't run." });
    }
    if (url.pathname === '/api/say') {
      const exact = url.searchParams.get('exact') === 'true';
      const client = req.headers['x-client'];
      const t = body.trim();
      if (client === NOTES_CLIENT) {
        (seen.noteReads ||= []).push({ text: t, exact });
        const read = t.match(/^read the note (.+)$/);
        if (read) return text(read[1] in seen.notes ? `The note ${read[1]}:\n${seen.notes[read[1]]}\n\nYou can also say:\n- …` : `There's no note called ${read[1]}.`);
        if (/^what do you know about the user$/.test(t)) return text(seen.aboutUser ? `What's known about the user:\n${seen.aboutUser.map((l) => `- ${l}`).join('\n')}` : 'Nothing is remembered about the user yet.');
      }
      seen.said.push({ text: body, client, replyTo: req.headers['x-reply-to'], type: req.headers['content-type'], exact });
      const l = lines(t);
      if (/^search the web for /i.test(t)) return text(`The web has these for "${t.slice(19)}":\n1. Leeds weather\n   https://weather.example/leeds\n   Rain today`);
      if (/^read the page at /i.test(t)) return text('The page at https://weather.example/leeds:\nLeeds today: 12°C and rain, clearing by 6pm.');
      if (/^what's the weather in /i.test(t)) return text('Leeds: 12°C, rain.');
      if (/weather/i.test(t)) return text("These can do that:\n1. Search the web\n     search the web for {what to look for}\n2. Weather\n     what's the weather in {a place}\nFill one in and say it back.");
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
    picked: 'qwen3:8b',
    current: () => ({ model: 'qwen3:8b' }),
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
  const peter = new Peter({ url: () => fake?.url || 'http://127.0.0.1:9', replyTo: () => 'http://127.0.0.1:8769/api/peter' });
  await peter.check();
  const said = [];
  const events = [];
  const tones = [];
  let stops = 0;
  const notes = new Notes({ peter });
  const model = scriptedModel(steps);
  const a = new Assistant({
    model,
    peter,
    notes,
    character: () => CHARACTERS[0],
    speak: (t) => said.push(t),
    stopSpeaking: () => stops++,
    tone: (w) => tones.push(w),
    emit: (e) => events.push(e),
  });
  const idle = async () => {
    for (let i = 0; i < 400 && (a.busy || a.inbox.length || a.reflecting); i++) await wait(5);
  };
  return { a, model, said, events, tones, notes, peter, idle, stops: () => stops };
}

test('a chat of three: @user is said, @peter is sent as it is (never said), and his answer comes back as the user\'s do', async () => {
  const fake = await fakePeter();
  try {
    const { a, model, said, tones, idle } = await setup(
      [
        '@user Let me check.\n@peter search the web for Leeds weather today',
        (m) => {
          assert.match(m.at(-1).content, /^\[Peter, \w+day [^\]]+\] @qwen3 The web has these for "Leeds weather today":\n1\. Leeds weather/);
          assert.equal(m.at(-1).role, 'user', "Peter's answer is a message to the model, as the user's are");
          return '@peter read the page at https://weather.example/leeds';
        },
        (m) => {
          assert.match(m.at(-1).content, /12°C and rain/);
          return "@user It's 12 degrees and raining in Leeds, clearing by six. [shrug]";
        },
      ],
      fake,
    );
    a.say("what's the weather in Leeds?", { how: 'said' });
    await idle();
    assert.deepEqual(said, ['Let me check.', "It's 12 degrees and raining in Leeds, clearing by six. [shrug]"], 'what was written to Peter is never said');
    assert.deepEqual(fake.seen.said.map((x) => x.text), ['search the web for Leeds weather today', 'read the page at https://weather.example/leeds']);
    assert.deepEqual(
      fake.seen.said.map((x) => [x.client, x.replyTo, x.type, x.exact]),
      Array(2).fill(['Super Face', 'http://127.0.0.1:8769/api/peter', 'text/plain; charset=utf-8', false]),
      'as plain text, saying who it is and where to tell it how a run went',
    );
    assert.deepEqual(tones, ['to-peter', 'from-peter', 'to-peter', 'from-peter'], 'a tone for each message to Peter, and each back');
    const sys = model.asked[0][0].content;
    assert.match(sys, /You are Ivy/);
    assert.match(sys, /In this chat you are @qwen3\./);
    assert.match(model.asked[0][1].content, /^\[the user, said aloud, \w+day \d+ \w+ \d{4}, \d\d:\d\d:\d\d \(UTC[+-]\d\d:\d\d\)\] @qwen3 what's the weather in Leeds\?$/);
    const chat = a.log.filter((e) => !e.hidden).map((e) => [e.kind, e.from, e.to, e.text]);
    assert.deepEqual(chat.map((x) => x.slice(0, 3)), [
      ['user', 'You', 'qwen3'],
      ['assistant', 'qwen3', 'user'],
      ['to-peter', 'qwen3', 'peter'],
      ['peter', 'Peter', 'qwen3'],
      ['to-peter', 'qwen3', 'peter'],
      ['peter', 'Peter', 'qwen3'],
      ['assistant', 'qwen3', 'user'],
    ]);
    assert.equal(chat[2][3], 'search the web for Leeds weather today');
    assert.match(chat[3][3], /^The web has these/);
    assert.equal(chat[6][3], "It's 12 degrees and raining in Leeds, clearing by six.");
  } finally {
    fake.close();
  }
});

test('its notes are read through Peter, exactly (never his model), as a client of their own', async () => {
  const fake = await fakePeter();
  fake.seen.notes[PLAYBOOK] = `# ${PLAYBOOK}\n\n- weather.py takes the city first`;
  fake.seen.notes[INSTRUCTIONS] = 'Call me Sam.';
  fake.seen.aboutUser = ['the user: lives in Leeds'];
  try {
    const { a, model, idle } = await setup(['@user Hi Sam.'], fake);
    a.say('hello');
    await idle();
    const sys = model.asked[0][0].content;
    assert.match(sys, /Your playbook[^\n]*\n- weather\.py takes the city first/);
    assert.match(sys, /What MEMORY has on the user themselves:\n- the user: lives in Leeds/);
    assert.match(sys, /The user's standing instructions \(follow them\):\nCall me Sam\./);
    assert.ok(fake.seen.noteReads.every((r) => r.exact), 'read exactly: Peter never asks his model for these');
    assert.equal(fake.seen.said.length, 0, "the model's own messages to Peter aren't mixed up with them");
  } finally {
    fake.close();
  }
});

test("an offer of Peter's is filled in and said back; once the request is over, his offers are folded to a line", async () => {
  const fake = await fakePeter();
  try {
    const { a, model, said, idle } = await setup(
      [
        '@peter I need to know about the weather in Leeds',
        (m) => {
          assert.match(m.at(-1).content, /These can do that:\n1\. Search the web/);
          return "@peter\n```\nwhat's the weather in Leeds\n```";
        },
        '@user 12 degrees and rain.',
        '@user nothing', // it took work: a moment to learn, and nothing to learn
        (m) => {
          const offer = m.find((x) => /^\[Peter, /.test(x.content) && /offered/.test(x.content));
          assert.match(offer?.content, /@qwen3 \(offered: Search the web, Weather\)$/);
          assert.ok(m.some((x) => /Leeds: 12°C, rain\./.test(x.content)), 'what came of it stays');
          return '@user You are welcome.';
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

test("a run doesn't hold the conversation up: asked for, followed, and its news comes in as a message from Peter, with a tone", async () => {
  const fake = await fakePeter();
  try {
    const { a, model, said, tones, idle } = await setup(
      [
        "@user I'll ask for it.\n@peter run the nightly backup",
        (m) => {
          assert.match(m.at(-1).content, /Asked for the nightly backup\. I'll tell you how it goes\./);
          return "@user It's asked for. I'll tell you when it's done.";
        },
        (m) => {
          assert.match(m.at(-1).content, /^\[Peter, [^\]]+\] @qwen3 Meanwhile: The nightly backup finished \(it worked\)\.$/);
          return "@user Your backup's done, and it worked.";
        },
      ],
      fake,
    );
    a.say('back up my documents');
    await idle();
    const msg = a.log.find((e) => e.kind === 'to-peter');
    assert.equal(msg.state, 'waiting', 'on the Mac, waiting for Run: the turn is over all the same');
    assert.equal(msg.number, 1);
    assert.ok(!a.busy);
    // Peter calls back once it's over.
    a.news('Meanwhile: The nightly backup finished (it worked).', [{ number: 1, state: 'worked', result: 'Backed up 3 files.' }]);
    assert.equal(msg.state, 'done');
    await idle();
    assert.equal(model.asked.length, 3);
    assert.deepEqual(said, ["I'll ask for it.", "It's asked for.", "I'll tell you when it's done.", "Your backup's done, and it worked."]);
    assert.deepEqual(a.log.filter((e) => e.kind === 'peter' && e.news).map((e) => [e.from, e.to, e.text]), [['Peter', 'qwen3', 'Meanwhile: The nightly backup finished (it worked).']]);
    assert.deepEqual(tones, ['to-peter', 'from-peter', 'from-peter']);
  } finally {
    fake.close();
  }
});

test('what the user says while Peter is working for them waits its turn; then it is answered at once', async () => {
  const fake = await fakePeter();
  try {
    const { a, model, said, idle } = await setup(
      [
        '@peter search the web for Leeds weather',
        (m) => {
          // Peter's answer goes on to the model at once, even though the user has spoken meanwhile.
          assert.match(m.at(-1).content, /^\[Peter, /);
          return '@user Rain in Leeds.';
        },
        (m) => {
          assert.match(m.at(-1).content, /^\[the user, typed, [^\]]+\] @qwen3 and in York\?$/);
          return '@user York too.';
        },
      ],
      fake,
    );
    a.say('weather in Leeds');
    for (let i = 0; i < 200 && !fake.seen.said.length; i++) await wait(2);
    a.say('and in York?');
    await idle();
    assert.equal(model.asked.length, 3, 'nothing was asked twice');
    assert.deepEqual(said, ['Rain in Leeds.', 'York too.']);
  } finally {
    fake.close();
  }
});

test('cancel: a run Peter is following is taken back, and the model is not asked again', async () => {
  const fake = await fakePeter();
  try {
    const { a, model, idle } = await setup(['@peter run the nightly backup', '@user Asked for it.'], fake);
    a.say('back up my documents');
    await idle();
    const msg = a.log.find((e) => e.kind === 'to-peter');
    assert.equal(msg.state, 'waiting');
    assert.ok(a.cancel());
    for (let i = 0; i < 100 && msg.state !== 'cancelled'; i++) await wait(5);
    assert.equal(msg.state, 'cancelled');
    assert.deepEqual(fake.seen.stopped, [1]);
    for (let i = 0; i < 100 && !a.log.some((e) => e.kind === 'note' && /Taken back/.test(e.text)); i++) await wait(5);
    assert.ok(a.log.some((e) => e.kind === 'note' && /^Cancelled: Taken back/.test(e.text)));
    assert.equal(model.asked.length, 2);
    assert.equal(a.cancelTool(msg.id), false, 'over already');
  } finally {
    fake.close();
  }
});

test('cancel while Peter is answering: the request is dropped, and the model is not asked again', async () => {
  const fake = await fakePeter();
  try {
    const { a, model, idle, stops } = await setup(['@user On it.\n@peter take your time'], fake);
    a.say('do the slow thing');
    for (let i = 0; i < 200 && !fake.seen.waiting; i++) await wait(5);
    assert.equal(a.state().phase, 'tool');
    assert.ok(a.cancel());
    await idle();
    assert.equal(model.asked.length, 1);
    assert.equal(a.log.find((e) => e.kind === 'to-peter').state, 'cancelled');
    assert.match(a.history.at(-1).content, /Cancelled by the user before Peter answered/);
    assert.ok(stops() >= 1);
    await wait(30);
    assert.equal(fake.seen.waiting, 0, 'hung up');
  } finally {
    fake.close();
  }
});

test('clear while Peter is answering: nothing of it is left in the chat or the conversation', async () => {
  const fake = await fakePeter();
  try {
    const { a, model, events, idle } = await setup(['@user On it.\n@peter take your time'], fake);
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

test('words that promise work with no message are sent back once; "nothing" is never said', async () => {
  const fake = await fakePeter();
  try {
    const { a, model, said, idle } = await setup(["@user I'll check that for you.", '@peter search the web for later today', '@user Rain later. 🙂', '@user (nothing)'], fake);
    a.say('anything later?');
    await idle();
    assert.match(model.asked[1].at(-1).content, /you said you'd do something, but didn't ask Peter/);
    // The promise was never said: a sentence is said once the next begins, and this one was sent back first.
    assert.deepEqual(said, ['Rain later. 🙂']);
    a.say('(the TV talking)');
    await idle();
    assert.equal(said.length, 1);
  } finally {
    fake.close();
  }
});

test('an answer addressed to no one is the user\'s: said, and kept as "@user …" for the model to see', async () => {
  const { a, model, said, idle } = await setup(['Sure, it is done. (nods) [smile]']);
  a.say('is it done?');
  await idle();
  assert.deepEqual(said.join(' ').replace(/\s+/g, ' '), 'Sure, it is done. [smile]', 'the cue is left for the face');
  assert.equal(a.log.filter((e) => e.kind === 'assistant').at(-1).text, 'Sure, it is done.');
  assert.match(a.history.at(-1).content, /^@user Sure, it is done\./);
  void model;
});

test("JSON out of habit is sent back; what Peter can't do brings the critic in; then it learns, quietly", async () => {
  const fake = await fakePeter();
  try {
    const { a, model, said, notes, idle } = await setup(
      [
        '{"tool": "run_script", "arguments": {"script": "teleport.sh"}}',
        '@peter teleport me to Paris',
        (m) => {
          assert.match(m.at(-1).content, /I don't know how to do that yet\.[\s\S]*that didn't work\. Before anything else, look at why/);
          return "@user Sorry, that's beyond what I can do.";
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
    assert.ok(a.log.some((e) => e.kind === 'note' && e.text === "Learned: Peter can't teleport anyone"));
    await notes.refresh();
    assert.deepEqual(notes.playbook, ["- Peter can't teleport anyone"], 'read back from Peter');
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
  assert.equal(learning({ to: 'user', text: 'hello' }), null);
});

test("Peter not there is said plainly, and the model is told so", async () => {
  const { a, model, said, idle } = await setup(['@peter search the web for x', (m) => {
    assert.match(m.at(-1).content, /Peter isn't answering/);
    return '@user Peter needs to be open for that.';
  }]);
  a.say('search for x');
  await idle();
  assert.match(model.asked[0][0].content, /Peter isn't answering right now/);
  assert.deepEqual(said, ['Peter needs to be open for that.']);
});

test('more said while it is still thinking is asked together, as one request', async () => {
  let release;
  const { a, model, said, idle } = await setup([
    (_m, signal) =>
      new Promise((resolve, reject) => {
        release = resolve;
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
    '@user Paris, at nine tomorrow. Done.',
  ]);
  a.say('book a table');
  await wait(10);
  a.say('in Paris at nine tomorrow');
  await idle();
  assert.equal(model.asked.length, 2);
  const asked = model.asked[1].at(-1).content;
  assert.match(asked, /typed, [^\]]+\] @qwen3 book a table\n\[the user, typed, [^\]]+\] @qwen3 in Paris at nine tomorrow$/);
  assert.equal(model.asked[1].filter((m) => m.role === 'user').length, 1);
  assert.deepEqual(said, ['Paris, at nine tomorrow.', 'Done.']);
  void release;
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
  const chunks = ['{"message":{"content":"<think>hm</think>Hel"}}', '{"message":{"content":"lo!"}}', '{"done":true}'].map((l) => l + '\n');
  const fetch = async (url, { body }) => {
    assert.equal(url, 'http://ollama/api/chat');
    assert.equal(JSON.parse(body).model, 'qwen3:8b');
    return new Response(new ReadableStream({ start: (c) => (chunks.forEach((l) => c.enqueue(new TextEncoder().encode(l))), c.close()) }), { status: 200 });
  };
  const m = new Ollama({ current: () => ({ url: 'http://ollama', model: 'qwen3:8b' }), fetch, trace });
  const text = await m.chat([{ role: 'system', content: 'You are Ivy' }, { role: 'user', content: 'hi' }], { onText: () => {} });
  assert.equal(text, 'Hello!');
  const [rec] = trace.list();
  assert.equal(rec.purpose, 'answer');
  assert.equal(rec.state, 'done');
  assert.equal(rec.text, '<think>hm</think>Hello!', 'what came back, thinking and all');
  const failing = new Ollama({ current: () => ({ url: 'http://127.0.0.1:9', model: 'x' }), trace });
  await assert.rejects(failing.chat([{ role: 'user', content: 'hi' }], { purpose: 'learning' }));
  assert.equal(trace.list()[1].state, 'failed');
});
