/* LuxCraft Cockpit – Jobs, Taxes, Daily, Settings */
// Contract progress bar: paid | billed & unpaid | scheduled.
function drawBar(j) {
  const t = j.contract_total || 0; if (!t) return '';
  const paid = Math.min(100, (j.income / t) * 100); const owed = Math.min(100 - paid, (j.owed / t) * 100);
  return `<div class="progress thin stack" title="${money0(j.income)} paid · ${money0(j.owed)} billed, unpaid · ${money0(j.to_bill)} still to bill"><span style="width:${paid}%"></span><span class="owed" style="width:${owed}%"></span></div>`;
}
// The draw schedule laid out like the invoice: #, description, share, amount, status.
function drawScheduleHtml(j) {
  const st = (d) => d.status === 'paid'
    ? `<span class="chip paid">Paid</span> <span class="note">${d.paid_date ? fmtDate(d.paid_date) : ''}${d.check_no ? ` · check #${esc(d.check_no)}` : ''}${d.note ? esc(d.note.replace(' · ', ' · ')) : ''}</span>`
    : d.status === 'billed'
      ? `<span class="chip ${d.due_date && d.due_date < today() ? 'overdue' : 'open'}">${d.due_date && d.due_date < today() ? 'Overdue' : 'Billed, unpaid'}</span> <span class="note">${fmtDate(d.issue_date)}${d.due_date ? ` · due ${fmtDate(d.due_date)}` : ''}</span>`
      : '<span class="chip">Scheduled</span>';
  const total = j.draws.reduce((a, d) => a + d.amount, 0);
  return `<h3>Draw schedule</h3><div class="table-wrap"><table><thead><tr><th>#</th><th>Description</th><th class="n">Share</th><th class="n">Amount</th><th>Invoice</th><th>Status</th></tr></thead><tbody>
    ${j.draws.map((d) => `<tr><td>${d.n}</td><td>${esc(d.label)}${d.flag ? `<div class="note warn-text">⚠ ${esc(d.flag)}</div>` : ''}</td><td class="n">${d.pct !== null ? `${+d.pct.toFixed(2)}%` : ''}</td>
      <td class="n">${money(d.billed_amount ?? d.amount)}${d.billed_amount && Math.abs(d.billed_amount - d.amount) > 0.005 ? `<div class="note">${money(d.amount)} draw${d.items ? ` + ${money(d.items)} items` : ''}${d.tax ? ` + ${money(d.tax)} tax` : ''}</div>` : ''}</td>
      <td class="mono">${esc(d.invoice_no || '—')}</td><td>${st(d)}</td></tr>`).join('')}
    <tr class="tfoot"><td></td><td>Contract amount</td><td class="n">100%</td><td class="n">${money(total)}</td><td></td><td></td></tr></tbody></table></div>
    <p class="note">Draws count as paid when you mark the invoice Paid in the invoice app, or enter its check # on a later invoice.</p>`;
}
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const subnav = (key, items, cur) => `<div class="subtabs" data-subnav="${key}">${items.map(([v, l]) => `<button type="button" data-v="${v}" class="${cur === v ? 'active' : ''}">${l}</button>`).join('')}</div>`;
function wireSubnav(el, key, fn) { $$(`[data-subnav="${key}"] button`, el).forEach((b) => b.addEventListener('click', () => { state[key] = b.dataset.v; fn(); })); }

// ================= JOBS =================
state.pages.jobs = async function renderJobs() {
  const el = $('#tab-jobs');
  const sub = state.jobsSub || 'jobs';
  const walt = agentInfo('jobs');
  const head = `<div class="page-head"><div><h2>Jobs</h2><div class="sub-title">Tag money, miles and hours to a job to see what it really made per hour.</div></div>
    <div class="row">${sub === 'jobs' ? '<button class="btn" id="jobHours">Log hours</button><button class="btn primary" id="jobNew">New job</button>' : sub === 'crew' ? '<button class="btn primary" id="crewNew">Add person</button>' : ''}</div></div>
    ${subnav('jobsSub', [['jobs', 'Jobs'], ['estimates', 'Estimates'], ['crew', 'Crew & hours']], sub)}`;
  if (sub === 'estimates') return renderEstimates(el, head);
  if (sub === 'crew') return renderCrew(el, head);
  const jobs = await api('/api/jobs');
  const active = jobs.filter((j) => j.status === 'active' && j.from_invoices);
  const others = jobs.filter((j) => !j.from_invoices);
  const done = jobs.filter((j) => j.status === 'complete' && j.margin !== null);
  el.innerHTML = `${head}
    <div class="kpis">
      <div class="kpi accent"><div class="l">Active jobs</div><div class="v">${active.length}</div><div class="s">${money0(active.reduce((a, j) => a + j.contract_total, 0))} under contract · from invoices</div></div>
      <div class="kpi"><div class="l">Billed, not paid</div><div class="v">${money0(jobs.reduce((a, j) => a + j.owed, 0))}</div><div class="s">unpaid draws</div></div>
      <div class="kpi"><div class="l">Still to bill</div><div class="v">${money0(active.reduce((a, j) => a + j.to_bill, 0))}</div><div class="s">scheduled draws on active jobs</div></div>
      <div class="kpi"><div class="l">Unbilled materials</div><div class="v">${money0(jobs.reduce((a, j) => a + j.unbilled, 0))}</div><div class="s">incl. markup</div></div>
      <div class="kpi"><div class="l">Avg. margin (done)</div><div class="v">${pct(avg(done.map((j) => j.margin)))}</div><div class="s">${done.length} completed jobs</div></div>
    </div>
    ${others.length ? `<div class="callout" style="margin-bottom:12px">${others.length} job${others.length === 1 ? ' isn\'t' : 's aren\'t'} from an invoice (made by hand, by an agent, or by an older version from an estimate). They don't count toward contracts, owed or still to bill. <button class="link" data-go-check>Review in the Numbers check</button></div>` : ''}
    <div class="filters"><select id="jStatus">${[['open', 'Open jobs'], ['all', 'All jobs'], ['lead', 'Leads'], ['estimating', 'Estimating'], ['active', 'Active'], ['complete', 'Complete'], ['lost', 'Lost']].map(([v, l]) => `<option value="${v}" ${(state.jobFilter || 'open') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Job</th><th>Status</th><th class="n">Contract</th><th class="n">Collected</th><th class="n">Owed</th><th class="n hide-sm">To bill</th><th class="n hide-sm">Costs</th><th class="n">Profit</th><th class="n hide-sm">Your hrs</th><th class="n">$/hr</th><th></th></tr></thead>
      <tbody>${jobs.filter((j) => { const f = state.jobFilter || 'open'; return f === 'all' || (f === 'open' ? !['complete', 'lost'].includes(j.status) : j.status === f); }).map((j) => {
        const budgetPct = j.budget_cost ? j.total_cost / j.budget_cost : null;
        return `<tr class="clickable" data-job="${j.id}">
        <td><b>${esc(j.name)}</b><div class="note">${j.from_invoices ? '' : '<span class="tag warn">not from an invoice</span> '}${esc(j.client || '')}${j.estimate ? ` · ${esc(j.estimate.est_no)} ${money0(j.estimate.total)}` : ''}${j.unbilled ? ` · <span class="down">${money0(j.unbilled)} materials to bill</span>` : ''}${j.draws_total ? ` · ${j.draws_paid} of ${j.draws_total} draws paid` : ''}</div>
          ${j.contract_total ? drawBar(j) : ''}${j.draw_flags.length ? `<div class="note warn-text">⚠ ${esc(j.draw_flags[0])}</div>` : ''}</td>
        <td><span class="chip">${j.status}</span>${budgetPct !== null && budgetPct > 0.9 ? `<div class="note ${budgetPct > 1 ? 'neg' : ''}">${pct(budgetPct)} of budget</div>` : ''}</td>
        <td class="n">${j.contract_total ? money0(j.contract_total) : '—'}${j.change_orders ? `<div class="note">incl. ${money0(j.change_orders)} change orders</div>` : ''}</td><td class="n">${money0(j.income)}</td>
        <td class="n ${j.owed ? 'down' : ''}">${j.owed ? money0(j.owed) : '—'}</td><td class="n hide-sm">${j.to_bill ? money0(j.to_bill) : '—'}</td>
        <td class="n hide-sm" title="${j.vehicle_cost ? `incl. ${money(j.vehicle_cost)} mileage` : ''}">${money0(j.total_cost)}</td>
        <td class="n ${j.profit < 0 ? 'neg' : ''}"><b>${money0(j.profit)}</b><div class="note">${pct(j.margin)}</div></td>
        <td class="n hide-sm">${j.my_hours || '—'}${j.crew_hours ? `<div class="note">+${j.crew_hours} crew</div>` : ''}</td><td class="n">${j.per_hour !== null ? money0(j.per_hour) : '—'}</td>
        <td class="actions"><button class="btn sm ghost" data-je="${j.id}">Edit</button></td></tr>`;
      }).join('') || '<tr><td colspan="11" class="empty">No jobs here yet.</td></tr>'}</tbody></table></div>`;
  wireSubnav(el, 'jobsSub', renderJobs);
  $('#jobNew').addEventListener('click', () => jobModal());
  $('#jobHours').addEventListener('click', () => hoursModal());
  $('#jStatus').addEventListener('change', (e) => { state.jobFilter = e.target.value; renderJobs(); });
  $('[data-go-check]', el)?.addEventListener('click', () => { state.sub = 'check'; showTab('financials'); });
  $$('[data-je]', el).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); jobModal(jobs.find((j) => j.id === Number(b.dataset.je))); }));
  $$('[data-job]', el).forEach((r) => r.addEventListener('click', () => jobDetail(jobs.find((j) => j.id === Number(r.dataset.job)), walt)));
};
async function jobDetail(j, walt) {
  const [tx, time, inv, ests] = await Promise.all([api(`/api/transactions?job_id=${j.id}&limit=500`), api(`/api/time?job_id=${j.id}`), api('/api/invoices'), api('/api/estimates')]);
  const est = ests.find((e) => e.job_id === j.id && e.status === 'accepted') || ests.find((e) => e.job_id === j.id);
  const myInv = inv.filter((i) => i.job_id === j.id);
  openModal(`<div class="row" style="justify-content:space-between"><h2 style="margin:0">${esc(j.name)}</h2><span class="chip">${j.status}</span></div>
    <p class="note">${esc(j.client || '')}${j.address ? ' · ' + esc(j.address) : ''}</p>
    <div class="kpis" style="grid-template-columns:repeat(4,minmax(0,1fr))">
      <div class="kpi"><div class="l">Contract</div><div class="v">${money0(j.contract_total)}</div><div class="s">${j.change_orders ? `${money0(j.contract_amount)} + ${money0(j.change_orders)} change orders` : est ? `${esc(est.est_no)} ${money0(est.total)}` : 'no estimate'}</div></div>
      <div class="kpi"><div class="l">Collected</div><div class="v">${money0(j.income)}</div><div class="s">${money0(j.owed)} billed & unpaid · ${money0(j.to_bill)} still to bill</div></div>
      <div class="kpi"><div class="l">Costs</div><div class="v">${money0(j.total_cost)}</div><div class="s">${j.budget_cost ? `budget ${money0(j.budget_cost)}` : 'no budget set'}</div></div>
      <div class="kpi accent"><div class="l">Profit</div><div class="v">${money0(j.profit)}</div><div class="s">${j.per_hour !== null ? `${money0(j.per_hour)}/hr over ${j.my_hours} hrs` : 'log hours to see $/hr'}</div></div></div>
    ${j.draws && j.draws.length ? drawScheduleHtml(j) : ''}
    <h3>Money</h3>${tx.length ? miniTable(['Date', 'What', 'Category', 'Amount'], tx.map((t) => [fmtDate(t.date), t.party || t.memo || '', t.category, `${t.kind === 'expense' ? '−' : '+'}${money(t.amount)}`])) : '<p class="note">Nothing tagged to this job yet.</p>'}
    <h3 style="margin-top:14px">Hours</h3>${time.length ? miniTable(['Date', 'Who', 'Hours', 'Note'], time.map((t) => [fmtDate(t.date), t.worker, t.hours, t.note || ''])) : '<p class="note">No hours logged.</p>'}
    ${myInv.length ? `<h3 style="margin-top:14px">Invoices</h3>${miniTable(['Invoice', 'Draw', 'Amount', 'Balance'], myInv.map((i) => [i.invoice_no, i.draw_label || '', money(i.amount), money(i.balance)]))}` : ''}
    ${est && est.items.length ? `<h3 style="margin-top:14px">Estimate line items</h3>${miniTable(['Item', 'Qty', 'Rate', 'Total'], est.items.map((it) => [`${it.section ? it.section + ': ' : ''}${it.desc}${it.optional ? ' (optional)' : ''}`, `${it.qty} ${it.unit || ''}`, money(it.rate), money(it.total)]))}` : ''}
    <div class="foot"><button class="btn" id="jdAsk">Ask ${esc(walt.name)} about this job</button><button class="btn" id="jdLedger">Open in ledger</button><button class="btn" data-close>Close</button></div>`, () => {
    $('#jdAsk').addEventListener('click', () => { closeModal(); Drawer.ask(`How is the ${j.name} job doing against its estimate and budget? Anything I should watch or bill?`); });
    $('#jdLedger').addEventListener('click', () => { closeModal(); state.ledgerFilter = { period: 'all', job_id: String(j.id) }; state.sub = 'ledger'; showTab('financials'); });
  }, { wide: true });
}
function jobModal(j = {}) {
  const isEdit = !!j.id;
  openModal(`<h2>${isEdit ? 'Edit job' : 'New job'}</h2><form id="jobForm" class="form-grid">
    <label class="wide">Job name<input name="name" value="${esc(j.name || '')}" required placeholder="Jane Smith · Kitchen remodel"></label>
    <label>Client<input name="client" value="${esc(j.client || '')}"></label>
    <label>Status<select name="status">${['lead', 'estimating', 'active', 'complete', 'lost'].map((s) => `<option ${(j.status || 'active') === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
    <label>Pricing<select name="pricing">${[['fixed', 'Fixed bid'], ['tm', 'Time & materials'], ['day', 'Day rate']].map(([v, l]) => `<option value="${v}" ${(j.pricing || 'fixed') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label>Contract amount<input type="number" step="0.01" name="contract_amount" value="${j.contract_amount ?? ''}"></label>
    <label>Budgeted cost<input type="number" step="0.01" name="budget_cost" value="${j.budget_cost ?? ''}" placeholder="Materials + subs"></label>
    <label class="wide">Address<input name="address" value="${esc(j.address || '')}"></label>
    <label>Start<input type="date" name="start_date" value="${j.start_date || ''}"></label><label>End<input type="date" name="end_date" value="${j.end_date || ''}"></label>
    <label class="wide">Notes<textarea name="notes">${esc(j.notes || '')}</textarea></label></form>
    <div class="foot">${isEdit ? '<button class="btn danger ghost" id="jobDel">Delete</button><span class="grow"></span>' : ''}<button class="btn" data-close>Cancel</button><button class="btn primary" id="jobSave">Save</button></div>`);
  $('#jobSave').addEventListener('click', async () => {
    const f = $('#jobForm'); if (!f.reportValidity()) return;
    try { if (isEdit) await api(`/api/jobs/${j.id}`, { method: 'PUT', body: formData(f) }); else await api('/api/jobs', { method: 'POST', body: formData(f) }); closeModal(); toast('Job saved'); refreshAfterChange(); } catch (e) { fail(e); }
  });
  if (isEdit) $('#jobDel').addEventListener('click', async () => { if (!confirm('Delete this job? Its transactions stay in the ledger, untagged.')) return; await api(`/api/jobs/${j.id}`, { method: 'DELETE' }); closeModal(); refreshAfterChange(); });
}
async function renderEstimates(el, head) {
  const ests = await api('/api/estimates');
  const decided = ests.filter((e) => ['accepted', 'declined'].includes(e.status));
  const won = ests.filter((e) => e.status === 'accepted');
  const open = ests.filter((e) => ['draft', 'sent'].includes(e.status));
  el.innerHTML = `${head}
    <div class="kpis"><div class="kpi accent"><div class="l">Win rate</div><div class="v">${decided.length ? pct(won.length / decided.length) : '—'}</div><div class="s">${won.length} won of ${decided.length} decided</div></div>
      <div class="kpi"><div class="l">Open bids</div><div class="v">${money0(open.reduce((s, e) => s + e.total, 0))}</div><div class="s">${open.length} estimates</div></div>
      <div class="kpi"><div class="l">Avg. accepted bid</div><div class="v">${money0(avg(won.map((e) => e.total)))}</div></div></div>
    <div class="table-wrap"><table><thead><tr><th>Estimate</th><th>Client / project</th><th class="hide-sm">Date</th><th class="n">Total</th><th>Status</th></tr></thead><tbody>
    ${ests.length ? ests.map((e) => `<tr class="clickable" data-est="${e.id}"><td class="mono"><b>${esc(e.est_no)}</b></td><td>${esc(e.client || '')}<div class="note">${esc(e.project || '')}</div></td>
      <td class="hide-sm mono">${fmtDate(e.est_date)}${e.valid_until && e.valid_until < today() && ['draft', 'sent'].includes(e.status) ? '<div class="note neg">expired</div>' : ''}</td><td class="n">${money(e.total)}</td>
      <td><span class="chip ${e.status === 'accepted' ? 'paid' : e.status === 'declined' ? 'overdue' : 'open'}">${e.status}</span></td></tr>`).join('')
      : '<tr><td colspan="5" class="empty">Estimates you write on the Invoicing tab appear here automatically.</td></tr>'}</tbody></table></div>`;
  wireSubnav(el, 'jobsSub', state.pages.jobs);
  $$('[data-est]', el).forEach((r) => r.addEventListener('click', () => {
    const e = ests.find((x) => x.id === Number(r.dataset.est));
    openModal(`<h2>${esc(e.est_no)} · ${esc(e.client || '')}</h2><p class="note">${esc(e.project || '')} · ${fmtDate(e.est_date)} · ${e.status}</p>${e.scope ? `<p>${esc(e.scope)}</p>` : ''}
      ${miniTable(['Item', 'Qty', 'Rate', 'Total'], (e.items || []).map((it) => [`${it.section ? it.section + ': ' : ''}${it.desc}${it.optional ? ' (optional)' : ''}`, `${it.qty} ${it.unit || ''}`, money(it.rate), money(it.total)]))}
      <div class="foot"><button class="btn" data-close>Close</button></div>`, null, { wide: true });
  }));
}
async function renderCrew(el, head) {
  const [workers, time] = await Promise.all([api('/api/workers'), api(`/api/time?from=${addDays(today(), -29)}`)]);
  const hrs = {}; time.forEach((t) => { hrs[t.worker] = (hrs[t.worker] || 0) + t.hours; });
  el.innerHTML = `${head}
    <div class="grid g2"><div class="card"><h3>Crew</h3><div class="list">${workers.map((w) => `<div class="li"><div><b>${esc(w.name === 'Me' ? 'You (Loshem)' : w.name)}</b> <span class="chip">${w.role}</span>${w.active ? '' : ' <span class="chip">inactive</span>'}<div class="meta">${w.rate ? `${money(w.rate)}/hr · ` : ''}${hrs[w.name] || 0} hrs last 30 days</div></div>${w.name !== 'Me' ? `<button class="btn sm ghost" data-w="${w.id}">Edit</button>` : ''}</div>`).join('')}</div>
      <p class="note">Helpers and subs are paid on 1099 – log their pay as Subcontractors expenses so the 1099 tracker counts it.</p></div>
    <div class="card"><div class="row" style="justify-content:space-between"><h3>Hours · last 30 days</h3><a class="btn sm" href="/api/export/time.csv?year=${today().slice(0, 4)}">Export</a></div>
      ${time.length ? miniTable(['Date', 'Who', 'Job', 'Hours'], time.map((t) => [fmtDate(t.date), t.worker, t.job_name || '', t.hours])) : '<p class="note">No hours yet. The Foreman records them at the morning check-in, or use Log hours.</p>'}</div></div>`;
  wireSubnav(el, 'jobsSub', state.pages.jobs);
  const edit = (w = {}) => openModal(`<h2>${w.id ? 'Edit' : 'Add'} crew member</h2><form id="wForm" class="form-grid"><label class="wide">Name<input name="name" value="${esc(w.name || '')}" required ${w.id ? 'readonly' : ''}></label>
    <label>Role<select name="role"><option value="helper" ${w.role !== 'sub' ? 'selected' : ''}>Helper</option><option value="sub" ${w.role === 'sub' ? 'selected' : ''}>Subcontractor</option></select></label>
    <label>Pay rate $/hr<input type="number" step="0.5" name="rate" value="${w.rate ?? ''}"></label><label class="check-label"><input type="checkbox" name="active" ${w.active !== false ? 'checked' : ''}> Active</label></form>
    <div class="foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="wSave">Save</button></div>`, () => $('#wSave').addEventListener('click', async () => {
    const f = $('#wForm'); if (!f.reportValidity()) return;
    try { await api('/api/workers', { method: 'POST', body: formData(f) }); closeModal(); refreshAfterChange(); } catch (e) { fail(e); }
  }));
  $('#crewNew').addEventListener('click', () => edit());
  $$('[data-w]', el).forEach((b) => b.addEventListener('click', () => edit(workers.find((w) => w.id === Number(b.dataset.w)))));
}

// ================= TAXES =================
state.pages.taxes = async function renderTaxes() {
  const el = $('#tab-taxes');
  const year = state.taxYear || Number(today().slice(0, 4));
  const t = await api(`/api/taxes?year=${year}`);
  const e = t.estimate; const s = state.meta.settings;
  const helen = agentInfo('taxes');
  const thisYear = Number(today().slice(0, 4));
  el.innerHTML = `
    <div class="page-head"><div><h2>Taxes · ${year}</h2><div class="sub-title">Sole proprietor · Schedule C + SE · ${s.filing_status === 'mfj' ? 'Married filing jointly' : 'Single'} · Fairborn, Ohio. Live from your ledger.</div></div>
      <div class="row"><select id="taxYear" style="width:auto">${[thisYear, thisYear - 1, thisYear - 2].map((y) => `<option ${y === year ? 'selected' : ''}>${y}</option>`).join('')}</select>
      <button class="btn" id="taxAssume">Assumptions</button><a class="btn" href="/api/export/tax.csv?year=${year}">Export for accountant</a></div></div>
    <div class="kpis">
      <div class="kpi"><div class="l">Gross receipts (L1)</div><div class="v">${money0(t.income.gross_receipts)}</div></div>
      <div class="kpi"><div class="l">Materials (COGS)</div><div class="v">${money0(t.income.cogs)}</div></div>
      <div class="kpi"><div class="l">Expenses (L28)</div><div class="v">${money0(t.total_expenses)}</div></div>
      <div class="kpi accent"><div class="l">Net profit (L31)</div><div class="v">${money0(t.net_profit)}</div>${e.projected_full_year_profit && year === thisYear ? `<div class="s">On pace for ${money0(e.projected_full_year_profit)}</div>` : ''}</div>
      <div class="kpi"><div class="l">Est. tax so far</div><div class="v">${money0(e.total)}</div><div class="s">≈ ${e.effective_set_aside_pct}% of profit${year === thisYear ? ` · full year ≈ ${money0(e.projected_full_year_tax)}` : ''}</div></div>
      <div class="kpi"><div class="l">Still to set aside</div><div class="v ${e.remaining > 0 ? 'neg' : 'pos'}">${money0(Math.max(0, e.remaining))}</div><div class="s">${money0(e.paid)} paid so far</div></div>
    </div>
    <div class="callout row" style="justify-content:space-between;margin-bottom:14px"><span>These numbers sort your books into tax-form buckets and estimate what to set aside. They aren't your filed return – confirm with your accountant.</span>
      ${state.meta.ai_enabled ? `<button class="btn sm" data-ask="Review my ${year} tax picture. What should I do before year end, and am I setting aside enough?">Ask ${esc(helen.name)} for a review</button>` : ''}</div>
    <div class="grid g-main">
      <div class="card"><h3>Schedule C, line by line</h3>
        <div class="table-wrap"><table><thead><tr><th>Line</th><th class="n">Amount</th></tr></thead><tbody>
          <tr><td>Line 1 – Gross receipts</td><td class="n">${money(t.income.gross_receipts)}</td></tr>
          <tr><td>Line 4 – Cost of goods sold (Part III, materials)</td><td class="n">${money(t.income.cogs)}</td></tr>
          <tr><td>Line 6 – Other income</td><td class="n">${money(t.income.other_income)}</td></tr>
          <tr class="tfoot"><td>Line 7 – Gross income</td><td class="n">${money(t.income.gross_income)}</td></tr>
          ${t.expense_lines.map((l, i) => `<tr class="sched-line" data-l="${i}"><td>${esc(l.label)}</td><td class="n">${money(l.amount)}</td></tr>
            ${l.categories.map((c) => `<tr class="sched-detail hidden" data-ld="${i}"><td>${esc(c.category)}${c.note ? ` (${esc(c.note)})` : ''}${c.count ? ` · ${c.count} entries` : ''}</td><td class="n">${money(c.amount)}</td></tr>`).join('')}`).join('')}
          <tr class="tfoot"><td>Line 28 – Total expenses</td><td class="n">${money(t.total_expenses)}</td></tr>
          <tr><td>Line 29 – Tentative profit</td><td class="n">${money(t.tentative_profit)}</td></tr>
          <tr><td>Line 30 – Home office (${t.home_office.sqft} sq ft, simplified)</td><td class="n">${money(t.home_office.deduction)}</td></tr>
          <tr class="tfoot"><td>Line 31 – Net profit</td><td class="n">${money(t.net_profit)}</td></tr>
        </tbody></table></div>
        ${t.not_deducted.length ? `<p class="note" style="margin-top:12px"><b>Not deducted:</b> ${t.not_deducted.map((n) => `${esc(n.category)} ${money(n.amount)} (${esc(n.reason)})`).join(' · ')}</p>` : ''}
      </div>
      <div class="grid" style="align-content:start">
        <div class="card"><h3>Estimated tax on this profit</h3><div class="list">
          <div class="li"><span>Self-employment tax<div class="meta">15.3% of 92.35% of profit (SS capped at ${money0(e.wage_base)})</div></span><span class="num">${money(e.se_tax)}</span></div>
          <div class="li"><span>Federal income tax<div class="meta">${money0(e.federal_taxable)} taxable after standard deduction, ½ SE${e.qbi_deduction ? ` and ${money0(e.qbi_deduction)} QBI` : ''} · ${Math.round(e.federal_marginal * 100)}% bracket</div></span><span class="num">${money(e.federal_income_tax)}</span></div>
          <div class="li"><span>Ohio income tax<div class="meta">Business income deduction shelters the first ${money0(e.ohio_bid)}</div></span><span class="num">${money(e.ohio_tax)}</span></div>
          <div class="li"><span>School district (Fairborn CSD)<div class="meta">${s.school_district_rate}% traditional base</div></span><span class="num">${money(e.school_tax)}</span></div>
          <div class="li"><span>City income tax<div class="meta">${s.city_rate}% of net profit</div></span><span class="num">${money(e.city_tax)}</span></div>
          <div class="li"><b>Total</b><b class="num">${money(e.total)}</b></div></div>
          ${Number(s.other_income) ? '' : '<p class="note">Assumes no other household income. If a spouse works or you have other income, add it under Assumptions so the bracket is right.</p>'}</div>
        <div class="card"><h3>Quarterly estimated payments</h3>
          <div class="table-wrap"><table><thead><tr><th>Quarter</th><th>Due</th><th class="n">Suggested</th><th class="n">Paid</th></tr></thead><tbody>
          ${t.deadlines.map((d) => `<tr><td>${d.q}<div class="note">${d.period}</div></td><td class="mono">${fmtDate(d.due)}${t.next_deadline && t.next_deadline.q === d.q ? ' <span class="chip open">next</span>' : ''}</td><td class="n">${money0(d.suggested)}</td><td class="n">${d.paid ? money0(d.paid) : d.due < today() ? '<span class="neg">—</span>' : '—'}</td></tr>`).join('')}
          </tbody></table></div>
          <p class="note">Suggested = projected full-year tax ÷ 4. Log payments as <b>Estimated Tax Payment</b> expenses.</p></div>
      </div>
    </div>
    <div class="grid g2" style="margin-top:14px">
      <div class="card"><div class="row" style="justify-content:space-between"><h3>Purchase planner (Section 179 / bonus)</h3><button class="btn sm" id="ppNew">+ Planned purchase</button></div>
        ${t.planned_purchases.length ? `<div class="list">${t.planned_purchases.map((p) => `<div class="li"><div><b>${esc(p.item)}</b> <span class="chip">${p.kind}</span> ${p.status === 'bought' ? '<span class="chip paid">bought</span>' : ''}<div class="meta">${money0(p.cost)} · ${p.business_pct}% business${p.planned_date ? ` · ${fmtDate(p.planned_date)}` : ''}</div>${p.warning ? `<div class="meta warn-text">⚠ ${esc(p.warning)}</div>` : ''}</div>
          <div style="text-align:right"><div class="num pos">≈ ${money0(p.est_saving)}</div><div class="meta">tax saved if expensed in ${year}</div><button class="btn sm ghost" data-pp="${p.id}">Edit</button></div></div>`).join('')}
          <div class="li"><b>Total if all expensed this year</b><b class="num pos">≈ ${money0(t.planned_purchases.reduce((s2, p) => s2 + p.est_saving, 0))}</b></div></div>`
          : '<p class="note">Add the tools, truck and trailer you\'re planning to see what buying them this year could save.</p>'}
        <p class="note">Savings modeled on your projected profit, one at a time. Deduction limits, business-use tests and vehicle rules apply.${state.meta.ai_enabled ? ` <button class="link" data-ask="I'm planning to buy power tools, a truck and a trailer, about $20k total. Walk me through Section 179 vs bonus depreciation vs the standard mileage rate for my situation, and whether to buy before December 31.">Ask ${esc(helen.name)} to compare options</button>` : ''}</p></div>
      <div class="card"><h3>1099-NEC tracker</h3>
        ${t.contractors_1099.payees.length ? `<div class="table-wrap"><table><thead><tr><th>Payee</th><th class="n">Paid</th><th>1099?</th></tr></thead><tbody>
          ${t.contractors_1099.payees.map((p) => `<tr><td>${esc(p.payee)}<div class="note">${p.n} payments${p.methods ? ' · ' + p.methods.join(', ') : ''}</div></td><td class="n">${money(p.total)}</td><td>${p.needs_1099 ? '<span class="chip overdue">File 1099</span>' : `<span class="chip">under ${money0(t.contractors_1099.threshold)}</span>`}</td></tr>`).join('')}</tbody></table></div>`
          : '<p class="note">No Subcontractors payments this year.</p>'}
        <p class="note">${money0(t.contractors_1099.threshold)} per payee for ${year} payments; due Jan 31. Get a W-9 before paying a new sub.</p></div>
      <div class="card"><h3>Home office / garage</h3>
        <div class="row"><label style="max-width:160px">Square feet used<input type="number" id="hoSqft" value="${s.home_office_sqft || 0}" min="0" max="2000"></label><button class="btn sm" id="hoSave" style="align-self:flex-end">Save</button></div>
        <p class="note">Simplified method: $5 per sq ft, up to 300 sq ft ($1,500), limited to your profit. The space must be used regularly and only for the business – a garage that also parks the family car usually doesn't qualify.</p></div>
      <div class="card"><h3>Ohio sales & use tax on materials</h3><div class="list">
        <div class="li"><span>Sales tax paid on purchases</span><span class="num">${money(t.sales_use_tax.sales_tax_paid)}</span></div>
        <div class="li"><span>Purchases with no tax charged<div class="meta">${t.sales_use_tax.untaxed_count} purchases</div></span><span class="num">${money(t.sales_use_tax.untaxed_purchases)}</span></div>
        <div class="li"><span>Possible use tax due<div class="meta">at ${t.sales_use_tax.use_tax_rate}% (Greene County)</div></span><span class="num">${money(t.sales_use_tax.est_use_tax_due)}</span></div></div>
        <p class="note">As a remodeling contractor you generally pay sales tax on materials when you buy them and don't charge it to clients. Untaxed online or out-of-state purchases may owe use tax.</p></div>
      <div class="card"><h3>Vehicle</h3><div class="list">
        <div class="li"><span>Method</span><span>${t.vehicle_method === 'standard' ? 'Standard mileage rate' : 'Actual expenses'}</span></div>
        <div class="li"><span>Business miles</span><span class="num">${t.mileage.miles.toLocaleString()}</span></div>
        <div class="li"><span>Mileage deduction</span><span class="num">${money(t.mileage.deduction)}</span></div></div></div>
    </div>`;
  $('#taxYear').addEventListener('change', (ev) => { state.taxYear = Number(ev.target.value); renderTaxes(); });
  $('#taxAssume').addEventListener('click', taxAssumptions);
  $$('.sched-line', el).forEach((r) => r.addEventListener('click', () => { r.classList.toggle('open'); $$(`[data-ld="${r.dataset.l}"]`, el).forEach((d) => d.classList.toggle('hidden')); }));
  $$('[data-ask]', el).forEach((b) => b.addEventListener('click', () => Drawer.ask(b.dataset.ask)));
  $('#hoSave').addEventListener('click', async () => { await api('/api/settings', { method: 'PUT', body: { home_office_sqft: $('#hoSqft').value } }); toast('Saved'); refreshAfterChange(); });
  $('#ppNew').addEventListener('click', () => plannedModal());
  $$('[data-pp]', el).forEach((b) => b.addEventListener('click', () => plannedModal(t.planned_purchases.find((p) => p.id === Number(b.dataset.pp)))));
};
function plannedModal(p = {}) {
  openModal(`<h2>${p.id ? 'Edit' : 'Plan a'} purchase</h2><form id="ppForm" class="form-grid">
    <label class="wide">Item<input name="item" value="${esc(p.item || '')}" required placeholder="F-250 pickup, 7x14 trailer, cordless kit…"></label>
    <label>Type<select name="kind">${['tools', 'truck', 'trailer', 'equipment', 'other'].map((k) => `<option ${p.kind === k ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
    <label>Cost<input type="number" step="0.01" name="cost" value="${p.cost ?? ''}" required></label>
    <label>Business use %<input type="number" name="business_pct" value="${p.business_pct ?? 100}" min="0" max="100"></label>
    <label>Planned date<input type="date" name="planned_date" value="${p.planned_date || ''}"></label>
    ${p.id ? `<label>Status<select name="status">${['planned', 'bought', 'dropped'].map((k) => `<option ${p.status === k ? 'selected' : ''}>${k}</option>`).join('')}</select></label>` : ''}
    <label class="wide">Note<input name="note" value="${esc(p.note || '')}"></label></form>
    <div class="foot">${p.id ? '<button class="btn danger ghost" id="ppDel">Delete</button><span class="grow"></span>' : ''}<button class="btn" data-close>Cancel</button><button class="btn primary" id="ppSave">Save</button></div>`, () => {
    $('#ppSave').addEventListener('click', async () => {
      const f = $('#ppForm'); if (!f.reportValidity()) return;
      try { await api(p.id ? `/api/planned/${p.id}` : '/api/planned', { method: p.id ? 'PUT' : 'POST', body: formData(f) }); closeModal(); render(); } catch (e) { fail(e); }
    });
    $('#ppDel')?.addEventListener('click', async () => { await api(`/api/planned/${p.id}`, { method: 'DELETE' }); closeModal(); render(); });
  });
}
function taxAssumptions() {
  const s = state.meta.settings;
  openModal(`<h2>Tax assumptions</h2><form id="taForm" class="form-grid">
    <label>Filing status<select name="filing_status"><option value="single" ${s.filing_status !== 'mfj' ? 'selected' : ''}>Single</option><option value="mfj" ${s.filing_status === 'mfj' ? 'selected' : ''}>Married filing jointly</option></select></label>
    <label>Other household income<input type="number" name="other_income" value="${s.other_income || 0}"></label>
    <label class="check-label"><input type="checkbox" name="apply_qbi" ${s.apply_qbi !== false && s.apply_qbi !== 'false' ? 'checked' : ''}> Apply 20% QBI deduction</label>
    <label>Vehicle method<select name="vehicle_method"><option value="standard" ${s.vehicle_method !== 'actual' ? 'selected' : ''}>Standard mileage</option><option value="actual" ${s.vehicle_method === 'actual' ? 'selected' : ''}>Actual expenses</option></select></label>
    <label>Ohio business income deduction<input type="number" name="ohio_bid" value="${s.ohio_bid}"></label>
    <label>Ohio rate above it %<input type="number" step="0.01" name="ohio_business_rate" value="${s.ohio_business_rate}"></label>
    <label>School district %<input type="number" step="0.01" name="school_district_rate" value="${s.school_district_rate}"></label>
    <label>City income tax %<input type="number" step="0.01" name="city_rate" value="${s.city_rate}"></label>
    <label>Use tax rate %<input type="number" step="0.01" name="use_tax_rate" value="${s.use_tax_rate}"></label>
    <label class="wide">Federal brackets & standard deduction (JSON, by year)<textarea name="tax_tables" rows="5" class="mono">${esc(JSON.stringify(s.tax_tables))}</textarea></label>
    <label class="wide">IRS mileage rates (from date → $/mile, one per line)<textarea name="mileage_rates" rows="3">${(s.mileage_rates || []).map((r) => `${r.from} ${r.rate}`).join('\n')}</textarea></label>
    <label>1099 threshold by year<textarea name="threshold_1099" rows="2">${Object.entries(s.threshold_1099 || {}).map(([y, v]) => `${y} ${v}`).join('\n')}</textarea></label>
    <label>SS wage base by year<textarea name="ss_wage_base" rows="2">${Object.entries(s.ss_wage_base || {}).map(([y, v]) => `${y} ${v}`).join('\n')}</textarea></label>
  </form><p class="note">Defaults are the 2026 figures for Fairborn, Ohio. Add next year's numbers when they're announced, or ask ${esc(agentInfo('taxes').name)} to look them up.</p>
  <div class="foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="taSave">Save</button></div>`, () => $('#taSave').addEventListener('click', async () => {
    const f = formData($('#taForm'));
    const pairs = (txt) => Object.fromEntries(txt.split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length === 2).map(([k, v]) => [k, Number(v)]));
    try { f.tax_tables = JSON.parse(f.tax_tables); } catch { return toast('The brackets JSON has a typo', true); }
    f.mileage_rates = f.mileage_rates.split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length === 2).map(([from, rate]) => ({ from, rate: Number(rate) }));
    f.threshold_1099 = pairs(f.threshold_1099); f.ss_wage_base = pairs(f.ss_wage_base); f.apply_qbi = String(f.apply_qbi);
    try { await api('/api/settings', { method: 'PUT', body: f }); closeModal(); toast('Saved'); refreshAfterChange(); } catch (e) { fail(e); }
  }), { wide: true });
}

// ================= DAILY =================
state.pages.productivity = async function renderDaily() {
  const el = $('#tab-productivity');
  const hank = agentInfo('daily');
  el.innerHTML = `<div class="grid g-main">
      <div class="card chat">
        <div class="chat-head"><span class="avatar">${initials(hank.name)}</span><div class="grow"><b>${esc(hank.name)}</b><div class="note">${esc(hank.title)} · daily plan, hours and check-ins</div></div>
          <button class="icon-btn autoread" title="Read replies aloud">🔈</button></div>
        <div class="chat-body" id="dailyChat"></div>
      </div>
      <div class="grid" style="align-content:start"><div class="card" id="todayCard"></div><div class="card" id="historyCard"></div></div>
    </div>`;
  syncAutoread();
  const chat = Chat($('#dailyChat'), 'daily', { embedded: true });
  await chat.load();
  refreshTodayCard();
  if (state.meta.ai_enabled && !state.dailyOpened) { state.dailyOpened = true; chat.opener(); }
};
window.refreshTodayCard = async function () {
  const [logs, time] = await Promise.all([api('/api/daily-logs?days=21'), api(`/api/time?from=${addDays(today(), -1)}`)]);
  const t = today();
  const log = logs.find((l) => l.date === t) || { date: t, goals: [] };
  const goals = log.goals || [];
  const target = Number(state.meta.settings.daily_target) || 0;
  const est = goals.reduce((s, g) => s + (g.est_value || 0), 0); const done = goals.filter((g) => g.done).reduce((s, g) => s + (g.est_value || 0), 0);
  const byWorker = {}; goals.forEach((g, i) => (byWorker[g.worker || 'Me'] ||= []).push({ ...g, i }));
  const c = $('#todayCard'); if (!c) return;
  c.innerHTML = `<div class="row" style="justify-content:space-between"><h3>Today · ${fmtDate(t)}</h3><div class="row"><button class="link" id="logHours">Log hours</button><button class="link" id="editToday">Edit</button></div></div>
    ${log.plan ? `<p style="margin:0 0 8px">${esc(log.plan)}</p>` : ''}
    ${goals.length ? Object.entries(byWorker).map(([w, gs]) => `<div class="worker-head">${w === 'Me' ? 'You' : esc(w)}</div>${gs.map((g) => `<div class="goal ${g.done ? 'done' : ''}"><input type="checkbox" data-tg="${g.i}" ${g.done ? 'checked' : ''}><span class="t">${esc(g.text)}${g.job_name ? `<span class="note"> · ${esc(g.job_name)}</span>` : ''}</span>${g.est_value ? `<span class="val num">${money0(g.est_value)}</span>` : ''}</div>`).join('')}`).join('')
      : `<p class="note">No plan yet. Tell ${esc(agentInfo('daily').name)} what you and the crew are doing today.</p>`}
    ${est ? `<div class="progress"><span style="width:${(done / est) * 100}%"></span></div><div class="note" style="margin-top:6px">${money0(done)} of ${money0(est)} planned${target ? ` · daily target ${money0(target)}` : ''} · ${goals.filter((g) => g.done).length}/${goals.length} goals</div>` : ''}
    ${time.filter((x) => x.date === t).length ? `<div class="worker-head">Hours logged today</div>${time.filter((x) => x.date === t).map((x) => `<div class="li"><span>${esc(x.worker === 'Me' ? 'You' : x.worker)}${x.job_name ? ` · ${esc(x.job_name)}` : ''}</span><span class="num">${x.hours}h</span></div>`).join('')}` : ''}`;
  $$('[data-tg]', c).forEach((cb) => cb.addEventListener('change', async () => {
    const gs = goals.map((g, i) => (i === Number(cb.dataset.tg) ? { ...g, done: cb.checked } : g));
    const allDone = gs.length && gs.every((g) => g.done);
    await api(`/api/daily-logs/${log.date}`, { method: 'PUT', body: { ...log, goals: gs, met: log.met || (allDone ? 'yes' : null) } });
    refreshTodayCard();
  }));
  $('#editToday').addEventListener('click', () => dayModal(log));
  $('#logHours').addEventListener('click', () => hoursModal(t));
  const judged = logs.filter((l) => l.met);
  const h = $('#historyCard');
  h.innerHTML = `<h3>Last 3 weeks</h3>
    <div class="kpis" style="grid-template-columns:repeat(3,minmax(0,1fr));margin-bottom:8px">
      <div><div class="note">Days met</div><b class="num">${judged.filter((l) => l.met === 'yes').length}/${judged.length}</b></div>
      <div><div class="note">Est. earned</div><b class="num">${money0(logs.reduce((s, l) => s + (l.est_earned || 0), 0))}</b></div>
      <div><div class="note">Your hours</div><b class="num">${logs.reduce((s, l) => s + (l.hours || 0), 0)}</b></div></div>
    <div class="list">${logs.filter((l) => l.date !== t).slice(0, 10).map((l) => `<div class="li clickable" data-log="${l.date}"><div><b>${fmtDate(l.date)}</b> <span class="chip ${l.met === 'yes' ? 'paid' : l.met === 'partial' ? 'partial' : l.met === 'no' ? 'overdue' : ''}">${l.met || 'not reviewed'}</span><div class="meta">${esc((l.plan || l.goals.map((g) => g.text).join(', ')).slice(0, 90))}</div></div><div class="num">${l.est_earned ? money0(l.est_earned) : ''}${l.hours ? `<div class="meta">${l.hours}h</div>` : ''}</div></div>`).join('') || '<p class="note">History builds as you check in.</p>'}</div>`;
  $$('[data-log]', h).forEach((r) => r.addEventListener('click', () => dayModal(logs.find((l) => l.date === r.dataset.log))));
};
function dayModal(log) {
  const goals = log.goals || [];
  const goalRow = (g = {}) => `<div class="split-row goal-row"><input type="checkbox" ${g.done ? 'checked' : ''} class="g-done"><input placeholder="Goal" value="${esc(g.text || '')}" class="g-text"><select class="g-w">${workerOptions(g.worker)}</select><input type="number" placeholder="$" value="${g.est_value ?? ''}" class="g-v"><button type="button" class="btn sm ghost sp-rm">✕</button></div>`;
  openModal(`<h2>${fmtDate(log.date)}</h2><form id="dayForm">
    <label>Plan<input name="plan" value="${esc(log.plan || '')}"></label>
    <h3 style="margin-top:14px">Goals</h3><div id="goalRows">${goals.map(goalRow).join('')}</div><button type="button" class="btn sm" id="addGoal">+ Goal</button>
    <div class="form-grid" style="margin-top:14px"><label>Goals met?<select name="met"><option value="">Not reviewed</option>${['yes', 'partial', 'no'].map((m) => `<option ${log.met === m ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
      <label>Est. earned<input type="number" step="0.01" name="est_earned" value="${log.est_earned ?? ''}"></label><label>Your hours<input type="number" step="0.25" name="hours" value="${log.hours ?? ''}"></label>
      <label class="wide">How it went<textarea name="outcome">${esc(log.outcome || '')}</textarea></label></div></form>
    <div class="foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="daySave">Save</button></div>`, (m) => {
    const wire = () => $$('.sp-rm', m).forEach((b) => (b.onclick = () => b.parentElement.remove()));
    $('#addGoal').addEventListener('click', () => { $('#goalRows').insertAdjacentHTML('beforeend', goalRow()); wire(); }); wire();
  }, { wide: true });
  $('#daySave').addEventListener('click', async () => {
    const f = formData($('#dayForm'));
    const gs = $$('.goal-row').map((r) => ({ text: $('.g-text', r).value.trim(), worker: $('.g-w', r).value, est_value: $('.g-v', r).value ? Number($('.g-v', r).value) : null, done: $('.g-done', r).checked })).filter((g) => g.text);
    try { await api(`/api/daily-logs/${log.date}`, { method: 'PUT', body: { ...f, goals: gs } }); closeModal(); toast('Day saved'); render(); } catch (e) { fail(e); }
  });
}

// ================= SETTINGS =================
state.pages.settings = async function renderSettings() {
  await loadMeta();
  const el = $('#tab-settings');
  const sub = state.setSub || 'agents';
  el.innerHTML = `<div class="page-head"><h2>Settings</h2></div>${subnav('setSub', [['agents', 'Agents & knowledge'], ['business', 'Business'], ['connections', 'Connections'], ['security', 'Security'], ['categories', 'Categories'], ['data', 'Data']], sub)}<div id="setBody"></div>`;
  wireSubnav(el, 'setSub', renderSettings);
  const body = $('#setBody');
  ({ agents: setAgents, business: setBusiness, connections: setConnections, security: setSecurity, categories: setCategories, data: setData }[sub])(body);
};
async function setAgents(body) {
  const [docs, facts] = await Promise.all([api('/api/docs'), api('/api/facts')]);
  const ids = ['home', 'financials', 'taxes', 'jobs', 'daily'];
  const folder = (id, label) => {
    const list = docs.filter((d) => d.agent === id);
    const chars = list.reduce((s, d) => s + d.chars, 0);
    return `<div class="folder"><div class="row" style="justify-content:space-between"><b>${label}</b><button class="btn sm" data-up="${id}">⇪ Add file</button></div>
      ${list.length ? `<div class="list">${list.map((d) => `<div class="li"><div>📄 ${esc(d.filename)}<div class="meta">${Math.round(d.size / 1024)} KB · ${d.chars ? `${(d.chars / 1000).toFixed(1)}k characters read` : 'no text found'}${d.note ? ` · ${esc(d.note)}` : ''}</div></div><div class="row"><a class="btn sm ghost" href="/api/attachments/${d.attachment_id}" target="_blank" rel="noopener">Open</a><button class="btn sm ghost danger" data-deldoc="${d.id}">✕</button></div></div>`).join('')}</div>
        <div class="note">${chars > 60000 ? 'Large folder: the agent searches it as needed.' : 'The agent reads these in full on every question.'}</div>` : '<p class="note">No files yet.</p>'}</div>`;
  };
  body.innerHTML = `
    <div class="callout" style="margin-bottom:14px">Files are encrypted before they're stored and are only sent to Claude when that agent answers you. Hold off on very sensitive documents (full tax returns, ID or account numbers) until you've turned on two-factor login under Security.</div>
    <div class="grid g2">${ids.map((id) => { const a = agentInfo(id); return `<div class="card"><div class="row"><span class="avatar">${initials(a.name)}</span><div class="grow"><b>${esc(a.name)}</b><div class="note">${esc(a.title)} · ${esc(a.page)} tab</div></div><button class="btn sm ghost" data-hear="${id}">▶ Hear voice</button></div>
      <form class="form-grid agent-form" data-agent="${id}" style="margin-top:12px">
        <label>Name<input name="name" value="${esc(a.name)}"></label>
        <label>Gemini voice<input name="voice" value="${esc(a.voice)}" placeholder="Kore, or voice_…"></label>
        <label class="wide">Speaking style<input name="style" value="${esc(a.style || '')}" placeholder="e.g. calm, warm, unhurried"></label>
        <label>&nbsp;<button class="btn sm">Save</button></label></form>
      ${folder(id, 'Knowledge folder')}</div>`; }).join('')}
      <div class="card">${folder('shared', 'Shared folder · all agents read these')}<p class="note">Good for a business overview, your price list, standard terms, or your CPA's guidance.</p></div>
    </div>
    <div class="card" style="margin-top:14px"><div class="row" style="justify-content:space-between"><h3>Shared team memory</h3><form id="factForm" class="row"><input name="text" placeholder="Add something every agent should know" style="min-width:280px"><button class="btn sm">Add</button></form></div>
      ${facts.length ? `<div class="list">${facts.map((f) => `<div class="li"><span>${esc(f.text)}<span class="meta"> · ${esc(f.agent === 'you' ? 'added by you' : agentInfo(f.agent).name || '')}</span></span><button class="btn sm ghost" data-delfact="${f.id}">✕</button></div>`).join('')}</div>` : '<p class="note">Facts the agents learn (after you approve them) appear here. Every agent sees this list.</p>'}</div>
    <p class="note" style="margin-top:10px">Voices: ${state.meta.tts_enabled ? 'Gemini voice is on.' : 'Add GEMINI_API_KEY in Railway to use your Gemini voices; until then your browser\'s voice is used.'} Paste a custom voice ID (starts with voice_) to use a voice you designed or recorded in Gemini.</p>
    <input type="file" id="docFile" accept=".pdf,.docx,.txt,.md,.csv,.json,image/*" hidden>`;
  let target = null;
  $$('[data-up]', body).forEach((b) => b.addEventListener('click', () => { target = b.dataset.up; $('#docFile').click(); }));
  $('#docFile').addEventListener('change', async (e) => {
    const file = e.target.files[0]; e.target.value = ''; if (!file) return;
    const note = prompt('Optional: a short note about this file (what it is, when to use it)', '') || '';
    const fd = new FormData(); fd.append('file', file); fd.append('note', note);
    toast('Uploading and reading…');
    try { const d = await api(`/api/docs/${target}`, { method: 'POST', body: fd }); toast(d.chars ? `Added – ${(d.chars / 1000).toFixed(1)}k characters read` : 'Added, but no text could be read from it', !d.chars); setAgents(body); } catch (err) { fail(err); }
  });
  $$('[data-deldoc]', body).forEach((b) => b.addEventListener('click', async () => { if (confirm('Remove this file from the agent\'s folder?')) { await api(`/api/docs/${b.dataset.deldoc}`, { method: 'DELETE' }); setAgents(body); } }));
  $$('.agent-form', body).forEach((f) => f.addEventListener('submit', async (e) => { e.preventDefault(); await api(`/api/agents/${f.dataset.agent}/config`, { method: 'PUT', body: formData(f) }); await loadMeta(); toast('Saved'); Drawer.agent = null; Drawer.setAgent(PAGE_AGENT[state.tab], state.tab === 'productivity'); }));
  $$('[data-hear]', body).forEach((b) => b.addEventListener('click', () => { const a = agentInfo(b.dataset.hear); Voice.speak(`Hi Loshem, I'm ${a.name}, your ${a.title}.`, b.dataset.hear, b); }));
  $('#factForm').addEventListener('submit', async (e) => { e.preventDefault(); const t = e.target.text.value.trim(); if (!t) return; await api('/api/facts', { method: 'POST', body: { text: t } }); setAgents(body); });
  $$('[data-delfact]', body).forEach((b) => b.addEventListener('click', async () => { await api(`/api/facts/${b.dataset.delfact}`, { method: 'DELETE' }); setAgents(body); }));
}
function setBusiness(body) {
  const s = state.meta.settings;
  body.innerHTML = `<div class="card" style="max-width:760px"><form id="bizForm" class="form-grid">
    <label class="wide">Business name<input name="business_name" value="${esc(s.business_name)}"></label>
    <label>Home city<input name="business_city" value="${esc(s.business_city || '')}"></label>
    <label>Monthly revenue goal<input type="number" name="goal_monthly_revenue" value="${s.goal_monthly_revenue || ''}"></label>
    <label>Daily $ target<input type="number" name="daily_target" value="${s.daily_target || ''}"></label>
    <label>Default markup on client materials %<input type="number" step="0.5" name="default_markup_pct" value="${s.default_markup_pct || ''}"></label>
    <label>"Due upon receipt" overdue after (days)<input type="number" min="0" name="receipt_grace_days" value="${s.receipt_grace_days ?? 14}"></label>
  </form><p class="note">Tax assumptions (filing status, rates, mileage) live on the Taxes tab under Assumptions.</p>
  <div class="foot"><button class="btn primary" id="bizSave">Save</button></div></div>`;
  $('#bizSave').addEventListener('click', async () => { await api('/api/settings', { method: 'PUT', body: formData($('#bizForm')) }); toast('Saved'); loadMeta(); });
}
async function setConnections(body) {
  const sec = await api('/api/security');
  const tokens = sec.tokens.filter((t) => t.scope === 'invoice-app');
  body.innerHTML = `<div class="grid g2">
    <div class="card"><h3>LuxCraft invoice & estimate app</h3>
      <p><span class="chip paid">built in</span> The invoice and estimate app now lives on the <button class="link" data-go="invoicing">Invoicing</button> tab and saves straight into the Cockpit, so there's nothing to connect or sync.</p>
      <p class="note">Moving over from the old standalone app: open it, use <b>Settings → Export backup</b> on both its Invoices and Estimates pages, then in the Invoicing tab use <b>Settings → Import backup</b> with each file (or upload them on Financials → Invoices → Import app backup).</p>
      ${tokens.length ? `<p class="note">Old standalone-app connection keys (no longer used):</p><div class="list">${tokens.map((t) => `<div class="li"><div><b>${esc(t.label)}</b><div class="meta">${esc(t.origin || 'any origin')} · ${t.last_used ? `last used ${new Date(t.last_used).toLocaleString()}` : 'never used'}</div></div><button class="btn sm ghost danger" data-revoke="${t.id}">Remove</button></div>`).join('')}</div>` : ''}</div>
    <div class="card"><h3>Website leads</h3><p class="note">Ready for later: once the website is updated, it can send new leads here and they'll appear on the Jobs tab as leads. Create a key for it then.</p><button class="btn" id="leadTok">Create website key</button></div></div>`;
  wireGoTo(body);
  $('#leadTok').addEventListener('click', async () => { try { const { token } = await api('/api/security/tokens', { method: 'POST', body: { scope: 'leads', label: 'Website leads' } }); showToken(token); } catch (err) { fail(err); } });
  $$('[data-revoke]', body).forEach((b) => b.addEventListener('click', async () => { if (confirm('Disconnect? That app will stop syncing until you create a new key.')) { await api(`/api/security/tokens/${b.dataset.revoke}`, { method: 'DELETE' }); setConnections(body); } }));
  function showToken(token) {
    openModal(`<h2>Connection key</h2><p>Copy this now – it won't be shown again.</p><div class="token-box mono">${esc(token)}</div>
      <p class="note">Cockpit address to enter alongside it: <span class="mono">${esc(location.origin)}</span></p>
      <div class="foot"><button class="btn" id="copyTok">Copy</button><button class="btn primary" data-close>Done</button></div>`, () => $('#copyTok').addEventListener('click', async () => { await navigator.clipboard.writeText(token); toast('Copied'); }));
    setConnections(body);
  }
}
async function setSecurity(body) {
  const s = await api('/api/security');
  body.innerHTML = `<div class="grid g2">
    <div class="card"><h3>Login protection</h3><div class="list">
      <div class="li"><span>Two-factor login (authenticator app)</span>${s.two_factor ? `<span class="chip paid">on · ${s.recovery_left} recovery codes left</span>` : '<span class="chip overdue">off</span>'}</div>
      <div class="li"><span>Password strength</span><span class="chip ${s.password_strength === 'weak' ? 'overdue' : 'paid'}">${s.password_strength}</span></div>
      <div class="li"><span>Encrypted connection (HTTPS)</span><span class="chip ${s.https ? 'paid' : 'overdue'}">${s.https ? 'yes' : 'no'}</span></div>
      <div class="li"><span>Files & documents encrypted at rest</span><span class="chip paid">AES-256</span></div></div>
      ${s.two_factor ? '<button class="btn" id="tfaOff" style="margin-top:12px">Turn off two-factor</button>' : '<button class="btn primary" id="tfaOn" style="margin-top:12px">Turn on two-factor login</button>'}
      ${s.password_strength === 'weak' ? '<p class="note warn-text">Use a password of 16+ characters: change ADMIN_PASSWORD in Railway → Variables.</p>' : ''}</div>
    <div class="card"><div class="row" style="justify-content:space-between"><h3>Signed-in devices</h3><button class="btn sm" id="revokeOthers">Sign out other devices</button></div>
      <div class="list">${s.sessions.map((x) => `<div class="li"><div>${esc((x.user_agent || '').replace(/\(.*?\)/g, '').slice(0, 60) || 'Device')}${x.current ? ' <span class="chip paid">this device</span>' : ''}<div class="meta">${esc(x.ip || '')} · last active ${new Date(x.last_seen).toLocaleString()}</div></div></div>`).join('')}</div></div>
    <div class="card" style="grid-column:1/-1"><h3>Activity log</h3>${miniTable(['When', 'Event', 'Detail', 'IP'], s.audit.map((a) => [new Date(a.at).toLocaleString(), a.event, a.detail || '', a.ip || '']))}</div></div>`;
  $('#revokeOthers').addEventListener('click', async () => { const r = await api('/api/security/sessions/revoke-others', { method: 'POST' }); toast(`Signed out ${r.revoked} other sessions`); setSecurity(body); });
  $('#tfaOff')?.addEventListener('click', async () => { const code = prompt('Enter a current 6-digit code from your authenticator app'); if (!code) return; try { await api('/api/security/2fa/disable', { method: 'POST', body: { code } }); toast('Two-factor turned off'); setSecurity(body); } catch (e) { fail(e); } });
  $('#tfaOn')?.addEventListener('click', async () => {
    const r = await api('/api/security/2fa/setup', { method: 'POST' });
    openModal(`<h2>Turn on two-factor login</h2><ol class="steps"><li>Open an authenticator app (Google Authenticator, 1Password, Authy…).</li><li>Scan this code, or enter the key by hand.</li><li>Type the 6-digit code it shows.</li></ol>
      <div class="qr">${r.qr}</div><div class="token-box mono">${esc(r.secret)}</div>
      <form id="tfaForm" class="row" style="margin-top:12px"><input name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" maxlength="6" style="max-width:140px" required><button class="btn primary">Turn on</button></form>`, () => {
      $('#tfaForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const out = await api('/api/security/2fa/enable', { method: 'POST', body: { code: e.target.code.value } });
          openModal(`<h2>Two-factor is on</h2><p>Save these recovery codes somewhere safe (not on this computer). Each one works once if you lose your phone.</p>
            <div class="token-box mono codes">${out.recovery_codes.map(esc).join('<br>')}</div><div class="foot"><button class="btn" id="copyCodes">Copy</button><button class="btn primary" data-close>I saved them</button></div>`,
          () => $('#copyCodes').addEventListener('click', async () => { await navigator.clipboard.writeText(out.recovery_codes.join('\n')); toast('Copied'); }));
          setSecurity(body);
        } catch (err) { fail(err); }
      });
    });
  });
}
function setCategories(body) {
  const lines = state.meta.line_labels;
  body.innerHTML = `<div class="card"><div class="row" style="justify-content:space-between"><h3>Categories → tax lines</h3><button class="btn sm" id="catNew">+ Category</button></div>
    <div class="table-wrap"><table><thead><tr><th>Category</th><th>Type</th><th>Tax line</th><th class="hide-sm">Notes</th><th>Active</th></tr></thead><tbody>
    ${state.meta.categories.map((c) => `<tr><td><b>${esc(c.name)}</b></td><td><span class="chip ${c.kind}">${c.kind}</span></td>
      <td><select data-cl="${c.id}" style="min-width:220px">${Object.entries(lines).map(([k, l]) => `<option value="${k}" ${c.sched_c === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></td>
      <td class="hide-sm note">${esc(c.note || '')}</td><td><input type="checkbox" data-ca="${c.id}" ${c.active ? 'checked' : ''} class="cb"></td></tr>`).join('')}</tbody></table></div></div>`;
  $$('[data-cl]', body).forEach((s2) => s2.addEventListener('change', () => api(`/api/categories/${s2.dataset.cl}`, { method: 'PUT', body: { sched_c: s2.value } }).then(() => toast('Updated')).catch(fail)));
  $$('[data-ca]', body).forEach((cb) => cb.addEventListener('change', () => api(`/api/categories/${cb.dataset.ca}`, { method: 'PUT', body: { active: cb.checked } }).then(loadMeta).catch(fail)));
  $('#catNew').addEventListener('click', () => openModal(`<h2>New category</h2><form id="catForm" class="form-grid">
    <label class="wide">Name<input name="name" required></label><label>Type<select name="kind"><option value="expense">expense</option><option value="income">income</option></select></label>
    <label>Tax line<select name="sched_c">${Object.entries(lines).map(([k, l]) => `<option value="${k}" ${k === 'L27a' ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
    <label class="wide">Notes<input name="note"></label></form><div class="foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="catSave">Add</button></div>`,
  () => $('#catSave').addEventListener('click', async () => { const f = $('#catForm'); if (!f.reportValidity()) return; try { await api('/api/categories', { method: 'POST', body: formData(f) }); closeModal(); await loadMeta(); setCategories(body); } catch (err) { fail(err); } })));
}
function setData(body) {
  const y = today().slice(0, 4);
  body.innerHTML = `<div class="card" style="max-width:760px"><h3>Exports</h3><div class="row">
    <a class="btn" href="/api/export/transactions.csv?year=${y}">Ledger CSV</a><a class="btn" href="/api/export/tax.csv?year=${y}">Tax summary CSV</a>
    <a class="btn" href="/api/export/mileage.csv?year=${y}">Mileage CSV</a><a class="btn" href="/api/export/time.csv?year=${y}">Hours CSV</a><a class="btn" href="/api/export/backup.json">Full backup (JSON)</a></div>
    <p class="note">The full backup covers your books, jobs, invoices, estimates, hours, logs and team memory (not uploaded files). Railway also keeps database backups.</p>
    <h3 style="margin-top:18px">Agent model</h3><p class="note">${state.meta.ai_enabled ? `Agents use <span class="mono">${esc(state.meta.model)}</span>.` : 'Add ANTHROPIC_API_KEY to turn on the agents.'}</p></div>`;
}
