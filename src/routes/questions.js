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
  if (req.user.role === 'STUDENT' && review.length && req.body.mode === 'daily') {
    try {
      await prisma.activityLog.create({ data: { userId: req.user.id, action: 'DAILY_CHALLENGE', detail: JSON.stringify({ title: String(req.body.label || 'Daily Challenge').slice(0, 120), score, total: review.length }) } });
    } catch { /* the result still shows */ }
  }
  res.json({ score, total: review.length, review, points });
});

// The Daily Challenge: a short timed set from the question bank, one course at a time, every day. This says what is
// on offer today (the student's own courses that have questions, or the general subjects when none do), what has
// been done today, the streak, the points and the last few results.
router.get('/daily', async (req, res) => {
  if (req.user.role !== 'STUDENT') return res.status(403).json({ error: 'The Daily Challenge is for students.' });
  const mine = [];
  if (req.user.schoolId) {
    const rows = await prisma.enrollment.findMany({ where: { studentId: req.user.id }, select: { course: { select: { id: true, code: true, title: true, department: { select: { schoolId: true } } } } } });
    rows.filter((r) => r.course.department.schoolId === req.user.schoolId).forEach((r) => mine.push({ kind: 'school', id: r.course.id, title: `${r.course.code} — ${r.course.title}` }));
  }
  (await prisma.individualCourse.findMany({ where: { studentId: req.user.id }, select: { id: true, title: true } })).forEach((c) => mine.push({ kind: 'self', id: c.id, title: c.title }));
  const counts = await Promise.all(mine.map((c) => prisma.platformQuestion.count({ where: { active: true, generated: true, ...(c.kind === 'school' ? { courseId: c.id } : { individualCourseId: c.id }) } })));
  let sources = mine.map((c, i) => ({ ...c, count: counts[i] })).filter((c) => c.count > 0);
  if (!sources.length) {
    const rows = await prisma.platformQuestion.groupBy({ by: ['subject'], where: { active: true, generated: false }, _count: { _all: true }, orderBy: { subject: 'asc' } });
    sources = rows.slice(0, 6).map((r) => ({ kind: 'subject', id: r.subject, title: r.subject, count: r._count._all }));
  }
  const dayStart = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const today = dayStart(new Date());
  const weekAgo = new Date(today.getTime() - 6 * 86400000);
  const logs = await prisma.activityLog.findMany({ where: { userId: req.user.id, action: 'DAILY_CHALLENGE', createdAt: { gte: weekAgo } }, orderBy: { createdAt: 'desc' }, take: 200 });
  const parsed = logs.map((l) => { let d = {}; try { d = JSON.parse(l.detail || '{}'); } catch { d = {}; } return { title: d.title || 'Daily Challenge', score: d.score || 0, total: d.total || 0, at: l.createdAt }; });
  const doneToday = new Set(parsed.filter((l) => l.at >= today).map((l) => l.title));
  sources = sources.map((c) => ({ ...c, done: doneToday.has(c.title) }));
  const stats = await prisma.userStats.findUnique({ where: { userId: req.user.id } });
  const streakDays = new Set();
  parsed.forEach((l) => streakDays.add(dayStart(l.at).getTime()));
  if (stats && stats.lastActivityDate && stats.currentStreak > 0) {
    for (let i = 0; i < stats.currentStreak && i < 7; i++) streakDays.add(dayStart(new Date(stats.lastActivityDate).getTime() - i * 86400000).getTime());
  }
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    days.push({ label: 'SMTWTFS'[d.getDay()], name: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][d.getDay()], done: streakDays.has(d.getTime()), today: i === 0 });
  }
  res.json({
    sources,
    goal: Math.min(5, sources.length),
    done: sources.filter((c) => c.done).length,
    streak: stats ? stats.currentStreak : 0,
    points: stats ? stats.points : 0,
    days,
    history: parsed.slice(0, 15),
  });
});

module.exports = router;
