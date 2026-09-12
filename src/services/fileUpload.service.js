const fs = require('fs');
const path = require('path');
const multer = require('multer');
const cloudinary = require('./cloudinary.service');

const uploadsDir = path.join(__dirname, '..', '..', 'uploads');

// Buffered in memory (not written to disk directly) so the same upload can go to
// Cloudinary when configured, or fall back to local disk otherwise. Local disk is
// NOT durable on Render -- a redeploy wipes it -- so it's a dev/fallback path only.
function memoryUpload(maxSizeMb) {
  return multer({ storage: multer.memoryStorage(), limits: { fileSize: maxSizeMb * 1024 * 1024 } });
}

// Saves a multer in-memory file (req.file) and returns { url, storage }. Every upload
// on Learnza comes from the user's own device -- there is no "paste a link instead"
// path -- so this is the single place that decides where the bytes actually land.
async function saveUpload(file) {
  const safeName = `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
  if (cloudinary.isConfigured()) {
    const url = await cloudinary.uploadBuffer(file.buffer, safeName);
    return { url, storage: 'cloudinary' };
  }
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.writeFileSync(path.join(uploadsDir, safeName), file.buffer);
  return { url: `/uploads/${safeName}`, storage: 'local-disk' };
}

module.exports = { memoryUpload, saveUpload };
