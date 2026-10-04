const express = require('express');
const path = require('path');
const prisma = require('../db');
const { logAction } = require('../audit');
const site = require('../siteFiles');

// The owner's live source tools, modelled on PassNow's:
//   Code Editor  - find an exact snippet, see it in context, replace it
//   Codes        - the complete raw source of a file, edited and saved whole
//   Live Preview - the real running app in a frame (a panel view; no API)
// Changes take effect the moment they are saved — there is no deploy step — and are stored in
// the database, so a redeploy does not wipe them. Every save keeps the previous content as a
// backup that can be restored. Mounted inside routes/super.js, so only a super admin gets here.
//
// Guard rails: JavaScript must parse and JSON must be valid before anything is saved; only
// text files inside public/ can be touched (not the service worker, not the admin panel, so
// the panel can always undo a bad change); every save, restore and revert is audited.
const router = express.Router();

const KEEP_BACKUPS = 30; // per file

function badPath(res) {
  return res.status(400).json({ error: 'That file cannot be edited here. Only the apps\' text files (html, css, js, json, svg) can, and not the service worker.' });
}

function currentContent(file) {
  const override = site.getOverride(file);
  return override ? override.content : site.readDisk(file);
}

// Saves `content` as the live version of `file`, keeping what was live before as a backup.
async function saveLive(req, file, content, note) {
  const hadOverride = !!site.getOverride(file);
  const original = hadOverride ? null : site.readDisk(file);
  await prisma.$transaction(async (tx) => {
    if (!hadOverride && original != null) {
      // First edit of a file: keep the copy that shipped with the deploy so "undo" can reach it.
      await tx.siteFileVersion.create({ data: { path: file, content: original, status: 'SUPERSEDED', note: 'Original (as deployed)', authorEmail: null } });
    }
    await tx.siteFileVersion.updateMany({ where: { path: file, status: 'PUBLISHED' }, data: { status: 'SUPERSEDED' } });
    await tx.siteFileVersion.create({ data: { path: file, content, status: 'PUBLISHED', note, authorEmail: req.user.email, publishedAt: new Date() } });
    const old = await tx.siteFileVersion.findMany({ where: { path: file, status: 'SUPERSEDED' }, orderBy: { createdAt: 'desc' }, skip: KEEP_BACKUPS, select: { id: true } });
    if (old.length) await tx.siteFileVersion.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
  });
  await site.load();
}

// ---- files ----
router.get('/code/files', async (req, res) => {
  const rows = await prisma.siteFileVersion.findMany({ where: { status: 'PUBLISHED' }, select: { path: true, publishedAt: true } });
  const edited = new Map(rows.map((r) => [r.path, r.publishedAt]));
  res.json({
    files: site.listDiskFiles().map((f) => {
      const live = currentContent(f.path);
      return { path: f.path, size: live != null ? Buffer.byteLength(live) : f.size, customised: edited.has(f.path), lastEdited: edited.get(f.path) || null };
    }),
  });
});

router.get('/code/content', (req, res) => {
  const file = site.normalise(req.query.path);
  if (!file) return badPath(res);
  const content = currentContent(file);
  if (content == null) return res.status(404).json({ error: 'File not found' });
  res.json({ path: file, content, size: Buffer.byteLength(content), customised: !!site.getOverride(file), lines: content.split('\n').length });
});

// ---- Codes: save the whole file ----
router.post('/code/save', async (req, res) => {
  const file = site.normalise(req.body.path);
  if (!file) return badPath(res);
  const problem = site.validate(file, req.body.content);
  if (problem) return res.status(400).json({ error: problem });
  if (req.body.content === currentContent(file)) return res.json({ ok: true, unchanged: true });
  await saveLive(req, file, req.body.content, 'Saved from Codes');
  await logAction(req, 'SITE_FILE_SAVED', 'SiteFile', file, { bytes: Buffer.byteLength(req.body.content), via: 'codes' });
  res.json({ ok: true });
});

// ---- Code Editor: search, then replace ----
router.post('/code/search', (req, res) => {
  const file = site.normalise(req.body.file);
  const query = String(req.body.query || '');
  if (!file) return badPath(res);
  if (!query) return res.status(400).json({ error: 'Type the text to look for.' });
  const content = currentContent(file);
  if (content == null) return res.status(404).json({ error: 'File not found' });
  const ctx = Math.min(400, Math.max(40, parseInt(req.body.contextChars, 10) || 150));
  const MAX = 30;
  const matches = [];
  let from = 0;
  while (matches.length < MAX) {
    const idx = content.indexOf(query, from);
    if (idx === -1) break;
    matches.push({
      index: idx,
      line: content.slice(0, idx).split('\n').length,
      before: content.slice(Math.max(0, idx - ctx), idx),
      match: query,
      after: content.slice(idx + query.length, idx + query.length + ctx),
    });
    from = idx + query.length;
  }
  res.json({ file, query, totalMatches: matches.length, truncated: matches.length === MAX, matches });
});

router.post('/code/replace', async (req, res) => {
  const file = site.normalise(req.body.file);
  const find = String(req.body.find || '');
  if (!file) return badPath(res);
  if (!find || req.body.replaceWith === undefined) return res.status(400).json({ error: 'Both the text to find and its replacement are needed.' });
  const replaceWith = String(req.body.replaceWith);
  let content = currentContent(file);
  if (content == null) return res.status(404).json({ error: 'File not found' });

  const occurrences = content.split(find).length - 1;
  if (occurrences === 0) return res.status(404).json({ error: 'That exact text was not found in the file. Copy it precisely, including spaces and line breaks.' });
  const all = !!req.body.replaceAll;
  const hasIndex = req.body.occurrenceIndex !== undefined && req.body.occurrenceIndex !== null && req.body.occurrenceIndex !== '';
  if (occurrences > 1 && !all && !hasIndex) {
    return res.status(409).json({ error: `That text appears ${occurrences} times. Choose which one to change, or tick "Replace all occurrences".`, occurrences });
  }

  let replaced = 0;
  if (all) {
    replaced = occurrences;
    content = content.split(find).join(replaceWith);
  } else {
    const target = hasIndex ? parseInt(req.body.occurrenceIndex, 10) : 0;
    if (!(target >= 0 && target < occurrences)) return res.status(400).json({ error: 'That occurrence does not exist.' });
    let from = 0;
    for (let i = 0; i <= target; i++) {
      const idx = content.indexOf(find, from);
      if (i === target) { content = content.slice(0, idx) + replaceWith + content.slice(idx + find.length); replaced = 1; break; }
      from = idx + find.length;
    }
  }
  const problem = site.validate(file, content);
  if (problem) return res.status(400).json({ error: `That change would break the file, so nothing was saved. ${problem}` });
  await saveLive(req, file, content, `Replaced ${replaced} occurrence${replaced === 1 ? '' : 's'} from Code Editor`);
  await logAction(req, 'SITE_FILE_REPLACED', 'SiteFile', file, { replaced, findChars: find.length, replaceChars: replaceWith.length });
  res.json({ ok: true, replaced });
});

// A quick index of what a JS file contains: every screen renderer, the screen it is shown
// for, and a search string that finds its definition.
router.get('/code/features', (req, res) => {
  const file = site.normalise(req.query.file);
  if (!file) return badPath(res);
  const content = currentContent(file) || '';
  if (!file.endsWith('.js')) return res.json({ features: [] });
  const screenFor = new Map();
  for (const m of content.matchAll(/case '([\w-]+)':\s*return\s+(render\w+)\(/g)) if (!screenFor.has(m[2])) screenFor.set(m[2], m[1]);
  const seen = new Set();
  const features = [];
  for (const m of content.matchAll(/(?:async\s+)?function\s+(render\w+)\s*\(/g)) {
    const fn = m[1];
    if (seen.has(fn)) continue;
    seen.add(fn);
    const label = fn.replace(/^render/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    features.push({ label, search: `function ${fn}(`, screen: screenFor.get(fn) || null });
  }
  res.json({ features });
});

// ---- backups (every save keeps the previous content) ----
router.get('/code/backups', async (req, res) => {
  const where = { status: 'SUPERSEDED' };
  if (req.query.path) { const f = site.normalise(req.query.path); if (!f) return badPath(res); where.path = f; }
  const rows = await prisma.siteFileVersion.findMany({ where, orderBy: { createdAt: 'desc' }, take: 60, select: { id: true, path: true, note: true, authorEmail: true, createdAt: true, publishedAt: true, content: true } });
  res.json({ backups: rows.map(({ content, ...b }) => ({ ...b, size: Buffer.byteLength(content) })) });
});

router.post('/code/restore', async (req, res) => {
  const version = await prisma.siteFileVersion.findUnique({ where: { id: String(req.body.backupId || '') } });
  if (!version || version.status === 'DRAFT') return res.status(404).json({ error: 'Backup not found' });
  const problem = site.validate(version.path, version.content);
  if (problem) return res.status(400).json({ error: problem });
  await saveLive(req, version.path, version.content, `Restored the version from ${version.createdAt.toISOString().slice(0, 16).replace('T', ' ')}`);
  await logAction(req, 'SITE_FILE_RESTORED', 'SiteFile', version.path, { fromVersion: version.id });
  res.json({ ok: true, path: version.path });
});

// Drop every edit of a file: users get the copy that shipped with the last deploy.
router.post('/code/revert', async (req, res) => {
  const file = site.normalise(req.body.path);
  if (!file) return badPath(res);
  await prisma.siteFileVersion.updateMany({ where: { path: file, status: 'PUBLISHED' }, data: { status: 'SUPERSEDED', note: 'Reverted to the original file' } });
  await site.load();
  await logAction(req, 'SITE_FILE_REVERTED', 'SiteFile', file);
  res.json({ ok: true });
});

module.exports = router;
void path;
