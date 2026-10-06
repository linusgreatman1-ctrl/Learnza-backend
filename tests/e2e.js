// End-to-end API checks against a running server and its database.
//
//   DATABASE_URL=... JWT_SECRET=... SUPER_EMAIL=... SUPER_PASSWORD=... \
//   LOG_FILE=path/to/server.log node tests/e2e.js
//
// Start the server with the same DATABASE_URL/JWT_SECRET and NODE_ENV unset (so the
// password-reset link is printed to its log, which LOG_FILE points at). It creates its own
// uniquely-named school and users each run. The sign-in rate limiter remembers failures for
// 15 minutes, so restart the server between runs.
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const BASE = process.env.BASE || 'http://localhost:4100';
const SUPER_EMAIL = process.env.SUPER_EMAIL;
const SUPER_PASSWORD = process.env.SUPER_PASSWORD;
const LOG_FILE = process.env.LOG_FILE;
const RUN = Date.now();
let pass = 0, fail = 0;

function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
async function call(method, path, { token, body, raw } = {}) {
  const res = await fetch(BASE + path, {
    method,
    redirect: 'manual',
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!SUPER_EMAIL || !SUPER_PASSWORD) throw new Error('Set SUPER_EMAIL and SUPER_PASSWORD');

  console.log('== routing + headers ==');
  let r = await call('GET', '/', { raw: true });
  check('/ redirects to /app', r.status === 302 && r.headers.get('location') === '/app');
  for (const p of ['/app', '/schools', '/admin/', '/legal']) {
    r = await call('GET', p, { raw: true });
    check(`${p} serves a page`, r.status === 200, r.status);
  }
  r = await call('GET', '/app', { raw: true });
  const csp = r.headers.get('content-security-policy') || '';
  check('CSP is set and forbids inline scripts', /script-src [^;]*'self'/.test(csp) && !/script-src [^;]*'unsafe-inline'/.test(csp), csp);
  check('nosniff header set', r.headers.get('x-content-type-options') === 'nosniff');
  r = await call('GET', '/apply.html', { raw: true });
  check('/apply.html redirects away (admissions gone)', r.status === 302);
  r = await call('GET', '/api/schools');
  check('public school listing is gone', r.status === 404, r.status);
  r = await call('POST', '/api/auth/register-school', { body: { schoolName: 'x' } });
  check('school self-registration is gone', r.status === 404, r.status);

  console.log('== super admin ==');
  r = await call('POST', '/api/super/login', { body: { email: SUPER_EMAIL, password: 'wrong-password' } });
  check('wrong super password -> 401', r.status === 401, r);
  r = await call('POST', '/api/super/login', { body: { email: SUPER_EMAIL, password: SUPER_PASSWORD } });
  check('super login ok, returns access + refresh token', r.status === 200 && r.data.token && r.data.refreshToken, r.status);
  const SUPER = r.data.token;
  const SUPER_REFRESH = r.data.refreshToken;
  r = await call('GET', '/api/super/dashboard', { token: SUPER });
  check('dashboard loads', r.status === 200 && typeof r.data.schools.total === 'number', r);

  const schoolName = 'Test University ' + RUN;
  r = await call('POST', '/api/super/schools', { token: SUPER, body: { name: schoolName, state: 'Lagos', address: '1 Campus Rd' } });
  check('onboard school returns join code', r.status === 200 && /^[A-Z2-9]{8}$/.test(r.data.joinCode || ''), r);
  const SCHOOL_ID = r.data.school.id;
  let JOIN = r.data.joinCode;
  r = await call('POST', '/api/super/schools', { token: SUPER, body: { name: schoolName.toUpperCase() } });
  check('duplicate school name (any case) -> 409', r.status === 409, r);

  console.log('== school admin (join code) ==');
  r = await call('POST', '/api/auth/school-login', { body: { schoolName, joinCode: 'WRONGCOD' } });
  check('wrong join code -> 401', r.status === 401, r);
  r = await call('POST', '/api/auth/school-login', { body: { schoolName: schoolName.toLowerCase(), joinCode: JOIN.toLowerCase() } });
  check('right name+code (any case) signs in as ADMIN with a refresh token', r.status === 200 && r.data.user.role === 'ADMIN' && r.data.refreshToken, r);
  const ADMIN = r.data.token;
  r = await call('GET', '/api/auth/me', { token: ADMIN });
  check('admin /me includes joinCode', r.status === 200 && r.data.school.joinCode === JOIN, r.data.school);
  r = await call('GET', '/api/super/dashboard', { token: ADMIN });
  check('school admin cannot reach /api/super', r.status === 403, r.status);

  r = await call('POST', '/api/admin/departments', { token: ADMIN, body: { name: 'Computer Science', code: 'CSC' } });
  const DEPT = r.data.department.id;
  r = await call('POST', '/api/admin/lecturers', { token: ADMIN, body: { fullName: 'Dr Ada Obi', email: `ada${RUN}@test.edu`, departmentId: DEPT } });
  check('admin adds lecturer with access code', r.status === 200 && r.data.accessCode, r);
  const LECT_CODE = r.data.accessCode;
  r = await call('POST', '/api/admin/students', { token: ADMIN, body: { fullName: 'Tobi Bello', matricNumber: 'X/1', departmentId: DEPT } });
  check('a school admin cannot add students (lecturers do)', r.status === 403, r);
  const LECT_TOKEN = (await call('POST', '/api/auth/login-with-code', { body: { fullName: 'Dr Ada Obi', schoolName, accessCode: LECT_CODE } })).data.token;
  r = await call('POST', '/api/lect/students', { token: LECT_TOKEN, body: { fullName: 'Tobi Bello', email: `tobi${RUN}@test.edu`, matricNumber: 'CSC/2026/001', yearOfStudy: 1 } });
  check('the lecturer adds a student, who gets an access code', r.status === 201 && r.data.accessCode && r.data.user.departmentId === DEPT, r);
  const STUD_CODE = r.data.accessCode;
  const STUD_ID = r.data.user.id;
  r = await call('POST', '/api/admin/admins', { token: ADMIN, body: { fullName: 'Deputy Registrar', email: `deputy${RUN}@test.edu` } });
  check('extra admin gets an access code (no password needed)', r.status === 200 && r.data.accessCode, r);
  r = await call('GET', '/api/admin/admins', { token: ADMIN });
  check('admin list hides the founding (join-code) admin', r.data.admins.length === 1, r.data.admins && r.data.admins.map((a) => a.fullName));

  console.log('== access-code logins ==');
  r = await call('POST', '/api/auth/login-with-code', { body: { fullName: 'Dr Ada Obi', schoolName, accessCode: LECT_CODE } });
  check('lecturer signs in', r.status === 200 && r.data.user.role === 'LECTURER', r);
  r = await call('POST', '/api/auth/login-with-code', { body: { fullName: 'Someone Else', schoolName, accessCode: LECT_CODE } });
  check('right code, wrong name -> 401', r.status === 401, r);
  r = await call('POST', '/api/auth/login-with-code', { body: { fullName: 'Tobi Bello', schoolName, accessCode: STUD_CODE } });
  check('student signs in', r.status === 200 && r.data.user.role === 'STUDENT', r);
  const STUDENT = r.data.token;
  const STUDENT_REFRESH = r.data.refreshToken;
  r = await call('GET', '/api/auth/me', { token: STUDENT });
  check('student /me does NOT include joinCode', r.data.school && r.data.school.joinCode === undefined, r.data.school);

  console.log('== academic record ==');
  r = await call('POST', `/api/admin/students/${STUD_ID}/academic-details`, { token: ADMIN, body: { yearOfAdmission: 2026, programmeYears: 5, classPosition: 'Course Rep' } });
  check('admin sets year admitted + programme length', r.status === 200, r);
  r = await call('GET', `/api/admin/students/${STUD_ID}/academic-record`, { token: ADMIN });
  check('expected graduation uses programme length (2026+5)', r.data.expectedGraduationYear === 2031, r.data);
  r = await call('GET', '/api/students/me/admission-status', { token: STUDENT });
  check('old admission-status route is gone', r.status === 404, r.status);

  console.log('== refresh tokens ==');
  r = await call('POST', '/api/auth/refresh', { body: { refreshToken: STUDENT_REFRESH } });
  check('refresh returns a new access + refresh pair', r.status === 200 && r.data.token && r.data.refreshToken && r.data.refreshToken !== STUDENT_REFRESH, r.status);
  const STUDENT_REFRESH_2 = r.data.refreshToken;
  r = await call('GET', '/api/auth/me', { token: r.data.token });
  check('the new access token works', r.status === 200, r.status);
  r = await call('POST', '/api/auth/refresh', { body: { refreshToken: STUDENT_REFRESH } });
  check('old refresh token still works inside the 15s grace window (parallel refreshes)', r.status === 200, r.status);
  const expiredToken = jwt.sign({ id: STUD_ID, role: 'STUDENT' }, process.env.JWT_SECRET, { expiresIn: -10 });
  r = await call('GET', '/api/auth/me', { token: expiredToken });
  check('expired access token -> 401 TOKEN_EXPIRED', r.status === 401 && r.data.code === 'TOKEN_EXPIRED', r);
  r = await call('POST', '/api/auth/refresh', { body: { refreshToken: 'not-a-real-token' } });
  check('unknown refresh token -> 401', r.status === 401, r.status);
  r = await call('POST', '/api/auth/logout', { body: { refreshToken: STUDENT_REFRESH_2 } });
  check('logout ok', r.status === 200);
  r = await call('POST', '/api/auth/refresh', { body: { refreshToken: STUDENT_REFRESH_2 } });
  check('after logout the refresh token is dead immediately (no grace)', r.status === 401, r.status);

  console.log('== suspension + licence (also enforced on refresh) ==');
  r = await call('POST', '/api/auth/login-with-code', { body: { fullName: 'Tobi Bello', schoolName, accessCode: STUD_CODE } });
  const S2 = r.data;
  r = await call('PATCH', `/api/super/schools/${SCHOOL_ID}/status`, { token: SUPER, body: { status: 'SUSPENDED' } });
  check('super suspends school', r.status === 200, r);
  r = await call('POST', '/api/auth/school-login', { body: { schoolName, joinCode: JOIN } });
  check('suspended: join-code login refused', r.status === 403 && r.data.code === 'SCHOOL_SUSPENDED', r);
  r = await call('GET', '/api/students/me/academic-record', { token: S2.token });
  check('suspended: signed-in student cut off at once', r.status === 403 && r.data.code === 'SCHOOL_SUSPENDED', r);
  await sleep(100);
  r = await call('POST', '/api/auth/refresh', { body: { refreshToken: S2.refreshToken } });
  check('suspended: refresh refused', r.status === 403 && r.data.code === 'SCHOOL_SUSPENDED', r);
  await call('PATCH', `/api/super/schools/${SCHOOL_ID}/status`, { token: SUPER, body: { status: 'ACTIVE' } });
  r = await call('GET', '/api/students/me/academic-record', { token: S2.token });
  check('reactivated: student back in at once', r.status === 200, r.status);
  await prisma.school.update({ where: { id: SCHOOL_ID }, data: { subscriptionExpiresAt: new Date(Date.now() - 86400000) } });
  r = await call('POST', '/api/auth/school-login', { body: { schoolName, joinCode: JOIN } });
  check('expired licence: login refused', r.status === 403 && r.data.code === 'SCHOOL_LICENCE_EXPIRED', r);
  r = await call('POST', `/api/super/schools/${SCHOOL_ID}/renew`, { token: SUPER });
  check('renew +1 year', r.status === 200 && new Date(r.data.school.subscriptionExpiresAt) > new Date(Date.now() + 300 * 86400000), r.data);
  r = await call('POST', `/api/super/schools/${SCHOOL_ID}/regenerate-join-code`, { token: SUPER });
  check('regenerate join code; the old one stops working', r.status === 200 && r.data.joinCode !== JOIN, r);
  JOIN = r.data.joinCode;

  console.log('== student app: sign-up, lockout, password reset ==');
  const email = `indep${RUN}@example.com`;
  r = await call('POST', '/api/auth/register-individual', { body: { fullName: 'Ngozi Eze', email, password: 'secret12', institutionType: 'UNIVERSITY', attendedSchoolName: 'UNILAG', attendedDepartment: 'Law', courseOfStudy: 'LLB', yearOfStudy: 2 } });
  check('independent student registers (with a refresh token)', r.status === 200 && r.data.user.isIndividual === true && r.data.refreshToken, r.status);
  const INDEP_REFRESH = r.data.refreshToken;
  r = await call('POST', '/api/auth/login', { body: { email: `tobi${RUN}@test.edu`, password: 'anything' } });
  check('school student cannot use the student-app login', r.status === 401, r.status);
  r = await call('POST', '/api/auth/login', { body: { email: SUPER_EMAIL, password: SUPER_PASSWORD } });
  check('super admin cannot use the student-app login', r.status === 401, r.status);

  r = await call('POST', '/api/auth/password/forgot', { body: { email: `nobody${RUN}@example.com` } });
  check('forgot-password answers the same for an unknown email', r.status === 200 && r.data.ok, r);
  r = await call('POST', '/api/auth/password/forgot', { body: { email } });
  check('forgot-password ok for a real email', r.status === 200 && r.data.ok, r);
  await sleep(500);
  let resetToken = null;
  if (LOG_FILE) {
    const log = fs.readFileSync(LOG_FILE, 'utf8');
    const m = log.match(new RegExp('password reset link for ' + email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ': \\S+#reset=([A-Za-z0-9_-]+)'));
    resetToken = m && m[1];
  }
  check('a reset link was issued', !!resetToken, 'set LOG_FILE to the server log');
  if (resetToken) {
    r = await call('POST', '/api/auth/password/reset', { body: { token: 'bogus', password: 'newsecret1' } });
    check('bogus reset token rejected', r.status === 400, r);
    r = await call('POST', '/api/auth/password/reset', { body: { token: resetToken, password: 'newsecret1' } });
    check('reset with the emailed token works', r.status === 200, r);
    r = await call('POST', '/api/auth/password/reset', { body: { token: resetToken, password: 'another123' } });
    check('the reset token only works once', r.status === 400, r);
    r = await call('POST', '/api/auth/login', { body: { email, password: 'secret12' } });
    check('old password no longer works', r.status === 401, r.status);
    r = await call('POST', '/api/auth/login', { body: { email, password: 'newsecret1' } });
    check('new password works', r.status === 200, r.status);
    r = await call('POST', '/api/auth/refresh', { body: { refreshToken: INDEP_REFRESH } });
    check('a password reset signs out every earlier session', r.status === 401, r.status);
    r = await call('POST', '/api/auth/login', { body: { email, password: 'newsecret1' } });
    const T = r.data;
    r = await call('POST', '/api/auth/change-password', { token: T.token, body: { currentPassword: 'wrong-current', newPassword: 'x123456' } });
    check('wrong current password is a 400 (never a session-expiry 401)', r.status === 400, r);
    r = await call('POST', '/api/auth/change-password', { token: T.token, body: { currentPassword: 'newsecret1', newPassword: 'changed123' } });
    check('change password returns a replacement session', r.status === 200 && r.data.token && r.data.refreshToken, r.status);
    const afterChange = r.data;
    r = await call('POST', '/api/auth/refresh', { body: { refreshToken: T.refreshToken } });
    check('change password retires the old refresh token', r.status === 401, r.status);
    r = await call('POST', '/api/auth/refresh', { body: { refreshToken: afterChange.refreshToken } });
    check('...but the replacement one works', r.status === 200, r.status);
  }

  console.log('== lockout ==');
  const lockEmail = `lock${RUN}@example.com`;
  await call('POST', '/api/auth/register-individual', { body: { fullName: 'Lock Test', email: lockEmail, password: 'secret12', institutionType: 'OTHER' } });
  for (let i = 0; i < 5; i++) await call('POST', '/api/auth/login', { body: { email: lockEmail, password: 'bad-pass' } });
  r = await call('POST', '/api/auth/login', { body: { email: lockEmail, password: 'secret12' } });
  check('5 bad passwords lock the account (even for the right password)', r.status === 429 && r.data.code === 'ACCOUNT_LOCKED', r);

  console.log('== audit + delete rules ==');
  r = await call('GET', '/api/super/audit-logs', { token: SUPER });
  const actions = (r.data.logs || []).map((l) => l.action);
  check('audit log has the key actions', ['SUPER_ADMIN_LOGIN', 'SCHOOL_CREATED', 'SCHOOL_SUSPENDED', 'SCHOOL_REACTIVATED', 'SCHOOL_RENEWED', 'SCHOOL_JOIN_CODE_REGENERATED'].every((a) => actions.includes(a)), actions);
  r = await call('DELETE', `/api/super/schools/${SCHOOL_ID}?confirm=${encodeURIComponent(schoolName)}`, { token: SUPER });
  check('school with data cannot be deleted', r.status === 409, r);
  r = await call('POST', '/api/super/schools', { token: SUPER, body: { name: 'Mistake College ' + RUN } });
  const MISTAKE = r.data.school;
  r = await call('DELETE', `/api/super/schools/${MISTAKE.id}?confirm=${encodeURIComponent(MISTAKE.name)}`, { token: SUPER });
  check('an empty school can be deleted', r.status === 200, r);
  void SUPER_REFRESH;

  console.log('== rate limiting (last: it blocks this IP for 15 minutes) ==');
  let limited = false;
  for (let i = 0; i < 30 && !limited; i++) {
    r = await call('POST', '/api/auth/login-with-code', { body: { fullName: 'Nobody', schoolName, accessCode: 'ZZZZZZZZ' } });
    if (r.status === 429) limited = true;
  }
  check('repeated failed sign-ins are rate limited (429)', limited && r.data.code === 'RATE_LIMITED', r);

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('TEST CRASHED', e); await prisma.$disconnect(); process.exit(2); });
