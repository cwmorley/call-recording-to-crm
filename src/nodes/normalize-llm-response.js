// Flatten Ollama / OpenAI / Anthropic responses to one shape.
const r = $input.first().json;
let extraction = null, err = null, txt = null;
try {
  if (Array.isArray(r.content)) {                                  // Anthropic
    const tu = r.content.find(c => c.type === 'tool_use');
    if (tu) extraction = tu.input;
    else txt = r.content.map(c => c.text).filter(Boolean).join('');
  } else if (r.choices?.[0]?.message?.content) {                    // OpenAI
    txt = r.choices[0].message.content;
  } else if (r.message?.content) {                                  // Ollama
    txt = r.message.content;
  } else if (r.response) {
    txt = r.response;
  }
  if (!extraction && txt) {
    const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
    extraction = JSON.parse(s >= 0 ? txt.slice(s, e + 1) : txt);
  }
} catch (e) { err = String(e); }

return [{ json: { chunk_id: $('Loop Over Chunks').item.json.chunk_id,
  extraction: extraction || { _parse_error: err || 'no content', _raw: txt } } }];
