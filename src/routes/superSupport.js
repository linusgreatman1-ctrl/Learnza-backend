const express = require('express');
const prisma = require('../db');
const { logAction } = require('../audit');
const { notify } = require('../services/notification.service');
const coins = require('../services/coins.service');

// The owner's side of support (tickets, live chat, reviews) and of coins. Mounted inside
// routes/super.js, so everything here is already behind "signed in as SUPER_ADMIN".
const router = express.Router();
const pageOf = (req, size = 40) => ({ page: Math.max(1, parseInt(req.query.page, 10) || 1), size });
const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const who = { select: { id: true, fullName: true, email: true, role: true, school: { select: { name: true } } } };

// ---------------------------------------------------------------- tickets
router.get('/tickets', async (req, res) => {
  const { page, size } = pageOf(req);
  const where = {};
  if (['OPEN', 'ANSWERED', 'CLOSED'].includes(req.query.status)) where.status = req.query.status;
  const [total, open, tickets] = await Promise.all([
    prisma.supportTicket.count({ where }),
    prisma.supportTicket.count({ where: { status: 'OPEN' } }),
    prisma.supportTicket.findMany({
      where, orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }], skip: (page - 1) * size, take: size,
      include: { user: who, _count: { select: { messages: true } } },
    }),
  ]);
  res.json({ total, open, page, pageSize: size, tickets });
});

router.get('/tickets/:id', async (req, res) => {
  const ticket = await prisma.supportTicket.findUnique({
    where: { id: req.params.id },
    include: { user: who, messages: { orderBy: { createdAt: 'asc' } } },
  });
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  res.json({ ticket });
});

router.post('/tickets/:id/reply', async (req, res) => {
  const ticket = await prisma.supportTicket.findUnique({ where: { id: req.params.id } });
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  const body = clean(req.body.body, 3000);
  if (!body) return res.status(400).json({ error: 'Write a reply first.' });
  const message = await prisma.supportMessage.create({ data: { ticketId: ticket.id, fromStaff: true, body } });
  await prisma.supportTicket.update({ where: { id: ticket.id }, data: { status: req.body.close ? 'CLOSED' : 'ANSWERED' } });
  await notify(ticket.userId, 'Learnza support replied', ticket.subject, 'support');
  await logAction(req, 'TICKET_REPLIED', 'SupportTicket', ticket.id, { closed: !!req.body.close });
  res.json({ message });
});

router.post('/tickets/:id/status', async (req, res) => {
  const { status } = req.body;
  if (!['OPEN', 'ANSWERED', 'CLOSED'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  const ticket = await prisma.supportTicket.findUnique({ where: { id: req.params.id } });
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  const updated = await prisma.supportTicket.update({ where: { id: ticket.id }, data: { status } });
  await logAction(req, 'TICKET_STATUS', 'SupportTicket', ticket.id, { status });
  res.json({ ticket: updated });
});

// ---------------------------------------------------------------- live chat
router.get('/chat/threads', async (req, res) => {
  const { page, size } = pageOf(req);
  const [total, unread, threads] = await Promise.all([
    prisma.chatThread.count(),
    prisma.chatThread.count({ where: { unreadForAdmin: { gt: 0 } } }),
    prisma.chatThread.findMany({
      orderBy: { lastMessageAt: 'desc' }, skip: (page - 1) * size, take: size,
      include: { user: who, messages: { orderBy: { createdAt: 'desc' }, take: 1 } },
    }),
  ]);
  res.json({ total, unread, page, pageSize: size, threads: threads.map(({ messages, ...t }) => ({ ...t, lastMessage: messages[0] || null })) });
});

router.get('/chat/threads/:id', async (req, res) => {
  const thread = await prisma.chatThread.findUnique({
    where: { id: req.params.id },
    include: { user: who, messages: { orderBy: { createdAt: 'asc' }, take: 300 } },
  });
  if (!thread) return res.status(404).json({ error: 'Chat not found' });
  if (thread.unreadForAdmin) await prisma.chatThread.update({ where: { id: thread.id }, data: { unreadForAdmin: 0 } });
  res.json({ thread });
});

router.post('/chat/threads/:id/reply', async (req, res) => {
  const thread = await prisma.chatThread.findUnique({ where: { id: req.params.id } });
  if (!thread) return res.status(404).json({ error: 'Chat not found' });
  const body = clean(req.body.body, 1500);
  if (!body) return res.status(400).json({ error: 'Write a reply first.' });
  const message = await prisma.chatMessage.create({ data: { threadId: thread.id, sender: 'ADMIN', body } });
  // Answering as a person switches the AI off for this chat until it is handed back.
  await prisma.chatThread.update({ where: { id: thread.id }, data: { adminTookOver: true, unreadForUser: { increment: 1 }, unreadForAdmin: 0, lastMessageAt: new Date() } });
  await notify(thread.userId, 'Learnza support replied', clean(body, 100), 'support');
  res.json({ message });
});

router.post('/chat/threads/:id/release', async (req, res) => {
  const thread = await prisma.chatThread.findUnique({ where: { id: req.params.id } });
  if (!thread) return res.status(404).json({ error: 'Chat not found' });
  await prisma.chatThread.update({ where: { id: thread.id }, data: { adminTookOver: false } });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- reviews
router.get('/reviews', async (req, res) => {
  const { page, size } = pageOf(req);
  const [total, agg, dist, reviews] = await Promise.all([
    prisma.appReview.count(),
    prisma.appReview.aggregate({ _avg: { rating: true } }),
    prisma.appReview.groupBy({ by: ['rating'], _count: { _all: true } }),
    prisma.appReview.findMany({ orderBy: { updatedAt: 'desc' }, skip: (page - 1) * size, take: size, include: { user: who } }),
  ]);
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  dist.forEach((d) => { distribution[d.rating] = d._count._all; });
  res.json({ total, average: agg._avg.rating ? Number(agg._avg.rating.toFixed(2)) : null, distribution, page, pageSize: size, reviews });
});

// ---------------------------------------------------------------- coins
router.get('/coins/purchases', async (req, res) => {
  const { page, size } = pageOf(req, 50);
  const [total, bought, purchases] = await Promise.all([
    prisma.coinPurchase.count(),
    prisma.coinPurchase.aggregate({ where: { status: 'SUCCESS' }, _sum: { amountKobo: true, coins: true }, _count: true }),
    prisma.coinPurchase.findMany({ orderBy: { createdAt: 'desc' }, skip: (page - 1) * size, take: size, include: { user: who } }),
  ]);
  res.json({
    total, page, pageSize: size, purchases,
    summary: { revenueKobo: bought._sum.amountKobo || 0, coinsSold: bought._sum.coins || 0, paid: bought._count },
  });
});

router.get('/coins/ledger', async (req, res) => {
  const { page, size } = pageOf(req, 50);
  const [total, entries] = await Promise.all([
    prisma.coinLedger.count(),
    prisma.coinLedger.findMany({ orderBy: { createdAt: 'desc' }, skip: (page - 1) * size, take: size, include: { user: who } }),
  ]);
  res.json({ total, page, pageSize: size, entries });
});

router.post('/coins/grant', async (req, res) => {
  const email = clean(req.body.email, 200).toLowerCase();
  const amount = parseInt(req.body.coins, 10);
  if (!(amount >= 1 && amount <= 10000)) return res.status(400).json({ error: 'Enter a whole number of coins between 1 and 10,000.' });
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.role !== 'STUDENT') return res.status(404).json({ error: 'No student has that email address.' });
  const note = clean(req.body.note, 200) || 'Granted by Learnza';
  const wallet = await coins.credit(user.id, amount, 'GRANT', { note });
  await logAction(req, 'COINS_GRANTED', 'User', user.id, { email, coins: amount, note });
  await notify(user.id, 'Coins added', `${amount} coins were added to your wallet.`, 'wallet');
  res.json({ balance: wallet.balance });
});

module.exports = router;
