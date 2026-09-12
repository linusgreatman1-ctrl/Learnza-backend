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

module.exports = { getSubscriptionStatus, requireActiveSubscription, isEnforced };
