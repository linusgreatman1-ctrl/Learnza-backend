// Flutterwave, server side. The browser opens Flutterwave's own checkout popup with the PUBLIC
// key (see public/extras.js); everything that decides whether money was really paid happens
// here with the SECRET key, which never leaves the server.
const BASE_URL = 'https://api.flutterwave.com/v3';

const isConfigured = () => !!process.env.FLUTTERWAVE_SECRET_KEY;

// Asks Flutterwave about a payment by the reference we gave it (tx_ref). Resolves
// { ok, amountKobo } — ok is true only for a successful, completed transaction.
async function verifyByReference(reference) {
  if (!isConfigured()) return { ok: false, reason: 'not_configured' };
  try {
    const res = await fetch(`${BASE_URL}/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` },
    });
    if (!res.ok) return { ok: false, reason: 'http_' + res.status };
    const body = await res.json();
    return {
      ok: body && body.status === 'success' && body.data && body.data.status === 'successful',
      amountKobo: body && body.data && typeof body.data.amount === 'number' ? Math.round(body.data.amount * 100) : null,
    };
  } catch (err) {
    console.error('[flutterwave] verify failed:', err.message);
    return { ok: false, reason: 'network' };
  }
}

// Flutterwave webhooks are authenticated by a static shared secret in the verif-hash header.
function verifyWebhookSignature(signatureHeader) {
  const expected = process.env.FLUTTERWAVE_WEBHOOK_HASH || process.env.FLUTTERWAVE_SECRET_HASH;
  if (!expected || !signatureHeader) return false;
  const a = Buffer.from(String(signatureHeader));
  const b = Buffer.from(expected);
  return a.length === b.length && require('crypto').timingSafeEqual(a, b);
}

module.exports = { isConfigured, verifyByReference, verifyWebhookSignature };
