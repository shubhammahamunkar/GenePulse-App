'use strict';
const { pool } = require('./db');

// Best-effort audit trail. Never put names/phone numbers in meta - IDs and field names only.
async function audit(req, action, entity = null, entityId = null, meta = null, userOverride = null) {
  const u = userOverride || req.user || {};
  try {
    await pool.query(
      `INSERT INTO audit_log (user_id, username, action, entity, entity_id, ip, meta) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [u.id ?? null, u.username ?? null, action, entity, entityId, req.ip, meta ? JSON.stringify(meta) : null]
    );
  } catch (e) {
    console.error('[audit] failed to write:', e.message);
  }
}

module.exports = { audit };
