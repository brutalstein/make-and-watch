import assert from 'node:assert/strict';

import { motionClipLimits, normalizeMotionClipInput, validateMotionClip } from './motion-clip-contract.mjs';

const walkSkeleton = {
  bones: [
    { id: 'root', parent: null, rest: { x: 0, y: 0, rot: 0, len: 0 } },
    { id: 'hip', parent: 'root', rest: { x: 0, y: -4, rot: 0, len: 40 } },
    { id: 'thigh_l', parent: 'hip', rest: { x: 0, y: 0, rot: 0, len: 90 } },
    { id: 'shin_l', parent: 'thigh_l', rest: { x: 0, y: 0, rot: 0, len: 85 } },
    { id: 'foot_l', parent: 'shin_l', rest: { x: 0, y: 0, rot: 0, len: 30 } },
    { id: 'thigh_r', parent: 'hip', rest: { x: 0, y: 0, rot: 0, len: 90 } },
    { id: 'shin_r', parent: 'thigh_r', rest: { x: 0, y: 0, rot: 0, len: 85 } },
    { id: 'foot_r', parent: 'shin_r', rest: { x: 0, y: 0, rot: 0, len: 30 } },
  ],
};

const walk = {
  clipId: 'walk.neutral.loop',
  fps: 24,
  frameCount: 24,
  loopable: true,
  skeleton: walkSkeleton,
  channels: {
    bone: {
      thigh_l: [{ f: 0, deg: -18 }, { f: 12, deg: 22, ease: 'easeInOut' }, { f: 23, deg: -18 }],
      thigh_r: [{ f: 0, deg: 22 }, { f: 12, deg: -18, ease: 'easeInOut' }, { f: 23, deg: 22 }],
      shin_l: [{ f: 0, deg: 5 }, { f: 6, deg: 40 }, { f: 12, deg: 2 }],
    },
    param: { breathing: [{ f: 0, v: 0 }, { f: 12, v: 1 }, { f: 23, v: 0 }] },
  },
  events: [
    { f: 12, kind: 'footPlant', bone: 'foot_l' },
    { f: 0, kind: 'footPlant', bone: 'foot_r' },
    { f: 6, kind: 'footLift', bone: 'foot_r' },
  ],
  rootMotion: [{ f: 0, x: 0, y: 0 }, { f: 23, x: 62, y: 0 }],
};

const clip = normalizeMotionClipInput(walk);
assert.equal(clip.schema, motionClipLimits.schema);
assert.equal(clip.clipId, 'walk.neutral.loop');
assert.equal(clip.frameCount, 24);
assert.equal(clip.durationSeconds, 1);
assert.equal(clip.loopable, true);
const order = clip.skeleton.bones.map((bone) => bone.id);
assert.ok(order.indexOf('hip') < order.indexOf('thigh_l'));
assert.ok(order.indexOf('thigh_l') < order.indexOf('shin_l'));
assert.deepEqual(clip.events.map((event) => event.f), [0, 6, 12]);
assert.equal(clip.channels.bone.thigh_l.length, 3);

assert.throws(() => validateMotionClip(walk), /schema must be/);
assert.equal(validateMotionClip({ ...walk, schema: motionClipLimits.schema }).clipId, 'walk.neutral.loop');

assert.throws(
  () => normalizeMotionClipInput({ ...walk, channels: { bone: { elbow_x: [{ f: 0, deg: 0 }] } } }),
  /not in the skeleton/,
);
assert.throws(
  () => normalizeMotionClipInput({ ...walk, channels: { ...walk.channels, bone: { thigh_l: [{ f: 5, deg: 0 }, { f: 5, deg: 1 }] } } }),
  /strictly increasing/,
);
assert.throws(
  () => normalizeMotionClipInput({ ...walk, channels: { ...walk.channels, bone: { thigh_l: [{ f: 40, deg: 0 }] } } }),
  /thigh_l\[0\]\.f must be a finite number in 0\.\.23/,
);
assert.throws(
  () => normalizeMotionClipInput({ ...walk, skeleton: { bones: [...walkSkeleton.bones, walkSkeleton.bones[1]] } }),
  /unique/,
);
assert.throws(
  () => normalizeMotionClipInput({ ...walk, skeleton: { bones: [
    { id: 'root', parent: null, rest: {} },
    { id: 'root2', parent: null, rest: {} },
  ] } }),
  /exactly one root/,
);
assert.throws(
  () => normalizeMotionClipInput({ ...walk, skeleton: { bones: [
    { id: 'a', parent: 'b', rest: {} },
    { id: 'b', parent: 'a', rest: {} },
  ] } }),
  /cycle|exactly one root/,
);
assert.throws(
  () => normalizeMotionClipInput({ ...walk, events: [{ f: 0, kind: 'contact', bone: 'tail' }] }),
  /not in the skeleton/,
);
assert.throws(
  () => normalizeMotionClipInput({ ...walk, events: [{ f: 0, kind: 'footPlant' }] }),
  /requires a bone/,
);
assert.throws(() => normalizeMotionClipInput({ ...walk, fps: 240 }), /fps/);
assert.throws(() => normalizeMotionClipInput({ ...walk, frameCount: 0 }), /frameCount/);
assert.throws(() => normalizeMotionClipInput({ ...walk, channels: { bone: {}, param: {} } }), /at least one/);
assert.throws(
  () => normalizeMotionClipInput({ ...walk, rootMotion: [{ f: 5, x: 0, y: 0 }, { f: 5, x: 1, y: 0 }] }),
  /strictly increase/,
);

assert.equal(
  JSON.stringify(normalizeMotionClipInput(walk)),
  JSON.stringify(normalizeMotionClipInput(structuredClone(walk))),
);
const shuffled = normalizeMotionClipInput({
  ...walk,
  channels: { ...walk.channels, bone: { thigh_r: walk.channels.bone.thigh_r, thigh_l: walk.channels.bone.thigh_l, shin_l: walk.channels.bone.shin_l } },
});
assert.deepEqual(Object.keys(shuffled.channels.bone), ['shin_l', 'thigh_l', 'thigh_r']);

console.log('motion clip contract check: passed');
