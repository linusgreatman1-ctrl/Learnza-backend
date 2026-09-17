const jwt = require('jsonwebtoken');
const prisma = require('../db');
const { getSubscriptionStatus, isEnforced } = require('../subscription');

// Star-topology WebRTC signaling: the lecturer's browser holds one RTCPeerConnection
// per connected student and relays its own camera/mic to each individually. This
// server only relays SDP offers/answers and ICE candidates between sockets -- it
// never touches the media itself. Deliberately simpler than a full SFU: fine for a
// small class, but every extra viewer is one more upload stream from the lecturer's
// own connection. No TURN server is configured, so some school/firewalled networks
// may fail to connect (same known limitation as the sibling PassNow project).
// How long a class stays alive after the teacher's socket drops before it's actually
// ended -- long enough to survive a WiFi blip, tab backgrounding, or mobile network
// handoff triggering Socket.IO's own reconnect (which opens a brand-new socket id, so
// the old socket's disconnect event still fires even though the teacher is still
// teaching). Ending immediately on first disconnect was the cause of "session has
// ended" firing on students mid-lecture.
const TEACHER_GRACE_MS = 25000;

function attachLiveNamespace(io) {
  const nsp = io.of('/live');
  const teacherSocketByLiveClass = new Map(); // liveClassId -> socket.id
  const pendingEndTimers = new Map(); // liveClassId -> Timeout
  const questionsByLiveClass = new Map(); // liveClassId -> [{ id, studentSocketId, studentName, text, askedAt }]
  const watchersByLiveClass = new Map(); // liveClassId -> Set<socket.id>

  function watchingCount(liveClassId) {
    return watchersByLiveClass.get(liveClassId)?.size || 0;
  }
  function broadcastWatchingCount(liveClassId) {
    nsp.to(`live:${liveClassId}`).emit('live:watching-count', { count: watchingCount(liveClassId) });
  }

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

      // Reconnecting within the grace window cancels the pending end -- the class was
      // never actually stopped, so tell the teacher's (new) socket the queue/count as
      // they left it instead of starting fresh.
      const pending = pendingEndTimers.get(liveClassId);
      if (pending) { clearTimeout(pending); pendingEndTimers.delete(liveClassId); }
      socket.emit('live:questions-sync', { questions: questionsByLiveClass.get(liveClassId) || [] });
      socket.emit('live:watching-count', { count: watchingCount(liveClassId) });
    });

    socket.on('student:join', async ({ liveClassId }) => {
      if (socket.user.role !== 'STUDENT') {
        return socket.emit('live:error', { message: 'Only students join as viewers.' });
      }
      if (isEnforced()) {
        const { active } = await getSubscriptionStatus(socket.user.id);
        if (!active) return socket.emit('live:error', { message: 'Live classes need an active Learnza subscription.', code: 'SUBSCRIPTION_REQUIRED' });
      }

      const liveClass = await prisma.liveClass.findUnique({ where: { id: liveClassId } });
      if (!liveClass || liveClass.status !== 'ACTIVE') {
        return socket.emit('live:error', { message: 'This class has ended.' });
      }
      socket.liveClassId = liveClassId;
      socket.join(`live:${liveClassId}`);

      if (!watchersByLiveClass.has(liveClassId)) watchersByLiveClass.set(liveClassId, new Set());
      watchersByLiveClass.get(liveClassId).add(socket.id);
      broadcastWatchingCount(liveClassId);
      socket.emit('live:room-info', { title: liveClass.title });

      const teacherSocketId = teacherSocketByLiveClass.get(liveClassId);
      if (teacherSocketId) {
        nsp.to(teacherSocketId).emit('student:joined', { studentSocketId: socket.id, studentName: socket.user.fullName });
      } else {
        socket.emit('live:error', { message: 'The lecturer is not connected yet — try again shortly.' });
      }
    });

    // A question is distinct from the flat chat log: it lands in the teacher's queue
    // (not broadcast to the class) until the teacher actually answers it, at which
    // point the Q&A pair is broadcast to everyone -- mirrors "got a question" being
    // answered on the board elsewhere in the app, rather than getting lost in chatter.
    socket.on('live:question', ({ liveClassId, text }) => {
      if (!text || !text.trim() || socket.liveClassId !== liveClassId || socket.user.role !== 'STUDENT') return;
      if (!questionsByLiveClass.has(liveClassId)) questionsByLiveClass.set(liveClassId, []);
      const queue = questionsByLiveClass.get(liveClassId);
      const question = { id: `${socket.id}-${Date.now()}`, studentSocketId: socket.id, studentName: socket.user.fullName, text: text.trim(), askedAt: new Date().toISOString() };
      queue.push(question);
      const teacherSocketId = teacherSocketByLiveClass.get(liveClassId);
      if (teacherSocketId) nsp.to(teacherSocketId).emit('live:new-question', question);
      socket.emit('live:question-received');
    });

    socket.on('live:answer-question', ({ liveClassId, questionId, answer }) => {
      if (teacherSocketByLiveClass.get(liveClassId) !== socket.id || !answer || !answer.trim()) return;
      const queue = questionsByLiveClass.get(liveClassId) || [];
      const idx = queue.findIndex((q) => q.id === questionId);
      const question = idx >= 0 ? queue[idx] : null;
      if (idx >= 0) queue.splice(idx, 1);
      nsp.to(`live:${liveClassId}`).emit('live:qa', {
        studentName: question ? question.studentName : 'A student',
        question: question ? question.text : '',
        answer: answer.trim(),
      });
    });

    // Relay SDP/ICE between two specific sockets; the server never inspects the
    // payload beyond `to` -- everything else (offer/answer/candidate, plus any
    // `purpose`/`speakerId` tag a caller adds to distinguish the main video
    // connection from a "invite to speak" mic connection or a relayed-audio
    // connection) passes through untouched.
    socket.on('webrtc:offer', ({ to, ...rest }) => nsp.to(to).emit('webrtc:offer', { ...rest, from: socket.id }));
    socket.on('webrtc:answer', ({ to, ...rest }) => nsp.to(to).emit('webrtc:answer', { ...rest, from: socket.id }));
    socket.on('webrtc:ice-candidate', ({ to, ...rest }) => nsp.to(to).emit('webrtc:ice-candidate', { ...rest, from: socket.id }));

    // Teacher calls on a specific student to speak (mirrors PassNow's "invite to
    // speak", raising the student's mic to the whole class through the teacher's own
    // connections rather than a full mesh). live:stop-speaking can come from either
    // the teacher (cutting them off) or the student themselves (done talking).
    socket.on('live:invite-to-speak', ({ liveClassId, studentSocketId }) => {
      if (teacherSocketByLiveClass.get(liveClassId) !== socket.id) return;
      nsp.to(studentSocketId).emit('live:invited-to-speak');
    });
    socket.on('live:stop-speaking', ({ liveClassId, studentSocketId }) => {
      if (teacherSocketByLiveClass.get(liveClassId) !== socket.id && socket.id !== studentSocketId) return;
      nsp.to(`live:${liveClassId}`).emit('live:speaker-stopped', { studentSocketId });
    });

    socket.on('chat:message', ({ liveClassId, text }) => {
      if (!text || !text.trim() || socket.liveClassId !== liveClassId) return;
      nsp.to(`live:${liveClassId}`).emit('chat:message', { from: socket.user.fullName, role: socket.user.role, text: text.trim() });
    });

    socket.on('teacher:end', async ({ liveClassId }) => {
      if (teacherSocketByLiveClass.get(liveClassId) !== socket.id) return; // only the registered host may end it
      await endLiveClass(liveClassId);
    });

    socket.on('disconnect', () => {
      if (socket.liveClassId && watchersByLiveClass.get(socket.liveClassId)?.delete(socket.id)) {
        broadcastWatchingCount(socket.liveClassId);
      }
      if (socket.liveClassId && teacherSocketByLiveClass.get(socket.liveClassId) === socket.id) {
        const liveClassId = socket.liveClassId;
        // Don't end the class on the spot -- give the teacher's client a window to
        // reconnect and re-register (teacher:join clears this timer) before treating
        // the drop as a real end of class.
        const timer = setTimeout(() => { endLiveClass(liveClassId); }, TEACHER_GRACE_MS);
        pendingEndTimers.set(liveClassId, timer);
      }
    });
  });

  async function endLiveClass(liveClassId) {
    teacherSocketByLiveClass.delete(liveClassId);
    pendingEndTimers.delete(liveClassId);
    questionsByLiveClass.delete(liveClassId);
    watchersByLiveClass.delete(liveClassId);
    await prisma.liveClass.updateMany({ where: { id: liveClassId, status: 'ACTIVE' }, data: { status: 'ENDED', endedAt: new Date() } });
    nsp.to(`live:${liveClassId}`).emit('live:ended');
    const room = nsp.adapter.rooms.get(`live:${liveClassId}`);
    if (room) for (const socketId of room) nsp.sockets.get(socketId)?.leave(`live:${liveClassId}`);
  }
}

module.exports = { attachLiveNamespace };
