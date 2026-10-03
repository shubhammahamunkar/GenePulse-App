/* App shell: boot, sign-in, forced password change, sidebar, hash router, connection indicator. */
(function () {
  'use strict';
  const { html, icon, $, $$ } = GP;

  const NAV = [
    { group: 'Overview', items: [{ id: 'dashboard', label: 'Dashboard', icon: 'layout-dashboard' }] },
    { group: 'Registry', items: [
      { id: 'directory', label: 'Directory', icon: 'users' },
      { id: 'register', label: 'Register donor', icon: 'user-plus', write: true },
      { id: 'data', label: 'Import & export', icon: 'file-spreadsheet' },
    ] },
    { group: 'Matching', items: [
      { id: 'blood', label: 'Blood matching', icon: 'droplet' },
      { id: 'organ', label: 'Organ matching', icon: 'heart-pulse' },
      { id: 'kinship', label: 'DNA kinship', icon: 'network' },
    ] },
    { group: 'Admin', admin: true, items: [
      { id: 'users', label: 'Users', icon: 'user-cog' },
      { id: 'audit', label: 'Audit log', icon: 'scroll-text' },
      { id: 'archive', label: 'Archive', icon: 'archive' },
    ] },
  ];

  const boot = $('#boot'); const authRoot = $('#auth-root'); const shell = $('#shell');
  let healthTimer = null;

  function show(which) {
    boot.hidden = which !== 'boot';
    authRoot.hidden = which !== 'auth';
    shell.hidden = which !== 'shell';
  }

  // ------------------------------------------------------------ connection indicator
  async function pingHealth() {
    const c = $('#conn');
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      c.dataset.state = res.ok ? 'ok' : 'down';
      $('.conn-text', c).textContent = res.ok ? 'Online' : 'Server problem';
    } catch { c.dataset.state = 'down'; $('.conn-text', c).textContent = 'Offline'; }
  }

  // ------------------------------------------------------------ auth screens
  const brand = (sub) => html`<div class="auth-brand"><div class="brand-mark">${icon('dna')}</div><h1>GenePulse</h1><p>${sub}</p></div>`;

  function showLogin(notice) {
    stopApp();
    show('auth');
    GP.setHtml(authRoot, html`<div class="auth"><div class="auth-card card view-enter">
      ${brand('Blood & organ donor registry')}
      ${notice ? html`<div class="banner warn" role="status">${icon('clock')}<div>${notice}</div></div>` : ''}
      <form id="login-form" class="stack" novalidate>
        <div class="field"><label for="l-user">Username</label>
          <input id="l-user" autocomplete="username" autocapitalize="none" spellcheck="false" required></div>
        <div class="field"><label for="l-pass">Password</label>
          <div class="pw-wrap"><input id="l-pass" type="password" autocomplete="current-password" required>
            <button class="btn btn-ghost btn-icon" type="button" id="l-eye" aria-label="Show password">${icon('eye')}</button></div></div>
        <div class="banner bad" id="l-err" role="alert" hidden></div>
        <button class="btn btn-primary btn-block" type="submit">${icon('lock')} Sign in</button>
      </form>
      <p class="muted hint center mt-14">Research prototype. Blood and DNA values are simulated unless marked otherwise.</p>
    </div></div>`);
    const form = $('#login-form', authRoot);
    $('#l-user', authRoot).focus();
    $('#l-eye', authRoot).onclick = () => {
      const i = $('#l-pass', authRoot); const on = i.type === 'password';
      i.type = on ? 'text' : 'password';
      $('#l-eye', authRoot).setAttribute('aria-label', on ? 'Hide password' : 'Show password');
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const err = $('#l-err', authRoot); err.hidden = true;
      await GP.withBusy($('button[type=submit]', form), async () => {
        try {
          const { user } = await GP.api('POST', '/api/auth/login', { username: $('#l-user', form).value, password: $('#l-pass', form).value }, { quiet: true });
          enter(user);
        } catch (ex) {
          setHtmlSafe(err, ex.message); err.hidden = false;
          $('#l-pass', form).value = '';
        }
      });
    };
  }
  const setHtmlSafe = (el, text) => GP.setHtml(el, html`${icon('circle-alert')}<div>${text}</div>`);

  function showForcedChange() {
    stopApp();
    show('auth');
    GP.setHtml(authRoot, html`<div class="auth"><div class="auth-card card view-enter">
      ${brand('Choose your own password to continue')}
      <div class="banner info">${icon('shield-check')}<div>Your password was set by an administrator. Pick a new one that only you know.</div></div>
      <div id="forced-root"></div>
      <p class="center mt-14"><button class="btn btn-ghost btn-sm" id="forced-out">${icon('log-out')} Sign out</button></p>
    </div></div>`);
    GP.passwordForm($('#forced-root', authRoot), { forced: true, onDone: async () => {
      try { enter((await GP.api('GET', '/api/auth/me')).user); } catch { showLogin(); }
    } });
    $('#forced-out', authRoot).onclick = logout;
  }

  async function logout() {
    try { await GP.api('POST', '/api/auth/logout', {}, { quiet: true }); } catch { /* cookie may already be gone */ }
    GP.state.user = null; GP.invalidate();
    showLogin();
  }

  GP.hooks.onSessionLost = () => { if (GP.state.user) { GP.state.user = null; showLogin('Your session ended. Please sign in again.'); } };
  GP.hooks.onPasswordChange = () => showForcedChange();

  // ------------------------------------------------------------ shell
  function enter(user) {
    GP.state.user = user;
    GP.invalidate();
    if (user.mustChangePassword) { showForcedChange(); return; }
    show('shell');
    buildSidebar();
    pingHealth(); clearInterval(healthTimer); healthTimer = setInterval(pingHealth, 30000);
    if (!location.hash || location.hash === '#/' || location.hash === '#') location.hash = '#/dashboard';
    route();
  }
  function stopApp() { clearInterval(healthTimer); document.body.classList.remove('nav-open'); }

  function visibleNav() {
    return NAV.filter((g) => !g.admin || GP.can('admin'))
      .map((g) => ({ ...g, items: g.items.filter((i) => !i.write || GP.canWrite()) }))
      .filter((g) => g.items.length);
  }

  function buildSidebar() {
    const u = GP.state.user;
    GP.setHtml($('#sidebar'), html`
      <div class="brand"><div class="brand-mark">${icon('dna')}</div><div><div class="brand-name">GenePulse</div><div class="brand-sub">DONOR REGISTRY</div></div></div>
      <nav aria-label="Primary">
        ${visibleNav().map((g) => html`<div class="nav-group">${g.group}</div>${g.items.map((i) => html`<a class="nav-link" href="#/${i.id}" data-nav="${i.id}">${icon(i.icon)}<span>${i.label}</span></a>`)}`)}
      </nav>
      <div class="sidebar-foot">
        <a class="user-chip nav-link" href="#/account" data-nav="account" aria-label="Your account"><span class="avatar">${GP.initials(u.username)}</span>
          <span><div class="user-name">${u.username}</div><div class="user-role">${u.role}</div></span></a>
        <button class="nav-link" id="theme-btn" type="button">${icon(GP.theme() === 'dark' ? 'sun' : 'moon')}<span>${GP.theme() === 'dark' ? 'Light theme' : 'Dark theme'}</span></button>
        <button class="nav-link" id="logout-btn" type="button">${icon('log-out')}<span>Sign out</span></button>
      </div>`);
    $('#theme-btn').onclick = () => { GP.setTheme(GP.theme() === 'dark' ? 'light' : 'dark'); buildSidebar(); markNav(); };
    $('#logout-btn').onclick = logout;
  }

  function markNav() {
    const cur = (location.hash.replace(/^#\//, '').split('/')[0]) || 'dashboard';
    const active = cur === 'patient' ? 'directory' : cur;
    $$('[data-nav]').forEach((a) => (a.dataset.nav === active ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  }

  // ------------------------------------------------------------ router
  let routeSeq = 0;
  function route() {
    if (!GP.state.user || GP.state.user.mustChangePassword) return;
    const [name = 'dashboard', arg] = (location.hash.replace(/^#\//, '') || 'dashboard').split('/');
    document.body.classList.remove('nav-open'); $('#menuBtn').setAttribute('aria-expanded', 'false');
    const main = $('#main');

    if (name === 'patient' && arg) { // deep link from a QR code: open the card on top of the directory
      location.replace('#/directory');
      GP.openCard(decodeURIComponent(arg));
      return;
    }
    const view = GP.views[name];
    if (!view || (view.admin && !GP.can('admin')) || (name === 'register' && !GP.canWrite())) {
      GP.setHtml(main, html`<div class="card view-enter">${GP.emptyState('circle-alert', 'That page does not exist or you do not have access to it.')}
        <p class="center"><a class="btn btn-primary" href="#/dashboard">Go to dashboard</a></p></div>`);
      $('#pageTitle').textContent = 'Not found'; markNav(); return;
    }
    const seq = ++routeSeq;
    const host = document.createElement('div');
    main.replaceChildren(host); // a slow view that finishes after the user moved on writes into a detached node
    $('#pageTitle').textContent = name === 'register' && arg ? 'Edit record' : view.title;
    document.title = `${view.title} - GenePulse`;
    markNav();
    try {
      const out = view.render(host, arg ? decodeURIComponent(arg) : undefined);
      if (out && out.catch) out.catch((e) => { if (seq === routeSeq) GP.setHtml(host, GP.errorCard(e)); });
    } catch (e) { GP.setHtml(host, GP.errorCard(e)); }
    window.scrollTo(0, 0);
  }

  window.addEventListener('hashchange', route);
  $('#menuBtn').onclick = () => {
    const open = document.body.classList.toggle('nav-open');
    $('#menuBtn').setAttribute('aria-expanded', String(open));
  };
  $('#backdrop').onclick = () => { document.body.classList.remove('nav-open'); $('#menuBtn').setAttribute('aria-expanded', 'false'); };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.body.classList.remove('nav-open'); });

  // ------------------------------------------------------------ start
  (async function start() {
    try {
      const { user } = await GP.api('GET', '/api/auth/me', undefined, { quiet: true });
      enter(user);
    } catch (e) {
      if (e.status === 401) showLogin();
      else {
        show('auth');
        GP.setHtml(authRoot, html`<div class="auth"><div class="auth-card card">${brand('Cannot reach the server')}${GP.errorCard(e)}</div></div>`);
        $('#retry', authRoot).onclick = () => location.reload();
      }
    }
  })();
})();
