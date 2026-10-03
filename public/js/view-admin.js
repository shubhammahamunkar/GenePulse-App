/* Account (everyone) and admin pages: users, audit log, archive. */
(function () {
  'use strict';
  const { html, icon, $, $$ } = GP;

  // ------------------------------------------------------------ password form (also used for the forced first-login change)
  GP.passwordForm = (root, { forced = false, onDone } = {}) => {
    GP.setHtml(root, html`<form id="pw-form" novalidate class="stack">
      <div class="field" data-field="currentPassword"><label for="pw-cur">Current password</label>
        <input id="pw-cur" type="password" autocomplete="current-password" required></div>
      <div class="field" data-field="newPassword"><label for="pw-new">New password</label>
        <input id="pw-new" type="password" autocomplete="new-password" minlength="12" required>
        <ul class="req-list"><li>At least 12 characters</li><li>Different from the current password</li><li>Must not contain your username</li></ul></div>
      <div class="field" data-field="confirm"><label for="pw-conf">Repeat new password</label>
        <input id="pw-conf" type="password" autocomplete="new-password" required></div>
      <button class="btn btn-primary" type="submit">${icon('key-round')} ${forced ? 'Set password and continue' : 'Change password'}</button>
    </form>`);
    const form = $('#pw-form', root);
    form.onsubmit = async (e) => {
      e.preventDefault();
      GP.clearErrors(form);
      const cur = $('#pw-cur', form).value; const next = $('#pw-new', form).value;
      if (next !== $('#pw-conf', form).value) { GP.showErrors(form, [{ field: 'confirm', message: 'The two new passwords do not match.' }]); return; }
      await GP.withBusy($('button[type=submit]', form), async () => {
        try {
          await GP.api('POST', '/api/auth/change-password', { currentPassword: cur, newPassword: next }, { quiet: true });
          form.reset();
          GP.toast('Password changed.', 'ok');
          if (onDone) onDone();
        } catch (err) {
          const left = err.errors ? GP.showErrors(form, err.errors) : [err.message];
          if (left.length) GP.toast(left[0], 'err');
        }
      });
    };
  };

  function renderAccount(el) {
    const u = GP.state.user;
    GP.setHtml(el, html`<div class="view-enter two-col">
      <section class="card"><div class="card-head"><h2>${icon('user-cog')} Your account</h2></div>
        <div class="kv"><span>Username</span><strong>${u.username}</strong></div>
        <div class="kv"><span>Role</span><strong>${u.role}</strong></div>
        <p class="muted hint">admin = everything &middot; staff = register, edit, match &middot; viewer = read-only with masked phone numbers.</p></section>
      <section class="card"><div class="card-head"><h2>${icon('lock')} Change password</h2></div><div id="pw-root"></div></section>
    </div>`);
    GP.passwordForm($('#pw-root', el));
  }

  // ------------------------------------------------------------ users (admin)
  const ROLES = ['viewer', 'staff', 'admin'];

  async function renderUsers(el) {
    GP.setHtml(el, GP.skeleton(false));
    let users;
    try { users = (await GP.api('GET', '/api/admin/users')).users; } catch (e) {
      GP.setHtml(el, GP.errorCard(e)); $('#retry', el).onclick = () => renderUsers(el); return;
    }
    const me = GP.state.user.username;
    GP.setHtml(el, html`<div class="view-enter"><section class="card">
      <div class="card-head"><h2>${icon('users')} Staff accounts</h2><span class="spacer"></span>
        <button class="btn btn-sm btn-primary" id="u-add">${icon('plus')} Add user</button></div>
      <div class="table-wrap" tabindex="0" role="region" aria-label="Users"><table>
        <thead><tr><th>Username</th><th>Role</th><th>Status</th><th>Last login</th><th><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${users.map((u) => html`<tr>
          <td><strong>${u.username}</strong>${u.username === me ? html` <span class="chip info">you</span>` : ''}</td>
          <td><span class="chip ${u.role === 'admin' ? 'violet' : u.role === 'staff' ? 'info' : ''}">${u.role}</span></td>
          <td>${u.active ? html`<span class="chip good">Active</span>` : html`<span class="chip bad">Disabled</span>`}
            ${u.locked ? html` <span class="chip warn">${icon('lock')} Locked</span>` : ''}
            ${u.mustChangePassword ? html` <span class="chip warn">Must change password</span>` : ''}</td>
          <td class="muted">${GP.fmtDateTime(u.lastLogin)}</td>
          <td><div class="row">
            <button class="btn btn-ghost btn-sm" data-act="role" data-id="${u.id}" data-u="${u.username}" data-role="${u.role}">Role</button>
            <button class="btn btn-ghost btn-sm" data-act="reset" data-id="${u.id}" data-u="${u.username}">Reset password</button>
            ${u.locked ? html`<button class="btn btn-ghost btn-sm" data-act="unlock" data-id="${u.id}">Unlock</button>` : ''}
            ${u.username !== me ? html`<button class="btn btn-ghost btn-sm" data-act="${u.active ? 'disable' : 'enable'}" data-id="${u.id}" data-u="${u.username}">${u.active ? 'Disable' : 'Enable'}</button>` : ''}
          </div></td></tr>`)}</tbody></table></div>
      <p class="muted hint">New and reset passwords are temporary: the person must choose their own at first sign-in. Disabling an account signs it out immediately.</p>
    </section></div>`);

    const patch = async (id, body, msg) => {
      try { await GP.api('PATCH', `/api/admin/users/${id}`, body); GP.toast(msg, 'ok'); renderUsers(el); } catch (e) { GP.errorToast(e); }
    };

    $('#u-add', el).onclick = () => GP.dialog({
      title: 'Add user',
      body: html`<form id="u-form" novalidate class="stack">
        <div class="field" data-field="username"><label for="nu-name">Username</label><input id="nu-name" autocomplete="off" autocapitalize="none" required></div>
        <div class="field" data-field="password"><label for="nu-pass">Temporary password</label><input id="nu-pass" type="text" autocomplete="off" required><p class="muted hint">At least 12 characters. Share it privately.</p></div>
        <div class="field" data-field="role"><label for="nu-role">Role</label><select id="nu-role">${ROLES.map((r) => html`<option ${r === 'staff' ? 'selected' : ''}>${r}</option>`)}</select></div></form>`,
      actions: [{ label: 'Cancel', value: false }, {
        label: 'Create user', kind: 'primary', value: true,
        run: async (d) => {
          GP.clearErrors(d);
          try {
            await GP.api('POST', '/api/admin/users', { username: $('#nu-name', d).value, password: $('#nu-pass', d).value, role: $('#nu-role', d).value });
          } catch (e) { const left = e.errors ? GP.showErrors(d, e.errors) : [e.message]; if (left.length) GP.toast(left[0], 'err'); return false; }
        },
      }],
    }).then((ok) => { if (ok) { GP.toast('User created.', 'ok'); renderUsers(el); } });

    el.onclick = async (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const { act, id, u } = b.dataset;
      if (act === 'unlock') return patch(id, { unlock: true }, 'Account unlocked.');
      if (act === 'enable') return patch(id, { active: true }, 'Account enabled.');
      if (act === 'disable') {
        if (await GP.confirm({ title: 'Disable account?', message: `${u} will be signed out and unable to sign in.`, confirmLabel: 'Disable', danger: true })) patch(id, { active: false }, 'Account disabled.');
        return;
      }
      if (act === 'role') {
        const role = await GP.dialog({
          title: `Role for ${u}`,
          body: html`<div class="seg" role="radiogroup" aria-label="Role">${ROLES.map((r) => html`<label><input type="radio" name="r" value="${r}" ${r === b.dataset.role ? 'checked' : ''}><span>${r}</span></label>`)}</div>`,
          actions: [{ label: 'Cancel', value: null }, { label: 'Save', kind: 'primary', run: (d) => { d.dataset.pick = $('input[name=r]:checked', d).value; } }],
          onOpen: () => {},
        });
        const picked = $('#dlg').dataset.pick;
        $('#dlg').dataset.pick = '';
        if (role !== null && picked && picked !== b.dataset.role) patch(id, { role: picked }, 'Role updated.');
        return;
      }
      if (act === 'reset') {
        const ok = await GP.dialog({
          title: `Reset password for ${u}`,
          body: html`<div class="field" data-field="newPassword"><label for="rp">Temporary password</label><input id="rp" type="text" autocomplete="off"><p class="muted hint">At least 12 characters. ${u} must change it at next sign-in.</p></div>`,
          actions: [{ label: 'Cancel', value: false }, {
            label: 'Reset', kind: 'primary', value: true,
            run: async (d) => {
              GP.clearErrors(d);
              try { await GP.api('PATCH', `/api/admin/users/${id}`, { newPassword: $('#rp', d).value }); } catch (err) { const left = err.errors ? GP.showErrors(d, err.errors) : [err.message]; if (left.length) GP.toast(left[0], 'err'); return false; }
            },
          }],
        });
        if (ok) { GP.toast('Password reset. Share the temporary password privately.', 'ok'); renderUsers(el); }
      }
    };
  }

  // ------------------------------------------------------------ audit log (admin)
  const ACTIONS = ['login', 'login_failed', 'account_locked', 'password_changed', 'user_created', 'user_updated', 'patient_created', 'patient_updated', 'donation_recorded', 'patients_imported', 'patient_archived', 'patient_restored', 'patient_deleted_permanently'];
  const PAGE = 50;

  async function renderAudit(el, state = { offset: 0, action: '' }) {
    GP.setHtml(el, GP.skeleton(false));
    let data;
    try { data = await GP.api('GET', `/api/admin/audit?limit=${PAGE}&offset=${state.offset}${state.action ? '&action=' + encodeURIComponent(state.action) : ''}`); } catch (e) {
      GP.setHtml(el, GP.errorCard(e)); $('#retry', el).onclick = () => renderAudit(el, state); return;
    }
    const meta = (m) => (m && Object.keys(m).length ? Object.entries(m).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join(' · ') : '');
    GP.setHtml(el, html`<div class="view-enter"><section class="card">
      <div class="card-head"><h2>${icon('scroll-text')} Audit log</h2><span class="spacer"></span>
        <div class="field m0"><label class="sr-only" for="a-filter">Filter by action</label>
          <select id="a-filter"><option value="">All actions</option>${ACTIONS.map((a) => html`<option ${a === state.action ? 'selected' : ''}>${a}</option>`)}</select></div></div>
      <p class="muted hint">Records who did what and when. It stores record IDs and field names only, never names, phone numbers or lab values.</p>
      <div class="table-wrap" tabindex="0" role="region" aria-label="Audit entries"><table>
        <thead><tr><th>When</th><th>User</th><th>Action</th><th>Record</th><th>Details</th><th>IP</th></tr></thead>
        <tbody>${data.entries.length ? data.entries.map((a) => html`<tr>
          <td class="muted">${GP.fmtDateTime(a.ts)}</td><td>${a.username || '-'}</td><td><span class="chip">${a.action}</span></td>
          <td class="mono">${a.entity_id || '-'}</td><td class="muted">${meta(a.meta)}</td><td class="mono muted">${a.ip || ''}</td></tr>`)
          : html`<tr><td colspan="6">${GP.emptyState('scroll-text', 'No entries.')}</td></tr>`}</tbody></table></div>
      <div class="pager"><span>${data.total ? `${state.offset + 1}-${Math.min(state.offset + PAGE, data.total)} of ${data.total}` : '0 entries'}</span>
        <span class="row"><button class="btn btn-ghost btn-sm" id="a-prev" ${state.offset === 0 ? 'disabled' : ''}>${icon('chevron-left')} Newer</button>
        <button class="btn btn-ghost btn-sm" id="a-next" ${state.offset + PAGE >= data.total ? 'disabled' : ''}>Older ${icon('chevron-right')}</button></span></div>
    </section></div>`);
    $('#a-filter', el).onchange = (e) => renderAudit(el, { offset: 0, action: e.target.value });
    $('#a-prev', el).onclick = () => renderAudit(el, { ...state, offset: Math.max(0, state.offset - PAGE) });
    $('#a-next', el).onclick = () => renderAudit(el, { ...state, offset: state.offset + PAGE });
  }

  // ------------------------------------------------------------ archive (admin)
  async function renderArchive(el) {
    GP.setHtml(el, GP.skeleton(false));
    let list;
    try { list = (await GP.api('GET', '/api/patients?archived=1')).patients; } catch (e) {
      GP.setHtml(el, GP.errorCard(e)); $('#retry', el).onclick = () => renderArchive(el); return;
    }
    GP.setHtml(el, html`<div class="view-enter"><section class="card">
      <div class="card-head"><h2>${icon('archive')} Archive</h2></div>
      <p class="muted hint">Archived records are hidden everywhere and never matched. Restore them, or delete them permanently (this cannot be undone).</p>
      ${list.length ? list.map((p) => html`<div class="donor-row">
        <div class="who"><strong>${p.name}</strong><div class="muted mono">${p.id}</div></div>${GP.bgBadge(p.bloodGroup)}
        <button class="btn btn-ghost btn-sm" data-restore="${p.id}">${icon('archive-restore')} Restore</button>
        <button class="btn btn-danger btn-sm" data-del="${p.id}" data-name="${p.name}">${icon('trash-2')} Delete forever</button></div>`)
        : GP.emptyState('archive', 'The archive is empty.')}
    </section></div>`);
    el.onclick = async (e) => {
      const r = e.target.closest('[data-restore]'); const d = e.target.closest('[data-del]');
      try {
        if (r) { await GP.api('POST', `/api/patients/${encodeURIComponent(r.dataset.restore)}/restore`); GP.invalidate(); GP.toast('Record restored.', 'ok'); renderArchive(el); }
        if (d && await GP.confirm({ title: 'Delete permanently?', message: `${d.dataset.name} (${d.dataset.del}) will be erased and cannot be recovered.`, confirmLabel: 'Delete forever', danger: true })) {
          await GP.api('DELETE', `/api/patients/${encodeURIComponent(d.dataset.del)}?permanent=1`); GP.invalidate(); GP.toast('Record deleted.', 'ok'); renderArchive(el);
        }
      } catch (err) { GP.errorToast(err); }
    };
  }

  GP.views.account = { title: 'Account', render: renderAccount };
  GP.views.users = { title: 'Users', render: renderUsers, admin: true };
  GP.views.audit = { title: 'Audit log', render: (el) => renderAudit(el), admin: true };
  GP.views.archive = { title: 'Archive', render: renderArchive, admin: true };
})();
