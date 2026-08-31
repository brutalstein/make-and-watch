import assert from 'node:assert/strict';

import { validateMotionClip } from './motion-clip-contract.mjs';
import { forwardKinematics } from './skeleton-kinematics.mjs';
import { retargetMotionClip } from './motion-retarget.mjs';

function near(actual, expected, tol, label) {
  assert.ok(Math.abs(actual - expected) <= tol, `${label}: expected ~${expected}, got ${actual}`);
}

// --- source clip: single planted foot, thigh/shin sweep, breath param, root travel ---
const clip = validateMotionClip({
  schema: 'makewatch.motionClip/1',
  clipId: 'test-step',
  fps: 24,
  frameCount: 12,
  skeleton: {
    bones: [
      { id: 'hip', parent: null, rest: { x: 0, y: 0, rot: 0, len: 0 } },
      { id: 'thigh_l', parent: 'hip', rest: { x: 0, y: 0, rot: 0, len: 100 } },
      { id: 'shin_l', parent: 'thigh_l', rest: { x: 100, y: 0, rot: 0, len: 100 } },
      { id: 'foot_l', parent: 'shin_l', rest: { x: 100, y: 0, rot: 0, len: 20 } },
    ],
  },
  channels: {
    bone: {
      thigh_l: [{ f: 0, deg: 0 }, { f: 11, deg: 20 }],
      shin_l: [{ f: 0, deg: 0 }, { f: 11, deg: -10 }],
    },
    param: { breath: [{ f: 0, v: 0 }, { f: 11, v: 1 }] },
  },
  events: [
    { f: 0, kind: 'footPlant', bone: 'foot_l' },
    { f: 6, kind: 'footLift', bone: 'foot_l' },
    { f: 8, kind: 'contact' },
  ],
  rootMotion: [{ f: 0, x: 0, y: 0 }, { f: 11, x: 100, y: 0 }],
});

// target rig: same topology, limbs 1.5x longer
const rigTarget = {
  characterId: 'char-1',
  characterRevision: 7,
  skeleton: {
    bones: [
      { id: 'hip', parent: null, rest: { x: 0, y: 0, rot: 0, len: 0 } },
      { id: 'thigh_l', parent: 'hip', rest: { x: 0, y: 0, rot: 0, len: 150 } },
      { id: 'shin_l', parent: 'thigh_l', rest: { x: 150, y: 0, rot: 0, len: 150 } },
      { id: 'foot_l', parent: 'shin_l', rest: { x: 150, y: 0, rot: 0, len: 30 } },
    ],
  },
  validDomain: { 'bone.thigh_l': [-45, 45] },
};

const baked = retargetMotionClip({ clip, targetRig: rigTarget, options: {} });

// shape
assert.equal(baked.characterId, 'char-1');
assert.equal(baked.clipId, 'test-step');
near(baked.durationSeconds, 0.5, 1e-9, 'durationSeconds');
assert.equal(baked.boneCurves.thigh_l.length, 12, 'one bone key per frame');
assert.equal(baked.boneCurves.shin_l.length, 12);
assert.ok(!('foot_l' in baked.boneCurves), 'unchannelled bone stays absent');

// foot-lock: planted ankle must not slide across frames 0..6 (leg-scaled plant point)
const legScale = 1.5;
const plantWorldX = 200 * legScale; // source foot_l origin [200,0] scaled
for (let f = 0; f <= 6; f += 1) {
  const pose = { thigh_l: baked.boneCurves.thigh_l[f].deg, shin_l: baked.boneCurves.shin_l[f].deg };
  const ankle = forwardKinematics(rigTarget.skeleton, pose).foot_l.origin;
  near(ankle[0], plantWorldX, 1e-3, `foot-lock ankle x @f${f}`);
  near(ankle[1], 0, 1e-3, `foot-lock ankle y @f${f}`);
}
// after footLift the foot is free to travel
{
  const pose = { thigh_l: baked.boneCurves.thigh_l[11].deg, shin_l: baked.boneCurves.shin_l[11].deg };
  const ankle = forwardKinematics(rigTarget.skeleton, pose).foot_l.origin;
  assert.ok(Math.abs(ankle[0] - plantWorldX) > 1, 'ankle moves once lifted');
}

// params pass straight through, retimed
near(baked.paramCurves.breath[0].t, 0, 1e-9, 'breath t0');
near(baked.paramCurves.breath[1].t, 11 / 24, 1e-6, 'breath t1');
assert.equal(baked.paramCurves.breath[1].v, 1);

// events -> seconds, bones kept when present in target
assert.deepEqual(baked.events[0], { t: 0, kind: 'footPlant', bone: 'foot_l' });
near(baked.events[1].t, 6 / 24, 1e-6, 'footLift t');
assert.equal(baked.events[2].kind, 'contact');
assert.ok(!('bone' in baked.events[2]), 'bone-less event stays bone-less');

// rootMotion scaled by leg length + COM shift
assert.equal(baked.rootMotion.length, 2);
assert.equal(baked.rootMotion[0].t, 0);
assert.ok(Number.isFinite(baked.rootMotion[1].x), 'rootMotion x finite');
near(baked.rootMotion[1].t, 11 / 24, 1e-6, 'rootMotion t1');

// domain inside [-45,45] -> no escalation
assert.equal(baked.domainEscalations.length, 0, 'thigh stays in domain');

// tight domain -> every out-of-range frame escalates
const rigTight = { ...rigTarget, validDomain: { 'bone.thigh_l': [-5, 5] } };
const tight = retargetMotionClip({ clip, targetRig: rigTight, options: {} });
// frames 0..6 the thigh is foot-locked to ~0; frames 7..11 raw sweep 12.7..20 -> 5 escalations
assert.equal(tight.domainEscalations.length, 5, 'tight-domain escalations');
assert.ok(tight.domainEscalations.every((e) => e.channel === 'bone.thigh_l'));
assert.deepEqual(tight.domainEscalations.map((e) => e.frame), [7, 8, 9, 10, 11]);

// validDomain.combined rules are parsed, not skipped
const rigCombined = {
  ...rigTarget,
  validDomain: {},
  validDomainCombined: [{ if: { shin_l: ['<', -3] }, then: { thigh_l: [30, 90] } }],
};
const combined = retargetMotionClip({ clip, targetRig: rigCombined, options: {} });
assert.equal(combined.domainEscalations.length, 5, 'combined-rule escalations');
assert.ok(combined.domainEscalations.every((e) => e.channel === 'combined.thigh_l'));

// missing target bone -> note + channel dropped, events for absent bones dropped
const rigMinimal = {
  characterId: 'char-2',
  skeleton: {
    bones: [
      { id: 'hip', parent: null, rest: { x: 0, y: 0, rot: 0, len: 0 } },
      { id: 'thigh_l', parent: 'hip', rest: { x: 0, y: 0, rot: 0, len: 150 } },
    ],
  },
};
const minimal = retargetMotionClip({ clip, targetRig: rigMinimal, options: {} });
assert.ok(minimal.notes.some((n) => n.code === 'missing_bone' && n.bone === 'shin_l'));
assert.ok(!('shin_l' in minimal.boneCurves));
assert.ok(minimal.notes.some((n) => n.code === 'event_bone_dropped' && n.bone === 'foot_l'));
assert.ok(minimal.events.every((e) => !('bone' in e)), 'dropped-bone events lose their bone');

// timeScale stretches time uniformly
const slow = retargetMotionClip({ clip, targetRig: rigTarget, options: { timeScale: 2 } });
near(slow.durationSeconds, 1.0, 1e-9, 'timeScale duration');
near(slow.events[1].t, 12 / 24, 1e-6, 'timeScale event t');

// deterministic: identical input -> identical bytes
assert.equal(
  JSON.stringify(retargetMotionClip({ clip, targetRig: rigTarget, options: {} })),
  JSON.stringify(retargetMotionClip({ clip, targetRig: rigTarget, options: {} })),
);

// guards
assert.throws(() => retargetMotionClip({ clip, targetRig: {} }), /skeleton/);
assert.throws(() => retargetMotionClip({ clip: { schema: 'x' }, targetRig: rigTarget }), /MotionClip/);

console.log('motion retarget check: passed');
