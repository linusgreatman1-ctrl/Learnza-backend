const express = require('express');
const prisma = require('../db');
const { requireAuth, requireRole } = require('../auth');

const router = express.Router();

// Study groups: student-only space, deliberately no scores/ranking/leaderboard here.
router.get('/courses/:id/groups', requireAuth, async (req, res) => {
  const groups = await prisma.studyGroup.findMany({
    where: { courseId: req.params.id },
    include: { _count: { select: { members: true } } },
  });
  res.json({ groups });
});

router.post('/courses/:id/groups', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Group name is required' });
  const group = await prisma.studyGroup.create({
    data: { courseId: req.params.id, name, creatorId: req.user.id },
  });
  await prisma.groupMembership.create({ data: { groupId: group.id, studentId: req.user.id } });
  res.json({ group });
});

router.post('/groups/:id/join', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const groupId = req.params.id;
  const existing = await prisma.groupMembership.findUnique({
    where: { groupId_studentId: { groupId, studentId: req.user.id } },
  });
  if (existing) return res.json({ ok: true, alreadyMember: true });
  await prisma.groupMembership.create({ data: { groupId, studentId: req.user.id } });
  res.json({ ok: true });
});

router.get('/groups/:id/messages', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const messages = await prisma.groupMessage.findMany({
    where: { groupId: req.params.id },
    include: { sender: { select: { fullName: true } } },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ messages });
});

router.post('/groups/:id/messages', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const { body } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: 'Message cannot be empty' });
  const message = await prisma.groupMessage.create({
    data: { groupId: req.params.id, senderId: req.user.id, body: body.trim() },
    include: { sender: { select: { fullName: true } } },
  });
  res.json({ message });
});

module.exports = router;
