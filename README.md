# Call Recording → Structured CRM Record (Local AI, CRM-Agnostic)

n8n workflow: turns a call recording into a structured CRM record — summary, pain
points, objections, competitor mentions, and (the differentiator) **rep
commitments** — without shipping audio to a third-party call-intelligence vendor.

## Why this exists

Gong/Chorus/Zoom IQ-class call intelligence, running on your own infrastructure.
No per-seat SaaS, no per-call API cost, no third party touching customer
conversations. Provider-agnostic by design:

- **AI provider**: if `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` is set, routes to
  cloud; otherwise falls back to local Ollama. Same for transcription — Deepgram
  or OpenAI Whisper API if a key is present, otherwise a local faster-whisper
  service (`docs/whisper_service.py`).
- **CRM**: adapter pattern with cases for Zoho, HubSpot, Salesforce, Pipedrive,
  monday.com, and a generic webhook default for anything else.

See `docs/spec.md` for the full build spec: positioning, acquisition-layer
design (Zoom/Teams/Meet/dialers/CRM-native/Recall.ai/folder-watch), the
extraction schema, known engineering constraints (VRAM contention, execution
timeouts, small-model hallucination risk), and packaging/go-to-market strategy.

## Status

Built, JSON-validated. Not yet run against a real call recording end-to-end —
node `typeVersion`s were written from memory of n8n's node library and should
be spot-checked against your n8n instance before a client-facing demo.

## Relationship to the monday.com CRM Audit project

This started as a spike inside that project (a monday.com CRM audit surfaces
"reps hand-typing call notes" as a finding — this workflow is the fix). It's
been split into its own repo because it's CRM-agnostic and stands as its own
product, not a monday-specific feature. The monday audit's `needs_external`
automation-fit classification points back here as a concrete example of "what
monday's native automation engine cannot do."

## Files

- `workflows/call-recording-to-crm.json` — the n8n workflow
- `docs/spec.md` — full build spec
- `docs/whisper_service.py` — local FastAPI transcription microservice
  (faster-whisper, dual-channel-aware, optional pyannote diarization fallback)

## Setup

Requires n8n. Set whichever of these apply:

```
OPENAI_API_KEY / ANTHROPIC_API_KEY       # cloud LLM (optional — falls back to Ollama)
OLLAMA_URL / OLLAMA_MODEL                # local LLM fallback
DEEPGRAM_API_KEY                         # cloud STT with diarization (optional)
MIN_CONFIDENCE                           # confidence gate threshold, default in workflow
```

Local transcription service:

```
pip install fastapi uvicorn faster-whisper soundfile numpy
python docs/whisper_service.py
```

## Kill criterion

If a 7B local model can't produce stable, schema-valid extractions across five
real transcripts, the local-hardware differentiation collapses and this
becomes a generic API workflow with no real edge. Test that before building
anything downstream (entity resolution, async split, CRM upsert polish).
