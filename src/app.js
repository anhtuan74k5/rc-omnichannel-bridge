/**
 * Express app: body parsers, routes and the error handler.
 */

const express = require('express');
const { ENV } = require('./constants/config');

const app = express();
// Keep the raw bytes: Facebook's X-Hub-Signature-256 is computed over them.
const keepRawBody = (req, res, buf) => { req.rawBody = buf; };
// Only the admin upload may be large; the first parser to run wins.
app.use('/documents/upload', express.json({ limit: ENV.requestBodyLimit, verify: keepRawBody }));
app.use(express.json({ limit: ENV.webhookBodyLimit, verify: keepRawBody }));

app.use(require('./routes/facebook'));
app.use(require('./routes/telegram'));
app.use(require('./routes/zalo'));
app.use(require('./routes/rocketchat'));
app.use(require('./routes/health'));
app.use(require('./routes/documents'));

// Malformed or oversized request bodies: a short JSON answer, never a stack trace.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = Number(err && err.status) >= 400 && Number(err.status) < 500 ? Number(err.status) : 500;
  console.warn(`[http] Rejected request with status ${status} (${(err && err.type) || 'error'}).`);
  return res.status(status).json({ success: false, error: status === 413 ? 'Payload too large' : 'Bad request' });
});

module.exports = { app };
