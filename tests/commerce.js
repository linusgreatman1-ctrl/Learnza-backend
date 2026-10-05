// Payments (Flutterwave only + bank transfer), elections, and the practice material the system
// writes for each course.
//
// Start the server with:  LZ_FAKE_AI=1 FLUTTERWAVE_WEBHOOK_HASH=whash FLUTTERWAVE_PUBLIC_KEY=FLWPUBK-test node src/server.js
//   SUPER_EMAIL=... SUPER_PASSWORD=... node tests/commerce.js
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const BASE = process.env.BASE || 'http://localhost:4100';
const RUN = Date.now();
const HASH = process.env.FLUTTERWAVE_WEBHOOK_HASH || 'whash';
let pass = 0, fail = 0;

function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
async function call(method, path, { token, body, headers } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}, headers || {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let r = await call('POST', '/api/super/login', { body: { email: process.env.SUPER_EMAIL, password: process.env.SUPER_PASSWORD } });
  const SUPER = r.data.token;
  if (!SUPER) throw new Error('super login failed');

  const mkSchool = async (label) => {
    const name = `Commerce ${label} ${RUN}`;
    const s = await call('POST', '/api/super/schools', { token: SUPER, body: { name } });
    const a = await call('POST', '/api/auth/school-login', { body: { schoolName: name, joinCode: s.data.joinCode } });
    return { name, admin: a.data.token };
  };
  const A = await mkSchool('A');
  const B = await mkSchool('B');
  const dept = (await call('POST', '/api/admin/departments', { token: A.admin, body: { name: 'History', code: 'HIS' } })).data.department;
  const course = (await call('POST', '/api/admin/courses', { token: A.admin, body: { departmentId: dept.id, code: 'HIS101', title: 'World History' } })).data.course;
  const person = async (school, path, body, role) => {
    const c = await call('POST', path, { token: school.admin, body });
    const l = await call('POST', '/api/auth/login-with-code', { body: { fullName: body.fullName, schoolName: school.name, accessCode: c.data.accessCode } });
    return { token: l.data.token, id: c.data.user.id, name: body.fullName, role };
  };
  const stu1 = await person(A, '/api/admin/students', { fullName: 'Voter One ' + RUN, matricNumber: 'H/1', departmentId: dept.id, yearOfStudy: 1, courseIds: [course.id] }, 'STUDENT');
  const stu2 = await person(A, '/api/admin/students', { fullName: 'Voter Two ' + RUN, matricNumber: 'H/2', departmentId: dept.id, yearOfStudy: 1, courseIds: [course.id] }, 'STUDENT');
  const stu3 = await person(A, '/api/admin/students', { fullName: 'Candidate Three ' + RUN, matricNumber: 'H/3', departmentId: dept.id, yearOfStudy: 2 }, 'STUDENT');
  const lec1 = await person(A, '/api/admin/lecturers', { fullName: 'Lec One ' + RUN, departmentId: dept.id, courseIds: [course.id] }, 'LECTURER');
  const lec2 = await person(A, '/api/admin/lecturers', { fullName: 'Lec Two ' + RUN, departmentId: dept.id }, 'LECTURER');
  const deptB = (await call('POST', '/api/admin/departments', { token: B.admin, body: { name: 'Law', code: 'LAW' } })).data.department;
  const stuB = await person(B, '/api/admin/students', { fullName: 'Other School ' + RUN, matricNumber: 'B/1', departmentId: deptB.id }, 'STUDENT');
  const indieEmail = `commerce${RUN}@example.com`;
  r = await call('POST', '/api/auth/register-individual', { body: { fullName: 'Indie ' + RUN, email: indieEmail, password: 'secret12', institutionType: 'MONOTECHNIC' } });
  const indie = { token: r.data.token, id: r.data.user.id };

  // ================================================================ payments
  console.log('== payments: Flutterwave + bank transfer, no Paystack ==');
  r = await call('GET', '/api/billing/config', { token: stu1.token });
  check('payment config: public key, PassNow bank details, plans, packs', r.status === 200 && r.data.flutterwavePublicKey && r.data.bank.bankName === 'Zenith Bank International' && r.data.bank.accountName === 'Infopedia Technology' && r.data.bank.accountNumber === '1016980625' && r.data.plans.length === 2 && r.data.packs.length === 2 && r.data.ussdTemplate === '*966*{amount}*1016980625#', r.data);
  for (const [m, p] of [['GET', '/api/billing/providers'], ['POST', '/api/billing/checkout'], ['POST', '/api/billing/webhook/paystack'], ['POST', '/api/coins/checkout']]) {
    r = await call(m, p, { token: stu1.token, body: m === 'GET' ? undefined : {} });
    check(`${m} ${p} no longer exists`, r.status === 404, r.status);
  }
  r = await call('POST', '/api/billing/initiate', { token: stu1.token, body: { plan: 'WEEKLY' } });
  check('unknown plan -> 400', r.status === 400);
  r = await call('POST', '/api/billing/initiate', { token: stu1.token, body: { plan: 'MONTHLY', amount: 1 } });
  check('initiate: the server sets the price, whatever the client sends', r.status === 201 && r.data.amount === 10000 && r.data.reference.startsWith('LZ-'), r.data);
  const ref1 = r.data.reference;
  r = await call('POST', '/api/billing/initiate', { token: A.admin, body: { plan: 'MONTHLY' } });
  check('only students can buy a plan', r.status === 403);
  r = await call('GET', '/api/billing/verify/' + ref1, { token: stu1.token });
  check('verify without a provider confirmation leaves it pending', r.status === 200 && r.data.status === 'PENDING', r.data);
  r = await call('GET', '/api/billing/verify/' + ref1, { token: stu2.token });
  check("another student cannot ask about someone's payment", r.status === 404);

  const hook = (tx_ref, amount, headers) => call('POST', '/api/billing/webhook/flutterwave', { headers: headers === undefined ? { 'verif-hash': HASH } : headers, body: { event: 'charge.completed', data: { tx_ref, status: 'successful', amount } } });
  r = await hook(ref1, 10000, {});
  check('webhook without the signature -> 401', r.status === 401);
  r = await hook(ref1, 10000, { 'verif-hash': 'wrong' });
  check('webhook with a wrong signature -> 401', r.status === 401);
  await hook(ref1, 5000);
  r = await call('GET', '/api/billing/status', { token: stu1.token });
  check('a payment for less than the price is not accepted', r.data.active === false);
  await hook(ref1, 10000);
  r = await call('GET', '/api/billing/status', { token: stu1.token });
  check('the full payment activates the subscription', r.data.active === true && r.data.subscription.plan === 'MONTHLY' && r.data.subscription.aiSecondsGranted === 300 * 60, r.data);
  const before = (await prisma.subscription.findUnique({ where: { userId: stu1.id } })).expiresAt.getTime();
  await hook(ref1, 10000);
  await hook(ref1, 10000);
  const after = (await prisma.subscription.findUnique({ where: { userId: stu1.id } })).expiresAt.getTime();
  check('a replayed webhook does not extend it again', before === after);

  r = await call('POST', '/api/billing/manual', { token: stu2.token, body: { plan: 'YEARLY' } });
  check('bank transfer / USSD request is recorded', r.status === 201 && r.data.reference.startsWith('LZ-MANUAL-'), r.data);
  const manualRef = r.data.reference;
  r = await call('GET', '/api/billing/status', { token: stu2.token });
  check('...and gives nothing until an admin confirms', r.data.active === false);
  r = await call('GET', '/api/super/dashboard', { token: SUPER });
  check('owner dashboard counts it as waiting', r.data.activity.pendingManualPayments >= 1);
  r = await call('GET', '/api/super/payments?status=PENDING', { token: SUPER });
  const manualRow = r.data.payments.find((p) => p.reference === manualRef);
  check('owner sees it in Payments as a bank transfer', manualRow && manualRow.provider === 'MANUAL_TRANSFER');
  r = await call('POST', `/api/super/payments/${manualRow.id}/confirm`, { token: A.admin });
  check('a school admin cannot confirm payments', r.status === 403);
  r = await call('POST', `/api/super/payments/${manualRow.id}/confirm`, { token: SUPER });
  check('owner confirms it', r.status === 200 && r.data.ok);
  r = await call('GET', '/api/billing/status', { token: stu2.token });
  check('the yearly plan is now active', r.data.active === true && r.data.subscription.plan === 'YEARLY');
  const exp = (await prisma.subscription.findUnique({ where: { userId: stu2.id } })).expiresAt.getTime();
  await call('POST', `/api/super/payments/${manualRow.id}/confirm`, { token: SUPER });
  check('confirming twice does nothing the second time', (await prisma.subscription.findUnique({ where: { userId: stu2.id } })).expiresAt.getTime() === exp);
  const fwRow = (await call('GET', '/api/super/payments', { token: SUPER })).data.payments.find((p) => p.reference === ref1);
  r = await call('POST', `/api/super/payments/${fwRow.id}/confirm`, { token: SUPER });
  check('card payments cannot be confirmed by hand', r.status === 400);
  r = await call('POST', '/api/billing/manual', { token: stu3.token, body: { plan: 'MONTHLY' } });
  const rej = (await call('GET', '/api/super/payments?status=PENDING', { token: SUPER })).data.payments.find((p) => p.reference === r.data.reference);
  r = await call('POST', `/api/super/payments/${rej.id}/reject`, { token: SUPER });
  r = await call('GET', '/api/billing/status', { token: stu3.token });
  check('a rejected transfer gives nothing', r.data.active === false);

  console.log('== coins: same two routes ==');
  r = await call('POST', '/api/coins/initiate', { token: indie.token, body: { packId: 'COINS_30' } });
  check('coin initiate: server price (₦2,500)', r.status === 201 && r.data.amount === 2500 && r.data.reference.startsWith('LZ-COIN-'), r.data);
  const coinRef = r.data.reference;
  await hook(coinRef, 1000);
  r = await call('GET', '/api/coins', { token: indie.token });
  check('underpaid coin purchase credits nothing', r.data.balance === 0);
  await hook(coinRef, 2500);
  await hook(coinRef, 2500);
  r = await call('GET', '/api/coins', { token: indie.token });
  check('paid in full -> 30 coins, once, = 30 minutes', r.data.balance === 30 && r.data.minutesLeft === 30, r.data);
  r = await call('GET', '/api/billing/verify/' + coinRef, { token: indie.token });
  check('verify reports coin purchases too', r.data.status === 'SUCCESS' && r.data.kind === 'coins' && r.data.coins === 30, r.data);
  r = await call('POST', '/api/coins/manual', { token: indie.token, body: { packId: 'COINS_100', method: 'USSD' } });
  check('bank/USSD coin request recorded', r.status === 201);
  r = await call('GET', '/api/coins', { token: indie.token });
  check('...and shown as waiting', r.data.pending.length === 1 && r.data.balance === 30);
  const cp = (await call('GET', '/api/super/coins/purchases', { token: SUPER })).data.purchases.find((p) => p.status === 'PENDING' && p.provider === 'MANUAL_TRANSFER' && p.user.id === indie.id);
  r = await call('POST', `/api/super/coins/purchases/${cp.id}/confirm`, { token: SUPER });
  await call('POST', `/api/super/coins/purchases/${cp.id}/confirm`, { token: SUPER });
  r = await call('GET', '/api/coins', { token: indie.token });
  check('owner confirms: +100 coins, credited exactly once', r.data.balance === 130 && r.data.pending.length === 0, r.data.balance);

  // ================================================================ elections
  console.log('== elections ==');
  const sug = (extra = {}) => ({
    title: 'SUG ' + RUN, kind: 'STUDENT_SUG',
    positions: [
      { title: 'President', candidates: [{ userId: stu3.id, manifesto: 'Better cafeteria' }, { name: 'Walk-in Candidate' }] },
      { title: 'Secretary', candidates: [{ name: 'Only Runner' }] },
    ],
    ...extra,
  });
  r = await call('POST', '/api/elections/manage', { token: A.admin, body: sug({ title: '' }) });
  check('election needs a title', r.status === 400);
  r = await call('POST', '/api/elections/manage', { token: A.admin, body: sug({ positions: [] }) });
  check('election needs positions', r.status === 400);
  r = await call('POST', '/api/elections/manage', { token: A.admin, body: sug({ positions: [{ title: 'President', candidates: [{ userId: lec1.id }] }] }) });
  check('a lecturer cannot stand in a student (SUG) election', r.status === 400, r.data);
  r = await call('POST', '/api/elections/manage', { token: A.admin, body: sug({ positions: [{ title: 'President', candidates: [{ userId: stuB.id }] }] }) });
  check("another school's student cannot stand", r.status === 400);
  r = await call('POST', '/api/elections/manage', { token: stu1.token, body: sug() });
  check('students cannot create elections', r.status === 403);
  r = await call('POST', '/api/elections/manage', { token: A.admin, body: sug() });
  check('admin creates a SUG election (draft)', r.status === 201 && r.data.election.state === 'DRAFT' && r.data.election.voters === 'STUDENTS', r.data);
  const el = r.data.election;
  r = await call('GET', '/api/elections', { token: stu1.token });
  check('a draft is invisible to voters', !r.data.elections.some((e) => e.id === el.id));
  r = await call('GET', '/api/elections/manage', { token: B.admin });
  check("another school's admin sees none of it", !r.data.elections.some((e) => e.id === el.id));
  r = await call('GET', `/api/elections/manage/candidates?kind=STUDENT_SUG&q=Candidate%20Three`, { token: A.admin });
  check('candidate search finds students of this school only', r.data.people.length === 1 && r.data.people[0].id === stu3.id, r.data);
  r = await call('PUT', `/api/elections/manage/${el.id}`, { token: A.admin, body: sug({ title: 'SUG edited ' + RUN }) });
  check('a draft can be edited', r.status === 200);
  r = await call('POST', `/api/elections/manage/${el.id}/open`, { token: A.admin });
  check('open voting', r.status === 200 && r.data.notified >= 3, r.data);
  r = await call('GET', '/api/notifications', { token: stu1.token });
  check('voters were notified', r.data.notifications.some((n) => n.title === 'Voting is open' && n.link === 'elections'));
  r = await call('PUT', `/api/elections/manage/${el.id}`, { token: A.admin, body: sug() });
  check('an opened election can no longer be edited', r.status === 409);
  r = await call('DELETE', `/api/elections/manage/${el.id}`, { token: A.admin });
  check('...or deleted', r.status === 409);

  r = await call('GET', '/api/elections/summary', { token: stu1.token });
  check('dashboard banner: 1 election waiting', r.data.pending === 1, r.data);
  r = await call('GET', '/api/elections/summary', { token: lec1.token });
  check('lecturers are not asked to vote in a students-only election', r.data.pending === 0 && r.data.open === 0, r.data);
  r = await call('GET', `/api/elections/${el.id}`, { token: lec1.token });
  check('...and cannot open its ballot', r.status === 404);
  r = await call('GET', `/api/elections/${el.id}`, { token: stuB.token });
  check("another school's student cannot see it", r.status === 404);
  r = await call('GET', `/api/elections/${el.id}`, { token: stu1.token });
  const ballot = r.data;
  check('the ballot lists positions and candidates, with no vote counts', r.status === 200 && ballot.positions.length === 2 && ballot.results === null && !JSON.stringify(ballot).includes('"votes"'), ballot.election);
  const pres = ballot.positions.find((p) => p.title === 'President');
  const sec = ballot.positions.find((p) => p.title === 'Secretary');
  const cand = (p, name) => p.candidates.find((c) => c.name.includes(name));
  r = await call('POST', `/api/elections/${el.id}/vote`, { token: stu1.token, body: { choices: [] } });
  check('an empty ballot is refused', r.status === 400);
  r = await call('POST', `/api/elections/${el.id}/vote`, { token: stu1.token, body: { choices: [{ positionId: pres.id, candidateId: cand(sec, 'Only').id }] } });
  check("a candidate from a different position is refused", r.status === 400);
  r = await call('POST', `/api/elections/${el.id}/vote`, { token: stu1.token, body: { choices: [{ positionId: pres.id, candidateId: cand(pres, 'Candidate Three').id }, { positionId: pres.id, candidateId: cand(pres, 'Walk-in').id }] } });
  check('two choices for one position are refused', r.status === 400);
  r = await call('POST', `/api/elections/${el.id}/vote`, { token: lec1.token, body: { choices: [{ positionId: pres.id, candidateId: cand(pres, 'Walk-in').id }] } });
  check('a lecturer cannot vote in a students-only election', r.status === 404);
  const [v1, v2] = await Promise.all([
    call('POST', `/api/elections/${el.id}/vote`, { token: stu1.token, body: { choices: [{ positionId: pres.id, candidateId: cand(pres, 'Candidate Three').id }, { positionId: sec.id, candidateId: cand(sec, 'Only').id }] } }),
    call('POST', `/api/elections/${el.id}/vote`, { token: stu1.token, body: { choices: [{ positionId: pres.id, candidateId: cand(pres, 'Walk-in').id }] } }),
  ]);
  check('two simultaneous votes from the same student: exactly one counts', [v1.status, v2.status].sort().join() === '200,409', [v1.status, v2.status]);
  r = await call('POST', `/api/elections/${el.id}/vote`, { token: stu2.token, body: { choices: [{ positionId: pres.id, candidateId: cand(pres, 'Candidate Three').id }] } });
  check('a second student votes (skipping Secretary)', r.status === 200 && r.data.positionsVoted === 1);
  r = await call('POST', `/api/elections/${el.id}/vote`, { token: stu2.token, body: { choices: [{ positionId: pres.id, candidateId: cand(pres, 'Walk-in').id }] } });
  check('voting twice is refused', r.status === 409);
  r = await call('GET', '/api/elections/summary', { token: stu1.token });
  check('banner clears once voted', r.data.pending === 0);

  r = await call('GET', `/api/elections/manage/${el.id}/results`, { token: A.admin });
  const res = r.data;
  const rp = res.positions.find((p) => p.title === 'President');
  const c3 = rp.candidates.find((c) => c.name.includes('Candidate Three'));
  check('admin sees every candidate\'s votes', c3.votes === (v1.status === 200 ? 2 : 1), rp);
  check('...with the student / lecturer split and a leader', c3.byStudents === c3.votes && c3.byLecturers === 0 && rp.candidates[0].leading === true, rp.candidates);
  check('turnout: 2 of 3 eligible students (voters only students)', res.turnout.students.voted === 2 && res.turnout.students.eligible >= 3 && !res.turnout.lecturers, res.turnout);
  check('the voter list names who voted but not what they chose', res.voted.length === 2 && res.voted.every((v) => v.name && !('candidate' in v) && !('choice' in v)) && res.voted.some((v) => v.name === stu2.name));
  const tableDump = await prisma.electionVote.findMany({ where: { electionId: el.id } });
  check('the stored ballots carry no voter id (secret by construction)', tableDump.length >= 2 && tableDump.every((v) => !('voterId' in v)));
  r = await call('GET', `/api/elections/manage/${el.id}/results`, { token: B.admin });
  check("another school's admin cannot see the results", r.status === 404);
  r = await call('GET', `/api/elections/manage/${el.id}/results`, { token: stu1.token });
  check('students cannot use the admin results', r.status === 403);

  r = await call('POST', `/api/elections/manage/${el.id}/close`, { token: A.admin });
  check('admin closes voting', r.status === 200);
  r = await call('POST', `/api/elections/${el.id}/vote`, { token: stu3.token, body: { choices: [{ positionId: pres.id, candidateId: cand(pres, 'Walk-in').id }] } });
  check('voting after it closed is refused', r.status === 409);
  r = await call('GET', `/api/elections/${el.id}`, { token: stu1.token });
  check('voters do not see results unless the admin allows it', r.data.results === null);
  await call('POST', `/api/elections/manage/${el.id}/results-visible`, { token: A.admin, body: { visible: true } });
  r = await call('GET', `/api/elections/${el.id}`, { token: stu1.token });
  check('...once allowed and closed, they do', r.data.results && r.data.results.find((p) => p.title === 'President').candidates.length === 2);

  // both groups vote
  r = await call('POST', '/api/elections/manage', { token: A.admin, body: { title: 'Joint ' + RUN, kind: 'LECTURER', voters: 'BOTH', positions: [{ title: 'Head of Staff Welfare', candidates: [{ userId: lec2.id }, { name: 'External Nominee' }] }] } });
  const joint = r.data.election;
  check('lecturer election open to students and lecturers', joint.voters === 'BOTH');
  await call('POST', `/api/elections/manage/${joint.id}/open`, { token: A.admin });
  const jb = (await call('GET', `/api/elections/${joint.id}`, { token: lec1.token })).data;
  const jp = jb.positions[0];
  await call('POST', `/api/elections/${joint.id}/vote`, { token: lec1.token, body: { choices: [{ positionId: jp.id, candidateId: jp.candidates.find((c) => c.name.includes('Lec Two')).id }] } });
  await call('POST', `/api/elections/${joint.id}/vote`, { token: stu1.token, body: { choices: [{ positionId: jp.id, candidateId: jp.candidates.find((c) => c.name.includes('Lec Two')).id }] } });
  await call('POST', `/api/elections/${joint.id}/vote`, { token: stu2.token, body: { choices: [{ positionId: jp.id, candidateId: jp.candidates.find((c) => c.name.includes('External')).id }] } });
  r = await call('GET', `/api/elections/manage/${joint.id}/results`, { token: A.admin });
  const leader = r.data.positions[0].candidates[0];
  check('admin sees votes from students AND lecturers, split by group', leader.name.includes('Lec Two') && leader.votes === 2 && leader.byStudents === 1 && leader.byLecturers === 1 && r.data.turnout.students.voted === 2 && r.data.turnout.lecturers.voted === 1, r.data.positions[0]);
  r = await call('POST', '/api/elections/manage', { token: A.admin, body: { title: 'Late', kind: 'STUDENT_SUG', closesAt: new Date(Date.now() - 3600000).toISOString(), positions: [{ title: 'P', candidates: [{ name: 'X' }] }] } });
  r = await call('POST', `/api/elections/manage/${r.data.election.id}/open`, { token: A.admin });
  check('an election whose closing time has passed cannot be opened', r.status === 400);
  r = await call('POST', '/api/elections/manage', { token: A.admin, body: { title: 'Scheduled', kind: 'STUDENT_SUG', opensAt: new Date(Date.now() + 86400000).toISOString(), positions: [{ title: 'P', candidates: [{ name: 'X' }] }] } });
  const sched = r.data.election.id;
  await call('POST', `/api/elections/manage/${sched}/open`, { token: A.admin });
  const sb = (await call('GET', `/api/elections/${sched}`, { token: stu1.token })).data;
  r = await call('POST', `/api/elections/${sched}/vote`, { token: stu1.token, body: { choices: [{ positionId: sb.positions[0].id, candidateId: sb.positions[0].candidates[0].id }] } });
  check('voting before the start time is refused', r.status === 409 && sb.election.state === 'UPCOMING', r.data);

  // ================================================================ generated practice
  console.log('== practice written for each course ==');
  r = await call('GET', '/api/practice/status', { token: lec1.token });
  check('students only', r.status === 403);
  r = await call('POST', '/api/practice/ensure', { token: stu1.token });
  check('ensure starts the course', r.status === 200 && r.data.courses.some((c) => c.id === course.id && ['generating', 'ready'].includes(c.status)), r.data);
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    r = await call('GET', '/api/practice/status', { token: stu1.token });
    ready = r.data.courses.every((c) => c.status === 'ready');
    if (!ready) await sleep(1500);
  }
  check('it becomes ready', ready, r.data);
  r = await call('GET', `/api/courses/${course.id}/assessments`, { token: stu1.token });
  const mocks = r.data.assessments.filter((a) => a.type === 'Mock'), pasts = r.data.assessments.filter((a) => a.type === 'PAST_QUESTION');
  check('the student has 2 mock exams (10 questions) and a past-question set (20)', mocks.length === 2 && mocks.every((m) => m._count.questions === 10) && pasts.length === 1 && pasts[0]._count.questions === 20, r.data.assessments.map((a) => [a.type, a._count.questions]));
  check('past-question set is honestly titled as practice', /Past Questions Practice/.test(pasts[0].title));
  r = await call('GET', `/api/courses/${course.id}/assessments`, { token: lec1.token });
  check("lecturers do not see (or manage) the system's sets", r.data.assessments.length === 0, r.data.assessments.map((a) => a.title));
  const stuAs = await call('GET', `/api/courses/${course.id}/assessments`, { token: stu2.token });
  check('every enrolled student shares the same sets (written once per course)', stuAs.data.assessments.length === 3);
  await call('POST', '/api/practice/ensure', { token: stu2.token });
  await sleep(1500);
  r = await call('GET', `/api/courses/${course.id}/assessments`, { token: stu1.token });
  check('asking again writes nothing more', r.data.assessments.length === 3);
  const rec = await call('GET', '/api/students/me/academic-record', { token: stu1.token });
  check("generated sets do not count as the student's tests", rec.data.tests.total === 0 && rec.data.exams.total === 0, rec.data.tests);

  r = await call('GET', '/api/questions/my-courses', { token: stu1.token });
  const mc = r.data.courses.find((c) => c.id === course.id);
  check('a 30-question practice bank exists for the course', mc && mc.kind === 'school' && mc.count === 30, r.data);
  r = await call('GET', `/api/questions/practice?courseId=${course.id}&count=10`, { token: stu1.token });
  check('practice questions for a course, without the answers', r.status === 200 && r.data.questions.length === 10 && r.data.questions.every((q) => q.correctIndex === undefined) && r.data.subject.includes('HIS101'), r.data.subject);
  const ids = r.data.questions.map((q) => q.id);
  r = await call('POST', '/api/questions/check', { token: stu1.token, body: { answers: ids.map((id) => ({ id, choice: 0 })) } });
  check('answers are checked on the server', r.status === 200 && r.data.total === 10 && r.data.review.every((x) => typeof x.correctIndex === 'number'));
  r = await call('GET', `/api/questions/practice?courseId=${course.id}`, { token: stuB.token });
  check("a student of another school cannot practise this course", r.status === 404);
  r = await call('POST', '/api/questions/check', { token: stuB.token, body: { answers: ids.map((id) => ({ id, choice: 0 })) } });
  check("...nor read its answers through /check", r.data.total === 0);
  r = await call('GET', `/api/super/questions?search=question`, { token: SUPER });
  check("generated sets stay out of the owner's question bank list", !r.data.questions.some((q) => q.generated));

  r = await call('POST', '/api/individual-courses', { token: indie.token, body: { title: 'Introductory Economics' } });
  const selfCourse = r.data.course;
  r = await call('POST', '/api/practice/ensure', { token: indie.token });
  ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    r = await call('GET', '/api/practice/status', { token: indie.token });
    ready = r.data.courses.length && r.data.courses.every((c) => c.status === 'ready');
    if (!ready) await sleep(1500);
  }
  check('an independent student gets the same for their own course', ready, r.data);
  r = await call('GET', `/api/individual-courses/${selfCourse.id}/assessments`, { token: indie.token });
  check('...2 mocks and a past-question set', r.data.assessments.filter((a) => a.type === 'Mock').length === 2 && r.data.assessments.filter((a) => a.type === 'PAST_QUESTION').length === 1, r.data.assessments.map((a) => a.type));
  r = await call('GET', `/api/questions/practice?individualCourseId=${selfCourse.id}&count=10`, { token: indie.token });
  check('...and practice questions', r.status === 200 && r.data.questions.length === 10);
  r = await call('GET', `/api/questions/practice?individualCourseId=${selfCourse.id}`, { token: stu1.token });
  check("another student cannot practise someone's self-study course", r.status === 404);

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('TEST CRASHED', e); await prisma.$disconnect(); process.exit(2); });
