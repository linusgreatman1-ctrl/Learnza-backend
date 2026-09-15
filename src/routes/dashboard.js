const express = require('express');
const prisma = require('../db');
const { requireAuth, requireRole } = require('../auth');

const router = express.Router();

// One aggregated view across every enrolled course -- backs the "My Dashboard" screen
// (assignments, attendance summary, recent test scores). Notifications are fetched
// separately by the frontend via the existing /notifications endpoint. Works for both
// school students (real enrollments) and individual learners (who simply have none yet
// -- their app-generated activity lands here once that generator exists).
router.get('/students/me/dashboard', requireAuth, requireRole('STUDENT'), async (req, res) => {
  const enrollments = await prisma.enrollment.findMany({
    where: { studentId: req.user.id },
    select: { courseId: true },
  });
  const courseIds = enrollments.map((e) => e.courseId);

  const [assignments, mySubs, attendance, recentResults] = await Promise.all([
    courseIds.length
      ? prisma.assignment.findMany({
          where: { courseId: { in: courseIds } },
          include: { course: { select: { code: true } } },
          orderBy: { createdAt: 'desc' },
          take: 20,
        })
      : [],
    prisma.assignmentSubmission.findMany({ where: { studentId: req.user.id } }),
    prisma.classAttendanceRecord.findMany({
      where: { studentId: req.user.id },
      include: { course: { select: { code: true } } },
      orderBy: { date: 'desc' },
      take: 30,
    }),
    prisma.submission.findMany({
      where: { studentId: req.user.id },
      include: { assessment: { select: { title: true, type: true, course: { select: { code: true } } } } },
      orderBy: { submittedAt: 'desc' },
      take: 10,
    }),
  ]);
  const subByAssignment = new Map(mySubs.map((s) => [s.assignmentId, s]));
  const presentCount = attendance.filter((a) => a.status === 'PRESENT').length;

  res.json({
    assignments: assignments.map((a) => ({ ...a, mySubmission: subByAssignment.get(a.id) || null })),
    attendance: { recent: attendance, presentCount, totalCount: attendance.length },
    recentResults,
  });
});

module.exports = router;
