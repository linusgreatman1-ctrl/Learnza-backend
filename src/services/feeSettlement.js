const prisma = require('../db');
const fees = require('./fees.service');
const { notify, notifySchoolAdmins } = require('./notification.service');

// What happens to a fee payment once the money moves: who is told, and how an online (card / USSD)
// payment becomes confirmed. Kept apart from the routes so the payment webhooks, the verify call and the
// fees pages all use the same code.

async function uniqueReceiptNo() {
  for (let i = 0; i < 5; i++) {
    const candidate = fees.newReceiptNo();
    if (!(await prisma.feePayment.findUnique({ where: { receiptNo: candidate } }))) return candidate;
  }
  return fees.newReceiptNo() + '-' + Date.now().toString(36).toUpperCase();
}

// An online payment is confirmed the moment the gateway says it was paid in full. Safe to call twice
// (the webhook and the page's own check can both arrive): only one of them flips the row.
async function settleOnline(reference, paidKobo) {
  const p = await prisma.feePayment.findFirst({ where: { reference, method: 'ONLINE' }, include: { student: { select: { id: true, fullName: true } } } });
  if (!p) return { ok: false, reason: 'not_found' };
  if (p.status === 'CONFIRMED') return { ok: true, kind: 'fee', already: true, payment: p };
  if (p.status === 'REJECTED') return { ok: false, reason: 'rejected' };
  if (paidKobo !== null && paidKobo !== undefined && !Number.isNaN(paidKobo) && paidKobo < p.amountKobo) return { ok: false, reason: 'amount_mismatch' };
  const receiptNo = await uniqueReceiptNo();
  const flipped = await prisma.feePayment.updateMany({
    where: { id: p.id, status: { in: ['AWAITING_PAYMENT', 'PENDING'] } },
    data: { status: 'CONFIRMED', receiptNo, paidOn: new Date(), reviewedAt: new Date(), rejectReason: null },
  });
  if (flipped.count === 1) {
    await notify(p.student.id, 'Fee payment received', 'Your online payment of ' + fees.naira(p.amountKobo) + ' was received (receipt ' + receiptNo + ').', 'fees').catch(() => {});
    await notifySchoolAdmins(p.schoolId, 'Fee paid online', p.student.fullName + ' paid ' + fees.naira(p.amountKobo) + ' online (receipt ' + receiptNo + ').', 'admin-fees').catch(() => {});
  }
  return { ok: true, kind: 'fee', payment: { ...p, status: 'CONFIRMED', receiptNo } };
}

module.exports = { uniqueReceiptNo, settleOnline };
