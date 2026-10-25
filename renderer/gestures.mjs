// Gestures for both hands at once, made of TalkingHead's own: a one-handed gesture and its mirror
// image on the other arm, or a two-handed one with the arms held differently. TalkingHead mirrors
// a pose by swapping Left and Right and turning the angles about y and z round; the same is done
// here to the template's angles (a range of angles, picked from at random each time, is turned
// round end for end).

/**
 * The gestures made here: the gesture each is made of, and angles of its own for the left arm
 * where it differs (the right arm gets their mirror image). "wide" is TalkingHead's "side" brought
 * halfway back to the arm at rest (both arms out at full stretch don't fit the window): both arms
 * open, low, palms out. "clasp", "hold" and "wring" are its "namaste" (the palms together) with the
 * hands brought down in front: low in front of the hips, at the waist, and at the waist pressed
 * across each other (from "hold" to "wring" and back is rubbing them). A man's build is wider: his
 * arms are brought further in (`M`), as TalkingHead does for its own "namaste".
 */
export const BOTH_HANDS = {
  wide: {
    from: 'side',
    arm: {
      'LeftShoulder.rotation': { x: 1.687, y: -0.1, z: -1.615 },
      'LeftArm.rotation': { x: 1.04, y: -0.199, z: 0.422 },
      'LeftForeArm.rotation': { x: 0, y: 0, z: 0.551 },
      'LeftHand.rotation': { x: -0.21, y: -0.755, z: 0.034 },
    },
  },
  bothup: { from: 'handup' },
  clasp: {
    from: 'namaste',
    arm: {
      'LeftArm.rotation': { x: 1.3, y: 0.5, z: 0.03 },
      'LeftForeArm.rotation': { x: 0.17, y: 0.1, z: 1.27 },
    },
    M: { 'LeftArm.rotation': { x: 1.3, y: 0.5, z: 0.35 } },
  },
  hold: {
    from: 'namaste',
    arm: {
      'LeftArm.rotation': { x: 1.25, y: 0.5, z: 0.3 },
      'LeftForeArm.rotation': { x: 0.17, y: 0.1, z: 1.6 },
    },
    M: { 'LeftArm.rotation': { x: 1.25, y: 0.5, z: 0.45 } },
  },
  wring: {
    from: 'namaste',
    arm: {
      'LeftArm.rotation': { x: 1.25, y: 0.5, z: 0.45 },
      'LeftForeArm.rotation': { x: 0.17, y: 0.1, z: 1.6 },
    },
    M: { 'LeftArm.rotation': { x: 1.25, y: 0.5, z: 0.6 } },
  },
};

const flip = (a) => (Array.isArray(a) ? [-a[1], -a[0], ...a.slice(2)] : -a);

/** The gesture `one` with the left arm's `arm` angles, and their mirror image on the right where it has none or they're its own. */
function mirrored(one, arm) {
  const left = { ...one, ...arm };
  const both = { ...left };
  for (const [key, v] of Object.entries(left)) {
    const m = key.match(/^(Left|Right)(.+\.rotation)$/);
    if (!m) continue;
    const other = `${m[1] === 'Left' ? 'Right' : 'Left'}${m[2]}`;
    if (!(other in left) || key in arm) both[other] = { x: v.x, y: flip(v.y), z: flip(v.z) };
  }
  return both;
}

/** Adds the two-handed gestures to TalkingHead's, so `playGesture('wide')` plays one (on a man, his own where there is one). */
export function bothHands(head) {
  const forMen = {};
  for (const [name, { from, arm = {}, M }] of Object.entries(BOTH_HANDS)) {
    const one = head.gestureTemplates[from];
    if (!one) continue;
    head.gestureTemplates[name] = mirrored(one, arm);
    if (M) forMen[name] = mirrored(one, { ...arm, ...M });
  }
  const play = head.playGesture.bind(head);
  head.playGesture = (name, ...rest) => {
    if (head.avatar?.body !== 'M' || !forMen[name]) return play(name, ...rest);
    const own = head.gestureTemplates[name];
    head.gestureTemplates[name] = forMen[name];
    try {
      return play(name, ...rest);
    } finally {
      head.gestureTemplates[name] = own;
    }
  };
}
