const express = require('express');
const prisma = require('../db');
const { requireAuth, requireRole, logActivity } = require('../auth');
const gamification = require('../services/gamification.service');
const { getCurrentSemesterId } = require('../semester');
const { notify, notifyMany } = require('../services/notification.service');

const router = express.Router();

// Every timed assessment (CA/Test/Mock/Semester Exam/Past Question practice) gets
// exactly 1 minute per question -- not the lecturer-set durationMin field, which is
// kept on the model but no longer used for the actual time limit.
function minutesFor(questionCount) {
  return Math.max(1, questionCount);
}

router.get('/courses/:id/assessments', requireAuth, async (req, res) => {
  const assessments = await prisma.assessment.findMany({
    where: { courseId: req.params.id },
    include: { _count: { select: { questions: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ assessments });
});

const MAX_QUESTIONS = { PAST_QUESTION: 20, DEFAULT: 10 };

function questionCreateData(questions) {
  return questions.map((q, i) => ({
    questionType: q.questionType === 'THEORY' ? 'THEORY' : 'OBJECTIVE',
    text: q.text,
    options: q.questionType === 'THEORY' ? null : JSON.stringify(q.options),
    correctIndex: q.questionType === 'THEORY' ? null : q.correctIndex,
    modelAnswer: q.questionType === 'THEORY' ? (q.modelAnswer || null) : null,
    explanation: q.questionType === 'THEORY' ? null : (q.explanation || null),
    order: i,
  }));
}

router.post('/courses/:id/assessments', requireAuth, requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  const { title, type, durationMin, questions } = req.body;
  if (!title || !Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: 'Title and at least one question are required' });
  }
  const max = MAX_QUESTIONS[type] || MAX_QUESTIONS.DEFAULT;
  if (questions.length > max) {
    return res.status(400).json({ error: `${type === 'PAST_QUESTION' ? 'Past question sets' : 'Tests'} can have at most ${max} questions.` });
  }
  const semesterId = await getCurrentSemesterId(req.user.schoolId);
  const assessment = await prisma.assessment.create({
    data: {
      courseId: req.params.id,
      title,
      type: type || 'CA',
      durationMin: durationMin || 20,
      authorId: req.user.id,
      semesterId,
      questions: { create: questionCreateData(questions) },
    },
    include: { questions: true },
  });
  if (req.user.role === 'LECTURER') await logActivity(req.user.id, 'CREATE_ASSESSMENT', title);

  // Real tests/exams notify the class immediately; PAST_QUESTION sets are practice
  // material a student opts into, not an event worth pushing a notification for.
  if (type !== 'PAST_QUESTION') {
    const students = await prisma.enrollment.findMany({ where: { courseId: req.params.id }, select: { studentId: true } });
    const label = type === 'SEMESTER_EXAM' ? 'New semester exam' : 'New test';
    await notifyMany(students.map((s) => s.studentId), label, title, type === 'SEMESTER_EXAM' ? 'semester-exam-hub' : 'cbt-mock');
  }

  res.json({ assessment });
});

// Lecturer edits their own already-set test/exam -- title and/or the full question
// set. Replaces every question rather than diffing them (simpler, and a lecturer
// editing a test is expected to review the whole thing anyway); refused once anyone
// has submitted, since changing questions under a student mid-attempt (or after
// grading) would silently invalidate their score.
router.put('/assessments/:id', requireAuth, requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  const { title, questions } = req.body;
  const assessment = await prisma.assessment.findUnique({ where: { id: req.params.id } });
  if (!assessment) return res.status(404).json({ error: 'Assessment not found' });
  if (assessment.authorId !== req.user.id && req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'You can only edit tests/exams you created.' });
  }
  const submissionCount = await prisma.submission.count({ where: { assessmentId: assessment.id, submittedAt: { not: null } } });
  if (submissionCount > 0) return res.status(400).json({ error: 'This already has submissions and can no longer be edited.' });

  if (!title || !Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: 'Title and at least one question are required' });
  }
  const max = MAX_QUESTIONS[assessment.type] || MAX_QUESTIONS.DEFAULT;
  if (questions.length > max) {
    return res.status(400).json({ error: `${assessment.type === 'PAST_QUESTION' ? 'Past question sets' : 'Tests'} can have at most ${max} questions.` });
  }

  await prisma.question.deleteMany({ where: { assessmentId: assessment.id } });
  const updated = await prisma.assessment.update({
    where: { id: assessment.id },
    data: {
      title,
      questions: { create: questionCreateData(questions) },
    },
    include: { questions: true },
  });
  res.json({ assessment: updated });
});

// Student view: questions without the correct answer revealed. mySubmission may be a
// completed attempt (score set) or an in-progress one (startedAt set, score still
// null) -- the frontend uses that to resume a timer rather than restart it.
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
      questionType: q.questionType,
      text: q.text,
      options: q.options ? JSON.parse(q.options) : null,
      order: q.order,
    }));
    return res.json({ assessment: { ...assessment, questions }, mySubmission });
  }
  res.json({ assessment });
});

// Stamps (or resumes) the student's attempt start time -- the deadline for /submit is
// measured from here, not from whenever the client happens to POST the answers.
router.post('/assessments/:id/start', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const assessment = await prisma.assessment.findUnique({ where: { id: req.params.id }, include: { _count: { select: { questions: true } } } });
  if (!assessment) return res.status(404).json({ error: 'Assessment not found' });
  const durationMin = minutesFor(assessment._count.questions);

  const existing = await prisma.submission.findUnique({
    where: { assessmentId_studentId: { assessmentId: assessment.id, studentId: req.user.id } },
  });
  if (existing && existing.submittedAt) return res.status(409).json({ error: 'You have already submitted this assessment' });
  if (existing) return res.json({ startedAt: existing.startedAt, durationMin });

  const submission = await prisma.submission.create({
    data: { assessmentId: assessment.id, studentId: req.user.id, startedAt: new Date() },
  });
  res.json({ startedAt: submission.startedAt, durationMin });
});

router.post('/assessments/:id/submit', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const { answers } = req.body; // array of { questionId, choice } (objective) / { questionId, text } (theory)
  const assessment = await prisma.assessment.findUnique({
    where: { id: req.params.id },
    include: { questions: true },
  });
  if (!assessment) return res.status(404).json({ error: 'Assessment not found' });

  const existing = await prisma.submission.findUnique({
    where: { assessmentId_studentId: { assessmentId: assessment.id, studentId: req.user.id } },
  });
  if (existing && existing.submittedAt) return res.status(409).json({ error: 'You have already submitted this assessment' });
  if (!existing || !existing.startedAt) return res.status(400).json({ error: 'Start the assessment before submitting.' });

  const deadline = new Date(existing.startedAt.getTime() + minutesFor(assessment.questions.length) * 60000 + 15000); // 15s grace for network lag
  if (new Date() > deadline) return res.status(400).json({ error: 'Time is up for this assessment.' });

  const objectiveQuestions = assessment.questions.filter((q) => q.questionType !== 'THEORY');
  let score = 0;
  const answerMap = new Map((answers || []).map((a) => [a.questionId, a.choice]));
  for (const q of objectiveQuestions) {
    if (answerMap.get(q.id) === q.correctIndex) score += 1;
  }

  const submission = await prisma.submission.update({
    where: { id: existing.id },
    data: {
      answers: JSON.stringify(answers || []),
      score,
      total: objectiveQuestions.length,
      submittedAt: new Date(),
    },
  });

  const { pointsEarned, newBadges } = await gamification.recordAssessmentCompletion(
    req.user.id,
    score,
    objectiveQuestions.length
  );
  res.json({ submission, pointsEarned, newBadges });
});

// Review-mistakes: correct answers + the student's own choice, for after a graded
// (non-practice) submission. Theory questions show the model answer alongside the
// student's text for self-comparison, never a correct/wrong verdict.
router.get('/assessments/:id/my-review', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const assessment = await prisma.assessment.findUnique({ where: { id: req.params.id }, include: { questions: true } });
  if (!assessment) return res.status(404).json({ error: 'Assessment not found' });
  const submission = await prisma.submission.findUnique({
    where: { assessmentId_studentId: { assessmentId: assessment.id, studentId: req.user.id } },
  });
  if (!submission || !submission.submittedAt) return res.status(404).json({ error: 'No submitted attempt to review.' });

  const answerMap = new Map((JSON.parse(submission.answers || '[]')).map((a) => [a.questionId, a]));
  const review = assessment.questions.map((q) => {
    const mine = answerMap.get(q.id);
    if (q.questionType === 'THEORY') {
      return { questionId: q.id, questionType: 'THEORY', text: q.text, myAnswer: mine ? mine.text : null, modelAnswer: q.modelAnswer };
    }
    const chosen = mine ? mine.choice : null;
    return {
      questionId: q.id, questionType: 'OBJECTIVE', text: q.text, options: JSON.parse(q.options),
      correctIndex: q.correctIndex, chosen, correct: chosen === q.correctIndex, explanation: q.explanation,
    };
  });
  res.json({ review, score: submission.score, total: submission.total });
});

// Past questions are for practice: no single-submission lock, no persisted record, no
// gamification points -- just instant grading so a student can retry as many times as
// they want. Theory questions are never auto-graded -- the model answer comes back for
// self-comparison and doesn't affect the score.
router.post('/assessments/:id/practice-submit', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const { answers } = req.body;
  const assessment = await prisma.assessment.findUnique({ where: { id: req.params.id }, include: { questions: true } });
  if (!assessment) return res.status(404).json({ error: 'Assessment not found' });
  if (assessment.type !== 'PAST_QUESTION') return res.status(400).json({ error: 'Only past-question sets support practice mode.' });

  const answerMap = new Map((answers || []).map((a) => [a.questionId, a]));
  let score = 0;
  const objectiveCount = assessment.questions.filter((q) => q.questionType !== 'THEORY').length;
  const corrections = assessment.questions.map((q) => {
    const mine = answerMap.get(q.id);
    if (q.questionType === 'THEORY') {
      return { questionId: q.id, questionType: 'THEORY', myAnswer: mine ? mine.text : null, modelAnswer: q.modelAnswer };
    }
    const chosen = mine ? mine.choice : undefined;
    const correct = chosen === q.correctIndex;
    if (correct) score += 1;
    return { questionId: q.id, questionType: 'OBJECTIVE', correctIndex: q.correctIndex, chosen: chosen ?? null, correct, explanation: q.explanation };
  });
  res.json({ score, total: objectiveCount, corrections });
});

// Every submitted attempt with at least one theory question that hasn't been reviewed
// yet -- theory answers are never auto-graded (assessments.js:submit only scores
// OBJECTIVE questions), so without this inbox they'd sit ungraded indefinitely. Powers
// the "Mark Work" hub alongside the equivalent Assignment-submissions inbox.
router.get('/lecturer/theory-submissions', requireAuth, requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  const submissions = await prisma.submission.findMany({
    where: {
      submittedAt: { not: null },
      markedAt: null,
      assessment: { authorId: req.user.id, questions: { some: { questionType: 'THEORY' } } },
    },
    include: {
      assessment: {
        select: { id: true, title: true, type: true, course: { select: { code: true, title: true } }, questions: { where: { questionType: 'THEORY' } } },
      },
      student: { select: { fullName: true, matricNumber: true } },
    },
    orderBy: { submittedAt: 'asc' },
  });
  res.json({
    submissions: submissions.map((s) => {
      const answers = JSON.parse(s.answers || '[]');
      const theoryAnswers = s.assessment.questions.map((q) => {
        const mine = answers.find((a) => a.questionId === q.id);
        return { questionId: q.id, text: q.text, myAnswer: mine ? mine.text : null, modelAnswer: q.modelAnswer };
      });
      return {
        id: s.id, student: s.student,
        assessment: { id: s.assessment.id, title: s.assessment.title, type: s.assessment.type, course: s.assessment.course },
        theoryAnswers,
      };
    }),
  });
});

// The score/max the lecturer enters for the theory portion only -- kept separate from
// the auto-graded objective `score`/`total` rather than merged into one number, since
// the two are graded through entirely different mechanisms.
router.post('/submissions/:id/mark-theory', requireAuth, requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  const { theoryScore, theoryMaxScore } = req.body;
  if (theoryScore === undefined || theoryScore === null || theoryMaxScore === undefined || theoryMaxScore === null) {
    return res.status(400).json({ error: 'A score and max score are required.' });
  }
  const submission = await prisma.submission.update({
    where: { id: req.params.id },
    data: { theoryScore: Number(theoryScore), theoryMaxScore: Number(theoryMaxScore), markedAt: new Date() },
    include: { assessment: { select: { title: true } } },
  });
  await notify(submission.studentId, 'Written answers marked', `${submission.assessment.title}: ${theoryScore}/${theoryMaxScore} for the written questions.`, 'student-results');
  res.json({ submission });
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
// profile page's "Results" section. Only completed attempts -- an in-progress one
// (started but not yet submitted) has no score to show.
router.get('/students/me/results', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const submissions = await prisma.submission.findMany({
    where: { studentId: req.user.id, submittedAt: { not: null } },
    include: {
      assessment: {
        include: { course: { select: { code: true, title: true } }, individualCourse: { select: { title: true } } },
      },
    },
    orderBy: { submittedAt: 'desc' },
  });
  res.json({
    results: submissions.map((s) => ({
      id: s.id,
      assessmentId: s.assessmentId,
      assessmentTitle: s.assessment.title,
      assessmentType: s.assessment.type,
      courseCode: s.assessment.course ? s.assessment.course.code : null,
      courseTitle: s.assessment.course ? s.assessment.course.title : s.assessment.individualCourse.title,
      score: s.score,
      total: s.total,
      submittedAt: s.submittedAt,
    })),
  });
});

// Lecturer: score sheet for an assessment. Only completed attempts.
router.get('/assessments/:id/results', requireAuth, requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  const submissions = await prisma.submission.findMany({
    where: { assessmentId: req.params.id, submittedAt: { not: null } },
    include: { student: { select: { fullName: true, matricNumber: true } } },
    orderBy: { score: 'desc' },
  });
  res.json({ submissions });
});

module.exports = router;
