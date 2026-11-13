/* LuxCraft Cockpit – Overview and Financials */

// ================= OVERVIEW =================
state.pages.overview = async function renderOverview() {
  const el = $('#tab-overview');
  const [o, a] = await Promise.all([api('/api/overview'), api('/api/analytics?' + new URLSearchParams(periodRange('12m')))]);
  const th = chartTheme();
  const goal = o.goal_monthly_revenue;
  const log = o.today_log; const goals = log ? log.goals : [];
  const home = agentInfo('home');
  const hour = new Date().getHours();
  el.innerHTML = `
    <div class="page-head"><div><h2>Good ${hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'}, Loshem</h2><div class="sub-title">${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</div></div>
      <div class="row"><button class="btn" data-go="productivity">Daily check-in</button><button class="btn primary" id="ovReceipt">📷 Snap receipt</button></div></div>
    <div class="card briefing-card" id="briefing">
      <div class="row" style="justify-content:space-between"><div class="row"><span class="avatar">${initials(home.name)}</span><div><b>${esc(home.name)}'s briefing</b><div class="note">${esc(home.title)}</div></div></div>
        <div class="row"><button class="icon-btn speak" id="briefSpeak" title="Read aloud">🔊</button><button class="btn sm" id="briefReply">Reply</button></div></div>
      <div class="brief-body" id="briefBody">${state.meta.ai_enabled ? '<p class="note"><span class="spinner"></span> Preparing today\'s briefing…</p>' : '<p class="note">Add ANTHROPIC_API_KEY in Railway to get a daily briefing from your Chief of Staff.</p>'}</div>
    </div>
    <div class="kpis">
      <div class="kpi accent"><div class="l">Revenue · this month</div><div class="v">${money0(o.month.income)}</div>
        <div class="s">Last month ${money0(o.last_month.income)}</div>
        ${goal ? `<div class="progress"><span style="width:${Math.min(100, (o.month.income / goal) * 100)}%"></span></div><div class="s">${pct(o.month.income / goal)} of ${money0(goal)} goal</div>` : ''}</div>
      <div class="kpi"><div class="l">Expenses · this month</div><div class="v">${money0(o.month.expense)}</div><div class="s">${o.month.top_expenses[0] ? `Top: ${esc(o.month.top_expenses[0].category)}` : 'Nothing logged yet'}</div></div>
      <div class="kpi"><div class="l">Profit · this month</div><div class="v ${o.month.profit < 0 ? 'neg' : ''}">${money0(o.month.profit)}</div><div class="s">YTD ${money0(o.ytd.profit)}${o.ytd.my_hours ? ` · ${money0(o.ytd.profit / o.ytd.my_hours)}/hr` : ''}</div></div>
      <div class="kpi"><div class="l">Owed to you</div><div class="v">${money0(o.receivables.total)}</div><div class="s">${o.receivables.count} open${o.receivables.overdue ? ` · <span class="down">${o.receivables.overdue} overdue</span>` : ''}${o.unbilled ? ` · ${money0(o.unbilled)} unbilled materials` : ''}</div></div>
      ${o.backlog.shown !== false ? `<div class="kpi"><div class="l">Still to bill</div><div class="v">${money0(o.backlog.to_bill)}</div><div class="s">scheduled draws · ${o.backlog.jobs} active job${o.backlog.jobs === 1 ? '' : 's'}</div></div>` : ''}
      <div class="kpi"><div class="l">Tax set-aside left</div><div class="v">${money0(Math.max(0, o.tax.remaining))}</div><div class="s">${o.tax.next_deadline ? `${o.tax.next_deadline.q} due ${fmtDate(o.tax.next_deadline.due)}` : ''}</div></div>
      <div class="kpi"><div class="l">Last 7 days</div><div class="v">${money0(o.week.est_earned)}</div><div class="s">est. earned · goals met ${o.week.days_met}/${o.week.days_judged || 0} days</div></div>
    </div>
    ${o.backlog.flags.length ? `<div class="callout" style="margin-bottom:14px"><b>Check your Paid marks:</b> ${o.backlog.flags.map(esc).join(' · ')}</div>` : ''}
    <div class="grid g-main">
      <div class="card"><h3>Income vs expenses · 12 months</h3>${legend([[th.income, 'Income'], [th.expense, 'Expenses']])}<div class="chart-box"><canvas id="ovChart"></canvas></div></div>
      <div class="card"><div class="row" style="justify-content:space-between"><h3>Today's plan</h3><button class="link" data-go="productivity">Open</button></div>
        ${goals.length ? goals.map((g, i) => `<div class="goal ${g.done ? 'done' : ''}"><input type="checkbox" data-goal="${i}" ${g.done ? 'checked' : ''}><span class="t">${g.worker && g.worker !== 'Me' ? `<span class="chip">${esc(g.worker)}</span> ` : ''}${esc(g.text)}</span>${g.est_value ? `<span class="val num">${money0(g.est_value)}</span>` : ''}</div>`).join('')
          : `<p class="note">No plan for today yet. Tell ${esc(agentInfo('daily').name)} what you and the crew are working on.</p><button class="btn" data-go="productivity">Plan my day</button>`}
      </div>
    </div>
    <div class="grid g2" style="margin-top:14px">
      <div class="card"><div class="row" style="justify-content:space-between"><h3>Unpaid invoices</h3><button class="link" data-gosub="invoices">All invoices</button></div>
        ${o.receivables.items.length ? `<div class="list">${o.receivables.items.map((i) => `<div class="li"><div><b>${esc(i.invoice_no)}</b> · ${esc(i.client || i.job_name || '')}<div class="meta">${i.days_out ?? '—'} days out ${i.due_date ? `· due ${fmtDate(i.due_date)}` : ''}</div></div><div style="text-align:right"><div class="num">${money(i.balance)}</div><span class="chip ${i.status}">${i.status}</span></div></div>`).join('')}</div>`
          : '<p class="note">Nothing outstanding.</p>'}</div>
      <div class="card"><div class="row" style="justify-content:space-between"><h3>Recent activity</h3><button class="link" data-gosub="ledger">Ledger</button></div>
        ${o.recent.length ? `<div class="list">${o.recent.map((t) => `<div class="li"><div><span class="kind-bar" style="background:var(--${t.kind})"></span>${esc(t.party || t.category)}<div class="meta">${fmtDate(t.date)} · ${esc(t.category)}${t.job_name ? ' · ' + esc(t.job_name) : ''}</div></div><div class="num">${t.kind === 'expense' ? '−' : '+'}${money(t.amount)}</div></div>`).join('')}</div>`
          : '<p class="note">No transactions yet. Use the + button to add your first.</p>'}</div>
    </div>`;
  makeChart('ovChart', { type: 'bar', data: { labels: a.series.map((s) => monthLabel(s.month)),
    datasets: [{ label: 'Income', data: a.series.map((s) => s.income), ...barStyle(th.income) }, { label: 'Expenses', data: a.series.map((s) => s.expense), ...barStyle(th.expense) }] },
  options: { datasets: { bar: { categoryPercentage: 0.7, barPercentage: 0.9 } } } });
  $('#ovReceipt').addEventListener('click', () => $('#receiptInput').click());
  $('#briefReply').addEventListener('click', () => { Drawer.toggle(true); });
  wireGoTo(el);
  $$('[data-goal]', el).forEach((cb) => cb.addEventListener('change', async () => {
    const gs = log.goals.map((g, i) => (i === Number(cb.dataset.goal) ? { ...g, done: cb.checked } : g));
    await api(`/api/daily-logs/${log.date}`, { method: 'PUT', body: { ...log, goals: gs } }); state.pages.overview();
  }));
  if (state.meta.ai_enabled) loadBriefing();
};
async function loadBriefing() {
  try {
    const r = await api('/api/agents/home/opener', { method: 'POST' });
    const m = r.message || r;
    const body = $('#briefBody'); if (!body || !m || !m.text) return;
    const el = msgEl(m, 'home');
    body.innerHTML = ''; body.appendChild(el); updateAllButtons();
    $('#briefSpeak').addEventListener('click', (e) => Voice.speak(m.text, 'home', e.currentTarget));
    if (!r.skipped && lsGet('lc-autoread', false)) Voice.speak(m.text, 'home', $('#briefSpeak'));
    if (Drawer.agent === 'home' && Drawer.chat && Drawer.open) Drawer.chat.load();
  } catch (e) { const b = $('#briefBody'); if (b) b.innerHTML = `<p class="note">Couldn't prepare the briefing: ${esc(e.message)}</p>`; }
}

// ================= LEDGER =================
state.pages['fin-ledger'] = async function renderLedger() {
  const el = $('#fin-ledger');
  const f = state.ledgerFilter;
  const range = f.period === 'custom' ? { from: f.from, to: f.to } : periodRange(f.period);
  const params = new URLSearchParams(Object.entries({ ...range, kind: f.kind, category: f.category, job_id: f.job_id, search: f.search, billable: f.billable }).filter(([, v]) => v));
  const rows = await api('/api/transactions?' + params);
  const inc = rows.filter((r) => r.kind === 'income' && r.category !== AWAITING).reduce((s, r) => s + r.amount, 0);
  const awaiting = rows.filter((r) => r.category === AWAITING);
  const awaitingSum = awaiting.reduce((s, r) => s + r.amount, 0);
  const exp = rows.filter((r) => r.kind === 'expense').reduce((s, r) => s + r.amount, 0);
  const qk = state.quickKind || 'expense';
  el.innerHTML = `
    <div class="card quick">
      <div class="row" style="justify-content:space-between;margin-bottom:12px"><h3 style="margin:0">Quick entry</h3>
        <div class="row"><div class="seg" id="qkSeg"><button type="button" data-k="expense" class="${qk === 'expense' ? 'on-expense' : ''}">Expense</button><button type="button" data-k="income" class="${qk === 'income' ? 'on-income' : ''}">Income</button></div>
        <button class="btn" id="qkReceipt">📷 Receipt</button><button class="btn" id="qkSplit">Split…</button></div></div>
      <form id="qkForm" class="form-grid">
        <label>Date<input type="date" name="date" value="${today()}" required></label>
        <label>Amount<input type="number" name="amount" step="0.01" min="0.01" inputmode="decimal" placeholder="0.00" required></label>
        <label>Category<select name="category">${catOptions(qk, qk === 'income' ? 'Contract Revenue' : 'Materials')}</select></label>
        <label>Job<select name="job_id">${jobOptions(f.job_id)}</select></label>
        <label>${qk === 'income' ? 'Paid by' : 'Vendor / payee'}<input name="party" list="partyList"></label>
        <label>Method<select name="method">${methodOptions(qk === 'income' ? 'check' : '')}</select></label>
        <label>Check #<input name="check_no" inputmode="numeric"></label>
        ${qk === 'income' ? '<p class="note wide" style="margin:0">Invoice payments go on the <button type="button" class="link" data-go="invoicing">Invoicing tab</button> (click the invoice\'s Unpaid button). Add income here only when there was no invoice.</p>' : `<label class="check-label"><input type="checkbox" name="billable"> Client reimburses</label>`}
        <label class="wide">Memo<input name="memo" placeholder="Optional note"></label>
        <label>&nbsp;<button class="btn primary" type="submit">Add ${qk}</button></label>
      </form>
      <datalist id="partyList"></datalist><datalist id="invList"></datalist>
    </div>
    <div class="filters">
      <select id="fPeriod">${[['month', 'This month'], ['lastmonth', 'Last month'], ['30', 'Last 30 days'], ['ytd', 'Year to date'], ['lastyear', 'Last year'], ['all', 'All time'], ['custom', 'Custom…']].map(([v, l]) => `<option value="${v}" ${f.period === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      ${f.period === 'custom' ? `<input type="date" id="fFrom" value="${f.from || ''}"><input type="date" id="fTo" value="${f.to || ''}">` : ''}
      <select id="fKind"><option value="">Income & expenses</option><option value="income" ${f.kind === 'income' ? 'selected' : ''}>Income</option><option value="expense" ${f.kind === 'expense' ? 'selected' : ''}>Expenses</option></select>
      <select id="fCat"><option value="">All categories</option>${catOptions(null, f.category)}</select>
      <select id="fJob">${jobOptions(f.job_id, 'All jobs')}</select>
      <select id="fBill"><option value="">All</option><option value="unbilled" ${f.billable === 'unbilled' ? 'selected' : ''}>Unbilled reimbursables</option></select>
      <input type="search" id="fSearch" placeholder="Search vendor, memo, check #, invoice…" value="${esc(f.search || '')}">
      <a class="btn" href="/api/export/transactions.csv?year=${(range.from || today()).slice(0, 4)}">Export CSV</a>
    </div>
    <div class="kpis" style="grid-template-columns:repeat(4,minmax(0,1fr))">
      <div class="kpi"><div class="l">Income received</div><div class="v">${money(inc)}</div></div>
      <div class="kpi"><div class="l">Invoiced, awaiting payment</div><div class="v">${money(awaitingSum)}</div><div class="s">${awaiting.length} invoice${awaiting.length === 1 ? '' : 's'} · not counted until paid</div></div>
      <div class="kpi"><div class="l">Expenses</div><div class="v">${money(exp)}</div></div>
      <div class="kpi"><div class="l">Net (received − expenses)</div><div class="v ${inc - exp < 0 ? 'neg' : ''}">${money(inc - exp)}</div></div>
    </div>
    ${f.billable === 'unbilled' && rows.length ? `<div class="callout row" style="justify-content:space-between;margin-bottom:12px"><span>To bill: <b>${money(rows.reduce((s, t) => s + t.amount * (1 + (t.markup_pct || 0) / 100), 0))}</b> including markup.</span><button class="btn sm" id="markBilled">Mark these billed</button></div>` : ''}
    <div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>Description</th><th class="hide-sm">Category</th><th class="hide-sm">Job</th><th class="hide-sm">Ref</th><th class="n">Amount</th><th></th></tr></thead>
      <tbody>${rows.length ? rows.map((t) => `<tr>
        <td class="mono">${fmtDate(t.date)}</td>
        <td><span class="kind-bar" style="background:var(--${t.kind})"></span>${esc(t.party || '—')}
          ${t.split_group ? '<span class="tag" title="Part of a split receipt">split</span>' : ''}${t.billable ? `<span class="tag ${t.billed ? '' : 'warn'}">${t.billed ? 'billed' : 'to bill'}${t.markup_pct ? ` +${t.markup_pct}%` : ''}</span>` : ''}${t.untaxed ? '<span class="tag warn" title="No sales tax charged">no tax</span>' : ''}${t.reconciled ? '<span class="tag ok" title="Matched to bank statement">✓ bank</span>' : ''}${t.created_by === 'agent' ? '<span class="tag">agent</span>' : ''}${t.created_by === 'sync' ? (t.category === AWAITING ? '<span class="tag warn" title="Synced from the invoice app">invoice · awaiting payment</span>' : '<span class="tag ok" title="Synced from the invoice app">invoice · paid</span>') : ''}
          ${t.memo ? `<div class="note">${esc(t.memo)}</div>` : ''}</td>
        <td class="hide-sm"><span class="chip ${t.kind}">${esc(t.category)}</span></td>
        <td class="hide-sm">${esc(t.job_name || '')}</td>
        <td class="hide-sm mono">${[t.check_no ? '#' + esc(t.check_no) : '', esc(t.invoice_no || '')].filter(Boolean).join(' · ')}</td>
        <td class="n ${t.category === AWAITING ? 'awaiting' : ''}">${t.kind === 'expense' ? '−' : '+'}${money(t.amount)}</td>
        <td class="actions">${t.attachment_id ? `<a class="btn sm ghost" href="/api/attachments/${t.attachment_id}" target="_blank" rel="noopener" title="View receipt">🧾</a>` : ''}<button class="btn sm ghost" data-edit="${t.id}">Edit</button></td></tr>`).join('')
        : '<tr><td colspan="7" class="empty">No transactions in this view.</td></tr>'}</tbody>
    </table></div>`;
  $('#qkSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { state.quickKind = b.dataset.k; renderLedger(); } });
  $('#qkReceipt').addEventListener('click', () => $('#receiptInput').click());
  $('#qkSplit').addEventListener('click', () => txModal({ kind: qk, date: today() }, { split: true }));
  $('#qkForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { ...formData(e.target), kind: qk };
    if (body.billable) body.markup_pct = state.meta.settings.default_markup_pct;
    try { await api('/api/transactions', { method: 'POST', body }); toast(`${qk === 'income' ? 'Income' : 'Expense'} added`); renderLedger(); } catch (err) { fail(err); }
  });
  const set = (k, v) => { state.ledgerFilter[k] = v; renderLedger(); };
  $('#fPeriod').addEventListener('change', (e) => set('period', e.target.value));
  $('#fKind').addEventListener('change', (e) => set('kind', e.target.value));
  $('#fCat').addEventListener('change', (e) => set('category', e.target.value));
  $('#fJob').addEventListener('change', (e) => set('job_id', e.target.value));
  $('#fBill').addEventListener('change', (e) => set('billable', e.target.value));
  let st; $('#fSearch').addEventListener('input', (e) => { clearTimeout(st); st = setTimeout(() => { set('search', e.target.value); setTimeout(() => { const s = $('#fSearch'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }); }, 400); });
  if ($('#fFrom')) { $('#fFrom').addEventListener('change', (e) => set('from', e.target.value)); $('#fTo').addEventListener('change', (e) => set('to', e.target.value)); }
  if ($('#markBilled')) $('#markBilled').addEventListener('click', async () => { await api('/api/transactions/mark-billed', { method: 'POST', body: { ids: rows.map((r) => r.id) } }); toast('Marked billed'); renderLedger(); });
  $$('[data-edit]', el).forEach((b) => b.addEventListener('click', () => txModal(rows.find((r) => r.id === Number(b.dataset.edit)))));
  wireGoTo(el);
  $('#partyList').innerHTML = [...new Set(rows.map((r) => r.party).filter(Boolean))].slice(0, 60).map((p) => `<option value="${esc(p)}">`).join('');
};

// Add/edit transaction, with split mode, reimbursable materials and sales tax.
function txModal(t = {}, opts = {}) {
  const kind = t.kind || 'expense';
  const isEdit = !!t.id;
  const split = !!opts.split && !isEdit;
  const parts = opts.parts || [{ amount: '', category: kind === 'income' ? 'Contract Revenue' : 'Materials', job_id: t.job_id || '' }, { amount: '', category: kind === 'income' ? 'Contract Revenue' : 'Tools & Small Equipment', job_id: '' }];
  const partRow = (p = {}) => `<div class="split-row">
      <input type="number" step="0.01" class="sp-amt" placeholder="Amount" value="${p.amount ?? ''}">
      <select class="sp-cat">${catOptions(kind, p.category)}</select>
      <select class="sp-job">${jobOptions(p.job_id)}</select>
      ${kind === 'expense' ? `<label class="check-label sm"><input type="checkbox" class="sp-bill" ${p.billable ? 'checked' : ''}> bill</label>` : ''}
      <button type="button" class="btn sm ghost sp-rm" title="Remove">✕</button></div>`;
  openModal(`
    <h2>${isEdit ? 'Edit' : 'New'} ${kind === 'income' ? 'income' : 'expense'}${split ? ' · split' : ''}</h2>
    ${opts.aiNote ? `<div class="ai-note">${opts.aiNote}</div>` : ''}
    ${t.split_group && isEdit ? '<div class="ai-note">This line is one part of a split receipt. Editing changes only this part.</div>' : ''}
    ${kind === 'income' && !isEdit ? '<div class="ai-note">Payments for invoices are recorded on the Invoicing tab (click the invoice\'s Unpaid button), so they\'re only counted once. Use this only for money that had no invoice.</div>' : ''}
    ${t.created_by === 'sync' && isEdit ? '<div class="ai-note">Synced from the invoice app. The amount, dates and check # follow the invoice on every sync, so change those in the invoice app. Once it is paid, you can change its category here.</div>' : ''}
    <form id="txForm" class="form-grid">
      <label>Date<input type="date" name="date" value="${t.date || today()}" required></label>
      <label>${split ? 'Receipt total' : 'Amount'}<input type="number" name="${split ? 'total' : 'amount'}" step="0.01" min="0.01" value="${t.amount ?? ''}" inputmode="decimal" ${split ? '' : 'required'}></label>
      ${split ? '' : `<label>Category<select name="category">${catOptions(kind, t.category)}</select></label><label>Job<select name="job_id">${jobOptions(t.job_id)}</select></label>`}
      <label>${kind === 'income' ? 'Paid by' : 'Vendor / payee'}<input name="party" value="${esc(t.party || '')}"></label>
      <label>Method<select name="method">${methodOptions(t.method)}</select></label>
      <label>Check #<input name="check_no" value="${esc(t.check_no || '')}"></label>
      ${kind === 'income' && isEdit && t.invoice_no ? `<label>Invoice #<input name="invoice_no" value="${esc(t.invoice_no || '')}"></label>` : ''}
      ${kind === 'expense' ? `<label>Sales tax paid<input type="number" step="0.01" name="sales_tax" value="${t.sales_tax ?? ''}"></label>
        <label class="check-label"><input type="checkbox" name="untaxed" ${t.untaxed ? 'checked' : ''}> No sales tax charged</label>` : ''}
      ${kind === 'expense' && !split ? `<label class="check-label"><input type="checkbox" name="billable" ${t.billable ? 'checked' : ''}> Client reimburses</label>
        <label>Markup %<input type="number" step="0.5" name="markup_pct" value="${t.markup_pct ?? (t.billable ? '' : state.meta.settings.default_markup_pct || '')}"></label>
        ${isEdit && t.billable ? `<label class="check-label"><input type="checkbox" name="billed" ${t.billed ? 'checked' : ''}> Already billed</label>` : ''}` : ''}
      <label class="wide">Memo<input name="memo" value="${esc(t.memo || '')}"></label>
      <input type="hidden" name="attachment_id" value="${t.attachment_id || ''}">
    </form>
    ${split ? `<h3 style="margin-top:16px">Parts</h3><div id="splitRows">${parts.map(partRow).join('')}</div>
      <div class="row" style="justify-content:space-between;margin-top:8px"><button type="button" class="btn sm" id="addPart">+ Part</button><span class="note" id="splitLeft"></span></div>` : ''}
    ${t.attachment_id ? `<p class="note">🧾 <a href="/api/attachments/${t.attachment_id}" target="_blank" rel="noopener">View attached file</a></p>` : ''}
    <div class="foot">${isEdit ? '<button class="btn danger ghost" id="txDel">Delete</button><span class="grow"></span>' : ''}
      ${!isEdit && !split ? '<button class="btn ghost" id="txToSplit">Split…</button><span class="grow"></span>' : ''}
      <button class="btn" data-close>Cancel</button><button class="btn primary" id="txSave">${isEdit ? 'Save' : 'Add'}</button></div>`, (m) => {
    if (split) {
      const left = () => {
        const total = Number($('[name=total]', m).value || 0);
        const sum = $$('.sp-amt', m).reduce((s, i) => s + Number(i.value || 0), 0);
        const l = Math.round((total - sum) * 100) / 100;
        $('#splitLeft').textContent = total ? (Math.abs(l) < 0.005 ? 'Parts match the total ✓' : `${money(l)} ${l > 0 ? 'left to assign' : 'over the total'}`) : `Parts total ${money(sum)}`;
      };
      const wire = () => { $$('.sp-rm', m).forEach((b) => (b.onclick = () => { b.parentElement.remove(); left(); })); $$('.sp-amt', m).forEach((i) => (i.oninput = left)); };
      $('#addPart').addEventListener('click', () => { $('#splitRows').insertAdjacentHTML('beforeend', partRow()); wire(); left(); });
      $('[name=total]', m).addEventListener('input', left); wire(); left();
    }
    $('#txToSplit')?.addEventListener('click', () => { const cur = formData($('#txForm')); txModal({ ...t, ...cur, kind }, { split: true }); });
  });
  $('#txSave').addEventListener('click', async () => {
    const f = $('#txForm'); if (!f.reportValidity()) return;
    const body = { ...formData(f), kind };
    try {
      if (split) {
        body.parts = $$('.split-row').map((r) => ({ amount: $('.sp-amt', r).value, category: $('.sp-cat', r).value, job_id: $('.sp-job', r).value,
          billable: !!$('.sp-bill', r)?.checked, markup_pct: $('.sp-bill', r)?.checked ? state.meta.settings.default_markup_pct : null })).filter((p) => Number(p.amount) > 0);
        if (!body.total) delete body.total;
        await api('/api/transactions/split', { method: 'POST', body });
      } else if (isEdit) await api(`/api/transactions/${t.id}`, { method: 'PUT', body });
      else await api('/api/transactions', { method: 'POST', body });
      closeModal(); toast('Saved'); render();
    } catch (e) { fail(e); }
  });
  if (isEdit) $('#txDel').addEventListener('click', async () => { if (!confirm('Delete this transaction?')) return; await api(`/api/transactions/${t.id}`, { method: 'DELETE' }); closeModal(); toast('Deleted'); render(); });
}

// Receipt capture → Claude reads it → prefilled expense (or split) form
$('#receiptInput').addEventListener('change', async (e) => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  if (!state.meta.ai_enabled) {
    const fd = new FormData(); fd.append('file', file);
    try { const { id } = await api('/api/attachments', { method: 'POST', body: fd }); txModal({ kind: 'expense', attachment_id: id }, { aiNote: 'Receipt attached. Add ANTHROPIC_API_KEY in Railway to have it read automatically.' }); } catch (err) { fail(err); }
    return;
  }
  openModal('<h2>Reading receipt…</h2><p><span class="spinner"></span> Reading the vendor, date, total, tax and category.</p>');
  try {
    const fd = new FormData(); fd.append('file', file); fd.append('kind', 'receipt');
    const { attachment_id, fields: x } = await api('/api/ai/extract', { method: 'POST', body: fd });
    const job = x.job_hint ? state.meta.jobs.find((j) => j.name.toLowerCase() === x.job_hint.toLowerCase()) : null;
    const base = { kind: 'expense', date: x.date, amount: x.total, category: x.category, party: x.vendor, method: x.method, check_no: x.check_no,
      memo: x.summary, attachment_id, sales_tax: x.sales_tax || '', untaxed: x.sales_tax === 0, job_id: job ? job.id : (state.ledgerFilter.job_id || '') };
    const note = `Read by Claude (${x.confidence} confidence)${x.sales_tax ? ` · ${money(x.sales_tax)} sales tax` : ''}. Check it, pick the job, then save.`;
    if (x.mixed && Array.isArray(x.line_groups) && x.line_groups.length > 1) {
      txModal(base, { split: true, parts: x.line_groups.map((g) => ({ amount: g.amount, category: g.category, job_id: base.job_id })), aiNote: `${note} This receipt mixes categories, so it's set up as a split.` });
    } else txModal(base, { aiNote: note });
  } catch (err) { closeModal(); fail(err); }
});

// ================= INVOICES =================
state.pages['fin-invoices'] = async function renderInvoices() {
  const el = $('#fin-invoices');
  const all = await api('/api/invoices');
  const voided = all.filter((i) => i.status === 'void' && i.counted);
  const outside = all.filter((i) => !i.counted && i.status !== 'void');
  const inv = all.filter((i) => i.counted && (state.showVoid || i.status !== 'void'));
  const unpaid = inv.filter((i) => ['open', 'partial', 'overdue'].includes(i.status));
  el.innerHTML = `
    <div class="page-head"><div><h2>Invoices</h2><div class="sub-title">Straight from the Invoicing tab – the only place invoices and their payments are entered. Record a payment there by clicking an invoice's Unpaid button.</div></div>
      <div class="row"><button class="btn" id="invBackup" title="Upload the invoice or estimate app's Export backup file">⇪ Import app backup</button><button class="btn primary" data-go="invoicing">Open Invoicing</button></div></div>
    <div class="kpis">
      <div class="kpi accent"><div class="l">Outstanding</div><div class="v">${money(unpaid.reduce((a, i) => a + i.balance, 0))}</div><div class="s">${unpaid.length} invoices</div></div>
      <div class="kpi"><div class="l">Overdue</div><div class="v ${inv.some((i) => i.status === 'overdue') ? 'neg' : ''}">${money(inv.filter((i) => i.status === 'overdue').reduce((a, i) => a + i.balance, 0))}</div><div class="s">${inv.filter((i) => i.status === 'overdue').length} past due</div></div>
      <div class="kpi"><div class="l">Avg. days to get paid</div><div class="v">${avgDaysToPay(inv)}</div></div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Invoice</th><th>Client / job</th><th class="hide-sm">Issued</th><th class="hide-sm">Due</th><th class="n">Amount</th><th class="n hide-sm">Paid</th><th class="n">Balance</th><th>Status</th><th></th></tr></thead>
      <tbody>${inv.length ? inv.map((i) => `<tr>
        <td class="mono"><b>${esc(i.invoice_no)}</b>${i.source !== 'manual' ? ' <span class="tag">synced</span>' : ''}${i.draw_no ? `<div class="note">Draw ${i.draw_no} of ${i.draw_count}${i.draw_label ? ` · ${esc(i.draw_label)}` : ''}</div>` : i.draw_label ? `<div class="note">${esc(i.draw_label)}</div>` : ''}</td>
        <td>${esc(i.client || '')}<div class="note">${esc(i.job_name || '')}</div></td>
        <td class="hide-sm mono">${fmtDate(i.issue_date)}</td><td class="hide-sm mono">${fmtDate(i.due_date)}${i.terms ? `<div class="note">${esc(i.terms)}</div>` : ''}</td>
        <td class="n">${money(i.amount)}${(i.items_total || i.tax) ? `<div class="note">${money(i.draw_amount)} draw${i.items_total ? ` + ${money(i.items_total)} items` : ''}${i.tax ? ` + ${money(i.tax)} tax` : ''}</div>` : ''}</td><td class="n hide-sm" title="${esc((i.payments || []).map((p) => `${p.date} ${money(p.amount)}${p.check_no ? ' #' + p.check_no : ''}`).join('\n'))}">${money(i.paid)}</td>
        <td class="n"><b>${money(i.balance)}</b></td><td><span class="chip ${i.status}">${i.status}</span>${i.days_out > 0 && !['paid', 'void'].includes(i.status) ? `<div class="note">${i.days_out}d out</div>` : ''}</td>
        <td class="actions">${(i.payments || []).length ? `<span class="note">${esc(i.payments.map((p) => `${fmtDate(p.date)}${p.check_no ? ' · Ck ' + p.check_no : ''}`).join(', '))}</span>` : ''}</td></tr>`).join('')
        : '<tr><td colspan="9" class="empty">No invoices yet. Create them on the Invoicing tab, or import the old app\'s backup file.</td></tr>'}</tbody></table></div>
    ${outside.length ? `<div class="card" style="margin-top:14px"><h3>Not from the Invoicing tab · not counted</h3><p class="note">Entered by hand or read from an uploaded PDF before invoices moved into the Cockpit. They're left out of what you're owed. Delete any that are copies of an invoice in the Invoicing tab.</p>
      <div class="list">${outside.map((i) => `<div class="li"><div><b>${esc(i.invoice_no)}</b> · ${esc(i.client || i.job_name || '')}<div class="meta">${fmtDate(i.issue_date)} · ${money(i.amount)}</div></div><div class="row"><button class="btn sm ghost" data-ie="${i.id}">Edit</button><button class="btn sm danger ghost" data-idel="${i.id}">Delete</button></div></div>`).join('')}</div></div>` : ''}
    ${voided.length ? `<p class="note"><button class="link" id="toggleVoid">${state.showVoid ? 'Hide' : 'Show'} ${voided.length} voided / deleted in the invoice app</button></p>` : ''}
    <input type="file" id="backupInput" accept="application/json,.json" hidden>`;
  wireGoTo(el);
  $$('[data-idel]', el).forEach((b) => b.addEventListener('click', async () => { if (!confirm('Delete this invoice? Ledger entries stay.')) return; await api(`/api/invoices/${b.dataset.idel}`, { method: 'DELETE' }); refreshAfterChange(); }));
  $('#toggleVoid')?.addEventListener('click', () => { state.showVoid = !state.showVoid; state.pages['fin-invoices'](); });
  $('#invBackup').addEventListener('click', () => $('#backupInput').click());
  $('#backupInput').addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const fd = new FormData(); fd.append('file', file);
    try { const r = await api('/api/invoices/import-backup', { method: 'POST', body: fd }); toast(`Imported ${r.invoices} invoices and ${r.estimates} estimates · ledger updated${r.renamed && r.renamed.length ? ` · duplicate numbers kept as ${r.renamed.join(', ')}` : ''}${r.skipped && r.skipped.length ? ` · skipped ${r.skipped.length}: ${r.skipped.join('; ')}` : ''}`, !!(r.skipped && r.skipped.length)); refreshAfterChange(); } catch (err) { fail(err); }
  });
  $$('[data-ie]', el).forEach((b) => b.addEventListener('click', () => invoiceModal(all.find((x) => x.id === Number(b.dataset.ie)))));
};
function avgDaysToPay(inv) {
  const d = inv.filter((i) => i.status === 'paid' && i.issue_date && i.payments.length).map((i) => (Date.parse(i.payments[i.payments.length - 1].date) - Date.parse(i.issue_date)) / 86400000);
  return d.length ? `${Math.round(d.reduce((a, b) => a + b, 0) / d.length)} days` : '—';
}
function invoiceModal(i = {}, aiNote) {
  const isEdit = !!i.id;
  openModal(`<h2>${isEdit ? 'Edit invoice' : 'New invoice'}</h2>${aiNote ? `<div class="ai-note">${aiNote}</div>` : ''}
    <form id="invForm" class="form-grid">
      <label>Invoice #<input name="invoice_no" value="${esc(i.invoice_no || '')}" required placeholder="LC-1001"></label>
      <label>Amount<input type="number" step="0.01" name="amount" value="${i.amount ?? ''}" required></label>
      <label>Client<input name="client" value="${esc(i.client || '')}"></label>
      <label>Job<select name="job_id">${jobOptions(i.job_id)}</select></label>
      ${!isEdit ? `<label>…or new job name<input name="job_name" value="${esc(i.job_name && !i.job_id ? i.job_name : '')}"></label>` : ''}
      <label>Issued<input type="date" name="issue_date" value="${i.issue_date || today()}"></label>
      <label>Due<input type="date" name="due_date" value="${i.due_date || ''}"></label>
      <label class="wide">Notes<input name="notes" value="${esc(i.notes || '')}"></label>
      ${isEdit ? `<label class="check-label"><input type="checkbox" name="void" ${i.void ? 'checked' : ''}> Void</label>` : ''}
      <input type="hidden" name="attachment_id" value="${i.attachment_id || ''}">
    </form>
    <div class="foot">${isEdit ? '<button class="btn danger ghost" id="invDel">Delete</button><span class="grow"></span>' : ''}<button class="btn" data-close>Cancel</button><button class="btn primary" id="invSave">Save</button></div>`);
  $('#invSave').addEventListener('click', async () => {
    const f = $('#invForm'); if (!f.reportValidity()) return;
    const body = formData(f);
    if (!body.job_id) delete body.job_id; if (!body.job_name) delete body.job_name;
    try { if (isEdit) await api(`/api/invoices/${i.id}`, { method: 'PUT', body }); else await api('/api/invoices', { method: 'POST', body }); closeModal(); toast('Invoice saved'); refreshAfterChange(); } catch (e) { fail(e); }
  });
  if (isEdit) $('#invDel').addEventListener('click', async () => { if (!confirm('Delete this invoice? Payments stay in the ledger.')) return; await api(`/api/invoices/${i.id}`, { method: 'DELETE' }); closeModal(); render(); });
}
$('#invoiceInput').addEventListener('change', async (e) => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  openModal('<h2>Reading invoice…</h2><p><span class="spinner"></span> Pulling the invoice number, client and amount.</p>');
  try {
    if (!state.meta.ai_enabled) { const fd = new FormData(); fd.append('file', file); const { id } = await api('/api/attachments', { method: 'POST', body: fd }); return invoiceModal({ attachment_id: id }, 'File attached.'); }
    const fd = new FormData(); fd.append('file', file); fd.append('kind', 'invoice');
    const { attachment_id, fields: x } = await api('/api/ai/extract', { method: 'POST', body: fd });
    const job = x.job_name ? state.meta.jobs.find((j) => j.name.toLowerCase() === x.job_name.toLowerCase()) : null;
    invoiceModal({ ...x, attachment_id, job_id: job ? job.id : '', job_name: job ? '' : x.job_name }, `Read by Claude (${x.confidence} confidence). Check and save.`);
  } catch (err) { closeModal(); fail(err); }
});

// ================= BANK =================
state.pages['fin-bank'] = async function renderBank() {
  const el = $('#fin-bank');
  const rows = await api('/api/bank/rows');
  const fresh = rows.filter((r) => r.status === 'new');
  const fin = agentInfo('financials');
  el.innerHTML = `
    <div class="page-head"><div><h2>Bank & card statements</h2><div class="sub-title">Import a CSV export from your bank or card. Rows that match ledger entries are checked off; the rest wait for you here.</div></div>
      <div class="row">${fresh.length && state.meta.ai_enabled ? `<button class="btn" id="askCat">Ask ${esc(fin.name)} to sort these</button>` : ''}<button class="btn primary" id="bankUp">⇪ Import CSV</button></div></div>
    <div class="callout" style="margin-bottom:14px">Importing a statement is read-only: the cockpit never connects to your bank, never stores logins, and can't move money. Long card/account numbers in descriptions are masked before saving.</div>
    <div class="kpis"><div class="kpi accent"><div class="l">Waiting for you</div><div class="v">${fresh.length}</div></div>
      <div class="kpi"><div class="l">Matched</div><div class="v">${rows.filter((r) => r.status === 'matched').length}</div></div>
      <div class="kpi"><div class="l">Added from statements</div><div class="v">${rows.filter((r) => r.status === 'added').length}</div></div></div>
    <div class="table-wrap"><table><thead><tr><th>Date</th><th>Description</th><th class="n">Amount</th><th>Status / category</th><th class="hide-sm">Job</th><th></th></tr></thead><tbody>
    ${rows.length ? rows.map((r) => `<tr data-row="${r.id}">
      <td class="mono">${fmtDate(r.date)}</td><td>${esc(r.description)}${r.account ? `<div class="note">${esc(r.account)}</div>` : ''}</td><td class="n">${money(r.amount)}</td>
      ${r.status === 'new' ? `<td><select class="b-cat">${catOptions(r.amount > 0 ? 'income' : 'expense')}</select></td><td class="hide-sm"><select class="b-job">${jobOptions('')}</select></td>
        <td class="actions"><button class="btn sm primary" data-badd>Add</button><button class="btn sm ghost" data-bign title="Personal or transfer">Ignore</button></td>`
      : `<td><span class="chip ${r.status === 'ignored' ? '' : 'paid'}">${r.status}</span> ${r.tx_category ? `<span class="note">${esc(r.tx_category)}</span>` : ''}</td><td class="hide-sm"></td><td></td>`}</tr>`).join('')
      : '<tr><td colspan="6" class="empty">No statements imported yet.</td></tr>'}</tbody></table></div>
    <input type="file" id="bankFile" accept=".csv,text/csv" hidden>`;
  $('#bankUp').addEventListener('click', () => $('#bankFile').click());
  $('#bankFile').addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const account = prompt('Which account is this? (e.g. "Business checking", "Visa")', '') || '';
    const fd = new FormData(); fd.append('file', file); fd.append('account', account);
    try { const r = await api('/api/bank/import', { method: 'POST', body: fd }); toast(`${r.added} rows imported, ${r.matched} matched${r.duplicates_skipped ? `, ${r.duplicates_skipped} already imported` : ''}`); renderBank(); } catch (err) { fail(err); }
  });
  $('#askCat')?.addEventListener('click', () => Drawer.ask('Please go through my unmatched bank rows and propose how to handle each one (add with category and job, or ignore if personal/transfer).'));
  $$('[data-badd],[data-bign]', el).forEach((b) => b.addEventListener('click', async () => {
    const tr = b.closest('tr'); const id = Number(tr.dataset.row);
    const d = b.hasAttribute('data-bign') ? { row_id: id, action: 'ignore' } : { row_id: id, action: 'add', category: $('.b-cat', tr).value, job_id: $('.b-job', tr).value || null };
    try { const r = await api('/api/bank/decide', { method: 'POST', body: { rows: [d] } }); if (r.skipped && r.skipped.length) toast(r.skipped.join(' · '), true); renderBank(); } catch (err) { fail(err); }
  }));
};

// ================= MILEAGE =================
state.pages['fin-mileage'] = async function renderMileage() {
  const el = $('#fin-mileage');
  const y = today().slice(0, 4);
  const rows = await api(`/api/mileage?year=${y}`);
  const miles = rows.reduce((a, r) => a + r.miles, 0); const ded = rows.reduce((a, r) => a + r.deduction, 0);
  el.innerHTML = `
    <div class="page-head"><div><h2>Mileage log · ${y}</h2><div class="sub-title">${state.meta.settings.vehicle_method === 'standard' ? 'Standard mileage method: this is your vehicle deduction.' : 'Actual-expense method selected; miles are your business-use record.'}</div></div>
      <a class="btn" href="/api/export/mileage.csv?year=${y}">Export CSV</a></div>
    <div class="kpis"><div class="kpi accent"><div class="l">Business miles</div><div class="v">${miles.toLocaleString('en-US', { maximumFractionDigits: 1 })}</div><div class="s">${rows.length} trips</div></div>
      <div class="kpi"><div class="l">Deduction value</div><div class="v">${money(ded)}</div><div class="s">at IRS standard rate</div></div></div>
    <div class="card quick"><form id="miForm" class="form-grid">
      <label>Date<input type="date" name="date" value="${today()}" required></label><label>Miles<input type="number" name="miles" step="0.1" min="0.1" inputmode="decimal" required></label>
      <label>Job<select name="job_id">${jobOptions('')}</select></label><label class="wide">Purpose<input name="purpose" placeholder="Supply run, site visit, estimate…"></label>
      <label>&nbsp;<button class="btn primary">Log miles</button></label></form></div>
    <div class="table-wrap"><table><thead><tr><th>Date</th><th>Job</th><th>Purpose</th><th class="n">Miles</th><th class="n">Rate</th><th class="n">Deduction</th><th></th></tr></thead>
      <tbody>${rows.length ? rows.map((m) => `<tr><td class="mono">${fmtDate(m.date)}</td><td>${esc(m.job_name || '')}</td><td>${esc(m.purpose || '')}</td><td class="n">${m.miles}</td><td class="n">$${m.rate.toFixed(3)}</td><td class="n">${money(m.deduction)}</td><td class="actions"><button class="btn sm ghost" data-md="${m.id}">✕</button></td></tr>`).join('')
        : '<tr><td colspan="7" class="empty">No trips logged this year.</td></tr>'}</tbody></table></div>`;
  $('#miForm').addEventListener('submit', async (e) => { e.preventDefault(); try { await api('/api/mileage', { method: 'POST', body: formData(e.target) }); toast('Miles logged'); renderMileage(); } catch (err) { fail(err); } });
  $$('[data-md]', el).forEach((b) => b.addEventListener('click', async () => { if (confirm('Delete this trip?')) { await api(`/api/mileage/${b.dataset.md}`, { method: 'DELETE' }); renderMileage(); } }));
};
function mileageModal() {
  openModal(`<h2>Log miles</h2><form id="qmForm" class="form-grid"><label>Date<input type="date" name="date" value="${today()}"></label><label>Miles<input type="number" name="miles" step="0.1" min="0.1" required inputmode="decimal"></label><label>Job<select name="job_id">${jobOptions('')}</select></label><label class="wide">Purpose<input name="purpose"></label></form><div class="foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="qmSave">Log</button></div>`,
    () => $('#qmSave').addEventListener('click', async () => { const f = $('#qmForm'); if (!f.reportValidity()) return; await api('/api/mileage', { method: 'POST', body: formData(f) }).then(() => { closeModal(); toast('Miles logged'); render(); }).catch(fail); }));
}
function hoursModal(date) {
  const row = () => `<div class="split-row"><select class="h-w">${workerOptions('Me')}</select><select class="h-j">${jobOptions('')}</select><input type="number" step="0.25" class="h-h" placeholder="Hours"><input type="number" step="1" class="h-e" placeholder="$ earned"><button type="button" class="btn sm ghost sp-rm">✕</button></div>`;
  openModal(`<h2>Log hours</h2><form id="hForm"><label style="max-width:200px">Date<input type="date" name="date" value="${date || today()}"></label></form>
    <div id="hRows" style="margin-top:12px">${row()}</div><button type="button" class="btn sm" id="hAdd" style="margin-top:6px">+ Person / job</button>
    <p class="note">New helper? Add them in Jobs → Crew.</p>
    <div class="foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="hSave">Save hours</button></div>`, (m) => {
    const wire = () => $$('.sp-rm', m).forEach((b) => (b.onclick = () => b.parentElement.remove()));
    $('#hAdd').addEventListener('click', () => { $('#hRows').insertAdjacentHTML('beforeend', row()); wire(); }); wire();
    $('#hSave').addEventListener('click', async () => {
      const entries = $$('#hRows .split-row').map((r) => ({ worker: $('.h-w', r).value, job_id: $('.h-j', r).value || null, hours: Number($('.h-h', r).value), est_earned: $('.h-e', r).value || null })).filter((x) => x.hours > 0);
      if (!entries.length) return toast('Enter some hours', true);
      try { await api('/api/time', { method: 'POST', body: { date: $('[name=date]', m).value, entries } }); closeModal(); toast('Hours saved'); render(); } catch (e) { fail(e); }
    });
  });
}

// ================= CHARTS =================
state.pages['fin-charts'] = async function renderCharts() {
  const el = $('#fin-charts');
  const a = await api('/api/analytics?' + new URLSearchParams(periodRange(state.chartRange)));
  const th = chartTheme();
  const cats = a.by_category.slice(0, 10);
  const topCats = a.by_category.slice(0, 4).map((c) => c.category);
  const catColors = [th.expense, th.gold, th.profit, th.income];
  const dows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const labels = a.series.map((s) => monthLabel(s.month));
  el.innerHTML = `
    <div class="page-head"><h2>Patterns over time</h2>
      <select id="chRange" style="width:auto">${[['12m', 'Last 12 months'], ['24m', 'Last 24 months'], ['ytd', 'Year to date'], ['lastyear', 'Last year']].map(([v, l]) => `<option value="${v}" ${state.chartRange === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="kpis">
      <div class="kpi"><div class="l">Income</div><div class="v">${money0(a.totals.income)}</div></div>
      <div class="kpi"><div class="l">Expenses</div><div class="v">${money0(a.totals.expense)}</div></div>
      <div class="kpi accent"><div class="l">Profit</div><div class="v">${money0(a.totals.profit)}</div><div class="s">margin ${pct(a.totals.margin)}</div></div>
      <div class="kpi"><div class="l">Your profit per hour</div><div class="v">${a.totals.per_hour !== null ? money0(a.totals.per_hour) : '—'}</div><div class="s">${a.totals.my_hours} hours logged</div></div>
      <div class="kpi"><div class="l">Estimate win rate</div><div class="v">${pct(a.estimates.win_rate)}</div><div class="s">accepted vs declined</div></div>
    </div>
    <div class="grid g2">
      <div class="card"><h3>Monthly income & expenses</h3>${legend([[th.income, 'Income'], [th.expense, 'Expenses']])}<div class="chart-box"><canvas id="c1"></canvas></div>
        <details class="tview"><summary>Table</summary>${miniTable(['Month', 'Income', 'Expenses', 'Profit', 'Your hours'], a.series.map((s) => [s.month, money(s.income), money(s.expense), money(s.profit), s.my_hours]))}</details></div>
      <div class="card"><h3>Monthly profit</h3><div class="chart-box"><canvas id="c2"></canvas></div></div>
      <div class="card"><h3>Where the money goes</h3><div class="chart-box tall"><canvas id="c3"></canvas></div>
        <details class="tview"><summary>Table</summary>${miniTable(['Category', 'Total'], a.by_category.map((c) => [c.category, money(c.total)]))}</details></div>
      <div class="card"><h3>Top expense categories by month</h3>${legend(topCats.map((c, i) => [catColors[i], esc(c)]))}<div class="chart-box tall"><canvas id="c4"></canvas></div></div>
      <div class="card"><h3>Profit by job</h3>${legend([[th.income, 'Income'], [th.expense, 'Cost (incl. mileage)']])}<div class="chart-box tall"><canvas id="c5"></canvas></div>
        <details class="tview"><summary>Table</summary>${miniTable(['Job', 'Income', 'Cost', 'Profit', 'Margin', '$/hr'], a.jobs.map((j) => [j.name, money(j.income), money(j.cost), money(j.profit), pct(j.margin), j.per_hour ? money0(j.per_hour) : '—']))}</details></div>
      <div class="card"><h3>Daily log: estimated earnings</h3><div class="chart-box tall"><canvas id="c6"></canvas></div>
        <p class="note">${a.productivity.length ? `${a.productivity.filter((p) => p.met === 'yes').length} of ${a.productivity.filter((p) => p.met).length} reviewed days fully met · ${a.productivity.reduce((s, p) => s + p.done_n, 0)} goals completed` : 'Daily check-ins will show up here.'}</p></div>
      <div class="card"><h3>Income received by weekday</h3><div class="chart-box"><canvas id="c7"></canvas></div><p class="note">When clients actually pay.</p></div>
    </div>`;
  $('#chRange').addEventListener('change', (e) => { state.chartRange = e.target.value; renderCharts(); });
  const hBar = (extra = {}) => deepMerge({ indexAxis: 'y', interaction: { mode: 'index', axis: 'y' },
    scales: { x: { grid: { color: th.grid, display: true }, ticks: { callback: (v) => money0(v) } }, y: { grid: { display: false }, ticks: { color: th.text, callback: function (v) { return this.getLabelForValue(v); } } } },
    plugins: { tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${money(c.parsed.x)}` } } } }, extra);
  makeChart('c1', { type: 'bar', data: { labels, datasets: [{ label: 'Income', data: a.series.map((s) => s.income), ...barStyle(th.income) }, { label: 'Expenses', data: a.series.map((s) => s.expense), ...barStyle(th.expense) }] } });
  makeChart('c2', { type: 'bar', data: { labels, datasets: [{ label: 'Profit', data: a.series.map((s) => s.profit), ...barStyle(a.series.map((s) => (s.profit < 0 ? th.bad : th.profit))), borderSkipped: false }] } });
  makeChart('c3', { type: 'bar', data: { labels: cats.map((c) => c.category), datasets: [{ label: 'Spent', data: cats.map((c) => c.total), ...barStyle(th.expense) }] }, options: hBar() });
  makeChart('c4', { type: 'line', data: { labels, datasets: topCats.map((cat, i) => ({ label: cat, borderColor: catColors[i], backgroundColor: catColors[i], borderWidth: 2, pointRadius: 3, pointHoverRadius: 5, tension: 0,
    data: a.series.map((s) => (a.category_by_month.find((r) => r.month === s.month && r.category === cat) || { total: 0 }).total) })) } });
  makeChart('c5', { type: 'bar', data: { labels: a.jobs.map((j) => j.name), datasets: [{ label: 'Income', data: a.jobs.map((j) => j.income), ...barStyle(th.income) }, { label: 'Cost', data: a.jobs.map((j) => j.cost), ...barStyle(th.expense) }] },
    options: hBar({ plugins: { tooltip: { callbacks: { footer: (items) => { const j = a.jobs[items[0].dataIndex]; return `Profit ${money(j.profit)} · margin ${pct(j.margin)}${j.per_hour ? ` · ${money0(j.per_hour)}/hr` : ''}`; } } } } }) });
  makeChart('c6', { type: 'bar', data: { labels: a.productivity.map((p) => fmtDate(p.date)), datasets: [{ label: 'Est. earned', data: a.productivity.map((p) => p.est_earned || 0),
    ...barStyle(a.productivity.map((p) => (p.met === 'yes' ? th.profit : p.met === 'partial' ? th.warn : p.met === 'no' ? th.bad : th.muted))) }] },
  options: { plugins: { tooltip: { callbacks: { afterLabel: (c) => { const p = a.productivity[c.dataIndex]; return ` Goals ${p.done_n}/${p.goals_n} · ${p.met || 'not reviewed'}`; } } } } } });
  makeChart('c7', { type: 'bar', data: { labels: dows, datasets: [{ label: 'Income', data: dows.map((_, i) => (a.weekdays.find((w) => w.dow === i) || { income: 0 }).income), ...barStyle(th.income) }] } });
};

// ================= INVOICING (the built-in invoice & estimate app) =================
state.pages.invoicing = function renderInvoicing() {
  const f = $('#invoiceFrame');
  if (!f.getAttribute('src')) f.setAttribute('src', '/invoice-app/');
};
// Every save in the invoice app updates the Cockpit's numbers; refresh the badge counts and whichever page is open next.
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || !e.data || e.data.type !== 'lc-books-saved') return;
  loadMeta().catch(() => {});
});

// ================= NUMBERS CHECK =================
// Every headline figure, as each tab works it out, side by side – and anything that would make them wrong.
state.pages['fin-check'] = async function renderCheck() {
  const el = $('#fin-check');
  el.innerHTML = '<p class="note"><span class="spinner"></span> Checking every number…</p>';
  const [c, rr] = await Promise.all([api('/api/check'), api('/api/rules')]);
  const clara = agentInfo('financials').name;
  const projects = c.projects;
  const bad = c.comparisons.filter((x) => !x.ok).length;
  const high = c.issues.filter((i) => i.severity === 'high').length;
  const drawStatus = (d) => d.status === 'paid' ? `<span class="chip paid">paid ${d.paid_date ? fmtDate(d.paid_date) : ''}</span>${d.check_no ? ` <span class="note">Ck ${esc(d.check_no)}</span>` : ''}`
    : d.status === 'billed' ? `<span class="chip open">billed ${d.issue_date ? fmtDate(d.issue_date) : ''}</span>` : '<span class="chip">scheduled</span>';
  el.innerHTML = `
    <div class="page-head"><div><h2>Numbers check</h2><div class="sub-title">Income and projects come only from the Invoicing tab. This page shows each figure the way every tab works it out, so you can see they agree.</div></div>
      <div class="row"><button class="btn" id="chkRefresh">Re-check</button>${state.meta.ai_enabled ? `<button class="btn primary" id="chkClara">Have ${esc(clara)} clean it up</button>` : ''}</div></div>
    <div class="callout ${bad || high ? '' : 'ok'}" style="margin-bottom:14px">${bad || high
      ? `<b>${bad ? `${bad} figure${bad === 1 ? '' : 's'} disagree` : 'Every figure agrees'}${high ? ` · ${high} thing${high === 1 ? '' : 's'} to fix` : ''}.</b> Work down the list below – each item says what to do.`
      : `<b>Everything agrees.</b> ${c.counts.app_invoices} invoice${c.counts.app_invoices === 1 ? '' : 's'} in the Invoicing tab → ${c.counts.projects} project${c.counts.projects === 1 ? '' : 's'}.`}</div>
    <div class="grid g3">${c.comparisons.map((x) => `<div class="card"><div class="row" style="justify-content:space-between"><h3 style="margin:0">${esc(x.name)}</h3><span class="chip ${x.ok ? 'paid' : 'overdue'}">${x.ok ? 'agrees' : 'differs'}</span></div><p class="note">${esc(x.note)}</p>
      <div class="list">${x.values.map((v) => `<div class="li"><span>${esc(v.where)}${v.plus ? `<div class="meta">+ ${money(v.plus)} ${esc(v.plusLabel)}</div>` : ''}</span><b class="num">${money(v.v)}</b></div>`).join('')}</div></div>`).join('')}</div>
    <details class="card rules-sum" style="margin-top:14px"><summary><b>Books rules in effect</b> <span class="note">· ${rr.rules.length} rules${rr.house_rules.length ? ` · ${rr.house_rules.length} house rule${rr.house_rules.length === 1 ? '' : 's'}` : ''}${rr.flags.length ? ` · ${rr.flags.length} flagged for ${esc(clara)}` : ''}</span></summary>
      <ul class="prop-lines">${rr.rules.map((x) => `<li><b>${esc(x.label)}:</b> ${esc(x.text)}</li>`).join('')}${rr.house_rules.map((h) => `<li><b>House rule:</b> ${esc(h)}</li>`).join('')}</ul>
      <p class="note">Change them in <button class="link" id="chkRules">Settings → Books rules</button>, or tell ${esc(clara)} how you want it.</p></details>
    <div class="card" style="margin-top:14px"><h3>To check or fix (${c.issues.length})</h3>
      ${c.issues.length ? `<div class="list">${c.issues.map((i, n) => `<div class="li chk-li"><div class="chk-txt"><span class="chip ${i.severity === 'high' ? 'overdue' : i.severity === 'medium' ? 'open' : ''}">${i.severity === 'high' ? 'fix' : i.severity === 'medium' ? 'check' : 'info'}</span> <b>${esc(i.title)}</b><div class="meta" style="white-space:normal">${esc(i.detail)}</div></div>
        <div class="row chk-acts">${i.tx_id ? `<button class="btn sm ghost" data-ctx="${i.tx_id}">Open</button><button class="btn sm danger ghost" data-cdel="${i.tx_id}">Delete</button>` : ''}
          ${i.invoice_id ? `<button class="btn sm danger ghost" data-cidel="${i.invoice_id}">Delete</button>` : ''}
          ${i.type === 'other_job' ? `${i.counts.tx + i.counts.hrs + i.counts.mi ? `<select class="c-into" data-n="${n}"><option value="">Move entries to…</option>${projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select><button class="btn sm" data-cmerge="${i.job_id}" data-n="${n}">Move</button>` : `<button class="btn sm danger ghost" data-cjdel="${i.job_id}">Delete</button>`}` : ''}
          ${['dup_number', 'same_lot', 'unreadable'].includes(i.type) || (i.type === 'manual_income' && i.severity === 'high') ? '<button class="btn sm" data-go="invoicing">Invoicing</button>' : ''}</div></div>`).join('')}</div>`
        : '<p class="note">Nothing to fix.</p>'}</div>
    <div class="card" style="margin-top:14px"><h3>Projects, from the Invoicing tab (${projects.length})</h3>
      <p class="note">Each invoice starts its own project. "Bill next draw" adds the next invoice to the same project. Contract = collected + owed + still to bill.</p>
      ${projects.length ? projects.map((p) => `<details class="proj" style="border-top:1px solid var(--line);padding:10px 0"><summary style="cursor:pointer"><b>${esc(p.name)}</b> <span class="note">${esc(p.client || '')} · ${p.status}</span>
          <span class="row" style="gap:14px;flex-wrap:wrap;margin-top:4px"><span class="note">Contract <b class="num">${money(p.contract)}</b></span><span class="note">Collected <b class="num">${money(p.collected)}</b></span><span class="note">Owed <b class="num">${money(p.owed)}</b></span><span class="note">To bill <b class="num">${money(p.to_bill)}</b></span>${p.issues.length ? `<span class="chip overdue">${p.issues.length} to check</span>` : ''}</span></summary>
        ${p.issues.length ? `<div class="callout" style="margin:8px 0">${p.issues.map(esc).join('<br>')}</div>` : ''}
        <div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>Draw</th><th>Invoice</th><th class="n">Amount</th><th>Status</th></tr></thead><tbody>${p.draws.map((d) => `<tr><td>${d.n}. ${esc(d.label)}</td><td class="mono">${d.invoice_no ? esc(d.invoice_no) : '—'}</td>
          <td class="n">${money(d.billed_amount ?? d.amount)}${d.received != null && d.received !== (d.billed_amount ?? d.amount) ? `<div class="note">received ${money(d.received)}</div>` : ''}</td><td>${drawStatus(d)}</td></tr>`).join('')}</tbody></table></div></details>`).join('')
        : '<p class="note">No invoices in the Invoicing tab yet.</p>'}</div>`;
  wireGoTo(el);
  $('#chkRefresh').addEventListener('click', () => renderCheck());
  $('#chkRules').addEventListener('click', () => { state.setSub = 'rules'; showTab('settings'); });
  $('#chkClara')?.addEventListener('click', async () => {
    Drawer.setAgent('financials'); Drawer.needsLoad = false; Drawer.toggle(true);
    Drawer.chat.load().catch(() => {}).then(() => Drawer.chat.send('Go through the Numbers check and clean up my books. Ask me about anything that could go either way.'));
  });
  $$('[data-ctx]', el).forEach((b) => b.addEventListener('click', async () => { const rows = await api(`/api/transactions?kind=income&limit=5000`); const t = rows.find((r) => r.id === Number(b.dataset.ctx)); if (t) txModal(t); }));
  $$('[data-cdel]', el).forEach((b) => b.addEventListener('click', async () => { if (!confirm('Delete this ledger entry?')) return; await api(`/api/transactions/${b.dataset.cdel}`, { method: 'DELETE' }); toast('Deleted'); renderCheck(); }));
  $$('[data-cidel]', el).forEach((b) => b.addEventListener('click', async () => { if (!confirm('Delete this invoice? Ledger entries stay.')) return; await api(`/api/invoices/${b.dataset.cidel}`, { method: 'DELETE' }); toast('Deleted'); renderCheck(); }));
  $$('[data-cjdel]', el).forEach((b) => b.addEventListener('click', async () => { if (!confirm('Delete this empty job?')) return; await api(`/api/jobs/${b.dataset.cjdel}`, { method: 'DELETE' }); toast('Deleted'); loadMeta().catch(() => {}); renderCheck(); }));
  $$('[data-cmerge]', el).forEach((b) => b.addEventListener('click', async () => {
    const into = $(`.c-into[data-n="${b.dataset.n}"]`, el).value; if (!into) return toast('Pick the project to move them into', true);
    try { const r = await api(`/api/jobs/${b.dataset.cmerge}/merge`, { method: 'POST', body: { into } }); toast(`Moved into ${r.into}`); loadMeta().catch(() => {}); renderCheck(); } catch (e) { fail(e); }
  }));
};
