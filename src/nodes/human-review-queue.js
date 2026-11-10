// HUMAN REVIEW QUEUE - where a record goes when the gate holds it back.
// If REVIEW_WEBHOOK_URL is set, the held record is POSTed there (a Slack workflow,
// a ticket intake, another n8n workflow). Otherwise the run stops here and the
// record - with its validation flags and quarantined items - stays in this
// node's output in the execution data. Nothing on this branch reaches the CRM.
const env = (k) => { try { return $env[k] || ''; } catch (e) { return ''; } };
const rec = $json;
const url = env('REVIEW_WEBHOOK_URL');

const v = rec.validation || {};
const reasons = [...new Set((v.flags || []).filter((f) => f.severity === 'hard').map((f) => f.code))];
if (!v.clears_confidence) reasons.push('below_min_confidence');

const held = { ...rec, _review: { status: 'held', reasons, delivery: url ? 'webhook' : 'execution_data' } };
if (!url) return [{ json: held }];
return [{ json: { ...held,
  _req: { url, headers: { 'Content-Type': 'application/json' }, body: held } } }];
