import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import transcriptionRoutes from './routes/transcription.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { getQueueMetrics } from './queue/transcriptionQueue.js';
import config from './config/index.js';

const app = express();

// ---------------------------------------------------------------------------
// Core middleware
// ---------------------------------------------------------------------------
app.use(cors());
app.use(morgan(config.nodeEnv === 'production' ? 'combined' : 'dev'));
app.use(express.json());

// ---------------------------------------------------------------------------
// Rate limiting
// Separate limits for upload (expensive) vs. polling (cheap)
// ---------------------------------------------------------------------------
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,                   // 20 uploads per 15 min per IP
  message: { success: false, error: 'Too many upload requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const pollLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 120,             // 120 polls per minute (~2/second) — generous for polling UIs
  message: { success: false, error: 'Too many requests.' },
});

// Apply upload limiter only to the POST route
app.use('/api/v1/transcribe', (req, res, next) => {
  if (req.method === 'POST' && req.path === '/') return uploadLimiter(req, res, next);
  return pollLimiter(req, res, next);
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.use('/api/v1/transcribe', transcriptionRoutes);

// ---------------------------------------------------------------------------
// Health check
// Returns 200 if the service is up, includes queue depth for monitoring
// ---------------------------------------------------------------------------
app.get('/api/v1/health', async (_req, res) => {
  try {
    const queue = await getQueueMetrics();
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      queue,
      uptime: process.uptime(),
    });
  } catch {
    res.status(503).json({ status: 'degraded', error: 'Queue unavailable' });
  }
});

// Root ping — useful for load-balancer health checks
app.get('/', (_req, res) => res.json({ service: 'transcription-pipeline', version: '1.0.0' }));

// ---------------------------------------------------------------------------
// Error handling (must be last)
// ---------------------------------------------------------------------------
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
