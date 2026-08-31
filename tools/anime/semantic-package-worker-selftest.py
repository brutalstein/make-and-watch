"""Deterministic protocol self-test for tools/anime/semantic-package-worker.py.

Builds tiny synthetic RGBA fixtures (no ComfyUI), runs the worker's `character`
and `environment` QC operations and asserts:
  * a registered, in-register semantic state set passes;
  * a `face_base` with baked eyes fails the exclusion check;
  * a state sprite with a wide translucent halo fails the halo check;
  * mismatched environment plate canvases fail registration;
  * non-ascending plate depth fails ordering;
  * identical inputs produce byte-identical result JSON apart from the
    caller-supplied contact-sheet path.

Run:  python tools/anime/semantic-package-worker-selftest.py
Needs: numpy + Pillow.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

WORKER = Path(__file__).with_name("semantic-package-worker.py")
W, H = 256, 256
RESULT_PREFIX = "MW_SEMANTIC_QC_V1\t"

EYE_STATES = ("OPEN", "HALF", "CLOSED")
MOUTH_STATES = ("CLOSED", "SMALL", "A", "I", "U", "E", "O", "WIDE")

# Normalised regions face_base must leave transparent (eyes band + mouth).
EYE_RECT = [0.28, 0.40, 0.72, 0.55]
MOUTH_RECT = [0.42, 0.66, 0.58, 0.74]


def _canvas() -> Image.Image:
    return Image.new("RGBA", (W, H), (0, 0, 0, 0))


def _fill_rect(img: Image.Image, rect, rgba) -> Image.Image:
    x0, y0, x1, y1 = rect
    arr = np.asarray(img).copy()
    arr[int(y0 * H):int(y1 * H), int(x0 * W):int(x1 * W)] = rgba
    return Image.fromarray(arr, "RGBA")


def _ellipse(img: Image.Image, cx, cy, rx, ry, rgba, feather=0.0) -> Image.Image:
    ys, xs = np.mgrid[0:H, 0:W]
    d = ((xs - cx * W) / (rx * W)) ** 2 + ((ys - cy * H) / (ry * H)) ** 2
    arr = np.asarray(img).astype(np.float32)
    if feather <= 0:
        mask = (d <= 1.0).astype(np.float32)
    else:
        mask = np.clip((1.0 + feather - d) / max(feather, 1e-6), 0.0, 1.0)
    for c in range(3):
        arr[:, :, c] = arr[:, :, c] * (1 - mask) + rgba[c] * mask
    arr[:, :, 3] = np.maximum(arr[:, :, 3], mask * rgba[3])
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGBA")


def _skin_with_holes(bake_eyes: bool) -> Image.Image:
    img = _fill_rect(_canvas(), [0.20, 0.18, 0.80, 0.80], (238, 205, 180, 255))
    for rect in (EYE_RECT, MOUTH_RECT):
        img = _fill_rect(img, rect, (0, 0, 0, 0))
    if bake_eyes:
        img = _ellipse(img, 0.40, 0.47, 0.06, 0.04, (20, 40, 60, 255))
        img = _ellipse(img, 0.60, 0.47, 0.06, 0.04, (20, 40, 60, 255))
    return img


def _eye(side: str, state: str, halo: bool) -> Image.Image:
    cx = 0.40 if side == "eyes_l" else 0.60
    ry = {"OPEN": 0.040, "HALF": 0.022, "CLOSED": 0.006}[state]
    return _ellipse(_canvas(), cx, 0.47, 0.055, ry, (18, 44, 60, 255), feather=3.5 if halo else 0.0)


def _mouth(state: str) -> Image.Image:
    open_amt = {"CLOSED": 0.010, "SMALL": 0.020, "A": 0.045, "I": 0.028,
               "U": 0.026, "E": 0.036, "O": 0.042, "WIDE": 0.048}[state]
    return _ellipse(_canvas(), 0.50, 0.70, 0.05, open_amt, (150, 70, 70, 255))


def _blob(rect, rgba) -> Image.Image:
    return _fill_rect(_canvas(), rect, rgba)


def _write_character(root: Path, *, bake_eyes=False, halo=False) -> dict:
    root.mkdir(parents=True, exist_ok=True)
    files = {
        "body": _blob([0.30, 0.62, 0.70, 0.98], (120, 130, 150, 255)),
        "rear_hair": _blob([0.16, 0.12, 0.84, 0.72], (60, 42, 40, 255)),
        "front_hair": _blob([0.20, 0.12, 0.80, 0.34], (70, 50, 46, 255)),
        "face_base": _skin_with_holes(bake_eyes),
    }
    for side in ("eyes_l", "eyes_r"):
        for st in EYE_STATES:
            files[f"{side}.{st}"] = _eye(side, st, halo and side == "eyes_l" and st == "OPEN")
    for st in MOUTH_STATES:
        files[f"mouth.{st}"] = _mouth(st)
    states = []
    for name, img in files.items():
        path = root / f"{name}.png"
        img.save(path)
        part = name.split(".")[0] if "." in name else name
        states.append({"id": name, "semanticPart": part, "path": str(path), "pivot": [0.5, 0.5], "z": 0})
    return {
        "operation": "character",
        "canvas": {"width": W, "height": H},
        "states": states,
        "faceBaseExclusion": [EYE_RECT, MOUTH_RECT],
        "thresholds": {},
    }


def _write_environment(root: Path, *, bad_size=False, bad_depth=False) -> dict:
    root.mkdir(parents=True, exist_ok=True)
    specs = [("background", 0.10, (40, 46, 78)), ("midground", 0.45, (70, 60, 92)), ("foreground", 0.90, (30, 24, 36))]
    if bad_depth:
        specs = [("background", 0.60, specs[0][2]), ("midground", 0.20, specs[1][2]), ("foreground", 0.90, specs[2][2])]
    plates = []
    for role, depth, rgb in specs:
        size = (W, H) if not (bad_size and role == "midground") else (W - 8, H)
        img = Image.new("RGBA", size, (*rgb, 255))
        if role != "background":
            a = np.asarray(img).copy()
            a[: int(H * 0.30), :, 3] = 0
            img = Image.fromarray(a, "RGBA")
        path = root / f"plate_{role}.png"
        img.save(path)
        plates.append({"id": f"plate.{role}", "role": role, "path": str(path), "depth": depth})
    mask = np.zeros((H, W), np.uint8)
    mask[:, : W // 2] = 255
    mpath = root / "occlusion.png"
    Image.fromarray(mask, "L").save(mpath)
    return {
        "operation": "environment",
        "canvas": {"width": W, "height": H},
        "plates": plates,
        "occlusionMaskPath": str(mpath),
        "cameraSafeRegion": {"x": [0.06, 0.94], "y": [0.06, 0.94]},
        "thresholds": {},
    }


def run(request: dict, root: Path, sheet_name: str) -> dict:
    request = {**request, "contactSheet": str(root / sheet_name)}
    req_path = root / f"{sheet_name}.request.json"
    req_path.write_text(json.dumps(request), encoding="utf-8")
    proc = subprocess.run([sys.executable, str(WORKER), "--request", str(req_path)],
                          capture_output=True, text=True)
    assert proc.returncode == 0, f"worker exited {proc.returncode}\n{proc.stdout}\n{proc.stderr}"
    line = next((ln for ln in proc.stdout.splitlines() if ln.startswith(RESULT_PREFIX)), None)
    assert line, f"no result line\nstdout={proc.stdout}\nstderr={proc.stderr}"
    payload = json.loads(line.split("\t", 1)[1])
    assert payload.get("ok"), f"worker error: {payload.get('error')}"
    return payload["result"]


def failed_ids(result: dict) -> set:
    return {c["id"] for c in result["checks"] if not c["passed"]}


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="semantic-pkg-selftest-"))
    try:
        good = run(_write_character(tmp / "c_ok"), tmp / "c_ok", "sheet.png")
        assert good["passed"], good["checks"]
        assert good["operation"] == "character"
        assert Path(good["contactSheet"]).is_file(), "contact sheet was not written"

        baked = run(_write_character(tmp / "c_bake", bake_eyes=True), tmp / "c_bake", "sheet.png")
        assert not baked["passed"]
        assert "face_base_exclusion" in failed_ids(baked), baked["checks"]

        haloed = run(_write_character(tmp / "c_halo", halo=True), tmp / "c_halo", "sheet.png")
        assert not haloed["passed"]
        assert "alpha_halo" in failed_ids(haloed), haloed["checks"]

        env_ok = run(_write_environment(tmp / "e_ok"), tmp / "e_ok", "sheet.png")
        assert env_ok["passed"], env_ok["checks"]

        env_size = run(_write_environment(tmp / "e_size", bad_size=True), tmp / "e_size", "sheet.png")
        assert not env_size["passed"]
        assert "canvas_registration" in failed_ids(env_size), env_size["checks"]

        env_depth = run(_write_environment(tmp / "e_depth", bad_depth=True), tmp / "e_depth", "sheet.png")
        assert not env_depth["passed"]
        assert "depth_ordering" in failed_ids(env_depth), env_depth["checks"]

        r1 = run(_write_character(tmp / "d1"), tmp / "d1", "one.png")
        r2 = run(_write_character(tmp / "d2"), tmp / "d2", "two.png")
        r1.pop("contactSheet")
        r2.pop("contactSheet")
        s1 = json.dumps(r1, sort_keys=True).replace(str(tmp / "d1").replace("\\", "/"), "").replace("\\", "/")
        s2 = json.dumps(r2, sort_keys=True).replace(str(tmp / "d2").replace("\\", "/"), "").replace("\\", "/")
        assert s1 == s2, f"non-deterministic result:\n{s1}\n{s2}"

        print("semantic package worker self-test: passed")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
