// The core as the app builds it, over the API: chat (and wait for the answer), what's heard (its
// own voice dropped, "stop" and "cancel" done here, an unfinished phrase waited on), the schedule,
// memory, the character that is its voice.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createApi } from '../src/main/api.mjs';
import { createCore } from '../src/main/core.mjs';
import { Settings } from '../src/main/settings.mjs';
import { Speech } from '../src/main/speech.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let replies = []; // what the fake Ollama says next
let asked = [];
let spoken = [];
let speech;
let core;
let settings;
let base;
let server;
let shown = 0;

/** Ollama, as far as the app uses it. */
async function fakeFetch(url, init = {}) {
  if (String(url).endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'qwen3:8b' }] }));
  if (String(url).endsWith('/api/chat')) {
    const body = JSON.parse(init.body);
    asked.push(body);
    const text = replies.shift() ?? 'Okay.';
    if (!body.stream) return new Response(JSON.stringify({ message: { content: text } }));
    return new Response(new Blob([JSON.stringify({ message: { content: text } }) + '\n', JSON.stringify({ done: true }) + '\n']).stream());
  }
  throw new TypeError('fetch failed'); // Tool Mac Tool Run isn't running
}

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-core-'));
  settings = new Settings(path.join(dir, 'settings.json'));
  speech = new Speech({
    send: (type, data) => {
      if (type !== 'speak') return;
      spoken.push(data);
      setImmediate(() => {
        speech.event({ type: 'started', id: data.id });
        speech.event({ type: 'sentence', id: data.id, text: data.text, duration: 2 });
        if (!data.text.includes('long')) speech.event({ type: 'ended', id: data.id });
      });
    },
  });
  core = createCore({ settings, speech, dataDir: dir, fetch: fakeFetch, host: { show: () => shown++ } });
  core.start();
  const handle = createApi({
    speech,
    settings,
    version: 't',
    core,
    avatars: ['brunette', 'david', 'avaturn', 'avatarsdk'],
    face: { status: () => ({ visible: true, avatar: 'ready', tts: { state: 'ready' } }), show: () => shown++, hide() {}, toggle() {}, express: async () => {}, tts: async () => ({}) },
  });
  server = http.createServer(handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  core.stop();
  server.close();
});

const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => [r.status, await r.json()]);
const get = (p) => fetch(base + p).then(async (r) => [r.status, await r.json()]);
const idle = async () => {
  for (let i = 0; i < 400 && (core.assistant.busy || core.assistant.inbox.length); i++) await wait(5);
};

test('chat over the API, waiting for the answer; the character speaks it in its own voice', async () => {
  replies = ['Hello! 👋 Nice to meet you.'];
  const [status, r] = await post('/api/chat', { text: 'hi there', wait: true });
  assert.equal(status, 200);
  assert.equal(r.reply, 'Hello! 👋 Nice to meet you.');
  assert.equal(asked.at(-1).model, 'qwen3:8b', 'the best model Ollama has');
  assert.equal(spoken.at(-1).voice, 'af_heart');
  assert.equal(spoken.at(-1).director, 'rules', "its own words carry their cues: the model isn't asked again for expressions");
  assert.equal(spoken.at(-1).who, 'Ivy');
  const [, log] = await get('/api/chat?limit=5');
  assert.deepEqual(log.entries.map((e) => e.kind), ['user', 'assistant']);
  const [, a] = await get('/api/assistant');
  assert.equal(a.character.name, 'Ivy');
  assert.equal(a.tools.reachable, false);
  assert.match(a.tools.error, /isn't answering/);
});

test('picking a character picks its voice, and its name', async () => {
  const [, s] = await post('/api/settings', { avatar: 'avatarsdk' });
  assert.equal(s.voice, 'am_puck');
  replies = ["I'm Leo."];
  await post('/api/chat', { text: 'who are you?', wait: true });
  assert.match(asked.at(-1).messages[0].content, /^You are Leo/);
  assert.equal(spoken.at(-1).voice, 'am_puck');
  core.actions.setCharacter({ id: 'Sofia' });
  assert.equal(settings.get().voice, 'bf_emma');
  core.actions.setCharacter({ id: 'brunette' });
});

test('what it hears of its own voice is dropped; what the user says over it cuts in', async () => {
  replies = ['The quick brown fox jumps over the lazy dog, and that is a long story.'];
  core.assistant.say('tell me something');
  await idle();
  await wait(10);
  assert.ok(speech.speaking, 'still talking');
  const before = asked.length;
  assert.deepEqual(core.heard({ text: 'the quick brown fox jumps over' }), { dropped: 'echo' });
  assert.equal(asked.length, before);
  replies = ['Sure.'];
  const r = core.heard({ text: 'what time is it in Tokyo' });
  assert.equal(r.said, 'what time is it in Tokyo');
  assert.ok(!speech.speaking, 'cut in: it stopped talking');
  await idle();
  assert.match(asked.at(-1).messages.at(-1).content, /said\] what time is it in Tokyo$/);
});

test('"stop", "cancel" and "new chat" are done at once, without the model', async () => {
  const before = asked.length;
  assert.deepEqual(core.heard({ text: 'Stop.' }), { command: 'hush' });
  assert.deepEqual(core.heard({ text: 'never mind' }), { command: 'cancel' });
  assert.deepEqual(core.heard({ text: 'New chat!' }), { command: 'new_chat' });
  assert.equal(asked.length, before);
  assert.equal(core.assistant.history.length, 0);
  assert.equal(spoken.at(-1).text, 'Okay, a fresh start.');
  assert.deepEqual(core.heard({ text: 'um' }), { dropped: 'noise' });
});

test('a phrase that sounds unfinished waits for the rest', async () => {
  replies = ['Done.'];
  const before = asked.length;
  assert.deepEqual(core.heard({ text: 'add milk and' }), { held: true });
  await wait(50);
  assert.equal(asked.length, before);
  core.heard({ text: 'eggs to my shopping list' });
  await idle();
  assert.match(asked.at(-1).messages.at(-1).content, /said\] add milk and eggs to my shopping list$/);
});

test('the schedule over the API: set, listed, cancelled; one due shows the character and asks the model', async () => {
  let [status, t] = await post('/api/schedules', { in_minutes: 30, task: 'Check the oven.' });
  assert.equal(status, 201);
  assert.equal(t.id, 's1');
  [status] = await post('/api/schedules', { at: 'not a time', task: 'x' });
  assert.equal(status, 400);
  let [, list] = await get('/api/schedules');
  assert.equal(list.schedules[0].fromNow, 'in 30 minutes');
  [, t] = await post('/api/schedules/cancel', { id: 's1' });
  assert.deepEqual(t.cancelled, ['s1']);

  replies = ['Time to stretch! 🙆'];
  const shownBefore = shown;
  core.scheduler.add({ task: 'Remind the user to stretch.', due: Date.now() + 30 });
  for (let i = 0; i < 100 && !asked.at(-1)?.messages.at(-1).content.includes('Scheduled task'); i++) await wait(10);
  await idle();
  assert.match(asked.at(-1).messages.at(-1).content, /scheduled\] Scheduled task s2, set today at \d\d:\d\d: Remind the user to stretch\.$/);
  assert.ok(shown > shownBefore);
  [, list] = await get('/api/schedules');
  assert.equal(list.schedules.length, 0);
});

test('memory and the tool list over the API', async () => {
  let [, m] = await post('/api/memory', { remember: { section: 'user', note: 'Likes tea' }, instructions: 'Be brief.' });
  assert.deepEqual(m.notes.user, ['Likes tea']);
  assert.equal(m.instructions, 'Be brief.');
  [, m] = await post('/api/memory', { forget: { note: 'tea' } });
  assert.deepEqual(m.notes.user, []);
  const [, tools] = await get('/api/tools');
  assert.deepEqual(tools.builtin.map((t) => t.name), ['schedule', 'list_schedules', 'cancel_schedule', 'remember', 'forget']);
  assert.equal(tools.reachable, false);
  const [, h] = await get('/api/health');
  assert.equal(h.character, 'Ivy');
  assert.equal(h.assistant.busy, false);
});
