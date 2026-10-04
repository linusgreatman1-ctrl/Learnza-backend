const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const prisma = require('../db');
const { logAction } = require('../audit');
const site = require('../siteFiles');

// The Code Editor: edit the front-end files (public/*) from the admin panel, preview the
// result live, then publish. Mounted inside routes/super.js (super admin only). Publishing
// and rolling back need the owner's password again, and every change is written to the
// audit log with the file name and version.
const router = express.Router();

const note = (v) => String(v || '').trim().slice(0, 200) || null;

function badPath(res) {
  return res.status(400).json({ error: 'That file cannot be edited here. Only text files inside the public folder (html, css, js, json, svg) can, and not the service worker.' });
}

async function confirmPassword(req, res) {
  const ok = req.body.password && (await bcrypt.compare(String(req.body.password), req.user.passwordHash));
  if (!ok) res.status(403).json({ error: 'Enter your password to confirm.', code: 'PASSWORD_REQUIRED' });
  return !!ok;
}

router.get('/code/files', async (req, res) => {
  const disk = site.listDiskFiles();
  const rows = await prisma.siteFileVersion.findMany({ where: { status: { in: ['DRAFT', 'PUBLISHED'] } }, select: { path: true, status: true } });
  const published = new Set(rows.filter((r) => r.status === 'PUBLISHED').map((r) => r.path));
  const drafts = new Set(rows.filter((r) => r.status === 'DRAFT').map((r) => r.path));
  res.json({ files: disk.map((f) => ({ ...f, customised: published.has(f.path), hasDraft: drafts.has(f.path) })) });
});

router.get('/code/file', async (req, res) => {
  const file = site.normalise(req.query.path);
  if (!file) return badPath(res);
  const original = site.readDisk(file);
  if (original == null) return res.status(404).json({ error: 'File not found' });
  const [published, draft] = await Promise.all([
    prisma.siteFileVersion.findFirst({ where: { path: file, status: 'PUBLISHED' }, orderBy: { publishedAt: 'desc' } }),
    prisma.siteFileVersion.findFirst({ where: { path: file, status: 'DRAFT' }, orderBy: { createdAt: 'desc' } }),
  ]);
  res.json({
    path: file,
    original,
    published: published ? { id: published.id, content: published.content, publishedAt: published.publishedAt, authorEmail: published.authorEmail, note: published.note } : null,
    draft: draft ? { id: draft.id, content: draft.content, createdAt: draft.createdAt } : null,
  });
});

router.get('/code/versions', async (req, res) => {
  const file = site.normalise(req.query.path);
  if (!file) return badPath(res);
  const versions = await prisma.siteFileVersion.findMany({
    where: { path: file, status: { not: 'DRAFT' } },
    orderBy: { createdAt: 'desc' },
    take: 40,
    select: { id: true, status: true, note: true, authorEmail: true, createdAt: true, publishedAt: true, content: true },
  });
  res.json({ versions: versions.map(({ content, ...v }) => ({ ...v, size: Buffer.byteLength(content) })) });
});

// Saving a draft changes nothing for users; only the live preview shows it.
router.put('/code/draft', async (req, res) => {
  const file = site.normalise(req.body.path);
  if (!file) return badPath(res);
  const problem = site.validate(file, req.body.content);
  if (problem) return res.status(400).json({ error: problem });
  await prisma.siteFileVersion.deleteMany({ where: { path: file, status: 'DRAFT' } });
  const draft = await prisma.siteFileVersion.create({
    data: { path: file, content: req.body.content, status: 'DRAFT', note: note(req.body.note), authorEmail: req.user.email },
  });
  res.json({ draft: { id: draft.id, createdAt: draft.createdAt } });
});

router.post('/code/discard', async (req, res) => {
  const file = site.normalise(req.body.path);
  if (!file) return badPath(res);
  await prisma.siteFileVersion.deleteMany({ where: { path: file, status: 'DRAFT' } });
  res.json({ ok: true });
});

async function publishContent(req, file, content, why) {
  await prisma.$transaction([
    prisma.siteFileVersion.updateMany({ where: { path: file, status: 'PUBLISHED' }, data: { status: 'SUPERSEDED' } }),
    prisma.siteFileVersion.deleteMany({ where: { path: file, status: 'DRAFT' } }),
    prisma.siteFileVersion.create({
      data: { path: file, content, status: 'PUBLISHED', note: why, authorEmail: req.user.email, publishedAt: new Date() },
    }),
  ]);
  await site.load();
}

router.post('/code/publish', async (req, res) => {
  const file = site.normalise(req.body.path);
  if (!file) return badPath(res);
  if (!(await confirmPassword(req, res))) return;
  const draft = await prisma.siteFileVersion.findFirst({ where: { path: file, status: 'DRAFT' }, orderBy: { createdAt: 'desc' } });
  if (!draft) return res.status(400).json({ error: 'There is no draft to publish. Save your changes first.' });
  const problem = site.validate(file, draft.content);
  if (problem) return res.status(400).json({ error: problem });
  await publishContent(req, file, draft.content, draft.note || 'Published from the Code Editor');
  await logAction(req, 'SITE_FILE_PUBLISHED', 'SiteFile', file, { bytes: Buffer.byteLength(draft.content), note: draft.note });
  res.json({ ok: true });
});

// Put an older version back (as a new published version, so history stays complete).
router.post('/code/rollback', async (req, res) => {
  if (!(await confirmPassword(req, res))) return;
  const version = await prisma.siteFileVersion.findUnique({ where: { id: String(req.body.versionId || '') } });
  if (!version || version.status === 'DRAFT') return res.status(404).json({ error: 'Version not found' });
  const problem = site.validate(version.path, version.content);
  if (problem) return res.status(400).json({ error: problem });
  await publishContent(req, version.path, version.content, `Rolled back to the version from ${version.createdAt.toISOString().slice(0, 16).replace('T', ' ')}`);
  await logAction(req, 'SITE_FILE_ROLLED_BACK', 'SiteFile', version.path, { toVersion: version.id });
  res.json({ ok: true });
});

// Drop every customisation of a file: users get the copy that shipped with the last deploy.
router.post('/code/revert', async (req, res) => {
  const file = site.normalise(req.body.path);
  if (!file) return badPath(res);
  if (!(await confirmPassword(req, res))) return;
  await prisma.siteFileVersion.updateMany({ where: { path: file, status: 'PUBLISHED' }, data: { status: 'SUPERSEDED', note: 'Reverted to the original file' } });
  await prisma.siteFileVersion.deleteMany({ where: { path: file, status: 'DRAFT' } });
  await site.load();
  await logAction(req, 'SITE_FILE_REVERTED', 'SiteFile', file);
  res.json({ ok: true });
});

// A 30-minute link for the live preview iframe. The iframe navigates by URL and cannot send
// an Authorization header, so the (short-lived, preview-only) token travels in the path.
router.post('/code/preview-token', (req, res) => {
  const token = jwt.sign({ purpose: 'preview', id: req.user.id }, process.env.JWT_SECRET, { expiresIn: '30m' });
  res.json({ token });
});

// ---- the preview itself (mounted at /_preview/:token/* by server.js, outside /api) ----
async function previewHandler(req, res) {
  try {
    const payload = jwt.verify(req.params.token, process.env.JWT_SECRET);
    if (payload.purpose !== 'preview') throw new Error('wrong token');
  } catch {
    return res.status(401).send('This preview link has expired. Reopen the preview from the Code Editor.');
  }
  let rel = decodeURIComponent(req.params[0] || '').replace(/^\/+/, '');
  if (!rel) rel = 'app';
  if (site.PAGE_FILES[rel]) rel = site.PAGE_FILES[rel];
  const ext = path.extname(rel).toLowerCase();
  const file = site.normalise(rel);
  res.setHeader('Cache-Control', 'no-store');

  if (!file) {
    // Images, fonts and other assets: serve from disk if they are inside public/.
    const full = path.join(site.PUBLIC_DIR, rel);
    if (!rel || rel.includes('..') || !full.startsWith(site.PUBLIC_DIR + path.sep)) return res.status(404).end();
    return res.sendFile(full, (err) => { if (err && !res.headersSent) res.status(404).end(); });
  }
  const draft = await prisma.siteFileVersion.findFirst({ where: { path: file, status: 'DRAFT' }, orderBy: { createdAt: 'desc' } });
  const override = site.getOverride(file);
  let content = draft ? draft.content : override ? override.content : site.readDisk(file);
  if (content == null) return res.status(404).end();
  if (ext === '.html') content = content.replace(/<head([^>]*)>/i, `<head$1><base href="/_preview/${req.params.token}/">`);
  res.setHeader('Content-Type', site.TYPES[ext] || 'text/plain');
  res.send(content);
}

module.exports = router;
module.exports.previewHandler = previewHandler;
