// Defaults. Everything here can be changed in Settings (right-click the avatar);
// saved values live in ~/Library/Application Support/Avatar Desk/settings.json.

export const AVATARS = {
  female_1: { label: 'Mira (motion-engine demo)', url: './avatars/female_1.glb', body: 'F' },
  julia: { label: 'Julia', url: './avatars/julia.glb', body: 'F' },
  david: { label: 'David', url: './avatars/david.glb', body: 'M' },
};

export const DEFAULTS = {
  avatar: 'female_1',
  cameraView: 'upper',

  // Ollama
  ollamaUrl: 'http://127.0.0.1:11434',
  chatModel: '', // empty: the first model Ollama lists
  motionModel: '', // the model that picks expressions and gestures; empty: same as chatModel
  thinking: false, // ask thinking models (qwen3, deepseek-r1…) to answer straight away

  // Super Voice
  voiceUrl: 'http://127.0.0.1:8767',
  voice: 'f1',
  speed: 1.0,

  name: 'Ava',
  persona:
    'You are {name}, a friendly assistant who lives on the user’s Mac desktop as a 3D avatar. ' +
    'Everything you write is spoken aloud by a voice, so talk like a person in a conversation: ' +
    'short answers (one to three sentences unless asked for more), no markdown, no lists, no emojis, ' +
    'no code blocks. Spell out symbols that read badly aloud. Be warm, natural and direct.',

  // motion-engine director: a local LLM rates its own picks generously, so these
  // sit a little above the defaults tuned for Jev.
  minConfidence: { expression: 0.6, head: 0.6, hands: 0.7 },
};

// Kokoro voices in Super Voice: f1–f3 are female, m1–m3 male.
export const isMaleVoice = (voice) => /^(m\d|male|am_|michael|fenrir|puck)/i.test(voice || '');
