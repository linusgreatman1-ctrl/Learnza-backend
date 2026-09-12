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

module.exports = { notify, notifyMany };
