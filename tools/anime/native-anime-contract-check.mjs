import assert from 'node:assert/strict';

import { nativeAnimeContract, validateShotAnim } from './native-anime-contract.mjs';

const base = {
  schema: 'makewatch.shotAnim/1',
  shotId: 'shot.slice.01',
  durationSeconds: 4,
  fps: 24,
  resolution: [1920, 1080],
  background: { color: [8, 10, 16] },
  layers: [
    { id: 'bg_far', part: 'plate', path: 'anime/slice/bg_far.png', z: 0, parallax: 0.15, pivot: [0.5, 0.5] },
    { id: 'bg_near', part: 'plate', path: 'anime/slice/bg_near.png', z: 1, parallax: 0.6, pivot: [0.5, 0.5] },
    { id: 'body', part: 'torso', path: 'anime/slice/body.png', z: 10, parallax: 1, pivot: [0.5, 0.9],
      curves: { breathe: [{ t: 0, v: 0 }, { t: 2, v: 1, ease: 'easeInOut' }, { t: 4, v: 0, ease: 'easeInOut' }] } },
    { id: 'eyes', part: 'eyes', path: 'anime/slice/eyes.png', z: 20, parallax: 1, pivot: [0.5, 0.5],
      curves: { blink: [{ t: 1.1, v: 1 }, { t: 3.0, v: 1 }], eyeLookX: [{ t: 0, v: 0 }, { t: 2, v: -0.8, ease: 'easeInOut' }] } },
    { id: 'mouth', part: 'mouth', path: 'anime/slice/mouth.png', z: 21, parallax: 1, pivot: [0.5, 0.1] },
    { id: 'front_hair', part: 'front_hair', path: 'anime/slice/hair.png', z: 30, parallax: 1, pivot: [0.5, 0.1],
      dynamic: { segments: 3, stiffness: 0.28, damping: 0.12, gravity: 0.6, maxDeg: 22 } },
  ],
  camera: { keyframes: [{ t: 0, x: 0, y: 0, zoom: 1 }, { t: 4, x: 0, y: -0.01, zoom: 1.05, ease: 'easeInOut' }] },
  dialogue: [{ id: 'dlg.01', startSeconds: 0.6, language: 'ja', audioPath: 'anime/slice/line.wav', alignmentPath: 'anime/slice/line.align.json', mouthSource: 'alignment' }],
  subtitles: [{ text: 'Yağmur yağıyor.', startSeconds: 0.6, endSeconds: 3.4, language: 'tr' }],
  grain: 0.04,
};

const ok = validateShotAnim(base);
assert.equal(ok.schema, 'makewatch.shotAnim/1');
assert.equal(ok.frameCount, 96, '4s @ 24fps -> 96 frames');
assert.equal(ok.layers.length, 6);
assert.equal(ok.layers[0].id, 'bg_far', 'layers sort by z');
assert.equal(ok.layers.at(-1).id, 'front_hair');
assert.ok(ok.layers.find((l) => l.id === 'front_hair').dynamic, 'dynamic chain preserved');
assert.equal(ok.dialogue[0].audioPath, 'anime/slice/line.wav');
assert.equal(ok.subtitles[0].endSeconds, 3.4);
assert.ok(Object.isFrozen(ok));
assert.deepEqual(ok.motion, [], 'motion defaults to empty');

// --- M5 Task 6: retargeted motion block ---
const motionSkeleton = {
  bones: [
    { id: 'hip', parent: null, rest: { x: 0, y: 0, rot: 0, len: 0 } },
    { id: 'thigh_l', parent: 'hip', rest: { x: 0, y: 0, rot: 0, len: 90 } },
    { id: 'shin_l', parent: 'thigh_l', rest: { x: 90, y: 0, rot: 0, len: 85 } },
    { id: 'foot_l', parent: 'shin_l', rest: { x: 85, y: 0, rot: 0, len: 25 } },
  ],
};
const withMotion = validateShotAnim({
  ...base,
  layers: [...base.layers, { id: 'aya.leg', part: 'thigh_l', path: 'anime/slice/leg.png', z: 15, bone: 'thigh_l', pivot: [0.5, 0.1] }],
  motion: [{
    characterId: 'character.aya',
    fps: 24,
    loop: true,
    skeleton: motionSkeleton,
    boneCurves: { thigh_l: [{ t: 0, v: -18 }, { t: 2, v: 22, ease: 'easeInOut' }, { t: 4, v: -18 }] },
    events: [{ t: 0, kind: 'footPlant', bone: 'foot_l' }, { t: 2, kind: 'footLift', bone: 'foot_l' }],
    rootMotion: [{ t: 0, x: 0, y: 0 }, { t: 4, x: 58, y: 0 }],
  }],
});
assert.equal(withMotion.motion.length, 1);
assert.equal(withMotion.motion[0].loop, true);
assert.equal(withMotion.motion[0].boneCurves.thigh_l.length, 3);
assert.equal(withMotion.motion[0].events[1].kind, 'footLift');
assert.equal(withMotion.layers.find((l) => l.id === 'aya.leg').bone, 'thigh_l');
// dialogue / eyes / mouth still intact alongside motion
assert.equal(withMotion.dialogue[0].mouthSource, 'alignment');
assert.ok(withMotion.layers.find((l) => l.part === 'mouth'));

assert.throws(
  () => validateShotAnim({ ...base, motion: [{ characterId: 'x', skeleton: motionSkeleton, boneCurves: { tail: [{ t: 0, v: 0 }] } }] }),
  /bone tail not in the skeleton/,
);
assert.throws(
  () => validateShotAnim({ ...base, motion: [{ characterId: 'x', skeleton: { bones: [{ id: 'a', parent: 'b', rest: {} }, { id: 'b', parent: 'a', rest: {} }] }, boneCurves: {} }] }),
  /cycle|exactly one root/,
);
assert.throws(
  () => validateShotAnim({ ...base, motion: [{ characterId: 'x', skeleton: motionSkeleton, boneCurves: {}, events: [{ t: 0, kind: 'nope' }] }] }),
  /events\[0\]\.kind is unknown/,
);

const rejects = [
  [{ ...base, schema: 'nope' }, /schema must be/],
  [{ ...base, durationSeconds: 0 }, /durationSeconds must be 1\.\.20/],
  [{ ...base, durationSeconds: 999 }, /durationSeconds must be 1\.\.20/],
  [{ ...base, fps: 4 }, /fps must be 12\.\.60/],
  [{ ...base, resolution: [1921, 1080] }, /resolution must be even/],
  [{ ...base, resolution: [1920] }, /resolution must be \[width, height\]/],
  [{ ...base, layers: [] }, /layers must contain 1\.\.64/],
  [{ ...base, layers: [{ part: 'torso', path: '/etc/passwd' }] }, /must be a project-relative path/],
  [{ ...base, layers: [{ part: 'torso', path: '../../secret.png' }] }, /must not contain path traversal/],
  [{ ...base, layers: [{ part: 'torso', path: 'a.png', parallax: 9 }] }, /parallax must be 0\.\.4/],
  [{ ...base, subtitles: [{ text: 'x', startSeconds: 2, endSeconds: 1 }] }, /end must be after start/],
  [{ ...base, subtitles: [{ text: 'x', startSeconds: 5, endSeconds: 6 }] }, /does not overlap the shot/],
  [{ ...base, subtitles: [{ text: '  ', startSeconds: 0, endSeconds: 1 }] }, /text is empty/],
  [{ ...base, camera: { keyframes: [{ t: 0, x: Number.NaN }] } }, /camera\.keyframes\[0\]\.x must be a finite number/],
  [{ ...base, layers: [{ part: 'front_hair', path: 'a.png', dynamic: { stiffness: Number.NaN } }] }, /dynamic\.stiffness must be a finite number/],
  [{ ...base, dialogue: [base.dialogue[0], { ...base.dialogue[0], id: 'dlg.02' }] }, /too many units/],
  [{ ...base, layers: [{ part: 'torso', path: 'a.png', curves: { x: [{ t: 1, v: 0 }, { t: 0, v: 1 }] } }] }, /sorted by t/],
  [{ ...base, camera: { keyframes: [{ t: 3 }, { t: 1 }] } }, /camera.keyframes must be sorted/],
];
for (const [value, pattern] of rejects) {
  assert.throws(() => validateShotAnim(value), pattern, `expected rejection: ${pattern}`);
}

assert.deepEqual(nativeAnimeContract.strategies, ['I2V']);
assert.equal(nativeAnimeContract.residentVideoModel, false);
assert.equal(nativeAnimeContract.persistsIntermediateFrames, false);

console.log('native anime contract checks passed');
