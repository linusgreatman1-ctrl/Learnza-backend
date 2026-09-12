const jwt = require('jsonwebtoken');
const prisma = require('./db');

const JWT_SECRET = process.env.JWT_SECRET;

function signToken(user) {
  return jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
}

const STATUS_MESSAGE = {
  SUSPENDED: 'Your account has been suspended. Contact your school administrator.',
  DISMISSED: 'Your account has been deactivated.',
  EXPELLED: 'Your account has been deactivated.',
};

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
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Session expired, please sign in again' });
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

module.exports = { signToken, requireAuth, requireRole, logActivity };
