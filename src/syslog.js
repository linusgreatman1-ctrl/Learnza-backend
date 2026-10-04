const prisma = require('./db');

// Writes server problems to the SystemLog table so the owner can read them in the admin
// panel (System Logs). Never throws and never blocks: logging must not be able to break the
// request that triggered it, and a database outage (the likeliest cause of errors) must not
// cause a loop of failed log writes.
let failing = 0;

async function log(level, source, message, { detail, method, path, userId } = {}) {
  if (failing > 5) return; // database is down; stop trying until a write succeeds again
  try {
    await prisma.systemLog.create({
      data: {
        level,
        source,
        message: String(message).slice(0, 500),
        detail: detail ? String(detail).slice(0, 4000) : null,
        method: method || null,
        path: path ? String(path).slice(0, 300) : null,
        userId: userId || null,
      },
    });
    failing = 0;
  } catch {
    failing += 1;
  }
}

const error = (source, message, opts) => log('ERROR', source, message, opts);
const warn = (source, message, opts) => log('WARN', source, message, opts);
const info = (source, message, opts) => log('INFO', source, message, opts);

// Server errors that would otherwise only exist in the host's console.
function installProcessHandlers() {
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
    error('process', 'Unhandled promise rejection: ' + (reason && reason.message ? reason.message : reason), { detail: reason && reason.stack });
  });
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    error('process', 'Uncaught exception: ' + err.message, { detail: err.stack });
  });
}

module.exports = { log, error, warn, info, installProcessHandlers };
