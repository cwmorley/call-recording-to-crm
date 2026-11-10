"""
Local transcription service for the n8n Call-to-CRM workflow.

    pip install fastapi uvicorn faster-whisper soundfile numpy
    python services/whisper_service.py        # -> http://127.0.0.1:8000

POST /transcribe
    {"path": "/data/work/abc.wav", "meeting_id": "abc",
     "channels": "mono|dual", "diarize": true}

Returns
    {"meeting_id": ..., "text": ..., "segments": [{speaker,start,end,text}, ...]}

Design notes
------------
* Models are loaded ONCE and held. Reloading weights per request dominates runtime.
* channels="dual" is the happy path: the dialer recorded each leg on its own channel,
  so speaker attribution is exact and free. Diarization is skipped entirely.
* On an 8GB card, distil-large-v3 / large-v3-turbo give near-parity accuracy at a
  fraction of the VRAM and time of large-v3. Leave headroom -- the LLM needs it next.

Security notes
--------------
* The service has no authentication. It binds to 127.0.0.1 by default; set
  WHISPER_HOST=0.0.0.0 only on a private network (for example, a Docker network
  shared with n8n).
* Every requested path must resolve inside WHISPER_WORK_DIR (default /data/work).
"""

from __future__ import annotations

import gc
import os
from contextlib import asynccontextmanager
from typing import Any

import soundfile as sf
from fastapi import FastAPI, HTTPException
from faster_whisper import WhisperModel
from pydantic import BaseModel

from pathguard import PathNotAllowed, resolve_in_workdir

MODEL_SIZE = os.getenv("WHISPER_MODEL", "distil-large-v3")
DEVICE = os.getenv("WHISPER_DEVICE", "cuda")
COMPUTE = os.getenv("WHISPER_COMPUTE", "int8_float16")  # 8GB-friendly
WORK_DIR = os.getenv("WHISPER_WORK_DIR", "/data/work")
HOST = os.getenv("WHISPER_HOST", "127.0.0.1")

model: WhisperModel | None = None
_diarizer: Any = None


@asynccontextmanager
async def lifespan(_: FastAPI):
    global model
    print(f"[whisper] loading {MODEL_SIZE} on {DEVICE} ({COMPUTE}) ...")
    model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE)
    print("[whisper] ready")
    yield


app = FastAPI(title="Local Transcription Service", lifespan=lifespan)


class Req(BaseModel):
    path: str
    meeting_id: str = "unknown"
    channels: str = "mono"
    diarize: bool = True


def _transcribe(path: str, label: str | None) -> list[dict[str, Any]]:
    segments, _ = model.transcribe(
        path,
        beam_size=5,
        vad_filter=True,  # drops silence; big speedup on real calls
        vad_parameters={"min_silence_duration_ms": 500},
    )
    return [
        {
            "speaker": label or "SPEAKER",
            "start": round(s.start, 2),
            "end": round(s.end, 2),
            "text": s.text.strip(),
        }
        for s in segments
        if s.text and s.text.strip()
    ]


def _split_channels(path: str) -> tuple[str, str] | None:
    """Write each channel of a stereo file to its own mono wav. None if not stereo."""
    data, sr = sf.read(path, always_2d=True)
    if data.shape[1] < 2:
        return None
    base = os.path.splitext(path)[0]
    left, right = f"{base}_L.wav", f"{base}_R.wav"
    sf.write(left, data[:, 0], sr)
    sf.write(right, data[:, 1], sr)
    return left, right


def _get_diarizer() -> Any:
    """Load the pyannote pipeline once. Requires pyannote.audio and HF_TOKEN."""
    global _diarizer
    if _diarizer is None:
        from pyannote.audio import Pipeline

        token = os.getenv("HF_TOKEN")
        if not token:
            raise RuntimeError("HF_TOKEN not set")
        _diarizer = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-3.1", use_auth_token=token
        )
    return _diarizer


@app.post("/transcribe")
def transcribe(req: Req) -> dict[str, Any]:
    if model is None:
        raise HTTPException(503, "model not loaded yet")
    try:
        path = str(resolve_in_workdir(req.path, WORK_DIR))
    except PathNotAllowed as error:
        raise HTTPException(403, str(error)) from error
    if not os.path.isfile(path):
        raise HTTPException(404, "file not found")

    segments: list[dict[str, Any]] = []
    diarization = "none"

    if req.channels == "dual":
        # Best case -- exact speaker separation, no diarization model needed.
        pair = _split_channels(path)
        if pair is None:
            segments = _transcribe(path, "SPEAKER")
        else:
            left, right = pair
            try:
                segments = _transcribe(left, "REP") + _transcribe(right, "PROSPECT")
            finally:
                for f in (left, right):
                    try:
                        os.remove(f)
                    except OSError:
                        pass
            segments.sort(key=lambda s: s["start"])
            diarization = "channel"

    elif req.diarize:
        # Mono + diarization. Falls back to unlabelled rather than failing the run,
        # and reports the fallback so the workflow can see it happened.
        try:
            turns = list(_get_diarizer()(path).itertracks(yield_label=True))
            segments = _transcribe(path, None)
            for seg in segments:
                mid = (seg["start"] + seg["end"]) / 2
                for turn, _, spk in turns:
                    if turn.start <= mid <= turn.end:
                        seg["speaker"] = spk
                        break
            diarization = "pyannote"
        except Exception as e:  # noqa: BLE001 - degrade, never hard-fail the pipeline
            print(f"[whisper] diarization unavailable ({e}); continuing unlabelled")
            segments = _transcribe(path, "SPEAKER")
            diarization = "unavailable"
    else:
        segments = _transcribe(path, "SPEAKER")

    gc.collect()
    return {
        "meeting_id": req.meeting_id,
        "model": MODEL_SIZE,
        "diarization": diarization,
        "segment_count": len(segments),
        "text": " ".join(s["text"] for s in segments),
        "segments": segments,
    }


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": model is not None, "model": MODEL_SIZE, "device": DEVICE}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=HOST, port=int(os.getenv("PORT", "8000")))
