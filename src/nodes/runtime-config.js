// ===== RUNTIME CONFIG - the only node you edit =====
// Providers auto-select on key presence: keys -> cloud, no keys -> local.
// API keys are deliberately NOT copied into this node's output. n8n stores every
// node's output in execution data, so a key placed here would be readable in
// every later node of every saved execution. The request-builder nodes read the
// key from the environment at the moment they build an HTTP request instead.
// n8n 2.x blocks $env by default: set N8N_BLOCK_ENV_ACCESS_IN_NODE=false.
const env = (k) => { try { return $env[k] || ''; } catch (e) { return ''; } };

const CFG = {
  ollama_url:    env('OLLAMA_URL')  || 'http://host.docker.internal:11434',
  whisper_url:   env('WHISPER_URL') || 'http://host.docker.internal:8000',
  openai_model:    env('OPENAI_MODEL')    || 'gpt-4o-mini',
  anthropic_model: env('ANTHROPIC_MODEL') || 'claude-sonnet-4-20250514',
  ollama_model:    env('OLLAMA_MODEL')    || 'qwen2.5:7b',
  crm_provider:  (env('CRM_PROVIDER') || 'webhook').toLowerCase(),
  crm_webhook:   env('CRM_WEBHOOK_URL'),
  crm_base:      env('CRM_BASE_URL'),
  monday_board:  env('MONDAY_BOARD_ID'),
  monday_group:  env('MONDAY_GROUP_ID') || '',
  min_conf:      Number(env('MIN_CONFIDENCE') || 0.6)
};

// --- provider election -------------------------------------------------
let llm = 'ollama';
if (env('OPENAI_API_KEY')) llm = 'openai';
else if (env('ANTHROPIC_API_KEY')) llm = 'anthropic';

let stt = 'local';
if (env('DEEPGRAM_API_KEY')) stt = 'deepgram';      // cloud: diarization and per-channel transcripts

const ctx = $input.first().json;
return [{ json: { ...ctx, _cfg: { ...CFG, llm_provider: llm, stt_provider: stt },
  _routing: { llm, stt, crm: CFG.crm_provider,
    note: `LLM=${llm} STT=${stt} CRM=${CFG.crm_provider}` } }}];
