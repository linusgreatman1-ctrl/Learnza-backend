// School fees (higher institutions) and class representative voting, against a stand-in database:  npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

const U = {
  adm: { id: 'adm', fullName: 'Registrar', role: 'ADMIN', schoolId: 's1', status: 'ACTIVE' },
  ada: { id: 'ada', fullName: 'Ada', email: 'ada@x.com', role: 'STUDENT', schoolId: 's1', status: 'ACTIVE', yearOfStudy: 2, departmentId: 'd-csc', matricNumber: 'C/1', avatarUrl: null, department: { id: 'd-csc', name: 'Computer Science' } },
  bayo: { id: 'bayo', fullName: 'Bayo', email: 'b@x.com', role: 'STUDENT', schoolId: 's1', status: 'ACTIVE', yearOfStudy: 1, departmentId: 'd-eng', matricNumber: 'E/1', avatarUrl: null, department: { id: 'd-eng', name: 'English' } },
  cara: { id: 'cara', fullName: 'Cara', email: 'c@x.com', role: 'STUDENT', schoolId: 's1', status: 'ACTIVE', yearOfStudy: 2, departmentId: 'd-csc', matricNumber: 'C/2', avatarUrl: null, department: { id: 'd-csc', name: 'Computer Science' } },
  zed: { id: 'zed', fullName: 'Zed', email: 'z@x.com', role: 'STUDENT', schoolId: 's2', status: 'ACTIVE', yearOfStudy: 2, departmentId: 'd-z', avatarUrl: null, department: { id: 'd-z', name: 'Law' } },
  indie: { id: 'indie', fullName: 'Indie', email: 'i@x.com', role: 'STUDENT', schoolId: null, status: 'ACTIVE' },
  dr: { id: 'dr', fullName: 'Dr Tola', role: 'LECTURER', schoolId: 's1', status: 'ACTIVE' },
  dr2: { id: 'dr2', fullName: 'Dr Ken', role: 'LECTURER', schoolId: 's1', status: 'ACTIVE' },
};
const db = { banks: {}, fees: [], payments: [], notes: [], elections: [], positions: [], candidates: [], voters: [], votes: [] };
const departments = { 'd-csc': { id: 'd-csc', schoolId: 's1' }, 'd-eng': { id: 'd-eng', schoolId: 's1' }, 'd-z': { id: 'd-z', schoolId: 's2' } };
const courses = { c1: { id: 'c1', code: 'CSC 201', title: 'Data Structures', level: '200L', department: { schoolId: 's1', name: 'Computer Science' }, _count: { enrollments: 2 } }, c2: { id: 'c2', code: 'ENG 101', title: 'Use of English', level: '100L', department: { schoolId: 's1', name: 'English' }, _count: { enrollments: 1 } } };
const lecturers = [{ lecturerId: 'dr', courseId: 'c1' }, { lecturerId: 'dr2', courseId: 'c2' }];
const enrollments = [{ studentId: 'ada', courseId: 'c1' }, { studentId: 'cara', courseId: 'c1' }, { studentId: 'bayo', courseId: 'c2' }];
let n = 0;
const nid = (p) => p + ++n;
const match = (row, where) => Object.entries(where || {}).every(([k, v]) => {
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('in' in v) return v.in.includes(row[k]);
    if ('not' in v) return row[k] !== v.not;
    if ('contains' in v) return String(row[k] || '').toLowerCase().includes(String(v.contains).toLowerCase());
    return true;
  }
  return row[k] === v;
});
const withStudent = (p) => ({ ...p, student: U[p.studentId] });
const fake = {
  user: {
    findUnique: async ({ where }) => U[where.id] || null,
    findFirst: async ({ where }) => Object.values(U).find((u) => u.id === where.id && u.schoolId === where.schoolId && u.role === where.role && u.status === where.status && (!where.enrollments || enrollments.some((e) => e.studentId === u.id && e.courseId === where.enrollments.some.courseId))) || null,
    findMany: async ({ where }) => Object.values(U).filter((u) => (!where.schoolId || u.schoolId === where.schoolId) && (!where.role || (where.role.in ? where.role.in.includes(u.role) : u.role === where.role)) && (!where.status || u.status === where.status) && (!where.id || (where.id.in || []).includes(u.id)) && (!where.enrollments || enrollments.some((e) => e.studentId === u.id && e.courseId === where.enrollments.some.courseId))),
    count: async ({ where }) => Object.values(U).filter((u) => u.schoolId === where.schoolId && u.role === where.role).length,
  },
  school: { findUnique: async ({ where }) => ({ id: where.id, name: where.id === 's1' ? 'Federal University' : 'Other' }) },
  department: { findFirst: async ({ where }) => (departments[where.id] && departments[where.id].schoolId === where.schoolId ? departments[where.id] : null), findMany: async () => [{ id: 'd-csc', name: 'Computer Science' }] },
  schoolBankAccount: {
    findUnique: async ({ where }) => db.banks[where.schoolId] || null,
    upsert: async ({ where, create, update }) => { db.banks[where.schoolId] = { ...(db.banks[where.schoolId] || create), ...update, updatedAt: new Date() }; return db.banks[where.schoolId]; },
  },
  schoolFee: {
    findMany: async ({ where }) => db.fees.filter((f) => match(f, where)),
    findUnique: async ({ where }) => db.fees.find((f) => f.id === where.id) || null,
    count: async ({ where }) => db.fees.filter((f) => match(f, where)).length,
    create: async ({ data }) => { const f = { id: nid('fee'), createdAt: new Date(), ...data }; db.fees.push(f); return f; },
    update: async ({ where, data }) => Object.assign(db.fees.find((f) => f.id === where.id), data),
    delete: async ({ where }) => { db.fees.splice(db.fees.findIndex((f) => f.id === where.id), 1); },
  },
  feePayment: {
    findMany: async ({ where }) => db.payments.filter((p) => match(p, where)).map(withStudent),
    findUnique: async ({ where }) => { const p = db.payments.find((x) => (where.id ? x.id === where.id : x.receiptNo === where.receiptNo)); return p ? withStudent(p) : null; },
    aggregate: async ({ where }) => ({ _sum: { amountKobo: db.payments.filter((p) => match(p, where)).reduce((a, p) => a + p.amountKobo, 0) } }),
    create: async ({ data }) => { const p = { id: nid('pay'), createdAt: new Date(), proofUrl: null, receiptNo: null, rejectReason: null, reviewedAt: null, provider: null, ...data }; db.payments.push(p); return p; },
    update: async ({ where, data }) => Object.assign(db.payments.find((p) => p.id === where.id), data),
    count: async ({ where }) => db.payments.filter((p) => match(p, where)).length,
  },
  notification: { create: async ({ data }) => { db.notes.push(data); return { id: nid('note'), ...data }; } },
  courseLecturer: {
    findFirst: async ({ where }) => { const r = lecturers.find((l) => l.lecturerId === where.lecturerId && l.courseId === where.courseId); return r ? { ...r, course: courses[r.courseId] } : null; },
    findMany: async ({ where }) => lecturers.filter((l) => l.lecturerId === where.lecturerId).map((l) => ({ ...l, course: courses[l.courseId] })),
  },
  course: { findUnique: async ({ where }) => courses[where.id] || null },
  enrollment: {
    findMany: async ({ where }) => enrollments.filter((e) => e.studentId === where.studentId && where.courseId.in.includes(e.courseId)),
    count: async ({ where }) => enrollments.filter((e) => e.courseId === where.courseId).length,
  },
  election: {
    create: async ({ data }) => {
      const e = { id: nid('el'), status: 'DRAFT', createdAt: new Date(), openedAt: null, closedAt: null, ...data, positions: undefined };
      db.elections.push(e);
      for (const p of data.positions.create) {
        const pos = { id: nid('pos'), electionId: e.id, title: p.title, order: p.order }; db.positions.push(pos);
        for (const c of p.candidates.create) db.candidates.push({ id: nid('cand'), positionId: pos.id, ...c });
      }
      return e;
    },
    findFirst: async ({ where }) => db.elections.find((e) => e.id === where.id && e.schoolId === where.schoolId && (!where.createdById || e.createdById === where.createdById) && (!where.kind || e.kind === where.kind)) || null,
    findMany: async ({ where }) => db.elections.filter((e) => e.schoolId === where.schoolId && (!where.createdById || e.createdById === where.createdById) && (!where.kind || e.kind === where.kind) && (!where.status || (where.status.in ? where.status.in.includes(e.status) : e.status === where.status)) && (!where.OR || e.kind !== 'CLASS_REP' || e.status !== 'DRAFT'))
      .map((e) => ({ ...e, course: e.courseId ? courses[e.courseId] : null, _count: { positions: db.positions.filter((p) => p.electionId === e.id).length, ballots: db.voters.filter((v) => v.electionId === e.id).length } })),
    update: async ({ where, data }) => Object.assign(db.elections.find((e) => e.id === where.id), data),
  },
  electionPosition: {
    count: async ({ where }) => db.positions.filter((p) => p.electionId === where.electionId && !db.candidates.some((c) => c.positionId === p.id)).length,
    findMany: async ({ where }) => db.positions.filter((p) => p.electionId === where.electionId).sort((a, b) => a.order - b.order).map((p) => ({ ...p, candidates: db.candidates.filter((c) => c.positionId === p.id) })),
  },
  electionVoter: {
    findUnique: async ({ where }) => db.voters.find((v) => v.electionId === where.electionId_voterId.electionId && v.voterId === where.electionId_voterId.voterId) || null,
    findMany: async ({ where }) => db.voters.filter((v) => v.electionId === where.electionId && (!where.voterId || v.voterId === where.voterId)),
    count: async ({ where }) => db.voters.filter((v) => v.electionId === where.electionId && v.voterRole === where.voterRole).length,
    create: ({ data }) => ({ __run: async () => { if (db.voters.some((v) => v.electionId === data.electionId && v.voterId === data.voterId)) { const e = new Error('dup'); e.code = 'P2002'; throw e; } db.voters.push({ id: nid('v'), votedAt: new Date(), ...data }); } }),
  },
  electionVote: {
    groupBy: async ({ where }) => {
      const map = new Map();
      db.votes.filter((v) => v.electionId === where.electionId).forEach((v) => { const k = [v.positionId, v.candidateId, v.voterRole].join('|'); map.set(k, (map.get(k) || 0) + 1); });
      return [...map.entries()].map(([k, c]) => { const [positionId, candidateId, voterRole] = k.split('|'); return { positionId, candidateId, voterRole, _count: { _all: c } }; });
    },
    createMany: ({ data }) => ({ __run: async () => { data.forEach((d) => db.votes.push({ id: nid('vote'), ...d })); } }),
  },
  $transaction: async (ops) => { const out = []; for (const op of ops) out.push(await (op.__run ? op.__run() : op)); return out; },
};
const dbPath = require.resolve(path.join('..', '..', 'src', 'db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fake };
const feesRoutes = require('../../src/routes/fees');
const electionRoutes = require('../../src/routes/elections');
const feeKit = require('../../src/services/fees.service');
const F = feesRoutes.handlers;
const E = electionRoutes.handlers;

function call(fn, req) {
  return new Promise((resolve, reject) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { resolve({ status: this.code, body: b }); } };
    Promise.resolve(fn({ body: {}, query: {}, params: {}, get: () => 'localhost', protocol: 'http', ...req }, res)).catch(reject);
  });
}

test('fee categories cover what higher institutions charge, and the kind of fee is its name', () => {
  const ids = feeKit.CATEGORIES.map((c) => c.id);
  for (const id of ['TUITION', 'ACCEPTANCE', 'FACULTY_DUES', 'DEPARTMENTAL_DUES', 'STUDENT_UNION', 'INDUSTRIAL_TRAINING', 'TEACHING_PRACTICE', 'PROJECT', 'HOSTEL', 'GRADUATION', 'OTHER']) assert.ok(ids.includes(id), id);
  assert.equal(feeKit.feeDetails({ category: 'TUITION', amountNaira: 100000 }).data.title, 'School fees / tuition');
  assert.match(feeKit.feeDetails({ category: 'OTHER', title: '', amountNaira: 5 }).error, /what the other fee is for/i);
  assert.equal(feeKit.feeDetails({ category: 'OTHER', title: 'Matric ball', amountNaira: 5000 }).data.title, 'Matric ball');
});

test('the school admin adds bank details and fees limited to a level or a department of their own school', async () => {
  assert.equal((await call(F.saveBank, { user: U.adm, body: { bankName: 'Zenith', accountName: 'FUT', accountNumber: '12' } })).status, 400);
  assert.equal((await call(F.saveBank, { user: U.adm, body: { bankName: 'Zenith Bank', accountName: 'Federal University', accountNumber: '1016980625' } })).status, 200);
  assert.equal((await call(F.createFee, { user: U.adm, body: { category: 'TUITION', amountNaira: 150000, session: '2026/2027', semester: 'First Semester' } })).status, 201);
  assert.equal((await call(F.createFee, { user: U.adm, body: { category: 'LABORATORY', amountNaira: 20000, levels: [2, 3], departmentId: 'd-csc' } })).status, 201);
  assert.equal((await call(F.createFee, { user: U.adm, body: { category: 'INDUSTRIAL_TRAINING', amountNaira: 10000, levels: [3] } })).status, 201);
  const otherSchoolDept = await call(F.createFee, { user: U.adm, body: { category: 'LIBRARY', amountNaira: 5000, departmentId: 'd-z' } });
  assert.equal(otherSchoolDept.status, 400);                                                   // another school's department
});

test('a student sees only the fees for their level and department, and their own school\'s bank details', async () => {
  const ada = await call(F.mine, { user: U.ada });
  assert.deepEqual(ada.body.fees.map((f) => f.title).sort(), ['Laboratory, workshop & practicals', 'School fees / tuition']);   // 200L Computer Science: not the 300L SIWES fee
  assert.equal(ada.body.bank.accountNumber, '1016980625');
  assert.equal(ada.body.student.level, '200L');
  const bayo = await call(F.mine, { user: U.bayo });
  assert.deepEqual(bayo.body.fees.map((f) => f.title), ['School fees / tuition']);              // 100L English: no lab fee
  const zed = await call(F.mine, { user: U.zed });
  assert.equal(zed.body.bank, null);                                                             // another school never sees it
  assert.equal(zed.body.fees.length, 0);
  assert.equal((await call(F.mine, { user: U.indie })).status, 403);                             // independent learners have no school fees
  assert.equal((await call(F.mine, { user: U.adm })).status, 403);
});

test('a student pays part of a fee and an Other fee by transfer: it waits for the school; too much is refused', async () => {
  const fee = db.fees.find((f) => f.category === 'TUITION');
  assert.equal((await call(F.pay, { user: U.ada, body: { items: [{ feeId: fee.id, amountKobo: 99999999 }], reference: 'X' } })).status, 400);
  assert.equal((await call(F.pay, { user: U.ada, body: { items: [{ feeId: fee.id, amountKobo: 5000000 }] } })).status, 400);      // no reference or name
  const ok = await call(F.pay, { user: U.ada, body: { items: [{ feeId: fee.id, amountKobo: 5000000 }, { title: 'Faculty week', amountKobo: 200000 }], reference: 'TRX1', depositorName: 'Mr Okafor' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.payment.status, 'PENDING');
  assert.equal(ok.body.payment.amountKobo, 5200000);
  assert.ok(db.notes.some((x) => x.userId === 'adm' && /to confirm/i.test(x.title)));
});

test('the school confirms with a receipt; it cannot be confirmed twice and another school cannot touch it', async () => {
  const p = db.payments.find((x) => x.reference === 'TRX1');
  const other = { ...U.adm, schoolId: 's2' };
  assert.equal((await call(F.confirmPayment, { user: other, params: { id: p.id } })).status, 404);
  const ok = await call(F.confirmPayment, { user: U.adm, params: { id: p.id } });
  assert.match(ok.body.payment.receiptNo, /^RCT-/);
  assert.equal((await call(F.confirmPayment, { user: U.adm, params: { id: p.id } })).status, 409);
  const view = await call(F.mine, { user: U.ada });
  assert.equal(view.body.fees.find((f) => f.category === 'TUITION').paidKobo, 5000000);
});

test('the school sees who owes what; the office records cash and the fee clears', async () => {
  const lab = db.fees.find((f) => f.category === 'LABORATORY');
  const rec = await call(F.recordPayment, { user: U.adm, body: { studentId: 'cara', items: [{ feeId: lab.id, amountKobo: 2000000 }], method: 'CASH' } });
  assert.equal(rec.status, 201);
  assert.equal(rec.body.payment.status, 'CONFIRMED');
  assert.equal((await call(F.recordPayment, { user: U.adm, body: { studentId: 'zed', items: [{ title: 'x', amountKobo: 1000 }] } })).status, 404);   // not in this school
  const ov = await call(F.overview, { user: U.adm });
  assert.ok(ov.body.totals.collectedKobo > 0);
  assert.ok(ov.body.byDepartment.some((d) => d.department === 'Computer Science'));
});

// ---- class representative voting
const crBody = (extra) => ({ title: 'CSC 201 class rep', courseId: 'c1', positions: [{ title: 'Class Representative', candidates: [{ userId: 'ada' }, { userId: 'cara' }] }], ...extra });
let electionId, posId, adaCand;

test('a lecturer runs a class rep vote only for their own course, with candidates enrolled in it', async () => {
  const courseList = await call(E.myCourses, { user: U.dr });
  assert.deepEqual(courseList.body.courses.map((c) => c.code), ['CSC 201']);
  assert.equal((await call(E.createElection, { user: U.dr, body: crBody({ courseId: 'c2' }) })).status, 400);                   // Dr Tola does not teach ENG 101
  assert.equal((await call(E.createElection, { user: U.dr, body: crBody({ positions: [{ title: 'Rep', candidates: [{ userId: 'bayo' }] }] }) })).status, 400);   // Bayo is not in CSC 201
  const ok = await call(E.createElection, { user: U.dr, body: crBody({ kind: 'LECTURER', voters: 'BOTH' }) });                    // a lecturer cannot change who votes
  assert.equal(ok.status, 201);
  electionId = ok.body.election.id;
  assert.equal(ok.body.election.kind, 'CLASS_REP');
  assert.equal(ok.body.election.voters, 'STUDENTS');
  posId = db.positions[0].id; adaCand = db.candidates.find((c) => c.name === 'Ada').id;
  assert.equal((await call(E.createElection, { user: U.adm, body: { title: 'x', kind: 'CLASS_REP', positions: [{ title: 'p', candidates: [{ name: 'n' }] }] } })).status, 400);   // class votes are a lecturer's
});

test('another lecturer cannot reach it, and the admin does not see a lecturer\'s draft', async () => {
  assert.equal((await call(E.manageOne, { user: U.dr2, params: { id: electionId } })).status, 404);
  assert.equal((await call(E.openElection, { user: U.dr2, params: { id: electionId } })).status, 404);
  assert.equal((await call(E.manageList, { user: U.adm, query: {} })).body.elections.length, 0);
  assert.equal((await call(E.manageList, { user: U.dr, query: {} })).body.elections.length, 1);
});

test('only students enrolled in the course are told, can see it and vote once', async () => {
  const opened = await call(E.openElection, { user: U.dr, params: { id: electionId } });
  assert.equal(opened.body.notified, 2);                                                          // Ada and Cara, not Bayo
  const choices = [{ positionId: posId, candidateId: adaCand }];
  const listFor = async (u) => { let out; await new Promise((resolve) => { const res = { status() { return this; }, json(b) { out = b; resolve(); } }; electionRoutes.stack.find((l) => l.route && l.route.path === '/' && l.route.methods.get).route.stack.slice(-1)[0].handle({ user: u }, res); }); return out; };
  assert.equal((await listFor(U.bayo)).elections.length, 0);                                      // Bayo is in another course
  assert.equal((await listFor(U.ada)).elections.length, 1);
  const voteAs = (u) => new Promise((resolve) => { const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { resolve({ status: this.code, body: b }); } }; electionRoutes.stack.find((l) => l.route && l.route.path === '/:id/vote').route.stack.slice(-1)[0].handle({ user: u, params: { id: electionId }, body: { choices } }, res); });
  assert.equal((await voteAs(U.bayo)).status, 404);
  assert.equal((await voteAs(U.dr2)).status, 404);
  assert.equal((await voteAs(U.ada)).status, 200);
  assert.equal((await voteAs(U.ada)).status, 409);                                                // once only
});

test('the lecturer sees the count and turnout of the course only, and the ballot stays secret', async () => {
  const r = await call(E.manageResults, { user: U.dr, params: { id: electionId } });
  assert.equal(r.body.turnout.students.eligible, 2);
  assert.equal(r.body.turnout.students.voted, 1);
  assert.equal(r.body.election.courseName, 'CSC 201 Data Structures');
  assert.ok(db.votes.every((v) => !('voterId' in v) && !('userId' in v)));
  assert.ok(!JSON.stringify(r.body.voted).includes('candidate'));
});
