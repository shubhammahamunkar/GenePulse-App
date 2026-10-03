'use strict';
const express = require('express');
const { pool } = require('../db');
const { wrap } = require('../http');
const { authenticate, requireReady } = require('../auth');
const { COLS, mapRow } = require('../model');
const { donorEligibility, matchBlood, organCandidates, kinshipGraph, canDonate } = require('../matching');

const router = express.Router();
const guard = [authenticate, requireReady];

const GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

// Phones are masked for the read-only "viewer" role by mapRow.
async function loadActive(role) {
  const { rows } = await pool.query(
    `SELECT ${COLS} FROM patients WHERE deleted_at IS NULL ORDER BY created_at DESC NULLS LAST LIMIT 5000`
  );
  return rows.map((r) => mapRow(r, role));
}

router.get('/match/blood', ...guard, wrap(async (req, res) => {
  const all = await loadActive(req.user.role);
  const phones = new Map(all.map((p) => [p.id, p.phone]));
  const recipients = all
    .filter((p) => p.needsBlood)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)); // waiting longest first

  res.json({
    recipients: recipients.map((r) => {
      const m = matchBlood(r, all);
      return {
        recipient: { id: r.id, name: r.name, bloodGroup: r.bloodGroup, age: r.age, sex: r.sex, createdAt: r.createdAt },
        eligibleCount: m.eligibleCount,
        compatibleCount: m.compatibleCount,
        donors: m.donors.slice(0, 50).map((d) => ({ ...d, phone: phones.get(d.id) || null })),
      };
    }),
  });
}));

router.get('/match/organ', ...guard, wrap(async (req, res) => {
  const all = await loadActive(req.user.role);
  res.json({
    recipients: all.filter((p) => p.needsOrgan !== 'None').map((p) => ({
      recipient: { id: p.id, name: p.name, bloodGroup: p.bloodGroup, age: p.age, needsOrgan: p.needsOrgan, hasStr: Array.isArray(p.codis) },
      candidates: organCandidates(p, all, 3),
    })),
  });
}));

router.get('/kinship', ...guard, wrap(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 60, 2), 400);
  res.json(kinshipGraph(await loadActive(req.user.role), limit));
}));

router.get('/stats', ...guard, wrap(async (req, res) => {
  const all = await loadActive(req.user.role);
  const eligible = all.filter((p) => donorEligibility(p).eligible);

  const bloodGroups = GROUPS.map((g) => {
    const requests = all.filter((p) => p.needsBlood && p.bloodGroup === g).length;
    const compatibleSupply = eligible.filter((d) => canDonate(d.bloodGroup, g)).length;
    return { group: g, donors: eligible.filter((d) => d.bloodGroup === g).length, requests, compatibleSupply, shortage: requests > compatibleSupply };
  });

  const count = (arr, keyFn) => arr.reduce((m, x) => { const k = keyFn(x); if (k != null) m[k] = (m[k] || 0) + 1; return m; }, {});
  const ageGroup = (a) => (a == null ? null : a < 18 ? '0-17' : a <= 30 ? '18-30' : a <= 45 ? '31-45' : a <= 65 ? '46-65' : '66+');
  const flagCounts = {};
  all.forEach((p) => p.flags.forEach((f) => { flagCounts[f] = (flagCounts[f] || 0) + 1; }));
  const ages = all.map((p) => p.age).filter((a) => a != null);

  res.json({
    total: all.length,
    eligibleDonors: eligible.length,
    needBlood: all.filter((p) => p.needsBlood).length,
    needOrgan: all.filter((p) => p.needsOrgan !== 'None').length,
    flagged: all.filter((p) => p.flags.length).length,
    noConsent: all.filter((p) => !p.consent).length,
    averageAge: ages.length ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length) : null,
    bloodGroups,
    shortages: bloodGroups.filter((b) => b.shortage).map((b) => b.group),
    flagCounts,
    ageGroups: count(all, (p) => ageGroup(p.age)),
    sexes: count(all, (p) => p.sex),
    organNeeds: count(all.filter((p) => p.needsOrgan !== 'None'), (p) => p.needsOrgan),
    sources: count(all, (p) => p.dataSource),
    recent: all.slice(0, 5).map((p) => ({ id: p.id, name: p.name, bloodGroup: p.bloodGroup, createdAt: p.createdAt })),
  });
}));

module.exports = router;
