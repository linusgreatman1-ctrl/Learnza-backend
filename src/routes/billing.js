const express = require('express');
const crypto = require('crypto');
const prisma = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { getSubscriptionStatus, isEnforced } = require('../subscription');
const { PLANS, getPlan } = require('../config/plans');
const { bank, flutterwavePublicKey } = require('../config/payments');
const flutterwave = require('../services/flutterwave.service');
const paystack = require('../services/paystack.service');
const payments = require('../services/payments.service');
const coins = require('../services/coins.service');

// Subscriptions, structured like PassNow's: the browser opens Flutterwave's checkout popup (card,
// bank transfer, USSD, mobile money) with the PUBLIC key, or goes to Paystack's checkout page; the
// server fixes the price, verifies the result with the SECRET key and confirms again from the
// provider's webhook. Anyone who would rather pay by plain bank transfer or USSD files a manual
// request that an admin confirms.
const router = express.Router();

const INTERNAL = /@internal\.learnza\.local$/;
// Flutterwave needs a deliverable email address for the receipt; accounts created without one
// carry a placeholder that is not.
// Where Paystack sends the browser back to: the page the payment started from, but only on this
// site (never a address a client invented).
function returnUrl(req) {
  const origin = `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}`;
  try {
    const u = new URL(String(req.body.returnUrl || ''), origin);
    if (u.host === req.get('host')) return u.origin + u.pathname;
  } catch { /* fall through */ }
  return origin + '/app';
}
const payerEmail = (u) => (u.email && !INTERNAL.test(u.email) ? u.email : process.env.PAY_FALLBACK_EMAIL || 'payments@learnza.app');

router.get('/status', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const status = await getSubscriptionStatus(req.user.id);
  res.json({ ...status, enforced: isEnforced() });
});

// Everything the payment screen needs, from one place.
router.get('/config', requireAuth, (req, res) => {
  const { accountNumber, accountName, bankName } = bank;
  res.json({
    flutterwavePublicKey: flutterwavePublicKey(),
    paystack: paystack.isConfigured(),
    bank: { bankName, accountName, accountNumber },
    ussdTemplate: '*966*{amount}*' + accountNumber + '#',
    plans: Object.entries(PLANS).map(([id, p]) => ({ id, label: p.label, amountNaira: p.amountNaira, days: p.days, aiMinutes: p.aiMinutes })),
    packs: coins.PACKS,
  });
});

// Starts an online payment: records a PENDING payment at the server's price. For Flutterwave the
// browser gets the reference to open the popup with; for Paystack it gets the checkout page to go to.
router.post('/initiate', requireAuth, requireRole('STUDENT'), async (req, res) => {
  let plan;
  try { plan = getPlan(req.body.plan); } catch { return res.status(400).json({ error: 'Choose a monthly or yearly plan.' }); }
  const provider = req.body.provider === 'PAYSTACK' ? 'PAYSTACK' : 'FLUTTERWAVE';
  if (provider === 'PAYSTACK' && !paystack.isConfigured()) return res.status(503).json({ error: 'Paystack is not set up yet. Please choose another way to pay.' });
  const reference = `LZ-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
  let authorizationUrl;
  if (provider === 'PAYSTACK') {
    try {
      const init = await paystack.initializeTransaction({ email: payerEmail(req.user), amountKobo: plan.amountKobo, reference, callbackUrl: returnUrl(req), metadata: { userId: req.user.id, plan: req.body.plan } });
      authorizationUrl = init.authorization_url;
    } catch (err) { return res.status(502).json({ error: 'Could not reach Paystack: ' + err.message }); }
  }
  await prisma.payment.create({
    data: { userId: req.user.id, provider, reference, plan: req.body.plan, amountKobo: plan.amountKobo, status: 'PENDING' },
  });
  res.status(201).json({ reference, authorizationUrl, amount: plan.amountNaira, amountKobo: plan.amountKobo, email: payerEmail(req.user), name: req.user.fullName, label: plan.label });
});

// Bank transfer / USSD: nothing to verify against, so it is recorded PENDING for an admin to confirm.
router.post('/manual', requireAuth, requireRole('STUDENT'), async (req, res) => {
  let plan;
  try { plan = getPlan(req.body.plan); } catch { return res.status(400).json({ error: 'Choose a monthly or yearly plan.' }); }
  const reference = `LZ-MANUAL-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
  await prisma.payment.create({
    data: { userId: req.user.id, provider: 'MANUAL_TRANSFER', reference, plan: req.body.plan, amountKobo: plan.amountKobo, status: 'PENDING' },
  });
  res.status(201).json({ reference, message: 'Thanks! Your plan will be activated as soon as the payment is confirmed (usually within 24 hours).' });
});

// The browser calls this right after the popup reports success — a quick confirmation so the
// student is not left looking at "pending". The webhook remains the source of truth. Works for
// subscription payments and coin purchases alike.
router.get('/verify/:reference', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const { reference } = req.params;
  const payment = await prisma.payment.findUnique({ where: { reference } });
  const purchase = payment ? null : await prisma.coinPurchase.findUnique({ where: { reference } });
  const record = payment || purchase;
  if (!record || record.userId !== req.user.id) return res.status(404).json({ error: 'Payment not found' });
  const kind = payment ? 'plan' : 'coins';
  if (record.status === 'SUCCESS') return res.json({ status: 'SUCCESS', kind, coins: purchase ? purchase.coins : undefined });
  if (record.provider !== 'FLUTTERWAVE' && record.provider !== 'PAYSTACK') return res.json({ status: record.status, kind });
  const result = await payments.verifyAndSettle(reference, record.provider);
  const fresh = payment ? await prisma.payment.findUnique({ where: { id: record.id } }) : await prisma.coinPurchase.findUnique({ where: { id: record.id } });
  res.json({ status: fresh.status, kind, coins: purchase ? purchase.coins : undefined, ...(result.ok ? {} : { note: result.reason }) });
});

// Flutterwave tells us a charge completed. Public route, authenticated by the verif-hash header
// (server.js keeps the raw body available).
router.post('/webhook/flutterwave', async (req, res) => {
  if (!flutterwave.verifyWebhookSignature(req.headers['verif-hash'])) return res.status(401).end();
  const event = req.body || {};
  const reference = event.data && (event.data.tx_ref || event.data.reference);
  if (reference && event.event === 'charge.completed' && event.data.status === 'successful') {
    const paidKobo = typeof event.data.amount === 'number' ? Math.round(event.data.amount * 100) : null;
    await payments.settle(reference, paidKobo);
  }
  res.status(200).end();
});

// Paystack tells us a charge succeeded. Public route, authenticated by the HMAC signature of the raw
// body (server.js keeps it in req.rawBody).
router.post('/webhook/paystack', async (req, res) => {
  if (!paystack.verifyWebhookSignature(req.rawBody, req.headers['x-paystack-signature'])) return res.status(401).end();
  const event = req.body || {};
  if (event.event === 'charge.success' && event.data && event.data.reference) {
    const paidKobo = typeof event.data.amount === 'number' ? event.data.amount : null;
    await payments.settle(event.data.reference, paidKobo);
  }
  res.status(200).end();
});

module.exports = router;
