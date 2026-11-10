# Call Recording → Structured CRM Record (Local AI, CRM-Agnostic)

n8n workflow: turns a call recording into a structured CRM record — summary, pain
points, objections, competitor mentions, and (the differentiator) **rep
commitments** — without shipping audio to a third-party call-intelligence vendor.

## Why this exists

Gong/Chorus/Zoom IQ-class call intelligence, running on your own infrastructure.
No per-seat SaaS, no per-call API cost, no third party touching customer
conversations. Provider-agnostic by design:

- **AI provider**: if `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` is set, routes to
  cloud; otherwise falls back to local Ollama. Transcription uses Deepgram if
  `DEEPGRAM_API_KEY` is set, otherwise a local faster-whisper service
  (`services/whisper_service.py`). OpenAI transcription is not supported: the
  endpoint needs a multipart upload with a `model` field, and the earlier
  attempt posted raw bytes, so it was removed rather than left broken.
- **CRM**: adapter pattern with cases for Zoho, HubSpot, Salesforce, Pipedrive,
  monday.com, and a generic webhook default for anything else.

See `docs/spec.md` for the full build spec: positioning, acquisition-layer
design (Zoom/Teams/Meet/dialers/CRM-native/Recall.ai/folder-watch), the
extraction schema, known engineering constraints (VRAM contention, execution
timeouts, small-model hallucination risk), and packaging/go-to-market strategy.

## Status

What is verified, and how:

- **Node logic is tested outside n8n.** `npm test` runs the exact code that ships
  inside each Code node against synthetic transcripts and model responses for all
  three providers. 29 tests cover ingest, provider election, transcript
  normalization, chunking, response parsing, the reducer, the validator, the CRM
  adapters, and the workflow wiring.
- **The workflow file is a build output.** `src/nodes/*.js` is the source of
  truth; `npm run build` injects it into the workflow, and CI fails if the
  committed JSON differs.

What is not verified yet:

- **No end-to-end run inside n8n against a real recording.** Node `typeVersion`s
  and the If-node condition format were written from memory of n8n's node library
  and need a spot-check in a live instance.
- **No live CRM write.** Adapter payloads are tested for shape, not against the
  HubSpot, Zoho, Salesforce, Pipedrive or monday.com APIs.
- **The transcription service has not been load-tested.** Its path guard is unit
  tested; the model code needs a GPU to exercise.

## Guardrails

The model's own confidence score is self-reported, so it is not treated as
evidence. Between the model and the CRM, `Validate Extraction` checks the
extraction against the transcript:

| Check | Rule | On failure |
| --- | --- | --- |
| Shape | Required fields exist with the right types | Human review |
| Quotes | `verbatim_quote` must be an exact substring of the transcript | Quote stripped, flagged |
| Competitors | The name must appear in the transcript as whole words (`Clari` is not grounded by `clarify`) | Quarantined, human review |
| Rep commitments | At least half the content words must appear in the transcript, compared as whole words with common endings removed | Quarantined, human review |
| Numbers | Every number in a rep commitment must appear in the transcript | Quarantined, human review |
| Due dates | A `due` value must be made of words from the transcript | Due date stripped, flagged |
| Pipeline health | No chunk returned unparseable output; the record is not empty | Human review |

A record reaches the CRM adapter only if every hard check passes **and**
confidence clears `MIN_CONFIDENCE`. The gate fails closed, and a test asserts
that the review branch cannot reach `CRM Write`.

The commitment check is a heuristic. It catches invented commitments; it does not
prove a paraphrase is faithful, and it does not check that the words were spoken
by the rep rather than the prospect. A number written as digits when the speaker
said it in words (`20` for "twenty") is sent to review rather than passed. Quarantined items stay on the record under
`_quarantined` so a reviewer can see what was held back and why.

Inputs are constrained too: `meeting_id` and `audio_ref` are interpolated into
the ffmpeg command line, so shell metacharacters are stripped or rejected at
ingest.

## Known limitations

- **API keys travel in item data.** `Runtime Config` reads keys from the
  environment and passes them along in `_cfg` and `_req.headers`, so they appear
  in n8n execution data. Moving them to n8n credentials is the next change.
- **`Human Review Queue` is a placeholder.** Held records stop there; nothing
  notifies a reviewer yet.
- **CRM writes are not associated to a contact or deal.** The HubSpot and Zoho
  adapters create a standalone call record. Direction and duration are fixed
  values.
- **No retry or idempotency.** Re-running a recording creates a second record.

## Relationship to the monday.com CRM Audit project

This started as a spike inside that project (a monday.com CRM audit surfaces
"reps hand-typing call notes" as a finding — this workflow is the fix). It's
been split into its own repo because it's CRM-agnostic and stands as its own
product, not a monday-specific feature. The monday audit's `needs_external`
automation-fit classification points back here as a concrete example of "what
monday's native automation engine cannot do."

## Files

- `workflows/call-recording-to-crm.json` — the n8n workflow (built from `src/nodes`)
- `src/nodes/*.js` — the code for each Code node, one file per node
- `scripts/build-workflow.mjs` — injects `src/nodes` into the workflow
- `test/` — node tests, workflow wiring tests, and synthetic fixtures
- `test-support/harness.mjs` — runs Code-node source outside n8n
- `services/whisper_service.py` — local FastAPI transcription microservice
  (faster-whisper, dual-channel-aware, optional pyannote diarization fallback)
- `services/pathguard.py` — confines the service to its work directory
- `docs/spec.md` — full build spec

## Setup

Requires n8n. Set whichever of these apply:

```
OPENAI_API_KEY / ANTHROPIC_API_KEY       # cloud LLM (optional — falls back to Ollama)
OLLAMA_URL / OLLAMA_MODEL                # local LLM fallback
DEEPGRAM_API_KEY                         # cloud STT with diarization (optional)
CRM_PROVIDER                             # zoho | hubspot | salesforce | pipedrive | monday | webhook
CRM_TOKEN / CRM_BASE_URL / CRM_WEBHOOK_URL
MIN_CONFIDENCE                           # gate threshold, default 0.6
```

Local transcription service (binds to 127.0.0.1 and reads only from
`WHISPER_WORK_DIR`, default `/data/work`):

```
pip install fastapi uvicorn faster-whisper soundfile numpy
python services/whisper_service.py
```

## Development

Requires Node.js 22 or newer. No dependencies to install.

```
npm test          # node logic, validator, adapters, workflow wiring
npm run build     # rebuild the workflow after editing src/nodes
python -m unittest discover -s tests   # transcription service path guard
```

## Kill criterion

If a 7B local model can't produce stable, schema-valid extractions across five
real transcripts, the local-hardware differentiation collapses and this
becomes a generic API workflow with no real edge. Test that before building
anything downstream (entity resolution, async split, CRM upsert polish).
