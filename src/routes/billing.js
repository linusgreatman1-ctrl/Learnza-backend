const express = require('express');
const crypto = require('crypto');
const prisma = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { getSubscriptionStatus, isEnforced } = require('../subscription');
const { PLANS, getPlan } = require('../config/plans');
const { bank, flutterwavePublicKey } = require('../config/payments');
const flutterwave = require('../services/flutterwave.service');
const payments = require('../services/payments.service');
const coins = require('../services/coins.service');

// Subscriptions, structured like PassNow's: the browser opens Flutterwave's checkout popup (card,
// bank transfer, USSD, mobile money) with the PUBLIC key; the server fixes the price, verifies
// the result with the SECRET key and confirms again from Flutterwave's webhook. Anyone who would
// rather pay by plain bank transfer or USSD files a manual request that an admin confirms.
const router = express.Router();

const INTERNAL = /@internal\.learnza\.local$/;
// Flutterwave needs a deliverable email address for the receipt; accounts created without one
// carry a placeholder that is not.
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
    bank: { bankName, accountName, accountNumber },
    ussdTemplate: '*966*{amount}*' + accountNumber + '#',
    plans: Object.entries(PLANS).map(([id, p]) => ({ id, label: p.label, amountNaira: p.amountNaira, days: p.days, aiMinutes: p.aiMinutes })),
    packs: coins.PACKS,
  });
});

// Starts a card/bank/USSD payment: records a PENDING payment at the server's price and hands the
// browser the reference to open Flutterwave's popup with.
router.post('/initiate', requireAuth, requireRole('STUDENT'), async (req, res) => {
  let plan;
  try { plan = getPlan(req.body.plan); } catch { return res.status(400).json({ error: 'Choose a monthly or yearly plan.' }); }
  const reference = `LZ-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
  await prisma.payment.create({
    data: { userId: req.user.id, provider: 'FLUTTERWAVE', reference, plan: req.body.plan, amountKobo: plan.amountKobo, status: 'PENDING' },
  });
  res.status(201).json({ reference, amount: plan.amountNaira, amountKobo: plan.amountKobo, email: payerEmail(req.user), name: req.user.fullName, label: plan.label });
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
  if (record.provider !== 'FLUTTERWAVE') return res.json({ status: record.status, kind });
  const result = await payments.verifyAndSettle(reference);
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

module.exports = router;
