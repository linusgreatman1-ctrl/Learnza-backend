const prisma = require('./db');

// Tenant isolation. Many schools share one database, and almost everything hangs off a
// school through  Department.schoolId -> Course -> (assessments, assignments, rosters ...).
// A route that trusts an id from the URL or body without checking that the record belongs
// to the caller's school lets one school read or change another's data. These helpers are
// the single place that check lives.
//
// They answer 404, never 403, for something in another school: confirming "that id exists,
// you just can't have it" would let a caller probe for valid ids.
//
// Pitfall they all guard against: Prisma silently DROPS a filter whose value is undefined,
// so { schoolId: undefined } matches every school. Independent students and the super admin
// have no schoolId, so every helper refuses when it is missing instead of querying.

const hasSchool = (user) => !!(user && user.schoolId);

async function courseInSchool(courseId, schoolId) {
  if (!courseId || !schoolId) return null;
  return prisma.course.findFirst({ where: { id: courseId, department: { schoolId } } });
}

// Middleware: /courses/:id/... routes. Sets req.course.
function loadCourse(param = 'id') {
  return async (req, res, next) => {
    const course = hasSchool(req.user) ? await courseInSchool(req.params[param], req.user.schoolId) : null;
    if (!course) return res.status(404).json({ error: 'Course not found' });
    req.course = course;
    next();
  };
}

// ---- assessments (school-course tests/exams, or an independent learner's own) ----
function assessmentVisibleTo(a, user) {
  if (a.courseId) return hasSchool(user) && !!a.course && a.course.department.schoolId === user.schoolId;
  if (a.individualCourseId) return user.role === 'STUDENT' && !!a.individualCourse && a.individualCourse.studentId === user.id;
  return false;
}

// Middleware: /assessments/:id/... routes. Sets req.assessment. A student can't see a
// school assessment its lecturer hasn't sent yet (a draft).
function loadAssessment({ include = {} } = {}) {
  return async (req, res, next) => {
    const a = await prisma.assessment.findUnique({
      where: { id: req.params.id },
      include: {
        ...include,
        course: { include: { department: { select: { schoolId: true } } } },
        individualCourse: { select: { studentId: true } },
      },
    });
    if (!a || !assessmentVisibleTo(a, req.user) || (req.user.role === 'STUDENT' && a.courseId && !a.sentAt)) {
      return res.status(404).json({ error: 'Assessment not found' });
    }
    req.assessment = a;
    next();
  };
}

// The assessment's course without the internal department join used for the check.
function plainCourse(a) {
  if (!a.course) return null;
  const { department, ...course } = a.course;
  return course;
}

// Middleware: /submissions/:id routes (a student's attempt at an assessment).
function loadSubmission({ include = {} } = {}) {
  return async (req, res, next) => {
    const s = await prisma.submission.findUnique({
      where: { id: req.params.id },
      include: { ...include, assessment: { include: { course: { include: { department: { select: { schoolId: true } } } } } } },
    });
    if (!s || !hasSchool(req.user) || !s.assessment.course || s.assessment.course.department.schoolId !== req.user.schoolId) {
      return res.status(404).json({ error: 'Submission not found' });
    }
    req.submission = s;
    next();
  };
}

// ---- assignments ----
function loadAssignment({ include = {} } = {}) {
  return async (req, res, next) => {
    const a = await prisma.assignment.findUnique({
      where: { id: req.params.id },
      include: { ...include, course: { include: { department: { select: { schoolId: true } } } } },
    });
    if (!a || !hasSchool(req.user) || a.course.department.schoolId !== req.user.schoolId || (req.user.role === 'STUDENT' && !a.sentAt)) {
      return res.status(404).json({ error: 'Assignment not found' });
    }
    req.assignment = a;
    next();
  };
}

function loadAssignmentSubmission({ include = {} } = {}) {
  return async (req, res, next) => {
    const s = await prisma.assignmentSubmission.findUnique({
      where: { id: req.params.id },
      include: { ...include, assignment: { include: { course: { include: { department: { select: { schoolId: true } } } } } } },
    });
    if (!s || !hasSchool(req.user) || s.assignment.course.department.schoolId !== req.user.schoolId) {
      return res.status(404).json({ error: 'Submission not found' });
    }
    req.assignmentSubmission = s;
    next();
  };
}

// A lecturer may only change what they wrote; an admin of the same school may change
// anything in their school. (The school check has already happened by the time this runs.)
function mayModify(user, authorId) {
  return user.role === 'ADMIN' || authorId === user.id;
}

// ---- body-supplied ids (admin forms): every id must belong to the caller's school ----
async function departmentsInSchool(ids, schoolId) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : [ids]).filter(Boolean))];
  if (!schoolId) return false;
  if (!wanted.length) return true;
  return (await prisma.department.count({ where: { id: { in: wanted }, schoolId } })) === wanted.length;
}

async function coursesInSchool(ids, schoolId) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : [ids]).filter(Boolean))];
  if (!schoolId) return false;
  if (!wanted.length) return true;
  return (await prisma.course.count({ where: { id: { in: wanted }, department: { schoolId } } })) === wanted.length;
}

async function studentInSchool(studentId, schoolId) {
  if (!studentId || !schoolId) return null;
  return prisma.user.findFirst({ where: { id: studentId, schoolId, role: 'STUDENT' } });
}

module.exports = {
  hasSchool, courseInSchool, loadCourse,
  loadAssessment, plainCourse, loadSubmission,
  loadAssignment, loadAssignmentSubmission, mayModify,
  departmentsInSchool, coursesInSchool, studentInSchool,
};
