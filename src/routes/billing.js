const express = require('express');
const prisma = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { getSubscriptionStatus } = require('../subscription');
const { getPlan } = require('../config/plans');
const paystack = require('../services/paystack.service');
const flutterwave = require('../services/flutterwave.service');

const router = express.Router();

router.get('/status', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const status = await getSubscriptionStatus(req.user.id);
  res.json(status);
});

router.get('/providers', requireAuth, (req, res) => {
  res.json({ paystack: paystack.isConfigured(), flutterwave: flutterwave.isConfigured() });
});

router.post('/checkout', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const { plan, provider } = req.body;
  let planConfig;
  try {
    planConfig = getPlan(plan);
  } catch {
    return res.status(400).json({ error: 'Invalid plan. Choose MONTHLY or YEARLY.' });
  }
  if (!['paystack', 'flutterwave'].includes(provider)) {
    return res.status(400).json({ error: 'Invalid payment provider.' });
  }

  const reference = `learnza_${req.user.id}_${Date.now()}`;
  const origin = req.headers.origin || `${req.protocol}://${req.get('host')}`;

  try {
    const payment = await prisma.payment.create({
      data: {
        userId: req.user.id,
        provider: provider.toUpperCase(),
        reference,
        plan,
        amountKobo: planConfig.amountKobo,
        status: 'PENDING',
      },
    });

    if (provider === 'paystack') {
      const data = await paystack.initializeTransaction({
        email: req.user.email,
        amountKobo: planConfig.amountKobo,
        reference,
        callbackUrl: `${origin}/app.html#billing-callback`,
        metadata: { userId: req.user.id, plan },
      });
      return res.json({ checkoutUrl: data.authorization_url, reference: payment.reference });
    }

    const data = await flutterwave.initializePayment({
      email: req.user.email,
      amountNaira: planConfig.amountNaira,
      reference,
      redirectUrl: `${origin}/app.html#billing-callback`,
      meta: { userId: req.user.id, plan },
    });
    return res.json({ checkoutUrl: data.link, reference: payment.reference });
  } catch (err) {
    return res.status(503).json({ error: err.message });
  }
});

// Fallback verification the frontend can call right after redirect, in case the
// async webhook hasn't landed yet.
router.get('/verify/:reference', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const payment = await prisma.payment.findUnique({ where: { reference: req.params.reference } });
  if (!payment || payment.userId !== req.user.id) return res.status(404).json({ error: 'Payment not found' });
  if (payment.status === 'SUCCESS') return res.json({ status: 'SUCCESS' });

  try {
    if (payment.provider === 'PAYSTACK') {
      const data = await paystack.verifyTransaction(payment.reference);
      if (data.status === 'success') await activateSubscription(payment);
    } else {
      const data = await flutterwave.verifyTransaction(req.query.transactionId || payment.reference);
      if (data.status === 'successful') await activateSubscription(payment);
    }
    const fresh = await prisma.payment.findUnique({ where: { id: payment.id } });
    res.json({ status: fresh.status });
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

async function activateSubscription(payment) {
  if (payment.status === 'SUCCESS') return;
  const planConfig = getPlan(payment.plan);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + planConfig.days * 24 * 60 * 60 * 1000);

  const subscription = await prisma.subscription.upsert({
    where: { userId: payment.userId },
    create: { userId: payment.userId, plan: payment.plan, status: 'ACTIVE', startedAt: now, expiresAt },
    update: { plan: payment.plan, status: 'ACTIVE', startedAt: now, expiresAt },
  });
  await prisma.payment.update({
    where: { id: payment.id },
    data: { status: 'SUCCESS', subscriptionId: subscription.id },
  });
}

// Webhooks are public (called by the payment provider, not a logged-in user) and are
// authenticated by signature instead of a session token. server.js captures req.rawBody
// for signature verification.
router.post('/webhook/paystack', async (req, res) => {
  const signature = req.headers['x-paystack-signature'];
  if (!paystack.verifyWebhookSignature(req.rawBody, signature)) return res.status(401).end();

  const event = req.body;
  if (event.event === 'charge.success') {
    const payment = await prisma.payment.findUnique({ where: { reference: event.data.reference } });
    if (payment) await activateSubscription(payment);
  }
  res.status(200).end();
});

router.post('/webhook/flutterwave', async (req, res) => {
  const signature = req.headers['verif-hash'];
  if (!flutterwave.verifyWebhookSignature(signature)) return res.status(401).end();

  const event = req.body;
  if (event.event === 'charge.completed' && event.data?.status === 'successful') {
    const payment = await prisma.payment.findUnique({ where: { reference: event.data.tx_ref } });
    if (payment) await activateSubscription(payment);
  }
  res.status(200).end();
});

module.exports = router;
