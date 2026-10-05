require('dotenv').config();
require('express-async-errors'); // lets async route handlers throw -- Express 4 otherwise drops the rejection
const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');

const authRoutes = require('./routes/auth');
const superRoutes = require('./routes/super');
const academicsRoutes = require('./routes/academics');
const libraryRoutes = require('./routes/library');
const groupsRoutes = require('./routes/groups');
const settings = require('./settings');
const coinsRoutes = require('./routes/coins');
const supportRoutes = require('./routes/support');
const questionsRoutes = require('./routes/questions');
const siteFiles = require('./siteFiles');
const syslog = require('./syslog');
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

// Security headers. The policy lists exactly the outside hosts the apps use (fonts,
// KaTeX/Chart.js on cdnjs, the socket.io client, and the Simli avatar SDK on jsDelivr);
// scripts are never allowed inline, so an injected <script> cannot run. Styles do allow
// inline because the screens set style attributes throughout. Images/media/connections
// may come from any https origin since lecture videos, library PDFs and avatar streams
// are hosted all over (Cloudinary, Simli, the payment pages).
const isProd = process.env.NODE_ENV === 'production';
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'", 'https://cdnjs.cloudflare.com', 'https://cdn.socket.io', 'https://cdn.jsdelivr.net', "'wasm-unsafe-eval'"],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
      'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
      'img-src': ["'self'", 'data:', 'blob:', 'https:'],
      'media-src': ["'self'", 'data:', 'blob:', 'https:'],
      'connect-src': ["'self'", 'https:', 'wss:', ...(isProd ? [] : ['ws:'])],
      'frame-src': ["'self'", 'https:'],
      'worker-src': ["'self'", 'blob:'],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
      'frame-ancestors': ["'self'"],
      ...(isProd ? { 'upgrade-insecure-requests': [] } : {}),
    },
  },
  // The apps' own pages embed legal.html in an iframe; everything is same-origin.
  crossOriginResourcePolicy: { policy: 'same-origin' },
}));

// Rate limits (per IP; trust proxy above makes that the real client). Sign-in limits only
// count FAILED attempts: a school's whole class often shares one public IP, and thirty
// students signing in together must not lock each other out -- but someone guessing
// codes still hits the wall after twenty misses.
const tooMany = { error: 'Too many attempts. Please wait a few minutes and try again.', code: 'RATE_LIMITED' };
const failedLogins = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, skipSuccessfulRequests: true, standardHeaders: 'draft-7', legacyHeaders: false, message: tooMany });
const superLogin = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, skipSuccessfulRequests: true, standardHeaders: 'draft-7', legacyHeaders: false, message: tooMany });
const signups = rateLimit({ windowMs: 60 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false, message: tooMany });
const passwordEmails = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: tooMany });
const refreshes = rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false, message: tooMany });
const apiOverall = rateLimit({ windowMs: 15 * 60 * 1000, limit: 3000, standardHeaders: 'draft-7', legacyHeaders: false, message: tooMany });

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
// Versioned asset URLs (?v=...) are cacheable for a year; everything else must revalidate.
const noCache = {
  setHeaders: (res) => {
    if (!/immutable/.test(String(res.getHeader('Cache-Control') || ''))) res.setHeader('Cache-Control', 'no-cache');
  },
};
app.use((req, res, next) => {
  if ((req.method === 'GET' || req.method === 'HEAD') && req.query.v && /\.(?:js|css|svg|png|webmanifest)$/.test(req.path)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  next();
});

// ---- API ----
app.use('/api', apiOverall);
// Timing. Any API request slower than 2 seconds is written to System Logs (admin panel) so slow
// spots show up without anyone having to complain. With LZ_QUERY_COUNT=1 (tests only) the
// response also reports how many database queries it ran.
const db = require('./db');
app.use('/api', (req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - started;
    if (ms > 2000) syslog.warn('http', `Slow request: ${ms} ms`, { method: req.method, path: req.originalUrl.split('?')[0], userId: req.user && req.user.id });
  });
  if (!db.counting) return next();
  const stats = { queries: 0, ms: 0 };
  const writeHead = res.writeHead;
  res.writeHead = function (...args) {
    res.setHeader('X-Query-Count', stats.queries);
    res.setHeader('X-Query-Ms', Math.round(stats.ms));
    return writeHead.apply(this, args);
  };
  db.requestStats.run(stats, next);
});
// Maintenance mode (admin panel > Settings): everything but the owner's own panel and the
// bits that must keep working (token refresh/sign-out, payment webhooks) answers 503.
app.use('/api', (req, res, next) => {
  if (!settings.get('maintenanceMode')) return next();
  if (req.path.startsWith('/super') || req.path.startsWith('/auth/refresh') || req.path.startsWith('/auth/logout') || req.path.startsWith('/billing/webhook')) return next();
  res.status(503).json({ error: settings.get('maintenanceMessage'), code: 'MAINTENANCE' });
});
app.use(['/api/auth/login', '/api/auth/school-login', '/api/auth/login-with-code', '/api/auth/password/reset'], failedLogins);
app.use('/api/auth/register-individual', signups);
app.use('/api/auth/password/forgot', passwordEmails);
app.use('/api/auth/refresh', refreshes);
app.use('/api/super/login', superLogin);
app.use('/api/auth', authRoutes);
app.use('/api/super', superRoutes); // the platform owner's API (the /admin panel)
app.use('/api', academicsRoutes);
app.use('/api', libraryRoutes);
app.use('/api', groupsRoutes);
app.use('/api', assessmentsRoutes);
app.use('/api/admin', adminRoutes); // a school admin's API (the Schools app)
app.use('/api/billing', billingRoutes);
app.use('/api/coins', coinsRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/questions', questionsRoutes);
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
// Front-end files edited in the admin panel (Code Editor / Codes) win over the copies on disk.
app.use(siteFiles.middleware);

// The apps poll this to notice a new deploy and offer a refresh. The commit id changes on
// every Railway deploy; locally it is just the boot time.
const BUILD_ID = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.RAILWAY_DEPLOYMENT_ID || String(Date.now());
app.get('/version.json', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ version: BUILD_ID });
});
app.get('/', (req, res) => res.redirect('/app'));
// The pages: HTML always revalidates (a 304 costs one tiny round trip), but the scripts and
// styles they point to are versioned and cached for good — see siteFiles.optimisePage.
const page = (name) => (req, res) => {
  const html = siteFiles.pageHtml(name);
  if (html == null) return res.status(404).end();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(html);
};
app.get('/app', page('app'));
app.get('/schools', page('schools'));
app.get('/legal', page('legal'));
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
  if (!clientError) syslog.error('http', err && err.message ? err.message : 'Unknown error', { detail: err && err.stack, method: req.method, path: req.originalUrl.split('?')[0], userId: req.user && req.user.id });
  res.status(clientError ? err.status : 500).json({ error: clientError ? err.message : 'Something went wrong. Please try again.' });
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true } });
attachLiveNamespace(io);
attachNotificationsNamespace(io);

settings.start();
siteFiles.start();
syslog.installProcessHandlers();

const PORT = process.env.PORT || 4100;
server.listen(PORT, () => console.log(`Learnza API listening on port ${PORT}`));

require('./seed')().catch((e) => console.error('Seed check failed:', e.message));
