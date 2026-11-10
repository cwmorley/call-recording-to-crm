// CRM ADAPTER - canonical record -> provider payload.
// Default 'webhook' posts the canonical record anywhere: works with ANY CRM,
// including ones not implemented here. Add a branch to support a new system.
//
// Facts about the call itself (direction, duration, which CRM records it belongs
// to) come from the ingest contract. A fact that was not supplied is omitted; if
// the CRM makes it mandatory the adapter stops rather than inventing a value.
const rec = $json;
const c = $('Runtime Config').first().json._cfg;
const call = $('Ingest Contract').first().json;
const refs = call.crm_refs || {};
const durationSec = Number(call.duration_sec) || 0;

const lines = [];
if (rec.rep_commitments?.length) lines.push('COMMITMENTS MADE BY REP:',
  ...rec.rep_commitments.map(x => '- ' + x.commitment + (x.due ? ' (due ' + x.due + ')' : '')), '');
if (rec.next_steps?.length) lines.push('NEXT STEPS:',
  ...rec.next_steps.map(x => '- ' + x.action + ' [' + (x.owner || 'unassigned') + ']'), '');
if (rec.objections?.length) lines.push('OBJECTIONS:',
  ...rec.objections.map(x => '- ' + x.objection), '');
if (rec.pain_points?.length) lines.push('PAIN POINTS:',
  ...rec.pain_points.map(x => '- ' + x.paraphrase), '');
if (rec.competitors_mentioned?.length)
  lines.push('COMPETITORS: ' + rec.competitors_mentioned.map(x => x.name).join(', '), '');
if (rec.risk_flags?.length) lines.push('RISK FLAGS: ' + rec.risk_flags.join(', '), '');
lines.push(`(${rec.provenance?.llm_provider}/${rec.provenance?.model} · confidence ${rec.confidence})`);
const summary = lines.join('\n');
const subject = 'Call Summary - ' + (rec.account.name || 'Unknown Account');

const J = { 'Content-Type': 'application/json' };
let _req;
switch (c.crm_provider) {
  case 'zoho': {     // NOTE: region-specific domain (.com/.eu/.in/.com.au) via CRM_BASE_URL
    // Zoho makes Call_Type and Call_Duration mandatory and rejects a zero duration.
    if (!call.direction) throw new Error('Zoho requires the call direction. Set direction (inbound|outbound) on the ingest contract.');
    if (durationSec <= 0) throw new Error('Zoho requires the call duration. Set duration_sec on the ingest contract.');
    const mins = Math.max(1, Math.round(durationSec / 60));
    const pad = (n) => String(n).padStart(2, '0');
    _req = { url: (c.crm_base || 'https://www.zohoapis.com') + '/crm/v5/Calls',
      headers: { ...J, Authorization: 'Zoho-oauthtoken ' + c.crm_token },
      body: { data: [{ Subject: subject, Description: summary, Call_Start_Time: rec.start_time,
        Call_Type: call.direction === 'outbound' ? 'Outbound' : 'Inbound',
        Call_Duration: pad(Math.floor(mins / 60)) + ':' + pad(mins % 60) }] } };   // documented as HH:mm
    break;
  }
  case 'hubspot': {
    const properties = { hs_timestamp: rec.start_time, hs_call_title: subject, hs_call_body: summary,
      hs_call_status: 'COMPLETED' };
    if (call.direction) properties.hs_call_direction = call.direction.toUpperCase();
    if (durationSec > 0) properties.hs_call_duration = Math.round(durationSec * 1000);   // milliseconds
    // HubSpot-defined association type ids, call -> contact / company / deal.
    const TYPE_ID = { contact_id: 194, company_id: 182, deal_id: 206 };
    const associations = Object.keys(TYPE_ID).filter((k) => refs[k]).map((k) => ({ to: { id: refs[k] },
      types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: TYPE_ID[k] }] }));
    _req = { url: 'https://api.hubapi.com/crm/v3/objects/calls',
      headers: { ...J, Authorization: 'Bearer ' + c.crm_token },
      body: associations.length ? { properties, associations } : { properties } };
    break;
  }
  case 'salesforce':
    _req = { url: (c.crm_base || '') + '/services/data/v60.0/sobjects/Task',
      headers: { ...J, Authorization: 'Bearer ' + c.crm_token },
      body: { Subject: subject, Description: summary, Status: 'Completed', TaskSubtype: 'Call' } };
    break;
  case 'pipedrive':
    _req = { url: (c.crm_base || 'https://api.pipedrive.com') + '/v1/notes?api_token=' + c.crm_token,
      headers: J, body: { content: '<b>' + subject + '</b><br>' + summary.replace(/\n/g, '<br>') } };
    break;
  case 'monday': {
    const m = rec._monday;
    if (!m) throw new Error('monday mapping missing - Discover Schema did not run.');
    // JSON.stringify yields a valid GraphQL string literal (quotes, backslashes
    // and newlines escaped). column_values is a JSON document inside one.
    const q = (v) => JSON.stringify(String(v));
    const grp = m.group_id ? `group_id: ${q(m.group_id)}, ` : '';
    _req = { url: 'https://api.monday.com/v2',
      headers: { ...J, Authorization: c.crm_token, 'API-Version': '2024-10' },
      body: { query: `mutation { create_item (board_id: ${Number(m.board_id)}, ${grp}` +
        `item_name: ${q(m.item_name)}, ` +
        `column_values: ${q(JSON.stringify(m.column_values))}) { id } }` } };
    break;
  }
  default:           // generic webhook - canonical record, untouched
    _req = { url: c.crm_webhook, headers: J, body: rec };
}
if (!_req.url) throw new Error('No CRM target configured. Set CRM_WEBHOOK_URL or CRM_PROVIDER + CRM_BASE_URL.');
return [{ json: { ...rec, _req } }];
