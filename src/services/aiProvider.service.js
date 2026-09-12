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

async function callGemini(systemPrompt, userPrompt) {
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: { responseMimeType: 'application/json' },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Gemini request failed');
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
  if (!res.ok) throw new Error(data.error?.message || 'Claude request failed');
  const text = data.content?.[0]?.text;
  if (!text) throw new Error('Claude returned an empty response');
  return text;
}

// Sends a prompt pair and returns parsed JSON. `systemPrompt` should instruct the
// model to reply with JSON only.
async function askForJson(systemPrompt, userPrompt) {
  const provider = activeProvider();
  if (!provider) {
    const err = new Error('AI Teacher is not configured yet (no GEMINI_API_KEY or ANTHROPIC_API_KEY set).');
    err.code = 'AI_NOT_CONFIGURED';
    throw err;
  }
  const raw = provider === 'gemini' ? await callGemini(systemPrompt, userPrompt) : await callAnthropic(systemPrompt, userPrompt);
  const jsonText = extractJson(raw);
  try {
    return JSON.parse(jsonText);
  } catch {
    throw new Error('AI response was not valid JSON');
  }
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (fenced ? fenced[1] : text).trim();
}

module.exports = { isConfigured, activeProvider, askForJson };
