// Deterministic 2D skeletal kinematics for the Native Anime Motion Engine.
//
// Convention: a bone's world frame is `parentWorld · T(rest.x, rest.y) · R(rest.rot + animDeg)`.
// A child that sits at its parent's tip authors `rest.x = parentRestLen`. Angles are
// degrees, rotation matrix `[cos -sin; sin cos]` (standard math frame; in the engine's
// y-down screen space a positive angle reads clockwise). No randomness, fixed
// iteration counts: identical inputs -> identical outputs, matched byte-for-byte by
// `skeleton-kinematics.py`.

const DEG = Math.PI / 180;
const FABRIK_ITERATIONS = 16;
const FABRIK_TOLERANCE = 1e-7;
const REACH_EPSILON = 1e-6;

function rot(deg) {
  const r = deg * DEG;
  return [Math.cos(r), -Math.sin(r), Math.sin(r), Math.cos(r)];
}

function mul2x3(a, b) {
  return [
    a[0] * b[0] + a[1] * b[3],
    a[0] * b[1] + a[1] * b[4],
    a[0] * b[2] + a[1] * b[5] + a[2],
    a[3] * b[0] + a[4] * b[3],
    a[3] * b[1] + a[4] * b[4],
    a[3] * b[2] + a[4] * b[5] + a[5],
  ];
}

function translate(x, y) { return [1, 0, x, 0, 1, y]; }
function rotate2x3(deg) { const [a, b, c, d] = rot(deg); return [a, b, 0, c, d, 0]; }
function apply(m, x, y) { return [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]]; }
function worldAngleDeg(m) { return Math.atan2(m[3], m[0]) / DEG; }

/**
 * Forward kinematics. `skeleton.bones` must be topologically ordered (parents first,
 * as `validateMotionClip` / the rig contract emit). Returns a plain object keyed by
 * bone id: `{ origin:[x,y], tip:[x,y], worldDeg }`.
 */
export function forwardKinematics(skeleton, animDegByBone = {}, rootTransform = null) {
  const world = new Map();
  const base = rootTransform ?? [1, 0, 0, 0, 1, 0];
  const joints = {};
  for (const bone of skeleton.bones) {
    const parentWorld = bone.parent === null ? base : world.get(bone.parent);
    if (!parentWorld) throw new Error(`skeleton not topologically ordered: ${bone.id} before parent ${bone.parent}`);
    const anim = Number(animDegByBone[bone.id] ?? 0);
    const local = mul2x3(translate(bone.rest.x, bone.rest.y), rotate2x3(bone.rest.rot + anim));
    const m = mul2x3(parentWorld, local);
    world.set(bone.id, m);
    joints[bone.id] = {
      origin: apply(m, 0, 0),
      tip: apply(m, bone.rest.len, 0),
      worldDeg: worldAngleDeg(m),
    };
  }
  return joints;
}

function clamp(value, lo, hi) { return Math.min(hi, Math.max(lo, value)); }
function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }

/**
 * Analytic two-bone IK. Given the chain root, the upper and lower segment lengths,
 * a world-space target and a bend sign (+1 / -1 picks the knee/elbow side), returns
 * `{ upperWorldDeg, lowerRelDeg, reached }`. An unreachable target extends the chain
 * straight at maximum length (`reached: false`).
 */
export function solveTwoBoneIK(rootPos, upperLen, lowerLen, targetPos, bend = 1) {
  const sign = bend < 0 ? -1 : 1;
  const dx = targetPos[0] - rootPos[0];
  const dy = targetPos[1] - rootPos[1];
  const rawDist = Math.hypot(dx, dy);
  const minReach = Math.abs(upperLen - lowerLen) + REACH_EPSILON;
  const maxReach = upperLen + lowerLen;
  const d = clamp(rawDist, minReach, maxReach);
  const reached = rawDist >= minReach - REACH_EPSILON && rawDist <= maxReach + REACH_EPSILON;

  const toTarget = Math.atan2(dy, dx) / DEG;
  const cosShoulder = clamp((upperLen * upperLen + d * d - lowerLen * lowerLen) / (2 * upperLen * d), -1, 1);
  const shoulder = (Math.acos(cosShoulder) / DEG) * sign;
  const cosElbow = clamp((upperLen * upperLen + lowerLen * lowerLen - d * d) / (2 * upperLen * lowerLen), -1, 1);
  const elbowInterior = Math.acos(cosElbow) / DEG;

  return {
    upperWorldDeg: toTarget - shoulder,
    lowerRelDeg: sign * (180 - elbowInterior),
    reached,
  };
}

/**
 * FABRIK for an N-segment chain. `points[0]` is pinned; the chain reaches toward
 * `targetPos`. Segment lengths are preserved exactly. Fixed iteration count.
 */
export function solveFabrik(points, lengths, targetPos, iterations = FABRIK_ITERATIONS) {
  const p = points.map((point) => [point[0], point[1]]);
  const n = p.length;
  if (lengths.length !== n - 1) throw new Error('solveFabrik: lengths must be points.length - 1');
  const totalLength = lengths.reduce((sum, value) => sum + value, 0);
  const root = [p[0][0], p[0][1]];

  if (dist(root, targetPos) > totalLength) {
    for (let i = 0; i < n - 1; i += 1) {
      const r = dist(p[i], targetPos) || 1;
      const lambda = lengths[i] / r;
      p[i + 1] = [
        (1 - lambda) * p[i][0] + lambda * targetPos[0],
        (1 - lambda) * p[i][1] + lambda * targetPos[1],
      ];
    }
    return p;
  }

  for (let iter = 0; iter < iterations; iter += 1) {
    if (dist(p[n - 1], targetPos) < FABRIK_TOLERANCE) break;
    p[n - 1] = [targetPos[0], targetPos[1]];
    for (let i = n - 2; i >= 0; i -= 1) {
      const r = dist(p[i + 1], p[i]) || 1;
      const lambda = lengths[i] / r;
      p[i] = [
        (1 - lambda) * p[i + 1][0] + lambda * p[i][0],
        (1 - lambda) * p[i + 1][1] + lambda * p[i][1],
      ];
    }
    p[0] = [root[0], root[1]];
    for (let i = 0; i < n - 1; i += 1) {
      const r = dist(p[i + 1], p[i]) || 1;
      const lambda = lengths[i] / r;
      p[i + 1] = [
        (1 - lambda) * p[i][0] + lambda * p[i + 1][0],
        (1 - lambda) * p[i][1] + lambda * p[i + 1][1],
      ];
    }
  }
  return p;
}

/**
 * Foot-lock: solve a hip->ankle two-bone chain so the planted ankle stays fixed
 * while the hip is wherever the body pose puts it. `bend` picks the knee side.
 * Returns `{ thighWorldDeg, shinRelDeg, reached }`.
 */
export function solveFootLock(hipPos, thighLen, shinLen, plantAnklePos, bend = 1) {
  const solved = solveTwoBoneIK(hipPos, thighLen, shinLen, plantAnklePos, bend);
  return { thighWorldDeg: solved.upperWorldDeg, shinRelDeg: solved.lowerRelDeg, reached: solved.reached };
}

/** Mass-weighted centre-of-mass x of a set of points. */
export function centreOfMassX(points, weights = null) {
  const w = weights ?? points.map(() => 1);
  let sum = 0;
  let total = 0;
  for (let i = 0; i < points.length; i += 1) {
    sum += points[i][0] * w[i];
    total += w[i];
  }
  return total === 0 ? 0 : sum / total;
}

export const skeletonKinematicsLimits = Object.freeze({
  fabrikIterations: FABRIK_ITERATIONS,
  fabrikTolerance: FABRIK_TOLERANCE,
  reachEpsilon: REACH_EPSILON,
});
