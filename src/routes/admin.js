const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../db');
const { requireAuth, requireRole } = require('../auth');

const router = express.Router();
router.use(requireAuth, requireRole('ADMIN'));

router.get('/school', async (req, res) => {
  const school = await prisma.school.findUnique({ where: { id: req.user.schoolId } });
  res.json({ school });
});

router.get('/students', async (req, res) => {
  const students = await prisma.user.findMany({
    where: { schoolId: req.user.schoolId, role: 'STUDENT' },
    include: { department: true },
    orderBy: { fullName: 'asc' },
  });
  res.json({ students: students.map(({ passwordHash, ...s }) => s) });
});

router.get('/lecturers', async (req, res) => {
  const lecturers = await prisma.user.findMany({
    where: { schoolId: req.user.schoolId, role: 'LECTURER' },
    include: { department: true },
    orderBy: { fullName: 'asc' },
  });
  res.json({ lecturers: lecturers.map(({ passwordHash, ...l }) => l) });
});

// Monitoring reaches lecturer activity only -- students are never tracked here by design.
router.get('/lecturer-activity', async (req, res) => {
  const logs = await prisma.activityLog.findMany({
    where: { user: { schoolId: req.user.schoolId, role: 'LECTURER' } },
    include: { user: { select: { fullName: true } } },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  res.json({ logs });
});

router.post('/lecturers', async (req, res) => {
  const { fullName, email, password, staffId, departmentId } = req.body;
  if (!fullName || !email || !password || !departmentId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ error: 'An account with that email already exists' });
  const passwordHash = await bcrypt.hash(password, 10);
  const lecturer = await prisma.user.create({
    data: { fullName, email, passwordHash, staffId, departmentId, schoolId: req.user.schoolId, role: 'LECTURER' },
  });
  const { passwordHash: _, ...safe } = lecturer;
  res.json({ lecturer: safe });
});

router.post('/departments', async (req, res) => {
  const { name, code } = req.body;
  if (!name || !code) return res.status(400).json({ error: 'Name and code are required' });
  const department = await prisma.department.create({
    data: { name, code, schoolId: req.user.schoolId },
  });
  res.json({ department });
});

router.post('/courses', async (req, res) => {
  const { departmentId, code, title, level, semester } = req.body;
  if (!departmentId || !code || !title) return res.status(400).json({ error: 'Missing required fields' });
  const course = await prisma.course.create({
    data: { departmentId, code, title, level: level || 'NCE 1', semester: semester || 'First' },
  });
  res.json({ course });
});

module.exports = router;
