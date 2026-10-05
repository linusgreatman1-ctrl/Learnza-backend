const express = require('express');
const crypto = require('crypto');
const prisma = require('../db');
const { requireAuth, requireRole } = require('../auth');
const coins = require('../services/coins.service');
const paystack = require('../services/paystack.service');

// A student's coin wallet: balance, history, and buying a pack — the same two ways as a
// subscription (Flutterwave popup, or bank transfer / USSD confirmed by an admin). Payment
// confirmation shares routes/billing.js (verify + webhook); the reference tells them apart.
const router = express.Router();
router.use(requireAuth, requireRole('STUDENT'));

const INTERNAL = /@internal\.learnza\.local$/;
// Where Paystack sends the browser back to: the page the purchase started from, on this site only.
function returnUrl(req) {
  const origin = `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}`;
  try {
    const u = new URL(String(req.body.returnUrl || ''), origin);
    if (u.host === req.get('host')) return u.origin + u.pathname;
  } catch { /* fall through */ }
  return origin + '/app';
}
const payerEmail = (u) => (u.email && !INTERNAL.test(u.email) ? u.email : process.env.PAY_FALLBACK_EMAIL || 'payments@learnza.app');

router.get('/', async (req, res) => {
  const wallet = await coins.getWallet(req.user.id);
  const [ledger, pending] = await Promise.all([
    prisma.coinLedger.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: 'desc' }, take: 30 }),
    prisma.coinPurchase.findMany({ where: { userId: req.user.id, status: 'PENDING', provider: 'MANUAL_TRANSFER' }, orderBy: { createdAt: 'desc' }, take: 3 }),
  ]);
  res.json({
    balance: wallet.balance,
    minutesLeft: Math.floor(coins.walletSeconds(wallet) / 60),
    packs: coins.PACKS,
    secondsPerCoin: coins.SECONDS_PER_COIN,
    pending,
    ledger,
  });
});

// Card / bank / USSD through Flutterwave's popup, or Paystack's checkout page: record the purchase
// at the server's price.
router.post('/initiate', async (req, res) => {
  const pack = coins.getPack(req.body.packId);
  if (!pack) return res.status(400).json({ error: 'Choose a coin pack.' });
  const provider = req.body.provider === 'PAYSTACK' ? 'PAYSTACK' : 'FLUTTERWAVE';
  if (provider === 'PAYSTACK' && !paystack.isConfigured()) return res.status(503).json({ error: 'Paystack is not set up yet. Please choose another way to pay.' });
  const reference = `LZ-COIN-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
  let authorizationUrl;
  if (provider === 'PAYSTACK') {
    try {
      const init = await paystack.initializeTransaction({ email: payerEmail(req.user), amountKobo: pack.amountKobo, reference, callbackUrl: returnUrl(req), metadata: { userId: req.user.id, coins: pack.coins } });
      authorizationUrl = init.authorization_url;
    } catch (err) { return res.status(502).json({ error: 'Could not reach Paystack: ' + err.message }); }
  }
  await prisma.coinPurchase.create({
    data: { userId: req.user.id, coins: pack.coins, amountKobo: pack.amountKobo, provider, reference, status: 'PENDING' },
  });
  res.status(201).json({ reference, authorizationUrl, amount: pack.amountKobo / 100, amountKobo: pack.amountKobo, email: payerEmail(req.user), name: req.user.fullName, label: pack.label, coins: pack.coins });
});

// Bank transfer / USSD: recorded PENDING; an admin confirms it and the coins are credited then.
router.post('/manual', async (req, res) => {
  const pack = coins.getPack(req.body.packId);
  if (!pack) return res.status(400).json({ error: 'Choose a coin pack.' });
  const how = req.body.method === 'USSD' ? 'USSD' : 'BANK';
  const reference = `LZ-COIN-MANUAL-${how}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  await prisma.coinPurchase.create({
    data: { userId: req.user.id, coins: pack.coins, amountKobo: pack.amountKobo, provider: 'MANUAL_TRANSFER', reference, status: 'PENDING' },
  });
  res.status(201).json({ reference, coins: pack.coins, message: 'Thanks! We will add your coins as soon as the payment is confirmed (usually within 24 hours).' });
});

module.exports = router;
