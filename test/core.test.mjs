// The pieces under the assistant: tool calls read out of an answer, the schedule and its times,
// memory, the prompt, the model client.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { calls, isSilent, looksBroken, sayable, words } from '../src/main/calls.mjs';
import { Memory } from '../src/main/memory.mjs';
import { Ollama, pick, stripThinking } from '../src/main/model.mjs';
import { canonical, catalogPrompt, claimsInability, promisesWork, stamp, systemPrompt } from '../src/main/prompt.mjs';
import { Scheduler, dueFrom, fromNow, longTime, parseAt, runTool } from '../src/main/scheduler.mjs';
import { CHARACTERS, nextSize } from '../src/shared/characters.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sf-'));

test('tool calls: bare, fenced, among words, arguments beside the name', () => {
  assert.deepEqual(calls('{"tool": "list_runs", "arguments": {"limit": 3}}').map((c) => [c.name, c.arguments]), [['list_runs', { limit: 3 }]]);
  const fenced = 'Checking.\n```json\n{"tool": "run_script", "arguments": {"script": "a.sh", "why": "x {y}"}}\n```';
  assert.equal(calls(fenced)[0].arguments.why, 'x {y}');
  assert.equal(words(fenced), 'Checking.');
  assert.deepEqual(calls('{"tool": "list_runs", "limit": 5}')[0].arguments, { limit: 5 });
  assert.deepEqual(calls('{"name": "schedule", "arguments": "{\\"in_minutes\\": 5}"}')[0].arguments, { in_minutes: 5 });
  assert.equal(calls('{"name": "Sam", "age": 3}').length, 0, 'a name in some data is not a call');
  assert.equal(calls('First {"tool":"a"} then {"tool":"b"}').length, 2);
});

test('what can be said of an answer while it is being written', () => {
  assert.equal(sayable('Let me look. {"tool": "run_scr'), 'Let me look. ');
  assert.equal(sayable('Here:\n```json\n{'), 'Here:\n');
  assert.equal(sayable('Plain words.'), 'Plain words.');
  assert.ok(looksBroken('{"tool": "run_script", "arguments": {"script": "a.sh"'));
  assert.ok(!looksBroken('All good.'));
  assert.ok(isSilent('(nothing)') && isSilent('[silence].') && !isSilent('Nothing came back.'));
});

test('the harness knows promises and "I can\'t"', () => {
  assert.ok(promisesWork("I'll check the weather for you."));
  assert.ok(promisesWork('Let me look that up.'));
  assert.ok(!promisesWork("It's 28 degrees in Lagos."));
  assert.ok(claimsInability("I don't have access to real-time weather data."));
  assert.ok(!claimsInability('It rained.'));
});

test('times: in minutes, at a time of day, a date, a weekday', () => {
  const now = new Date(2026, 9, 24, 15, 20, 0).getTime(); // a Saturday
  assert.equal(dueFrom({ in_minutes: 20 }, now), now + 20 * 60_000);
  assert.equal(dueFrom({ in_minutes: '1.5' }, now), now + 90_000);
  assert.equal(parseAt('17:30', now), new Date(2026, 9, 24, 17, 30).getTime());
  assert.equal(parseAt('9:00', now), new Date(2026, 9, 25, 9, 0).getTime(), 'passed today: tomorrow');
  assert.equal(parseAt('5:30 pm', now), new Date(2026, 9, 24, 17, 30).getTime());
  assert.equal(parseAt('2026-10-24 18:05', now), new Date(2026, 9, 24, 18, 5).getTime());
  assert.equal(parseAt('2026-10-24T18:05:30', now), new Date(2026, 9, 24, 18, 5, 30).getTime());
  assert.equal(parseAt('tomorrow 9am', now), new Date(2026, 9, 25, 9, 0).getTime());
  assert.equal(parseAt('monday 8:00', now), new Date(2026, 9, 26, 8, 0).getTime());
  assert.equal(parseAt('saturday 8:00', now), new Date(2026, 9, 31, 8, 0).getTime(), 'this Saturday 8:00 has passed: next week');
  assert.equal(parseAt('25 December 10:00', now), new Date(2026, 11, 25, 10, 0).getTime());
  assert.equal(parseAt('in 2 hours', now), now + 2 * 3_600_000);
  assert.equal(parseAt('2026-10-24T18:00:00Z', now), Date.UTC(2026, 9, 24, 18, 0));
  assert.ok(Number.isNaN(parseAt('whenever you like', now)));
  assert.ok(Number.isNaN(parseAt('31 February 10:00', now)));
  assert.equal(longTime(new Date(2026, 9, 24, 17, 30).getTime(), now), 'today at 17:30');
  assert.equal(longTime(new Date(2026, 9, 25, 9, 0).getTime(), now), 'tomorrow at 09:00');
  assert.equal(fromNow(now + 65 * 60_000, now), 'in 1 hour and 5 minutes');
});

test('the schedule: several at once, cancelled, kept, and done when due', async () => {
  const dir = tmp();
  const file = path.join(dir, 'schedule.json');
  const fired = [];
  let now = Date.now();
  const s = new Scheduler({ file, onFire: (t, late) => fired.push([t.id, late]), now: () => now });
  s.start();
  const a = s.add({ task: 'Remind the user to stretch.', due: now + 40 });
  const b = s.add({ task: 'Check the build.', due: now + 60_000 });
  s.add({ task: 'Water the plants.', due: now + 120_000 });
  assert.deepEqual([a.id, b.id], ['s1', 's2']);
  assert.match(runTool(s, 'list_schedules', {}, now), /s1: today at .*stretch/);
  assert.match(runTool(s, 'cancel_schedule', { id: 's2' }, now), /Cancelled s2/);
  assert.match(runTool(s, 'cancel_schedule', { id: 's9' }, now), /Nothing scheduled has the id s9/);
  assert.match(runTool(s, 'schedule', { at: 'whenever', task: 'x' }, now), /couldn't read when/);
  assert.match(runTool(s, 'schedule', { in_minutes: 5 }, now), /what to do/);
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(fired, [['s1', false]]);
  assert.deepEqual(s.list().map((t) => t.id), ['s3']);
  s.stop();

  // Kept across a restart; one that came due while closed is done, late.
  const again = [];
  now += 10 * 60_000;
  const s2 = new Scheduler({ file, onFire: (t, late) => again.push([t.id, late]), now: () => now });
  s2.start();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(again, [['s3', true]]);
  assert.equal(s2.add({ task: 'Next.', due: now + 1e6 }).id, 's4', 'ids carry on');
  assert.equal(runTool(s2, 'cancel_schedule', { id: 'all' }, now), 'Cancelled s4 (Next.).');
  s2.stop();
});

test('memory: sections, no repeats, a cap, forgetting by words', () => {
  const file = path.join(tmp(), 'memory.json');
  const m = new Memory({ file });
  assert.match(m.remember('user', 'Lives in Leeds'), /Noted in user/);
  assert.match(m.remember('preferences', 'lives in leeds'), /Already noted/);
  assert.match(m.remember('playbook', 'weather.py takes a city'), /Noted in playbook/);
  assert.match(m.remember('nowhere', 'x'), /No section/);
  assert.match(new Memory({ file }).prompt(), /- Lives in Leeds/);
  assert.equal(m.forget(null, 'leeds'), 'Forgotten.');
  for (let i = 0; i < 59; i++) m.remember('mistakes', `note ${i}`);
  assert.match(m.remember('user', 'one too many'), /full/);
});

test('the prompt: the character, the scripts with what they take, memory, the day', () => {
  const m = new Memory();
  m.remember('user', 'Prefers Celsius');
  m.setInstructions('Call me Sam.');
  const catalog = {
    reachable: true,
    error: null,
    scripts: [{ name: 'utilities/weather.py', summary: 'The weather', inputs: [{ prompt: 'City', kind: 'argument', optional: true }], dangers: [] }, { name: 'utilities/library.py', summary: 'Notes', inputs: [], dangers: [] }],
    flows: [{ name: 'morning.flow', summary: 'The day' }],
  };
  const p = systemPrompt({ character: CHARACTERS[2], catalog, memory: m, now: new Date(2026, 9, 24).getTime() });
  assert.match(p, /You are Sofia/);
  assert.match(p, /utilities\/weather\.py: The weather \| takes: City \(optional\)/);
  assert.match(p, /utilities\/library\.py is the user's notes library/);
  assert.match(p, /- Prefers Celsius/);
  assert.match(p, /Call me Sam\./);
  assert.match(p, /Today is Saturday 24 October 2026\.$/);
  assert.match(catalogPrompt({ reachable: false, error: 'not running' }), /isn't available right now \(not running\)/);
  assert.match(stamp(new Date(2026, 9, 24, 9, 5, 7).getTime()), /Saturday 24 October 2026, 09:05:07 \(UTC[+-]\d\d:\d\d\)/);
});

test('a tool named loosely, or by a script\'s own name, is the tool meant', () => {
  const catalog = { scripts: [{ name: 'utilities/weather.py' }], flows: [{ name: 'morning.flow' }] };
  assert.equal(canonical({ name: 'remind_me', arguments: {} }).name, 'schedule');
  assert.deepEqual(canonical({ name: 'weather', arguments: { args: ['Paris'] } }, catalog), {
    name: 'run_script',
    arguments: { script: 'utilities/weather.py', args: ['Paris'], stdin: undefined, why: undefined },
  });
  assert.equal(canonical({ name: 'morning', arguments: {} }, catalog).name, 'run_flow');
  assert.ok(canonical({ name: 'fly_to_mars', arguments: {} }, catalog).unknown);
});

test('sizes go round', () => {
  assert.equal(nextSize('Medium'), 'Large');
  assert.equal(nextSize('Huge'), 'Small');
  assert.equal(nextSize('Small', -1), 'Huge');
});

test('the model: the best one Ollama has, thinking left out, streamed, asked again without "think"', async () => {
  assert.equal(pick(['nomic-embed-text', 'llama3.2:3b', 'qwen3:8b']), 'qwen3:8b');
  assert.equal(pick(['tinyllama']), 'tinyllama');
  assert.equal(stripThinking('<think>hmm</think> Hi.'), 'Hi.');
  assert.equal(stripThinking('<think>still going', true), '');

  const bodies = [];
  const fakeFetch = async (url, init) => {
    if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'gemma3:4b' }] }));
    const body = JSON.parse(init.body);
    bodies.push(body);
    if ('think' in body) return new Response(JSON.stringify({ error: 'model does not support thinking' }), { status: 400 });
    const lines = ['Hel', 'lo there.', ' Bye.'].map((c) => JSON.stringify({ message: { content: c }, done: false }) + '\n');
    return new Response(new Blob(lines).stream());
  };
  const o = new Ollama({ current: () => ({ url: 'http://x', model: '' }), fetch: fakeFetch });
  const seen = [];
  const text = await o.chat([{ role: 'user', content: 'hi' }], { onText: (t) => seen.push(t) });
  assert.equal(text, 'Hello there. Bye.');
  assert.deepEqual(seen, ['Hel', 'Hello there.', 'Hello there. Bye.']);
  assert.equal(bodies[0].model, 'gemma3:4b');
  assert.equal(bodies[0].options.num_ctx, 16384);
  assert.ok(!('think' in bodies[1]));
  const down = new Ollama({ current: () => ({ url: 'http://x', model: 'm' }), fetch: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(down.chat([]), (e) => e.code === 'unreachable');
});
