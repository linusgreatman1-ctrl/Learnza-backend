const express = require('express');
const prisma = require('../db');
const { requireAuth, requireRole, logActivity } = require('../auth');
const { notifyMany, notify, notifySchoolAdmins } = require('../services/notification.service');
const { getCurrentSemesterId } = require('../semester');

const router = express.Router();

router.get('/courses/:id/assignments', requireAuth, async (req, res) => {
  const assignments = await prisma.assignment.findMany({
    // Same draft/send pattern as Assessment/Result -- a draft (sentAt null) is the
    // lecturer's own unsent working copy, invisible to students.
    where: { courseId: req.params.id, ...(req.user.role === 'STUDENT' ? { sentAt: { not: null } } : {}) },
    include: { _count: { select: { submissions: true } } },
    orderBy: { createdAt: 'desc' },
  });
  if (req.user.role !== 'STUDENT') return res.json({ assignments });

  // Attach the student's own submission (if any) so the UI can show submitted/marked state.
  const mySubs = await prisma.assignmentSubmission.findMany({
    where: { studentId: req.user.id, assignmentId: { in: assignments.map((a) => a.id) } },
  });
  const byAssignment = new Map(mySubs.map((s) => [s.assignmentId, s]));
  res.json({ assignments: assignments.map((a) => ({ ...a, mySubmission: byAssignment.get(a.id) || null })) });
});

router.post('/courses/:id/assignments', requireAuth, requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  const { title, instructions, dueAt, kind, send } = req.body;
  if (!title || !instructions) return res.status(400).json({ error: 'Title and instructions are required.' });
  const semesterId = await getCurrentSemesterId(req.user.schoolId);
  const assignment = await prisma.assignment.create({
    data: {
      courseId: req.params.id, title, instructions, dueAt: dueAt ? new Date(dueAt) : null,
      authorId: req.user.id, kind: kind === 'PROJECT' ? 'PROJECT' : 'ASSIGNMENT', semesterId,
      sentAt: send === false ? null : new Date(),
    },
  });
  if (req.user.role === 'LECTURER') await logActivity(req.user.id, 'CREATE_ASSIGNMENT', title);

  if (send !== false) {
    const students = await prisma.enrollment.findMany({ where: { courseId: req.params.id }, select: { studentId: true } });
    const label = kind === 'PROJECT' ? 'New project posted' : 'New assignment posted';
    await notifyMany(students.map((s) => s.studentId), label, title, 'my-dashboard');
  }

  res.json({ assignment });
});

// Edits a draft (unsent) assignment's own details. Once it's out, the content stays
// fixed -- a student may already be partway through writing an answer to it, so
// changing the instructions under them isn't safe the way it is while still a draft.
router.put('/assignments/:id', requireAuth, requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  const { title, instructions, dueAt, kind, send } = req.body;
  const assignment = await prisma.assignment.findUnique({ where: { id: req.params.id } });
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
  if (assignment.authorId !== req.user.id && req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'You can only edit assignments you created.' });
  }
  if (assignment.sentAt) return res.status(400).json({ error: 'This has already been sent and can no longer be edited.' });
  if (!title || !instructions) return res.status(400).json({ error: 'Title and instructions are required.' });

  const updated = await prisma.assignment.update({
    where: { id: assignment.id },
    data: {
      title, instructions, dueAt: dueAt ? new Date(dueAt) : null,
      kind: kind === 'PROJECT' ? 'PROJECT' : 'ASSIGNMENT',
      sentAt: send === true ? new Date() : null,
    },
  });
  if (send === true) {
    const students = await prisma.enrollment.findMany({ where: { courseId: assignment.courseId }, select: { studentId: true } });
    const label = updated.kind === 'PROJECT' ? 'New project posted' : 'New assignment posted';
    await notifyMany(students.map((s) => s.studentId), label, title, 'my-dashboard');
  }
  res.json({ assignment: updated });
});

// Sends (or resends) an already-created assignment/project to its class.
router.post('/assignments/:id/send', requireAuth, requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  const assignment = await prisma.assignment.findUnique({ where: { id: req.params.id } });
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
  if (assignment.authorId !== req.user.id && req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'You can only send assignments you created.' });
  }
  const updated = await prisma.assignment.update({ where: { id: assignment.id }, data: { sentAt: assignment.sentAt || new Date() } });
  const students = await prisma.enrollment.findMany({ where: { courseId: assignment.courseId }, select: { studentId: true } });
  const label = assignment.kind === 'PROJECT' ? 'New project posted' : 'New assignment posted';
  await notifyMany(students.map((s) => s.studentId), label, assignment.title, 'my-dashboard');
  res.json({ assignment: updated });
});

// One assignment's full detail + the caller's own submission -- powers a click-through
// detail view from My Dashboard's assignment list instead of only the inline summary.
router.get('/assignments/:id', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const assignment = await prisma.assignment.findUnique({
    where: { id: req.params.id },
    include: { course: { select: { code: true, title: true } } },
  });
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
  const mySubmission = await prisma.assignmentSubmission.findUnique({
    where: { assignmentId_studentId: { assignmentId: assignment.id, studentId: req.user.id } },
  });
  res.json({ assignment, mySubmission });
});

router.post('/assignments/:id/submit', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const { answerText } = req.body;
  if (!answerText || !answerText.trim()) return res.status(400).json({ error: 'Write an answer before submitting.' });
  const existing = await prisma.assignmentSubmission.findUnique({
    where: { assignmentId_studentId: { assignmentId: req.params.id, studentId: req.user.id } },
  });
  if (existing) return res.status(409).json({ error: 'You already submitted this assignment.' });

  const submission = await prisma.assignmentSubmission.create({
    data: { assignmentId: req.params.id, studentId: req.user.id, answerText: answerText.trim() },
    include: { assignment: { select: { title: true, authorId: true } }, student: { select: { fullName: true } } },
  });
  // The lecturer had no way to know new work had come in short of reopening every
  // assignment to check -- this is what was missing from "set assignment -> student
  // submits" round-tripping back to them.
  await notify(submission.assignment.authorId, 'New submission', `${submission.student.fullName} submitted "${submission.assignment.title}".`, 'lect-mark-work');
  res.json({ submission });
});

// Every not-yet-marked submission across every course this lecturer teaches -- powers
// the "Mark Work" hub as a single inbox instead of checking each assignment one by one.
router.get('/lecturer/unmarked-assignment-submissions', requireAuth, requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  const submissions = await prisma.assignmentSubmission.findMany({
    where: { status: { not: 'MARKED' }, assignment: { authorId: req.user.id } },
    include: {
      assignment: { select: { id: true, title: true, kind: true, course: { select: { id: true, code: true, title: true } } } },
      student: { select: { fullName: true, matricNumber: true } },
    },
    orderBy: { submittedAt: 'asc' },
  });
  res.json({ submissions });
});

// Lecturer: submissions for one assignment, to mark.
router.get('/assignments/:id/submissions', requireAuth, requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  const submissions = await prisma.assignmentSubmission.findMany({
    where: { assignmentId: req.params.id },
    include: { student: { select: { fullName: true, matricNumber: true } } },
    orderBy: { submittedAt: 'asc' },
  });
  res.json({ submissions });
});

router.post('/assignment-submissions/:id/mark', requireAuth, requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  const { score, feedback } = req.body;
  if (score === undefined || score === null || Number.isNaN(Number(score))) {
    return res.status(400).json({ error: 'A numeric score is required.' });
  }
  const submission = await prisma.assignmentSubmission.update({
    where: { id: req.params.id },
    data: { score: Number(score), feedback: feedback || null, status: 'MARKED', markedAt: new Date() },
    include: {
      assignment: { select: { title: true } },
      student: { select: { fullName: true, schoolId: true } },
    },
  });
  await notify(submission.studentId, 'Assignment marked', `${submission.assignment.title}: ${score} — check your assignments for feedback.`, 'my-dashboard');
  await notifySchoolAdmins(
    submission.student.schoolId,
    'Score released',
    `${submission.student.fullName} scored ${score} on "${submission.assignment.title}".`,
    'admin-student-activity'
  );
  res.json({ submission });
});

module.exports = router;
