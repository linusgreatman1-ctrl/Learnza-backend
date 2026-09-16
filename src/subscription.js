const prisma = require('./db');

// Testing-phase switch: while the platform is still being tested, nothing should be
// paywalled. Set REQUIRE_SUBSCRIPTION=true (as a Render env var) to flip enforcement
// back on once ready for real launch -- no code change needed, just that one var.
function isEnforced() {
  return process.env.REQUIRE_SUBSCRIPTION === 'true';
}

async function getSubscriptionStatus(userId) {
  const sub = await prisma.subscription.findUnique({ where: { userId } });
  if (!sub) return { active: false, subscription: null };
  const active = sub.status === 'ACTIVE' && sub.expiresAt && sub.expiresAt > new Date();
  return { active, subscription: sub };
}

// Students need an active plan for AI Teaching (interactive AI lessons + Simli avatar),
// recorded video lectures, live classes and the research assistant -- unless
// enforcement is off (see isEnforced above). Lecturers/admins always pass -- they're
// authoring, not consuming.
async function requireActiveSubscription(req, res, next) {
  if (!isEnforced()) return next();
  if (req.user.role !== 'STUDENT') return next();
  const { active } = await getSubscriptionStatus(req.user.id);
  if (!active) {
    return res.status(402).json({
      error: 'This requires an active Learnza subscription (₦10,000/month or ₦105,000/year).',
      code: 'SUBSCRIPTION_REQUIRED',
    });
  }
  next();
}

// Live AI Teacher (avatar/voice) usage draws down a per-cycle credit bank, separate
// from the plain time-based active/expired check above -- so a student can be
// time-active but still have run out of AI minutes for this cycle, and vice versa
// while credits are simply untracked (no subscription row yet, e.g. during testing).
async function getAiCreditStatus(userId) {
  const sub = await prisma.subscription.findUnique({ where: { userId } });
  if (!sub) return { tracked: false, secondsGranted: 0, secondsUsed: 0, secondsRemaining: Infinity, exhausted: false };
  const secondsRemaining = Math.max(0, sub.aiSecondsGranted - sub.aiSecondsUsed);
  return { tracked: true, secondsGranted: sub.aiSecondsGranted, secondsUsed: sub.aiSecondsUsed, secondsRemaining, exhausted: secondsRemaining <= 0 };
}

async function requireAiCredits(req, res, next) {
  if (!isEnforced()) return next();
  if (req.user.role !== 'STUDENT') return next();
  const { tracked, exhausted } = await getAiCreditStatus(req.user.id);
  if (tracked && exhausted) {
    return res.status(402).json({
      error: "You've used up this cycle's live AI Teacher minutes. Subscribe again to top up your credit.",
      code: 'AI_CREDITS_EXHAUSTED',
    });
  }
  next();
}

// Called after AI-generated speech is actually produced, so credit usage tracks real
// audio duration rather than request count -- a 5-second answer costs less than a
// 2-minute lesson section. No-ops when there's no subscription row to track against.
async function recordAiUsage(userId, seconds) {
  if (!seconds || seconds <= 0) return;
  try {
    await prisma.subscription.update({
      where: { userId },
      data: { aiSecondsUsed: { increment: Math.round(seconds) } },
    });
  } catch {
    // No subscription row (free/testing user) -- nothing to track against.
  }
}

module.exports = { getSubscriptionStatus, requireActiveSubscription, isEnforced, getAiCreditStatus, requireAiCredits, recordAiUsage };
