// The characters: each is an avatar, a voice and a name, chosen together. Picking a character is
// picking its voice; the assistant goes by the character's name.

export const CHARACTERS = [
  { id: 'brunette', name: 'Ivy', file: 'brunette.glb', body: 'F', voice: 'af_heart', looks: 'a woman with dark hair and glasses' },
  { id: 'david', name: 'David', file: 'david.glb', body: 'M', voice: 'am_michael', looks: 'a man with a moustache and glasses' },
  {
    id: 'avaturn',
    name: 'Sofia',
    file: 'avaturn.glb',
    body: 'F',
    voice: 'bf_emma',
    looks: 'a woman in a dark suit, long brown hair',
    // Avaturn's head sits a little high and its eyes a little wide, as TalkingHead's own example corrects.
    baseline: { headRotateX: -0.05, eyeBlinkLeft: 0.15, eyeBlinkRight: 0.15 },
  },
  { id: 'avatarsdk', name: 'Leo', file: 'avatarsdk.glb', body: 'M', voice: 'am_puck', looks: 'a young man with a beard, in a teal shirt' },
];

export const DEFAULT_CHARACTER = CHARACTERS[0].id;

export const characterOf = (id) => CHARACTERS.find((c) => c.id === id) || CHARACTERS[0];

/** A character asked for by id or name ("Sofia", "avaturn"); null when there's none. */
export function resolveCharacter(asked) {
  const k = String(asked ?? '').trim().toLowerCase();
  return CHARACTERS.find((c) => c.id === k || c.name.toLowerCase() === k) || null;
}

/** The sizes the character can be, smallest first: [width, height] of its window. */
export const SIZES = { Small: [220, 470], Medium: [300, 640], Large: [380, 800], Huge: [470, 980] };
export const SIZE_NAMES = Object.keys(SIZES);

/** The size after (or before, step -1) `name`, going round. */
export function nextSize(name, step = 1) {
  const i = SIZE_NAMES.indexOf(name);
  const n = SIZE_NAMES.length;
  return SIZE_NAMES[(((i === -1 ? 1 : i) + step) % n + n) % n];
}
