# Avatar Desk

A 3D avatar that floats on your Mac desktop with no window or background around it. Everything runs on your Mac:

- **The look and lip-sync** come from [TalkingHead](https://github.com/met4citizen/TalkingHead) 1.7 and [HeadAudio](https://github.com/met4citizen/HeadAudio), which reads the lip shapes from the sound itself, as in HeadAudio's `openai.html` demo.
- **The conversation** comes from **Ollama**.
- **The voice and hearing** come from **Super Voice** (Kokoro for speaking, Parakeet for listening).
- **Expressions and gestures** come from [motion-engine](https://github.com/lhupyn/motion-engine) 2.1: 35 facial expressions, 5 head movements and 16 hand gestures. A local Ollama model picks them, sentence by sentence, instead of Jev on OpenRouter.

## What you need

- Node.js 22 or newer.
- **Ollama**, running, with at least one model pulled. For example:
  - `ollama pull qwen3:8b` for the conversation.
  - `ollama pull qwen3:4b` (optional) for choosing expressions and gestures. A small model keeps reactions quick. With 64 GB you can afford a bigger conversation model.
- **Super Voice**, running, with TTS and STT switched on.

## Install and run

```bash
cd avatar-desk
npm install      # also downloads three sample avatars into renderer/avatars
npm start
```

The avatar appears at the bottom right of your screen. The first time you hold the mic, macOS asks for microphone access.

To make a real app you can keep in Applications:

```bash
npm run dist     # → dist/mac-arm64/Avatar Desk.app
```

The app is unsigned, so the first time you open it, right-click it and choose **Open**.

## Using it

| To | Do |
|---|---|
| Talk | Hold the mic button or **Space**, speak, then let go. |
| Talk from any app | Press **⌘⇧Space** to start listening and again to send. |
| Type | Hover over the avatar, type in the box and press Return. |
| Interrupt | Start talking, or press **Esc**. |
| Move | Drag the avatar. |
| Resize | Right-click › Size (small, medium or large). |
| Options | Right-click: settings, new conversation, framing (face, head and shoulders, waist up, full body), size, keep on top, click-through. |
| Let clicks pass through | Use the right-click menu, or press **⌘⇧H** (press it again to undo). |
| Hide or show the avatar | Press **⌘⇧A**. |

In Settings you can change the avatar's name and personality, choose the two Ollama models, pick a voice and speed, and set the addresses of Ollama and Super Voice. Settings are saved in `~/Library/Application Support/Avatar Desk/settings.json`.

## How it works

```
you ──mic──▶ Super Voice /api/stt ──text──▶ Ollama /api/chat (streamed)
                                              │ sentence by sentence
                                              ▼
                 Super Voice /api/tts (PCM) ──▶ TalkingHead speech path ──▶ speakers
                                              │                └──▶ HeadAudio ──▶ lips
                                              └──▶ motion-engine.feed(sentence)
                                                     └─ Ollama picks face / head / hands
```

**A reply streams in from Ollama.** It is cut into sentences. Each sentence is sent to Super Voice right away, so the next one is ready while the current one plays.

**Lip-sync comes from the audio.** Each sentence's audio goes into TalkingHead's speech path, exactly where `openai.html` plugged in the WebRTC stream. HeadAudio listens there and drives the lips.

**Motion follows the speech.** When a sentence starts playing, it is also handed to motion-engine. motion-engine asks the Ollama classifier (`renderer/ollama.js`) to pick an expression, a head movement and a hand gesture. The JSON schema it sends lists only names from motion-engine's catalog, so the model can't pick anything that doesn't exist. motion-engine's director then applies its confidence thresholds and cooldowns.

**Your own lines get a reaction too.** What you say is fed to motion-engine first, so the avatar reacts as a listener, for example with concern at bad news, before it answers.

**The window is see-through.** TalkingHead draws on a transparent WebGL canvas, the page has no background, and Electron's window is transparent and frameless. Nothing is cut out of a video, so edges such as hair stay clean.

**The page is served from a local web address.** The app serves itself on `127.0.0.1` because Super Voice and Ollama both accept requests from localhost pages but not from `file://` pages.

## Tuning

**How often it gestures.** A local model rates its own picks generously, so the confidence thresholds in `renderer/config.js` (`minConfidence`) are set a little higher than motion-engine's defaults. Raise them for a calmer avatar and lower them for a livelier one. To see every decision and why it did or didn't play, right-click › Developer tools and look at the console (`[motion] …`).

**Other avatars.** Add a `.glb` file to `renderer/avatars/` and an entry to `AVATARS` in `renderer/config.js`. It needs TalkingHead's rig and blend shapes: a Mixamo skeleton, plus ARKit and Oculus viseme shapes. motion-engine's poses and expression levels are tuned to its demo avatar (the default, "Mira"), so other avatars may look slightly off.

**Lip-sync timing.** The 80 ms `DelayNode` in `renderer/app.js` holds back the sound so the lips catch up. `speakerMeanHz` is set from the voice's gender to match it.

## Licenses

The code in this folder may be used freely. TalkingHead, HeadAudio, motion-engine and three.js are MIT-licensed.

The sample avatars are not free for commercial use:

- `female_1.glb` (motion-engine's demo avatar) was made with Ready Player Me and is licensed CC BY-NC-SA 4.0.
- `julia.glb` and `david.glb` come from the HeadAudio repository; check their terms before any commercial use.

Use them for personal projects, or make your own avatar (see TalkingHead's Appendix A).
