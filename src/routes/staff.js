const express = require('express');
const prisma = require('../db');
const { requireAuth, requireRole } = require('../auth');

const router = express.Router();

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

router.post('/staff/attendance/checkin', requireAuth, requireRole('LECTURER'), async (req, res) => {
  const date = startOfToday();
  const record = await prisma.staffAttendanceRecord.upsert({
    where: { userId_date: { userId: req.user.id, date } },
    create: { userId: req.user.id, date, status: 'PRESENT' },
    update: {},
  });
  res.json({ record });
});

router.get('/staff/attendance/me', requireAuth, requireRole('LECTURER'), async (req, res) => {
  const records = await prisma.staffAttendanceRecord.findMany({
    where: { userId: req.user.id },
    orderBy: { date: 'desc' },
    take: 60,
  });
  res.json({ records });
});

router.post('/staff/cpd', requireAuth, requireRole('LECTURER'), async (req, res) => {
  const { title, provider, hours, completedAt } = req.body;
  if (!title || !provider || !hours || !completedAt) return res.status(400).json({ error: 'Title, provider, hours and date are required.' });
  const record = await prisma.cpdRecord.create({
    data: { userId: req.user.id, title, provider, hours: Number(hours), completedAt: new Date(completedAt) },
  });
  res.json({ record });
});

router.get('/staff/cpd/me', requireAuth, requireRole('LECTURER'), async (req, res) => {
  const records = await prisma.cpdRecord.findMany({ where: { userId: req.user.id }, orderBy: { completedAt: 'desc' } });
  res.json({ records });
});

// ---- My Publications: a lecturer's publications, journals, books, conference papers and CPD, each as a link and/or an uploaded
// file, and a PDF or photo can be put in the e-Library for students to read (page by page, never downloaded).
const { memoryUpload, saveUpload } = require('../services/fileUpload.service');
const pubUpload = memoryUpload(25);
const PUB_KINDS = ['PUBLICATION', 'JOURNAL', 'BOOK', 'CONFERENCE', 'CPD', 'OTHER'];
const LIB_TYPE = { JOURNAL: 'Journal', PUBLICATION: 'Journal', CONFERENCE: 'Journal', BOOK: 'Textbook', CPD: 'Handout', OTHER: 'Handout' };
const ALLOWED_DOC = /^(application\/pdf|application\/msword|application\/vnd\.openxmlformats-officedocument\.[a-z.]+|image\/(png|jpe?g|webp))$/;
const isReadable = (name, url) => /\.(pdf|png|jpe?g|webp)(\?|#|$)/i.test(name || '') || /\.(pdf|png|jpe?g|webp)(\?|#|$)/i.test(url || '');
const truthy = (v) => v === true || v === 'true' || v === '1' || v === 1 || v === 'on';
const presentPub = (p) => ({
  id: p.id, kind: p.kind, title: p.title, outlet: p.outlet, year: p.year, url: p.url, fileUrl: p.fileUrl, fileName: p.fileName,
  description: p.description, inLibrary: !!p.libraryId, canLibrary: !!p.fileUrl && isReadable(p.fileName, p.fileUrl), createdAt: p.createdAt,
});

// Reads and checks what a lecturer typed in; { data } or { error }.
function pubFields(body, partial) {
  const data = {};
  const has = (k) => !partial || body[k] !== undefined;
  if (has('title')) { data.title = String(body.title || '').trim().slice(0, 240); if (!data.title) return { error: 'Give it a title.' }; }
  if (has('outlet')) { data.outlet = String(body.outlet || '').trim().slice(0, 200); if (!data.outlet) return { error: 'Say where it was published (journal, publisher, conference or provider).' }; }
  if (has('year')) { const y = parseInt(body.year, 10); if (!(y >= 1950 && y <= new Date().getFullYear() + 1)) return { error: 'Enter a year that makes sense.' }; data.year = y; }
  if (has('kind')) data.kind = PUB_KINDS.includes(body.kind) ? body.kind : 'PUBLICATION';
  if (has('url')) {
    const u = String(body.url || '').trim();
    if (u && !/^https?:\/\/\S+$/i.test(u)) return { error: 'The link must start with http:// or https://.' };
    data.url = u || null;
  }
  if (has('description')) data.description = String(body.description || '').trim().slice(0, 1200) || null;
  return { data };
}

async function saveDoc(file) {
  if (!ALLOWED_DOC.test(file.mimetype)) return { error: 'Upload a PDF, a Word document or a photo.' };
  const { url } = await saveUpload(file);
  return { fileUrl: url, fileName: file.originalname.slice(0, 160) };
}

// The e-Library entry made from a publication: the same file, read page by page by students and never downloaded.
async function putInLibrary(user, pub) {
  const data = { title: pub.title, author: user.fullName, publisher: pub.outlet, type: LIB_TYPE[pub.kind] || 'Journal', fileUrl: pub.fileUrl, uploaderId: user.id, schoolId: user.schoolId };
  if (pub.libraryId) {
    const have = await prisma.libraryResource.findUnique({ where: { id: pub.libraryId } });
    if (have) { await prisma.libraryResource.update({ where: { id: have.id }, data: { title: data.title, author: data.author, publisher: data.publisher, type: data.type, fileUrl: data.fileUrl } }); return have.id; }
  }
  const made = await prisma.libraryResource.create({ data });
  return made.id;
}

router.post('/staff/publications', requireAuth, requireRole('LECTURER'), pubUpload.single('file'), async (req, res) => {
  const f = pubFields(req.body, false);
  if (f.error) return res.status(400).json({ error: f.error });
  let file = {};
  if (req.file) { file = await saveDoc(req.file); if (file.error) return res.status(400).json({ error: file.error }); }
  if (!f.data.url && !file.fileUrl) return res.status(400).json({ error: 'Add a link, upload the file, or both.' });
  let record = await prisma.publication.create({ data: { userId: req.user.id, ...f.data, ...(file.fileUrl ? { fileUrl: file.fileUrl, fileName: file.fileName } : {}) } });
  if (truthy(req.body.addToLibrary)) {
    if (!record.fileUrl || !isReadable(record.fileName, record.fileUrl)) return res.status(400).json({ error: 'To put it in the e-Library, upload it as a PDF (or a photo).', record: presentPub(record) });
    const libraryId = await putInLibrary(req.user, record);
    record = await prisma.publication.update({ where: { id: record.id }, data: { libraryId } });
  }
  res.json({ record: presentPub(record) });
});

router.put('/staff/publications/:id', requireAuth, requireRole('LECTURER'), pubUpload.single('file'), async (req, res) => {
  const have = await prisma.publication.findFirst({ where: { id: req.params.id, userId: req.user.id } });
  if (!have) return res.status(404).json({ error: 'Publication not found.' });
  const f = pubFields(req.body, true);
  if (f.error) return res.status(400).json({ error: f.error });
  const data = { ...f.data };
  if (req.file) { const file = await saveDoc(req.file); if (file.error) return res.status(400).json({ error: file.error }); data.fileUrl = file.fileUrl; data.fileName = file.fileName; }
  else if (truthy(req.body.removeFile)) { data.fileUrl = null; data.fileName = null; }
  const after = { url: data.url !== undefined ? data.url : have.url, fileUrl: data.fileUrl !== undefined ? data.fileUrl : have.fileUrl };
  if (!after.url && !after.fileUrl) return res.status(400).json({ error: 'Keep a link or a file on it (or remove the whole entry).' });
  let record = await prisma.publication.update({ where: { id: have.id }, data });
  // keep the e-Library copy in step: it follows the file and the title, or goes if there is no readable file left
  if (record.libraryId) {
    if (record.fileUrl && isReadable(record.fileName, record.fileUrl)) await putInLibrary(req.user, record);
    else { await prisma.libraryResource.deleteMany({ where: { id: record.libraryId } }); record = await prisma.publication.update({ where: { id: record.id }, data: { libraryId: null } }); }
  }
  res.json({ record: presentPub(record) });
});

router.delete('/staff/publications/:id', requireAuth, requireRole('LECTURER'), async (req, res) => {
  const have = await prisma.publication.findFirst({ where: { id: req.params.id, userId: req.user.id } });
  if (!have) return res.status(404).json({ error: 'Publication not found.' });
  if (have.libraryId) await prisma.libraryResource.deleteMany({ where: { id: have.libraryId } });
  await prisma.publication.delete({ where: { id: have.id } });
  res.json({ ok: true });
});

router.post('/staff/publications/:id/library', requireAuth, requireRole('LECTURER'), async (req, res) => {
  const have = await prisma.publication.findFirst({ where: { id: req.params.id, userId: req.user.id } });
  if (!have) return res.status(404).json({ error: 'Publication not found.' });
  if (!have.fileUrl || !isReadable(have.fileName, have.fileUrl)) return res.status(400).json({ error: 'To put it in the e-Library, upload it as a PDF (or a photo) first: a link alone cannot be read there.' });
  const libraryId = await putInLibrary(req.user, have);
  const record = await prisma.publication.update({ where: { id: have.id }, data: { libraryId } });
  res.json({ record: presentPub(record) });
});

router.delete('/staff/publications/:id/library', requireAuth, requireRole('LECTURER'), async (req, res) => {
  const have = await prisma.publication.findFirst({ where: { id: req.params.id, userId: req.user.id } });
  if (!have) return res.status(404).json({ error: 'Publication not found.' });
  if (have.libraryId) await prisma.libraryResource.deleteMany({ where: { id: have.libraryId } });
  const record = await prisma.publication.update({ where: { id: have.id }, data: { libraryId: null } });
  res.json({ record: presentPub(record) });
});

router.get('/staff/publications/me', requireAuth, requireRole('LECTURER'), async (req, res) => {
  const records = await prisma.publication.findMany({ where: { userId: req.user.id }, orderBy: [{ year: 'desc' }, { createdAt: 'desc' }] });
  res.json({ records: records.map(presentPub) });
});

// ---- Admin views: real activity-derived workload + all staff records ----

router.get('/admin/staff/workload', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const lecturers = await prisma.user.findMany({
    where: { schoolId: req.user.schoolId, role: 'LECTURER' },
    select: { id: true, fullName: true, department: { select: { name: true } } },
  });
  // Five grouped queries for the whole staff list, not five per lecturer.
  const ids = lecturers.map((l) => l.id);
  const [lessons, assessments, liveClasses, labDemos, courseRows] = ids.length ? await Promise.all([
    prisma.lesson.groupBy({ by: ['authorId'], where: { authorId: { in: ids } }, _count: { _all: true } }),
    prisma.assessment.groupBy({ by: ['authorId'], where: { authorId: { in: ids } }, _count: { _all: true } }),
    prisma.liveClass.groupBy({ by: ['hostId'], where: { hostId: { in: ids } }, _count: { _all: true } }),
    prisma.labDemonstration.groupBy({ by: ['authorId'], where: { authorId: { in: ids }, source: 'CURATED' }, _count: { _all: true } }),
    prisma.lesson.findMany({ where: { authorId: { in: ids } }, distinct: ['authorId', 'courseId'], select: { authorId: true } }),
  ]) : [[], [], [], [], []];
  const count = (rows, key) => new Map(rows.map((r) => [r[key], r._count._all]));
  const L = count(lessons, 'authorId'), A = count(assessments, 'authorId'), C = count(liveClasses, 'hostId'), D = count(labDemos, 'authorId');
  const courses = new Map();
  courseRows.forEach((r) => courses.set(r.authorId, (courses.get(r.authorId) || 0) + 1));
  const workload = lecturers.map((l) => ({
    fullName: l.fullName, department: l.department?.name || null,
    courses: courses.get(l.id) || 0, lessons: L.get(l.id) || 0, assessments: A.get(l.id) || 0, liveClasses: C.get(l.id) || 0, labDemos: D.get(l.id) || 0,
  }));
  res.json({ workload });
});

// Every attendance record, not just recent -- the admin's own "Attendance" view.
router.get('/admin/staff/attendance', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const records = await prisma.staffAttendanceRecord.findMany({
    where: { user: { schoolId: req.user.schoolId, role: 'LECTURER' } },
    include: { user: { select: { fullName: true } } },
    orderBy: { date: 'desc' },
  });
  res.json({ records });
});

router.get('/admin/staff/cpd', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const records = await prisma.cpdRecord.findMany({
    where: { user: { schoolId: req.user.schoolId } },
    include: { user: { select: { fullName: true } } },
    orderBy: { completedAt: 'desc' },
  });
  res.json({ records });
});

router.get('/admin/staff/publications', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const records = await prisma.publication.findMany({
    where: { user: { schoolId: req.user.schoolId } },
    include: { user: { select: { fullName: true } } },
    orderBy: { year: 'desc' },
  });
  res.json({ records });
});

module.exports = router;
