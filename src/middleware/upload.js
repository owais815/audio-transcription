import multer from 'multer';
import path from 'path';
import { mkdir } from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import config from '../config/index.js';

// Ensure temp upload dir exists
await mkdir('./uploads/raw', { recursive: true });

/**
 * Multer disk storage — files land in ./uploads/raw/<uuid><ext>
 * before being moved to S3 by the route handler.
 *
 * Why disk storage instead of memory storage?
 * Memory storage loads the entire file into RAM before any processing starts.
 * A 500MB upload × 10 concurrent users = 5GB RAM just for buffering — instant OOM.
 * Disk storage streams directly to disk, keeping memory flat regardless of file size.
 */
const storage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    cb(null, './uploads/raw');
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.audio';
    cb(null, `${uuidv4()}${ext}`);
  },
});

/**
 * MIME type guard — rejects anything that isn't audio/video before it hits disk.
 */
function fileFilter(_req, file, cb) {
  if (config.upload.allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      Object.assign(new Error(`Unsupported file type: ${file.mimetype}`), { status: 415 }),
      false
    );
  }
}

export const uploadMiddleware = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: config.upload.maxFileSizeMb * 1024 * 1024,
    files: 1,
  },
}).single('audio'); // Field name in the multipart form must be "audio"

/**
 * Wraps multer in a promise so route handlers can use async/await cleanly.
 */
export function handleUpload(req, res) {
  return new Promise((resolve, reject) => {
    uploadMiddleware(req, res, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
