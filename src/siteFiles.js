const fs = require('fs');
const path = require('path');
const prisma = require('./db');

// Front-end files edited from the admin panel's Code Editor. The newest PUBLISHED version of a
// file overrides the copy shipped in public/, and is served from memory (refreshed on every
// publish and once a minute, so a second server instance catches up).
//
// Safety rails, because a bad front-end file can lock every user out:
//   - only text files inside public/ with an allowed extension;
//   - JavaScript must parse, JSON must be valid, before a draft is even saved;
//   - the admin panel itself (admin-panel/) is not editable, so it can always roll a change back;
//   - the service worker is not editable (a broken one is very hard to recover from).
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const ALLOWED = new Set(['.html', '.css', '.js', '.json', '.svg', '.webmanifest', '.txt']);
const BLOCKED = new Set(['sw.js']);
const MAX_BYTES = 600 * 1024;
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
  if (Buffer.byteLength(content) > MAX_BYTES) return 'That file is too large (limit 600 KB).';
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
const PAGE_FILES = { app: 'app.html', schools: 'schools.html', legal: 'legal.html' };

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
  let rel = decodeURIComponent(req.path).replace(/^\/+/, '');
  if (PAGE_FILES[rel]) rel = PAGE_FILES[rel];
  const hit = overrides.get(rel);
  if (!hit) return next();
  res.setHeader('Content-Type', hit.type);
  res.setHeader('Cache-Control', 'no-cache');
  res.send(hit.content);
}

module.exports = { PUBLIC_DIR, PAGE_FILES, normalise, validate, load, start, listDiskFiles, readDisk, getOverride, middleware, MAX_BYTES, TYPES };
