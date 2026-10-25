import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { allowedOrigin, createApi, localHost } from '../src/main/api.mjs';
import { iconPixels } from '../src/main/icon.mjs';
import { Settings } from '../src/main/settings.mjs';
import { Speech } from '../src/main/speech.mjs';
import { newer } from '../src/main/updater.mjs';

// A face that says everything at once: each speak starts, says its text as one sentence, ends.
let sent = [];
let visible = false;
let ttsState = { state: 'ready' };
let avatar = 'ready';
let avatarMessage = '';
let speech;
let server;
let base;

before(async () => {
  speech = new Speech({
    send: (type, data) => {
      sent.push({ type, data });
      if (type === 'speak' && !data.text.includes('[slow]')) {
        setImmediate(() => {
          speech.event({ type: 'started', id: data.id });
          speech.event({ type: 'sentence', id: data.id, text: data.text, duration: 1 });
          speech.event({ type: 'ended', id: data.id });
        });
      }
    },
  });
  const settings = new Settings(path.join(os.tmpdir(), `superface-test-${process.pid}.json`));
  const handle = createApi({
    speech,
    settings,
    version: '0.1.0-test',
    docs: () => '# Super Face API\n127.0.0.1:8769',
    avatars: ['brunette', 'david'],
    readyWait: 600,
    face: {
      status: () => ({ visible, avatar, tts: ttsState, message: avatarMessage }),
      show: () => (visible = true),
      hide: () => (visible = false),
      toggle: () => (visible = !visible),
      express: async () => {},
      tts: async () => ({ pcm: Buffer.alloc(48000), sampleRate: 24000, words: ['Hi'], wtimes: [10], wdurations: [200] }),
    },
  });
  server = http.createServer(handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const post = (p, body, headers = {}) =>
  fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('health says what it is and how it is', async () => {
  const h = await (await fetch(`${base}/api/health`)).json();
  assert.equal(h.ok, true);
  assert.equal(h.service, 'superface');
  assert.equal(h.models.tts.state, 'ready');
});

test('speak queues, shows the avatar, and can wait until it has been said', async () => {
  visible = false;
  sent = [];
  const r = await post('/api/speak', { text: 'Hello there', voice: 'm1', mood: 'happy', gesture: 'wave', source: 'test' });
  assert.equal(r.status, 202);
  const j = await r.json();
  assert.ok(j.id);
  assert.equal(visible, true);
  const speak = sent.find((s) => s.type === 'speak');
  assert.equal(speak.data.voice, 'am_michael');
  assert.equal(speak.data.gesture, 'handup');
  assert.equal(speak.data.mood, 'happy');

  const w = await (await post('/api/speak', { text: 'Wait for me', wait: true, show: false })).json();
  assert.equal(w.ok, true);
  assert.equal(w.state, 'done');
  const s = await (await fetch(`${base}/api/speak/${w.id}`)).json();
  assert.equal(s.state, 'done');
});

test('plain text is spoken too', async () => {
  const r = await post('/api/speak', 'Just words', { 'Content-Type': 'text/plain' });
  assert.equal(r.status, 202);
});

test('bad requests say what is wrong', async () => {
  assert.equal((await (await post('/api/speak', {})).json()).code, 'missing_text');
  assert.equal((await (await post('/api/speak', { text: 'x', voice: 'alloy' })).json()).code, 'unknown_voice');
  assert.equal((await (await post('/api/speak', { text: 'x', speed: 5 })).json()).code, 'bad_speed');
  assert.equal((await (await post('/api/speak', { text: 'x', mood: 'ecstatic' })).json()).code, 'unknown_name');
  assert.equal((await (await post('/api/speak', '{bad json')).json()).code, 'bad_request');
  assert.equal((await fetch(`${base}/api/nope`)).status, 404);
  assert.equal((await fetch(`${base}/api/speak`)).status, 405);
});

test('a first download answers model_loading, so callers can fall back', async () => {
  ttsState = { state: 'downloading', progress: 0.4 };
  const r = await post('/api/speak', { text: 'Hi' });
  assert.equal(r.status, 503);
  assert.equal(r.headers.get('retry-after'), '5');
  const j = await r.json();
  assert.equal(j.code, 'model_loading');
  assert.equal(j.progress, 0.4);
  ttsState = { state: 'ready' };
});

test('stop drops what is queued, only the caller’s when it says whose', async () => {
  const a = await (await post('/api/speak', { text: '[slow] mine', source: 'a' })).json();
  const b = await (await post('/api/speak', { text: '[slow] theirs', source: 'b' })).json();
  const r = await (await post('/api/stop', { source: 'a' })).json();
  assert.equal(r.stopped, 1);
  assert.equal(speech.get(a.id).state, 'stopped');
  assert.equal(speech.get(b.id).state, 'queued');
  assert.equal((await (await post('/api/stop', '')).json()).stopped, 1);
});

test('what was said is logged, and the ears can ask whether they heard it', async () => {
  await (await post('/api/speak', { text: 'The meeting moved to three o clock tomorrow', wait: true })).json();
  const said = await (await fetch(`${base}/api/said?seconds=10`)).json();
  assert.ok(said.lines.some((l) => l.text.includes('meeting moved')));
  const echo = await (await post('/api/echo', { text: 'the meeting moved to three' })).json();
  assert.equal(echo.echo, true);
  const mine = await (await post('/api/echo', { text: 'can you book a taxi for me' })).json();
  assert.equal(mine.echo, false);
  assert.equal(mine.rest, 'can you book a taxi for me');
  assert.equal((await (await post('/api/echo', {})).json()).code, 'missing_text');
});

test('tts answers audio without speaking', async () => {
  const r = await post('/api/tts', { text: 'Hi', format: 'wav' });
  assert.equal(r.headers.get('content-type'), 'audio/wav');
  assert.equal(r.headers.get('x-duration'), '1');
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.subarray(0, 4).toString(), 'RIFF');
  assert.equal(buf.length, 44 + 48000);
  const j = await (await post('/api/tts', { text: 'Hi', format: 'json' })).json();
  assert.deepEqual(j.words, ['Hi']);
  assert.ok(j.audio.length > 100);
});

test('show, hide, toggle, express', async () => {
  assert.equal((await (await post('/api/hide', '')).json()).visible, false);
  assert.equal((await (await post('/api/toggle', '')).json()).visible, true);
  const e = await (await post('/api/express', { expression: '😉', gesture: 'thumbup' })).json();
  assert.equal(e.expression, 'wink');
  assert.equal((await (await post('/api/express', {})).json()).code, 'bad_request');
  assert.equal((await (await post('/api/express', { foo: 1 })).json()).code, 'bad_request');
});

test('settings can be read and changed, checked', async () => {
  const s = await (await post('/api/settings', { voice: 'f2' })).json();
  assert.equal(s.voice, 'af_bella');
  // The framing is always head to toes: it isn't a setting.
  assert.equal(s.view, undefined);
  assert.equal((await post('/api/settings', { view: 'mid' })).status, 400);
  assert.equal((await post('/api/settings', { port: 1 })).status, 400);
  assert.equal((await post('/api/settings', { avatar: 'nobody' })).status, 400);
  const v = await (await fetch(`${base}/api/voices`)).json();
  assert.equal(v.default, 'af_bella');
  const c = await (await fetch(`${base}/api/catalog`)).json();
  assert.ok(c.gestures.thumbup && c.moods.happy && c.expressions.wink);
});

test('what the face would show, read from the words: nothing said, no model asked', async () => {
  const r = await post('/api/expressions', { text: 'Hello! 👍 The run failed, sorry. Would you like me to try again?' });
  assert.equal(r.status, 200);
  const { sentences } = await r.json();
  assert.deepEqual(sentences.map((x) => x.text), ['Hello!', 'The run failed, sorry.', 'Would you like me to try again?']);
  assert.equal(sentences[0].gesture, undefined, 'the 👍 written in the text is the gesture, at its place');
  assert.equal(sentences[0].timed[0].gesture, 'thumbup');
  assert.equal(sentences[0].expression, 'grin');
  assert.equal(sentences[1].mood, 'sad');
  assert.equal(sentences[2].look, 'camera');
  assert.deepEqual(sentences[2].kinds, ['offer']);
  assert.equal((await post('/api/expressions', {})).status, 400);
  // "model" was a choice once: it's taken as the words now.
  assert.equal((await (await post('/api/settings', { expressions: 'model' })).json()).expressions, 'rules');
  assert.equal((await post('/api/settings', { expressions: 'loud' })).status, 400);
});

test('only this machine, and its pages, may call', async () => {
  assert.equal(localHost('127.0.0.1:8769'), true);
  assert.equal(localHost('evil.example.com'), false);
  assert.equal(allowedOrigin('http://localhost:3000'), true);
  assert.equal(allowedOrigin('https://evil.example.com'), false);
  assert.equal(allowedOrigin('https://app.example.com', ['https://*.example.com']), true);
  const r = await fetch(`${base}/api/health`, { headers: { Origin: 'https://evil.example.com' } });
  assert.equal(r.status, 403);
  const ok = await fetch(`${base}/api/health`, { headers: { Origin: 'http://127.0.0.1:5000' } });
  assert.equal(ok.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5000');
});

test('the docs and the status page are served', async () => {
  assert.match(await (await fetch(`${base}/api.md`)).text(), /Super Face API/);
  assert.match(await (await fetch(`${base}/`)).text(), /<title>Super Face<\/title>/);
});

test('updates compare versions part by part', () => {
  assert.equal(newer('v0.1.12', '0.1.9'), true);
  assert.equal(newer('0.1.9', '0.1.12'), false);
  assert.equal(newer('v0.1.3', '0.1.3'), false);
  assert.equal(newer('v0.2.0', '0.1.99'), true);
});

test('the menu bar icon is drawn', () => {
  const px = iconPixels(36, false);
  assert.equal(px.length, 36 * 36 * 4);
  assert.ok(px.some((b, i) => i % 4 === 3 && b > 200));
  assert.notDeepEqual(iconPixels(36, true), px);
});

test('an avatar that did not load says so, rather than taking what it can never say', async () => {
  avatar = 'failed';
  avatarMessage = 'GLTFLoader.js is missing';
  const r = await post('/api/speak', { text: 'Hi', wait: true });
  assert.equal(r.status, 503);
  const j = await r.json();
  assert.equal(j.code, 'avatar_failed');
  assert.match(j.error, /GLTFLoader/);
  const h = await (await fetch(`${base}/api/health`)).json();
  assert.equal(h.ready, false);
  assert.match(h.message, /GLTFLoader/);
  avatar = 'ready';
  avatarMessage = '';
});

test('while it starts, a speak waits for it; if it does not start, it says so', async () => {
  avatar = 'loading';
  const t0 = Date.now();
  const late = await post('/api/speak', { text: 'Hi' });
  assert.equal(late.status, 503);
  assert.equal((await late.json()).code, 'not_ready');
  assert.ok(Date.now() - t0 >= 500);
  setTimeout(() => (avatar = 'ready'), 200);
  const r = await post('/api/speak', { text: 'Hi' });
  assert.equal(r.status, 202);
  assert.equal((await (await fetch(`${base}/api/health`)).json()).ready, true);
});

test('an utterance the avatar goes quiet on fails, so nobody waits for ever', () => {
  let t = 0;
  const s = new Speech({ send: () => {}, now: () => t });
  const rec = s.enqueue({ text: 'Hello', voice: 'af_heart', speed: 1 });
  const done = s.wait(rec.id);
  t = 30_000;
  s.watch();
  assert.equal(s.get(rec.id).state, 'queued');
  t = 61_000;
  s.watch();
  assert.equal(s.get(rec.id).state, 'failed');
  return done.then((r) => assert.equal(r.state, 'failed'));
});

test('settings saved when expressions came from the model load as read from the words', () => {
  const file = path.join(os.tmpdir(), `superface-old-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ expressions: 'model', voice: 'am_puck' }));
  try {
    const s = new Settings(file).get();
    assert.equal(s.expressions, 'rules');
    assert.equal(s.voice, 'am_puck');
  } finally {
    fs.rmSync(file, { force: true });
  }
});
