const express = require('express');
const prisma = require('../db');
const { requireAuth, requireRole } = require('../auth');

const router = express.Router();

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

router.post('/staff/attendance/checkin', requireAuth, requireRole('LECTURER'), async (req, res) => {
  const date = startOfToday();
  const record = await prisma.staffAttendanceRecord.upsert({
    where: { userId_date: { userId: req.user.id, date } },
    create: { userId: req.user.id, date, status: 'PRESENT' },
    update: {},
  });
  res.json({ record });
});

router.get('/staff/attendance/me', requireAuth, requireRole('LECTURER'), async (req, res) => {
  const records = await prisma.staffAttendanceRecord.findMany({
    where: { userId: req.user.id },
    orderBy: { date: 'desc' },
    take: 60,
  });
  res.json({ records });
});

router.post('/staff/cpd', requireAuth, requireRole('LECTURER'), async (req, res) => {
  const { title, provider, hours, completedAt } = req.body;
  if (!title || !provider || !hours || !completedAt) return res.status(400).json({ error: 'Title, provider, hours and date are required.' });
  const record = await prisma.cpdRecord.create({
    data: { userId: req.user.id, title, provider, hours: Number(hours), completedAt: new Date(completedAt) },
  });
  res.json({ record });
});

router.get('/staff/cpd/me', requireAuth, requireRole('LECTURER'), async (req, res) => {
  const records = await prisma.cpdRecord.findMany({ where: { userId: req.user.id }, orderBy: { completedAt: 'desc' } });
  res.json({ records });
});

router.post('/staff/publications', requireAuth, requireRole('LECTURER'), async (req, res) => {
  const { title, outlet, year, url } = req.body;
  if (!title || !outlet || !year) return res.status(400).json({ error: 'Title, outlet and year are required.' });
  const record = await prisma.publication.create({
    data: { userId: req.user.id, title, outlet, year: Number(year), url: url || null },
  });
  res.json({ record });
});

router.get('/staff/publications/me', requireAuth, requireRole('LECTURER'), async (req, res) => {
  const records = await prisma.publication.findMany({ where: { userId: req.user.id }, orderBy: { year: 'desc' } });
  res.json({ records });
});

// ---- Admin views: real activity-derived workload + all staff records ----

router.get('/admin/staff/workload', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const lecturers = await prisma.user.findMany({
    where: { schoolId: req.user.schoolId, role: 'LECTURER' },
    select: { id: true, fullName: true, department: { select: { name: true } } },
  });
  // Five grouped queries for the whole staff list, not five per lecturer.
  const ids = lecturers.map((l) => l.id);
  const [lessons, assessments, liveClasses, labDemos, courseRows] = ids.length ? await Promise.all([
    prisma.lesson.groupBy({ by: ['authorId'], where: { authorId: { in: ids } }, _count: { _all: true } }),
    prisma.assessment.groupBy({ by: ['authorId'], where: { authorId: { in: ids } }, _count: { _all: true } }),
    prisma.liveClass.groupBy({ by: ['hostId'], where: { hostId: { in: ids } }, _count: { _all: true } }),
    prisma.labDemonstration.groupBy({ by: ['authorId'], where: { authorId: { in: ids }, source: 'CURATED' }, _count: { _all: true } }),
    prisma.lesson.findMany({ where: { authorId: { in: ids } }, distinct: ['authorId', 'courseId'], select: { authorId: true } }),
  ]) : [[], [], [], [], []];
  const count = (rows, key) => new Map(rows.map((r) => [r[key], r._count._all]));
  const L = count(lessons, 'authorId'), A = count(assessments, 'authorId'), C = count(liveClasses, 'hostId'), D = count(labDemos, 'authorId');
  const courses = new Map();
  courseRows.forEach((r) => courses.set(r.authorId, (courses.get(r.authorId) || 0) + 1));
  const workload = lecturers.map((l) => ({
    fullName: l.fullName, department: l.department?.name || null,
    courses: courses.get(l.id) || 0, lessons: L.get(l.id) || 0, assessments: A.get(l.id) || 0, liveClasses: C.get(l.id) || 0, labDemos: D.get(l.id) || 0,
  }));
  res.json({ workload });
});

// Every attendance record, not just recent -- the admin's own "Attendance" view.
router.get('/admin/staff/attendance', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const records = await prisma.staffAttendanceRecord.findMany({
    where: { user: { schoolId: req.user.schoolId, role: 'LECTURER' } },
    include: { user: { select: { fullName: true } } },
    orderBy: { date: 'desc' },
  });
  res.json({ records });
});

router.get('/admin/staff/cpd', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const records = await prisma.cpdRecord.findMany({
    where: { user: { schoolId: req.user.schoolId } },
    include: { user: { select: { fullName: true } } },
    orderBy: { completedAt: 'desc' },
  });
  res.json({ records });
});

router.get('/admin/staff/publications', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const records = await prisma.publication.findMany({
    where: { user: { schoolId: req.user.schoolId } },
    include: { user: { select: { fullName: true } } },
    orderBy: { year: 'desc' },
  });
  res.json({ records });
});

module.exports = router;
