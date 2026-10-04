const express = require('express');
const prisma = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { memoryUpload, saveUpload } = require('../services/fileUpload.service');
const { loadCourse, hasSchool } = require('../scope');

const router = express.Router();
const upload = memoryUpload(20); // group chat attachments -- images/docs, not lecture video

// Who may touch a group.
//  - A school course's group belongs to that school: only its students get in.
//  - A self-directed course's group is joined by sharing its id with a study partner
//    (that is the invite), so joining is open to any student who has the id.
//  - Reading or writing the chat always needs membership -- being able to see that a group
//    exists is not the same as being in it.
function groupGate({ member }) {
  return async (req, res, next) => {
    const groupId = req.params.groupId || req.params.id;
    const group = await prisma.studyGroup.findUnique({
      where: { id: groupId },
      include: { course: { select: { department: { select: { schoolId: true } } } } },
    });
    const sameSchool = group && group.course && hasSchool(req.user) && group.course.department.schoolId === req.user.schoolId;
    const selfDirected = group && !group.courseId && !!group.individualCourseId;
    if (!group || !(sameSchool || selfDirected)) return res.status(404).json({ error: 'Group not found' });
    if (member) {
      const m = await prisma.groupMembership.findUnique({ where: { groupId_studentId: { groupId: group.id, studentId: req.user.id } } });
      if (!m) return res.status(403).json({ error: 'Join the group first.' });
    }
    req.group = group;
    next();
  };
}

// Study groups: student-only space, deliberately no scores/ranking/leaderboard here.
router.get('/courses/:id/groups', requireAuth, loadCourse(), async (req, res) => {
  const groups = await prisma.studyGroup.findMany({
    where: { courseId: req.course.id },
    include: { _count: { select: { members: true } } },
  });
  res.json({ groups });
});

router.post('/courses/:id/groups', requireAuth, requireRole('STUDENT'), loadCourse(), async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Group name is required' });
  const group = await prisma.studyGroup.create({
    data: { courseId: req.course.id, name, creatorId: req.user.id },
  });
  await prisma.groupMembership.create({ data: { groupId: group.id, studentId: req.user.id } });
  res.json({ group });
});

router.post('/groups/:id/join', requireAuth, requireRole('STUDENT'), groupGate({ member: false }), async (req, res) => {
  const groupId = req.group.id;
  const existing = await prisma.groupMembership.findUnique({
    where: { groupId_studentId: { groupId, studentId: req.user.id } },
  });
  if (existing) return res.json({ ok: true, alreadyMember: true });
  await prisma.groupMembership.create({ data: { groupId, studentId: req.user.id } });
  res.json({ ok: true });
});

router.get('/groups/:id/messages', requireAuth, requireRole('STUDENT'), groupGate({ member: true }), async (req, res) => {
  const messages = await prisma.groupMessage.findMany({
    // Hide anything this member deleted "for me" -- everyone else still sees it.
    where: { groupId: req.group.id, NOT: { deletedForIds: { has: req.user.id } } },
    include: { sender: { select: { fullName: true } } },
    orderBy: { createdAt: 'asc' },
  });
  // "Seen by N": how many other members have opened each message. memberCount - 1 is the
  // most it can reach for anyone's own message.
  const [reads, memberCount] = await Promise.all([
    messages.length
      ? prisma.groupMessageRead.groupBy({ by: ['messageId'], where: { messageId: { in: messages.map((m) => m.id) } }, _count: { _all: true } })
      : [],
    prisma.groupMembership.count({ where: { groupId: req.group.id } }),
  ]);
  const seen = new Map(reads.map((r) => [r.messageId, r._count._all]));
  res.json({ messages: messages.map((m) => ({ ...m, seenBy: seen.get(m.id) || 0 })), memberCount });
});

// Opening the chat marks everyone else's messages as seen by this member.
router.post('/groups/:id/read', requireAuth, requireRole('STUDENT'), groupGate({ member: true }), async (req, res) => {
  const unread = await prisma.groupMessage.findMany({
    where: { groupId: req.group.id, senderId: { not: req.user.id }, reads: { none: { readerId: req.user.id } } },
    select: { id: true },
    take: 500,
  });
  if (unread.length) await prisma.groupMessageRead.createMany({ data: unread.map((m) => ({ messageId: m.id, readerId: req.user.id })), skipDuplicates: true });
  res.json({ marked: unread.length });
});

// ---- Polls: a quick vote inside the group (e.g. "Which day for the revision session?") ----
function pollShape(poll, userId) {
  const options = JSON.parse(poll.options);
  const counts = options.map(() => 0);
  let mine = null;
  for (const v of poll.votes) {
    if (counts[v.optionIdx] !== undefined) counts[v.optionIdx] += 1;
    if (v.voterId === userId) mine = v.optionIdx;
  }
  return {
    id: poll.id, question: poll.question, closed: poll.closed, createdAt: poll.createdAt,
    creator: poll.creator ? poll.creator.fullName : null, mine: poll.creatorId === userId,
    options: options.map((label, i) => ({ label, votes: counts[i] })), myVote: mine, totalVotes: poll.votes.length,
  };
}

router.get('/groups/:id/polls', requireAuth, requireRole('STUDENT'), groupGate({ member: true }), async (req, res) => {
  const polls = await prisma.groupPoll.findMany({
    where: { groupId: req.group.id }, orderBy: { createdAt: 'desc' }, take: 30,
    include: { votes: true, creator: { select: { fullName: true } } },
  });
  res.json({ polls: polls.map((p) => pollShape(p, req.user.id)) });
});

router.post('/groups/:id/polls', requireAuth, requireRole('STUDENT'), groupGate({ member: true }), async (req, res) => {
  const question = String(req.body.question || '').trim().slice(0, 200);
  const options = (Array.isArray(req.body.options) ? req.body.options : []).map((o) => String(o || '').trim().slice(0, 80)).filter(Boolean);
  if (!question) return res.status(400).json({ error: 'Ask a question.' });
  if (options.length < 2 || options.length > 6) return res.status(400).json({ error: 'Give between 2 and 6 options.' });
  if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) return res.status(400).json({ error: 'Each option must be different.' });
  const poll = await prisma.groupPoll.create({
    data: { groupId: req.group.id, creatorId: req.user.id, question, options: JSON.stringify(options) },
    include: { votes: true, creator: { select: { fullName: true } } },
  });
  res.json({ poll: pollShape(poll, req.user.id) });
});

// Voting and closing look the poll up first, then apply the same group check.
async function loadPoll(req, res, next) {
  const poll = await prisma.groupPoll.findUnique({ where: { id: req.params.pollId }, include: { votes: true, creator: { select: { fullName: true } } } });
  if (!poll) return res.status(404).json({ error: 'Poll not found' });
  req.params.id = poll.groupId;
  req.poll = poll;
  next();
}

router.post('/polls/:pollId/vote', requireAuth, requireRole('STUDENT'), loadPoll, groupGate({ member: true }), async (req, res) => {
  const idx = parseInt(req.body.optionIdx, 10);
  const options = JSON.parse(req.poll.options);
  if (req.poll.closed) return res.status(409).json({ error: 'This poll is closed.' });
  if (!(idx >= 0 && idx < options.length)) return res.status(400).json({ error: 'Pick one of the options.' });
  await prisma.groupPollVote.upsert({
    where: { pollId_voterId: { pollId: req.poll.id, voterId: req.user.id } },
    create: { pollId: req.poll.id, voterId: req.user.id, optionIdx: idx },
    update: { optionIdx: idx },
  });
  const fresh = await prisma.groupPoll.findUnique({ where: { id: req.poll.id }, include: { votes: true, creator: { select: { fullName: true } } } });
  res.json({ poll: pollShape(fresh, req.user.id) });
});

router.post('/polls/:pollId/close', requireAuth, requireRole('STUDENT'), loadPoll, groupGate({ member: true }), async (req, res) => {
  if (req.poll.creatorId !== req.user.id) return res.status(403).json({ error: 'Only the person who started the poll can close it.' });
  const updated = await prisma.groupPoll.update({ where: { id: req.poll.id }, data: { closed: true }, include: { votes: true, creator: { select: { fullName: true } } } });
  res.json({ poll: pollShape(updated, req.user.id) });
});

router.post('/groups/:id/messages', requireAuth, requireRole('STUDENT'), groupGate({ member: true }), async (req, res) => {
  const { body } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: 'Message cannot be empty' });
  const message = await prisma.groupMessage.create({
    data: { groupId: req.group.id, senderId: req.user.id, body: body.trim() },
    include: { sender: { select: { fullName: true } } },
  });
  res.json({ message });
});

// A file shared in the group chat -- same direct-device-upload convention as lesson
// videos and library resources (Cloudinary when configured, local disk otherwise).
router.post('/groups/:id/messages/file', requireAuth, requireRole('STUDENT'), groupGate({ member: true }), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a file to share.' });
  let fileUrl, storage;
  try {
    ({ url: fileUrl, storage } = await saveUpload(req.file));
  } catch {
    return res.status(502).json({ error: 'File upload failed. Please try again.' });
  }
  const message = await prisma.groupMessage.create({
    data: {
      groupId: req.group.id,
      senderId: req.user.id,
      fileUrl,
      fileName: req.file.originalname,
      fileMime: req.file.mimetype,
    },
    include: { sender: { select: { fullName: true } } },
  });
  res.json({ message, storage });
});

// Delete for everyone: only the sender may do this, and it clears the content
// (keeping the row so the thread order/placeholder still makes sense) rather than
// removing the row outright. Delete for me: any member can hide it from just their
// own view via deletedForIds, leaving it untouched for everyone else. Ownership for
// "everyone" is checked server-side regardless of what the client claims.
router.delete('/groups/:groupId/messages/:messageId', requireAuth, requireRole('STUDENT'), groupGate({ member: true }), async (req, res) => {
  const message = await prisma.groupMessage.findUnique({ where: { id: req.params.messageId } });
  if (!message || message.groupId !== req.params.groupId) return res.status(404).json({ error: 'Message not found' });
  if (req.query.for === 'everyone') {
    if (message.senderId !== req.user.id) return res.status(403).json({ error: 'You can only delete your own messages for everyone.' });
    await prisma.groupMessage.update({
      where: { id: message.id },
      data: { deletedForEveryone: true, body: null, fileUrl: null, fileName: null, fileMime: null },
    });
  } else {
    if (!message.deletedForIds.includes(req.user.id)) {
      await prisma.groupMessage.update({
        where: { id: message.id },
        data: { deletedForIds: { push: req.user.id } },
      });
    }
  }
  res.json({ ok: true });
});

module.exports = router;
