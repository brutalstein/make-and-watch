"""Headless adapter around an installed official FramePack checkout.

Make & Watch does not vendor FramePack's inference implementation. This worker
loads the user's explicit official checkout, suppresses only the Gradio server
launch, and invokes the upstream process() generator. The adapter is intentionally
shape-guarded: if upstream changes the expected entry surface, it fails before
loading multi-gigabyte models rather than guessing through an expensive run.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import runpy
import shutil
import sys
import traceback

RESULT_PREFIX = "MW_TEMPORAL_RESULT_V1\t"
MAX_PROMPT_CHARS = 12_000
MAX_SECONDS = 8.0


def fail(message: str, code: str = "worker_error") -> int:
    payload = {"ok": False, "error": {"code": code, "message": str(message)[:2000]}}
    print(RESULT_PREFIX + json.dumps(payload, separators=(",", ":")), flush=True)
    return 2


def load_request(path: Path) -> dict:
    if not path.is_file() or path.stat().st_size > 256 * 1024:
        raise ValueError("FramePack worker request file is missing or oversized")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("FramePack worker request must be a JSON object")
    return value


def bounded_request(value: dict) -> dict:
    root = Path(str(value.get("framepackRoot", ""))).resolve()
    input_image = Path(str(value.get("inputImage", ""))).resolve()
    output_file = Path(str(value.get("outputFile", ""))).resolve()
    prompt = str(value.get("prompt", "")).strip()
    negative = str(value.get("negativePrompt", "")).strip()
    duration = float(value.get("durationSeconds", 0))
    seed = int(value.get("seed", 31337))
    quality = str(value.get("qualityTier", "preview")).strip().lower()

    if not (root / "demo_gradio.py").is_file():
        raise ValueError("FramePack demo_gradio.py was not found in the selected installation")
    if not input_image.is_file():
        raise ValueError("FramePack input image does not exist")
    if not prompt or len(prompt) > MAX_PROMPT_CHARS:
        raise ValueError(f"FramePack prompt must contain 1..{MAX_PROMPT_CHARS} characters")
    if len(negative) > MAX_PROMPT_CHARS:
        raise ValueError("FramePack negative prompt exceeds bounded length")
    if not (1.0 <= duration <= MAX_SECONDS):
        raise ValueError(f"FramePack v1 Shot duration must be between 1 and {MAX_SECONDS:g} seconds")
    if not (0 <= seed <= 2**32 - 1):
        raise ValueError("FramePack seed must fit uint32")
    if quality not in {"draft", "preview", "final"}:
        raise ValueError("FramePack qualityTier must be draft, preview or final")

    return {
        "root": root,
        "input_image": input_image,
        "output_file": output_file,
        "prompt": prompt,
        "negative": negative,
        "duration": duration,
        "seed": seed,
        "quality": quality,
    }


def guard_upstream_shape(demo_path: Path) -> None:
    source = demo_path.read_text(encoding="utf-8", errors="replace")
    required = [
        "def process(input_image, prompt, n_prompt, seed, total_second_length",
        "latent_window_size",
        "gpu_memory_preservation",
        "use_teacache",
        "mp4_crf",
        "block.launch(",
    ]
    missing = [token for token in required if token not in source]
    if missing:
        raise RuntimeError(
            "Unsupported FramePack checkout shape; update the Make & Watch adapter before inference. "
            + "Missing: " + ", ".join(missing)
        )


def quality_settings(quality: str) -> dict:
    if quality == "draft":
        return {"steps": 20, "teacache": True, "crf": 20}
    if quality == "final":
        return {"steps": 25, "teacache": False, "crf": 12}
    return {"steps": 25, "teacache": True, "crf": 16}


def run_framepack(request: dict) -> dict:
    root: Path = request["root"]
    demo_path = root / "demo_gradio.py"
    guard_upstream_shape(demo_path)

    sys.path.insert(0, str(root))
    previous_argv = sys.argv[:]
    sys.argv = [str(demo_path)]

    import gradio as gr  # imported from the selected FramePack environment
    import numpy as np
    from PIL import Image

    original_launch = gr.Blocks.launch
    gr.Blocks.launch = lambda self, *args, **kwargs: self
    try:
        namespace = runpy.run_path(str(demo_path), run_name="makewatch_framepack_runtime")
    finally:
        gr.Blocks.launch = original_launch
        sys.argv = previous_argv

    process = namespace.get("process")
    if not callable(process):
        raise RuntimeError("FramePack checkout did not expose the guarded process() entry point")

    image = np.array(Image.open(request["input_image"]).convert("RGB"))
    settings = quality_settings(request["quality"])
    output_candidate = None

    # These values intentionally mirror upstream's documented/default controls.
    # Quality tiers only change the safe knobs FramePack itself exposes.
    generator = process(
        image,
        request["prompt"],
        request["negative"],
        request["seed"],
        request["duration"],
        9,      # latent_window_size: upstream says this should not change
        settings["steps"],
        1.0,    # cfg: upstream hidden default
        10.0,   # distilled guidance: upstream recommended default
        0.0,    # guidance rescale: upstream hidden default
        6.0,    # preserve memory aggressively on laptop-class GPUs
        settings["teacache"],
        settings["crf"],
    )
    for update in generator:
        if not isinstance(update, tuple) or not update:
            continue
        candidate = update[0]
        if isinstance(candidate, str) and candidate and Path(candidate).is_file():
            output_candidate = Path(candidate).resolve()

    if output_candidate is None or not output_candidate.is_file():
        raise RuntimeError("FramePack completed without exposing a video output file")

    output_file: Path = request["output_file"]
    output_file.parent.mkdir(parents=True, exist_ok=True)
    if output_candidate != output_file:
        shutil.copy2(output_candidate, output_file)
    return {
        "outputFile": str(output_file),
        "qualityTier": request["quality"],
        "teacache": settings["teacache"],
        "steps": settings["steps"],
        "upstreamOutput": str(output_candidate),
    }


def main() -> int:
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--request", required=True)
    args = parser.parse_args()
    try:
        request = bounded_request(load_request(Path(args.request).resolve()))
        result = run_framepack(request)
        print(RESULT_PREFIX + json.dumps({"ok": True, "result": result}, separators=(",", ":")), flush=True)
        return 0
    except Exception as error:  # worker boundary must always return one parseable final status
        traceback.print_exc(file=sys.stderr)
        return fail(error)


if __name__ == "__main__":
    raise SystemExit(main())
