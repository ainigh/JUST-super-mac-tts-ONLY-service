# Super Face

A character on your Mac's desktop you just talk to. A 3D person, head to toes, with no window or
background around it, on standby as soon as it opens: it hears you, thinks with one local model,
does things with your scripts through [Tool Mac Tool Run](https://github.com/ainigh/tool-mac-tool-run),
sets itself reminders, learns as it goes, and answers out loud, with lip-sync, expressions and
gestures. Click it for the chat. Any app can make it talk, or talk to it, over HTTP. The goal it
was built to is in [GOAL.md](GOAL.md).

It's everything [Super Voice](https://github.com/ainigh/super-mac-tts-stt-service) does with AI
Listen (hearing you, a model, tools, memory) without the complexity: one assistant instead of Tom,
Jerry and Jane, one model instead of three, no library of its own (the notes are a Tool Mac Tool
Run script), and no wake word.

- **Four characters, each its own voice**: Ivy (a woman, Kokoro's Heart), David (a man, Michael),
  Sofia (a woman, Emma, British) and Leo (a young man, Puck). Picking one picks its voice and its
  name.
- **Ears**: while it shows, it listens. Silero VAD hears where your phrase starts and ends,
  Moonshine writes it down, both in the app (on the GPU when there's one). Its own voice is kept out
  three ways: the microphone's echo cancellation, then what it heard is compared word for word with
  what it just said (and dropped when it's only that), and you can turn off listening while it
  talks. Talk over it and it stops to listen. A small light at its feet says when it hears you.
- **One model**: [Ollama](https://ollama.com)'s, on this Mac (the best one you have, or the one you
  pick). It answers, calls the tools, and writes the emojis and `[tags]` its face plays, all in one
  answer, said sentence by sentence as it's written.
- **Tools, hand-rolled**: the model writes a line of JSON, `{"tool": …, "arguments": …}`, and the
  result comes back to it as the next message (not Ollama's tool calling, so any model can). Its
  tools are Tool Mac Tool Run's (run a script or a flow, write Flow code, read runs), each run
  asking you on the Mac first, plus its own: a schedule and its memory. **Cancel** any of it: the
  Stop button, a Cancel on a tool's card, or say "cancel": a run waiting for your click is taken off
  the Mac, a running one is stopped.
- **Later**: "remind me in 20 minutes…", "at 5 check the build…", "on Friday at 8…". It
  schedules a task for itself (as many as you like, each cancellable); when it's due the character
  appears and does it.
- **Learning**: it keeps short notes of what it learns about you, which scripts work for what, and
  its mistakes, reads them every time, and you can read and delete them (and give it standing
  instructions) in the chat's **Mind** tab.
- **The chat**: click the character. What you both said, each tool at work (waiting for your click,
  running, what it printed, Cancel), every tool there is (fetched from Tool Mac Tool Run as it
  opens), what's scheduled, its memory and model, the **Prompts** it's given as they stand now
  (each with Copy), and the **Errors** (with **Copy report**, to paste wherever you report a
  problem, and **Try the voice again**); the character picker and the size buttons (smaller and
  bigger go round). Click it again to hide it.
- **The face**: [TalkingHead](https://github.com/met4citizen/TalkingHead) (8 moods, 27 expressions,
  8 hand gestures, nods and shakes, 10 poses) and Kokoro through
  [HeadTTS](https://github.com/met4citizen/HeadTTS), with each word and viseme timed, so the lips
  follow the words.
- **API**: [API.md](API.md), at `http://127.0.0.1:8769`: speak, stop, express, audio alone, the
  echo check, and the assistant (chat, cancel, tools, schedules, memory), with live events.

## Install

Paste this into Terminal (it installs Homebrew's `gh` if needed and signs you in to GitHub, since
the repository may be private):

```bash
/bin/bash -c 'for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$("$b" shellenv)"; done; command -v gh >/dev/null || brew install gh; gh auth status >/dev/null 2>&1 || gh auth login --web --git-protocol https -h github.com; gh api -H "Accept: application/vnd.github.raw" repos/ainigh/JUST-super-mac-tts-ONLY-service/contents/install.sh | bash'
```

It takes the latest release GitHub built; if there isn't one, it builds it on your Mac (that needs
Node.js 22). It installs `~/Applications/Super Face.app` and opens it: the character appears, says
hello, and listens. macOS asks once for the microphone. The first time, the voice and the ears
download (a few hundred MB); the menu shows how far they've got.

What it works with, on the same Mac:

1. **Ollama** with a model: `brew install ollama`, then `ollama pull qwen3:8b` (or any model; it
   picks the best you have). Without it, it says it can't reach its model.
2. **Tool Mac Tool Run** with its API on (its [install](https://github.com/ainigh/tool-mac-tool-run)):
   its scripts are the character's tools. Its examples include `utilities/library.py`, your notes
   (the character's library: this app keeps none of its own). A scripts folder set up before that
   script existed doesn't get it by itself; this puts it there (`~/Scripts` is the usual folder):

   ```bash
   gh api -H "Accept: application/vnd.github.raw" repos/ainigh/JUST-super-mac-tts-ONLY-service/contents/extras/library.py > ~/Scripts/utilities/library.py && chmod +x ~/Scripts/utilities/library.py
   ```

**Something not working?** Click the character, open **Errors**, and **Copy report**: it has what
went wrong (a voice that didn't start says why, from inside the voice's own worker) and how
everything stands (versions, GPU, voice, ears, model, tools). **Try the voice again** starts the
voice again without restarting the app.

**Update**: the menu shows **Update to …** when there's a newer release (or `POST /api/update
{"install": true}`); running the install line again works too.

## Using it

| To | Do |
|---|---|
| Ask it anything | Just talk while it shows (no wake word), or type in the chat |
| Open or hide the chat | Click the character |
| Stop it talking / cancel what it's doing | Say "stop" / "cancel" (or "never mind"); or the red button in the chat |
| Start over | Say "new chat", or **Mind › Start a new chat** |
| Show or hide the character | Click the menu bar icon, or **⌘⇧A** anywhere |
| Change character (and voice), size | The chat's top row; or right-click the icon or the character |
| Model, thinking, listening while it talks, memory | The chat's **Mind** tab |
| Move it | Drag it |

Its settings, chat, schedule and memory are kept in `~/Library/Application Support/Super Face/`.

## How it works

```
 mic ─▶ ears (Silero VAD + Moonshine, in a worker) ─▶ main process: was that its own voice? a command?
                                                          │
 chat window ── typed ──────────────────────────────────▶ assistant ◀── schedule (due tasks)
                                                          │   ▲
                                         one model (Ollama, streamed)   memory notes
                                                          │   │ tool result
                                                          ▼   │
                      a tool call? ── schedule / remember ┤   │
                                   └─ Tool Mac Tool Run (streamed run: card, click, output; cancellable)
                                                          │
                     its words, sentence by sentence ─────▶ the character's page: HeadTTS (Kokoro) +
                                                            TalkingHead (lips, mood, gestures)
```

## Working on it

```bash
npm install          # also downloads the four characters into renderer/avatars
npm test             # the assistant, its tools, the schedule, memory, the API, the text, the director, the echo check
npm start            # the app
npm run dev          # without Electron: http://127.0.0.1:8769/renderer/index.html and /renderer/chat.html in Chrome
npm run dist         # on a Mac: dist/SuperFace.zip (checks every file the pages load is in it)
scripts/smoke-mac.sh # on a Mac, after dist: opens the app, waits for it, makes it speak, asks its assistant
```

| | |
|---|---|
| `main.mjs` | the Electron main process: the menu bar, the character's window and the chat beside it, the API server |
| `src/main/core.mjs` | the assistant and what it works with, what's heard, the actions the chat and the API share |
| `src/main/assistant.mjs` | the conversation: the model, tool calls, cancelling, the harness's notes, learning |
| `src/main/prompt.mjs` | what the model is told (one model, the three habits), and the notes it gets when it slips |
| `src/main/model.mjs`, `toolrun.mjs`, `scheduler.mjs`, `memory.mjs`, `calls.mjs` | Ollama, Tool Mac Tool Run, the schedule, memory, reading tool calls |
| `src/main/api.mjs`, `speech.mjs` | the API; the record of what's said |
| `src/shared/` | the characters, the catalog of what it can show, voices, text into sentences and cues, the director, the echo check |
| `renderer/` | the character's page (TalkingHead, HeadTTS, the ears) and the chat; `voice-glue.mjs` runs inside HeadTTS's worker to say what went wrong there, `ort-local.mjs` gives transformers.js ONNX Runtime from the app rather than a CDN |
| `scripts/` | fetching the characters, the browser dev server, packaging for the Mac |
| `extras/library.py` | the notes library script, as Tool Mac Tool Run ships it, for folders set up before it did |

## Licenses

The code here may be used freely. TalkingHead, HeadTTS and three.js are MIT-licensed; Kokoro,
Moonshine, Silero VAD and transformers.js are Apache 2.0 / MIT. The characters: `brunette.glb`
(Ready Player Me, CC BY-NC 4.0), `avaturn.glb` (Avaturn) and `avatarsdk.glb` (AvatarSDK) come from
TalkingHead's repository, `david.glb` from HeadAudio's; they're for non-commercial use: check their
terms before any commercial use.
