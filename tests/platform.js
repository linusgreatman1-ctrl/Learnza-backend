// Super-admin platform features (phase 3), against a running server.
//
//   DATABASE_URL=... JWT_SECRET=... SUPER_EMAIL=... SUPER_PASSWORD=... node tests/platform.js
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
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
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let r = await call('POST', '/api/super/login', { body: { email: process.env.SUPER_EMAIL, password: process.env.SUPER_PASSWORD } });
  const SUPER = r.data.token;
  if (!SUPER) throw new Error('super login failed');

  console.log('== access control ==');
  for (const p of ['/announcements', '/payments', '/subscriptions', '/ai-logs', '/ai-sessions', '/live-classes', '/gamification', '/library', '/settings']) {
    r = await call('GET', '/api/super' + p);
    if (r.status !== 401) check(`GET ${p} without a token -> 401`, false, r.status);
  }
  check('every platform route refuses anonymous callers', true);

  // a school with an admin, a student, and an independent learner
  const schoolName = 'Platform Test ' + RUN;
  r = await call('POST', '/api/super/schools', { token: SUPER, body: { name: schoolName } });
  const joinCode = r.data.joinCode;
  const schoolId = r.data.school.id;
  r = await call('POST', '/api/auth/school-login', { body: { schoolName, joinCode } });
  const admin = r.data.token;
  const nonSuper = admin;
  for (const p of ['/announcements', '/payments', '/settings', '/library']) {
    r = await call('GET', '/api/super' + p, { token: nonSuper });
    if (r.status !== 403) check(`school admin cannot read ${p}`, false, r.status);
  }
  check('a school admin cannot reach any platform route', true);

  r = await call('POST', '/api/admin/departments', { token: admin, body: { name: 'Physics', code: 'PHY' } });
  const dept = r.data.department;
  r = await call('POST', '/api/admin/lecturers', { token: admin, body: { fullName: 'Plat Lecturer', departmentId: dept.id } });
  const platLec = (await call('POST', '/api/auth/login-with-code', { body: { fullName: 'Plat Lecturer', schoolName, accessCode: r.data.accessCode } })).data.token;
  r = await call('POST', '/api/lect/students', { token: platLec, body: { fullName: 'Plat Student', matricNumber: 'P/1' } });
  const stuLogin = await call('POST', '/api/auth/login-with-code', { body: { fullName: 'Plat Student', schoolName, accessCode: r.data.accessCode } });
  const stu = stuLogin.data.token;
  const indEmail = `plat${RUN}@example.com`;
  r = await call('POST', '/api/auth/register-individual', { body: { fullName: 'Plat Indie', email: indEmail, password: 'secret12', institutionType: 'OTHER' } });
  const indie = r.data.token;
  const indieId = r.data.user.id;

  console.log('== announcements ==');
  r = await call('POST', '/api/super/announcements', { token: SUPER, body: { title: 'Hello', body: '', audience: 'ALL' } });
  check('empty message refused', r.status === 400, r);
  r = await call('POST', '/api/super/announcements', { token: SUPER, body: { title: 'Hi', body: 'x', audience: 'NOPE' } });
  check('bad audience refused', r.status === 400, r);
  r = await call('POST', '/api/super/announcements', { token: SUPER, body: { title: 'Hi', body: 'x', audience: 'SCHOOL', schoolId: 'nope' } });
  check('unknown school refused', r.status === 400, r);
  r = await call('POST', '/api/super/announcements', { token: SUPER, body: { title: 'Hi', body: 'x', audience: 'ALL', channels: ['EMAIL'] } });
  check('email channel refused when SMTP is not configured', r.status === 400, r);
  r = await call('POST', '/api/super/announcements', { token: SUPER, body: { title: 'Only for ' + RUN, body: 'School-only news', audience: 'SCHOOL', schoolId } });
  check('announce to one school', r.status === 200 && r.data.announcement.recipientCount === 3, r);
  await sleep(1500);
  const feed = async (token) => (await call('GET', '/api/notifications', { token })).data.notifications || [];
  check('the school admin got it', (await feed(admin)).some((n) => n.title === 'Only for ' + RUN));
  check('the school student got it', (await feed(stu)).some((n) => n.title === 'Only for ' + RUN));
  check('an independent student did NOT get a school-only message', !(await feed(indie)).some((n) => n.title === 'Only for ' + RUN));
  r = await call('POST', '/api/super/announcements', { token: SUPER, body: { title: 'Indie ' + RUN, body: 'For independents', audience: 'INDEPENDENT' } });
  await sleep(2500);
  check('independent-only message reaches an independent student', (await feed(indie)).some((n) => n.title === 'Indie ' + RUN));
  check('...and not a school student', !(await feed(stu)).some((n) => n.title === 'Indie ' + RUN));
  r = await call('GET', '/api/super/announcements', { token: SUPER });
  check('sent announcements are listed', r.data.announcements.some((a) => a.title === 'Only for ' + RUN && a.schoolName === schoolName), r.data.announcements && r.data.announcements[0]);

  console.log('== subscriptions + payments ==');
  r = await call('POST', '/api/super/subscriptions/grant', { token: SUPER, body: { email: 'nobody@example.com', plan: 'MONTHLY' } });
  check('grant to an unknown email -> 404', r.status === 404, r);
  r = await call('POST', '/api/super/subscriptions/grant', { token: SUPER, body: { email: indEmail, plan: 'WEEKLY' } });
  check('grant with a bad plan -> 400', r.status === 400, r);
  r = await call('POST', '/api/super/subscriptions/grant', { token: SUPER, body: { email: indEmail, plan: 'MONTHLY', days: 10 } });
  check('manual grant works', r.status === 200 && r.data.subscription.status === 'ACTIVE', r);
  r = await call('GET', '/api/billing/status', { token: indie });
  check('the student now has an active subscription', r.data.active === true, r.data);
  r = await call('GET', '/api/super/subscriptions?state=active', { token: SUPER });
  check('it shows in the active list', r.data.subscriptions.some((s) => s.userId === indieId && s.active), r.data.total);
  await prisma.payment.create({ data: { userId: indieId, provider: 'FLUTTERWAVE', reference: 'plat_' + RUN, plan: 'MONTHLY', amountKobo: 1000000, status: 'SUCCESS' } });
  r = await call('GET', '/api/super/payments', { token: SUPER });
  check('payments list + revenue summary', r.data.payments.some((p) => p.reference === 'plat_' + RUN) && r.data.summary.revenueKobo >= 1000000, r.data.summary);
  r = await call('POST', `/api/super/subscriptions/${indieId}/revoke`, { token: SUPER });
  check('revoke', r.status === 200, r);
  r = await call('GET', '/api/billing/status', { token: indie });
  check('revoked student is no longer active', r.data.active === false, r.data);
  r = await call('GET', '/api/super/dashboard', { token: SUPER });
  check('dashboard shows revenue + activity', r.data.activity && r.data.activity.revenueThisMonthKobo >= 1000000, r.data.activity);

  console.log('== AI activity ==');
  await prisma.aiConversationLog.create({ data: { userId: indieId, kind: 'RESEARCH', question: 'What is entropy ' + RUN + '?', answer: 'Disorder.' } });
  r = await call('GET', '/api/super/ai-logs?search=' + RUN, { token: SUPER });
  check('AI conversation log is searchable', r.data.logs.length === 1 && r.data.logs[0].user.fullName === 'Plat Indie', r.data);
  r = await call('GET', '/api/super/ai-sessions', { token: SUPER });
  check('AI Teacher sessions list loads', r.status === 200 && Array.isArray(r.data.sessions));

  console.log('== settings ==');
  r = await call('GET', '/api/super/settings', { token: SUPER });
  const keys = r.data.settings.map((s) => s.key);
  check('settings list has every key', ['subscriptionEnforced', 'maintenanceMode', 'maintenanceMessage', 'registrationOpen', 'aiEnabled', 'aiQuestionsPerDay'].every((k) => keys.includes(k)), keys);

  r = await call('PUT', '/api/super/settings', { token: SUPER, body: { settings: { registrationOpen: false } } });
  check('close registration', r.status === 200);
  r = await call('POST', '/api/auth/register-individual', { body: { fullName: 'Late', email: `late${RUN}@example.com`, password: 'secret12', institutionType: 'OTHER' } });
  check('sign-up refused while closed', r.status === 403 && r.data.code === 'REGISTRATION_CLOSED', r);
  await call('PUT', '/api/super/settings', { token: SUPER, body: { settings: { registrationOpen: true } } });
  r = await call('POST', '/api/auth/register-individual', { body: { fullName: 'Late', email: `late${RUN}@example.com`, password: 'secret12', institutionType: 'OTHER' } });
  check('sign-up works again when reopened', r.status === 200, r);

  await call('PUT', '/api/super/settings', { token: SUPER, body: { settings: { subscriptionEnforced: 'on' } } });
  r = await call('POST', '/api/research-assistant/ask', { token: stu, body: { question: 'hi' } });
  check('paywall "on" overrides the environment: a student without a plan gets 402', r.status === 402, r);
  await call('PUT', '/api/super/settings', { token: SUPER, body: { settings: { subscriptionEnforced: 'off' } } });
  r = await call('POST', '/api/research-assistant/ask', { token: stu, body: { question: 'hi' } });
  check('paywall "off" lets the request through to the AI layer', r.status !== 402, r.status);

  await call('PUT', '/api/super/settings', { token: SUPER, body: { settings: { aiEnabled: false } } });
  r = await call('POST', '/api/research-assistant/ask', { token: stu, body: { question: 'hi' } });
  check('AI kill switch -> 503 AI_DISABLED', r.status === 503 && r.data.code === 'AI_DISABLED', r);
  await call('PUT', '/api/super/settings', { token: SUPER, body: { settings: { aiEnabled: true, aiQuestionsPerDay: 1 } } });
  await prisma.aiConversationLog.create({ data: { userId: (await call('GET', '/api/auth/me', { token: stu })).data.user.id, kind: 'RESEARCH', question: 'q', answer: 'a' } });
  r = await call('POST', '/api/research-assistant/ask', { token: stu, body: { question: 'hi' } });
  check('daily AI question limit -> 429', r.status === 429 && r.data.code === 'AI_DAILY_LIMIT', r);
  await call('PUT', '/api/super/settings', { token: SUPER, body: { settings: { aiQuestionsPerDay: 0, subscriptionEnforced: 'env' } } });

  r = await call('PUT', '/api/super/settings', { token: SUPER, body: { settings: { maintenanceMode: true, maintenanceMessage: 'Back soon ' + RUN } } });
  r = await call('GET', '/api/auth/me', { token: stu });
  check('maintenance mode -> 503 with the message', r.status === 503 && r.data.error === 'Back soon ' + RUN && r.data.code === 'MAINTENANCE', r);
  r = await call('GET', '/api/super/me', { token: SUPER });
  check('...but the owner still gets in', r.status === 200);
  await call('PUT', '/api/super/settings', { token: SUPER, body: { settings: { maintenanceMode: false } } });
  r = await call('GET', '/api/auth/me', { token: stu });
  check('and normal service resumes', r.status === 200, r.status);
  r = await call('PUT', '/api/super/settings', { token: SUPER, body: { settings: { bogusKey: 1, aiQuestionsPerDay: -5 } } });
  check('unknown keys ignored, numbers clamped', r.status === 200 && r.data.settings.find((s) => s.key === 'aiQuestionsPerDay').value === 0, r.data.settings.find((s) => s.key === 'aiQuestionsPerDay'));
  r = await call('GET', '/api/super/audit-logs', { token: SUPER });
  check('settings changes are audited', r.data.logs.some((l) => l.action === 'SETTINGS_CHANGED') && r.data.logs.some((l) => l.action === 'SUBSCRIPTION_GRANTED') && r.data.logs.some((l) => l.action === 'ANNOUNCEMENT_SENT'));

  console.log('== platform e-Library ==');
  let form = new FormData();
  form.append('title', 'Platform Physics ' + RUN);
  form.append('author', 'A. Newton');
  form.append('type', 'Textbook');
  form.append('file', new Blob(['%PDF-1.4 fake'], { type: 'application/pdf' }), 'physics.pdf');
  r = await call('POST', '/api/super/library', { token: SUPER, form });
  check('owner uploads a platform book', r.status === 200 && r.data.item.schoolId === null, r);
  const bookId = r.data.item.id;
  const titles = async (t) => ((await call('GET', '/api/library', { token: t })).data.items || []).map((i) => i.title);
  check('a school student sees it', (await titles(stu)).includes('Platform Physics ' + RUN));
  check('an independent student sees it', (await titles(indie)).includes('Platform Physics ' + RUN));
  form = new FormData();
  form.append('title', 'x');
  r = await call('POST', '/api/super/library', { token: SUPER, form });
  check('upload without a file/author refused', r.status === 400, r);
  r = await call('GET', '/api/super/library?scope=platform&search=Platform%20Physics', { token: SUPER });
  check('listed in the panel', r.data.items.some((i) => i.id === bookId));
  r = await call('DELETE', '/api/super/library/' + bookId, { token: SUPER });
  check('removed', r.status === 200);
  check('...and gone for students', !(await titles(stu)).includes('Platform Physics ' + RUN));

  console.log('== live classes + gamification views ==');
  r = await call('GET', '/api/super/live-classes', { token: SUPER });
  check('live classes overview loads', r.status === 200 && typeof r.data.liveNow === 'number', r);
  r = await call('GET', '/api/super/gamification', { token: SUPER });
  check('gamification overview loads', r.status === 200 && Array.isArray(r.data.badges), r);

  await prisma.payment.deleteMany({ where: { reference: 'plat_' + RUN } });
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('TEST CRASHED', e); await prisma.$disconnect(); process.exit(2); });
