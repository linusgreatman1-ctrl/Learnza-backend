require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const authRoutes = require('./routes/auth');
const academicsRoutes = require('./routes/academics');
const libraryRoutes = require('./routes/library');
const groupsRoutes = require('./routes/groups');
const assessmentsRoutes = require('./routes/assessments');
const adminRoutes = require('./routes/admin');
const billingRoutes = require('./routes/billing');
const aiTeacherRoutes = require('./routes/aiTeacher');
const liveRoutes = require('./routes/live');
const researchAssistantRoutes = require('./routes/researchAssistant');
const { attachLiveNamespace } = require('./realtime/live');

const app = express();

app.use(cors());
// `verify` stashes the raw body bytes on the request so payment-webhook signature
// checks (HMAC over the exact bytes sent) work even though we still want express
// to parse JSON for every other route.
app.use(express.json({ limit: '2mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/auth', authRoutes);
app.use('/api', academicsRoutes);
app.use('/api', libraryRoutes);
app.use('/api', groupsRoutes);
app.use('/api', assessmentsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api', aiTeacherRoutes);
app.use('/api', liveRoutes);
app.use('/api', researchAssistantRoutes);

app.get('/health', (req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true } });
attachLiveNamespace(io);

const PORT = process.env.PORT || 4100;
server.listen(PORT, () => console.log(`Learnza API listening on port ${PORT}`));

require('./seed')().catch((e) => console.error('Seed check failed:', e.message));
