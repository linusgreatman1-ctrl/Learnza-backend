const express = require('express');
const prisma = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { notify, notifySchoolAdmins } = require('../services/notification.service');
const { getCurrentSemesterId } = require('../semester');

const router = express.Router();

// Lecturer compiles a formal result for one student/course/term. "send" controls
// whether it goes out immediately (visible to the student and school admin, with
// notifications) or is just saved as a draft (sentAt stays null, invisible to the
// student) for the lecturer to review and send later, individually or in bulk via
// the /publish route below.
router.post('/courses/:id/results', requireAuth, requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  const { studentId, term, score, grade, remark, send } = req.body;
  if (!studentId || !term || score === undefined || score === null) {
    return res.status(400).json({ error: 'Student, semester and score are required.' });
  }
  const semesterId = await getCurrentSemesterId(req.user.schoolId);
  const result = await prisma.result.create({
    data: {
      courseId: req.params.id, studentId, authorId: req.user.id, term, semesterId,
      score: Number(score), grade: grade || null, remark: remark || null,
      sentAt: send === false ? null : new Date(),
    },
    include: { student: { select: { fullName: true, schoolId: true } } },
  });
  if (send !== false) {
    await notify(studentId, 'Result published', `Your result for ${term} is ready.`, 'digital-id');
    await notifySchoolAdmins(
      result.student.schoolId,
      'Score released',
      `${result.student.fullName} scored ${score} for ${term}.`,
      'admin-student-activity'
    );
  }
  res.json({ result });
});

// Sends one specific draft result -- the admin Results screens work across many
// courses for one student at a time, where a per-course bulk /publish (below) would
// need a separate button per course; this covers that case with a single "Send" per
// row instead.
// Sends a draft result the first time, or resends an already-sent one (e.g. a student
// missed the notification, or the lecturer wants to prompt them to check it again) --
// same endpoint either way, since the only difference is whether sentAt was already set.
router.post('/results/:id/send', requireAuth, requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  const result = await prisma.result.findUnique({ where: { id: req.params.id }, include: { student: { select: { fullName: true, schoolId: true } } } });
  if (!result || result.student.schoolId !== req.user.schoolId) return res.status(404).json({ error: 'Result not found' });
  if (result.authorId !== req.user.id && req.user.role !== 'ADMIN') return res.status(403).json({ error: 'You can only send results you created.' });

  const updated = await prisma.result.update({ where: { id: result.id }, data: { sentAt: result.sentAt || new Date() } });
  await notify(result.studentId, 'Result published', `Your result for ${result.term} is ready.`, 'digital-id');
  await notifySchoolAdmins(
    result.student.schoolId,
    'Score released',
    `${result.student.fullName} scored ${result.score} for ${result.term}.`,
    'admin-student-activity'
  );
  res.json({ result: updated });
});

// Edits a saved result's own fields, whether still a draft or already sent -- lets a
// lecturer correct a mistake without deleting and recreating the row. Editing an
// already-sent result doesn't re-notify on its own; use /send afterward to resend if
// the correction should reach the student again.
router.put('/results/:id', requireAuth, requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  const { term, score, grade, remark } = req.body;
  const result = await prisma.result.findUnique({ where: { id: req.params.id }, include: { student: { select: { schoolId: true } } } });
  if (!result || result.student.schoolId !== req.user.schoolId) return res.status(404).json({ error: 'Result not found' });
  if (result.authorId !== req.user.id && req.user.role !== 'ADMIN') return res.status(403).json({ error: 'You can only edit results you created.' });
  if (!term || score === undefined || score === null) return res.status(400).json({ error: 'Semester and score are required.' });

  const updated = await prisma.result.update({
    where: { id: result.id },
    data: { term, score: Number(score), grade: grade || null, remark: remark || null },
  });
  res.json({ result: updated });
});

// Sends every draft (sentAt still null) result this lecturer has saved for a course,
// individually notifying each student by name in one action -- the bulk counterpart
// to sending one result at a time from the create dialog.
router.post('/courses/:id/results/publish', requireAuth, requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  const drafts = await prisma.result.findMany({
    where: { courseId: req.params.id, authorId: req.user.id, sentAt: null },
    include: { student: { select: { fullName: true, schoolId: true } } },
  });
  if (!drafts.length) return res.json({ count: 0 });
  await prisma.result.updateMany({ where: { id: { in: drafts.map((d) => d.id) } }, data: { sentAt: new Date() } });
  for (const result of drafts) {
    await notify(result.studentId, 'Result published', `Your result for ${result.term} is ready.`, 'digital-id');
    await notifySchoolAdmins(
      result.student.schoolId,
      'Score released',
      `${result.student.fullName} scored ${result.score} for ${result.term}.`,
      'admin-student-activity'
    );
  }
  res.json({ count: drafts.length });
});

router.get('/courses/:id/results', requireAuth, requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  const results = await prisma.result.findMany({
    where: { courseId: req.params.id },
    include: { student: { select: { fullName: true, matricNumber: true } } },
    orderBy: { publishedAt: 'desc' },
  });
  res.json({ results });
});

router.get('/students/me/formal-results', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const results = await prisma.result.findMany({
    where: { studentId: req.user.id, sentAt: { not: null } },
    include: { course: { select: { code: true, title: true } } },
    orderBy: { publishedAt: 'desc' },
  });
  res.json({ results });
});

// Every formal result for one student, across every course -- backs admin's Results
// screen ("click a student to see all the details of their results"). Unlike the
// student's own view, this intentionally includes drafts (sentAt still null) too --
// admin authored some of them and needs to see/send them from here, not just the
// already-published ones.
router.get('/admin/students/:id/results', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const student = await prisma.user.findFirst({ where: { id: req.params.id, schoolId: req.user.schoolId, role: 'STUDENT' } });
  if (!student) return res.status(404).json({ error: 'Student not found' });
  const results = await prisma.result.findMany({
    where: { studentId: student.id },
    include: { course: { select: { id: true, code: true, title: true } } },
    orderBy: { publishedAt: 'desc' },
  });
  res.json({ student: { id: student.id, fullName: student.fullName, matricNumber: student.matricNumber }, results });
});

module.exports = router;
