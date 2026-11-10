// Flatten every provider's response into ONE shape:
// { meeting_id, segments: [{speaker,start,end,text}] }
const r = $input.first().json;
const ctx = $('Runtime Config').first().json;
let segments = [];

if (Array.isArray(r.segments)) {
  segments = r.segments;                                   // local service - already normalized
} else if (r.results?.channels) {                          // Deepgram
  const channels = r.results.channels;
  // multichannel: one entry per audio channel, labelled like the local service
  // (left = REP, right = PROSPECT). Otherwise the diarized speaker index.
  const LEGS = ['REP', 'PROSPECT'];
  const words = channels.flatMap((ch, idx) => (ch.alternatives?.[0]?.words || []).map((w) => ({ ...w,
    _spk: channels.length > 1 ? (LEGS[idx] || 'CHANNEL_' + idx)
        : w.speaker !== undefined ? 'SPEAKER_' + w.speaker : 'SPEAKER' })));
  if (channels.length > 1) words.sort((a, b) => a.start - b.start);
  let cur = null;
  for (const w of words) {
    if (!cur || cur.speaker !== w._spk) {
      if (cur) segments.push(cur);
      cur = { speaker: w._spk, start: w.start, end: w.end, text: '' };
    }
    cur.text += (cur.text ? ' ' : '') + (w.punctuated_word || w.word);
    cur.end = w.end;
  }
  if (cur) segments.push(cur);
  if (!segments.length) {
    const text = channels.map((ch) => ch.alternatives?.[0]?.transcript || '').join(' ').trim();
    if (text) segments = [{ speaker: 'SPEAKER', start: 0, end: 0, text }];
  }
}

if (!segments.length) throw new Error('Transcription returned no segments.');
return [{ json: { meeting_id: ctx.meeting_id, segments } }];
