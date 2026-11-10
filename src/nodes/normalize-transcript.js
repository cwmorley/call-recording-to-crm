// Flatten every provider's response into ONE shape:
// { meeting_id, segments: [{speaker,start,end,text}] }
const r = $input.first().json;
const ctx = $('Runtime Config').first().json;
let segments = [];

if (Array.isArray(r.segments) && r.segments.length && r.segments[0].speaker !== undefined) {
  segments = r.segments;                                   // local service - already normalized
} else if (r.results?.channels) {                          // Deepgram
  const alt = r.results.channels[0].alternatives[0];
  const words = alt.words || [];
  if (words.length && words[0].speaker !== undefined) {
    let cur = null;
    for (const w of words) {
      const spk = 'SPEAKER_' + w.speaker;
      if (!cur || cur.speaker !== spk) {
        if (cur) segments.push(cur);
        cur = { speaker: spk, start: w.start, end: w.end, text: '' };
      }
      cur.text += (cur.text ? ' ' : '') + (w.punctuated_word || w.word);
      cur.end = w.end;
    }
    if (cur) segments.push(cur);
  } else {
    segments = [{ speaker: 'SPEAKER', start: 0, end: 0, text: alt.transcript || '' }];
  }
} else if (Array.isArray(r.segments)) {                    // OpenAI verbose_json - NO diarization
  segments = r.segments.map(s => ({ speaker: 'SPEAKER', start: s.start, end: s.end,
                                    text: (s.text || '').trim() }));
} else if (r.text) {
  segments = [{ speaker: 'SPEAKER', start: 0, end: 0, text: r.text }];
}

if (!segments.length) throw new Error('Transcription returned no segments.');
return [{ json: { meeting_id: ctx.meeting_id, segments } }];
