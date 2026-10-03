const express = require('express');
const prisma = require('../db');
const { requireAuth, requireRole, logActivity } = require('../auth');
const { requireActiveSubscription } = require('../subscription');
const labDemo = require('../services/labDemo.service');
const ai = require('../services/aiProvider.service');
const { aiGuard, aiDailyLimit, logAiConversation } = require('../aiGuard');
const { loadCourse, hasSchool } = require('../scope');

// A practical is visible to the school that owns its course, or to the independent learner
// whose own course it belongs to -- nobody else.
function loadDemo() {
  return async (req, res, next) => {
    const demo = await prisma.labDemonstration.findUnique({
      where: { id: req.params.id },
      include: {
        course: { select: { department: { select: { schoolId: true } } } },
        individualCourse: { select: { studentId: true } },
      },
    });
    const ok = demo && (demo.courseId
      ? hasSchool(req.user) && demo.course.department.schoolId === req.user.schoolId
      : demo.individualCourse && req.user.role === 'STUDENT' && demo.individualCourse.studentId === req.user.id);
    if (!ok) return res.status(404).json({ error: 'Practical not found' });
    req.demo = demo;
    next();
  };
}

const router = express.Router();

function shape(demo) {
  return { ...demo, steps: JSON.parse(demo.stepsJson) };
}

// Every approved demonstration for a course -- curated and AI-generated alike are
// visible immediately (AI generation is gated by subscription, not admin review).
router.get('/courses/:id/lab', requireAuth, loadCourse(), async (req, res) => {
  const demos = await prisma.labDemonstration.findMany({
    where: { courseId: req.course.id, status: 'APPROVED' },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ demonstrations: demos.map(shape) });
});

// Lecturer/admin-authored demonstrations are trusted content -- approved immediately.
router.post('/courses/:id/lab', requireAuth, requireRole('LECTURER', 'ADMIN'), loadCourse(), async (req, res) => {
  const { title, description, steps } = req.body;
  if (!title || !Array.isArray(steps) || steps.length === 0) {
    return res.status(400).json({ error: 'Title and at least one step are required.' });
  }
  const demo = await prisma.labDemonstration.create({
    data: {
      courseId: req.course.id,
      title,
      description: description || '',
      stepsJson: JSON.stringify(steps),
      source: 'CURATED',
      status: 'APPROVED',
      authorId: req.user.id,
    },
  });
  if (req.user.role === 'LECTURER') await logActivity(req.user.id, 'CREATE_LAB_DEMO', title);
  res.json({ demonstration: shape(demo) });
});

// Any subscribed student can request a practical on a topic not yet covered -- the AI
// drafts it and it's live immediately, gated only by having an active subscription
// (no admin review step).
router.post('/courses/:id/lab/generate', requireAuth, requireRole('STUDENT'), loadCourse(), aiGuard, requireActiveSubscription, async (req, res) => {
  const { topic } = req.body;
  if (!topic || !topic.trim()) return res.status(400).json({ error: 'Describe the practical topic first.' });
  const course = req.course;

  try {
    const draft = await labDemo.generateDemonstration({ courseTitle: course.title, topic });
    const demo = await prisma.labDemonstration.create({
      data: {
        courseId: course.id,
        title: draft.title,
        description: draft.description,
        stepsJson: JSON.stringify(draft.steps),
        source: 'AI_GENERATED',
        status: 'APPROVED',
        authorId: req.user.id,
      },
    });
    res.json({ demonstration: shape(demo) });
  } catch (err) {
    if (err.code === 'AI_NOT_CONFIGURED') return res.status(503).json({ error: err.message, code: err.code });
    res.status(502).json({ error: 'Could not generate that demonstration. Please try again.' });
  }
});

// "Got a question" for a practical -- same subscription gate as generating one,
// answered with the practical's own content as context so it stays on-topic.
router.post('/lab/:id/ask', requireAuth, aiGuard, loadDemo(), requireActiveSubscription, aiDailyLimit, async (req, res) => {
  const { question } = req.body;
  if (!question || !question.trim()) return res.status(400).json({ error: 'Type a question first.' });
  const demo = req.demo;

  const steps = JSON.parse(demo.stepsJson).map((s, i) => `${i + 1}. ${s.title}: ${s.instruction}`).join('\n');
  const systemPrompt = `You are the AI teacher guiding a student through a science/lab practical called "${demo.title}". Description: ${demo.description}\nSteps:\n${steps}\nAnswer the student's question about this practical clearly and briefly (2-4 sentences), staying on topic.`;
  try {
    const answer = await ai.askForText(systemPrompt, question.trim());
    await logAiConversation(req.user.id, 'LAB', question.trim(), answer);
    // Structured the same way AI Teacher's interrupt answers are, so the frontend can
    // always render the answer onto the board rather than only in the chat log.
    res.json({ answer, boardActions: [{ type: 'TEXT', content: answer }] });
  } catch (err) {
    if (err.code === 'AI_NOT_CONFIGURED') return res.status(503).json({ error: err.message, code: err.code });
    res.status(502).json({ error: 'Could not answer that right now. Please try again.' });
  }
});

// Logged once a student actually starts a guided practical (renderLabTeach calls this
// right when narration begins, same moment "Got a question" unlocks) -- re-doing the
// same practical just refreshes startedAt rather than piling up duplicate rows, so
// admin's view always shows one row per student per practical: who did it, and when.
router.post('/lab/:id/attempt', requireAuth, requireRole('STUDENT'), loadDemo(), async (req, res) => {
  const demo = req.demo;
  await prisma.labAttempt.upsert({
    where: { demoId_studentId: { demoId: demo.id, studentId: req.user.id } },
    create: { demoId: demo.id, studentId: req.user.id },
    update: { startedAt: new Date() },
  });
  res.json({ ok: true });
});

// Read-only records of all lab activity for the school -- there's no approval step
// to action here any more, just visibility into what's been curated vs AI-generated,
// plus which students actually did each practical.
router.get('/admin/lab', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const demos = await prisma.labDemonstration.findMany({
    where: { course: { department: { schoolId: req.user.schoolId } } },
    include: {
      course: { select: { code: true, title: true } },
      author: { select: { fullName: true } },
      attempts: {
        include: { student: { select: { fullName: true, matricNumber: true } } },
        orderBy: { startedAt: 'desc' },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ demonstrations: demos.map(shape) });
});

module.exports = router;
