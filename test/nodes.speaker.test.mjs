import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runNode, fixture } from '../test-support/harness.mjs';

// The validator must check WHO said a commitment, not only that its words were said.
const transcript = fixture('transcript.json');

const seg = (speaker, text) => ({ speaker, start: 0, end: 0, text });
const record = (rep_commitments) => ({ account: { name: 'Northwind Logistics' }, attendees: [],
  pain_points: [], competitors_mentioned: [], objections: [], rep_commitments, next_steps: [],
  risk_flags: [], confidence: 0.85, _min_confidence: 0.6, provenance: { chunks_failed: 0 } });
const validate = (rec, segments) => runNode('validate-extraction', {
  input: [rec], nodes: { 'Normalize Transcript': { segments } } })[0];
const count = (out, code) => out.validation.flags.filter((f) => f.code === code).length;

const REP_PROMISE = { commitment: 'Send the pricing sheet by Friday' };
const PROSPECT_PROMISE = { commitment: 'Make a decision before the end of the quarter' };

test('speakers: a commitment the rep said passes', () => {
  const out = validate(record([REP_PROMISE,
    { commitment: 'Set up a security review with the solutions engineer' }]), transcript.segments);
  assert.equal(out.rep_commitments.length, 2);
  assert.deepEqual(out.validation.flags, []);
  assert.equal(out._gate, 1);
});

test('speakers: a promise only the prospect made is quarantined as commitment_wrong_speaker', () => {
  // In the demo call it is Dana, the prospect, who says "We need a decision before the end of the quarter."
  const invented = { commitment: 'Provide a free onsite implementation workshop' };
  const out = validate(record([REP_PROMISE, PROSPECT_PROMISE, invented]), transcript.segments);
  assert.deepEqual(out.rep_commitments, [REP_PROMISE]);
  assert.deepEqual(out._quarantined.rep_commitments, [PROSPECT_PROMISE, invented]);
  assert.ok(out.validation.flags.some((f) => f.code === 'commitment_wrong_speaker' && f.severity === 'hard'
    && /decision/.test(f.detail)));
  // words said by nobody keep their existing code
  assert.ok(out.validation.flags.some((f) => f.code === 'ungrounded_commitment' && /workshop/.test(f.detail)));
  assert.equal(count(out, 'commitment_wrong_speaker'), 1);
  assert.equal(count(out, 'speaker_roles_unknown'), 0);
  assert.equal(out._gate, 0);
});

test('speakers: a rep who repeats the prospect\'s request in their own turn has committed', () => {
  const ask = seg('PROSPECT', 'Could you send over the security questionnaire answers?');
  const rec = record([{ commitment: 'Send the security questionnaire answers' }]);
  const repeated = validate(rec, [ask, seg('REP', 'Yes. I will send the security questionnaire answers tomorrow.')]);
  assert.equal(repeated.rep_commitments.length, 1);
  assert.equal(repeated._gate, 1);
  // A bare "sure" is not checkable evidence; it goes to a human rather than straight to the CRM.
  const agreed = validate(rec, [ask, seg('REP', 'Sure, sounds good.')]);
  assert.equal(agreed.rep_commitments.length, 0);
  assert.equal(count(agreed, 'commitment_wrong_speaker'), 1);
  assert.equal(agreed._gate, 0);
});

test('speakers: a number only the prospect said cannot enter a rep commitment', () => {
  const rec = record([{ commitment: 'Send revised pricing with a 15% discount' }]);
  const ask = seg('PROSPECT', 'Can you do 15% off the annual plan?');
  const out = validate(rec, [ask, seg('REP', 'I will send revised pricing with a discount.')]);
  assert.equal(out.rep_commitments.length, 0);
  assert.ok(out.validation.flags.some((f) => f.code === 'commitment_wrong_speaker' && /15/.test(f.detail)));
  assert.equal(count(out, 'ungrounded_number'), 0);
  assert.equal(validate(rec, [ask, seg('REP', 'I will send revised pricing with a 15% discount.')])._gate, 1);
});

test('speakers: diarized or mono transcripts fall back to the whole transcript and say so once', () => {
  const diarized = [seg('SPEAKER_0', 'I will send the pricing sheet by Friday.'),
    seg('SPEAKER_1', 'We will make a decision before the end of the quarter.')];
  const mono = [seg('SPEAKER', diarized.map((s) => s.text).join(' '))];
  for (const segments of [diarized, mono]) {
    const out = validate(record([REP_PROMISE, PROSPECT_PROMISE]), segments);
    // The weaker check cannot tell the two apart. Both pass, and the record carries that fact.
    assert.equal(out.rep_commitments.length, 2);
    assert.equal(count(out, 'speaker_roles_unknown'), 1);
    assert.equal(out.validation.flags.find((f) => f.code === 'speaker_roles_unknown').severity, 'soft');
    assert.equal(count(out, 'commitment_wrong_speaker'), 0);
    assert.equal(out.validation.passed, true);
    assert.equal(out._gate, 1);
  }
});

test('speakers: unknown roles still quarantine words nobody said', () => {
  const out = validate(record([{ commitment: 'Provide a free onsite implementation workshop' }]),
    [seg('SPEAKER_0', 'I will send the pricing sheet by Friday.')]);
  assert.equal(count(out, 'ungrounded_commitment'), 1);
  assert.equal(count(out, 'speaker_roles_unknown'), 1);
  assert.equal(out._gate, 0);
});

test('speakers: the REP and PROSPECT labels are matched case-insensitively', () => {
  for (const [rep, prospect] of [['rep', 'prospect'], ['Rep', 'Prospect'], [' REP ', 'PROSPECT']]) {
    const out = validate(record([REP_PROMISE, PROSPECT_PROMISE]), [
      seg(rep, 'I will send the pricing sheet by Friday.'),
      seg(prospect, 'We will make a decision before the end of the quarter.')]);
    assert.deepEqual(out.rep_commitments, [REP_PROMISE], `labels ${rep}/${prospect}`);
    assert.equal(count(out, 'commitment_wrong_speaker'), 1);
    assert.equal(count(out, 'speaker_roles_unknown'), 0);
  }
});

test('speakers: an empty transcript is reported, not thrown', () => {
  for (const segments of [[], undefined]) {
    const out = validate(record([REP_PROMISE]), segments);
    assert.equal(out.rep_commitments.length, 0);
    assert.equal(count(out, 'ungrounded_commitment'), 1);
    assert.equal(count(out, 'commitment_wrong_speaker'), 0);
    assert.equal(count(out, 'speaker_roles_unknown'), 1);
    assert.equal(out._gate, 0);
  }
});

// --- hard evaluation set --------------------------------------------------
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { evaluateFile } from '../scripts/eval.mjs';

const evalsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'evals');

test('hard eval set: eight synthetic dual-channel cases with a stated rationale', () => {
  const set = JSON.parse(readFileSync(join(evalsDir, 'hard-cases.json'), 'utf8'));
  assert.equal(set.cases.length, 8);
  for (const c of set.cases) {
    assert.ok(c.id.startsWith('hard-'));
    assert.ok(c.rationale, `${c.id} has no rationale`);
    assert.ok(Array.isArray(c.expected.rep_commitments));
    for (const s of c.segments) assert.ok(['REP', 'PROSPECT'].includes(s.speaker), `${c.id}: ${s.speaker}`);
  }
});

test('recorded model outputs cover every case and name the model that produced them', () => {
  for (const [dir, cases, n] of [['easy', 'cases.json', 5], ['hard', 'hard-cases.json', 8]]) {
    for (const file of readdirSync(join(evalsDir, 'outputs', 'models', dir))) {
      const path = join(evalsDir, 'outputs', 'models', dir, file);
      const recorded = JSON.parse(readFileSync(path, 'utf8'));
      assert.ok(recorded._meta.model, `${dir}/${file} does not name a model`);
      assert.equal(evaluateFile(path, join(evalsDir, cases)).cases, n);
    }
  }
});
