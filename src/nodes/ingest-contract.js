// Normalized ingest contract. Every acquisition path emits this shape.
// audio_ref and meeting_id are interpolated into the ffmpeg command line by the
// next node, so both are constrained here: anything that could break out of the
// quoted shell argument is rejected instead of being passed through.
const DEMO = '/data/recordings/sample-call.m4a';
const i = $input.first().json || {};

const audioRef = String(i.path || i.filePath || i.audio_ref || DEMO);
if (/["'`$\\\n\r;|&<>]/.test(audioRef)) {
  throw new Error('audio_ref contains characters that are not allowed in a file reference.');
}

const rawId = String(i.meeting_id || ('local-' + Date.now()));
const meetingId = rawId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || ('local-' + Date.now());

const channels = i.channels === 'dual' ? 'dual' : 'mono'; // 'dual' = per-leg channels, no diarization needed

return [{ json: {
  audio_ref:    audioRef,
  meeting_id:   meetingId,
  participants: Array.isArray(i.participants) ? i.participants : [],
  start_time:   i.start_time || new Date().toISOString(),
  duration_sec: Number(i.duration_sec) || 0,
  channels,
  source:       i.source || 'folder' } }];
