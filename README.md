# Super Face

The mouth and the face. A menu bar app for the Mac: a 3D avatar, head to toes, standing on your
desktop with no window or background around it, that says whatever it's given, out loud, with
lip-sync, expressions and gestures. Any app can make it talk, over HTTP, the way apps use Ollama.

[Super Voice](https://github.com/ainigh/super-mac-tts-stt-service) is the ears and the model;
Super Face is the mouth and the presentation. With both running, everything Super Voice says (AI
Listen's Tom, Jerry and Jane) is said by the avatar, and Super Voice asks Super Face about each
phrase it hears ("was that you?"), so it doesn't take the avatar's voice for yours. The goal it was
built to is in [GOAL.md](GOAL.md).

- **The voice**: Kokoro-82M, through [HeadTTS](https://github.com/met4citizen/HeadTTS), in the app
  itself: on the Mac's GPU (WebGPU) when it can, else the CPU. Eight voices, the same six as Super
  Voice (with the same short names, f1–f3 and m1–m3) and two more. Each word and viseme comes with
  its timing, so the lips follow the words exactly.
- **The face and body**: [TalkingHead](https://github.com/met4citizen/TalkingHead), all of it: 8
  moods, 27 expressions, 8 hand gestures, nods and shakes, 10 body poses, eye contact, hands that
  move as it talks, blinking and breathing while it waits.
- **Feeling**: for each sentence, a mood, an expression, a gesture and a head movement. What the
  caller asks for comes first (fields, or emojis and `[tags]` written in the text); then Super
  Voice's model chooses (one question per reply, from the catalog's names only; the app has no
  model of its own, so there's one model on the Mac for both); and rules on the words fill in until
  it answers, or when it can't be reached.
- **Not hearing itself**: it keeps what it said and when; `POST /api/echo` tells a listener
  whether a phrase it heard was the avatar's own words coming back. Plain word comparison, nothing
  fancier.
- **API**: [API.md](API.md), at `http://127.0.0.1:8769`: speak, stop, express, show and hide, what
  was said, the echo check, live events, audio without the avatar, settings and updates.

## Install

Paste this into Terminal (it installs Homebrew's `gh` if needed and signs you in to GitHub, since
the repository may be private):

```bash
/bin/bash -c 'for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$("$b" shellenv)"; done; command -v gh >/dev/null || brew install gh; gh auth status >/dev/null 2>&1 || gh auth login --web --git-protocol https -h github.com; gh api -H "Accept: application/vnd.github.raw" repos/ainigh/JUST-super-mac-tts-ONLY-service/contents/install.sh | bash'
```

It takes the latest release GitHub built; if there isn't one, it builds it on your Mac (that needs
Node.js 22). It installs `~/Applications/Super Face.app` and opens it: look for the little person
in the menu bar. The first time, the voice model downloads (a few hundred MB); the menu shows how
far it has got.

**Update**: the menu shows **Update to …** when there's a newer release (or `POST /api/update
{"install": true}`); running the install line again works too.

## Using it

| To | Do |
|---|---|
| Show or hide the avatar | Click the menu bar icon, or press **⌘⇧A** anywhere |
| Make it talk | `curl -s localhost:8769/api/speak -d '{"text": "Hello!"}'` (it shows itself) |
| Options | Right-click the icon, or the avatar: avatar, framing (head to toes, waist up, head and shoulders, face), voice, speed, resting mood, where expressions come from, size, hiding after it talks, captions, keep on top, the API on or off, copy its URL and docs, updates, open at login |
| Move it | Drag the avatar |

Settings are kept in `~/Library/Application Support/Super Face/settings.json`.

## How it works

```
any app ──POST /api/speak──▶ main process (API, the record of what's said, the window)
                                   │  speak / stop / express
                                   ▼
                      the avatar's page (transparent window)
                        text → sentences, cues taken out
                        each sentence → HeadTTS (Kokoro) → audio + word and viseme timing
                        each sentence → direction ◀── what was asked, Super Voice's model, rules
                        → TalkingHead.speakAudio: lips on the visemes; mood, expression,
                          gesture, nod at their moments
                                   │  started / sentence / ended
                                   ▼
                      /api/said, /api/echo, /api/events ──▶ Super Voice (the ears)
```

Sentences are made one after another while the one before plays, so there's no wait between
them; the next utterance is made while this one plays. The window is transparent and frameless:
TalkingHead draws on a transparent canvas, so edges such as hair stay clean.

## Working on it

```bash
npm install          # also downloads the two avatars into renderer/avatars
npm test             # the API, the text and cues, the director, the echo check (no Electron)
npm start            # the app
npm run dev          # without Electron: open http://127.0.0.1:8769/renderer/index.html in Chrome
npm run dist         # on a Mac: dist/SuperFace.zip
```

| | |
|---|---|
| `main.mjs` | the Electron main process: the menu bar, the window, the commands to the page, the API server |
| `src/main/` | the API (`api.mjs`), the record of what's said (`speech.mjs`), settings, the updater, the menu bar icon |
| `src/shared/` | the catalog of what it can show, voices, text into sentences and cues, the director (rules and the model's question), the echo check: used by both sides |
| `renderer/` | the avatar's page: TalkingHead, HeadTTS, the speaking queue |
| `scripts/` | fetching the avatars, the browser dev server, packaging for the Mac |
| `.github/workflows/build.yml`, `install.sh` | building and releasing (pushes to `main`), installing |

## Licenses

The code here may be used freely. TalkingHead, HeadTTS and three.js are MIT-licensed; Kokoro and
transformers.js are Apache 2.0. The avatars: `brunette.glb` comes from TalkingHead's repository and
`david.glb` from HeadAudio's; check their terms before any commercial use.
