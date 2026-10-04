const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../auth');
const ai = require('../services/aiProvider.service');
const settings = require('../settings');

// Help & support for every signed-in person (students, lecturers, school admins): tickets,
// a live chat with the platform team, and one review of the app. The owner answers all of it
// from the admin panel (routes/superSupport.js).
const router = express.Router();
router.use(requireAuth);
router.use((req, res, next) => {
  if (req.user.role === 'SUPER_ADMIN') return res.status(403).json({ error: 'Platform admins answer support from the admin panel.' });
  next();
});

const CATEGORIES = ['GENERAL', 'BILLING', 'ACCOUNT', 'BUG', 'OTHER'];
const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

// ---------------------------------------------------------------- tickets
router.get('/tickets', async (req, res) => {
  const tickets = await prisma.supportTicket.findMany({
    where: { userId: req.user.id },
    orderBy: { updatedAt: 'desc' },
    take: 50,
    include: { messages: { orderBy: { createdAt: 'desc' }, take: 1 } },
  });
  res.json({ tickets: tickets.map(({ messages, ...t }) => ({ ...t, lastMessage: messages[0] || null })) });
});

router.post('/tickets', async (req, res) => {
  const subject = clean(req.body.subject, 120);
  const body = clean(req.body.body, 3000);
  const category = CATEGORIES.includes(req.body.category) ? req.body.category : 'GENERAL';
  if (!subject || !body) return res.status(400).json({ error: 'Add a subject and describe what you need help with.' });
  const open = await prisma.supportTicket.count({ where: { userId: req.user.id, status: { not: 'CLOSED' } } });
  if (open >= 5) return res.status(429).json({ error: 'You already have several open tickets. Please wait for a reply, or add to one of them.' });
  const ticket = await prisma.supportTicket.create({
    data: { userId: req.user.id, subject, category, messages: { create: [{ fromStaff: false, body }] } },
  });
  res.json({ ticket });
});

async function myTicket(req, res) {
  const ticket = await prisma.supportTicket.findFirst({
    where: { id: req.params.id, userId: req.user.id },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });
  if (!ticket) res.status(404).json({ error: 'Ticket not found' });
  return ticket;
}

router.get('/tickets/:id', async (req, res) => {
  const ticket = await myTicket(req, res);
  if (ticket) res.json({ ticket });
});

router.post('/tickets/:id/messages', async (req, res) => {
  const ticket = await myTicket(req, res);
  if (!ticket) return;
  if (ticket.status === 'CLOSED') return res.status(409).json({ error: 'This ticket is closed. Please open a new one.' });
  const body = clean(req.body.body, 3000);
  if (!body) return res.status(400).json({ error: 'Write a message first.' });
  const message = await prisma.supportMessage.create({ data: { ticketId: ticket.id, fromStaff: false, body } });
  await prisma.supportTicket.update({ where: { id: ticket.id }, data: { status: 'OPEN' } });
  res.json({ message });
});

// ---------------------------------------------------------------- app review
router.get('/review', async (req, res) => {
  res.json({ review: await prisma.appReview.findUnique({ where: { userId: req.user.id } }) });
});

router.put('/review', async (req, res) => {
  const rating = parseInt(req.body.rating, 10);
  if (!(rating >= 1 && rating <= 5)) return res.status(400).json({ error: 'Choose 1 to 5 stars.' });
  const comment = clean(req.body.comment, 1000) || null;
  const review = await prisma.appReview.upsert({
    where: { userId: req.user.id },
    create: { userId: req.user.id, rating, comment },
    update: { rating, comment },
  });
  res.json({ review });
});

// ---------------------------------------------------------------- live chat
const CHAT_SYSTEM = `You are the friendly support assistant inside Learnza, a learning platform for Nigerian higher-institution students, lecturers and school administrators. Answer briefly (2-4 sentences) and practically about how to use the app. Never ask for or accept passwords, access codes or card details. For anything about payments, refunds, account access, or a bug you cannot fix with simple steps, say a member of the Learnza team will reply in this chat soon. If you do not know, say so rather than guessing.`;
const FALLBACK = "Thanks for your message. A member of the Learnza team will reply here soon.";

async function threadFor(userId) {
  return prisma.chatThread.upsert({ where: { userId }, create: { userId }, update: {} });
}

// Poll with ?after=<ISO time> to get only what is new. Opening the chat clears the badge.
router.get('/chat', async (req, res) => {
  const thread = await threadFor(req.user.id);
  const after = req.query.after ? new Date(String(req.query.after)) : null;
  const messages = await prisma.chatMessage.findMany({
    where: { threadId: thread.id, ...(after && !isNaN(after) ? { createdAt: { gt: after } } : {}) },
    orderBy: { createdAt: 'asc' },
    take: 200,
  });
  if (thread.unreadForUser) await prisma.chatThread.update({ where: { id: thread.id }, data: { unreadForUser: 0 } });
  res.json({ messages, withTeam: thread.adminTookOver });
});

router.post('/chat', async (req, res) => {
  const body = clean(req.body.body, 1500);
  if (!body) return res.status(400).json({ error: 'Write a message first.' });
  const thread = await threadFor(req.user.id);
  const recent = await prisma.chatMessage.count({ where: { threadId: thread.id, sender: 'USER', createdAt: { gt: new Date(Date.now() - 60 * 1000) } } });
  if (recent >= 12) return res.status(429).json({ error: 'You are sending messages too quickly. Please slow down.' });

  const message = await prisma.chatMessage.create({ data: { threadId: thread.id, sender: 'USER', body } });
  await prisma.chatThread.update({ where: { id: thread.id }, data: { unreadForAdmin: { increment: 1 }, lastMessageAt: new Date() } });
  res.json({ message });

  // The assistant answers until a person from the team steps in.
  if (!thread.adminTookOver) answerWithAi(thread.id).catch((e) => console.error('Support chat AI reply failed:', e.message));
});

async function answerWithAi(threadId) {
  let reply = FALLBACK;
  if (settings.get('aiEnabled') && ai.isConfigured()) {
    const history = (await prisma.chatMessage.findMany({ where: { threadId }, orderBy: { createdAt: 'desc' }, take: 8 })).reverse();
    const transcript = history.map((m) => `${m.sender === 'USER' ? 'User' : 'Support'}: ${m.body}`).join('\n');
    try {
      reply = (await ai.askForText(CHAT_SYSTEM, `${transcript}\nSupport:`)).trim().slice(0, 1500) || FALLBACK;
    } catch {
      reply = FALLBACK;
    }
  }
  // A person may have joined while the AI was thinking -- then stay quiet.
  const fresh = await prisma.chatThread.findUnique({ where: { id: threadId } });
  if (!fresh || fresh.adminTookOver) return;
  await prisma.chatMessage.create({ data: { threadId, sender: 'AI', body: reply } });
  await prisma.chatThread.update({ where: { id: threadId }, data: { unreadForUser: { increment: 1 }, lastMessageAt: new Date() } });
}

router.get('/chat/unread', async (req, res) => {
  const thread = await prisma.chatThread.findUnique({ where: { userId: req.user.id } });
  res.json({ unread: thread ? thread.unreadForUser : 0 });
});

module.exports = router;
