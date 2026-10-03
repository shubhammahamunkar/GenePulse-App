'use strict';
/*
 * Integration tests. They need a throw-away Postgres database:
 *   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/genepulse_test npm test
 * WARNING: the tables in that database are dropped and recreated.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const DB = process.env.TEST_DATABASE_URL;
if (!DB) {
  test('api tests skipped (set TEST_DATABASE_URL)', { skip: true }, () => {});
  return;
}
Object.assign(process.env, {
  DATABASE_URL: DB, DATABASE_SSL: 'false', NODE_ENV: 'test',
  JWT_SECRET: 'test-secret-test-secret-test-secret-123456',
  ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'Initial-Admin-Pass-1',
  MAX_LOGIN_FAILURES: '3', LOCK_MINUTES: '1', API_RATE_MAX: '100000',
});

const { pool, migrate, bootstrapAdmin } = require('../src/db');
const { createApp } = require('../src/app');

let server; let base;

// Minimal cookie-jar client.
function client() {
  let cookie = '';
  async function call(method, url, body, extra = {}) {
    const headers = { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) };
    if (method !== 'GET') headers['X-Requested-With'] = 'genepulse';
    if (cookie) headers.Cookie = cookie;
    Object.assign(headers, extra);
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (set.length) {
      const c = set.map((s) => s.split(';')[0]).find((s) => s.startsWith('gp_session='));
      cookie = c && c !== 'gp_session=' ? c : '';
    }
    let json = null;
    try { json = await res.json(); } catch { /* not json */ }
    return { status: res.status, json, headers: res.headers };
  }
  return {
    get: (u, h) => call('GET', u, undefined, h), post: (u, b, h) => call('POST', u, b, h),
    patch: (u, b) => call('PATCH', u, b), del: (u) => call('DELETE', u),
    raw: call,
  };
}

async function loginAs(username, password, newPassword) {
  const c = client();
  const r = await c.post('/api/auth/login', { username, password });
  assert.equal(r.status, 200, `login ${username}: ${JSON.stringify(r.json)}`);
  if (r.json.user.mustChangePassword) {
    const ch = await c.post('/api/auth/change-password', { currentPassword: password, newPassword });
    assert.equal(ch.status, 200, `change pw: ${JSON.stringify(ch.json)}`);
  }
  return c;
}

const good = (o = {}) => ({
  name: 'Asha Rao', age: 30, sex: 'Female', bloodGroup: 'O+', hb: 13.5, wbc: 7000, glucose: 95,
  needsBlood: false, needsOrgan: 'None', phone: '+91 98765 43210', consent: true, ...o,
});

let admin; let staff; let viewer;

before(async () => {
  await pool.query('DROP TABLE IF EXISTS audit_log, users, patients CASCADE');
});
after(async () => { if (server) await new Promise((r) => server.close(r)); await pool.end(); });

test('migration: upgrades a legacy v1 patients table without losing rows or crashing on bad data', async () => {
  await pool.query(`CREATE TABLE patients (id VARCHAR(50) PRIMARY KEY, name TEXT NOT NULL, age INTEGER, sex VARCHAR(20),
    blood_group VARCHAR(10), hb NUMERIC(4,1), wbc INTEGER, glucose INTEGER, codis JSONB, flags JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, needs_blood BOOLEAN NOT NULL DEFAULT FALSE,
    needs_organ VARCHAR(30) NOT NULL DEFAULT 'None')`);
  await pool.query(`INSERT INTO patients (id,name,age,sex,blood_group,hb,wbc,glucose,flags) VALUES
    ('GP-2026-AAAA1111','Old Record',40,'Male','B+',14.2,7000,90,'"boom"'),
    ('GP-2026-BBBB2222','Null Record',NULL,NULL,NULL,NULL,NULL,NULL,NULL)`);
  await migrate();
  await migrate(); // idempotent
  await bootstrapAdmin();
  const { rows } = await pool.query('SELECT id, data_source, consent FROM patients ORDER BY id');
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.data_source === 'simulated' && r.consent === false), 'legacy rows are labelled simulated / no consent');
  const u = await pool.query('SELECT username, must_change_password FROM users');
  assert.deepEqual(u.rows, [{ username: 'admin', must_change_password: true }]);

  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

test('public: health ok, security headers set, API never cached', async () => {
  const c = client();
  const h = await c.get('/api/health');
  assert.equal(h.status, 200);
  assert.deepEqual(h.json, { status: 'ok' });
  const csp = h.headers.get('content-security-policy');
  assert.ok(csp.includes("default-src 'self'") && csp.includes("script-src 'self'") && csp.includes("frame-ancestors 'none'"));
  assert.equal(h.headers.get('x-powered-by'), null);
  assert.equal(h.headers.get('cache-control'), 'no-store');
  const nf = await c.get('/api/nope');
  assert.equal(nf.status, 404);
  assert.equal(nf.json.code, 'NOT_FOUND');
});

test('auth: unauthenticated is rejected; forced password change; CSRF header; weak passwords refused', async () => {
  const c = client();
  assert.equal((await c.get('/api/patients')).status, 401);
  const bad = await c.post('/api/auth/login', { username: 'admin', password: 'wrong-wrong-wrong' });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.code, 'LOGIN_FAILED');
  const unknown = await c.post('/api/auth/login', { username: 'nobody', password: 'wrong-wrong-wrong' });
  assert.deepEqual(unknown.json, bad.json, 'same message for unknown user and wrong password');

  const ok = await c.post('/api/auth/login', { username: 'admin', password: 'Initial-Admin-Pass-1' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.user.mustChangePassword, true);
  const blocked = await c.get('/api/patients');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.code, 'PASSWORD_CHANGE_REQUIRED');

  assert.equal((await c.post('/api/auth/change-password', { currentPassword: 'Initial-Admin-Pass-1', newPassword: 'short' })).status, 400);
  assert.equal((await c.post('/api/auth/change-password', { currentPassword: 'Initial-Admin-Pass-1', newPassword: 'admin-admin-admin' })).status, 400, 'must not contain username');
  const ch = await c.post('/api/auth/change-password', { currentPassword: 'Initial-Admin-Pass-1', newPassword: 'Brand-New-Secret-Pass-2' });
  assert.equal(ch.status, 200);
  assert.equal((await c.get('/api/patients')).status, 200);

  // CSRF: a state-changing request without the custom header is refused even with a valid cookie.
  const noHeader = await c.raw('POST', '/api/patients', good(), { 'X-Requested-With': '' });
  assert.equal(noHeader.status, 403);
  assert.equal(noHeader.json.code, 'CSRF');
  admin = c;
});

test('admin: create users, duplicate username, role guards', async () => {
  const mk = async (username, role) => admin.post('/api/admin/users', { username, password: 'Temp-Password-1234', role });
  assert.equal((await mk('nurse1', 'staff')).status, 201);
  assert.equal((await mk('viewer1', 'viewer')).status, 201);
  const dup = await mk('nurse1', 'staff');
  assert.equal(dup.status, 409);
  assert.equal((await admin.post('/api/admin/users', { username: 'x', password: 'short', role: 'god' })).status, 400);

  staff = await loginAs('nurse1', 'Temp-Password-1234', 'Nurse-Own-Password-9');
  viewer = await loginAs('viewer1', 'Temp-Password-1234', 'Viewer-Own-Password-9');

  const users = await admin.get('/api/admin/users');
  assert.equal(users.json.users.length, 3);
  assert.ok(users.json.users.every((u) => !('password_hash' in u) && !('passwordHash' in u)));
  const me = await admin.get('/api/auth/me');
  const self = users.json.users.find((u) => u.username === 'admin');
  assert.equal((await admin.patch(`/api/admin/users/${self.id}`, { role: 'viewer' })).status, 400, 'cannot demote self');
  assert.equal((await admin.patch(`/api/admin/users/${self.id}`, { active: false })).status, 400, 'cannot deactivate self');
  assert.equal(me.json.user.role, 'admin');

  assert.equal((await staff.get('/api/admin/users')).status, 403);
  assert.equal((await staff.get('/api/admin/audit')).status, 403);
  assert.equal((await viewer.get('/api/admin/users')).status, 403);
});

test('lockout: repeated wrong passwords lock the account even for the right password', async () => {
  const c = client();
  for (let i = 0; i < 3; i++) await c.post('/api/auth/login', { username: 'viewer1', password: 'definitely-wrong-1' });
  const r = await c.post('/api/auth/login', { username: 'viewer1', password: 'Viewer-Own-Password-9' });
  assert.equal(r.status, 401, 'locked');
  const users = await admin.get('/api/admin/users');
  const v = users.json.users.find((u) => u.username === 'viewer1');
  assert.equal(v.locked, true);
  assert.equal((await admin.patch(`/api/admin/users/${v.id}`, { unlock: true })).status, 200);
  const again = await c.post('/api/auth/login', { username: 'viewer1', password: 'Viewer-Own-Password-9' });
  assert.equal(again.status, 200, 'works after admin unlock');
});

test('patients: validation, computed flags, consent, duplicates, injection resistance', async () => {
  const noConsent = await staff.post('/api/patients', good({ consent: false }));
  assert.equal(noConsent.status, 400);
  assert.ok(noConsent.json.errors.some((e) => e.field === 'consent'));

  for (const [field, value] of [['age', 200], ['age', 'abc'], ['hb', 99], ['bloodGroup', 'Z+'], ['bloodGroup', 'Unknown'],
    ['sex', 'robot'], ['phone', '12'], ['lastDonated', '2999-01-01'], ['lastDonated', '2020-02-31'], ['name', '   ']]) {
    const r = await staff.post('/api/patients', good({ [field]: value }));
    assert.equal(r.status, 400, `${field}=${value} should be rejected`);
    assert.ok(r.json.errors.some((e) => e.field === field), `error mentions ${field}`);
  }

  const created = await staff.post('/api/patients', good({ name: 'Ravi <b>Kumar</b>', sex: 'Male', hb: 11, flags: ['INJECTED'] }));
  assert.equal(created.status, 201);
  const p = created.json.patient;
  assert.match(p.id, /^GP-\d{4}-[0-9A-F]{8}$/);
  assert.deepEqual(p.flags, ['Low hemoglobin'], 'flags are computed on the server; client flags ignored');
  assert.equal(p.name, 'Ravi <b>Kumar</b>', 'stored verbatim (the UI escapes on output)');
  assert.equal(p.eligibility.eligible, false);
  assert.ok(p.eligibility.reasons.some((x) => x.includes('Hemoglobin below')));
  assert.equal(p.phone, '+919876543210', 'phone normalised');

  const dup = await staff.post('/api/patients', good({ name: 'ravi <b>kumar</b>', sex: 'Male', hb: 11 }));
  assert.equal(dup.status, 409);
  assert.equal(dup.json.code, 'DUPLICATE');
  assert.equal((await staff.post('/api/patients?force=1', good({ name: 'Ravi <b>Kumar</b>', sex: 'Male', hb: 11, phone: '9000000001' }))).status, 201);

  assert.equal((await viewer.post('/api/patients', good({ name: 'Nope' }))).status, 403);

  const evil = await staff.get(`/api/patients/${encodeURIComponent("x'; DROP TABLE patients;--")}`);
  assert.equal(evil.status, 404);
  assert.equal((await pool.query('SELECT 1 FROM patients LIMIT 1')).rowCount, 1, 'table still exists');
});

test('patients: viewer sees masked phones; legacy rows with null/odd data do not break the list', async () => {
  const asViewer = await viewer.get('/api/patients');
  assert.equal(asViewer.status, 200);
  const withPhone = asViewer.json.patients.find((x) => x.phone);
  assert.match(withPhone.phone, /^\*+\d{3}$/, 'masked');
  const asStaff = await staff.get('/api/patients');
  const legacy = asStaff.json.patients.filter((x) => ['GP-2026-AAAA1111', 'GP-2026-BBBB2222'].includes(x.id));
  assert.equal(legacy.length, 2);
  assert.ok(legacy.every((x) => Array.isArray(x.flags) && x.consent === false && x.dataSource === 'simulated'));
  assert.ok(legacy.every((x) => x.eligibility.eligible === false), 'no consent => never offered as a donor');
});

test('patients: partial update keeps untouched fields (incl. STR profile); validates; audited without values', async () => {
  const codis = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];
  const c = await staff.post('/api/patients', good({ name: 'Sim Person', phone: '9111111111', dataSource: 'simulated', codis }));
  assert.equal(c.status, 201);
  const id = c.json.patient.id;
  const up = await staff.patch(`/api/patients/${id}`, { bloodGroup: 'A+', phone: '' });
  assert.equal(up.status, 200);
  assert.equal(up.json.patient.bloodGroup, 'A+');
  assert.equal(up.json.patient.phone, null);
  assert.equal(up.json.patient.name, 'Sim Person');
  assert.deepEqual(up.json.patient.codis, codis, 'STR profile preserved');
  assert.equal(up.json.patient.dataSource, 'simulated');
  assert.equal((await staff.patch(`/api/patients/${id}`, { age: 500 })).status, 400);
  assert.equal((await staff.patch('/api/patients/GP-0000-NOPE', { age: 5 })).status, 404);
  assert.equal((await staff.patch(`/api/patients/${id}`, { id: 'HACK', createdBy: 1, deletedAt: 'x' })).status, 200, 'unknown fields ignored');
  const audit = await admin.get('/api/admin/audit?action=patient_updated');
  const entry = audit.json.entries.find((e) => e.entity_id === id);
  assert.deepEqual(entry.meta.fields.sort(), ['bloodGroup', 'phone']);
  assert.ok(!JSON.stringify(entry).includes('Sim Person'), 'audit never contains personal data');
});

test('donations: recording, validation and the eligibility interval', async () => {
  const c = await staff.post('/api/patients', good({ name: 'Donor Dev', sex: 'Male', phone: '9222222222', hb: 14.5 }));
  const id = c.json.patient.id;
  assert.equal(c.json.patient.eligibility.eligible, true);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const rec = await staff.post(`/api/patients/${id}/donations`, {});
  assert.equal(rec.status, 200);
  assert.equal(rec.json.patient.lastDonated, today);
  assert.equal(rec.json.patient.eligibility.eligible, false);
  assert.ok(rec.json.patient.eligibility.reasons.some((r) => r.includes('wait')));
  assert.equal((await staff.post(`/api/patients/${id}/donations`, { date: '2999-01-01' })).status, 400, 'future');
  assert.equal((await staff.post(`/api/patients/${id}/donations`, { date: '2000-01-01' })).status, 400, 'earlier than last');
  assert.equal((await staff.post(`/api/patients/${id}/donations`, { date: 'tomorrow' })).status, 400);
  assert.equal((await viewer.post(`/api/patients/${id}/donations`, {})).status, 403);
  const old = await staff.post('/api/patients', good({ name: 'Donor Old', sex: 'Male', phone: '9333333333', hb: 14, lastDonated: '2020-01-01' }));
  assert.equal(old.json.patient.eligibility.eligible, true, 'long ago => eligible again');
});

test('archive / restore / permanent delete', async () => {
  const c = await staff.post('/api/patients', good({ name: 'To Archive', phone: '9444444444' }));
  const id = c.json.patient.id;
  assert.equal((await staff.del(`/api/patients/${id}`)).status, 403, 'staff cannot delete');
  assert.equal((await admin.del(`/api/patients/${id}?permanent=1`)).status, 409, 'must archive first');
  assert.equal((await admin.del(`/api/patients/${id}`)).status, 200);
  assert.equal((await staff.get(`/api/patients/${id}`)).status, 404);
  assert.ok(!(await staff.get('/api/patients')).json.patients.some((p) => p.id === id));
  assert.ok((await admin.get('/api/patients?archived=1')).json.patients.some((p) => p.id === id));
  assert.equal((await staff.get('/api/patients?archived=1')).json.patients.some((p) => p.id === id), false, 'archive list is admin-only');
  assert.equal((await admin.post(`/api/patients/${id}/restore`)).status, 200);
  assert.equal((await staff.get(`/api/patients/${id}`)).status, 200);
  await admin.del(`/api/patients/${id}`);
  assert.equal((await admin.del(`/api/patients/${id}?permanent=1`)).status, 200);
  assert.equal((await pool.query('SELECT 1 FROM patients WHERE id=$1', [id])).rowCount, 0);
});

test('bulk import: validation report, duplicates, consent flag, limits', async () => {
  const rows = [
    { name: 'Imp One', age: 25, sex: 'Male', bloodGroup: 'B+', hb: 14, phone: '9555555501' },
    { name: 'Imp Two', age: 31 },                                  // only name + age is enough
    { name: 'Imp One', age: 25, bloodGroup: 'B+' },               // duplicate inside the file
    { name: 'Ravi <b>Kumar</b>', age: 30, sex: 'Male', bloodGroup: 'O+' }, // duplicate of an existing record
    { name: 'Bad Age', age: 'x' },
    { name: '', age: 20 },
    { name: 'Bad Group', age: 20, bloodGroup: 'Q-' },
    'not an object',
  ];
  const r = await staff.post('/api/patients/bulk', { records: rows, consentConfirmed: false });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.inserted, 2);
  assert.equal(r.json.skippedDuplicates, 2);
  assert.equal(r.json.invalid, 4);
  assert.deepEqual(r.json.errors.map((e) => e.row), [5, 6, 7, 8]);
  const rec = (await staff.get('/api/patients')).json.patients.find((p) => p.name === 'Imp Two');
  assert.equal(rec.consent, false);
  assert.equal(rec.dataSource, 'imported');
  assert.equal(rec.bloodGroup, 'Unknown');
  assert.deepEqual(rec.flags, [], 'blank lab values are not flagged');
  assert.equal(rec.eligibility.eligible, false);

  const again = await staff.post('/api/patients/bulk', { records: [rows[0]], consentConfirmed: true });
  assert.equal(again.json.inserted, 0, 're-importing the same file adds nothing');
  assert.equal(again.json.skippedDuplicates, 1);

  assert.equal((await staff.post('/api/patients/bulk', { records: [] })).status, 400);
  assert.equal((await staff.post('/api/patients/bulk', { records: 'x' })).status, 400);
  assert.equal((await staff.post('/api/patients/bulk', { records: Array.from({ length: 1001 }, (_, i) => ({ name: `N${i}`, age: 20 })) })).status, 413);
  assert.equal((await viewer.post('/api/patients/bulk', { records: rows })).status, 403);
});

test('insights: blood matching, shortages, stats, kinship, organ candidates', async () => {
  const mk = (o) => staff.post('/api/patients?force=1', good(o));
  await mk({ name: 'Match Donor', sex: 'Male', age: 28, bloodGroup: 'O-', hb: 15, phone: '9666666601' });
  await mk({ name: 'Tired Donor', sex: 'Male', age: 28, bloodGroup: 'O+', hb: 11, phone: '9666666602' });
  const rcp = await mk({ name: 'Needs Blood A', sex: 'Female', age: 50, bloodGroup: 'A+', needsBlood: true, hb: 8, phone: '9666666603' });
  await mk({ name: 'Needs Blood AB-', sex: 'Female', age: 60, bloodGroup: 'AB-', needsBlood: true, hb: 8, phone: '9666666604' });

  const m = await staff.get('/api/match/blood');
  assert.equal(m.status, 200);
  const forA = m.json.recipients.find((r) => r.recipient.id === rcp.json.patient.id);
  const donorNames = forA.donors.map((d) => d.name);
  assert.ok(donorNames.includes('Match Donor') && donorNames.includes('Tired Donor'));
  assert.equal(forA.donors.find((d) => d.name === 'Match Donor').eligible, true);
  const tired = forA.donors.find((d) => d.name === 'Tired Donor');
  assert.equal(tired.eligible, false);
  assert.ok(tired.reasons[0].includes('Hemoglobin below'));
  assert.equal(forA.donors[0].eligible, true, 'eligible donors are listed first');
  assert.ok(forA.donors.every((d) => d.name !== 'Needs Blood A'));
  const vm = await viewer.get('/api/match/blood');
  assert.ok(vm.json.recipients.flatMap((r) => r.donors).filter((d) => d.phone).every((d) => /^\*+\d{3}$/.test(d.phone)), 'viewer: masked');

  const s = await staff.get('/api/stats');
  assert.equal(s.status, 200);
  assert.ok(s.json.total >= 8 && s.json.needBlood >= 2);
  assert.ok(s.json.shortages.includes('AB-') === false || s.json.bloodGroups.find((b) => b.group === 'AB-').compatibleSupply < 1);
  assert.equal(s.json.bloodGroups.length, 8);
  assert.ok(s.json.flagCounts['Low hemoglobin'] >= 1);
  assert.ok(s.json.noConsent >= 2, 'legacy + imported rows without consent are counted');

  const a = Array.from({ length: 13 }, (_, i) => 10 + (i % 5));
  const b = a.slice(); b[0] += 9; b[1] += 9; // 11/13 shared => parent-child
  await mk({ name: 'Kin A', dataSource: 'simulated', codis: a, phone: '9666666610' });
  await mk({ name: 'Kin B', dataSource: 'simulated', codis: b, phone: '9666666611' });
  const k = await staff.get('/api/kinship');
  const ids = Object.fromEntries(k.json.nodes.map((n) => [n.name, n.id]));
  const edge = k.json.edges.find((e) => [e.a, e.b].includes(ids['Kin A']) && [e.a, e.b].includes(ids['Kin B']));
  assert.equal(edge.kind, 'parent');

  const o = await mk({ name: 'Needs Kidney', age: 40, bloodGroup: 'A+', needsOrgan: 'Kidney', phone: '9666666620' });
  const org = await staff.get('/api/match/organ');
  const mine = org.json.recipients.find((r) => r.recipient.id === o.json.patient.id);
  assert.ok(Array.isArray(mine.candidates));
  assert.ok(mine.candidates.every((c) => c.name !== 'Needs Kidney'));
});

test('admin: deactivate kills live sessions; password reset; audit log is complete and PII-free', async () => {
  const users = (await admin.get('/api/admin/users')).json.users;
  const n = users.find((u) => u.username === 'nurse1');
  assert.equal((await staff.get('/api/patients')).status, 200);
  assert.equal((await admin.patch(`/api/admin/users/${n.id}`, { active: false })).status, 200);
  assert.equal((await staff.get('/api/patients')).status, 401, 'live session revoked immediately');
  const c = client();
  assert.equal((await c.post('/api/auth/login', { username: 'nurse1', password: 'Nurse-Own-Password-9' })).status, 401, 'cannot log in while inactive');
  assert.equal((await admin.patch(`/api/admin/users/${n.id}`, { active: true, newPassword: 'Reset-Temp-Password-77' })).status, 200);
  const back = await c.post('/api/auth/login', { username: 'nurse1', password: 'Reset-Temp-Password-77' });
  assert.equal(back.json.user.mustChangePassword, true, 'reset forces a new password');

  const log = await admin.get('/api/admin/audit?limit=500');
  const actions = new Set(log.json.entries.map((e) => e.action));
  for (const a of ['login', 'login_failed', 'account_locked', 'password_changed', 'user_created', 'patient_created',
    'patient_updated', 'donation_recorded', 'patient_archived', 'patient_restored', 'patient_deleted_permanently', 'patients_imported', 'user_updated']) {
    assert.ok(actions.has(a), `audit has ${a}`);
  }
  const blob = JSON.stringify(log.json.entries);
  for (const secret of ['Ravi', 'Asha Rao', '9876543210', 'Initial-Admin-Pass-1', 'Nurse-Own-Password-9', 'Brand-New-Secret-Pass-2']) {
    assert.ok(!blob.includes(secret), `audit must not contain "${secret}"`);
  }
});

test('robustness: malformed JSON, oversized body, wrong types, error bodies never leak internals', async () => {
  const bad = await staff.raw('POST', '/api/auth/login', '{ not json', { 'Content-Type': 'application/json' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'BAD_JSON');
  const big = await admin.post('/api/patients/bulk', { records: [{ name: 'x'.repeat(1_200_000), age: 1 }] });
  assert.equal(big.status, 413);
  for (const body of [null, 5, [], 'str', { name: { $ne: 1 }, age: [] }]) {
    const r = await admin.raw('POST', '/api/patients', body === null ? 'null' : JSON.stringify(body));
    assert.ok([400].includes(r.status), `body ${JSON.stringify(body)} -> ${r.status}`);
  }
  const texts = JSON.stringify([bad.json, big.json]);
  assert.ok(!/at .*\.js|node_modules|\/home\/|stack/i.test(texts), 'no stack traces or paths in error responses');
});

test('rate limiting: failed logins are throttled per IP (runs last)', async () => {
  const c = client();
  let limited = null;
  for (let i = 0; i < 30 && !limited; i++) {
    const r = await c.post('/api/auth/login', { username: `ghost${i}`, password: 'wrong-wrong-wrong' });
    if (r.status === 429) limited = r;
  }
  assert.ok(limited, 'eventually 429');
  assert.equal(limited.json.code, 'RATE_LIMITED');
});
