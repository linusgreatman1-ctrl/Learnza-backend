const express = require('express');
const prisma = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { requireActiveSubscription } = require('../subscription');
const aiTeacher = require('../services/aiTeacher.service');
const simli = require('../services/simli.service');

const router = express.Router();

function handleAiError(res, err) {
  if (err.code === 'AI_NOT_CONFIGURED' || err.code === 'SIMLI_NOT_CONFIGURED') {
    return res.status(503).json({ error: err.message, code: err.code });
  }
  return res.status(502).json({ error: err.message || 'The AI Teacher had trouble responding. Please try again.' });
}

function courseTitleOf(session) {
  return session.course?.title || session.individualCourse?.title || session.topic;
}

router.get('/config', requireAuth, (req, res) => {
  res.json({ aiConfigured: aiTeacher.isConfigured(), avatarConfigured: simli.isConfigured() });
});

async function startSession(req, res, { courseId, individualCourseId, courseTitle }) {
  const { topic } = req.body;
  if (!topic || !topic.trim()) return res.status(400).json({ error: 'Tell the AI Teacher what topic to cover.' });

  try {
    const plan = await aiTeacher.generateLessonPlan({ courseTitle, topic });
    const session = await prisma.aiTeacherSession.create({
      data: {
        studentId: req.user.id,
        courseId: courseId || null,
        individualCourseId: individualCourseId || null,
        topic,
        planJson: JSON.stringify(plan),
        sectionIdx: 0,
        turns: { create: [{ role: 'TEACHER', type: 'SECTION', content: JSON.stringify(plan.sections[0]), sectionIdx: 0 }] },
      },
      include: { turns: true },
    });
    res.json({ session: { ...session, plan } });
  } catch (err) {
    handleAiError(res, err);
  }
}

router.post('/courses/:id/ai-teacher/sessions', requireAuth, requireRole('STUDENT'), requireActiveSubscription, async (req, res) => {
  const course = await prisma.course.findUnique({ where: { id: req.params.id } });
  if (!course) return res.status(404).json({ error: 'Course not found' });
  await startSession(req, res, { courseId: course.id, courseTitle: course.title });
});

router.post('/individual-courses/:id/ai-teacher/sessions', requireAuth, requireRole('STUDENT'), requireActiveSubscription, async (req, res) => {
  const course = await prisma.individualCourse.findFirst({ where: { id: req.params.id, studentId: req.user.id } });
  if (!course) return res.status(404).json({ error: 'Course not found' });
  await startSession(req, res, { individualCourseId: course.id, courseTitle: course.title });
});

router.get('/ai-teacher/sessions/:id', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const session = await prisma.aiTeacherSession.findUnique({
    where: { id: req.params.id },
    include: { turns: { orderBy: { createdAt: 'asc' } }, course: true, individualCourse: true },
  });
  if (!session || session.studentId !== req.user.id) return res.status(404).json({ error: 'Session not found' });
  res.json({ session: { ...session, plan: JSON.parse(session.planJson) } });
});

router.post('/ai-teacher/sessions/:id/next', requireAuth, requireRole('STUDENT'), requireActiveSubscription, async (req, res) => {
  const session = await prisma.aiTeacherSession.findUnique({ where: { id: req.params.id } });
  if (!session || session.studentId !== req.user.id) return res.status(404).json({ error: 'Session not found' });
  const plan = JSON.parse(session.planJson);
  const nextIdx = session.sectionIdx + 1;

  if (nextIdx >= plan.sections.length) {
    const updated = await prisma.aiTeacherSession.update({ where: { id: session.id }, data: { status: 'COMPLETED' } });
    return res.json({ session: updated, done: true });
  }

  const updated = await prisma.aiTeacherSession.update({
    where: { id: session.id },
    data: {
      sectionIdx: nextIdx,
      turns: { create: [{ role: 'TEACHER', type: 'SECTION', content: JSON.stringify(plan.sections[nextIdx]), sectionIdx: nextIdx }] },
    },
    include: { turns: { orderBy: { createdAt: 'asc' } } },
  });
  res.json({ session: updated, done: false });
});

router.post('/ai-teacher/sessions/:id/interrupt', requireAuth, requireRole('STUDENT'), requireActiveSubscription, async (req, res) => {
  const { question } = req.body;
  if (!question || !question.trim()) return res.status(400).json({ error: 'Type a question first.' });
  const session = await prisma.aiTeacherSession.findUnique({
    where: { id: req.params.id },
    include: { course: true, individualCourse: true },
  });
  if (!session || session.studentId !== req.user.id) return res.status(404).json({ error: 'Session not found' });
  const plan = JSON.parse(session.planJson);
  const section = plan.sections[session.sectionIdx];

  try {
    const { answer } = await aiTeacher.answerInterrupt({
      courseTitle: courseTitleOf(session),
      topic: session.topic,
      sectionTitle: section.title,
      question,
    });
    await prisma.aiTeacherTurn.createMany({
      data: [
        { sessionId: session.id, role: 'STUDENT', type: 'INTERRUPT_QUESTION', content: question, sectionIdx: session.sectionIdx },
        { sessionId: session.id, role: 'TEACHER', type: 'INTERRUPT_ANSWER', content: answer, sectionIdx: session.sectionIdx },
      ],
    });
    res.json({ answer });
  } catch (err) {
    handleAiError(res, err);
  }
});

router.post('/ai-teacher/sessions/:id/check-answer', requireAuth, requireRole('STUDENT'), requireActiveSubscription, async (req, res) => {
  const { answer } = req.body;
  if (!answer || !answer.trim()) return res.status(400).json({ error: 'Type an answer first.' });
  const session = await prisma.aiTeacherSession.findUnique({ where: { id: req.params.id } });
  if (!session || session.studentId !== req.user.id) return res.status(404).json({ error: 'Session not found' });
  const plan = JSON.parse(session.planJson);
  const section = plan.sections[session.sectionIdx];
  if (!section.checkQuestion) return res.status(400).json({ error: 'This section has no check question.' });

  try {
    const result = await aiTeacher.gradeCheckAnswer({ checkQuestion: section.checkQuestion, studentAnswer: answer });
    await prisma.aiTeacherTurn.createMany({
      data: [
        { sessionId: session.id, role: 'STUDENT', type: 'CHECK_ANSWER', content: answer, sectionIdx: session.sectionIdx },
        { sessionId: session.id, role: 'TEACHER', type: 'FEEDBACK', content: JSON.stringify(result), sectionIdx: session.sectionIdx },
      ],
    });
    res.json(result);
  } catch (err) {
    handleAiError(res, err);
  }
});

router.post('/ai-teacher/sessions/:id/avatar', requireAuth, requireRole('STUDENT'), requireActiveSubscription, async (req, res) => {
  try {
    const data = await simli.startSession();
    res.json(data);
  } catch (err) {
    handleAiError(res, err);
  }
});

module.exports = router;
