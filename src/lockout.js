const prisma = require('./db');

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

// Password logins only (email + password). Access-code and join-code logins are covered
// by the IP rate limiter instead, since locking a shared code's account would let anyone
// who knows a name lock that person out.
function lockedMessage(user) {
  if (!user.lockedUntil || user.lockedUntil <= new Date()) return null;
  const minutes = Math.max(1, Math.ceil((user.lockedUntil - new Date()) / 60000));
  return `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

async function recordFailure(user) {
  const attempts = user.loginAttempts + 1;
  const data = attempts >= MAX_ATTEMPTS
    ? { loginAttempts: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60 * 1000) }
    : { loginAttempts: attempts };
  await prisma.user.update({ where: { id: user.id }, data });
}

async function clearFailures(user) {
  if (user.loginAttempts === 0 && !user.lockedUntil) return;
  await prisma.user.update({ where: { id: user.id }, data: { loginAttempts: 0, lockedUntil: null } });
}

module.exports = { lockedMessage, recordFailure, clearFailures, MAX_ATTEMPTS, LOCK_MINUTES };
