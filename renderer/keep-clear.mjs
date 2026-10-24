// The hands kept out of the head. TalkingHead's gestures and poses are joint angles (some picked
// at random, some mirrored) played on top of a pose, a look, a nod and the hands it moves as it
// talks, and one gesture often takes over from another halfway, on avatars of different builds:
// nothing in it stops one body part going through another, and now and then a hand passes through
// the head. So, each frame after TalkingHead has posed the body, every point of each hand and
// forearm is checked against the head (the avatar's own head, hair and all, down to the chin,
// turning with it), and an arm that's in it is swung out from the shoulder just far enough to
// clear it. While the hands are clear, nothing is changed. No Electron or WebGL in here, so it's
// tested on its own.

import * as THREE from 'three';

const SIDES = ['Left', 'Right'];
const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];
const PAD = 0.15; // room left around the head for the hand's own thickness, as a share of the head's size
const TRIES = 8; // swings an arm gets in one frame
const AROUND = 24; // the head's outline: directions around it (15° apart)…
const UPDOWN = 12; // …and from straight down to straight up
const UP = new THREE.Vector3(0, 1, 0);
const ACROSS = new THREE.Vector3(1, 0, 0);

/** The bone of the head and the bones under it (eyes, jaw, the top of the head). */
function headBones(head) {
  const out = new Set();
  head.traverse((o) => o.isBone && out.add(o));
  return out;
}

/**
 * The head's shape, from the avatar's skinned meshes: the vertices that move with the head (its
 * bone, or a bone under it, carries most of their weight), in the head bone's own space, as they
 * are at rest, down to about the chin (long hair hangs to the shoulders, and the arms must be free
 * to move there). It's kept as how far the head reaches from its middle in each direction, so a
 * jaw or a bun is as much the head as the skull is. Answers { bone, center, size, reach(dir) }
 * (`dir` a unit vector in the bone's space), or null when there's no head.
 */
export function headShape(armature) {
  const bone = armature?.getObjectByName('Head');
  if (!bone) return null;
  const mine = headBones(bone);
  const v = new THREE.Vector3();
  const toHead = new THREE.Matrix4();
  const found = [];
  armature.traverse((mesh) => {
    if (!mesh.isSkinnedMesh || !mesh.skeleton) return;
    const g = mesh.geometry;
    const pos = g.attributes.position;
    const index = g.attributes.skinIndex;
    const weight = g.attributes.skinWeight;
    if (!pos || !index || !weight) return;
    const bones = mesh.skeleton.bones;
    const at = bones.indexOf(bone);
    if (at === -1) return;
    // At rest, a vertex in the head bone's space is its inverse bind matrix after the mesh's bind matrix.
    toHead.multiplyMatrices(mesh.skeleton.boneInverses[at], mesh.bindMatrix);
    for (let i = 0; i < pos.count; i++) {
      let w = 0;
      for (let k = 0; k < index.itemSize; k++) if (mine.has(bones[index.getComponent(i, k)])) w += weight.getComponent(i, k);
      if (w >= 0.5) found.push(v.fromBufferAttribute(pos, i).applyMatrix4(toHead).clone());
    }
  });
  if (found.length < 50) return null;
  // Up the head: towards the bone at its top, where the rig has one. The chin is about a fifth of
  // the head's height below the bone.
  const top = bone.children.find((c) => c.isBone && /top/i.test(c.name));
  const up = top && top.position.lengthSq() > 0 ? top.position.clone().normalize() : new THREE.Vector3(0, 1, 0);
  const highest = Math.max(...found.map((p) => p.dot(up)));
  const head = found.filter((p) => p.dot(up) >= -0.2 * highest);
  const box = new THREE.Box3().setFromPoints(head);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3()).length() / 2;

  // How far it reaches, direction by direction, from its middle.
  const across = new THREE.Vector3(1, 0, 0).projectOnPlane(up);
  if (across.lengthSq() < 1e-6) across.set(0, 0, 1).projectOnPlane(up);
  across.normalize();
  const ahead = new THREE.Vector3().crossVectors(across, up);
  const cell = (d) => [((Math.atan2(d.dot(ahead), d.dot(across)) / (2 * Math.PI) + 1) % 1) * AROUND, ((Math.asin(Math.max(-1, Math.min(1, d.dot(up)))) / Math.PI) + 0.5) * (UPDOWN - 1)];
  const grid = new Float32Array(AROUND * UPDOWN);
  for (const p of head) {
    const d = p.clone().sub(center);
    const r = d.length();
    if (r < 1e-9) continue;
    const [a, e] = cell(d.divideScalar(r));
    const k = Math.round(e) * AROUND + (Math.round(a) % AROUND);
    grid[k] = Math.max(grid[k], r);
  }
  // Each direction reaches as far as its neighbours do (no gaps between them), and the room for a
  // hand's thickness on top.
  const reachOf = new Float32Array(grid.length);
  for (let e = 0; e < UPDOWN; e++) {
    for (let a = 0; a < AROUND; a++) {
      let r = 0;
      for (let de = -1; de <= 1; de++) for (let da = -1; da <= 1; da++) {
        const ee = e + de;
        if (ee >= 0 && ee < UPDOWN) r = Math.max(r, grid[ee * AROUND + ((a + da + AROUND) % AROUND)]);
      }
      reachOf[e * AROUND + a] = (r || size * 0.5) + PAD * size;
    }
  }
  /** How far the head reaches from its middle towards `dir`: smooth from one direction to the next. */
  const reach = (dir) => {
    const [a, e] = cell(dir);
    const a0 = Math.floor(a) % AROUND;
    const a1 = (a0 + 1) % AROUND;
    const e0 = Math.min(UPDOWN - 1, Math.floor(e));
    const e1 = Math.min(UPDOWN - 1, e0 + 1);
    const fa = a - Math.floor(a);
    const fe = e - Math.floor(e);
    const at = (ee, aa) => reachOf[ee * AROUND + aa];
    return (at(e0, a0) * (1 - fa) + at(e0, a1) * fa) * (1 - fe) + (at(e1, a0) * (1 - fa) + at(e1, a1) * fa) * fe;
  };
  return { bone, center, size, reach };
}

/** The bones of one arm that can reach the head, the shoulder first; null if the avatar has none. */
function armOf(armature, side) {
  const get = (n) => armature.getObjectByName(`${side}${n}`);
  const shoulder = get('Arm');
  const elbow = get('ForeArm');
  const wrist = get('Hand');
  if (!shoulder || !elbow || !wrist) return null;
  const fingers = FINGERS.map((f) => [1, 2, 3].map((n) => get(`Hand${f}${n}`)).filter(Boolean)).filter((f) => f.length);
  return { shoulder, elbow, wrist, fingers };
}

/**
 * Keeps an avatar's hands out of its head: call `update()` once a frame, after the body is posed
 * (TalkingHead's `update` option).
 */
export function keepClear(armature, { shape = headShape(armature) } = {}) {
  const arms = shape ? SIDES.map((s) => armOf(armature, s)).filter(Boolean) : [];
  const toLocal = new THREE.Matrix4();
  const points = Array.from({ length: 64 }, () => new THREE.Vector3());
  const local = new THREE.Vector3();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const pivot = new THREE.Vector3();
  const middle = new THREE.Vector3();
  const out = new THREE.Vector3();
  const along = new THREE.Vector3();
  const axis = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const turn = new THREE.Quaternion();
  const parent = new THREE.Quaternion();

  /** The points of an arm to keep out, in world space: the forearm, the wrist, every finger joint and tip. */
  function sample(arm) {
    let n = 0;
    arm.elbow.getWorldPosition(a);
    arm.wrist.getWorldPosition(b);
    for (const t of [0, 0.35, 0.7, 1]) points[n++].lerpVectors(a, b, t);
    for (const finger of arm.fingers) {
      for (const joint of finger) joint.getWorldPosition(points[n++]);
      // The tip is past the last joint, about as far again as the joint before it.
      if (finger.length >= 2) {
        const [before, last] = [points[n - 2], points[n - 1]];
        points[n++].subVectors(last, before).multiplyScalar(0.8).add(last);
      }
    }
    return n;
  }

  /** The point of the arm deepest in the head, and how far it has to go to be out: null when clear. */
  function deepest(arm) {
    const n = sample(arm);
    toLocal.copy(shape.bone.matrixWorld).invert();
    let best = null;
    for (let i = 0; i < n; i++) {
      local.copy(points[i]).applyMatrix4(toLocal).sub(shape.center);
      const r = local.length();
      const dir = r > 1e-9 ? local.divideScalar(r) : local.set(0, 0, 1);
      const depth = (shape.reach(dir) - r) / shape.size;
      if (depth > 0 && (!best || depth > best.depth)) best = { depth, i };
    }
    return best;
  }

  /** Swings the arm about the shoulder by `rotation` (in world space). */
  function swing(arm, rotation) {
    const s = arm.shoulder;
    s.parent.getWorldQuaternion(parent);
    // The world turn, made in the shoulder's parent's space: P⁻¹ · q · P, before what the bone has.
    q.copy(parent).invert().multiply(rotation).multiply(parent);
    s.quaternion.premultiply(q);
    s.updateMatrixWorld(true);
  }

  /** Once a frame. Answers how many swings it took (0 when the hands were clear). */
  function update() {
    if (!arms.length) return 0;
    armature.updateMatrixWorld(true);
    shape.bone.localToWorld(middle.copy(shape.center));
    const scale = shape.bone.matrixWorld.getMaxScaleOnAxis();
    let swings = 0;
    for (const arm of arms) {
      for (let k = 0; k < TRIES; k++) {
        const hit = deepest(arm);
        if (!hit) break;
        // The point moves round the shoulder: as much of "straight out of the head" as it can.
        const p = points[hit.i];
        arm.shoulder.getWorldPosition(pivot);
        a.subVectors(p, pivot);
        const radius = a.length();
        if (radius < 1e-9) break;
        a.divideScalar(radius);
        out.subVectors(p, middle).normalize();
        along.copy(out).addScaledVector(a, -out.dot(a));
        // Shoulder, point and head in a line: any way round the shoulder takes it out.
        if (along.lengthSq() < 0.04) along.crossVectors(a, Math.abs(a.y) < 0.9 ? UP : ACROSS).normalize();
        const push = (hit.depth * shape.size * scale + 0.002) / Math.max(0.2, along.length());
        axis.crossVectors(a, along).normalize();
        swing(arm, turn.setFromAxisAngle(axis, Math.min(0.5, push / radius)));
        swings++;
      }
    }
    return swings;
  }

  return { update, shape, inHead: (arm = 0) => (arms[arm] ? !!deepest(arms[arm]) : false), arms: arms.length };
}
