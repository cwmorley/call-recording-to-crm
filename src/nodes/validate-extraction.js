// VALIDATOR - runs between the model and the CRM. Nothing reaches the CRM adapter
// unless it passes here AND clears the confidence threshold.
//
// The model's own confidence number is self-reported, so it is not treated as
// evidence. These checks compare the extraction against the transcript itself:
//   - shape:        required fields exist and have the right types
//   - quotes:       a verbatim_quote must be an exact substring of the transcript
//   - competitors:  the name must appear in the transcript as whole words
//   - commitments:  every number in a rep commitment must appear in the transcript,
//                   and at least half of its content words must too (compared as
//                   whole words with common endings removed). A heuristic: it
//                   catches inventions, it does not prove a paraphrase is faithful.
//   - speakers:     when the transcript labels the sides (REP / PROSPECT, from
//                   dual-channel audio), the same words and numbers must have been
//                   said by the REP. A promise only the prospect made is not a rep
//                   commitment. Diarized (SPEAKER_n) and mono (SPEAKER) transcripts
//                   say who spoke, not which side, so roles are never guessed: the
//                   whole-transcript check is used and the record says so.
//   - due dates:    a due value must be made of words from the transcript
// Anything that fails a hard check is moved to _quarantined and the whole record
// is routed to human review. Ungrounded quotes and due dates are stripped and
// flagged (soft).
const rec = $json;
const segments = $('Normalize Transcript').first().json.segments || [];

const norm = (s) => String(s || '').toLowerCase()
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
  .replace(/\s+/g, ' ').trim();
const transcript = norm(segments.map((s) => s.text).join(' '));

// Whole-word matching: "Clari" must not be grounded by "clarify", nor "rate" by "separate".
const tokens = (s) => norm(s).replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
const stem = (w) => { const m = /^(.{4,}?)(ing|ed|es|s|e)$/.exec(w); return m ? m[1] : w; };
const said = tokens(transcript);
const saidWords = new Set(said);
const saidStems = new Set(said.map(stem));
const saidText = ' ' + said.join(' ') + ' ';
const saysPhrase = (s) => { const t = tokens(s); return t.length > 0 && saidText.includes(' ' + t.join(' ') + ' '); };

// Speaker roles are known only when the transcript carries side labels.
const role = (s) => String((s && s.speaker) || '').trim().toLowerCase();
const rolesKnown = segments.some((s) => role(s) === 'rep' || role(s) === 'prospect');
const repSaid = tokens(segments.filter((s) => role(s) === 'rep').map((s) => s.text).join(' '));
const repWords = new Set(repSaid);
const repStems = new Set(repSaid.map(stem));

const STOP = new Set(['that', 'this', 'with', 'from', 'will', 'have', 'they', 'them', 'their',
  'your', 'about', 'what', 'when', 'were', 'been', 'would', 'could', 'should', 'into', 'over',
  'send', 'sent', 'next', 'week', 'follow', 'call', 'team', 'customer', 'prospect']);
const contentWords = (s) => tokens(s).filter((w) => w.length > 3 && !STOP.has(w) && !/\d/.test(w));
const numbers = (s) => tokens(s).filter((w) => /\d/.test(w));

const flags = [];
const hard = (code, detail) => flags.push({ code, severity: 'hard', detail });
const soft = (code, detail) => flags.push({ code, severity: 'soft', detail });

// --- shape ---------------------------------------------------------------
const ARRAYS = ['attendees', 'pain_points', 'competitors_mentioned', 'objections',
  'rep_commitments', 'next_steps', 'risk_flags'];
for (const key of ARRAYS) {
  if (!Array.isArray(rec[key])) hard('schema_invalid', key + ' is not an array');
}
if (!rec.account || typeof rec.account.name !== 'string') hard('schema_invalid', 'account.name missing');
const conf = typeof rec.confidence === 'number' ? rec.confidence : NaN;
if (!Number.isFinite(conf) || conf < 0 || conf > 1) hard('schema_invalid', 'confidence is not a number between 0 and 1');

const arr = (key) => (Array.isArray(rec[key]) ? rec[key] : []);
const quarantined = { rep_commitments: [], competitors_mentioned: [] };

// --- quotes (soft: strip the quote, keep the paraphrase) -------------------
const painPoints = arr('pain_points').map((p) => {
  if (p && p.verbatim_quote && !transcript.includes(norm(p.verbatim_quote))) {
    soft('ungrounded_quote', String(p.verbatim_quote).slice(0, 120));
    return { ...p, verbatim_quote: '' };
  }
  return p;
});

// --- competitors (hard) ---------------------------------------------------
const competitors = arr('competitors_mentioned').filter((c) => {
  if (saysPhrase(c && c.name)) return true;
  quarantined.competitors_mentioned.push(c);
  hard('ungrounded_competitor', String((c && c.name) || '(empty)'));
  return false;
});

// --- rep commitments (hard) -----------------------------------------------
// First: was it said at all? Then, if the sides are labelled: did the rep say it?
const MIN_OVERLAP = 0.5;
const covers = (words, inWords, inStems) =>
  words.filter((w) => inWords.has(w) || inStems.has(stem(w))).length / words.length >= MIN_OVERLAP;
const quarantine = (c, code, detail) => {
  quarantined.rep_commitments.push(c); hard(code, detail); return false; };
let wholeTranscriptOnly = false;
const commitments = arr('rep_commitments').filter((c) => {
  const text = c && c.commitment;
  const words = contentWords(text);
  if (!words.length) return quarantine(c, 'empty_commitment', 'commitment has no checkable content');
  if (!rolesKnown) wholeTranscriptOnly = true;
  if (!covers(words, saidWords, saidStems)) return quarantine(c, 'ungrounded_commitment', String(text).slice(0, 120));
  const missing = numbers(text).filter((n) => !saidWords.has(n));
  if (missing.length) return quarantine(c, 'ungrounded_number', missing.join(', ') + ' in: ' + String(text).slice(0, 100));
  if (!rolesKnown) return true;
  if (!covers(words, repWords, repStems)) {
    return quarantine(c, 'commitment_wrong_speaker', 'not said by the rep: ' + String(text).slice(0, 100));
  }
  const notByRep = numbers(text).filter((n) => !repWords.has(n));
  if (notByRep.length) {
    return quarantine(c, 'commitment_wrong_speaker', notByRep.join(', ') + ' not said by the rep in: ' + String(text).slice(0, 100));
  }
  return true;
}).map((c) => {
  // due dates (soft: strip the date, keep the commitment)
  if (c.due && !tokens(c.due).every((w) => saidWords.has(w))) {
    soft('ungrounded_due', String(c.due).slice(0, 60));
    return { ...c, due: '' };
  }
  return c;
});
if (wholeTranscriptOnly) {
  const labels = [...new Set(segments.map((s) => String((s && s.speaker) || '(none)')))].slice(0, 5);
  soft('speaker_roles_unknown', 'speaker labels: ' + (labels.join(', ') || '(no segments)')
    + '; commitments were checked against the whole transcript, not the rep\'s turns');
}

// --- pipeline health ------------------------------------------------------
const failed = Number(rec.provenance && rec.provenance.chunks_failed) || 0;
if (failed > 0) hard('chunk_parse_failures', failed + ' chunk(s) returned unparseable output');
if (!commitments.length && !arr('next_steps').length && !painPoints.length) {
  hard('empty_extraction', 'no commitments, next steps or pain points were extracted');
}

const passed = !flags.some((f) => f.severity === 'hard');
const minConf = Number(rec._min_confidence);
const clearsConfidence = Number.isFinite(conf) && conf >= (Number.isFinite(minConf) ? minConf : 0.6);

return [{ json: {
  ...rec,
  pain_points: painPoints,
  competitors_mentioned: competitors,
  rep_commitments: commitments,
  _quarantined: quarantined,
  validation: { passed, clears_confidence: clearsConfidence, flags,
    checks: ['shape', 'quotes', 'competitors', 'commitments', 'speakers', 'due_dates', 'pipeline_health'] },
  _gate: passed && clearsConfidence ? 1 : 0 } }];
