'use strict';

// Forward async errors to the central error handler (Express 4 does not do this by itself).
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  if (res.headersSent) return next(err);
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON in request body.', code: 'BAD_JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large.', code: 'TOO_LARGE' });
  const status = err.status || err.statusCode;
  if (status >= 400 && status < 500) return res.status(status).json({ error: 'Bad request.', code: 'BAD_REQUEST' });
  // Real server fault: full detail goes to the server log only, never to the client.
  console.error(`[${req.id}] ${req.method} ${req.path} ->`, err);
  res.status(500).json({ error: 'Something went wrong on the server.', code: 'SERVER_ERROR', requestId: req.id });
}

module.exports = { wrap, errorHandler };
