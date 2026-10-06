// Digital ID: every kind of account can sign in and has what the card needs; photos can be
// added by the owner of the card, a school admin, or the lecturer who teaches the student.
//
//   DATABASE_URL=... JWT_SECRET=... SUPER_EMAIL=... SUPER_PASSWORD=... node tests/digital-id.js
const BASE = process.env.BASE || 'http://localhost:4100';
const RUN = Date.now();
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
async function call(method, path, { token, body, form } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: Object.assign(form ? {} : { 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: form || (body ? JSON.stringify(body) : undefined),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
// the smallest valid PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const photoForm = () => { const f = new FormData(); f.append('avatar', new Blob([PNG], { type: 'image/png' }), 'p.png'); return f; };

(async () => {
  let r = await call('POST', '/api/super/login', { body: { email: process.env.SUPER_EMAIL, password: process.env.SUPER_PASSWORD } });
  const SUPER = r.data.token;
  if (!SUPER) throw new Error('super login failed');
  const mkSchool = async (label) => {
    const name = `ID ${label} ${RUN}`;
    const s = await call('POST', '/api/super/schools', { token: SUPER, body: { name, state: 'Kano' } });
    const a = await call('POST', '/api/auth/school-login', { body: { schoolName: name, joinCode: s.data.joinCode } });
    return { name, admin: a.data.token, adminUser: a.data.user };
  };
  const A = await mkSchool('A');
  const B = await mkSchool('B');
  const dept = (await call('POST', '/api/admin/departments', { token: A.admin, body: { name: 'Law', code: 'LAW' } })).data.department;
  const c1 = (await call('POST', '/api/admin/courses', { token: A.admin, body: { departmentId: dept.id, code: 'LAW101', title: 'Intro' } })).data.course;
  const c2 = (await call('POST', '/api/admin/courses', { token: A.admin, body: { departmentId: dept.id, code: 'LAW102', title: 'Other' } })).data.course;
  const lecA = (await call('POST', '/api/admin/lecturers', { token: A.admin, body: { fullName: 'Dr ID ' + RUN, departmentId: dept.id, staffId: 'STF/1', courseIds: [c1.id] } })).data;
  const lecOther = (await call('POST', '/api/admin/lecturers', { token: A.admin, body: { fullName: 'Dr Other ' + RUN, departmentId: dept.id, courseIds: [c2.id] } })).data;
  const staff = (await call('POST', '/api/admin/non-academic-staff', { token: A.admin, body: { fullName: 'Lib ' + RUN, position: 'Librarian' } })).data;
  const login = async (school, name, code) => (await call('POST', '/api/auth/login-with-code', { body: { fullName: name, schoolName: school.name, accessCode: code } }));
  const lecAToken = (await login(A, 'Dr ID ' + RUN, lecA.accessCode)).data.token;
  const stu = (await call('POST', '/api/lect/students', { token: lecAToken, body: { fullName: 'Stu ' + RUN, matricNumber: 'L/1', yearOfStudy: 2, courseIds: [c1.id] } })).data;

  console.log('== every kind of account can sign in and has what its card needs ==');
  const sStaff = await login(A, 'Lib ' + RUN, staff.accessCode);
  check('non-academic staff can sign in', sStaff.status === 200 && sStaff.data.user.role === 'STAFF', sStaff.data);
  const me = await call('GET', '/api/auth/me', { token: sStaff.data.token });
  check('staff /me has id, position, school and createdAt for the card', me.data.user.id && me.data.user.position === 'Librarian' && me.data.user.createdAt && me.data.school && me.data.school.name === A.name, me.data);
  const sAdmin = await call('GET', '/api/auth/me', { token: A.admin });
  check('school admin /me has what the card needs', sAdmin.data.user.role === 'ADMIN' && sAdmin.data.user.id && sAdmin.data.school.name === A.name);
  const sLec = await login(A, 'Dr ID ' + RUN, lecA.accessCode);
  const lecMe = await call('GET', '/api/auth/me', { token: sLec.data.token });
  check('lecturer /me has staffId and department', lecMe.data.user.staffId === 'STF/1' && lecMe.data.user.departmentId === dept.id);
  const sStu = await login(A, 'Stu ' + RUN, stu.accessCode);
  const stuMe = await call('GET', '/api/auth/me', { token: sStu.data.token });
  check('student /me has matric number and level', stuMe.data.user.matricNumber === 'L/1' && stuMe.data.user.yearOfStudy === 2);
  const ind = await call('POST', '/api/auth/register-individual', { body: { fullName: 'Solo ' + RUN, email: `solo${RUN}@example.com`, password: 'secret12', institutionType: 'MONOTECHNIC', attendedSchoolName: 'Yaba Mono', courseOfStudy: 'Lab Tech', yearOfStudy: 1 } });
  const indMe = await call('GET', '/api/auth/me', { token: ind.data.token });
  check('independent student /me has institution and programme', indMe.data.user.attendedSchoolName === 'Yaba Mono' && indMe.data.user.courseOfStudy === 'Lab Tech' && indMe.data.user.institutionType === 'MONOTECHNIC');

  console.log('== everyone can add their own photo ==');
  for (const [label, token] of [['staff', sStaff.data.token], ['school admin', A.admin], ['lecturer', sLec.data.token], ['student', sStu.data.token], ['independent student', ind.data.token]]) {
    r = await call('POST', '/api/auth/me/avatar', { token, form: photoForm() });
    check(`${label} can set their own photo`, r.status === 200 && !!r.data.user.avatarUrl, r.data);
  }

  console.log('== photos set by someone else ==');
  r = await call('POST', `/api/admin/users/${lecA.user.id}/photo`, { token: A.admin, form: photoForm() });
  check('school admin sets a lecturer\'s photo', r.status === 200 && r.data.user.avatarUrl, r.data);
  r = await call('POST', `/api/admin/users/${staff.user.id}/photo`, { token: A.admin, form: photoForm() });
  check('...and a staff member\'s', r.status === 200);
  r = await call('POST', `/api/admin/users/${stu.user.id}/photo`, { token: A.admin, form: photoForm() });
  check('...and a student\'s', r.status === 200);
  r = await call('POST', `/api/admin/users/${stu.user.id}/photo`, { token: B.admin, form: photoForm() });
  check('another school\'s admin cannot', r.status === 404);
  r = await call('POST', `/api/admin/users/${A.adminUser.id}/photo`, { token: A.admin, form: photoForm() });
  check('the admin route does not touch admin accounts (they use their own)', r.status === 404);
  r = await call('POST', `/api/admin/users/${stu.user.id}/photo`, { token: A.admin });
  check('no file -> 400', r.status === 400);
  r = await call('POST', `/api/admin/users/${stu.user.id}/photo`, { token: sStu.data.token, form: photoForm() });
  check('a student cannot use the admin route', r.status === 403);
  r = await call('POST', `/api/lect/students/${stu.user.id}/photo`, { token: sLec.data.token, form: photoForm() });
  check('the lecturer who teaches the student sets their photo', r.status === 200 && r.data.user.avatarUrl, r.data);
  const lecO = await login(A, 'Dr Other ' + RUN, lecOther.accessCode);
  r = await call('POST', `/api/lect/students/${stu.user.id}/photo`, { token: lecO.data.token, form: photoForm() });
  check('a lecturer who does not teach them cannot', r.status === 404);
  r = await call('POST', `/api/lect/students/${stu.user.id}/photo`, { token: sStu.data.token, form: photoForm() });
  check('students cannot use the lecturer route', r.status === 403);

  console.log('== what lecturers and admins see ==');
  r = await call('GET', `/api/lect/students/${stu.user.id}`, { token: sLec.data.token });
  check('lecturer\'s student detail carries id, photo and level for the card', r.data.id === stu.user.id && !!r.data.avatarUrl && r.data.yearOfStudy === 2 && r.data.createdAt, r.data);
  r = await call('GET', `/api/admin/students/${stu.user.id}`, { token: A.admin });
  check('admin\'s student detail carries the photo and department', !!r.data.student.avatarUrl && r.data.student.department.name === 'Law');
  r = await call('GET', `/api/admin/non-academic-staff/${staff.user.id}`, { token: A.admin });
  check('admin\'s staff detail carries the photo and position', !!r.data.staff.avatarUrl && r.data.staff.position === 'Librarian', r.data);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST CRASHED', e); process.exit(2); });
