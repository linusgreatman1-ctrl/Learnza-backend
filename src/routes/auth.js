const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const prisma = require('../db');
const { signToken, requireAuth, logActivity } = require('../auth');
const { memoryUpload, saveUpload } = require('../services/fileUpload.service');

const router = express.Router();
const avatarUpload = memoryUpload(5); // a profile picture, not a lecture video -- keep it small

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

// Individual (non-school) learners self-register -- no Learnza school or department,
// and deliberately no link to one at all: they aren't affiliated with any Learnza
// School row, ever (their own uploads/textbooks are a separate, school-independent
// concern). attendedSchoolName/attendedDepartment/courseOfStudy describe their real
// institution for display purposes only. They get their own self-directed courses
// (see /individual-courses) taught by the AI Teacher, and never see school/
// lecturer-only or e-Library features.
const INSTITUTION_TYPES = ['UNIVERSITY', 'POLYTECHNIC', 'COLLEGE_OF_EDUCATION', 'OTHER'];

router.post('/register-individual', async (req, res) => {
  const { fullName, email, password, phone, attendedSchoolName, attendedDepartment, courseOfStudy, institutionType, yearOfStudy } = req.body;
  if (!fullName || !email || !password) {
    return res.status(400).json({ error: 'Full name, email and password are required.' });
  }
  if (!institutionType || !INSTITUTION_TYPES.includes(institutionType)) {
    return res.status(400).json({ error: 'Select an institution type.' });
  }
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ error: 'An account with that email already exists' });

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: {
      fullName, email, passwordHash, phone: phone || null,
      role: 'STUDENT', isIndividual: true, schoolId: null,
      attendedSchoolName: attendedSchoolName || null,
      attendedDepartment: attendedDepartment || null,
      courseOfStudy: courseOfStudy || null,
      institutionType,
      yearOfStudy: yearOfStudy ? parseInt(yearOfStudy, 10) : null,
    },
  });
  res.json({ token: signToken(user), user: publicUser(user) });
});

// A school self-registers here: creates the School row plus its first ADMIN account
// in one step. Every other school-affiliated user (lecturer, staff, student) is then
// created by that admin from the school directory, not by self-registration.
router.post('/register-school', async (req, res) => {
  const { schoolName, location, fullName, email, password, phone } = req.body;
  if (!schoolName || !fullName || !email || !password) {
    return res.status(400).json({ error: 'School name, your full name, email and password are required.' });
  }
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ error: 'An account with that email already exists' });

  const passwordHash = await bcrypt.hash(password, 10);
  const school = await prisma.school.create({
    data: {
      name: schoolName,
      location: location || null,
      licenseExpiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    },
  });
  const user = await prisma.user.create({
    data: { fullName, email, passwordHash, phone: phone || null, role: 'ADMIN', schoolId: school.id },
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
      role: { in: ['STUDENT', 'LECTURER', 'STAFF'] },
    },
  });
  if (!user || user.fullName.trim().toLowerCase() !== fullName.trim().toLowerCase()) {
    return res.status(401).json({ error: 'Name, school or access code did not match.' });
  }
  if (!checkStatus(res, user)) return;

  if (user.role === 'LECTURER') await logActivity(user.id, 'LOGIN', null);
  res.json({ token: signToken(user), user: publicUser(user) });
});

// Resolved school/department names for the header strip -- the JWT-derived req.user
// only carries IDs, and the login response is deliberately lean, so this is a small
// separate fetch made once after auth rather than joining it onto every login.
router.get('/me', requireAuth, async (req, res) => {
  let school = null;
  let department = null;
  if (req.user.schoolId) school = await prisma.school.findUnique({ where: { id: req.user.schoolId } });
  if (req.user.departmentId) department = await prisma.department.findUnique({ where: { id: req.user.departmentId } });
  res.json({ user: publicUser(req.user), school, department });
});

// ---- Settings: shared by every role (student, lecturer, admin, staff) ----

// Edit Profile -- only the fields every role can safely self-edit; anything
// role-specific (matric number, access code, department, etc.) is admin-managed.
// Self-editable fields, every role: name, phone, and -- for individual learners only,
// since there's no admin managing these for them -- their real institution details and
// level. School-affiliated identity fields (matric number, staff ID, department) stay
// admin-managed (Staff & Student Directory), same as before.
router.patch('/me', requireAuth, async (req, res) => {
  const { fullName, phone, attendedSchoolName, attendedDepartment, courseOfStudy, institutionType, yearOfStudy } = req.body;
  const data = {};
  if (fullName !== undefined) {
    if (!fullName.trim()) return res.status(400).json({ error: 'Name cannot be empty.' });
    data.fullName = fullName.trim();
  }
  if (phone !== undefined) data.phone = phone || null;
  if (req.user.isIndividual) {
    if (attendedSchoolName !== undefined) data.attendedSchoolName = attendedSchoolName || null;
    if (attendedDepartment !== undefined) data.attendedDepartment = attendedDepartment || null;
    if (courseOfStudy !== undefined) data.courseOfStudy = courseOfStudy || null;
    if (institutionType !== undefined && INSTITUTION_TYPES.includes(institutionType)) data.institutionType = institutionType;
    if (yearOfStudy !== undefined) data.yearOfStudy = yearOfStudy ? parseInt(yearOfStudy, 10) : null;
  }
  const user = await prisma.user.update({ where: { id: req.user.id }, data });
  res.json({ user: publicUser(user) });
});

router.post('/me/avatar', requireAuth, avatarUpload.single('avatar'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose an image first.' });
  let avatarUrl, storage;
  try {
    ({ url: avatarUrl, storage } = await saveUpload(req.file));
  } catch {
    return res.status(502).json({ error: 'Upload failed. Please try again.' });
  }
  const user = await prisma.user.update({ where: { id: req.user.id }, data: { avatarUrl } });
  res.json({ user: publicUser(user), storage });
});

router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new password are required.' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  const ok = await bcrypt.compare(currentPassword, req.user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Current password is incorrect.' });
  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.user.update({ where: { id: req.user.id }, data: { passwordHash } });
  res.json({ ok: true });
});

// "Mute notifications" -- suppresses new in-app notifications for this user without
// deleting anything already delivered; checked centrally in notification.service.js.
router.patch('/me/notifications', requireAuth, async (req, res) => {
  const user = await prisma.user.update({ where: { id: req.user.id }, data: { notificationsMuted: !!req.body.muted } });
  res.json({ user: publicUser(user) });
});

module.exports = router;
