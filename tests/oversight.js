// Owner-side oversight views, question bank, system logs, access codes and the Code Editor.
//
//   DATABASE_URL=... JWT_SECRET=... SUPER_EMAIL=... SUPER_PASSWORD=... node tests/oversight.js
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');

const prisma = new PrismaClient();
const BASE = process.env.BASE || 'http://localhost:4100';
const RUN = Date.now();
const LEC_NAME = 'Dr Over ' + RUN;
const STU_NAME = 'Over Student ' + RUN;
let pass = 0, fail = 0;

function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
async function call(method, p, { token, body } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const text = async (p) => { const r = await fetch(BASE + p); return { status: r.status, type: r.headers.get('content-type'), body: await r.text() }; };

(async () => {
  let r = await call('POST', '/api/super/login', { body: { email: process.env.SUPER_EMAIL, password: process.env.SUPER_PASSWORD } });
  const SUPER = r.data.token;
  if (!SUPER) throw new Error('super login failed');

  // fixtures: a school with a lecturer, a student, a course, a result
  const name = 'Oversight Test ' + RUN;
  r = await call('POST', '/api/super/schools', { token: SUPER, body: { name } });
  r = await call('POST', '/api/auth/school-login', { body: { schoolName: name, joinCode: r.data.joinCode } });
  const admin = r.data.token;
  const dept = (await call('POST', '/api/admin/departments', { token: admin, body: { name: 'Biology', code: 'BIO' } })).data.department;
  const course = (await call('POST', '/api/admin/courses', { token: admin, body: { departmentId: dept.id, code: 'BIO101', title: 'Intro Biology' } })).data.course;
  const lec = (await call('POST', '/api/admin/lecturers', { token: admin, body: { fullName: LEC_NAME, departmentId: dept.id, courseIds: [course.id] } })).data;
  const stu = (await call('POST', '/api/admin/students', { token: admin, body: { fullName: STU_NAME, matricNumber: 'O/1', departmentId: dept.id, yearOfStudy: 1, courseIds: [course.id] } })).data;
  const lecToken = (await call('POST', '/api/auth/login-with-code', { body: { fullName: LEC_NAME, schoolName: name, accessCode: lec.accessCode } })).data.token;
  const stuToken = (await call('POST', '/api/auth/login-with-code', { body: { fullName: STU_NAME, schoolName: name, accessCode: stu.accessCode } })).data.token;
  await call('POST', `/api/courses/${course.id}/results`, { token: lecToken, body: { studentId: stu.user.id, term: 'First 2026', score: 72, grade: 'A', send: true } });
  await call('POST', `/api/courses/${course.id}/attendance`, { token: lecToken, body: { studentId: stu.user.id, status: 'PRESENT' } });
  await call('POST', `/api/courses/${course.id}/lessons`, { token: lecToken, body: { title: 'Cells', script: 'All about cells' } }).catch(() => {});

  console.log('== access control ==');
  for (const p of ['/analytics', '/questions', '/lessons', '/courses', '/demonstrations', '/attendance', '/results', '/teachers', '/academic-records', '/system-logs', '/codes/users', '/code/files']) {
    const anon = await call('GET', '/api/super' + p);
    const nonOwner = await call('GET', '/api/super' + p, { token: lecToken });
    if (anon.status !== 401 || nonOwner.status !== 403) check('guarded ' + p, false, [anon.status, nonOwner.status]);
  }
  check('every new owner route refuses anonymous callers and non-owners', true);

  console.log('== oversight views ==');
  r = await call('GET', '/api/super/analytics?days=14', { token: SUPER });
  check('analytics: 14 labelled days and every series', r.status === 200 && r.data.labels.length === 14 && ['schoolSignups', 'independentSignups', 'activeUsers', 'revenueKobo', 'aiQuestions', 'testsSubmitted', 'liveClasses'].every((k) => r.data.series[k].length === 14), r.data.series && Object.keys(r.data.series));
  check('analytics: today shows the sign-ups just made', r.data.series.schoolSignups.reduce((a, b) => a + b, 0) >= 3, r.data.series.schoolSignups);
  r = await call('GET', '/api/super/lessons?search=Cells', { token: SUPER });
  check('lessons list (searchable)', r.status === 200 && Array.isArray(r.data.lessons));
  r = await call('GET', `/api/super/courses?search=BIO101`, { token: SUPER });
  check('courses show school, students and lecturers', r.data.courses.some((c) => c.code === 'BIO101' && c.students === 1 && c.lecturers.includes(LEC_NAME) && c.schoolName === name), r.data.courses);
  r = await call('GET', '/api/super/courses?kind=self', { token: SUPER });
  check('self-study courses list', r.status === 200);
  r = await call('GET', '/api/super/attendance', { token: SUPER });
  check('class attendance summary includes the course', r.data.courses.some((c) => c.code === 'BIO101' && c.present === 1 && c.rate === 100), r.data);
  r = await call('GET', '/api/super/attendance?kind=staff', { token: SUPER });
  check('staff attendance list', r.status === 200 && Array.isArray(r.data.records));
  r = await call('GET', `/api/super/results?search=${encodeURIComponent(STU_NAME)}`, { token: SUPER });
  check('results across schools (searchable)', r.data.results.some((x) => x.student === STU_NAME && x.score === 72 && x.sentAt), r.data);
  r = await call('GET', `/api/super/teachers?search=${encodeURIComponent(LEC_NAME)}`, { token: SUPER });
  check('teachers show courses and school', r.data.teachers.length === 1 && r.data.teachers[0].courses === 1 && r.data.teachers[0].school.name === name, r.data);
  check('placeholder emails are never shown', r.data.teachers[0].email === null);
  r = await call('GET', `/api/super/academic-records?search=${encodeURIComponent(STU_NAME)}`, { token: SUPER });
  check('academic records list with CGPA', r.data.students.length === 1 && r.data.students[0].cgpa === 5 && r.data.students[0].level === '100L', r.data.students);
  r = await call('GET', `/api/super/academic-records/${r.data.students[0].id}`, { token: SUPER });
  check('academic record detail', r.status === 200 && r.data.schoolName === name && r.data.results.length === 1 && r.data.record.department === 'Biology', r.data);
  r = await call('GET', '/api/super/academic-records/not-a-student', { token: SUPER });
  check('unknown record -> 404', r.status === 404);

  console.log('== demonstrations ==');
  const demo = await prisma.labDemonstration.create({ data: { courseId: course.id, title: 'Osmosis ' + RUN, description: 'd', stepsJson: JSON.stringify([{ title: 'Step 1', instruction: 'Do it', expectedResult: 'It works' }]), source: 'CURATED', status: 'APPROVED' } });
  r = await call('GET', '/api/super/demonstrations?source=CURATED', { token: SUPER });
  check('demonstrations list', r.data.demonstrations.some((d) => d.id === demo.id && d.steps === 1 && d.schoolName === name));
  r = await call('GET', `/api/courses/${course.id}/lab`, { token: stuToken });
  check('students see it while visible', r.data.demonstrations.some((d) => d.id === demo.id));
  r = await call('PATCH', `/api/super/demonstrations/${demo.id}`, { token: SUPER, body: { status: 'REJECTED' } });
  r = await call('GET', `/api/courses/${course.id}/lab`, { token: stuToken });
  check('hiding it removes it from students', !r.data.demonstrations.some((d) => d.id === demo.id));
  r = await call('PATCH', `/api/super/demonstrations/${demo.id}`, { token: SUPER, body: { status: 'NOPE' } });
  check('bad status refused', r.status === 400);
  r = await call('DELETE', `/api/super/demonstrations/${demo.id}`, { token: SUPER });
  check('delete a demonstration', r.status === 200);

  console.log('== question bank ==');
  r = await call('POST', '/api/super/questions', { token: SUPER, body: { subject: 'Biology ' + RUN, text: 'Powerhouse of the cell?', options: ['Nucleus', 'Mitochondria', 'Ribosome'], correctIndex: 1, explanation: 'ATP is made there.' } });
  check('add a question', r.status === 200 && r.data.question.options.length === 3, r);
  const q1 = r.data.question;
  r = await call('POST', '/api/super/questions', { token: SUPER, body: { subject: 'x', text: 'q', options: ['a'], correctIndex: 0 } });
  check('needs 2+ options', r.status === 400);
  r = await call('POST', '/api/super/questions', { token: SUPER, body: { subject: 'x', text: 'q', options: ['a', 'b'], correctIndex: 5 } });
  check('correct option must exist', r.status === 400);
  r = await call('POST', '/api/super/questions/bulk', { token: SUPER, body: { subject: 'Biology ' + RUN, questions: [{ text: 'DNA stands for?', options: ['A', 'B'], correctIndex: 0 }, { text: 'bad', options: ['A'], correctIndex: 0 }] } });
  check('bulk import is all-or-nothing and says which item is wrong', r.status === 400 && r.data.problems[0].startsWith('#2'), r.data);
  r = await call('POST', '/api/super/questions/bulk', { token: SUPER, body: { subject: 'Biology ' + RUN, questions: [{ text: 'DNA stands for?', options: ['Deoxyribonucleic acid', 'Other'], correctIndex: 0 }, { text: 'RNA is?', options: ['Single stranded', 'Double'], correctIndex: 0 }] } });
  check('bulk import', r.status === 200 && r.data.added === 2, r);
  r = await call('GET', '/api/super/questions?subject=' + encodeURIComponent('Biology ' + RUN), { token: SUPER });
  check('subject filter + counts', r.data.questions.length === 3 && r.data.subjects.find((s) => s.subject === 'Biology ' + RUN).count === 3, r.data.subjects);

  r = await call('GET', '/api/questions/subjects', { token: stuToken });
  check('students see the subject', r.data.subjects.some((s) => s.subject === 'Biology ' + RUN));
  r = await call('GET', '/api/questions/practice?subject=' + encodeURIComponent('Biology ' + RUN) + '&count=5', { token: stuToken });
  check('practice set never includes the answers', r.status === 200 && r.data.questions.length === 3 && r.data.questions.every((q) => q.correctIndex === undefined && q.explanation === undefined), r.data.questions[0]);
  const set = r.data.questions;
  const mito = set.find((q) => q.id === q1.id);
  r = await call('POST', '/api/questions/check', { token: stuToken, body: { answers: set.map((q) => ({ id: q.id, choice: q.id === q1.id ? 1 : 1 })) } });
  const mitoReview = r.data.review.find((x) => x.id === q1.id);
  check('grading happens on the server: correct answer scores, review reveals the key + explanation', mitoReview.correct === true && mitoReview.explanation === 'ATP is made there.' && r.data.score >= 1 && r.data.total === 3, r.data);
  check('a student earned points for practising', r.data.points >= 10, r.data.points);
  r = await call('POST', '/api/questions/check', { token: stuToken, body: { answers: [{ id: q1.id, choice: 0 }] } });
  check('wrong answer scores 0', r.data.score === 0 && r.data.review[0].correct === false);
  void mito;
  r = await call('PUT', `/api/super/questions/${q1.id}`, { token: SUPER, body: { subject: 'Biology ' + RUN, text: 'Powerhouse?', options: ['Nucleus', 'Mitochondria'], correctIndex: 1, active: false } });
  check('edit / hide a question', r.status === 200 && r.data.question.active === false);
  r = await call('GET', '/api/questions/practice?subject=' + encodeURIComponent('Biology ' + RUN) + '&count=5', { token: stuToken });
  check('hidden questions are not served', r.data.questions.length === 2 && !r.data.questions.some((q) => q.id === q1.id));
  r = await call('GET', '/api/questions/practice?subject=Nope', { token: stuToken });
  check('unknown subject -> 404', r.status === 404);
  await prisma.platformQuestion.deleteMany({ where: { subject: 'Biology ' + RUN } });

  console.log('== system logs ==');
  const syslog = require('../src/syslog');
  await syslog.error('test', 'Synthetic failure ' + RUN, { detail: 'stack here', method: 'GET', path: '/x' });
  r = await call('GET', '/api/super/system-logs?level=ERROR&search=' + RUN, { token: SUPER });
  check('errors are listed and searchable', r.data.logs.length === 1 && r.data.logs[0].detail === 'stack here' && r.data.errors24h >= 1, r.data);
  r = await call('DELETE', '/api/super/system-logs?olderThanDays=3650', { token: SUPER });
  check('clearing logs older than N days keeps recent ones', r.status === 200);
  r = await call('GET', '/api/super/system-logs?search=' + RUN, { token: SUPER });
  check('...recent log still there', r.data.logs.length === 1);

  console.log('== access codes ==');
  r = await call('GET', `/api/super/codes/users?search=${encodeURIComponent(LEC_NAME)}`, { token: SUPER });
  check('access code visible to the owner', r.data.users.length === 1 && r.data.users[0].accessCode === lec.accessCode);
  const oldCode = lec.accessCode;
  r = await call('POST', `/api/super/codes/users/${lec.user.id}/regenerate`, { token: SUPER });
  check('regenerate returns a new code', r.status === 200 && r.data.accessCode && r.data.accessCode !== oldCode, r);
  r = await call('POST', '/api/auth/login-with-code', { body: { fullName: LEC_NAME, schoolName: name, accessCode: oldCode } });
  check('the old code stops working', r.status === 401);
  const bad = await call('POST', '/api/super/codes/users/nope/regenerate', { token: SUPER });
  check('unknown user -> 404', bad.status === 404);

  console.log('== bulk email / SMS ==');
  r = await call('POST', '/api/super/bulk', { token: SUPER, body: { channel: 'EMAIL', audience: 'EVERYONE', subject: 's', body: 'b' } });
  check('email refused clearly when SMTP is not configured', r.status === 400 && /not set up/.test(r.data.error), r);
  r = await call('POST', '/api/super/bulk', { token: SUPER, body: { channel: 'FAX', audience: 'EVERYONE', body: 'b' } });
  check('unknown channel refused', r.status === 400);

  console.log('== Code Editor / Codes (live source) ==');
  r = await call('GET', '/api/super/code/files', { token: SUPER });
  const names = r.data.files.map((f) => f.path);
  check('lists the front-end files, but not the service worker', names.includes('app.js') && names.includes('schools.html') && !names.includes('sw.js'), names);
  for (const bad of ['../src/server.js', 'sw.js', 'package.json']) {
    r = await call('GET', '/api/super/code/content?path=' + encodeURIComponent(bad), { token: SUPER });
    check('cannot open ' + bad, r.status === 400 || r.status === 404, r.status);
  }

  const FILE = 'verify.js';
  const original = fs.readFileSync(path.join(__dirname, '..', 'public', FILE), 'utf8');
  r = await call('GET', '/api/super/code/content?path=' + FILE, { token: SUPER });
  check('Codes: opens the whole raw file', r.status === 200 && r.data.content === original && r.data.customised === false && r.data.lines > 1);
  r = await call('POST', '/api/super/code/save', { token: SUPER, body: { path: FILE, content: 'function ( {' } });
  check('JavaScript that does not parse is refused', r.status === 400 && /JavaScript error/.test(r.data.error), r);
  let served = await text('/' + FILE);
  check('...and nothing changed for users', served.body === original);
  const edited = original + '\n// marker-A\n// marker-A\n';
  r = await call('POST', '/api/super/code/save', { token: SUPER, body: { path: FILE, content: edited } });
  check('Codes: save goes live immediately', r.status === 200);
  served = await text('/' + FILE);
  check('users get the saved file', served.body === edited && /javascript/.test(served.type));
  r = await call('POST', '/api/super/code/save', { token: SUPER, body: { path: FILE, content: edited } });
  check('saving identical content is a no-op', r.data.unchanged === true);

  r = await call('POST', '/api/super/code/search', { token: SUPER, body: { file: FILE, query: 'marker-A' } });
  check('search finds both occurrences with line numbers and context', r.data.totalMatches === 2 && r.data.matches[0].line > 0 && r.data.matches[0].before.length > 0, r.data);
  r = await call('POST', '/api/super/code/search', { token: SUPER, body: { file: FILE, query: 'definitely-not-present-xyz' } });
  check('search with no match', r.data.totalMatches === 0);
  r = await call('POST', '/api/super/code/replace', { token: SUPER, body: { file: FILE, find: 'marker-A', replaceWith: 'marker-B' } });
  check('replace refuses an ambiguous snippet and says how many', r.status === 409 && r.data.occurrences === 2, r);
  r = await call('POST', '/api/super/code/replace', { token: SUPER, body: { file: FILE, find: 'marker-A', replaceWith: 'marker-B', occurrenceIndex: 1 } });
  served = await text('/' + FILE);
  check('replace one chosen occurrence', r.data.replaced === 1 && (served.body.match(/marker-A/g) || []).length === 1 && (served.body.match(/marker-B/g) || []).length === 1);
  r = await call('POST', '/api/super/code/replace', { token: SUPER, body: { file: FILE, find: 'marker-A', replaceWith: 'marker-C' } });
  served = await text('/' + FILE);
  check('a unique snippet is replaced without further choices', r.data.replaced === 1 && served.body.includes('marker-C') && !served.body.includes('marker-A'));
  r = await call('POST', '/api/super/code/replace', { token: SUPER, body: { file: FILE, find: 'marker-', replaceWith: '', replaceAll: true } });
  served = await text('/' + FILE);
  check('replace all', r.data.replaced === 2 && !served.body.includes('marker-'));
  r = await call('POST', '/api/super/code/replace', { token: SUPER, body: { file: FILE, find: '// B', replaceWith: 'function (' } });
  check('a replacement that would break the file is refused and not saved', r.status === 400 && /break the file/.test(r.data.error), r);
  served = await text('/' + FILE);
  check('...users still get the working file', served.status === 200 && served.body === original + '\n// C\n// B\n');
  r = await call('POST', '/api/super/code/replace', { token: SUPER, body: { file: FILE, find: 'not-in-file-xyz', replaceWith: 'x' } });
  check('replace of text that is not there -> 404', r.status === 404);

  r = await call('GET', '/api/super/code/features?file=app.js', { token: SUPER });
  const withScreen = r.data.features.filter((f) => f.screen);
  check('feature index lists screens and their search strings', r.data.features.length > 20 && withScreen.length > 10 && r.data.features.every((f) => f.search.startsWith('function render')), r.data.features.length);
  r = await call('POST', '/api/super/code/search', { token: SUPER, body: { file: 'app.js', query: r.data.features[0].search } });
  check('a feature\'s search string finds its code', r.data.totalMatches === 1);

  r = await call('GET', '/api/super/code/backups?path=' + FILE, { token: SUPER });
  check('every save kept a backup, including the original', r.data.backups.length >= 4 && r.data.backups.some((b) => b.note === 'Original (as deployed)'), r.data.backups.map((b) => b.note));
  const originalBackup = r.data.backups.find((b) => b.note === 'Original (as deployed)');
  r = await call('POST', '/api/super/code/restore', { token: SUPER, body: { backupId: originalBackup.id } });
  served = await text('/' + FILE);
  check('undo: restoring the original backup', r.status === 200 && served.body === original);
  r = await call('POST', '/api/super/code/restore', { token: SUPER, body: { backupId: 'nope' } });
  check('unknown backup -> 404', r.status === 404);
  await call('POST', '/api/super/code/save', { token: SUPER, body: { path: FILE, content: edited } });
  r = await call('POST', '/api/super/code/revert', { token: SUPER, body: { path: FILE } });
  served = await text('/' + FILE);
  check('restore original removes every edit', r.status === 200 && served.body === original);
  r = await call('GET', '/api/super/audit-logs', { token: SUPER });
  const acts = r.data.logs.map((l) => l.action);
  check('every step was audited', ['SITE_FILE_SAVED', 'SITE_FILE_REPLACED', 'SITE_FILE_RESTORED', 'SITE_FILE_REVERTED', 'ACCESS_CODE_REGENERATED'].every((a) => acts.includes(a)), acts.slice(0, 14));
  r = await call('POST', '/api/super/code/save', { token: lecToken, body: { path: FILE, content: 'x' } });
  check('only the owner can save', r.status === 403);

  await prisma.siteFileVersion.deleteMany({ where: { path: FILE } });
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('TEST CRASHED', e); await prisma.$disconnect(); process.exit(2); });
