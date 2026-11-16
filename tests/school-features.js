// School app features: Add student + matric numbers, access codes (backend list == dashboards == login), fee details per student,
// My Publications, the read-only e-Library, meetings (host-only grid), transcript & credential documents, and notifications.
//
//   DATABASE_URL=... JWT_SECRET=... SEED_SUPER_ADMIN_EMAIL=... SEED_SUPER_ADMIN_PASSWORD=... PORT=4177 node src/server.js
//   SUPER_EMAIL=... SUPER_PASSWORD=... BASE=http://localhost:4177 [SOCKET_CLIENT=path/to/socket.io-client] node tests/school-features.js
const BASE = process.env.BASE || 'http://localhost:4177';
const RUN = Date.now();
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ''); }
}
async function call(method, path, { token, body, form, raw } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: Object.assign(form ? {} : { 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: form || (body ? JSON.stringify(body) : undefined),
  });
  if (raw) return res;
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

// a tiny but valid 3-page PDF (so the reader has pages to turn)
function makePdf(pages = 3) {
  const objs = [];
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push('<< /Type /Pages /Kids [' + Array.from({ length: pages }, (_, i) => (4 + i * 2) + ' 0 R').join(' ') + '] /Count ' + pages + ' >>');
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (let i = 0; i < pages; i++) {
    const stream = `BT /F1 36 Tf 60 400 Td (Page ${i + 1} of ${pages}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 600] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  let out = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const PDF = makePdf(3);
const fileForm = (fields, name = 'book.pdf', type = 'application/pdf', buf = PDF) => {
  const f = new FormData();
  Object.entries(fields).forEach(([k, v]) => { if (v != null) f.append(k, v); });
  f.append('file', new Blob([buf], { type }), name);
  return f;
};
const fieldsForm = (fields) => { const f = new FormData(); Object.entries(fields).forEach(([k, v]) => { if (v != null) f.append(k, v); }); return f; };

(async () => {
  let r = await call('POST', '/api/super/login', { body: { email: process.env.SUPER_EMAIL, password: process.env.SUPER_PASSWORD } });
  const SUPER = r.data.token;
  if (!SUPER) throw new Error('super login failed');

  const mkSchool = async (name) => {
    const s = await call('POST', '/api/super/schools', { token: SUPER, body: { name, state: 'Kano' } });
    const a = await call('POST', '/api/auth/school-login', { body: { schoolName: name, joinCode: s.data.joinCode } });
    return { id: s.data.school.id, name, joinCode: s.data.joinCode, admin: a.data.token, adminUser: a.data.user };
  };
  const A = await mkSchool('Okafor Memorial College');
  const B = await mkSchool('Bello Polytechnic');
  const admin = (A_) => (method, path, opts = {}) => call(method, '/api' + path, { token: A_.admin, ...opts });
  const aa = admin(A), bb = admin(B);

  const csc = (await aa('POST', '/admin/departments', { body: { name: 'Computer Science', code: 'CSC' } })).data.department;
  const mth = (await aa('POST', '/admin/departments', { body: { name: 'Mathematics', code: 'MTH' } })).data.department;
  const bcsc = (await bb('POST', '/admin/departments', { body: { name: 'Computer Science', code: 'CSC' } })).data.department;
  const c101 = (await aa('POST', '/admin/courses', { body: { departmentId: csc.id, code: 'CSC101', title: 'Intro to Computing' } })).data.course;
  const lec = (await aa('POST', '/admin/lecturers', { body: { fullName: 'Dr Lecturer ' + RUN, departmentId: csc.id, staffId: 'STF/9', courseIds: [c101.id] } })).data;
  const staff = (await aa('POST', '/admin/non-academic-staff', { body: { fullName: 'Staff Member ' + RUN, position: 'Librarian' } })).data;
  const admin2 = (await aa('POST', '/admin/admins', { body: { fullName: 'Second Admin ' + RUN } })).data;
  const login = (school, name, code) => call('POST', '/api/auth/login-with-code', { body: { fullName: name, schoolName: school.name, accessCode: code } });
  const lecToken = (await login(A, 'Dr Lecturer ' + RUN, lec.accessCode)).data.token;

  // ============================================================ 1 + 2: Add student, matric numbers
  console.log('== 1+2. the school admin adds a student; matric numbers are made by the system ==');
  const yr = new Date().getFullYear();
  const s1 = await aa('POST', '/admin/students', { body: { fullName: 'Ada Admin ' + RUN, departmentId: csc.id, yearOfStudy: 1, phone: '08030000001', email: `ada${RUN}@example.com`, programmeYears: 4, courseIds: [c101.id] } });
  check('admin can add a student (201)', s1.status === 201, s1.data);
  const m1 = s1.data.user && s1.data.user.matricNumber;
  check('matric made when none typed: SCHOOLCODE/YEAR/DEPT/NNN', /^OMC\/\d{4}\/CSC\/\d{3}$/.test(m1) && m1.includes('/' + yr + '/'), m1);
  check('first number in the department is 001', /\/001$/.test(m1), m1);
  const s2 = await aa('POST', '/admin/students', { body: { fullName: 'Bola Admin ' + RUN, departmentId: csc.id, yearOfStudy: 2 } });
  check('second student gets the next number (002)', /\/CSC\/002$/.test(s2.data.user.matricNumber), s2.data.user && s2.data.user.matricNumber);
  const s3 = await aa('POST', '/admin/students', { body: { fullName: 'Chidi Admin ' + RUN, departmentId: csc.id, yearOfStudy: 1, yearOfAdmission: 2024 } });
  check('year admitted drives the year in the number and restarts the serial', /^OMC\/2024\/CSC\/001$/.test(s3.data.user.matricNumber), s3.data.user && s3.data.user.matricNumber);
  const s4 = await aa('POST', '/admin/students', { body: { fullName: 'Dayo Admin ' + RUN, departmentId: mth.id, yearOfStudy: 1 } });
  check('another department counts on its own (MTH 001)', new RegExp('^OMC/' + yr + '/MTH/001$').test(s4.data.user.matricNumber), s4.data.user && s4.data.user.matricNumber);
  const s5 = await aa('POST', '/admin/students', { body: { fullName: 'Efe Typed ' + RUN, departmentId: csc.id, yearOfStudy: 1, matricNumber: 'TYPED/2026/001' } });
  check('a matric number typed in is kept as typed', s5.data.user && s5.data.user.matricNumber === 'TYPED/2026/001', s5.data);
  const dup = await aa('POST', '/admin/students', { body: { fullName: 'Dup ' + RUN, departmentId: csc.id, yearOfStudy: 1, matricNumber: 'typed/2026/001' } });
  check('a duplicate matric number is refused', dup.status === 409, dup.data);
  const noDept = await aa('POST', '/admin/students', { body: { fullName: 'No Dept ' + RUN, yearOfStudy: 1 } });
  check('a department is required', noDept.status === 400, noDept.data);
  const lectAdds = await call('POST', '/api/lect/students', { token: lecToken, body: { fullName: 'Lect Added ' + RUN, yearOfStudy: 1, courseIds: [c101.id] } });
  check('a lecturer adding a student without a matric gets a generated one too', lectAdds.status === 201 && /^OMC\/\d{4}\/CSC\/\d{3}$/.test(lectAdds.data.user.matricNumber), lectAdds.data);
  const all = (await aa('GET', '/admin/students')).data.students;
  const cscNow = all.filter((s) => s.matricNumber && s.matricNumber.startsWith(`OMC/${yr}/CSC/`)).map((s) => s.matricNumber);
  check('no two students share a number', new Set(all.map((s) => String(s.matricNumber).toLowerCase())).size === all.length);
  check('serials for the department and year run 001, 002, 003 with no gaps', cscNow.sort().join() === [`OMC/${yr}/CSC/001`, `OMC/${yr}/CSC/002`, `OMC/${yr}/CSC/003`].join(), cscNow);
  const bs = await bb('POST', '/admin/students', { body: { fullName: 'Bello Student ' + RUN, departmentId: bcsc.id, yearOfStudy: 1 } });
  check('another school numbers on its own (BP/…/CSC/001)', /^BP\/\d{4}\/CSC\/001$/.test(bs.data.user.matricNumber), bs.data.user && bs.data.user.matricNumber);

  // the same details and functionality as a student a lecturer added
  const dirAdmin = (await aa('GET', '/admin/students/' + s1.data.user.id)).data.student;
  const dirLect = (await aa('GET', '/admin/students/' + lectAdds.data.user.id)).data.student;
  check('admin-added student shows in the directory list', all.some((s) => s.id === s1.data.user.id && s.department && s.department.name === 'Computer Science'));
  check('directory record has exactly the same fields as a lecturer-added student', Object.keys(dirAdmin).sort().join() === Object.keys(dirLect).sort().join());
  check('details kept: level, phone, email, programme length, courses', dirAdmin.yearOfStudy === 1 && dirAdmin.phone === '08030000001' && dirAdmin.email === `ada${RUN}@example.com` && dirAdmin.programmeYears === 4 && dirAdmin.courses.length === 1, dirAdmin);
  const edit = await aa('PATCH', '/admin/students/' + s1.data.user.id, { body: { cgpa: '4.1', classPosition: 'Course Rep' } });
  check('the admin can edit it like any other student', edit.status === 200 && edit.data.user.cgpa === 4.1, edit.data);
  const adm = (await aa('GET', '/admin/admission/students')).data.students;
  check('the Admission screen lists the new student with the matric number', adm.some((s) => s.id === s1.data.user.id && s.matricNumber === m1));
  const sLogin = await login(A, 'Ada Admin ' + RUN, s1.data.accessCode);
  check('the student signs in with name, school and access code', sLogin.status === 200 && sLogin.data.user.matricNumber === m1, sLogin.data);
  const stuToken = sLogin.data.token;
  const rec = await call('GET', '/api/students/me/academic-record', { token: stuToken });
  check('the matric number is on the student\'s own record', rec.data.matricNumber === m1);

  // an independent lecturer and an independent learner still work
  const il = await call('POST', '/api/auth/register-lecturer', { body: { fullName: 'Indie Lect ' + RUN, email: `il${RUN}@example.com`, password: 'secret12', className: 'Indie Maths Class ' + RUN.toString(36) } });
  check('independent lecturer can register', il.status === 200 && il.data.lecturer, il.data);
  const ilTok = il.data.token;
  const ilStu = await call('POST', '/api/lect/students', { token: ilTok, body: { fullName: 'Indie Student ' + RUN, courseOfStudy: 'Maths', yearOfStudy: 1 } });
  check('independent lecturer adds a student; a matric number is generated', ilStu.status === 201 && /^[A-Z0-9]+\/\d{4}\/GEN\/001$/.test(ilStu.data.user.matricNumber), ilStu.data);
  const ilLogin = await call('POST', '/api/auth/login-lecturer-student', { body: { fullName: 'Indie Student ' + RUN, accessCode: ilStu.data.accessCode } });
  check('that student signs in from the student app', ilLogin.status === 200 && ilLogin.data.user.fromLecturer, ilLogin.data);
  const learner = await call('POST', '/api/auth/register-individual', { body: { confirmAdult: true, fullName: 'Solo ' + RUN, email: `solo${RUN}@example.com`, password: 'secret12', institutionType: 'MONOTECHNIC', attendedSchoolName: 'Yaba Mono', courseOfStudy: 'Lab Tech', yearOfStudy: 1 } });
  check('independent learner can still register', learner.status === 200 && learner.data.token, learner.data);

  // ============================================================ 3: access codes
  console.log('== 3. access codes: backend list == dashboards == login, for every role ==');
  const people = [
    { role: 'STUDENT', name: 'Ada Admin ' + RUN, id: s1.data.user.id, code: s1.data.accessCode, detail: async () => (await aa('GET', '/admin/students/' + s1.data.user.id)).data.student.accessCode, own: async (t) => (await call('GET', '/api/auth/me', { token: t })).data.user.accessCode, rec: async (t) => (await call('GET', '/api/students/me/academic-record', { token: t })).data.accessCode },
    { role: 'LECTURER', name: 'Dr Lecturer ' + RUN, id: lec.user.id, code: lec.accessCode, detail: async () => (await aa('GET', '/admin/lecturers/' + lec.user.id)).data.lecturer.accessCode, own: async (t) => (await call('GET', '/api/auth/me', { token: t })).data.user.accessCode },
    { role: 'STAFF', name: 'Staff Member ' + RUN, id: staff.user.id, code: staff.accessCode, detail: async () => (await aa('GET', '/admin/non-academic-staff/' + staff.user.id)).data.staff.accessCode, own: async (t) => (await call('GET', '/api/auth/me', { token: t })).data.user.accessCode },
    { role: 'ADMIN', name: 'Second Admin ' + RUN, id: admin2.user.id, code: admin2.accessCode, detail: async () => ((await aa('GET', '/admin/admins')).data.admins.find((a) => a.id === admin2.user.id) || {}).accessCode, own: async (t) => (await call('GET', '/api/auth/me', { token: t })).data.user.accessCode },
  ];
  const superCode = async (p) => ((await call('GET', `/api/super/codes/users?schoolId=${A.id}&search=${encodeURIComponent(p.name)}`, { token: SUPER })).data.users || []).find((u) => u.id === p.id);
  for (const p of people) {
    const sess = await login(A, p.name, p.code);
    const row = await superCode(p);
    const seen = { backendList: row && row.accessCode, adminDirectory: await p.detail(), ownDashboard: await p.own(sess.data.token), created: p.code };
    if (p.rec) seen.ownRecord = await p.rec(sess.data.token);
    check(`${p.role}: backend list == school admin directory == own dashboard == the code that signs in`, sess.status === 200 && Object.values(seen).every((v) => v === p.code), seen);
    // the backend re-issues the code
    const regen = await call('POST', `/api/super/codes/users/${p.id}/regenerate`, { token: SUPER });
    const fresh = regen.data.accessCode;
    check(`${p.role}: regenerated code is new`, fresh && fresh !== p.code);
    const oldLogin = await login(A, p.name, p.code);
    const newLogin = await login(A, p.name, fresh);
    const after = { backendList: (await superCode(p)).accessCode, adminDirectory: await p.detail(), ownDashboard: await p.own(newLogin.data.token), regen: fresh };
    check(`${p.role}: after regenerating, every place shows the new code, the old one stops and the new one signs in`, oldLogin.status === 401 && newLogin.status === 200 && Object.values(after).every((v) => v === fresh), { after, old: oldLogin.status, nw: newLogin.status });
    p.code = fresh;
  }
  // the lecturer sees the same code for their student
  const lecView = await call('GET', '/api/lect/students/' + s1.data.user.id, { token: lecToken });
  const stuNow = people[0];
  check('the lecturer\'s view of the student shows the same stored code', lecView.data.accessCode === stuNow.code, lecView.data.accessCode);
  // school join code
  const sup = (await call('GET', '/api/super/schools/' + A.id, { token: SUPER })).data.school;
  const adm1 = (await aa('GET', '/admin/school')).data.school;
  const adminMe = (await call('GET', '/api/auth/me', { token: A.admin })).data.school;
  check('school join code: backend == school admin dashboard == /me', sup.joinCode === A.joinCode && adm1.joinCode === A.joinCode && adminMe.joinCode === A.joinCode, [sup.joinCode, adm1.joinCode, adminMe.joinCode]);
  const rj = await call('POST', `/api/super/schools/${A.id}/regenerate-join-code`, { token: SUPER });
  const oldJ = await call('POST', '/api/auth/school-login', { body: { schoolName: A.name, joinCode: A.joinCode } });
  const newJ = await call('POST', '/api/auth/school-login', { body: { schoolName: A.name, joinCode: rj.data.joinCode } });
  const adm2 = (await call('GET', '/api/admin/school', { token: newJ.data.token })).data.school;
  check('school join code after regenerating: old stops, new signs in, dashboard shows the new one', oldJ.status === 401 && newJ.status === 200 && adm2.joinCode === rj.data.joinCode);
  A.admin = newJ.data.token;

  // ============================================================ 4: fee details per student
  console.log('== 4. fees: click a student, see what they paid for and what is owing ==');
  const fa = (m, p, o = {}) => call(m, '/api/fees' + p, { token: A.admin, ...o });
  await fa('PUT', '/admin/bank', { body: { bankName: 'Test Bank', accountName: 'Okafor Memorial', accountNumber: '0123456789' } });
  const tuition = (await fa('POST', '/admin/fees', { body: { category: 'TUITION', amountNaira: 100000, levels: [1], session: '2026/2027' } })).data.fee;
  const lib = (await fa('POST', '/admin/fees', { body: { category: 'LIBRARY', amountNaira: 5000, levels: [1] } })).data.fee;
  const pay1 = await call('POST', '/api/fees/pay', { token: stuToken, body: { method: 'BANK_TRANSFER', reference: 'REF-ONE', depositorName: 'Ada Parent', items: [{ feeId: tuition.id, amountKobo: 4000000 }] } });
  check('student reports a part payment for tuition', pay1.status === 201, pay1.data);
  const pend = await fa('GET', '/admin/payments?status=PENDING');
  const notifAdmin = (await call('GET', '/api/notifications', { token: A.admin })).data.notifications;
  check('the school admin is notified of the payment to confirm, landing on Fee Payment', notifAdmin.some((n) => /Fee payment to confirm/.test(n.title) && n.link === 'admin-fees'), notifAdmin.map((n) => [n.title, n.link]));
  const conf = await fa('POST', `/admin/payments/${pay1.data.payment.id}/confirm`, { body: {} });
  const pay2 = await call('POST', '/api/fees/pay', { token: stuToken, body: { method: 'BANK_TRANSFER', reference: 'REF-TWO', items: [{ feeId: lib.id, amountKobo: 500000 }] } });
  const detail = (await fa('GET', '/admin/students/' + s1.data.user.id)).data;
  check('student details are there (name, matric, department, level)', detail.student.name === 'Ada Admin ' + RUN && detail.student.matricNumber === m1 && detail.student.department === 'Computer Science' && detail.student.level === '100L', detail.student);
  check('billed / paid / awaiting / still-to-pay totals are right', detail.totals.dueKobo === 10500000 && detail.totals.paidKobo === 4000000 && detail.totals.pendingKobo === 500000 && detail.totals.balanceKobo === 6500000, detail.totals);
  const t1 = detail.fees.find((f) => f.id === tuition.id), l1 = detail.fees.find((f) => f.id === lib.id);
  check('each fee line says what it is for, amount, paid and still owing', t1.title && t1.amountKobo === 10000000 && t1.paidKobo === 4000000 && t1.balanceKobo === 6000000 && t1.status === 'PARTIAL' && l1.status === 'PENDING', [t1, l1]);
  const p1 = detail.payments.find((p) => p.reference === 'REF-ONE'), p2 = detail.payments.find((p) => p.reference === 'REF-TWO');
  check('each payment shows what for, amount, method, reference, status and receipt', p1.status === 'CONFIRMED' && p1.receiptNo && p1.method === 'BANK_TRANSFER' && p1.items[0].title === tuition.title && p1.amountKobo === 4000000 && p2.status === 'PENDING', [p1, p2]);
  const list = (await fa('GET', '/admin/students')).data.students;
  check('the fee list marks the student part-paid', list.find((s) => s.id === s1.data.user.id).status === 'PARTIAL');
  const stuN = (await call('GET', '/api/notifications', { token: stuToken })).data.notifications;
  check('the student is told the payment is confirmed, landing on School Fees', stuN.some((n) => /Fee payment confirmed/.test(n.title) && n.link === 'fees'), stuN.map((n) => [n.title, n.link]));

  // ============================================================ 5: My Publications
  console.log('== 5. My Publications ==');
  const pub = await call('POST', '/api/staff/publications', { token: lecToken, form: fileForm({ kind: 'JOURNAL', title: 'On Compilers', outlet: 'Journal of Computing', year: String(yr), url: 'https://example.com/paper', description: 'A short paper.' }, 'paper.pdf') });
  check('a lecturer adds a journal with a link AND a file', pub.status === 200 && pub.data.record.kind === 'JOURNAL' && pub.data.record.url && pub.data.record.fileUrl && pub.data.record.canLibrary, pub.data);
  const linkOnly = await call('POST', '/api/staff/publications', { token: lecToken, form: fieldsForm({ kind: 'BOOK', title: 'A Book', outlet: 'Pub House', year: String(yr), url: 'https://example.com/b' }) });
  check('a link alone is fine', linkOnly.status === 200 && !linkOnly.data.record.fileUrl, linkOnly.data);
  const fileOnly = await call('POST', '/api/staff/publications', { token: lecToken, form: fileForm({ kind: 'CPD', title: 'Pedagogy workshop', outlet: 'NUC', year: String(yr) }, 'cert.pdf') });
  check('a file alone is fine (CPD)', fileOnly.status === 200 && fileOnly.data.record.kind === 'CPD', fileOnly.data);
  const neither = await call('POST', '/api/staff/publications', { token: lecToken, form: fieldsForm({ kind: 'CONFERENCE', title: 'Nothing', outlet: 'X', year: String(yr) }) });
  check('neither a link nor a file is refused', neither.status === 400, neither.data);
  const notPdf = await call('POST', '/api/staff/publications', { token: lecToken, form: fileForm({ kind: 'OTHER', title: 'Exe', outlet: 'X', year: String(yr) }, 'x.exe', 'application/x-msdownload', Buffer.from('MZ')) });
  check('a program file is refused', notPdf.status === 400, notPdf.data);
  const edited = await call('PUT', '/api/staff/publications/' + linkOnly.data.record.id, { token: lecToken, form: fieldsForm({ title: 'A Better Book', year: String(yr) }) });
  check('edit works', edited.status === 200 && edited.data.record.title === 'A Better Book', edited.data);
  const mine = (await call('GET', '/api/staff/publications/me', { token: lecToken })).data.records;
  check('the list shows all of them (view)', mine.length === 3, mine.length);
  const toLib = await call('POST', `/api/staff/publications/${pub.data.record.id}/library`, { token: lecToken });
  check('a PDF can be put in the e-Library from My Publications', toLib.status === 200 && toLib.data.record.inLibrary, toLib.data);
  const linkLib = await call('POST', `/api/staff/publications/${linkOnly.data.record.id}/library`, { token: lecToken });
  check('a link alone cannot go in the e-Library', linkLib.status === 400, linkLib.data);
  const libAsStudent = (await call('GET', '/api/library', { token: stuToken })).data.items;
  check('students see it in the e-Library', libAsStudent.some((i) => i.title === 'On Compilers'), libAsStudent.map((i) => i.title));
  const rm = await call('DELETE', '/api/staff/publications/' + fileOnly.data.record.id, { token: lecToken });
  check('remove works', rm.status === 200);
  const other = await call('DELETE', '/api/staff/publications/' + pub.data.record.id, { token: stuToken });
  check('a student cannot remove a lecturer\'s publication', other.status === 403 || other.status === 404);

  // ============================================================ 6: e-Library, read only
  console.log('== 6. e-Library: add books, read page by page, no download ==');
  const bookA = await call('POST', '/api/library', { token: A.admin, form: fileForm({ title: 'Admin Textbook', author: 'The Registry', type: 'Textbook' }) });
  check('the school admin adds a book', bookA.status === 200, bookA.data);
  const bookL = await call('POST', '/api/library', { token: lecToken, form: fileForm({ title: 'Lecturer Handout', author: 'Dr Lecturer', type: 'Handout', courseId: c101.id }) });
  check('a lecturer adds a book', bookL.status === 200, bookL.data);
  const bookI = await call('POST', '/api/library', { token: ilTok, form: fileForm({ title: 'Indie Notes', author: 'Indie Lect', type: 'Notes' }) });
  check('an independent lecturer adds a book', bookI.status === 200, bookI.data);
  const stuAdd = await call('POST', '/api/library', { token: stuToken, form: fileForm({ title: 'Sneaky', author: 'me' }) });
  check('a student cannot add a book', stuAdd.status === 403, stuAdd.status);
  const txt = await call('POST', '/api/library', { token: lecToken, form: fileForm({ title: 'Doc', author: 'me' }, 'a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', Buffer.from('PK')) });
  check('only PDF or photo books are accepted (so they can be read page by page)', txt.status === 400, txt.data);
  const seen = await call('GET', '/api/library', { token: stuToken, raw: true });
  const seenText = await seen.text();
  check('the list handed to a student has no file address at all', !/\/uploads\/|fileUrl|cloudinary/i.test(seenText), seenText.slice(0, 200));
  const seenAdmin = await (await call('GET', '/api/library', { token: A.admin, raw: true })).text();
  const seenLec = await (await call('GET', '/api/library', { token: lecToken, raw: true })).text();
  check('nor to the lecturer who added it or the school admin', !/\/uploads\/|fileUrl/i.test(seenAdmin + seenLec));
  const items = JSON.parse(seenText).items;
  const book = items.find((i) => i.title === 'Admin Textbook');
  check('the list says it is a PDF and whether the reader may remove it', book.fileExt === 'pdf' && book.mine === false);
  const read = await call('GET', `/api/library/${book.id}/read`, { token: stuToken, raw: true });
  const bytes = Buffer.from(await read.arrayBuffer());
  check('a student reads the book through the authenticated endpoint (inline PDF, not cached, not sniffed)', read.status === 200 && read.headers.get('content-type') === 'application/pdf' && read.headers.get('content-disposition') === 'inline' && /no-store/.test(read.headers.get('cache-control')) && read.headers.get('x-content-type-options') === 'nosniff' && bytes.slice(0, 4).toString() === '%PDF', [read.status, read.headers.get('content-disposition')]);
  const anon = await call('GET', `/api/library/${book.id}/read`, { raw: true });
  check('nobody signed out can read it', anon.status === 401, anon.status);
  const bStu = (await login(B, 'Bello Student ' + RUN, bs.data.accessCode)).data.token;
  const cross = await call('GET', `/api/library/${book.id}/read`, { token: bStu, raw: true });
  check('another school\'s student cannot read it', cross.status === 404, cross.status);
  const learnerTok = learner.data.token;
  const cross2 = await call('GET', `/api/library/${book.id}/read`, { token: learnerTok, raw: true });
  check('an independent learner cannot read a school\'s book', cross2.status === 404, cross2.status);
  const ilStuTok = ilLogin.data.token;
  const indieBook = (await call('GET', '/api/library', { token: ilStuTok })).data.items.find((i) => i.title === 'Indie Notes');
  const indieRead = indieBook ? await call('GET', `/api/library/${indieBook.id}/read`, { token: ilStuTok, raw: true }) : { status: 0 };
  check('the independent lecturer\'s students can read the independent lecturer\'s book', !!indieBook && indieRead.status === 200, indieRead.status);
  const del = await call('DELETE', '/api/library/' + book.id, { token: stuToken });
  check('a student cannot delete a book', del.status === 403);
  const delOwn = await call('DELETE', '/api/library/' + bookL.data.item.id, { token: lecToken });
  check('the lecturer can remove their own book', delOwn.status === 200);
  const delAdmin = await call('DELETE', '/api/library/' + bookI.data.item.id, { token: A.admin });
  check('but not another school\'s book (404/403)', delAdmin.status === 403);
  const lib2 = (await call('GET', '/api/library', { token: lecToken })).data.items;
  check('the admin can remove a lecturer\'s book in their school', (await call('DELETE', '/api/library/' + lib2.find((i) => i.title === 'On Compilers').id, { token: A.admin })).status === 200);
  const pubAfter = (await call('GET', '/api/staff/publications/me', { token: lecToken })).data.records.find((p) => p.title === 'On Compilers');
  check('and the publication goes back to being just a publication', pubAfter && !pubAfter.inLibrary);

  // ============================================================ 7: meetings
  console.log('== 7. meetings: only the host sees the others ==');
  let io = null;
  try { io = require(process.env.SOCKET_CLIENT || 'socket.io-client').io; } catch { /* the test needs socket.io-client */ }
  if (!io) console.log('  SKIP no socket.io-client (set SOCKET_CLIENT)');
  else {
    const start = await aa('POST', '/meetings/start', { body: { title: 'Staff meeting', audience: 'STAFF', video: true } });
    check('the admin starts a meeting; staff are invited', start.status === 200 && start.data.meeting.invited >= 2, start.data);
    const mid = start.data.meeting.id;
    const staffTok = (await login(A, 'Staff Member ' + RUN, people[2].code)).data.token;
    const lec2Tok = (await login(A, 'Dr Lecturer ' + RUN, people[1].code)).data.token;
    const sock = (tok) => new Promise((res) => { const s = io(BASE + '/meeting', { auth: { token: tok }, transports: ['websocket'] }); s.on('connect', () => res(s)); });
    const [host, p1, p2] = await Promise.all([sock(A.admin), sock(staffTok), sock(lec2Tok)]);
    const log = { host: [], p1: [], p2: [] };
    [['host', host], ['p1', p1], ['p2', p2]].forEach(([k, s]) => { ['meeting:participant-joined', 'meeting:signal', 'meeting:hosting', 'meeting:joined'].forEach((ev) => s.on(ev, (d) => log[k].push([ev, d]))); });
    host.emit('meeting:enter', { meetingId: mid });
    await new Promise((r2) => setTimeout(r2, 300));
    p1.emit('meeting:enter', { meetingId: mid });
    await new Promise((r2) => setTimeout(r2, 300));
    p2.emit('meeting:enter', { meetingId: mid });
    await new Promise((r2) => setTimeout(r2, 500));
    const joinedAtHost = log.host.filter((e) => e[0] === 'meeting:participant-joined').map((e) => e[1].name);
    check('the host is told about every participant (so the host can show them in a grid)', joinedAtHost.length === 2, joinedAtHost);
    check('a participant is never told about another participant', !log.p1.some((e) => e[0] === 'meeting:participant-joined') && !log.p2.some((e) => e[0] === 'meeting:participant-joined'), log.p1.map((e) => e[0]));
    p1.emit('meeting:signal', { to: p2.id, data: { candidate: 'x' } });
    await new Promise((r2) => setTimeout(r2, 300));
    check('a participant cannot send media signals to another participant', !log.p2.some((e) => e[0] === 'meeting:signal'), log.p2.map((e) => e[0]));
    host.emit('meeting:signal', { to: p1.id, data: { candidate: 'h' } });
    p1.emit('meeting:signal', { to: host.id, data: { candidate: 'p' } });
    await new Promise((r2) => setTimeout(r2, 300));
    check('the host and each participant still reach each other', log.p1.some((e) => e[0] === 'meeting:signal') && log.host.some((e) => e[0] === 'meeting:signal'));
    await aa('POST', `/meetings/${mid}/end`);
    [host, p1, p2].forEach((s) => s.close());
  }

  // ============================================================ 8: transcript and other credentials
  console.log('== 8. transcript & credentials: request, admin uploads, student downloads ==');
  const adminNotifs = async () => (await call('GET', '/api/notifications', { token: A.admin })).data.notifications;
  const stuNotifs = async () => (await call('GET', '/api/notifications', { token: stuToken })).data.notifications;
  const rq = await call('POST', '/api/students/me/transcript-request', { token: stuToken, body: { kind: 'CERTIFICATE', note: 'For a job' } });
  check('a student requests a certificate', rq.status === 200 && rq.data.request.kind === 'CERTIFICATE' && rq.data.request.status === 'PENDING', rq.data);
  const noTitle = await call('POST', '/api/students/me/transcript-request', { token: stuToken, body: { kind: 'OTHER' } });
  check('"Other" must be named', noTitle.status === 400);
  const rqLetter = await call('POST', '/api/students/me/transcript-request', { token: stuToken, body: { kind: 'OTHER', title: 'Letter of recommendation' } });
  const rqTx = await call('POST', '/api/students/me/transcript-request', { token: stuToken, body: { kind: 'TRANSCRIPT' } });
  const pendingList = (await aa('GET', '/admin/transcript-requests')).data;
  check('the admin sees every request with who asked and what for', pendingList.requests.length === 3 && pendingList.requests.some((x) => x.label === 'Letter of recommendation' && x.student.fullName === 'Ada Admin ' + RUN), pendingList.requests.map((x) => x.label));
  check('the admin was notified, landing on Student Requests', (await adminNotifs()).some((n) => /Certificate requested/.test(n.title) && n.link === 'admin-student-requests'));
  const noFile = await call('POST', `/api/admin/transcript-requests/${rq.data.request.id}/issue`, { token: A.admin, form: fieldsForm({ note: 'x' }) });
  check('a certificate cannot be issued without the document', noFile.status === 400, noFile.data);
  const issued = await call('POST', `/api/admin/transcript-requests/${rq.data.request.id}/issue`, { token: A.admin, form: fileForm({ note: 'Collect the original too' }, 'certificate.pdf') });
  check('the admin issues it with the uploaded file', issued.status === 200 && issued.data.request.status === 'ISSUED' && issued.data.request.fileUrl, issued.data);
  const mineReq = (await call('GET', '/api/students/me/transcript-requests', { token: stuToken })).data.requests;
  const certReq = mineReq.find((x) => x.kind === 'CERTIFICATE');
  check('the student finds it on their page with the file and the admin\'s word', certReq.status === 'ISSUED' && certReq.fileUrl && certReq.adminNote === 'Collect the original too', certReq);
  const dl = await fetch(BASE + certReq.fileUrl);
  const dlBytes = Buffer.from(await dl.arrayBuffer());
  check('and downloads the real file', dl.status === 200 && dlBytes.slice(0, 4).toString() === '%PDF');
  check('the student was notified, landing on Transcript & Credentials', (await stuNotifs()).some((n) => /Certificate issued/.test(n.title) && n.link === 'transcript-hub'), (await stuNotifs()).map((n) => [n.title, n.link]));
  const noReason = await call('POST', `/api/admin/transcript-requests/${rqLetter.data.request.id}/decline`, { token: A.admin, body: {} });
  check('declining needs a reason', noReason.status === 400);
  const declined = await call('POST', `/api/admin/transcript-requests/${rqLetter.data.request.id}/decline`, { token: A.admin, body: { reason: 'Please see the registry in person.' } });
  check('declined with a reason; the student is told', declined.status === 200 && (await stuNotifs()).some((n) => /not granted/.test(n.title) && n.link === 'transcript-hub'), declined.data);
  const sysTx = await call('POST', `/api/admin/transcript-requests/${rqTx.data.request.id}/issue`, { token: A.admin, form: fieldsForm({}) });
  check('a transcript can be issued without a file (the system-made one)', sysTx.status === 200 && sysTx.data.request.status === 'ISSUED', sysTx.data);
  const tx = await call('GET', '/api/students/me/transcript', { token: stuToken });
  check('and then the student opens the system transcript', tx.status === 200 && Array.isArray(tx.data.results), tx.data);
  const twice = await call('POST', `/api/admin/transcript-requests/${rq.data.request.id}/issue`, { token: A.admin, form: fileForm({}, 'again.pdf') });
  check('a request already dealt with cannot be issued twice', twice.status === 409);
  const otherAdmin = await call('POST', `/api/admin/transcript-requests/${rqTx.data.request.id}/decline`, { token: B.admin, body: { reason: 'x' } });
  check('another school\'s admin cannot touch the request', otherAdmin.status === 404 || otherAdmin.status === 409);
  const cred = await call('POST', '/api/admin/credentials', { token: A.admin, form: fileForm({ studentId: s1.data.user.id, title: 'Statement of Result 2026' }, 'statement.pdf') });
  check('the admin issues a credential straight to a student with a file', cred.status === 200 && cred.data.credential.fileUrl && cred.data.credential.verifyCode, cred.data);
  const creds = (await call('GET', '/api/students/me/credentials', { token: stuToken })).data.credentials;
  check('it reaches the student with the file', creds.some((c) => c.title === 'Statement of Result 2026' && c.fileUrl));
  check('the student was notified, landing on Transcript & Credentials', (await stuNotifs()).some((n) => /credential was issued/i.test(n.title) && n.link === 'transcript-hub'));
  const verify = await call('GET', '/api/verify/' + cred.data.credential.verifyCode);
  check('the public verification link still works', verify.data.valid === true && verify.data.title === 'Statement of Result 2026', verify.data);
  const credPlain = await call('POST', '/api/admin/credentials', { token: A.admin, body: { studentId: s1.data.user.id, title: 'No file' } });
  check('a credential without a file still works (as before)', credPlain.status === 200 && !credPlain.data.credential.fileUrl);

  // ============================================================ 9: notifications
  console.log('== 9. notifications: each request reaches the admin, each answer reaches the student, on the right screen ==');
  const lastTo = async (token, re) => ((await call('GET', '/api/notifications', { token })).data.notifications.find((n) => re.test(n.title)) || {});
  await call('POST', '/api/students/me/clearance-request', { token: stuToken });
  check('clearance request -> admin, Student Requests', (await lastTo(A.admin, /Clearance requested/)).link === 'admin-student-requests');
  const clr = (await aa('GET', '/admin/clearance-requests')).data.requests[0];
  await aa('POST', `/admin/clearance-requests/${clr.id}/decide`, { body: { status: 'DENIED', note: 'Pay your fees' } });
  check('clearance answer -> student, Clearance', (await lastTo(stuToken, /Clearance update/)).link === 'clearance');
  await call('POST', '/api/students/me/hostel-application', { token: stuToken, body: { roomPreference: 'ground floor' } });
  check('hostel application -> admin, Hostels', (await lastTo(A.admin, /Hostel application received/)).link === 'admin-hostel-allocations');
  const hostel = (await aa('POST', '/admin/hostels', { body: { name: 'Zik Hall' } })).data.hostel;
  const hApp = (await aa('GET', '/admin/hostel-applications')).data.applications[0];
  await call('POST', `/api/admin/hostel-applications/${hApp.id}/approve`, { token: A.admin, body: { hostelId: hostel.id, roomAssigned: 'B12' } });
  check('hostel approval -> student, Hostel / Accommodation', (await lastTo(stuToken, /Hostel application approved/)).link === 'hostel');
  const dr = await aa('POST', `/admin/students/${s1.data.user.id}/disciplinary-records`, { body: { title: 'Late to class' } });
  check('disciplinary record -> student, Academic Record', (await lastTo(stuToken, /Disciplinary record added/)).link === 'academic-record');
  await aa('POST', `/admin/disciplinary-records/${dr.data.record.id}/resolve`);
  check('resolving it -> student told, Academic Record', (await lastTo(stuToken, /Disciplinary record resolved/)).link === 'academic-record');
  // a suspended person cannot sign in to read it, so check the stored notification directly through the admin-lifted account afterwards
  const sus = await aa('POST', `/admin/students/${s2.data.user.id}/suspend`);
  check('suspending a student works', sus.status === 200 && sus.data.user.status === 'SUSPENDED', sus.data);
  const lift = await aa('POST', `/admin/students/${s2.data.user.id}/lift-suspension`);
  const s2Tok = (await login(A, 'Bola Admin ' + RUN, s2.data.accessCode)).data.token;
  const s2n = (await call('GET', '/api/notifications', { token: s2Tok })).data.notifications;
  check('the student was told about the suspension and about it being lifted (both stored)', lift.status === 200 && s2n.some((n) => /status changed/i.test(n.title) && /suspended/i.test(n.body)) && s2n.some((n) => /status changed/i.test(n.title) && /reactivated/i.test(n.body)), s2n.map((n) => n.body));
  const pr = await aa('POST', '/admin/non-academic-staff/' + staff.user.id + '/suspend');
  check('staff status change works', pr.status === 200);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
