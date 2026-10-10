const express = require('express');
const prisma = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { requireActiveSubscription, isEnforced, requireAiCredits, recordAiUsage, getAiCreditStatus } = require('../subscription');
const aiTeacher = require('../services/aiTeacher.service');
const simli = require('../services/simli.service');
const { loadCourse } = require('../scope');
const { getSubscriptionStatus } = require('../subscription');
const { aiGuard } = require('../aiGuard');

const fs = require('fs');
const path = require('path');
const router = express.Router();

function handleAiError(res, err) {
  if (err.code === 'AI_NOT_CONFIGURED' || err.code === 'SIMLI_NOT_CONFIGURED') {
    return res.status(503).json({ error: err.message, code: err.code });
  }
  return res.status(502).json({ error: err.message || 'The AI Lecturer had trouble responding. Please try again.' });
}

function courseTitleOf(session) {
  return session.course?.title || session.individualCourse?.title || session.topic;
}

router.get('/config', requireAuth, async (req, res) => {
  const aiCredits = req.user.role === 'STUDENT' ? await getAiCreditStatus(req.user.id) : null;
  res.json({ aiConfigured: aiTeacher.isConfigured(), avatarConfigured: simli.isConfigured(), subscriptionEnforced: isEnforced(), aiCredits });
});

async function startSession(req, res, { courseId, individualCourseId, courseTitle }) {
  const { topic } = req.body;
  if (!topic || !topic.trim()) return res.status(400).json({ error: 'Tell the AI Lecturer what topic to cover.' });

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

router.post('/courses/:id/ai-teacher/sessions', requireAuth, requireRole('STUDENT'), aiGuard, loadCourse(), requireActiveSubscription, async (req, res) => {
  const course = req.course;
  await startSession(req, res, { courseId: course.id, courseTitle: course.title });
});

router.post('/individual-courses/:id/ai-teacher/sessions', requireAuth, requireRole('STUDENT'), aiGuard, requireActiveSubscription, async (req, res) => {
  const course = await prisma.individualCourse.findFirst({ where: { id: req.params.id, studentId: req.user.id } });
  if (!course) return res.status(404).json({ error: 'Course not found' });
  await startSession(req, res, { individualCourseId: course.id, courseTitle: course.title });
});

// The pre-recorded lectures the system's AI Lecturer made for a student's courses (the ones listed inside each course): the
// place a student falls back to when their live AI minutes or coins have run out.
router.get('/ai-teacher/prerecorded', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const out = [];
  const school = [];
  if (req.user.schoolId) {
    const rows = await prisma.enrollment.findMany({ where: { studentId: req.user.id }, select: { course: { select: { id: true, code: true, title: true, department: { select: { schoolId: true } } } } } });
    rows.filter((r) => r.course.department.schoolId === req.user.schoolId).forEach((r) => school.push(r.course));
  }
  const own = await prisma.individualCourse.findMany({ where: { studentId: req.user.id }, select: { id: true, title: true } });
  const [schoolLessons, ownLessons] = await Promise.all([
    school.length ? prisma.lesson.findMany({ where: { courseId: { in: school.map((c) => c.id) }, isAiTeacher: true }, orderBy: [{ courseId: 'asc' }, { order: 'asc' }] }) : [],
    own.length ? prisma.lesson.findMany({ where: { individualCourseId: { in: own.map((c) => c.id) } }, orderBy: [{ individualCourseId: 'asc' }, { order: 'asc' }] }) : [],
  ]);
  const titleOf = new Map([...school.map((c) => [c.id, `${c.code} — ${c.title}`]), ...own.map((c) => [c.id, c.title])]);
  const sub = isEnforced() ? await getSubscriptionStatus(req.user.id) : { active: true };
  for (const l of [...schoolLessons, ...ownLessons]) {
    out.push({ id: l.id, title: l.title, order: l.order, createdAt: l.createdAt, courseId: l.courseId, individualCourseId: l.individualCourseId, courseTitle: titleOf.get(l.courseId || l.individualCourseId) || '', locked: !sub.active, script: sub.active ? l.script : null });
  }
  res.json({ lessons: out });
});

// The video of an AI live class, sent by the student's browser in pieces while the class goes on (so nothing is lost if the
// page is closed). Each sitting is its own file; the list of them is kept with the session's plan.
const AI_REC_DIR = path.join(__dirname, '..', '..', 'uploads', 'ai');
const lastPiece = new Map();
const pieceBody = express.raw({ type: () => true, limit: '25mb' });
router.post('/ai-teacher/sessions/:id/recording/chunk', requireAuth, requireRole('STUDENT'), pieceBody, async (req, res) => {
  const session = await prisma.aiTeacherSession.findFirst({ where: { id: req.params.id, studentId: req.user.id } });
  if (!session) return res.status(404).json({ error: 'Class not found' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Empty recording piece.' });
  const rid = String(req.query.rid || '').replace(/[^0-9]/g, '').slice(0, 15) || String(Date.now());
  const seq = parseInt(req.query.seq, 10);
  const key = `${session.id}:${rid}`;
  if (Number.isFinite(seq) && seq <= (lastPiece.get(key) ?? -1)) return res.json({ ok: true, duplicate: true });
  fs.mkdirSync(AI_REC_DIR, { recursive: true });
  await fs.promises.appendFile(path.join(AI_REC_DIR, `${session.id}-${rid}.webm`), req.body);
  if (Number.isFinite(seq)) lastPiece.set(key, seq);
  let plan = {};
  try { plan = JSON.parse(session.planJson); } catch { plan = {}; }
  const url = `/uploads/ai/${session.id}-${rid}.webm`;
  plan.recordings = Array.isArray(plan.recordings) ? plan.recordings : [];
  if (!plan.recordings.some((r) => r.url === url)) {
    plan.recordings.push({ url, at: new Date().toISOString() });
    await prisma.aiTeacherSession.update({ where: { id: session.id }, data: { planJson: JSON.stringify(plan) } });
  }
  res.json({ ok: true });
});

// Every AI Lecturer class this student has had, with its notes, so it can be looked at again or downloaded.
router.get('/ai-teacher/my-sessions', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const rows = await prisma.aiTeacherSession.findMany({
    where: { studentId: req.user.id },
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: { course: { select: { code: true, title: true } }, individualCourse: { select: { title: true } } },
  });
  res.json({
    sessions: rows.map((r) => {
      let plan = {};
      try { plan = JSON.parse(r.planJson); } catch { plan = {}; }
      return {
        id: r.id, topic: r.topic, status: r.status, createdAt: r.createdAt, isIndividual: !!r.individualCourseId,
        recordings: Array.isArray(plan.recordings) ? plan.recordings : [],
        course: r.course ? `${r.course.code} — ${r.course.title}` : (r.individualCourse ? r.individualCourse.title : ''),
        title: plan.title || r.topic,
        sections: (plan.sections || []).map((x) => ({ title: x.title, boardText: x.boardText, speechText: x.speechText })),
      };
    }),
  });
});

router.get('/ai-teacher/sessions/:id', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const session = await prisma.aiTeacherSession.findUnique({
    where: { id: req.params.id },
    include: { turns: { orderBy: { createdAt: 'asc' } }, course: true, individualCourse: true },
  });
  if (!session || session.studentId !== req.user.id) return res.status(404).json({ error: 'Session not found' });
  res.json({ session: { ...session, plan: JSON.parse(session.planJson) } });
});

router.post('/ai-teacher/sessions/:id/next', requireAuth, requireRole('STUDENT'), aiGuard, requireActiveSubscription, async (req, res) => {
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

router.post('/ai-teacher/sessions/:id/interrupt', requireAuth, requireRole('STUDENT'), aiGuard, requireActiveSubscription, async (req, res) => {
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
    const { answer, boardActions } = await aiTeacher.answerInterrupt({
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
    res.json({ answer, boardActions });
  } catch (err) {
    handleAiError(res, err);
  }
});

router.post('/ai-teacher/sessions/:id/check-answer', requireAuth, requireRole('STUDENT'), aiGuard, requireActiveSubscription, async (req, res) => {
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

// Not session-scoped -- it's the same subscription-gated Simli session regardless of
// whether the avatar is being connected for a live session or a pre-recorded lesson.
// Also gated on AI credits: connecting the avatar is the entry point to using it, so
// a student with zero minutes left this cycle shouldn't even be able to open it.
// Mints a fresh short-lived Simli session token per connect -- the raw Simli API key
// never reaches the browser.
router.post('/ai-teacher/avatar-config', requireAuth, requireRole('STUDENT'), aiGuard, requireActiveSubscription, requireAiCredits, async (req, res) => {
  try {
    const sessionToken = await simli.createSessionToken();
    res.json({ sessionToken });
  } catch (err) {
    handleAiError(res, err);
  }
});

// Text -> speech for the avatar to lip-sync to. Returns base64 PCM16 audio (resampled
// to the 16kHz Simli's SDK expects) the browser feeds into SimliClient.sendAudioData()
// in chunks. The generated audio's own duration is what actually debits the AI credit
// bank -- usage tracks real speech produced, not request count.
router.post('/ai-teacher/tts', requireAuth, requireRole('STUDENT'), aiGuard, requireActiveSubscription, requireAiCredits, async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'No text to speak.' });
  try {
    const audio = await aiTeacher.synthesizeSpeech(text);
    const resampled = aiTeacher.resamplePcm16(Buffer.from(audio.data, 'base64'), audio.sampleRate || 24000, 16000);
    const seconds = resampled.length / (16000 * 2);
    await recordAiUsage(req.user.id, seconds);
    res.json({ data: resampled.toString('base64'), mimeType: audio.mimeType, sampleRate: 16000 });
  } catch (err) {
    handleAiError(res, err);
  }
});

module.exports = router;
