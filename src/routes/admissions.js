const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../db');
const { requireAuth, requireRole, requireApplicant, signApplicantToken } = require('../auth');
const { generateAccessCode } = require('../utils');
const { notifySchoolAdmins } = require('../services/notification.service');
const { memoryUpload, saveUpload } = require('../services/fileUpload.service');
const { sendEmail } = require('../services/bulkMessage.service');
const { pushToApplicant } = require('../realtime/notifications');

const router = express.Router();
const upload = memoryUpload(10);

// Best-effort: an applicant's in-app dashboard is always the source of truth, so a
// missing/misconfigured SMTP setup or a transient send failure must never break the
// admin action that triggered it -- this only ever adds an email on top.
async function notifyApplicantByEmail(email, subject, text) {
  try {
    await sendEmail(email, subject, text);
  } catch (err) {
    if (err.code !== 'EMAIL_NOT_CONFIGURED') console.error('Applicant email failed:', err.message);
  }
}

// The in-app counterpart to the email above -- every school decision reached an
// applicant only by email before, with nothing to see on the dashboard itself unless
// they happened to re-check their application status. applicantId is nullable on
// Application in the schema (pre-dates applicant accounts existing at all), so this
// is a no-op for the rare row without one rather than a hard requirement.
async function notifyApplicant(applicantId, title, body) {
  if (!applicantId) return;
  const notification = await prisma.applicantNotification.create({ data: { applicantId, title, body } });
  pushToApplicant(applicantId, notification);
}

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
    include: {
      department: true,
      aptitudeTestSubmission: { include: { test: { include: { questions: true } } } },
    },
  });
  if (!application) return res.status(404).json({ error: 'Application not found' });
  res.json({ application });
});

router.post('/admin/admissions/:id/screen', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const application = await prisma.application.update({ where: { id: req.params.id }, data: { status: 'UNDER_REVIEW' } });
  notifyApplicantByEmail(application.email, 'Your Learnza application is under review',
    `Hi ${application.fullName},\n\nYour admission application is now under review. Log in to your applicant dashboard on Learnza anytime to check for updates.\n\n— Learnza`);
  notifyApplicant(application.applicantId, 'Application under review', 'Your admission application is now under review.');
  res.json({ application });
});

// A formal, school-letterhead register -- these are read by the applicant as an
// actual admission decision, not an app notification, so they're written the way a
// real admissions office would write them rather than as a short in-app toast.
function admissionAcceptedEmailText(app) {
  const campus = app.school.location ? `, ${app.school.location} Campus,` : ',';
  return `Dear ${app.fullName},\n\nCongratulations! You have been offered provisional admission to study ${app.department.name} at ${app.school.name}${campus} for a duration of three (3) academic years.\n\nPlease log in to your applicant dashboard on Learnza to download your admission letter and review the instructions in it to complete your registration.\n\nCongratulations once again, and welcome to ${app.school.name}.\n\n— Admissions Office, ${app.school.name}`;
}
function admissionRejectedEmailText(app) {
  const reasonLine = app.rejectionReason
    ? `Reason: ${app.rejectionReason}`
    : 'After careful review, we are unable to offer you admission to your chosen programme at this time.';
  return `Dear ${app.fullName},\n\nWe regret to inform you that your application for admission was not successful.\n\n${reasonLine}\n\nWe thank you for your interest and wish you the very best in your future endeavours.\n\n— Admissions Office`;
}

// Accepts an optional admission letter upload in the same request -- "so they can be
// sent together" -- but doesn't require one: admin can accept now and add the letter
// later from the standalone upload route below.
router.post('/admin/admissions/:id/accept', requireAuth, requireRole('ADMIN'), upload.single('admissionLetter'), async (req, res) => {
  const existing = await prisma.application.findFirst({
    where: { id: req.params.id, schoolId: req.user.schoolId },
    include: { school: true, department: true },
  });
  if (!existing) return res.status(404).json({ error: 'Application not found' });

  let admissionLetterUrl = existing.admissionLetterUrl;
  if (req.file) ({ url: admissionLetterUrl } = await saveUpload(req.file));

  const application = await prisma.application.update({
    where: { id: existing.id },
    data: { status: 'ACCEPTED', decidedAt: new Date(), admissionLetterUrl },
  });
  notifyApplicantByEmail(existing.email, 'Your Learnza application has been accepted',
    admissionAcceptedEmailText({ ...existing, admissionLetterUrl }));
  notifyApplicant(existing.applicantId, 'Application accepted', `Congratulations! You've been offered provisional admission to ${existing.department.name}.`);
  res.json({ application });
});

router.post('/admin/admissions/:id/reject', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const { reason } = req.body;
  const application = await prisma.application.update({
    where: { id: req.params.id },
    data: { status: 'REJECTED', decidedAt: new Date(), rejectionReason: reason || null },
  });
  notifyApplicantByEmail(application.email, 'Update on your Learnza application', admissionRejectedEmailText(application));
  notifyApplicant(application.applicantId, 'Update on your application', 'There is an update on your admission application -- log in to view it.');
  res.json({ application });
});

// Adds or replaces the admission letter independent of accept -- for an application
// already accepted without one, or to correct/reissue it later.
router.post('/admin/admissions/:id/admission-letter', requireAuth, requireRole('ADMIN'), upload.single('admissionLetter'), async (req, res) => {
  const existing = await prisma.application.findFirst({ where: { id: req.params.id, schoolId: req.user.schoolId } });
  if (!existing) return res.status(404).json({ error: 'Application not found' });
  if (!req.file) return res.status(400).json({ error: 'Choose a file to upload.' });
  const { url } = await saveUpload(req.file);
  const application = await prisma.application.update({ where: { id: existing.id }, data: { admissionLetterUrl: url } });
  notifyApplicantByEmail(existing.email, 'Your Learnza admission letter is ready',
    `Dear ${existing.fullName},\n\nYour admission letter is now available. Log in to your applicant dashboard on Learnza to download it.\n\n— Admissions Office`);
  notifyApplicant(existing.applicantId, 'Admission letter ready', 'Your admission letter is now available to download from your dashboard.');
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
  notifyApplicantByEmail(application.email, 'Welcome to Learnza — your student account is ready',
    `Hi ${application.fullName},\n\nYour admission has been registered. You can now log in to Learnza with:\n\nEmail: ${user.email}\nMatric number: ${matricNumber}\nAccess code: ${accessCode}\nTemporary password: ${tempPassword}\n\nPlease log in and change your password as soon as possible.\n\n— Learnza`);
  notifyApplicant(application.applicantId, 'Your student account is ready', 'Your admission has been registered -- check your email for your login details.');

  res.json({ user: { fullName: user.fullName, email: user.email, matricNumber }, accessCode, tempPassword });
});

// ---- Applicant's own notification bell: an in-app feed of every status change above,
// so their dashboard doesn't rely purely on email having actually reached them. ----

router.get('/applicant/notifications', requireApplicant, async (req, res) => {
  const notifications = await prisma.applicantNotification.findMany({
    where: { applicantId: req.applicant.id },
    orderBy: { createdAt: 'desc' },
    take: 30,
  });
  const unreadCount = await prisma.applicantNotification.count({ where: { applicantId: req.applicant.id, read: false } });
  res.json({ notifications, unreadCount });
});

router.post('/applicant/notifications/:id/read', requireApplicant, async (req, res) => {
  await prisma.applicantNotification.updateMany({ where: { id: req.params.id, applicantId: req.applicant.id }, data: { read: true } });
  res.json({ ok: true });
});

router.post('/applicant/notifications/read-all', requireApplicant, async (req, res) => {
  await prisma.applicantNotification.updateMany({ where: { applicantId: req.applicant.id, read: false }, data: { read: true } });
  res.json({ ok: true });
});

// ---- Admission aptitude test: one bank per school. Editable in place for as long
// as nobody has been sent it yet -- saving again just updates the same bank, so
// fixing a typo or a missing model answer doesn't spawn a pointless new version.
// The moment it's actually been sent to at least one applicant, a further save
// creates a fresh version instead: that applicant's in-progress/completed attempt
// must keep its own untouched copy of the exact questions it was scored against,
// so editing the live bank out from under them isn't safe once it's in use.
// Capped at 10 questions -- each is worth a flat 10% of the applicant's score, so a
// bank larger than 10 would push the total over 100%. ----

const MAX_APTITUDE_QUESTIONS = 10;

router.get('/admin/aptitude-test', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const test = await prisma.aptitudeTest.findFirst({
    where: { schoolId: req.user.schoolId },
    include: { questions: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ test, maxQuestions: MAX_APTITUDE_QUESTIONS });
});

function questionCreateData(questions) {
  return questions.map((q, i) => ({
    questionType: q.questionType === 'THEORY' ? 'THEORY' : 'OBJECTIVE',
    text: q.text,
    options: q.questionType === 'THEORY' ? null : JSON.stringify(q.options),
    correctIndex: q.questionType === 'THEORY' ? null : q.correctIndex,
    modelAnswer: q.questionType === 'THEORY' ? (q.modelAnswer || null) : null,
    order: i,
  }));
}

router.post('/admin/aptitude-test', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const { title, questions } = req.body;
  if (!title || !Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: 'Title and at least one question are required.' });
  }
  if (questions.length > MAX_APTITUDE_QUESTIONS) {
    return res.status(400).json({ error: `The aptitude test can have at most ${MAX_APTITUDE_QUESTIONS} questions (each is worth 10%).` });
  }

  const current = await prisma.aptitudeTest.findFirst({ where: { schoolId: req.user.schoolId }, orderBy: { createdAt: 'desc' } });
  const alreadyUsed = current && (await prisma.aptitudeTestSubmission.findFirst({ where: { testId: current.id } }));
  if (current && !alreadyUsed) {
    await prisma.aptitudeTestQuestion.deleteMany({ where: { testId: current.id } });
    const test = await prisma.aptitudeTest.update({
      where: { id: current.id },
      data: { title, questions: { create: questionCreateData(questions) } },
      include: { questions: true },
    });
    return res.json({ test });
  }

  const test = await prisma.aptitudeTest.create({
    data: { schoolId: req.user.schoolId, title, questions: { create: questionCreateData(questions) } },
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
  if (!test) return res.status(400).json({ error: 'Set up the aptitude test bank first.', code: 'NO_TEST_BANK' });

  const existing = await prisma.aptitudeTestSubmission.findUnique({ where: { applicationId: application.id } });
  if (existing && (existing.startedAt || existing.submittedAt)) {
    return res.status(400).json({ error: 'This applicant has already started or completed their test.' });
  }
  const submission = existing
    ? await prisma.aptitudeTestSubmission.update({ where: { id: existing.id }, data: { testId: test.id, sentAt: new Date() } })
    : await prisma.aptitudeTestSubmission.create({ data: { testId: test.id, applicationId: application.id, sentAt: new Date() } });
  notifyApplicantByEmail(application.email, 'Your Learnza aptitude test is ready',
    `Hi ${application.fullName},\n\nYour school has sent your aptitude test. Log in to your applicant dashboard on Learnza to take it -- once you open it, you'll have 1 minute per question and it cannot be paused.\n\n— Learnza`);
  notifyApplicant(application.applicantId, 'Aptitude test ready', 'Your school has sent your aptitude test -- log in to take it.');
  res.json({ submission });
});

// ---- Applicant side of the aptitude test -- requires their own login now (previously
// a fully anonymous, unauthenticated pair of routes keyed only by a guessable id). ----

function minutesForAptitude(questionCount) {
  return Math.max(1, questionCount); // 1 minute per question, same convention as assessments.js
}

// Trims, lowercases, and collapses internal whitespace so "Paris", " paris ", and
// "Paris\n" all match -- an exact match otherwise, same strictness as an objective
// question's correctIndex, just for typed text instead of a picked option.
function normalizeAnswerText(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

router.get('/applicant/aptitude-test', requireApplicant, async (req, res) => {
  const application = await prisma.application.findFirst({ where: { applicantId: req.applicant.id } });
  if (!application) return res.status(404).json({ error: 'No application found.' });
  const sub = await prisma.aptitudeTestSubmission.findUnique({ where: { applicationId: application.id } });
  if (!sub || !sub.sentAt) return res.json({ test: null, aptitudeScheduledAt: application.aptitudeScheduledAt });
  if (sub.submittedAt) return res.json({ submitted: true, score: sub.score, total: sub.total, gradedAt: sub.gradedAt });

  const test = await prisma.aptitudeTest.findUnique({ where: { id: sub.testId }, include: { questions: true } });
  // Opening the test for the first time stamps startedAt -- the deadline anchor from
  // here on, same server-side-timer pattern as assessments.js's /start.
  const startedAt = sub.startedAt || (await prisma.aptitudeTestSubmission.update({ where: { id: sub.id }, data: { startedAt: new Date() } })).startedAt;
  const durationMin = minutesForAptitude(test.questions.length);
  res.json({
    test: {
      id: test.id,
      title: test.title,
      questions: test.questions.map((q) => ({
        id: q.id,
        text: q.text,
        order: q.order,
        questionType: q.questionType,
        options: q.questionType === 'THEORY' ? null : JSON.parse(q.options || '[]'),
      })),
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
  const answerMap = new Map((answers || []).map((a) => [a.questionId, a]));
  // Each question is a flat 10% regardless of bank size (capped at 10 questions on
  // the way in), not correctCount/total*100 -- matches "one question is 10%". THEORY
  // questions auto-grade too, the same way OBJECTIVE ones do: admin types the correct
  // answer into the question (modelAnswer) when setting up the test, and the
  // applicant's typed answer is compared against it (trimmed, case- and
  // whitespace-insensitive) -- an exact match either way, just like matching a
  // multiple-choice index. A question only falls back to manual grading (see
  // /aptitude-test/grade below) if admin left its correct answer blank when composing
  // it -- there's nothing to auto-match against in that case.
  let correctCount = 0;
  let hasUngraded = false;
  for (const q of test.questions) {
    if (q.questionType === 'THEORY') {
      if (!q.modelAnswer) { hasUngraded = true; continue; }
      const given = answerMap.get(q.id);
      if (given && normalizeAnswerText(given.text) === normalizeAnswerText(q.modelAnswer)) correctCount += 1;
      continue;
    }
    const a = answerMap.get(q.id);
    if (a && a.choice === q.correctIndex) correctCount += 1;
  }
  const total = test.questions.length * 10;

  const updated = await prisma.aptitudeTestSubmission.update({
    where: { id: sub.id },
    data: {
      answers: JSON.stringify(answers || []),
      submittedAt: new Date(),
      total,
      score: hasUngraded ? null : correctCount * 10,
      gradedAt: hasUngraded ? null : new Date(),
    },
  });
  res.json({ score: updated.score, total: updated.total, pendingGrading: hasUngraded });
});

// Admin awards each THEORY answer correct/incorrect (each still worth a flat 10%,
// same as an OBJECTIVE question) once the applicant has submitted -- the one manual
// step a mixed objective/theory aptitude test needs, mirroring how a mixed
// Assessment already needs Mark Work before its score is final. A pure-OBJECTIVE
// test never needs this: it's already fully scored at submit time above.
router.post('/admin/admissions/:id/aptitude-test/grade', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const application = await prisma.application.findFirst({ where: { id: req.params.id, schoolId: req.user.schoolId } });
  if (!application) return res.status(404).json({ error: 'Application not found' });
  const sub = await prisma.aptitudeTestSubmission.findUnique({
    where: { applicationId: application.id },
    include: { test: { include: { questions: true } } },
  });
  if (!sub || !sub.submittedAt) return res.status(400).json({ error: 'This applicant has not submitted the test yet.' });

  const { grades } = req.body; // [{ questionId, correct: boolean }] -- THEORY questions only,
  // an explicit override; any THEORY question not included here keeps its auto-match
  // result (below) rather than being silently zeroed out.
  const gradeMap = new Map((grades || []).map((g) => [g.questionId, !!g.correct]));
  const answers = JSON.parse(sub.answers || '[]');
  const answerMap = new Map(answers.map((a) => [a.questionId, a]));

  let correctCount = 0;
  for (const q of sub.test.questions) {
    if (q.questionType === 'THEORY') {
      if (gradeMap.has(q.id)) {
        if (gradeMap.get(q.id)) correctCount += 1;
      } else if (q.modelAnswer) {
        const given = answerMap.get(q.id);
        if (given && normalizeAnswerText(given.text) === normalizeAnswerText(q.modelAnswer)) correctCount += 1;
      }
    } else {
      const a = answerMap.get(q.id);
      if (a && a.choice === q.correctIndex) correctCount += 1;
    }
  }
  const updated = await prisma.aptitudeTestSubmission.update({
    where: { id: sub.id },
    data: {
      score: correctCount * 10,
      total: sub.test.questions.length * 10,
      theoryGrades: JSON.stringify(Object.fromEntries(gradeMap)),
      gradedAt: new Date(),
    },
  });
  res.json({ submission: updated });
});

async function generateMatricNumber(schoolName, departmentId, deptCode) {
  const prefix = schoolName.split(' ').map((w) => w[0]).join('').toUpperCase();
  const year = String(new Date().getFullYear()).slice(-2);
  const count = await prisma.user.count({ where: { departmentId, role: 'STUDENT' } });
  const seq = String(count + 1).padStart(3, '0');
  return `${prefix}/${year}/${deptCode}/${seq}`;
}

module.exports = router;
