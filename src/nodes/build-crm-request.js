// CRM ADAPTER - canonical record -> provider payload.
// Default 'webhook' posts the canonical record anywhere: works with ANY CRM,
// including ones not implemented here. Add a branch to support a new system.
const rec = $json;
const c = $('Runtime Config').first().json._cfg;

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
  case 'zoho':       // NOTE: region-specific domain (.com/.eu/.in/.com.au) via CRM_BASE_URL
    _req = { url: (c.crm_base || 'https://www.zohoapis.com') + '/crm/v5/Calls',
      headers: { ...J, Authorization: 'Zoho-oauthtoken ' + c.crm_token },
      body: { data: [{ Subject: subject, Description: summary,
        Call_Start_Time: rec.start_time, Call_Type: 'Inbound', Call_Duration: '00:30' }] } };
    break;
  case 'hubspot':
    _req = { url: 'https://api.hubapi.com/crm/v3/objects/calls',
      headers: { ...J, Authorization: 'Bearer ' + c.crm_token },
      body: { properties: { hs_call_title: subject, hs_call_body: summary,
        hs_timestamp: rec.start_time, hs_call_direction: 'INBOUND' } } };
    break;
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
    const cv = JSON.stringify(m.column_values).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const grp = m.group_id ? `group_id: "${m.group_id}", ` : '';
    _req = { url: 'https://api.monday.com/v2',
      headers: { ...J, Authorization: c.crm_token, 'API-Version': '2024-10' },
      body: { query: `mutation { create_item (board_id: ${m.board_id}, ${grp}` +
        `item_name: "${m.item_name.replace(/"/g, '\\"')}", ` +
        `column_values: "${cv}") { id } }` } };
    break;
  }
  default:           // generic webhook - canonical record, untouched
    _req = { url: c.crm_webhook, headers: J, body: rec };
}
if (!_req.url) throw new Error('No CRM target configured. Set CRM_WEBHOOK_URL or CRM_PROVIDER + CRM_BASE_URL.');
return [{ json: { ...rec, _req } }];
