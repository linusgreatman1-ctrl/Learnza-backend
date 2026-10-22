const jwt = require('jsonwebtoken');
const prisma = require('../db');

// Meeting signaling, star shape like a live class: the host keeps one RTCPeerConnection to each person who joins and
// everyone sees/hears the host; the host sees and hears everyone. This server only passes offers, answers and ICE
// candidates between the sockets; it never touches the media.
let nsp = null;
const hostSocket = new Map();       // meetingId -> host socket id
const members = new Map();          // meetingId -> Map<socketId, { userId, name }>

function attachMeetingNamespace(io) {
  const { mayJoin } = require('../routes/meetings');
  nsp = io.of('/meeting');
  nsp.use(async (socket, next) => {
    try {
      const payload = jwt.verify(socket.handshake.auth && socket.handshake.auth.token, process.env.JWT_SECRET);
      const user = await prisma.user.findUnique({ where: { id: payload.id } });
      if (!user) return next(new Error('Not signed in'));
      socket.user = user;
      next();
    } catch { next(new Error('Not signed in')); }
  });
  nsp.on('connection', (socket) => {
    const room = (id) => 'meeting:' + id;
    socket.on('meeting:enter', async ({ meetingId }) => {
      const m = await prisma.meeting.findUnique({ where: { id: meetingId } });
      if (!m || m.status !== 'ACTIVE') return socket.emit('meeting:error', { message: 'This meeting has ended.', ended: true });
      if (!(await mayJoin(socket.user, m))) return socket.emit('meeting:error', { message: 'You are not invited to this meeting.' });
      socket.meetingId = meetingId;
      socket.join(room(meetingId));
      if (m.hostId === socket.user.id) {
        socket.isHost = true;
        hostSocket.set(meetingId, socket.id);
        const list = members.get(meetingId) || new Map();
        socket.emit('meeting:hosting', { participants: [...list.entries()].map(([socketId, p]) => ({ socketId, ...p })) });
        nsp.to(room(meetingId)).emit('meeting:host-online');
      } else {
        if (!members.has(meetingId)) members.set(meetingId, new Map());
        members.get(meetingId).set(socket.id, { userId: socket.user.id, name: socket.user.fullName });
        socket.emit('meeting:joined', { hostOnline: hostSocket.has(meetingId) });
        if (hostSocket.has(meetingId)) nsp.to(hostSocket.get(meetingId)).emit('meeting:participant-joined', { socketId: socket.id, userId: socket.user.id, name: socket.user.fullName });
      }
    });
    // offers, answers and ICE candidates between the host and one participant
    socket.on('meeting:signal', ({ to, data }) => {
      if (!socket.meetingId || !to) return;
      const target = nsp.sockets.get(to);
      if (!target || target.meetingId !== socket.meetingId) return;
      target.emit('meeting:signal', { from: socket.id, data });
    });
    // a participant who turns up before the host has connected asks again once the host is there
    socket.on('meeting:ready', () => {
      if (!socket.meetingId || socket.isHost) return;
      const h = hostSocket.get(socket.meetingId);
      if (h) nsp.to(h).emit('meeting:participant-joined', { socketId: socket.id, userId: socket.user.id, name: socket.user.fullName });
    });
    socket.on('disconnect', () => {
      const id = socket.meetingId;
      if (!id) return;
      if (socket.isHost) {
        if (hostSocket.get(id) === socket.id) hostSocket.delete(id);
        nsp.to(room(id)).emit('meeting:host-offline');
      } else {
        const list = members.get(id);
        if (list) list.delete(socket.id);
        if (hostSocket.has(id)) nsp.to(hostSocket.get(id)).emit('meeting:participant-left', { socketId: socket.id });
      }
    });
  });
}

function endMeeting(meetingId) {
  if (!nsp) return;
  nsp.to('meeting:' + meetingId).emit('meeting:ended');
  hostSocket.delete(meetingId);
  members.delete(meetingId);
  const r = nsp.adapter.rooms.get('meeting:' + meetingId);
  if (r) for (const sid of r) { const s = nsp.sockets.get(sid); if (s) s.leave('meeting:' + meetingId); }
}

module.exports = { attachMeetingNamespace, endMeeting };
