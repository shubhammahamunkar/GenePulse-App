'use strict';
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const config = require('./config');
const { pool } = require('./db');

const COOKIE = 'gp_session';
const COOKIE_OPTS = { httpOnly: true, sameSite: 'strict', secure: config.isProd, path: '/' };

// Compared against when the username does not exist, so response time doesn't reveal which usernames are real.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function issueSession(res, user) {
  const token = jwt.sign({ sub: user.id, tv: user.token_version }, config.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: `${config.sessionHours}h`,
  });
  res.cookie(COOKIE, token, { ...COOKIE_OPTS, maxAge: config.sessionHours * 3600 * 1000 });
}

function clearSession(res) {
  res.clearCookie(COOKIE, COOKIE_OPTS);
}

const deny = (res, status, code, error) => res.status(status).json({ error, code });

// Verifies the session cookie, loads the user fresh from the DB (so disabling a user or
// changing a password takes effect immediately) and enforces the CSRF header on writes.
async function authenticate(req, res, next) {
  try {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return deny(res, 401, 'UNAUTHENTICATED', 'Please sign in.');
    let payload;
    try {
      payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    } catch {
      return deny(res, 401, 'UNAUTHENTICATED', 'Your session has expired. Please sign in again.');
    }
    const { rows } = await pool.query(
      'SELECT id, username, role, active, token_version, must_change_password FROM users WHERE id = $1',
      [payload.sub]
    );
    const u = rows[0];
    if (!u || !u.active || u.token_version !== payload.tv) {
      return deny(res, 401, 'UNAUTHENTICATED', 'Your session is no longer valid. Please sign in again.');
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('X-Requested-With') !== 'genepulse') {
      return deny(res, 403, 'CSRF', 'Missing required request header.');
    }
    req.user = { id: u.id, username: u.username, role: u.role, mustChange: u.must_change_password };
    next();
  } catch (e) {
    next(e);
  }
}

// Blocks everything except changing the password while a temporary password is in use.
function requireReady(req, res, next) {
  if (req.user.mustChange) return deny(res, 403, 'PASSWORD_CHANGE_REQUIRED', 'You must change your password before continuing.');
  next();
}

const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : deny(res, 403, 'FORBIDDEN', 'You do not have permission to do that.');

const hashPassword = (pw) => bcrypt.hash(pw, 12);

module.exports = { COOKIE, DUMMY_HASH, issueSession, clearSession, authenticate, requireReady, requireRole, hashPassword };
