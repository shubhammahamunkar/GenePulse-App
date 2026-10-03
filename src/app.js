'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const { pool } = require('./db');
const { wrap, errorHandler } = require('./http');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use((req, res, next) => {
    req.id = crypto.randomBytes(4).toString('hex');
    res.set('X-Request-Id', req.id);
    next();
  });

  // Strict CSP: nothing inline, nothing from other origins. (The frontend is written to comply.)
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        ...(config.isProd ? { upgradeInsecureRequests: [] } : {}),
      },
    },
  }));
  app.use((req, res, next) => {
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    next();
  });

  if (config.corsOrigin) {
    app.use('/api', cors({
      origin: config.corsOrigin,
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', 'X-Requested-With'],
    }));
  }

  // Health check: before the rate limiter, no auth, no data.
  app.get('/api/health', wrap(async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.set('Cache-Control', 'no-store').json({ status: 'ok' });
    } catch {
      res.status(503).set('Cache-Control', 'no-store').json({ status: 'degraded' });
    }
  }));

  app.use('/api', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: config.apiRateMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please slow down and try again shortly.', code: 'RATE_LIMITED' },
  }));
  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); }); // never cache patient data
  app.use('/api', express.json({ limit: '1mb' }));

  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/patients', require('./routes/patients'));
  app.use('/api/admin', require('./routes/admin'));
  app.use('/api', require('./routes/insights'));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.', code: 'NOT_FOUND' }));

  app.use(express.static(PUBLIC_DIR, {
    index: 'index.html',
    setHeaders(res, file) {
      if (/\.(woff2|svg)$/.test(file) || file.includes(`${path.sep}vendor${path.sep}`)) {
        res.set('Cache-Control', 'public, max-age=2592000, immutable');
      } else {
        res.set('Cache-Control', 'no-cache'); // always revalidate html/css/js so updates show up
      }
    },
  }));
  app.use((req, res) => res.status(404).type('text/plain').send('Not found'));

  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
