"""Deterministic visual QC for semantic packages (CharacterRig / EnvironmentPackage).

Milestone 2, Task 2. Given resolved state-sprite / plate image paths this worker
validates alpha occupancy and halo, in-register bounds, eye/mouth registration,
`face_base` exclusion (no baked eyes/mouth), palette consistency for character
packages, and canvas registration, depth ordering, opacity, occlusion-mask and
worst-case parallax exposure for environment packages. It never mutates a source.

Protocol (same shape as the other tools/anime workers):
  input : --request <path to request.json>
  output: exactly one line  MW_SEMANTIC_QC_V1\t<json>
  exit  : 0 on a completed evaluation (even when passed=false);
          non-zero only for a protocol / runtime failure.

QC failure is data, not an error: {"passed": false, "findings": [...], "checks": [...]}.
Identical inputs produce byte-identical result JSON apart from the caller-supplied
contact-sheet path. Design: project_brain/NATIVE_ANIME_MOTION_ENGINE.md sec 8, 8.1.
"""

from __future__ import annotations

import argparse
import json
import sys
import traceback
from pathlib import Path

import numpy as np
from PIL import Image

RESULT_PREFIX = "MW_SEMANTIC_QC_V1\t"

EYE_STATES = ("OPEN", "HALF", "CLOSED")
MOUTH_STATES = ("CLOSED", "SMALL", "A", "I", "U", "E", "O", "WIDE")

DEFAULT_THRESHOLDS = {
    "occupancy.face_base": [0.06, 0.88],
    "occupancy.body": [0.02, 0.92],
    "occupancy.hair": [0.02, 0.92],
    "occupancy.eye": [0.0002, 0.16],
    "occupancy.mouth": [0.0002, 0.14],
    "occupancy.pose": [0.0004, 0.60],
    "halo.softFraction": 0.35,
    "faceBaseExclusion.meanAlpha": 0.12,
    "registration.eyeCluster": 0.05,
    "registration.eyeLevel": 0.05,
    "registration.mouthCluster": 0.045,
    "registration.mouthCentre": 0.14,
    "palette.maxDistance": 0.16,
    "environment.backgroundOpacity": 0.985,
    "environment.foregroundMaxCoverage": 0.999,
    "environment.occlusionMinShare": 0.02,
    "environment.cameraSafeMinSpan": 0.45,
    "environment.parallaxMaxExposure": 0.001,
    "environment.maxModeledPan": 0.06,
}


def emit_ok(result: dict) -> int:
    print(RESULT_PREFIX + json.dumps({"ok": True, "result": result}, sort_keys=True, separators=(",", ":")), flush=True)
    return 0


def emit_err(message: str, code: str = "worker_error") -> int:
    print(RESULT_PREFIX + json.dumps({"ok": False, "error": {"code": code, "message": str(message)[:2000]}},
                                     sort_keys=True, separators=(",", ":")), flush=True)
    return 2


def rn(value) -> float:
    return round(float(value), 6)


def load_rgba(path: str) -> np.ndarray:
    file = Path(path)
    if not file.is_file():
        raise FileNotFoundError(f"image is missing: {path}")
    with Image.open(file) as handle:
        return np.asarray(handle.convert("RGBA"), dtype=np.uint8)


def alpha_of(image: np.ndarray) -> np.ndarray:
    return image[:, :, 3].astype(np.float32) / 255.0


def coverage(image: np.ndarray, cut: float = 0.125) -> float:
    return float(np.mean(alpha_of(image) > cut))


def soft_fraction(image: np.ndarray) -> float:
    a = alpha_of(image)
    present = a > 0.016
    if not present.any():
        return 0.0
    soft = present & (a < 0.92)
    return float(np.count_nonzero(soft) / np.count_nonzero(present))


def centroid(image: np.ndarray):
    a = alpha_of(image)
    total = float(a.sum())
    if total <= 1e-6:
        return None
    ys, xs = np.mgrid[0:a.shape[0], 0:a.shape[1]]
    return (float((xs * a).sum() / total) / a.shape[1], float((ys * a).sum() / total) / a.shape[0])


def mean_opaque_rgb(image: np.ndarray):
    a = alpha_of(image)
    mask = a > 0.5
    if not mask.any():
        return None
    return image[:, :, :3][mask].astype(np.float32).mean(axis=0)


def rect_mean_alpha(image: np.ndarray, rect) -> float:
    h, w = image.shape[:2]
    x0, y0, x1, y1 = rect
    xa, xb = sorted((int(round(x0 * w)), int(round(x1 * w))))
    ya, yb = sorted((int(round(y0 * h)), int(round(y1 * h))))
    xa, ya = max(0, xa), max(0, ya)
    xb, yb = min(w, max(xb, xa + 1)), min(h, max(yb, ya + 1))
    return float(alpha_of(image)[ya:yb, xa:xb].mean())


def colour_distance(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.linalg.norm(a - b) / 441.673)


def add_check(checks, findings, cid, passed, value, message):
    checks.append({"id": cid, "passed": bool(passed), "value": rn(value)})
    if not passed:
        findings.append(f"{cid}: {message}")


def thresholds_for(request: dict) -> dict:
    merged = dict(DEFAULT_THRESHOLDS)
    for key, value in (request.get("thresholds") or {}).items():
        merged[key] = value
    return merged


def occupancy_band(part: str, state_id: str, th: dict):
    if state_id.startswith("mouth."):
        return th["occupancy.mouth"]
    if state_id.startswith(("eyes_l.", "eyes_r.")):
        return th["occupancy.eye"]
    if part in ("body", "torso"):
        return th["occupancy.body"]
    if part in ("front_hair", "rear_hair", "hair", "side_hair_l", "side_hair_r"):
        return th["occupancy.hair"]
    if part == "face_base":
        return th["occupancy.face_base"]
    return th["occupancy.pose"]


# --------------------------------------------------------------------- character

def qc_character(request: dict, th: dict):
    checks: list = []
    findings: list = []
    canvas = request["canvas"]
    cw, ch = int(canvas["width"]), int(canvas["height"])
    states = sorted(request.get("states") or [], key=lambda s: str(s["id"]))
    images = {str(s["id"]): load_rgba(s["path"]) for s in states}
    parts = {str(s["id"]): str(s.get("semanticPart") or str(s["id"]).split(".")[0]) for s in states}
    ids = set(images)

    missing = []
    part_set = {parts[i] for i in ids}
    if "face_base" not in part_set:
        missing.append("face_base")
    if not ({"body", "torso"} & part_set):
        missing.append("body|torso")
    if "front_hair" not in part_set:
        missing.append("front_hair")
    if not ({"rear_hair", "hair"} & part_set):
        missing.append("rear_hair|hair")
    for side in ("eyes_l", "eyes_r"):
        for st in EYE_STATES:
            if f"{side}.{st}" not in ids:
                missing.append(f"{side}.{st}")
    for st in MOUTH_STATES:
        if f"mouth.{st}" not in ids:
            missing.append(f"mouth.{st}")
    add_check(checks, findings, "required_states", not missing, len(missing),
              f"missing semantic states: {', '.join(missing)}" if missing else "all present")

    mismatched = [i for i, im in images.items() if im.shape[0] != ch or im.shape[1] != cw]
    add_check(checks, findings, "canvas_registration", not mismatched, len(mismatched),
              f"{len(mismatched)} sprites are not {cw}x{ch} in-register" + (f" ({sorted(mismatched)[0]})" if mismatched else ""))

    occ_bad = []
    worst_occ = 0.0
    for i in sorted(images):
        lo, hi = occupancy_band(parts[i], i, th)
        cov = coverage(images[i])
        if cov < lo or cov > hi:
            occ_bad.append(f"{i}={cov:.4f} not in [{lo},{hi}]")
            worst_occ = max(worst_occ, abs(cov - min(max(cov, lo), hi)))
    add_check(checks, findings, "alpha_occupancy", not occ_bad, worst_occ,
              "; ".join(occ_bad[:4]) if occ_bad else "within bands")

    halo_limit = th["halo.softFraction"]
    halo_bad = []
    worst_soft = 0.0
    for i in sorted(images):
        sf = soft_fraction(images[i])
        worst_soft = max(worst_soft, sf)
        if sf > halo_limit:
            halo_bad.append(f"{i}={sf:.3f}")
    add_check(checks, findings, "alpha_halo", not halo_bad, worst_soft,
              f"translucent halo on {', '.join(halo_bad[:4])} (limit {halo_limit})" if halo_bad else "clean edges")

    face_id = next((i for i in sorted(images) if parts[i] == "face_base"), None)
    exclusion = request.get("faceBaseExclusion")
    if not exclusion:
        exclusion = []
        for key in ("eyes_l.OPEN", "eyes_r.OPEN", "mouth.A"):
            c = centroid(images[key]) if key in images else None
            if c:
                exclusion.append([c[0] - 0.10, c[1] - 0.06, c[0] + 0.10, c[1] + 0.06])
    if face_id is not None and exclusion:
        worst = max(rect_mean_alpha(images[face_id], r) for r in exclusion)
        limit = th["faceBaseExclusion.meanAlpha"]
        add_check(checks, findings, "face_base_exclusion", worst <= limit, worst,
                  f"face_base paints the eye/mouth region (mean alpha {worst:.3f} > {limit}); use a clean base, not cut-and-inpaint"
                  if worst > limit else "face_base leaves eyes/mouth transparent")
    else:
        add_check(checks, findings, "face_base_exclusion", face_id is not None, 0.0,
                  "no face_base state to check" if face_id is None else "no exclusion regions")

    eye_centroids = {k: centroid(v) for k, v in images.items() if k.startswith(("eyes_l.", "eyes_r."))}
    worst_reg = 0.0
    reg_notes = []
    for side in ("eyes_l", "eyes_r"):
        pts = [eye_centroids.get(f"{side}.{st}") for st in EYE_STATES]
        pts = [p for p in pts if p]
        if len(pts) >= 2:
            spread = max(((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5 for a in pts for b in pts)
            worst_reg = max(worst_reg, spread)
            if spread > th["registration.eyeCluster"]:
                reg_notes.append(f"{side} states spread {spread:.3f}")
    lo_pt, ro_pt = eye_centroids.get("eyes_l.OPEN"), eye_centroids.get("eyes_r.OPEN")
    if lo_pt and ro_pt:
        if lo_pt[0] >= ro_pt[0]:
            reg_notes.append("eyes_l is not left of eyes_r")
            worst_reg = max(worst_reg, 1.0)
        level = abs(lo_pt[1] - ro_pt[1])
        worst_reg = max(worst_reg, level)
        if level > th["registration.eyeLevel"]:
            reg_notes.append(f"eyes not level (delta y {level:.3f})")
    add_check(checks, findings, "eye_registration", not reg_notes, worst_reg,
              "; ".join(reg_notes) if reg_notes else "eyes registered")

    mouth_centroids = [centroid(images[f"mouth.{st}"]) for st in MOUTH_STATES if f"mouth.{st}" in images]
    mouth_centroids = [p for p in mouth_centroids if p]
    mouth_notes = []
    worst_mouth = 0.0
    if len(mouth_centroids) >= 2:
        spread = max(((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5 for a in mouth_centroids for b in mouth_centroids)
        worst_mouth = max(worst_mouth, spread)
        if spread > th["registration.mouthCluster"]:
            mouth_notes.append(f"mouth states spread {spread:.3f}")
        cx = sum(p[0] for p in mouth_centroids) / len(mouth_centroids)
        face_centroid = centroid(images[face_id]) if face_id is not None else None
        ref = face_centroid[0] if face_centroid else 0.5
        off = abs(cx - ref)
        worst_mouth = max(worst_mouth, off)
        if off > th["registration.mouthCentre"]:
            mouth_notes.append(f"mouth off face centre by {off:.3f}")
    add_check(checks, findings, "mouth_registration", not mouth_notes, worst_mouth,
              "; ".join(mouth_notes) if mouth_notes else "mouth registered")

    pal_notes = []
    worst_pal = 0.0
    for label, group in (("eye", [f"{s}.{st}" for s in ("eyes_l", "eyes_r") for st in EYE_STATES]),
                         ("mouth", [f"mouth.{st}" for st in MOUTH_STATES])):
        cols = [mean_opaque_rgb(images[k]) for k in group if k in images]
        cols = [c for c in cols if c is not None]
        if len(cols) >= 2:
            mean = np.mean(cols, axis=0)
            far = max(colour_distance(c, mean) for c in cols)
            worst_pal = max(worst_pal, far)
            if far > th["palette.maxDistance"]:
                pal_notes.append(f"{label} colour varies {far:.3f}")
    add_check(checks, findings, "palette_consistency", not pal_notes, worst_pal,
              "; ".join(pal_notes) if pal_notes else "state colours consistent")

    sheet = write_contact_sheet(request.get("contactSheet"), [images[i] for i in sorted(images)])
    return finalize("character", checks, findings, sheet, th)


# ------------------------------------------------------------------- environment

def parallax_for_depth(depth: float) -> float:
    # ponytail: linear heuristic matching NATIVE_ANIME_MOTION_ENGINE.md sec 4.4's
    # stated ~0.10..1.15 range; the compiler owns the real value later.
    return 0.10 + 1.05 * float(depth)


def qc_environment(request: dict, th: dict):
    checks: list = []
    findings: list = []
    canvas = request["canvas"]
    cw, ch = int(canvas["width"]), int(canvas["height"])
    plates = request.get("plates") or []
    images = [load_rgba(p["path"]) for p in plates]
    roles = [str(p.get("role") or "") for p in plates]
    depths = [float(p.get("depth")) for p in plates]

    mask_path = request.get("occlusionMaskPath")
    mask_img = load_rgba(mask_path) if mask_path else None

    check_targets = list(images) + ([mask_img] if mask_img is not None else [])
    mismatched = sum(1 for im in check_targets if im.shape[0] != ch or im.shape[1] != cw)
    add_check(checks, findings, "canvas_registration", mismatched == 0, mismatched,
              f"{mismatched} plate/mask images are not {cw}x{ch}")

    order_bad = 0
    for a, b in zip(depths, depths[1:]):
        if not b > a:
            order_bad += 1
    if depths and (min(depths) < 0 or max(depths) > 1):
        order_bad += 1
    if roles and depths:
        if "background" in roles and depths[roles.index("background")] != min(depths):
            order_bad += 1
        if "foreground" in roles and depths[roles.index("foreground")] != max(depths):
            order_bad += 1
    add_check(checks, findings, "depth_ordering", order_bad == 0, order_bad,
              f"plate depths not strictly ascending / role-consistent ({depths})" if order_bad else "depths ascending")

    bg_idx = roles.index("background") if "background" in roles else (0 if images else None)
    if bg_idx is not None:
        bg_cov = coverage(images[bg_idx], cut=0.5)
        limit = th["environment.backgroundOpacity"]
        add_check(checks, findings, "background_opacity", bg_cov >= limit, bg_cov,
                  f"background plate only {bg_cov:.3f} opaque (need {limit})" if bg_cov < limit else "background is opaque")

    fg_bad = []
    worst_fg = 0.0
    for im, role in zip(images, roles):
        if role == "background":
            continue
        cov = coverage(im, cut=0.5)
        worst_fg = max(worst_fg, cov)
        if cov >= th["environment.foregroundMaxCoverage"]:
            fg_bad.append(f"{role}={cov:.3f}")
    add_check(checks, findings, "layer_transparency", not fg_bad, worst_fg,
              f"non-background plate fully opaque, will hide the scene: {', '.join(fg_bad)}" if fg_bad else "layers have gaps")

    if mask_img is not None:
        m = mask_img[:, :, :3].mean(axis=2) / 255.0
        low = float(np.mean(m < 0.2))
        high = float(np.mean(m > 0.8))
        share = min(low, high)
        limit = th["environment.occlusionMinShare"]
        add_check(checks, findings, "occlusion_mask", share >= limit, share,
                  f"occlusion mask is near-uniform (masked share {share:.3f})" if share < limit else "occlusion mask is meaningful")
    else:
        add_check(checks, findings, "occlusion_mask", False, 0.0, "no occlusionMaskPath supplied")

    region = request.get("cameraSafeRegion") or {}
    rx = [float(v) for v in region.get("x", [0.0, 1.0])]
    ry = [float(v) for v in region.get("y", [0.0, 1.0])]
    span = min(rx[1] - rx[0], ry[1] - ry[0])
    bounds_ok = 0.0 <= rx[0] < rx[1] <= 1.0 and 0.0 <= ry[0] < ry[1] <= 1.0 and span >= th["environment.cameraSafeMinSpan"]
    add_check(checks, findings, "camera_safe_bounds", bounds_ok, span,
              f"camera-safe region degenerate or out of range (span {span:.3f})" if not bounds_ok else "camera-safe region ok")

    if bg_idx is not None and images:
        opaque = alpha_of(images[bg_idx]) > 0.5
        pan = min(th["environment.maxModeledPan"], max(rx[0], 1 - rx[1], ry[0], 1 - ry[1], 0.0))
        px = parallax_for_depth(depths[bg_idx]) if depths else 1.0
        dx = int(round(pan * px * cw))
        dy = int(round(pan * px * ch))
        x0, x1 = int(rx[0] * cw), int(rx[1] * cw)
        y0, y1 = int(ry[0] * ch), int(ry[1] * ch)
        safe = np.ones((max(1, y1 - y0), max(1, x1 - x0)), dtype=bool)
        total = safe.size
        exposure = 0.0
        for sx in (-dx, dx):
            for sy in (-dy, dy):
                shifted = np.zeros_like(opaque)
                shifted[max(0, sy):min(ch, ch + sy), max(0, sx):min(cw, cw + sx)] = \
                    opaque[max(0, -sy):min(ch, ch - sy), max(0, -sx):min(cw, cw - sx)]
                hole = int(np.count_nonzero(safe & ~shifted[y0:y0 + safe.shape[0], x0:x0 + safe.shape[1]]))
                exposure = max(exposure, hole / total)
        limit = th["environment.parallaxMaxExposure"]
        add_check(checks, findings, "parallax_exposure", exposure <= limit, exposure,
                  f"worst-case camera pan exposes {exposure:.4f} of the safe frame past the background"
                  if exposure > limit else "background covers the safe frame under camera motion")

    sheet = write_contact_sheet(request.get("contactSheet"), images + ([mask_img] if mask_img is not None else []))
    return finalize("environment", checks, findings, sheet, th)


# ------------------------------------------------------------------------ shared

def write_contact_sheet(path, images):
    if not path or not images:
        return path
    tile = 192
    cols = 6
    rows = (len(images) + cols - 1) // cols
    check = np.indices((tile, tile)).sum(axis=0) // 16 % 2
    bg = np.where(check[..., None] == 0, 210, 170).astype(np.uint8).repeat(3, axis=2)
    sheet = np.zeros((rows * tile, cols * tile, 3), dtype=np.uint8)
    for idx, im in enumerate(images):
        thumb = np.asarray(Image.fromarray(im, "RGBA").resize((tile, tile), Image.NEAREST), dtype=np.float32)
        a = thumb[:, :, 3:4] / 255.0
        comp = (thumb[:, :, :3] * a + bg * (1 - a)).astype(np.uint8)
        r, c = divmod(idx, cols)
        sheet[r * tile:(r + 1) * tile, c * tile:(c + 1) * tile] = comp
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(sheet, "RGB").save(out, format="PNG")
    return str(path)


def finalize(operation: str, checks, findings, sheet, th):
    passed = all(c["passed"] for c in checks)
    return {
        "operation": operation,
        "passed": passed,
        "checks": sorted(checks, key=lambda c: c["id"]),
        "findings": sorted(findings),
        "thresholds": {k: th[k] for k in sorted(th)},
        "contactSheet": sheet,
    }


def main(argv: list) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    args = parser.parse_args(argv)
    try:
        request = json.loads(Path(args.request).read_text(encoding="utf-8"))
        if not isinstance(request, dict) or "canvas" not in request:
            return emit_err("request must be an object with a canvas", "invalid_request")
        operation = request.get("operation")
        th = thresholds_for(request)
        if operation == "character":
            return emit_ok(qc_character(request, th))
        if operation == "environment":
            return emit_ok(qc_environment(request, th))
        return emit_err(f"unknown operation: {operation!r}", "invalid_request")
    except (FileNotFoundError, ValueError, KeyError) as exc:
        return emit_err(str(exc), "invalid_request")
    except Exception as exc:  # noqa: BLE001 - protocol failure path
        print(traceback.format_exc()[-3000:], file=sys.stderr, flush=True)
        return emit_err(str(exc), "worker_error")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
