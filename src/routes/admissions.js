const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { generateAccessCode } = require('../utils');
const { notifySchoolAdmins } = require('../services/notification.service');

const router = express.Router();

// Public: no account needed to apply.
router.post('/admissions/apply', async (req, res) => {
  const { schoolId, departmentId, fullName, email, phone, level, statement } = req.body;
  if (!schoolId || !departmentId || !fullName || !email || !phone) {
    return res.status(400).json({ error: 'Full name, email, phone, and department are required.' });
  }
  const application = await prisma.application.create({
    data: { schoolId, departmentId, fullName, email, phone, level: level || 'NCE 1', statement: statement || null },
  });
  await notifySchoolAdmins(schoolId, 'New admission application', `${fullName} applied for admission.`, 'admin-admissions');
  res.json({ application });
});

router.get('/admin/admissions', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const { status } = req.query;
  const applications = await prisma.application.findMany({
    where: { schoolId: req.user.schoolId, ...(status ? { status } : {}) },
    include: { department: { select: { name: true, code: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ applications });
});

router.get('/admin/admissions/:id', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const application = await prisma.application.findFirst({
    where: { id: req.params.id, schoolId: req.user.schoolId },
    include: { department: true, attitudeTestSubmission: true },
  });
  if (!application) return res.status(404).json({ error: 'Application not found' });
  res.json({ application });
});

router.post('/admin/admissions/:id/screen', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const application = await prisma.application.update({ where: { id: req.params.id }, data: { status: 'UNDER_REVIEW' } });
  res.json({ application });
});

router.post('/admin/admissions/:id/accept', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const application = await prisma.application.update({ where: { id: req.params.id }, data: { status: 'ACCEPTED', decidedAt: new Date() } });
  res.json({ application });
});

router.post('/admin/admissions/:id/reject', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const application = await prisma.application.update({ where: { id: req.params.id }, data: { status: 'REJECTED', decidedAt: new Date() } });
  res.json({ application });
});

// Turns an accepted application into a real student account: generates a matric
// number and a one-time temporary password (shown once here, for the admin to relay).
router.post('/admin/admissions/:id/register', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const application = await prisma.application.findUnique({
    where: { id: req.params.id },
    include: { school: true, department: true },
  });
  if (!application) return res.status(404).json({ error: 'Application not found' });
  if (application.status !== 'ACCEPTED') return res.status(400).json({ error: 'Only accepted applications can be registered.' });
  if (application.registeredUserId) return res.status(409).json({ error: 'This application has already been registered.' });

  const existingEmail = await prisma.user.findUnique({ where: { email: application.email } });
  if (existingEmail) return res.status(409).json({ error: 'A user with this email already exists.' });

  const matricNumber = await generateMatricNumber(application.school.name, application.departmentId, application.department.code);
  const tempPassword = generateAccessCode(8); // fallback email+password login, kept working alongside the access code
  const passwordHash = await bcrypt.hash(tempPassword, 10);
  let accessCode = generateAccessCode();
  while (await prisma.user.findUnique({ where: { accessCode } })) accessCode = generateAccessCode();

  const user = await prisma.user.create({
    data: {
      fullName: application.fullName,
      email: application.email,
      passwordHash,
      role: 'STUDENT',
      matricNumber,
      departmentId: application.departmentId,
      schoolId: application.schoolId,
      accessCode,
    },
  });
  await prisma.application.update({
    where: { id: application.id },
    data: { status: 'REGISTERED', registeredUserId: user.id },
  });

  res.json({ user: { fullName: user.fullName, email: user.email, matricNumber }, accessCode, tempPassword });
});

// ---- Admission attitude test: one bank per school, replaced wholesale on re-create
// (there's no per-question edit -- posting again just makes a new, newer test; the
// applicant flow always uses the latest one for the school). ----

router.get('/admin/attitude-test', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const test = await prisma.attitudeTest.findFirst({
    where: { schoolId: req.user.schoolId },
    include: { questions: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ test });
});

router.post('/admin/attitude-test', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const { title, questions } = req.body;
  if (!title || !Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: 'Title and at least one question are required.' });
  }
  const test = await prisma.attitudeTest.create({
    data: {
      schoolId: req.user.schoolId,
      title,
      questions: {
        create: questions.map((q, i) => ({
          text: q.text,
          options: JSON.stringify(q.options),
          correctIndex: q.correctIndex,
          order: i,
        })),
      },
    },
    include: { questions: true },
  });
  res.json({ test });
});

// Public: the applicant takes this without an account, identified only by their
// application id.
router.get('/admissions/:id/attitude-test', async (req, res) => {
  const application = await prisma.application.findUnique({ where: { id: req.params.id } });
  if (!application) return res.status(404).json({ error: 'Application not found' });
  const test = await prisma.attitudeTest.findFirst({
    where: { schoolId: application.schoolId },
    include: { questions: true },
    orderBy: { createdAt: 'desc' },
  });
  if (!test) return res.json({ test: null });
  res.json({
    test: {
      id: test.id,
      title: test.title,
      questions: test.questions.map((q) => ({ id: q.id, text: q.text, options: JSON.parse(q.options), order: q.order })),
    },
  });
});

router.post('/admissions/:id/attitude-test/submit', async (req, res) => {
  const application = await prisma.application.findUnique({ where: { id: req.params.id } });
  if (!application) return res.status(404).json({ error: 'Application not found' });
  const existing = await prisma.attitudeTestSubmission.findUnique({ where: { applicationId: application.id } });
  if (existing) return res.status(409).json({ error: 'You have already taken the attitude test.' });

  const test = await prisma.attitudeTest.findFirst({
    where: { schoolId: application.schoolId },
    include: { questions: true },
    orderBy: { createdAt: 'desc' },
  });
  if (!test) return res.status(404).json({ error: 'No attitude test is configured for this school.' });

  const { answers } = req.body;
  const answerMap = new Map((answers || []).map((a) => [a.questionId, a.choice]));
  let score = 0;
  for (const q of test.questions) {
    if (answerMap.get(q.id) === q.correctIndex) score += 1;
  }

  const submission = await prisma.attitudeTestSubmission.create({
    data: {
      testId: test.id,
      applicationId: application.id,
      answers: JSON.stringify(answers || []),
      score,
      total: test.questions.length,
    },
  });
  res.json({ submission });
});

async function generateMatricNumber(schoolName, departmentId, deptCode) {
  const prefix = schoolName.split(' ').map((w) => w[0]).join('').toUpperCase();
  const year = String(new Date().getFullYear()).slice(-2);
  const count = await prisma.user.count({ where: { departmentId, role: 'STUDENT' } });
  const seq = String(count + 1).padStart(3, '0');
  return `${prefix}/${year}/${deptCode}/${seq}`;
}

module.exports = router;
