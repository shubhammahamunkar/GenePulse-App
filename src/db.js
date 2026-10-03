'use strict';
const { Pool, types } = require('pg');

// Keep Postgres DATE as a plain 'YYYY-MM-DD' string (no timezone shifting).
types.setTypeParser(1082, (v) => v);
const bcrypt = require('bcryptjs');
const config = require('./config');

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// A dropped idle connection must never crash the process.
pool.on('error', (err) => console.error('[db] idle client error:', err.message));

// Idempotent. Safe to run on every start and on top of the v1 "patients" table.
const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS patients (
     id VARCHAR(50) PRIMARY KEY,
     name TEXT NOT NULL,
     age INTEGER,
     sex VARCHAR(20),
     blood_group VARCHAR(10),
     hb NUMERIC(4,1),
     wbc INTEGER,
     glucose INTEGER,
     codis JSONB,
     flags JSONB,
     created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
   )`,
  `ALTER TABLE patients ADD COLUMN IF NOT EXISTS needs_blood BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE patients ADD COLUMN IF NOT EXISTS needs_organ VARCHAR(30) NOT NULL DEFAULT 'None'`,
  `ALTER TABLE patients ADD COLUMN IF NOT EXISTS phone VARCHAR(24)`,
  `ALTER TABLE patients ADD COLUMN IF NOT EXISTS last_donated DATE`,
  `ALTER TABLE patients ADD COLUMN IF NOT EXISTS consent BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE patients ADD COLUMN IF NOT EXISTS data_source VARCHAR(12) NOT NULL DEFAULT 'simulated'`,
  `ALTER TABLE patients ADD COLUMN IF NOT EXISTS created_by INTEGER`,
  `ALTER TABLE patients ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP`,
  `ALTER TABLE patients ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP`,
  `CREATE INDEX IF NOT EXISTS idx_patients_deleted ON patients (deleted_at)`,
  `CREATE INDEX IF NOT EXISTS idx_patients_bg ON patients (blood_group)`,
  `CREATE TABLE IF NOT EXISTS users (
     id SERIAL PRIMARY KEY,
     username VARCHAR(32) NOT NULL UNIQUE,
     password_hash TEXT NOT NULL,
     role VARCHAR(10) NOT NULL CHECK (role IN ('admin','staff','viewer')),
     active BOOLEAN NOT NULL DEFAULT TRUE,
     token_version INTEGER NOT NULL DEFAULT 0,
     failed_attempts INTEGER NOT NULL DEFAULT 0,
     locked_until TIMESTAMPTZ,
     must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     last_login TIMESTAMPTZ
   )`,
  `CREATE TABLE IF NOT EXISTS audit_log (
     id BIGSERIAL PRIMARY KEY,
     ts TIMESTAMPTZ NOT NULL DEFAULT now(),
     user_id INTEGER,
     username TEXT,
     action VARCHAR(40) NOT NULL,
     entity VARCHAR(20),
     entity_id TEXT,
     ip TEXT,
     meta JSONB
   )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log (ts DESC)`,
];

async function migrate() {
  for (const sql of MIGRATIONS) await pool.query(sql);
}

// First run only: create the initial admin from env. Forced to change password on first login.
async function bootstrapAdmin() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM users');
  if (rows[0].n > 0) return;
  if (!config.adminUsername || !config.adminPassword) {
    console.warn('[auth] No users exist. Set ADMIN_USERNAME and ADMIN_PASSWORD (12+ chars) and restart to create the first admin.');
    return;
  }
  const hash = await bcrypt.hash(config.adminPassword, 12);
  await pool.query(
    `INSERT INTO users (username, password_hash, role, must_change_password) VALUES ($1,$2,'admin',TRUE)`,
    [config.adminUsername, hash]
  );
  console.log(`[auth] Created initial admin "${config.adminUsername}" (must change password at first login).`);
}

// Runs fn(client) inside a transaction. A failed ROLLBACK (e.g. the connection died) must never
// throw out of here unhandled, and a broken client is destroyed instead of returned to the pool.
async function withTransaction(fn) {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { broken = true; }
    throw e;
  } finally {
    client.release(broken ? true : undefined);
  }
}

module.exports = { pool, migrate, bootstrapAdmin, withTransaction };
