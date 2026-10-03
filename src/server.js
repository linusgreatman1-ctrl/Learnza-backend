require('dotenv').config();
require('express-async-errors'); // lets async route handlers throw -- Express 4 otherwise drops the rejection
const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const { Server } = require('socket.io');

const authRoutes = require('./routes/auth');
const superRoutes = require('./routes/super');
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
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const ADMIN_PANEL_DIR = path.join(__dirname, '..', 'admin-panel');

// Railway terminates TLS in front of the app; trusting one proxy hop makes req.ip the
// real client address (audit log, rate limits) instead of the proxy's.
app.set('trust proxy', 1);

// The frontends are several hundred KB of JS -- uncompressed that's seconds of transfer
// on a slow connection. gzip typically shrinks JS/HTML/CSS by 70-80%.
app.use(compression());
app.use(cors());
// `verify` stashes the raw body bytes on the request so payment-webhook signature
// checks (HMAC over the exact bytes sent) work even though we still want express
// to parse JSON for every other route.
app.use(express.json({ limit: '2mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// No Cache-Control at all lets browsers apply their own heuristic caching and keep
// serving an already-loaded copy across deploys. Forcing revalidation is cheap (a fast
// 304 via ETag/Last-Modified when nothing changed) and guarantees a refresh always gets
// whatever was just deployed.
const noCache = { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') };

// ---- API ----
app.use('/api/auth', authRoutes);
app.use('/api/super', superRoutes); // the platform owner's API (the /admin panel)
app.use('/api', academicsRoutes);
app.use('/api', libraryRoutes);
app.use('/api', groupsRoutes);
app.use('/api', assessmentsRoutes);
app.use('/api/admin', adminRoutes); // a school admin's API (the Schools app)
app.use('/api/billing', billingRoutes);
app.use('/api', aiTeacherRoutes);
app.use('/api', liveRoutes);
app.use('/api', researchAssistantRoutes);
app.use('/api', labRoutes);
app.use('/api', staffRoutes);
app.use('/api', recordsRoutes);
app.use('/api', individualCoursesRoutes);
app.use('/api', classAttendanceRoutes);
app.use('/api', assignmentsRoutes);
app.use('/api', notificationsRoutes);
app.use('/api', resultsRoutes);
app.use('/api', dashboardRoutes);
app.get('/health', (req, res) => res.json({ ok: true }));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ---- The three surfaces, one server (same layout as PassNow) ----
//   /app      the Student app    (independent learners)
//   /schools  the Schools app    (school admin, lecturers, school students)
//   /admin    the Super-admin panel (platform owner; onboards schools)
app.get('/', (req, res) => res.redirect('/app'));
app.get('/app', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'app.html')));
app.get('/schools', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'schools.html')));
app.get('/legal', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'legal.html')));
app.use('/admin', express.static(ADMIN_PANEL_DIR, noCache));
app.use(express.static(PUBLIC_DIR, noCache));

// Pages that no longer exist (the old intro website, admissions, the separate
// "individual" app) go to the Student app rather than a dead end.
app.get(['/index.html', '/apply.html', '/independent', '/independent.html', '/individual', '/individual.html'], (req, res) => res.redirect('/app'));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'That file is too large.' });
  console.error(err);
  const clientError = err && err.status >= 400 && err.status < 500;
  res.status(clientError ? err.status : 500).json({ error: clientError ? err.message : 'Something went wrong. Please try again.' });
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true } });
attachLiveNamespace(io);
attachNotificationsNamespace(io);

const PORT = process.env.PORT || 4100;
server.listen(PORT, () => console.log(`Learnza API listening on port ${PORT}`));

require('./seed')().catch((e) => console.error('Seed check failed:', e.message));
