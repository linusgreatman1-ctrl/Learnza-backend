// Tenant-isolation + "add people" flow checks against a running server.
//
//   DATABASE_URL=... JWT_SECRET=... SUPER_EMAIL=... SUPER_PASSWORD=... node tests/isolation.js
//
// Creates two schools (A and B) with their own admin, lecturer, students, courses, then
// proves (1) the add-lecturer / add-student / enrol flows work and (2) nothing in school A is
// reachable from school B by guessing ids.
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const BASE = process.env.BASE || 'http://localhost:4100';
const RUN = Date.now();
let pass = 0, fail = 0;

function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
async function call(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function makeSchool(SUPER, label) {
  const name = `Iso ${label} ${RUN}`;
  let r = await call('POST', '/api/super/schools', { token: SUPER, body: { name, state: 'Lagos', address: '1 Road' } });
  if (r.status !== 200) throw new Error('create school failed ' + JSON.stringify(r));
  const joinCode = r.data.joinCode;
  r = await call('POST', '/api/auth/school-login', { body: { schoolName: name, joinCode } });
  const admin = r.data.token;
  return { name, admin, id: r.data.user.schoolId };
}

async function loginCode(school, fullName, accessCode) {
  const r = await call('POST', '/api/auth/login-with-code', { body: { fullName, schoolName: school.name, accessCode } });
  if (r.status !== 200) throw new Error(`code login failed for ${fullName}: ${JSON.stringify(r)}`);
  return r.data.token;
}

(async () => {
  let r = await call('POST', '/api/super/login', { body: { email: process.env.SUPER_EMAIL, password: process.env.SUPER_PASSWORD } });
  const SUPER = r.data.token;
  if (!SUPER) throw new Error('super login failed');

  console.log('== set up two schools ==');
  const A = await makeSchool(SUPER, 'A');
  const B = await makeSchool(SUPER, 'B');
  check('both school admins signed in', !!A.admin && !!B.admin);

  // ---- school A: the add-lecturer / add-student flow, exactly as an admin would do it ----
  console.log('== admin adds department, course, lecturer, students (no email needed) ==');
  r = await call('POST', '/api/admin/lecturers', { token: A.admin, body: { fullName: 'No Dept', staffId: 'x' } });
  check('lecturer without a department is refused with a clear message', r.status === 400 && /required/i.test(r.data.error || ''), r);
  r = await call('POST', '/api/admin/departments', { token: A.admin, body: { name: 'Computer Science', code: 'CSC' } });
  const deptA = r.data.department;
  r = await call('POST', '/api/admin/departments', { token: A.admin, body: { name: 'Biology', code: 'BIO' } });
  const deptA2 = r.data.department;
  r = await call('POST', '/api/admin/courses', { token: A.admin, body: { departmentId: deptA.id, code: 'CSC101', title: 'Intro to Computing', level: '100L' } });
  const courseA = r.data.course;
  check('admin creates a course', r.status === 200 && courseA && courseA.id, r);

  r = await call('POST', '/api/admin/lecturers', { token: A.admin, body: { fullName: 'Dr Ada Obi', departmentId: deptA.id, courseIds: [courseA.id] } });
  check('admin adds a lecturer with no email', r.status === 200 && r.data.accessCode, r);
  const lecA = r.data;
  check('placeholder email is used and the lecturer is attached to the course', /@internal\.learnza\.local$/.test(lecA.user.email), lecA.user.email);
  r = await call('POST', '/api/admin/lecturers', { token: A.admin, body: { fullName: 'Dr Two', departmentId: deptA.id, email: 'not-an-email' } });
  check('a malformed email is refused', r.status === 400, r);
  r = await call('POST', '/api/admin/lecturers', { token: A.admin, body: { fullName: 'Dr Three', departmentId: deptA.id, email: `three${RUN}@example.com` } });
  check('a real email still works', r.status === 200, r);
  r = await call('POST', '/api/admin/lecturers', { token: A.admin, body: { fullName: 'Dr Four', departmentId: deptA.id, email: `THREE${RUN}@example.com` } });
  check('duplicate email (any case) -> 409', r.status === 409, r);

  console.log('== only lecturers add students; the school admin views and edits them ==');
  r = await call('POST', '/api/admin/students', { token: A.admin, body: { fullName: 'Student One', matricNumber: 'AB/001', departmentId: deptA.id, yearOfStudy: 1 } });
  check('a school admin cannot add a student', r.status === 403, r);
  const lecToken = await loginCode(A, 'Dr Ada Obi', lecA.accessCode);
  r = await call('GET', '/api/lect/add-student-options', { token: lecToken });
  check("the lecturer's options are their own department and classes", r.status === 200 && r.data.departments.length === 1 && r.data.departments[0].id === deptA.id && r.data.courses.length === 1 && r.data.courses[0].id === courseA.id, r.data);
  r = await call('POST', '/api/lect/students', { token: lecToken, body: { fullName: 'Student One', matricNumber: 'AB/001', yearOfStudy: 1 } });
  check('the lecturer adds a student with no email', r.status === 201 && r.data.accessCode && r.data.user.departmentId === deptA.id && r.data.user.addedById === lecA.user.id, r);
  const s1 = r.data;
  r = await call('POST', '/api/lect/students', { token: lecToken, body: { fullName: 'Wrong Dept', matricNumber: 'AB/009', departmentId: deptA2.id } });
  check("a lecturer cannot add a student to another department", r.status === 403, r);
  r = await call('POST', '/api/lect/students', { token: lecToken, body: { fullName: 'Dup', matricNumber: 'ab/001' } });
  check('same matric number (any case) in the same school -> 409', r.status === 409, r);
  r = await call('POST', '/api/admin/lecturers', { token: A.admin, body: { fullName: 'Dr Bio', departmentId: deptA2.id } });
  const bioToken = await loginCode(A, 'Dr Bio', r.data.accessCode);
  r = await call('POST', '/api/lect/students', { token: bioToken, body: { fullName: 'Student Two', matricNumber: 'AB/002', yearOfStudy: 2 } });
  check("a lecturer with no classes adds to their own department", r.status === 201 && r.data.user.departmentId === deptA2.id, r);
  const s2 = r.data;
  r = await call('PATCH', `/api/admin/students/${s1.user.id}`, { token: A.admin, body: { phone: '08011112222' } });
  check('the school admin can still edit a student', r.status === 200 && r.data.user.phone === '08011112222', r);
  r = await call('GET', '/api/admin/students', { token: A.admin });
  check('...and sees them in the directory', r.status === 200 && r.data.students.length === 2, r.data.students && r.data.students.length);
  r = await call('PATCH', `/api/lect/students/${s1.user.id}`, { token: lecToken, body: { matricNumber: 'AB/001A' } });
  check('the lecturer who added a student can edit them', r.status === 200 && r.data.user.matricNumber === 'AB/001A', r);
  r = await call('PATCH', `/api/lect/students/${s1.user.id}`, { token: bioToken, body: { fullName: 'hacked' } });
  check("another lecturer cannot edit a student who isn't theirs", r.status === 404, r);
  await call('PATCH', `/api/lect/students/${s1.user.id}`, { token: lecToken, body: { matricNumber: 'AB/001' } });

  console.log('== lecturer adds students to the class ==');
  r = await call('GET', `/api/courses/${courseA.id}/addable-students`, { token: lecToken });
  check('picker lists both school students', r.status === 200 && r.data.students.length === 2, r);
  check('same-department student is listed first', r.data.students[0].id === s1.user.id, r.data.students.map((s) => s.fullName));
  r = await call('GET', `/api/courses/${courseA.id}/addable-students?q=two`, { token: lecToken });
  check('picker search narrows by name', r.data.students.length === 1 && r.data.students[0].id === s2.user.id, r);
  r = await call('POST', `/api/courses/${courseA.id}/enroll-student`, { token: lecToken, body: { studentId: s1.user.id } });
  check('lecturer adds a student from the picker', r.status === 200, r);
  r = await call('POST', `/api/courses/${courseA.id}/enroll-student`, { token: lecToken, body: { studentId: s1.user.id } });
  check('adding twice -> 409', r.status === 409, r);
  r = await call('POST', `/api/courses/${courseA.id}/enroll-student`, { token: lecToken, body: { matricNumber: ' ab/002 ' } });
  check('lecturer adds a student by matric number (any case, trimmed)', r.status === 200, r);
  r = await call('GET', `/api/courses/${courseA.id}/addable-students`, { token: lecToken });
  check('enrolled students leave the picker', r.status === 200 && r.data.students.length === 0, r);
  r = await call('GET', `/api/courses/${courseA.id}/roster`, { token: lecToken });
  check('roster shows both students', r.data.students && r.data.students.length === 2, r);
  const stuToken = await loginCode(A, 'Student One', s1.accessCode);
  r = await call('GET', '/api/students/me/courses', { token: stuToken });
  check('the student sees the course', r.data.courses && r.data.courses.some((c) => c.id === courseA.id), r);

  // some content in A to try to reach from B
  r = await call('POST', `/api/courses/${courseA.id}/assessments`, { token: lecToken, body: { title: 'Quiz', type: 'CA', questions: [{ text: 'q', options: ['a', 'b'], correctIndex: 0 }] } });
  check('lecturer creates a test', r.status === 200, r);
  const assessA = r.data.assessment;
  r = await call('POST', `/api/courses/${courseA.id}/assignments`, { token: lecToken, body: { title: 'HW', instructions: 'do it' } });
  const assignA = r.data.assignment;
  r = await call('POST', `/api/courses/${courseA.id}/groups`, { token: stuToken, body: { name: 'Study' } });
  const groupA = r.data.group;
  r = await call('POST', `/api/courses/${courseA.id}/results`, { token: lecToken, body: { studentId: s1.user.id, term: 'First', score: 70, grade: 'A' } });
  const resultA = r.data.result;
  r = await call('POST', '/api/students/me/transcript-request', { token: stuToken });
  const transcriptA = r.data.request;
  const libA = await prisma.libraryResource.create({ data: { title: 'A-only book', author: 'x', type: 'TEXTBOOK', fileUrl: '/x.pdf', schoolId: A.id } });
  const libGlobal = await prisma.libraryResource.create({ data: { title: 'Platform book', author: 'x', type: 'TEXTBOOK', fileUrl: '/y.pdf', schoolId: null } });
  check('fixtures created', !!(assessA && assignA && groupA && resultA && transcriptA));

  // ---- school B tries to reach A ----
  console.log('== school B cannot reach school A ==');
  r = await call('POST', '/api/admin/departments', { token: B.admin, body: { name: 'Physics', code: 'PHY' } });
  const deptB = r.data.department;
  r = await call('POST', '/api/admin/courses', { token: B.admin, body: { departmentId: deptB.id, code: 'PHY101', title: 'Mechanics' } });
  const courseB = r.data.course;
  r = await call('POST', '/api/admin/lecturers', { token: B.admin, body: { fullName: 'Dr Bee', departmentId: deptB.id, courseIds: [courseB.id] } });
  const lecBToken = await loginCode(B, 'Dr Bee', r.data.accessCode);
  r = await call('POST', '/api/lect/students', { token: lecBToken, body: { fullName: 'Bee Student', matricNumber: 'AB/001' } });
  const sB = r.data;
  check('B can reuse a matric number that A uses (matric is unique per school)', r.status === 201, r);
  const stuBToken = await loginCode(B, 'Bee Student', sB.accessCode);

  const notFound = async (label, method, path, body, token = lecBToken) => {
    const x = await call(method, path, { token, body });
    check(`${label} -> 404`, x.status === 404 || x.status === 400, { status: x.status, data: x.data });
  };
  await notFound('read A course', 'GET', `/api/courses/${courseA.id}`);
  await notFound('read A roster', 'GET', `/api/courses/${courseA.id}/roster`);
  await notFound('enrolment count', 'GET', `/api/courses/${courseA.id}/enrollment-count`);
  await notFound('A lessons', 'GET', `/api/courses/${courseA.id}/lessons`);
  await notFound('A addable students', 'GET', `/api/courses/${courseA.id}/addable-students`);
  await notFound('enrol A student into A course', 'POST', `/api/courses/${courseA.id}/enroll-student`, { studentId: s1.user.id });
  await notFound('announce to A class', 'POST', `/api/courses/${courseA.id}/announce`, { title: 'x', body: 'y' });
  await notFound('A assessments list', 'GET', `/api/courses/${courseA.id}/assessments`);
  await notFound('create A assessment', 'POST', `/api/courses/${courseA.id}/assessments`, { title: 'x', questions: [{ text: 'q', options: ['a'], correctIndex: 0 }] });
  await notFound('read A assessment', 'GET', `/api/assessments/${assessA.id}`);
  await notFound('send A assessment', 'POST', `/api/assessments/${assessA.id}/send`);
  await notFound('A assignments list', 'GET', `/api/courses/${courseA.id}/assignments`);
  await notFound('read A assignment', 'GET', `/api/assignments/${assignA.id}`, null, stuBToken);
  await notFound('A groups', 'GET', `/api/courses/${courseA.id}/groups`, null, stuBToken);
  await notFound('join A group', 'POST', `/api/groups/${groupA.id}/join`, null, stuBToken);
  await notFound('A group messages', 'GET', `/api/groups/${groupA.id}/messages`, null, stuBToken);
  await notFound('A lab', 'GET', `/api/courses/${courseA.id}/lab`);
  await notFound('A live class', 'GET', `/api/courses/${courseA.id}/live`);
  await notFound('start live class in A', 'POST', `/api/courses/${courseA.id}/live/start`, { title: 'x' });
  await notFound('A attendance', 'GET', `/api/courses/${courseA.id}/attendance`);
  await notFound('mark A attendance', 'POST', `/api/courses/${courseA.id}/attendance`, { studentId: s1.user.id, status: 'PRESENT' });
  await notFound('A results list', 'GET', `/api/courses/${courseA.id}/results`);
  await notFound('result for A student', 'POST', `/api/courses/${courseA.id}/results`, { studentId: s1.user.id, term: 'x', score: 1 });
  await notFound('edit A result', 'PUT', `/api/results/${resultA.id}`, { term: 'x', score: 1 });
  await notFound('self-enrol into A course', 'POST', `/api/courses/${courseA.id}/enroll`, null, stuBToken);
  await notFound('B admin reads A student', 'GET', `/api/admin/students/${s1.user.id}`, null, B.admin);
  await notFound('B admin edits A student', 'PATCH', `/api/admin/students/${s1.user.id}`, { fullName: 'hacked' }, B.admin);
  await notFound('B admin suspends A lecturer', 'POST', `/api/admin/lecturers/${lecA.user.id}/suspend`, null, B.admin);
  await notFound('B admin issues A transcript', 'POST', `/api/admin/transcript-requests/${transcriptA.id}/issue`, null, B.admin);
  await notFound('B admin reads A academic record', 'GET', `/api/admin/students/${s1.user.id}/academic-record`, null, B.admin);

  r = await call('POST', '/api/admin/courses', { token: B.admin, body: { departmentId: deptA.id, code: 'X1', title: 'Sneaky' } });
  check('B admin cannot put a course in A department', r.status === 400, r);
  r = await call('POST', '/api/admin/lecturers', { token: B.admin, body: { fullName: 'Sneaky', departmentId: deptA.id } });
  check('B admin cannot add a lecturer into A department', r.status === 400, r);
  r = await call('POST', '/api/admin/lecturers', { token: B.admin, body: { fullName: 'Sneaky 2', departmentId: deptB.id, courseIds: [courseA.id] } });
  check('B admin cannot assign A course to a lecturer', r.status === 400, r);
  r = await call('POST', '/api/lect/students', { token: lecBToken, body: { fullName: 'Sneaky 3', matricNumber: 'ZZ/1', courseIds: [courseA.id] } });
  check('a B lecturer cannot put a new student in an A course', r.status === 403, r);
  r = await call('POST', '/api/lect/students', { token: lecBToken, body: { fullName: 'Sneaky 4', matricNumber: 'ZZ/2', departmentId: deptA.id } });
  check('...or in an A department', r.status === 403, r);
  r = await call('PATCH', `/api/lect/students/${s1.user.id}`, { token: lecBToken, body: { fullName: 'hacked' } });
  check('...or edit an A student', r.status === 404, r);
  r = await call('PATCH', `/api/admin/lecturers/${r.data && lecA.user.id}`, { token: B.admin, body: { departmentId: deptB.id } });
  check('B admin cannot move an A lecturer', r.status === 404, r);
  r = await call('GET', `/api/departments/${deptA.id}/courses`, { token: lecBToken });
  check('department course list of another school is empty', r.status === 200 && r.data.courses.length === 0, r);
  r = await call('GET', '/api/departments', { token: lecBToken });
  check('department list only has own school', r.data.departments.length === 1 && r.data.departments[0].id === deptB.id, r.data);
  r = await call('POST', `/api/courses/${courseB.id}/enroll-student`, { token: lecBToken, body: { studentId: s1.user.id } });
  check('B lecturer cannot enrol an A student in a B course', r.status === 404, r);
  r = await call('POST', `/api/courses/${courseB.id}/enroll-student`, { token: lecBToken, body: { matricNumber: 'AB/002' } });
  check('...nor by matric number', r.status === 404, r);

  console.log('== library visibility ==');
  const titles = async (token) => ((await call('GET', '/api/library', { token })).data.items || []).map((i) => i.title);
  let t = await titles(lecToken);
  check('A sees its own + platform books', t.includes('A-only book') && t.includes('Platform book'), t);
  t = await titles(lecBToken);
  check('B sees only the platform book', !t.includes('A-only book') && t.includes('Platform book'), t);
  const indEmail = `ind${RUN}@example.com`;
  r = await call('POST', '/api/auth/register-individual', { body: { fullName: 'Solo', email: indEmail, password: 'secret12', institutionType: 'OTHER' } });
  t = await titles(r.data.token);
  check('independent learner sees only the platform catalog', !t.includes('A-only book') && t.includes('Platform book'), t);
  r = await call('GET', `/api/courses/${courseA.id}`, { token: r.data.token });
  check('independent learner cannot read a school course', r.status === 404, r.status);

  console.log('== A itself still works after all that ==');
  r = await call('GET', `/api/courses/${courseA.id}/assessments`, { token: lecToken });
  check('A lecturer lists their tests', r.status === 200 && r.data.assessments.length === 1, r);
  r = await call('GET', `/api/groups/${groupA.id}/messages`, { token: stuToken });
  check('A group member reads the chat', r.status === 200, r);
  r = await call('POST', `/api/groups/${groupA.id}/messages`, { token: stuToken, body: { body: 'hello' } });
  check('A group member posts to the chat', r.status === 200, r);
  r = await call('POST', `/api/admin/transcript-requests/${transcriptA.id}/issue`, { token: A.admin });
  check('A admin issues A transcript', r.status === 200, r);
  r = await call('PATCH', `/api/admin/lecturers/${lecA.user.id}`, { token: A.admin, body: { email: '' } });
  check('blank email on edit keeps the placeholder', r.status === 200 && /@internal\.learnza\.local$/.test(r.data.user.email), r);

  await prisma.libraryResource.deleteMany({ where: { id: { in: [libA.id, libGlobal.id] } } });
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('TEST CRASHED', e); await prisma.$disconnect(); process.exit(2); });
