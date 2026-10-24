// What the character does while it talks, worked out from the sentences themselves (no model, no
// waiting, the same every time for the same words). Each sentence is read for what kind of thing
// it is (hello, thanks, sorry, good or bad news, a question to the user, an offer, an instruction,
// not knowing, thinking it over, a warning, a joke, a yes, a no, the next point, a "but"…), where
// in it each kind is said, and what came before it in the same utterance. That gives it a mood
// (kept until the feeling changes), an expression, a hand gesture, a head movement, where to look
// and, in a long answer, a pose; what's said later in a sentence ("…, but it failed") is shown at
// that word. It's kept varied (the same gesture twice running is dropped) and quiet when the
// sentence is just facts. The small words carry it the rest of the way: who is meant ("you", "we",
// "they"), where and when ("here", "up", "later", "ago"), how much and how sure ("all", "a bit",
// "maybe", "definitely"), "not", "because", "if"… each moves the hands, the head or the body a
// little at its word. And it doesn't stand square-on the whole time: it faces the user for what's
// said to them, and turns aside for thinking aloud, for other people, for what's past or to come,
// and now and then anyway. The model writing the words knows nothing of any of this.

import { STANDING_POSES } from './catalog.mjs';

// ---------------------------------------------------------------- the kinds of sentence

// Said at the start of a sentence, after a little "oh," or "well,".
const START = String.raw`^(?:(?:oh|ah|well|so|um|uh|and|now)[,!]?\s+)?`;
const any = (src) => new RegExp(String.raw`\b(?:${src})\b`, 'g');
const start = (src) => new RegExp(`${START}(?:${src})\\b`, 'g');

/**
 * Each kind: where it's found (`re`), how much it matters (`strength`: 3 always shows, 1 only when
 * the sentence before showed no gesture), and what it shows. A list is choices, picked by the
 * words (so the same words always look the same) and so as not to repeat the sentence before.
 * `valence`: +1 a good thing, -1 a bad one (said with "not" before it, it turns round).
 * Checked in order: once a stretch of words is one kind, no later kind reads it again.
 */
const KINDS = [
  // ---- hello, goodbye, thanks, sorry
  { kind: 'farewell', re: any(String.raw`good ?bye|bye(?: for now)?|see you(?: soon| later| tomorrow)?|take care|talk (?:to you )?(?:soon|later)|farewell|good night|have a (?:good|great|nice|lovely) (?:day|night|evening|weekend|one)|catch you later`), strength: 3, mood: 'happy', expression: ['warm', 'smile'], gesture: 'handup', look: 'camera' },
  { kind: 'greeting', re: start(String.raw`hi|hello|hey|hiya|howdy|greetings|good (?:morning|afternoon|evening|day)|welcome(?: back)?|nice to (?:meet|see) you`), strength: 3, mood: 'happy', expression: ['grin', 'beaming'], gesture: 'handup', look: 'camera' },
  { kind: 'welcome', re: any(String.raw`you'?re (?:very |most )?welcome|no problem(?: at all)?|not a problem|any ?time|my pleasure|happy to help|glad (?:i could|to) help|don'?t mention it`), strength: 2, mood: 'happy', expression: ['warm', 'smile'], head: 'yes', look: 'camera' },
  { kind: 'thanks', re: any(String.raw`thank(?:s| you)|many thanks|cheers|grateful|appreciate(?:d)?`), strength: 3, mood: 'happy', expression: ['warm', 'smile'], gesture: 'namaste', look: 'camera', valence: 1 },
  { kind: 'empathy', re: any(String.raw`(?:i'?m |i am )?(?:so |really |very )?sorry to hear|that (?:sounds|must be|must have been) (?:hard|tough|rough|awful|difficult|stressful|frustrating|painful|scary)|i (?:completely |totally )?(?:understand|hear you|get it)(?=,| how| that|\.|!|$)|poor (?:you|thing)|that'?s (?:hard|tough|rough)`), strength: 3, mood: 'sad', expression: ['pensive', 'pleading'], head: 'yes' },
  { kind: 'apology', re: any(String.raw`sorry|apologi[sz]e|apologies|my (?:bad|mistake|fault)|forgive me|i was wrong`), strength: 3, mood: 'sad', expression: ['pensive', 'embarrassed'], valence: -1 },
  { kind: 'please', re: start(String.raw`please|(?:could|would) you (?:please|kindly)|if you (?:could|would|don'?t mind)`), strength: 2, expression: 'smile', gesture: 'namaste', look: 'camera' },

  // ---- reassurance, before "worry" reads as fear
  { kind: 'reassure', re: any(String.raw`don'?t (?:you )?worry|no worries|nothing to worry about|it'?s (?:all )?(?:fine|okay|ok|alright)|it'?ll be (?:fine|okay|ok|alright)|you'?re (?:fine|okay|ok|all set)|all good|not a big deal|no harm done`), strength: 2, mood: 'happy', expression: ['warm', 'smile'], gesture: 'ok', head: 'yes' },

  // ---- good news, praise, joy
  { kind: 'praise', re: any(String.raw`well done|nice (?:work|job|one|going)|good (?:job|work|call|idea|choice|question)|great (?:job|work|idea|question|choice)|congrat\w*|bravo|nailed it|you did it|impressive|proud of you`), strength: 3, mood: 'happy', expression: ['beaming', 'delighted'], gesture: 'thumbup', valence: 1 },
  { kind: 'success', re: any(String.raw`(?:it'?s |that'?s |all |now )?(?:done|finished|complete|sorted|fixed)(?: now)?|all set|it(?: now)? works|it worked|that worked|(?:it'?s |now )?working(?: now| again)?|(?:it |that )?went (?:well|fine|through)|success(?:ful(?:ly)?)?|i'?ve (?:added|saved|set|sent|scheduled|booked|created|found|fixed|moved|written|updated|made|put|started|finished|turned)|(?:is|are|was|were) (?:now )?(?:saved|sent|added|ready|on (?:your|the) (?:\w+ )?list|booked|scheduled|set up)|here (?:it is|you go|you are)|found (?:it|them|one)`), strength: 2, mood: 'happy', expression: ['smile', 'grin'], gesture: 'ok', valence: 1 },
  { kind: 'awe', re: any(String.raw`wow|whoa|amazing|incredible|awesome|fantastic|unbelievable|stunning|spectacular|mind[- ]blowing|extraordinary`), strength: 3, mood: 'happy', expression: 'starstruck', valence: 1 },
  { kind: 'great', re: any(String.raw`great|excellent|perfect|brilliant|wonderful|superb|terrific|splendid|good news`), strength: 2, mood: 'happy', expression: ['beaming', 'grin'], gesture: 'thumbup', valence: 1 },
  { kind: 'joy', re: any(String.raw`glad|happy|pleased|delighted|excited|thrilled|yay|hooray|woo-?hoo|can'?t wait|looking forward|i love (?:it|that|this)|so much fun|fun`), strength: 2, mood: 'happy', expression: ['delighted', 'grin'], valence: 1 },
  { kind: 'love', re: any(String.raw`love|adore|sweet(?:heart)?|lovely|dear|darling|cute|adorable|miss(?:ed)? you|hugs?|kind of you`), strength: 2, mood: 'love', expression: ['adoring', 'warm'], valence: 1 },
  { kind: 'funny', re: any(String.raw`ha(?: ?ha)+|lol|lmao|funny|hilarious|that'?s a good one`), strength: 3, mood: 'happy', expression: 'laughing', valence: 1 },
  { kind: 'tease', re: any(String.raw`(?:just )?(?:kidding|joking|teasing)|cheeky|gotcha`), strength: 3, mood: 'happy', expression: ['playful', 'wink'] },
  { kind: 'secret', re: any(String.raw`wink|between (?:you and me|us)|our (?:little )?secret|don'?t tell (?:anyone|a soul)|just saying`), strength: 3, expression: ['wink', 'smirk'] },

  // ---- bad news, failure, warnings, feelings that hurt
  { kind: 'disaster', re: any(String.raw`oh no|disaster|terrible|awful|horrible|dreadful|catastroph\w*`), strength: 3, mood: 'sad', expression: ['shocked', 'disappointed'], valence: -1 },
  { kind: 'failure', re: any(String.raw`(?:didn'?t|doesn'?t|won'?t|isn'?t) (?:work|working|run|start|load|go through|answer)|not working|failed|fails?|failure|an? (?:error|problem|issue)|errors?|broken|crash(?:ed|es)?|went wrong|something'?s wrong|couldn'?t|can'?t (?:find|reach|open|connect|get|see|do)|no luck|unfortunately|sadly|bad news|i'?m afraid|denied|refused|missing|lost|timed out|didn'?t click`), strength: 2, mood: 'sad', expression: ['disappointed', 'pensive'], valence: -1 },
  { kind: 'warning', re: any(String.raw`careful|be aware|heads up|watch out|look out|warning|beware|danger(?:ous)?|risk(?:y)?|can'?t be undone|for good|permanently|irreversible|make sure|double[- ]check|don'?t forget`), strength: 2, expression: ['grimace', 'thinking'], gesture: 'index', look: 'camera' },
  { kind: 'fear', re: any(String.raw`scary|scared|afraid of|frighten\w*|terrif\w*|nervous|anxious|worried|worrying|panic\w*|yikes`), strength: 3, mood: 'fear', expression: ['grimace', 'shocked'] },
  { kind: 'anger', re: any(String.raw`angry|furious|annoy\w*|outrage\w*|unacceptable|ridiculous|infuriat\w*|hate|fed up|how dare`), strength: 3, mood: 'angry', expression: ['angry', 'frown'], valence: -1 },
  { kind: 'disgust', re: any(String.raw`gross|disgust\w*|yuck|eww+|revolting|nasty|vile`), strength: 3, mood: 'disgust', expression: 'grimace', valence: -1 },
  { kind: 'oops', re: any(String.raw`oops|whoops|awkward|embarrass\w*|silly me|my mistake`), strength: 3, expression: 'embarrassed' },
  { kind: 'exasperated', re: any(String.raw`sigh|ugh|seriously|whatever|obviously|yeah,? right|as if`), strength: 2, expression: ['eyeroll', 'unamused'] },
  { kind: 'tired', re: any(String.raw`tired|sleepy|exhausted|yawn\w*|bedtime|time for bed|worn out`), strength: 3, mood: 'sleep', expression: 'sleepy' },
  { kind: 'sad', re: any(String.raw`sad|unhappy|upset|heartbroken|miss (?:him|her|them|it)|passed away|died|condolences|grief|lonely`), strength: 3, mood: 'sad', expression: ['pensive', 'pleading'], valence: -1 },

  // ---- knowing and not knowing; working on it
  { kind: 'unsure', re: any(String.raw`i (?:don'?t|do not) know|not (?:quite |really |entirely )?sure|no idea|who knows|hard to (?:say|tell)|it depends|depends on|i can'?t (?:say|tell)|unclear|i'?m not certain`), strength: 3, expression: 'thinking', gesture: 'shrug' },
  { kind: 'wait', re: any(String.raw`one (?:moment|sec(?:ond)?|minute)|just a (?:moment|sec(?:ond)?|minute)|hang on|hold on|bear with me|give me a (?:moment|sec(?:ond)?)`), strength: 3, expression: 'smile', gesture: 'handup' },
  { kind: 'checking', re: any(String.raw`let me (?:check|look|see|find|have a look|take a look|think|try|run|ask|get)|i'?ll (?:check|look|find out|have a look|take a look|try|run|ask)|checking|looking (?:it |that )?(?:up|into)|i'?m (?:on it|looking|checking|working on)`), strength: 2, expression: 'thinking', look: 'away' },
  { kind: 'musing', re: start(String.raw`hmm+|let me think|i (?:think|guess|suppose|reckon|believe|wonder)|maybe|perhaps|possibly|probably|it (?:might|may|could) be|i'?d say`), strength: 1, expression: 'thinking', look: 'away' },
  { kind: 'understand', re: any(String.raw`i see|makes sense|that makes sense|got it|understood|fair enough|i hear you|good point`), strength: 2, expression: 'smile', head: 'yes' },

  // ---- yes and no, first thing in the sentence
  { kind: 'yes', re: start(String.raw`yes|yeah|yep|yup|sure(?: thing)?|absolutely|definitely|exactly|indeed|of course|certainly|correct|right(?!\s+(?:now|here|there|away|after|before|next|on|in|at|after)\b)|that'?s right|agreed|okay|ok|alright|all right|will do|sounds good|you bet`), strength: 2, expression: 'smile', head: 'yes' },
  { kind: 'no', re: start(String.raw`no|nope|nah|not really|not at all|never|i'?m afraid not|unfortunately not|not yet|that'?s not (?:right|true|it)`), strength: 2, head: 'no' },
  { kind: 'wrong', re: any(String.raw`that'?s (?:wrong|incorrect|not right|not true|false)|isn'?t (?:right|true|correct)|bad idea|not a good idea|i wouldn'?t|don'?t do (?:it|that)|thumbs down`), strength: 2, expression: 'frown', gesture: 'thumbdown', head: 'no', valence: -1 },

  // ---- making points: instructions, steps, what matters, the other side
  { kind: 'important', re: any(String.raw`important(?:ly)?|the key (?:thing|point|is)|key point|note that|keep in mind|bear in mind|crucial|essential|the thing is|the point is|remember (?:that|to)|you (?:must|need to|have to|should)`), strength: 2, gesture: 'index', look: 'camera' },
  { kind: 'reminder', re: any(String.raw`it'?s time (?:to|for)|time to|reminder|you asked me to remind|you wanted me to|don'?t forget`), strength: 2, expression: 'grin', gesture: 'index', look: 'camera' },
  { kind: 'instruct', re: start(String.raw`click|press|tap|open|close|go to|type|say|choose|pick|select|try|check|look at|put|move|drag|drop|enter|run|wait|copy|paste|save|send|turn (?:on|off)|switch|scroll|find|use|ask|tell|let me know`), strength: 1, gesture: 'index', look: 'camera' },
  { kind: 'step', re: start(String.raw`first(?:ly)?|second(?:ly)?|third(?:ly)?|next|then|after that|finally|lastly|last(?:ly)?|also|plus|another (?:thing|one)|step (?:one|two|three|\d+)|number (?:one|two|three|\d+)|one|two|three`), strength: 1, gesture: ['index', 'side'] },
  { kind: 'contrast', re: any(String.raw`but|however|on the other hand|alternatively|whereas|instead|although|though|still|then again|that said|even so`), strength: 1, gesture: 'side' },
  { kind: 'offer', re: start(String.raw`would you like|do you want|want me to|shall i|should i|can i|may i|how about|what about|if you (?:like|want)|i can (?:also )?|i could`), strength: 2, expression: ['smile', 'warm'], gesture: 'side', look: 'camera' },
  { kind: 'self', re: start(String.raw`i'?m [a-z]+,? your|my name is|i'?m your|this is [a-z]+ speaking|it'?s me`), strength: 2, expression: 'warm', gesture: 'side', look: 'camera' },
  { kind: 'stop', re: start(String.raw`stop(?: right there)?|halt|hold it|freeze|whoa there|wait a (?:sec(?:ond)?|minute|moment)`), strength: 2, gesture: 'bothup', look: 'camera', turn: 'user' },

  // ---- the small words, each a small touch at its word. Phrases above have first claim on them.
  // Who's meant.
  { kind: 'you', re: any(String.raw`you(?:rs?|rself|rselves|'ll|'re|'ve|'d)?`), strength: 1, gesture: 'side', look: 'camera', turn: 'user' },
  { kind: 'we', re: any(String.raw`we|us|our|ours|ourselves|let'?s|together|both of us`), strength: 1, expression: 'warm', gesture: ['wide', 'side'], turn: 'user' },
  { kind: 'they', re: any(String.raw`they|them|their|theirs|themselves|he|him|his|she|her|hers|someone|somebody|people|others|everyone else`), strength: 1, look: 'ahead', turn: 'aside' },
  // Here and there.
  { kind: 'this', re: any(String.raw`this|these|here|right here|this one`), strength: 1, gesture: 'index' },
  { kind: 'that', re: any(String.raw`those|over there|out there|that one|that way|elsewhere|somewhere else`), strength: 1, gesture: 'side', look: 'ahead', turn: 'aside' },
  { kind: 'far', re: any(String.raw`far(?: away| off)?|distant|remote|miles (?:away|off)|abroad|overseas`), strength: 1, gesture: 'side', look: 'ahead', turn: 'aside' },
  { kind: 'near', re: any(String.raw`near(?:by)?|close (?:to|by)|next to|beside|right by|around the corner`), strength: 1, gesture: 'ok' },
  { kind: 'up', re: new RegExp(String.raw`(?<!\b(?:set|look|pick|sign|make|end|show|come|turn|give|wake|back|line|catch|hang|fill|clean|open|wrap|bring|follow|keep|speak|cheer|mix|break|split|warm|shut|start|boot|load|call|hold|pull|bring|put|sum|top|speed|catch) )\b(?:up(?! to\b)|above|on top|upwards?|higher|highest|rise|rising|rose|raised?|climb(?:s|ed|ing)?|soar(?:s|ed|ing)?|peak(?:s|ed)?)\b`, 'g'), strength: 1, gesture: 'handup' },
  { kind: 'down', re: any(String.raw`down(?:wards?)?|below|beneath|under(?:neath)?|lower|lowest|fall(?:s|ing)?|fell|drop(?:s|ped|ping)?|sink(?:s|ing)?|sank`), strength: 1, look: 'down' },
  { kind: 'inside', re: any(String.raw`inside|into|within|contains?|included?|including`), strength: 1, gesture: 'namaste' },
  { kind: 'outside', re: any(String.raw`outside|out of|away from|apart from|except|excluding`), strength: 1, gesture: 'side', turn: 'aside' },
  { kind: 'around', re: any(String.raw`across|throughout|everywhere|all over|worldwide|anywhere|all around`), strength: 1, gesture: 'wide' },
  { kind: 'between', re: any(String.raw`between|among|versus|vs|compared (?:to|with)|either|on (?:one|each) side`), strength: 1, gesture: 'side' },
  // When.
  { kind: 'past', re: any(String.raw`ago|earlier|previously|yesterday|last (?:time|night|week|month|year)|back then|used to|formerly|before that|originally|at first`), strength: 1, look: 'ahead', turn: 'left' },
  { kind: 'future', re: any(String.raw`later|afterwards?|after that|soon|tomorrow|next (?:time|week|month|year)|in the future|eventually|upcoming|tonight|from now on|ahead`), strength: 1, gesture: 'side', turn: 'right' },
  { kind: 'now', re: any(String.raw`now|today|right now|currently|at the moment|at once|immediately|right away|instantly|straight away`), strength: 1, gesture: 'index', look: 'camera' },
  // How much.
  { kind: 'approx', re: any(String.raw`(?:about|around|roughly|approximately|nearly|almost|close to) (?=\d|one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|a (?:few|dozen|hundred|thousand|million)|half)|more or less|give or take|kind of|sort of|or so|somewhat`), strength: 1, expression: 'thinking', look: 'ahead' },
  { kind: 'big', re: any(String.raw`big(?:ger|gest)?|huge|enormous|massive|giant|gigantic|vast|large(?:r|st)?|tons|loads|lots|a lot|plenty|so (?:much|many)|many|much|whole|entire(?:ly)?|everything|everyone|everybody|all(?! right)|every|completely|totally|fully|infinite|endless|countless|maximum`), strength: 1, gesture: 'wide' },
  { kind: 'small', re: any(String.raw`small(?:er|est)?|tiny|little|a bit|bit|slight(?:ly)?|barely|hardly|only|just a|few|a few|short|brief(?:ly)?|minor|minimal|minimum|mini`), strength: 1, gesture: 'ok' },
  { kind: 'more', re: any(String.raw`more|most|increase[sd]?|increasing|grow(?:s|ing|n)?|grew|gain(?:s|ed)?|extra|additional|further|plus`), strength: 1, gesture: 'handup' },
  { kind: 'less', re: any(String.raw`less|least|fewer|decrease[sd]?|decreasing|shrink(?:s|ing)?|shrank|reduce[sd]?|reducing|minus`), strength: 1, gesture: 'ok', look: 'down' },
  { kind: 'none', re: any(String.raw`nothing|nobody|no one|none|neither|nor|zero|nowhere|without`), strength: 1, head: 'no' },
  // How good.
  { kind: 'better', re: any(String.raw`better|best|improve[sd]?|improving|upgrade[sd]?`), strength: 1, expression: 'smile', gesture: 'thumbup', valence: 1 },
  { kind: 'good', re: any(String.raw`good|nice|fine|cool|neat|handy|useful|easy|easier|simple|simply`), strength: 1, expression: 'smile', valence: 1 },
  { kind: 'bad', re: any(String.raw`worse|worst|bad|poor(?:ly)?|wrong|hard(?:er)?|difficult|tricky|complicated|tough|messy|slow(?:er)?|annoying`), strength: 1, expression: ['grimace', 'frown'], valence: -1 },
  // How sure.
  { kind: 'sure', re: any(String.raw`definitely|certainly|surely|clearly|obviously|of course|no doubt|for sure|always|guaranteed|exactly|precisely|indeed`), strength: 1, head: 'yes', look: 'camera' },
  { kind: 'maybe', re: any(String.raw`maybe|perhaps|possibly|probably|might|may|could be|likely|unlikely|seems?|apparently`), strength: 1, expression: 'thinking', look: 'ahead', turn: 'aside' },
  { kind: 'very', re: any(String.raw`very|really|extremely|incredibly|super|truly|highly|deeply|absolutely|totally|seriously|such a|quite`), strength: 1, head: 'yes' },
  { kind: 'not', re: any(String.raw`not|never|(?:do|does|did|is|are|was|were|ca|wo|could|should|would|have|has|had|must|need|ai)n'?t|cannot|no longer|no more`), strength: 1, head: 'no' },
  // How it hangs together.
  { kind: 'because', re: any(String.raw`because|since|so that|therefore|thus|hence|that'?s why|which means|that means|as a result|due to`), strength: 1, gesture: 'index', look: 'camera' },
  { kind: 'if', re: any(String.raw`if|unless|in case|as long as|provided|whether|otherwise|suppose|assuming`), strength: 1, expression: 'thinking', gesture: 'side' },
  { kind: 'example', re: any(String.raw`for example|for instance|such as|e\.g\.|like this|like that`), strength: 1, gesture: 'index', turn: 'aside' },
  { kind: 'sum', re: any(String.raw`in short|basically|essentially|overall|in the end|all in all|to sum up|in summary|anyway|in a nutshell|bottom line`), strength: 1, gesture: 'wide', look: 'camera', turn: 'user' },
  { kind: 'also', re: any(String.raw`also|too|as well|besides|moreover|furthermore|in addition|on top of that`), strength: 1, gesture: 'side' },
  // How.
  { kind: 'fast', re: any(String.raw`quick(?:ly|er|est)?|fast(?:er|est)?|rapid(?:ly)?|hurry|asap|in no time|in a flash|speedy`), strength: 1, expression: 'grin', gesture: 'index' },
  { kind: 'gentle', re: any(String.raw`slowly|gently|careful(?:ly)?|calm(?:ly)?|gradual(?:ly)?|step by step|take your time|bit by bit`), strength: 1, expression: 'warm', gesture: 'namaste' },
  { kind: 'joined', re: any(String.raw`combine[sd]?|join(?:s|ed)?|merge[sd]?|both|each other|in common`), strength: 1, gesture: 'namaste' },
  { kind: 'apart', re: any(String.raw`apart|separate(?:ly)?|each|split|divide[sd]?|alone|individually|one by one|different`), strength: 1, gesture: 'side' },
  { kind: 'aha', re: any(String.raw`aha|ooh|eureka|there it is|got it now`), strength: 1, expression: 'delighted', gesture: 'index' },
];

/** What's said to the user: said facing them. */
const TO_THEM = new Set(['greeting', 'farewell', 'welcome', 'thanks', 'empathy', 'apology', 'please', 'reassure', 'praise', 'offer', 'self', 'reminder', 'important', 'instruct', 'wait', 'stop', 'you', 'sum', 'yes', 'no']);

/** Words that turn what follows round: "not great", "not bad". */
const NEGATED = /\b(?:not|never|no|hardly|barely|isn'?t|aren'?t|wasn'?t|weren'?t|don'?t|doesn'?t|didn'?t|won'?t|can'?t|couldn'?t|shouldn'?t|wouldn'?t)\s+(?:\w+\s+)?$/;
/** Questions: an offer is told apart above; these are the rest. */
const TAG_QUESTION = /\b(?:right|isn'?t (?:it|that)|aren'?t (?:they|you)|don'?t you (?:think)?|wouldn'?t you say|no|yeah|eh)\?\s*$/;
const WH_QUESTION = new RegExp(`${START}(?:what|which|where|when|who|whom|whose|why|how)\\b`);

// ---------------------------------------------------------------- reading one sentence

const norm = (s) => String(s ?? '').toLowerCase().replace(/[’‘]/g, "'");

/** A number for the words, the same every time: for picking among choices. */
function seedOf(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Every kind said in `sentence`, in order, each with `at`: how far into the sentence (0 to 1). */
export function read(sentence) {
  const s = norm(sentence).trim();
  const len = Math.max(1, s.length);
  const taken = []; // [start, end) stretches already read as a kind
  const hits = [];
  for (const k of KINDS) {
    for (const m of s.matchAll(k.re)) {
      // A match anchored at the start may include the little "oh," before it: the kind starts after.
      const lead = m[0].match(/^\s*(?:(?:oh|ah|well|so|um|uh|and|now)[,!]?\s+)?/)?.[0].length || 0;
      const from = m.index + (k.re.source.startsWith('^') ? lead : 0);
      const to = m.index + m[0].length;
      if (to === from || taken.some(([a, b]) => from < b && to > a)) continue;
      taken.push([from, to]);
      let hit = { ...k, at: from / len, start: from };
      const before = s.slice(Math.max(0, from - 24), from);
      const negated = k.valence && before.match(NEGATED);
      if (negated) {
        // "not great" is a small letdown; "not bad" a small smile. The "not" is part of it.
        const at = from - before.length + negated.index;
        taken.push([at, from]);
        hit = { kind: `not ${k.kind}`, strength: 1, expression: k.valence > 0 ? 'disappointed' : 'smile', at: at / len, start: at };
      }
      hits.push(hit);
      break; // one of each kind a sentence
    }
  }
  return hits.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------- a whole utterance

const pick = (v, seed, avoid) => {
  if (!Array.isArray(v)) return v;
  const order = v.map((_, i) => v[(i + (seed % v.length)) % v.length]);
  return order.find((x) => x !== avoid) ?? order[0];
};

/**
 * What to show for each sentence of an utterance: [{ mood?, expression?, gesture?, head?, look?,
 * pose?, timed: [{ at, …the same }], kinds }]. `mood` is the resting mood the character starts
 * from and comes back to.
 */
export function direct(texts, o) {
  return directOn(texts, o).directions;
}

/**
 * The same, carrying on from `from` (the state the last utterance left: an answer said a sentence
 * or two at a time as it's written is read as one): { directions, state }.
 */
export function directOn(texts, { mood: resting = 'neutral', from = null } = {}) {
  const out = [];
  let mood = from?.mood ?? resting;
  let calm = from?.calm ?? 0; // sentences in a row that showed no feeling
  let prev = from?.prev ?? {}; // what the sentence before showed
  let said = from?.said ?? 0; // sentences said so far
  let facing = from?.facing ?? 'user'; // where it faces: the user, or turned to the left or right
  let squareOn = from?.squareOn ?? 0; // sentences in a row facing the user
  let side = from?.side ?? 'right'; // the way it turns aside, this time
  texts.forEach((text) => {
    const t = String(text ?? '').trim();
    const s = norm(t);
    const seed = seedOf(s);
    const hits = read(t);
    const d = { timed: [], kinds: hits.map((h) => h.kind) };

    // What leads: the strongest kind said early (in its first 40%, or its first few words); later
    // ones are shown at their word.
    const early = hits.filter((h) => h.at <= 0.4 || h.start <= 12);
    // With nothing said early, a kind that matters leads anyway; a small word waits for its word.
    const lead = early.length ? early.reduce((a, b) => (b.strength > a.strength ? b : a)) : hits[0]?.strength > 1 ? hits[0] : undefined;
    const set = (target, h, k, avoid) => {
      if (h[k] === undefined) return false;
      target[k] = pick(h[k], seed, avoid);
      return true;
    };
    for (const h of [lead, ...early.filter((x) => x !== lead)].filter(Boolean)) {
      for (const k of ['mood', 'expression', 'gesture', 'head', 'look', 'turn']) if (d[k] === undefined) set(d, h, k, prev[k]);
    }
    const carried = new Set(); // what a "but" already shows
    let lastAt = 0;
    for (const h of hits.filter((x) => !early.includes(x) && x !== lead)) {
      if (d.timed.length >= 2) break;
      if (carried.has(h)) continue;
      // Later in the sentence, at its word: a turn of feeling ("…, but it failed"), a "but", a strong
      // kind, or, a little apart from the last, a small word that moves the hands, the head or the body.
      const turns = h.valence && Math.sign(h.valence) !== Math.sign(lead?.valence || 0);
      const strong = turns || h.strength >= 3 || h.kind === 'contrast';
      if (!strong && h.at - lastAt < 0.25) continue;
      const c = { at: Math.round(Math.min(0.95, h.at) * 100) / 100 };
      for (const k of ['mood', 'expression', 'gesture', 'head', 'turn', 'look']) {
        if (h[k] === undefined || (!strong && (k === 'mood' || k === 'expression'))) continue;
        const showing = k === 'mood' ? d.mood ?? mood : d[k] ?? prev[k];
        const v = pick(h[k], seed, showing);
        if (v !== showing) c[k] = v;
      }
      if (Object.keys(c).length > 1) {
        d.timed.push(c);
        lastAt = h.at;
      }
      // A "but …" carries the feeling of what follows it.
      if (h.kind === 'contrast') {
        const after = hits.find((x) => x.start > h.start && x.valence);
        if (after) {
          carried.add(after);
          for (const k of ['mood', 'expression']) if (after[k] !== undefined) c[k] = pick(after[k], seed, d[k]);
        }
      }
    }

    // How it ends: a question, an exclamation, trailing off.
    const question = /\?\s*["'”’)]*$/.test(t);
    if (question && !hits.some((h) => h.kind === 'offer')) {
      if (TAG_QUESTION.test(s)) {
        d.expression ??= 'smirk';
        d.head ??= 'yes';
      } else if (WH_QUESTION.test(s)) d.expression ??= 'thinking';
      else d.expression ??= 'smile';
      d.look ??= 'camera';
      d.turn = 'user';
    }
    if (/!\s*["'”’)]*$/.test(t) && d.expression === undefined) d.expression = ['sad', 'fear', 'angry'].includes(d.mood ?? mood) ? 'shocked' : 'grin';
    if (/(?:\.\.\.|…)\s*$/.test(t) && d.expression === undefined) d.expression = (d.mood ?? mood) === 'sad' ? 'pensive' : 'thinking';

    // The mood: changed only when the feeling does, and back to rest after two calm sentences.
    const felt = d.mood ?? [...d.timed].reverse().find((c) => c.mood)?.mood;
    if (d.mood && d.mood === mood) delete d.mood;
    if (felt) {
      mood = felt;
      calm = 0;
    } else if (mood !== resting && ++calm >= 2) {
      d.mood = mood = resting;
      calm = 0;
    }

    // Kept varied: no gesture or face twice running (unless it really matters).
    const strengthOf = (k) => Math.max(0, ...hits.filter((h) => h[k] !== undefined).map((h) => h.strength));
    if (d.gesture && d.gesture === prev.gesture) delete d.gesture;
    if (d.expression && d.expression === prev.expression && strengthOf('expression') < 3) delete d.expression;
    if (d.head && d.head === prev.head && !hits.some((h) => h.head && h.at <= 0.1)) delete d.head;

    // Where it faces: the user for what's said to them, aside for thinking aloud and the like; and
    // after a couple of sentences square-on, now and then aside anyway, back after one.
    if (d.turn === undefined && hits.some((h) => TO_THEM.has(h.kind))) d.turn = 'user';
    const ownTurn = d.timed.some((c) => c.turn); // a word of its own turns it, later on
    if (d.turn === undefined && !ownTurn) d.turn = facing === 'user' ? (squareOn >= 2 && seed % 3 !== 0 ? 'aside' : 'user') : 'user';
    if (d.turn === 'aside') {
      if (facing === 'user') side = seed % 2 ? 'left' : 'right';
      d.turn = side;
    }
    let now = d.turn ?? facing;
    for (const c of d.timed) {
      if (c.turn === 'aside') c.turn = now === 'user' ? side : now;
      if (c.turn === now) delete c.turn;
      now = c.turn ?? now;
    }
    d.timed = d.timed.filter((c) => Object.keys(c).length > 1);
    const faced = [...d.timed].reverse().find((c) => c.turn)?.turn ?? d.turn;
    squareOn = faced === 'user' ? (d.turn === facing ? squareOn + 1 : 1) : 0;
    if (d.turn === facing) delete d.turn;
    facing = faced;
    // Turned aside, the eyes go the way it faces; back to the user, they look at them.
    if (d.turn && d.look === undefined) d.look = d.turn === 'user' ? 'camera' : 'ahead';
    if (d.look && d.look === prev.look) delete d.look;

    // A long answer: a change of stance every few sentences.
    if (++said % 4 === 0) d.pose = STANDING_POSES[1 + (seed % (STANDING_POSES.length - 1))];

    prev = d;
    out.push(clean(d));
  });
  return { directions: out, state: { mood, calm, prev, said, facing, squareOn, side } };
}

/** One sentence on its own: what it shows (as the first sentence of an utterance). */
export function rules(sentence, o) {
  return direct([sentence], o)[0];
}

function clean(d) {
  const o = Object.fromEntries(Object.entries(d).filter(([k, v]) => v !== undefined && k !== 'kinds' && k !== 'timed'));
  return { ...o, timed: d.timed, kinds: d.kinds };
}

/**
 * One sentence's direction, from what was asked (the request), the cues written in the text (an
 * emoji, a [tag]) and what the words show (`auto`, from direct), in that order of precedence.
 * Cues written in the text are played where they were written, so they're kept apart: `timed`;
 * what the words show at a later word is timed too, unless a written cue already shows that kind.
 */
export function merge({ asked = {}, auto = null, cues = [] }) {
  const out = {};
  for (const k of ['mood', 'expression', 'gesture', 'head', 'pose', 'look', 'turn']) {
    if (asked[k]) out[k] = asked[k];
    else if (cues.some((c) => c[k])) continue; // played at its own time
    else if (auto && auto[k]) out[k] = auto[k];
  }
  const written = new Set(cues.flatMap((c) => Object.keys(c)));
  const later = (auto?.timed || [])
    .map((c) => Object.fromEntries(Object.entries(c).filter(([k]) => k === 'at' || (!written.has(k) && !asked[k]))))
    .filter((c) => Object.keys(c).length > 1);
  return { ...out, timed: [...cues, ...later].sort((a, b) => a.at - b.at) };
}
