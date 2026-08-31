"""Python-side parity test for skeleton-kinematics.py against the shared fixture.

Asserts the same solved joint positions as skeleton-kinematics-check.mjs so the
JS compiler path and the Python worker path stay bit-compatible. Pure `math`
(no numpy) so it runs inside anime:m5-check.
"""
from __future__ import annotations

import json
import math
import pathlib
import runpy

_HERE = pathlib.Path(__file__).parent
_KIN = runpy.run_path(str(_HERE / "skeleton-kinematics.py"))
forward_kinematics = _KIN["forward_kinematics"]
solve_two_bone_ik = _KIN["solve_two_bone_ik"]
solve_fabrik = _KIN["solve_fabrik"]
solve_foot_lock = _KIN["solve_foot_lock"]
centre_of_mass_x = _KIN["centre_of_mass_x"]
SKELETON_KINEMATICS_LIMITS = _KIN["SKELETON_KINEMATICS_LIMITS"]

FIXTURE = json.loads((_HERE / "skeleton-kinematics-fixture.json").read_text(encoding="utf-8"))
TOL = FIXTURE["tolerance"]


def near(actual, expected, tol, label):
    assert abs(actual - expected) <= tol, f"{label}: expected ~{expected}, got {actual}"


joints = forward_kinematics(FIXTURE["fkSkeleton"], FIXTURE["fkAnim"])
for bone_id, expected in FIXTURE["fkExpected"].items():
    near(joints[bone_id]["origin"][0], expected["origin"][0], TOL, f"{bone_id}.origin.x")
    near(joints[bone_id]["origin"][1], expected["origin"][1], TOL, f"{bone_id}.origin.y")
    near(joints[bone_id]["tip"][0], expected["tip"][0], TOL, f"{bone_id}.tip.x")
    near(joints[bone_id]["tip"][1], expected["tip"][1], TOL, f"{bone_id}.tip.y")
    near(joints[bone_id]["worldDeg"], expected["worldDeg"], TOL, f"{bone_id}.worldDeg")

try:
    forward_kinematics({"bones": [FIXTURE["fkSkeleton"]["bones"][1], FIXTURE["fkSkeleton"]["bones"][0]]}, {})
    raise AssertionError("expected out-of-order skeleton to raise")
except ValueError as error:
    assert "topologically ordered" in str(error)

for case in FIXTURE["ikCases"]:
    result = solve_two_bone_ik(case["root"], case["upper"], case["lower"], case["target"], case["bend"])
    near(result["upperWorldDeg"], case["expect"]["upperWorldDeg"], TOL, "ik.upperWorldDeg")
    near(result["lowerRelDeg"], case["expect"]["lowerRelDeg"], TOL, "ik.lowerRelDeg")
    assert result["reached"] is case["expect"]["reached"], "ik.reached"

case = FIXTURE["ikCases"][2]
solved = solve_two_bone_ik(case["root"], case["upper"], case["lower"], case["target"], case["bend"])
upper_rad = math.radians(solved["upperWorldDeg"])
elbow = (case["root"][0] + math.cos(upper_rad) * case["upper"], case["root"][1] + math.sin(upper_rad) * case["upper"])
lower_rad = math.radians(solved["upperWorldDeg"] + solved["lowerRelDeg"])
end = (elbow[0] + math.cos(lower_rad) * case["lower"], elbow[1] + math.sin(lower_rad) * case["lower"])
near(end[0], case["target"][0], 1e-6, "ik end effector x")
near(end[1], case["target"][1], 1e-6, "ik end effector y")

fab = FIXTURE["fabrik"]
solved = solve_fabrik(fab["points"], fab["lengths"], fab["target"])
near(solved[-1][0], fab["expectLast"][0], FIXTURE["fabrikTolerance"], "fabrik last x")
near(solved[-1][1], fab["expectLast"][1], FIXTURE["fabrikTolerance"], "fabrik last y")
for i, length in enumerate(fab["lengths"]):
    seg = math.hypot(solved[i + 1][0] - solved[i][0], solved[i + 1][1] - solved[i][1])
    near(seg, length, 1e-6, f"fabrik segment {i} length")
near(solved[0][0], fab["points"][0][0], 1e-9, "fabrik root x")
near(solved[0][1], fab["points"][0][1], 1e-9, "fabrik root y")
far = solve_fabrik(fab["points"], fab["lengths"], [1000, 0])
for i, length in enumerate(fab["lengths"]):
    seg = math.hypot(far[i + 1][0] - far[i][0], far[i + 1][1] - far[i][1])
    near(seg, length, 1e-9, f"fabrik far segment {i}")
near(far[3][1], 0, 1e-9, "fabrik far collinear")

fl = FIXTURE["footLock"]
solved = solve_foot_lock(fl["hip"], fl["thigh"], fl["shin"], fl["plantAnkle"], fl["bend"])
assert solved["reached"] is fl["expectReached"], "footLock.reached"
thigh_rad = math.radians(solved["thighWorldDeg"])
knee = (fl["hip"][0] + math.cos(thigh_rad) * fl["thigh"], fl["hip"][1] + math.sin(thigh_rad) * fl["thigh"])
shin_rad = math.radians(solved["thighWorldDeg"] + solved["shinRelDeg"])
ankle = (knee[0] + math.cos(shin_rad) * fl["shin"], knee[1] + math.sin(shin_rad) * fl["shin"])
near(ankle[0], fl["plantAnkle"][0], 1e-6, "footLock ankle x pinned")
near(ankle[1], fl["plantAnkle"][1], 1e-6, "footLock ankle y pinned")

near(centre_of_mass_x(FIXTURE["com"]["points"]), FIXTURE["com"]["expectX"], TOL, "com x")
near(centre_of_mass_x([[0, 0], [10, 0]], [3, 1]), 2.5, TOL, "com weighted x")

assert SKELETON_KINEMATICS_LIMITS["fabrikIterations"] == 16

print("skeleton kinematics self-test: passed")
