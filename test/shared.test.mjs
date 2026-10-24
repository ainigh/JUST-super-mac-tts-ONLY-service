import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expressionName, gestureName } from '../src/shared/catalog.mjs';
import { direct, directOn, merge, read, rules } from '../src/shared/director.mjs';
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

test('each kind of sentence shows what it is', () => {
  const show = (t) => rules(t);
  assert.equal(show('Hello there!').gesture, 'handup');
  assert.equal(show('Hello there!').look, 'camera');
  assert.equal(show('Goodbye, take care.').gesture, 'handup');
  assert.equal(show('Thank you so much.').gesture, 'namaste');
  assert.equal(show("I'm sorry about that.").mood, 'sad');
  assert.equal(show("I'm sorry to hear that.").kinds[0], 'empathy');
  assert.equal(show('Yes, absolutely.').head, 'yes');
  assert.equal(show('No, not at all.').head, 'no');
  assert.equal(show('No problem at all.').head, 'yes', '"no problem" is a kindness, not a no');
  assert.equal(show("I don't know.").gesture, 'shrug');
  assert.equal(show('One moment.').gesture, 'handup');
  assert.equal(show('Let me check.').look, 'away');
  assert.equal(show('Click Run on your Mac.').gesture, 'index');
  assert.equal(show('Would you like me to try again?').gesture, 'side');
  assert.equal(show('What time is it?').expression, 'thinking');
  assert.equal(show('Is that the one?').expression, 'smile');
  assert.equal(show("It's lovely, isn't it?").head, 'yes');
  assert.equal(show('Eggs are on your shopping list.').gesture, 'ok');
  assert.equal(show('Well done!').gesture, 'thumbup');
  assert.equal(show('Wow, that is amazing.').expression, 'starstruck');
  assert.equal(show('It failed with an error.').mood, 'sad');
  assert.equal(show('Careful: this deletes them for good.').gesture, 'index');
  assert.equal(show('Haha, that is funny.').expression, 'laughing');
  assert.equal(show('Right now it is raining.').head, undefined, '"right now" is not a yes');
  assert.deepEqual(show("It's 28 degrees in Lagos, with a high of 31."), { timed: [], kinds: [] }, 'facts are said calmly');
});

test('"not" turns a word round, and what is said later in a sentence is shown at that word', () => {
  assert.equal(rules("That's not great.").expression, 'disappointed');
  assert.notEqual(rules("That's not great.").gesture, 'thumbup');
  const d = rules('The script ran, but it failed with an error.');
  assert.equal(d.gesture, 'side');
  assert.equal(d.timed.length, 1);
  assert.ok(d.timed[0].at > 0.4 && d.timed[0].at < 0.7);
  assert.equal(d.timed[0].mood, 'sad');
  const turn = rules('It failed at first, but now it works.');
  assert.equal(turn.mood, 'sad');
  assert.equal(turn.timed[0].mood, 'happy', 'the "but" carries what follows it');
  assert.deepEqual(read('Hi! Thanks.').map((h) => h.kind), ['greeting', 'thanks']);
});

test('across an utterance: the mood holds until the feeling changes, and nothing repeats twice running', () => {
  const d = direct(['Thank you!', 'Thanks again.', 'The file has three lines.', 'It is in your folder.', 'That is all.']);
  assert.equal(d[0].mood, 'happy');
  assert.equal(d[1].mood, undefined, 'still happy: not set again');
  assert.equal(d[1].gesture, undefined, 'no namaste twice running');
  assert.equal(d[3].mood, 'neutral', 'two calm sentences later, back to rest');
  const steps = direct(['First, open the folder.', 'Then pick the file.', 'Finally, click Save.']);
  assert.deepEqual(steps.map((d) => d.gesture), ['index', 'side', 'index'], 'every step shows, and never the same twice running');
  assert.ok(direct(['One.', 'Two.', 'Three.', 'Four.'])[3].pose, 'a long answer changes stance');
  // Said a piece at a time (as an answer is, while it's written), it reads as one.
  const first = directOn(['Thank you!'], {});
  const next = directOn(['Thanks again.', 'The file has three lines.', 'It is in your folder.'], { from: first.state });
  assert.deepEqual([first.directions, next.directions].flat(), d.slice(0, 4));
  assert.deepEqual(direct(['Hi!']), direct(['Hi!']), 'the same words, the same show');
  assert.equal(direct(['Hello.'], { mood: 'happy' })[0].mood, undefined, 'already in that mood');
});

test('the small words move it at their word: who, where, when, how much, how sure, "not", "because"', () => {
  const kinds = (t) => rules(t).kinds;
  assert.equal(rules('We can do it together.').gesture === 'wide' || rules('We can do it together.').gesture === 'side', true);
  assert.equal(rules('Everything is in the box.').gesture, 'wide', '"everything": arms wide');
  assert.equal(rules('Just a tiny bit more.').gesture, 'ok', '"a tiny bit": a pinch');
  assert.equal(rules('Prices went down.').look, 'down');
  assert.equal(rules('Maybe it rains.').expression, 'thinking');
  assert.ok(['left', 'right'].includes(rules('They said it was fine.').turn), 'other people: it turns aside');
  assert.equal(rules('It happened two years ago.').timed.at(-1).turn, 'left', 'the past is to one side, at "ago"…');
  const later = rules('We can try it again tomorrow.');
  assert.equal(later.turn, undefined, 'it starts facing the user…');
  assert.equal(later.timed.at(-1).turn, 'right', '…and turns to what is to come at "tomorrow"');
  assert.equal(direct(['I checked it.', 'I checked it.', 'It is raining tomorrow.'])[2].timed.at(-1).turn, 'right', 'what is to come, to the other side');
  assert.equal(rules('It does not work.').head, 'no');
  assert.equal(rules('That is definitely it.').head, 'yes');
  const because = rules('The train is late, because the line is closed.');
  assert.deepEqual(because.timed.map((c) => c.gesture), ['index'], '"because" points, at its word');
  assert.ok(because.timed[0].at > 0.4);
  assert.equal(rules('Stop right there!').gesture, 'bothup');
  assert.ok(!kinds('They all stop in Paris.').includes('stop'), 'a stop on the way is not "stop!"');
  assert.ok(!kinds('I want to point at the front.').includes('not'), 'words that end in "nt" are not "not"');
});

test('it turns aside now and then while it talks, and faces the user for what is said to them', () => {
  const said = ['The file is open.', 'It has ten lines.', 'The last one is blank.', 'The first is a title.', 'Would you like me to fix it?'];
  const d = direct(said);
  const facing = [];
  let now = 'user';
  for (const x of d) facing.push((now = [...x.timed].reverse().find((c) => c.turn)?.turn ?? x.turn ?? now));
  assert.ok(facing.some((f) => f !== 'user'), `some of it aside (${facing})`);
  assert.ok(facing.filter((f) => f === 'user').length >= 3, `most of it to the user (${facing})`);
  assert.equal(facing.at(-1), 'user', 'a question is asked facing them');
  assert.deepEqual(direct(said), d, 'the same words, the same turns');
});

test('what was asked wins, then what is written in the text, then what the words show; each at its time', () => {
  const cues = [{ gesture: 'ok', at: 0.5 }];
  const auto = { mood: 'sad', expression: 'pensive', gesture: 'thumbup', head: 'yes', timed: [{ at: 0.7, expression: 'smile', gesture: 'side' }] };
  const d = merge({ asked: { mood: 'love' }, auto, cues });
  assert.deepEqual(d, { mood: 'love', expression: 'pensive', head: 'yes', timed: [{ gesture: 'ok', at: 0.5 }, { at: 0.7, expression: 'smile' }] });
  assert.deepEqual(merge({ auto: { head: 'yes', timed: [] } }), { head: 'yes', timed: [] });
  assert.deepEqual(merge({}), { timed: [] });
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
