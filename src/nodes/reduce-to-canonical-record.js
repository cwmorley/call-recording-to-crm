// Reduce chunk extractions -> one canonical record. CRM-neutral by design.
const items = $input.all().map(i => i.json).filter(Boolean);
const ctx = $('Runtime Config').first().json;
const cfg = ctx._cfg;

const good = items.filter(i => i.extraction && !i.extraction._parse_error);
const dedupe = (arr, key) => { const seen = new Set(), out = [];
  for (const x of arr) {
    const k = String(typeof x === 'string' ? x : (x[key] ?? JSON.stringify(x))).toLowerCase().trim();
    if (k && !seen.has(k)) { seen.add(k); out.push(x); } }
  return out; };
const gather = (path, key) => dedupe(good.flatMap(i => {
  const v = path.split('.').reduce((o, p) => (o ?? {})[p], i.extraction);
  return Array.isArray(v) ? v : []; }), key);

const names = good.map(i => i.extraction?.account?.name).filter(Boolean);
const confs = good.map(i => Number(i.extraction?.confidence)).filter(n => !isNaN(n));
const avg = confs.length ? confs.reduce((a,b) => a+b, 0) / confs.length : 0;
const parseRate = items.length ? good.length / items.length : 0;

return [{ json: {
  meeting_id: ctx.meeting_id, source: ctx.source, start_time: ctx.start_time,
  account: { name: names.sort((a,b) =>
      names.filter(v=>v===b).length - names.filter(v=>v===a).length)[0] || '' },
  attendees:             gather('attendees','name'),
  pain_points:           gather('pain_points','paraphrase'),
  competitors_mentioned: gather('competitors_mentioned','name'),
  objections:            gather('objections','objection'),
  rep_commitments:       gather('rep_commitments','commitment'),
  next_steps:            gather('next_steps','action'),
  risk_flags:            gather('risk_flags'),
  qualification: {
    budget_signals: gather('qualification.budget_signals'),
    authority: gather('qualification.authority'),
    need: gather('qualification.need'),
    metrics_mentioned: gather('qualification.metrics_mentioned'),
    timeline: good.map(i => i.extraction?.qualification?.timeline).filter(Boolean)[0] || '' },
  recommended_stage: good.map(i => i.extraction?.recommended_stage).filter(Boolean)[0] || '',
  confidence: Number((avg * parseRate).toFixed(3)),
  _min_confidence: cfg.min_conf,
  provenance: { llm_provider: cfg.llm_provider, stt_provider: cfg.stt_provider,
    model: cfg.llm_provider === 'openai' ? cfg.openai_model
         : cfg.llm_provider === 'anthropic' ? cfg.anthropic_model : cfg.ollama_model,
    chunks_total: items.length, chunks_parsed: good.length,
    chunks_failed: items.length - good.length,
    generated_at: new Date().toISOString() } } }];
