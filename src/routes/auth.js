const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const prisma = require('../db');
const { signToken, requireAuth, logActivity } = require('../auth');

const router = express.Router();

const STATUS_MESSAGE = {
  SUSPENDED: 'This account has been suspended. Contact your school administrator.',
  DISMISSED: 'This account has been deactivated.',
  EXPELLED: 'This account has been deactivated.',
};

function publicUser(u) {
  const { passwordHash, ...rest } = u;
  return rest;
}

function checkStatus(res, user) {
  if (user.status !== 'ACTIVE') {
    res.status(403).json({ error: STATUS_MESSAGE[user.status] || 'This account is inactive.', code: 'ACCOUNT_INACTIVE' });
    return false;
  }
  return true;
}

// Individual (non-school) learners self-register with just email + password -- no
// school or department, since they aren't affiliated with one. They get their own
// self-directed courses (see /individual-courses) taught by the AI Teacher, and never
// see school/lecturer-only features.
router.post('/register-individual', async (req, res) => {
  const { fullName, email, password } = req.body;
  if (!fullName || !email || !password) {
    return res.status(400).json({ error: 'Full name, email and password are required.' });
  }
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ error: 'An account with that email already exists' });

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { fullName, email, passwordHash, role: 'STUDENT', isIndividual: true, schoolId: null },
  });
  res.json({ token: signToken(user), user: publicUser(user) });
});

// Email + password -- used by school admins always, and as a fallback for anyone.
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
  if (!checkStatus(res, user)) return;

  if (user.role === 'LECTURER') await logActivity(user.id, 'LOGIN', null);
  res.json({ token: signToken(user), user: publicUser(user) });
});

// School-affiliated students and lecturers log in with the access code issued when
// the school registered them (in the school directory), not a password.
router.post('/login-with-code', async (req, res) => {
  const { fullName, schoolName, accessCode } = req.body;
  if (!fullName || !schoolName || !accessCode) {
    return res.status(400).json({ error: 'Full name, school name and access code are all required.' });
  }
  const school = await prisma.school.findFirst({
    where: { name: { equals: schoolName.trim(), mode: 'insensitive' } },
  });
  if (!school) return res.status(401).json({ error: 'No school found with that name.' });

  const user = await prisma.user.findFirst({
    where: {
      schoolId: school.id,
      accessCode: accessCode.trim().toUpperCase(),
      role: { in: ['STUDENT', 'LECTURER'] },
    },
  });
  if (!user || user.fullName.trim().toLowerCase() !== fullName.trim().toLowerCase()) {
    return res.status(401).json({ error: 'Name, school or access code did not match.' });
  }
  if (!checkStatus(res, user)) return;

  if (user.role === 'LECTURER') await logActivity(user.id, 'LOGIN', null);
  res.json({ token: signToken(user), user: publicUser(user) });
});

router.get('/me', requireAuth, async (req, res) => {
  res.json({ user: publicUser(req.user) });
});

module.exports = router;
