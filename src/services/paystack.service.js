const crypto = require('crypto');

const BASE_URL = 'https://api.paystack.co';

function isConfigured() {
  return !!process.env.PAYSTACK_SECRET_KEY;
}

async function initializeTransaction({ email, amountKobo, reference, callbackUrl, metadata }) {
  if (!isConfigured()) throw new Error('Paystack is not configured (missing PAYSTACK_SECRET_KEY)');
  const res = await fetch(`${BASE_URL}/transaction/initialize`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, amount: amountKobo, reference, callback_url: callbackUrl, metadata }),
  });
  const data = await res.json();
  if (!res.ok || !data.status) throw new Error(data.message || 'Paystack initialization failed');
  return data.data; // { authorization_url, access_code, reference }
}

async function verifyTransaction(reference) {
  if (!isConfigured()) throw new Error('Paystack is not configured (missing PAYSTACK_SECRET_KEY)');
  const res = await fetch(`${BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
  });
  const data = await res.json();
  if (!res.ok || !data.status) throw new Error(data.message || 'Paystack verification failed');
  return data.data; // { status: 'success'|..., amount, reference, ... }
}

// Paystack signs webhook bodies with HMAC-SHA512 of the raw request body using the secret key.
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!isConfigured() || !signatureHeader) return false;
  const expected = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false;
  }
}

module.exports = { isConfigured, initializeTransaction, verifyTransaction, verifyWebhookSignature };
