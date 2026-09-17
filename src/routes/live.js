const express = require('express');
const prisma = require('../db');
const { requireAuth, requireRole, logActivity } = require('../auth');
const { notifyMany } = require('../services/notification.service');
const liveRealtime = require('../realtime/live');

const router = express.Router();

router.get('/courses/:id/live', requireAuth, async (req, res) => {
  const liveClass = await prisma.liveClass.findFirst({
    where: { courseId: req.params.id, status: 'ACTIVE' },
    include: { host: { select: { fullName: true } } },
  });
  res.json({ liveClass });
});

router.post('/courses/:id/live/start', requireAuth, requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  const { title } = req.body;
  const course = await prisma.course.findUnique({ where: { id: req.params.id } });
  await prisma.liveClass.updateMany({ where: { courseId: req.params.id, status: 'ACTIVE' }, data: { status: 'ENDED', endedAt: new Date() } });
  const liveClass = await prisma.liveClass.create({
    data: { courseId: req.params.id, hostId: req.user.id, title: title || 'Live class' },
  });
  if (req.user.role === 'LECTURER') await logActivity(req.user.id, 'START_LIVE_CLASS', liveClass.title);

  // Deep-links straight into the live session (not just the course page) so tapping
  // the notification really is "tap to join", not "tap, then hunt for the join button".
  const joinLink = `live-class?courseId=${req.params.id}&liveClassId=${liveClass.id}&title=${encodeURIComponent(liveClass.title)}`;
  const students = await prisma.enrollment.findMany({ where: { courseId: req.params.id }, select: { studentId: true } });
  await notifyMany(
    students.map((s) => s.studentId),
    `${req.user.fullName} is teaching live — tap to join`,
    `${course ? course.code + ' — ' : ''}${liveClass.title}`,
    joinLink
  );

  res.json({ liveClass });
});

router.post('/live/:id/end', requireAuth, requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  const liveClass = await prisma.liveClass.findUnique({ where: { id: req.params.id } });
  if (!liveClass || liveClass.hostId !== req.user.id) return res.status(404).json({ error: 'Live class not found' });
  // endLiveClassById both marks the class ENDED and broadcasts live:ended to every
  // connected student's socket -- a plain DB update here left students' live view
  // running indefinitely, only ending when they happened to leave on their own.
  await liveRealtime.endLiveClassById(liveClass.id);
  res.json({ ok: true });
});

module.exports = router;
