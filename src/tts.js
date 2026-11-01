// Text-to-speech through Gemini 3.8 Flash TTS. Works with prebuilt voices ("Kore")
// and your own designed/replicated voices ("voice_...").
const crypto = require('crypto');

const MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-tts';
const cache = new Map(); // small in-memory cache so replaying a reply is free
const CACHE_MAX = 40;

function speakable(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_#>`]/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\$(\d)/g, '$1 dollars ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);
}

async function synthesize(text, voice, style) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) { const e = new Error('GEMINI_API_KEY is not set'); e.status = 503; throw e; }
  const clean = speakable(text);
  if (!clean) throw Object.assign(new Error('Nothing to read'), { status: 400 });
  const ck = crypto.createHash('sha256').update(`${voice}|${style}|${clean}`).digest('hex');
  if (cache.has(ck)) return cache.get(ck);
  const content = { type: 'text', text: clean };
  if (style) content.annotations = [{ type: 'speech_metadata', style }];
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      input: [{ type: 'user_input', content: [content] }],
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice: voice || 'Kore' }] },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const e = new Error(`Voice service error (${res.status})${body ? `: ${body.slice(0, 200)}` : ''}`); e.status = 502; throw e;
  }
  const data = await res.json();
  let b64 = data.output_audio?.data;
  if (!b64) {
    const out = (data.steps || []).filter((s) => s.type === 'model_output').flatMap((s) => s.content || []).filter((c) => c.type === 'audio');
    b64 = out.length ? out[out.length - 1].data : null;
  }
  if (!b64) throw Object.assign(new Error('No audio returned'), { status: 502 });
  const wav = Buffer.from(b64, 'base64');
  cache.set(ck, wav);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return wav;
}

module.exports = { synthesize, speakable, enabled: () => !!process.env.GEMINI_API_KEY };
