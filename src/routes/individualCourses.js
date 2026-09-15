const express = require('express');
const prisma = require('../db');
const { requireAuth, requireRole } = require('../auth');
const quizGen = require('../services/quizGen.service');

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

// App-generated tests/assignments for a self-directed course -- there's no lecturer to
// set these, so the AI drafts them on request. Taking/scoring/review-mistakes reuse the
// exact same generic /assessments/:id/* endpoints school courses use.
router.get('/individual-courses/:id/assessments', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const course = await prisma.individualCourse.findFirst({ where: { id: req.params.id, studentId: req.user.id } });
  if (!course) return res.status(404).json({ error: 'Course not found' });
  const assessments = await prisma.assessment.findMany({
    where: { individualCourseId: course.id },
    include: { _count: { select: { questions: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ assessments });
});

router.post('/individual-courses/:id/assessments/generate', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const { topic, kind } = req.body; // kind: 'TEST' | 'ASSIGNMENT'
  if (!topic || !topic.trim()) return res.status(400).json({ error: 'Describe the topic first.' });
  const course = await prisma.individualCourse.findFirst({ where: { id: req.params.id, studentId: req.user.id } });
  if (!course) return res.status(404).json({ error: 'Course not found' });

  try {
    const isAssignment = kind === 'ASSIGNMENT';
    const draft = isAssignment
      ? await quizGen.generateAssignment({ courseTitle: course.title, topic })
      : await quizGen.generateQuiz({ courseTitle: course.title, topic });

    const assessment = await prisma.assessment.create({
      data: {
        individualCourseId: course.id,
        authorId: req.user.id,
        title: draft.title || topic,
        type: isAssignment ? 'Assignment' : 'Test',
        durationMin: isAssignment ? 30 : 15,
        questions: {
          create: (draft.questions || []).map((q, i) => isAssignment
            ? { questionType: 'THEORY', text: q.text, modelAnswer: q.modelAnswer || null, order: i }
            : { questionType: 'OBJECTIVE', text: q.text, options: JSON.stringify(q.options), correctIndex: q.correctIndex, order: i }),
        },
      },
      include: { questions: true },
    });
    res.json({ assessment });
  } catch (err) {
    if (err.code === 'AI_NOT_CONFIGURED') return res.status(503).json({ error: err.message, code: err.code });
    res.status(502).json({ error: 'Could not generate that right now. Please try again.' });
  }
});

module.exports = router;
