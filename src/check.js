// Numbers check: every headline figure, worked out the way each tab works it out, side by side – plus a list of
// anything that could make the numbers wrong (duplicates, money that didn't come from an invoice, missing dates).
const { q } = require('./db');
const S = require('./services');
const LCP = require('../public/invoice-app/projects.js');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
const same = (a, b) => Math.abs(r2(a) - r2(b)) < 0.01;

async function numbersCheck() {
  const today = S.todayISO(); const year = Number(today.slice(0, 4));
  const [jobs, invoices, ytd, tax, overview, books] = await Promise.all([
    S.listJobs(), S.listInvoices(), S.periodSummary('ytd'), S.taxSummary(year), S.overview(),
    q(`SELECT value FROM books WHERE key='luxcraft.invoices.v1'`),
  ]);
  const appRecs = ((books.rows[0] && books.rows[0].value && books.rows[0].value.invoices) || []).filter((r) => r && r.id && r.st);
  const projectsFromInvoices = jobs.filter((j) => j.from_invoices);

  // ---- the same figure, from each place it appears ----
  const draws = projectsFromInvoices.flatMap((j) => (j.draws || []).map((d) => ({ ...d, job: j.name })));
  const paidThisYear = draws.filter((d) => d.status === 'paid' && String(d.paid_date || '').startsWith(String(year)))
    .reduce((a, d) => a + (d.received ?? d.billed_amount ?? d.amount), 0);
  const awaitingRows = await q(`SELECT COALESCE(SUM(amount),0) AS v, COUNT(*)::int AS n FROM transactions WHERE category=$1`, [S.AWAITING]);
  const manualRevenue = await q(`SELECT COALESCE(SUM(t.amount),0) AS v FROM transactions t JOIN categories c ON c.name=t.category
     WHERE t.kind='income' AND t.created_by<>'sync' AND c.sched_c IN ('L1','L6') AND t.category<>$1 AND t.date BETWEEN $2 AND $3`, [S.AWAITING, `${year}-01-01`, today]);
  const appUnpaid = appRecs.filter((r) => r.status !== 'paid').reduce((a, r) => a + num(r.total), 0)
    + appRecs.filter((r) => r.status === 'paid' && r.payment && num(r.payment.amount) > 0 && num(r.payment.amount) < num(r.total)).reduce((a, r) => a + num(r.total) - num(r.payment.amount), 0);
  const appPaid = appRecs.filter((r) => r.status === 'paid').reduce((a, r) => a + (r.payment && num(r.payment.amount) > 0 ? Math.min(num(r.payment.amount), num(r.total)) : num(r.total)), 0);
  const owedInvoices = invoices.filter((i) => i.counted && !['paid', 'void'].includes(i.status)).reduce((a, i) => a + i.balance, 0);

  const ledgerRevenueYtd = ytd.income; // Overview / Ledger
  const taxGross = r2((tax.income.gross_receipts || 0) + (tax.income.other_income || 0));
  const comparisons = [
    { name: 'Income received this year', note: 'Money in, counted when paid', values: [
      { where: 'Overview & Ledger (YTD revenue)', v: r2(ledgerRevenueYtd) },
      { where: 'Taxes (Schedule C gross receipts + other income)', v: taxGross },
      { where: 'Invoicing tab (draws paid this year)', v: r2(paidThisYear), plus: r2(manualRevenue.rows[0].v), plusLabel: 'entered by hand, not from an invoice' },
    ] },
    { name: 'Owed to you', note: 'Billed and not yet paid', values: [
      { where: 'Overview (Owed to you)', v: r2(overview.receivables.total) },
      { where: 'Financials → Invoices (Outstanding)', v: r2(owedInvoices) },
      { where: 'Jobs (Billed, not paid)', v: r2(projectsFromInvoices.reduce((a, j) => a + j.owed, 0)) },
      { where: 'Ledger (Invoiced, awaiting payment)', v: r2(awaitingRows.rows[0].v) },
      { where: 'Invoicing tab (Unpaid)', v: r2(appUnpaid) },
    ] },
    { name: 'Still to bill', note: 'Draws scheduled but not invoiced yet', values: [
      { where: 'Overview (Still to bill)', v: r2(overview.backlog.to_bill) },
      { where: 'Jobs (Still to bill, active)', v: r2(projectsFromInvoices.filter((j) => j.status === 'active').reduce((a, j) => a + j.to_bill, 0)) },
    ] },
  ];
  for (const c of comparisons) {
    const vs = c.values.map((x) => x.v);
    c.ok = vs.every((v) => same(v, vs[0]));
    // Income: the invoice figure plus hand-entered revenue should equal the ledger.
    if (c.name.startsWith('Income')) c.ok = same(vs[0], vs[1]) && same(vs[0], r2(vs[2] + (c.values[2].plus || 0)));
  }
  const allTime = { paid: r2(appPaid), owed: r2(appUnpaid) };

  // ---- per project: contract = collected + owed + still to bill ----
  const projects = projectsFromInvoices.map((j) => {
    const ds = j.draws || [];
    const billed = ds.filter((d) => d.status !== 'scheduled').reduce((a, d) => a + (d.billed_amount ?? d.amount), 0);
    const scheduleSum = r2(ds.reduce((a, d) => a + d.amount, 0));
    const issues = [];
    if (!same(scheduleSum, j.contract_amount || 0)) issues.push(`Draw schedule adds up to ${scheduleSum.toFixed(2)}, contract is ${(j.contract_amount || 0).toFixed(2)}`);
    for (const d of ds) {
      if (d.flag) issues.push(`Draw ${d.n}: ${d.flag}`);
      if (d.status === 'paid' && d.note && /no (payment|paid) date/.test(d.note)) issues.push(`Draw ${d.n} (${d.invoice_no}) is paid but has no payment date – open it in the Invoicing tab and record the date`);
      if (d.status === 'paid' && d.received != null && d.received < (d.billed_amount ?? d.amount) - 0.004) issues.push(`Draw ${d.n} (${d.invoice_no}) was short-paid by ${((d.billed_amount ?? d.amount) - d.received).toFixed(2)}`);
    }
    return { id: j.id, name: j.name, client: j.client, lot: j.lot, status: j.status, contract: r2(j.contract_total), billed: r2(billed),
      collected: r2(j.collected), owed: r2(j.owed), to_bill: r2(j.to_bill), draws: ds, issues };
  });

  // ---- things that could double-count or don't come from the Invoicing tab ----
  const issues = [];
  const appInvoiceNos = new Set(invoices.filter((i) => i.counted).map((i) => String(i.invoice_no).toLowerCase()));
  const appAmounts = invoices.filter((i) => i.counted && !i.void).map((i) => ({ no: i.invoice_no, amount: i.amount, date: i.issue_date }));
  const manualIncome = (await q(`SELECT t.*, j.name AS job_name FROM transactions t LEFT JOIN jobs j ON j.id=t.job_id
     WHERE t.kind='income' AND t.created_by<>'sync' AND t.category NOT IN ('Owner Contribution', $1) ORDER BY t.date DESC`, [S.AWAITING])).rows;
  for (const t of manualIncome) {
    const byNo = t.invoice_no && appInvoiceNos.has(String(t.invoice_no).toLowerCase());
    const byAmt = !byNo && appAmounts.find((a) => same(a.amount, t.amount) && (!a.date || Math.abs(Date.parse(t.date) - Date.parse(a.date)) <= 75 * 86400000));
    issues.push({ type: 'manual_income', severity: byNo || byAmt ? 'high' : 'medium', tx_id: t.id,
      title: `${S.round2(t.amount).toFixed(2)} income on ${t.date} entered ${t.created_by === 'agent' ? 'by an agent' : t.memo && t.memo.startsWith('Bank:') ? 'from a bank statement' : 'by hand'}${t.party ? ` · ${t.party}` : ''}`,
      detail: byNo ? `It carries invoice ${t.invoice_no}, which is in the Invoicing tab. The Cockpit is using this entry instead of the invoice's own payment. Delete it and record the payment on ${t.invoice_no} in the Invoicing tab.`
        : byAmt ? `Same amount as invoice ${byAmt.no}. If this is that payment, it's counted twice – delete it and mark ${byAmt.no} paid in the Invoicing tab.`
          : 'Not tied to an invoice. Keep it only if this money had no invoice (a small cash job, a refund, other income).' });
  }
  for (const i of invoices.filter((x) => !x.counted && x.status !== 'void')) {
    issues.push({ type: 'outside_invoice', severity: 'medium', invoice_id: i.id, title: `Invoice ${i.invoice_no} (${S.round2(i.amount).toFixed(2)}) isn't in the Invoicing tab`,
      detail: 'It was entered by hand or read from an uploaded PDF. It is not counted in what you\'re owed. Delete it, or re-create it in the Invoicing tab if it\'s real.' });
  }
  for (const j of jobs.filter((x) => !x.from_invoices)) {
    const n = (await q(`SELECT (SELECT COUNT(*) FROM transactions WHERE job_id=$1)::int AS tx, (SELECT COUNT(*) FROM time_entries WHERE job_id=$1)::int AS hrs,
      (SELECT COUNT(*) FROM mileage WHERE job_id=$1)::int AS mi`, [j.id])).rows[0];
    issues.push({ type: 'other_job', severity: n.tx + n.hrs + n.mi ? 'medium' : 'low', job_id: j.id, counts: n,
      title: `Job "${j.name}" isn't from an invoice`,
      detail: n.tx + n.hrs + n.mi ? `It holds ${n.tx} ledger entr${n.tx === 1 ? 'y' : 'ies'}, ${n.hrs} hour entr${n.hrs === 1 ? 'y' : 'ies'} and ${n.mi} mileage entr${n.mi === 1 ? 'y' : 'ies'}. Move them into the right project, or keep it if it's real work without an invoice.`
        : 'It has nothing tagged to it. Delete it unless you plan to invoice it.' });
  }
  const renamed = invoices.filter((i) => / \(\d+\)$/.test(i.invoice_no) && i.counted && !i.void);
  for (const i of renamed) issues.push({ type: 'dup_number', severity: 'high', title: `Two invoices in the Invoicing tab share number ${i.invoice_no.replace(/ \(\d+\)$/, '')}`,
    detail: `The second is shown here as ${i.invoice_no}. Open it in the Invoicing tab and give it its own number, or delete the copy.` });
  // Several projects on one lot – fine if they really are separate jobs (every invoice is its own project unless billed as its next draw).
  const lots = {};
  for (const p of projects) if (p.lot) (lots[`${(p.client || '').toLowerCase()}|${p.lot}`] ||= []).push(p);
  for (const list of Object.values(lots)) if (list.length > 1) issues.push({ type: 'same_lot', severity: 'low', title: `Lot ${list[0].lot} has ${list.length} separate projects`,
    detail: `${list.map((p) => p.name).join(' · ')}. That's right if they're separate jobs. If one is really the next draw of another, delete it in the Invoicing tab and use "Bill next draw" on the first invoice instead.` });
  // Records in the app that the sync couldn't read.
  const unreadable = appRecs.filter((r) => !String(r.st.invNo || '').trim() || !Array.isArray(r.st.draws) || !r.st.draws.length);
  for (const r of unreadable) issues.push({ type: 'unreadable', severity: 'high', title: `An invoice in the Invoicing tab has no ${!String(r.st.invNo || '').trim() ? 'invoice number' : 'draw schedule'}`,
    detail: `Client: ${r.st.client && r.st.client.name || 'unknown'}. It isn't counted anywhere until it has one.` });

  // Income only "agrees" if no hand-entered income looks like a copy of an invoice payment.
  if (issues.some((i) => i.type === 'manual_income' && i.severity === 'high')) comparisons[0].ok = false;
  const order = { high: 0, medium: 1, low: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);
  const groupsCount = LCP.groups(appRecs.filter((r) => String(r.st.invNo || '').trim() && Array.isArray(r.st.draws) && r.st.draws.length)).size;
  return { as_of: today, year, comparisons, all_time: allTime, projects, issues, counts: { app_invoices: appRecs.length, projects: groupsCount, cockpit_projects: projects.length } };
}

// Move everything tagged to one job into another, then delete the empty one.
async function mergeJob(fromId, intoId) {
  fromId = Number(fromId); intoId = Number(intoId);
  if (!fromId || !intoId || fromId === intoId) throw new Error('Pick a different project to move these into');
  const into = (await q('SELECT id, name FROM jobs WHERE id=$1', [intoId])).rows[0];
  if (!into) throw new Error('That project no longer exists');
  for (const t of ['transactions', 'time_entries', 'mileage']) await q(`UPDATE ${t} SET job_id=$2 WHERE job_id=$1`, [fromId, intoId]);
  await q('UPDATE invoices SET job_id=$2 WHERE job_id=$1 AND source<>\'invoice-app\'', [fromId, intoId]);
  await q('UPDATE estimates SET job_id=NULL WHERE job_id=$1', [fromId]);
  // Daily goals refer to jobs by name.
  const from = (await q('SELECT name FROM jobs WHERE id=$1', [fromId])).rows[0];
  if (from) await q(`UPDATE daily_logs SET goals = (SELECT COALESCE(jsonb_agg(CASE WHEN g->>'job_name' = $1 THEN jsonb_set(g, '{job_name}', to_jsonb($2::text)) ELSE g END), '[]'::jsonb) FROM jsonb_array_elements(goals) g)
     WHERE goals::text LIKE '%' || $1 || '%'`, [from.name, into.name]).catch(() => {});
  if ((await q('SELECT 1 FROM invoices WHERE job_id=$1 AND NOT void', [fromId])).rows.length) throw new Error('That job still has invoices from the Invoicing tab');
  await q('UPDATE invoices SET job_id=NULL WHERE job_id=$1', [fromId]);
  await q('DELETE FROM jobs WHERE id=$1', [fromId]);
  return { ok: true, into: into.name };
}

module.exports = { numbersCheck, mergeJob };
