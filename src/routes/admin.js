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

// Courses a lecturer teaches -- explicit CourseLecturer assignments (set by admin when
// adding/editing the lecturer) merged with the indirect "authored a lesson for this
// course" signal (same one workload already uses in staff.js), so the directory shows
// a course the instant admin assigns it, not only once the lecturer publishes something.
async function coursesTaughtBy(userId) {
  const [assigned, lessons] = await Promise.all([
    prisma.courseLecturer.findMany({ where: { lecturerId: userId }, select: { course: { select: { id: true, code: true, title: true } } } }),
    prisma.lesson.findMany({ where: { authorId: userId }, distinct: ['courseId'], select: { course: { select: { id: true, code: true, title: true } } } }),
  ]);
  const byId = new Map();
  for (const { course } of [...assigned, ...lessons]) byId.set(course.id, course);
  return Array.from(byId.values());
}

// Replaces a lecturer's course assignments with exactly this list -- used by both the
// "add lecturer" and "edit lecturer" flows so course selection behaves identically.
async function setLecturerCourses(lecturerId, courseIds) {
  if (!Array.isArray(courseIds)) return;
  await prisma.courseLecturer.deleteMany({ where: { lecturerId } });
  if (courseIds.length) {
    await prisma.courseLecturer.createMany({
      data: courseIds.map((courseId) => ({ lecturerId, courseId })),
      skipDuplicates: true,
    });
  }
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

// Shared by every "admin directly adds a user" flow -- always auto-generates a temp
// password, and an access code too unless skipAccessCode is set (non-academic staff
// log in with email+password only -- an access code is a school-issued shortcut for
// roles that need one, not a requirement of every account). Returns the created user,
// or null after sending an error response itself, so callers can do post-creation work
// (attaching courses) before sending their own final response.
async function createSchoolUser(req, res, { role, extraFields = {}, requiredFields = [], skipAccessCode = false }) {
  const { fullName, email, phone } = req.body;
  if (!fullName || !email || requiredFields.some((f) => !req.body[f])) {
    res.status(400).json({ error: 'Missing required fields' });
    return null;
  }
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    res.status(409).json({ error: 'An account with that email already exists' });
    return null;
  }
  const tempPassword = generateAccessCode(8);
  const passwordHash = await bcrypt.hash(tempPassword, 10);
  let accessCode = null;
  if (!skipAccessCode) {
    accessCode = generateAccessCode();
    while (await prisma.user.findUnique({ where: { accessCode } })) accessCode = generateAccessCode();
  }

  const user = await prisma.user.create({
    data: { fullName, email, phone: phone || null, passwordHash, schoolId: req.user.schoolId, role, accessCode, ...extraFields },
  });
  return { user, accessCode, tempPassword };
}

function parseCourseIds(body) {
  if (Array.isArray(body.courseIds)) return body.courseIds.filter(Boolean);
  if (typeof body.courseIds === 'string' && body.courseIds.trim()) return body.courseIds.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

router.post('/lecturers', async (req, res) => {
  const { staffId, departmentId } = req.body;
  const created = await createSchoolUser(req, res, {
    role: 'LECTURER',
    requiredFields: ['departmentId'],
    extraFields: { staffId: staffId || null, departmentId, staffType: 'ACADEMIC' },
  });
  if (!created) return;
  const courseIds = parseCourseIds(req.body);
  if (courseIds.length) await setLecturerCourses(created.user.id, courseIds);
  const { passwordHash, ...safe } = created.user;
  res.json({ user: safe, accessCode: created.accessCode, tempPassword: created.tempPassword });
});

router.post('/non-academic-staff', async (req, res) => {
  const { staffId, position, departmentId } = req.body;
  const created = await createSchoolUser(req, res, {
    role: 'STAFF',
    requiredFields: ['position'],
    extraFields: { staffId: staffId || null, position, departmentId: departmentId || null, staffType: 'NON_ACADEMIC' },
    skipAccessCode: true,
  });
  if (!created) return;
  const { passwordHash, ...safe } = created.user;
  res.json({ user: safe, accessCode: created.accessCode, tempPassword: created.tempPassword });
});

router.post('/students', async (req, res) => {
  const { matricNumber, departmentId, yearOfStudy } = req.body;
  const created = await createSchoolUser(req, res, {
    role: 'STUDENT',
    requiredFields: ['matricNumber', 'departmentId'],
    extraFields: { matricNumber, departmentId, yearOfStudy: yearOfStudy ? parseInt(yearOfStudy, 10) : null },
  });
  if (!created) return;
  const courseIds = parseCourseIds(req.body);
  if (courseIds.length) {
    await prisma.enrollment.createMany({ data: courseIds.map((courseId) => ({ studentId: created.user.id, courseId })), skipDuplicates: true });
  }
  const { passwordHash, ...safe } = created.user;
  res.json({ user: safe, accessCode: created.accessCode, tempPassword: created.tempPassword });
});

// ---- Admin management: a school can have more than one admin account (e.g. the
// principal plus a vice-principal or registrar) -- this is how additional ones get
// added, distinct from the single admin created automatically at school registration.
// Admins log in with email+password only, same as non-academic staff -- no access code.
router.get('/admins', async (req, res) => {
  const admins = await prisma.user.findMany({
    where: { schoolId: req.user.schoolId, role: 'ADMIN' },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ admins: admins.map(({ passwordHash, ...a }) => a) });
});

router.post('/admins', async (req, res) => {
  const created = await createSchoolUser(req, res, { role: 'ADMIN', skipAccessCode: true });
  if (!created) return;
  const { passwordHash, ...safe } = created.user;
  res.json({ user: safe, accessCode: created.accessCode, tempPassword: created.tempPassword });
});

// A status change (DISMISSED), not a hard delete -- an admin account can easily have
// authored assessments, results, disciplinary records, etc., and deleting the row
// outright would hit those foreign keys. This also matches how lecturer/staff removal
// already works elsewhere. A school should never end up with zero *active* admins able
// to log in, and can't remove the account you're currently logged in as -- both guards
// are enforced server-side regardless of what the client checks.
router.post('/admins/:id/remove', async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: "You can't remove your own admin account." });
  const admin = await prisma.user.findFirst({ where: { id: req.params.id, schoolId: req.user.schoolId, role: 'ADMIN' } });
  if (!admin) return res.status(404).json({ error: 'Admin not found' });
  const activeAdminCount = await prisma.user.count({ where: { schoolId: req.user.schoolId, role: 'ADMIN', status: 'ACTIVE' } });
  if (admin.status === 'ACTIVE' && activeAdminCount <= 1) return res.status(400).json({ error: 'A school must always have at least one active admin.' });
  const updated = await prisma.user.update({ where: { id: admin.id }, data: { status: 'DISMISSED' } });
  const { passwordHash, ...safe } = updated;
  res.json({ user: safe });
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

// ---- Editing: department, course, and every directory user type ----

router.patch('/departments/:id', async (req, res) => {
  const department = await prisma.department.findFirst({ where: { id: req.params.id, schoolId: req.user.schoolId } });
  if (!department) return res.status(404).json({ error: 'Department not found' });
  const { name, code } = req.body;
  const updated = await prisma.department.update({
    where: { id: department.id },
    data: { name: name !== undefined ? name : department.name, code: code !== undefined ? code : department.code },
  });
  res.json({ department: updated });
});

router.patch('/courses/:id', async (req, res) => {
  const course = await prisma.course.findFirst({ where: { id: req.params.id, department: { schoolId: req.user.schoolId } } });
  if (!course) return res.status(404).json({ error: 'Course not found' });
  const { code, title, level, semester, departmentId } = req.body;
  const updated = await prisma.course.update({
    where: { id: course.id },
    data: {
      code: code !== undefined ? code : course.code,
      title: title !== undefined ? title : course.title,
      level: level !== undefined ? level : course.level,
      semester: semester !== undefined ? semester : course.semester,
      departmentId: departmentId || course.departmentId,
    },
  });
  res.json({ course: updated });
});

// Shared by the lecturer/staff/student edit forms -- each accepts the fields relevant
// to that role and leaves the rest untouched (undefined means "not submitted", not
// "clear it"). Course assignment/enrollment (courseIds) is handled per-role below since
// lecturers use CourseLecturer and students use Enrollment.
async function updateSchoolUser(req, res, role, fields) {
  const user = await prisma.user.findFirst({ where: { id: req.params.id, schoolId: req.user.schoolId, role } });
  if (!user) return null;
  const data = {};
  for (const key of fields) if (req.body[key] !== undefined) data[key] = req.body[key] || null;
  const updated = await prisma.user.update({ where: { id: user.id }, data });
  return updated;
}

router.patch('/lecturers/:id', async (req, res) => {
  const updated = await updateSchoolUser(req, res, 'LECTURER', ['fullName', 'email', 'phone', 'staffId', 'departmentId']);
  if (!updated) return res.status(404).json({ error: 'Not found' });
  const courseIds = parseCourseIds(req.body);
  if (req.body.courseIds !== undefined) await setLecturerCourses(updated.id, courseIds);
  const { passwordHash, ...safe } = updated;
  res.json({ user: { ...safe, courses: await coursesTaughtBy(updated.id) } });
});

router.patch('/non-academic-staff/:id', async (req, res) => {
  const updated = await updateSchoolUser(req, res, 'STAFF', ['fullName', 'email', 'phone', 'staffId', 'position', 'departmentId']);
  if (!updated) return res.status(404).json({ error: 'Not found' });
  const { passwordHash, ...safe } = updated;
  res.json({ user: safe });
});

router.patch('/students/:id', async (req, res) => {
  const updated = await updateSchoolUser(req, res, 'STUDENT', ['fullName', 'email', 'phone', 'matricNumber', 'departmentId', 'yearOfStudy']);
  if (!updated) return res.status(404).json({ error: 'Not found' });
  if (req.body.courseIds !== undefined) {
    const courseIds = parseCourseIds(req.body);
    await prisma.enrollment.deleteMany({ where: { studentId: updated.id } });
    if (courseIds.length) await prisma.enrollment.createMany({ data: courseIds.map((courseId) => ({ studentId: updated.id, courseId })), skipDuplicates: true });
  }
  const { passwordHash, ...safe } = updated;
  res.json({ user: { ...safe, courses: await coursesEnrolledBy(updated.id) } });
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

// Admin-initiated allocation -- directly assigns a student to a hostel/room without
// requiring them to have submitted their own application first (the existing approve/
// reject flow at /admin/hostel-applications/:id/approve still handles applications a
// student submitted themselves; this is the "+ Add student to hostel" shortcut).
router.post('/hostels/:id/allocate', async (req, res) => {
  const { studentId, roomAssigned } = req.body;
  if (!studentId) return res.status(400).json({ error: 'Choose a student.' });
  const hostel = await prisma.hostel.findFirst({ where: { id: req.params.id, schoolId: req.user.schoolId } });
  if (!hostel) return res.status(404).json({ error: 'Hostel not found' });
  const student = await prisma.user.findFirst({ where: { id: studentId, schoolId: req.user.schoolId, role: 'STUDENT' } });
  if (!student) return res.status(404).json({ error: 'Student not found' });
  const existing = await prisma.hostelApplication.findFirst({ where: { studentId, status: 'APPROVED' } });
  const application = existing
    ? await prisma.hostelApplication.update({ where: { id: existing.id }, data: { hostelId: hostel.id, roomAssigned: roomAssigned || 'To be confirmed', decidedAt: new Date() } })
    : await prisma.hostelApplication.create({ data: { studentId, hostelId: hostel.id, roomAssigned: roomAssigned || 'To be confirmed', status: 'APPROVED', decidedAt: new Date() } });
  await notify(studentId, 'Hostel allocated', `You've been allocated to ${hostel.name}${roomAssigned ? `, room ${roomAssigned}` : ''}.`, 'digital-id');
  res.json({ application });
});

// A flat, school-wide course list (with department name) -- powers the course
// multi-select on the add/edit lecturer and add/edit student forms, so admin doesn't
// have to pick a department first just to see which courses exist.
router.get('/courses', async (req, res) => {
  const courses = await prisma.course.findMany({
    where: { department: { schoolId: req.user.schoolId } },
    include: { department: { select: { name: true } } },
    orderBy: [{ department: { name: 'asc' } }, { code: 'asc' }],
  });
  res.json({ courses });
});

module.exports = router;
