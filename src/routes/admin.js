const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { generateAccessCode } = require('../utils');
const { notify, notifyMany } = require('../services/notification.service');
const { getCurrentSemesterId } = require('../semester');
const bulkMessage = require('../services/bulkMessage.service');
const { departmentsInSchool, coursesInSchool } = require('../scope');
const { memoryUpload, saveUpload } = require('../services/fileUpload.service');
const photoUpload = memoryUpload(5);

// People added by the school admin don't need an email -- they sign in with their access
// code. The column is required and unique, so those accounts get an address that can never
// receive mail (and is never shown or emailed).
const INTERNAL_EMAIL_DOMAIN = 'internal.learnza.local';
const isInternalEmail = (e) => typeof e === 'string' && e.endsWith('@' + INTERNAL_EMAIL_DOMAIN);

const router = express.Router();
router.use(requireAuth, requireRole('ADMIN'));

// ---- Bulk SMS/Email: one message to every student, every academic (lecturer) or
// non-academic staff member, or the whole school -- an in-app notification always
// goes out (needs no configuration); Email/SMS are opt-in channels the admin picks,
// and fail per-recipient (missing address/number, or the channel not configured at
// all) without blocking the others.
router.post('/bulk-message', async (req, res) => {
  const { audience, departmentId, channels, subject, body } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: 'Write a message first.' });
  if (!Array.isArray(channels) || !channels.length) return res.status(400).json({ error: 'Pick at least one channel.' });

  const roleFilter = {
    STUDENTS: { role: 'STUDENT' },
    ACADEMIC_STAFF: { role: 'LECTURER' },
    NON_ACADEMIC_STAFF: { role: 'STAFF' },
    EVERYONE: { role: { in: ['STUDENT', 'LECTURER', 'STAFF'] } },
  }[audience];
  if (!roleFilter) return res.status(400).json({ error: 'Pick a valid audience.' });

  const recipients = await prisma.user.findMany({
    where: { schoolId: req.user.schoolId, status: 'ACTIVE', ...roleFilter, ...(departmentId ? { departmentId } : {}) },
    select: { id: true, email: true, phone: true, fullName: true },
  });
  if (!recipients.length) return res.json({ recipientCount: 0, inApp: 0, email: 0, sms: 0, emailSkipped: 0, smsSkipped: 0 });

  const result = { recipientCount: recipients.length, inApp: 0, email: 0, sms: 0, emailSkipped: 0, smsSkipped: 0 };

  if (channels.includes('IN_APP')) {
    await notifyMany(recipients.map((r) => r.id), subject || 'Message from school admin', body, 'my-dashboard');
    result.inApp = recipients.length;
  }

  if (channels.includes('EMAIL')) {
    if (!bulkMessage.emailConfigured()) {
      result.emailSkipped = recipients.length;
      result.emailError = 'Email is not configured yet -- ask your developer to set SMTP_HOST/SMTP_USER/SMTP_PASS.';
    } else {
      for (const r of recipients) {
        if (!r.email || isInternalEmail(r.email)) { result.emailSkipped++; continue; }
        try { await bulkMessage.sendEmail(r.email, subject || 'Message from your school', body); result.email++; }
        catch { result.emailSkipped++; }
      }
    }
  }

  if (channels.includes('SMS')) {
    if (!bulkMessage.smsConfigured()) {
      result.smsSkipped = recipients.length;
      result.smsError = 'SMS is not configured yet -- ask your developer to set TERMII_API_KEY/TERMII_SENDER_ID.';
    } else {
      for (const r of recipients) {
        if (!r.phone) { result.smsSkipped++; continue; }
        try { await bulkMessage.sendSms(r.phone, body); result.sms++; }
        catch { result.smsSkipped++; }
      }
    }
  }

  res.json(result);
});

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

// One query for everybody's courses, not one per person (a school of 2,000 students would
// otherwise run 2,000 queries to draw the directory).
async function coursesEnrolledByMany(studentIds) {
  const byStudent = new Map(studentIds.map((id) => [id, []]));
  if (!studentIds.length) return byStudent;
  const rows = await prisma.enrollment.findMany({
    where: { studentId: { in: studentIds } },
    select: { studentId: true, course: { select: { id: true, code: true, title: true } } },
  });
  for (const r of rows) byStudent.get(r.studentId).push(r.course);
  return byStudent;
}

async function coursesTaughtByMany(lecturerIds) {
  const byLecturer = new Map(lecturerIds.map((id) => [id, new Map()]));
  if (!lecturerIds.length) return new Map(lecturerIds.map((id) => [id, []]));
  const [assigned, lessons] = await Promise.all([
    prisma.courseLecturer.findMany({ where: { lecturerId: { in: lecturerIds } }, select: { lecturerId: true, course: { select: { id: true, code: true, title: true } } } }),
    prisma.lesson.findMany({ where: { authorId: { in: lecturerIds }, courseId: { not: null } }, distinct: ['authorId', 'courseId'], select: { authorId: true, course: { select: { id: true, code: true, title: true } } } }),
  ]);
  for (const a of assigned) byLecturer.get(a.lecturerId).set(a.course.id, a.course);
  for (const l of lessons) if (l.course) byLecturer.get(l.authorId).set(l.course.id, l.course);
  return new Map([...byLecturer].map(([id, m]) => [id, Array.from(m.values())]));
}

router.get('/students', async (req, res) => {
  const students = await prisma.user.findMany({
    where: { schoolId: req.user.schoolId, role: 'STUDENT' },
    include: { department: true },
    orderBy: { fullName: 'asc' },
  });
  const courses = await coursesEnrolledByMany(students.map((s) => s.id));
  res.json({ students: students.map(({ passwordHash, ...s }) => ({ ...s, courses: courses.get(s.id) })) });
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
  const courses = await coursesTaughtByMany(lecturers.map((l) => l.id));
  res.json({ lecturers: lecturers.map(({ passwordHash, ...l }) => ({ ...l, courses: courses.get(l.id) })) });
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

// Shared by every "admin directly adds a user" flow -- always generates an access code
// (the credential they sign in to the Schools app with, along with their name and the
// school's name) plus a stored password nobody needs to know. Returns the created user,
// or null after sending an error response itself, so callers can do post-creation work
// (attaching courses) before sending their own final response.
async function createSchoolUser(req, res, { role, extraFields = {}, requiredFields = [] }) {
  const { fullName, phone, password } = req.body;
  const name = typeof fullName === 'string' ? fullName.trim() : '';
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!name || requiredFields.some((f) => !String(req.body[f] || '').trim())) {
    res.status(400).json({ error: 'Please fill in every required field.' });
    return null;
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: 'That email address does not look right.' });
    return null;
  }
  if (password && password.length < 6) {
    res.status(400).json({ error: 'Password must be at least 6 characters.' });
    return null;
  }
  // Every id that arrives in the body must belong to THIS school.
  if (extraFields.departmentId && !(await departmentsInSchool([extraFields.departmentId], req.user.schoolId))) {
    res.status(400).json({ error: 'That department does not exist in your school. Pick one from the list.' });
    return null;
  }
  const courseIds = parseCourseIds(req.body);
  if (courseIds.length && !(await coursesInSchool(courseIds, req.user.schoolId))) {
    res.status(400).json({ error: 'One of the chosen courses does not exist in your school.' });
    return null;
  }
  if (email && (await prisma.user.findUnique({ where: { email } }))) {
    res.status(409).json({ error: 'An account with that email already exists' });
    return null;
  }
  if (role === 'STUDENT' && extraFields.matricNumber) {
    extraFields.matricNumber = String(extraFields.matricNumber).trim();
    const dup = await prisma.user.findFirst({
      where: { schoolId: req.user.schoolId, role: 'STUDENT', matricNumber: { equals: extraFields.matricNumber, mode: 'insensitive' } },
    });
    if (dup) {
      res.status(409).json({ error: 'A student with that matric number already exists in your school.' });
      return null;
    }
  }
  const tempPassword = password || generateAccessCode(12);
  const passwordHash = await bcrypt.hash(tempPassword, 10);
  let accessCode = generateAccessCode();
  while (await prisma.user.findUnique({ where: { accessCode } })) accessCode = generateAccessCode();

  const user = await prisma.user.create({
    data: {
      fullName: name,
      email: email || `u.${accessCode.toLowerCase()}@${INTERNAL_EMAIL_DOMAIN}`,
      phone: phone || null,
      passwordHash,
      schoolId: req.user.schoolId,
      role,
      accessCode,
      ...extraFields,
    },
  });
  return { user, accessCode, tempPassword: password ? null : tempPassword };
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
// registrar plus a deputy) -- this is how additional ones get added, on top of the
// founding admin the platform created when it onboarded the school (the one the join
// code signs in as, hidden from this list since it isn't a person). Additional admins
// sign in to the Schools app with their access code, like lecturers and students.
router.get('/admins', async (req, res) => {
  const admins = await prisma.user.findMany({
    where: { schoolId: req.user.schoolId, role: 'ADMIN', NOT: { email: { endsWith: '@internal.learnza.local' } } },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ admins: admins.map(({ passwordHash, ...a }) => a) });
});

router.post('/admins', async (req, res) => {
  const created = await createSchoolUser(req, res, { role: 'ADMIN' });
  if (!created) return;
  const { passwordHash, ...safe } = created.user;
  res.json({ user: safe, accessCode: created.accessCode });
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
  if (!(await departmentsInSchool([departmentId], req.user.schoolId))) return res.status(400).json({ error: 'Pick a department from your school.' });
  const semesterId = await getCurrentSemesterId(req.user.schoolId);
  const course = await prisma.course.create({
    data: { departmentId, code, title, level: level || '100L', semester: semester || 'First', semesterId },
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
  if (departmentId && !(await departmentsInSchool([departmentId], req.user.schoolId))) return res.status(400).json({ error: 'Pick a department from your school.' });
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
  if (req.body.departmentId && !(await departmentsInSchool([req.body.departmentId], req.user.schoolId))) {
    res.status(400).json({ error: 'That department does not exist in your school.' });
    return 'handled';
  }
  const courseIds = parseCourseIds(req.body);
  if (req.body.courseIds !== undefined && courseIds.length && !(await coursesInSchool(courseIds, req.user.schoolId))) {
    res.status(400).json({ error: 'One of the chosen courses does not exist in your school.' });
    return 'handled';
  }
  if (typeof req.body.email === 'string') {
    const e = req.body.email.trim().toLowerCase();
    if (!e) delete req.body.email; // blank = leave the address as it is
    else {
      const clash = await prisma.user.findFirst({ where: { email: e, NOT: { id: user.id } } });
      if (clash) {
        res.status(409).json({ error: 'Another account already uses that email.' });
        return 'handled';
      }
      req.body.email = e;
    }
  }
  const data = {};
  for (const key of fields) {
    if (req.body[key] === undefined) continue;
    // yearOfStudy is the one Int column among these edit fields -- every other one is
    // a plain String column, but the <select> it comes from submits its value as a
    // string regardless, which Prisma rejects outright for an Int field.
    data[key] = key === 'yearOfStudy' ? (req.body[key] ? Number(req.body[key]) : null) : (req.body[key] || null);
  }
  const updated = await prisma.user.update({ where: { id: user.id }, data });
  return updated;
}

router.patch('/lecturers/:id', async (req, res) => {
  const updated = await updateSchoolUser(req, res, 'LECTURER', ['fullName', 'email', 'phone', 'staffId', 'departmentId']);
  if (updated === 'handled') return;
  if (!updated) return res.status(404).json({ error: 'Not found' });
  const courseIds = parseCourseIds(req.body);
  if (req.body.courseIds !== undefined) await setLecturerCourses(updated.id, courseIds);
  const { passwordHash, ...safe } = updated;
  res.json({ user: { ...safe, courses: await coursesTaughtBy(updated.id) } });
});

router.patch('/non-academic-staff/:id', async (req, res) => {
  const updated = await updateSchoolUser(req, res, 'STAFF', ['fullName', 'email', 'phone', 'staffId', 'position', 'departmentId']);
  if (updated === 'handled') return;
  if (!updated) return res.status(404).json({ error: 'Not found' });
  const { passwordHash, ...safe } = updated;
  res.json({ user: safe });
});

router.patch('/students/:id', async (req, res) => {
  const updated = await updateSchoolUser(req, res, 'STUDENT', ['fullName', 'email', 'phone', 'matricNumber', 'departmentId', 'yearOfStudy']);
  if (updated === 'handled') return;
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

// Not every POST /students/:id/<something> is a status change -- academic details and
// disciplinary records live on the same path shape in records.js, mounted after this
// router. An action that isn't one of this role's status actions must fall through
// (next) rather than be rejected here, or those routes are unreachable.
async function setUserStatus(req, res, next, { role, statuses }) {
  const status = statuses[req.params.action];
  if (!status) return next();
  const user = await prisma.user.findFirst({ where: { id: req.params.id, schoolId: req.user.schoolId, role } });
  if (!user) return res.status(404).json({ error: 'Not found' });
  const updated = await prisma.user.update({ where: { id: user.id }, data: { status } });
  await notify(user.id, 'Account status changed', STATUS_NOTE[status]);
  const { passwordHash, ...safe } = updated;
  res.json({ user: safe });
}

// A photo for someone in this school's directory (their Digital ID card), set by the admin --
// useful for staff and students who have not added one themselves.
router.post('/users/:id/photo', photoUpload.single('avatar'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose an image first.' });
  const user = await prisma.user.findFirst({ where: { id: req.params.id, schoolId: req.user.schoolId, role: { in: ['STUDENT', 'LECTURER', 'STAFF'] } } });
  if (!user) return res.status(404).json({ error: 'Not found' });
  let url;
  try { ({ url } = await saveUpload(req.file)); } catch { return res.status(502).json({ error: 'Upload failed. Please try again.' }); }
  const updated = await prisma.user.update({ where: { id: user.id }, data: { avatarUrl: url } });
  const { passwordHash, ...safe } = updated;
  res.json({ user: safe });
});

router.post('/lecturers/:id/:action', (req, res, next) =>
  setUserStatus(req, res, next, { role: 'LECTURER', statuses: { suspend: 'SUSPENDED', 'lift-suspension': 'ACTIVE', dismiss: 'DISMISSED' } })
);

router.post('/non-academic-staff/:id/:action', (req, res, next) =>
  setUserStatus(req, res, next, { role: 'STAFF', statuses: { suspend: 'SUSPENDED', 'lift-suspension': 'ACTIVE', dismiss: 'DISMISSED' } })
);

router.post('/students/:id/:action', (req, res, next) =>
  setUserStatus(req, res, next, { role: 'STUDENT', statuses: { suspend: 'SUSPENDED', 'lift-suspension': 'ACTIVE', expel: 'EXPELLED' } })
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
