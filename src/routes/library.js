const express = require('express');
const multer = require('multer');
const path = require('path');
const prisma = require('../db');
const { requireAuth, requireRole, logActivity } = require('../auth');

const router = express.Router();

const storage = multer.diskStorage({
  destination: path.join(__dirname, '..', '..', 'uploads'),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, `${Date.now()}-${safe}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

router.get('/library', requireAuth, async (req, res) => {
  const { courseId } = req.query;
  const items = await prisma.libraryResource.findMany({
    where: courseId ? { courseId } : undefined,
    orderBy: { createdAt: 'desc' },
  });
  res.json({ items });
});

router.post('/library', requireAuth, requireRole('LECTURER', 'ADMIN'), upload.single('file'), async (req, res) => {
  const { title, author, type, courseId, externalUrl } = req.body;
  if (!title || !author || !type) return res.status(400).json({ error: 'Title, author and type are required' });
  const fileUrl = req.file ? `/uploads/${req.file.filename}` : externalUrl;
  if (!fileUrl) return res.status(400).json({ error: 'Attach a file or provide a link' });

  const item = await prisma.libraryResource.create({
    data: { title, author, type, courseId: courseId || null, fileUrl, uploaderId: req.user.id },
  });
  if (req.user.role === 'LECTURER') await logActivity(req.user.id, 'UPLOAD_LIBRARY_RESOURCE', title);
  res.json({ item });
});

module.exports = router;
