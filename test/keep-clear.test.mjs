// The hands kept out of the head, on a small made-up avatar: a head (a ball, with long hair down
// to the shoulders), and a left arm bent so its hand is in the head.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { headShape, keepClear } from '../renderer/keep-clear.mjs';

const bone = (name, x, y, z, parent) => {
  const b = new THREE.Bone();
  b.name = name;
  b.position.set(x, y, z);
  parent?.add(b);
  return b;
};

/** Skinned to the head: a geometry's vertices, all of their weight on `skeleton.bones[0]`. */
function headMesh(geometry, skeleton) {
  const n = geometry.attributes.position.count;
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(n * 4), 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(n * 4).map((_, i) => (i % 4 ? 0 : 1)), 4));
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
  mesh.bind(skeleton);
  return mesh;
}

function avatar() {
  const armature = new THREE.Group();
  const hips = bone('Hips', 0, 1, 0, armature);
  const head = bone('Head', 0, 0.6, 0, hips); // at 1.6 m
  bone('HeadTop_End', 0, 0.2, 0, head);
  const shoulder = bone('LeftArm', 0.18, 0.45, 0, hips); // at 1.45 m
  const elbow = bone('LeftForeArm', 0, 0.28, 0, shoulder); // the arm straight up
  const wrist = bone('LeftHand', 0, 0.25, 0, elbow);
  for (const f of ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']) {
    let at = wrist;
    for (const n of [1, 2, 3]) at = bone(`LeftHand${f}${n}`, 0, n === 1 ? 0.08 : 0.03, 0, at);
  }
  // The forearm across to the left, the hand into the head.
  elbow.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
  armature.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton([head]);
  const skull = new THREE.SphereGeometry(0.1, 24, 16).translate(0, 1.7, 0); // 1.6 to 1.8 m
  const hair = new THREE.CylinderGeometry(0.12, 0.12, 0.3, 16, 4).translate(0, 1.45, -0.05); // down to the shoulders
  armature.add(headMesh(skull, skeleton), headMesh(hair, skeleton));
  return { armature, head, shoulder, elbow, wrist };
}

test("the head's shape is the avatar's own, down to the chin (not the hair on the shoulders)", () => {
  const { armature } = avatar();
  const s = headShape(armature);
  assert.equal(s.bone.name, 'Head');
  const reach = (x, y, z) => s.reach(new THREE.Vector3(x, y, z).normalize());
  assert.ok(s.center.y > 0.07 && s.center.y < 0.11, `its middle is the skull's (${s.center.y})`);
  assert.ok(reach(0, 1, 0) > 0.1 && reach(0, 1, 0) < 0.16, `up to the top of the head, and a hand's room (${reach(0, 1, 0)})`);
  assert.ok(reach(1, 0, 0) > 0.12 && reach(1, 0, 0) < 0.19, `out to the hair at the side (${reach(1, 0, 0)})`);
  assert.ok(reach(0, -1, 0) < 0.19, `not down to the hair on the shoulders (${reach(0, -1, 0)})`);
  assert.equal(headShape(new THREE.Group()), null, 'no head, no shape');
});

test('a hand in the head is swung out from the shoulder until it is clear; clear hands are left alone', () => {
  const { armature, shoulder, elbow, wrist } = avatar();
  const guard = keepClear(armature);
  assert.equal(guard.arms, 1);
  assert.ok(guard.inHead(), 'the hand starts in the head');
  const at = (o) => o.getWorldPosition(new THREE.Vector3());
  const shoulderAt = at(shoulder);
  const bend = elbow.quaternion.clone();
  assert.ok(guard.update() > 0);
  assert.ok(!guard.inHead(), 'and ends clear of it');
  assert.ok(at(shoulder).distanceTo(shoulderAt) < 1e-9, 'the shoulder stays where it is');
  assert.ok(elbow.quaternion.equals(bend), 'the elbow keeps its bend: the whole arm swings');
  assert.ok(at(wrist).distanceTo(new THREE.Vector3(0, 1.7, 0)) > 0.1, 'the wrist is out of the head');

  // Clear: nothing changes.
  const swung = shoulder.quaternion.clone();
  assert.equal(guard.update(), 0);
  assert.ok(shoulder.quaternion.equals(swung));
});

test('an avatar without the bones it needs is left as it is', () => {
  const armature = new THREE.Group();
  bone('Hips', 0, 1, 0, armature);
  const guard = keepClear(armature);
  assert.equal(guard.update(), 0);
  assert.equal(guard.arms, 0);
});
