const { v2: cloudinary } = require('cloudinary');

function isConfigured() {
  return !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
}

if (isConfigured()) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

// Uploads a Buffer (from multer's memory storage) to Cloudinary and returns the
// permanent HTTPS URL. resource_type "auto" lets Cloudinary handle PDFs/images/video
// correctly instead of guessing wrong on non-image files.
function uploadBuffer(buffer, filename) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: 'auto', folder: 'learnza', public_id: filename.replace(/\.[^/.]+$/, '') },
      (err, result) => (err ? reject(err) : resolve(result.secure_url))
    );
    stream.end(buffer);
  });
}

module.exports = { isConfigured, uploadBuffer };
