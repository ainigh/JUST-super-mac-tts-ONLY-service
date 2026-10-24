# Super Face API

Super Face is a menu bar app for the Mac: a 3D character, head to toes, with no window or
background around it, that you talk to. It hears you, thinks with one local model (Ollama's), does
things with your scripts and flows through [Tool Mac Tool Run](https://github.com/ainigh/tool-mac-tool-run),
sets itself reminders, learns, and answers out loud with feeling. Other apps can make it say
anything, talk to its assistant, or use its voice alone.

- **The voice**: Kokoro-82M through [HeadTTS](https://github.com/met4citizen/HeadTTS), in the app
  (on the GPU through WebGPU, else the CPU). Every word and viseme comes with its timing, so the
  lips follow the words exactly. The model downloads once (a few hundred MB); after that nothing
  leaves the Mac.
- **The face and body**: [TalkingHead](https://github.com/met4citizen/TalkingHead): 8 moods, 27
  expressions, 8 hand gestures, nods and shakes, 10 body poses, eye contact.
- **What it shows** while it talks: what the caller asks for; then what's written in the text (an
  emoji, a `[tag]`); then what the sentences themselves call for, read from their words (no model,
  no waiting): hello waves, thanks bows, sorry saddens, good news smiles with an OK, a question
  looks at you, an instruction points, "I don't know" shrugs, "one moment" holds up a hand, a "but"
  turns the face at that word. The assistant's words are read the same way.
- **The assistant**: [below](#the-assistant). One model, hand-rolled tool calls, a schedule, memory.

This document is the contract for client apps. New fields may be added to responses, but nothing
listed here changes meaning.

```
Base URL   http://127.0.0.1:8769
```

## In one minute

```bash
# say something (the avatar shows itself, speaks, and the call answers at once)
curl -s localhost:8769/api/speak -d '{"text": "Hello! Nice to meet you."}'

# with feeling: a mood, a gesture, and cues written in the text
curl -s localhost:8769/api/speak -d '{"text": "I have bad news. [sad] The build failed. 😔 [shrug]", "voice": "m1"}'

# wait until it has been said
curl -s localhost:8769/api/speak -d '{"text": "Done.", "wait": true}'
# {"ok":true,"id":"…","state":"done","text":"Done.","voice":"af_heart","seconds":0.9}

# just a face, no words
curl -s localhost:8769/api/express -d '{"expression": "wink", "gesture": "thumbup"}'

# stop, show, hide
curl -s -X POST localhost:8769/api/stop
curl -s -X POST localhost:8769/api/show
curl -s -X POST localhost:8769/api/hide

# audio only, without the avatar (WAV, 24 kHz mono)
curl -s localhost:8769/api/tts -d '{"text": "Hello there", "voice": "bella"}' -o hello.wav

# for the ears: was what I just heard your voice?
curl -s localhost:8769/api/echo -d '{"text": "nice to meet you"}'
# {"echo":true,"rest":"","matched":1,"speaking":false,"lines":1}
```

## Endpoints

| route | does |
|---|---|
| `GET  /api/health` | whether it's up, whether it's showing or speaking, how the voice model is doing |
| `GET  /api/voices` | the voices, and the default voice and speed |
| `GET  /api/catalog` | every mood, expression, gesture, head movement and pose, with what each means |
| `POST /api/expressions` | what the character would show for a text, sentence by sentence (nothing is said) |
| `POST /api/speak` | text → said by the avatar (queued after what's being said) |
| `GET  /api/speak/{id}` | how an utterance is going (`?wait=true` answers once it's over) |
| `POST /api/stop` | stops speaking and empties the queue (only one caller's, with `source`) |
| `POST /api/express` | a mood, expression, gesture, head movement, pose or look, now, without words |
| `POST /api/show`, `/api/hide`, `/api/toggle` | the avatar on the desktop, or not |
| `GET  /api/said` | what was said in the last `?seconds=30`, sentence by sentence, with when |
| `POST /api/echo` | was a phrase someone heard the avatar's own voice? |
| `GET  /api/events` | Server-Sent Events: each utterance queued, started, each sentence, ended |
| `POST /api/tts` | text → audio (WAV, PCM, or JSON with word and viseme timing), not said |
| `GET  /api/settings`, `POST /api/settings` | the avatar, framing, voice, speed, resting mood, … |
| `GET  /api/update`, `POST /api/update` | whether there's a newer version; `{"install": true}` installs it |
| `GET  /api/assistant` | the assistant: the character, what it's doing, the ears, the model, the tools |
| `POST /api/chat`, `GET /api/chat` | a message to the assistant (`"wait": true` answers with its reply); the conversation |
| `POST /api/chat/new` | a fresh conversation (the chat keeps what was said, behind a line) |
| `POST /api/chat/clear` | clears the chat: the conversation and every entry of it (memory stays) |
| `GET  /api/trace/model` | the latest requests to the model (`?limit=20`): the messages sent, word for word, and what came back |
| `GET  /api/trace/calls` | the latest tool calls (`?limit=20`): each with its arguments, every request it made (address, body, status, request id, the stream's events, the answer) and what went back to the model |
| `POST /api/cancel` | cancels what the assistant is doing: its answer, a run waiting for its click or running |
| `POST /api/heard` | a phrase heard by other ears, handled as if the character's own had heard it |
| `GET  /api/tools`, `POST /api/tools` | every tool it has (built in, and Tool Mac Tool Run's scripts and flows); POST asks again |
| `GET  /api/schedules`, `POST /api/schedules` | what it has set itself to do later; set one |
| `POST /api/schedules/cancel` | cancels one (`{"id": "s3"}`) or all (`{"id": "all"}`) |
| `GET  /api/memory`, `POST /api/memory` | what it has learned, and the user's standing instructions |
| `GET  /api/errors` | what went wrong (the voice, the ears, the avatar, the model, the app), and `report`: all of it with versions and state, as text to paste |
| `GET  /` | a status page, with a box to try it |
| `GET  /api.md` | this document |

The menu bar icon starts and stops the server; when it's stopped, connections are refused.

---

### `POST /api/speak`

```json
{"text": "Hello there! How are you today?", "voice": "f1", "speed": 1.0,
 "mood": "happy", "expression": "grin", "gesture": "handup", "head": "yes", "pose": "hip",
 "wait": false, "interrupt": false, "show": true, "auto": true, "source": "myapp", "who": "Tom"}
```

| field | | |
|---|---|---|
| `text` | required | up to 20,000 characters. Markdown, links and code are tidied for reading aloud |
| `voice` | optional | see *Naming a voice*; default: the one picked in the menu |
| `speed` | optional | 0.5 to 2.0 |
| `mood` | optional | the mood it says it in (see *What it can show*); it goes back to its resting mood after |
| `expression`, `gesture`, `head`, `pose` | optional | shown on the first sentence |
| `wait` | optional | `true`: answer once it has been said (or stopped), with its state |
| `interrupt` | optional | `true`: stop everything being said first |
| `show` | optional | `false`: don't bring the avatar up for it (it speaks hidden) |
| `auto` | optional | `false`: show only what's asked for and written in, nothing chosen for it |
| `source` | optional | who's asking (40 characters); `POST /api/stop {"source"}` stops only theirs |
| `who` | optional | who is speaking (a character's name), passed to the model and the events |

A plain-text body (`Content-Type: text/plain`) is taken as `text`.

Answers `202 {"ok": true, "id": "…", "queued": 1}`, or with `wait`, `200 {"ok": true, "id", "state":
"done", "text", "voice", "source", "who", "seconds"}` (`ok` is false and `state` is `stopped` or
`failed` when it wasn't said in full).

**Cues in the text.** Emojis and `[tags]` are not read out; they're shown where they're written.
An emoji right after a sentence ("Sorry. 😔") is how that sentence is said.

| written | shows |
|---|---|
| `😀 😉 🤔 😱 😭 🥰 🙄 …` | that expression (`GET /api/catalog` has the list) |
| `👋 👍 👎 👌 👉 🤷 🙏` | that gesture |
| `[happy]`, `[mood:sad]` | the mood, from there on |
| `[wink]`, `[expression:thinking]` | the expression |
| `[thumbup]`, `[gesture:shrug]`, `[wave]` | the gesture |
| `[nod]`, `[shake]`, `[head:yes]` | the head movement |
| `[pose:hip]` | the pose |

Brackets that aren't one of these are read as they are.

**What's shown otherwise.** For anything the request and the text leave out, the sentences are
read for what kind each is, and where in it each kind is said: a greeting or goodbye (a wave), thanks
(hands together), an apology or sympathy (a sad face, a nod), good news or something done (a smile,
the OK sign), praise (a thumbs-up), wonder, joy, a joke, bad news or a failure (disappointed, the
mood sad), a warning (a grimace, a pointed finger), not knowing (a shrug), "one moment" (a hand
up), thinking it over or "let me check" (a thoughtful look away), a yes or a no at the start (a nod
or a shake), an instruction or a step (pointing), "but"/"however" (a hand to the side, and the face
of what follows, at that word), an offer or a question (a smile and a look at you). "Not" turns a
word round ("not great"). The mood holds until the feeling changes and comes back to rest after two
calm sentences; no gesture or face is repeated twice running; a sentence of plain facts is said
calmly. Nothing is asked of a model, so it's instant and the same every time for the same words.
The menu's *Expressions* setting: *From the words* (the default), or *Only when asked* (only what's
asked for and written in). `POST /api/expressions` shows what would be done, without saying it.

### `POST /api/expressions`

```bash
curl -s localhost:8769/api/expressions -d '{"text": "The run failed, sorry. Would you like me to try again?"}'
# {"mood":"neutral","sentences":[{"text":"The run failed, sorry.","mood":"sad","expression":"disappointed","timed":[],"kinds":["failure","apology"]},
#   {"text":"Would you like me to try again?","expression":"smile","gesture":"side","look":"camera","timed":[],"kinds":["offer"]}]}
```

Each sentence: what it shows as it starts (`mood`, `expression`, `gesture`, `head`, `look`, `pose`),
what it shows later (`timed`, each at `at`, 0 to 1 through the sentence), and the `kinds` read in it.
`mood` (optional) is the resting mood to start from (the settings' by default).

### `GET /api/speak/{id}`

`{"ok": true, "id", "state", "text", "voice", "source", "who"}`, where `state` is `queued`,
`speaking`, `done`, `stopped` or `failed` (with `error`). `?wait=true` answers once it's over. The
last 200 utterances are kept.

### `POST /api/stop`

`{}` stops everything; `{"source": "myapp"}` stops only what `myapp` asked for. Answers
`{"ok": true, "stopped": 2}`.

### `POST /api/express`

```json
{"mood": "love", "expression": "adoring", "gesture": "namaste", "head": "yes", "pose": "side", "look": "camera", "duration": 3}
```

Any of them (at least one). `look` is `camera`, `ahead` or `away`; `duration` (seconds, up to 60)
is how long the expression or gesture is held. The avatar shows itself unless `"show": false`.
Answers `{"ok": true, …what was shown}`.

### What it can show

`GET /api/catalog` lists each with what it means. In short:

| | names |
|---|---|
| `mood` | neutral, happy, love, sad, fear, angry, disgust, sleep |
| `expression` | neutral, smile, warm, grin, delighted, beaming, laughing, playful, wink, smirk, adoring, starstruck, kiss, thinking, glance, eyeroll, unamused, grimace, embarrassed, shocked, frown, disappointed, pensive, pleading, crying, angry, sleepy |
| `gesture` | handup (also `wave`), index (also `point`), ok, thumbup, thumbdown, side, shrug, namaste |
| `head` | yes, no |
| `pose` | straight, side, hip, turn, wide, back, bend, oneknee, kneel, sitting |

An expression or gesture can also be named by its emoji. An unknown name is
`400 {"code": "unknown_name"}`.

### `GET /api/voices`

```json
{"default": "af_heart", "speed": 1, "voices": [
  {"id": "af_heart", "name": "Heart", "gender": "female", "accent": "us", "alias": "f1"}, …]}
```

Eight Kokoro voices: Heart (f1), Bella (f2), Emma (f3, UK), Michael (m1), Fenrir (m2), Puck (m3), the
same six as Super Voice with the same short names, and Nicole (f4) and George (m4, UK). Each
character has its voice (Ivy: Heart, David: Michael, Sofia: Emma, Leo: Puck), and picking a
character picks it; `voice` on a request still overrides it for that request.

**Naming a voice**: the id (`af_heart`), the name (`heart`), the short name (`f1` … `m4`), `female` /
`male`, `uk` / `us`; nothing means the default. An unknown name is `400 {"code": "unknown_voice"}`.

### `GET /api/said` and `POST /api/echo`: not hearing itself

Super Face knows exactly what it said and when, so whatever is listening (its own ears, or another app) can check
each phrase it hears, without echo cancellation or anything else fancy:

```bash
curl -s localhost:8769/api/echo -d '{"text": "the weather is sunny today", "seconds": 2.5}'
```

| field | | |
|---|---|---|
| `text` | required | what was heard |
| `seconds` | optional | how long the phrase was (default 10); what was said from then on, or up to 2.5 s before, counts |
| `at` | optional | when it ended, in milliseconds since 1970 (default: now) |

Answers `{"echo": true|false, "rest": "…", "matched": 0.8, "speaking": false, "lines": 2}`. `echo`
is true when what was heard is the avatar's own words coming back (a word misheard here and there
still counts); `rest` is what's left that the user said (the echo before it taken off), and is
empty for an echo. "Stop", "wait" and the like said first are always the user's.

`GET /api/said?seconds=30` answers `{"speaking", "current", "lines": [{"id", "text", "start", "end",
"source", "who"}]}` (times in milliseconds since 1970), for listeners that would rather compare
themselves.

### `GET /api/events`

Server-Sent Events, one per line of `data:` JSON, with its type as `event:`:

```
event: started
data: {"type":"started","id":"…","text":"Hello there! How are you?","source":"myapp","who":"","at":1767225600000}

event: sentence
data: {"type":"sentence","id":"…","text":"Hello there!","duration":1.2,"source":"myapp","who":"","at":…}
```

Types: `hello` (on connecting, with `speaking`), `queued`, `started`, `sentence` (as each starts
playing, with its length in seconds), `ended`, `stopped`, `failed`.

### `POST /api/tts`

```json
{"text": "Hello there", "voice": "m2", "speed": 1.0, "format": "wav"}
```

`format`: `wav` (default; `audio/wav`, 24 kHz, mono, 16-bit), `pcm` (raw 16-bit little-endian) or
`json`: `{"audio": "<base64 WAV>", "words", "wtimes", "wdurations", "visemes", "vtimes",
"vdurations", "sampleRate"}`, times in milliseconds, visemes Oculus's (`aa`, `E`, `I`, `O`, `U`,
`PP`, `SS`, `TH`, `CH`, `FF`, `kk`, `nn`, `RR`, `DD`, `sil`): enough to drive another avatar.
Headers: `X-Voice`, `X-Sample-Rate`, `X-Duration`.

### `GET /api/health`

```json
{"ok": true, "service": "superface", "version": "0.1.12", "port": 8769, "uptime": 3641,
 "visible": true, "speaking": false, "queued": 0, "avatar": "ready", "ready": true,
 "models": {"tts": {"state": "ready"}}, "expressions": "rules", "character": "Ivy",
 "assistant": {"busy": false, "phase": "idle", "queued": 0, "tool": null, "model": "qwen3:8b", "error": null},
 "ears": {"state": "listening", "device": "webgpu"}}
```

`ready` is true when it can speak: the avatar loaded and the voice ready. Check it before handing
speech over. `avatar` is `loading`, `ready` or `failed` (then `message` says why).
`models.tts.state` is `loading`, `downloading` (the first time, with `progress`), `ready` or
`failed` (with `message`).

A speak made while it's still starting (the first seconds after it opens) waits for it, up to 15
seconds, and is then refused with `503 not_ready`. One it can't say (the avatar didn't load, or the
voice didn't) is refused at once, so a caller can say it another way. An utterance the avatar goes
quiet on for a minute ends `failed`, so nobody waits on it for ever.

### Settings and updates

`POST /api/settings` takes any of `avatar` (the character: `brunette` Ivy, `david` David,
`avaturn` Sofia, `avatarsdk` Leo; its voice comes with it), `view` (`full`, `mid`, `upper`,
`head`), `voice`, `speed`, `mood` (the resting mood), `expressions` (`rules`: read from the words; `off`: only what's asked),
`captions` (true/false), `hideAfter` (seconds after speaking before it hides; 0 stays), `model`
(an Ollama model's name; empty: the best one Ollama has), `think` (true: it thinks before
answering), `ollamaUrl`, `toolRunUrl`, `listening` (the ears on while it shows), and
`listenWhileSpeaking` (it can be cut in on), and answers all of them. `GET /api/update` says `{"state": "idle" | "checking" |
"upToDate" | "available" | "installing" | "failed", "version", "latest"}`; `POST /api/update` checks
again, `{"install": true}` installs and restarts.

## Errors

`{"error": "what went wrong", "code": "…"}`:

| status | `code` | when |
|---|---|---|
| 400 | `missing_text`, `bad_speed`, `unknown_voice`, `unknown_name`, `bad_request` | the request isn't right |
| 403 | `forbidden` | a browser page from another site, or a `Host` that isn't this machine |
| 404 | `not_found` | no such route, or utterance |
| 413 | `too_large` | text over 20,000 characters, or a body over 1 MB |
| 503 | `model_loading` | the voice is still downloading, the first time; has `progress`, and `Retry-After` |
| 503 | `model_failed` | the voice model didn't load |
| 503 | `avatar_failed` | the avatar didn't load; `error` says why |
| 503 | `not_ready` | still starting after 15 seconds; has `Retry-After` |
| 500 | `failed` | anything else |

## Access

It listens on **127.0.0.1** only. Programs on this Mac are always answered; browser pages only from
this machine (`http://localhost:*`, `http://127.0.0.1:*`), or origins added to `origins` in the
settings file (`~/Library/Application Support/Super Face/settings.json`).

## The assistant

The character is an assistant on standby: as soon as it's showing it listens, and anything said to
it is a request (no wake word). Typed messages (its chat, or `POST /api/chat`) are the same.

- **One model**: Ollama's (`http://127.0.0.1:11434`), the one in `model`, else the best Ollama has
  (Qwen 3, Qwen 2.5, Gemma 3, Llama 3.x… in that order). It talks, uses the tools, and writes the
  emojis and `[tags]` its face shows, in one answer, streamed: each sentence is said as soon as
  it's written.
- **Tools, hand-rolled**: the model ends an answer with one line of JSON, `{"tool": "name",
  "arguments": {…}}`; the app runs it and hands the result back as the next message, until the
  model answers in words (ten tools for one request at most). Not Ollama's tool calling, so any
  model can do it.
- **Tool Mac Tool Run's tools**: `run_script`, `run_flow`, `run_flow_code`, `check_flow`,
  `list_scripts`, `list_runs`, `read_run`, `stop_run`, over its API (`http://127.0.0.1:8768`). The
  scripts and flows (with what each does and takes) are fetched as the app opens, every five
  minutes, and on `POST /api/tools`, and put in the model's instructions. Every run puts a card on
  the Mac and waits for the user's click on Run. Runs are streamed, so each can be **cancelled**
  at any point: while the card waits (the card is taken away and nothing runs) or while it runs
  (it's stopped). The routes it lists (`GET /api/endpoints`) are fetched with them.
- **Notes**: `library` (an `op`, with `name`, `text`, `q`, `to`…) is Tool Mac Tool Run's file
  library (`POST /api/library`), which answers at once, with no card: this app keeps no library of
  its own. An older Tool Mac Tool Run without it: the notes script (`utilities/library.py`).
- **Remembering the user's world**: Tool Mac Tool Run's MEMORY (a file for each kind of thing:
  PEOPLE, ORGANIZATIONS, EVENT-DATES, BIRTHDAYS, LOCATIONS, IDEAS, LEVERAGE, STRATEGIES, OTHERS) and
  its mind (what links to what), all answered at once. `remember` (`category`, `about`, `text`,
  `links`, `notes` such as `"birthday 03-14"`), `recall` (`name`), `memory` (`upcoming`,
  `members`, and its files as for the library), `mind` (`about`, `find`, `path`, `neighbors`,
  `query` in its notation, `add` a link, `note`…; compacting is the person's). The model is told to
  recall before it answers about a person, place, organization, plan or date, and to write only
  what the user said. With every request, what the mind already has on what's being said
  (`POST /api/mind/context`) goes in with the model's instructions, and the next week's dates
  (`upcoming`) are fetched with the scripts.
- **Showing and Chrome's page**: `show` (a window in front of everything, with copy buttons:
  your text, a file, or a node of the mind), `copy` (to the clipboard), `browser` (`url`,
  `tabs`, `page`, `has`, `find`, `highlight`, `outline`: reads Chrome's page to guide the user
  through a site; it never clicks).
- Each of these is offered only when Tool Mac Tool Run lists its group and has it switched on.
- **Every other route** Tool Mac Tool Run lists (Straw, automation, system docs, and whatever it
  adds later) is reached with `call_api` (`method`, `path`, `body`, `why`), only under `/api/` on
  that server; one marked as asking on the Mac waits for the click there.
- **Its own tools**: `schedule` (`in_minutes`, or `at`: a local date and time such as
  `"2026-10-24 17:30"`, `"17:30"`, `"tomorrow 9:00"`, `"friday 8:00"`), `list_schedules`,
  `cancel_schedule` (an id, or `"all"`); `learn` and `unlearn` (its own notes: how to work with
  the user, which scripts work for what, its mistakes).
- **Later**: when something scheduled comes due, the character shows itself (if it wasn't showing)
  and the model is given the task to do now. Kept across restarts; one due while the app was
  closed is done as it opens, saying it's late.
- **Its habits** (one model playing what Super Voice gave three): understand what's wanted and own
  it until it's delivered; do it with a tool, never claiming what no tool did; check what came
  back with suspicion before answering. The app steps in at the moments it matters: an answer
  that promises work with no call is sent back; a tool call that can't be read is asked for again;
  a run that failed brings a note to work out why before retrying; after a request that took work,
  a quiet moment (nothing said) to save what it taught.
- **Memory**: up to 60 short notes in three sections (`user`, `playbook`, `mistakes`), read every
  turn, written by the model, shown in the chat window (where the user can delete them), plus the
  user's standing instructions.
- **Heard**: what the ears write down is first compared with what the character just said
  (`/api/echo`'s comparison), so its own voice coming back is dropped; said over it, it cuts in.
  "Stop" stops it talking, "cancel" (or "never mind") calls off whatever it's doing, "new chat"
  starts over, "clear the chat" wipes it, all without the model. A phrase that sounds unfinished ("…and") waits a moment for
  the rest.

### `POST /api/chat`

```bash
curl -s localhost:8769/api/chat -d '{"text": "what is on my list for later?", "wait": true}'
# {"ok":true,"id":"e12","reply":"You've one thing: stretch at 17:30.","tools":[{"name":"list_schedules","state":"done","result":"s1: today at 17:30 …"}]}
```

`text` is required; `wait: true` answers once the request is over (with `reply`, what was said;
`tools`, each tool used and how it went; `error` if the model couldn't be reached), else at once
with `202` and the entry's `id`. `show: false` keeps the character hidden. The reply is said out
loud either way. `GET /api/chat?limit=50` gives the conversation's entries (`user`, `assistant`,
`tool` with `name`, `args`, `state` (`working`, `sending`, `waiting` for the click, `running`,
`done`, `failed`, `cancelled`), `output`, `result`; `schedule`, `note`, `error`, `divider`).

### `POST /api/heard`

`{"text": "what's the weather", "at": 1792812247715, "seconds": 1.4}` (`at` and `seconds`
optional): for another app that listens. Answers what came of it: `{"said": "…"}`, `{"held":
true}` (waiting for the rest), `{"dropped": "echo"}`, `{"command": "cancel"}`…

### `GET /api/errors`

`{"errors": [{"id", "at", "source", "message", "detail", "count"}], "report": "Super Face 0.1.7, report made …"}`.
`source` is `voice`, `ears`, `avatar`, `speech`, `page`, `chat`, `model`, `api` or `app`; the same
error again within a minute is counted (`count`), not listed twice. A voice that doesn't start says
why, from inside its worker (a download that failed, a model that didn't load), for each try (the
GPU, then the CPU; twice round). The chat's **Errors** tab shows them, with **Copy report** and
**Try the voice again**.

### `GET /api/events`, for the assistant

Besides the speech events, the stream carries `entry` (a conversation entry added or changed),
`assistant` (what it's doing: `phase` is `idle`, `thinking`, `tool` or `learning`), `ears` (`off`,
`loading`, `listening`, `hearing`, `writing`, `paused`, `failed`), `heard`, `schedules`, `memory`,
`tools`, `errors` and `status`.

## With Super Voice

Super Voice's own Super Face link still works: it can make the character speak (`/api/speak`) and
check what it hears with `/api/echo`. Run one assistant at a time, though: Super Face now listens
and thinks for itself.
