/* GenePulse frontend core. Plain browser JS, no build step. Everything user-supplied is escaped by the html`` helper. */
(function () {
  'use strict';
  const GP = (window.GP = { views: {}, hooks: {}, state: { user: null, patients: null, stats: null } });

  // ---------------------------------------------------------------- safe templating
  // html`<td>${value}</td>` escapes every interpolated value. Only values wrapped by raw() or produced by
  // html`` itself are inserted as markup. This makes "forgot to escape" bugs (XSS) structurally hard.
  class Raw { constructor(s) { this.s = s; } }
  const raw = (s) => new Raw(String(s));
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
  function toHtml(v) {
    if (v instanceof Raw) return v.s;
    if (Array.isArray(v)) return v.map(toHtml).join('');
    if (v === null || v === undefined || v === false) return '';
    return esc(v);
  }
  function html(strings, ...vals) {
    let out = '';
    strings.forEach((s, i) => { out += s; if (i < vals.length) out += toHtml(vals[i]); });
    return new Raw(out);
  }
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const setHtml = (el, content) => { el.innerHTML = toHtml(content); return el; };
  Object.assign(GP, { raw, html, esc, $, $$, setHtml });

  GP.icon = (name, cls = '') => raw(`<svg class="ic ${esc(cls)}" aria-hidden="true"><use href="/icons.svg#i-${esc(name)}"/></svg>`);

  // ---------------------------------------------------------------- formatting
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  GP.fmtDay = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || ''); return m ? `${m[3]} ${MON[+m[2] - 1]} ${m[1]}` : '-'; };
  GP.fmtDateTime = (iso) => {
    if (!iso) return '-';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  GP.todayISO = () => new Date().toLocaleDateString('en-CA');
  GP.initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
  GP.bgBadge = (g) => {
    const group = g || 'Unknown';
    const cls = group === 'Unknown' ? 'Unknown' : group.replace(/[+-]/g, '');
    return html`<span class="bg bg-${cls}">${group}</span>`;
  };
  GP.plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;
  GP.debounce = (fn, ms = 200) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  GP.sleep = sleep;

  // Phone display. Viewers receive masked numbers (e.g. "******3210") which must not become links.
  GP.phoneActions = (phone, message) => {
    if (!phone) return raw('<span class="faint">-</span>');
    if (phone.startsWith('*')) return html`<span class="mono">${phone}</span>`;
    let digits = phone.replace(/\D/g, '');
    if (!phone.startsWith('+') && digits.length === 10) digits = '91' + digits; // assumes India for bare 10-digit numbers
    const wa = `https://wa.me/${digits}?text=${encodeURIComponent(message || 'Hello')}`;
    return html`<span class="row">
      <a class="btn btn-ghost btn-sm" href="tel:${phone.replace(/[^\d+]/g, '')}">${GP.icon('phone')} ${phone}</a>
      <a class="btn btn-ghost btn-sm" href="${wa}" target="_blank" rel="noopener noreferrer" aria-label="Message on WhatsApp">${GP.icon('message-circle')}</a>
    </span>`;
  };

  // ---------------------------------------------------------------- network
  class ApiError extends Error { constructor(message, info) { super(message); this.name = 'ApiError'; Object.assign(this, info); } }
  GP.ApiError = ApiError;
  const apiBase = ((document.querySelector('meta[name="api-base"]') || {}).content || '').replace(/\/+$/, '');
  let inflight = 0; let bannerTimer = null;

  const net = () => $('#netBanner');
  function busyStart() {
    inflight++;
    if (!bannerTimer) {
      bannerTimer = setTimeout(() => {
        setHtml(net(), html`${GP.icon('clock')}<span>Waking the server up&hellip; free hosting can take up to a minute after a quiet period. Please wait.</span>`);
        net().hidden = false;
      }, 4000);
    }
  }
  function busyEnd() {
    inflight = Math.max(0, inflight - 1);
    if (inflight === 0) { clearTimeout(bannerTimer); bannerTimer = null; net().hidden = true; }
  }

  GP.api = async function api(method, path, body, opt = {}) {
    const retries = method === 'GET' ? 2 : 0; // only idempotent reads are retried automatically
    for (let attempt = 0; ; attempt++) {
      busyStart();
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 75000);
      try {
        const res = await fetch(apiBase + path, {
          method, credentials: 'same-origin', signal: ctl.signal,
          headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), 'X-Requested-With': 'genepulse' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        let data = null;
        try { data = await res.json(); } catch { /* empty or non-JSON body */ }
        if (res.ok) return data;
        if ([502, 503, 504].includes(res.status) && attempt < retries) { await sleep(1500 * (attempt + 1)); continue; }
        const err = new ApiError((data && data.error) || `Request failed (${res.status}).`, { status: res.status, code: data && data.code, errors: data && data.errors, data });
        if (!opt.quiet) {
          if (res.status === 401 && err.code === 'UNAUTHENTICATED' && GP.hooks.onSessionLost) GP.hooks.onSessionLost();
          if (res.status === 403 && err.code === 'PASSWORD_CHANGE_REQUIRED' && GP.hooks.onPasswordChange) GP.hooks.onPasswordChange();
        }
        throw err;
      } catch (e) {
        if (e instanceof ApiError) throw e;
        if (attempt < retries) { await sleep(1500 * (attempt + 1)); continue; }
        throw new ApiError(e.name === 'AbortError' ? 'The server took too long to respond. Please try again.' : 'Cannot reach the server. Check your connection and try again.', { status: 0, code: 'NETWORK' });
      } finally {
        clearTimeout(timer);
        busyEnd();
      }
    }
  };

  // ---------------------------------------------------------------- state / data
  GP.can = (...roles) => !!GP.state.user && roles.includes(GP.state.user.role);
  GP.canWrite = () => GP.can('admin', 'staff');
  GP.loadPatients = async (force = false) => {
    if (GP.state.patients && !force) return GP.state.patients;
    const d = await GP.api('GET', '/api/patients');
    GP.state.patients = d.patients;
    return d.patients;
  };
  GP.invalidate = () => { GP.state.patients = null; GP.state.stats = null; };

  // ---------------------------------------------------------------- feedback: toasts
  GP.toast = (msg, type = 'info', ms) => {
    const el = document.createElement('div');
    el.className = `toast ${type === 'ok' || type === 'err' || type === 'warn' ? type : ''}`;
    el.setAttribute('role', type === 'err' ? 'alert' : 'status');
    setHtml(el, html`${GP.icon(type === 'err' ? 'circle-alert' : type === 'ok' ? 'circle-check' : 'info')}<div>${msg}</div>`);
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), ms || (type === 'err' ? 7500 : 3800));
  };
  GP.errorToast = (e) => GP.toast(e && e.message ? e.message : 'Something went wrong.', 'err');

  // ---------------------------------------------------------------- feedback: dialogs (native <dialog>)
  GP.closeDialog = () => { const d = $('#dlg'); if (d.open) d.close(); };
  /*
   * GP.dialog({ title, body, actions:[{label, kind, value, run}], wide, onOpen })
   * An action's run(dialogEl, button) may be async; returning false keeps the dialog open.
   * Resolves with the clicked action's value (or undefined if dismissed).
   */
  GP.dialog = ({ title, body, actions = [], wide = false, onOpen }) => new Promise((resolve) => {
    const d = $('#dlg');
    if (d.open) d.close();
    d.className = wide ? 'wide' : '';
    setHtml(d, html`
      <div class="dlg-head"><h2 id="dlgTitle">${title}</h2>
        <button class="btn btn-ghost btn-icon" type="button" data-close aria-label="Close">${GP.icon('x')}</button></div>
      <div class="dlg-body">${body}</div>
      ${actions.length ? html`<div class="dlg-foot">${actions.map((a, i) => html`<button type="button" class="btn ${a.kind === 'primary' ? 'btn-primary' : a.kind === 'danger' ? 'btn-danger' : 'btn-ghost'}" data-act="${i}">${a.label}</button>`)}</div>` : ''}`);
    let result;
    const ac = new AbortController();
    d.addEventListener('click', async (e) => {
      if (e.target === d || e.target.closest('[data-close]')) { d.close(); return; }
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const a = actions[Number(btn.dataset.act)];
      if (a.run) {
        btn.classList.add('is-busy');
        let keep;
        try { keep = await a.run(d, btn); } catch (err) { GP.errorToast(err); keep = false; } finally { btn.classList.remove('is-busy'); }
        if (keep === false) return;
      }
      result = a.value;
      d.close();
    }, { signal: ac.signal });
    d.addEventListener('close', () => { ac.abort(); resolve(result); }, { once: true });
    d.showModal();
    if (onOpen) onOpen(d);
  });

  GP.confirm = ({ title, message, confirmLabel = 'Confirm', danger = false }) =>
    GP.dialog({
      title, body: html`<p>${message}</p>`,
      actions: [{ label: 'Cancel', value: false }, { label: confirmLabel, kind: danger ? 'danger' : 'primary', value: true }],
    }).then((v) => v === true);

  // ---------------------------------------------------------------- forms
  GP.clearErrors = (root) => {
    $$('.field.has-error', root).forEach((f) => f.classList.remove('has-error'));
    $$('.field .error', root).forEach((n) => n.remove());
    $$('[aria-invalid]', root).forEach((n) => n.removeAttribute('aria-invalid'));
  };
  // Shows server validation errors [{field, message}] under the matching [data-field] wrappers.
  GP.showErrors = (root, errors) => {
    GP.clearErrors(root);
    let first = null; const unmatched = [];
    (errors || []).forEach((e, i) => {
      const wrap = $(`[data-field="${CSS.escape(e.field)}"]`, root);
      if (!wrap) { unmatched.push(e.message); return; }
      wrap.classList.add('has-error');
      const id = `err-${e.field}-${i}`;
      const msg = document.createElement('div');
      msg.className = 'error'; msg.id = id; msg.textContent = e.message;
      wrap.appendChild(msg);
      const input = $('input, select', wrap);
      if (input) { input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', id); if (!first) first = input; }
    });
    if (first) first.focus();
    return unmatched;
  };
  GP.withBusy = async (btn, fn) => {
    btn.classList.add('is-busy'); btn.disabled = true;
    try { return await fn(); } finally { btn.classList.remove('is-busy'); btn.disabled = false; }
  };

  // ---------------------------------------------------------------- files
  GP.download = (filename, text, mime = 'text/plain') => {
    const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
    const a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  // CSV with formula-injection protection: a text cell starting with = + - @ would run as a formula in Excel.
  GP.csvCell = (v) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  GP.toCSV = (headers, rows) => [headers.join(','), ...rows.map((r) => r.map(GP.csvCell).join(','))].join('\r\n');

  // ---------------------------------------------------------------- theme
  GP.setTheme = (t) => {
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('gp_theme', t); } catch { /* private mode */ }
  };
  GP.theme = () => document.documentElement.getAttribute('data-theme') || 'dark';

  // ---------------------------------------------------------------- shared UI bits
  GP.skeleton = (tiles = true) => html`${tiles ? html`<div class="sk-tiles"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>` : ''}<div class="skeleton skel-block"></div>`;
  GP.emptyState = (icon, text) => html`<div class="empty">${GP.icon(icon)}${text}</div>`;
  GP.bar = (value, max, cls = '') => html`<progress class="${cls}" value="${value}" max="${Math.max(max, 1)}"></progress>`;
  GP.errorCard = (e, retryId = 'retry') => html`<div class="card"><div class="banner bad">${GP.icon('circle-alert')}<div>${e.message}</div></div><button class="btn" id="${retryId}">${GP.icon('refresh-cw')} Try again</button></div>`;
})();
