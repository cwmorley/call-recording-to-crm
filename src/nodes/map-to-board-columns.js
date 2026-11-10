// Map canonical record -> this board's actual column ids.
// Deterministic synonym + type matching. Reliable, debuggable, no LLM needed here.
const c = $('Runtime Config').first().json._cfg;
const rec = $('Validate Extraction').first().json;
const resp = $json;

if (c.crm_provider !== 'monday') return [{ json: rec }];

const board = resp?.data?.boards?.[0];
if (!board) throw new Error('monday board not found or token lacks access.');
const cols = board.columns || [];

const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const SYNONYMS = {
  summary:      ['summary','callsummary','notes','callnotes','description','details'],
  commitments:  ['commitments','repcommitments','promised','followups','owed'],
  next_steps:   ['nextsteps','nextstep','actions','actionitems','todo'],
  objections:   ['objections','concerns','blockers'],
  pain_points:  ['painpoints','pain','challenges','problems','needs'],
  competitors:  ['competitors','competition','competitor','vsvendor'],
  risk:         ['risk','riskflags','dealrisk','healthflags'],
  stage:        ['stage','status','dealstage','pipelinestage'],
  timeline:     ['timeline','closedate','expectedclose','targetdate'],
  confidence:   ['confidence','aiconfidence','score'],
  account:      ['account','company','organisation','organization','client','customer']
};
const findCol = (key, allowed) => {
  const wants = SYNONYMS[key] || [];
  return cols.find(col => wants.includes(norm(col.title)) &&
                          (!allowed || allowed.includes(col.type)));
};

const bullets = (arr, f) => (arr || []).map(x => '• ' + f(x)).join('\n');
const summary = [
  rec.rep_commitments?.length ? 'COMMITMENTS BY REP:\n' +
    bullets(rec.rep_commitments, x => x.commitment + (x.due ? ' (due ' + x.due + ')' : '')) : '',
  rec.next_steps?.length ? 'NEXT STEPS:\n' +
    bullets(rec.next_steps, x => x.action + ' [' + (x.owner || 'unassigned') + ']') : '',
  rec.objections?.length ? 'OBJECTIONS:\n' + bullets(rec.objections, x => x.objection) : '',
  rec.pain_points?.length ? 'PAIN POINTS:\n' + bullets(rec.pain_points, x => x.paraphrase) : '',
  rec.competitors_mentioned?.length ?
    'COMPETITORS: ' + rec.competitors_mentioned.map(x => x.name).join(', ') : '',
  rec.risk_flags?.length ? 'RISK: ' + rec.risk_flags.join(', ') : ''
].filter(Boolean).join('\n\n');

const TEXTY = ['text','long_text'];
const values = {}; const mapped = []; const unmapped = [];
const put = (key, val, allowed) => {
  const col = findCol(key, allowed);
  if (col) { values[col.id] = val; mapped.push(`${key} -> ${col.title} (${col.id})`); }
  else unmapped.push(key);
};

put('summary',     summary, TEXTY);
put('commitments', bullets(rec.rep_commitments, x => x.commitment), TEXTY);
put('next_steps',  bullets(rec.next_steps, x => x.action), TEXTY);
put('objections',  bullets(rec.objections, x => x.objection), TEXTY);
put('pain_points', bullets(rec.pain_points, x => x.paraphrase), TEXTY);
put('competitors', (rec.competitors_mentioned || []).map(x => x.name).join(', '), TEXTY);
put('risk',        (rec.risk_flags || []).join(', '), TEXTY);
put('confidence',  rec.confidence, ['numbers']);

const stageCol = findCol('stage', ['status','color']);
if (stageCol && rec.recommended_stage) {
  values[stageCol.id] = { label: rec.recommended_stage };
  mapped.push(`stage -> ${stageCol.title} (${stageCol.id})`);
} else if (rec.recommended_stage) unmapped.push('stage');

return [{ json: { ...rec, _monday: {
  board_id: board.id, board_name: board.name,
  group_id: c.monday_group || board.groups?.[0]?.id || '',
  item_name: 'Call - ' + (rec.account.name || 'Unknown') + ' - ' +
             new Date(rec.start_time).toISOString().slice(0,10),
  column_values: values,
  // surfaced deliberately: unmapped fields ARE the audit finding
  mapping_report: { mapped, unmapped,
    note: unmapped.length ? 'Board has no column for: ' + unmapped.join(', ') +
          '. Extraction is richer than the board can store.' : 'All fields mapped.' }
} }}];
