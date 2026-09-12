const express = require('express');
const prisma = require('../db');
const { requireAuth, requireRole, logActivity } = require('../auth');
const gamification = require('../services/gamification.service');

const router = express.Router();

router.get('/courses/:id/assessments', requireAuth, async (req, res) => {
  const assessments = await prisma.assessment.findMany({
    where: { courseId: req.params.id },
    include: { _count: { select: { questions: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ assessments });
});

const MAX_QUESTIONS = { PAST_QUESTION: 20, DEFAULT: 10 };

router.post('/courses/:id/assessments', requireAuth, requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  const { title, type, durationMin, questions } = req.body;
  if (!title || !Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: 'Title and at least one question are required' });
  }
  const max = MAX_QUESTIONS[type] || MAX_QUESTIONS.DEFAULT;
  if (questions.length > max) {
    return res.status(400).json({ error: `${type === 'PAST_QUESTION' ? 'Past question sets' : 'Tests'} can have at most ${max} questions.` });
  }
  const assessment = await prisma.assessment.create({
    data: {
      courseId: req.params.id,
      title,
      type: type || 'CA',
      durationMin: durationMin || 20,
      authorId: req.user.id,
      questions: {
        create: questions.map((q, i) => ({
          text: q.text,
          options: JSON.stringify(q.options),
          correctIndex: q.correctIndex,
          order: i,
        })),
      },
    },
    include: { questions: true },
  });
  if (req.user.role === 'LECTURER') await logActivity(req.user.id, 'CREATE_ASSESSMENT', title);
  res.json({ assessment });
});

// Student view: questions without the correct answer revealed.
router.get('/assessments/:id', requireAuth, async (req, res) => {
  const assessment = await prisma.assessment.findUnique({
    where: { id: req.params.id },
    include: { questions: true, course: true },
  });
  if (!assessment) return res.status(404).json({ error: 'Assessment not found' });

  if (req.user.role === 'STUDENT') {
    const mySubmission = await prisma.submission.findUnique({
      where: { assessmentId_studentId: { assessmentId: assessment.id, studentId: req.user.id } },
    });
    const questions = assessment.questions.map((q) => ({
      id: q.id,
      text: q.text,
      options: JSON.parse(q.options),
      order: q.order,
    }));
    return res.json({ assessment: { ...assessment, questions }, mySubmission });
  }
  res.json({ assessment });
});

router.post('/assessments/:id/submit', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const { answers } = req.body; // array of { questionId, choice }
  const assessment = await prisma.assessment.findUnique({
    where: { id: req.params.id },
    include: { questions: true },
  });
  if (!assessment) return res.status(404).json({ error: 'Assessment not found' });

  const existing = await prisma.submission.findUnique({
    where: { assessmentId_studentId: { assessmentId: assessment.id, studentId: req.user.id } },
  });
  if (existing) return res.status(409).json({ error: 'You have already submitted this assessment' });

  let score = 0;
  const answerMap = new Map((answers || []).map((a) => [a.questionId, a.choice]));
  for (const q of assessment.questions) {
    if (answerMap.get(q.id) === q.correctIndex) score += 1;
  }

  const submission = await prisma.submission.create({
    data: {
      assessmentId: assessment.id,
      studentId: req.user.id,
      answers: JSON.stringify(answers || []),
      score,
      total: assessment.questions.length,
    },
  });

  const { pointsEarned, newBadges } = await gamification.recordAssessmentCompletion(
    req.user.id,
    score,
    assessment.questions.length
  );
  res.json({ submission, pointsEarned, newBadges });
});

// Past questions are for practice: no single-submission lock, no persisted record, no
// gamification points -- just instant grading so a student can retry as many times as
// they want.
router.post('/assessments/:id/practice-submit', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const { answers } = req.body;
  const assessment = await prisma.assessment.findUnique({ where: { id: req.params.id }, include: { questions: true } });
  if (!assessment) return res.status(404).json({ error: 'Assessment not found' });
  if (assessment.type !== 'PAST_QUESTION') return res.status(400).json({ error: 'Only past-question sets support practice mode.' });

  const answerMap = new Map((answers || []).map((a) => [a.questionId, a.choice]));
  let score = 0;
  const corrections = assessment.questions.map((q) => {
    const chosen = answerMap.get(q.id);
    const correct = chosen === q.correctIndex;
    if (correct) score += 1;
    return { questionId: q.id, correctIndex: q.correctIndex, chosen: chosen ?? null, correct };
  });
  res.json({ score, total: assessment.questions.length, corrections });
});

router.get('/students/me/progress', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const progress = await gamification.getProgress(req.user.id);
  res.json(progress);
});

router.get('/leaderboard', requireAuth, async (req, res) => {
  const leaderboard = await gamification.getLeaderboard(req.user.schoolId, req.query.departmentId || undefined);
  res.json({ leaderboard });
});

// A student's full result history across every course -- powers the Digital ID /
// profile page's "Results" section.
router.get('/students/me/results', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const submissions = await prisma.submission.findMany({
    where: { studentId: req.user.id },
    include: { assessment: { include: { course: { select: { code: true, title: true } } } } },
    orderBy: { submittedAt: 'desc' },
  });
  res.json({
    results: submissions.map((s) => ({
      id: s.id,
      assessmentTitle: s.assessment.title,
      assessmentType: s.assessment.type,
      courseCode: s.assessment.course.code,
      courseTitle: s.assessment.course.title,
      score: s.score,
      total: s.total,
      submittedAt: s.submittedAt,
    })),
  });
});

// Lecturer: score sheet for an assessment
router.get('/assessments/:id/results', requireAuth, requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  const submissions = await prisma.submission.findMany({
    where: { assessmentId: req.params.id },
    include: { student: { select: { fullName: true, matricNumber: true } } },
    orderBy: { score: 'desc' },
  });
  res.json({ submissions });
});

module.exports = router;
