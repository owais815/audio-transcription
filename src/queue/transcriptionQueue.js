import Bull from 'bull';
import config from '../config/index.js';

/**
 * Bull queue backed by Redis.
 *
 * Why Bull?
 * - Battle-tested with a built-in dashboard (bull-board)
 * - Handles retry/backoff automatically
 * - Redis persistence means jobs survive server restarts
 * - Concurrency control at the worker level prevents API rate-limit hammering
 */
const transcriptionQueue = new Bull('transcriptions', {
  redis: {
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000, // 2s → 4s → 8s
    },
    removeOnComplete: false, // Keep history for job status polling
    removeOnFail: false,
    timeout: 30 * 60 * 1000, // 30-minute job timeout — long audio takes time
  },
});

/**
 * Enqueues a new transcription job.
 * Returns the Bull Job object (contains job.id used as the public jobId).
 */
export async function enqueueTranscription(payload) {
  const job = await transcriptionQueue.add(payload, {
    // Job ID doubles as the public-facing ID stored in MongoDB
    jobId: payload.jobId,
  });
  return job;
}

/**
 * Fetches a Bull job by ID — used to check raw queue state.
 */
export async function getJob(jobId) {
  return transcriptionQueue.getJob(jobId);
}

/**
 * Cancels (removes) a pending job. Can't cancel an actively running job.
 */
export async function cancelJob(jobId) {
  const job = await transcriptionQueue.getJob(jobId);
  if (!job) return false;

  const state = await job.getState();
  if (state === 'active') {
    throw new Error('Cannot cancel a job that is actively processing');
  }

  await job.remove();
  return true;
}

/**
 * Returns current queue health metrics — exposed via /api/v1/health
 */
export async function getQueueMetrics() {
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    transcriptionQueue.getWaitingCount(),
    transcriptionQueue.getActiveCount(),
    transcriptionQueue.getCompletedCount(),
    transcriptionQueue.getFailedCount(),
    transcriptionQueue.getDelayedCount(),
  ]);

  return { waiting, active, completed, failed, delayed };
}

/**
 * Retry a specific failed job — enqueues it again with fresh attempts.
 */
export async function retryJob(jobId) {
  const job = await transcriptionQueue.getJob(jobId);
  if (!job) throw new Error('Job not found');

  const state = await job.getState();
  if (state !== 'failed') throw new Error(`Job is not in a failed state (current: ${state})`);

  await job.retry();
  return job;
}

export default transcriptionQueue;
