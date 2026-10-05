const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const prisma = require('../db');
const { requireAuth, requireRole, clearSchoolCache } = require('../auth');
const { issueSession } = require('../session');
const { generateJoinCode } = require('../utils');
const { logAction } = require('../audit');
const { lockedMessage, recordFailure, clearFailures } = require('../lockout');

// The platform owner's API (mounted at /api/super, used by the /admin panel). Entirely
// separate from /api/admin, which is the per-school admin API: a school admin can never
// reach anything here, and the super admin has no school of their own.
const router = express.Router();

const INTERNAL_EMAIL_DOMAIN = 'internal.learnza.local';

function safeUser(u) {
  const { passwordHash, loginAttempts, lockedUntil, ...rest } = u;
  return rest;
}

function licenceState(school) {
  if (school.status !== 'ACTIVE') return 'SUSPENDED';
  if (school.subscriptionExpiresAt && school.subscriptionExpiresAt <= new Date()) return 'EXPIRED';
  return 'ACTIVE';
}

// ---- Sign-in (the only unauthenticated route) ----
router.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const { password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  const user = await prisma.user.findUnique({ where: { email } });
  // Same message for "no such user" and "not a super admin" so this can't be used to
  // discover which emails belong to school accounts.
  if (!user || user.role !== 'SUPER_ADMIN') return res.status(401).json({ error: 'Invalid email or password' });
  const locked = lockedMessage(user);
  if (locked) return res.status(429).json({ error: locked, code: 'ACCOUNT_LOCKED' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    await recordFailure(user);
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  if (user.status !== 'ACTIVE') return res.status(403).json({ error: 'This account is inactive.', code: 'ACCOUNT_INACTIVE' });
  await clearFailures(user);
  req.user = user;
  await logAction(req, 'SUPER_ADMIN_LOGIN', 'User', user.id);
  res.json({ ...(await issueSession(user, 'admin')), user: safeUser(user) });
});

router.use(requireAuth, requireRole('SUPER_ADMIN'));

router.get('/me', (req, res) => res.json({ user: safeUser(req.user) }));

// ---- Dashboard ----
router.get('/dashboard', async (req, res) => {
  const now = new Date();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const [pendingPayments, pendingCoinBuys, openTickets, unreadChats, money, activeSubs, aiToday, liveNow, newToday] = await Promise.all([
    prisma.payment.count({ where: { status: 'PENDING', provider: 'MANUAL_TRANSFER' } }),
    prisma.coinPurchase.count({ where: { status: 'PENDING', provider: 'MANUAL_TRANSFER' } }),
    prisma.supportTicket.count({ where: { status: 'OPEN' } }),
    prisma.chatThread.count({ where: { unreadForAdmin: { gt: 0 } } }),
    prisma.payment.aggregate({ where: { status: 'SUCCESS', createdAt: { gte: monthStart } }, _sum: { amountKobo: true } }),
    prisma.subscription.count({ where: { status: 'ACTIVE', expiresAt: { gt: now } } }),
    prisma.aiConversationLog.count({ where: { createdAt: { gte: startOfDay } } }),
    prisma.liveClass.count({ where: { status: 'ACTIVE' } }),
    prisma.user.count({ where: { createdAt: { gte: startOfDay }, role: { not: 'SUPER_ADMIN' } } }),
  ]);
  const [schools, active, suspended, expired, independent, roleCounts, recentSchools] = await Promise.all([
    prisma.school.count(),
    prisma.school.count({ where: { status: 'ACTIVE', OR: [{ subscriptionExpiresAt: null }, { subscriptionExpiresAt: { gt: now } }] } }),
    prisma.school.count({ where: { status: { not: 'ACTIVE' } } }),
    prisma.school.count({ where: { status: 'ACTIVE', subscriptionExpiresAt: { lte: now } } }),
    prisma.user.count({ where: { isIndividual: true } }),
    prisma.user.groupBy({ by: ['role'], where: { schoolId: { not: null } }, _count: { _all: true } }),
    prisma.school.findMany({ orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, name: true, state: true, createdAt: true } }),
  ]);
  const byRole = Object.fromEntries(roleCounts.map((r) => [r.role, r._count._all]));
  res.json({
    schools: { total: schools, active, suspended, expired },
    schoolUsers: { students: byRole.STUDENT || 0, lecturers: byRole.LECTURER || 0, staff: byRole.STAFF || 0, admins: byRole.ADMIN || 0 },
    independentStudents: independent,
    activity: { pendingManualPayments: pendingPayments + pendingCoinBuys, openTickets, unreadChats, revenueThisMonthKobo: money._sum.amountKobo || 0, activeSubscriptions: activeSubs, aiQuestionsToday: aiToday, liveNow, newUsersToday: newToday },
    recentSchools,
  });
});

// ---- Schools ----
async function schoolRoleCounts() {
  const rows = await prisma.user.groupBy({ by: ['schoolId', 'role'], where: { schoolId: { not: null } }, _count: { _all: true } });
  const map = new Map();
  for (const r of rows) {
    const c = map.get(r.schoolId) || {};
    c[r.role] = r._count._all;
    map.set(r.schoolId, c);
  }
  return map;
}

router.get('/schools', async (req, res) => {
  const search = String(req.query.search || '').trim();
  const [schools, counts] = await Promise.all([
    prisma.school.findMany({
      where: search ? { name: { contains: search, mode: 'insensitive' } } : undefined,
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { departments: true } } },
    }),
    schoolRoleCounts(),
  ]);
  res.json({
    schools: schools.map((s) => {
      const c = counts.get(s.id) || {};
      return { ...s, licence: licenceState(s), students: c.STUDENT || 0, lecturers: c.LECTURER || 0, departments: s._count.departments };
    }),
  });
});

router.post('/schools', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const { state, address, contactEmail, contactPhone, adminName } = req.body;
  if (!name) return res.status(400).json({ error: 'School name is required.' });
  // The school signs in by name, so two schools can't share one (ignoring case).
  const clash = await prisma.school.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
  if (clash) return res.status(409).json({ error: 'A school with that name already exists.' });

  let created;
  for (let attempt = 0; attempt < 5 && !created; attempt++) {
    const joinCode = generateJoinCode();
    try {
      created = await prisma.$transaction(async (tx) => {
        const school = await tx.school.create({
          data: {
            name,
            state: state || null,
            address: address || null,
            contactEmail: contactEmail || null,
            contactPhone: contactPhone || null,
            joinCode,
            subscriptionExpiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
          },
        });
        // The founding admin the join code signs in as. Its credentials are never shown
        // or used: a random password nobody has, and an internal-only email.
        await tx.user.create({
          data: {
            schoolId: school.id,
            role: 'ADMIN',
            fullName: String(adminName || '').trim() || `${name} Admin`,
            email: `school.${joinCode.toLowerCase()}@${INTERNAL_EMAIL_DOMAIN}`,
            passwordHash: await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10),
            phone: contactPhone || null,
          },
        });
        return school;
      });
    } catch (e) {
      if (e.code === 'P2002') continue; // join code collision -- extremely unlikely, just retry
      throw e;
    }
  }
  if (!created) return res.status(500).json({ error: 'Could not generate a unique join code. Please try again.' });
  await logAction(req, 'SCHOOL_CREATED', 'School', created.id, { name });
  res.json({ school: created, joinCode: created.joinCode });
});

router.get('/schools/:id', async (req, res) => {
  const school = await prisma.school.findUnique({
    where: { id: req.params.id },
    include: { _count: { select: { departments: true, semesters: true, hostels: true } } },
  });
  if (!school) return res.status(404).json({ error: 'School not found' });
  const [counts, admins, recentUsers] = await Promise.all([
    prisma.user.groupBy({ by: ['role'], where: { schoolId: school.id }, _count: { _all: true } }),
    prisma.user.findMany({
      where: { schoolId: school.id, role: 'ADMIN', NOT: { email: { endsWith: `@${INTERNAL_EMAIL_DOMAIN}` } } },
      select: { id: true, fullName: true, email: true, status: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.user.findMany({
      where: { schoolId: school.id },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { id: true, fullName: true, role: true, status: true, createdAt: true },
    }),
  ]);
  const byRole = Object.fromEntries(counts.map((c) => [c.role, c._count._all]));
  res.json({ school: { ...school, licence: licenceState(school) }, counts: byRole, admins, recentUsers });
});

router.patch('/schools/:id', async (req, res) => {
  const school = await prisma.school.findUnique({ where: { id: req.params.id } });
  if (!school) return res.status(404).json({ error: 'School not found' });
  const data = {};
  for (const key of ['state', 'address', 'contactEmail', 'contactPhone']) {
    if (req.body[key] !== undefined) data[key] = req.body[key] || null;
  }
  if (req.body.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: 'School name cannot be empty.' });
    const clash = await prisma.school.findFirst({ where: { name: { equals: name, mode: 'insensitive' }, NOT: { id: school.id } } });
    if (clash) return res.status(409).json({ error: 'A school with that name already exists.' });
    data.name = name;
  }
  const updated = await prisma.school.update({ where: { id: school.id }, data });
  await logAction(req, 'SCHOOL_UPDATED', 'School', school.id, data);
  res.json({ school: updated });
});

router.patch('/schools/:id/status', async (req, res) => {
  const { status } = req.body;
  if (!['ACTIVE', 'SUSPENDED'].includes(status)) return res.status(400).json({ error: 'Status must be ACTIVE or SUSPENDED.' });
  const school = await prisma.school.findUnique({ where: { id: req.params.id } });
  if (!school) return res.status(404).json({ error: 'School not found' });
  const updated = await prisma.school.update({ where: { id: school.id }, data: { status } });
  clearSchoolCache(school.id);
  await logAction(req, status === 'SUSPENDED' ? 'SCHOOL_SUSPENDED' : 'SCHOOL_REACTIVATED', 'School', school.id, { name: school.name });
  res.json({ school: updated });
});

// +1 year, counted from whichever is later: today, or the current expiry -- so renewing
// early never throws away time the school already paid for.
router.post('/schools/:id/renew', async (req, res) => {
  const school = await prisma.school.findUnique({ where: { id: req.params.id } });
  if (!school) return res.status(404).json({ error: 'School not found' });
  const base = school.subscriptionExpiresAt && school.subscriptionExpiresAt > new Date() ? school.subscriptionExpiresAt : new Date();
  const subscriptionExpiresAt = new Date(base.getTime() + 365 * 24 * 60 * 60 * 1000);
  const updated = await prisma.school.update({ where: { id: school.id }, data: { subscriptionExpiresAt, status: 'ACTIVE' } });
  clearSchoolCache(school.id);
  await logAction(req, 'SCHOOL_RENEWED', 'School', school.id, { name: school.name, until: subscriptionExpiresAt });
  res.json({ school: updated });
});

router.post('/schools/:id/regenerate-join-code', async (req, res) => {
  const school = await prisma.school.findUnique({ where: { id: req.params.id } });
  if (!school) return res.status(404).json({ error: 'School not found' });
  let updated;
  for (let attempt = 0; attempt < 5 && !updated; attempt++) {
    try {
      updated = await prisma.school.update({ where: { id: school.id }, data: { joinCode: generateJoinCode() } });
    } catch (e) {
      if (e.code !== 'P2002') throw e;
    }
  }
  if (!updated) return res.status(500).json({ error: 'Could not generate a unique join code. Please try again.' });
  await logAction(req, 'SCHOOL_JOIN_CODE_REGENERATED', 'School', school.id, { name: school.name });
  res.json({ school: updated, joinCode: updated.joinCode });
});

// Only a school set up by mistake can be deleted: one with nothing in it but its founding
// admin. Anything with real data is suspended instead -- deleting it would cascade through
// courses, results, submissions and records that cannot be recovered.
router.delete('/schools/:id', async (req, res) => {
  const school = await prisma.school.findUnique({ where: { id: req.params.id } });
  if (!school) return res.status(404).json({ error: 'School not found' });
  if (String(req.query.confirm || '').trim().toLowerCase() !== school.name.toLowerCase()) {
    return res.status(400).json({ error: 'Type the school name to confirm deletion.' });
  }
  const [users, departments, semesters, hostels] = await Promise.all([
    prisma.user.count({ where: { schoolId: school.id } }),
    prisma.department.count({ where: { schoolId: school.id } }),
    prisma.semester.count({ where: { schoolId: school.id } }),
    prisma.hostel.count({ where: { schoolId: school.id } }),
  ]);
  if (users > 1 || departments || semesters || hostels) {
    return res.status(409).json({ error: 'This school already has data in it, so it cannot be deleted. Suspend it instead.' });
  }
  await prisma.$transaction([
    prisma.user.deleteMany({ where: { schoolId: school.id } }),
    prisma.school.delete({ where: { id: school.id } }),
  ]);
  clearSchoolCache(school.id);
  await logAction(req, 'SCHOOL_DELETED', 'School', school.id, { name: school.name });
  res.json({ ok: true });
});

// ---- Users (all roles, platform-wide) ----
router.get('/users', async (req, res) => {
  const search = String(req.query.search || '').trim();
  const role = String(req.query.role || '').trim();
  const where = {};
  if (role) where.role = role;
  if (req.query.schoolId) where.schoolId = String(req.query.schoolId);
  if (req.query.independent === 'true') where.isIndividual = true;
  if (search) {
    where.OR = [
      { fullName: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
    ];
  }
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = 50;
  const [total, users] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { school: { select: { id: true, name: true } } },
    }),
  ]);
  res.json({ total, page, pageSize, users: users.map(safeUser) });
});

router.patch('/users/:id/status', async (req, res) => {
  const { status } = req.body;
  if (!['ACTIVE', 'SUSPENDED'].includes(status)) return res.status(400).json({ error: 'Status must be ACTIVE or SUSPENDED.' });
  if (req.params.id === req.user.id) return res.status(400).json({ error: "You can't change your own account's status." });
  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) return res.status(404).json({ error: 'User not found' });
  const updated = await prisma.user.update({ where: { id: user.id }, data: { status } });
  await logAction(req, status === 'SUSPENDED' ? 'USER_SUSPENDED' : 'USER_REACTIVATED', 'User', user.id, { email: user.email, role: user.role });
  res.json({ user: safeUser(updated) });
});

// ---- Platform admins ----
router.get('/admins', async (req, res) => {
  const admins = await prisma.user.findMany({ where: { role: 'SUPER_ADMIN' }, orderBy: { createdAt: 'asc' } });
  res.json({ admins: admins.map(safeUser) });
});

router.post('/admins', async (req, res) => {
  const fullName = String(req.body.fullName || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const { password } = req.body;
  if (!fullName || !email || !password) return res.status(400).json({ error: 'Name, email and password are required.' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (await prisma.user.findUnique({ where: { email } })) return res.status(409).json({ error: 'An account with that email already exists.' });
  const user = await prisma.user.create({
    data: { fullName, email, passwordHash: await bcrypt.hash(password, 12), role: 'SUPER_ADMIN' },
  });
  await logAction(req, 'SUPER_ADMIN_CREATED', 'User', user.id, { email });
  res.json({ user: safeUser(user) });
});

// ---- Audit log ----
router.get('/audit-logs', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = 100;
  const [total, logs] = await Promise.all([
    prisma.auditLog.count(),
    prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
  ]);
  res.json({ total, page, pageSize, logs });
});

// Announcements, payments, AI activity, live classes, gamification, e-Library, settings.
router.use(require('./superPlatform'));
// Support tickets, live chat, reviews, coins.
router.use(require('./superSupport'));
// Analytics, lessons, courses, labs, attendance, results, teachers, records, logs, codes, question bank.
router.use(require('./superInsights'));
// The Code Editor.
router.use(require('./superCode'));

module.exports = router;
