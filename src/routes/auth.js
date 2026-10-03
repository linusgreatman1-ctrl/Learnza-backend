const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../db');
const { signToken, requireAuth, logActivity } = require('../auth');
const { memoryUpload, saveUpload } = require('../services/fileUpload.service');
const { safeEqual } = require('../utils');
const { lockedMessage, recordFailure, clearFailures } = require('../lockout');

const router = express.Router();
const avatarUpload = memoryUpload(5); // a profile picture, not a lecture video -- keep it small

const STATUS_MESSAGE = {
  SUSPENDED: 'This account has been suspended. Contact your school administrator.',
  DISMISSED: 'This account has been deactivated.',
  EXPELLED: 'This account has been deactivated.',
};

function publicUser(u) {
  const { passwordHash, loginAttempts, lockedUntil, ...rest } = u;
  return rest;
}

// The join code is the school admin's credential, so it (and the school's contact
// details) only go back to a signed-in admin of that school -- never to the students and
// lecturers whose own /me call also returns their school.
function publicSchool(school, role) {
  if (!school) return null;
  const base = { id: school.id, name: school.name, state: school.state, status: school.status, subscriptionExpiresAt: school.subscriptionExpiresAt };
  if (role !== 'ADMIN') return base;
  return { ...base, address: school.address, contactEmail: school.contactEmail, contactPhone: school.contactPhone, joinCode: school.joinCode };
}

function checkStatus(res, user) {
  if (user.status !== 'ACTIVE') {
    res.status(403).json({ error: STATUS_MESSAGE[user.status] || 'This account is inactive.', code: 'ACCOUNT_INACTIVE' });
    return false;
  }
  return true;
}

// A school that's been suspended by the platform, or whose licence has lapsed, can't be
// signed into from the Schools app at all -- checked at every school-facing login.
function checkSchoolAccess(res, school) {
  if (school.status !== 'ACTIVE') {
    res.status(403).json({ error: "This school's account is suspended. Contact Learnza.", code: 'SCHOOL_SUSPENDED' });
    return false;
  }
  if (school.subscriptionExpiresAt && school.subscriptionExpiresAt <= new Date()) {
    res.status(403).json({ error: "This school's Learnza licence has expired. Ask your school to renew it.", code: 'SCHOOL_LICENCE_EXPIRED' });
    return false;
  }
  return true;
}

// Independent (non-school) learners self-register -- no Learnza school or department,
// and deliberately no link to one at all. attendedSchoolName/attendedDepartment/
// courseOfStudy describe their real institution for display purposes only. They get
// their own self-directed courses (see /individual-courses) taught by the AI Teacher.
const INSTITUTION_TYPES = ['UNIVERSITY', 'POLYTECHNIC', 'COLLEGE_OF_EDUCATION', 'OTHER'];

router.post('/register-individual', async (req, res) => {
  const { fullName, password, phone, attendedSchoolName, attendedDepartment, courseOfStudy, institutionType, yearOfStudy } = req.body;
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!fullName || !email || !password) {
    return res.status(400).json({ error: 'Full name, email and password are required.' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  if (!institutionType || !INSTITUTION_TYPES.includes(institutionType)) {
    return res.status(400).json({ error: 'Select an institution type.' });
  }
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ error: 'An account with that email already exists' });

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: {
      fullName: String(fullName).trim(), email, passwordHash, phone: phone || null,
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

// Email + password -- the Student app's sign-in. Only independent learners sign in this
// way: school users use the join code / access code endpoints below, and the platform
// owner signs in at /api/super/login. Anything else gets the same message as a wrong
// password so this endpoint can't be used to probe which emails belong to school staff.
router.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const { password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.isIndividual || user.role !== 'STUDENT') {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const locked = lockedMessage(user);
  if (locked) return res.status(429).json({ error: locked, code: 'ACCOUNT_LOCKED' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    await recordFailure(user);
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  if (!checkStatus(res, user)) return;
  await clearFailures(user);
  res.json({ token: signToken(user), user: publicUser(user) });
});

// The Schools app's "School" sign-in: the school's name plus the permanent join code the
// platform issued when it onboarded the school. Signs in as the school's founding admin
// account (a real ADMIN user row created at onboarding, so every permission check works
// exactly as for any other admin). The join code is the whole credential -- there is
// deliberately no password for the founding admin.
router.post('/school-login', async (req, res) => {
  const { schoolName, joinCode } = req.body;
  if (!schoolName || !joinCode) return res.status(400).json({ error: 'School name and join code are required.' });
  const school = await prisma.school.findFirst({
    where: { name: { equals: String(schoolName).trim(), mode: 'insensitive' } },
  });
  if (!school || !safeEqual(school.joinCode, String(joinCode).trim().toUpperCase())) {
    return res.status(401).json({ error: 'School name or join code did not match.' });
  }
  if (!checkSchoolAccess(res, school)) return;

  const admin = await prisma.user.findFirst({
    where: { schoolId: school.id, role: 'ADMIN', status: 'ACTIVE' },
    orderBy: { createdAt: 'asc' },
  });
  if (!admin) return res.status(403).json({ error: 'This school has no active admin account. Contact Learnza.' });
  res.json({ token: signToken(admin), user: publicUser(admin) });
});

// School-affiliated students, lecturers, staff and additional admins sign in with the
// access code issued when the school added them -- along with their exact name and the
// school's name, so a code on its own is never enough.
router.post('/login-with-code', async (req, res) => {
  const { fullName, schoolName, accessCode } = req.body;
  if (!fullName || !schoolName || !accessCode) {
    return res.status(400).json({ error: 'Full name, school name and access code are all required.' });
  }
  const school = await prisma.school.findFirst({
    where: { name: { equals: String(schoolName).trim(), mode: 'insensitive' } },
  });
  if (!school) return res.status(401).json({ error: 'No school found with that name.' });

  const user = await prisma.user.findFirst({
    where: {
      schoolId: school.id,
      accessCode: String(accessCode).trim().toUpperCase(),
      role: { in: ['STUDENT', 'LECTURER', 'STAFF', 'ADMIN'] },
    },
  });
  if (!user || user.fullName.trim().toLowerCase() !== String(fullName).trim().toLowerCase()) {
    return res.status(401).json({ error: 'Name, school or access code did not match.' });
  }
  if (!checkSchoolAccess(res, school)) return;
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
  res.json({ user: publicUser(req.user), school: publicSchool(school, req.user.role), department });
});

// ---- Settings: shared by every role (student, lecturer, admin, staff) ----

// Edit Profile -- only the fields every role can safely self-edit; anything
// role-specific (matric number, access code, department, etc.) is admin-managed.
// Self-editable fields, every role: name, phone, and -- for independent learners only,
// since there's no admin managing these for them -- their real institution details and
// level. School-affiliated identity fields (matric number, staff ID, department) stay
// admin-managed (Staff & Student Directory).
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
module.exports.publicUser = publicUser;
module.exports.publicSchool = publicSchool;
