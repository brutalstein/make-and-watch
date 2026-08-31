"""Deterministic render self-test for tools/anime/native-anime-worker.py.

Draws a handful of procedural shape layers (no ComfyUI), renders two short clips
through the worker and asserts:
  * the MP4 probes as real video (right dimensions, frame count, has audio);
  * both runs produce a bit-identical framesSha256 (the renderer is deterministic).

Not wired into verify.ps1 because it needs numpy + Pillow + OpenCV + ffmpeg. Run:
  python tools/anime/native-anime-worker-selftest.py
"""

from __future__ import annotations

import json
import runpy
import shutil
import struct
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

WORKER = Path(__file__).with_name("native-anime-worker.py")
W, H, FPS, DUR = 320, 180, 24, 1.0


def shape_layer(path: Path, draw) -> None:
    image = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw(ImageDraw.Draw(image))
    image.save(path)


def sine_wav(path: Path) -> None:
    sr = 16000
    n = int(0.6 * sr)
    samples = (0.4 * np.sin(2 * np.pi * 320 * np.arange(n) / sr)) * np.hanning(n)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sr)
        handle.writeframes(b"".join(struct.pack("<h", int(v * 32767)) for v in samples))


def run(request_path: Path) -> dict:
    proc = subprocess.run([sys.executable, str(WORKER), "--request", str(request_path)],
                          capture_output=True, text=True)
    line = next((ln for ln in proc.stdout.splitlines() if ln.startswith("MW_TEMPORAL_RESULT_V1\t")), None)
    assert line, f"no result line\nstdout={proc.stdout}\nstderr={proc.stderr}"
    payload = json.loads(line.split("\t", 1)[1])
    assert payload.get("ok"), f"worker failed: {payload.get('error')}\n{proc.stderr}"
    return payload["result"]


def main() -> int:
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        print("SKIP: ffmpeg/ffprobe not on PATH")
        return 0
    tmp = Path(tempfile.mkdtemp(prefix="native-anime-selftest-"))
    try:
        media = tmp / ".makewatch"
        (media / "anime").mkdir(parents=True)
        shape_layer(media / "anime" / "bg.png", lambda d: d.rectangle([0, 0, W, H], fill=(30, 40, 70, 255)))
        shape_layer(media / "anime" / "body.png", lambda d: d.ellipse([120, 60, 200, 170], fill=(210, 180, 160, 255)))
        shape_layer(media / "anime" / "eyes.png", lambda d: (d.ellipse([138, 92, 152, 104], fill=(20, 20, 20, 255)),
                                                             d.ellipse([168, 92, 182, 104], fill=(20, 20, 20, 255))))
        shape_layer(media / "anime" / "mouth.png", lambda d: d.ellipse([150, 120, 170, 130], fill=(150, 60, 60, 255)))
        shape_layer(media / "anime" / "hair.png", lambda d: d.polygon([(118, 70), (200, 70), (196, 40), (122, 40)], fill=(60, 40, 30, 255)))
        sine_wav(media / "anime" / "line.wav")
        alignment_path = media / "anime" / "line.align.json"
        alignment_path.write_text(json.dumps({
            "schema": "makewatch.alignment/1", "sampleRate": 16000,
            "tokens": [{"text": "a", "readingKana": "ア", "startSample": 1600, "endSample": 4800, "confidence": 1.0},
                       {"text": "o", "readingKana": "オ", "startSample": 5600, "endSample": 8800, "confidence": 1.0}],
            "speechStartSample": 1600, "speechEndSample": 8800,
        }), encoding="utf-8")
        loaded_alignment = runpy.run_path(str(WORKER))["load_alignment"](alignment_path)
        assert loaded_alignment["tokens"][0]["start"] == 0.1, loaded_alignment
        assert loaded_alignment["tokens"][1]["end"] == 0.55, loaded_alignment

        shot_anim = {
            "schema": "makewatch.shotAnim/1", "shotId": "shot.selftest", "durationSeconds": DUR,
            "fps": FPS, "resolution": [W, H], "grain": 0.03, "headPivot": [0.5, 0.75],
            "layers": [
                {"id": "bg", "part": "plate", "path": "anime/bg.png", "z": 0, "parallax": 0.2},
                {"id": "body", "part": "torso", "path": "anime/body.png", "z": 10, "parallax": 1.0,
                 "curves": {"breathe": [{"t": 0, "v": 0}, {"t": 0.5, "v": 1, "ease": "easeInOut"}, {"t": 1.0, "v": 0}]}},
                {"id": "hair", "part": "front_hair", "path": "anime/hair.png", "z": 20, "parallax": 1.0,
                 "pivot": [0.5, 0.24], "dynamic": {"segments": 3, "maxDeg": 14},
                 "curves": {"headAngleZ": [{"t": 0, "v": 0}, {"t": 1.0, "v": -4, "ease": "easeOut"}],
                            "blink": [{"t": 0.5, "v": 1}]}},
                {"id": "eyes", "part": "eyes", "path": "anime/eyes.png", "z": 21, "parallax": 1.0, "pivot": [0.5, 0.54],
                 "curves": {"eyeLookX": [{"t": 0, "v": 0}, {"t": 1.0, "v": -1, "ease": "easeInOut"}]}},
                {"id": "mouth", "part": "mouth", "path": "anime/mouth.png", "z": 22, "parallax": 1.0, "pivot": [0.5, 0.68]},
            ],
            "camera": {"keyframes": [{"t": 0, "x": 0, "y": 0, "zoom": 1.0},
                                     {"t": 1.0, "x": 0.02, "y": -0.01, "zoom": 1.05, "ease": "easeInOut"}]},
            "dialogue": [{"id": "d0", "startSeconds": 0.1, "audioPath": "anime/line.wav",
                          "alignmentPath": "anime/line.align.json", "mouthSource": "alignment"}],
            "subtitles": [{"text": "test", "startSeconds": 0.1, "endSeconds": 0.9}],
        }

        hashes = []
        for i in range(2):
            out = tmp / f"out{i}.mp4"
            request = tmp / f"req{i}.json"
            request.write_text(json.dumps({
                "shotAnim": shot_anim, "projectMediaRoot": str(media), "outputFile": str(out),
                "ffmpeg": shutil.which("ffmpeg"), "ffprobe": shutil.which("ffprobe"), "seed": 777,
            }), encoding="utf-8")
            result = run(request)
            assert result["resolution"] == [W, H], result
            assert result["frameCount"] == round(DUR * FPS) == 24, result
            assert result["persistedIntermediateFrames"] == 0
            probe = subprocess.run([shutil.which("ffprobe"), "-v", "error", "-show_entries",
                                    "stream=codec_type:format=duration", "-of", "json", str(out)],
                                   capture_output=True, text=True)
            meta = json.loads(probe.stdout)
            types = {s["codec_type"] for s in meta.get("streams", [])}
            assert "video" in types and "audio" in types, meta
            assert abs(float(meta["format"]["duration"]) - DUR) < 0.2, meta
            hashes.append(result["framesSha256"])

        assert hashes[0] == hashes[1], f"renderer is not deterministic: {hashes}"
        assert len(hashes[0]) == 64
        print(f"native anime worker selftest passed (deterministic framesSha256={hashes[0][:16]}...)")

        # ---- M5: retargeted limb motion renders deterministically and moves pixels
        shape_layer(media / "anime" / "thigh.png", lambda d: d.rectangle([150, 100, 172, 150], fill=(120, 90, 200, 255)))
        shape_layer(media / "anime" / "shin.png", lambda d: d.rectangle([150, 146, 170, 188], fill=(90, 150, 200, 255)))
        skeleton = {"bones": [
            {"id": "root", "parent": None, "rest": {"x": 0.0, "y": 0.0, "rot": 0.0, "len": 0.0}},
            {"id": "hip", "parent": "root", "rest": {"x": 0.0, "y": 0.0, "rot": 0.0, "len": 0.0}},
            {"id": "spine", "parent": "hip", "rest": {"x": 0.0, "y": 0.0, "rot": -90.0, "len": 40.0}},
            {"id": "thigh_l", "parent": "hip", "rest": {"x": 0.0, "y": 0.0, "rot": 90.0, "len": 42.0}},
            {"id": "shin_l", "parent": "thigh_l", "rest": {"x": 42.0, "y": 0.0, "rot": 0.0, "len": 38.0}},
            {"id": "foot_l", "parent": "shin_l", "rest": {"x": 38.0, "y": 0.0, "rot": 0.0, "len": 12.0}},
        ]}
        motion_shot = json.loads(json.dumps(shot_anim))
        motion_shot["shotId"] = "shot.motion"
        motion_shot["layers"].append({"id": "char.hero.thigh", "part": "body", "path": "anime/thigh.png",
                                      "z": 15, "parallax": 1.0, "bone": "thigh_l", "curves": {}})
        motion_shot["layers"].append({"id": "char.hero.shin", "part": "body", "path": "anime/shin.png",
                                      "z": 16, "parallax": 1.0, "bone": "shin_l", "curves": {}})
        motion_shot["motion"] = [{
            "characterId": "char.hero", "fps": FPS, "pixelsPerUnit": 1.4, "loop": False,
            "screenAnchor": [0.5, 0.32], "skeleton": skeleton,
            "boneCurves": {
                "thigh_l": [{"t": 0.0, "v": 0.0}, {"t": 1.0, "v": 32.0, "ease": "easeInOut"}],
                "shin_l": [{"t": 0.0, "v": 0.0}, {"t": 1.0, "v": -24.0, "ease": "easeInOut"}],
            },
            "events": [{"t": 0.5, "kind": "contact", "bone": "foot_l"}],
            "rootMotion": [{"t": 0.0, "x": 0.0, "y": 0.0}, {"t": 1.0, "x": 5.0, "y": 0.0}],
        }]

        def render_motion(name: str, shot: dict) -> str:
            out = tmp / f"{name}.mp4"
            request = tmp / f"{name}.json"
            request.write_text(json.dumps({
                "shotAnim": shot, "projectMediaRoot": str(media), "outputFile": str(out),
                "ffmpeg": shutil.which("ffmpeg"), "ffprobe": shutil.which("ffprobe"), "seed": 777,
            }), encoding="utf-8")
            return run(request)["framesSha256"]

        motion_a = render_motion("motion0", motion_shot)
        motion_b = render_motion("motion1", motion_shot)
        assert motion_a == motion_b, f"motion render not deterministic: {motion_a} {motion_b}"

        flat_shot = json.loads(json.dumps(motion_shot))
        flat_shot["shotId"] = "shot.motionflat"
        flat_shot["motion"][0]["boneCurves"] = {"thigh_l": [{"t": 0.0, "v": 0.0}], "shin_l": [{"t": 0.0, "v": 0.0}]}
        flat_shot["motion"][0]["rootMotion"] = [{"t": 0.0, "x": 0.0, "y": 0.0}]
        assert render_motion("motionflat", flat_shot) != motion_a, "bone curves did not animate the limb layers"
        print(f"native anime motion selftest passed (framesSha256={motion_a[:16]}...)")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
