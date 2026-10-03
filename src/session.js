const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const prisma = require('./db');

// Short-lived access token + long-lived rotating refresh token (same scheme as PassNow).
//  - The access token is a JWT that proves who you are for ~15 minutes.
//  - The refresh token is an opaque random string; only its SHA-256 hash is stored, so a
//    database leak can't be turned into live sessions. Each use of it hands back a brand
//    new pair and retires the old one.
//  - A just-retired refresh token stays usable for a few seconds, so two requests that
//    refresh at the same moment (two tabs, or a page firing several calls as the access
//    token lapses) don't knock the user out.
const ACCESS_TTL = process.env.ACCESS_TOKEN_TTL || '15m';
const REFRESH_DAYS = 30;
const GRACE_MS = 15 * 1000;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function signAccessToken(user) {
  return jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: ACCESS_TTL });
}

// surface: 'app' | 'schools' | 'admin' -- which frontend the login came from.
async function issueSession(user, surface) {
  const raw = crypto.randomBytes(48).toString('base64url');
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: sha256(raw),
      surface,
      expiresAt: new Date(Date.now() + REFRESH_DAYS * 24 * 60 * 60 * 1000),
    },
  });
  // Housekeeping: expired tokens, and ones retired more than a day ago, are dead weight.
  prisma.refreshToken
    .deleteMany({ where: { userId: user.id, OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } }] } })
    .catch(() => {});
  return { token: signAccessToken(user), refreshToken: raw };
}

// Retires the presented refresh token and returns { user, surface } so the caller can
// issue its replacement -- or null if the token is unknown, expired, or was retired too
// long ago to be a harmless race.
async function consumeRefreshToken(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const record = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(raw) }, include: { user: true } });
  if (!record || record.expiresAt <= new Date()) return null;
  if (record.revokedAt) {
    if (Date.now() - record.revokedAt.getTime() > GRACE_MS) return null;
  } else {
    // updateMany + revokedAt:null makes retiring atomic: of two simultaneous refreshes
    // only one flips it, the other falls through to the grace window above next time.
    await prisma.refreshToken.updateMany({ where: { id: record.id, revokedAt: null }, data: { revokedAt: new Date() } });
  }
  return { user: record.user, surface: record.surface };
}

// An explicit sign-out (or a password change) must end the session for good. Stamping
// revokedAt at the epoch puts it far outside the few-seconds grace window that protects
// ordinary rotation, so the token is dead the instant this runs.
const REVOKED_FOR_GOOD = new Date(0);

async function revokeRefreshToken(raw) {
  if (!raw || typeof raw !== 'string') return;
  await prisma.refreshToken.updateMany({ where: { tokenHash: sha256(raw), revokedAt: null }, data: { revokedAt: REVOKED_FOR_GOOD } });
}

// Sign a user out everywhere -- used when their password changes or is reset. Also
// cancels tokens already retired by rotation but still inside their grace window.
async function revokeAllRefreshTokens(userId) {
  await prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: REVOKED_FOR_GOOD } });
  await prisma.refreshToken.updateMany({ where: { userId, revokedAt: { gt: REVOKED_FOR_GOOD } }, data: { revokedAt: REVOKED_FOR_GOOD } });
}

module.exports = { signAccessToken, issueSession, consumeRefreshToken, revokeRefreshToken, revokeAllRefreshTokens, sha256 };
