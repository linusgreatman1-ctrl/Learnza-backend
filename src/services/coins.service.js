const prisma = require('../db');

// Coins are a pay-as-you-go top-up for live AI Lecturer time. A subscription already includes
// AI minutes each billing cycle (src/subscription.js); once those are used up, coins keep the
// avatar going. 1 coin = 1 minute (as in PassNow). The wallet holds whole coins plus the unspent
// remainder of the coin currently being used, so a 30-second answer costs 30 seconds, not a coin.
const SECONDS_PER_COIN = 60;

const PACKS = [
  { id: 'COINS_30', coins: 30, amountKobo: 250000, label: '30 minutes', minutes: 30, blurb: '30 minutes of live AI teaching' },
  { id: 'COINS_60', coins: 60, amountKobo: 480000, label: '60 minutes', minutes: 60, blurb: '60 minutes of live AI teaching' },
  { id: 'COINS_90', coins: 90, amountKobo: 700000, label: '90 minutes', minutes: 90, blurb: '90 minutes of live AI teaching' },
  { id: 'COINS_120', coins: 120, amountKobo: 900000, label: '120 minutes', minutes: 120, blurb: '120 minutes — best value' },
];

function getPack(id) {
  return PACKS.find((p) => p.id === id) || null;
}

async function getWallet(userId, db = prisma) {
  return db.coinWallet.upsert({ where: { userId }, create: { userId }, update: {} });
}

function walletSeconds(wallet) {
  return wallet.balance * SECONDS_PER_COIN + wallet.aiSecondsCredit;
}

// Adds coins and records it in the append-only ledger, atomically.
async function credit(userId, coins, reason, { note = null, reference = null } = {}) {
  if (!Number.isInteger(coins) || coins <= 0) throw new Error('coins must be a positive whole number');
  return prisma.$transaction(async (tx) => {
    await getWallet(userId, tx);
    const wallet = await tx.coinWallet.update({ where: { userId }, data: { balance: { increment: coins } } });
    await tx.coinLedger.create({ data: { userId, delta: coins, balanceAfter: wallet.balance, reason, note, reference } });
    return wallet;
  });
}

// Spends up to `seconds` of AI time from the wallet. Returns how many seconds were actually
// covered (less than asked when the wallet runs dry -- the caller decides what that means).
async function spendSeconds(userId, seconds) {
  let need = Math.max(0, Math.round(seconds));
  if (!need) return 0;
  return prisma.$transaction(async (tx) => {
    const wallet = await getWallet(userId, tx);
    let { balance, aiSecondsCredit } = wallet;
    let covered = 0;
    let coinsUsed = 0;
    while (need > 0) {
      if (aiSecondsCredit === 0) {
        if (balance === 0) break;
        balance -= 1;
        coinsUsed += 1;
        aiSecondsCredit = SECONDS_PER_COIN;
      }
      const take = Math.min(need, aiSecondsCredit);
      aiSecondsCredit -= take;
      need -= take;
      covered += take;
    }
    if (covered > 0) {
      await tx.coinWallet.update({ where: { userId }, data: { balance, aiSecondsCredit } });
      if (coinsUsed > 0) {
        await tx.coinLedger.create({
          data: { userId, delta: -coinsUsed, balanceAfter: balance, reason: 'AI_USAGE', note: `${Math.round(covered / 60)} min of live AI Lecturer` },
        });
      }
    }
    return covered;
  });
}

// Marks a pending purchase paid and credits the coins -- exactly once, however many times
// the webhook and the redirect-verification both arrive.
async function completePurchase(purchase) {
  const claimed = await prisma.coinPurchase.updateMany({ where: { id: purchase.id, status: 'PENDING' }, data: { status: 'SUCCESS' } });
  if (claimed.count === 0) return false;
  await credit(purchase.userId, purchase.coins, 'PURCHASE', { note: `${purchase.coins} coin pack`, reference: purchase.reference });
  return true;
}

module.exports = { PACKS, SECONDS_PER_COIN, getPack, getWallet, walletSeconds, credit, spendSeconds, completePurchase };
