const express = require('express');
const prisma = require('../db');
const { requireAuth, requireRole, logActivity } = require('../auth');
const { memoryUpload, saveUpload } = require('../services/fileUpload.service');

const router = express.Router();
const upload = memoryUpload(25);

// Browsable across a whole school (every department/course, not just the ones the
// caller is enrolled in or teaches) -- the e-Library is meant to be a shared campus
// catalog, matching how the department/course browse screen already works. Individual
// (non-school) learners have no school/department/course to browse by at all -- they
// see only resources uploaded with no course attached (?global=true), a catalog
// Learnza itself stocks directly rather than through any one school.
router.get('/library', requireAuth, async (req, res) => {
  const { courseId, departmentId, schoolId, global } = req.query;
  let where;
  if (global === 'true') where = { courseId: null };
  else if (courseId) where = { courseId };
  else if (departmentId) where = { course: { departmentId } };
  else if (schoolId) where = { course: { department: { schoolId } } };
  const items = await prisma.libraryResource.findMany({
    where,
    include: { course: { select: { id: true, code: true, title: true, departmentId: true } } },
    orderBy: [{ type: 'asc' }, { title: 'asc' }],
  });
  res.json({ items });
});

router.post('/library', requireAuth, requireRole('LECTURER', 'ADMIN'), upload.single('file'), async (req, res) => {
  const { title, author, publisher, type, courseId } = req.body;
  if (!title || !author || !type) return res.status(400).json({ error: 'Title, author and type are required' });
  if (!req.file) return res.status(400).json({ error: 'Attach a file from your device.' });

  let fileUrl, storage;
  try {
    ({ url: fileUrl, storage } = await saveUpload(req.file));
  } catch {
    return res.status(502).json({ error: 'Upload to cloud storage failed. Please try again.' });
  }

  const item = await prisma.libraryResource.create({
    data: { title, author, publisher: publisher || null, type, courseId: courseId || null, fileUrl, uploaderId: req.user.id },
  });
  if (req.user.role === 'LECTURER') await logActivity(req.user.id, 'UPLOAD_LIBRARY_RESOURCE', title);
  res.json({ item, storage });
});

module.exports = router;
