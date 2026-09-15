// Simli real-time talking-avatar video (api.simli.ai). Verified against Simli's own
// published tutorials (docs.simli.com's own reference page for this returned an
// inconsistent/renamed endpoint when checked, so this follows the confirmed
// SimliClient browser-SDK pattern instead): the browser's SimliClient connects
// directly to Simli using apiKey + faceID, so the backend's only job is to hand those
// two values to an authenticated, subscribed student -- there's no separate
// "create session" server-to-Simli call in this flow.

function isConfigured() {
  return !!(process.env.SIMLI_API_KEY && process.env.SIMLI_FACE_ID);
}

function getClientConfig() {
  if (!isConfigured()) {
    const err = new Error('The AI video avatar is not configured yet (missing SIMLI_API_KEY / SIMLI_FACE_ID).');
    err.code = 'SIMLI_NOT_CONFIGURED';
    throw err;
  }
  return { apiKey: process.env.SIMLI_API_KEY, faceID: process.env.SIMLI_FACE_ID };
}

module.exports = { isConfigured, getClientConfig };
