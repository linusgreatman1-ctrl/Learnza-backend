// Query-count / N+1 check. Run against a server started with LZ_QUERY_COUNT=1:
//
//   LZ_QUERY_COUNT=1 node src/server.js
//   SUPER_EMAIL=... SUPER_PASSWORD=... node tests/perf.js
//
// Builds a SMALL school and a LARGE one, calls the main endpoints for every role in both, and
// compares how many database queries each request ran. A request whose query count grows with
// the amount of data (an N+1) is the usual cause of "it is slow with real data" — it fails here
// no matter how fast or slow the database connection happens to be.
const BASE = process.env.BASE || 'http://localhost:4100';
// PERF_QUICK=1 uses smaller schools and only the directory endpoints (minutes instead of a quarter hour
// when the database is far away)
const QUICK = process.env.PERF_QUICK === '1';
const SMALL = QUICK ? { students: 2, lecturers: 1, courses: 2 } : { students: 3, lecturers: 1, courses: 2 };
const LARGE = QUICK ? { students: 10, lecturers: 4, courses: 3 } : { students: 24, lecturers: 6, courses: 6 };
const RUN = Date.now();

async function call(method, path, { token, body } = {}) {
  const t = Date.now();
  const res = await fetch(BASE + path, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}), body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, queries: Number(res.headers.get('x-query-count')), dbMs: Number(res.headers.get('x-query-ms')), ms: Date.now() - t };
}
async function pool(items, size, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => { while (i < items.length) { const n = i++; out[n] = await fn(items[n], n); } }));
  return out;
}

async function build(SUPER, label, size) {
  const name = `Perf ${label} ${RUN}`;
  const s = await call('POST', '/api/super/schools', { token: SUPER, body: { name } });
  const admin = (await call('POST', '/api/auth/school-login', { body: { schoolName: name, joinCode: s.data.joinCode } })).data.token;
  const dept = (await call('POST', '/api/admin/departments', { token: admin, body: { name: 'Dept', code: 'D' + label } })).data.department;
  const courses = await pool(Array.from({ length: size.courses }), 3, (_, i) => call('POST', '/api/admin/courses', { token: admin, body: { departmentId: dept.id, code: `C${label}${i}`, title: `Course ${i}` } }).then((r) => r.data.course));
  const lecturers = await pool(Array.from({ length: size.lecturers }), 3, (_, i) => call('POST', '/api/admin/lecturers', { token: admin, body: { fullName: `Lec ${label} ${i}`, departmentId: dept.id, courseIds: courses.map((c) => c.id) } }).then((r) => r.data));
  const students = await pool(Array.from({ length: size.students }), 4, (_, i) => call('POST', '/api/admin/students', { token: admin, body: { fullName: `Stu ${label} ${i}`, matricNumber: `${label}/${i}`, departmentId: dept.id, yearOfStudy: 1, courseIds: courses.map((c) => c.id) } }).then((r) => r.data));
  const login = async (n, code) => (await call('POST', '/api/auth/login-with-code', { body: { fullName: n, schoolName: name, accessCode: code } })).data.token;
  const lecToken = await login(`Lec ${label} 0`, lecturers[0].accessCode);
  const stuToken = await login(`Stu ${label} 0`, students[0].accessCode);
  // some activity so the lists have rows: results, attendance, an assessment, a group, a lesson
  const c0 = courses[0];
  for (const st of students.slice(0, Math.min(students.length, 8))) {
    await call('POST', `/api/courses/${c0.id}/results`, { token: lecToken, body: { studentId: st.user.id, term: 'First', score: 60, grade: 'B', send: true } });
    await call('POST', `/api/courses/${c0.id}/attendance`, { token: lecToken, body: { studentId: st.user.id, status: 'PRESENT' } });
  }
  await call('POST', `/api/courses/${c0.id}/assessments`, { token: lecToken, body: { title: 'Quiz', type: 'CA', questions: [{ text: 'q', options: ['a', 'b'], correctIndex: 0 }] } });
  await call('POST', `/api/courses/${c0.id}/groups`, { token: stuToken, body: { name: 'Grp' } });
  return { name, admin, lecToken, stuToken, course: c0, student: students[0].user, dept };
}

function endpoints(w) {
  const c = w.course.id, sid = w.student.id;
  return [
    ['admin', 'GET /admin/students', w.admin, '/api/admin/students'],
    ['admin', 'GET /admin/lecturers', w.admin, '/api/admin/lecturers'],
    ['admin', 'GET /admin/non-academic-staff', w.admin, '/api/admin/non-academic-staff'],
    ['admin', 'GET /admin/courses', w.admin, '/api/admin/courses'],
    ['admin', 'GET /admin/lecturer-activity', w.admin, '/api/admin/lecturer-activity'],
    ['admin', 'GET /admin/student-activity', w.admin, '/api/admin/student-activity'],
    ['admin', 'GET /admin/staff/workload', w.admin, '/api/admin/staff/workload'],
    ['admin', 'GET /admin/staff/attendance', w.admin, '/api/admin/staff/attendance'],
    ['admin', 'GET /admin/hostels', w.admin, '/api/admin/hostels'],
    ['admin', 'GET /admin/transcript-requests', w.admin, '/api/admin/transcript-requests'],
    ['admin', 'GET /admin/lab', w.admin, '/api/admin/lab'],
    ['admin', 'GET /admin/students/:id', w.admin, `/api/admin/students/${sid}`],
    ['admin', 'GET /admin/students/:id/academic-record', w.admin, `/api/admin/students/${sid}/academic-record`],
    ['lecturer', 'GET /courses/:id/roster', w.lecToken, `/api/courses/${c}/roster`],
    ['lecturer', 'GET /courses/:id/results', w.lecToken, `/api/courses/${c}/results`],
    ['lecturer', 'GET /courses/:id/attendance', w.lecToken, `/api/courses/${c}/attendance`],
    ['lecturer', 'GET /courses/:id/assessments', w.lecToken, `/api/courses/${c}/assessments`],
    ['lecturer', 'GET /courses/:id/assignments', w.lecToken, `/api/courses/${c}/assignments`],
    ['lecturer', 'GET /courses/:id/addable-students', w.lecToken, `/api/courses/${c}/addable-students`],
    ['lecturer', 'GET /lecturer/unmarked-assignment-submissions', w.lecToken, '/api/lecturer/unmarked-assignment-submissions'],
    ['lecturer', 'GET /lect/students/:id', w.lecToken, `/api/lect/students/${sid}`],
    ['student', 'GET /students/me/dashboard', w.stuToken, '/api/students/me/dashboard'],
    ['student', 'GET /students/me/courses', w.stuToken, '/api/students/me/courses'],
    ['student', 'GET /students/me/results', w.stuToken, '/api/students/me/results'],
    ['student', 'GET /students/me/formal-results', w.stuToken, '/api/students/me/formal-results'],
    ['student', 'GET /students/me/academic-record', w.stuToken, '/api/students/me/academic-record'],
    ['student', 'GET /courses/:id/assessments', w.stuToken, `/api/courses/${c}/assessments`],
    ['student', 'GET /courses/:id/lessons', w.stuToken, `/api/courses/${c}/lessons`],
    ['student', 'GET /courses/:id/groups', w.stuToken, `/api/courses/${c}/groups`],
    ['student', 'GET /library', w.stuToken, '/api/library'],
    ['student', 'GET /notifications', w.stuToken, '/api/notifications'],
    ['student', 'GET /auth/me', w.stuToken, '/api/auth/me'],
    ['student', 'GET /billing/status', w.stuToken, '/api/billing/status'],
    ['student', 'GET /coins', w.stuToken, '/api/coins'],
    ['student', 'GET /semesters', w.stuToken, '/api/semesters'],
  ];
}

(async () => {
  const login = await call('POST', '/api/super/login', { body: { email: process.env.SUPER_EMAIL, password: process.env.SUPER_PASSWORD } });
  const SUPER = login.data.token;
  if (!SUPER) throw new Error('super login failed');
  console.log('Building a small and a large school (this takes a minute)…');
  const [S, L] = [await build(SUPER, 'S', SMALL), await build(SUPER, 'L', LARGE)];
  const keep = (e) => !QUICK || /\/admin\/(students|lecturers|staff\/workload)$/.test(e[3]);
  const es = endpoints(S).filter(keep), el = endpoints(L).filter(keep);
  let bad = 0;
  console.log(`\n${'endpoint'.padEnd(50)} ${'small'.padStart(6)} ${'large'.padStart(6)}  status`);
  for (let i = 0; i < es.length; i++) {
    const a = await call('GET', es[i][3], { token: es[i][2] });
    const b = await call('GET', el[i][3], { token: el[i][2] });
    const grows = b.queries > a.queries + 1;
    const ok = a.status === 200 && b.status === 200 && !grows && b.queries <= 14;
    if (!ok) bad++;
    console.log(`${(es[i][0] + ' ' + es[i][1]).padEnd(50)} ${String(a.queries).padStart(6)} ${String(b.queries).padStart(6)}  ${ok ? 'ok' : 'FAIL ' + (a.status !== 200 || b.status !== 200 ? `HTTP ${a.status}/${b.status}` : grows ? 'queries grow with data (N+1)' : 'too many queries')}`);
  }
  console.log(`\n${bad ? bad + ' endpoint(s) need attention' : 'every endpoint runs a fixed number of queries regardless of data size'}`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('PERF TEST CRASHED', e); process.exit(2); });
