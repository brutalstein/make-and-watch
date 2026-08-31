"""Deterministic 2D anime motion renderer for the `native-anime` temporal provider.

No generative video model. Given a ShotAnim program (layered art + parameter curves +
camera path + dialogue alignment + subtitle cues) this renders every delivery frame
with numpy + Pillow + OpenCV, streams the frames straight into FFmpeg, muxes the
dialogue audio and writes one MP4. Intermediate frames are never written to disk.

Same worker protocol as tools/generation/framepack-temporal-worker.py:
  input : --request <path to request.json>
  output: exactly one line  MW_TEMPORAL_RESULT_V1\t<json>

Design + math: project_brain/NATIVE_ANIME_MOTION_ENGINE.md (sections 4, 7, 8).
This first cut uses affine layer transforms as a stand-in for the warp-grid deformer
described in the design; the deterministic Verlet secondary motion, 2.5D parallax,
discrete blink/mouth charts and camera path are the real implementations.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import runpy
import subprocess
import sys
import traceback
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

RESULT_PREFIX = "MW_TEMPORAL_RESULT_V1\t"

# Deterministic 2D skeletal FK for retargeted limb layers (M5). Loaded by path
# because the file name is hyphenated; pure-math, no numpy dependency of its own.
_KINEMATICS = runpy.run_path(str(Path(__file__).with_name("skeleton-kinematics.py")))
forward_kinematics = _KINEMATICS["forward_kinematics"]

HEAD_PARTS = {"head_group", "face_base", "eyes", "eyes_l", "eyes_r", "brows", "mouth",
              "front_hair", "side_hair_l", "side_hair_r"}
EYE_PARTS = {"eyes", "eyes_l", "eyes_r"}

# Anime-simple mouth chart -> vertical openness of the mouth layer.
MOUTH_OPENNESS = {
    "CLOSED": 0.06, "SMALL": 0.24, "A": 1.0, "I": 0.5,
    "U": 0.44, "E": 0.7, "O": 0.86, "WIDE": 1.0,
}
VOWEL_SHAPE = {"a": "A", "i": "I", "u": "U", "e": "E", "o": "O", "n": "CLOSED", "-": "CLOSED"}


def emit_ok(result: dict) -> int:
    print(RESULT_PREFIX + json.dumps({"ok": True, "result": result}, separators=(",", ":")), flush=True)
    return 0


def emit_err(message: str, code: str = "worker_error") -> int:
    print(RESULT_PREFIX + json.dumps({"ok": False, "error": {"code": code, "message": str(message)[:2000]}},
                                     separators=(",", ":")), flush=True)
    return 2


# --------------------------------------------------------------------------- paths

def safe_media_path(media_root: Path, rel: str) -> Path:
    root = media_root.resolve()
    candidate = (root / rel).resolve()
    if candidate != root and root not in candidate.parents:
        raise ValueError(f"path escapes media root: {rel}")
    if not candidate.is_file():
        raise ValueError(f"asset is missing: {rel}")
    return candidate


# ------------------------------------------------------------------------- curves

def _ease(kind: str, u: float) -> float:
    u = min(1.0, max(0.0, u))
    if kind in ("step", "hold"):
        return 0.0
    if kind == "easeIn":
        return u * u
    if kind == "easeOut":
        return 1.0 - (1.0 - u) * (1.0 - u)
    if kind == "easeInOut":
        return 3 * u * u - 2 * u * u * u
    return u  # linear


def sample_curve(keys: list, t: float) -> float:
    if not keys:
        return 0.0
    if t <= keys[0]["t"]:
        return keys[0]["v"]
    if t >= keys[-1]["t"]:
        return keys[-1]["v"]
    for i in range(1, len(keys)):
        a, b = keys[i - 1], keys[i]
        if t <= b["t"]:
            span = b["t"] - a["t"]
            if span <= 1e-9 or b.get("ease") in ("step", "hold"):
                return a["v"]
            u = _ease(b.get("ease", "linear"), (t - a["t"]) / span)
            return a["v"] + (b["v"] - a["v"]) * u
    return keys[-1]["v"]


# ------------------------------------------------------------------- verlet chain

class VerletChain:
    """Fixed dt, fixed iteration count, no RNG -> bit-identical every run."""

    def __init__(self, segments: int, seg_len: float, stiffness: float, damping: float, gravity: float):
        self.n = segments
        self.seg_len = seg_len
        self.stiffness = stiffness
        self.damping = damping
        self.gravity = gravity
        self.pos = np.array([[0.0, i * seg_len] for i in range(segments + 1)], dtype=np.float64)
        self.prev = self.pos.copy()
        self.initialized = False

    def step(self, dt: float, root_xy: np.ndarray) -> np.ndarray:
        if not self.initialized:
            self.pos = np.array(
                [root_xy + np.array([0.0, i * self.seg_len]) for i in range(self.n + 1)],
                dtype=np.float64,
            )
            self.prev = self.pos.copy()
            self.initialized = True
        self.pos[0] = root_xy
        self.prev[0] = root_xy
        for i in range(1, self.n + 1):
            vel = (self.pos[i] - self.prev[i]) * (1.0 - self.damping)
            self.prev[i] = self.pos[i].copy()
            self.pos[i] = self.pos[i] + vel
            self.pos[i][1] += self.gravity * dt * dt * 900.0
        for _ in range(8):
            for i in range(1, self.n + 1):
                delta = self.pos[i] - self.pos[i - 1]
                dist = float(np.hypot(delta[0], delta[1])) or 1e-6
                self.pos[i] = self.pos[i] - delta * ((dist - self.seg_len) / dist)
                rest = self.pos[i - 1] + np.array([0.0, self.seg_len])
                self.pos[i] = self.pos[i] + (rest - self.pos[i]) * (self.stiffness * 0.25)
        return self.pos[self.n]


# ---------------------------------------------------------------------- rendering

# 3x3 homogeneous helpers so placement (about canvas centre) and local feature
# deform (about a part's own pivot) compose cleanly: M = M_place @ M_local.
def _t(tx: float, ty: float) -> np.ndarray:
    return np.array([[1, 0, tx], [0, 1, ty], [0, 0, 1]], dtype=np.float64)


def scale_about(sx: float, sy: float, px: float, py: float) -> np.ndarray:
    return _t(px, py) @ np.diag([sx, sy, 1.0]) @ _t(-px, -py)


def rotate_about(deg: float, px: float, py: float) -> np.ndarray:
    a = math.radians(deg)
    ca, sa = math.cos(a), math.sin(a)
    return _t(px, py) @ np.array([[ca, -sa, 0], [sa, ca, 0], [0, 0, 1]], dtype=np.float64) @ _t(-px, -py)


def load_layer(path: Path) -> np.ndarray:
    return np.asarray(Image.open(path).convert("RGBA"), dtype=np.float32) / np.float32(255.0)


def over(dst_rgb: np.ndarray, src_rgba: np.ndarray) -> None:
    alpha = src_rgba[..., 3:4].astype(np.float32)
    dst_rgb *= (1.0 - alpha)
    dst_rgb += src_rgba[..., :3] * alpha


def load_alignment(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    sample_rate = float(data.get("sampleRate", 0.0) or 0.0)

    def timing(value: dict, sample_key: str, seconds_key: str) -> float:
        if sample_rate > 0 and sample_key in value:
            return float(value[sample_key]) / sample_rate
        return float(value.get(seconds_key, 0.0))

    tokens = []
    for token in data.get("tokens", []):
        tokens.append({
            "text": str(token.get("text", "")).strip().lower(),
            "start": timing(token, "startSample", "start"),
            "end": timing(token, "endSample", "end"),
            "conf": float(token.get("confidence", token.get("conf", 1.0))),
        })
    return {
        "tokens": tokens,
        "speechStart": (float(data["speechStartSample"]) / sample_rate
                        if sample_rate > 0 and "speechStartSample" in data
                        else float(data.get("speechStart", tokens[0]["start"] if tokens else 0.0))),
        "speechEnd": (float(data["speechEndSample"]) / sample_rate
                      if sample_rate > 0 and "speechEndSample" in data
                      else float(data.get("speechEnd", tokens[-1]["end"] if tokens else 0.0))),
    }


def mouth_openness(t: float, dialogue: list, alignments: dict) -> float:
    best = 0.06
    for unit in dialogue:
        start = unit["startSeconds"]
        align = alignments.get(unit["id"])
        if align and unit.get("mouthSource") == "alignment" and align["tokens"]:
            for token in align["tokens"]:
                if token["start"] + start <= t < token["end"] + start:
                    shape = VOWEL_SHAPE.get(token["text"][-1:], "A" if token["text"] else "CLOSED")
                    best = max(best, MOUTH_OPENNESS.get(shape, 0.5) * (0.55 + 0.45 * token["conf"]))
        else:
            span = (align["speechEnd"] - align["speechStart"]) if align else 1.8
            if start <= t < start + max(0.4, span):
                phase = (t - start) * 6.5
                best = max(best, 0.12 + 0.78 * (0.5 - 0.5 * math.cos(phase * 2 * math.pi)))
    return best


def blink_value(t: float, schedule: list) -> float:
    v = 0.0
    for bt in schedule:
        d = abs(t - bt)
        if d < 0.07:
            v = max(v, 1.0 - d / 0.07)
    return v


def resolve_font(shot_anim: dict) -> ImageFont.ImageFont:
    candidates = []
    if shot_anim.get("subtitleFontPath"):
        candidates.append(shot_anim["subtitleFontPath"])
    candidates += [
        r"C:\Windows\Fonts\arial.ttf",
        r"C:\Windows\Fonts\segoeui.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/Library/Fonts/Arial.ttf",
    ]
    for candidate in candidates:
        try:
            return ImageFont.truetype(candidate, 40)
        except Exception:
            continue
    return ImageFont.load_default()


def draw_subtitle(canvas_u8: np.ndarray, text: str, font) -> np.ndarray:
    image = Image.fromarray(canvas_u8, "RGB").convert("RGBA")
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    w, h = image.size
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x = (w - tw) // 2
    y = h - th - 64
    draw.rectangle([x - 24, y - 16, x + tw + 24, y + th + 20], fill=(0, 0, 0, 150))
    draw.text((x - bbox[0], y - bbox[1]), text, font=font, fill=(255, 255, 255, 255),
              stroke_width=2, stroke_fill=(0, 0, 0, 255))
    return np.asarray(Image.alpha_composite(image, overlay).convert("RGB"))


def build_ffmpeg_cmd(request: dict, shot_anim: dict, media_root: Path) -> list:
    w, h = shot_anim["resolution"]
    fps = shot_anim["fps"]
    cmd = [
        request["ffmpeg"], "-y", "-hide_banner", "-loglevel", "error", "-nostdin",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", str(fps), "-i", "pipe:0",
    ]
    audio_units = [u for u in shot_anim.get("dialogue", []) if u.get("audioPath")]
    if audio_units:
        unit = audio_units[0]
        cmd += ["-itsoffset", f"{unit['startSeconds']:.3f}",
                "-i", str(safe_media_path(media_root, unit["audioPath"]))]
    cmd += ["-map", "0:v:0"]
    if audio_units:
        # video drives the length; a shorter dialogue clip simply ends. No -shortest
        # (that closes the frame pipe early and breaks the writer on Windows).
        cmd += ["-map", "1:a:0", "-c:a", "aac", "-b:a", "160k"]
    # -threads 1 keeps libx264 output bit-exact; framesSha256 is the stronger guarantee.
    cmd += [
        "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
        "-threads", "1", "-fflags", "+bitexact", "-flags:v", "+bitexact",
        "-movflags", "+faststart", str(request["outputFile"]),
    ]
    return cmd


def _camera_sampler(cam_keys: list):
    def cam_at(t: float):
        if t <= cam_keys[0]["t"]:
            k = cam_keys[0]
        elif t >= cam_keys[-1]["t"]:
            k = cam_keys[-1]
        else:
            for i in range(1, len(cam_keys)):
                a, b = cam_keys[i - 1], cam_keys[i]
                if t <= b["t"]:
                    span = (b["t"] - a["t"]) or 1e-9
                    u = _ease(b.get("ease", "easeInOut"), (t - a["t"]) / span)
                    return (a["x"] + (b["x"] - a["x"]) * u, a["y"] + (b["y"] - a["y"]) * u,
                            a["zoom"] + (b["zoom"] - a["zoom"]) * u, a["rot"] + (b["rot"] - a["rot"]) * u)
            k = cam_keys[-1]
        return k["x"], k["y"], k["zoom"], k["rot"]
    return cam_at


def prepare_shot_anim(shot_anim: dict) -> dict:
    """Fill the fields the JS contract normally normalizes, so direct callers (the
    vertical slice, the self-test) can hand the worker a lean ShotAnim."""
    fps = int(shot_anim.get("fps", 24))
    duration = float(shot_anim["durationSeconds"])
    shot_anim.setdefault("fps", fps)
    shot_anim.setdefault("frameCount", max(1, round(duration * fps)))
    shot_anim.setdefault("background", {"color": [8, 10, 16]})
    shot_anim["background"].setdefault("color", [8, 10, 16])
    shot_anim.setdefault("grain", 0.0)
    shot_anim.setdefault("camera", {})
    shot_anim["camera"].setdefault("keyframes", [{"t": 0}])
    for key in shot_anim["camera"]["keyframes"]:
        key.setdefault("t", 0.0)
        key.setdefault("x", 0.0)
        key.setdefault("y", 0.0)
        key.setdefault("zoom", 1.0)
        key.setdefault("rot", 0.0)
    shot_anim.setdefault("dialogue", [])
    shot_anim.setdefault("subtitles", [])
    shot_anim.setdefault("motion", [])
    for index, layer in enumerate(shot_anim.get("layers", [])):
        layer.setdefault("part", "body")
        layer.setdefault("parallax", 1.0)
        layer.setdefault("pivot", [0.5, 0.5])
        layer.setdefault("z", index)
        layer.setdefault("curves", {})
        layer.setdefault("anchor", None)
        layer.setdefault("bone", None)
        if layer.get("dynamic"):
            dyn = layer["dynamic"]
            dyn.setdefault("segments", 3)
            dyn.setdefault("stiffness", 0.28)
            dyn.setdefault("damping", 0.12)
            dyn.setdefault("gravity", 0.6)
            dyn.setdefault("maxDeg", 22)
    shot_anim["layers"].sort(key=lambda item: item["z"])
    return shot_anim


# ------------------------------------------------------------------- skeletal FK

def build_motion_index(shot_anim: dict, w: float, h: float) -> dict:
    """Precompute the rest pose and per-character placement for every `motion` entry."""
    index = {}
    for entry in shot_anim.get("motion", []):
        skeleton = entry["skeleton"]
        bone_ids = [bone["id"] for bone in skeleton["bones"]]
        anchor = entry.get("screenAnchor") or [0.5, 0.5]
        root_keys = entry.get("rootMotion", [])
        index[entry["characterId"]] = {
            "skeleton": skeleton,
            "boneCurves": entry.get("boneCurves", {}),
            "boneIds": bone_ids,
            "rest": forward_kinematics(skeleton, {}),
            "anchorPx": (anchor[0] * w, anchor[1] * h),
            "ppu": float(entry.get("pixelsPerUnit", 1.0)),
            "rootX": [{"t": key["t"], "v": key.get("x", 0.0)} for key in root_keys],
            "rootY": [{"t": key["t"], "v": key.get("y", 0.0)} for key in root_keys],
        }
    return index


def bone_matrix(entry: dict, joints_t: dict, bone_id: str, t: float) -> np.ndarray:
    """Rigid-bone deform for a rest-pose sprite: shift its authored head to the FK
    head (plus root motion) and rotate about that head by the bone's world-angle
    change since rest. No skin/stretch — limited-animation limbs stay rigid."""
    rest = entry["rest"][bone_id]
    now = joints_t[bone_id]
    ax, ay = entry["anchorPx"]
    ppu = entry["ppu"]
    root_x = sample_curve(entry["rootX"], t)
    root_y = sample_curve(entry["rootY"], t)
    head_rest = (ax + rest["origin"][0] * ppu, ay + rest["origin"][1] * ppu)
    head_now = (ax + (now["origin"][0] + root_x) * ppu, ay + (now["origin"][1] + root_y) * ppu)
    dtheta = now["worldDeg"] - rest["worldDeg"]
    return _t(head_now[0] - head_rest[0], head_now[1] - head_rest[1]) @ rotate_about(dtheta, head_rest[0], head_rest[1])


def _motion_entry_for(layer_id: str, bone_id: str, motion_index: dict):
    for character_id, entry in motion_index.items():
        if layer_id.startswith(character_id + ".") and bone_id in entry["rest"]:
            return character_id, entry
    return None


def render(request: dict) -> dict:
    shot_anim = prepare_shot_anim(request["shotAnim"])
    media_root = Path(request["projectMediaRoot"])
    seed = int(request.get("seed", 0)) & 0xFFFFFFFF
    w, h = shot_anim["resolution"]
    fps = shot_anim["fps"]
    duration = shot_anim["durationSeconds"]
    frame_count = shot_anim["frameCount"]
    dt = 1.0 / fps
    rng = np.random.default_rng(seed)
    grain = shot_anim.get("grain", 0.0)
    bg = np.array(shot_anim["background"]["color"], dtype=np.float64) / 255.0

    layers = []
    for spec in shot_anim["layers"]:
        pixels = load_layer(safe_media_path(media_root, spec["path"]))
        lh, lw = pixels.shape[:2]
        chain = None
        if spec.get("dynamic"):
            dyn = spec["dynamic"]
            chain = VerletChain(dyn["segments"], seg_len=max(4.0, lh * 0.32 / dyn["segments"]),
                                stiffness=dyn["stiffness"], damping=dyn["damping"], gravity=dyn["gravity"])
        layers.append({"spec": spec, "px": pixels, "w": lw, "h": lh, "chain": chain})

    motion_index = build_motion_index(shot_anim, w, h)
    for layer in layers:
        bone_id = layer["spec"].get("bone")
        layer["motion"] = _motion_entry_for(layer["spec"].get("id", ""), bone_id, motion_index) if bone_id else None

    alignments = {}
    for unit in shot_anim.get("dialogue", []):
        if unit.get("alignmentPath"):
            alignments[unit["id"]] = load_alignment(safe_media_path(media_root, unit["alignmentPath"]))

    font = resolve_font(shot_anim)
    cam_at = _camera_sampler(shot_anim["camera"]["keyframes"])
    subtitles = shot_anim.get("subtitles", [])
    dialogue = shot_anim.get("dialogue", [])

    # shot-wide head channels (authored on whichever layer carries them)
    head_z_keys, head_bob_keys, blink_sched = [], [], []
    for layer in layers:
        curves = layer["spec"].get("curves", {})
        head_z_keys = curves.get("headAngleZ", head_z_keys)
        head_bob_keys = curves.get("headBob", head_bob_keys)
        if "blink" in curves:
            blink_sched = [k["t"] for k in curves["blink"]]

    # Character sublayers (eyes/mouth/hair/face) are canvas-sized cut-outs already in
    # register with the body, so they share ONE placement transform (camera + anchor
    # about the canvas centre) and differ only by a small local deform about their own
    # feature pivot. Plates use placement only, scaled by their parallax.
    centre_x, centre_y = w * 0.5, h * 0.5
    head_pivot = shot_anim.get("headPivot", [0.5, 0.62])
    hp_x, hp_y = head_pivot[0] * w, head_pivot[1] * h

    cmd = build_ffmpeg_cmd(request, shot_anim, media_root)
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    frames_hash = hashlib.sha256()

    try:
        for frame_index in range(frame_count):
            t = frame_index / fps
            cx, cy, czoom, crot = cam_at(t)
            head_z = sample_curve(head_z_keys, t)
            head_bob = sample_curve(head_bob_keys, t)
            blink = blink_value(t, blink_sched)
            openness = mouth_openness(t, dialogue, alignments)
            frame_joints = {}
            for character_id, entry in motion_index.items():
                anim = {bone: sample_curve(entry["boneCurves"].get(bone, []), t) for bone in entry["boneIds"]}
                frame_joints[character_id] = forward_kinematics(entry["skeleton"], anim)
            canvas = np.empty((h, w, 3), dtype=np.float32)
            canvas[:] = bg

            for layer in layers:
                spec = layer["spec"]
                curves = spec.get("curves", {})
                parallax = spec["parallax"]
                part = spec["part"]
                anchor = spec.get("anchor") or [0.0, 0.0]

                place_scale = 1.0 + (czoom - 1.0) * parallax
                place = (_t(centre_x + (cx * parallax) * w + anchor[0] * w,
                           centre_y + (cy * parallax) * h + anchor[1] * h)
                         @ np.diag([place_scale, place_scale, 1.0])
                         @ _t(-centre_x, -centre_y)
                         @ rotate_about(crot * parallax, centre_x, centre_y))

                local = np.eye(3)
                if layer["motion"] is not None:
                    character_id, entry = layer["motion"]
                    local = bone_matrix(entry, frame_joints[character_id], spec["bone"], t)
                elif part == "plate":
                    pass
                elif part == "torso":
                    breathe = sample_curve(curves["breathe"], t) if "breathe" in curves else 0.0
                    local = scale_about(1.0 + 0.005 * breathe, 1.0 + 0.013 * breathe, centre_x, h * 0.74)
                else:  # head-group part
                    fp_x, fp_y = spec["pivot"][0] * w, spec["pivot"][1] * h
                    local = rotate_about(head_z, hp_x, hp_y) @ _t(0.0, head_bob + 1.6 * math.sin(t * 1.7))
                    if part in EYE_PARTS:
                        look_x = sample_curve(curves["eyeLookX"], t) if "eyeLookX" in curves else 0.0
                        look_y = sample_curve(curves["eyeLookY"], t) if "eyeLookY" in curves else 0.0
                        local = local @ _t(look_x * 7.0, look_y * 5.0) @ scale_about(1.0, 1.0 - 0.9 * blink, fp_x, fp_y)
                    elif part == "mouth":
                        local = local @ scale_about(1.0, 0.14 + 0.86 * openness, fp_x, fp_y)
                    elif part == "front_hair" and layer["chain"] is not None:
                        driven = (
                            rotate_about(head_z, hp_x, hp_y)
                            @ _t(0.0, head_bob + 1.6 * math.sin(t * 1.7))
                            @ np.array([hp_x, hp_y - h * 0.16, 1.0])
                        )
                        root = driven[:2]
                        tip = layer["chain"].step(dt, root)
                        sway = math.degrees(math.atan2(tip[0] - root[0], max(1.0, tip[1] - root[1])))
                        maxd = spec["dynamic"]["maxDeg"]
                        local = local @ rotate_about(max(-maxd, min(maxd, sway * 1.3)), fp_x, fp_y)

                matrix = (place @ local)[:2].astype(np.float32)
                warped = cv2.warpAffine(layer["px"], matrix, (w, h), flags=cv2.INTER_LINEAR,
                                        borderMode=cv2.BORDER_CONSTANT, borderValue=(0.0, 0.0, 0.0, 0.0))
                over(canvas, warped)

            if grain > 0.0:
                canvas += (rng.random((h, w, 1), dtype=np.float32) - np.float32(0.5)) * np.float32(2.0 * grain)

            frame_u8 = np.ascontiguousarray(np.clip(canvas * 255.0, 0, 255).astype(np.uint8))
            active = next((c for c in subtitles if c["startSeconds"] <= t < c["endSeconds"]), None)
            if active:
                frame_u8 = np.ascontiguousarray(draw_subtitle(frame_u8, active["text"], font))

            payload = frame_u8.tobytes()
            frames_hash.update(payload)
            try:
                proc.stdin.write(payload)
            except (BrokenPipeError, OSError):
                break  # ffmpeg exited early; report its stderr below

        proc.stdin.close()
        code = proc.wait(timeout=600)
        if code != 0:
            raise RuntimeError(f"ffmpeg exited {code}: {proc.stderr.read().decode('utf-8', 'ignore')[-1200:]}")
    finally:
        if proc.poll() is None:
            proc.kill()

    out = Path(request["outputFile"])
    if not out.is_file() or out.stat().st_size <= 1024:
        raise RuntimeError("native-anime produced no output file")

    return {
        "outputFile": str(out),
        "frameCount": frame_count,
        "fps": fps,
        "durationSeconds": duration,
        "resolution": [w, h],
        "layerCount": len(layers),
        "dynamicChains": sum(1 for layer in layers if layer["chain"] is not None),
        "framesSha256": frames_hash.hexdigest(),
        "bytes": out.stat().st_size,
        "persistedIntermediateFrames": 0,
    }


def load_request(path: Path) -> dict:
    if not path.is_file() or path.stat().st_size > 2 * 1024 * 1024:
        raise ValueError("native-anime request file is missing or oversized")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or "shotAnim" not in value:
        raise ValueError("native-anime request must be an object with a shotAnim")
    return value


def main(argv: list) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    args = parser.parse_args(argv)
    try:
        return emit_ok(render(load_request(Path(args.request))))
    except Exception as error:  # noqa: BLE001 - worker boundary: always report as a result line
        print(traceback.format_exc()[-3000:], file=sys.stderr, flush=True)
        return emit_err(f"{type(error).__name__}: {error}", code="provider_error")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
