import mongoose from 'mongoose';

const segmentSchema = new mongoose.Schema({
  id: Number,
  start: { type: Number, required: true },
  end: { type: Number, required: true },
  text: { type: String, required: true },
  confidence: Number,
}, { _id: false });

const transcriptSchema = new mongoose.Schema({
  jobId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  userId: {
    type: String,
    index: true,
    default: 'anonymous',
  },

  // Where the original file lives in S3
  audioS3Key: String,

  // Original upload info
  metadata: {
    originalFilename: String,
    duration: Number,       // seconds
    language: String,
    fileSize: Number,       // bytes
    mimeType: String,
  },

  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed', 'cancelled'],
    default: 'pending',
    index: true,
  },

  // Progress tracking for polling clients (0–100)
  progress: {
    stage: { type: String, default: 'queued' },
    percent: { type: Number, default: 0 },
  },

  transcription: {
    fullText: String,
    wordCount: Number,
    segments: [segmentSchema],
  },

  // Populated on failure
  error: String,

  // Bull retry counter
  attempts: { type: Number, default: 0 },

  completedAt: Date,
}, {
  timestamps: true, // adds createdAt / updatedAt automatically
});

// Compound index for listing a user's jobs sorted by creation date
transcriptSchema.index({ userId: 1, createdAt: -1 });

// TTL index: auto-delete completed/failed records after 30 days to keep the DB lean
transcriptSchema.index(
  { completedAt: 1 },
  { expireAfterSeconds: 30 * 24 * 60 * 60, partialFilterExpression: { status: { $in: ['completed', 'failed'] } } }
);

export const Transcript = mongoose.model('Transcript', transcriptSchema);
