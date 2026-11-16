const express = require('express');
const crypto = require('crypto');
const prisma = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { notify, notifySchoolAdmins } = require('../services/notification.service');

const router = express.Router();

// Admin actions on a request (transcript, clearance, hostel, disciplinary record) must only
// reach students of the admin's own school -- the id in the URL alone proves nothing.
// A missing schoolId would make Prisma drop the filter, so refuse that outright.
const inMySchool = (req) => (req.user.schoolId ? { student: { schoolId: req.user.schoolId } } : { id: '__none__' });

// ---- Transcript and other credentials ----
// A student asks the school for a transcript, a certificate, a statement of result, a letter or something else; the request lands
// with the school admin, who uploads the document (or, for a transcript, issues the one the system makes from the student's results)
// and the student is told. It then shows on the student's Transcript & Credentials page with a download.
const { memoryUpload, saveUpload } = require('../services/fileUpload.service');
const docUpload = memoryUpload(15);
const KINDS = { TRANSCRIPT: 'Transcript', CERTIFICATE: 'Certificate', STATEMENT_OF_RESULT: 'Statement of result', LETTER: 'Letter', OTHER: 'Other document' };
const requestLabel = (r) => (r.kind === 'OTHER' && r.title ? r.title : KINDS[r.kind] || 'Document');
const presentRequest = (r) => ({
  id: r.id, kind: r.kind, label: requestLabel(r), title: r.title, note: r.note, status: r.status, requestedAt: r.requestedAt, issuedAt: r.issuedAt,
  fileUrl: r.fileUrl, fileName: r.fileName, adminNote: r.adminNote,
});
const DOC_TYPES = /^(application\/pdf|application\/msword|application\/vnd\.openxmlformats-officedocument\.[a-z.]+|image\/(png|jpe?g|webp))$/;

router.post('/students/me/transcript-request', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const kind = KINDS[req.body && req.body.kind] ? req.body.kind : 'TRANSCRIPT';
  const title = String((req.body && req.body.title) || '').trim().slice(0, 120) || null;
  const note = String((req.body && req.body.note) || '').trim().slice(0, 400) || null;
  if (kind === 'OTHER' && !title) return res.status(400).json({ error: 'Say which document you need.' });
  const existing = await prisma.transcriptRequest.findFirst({ where: { studentId: req.user.id, status: 'PENDING', kind, ...(kind === 'OTHER' ? { title } : {}) } });
  if (existing) return res.json({ request: presentRequest(existing) });
  const request = await prisma.transcriptRequest.create({ data: { studentId: req.user.id, kind, title: kind === 'OTHER' ? title : null, note } });
  await notifySchoolAdmins(req.user.schoolId, `${requestLabel(request)} requested`, `${req.user.fullName}${req.user.matricNumber ? ' (' + req.user.matricNumber + ')' : ''} requested a ${requestLabel(request).toLowerCase()}.`, 'admin-student-requests');
  res.json({ request: presentRequest(request) });
});

// The latest transcript request (the Digital ID card still reads this one).
router.get('/students/me/transcript-request', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const request = await prisma.transcriptRequest.findFirst({ where: { studentId: req.user.id, kind: 'TRANSCRIPT' }, orderBy: { requestedAt: 'desc' } });
  res.json({ request: request ? presentRequest(request) : null });
});

// Everything the student has asked for, newest first, with the document when the school has sent it.
router.get('/students/me/transcript-requests', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const requests = await prisma.transcriptRequest.findMany({ where: { studentId: req.user.id }, orderBy: { requestedAt: 'desc' }, take: 50 });
  res.json({ requests: requests.map(presentRequest), kinds: KINDS });
});

router.get('/students/me/transcript', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const issued = await prisma.transcriptRequest.findFirst({ where: { studentId: req.user.id, kind: 'TRANSCRIPT', status: 'ISSUED' }, orderBy: { issuedAt: 'desc' } });
  if (!issued) return res.status(403).json({ error: 'No issued transcript yet. Request one first.' });
  const submissions = await prisma.submission.findMany({
    where: { studentId: req.user.id, submittedAt: { not: null } },
    include: { assessment: { include: { course: { select: { code: true, title: true } } } } },
    orderBy: { submittedAt: 'asc' },
  });
  res.json({
    issuedAt: issued.issuedAt, fileUrl: issued.fileUrl, fileName: issued.fileName,
    results: submissions.map((s) => ({
      courseCode: s.assessment.course.code,
      courseTitle: s.assessment.course.title,
      assessmentTitle: s.assessment.title,
      score: s.score,
      total: s.total,
    })),
  });
});

// Pending requests for the school admin, with who asked and for what; the ones already dealt with show underneath.
router.get('/admin/transcript-requests', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const include = { student: { select: { id: true, fullName: true, matricNumber: true, department: { select: { name: true } } } } };
  const [pending, done] = await Promise.all([
    prisma.transcriptRequest.findMany({ where: { status: 'PENDING', student: { schoolId: req.user.schoolId } }, include, orderBy: { requestedAt: 'asc' } }),
    prisma.transcriptRequest.findMany({ where: { status: { not: 'PENDING' }, student: { schoolId: req.user.schoolId } }, include, orderBy: { issuedAt: 'desc' }, take: 15 }),
  ]);
  const shape = (r) => ({ ...presentRequest(r), student: r.student });
  res.json({ requests: pending.map(shape), recent: done.map(shape) });
});

// Issue it: upload the document (a transcript can also be issued without one, and then the student opens the one the system
// makes from their results). The student is notified and it appears on their Transcript & Credentials page.
router.post('/admin/transcript-requests/:id/issue', requireAuth, requireRole('ADMIN'), docUpload.single('file'), async (req, res) => {
  const found = await prisma.transcriptRequest.findFirst({ where: { id: req.params.id, ...inMySchool(req) } });
  if (!found) return res.status(404).json({ error: 'Request not found' });
  if (found.status !== 'PENDING') return res.status(409).json({ error: 'This request has already been dealt with.' });
  if (!req.file && found.kind !== 'TRANSCRIPT') return res.status(400).json({ error: 'Upload the document to send to the student.' });
  if (req.file && !DOC_TYPES.test(req.file.mimetype)) return res.status(400).json({ error: 'Upload a PDF, a Word document or a photo.' });
  let fileUrl = null, fileName = null;
  if (req.file) { ({ url: fileUrl } = await saveUpload(req.file)); fileName = req.file.originalname.slice(0, 160); }
  const adminNote = String((req.body && req.body.note) || '').trim().slice(0, 300) || null;
  const request = await prisma.transcriptRequest.update({ where: { id: found.id }, data: { status: 'ISSUED', issuedAt: new Date(), fileUrl, fileName, adminNote } });
  await notify(request.studentId, `${requestLabel(request)} issued`, `Your ${requestLabel(request).toLowerCase()} is ready${fileUrl ? ' to download' : ' to view'} on your Transcript & Credentials page.`, 'transcript-hub');
  res.json({ request: presentRequest(request) });
});

router.post('/admin/transcript-requests/:id/decline', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const found = await prisma.transcriptRequest.findFirst({ where: { id: req.params.id, ...inMySchool(req) } });
  if (!found) return res.status(404).json({ error: 'Request not found' });
  if (found.status !== 'PENDING') return res.status(409).json({ error: 'This request has already been dealt with.' });
  const adminNote = String((req.body && req.body.reason) || '').trim().slice(0, 300);
  if (!adminNote) return res.status(400).json({ error: 'Say why, so the student knows what to do.' });
  const request = await prisma.transcriptRequest.update({ where: { id: found.id }, data: { status: 'DECLINED', adminNote, issuedAt: new Date() } });
  await notify(request.studentId, `${requestLabel(request)} request not granted`, adminNote, 'transcript-hub');
  res.json({ request: presentRequest(request) });
});

// ---- Clearance ----

router.post('/students/me/clearance-request', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const existing = await prisma.clearanceRequest.findFirst({ where: { studentId: req.user.id, status: 'PENDING' } });
  if (existing) return res.json({ request: existing });
  const request = await prisma.clearanceRequest.create({ data: { studentId: req.user.id } });
  await notifySchoolAdmins(req.user.schoolId, 'Clearance requested', `${req.user.fullName} requested clearance.`, 'admin-student-requests');
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
  const found = await prisma.clearanceRequest.findFirst({ where: { id: req.params.id, ...inMySchool(req) } });
  if (!found) return res.status(404).json({ error: 'Request not found' });
  const request = await prisma.clearanceRequest.update({
    where: { id: found.id },
    data: { status, note: note || null, decidedAt: new Date() },
  });
  await notify(request.studentId, 'Clearance update', status === 'CLEARED' ? 'You have been cleared.' : `Clearance denied${note ? `: ${note}` : ''}.`, 'clearance');
  res.json({ request });
});

// ---- Hostel ----

router.post('/students/me/hostel-application', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const existing = await prisma.hostelApplication.findFirst({ where: { studentId: req.user.id, status: 'PENDING' } });
  if (existing) return res.json({ application: existing });
  const application = await prisma.hostelApplication.create({
    data: { studentId: req.user.id, roomPreference: req.body.roomPreference || null },
  });
  await notifySchoolAdmins(req.user.schoolId, 'Hostel application received', `${req.user.fullName} applied for hostel accommodation.`, 'admin-hostel-allocations');
  res.json({ application });
});

router.get('/students/me/hostel-application', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const application = await prisma.hostelApplication.findFirst({
    where: { studentId: req.user.id },
    include: { hostel: { select: { name: true } } },
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
  const found = await prisma.hostelApplication.findFirst({ where: { id: req.params.id, ...inMySchool(req) } });
  if (!found) return res.status(404).json({ error: 'Application not found' });
  const application = await prisma.hostelApplication.update({
    where: { id: found.id },
    data: { status: 'APPROVED', hostelId, roomAssigned: roomAssigned || 'To be confirmed', decidedAt: new Date() },
  });
  await notify(application.studentId, 'Hostel application approved', `You've been allocated to ${hostel.name}${roomAssigned ? `, room ${roomAssigned}` : ''}.`, 'hostel');
  res.json({ application });
});

router.post('/admin/hostel-applications/:id/reject', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const found = await prisma.hostelApplication.findFirst({ where: { id: req.params.id, ...inMySchool(req) } });
  if (!found) return res.status(404).json({ error: 'Application not found' });
  const application = await prisma.hostelApplication.update({
    where: { id: found.id },
    data: { status: 'REJECTED', decidedAt: new Date() },
  });
  await notify(application.studentId, 'Hostel application update', 'Your hostel application was not approved.', 'hostel');
  res.json({ application });
});

// ---- Digital credentials (e.g. graduation certificates), publicly verifiable ----

router.post('/admin/credentials', requireAuth, requireRole('ADMIN'), docUpload.single('file'), async (req, res) => {
  const { studentId } = req.body;
  const title = String((req.body && req.body.title) || '').trim().slice(0, 160);
  if (!studentId || !title) return res.status(400).json({ error: 'Student and credential title are required.' });
  const student = await prisma.user.findFirst({ where: { id: studentId, schoolId: req.user.schoolId, role: 'STUDENT' } });
  if (!student) return res.status(404).json({ error: 'Student not found' });
  if (req.file && !DOC_TYPES.test(req.file.mimetype)) return res.status(400).json({ error: 'Upload a PDF, a Word document or a photo.' });
  let fileUrl = null, fileName = null;
  if (req.file) { ({ url: fileUrl } = await saveUpload(req.file)); fileName = req.file.originalname.slice(0, 160); }

  const verifyCode = crypto.randomBytes(6).toString('hex');
  const credential = await prisma.credential.create({ data: { studentId, title, verifyCode, fileUrl, fileName } });
  // the student hears about it and finds it (with the document) on their Transcript & Credentials page
  await notify(studentId, 'A credential was issued to you', `${title} is ready${fileUrl ? ' to download' : ''} on your Transcript & Credentials page.`, 'transcript-hub');
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

// ---- Academic Record: the full academic/bio profile a student and their school
// admin both need in one place (personal details, level, GPA, exam/assignment
// completion, disciplinary record). Programme length varies by institution and course
// (ND/NCE 2-3 years, a bachelor's 4-6), so it's a per-student field the admin sets;
// until they do, expectedGraduationYear assumes a 4-year programme.
const DEFAULT_PROGRAMME_YEARS = 4;
const GRADE_POINTS = { A: 5, B: 4, C: 3, D: 2, E: 1, F: 0 };

async function computeAcademicRecord(student) {
  const [enrollments, results, disciplinaryRecords] = await Promise.all([
    prisma.enrollment.findMany({ where: { studentId: student.id }, select: { courseId: true } }),
    prisma.result.findMany({ where: { studentId: student.id } }),
    prisma.disciplinaryRecord.findMany({ where: { studentId: student.id }, orderBy: { createdAt: 'desc' } }),
  ]);
  const courseIds = enrollments.map((e) => e.courseId);

  const [assessments, assignments, submissions, assignmentSubmissions] = await Promise.all([
    courseIds.length ? prisma.assessment.findMany({ where: { courseId: { in: courseIds }, generated: false }, select: { id: true, type: true } }) : [],
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
  const computedCgpa = gradedResults.length
    ? Number((gradedResults.reduce((sum, r) => sum + GRADE_POINTS[r.grade.toUpperCase()], 0) / gradedResults.length).toFixed(2))
    : null;
  // The campus admin's own figure wins; otherwise the average of the published grades.
  const cgpa = student.cgpa != null ? student.cgpa : computedCgpa;

  return {
    id: student.id,
    avatarUrl: student.avatarUrl,
    createdAt: student.createdAt,
    yearOfStudy: student.yearOfStudy,
    fullName: student.fullName,
    email: student.email,
    phone: student.phone,
    matricNumber: student.matricNumber,
    courseOfStudy: student.courseOfStudy || null,
    accessCode: student.accessCode,
    status: student.status,
    department: student.department ? student.department.name : null,
    level: student.yearOfStudy ? `${student.yearOfStudy * 100}L` : null,
    classPosition: student.classPosition,
    yearOfAdmission: student.yearOfAdmission,
    programmeYears: student.programmeYears,
    expectedGraduationYear: student.yearOfAdmission ? student.yearOfAdmission + (student.programmeYears || DEFAULT_PROGRAMME_YEARS) : null,
    cgpa,
    cgpaEntered: student.cgpa != null,
    exams: countDoneMissed(exams, submittedAssessmentIds),
    tests: countDoneMissed(tests, submittedAssessmentIds),
    assignments: countDoneMissed(assignments, submittedAssignmentIds),
    disciplinaryIssueCount: disciplinaryRecords.length,
    disciplinaryRecords,
  };
}

router.get('/students/me/academic-record', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const student = await prisma.user.findUnique({ where: { id: req.user.id }, include: { department: true } });
  res.json(await computeAcademicRecord(student));
});

router.get('/admin/students/:id/academic-record', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const student = await prisma.user.findFirst({ where: { id: req.params.id, schoolId: req.user.schoolId, role: 'STUDENT' }, include: { department: true } });
  if (!student) return res.status(404).json({ error: 'Student not found' });
  res.json(await computeAcademicRecord(student));
});

router.post('/admin/students/:id/disciplinary-records', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const { title, description } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'A title is required.' });
  const student = await prisma.user.findFirst({ where: { id: req.params.id, schoolId: req.user.schoolId, role: 'STUDENT' } });
  if (!student) return res.status(404).json({ error: 'Student not found' });
  const record = await prisma.disciplinaryRecord.create({
    data: { studentId: student.id, title: title.trim(), description: description || null, recordedById: req.user.id },
  });
  await notify(student.id, 'Disciplinary record added', title.trim(), 'academic-record');
  res.json({ record });
});

router.post('/admin/disciplinary-records/:id/resolve', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const found = await prisma.disciplinaryRecord.findFirst({ where: { id: req.params.id, ...inMySchool(req) } });
  if (!found) return res.status(404).json({ error: 'Record not found' });
  const record = await prisma.disciplinaryRecord.update({ where: { id: found.id }, data: { status: 'RESOLVED' } });
  await notify(record.studentId, 'Disciplinary record resolved', record.title, 'academic-record');
  res.json({ record });
});

router.post('/admin/students/:id/academic-details', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const { yearOfAdmission, classPosition, programmeYears, cgpa } = req.body;
  if (cgpa !== undefined && cgpa !== '' && cgpa !== null && !(Number(cgpa) >= 0 && Number(cgpa) <= 5)) return res.status(400).json({ error: 'CGPA must be a number from 0 to 5.' });
  const student = await prisma.user.findFirst({ where: { id: req.params.id, schoolId: req.user.schoolId, role: 'STUDENT' } });
  if (!student) return res.status(404).json({ error: 'Student not found' });
  const updated = await prisma.user.update({
    where: { id: student.id },
    data: {
      yearOfAdmission: yearOfAdmission ? parseInt(yearOfAdmission, 10) : student.yearOfAdmission,
      programmeYears: programmeYears ? parseInt(programmeYears, 10) : student.programmeYears,
      classPosition: classPosition !== undefined ? (classPosition || null) : student.classPosition,
      ...(cgpa !== undefined ? { cgpa: cgpa === '' || cgpa === null ? null : Number(Number(cgpa).toFixed(2)) } : {}),
    },
  });
  res.json({ student: updated });
});

module.exports = router;
// Exported so lecturer-facing routes (academics.js "My Students" detail) can reuse the
// exact same comprehensive-details computation the student/admin Academic Record
// screens use, instead of building a second copy of the same aggregation.
module.exports.computeAcademicRecord = computeAcademicRecord;
