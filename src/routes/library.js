const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const prisma = require('../db');
const { requireAuth, requireRole, logActivity } = require('../auth');
const cloudinary = require('../services/cloudinary.service');

const router = express.Router();

// Buffered in memory (not written to disk directly) so the same upload can go to
// Cloudinary when configured, or fall back to local disk otherwise. Local disk is
// NOT durable on Render -- a redeploy wipes it -- so it's a dev/fallback path only,
// not something to rely on in production without Cloudinary configured.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const uploadsDir = path.join(__dirname, '..', '..', 'uploads');

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

  let fileUrl = externalUrl;
  if (req.file) {
    const safeName = `${Date.now()}-${req.file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
    if (cloudinary.isConfigured()) {
      try {
        fileUrl = await cloudinary.uploadBuffer(req.file.buffer, safeName);
      } catch {
        return res.status(502).json({ error: 'Upload to cloud storage failed. Please try again.' });
      }
    } else {
      fs.mkdirSync(uploadsDir, { recursive: true });
      fs.writeFileSync(path.join(uploadsDir, safeName), req.file.buffer);
      fileUrl = `/uploads/${safeName}`;
    }
  }
  if (!fileUrl) return res.status(400).json({ error: 'Attach a file or provide a link' });

  const item = await prisma.libraryResource.create({
    data: { title, author, type, courseId: courseId || null, fileUrl, uploaderId: req.user.id },
  });
  if (req.user.role === 'LECTURER') await logActivity(req.user.id, 'UPLOAD_LIBRARY_RESOURCE', title);
  res.json({ item, storage: cloudinary.isConfigured() ? 'cloudinary' : 'local-disk' });
});

module.exports = router;
