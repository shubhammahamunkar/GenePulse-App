(function () {
  'use strict';
  const { html, icon, $ } = GP;

  const AGE_ORDER = ['0-17', '18-30', '31-45', '46-65', '66+'];

  function barRows(obj, order, cls = '') {
    const keys = (order || Object.keys(obj)).filter((k) => obj[k]);
    if (!keys.length) return html`<p class="muted">No data yet.</p>`;
    const max = Math.max(...keys.map((k) => obj[k]));
    return keys.map((k) => html`<div class="bar-row wide"><span>${k}</span>${GP.bar(obj[k], max, cls)}<span class="v">${obj[k]}</span></div>`);
  }

  async function render(el) {
    GP.setHtml(el, GP.skeleton());
    let s;
    try {
      s = await GP.api('GET', '/api/stats');
    } catch (e) {
      GP.setHtml(el, GP.errorCard(e));
      $('#retry', el).onclick = () => render(el);
      return;
    }
    GP.state.stats = s;
    const max = Math.max(1, ...s.bloodGroups.map((b) => Math.max(b.donors, b.requests)));
    const tone = (n, bad) => (n > 0 ? bad : 'good');

    GP.setHtml(el, html`
      <div class="view-enter">
        ${s.shortages.length ? html`<div class="banner bad" role="alert">${icon('triangle-alert')}<div>
          <strong>Possible blood shortage.</strong> More pending requests than eligible compatible donors for:
          <strong>${s.shortages.join(', ')}</strong>. <a href="#/blood">Open blood matching</a></div></div>` : ''}
        ${s.noConsent > 0 ? html`<div class="banner warn">${icon('shield-check')}<div>
          <strong>${GP.plural(s.noConsent, 'record')}</strong> without consent on file. They are never offered as donors.
          Confirm consent on each record (Directory &rarr; Edit).</div></div>` : ''}

        <div class="tiles">
          <div class="tile info"><div class="n">${s.total}</div><div class="l">Registered</div></div>
          <div class="tile good"><div class="n">${s.eligibleDonors}</div><div class="l">Eligible donors</div></div>
          <div class="tile ${tone(s.needBlood, 'bad')}"><div class="n">${s.needBlood}</div><div class="l">Need blood</div></div>
          <div class="tile ${tone(s.needOrgan, 'warn')}"><div class="n">${s.needOrgan}</div><div class="l">Need organ</div></div>
          <div class="tile ${tone(s.flagged, 'warn')}"><div class="n">${s.flagged}</div><div class="l">Abnormal values</div></div>
          <div class="tile"><div class="n">${s.averageAge ?? '-'}</div><div class="l">Average age</div></div>
        </div>

        <section class="card" aria-labelledby="h-supply">
          <div class="card-head"><h2 id="h-supply">${icon('droplet')} Supply vs demand</h2><span class="spacer"></span>
            ${GP.canWrite() ? html`<a class="btn btn-sm" href="#/register">${icon('user-plus')} Register donor</a>` : ''}</div>
          <div class="table-wrap" tabindex="0" role="region" aria-label="Blood group supply and demand">
            <table class="gb-table">
              <thead><tr><th>Group</th><th>Eligible donors</th><th>Requests</th><th>Compatible supply</th><th>Status</th></tr></thead>
              <tbody>${s.bloodGroups.map((b) => html`<tr>
                <td>${GP.bgBadge(b.group)}</td>
                <td><div class="gb-bars">${GP.bar(b.donors, max, 'good')}<span class="muted mono">${b.donors}</span></div></td>
                <td><div class="gb-bars">${GP.bar(b.requests, max, 'bad')}<span class="muted mono">${b.requests}</span></div></td>
                <td class="mono">${b.compatibleSupply}</td>
                <td>${b.shortage ? html`<span class="chip bad">${icon('triangle-alert')} Shortage</span>`
                  : b.requests ? html`<span class="chip good">${icon('circle-check')} Covered</span>` : html`<span class="chip">No requests</span>`}</td>
              </tr>`)}</tbody>
            </table>
          </div>
          <p class="muted hint">"Compatible supply" = eligible donors whose group can give to this group (ABO/Rh). Screening aid only - final cross-matching is done by the lab.</p>
        </section>

        <div class="two-col">
          <section class="card" aria-labelledby="h-flags">
            <div class="card-head"><h2 id="h-flags">${icon('activity')} Abnormal values</h2></div>
            ${barRows(s.flagCounts, null, 'warn')}
          </section>
          <section class="card" aria-labelledby="h-age">
            <div class="card-head"><h2 id="h-age">${icon('users')} Age groups</h2></div>
            ${barRows(s.ageGroups, AGE_ORDER)}
            <div class="card-head"><h2 class="muted">Sex</h2></div>
            ${barRows(s.sexes, null, 'violet')}
          </section>
          <section class="card" aria-labelledby="h-organ">
            <div class="card-head"><h2 id="h-organ">${icon('heart-pulse')} Organ requests</h2></div>
            ${barRows(s.organNeeds, null, 'bad')}
            <div class="card-head"><h2 class="muted">Record source</h2></div>
            ${barRows(s.sources)}
          </section>
          <section class="card" aria-labelledby="h-recent">
            <div class="card-head"><h2 id="h-recent">${icon('clock')} Recently added</h2></div>
            ${s.recent.length ? s.recent.map((r) => html`<div class="donor-row">
              <div class="who"><strong>${r.name}</strong><div class="muted mono">${r.id} &middot; ${GP.fmtDateTime(r.createdAt)}</div></div>
              ${GP.bgBadge(r.bloodGroup)}
              <button class="btn btn-ghost btn-sm" data-open="${r.id}">${icon('qr-code')} Card</button></div>`)
              : GP.emptyState('users', 'No registrations yet.')}
          </section>
        </div>
      </div>`);

    el.onclick = (e) => {
      const b = e.target.closest('[data-open]');
      if (b) GP.openCard(b.dataset.open);
    };
  }

  GP.views.dashboard = { title: 'Dashboard', render };
})();
