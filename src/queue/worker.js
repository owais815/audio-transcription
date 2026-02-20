/**
 * Worker process — runs separately from the web server.
 *
 * Start with: node src/queue/worker.js
 * Or via npm: npm run worker
 *
 * Keeping workers in a separate process means:
 * - A crash in FFmpeg/Whisper doesn't take down the API server
 * - Workers can be scaled independently (e.g. 3 API pods, 10 worker pods)
 * - Memory-hungry FFmpeg ops don't affect API latency
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import transcriptionQueue from './transcriptionQueue.js';
import { Transcript } from '../models/Transcript.js';
import { transcribeAudio } from '../transcriptionService.js';
import { uploadAudioToS3, downloadFromS3 } from '../services/storageService.js';
import { cleanupFiles } from '../audioProcessor.js';
import config from '../config/index.js';

// Connect to MongoDB
await mongoose.connect(config.mongoUri);
console.log('Worker: MongoDB connected');

// Process jobs — concurrency = 3 means at most 3 simultaneous Whisper calls
transcriptionQueue.process(config.queue.concurrency, async (job) => {
  const { jobId, s3Key, localFilePath, originalFilename, mimeType, fileSize } = job.data;

  console.log(`[${jobId}] Starting transcription`);

  // Mark as processing in DB
  await Transcript.findOneAndUpdate(
    { jobId },
    {
      status: 'processing',
      attempts: job.attemptsMade + 1,
      'progress.stage': 'starting',
      'progress.percent': 0,
    }
  );

  // If S3 is configured: download the file from S3 to a temp location.
  // If S3 is not configured (local dev): use the localFilePath directly.
  let audioPath = localFilePath;
  const tempFiles = [];

  if (s3Key) {
    const tempDir = path.join(tmpdir(), 'transcription-worker');
    await mkdir(tempDir, { recursive: true });
    const ext = path.extname(originalFilename) || '.audio';
    audioPath = path.join(tempDir, `${jobId}${ext}`);
    await downloadFromS3(s3Key, audioPath);
    tempFiles.push(audioPath);
  }

  // Progress callback — updates DB so polling clients see live progress
  const onProgress = async ({ stage, percent }) => {
    await Transcript.findOneAndUpdate(
      { jobId },
      { 'progress.stage': stage, 'progress.percent': percent }
    );
    await job.progress(percent);
  };

  try {
    const result = await transcribeAudio(audioPath, {}, onProgress);

    // Persist the completed transcription
    await Transcript.findOneAndUpdate(
      { jobId },
      {
        status: 'completed',
        completedAt: new Date(),
        'metadata.duration': result.metadata.duration,
        'metadata.language': result.metadata.language,
        'transcription.fullText': result.transcription.fullText,
        'transcription.wordCount': result.transcription.wordCount,
        'transcription.segments': result.transcription.segments,
        'progress.stage': 'done',
        'progress.percent': 100,
        error: undefined,
      }
    );

    console.log(`[${jobId}] Completed — ${result.transcription.wordCount} words, ${result.metadata.duration.toFixed(1)}s audio`);
    return result;

  } finally {
    await cleanupFiles(tempFiles);
  }
});

// Failed jobs (all retries exhausted) — mark as failed in DB
transcriptionQueue.on('failed', async (job, err) => {
  const { jobId } = job.data;
  console.error(`[${jobId}] Failed after ${job.attemptsMade} attempts: ${err.message}`);

  await Transcript.findOneAndUpdate(
    { jobId },
    {
      status: 'failed',
      error: err.message,
      completedAt: new Date(),
      'progress.stage': 'failed',
    }
  );
});

// Graceful shutdown — finish current jobs, don't accept new ones
const shutdown = async (signal) => {
  console.log(`Worker: ${signal} received, shutting down gracefully...`);
  await transcriptionQueue.close();
  await mongoose.disconnect();
  console.log('Worker: shutdown complete');
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

console.log(`Worker: listening for jobs (concurrency: ${config.queue.concurrency})`);
