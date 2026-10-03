'use strict';
const crypto = require('crypto');
const { maskPhone } = require('./matching');

const COLS = `id, name, age, sex, blood_group, hb, wbc, glucose, codis, flags, needs_blood, needs_organ,
  phone, last_donated, consent, data_source, created_by, created_at, updated_at, deleted_at`;

// Tolerant of legacy v1 rows (nulls, odd flag values) so one old record can never break the app.
function mapRow(r, role = 'admin') {
  const flags = Array.isArray(r.flags) ? r.flags.filter((f) => typeof f === 'string').slice(0, 10) : [];
  return {
    id: r.id,
    name: r.name,
    age: r.age === null ? null : Number(r.age),
    sex: r.sex || 'Unknown',
    bloodGroup: r.blood_group || 'Unknown',
    hb: r.hb === null ? null : Number(r.hb),
    wbc: r.wbc === null ? null : Number(r.wbc),
    glucose: r.glucose === null ? null : Number(r.glucose),
    needsBlood: !!r.needs_blood,
    needsOrgan: r.needs_organ || 'None',
    phone: role === 'viewer' ? maskPhone(r.phone) : r.phone || null,
    lastDonated: r.last_donated || null,
    consent: !!r.consent,
    dataSource: r.data_source || 'simulated',
    flags,
    codis: Array.isArray(r.codis) ? r.codis : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    archived: !!r.deleted_at,
  };
}

const newId = () => `GP-${new Date().getFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

// ON CONFLICT DO NOTHING keeps this safe inside a transaction (a plain unique violation would abort it).
async function insertPatient(db, v, userId) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const { rows } = await db.query(
      `INSERT INTO patients (id, name, age, sex, blood_group, hb, wbc, glucose, codis, flags, needs_blood,
         needs_organ, phone, last_donated, consent, data_source, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (id) DO NOTHING RETURNING ${COLS}`,
      [newId(), v.name, v.age, v.sex, v.bloodGroup, v.hb, v.wbc, v.glucose,
        v.codis ? JSON.stringify(v.codis) : null, JSON.stringify(v.flags), v.needsBlood, v.needsOrgan,
        v.phone, v.lastDonated, v.consent, v.dataSource, userId]
    );
    if (rows[0]) return rows[0];
  }
  throw new Error('Could not allocate a unique patient id');
}

module.exports = { COLS, mapRow, insertPatient };
