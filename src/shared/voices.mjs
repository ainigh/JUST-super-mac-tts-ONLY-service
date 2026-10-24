// The voices: Kokoro-82M's, the same six Super Voice has (with the same short names, which never
// change), and two more. HeadTTS speaks them with American English pronunciation.

export const VOICES = [
  { id: 'af_heart', name: 'Heart', female: true, alias: 'f1' },
  { id: 'af_bella', name: 'Bella', female: true, alias: 'f2' },
  { id: 'bf_emma', name: 'Emma', female: true, alias: 'f3' },
  { id: 'am_michael', name: 'Michael', female: false, alias: 'm1' },
  { id: 'am_fenrir', name: 'Fenrir', female: false, alias: 'm2' },
  { id: 'am_puck', name: 'Puck', female: false, alias: 'm3' },
  { id: 'af_nicole', name: 'Nicole', female: true, alias: 'f4' },
  { id: 'bm_george', name: 'George', female: false, alias: 'm4' },
];

export const DEFAULT_VOICE = VOICES[0].id;

export const accent = (v) => (v.id.startsWith('b') ? 'uk' : 'us');

export function voiceJSON(v) {
  return { id: v.id, name: v.name, gender: v.female ? 'female' : 'male', accent: accent(v), alias: v.alias };
}

/**
 * What a caller asked for: an id ("af_heart"), a name ("Heart"), a short name ("f1", "m3"),
 * "female" / "male", "uk" / "us". Blank gives `fallback`; anything else unknown gives null.
 */
export function resolveVoice(asked, fallback = DEFAULT_VOICE) {
  if (asked === undefined || asked === null || String(asked).trim() === '') {
    return VOICES.find((v) => v.id === fallback) || VOICES[0];
  }
  const key = String(asked).trim().toLowerCase();
  switch (key) {
    case 'female':
    case 'f':
    case 'woman':
      return VOICES.find((v) => v.female);
    case 'male':
    case 'm':
    case 'man':
      return VOICES.find((v) => !v.female);
    case 'uk':
    case 'british':
      return VOICES.find((v) => accent(v) === 'uk');
    case 'us':
    case 'american':
      return VOICES.find((v) => accent(v) === 'us');
    default:
      return VOICES.find((v) => v.id === key || v.name.toLowerCase() === key || v.alias === key) || null;
  }
}
