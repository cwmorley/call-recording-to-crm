// Offline evaluation. Scores a file of model outputs against the expected
// extraction for each synthetic transcript in evals/cases.json, and runs each
// output through the shipped reducer and validator to see what would be held.
//
//   node scripts/eval.mjs evals/outputs/good.json
//   node scripts/eval.mjs evals/outputs/models/hard/sonnet.json --cases evals/hard-cases.json
//
// The outputs file is { outputs: { <case id>: <extraction> } } - one extraction
// per transcript, in the schema the model is asked for.
//
// Matching rule for rep commitments: lowercase, split into alphanumeric tokens,
// drop the words in FILLER, and strip common endings (runs/running -> run). A
// predicted commitment matches an expected one when the tokens they share are at
// least 40% of the shorter of the two. Each expected commitment can be matched
// once, and the best-overlapping pair is taken first. Competitors match on the
// normalised name.
//
// Firm versus soft: the schema lets the model mark a commitment `explicit: false`
// (hedged or implied, e.g. "I'll try to find out, no promises"). Precision and
// recall are computed on firm commitments only; soft ones are counted separately.
//
// History: the first version used 60% with no stemming and ignored `explicit`.
// Against real model output on the hard set it marked correct paraphrases as
// wrong and counted correctly-hedged items as errors, so it was changed on
// 2026-11-10 after reading every mismatch by hand.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { runNode } from '../test-support/harness.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILLER = new Set(['the', 'a', 'an', 'to', 'of', 'for', 'by', 'with', 'and', 'on', 'in', 'at',
  'our', 'your', 'you', 'i', 'will', 'up', 'next']);
const MATCH = 0.4;

const stem = (w) => (w.length > 3 ? w.replace(/(ing|ed|es|s)$/, '') : w);
const tokens = (s) => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  .split(' ').filter((w) => w && !FILLER.has(w)).map(stem));
const overlap = (a, b) => {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  return [...A].filter((w) => B.has(w)).length / Math.min(A.size, B.size);
};
const name = (s) => [...tokens(s)].join(' ');

// Returns the number of predicted items that match a distinct expected item.
const countMatches = (predicted, expected, same) => {
  const free = [...expected]; let hits = 0;
  for (const p of predicted) {
    const i = free.findIndex((e) => same(p, e));
    if (i >= 0) { free.splice(i, 1); hits++; }
  }
  return hits;
};
// Greedy on the strongest pair first, so a weak match cannot take the expected
// item that a stronger prediction belongs to.
const countBestMatches = (predicted, expected) => {
  const pairs = [];
  predicted.forEach((p, i) => expected.forEach((e, j) => {
    const o = overlap(p, e);
    if (o >= MATCH) pairs.push([o, i, j]);
  }));
  pairs.sort((a, b) => b[0] - a[0] || a[1] - b[1] || a[2] - b[2]);
  const usedP = new Set(), usedE = new Set();
  for (const [, i, j] of pairs) {
    if (usedP.has(i) || usedE.has(j)) continue;
    usedP.add(i); usedE.add(j);
  }
  return usedP.size;
};
const ratio = (n, d) => (d ? Number((n / d).toFixed(3)) : 1);
const score = (tp, predicted, expected) => ({ true_positives: tp, predicted, expected,
  precision: ratio(tp, predicted), recall: ratio(tp, expected) });

const CFG = { min_conf: 0.6, llm_provider: 'recorded', stt_provider: 'none', ollama_model: 'recorded-sample' };

export function evaluate(cases, outputs) {
  const total = { c_soft: 0, c_tp: 0, c_pred: 0, c_exp: 0, k_tp: 0, k_pred: 0, k_exp: 0, quotes: 0, quotes_grounded: 0 };
  const perCase = [];
  for (const c of cases) {
    const extraction = outputs[c.id];
    if (!extraction) throw new Error('no output for case ' + c.id);

    const all = extraction.rep_commitments || [];
    const commitments = all.filter((x) => x.explicit !== false).map((x) => x.commitment);
    const soft = all.length - commitments.length;
    const competitors = (extraction.competitors_mentioned || []).map((x) => x.name);
    const cTp = countBestMatches(commitments, c.expected.rep_commitments);
    const kTp = countMatches(competitors, c.expected.competitors_mentioned, (p, e) => name(p) === name(e));

    // What the shipped pipeline would do with this output.
    const ctx = { meeting_id: c.id, source: 'eval', start_time: '2026-01-01T00:00:00.000Z', _cfg: CFG };
    const [record] = runNode('reduce-to-canonical-record', {
      input: [{ chunk_id: 0, extraction }], nodes: { 'Runtime Config': ctx } });
    const [validated] = runNode('validate-extraction', {
      input: [record], nodes: { 'Normalize Transcript': { segments: c.segments } } });
    const flags = validated.validation.flags.map((f) => f.code);
    const quotes = (extraction.pain_points || []).filter((p) => p.verbatim_quote).length;
    const grounded = quotes - flags.filter((f) => f === 'ungrounded_quote').length;

    total.c_tp += cTp; total.c_pred += commitments.length; total.c_exp += c.expected.rep_commitments.length;
    total.c_soft += soft;
    total.k_tp += kTp; total.k_pred += competitors.length; total.k_exp += c.expected.competitors_mentioned.length;
    total.quotes += quotes; total.quotes_grounded += grounded;
    perCase.push({ id: c.id, sent_to_review: validated._gate !== 1, flags });
  }
  return {
    cases: cases.length,
    rep_commitments: score(total.c_tp, total.c_pred, total.c_exp),
    soft_commitments: total.c_soft,
    competitors: score(total.k_tp, total.k_pred, total.k_exp),
    quote_grounding_rate: ratio(total.quotes_grounded, total.quotes),
    sent_to_review: perCase.filter((c) => c.sent_to_review).length,
    per_case: perCase,
  };
}

export const load = (path) => JSON.parse(readFileSync(path, 'utf8'));
export const evaluateFile = (path, casesPath = join(root, 'evals', 'cases.json')) =>
  evaluate(load(casesPath).cases, load(path).outputs);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--cases');
  const casesPath = at >= 0 ? resolve(args.splice(at, 2)[1]) : undefined;
  const file = args[0];
  if (!file) { console.error('usage: node scripts/eval.mjs <outputs.json> [--cases <cases.json>]'); process.exit(2); }
  const m = evaluateFile(resolve(file), casesPath);
  const meta = load(resolve(file))._meta || {};
  const line = (label, s) => console.log(`${label.padEnd(18)} precision ${s.precision}  recall ${s.recall}  (${s.true_positives} matched, ${s.predicted} predicted, ${s.expected} expected)`);
  console.log(`${file} - ${m.cases} synthetic transcripts`);
  console.log(`source: ${meta.model || 'unknown'}${meta.note ? ' (' + meta.note + ')' : ''}`);
  line('firm commitments', m.rep_commitments);
  console.log(`${'soft commitments'.padEnd(18)} ${m.soft_commitments} (explicit: false; not scored)`);
  line('competitors', m.competitors);
  console.log(`${'quote grounding'.padEnd(18)} ${m.quote_grounding_rate}`);
  console.log(`${'sent to review'.padEnd(18)} ${m.sent_to_review} of ${m.cases}`);
  for (const c of m.per_case) console.log(`  ${c.sent_to_review ? 'REVIEW' : 'pass  '} ${c.id}${c.flags.length ? '  [' + c.flags.join(', ') + ']' : ''}`);
}
