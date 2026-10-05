const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../auth');
const gamification = require('../services/gamification.service');

// Practice from the platform's question bank (curated in the admin panel). Open to every
// signed-in person; the correct answers stay on the server until a set is submitted.
const router = express.Router();
router.use(requireAuth);

router.get('/subjects', async (req, res) => {
  const rows = await prisma.platformQuestion.groupBy({ by: ['subject'], where: { active: true, generated: false }, _count: { _all: true }, orderBy: { subject: 'asc' } });
  res.json({ subjects: rows.map((r) => ({ subject: r.subject, count: r._count._all })) });
});

// The courses on the student's dashboard that have practice questions written for them.
router.get('/my-courses', async (req, res) => {
  const mine = [];
  if (req.user.schoolId) {
    const rows = await prisma.enrollment.findMany({ where: { studentId: req.user.id }, select: { course: { select: { id: true, code: true, title: true, department: { select: { schoolId: true } } } } } });
    rows.filter((r) => r.course.department.schoolId === req.user.schoolId).forEach((r) => mine.push({ kind: 'school', id: r.course.id, title: `${r.course.code} — ${r.course.title}` }));
  }
  (await prisma.individualCourse.findMany({ where: { studentId: req.user.id }, select: { id: true, title: true } })).forEach((c) => mine.push({ kind: 'self', id: c.id, title: c.title }));
  const counts = await Promise.all(mine.map((c) => prisma.platformQuestion.count({ where: { active: true, generated: true, ...(c.kind === 'school' ? { courseId: c.id } : { individualCourseId: c.id }) } })));
  res.json({ courses: mine.map((c, i) => ({ ...c, count: counts[i] })) });
});

router.get('/practice', async (req, res) => {
  const subject = String(req.query.subject || '').trim();
  const courseId = String(req.query.courseId || '');
  const selfCourseId = String(req.query.individualCourseId || '');
  let filter;
  let heading = subject;
  if (courseId || selfCourseId) {
    // A course on the student's own dashboard: they must be enrolled in it / own it.
    if (courseId) {
      const enrolled = req.user.schoolId && (await prisma.enrollment.findFirst({ where: { studentId: req.user.id, courseId, course: { department: { schoolId: req.user.schoolId } } }, select: { id: true, course: { select: { code: true, title: true } } } }));
      if (!enrolled) return res.status(404).json({ error: 'Course not found.' });
      filter = { courseId, generated: true };
      heading = `${enrolled.course.code} — ${enrolled.course.title}`;
    } else {
      const own = await prisma.individualCourse.findFirst({ where: { id: selfCourseId, studentId: req.user.id }, select: { title: true } });
      if (!own) return res.status(404).json({ error: 'Course not found.' });
      filter = { individualCourseId: selfCourseId, generated: true };
      heading = own.title;
    }
  } else {
    if (!subject) return res.status(400).json({ error: 'Choose a subject.' });
    filter = { subject, generated: false };
  }
  const count = Math.min(30, Math.max(5, parseInt(req.query.count, 10) || 20));
  const ids = (await prisma.platformQuestion.findMany({ where: { ...filter, active: true }, select: { id: true } })).map((q) => q.id);
  if (!ids.length) return res.status(404).json({ error: courseId || selfCourseId ? 'Your questions for this course are still being prepared. Try again in a minute.' : 'There are no questions for that subject yet.' });
  // Fisher–Yates on the id list, then take the first `count`.
  for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
  const picked = await prisma.platformQuestion.findMany({ where: { id: { in: ids.slice(0, count) } } });
  picked.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  res.json({
    subject: heading,
    questions: picked.map((q) => ({ id: q.id, text: q.text, options: JSON.parse(q.options), topic: q.topic, year: q.year, source: q.source })),
  });
});

router.post('/check', async (req, res) => {
  const answers = Array.isArray(req.body.answers) ? req.body.answers.slice(0, 50) : [];
  if (!answers.length) return res.status(400).json({ error: 'No answers to check.' });
  let questions = await prisma.platformQuestion.findMany({ where: { id: { in: answers.map((a) => String(a.id)) } } });
  // Questions written for a course can only be checked by someone on that course.
  const courseIds = [...new Set(questions.filter((q) => q.courseId).map((q) => q.courseId))];
  const selfIds = [...new Set(questions.filter((q) => q.individualCourseId).map((q) => q.individualCourseId))];
  const [mine, own] = await Promise.all([
    courseIds.length ? prisma.enrollment.findMany({ where: { studentId: req.user.id, courseId: { in: courseIds } }, select: { courseId: true } }) : [],
    selfIds.length ? prisma.individualCourse.findMany({ where: { studentId: req.user.id, id: { in: selfIds } }, select: { id: true } }) : [],
  ]);
  const okCourses = new Set(mine.map((m) => m.courseId)), okSelf = new Set(own.map((o) => o.id));
  questions = questions.filter((q) => (!q.courseId || okCourses.has(q.courseId)) && (!q.individualCourseId || okSelf.has(q.individualCourseId)));
  const byId = new Map(questions.map((q) => [q.id, q]));
  let score = 0;
  const review = answers.filter((a) => byId.has(String(a.id))).map((a) => {
    const q = byId.get(String(a.id));
    const correct = Number(a.choice) === q.correctIndex;
    if (correct) score += 1;
    return { id: q.id, text: q.text, options: JSON.parse(q.options), choice: a.choice == null ? null : Number(a.choice), correctIndex: q.correctIndex, correct, explanation: q.explanation };
  });
  let points = 0;
  if (req.user.role === 'STUDENT' && review.length) {
    try { points = (await gamification.recordAssessmentCompletion(req.user.id, score, review.length)).pointsEarned || 0; } catch { /* practice still counts without points */ }
  }
  res.json({ score, total: review.length, review, points });
});

module.exports = router;
