// Map-reduce. Small models degrade over long context; even large ones lose recall.
const r = $input.first().json;
const segs = r.segments || [];
const MAX = 1200;
const chunks = []; let cur = [], words = 0;
for (const s of segs) {
  const w = (s.text || '').split(/\s+/).length;
  if (words + w > MAX && cur.length) {
    chunks.push(cur);
    cur = [cur[cur.length - 1]];                 // 1-turn overlap
    words = (cur[0].text || '').split(/\s+/).length;
  }
  cur.push(s); words += w;
}
if (cur.length) chunks.push(cur);
return chunks.map((c, i) => ({ json: { chunk_id: i, chunk_total: chunks.length,
  meeting_id: r.meeting_id,
  text: c.map(s => `${s.speaker || 'SPEAKER'}: ${s.text}`).join('\n') } }));
