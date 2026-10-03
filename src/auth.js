const jwt = require('jsonwebtoken');
const prisma = require('./db');
const { signAccessToken } = require('./session');

const JWT_SECRET = process.env.JWT_SECRET;

// Kept under its old name for the few callers that just need an access token; real
// sign-ins go through session.issueSession() so they get a refresh token as well.
const signToken = signAccessToken;

const STATUS_MESSAGE = {
  SUSPENDED: 'Your account has been suspended. Contact your school administrator.',
  DISMISSED: 'Your account has been deactivated.',
  EXPELLED: 'Your account has been deactivated.',
};

// A suspended school, or one whose licence has lapsed, must lose access even for people
// who are already signed in -- not only at the next login. Checked on each request but
// cached per school for a minute so it isn't a database round trip every time;
// clearSchoolCache() lets the super-admin routes make a suspension/renewal bite at once.
const SCHOOL_CACHE_MS = 60 * 1000;
const schoolCache = new Map();

async function schoolBlock(schoolId) {
  const hit = schoolCache.get(schoolId);
  if (hit && Date.now() - hit.at < SCHOOL_CACHE_MS) return hit.block;
  const school = await prisma.school.findUnique({ where: { id: schoolId }, select: { status: true, subscriptionExpiresAt: true } });
  let block = null;
  if (!school) block = { error: 'This school no longer exists.', code: 'SCHOOL_SUSPENDED' };
  else if (school.status !== 'ACTIVE') block = { error: "This school's account is suspended. Contact Learnza.", code: 'SCHOOL_SUSPENDED' };
  else if (school.subscriptionExpiresAt && school.subscriptionExpiresAt <= new Date()) {
    block = { error: "This school's Learnza licence has expired. Ask your school to renew it.", code: 'SCHOOL_LICENCE_EXPIRED' };
  }
  schoolCache.set(schoolId, { block, at: Date.now() });
  return block;
}

function clearSchoolCache(schoolId) {
  if (schoolId) schoolCache.delete(schoolId);
  else schoolCache.clear();
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await prisma.user.findUnique({ where: { id: payload.id } });
    if (!user) return res.status(401).json({ error: 'Not signed in' });
    if (user.status !== 'ACTIVE') {
      return res.status(403).json({ error: STATUS_MESSAGE[user.status] || 'Your account is inactive.', code: 'ACCOUNT_INACTIVE' });
    }
    if (user.schoolId) {
      const block = await schoolBlock(user.schoolId);
      if (block) return res.status(403).json(block);
    }
    req.user = user;
    next();
  } catch (err) {
    // An expired access token is the normal case (they last 15 minutes) -- the frontends
    // see this and quietly swap their refresh token for a new one instead of signing out.
    const expired = err && err.name === 'TokenExpiredError';
    return res.status(401).json({ error: 'Session expired, please sign in again', code: expired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Not allowed for your role' });
    }
    next();
  };
}

async function logActivity(userId, action, detail) {
  await prisma.activityLog.create({ data: { userId, action, detail } });
}

module.exports = { signToken, requireAuth, requireRole, logActivity, clearSchoolCache, schoolBlock };
