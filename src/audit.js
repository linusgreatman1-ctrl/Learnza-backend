const prisma = require('./db');

// Append-only record of privileged super-admin actions. Never throws -- a failed audit
// write must not undo or block the action it describes.
async function logAction(req, action, targetType, targetId, metadata) {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: req.user ? req.user.id : null,
        actorEmail: req.user ? req.user.email : null,
        action,
        targetType: targetType || null,
        targetId: targetId || null,
        metadata: metadata ? JSON.stringify(metadata) : null,
        ip: req.ip || null,
      },
    });
  } catch (e) {
    console.error('Audit log write failed:', e.message);
  }
}

module.exports = { logAction };
