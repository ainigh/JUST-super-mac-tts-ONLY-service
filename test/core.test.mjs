// The pieces under the assistant: messages to Peter and the Clock read out of an answer, the
// schedule (the Clock) and its times, memory, the prompt, the model client.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isSilent, looksLikeCall, maySayNothing, messages, sayable, withoutAsides, words } from '../src/main/calls.mjs';
import { Ollama, pick, stripThinking } from '../src/main/model.mjs';
import { claimsInability, promisesWork, stamp, systemPrompt } from '../src/main/prompt.mjs';
import { Scheduler, clockSay, dueFrom, fromNow, longTime, parseAt } from '../src/main/scheduler.mjs';
import { CHARACTERS, nextSize } from '../src/shared/characters.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sf-'));

test('messages: to Peter or the Clock, after words or alone, fenced, a template of lines, one after another', () => {
  const at = (t) => messages(t).map((m) => [m.to, m.text]);
  assert.deepEqual(at('Let me check. @peter search the web for Walmart hours'), [['peter', 'search the web for Walmart hours']]);
  assert.equal(words('Let me check. @peter search the web for Walmart hours'), 'Let me check.');
  const labeled = 'Got it.\n```\n@peter\nAdd to a note\n- name: Super Face instructions\n- text: - say yes or no\n```';
  assert.deepEqual(at(labeled), [['peter', 'Add to a note\n- name: Super Face instructions\n- text: - say yes or no']]);
  assert.equal(words(labeled), 'Got it.', 'the fence goes with the message');
  assert.deepEqual(at('@peter read the page at https://x.y\n@clock\n- in minutes: 5\n- task: check'), [['peter', 'read the page at https://x.y'], ['clock', '- in minutes: 5\n- task: check']]);
  assert.deepEqual(at('Sure! @Peter_the_worker: open https://a.b in Chrome'), [['peter', 'open https://a.b in Chrome']], 'his name as a model writes it');
  assert.equal(messages('Mail it to sam@peter.com.').length, 0, 'an address is not a message');
  assert.deepEqual(at('Ask @peter later about it'), [['peter', 'later about it']], 'the first one starts a message anywhere');
  assert.deepEqual(at('@peter search for "Ask @peter" quotes'), [['peter', 'search for "Ask @peter" quotes']], 'another starts one only at the start of a line');
  assert.ok(looksLikeCall('{"tool": "web_search", "arguments": {"q": "x"}}') && !looksLikeCall('All good.') && !looksLikeCall('@peter {"tool": 1}'));
});

test('what can be said of an answer while it is being written', () => {
  assert.equal(sayable('Let me look. @pe'), 'Let me look.', 'what may be the start of a message waits');
  assert.equal(sayable('Let me look. @peter search the web for x'), 'Let me look.');
  assert.equal(sayable('Here:\n```\n@pet'), 'Here:\n');
  assert.equal(sayable('Plain words.'), 'Plain words.');
  assert.equal(sayable('Let me look. {"tool": "web_search"'), 'Let me look. ', 'JSON out of habit is never said');
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
  assert.equal(sayable('Let me look. (checks) @peter read x'), 'Let me look. ');
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
  assert.match(clockSay(s, "what's scheduled", now), /s1: today at .*stretch/);
  assert.match(clockSay(s, 'cancel s2', now), /Cancelled s2/);
  assert.match(clockSay(s, 'cancel s9', now), /Nothing scheduled has the id s9/);
  assert.match(clockSay(s, '- at: whenever\n- task: x', now), /couldn't read when/);
  assert.match(clockSay(s, '- in minutes: 5', now), /Say what to do then/);
  assert.match(clockSay(s, 'hello there', now), /didn't understand that\. The Clock takes:\n\nSet something for later\n- in minutes:/);
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
  assert.equal(clockSay(s2, 'cancel all', now), 'Cancelled s4 (Next.).');
  s2.stop();
});

test('the Clock is asked in words: lines, or a line; in minutes or at a time', () => {
  const now = new Date(2026, 9, 25, 21, 40).getTime();
  const s = new Scheduler({ onFire: () => {}, now: () => now });
  assert.equal(clockSay(s, '- in minutes: 20\n- task: Remind the user to call Sam.', now), 'Scheduled s1 for today at 22:00 (in 20 minutes): Remind the user to call Sam.');
  assert.match(clockSay(s, 'Set something for later\n- at: friday 8:00\n- task: Check the build.', now), /^Scheduled s2 for Friday 30 October at 08:00/);
  assert.match(clockSay(s, '- In Minutes: 2 hours\n- Task: Water the plants.', now), /^Scheduled s3 for today at 23:40/);
  assert.match(clockSay(s, 'in 5 minutes: stretch', now), /^Scheduled s4 for today at 21:45 \(in 5 minutes\): stretch$/);
  assert.match(clockSay(s, 'at 17:30: call the bank', now), /^Scheduled s5 for tomorrow at 17:30/);
  assert.equal(clockSay(s, 'list', now).split('\n').length, 5);
  assert.equal(clockSay(s, 'cancel s1 and s3', now), 'Cancelled s1 (Remind the user to call Sam.), s3 (Water the plants.).');
  s.stop();
});

test('the prompt: the character, how to ask Peter and the Clock, his templates that fit, what it has learned, the day', () => {
  const m = { prompt: () => "Your playbook:\n- Prefers Celsius\n\nThe user's standing instructions (follow them):\nCall me Sam." };
  const catalog = {
    reachable: true,
    error: null,
    tools: [{ name: 'library' }, { name: 'remember' }, { name: 'recall' }, { name: 'web_fetch', description: 'Reads any web address.', args: [{ name: 'url' }] }],
    scripts: [{ name: 'utilities/weather.py', summary: 'The weather', inputs: [], dangers: [] }],
    flows: [],
  };
  const forms = ['search the web for {what to look for}', 'Find words on a web page\n- address: {a web address}\n- words: {what to look for on it}'];
  const p = systemPrompt({ character: CHARACTERS[2], catalog, notes: m, forms, now: new Date(2026, 9, 24).getTime() });
  assert.match(p, /You are Sofia/);
  assert.doesNotMatch(p, /3D|character|avatar|gesture|your (?:face|hands|body)|\[tags?\]|dark suit/i, 'the model knows nothing of the character it is shown as: how it moves comes from its words, afterwards');
  assert.match(p, /To ask him, end your answer with a line that starts with @peter, then what you want, in plain words\./);
  assert.match(p, /end your answer with @clock and one of these:\n  Set something for later\n  - in minutes:/);
  assert.doesNotMatch(p, /web_fetch|run_script|"tool"|Arguments:|JSON/, 'no tool names, arguments or JSON: only words');
  assert.match(p, /Peter's templates that fit what was just said \(fill one in, or ask him in your own words\):\nsearch the web for \{what to look for\}\n\nFind words on a web page\n- address: \{a web address\}/);
  assert.match(p, /ask Peter to add it to the note "Super Face instructions"/, 'standing instructions: where they go');
  assert.match(p, /- Prefers Celsius/);
  assert.match(p, /Call me Sam\./);
  assert.match(p, /Today is Saturday 24 October 2026\.$/);
  assert.match(systemPrompt({ character: CHARACTERS[0], catalog: { reachable: false, error: 'not running', tools: [], scripts: [], flows: [] } }), /Peter isn't available right now \(not running\)/);
  assert.match(stamp(new Date(2026, 9, 24, 9, 5, 7).getTime()), /Saturday 24 October 2026, 09:05:07 \(UTC[+-]\d\d:\d\d\)/);
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
