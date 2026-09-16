// Provider-agnostic AI layer: picks Gemini or Claude based on whichever API key is
// present (Gemini first, matching the sibling PassNow project), and throws a clear,
// catchable error when neither is configured yet -- callers turn that into a friendly
// "AI Teacher isn't set up yet" response rather than a crash.

function isConfigured() {
  return !!(process.env.GEMINI_API_KEY || process.env.ANTHROPIC_API_KEY);
}

function activeProvider() {
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return null;
}

async function callGemini(systemPrompt, userPrompt, { json = true } = {}) {
  // gemini-2.0-flash was retired by Google (confirmed live 2026-09-15: the API now
  // 404s with "no longer available", not a slow deprecation warning) -- this was
  // silently broken the whole time GEMINI_API_KEY was unset, since every caller hit
  // AI_NOT_CONFIGURED first and never reached this request.
  const model = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      ...(json ? { generationConfig: { responseMimeType: 'application/json' } } : {}),
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    // Every caller (lab Q&A, research assistant, AI Teacher, quiz/lab generation)
    // catches and swallows this into a generic "please try again" -- log it here once,
    // centrally, so a real failure (bad model name, quota, etc.) is actually visible
    // in server logs instead of requiring live reproduction to diagnose.
    console.error('Gemini request failed:', res.status, data.error?.message || data);
    throw new Error(data.error?.message || 'Gemini request failed');
  }
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned an empty response');
  return text;
}

async function callAnthropic(systemPrompt, userPrompt) {
  const model = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error('Claude request failed:', res.status, data.error?.message || data);
    throw new Error(data.error?.message || 'Claude request failed');
  }
  const text = data.content?.[0]?.text;
  if (!text) throw new Error('Claude returned an empty response');
  return text;
}

// Gemini-only: Anthropic's API has no TTS endpoint. Returns raw PCM16 audio (24kHz,
// mono) as a base64 string -- the shape Simli's sendAudioData() expects to stream to
// the video avatar. Reference: https://ai.google.dev/gemini-api/docs/generate-content/speech-generation
async function synthesizeSpeech(text) {
  if (!process.env.GEMINI_API_KEY) {
    const err = new Error('AI Teacher voice synthesis needs GEMINI_API_KEY (Anthropic has no TTS endpoint).');
    err.code = 'AI_NOT_CONFIGURED';
    throw err;
  }
  const model = process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: process.env.GEMINI_TTS_VOICE || 'Kore' } } },
      },
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error('Gemini TTS request failed:', res.status, data.error?.message || data);
    throw new Error(data.error?.message || 'Speech synthesis request failed');
  }
  const part = data.candidates?.[0]?.content?.parts?.[0]?.inlineData;
  if (!part?.data) throw new Error('Speech synthesis returned no audio');
  return { data: part.data, mimeType: part.mimeType || 'audio/pcm', sampleRate: 24000 };
}

// Gemini TTS always returns 24kHz PCM16, but Simli's avatar SDK expects 16kHz PCM16
// input for lip-sync -- linear-interpolation downsample, cheap and good enough for
// speech (no resampling library needed for a 24000->16000 ratio).
function resamplePcm16(buffer, fromRate, toRate) {
  if (fromRate === toRate) return buffer;
  const inSamples = buffer.length / 2;
  const outSamples = Math.max(1, Math.round((inSamples * toRate) / fromRate));
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const srcPos = (i * fromRate) / toRate;
    const srcIdx = Math.floor(srcPos);
    const frac = srcPos - srcIdx;
    const s0 = buffer.readInt16LE(Math.min(srcIdx, inSamples - 1) * 2);
    const s1 = buffer.readInt16LE(Math.min(srcIdx + 1, inSamples - 1) * 2);
    const sample = Math.round(s0 + (s1 - s0) * frac);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
  }
  return out;
}

function requireProvider() {
  const provider = activeProvider();
  if (!provider) {
    const err = new Error('This AI feature is not configured yet (no GEMINI_API_KEY or ANTHROPIC_API_KEY set).');
    err.code = 'AI_NOT_CONFIGURED';
    throw err;
  }
  return provider;
}

// Sends a prompt pair and returns parsed JSON. `systemPrompt` should instruct the
// model to reply with JSON only.
async function askForJson(systemPrompt, userPrompt) {
  const provider = requireProvider();
  const raw = provider === 'gemini' ? await callGemini(systemPrompt, userPrompt, { json: true }) : await callAnthropic(systemPrompt, userPrompt);
  const jsonText = extractJson(raw);
  try {
    return JSON.parse(jsonText);
  } catch {
    throw new Error('AI response was not valid JSON');
  }
}

// Sends a prompt pair and returns the model's raw text reply -- for open-ended
// answers (e.g. the research assistant) where forcing a JSON shape would be wrong.
async function askForText(systemPrompt, userPrompt) {
  const provider = requireProvider();
  return provider === 'gemini' ? callGemini(systemPrompt, userPrompt, { json: false }) : callAnthropic(systemPrompt, userPrompt);
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (fenced ? fenced[1] : text).trim();
}

module.exports = { isConfigured, activeProvider, askForJson, askForText, synthesizeSpeech, resamplePcm16 };
