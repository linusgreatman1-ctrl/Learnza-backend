// Money that arrives in the company account confirms the matching waiting payment by itself (services/bankCredit.service.js).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const crypto = require('crypto');

let seq = 0;
function table(unique = []) {
  const rows = [];
  const match = (row, where = {}) => Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('not' in v) return row[k] !== v.not;
      if ('gt' in v) return row[k] != null && new Date(row[k]) > new Date(v.gt);
      if ('in' in v) return v.in.includes(row[k]);
      return true;
    }
    return row[k] === v;
  });
  return {
    rows,
    async create({ data }) {
      const row = { id: 'i' + ++seq, createdAt: new Date(), status: 'PENDING', ...data };
      for (const u of unique) if (rows.some((r) => u.every((f) => r[f] === row[f]))) { const e = new Error('unique'); e.code = 'P2002'; throw e; }
      rows.push(row); return { ...row };
    },
    async findUnique({ where }) { const r = rows.find((x) => match(x, where)); return r ? { ...r } : null; },
    async findMany({ where, include } = {}) { return rows.filter((r) => match(r, where)).map((r) => ({ ...r, ...(include && include.user ? { user: { fullName: r.holder, email: r.contact } } : {}) })); },
    async update({ where, data }) { const r = rows.find((x) => match(x, where)); Object.assign(r, data); return { ...r }; },
    async updateMany({ where, data }) { const hit = rows.filter((r) => match(r, where)); hit.forEach((r) => Object.assign(r, data)); return { count: hit.length }; },
  };
}
const db = {
  bankCredit: table([['providerRef']]),
  payment: table(), coinPurchase: table(),
  user: { findMany: async () => [{ id: 'admin1' }], findUnique: async () => ({ notificationsMuted: false }) },
  notification: table(),
};
const dbPath = require.resolve(path.join('..', '..', 'src', 'db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: db };
const rtPath = require.resolve(path.join('..', '..', 'src', 'realtime', 'notifications.js'));
require.cache[rtPath] = { id: rtPath, filename: rtPath, loaded: true, exports: { pushToUser() {} } };

const payments = require('../../src/services/payments.service');
const confirmed = [];
payments.settle = async (ref) => { confirmed.push(ref); const row = db.payment.rows.concat(db.coinPurchase.rows).find((r) => r.reference === ref); row.status = 'SUCCESS'; return { ok: true }; };
const bank = require('../../src/services/bankCredit.service');

const request = (t, reference, amountKobo, holder, extra = {}) => t.rows.push({ id: 'r' + ++seq, reference, amountKobo, holder, provider: 'MANUAL_TRANSFER', status: 'PENDING', createdAt: new Date(), plan: 'YEARLY', coins: 30, ...extra });

test("each feed's call is put into one shape, and only successful bank transfers count", () => {
  const f = bank.normalize('flutterwave', { event: 'charge.completed', data: { id: 77, status: 'successful', amount: 13500, payment_type: 'bank_transfer', narration: 'LZ-MANUAL-1', customer: { name: 'Ada Okoro' } } });
  assert.equal(f.amountKobo, 1350000); assert.equal(f.providerRef, 'FLW-77'); assert.equal(f.payerName, 'Ada Okoro');
  assert.equal(bank.normalize('flutterwave', { event: 'charge.completed', data: { id: 1, status: 'failed', amount: 5 } }), null);
  assert.equal(bank.normalize('flutterwave', { event: 'charge.completed', data: { id: 1, status: 'successful', amount: 5, payment_type: 'card' } }), null);
  const p = bank.normalize('paystack', { event: 'charge.success', data: { id: 5, status: 'success', amount: 250000, channel: 'dedicated_nuban', reference: 'r1', authorization: { sender_name: 'Bola Ade' } } });
  assert.equal(p.amountKobo, 250000); assert.equal(p.payerName, 'Bola Ade');
  assert.equal(bank.normalize('paystack', { event: 'charge.success', data: { id: 5, status: 'success', amount: 1, channel: 'card' } }), null);
  assert.equal(bank.normalize('generic', { id: 'x1', amount: 12500, narration: 'hi', name: 'Z' }).amountKobo, 1250000);
  assert.equal(bank.normalize('generic', {}), null);
});

test('the feed must prove who it is', () => {
  process.env.BANK_WEBHOOK_SECRET = 's3cret'; process.env.FLUTTERWAVE_WEBHOOK_HASH = 'hash1';
  assert.equal(bank.verifySignature('generic', { headers: { 'x-bank-secret': 's3cret' } }), true);
  assert.equal(bank.verifySignature('generic', { headers: { 'x-bank-secret': 'nope' } }), false);
  assert.equal(bank.verifySignature('generic', { headers: {} }), false);
  assert.equal(bank.verifySignature('flutterwave', { headers: { 'verif-hash': 'hash1' } }), true);
  assert.equal(bank.verifySignature('flutterwave', { headers: { 'verif-hash': 'x' } }), false);
  process.env.PAYSTACK_SECRET_KEY = 'sk'; const raw = Buffer.from('{"a":1}');
  assert.equal(bank.verifySignature('paystack', { rawBody: raw, headers: { 'x-paystack-signature': crypto.createHmac('sha512', 'sk').update(raw).digest('hex') } }), true);
  assert.equal(bank.verifySignature('paystack', { rawBody: raw, headers: { 'x-paystack-signature': 'bad' } }), false);
  delete process.env.BANK_WEBHOOK_SECRET;
  assert.equal(bank.verifySignature('generic', { headers: { 'x-bank-secret': '' } }), false);
});

test('a credit with the reference in its narration confirms that request; the same credit twice counts once', async () => {
  request(db.payment, 'LZ-MANUAL-AAA', 1500000, 'Ada Okoro');
  request(db.payment, 'LZ-MANUAL-BBB', 1500000, 'Bola Ade');
  const r = await bank.processCredit({ provider: 'GENERIC', providerRef: 'GEN-1', amountKobo: 1500000, narration: 'transfer lz-manual-bbb thanks', payerName: 'someone' });
  assert.equal(r.status, 'MATCHED');
  assert.deepEqual(confirmed, ['LZ-MANUAL-BBB']);
  assert.ok(db.notification.rows.some((n) => /confirmed automatically/.test(n.title)));
  const again = await bank.processCredit({ provider: 'GENERIC', providerRef: 'GEN-1', amountKobo: 1500000, narration: 'lz-manual-aaa', payerName: '' });
  assert.equal(again.duplicate, true);
  assert.deepEqual(confirmed, ['LZ-MANUAL-BBB']);
});

test('the only request waiting for that amount is confirmed; the name decides between several; otherwise the admins are asked', async () => {
  confirmed.length = 0;
  request(db.coinPurchase, 'LZ-COIN-MANUAL-ONE', 250000, 'Chi Obi');
  assert.equal((await bank.processCredit({ provider: 'GENERIC', providerRef: 'GEN-2', amountKobo: 250000, narration: '', payerName: '' })).status, 'MATCHED');
  request(db.coinPurchase, 'LZ-COIN-MANUAL-TWO', 480000, 'Ngozi Eze');
  request(db.coinPurchase, 'LZ-COIN-MANUAL-THREE', 480000, 'Tunde Bello');
  const named = await bank.processCredit({ provider: 'GENERIC', providerRef: 'GEN-3', amountKobo: 480000, narration: '', payerName: 'BELLO TUNDE A' });
  assert.equal(named.status, 'MATCHED'); assert.equal(named.ref, 'LZ-COIN-MANUAL-THREE');
  request(db.coinPurchase, 'LZ-COIN-MANUAL-FOUR', 700000, 'Amina Musa');
  request(db.coinPurchase, 'LZ-COIN-MANUAL-FIVE', 700000, 'Segun Ade');
  assert.equal((await bank.processCredit({ provider: 'GENERIC', providerRef: 'GEN-4', amountKobo: 700000, narration: '', payerName: 'Unknown' })).status, 'AMBIGUOUS');
  assert.equal((await bank.processCredit({ provider: 'GENERIC', providerRef: 'GEN-5', amountKobo: 123400, narration: '', payerName: '' })).status, 'UNMATCHED');
  const kept = db.bankCredit.rows.find((r) => r.providerRef === 'GEN-4');
  assert.equal((await bank.matchByHand(kept.id, 'LZ-COIN-MANUAL-FOUR')).ok, true);
  assert.equal((await bank.matchByHand(kept.id, 'LZ-COIN-MANUAL-FIVE')).reason, 'already_matched');
});

test('a payment that is too small for the reference it names is not confirmed; a request can be rejected', async () => {
  confirmed.length = 0;
  request(db.payment, 'LZ-MANUAL-SMALL', 1500000, 'Short Payer');
  const r = await bank.processCredit({ provider: 'GENERIC', providerRef: 'GEN-6', amountKobo: 500000, narration: 'lz-manual-small', payerName: 'Short Payer' });
  assert.notEqual(r.status, 'MATCHED');
  assert.equal(confirmed.length, 0);
  assert.equal((await bank.rejectRequest('LZ-MANUAL-SMALL')).ok, true);
  assert.equal(db.payment.rows.find((x) => x.reference === 'LZ-MANUAL-SMALL').status, 'FAILED');
  assert.equal((await bank.rejectRequest('LZ-MANUAL-SMALL')).reason, 'request_not_waiting');
});
