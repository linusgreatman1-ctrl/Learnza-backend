const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const prisma = require('../db');
const { requireAuth, requireRole } = require('../auth');

const router = express.Router();

// Public: no account needed to apply.
router.post('/admissions/apply', async (req, res) => {
  const { schoolId, departmentId, fullName, email, phone, level, statement } = req.body;
  if (!schoolId || !departmentId || !fullName || !email || !phone) {
    return res.status(400).json({ error: 'Full name, email, phone, and department are required.' });
  }
  const application = await prisma.application.create({
    data: { schoolId, departmentId, fullName, email, phone, level: level || 'NCE 1', statement: statement || null },
  });
  res.json({ application });
});

router.get('/admin/admissions', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const { status } = req.query;
  const applications = await prisma.application.findMany({
    where: { schoolId: req.user.schoolId, ...(status ? { status } : {}) },
    include: { department: { select: { name: true, code: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ applications });
});

router.post('/admin/admissions/:id/screen', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const application = await prisma.application.update({ where: { id: req.params.id }, data: { status: 'UNDER_REVIEW' } });
  res.json({ application });
});

router.post('/admin/admissions/:id/accept', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const application = await prisma.application.update({ where: { id: req.params.id }, data: { status: 'ACCEPTED', decidedAt: new Date() } });
  res.json({ application });
});

router.post('/admin/admissions/:id/reject', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const application = await prisma.application.update({ where: { id: req.params.id }, data: { status: 'REJECTED', decidedAt: new Date() } });
  res.json({ application });
});

// Turns an accepted application into a real student account: generates a matric
// number and a one-time temporary password (shown once here, for the admin to relay).
router.post('/admin/admissions/:id/register', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const application = await prisma.application.findUnique({
    where: { id: req.params.id },
    include: { school: true, department: true },
  });
  if (!application) return res.status(404).json({ error: 'Application not found' });
  if (application.status !== 'ACCEPTED') return res.status(400).json({ error: 'Only accepted applications can be registered.' });
  if (application.registeredUserId) return res.status(409).json({ error: 'This application has already been registered.' });

  const existingEmail = await prisma.user.findUnique({ where: { email: application.email } });
  if (existingEmail) return res.status(409).json({ error: 'A user with this email already exists.' });

  const matricNumber = await generateMatricNumber(application.school.name, application.departmentId, application.department.code);
  const tempPassword = crypto.randomBytes(4).toString('hex'); // 8 hex chars, easy to read aloud/relay
  const passwordHash = await bcrypt.hash(tempPassword, 10);

  const user = await prisma.user.create({
    data: {
      fullName: application.fullName,
      email: application.email,
      passwordHash,
      role: 'STUDENT',
      matricNumber,
      departmentId: application.departmentId,
      schoolId: application.schoolId,
    },
  });
  await prisma.application.update({
    where: { id: application.id },
    data: { status: 'REGISTERED', registeredUserId: user.id },
  });

  res.json({ user: { fullName: user.fullName, email: user.email, matricNumber }, tempPassword });
});

async function generateMatricNumber(schoolName, departmentId, deptCode) {
  const prefix = schoolName.split(' ').map((w) => w[0]).join('').toUpperCase();
  const year = String(new Date().getFullYear()).slice(-2);
  const count = await prisma.user.count({ where: { departmentId, role: 'STUDENT' } });
  const seq = String(count + 1).padStart(3, '0');
  return `${prefix}/${year}/${deptCode}/${seq}`;
}

module.exports = router;
