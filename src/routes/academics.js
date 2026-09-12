const express = require('express');
const prisma = require('../db');
const { requireAuth, requireRole, logActivity } = require('../auth');
const { getSubscriptionStatus, isEnforced } = require('../subscription');

const router = express.Router();

router.get('/schools', async (req, res) => {
  const schools = await prisma.school.findMany();
  res.json({ schools });
});

router.get('/departments', async (req, res) => {
  const { schoolId } = req.query;
  const departments = await prisma.department.findMany({
    where: schoolId ? { schoolId } : undefined,
    orderBy: { name: 'asc' },
  });
  res.json({ departments });
});

router.get('/departments/:id/courses', async (req, res) => {
  const courses = await prisma.course.findMany({
    where: { departmentId: req.params.id },
    orderBy: [{ level: 'asc' }, { code: 'asc' }],
  });
  res.json({ courses });
});

router.get('/courses/:id', async (req, res) => {
  const course = await prisma.course.findUnique({
    where: { id: req.params.id },
    include: { department: true },
  });
  if (!course) return res.status(404).json({ error: 'Course not found' });
  res.json({ course });
});

// Student: my enrolled courses
router.get('/students/me/courses', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const enrollments = await prisma.enrollment.findMany({
    where: { studentId: req.user.id },
    include: { course: { include: { department: true } } },
  });
  res.json({ courses: enrollments.map((e) => e.course) });
});

router.post('/courses/:id/enroll', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const courseId = req.params.id;
  const existing = await prisma.enrollment.findUnique({
    where: { studentId_courseId: { studentId: req.user.id, courseId } },
  });
  if (existing) return res.json({ ok: true, alreadyEnrolled: true });
  await prisma.enrollment.create({ data: { studentId: req.user.id, courseId } });
  res.json({ ok: true });
});

// Lessons (AI-teacher narrated or lecturer recorded)
// AI Teacher narration and lecturer-recorded video are paid features -- students can
// always see what lessons exist, but the actual content (script/videoUrl) is stripped
// unless they have an active subscription. Lecturers/admins always see everything.
router.get('/courses/:id/lessons', requireAuth, async (req, res) => {
  const lessons = await prisma.lesson.findMany({
    where: { courseId: req.params.id },
    orderBy: { order: 'asc' },
  });

  if (req.user.role !== 'STUDENT' || !isEnforced()) return res.json({ lessons: lessons.map((l) => ({ ...l, locked: false })) });

  const { active } = await getSubscriptionStatus(req.user.id);
  const shaped = lessons.map((l) => {
    if (active) return { ...l, locked: false };
    const { script, videoUrl, ...rest } = l;
    return { ...rest, locked: true };
  });
  res.json({ lessons: shaped });
});

router.post('/courses/:id/lessons', requireAuth, requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  const { title, script, videoUrl, order, isAiTeacher } = req.body;
  if (!title || !script) return res.status(400).json({ error: 'Title and script are required' });
  const lesson = await prisma.lesson.create({
    data: {
      courseId: req.params.id,
      title,
      script,
      videoUrl: videoUrl || null,
      order: order || 0,
      isAiTeacher: isAiTeacher !== false,
      authorId: req.user.id,
    },
  });
  if (req.user.role === 'LECTURER') await logActivity(req.user.id, 'CREATE_LESSON', title);
  res.json({ lesson });
});

router.delete('/lessons/:id', requireAuth, requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  await prisma.lesson.delete({ where: { id: req.params.id } });
  if (req.user.role === 'LECTURER') await logActivity(req.user.id, 'DELETE_LESSON', req.params.id);
  res.json({ ok: true });
});

module.exports = router;
