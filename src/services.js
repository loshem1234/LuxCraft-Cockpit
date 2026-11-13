// Business logic shared by the HTTP API and the agents.
const crypto = require('crypto');
const { q, pool, getSettings, resolveJob } = require('./db');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const todayISO = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const NOT_OPERATING = "('Owner Draw','Estimated Tax Payment')";
const AWAITING = 'Invoiced – Awaiting Payment';
const NOT_REVENUE = "('Owner Contribution','Invoiced – Awaiting Payment')";

function yearValue(map, year) {
  if (map && typeof map === 'object') {
    if (map[year] !== undefined) return map[year];
    const ys = Object.keys(map).map(Number).filter((y) => y <= year).sort((a, b) => b - a);
    if (ys.length) return map[ys[0]];
    return map[Object.keys(map).sort()[0]];
  }
  return map;
}
function mileageRateFor(date, settings) {
  const rates = (settings.mileage_rates || []).slice().sort((a, b) => (a.from < b.from ? -1 : 1));
  let rate = rates.length ? rates[0].rate : 0.725;
  for (const r of rates) if (r.from <= date) rate = r.rate;
  return Number(rate);
}

// ---------- transactions ----------
const TX_FIELDS = ['kind', 'date', 'amount', 'category', 'job_id', 'party', 'method', 'check_no', 'invoice_no', 'memo',
  'attachment_id', 'billable', 'markup_pct', 'billed', 'sales_tax', 'untaxed'];
async function normalizeTx(t) {
  const kind = t.kind === 'income' ? 'income' : 'expense';
  const amount = round2(t.amount);
  if (!(amount > 0)) throw new Error('Amount must be greater than zero');
  const cat = await q('SELECT name FROM categories WHERE lower(name)=lower($1) AND kind=$2', [t.category || '', kind]);
  const category = cat.rows[0] ? cat.rows[0].name : kind === 'income' ? 'Contract Revenue' : 'Other Expense';
  const jobId = t.job_id === '' ? null : await resolveJob(t.job_id ?? t.job_name ?? null);
  const bool = (v) => v === true || v === 'true' || v === 'on' || v === '1';
  return {
    kind, date: t.date || todayISO(), amount, category, job_id: jobId, party: t.party || null, method: t.method || null,
    check_no: t.check_no ? String(t.check_no).trim() : null, invoice_no: t.invoice_no ? String(t.invoice_no).trim() : null,
    memo: t.memo || null, attachment_id: t.attachment_id ? Number(t.attachment_id) : null,
    billable: kind === 'expense' && bool(t.billable), markup_pct: t.markup_pct === '' || t.markup_pct == null ? null : Number(t.markup_pct),
    billed: bool(t.billed), sales_tax: t.sales_tax === '' || t.sales_tax == null ? null : round2(t.sales_tax), untaxed: bool(t.untaxed),
  };
}
// Invoice payments live on the invoice (Invoicing tab), so a hand-entered payment for one of its invoices would be a
// second copy of the same money.
async function guardInvoicePayment(n, createdBy) {
  if (createdBy === 'sync' || n.kind !== 'income' || n.category === AWAITING) return;
  // Rule "Income entered by hand": never → all income comes from invoices (owner contributions aren't income).
  if (n.category !== 'Owner Contribution' && (await require('./rules').getRules()).manual_income === 'never') {
    throw Object.assign(new Error('Income is entered only through invoices (Settings → Books rules). Record the payment on its invoice in the Invoicing tab.'), { status: 400 });
  }
  if (!n.invoice_no) return;
  const inv = (await q(`SELECT invoice_no FROM invoices WHERE lower(invoice_no)=lower($1) AND source='invoice-app' AND NOT void`, [n.invoice_no])).rows[0];
  if (inv) throw Object.assign(new Error(`${inv.invoice_no} is in the Invoicing tab – record its payment there (click its Unpaid button) so it's only counted once.`), { status: 400 });
}
async function addTransaction(t, createdBy = 'manual', client = null) {
  const n = await normalizeTx(t);
  await guardInvoicePayment(n, createdBy);
  const db = client || pool;
  const { rows } = await db.query(
    `INSERT INTO transactions (${TX_FIELDS.join(',')}, split_group, ext_ref, created_by)
     VALUES (${TX_FIELDS.map((_, i) => `$${i + 1}`).join(',')}, $${TX_FIELDS.length + 1}, $${TX_FIELDS.length + 2}, $${TX_FIELDS.length + 3}) RETURNING *`,
    [...TX_FIELDS.map((f) => n[f]), t.split_group || null, t.ext_ref || null, createdBy]);
  return rows[0];
}
async function updateTransaction(id, t) {
  const n = await normalizeTx(t);
  const cur = (await q('SELECT created_by FROM transactions WHERE id=$1', [id])).rows[0];
  await guardInvoicePayment(n, cur ? cur.created_by : 'manual');
  const { rows } = await q(
    `UPDATE transactions SET ${TX_FIELDS.map((f, i) => (f === 'attachment_id' ? `${f}=COALESCE($${i + 2}, ${f})` : `${f}=$${i + 2}`)).join(', ')} WHERE id=$1 RETURNING *`,
    [id, ...TX_FIELDS.map((f) => n[f])]);
  if (!rows[0]) throw new Error('Transaction not found');
  return rows[0];
}
// One receipt split across jobs/categories: shared date/vendor/receipt, separate amounts.
async function addSplit(base, parts, createdBy = 'manual') {
  if (!Array.isArray(parts) || parts.length < 2) throw new Error('A split needs at least two parts');
  const group = crypto.randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = [];
    const total = parts.reduce((s, p) => s + Number(p.amount || 0), 0);
    const tax = Number(base.sales_tax) || 0;
    let taxLeft = round2(tax);
    for (const [i, p] of parts.entries()) {
      // Sales tax is shared across the parts in proportion to their amounts.
      const share = i === parts.length - 1 ? taxLeft : round2(total ? tax * Number(p.amount) / total : 0);
      taxLeft = round2(taxLeft - share);
      out.push(await addTransaction({ ...base, ...p, sales_tax: tax ? share : null, split_group: group }, createdBy, client));
    }
    await client.query('COMMIT');
    return out;
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

async function listTransactions({ from, to, kind, category, job_id, search, billable, limit = 500 } = {}) {
  const where = []; const p = [];
  const add = (sql, v) => { p.push(v); where.push(sql.replace('?', `$${p.length}`)); };
  if (from) add('t.date >= ?', from);
  if (to) add('t.date <= ?', to);
  if (kind) add('t.kind = ?', kind);
  if (category) add('t.category = ?', category);
  if (job_id) add('t.job_id = ?', job_id);
  if (billable === 'unbilled') where.push('t.billable AND NOT t.billed');
  if (search) {
    p.push(`%${search}%`);
    where.push(`(t.party ILIKE $${p.length} OR t.memo ILIKE $${p.length} OR t.check_no ILIKE $${p.length} OR t.invoice_no ILIKE $${p.length})`);
  }
  p.push(Math.min(Number(limit) || 500, 5000));
  const { rows } = await q(
    `SELECT t.*, j.name AS job_name FROM transactions t LEFT JOIN jobs j ON j.id=t.job_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.date DESC, t.id DESC LIMIT $${p.length}`, p);
  return rows;
}

// ---------- invoices & estimates ----------
async function listInvoices({ status } = {}) {
  const { rows } = await q(`
    SELECT i.*, j.name AS job_name,
      COALESCE((SELECT SUM(amount) FROM transactions t WHERE t.kind='income' AND t.category<>'Invoiced – Awaiting Payment' AND lower(t.invoice_no)=lower(i.invoice_no)),0) AS paid,
      (SELECT json_agg(json_build_object('id',t.id,'date',t.date,'amount',t.amount,'check_no',t.check_no,'method',t.method) ORDER BY t.date)
         FROM transactions t WHERE t.kind='income' AND t.category<>'Invoiced – Awaiting Payment' AND lower(t.invoice_no)=lower(i.invoice_no)) AS payments
    FROM invoices i LEFT JOIN jobs j ON j.id=i.job_id ORDER BY i.issue_date DESC NULLS LAST, i.id DESC`);
  const today = todayISO();
  const out = rows.map((r) => {
    const balance = round2(r.amount - r.paid);
    let st = r.void ? 'void' : balance <= 0.004 ? 'paid' : r.paid > 0 ? 'partial' : 'open';
    const overdue = !['paid', 'void'].includes(st) && r.due_date && r.due_date < today;
    const daysOut = r.issue_date ? Math.floor((Date.parse(today) - Date.parse(r.issue_date)) / 86400000) : null;
    // Only invoices from the Invoicing tab count toward what you're owed; others are listed so you can delete them.
    return { ...r, balance, status: overdue ? 'overdue' : st, days_out: daysOut, payments: r.payments || [], counted: r.source === 'invoice-app' };
  });
  return status ? out.filter((r) => r.counted && (status === 'unpaid' ? ['open', 'partial', 'overdue'].includes(r.status) : r.status === status)) : out;
}
async function upsertInvoice(inv, source = 'manual') {
  const jobId = inv.job_id ? await resolveJob(inv.job_id) : await resolveJob(inv.job_name ?? null, { create: !!inv.job_name, client: inv.client });
  const { rows } = await q(
    `INSERT INTO invoices (invoice_no, job_id, client, issue_date, due_date, amount, draw_label, notes, source, external_id, attachment_id, void)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12,false))
     ON CONFLICT (invoice_no) DO UPDATE SET
       job_id=COALESCE(EXCLUDED.job_id, invoices.job_id), client=COALESCE(EXCLUDED.client, invoices.client),
       issue_date=COALESCE(EXCLUDED.issue_date, invoices.issue_date), due_date=COALESCE(EXCLUDED.due_date, invoices.due_date),
       amount=EXCLUDED.amount, draw_label=COALESCE(EXCLUDED.draw_label, invoices.draw_label), notes=COALESCE(EXCLUDED.notes, invoices.notes),
       external_id=COALESCE(EXCLUDED.external_id, invoices.external_id),
       attachment_id=COALESCE(EXCLUDED.attachment_id, invoices.attachment_id), void=EXCLUDED.void
     RETURNING *`,
    [String(inv.invoice_no).trim(), jobId, inv.client || null, inv.issue_date || null, inv.due_date || null, round2(inv.amount),
      inv.draw_label || null, inv.notes || null, source, inv.external_id || null, inv.attachment_id || null, inv.void ?? null]);
  return rows[0];
}
async function listEstimates() {
  const { rows } = await q(`SELECT e.*, j.name AS job_name FROM estimates e LEFT JOIN jobs j ON j.id=e.job_id ORDER BY e.est_date DESC NULLS LAST, e.id DESC`);
  return rows;
}

// ---------- jobs ----------
async function listJobs() {
  const settings = await getSettings();
  const rules = await require('./rules').getRules();
  const { rows } = await q(`
    SELECT j.*,
      COALESCE((SELECT SUM(amount) FROM transactions t WHERE t.job_id=j.id AND t.kind='income' AND t.category NOT IN ${NOT_REVENUE}),0) AS income,
      COALESCE((SELECT SUM(amount) FROM transactions t WHERE t.job_id=j.id AND t.kind='expense' AND t.category NOT IN ${NOT_OPERATING}),0) AS expenses,
      COALESCE((SELECT SUM(amount * (1 + COALESCE(markup_pct,0)/100)) FROM transactions t WHERE t.job_id=j.id AND t.billable AND NOT t.billed),0) AS unbilled,
      COALESCE((SELECT SUM(amount) FROM invoices i WHERE i.job_id=j.id AND NOT i.void AND i.source='invoice-app'),0) AS invoiced,
      COALESCE((SELECT SUM(GREATEST(0, i.amount - COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.kind='income' AND t.category<>'${AWAITING}'
        AND lower(t.invoice_no)=lower(i.invoice_no)),0))) FROM invoices i WHERE i.job_id=j.id AND NOT i.void AND i.source='invoice-app'),0) AS owed,
      COALESCE((SELECT SUM(hours) FROM time_entries te WHERE te.job_id=j.id AND te.worker='Me'),0) AS my_hours,
      COALESCE((SELECT SUM(hours) FROM time_entries te WHERE te.job_id=j.id AND te.worker<>'Me'),0) AS crew_hours,
      (SELECT json_build_object('est_no',e.est_no,'total',e.total,'status',e.status) FROM estimates e WHERE e.job_id=j.id ORDER BY (e.status='accepted') DESC, e.est_date DESC LIMIT 1) AS estimate
    FROM jobs j ORDER BY CASE j.status WHEN 'active' THEN 0 WHEN 'estimating' THEN 1 WHEN 'lead' THEN 2 ELSE 3 END, j.created_at DESC`);
  const miles = await q('SELECT job_id, date, miles FROM mileage WHERE job_id IS NOT NULL');
  const mileCost = {};
  for (const m of miles.rows) mileCost[m.job_id] = (mileCost[m.job_id] || 0) + m.miles * mileageRateFor(m.date, settings);
  return rows.map((j) => {
    const vehicle = settings.vehicle_method === 'standard' ? round2(mileCost[j.id] || 0) : 0;
    const cost = round2(j.expenses + vehicle);
    const profit = round2(j.income - cost);
    // Contract position: what's been billed, collected, owed, and what's still scheduled to bill.
    const draws = Array.isArray(j.draws) ? j.draws : null;
    const contractTotal = round2((j.contract_amount || 0) + (j.change_orders || 0));
    // Still to bill comes only from an invoice's draw schedule – never guessed from a contract amount.
    // Rule "Draws not invoiced yet": hidden → numbers only change when an invoice is created.
    const toBill = draws && rules.count_to_bill === 'show' ? round2(draws.filter((d) => d.status === 'scheduled').reduce((a, d) => a + d.amount, 0)) : 0;
    const collected = draws ? round2(draws.filter((d) => d.status === 'paid').reduce((a, d) => a + (d.received ?? d.billed_amount ?? d.amount), 0)) : 0;
    return { ...j, from_invoices: !!draws, collected, unbilled: round2(j.unbilled), owed: round2(j.owed), contract_total: draws ? contractTotal : 0, to_bill: toBill,
      draws_paid: draws ? draws.filter((d) => d.status === 'paid' && !d.extra).length : null, draws_total: draws ? draws.filter((d) => !d.extra).length : null,
      draw_flags: draws ? draws.filter((d) => d.flag).map((d) => `Draw ${d.n}: ${d.flag}`) : [],
      vehicle_cost: vehicle, total_cost: cost, profit,
      margin: j.income > 0 ? profit / j.income : null, per_hour: j.my_hours > 0 ? round2(profit / j.my_hours) : null };
  });
}
async function upsertJob(b) {
  const fields = ['client', 'address', 'status', 'pricing', 'contract_amount', 'budget_cost', 'start_date', 'end_date', 'source', 'notes'];
  // Rule "What counts as a job": with invoices only, new jobs come from the Invoicing tab, never from here.
  if (!b.id && (await require('./rules').getRules()).jobs_source === 'invoices_only' && !(await resolveJob(b.name))) {
    throw Object.assign(new Error('Jobs come only from invoices (Settings → Books rules). Create the invoice in the Invoicing tab and its job appears.'), { status: 400 });
  }
  const id = b.id ? Number(b.id) : await resolveJob(b.name, { create: true, client: b.client });
  const sets = []; const vals = [id];
  if (b.name && b.id) { vals.push(b.name.trim()); sets.push(`name=$${vals.length}`); }
  for (const f of fields) if (b[f] !== undefined) { vals.push(b[f] === '' ? null : b[f]); sets.push(`${f}=$${vals.length}`); }
  if (!sets.length) return (await q('SELECT * FROM jobs WHERE id=$1', [id])).rows[0];
  const { rows } = await q(`UPDATE jobs SET ${sets.join(', ')} WHERE id=$1 RETURNING *`, vals);
  return rows[0];
}

// ---------- mileage & time ----------
async function addMileage(m) {
  const miles = Number(m.miles);
  if (!(miles > 0)) throw new Error('Miles must be greater than zero');
  const jobId = await resolveJob(m.job_id || m.job_name || null);
  const { rows } = await q('INSERT INTO mileage (date, miles, job_id, purpose) VALUES ($1,$2,$3,$4) RETURNING *',
    [m.date || todayISO(), miles, jobId, m.purpose || null]);
  return rows[0];
}
async function listMileage(year) {
  const settings = await getSettings();
  const { rows } = await q(`SELECT m.*, j.name AS job_name FROM mileage m LEFT JOIN jobs j ON j.id=m.job_id
     WHERE ($1::int IS NULL OR EXTRACT(YEAR FROM m.date)=$1) ORDER BY m.date DESC, m.id DESC`, [year || null]);
  return rows.map((r) => { const rate = mileageRateFor(r.date, settings); return { ...r, rate, deduction: round2(r.miles * rate) }; });
}
async function addTimeEntries(date, entries) {
  const out = [];
  for (const e of entries || []) {
    if (!(Number(e.hours) > 0)) continue;
    const jobId = await resolveJob(e.job_id || e.job_name || null);
    const worker = (e.worker || 'Me').trim() || 'Me';
    if (worker !== 'Me') await q(`INSERT INTO workers (name, role) VALUES ($1,'helper') ON CONFLICT (name) DO NOTHING`, [worker]);
    const { rows } = await q('INSERT INTO time_entries (date, worker, job_id, hours, est_earned, note) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [e.date || date || todayISO(), worker, jobId, Number(e.hours), e.est_earned ?? null, e.note || null]);
    out.push(rows[0]);
  }
  return out;
}
// Weekly timesheet: replace one person's hours for one Monday–Sunday week in a single step, so the grid on
// Jobs → Crew & hours is always exactly what's stored (no doubled days from saving twice).
async function setWeekHours(worker, monday, entries) {
  worker = String(worker || 'Me').trim() || 'Me';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(monday || ''))) throw Object.assign(new Error('Pick a week'), { status: 400 });
  const start = new Date(monday + 'T12:00:00Z');
  if (start.getUTCDay() !== 1) throw Object.assign(new Error('A week starts on Monday'), { status: 400 });
  const sunday = new Date(start.getTime() + 6 * 86400000).toISOString().slice(0, 10);
  const rows = [];
  for (const e of entries || []) {
    const hours = Math.round(Number(e.hours) * 100) / 100;
    if (!(hours > 0)) continue;
    if (hours > 24) throw Object.assign(new Error(`${e.date}: more than 24 hours in a day`), { status: 400 });
    if (!(e.date >= monday && e.date <= sunday)) throw Object.assign(new Error(`${e.date} isn't in this week`), { status: 400 });
    rows.push({ date: e.date, hours, job_id: e.job_id ? await resolveJob(e.job_id) : null, note: e.note ? String(e.note).slice(0, 300) : null,
      est_earned: e.est_earned === '' || e.est_earned == null ? null : Number(e.est_earned) });
  }
  const perDay = {}; rows.forEach((r) => { perDay[r.date] = (perDay[r.date] || 0) + r.hours; });
  const over = Object.entries(perDay).find(([, h]) => h > 24);
  if (over) throw Object.assign(new Error(`${over[0]}: more than 24 hours in a day`), { status: 400 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (worker !== 'Me') await client.query(`INSERT INTO workers (name, role) VALUES ($1,'helper') ON CONFLICT (name) DO NOTHING`, [worker]);
    await client.query('DELETE FROM time_entries WHERE worker=$1 AND date BETWEEN $2 AND $3', [worker, monday, sunday]);
    for (const r of rows) await client.query('INSERT INTO time_entries (date, worker, job_id, hours, est_earned, note) VALUES ($1,$2,$3,$4,$5,$6)',
      [r.date, worker, r.job_id, r.hours, r.est_earned, r.note]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  return { worker, from: monday, to: sunday, entries: rows.length, hours: Math.round(rows.reduce((a, r) => a + r.hours, 0) * 100) / 100 };
}
// Hours per person per week, for the "previous weeks" list.
async function weeklyHours(weeks = 12) {
  const { rows } = await q(`SELECT to_char(date_trunc('week', date), 'YYYY-MM-DD') AS week, worker, SUM(hours)::float AS hours, COUNT(DISTINCT date)::int AS days
     FROM time_entries WHERE date >= date_trunc('week', CURRENT_DATE) - ($1::int * interval '1 week') GROUP BY 1, 2 ORDER BY 1 DESC, 2`, [weeks]);
  return rows;
}
async function listTimeEntries({ from, to, job_id, worker } = {}) {
  const { rows } = await q(`SELECT te.*, j.name AS job_name FROM time_entries te LEFT JOIN jobs j ON j.id=te.job_id
     WHERE ($1::date IS NULL OR te.date >= $1) AND ($2::date IS NULL OR te.date <= $2) AND ($3::int IS NULL OR te.job_id=$3)
       AND ($4::text IS NULL OR te.worker=$4)
     ORDER BY te.date DESC, te.id DESC LIMIT 1000`, [from || null, to || null, job_id || null, worker || null]);
  return rows;
}

// ---------- taxes (sole proprietor / single-member LLC) ----------
const LINE_LABELS = {
  L1: 'Line 1 – Gross receipts', L6: 'Line 6 – Other income', COGS: 'Part III – Cost of goods sold (materials)',
  L8: 'Line 8 – Advertising', L9: 'Line 9 – Car and truck expenses', L11: 'Line 11 – Contract labor',
  L13: 'Line 13 – Depreciation / Section 179', L15: 'Line 15 – Insurance', L16b: 'Line 16b – Interest (other)',
  L17: 'Line 17 – Legal & professional services', L18: 'Line 18 – Office expense',
  L20a: 'Line 20a – Rent: vehicles, machinery, equipment', L20b: 'Line 20b – Rent: other business property',
  L21: 'Line 21 – Repairs and maintenance', L22: 'Line 22 – Supplies', L23: 'Line 23 – Taxes and licenses',
  L24a: 'Line 24a – Travel', L24b: 'Line 24b – Deductible meals', L25: 'Line 25 – Utilities',
  L26: 'Line 26 – Wages', L27a: 'Line 27a – Other expenses (Part V)', NONE: 'Not deductible',
};
function quarterDeadlines(year) {
  return [
    { q: 'Q1', period: `Jan 1 – Mar 31, ${year}`, due: `${year}-04-15`, from: `${year}-01-16`, to: `${year}-04-15` },
    { q: 'Q2', period: `Apr 1 – May 31, ${year}`, due: `${year}-06-15`, from: `${year}-04-16`, to: `${year}-06-15` },
    { q: 'Q3', period: `Jun 1 – Aug 31, ${year}`, due: `${year}-09-15`, from: `${year}-06-16`, to: `${year}-09-15` },
    { q: 'Q4', period: `Sep 1 – Dec 31, ${year}`, due: `${year + 1}-01-15`, from: `${year}-09-16`, to: `${year + 1}-01-31` },
  ];
}
function bracketTax(taxable, brackets) {
  let tax = 0; let prev = 0; let marginal = brackets[0][1];
  for (const [top, rate] of brackets) {
    const cap = top === null ? Infinity : top;
    if (taxable > prev) { tax += (Math.min(taxable, cap) - prev) * rate; marginal = rate; }
    prev = cap;
    if (taxable <= cap) break;
  }
  return { tax, marginal };
}
// Tax attributable to the business at a given Schedule C net profit.
function estimateTaxes(net, year, settings) {
  const wageBase = Number(yearValue(settings.ss_wage_base, year)) || 184500;
  const seBase = Math.max(0, net * 0.9235);
  const seTax = net > 0 && seBase >= 400 ? Math.min(seBase, wageBase) * 0.124 + seBase * 0.029 : 0;
  const halfSe = seTax / 2;
  const tables = yearValue(settings.tax_tables, year) || {};
  const tbl = tables[settings.filing_status] || tables.single;
  const other = Number(settings.other_income) || 0;
  let federal = 0; let marginal = 0.12; let qbi = 0; let taxable = 0;
  if (tbl) {
    const before = Math.max(0, net + other - halfSe - tbl.std);
    qbi = settings.apply_qbi === false || settings.apply_qbi === 'false' ? 0 : 0.2 * Math.min(Math.max(0, net - halfSe), before);
    taxable = Math.max(0, before - qbi);
    const withBiz = bracketTax(taxable, tbl.brackets);
    const without = bracketTax(Math.max(0, other - tbl.std), tbl.brackets);
    federal = Math.max(0, withBiz.tax - without.tax);
    marginal = withBiz.marginal;
  }
  const bid = Number(settings.ohio_bid) || 0;
  const ohioBase = Math.max(0, net - halfSe - bid);
  const ohio = ohioBase * (Number(settings.ohio_business_rate) || 0) / 100;
  const school = ohioBase * (Number(settings.school_district_rate) || 0) / 100;
  const city = Math.max(0, net) * (Number(settings.city_rate) || 0) / 100;
  const total = seTax + federal + ohio + school + city;
  return {
    se_base: round2(seBase), wage_base: wageBase, se_tax: round2(seTax), half_se_deduction: round2(halfSe), qbi_deduction: round2(qbi),
    federal_taxable: round2(taxable), federal_income_tax: round2(federal), federal_marginal: marginal,
    ohio_bid: bid, ohio_tax: round2(ohio), school_tax: round2(school), city_tax: round2(city), total: round2(total),
  };
}

async function taxSummary(year) {
  year = Number(year) || new Date().getFullYear();
  const settings = await getSettings();
  const from = `${year}-01-01`; const to = `${year}-12-31`;
  const byCat = await q(
    `SELECT t.kind, t.category, COALESCE(c.sched_c,'L27a') AS sched_c, SUM(t.amount) AS total, COUNT(*) AS n
     FROM transactions t LEFT JOIN categories c ON c.name=t.category WHERE t.date BETWEEN $1 AND $2 AND t.category<>'Invoiced – Awaiting Payment' GROUP BY 1,2,3 ORDER BY 3,2`, [from, to]);
  const lines = {}; const notDeducted = [];
  const vehicleStandard = settings.vehicle_method !== 'actual';
  for (const r of byCat.rows) {
    let amt = Number(r.total); const line = r.sched_c;
    if (line === 'NONE') { notDeducted.push({ category: r.category, amount: round2(amt), reason: 'Not a business deduction' }); continue; }
    if (line === 'L9' && vehicleStandard) { notDeducted.push({ category: r.category, amount: round2(amt), reason: 'Standard mileage method – actual vehicle costs are not deducted' }); continue; }
    let note = null;
    if (line === 'L24b') { note = `50% of $${round2(amt).toFixed(2)}`; amt *= 0.5; }
    if (!lines[line]) lines[line] = { line, label: LINE_LABELS[line] || line, amount: 0, categories: [] };
    lines[line].amount += amt;
    lines[line].categories.push({ category: r.category, amount: round2(amt), count: Number(r.n), note });
  }
  const mileage = await q('SELECT date, miles FROM mileage WHERE date BETWEEN $1 AND $2', [from, to]);
  let totalMiles = 0; let mileageDeduction = 0;
  for (const m of mileage.rows) { totalMiles += m.miles; mileageDeduction += m.miles * mileageRateFor(m.date, settings); }
  if (vehicleStandard && mileageDeduction > 0) {
    if (!lines.L9) lines.L9 = { line: 'L9', label: LINE_LABELS.L9, amount: 0, categories: [] };
    lines.L9.amount += mileageDeduction;
    lines.L9.categories.push({ category: `Standard mileage (${round2(totalMiles)} mi)`, amount: round2(mileageDeduction), count: mileage.rows.length });
  }
  for (const l of Object.values(lines)) l.amount = round2(l.amount);
  const gross = lines.L1 ? lines.L1.amount : 0;
  const otherIncome = lines.L6 ? lines.L6.amount : 0;
  const cogs = lines.COGS ? lines.COGS.amount : 0;
  const grossIncome = round2(gross - cogs + otherIncome);
  const expenseLines = Object.values(lines).filter((l) => !['L1', 'L6', 'COGS'].includes(l.line)).sort((a, b) => a.line.localeCompare(b.line, 'en', { numeric: true }));
  const totalExpenses = round2(expenseLines.reduce((s, l) => s + l.amount, 0));
  const tentative = round2(grossIncome - totalExpenses);
  // Line 30: home office, simplified method ($5/sq ft, max 300 sq ft), can't create a loss.
  const sqft = Math.min(300, Number(settings.home_office_sqft) || 0);
  const homeOffice = round2(Math.max(0, Math.min(sqft * 5, tentative)));
  const netProfit = round2(tentative - homeOffice);

  const est = estimateTaxes(netProfit, year, settings);
  const paidRows = await q(`SELECT date, amount, memo, party FROM transactions WHERE category='Estimated Tax Payment' AND date BETWEEN $1 AND $2 ORDER BY date`, [`${year}-01-16`, `${year + 1}-01-31`]);
  const paid = round2(paidRows.rows.reduce((s, r) => s + r.amount, 0));
  const now = new Date();
  const elapsed = year < now.getFullYear() ? 1 : year > now.getFullYear() ? 0 : (now - new Date(year, 0, 1)) / (new Date(year + 1, 0, 1) - new Date(year, 0, 1));
  const projectedProfit = elapsed > 0.05 ? round2(netProfit / elapsed) : null;
  const annual = projectedProfit !== null ? estimateTaxes(projectedProfit, year, settings) : est;
  const deadlines = quarterDeadlines(year).map((d) => ({ ...d, suggested: round2(annual.total / 4),
    paid: round2(paidRows.rows.filter((p) => p.date >= d.from && p.date <= d.to).reduce((s, p) => s + p.amount, 0)) }));
  const today = todayISO();

  // 1099-NEC tracker
  const threshold = Number(yearValue(settings.threshold_1099, year));
  const subs = await q(`SELECT COALESCE(NULLIF(trim(party),''),'(no name)') AS payee, SUM(amount) AS total, COUNT(*) AS n,
       array_agg(DISTINCT method) FILTER (WHERE method IS NOT NULL) AS methods
     FROM transactions WHERE category='Subcontractors' AND date BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 2 DESC`, [from, to]);

  // Ohio sales & use tax on materials
  const st = await q(`SELECT COALESCE(SUM(sales_tax),0) AS paid, COALESCE(SUM(CASE WHEN untaxed THEN amount END),0) AS untaxed_amt,
       COUNT(*) FILTER (WHERE untaxed) AS untaxed_n FROM transactions WHERE kind='expense' AND date BETWEEN $1 AND $2`, [from, to]);
  const useRate = Number(settings.use_tax_rate) || 0;

  // Planned purchases: what expensing each one this year would save, at your projected profit.
  const base = projectedProfit ?? netProfit;
  const pp = await q(`SELECT * FROM planned_purchases WHERE status<>'dropped' ORDER BY planned_date NULLS LAST, id`);
  const baseTax = estimateTaxes(base, year, settings).total;
  const planned = pp.rows.map((p) => {
    const ded = round2(p.cost * p.business_pct / 100);
    const saving = round2(baseTax - estimateTaxes(base - ded, year, settings).total);
    return { ...p, deduction: ded, est_saving: saving,
      warning: (p.kind === 'truck' && vehicleStandard) ? 'You use the standard mileage rate. Depreciating or expensing a truck means using actual expenses for it instead – compare both with your accountant before buying.' : null };
  });

  return {
    year, vehicle_method: vehicleStandard ? 'standard' : 'actual', filing_status: settings.filing_status,
    income: { gross_receipts: gross, other_income: otherIncome, cogs, gross_profit: round2(gross - cogs), gross_income: grossIncome },
    lines: Object.values(lines), expense_lines: expenseLines, total_expenses: totalExpenses,
    tentative_profit: tentative, home_office: { sqft, deduction: homeOffice }, net_profit: netProfit, not_deducted: notDeducted,
    mileage: { miles: round2(totalMiles), deduction: round2(mileageDeduction), trips: mileage.rows.length },
    estimate: { ...est, paid, remaining: round2(est.total - paid), payments: paidRows.rows,
      effective_set_aside_pct: netProfit > 0 ? round2((est.total / netProfit) * 100) : 0,
      projected_full_year_profit: projectedProfit, projected_full_year_tax: annual.total },
    deadlines, next_deadline: deadlines.find((d) => d.due >= today) || null,
    contractors_1099: { threshold, payees: subs.rows.map((r) => ({ ...r, total: round2(r.total), n: Number(r.n), needs_1099: r.total >= threshold })) },
    sales_use_tax: { sales_tax_paid: round2(st.rows[0].paid), untaxed_purchases: round2(st.rows[0].untaxed_amt), untaxed_count: Number(st.rows[0].untaxed_n),
      use_tax_rate: useRate, est_use_tax_due: round2(st.rows[0].untaxed_amt * useRate / 100) },
    planned_purchases: planned,
  };
}

// ---------- analytics / summaries ----------
async function analytics({ from, to } = {}) {
  to = to || todayISO();
  from = from || `${Number(to.slice(0, 4)) - 1}${to.slice(4, 7)}-01`;
  const monthly = await q(
    `SELECT to_char(date_trunc('month', date), 'YYYY-MM') AS month,
       SUM(CASE WHEN kind='income' AND category NOT IN ${NOT_REVENUE} THEN amount ELSE 0 END) AS income,
       SUM(CASE WHEN kind='expense' AND category NOT IN ${NOT_OPERATING} THEN amount ELSE 0 END) AS expense
     FROM transactions WHERE date BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 1`, [from, to]);
  const months = [];
  const d = new Date(from.slice(0, 7) + '-01T00:00:00'); const end = new Date(to.slice(0, 7) + '-01T00:00:00');
  while (d <= end) { months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`); d.setMonth(d.getMonth() + 1); }
  const map = Object.fromEntries(monthly.rows.map((r) => [r.month, r]));
  const hoursRows = await q(`SELECT to_char(date_trunc('month', date), 'YYYY-MM') AS month, SUM(hours) FILTER (WHERE worker='Me') AS mine, SUM(hours) AS all_hours
     FROM time_entries WHERE date BETWEEN $1 AND $2 GROUP BY 1`, [from, to]);
  const hmap = Object.fromEntries(hoursRows.rows.map((r) => [r.month, r]));
  const series = months.map((m) => {
    const r = map[m] || { income: 0, expense: 0 };
    return { month: m, income: round2(r.income), expense: round2(r.expense), profit: round2(r.income - r.expense), my_hours: Number(hmap[m]?.mine || 0) };
  });
  const byCategory = await q(`SELECT category, SUM(amount) AS total FROM transactions WHERE kind='expense' AND category NOT IN ${NOT_OPERATING}
     AND date BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 2 DESC`, [from, to]);
  const catByMonth = await q(`SELECT to_char(date_trunc('month', date), 'YYYY-MM') AS month, category, SUM(amount) AS total FROM transactions
     WHERE kind='expense' AND category NOT IN ${NOT_OPERATING} AND date BETWEEN $1 AND $2 GROUP BY 1,2`, [from, to]);
  const jobs = (await listJobs()).filter((j) => j.income > 0 || j.total_cost > 0).slice(0, 12);
  const prod = await q(`SELECT date, met, est_earned, hours, jsonb_array_length(goals) AS goals_n,
       (SELECT COUNT(*) FROM jsonb_array_elements(goals) g WHERE (g->>'done')::boolean) AS done_n
     FROM daily_logs WHERE date BETWEEN $1 AND $2 ORDER BY date`, [from, to]);
  const weekdays = await q(`SELECT EXTRACT(DOW FROM date)::int AS dow, SUM(amount) AS income FROM transactions
     WHERE date BETWEEN $1 AND $2 AND kind='income' AND category NOT IN ${NOT_REVENUE} GROUP BY 1`, [from, to]);
  const est = await q(`SELECT status, COUNT(*)::int AS n, SUM(total) AS total FROM estimates WHERE est_date BETWEEN $1 AND $2 GROUP BY 1`, [from, to]);
  const totals = series.reduce((a, s) => ({ income: a.income + s.income, expense: a.expense + s.expense, hours: a.hours + s.my_hours }), { income: 0, expense: 0, hours: 0 });
  const decided = est.rows.filter((r) => ['accepted', 'declined'].includes(r.status)).reduce((s, r) => s + r.n, 0);
  const won = (est.rows.find((r) => r.status === 'accepted') || { n: 0 }).n;
  return {
    from, to, series,
    totals: { income: round2(totals.income), expense: round2(totals.expense), profit: round2(totals.income - totals.expense),
      margin: totals.income > 0 ? (totals.income - totals.expense) / totals.income : null, my_hours: totals.hours,
      per_hour: totals.hours > 0 ? round2((totals.income - totals.expense) / totals.hours) : null },
    by_category: byCategory.rows.map((r) => ({ category: r.category, total: round2(r.total) })),
    category_by_month: catByMonth.rows.map((r) => ({ ...r, total: round2(r.total) })),
    jobs: jobs.map((j) => ({ name: j.name, income: j.income, cost: j.total_cost, profit: j.profit, margin: j.margin, per_hour: j.per_hour })),
    productivity: prod.rows.map((r) => ({ ...r, goals_n: Number(r.goals_n), done_n: Number(r.done_n) })),
    weekdays: weekdays.rows.map((r) => ({ dow: r.dow, income: round2(r.income) })),
    estimates: { by_status: est.rows, win_rate: decided ? won / decided : null },
  };
}
async function periodSummary(period = 'month') {
  const today = todayISO();
  const from = period === 'ytd' ? `${today.slice(0, 4)}-01-01`
    : period === 'last30' ? new Date(Date.parse(today) - 29 * 86400000).toISOString().slice(0, 10)
      : period === 'week' ? new Date(Date.parse(today) - 6 * 86400000).toISOString().slice(0, 10)
        : `${today.slice(0, 7)}-01`;
  const { rows } = await q(`SELECT
       COALESCE(SUM(CASE WHEN kind='income' AND category NOT IN ${NOT_REVENUE} THEN amount END),0) AS income,
       COALESCE(SUM(CASE WHEN kind='expense' AND category NOT IN ${NOT_OPERATING} THEN amount END),0) AS expense
     FROM transactions WHERE date BETWEEN $1 AND $2`, [from, today]);
  const cats = await q(`SELECT category, SUM(amount) AS total FROM transactions WHERE kind='expense' AND date BETWEEN $1 AND $2
     AND category NOT IN ${NOT_OPERATING} GROUP BY 1 ORDER BY 2 DESC LIMIT 6`, [from, today]);
  const hrs = await q(`SELECT COALESCE(SUM(hours) FILTER (WHERE worker='Me'),0) AS mine FROM time_entries WHERE date BETWEEN $1 AND $2`, [from, today]);
  const r = rows[0];
  return { period, from, to: today, income: round2(r.income), expense: round2(r.expense), profit: round2(r.income - r.expense),
    my_hours: Number(hrs.rows[0].mine), top_expenses: cats.rows.map((c) => ({ category: c.category, total: round2(c.total) })) };
}
async function overview() {
  const today = todayISO();
  const year = Number(today.slice(0, 4));
  const [month, ytd, invoices, tax, log, recent, settings, pending] = await Promise.all([
    periodSummary('month'), periodSummary('ytd'), listInvoices({ status: 'unpaid' }), taxSummary(year),
    q('SELECT * FROM daily_logs WHERE date=$1', [today]), listTransactions({ limit: 8 }), getSettings(),
    q(`SELECT COUNT(*)::int AS n FROM proposals WHERE status='pending'`),
  ]);
  const lmStart = new Date(year, Number(today.slice(5, 7)) - 2, 1);
  const lmEnd = new Date(year, Number(today.slice(5, 7)) - 1, 0);
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const lm = await q(`SELECT COALESCE(SUM(CASE WHEN kind='income' AND category NOT IN ${NOT_REVENUE} THEN amount END),0) AS income,
       COALESCE(SUM(CASE WHEN kind='expense' AND category NOT IN ${NOT_OPERATING} THEN amount END),0) AS expense
     FROM transactions WHERE date BETWEEN $1 AND $2`, [iso(lmStart), iso(lmEnd)]);
  const active = await q(`SELECT COUNT(*)::int AS n FROM jobs WHERE status='active' AND draws IS NOT NULL`);
  const unbilled = await q(`SELECT COALESCE(SUM(amount * (1 + COALESCE(markup_pct,0)/100)),0) AS v FROM transactions WHERE billable AND NOT billed`);
  const week = await q(`SELECT COALESCE(SUM(est_earned),0) AS est, COUNT(*) FILTER (WHERE met='yes')::int AS met,
     COUNT(*) FILTER (WHERE met IS NOT NULL)::int AS judged FROM daily_logs WHERE date > $1::date - 7`, [today]);
  return {
    today, month, ytd, last_month: { income: round2(lm.rows[0].income), expense: round2(lm.rows[0].expense) },
    goal_monthly_revenue: Number(settings.goal_monthly_revenue) || 0,
    receivables: { total: round2(invoices.reduce((s, i) => s + i.balance, 0)), count: invoices.length,
      overdue: invoices.filter((i) => i.status === 'overdue').length, items: invoices.slice(0, 6) },
    unbilled: round2(unbilled.rows[0].v),
    backlog: await (async () => { const js = (await listJobs()).filter((j) => j.status === 'active' && j.from_invoices);
      return { shown: (await require('./rules').getRules()).count_to_bill === 'show', to_bill: round2(js.reduce((a, j) => a + j.to_bill, 0)), jobs: js.filter((j) => j.to_bill > 0).length,
        flags: js.flatMap((j) => j.draw_flags.map((f) => `${j.name} · ${f}`)) }; })(),
    tax: { net_profit: tax.net_profit, estimate: tax.estimate.total, paid: tax.estimate.paid, remaining: tax.estimate.remaining,
      pct: tax.estimate.effective_set_aside_pct, next_deadline: tax.next_deadline },
    today_log: log.rows[0] || null,
    week: { est_earned: round2(week.rows[0].est), days_met: week.rows[0].met, days_judged: week.rows[0].judged },
    active_jobs: active.rows[0].n, pending_approvals: pending.rows[0].n, recent,
  };
}

module.exports = {
  AWAITING, round2, todayISO, mileageRateFor, addTransaction, updateTransaction, addSplit, listTransactions, listInvoices, upsertInvoice,
  listEstimates, listJobs, upsertJob, addMileage, listMileage, addTimeEntries, listTimeEntries, setWeekHours, weeklyHours, taxSummary, estimateTaxes,
  analytics, periodSummary, overview, LINE_LABELS,
};
