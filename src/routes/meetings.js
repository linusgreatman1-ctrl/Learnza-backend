const express = require('express');
const prisma = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { notifyMany } = require('../services/notification.service');

// Meetings: a school admin starts a video or audio meeting with the staff, and schedules meetings and other activities
// (title, date and time, a note) with a reminder. Same star shape as a live class: the host sees and hears everyone who
// joins, and each person who joins sees and hears the host (see realtime/meeting.js).
const router = express.Router();
router.use(requireAuth);

// Who can be invited to a meeting. `roles` are account roles in the host's school.
const AUDIENCES = {
  STAFF: { label: 'Staff (lecturers and other staff)', roles: ['LECTURER', 'STAFF'] },
};

const clean = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

async function inviteesOf(host, audience) {
  const a = AUDIENCES[audience];
  if (!a || !host.schoolId) return [];
  return prisma.user.findMany({ where: { schoolId: host.schoolId, role: { in: a.roles }, status: 'ACTIVE', NOT: { id: host.id } }, select: { id: true, fullName: true, role: true, position: true }, orderBy: { fullName: 'asc' } });
}

// May this person join this meeting (as someone invited, or as its host)?
async function mayJoin(user, meeting) {
  if (!meeting || meeting.status !== 'ACTIVE') return false;
  if (meeting.hostId === user.id) return true;
  const a = AUDIENCES[meeting.audience];
  return !!(a && meeting.schoolId && meeting.schoolId === user.schoolId && a.roles.includes(user.role));
}

router.get('/meetings/audiences', requireRole('ADMIN'), async (req, res) => {
  const out = [];
  for (const [key, a] of Object.entries(AUDIENCES)) out.push({ key, label: a.label, people: (await inviteesOf(req.user, key)).length });
  res.json({ audiences: out });
});

router.get('/meetings/roster', requireRole('ADMIN'), async (req, res) => {
  res.json({ people: await inviteesOf(req.user, String(req.query.audience || 'STAFF')) });
});

// Meetings going on now that this person may join (or is hosting).
router.get('/meetings/active', async (req, res) => {
  if (!req.user.schoolId) return res.json({ meetings: [] });
  const rows = await prisma.meeting.findMany({ where: { schoolId: req.user.schoolId, status: 'ACTIVE' }, orderBy: { startedAt: 'desc' } });
  const mine = [];
  for (const m of rows) if (await mayJoin(req.user, m)) mine.push(m);
  const hosts = await prisma.user.findMany({ where: { id: { in: mine.map((m) => m.hostId) } }, select: { id: true, fullName: true } });
  res.json({ meetings: mine.map((m) => ({ id: m.id, title: m.title, audience: m.audience, video: m.video, startedAt: m.startedAt, hosting: m.hostId === req.user.id, hostName: (hosts.find((h) => h.id === m.hostId) || {}).fullName || '' })) });
});

router.post('/meetings/start', requireRole('ADMIN'), async (req, res) => {
  const audience = AUDIENCES[req.body.audience] ? req.body.audience : 'STAFF';
  const video = req.body.video !== false;
  const title = clean(req.body.title, 120) || (video ? 'Video meeting' : 'Audio meeting');
  const people = await inviteesOf(req.user, audience);
  if (!people.length) return res.status(400).json({ error: 'There is nobody to invite yet. Add staff first.' });
  await prisma.meeting.updateMany({ where: { hostId: req.user.id, status: 'ACTIVE' }, data: { status: 'ENDED', endedAt: new Date() } });
  const meeting = await prisma.meeting.create({ data: { schoolId: req.user.schoolId, hostId: req.user.id, title, audience, video } });
  await notifyMany(people.map((p) => p.id), `${req.user.fullName} has started a ${video ? 'video' : 'audio'} meeting — tap to join`, title, `meeting-room?meetingId=${meeting.id}`);
  res.json({ meeting: { id: meeting.id, title, audience, video, invited: people.length } });
});

router.post('/meetings/:id/end', async (req, res) => {
  const m = await prisma.meeting.findUnique({ where: { id: req.params.id } });
  if (!m || m.hostId !== req.user.id) return res.status(404).json({ error: 'Meeting not found.' });
  if (m.status === 'ACTIVE') await prisma.meeting.update({ where: { id: m.id }, data: { status: 'ENDED', endedAt: new Date() } });
  await prisma.notification.updateMany({ where: { link: { contains: 'meetingId=' + m.id } }, data: { title: `${req.user.fullName} held a meeting`, body: `${m.title} · the meeting has ended`, link: null } });
  try { require('../realtime/meeting').endMeeting(m.id); } catch { /* the sockets are tidied up when they drop */ }
  res.json({ ok: true });
});

// A meeting someone is invited to open from a link: can I join it?
router.get('/meetings/:id', async (req, res) => {
  const m = await prisma.meeting.findUnique({ where: { id: req.params.id } });
  if (!m) return res.status(404).json({ error: 'Meeting not found.' });
  if (m.status !== 'ACTIVE') return res.json({ meeting: { id: m.id, title: m.title, status: m.status, video: m.video } });
  if (!(await mayJoin(req.user, m))) return res.status(403).json({ error: 'You are not invited to this meeting.' });
  const host = await prisma.user.findUnique({ where: { id: m.hostId }, select: { fullName: true } });
  res.json({ meeting: { id: m.id, title: m.title, status: m.status, video: m.video, hosting: m.hostId === req.user.id, hostName: host ? host.fullName : '' } });
});

// ── schedules: meetings and other activities, with a reminder; each person's own schedule is private to them ──────────
router.get('/meeting-schedules', requireRole('ADMIN'), async (req, res) => {
  const rows = await prisma.meetingSchedule.findMany({ where: { ownerId: req.user.id }, orderBy: { whenAt: 'asc' } });
  res.json({ schedules: rows });
});
router.post('/meeting-schedules', requireRole('ADMIN'), async (req, res) => {
  const title = clean(req.body.title, 140);
  const whenAt = new Date(req.body.when);
  if (!title) return res.status(400).json({ error: 'Give the meeting or activity a title.' });
  if (isNaN(whenAt.getTime())) return res.status(400).json({ error: 'Choose the date and time.' });
  const row = await prisma.meetingSchedule.create({ data: { schoolId: req.user.schoolId, ownerId: req.user.id, title, whenAt, note: clean(req.body.note, 400) || null, audience: AUDIENCES[req.body.audience] ? req.body.audience : null } });
  res.json({ schedule: row });
});
router.delete('/meeting-schedules/:id', requireRole('ADMIN'), async (req, res) => {
  await prisma.meetingSchedule.deleteMany({ where: { id: req.params.id, ownerId: req.user.id } });
  res.json({ ok: true });
});

// Reminders: a schedule that is about to start (within 15 minutes) tells its owner, once.
function startScheduleReminders() {
  const tick = async () => {
    try {
      const soon = new Date(Date.now() + 15 * 60 * 1000);
      const due = await prisma.meetingSchedule.findMany({ where: { reminded: false, whenAt: { lte: soon, gte: new Date(Date.now() - 6 * 3600 * 1000) } }, take: 100 });
      for (const s of due) {
        await prisma.meetingSchedule.update({ where: { id: s.id }, data: { reminded: true } });
        await notifyMany([s.ownerId], `Coming up: ${s.title}`, `${s.whenAt.toLocaleString('en-NG')}${s.note ? ' · ' + s.note : ''}`, 'my-schedules');
      }
    } catch { /* tries again next minute */ }
  };
  const t = setInterval(tick, 60 * 1000);
  if (t.unref) t.unref();
}

module.exports = router;
module.exports.mayJoin = mayJoin;
module.exports.AUDIENCES = AUDIENCES;
module.exports.startScheduleReminders = startScheduleReminders;
