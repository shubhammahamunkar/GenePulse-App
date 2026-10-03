'use strict';
require('dotenv').config();
const crypto = require('crypto');

const env = process.env;
const isProd = env.NODE_ENV === 'production';
const problems = [];

function isLocalHost(url) {
  try { return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url).hostname); } catch { return false; }
}
const int = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : d);

if (!env.DATABASE_URL) problems.push('DATABASE_URL is required.');

let jwtSecret = env.JWT_SECRET || '';
if (!jwtSecret) {
  if (isProd) problems.push('JWT_SECRET is required in production (32+ random characters).');
  else { jwtSecret = crypto.randomBytes(32).toString('hex'); console.warn('[config] JWT_SECRET not set - using a random one (sessions reset on restart).'); }
} else if (jwtSecret.length < 32) {
  problems.push('JWT_SECRET must be at least 32 characters.');
}

const adminUsername = (env.ADMIN_USERNAME || '').trim().toLowerCase();
const adminPassword = env.ADMIN_PASSWORD || '';
if (adminPassword && adminPassword.length < 12) problems.push('ADMIN_PASSWORD must be at least 12 characters.');
if (adminUsername && !/^[a-z0-9._-]{3,32}$/.test(adminUsername)) problems.push('ADMIN_USERNAME must be 3-32 characters (a-z, 0-9, . _ -).');

if (problems.length) {
  const e = new Error('Invalid configuration:\n - ' + problems.join('\n - '));
  e.code = 'BAD_CONFIG';
  throw e;
}

module.exports = {
  isProd,
  port: int(env.PORT, 3000),
  databaseUrl: env.DATABASE_URL,
  // TLS to Postgres: on by default for anything that is not localhost. DATABASE_SSL=false to override.
  databaseSsl: env.DATABASE_SSL === 'false' ? false : env.DATABASE_SSL === 'true' ? true : !isLocalHost(env.DATABASE_URL),
  jwtSecret,
  sessionHours: int(env.SESSION_HOURS, 8),
  adminUsername,
  adminPassword,
  maxLoginFailures: int(env.MAX_LOGIN_FAILURES, 5),
  lockMinutes: int(env.LOCK_MINUTES, 15),
  trustProxy: env.TRUST_PROXY === undefined ? 1 : Number(env.TRUST_PROXY),
  apiRateMax: int(env.API_RATE_MAX, 600),
  // Only set when the frontend is hosted on a different origin than this server.
  corsOrigin: (env.FRONTEND_URL || '').replace(/\/+$/, ''),
  bulkMaxRows: 1000,
  timezone: env.APP_TIMEZONE || 'Asia/Kolkata',
};
