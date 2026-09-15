const express = require('express');
const prisma = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { getCurrentSemesterId } = require('../semester');

const router = express.Router();

function startOfDay(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// Roster + today's marks, so the lecturer's attendance screen can render in one call.
router.get('/courses/:id/attendance', requireAuth, requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  const date = startOfDay(req.query.date);
  const enrollments = await prisma.enrollment.findMany({
    where: { courseId: req.params.id },
    include: { student: { select: { id: true, fullName: true, matricNumber: true } } },
    orderBy: { student: { fullName: 'asc' } },
  });
  const marks = await prisma.classAttendanceRecord.findMany({ where: { courseId: req.params.id, date } });
  const markByStudent = new Map(marks.map((m) => [m.studentId, m.status]));
  res.json({
    date,
    roster: enrollments.map((e) => ({ student: e.student, status: markByStudent.get(e.student.id) || null })),
  });
});

router.post('/courses/:id/attendance', requireAuth, requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  const { studentId, status, date } = req.body;
  if (!studentId || !['PRESENT', 'ABSENT'].includes(status)) {
    return res.status(400).json({ error: 'studentId and a valid status (PRESENT/ABSENT) are required.' });
  }
  const markDate = startOfDay(date);
  const semesterId = await getCurrentSemesterId(req.user.schoolId);
  const record = await prisma.classAttendanceRecord.upsert({
    where: { courseId_studentId_date: { courseId: req.params.id, studentId, date: markDate } },
    create: { courseId: req.params.id, studentId, date: markDate, status, markedById: req.user.id, semesterId },
    update: { status, markedById: req.user.id },
  });
  res.json({ record });
});

// A student's own attendance history for a course.
router.get('/courses/:id/attendance/me', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const records = await prisma.classAttendanceRecord.findMany({
    where: { courseId: req.params.id, studentId: req.user.id },
    orderBy: { date: 'desc' },
    take: 60,
  });
  res.json({ records });
});

module.exports = router;
