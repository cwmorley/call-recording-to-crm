# Build Spec: Call Recording → Structured CRM Record (Local AI)

**n8n workflow**
**Spec date:** 2026-09-05
**Hardware target:** RTX 4060 8GB (Ollama + faster-whisper, already running)

---

## Problem and goals

**Goal:** Gong-class call intelligence, running on your own hardware. No per-seat SaaS, no per-call API cost, no third-party processor touching customer conversations.

**The problem, concretely:**
- Reps spend 15–20 min post-call writing CRM notes — or don't, and pipeline data rots
- Managers have no real visibility into objections, competitors, or commitments made
- Gong/Chorus run ~$1,200–1,800/user/year and ship audio to a third party

---

## Acquisition layer

Where the audio actually comes from. This is the first question any real client asks, and it is deliberately kept separate from the processing pipeline.

### Design rule: one normalized ingest contract

Every acquisition path emits the same shape, and the pipeline consumes only this:

```json
{
  "audio_ref": "url|path",
  "auth_header": null,
  "meeting_id": "",
  "participants": [{ "name": "", "email": "", "side": "rep|prospect" }],
  "start_time": "",
  "duration_sec": 0,
  "channels": "mono|dual",
  "source": "zoom|teams|meet|twilio|aircall|ringcentral|folder|recall"
}
```

Each platform becomes a small independent workflow emitting into this contract. Adding RingCentral six months later never touches the pipeline.

### Sources, by family

**Meeting platforms**
- **Zoom** — cleanest path. Server-to-Server OAuth app, scope `recording:read:admin`, subscribe to `recording.completed` webhook. Request the **M4A audio-only** asset, not the video.
- **Microsoft Teams** — go through the file layer, not the meetings API. Recordings land in OneDrive (1:1) or SharePoint (channel meetings). Watching those folders avoids Graph's call-recording permission and licensing complexity.
- **Google Meet** — recordings land in Drive; a Drive trigger on the Meet Recordings folder is sufficient. Requires Workspace Business Standard+ for recording at all.

**Dialers — where real B2B sales calls actually live**
Most sales calls are not Zoom meetings. RingCentral, Aircall, Dialpad, Twilio, Kixie, JustCall, Five9 all expose a call-ended webhook carrying a recording URL. If the buyer is a sales team, **this is the integration that matters**, not Zoom.

**CRM-native**
Zoho Voice / PhoneBridge and HubSpot Calling attach recordings directly to call records, reachable via the CRM API. Often the shortest path, since the workflow writes back there anyway.

**Meeting bots — universal fallback**
**Recall.ai**: one API that sends a bot into Zoom/Meet/Teams/Webex and returns audio. Paid, but collapses four integrations into one.

**Local / manual**
Folder watch or a Drive/Dropbox drop folder. Zero credentials.

### Two things that matter more than the source list

**1. Ask for dual-channel recording before building diarization.**
Twilio, Aircall and most dialers can record each call leg on its own channel. Stereo — rep left, prospect right — gives perfect speaker separation for free and **deletes the hardest, most error-prone component of the pipeline**. Always check for this before reaching for pyannote/WhisperX. It is usually a config flag.

**2. Pull audio-only.**
A 45-min video is hundreds of MB; the audio is tens. Zoom exposes the M4A separately. Bandwidth, storage, and ffmpeg time all drop by roughly an order of magnitude.

### Gotchas

- **Zoom download URLs are short-lived and require the bearer token as a header.** A plain HTTP node pointed at the URL will fail — pass `auth_header` through the ingest contract.
- **Processing lag** — cloud recordings are not instantly available; the webhook fires on processing completion, and large files still lag.
- **Retention policies** — many orgs auto-purge recordings after 30–90 days. Ingest promptly or lose the corpus.
- **Consent** — see legal note below. Acquisition is exactly where consent capture belongs.

### Scope note

The default trigger is the folder/Drive trigger and needs no credentials. Platform-specific acquisition is not part of it: every client has a different phone stack, so it is built per deployment as its own small workflow emitting into the ingest contract.

---

## Pipeline

```
[0] Acquisition (see above) → normalized ingest contract
        ↓
[1] Trigger — Local File Trigger (watch /recordings) | Manual for testing
        ↓
[2] Normalize audio — Execute Command: ffmpeg → 16kHz mono WAV
        ↓
[3] Transcribe + diarize — faster-whisper (local HTTP service)
        ↓  speaker-labeled transcript
[4] Chunk — split by speaker turn / topic window
        ↓
[5] Extract (map) — Ollama, strict JSON schema, per chunk
        ↓
[6] Reduce — merge chunk extractions into one record
        ↓
[7] Validate — JSON Schema check; retry once on failure
        ↓
[8] Resolve entity — match contact/account in CRM (fuzzy)
        ↓
[9] Confidence gate — low confidence → Slack/email review
        ↓
[10] Upsert — Zoho CRM / HubSpot: record + note + tasks
```

### Node-level detail

**[2] Audio normalization**
`ffmpeg -i input -ar 16000 -ac 1 -c:a pcm_s16le out.wav`
Whisper wants 16kHz mono. Skipping this costs accuracy on Teams/Zoom recordings.

**[3] Transcription — the local core**
- Use **faster-whisper** with `distil-large-v3` or `large-v3-turbo`, not vanilla large-v3. On 8GB, turbo/distil gives near-parity WER at several times the speed and leaves VRAM headroom.
- **Diarization is the value-add** — "who said what" is what makes it a *sales* tool rather than a transcript. Use WhisperX or pyannote for speaker labels. Rep vs. prospect attribution drives half the extracted fields.
- Wrap it as a small local HTTP service (FastAPI) rather than shelling out per execution — avoids model reload on every call.

**[4] Chunking — do not skip**
A 45-min call ≈ 8–12k tokens. It *fits* llama3.1:8b's context, but small-model extraction quality degrades badly over long context. Map-reduce over chunks is more accurate.

**[5] Extraction — model choice**
`qwen2.5:7b` (already pulled — has `tools` capability, better at structured output than llama3.1:8b for this) with Ollama's JSON/structured output mode. Temperature 0.

**[8] Entity resolution**
Fuzzy-match company/contact against CRM before writing.

---

## Extraction schema

```json
{
  "account": { "name": "", "domain": "", "crm_id": null },
  "attendees": [{ "name": "", "role": "", "side": "rep|prospect" }],
  "qualification": {
    "budget_signals": [], "authority": [], "need": [],
    "timeline": "", "metrics_mentioned": []
  },
  "pain_points": [{ "paraphrase": "", "verbatim_quote": "", "severity": "" }],
  "competitors_mentioned": [{ "name": "", "context": "" }],
  "objections": [{ "objection": "", "rep_response": "", "resolved": true }],
  "rep_commitments": [{ "commitment": "", "due": "", "explicit": true }],
  "next_steps": [{ "action": "", "owner": "", "due_date": "" }],
  "risk_flags": [],
  "recommended_stage": "",
  "confidence": { "overall": 0.0, "per_field": {} },
  "provenance": { "chunk_ids": [], "model": "", "transcript_span": "" }
}
```

**`rep_commitments` isolates what the rep promised.** Everyone extracts action items. Almost nobody isolates *what the rep promised* — send pricing, loop in an SE, follow up Thursday. Those are the forgotten promises that quietly kill deals.

**`provenance` + `per_field` confidence** is what makes the output trustworthy enough to write into a CRM. Any field below threshold routes to human review instead of silently corrupting the record.

---

## Known constraints — engineer around these, don't discover them live

**VRAM contention (8GB).** Whisper and the LLM cannot both stay resident comfortably. Run sequentially, and set `OLLAMA_KEEP_ALIVE` so the LLM unloads while Whisper works. Otherwise expect swapping and 10× slowdowns.

**n8n execution timeouts.** A 45-min recording can exceed default execution limits during transcription. Either raise `EXECUTIONS_TIMEOUT`, or split into two workflows (transcribe → webhook → extract). The async split avoids the timeout and decouples the two stages.

**Small-model hallucination.** A 7B model *will* fabricate structured fields under pressure. This is why validation + confidence gating + human review are in the pipeline, not optional polish. Do not oversell autonomous accuracy — "high-confidence auto-write, low-confidence review queue" is both honest and a better product.

**Recording consent — legal, not technical.** Two-party consent states (CA, WA, IL, FL, PA and others) require all-party consent to record. Any client deployment needs consent capture in the call flow. Flag this in the template README.

---

## Packaging

**Default path:** ship it with **API-based** Whisper + LLM so it runs out of the box without a local GPU. Published to n8n.io/workflows.

**Documented local path:** same workflow, swap two nodes for Ollama + local Whisper.

**Deliverables:**
1. Workflow JSON (both paths)
2. README with setup, schema docs, consent warning

---

## Build order

1. Local faster-whisper service with diarization, verify on one real recording
2. Extraction prompt + schema, iterate against 3–5 transcripts until fields are stable
3. Validation + confidence gating
4. CRM upsert (pick one — Zoho)
5. Entity resolution
6. Async split + error handling
7. Package API variant, README

Steps 1–3 are the actual work. If extraction quality isn't stable by end of step 2, stop — the rest doesn't matter.

## Kill criterion

If a 7B local model can't produce stable, schema-valid extractions across five real transcripts, the local path is not viable and this falls back to a generic API workflow. **Test that before building anything downstream.**
