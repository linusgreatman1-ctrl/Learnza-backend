const prisma = require('../db');

// A user who's muted notifications in Settings still exists and can still be notified
// later once unmuted -- this just skips creating the row while muted, checked here
// centrally rather than at every one of the many notify()/notifyMany() call sites.
async function notify(userId, title, body, link) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { notificationsMuted: true } });
  if (user && user.notificationsMuted) return;
  await prisma.notification.create({ data: { userId, title, body, link: link || null } });
}

async function notifyMany(userIds, title, body, link) {
  if (!userIds.length) return;
  const active = await prisma.user.findMany({ where: { id: { in: userIds }, notificationsMuted: false }, select: { id: true } });
  if (!active.length) return;
  await prisma.notification.createMany({
    data: active.map((u) => ({ userId: u.id, title, body, link: link || null })),
  });
}

// Every score a lecturer releases (assignment mark, published formal result) also
// reaches the school admin -- "the school admin receives the scores for each student".
async function notifySchoolAdmins(schoolId, title, body, link) {
  if (!schoolId) return;
  const admins = await prisma.user.findMany({ where: { schoolId, role: 'ADMIN' }, select: { id: true } });
  await notifyMany(admins.map((a) => a.id), title, body, link);
}

module.exports = { notify, notifyMany, notifySchoolAdmins };
