const express = require('express');
const crypto = require('crypto');
const prisma = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { notify } = require('../services/notification.service');

const router = express.Router();

// ---- Transcript ----

router.post('/students/me/transcript-request', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const existing = await prisma.transcriptRequest.findFirst({
    where: { studentId: req.user.id, status: 'PENDING' },
  });
  if (existing) return res.json({ request: existing });
  const request = await prisma.transcriptRequest.create({ data: { studentId: req.user.id } });
  res.json({ request });
});

router.get('/students/me/transcript-request', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const request = await prisma.transcriptRequest.findFirst({
    where: { studentId: req.user.id },
    orderBy: { requestedAt: 'desc' },
  });
  res.json({ request });
});

router.get('/students/me/transcript', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const issued = await prisma.transcriptRequest.findFirst({ where: { studentId: req.user.id, status: 'ISSUED' } });
  if (!issued) return res.status(403).json({ error: 'No issued transcript yet. Request one first.' });
  const submissions = await prisma.submission.findMany({
    where: { studentId: req.user.id, submittedAt: { not: null } },
    include: { assessment: { include: { course: { select: { code: true, title: true } } } } },
    orderBy: { submittedAt: 'asc' },
  });
  res.json({
    issuedAt: issued.issuedAt,
    results: submissions.map((s) => ({
      courseCode: s.assessment.course.code,
      courseTitle: s.assessment.course.title,
      assessmentTitle: s.assessment.title,
      score: s.score,
      total: s.total,
    })),
  });
});

router.get('/admin/transcript-requests', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const requests = await prisma.transcriptRequest.findMany({
    where: { status: 'PENDING', student: { schoolId: req.user.schoolId } },
    include: { student: { select: { fullName: true, matricNumber: true } } },
    orderBy: { requestedAt: 'asc' },
  });
  res.json({ requests });
});

router.post('/admin/transcript-requests/:id/issue', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const request = await prisma.transcriptRequest.update({
    where: { id: req.params.id },
    data: { status: 'ISSUED', issuedAt: new Date() },
  });
  await notify(request.studentId, 'Transcript issued', 'Your official transcript is ready to view.', 'digital-id');
  res.json({ request });
});

// ---- Clearance ----

router.post('/students/me/clearance-request', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const existing = await prisma.clearanceRequest.findFirst({ where: { studentId: req.user.id, status: 'PENDING' } });
  if (existing) return res.json({ request: existing });
  const request = await prisma.clearanceRequest.create({ data: { studentId: req.user.id } });
  res.json({ request });
});

router.get('/students/me/clearance-request', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const request = await prisma.clearanceRequest.findFirst({
    where: { studentId: req.user.id },
    orderBy: { requestedAt: 'desc' },
  });
  res.json({ request });
});

router.get('/admin/clearance-requests', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const requests = await prisma.clearanceRequest.findMany({
    where: { status: 'PENDING', student: { schoolId: req.user.schoolId } },
    include: { student: { select: { fullName: true, matricNumber: true } } },
    orderBy: { requestedAt: 'asc' },
  });
  res.json({ requests });
});

router.post('/admin/clearance-requests/:id/decide', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const { status, note } = req.body;
  if (!['CLEARED', 'DENIED'].includes(status)) return res.status(400).json({ error: 'Status must be CLEARED or DENIED.' });
  const request = await prisma.clearanceRequest.update({
    where: { id: req.params.id },
    data: { status, note: note || null, decidedAt: new Date() },
  });
  await notify(request.studentId, 'Clearance update', status === 'CLEARED' ? 'You have been cleared.' : `Clearance denied${note ? `: ${note}` : ''}.`, 'digital-id');
  res.json({ request });
});

// ---- Hostel ----

router.post('/students/me/hostel-application', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const existing = await prisma.hostelApplication.findFirst({ where: { studentId: req.user.id, status: 'PENDING' } });
  if (existing) return res.json({ application: existing });
  const application = await prisma.hostelApplication.create({
    data: { studentId: req.user.id, roomPreference: req.body.roomPreference || null },
  });
  res.json({ application });
});

router.get('/students/me/hostel-application', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const application = await prisma.hostelApplication.findFirst({
    where: { studentId: req.user.id },
    orderBy: { requestedAt: 'desc' },
  });
  res.json({ application });
});

router.get('/admin/hostel-applications', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const applications = await prisma.hostelApplication.findMany({
    where: { status: 'PENDING', student: { schoolId: req.user.schoolId } },
    include: { student: { select: { fullName: true, matricNumber: true } } },
    orderBy: { requestedAt: 'asc' },
  });
  res.json({ applications });
});

router.post('/admin/hostel-applications/:id/approve', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const { hostelId, roomAssigned } = req.body;
  if (!hostelId) return res.status(400).json({ error: 'Choose a hostel to allocate into.' });
  const hostel = await prisma.hostel.findFirst({ where: { id: hostelId, schoolId: req.user.schoolId } });
  if (!hostel) return res.status(404).json({ error: 'Hostel not found' });
  const application = await prisma.hostelApplication.update({
    where: { id: req.params.id },
    data: { status: 'APPROVED', hostelId, roomAssigned: roomAssigned || 'To be confirmed', decidedAt: new Date() },
  });
  await notify(application.studentId, 'Hostel application approved', `You've been allocated to ${hostel.name}${roomAssigned ? `, room ${roomAssigned}` : ''}.`, 'digital-id');
  res.json({ application });
});

router.post('/admin/hostel-applications/:id/reject', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const application = await prisma.hostelApplication.update({
    where: { id: req.params.id },
    data: { status: 'REJECTED', decidedAt: new Date() },
  });
  await notify(application.studentId, 'Hostel application update', 'Your hostel application was not approved.', 'digital-id');
  res.json({ application });
});

// ---- Digital credentials (e.g. graduation certificates), publicly verifiable ----

router.post('/admin/credentials', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const { studentId, title } = req.body;
  if (!studentId || !title) return res.status(400).json({ error: 'Student and credential title are required.' });
  const student = await prisma.user.findFirst({ where: { id: studentId, schoolId: req.user.schoolId, role: 'STUDENT' } });
  if (!student) return res.status(404).json({ error: 'Student not found' });

  const verifyCode = crypto.randomBytes(6).toString('hex');
  const credential = await prisma.credential.create({ data: { studentId, title, verifyCode } });
  res.json({ credential });
});

router.get('/students/me/credentials', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const credentials = await prisma.credential.findMany({ where: { studentId: req.user.id }, orderBy: { issuedAt: 'desc' } });
  res.json({ credentials });
});

// Public: no auth, so anyone with the code (e.g. an employer) can verify a credential.
router.get('/verify/:code', async (req, res) => {
  const credential = await prisma.credential.findUnique({
    where: { verifyCode: req.params.code },
    include: { student: { select: { fullName: true, matricNumber: true, school: { select: { name: true } } } } },
  });
  if (!credential) return res.status(404).json({ valid: false });
  res.json({
    valid: true,
    title: credential.title,
    studentName: credential.student.fullName,
    matricNumber: credential.student.matricNumber,
    school: credential.student.school.name,
    issuedAt: credential.issuedAt,
  });
});

// ---- Admission Status: the full academic/bio profile a student and their school
// admin both need in one place (personal details, level, GPA, exam/assignment
// completion, disciplinary record). Nigerian NCE programmes run 3 years; there's no
// per-student program-length field, so expectedGraduationYear assumes that -- noted
// explicitly rather than silently guessing.
const PROGRAM_DURATION_YEARS = 3;
const GRADE_POINTS = { A: 5, B: 4, C: 3, D: 2, E: 1, F: 0 };

async function computeAdmissionStatus(student) {
  const [enrollments, results, disciplinaryRecords] = await Promise.all([
    prisma.enrollment.findMany({ where: { studentId: student.id }, select: { courseId: true } }),
    prisma.result.findMany({ where: { studentId: student.id } }),
    prisma.disciplinaryRecord.findMany({ where: { studentId: student.id }, orderBy: { createdAt: 'desc' } }),
  ]);
  const courseIds = enrollments.map((e) => e.courseId);

  const [assessments, assignments, submissions, assignmentSubmissions] = await Promise.all([
    courseIds.length ? prisma.assessment.findMany({ where: { courseId: { in: courseIds } }, select: { id: true, type: true } }) : [],
    courseIds.length ? prisma.assignment.findMany({ where: { courseId: { in: courseIds } }, select: { id: true } }) : [],
    prisma.submission.findMany({ where: { studentId: student.id }, select: { assessmentId: true, submittedAt: true } }),
    prisma.assignmentSubmission.findMany({ where: { studentId: student.id }, select: { assignmentId: true } }),
  ]);

  const submittedAssessmentIds = new Set(submissions.filter((s) => s.submittedAt).map((s) => s.assessmentId));
  const submittedAssignmentIds = new Set(assignmentSubmissions.map((s) => s.assignmentId));
  const exams = assessments.filter((a) => a.type === 'SEMESTER_EXAM');
  const tests = assessments.filter((a) => ['CA', 'Test', 'Mock'].includes(a.type));

  const countDoneMissed = (items, doneIds) => ({
    total: items.length,
    done: items.filter((i) => doneIds.has(i.id)).length,
    missed: items.filter((i) => !doneIds.has(i.id)).length,
  });

  const gradedResults = results.filter((r) => r.grade && GRADE_POINTS[r.grade.toUpperCase()] != null);
  const cgpa = gradedResults.length
    ? Number((gradedResults.reduce((sum, r) => sum + GRADE_POINTS[r.grade.toUpperCase()], 0) / gradedResults.length).toFixed(2))
    : null;

  return {
    fullName: student.fullName,
    email: student.email,
    phone: student.phone,
    matricNumber: student.matricNumber,
    status: student.status,
    department: student.department ? student.department.name : null,
    level: student.yearOfStudy ? `${student.yearOfStudy * 100}L` : null,
    classPosition: student.classPosition,
    yearOfAdmission: student.yearOfAdmission,
    expectedGraduationYear: student.yearOfAdmission ? student.yearOfAdmission + PROGRAM_DURATION_YEARS : null,
    cgpa,
    exams: countDoneMissed(exams, submittedAssessmentIds),
    tests: countDoneMissed(tests, submittedAssessmentIds),
    assignments: countDoneMissed(assignments, submittedAssignmentIds),
    disciplinaryIssueCount: disciplinaryRecords.length,
    disciplinaryRecords,
  };
}

router.get('/students/me/admission-status', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const student = await prisma.user.findUnique({ where: { id: req.user.id }, include: { department: true } });
  res.json(await computeAdmissionStatus(student));
});

router.get('/admin/students/:id/admission-status', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const student = await prisma.user.findFirst({ where: { id: req.params.id, schoolId: req.user.schoolId, role: 'STUDENT' }, include: { department: true } });
  if (!student) return res.status(404).json({ error: 'Student not found' });
  res.json(await computeAdmissionStatus(student));
});

router.post('/admin/students/:id/disciplinary-records', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const { title, description } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'A title is required.' });
  const student = await prisma.user.findFirst({ where: { id: req.params.id, schoolId: req.user.schoolId, role: 'STUDENT' } });
  if (!student) return res.status(404).json({ error: 'Student not found' });
  const record = await prisma.disciplinaryRecord.create({
    data: { studentId: student.id, title: title.trim(), description: description || null, recordedById: req.user.id },
  });
  await notify(student.id, 'Disciplinary record added', title.trim(), 'admission-status');
  res.json({ record });
});

router.post('/admin/disciplinary-records/:id/resolve', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const record = await prisma.disciplinaryRecord.update({ where: { id: req.params.id }, data: { status: 'RESOLVED' } });
  res.json({ record });
});

router.post('/admin/students/:id/admission-details', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const { yearOfAdmission, classPosition } = req.body;
  const student = await prisma.user.findFirst({ where: { id: req.params.id, schoolId: req.user.schoolId, role: 'STUDENT' } });
  if (!student) return res.status(404).json({ error: 'Student not found' });
  const updated = await prisma.user.update({
    where: { id: student.id },
    data: {
      yearOfAdmission: yearOfAdmission ? parseInt(yearOfAdmission, 10) : student.yearOfAdmission,
      classPosition: classPosition !== undefined ? (classPosition || null) : student.classPosition,
    },
  });
  res.json({ student: updated });
});

module.exports = router;
