const express = require('express');
const prisma = require('../db');
const { requireAuth, requireRole } = require('../auth');
const coins = require('../services/coins.service');
const paystack = require('../services/paystack.service');
const flutterwave = require('../services/flutterwave.service');

// A student's coin wallet: balance, history, and buying a pack. Payment confirmation shares
// routes/billing.js's verify + webhook endpoints (the reference tells them apart).
const router = express.Router();
router.use(requireAuth, requireRole('STUDENT'));

router.get('/', async (req, res) => {
  const wallet = await coins.getWallet(req.user.id);
  const [ledger, purchases] = await Promise.all([
    prisma.coinLedger.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: 'desc' }, take: 30 }),
    prisma.coinPurchase.findMany({ where: { userId: req.user.id, status: 'PENDING' }, orderBy: { createdAt: 'desc' }, take: 3 }),
  ]);
  res.json({
    balance: wallet.balance,
    minutesLeft: Math.floor(coins.walletSeconds(wallet) / 60),
    packs: coins.PACKS,
    secondsPerCoin: coins.SECONDS_PER_COIN,
    providers: { paystack: paystack.isConfigured(), flutterwave: flutterwave.isConfigured() },
    pending: purchases,
    ledger,
  });
});

router.post('/checkout', async (req, res) => {
  const pack = coins.getPack(req.body.packId);
  const { provider } = req.body;
  if (!pack) return res.status(400).json({ error: 'Choose a coin pack.' });
  if (!['paystack', 'flutterwave'].includes(provider)) return res.status(400).json({ error: 'Invalid payment provider.' });

  const reference = `learnzacoins_${req.user.id}_${Date.now()}`;
  const origin = req.headers.origin || `${req.protocol}://${req.get('host')}`;
  const back = `${origin}${req.user.schoolId ? '/schools' : '/app'}#billing-callback`;
  try {
    const purchase = await prisma.coinPurchase.create({
      data: { userId: req.user.id, coins: pack.coins, amountKobo: pack.amountKobo, provider: provider.toUpperCase(), reference, status: 'PENDING' },
    });
    if (provider === 'paystack') {
      const data = await paystack.initializeTransaction({
        email: req.user.email, amountKobo: pack.amountKobo, reference, callbackUrl: back, metadata: { userId: req.user.id, packId: pack.id },
      });
      return res.json({ checkoutUrl: data.authorization_url, reference: purchase.reference });
    }
    const data = await flutterwave.initializePayment({
      email: req.user.email, amountNaira: pack.amountKobo / 100, reference, redirectUrl: back, meta: { userId: req.user.id, packId: pack.id },
    });
    return res.json({ checkoutUrl: data.link, reference: purchase.reference });
  } catch (err) {
    return res.status(503).json({ error: err.message });
  }
});

module.exports = router;
