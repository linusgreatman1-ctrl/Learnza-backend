const express = require('express');
const crypto = require('crypto');
const prisma = require('../db');
const { requireAuth, requireRole } = require('../auth');
const fees = require('../services/fees.service');
const { notify, notifySchoolAdmins } = require('../services/notification.service');
const { uniqueReceiptNo, settleOnline } = require('../services/feeSettlement');
const flutterwave = require('../services/flutterwave.service');
const paystack = require('../services/paystack.service');
const { flutterwavePublicKey } = require('../config/payments');

// School fees. A student sees the fees for their level and department, the school's own bank
// details (only the students of THAT school ever get them) and what is paid and owing. They pay by card,
// USSD or bank transfer through the payment window (confirmed automatically, with a receipt) or by
// transferring to the school's account and telling the school (the school confirms). The school admin
// sets the bank details and fees, confirms or rejects, records cash, and sees who has paid. The
// platform owner can only look (routes/superInsights.js).
const router = express.Router();
router.use(requireAuth);

const PAGE = 30;
const PROVIDERS = ['FLUTTERWAVE', 'PAYSTACK'];
const INTERNAL = /@internal\.learnza\.local$/;
const payerEmail = (u) => (u.email && !INTERNAL.test(u.email) ? u.email : process.env.PAY_FALLBACK_EMAIL || 'payments@learnza.app');
// Where Paystack sends the browser back to: the page the payment started from, on this site only.
function returnUrl(req) {
  const origin = `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}`;
  try {
    const u = new URL(String((req.body && req.body.returnUrl) || ''), origin);
    if (u.host === req.get('host')) return u.origin + u.pathname;
  } catch { /* fall through */ }
  return origin + '/schools';
}

const STUDENT_SELECT = { id: true, fullName: true, email: true, role: true, schoolId: true, departmentId: true, yearOfStudy: true, matricNumber: true, department: { select: { id: true, name: true } } };
const studentRow = (id) => prisma.user.findUnique({ where: { id }, select: STUDENT_SELECT });

function presentPayment(p) {
  return {
    id: p.id, status: p.status, amountKobo: p.amountKobo, method: p.method, provider: p.provider || null, reference: p.reference, depositorName: p.depositorName,
    paidOn: p.paidOn, note: p.note, items: fees.itemsOf(p), receiptNo: p.receiptNo, rejectReason: p.rejectReason,
    hasProof: !!p.proofUrl, submittedByType: p.submittedByType, createdAt: p.createdAt, reviewedAt: p.reviewedAt,
  };
}

function onlineOptions() {
  return { flutterwave: !!flutterwavePublicKey(), flutterwavePublicKey: flutterwavePublicKey() || null, paystack: paystack.isConfigured() };
}

// Everything a student sees. Bank details go to people of THIS school only.
async function studentView(student) {
  if (!student || !student.schoolId) return { error: 'School fees belong to an institution. Your account is not linked to one.', status: 404 };
  const [school, bank, feeRows, rows] = await Promise.all([
    prisma.school.findUnique({ where: { id: student.schoolId }, select: { id: true, name: true } }),
    prisma.schoolBankAccount.findUnique({ where: { schoolId: student.schoolId } }),
    prisma.schoolFee.findMany({ where: { schoolId: student.schoolId, active: true }, orderBy: [{ category: 'asc' }, { createdAt: 'asc' }] }),
    prisma.feePayment.findMany({ where: { studentId: student.id, status: { not: 'AWAITING_PAYMENT' } }, orderBy: { createdAt: 'desc' }, take: 60 }),
  ]);
  const led = fees.ledger(feeRows, rows, student);
  return {
    school, student: { id: student.id, name: student.fullName, matricNumber: student.matricNumber || null, department: student.department ? student.department.name : null, level: fees.levelLabel(student.yearOfStudy) },
    bank: bank ? { bankName: bank.bankName, accountName: bank.accountName, accountNumber: bank.accountNumber, instructions: bank.instructions } : null,
    online: onlineOptions(), categories: fees.CATEGORIES, fees: led.fees, totals: led.totals, payments: rows.map(presentPayment),
  };
}

async function ledgerFor(student) {
  const [feeRows, confirmed] = await Promise.all([
    prisma.schoolFee.findMany({ where: { schoolId: student.schoolId, active: true } }),
    prisma.feePayment.findMany({ where: { studentId: student.id, status: 'CONFIRMED' } }),
  ]);
  return fees.ledger(feeRows, confirmed, student);
}

const isSchoolStudent = (u) => u.role === 'STUDENT' && !!u.schoolId;
function notStudent(res) { res.status(403).json({ error: 'This page is for students of an institution.' }); }

// ---- the student ---------------------------------------------------------------------------
async function mine(req, res) {
  if (!isSchoolStudent(req.user)) return notStudent(res);
  const out = await studentView(await studentRow(req.user.id));
  if (out.error) return res.status(out.status).json({ error: out.error });
  res.json(out);
}

// "I have paid by transfer": waits for the school to confirm.
async function pay(req, res) {
  if (!isSchoolStudent(req.user)) return notStudent(res);
  const student = await studentRow(req.user.id);
  const led = await ledgerFor(student);
  const items = fees.buildItems(req.body.items, led.fees);
  if (items.error) return res.status(400).json({ error: items.error });
  const details = fees.paymentDetails(req.body || {}, { requireReference: true });
  if (details.error) return res.status(400).json({ error: details.error });
  const row = await prisma.feePayment.create({
    data: { schoolId: student.schoolId, studentId: student.id, submittedByType: 'STUDENT', submittedById: student.id, status: 'PENDING', amountKobo: items.totalKobo, items: items.items, ...details.data },
  });
  await notifySchoolAdmins(student.schoolId, 'Fee payment to confirm', student.fullName + ' paid ' + fees.naira(items.totalKobo) + ' (' + items.items.map((i) => i.title).join(', ').slice(0, 120) + ').', 'admin-fees').catch(() => {});
  res.status(201).json({ payment: presentPayment(row) });
}

// Card / USSD / bank transfer through the gateway: priced here, never from the browser. Until the gateway
// confirms, the row is AWAITING_PAYMENT: the school never sees it and the balance does not change.
async function payOnline(req, res) {
  if (!isSchoolStudent(req.user)) return notStudent(res);
  const provider = String((req.body && req.body.provider) || '');
  if (!PROVIDERS.includes(provider)) return res.status(400).json({ error: 'Choose Flutterwave or Paystack.' });
  if (provider === 'PAYSTACK' && !paystack.isConfigured()) return res.status(503).json({ error: 'Paystack is not set up yet. Please choose another way to pay.' });
  const student = await studentRow(req.user.id);
  const led = await ledgerFor(student);
  const items = fees.buildItems(req.body.items, led.fees);
  if (items.error) return res.status(400).json({ error: items.error });
  const reference = 'LZ-FEE-' + Date.now() + '-' + crypto.randomBytes(5).toString('hex');
  let authorizationUrl;
  if (provider === 'PAYSTACK') {
    try {
      const init = await paystack.initializeTransaction({ email: payerEmail(req.user), amountKobo: items.totalKobo, reference, callbackUrl: returnUrl(req), metadata: { userId: student.id, kind: 'school-fees' } });
      authorizationUrl = init.authorization_url;
    } catch (err) { return res.status(502).json({ error: 'Could not reach Paystack: ' + err.message }); }
  }
  const row = await prisma.feePayment.create({
    data: { schoolId: student.schoolId, studentId: student.id, submittedByType: 'STUDENT', submittedById: student.id, status: 'AWAITING_PAYMENT', method: 'ONLINE', provider, reference, amountKobo: items.totalKobo, items: items.items },
  });
  res.status(201).json({ reference, authorizationUrl, amountKobo: row.amountKobo, amount: row.amountKobo / 100, email: payerEmail(req.user), name: student.fullName, provider });
}

// Called when the gateway's window reports success (completed = '1') and again while it waits. If the
// gateway confirms, the payment is confirmed on the spot. If it cannot be checked (the gateway is slow,
// or there is no key for it yet) a payment the student says went through is handed to the school as a
// normal "to confirm" payment, so nobody is left having paid with nothing to show for it.
async function verifyOnline(req, res) {
  if (!isSchoolStudent(req.user)) return notStudent(res);
  const student = await studentRow(req.user.id);
  const p = await prisma.feePayment.findFirst({ where: { reference: String(req.params.reference), method: 'ONLINE', studentId: student.id } });
  if (!p) return res.status(404).json({ error: 'Payment not found.' });
  if (p.status === 'CONFIRMED') return res.json({ status: 'CONFIRMED', receiptNo: p.receiptNo });
  if (p.status === 'REJECTED') return res.json({ status: 'REJECTED' });
  const checked = await verifyWithGateway(p.provider, p.reference);
  if (checked.ok) {
    const done = await settleOnline(p.reference, checked.amountKobo);
    if (done.ok) return res.json({ status: 'CONFIRMED', receiptNo: done.payment.receiptNo });
  }
  if (req.query.completed === '1' && p.status === 'AWAITING_PAYMENT') {
    const flipped = await prisma.feePayment.updateMany({ where: { id: p.id, status: 'AWAITING_PAYMENT' }, data: { status: 'PENDING', note: 'Paid online with ' + (p.provider === 'PAYSTACK' ? 'Paystack' : 'Flutterwave') + '. Learnza could not check it automatically yet, please confirm it from your bank or gateway statement.' } });
    if (flipped.count === 1) await notifySchoolAdmins(p.schoolId, 'Online fee payment to confirm', student.fullName + ' paid ' + fees.naira(p.amountKobo) + ' online (' + p.reference + ').', 'admin-fees').catch(() => {});
    return res.json({ status: 'PENDING' });
  }
  res.json({ status: p.status });
}
const verifyWithGateway = (provider, reference) => (provider === 'PAYSTACK' ? paystack.verifyByReference(reference) : flutterwave.verifyByReference(reference));

function categories(req, res) { res.json({ categories: fees.CATEGORIES, levels: fees.LEVELS.map((y) => ({ year: y, label: y * 100 + 'L' })) }); }

// ---- the school admin ----------------------------------------------------------------------
const admin = [requireRole('ADMIN')];
function needSchool(req, res, next) {
  if (!req.user.schoolId) return res.status(404).json({ error: 'This account is not linked to an institution.' });
  next();
}

async function getBank(req, res) {
  const bank = await prisma.schoolBankAccount.findUnique({ where: { schoolId: req.user.schoolId } });
  res.json({ bank: bank ? { bankName: bank.bankName, accountName: bank.accountName, accountNumber: bank.accountNumber, instructions: bank.instructions, updatedAt: bank.updatedAt } : null });
}

async function saveBank(req, res) {
  const v = fees.bankDetails(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  const bank = await prisma.schoolBankAccount.upsert({ where: { schoolId: req.user.schoolId }, create: { schoolId: req.user.schoolId, ...v.data }, update: v.data });
  res.json({ bank: { bankName: bank.bankName, accountName: bank.accountName, accountNumber: bank.accountNumber, instructions: bank.instructions } });
}

async function listFees(req, res) {
  const [rows, departments] = await Promise.all([
    prisma.schoolFee.findMany({ where: { schoolId: req.user.schoolId }, orderBy: [{ active: 'desc' }, { category: 'asc' }, { createdAt: 'asc' }] }),
    prisma.department.findMany({ where: { schoolId: req.user.schoolId }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
  ]);
  res.json({
    fees: rows.map((f) => ({ id: f.id, title: f.title, category: f.category, description: f.description, amountKobo: f.amountKobo, session: f.session, semester: f.semester, levels: f.levels, departmentId: f.departmentId, dueDate: f.dueDate, active: f.active })),
    categories: fees.CATEGORIES, levels: fees.LEVELS.map((y) => ({ year: y, label: y * 100 + 'L' })), departments,
  });
}

// A fee can be limited to one department of the school, never to another school's.
async function departmentOk(req, data) {
  if (!data.departmentId) return true;
  const d = await prisma.department.findFirst({ where: { id: data.departmentId, schoolId: req.user.schoolId } });
  return !!d;
}

async function createFee(req, res) {
  const v = fees.feeDetails(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  if (!(await departmentOk(req, v.data))) return res.status(400).json({ error: 'That department is not in your institution.' });
  const row = await prisma.schoolFee.create({ data: { schoolId: req.user.schoolId, ...v.data } });
  res.status(201).json({ fee: row });
}

async function updateFee(req, res) {
  const cur = await prisma.schoolFee.findUnique({ where: { id: req.params.id } });
  if (!cur || cur.schoolId !== req.user.schoolId) return res.status(404).json({ error: 'Fee not found.' });
  const v = fees.feeDetails({ ...cur, ...(req.body || {}) });
  if (v.error) return res.status(400).json({ error: v.error });
  if (!(await departmentOk(req, v.data))) return res.status(400).json({ error: 'That department is not in your institution.' });
  const row = await prisma.schoolFee.update({ where: { id: cur.id }, data: v.data });
  res.json({ fee: row });
}

async function deleteFee(req, res) {
  const cur = await prisma.schoolFee.findUnique({ where: { id: req.params.id } });
  if (!cur || cur.schoolId !== req.user.schoolId) return res.status(404).json({ error: 'Fee not found.' });
  await prisma.schoolFee.delete({ where: { id: cur.id } });       // payments keep the fee's name, so history is not lost
  res.json({ ok: true });
}

const STUDENT_INCLUDE = { select: { id: true, fullName: true, matricNumber: true, yearOfStudy: true, department: { select: { name: true } } } };
const who = (s) => ({ studentId: s.id, studentName: s.fullName, matricNumber: s.matricNumber || null, department: s.department ? s.department.name : null, level: fees.levelLabel(s.yearOfStudy) });

async function listPayments(req, res) {
  const status = ['PENDING', 'CONFIRMED', 'REJECTED'].includes(req.query.status) ? req.query.status : undefined;
  const q = fees.clean(req.query.q, 60);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const where = { schoolId: req.user.schoolId, ...(status ? { status } : { status: { not: 'AWAITING_PAYMENT' } }), ...(q ? { student: { fullName: { contains: q, mode: 'insensitive' } } } : {}) };
  const [rows, total, pending] = await Promise.all([
    prisma.feePayment.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * PAGE, take: PAGE, include: { student: STUDENT_INCLUDE } }),
    prisma.feePayment.count({ where }),
    prisma.feePayment.count({ where: { schoolId: req.user.schoolId, status: 'PENDING' } }),
  ]);
  res.json({ total, page, pageSize: PAGE, pending, payments: rows.map((p) => ({ ...presentPayment(p), ...who(p.student) })) });
}

async function paymentDetail(req, res) {
  const p = await prisma.feePayment.findUnique({ where: { id: req.params.id }, include: { student: STUDENT_INCLUDE } });
  if (!p || p.schoolId !== req.user.schoolId) return res.status(404).json({ error: 'Payment not found.' });
  res.json({ payment: { ...presentPayment(p), proofUrl: p.proofUrl, ...who(p.student) } });
}

async function review(req, res, confirm) {
  const p = await prisma.feePayment.findUnique({ where: { id: req.params.id }, include: { student: { select: { id: true, fullName: true } } } });
  if (!p || p.schoolId !== req.user.schoolId) return res.status(404).json({ error: 'Payment not found.' });
  if (p.status !== 'PENDING') return res.status(409).json({ error: 'This payment has already been ' + p.status.toLowerCase() + '.' });
  const reason = fees.clean(req.body && req.body.reason, 200);
  if (!confirm && !reason) return res.status(400).json({ error: 'Say why it is being rejected, so the student knows what to do.' });
  const receiptNo = confirm ? await uniqueReceiptNo() : null;
  const row = await prisma.feePayment.update({
    where: { id: p.id },
    data: confirm ? { status: 'CONFIRMED', receiptNo, reviewedById: req.user.id, reviewedAt: new Date(), rejectReason: null } : { status: 'REJECTED', rejectReason: reason, reviewedById: req.user.id, reviewedAt: new Date() },
  });
  await notify(p.student.id, confirm ? 'Fee payment confirmed' : 'Fee payment not accepted',
    confirm ? 'The school confirmed ' + fees.naira(p.amountKobo) + ' (receipt ' + receiptNo + ').' : 'The school could not confirm ' + fees.naira(p.amountKobo) + ': ' + reason, 'fees').catch(() => {});
  res.json({ payment: presentPayment(row) });
}
const confirmPayment = (req, res) => review(req, res, true);
const rejectPayment = (req, res) => review(req, res, false);

// The bursary records a payment itself (cash at the bursar's, a transfer seen in the bank statement): confirmed at once.
async function recordPayment(req, res) {
  const student = await studentRow(String((req.body && req.body.studentId) || ''));
  if (!student || student.schoolId !== req.user.schoolId || student.role !== 'STUDENT') return res.status(404).json({ error: 'That student is not in your institution.' });
  const led = await ledgerFor(student);
  const items = fees.buildItems(req.body.items, led.fees);
  if (items.error) return res.status(400).json({ error: items.error });
  const details = fees.paymentDetails(req.body, { requireReference: false });
  if (details.error) return res.status(400).json({ error: details.error });
  const receiptNo = await uniqueReceiptNo();
  const row = await prisma.feePayment.create({
    data: { schoolId: student.schoolId, studentId: student.id, submittedByType: 'SCHOOL', submittedById: req.user.id, status: 'CONFIRMED', amountKobo: items.totalKobo, items: items.items, receiptNo, reviewedById: req.user.id, reviewedAt: new Date(), ...details.data, paidOn: details.data.paidOn || new Date() },
  });
  await notify(student.id, 'Fee payment recorded', 'The school recorded ' + fees.naira(items.totalKobo) + ' for you (receipt ' + receiptNo + ').', 'fees').catch(() => {});
  res.status(201).json({ payment: presentPayment(row) });
}

// Who owes what, and the school's totals.
async function ledgers(schoolId, { q } = {}) {
  const [students, feeRows, rows] = await Promise.all([
    prisma.user.findMany({
      where: { schoolId, role: 'STUDENT', status: 'ACTIVE', ...(q ? { fullName: { contains: q, mode: 'insensitive' } } : {}) },
      orderBy: { fullName: 'asc' }, take: 2000, select: { id: true, fullName: true, matricNumber: true, yearOfStudy: true, departmentId: true, department: { select: { name: true } } },
    }),
    prisma.schoolFee.findMany({ where: { schoolId, active: true } }),
    prisma.feePayment.findMany({ where: { schoolId, status: { in: ['CONFIRMED', 'PENDING'] } }, select: { studentId: true, status: true, items: true } }),
  ]);
  const byStudent = new Map();
  rows.forEach((p) => { if (!byStudent.has(p.studentId)) byStudent.set(p.studentId, []); byStudent.get(p.studentId).push(p); });
  return students.map((s) => {
    const led = fees.ledger(feeRows, byStudent.get(s.id) || [], s);
    const t = led.totals;
    const status = !led.fees.length ? 'NO_FEES' : t.balanceKobo === 0 ? 'PAID' : t.paidKobo > 0 ? 'PARTIAL' : 'UNPAID';
    return { id: s.id, name: s.fullName, matricNumber: s.matricNumber || null, department: s.department ? s.department.name : null, level: fees.levelLabel(s.yearOfStudy), ...t, status };
  });
}

async function students(req, res) {
  res.json({ students: await ledgers(req.user.schoolId, { q: fees.clean(req.query.q, 60) }) });
}

async function overview(req, res) {
  const [list, bank, pending, feeCount, confirmedAgg] = await Promise.all([
    ledgers(req.user.schoolId),
    prisma.schoolBankAccount.findUnique({ where: { schoolId: req.user.schoolId }, select: { id: true } }),
    prisma.feePayment.count({ where: { schoolId: req.user.schoolId, status: 'PENDING' } }),
    prisma.schoolFee.count({ where: { schoolId: req.user.schoolId, active: true } }),
    prisma.feePayment.aggregate({ where: { schoolId: req.user.schoolId, status: 'CONFIRMED' }, _sum: { amountKobo: true } }),
  ]);
  const byDept = new Map();
  list.forEach((s) => {
    const key = s.department || 'No department';
    if (!byDept.has(key)) byDept.set(key, { department: key, students: 0, dueKobo: 0, paidKobo: 0, balanceKobo: 0 });
    const c = byDept.get(key); c.students += 1; c.dueKobo += s.dueKobo; c.paidKobo += s.paidKobo; c.balanceKobo += s.balanceKobo;
  });
  res.json({
    hasBank: !!bank, feeCount, pendingPayments: pending,
    totals: { dueKobo: list.reduce((a, s) => a + s.dueKobo, 0), collectedKobo: (confirmedAgg._sum && confirmedAgg._sum.amountKobo) || 0, balanceKobo: list.reduce((a, s) => a + s.balanceKobo, 0) },
    students: { total: list.length, paid: list.filter((s) => s.status === 'PAID').length, partial: list.filter((s) => s.status === 'PARTIAL').length, unpaid: list.filter((s) => s.status === 'UNPAID').length },
    byDepartment: Array.from(byDept.values()),
  });
}

// One student's fees as the school sees them (used to record a payment for them).
async function studentLedger(req, res) {
  const row = await studentRow(req.params.id);
  if (!row || row.schoolId !== req.user.schoolId || row.role !== 'STUDENT') return res.status(404).json({ error: 'That student is not in your institution.' });
  const out = await studentView(row);
  if (out.error) return res.status(out.status).json({ error: out.error });
  delete out.bank; delete out.online;
  res.json(out);
}

// the student
router.get('/categories', categories);
router.get('/mine', mine);
router.post('/pay', pay);
router.post('/online/initiate', payOnline);
router.get('/online/verify/:reference', verifyOnline);

// the school admin: the school's own money, nobody else's
router.get('/admin/overview', ...admin, needSchool, overview);
router.get('/admin/bank', ...admin, needSchool, getBank);
router.put('/admin/bank', ...admin, needSchool, saveBank);
router.get('/admin/fees', ...admin, needSchool, listFees);
router.post('/admin/fees', ...admin, needSchool, createFee);
router.patch('/admin/fees/:id', ...admin, needSchool, updateFee);
router.delete('/admin/fees/:id', ...admin, needSchool, deleteFee);
router.get('/admin/payments', ...admin, needSchool, listPayments);
router.get('/admin/payments/:id', ...admin, needSchool, paymentDetail);
router.post('/admin/payments/:id/confirm', ...admin, needSchool, confirmPayment);
router.post('/admin/payments/:id/reject', ...admin, needSchool, rejectPayment);
router.post('/admin/record', ...admin, needSchool, recordPayment);
router.get('/admin/students', ...admin, needSchool, students);
router.get('/admin/students/:id', ...admin, needSchool, studentLedger);

// For the tests, and for the owner's read-only pages (routes/superInsights.js).
router.handlers = { mine, pay, payOnline, verifyOnline, categories, getBank, saveBank, listFees, createFee, updateFee, deleteFee, listPayments, paymentDetail, confirmPayment, rejectPayment, recordPayment, students, overview, studentLedger };
router.helpers = { presentPayment, settleOnline };

module.exports = router;
