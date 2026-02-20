/**
 * Global error handling middleware.
 * Express calls this when next(err) is invoked from any route.
 *
 * Keeps error formatting consistent across the API — clients always
 * get { success: false, error: string, details?: any }
 */
export function errorHandler(err, req, res, _next) {
  // Log the full error server-side for debugging
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.path}`, err);

  // Multer errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      success: false,
      error: `File too large. Maximum allowed size is ${err.field} MB.`,
    });
  }

  // Explicit HTTP status attached to the error
  const status = err.status || err.statusCode || 500;

  // Don't leak internal stack traces to clients in production
  const message =
    process.env.NODE_ENV === 'production' && status === 500
      ? 'Internal server error'
      : err.message || 'Something went wrong';

  res.status(status).json({
    success: false,
    error: message,
    ...(process.env.NODE_ENV !== 'production' && err.stack
      ? { stack: err.stack.split('\n').slice(0, 5) }
      : {}),
  });
}

/**
 * 404 handler — catches requests that fall through all routes.
 */
export function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    error: `Route not found: ${req.method} ${req.path}`,
  });
}
