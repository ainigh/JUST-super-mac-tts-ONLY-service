import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expressionName, gestureName } from '../src/shared/catalog.mjs';
import { merge, modelRequest, readAnswer, rules, schema } from '../src/shared/director.mjs';
import { around, compare } from '../src/shared/echo.mjs';
import { extractCues, parse, sentences, speakable, words } from '../src/shared/text.mjs';
import { resolveVoice } from '../src/shared/voices.mjs';

test('voices are named the way Super Voice names them', () => {
  assert.equal(resolveVoice('f1').id, 'af_heart');
  assert.equal(resolveVoice('m2').id, 'am_fenrir');
  assert.equal(resolveVoice('Bella').id, 'af_bella');
  assert.equal(resolveVoice('am_puck').id, 'am_puck');
  assert.equal(resolveVoice('uk').id, 'bf_emma');
  assert.equal(resolveVoice('male').id, 'am_michael');
  assert.equal(resolveVoice('', 'am_puck').id, 'am_puck');
  assert.equal(resolveVoice(null).id, 'af_heart');
  assert.equal(resolveVoice('alloy'), null);
});

test('markdown is made fit to read aloud', () => {
  assert.equal(speakable('**Bold** and _soft_, `code` and [a link](https://x.y).'), 'Bold and soft, code and a link.');
  assert.equal(speakable('# Title\n- one\n- two'), 'Title\none\ntwo');
  assert.equal(speakable('see https://example.com/page now'), 'see a link now');
});

test('sentences are cut at their ends, and long ones again', () => {
  assert.deepEqual(sentences('Hello there. How are you? Fine!'), ['Hello there.', 'How are you?', 'Fine!']);
  assert.deepEqual(sentences('One\nTwo'), ['One', 'Two']);
  assert.deepEqual(sentences('3.5 is a number. Yes.'), ['3.5 is a number.', 'Yes.']);
  const long = sentences(`${'word '.repeat(100)}end.`);
  assert.ok(long.length >= 2 && long.every((s) => s.length <= 300));
  assert.deepEqual(sentences('...'), []);
});

test('emojis and tags become cues where they were written, and are not read out', () => {
  const { text, cues } = extractCues('Great job 👍 really [happy] [not a tag]');
  assert.equal(text.replace(/\s+/g, ' ').trim(), 'Great job really [not a tag]');
  assert.deepEqual(cues.map(({ at: _a, emoji: _e, ...c }) => c), [{ gesture: 'thumbup' }, { mood: 'happy' }]);

  const p = parse('Hello! 👋 I have news. [mood:sad] Sorry. 😔');
  assert.deepEqual(p.sentences.map((s) => s.text), ['Hello!', 'I have news.', 'Sorry.']);
  assert.equal(p.sentences[0].cues[0].gesture, 'handup');
  assert.deepEqual(p.sentences[1].cues, []);
  assert.equal(p.sentences[0].cues[0].at, 0);
  assert.deepEqual(p.sentences[2].cues.map(({ at: _a, ...c }) => c), [{ mood: 'sad' }, { expression: 'pensive' }]);
  assert.equal(p.sentences[2].cues[1].at, 0);
  const mid = parse('Great job 👍 really.').sentences[0].cues[0];
  assert.ok(mid.at > 0.3 && mid.at < 0.8);
  for (const s of p.sentences) for (const c of s.cues) assert.ok(c.at >= 0 && c.at <= 1);

  const tags = parse('[gesture:shrug] Who knows. [nod] [pose:hip] [expression:wink]');
  assert.deepEqual(tags.sentences[0].cues.map(({ at: _a, ...c }) => c), [{ gesture: 'shrug' }, { head: 'yes' }, { pose: 'hip' }, { expression: 'wink' }]);
});

test('names and emojis resolve in the catalog', () => {
  assert.equal(expressionName('😀'), 'grin');
  assert.equal(expressionName('Thinking'), 'thinking');
  assert.equal(expressionName('dancing'), null);
  assert.equal(gestureName('wave'), 'handup');
  assert.equal(gestureName('🙏'), 'namaste');
});

test('the rules read the words', () => {
  assert.equal(rules('Hello there!').gesture, 'handup');
  assert.equal(rules('Thank you so much.').gesture, 'namaste');
  assert.equal(rules("I'm sorry to hear that.").mood, 'sad');
  assert.equal(rules('Yes, absolutely.').head, 'yes');
  assert.equal(rules("I don't know.").gesture, 'shrug');
  assert.equal(rules('What time is it?').expression, 'thinking');
  assert.deepEqual(rules('The file has three lines.'), {});
});

test('the model is asked once per utterance, and only catalog names come back', () => {
  const body = modelRequest(['Hi!', 'Bad news.'], { who: 'Tom' });
  assert.equal(body.format.properties.sentences.minItems, 2);
  assert.ok(body.messages[0].content.includes('thumbup'));
  assert.ok(body.messages[1].content.includes('1. Hi!'));
  assert.ok(schema(1).properties.sentences.items.properties.mood.enum.includes('none'));
  const a = readAnswer(JSON.stringify({ sentences: [{ mood: 'happy', expression: 'grin', gesture: 'none', head: 'nope' }] }), 2);
  assert.deepEqual(a, [{ mood: 'happy', expression: 'grin' }, {}]);
  assert.equal(readAnswer('not json', 1), null);
});

test('what was asked wins, then the model, then the rules; cues keep their own time', () => {
  const cues = [{ gesture: 'ok', at: 0.5 }];
  const d = merge({ asked: { mood: 'love' }, model: { mood: 'sad', expression: 'grin', gesture: 'thumbup' }, rule: { head: 'yes' }, cues });
  assert.deepEqual(d, { mood: 'love', expression: 'grin', timed: cues });
  assert.deepEqual(merge({ rule: { head: 'yes' } }), { head: 'yes', timed: [] });
  assert.deepEqual(merge({ model: {}, rule: { head: 'yes' } }), { timed: [] });
});

test('what the ears heard is told apart from what the mouth said', () => {
  const said = ['The weather today is sunny with a light breeze from the west.'];
  assert.equal(compare('the weather today is sunny', said).echo, true);
  assert.equal(compare('weather today is sonny with a light breeze', said).echo, true); // misheard
  assert.equal(compare('stop', said).echo, false);
  assert.equal(compare('wait what about tomorrow', said).echo, false);
  const mixed = compare('light breeze from the west can you book me a table for two', said);
  assert.equal(mixed.echo, false);
  assert.equal(mixed.rest, 'can you book me a table for two');
  assert.equal(compare('remind me to call Sam at four', said).echo, false);
  assert.equal(compare('anything', []).echo, false);
  assert.deepEqual(words("It's Tom’s"), ["it's", "tom's"]);

  const lines = [
    { text: 'old', start: 0, end: 1000 },
    { text: 'recent', start: 50_000, end: 55_000 },
  ];
  assert.deepEqual(around(lines, { at: 56_000, seconds: 5 }).map((l) => l.text), ['recent']);
});
