// ElevenLabs batch STT + TTS. Batch STT (POST the whole clip on release)
// was chosen over the realtime WebSocket per the "ship the fallback first"
// rule — one HTTP call, no stream plumbing.
const API_KEY = () => process.env.ELEVENLABS_API_KEY;

async function transcribe(audioBuffer, mimeType = 'audio/webm') {
  if (!API_KEY()) throw new Error('No ELEVENLABS_API_KEY in .env');

  // scribe_v2 per spec; older accounts only have scribe_v1, so fall back.
  let lastErr;
  for (const modelId of ['scribe_v2', 'scribe_v1']) {
    const form = new FormData();
    form.append('file', new Blob([audioBuffer], { type: mimeType }), 'clip.webm');
    form.append('model_id', modelId);
    const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': API_KEY() },
      body: form,
      signal: AbortSignal.timeout(20000),
    });
    if (res.ok) {
      const json = await res.json();
      return (json.text || '').trim();
    }
    lastErr = `STT ${modelId}: HTTP ${res.status} ${await res.text().catch(() => '')}`;
    if (res.status !== 400 && res.status !== 422) break; // only retry on bad-model errors
  }
  throw new Error(lastErr);
}

async function tts(text) {
  if (!API_KEY()) throw new Error('No ELEVENLABS_API_KEY in .env');
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  const modelId = process.env.ELEVENLABS_TTS_MODEL || 'eleven_flash_v2_5';
  if (!voiceId) throw new Error('No ELEVENLABS_VOICE_ID in .env');

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_64`,
    {
      method: 'POST',
      headers: { 'xi-api-key': API_KEY(), 'content-type': 'application/json' },
      body: JSON.stringify({ text, model_id: modelId }),
      signal: AbortSignal.timeout(15000),
    }
  );
  if (!res.ok) throw new Error(`TTS: HTTP ${res.status} ${await res.text().catch(() => '')}`);
  return Buffer.from(await res.arrayBuffer());
}

module.exports = { transcribe, tts };
