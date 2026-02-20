import 'dotenv/config';
import mongoose from 'mongoose';
import app from './app.js';
import config from './config/index.js';

async function start() {
  // Connect to MongoDB before accepting traffic
  await mongoose.connect(config.mongoUri);
  console.log(`MongoDB connected: ${config.mongoUri}`);

  const server = app.listen(config.port, () => {
    console.log(`
╔══════════════════════════════════════════════╗
║      Transcription Pipeline API              ║
║      http://localhost:${config.port}                 ║
╚══════════════════════════════════════════════╝

Endpoints:
  POST   /api/v1/transcribe              Upload + queue audio
  GET    /api/v1/transcribe/:jobId       Poll status / get result
  GET    /api/v1/transcribe              List user's jobs
  DELETE /api/v1/transcribe/:jobId       Cancel / delete job
  POST   /api/v1/transcribe/:jobId/retry Re-queue failed job
  GET    /api/v1/health                  Queue health metrics

Run the worker separately: npm run worker
    `);
  });

  // Graceful shutdown — finish in-flight HTTP requests before closing
  const shutdown = async (signal) => {
    console.log(`\n${signal} received. Shutting down gracefully...`);
    server.close(async () => {
      await mongoose.disconnect();
      console.log('Server closed.');
      process.exit(0);
    });

    // Force exit if graceful shutdown stalls
    setTimeout(() => process.exit(1), 10000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
