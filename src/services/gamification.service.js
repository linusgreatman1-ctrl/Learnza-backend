const prisma = require('../db');

const POINTS_PER_CORRECT_ANSWER = 10;

function isSameDay(a, b) {
  return a.toDateString() === b.toDateString();
}
function isYesterday(a, b) {
  const oneDayMs = 24 * 60 * 60 * 1000;
  return isSameDay(new Date(a.getTime() + oneDayMs), b);
}

// Called after a student submits a CBT/CA assessment. Awards points for correct
// answers, updates their daily streak, and grants any newly-earned badges.
// Deliberately no leaderboard/ranking anywhere in this flow -- progress stays private.
async function recordAssessmentCompletion(userId, score, total) {
  const pointsEarned = score * POINTS_PER_CORRECT_ANSWER;
  const now = new Date();

  let stats = await prisma.userStats.findUnique({ where: { userId } });
  let currentStreak = 1;
  if (stats?.lastActivityDate) {
    if (isSameDay(stats.lastActivityDate, now)) currentStreak = stats.currentStreak;
    else if (isYesterday(stats.lastActivityDate, now)) currentStreak = stats.currentStreak + 1;
  }
  const longestStreak = Math.max(currentStreak, stats?.longestStreak || 0);

  stats = await prisma.userStats.upsert({
    where: { userId },
    create: { userId, points: pointsEarned, currentStreak, longestStreak, lastActivityDate: now },
    update: { points: { increment: pointsEarned }, currentStreak, longestStreak, lastActivityDate: now },
  });

  const newBadges = [];
  const examCount = await prisma.submission.count({ where: { studentId: userId } });
  const percent = total > 0 ? score / total : 0;

  if (examCount === 1) newBadges.push(await awardBadge(userId, 'FIRST_EXAM', 'First Exam', 'Completed your first assessment on Learnza', '🎯'));
  if (currentStreak >= 7) newBadges.push(await awardBadge(userId, 'STREAK_7', '7-Day Streak', 'Studied 7 days in a row', '🔥'));
  if (currentStreak >= 30) newBadges.push(await awardBadge(userId, 'STREAK_30', '30-Day Streak', 'Studied 30 days in a row', '🏆'));
  if (percent >= 0.9) newBadges.push(await awardBadge(userId, 'SHARPSHOOTER', 'Sharpshooter', 'Scored 90% or higher on an assessment', '🎓'));

  return { pointsEarned, stats, newBadges: newBadges.filter(Boolean) };
}

// Returns null if the student already has this badge (so callers can filter silently).
async function awardBadge(userId, code, name, description, icon) {
  const badge = await prisma.badge.upsert({
    where: { code },
    create: { code, name, description, icon },
    update: {},
  });
  const existing = await prisma.userBadge.findUnique({ where: { userId_badgeId: { userId, badgeId: badge.id } } });
  if (existing) return null;
  await prisma.userBadge.create({ data: { userId, badgeId: badge.id } });
  return badge;
}

async function getProgress(userId) {
  const [stats, badges] = await Promise.all([
    prisma.userStats.findUnique({ where: { userId } }),
    prisma.userBadge.findMany({ where: { userId }, include: { badge: true }, orderBy: { earnedAt: 'desc' } }),
  ]);
  return {
    points: stats?.points || 0,
    currentStreak: stats?.currentStreak || 0,
    longestStreak: stats?.longestStreak || 0,
    badges: badges.map((b) => b.badge),
  };
}

module.exports = { recordAssessmentCompletion, getProgress };
