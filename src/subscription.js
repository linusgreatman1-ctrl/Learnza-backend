const prisma = require('./db');

async function getSubscriptionStatus(userId) {
  const sub = await prisma.subscription.findUnique({ where: { userId } });
  if (!sub) return { active: false, subscription: null };
  const active = sub.status === 'ACTIVE' && sub.expiresAt && sub.expiresAt > new Date();
  return { active, subscription: sub };
}

// Students need an active plan for AI Teaching (interactive AI lessons + Simli avatar)
// and recorded video lectures. Lecturers/admins always pass -- they're authoring, not consuming.
async function requireActiveSubscription(req, res, next) {
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

module.exports = { getSubscriptionStatus, requireActiveSubscription };
