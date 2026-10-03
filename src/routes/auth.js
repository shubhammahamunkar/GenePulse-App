'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { pool } = require('../db');
const { wrap } = require('../http');
const { audit } = require('../audit');
const { DUMMY_HASH, issueSession, clearSession, authenticate, hashPassword } = require('../auth');

const router = express.Router();

// Only failed attempts count toward this limit.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.', code: 'RATE_LIMITED' },
});

const publicUser = (u) => ({ username: u.username, role: u.role, mustChangePassword: !!(u.must_change_password ?? u.mustChange) });

router.post('/login', loginLimiter, wrap(async (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const generic = { error: 'Incorrect username or password, or the account is temporarily locked.', code: 'LOGIN_FAILED' };

  if (!username || !password || password.length > 128) return res.status(401).json(generic);

  const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  const u = rows[0];
  const locked = u && u.locked_until && new Date(u.locked_until) > new Date();

  // Always run one bcrypt comparison so timing doesn't reveal whether the user exists.
  const passwordOk = await bcrypt.compare(password, u ? u.password_hash : DUMMY_HASH);

  if (!u || !u.active || locked || !passwordOk) {
    if (u && !locked) {
      const failures = u.failed_attempts + 1;
      if (failures >= config.maxLoginFailures) {
        await pool.query(
          `UPDATE users SET failed_attempts = 0, locked_until = now() + ($2 || ' minutes')::interval WHERE id = $1`,
          [u.id, String(config.lockMinutes)]
        );
        await audit(req, 'account_locked', 'user', String(u.id), null, { id: u.id, username: u.username });
      } else {
        await pool.query('UPDATE users SET failed_attempts = $2 WHERE id = $1', [u.id, failures]);
      }
    }
    await audit(req, 'login_failed', 'user', u ? String(u.id) : null, { attemptedUsername: username.slice(0, 32) });
    return res.status(401).json(generic);
  }

  await pool.query('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login = now() WHERE id = $1', [u.id]);
  issueSession(res, u);
  await audit(req, 'login', 'user', String(u.id), null, { id: u.id, username: u.username });
  res.json({ user: publicUser(u) });
}));

router.post('/logout', wrap(async (req, res) => {
  clearSession(res);
  res.json({ ok: true });
}));

router.get('/me', authenticate, (req, res) => res.json({ user: publicUser(req.user) }));

router.post('/change-password', loginLimiter, authenticate, wrap(async (req, res) => {
  const current = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
  const next = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  const u = rows[0];

  if (!(await bcrypt.compare(current, u.password_hash))) {
    return res.status(400).json({ error: 'Current password is incorrect.', code: 'BAD_CURRENT', errors: [{ field: 'currentPassword', message: 'Current password is incorrect.' }] });
  }
  const problems = [];
  if (next.length < 12) problems.push('New password must be at least 12 characters.');
  if (next.length > 128) problems.push('New password is too long.');
  if (next.toLowerCase().includes(u.username)) problems.push('New password must not contain your username.');
  if (next === current) problems.push('New password must be different from the current one.');
  if (problems.length) {
    return res.status(400).json({ error: problems[0], code: 'WEAK_PASSWORD', errors: problems.map((message) => ({ field: 'newPassword', message })) });
  }

  const hash = await hashPassword(next);
  // token_version bump signs out every other session using the old password.
  const upd = await pool.query(
    `UPDATE users SET password_hash = $2, must_change_password = FALSE, token_version = token_version + 1 WHERE id = $1 RETURNING id, token_version`,
    [u.id, hash]
  );
  issueSession(res, { id: u.id, token_version: upd.rows[0].token_version });
  await audit(req, 'password_changed', 'user', String(u.id));
  res.json({ ok: true });
}));

module.exports = router;
