import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { unlink } from 'fs/promises';
import { handleUpload } from '../middleware/upload.js';
import { Transcript } from '../models/Transcript.js';
import { uploadAudioToS3, deleteFromS3, getPresignedDownloadUrl } from '../services/storageService.js';
import {
  enqueueTranscription,
  cancelJob,
  retryJob,
  getQueueMetrics,
} from '../queue/transcriptionQueue.js';
import config from '../config/index.js';

const router = Router();

// ---------------------------------------------------------------------------
// POST /api/v1/transcribe
// Upload audio + immediately enqueue a transcription job.
// Returns 202 Accepted with a jobId for polling.
// ---------------------------------------------------------------------------
router.post('/', async (req, res, next) => {
  // Backpressure guard — refuse new work if queue is too deep
  const metrics = await getQueueMetrics();
  if (metrics.waiting >= config.queue.maxQueueDepth) {
    return res.status(503).json({
      success: false,
      error: 'Service is at capacity. Please try again later.',
      queueDepth: metrics.waiting,
    });
  }

  // Parse multipart upload (streams directly to disk, not into memory)
  try {
    await handleUpload(req, res);
  } catch (uploadErr) {
    return next(uploadErr);
  }

  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No audio file provided. Use field name "audio".' });
  }

  const jobId = uuidv4();
  const { path: localPath, originalname, mimetype, size } = req.file;

  // Upload to S3 before queuing — if S3 upload fails, nothing gets queued
  let s3Key = null;
  try {
    if (config.s3.accessKeyId) {
      s3Key = await uploadAudioToS3(localPath, originalname, mimetype);
    }
  } catch (s3Err) {
    await unlink(localPath).catch(() => {});
    return next(Object.assign(s3Err, { status: 502, message: `S3 upload failed: ${s3Err.message}` }));
  }

  // Create the DB record immediately so clients can poll before the worker picks it up
  await Transcript.create({
    jobId,
    userId: req.headers['x-user-id'] || 'anonymous',
    audioS3Key: s3Key,
    status: 'pending',
    metadata: {
      originalFilename: originalname,
      fileSize: size,
      mimeType: mimetype,
    },
  });

  // Enqueue the job — worker picks it up asynchronously
  await enqueueTranscription({
    jobId,
    s3Key,
    // Pass localPath as fallback for local dev without S3
    localFilePath: s3Key ? null : localPath,
    originalFilename: originalname,
    mimeType: mimetype,
    fileSize: size,
  });

  // Clean up local temp file if it's already in S3
  if (s3Key) {
    await unlink(localPath).catch(() => {});
  }

  res.status(202).json({
    success: true,
    jobId,
    status: 'pending',
    message: 'Audio queued for transcription. Poll GET /api/v1/transcribe/:jobId for status.',
    links: {
      status: `/api/v1/transcribe/${jobId}`,
      cancel: `/api/v1/transcribe/${jobId}`,
    },
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/transcribe/:jobId
// Poll job status. Returns full transcription when completed.
// ---------------------------------------------------------------------------
router.get('/:jobId', async (req, res, next) => {
  try {
    const transcript = await Transcript.findOne({ jobId: req.params.jobId }).lean();

    if (!transcript) {
      return res.status(404).json({ success: false, error: 'Job not found.' });
    }

    const response = {
      success: true,
      jobId: transcript.jobId,
      status: transcript.status,
      progress: transcript.progress,
      metadata: transcript.metadata,
      createdAt: transcript.createdAt,
      completedAt: transcript.completedAt,
    };

    // Include transcription only when done
    if (transcript.status === 'completed') {
      response.transcription = transcript.transcription;

      // Optionally attach a pre-signed URL to download the original audio
      if (transcript.audioS3Key) {
        response.audioDownloadUrl = await getPresignedDownloadUrl(transcript.audioS3Key);
      }
    }

    if (transcript.status === 'failed') {
      response.error = transcript.error;
      response.attempts = transcript.attempts;
    }

    // Suggest polling interval based on status
    if (['pending', 'processing'].includes(transcript.status)) {
      res.set('Retry-After', '5'); // hint: poll again in 5 seconds
    }

    res.json(response);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/transcribe
// List jobs for the authenticated user (paginated, newest first).
// ---------------------------------------------------------------------------
router.get('/', async (req, res, next) => {
  try {
    const userId = req.headers['x-user-id'] || 'anonymous';
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const status = req.query.status; // optional filter

    const filter = { userId };
    if (status) filter.status = status;

    const [jobs, total] = await Promise.all([
      Transcript.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select('jobId status progress metadata createdAt completedAt')
        .lean(),
      Transcript.countDocuments(filter),
    ]);

    res.json({
      success: true,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      jobs,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/transcribe/:jobId
// Cancel a pending job or delete a completed/failed record.
// ---------------------------------------------------------------------------
router.delete('/:jobId', async (req, res, next) => {
  try {
    const transcript = await Transcript.findOne({ jobId: req.params.jobId });
    if (!transcript) {
      return res.status(404).json({ success: false, error: 'Job not found.' });
    }

    if (transcript.status === 'processing') {
      return res.status(409).json({
        success: false,
        error: 'Cannot delete a job that is actively processing. Wait for completion or failure.',
      });
    }

    // Remove from Bull queue (if still pending/delayed)
    await cancelJob(req.params.jobId).catch(() => {});

    // Remove S3 object
    if (transcript.audioS3Key) {
      await deleteFromS3(transcript.audioS3Key).catch(() => {});
    }

    // Remove DB record
    await transcript.deleteOne();

    res.json({ success: true, message: 'Job deleted.' });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/transcribe/:jobId/retry
// Re-queue a failed job.
// ---------------------------------------------------------------------------
router.post('/:jobId/retry', async (req, res, next) => {
  try {
    const transcript = await Transcript.findOne({ jobId: req.params.jobId });
    if (!transcript) {
      return res.status(404).json({ success: false, error: 'Job not found.' });
    }

    if (transcript.status !== 'failed') {
      return res.status(409).json({
        success: false,
        error: `Cannot retry a job with status "${transcript.status}". Only failed jobs can be retried.`,
      });
    }

    // Reset DB state
    await transcript.updateOne({
      status: 'pending',
      error: undefined,
      'progress.stage': 'queued',
      'progress.percent': 0,
    });

    // Re-queue in Bull
    await retryJob(req.params.jobId);

    res.json({
      success: true,
      message: 'Job requeued for processing.',
      jobId: req.params.jobId,
      links: { status: `/api/v1/transcribe/${req.params.jobId}` },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
