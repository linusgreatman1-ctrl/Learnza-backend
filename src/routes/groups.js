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
  res.json({ messages });
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
