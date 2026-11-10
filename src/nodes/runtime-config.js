// ===== RUNTIME CONFIG - the only node you edit =====
// Providers auto-select on key presence: keys -> cloud, no keys -> local.
// $env access can be disabled in some n8n installs; hardcode below if so.
const env = (k) => { try { return $env[k] || ''; } catch (e) { return ''; } };

const CFG = {
  openai_key:    env('OPENAI_API_KEY'),
  anthropic_key: env('ANTHROPIC_API_KEY'),
  deepgram_key:  env('DEEPGRAM_API_KEY'),
  ollama_url:    env('OLLAMA_URL')  || 'http://host.docker.internal:11434',
  whisper_url:   env('WHISPER_URL') || 'http://host.docker.internal:8000',
  openai_model:    env('OPENAI_MODEL')    || 'gpt-4o-mini',
  anthropic_model: env('ANTHROPIC_MODEL') || 'claude-sonnet-4-20250514',
  ollama_model:    env('OLLAMA_MODEL')    || 'qwen2.5:7b',
  crm_provider:  (env('CRM_PROVIDER') || 'webhook').toLowerCase(),
  crm_webhook:   env('CRM_WEBHOOK_URL'),
  crm_token:     env('CRM_TOKEN'),
  crm_base:      env('CRM_BASE_URL'),
  monday_board:  env('MONDAY_BOARD_ID'),
  monday_group:  env('MONDAY_GROUP_ID') || '',
  min_conf:      Number(env('MIN_CONFIDENCE') || 0.6)
};

// --- provider election -------------------------------------------------
let llm = 'ollama';
if (CFG.openai_key) llm = 'openai';
else if (CFG.anthropic_key) llm = 'anthropic';

let stt = 'local';
if (CFG.deepgram_key) stt = 'deepgram';      // preferred cloud: supports diarization
else if (CFG.openai_key) stt = 'openai';     // no diarization available

const ctx = $input.first().json;
return [{ json: { ...ctx, _cfg: { ...CFG, llm_provider: llm, stt_provider: stt },
  _routing: { llm, stt, crm: CFG.crm_provider,
    note: `LLM=${llm} STT=${stt} CRM=${CFG.crm_provider}` } }}];
