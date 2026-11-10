// VALIDATOR - runs between the model and the CRM. Nothing reaches the CRM adapter
// unless it passes here AND clears the confidence threshold.
//
// The model's own confidence number is self-reported, so it is not treated as
// evidence. These checks compare the extraction against the transcript itself:
//   - shape:        required fields exist and have the right types
//   - quotes:       a verbatim_quote must be an exact substring of the transcript
//   - competitors:  a competitor name must literally appear in the transcript
//   - commitments:  most content words of a rep commitment must appear in the
//                   transcript (a heuristic - it catches inventions, not paraphrase)
// Anything that fails a hard check is moved to _quarantined and the whole record
// is routed to human review. Ungrounded quotes are stripped and flagged (soft).
const rec = $json;
const segments = $('Normalize Transcript').first().json.segments || [];

const norm = (s) => String(s || '').toLowerCase()
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
  .replace(/\s+/g, ' ').trim();
const transcript = norm(segments.map((s) => s.text).join(' '));

const STOP = new Set(['that', 'this', 'with', 'from', 'will', 'have', 'they', 'them', 'their',
  'your', 'about', 'what', 'when', 'were', 'been', 'would', 'could', 'should', 'into', 'over',
  'send', 'sent', 'next', 'week', 'follow', 'call', 'team', 'customer', 'prospect']);
const contentWords = (s) => norm(s).replace(/[^a-z0-9 ]/g, ' ').split(' ')
  .filter((w) => w.length > 3 && !STOP.has(w));

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
const conf = Number(rec.confidence);
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
  const name = norm(c && c.name);
  if (name && transcript.includes(name)) return true;
  quarantined.competitors_mentioned.push(c);
  hard('ungrounded_competitor', String((c && c.name) || '(empty)'));
  return false;
});

// --- rep commitments (hard) -----------------------------------------------
const MIN_OVERLAP = 0.5;
const commitments = arr('rep_commitments').filter((c) => {
  const words = contentWords(c && c.commitment);
  if (!words.length) {
    quarantined.rep_commitments.push(c);
    hard('empty_commitment', 'commitment has no checkable content');
    return false;
  }
  const found = words.filter((w) => transcript.includes(w)).length;
  if (found / words.length >= MIN_OVERLAP) return true;
  quarantined.rep_commitments.push(c);
  hard('ungrounded_commitment', String(c.commitment).slice(0, 120));
  return false;
});

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
    checks: ['shape', 'quotes', 'competitors', 'commitments', 'pipeline_health'] },
  _gate: passed && clearsConfidence ? 1 : 0 } }];
