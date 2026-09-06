"""
Local transcription service for the n8n Call-to-CRM workflow.

    pip install fastapi uvicorn faster-whisper soundfile numpy
    python whisper_service.py            # -> http://0.0.0.0:8000

POST /transcribe
    {"path": "/data/work/abc.wav", "meeting_id": "abc",
     "channels": "mono|dual", "diarize": true}

Returns
    {"meeting_id": ..., "text": ..., "segments": [{speaker,start,end,text}, ...]}

Design notes
------------
* Model is loaded ONCE at startup and held. Do not shell out to the CLI per call --
  reloading weights on every execution dominates runtime.
* channels="dual" is the happy path: the dialer recorded each leg on its own channel,
  so speaker attribution is exact and free. Diarization is skipped entirely.
* On an 8GB card, distil-large-v3 / large-v3-turbo give near-parity accuracy at a
  fraction of the VRAM and time of large-v3. Leave headroom -- the LLM needs it next.
"""

import os
import gc
from typing import List, Dict, Any, Optional

import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from faster_whisper import WhisperModel

MODEL_SIZE = os.getenv("WHISPER_MODEL", "distil-large-v3")
DEVICE = os.getenv("WHISPER_DEVICE", "cuda")
COMPUTE = os.getenv("WHISPER_COMPUTE", "int8_float16")  # 8GB-friendly

app = FastAPI(title="Local Transcription Service")
model: Optional[WhisperModel] = None


@app.on_event("startup")
def _load() -> None:
    global model
    print(f"[whisper] loading {MODEL_SIZE} on {DEVICE} ({COMPUTE}) ...")
    model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE)
    print("[whisper] ready")


class Req(BaseModel):
    path: str
    meeting_id: str = "unknown"
    channels: str = "mono"
    diarize: bool = True


def _transcribe(path: str, label: Optional[str]) -> List[Dict[str, Any]]:
    segments, _ = model.transcribe(
        path,
        beam_size=5,
        vad_filter=True,                       # drops silence; big speedup on real calls
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


def _split_channels(path: str) -> Optional[tuple]:
    """Write each channel of a stereo file to its own mono wav. None if not stereo."""
    data, sr = sf.read(path, always_2d=True)
    if data.shape[1] < 2:
        return None
    base = os.path.splitext(path)[0]
    left, right = f"{base}_L.wav", f"{base}_R.wav"
    sf.write(left, data[:, 0], sr)
    sf.write(right, data[:, 1], sr)
    return left, right


@app.post("/transcribe")
def transcribe(req: Req) -> Dict[str, Any]:
    if model is None:
        raise HTTPException(503, "model not loaded yet")
    if not os.path.exists(req.path):
        raise HTTPException(404, f"file not found: {req.path}")

    segments: List[Dict[str, Any]] = []

    if req.channels == "dual":
        # Best case -- exact speaker separation, no diarization model needed.
        pair = _split_channels(req.path)
        if pair is None:
            segments = _transcribe(req.path, "SPEAKER")
        else:
            left, right = pair
            segments = _transcribe(left, "REP") + _transcribe(right, "PROSPECT")
            segments.sort(key=lambda s: s["start"])
            for f in (left, right):
                try:
                    os.remove(f)
                except OSError:
                    pass

    elif req.diarize:
        # Mono + diarization. Requires: pip install pyannote.audio, and a HuggingFace
        # token with access to pyannote/speaker-diarization-3.1 (gated model).
        # Falls back to unlabelled rather than failing the whole run.
        try:
            from pyannote.audio import Pipeline

            token = os.getenv("HF_TOKEN")
            if not token:
                raise RuntimeError("HF_TOKEN not set")
            pipe = Pipeline.from_pretrained(
                "pyannote/speaker-diarization-3.1", use_auth_token=token
            )
            turns = list(pipe(req.path).itertracks(yield_label=True))
            segments = _transcribe(req.path, None)
            for seg in segments:
                mid = (seg["start"] + seg["end"]) / 2
                for turn, _, spk in turns:
                    if turn.start <= mid <= turn.end:
                        seg["speaker"] = spk
                        break
        except Exception as e:  # noqa: BLE001 - degrade, never hard-fail the pipeline
            print(f"[whisper] diarization unavailable ({e}); continuing unlabelled")
            segments = _transcribe(req.path, "SPEAKER")
    else:
        segments = _transcribe(req.path, "SPEAKER")

    gc.collect()
    return {
        "meeting_id": req.meeting_id,
        "model": MODEL_SIZE,
        "segment_count": len(segments),
        "text": " ".join(s["text"] for s in segments),
        "segments": segments,
    }


@app.get("/health")
def health() -> Dict[str, Any]:
    return {"ok": model is not None, "model": MODEL_SIZE, "device": DEVICE}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
