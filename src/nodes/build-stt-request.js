// Build STT request. Cloud STT needs the audio bytes; local takes a path.
const c = $json._cfg;
const wav = '/data/work/' + $json.meeting_id + '.wav';

if (c.stt_provider === 'deepgram') {
  return [{ json: { ...$json, _stt: { mode: 'binary', file: wav,
    url: 'https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&diarize=true&punctuate=true',
    headers: { Authorization: 'Token ' + c.deepgram_key, 'Content-Type': 'audio/wav' } }}}];
}
if (c.stt_provider === 'openai') {
  return [{ json: { ...$json, _stt: { mode: 'multipart', file: wav,
    url: 'https://api.openai.com/v1/audio/transcriptions',
    headers: { Authorization: 'Bearer ' + c.openai_key } }}}];
}
return [{ json: { ...$json, _stt: { mode: 'json' },
  _req: { url: c.whisper_url + '/transcribe', headers: { 'Content-Type': 'application/json' },
    body: { path: wav, meeting_id: $json.meeting_id, channels: $json.channels,
            diarize: $json.channels !== 'dual' } } }}];
