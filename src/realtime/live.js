const jwt = require('jsonwebtoken');
const prisma = require('../db');
const { getSubscriptionStatus } = require('../subscription');

// Star-topology WebRTC signaling: the lecturer's browser holds one RTCPeerConnection
// per connected student and relays its own camera/mic to each individually. This
// server only relays SDP offers/answers and ICE candidates between sockets -- it
// never touches the media itself. Deliberately simpler than a full SFU: fine for a
// small class, but every extra viewer is one more upload stream from the lecturer's
// own connection. No TURN server is configured, so some school/firewalled networks
// may fail to connect (same known limitation as the sibling PassNow project).
function attachLiveNamespace(io) {
  const nsp = io.of('/live');
  const teacherSocketByLiveClass = new Map(); // liveClassId -> socket.id

  nsp.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      const user = await prisma.user.findUnique({ where: { id: payload.id } });
      if (!user) return next(new Error('Not signed in'));
      socket.user = user;
      next();
    } catch {
      next(new Error('Not signed in'));
    }
  });

  nsp.on('connection', (socket) => {
    socket.on('teacher:join', async ({ liveClassId }) => {
      const liveClass = await prisma.liveClass.findUnique({ where: { id: liveClassId } });
      if (!liveClass || liveClass.status !== 'ACTIVE' || liveClass.hostId !== socket.user.id) {
        return socket.emit('live:error', { message: 'You are not hosting this class.' });
      }
      socket.liveClassId = liveClassId;
      socket.join(`live:${liveClassId}`);
      teacherSocketByLiveClass.set(liveClassId, socket.id);
    });

    socket.on('student:join', async ({ liveClassId }) => {
      if (socket.user.role !== 'STUDENT') {
        return socket.emit('live:error', { message: 'Only students join as viewers.' });
      }
      const { active } = await getSubscriptionStatus(socket.user.id);
      if (!active) return socket.emit('live:error', { message: 'Live classes need an active Learnza subscription.', code: 'SUBSCRIPTION_REQUIRED' });

      const liveClass = await prisma.liveClass.findUnique({ where: { id: liveClassId } });
      if (!liveClass || liveClass.status !== 'ACTIVE') {
        return socket.emit('live:error', { message: 'This class has ended.' });
      }
      socket.liveClassId = liveClassId;
      socket.join(`live:${liveClassId}`);

      const teacherSocketId = teacherSocketByLiveClass.get(liveClassId);
      if (teacherSocketId) {
        nsp.to(teacherSocketId).emit('student:joined', { studentSocketId: socket.id, studentName: socket.user.fullName });
      } else {
        socket.emit('live:error', { message: 'The lecturer is not connected yet — try again shortly.' });
      }
    });

    // Relay SDP/ICE between two specific sockets; the server never inspects the payload.
    socket.on('webrtc:offer', ({ to, offer }) => nsp.to(to).emit('webrtc:offer', { from: socket.id, offer }));
    socket.on('webrtc:answer', ({ to, answer }) => nsp.to(to).emit('webrtc:answer', { from: socket.id, answer }));
    socket.on('webrtc:ice-candidate', ({ to, candidate }) => nsp.to(to).emit('webrtc:ice-candidate', { from: socket.id, candidate }));

    socket.on('chat:message', ({ liveClassId, text }) => {
      if (!text || !text.trim() || socket.liveClassId !== liveClassId) return;
      nsp.to(`live:${liveClassId}`).emit('chat:message', { from: socket.user.fullName, role: socket.user.role, text: text.trim() });
    });

    socket.on('teacher:end', async ({ liveClassId }) => {
      if (teacherSocketByLiveClass.get(liveClassId) !== socket.id) return; // only the registered host may end it
      await endLiveClass(liveClassId);
    });

    socket.on('disconnect', async () => {
      if (socket.liveClassId && teacherSocketByLiveClass.get(socket.liveClassId) === socket.id) {
        await endLiveClass(socket.liveClassId);
      }
    });
  });

  async function endLiveClass(liveClassId) {
    teacherSocketByLiveClass.delete(liveClassId);
    await prisma.liveClass.updateMany({ where: { id: liveClassId, status: 'ACTIVE' }, data: { status: 'ENDED', endedAt: new Date() } });
    nsp.to(`live:${liveClassId}`).emit('live:ended');
    const room = nsp.adapter.rooms.get(`live:${liveClassId}`);
    if (room) for (const socketId of room) nsp.sockets.get(socketId)?.leave(`live:${liveClassId}`);
  }
}

module.exports = { attachLiveNamespace };
