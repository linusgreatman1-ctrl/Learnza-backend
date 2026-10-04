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
  const infoByLiveClass = new Map(); // liveClassId -> { topic, subject } (what students see at the top)
  const handsByLiveClass = new Map(); // liveClassId -> Map<socket.id, { studentName, kind }> raised hands waiting for the lecturer
  const floorByLiveClass = new Map(); // liveClassId -> { socketId, name, kind, phase } the ONE student let in right now
  const classQuestionByLiveClass = new Map(); // liveClassId -> text of a question the lecturer put to the whole class

  function floorInfo(liveClassId) {
    const f = floorByLiveClass.get(liveClassId);
    return f ? { socketId: f.socketId, name: f.name, kind: f.kind, phase: f.phase } : null;
  }
  function roomInfo(liveClassId) {
    const info = infoByLiveClass.get(liveClassId) || {};
    return { title: info.topic || '', subject: info.subject || '', classQuestion: classQuestionByLiveClass.get(liveClassId) || null, floor: floorInfo(liveClassId) };
  }
  function sendFloor(liveClassId) {
    nsp.to(`live:${liveClassId}`).emit('live:floor', floorInfo(liveClassId));
  }
  // The label students see: the course (subject) and, separately, the topic the lecturer types.
  function rememberInfo(liveClass) {
    const course = liveClass.course;
    const subject = course ? [course.code, course.title].filter(Boolean).join(' — ') : '';
    const cur = infoByLiveClass.get(liveClass.id) || {};
    infoByLiveClass.set(liveClass.id, { topic: cur.topic !== undefined ? cur.topic : liveClass.title, subject: subject || cur.subject || '' });
  }
  // A student left, dropped off, or was cut off: forget their hand and give back the floor if they held it.
  function dropStudentState(liveClassId, socketId) {
    const hands = handsByLiveClass.get(liveClassId);
    if (hands && hands.delete(socketId)) {
      const teacherSocketId = teacherSocketByLiveClass.get(liveClassId);
      if (teacherSocketId) nsp.to(teacherSocketId).emit('live:hand-lowered', { studentSocketId: socketId });
    }
    const floor = floorByLiveClass.get(liveClassId);
    if (floor && floor.socketId === socketId) {
      floorByLiveClass.delete(liveClassId);
      sendFloor(liveClassId);
      nsp.to(`live:${liveClassId}`).emit('live:speaker-stopped', { studentSocketId: socketId });
    }
  }

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
      const liveClass = await prisma.liveClass.findUnique({ where: { id: liveClassId }, include: { course: { select: { code: true, title: true } } } });
      if (!liveClass || liveClass.status !== 'ACTIVE' || liveClass.hostId !== socket.user.id) {
        return socket.emit('live:error', { message: 'You are not hosting this class.' });
      }
      rememberInfo(liveClass);
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
      socket.emit('live:hands-sync', { hands: Array.from((handsByLiveClass.get(liveClassId) || new Map()).entries()).map(([id, h]) => ({ studentSocketId: id, studentName: h.studentName, kind: h.kind })), floor: floorInfo(liveClassId), classQuestion: classQuestionByLiveClass.get(liveClassId) || null });
      nsp.to(`live:${liveClassId}`).emit('live:room-info', roomInfo(liveClassId));
    });

    socket.on('student:join', async ({ liveClassId }) => {
      if (socket.user.role !== 'STUDENT') {
        return socket.emit('live:error', { message: 'Only students join as viewers.' });
      }
      if (isEnforced()) {
        const { active } = await getSubscriptionStatus(socket.user.id);
        if (!active) return socket.emit('live:error', { message: 'Live classes need an active Learnza subscription.', code: 'SUBSCRIPTION_REQUIRED' });
      }

      const liveClass = await prisma.liveClass.findUnique({
        where: { id: liveClassId },
        include: { course: { select: { code: true, title: true, department: { select: { schoolId: true } } } } },
      });
      if (!liveClass || liveClass.status !== 'ACTIVE') {
        return socket.emit('live:error', { message: 'This class has ended.' });
      }
      rememberInfo(liveClass);
      // Only students of the school that is running the class may watch it.
      if (!socket.user.schoolId || liveClass.course.department.schoolId !== socket.user.schoolId) {
        return socket.emit('live:error', { message: 'This class is not open to you.' });
      }
      socket.liveClassId = liveClassId;
      socket.join(`live:${liveClassId}`);

      if (!watchersByLiveClass.has(liveClassId)) watchersByLiveClass.set(liveClassId, new Set());
      watchersByLiveClass.get(liveClassId).add(socket.id);
      broadcastWatchingCount(liveClassId);
      socket.emit('live:room-info', roomInfo(liveClassId));

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
      // Only the student the lecturer has let in can send one.
      const floor = floorByLiveClass.get(liveClassId);
      if (!floor || floor.socketId !== socket.id) return;
      if (!questionsByLiveClass.has(liveClassId)) questionsByLiveClass.set(liveClassId, []);
      const queue = questionsByLiveClass.get(liveClassId);
      const question = { id: `${socket.id}-${Date.now()}`, studentSocketId: socket.id, studentName: socket.user.fullName, text: text.trim().slice(0, 500), kind: floor.kind, askedAt: new Date().toISOString() };
      queue.push(question);
      floorByLiveClass.delete(liveClassId);
      const teacherSocketId = teacherSocketByLiveClass.get(liveClassId);
      if (teacherSocketId) nsp.to(teacherSocketId).emit('live:new-question', question);
      socket.emit('live:hand-state', { state: 'sent', kind: question.kind });
      sendFloor(liveClassId);
    });

    // A student raises a hand: to ask a question, or (when the lecturer has put a question to the class) to answer it.
    socket.on('live:raise-hand', ({ liveClassId }) => {
      if (socket.liveClassId !== liveClassId || socket.user.role !== 'STUDENT') return;
      const teacherSocketId = teacherSocketByLiveClass.get(liveClassId);
      if (!teacherSocketId) return;
      const floor = floorByLiveClass.get(liveClassId);
      if (floor && floor.socketId === socket.id) return;
      const kind = classQuestionByLiveClass.get(liveClassId) ? 'answer' : 'question';
      if (kind === 'answer' && floor && floor.kind === 'answer') return; // someone is already answering
      if (!handsByLiveClass.has(liveClassId)) handsByLiveClass.set(liveClassId, new Map());
      handsByLiveClass.get(liveClassId).set(socket.id, { studentName: socket.user.fullName, kind });
      socket.emit('live:hand-state', { state: 'waiting', kind });
      nsp.to(teacherSocketId).emit('live:hand-raised', { studentSocketId: socket.id, studentName: socket.user.fullName, kind });
    });
    socket.on('live:lower-hand', ({ liveClassId }) => {
      if (socket.liveClassId !== liveClassId) return;
      const hands = handsByLiveClass.get(liveClassId);
      const teacherSocketId = teacherSocketByLiveClass.get(liveClassId);
      if (hands && hands.delete(socket.id) && teacherSocketId) nsp.to(teacherSocketId).emit('live:hand-lowered', { studentSocketId: socket.id });
      socket.emit('live:hand-state', { state: 'idle' });
    });

    // The lecturer lets ONE raised hand speak. That student picks mic or typing; everyone sees who has the floor.
    socket.on('live:allow', ({ liveClassId, studentSocketId }) => {
      if (teacherSocketByLiveClass.get(liveClassId) !== socket.id || !studentSocketId) return;
      const hands = handsByLiveClass.get(liveClassId) || new Map();
      const hand = hands.get(studentSocketId);
      const target = nsp.sockets.get(studentSocketId);
      if (!hand && !target) return;
      const prev = floorByLiveClass.get(liveClassId);
      if (prev && prev.socketId !== studentSocketId) {
        nsp.to(prev.socketId).emit('live:speak-ended');
        nsp.to(`live:${liveClassId}`).emit('live:speaker-stopped', { studentSocketId: prev.socketId });
      }
      const kind = (hand && hand.kind) || (classQuestionByLiveClass.get(liveClassId) ? 'answer' : 'question');
      hands.delete(studentSocketId);
      floorByLiveClass.set(liveClassId, { socketId: studentSocketId, name: hand ? hand.studentName : (target && target.user ? target.user.fullName : 'A student'), kind, phase: 'choosing' });
      if (kind === 'answer') {
        // the other students' hands fade away: one answers at a time
        for (const [otherId, h] of Array.from(hands.entries())) {
          if (h.kind !== 'answer') continue;
          hands.delete(otherId);
          nsp.to(otherId).emit('live:hand-state', { state: 'idle' });
          nsp.to(socket.id).emit('live:hand-lowered', { studentSocketId: otherId });
        }
      }
      nsp.to(studentSocketId).emit('live:allowed', { kind });
      nsp.to(socket.id).emit('live:hand-lowered', { studentSocketId });
      sendFloor(liveClassId);
    });
    // The allowed student says how they will ask or answer.
    socket.on('live:speak-mode', ({ liveClassId, mode }) => {
      const floor = floorByLiveClass.get(liveClassId);
      if (!floor || floor.socketId !== socket.id) return;
      floor.phase = mode === 'mic' ? 'speaking' : 'typing';
      sendFloor(liveClassId);
    });
    // The lecturer puts a question to the whole class; students then raise a hand to answer.
    socket.on('live:ask-class', ({ liveClassId, question }) => {
      if (teacherSocketByLiveClass.get(liveClassId) !== socket.id) return;
      const hands = handsByLiveClass.get(liveClassId);
      if (hands) {
        for (const [sid] of Array.from(hands.entries())) { nsp.to(sid).emit('live:hand-state', { state: 'idle' }); nsp.to(socket.id).emit('live:hand-lowered', { studentSocketId: sid }); }
        hands.clear();
      }
      const floor = floorByLiveClass.get(liveClassId);
      if (floor) {
        nsp.to(floor.socketId).emit('live:speak-ended');
        nsp.to(`live:${liveClassId}`).emit('live:speaker-stopped', { studentSocketId: floor.socketId });
        floorByLiveClass.delete(liveClassId);
        sendFloor(liveClassId);
      }
      const q = typeof question === 'string' ? question.trim().slice(0, 500) : '';
      if (q) classQuestionByLiveClass.set(liveClassId, q); else classQuestionByLiveClass.delete(liveClassId);
      nsp.to(`live:${liveClassId}`).emit('live:class-question', { question: q || null });
    });
    // The lecturer typed a new topic: students see it at once, and it is saved as the class title.
    socket.on('live:update-info', async ({ liveClassId, topic }) => {
      if (teacherSocketByLiveClass.get(liveClassId) !== socket.id || typeof topic !== 'string') return;
      const cur = infoByLiveClass.get(liveClassId) || {};
      infoByLiveClass.set(liveClassId, { ...cur, topic: topic.trim().slice(0, 200) });
      nsp.to(`live:${liveClassId}`).emit('live:room-info', roomInfo(liveClassId));
      try { await prisma.liveClass.update({ where: { id: liveClassId }, data: { title: topic.trim().slice(0, 200) || 'Live class' } }); } catch { /* the screens already updated */ }
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

    // Either side can end a turn: the lecturer cutting it off, or the student saying they are done.
    socket.on('live:end-speak', ({ liveClassId, studentSocketId }) => {
      if (teacherSocketByLiveClass.get(liveClassId) !== socket.id || !studentSocketId) return;
      nsp.to(studentSocketId).emit('live:speak-ended');
      const floor = floorByLiveClass.get(liveClassId);
      if (floor && floor.socketId === studentSocketId) { floorByLiveClass.delete(liveClassId); sendFloor(liveClassId); }
      nsp.to(`live:${liveClassId}`).emit('live:speaker-stopped', { studentSocketId });
    });
    socket.on('live:stop-speaking', ({ liveClassId, studentSocketId }) => {
      if (teacherSocketByLiveClass.get(liveClassId) !== socket.id && socket.id !== studentSocketId) return;
      const floor = floorByLiveClass.get(liveClassId);
      if (floor && floor.socketId === studentSocketId) { floorByLiveClass.delete(liveClassId); sendFloor(liveClassId); }
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
        dropStudentState(socket.liveClassId, socket.id);
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
    infoByLiveClass.delete(liveClassId);
    handsByLiveClass.delete(liveClassId);
    floorByLiveClass.delete(liveClassId);
    classQuestionByLiveClass.delete(liveClassId);
    const endedAt = new Date();
    // Read startedAt before the update so everyone (host and students alike) can be
    // told how long the class actually ran, not just that it ended.
    const liveClass = await prisma.liveClass.findUnique({ where: { id: liveClassId } });
    const durationMin = liveClass ? Math.max(1, Math.round((endedAt - liveClass.startedAt) / 60000)) : 0;
    await prisma.liveClass.updateMany({ where: { id: liveClassId, status: 'ACTIVE' }, data: { status: 'ENDED', endedAt } });
    nsp.to(`live:${liveClassId}`).emit('live:ended', { durationMin });
    const room = nsp.adapter.rooms.get(`live:${liveClassId}`);
    if (room) for (const socketId of room) nsp.sockets.get(socketId)?.leave(`live:${liveClassId}`);
    return durationMin;
  }

  // Exposed so the REST /live/:id/end route (src/routes/live.js) can trigger the
  // exact same broadcast+cleanup teacher:end does over the socket -- the lecturer's
  // "End class" button calls that REST endpoint specifically to avoid a socket emit
  // racing the page's own disconnect, but students still need live:ended to actually
  // leave the session instead of it just going stale in the database.
  module.exports.endLiveClassById = endLiveClass;
}

module.exports = { attachLiveNamespace };
