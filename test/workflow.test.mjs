import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { build } from '../scripts/build-workflow.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const committed = JSON.parse(readFileSync(join(root, 'workflows', 'call-recording-to-crm.json'), 'utf8'));
const names = new Set(committed.nodes.map((n) => n.name));
const targets = (from, output = 0) =>
  (committed.connections[from]?.main?.[output] || []).map((t) => t.node);

test('committed workflow matches a fresh build from src/nodes', () => {
  assert.deepEqual(committed, build());
});

test('every connection points at a node that exists', () => {
  for (const [from, outs] of Object.entries(committed.connections)) {
    assert.ok(names.has(from), `unknown source node ${from}`);
    for (const branch of outs.main) for (const t of branch || []) {
      assert.ok(names.has(t.node), `${from} -> unknown node ${t.node}`);
    }
  }
});

test('the validator sits between the model output and the gate', () => {
  assert.deepEqual(targets('Reduce to Canonical Record'), ['Validate Extraction']);
  assert.deepEqual(targets('Validate Extraction'), ['Confidence Gate']);
});

test('the gate fails closed: only the passing branch can reach the CRM write', () => {
  assert.deepEqual(targets('Confidence Gate', 1), ['Human Review Queue']);
  const reach = (start) => {
    const seen = new Set(); const stack = [start];
    while (stack.length) {
      const n = stack.pop();
      if (seen.has(n)) continue;
      seen.add(n);
      for (const branch of committed.connections[n]?.main || []) for (const t of branch || []) stack.push(t.node);
    }
    return seen;
  };
  assert.ok(!reach('Human Review Queue').has('CRM Write'));
  const preds = Object.keys(committed.connections).filter((from) =>
    committed.connections[from].main.some((b) => (b || []).some((t) => t.node === 'CRM Write')));
  assert.deepEqual(preds, ['Build CRM Request']);
});

test('schema discovery runs only for monday; other providers go straight to the adapter', () => {
  assert.deepEqual(targets('Needs Schema Discovery?', 0), ['Discover CRM Schema']);
  assert.deepEqual(targets('Needs Schema Discovery?', 1), ['Build CRM Request']);
});

test('transcription: local posts a path, cloud posts the audio bytes, and nothing targets OpenAI audio', () => {
  const node = (name) => committed.nodes.find((n) => n.name === name);
  assert.deepEqual(targets('Local or Cloud STT?', 0), ['STT - Local Service']);
  assert.deepEqual(targets('Local or Cloud STT?', 1), ['Read Audio Binary']);
  assert.deepEqual(targets('Read Audio Binary'), ['STT - Cloud API']);
  assert.equal(node('STT - Local Service').parameters.specifyBody, 'json');
  assert.equal(node('STT - Cloud API').parameters.contentType, 'binaryData');
  assert.equal(node('STT - Cloud API').parameters.inputDataFieldName, 'data');
  assert.ok(!JSON.stringify(committed).includes('audio/transcriptions'));
});

test('no credentials are stored in the workflow file', () => {
  const text = JSON.stringify(committed);
  assert.ok(!/sk-[A-Za-z0-9]{20,}|Bearer [A-Za-z0-9_\-]{20,}|pat-[a-z0-9-]{20,}/.test(text));
  for (const node of committed.nodes) assert.equal(node.credentials, undefined);
});
