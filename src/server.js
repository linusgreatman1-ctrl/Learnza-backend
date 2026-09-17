require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const compression = require('compression');
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
const labRoutes = require('./routes/lab');
const admissionsRoutes = require('./routes/admissions');
const staffRoutes = require('./routes/staff');
const recordsRoutes = require('./routes/records');
const individualCoursesRoutes = require('./routes/individualCourses');
const classAttendanceRoutes = require('./routes/classAttendance');
const assignmentsRoutes = require('./routes/assignments');
const notificationsRoutes = require('./routes/notifications');
const resultsRoutes = require('./routes/results');
const dashboardRoutes = require('./routes/dashboard');
const { attachLiveNamespace } = require('./realtime/live');
const { attachNotificationsNamespace } = require('./realtime/notifications');

const app = express();

// app.js alone is 400+KB and was being sent completely uncompressed -- on a slow
// connection that's several real seconds of transfer time on every load, made worse
// by the no-cache header just below forcing a fresh fetch far more often. gzip
// typically shrinks JS/HTML/CSS by 70-80%, which is the actual load-time fix here.
app.use(compression());
app.use(cors());
// `verify` stashes the raw body bytes on the request so payment-webhook signature
// checks (HMAC over the exact bytes sent) work even though we still want express
// to parse JSON for every other route.
app.use(express.json({ limit: '2mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));
// No Cache-Control at all meant browsers could apply their own heuristic caching to
// app.js/app.html/etc. and keep serving an already-loaded copy across page loads --
// invisible to whoever's testing, and indistinguishable from a fix "not actually
// working" when it was really just stale cached JS. Forcing revalidation on every
// load is cheap (still a fast 304 via ETag/Last-Modified when nothing changed) and
// guarantees a real refresh always gets whatever was just deployed.
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

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
app.use('/api', labRoutes);
app.use('/api', admissionsRoutes);
app.use('/api', staffRoutes);
app.use('/api', recordsRoutes);
app.use('/api', individualCoursesRoutes);
app.use('/api', classAttendanceRoutes);
app.use('/api', assignmentsRoutes);
app.use('/api', notificationsRoutes);
app.use('/api', resultsRoutes);
app.use('/api', dashboardRoutes);

app.get('/health', (req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true } });
attachLiveNamespace(io);
attachNotificationsNamespace(io);

const PORT = process.env.PORT || 4100;
server.listen(PORT, () => console.log(`Learnza API listening on port ${PORT}`));

require('./seed')().catch((e) => console.error('Seed check failed:', e.message));
