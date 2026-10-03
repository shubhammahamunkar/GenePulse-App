'use strict';
const express = require('express');
const { pool } = require('../db');
const { wrap } = require('../http');
const { audit } = require('../audit');
const { authenticate, requireReady, requireRole, hashPassword } = require('../auth');
const { validateNewUser, ROLES } = require('../validate');

const router = express.Router();
router.use(authenticate, requireReady, requireRole('admin'));

const bad = (res, message, field, status = 400) =>
  res.status(status).json({ error: message, code: 'VALIDATION', errors: [{ field, message }] });

const publicRow = (u) => ({
  id: u.id,
  username: u.username,
  role: u.role,
  active: u.active,
  mustChangePassword: u.must_change_password,
  locked: !!(u.locked_until && new Date(u.locked_until) > new Date()),
  lastLogin: u.last_login,
  createdAt: u.created_at,
});

const USER_COLS = 'id, username, role, active, must_change_password, locked_until, last_login, created_at';

router.get('/users', wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT ${USER_COLS} FROM users ORDER BY id`);
  res.json({ users: rows.map(publicRow) });
}));

router.post('/users', wrap(async (req, res) => {
  const r = validateNewUser(req.body || {});
  if (!r.ok) return res.status(400).json({ error: r.errors[0].message, code: 'VALIDATION', errors: r.errors });
  const { username, password, role } = r.value;
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password_hash, role, must_change_password) VALUES ($1,$2,$3,TRUE) RETURNING ${USER_COLS}`,
      [username, await hashPassword(password), role]
    );
    await audit(req, 'user_created', 'user', String(rows[0].id), { role });
    res.status(201).json({ user: publicRow(rows[0]) });
  } catch (e) {
    if (e.code === '23505') return bad(res, 'That username is already taken.', 'username', 409);
    throw e;
  }
}));

router.patch('/users/:id', wrap(async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'User not found.', code: 'NOT_FOUND' });
  const cur = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  const u = cur.rows[0];
  if (!u) return res.status(404).json({ error: 'User not found.', code: 'NOT_FOUND' });

  const b = req.body || {};
  const self = id === req.user.id;
  const sets = [];
  const params = [id];
  const meta = {};

  if (b.role !== undefined) {
    if (!ROLES.includes(b.role)) return bad(res, 'Role must be admin, staff or viewer.', 'role');
    if (self && b.role !== u.role) return bad(res, 'You cannot change your own role.', 'role');
    sets.push(`role = $${params.push(b.role)}`);
    meta.role = b.role;
  }
  if (b.active !== undefined) {
    if (typeof b.active !== 'boolean') return bad(res, 'active must be true or false.', 'active');
    if (self && b.active === false) return bad(res, 'You cannot deactivate your own account.', 'active');
    sets.push(`active = $${params.push(b.active)}`);
    if (!b.active) sets.push('token_version = token_version + 1'); // kills their live sessions
    meta.active = b.active;
  }
  if (b.unlock === true) {
    sets.push('failed_attempts = 0', 'locked_until = NULL');
    meta.unlock = true;
  }
  if (b.newPassword !== undefined) {
    const pw = b.newPassword;
    if (typeof pw !== 'string' || pw.length < 12) return bad(res, 'Temporary password must be at least 12 characters.', 'newPassword');
    if (pw.length > 128) return bad(res, 'Password is too long.', 'newPassword');
    if (pw.toLowerCase().includes(u.username)) return bad(res, 'Password must not contain the username.', 'newPassword');
    sets.push(`password_hash = $${params.push(await hashPassword(pw))}`, 'must_change_password = TRUE',
      'token_version = token_version + 1', 'failed_attempts = 0', 'locked_until = NULL');
    meta.passwordReset = true;
  }
  if (!sets.length) return bad(res, 'Nothing to update.', '_');

  const { rows } = await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1 RETURNING ${USER_COLS}`, params);
  await audit(req, 'user_updated', 'user', String(id), meta);
  res.json({ user: publicRow(rows[0]) });
}));

router.get('/audit', wrap(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const action = typeof req.query.action === 'string' && /^[a-z_]{1,40}$/.test(req.query.action) ? req.query.action : null;
  const where = action ? 'WHERE action = $1' : '';
  const args = action ? [action] : [];
  const [list, total] = await Promise.all([
    pool.query(
      `SELECT id, ts, username, action, entity, entity_id, ip, meta FROM audit_log ${where}
       ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`, args),
    pool.query(`SELECT COUNT(*)::int AS n FROM audit_log ${where}`, args),
  ]);
  res.json({ entries: list.rows, total: total.rows[0].n });
}));

module.exports = router;
