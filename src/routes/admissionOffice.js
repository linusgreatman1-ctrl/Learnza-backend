const express = require('express');
const prisma = require('../db');
const { requireAuth, requireRole } = require('../auth');

// Admission (school admin): the file of every student from the day and year they were admitted: how they came in, their
// present class, and everything on record since: results, tests and exams, fee payments, project, attendance, discipline,
// plus whatever older records the admin types in (an old result, a fee paid before the system, ...).
const router = express.Router();
const A = [requireAuth, requireRole('ADMIN')];

const clean = (v, n) => String(v == null ? '' : v).trim().slice(0, n) || null;
const KINDS = ['EXAM', 'TEST', 'RESULT', 'FEE', 'PROJECT', 'OTHER'];
const MODES = ['UTME', 'DIRECT_ENTRY', 'TRANSFER', 'OTHER'];

async function ownStudent(req, id) {
  return prisma.user.findFirst({ where: { id, role: 'STUDENT', schoolId: req.user.schoolId }, include: { department: { select: { name: true } } } });
}

router.get('/admin/admission/students', ...A, async (req, res) => {
  const search = String(req.query.search || '').trim();
  const where = { role: 'STUDENT', schoolId: req.user.schoolId };
  if (search) where.OR = [{ fullName: { contains: search, mode: 'insensitive' } }, { matricNumber: { contains: search, mode: 'insensitive' } }];
  const students = await prisma.user.findMany({ where, orderBy: { fullName: 'asc' }, take: 500, select: { id: true, fullName: true, matricNumber: true, yearOfStudy: true, yearOfAdmission: true, status: true, department: { select: { name: true } } } });
  const adm = await prisma.studentAdmission.findMany({ where: { studentId: { in: students.map((s) => s.id) } } });
  let rows = students.map((s) => {
    const a = adm.find((x) => x.studentId === s.id);
    return { id: s.id, fullName: s.fullName, matricNumber: s.matricNumber, department: s.department && s.department.name, level: s.yearOfStudy ? s.yearOfStudy * 100 + 'L' : null, status: s.status,
      admissionYear: (a && a.admissionYear) || s.yearOfAdmission || null, admissionDate: a && a.admissionDate, admissionNo: a && a.admissionNo, hasFile: !!a };
  });
  if (req.query.year) rows = rows.filter((r) => String(r.admissionYear) === String(req.query.year));
  const years = [...new Set(students.map((s) => (adm.find((x) => x.studentId === s.id) || {}).admissionYear || s.yearOfAdmission).filter(Boolean))].sort((a, b) => b - a);
  res.json({ students: rows, years });
});

router.get('/admin/admission/students/:id', ...A, async (req, res) => {
  const s = await ownStudent(req, req.params.id);
  if (!s) return res.status(404).json({ error: 'Student not found.' });
  const [admission, entries, results, subs, fees, project, attendance, discipline, enrolments] = await Promise.all([
    prisma.studentAdmission.findUnique({ where: { studentId: s.id } }),
    prisma.studentRecordEntry.findMany({ where: { studentId: s.id, schoolId: req.user.schoolId }, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }] }),
    prisma.result.findMany({ where: { studentId: s.id, sentAt: { not: null } }, include: { course: { select: { code: true, title: true } } }, orderBy: { publishedAt: 'desc' } }),
    prisma.submission.findMany({ where: { studentId: s.id, submittedAt: { not: null } }, include: { assessment: { select: { title: true, type: true, course: { select: { code: true } } } } }, orderBy: { submittedAt: 'desc' }, take: 200 }),
    prisma.feePayment.findMany({ where: { studentId: s.id, schoolId: req.user.schoolId }, orderBy: { createdAt: 'desc' } }),
    prisma.project.findFirst({ where: { studentId: s.id }, orderBy: { updatedAt: 'desc' } }),
    prisma.classAttendanceRecord.groupBy({ by: ['status'], where: { studentId: s.id }, _count: true }),
    prisma.disciplinaryRecord.findMany({ where: { studentId: s.id }, orderBy: { createdAt: 'desc' } }),
    prisma.enrollment.findMany({ where: { studentId: s.id }, include: { course: { select: { code: true, title: true, level: true, semester: true } } } }),
  ]);
  // each test or exam: objective and theory shown together
  const { scoreView } = require('./assessments');
  const qs = await prisma.question.findMany({ where: { assessmentId: { in: [...new Set(subs.map((x) => x.assessmentId))] } }, select: { assessmentId: true, questionType: true } });
  const tests = subs.map((x) => ({ id: x.id, title: x.assessment.title, type: x.assessment.type, course: x.assessment.course && x.assessment.course.code, submittedAt: x.submittedAt, score: x.score, total: x.total, view: scoreView(x, qs.filter((q) => q.assessmentId === x.assessmentId)) }));
  let projectOut = null;
  if (project) {
    const [chapters, defense] = await Promise.all([prisma.projectChapter.findMany({ where: { projectId: project.id }, select: { number: true, status: true } }), prisma.projectDefense.findUnique({ where: { projectId: project.id } })]);
    projectOut = { title: project.title, status: project.status, session: project.session, supervisorScore: project.supervisorScore, finalScore: project.finalScore,
      chaptersApproved: chapters.filter((c) => c.status === 'APPROVED' && c.number <= 5).length, defense: defense ? { scheduledAt: defense.scheduledAt, venue: defense.venue, verdict: defense.verdict, panelTotal: defense.panelTotal } : null };
  }
  const present = (attendance.find((a) => a.status === 'PRESENT') || { _count: 0 })._count, absent = (attendance.find((a) => a.status === 'ABSENT') || { _count: 0 })._count;
  const confirmed = fees.filter((f) => f.status === 'CONFIRMED');
  res.json({
    student: { id: s.id, fullName: s.fullName, matricNumber: s.matricNumber, email: /@internal\.learnza\.local$/.test(s.email || '') ? null : s.email, phone: s.phone, department: s.department && s.department.name, courseOfStudy: s.courseOfStudy, level: s.yearOfStudy ? s.yearOfStudy * 100 + 'L' : null,
      status: s.status, cgpa: s.cgpa, classPosition: s.classPosition, yearOfAdmission: s.yearOfAdmission, programmeYears: s.programmeYears, avatarUrl: s.avatarUrl, createdAt: s.createdAt },
    admission, entries,
    results: results.map((r) => ({ id: r.id, course: r.course.code + ' — ' + r.course.title, term: r.term, score: r.score, grade: r.grade, remark: r.remark, publishedAt: r.publishedAt })),
    tests,
    fees: { payments: fees.map((f) => ({ id: f.id, status: f.status, amountKobo: f.amountKobo, method: f.method, paidOn: f.paidOn, reference: f.reference, receiptNo: f.receiptNo, items: f.items })), paidKobo: confirmed.reduce((a, f) => a + f.amountKobo, 0) },
    project: projectOut,
    attendance: { present, absent },
    discipline: discipline.map((d) => ({ id: d.id, title: d.title, description: d.description, status: d.status, createdAt: d.createdAt })),
    courses: enrolments.map((e) => ({ code: e.course.code, title: e.course.title, level: e.course.level, semester: e.course.semester })),
  });
});

router.put('/admin/admission/students/:id', ...A, async (req, res) => {
  const s = await ownStudent(req, req.params.id);
  if (!s) return res.status(404).json({ error: 'Student not found.' });
  const b = req.body || {};
  const date = (v) => { if (!v) return null; const d = new Date(v); return isNaN(d.getTime()) ? undefined : d; };
  const admissionDate = date(b.admissionDate), dateOfBirth = date(b.dateOfBirth);
  if (admissionDate === undefined || dateOfBirth === undefined) return res.status(400).json({ error: 'One of the dates is not valid.' });
  let admissionYear = b.admissionYear ? parseInt(b.admissionYear, 10) : (admissionDate ? admissionDate.getFullYear() : null);
  if (admissionYear !== null && !(admissionYear >= 1960 && admissionYear <= new Date().getFullYear() + 1)) return res.status(400).json({ error: 'Enter a valid admission year.' });
  const data = {
    admissionNo: clean(b.admissionNo, 40), admissionDate, admissionYear, entryLevel: clean(b.entryLevel, 30), modeOfEntry: MODES.includes(b.modeOfEntry) ? b.modeOfEntry : null,
    jambRegNo: clean(b.jambRegNo, 30), previousSchool: clean(b.previousSchool, 160), gender: ['MALE', 'FEMALE'].includes(b.gender) ? b.gender : null, dateOfBirth,
    stateOfOrigin: clean(b.stateOfOrigin, 60), address: clean(b.address, 240), guardianName: clean(b.guardianName, 120), guardianPhone: clean(b.guardianPhone, 30), note: clean(b.note, 1000),
  };
  const row = await prisma.studentAdmission.upsert({ where: { studentId: s.id }, update: data, create: { ...data, studentId: s.id, schoolId: req.user.schoolId } });
  // the year shows on the student's own record too
  if (admissionYear && admissionYear !== s.yearOfAdmission) await prisma.user.update({ where: { id: s.id }, data: { yearOfAdmission: admissionYear } });
  res.json({ admission: row });
});

router.post('/admin/admission/students/:id/records', ...A, async (req, res) => {
  const s = await ownStudent(req, req.params.id);
  if (!s) return res.status(404).json({ error: 'Student not found.' });
  const b = req.body || {};
  const title = clean(b.title, 160);
  if (!title) return res.status(400).json({ error: 'Say what the record is (for example "First semester exam, MTH 101").' });
  const num = (v) => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v));
  const d = b.date ? new Date(b.date) : null;
  const row = await prisma.studentRecordEntry.create({ data: {
    schoolId: req.user.schoolId, studentId: s.id, kind: KINDS.includes(b.kind) ? b.kind : 'OTHER', session: clean(b.session, 30), term: clean(b.term, 40), title,
    score: num(b.score), maxScore: num(b.maxScore), amountKobo: num(b.amountNaira) != null ? Math.round(num(b.amountNaira) * 100) : null, date: d && !isNaN(d.getTime()) ? d : null, note: clean(b.note, 500), enteredById: req.user.id,
  } });
  res.json({ record: row });
});

router.delete('/admin/admission/records/:rid', ...A, async (req, res) => {
  await prisma.studentRecordEntry.deleteMany({ where: { id: req.params.rid, schoolId: req.user.schoolId } });
  res.json({ ok: true });
});

module.exports = router;
