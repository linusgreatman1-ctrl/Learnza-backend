const jwt = require('jsonwebtoken');

// Notifications (both the regular User bell and the applicant portal's) previously
// only ever reached the client via a 20s poll -- correct, but never "live": a status
// change could sit unseen for up to 20 seconds even while the recipient was already
// looking at the screen. This namespace lets notify()/notifyMany()/notifySchoolAdmins()
// (notification.service.js) and notifyApplicant() (admissions.js) push straight to
// whoever's online the instant a notification is created, with the poll kept as a
// reliability fallback for anyone not currently connected (or who missed a reconnect).
//
// One shared namespace for both audiences (User and Applicant are separate models
// with separate token shapes -- {id,role} vs {applicantId}) -- each socket joins a
// room keyed by whichever kind of token it authenticated with, and pushToUser/
// pushToApplicant address exactly that room.
let notifNsp = null;

function attachNotificationsNamespace(io) {
  const nsp = io.of('/notifications');
  nsp.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      if (payload.applicantId) socket.room = `applicant:${payload.applicantId}`;
      else if (payload.id) socket.room = `user:${payload.id}`;
      else return next(new Error('Not signed in'));
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

function pushToApplicant(applicantId, notification) {
  if (notifNsp) notifNsp.to(`applicant:${applicantId}`).emit('notification:new', notification);
}

module.exports = { attachNotificationsNamespace, pushToUser, pushToApplicant };
