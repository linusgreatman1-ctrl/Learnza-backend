// Scaffolding for Simli's real-time talking-avatar video (api.simli.ai). Not yet
// verified end-to-end against a live Simli account -- when SIMLI_API_KEY/SIMLI_FACE_ID
// are provided, double-check this request shape against Simli's current docs before
// relying on it, since third-party API contracts can change.

function isConfigured() {
  return !!(process.env.SIMLI_API_KEY && process.env.SIMLI_FACE_ID);
}

async function startSession() {
  if (!isConfigured()) {
    const err = new Error('The AI video avatar is not configured yet (missing SIMLI_API_KEY / SIMLI_FACE_ID).');
    err.code = 'SIMLI_NOT_CONFIGURED';
    throw err;
  }
  const res = await fetch('https://api.simli.ai/startAudioToVideoSession', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiKey: process.env.SIMLI_API_KEY,
      faceId: process.env.SIMLI_FACE_ID,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Failed to start the AI avatar session');
  return data; // expected to include a session token / room details for the client SDK
}

module.exports = { isConfigured, startSession };
