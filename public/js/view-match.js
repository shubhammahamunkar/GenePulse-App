/* Matching views: blood (ABO/Rh), organ (heuristic index) and kinship graph (heuristic STR comparison). */
(function () {
  'use strict';
  const { html, icon, $, $$ } = GP;

  function daysWaiting(iso) {
    const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    return Number.isFinite(d) && d >= 0 ? d : 0;
  }

  async function load(el, path, draw) {
    GP.setHtml(el, GP.skeleton(false));
    try {
      const data = await GP.api('GET', path);
      draw(data);
    } catch (e) {
      GP.setHtml(el, GP.errorCard(e));
      $('#retry', el).onclick = () => load(el, path, draw);
    }
  }

  // -------------------------------------------------------------- blood
  function renderBlood(el) {
    load(el, '/api/match/blood', ({ recipients }) => {
      if (!recipients.length) {
        GP.setHtml(el, html`<div class="view-enter card">${GP.emptyState('droplet', 'Nobody is waiting for blood right now. Mark a record as "Needs a blood transfusion" and it appears here.')}</div>`);
        return;
      }
      GP.setHtml(el, html`<div class="view-enter">
        <div class="banner info">${icon('info')}<div>Compatibility follows standard ABO/Rh rules. Only donors with consent, a recorded hemoglobin, an allowed age and a respected donation interval are marked <strong>eligible</strong>. This is a screening aid; the blood bank still does the final cross-match.</div></div>
        ${recipients.map((r, i) => {
          const rec = r.recipient;
          const eligible = r.donors.filter((d) => d.eligible);
          const rest = r.donors.filter((d) => !d.eligible);
          const row = (d) => html`<div class="donor-row">
            <div class="who"><strong>${d.name}</strong>
              <div class="muted mono">${d.id}${d.lastDonated ? html` &middot; last gave ${GP.fmtDay(d.lastDonated)}` : ''}</div></div>
            ${GP.bgBadge(d.bloodGroup)}
            ${d.exact ? html`<span class="chip good">Exact match</span>` : ''}
            ${d.eligible ? html`<span class="chip good">${icon('circle-check')} Eligible</span>`
              : html`<span class="chip warn" title="${d.reasons.join('; ')}">${icon('clock')} ${d.reasons[0] || 'Not eligible'}</span>`}
            ${d.eligible ? GP.phoneActions(d.phone, `Hello ${d.name}, GenePulse here. A patient needs ${rec.bloodGroup}-compatible blood. Could you donate?`) : ''}
            <button class="btn btn-ghost btn-sm" data-open="${d.id}">${icon('qr-code')} Card</button></div>`;
          return html`<section class="match-card" aria-label="Matches for ${rec.name}">
            <div class="row between">
              <div class="row"><strong>${rec.name}</strong> ${GP.bgBadge(rec.bloodGroup)}
                <span class="muted">${rec.age != null ? rec.age + ' y' : ''}${rec.sex !== 'Unknown' ? html` &middot; ${rec.sex}` : ''}</span></div>
              <span class="chip ${r.eligibleCount ? 'good' : 'bad'}">${r.eligibleCount} eligible of ${r.compatibleCount} compatible</span>
            </div>
            <p class="muted mono">${rec.id} &middot; waiting ${GP.plural(daysWaiting(rec.createdAt), 'day')}</p>
            ${r.eligibleCount === 0 ? html`<div class="banner bad">${icon('triangle-alert')}<div>No eligible compatible donor in the registry. Contact the blood bank or organise a camp.</div></div>` : ''}
            ${eligible.slice(0, 6).map(row)}
            ${eligible.length > 6 ? html`<details><summary class="muted">${eligible.length - 6} more eligible</summary>${eligible.slice(6).map(row)}</details>` : ''}
            ${rest.length ? html`<details><summary class="muted">${rest.length} compatible but not eligible now</summary>${rest.map(row)}</details>` : ''}
          </section>`;
        })}
      </div>`);
      el.onclick = (e) => { const b = e.target.closest('[data-open]'); if (b) GP.openCard(b.dataset.open); };
    });
  }

  // -------------------------------------------------------------- organ
  function renderOrgan(el) {
    load(el, '/api/match/organ', ({ recipients }) => {
      if (!recipients.length) {
        GP.setHtml(el, html`<div class="view-enter card">${GP.emptyState('heart-pulse', 'No organ requests recorded.')}</div>`);
        return;
      }
      GP.setHtml(el, html`<div class="view-enter">
        <div class="banner warn">${icon('triangle-alert')}<div><strong>Heuristic index only.</strong> Real organ allocation depends on HLA typing, crossmatch, organ size and urgency, decided by a transplant team. This list ranks consenting adults by blood-group compatibility and the (simulated) STR similarity. Never use it for a clinical decision.</div></div>
        ${recipients.map((r) => {
          const p = r.recipient;
          return html`<section class="match-card">
            <div class="row between"><div class="row"><strong>${p.name}</strong> ${GP.bgBadge(p.bloodGroup)}
              <span class="chip violet">${icon('heart-pulse')} ${p.needsOrgan}</span></div>
              <span class="muted mono">${p.id}</span></div>
            ${r.candidates.length ? r.candidates.map((c) => html`<div class="donor-row">
              <div class="who"><strong>${c.name}</strong><div class="muted mono">${c.id}</div></div>
              ${GP.bgBadge(c.bloodGroup)}
              ${c.exactAbo ? html`<span class="chip good">Same group</span>` : html`<span class="chip">Compatible</span>`}
              ${c.strLoci != null ? html`<span class="chip info">${c.strLoci}/13 STR loci</span>` : ''}
              <span class="chip violet" title="Heuristic index, not a clinical score">Index ${c.index}</span>
              <button class="btn btn-ghost btn-sm" data-open="${c.id}">${icon('qr-code')} Card</button></div>`)
              : html`<p class="muted">No consenting, compatible candidates in the registry.</p>`}
          </section>`;
        })}
      </div>`);
      el.onclick = (e) => { const b = e.target.closest('[data-open]'); if (b) GP.openCard(b.dataset.open); };
    });
  }

  // -------------------------------------------------------------- kinship
  const KIND = { parent: 'Parent-child', sibling: 'Sibling', distant: 'Distant relative' };

  function renderKinship(el) {
    load(el, '/api/kinship?limit=80', (g) => {
      const byId = new Map(g.nodes.map((n) => [n.id, n]));
      const linkedIds = [...new Set(g.edges.flatMap((e) => [e.a, e.b]))];
      const nodes = linkedIds.map((id) => byId.get(id)).filter(Boolean);
      const W = 640; const H = 520; const cx = W / 2; const cy = H / 2; const R = Math.min(W, H) / 2 - 56;
      const pos = new Map(nodes.map((n, i) => {
        const a = (2 * Math.PI * i) / Math.max(nodes.length, 1) - Math.PI / 2;
        return [n.id, { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) }];
      }));
      const short = (name) => (name.length > 14 ? name.slice(0, 13) + '…' : name);

      GP.setHtml(el, html`<div class="view-enter">
        <div class="banner warn">${icon('triangle-alert')}<div><strong>Simulated, heuristic kinship.</strong> Links come from comparing 13 simulated STR markers (&plusmn;1 tolerance). A real parentage or kinship test needs lab-typed alleles and statistical likelihood ratios. Treat these links as a demo of the idea, not as evidence of a relationship.</div></div>
        <section class="card">
          <div class="card-head"><h2>${icon('network')} Family graph</h2><span class="spacer"></span>
            <span class="muted">${GP.plural(nodes.length, 'person', 'people')} linked &middot; ${GP.plural(g.edges.length, 'link')}</span></div>
          ${g.edges.length ? html`
            <svg class="kin-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Estimated relationships between registered people">
              ${g.edges.map((e) => { const a = pos.get(e.a); const b = pos.get(e.b); return a && b ? html`<line class="edge edge-${e.kind}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"><title>${byId.get(e.a).name} - ${byId.get(e.b).name}: ${e.label} (${e.shared}/13)</title></line>` : ''; })}
              ${nodes.map((n) => { const p = pos.get(n.id); return html`<g data-open="${n.id}" tabindex="0" role="button" aria-label="${n.name}" class="kin-node">
                <circle class="node" cx="${p.x}" cy="${p.y}" r="22"/><text class="ini" x="${p.x}" y="${p.y + 4}">${GP.initials(n.name)}</text>
                ${nodes.length <= 24 ? html`<text class="lbl" x="${p.x}" y="${p.y + 40}">${short(n.name)}</text>` : ''}</g>`; })}
            </svg>
            <div class="legend"><span><i class="l-parent"></i>Parent-child (10+ of 13 loci)</span><span><i class="l-sibling"></i>Sibling (8+)</span><span><i class="l-distant"></i>Distant (6+)</span></div>`
            : GP.emptyState('network', 'No related pairs found yet. Register more people with a simulated scan (the scan creates the STR profile).')}
          ${g.truncated ? html`<p class="muted hint">Only the first 80 profiles were compared.</p>` : ''}
        </section>
        ${g.edges.length ? html`<section class="card"><div class="card-head"><h2>${icon('users')} Estimated relationships</h2></div>
          <div class="table-wrap" tabindex="0" role="region" aria-label="Relationship list"><table>
            <thead><tr><th>Person A</th><th>Person B</th><th>Estimate</th><th>Shared loci</th></tr></thead>
            <tbody>${[...g.edges].sort((x, y) => y.shared - x.shared).map((e) => html`<tr>
              <td><button class="btn btn-ghost btn-sm" data-open="${e.a}">${byId.get(e.a).name}</button></td>
              <td><button class="btn btn-ghost btn-sm" data-open="${e.b}">${byId.get(e.b).name}</button></td>
              <td><span class="chip ${e.kind === 'parent' ? 'info' : e.kind === 'sibling' ? 'good' : ''}">${KIND[e.kind] || e.label}</span></td>
              <td class="mono">${e.shared}/13</td></tr>`)}</tbody></table></div></section>` : ''}
      </div>`);
      el.onclick = (e) => { const b = e.target.closest('[data-open]'); if (b) GP.openCard(b.dataset.open); };
      el.onkeydown = (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('g[data-open]')) { e.preventDefault(); GP.openCard(e.target.dataset.open); } };
    });
  }

  GP.views.blood = { title: 'Blood matching', render: renderBlood };
  GP.views.organ = { title: 'Organ matching', render: renderOrgan };
  GP.views.kinship = { title: 'DNA kinship', render: renderKinship };
})();
