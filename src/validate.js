'use strict';

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const SEX = ['Male', 'Female', 'Other', 'Unknown'];
const ORGANS = ['None', 'Kidney', 'Liver', 'Heart', 'Cornea', 'Bone Marrow'];
const SOURCES = ['simulated', 'manual', 'imported'];
const ROLES = ['admin', 'staff', 'viewer'];

// Screening flags are always computed on the server from the numbers.
// Clients cannot send (or poison) flags.
function computeFlags({ hb, wbc, glucose, sex }) {
  const flags = [];
  const hbLow = sex === 'Male' ? 13.0 : 12.0;
  // Missing values (null) must never be flagged: in JS, null < 12 is true.
  if (hb != null) {
    if (hb < hbLow) flags.push('Low hemoglobin');
    else if (hb > 17.5) flags.push('High hemoglobin');
  }
  if (wbc != null) {
    if (wbc > 11000) flags.push('Elevated WBC');
    else if (wbc < 4000) flags.push('Low WBC');
  }
  if (glucose != null) {
    if (glucose > 140) flags.push('High glucose');
    else if (glucose < 70) flags.push('Low glucose');
  }
  return flags;
}

function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string' && v.trim() !== '' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim());
  return NaN;
}

function isValidISODate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

/**
 * mode 'create'  -> consent must be true
 * mode 'update'  -> consent optional boolean
 * mode 'import'  -> consent optional (defaults false = "not recorded", excluded from matching)
 * Returns { ok, value, errors:[{field,message}] }
 */
function validatePatient(input, mode = 'create', today = new Date()) {
  const errors = [];
  const bad = (field, message) => errors.push({ field, message });
  const b = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const v = {};

  if (typeof b.name !== 'string') bad('name', 'Name is required.');
  else {
    const name = b.name.trim().replace(/\s+/g, ' ');
    if (!name) bad('name', 'Name is required.');
    else if (name.length > 100) bad('name', 'Name must be 100 characters or fewer.');
    else if (/[\u0000-\u001f\u007f]/.test(name)) bad('name', 'Name contains invalid characters.');
    else v.name = name;
  }

  const age = toNumber(b.age);
  if (!Number.isInteger(age) || age < 0 || age > 120) bad('age', 'Age must be a whole number from 0 to 120.');
  else v.age = age;

  const blank = (x) => x === undefined || x === null || (typeof x === 'string' && x.trim() === '');
  v.sex = SEX.includes(b.sex) ? b.sex : mode === 'import' && blank(b.sex) ? 'Unknown' : null;
  if (!v.sex) bad('sex', 'Sex must be Male, Female, Other or Unknown.');

  if (mode === 'import' && (blank(b.bloodGroup) || b.bloodGroup === 'Unknown')) v.bloodGroup = 'Unknown';
  else if (!BLOOD_GROUPS.includes(b.bloodGroup)) bad('bloodGroup', 'Blood group must be one of ' + BLOOD_GROUPS.join(', ') + '.');
  else v.bloodGroup = b.bloodGroup;

  // Lab values are optional (a donor may be registered before screening) but validated when present.
  v.hb = null; v.wbc = null; v.glucose = null;
  if (!blank(b.hb)) {
    const hb = toNumber(b.hb);
    if (isNaN(hb) || hb < 1 || hb > 30) bad('hb', 'Hemoglobin must be a number from 1 to 30 g/dL.');
    else v.hb = Math.round(hb * 10) / 10;
  }
  if (!blank(b.wbc)) {
    const wbc = toNumber(b.wbc);
    if (!Number.isInteger(wbc) || wbc < 100 || wbc > 100000) bad('wbc', 'WBC must be a whole number from 100 to 100000 /µL.');
    else v.wbc = wbc;
  }
  if (!blank(b.glucose)) {
    const glucose = toNumber(b.glucose);
    if (!Number.isInteger(glucose) || glucose < 10 || glucose > 1000) bad('glucose', 'Glucose must be a whole number from 10 to 1000 mg/dL.');
    else v.glucose = glucose;
  }

  v.needsBlood = b.needsBlood === true;
  v.needsOrgan = b.needsOrgan === undefined || b.needsOrgan === null ? 'None' : b.needsOrgan;
  if (!ORGANS.includes(v.needsOrgan)) bad('needsOrgan', 'Unknown organ type.');

  v.phone = null;
  if (b.phone !== undefined && b.phone !== null && String(b.phone).trim() !== '') {
    const p = String(b.phone).replace(/[\s\-()]/g, '');
    if (!/^\+?\d{7,15}$/.test(p)) bad('phone', 'Phone must have 7 to 15 digits (optional leading +).');
    else v.phone = p;
  }

  v.lastDonated = null;
  if (b.lastDonated !== undefined && b.lastDonated !== null && b.lastDonated !== '') {
    if (!isValidISODate(b.lastDonated)) bad('lastDonated', 'Last donated must be a valid date (YYYY-MM-DD).');
    else if (new Date(b.lastDonated + 'T00:00:00Z') > today) bad('lastDonated', 'Last donated cannot be in the future.');
    else if (b.lastDonated < '1990-01-01') bad('lastDonated', 'Last donated date is too far in the past.');
    else v.lastDonated = b.lastDonated;
  }

  if (mode === 'create') {
    if (b.consent !== true) bad('consent', 'Consent to store this record must be confirmed.');
    v.consent = b.consent === true;
  } else {
    v.consent = b.consent === true;
  }

  v.dataSource = b.dataSource === undefined ? 'manual' : b.dataSource;
  if (!SOURCES.includes(v.dataSource)) bad('dataSource', 'Unknown data source.');

  v.codis = null;
  if (b.codis !== undefined && b.codis !== null) {
    if (!Array.isArray(b.codis) || b.codis.length !== 13 || !b.codis.every((n) => Number.isInteger(n) && n >= 1 && n <= 60)) {
      bad('codis', 'STR profile must be 13 whole numbers between 1 and 60.');
    } else v.codis = b.codis;
  }

  if (errors.length) return { ok: false, errors };
  v.flags = computeFlags(v);
  return { ok: true, value: v, errors: [] };
}

function validateNewUser(b) {
  const errors = [];
  const bad = (field, message) => errors.push({ field, message });
  const username = typeof b.username === 'string' ? b.username.trim().toLowerCase() : '';
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) bad('username', 'Username: 3-32 characters (a-z, 0-9, . _ -).');
  if (typeof b.password !== 'string' || b.password.length < 12) bad('password', 'Password must be at least 12 characters.');
  else if (b.password.length > 128) bad('password', 'Password is too long.');
  else if (b.password.toLowerCase().includes(username) && username) bad('password', 'Password must not contain the username.');
  if (!ROLES.includes(b.role)) bad('role', 'Role must be admin, staff or viewer.');
  return errors.length ? { ok: false, errors } : { ok: true, value: { username, password: b.password, role: b.role } };
}

module.exports = { BLOOD_GROUPS, SEX, ORGANS, SOURCES, ROLES, computeFlags, validatePatient, validateNewUser, isValidISODate };
