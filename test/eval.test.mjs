import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { evaluateFile, load } from '../scripts/eval.mjs';

const evals = join(dirname(fileURLToPath(import.meta.url)), '..', 'evals');

test('eval set: five synthetic cases, each labelled synthetic with expected output', () => {
  const { _meta, cases } = load(join(evals, 'cases.json'));
  assert.equal(_meta.synthetic, true);
  assert.equal(cases.length, 5);
  for (const c of cases) {
    for (const key of ['rep_commitments', 'competitors_mentioned', 'next_steps']) assert.ok(Array.isArray(c.expected[key]), c.id);
  }
});

test('eval: the good sample scores perfectly and nothing is held', () => {
  const m = evaluateFile(join(evals, 'outputs', 'good.json'));
  assert.deepEqual(m.rep_commitments, { true_positives: 7, predicted: 7, expected: 7, precision: 1, recall: 1 });
  assert.deepEqual(m.competitors, { true_positives: 4, predicted: 4, expected: 4, precision: 1, recall: 1 });
  assert.equal(m.quote_grounding_rate, 1);
  assert.equal(m.sent_to_review, 0);
});

test('eval: the flawed sample loses precision and recall, and the validator holds the inventions', () => {
  const m = evaluateFile(join(evals, 'outputs', 'flawed.json'));
  assert.deepEqual(m.rep_commitments, { true_positives: 6, predicted: 7, expected: 7, precision: 0.857, recall: 0.857 });
  assert.deepEqual(m.competitors, { true_positives: 4, predicted: 5, expected: 4, precision: 0.8, recall: 1 });
  assert.equal(m.quote_grounding_rate, 0.75);
  const held = Object.fromEntries(m.per_case.filter((c) => c.sent_to_review).map((c) => [c.id, c.flags]));
  assert.deepEqual(held, { 'harborline-freight': ['ungrounded_commitment'], 'bluefin-analytics': ['ungrounded_competitor'] });
  // The missed commitment is invisible to the validator: it lowers recall but holds nothing.
  assert.equal(m.per_case.find((c) => c.id === 'quarry-ridge-supply').sent_to_review, false);
});

// --- scorer rules, checked against recorded model output -------------------
const hard = (model) => evaluateFile(join(evals, 'outputs', 'models', 'hard', model + '.json'),
  join(evals, 'hard-cases.json'));

test('eval: a commitment marked explicit false is counted as soft, not scored as firm', () => {
  const m = hard('sonnet');
  assert.equal(m.soft_commitments, 2);
  assert.equal(m.rep_commitments.predicted, 10);
  assert.equal(m.rep_commitments.precision, 1);
});

test('eval: a hedged statement marked explicit true still costs precision', () => {
  const m = hard('haiku');
  assert.deepEqual(m.rep_commitments, { true_positives: 11, predicted: 12, expected: 11, precision: 0.917, recall: 1 });
});

test('eval: a correct paraphrase with different word endings is matched', () => {
  assert.deepEqual(hard('opus').rep_commitments,
    { true_positives: 11, predicted: 11, expected: 11, precision: 1, recall: 1 });
});

test('eval: a missed commitment still lowers recall under the looser matching rule', () => {
  assert.equal(hard('sonnet').rep_commitments.recall, 0.909);
});
