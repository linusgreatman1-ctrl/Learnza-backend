const express = require('express');
const prisma = require('../db');
const { requireAuth, requireRole, logActivity } = require('../auth');
const { memoryUpload, saveUpload } = require('../services/fileUpload.service');
const { courseInSchool, hasSchool } = require('../scope');

const router = express.Router();
const upload = memoryUpload(25);

// What a user can browse: the platform's own catalog (schoolId null -- uploaded by the
// platform owner from the admin panel) plus, for school members, their own school's uploads.
// One school never sees another's resources. Independent learners see the platform catalog.
router.get('/library', requireAuth, async (req, res) => {
  const { courseId, departmentId } = req.query;
  const visible = hasSchool(req.user) ? { OR: [{ schoolId: req.user.schoolId }, { schoolId: null }] } : { schoolId: null };
  const narrow = [];
  if (courseId) narrow.push({ courseId: String(courseId) });
  if (departmentId) narrow.push({ course: { departmentId: String(departmentId) } });
  const items = await prisma.libraryResource.findMany({
    where: { AND: [visible, ...narrow] },
    include: { course: { select: { id: true, code: true, title: true, departmentId: true } }, uploader: { select: { fullName: true } } },
    orderBy: [{ type: 'asc' }, { title: 'asc' }],
  });
  res.json({ items });
});

router.post('/library', requireAuth, requireRole('LECTURER', 'ADMIN'), upload.single('file'), async (req, res) => {
  const { title, publisher, type, courseId } = req.body;
  const author = String(req.body.author || '').trim() || req.user.fullName;
  if (!title || !type) return res.status(400).json({ error: 'A title and a type are required' });
  if (!req.file) return res.status(400).json({ error: 'Attach a file from your device.' });
  if (!hasSchool(req.user)) return res.status(403).json({ error: 'Only school staff can add to a school library.' });
  if (courseId && !(await courseInSchool(courseId, req.user.schoolId))) return res.status(404).json({ error: 'Course not found' });

  let fileUrl, storage;
  try {
    ({ url: fileUrl, storage } = await saveUpload(req.file));
  } catch {
    return res.status(502).json({ error: 'Upload to cloud storage failed. Please try again.' });
  }

  const item = await prisma.libraryResource.create({
    data: { title, author, publisher: publisher || null, type, courseId: courseId || null, fileUrl, uploaderId: req.user.id, schoolId: req.user.schoolId },
  });
  if (req.user.role === 'LECTURER') await logActivity(req.user.id, 'UPLOAD_LIBRARY_RESOURCE', title);
  res.json({ item, storage });
});

// A lecturer removes what he added; the school admin can remove anything their school added.
router.delete('/library/:id', requireAuth, requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  const item = hasSchool(req.user) ? await prisma.libraryResource.findFirst({ where: { id: req.params.id, schoolId: req.user.schoolId } }) : null;
  if (!item || (req.user.role !== 'ADMIN' && item.uploaderId !== req.user.id)) return res.status(404).json({ error: 'File not found' });
  await prisma.libraryResource.delete({ where: { id: item.id } });
  res.json({ ok: true });
});

module.exports = router;
