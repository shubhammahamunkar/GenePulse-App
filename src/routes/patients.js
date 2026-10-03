'use strict';
const express = require('express');
const config = require('../config');
const { pool, withTransaction } = require('../db');
const { wrap } = require('../http');
const { audit } = require('../audit');
const { authenticate, requireReady, requireRole } = require('../auth');
const { COLS, mapRow, insertPatient } = require('../model');
const { validatePatient, isValidISODate } = require('../validate');
const { donorEligibility } = require('../matching');

const router = express.Router();
router.use(authenticate, requireReady);

const canWrite = requireRole('admin', 'staff');
const adminOnly = requireRole('admin');

const ID_RE = /^[A-Za-z0-9-]{1,50}$/;
const EDITABLE = ['name', 'age', 'sex', 'bloodGroup', 'hb', 'wbc', 'glucose', 'needsBlood', 'needsOrgan',
  'phone', 'lastDonated', 'consent', 'dataSource', 'codis'];

const todayLocal = () => new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => Object.prototype.hasOwnProperty.call(o, k)).map((k) => [k, o[k]]));
const notFound = (res) => res.status(404).json({ error: 'Patient not found.', code: 'NOT_FOUND' });
const invalid = (res, errors) => res.status(400).json({ error: errors[0].message, code: 'VALIDATION', errors });

function present(row, role) {
  const p = mapRow(row, role);
  p.eligibility = donorEligibility(p);
  return p;
}

function idParam(req, res, next) {
  return ID_RE.test(req.params.id) ? next() : notFound(res);
}

// A "possible duplicate" = same phone, or same name + age + blood group, among active records.
async function findDuplicate(db, v) {
  const params = [v.name.toLowerCase(), v.age, v.bloodGroup];
  let sql = 'SELECT id, name FROM patients WHERE deleted_at IS NULL AND ((lower(name) = $1 AND age = $2 AND blood_group = $3)';
  if (v.phone) { params.push(v.phone); sql += ' OR phone = $4'; }
  const { rows } = await db.query(sql + ') LIMIT 1', params);
  return rows[0] || null;
}

// ---- list / read -----------------------------------------------------------
router.get('/', wrap(async (req, res) => {
  const archived = req.query.archived === '1' && req.user.role === 'admin';
  const { rows } = await pool.query(
    `SELECT ${COLS} FROM patients WHERE deleted_at IS ${archived ? 'NOT NULL' : 'NULL'}
     ORDER BY created_at DESC NULLS LAST LIMIT 5000`
  );
  res.json({ patients: rows.map((r) => present(r, req.user.role)), total: rows.length });
}));

router.get('/:id', idParam, wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT ${COLS} FROM patients WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
  if (!rows[0]) return notFound(res);
  res.json({ patient: present(rows[0], req.user.role) });
}));

// ---- create ----------------------------------------------------------------
router.post('/', canWrite, wrap(async (req, res) => {
  const r = validatePatient(req.body, 'create', new Date());
  if (!r.ok) return invalid(res, r.errors);

  if (req.query.force !== '1') {
    const dup = await findDuplicate(pool, r.value);
    if (dup) {
      return res.status(409).json({
        error: `A similar record already exists (${dup.id}).`, code: 'DUPLICATE', existing: { id: dup.id, name: dup.name },
      });
    }
  }
  const row = await insertPatient(pool, r.value, req.user.id);
  await audit(req, 'patient_created', 'patient', row.id, { source: r.value.dataSource });
  res.status(201).json({ patient: present(row, req.user.role) });
}));

// ---- bulk import (must be declared before any '/:id' POST) -------------------
router.post('/bulk', canWrite, wrap(async (req, res) => {
  const records = req.body && req.body.records;
  if (!Array.isArray(records) || records.length === 0) {
    return res.status(400).json({ error: 'Expected { "records": [ ... ] } with at least one row.', code: 'BAD_BODY' });
  }
  if (records.length > config.bulkMaxRows) {
    return res.status(413).json({ error: `Import is limited to ${config.bulkMaxRows} rows at a time.`, code: 'TOO_MANY' });
  }
  const consentConfirmed = req.body.consentConfirmed === true;

  const out = await withTransaction(async (client) => {
    const ex = await client.query('SELECT lower(name) AS n, age, blood_group AS bg, phone FROM patients WHERE deleted_at IS NULL');
    const phones = new Set(ex.rows.map((r) => r.phone).filter(Boolean));
    const keys = new Set(ex.rows.map((r) => `${r.n}|${r.age}|${r.bg}`));
    let inserted = 0; let duplicates = 0; let invalidCount = 0;
    const errors = [];

    for (let i = 0; i < records.length; i++) {
      const raw = records[i] && typeof records[i] === 'object' && !Array.isArray(records[i]) ? records[i] : {};
      // Consent is a property of the whole batch (confirmed by the importer); imported rows never carry STR data.
      const r = validatePatient({ ...raw, consent: consentConfirmed, dataSource: 'imported', codis: undefined }, 'import', new Date());
      if (!r.ok) { invalidCount++; if (errors.length < 50) errors.push({ row: i + 1, errors: r.errors }); continue; }
      const v = r.value;
      const key = `${v.name.toLowerCase()}|${v.age}|${v.bloodGroup}`;
      if ((v.phone && phones.has(v.phone)) || keys.has(key)) { duplicates++; continue; }
      await insertPatient(client, v, req.user.id);
      if (v.phone) phones.add(v.phone);
      keys.add(key);
      inserted++;
    }
    return { inserted, skippedDuplicates: duplicates, invalid: invalidCount, errors };
  });

  await audit(req, 'patients_imported', 'patient', null,
    { inserted: out.inserted, duplicates: out.skippedDuplicates, invalid: out.invalid, consentConfirmed });
  res.status(201).json(out);
}));

// ---- partial update ----------------------------------------------------------
router.patch('/:id', canWrite, idParam, wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT ${COLS} FROM patients WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
  if (!rows[0]) return notFound(res);

  // Merge onto the stored record so omitted fields (e.g. the STR profile) are kept, never wiped.
  const base = pick(mapRow(rows[0], 'admin'), EDITABLE);
  const merged = { ...base, ...pick(req.body || {}, EDITABLE) };
  const r = validatePatient(merged, 'update', new Date());
  if (!r.ok) return invalid(res, r.errors);
  const v = r.value;

  const changed = EDITABLE.filter((k) => JSON.stringify(base[k] ?? null) !== JSON.stringify(v[k] ?? null));
  const upd = await pool.query(
    `UPDATE patients SET name=$2, age=$3, sex=$4, blood_group=$5, hb=$6, wbc=$7, glucose=$8, codis=$9, flags=$10,
       needs_blood=$11, needs_organ=$12, phone=$13, last_donated=$14, consent=$15, data_source=$16, updated_at=now()
     WHERE id=$1 AND deleted_at IS NULL RETURNING ${COLS}`,
    [req.params.id, v.name, v.age, v.sex, v.bloodGroup, v.hb, v.wbc, v.glucose,
      v.codis ? JSON.stringify(v.codis) : null, JSON.stringify(v.flags), v.needsBlood, v.needsOrgan,
      v.phone, v.lastDonated, v.consent, v.dataSource]
  );
  if (!upd.rows[0]) return notFound(res);
  if (changed.length) await audit(req, 'patient_updated', 'patient', req.params.id, { fields: changed }); // names only, never values; no-op edits are not logged
  res.json({ patient: present(upd.rows[0], req.user.role) });
}));

// ---- record a donation -------------------------------------------------------
router.post('/:id/donations', canWrite, idParam, wrap(async (req, res) => {
  const date = req.body && req.body.date !== undefined ? req.body.date : todayLocal();
  if (!isValidISODate(date) || date < '1990-01-01') {
    return invalid(res, [{ field: 'date', message: 'Donation date must be a valid date (YYYY-MM-DD).' }]);
  }
  if (date > todayLocal()) return invalid(res, [{ field: 'date', message: 'Donation date cannot be in the future.' }]);

  const cur = await pool.query('SELECT last_donated FROM patients WHERE id = $1 AND deleted_at IS NULL', [req.params.id]);
  if (!cur.rows[0]) return notFound(res);
  if (cur.rows[0].last_donated && date < cur.rows[0].last_donated) {
    return invalid(res, [{ field: 'date', message: `Date is earlier than the last recorded donation (${cur.rows[0].last_donated}).` }]);
  }
  const { rows } = await pool.query(
    `UPDATE patients SET last_donated = $2, updated_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING ${COLS}`,
    [req.params.id, date]
  );
  await audit(req, 'donation_recorded', 'patient', req.params.id, { date });
  res.json({ patient: present(rows[0], req.user.role) });
}));

// ---- archive (soft delete) / restore / permanent delete ------------------------
router.delete('/:id', adminOnly, idParam, wrap(async (req, res) => {
  const cur = await pool.query('SELECT id, deleted_at FROM patients WHERE id = $1', [req.params.id]);
  if (!cur.rows[0]) return notFound(res);

  if (req.query.permanent === '1') {
    if (!cur.rows[0].deleted_at) {
      return res.status(409).json({ error: 'Archive the record first; only archived records can be permanently deleted.', code: 'NOT_ARCHIVED' });
    }
    await pool.query('DELETE FROM patients WHERE id = $1 AND deleted_at IS NOT NULL', [req.params.id]);
    await audit(req, 'patient_deleted_permanently', 'patient', req.params.id);
    return res.json({ ok: true, permanent: true });
  }
  if (cur.rows[0].deleted_at) return res.json({ ok: true, alreadyArchived: true });
  await pool.query('UPDATE patients SET deleted_at = now() WHERE id = $1', [req.params.id]);
  await audit(req, 'patient_archived', 'patient', req.params.id);
  res.json({ ok: true });
}));

router.post('/:id/restore', adminOnly, idParam, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE patients SET deleted_at = NULL, updated_at = now() WHERE id = $1 AND deleted_at IS NOT NULL RETURNING ${COLS}`,
    [req.params.id]
  );
  if (!rows[0]) return notFound(res);
  await audit(req, 'patient_restored', 'patient', req.params.id);
  res.json({ patient: present(rows[0], req.user.role) });
}));

module.exports = router;
