# Transcription Pipeline

End-to-end audio transcription service built with Node.js, OpenAI Whisper, FFmpeg, Bull (Redis), MongoDB, and S3.

## Architecture

```
Client
  │
  ▼
Express API  (src/server.js + src/app.js)
  │  POST /api/v1/transcribe  →  upload file → S3, enqueue Bull job, return jobId
  │  GET  /api/v1/transcribe/:jobId  →  poll status/result from MongoDB
  │
  ▼
Redis (Bull Queue)
  │
  ▼
Worker Process  (src/queue/worker.js)
  │  1. Download audio from S3
  │  2. FFmpeg: normalize to 16kHz mono WAV  (src/audioProcessor.js)
  │  3. Split into 10-min chunks if needed
  │  4. OpenAI Whisper API per chunk         (src/transcriptionService.js)
  │  5. Merge + deduplicate segments
  │  6. Save result to MongoDB
  │
  ▼
MongoDB  (Transcript documents)
```

## Quick Start

### Prerequisites
- Node.js 18+
- Docker & Docker Compose (for MongoDB, Redis, MinIO)
- OpenAI API key

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env — set OPENAI_API_KEY at minimum
```

### 3. Start infrastructure (MongoDB + Redis + MinIO)
```bash
docker-compose up mongo redis minio minio-init -d
```

### 4. Start the API server
```bash
npm start
# or for development with auto-reload:
npm run dev
```

### 5. Start the worker
```bash
npm run worker
# or for development:
npm run dev:worker
```

## API Reference

### Upload audio for transcription
```http
POST /api/v1/transcribe
Content-Type: multipart/form-data

audio: <file>  (MP3, WAV, M4A, OGG, FLAC, WEBM, AAC, MP4)
```

**Response (202 Accepted):**
```json
{
  "success": true,
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "pending",
  "links": {
    "status": "/api/v1/transcribe/550e8400-e29b-41d4-a716-446655440000"
  }
}
```

### Poll job status
```http
GET /api/v1/transcribe/:jobId
```

**Response when completed:**
```json
{
  "success": true,
  "jobId": "550e8400-...",
  "status": "completed",
  "progress": { "stage": "done", "percent": 100 },
  "metadata": {
    "originalFilename": "interview.mp3",
    "duration": 3742.5,
    "language": "en",
    "fileSize": 45234123
  },
  "transcription": {
    "fullText": "Welcome to today's podcast...",
    "wordCount": 6821,
    "segments": [
      { "start": 0.0, "end": 4.2, "text": "Welcome to today's podcast.", "confidence": 0.98 },
      { "start": 4.2, "end": 9.1, "text": "Today we're talking about...", "confidence": 0.95 }
    ]
  }
}
```

### List your jobs
```http
GET /api/v1/transcribe?page=1&limit=20&status=completed
X-User-Id: your-user-id
```

### Cancel / delete a job
```http
DELETE /api/v1/transcribe/:jobId
```

### Retry a failed job
```http
POST /api/v1/transcribe/:jobId/retry
```

### Health check
```http
GET /api/v1/health
```
```json
{
  "status": "ok",
  "queue": { "waiting": 2, "active": 3, "completed": 841, "failed": 2, "delayed": 0 }
}
```

## Design Decisions

### Audio Handling (FFmpeg)
Every input format is normalized to 16kHz mono WAV before transcription. This means:
- The transcription layer never cares what format came in
- Whisper gets its optimal input format every time
- Swapping STT engines requires zero changes to audio handling

### Long Audio (chunking)
Files over 10 minutes are split with 10-second overlap at chunk boundaries. Timestamps are offset per chunk so the final output has correct absolute timing. A deduplication pass removes repeated segments caused by the overlap.

### Concurrency (Bull queue)
Workers process 3 jobs simultaneously — matching typical Whisper API rate limits. The API immediately returns 202 with a jobId; clients poll for results. Queue depth is capped at 100; requests beyond that receive 503 with a `Retry-After` hint.

### Storage
- **Raw uploads → S3** — app servers stay stateless and horizontally scalable
- **Local disk** — only used as a transient buffer during upload and processing; cleaned up after each job
- **MongoDB** — structured job records with a 30-day TTL for completed/failed jobs

### Retry Logic
Bull retries failed jobs up to 3 times with exponential backoff (2s → 4s → 8s). After all retries are exhausted, the job is marked `failed` in MongoDB and available for manual retry via the API.

## Full Docker Deployment

```bash
cp .env.example .env
# Edit .env with your OPENAI_API_KEY and AWS credentials (or leave S3 blank for MinIO)

docker-compose up --build
```

This starts: API server, 2 worker replicas, MongoDB, Redis, MinIO.
