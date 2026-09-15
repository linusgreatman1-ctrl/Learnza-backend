const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { generateAccessCode } = require('../utils');
const { notify } = require('../services/notification.service');
const { getCurrentSemesterId } = require('../semester');

const router = express.Router();
router.use(requireAuth, requireRole('ADMIN'));

router.get('/school', async (req, res) => {
  const school = await prisma.school.findUnique({ where: { id: req.user.schoolId } });
  res.json({ school });
});

// Distinct courses a lecturer/staff member has actually taught (authored a lesson
// for) -- there's no direct "assigned courses" relation, so this is derived from real
// teaching activity, same signal already used for workload (staff.js).
async function coursesTaughtBy(userId) {
  const lessons = await prisma.lesson.findMany({
    where: { authorId: userId },
    distinct: ['courseId'],
    select: { course: { select: { id: true, code: true, title: true } } },
  });
  return lessons.map((l) => l.course);
}

async function coursesEnrolledBy(studentId) {
  const enrollments = await prisma.enrollment.findMany({
    where: { studentId },
    select: { course: { select: { id: true, code: true, title: true } } },
  });
  return enrollments.map((e) => e.course);
}

router.get('/students', async (req, res) => {
  const students = await prisma.user.findMany({
    where: { schoolId: req.user.schoolId, role: 'STUDENT' },
    include: { department: true },
    orderBy: { fullName: 'asc' },
  });
  const withCourses = await Promise.all(
    students.map(async ({ passwordHash, ...s }) => ({ ...s, courses: await coursesEnrolledBy(s.id) }))
  );
  res.json({ students: withCourses });
});

router.get('/students/:id', async (req, res) => {
  const student = await prisma.user.findFirst({
    where: { id: req.params.id, schoolId: req.user.schoolId, role: 'STUDENT' },
    include: { department: true },
  });
  if (!student) return res.status(404).json({ error: 'Not found' });
  const { passwordHash, ...safe } = student;
  res.json({ student: { ...safe, courses: await coursesEnrolledBy(student.id) } });
});

router.get('/lecturers', async (req, res) => {
  const lecturers = await prisma.user.findMany({
    where: { schoolId: req.user.schoolId, role: 'LECTURER' },
    include: { department: true },
    orderBy: { fullName: 'asc' },
  });
  const withCourses = await Promise.all(
    lecturers.map(async ({ passwordHash, ...l }) => ({ ...l, courses: await coursesTaughtBy(l.id) }))
  );
  res.json({ lecturers: withCourses });
});

router.get('/lecturers/:id', async (req, res) => {
  const lecturer = await prisma.user.findFirst({
    where: { id: req.params.id, schoolId: req.user.schoolId, role: 'LECTURER' },
    include: { department: true },
  });
  if (!lecturer) return res.status(404).json({ error: 'Not found' });
  const { passwordHash, ...safe } = lecturer;
  res.json({ lecturer: { ...safe, courses: await coursesTaughtBy(lecturer.id) } });
});

// Non-academic staff (librarians, accountants, registrars, etc.) -- role STAFF,
// distinct from LECTURER. They don't teach a course, so "position" (job title)
// stands in for "course" in their directory listing. Routed as /non-academic-staff,
// not /staff, since staff.js already owns /admin/staff/* (workload, attendance, CPD,
// publications) on a separate router mounted ahead of this one -- a /staff/:id route
// here would shadow those.
router.get('/non-academic-staff', async (req, res) => {
  const staff = await prisma.user.findMany({
    where: { schoolId: req.user.schoolId, role: 'STAFF' },
    include: { department: true },
    orderBy: { fullName: 'asc' },
  });
  res.json({ staff: staff.map(({ passwordHash, ...s }) => s) });
});

router.get('/non-academic-staff/:id', async (req, res) => {
  const staff = await prisma.user.findFirst({
    where: { id: req.params.id, schoolId: req.user.schoolId, role: 'STAFF' },
    include: { department: true },
  });
  if (!staff) return res.status(404).json({ error: 'Not found' });
  const { passwordHash, ...safe } = staff;
  res.json({ staff: safe });
});

// Monitoring reaches lecturer activity only -- students are never tracked here by design.
router.get('/lecturer-activity', async (req, res) => {
  const logs = await prisma.activityLog.findMany({
    where: { user: { schoolId: req.user.schoolId, role: 'LECTURER' } },
    include: { user: { select: { fullName: true } } },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  res.json({ logs });
});

// Every student assessment/assignment/exam score in one place -- the "school can see
// students' tests, assignments and exams" view.
router.get('/student-activity', async (req, res) => {
  const [submissions, assignmentSubs, results, attendance] = await Promise.all([
    prisma.submission.findMany({
      where: { student: { schoolId: req.user.schoolId }, submittedAt: { not: null } },
      include: { student: { select: { fullName: true, matricNumber: true } }, assessment: { select: { title: true, type: true, course: { select: { code: true } } } } },
      orderBy: { submittedAt: 'desc' },
      take: 100,
    }),
    prisma.assignmentSubmission.findMany({
      where: { student: { schoolId: req.user.schoolId } },
      include: { student: { select: { fullName: true, matricNumber: true } }, assignment: { select: { title: true, course: { select: { code: true } } } } },
      orderBy: { submittedAt: 'desc' },
      take: 100,
    }),
    prisma.result.findMany({
      where: { student: { schoolId: req.user.schoolId } },
      include: { student: { select: { fullName: true, matricNumber: true } }, course: { select: { code: true } } },
      orderBy: { publishedAt: 'desc' },
      take: 100,
    }),
    prisma.classAttendanceRecord.findMany({
      where: { student: { schoolId: req.user.schoolId } },
      include: { student: { select: { fullName: true, matricNumber: true } }, course: { select: { code: true } } },
      orderBy: { date: 'desc' },
      take: 100,
    }),
  ]);
  res.json({ submissions, assignmentSubmissions: assignmentSubs, results, attendance });
});

// Shared by every "admin directly adds a user" flow -- always auto-generates the
// access code and a temp password, never accepts either as input.
async function createSchoolUser(req, res, { role, extraFields = {}, requiredFields = [] }) {
  const { fullName, email, phone } = req.body;
  if (!fullName || !email || requiredFields.some((f) => !req.body[f])) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ error: 'An account with that email already exists' });
  const tempPassword = generateAccessCode(8);
  const passwordHash = await bcrypt.hash(tempPassword, 10);
  let accessCode = generateAccessCode();
  while (await prisma.user.findUnique({ where: { accessCode } })) accessCode = generateAccessCode();

  const user = await prisma.user.create({
    data: { fullName, email, phone: phone || null, passwordHash, schoolId: req.user.schoolId, role, accessCode, ...extraFields },
  });
  const { passwordHash: _, ...safe } = user;
  return res.json({ user: safe, accessCode, tempPassword });
}

router.post('/lecturers', async (req, res) => {
  const { staffId, departmentId } = req.body;
  return createSchoolUser(req, res, {
    role: 'LECTURER',
    requiredFields: ['departmentId'],
    extraFields: { staffId: staffId || null, departmentId, staffType: 'ACADEMIC' },
  });
});

router.post('/non-academic-staff', async (req, res) => {
  const { staffId, position, departmentId } = req.body;
  return createSchoolUser(req, res, {
    role: 'STAFF',
    requiredFields: ['position'],
    extraFields: { staffId: staffId || null, position, departmentId: departmentId || null, staffType: 'NON_ACADEMIC' },
  });
});

router.post('/students', async (req, res) => {
  const { matricNumber, departmentId } = req.body;
  return createSchoolUser(req, res, {
    role: 'STUDENT',
    requiredFields: ['matricNumber', 'departmentId'],
    extraFields: { matricNumber, departmentId },
  });
});

router.post('/departments', async (req, res) => {
  const { name, code } = req.body;
  if (!name || !code) return res.status(400).json({ error: 'Name and code are required' });
  const department = await prisma.department.create({
    data: { name, code, schoolId: req.user.schoolId },
  });
  res.json({ department });
});

router.post('/courses', async (req, res) => {
  const { departmentId, code, title, level, semester } = req.body;
  if (!departmentId || !code || !title) return res.status(400).json({ error: 'Missing required fields' });
  const semesterId = await getCurrentSemesterId(req.user.schoolId);
  const course = await prisma.course.create({
    data: { departmentId, code, title, level: level || 'NCE 1', semester: semester || 'First', semesterId },
  });
  res.json({ course });
});

// ---- Lecturer status: suspend / lift / dismiss ----

const STATUS_NOTE = {
  ACTIVE: 'Your account has been reactivated.',
  SUSPENDED: 'Your account has been suspended by the school administrator.',
  DISMISSED: 'Your account has been dismissed.',
  EXPELLED: 'Your account has been marked as expelled.',
};

async function setUserStatus(req, res, { role, statuses }) {
  const user = await prisma.user.findFirst({ where: { id: req.params.id, schoolId: req.user.schoolId, role } });
  if (!user) return res.status(404).json({ error: 'Not found' });
  const status = statuses[req.params.action];
  if (!status) return res.status(400).json({ error: 'Unknown action' });
  const updated = await prisma.user.update({ where: { id: user.id }, data: { status } });
  await notify(user.id, 'Account status changed', STATUS_NOTE[status]);
  const { passwordHash, ...safe } = updated;
  res.json({ user: safe });
}

router.post('/lecturers/:id/:action', (req, res) =>
  setUserStatus(req, res, { role: 'LECTURER', statuses: { suspend: 'SUSPENDED', 'lift-suspension': 'ACTIVE', dismiss: 'DISMISSED' } })
);

router.post('/non-academic-staff/:id/:action', (req, res) =>
  setUserStatus(req, res, { role: 'STAFF', statuses: { suspend: 'SUSPENDED', 'lift-suspension': 'ACTIVE', dismiss: 'DISMISSED' } })
);

router.post('/students/:id/:action', (req, res) =>
  setUserStatus(req, res, { role: 'STUDENT', statuses: { suspend: 'SUSPENDED', 'lift-suspension': 'ACTIVE', expel: 'EXPELLED' } })
);

// ---- Semesters: the school's own term calendar. New activity (courses, assessments,
// assignments, attendance, results) is stamped with whichever one is current. ----
router.post('/semesters', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const semester = await prisma.semester.create({ data: { name, schoolId: req.user.schoolId } });
  res.json({ semester });
});

router.post('/semesters/:id/activate', async (req, res) => {
  const semester = await prisma.semester.findFirst({ where: { id: req.params.id, schoolId: req.user.schoolId } });
  if (!semester) return res.status(404).json({ error: 'Semester not found' });
  await prisma.$transaction([
    prisma.semester.updateMany({ where: { schoolId: req.user.schoolId, isCurrent: true }, data: { isCurrent: false } }),
    prisma.semester.update({ where: { id: semester.id }, data: { isCurrent: true } }),
  ]);
  res.json({ ok: true });
});

// ---- Named hostels, grouped allocations ----
router.get('/hostels', async (req, res) => {
  const hostels = await prisma.hostel.findMany({
    where: { schoolId: req.user.schoolId },
    include: { _count: { select: { applications: { where: { status: 'APPROVED' } } } } },
    orderBy: { name: 'asc' },
  });
  res.json({ hostels });
});

router.post('/hostels', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const hostel = await prisma.hostel.create({ data: { name, schoolId: req.user.schoolId } });
  res.json({ hostel });
});

router.get('/hostels/:id/allocations', async (req, res) => {
  const allocations = await prisma.hostelApplication.findMany({
    where: { hostelId: req.params.id, status: 'APPROVED', student: { schoolId: req.user.schoolId } },
    include: { student: { select: { fullName: true, matricNumber: true, phone: true, email: true, department: { select: { name: true } } } } },
    orderBy: { decidedAt: 'desc' },
  });
  res.json({ allocations });
});

module.exports = router;
