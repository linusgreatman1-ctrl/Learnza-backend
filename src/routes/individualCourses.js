const express = require('express');
const prisma = require('../db');
const { requireAuth, requireRole } = require('../auth');

const router = express.Router();

// Self-directed courses for individual (non-school) learners -- no lecturer, no
// department, just a topic they want the AI Teacher to cover.
router.get('/individual-courses', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const courses = await prisma.individualCourse.findMany({
    where: { studentId: req.user.id },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ courses });
});

router.post('/individual-courses', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const { title, description } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Give your course a title.' });
  const course = await prisma.individualCourse.create({
    data: { studentId: req.user.id, title: title.trim(), description: description || null },
  });
  res.json({ course });
});

router.get('/individual-courses/:id', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const course = await prisma.individualCourse.findFirst({ where: { id: req.params.id, studentId: req.user.id } });
  if (!course) return res.status(404).json({ error: 'Course not found' });
  res.json({ course });
});

router.delete('/individual-courses/:id', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const course = await prisma.individualCourse.findFirst({ where: { id: req.params.id, studentId: req.user.id } });
  if (!course) return res.status(404).json({ error: 'Course not found' });
  await prisma.individualCourse.delete({ where: { id: course.id } });
  res.json({ ok: true });
});

module.exports = router;
