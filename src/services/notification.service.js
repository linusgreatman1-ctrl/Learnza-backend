const prisma = require('../db');

async function notify(userId, title, body, link) {
  await prisma.notification.create({ data: { userId, title, body, link: link || null } });
}

async function notifyMany(userIds, title, body, link) {
  if (!userIds.length) return;
  await prisma.notification.createMany({
    data: userIds.map((userId) => ({ userId, title, body, link: link || null })),
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
