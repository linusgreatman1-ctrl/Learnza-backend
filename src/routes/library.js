const express = require('express');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const prisma = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { memoryUpload, saveUpload } = require('../services/fileUpload.service');
const { courseInSchool, hasSchool } = require('../scope');

const router = express.Router();
const upload = memoryUpload(25);
const uploadsDir = path.join(__dirname, '..', '..', 'uploads');
const extOf = (url) => ((String(url || '').split('?')[0].match(/\.([a-z0-9]{2,5})$/i) || [])[1] || '').toLowerCase();

// What a user can browse: the platform's own catalog (schoolId null -- uploaded by the platform owner from the admin panel) plus,
// for school members, their own school's books. One school never sees another's. Independent learners see the platform catalog.
function visibleTo(user) {
  return hasSchool(user) ? { OR: [{ schoolId: user.schoolId }, { schoolId: null }] } : { schoolId: null };
}

router.get('/library', requireAuth, async (req, res) => {
  const { courseId, departmentId } = req.query;
  const narrow = [];
  if (courseId) narrow.push({ courseId: String(courseId) });
  if (departmentId) narrow.push({ course: { departmentId: String(departmentId) } });
  const items = await prisma.libraryResource.findMany({
    where: { AND: [visibleTo(req.user), ...narrow] },
    include: { course: { select: { id: true, code: true, title: true, departmentId: true } }, uploader: { select: { fullName: true } } },
    orderBy: [{ type: 'asc' }, { title: 'asc' }],
  });
  // Readers get a book only through /library/:id/read, page by page. The file's address is never put in the list: not for students,
  // not for the lecturer who added it, not for the school admin. `mine` says whether this person may remove it.
  res.json({
    items: items.map(({ fileUrl, ...it }) => ({
      ...it, fileExt: extOf(fileUrl),
      mine: !!(it.schoolId && (it.uploaderId === req.user.id || (req.user.role === 'ADMIN' && it.schoolId === req.user.schoolId))),
    })),
  });
});

// Read-only: the file goes to the reader to be shown page by page, inline, never as a download, only to someone signed in who may see it.
router.get('/library/:id/read', requireAuth, async (req, res) => {
  const it = await prisma.libraryResource.findUnique({ where: { id: req.params.id } });
  const visible = it && (it.schoolId === null || (hasSchool(req.user) && it.schoolId === req.user.schoolId));
  if (!visible) return res.status(404).json({ error: 'That book is not in the library.' });
  const ext = extOf(it.fileUrl);
  const type = ext === 'pdf' ? 'application/pdf' : /^(png|jpe?g|webp)$/.test(ext) ? 'image/' + (ext === 'jpg' ? 'jpeg' : ext) : 'application/octet-stream';
  res.set({ 'Content-Type': type, 'Content-Disposition': 'inline', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  try {
    if (it.fileUrl.startsWith('/uploads/')) {
      const file = path.join(uploadsDir, path.basename(it.fileUrl));
      if (!fs.existsSync(file)) return res.status(404).json({ error: 'The file is missing.' });
      return fs.createReadStream(file).pipe(res);
    }
    const r = await fetch(it.fileUrl);
    if (!r.ok) return res.status(502).json({ error: 'The file could not be opened right now.' });
    if (r.headers.get('content-type') && type === 'application/octet-stream') res.set('Content-Type', r.headers.get('content-type'));
    return Readable.fromWeb(r.body).pipe(res);
  } catch { return res.status(502).json({ error: 'The file could not be opened right now.' }); }
});

// Lecturers (an independent lecturer too) and the school admin add books to their school's library as a PDF or a photo, so they can be
// read page by page. The backend admin adds to the Learnza-wide library from its own panel. A book is removed by whoever added it, or by
// the school admin.
const BOOK_TYPES = ['Textbook', 'Handout', 'Notes', 'Journal'];
router.post('/library', requireAuth, requireRole('LECTURER', 'ADMIN'), upload.single('file'), async (req, res) => {
  if (!hasSchool(req.user)) return res.status(403).json({ error: 'Only people at a school add books here.' });
  const title = String(req.body.title || '').trim().slice(0, 240);
  const author = String(req.body.author || '').trim().slice(0, 200);
  if (!title || !author) return res.status(400).json({ error: 'Give the title and the author.' });
  if (!req.file) return res.status(400).json({ error: 'Choose the book from your device.' });
  if (!/^(application\/pdf|image\/(png|jpe?g|webp))$/.test(req.file.mimetype)) return res.status(400).json({ error: 'Upload the book as a PDF (or a photo), so students can read it page by page.' });
  const type = BOOK_TYPES.includes(req.body.type) ? req.body.type : 'Textbook';
  const courseId = req.body.courseId ? String(req.body.courseId) : null;
  if (courseId && !(await courseInSchool(courseId, req.user.schoolId))) return res.status(400).json({ error: 'That course is not in your school.' });
  let saved;
  try { saved = await saveUpload(req.file); } catch { return res.status(502).json({ error: 'Upload failed. Please try again.' }); }
  const item = await prisma.libraryResource.create({
    data: { title, author, publisher: String(req.body.publisher || '').trim().slice(0, 200) || null, type, courseId, fileUrl: saved.url, uploaderId: req.user.id, schoolId: req.user.schoolId },
  });
  const { fileUrl, ...safe } = item;
  res.json({ item: { ...safe, fileExt: extOf(fileUrl) } });
});

router.delete('/library/:id', requireAuth, async (req, res) => {
  const it = await prisma.libraryResource.findUnique({ where: { id: req.params.id } });
  if (!it || !it.schoolId) return res.status(403).json({ error: 'Only the backend admin can remove the Learnza-wide library books.' });
  const mine = it.uploaderId === req.user.id;
  const myAdmin = req.user.role === 'ADMIN' && it.schoolId === req.user.schoolId;
  if (!mine && !myAdmin) return res.status(403).json({ error: 'You can only remove books you added.' });
  await prisma.libraryResource.delete({ where: { id: it.id } });
  // a book made from a lecturer's publication goes back to being just the publication
  await prisma.publication.updateMany({ where: { libraryId: it.id }, data: { libraryId: null } });
  res.json({ ok: true });
});

module.exports = router;
