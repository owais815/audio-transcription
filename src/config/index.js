import 'dotenv/config';

// Centralised config — all env vars validated at startup, not scattered across files
const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  // MongoDB
  mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017/transcription',

  // Redis (Bull queue backend)
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
  },

  // OpenAI
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
  },

  // AWS S3
  s3: {
    region: process.env.AWS_REGION || 'us-east-1',
    bucket: process.env.S3_BUCKET || 'transcription-audio',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    // Optional: for local dev with MinIO or LocalStack
    endpoint: process.env.S3_ENDPOINT || undefined,
  },

  // Upload limits
  upload: {
    maxFileSizeMb: parseInt(process.env.MAX_FILE_SIZE_MB || '500', 10),
    allowedMimeTypes: [
      'audio/mpeg',        // MP3
      'audio/wav',         // WAV
      'audio/wave',
      'audio/x-wav',
      'audio/mp4',         // M4A
      'audio/x-m4a',
      'audio/ogg',         // OGG
      'audio/webm',        // WEBM
      'audio/flac',        // FLAC
      'audio/x-flac',
      'audio/aac',         // AAC
      'video/mp4',         // MP4 video (audio extracted)
      'video/webm',
    ],
  },

  // Queue
  queue: {
    concurrency: parseInt(process.env.QUEUE_CONCURRENCY || '3', 10),
    maxQueueDepth: parseInt(process.env.MAX_QUEUE_DEPTH || '100', 10),
  },
};

// Validate required vars at startup — fail fast rather than silently degrade
const required = ['OPENAI_API_KEY'];
const missing = required.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  console.error('Copy .env.example to .env and fill in the values.');
  process.exit(1);
}

export default config;
