const fs = require('fs');
const path = require('path');
const prisma = require('./db');

// Front-end files edited from the admin panel's Code Editor. The newest PUBLISHED version of a
// file overrides the copy shipped in public/, and is served from memory (refreshed on every
// publish and once a minute, so a second server instance catches up).
//
// Safety rails, because a bad front-end file can lock every user out:
//   - only text files inside public/ with an allowed extension;
//   - JavaScript must parse, JSON must be valid, before anything is saved;
//   - the admin panel itself (admin-panel/) is not editable, so it can always roll a change back;
//   - the service worker is not editable (a broken one is very hard to recover from).
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// The pages the server serves at clean URLs.
const PAGE_FILES = { app: 'app.html', schools: 'schools.html', legal: 'legal.html' };
const ALLOWED = new Set(['.html', '.css', '.js', '.json', '.svg', '.webmanifest', '.txt']);
const BLOCKED = new Set(['sw.js']);
const MAX_BYTES = 1400 * 1024; // the request body limit (2 MB, JSON-escaped) is the real ceiling
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

let overrides = new Map(); // path -> { content, type }

// ---- Fast loading --------------------------------------------------------------------
// The app's own scripts and stylesheets are requested with ?v=<version>, and anything carrying
// a version is cached by the browser for a year ("immutable"). The version changes on every
// deploy and every Code Editor save, so users never see stale code — but a returning visitor
// loads the whole app from their device with no round trips to the server at all, which is the
// difference between instant and several seconds on a slow or distant connection.
// Scripts are also deferred (they no longer stop the page from appearing) and the hosts the page
// will fetch from are pre-connected.
const BUILD_ID = String(process.env.RAILWAY_GIT_COMMIT_SHA || process.env.RAILWAY_DEPLOYMENT_ID || Date.now()).slice(0, 8);
let overridesStamp = '0';
// Also folds in the newest modified-time of the files themselves, so editing a file without
// restarting the server (local development) still produces a new version and defeats the cache.
let diskStamp = { at: 0, v: '0' };
function filesStamp() {
  if (Date.now() - diskStamp.at < 2000) return diskStamp.v;
  let newest = 0;
  for (const f of ['app.js', 'schools.js', 'extras.js', 'style.css', 'auth.css', 'icon.svg']) {
    try { newest = Math.max(newest, fs.statSync(path.join(PUBLIC_DIR, f)).mtimeMs); } catch { /* missing file: ignore */ }
  }
  diskStamp = { at: Date.now(), v: Math.round(newest / 1000).toString(36) };
  return diskStamp.v;
}
const assetVersion = () => BUILD_ID + '-' + overridesStamp + '-' + filesStamp();
const LOCAL_ASSETS = /^(?:app|schools|extras)\.js$|^(?:style|auth)\.css$|^icon\.svg$/;
const HINTS = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net', 'https://cdn.socket.io'];

function optimisePage(html) {
  if (typeof html !== 'string') return html;
  const v = assetVersion();
  let out = html.replace(/(<(?:script|link)\b[^>]*?\b(?:src|href)=")([^"?#]+)(")/g, (m, pre, url, post) => (LOCAL_ASSETS.test(url) ? pre + url + '?v=' + v + post : m));
  // defer every <script src>: they run in document order after the page is parsed
  out = out.replace(/<script\b(?![^>]*\bdefer\b)([^>]*\bsrc="[^"]+"[^>]*)>/g, '<script defer$1>');
  const hints = HINTS.map((h) => '<link rel="preconnect" href="' + h + '"' + (h.includes('gstatic') ? ' crossorigin' : '') + '>').join('');
  return out.replace(/<head([^>]*)>/i, '<head$1>' + hints);
}

// The page the clean URLs (/app, /schools, /legal) serve: an edited copy if there is one.
function pageHtml(name) {
  const file = PAGE_FILES[name];
  if (!file) return null;
  const o = overrides.get(file);
  const html = o ? o.content : readDisk(file);
  return html == null ? null : optimisePage(html);
}

function normalise(p) {
  const clean = String(p || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.includes('..') || clean.startsWith('.') || clean.includes('//')) return null;
  const ext = path.extname(clean).toLowerCase();
  if (!ALLOWED.has(ext) || BLOCKED.has(clean)) return null;
  const full = path.join(PUBLIC_DIR, clean);
  if (!full.startsWith(PUBLIC_DIR + path.sep)) return null;
  return clean;
}

function validate(file, content) {
  if (typeof content !== 'string') return 'The file content is missing.';
  if (Buffer.byteLength(content) > MAX_BYTES) return 'That file is too large (limit 1.4 MB).';
  const ext = path.extname(file).toLowerCase();
  if (ext === '.js') {
    try { new (require('vm').Script)(content, { filename: file }); } catch (e) { return 'JavaScript error: ' + e.message; }
  }
  if (ext === '.json' || ext === '.webmanifest') {
    try { JSON.parse(content); } catch (e) { return 'Invalid JSON: ' + e.message; }
  }
  return null;
}

async function load() {
  const rows = await prisma.siteFileVersion.findMany({ where: { status: 'PUBLISHED' }, orderBy: { publishedAt: 'asc' } });
  const next = new Map();
  for (const r of rows) next.set(r.path, { content: r.content, type: TYPES[path.extname(r.path).toLowerCase()] || 'text/plain' });
  overrides = next;
  const stamps = rows.map((r) => (r.publishedAt ? r.publishedAt.getTime() : 0));
  overridesStamp = stamps.length ? Math.max(...stamps).toString(36) : '0';
}

// Disk files the editor can list.
function listDiskFiles() {
  const out = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const rel = path.relative(PUBLIC_DIR, full).replace(/\\/g, '/');
      if (normalise(rel)) out.push({ path: rel, size: fs.statSync(full).size });
    }
  })(PUBLIC_DIR);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function readDisk(file) {
  try { return fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8'); } catch { return null; }
}

// The pages the server serves at clean URLs.


function getOverride(file) {
  return overrides.get(file) || null;
}

function start() {
  load().catch((e) => console.error('Could not load site files:', e.message));
  setInterval(() => load().catch(() => {}), 60 * 1000).unref();
}

// Express middleware: serve a published override for any matching GET before the static
// handler sees it. Clean page URLs (/app, /schools, /legal) map to their html files.
function middleware(req, res, next) {
  if (req.method !== 'GET' || !overrides.size) return next();
  const rel = decodeURIComponent(req.path).replace(/^\/+/, '');
  if (PAGE_FILES[rel]) return next(); // pages are rendered (with overrides applied) by the page route
  const hit = overrides.get(rel);
  if (!hit) return next();
  res.setHeader('Content-Type', hit.type);
  // A versioned request (?v=...) can be cached for good: the version changes when the file does.
  res.setHeader('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
  res.send(hit.content);
}

module.exports = { assetVersion, pageHtml, optimisePage, PUBLIC_DIR, PAGE_FILES, normalise, validate, load, start, listDiskFiles, readDisk, getOverride, middleware, MAX_BYTES, TYPES };
