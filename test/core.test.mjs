// The pieces under the assistant: tool calls read out of an answer, the schedule and its times,
// memory, the prompt, the model client.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { calls, isSilent, looksBroken, maySayNothing, sayable, withoutAsides, words } from '../src/main/calls.mjs';
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
  assert.ok(isSilent('(nothing)') && isSilent('[silence].') && isSilent('nothing') && isSilent('Nothing.') && !isSilent('Nothing came back.'));
  assert.ok(isSilent('(looking puzzled) (nothing)') && isSilent('(shrugs)'), 'only asides: nothing to say');
  assert.ok(maySayNothing('') && maySayNothing('Noth') && !maySayNothing('No, it') && !maySayNothing('Sure'));
});

test('asides in brackets are never said: stage directions go, cues for the face, code and links stay', () => {
  assert.equal(withoutAsides('(looking puzzled) (nothing)').trim(), '');
  assert.equal(withoutAsides('(smiles) Sure, done. [looks around] Anything else?'), ' Sure, done.  Anything else?');
  assert.equal(withoutAsides('Done (well (mostly)) now.'), 'Done  now.', 'nested');
  assert.equal(withoutAsides('Great! [thumbup] [mood: happy]'), 'Great! [thumbup] [mood: happy]', 'cues the face plays stay for it');
  assert.equal(withoutAsides('Run `f(x)` or see [the docs](https://x.y/a).'), 'Run `f(x)` or see [the docs](https://x.y/a).');
  assert.equal(withoutAsides('```js\nf(1)\n``` (smiles)'), '```js\nf(1)\n``` ');
  // While it's written: what follows an aside that hasn't ended waits; once it ends, it's gone.
  assert.equal(sayable('Sure. (smi'), 'Sure. ');
  assert.equal(sayable('Sure. (smiles) It is'), 'Sure.  It is');
  assert.equal(sayable('Sure. (it is', { final: true }), 'Sure. (it is', 'at the end, a bracket never closed is just a bracket');
  assert.equal(sayable('Let me look. (checks) {"tool": "x"}'), 'Let me look.  ');
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

test('the prompt: the character, Tool Mac Tool Run\'s tools as it gives them, the scripts by name, what it has learned, the day', () => {
  const m = { prompt: () => "Your playbook:\n- Prefers Celsius\n\nThe user's standing instructions (follow them):\nCall me Sam." };
  const catalog = {
    reachable: true,
    error: null,
    tools: [
      { name: 'web_fetch', description: 'Reads any web address.', args: [{ name: 'url', type: 'string', required: true, about: 'the address' }, { name: 'find', type: 'string', required: false, about: 'words' }], asks: false, stream: false, aliases: ['fetch'] },
      { name: 'run_script', description: 'Runs a script.', args: [{ name: 'script', type: 'string', required: true, about: 'its name' }], asks: true, stream: true, aliases: [] },
      { name: 'teleport', description: 'A tool this app has never heard of.', args: [], asks: false, stream: false, aliases: [] },
    ],
    guide: ['Search the web before you say you can\'t.'],
    examples: [{ user: 'When does the Louvre open?', steps: [{ call: { tool: 'web_fetch', arguments: { url: 'https://louvre.fr' } }, result: '9 to 6' }], answer: 'From 9 to 6.' }],
    scripts: [{ name: 'utilities/weather.py', summary: 'The weather', inputs: [], dangers: [] }, { name: 'hello.sh', summary: 'Hi', inputs: [], dangers: [] }],
    flows: [{ name: 'morning.flow', summary: 'The day' }],
  };
  const p = systemPrompt({ character: CHARACTERS[2], catalog, notes: m, now: new Date(2026, 9, 24).getTime() });
  assert.match(p, /You are Sofia/);
  assert.doesNotMatch(p, /3D|character|avatar|gesture|your (?:face|hands|body)|\[tags?\]|dark suit/i, 'the model knows nothing of the character it is shown as: how it moves comes from its words, afterwards');
  assert.match(p, /^- web_fetch: Reads any web address\. Arguments: url \(string\): the address; find \(string, optional\): words\.$/m);
  assert.match(p, /^- run_script: Runs a script\. Arguments: script \(string\): its name\. \[waits for the user to click Run on the Mac\]$/m);
  assert.match(p, /^- teleport: A tool this app has never heard of\.$/m, 'what Tool Mac Tool Run adds is there the day it ships');
  assert.match(p, /^- schedule: /m);
  assert.match(p, /^Using Tool Mac Tool Run's tools \(its own advice\):\n- Search the web before you say you can't\.$/m);
  assert.match(p, /^The user says: When does the Louvre open\?\nYou answer: \{"tool": "web_fetch", "arguments": \{"url":"https:\/\/louvre\.fr"\}\}\nThe tool result: 9 to 6\nYou answer: From 9 to 6\.$/m);
  assert.match(p, /^utilities\/: weather$/m);
  assert.match(p, /^hello$/m);
  assert.match(p, /^Their flows, for run_flow: morning$/m);
  assert.match(p, /- Prefers Celsius/);
  assert.match(p, /Call me Sam\./);
  assert.match(p, /Today is Saturday 24 October 2026\.$/);
  assert.match(catalogPrompt({ reachable: false, error: 'not running' }), /isn't available right now \(not running\)/);
  assert.match(systemPrompt({ character: CHARACTERS[0], catalog: { reachable: false, error: 'not running', tools: [], scripts: [], flows: [] } }), /no tools but the schedule/);
  assert.match(stamp(new Date(2026, 9, 24, 9, 5, 7).getTime()), /Saturday 24 October 2026, 09:05:07 \(UTC[+-]\d\d:\d\d\)/);
});

test('a call goes where its tool is: the schedule here, everything else to Tool Mac Tool Run as called', () => {
  const catalog = { tools: [{ name: 'web_search', aliases: ['google'], args: [] }, { name: 'runs', aliases: ['cancel_run'], args: [] }] };
  assert.deepEqual(canonical({ name: 'remind_me', arguments: { in_minutes: 5 } }, catalog), { name: 'schedule', arguments: { in_minutes: 5 }, where: 'local' });
  assert.deepEqual(canonical({ name: 'Google', arguments: { q: 'x' } }, catalog), { name: 'web_search', arguments: { q: 'x' }, where: 'mac' });
  // A name it doesn't know (a script's, a tool added later) goes as it was called: Tool Mac Tool Run says what it is.
  assert.deepEqual(canonical({ name: 'weather', arguments: { args: ['Paris'] } }, catalog), { name: 'weather', arguments: { args: ['Paris'] }, where: 'mac' });
  assert.equal(canonical({ name: 'cancel_schedule', arguments: {} }, catalog).where, 'local');
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
