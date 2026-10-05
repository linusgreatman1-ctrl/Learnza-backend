const express = require('express');
const prisma = require('../db');
const { logAction } = require('../audit');
const { getPlan, PLANS } = require('../config/plans');
const { notifyMany } = require('../services/notification.service');
const bulkMessage = require('../services/bulkMessage.service');
const { memoryUpload, saveUpload } = require('../services/fileUpload.service');
const settings = require('../settings');
const payments = require('../services/payments.service');

// The rest of the platform owner's API (mounted inside routes/super.js, so every route here
// is already behind "signed in as SUPER_ADMIN"): announcements, payments & subscriptions,
// AI activity, live classes, gamification, the platform e-Library, and Settings.
const router = express.Router();
const upload = memoryUpload(25);

const INTERNAL = /@internal\.learnza\.local$/;
const pageOf = (req, size = 50) => ({ page: Math.max(1, parseInt(req.query.page, 10) || 1), size });

// ---------------------------------------------------------------- announcements
const AUDIENCES = ['ALL', 'INDEPENDENT', 'SCHOOLS', 'SCHOOL'];

function audienceWhere(audience, schoolId) {
  const base = { status: 'ACTIVE', role: { not: 'SUPER_ADMIN' } };
  if (audience === 'INDEPENDENT') return { ...base, isIndividual: true };
  if (audience === 'SCHOOLS') return { ...base, schoolId: { not: null } };
  if (audience === 'SCHOOL') return { ...base, schoolId };
  return base;
}

router.get('/announcements', async (req, res) => {
  const { page, size } = pageOf(req, 30);
  const [total, announcements] = await Promise.all([
    prisma.announcement.count(),
    prisma.announcement.findMany({ orderBy: { createdAt: 'desc' }, skip: (page - 1) * size, take: size }),
  ]);
  const schoolIds = [...new Set(announcements.map((a) => a.schoolId).filter(Boolean))];
  const schools = schoolIds.length ? await prisma.school.findMany({ where: { id: { in: schoolIds } }, select: { id: true, name: true } }) : [];
  const names = new Map(schools.map((s) => [s.id, s.name]));
  res.json({
    total, page, pageSize: size,
    announcements: announcements.map((a) => ({ ...a, schoolName: a.schoolId ? names.get(a.schoolId) || null : null })),
    channelsAvailable: { email: bulkMessage.emailConfigured(), sms: bulkMessage.smsConfigured() },
  });
});

router.post('/announcements', async (req, res) => {
  const title = String(req.body.title || '').trim();
  const body = String(req.body.body || '').trim();
  const audience = String(req.body.audience || 'ALL');
  const channels = Array.isArray(req.body.channels) ? req.body.channels.filter((c) => ['EMAIL', 'SMS'].includes(c)) : [];
  if (!title || !body) return res.status(400).json({ error: 'Add a title and a message.' });
  if (title.length > 120 || body.length > 2000) return res.status(400).json({ error: 'Keep the title under 120 and the message under 2000 characters.' });
  if (!AUDIENCES.includes(audience)) return res.status(400).json({ error: 'Pick who this is for.' });
  let schoolId = null;
  if (audience === 'SCHOOL') {
    schoolId = String(req.body.schoolId || '');
    if (!schoolId || !(await prisma.school.findUnique({ where: { id: schoolId } }))) return res.status(400).json({ error: 'Pick a school.' });
  }
  if (channels.includes('EMAIL') && !bulkMessage.emailConfigured()) return res.status(400).json({ error: 'Email is not set up on the server yet (SMTP_HOST / SMTP_USER / SMTP_PASS).' });
  if (channels.includes('SMS') && !bulkMessage.smsConfigured()) return res.status(400).json({ error: 'SMS is not set up on the server yet (TERMII_API_KEY / TERMII_SENDER_ID).' });

  const recipients = await prisma.user.findMany({
    where: audienceWhere(audience, schoolId),
    select: { id: true, email: true, phone: true },
  });
  const announcement = await prisma.announcement.create({
    data: { title, body, audience, schoolId, channels: ['IN_APP', ...channels].join(','), recipientCount: recipients.length, sentById: req.user.id },
  });
  await logAction(req, 'ANNOUNCEMENT_SENT', 'Announcement', announcement.id, { title, audience, channels, recipients: recipients.length });
  res.json({ announcement });

  // The in-app notification, then email/SMS, all after the response so a big audience never
  // makes the owner wait. Failures are per recipient and only counted, never fatal.
  (async () => {
    const ids = recipients.map((r) => r.id);
    for (let i = 0; i < ids.length; i += 100) await notifyMany(ids.slice(i, i + 100), title, body, null);
    let emailSent = 0;
    let smsSent = 0;
    if (channels.includes('EMAIL')) {
      for (const r of recipients) {
        if (!r.email || INTERNAL.test(r.email)) continue;
        try { await bulkMessage.sendEmail(r.email, title, body); emailSent++; } catch { /* counted by omission */ }
      }
    }
    if (channels.includes('SMS')) {
      for (const r of recipients) {
        if (!r.phone) continue;
        try { await bulkMessage.sendSms(r.phone, `${title}: ${body}`.slice(0, 450)); smsSent++; } catch { /* counted by omission */ }
      }
    }
    await prisma.announcement.update({ where: { id: announcement.id }, data: { emailSent, smsSent } });
  })().catch((e) => console.error('Announcement delivery failed:', e.message));
});

// ---------------------------------------------------------------- payments & subscriptions
router.get('/payments', async (req, res) => {
  const { page, size } = pageOf(req);
  const where = {};
  if (['PENDING', 'SUCCESS', 'FAILED'].includes(req.query.status)) where.status = req.query.status;
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const [total, payments, allTime, thisMonth, pending, failed] = await Promise.all([
    prisma.payment.count({ where }),
    prisma.payment.findMany({
      where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * size, take: size,
      include: { user: { select: { fullName: true, email: true, school: { select: { name: true } } } } },
    }),
    prisma.payment.aggregate({ where: { status: 'SUCCESS' }, _sum: { amountKobo: true }, _count: true }),
    prisma.payment.aggregate({ where: { status: 'SUCCESS', createdAt: { gte: monthStart } }, _sum: { amountKobo: true }, _count: true }),
    prisma.payment.count({ where: { status: 'PENDING' } }),
    prisma.payment.count({ where: { status: 'FAILED' } }),
  ]);
  res.json({
    total, page, pageSize: size, payments,
    summary: {
      revenueKobo: allTime._sum.amountKobo || 0, paid: allTime._count,
      monthKobo: thisMonth._sum.amountKobo || 0, monthPaid: thisMonth._count,
      pending, failed,
    },
  });
});

// A bank-transfer / USSD payment a student reported: the admin saw the money, so confirm it and
// the subscription starts. (Idempotent — confirming twice does nothing the second time.)
router.post('/payments/:id/confirm', async (req, res) => {
  const payment = await prisma.payment.findUnique({ where: { id: req.params.id } });
  if (!payment) return res.status(404).json({ error: 'Payment not found' });
  if (payment.provider !== 'MANUAL_TRANSFER') return res.status(400).json({ error: 'Only bank-transfer payments are confirmed by hand. Card payments confirm themselves.' });
  const result = await payments.settle(payment.reference, null);
  await logAction(req, 'PAYMENT_CONFIRMED', 'Payment', payment.id, { reference: payment.reference, amountKobo: payment.amountKobo });
  res.json({ ok: result.ok });
});

router.post('/payments/:id/reject', async (req, res) => {
  const payment = await prisma.payment.findUnique({ where: { id: req.params.id } });
  if (!payment) return res.status(404).json({ error: 'Payment not found' });
  if (payment.provider !== 'MANUAL_TRANSFER' || payment.status !== 'PENDING') return res.status(400).json({ error: 'Only a pending bank-transfer payment can be rejected.' });
  await prisma.payment.update({ where: { id: payment.id }, data: { status: 'FAILED' } });
  await logAction(req, 'PAYMENT_REJECTED', 'Payment', payment.id, { reference: payment.reference });
  res.json({ ok: true });
});

router.get('/subscriptions', async (req, res) => {
  const { page, size } = pageOf(req);
  const now = new Date();
  const where = {};
  if (req.query.state === 'active') Object.assign(where, { status: 'ACTIVE', expiresAt: { gt: now } });
  if (req.query.state === 'expired') Object.assign(where, { OR: [{ status: { not: 'ACTIVE' } }, { expiresAt: { lte: now } }] });
  const [total, active, subs] = await Promise.all([
    prisma.subscription.count({ where }),
    prisma.subscription.count({ where: { status: 'ACTIVE', expiresAt: { gt: now } } }),
    prisma.subscription.findMany({
      where, orderBy: { updatedAt: 'desc' }, skip: (page - 1) * size, take: size,
      include: { user: { select: { id: true, fullName: true, email: true, school: { select: { name: true } } } } },
    }),
  ]);
  res.json({
    total, page, pageSize: size, activeCount: active, plans: PLANS,
    subscriptions: subs.map((s) => ({ ...s, active: s.status === 'ACTIVE' && !!s.expiresAt && s.expiresAt > now })),
  });
});

// A manual grant: for an offline payment, a scholarship, or making good on a problem.
router.post('/subscriptions/grant', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.role !== 'STUDENT') return res.status(404).json({ error: 'No student has that email address.' });
  let plan;
  try { plan = getPlan(req.body.plan); } catch { return res.status(400).json({ error: 'Choose MONTHLY or YEARLY.' }); }
  const days = req.body.days ? Math.min(3650, Math.max(1, parseInt(req.body.days, 10) || plan.days)) : plan.days;
  const now = new Date();
  const base = { plan: req.body.plan, status: 'ACTIVE', startedAt: now, expiresAt: new Date(now.getTime() + days * 86400000), aiSecondsGranted: plan.aiMinutes * 60, aiSecondsUsed: 0 };
  const subscription = await prisma.subscription.upsert({ where: { userId: user.id }, create: { userId: user.id, ...base }, update: base });
  await logAction(req, 'SUBSCRIPTION_GRANTED', 'User', user.id, { email, plan: req.body.plan, days });
  res.json({ subscription });
});

router.post('/subscriptions/:userId/revoke', async (req, res) => {
  const sub = await prisma.subscription.findUnique({ where: { userId: req.params.userId } });
  if (!sub) return res.status(404).json({ error: 'No subscription found.' });
  const updated = await prisma.subscription.update({ where: { id: sub.id }, data: { status: 'CANCELLED', expiresAt: new Date() } });
  await logAction(req, 'SUBSCRIPTION_REVOKED', 'User', sub.userId);
  res.json({ subscription: updated });
});

// ---------------------------------------------------------------- AI activity
router.get('/ai-logs', async (req, res) => {
  const { page, size } = pageOf(req);
  const where = {};
  if (['RESEARCH', 'LAB'].includes(req.query.kind)) where.kind = req.query.kind;
  const search = String(req.query.search || '').trim();
  if (search) where.OR = [{ question: { contains: search, mode: 'insensitive' } }, { answer: { contains: search, mode: 'insensitive' } }, { user: { fullName: { contains: search, mode: 'insensitive' } } }];
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const [total, today, logs] = await Promise.all([
    prisma.aiConversationLog.count({ where }),
    prisma.aiConversationLog.count({ where: { createdAt: { gte: startOfDay } } }),
    prisma.aiConversationLog.findMany({
      where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * size, take: size,
      include: { user: { select: { fullName: true, role: true, school: { select: { name: true } } } } },
    }),
  ]);
  res.json({ total, today, page, pageSize: size, logs });
});

router.get('/ai-sessions', async (req, res) => {
  const { page, size } = pageOf(req);
  const [total, active, sessions] = await Promise.all([
    prisma.aiTeacherSession.count(),
    prisma.aiTeacherSession.count({ where: { status: 'ACTIVE' } }),
    prisma.aiTeacherSession.findMany({
      orderBy: { createdAt: 'desc' }, skip: (page - 1) * size, take: size,
      include: {
        student: { select: { fullName: true, school: { select: { name: true } } } },
        course: { select: { code: true, title: true } },
        individualCourse: { select: { title: true } },
        _count: { select: { turns: true } },
      },
    }),
  ]);
  res.json({ total, active, page, pageSize: size, sessions });
});

// ---------------------------------------------------------------- live classes
router.get('/live-classes', async (req, res) => {
  const { page, size } = pageOf(req);
  const [total, liveNow, withRecording, classes] = await Promise.all([
    prisma.liveClass.count(),
    prisma.liveClass.count({ where: { status: 'ACTIVE' } }),
    prisma.liveClass.count({ where: { recordingUrl: { not: null } } }),
    prisma.liveClass.findMany({
      orderBy: { startedAt: 'desc' }, skip: (page - 1) * size, take: size,
      include: {
        host: { select: { fullName: true } },
        course: { select: { code: true, title: true, department: { select: { school: { select: { name: true } } } } } },
      },
    }),
  ]);
  res.json({
    total, liveNow, withRecording, page, pageSize: size,
    classes: classes.map(({ course, ...c }) => ({
      ...c,
      courseCode: course.code, courseTitle: course.title,
      schoolName: course.department.school ? course.department.school.name : null,
    })),
  });
});

// ---------------------------------------------------------------- gamification
router.get('/gamification', async (req, res) => {
  const [players, totals, badges, recent, streaks] = await Promise.all([
    prisma.userStats.count(),
    prisma.userStats.aggregate({ _sum: { points: true }, _max: { longestStreak: true } }),
    prisma.badge.findMany({ include: { _count: { select: { users: true } } }, orderBy: { name: 'asc' } }),
    prisma.userBadge.findMany({
      orderBy: { earnedAt: 'desc' }, take: 15,
      include: { badge: { select: { name: true, icon: true } }, user: { select: { fullName: true, school: { select: { name: true } } } } },
    }),
    prisma.userStats.findMany({
      where: { currentStreak: { gt: 0 } }, orderBy: { currentStreak: 'desc' }, take: 10,
      include: { user: { select: { fullName: true, school: { select: { name: true } } } } },
    }),
  ]);
  res.json({
    players, totalPoints: totals._sum.points || 0, longestStreak: totals._max.longestStreak || 0,
    badges: badges.map((b) => ({ id: b.id, code: b.code, name: b.name, description: b.description, icon: b.icon, earned: b._count.users })),
    recent, streaks,
  });
});

// ---------------------------------------------------------------- platform e-Library
// Resources with no school (schoolId null) are the platform's own catalogue: every student
// and every school sees them. Schools' own uploads are listed here too, for oversight.
router.get('/library', async (req, res) => {
  const { page, size } = pageOf(req);
  const where = req.query.scope === 'platform' ? { schoolId: null } : {};
  const search = String(req.query.search || '').trim();
  if (search) where.OR = [{ title: { contains: search, mode: 'insensitive' } }, { author: { contains: search, mode: 'insensitive' } }];
  const [total, items] = await Promise.all([
    prisma.libraryResource.count({ where }),
    prisma.libraryResource.findMany({
      where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * size, take: size,
      include: { school: { select: { name: true } }, uploader: { select: { fullName: true } } },
    }),
  ]);
  res.json({ total, page, pageSize: size, items });
});

router.post('/library', upload.single('file'), async (req, res) => {
  const { title, author, publisher, type } = req.body;
  if (!title || !author || !type) return res.status(400).json({ error: 'Title, author and type are required.' });
  if (!req.file) return res.status(400).json({ error: 'Attach the file from your computer.' });
  let saved;
  try { saved = await saveUpload(req.file); } catch { return res.status(502).json({ error: 'Upload failed. Please try again.' }); }
  const item = await prisma.libraryResource.create({
    data: { title: String(title).trim(), author: String(author).trim(), publisher: publisher ? String(publisher).trim() : null, type, fileUrl: saved.url, uploaderId: req.user.id, schoolId: null },
  });
  await logAction(req, 'LIBRARY_RESOURCE_ADDED', 'LibraryResource', item.id, { title: item.title });
  res.json({ item, storage: saved.storage });
});

router.delete('/library/:id', async (req, res) => {
  const item = await prisma.libraryResource.findUnique({ where: { id: req.params.id } });
  if (!item) return res.status(404).json({ error: 'Resource not found' });
  await prisma.libraryResource.delete({ where: { id: item.id } });
  await logAction(req, 'LIBRARY_RESOURCE_REMOVED', 'LibraryResource', item.id, { title: item.title, schoolId: item.schoolId });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- settings
router.get('/settings', (req, res) => res.json({ settings: settings.all() }));

router.put('/settings', async (req, res) => {
  const incoming = req.body.settings && typeof req.body.settings === 'object' ? req.body.settings : {};
  const changed = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (!settings.DEFINITIONS[key]) continue;
    const before = settings.get(key);
    const after = await settings.set(key, value);
    if (before !== after) changed[key] = { from: before, to: after };
  }
  if (Object.keys(changed).length) await logAction(req, 'SETTINGS_CHANGED', 'AppSetting', null, changed);
  res.json({ settings: settings.all() });
});

module.exports = router;
