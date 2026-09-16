const express = require('express');
const prisma = require('../db');
const { requireAuth, requireRole, logActivity } = require('../auth');
const { notifyMany, notify, notifySchoolAdmins } = require('../services/notification.service');
const { getCurrentSemesterId } = require('../semester');

const router = express.Router();

router.get('/courses/:id/assignments', requireAuth, async (req, res) => {
  const assignments = await prisma.assignment.findMany({
    where: { courseId: req.params.id },
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
  const { title, instructions, dueAt, kind } = req.body;
  if (!title || !instructions) return res.status(400).json({ error: 'Title and instructions are required.' });
  const semesterId = await getCurrentSemesterId(req.user.schoolId);
  const assignment = await prisma.assignment.create({
    data: {
      courseId: req.params.id, title, instructions, dueAt: dueAt ? new Date(dueAt) : null,
      authorId: req.user.id, kind: kind === 'PROJECT' ? 'PROJECT' : 'ASSIGNMENT', semesterId,
    },
  });
  if (req.user.role === 'LECTURER') await logActivity(req.user.id, 'CREATE_ASSIGNMENT', title);

  const students = await prisma.enrollment.findMany({ where: { courseId: req.params.id }, select: { studentId: true } });
  const label = kind === 'PROJECT' ? 'New project posted' : 'New assignment posted';
  await notifyMany(students.map((s) => s.studentId), label, title, 'my-dashboard');

  res.json({ assignment });
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
  });
  res.json({ submission });
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
