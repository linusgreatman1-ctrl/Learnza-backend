const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { generateAccessCode } = require('../utils');
const { notify } = require('../services/notification.service');

const router = express.Router();
router.use(requireAuth, requireRole('ADMIN'));

router.get('/school', async (req, res) => {
  const school = await prisma.school.findUnique({ where: { id: req.user.schoolId } });
  res.json({ school });
});

router.get('/students', async (req, res) => {
  const students = await prisma.user.findMany({
    where: { schoolId: req.user.schoolId, role: 'STUDENT' },
    include: { department: true },
    orderBy: { fullName: 'asc' },
  });
  res.json({ students: students.map(({ passwordHash, ...s }) => s) });
});

router.get('/lecturers', async (req, res) => {
  const lecturers = await prisma.user.findMany({
    where: { schoolId: req.user.schoolId, role: 'LECTURER' },
    include: { department: true },
    orderBy: { fullName: 'asc' },
  });
  res.json({ lecturers: lecturers.map(({ passwordHash, ...l }) => l) });
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
  const [submissions, assignmentSubs, results] = await Promise.all([
    prisma.submission.findMany({
      where: { student: { schoolId: req.user.schoolId } },
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
  ]);
  res.json({ submissions, assignmentSubmissions: assignmentSubs, results });
});

router.post('/lecturers', async (req, res) => {
  const { fullName, email, staffId, departmentId } = req.body;
  if (!fullName || !email || !departmentId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ error: 'An account with that email already exists' });
  const tempPassword = generateAccessCode(8);
  const passwordHash = await bcrypt.hash(tempPassword, 10);
  let accessCode = generateAccessCode();
  while (await prisma.user.findUnique({ where: { accessCode } })) accessCode = generateAccessCode();

  const lecturer = await prisma.user.create({
    data: { fullName, email, passwordHash, staffId, departmentId, schoolId: req.user.schoolId, role: 'LECTURER', accessCode },
  });
  const { passwordHash: _, ...safe } = lecturer;
  res.json({ lecturer: safe, accessCode, tempPassword });
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
  const course = await prisma.course.create({
    data: { departmentId, code, title, level: level || 'NCE 1', semester: semester || 'First' },
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

router.post('/students/:id/:action', (req, res) =>
  setUserStatus(req, res, { role: 'STUDENT', statuses: { suspend: 'SUSPENDED', 'lift-suspension': 'ACTIVE', expel: 'EXPELLED' } })
);

// ---- Hostel allocations (approved, with room + student details) ----
router.get('/hostel-allocations', async (req, res) => {
  const allocations = await prisma.hostelApplication.findMany({
    where: { status: 'APPROVED', student: { schoolId: req.user.schoolId } },
    include: { student: { select: { fullName: true, matricNumber: true, department: { select: { name: true } } } } },
    orderBy: { decidedAt: 'desc' },
  });
  res.json({ allocations });
});

module.exports = router;
