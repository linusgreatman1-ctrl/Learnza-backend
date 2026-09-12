const express = require('express');
const prisma = require('../db');
const { requireAuth, requireRole, logActivity } = require('../auth');
const { requireActiveSubscription } = require('../subscription');
const labDemo = require('../services/labDemo.service');

const router = express.Router();

function shape(demo) {
  return { ...demo, steps: JSON.parse(demo.stepsJson) };
}

// Approved demonstrations for a course, plus the current user's own pending requests
// (so they can see "waiting on admin review" without exposing other students' requests).
router.get('/courses/:id/lab', requireAuth, async (req, res) => {
  const approved = await prisma.labDemonstration.findMany({
    where: { courseId: req.params.id, status: 'APPROVED' },
    orderBy: { createdAt: 'desc' },
  });
  const ownPending =
    req.user.role === 'STUDENT'
      ? await prisma.labDemonstration.findMany({
          where: { courseId: req.params.id, status: 'PENDING', authorId: req.user.id },
          orderBy: { createdAt: 'desc' },
        })
      : [];
  res.json({ demonstrations: [...approved, ...ownPending].map(shape) });
});

// Lecturer/admin-authored demonstrations are trusted content -- approved immediately.
router.post('/courses/:id/lab', requireAuth, requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  const { title, description, steps } = req.body;
  if (!title || !Array.isArray(steps) || steps.length === 0) {
    return res.status(400).json({ error: 'Title and at least one step are required.' });
  }
  const demo = await prisma.labDemonstration.create({
    data: {
      courseId: req.params.id,
      title,
      description: description || '',
      stepsJson: JSON.stringify(steps),
      source: 'CURATED',
      status: 'APPROVED',
      authorId: req.user.id,
    },
  });
  if (req.user.role === 'LECTURER') await logActivity(req.user.id, 'CREATE_LAB_DEMO', title);
  res.json({ demonstration: shape(demo) });
});

// Student requests a practical on a topic not yet covered -- AI drafts it, but it
// stays invisible to everyone (including the requester's classmates) until an admin
// reviews and approves it.
router.post('/courses/:id/lab/generate', requireAuth, requireRole('STUDENT'), requireActiveSubscription, async (req, res) => {
  const { topic } = req.body;
  if (!topic || !topic.trim()) return res.status(400).json({ error: 'Describe the practical topic first.' });
  const course = await prisma.course.findUnique({ where: { id: req.params.id } });
  if (!course) return res.status(404).json({ error: 'Course not found' });

  try {
    const draft = await labDemo.generateDemonstration({ courseTitle: course.title, topic });
    const demo = await prisma.labDemonstration.create({
      data: {
        courseId: course.id,
        title: draft.title,
        description: draft.description,
        stepsJson: JSON.stringify(draft.steps),
        source: 'AI_GENERATED',
        status: 'PENDING',
        authorId: req.user.id,
      },
    });
    res.json({ demonstration: shape(demo) });
  } catch (err) {
    if (err.code === 'AI_NOT_CONFIGURED') return res.status(503).json({ error: err.message, code: err.code });
    res.status(502).json({ error: 'Could not generate that demonstration. Please try again.' });
  }
});

// Admin approval queue.
router.get('/admin/lab/pending', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const pending = await prisma.labDemonstration.findMany({
    where: { status: 'PENDING', course: { department: { schoolId: req.user.schoolId } } },
    include: { course: { select: { code: true, title: true } }, author: { select: { fullName: true } } },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ pending: pending.map(shape) });
});

router.post('/admin/lab/:id/approve', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const demo = await prisma.labDemonstration.update({ where: { id: req.params.id }, data: { status: 'APPROVED' } });
  res.json({ demonstration: shape(demo) });
});

router.post('/admin/lab/:id/reject', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const demo = await prisma.labDemonstration.update({ where: { id: req.params.id }, data: { status: 'REJECTED' } });
  res.json({ demonstration: shape(demo) });
});

module.exports = router;
