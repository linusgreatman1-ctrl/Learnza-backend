const express = require('express');
const prisma = require('../db');
const { requireAuth, requireRole, logActivity } = require('../auth');
const { notifyMany } = require('../services/notification.service');
const liveRealtime = require('../realtime/live');
const { memoryUpload, saveUpload } = require('../services/fileUpload.service');
const { loadCourse, hasSchool } = require('../scope');

const router = express.Router();
const recordingUpload = memoryUpload(80); // recorded class videos, same cap as lecture-upload

router.get('/courses/:id/live', requireAuth, loadCourse(), async (req, res) => {
  const liveClass = await prisma.liveClass.findFirst({
    where: { courseId: req.course.id, status: 'ACTIVE' },
    include: { host: { select: { fullName: true } } },
  });
  res.json({ liveClass });
});

router.post('/courses/:id/live/start', requireAuth, requireRole('LECTURER', 'ADMIN'), loadCourse(), async (req, res) => {
  const { title } = req.body;
  const course = req.course;
  await prisma.liveClass.updateMany({ where: { courseId: course.id, status: 'ACTIVE' }, data: { status: 'ENDED', endedAt: new Date() } });
  const liveClass = await prisma.liveClass.create({
    data: { courseId: course.id, hostId: req.user.id, title: title || 'Live class' },
  });
  if (req.user.role === 'LECTURER') await logActivity(req.user.id, 'START_LIVE_CLASS', liveClass.title);

  // Deep-links straight into the live session (not just the course page) so tapping
  // the notification really is "tap to join", not "tap, then hunt for the join button".
  const joinLink = `live-class?courseId=${course.id}&liveClassId=${liveClass.id}&title=${encodeURIComponent(liveClass.title)}`;
  const students = await prisma.enrollment.findMany({ where: { courseId: course.id }, select: { studentId: true } });
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
  const durationMin = await liveRealtime.endLiveClassById(liveClass.id);
  res.json({ ok: true, durationMin });
});

// ---- Recording a live class --------------------------------------------------------------
// The lecturer's browser records the class (their camera and microphone, plus the voice of any
// student let in to speak) and sends it here in small pieces every few seconds, so nothing is
// lost if the lecturer's connection drops or the page is closed: each piece is appended to one
// file on the server's storage volume. The first piece makes the recording appear; the
// recording is shown to the class and the lecturer once the class has ended.
const fs = require('fs');
const path = require('path');
const LIVE_DIR = path.join(__dirname, '..', '..', 'uploads', 'live');
const lastSeq = new Map(); // liveClassId -> highest piece number written (drops a piece the browser re-sent)
const chunkBody = express.raw({ type: () => true, limit: '25mb' });

router.post('/live/:id/recording/chunk', requireAuth, requireRole('LECTURER', 'ADMIN'), chunkBody, async (req, res) => {
  const liveClass = await prisma.liveClass.findUnique({ where: { id: req.params.id } });
  if (!liveClass || liveClass.hostId !== req.user.id) return res.status(404).json({ error: 'Live class not found' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Empty recording piece.' });
  const seq = parseInt(req.query.seq, 10);
  if (Number.isFinite(seq) && seq <= (lastSeq.get(liveClass.id) ?? -1)) return res.json({ ok: true, duplicate: true });
  fs.mkdirSync(LIVE_DIR, { recursive: true });
  const file = path.join(LIVE_DIR, `${liveClass.id}.webm`);
  await fs.promises.appendFile(file, req.body);
  if (Number.isFinite(seq)) lastSeq.set(liveClass.id, seq);
  if (!liveClass.recordingUrl) await prisma.liveClass.update({ where: { id: liveClass.id }, data: { recordingUrl: `/uploads/live/${liveClass.id}.webm` } });
  res.json({ ok: true });
});

// Kept for an older browser tab that sends the whole file at the end.
router.post('/live/:id/recording', requireAuth, requireRole('LECTURER', 'ADMIN'), recordingUpload.single('video'), async (req, res) => {
  const liveClass = await prisma.liveClass.findUnique({ where: { id: req.params.id } });
  if (!liveClass || liveClass.hostId !== req.user.id) return res.status(404).json({ error: 'Live class not found' });
  if (!req.file) return res.status(400).json({ error: 'No recording received.' });
  let videoUrl;
  try {
    ({ url: videoUrl } = await saveUpload(req.file));
  } catch {
    return res.status(502).json({ error: 'Recording upload failed. Please try again.' });
  }
  const updated = await prisma.liveClass.update({ where: { id: liveClass.id }, data: { recordingUrl: videoUrl } });
  res.json({ liveClass: updated });
});

// The recordings a person can watch again: a lecturer sees the classes they taught, a student the
// classes of the courses they are in, and a campus admin every class of their campus.
router.get('/live/recordings', requireAuth, async (req, res) => {
  if (!hasSchool(req.user)) return res.json({ recordings: [] });
  const base = { recordingUrl: { not: null }, status: 'ENDED', course: { department: { schoolId: req.user.schoolId } } };
  let where = null;
  if (req.user.role === 'LECTURER') where = { ...base, OR: [{ hostId: req.user.id }, { course: { lecturers: { some: { lecturerId: req.user.id } } } }] };
  else if (req.user.role === 'STUDENT') where = { ...base, course: { department: { schoolId: req.user.schoolId }, enrollments: { some: { studentId: req.user.id } } } };
  else if (req.user.role === 'ADMIN') where = base;
  if (!where) return res.json({ recordings: [] });
  const rows = await prisma.liveClass.findMany({
    where, orderBy: { startedAt: 'desc' }, take: 100,
    include: { course: { select: { code: true, title: true } }, host: { select: { fullName: true } } },
  });
  const recordings = rows.map((r) => {
    let size = null;
    if (/^\/uploads\/live\//.test(r.recordingUrl)) { try { size = fs.statSync(path.join(__dirname, '..', '..', r.recordingUrl)).size; } catch { size = 0; } }
    return { id: r.id, title: r.title, course: r.course, host: r.host.fullName, startedAt: r.startedAt, endedAt: r.endedAt, recordingUrl: r.recordingUrl, size, mine: r.hostId === req.user.id };
  }).filter((r) => r.size !== 0);
  res.json({ recordings });
});

// A lecturer may remove the recording of a class they taught.
router.delete('/live/:id/recording', requireAuth, requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  const liveClass = await prisma.liveClass.findUnique({ where: { id: req.params.id }, include: { course: { select: { department: { select: { schoolId: true } } } } } });
  const allowed = liveClass && (liveClass.hostId === req.user.id || (req.user.role === 'ADMIN' && liveClass.course.department.schoolId === req.user.schoolId));
  if (!allowed) return res.status(404).json({ error: 'Recording not found' });
  if (liveClass.recordingUrl && /^\/uploads\/live\//.test(liveClass.recordingUrl)) fs.promises.unlink(path.join(LIVE_DIR, `${liveClass.id}.webm`)).catch(() => {});
  await prisma.liveClass.update({ where: { id: liveClass.id }, data: { recordingUrl: null } });
  res.json({ ok: true });
});

module.exports = router;
