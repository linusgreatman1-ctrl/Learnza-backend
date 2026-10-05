// Paystack, server side. Paystack is a second way to pay online beside Flutterwave: the server
// asks Paystack for a checkout page, the browser goes there and comes back, and the server then
// confirms the payment with its SECRET key (and again from Paystack's signed webhook).
const crypto = require('crypto');

const BASE_URL = 'https://api.paystack.co';

const isConfigured = () => !!process.env.PAYSTACK_SECRET_KEY;

async function initializeTransaction({ email, amountKobo, reference, callbackUrl, metadata }) {
  if (!isConfigured()) throw new Error('Paystack is not configured (missing PAYSTACK_SECRET_KEY)');
  const res = await fetch(`${BASE_URL}/transaction/initialize`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, amount: amountKobo, reference, callback_url: callbackUrl, metadata }),
  });
  const data = await res.json();
  if (!res.ok || !data.status) throw new Error(data.message || 'Paystack initialization failed');
  return data.data; // { authorization_url, access_code, reference }
}

// Asks Paystack about a payment by the reference we gave it. Resolves { ok, amountKobo } --
// ok is true only for a completed, successful transaction.
async function verifyByReference(reference) {
  if (!isConfigured()) return { ok: false, reason: 'not_configured' };
  try {
    const res = await fetch(`${BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
    });
    if (!res.ok) return { ok: false, reason: 'http_' + res.status };
    const body = await res.json();
    return {
      ok: !!(body && body.status && body.data && body.data.status === 'success'),
      amountKobo: body && body.data && typeof body.data.amount === 'number' ? body.data.amount : null,
    };
  } catch (err) {
    console.error('[paystack] verify failed:', err.message);
    return { ok: false, reason: 'network' };
  }
}

// Paystack signs webhook bodies with HMAC-SHA512 of the raw request body using the secret key.
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!isConfigured() || !signatureHeader || !rawBody) return false;
  const expected = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signatureHeader)));
  } catch {
    return false;
  }
}

module.exports = { isConfigured, initializeTransaction, verifyByReference, verifyWebhookSignature };
