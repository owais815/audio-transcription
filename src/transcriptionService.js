import OpenAI from "openai";
import { createReadStream } from "fs";
import { normalizeAudio, splitAudioIntoChunks, getAudioDuration, cleanupFiles } from "./audioProcessor.js";
import config from "./config/index.js";

const openai = new OpenAI({ apiKey: config.openai.apiKey });

/**
 * Transcribes a single audio chunk and returns segments with absolute timestamps.
 * The `timestamp_granularities` param gives us word/segment-level timing from Whisper.
 */
async function transcribeChunk(chunkPath, timeOffset = 0) {
  const response = await openai.audio.transcriptions.create({
    file: createReadStream(chunkPath),
    model: "whisper-1",
    response_format: "verbose_json", // Gives us segments with timestamps
    timestamp_granularities: ["segment"], // segment = sentence-level; 'word' for word-level
  });

  // Offset timestamps so chunks stitch together correctly in the final output
  const segments = (response.segments || []).map((segment) => ({
    id: segment.id,
    start: parseFloat((segment.start + timeOffset).toFixed(3)),
    end: parseFloat((segment.end + timeOffset).toFixed(3)),
    text: segment.text.trim(),
    confidence: segment.avg_logprob ? Math.exp(segment.avg_logprob) : null, // log prob → probability
  }));

  return {
    text: response.text,
    segments,
    language: response.language,
  };
}

/**
 * Main pipeline function.
 * Takes a raw uploaded file path, handles everything, returns clean structured output.
 *
 * @param {string} rawFilePath  - Path to the uploaded audio file on disk
 * @param {object} options      - Optional overrides (e.g. { language: 'en' })
 * @param {function} onProgress - Optional callback: ({ stage, percent }) => void
 */
export async function transcribeAudio(rawFilePath, options = {}, onProgress = null) {
  const startedAt = Date.now();
  const tempFiles = [];

  const progress = (stage, percent) => {
    if (onProgress) onProgress({ stage, percent });
  };

  try {
    // Step 1: Normalize to WAV regardless of input format
    progress("normalizing", 10);
    const normalizedPath = await normalizeAudio(rawFilePath);
    tempFiles.push(normalizedPath);

    // Step 2: Split into chunks if needed
    progress("splitting", 20);
    const chunks = await splitAudioIntoChunks(normalizedPath);
    tempFiles.push(...chunks.filter((c) => c.path !== normalizedPath).map((c) => c.path));

    // Step 3: Transcribe all chunks (sequentially to respect API rate limits)
    const chunkResults = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const chunkPercent = 20 + Math.round(((i + 1) / chunks.length) * 70);
      progress("transcribing", chunkPercent);
      const result = await transcribeChunk(chunk.path, chunk.startTime);
      chunkResults.push(result);
    }

    // Step 4: Merge results from all chunks
    progress("merging", 95);
    const mergedSegments = mergeChunkSegments(chunkResults);
    const fullText = chunkResults
      .map((r) => r.text)
      .join(" ")
      .trim();

    progress("done", 100);

    return {
      success: true,
      metadata: {
        duration: await getAudioDuration(normalizedPath),
        language: chunkResults[0]?.language || "unknown",
        chunksProcessed: chunks.length,
        processingTimeMs: Date.now() - startedAt,
      },
      transcription: {
        fullText,
        segments: mergedSegments,
        wordCount: fullText.split(/\s+/).filter(Boolean).length,
      },
    };
  } finally {
    // Always clean up, even if transcription failed
    await cleanupFiles(tempFiles);
  }
}

/**
 * Merges segments from multiple chunks, removing duplicates caused by overlap.
 * Two segments are "duplicate" if they start within 5 seconds of each other and share text.
 */
function mergeChunkSegments(chunkResults) {
  const allSegments = chunkResults.flatMap((r) => r.segments);
  const merged = [];

  for (const segment of allSegments) {
    const isDuplicate = merged.some(
      (existing) =>
        Math.abs(existing.start - segment.start) < 5 && existing.text.toLowerCase() === segment.text.toLowerCase(),
    );
    if (!isDuplicate) merged.push(segment);
  }

  return merged.sort((a, b) => a.start - b.start);
}
