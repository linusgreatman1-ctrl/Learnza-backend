const prisma = require('../db');
const { getPlan } = require('../config/plans');
const coins = require('./coins.service');
const flutterwave = require('./flutterwave.service');
const paystack = require('./paystack.service');
const { notify } = require('./notification.service');

// Everything that turns "a payment exists" into "the student has what they paid for". Shared by
// the browser's verify call, Flutterwave's webhook and the admin's manual confirmation, so no
// matter how many of them arrive — or in what order — a payment is only ever honoured once.

// A payment counts only if the provider says at least the price WE set was paid. (When the
// provider gives no amount, as with a manual confirmation, there is nothing to compare.)
const amountCovers = (expectedKobo, paidKobo) => paidKobo == null || Number.isNaN(paidKobo) || paidKobo >= expectedKobo;

async function activateSubscription(payment) {
  const planConfig = getPlan(payment.plan);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + planConfig.days * 24 * 60 * 60 * 1000);
  // Every activation resets the AI minutes to a full allotment for the new cycle.
  const aiSecondsGranted = planConfig.aiMinutes * 60;
  const subscription = await prisma.subscription.upsert({
    where: { userId: payment.userId },
    create: { userId: payment.userId, plan: payment.plan, status: 'ACTIVE', startedAt: now, expiresAt, aiSecondsGranted, aiSecondsUsed: 0 },
    update: { plan: payment.plan, status: 'ACTIVE', startedAt: now, expiresAt, aiSecondsGranted, aiSecondsUsed: 0 },
  });
  await prisma.payment.update({ where: { id: payment.id }, data: { subscriptionId: subscription.id } });
  await notify(payment.userId, 'Payment confirmed', `Your ${planConfig.label.toLowerCase()} subscription is now active.`, 'billing');
}

// Settles a subscription payment or a coin purchase by its reference. `paidKobo` is what the
// provider reports (null for a manual confirmation).
async function settle(reference, paidKobo) {
  const payment = await prisma.payment.findUnique({ where: { reference } });
  if (payment) {
    if (payment.status === 'SUCCESS') return { ok: true, kind: 'plan', already: true };
    if (!amountCovers(payment.amountKobo, paidKobo)) return { ok: false, reason: 'amount_mismatch' };
    // Only one caller can move PENDING/FAILED -> SUCCESS.
    const flipped = await prisma.payment.updateMany({ where: { id: payment.id, status: { not: 'SUCCESS' } }, data: { status: 'SUCCESS' } });
    if (flipped.count === 1) await activateSubscription(payment);
    return { ok: true, kind: 'plan' };
  }
  const purchase = await prisma.coinPurchase.findUnique({ where: { reference } });
  if (purchase) {
    if (purchase.status === 'SUCCESS') return { ok: true, kind: 'coins', already: true, coins: purchase.coins };
    if (!amountCovers(purchase.amountKobo, paidKobo)) return { ok: false, reason: 'amount_mismatch' };
    const credited = await coins.completePurchase(purchase);
    if (credited) await notify(purchase.userId, 'Coins added', `${purchase.coins} coins (${purchase.coins} minutes of live AI Teacher) were added to your wallet.`, 'wallet');
    return { ok: true, kind: 'coins', coins: purchase.coins };
  }
  return { ok: false, reason: 'not_found' };
}

// Asks the provider that took the payment (Flutterwave or Paystack) about `reference` and settles
// it if it was paid.
async function verifyAndSettle(reference, provider = 'FLUTTERWAVE') {
  const verified = provider === 'PAYSTACK' ? await paystack.verifyByReference(reference) : await flutterwave.verifyByReference(reference);
  if (!verified.ok) return { ok: false, reason: verified.reason || 'not_paid' };
  return settle(reference, verified.amountKobo);
}

module.exports = { settle, verifyAndSettle, activateSubscription, amountCovers };
