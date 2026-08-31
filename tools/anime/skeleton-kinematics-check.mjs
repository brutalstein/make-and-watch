import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  centreOfMassX,
  forwardKinematics,
  skeletonKinematicsLimits,
  solveFabrik,
  solveFootLock,
  solveTwoBoneIK,
} from './skeleton-kinematics.mjs';

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('./skeleton-kinematics-fixture.json', import.meta.url)), 'utf8'));
const TOL = fixture.tolerance;

function near(actual, expected, tol, label) {
  assert.ok(Math.abs(actual - expected) <= tol, `${label}: expected ~${expected}, got ${actual}`);
}

const joints = forwardKinematics(fixture.fkSkeleton, fixture.fkAnim);
for (const [id, expected] of Object.entries(fixture.fkExpected)) {
  near(joints[id].origin[0], expected.origin[0], TOL, `${id}.origin.x`);
  near(joints[id].origin[1], expected.origin[1], TOL, `${id}.origin.y`);
  near(joints[id].tip[0], expected.tip[0], TOL, `${id}.tip.x`);
  near(joints[id].tip[1], expected.tip[1], TOL, `${id}.tip.y`);
  near(joints[id].worldDeg, expected.worldDeg, TOL, `${id}.worldDeg`);
}

assert.throws(
  () => forwardKinematics({ bones: [fixture.fkSkeleton.bones[1], fixture.fkSkeleton.bones[0]] }, {}),
  /topologically ordered/,
);

for (const testCase of fixture.ikCases) {
  const result = solveTwoBoneIK(testCase.root, testCase.upper, testCase.lower, testCase.target, testCase.bend);
  near(result.upperWorldDeg, testCase.expect.upperWorldDeg, TOL, 'ik.upperWorldDeg');
  near(result.lowerRelDeg, testCase.expect.lowerRelDeg, TOL, 'ik.lowerRelDeg');
  assert.equal(result.reached, testCase.expect.reached, 'ik.reached');
}

{
  const testCase = fixture.ikCases[2];
  const solved = solveTwoBoneIK(testCase.root, testCase.upper, testCase.lower, testCase.target, testCase.bend);
  const upperRad = solved.upperWorldDeg * (Math.PI / 180);
  const elbow = [
    testCase.root[0] + Math.cos(upperRad) * testCase.upper,
    testCase.root[1] + Math.sin(upperRad) * testCase.upper,
  ];
  const lowerRad = (solved.upperWorldDeg + solved.lowerRelDeg) * (Math.PI / 180);
  const end = [elbow[0] + Math.cos(lowerRad) * testCase.lower, elbow[1] + Math.sin(lowerRad) * testCase.lower];
  near(end[0], testCase.target[0], 1e-6, 'ik end effector x');
  near(end[1], testCase.target[1], 1e-6, 'ik end effector y');
}

{
  const fab = fixture.fabrik;
  const solved = solveFabrik(fab.points, fab.lengths, fab.target);
  near(solved[solved.length - 1][0], fab.expectLast[0], fixture.fabrikTolerance, 'fabrik last x');
  near(solved[solved.length - 1][1], fab.expectLast[1], fixture.fabrikTolerance, 'fabrik last y');
  for (let i = 0; i < fab.lengths.length; i += 1) {
    const seg = Math.hypot(solved[i + 1][0] - solved[i][0], solved[i + 1][1] - solved[i][1]);
    near(seg, fab.lengths[i], 1e-6, `fabrik segment ${i} length`);
  }
  near(solved[0][0], fab.points[0][0], 1e-9, 'fabrik root x');
  near(solved[0][1], fab.points[0][1], 1e-9, 'fabrik root y');
  const far = solveFabrik(fab.points, fab.lengths, [1000, 0]);
  for (let i = 0; i < fab.lengths.length; i += 1) {
    const seg = Math.hypot(far[i + 1][0] - far[i][0], far[i + 1][1] - far[i][1]);
    near(seg, fab.lengths[i], 1e-9, `fabrik far segment ${i}`);
  }
  near(far[3][1], 0, 1e-9, 'fabrik far collinear');
}

{
  const fl = fixture.footLock;
  const solved = solveFootLock(fl.hip, fl.thigh, fl.shin, fl.plantAnkle, fl.bend);
  assert.equal(solved.reached, fl.expectReached, 'footLock.reached');
  const thighRad = solved.thighWorldDeg * (Math.PI / 180);
  const knee = [fl.hip[0] + Math.cos(thighRad) * fl.thigh, fl.hip[1] + Math.sin(thighRad) * fl.thigh];
  const shinRad = (solved.thighWorldDeg + solved.shinRelDeg) * (Math.PI / 180);
  const ankle = [knee[0] + Math.cos(shinRad) * fl.shin, knee[1] + Math.sin(shinRad) * fl.shin];
  near(ankle[0], fl.plantAnkle[0], 1e-6, 'footLock ankle x pinned');
  near(ankle[1], fl.plantAnkle[1], 1e-6, 'footLock ankle y pinned');
}

near(centreOfMassX(fixture.com.points), fixture.com.expectX, TOL, 'com x');
near(centreOfMassX([[0, 0], [10, 0]], [3, 1]), 2.5, TOL, 'com weighted x');

assert.equal(
  JSON.stringify(forwardKinematics(fixture.fkSkeleton, fixture.fkAnim)),
  JSON.stringify(forwardKinematics(fixture.fkSkeleton, fixture.fkAnim)),
);
assert.equal(skeletonKinematicsLimits.fabrikIterations, 16);

console.log('skeleton kinematics check: passed');
