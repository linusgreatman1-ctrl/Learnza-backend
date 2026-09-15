const express = require('express');
const prisma = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { notify } = require('../services/notification.service');
const { getCurrentSemesterId } = require('../semester');

const router = express.Router();

// Lecturer compiles and publishes a formal result for one student/course/term --
// visible to the student and to school admin. Distinct from raw CBT/assignment scores.
router.post('/courses/:id/results', requireAuth, requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  const { studentId, term, score, grade, remark } = req.body;
  if (!studentId || !term || score === undefined || score === null) {
    return res.status(400).json({ error: 'Student, term and score are required.' });
  }
  const semesterId = await getCurrentSemesterId(req.user.schoolId);
  const result = await prisma.result.create({
    data: { courseId: req.params.id, studentId, authorId: req.user.id, term, semesterId, score: Number(score), grade: grade || null, remark: remark || null },
  });
  await notify(studentId, 'Result published', `Your result for ${term} is ready.`, 'digital-id');
  res.json({ result });
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
    where: { studentId: req.user.id },
    include: { course: { select: { code: true, title: true } } },
    orderBy: { publishedAt: 'desc' },
  });
  res.json({ results });
});

module.exports = router;
