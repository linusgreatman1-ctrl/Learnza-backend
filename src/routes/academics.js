const express = require('express');
const prisma = require('../db');
const { requireAuth, requireRole, logActivity } = require('../auth');
const { getSubscriptionStatus, isEnforced } = require('../subscription');
const { memoryUpload, saveUpload } = require('../services/fileUpload.service');
const { getCurrentSemesterId } = require('../semester');
const { computeAcademicRecord } = require('./records');
const { notifyMany } = require('../services/notification.service');
const photoUpload = memoryUpload(5);
const { loadCourse, hasSchool, departmentsInSchool } = require('../scope');

const router = express.Router();
const upload = memoryUpload(80); // videos run larger than library documents

// Any logged-in school member (admin/lecturer/student) can read the school's semester
// list -- used to drive the semester switcher in every dashboard header.
router.get('/semesters', requireAuth, async (req, res) => {
  if (!req.user.schoolId) return res.json({ semesters: [] });
  // Chronological (creation) order, not newest-first -- semesters are created in
  // sequence as the school year progresses, so this is what puts "First Semester"
  // before "Second Semester" instead of showing whichever was set up most recently.
  const semesters = await prisma.semester.findMany({
    where: { schoolId: req.user.schoolId },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ semesters });
});

// A school only ever sees its own departments and courses. (Users with no school -- independent
// learners -- have none; an unscoped query here would list every school's.)
router.get('/departments', requireAuth, async (req, res) => {
  if (!hasSchool(req.user)) return res.json({ departments: [] });
  const departments = await prisma.department.findMany({
    where: { schoolId: req.user.schoolId },
    orderBy: { name: 'asc' },
  });
  res.json({ departments });
});

router.get('/departments/:id/courses', requireAuth, async (req, res) => {
  if (!hasSchool(req.user) || !(await departmentsInSchool([req.params.id], req.user.schoolId))) return res.json({ courses: [] });
  const courses = await prisma.course.findMany({
    where: { departmentId: req.params.id },
    orderBy: [{ level: 'asc' }, { code: 'asc' }],
  });
  res.json({ courses });
});

router.get('/courses/:id', requireAuth, loadCourse(), async (req, res) => {
  const course = await prisma.course.findUnique({ where: { id: req.course.id }, include: { department: true } });
  res.json({ course });
});

// Student: my enrolled courses
router.get('/students/me/courses', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const enrollments = await prisma.enrollment.findMany({
    where: { studentId: req.user.id },
    include: { course: { include: { department: true } } },
  });
  res.json({ courses: enrollments.map((e) => e.course) });
});

router.post('/courses/:id/enroll', requireAuth, requireRole('STUDENT'), loadCourse(), async (req, res) => {
  const courseId = req.course.id;
  const existing = await prisma.enrollment.findUnique({
    where: { studentId_courseId: { studentId: req.user.id, courseId } },
  });
  if (existing) return res.json({ ok: true, alreadyEnrolled: true });
  await prisma.enrollment.create({ data: { studentId: req.user.id, courseId } });
  res.json({ ok: true });
});

router.delete('/courses/:id/enroll', requireAuth, requireRole('STUDENT'), loadCourse(), async (req, res) => {
  await prisma.enrollment.deleteMany({ where: { studentId: req.user.id, courseId: req.course.id } });
  res.json({ ok: true });
});

router.get('/courses/:id/enrollment-count', requireAuth, requireRole('LECTURER', 'ADMIN'), loadCourse(), async (req, res) => {
  const count = await prisma.enrollment.count({ where: { courseId: req.course.id } });
  res.json({ count });
});

// "My Students" -- the class roster for one course, so a lecturer can see everyone in
// that class before drilling into an individual student's comprehensive details.
router.get('/courses/:id/roster', requireAuth, requireRole('LECTURER', 'ADMIN'), loadCourse(), async (req, res) => {
  const enrollments = await prisma.enrollment.findMany({
    where: { courseId: req.course.id },
    include: { student: { select: { id: true, fullName: true, matricNumber: true, email: true, phone: true, yearOfStudy: true, status: true } } },
    orderBy: { student: { fullName: 'asc' } },
  });
  res.json({ students: enrollments.map((e) => e.student) });
});

// Students of this school who could be added to a class: not already in it, same department
// first. Feeds the lecturer's "Add student" picker, so nobody has to know a matric number.
router.get('/courses/:id/addable-students', requireAuth, requireRole('LECTURER', 'ADMIN'), loadCourse(), async (req, res) => {
  const q = String(req.query.q || '').trim();
  const where = {
    role: 'STUDENT',
    schoolId: req.user.schoolId,
    status: 'ACTIVE',
    enrollments: { none: { courseId: req.course.id } },
  };
  if (q) {
    where.OR = [
      { fullName: { contains: q, mode: 'insensitive' } },
      { matricNumber: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } },
    ];
  }
  const students = await prisma.user.findMany({
    where,
    select: { id: true, fullName: true, matricNumber: true, departmentId: true, yearOfStudy: true, department: { select: { name: true } } },
    orderBy: { fullName: 'asc' },
    take: 200,
  });
  // Same department as the course first, then alphabetical.
  students.sort((a, b) => (b.departmentId === req.course.departmentId) - (a.departmentId === req.course.departmentId));
  res.json({
    students: students.slice(0, 30).map((u) => ({
      id: u.id, fullName: u.fullName, matricNumber: u.matricNumber, yearOfStudy: u.yearOfStudy,
      department: u.department ? u.department.name : null,
      sameDepartment: u.departmentId === req.course.departmentId,
    })),
  });
});

// A lecturer (or admin) adds an existing student of their own school to a class: picked from
// the list above (studentId), or typed in by matric number. Never creates accounts -- that
// is the school admin's job in the directory.
router.post('/courses/:id/enroll-student', requireAuth, requireRole('LECTURER', 'ADMIN'), loadCourse(), async (req, res) => {
  const { studentId, matricNumber } = req.body;
  const matric = typeof matricNumber === 'string' ? matricNumber.trim() : '';
  if (!studentId && !matric) return res.status(400).json({ error: 'Choose a student, or enter their matric number.' });
  const student = await prisma.user.findFirst({
    where: studentId
      ? { id: String(studentId), role: 'STUDENT', schoolId: req.user.schoolId }
      : { matricNumber: { equals: matric, mode: 'insensitive' }, role: 'STUDENT', schoolId: req.user.schoolId },
  });
  if (!student) return res.status(404).json({ error: studentId ? 'Student not found in your school.' : 'No student with that matric number found in your school.' });
  const existing = await prisma.enrollment.findUnique({
    where: { studentId_courseId: { studentId: student.id, courseId: req.course.id } },
  });
  if (existing) return res.status(409).json({ error: student.fullName + ' is already in this class.' });
  await prisma.enrollment.create({ data: { studentId: student.id, courseId: req.course.id } });
  res.json({ student: { id: student.id, fullName: student.fullName, matricNumber: student.matricNumber } });
});

// Comprehensive detail for one of the lecturer's own students -- reuses the same
// computation the student/admin Admission Status screens use. Scoped so a lecturer can
// only look up a student who is actually enrolled in one of their courses.
router.get('/lect/students/:id', requireAuth, requireRole('LECTURER'), async (req, res) => {
  const enrollment = await prisma.enrollment.findFirst({
    where: { studentId: req.params.id, course: { department: { schoolId: req.user.schoolId } } },
  });
  if (!enrollment) return res.status(404).json({ error: 'Student not found in any of your classes.' });
  const student = await prisma.user.findUnique({ where: { id: req.params.id }, include: { department: true } });
  if (!student) return res.status(404).json({ error: 'Student not found' });
  res.json(await computeAcademicRecord(student));
});

// A lecturer can add or change the photo on the Digital ID of a student in one of their classes.
router.post('/lect/students/:id/photo', requireAuth, requireRole('LECTURER'), photoUpload.single('avatar'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose an image first.' });
  if (!hasSchool(req.user)) return res.status(404).json({ error: 'Student not found' });
  const enrolled = await prisma.enrollment.findFirst({
    where: { studentId: req.params.id, student: { schoolId: req.user.schoolId, role: 'STUDENT' }, course: { department: { schoolId: req.user.schoolId }, OR: [{ lecturers: { some: { lecturerId: req.user.id } } }, { lessons: { some: { authorId: req.user.id } } }] } },
  });
  if (!enrolled) return res.status(404).json({ error: 'Student not found in any of your classes.' });
  let url;
  try { ({ url } = await saveUpload(req.file)); } catch { return res.status(502).json({ error: 'Upload failed. Please try again.' }); }
  const updated = await prisma.user.update({ where: { id: enrolled.studentId }, data: { avatarUrl: url } });
  res.json({ user: { id: updated.id, avatarUrl: updated.avatarUrl } });
});

// A quick broadcast to everyone enrolled in one class -- a regular in-app
// notification, so a muted student's own Settings preference is still respected.
router.post('/courses/:id/announce', requireAuth, requireRole('LECTURER', 'ADMIN'), loadCourse(), async (req, res) => {
  const { title, body } = req.body;
  if (!title || !title.trim() || !body || !body.trim()) return res.status(400).json({ error: 'Title and message are required.' });
  const enrollments = await prisma.enrollment.findMany({ where: { courseId: req.course.id }, select: { studentId: true } });
  await notifyMany(enrollments.map((e) => e.studentId), title.trim(), body.trim(), 'my-dashboard');
  res.json({ ok: true, count: enrollments.length });
});

// Lecturers can add courses within their own department; admins can add to any.
router.post('/courses', requireAuth, requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  const { departmentId, code, title, level, semester } = req.body;
  if (!departmentId || !code || !title) return res.status(400).json({ error: 'Missing required fields' });
  if (req.user.role === 'LECTURER' && departmentId !== req.user.departmentId) {
    return res.status(403).json({ error: 'You can only add courses to your own department.' });
  }
  if (!(await departmentsInSchool([departmentId], req.user.schoolId))) return res.status(404).json({ error: 'Department not found' });
  const semesterId = await getCurrentSemesterId(req.user.schoolId);
  const course = await prisma.course.create({
    data: { departmentId, code, title, level: level || '100L', semester: semester || 'First', semesterId },
  });
  if (req.user.role === 'LECTURER') await logActivity(req.user.id, 'CREATE_COURSE', `${code} — ${title}`);
  res.json({ course });
});

// Lessons (AI-teacher narrated or lecturer recorded)
// AI Teacher narration and lecturer-recorded video are paid features -- students can
// always see what lessons exist, but the actual content (script/videoUrl) is stripped
// unless they have an active subscription. Lecturers/admins always see everything.
router.get('/courses/:id/lessons', requireAuth, loadCourse(), async (req, res) => {
  const lessons = await prisma.lesson.findMany({
    where: { courseId: req.course.id },
    include: { author: { select: { fullName: true } } },
    orderBy: { order: 'asc' },
  });

  if (req.user.role !== 'STUDENT' || !isEnforced()) return res.json({ lessons: lessons.map((l) => ({ ...l, locked: false })) });

  const { active } = await getSubscriptionStatus(req.user.id);
  const shaped = lessons.map((l) => {
    if (active) return { ...l, locked: false };
    const { script, videoUrl, ...rest } = l;
    return { ...rest, locked: true };
  });
  res.json({ lessons: shaped });
});

// Video, when provided, is always a direct device upload (multipart file) -- never a
// pasted link -- same policy as the e-library. This is the lecturer's own recorded
// lesson -- a direct video/script they authored -- and has nothing to do with the AI
// Teacher's live avatar sessions, so it's always stored isAiTeacher: false. (A prior
// version of this route defaulted isAiTeacher to true whenever the field was omitted,
// and no frontend form ever sent it, so every lecturer-uploaded lesson was silently
// mislabeled as "AI Teacher" content.)
router.post('/courses/:id/lessons', requireAuth, requireRole('LECTURER', 'ADMIN'), loadCourse(), upload.single('video'), async (req, res) => {
  const { title, script, order } = req.body;
  if (!title || !script) return res.status(400).json({ error: 'Title and script are required' });

  let videoUrl = null;
  let storage = null;
  if (req.file) {
    try {
      ({ url: videoUrl, storage } = await saveUpload(req.file));
    } catch {
      return res.status(502).json({ error: 'Video upload failed. Please try again.' });
    }
  }

  const lesson = await prisma.lesson.create({
    data: {
      courseId: req.course.id,
      title,
      script,
      videoUrl,
      order: order ? Number(order) : 0,
      isAiTeacher: false,
      authorId: req.user.id,
    },
  });
  if (req.user.role === 'LECTURER') await logActivity(req.user.id, 'CREATE_LESSON', title);
  res.json({ lesson, storage });
});

router.delete('/lessons/:id', requireAuth, requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  const lesson = hasSchool(req.user)
    ? await prisma.lesson.findFirst({ where: { id: req.params.id, course: { department: { schoolId: req.user.schoolId } } } })
    : null;
  if (!lesson || (req.user.role !== 'ADMIN' && lesson.authorId !== req.user.id)) return res.status(404).json({ error: 'Lesson not found' });
  await prisma.lesson.delete({ where: { id: lesson.id } });
  if (req.user.role === 'LECTURER') await logActivity(req.user.id, 'DELETE_LESSON', req.params.id);
  res.json({ ok: true });
});

module.exports = router;
