// The pieces under the assistant: who an answer is to (@user, said aloud; @peter, a message to
// Peter), what's said of it as it's written, the prompt, the model client.
import assert from 'node:assert/strict';
import test from 'node:test';
import { addressed, isSilent, looksLikeCall, maySayNothing, messages, parts, sayable, withoutAsides, words } from '../src/main/calls.mjs';
import { Ollama, pick, stripThinking } from '../src/main/model.mjs';
import { claimsInability, handleOf, peterMessage, promisesWork, stamp, systemPrompt, userMessage } from '../src/main/prompt.mjs';
import { CHARACTERS, nextSize } from '../src/shared/characters.mjs';

test('who an answer is to: @user (said), @peter (to Peter), both, fenced, a template of lines; unaddressed words are the user\'s', () => {
  const at = (t) => messages(t).map((m) => [m.to, m.text]);
  assert.deepEqual(at('@user Let me check.\n@peter search the web for Walmart hours'), [['peter', 'search the web for Walmart hours']]);
  assert.equal(words('@user Let me check.\n@peter search the web for Walmart hours'), 'Let me check.');
  assert.equal(words('Let me check. @peter search the web for Walmart hours'), 'Let me check.', 'words before any handle are the user\'s');
  assert.ok(addressed('@user hi') && addressed('@peter x') && !addressed('Hi there.'));
  const labeled = '@user Got it.\n```\n@peter\nAdd to a note\n- name: Super Face instructions\n- text: - say yes or no\n```';
  assert.deepEqual(at(labeled), [['peter', 'Add to a note\n- name: Super Face instructions\n- text: - say yes or no']]);
  assert.equal(words(labeled), 'Got it.', 'the fence goes with the message');
  assert.deepEqual(parts('@peter read the page at https://x.y\n@user Reading it now.').map((p) => p.to), ['peter', 'user']);
  assert.equal(words('@peter read the page at https://x.y\n@user Reading it now.'), 'Reading it now.');
  assert.deepEqual(at('Sure! @Peter: open https://a.b in Chrome'), [['peter', 'open https://a.b in Chrome']], 'his name as a model writes it');
  assert.equal(messages('Mail it to sam@peter.com.').length, 0, 'an address is not a message');
  assert.deepEqual(at('@peter search for "Ask @peter" quotes'), [['peter', 'search for "Ask @peter" quotes']], 'another starts one only at the start of a line');
  assert.ok(looksLikeCall('{"tool": "web_search", "arguments": {"q": "x"}}') && !looksLikeCall('All good.') && !looksLikeCall('@peter {"tool": 1}'));
});

test('what can be said of an answer while it is being written', () => {
  assert.equal(sayable('@user Let me look. @pe'), 'Let me look.', 'what may be the start of a message waits');
  assert.equal(sayable('@user Let me look.\n@peter search the web for x'), 'Let me look.');
  assert.equal(sayable('@peter search the web for x'), '', 'a message to Peter is never said');
  assert.equal(sayable('@peter search the web for x\n@user Looking'), 'Looking');
  assert.equal(sayable('Here:\n```\n@pet'), 'Here:');
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

test('the prompt: a helpful assistant in a chat of three, an example, a short explanation, what it has learned, the day', () => {
  const m = { prompt: () => "The user's standing instructions (follow them):\nCall me Sam.\n\nWhat you've learned about getting things done for the user:\n- Prefers Celsius" };
  const p = systemPrompt({ character: CHARACTERS[2], model: 'qwen3:8b', peter: { reachable: true }, notes: m, now: new Date(2026, 9, 24).getTime() });
  assert.match(p, /^You are Sofia, a helpful assistant/);
  assert.match(p, /In this chat you are @qwen3\./);
  assert.doesNotMatch(p, /3D|character|avatar|gesture|your (?:face|hands|body)|\[tags?\]|dark suit/i, 'the model knows nothing of the character it is shown as: how it moves comes from its words, afterwards');
  assert.match(p, /For example:\n\[the user\] @qwen3 /, 'an example first');
  assert.match(p, /Start every answer with @user \(said aloud/);
  assert.match(p, /@peter \(a message to Peter\)/);
  assert.match(p, /how would I ask you to …\?/, 'how to find out what Peter can do');
  assert.match(p, /ask Peter to add it, word for word, to Super Face's instructions/, 'what it learns is kept by Peter');
  assert.doesNotMatch(p, /@clock|web_fetch|run_script|"tool"|Arguments:|JSON|template|\{[a-z ]+\}|Taken as/, 'no tools, templates or formats: only plain words');
  assert.doesNotMatch(p, /concierge|JARVIS|the face|the engine|the critic/i, 'no persona');
  assert.ok(p.length < 3000, `short: ${p.length} characters`);
  assert.match(p, /- Prefers Celsius/);
  assert.match(p, /Call me Sam\./);
  assert.match(p, /Today is Saturday 24 October 2026\.$/);
  assert.doesNotMatch(p, /Peter isn't answering/);
  assert.match(systemPrompt({ character: CHARACTERS[0], peter: { reachable: false, error: 'not running' } }), /Peter isn't answering right now \(not running\)/);
  assert.match(stamp(new Date(2026, 9, 24, 9, 5, 7).getTime()), /Saturday 24 October 2026, 09:05:07 \(UTC[+-]\d\d:\d\d\)/);
  assert.equal(handleOf('qwen3:8b'), 'qwen3');
  assert.equal(handleOf('library/llama3.2:3b'), 'llama3.2');
  assert.equal(handleOf(''), 'model');
  const at = new Date(2026, 9, 24, 9, 5, 7).getTime();
  assert.match(userMessage('hi', { at, how: 'said', model: 'qwen3:8b' }), /^\[the user, said aloud, Saturday 24 October 2026, 09:05:07 \(UTC[^)]*\)\] @qwen3 hi$/);
  assert.match(peterMessage('Done.', { at, model: 'qwen3:8b' }), /^\[Peter, Saturday [^\]]*\] @qwen3 Done\.$/);
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
