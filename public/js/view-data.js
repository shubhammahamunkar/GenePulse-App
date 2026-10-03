/* Import (CSV / Excel / JSON) and export (CSV / JSON backup). Everything is parsed in the browser; only validated rows are sent to the server. */
(function () {
  'use strict';
  const { html, icon, $ } = GP;

  const ORGANS = ['Kidney', 'Liver', 'Heart', 'Cornea', 'Bone Marrow'];
  const CHUNK = 500;

  // ---- header + value normalisation (spreadsheets are messy; be forgiving, then let the server validate)
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const HEADERS = {
    name: ['name', 'fullname', 'patientname', 'donorname', 'patient', 'donor'],
    age: ['age', 'ageyears', 'years'],
    sex: ['sex', 'gender'],
    bloodGroup: ['bloodgroup', 'bloodtype', 'bg', 'abo', 'group', 'bloodgrp'],
    hb: ['hb', 'hemoglobin', 'haemoglobin', 'hgb'],
    wbc: ['wbc', 'whitecells', 'whitebloodcells', 'tlc'],
    glucose: ['glucose', 'sugar', 'bloodsugar', 'rbs', 'fbs'],
    phone: ['phone', 'mobile', 'contact', 'phoneno', 'mobileno', 'contactno', 'phonenumber', 'mobilenumber', 'whatsapp'],
    lastDonated: ['lastdonated', 'lastdonation', 'lastdonationdate', 'lastdonateddate', 'lastblooddonation'],
    needsBlood: ['needsblood', 'needblood', 'bloodneeded', 'requiresblood'],
    needsOrgan: ['needsorgan', 'organneeded', 'organ', 'needorgan'],
  };
  const LOOKUP = new Map();
  Object.entries(HEADERS).forEach(([field, names]) => names.forEach((n) => LOOKUP.set(n, field)));

  function normBlood(v) {
    let s = String(v || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!s) return '';
    s = s.replace(/POSITIVE|POS|\+VE/, '+').replace(/NEGATIVE|NEG|-VE/, '-');
    return /^(A|B|AB|O)[+-]$/.test(s) ? s : String(v).trim();
  }
  const normSex = (v) => {
    const s = String(v || '').trim().toLowerCase();
    return s === 'm' || s === 'male' ? 'Male' : s === 'f' || s === 'female' ? 'Female' : s === 'o' || s === 'other' ? 'Other' : s ? String(v).trim() : '';
  };
  const truthy = (v) => v === true || ['yes', 'y', 'true', '1', 'needed', 'required'].includes(String(v || '').trim().toLowerCase());
  function normDate(v) {
    const s = String(v || '').trim();
    if (!s) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/.exec(s); // day-first (India)
    return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : s; // unknown formats go to the server, which rejects them with a clear message
  }
  function normOrgan(v) {
    const s = String(v || '').trim().toLowerCase();
    if (!s || s === 'none' || s === 'no' || s === '-') return 'None';
    const hit = ORGANS.find((o) => o.toLowerCase() === s);
    return hit || String(v).trim();
  }

  function mapRows(rawRows) {
    const unmapped = new Set();
    const rows = rawRows.map((raw) => {
      const o = {};
      Object.entries(raw).forEach(([k, v]) => {
        const field = LOOKUP.get(norm(k));
        if (!field) { if (String(v).trim()) unmapped.add(k); return; }
        if (o[field] === undefined || o[field] === '') o[field] = typeof v === 'string' ? v.trim() : v;
      });
      if (o.bloodGroup !== undefined) o.bloodGroup = normBlood(o.bloodGroup);
      if (o.sex !== undefined) o.sex = normSex(o.sex);
      if (o.lastDonated !== undefined) o.lastDonated = normDate(o.lastDonated);
      if (o.needsBlood !== undefined) o.needsBlood = truthy(o.needsBlood);
      if (o.needsOrgan !== undefined) o.needsOrgan = normOrgan(o.needsOrgan);
      return o;
    }).filter((o) => Object.values(o).some((v) => v !== '' && v !== false && v !== undefined));
    return { rows, unmapped: [...unmapped] };
  }

  let xlsxLoading = null;
  function loadXlsx() {
    if (window.XLSX) return Promise.resolve();
    if (!xlsxLoading) {
      xlsxLoading = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = '/vendor/xlsx.full.min.js';
        s.onload = resolve;
        s.onerror = () => { xlsxLoading = null; reject(new Error('Could not load the spreadsheet reader.')); };
        document.head.appendChild(s);
      });
    }
    return xlsxLoading;
  }

  async function parseFile(file) {
    if (file.size > 8 * 1024 * 1024) throw new Error('That file is larger than 8 MB. Split it into smaller files.');
    const name = file.name.toLowerCase();
    if (name.endsWith('.json')) {
      let data;
      try { data = JSON.parse(await file.text()); } catch { throw new Error('That file is not valid JSON.'); }
      const list = Array.isArray(data) ? data : Array.isArray(data && data.patients) ? data.patients : null;
      if (!list) throw new Error('JSON must be a list of records, or an object with a "patients" list.');
      return mapRows(list.filter((x) => x && typeof x === 'object'));
    }
    if (!/\.(csv|xlsx|xls|tsv|txt)$/.test(name)) throw new Error('Use a .csv, .xlsx, .xls or .json file.');
    await loadXlsx();
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true, dateNF: 'yyyy-mm-dd' });
    if (!wb.SheetNames.length) throw new Error('The workbook has no sheets.');
    const raw = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: false, dateNF: 'yyyy-mm-dd' });
    return mapRows(raw);
  }

  // ---- view
  function render(el) {
    const canImport = GP.canWrite();
    let parsed = null;

    GP.setHtml(el, html`<div class="view-enter">
      ${canImport ? html`<section class="card" aria-labelledby="h-imp">
        <div class="card-head"><h2 id="h-imp">${icon('upload')} Import a spreadsheet</h2></div>
        <ol class="step-list">
          <li>Use a <strong>.csv</strong>, <strong>.xlsx</strong> or <strong>.json</strong> file (first sheet is read; one person per row).</li>
          <li>Columns are recognised by name: Name, Age, Sex, Blood Group, Hemoglobin, WBC, Glucose, Phone, Last Donated, Needs Blood, Needs Organ. Only <em>Name</em> and <em>Age</em> are required.</li>
          <li>Review the preview, confirm consent, and import. Duplicates (same phone, or same name + age + group) are skipped.</li>
        </ol>
        <div class="dropzone" id="drop">
          <p>${icon('file-spreadsheet')} Drag a file here, or choose one</p>
          <label class="btn btn-primary" for="file-in">${icon('upload')} Choose file</label>
          <input id="file-in" type="file" accept=".csv,.xlsx,.xls,.json,.tsv" class="sr-only">
          <button type="button" class="btn btn-ghost" id="tpl-btn">${icon('download')} Download template</button>
        </div>
        <div id="imp-out" aria-live="polite"></div>
      </section>` : html`<div class="banner info">${icon('eye')}<div>Your account is read-only, so importing is disabled. You can still export.</div></div>`}

      <section class="card" aria-labelledby="h-exp">
        <div class="card-head"><h2 id="h-exp">${icon('download')} Export</h2></div>
        <p class="muted">Exports contain personal data${GP.can('viewer') ? ' (phone numbers are masked for your role)' : ''}. Store them securely and delete copies you no longer need.</p>
        <div class="row">
          <button class="btn" id="exp-csv">${icon('file-spreadsheet')} Download CSV</button>
          <button class="btn" id="exp-json">${icon('download')} Download JSON backup</button>
        </div>
      </section>
    </div>`);

    // ---- export
    const stamp = () => GP.todayISO();
    $('#exp-csv', el).onclick = async (e) => GP.withBusy(e.currentTarget, async () => {
      try {
        const list = await GP.loadPatients(true);
        const head = ['ID', 'Name', 'Age', 'Sex', 'Blood group', 'Hemoglobin', 'WBC', 'Glucose', 'Phone', 'Last donated', 'Needs blood', 'Needs organ', 'Consent', 'Flags', 'Source', 'Registered'];
        GP.download(`genepulse-${stamp()}.csv`, GP.toCSV(head, list.map((p) => [p.id, p.name, p.age, p.sex, p.bloodGroup, p.hb, p.wbc, p.glucose, p.phone, p.lastDonated, p.needsBlood ? 'Yes' : 'No', p.needsOrgan, p.consent ? 'Yes' : 'No', p.flags.join('; '), p.dataSource, p.createdAt])), 'text/csv');
        GP.toast(`Exported ${GP.plural(list.length, 'record')}.`, 'ok');
      } catch (err) { GP.errorToast(err); }
    });
    $('#exp-json', el).onclick = async (e) => GP.withBusy(e.currentTarget, async () => {
      try {
        const list = await GP.loadPatients(true);
        GP.download(`genepulse-backup-${stamp()}.json`, JSON.stringify({ exportedAt: new Date().toISOString(), patients: list }, null, 2), 'application/json');
        GP.toast(`Backed up ${GP.plural(list.length, 'record')}.`, 'ok');
      } catch (err) { GP.errorToast(err); }
    });

    if (!canImport) return;
    const out = $('#imp-out', el);

    $('#tpl-btn', el).onclick = () => GP.download('genepulse-template.csv', GP.toCSV(
      ['Name', 'Age', 'Sex', 'Blood Group', 'Hemoglobin', 'WBC', 'Glucose', 'Phone', 'Last Donated', 'Needs Blood', 'Needs Organ'],
      [['Asha Patil', 29, 'Female', 'B+', 13.1, 7200, 92, '9876500001', '2026-03-14', 'No', 'None'],
        ['Rohan Shah', 41, 'Male', 'O-', 14.8, 6400, 101, '9876500002', '', 'Yes', 'None']]), 'text/csv');

    async function handle(file) {
      parsed = null;
      GP.setHtml(out, html`<p class="muted">Reading ${file.name}&hellip;</p>`);
      try {
        parsed = await parseFile(file);
      } catch (err) { GP.setHtml(out, html`<div class="banner bad">${icon('circle-alert')}<div>${err.message}</div></div>`); return; }
      const { rows, unmapped } = parsed;
      if (!rows.length) { GP.setHtml(out, html`<div class="banner bad">${icon('circle-alert')}<div>No usable rows found. Check that the first row contains column names such as Name and Age.</div></div>`); return; }
      const cols = ['name', 'age', 'sex', 'bloodGroup', 'hb', 'phone'];
      GP.setHtml(out, html`
        <h3>${GP.plural(rows.length, 'row')} ready to import</h3>
        ${unmapped.length ? html`<p class="muted hint">Ignored columns: ${unmapped.slice(0, 8).join(', ')}${unmapped.length > 8 ? '…' : ''}</p>` : ''}
        <div class="table-wrap" tabindex="0" role="region" aria-label="Preview of the first rows"><table>
          <thead><tr><th>Name</th><th>Age</th><th>Sex</th><th>Group</th><th>Hb</th><th>Phone</th></tr></thead>
          <tbody>${rows.slice(0, 5).map((r) => html`<tr>${cols.map((c) => html`<td>${r[c] ?? ''}</td>`)}</tr>`)}</tbody></table></div>
        ${rows.length > 5 ? html`<p class="muted hint">Showing the first 5 rows.</p>` : ''}
        <div class="field"><label class="check"><input type="checkbox" id="imp-consent"><span><strong>I confirm</strong> that every person in this file agreed to have their details stored here. Without this, rows are imported as "no consent" and are never offered as donors.</span></label></div>
        <button class="btn btn-primary" id="imp-go">${icon('upload')} Import ${GP.plural(rows.length, 'row')}</button>`);
      $('#imp-go', out).onclick = (e) => GP.withBusy(e.currentTarget, doImport);
    }

    async function doImport() {
      const consentConfirmed = $('#imp-consent', out).checked;
      const rows = parsed.rows;
      const total = { inserted: 0, skippedDuplicates: 0, invalid: 0, errors: [] };
      try {
        for (let i = 0; i < rows.length; i += CHUNK) {
          const res = await GP.api('POST', '/api/patients/bulk', { records: rows.slice(i, i + CHUNK), consentConfirmed });
          total.inserted += res.inserted; total.skippedDuplicates += res.skippedDuplicates; total.invalid += res.invalid;
          res.errors.forEach((er) => { if (total.errors.length < 50) total.errors.push({ row: er.row + i, errors: er.errors }); });
        }
      } catch (err) {
        GP.invalidate();
        GP.setHtml(out, html`<div class="banner bad">${icon('circle-alert')}<div>Import stopped: ${err.message}${total.inserted ? ` ${total.inserted} rows from earlier batches were already saved.` : ' Nothing was saved.'}</div></div>`);
        return;
      }
      GP.invalidate();
      parsed = null;
      GP.setHtml(out, html`
        <div class="banner ${total.inserted ? 'good' : 'warn'}" role="status">${icon(total.inserted ? 'circle-check' : 'triangle-alert')}<div>
          <strong>${total.inserted} imported</strong>, ${total.skippedDuplicates} duplicates skipped, ${total.invalid} rows had problems.
          ${consentConfirmed ? '' : ' Consent was not confirmed, so these records are marked "no consent".'}</div></div>
        ${total.errors.length ? html`<details open><summary>Row problems (first ${total.errors.length})</summary>
          <ul class="err-list">${total.errors.map((er) => html`<li>Row ${er.row + 1} (counting the header as row 1): ${er.errors.map((x) => x.message).join(' ')}</li>`)}</ul></details>` : ''}
        <div class="row"><a class="btn btn-primary" href="#/directory">${icon('users')} Open directory</a></div>`);
      GP.toast(`${total.inserted} records imported.`, total.inserted ? 'ok' : 'warn');
    }

    const input = $('#file-in', el);
    input.onchange = () => { if (input.files[0]) handle(input.files[0]); input.value = ''; };
    const drop = $('#drop', el);
    ['dragenter', 'dragover'].forEach((n) => drop.addEventListener(n, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((n) => drop.addEventListener(n, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
    drop.addEventListener('drop', (e) => { const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) handle(f); });
  }

  GP.views.data = { title: 'Import & export', render };
})();
