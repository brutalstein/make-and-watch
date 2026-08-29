from __future__ import annotations

import json
import math
import os
import random
import sys
from pathlib import Path


def fail(message: str, result_path: Path | None = None) -> int:
    payload = {"ok": False, "error": str(message)[:2000]}
    if result_path is not None:
        result_path.parent.mkdir(parents=True, exist_ok=True)
        result_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    else:
        print(json.dumps(payload, ensure_ascii=False), file=sys.stderr)
    return 1


def clamp(value: object, fallback: float, minimum: float, maximum: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    if not math.isfinite(parsed):
        return fallback
    return max(minimum, min(maximum, parsed))


def main() -> int:
    if len(sys.argv) != 3:
        return fail("usage: chatterbox-worker.py <request.json> <result.json>")

    request_path = Path(sys.argv[1]).resolve()
    result_path = Path(sys.argv[2]).resolve()
    try:
        request = json.loads(request_path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        return fail(f"invalid request: {exc}", result_path)

    text = str(request.get("text", "")).strip()
    if not text or len(text) > 4000:
        return fail("text must contain between 1 and 4000 characters", result_path)

    language = str(request.get("language", "tr")).strip().lower() or "tr"
    output_path = Path(str(request.get("outputPath", ""))).resolve()
    if not output_path.name:
        return fail("outputPath is required", result_path)

    reference = request.get("audioPromptPath")
    audio_prompt_path = None
    if reference:
        candidate = Path(str(reference)).resolve()
        if not candidate.is_file():
            return fail(f"voice reference does not exist: {candidate}", result_path)
        audio_prompt_path = str(candidate)

    seed = int(request.get("seed", 0)) & 0xFFFFFFFF
    exaggeration = clamp(request.get("exaggeration"), 0.5, 0.25, 1.5)
    cfg_weight = clamp(request.get("cfgWeight"), 0.5, 0.0, 1.0)
    temperature = clamp(request.get("temperature"), 0.8, 0.05, 2.0)

    try:
        import numpy as np
        import torch
        import torchaudio as ta
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS

        torch.manual_seed(seed)
        random.seed(seed)
        np.random.seed(seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)
            device = "cuda"
        else:
            device = "cpu"

        model = ChatterboxMultilingualTTS.from_pretrained(device=device, t3_model="v3")
        supported = model.get_supported_languages()
        if language not in supported:
            return fail(f"unsupported Chatterbox language: {language}", result_path)

        kwargs = {
            "language_id": language,
            "exaggeration": exaggeration,
            "cfg_weight": cfg_weight,
            "temperature": temperature,
        }
        if audio_prompt_path:
            kwargs["audio_prompt_path"] = audio_prompt_path

        wav = model.generate(text, **kwargs)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        ta.save(str(output_path), wav, model.sr)
        frames = int(wav.shape[-1])
        duration = frames / float(model.sr)
        payload = {
            "ok": True,
            "outputPath": str(output_path),
            "sampleRate": int(model.sr),
            "frames": frames,
            "durationSeconds": duration,
            "device": device,
            "model": "Chatterbox Multilingual V3",
            "language": language,
            "seed": seed,
            "watermarked": True,
            "voiceReferenceUsed": bool(audio_prompt_path),
        }
        result_path.parent.mkdir(parents=True, exist_ok=True)
        result_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        return 0
    except Exception as exc:  # noqa: BLE001
        return fail(f"voice generation failed: {exc}", result_path)


if __name__ == "__main__":
    raise SystemExit(main())
