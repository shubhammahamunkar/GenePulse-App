'use strict';

// Who each blood group can donate red cells to (standard ABO/Rh rules).
const DONATE_TO = {
  'O-': ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'],
  'O+': ['O+', 'A+', 'B+', 'AB+'],
  'A-': ['A-', 'A+', 'AB-', 'AB+'],
  'A+': ['A+', 'AB+'],
  'B-': ['B-', 'B+', 'AB-', 'AB+'],
  'B+': ['B+', 'AB+'],
  'AB-': ['AB-', 'AB+'],
  'AB+': ['AB+'],
};

const canDonate = (donorBg, recipientBg) => (DONATE_TO[donorBg] || []).includes(recipientBg);

// PROTOTYPE RULES - verify against current NBTC / hospital policy before any real use.
const RULES = { minAge: 18, maxAge: 65, minHb: 12.5, intervalDays: { Male: 90, Female: 120, default: 120 } };

function daysBetween(isoDate, now) {
  const then = new Date(isoDate + 'T00:00:00Z').getTime();
  return Math.floor((now.getTime() - then) / 86400000);
}

function donorEligibility(p, now = new Date()) {
  const reasons = [];
  if (!p.consent) reasons.push('No consent on record');
  if (p.needsBlood) reasons.push('Currently needs blood');
  if (p.bloodGroup === 'Unknown') reasons.push('Blood group not recorded');
  if (p.age == null || p.age < RULES.minAge || p.age > RULES.maxAge) reasons.push(`Age outside ${RULES.minAge}-${RULES.maxAge}`);
  if (p.hb == null) reasons.push('Hemoglobin not recorded - screen first');
  else if (p.hb < RULES.minHb) reasons.push(`Hemoglobin below ${RULES.minHb} g/dL`);
  if (p.lastDonated) {
    const need = RULES.intervalDays[p.sex] || RULES.intervalDays.default;
    const days = daysBetween(p.lastDonated, now);
    if (days < need) reasons.push(`Donated ${days} day(s) ago - wait ${need - days} more`);
  }
  return { eligible: reasons.length === 0, reasons };
}

function matchBlood(recipient, all, now = new Date()) {
  const donors = all
    .filter((d) => d.id !== recipient.id && canDonate(d.bloodGroup, recipient.bloodGroup))
    .map((d) => ({
      id: d.id, name: d.name, bloodGroup: d.bloodGroup, lastDonated: d.lastDonated,
      exact: d.bloodGroup === recipient.bloodGroup,
      ...donorEligibility(d, now),
    }))
    .sort((a, b) =>
      (b.eligible - a.eligible) ||
      (b.exact - a.exact) ||
      ((a.bloodGroup === 'O-') - (b.bloodGroup === 'O-')) || // keep universal donors in reserve
      a.name.localeCompare(b.name));
  return { eligibleCount: donors.filter((d) => d.eligible).length, compatibleCount: donors.length, donors };
}

const KIN_TOLERANCE = 1;
function sharedLoci(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return null;
  let n = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (Math.abs(a[i] - b[i]) <= KIN_TOLERANCE) n++;
  return n;
}

// HEURISTIC index only. Real organ allocation uses HLA typing and clinical criteria.
function organCandidates(patient, all, limit = 3) {
  return all
    .filter((d) => d.id !== patient.id && d.consent && !d.needsBlood && d.needsOrgan === 'None' &&
      d.age >= RULES.minAge && d.age <= RULES.maxAge && canDonate(d.bloodGroup, patient.bloodGroup))
    .map((d) => {
      const loci = sharedLoci(d.codis, patient.codis);
      const exact = d.bloodGroup === patient.bloodGroup;
      return { id: d.id, name: d.name, bloodGroup: d.bloodGroup, exactAbo: exact, strLoci: loci,
        index: 50 + (exact ? 15 : 0) + (loci === null ? 0 : loci * 2) };
    })
    .sort((a, b) => b.index - a.index || a.name.localeCompare(b.name))
    .slice(0, limit);
}

// Thresholds chosen so unrelated pairs rarely trip them (with +/-1 tolerance two strangers
// match ~14.5% of loci by chance, so >=3/13 would link ~29% of strangers; >=6/13 is <1%).
function estimateRelationship(a, b) {
  const shared = sharedLoci(a, b);
  if (shared === null) return { kind: null, shared: null };
  if (shared >= 10) return { kind: 'parent', label: 'Estimated parent-child', shared };
  if (shared >= 8) return { kind: 'sibling', label: 'Estimated sibling', shared };
  if (shared >= 6) return { kind: 'distant', label: 'Estimated distant relative', shared };
  return { kind: null, shared };
}

function kinshipGraph(list, cap = 400) {
  const nodes = list.filter((p) => Array.isArray(p.codis)).slice(0, cap);
  const edges = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const r = estimateRelationship(nodes[i].codis, nodes[j].codis);
      if (r.kind) edges.push({ a: nodes[i].id, b: nodes[j].id, kind: r.kind, label: r.label, shared: r.shared });
    }
  }
  return { nodes: nodes.map((n) => ({ id: n.id, name: n.name })), edges, truncated: list.filter((p) => Array.isArray(p.codis)).length > cap };
}

function maskPhone(phone) {
  if (!phone) return null;
  return phone.length <= 3 ? '***' : '*'.repeat(phone.length - 3) + phone.slice(-3);
}

module.exports = { DONATE_TO, RULES, canDonate, donorEligibility, matchBlood, organCandidates, sharedLoci, estimateRelationship, kinshipGraph, maskPhone };
