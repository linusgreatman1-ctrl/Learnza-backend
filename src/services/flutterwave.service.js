const BASE_URL = 'https://api.flutterwave.com/v3';

function isConfigured() {
  return !!process.env.FLUTTERWAVE_SECRET_KEY;
}

async function initializePayment({ email, amountNaira, reference, redirectUrl, meta }) {
  if (!isConfigured()) throw new Error('Flutterwave is not configured (missing FLUTTERWAVE_SECRET_KEY)');
  const res = await fetch(`${BASE_URL}/payments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      tx_ref: reference,
      amount: amountNaira,
      currency: 'NGN',
      redirect_url: redirectUrl,
      customer: { email },
      meta,
    }),
  });
  const data = await res.json();
  if (!res.ok || data.status !== 'success') throw new Error(data.message || 'Flutterwave initialization failed');
  return data.data; // { link }
}

async function verifyTransaction(transactionId) {
  if (!isConfigured()) throw new Error('Flutterwave is not configured (missing FLUTTERWAVE_SECRET_KEY)');
  const res = await fetch(`${BASE_URL}/transactions/${encodeURIComponent(transactionId)}/verify`, {
    headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` },
  });
  const data = await res.json();
  if (!res.ok || data.status !== 'success') throw new Error(data.message || 'Flutterwave verification failed');
  return data.data; // { status: 'successful'|..., amount, tx_ref, ... }
}

// Flutterwave webhooks are authenticated by a static shared secret hash header, not HMAC.
function verifyWebhookSignature(signatureHeader) {
  const expected = process.env.FLUTTERWAVE_WEBHOOK_HASH;
  if (!expected || !signatureHeader) return false;
  return signatureHeader === expected;
}

module.exports = { isConfigured, initializePayment, verifyTransaction, verifyWebhookSignature };
