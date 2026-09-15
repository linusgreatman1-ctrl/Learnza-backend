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
  const workload = await Promise.all(
    lecturers.map(async (l) => {
      const [lessons, assessments, liveClasses, labDemos, courseIds] = await Promise.all([
        prisma.lesson.count({ where: { authorId: l.id } }),
        prisma.assessment.count({ where: { authorId: l.id } }),
        prisma.liveClass.count({ where: { hostId: l.id } }),
        prisma.labDemonstration.count({ where: { authorId: l.id, source: 'CURATED' } }),
        prisma.lesson.findMany({ where: { authorId: l.id }, distinct: ['courseId'], select: { courseId: true } }),
      ]);
      return { fullName: l.fullName, department: l.department?.name || null, courses: courseIds.length, lessons, assessments, liveClasses, labDemos };
    })
  );
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
