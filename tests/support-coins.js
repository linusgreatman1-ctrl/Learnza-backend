// Phase 4: support tickets, live chat, reviews, coins, group polls + read receipts.
//
//   DATABASE_URL=... JWT_SECRET=... SUPER_EMAIL=... SUPER_PASSWORD=... node tests/support-coins.js
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
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let r = await call('POST', '/api/super/login', { body: { email: process.env.SUPER_EMAIL, password: process.env.SUPER_PASSWORD } });
  const SUPER = r.data.token;

  const name = 'Support Test ' + RUN;
  r = await call('POST', '/api/super/schools', { token: SUPER, body: { name } });
  r = await call('POST', '/api/auth/school-login', { body: { schoolName: name, joinCode: r.data.joinCode } });
  const admin = r.data.token;
  r = await call('POST', '/api/admin/departments', { token: admin, body: { name: 'Law', code: 'LAW' } });
  const dept = r.data.department;
  r = await call('POST', '/api/admin/courses', { token: admin, body: { departmentId: dept.id, code: 'LAW101', title: 'Intro Law' } });
  const course = r.data.course;
  const mk = async (n, matric) => {
    const c = await call('POST', '/api/admin/students', { token: admin, body: { fullName: n, matricNumber: matric, departmentId: dept.id, courseIds: [course.id] } });
    const l = await call('POST', '/api/auth/login-with-code', { body: { fullName: n, schoolName: name, accessCode: c.data.accessCode } });
    return { token: l.data.token, id: c.data.user.id };
  };
  const s1 = await mk('Amaka One', 'L/1');
  const s2 = await mk('Bayo Two', 'L/2');
  const email = `sup${RUN}@example.com`;
  r = await call('POST', '/api/auth/register-individual', { body: { fullName: 'Indie Sup', email, password: 'secret12', institutionType: 'OTHER' } });
  const indie = { token: r.data.token, id: r.data.user.id };

  console.log('== tickets ==');
  r = await call('POST', '/api/support/tickets', { token: s1.token, body: { subject: '', body: 'x' } });
  check('ticket needs a subject', r.status === 400);
  r = await call('POST', '/api/support/tickets', { token: s1.token, body: { subject: 'Cannot see results', body: 'My results are blank', category: 'BUG' } });
  check('open a ticket', r.status === 200 && r.data.ticket.status === 'OPEN', r);
  const ticketId = r.data.ticket.id;
  r = await call('GET', `/api/support/tickets/${ticketId}`, { token: s2.token });
  check("another user cannot read someone's ticket", r.status === 404);
  r = await call('GET', '/api/support/tickets', { token: s1.token });
  check('I can list my tickets', r.data.tickets.length === 1 && r.data.tickets[0].lastMessage);
  r = await call('GET', '/api/super/tickets?status=OPEN', { token: SUPER });
  check('owner sees it in the OPEN queue', r.data.tickets.some((t) => t.id === ticketId) && r.data.open >= 1);
  r = await call('GET', '/api/support/tickets', { token: admin });
  check('a school admin can use support too', r.status === 200);
  r = await call('GET', '/api/support/tickets', { token: SUPER });
  check('super admin is told to use the panel', r.status === 403);
  r = await call('POST', `/api/super/tickets/${ticketId}/reply`, { token: SUPER, body: { body: 'We are looking into it.' } });
  check('owner replies', r.status === 200);
  r = await call('GET', `/api/support/tickets/${ticketId}`, { token: s1.token });
  check('user sees the reply, status ANSWERED', r.data.ticket.status === 'ANSWERED' && r.data.ticket.messages.length === 2 && r.data.ticket.messages[1].fromStaff === true, r.data.ticket);
  r = await call('GET', '/api/notifications', { token: s1.token });
  check('user was notified', r.data.notifications.some((n) => n.title === 'Learnza support replied' && n.link === 'support'));
  r = await call('POST', `/api/support/tickets/${ticketId}/messages`, { token: s1.token, body: { body: 'Thanks, still blank' } });
  r = await call('GET', `/api/support/tickets/${ticketId}`, { token: s1.token });
  check('user reply reopens it', r.data.ticket.status === 'OPEN');
  await call('POST', `/api/super/tickets/${ticketId}/reply`, { token: SUPER, body: { body: 'Fixed!', close: true } });
  r = await call('POST', `/api/support/tickets/${ticketId}/messages`, { token: s1.token, body: { body: 'more' } });
  check('cannot add to a closed ticket', r.status === 409);

  console.log('== live chat ==');
  r = await call('POST', '/api/support/chat', { token: s2.token, body: { body: 'Hello, how do I join a class?' } });
  check('send a chat message', r.status === 200);
  await sleep(1500);
  r = await call('GET', '/api/support/chat', { token: s2.token });
  check('the assistant (or fallback) answers while no person has joined', r.data.messages.length === 2 && r.data.messages[1].sender === 'AI' && r.data.withTeam === false, r.data);
  r = await call('GET', '/api/super/chat/threads', { token: SUPER });
  const thread = r.data.threads.find((t) => t.user.fullName === 'Bayo Two');
  check('owner sees the thread with an unread count', thread && thread.unreadForAdmin === 1, thread && thread.unreadForAdmin);
  r = await call('GET', `/api/super/chat/threads/${thread.id}`, { token: SUPER });
  check('opening it shows the conversation and clears the badge', r.data.thread.messages.length === 2);
  r = await call('POST', `/api/super/chat/threads/${thread.id}/reply`, { token: SUPER, body: { body: 'Hi Bayo, a person here.' } });
  check('owner replies in chat', r.status === 200);
  r = await call('POST', '/api/support/chat', { token: s2.token, body: { body: 'Thanks!' } });
  await sleep(1200);
  r = await call('GET', '/api/support/chat', { token: s2.token });
  check('once a person has joined the AI stays quiet', r.data.withTeam === true && r.data.messages.length === 4 && r.data.messages[3].sender === 'USER', r.data.messages.map((m) => m.sender));
  r = await call('GET', `/api/support/chat?after=${encodeURIComponent(r.data.messages[2].createdAt)}`, { token: s2.token });
  check('polling with ?after returns only new messages', r.data.messages.length === 1);
  await call('POST', `/api/super/chat/threads/${thread.id}/release`, { token: SUPER });
  r = await call('GET', '/api/support/chat', { token: s2.token });
  check('handing the chat back to the assistant', r.data.withTeam === false);

  console.log('== reviews ==');
  r = await call('PUT', '/api/support/review', { token: s1.token, body: { rating: 9 } });
  check('rating must be 1-5', r.status === 400);
  await call('PUT', '/api/support/review', { token: s1.token, body: { rating: 4, comment: 'Good' } });
  await call('PUT', '/api/support/review', { token: s1.token, body: { rating: 5, comment: 'Great' } });
  await call('PUT', '/api/support/review', { token: s2.token, body: { rating: 3 } });
  r = await call('GET', '/api/support/review', { token: s1.token });
  check('editing replaces my review', r.data.review.rating === 5);
  r = await call('GET', '/api/super/reviews', { token: SUPER });
  check('owner sees average + distribution', r.data.total >= 2 && r.data.average > 0 && r.data.distribution[5] >= 1, r.data);

  console.log('== coins ==');
  r = await call('GET', '/api/coins', { token: indie.token });
  check('wallet starts empty with two packs', r.status === 200 && r.data.balance === 0 && r.data.packs.length === 2 && r.data.packs[0].amountKobo === 250000, r.data);
  r = await call('GET', '/api/coins', { token: admin });
  check('only students have wallets', r.status === 403);
  r = await call('POST', '/api/coins/checkout', { token: indie.token, body: { packId: 'NOPE', provider: 'paystack' } });
  check('bad pack refused', r.status === 400);
  r = await call('POST', '/api/super/coins/grant', { token: SUPER, body: { email, coins: 2, note: 'test' } });
  check('owner grants 2 coins', r.status === 200 && r.data.balance === 2, r);
  r = await call('GET', '/api/coins', { token: indie.token });
  check('wallet shows 10 minutes', r.data.balance === 2 && r.data.minutesLeft === 10 && r.data.ledger[0].reason === 'GRANT', r.data);

  const coins = require('../src/services/coins.service');
  let used = await coins.spendSeconds(indie.id, 120);
  let w = await coins.getWallet(indie.id);
  check('2 minutes spend part of one coin', used === 120 && w.balance === 1 && w.aiSecondsCredit === 180, w);
  used = await coins.spendSeconds(indie.id, 600);
  w = await coins.getWallet(indie.id);
  check('spending more than the wallet holds drains it and reports what was covered', used === 480 && w.balance === 0 && w.aiSecondsCredit === 0, { used, w });
  used = await coins.spendSeconds(indie.id, 60);
  check('an empty wallet covers nothing', used === 0);
  const ledger = await prisma.coinLedger.findMany({ where: { userId: indie.id }, orderBy: { createdAt: 'asc' } });
  check('ledger is consistent (credits minus spends = 0)', ledger.reduce((a, e) => a + e.delta, 0) === 0 && ledger.every((e) => e.balanceAfter >= 0), ledger.map((e) => [e.delta, e.balanceAfter]));

  const purchase = await prisma.coinPurchase.create({ data: { userId: indie.id, coins: 30, amountKobo: 250000, provider: 'PAYSTACK', reference: 'coinref_' + RUN, status: 'PENDING' } });
  const [a, b] = await Promise.all([coins.completePurchase(purchase), coins.completePurchase(purchase)]);
  w = await coins.getWallet(indie.id);
  check('a purchase confirmed twice (webhook + redirect) credits exactly once', [a, b].filter(Boolean).length === 1 && w.balance === 30, { a, b, balance: w.balance });
  r = await call('GET', '/api/super/coins/purchases', { token: SUPER });
  check('owner sees purchase + revenue', r.data.purchases.some((p) => p.reference === 'coinref_' + RUN && p.status === 'SUCCESS') && r.data.summary.coinsSold >= 30);
  r = await call('POST', '/api/super/coins/grant', { token: SUPER, body: { email, coins: 0 } });
  check('grant needs a positive amount', r.status === 400);

  // AI usage draws on the plan first, then coins
  const sub = require('../src/subscription');
  await prisma.subscription.create({ data: { userId: indie.id, plan: 'MONTHLY', status: 'ACTIVE', startedAt: new Date(), expiresAt: new Date(Date.now() + 86400000), aiSecondsGranted: 60, aiSecondsUsed: 0 } });
  await sub.recordAiUsage(indie.id, 100);
  const subRow = await prisma.subscription.findUnique({ where: { userId: indie.id } });
  w = await coins.getWallet(indie.id);
  check('AI usage uses the plan minutes first, then coins', subRow.aiSecondsUsed === 60 && w.balance === 29 && w.aiSecondsCredit === 260, { used: subRow.aiSecondsUsed, w });
  const status = await sub.getAiCreditStatus(indie.id);
  check('credit status counts coins, so a student with coins is not "exhausted"', status.exhausted === false && status.coinSeconds === 29 * 300 + 260, status);

  console.log('== group polls + read receipts ==');
  r = await call('POST', `/api/courses/${course.id}/groups`, { token: s1.token, body: { name: 'Revision' } });
  const group = r.data.group;
  await call('POST', `/api/groups/${group.id}/join`, { token: s2.token });
  r = await call('POST', `/api/groups/${group.id}/polls`, { token: s1.token, body: { question: 'Which day?', options: ['Mon'] } });
  check('a poll needs 2+ options', r.status === 400);
  r = await call('POST', `/api/groups/${group.id}/polls`, { token: s1.token, body: { question: 'Which day?', options: ['Mon', 'mon'] } });
  check('options must differ', r.status === 400);
  r = await call('POST', `/api/groups/${group.id}/polls`, { token: s1.token, body: { question: 'Which day?', options: ['Mon', 'Tue', 'Wed'] } });
  check('create a poll', r.status === 200 && r.data.poll.options.length === 3 && r.data.poll.mine === true, r);
  const pollId = r.data.poll.id;
  await call('POST', `/api/polls/${pollId}/vote`, { token: s1.token, body: { optionIdx: 0 } });
  r = await call('POST', `/api/polls/${pollId}/vote`, { token: s2.token, body: { optionIdx: 2 } });
  check('vote counts', r.data.poll.options[0].votes === 1 && r.data.poll.options[2].votes === 1 && r.data.poll.myVote === 2, r.data.poll);
  r = await call('POST', `/api/polls/${pollId}/vote`, { token: s2.token, body: { optionIdx: 1 } });
  check('changing a vote moves it (still one vote each)', r.data.poll.totalVotes === 2 && r.data.poll.options[2].votes === 0 && r.data.poll.options[1].votes === 1);
  r = await call('POST', `/api/polls/${pollId}/vote`, { token: indie.token, body: { optionIdx: 0 } });
  check('a non-member cannot vote', r.status === 404 || r.status === 403, r.status);
  r = await call('POST', `/api/polls/${pollId}/vote`, { token: s2.token, body: { optionIdx: 9 } });
  check('invalid option refused', r.status === 400);
  r = await call('POST', `/api/polls/${pollId}/close`, { token: s2.token });
  check('only the creator closes a poll', r.status === 403);
  await call('POST', `/api/polls/${pollId}/close`, { token: s1.token });
  r = await call('POST', `/api/polls/${pollId}/vote`, { token: s2.token, body: { optionIdx: 0 } });
  check('closed poll refuses votes', r.status === 409);
  r = await call('GET', `/api/groups/${group.id}/polls`, { token: s2.token });
  check('poll list shows closed + results', r.data.polls[0].closed === true && r.data.polls[0].totalVotes === 2);

  await call('POST', `/api/groups/${group.id}/messages`, { token: s1.token, body: { body: 'Hello group' } });
  r = await call('GET', `/api/groups/${group.id}/messages`, { token: s1.token });
  check('unread message: seenBy 0, memberCount 2', r.data.messages[0].seenBy === 0 && r.data.memberCount === 2, r.data);
  r = await call('POST', `/api/groups/${group.id}/read`, { token: s2.token });
  check('opening the chat marks it read', r.data.marked === 1);
  r = await call('POST', `/api/groups/${group.id}/read`, { token: s2.token });
  check('...only once', r.data.marked === 0);
  r = await call('GET', `/api/groups/${group.id}/messages`, { token: s1.token });
  check('sender now sees seenBy 1', r.data.messages[0].seenBy === 1);

  await prisma.subscription.deleteMany({ where: { userId: indie.id } });
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('TEST CRASHED', e); await prisma.$disconnect(); process.exit(2); });
