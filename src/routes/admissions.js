const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../db');
const { requireAuth, requireRole, requireApplicant, signApplicantToken } = require('../auth');
const { generateAccessCode } = require('../utils');
const { notifySchoolAdmins } = require('../services/notification.service');
const { memoryUpload, saveUpload } = require('../services/fileUpload.service');

const router = express.Router();
const upload = memoryUpload(10);

// A generic, platform-level screening question -- not school-specific and not
// configurable by admin, unlike the real aptitude test below. correctIndex never
// leaves the server; it's only used to record iqCorrect for the admin's own reference.
// Not scored/gated on -- just visible context alongside the rest of the application.
const IQ_QUESTION = {
  text: 'Look at this number series: 2, 4, 6, 8, ... What number comes next?',
  options: ['9', '10', '11', '12'],
  correctIndex: 1,
};
router.get('/iq-question', (req, res) => {
  res.json({ question: { text: IQ_QUESTION.text, options: IQ_QUESTION.options } });
});

// ---- Applicant accounts: a prospective student's own login, separate from School/
// Individual/Admin User accounts -- created the moment they choose to apply, before
// any actual application details exist, so they can log back into their own small
// dashboard later (check status, take the aptitude test when it's sent, etc). ----

router.post('/applicant/register', async (req, res) => {
  const { fullName, email, phone, password } = req.body;
  if (!fullName || !email || !phone || !password) {
    return res.status(400).json({ error: 'Full name, email, phone, and password are required.' });
  }
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  const existing = await prisma.applicant.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ error: 'An account with this email already exists -- log in instead.' });
  const passwordHash = await bcrypt.hash(password, 10);
  const applicant = await prisma.applicant.create({ data: { fullName, email, phone, passwordHash } });
  res.json({ token: signApplicantToken(applicant), applicant: { id: applicant.id, fullName, email, phone } });
});

router.post('/applicant/login', async (req, res) => {
  const { email, password } = req.body;
  const applicant = await prisma.applicant.findUnique({ where: { email: email || '' } });
  if (!applicant || !(await bcrypt.compare(password || '', applicant.passwordHash))) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  res.json({ token: signApplicantToken(applicant), applicant: { id: applicant.id, fullName: applicant.fullName, email: applicant.email, phone: applicant.phone } });
});

// The applicant's own small dashboard: their identity, their (most recent) application
// if any, and the state of its aptitude test if one has been sent. An applicant only
// ever has one live application in this version -- if they've already applied, this
// is what "apply for admission" in their dashboard shows instead of a fresh form.
router.get('/applicant/me', requireApplicant, async (req, res) => {
  const application = await prisma.application.findFirst({
    where: { applicantId: req.applicant.id },
    include: {
      school: { select: { name: true, location: true } },
      department: { select: { name: true, code: true } },
      aptitudeTestSubmission: true,
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json({
    applicant: { id: req.applicant.id, fullName: req.applicant.fullName, email: req.applicant.email, phone: req.applicant.phone },
    application,
  });
});

// 7 days out at 2pm -- the date communicated right after applying, before the school
// has actually set/sent a real test. Purely informational context, never a deadline
// enforced anywhere -- admin can send the real test whenever it's ready.
function computeScheduledAptitudeDate(from = new Date()) {
  const d = new Date(from);
  d.setDate(d.getDate() + 7);
  d.setHours(14, 0, 0, 0);
  return d;
}

// Requires an applicant account now (previously fully anonymous) -- multipart because
// of the O-level result upload.
router.post('/admissions/apply', requireApplicant, upload.single('olevelResult'), async (req, res) => {
  const existing = await prisma.application.findFirst({ where: { applicantId: req.applicant.id } });
  if (existing) return res.status(409).json({ error: 'You have already submitted an application.' });

  const { schoolId, departmentId, level, statement, olevelType, iqChoice } = req.body;
  if (!schoolId || !departmentId) {
    return res.status(400).json({ error: 'School and department are required.' });
  }
  if (!olevelType) return res.status(400).json({ error: 'Select which O-level result you have.' });
  if (!req.file) return res.status(400).json({ error: 'Upload your O-level result.' });
  if (iqChoice === undefined || iqChoice === null || iqChoice === '') {
    return res.status(400).json({ error: 'Answer the screening question.' });
  }

  const { url: olevelResultUrl } = await saveUpload(req.file);
  const aptitudeScheduledAt = computeScheduledAptitudeDate();

  const application = await prisma.application.create({
    data: {
      applicantId: req.applicant.id,
      schoolId, departmentId,
      fullName: req.applicant.fullName, email: req.applicant.email, phone: req.applicant.phone,
      level: level || 'NCE 1',
      statement: statement || null,
      olevelType,
      olevelResultUrl,
      iqAnswer: String(iqChoice),
      iqCorrect: Number(iqChoice) === IQ_QUESTION.correctIndex,
      aptitudeScheduledAt,
    },
  });
  await notifySchoolAdmins(schoolId, 'New admission application', `${req.applicant.fullName} applied for admission.`, 'admin-admissions');
  res.json({ application, aptitudeScheduledAt });
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
    include: { department: true, aptitudeTestSubmission: true },
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

// ---- Admission aptitude test: one bank per school, replaced wholesale on re-create
// (there's no per-question edit -- posting again just makes a new, newer test; sending
// it to an applicant always uses the latest one for the school). Capped at 10
// questions -- each question is worth a flat 10% of the applicant's score, so a bank
// larger than 10 would push the total over 100%. ----

const MAX_APTITUDE_QUESTIONS = 10;

router.get('/admin/aptitude-test', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const test = await prisma.aptitudeTest.findFirst({
    where: { schoolId: req.user.schoolId },
    include: { questions: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ test, maxQuestions: MAX_APTITUDE_QUESTIONS });
});

router.post('/admin/aptitude-test', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const { title, questions } = req.body;
  if (!title || !Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: 'Title and at least one question are required.' });
  }
  if (questions.length > MAX_APTITUDE_QUESTIONS) {
    return res.status(400).json({ error: `The aptitude test can have at most ${MAX_APTITUDE_QUESTIONS} questions (each is worth 10%).` });
  }
  const test = await prisma.aptitudeTest.create({
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

// Admin pushes the school's current aptitude test to one specific applicant --
// creates (or refreshes) their AptitudeTestSubmission row with sentAt set, which is
// what the applicant's dashboard polls for to know a test is waiting. Refused once
// they've already started/finished it, so re-sending can't reset an in-progress or
// completed attempt.
router.post('/admin/admissions/:id/send-aptitude-test', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const application = await prisma.application.findFirst({ where: { id: req.params.id, schoolId: req.user.schoolId } });
  if (!application) return res.status(404).json({ error: 'Application not found' });
  const test = await prisma.aptitudeTest.findFirst({ where: { schoolId: req.user.schoolId }, orderBy: { createdAt: 'desc' } });
  if (!test) return res.status(400).json({ error: 'Set up the aptitude test bank first.' });

  const existing = await prisma.aptitudeTestSubmission.findUnique({ where: { applicationId: application.id } });
  if (existing && (existing.startedAt || existing.submittedAt)) {
    return res.status(400).json({ error: 'This applicant has already started or completed their test.' });
  }
  const submission = existing
    ? await prisma.aptitudeTestSubmission.update({ where: { id: existing.id }, data: { testId: test.id, sentAt: new Date() } })
    : await prisma.aptitudeTestSubmission.create({ data: { testId: test.id, applicationId: application.id, sentAt: new Date() } });
  res.json({ submission });
});

// ---- Applicant side of the aptitude test -- requires their own login now (previously
// a fully anonymous, unauthenticated pair of routes keyed only by a guessable id). ----

function minutesForAptitude(questionCount) {
  return Math.max(1, questionCount); // 1 minute per question, same convention as assessments.js
}

router.get('/applicant/aptitude-test', requireApplicant, async (req, res) => {
  const application = await prisma.application.findFirst({ where: { applicantId: req.applicant.id } });
  if (!application) return res.status(404).json({ error: 'No application found.' });
  const sub = await prisma.aptitudeTestSubmission.findUnique({ where: { applicationId: application.id } });
  if (!sub || !sub.sentAt) return res.json({ test: null, aptitudeScheduledAt: application.aptitudeScheduledAt });
  if (sub.submittedAt) return res.json({ submitted: true, score: sub.score, total: sub.total });

  const test = await prisma.aptitudeTest.findUnique({ where: { id: sub.testId }, include: { questions: true } });
  // Opening the test for the first time stamps startedAt -- the deadline anchor from
  // here on, same server-side-timer pattern as assessments.js's /start.
  const startedAt = sub.startedAt || (await prisma.aptitudeTestSubmission.update({ where: { id: sub.id }, data: { startedAt: new Date() } })).startedAt;
  const durationMin = minutesForAptitude(test.questions.length);
  res.json({
    test: {
      id: test.id,
      title: test.title,
      questions: test.questions.map((q) => ({ id: q.id, text: q.text, options: JSON.parse(q.options), order: q.order })),
    },
    startedAt, durationMin,
  });
});

router.post('/applicant/aptitude-test/submit', requireApplicant, async (req, res) => {
  const application = await prisma.application.findFirst({ where: { applicantId: req.applicant.id } });
  if (!application) return res.status(404).json({ error: 'No application found.' });
  const sub = await prisma.aptitudeTestSubmission.findUnique({ where: { applicationId: application.id } });
  if (!sub || !sub.sentAt) return res.status(400).json({ error: 'No test has been sent to you yet.' });
  if (sub.submittedAt) return res.status(409).json({ error: 'You have already taken the aptitude test.' });
  if (!sub.startedAt) return res.status(400).json({ error: 'Open the test before submitting.' });

  const test = await prisma.aptitudeTest.findUnique({ where: { id: sub.testId }, include: { questions: true } });
  const deadline = new Date(sub.startedAt.getTime() + minutesForAptitude(test.questions.length) * 60000 + 15000); // 15s grace
  if (new Date() > deadline) return res.status(400).json({ error: 'Time is up for this test.' });

  const { answers } = req.body;
  const answerMap = new Map((answers || []).map((a) => [a.questionId, a.choice]));
  let correctCount = 0;
  for (const q of test.questions) {
    if (answerMap.get(q.id) === q.correctIndex) correctCount += 1;
  }
  // Each question is a flat 10% regardless of bank size (capped at 10 questions on
  // the way in), not correctCount/total*100 -- matches "one question is 10%".
  const score = correctCount * 10;

  const updated = await prisma.aptitudeTestSubmission.update({
    where: { id: sub.id },
    data: { answers: JSON.stringify(answers || []), score, total: test.questions.length * 10, submittedAt: new Date() },
  });
  res.json({ score: updated.score, total: updated.total });
});

async function generateMatricNumber(schoolName, departmentId, deptCode) {
  const prefix = schoolName.split(' ').map((w) => w[0]).join('').toUpperCase();
  const year = String(new Date().getFullYear()).slice(-2);
  const count = await prisma.user.count({ where: { departmentId, role: 'STUDENT' } });
  const seq = String(count + 1).padStart(3, '0');
  return `${prefix}/${year}/${deptCode}/${seq}`;
}

module.exports = router;
