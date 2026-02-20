import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import { createReadStream, statSync } from 'fs';
import { writeFile, unlink, mkdir } from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

ffmpeg.setFfmpegPath(ffmpegPath);

// Whisper API has a 25MB file size limit
const MAX_CHUNK_SIZE_MB = 20;
const CHUNK_DURATION_SECONDS = 600; // 10-minute chunks for long files

/**
 * Converts any audio format to WAV (16kHz mono — optimal for Whisper)
 * This is the "universal adapter" — the pipeline doesn't care what format comes in
 */
export async function normalizeAudio(inputPath, outputDir = './uploads/processed') {
  await mkdir(outputDir, { recursive: true });

  const outputPath = path.join(outputDir, `${uuidv4()}.wav`);

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioFrequency(16000)   // 16kHz — Whisper's sweet spot
      .audioChannels(1)        // Mono reduces file size without quality loss for speech
      .audioCodec('pcm_s16le') // Standard PCM WAV
      .format('wav')
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(new Error(`FFmpeg conversion failed: ${err.message}`)))
      .save(outputPath);
  });
}

/**
 * Gets audio duration in seconds using FFprobe
 */
export async function getAudioDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration);
    });
  });
}

/**
 * Splits long audio into overlapping chunks to avoid cutting words at boundaries.
 * 10-second overlap ensures no sentence gets lost at the seam.
 */
export async function splitAudioIntoChunks(filePath, outputDir = './uploads/chunks') {
  await mkdir(outputDir, { recursive: true });

  const duration = await getAudioDuration(filePath);

  // Short files don't need splitting
  if (duration <= CHUNK_DURATION_SECONDS) {
    return [{ path: filePath, startTime: 0, endTime: duration }];
  }

  const chunks = [];
  let startTime = 0;
  const overlap = 10; // seconds

  while (startTime < duration) {
    const chunkId = uuidv4();
    const outputPath = path.join(outputDir, `chunk_${chunkId}.wav`);
    const endTime = Math.min(startTime + CHUNK_DURATION_SECONDS, duration);

    await new Promise((resolve, reject) => {
      ffmpeg(filePath)
        .setStartTime(startTime)
        .setDuration(endTime - startTime + (startTime > 0 ? overlap : 0))
        .audioFrequency(16000)
        .audioChannels(1)
        .format('wav')
        .on('end', resolve)
        .on('error', reject)
        .save(outputPath);
    });

    chunks.push({ path: outputPath, startTime, endTime });
    startTime = endTime;
  }

  return chunks;
}

/**
 * Returns file size in MB — used to decide whether a file needs chunking
 */
export function getFileSizeMb(filePath) {
  const stats = statSync(filePath);
  return stats.size / (1024 * 1024);
}

/**
 * Cleanup temp files after processing — good hygiene, respect the server's disk
 */
export async function cleanupFiles(filePaths) {
  await Promise.allSettled(filePaths.map(fp => unlink(fp).catch(() => {})));
}
