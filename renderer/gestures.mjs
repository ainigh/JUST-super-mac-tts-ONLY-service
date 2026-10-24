// Gestures for both hands at once, made of TalkingHead's own one-handed ones: the gesture, and its
// mirror image on the other arm. TalkingHead mirrors a pose by swapping Left and Right and turning
// the angles about y and z round; the same is done here to the template's angles (a range of
// angles, picked from at random each time, is turned round end for end).

/**
 * The gestures made here: the one-handed gesture each is made of, and angles of its own for the
 * arm where it differs. "wide" is TalkingHead's "side" brought halfway back to the arm at rest
 * (both arms out at full stretch don't fit the window): both arms open, low, palms out.
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
};

const flip = (a) => (Array.isArray(a) ? [-a[1], -a[0], ...a.slice(2)] : -a);

/** Adds the two-handed gestures to TalkingHead's, so `playGesture('wide')` plays one. */
export function bothHands(head) {
  for (const [name, { from, arm = {} }] of Object.entries(BOTH_HANDS)) {
    const one = head.gestureTemplates[from];
    if (!one) continue;
    const left = { ...one, ...arm };
    const both = { ...left };
    for (const [key, v] of Object.entries(left)) {
      const m = key.match(/^(Left|Right)(.+\.rotation)$/);
      if (!m) continue;
      const other = `${m[1] === 'Left' ? 'Right' : 'Left'}${m[2]}`;
      if (!(other in left)) both[other] = { x: v.x, y: flip(v.y), z: flip(v.z) };
    }
    head.gestureTemplates[name] = both;
  }
}
