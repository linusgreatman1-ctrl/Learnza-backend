const express = require('express');
const settings = require('../settings');
const bcrypt = require('bcryptjs');
const prisma = require('../db');
const crypto = require('crypto');
const { requireAuth, logActivity, schoolBlock } = require('../auth');
const { issueSession, consumeRefreshToken, revokeRefreshToken, revokeAllRefreshTokens, sha256 } = require('../session');
const { sendEmail } = require('../services/bulkMessage.service');
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
const INSTITUTION_TYPES = ['UNIVERSITY', 'POLYTECHNIC', 'MONOTECHNIC', 'COLLEGE_OF_EDUCATION', 'OTHER'];

router.post('/register-individual', async (req, res) => {
  if (!settings.get('registrationOpen')) return res.status(403).json({ error: 'New sign-ups are closed right now. Please check back soon.', code: 'REGISTRATION_CLOSED' });
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
  res.json({ ...(await issueSession(user, 'app')), user: publicUser(user) });
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
  res.json({ ...(await issueSession(user, 'app')), user: publicUser(user) });
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
  res.json({ ...(await issueSession(admin, 'schools')), user: publicUser(admin) });
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
  res.json({ ...(await issueSession(user, 'schools')), user: publicUser(user) });
});

// Swap a refresh token for a fresh access + refresh pair. Re-checks the account and the
// school (suspension, lapsed licence) every time, so losing access takes effect within
// one access-token lifetime even for someone who never signs out.
router.post('/refresh', async (req, res) => {
  const result = await consumeRefreshToken(req.body && req.body.refreshToken);
  if (!result) return res.status(401).json({ error: 'Session expired, please sign in again', code: 'SESSION_EXPIRED' });
  const { user, surface } = result;
  if (user.status !== 'ACTIVE') {
    return res.status(403).json({ error: STATUS_MESSAGE[user.status] || 'This account is inactive.', code: 'ACCOUNT_INACTIVE' });
  }
  if (user.schoolId) {
    const block = await schoolBlock(user.schoolId);
    if (block) return res.status(403).json(block);
  }
  res.json({ ...(await issueSession(user, surface)), user: publicUser(user) });
});

router.post('/logout', async (req, res) => {
  await revokeRefreshToken(req.body && req.body.refreshToken);
  res.json({ ok: true });
});

// ---- Forgot / reset password (email + password accounts: independent students) ----
// Always answers the same way whether or not the email exists, so it can't be used to
// find out who has an account.
router.post('/password/forgot', async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  if (email) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user && user.isIndividual && user.status === 'ACTIVE') {
      const raw = crypto.randomBytes(32).toString('base64url');
      await prisma.passwordReset.create({
        data: { userId: user.id, tokenHash: sha256(raw), expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
      });
      const link = req.protocol + '://' + req.get('host') + '/app#reset=' + raw;
      try {
        await sendEmail(
          user.email,
          'Reset your Learnza password',
          'Hi ' + user.fullName + ',\n\nSomeone asked to reset the password for your Learnza account. If that was you, open this link within the next hour:\n\n' + link + '\n\nIf it wasn\'t you, ignore this email and your password stays as it is.\n\n— Learnza'
        );
      } catch (err) {
        if (err.code !== 'EMAIL_NOT_CONFIGURED') console.error('Password reset email failed:', err.message);
        // With no email set up there is nowhere to send this; in development the link is
        // printed so the flow can still be tried. Never logged in production.
        else if (process.env.NODE_ENV !== 'production') console.log('[dev] password reset link for ' + user.email + ': ' + link);
      }
    }
  }
  res.json({ ok: true, message: 'If that email has a Learnza account, a reset link is on its way.' });
});

router.post('/password/reset', async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: 'The reset link and a new password are required.' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  const record = await prisma.passwordReset.findUnique({ where: { tokenHash: sha256(String(token)) } });
  if (!record || record.usedAt || record.expiresAt <= new Date()) {
    return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  await prisma.$transaction([
    prisma.user.update({ where: { id: record.userId }, data: { passwordHash, loginAttempts: 0, lockedUntil: null } }),
    prisma.passwordReset.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
  ]);
  await revokeAllRefreshTokens(record.userId);
  res.json({ ok: true });
});

// Resolved school/department names for the header strip -- the JWT-derived req.user
// only carries IDs, and the login response is deliberately lean, so this is a small
// separate fetch made once after auth rather than joining it onto every login.
router.get('/me', requireAuth, async (req, res) => {
  // Everything the app needs to draw its first screen, in one round trip: the school, the
  // department and the school's semester list (the app used to ask for the semesters in a second
  // request, after waiting for this one).
  const [school, department, semesters] = await Promise.all([
    req.user.schoolId ? prisma.school.findUnique({ where: { id: req.user.schoolId } }) : null,
    req.user.departmentId ? prisma.department.findUnique({ where: { id: req.user.departmentId } }) : null,
    req.user.schoolId ? prisma.semester.findMany({ where: { schoolId: req.user.schoolId }, orderBy: { createdAt: 'asc' } }) : [],
  ]);
  res.json({ user: publicUser(req.user), school: publicSchool(school, req.user.role), department, semesters });
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
  if (!ok) return res.status(400).json({ error: 'Current password is incorrect.' });
  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.user.update({ where: { id: req.user.id }, data: { passwordHash } });
  // Every refresh token is retired, so any other device or tab is signed out once its
  // current 15-minute access token lapses. The caller is handed a fresh pair to stay in.
  await revokeAllRefreshTokens(req.user.id);
  const surface = req.user.role === 'SUPER_ADMIN' ? 'admin' : (req.user.isIndividual ? 'app' : 'schools');
  res.json({ ok: true, ...(await issueSession(req.user, surface)) });
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
