// Normalized ingest contract. Every acquisition path emits this shape.
// audio_ref and meeting_id are interpolated into the ffmpeg command line by the
// next node, so both are constrained here: anything that could break out of the
// quoted shell argument is rejected instead of being passed through.
//
// Optional fields a caller may supply when it knows them:
//   direction  'inbound' | 'outbound'   (omitted = unknown; adapters never guess it)
//   crm_refs   { contact_id, deal_id, company_id }   existing CRM record ids the
//              call should be associated to. Read by Build CRM Request.
const DEMO = '/data/recordings/sample-call.m4a';
const i = $input.first().json || {};

const audioRef = String(i.path || i.filePath || i.audio_ref || DEMO);
// Inside a double-quoted sh argument only " $ ` and \ are special. Control
// characters (newline, NUL) are rejected too. & ; | < > are inert there and are
// common in signed recording URLs, so they are allowed.
if (/["`$\\\x00-\x1f\x7f]/.test(audioRef)) {
  throw new Error('audio_ref contains characters that are not allowed in a file reference.');
}

const rawId = String(i.meeting_id || ('local-' + Date.now()));
const meetingId = rawId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || ('local-' + Date.now());

const channels = i.channels === 'dual' ? 'dual' : 'mono'; // 'dual' = per-leg channels, no diarization needed

const start = i.start_time ? new Date(i.start_time) : new Date();
if (isNaN(start.getTime())) throw new Error('start_time is not a valid date: ' + String(i.start_time).slice(0, 40));

const direction = ['inbound', 'outbound'].find((d) => d === String(i.direction || '').toLowerCase()) || '';

const crmRefs = {};
for (const key of ['contact_id', 'deal_id', 'company_id']) {
  const id = String((i.crm_refs && typeof i.crm_refs === 'object' && i.crm_refs[key]) || '');
  if (/^[A-Za-z0-9_-]{1,64}$/.test(id)) crmRefs[key] = id;
}

return [{ json: {
  audio_ref:    audioRef,
  meeting_id:   meetingId,
  participants: Array.isArray(i.participants) ? i.participants : [],
  start_time:   start.toISOString(),
  duration_sec: Number(i.duration_sec) || 0,
  channels,
  direction,
  crm_refs:     crmRefs,
  source:       i.source || 'folder' } }];
