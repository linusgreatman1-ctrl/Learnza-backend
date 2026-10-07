// School fees for higher institutions: what a university, polytechnic, monotechnic or college of
// education can charge, what a student owes, and how a payment is checked. All money is in kobo
// (1 naira = 100 kobo).
const crypto = require('crypto');

// The fees Nigerian higher institutions typically collect: tuition / school fees, acceptance fee,
// course registration, matriculation, faculty and departmental dues, students' union (SUG) dues,
// ICT / portal, library, medical and health insurance, sports, ID card, laboratory / workshop,
// industrial training (SIWES / IT), teaching practice (colleges of education), project and thesis,
// examinations and resit, hostel, transcript and result verification, convocation and clearance.
// "OTHER" is the "Other fees" button: anything a school charges that is not on the list.
const CATEGORIES = [
  { id: 'TUITION', label: 'School fees / tuition', icon: '🎓' },
  { id: 'ACCEPTANCE', label: 'Acceptance fee', icon: '✅' },
  { id: 'REGISTRATION', label: 'Course / semester registration', icon: '📝' },
  { id: 'MATRICULATION', label: 'Matriculation & orientation', icon: '🎉' },
  { id: 'FACULTY_DUES', label: 'Faculty dues', icon: '🏛️' },
  { id: 'DEPARTMENTAL_DUES', label: 'Departmental dues', icon: '🏫' },
  { id: 'STUDENT_UNION', label: "Students' union (SUG) dues", icon: '🤝' },
  { id: 'ICT', label: 'ICT, portal & e-learning', icon: '💻' },
  { id: 'LIBRARY', label: 'Library', icon: '📚' },
  { id: 'MEDICAL', label: 'Medical, health insurance & security', icon: '🩺' },
  { id: 'SPORTS', label: 'Sports & recreation', icon: '⚽' },
  { id: 'ID_CARD', label: 'ID card', icon: '🪪' },
  { id: 'LABORATORY', label: 'Laboratory, workshop & practicals', icon: '🔬' },
  { id: 'INDUSTRIAL_TRAINING', label: 'Industrial training (SIWES / IT)', icon: '🏭' },
  { id: 'TEACHING_PRACTICE', label: 'Teaching practice (colleges of education)', icon: '🍎' },
  { id: 'PROJECT', label: 'Project, thesis & research', icon: '📑' },
  { id: 'EXAMS', label: 'Examinations, resit & carry-over', icon: '🧾' },
  { id: 'DEVELOPMENT', label: 'Development levy', icon: '🏗️' },
  { id: 'HOSTEL', label: 'Hostel / accommodation', icon: '🛏️' },
  { id: 'FIELD_TRIP', label: 'Excursion & field trips', icon: '🚐' },
  { id: 'TRANSCRIPT', label: 'Transcript & result verification', icon: '📄' },
  { id: 'GRADUATION', label: 'Convocation, gown & clearance', icon: '🧑‍🎓' },
  { id: 'LATE_FEE', label: 'Late registration / penalty', icon: '⏰' },
  { id: 'OTHER', label: 'Other fees', icon: '➕' },
];
const CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id));
const METHODS = new Set(['BANK_TRANSFER', 'CASH', 'POS']);        // what a payer or the office may say; ONLINE is set only by the server
const SEMESTERS = new Set(['First Semester', 'Second Semester']);
const LEVELS = [1, 2, 3, 4, 5, 6, 7];                              // 100L .. 700L

const MIN_KOBO = 100;                       // ₦1
const MAX_ITEM_KOBO = 50_000_000_00;        // ₦50,000,000 for one fee (some private universities charge a lot)
const MAX_PROOF_LENGTH = 1_500_000;

const naira = (kobo) => '₦' + (Number(kobo) / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 });
const clean = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const levelLabel = (y) => (y ? y * 100 + 'L' : null);

function applies(fee, student) {
  if (!fee.active) return false;
  if (fee.levels && fee.levels.length && !(student && student.yearOfStudy && fee.levels.includes(student.yearOfStudy))) return false;
  if (fee.departmentId && !(student && student.departmentId === fee.departmentId)) return false;
  return true;
}
const itemsOf = (payment) => (Array.isArray(payment.items) ? payment.items : []);

// What one student owes and has paid, fee by fee. `payments` are that student's FeePayment rows.
function ledger(fees, payments, student) {
  const paid = new Map(), pending = new Map();
  let otherPaid = 0, otherPending = 0;
  for (const p of payments) {
    if (p.status !== 'CONFIRMED' && p.status !== 'PENDING') continue;
    for (const it of itemsOf(p)) {
      const target = p.status === 'CONFIRMED' ? paid : pending;
      if (it.feeId) target.set(it.feeId, (target.get(it.feeId) || 0) + it.amountKobo);
      else if (p.status === 'CONFIRMED') otherPaid += it.amountKobo; else otherPending += it.amountKobo;
    }
  }
  const rows = fees.filter((f) => applies(f, student)).map((f) => {
    const paidKobo = paid.get(f.id) || 0, pendingKobo = pending.get(f.id) || 0;
    const balanceKobo = Math.max(0, f.amountKobo - paidKobo);
    const status = balanceKobo === 0 ? 'PAID' : paidKobo > 0 ? 'PARTIAL' : pendingKobo > 0 ? 'PENDING' : 'UNPAID';
    return { id: f.id, title: f.title, category: f.category, description: f.description || null, amountKobo: f.amountKobo, session: f.session || null, semester: f.semester || null, dueDate: f.dueDate || null, paidKobo, pendingKobo, balanceKobo, status };
  });
  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
  return {
    fees: rows,
    totals: { dueKobo: sum('amountKobo'), paidKobo: Math.min(sum('paidKobo'), sum('amountKobo')) + otherPaid, pendingKobo: sum('pendingKobo') + otherPending, balanceKobo: sum('balanceKobo') },
    otherPaidKobo: otherPaid,
  };
}

// Checks the fees a payer says they are paying. `rows` is ledger(...).fees for that student.
function buildItems(raw, rows) {
  const list = Array.isArray(raw) ? raw : [];
  if (!list.length) return { error: 'Choose at least one fee to pay.' };
  if (list.length > 25) return { error: 'That is too many fees in one payment.' };
  const items = [], used = new Set();
  for (const it of list) {
    const amountKobo = Math.round(Number(it && it.amountKobo));
    if (!Number.isFinite(amountKobo) || amountKobo < MIN_KOBO) return { error: 'Each amount must be at least ₦1.' };
    if (amountKobo > MAX_ITEM_KOBO) return { error: 'One of those amounts is too large.' };
    if (it.feeId) {
      const row = rows.find((r) => r.id === String(it.feeId));
      if (!row) return { error: "One of those fees is not for this student's level or department." };
      if (used.has(row.id)) return { error: 'A fee is listed twice.' };
      used.add(row.id);
      if (row.balanceKobo === 0) return { error: row.title + ' is already fully paid.' };
      if (amountKobo > row.balanceKobo) return { error: row.title + ': only ' + naira(row.balanceKobo) + ' is still owing.' };
      items.push({ feeId: row.id, title: row.title, category: row.category, amountKobo });
    } else {
      const title = clean(it.title, 120);
      if (!title) return { error: 'Say what the other fee is for.' };
      items.push({ feeId: null, title, category: 'OTHER', amountKobo });
    }
  }
  return { items, totalKobo: items.reduce((a, i) => a + i.amountKobo, 0) };
}

// The details a payer fills in for a manual (transfer) payment. Returns { data } or { error }.
function paymentDetails(body, { requireReference }) {
  const method = METHODS.has(body.method) ? body.method : 'BANK_TRANSFER';
  const reference = clean(body.reference, 80) || null;
  const depositorName = clean(body.depositorName, 100) || null;
  if (requireReference && !reference && !depositorName) return { error: 'Add the transfer reference or the name on the transfer, so the school can find your payment.' };
  let paidOn = null;
  if (body.paidOn) {
    paidOn = new Date(body.paidOn);
    if (isNaN(paidOn)) return { error: 'That payment date does not look right.' };
    if (paidOn.getTime() > Date.now() + 36 * 3600 * 1000) return { error: 'The payment date cannot be in the future.' };
  }
  let proofUrl = null;
  if (body.proofUrl) {
    if (typeof body.proofUrl !== 'string' || !body.proofUrl.startsWith('data:image/')) return { error: 'The receipt must be a photo.' };
    if (body.proofUrl.length > MAX_PROOF_LENGTH) return { error: 'That receipt photo is too large. Use a smaller one.' };
    proofUrl = body.proofUrl;
  }
  return { data: { method, reference, depositorName, paidOn, note: clean(body.note, 300) || null, proofUrl } };
}

function newReceiptNo() {
  const d = new Date();
  return 'RCT-' + d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

// Fee items a school admin sets up. The kind of fee is its name; only "Other fees" says what it is for.
// Returns { data } or { error }.
function feeDetails(body) {
  const category = CATEGORY_IDS.has(body.category) ? body.category : 'OTHER';
  const title = category === 'OTHER' ? clean(body.title, 120) : CATEGORIES.find((c) => c.id === category).label;
  if (!title) return { error: 'Say what the other fee is for.' };
  const naira0 = Number(body.amountNaira != null ? body.amountNaira : body.amountKobo != null ? body.amountKobo / 100 : NaN);
  const amountKobo = Math.round(naira0 * 100);
  if (!Number.isFinite(amountKobo) || amountKobo < MIN_KOBO) return { error: 'Enter the amount in naira (at least ₦1).' };
  if (amountKobo > MAX_ITEM_KOBO) return { error: 'That amount is too large.' };
  const levels = Array.isArray(body.levels) ? body.levels.map(Number).filter((l) => LEVELS.includes(l)) : [];
  let dueDate = null;
  if (body.dueDate) { dueDate = new Date(body.dueDate); if (isNaN(dueDate)) return { error: 'That due date does not look right.' }; }
  return {
    data: {
      title, category, description: clean(body.description, 300) || null, amountKobo,
      session: clean(body.session, 20) || null, semester: SEMESTERS.has(body.semester) ? body.semester : null,
      levels: Array.from(new Set(levels)).sort(), departmentId: body.departmentId ? String(body.departmentId) : null, dueDate,
      active: body.active === undefined ? true : !!body.active,
    },
  };
}

function bankDetails(body) {
  const bankName = clean(body.bankName, 80), accountName = clean(body.accountName, 120), accountNumber = String(body.accountNumber || '').replace(/\s+/g, '');
  if (!bankName) return { error: "Enter the bank's name." };
  if (!accountName) return { error: 'Enter the account name.' };
  if (!/^[0-9]{10}$/.test(accountNumber)) return { error: 'A Nigerian account number has 10 digits.' };
  return { data: { bankName, accountName, accountNumber, instructions: clean(body.instructions, 300) || null } };
}

module.exports = { CATEGORIES, CATEGORY_IDS, LEVELS, MAX_PROOF_LENGTH, naira, clean, levelLabel, applies, itemsOf, ledger, buildItems, paymentDetails, newReceiptNo, feeDetails, bankDetails };
