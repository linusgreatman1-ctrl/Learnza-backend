const express = require('express');
const crypto = require('crypto');
const prisma = require('../db');
const { logAction } = require('../audit');
const { generateAccessCode } = require('../utils');
const { computeAcademicRecord } = require('./records');
const { notifyMany } = require('../services/notification.service');
const bulkMessage = require('../services/bulkMessage.service');

// The owner's read/oversight views across every school: analytics, lessons, courses,
// demonstrations, attendance, results, teachers, academic records, system logs, access codes,
// the platform question bank, and targeted bulk email/SMS. Mounted inside routes/super.js, so
// everything here is already behind "signed in as SUPER_ADMIN".
const router = express.Router();

const pageOf = (req, size = 40) => ({ page: Math.max(1, parseInt(req.query.page, 10) || 1), size });
const school = { select: { id: true, name: true } };
const INTERNAL = /@internal\.learnza\.local$/;
const cleanEmail = (e) => (INTERNAL.test(e || '') ? null : e);

// ---------------------------------------------------------------- analytics
function dayKey(d) { return new Date(d).toISOString().slice(0, 10); }

router.get('/analytics', async (req, res) => {
  const days = Math.min(180, Math.max(7, parseInt(req.query.days, 10) || 30));
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - (days - 1));

  const [signups, signIns, revenue, coinRevenue, ai, submissions, live, usersByRole, topSchools, tickets] = await Promise.all([
    prisma.$queryRaw`SELECT date_trunc('day', "createdAt") AS d, ("schoolId" IS NOT NULL) AS school, count(*)::int AS n FROM "User" WHERE "createdAt" >= ${since} AND role <> 'SUPER_ADMIN' GROUP BY 1, 2`,
    prisma.$queryRaw`SELECT date_trunc('day', "createdAt") AS d, count(DISTINCT "userId")::int AS n FROM "RefreshToken" WHERE "createdAt" >= ${since} GROUP BY 1`,
    prisma.$queryRaw`SELECT date_trunc('day', "createdAt") AS d, COALESCE(sum("amountKobo"),0)::bigint AS n FROM "Payment" WHERE "createdAt" >= ${since} AND status = 'SUCCESS' GROUP BY 1`,
    prisma.$queryRaw`SELECT date_trunc('day', "createdAt") AS d, COALESCE(sum("amountKobo"),0)::bigint AS n FROM "CoinPurchase" WHERE "createdAt" >= ${since} AND status = 'SUCCESS' GROUP BY 1`,
    prisma.$queryRaw`SELECT date_trunc('day', "createdAt") AS d, count(*)::int AS n FROM "AiConversationLog" WHERE "createdAt" >= ${since} GROUP BY 1`,
    prisma.$queryRaw`SELECT date_trunc('day', "submittedAt") AS d, count(*)::int AS n FROM "Submission" WHERE "submittedAt" >= ${since} GROUP BY 1`,
    prisma.$queryRaw`SELECT date_trunc('day', "startedAt") AS d, count(*)::int AS n FROM "LiveClass" WHERE "startedAt" >= ${since} GROUP BY 1`,
    prisma.user.groupBy({ by: ['role'], where: { role: { not: 'SUPER_ADMIN' } }, _count: { _all: true } }),
    prisma.user.groupBy({ by: ['schoolId'], where: { schoolId: { not: null } }, _count: { _all: true }, orderBy: { _count: { schoolId: 'desc' } }, take: 8 }),
    prisma.supportTicket.groupBy({ by: ['status'], _count: { _all: true } }),
  ]);

  // Fill every day of the range so a quiet day shows as zero, not as a gap.
  const addSeries = (a, b) => a.map((v, i) => v + b[i]);
  const labels = [];
  for (let i = 0; i < days; i++) { const d = new Date(since); d.setDate(d.getDate() + i); labels.push(dayKey(d)); }
  const series = (rows, pick = () => true) => {
    const m = new Map();
    for (const r of rows || []) if (pick(r)) m.set(dayKey(r.d), (m.get(dayKey(r.d)) || 0) + Number(r.n));
    return labels.map((l) => m.get(l) || 0);
  };

  const schools = await prisma.school.findMany({ where: { id: { in: topSchools.map((t) => t.schoolId) } }, select: { id: true, name: true } });
  const names = new Map(schools.map((s) => [s.id, s.name]));
  res.json({
    days, labels,
    series: {
      schoolSignups: series(signups, (r) => r.school),
      independentSignups: series(signups, (r) => !r.school),
      activeUsers: series(signIns),
      revenueKobo: addSeries(series(revenue), series(coinRevenue)),
      aiQuestions: series(ai),
      testsSubmitted: series(submissions),
      liveClasses: series(live),
    },
    usersByRole: Object.fromEntries(usersByRole.map((r) => [r.role, r._count._all])),
    topSchools: topSchools.map((t) => ({ id: t.schoolId, name: names.get(t.schoolId) || '—', users: t._count._all })),
    tickets: Object.fromEntries(tickets.map((t) => [t.status, t._count._all])),
  });
});

// ---------------------------------------------------------------- lessons
router.get('/lessons', async (req, res) => {
  const { page, size } = pageOf(req);
  const search = String(req.query.search || '').trim();
  const where = {};
  if (search) where.title = { contains: search, mode: 'insensitive' };
  if (req.query.kind === 'ai') where.isAiTeacher = true;
  if (req.query.kind === 'recorded') where.isAiTeacher = false;
  const [total, lessons] = await Promise.all([
    prisma.lesson.count({ where }),
    prisma.lesson.findMany({
      where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * size, take: size,
      select: {
        id: true, title: true, isAiTeacher: true, videoUrl: true, createdAt: true,
        author: { select: { fullName: true } },
        course: { select: { code: true, title: true, department: { select: { school } } } },
        individualCourse: { select: { title: true, student: { select: { fullName: true } } } },
      },
    }),
  ]);
  res.json({
    total, page, pageSize: size,
    lessons: lessons.map(({ course, individualCourse, ...l }) => ({
      ...l,
      where: course ? `${course.code} · ${course.title}` : individualCourse ? `${individualCourse.title} (self-study)` : '—',
      schoolName: course && course.department.school ? course.department.school.name : null,
      owner: l.author ? l.author.fullName : individualCourse ? individualCourse.student.fullName : null,
    })),
  });
});

router.delete('/lessons/:id', async (req, res) => {
  const lesson = await prisma.lesson.findUnique({ where: { id: req.params.id } });
  if (!lesson) return res.status(404).json({ error: 'Lesson not found' });
  await prisma.lesson.delete({ where: { id: lesson.id } });
  await logAction(req, 'LESSON_REMOVED', 'Lesson', lesson.id, { title: lesson.title });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- courses
router.get('/courses', async (req, res) => {
  const { page, size } = pageOf(req);
  const search = String(req.query.search || '').trim();
  if (req.query.kind === 'self') {
    const where = search ? { title: { contains: search, mode: 'insensitive' } } : {};
    const [total, rows] = await Promise.all([
      prisma.individualCourse.count({ where }),
      prisma.individualCourse.findMany({
        where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * size, take: size,
        include: { student: { select: { fullName: true, email: true } }, _count: { select: { lessons: true, assessments: true } } },
      }),
    ]);
    return res.json({ total, page, pageSize: size, courses: rows.map((c) => ({ id: c.id, title: c.title, owner: c.student.fullName, lessons: c._count.lessons, assessments: c._count.assessments, createdAt: c.createdAt })) });
  }
  const where = {};
  if (search) where.OR = [{ title: { contains: search, mode: 'insensitive' } }, { code: { contains: search, mode: 'insensitive' } }];
  if (req.query.schoolId) where.department = { schoolId: String(req.query.schoolId) };
  const [total, rows] = await Promise.all([
    prisma.course.count({ where }),
    prisma.course.findMany({
      where, orderBy: { code: 'asc' }, skip: (page - 1) * size, take: size,
      include: {
        department: { select: { name: true, school } },
        _count: { select: { enrollments: true, lessons: true, assessments: true } },
      },
    }),
  ]);
  const lecturers = await prisma.courseLecturer.findMany({ where: { courseId: { in: rows.map((r) => r.id) } }, select: { courseId: true, lecturer: { select: { fullName: true } } } });
  const byCourse = new Map();
  lecturers.forEach((l) => byCourse.set(l.courseId, [...(byCourse.get(l.courseId) || []), l.lecturer.fullName]));
  res.json({
    total, page, pageSize: size,
    courses: rows.map((c) => ({
      id: c.id, code: c.code, title: c.title, level: c.level, department: c.department.name,
      schoolName: c.department.school ? c.department.school.name : null,
      students: c._count.enrollments, lessons: c._count.lessons, assessments: c._count.assessments,
      lecturers: byCourse.get(c.id) || [],
    })),
  });
});

// ---------------------------------------------------------------- demonstrations (digital lab)
router.get('/demonstrations', async (req, res) => {
  const { page, size } = pageOf(req);
  const where = {};
  if (['APPROVED', 'PENDING', 'REJECTED'].includes(req.query.status)) where.status = req.query.status;
  if (['CURATED', 'AI_GENERATED'].includes(req.query.source)) where.source = req.query.source;
  const [total, rows] = await Promise.all([
    prisma.labDemonstration.count({ where }),
    prisma.labDemonstration.findMany({
      where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * size, take: size,
      include: {
        author: { select: { fullName: true } },
        course: { select: { code: true, title: true, department: { select: { school } } } },
        individualCourse: { select: { title: true } },
        _count: { select: { attempts: true } },
      },
    }),
  ]);
  res.json({
    total, page, pageSize: size,
    demonstrations: rows.map((d) => ({
      id: d.id, title: d.title, description: d.description, source: d.source, status: d.status, createdAt: d.createdAt,
      steps: (() => { try { return JSON.parse(d.stepsJson).length; } catch { return 0; } })(),
      attempts: d._count.attempts, author: d.author ? d.author.fullName : null,
      where: d.course ? `${d.course.code} · ${d.course.title}` : d.individualCourse ? `${d.individualCourse.title} (self-study)` : '—',
      schoolName: d.course && d.course.department.school ? d.course.department.school.name : null,
    })),
  });
});

router.get('/demonstrations/:id', async (req, res) => {
  const d = await prisma.labDemonstration.findUnique({ where: { id: req.params.id } });
  if (!d) return res.status(404).json({ error: 'Not found' });
  res.json({ title: d.title, description: d.description, steps: JSON.parse(d.stepsJson) });
});

router.patch('/demonstrations/:id', async (req, res) => {
  if (!['APPROVED', 'REJECTED'].includes(req.body.status)) return res.status(400).json({ error: 'Status must be APPROVED or REJECTED.' });
  const d = await prisma.labDemonstration.findUnique({ where: { id: req.params.id } });
  if (!d) return res.status(404).json({ error: 'Not found' });
  const updated = await prisma.labDemonstration.update({ where: { id: d.id }, data: { status: req.body.status } });
  await logAction(req, 'DEMONSTRATION_' + req.body.status, 'LabDemonstration', d.id, { title: d.title });
  res.json({ demonstration: { id: updated.id, status: updated.status } });
});

router.delete('/demonstrations/:id', async (req, res) => {
  const d = await prisma.labDemonstration.findUnique({ where: { id: req.params.id } });
  if (!d) return res.status(404).json({ error: 'Not found' });
  await prisma.$transaction([prisma.labAttempt.deleteMany({ where: { demoId: d.id } }), prisma.labDemonstration.delete({ where: { id: d.id } })]);
  await logAction(req, 'DEMONSTRATION_REMOVED', 'LabDemonstration', d.id, { title: d.title });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- attendance
router.get('/attendance', async (req, res) => {
  const { page, size } = pageOf(req);
  const since = new Date(Date.now() - 30 * 86400000);
  if (req.query.kind === 'staff') {
    const where = { date: { gte: since } };
    const [total, rows, today] = await Promise.all([
      prisma.staffAttendanceRecord.count({ where }),
      prisma.staffAttendanceRecord.findMany({
        where, orderBy: { date: 'desc' }, skip: (page - 1) * size, take: size,
        include: { user: { select: { fullName: true, role: true, school } } },
      }),
      prisma.staffAttendanceRecord.count({ where: { date: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } } }),
    ]);
    return res.json({ total, today, page, pageSize: size, records: rows.map((r) => ({ id: r.id, date: r.date, status: r.status, name: r.user.fullName, role: r.user.role, schoolName: r.user.school ? r.user.school.name : null })) });
  }
  // Class attendance, summarised per course over the last 30 days.
  const grouped = await prisma.classAttendanceRecord.groupBy({ by: ['courseId', 'status'], where: { date: { gte: since } }, _count: { _all: true } });
  const perCourse = new Map();
  for (const g of grouped) {
    const c = perCourse.get(g.courseId) || { present: 0, absent: 0 };
    if (g.status === 'PRESENT') c.present += g._count._all; else c.absent += g._count._all;
    perCourse.set(g.courseId, c);
  }
  const ids = [...perCourse.keys()];
  const courses = ids.length ? await prisma.course.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, title: true, department: { select: { school } } } }) : [];
  const rows = courses.map((c) => {
    const t = perCourse.get(c.id);
    const total = t.present + t.absent;
    return { id: c.id, code: c.code, title: c.title, schoolName: c.department.school ? c.department.school.name : null, present: t.present, absent: t.absent, rate: total ? Math.round((t.present / total) * 100) : null };
  }).sort((a, b) => (a.rate ?? 101) - (b.rate ?? 101));
  res.json({ total: rows.length, page: 1, pageSize: rows.length || 1, courses: rows.slice((page - 1) * size, page * size), pageCount: rows.length });
});

// ---------------------------------------------------------------- results (the higher-ed "report cards")
router.get('/results', async (req, res) => {
  const { page, size } = pageOf(req);
  const search = String(req.query.search || '').trim();
  const where = {};
  if (req.query.schoolId) where.course = { department: { schoolId: String(req.query.schoolId) } };
  if (req.query.sent === 'draft') where.sentAt = null;
  if (req.query.sent === 'sent') where.sentAt = { not: null };
  if (search) where.student = { OR: [{ fullName: { contains: search, mode: 'insensitive' } }, { matricNumber: { contains: search, mode: 'insensitive' } }] };
  const [total, sent, rows] = await Promise.all([
    prisma.result.count({ where }),
    prisma.result.count({ where: { ...where, sentAt: { not: null } } }),
    prisma.result.findMany({
      where, orderBy: { publishedAt: 'desc' }, skip: (page - 1) * size, take: size,
      include: {
        student: { select: { fullName: true, matricNumber: true } },
        author: { select: { fullName: true } },
        course: { select: { code: true, title: true, department: { select: { school } } } },
      },
    }),
  ]);
  res.json({
    total, sent, page, pageSize: size,
    results: rows.map((r) => ({
      id: r.id, student: r.student.fullName, matric: r.student.matricNumber, course: `${r.course.code} · ${r.course.title}`,
      schoolName: r.course.department.school ? r.course.department.school.name : null,
      term: r.term, score: r.score, grade: r.grade, by: r.author.fullName, sentAt: r.sentAt, publishedAt: r.publishedAt,
    })),
  });
});

// ---------------------------------------------------------------- teachers (lecturers + staff)
router.get('/teachers', async (req, res) => {
  const { page, size } = pageOf(req);
  const search = String(req.query.search || '').trim();
  const where = { role: { in: ['LECTURER', 'STAFF'] } };
  if (req.query.role === 'LECTURER' || req.query.role === 'STAFF') where.role = req.query.role;
  if (req.query.schoolId) where.schoolId = String(req.query.schoolId);
  if (search) where.OR = [{ fullName: { contains: search, mode: 'insensitive' } }, { staffId: { contains: search, mode: 'insensitive' } }];
  const [total, rows] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * size, take: size,
      select: {
        id: true, fullName: true, email: true, role: true, status: true, staffId: true, position: true, createdAt: true,
        school, department: { select: { name: true } },
        _count: { select: { coursesAssigned: true, lessonsCreated: true, assessmentsMade: true } },
      },
    }),
  ]);
  res.json({ total, page, pageSize: size, teachers: rows.map(({ _count, department, ...t }) => ({ ...t, email: cleanEmail(t.email), department: department ? department.name : null, courses: _count.coursesAssigned, lessons: _count.lessonsCreated, tests: _count.assessmentsMade })) });
});

// ---------------------------------------------------------------- academic records
router.get('/academic-records', async (req, res) => {
  const { page, size } = pageOf(req);
  const search = String(req.query.search || '').trim();
  const where = { role: 'STUDENT', schoolId: { not: null } };
  if (req.query.schoolId) where.schoolId = String(req.query.schoolId);
  if (search) where.OR = [{ fullName: { contains: search, mode: 'insensitive' } }, { matricNumber: { contains: search, mode: 'insensitive' } }];
  const [total, students] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where, orderBy: { fullName: 'asc' }, skip: (page - 1) * size, take: size,
      select: { id: true, fullName: true, matricNumber: true, status: true, yearOfStudy: true, yearOfAdmission: true, programmeYears: true, school, department: { select: { name: true } } },
    }),
  ]);
  const results = students.length ? await prisma.result.findMany({ where: { studentId: { in: students.map((s) => s.id) }, sentAt: { not: null } }, select: { studentId: true, grade: true } }) : [];
  const POINTS = { A: 5, B: 4, C: 3, D: 2, E: 1, F: 0 };
  const gpa = new Map();
  for (const r of results) {
    if (!r.grade || POINTS[r.grade.toUpperCase()] == null) continue;
    const g = gpa.get(r.studentId) || { sum: 0, n: 0 };
    g.sum += POINTS[r.grade.toUpperCase()]; g.n += 1;
    gpa.set(r.studentId, g);
  }
  res.json({
    total, page, pageSize: size,
    students: students.map(({ department, ...s }) => ({
      ...s, department: department ? department.name : null,
      level: s.yearOfStudy ? `${s.yearOfStudy * 100}L` : null,
      cgpa: gpa.has(s.id) ? Number((gpa.get(s.id).sum / gpa.get(s.id).n).toFixed(2)) : null,
      graduates: s.yearOfAdmission ? s.yearOfAdmission + (s.programmeYears || 4) : null,
    })),
  });
});

router.get('/academic-records/:id', async (req, res) => {
  const student = await prisma.user.findFirst({ where: { id: req.params.id, role: 'STUDENT', schoolId: { not: null } }, include: { department: true, school: true } });
  if (!student) return res.status(404).json({ error: 'Student not found' });
  const [record, results] = await Promise.all([
    computeAcademicRecord(student),
    prisma.result.findMany({ where: { studentId: student.id, sentAt: { not: null } }, orderBy: { publishedAt: 'desc' }, include: { course: { select: { code: true, title: true } } } }),
  ]);
  res.json({
    schoolName: student.school.name,
    record: { ...record, email: cleanEmail(record.email) },
    results: results.map((r) => ({ course: `${r.course.code} · ${r.course.title}`, term: r.term, score: r.score, grade: r.grade })),
  });
});

// ---------------------------------------------------------------- system logs
router.get('/system-logs', async (req, res) => {
  const { page, size } = pageOf(req, 60);
  const where = {};
  if (['ERROR', 'WARN', 'INFO'].includes(req.query.level)) where.level = req.query.level;
  const search = String(req.query.search || '').trim();
  if (search) where.OR = [{ message: { contains: search, mode: 'insensitive' } }, { path: { contains: search, mode: 'insensitive' } }];
  const dayAgo = new Date(Date.now() - 86400000);
  const [total, errors24h, logs] = await Promise.all([
    prisma.systemLog.count({ where }),
    prisma.systemLog.count({ where: { level: 'ERROR', createdAt: { gte: dayAgo } } }),
    prisma.systemLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * size, take: size }),
  ]);
  res.json({ total, errors24h, page, pageSize: size, logs });
});

router.delete('/system-logs', async (req, res) => {
  const olderThanDays = Math.max(0, parseInt(req.query.olderThanDays, 10) || 0);
  const cutoff = new Date(Date.now() - olderThanDays * 86400000);
  const r = await prisma.systemLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
  await logAction(req, 'SYSTEM_LOGS_CLEARED', 'SystemLog', null, { olderThanDays, deleted: r.count });
  res.json({ deleted: r.count });
});

// ---------------------------------------------------------------- codes (access codes + join codes)
router.get('/codes/users', async (req, res) => {
  const { page, size } = pageOf(req, 40);
  const search = String(req.query.search || '').trim();
  const where = { accessCode: { not: null }, role: { not: 'SUPER_ADMIN' } };
  if (req.query.schoolId) where.schoolId = String(req.query.schoolId);
  if (search) where.OR = [{ fullName: { contains: search, mode: 'insensitive' } }, { matricNumber: { contains: search, mode: 'insensitive' } }, { staffId: { contains: search, mode: 'insensitive' } }];
  const [total, users] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * size, take: size, select: { id: true, fullName: true, role: true, status: true, accessCode: true, school } }),
  ]);
  res.json({ total, page, pageSize: size, users });
});

router.post('/codes/users/:id/regenerate', async (req, res) => {
  const user = await prisma.user.findFirst({ where: { id: req.params.id, accessCode: { not: null }, role: { not: 'SUPER_ADMIN' } } });
  if (!user) return res.status(404).json({ error: 'User not found' });
  let code = generateAccessCode();
  while (await prisma.user.findUnique({ where: { accessCode: code } })) code = generateAccessCode();
  await prisma.user.update({ where: { id: user.id }, data: { accessCode: code } });
  await logAction(req, 'ACCESS_CODE_REGENERATED', 'User', user.id, { name: user.fullName, role: user.role });
  res.json({ accessCode: code });
});

// ---------------------------------------------------------------- bulk email / SMS (targeted)
// Same delivery rules as announcements, but aimed by role or school and sent over one channel.
router.post('/bulk', async (req, res) => {
  const channel = req.body.channel;
  if (!['EMAIL', 'SMS'].includes(channel)) return res.status(400).json({ error: 'Choose email or SMS.' });
  const body = String(req.body.body || '').trim();
  const subject = String(req.body.subject || '').trim().slice(0, 120);
  if (!body || body.length > 1500) return res.status(400).json({ error: 'Write a message (up to 1500 characters).' });
  if (channel === 'EMAIL' && !subject) return res.status(400).json({ error: 'Add a subject line.' });
  if (channel === 'EMAIL' && !bulkMessage.emailConfigured()) return res.status(400).json({ error: 'Email is not set up on the server yet (SMTP_HOST / SMTP_USER / SMTP_PASS).' });
  if (channel === 'SMS' && !bulkMessage.smsConfigured()) return res.status(400).json({ error: 'SMS is not set up on the server yet (TERMII_API_KEY / TERMII_SENDER_ID).' });

  const where = { status: 'ACTIVE', role: { not: 'SUPER_ADMIN' } };
  const roles = { STUDENTS: ['STUDENT'], LECTURERS: ['LECTURER'], STAFF: ['STAFF'], ADMINS: ['ADMIN'] }[req.body.audience];
  if (req.body.audience === 'INDEPENDENT') where.isIndividual = true;
  else if (roles) where.role = { in: roles };
  else if (req.body.audience !== 'EVERYONE') return res.status(400).json({ error: 'Pick who this is for.' });
  if (req.body.schoolId) {
    const exists = await prisma.school.findUnique({ where: { id: String(req.body.schoolId) } });
    if (!exists) return res.status(400).json({ error: 'School not found.' });
    where.schoolId = exists.id;
  }
  const recipients = await prisma.user.findMany({ where, select: { id: true, email: true, phone: true } });
  const eligible = recipients.filter((r) => (channel === 'EMAIL' ? r.email && !INTERNAL.test(r.email) : r.phone));
  await logAction(req, channel === 'EMAIL' ? 'BULK_EMAIL_SENT' : 'BULK_SMS_SENT', null, null, { audience: req.body.audience, schoolId: req.body.schoolId || null, recipients: eligible.length });
  res.json({ recipients: recipients.length, deliverable: eligible.length });

  (async () => {
    let sent = 0;
    for (const r of eligible) {
      try {
        if (channel === 'EMAIL') await bulkMessage.sendEmail(r.email, subject, body);
        else await bulkMessage.sendSms(r.phone, body.slice(0, 450));
        sent++;
      } catch { /* counted by omission */ }
    }
    await prisma.announcement.create({
      data: { title: subject || 'SMS', body, audience: req.body.schoolId ? 'SCHOOL' : 'ALL', schoolId: req.body.schoolId || null, channels: channel, recipientCount: eligible.length, emailSent: channel === 'EMAIL' ? sent : 0, smsSent: channel === 'SMS' ? sent : 0, sentById: req.user.id },
    });
  })().catch((e) => console.error('Bulk send failed:', e.message));
});

// ---------------------------------------------------------------- question bank
const qClean = (v, n) => (v == null || v === '' ? null : String(v).trim().slice(0, n));

function shapeQuestion(input) {
  const text = qClean(input.text, 2000);
  const subject = qClean(input.subject, 120);
  const options = (Array.isArray(input.options) ? input.options : []).map((o) => String(o == null ? '' : o).trim().slice(0, 500)).filter(Boolean);
  const correctIndex = parseInt(input.correctIndex, 10);
  if (!text || !subject) return { error: 'Each question needs a subject and the question text.' };
  if (options.length < 2 || options.length > 6) return { error: 'Give between 2 and 6 answer options.' };
  if (!(correctIndex >= 0 && correctIndex < options.length)) return { error: 'Mark which option is correct.' };
  const year = input.year ? parseInt(input.year, 10) : null;
  return {
    data: {
      subject, text, options: JSON.stringify(options), correctIndex,
      topic: qClean(input.topic, 120), level: qClean(input.level, 20), source: qClean(input.source, 120),
      year: year && year > 1950 && year < 2100 ? year : null,
      explanation: qClean(input.explanation, 2000),
      active: input.active === false ? false : true,
    },
  };
}

router.get('/questions', async (req, res) => {
  const { page, size } = pageOf(req, 50);
  const where = { generated: false }; // the system's per-course sets are not part of the owner's bank
  if (req.query.subject) where.subject = String(req.query.subject);
  if (req.query.active === 'true') where.active = true;
  if (req.query.active === 'false') where.active = false;
  const search = String(req.query.search || '').trim();
  if (search) where.text = { contains: search, mode: 'insensitive' };
  const [total, subjects, rows] = await Promise.all([
    prisma.platformQuestion.count({ where }),
    prisma.platformQuestion.groupBy({ by: ['subject'], where: { generated: false }, _count: { _all: true }, orderBy: { subject: 'asc' } }),
    prisma.platformQuestion.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * size, take: size }),
  ]);
  res.json({ total, page, pageSize: size, subjects: subjects.map((s) => ({ subject: s.subject, count: s._count._all })), questions: rows.map((q) => ({ ...q, options: JSON.parse(q.options) })) });
});

router.post('/questions', async (req, res) => {
  const { data, error } = shapeQuestion(req.body);
  if (error) return res.status(400).json({ error });
  const q = await prisma.platformQuestion.create({ data });
  res.json({ question: { ...q, options: JSON.parse(q.options) } });
});

// Paste a JSON array to add many at once: [{subject,text,options:[..],correctIndex,...}, ...]
router.post('/questions/bulk', async (req, res) => {
  const list = Array.isArray(req.body.questions) ? req.body.questions : null;
  if (!list || !list.length) return res.status(400).json({ error: 'Provide a list of questions.' });
  if (list.length > 500) return res.status(400).json({ error: 'Add at most 500 questions at a time.' });
  const data = [];
  const problems = [];
  list.forEach((q, i) => {
    const shaped = shapeQuestion({ ...q, subject: q.subject || req.body.subject });
    if (shaped.error) problems.push(`#${i + 1}: ${shaped.error}`); else data.push(shaped.data);
  });
  if (problems.length) return res.status(400).json({ error: `${problems.length} question${problems.length === 1 ? ' has' : 's have'} a problem — nothing was added.`, problems: problems.slice(0, 10) });
  await prisma.platformQuestion.createMany({ data });
  await logAction(req, 'QUESTIONS_IMPORTED', 'PlatformQuestion', null, { count: data.length });
  res.json({ added: data.length });
});

router.put('/questions/:id', async (req, res) => {
  const existing = await prisma.platformQuestion.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Question not found' });
  const { data, error } = shapeQuestion(req.body);
  if (error) return res.status(400).json({ error });
  const q = await prisma.platformQuestion.update({ where: { id: existing.id }, data });
  res.json({ question: { ...q, options: JSON.parse(q.options) } });
});

router.delete('/questions/:id', async (req, res) => {
  const existing = await prisma.platformQuestion.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Question not found' });
  await prisma.platformQuestion.delete({ where: { id: existing.id } });
  res.json({ ok: true });
});

module.exports = router;
void crypto; void notifyMany;
