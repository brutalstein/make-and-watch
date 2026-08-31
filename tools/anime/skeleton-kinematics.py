"""Deterministic 2D skeletal kinematics for the Native Anime Motion Engine.

Byte-for-byte mirror of `skeleton-kinematics.mjs`. Convention: a bone's world frame
is `parentWorld @ T(rest.x, rest.y) @ R(rest.rot + animDeg)`; a child at its parent's
tip authors `rest.x = parentRestLen`. Angles are degrees, rotation `[cos -sin; sin cos]`.
Pure `math` (IEEE-754 float, same as JS `number`); fixed iteration counts; no RNG.
"""
from __future__ import annotations

import math

DEG = math.pi / 180.0
FABRIK_ITERATIONS = 16
FABRIK_TOLERANCE = 1e-7
REACH_EPSILON = 1e-6


def _rotate(deg):
    r = deg * DEG
    c, s = math.cos(r), math.sin(r)
    return (c, -s, 0.0, s, c, 0.0)


def _translate(x, y):
    return (1.0, 0.0, x, 0.0, 1.0, y)


def _mul(a, b):
    return (
        a[0] * b[0] + a[1] * b[3],
        a[0] * b[1] + a[1] * b[4],
        a[0] * b[2] + a[1] * b[5] + a[2],
        a[3] * b[0] + a[4] * b[3],
        a[3] * b[1] + a[4] * b[4],
        a[3] * b[2] + a[4] * b[5] + a[5],
    )


def _apply(m, x, y):
    return (m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5])


def _world_angle_deg(m):
    return math.atan2(m[3], m[0]) / DEG


def forward_kinematics(skeleton, anim_deg_by_bone=None, root_transform=None):
    """`skeleton['bones']` must be topologically ordered. Returns a dict keyed by bone
    id: `{ 'origin': (x, y), 'tip': (x, y), 'worldDeg': float }`."""
    anim_deg_by_bone = anim_deg_by_bone or {}
    world = {}
    base = root_transform if root_transform is not None else (1.0, 0.0, 0.0, 0.0, 1.0, 0.0)
    joints = {}
    for bone in skeleton["bones"]:
        parent = bone["parent"]
        parent_world = base if parent is None else world.get(parent)
        if parent_world is None:
            raise ValueError(f"skeleton not topologically ordered: {bone['id']} before parent {parent}")
        anim = float(anim_deg_by_bone.get(bone["id"], 0.0))
        rest = bone["rest"]
        local = _mul(_translate(rest["x"], rest["y"]), _rotate(rest["rot"] + anim))
        m = _mul(parent_world, local)
        world[bone["id"]] = m
        joints[bone["id"]] = {
            "origin": _apply(m, 0.0, 0.0),
            "tip": _apply(m, rest["len"], 0.0),
            "worldDeg": _world_angle_deg(m),
        }
    return joints


def _clamp(value, lo, hi):
    return min(hi, max(lo, value))


def _dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def solve_two_bone_ik(root_pos, upper_len, lower_len, target_pos, bend=1):
    """Analytic two-bone IK. Returns `{ 'upperWorldDeg', 'lowerRelDeg', 'reached' }`."""
    sign = -1.0 if bend < 0 else 1.0
    dx = target_pos[0] - root_pos[0]
    dy = target_pos[1] - root_pos[1]
    raw_dist = math.hypot(dx, dy)
    min_reach = abs(upper_len - lower_len) + REACH_EPSILON
    max_reach = upper_len + lower_len
    d = _clamp(raw_dist, min_reach, max_reach)
    reached = (raw_dist >= min_reach - REACH_EPSILON) and (raw_dist <= max_reach + REACH_EPSILON)

    to_target = math.atan2(dy, dx) / DEG
    cos_shoulder = _clamp((upper_len * upper_len + d * d - lower_len * lower_len) / (2 * upper_len * d), -1.0, 1.0)
    shoulder = (math.acos(cos_shoulder) / DEG) * sign
    cos_elbow = _clamp((upper_len * upper_len + lower_len * lower_len - d * d) / (2 * upper_len * lower_len), -1.0, 1.0)
    elbow_interior = math.acos(cos_elbow) / DEG

    return {
        "upperWorldDeg": to_target - shoulder,
        "lowerRelDeg": sign * (180.0 - elbow_interior),
        "reached": reached,
    }


def solve_fabrik(points, lengths, target_pos, iterations=FABRIK_ITERATIONS):
    """FABRIK for an N-segment chain. `points[0]` is pinned; segment lengths preserved."""
    p = [[float(pt[0]), float(pt[1])] for pt in points]
    n = len(p)
    if len(lengths) != n - 1:
        raise ValueError("solve_fabrik: lengths must be len(points) - 1")
    total_length = sum(lengths)
    root = [p[0][0], p[0][1]]

    if _dist(root, target_pos) > total_length:
        for i in range(n - 1):
            r = _dist(p[i], target_pos) or 1.0
            lam = lengths[i] / r
            p[i + 1] = [
                (1 - lam) * p[i][0] + lam * target_pos[0],
                (1 - lam) * p[i][1] + lam * target_pos[1],
            ]
        return p

    for _ in range(iterations):
        if _dist(p[n - 1], target_pos) < FABRIK_TOLERANCE:
            break
        p[n - 1] = [float(target_pos[0]), float(target_pos[1])]
        for i in range(n - 2, -1, -1):
            r = _dist(p[i + 1], p[i]) or 1.0
            lam = lengths[i] / r
            p[i] = [
                (1 - lam) * p[i + 1][0] + lam * p[i][0],
                (1 - lam) * p[i + 1][1] + lam * p[i][1],
            ]
        p[0] = [root[0], root[1]]
        for i in range(n - 1):
            r = _dist(p[i + 1], p[i]) or 1.0
            lam = lengths[i] / r
            p[i + 1] = [
                (1 - lam) * p[i][0] + lam * p[i + 1][0],
                (1 - lam) * p[i][1] + lam * p[i + 1][1],
            ]
    return p


def solve_foot_lock(hip_pos, thigh_len, shin_len, plant_ankle_pos, bend=1):
    """Solve a hip->ankle chain so the planted ankle stays fixed."""
    solved = solve_two_bone_ik(hip_pos, thigh_len, shin_len, plant_ankle_pos, bend)
    return {
        "thighWorldDeg": solved["upperWorldDeg"],
        "shinRelDeg": solved["lowerRelDeg"],
        "reached": solved["reached"],
    }


def centre_of_mass_x(points, weights=None):
    w = weights if weights is not None else [1.0] * len(points)
    total = sum(w)
    if total == 0:
        return 0.0
    return sum(points[i][0] * w[i] for i in range(len(points))) / total


SKELETON_KINEMATICS_LIMITS = {
    "fabrikIterations": FABRIK_ITERATIONS,
    "fabrikTolerance": FABRIK_TOLERANCE,
    "reachEpsilon": REACH_EPSILON,
}
