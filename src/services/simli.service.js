// Simli real-time talking-avatar video (api.simli.ai). Ported from the sibling app
// PassNow's confirmed-working integration (real API key, live in that environment):
// the backend mints a short-lived session token server-side and the browser SDK
// connects with that token over WebRTC (P2P mode). This replaces an earlier direct
// apiKey+faceID browser-connect flow written against Simli's older SDK -- that
// approach broke once the pinned simli-client version's whole API surface changed in
// a later major release, and the session-token model is what Simli's current SDK and
// PassNow's own working integration both use.

function isConfigured() {
  return !!(process.env.SIMLI_API_KEY && process.env.SIMLI_FACE_ID);
}

async function createSessionToken() {
  if (!isConfigured()) {
    const err = new Error('The AI video avatar is not configured yet (missing SIMLI_API_KEY / SIMLI_FACE_ID).');
    err.code = 'SIMLI_NOT_CONFIGURED';
    throw err;
  }
  const res = await fetch('https://api.simli.ai/compose/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-simli-api-key': process.env.SIMLI_API_KEY },
    body: JSON.stringify({ faceId: process.env.SIMLI_FACE_ID, audioInputFormat: 'pcm16' }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.session_token || data.session_token === 'FAIL TOKEN') {
    console.error('Simli session token request failed:', res.status, data);
    const err = new Error('Could not start the video avatar right now. Please try again.');
    err.code = 'SIMLI_NOT_CONFIGURED';
    throw err;
  }
  return data.session_token;
}

module.exports = { isConfigured, createSessionToken };
