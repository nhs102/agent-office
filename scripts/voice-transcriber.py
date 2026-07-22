#!/usr/bin/env python3
import json
import os
import sys
import time

import mlx_whisper


MODEL = os.environ.get(
    "VOICE_WHISPER_MODEL", "mlx-community/whisper-small-mlx"
)
LANGUAGE = os.environ.get("VOICE_WHISPER_LANGUAGE", "ko")
INITIAL_PROMPT = (
    "Agent Office 음성 명령입니다. 치프, 대표님, PM, 엔지니어, 재무, "
    "파견, 리서처, 디자이너, QA 같은 업무 용어가 나올 수 있습니다."
)


for raw_line in sys.stdin:
    try:
        request = json.loads(raw_line)
        if request.get("action") == "quit":
            break
        request_id = str(request["id"])
        audio_path = str(request["path"])
        started = time.monotonic()
        result = mlx_whisper.transcribe(
            audio_path,
            path_or_hf_repo=MODEL,
            language=LANGUAGE,
            task="transcribe",
            verbose=None,
            condition_on_previous_text=False,
            initial_prompt=INITIAL_PROMPT,
        )
        print(
            json.dumps(
                {
                    "id": request_id,
                    "text": str(result.get("text", "")).strip(),
                    "elapsedMs": round((time.monotonic() - started) * 1000),
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
    except Exception as error:  # noqa: BLE001 - worker must report every request failure
        print(
            json.dumps(
                {
                    "id": str(request.get("id", "unknown"))
                    if "request" in locals()
                    else "unknown",
                    "error": f"{type(error).__name__}: {error}",
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
