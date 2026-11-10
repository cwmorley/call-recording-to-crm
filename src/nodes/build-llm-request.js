// One request builder, three providers. Downstream never knows which ran.
const c = $('Runtime Config').first().json._cfg;
const SCHEMA = {"type": "object", "properties": {"account": {"type": "object", "properties": {"name": {"type": "string"}, "domain": {"type": "string"}}, "required": ["name"]}, "attendees": {"type": "array", "items": {"type": "object", "properties": {"name": {"type": "string"}, "role": {"type": "string"}, "side": {"type": "string", "enum": ["rep", "prospect", "unknown"]}}, "required": ["name", "side"]}}, "qualification": {"type": "object", "properties": {"budget_signals": {"type": "array", "items": {"type": "string"}}, "authority": {"type": "array", "items": {"type": "string"}}, "need": {"type": "array", "items": {"type": "string"}}, "timeline": {"type": "string"}, "metrics_mentioned": {"type": "array", "items": {"type": "string"}}}}, "pain_points": {"type": "array", "items": {"type": "object", "properties": {"paraphrase": {"type": "string"}, "verbatim_quote": {"type": "string"}, "severity": {"type": "string", "enum": ["low", "medium", "high", "unknown"]}}, "required": ["paraphrase"]}}, "competitors_mentioned": {"type": "array", "items": {"type": "object", "properties": {"name": {"type": "string"}, "context": {"type": "string"}}, "required": ["name"]}}, "objections": {"type": "array", "items": {"type": "object", "properties": {"objection": {"type": "string"}, "rep_response": {"type": "string"}, "resolved": {"type": "boolean"}}, "required": ["objection"]}}, "rep_commitments": {"type": "array", "items": {"type": "object", "properties": {"commitment": {"type": "string"}, "due": {"type": "string"}, "explicit": {"type": "boolean"}}, "required": ["commitment"]}}, "next_steps": {"type": "array", "items": {"type": "object", "properties": {"action": {"type": "string"}, "owner": {"type": "string"}, "due_date": {"type": "string"}}, "required": ["action"]}}, "risk_flags": {"type": "array", "items": {"type": "string"}}, "recommended_stage": {"type": "string"}, "confidence": {"type": "number"}}, "required": ["account", "pain_points", "rep_commitments", "next_steps", "confidence"]};
const SYSTEM = "You extract structured sales-call intelligence from a transcript chunk.\nRULES:\n1. Extract ONLY what is explicitly supported by the transcript. Never infer or invent.\n2. If a field has no support in this chunk, return an empty array or empty string.\n3. rep_commitments = things the SALES REP promised to do (send pricing, intro an SE, follow up by a date). Highest-value field. Do not confuse with prospect actions.\n4. verbatim_quote must be an exact substring of the transcript.\n5. confidence = honest 0..1 confidence for THIS chunk. Low is fine and expected.\nReturn JSON only.";
const user = `Transcript chunk ${$json.chunk_id + 1} of ${$json.chunk_total}:\n\n${$json.text}`;

let _req;
if (c.llm_provider === 'openai') {
  _req = { url: 'https://api.openai.com/v1/chat/completions',
    headers: { Authorization: 'Bearer ' + c.openai_key, 'Content-Type': 'application/json' },
    body: { model: c.openai_model, temperature: 0,
      response_format: { type: 'json_schema',
        json_schema: { name: 'call_extraction', schema: SCHEMA } },
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }] } };
} else if (c.llm_provider === 'anthropic') {
  // Anthropic has no response_format; force a tool call to get schema-valid JSON.
  _req = { url: 'https://api.anthropic.com/v1/messages',
    headers: { 'x-api-key': c.anthropic_key, 'anthropic-version': '2023-06-01',
               'Content-Type': 'application/json' },
    body: { model: c.anthropic_model, max_tokens: 4096, temperature: 0, system: SYSTEM,
      messages: [{ role: 'user', content: user }],
      tools: [{ name: 'record_extraction', description: 'Return the structured extraction',
                input_schema: SCHEMA }],
      tool_choice: { type: 'tool', name: 'record_extraction' } } };
} else {
  _req = { url: c.ollama_url + '/api/chat',
    headers: { 'Content-Type': 'application/json' },
    body: { model: c.ollama_model, stream: false, format: SCHEMA,
      options: { temperature: 0, num_ctx: 8192 },
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }] } };
}
return [{ json: { ...$json, _req } }];
