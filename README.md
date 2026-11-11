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
  inside each Code node against synthetic transcripts and model responses.
  70 tests cover ingest, provider election, transcript normalization, chunking,
  response parsing, the reducer, the validator (including speaker attribution), the review path, the CRM
  adapters, key handling, the workflow wiring, and the eval scorer. 5 Python
  tests cover the transcription service's path guard.
- **The workflow file is a build output.** `src/nodes/*.js` is the source of
  truth; `npm run build` injects it into the workflow, and CI fails if the
  committed JSON differs.
- **Node formats were checked against the n8n node source** (`n8n-io/n8n`,
  `packages/nodes-base`, master, November 2026): the `typeVersion` of every
  node used, the If v2 condition format, the HTTP Request parameter names, the
  Split In Batches output order (done, loop), and the fact that Execute Command
  outputs only `exitCode`, `stderr` and `stdout`.
- **The HubSpot payload was checked against HubSpot's documentation**: the
  [calls endpoint and property names](https://developers.hubspot.com/docs/api-reference/crm-calls-v3/guide)
  and the [association type ids](https://developers.hubspot.com/docs/api-reference/latest/crm/associations/associate-records/guide)
  (call to contact 194, company 182, deal 206).
- **Also checked against vendor documentation**: Deepgram `multichannel=true`,
  the Pipedrive `x-api-token` header, Zoho's mandatory Calls fields, and the
  OpenAI transcription endpoint's required form fields (the reason that path
  was removed).

What is not verified yet:

- **No end-to-end run inside n8n against a real recording.** Reading the node
  source is not the same as importing the workflow and running it.
- **No live CRM write.** No request in this repo has been sent to HubSpot, Zoho,
  Salesforce, Pipedrive or monday.com. Salesforce and monday payloads were not
  checked against documentation at all. Zoho documents `Call_Duration` as
  `HH:mm`, which is what the adapter sends; whether a live org reads it that
  way is unconfirmed. Whether HubSpot renders line breaks in `hs_call_body` is
  unconfirmed.
- **No model call through the workflow.** `evals/outputs/models/` holds extractions that four
  models produced from the repository's prompt and schema inside an agent session (see
  Evaluation). That is model output, but it did not go through the `LLM Call` node, the
  chunker, or any provider's API parameters as the workflow sends them.
- **The transcription service has not been run.** Its path guard is unit
  tested; the model and diarization code needs a GPU and model weights.
- **Whether `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` also unblocks `$env` in the
  HTTP node expression** that reads the Deepgram key was not confirmed.

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
| Speaker attribution | When segments are labelled `REP` and `PROSPECT`, a commitment's words and numbers must appear in the rep's turns | Quarantined with `commitment_wrong_speaker`, human review |
| Due dates | A `due` value must be made of words from the transcript | Due date stripped, flagged |
| Pipeline health | No chunk returned unparseable output; the record is not empty | Human review |

A record reaches the CRM adapter only if every hard check passes **and**
confidence clears `MIN_CONFIDENCE`. The gate fails closed, and a test asserts
that the review branch cannot reach `CRM Write`.

The commitment check is a heuristic. It catches invented commitments; it does not
prove a paraphrase is faithful. Speaker attribution needs dual-channel audio: on
diarized or mono transcripts (`SPEAKER`, `SPEAKER_n`) the validator falls back to
whole-transcript matching and records a soft `speaker_roles_unknown` flag. Even
with roles it misses a rep reading back the prospect's promise, and it holds a
real commitment made as a short reply ("Sure, Thursday's fine") because the
content words were the prospect's. A number written as digits when the speaker
said it in words (`20` for "twenty") is sent to review rather than passed. Quarantined items stay on the record under
`_quarantined` so a reviewer can see what was held back and why.

Inputs are constrained too: `meeting_id` and `audio_ref` are interpolated into
the ffmpeg command line, so shell metacharacters are stripped or rejected at
ingest.

## Evaluation

`evals/cases.json` holds five short synthetic transcripts (fictional companies,
written by hand) with the expected rep commitments, competitors and next steps
for each. `npm run eval` scores a file of model outputs against them and runs
each output through the shipped reducer and validator:

- precision and recall for rep commitments (token-overlap match, rule documented
  in `scripts/eval.mjs`) and competitors
- the share of quotes that are exact transcript substrings
- how many records the validator would send to review

Two sample output files are included, both written by hand: `good.json`, and
`flawed.json` with an invented commitment, a missed commitment, an invented
competitor and a fabricated quote. **These are offline fixtures. No live model
run is recorded in this repo**, so the numbers show that the scorer and the
validator behave as intended, not how any model performs. The flawed sample
also shows the validator's blind spot: it holds the two inventions, but a
missed commitment lowers recall without holding anything.

To score a real run, save one extraction per case id in the same file shape
and pass the path to `node scripts/eval.mjs`.

### Model outputs (recorded 2026-11-10)

`evals/outputs/models/` holds extractions produced by four Claude models. Each
was given the system prompt and JSON schema from `Build LLM Request` and the
transcripts only, with no expected answers, inside an agent session. They were
not produced by a direct API call or by running the workflow, so treat them as
evidence about the prompt and the validator, not about the pipeline.

On the original five cases every model scored precision 1 and recall 1 on
commitments and competitors. A set that four models of very different cost all
ace cannot separate models or catch a regression, so `evals/hard-cases.json`
adds eight harder synthetic transcripts: prospect promises, hedged and declined
commitments, commitments made as short replies, look-alike words (`clarify`, a
physical gong), numbers only the prospect said, third-party commitments, and a
44-turn call with one buried commitment.

```
node scripts/eval.mjs evals/outputs/models/hard/opus.json --cases evals/hard-cases.json
```

| Model | Commitment precision | Commitment recall | Competitor precision / recall | Sent to review |
| --- | --- | --- | --- | --- |
| Haiku | 0.69 | 0.82 | 1 / 1 | 1 of 8 |
| Sonnet | 0.83 | 0.91 | 1 / 1 | 1 of 8 |
| Opus | 0.82 | 0.82 | 1 / 1 | 1 of 8 |
| Fable | 0.77 | 0.91 | 1 / 1 | 1 of 8 |

Read these numbers with care:

- **Eleven expected commitments is too few to rank models.** One item moves
  recall by nine points.
- **The scorer undercounts.** Reading the mismatches by hand, several "extra"
  and "missed" pairs are the same commitment worded differently (the 60%
  token-overlap rule fails against long expected strings). Counted by hand,
  Opus made no errors and Haiku and Fable missed none.
- **The scorer ignores `explicit`.** The common real error was recording a
  hedged statement ("I'll try to find out, no promises") as a commitment.
  Sonnet and Fable recorded those with `explicit: false`; Haiku marked one
  `explicit: true`. Scoring firm and soft commitments separately is the next
  change to the scorer.
- **The validator held one real commitment set.** In `hard-cedarvane-physio`
  the rep commits with short replies to the prospect's requests. Every model
  extracted the commitments correctly and the speaker check quarantined them,
  because the content words were spoken by the prospect. The record goes to
  review, so nothing wrong is written, but it is a false hold.
- **No look-alike word produced a competitor**, and no number said only by the
  prospect entered a rep commitment, for any model.

The hard cases were written by a model (Opus) to a brief listing the traps, and
their expected answers were not reviewed by a second person.

## Known limitations

- **API keys still pass through execution data once.** `Runtime Config` no
  longer holds keys. Each request-builder node reads its key from the
  environment and puts it in `_req.headers` for the HTTP node that follows, and
  the Deepgram key is read in the HTTP node's own header expression. A test
  asserts no key appears anywhere else. That one builder output is still saved
  with the execution; n8n credentials would remove it and are the next change.
- **Human review is a hand-off, not a queue.** A held record is POSTed to
  `REVIEW_WEBHOOK_URL` if set; otherwise the run stops with the record in the
  execution data. There is no approve-and-resume step: a reviewer who accepts
  the record has to write it to the CRM themselves.
- **Only HubSpot associates the call to existing records**, and only when the
  caller supplies them as `crm_refs` on the ingest contract. Nothing looks up a
  contact or deal from the transcript. The other adapters create a standalone
  record.
- **Direction and duration are never guessed.** They are written only when the
  ingest contract carries `direction` and `duration_sec`. Zoho makes both
  mandatory, so the Zoho adapter stops with an error without them.
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
- `test/` — node tests, workflow wiring tests, eval tests, and synthetic fixtures
- `evals/` — synthetic transcripts with expected output, and two sample output files
- `scripts/eval.mjs` — offline scorer (`npm run eval`)
- `test-support/harness.mjs` — runs Code-node source outside n8n
- `services/whisper_service.py` — local FastAPI transcription microservice
  (faster-whisper, dual-channel-aware, optional pyannote diarization fallback)
- `services/pathguard.py` — confines the service to its work directory
- `docs/spec.md` — full build spec

## Setup

Requires n8n. On n8n 2.x three defaults block this workflow (per the
[2.0 breaking changes](https://docs.n8n.io/2-0-breaking-changes/)) and must be
changed on the instance:

```
N8N_BLOCK_ENV_ACCESS_IN_NODE=false       # Code nodes read keys from $env; if blocked, every provider silently falls back to local
NODES_EXCLUDE="[]"                       # Execute Command and Local File Trigger are disabled by default
N8N_RESTRICT_FILE_ACCESS_TO=/data/work   # Read/Write Files is confined to ~/.n8n-files by default (cloud STT path)
```

Then set whichever of these apply:

```
OPENAI_API_KEY / ANTHROPIC_API_KEY       # cloud LLM (optional — falls back to Ollama)
OPENAI_MODEL / ANTHROPIC_MODEL           # model ids; the defaults in Runtime Config may be out of date
OLLAMA_URL / OLLAMA_MODEL                # local LLM fallback
DEEPGRAM_API_KEY                         # cloud STT (optional — falls back to the local service)
CRM_PROVIDER                             # zoho | hubspot | salesforce | pipedrive | monday | webhook
CRM_TOKEN / CRM_BASE_URL / CRM_WEBHOOK_URL
MIN_CONFIDENCE                           # gate threshold, default 0.6
REVIEW_WEBHOOK_URL                       # where held records are POSTed (optional)
```

Optional fields on the item that enters `Ingest Contract` (from a webhook or
the manual trigger), used only when supplied:

```
direction      inbound | outbound          # written to HubSpot/Zoho; never guessed
duration_sec   number                      # written to HubSpot/Zoho
crm_refs       { contact_id, deal_id, company_id }   # HubSpot: the call is created associated to these records
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
npm run eval      # score the sample outputs against the synthetic eval set
python -m unittest discover -s tests   # transcription service path guard
```

## Kill criterion

If a 7B local model can't produce stable, schema-valid extractions across five
real transcripts, the local-hardware differentiation collapses and this
becomes a generic API workflow with no real edge. Test that before building
anything downstream (entity resolution, async split, CRM upsert polish).
