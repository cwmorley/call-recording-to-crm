// Build STT request. Cloud STT needs the audio bytes; local takes a path.
// The previous node (Execute Command) outputs only { exitCode, stderr, stdout },
// so the call context is read from Runtime Config, not from $json.
const ctx = $('Runtime Config').first().json;
const c = ctx._cfg;
const wav = '/data/work/' + ctx.meeting_id + '.wav';
const dual = ctx.channels === 'dual';

if (c.stt_provider === 'deepgram') {
  // dual: one transcript per channel (exact speakers). mono: diarization.
  return [{ json: { _stt: { mode: 'binary', file: wav,
    url: 'https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&punctuate=true&' +
         (dual ? 'multichannel=true' : 'diarize=true'),
    headers: { Authorization: 'Token ' + c.deepgram_key, 'Content-Type': 'audio/wav' } } } }];
}
return [{ json: { _stt: { mode: 'json' },
  _req: { url: c.whisper_url + '/transcribe', headers: { 'Content-Type': 'application/json' },
    body: { path: wav, meeting_id: ctx.meeting_id, channels: ctx.channels, diarize: !dual } } } }];
