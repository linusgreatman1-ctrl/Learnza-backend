const express = require('express');
const prisma = require('../db');
const { requireAuth, requireRole } = require('../auth');
const autoGen = require('../services/individualAutoGen.service');
const labDemo = require('../services/labDemo.service');
const { requireActiveSubscription, getSubscriptionStatus, isEnforced } = require('../subscription');

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
  // Fire-and-forget, not awaited: starts generating the pre-recorded lessons (plus the
  // usual assignment/test/mock/exam) right away instead of waiting for the student to
  // first open the course, without making course creation itself wait on several AI
  // calls. ensureAutoContentForCourse already no-ops per-item if something's not due
  // yet, so calling it again moments later (e.g. from the lessons/assessments GET
  // routes) is harmless.
  autoGen.ensureAutoContentForCourse(course, req.user.id).catch(() => {});
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
// set these, and the student never triggers generation themselves either: the app
// auto-generates a fresh assignment daily, a test weekly, and a semester exam roughly
// once a term (individualAutoGen.service.js), ensured lazily right here. Taking/
// scoring/review-mistakes reuse the exact same generic /assessments/:id/* endpoints
// school courses use.
router.get('/individual-courses/:id/assessments', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const course = await prisma.individualCourse.findFirst({ where: { id: req.params.id, studentId: req.user.id } });
  if (!course) return res.status(404).json({ error: 'Course not found' });
  await autoGen.ensureAutoContentForCourse(course, req.user.id).catch(() => {});
  const assessments = await prisma.assessment.findMany({
    where: { individualCourseId: course.id },
    include: { _count: { select: { questions: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ assessments });
});

// Pre-recorded (AI-narrated) lessons for a self-directed course -- the individual-
// learner equivalent of a school course's lecturer-uploaded Lessons list, except
// every one is AI-generated (there's no lecturer to upload a real video). Generated
// as a one-time starter batch right when the course is created (see POST above),
// with this as a lazy fallback in case that never ran. Same subscription-lock shape
// as the school lessons route, for consistency.
router.get('/individual-courses/:id/lessons', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const course = await prisma.individualCourse.findFirst({ where: { id: req.params.id, studentId: req.user.id } });
  if (!course) return res.status(404).json({ error: 'Course not found' });
  await autoGen.ensureAutoContentForCourse(course, req.user.id).catch(() => {});
  const lessons = await prisma.lesson.findMany({
    where: { individualCourseId: course.id },
    orderBy: { order: 'asc' },
  });
  if (!isEnforced()) return res.json({ lessons: lessons.map((l) => ({ ...l, locked: false })) });
  const { active } = await getSubscriptionStatus(req.user.id);
  if (active) return res.json({ lessons: lessons.map((l) => ({ ...l, locked: false })) });
  res.json({ lessons: lessons.map((l) => { const { script, videoUrl, ...rest } = l; return { ...rest, locked: true }; }) });
});

// Digital Lab for a self-directed course -- same AI-generated-practical engine as a
// school course's lab, just scoped to individualCourseId instead of courseId. No
// curated/lecturer-authored practicals here (there's no lecturer), only AI-generated
// ones, gated by the same subscription check.
function shapeDemo(demo) {
  return { ...demo, steps: JSON.parse(demo.stepsJson) };
}

router.get('/individual-courses/:id/lab', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const course = await prisma.individualCourse.findFirst({ where: { id: req.params.id, studentId: req.user.id } });
  if (!course) return res.status(404).json({ error: 'Course not found' });
  const demos = await prisma.labDemonstration.findMany({
    where: { individualCourseId: course.id, status: 'APPROVED' },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ demonstrations: demos.map(shapeDemo) });
});

router.post('/individual-courses/:id/lab/generate', requireAuth, requireRole('STUDENT'), requireActiveSubscription, async (req, res) => {
  const { topic } = req.body;
  if (!topic || !topic.trim()) return res.status(400).json({ error: 'Describe the practical topic first.' });
  const course = await prisma.individualCourse.findFirst({ where: { id: req.params.id, studentId: req.user.id } });
  if (!course) return res.status(404).json({ error: 'Course not found' });

  try {
    const draft = await labDemo.generateDemonstration({ courseTitle: course.title, topic });
    const demo = await prisma.labDemonstration.create({
      data: {
        individualCourseId: course.id,
        title: draft.title,
        description: draft.description,
        stepsJson: JSON.stringify(draft.steps),
        source: 'AI_GENERATED',
        status: 'APPROVED',
        authorId: req.user.id,
      },
    });
    res.json({ demonstration: shapeDemo(demo) });
  } catch (err) {
    if (err.code === 'AI_NOT_CONFIGURED') return res.status(503).json({ error: err.message, code: err.code });
    res.status(502).json({ error: 'Could not generate that demonstration. Please try again.' });
  }
});

// Study Groups for a self-directed course -- the same group/chat engine a school
// course's Study Groups uses, scoped to individualCourseId. An individual learner has
// no automatic classmates, but can still share the group with a study partner (joining
// a group by id has never required course enrollment -- same as school courses today).
router.get('/individual-courses/:id/groups', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const course = await prisma.individualCourse.findFirst({ where: { id: req.params.id, studentId: req.user.id } });
  if (!course) return res.status(404).json({ error: 'Course not found' });
  const groups = await prisma.studyGroup.findMany({
    where: { individualCourseId: course.id },
    include: { _count: { select: { members: true } } },
  });
  res.json({ groups });
});

router.post('/individual-courses/:id/groups', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Group name is required' });
  const course = await prisma.individualCourse.findFirst({ where: { id: req.params.id, studentId: req.user.id } });
  if (!course) return res.status(404).json({ error: 'Course not found' });
  const group = await prisma.studyGroup.create({
    data: { individualCourseId: course.id, name, creatorId: req.user.id },
  });
  await prisma.groupMembership.create({ data: { groupId: group.id, studentId: req.user.id } });
  res.json({ group });
});

module.exports = router;
