"""Native Anime Motion Engine - Milestone 0 vertical slice.

Proves the thesis end to end with NO generative video model:

  1. generate one anime character (flat green backdrop) + one background via the
     already-running local ComfyUI (anime SDXL);
  2. hand-split the character into ~6 layers (body / front hair / eyes / mouth) and
     the background into 2 parallax plates  -- crude, because See-through-class layer
     decomposition is not installed;
  3. synthesize one deterministic Japanese line ("あめ　だね") + an alignment file
     (authored from the synth's known mora timing -- a real forced aligner is designed
     in NATIVE_ANIME_MOTION_ENGINE.md sec 7 but not run here);
  4. build a ShotAnim and render it through tools/anime/native-anime-worker.py to a
     real 1080p24 MP4 with eye-look + blink + mouth flap + subtle head motion +
     Verlet hair + 2.5D parallax push-in + a burned Turkish subtitle + muxed audio;
  5. ffprobe + extract a contact sheet + write metrics.json.

Run:  python tools/anime/vertical-slice.py
Fast rerender from accepted source drawings:  python tools/anime/vertical-slice.py --reuse-sources
Needs: local ComfyUI on 127.0.0.1:8188, ffmpeg/ffprobe on PATH, numpy+Pillow+OpenCV.
"""

from __future__ import annotations

import io
import json
import shutil
import struct
import subprocess
import sys
import time
import urllib.request
import wave
from pathlib import Path

import numpy as np
import cv2
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
MEDIA = ROOT / ".makewatch"
SLICE_DIR = MEDIA / "anime" / "slice"
REPORT_DIR = MEDIA / "reports" / "native-anime-slice"
COMFY = "http://127.0.0.1:8188"
CKPT = "waiIllustriousSDXL_v160.safetensors"
FPS = 24
DURATION = 4.0
W, H = 1920, 1080

STYLE = ("masterpiece, best quality, anime cinematic, 2d anime key visual, clean lineart, "
         "cel shading, soft rim light, detailed eyes")
NEG = ("photo, 3d, realistic, lowres, bad anatomy, bad hands, extra fingers, watermark, "
       "signature, jpeg artifacts, blurry, multiple views")


def post_prompt(workflow: dict) -> str:
    body = json.dumps({"prompt": workflow}).encode("utf-8")
    request = urllib.request.Request(f"{COMFY}/prompt", data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read())["prompt_id"]


def wait_image(prompt_id: str, timeout_s: int = 400) -> bytes:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        with urllib.request.urlopen(f"{COMFY}/history/{prompt_id}", timeout=30) as response:
            history = json.loads(response.read())
        entry = history.get(prompt_id)
        if entry and entry.get("outputs"):
            for node in entry["outputs"].values():
                for image in node.get("images", []):
                    query = (f"filename={image['filename']}&subfolder={image.get('subfolder', '')}"
                             f"&type={image.get('type', 'output')}")
                    with urllib.request.urlopen(f"{COMFY}/view?{query}", timeout=60) as response:
                        return response.read()
        time.sleep(2)
    raise TimeoutError(f"ComfyUI prompt {prompt_id} produced no image in {timeout_s}s")


def txt2img(prompt: str, negative: str, width: int, height: int, seed: int, prefix: str) -> Image.Image:
    workflow = {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": CKPT}},
        "2": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["1", 1]}},
        "3": {"class_type": "CLIPTextEncode", "inputs": {"text": negative, "clip": ["1", 1]}},
        "4": {"class_type": "EmptyLatentImage", "inputs": {"width": width, "height": height, "batch_size": 1}},
        "5": {"class_type": "KSampler", "inputs": {
            "seed": seed, "steps": 26, "cfg": 6.0, "sampler_name": "euler", "scheduler": "normal",
            "denoise": 1, "model": ["1", 0], "positive": ["2", 0], "negative": ["3", 0], "latent_image": ["4", 0]}},
        "6": {"class_type": "VAEDecode", "inputs": {"samples": ["5", 0], "vae": ["1", 2]}},
        "7": {"class_type": "SaveImage", "inputs": {"filename_prefix": prefix, "images": ["6", 0]}},
    }
    data = wait_image(post_prompt(workflow))
    return Image.open(io.BytesIO(data)).convert("RGB")


# --------------------------------------------------------------- layer extraction

def chroma_key(rgb: Image.Image) -> Image.Image:
    """Green-screen key -> straight-alpha RGBA, with light spill suppression."""
    arr = np.asarray(rgb, dtype=np.float32)
    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
    greenness = np.clip((g - np.maximum(r, b)) / 90.0, 0.0, 1.0)
    alpha = np.clip(1.0 - greenness * 1.6, 0.0, 1.0)
    alpha[(g > 110) & (g - r > 40) & (g - b > 30)] = 0.0
    out = arr.copy()
    spill = np.minimum(g, (r + b) / 2.0 + 12.0)
    out[..., 1] = np.where(greenness > 0.15, spill, g)
    rgba = np.dstack([out, alpha * 255.0]).astype(np.uint8)
    image = Image.fromarray(rgba, "RGBA")
    image.putalpha(image.split()[3].filter(ImageFilter.GaussianBlur(1.2)))
    return image


def content_bbox(rgba: Image.Image) -> tuple:
    alpha = np.asarray(rgba.split()[3])
    ys, xs = np.where(alpha > 24)
    if len(xs) == 0:
        return (0, 0, rgba.width, rgba.height)
    return (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)


def feathered_region(source: Image.Image, cx: float, cy: float, rx: float, ry: float, canvas: tuple) -> Image.Image:
    """Elliptical, feathered cut-out of `source` on a transparent full canvas."""
    mask = Image.new("L", canvas, 0)
    ImageDraw.Draw(mask).ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(rx * 0.16))
    src = source.resize(canvas) if source.size != canvas else source
    combined = np.minimum(np.asarray(src.split()[3], dtype=np.uint16), np.asarray(mask, dtype=np.uint16))
    layer = src.copy()
    layer.putalpha(Image.fromarray(combined.astype(np.uint8)))
    return layer


def feathered_regions(source: Image.Image, ellipses: list[tuple[float, float, float, float]], canvas: tuple) -> Image.Image:
    """One registered layer from several tightly bounded feature masks."""
    mask = Image.new("L", canvas, 0)
    draw = ImageDraw.Draw(mask)
    for cx, cy, rx, ry in ellipses:
        draw.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=255)
    minimum_radius = min(min(rx, ry) for _, _, rx, ry in ellipses)
    mask = mask.filter(ImageFilter.GaussianBlur(max(1.5, minimum_radius * 0.08)))
    src = source.resize(canvas) if source.size != canvas else source
    combined = np.minimum(np.asarray(src.split()[3], dtype=np.uint16), np.asarray(mask, dtype=np.uint16))
    layer = src.copy()
    layer.putalpha(Image.fromarray(combined.astype(np.uint8)))
    return layer


def split_character(char_rgb: Image.Image) -> dict:
    """Key the green screen, scale the bust to ~96% frame height keeping aspect, place
    it centred with the head near the top, then cut feathered feature layers from that
    placed canvas so every character layer is a 1920x1080 cut-out in register."""
    keyed = chroma_key(char_rgb)
    x0, y0, x1, y1 = content_bbox(keyed)
    bw, bh = x1 - x0, y1 - y0
    scale = (H * 0.96) / bh
    new = keyed.resize((max(1, round(keyed.width * scale)), max(1, round(keyed.height * scale))))
    nx0, ny0 = round(x0 * scale), round(y0 * scale)
    nbw, nbh = round(bw * scale), round(bh * scale)
    canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    off_x = round(W * 0.5 - (nx0 + nbw * 0.5))
    off_y = round(H * 0.03 - ny0)
    canvas.paste(new, (off_x, off_y), new)

    bx = W * 0.5
    by_top = off_y + ny0
    face_top = by_top + nbh * 0.05
    face_h = nbh * 0.40
    eyes_y = face_top + face_h * 0.44
    mouth_y = face_top + face_h * 0.74
    eye_masks = [
        (bx - nbw * 0.145, eyes_y, nbw * 0.115, face_h * 0.115),
        (bx + nbw * 0.145, eyes_y, nbw * 0.115, face_h * 0.115),
    ]
    eyes_layer = feathered_regions(canvas, eye_masks, (W, H))
    mouth_layer = feathered_region(canvas, bx, mouth_y, nbw * 0.13, face_h * 0.09, (W, H))
    front_hair = feathered_region(
        canvas, bx, face_top + face_h * 0.02, nbw * 0.40, face_h * 0.44, (W, H)
    )
    # The crude ellipse must not carry eyes/forehead skin into the rotating hair
    # layer. Keep only the upper/bang region; semantic decomposition replaces this.
    hair_alpha = np.asarray(front_hair.split()[3], dtype=np.uint8).copy()
    rgb = np.asarray(canvas, dtype=np.uint8)[:, :, :3]
    luminance = rgb[:, :, 0] * 0.2126 + rgb[:, :, 1] * 0.7152 + rgb[:, :, 2] * 0.0722
    hair_alpha[luminance >= 180] = 0
    cutoff = round(eyes_y - face_h * 0.07)
    feather_rows = max(2, round(face_h * 0.025))
    for row in range(max(0, cutoff - feather_rows), min(H, cutoff)):
        hair_alpha[row] = (hair_alpha[row].astype(np.float32) * (cutoff - row) / feather_rows).astype(np.uint8)
    hair_alpha[max(0, cutoff):] = 0
    front_hair.putalpha(Image.fromarray(hair_alpha))
    # Remove the source eyes/mouth from the base with bounded classical inpainting.
    # This is still a crude stand-in for semantic layer decomposition, but it avoids
    # the large translucent blur patches that made the first proof read as a puppet.
    hole = Image.new("L", (W, H), 0)
    hd = ImageDraw.Draw(hole)
    for cx, cy, rx, ry in eye_masks:
        hd.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=255)
    hd.ellipse([bx - nbw * 0.12, mouth_y - face_h * 0.075, bx + nbw * 0.12, mouth_y + face_h * 0.075], fill=255)
    rgba = np.asarray(canvas, dtype=np.uint8)
    inpainted = rgba.copy()
    inpainted[:, :, :3] = cv2.inpaint(rgba[:, :, :3], np.asarray(hole), 7, cv2.INPAINT_TELEA)
    filled = Image.fromarray(inpainted, "RGBA")
    feather = hole.filter(ImageFilter.GaussianBlur(max(2.0, face_h * 0.012)))
    body = Image.composite(filled, canvas, feather)
    layers = {
        "body": body,
        "front_hair": front_hair,
        "eyes": eyes_layer,
        "mouth": mouth_layer,
    }
    pivots = {
        "front_hair": [bx / W, (face_top - face_h * 0.05) / H],
        "eyes": [bx / W, eyes_y / H],
        "mouth": [bx / W, (mouth_y - face_h * 0.08) / H],
    }
    return {"layers": layers, "pivots": pivots, "headPivot": [0.5, (face_top + face_h * 1.05) / H]}


def split_background(bg_rgb: Image.Image) -> dict:
    bg = bg_rgb.resize((W, H)).convert("RGBA")
    arr = np.asarray(bg).astype(np.float32)
    seam = int(H * 0.58)
    ramp = np.clip((np.arange(H) - (seam - 60)) / 120.0, 0.0, 1.0)[:, None]
    far = arr.copy()
    near = arr.copy()
    far[..., 3] = arr[..., 3] * (1.0 - ramp)
    near[..., 3] = arr[..., 3] * ramp
    far_img = Image.fromarray(far.astype(np.uint8), "RGBA").filter(ImageFilter.GaussianBlur(2.5))
    near_img = Image.fromarray(near.astype(np.uint8), "RGBA")
    return {"bg_far": far_img, "bg_near": near_img}


# ---------------------------------------------------------------- synthetic voice

MORAE = [("a", 660, 1080), ("me", 400, 1700), ("da", 700, 1220), ("ne", 420, 2100)]
SR = 24000


def synth_line(path: Path) -> dict:
    samples = [np.zeros(int(0.15 * SR))]
    tokens = []
    cursor = 0.15
    gap = 0.05
    for text, f1, f2 in MORAE:
        dur = 0.20 if text in ("a", "da") else 0.26
        n = int(dur * SR)
        tt = np.arange(n) / SR
        env = np.sin(np.pi * np.clip(tt / dur, 0, 1)) ** 0.6
        tone = (0.5 * np.sin(2 * np.pi * 130 * tt)
                + 0.32 * np.sin(2 * np.pi * f1 * tt)
                + 0.2 * np.sin(2 * np.pi * f2 * tt))
        samples.append(np.zeros(int(gap * SR)))
        samples.append(env * tone * 0.5)
        tokens.append({"text": text, "start": round(cursor, 3), "end": round(cursor + dur, 3), "conf": 1.0})
        cursor += gap + dur
    samples.append(np.zeros(int(0.2 * SR)))
    pcm = np.clip(np.concatenate(samples), -1, 1)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SR)
        handle.writeframes(b"".join(struct.pack("<h", int(v * 32767)) for v in pcm))
    return {
        "tokens": tokens,
        "speechStart": tokens[0]["start"],
        "speechEnd": tokens[-1]["end"],
        "note": "authored from synthesizer mora timing; not a forced aligner",
    }


# --------------------------------------------------------------------------- main

def main() -> int:
    reuse_sources = "--reuse-sources" in sys.argv[1:]
    if SLICE_DIR.exists():
        shutil.rmtree(SLICE_DIR)
    SLICE_DIR.mkdir(parents=True)
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    ffmpeg = shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        print("ffmpeg/ffprobe not found on PATH", file=sys.stderr)
        return 2

    if reuse_sources:
        print("[1/5] reusing accepted character + background source drawings ...")
        char = Image.open(REPORT_DIR / "source-character.png").convert("RGB")
        bg = Image.open(REPORT_DIR / "source-background.png").convert("RGB")
    else:
        print("[1/5] generating character + background via local ComfyUI ...")
        char = txt2img(
            f"{STYLE}, 1girl, solo, upper body portrait, short dark bob hair, teal eyes, "
            f"grey hoodie, calm expression, looking at viewer, flat solid chroma key green background, "
            f"simple background", NEG + ", detailed background, scenery", 1024, 1024, 7, "MakeWatch/slice-char")
        bg = txt2img(
            f"{STYLE}, rainy Tokyo side street at dusk, wet asphalt reflections, neon signage bokeh, "
            f"no people, establishing shot", NEG + ", 1girl, person, character", 1344, 768, 11, "MakeWatch/slice-bg")
        char.save(REPORT_DIR / "source-character.png")
        bg.save(REPORT_DIR / "source-background.png")

    print("[2/5] splitting layers ...")
    character = split_character(char)
    plates = split_background(bg)
    for name, image in {**plates, **character["layers"]}.items():
        image.save(SLICE_DIR / f"{name}.png")

    print("[3/5] synthesizing Japanese line + alignment ...")
    alignment = synth_line(SLICE_DIR / "line.wav")
    (SLICE_DIR / "line.align.json").write_text(json.dumps(alignment, ensure_ascii=False, indent=2), encoding="utf-8")

    pv = character["pivots"]
    shot_anim = {
        "schema": "makewatch.shotAnim/1",
        "shotId": "shot.slice.milestone0",
        "durationSeconds": DURATION,
        "fps": FPS,
        "resolution": [W, H],
        "background": {"color": [10, 12, 20]},
        "grain": 0.02,
        "headPivot": character["headPivot"],
        "layers": [
            {"id": "bg_far", "part": "plate", "path": "anime/slice/bg_far.png", "z": 0, "parallax": 0.14},
            {"id": "bg_near", "part": "plate", "path": "anime/slice/bg_near.png", "z": 1, "parallax": 0.5},
            {"id": "body", "part": "torso", "path": "anime/slice/body.png", "z": 10, "parallax": 1.0,
             "curves": {"breathe": [{"t": 0, "v": 0}, {"t": 2.0, "v": 1, "ease": "easeInOut"}, {"t": 4.0, "v": 0, "ease": "easeInOut"}]}},
            {"id": "front_hair", "part": "front_hair", "path": "anime/slice/front_hair.png", "z": 20, "parallax": 1.0,
             "pivot": pv["front_hair"],
             "dynamic": {"segments": 3, "stiffness": 0.30, "damping": 0.10, "gravity": 0.55, "maxDeg": 14},
             "curves": {"headAngleZ": [{"t": 0, "v": 0}, {"t": 1.6, "v": 0}, {"t": 2.6, "v": -2.2, "ease": "easeOut"}, {"t": 4.0, "v": -1.2, "ease": "easeInOut"}],
                        "headBob": [{"t": 0, "v": 0}, {"t": 2.0, "v": 2.5, "ease": "easeInOut"}, {"t": 4.0, "v": 0, "ease": "easeInOut"}],
                        "blink": [{"t": 1.05, "v": 1}, {"t": 3.15, "v": 1}]}},
            {"id": "eyes", "part": "eyes", "path": "anime/slice/eyes.png", "z": 21, "parallax": 1.0,
             "pivot": pv["eyes"],
             "curves": {"eyeLookX": [{"t": 0, "v": 0}, {"t": 1.3, "v": 0}, {"t": 1.9, "v": -0.75, "ease": "easeInOut"}, {"t": 3.4, "v": -0.75}, {"t": 3.9, "v": 0, "ease": "easeInOut"}],
                        "eyeLookY": [{"t": 0, "v": 0}, {"t": 2.0, "v": 0.25, "ease": "easeInOut"}, {"t": 4.0, "v": 0}]}},
            {"id": "mouth", "part": "mouth", "path": "anime/slice/mouth.png", "z": 22, "parallax": 1.0,
             "pivot": pv["mouth"]},
        ],
        "camera": {"keyframes": [
            {"t": 0.0, "x": 0.0, "y": 0.0, "zoom": 1.0, "rot": 0},
            {"t": 4.0, "x": 0.012, "y": -0.014, "zoom": 1.06, "rot": 0, "ease": "easeInOut"}]},
        "dialogue": [{"id": "dlg.01", "startSeconds": 0.7, "language": "ja",
                      "audioPath": "anime/slice/line.wav", "alignmentPath": "anime/slice/line.align.json",
                      "mouthSource": "alignment"}],
        "subtitles": [{"text": "Yağmur yağıyor, değil mi?", "startSeconds": 0.7, "endSeconds": 3.6, "language": "tr"}],
    }

    request = {
        "shotAnim": shot_anim,
        "projectMediaRoot": str(MEDIA),
        "outputFile": str(REPORT_DIR / "slice.mp4"),
        "ffmpeg": ffmpeg,
        "ffprobe": ffprobe,
        "seed": 20260830,
    }
    request_path = REPORT_DIR / "request.json"
    request_path.write_text(json.dumps(request), encoding="utf-8")

    print("[4/5] rendering with native-anime-worker.py (no video model) ...")
    started = time.time()
    proc = subprocess.run([sys.executable, str(Path(__file__).with_name("native-anime-worker.py")),
                           "--request", str(request_path)], capture_output=True, text=True)
    render_s = time.time() - started
    result_line = next((ln for ln in proc.stdout.splitlines() if ln.startswith("MW_TEMPORAL_RESULT_V1\t")), None)
    if not result_line:
        print(proc.stdout[-2000:], proc.stderr[-2000:], sep="\n", file=sys.stderr)
        return 3
    result = json.loads(result_line.split("\t", 1)[1])
    if not result.get("ok"):
        print("worker error:", result.get("error"), file=sys.stderr)
        return 3
    payload = result["result"]

    print("[5/5] probing + contact sheet ...")
    probe = subprocess.run([ffprobe, "-v", "error", "-show_entries",
                            "stream=codec_type,width,height,avg_frame_rate,nb_read_packets:format=duration",
                            "-count_packets", "-of", "json", str(REPORT_DIR / "slice.mp4")],
                           capture_output=True, text=True)
    probe_json = json.loads(probe.stdout or "{}")
    subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-i", str(REPORT_DIR / "slice.mp4"),
                    "-vf", "select='not(mod(n\\,11))',scale=480:-1,tile=4x3", "-frames:v", "1",
                    str(REPORT_DIR / "contact-sheet.png")], check=False)

    layer_bytes = sum(p.stat().st_size for p in SLICE_DIR.glob("*"))
    mp4_bytes = (REPORT_DIR / "slice.mp4").stat().st_size
    metrics = {
        "output": str(REPORT_DIR / "slice.mp4"),
        "worker": payload,
        "ffprobe": probe_json,
        "renderSeconds": round(render_s, 2),
        "renderSecondsPerOutputSecond": round(render_s / DURATION, 2),
        "persistentBytes": {
            "reusable_layers_and_audio": layer_bytes,
            "final_mp4": mp4_bytes,
            "total": layer_bytes + mp4_bytes,
            "intermediate_frames_on_disk": 0,
        },
        "layerFiles": {p.name: p.stat().st_size for p in sorted(SLICE_DIR.glob("*"))},
    }
    (REPORT_DIR / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    print(json.dumps(metrics, indent=2))
    print(f"\nOK  ->  {REPORT_DIR / 'slice.mp4'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
