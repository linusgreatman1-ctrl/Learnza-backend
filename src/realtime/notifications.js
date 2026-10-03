const jwt = require('jsonwebtoken');

// Notifications previously only ever reached the client via a 20s poll -- correct, but
// never "live": a new notification could sit unseen for up to 20 seconds even while the
// recipient was already looking at the screen. This namespace lets notify()/notifyMany()/
// notifySchoolAdmins() (notification.service.js) push straight to whoever's online the
// instant a notification is created, with the poll kept as a reliability fallback for
// anyone not currently connected (or who missed a reconnect).
let notifNsp = null;

function attachNotificationsNamespace(io) {
  const nsp = io.of('/notifications');
  nsp.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      if (!payload.id) return next(new Error('Not signed in'));
      socket.room = `user:${payload.id}`;
      next();
    } catch {
      next(new Error('Not signed in'));
    }
  });
  nsp.on('connection', (socket) => {
    socket.join(socket.room);
  });
  notifNsp = nsp;
  return nsp;
}

function pushToUser(userId, notification) {
  if (notifNsp) notifNsp.to(`user:${userId}`).emit('notification:new', notification);
}

module.exports = { attachNotificationsNamespace, pushToUser };
