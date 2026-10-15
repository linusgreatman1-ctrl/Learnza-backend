// Notifications for the people who run Learnza (the admin panel's bell): a payment request is waiting, money arrived that matches
// nothing, an automatic confirmation happened... They are ordinary Notification rows addressed to every active SUPER_ADMIN.
const prisma = require('../db');
const { notify } = require('./notification.service');

async function notifyAdmins(title, body, link) {
  try {
    const admins = await prisma.user.findMany({ where: { role: 'SUPER_ADMIN', status: 'ACTIVE' }, select: { id: true } });
    for (const a of admins) await notify(a.id, String(title).slice(0, 160), String(body).slice(0, 600), link || null);
    return admins.length;
  } catch (err) {
    console.error('[admin-notify] could not notify the admins:', err && err.message);
    return 0;
  }
}

module.exports = { notifyAdmins };
