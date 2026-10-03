const prisma = require('./db');
const settings = require('./settings');

// Sits in front of every AI-backed route. Two switches from the admin panel's Settings:
// the master kill switch, and a per-student daily cap on research/lab questions.
function aiGuard(req, res, next) {
  if (!settings.get('aiEnabled')) {
    return res.status(503).json({ error: 'AI features are switched off for now. Please try again later.', code: 'AI_DISABLED' });
  }
  next();
}

// Daily cap, counted from the conversation log (so it only applies to the routes that log).
async function aiDailyLimit(req, res, next) {
  const limit = settings.get('aiQuestionsPerDay');
  if (!limit || req.user.role !== 'STUDENT') return next();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const used = await prisma.aiConversationLog.count({ where: { userId: req.user.id, createdAt: { gte: startOfDay } } });
  if (used >= limit) {
    return res.status(429).json({ error: `You've reached today's limit of ${limit} AI questions. It resets tomorrow.`, code: 'AI_DAILY_LIMIT' });
  }
  next();
}

// Keeps a record of what students asked the AI and what came back, so the platform owner
// can review quality and abuse (the Terms & Privacy page says conversations are kept).
async function logAiConversation(userId, kind, question, answer) {
  try {
    await prisma.aiConversationLog.create({
      data: { userId, kind, question: String(question).slice(0, 4000), answer: String(answer).slice(0, 8000) },
    });
  } catch (e) {
    console.error('Could not log AI conversation:', e.message);
  }
}

module.exports = { aiGuard, aiDailyLimit, logAiConversation };
