const express = require('express');
const prisma = require('../db');
const { requireAuth, requireRole, logActivity } = require('../auth');
const { memoryUpload, saveUpload } = require('../services/fileUpload.service');

const router = express.Router();
const upload = memoryUpload(25);

router.get('/library', requireAuth, async (req, res) => {
  const { courseId } = req.query;
  const items = await prisma.libraryResource.findMany({
    where: courseId ? { courseId } : undefined,
    orderBy: { createdAt: 'desc' },
  });
  res.json({ items });
});

router.post('/library', requireAuth, requireRole('LECTURER', 'ADMIN'), upload.single('file'), async (req, res) => {
  const { title, author, type, courseId } = req.body;
  if (!title || !author || !type) return res.status(400).json({ error: 'Title, author and type are required' });
  if (!req.file) return res.status(400).json({ error: 'Attach a file from your device.' });

  let fileUrl, storage;
  try {
    ({ url: fileUrl, storage } = await saveUpload(req.file));
  } catch {
    return res.status(502).json({ error: 'Upload to cloud storage failed. Please try again.' });
  }

  const item = await prisma.libraryResource.create({
    data: { title, author, type, courseId: courseId || null, fileUrl, uploaderId: req.user.id },
  });
  if (req.user.role === 'LECTURER') await logActivity(req.user.id, 'UPLOAD_LIBRARY_RESOURCE', title);
  res.json({ item, storage });
});

module.exports = router;
