// Importers: the LuxCraft invoice/estimate app, and bank/card CSV statements.
const crypto = require('crypto');
const { q, resolveJob, getSettings } = require('./db');
const S = require('./services');

const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
const r2 = (n) => Math.round(n * 100) / 100;
const toDate = (v) => {
  if (!v) return null;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s); return isNaN(d) ? null : d.toISOString().slice(0, 10);
};

// ---------- LuxCraft invoice app ----------
// Job identity is client + project, the same on estimates and invoices, so both land on one job.
function jobNameFor(st) {
  const client = String(st.client?.name || '').trim();
  const project = String(st.project || '').trim();
  return (project ? `${client} · ${project}` : client).slice(0, 120) || null;
}
function drawAmounts(st) {
  const proposal = num(st.proposal);
  return (st.draws || []).map((d) => r2(st.mode === 'pct' ? proposal * num(d.val) / 100 : num(d.val)));
}
function invoiceTotal(rec) {
  const st = rec.st; const ci = Math.min(st.currentIdx || 0, (st.draws || []).length - 1);
  if (num(rec.total)) return num(rec.total);
  const items = (st.items || []).reduce((s, it) => s + num(it.amt), 0);
  const sub = drawAmounts(st)[ci] + items;
  return r2(sub * (1 + num(st.taxRate) / 100));
}

// A number can only belong to one record. If another record from the app already uses it
// (a copied estimate, a hand-edited number), keep both by giving this one a suffix: "EST-1001 (2)".
async function freeNumber(table, col, wanted, selfId) {
  // Keep a suffix this record already has, so its number doesn't shuffle between syncs.
  if (selfId) {
    const cur = (await q(`SELECT ${col} AS v FROM ${table} WHERE id=$1`, [selfId])).rows[0];
    const esc = wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (cur && new RegExp(`^${esc} \\(\\d+\\)$`, 'i').test(cur.v)) {
      const taken = (await q(`SELECT 1 FROM ${table} WHERE lower(${col})=lower($1) AND id<>$2`, [wanted, selfId])).rows.length;
      if (taken) return cur.v;
    }
  }
  let candidate = wanted; let n = 1;
  for (;;) {
    const { rows } = await q(`SELECT id FROM ${table} WHERE lower(${col})=lower($1) AND ($2::int IS NULL OR id<>$2) LIMIT 1`, [candidate, selfId || null]);
    if (!rows.length) return candidate;
    n += 1; candidate = `${wanted} (${n})`;
  }
}

async function importEstimate(rec, source, stats) {
  const st = rec.st;
  const extId = `${source}:est:${rec.id}`;
  const wanted = String(st.estNo || '').trim() || `EST-${String(rec.id).slice(0, 6)}`;
  const jobName = jobNameFor(st);
  const jobId = jobName ? await resolveJob(jobName, { create: true, client: st.client?.name || null,
    status: rec.status === 'accepted' ? 'active' : rec.status === 'declined' ? 'lost' : 'estimating' }) : null;
  const items = [];
  for (const sec of st.sections || []) for (const it of sec.items || []) {
    if (!String(it.desc || '').trim() && !num(it.rate)) continue;
    items.push({ section: sec.name || '', desc: it.desc, qty: num(it.qty), unit: it.unit, rate: num(it.rate), total: r2(num(it.qty) * num(it.rate)), optional: !!it.optional });
  }
  const existing = (await q('SELECT id FROM estimates WHERE external_id=$1', [extId])).rows[0];
  const estNo = await freeNumber('estimates', 'est_no', wanted, existing && existing.id);
  if (estNo !== wanted) stats.renamed.push(`${wanted} → ${estNo}`);
  const vals = [estNo, jobId, st.client?.name || null, st.project || null, toDate(st.estDate), toDate(st.validUntil), num(rec.total),
    rec.status || 'draft', JSON.stringify(items), st.scope || null];
  if (existing) {
    await q(`UPDATE estimates SET est_no=$2, job_id=$3, client=$4, project=$5, est_date=$6, valid_until=$7, total=$8, status=$9, items=$10, scope=$11, updated_at=now() WHERE id=$1`, [existing.id, ...vals]);
  } else {
    await q(`INSERT INTO estimates (est_no, job_id, client, project, est_date, valid_until, total, status, items, scope, source, external_id, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())`, [...vals, source, extId]);
  }
  if (jobId) {
    stats.jobs_touched.add(jobId);
    // An accepted estimate makes the job active with the bid as its contract (unless set by hand).
    if (rec.status === 'accepted') await q(`UPDATE jobs SET status=CASE WHEN status IN ('lead','estimating') THEN 'active' ELSE status END,
        contract_amount=COALESCE(contract_amount,$2), pricing='fixed', source=COALESCE(source,'estimate') WHERE id=$1`, [jobId, num(rec.total)]);
    else if (['draft', 'sent'].includes(rec.status)) await q(`UPDATE jobs SET status=CASE WHEN status='lead' THEN 'estimating' ELSE status END WHERE id=$1`, [jobId]);
    else if (rec.status === 'declined') await q(`UPDATE jobs SET status=CASE WHEN status IN ('lead','estimating') THEN 'lost' ELSE status END WHERE id=$1`, [jobId]);
  }
  stats.estimates++;
}

// Due date from the invoice's terms: "Net 30" / "30 days" → invoice date + 30; "Due upon receipt" → invoice date
// plus the grace days in Settings (so it isn't flagged overdue the next morning); anything else → no due date.
function dueDateFor(terms, invDate, graceDays) {
  if (!invDate) return null;
  const t = String(terms || '').toLowerCase();
  const add = (n) => { const d = new Date(invDate + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  const m = t.match(/net\s*(\d{1,3})|(\d{1,3})\s*days?/);
  if (m) return add(Number(m[1] || m[2]));
  if (/receipt|due now|immediately|on completion/.test(t)) return add(Number(graceDays) || 0);
  return null;
}
const drawIndex = (st) => Math.max(0, Math.min(num(st.currentIdx), (st.draws || []).length - 1));

async function importInvoice(rec, source, stats) {
  const st = rec.st; const ci = drawIndex(st);
  const extId = `${source}:inv:${rec.id}`;
  const wanted = String(st.invNo).trim();
  const jobName = jobNameFor(st);
  const client = String(st.client?.name || '').trim() || null;
  const site = [st.site1, st.site2].map((x) => String(x || '').trim()).filter(Boolean).join(', ')
    || [st.client?.a1, st.client?.a2].map((x) => String(x || '').trim()).filter(Boolean).join(', ') || null;
  const jobId = jobName ? await resolveJob(jobName, { create: true, client }) : null;
  if (jobId) {
    stats.jobs_touched.add(jobId);
    await q(`UPDATE jobs SET client=COALESCE(client,$2), address=COALESCE(address,$3), pricing='fixed',
      status=CASE WHEN status IN ('lead','estimating') THEN 'active' ELSE status END WHERE id=$1`, [jobId, client, site]);
  }
  const amount = invoiceTotal(rec);
  const drawAmt = drawAmounts(st)[ci] || 0;
  const itemsTotal = r2((st.items || []).reduce((s2, it) => s2 + num(it.amt), 0));
  const tax = r2(Math.max(0, amount - drawAmt - itemsTotal));
  const issue = toDate(st.invDate);
  const due = dueDateFor(st.terms, issue, stats.settings.receipt_grace_days);
  // Same invoice from the app (by its id) → update it. Otherwise, a hand-entered/uploaded invoice with the same
  // number and no app link is the same invoice → adopt it. Otherwise it's new.
  let existing = (await q('SELECT id FROM invoices WHERE external_id=$1', [extId])).rows[0];
  if (!existing) existing = (await q('SELECT id FROM invoices WHERE lower(invoice_no)=lower($1) AND external_id IS NULL', [wanted])).rows[0];
  const invNo = await freeNumber('invoices', 'invoice_no', wanted, existing && existing.id);
  if (invNo !== wanted) stats.renamed.push(`${wanted} → ${invNo}`);
  const vals = [invNo, jobId, client, issue, due, amount, st.draws?.[ci]?.label || `Draw ${ci + 1}`, st.project || null,
    ci + 1, (st.draws || []).length, st.terms || null, drawAmt, itemsTotal, tax, num(st.proposal) || null, rec.status || 'unpaid'];
  if (existing) {
    await q(`UPDATE invoices SET invoice_no=$2, job_id=$3, client=$4, issue_date=$5, due_date=$6, amount=$7, draw_label=$8, notes=$9,
      draw_no=$10, draw_count=$11, terms=$12, draw_amount=$13, items_total=$14, tax=$15, contract_amount=$16, app_status=$17,
      external_id=$18, source=$19, void=false WHERE id=$1`, [existing.id, ...vals, extId, source]);
  } else {
    await q(`INSERT INTO invoices (invoice_no, job_id, client, issue_date, due_date, amount, draw_label, notes, draw_no, draw_count, terms,
      draw_amount, items_total, tax, contract_amount, app_status, external_id, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [...vals, extId, source]);
  }
  stats.invoices++;
  stats.stored[rec.id] = { invoice_no: invNo, amount, items: itemsTotal, tax, job_id: jobId, client, issue_date: issue, due_date: due };
}

// ---------- contracts, draws and the ledger ----------
// All invoices for one client + project are one contract. The newest invoice holds the current draw schedule.
// A draw is PAID only when you mark it: its invoice is marked Paid in the invoice app, or a check # is entered for it
// on a later invoice's draw schedule. A billed draw that isn't marked paid stays owed, even if a later invoice
// prints it under "Paid to date" (the Cockpit flags that so you can mark it).
// Every billed draw is one income-ledger row: "Invoiced – Awaiting Payment" (invoice date) until paid, then
// "Contract Revenue" (paid date, check #). Rows always match the invoice app.
function contractSchedule(recs, stats) {
  const byNew = (x, y) => String(y.updatedAt || y.st.invDate || '').localeCompare(String(x.updatedAt || x.st.invDate || ''));
  const present = recs.slice().sort((x, y) => (drawIndex(y.st) - drawIndex(x.st)) || byNew(x, y))[0];
  const st = present.st; const draws = st.draws || [];
  const amounts = drawAmounts(st);
  const billerOf = {};
  for (const r of recs.slice().sort(byNew)) { const i = drawIndex(r.st); if (!billerOf[i]) billerOf[i] = r; } // newest bill per draw
  const schedule = draws.map((d, i) => {
    const biller = billerOf[i];
    const billed = biller ? stats.stored[biller.id] : null;
    // Payment details recorded on the newest invoice that lists this draw as an earlier draw.
    const later = recs.filter((r) => drawIndex(r.st) > i).sort(byNew)[0];
    const ld = later ? (later.st.draws || [])[i] || {} : {};
    const checkNo = String(ld.ck || '').trim() || null;
    const paidDate = toDate(ld.date);
    const markedPaid = biller && biller.status === 'paid';
    const paid = !!(markedPaid || checkNo);
    let date = null; let note = '';
    if (paid) {
      date = paidDate || (markedPaid ? toDate(biller.updatedAt) : null) || (billed && billed.issue_date);
      note = paidDate ? '' : markedPaid ? ' · dated when marked Paid' : ' · no paid date entered';
    }
    return {
      n: i + 1, label: d.label || `Draw ${i + 1}`, pct: st.mode === 'pct' ? num(d.val) : (num(st.proposal) ? r2(amounts[i] / num(st.proposal) * 100) : null),
      amount: amounts[i] || 0, status: paid ? 'paid' : billed ? 'billed' : 'scheduled',
      invoice_no: billed ? billed.invoice_no : null, billed_amount: billed ? billed.amount : null, items: billed ? billed.items : 0, tax: billed ? billed.tax : 0,
      issue_date: billed ? billed.issue_date : null, due_date: billed ? billed.due_date : null,
      paid_date: paid ? date : null, check_no: checkNo, note,
      flag: !paid && later ? `${(stats.stored[later.id] || {}).invoice_no || 'A later invoice'} prints this draw under "Paid to date", but it isn't marked paid` : null,
      biller_id: biller ? biller.id : null,
    };
  });
  return { present, schedule, contract: num(st.proposal), job_id: (stats.stored[present.id] || {}).job_id ?? null, client: (stats.stored[present.id] || {}).client || null };
}

async function mirrorContracts(valid, source, stats) {
  const groups = {};
  for (const r of valid) (groups[jobNameFor(r.st) || `#${r.id}`] ||= []).push(r);
  const keep = new Set(); const jobs = new Set();
  for (const recs of Object.values(groups)) {
    const c = contractSchedule(recs, stats);
    jobs.add(c.job_id ?? 'none');
    if (c.job_id) {
      const co = r2(c.schedule.reduce((s2, d) => s2 + (d.items || 0), 0));
      await q(`UPDATE jobs SET contract_amount=$2, change_orders=$3, draws=$4, draws_synced_at=now() WHERE id=$1`,
        [c.job_id, c.contract || null, co || null, JSON.stringify(c.schedule.map(({ biller_id, ...d }) => d))]);
    }
    for (const d of c.schedule) {
      if (d.status === 'scheduled') continue;
      const amount = d.billed_amount ?? d.amount;
      if (!(amount > 0)) continue;
      const ref = d.biller_id ? `${source}:invoice:${d.biller_id}` : `${source}:draw:${c.job_id ?? 'none'}:${d.n}`;
      // A payment you entered by hand for this invoice wins; the synced row steps aside so nothing counts twice.
      if (d.invoice_no) {
        const manual = (await q(`SELECT 1 FROM transactions WHERE kind='income' AND created_by<>'sync' AND category<>$2 AND lower(invoice_no)=lower($1) LIMIT 1`,
          [d.invoice_no, S.AWAITING])).rows.length;
        if (manual) continue;
      }
      keep.add(ref);
      const label = `${d.label} (draw ${d.n} of ${c.schedule.length})`;
      const paid = d.status === 'paid';
      const row = paid
        ? { date: d.paid_date || d.issue_date || S.todayISO(), category: 'Contract Revenue', check_no: d.check_no, method: d.check_no ? 'check' : null,
          memo: `${label} · paid${d.note}${d.issue_date ? ` · invoiced ${d.issue_date}` : ''} – from invoice app` }
        : { date: d.issue_date || S.todayISO(), category: S.AWAITING, check_no: null, method: null,
          memo: `${label} · awaiting payment${d.flag ? ' · printed as paid on a later invoice' : ''} – from invoice app` };
      const full = { kind: 'income', amount, party: c.client, job_id: c.job_id, invoice_no: d.invoice_no, ...row };
      const mine = (await q('SELECT id, category FROM transactions WHERE ext_ref=$1', [ref])).rows[0];
      if (mine) {
        // Keep a category you chose yourself for a paid row (e.g. Materials Reimbursement); otherwise follow the invoice.
        const category = paid && mine.category !== S.AWAITING ? mine.category : row.category;
        await q(`UPDATE transactions SET date=$2, amount=$3, category=$4, party=$5, job_id=$6, method=$7, check_no=$8, invoice_no=$9, memo=$10 WHERE id=$1`,
          [mine.id, full.date, full.amount, category, full.party, full.job_id, full.method, full.check_no, full.invoice_no, full.memo]);
        stats.ledger_updated++;
      } else {
        await S.addTransaction({ ...full, ext_ref: ref }, 'sync');
        if (paid) stats.payments_added++; else stats.invoices_added++;
      }
      if (d.flag) stats.flags.push(`${d.invoice_no || c.client}: ${d.flag}`);
    }
  }
  // Remove synced rows whose invoice is gone from the app or that a hand-entered payment now covers.
  // Only for jobs in this sync; rows you entered yourself are never touched.
  for (const job of jobs) {
    const { rows } = await q(`SELECT id, ext_ref FROM transactions WHERE created_by='sync' AND ext_ref LIKE $1 AND ${job === 'none' ? 'job_id IS NULL' : 'job_id=$2'}`,
      job === 'none' ? [`${source}:%`] : [`${source}:%`, Number(job)]);
    for (const t of rows) if (!keep.has(t.ext_ref)) { await q('DELETE FROM transactions WHERE id=$1', [t.id]); stats.ledger_removed++; }
  }
}

async function importInvoiceApp({ invoices = [], estimates = [] }, source = 'invoice-app') {
  const stats = { invoices: 0, estimates: 0, payments_added: 0, invoices_added: 0, ledger_updated: 0, ledger_removed: 0, jobs_touched: new Set(), renamed: [], skipped: [], flags: [], stored: {}, settings: await getSettings() };
  // One bad record never stops the rest of the sync.
  const safely = async (label, fn) => {
    try { await fn(); } catch (e) { stats.skipped.push(`${label}: ${e.message}`); console.error('Invoice-app sync skipped', label, e.message); }
  };
  // Estimates first so jobs get their bid amount.
  for (const rec of estimates) {
    if (!rec || !rec.id || !rec.st) continue;
    await safely(`Estimate ${rec.st.estNo || rec.id}`, () => importEstimate(rec, source, stats));
  }
  const valid = invoices.filter((r) => r && r.id && r.st && String(r.st.invNo || '').trim() && Array.isArray(r.st.draws) && r.st.draws.length);
  for (const rec of valid) await safely(`Invoice ${rec.st.invNo}`, () => importInvoice(rec, source, stats));
  // Invoices deleted in the app: voided here (not deleted) for jobs in this sync; they come back if the app sends them again.
  await safely('Removed invoices', async () => {
    const ids = valid.map((r) => `${source}:inv:${r.id}`);
    const jobIds = [...stats.jobs_touched];
    if (jobIds.length) await q(`UPDATE invoices SET void=true WHERE source=$1 AND job_id = ANY($2) AND NOT (external_id = ANY($3))`, [source, jobIds, ids]);
  });
  await safely('Ledger', () => mirrorContracts(valid.filter((r) => stats.stored[r.id]), source, stats));
  return { invoices: stats.invoices, estimates: stats.estimates, payments_added: stats.payments_added, invoices_added: stats.invoices_added, ledger_updated: stats.ledger_updated,
    ledger_removed: stats.ledger_removed, jobs: stats.jobs_touched.size, renamed: stats.renamed, skipped: stats.skipped, flags: stats.flags };
}

// ---------- bank / card CSV ----------
function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c; continue; }
    if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}
const money = (s) => { if (s === undefined || s === null) return null; const t = String(s).replace(/[$,\s]/g, ''); if (!t) return null; const neg = /^\(.*\)$/.test(t) || t.startsWith('-'); const n = parseFloat(t.replace(/[()-]/g, '')); return isFinite(n) ? (neg ? -n : n) : null; };
// Strip long digit runs (account/card numbers) from descriptions before storing.
const scrub = (s) => String(s || '').replace(/\d[\d\s-]{7,}\d/g, (m) => `••••${m.replace(/\D/g, '').slice(-4)}`).slice(0, 200);

async function importBankCsv(text, account) {
  const rows = parseCsv(text.replace(/^﻿/, ''));
  if (rows.length < 2) throw new Error('That CSV looks empty.');
  let h = rows.findIndex((r) => r.some((c) => /date/i.test(c)));
  if (h < 0) throw new Error('Couldn\'t find a Date column in that CSV.');
  const head = rows[h].map((c) => c.trim().toLowerCase());
  const find = (...names) => head.findIndex((c) => names.some((n) => c === n || c.includes(n)));
  const iDate = find('posted date', 'posting date', 'transaction date', 'date');
  const iDesc = find('description', 'payee', 'merchant', 'name', 'memo', 'details');
  const iAmt = head.findIndex((c) => c === 'amount' || c === 'transaction amount');
  const iDebit = find('debit', 'withdrawal', 'withdrawals');
  const iCredit = find('credit', 'deposit', 'deposits');
  if (iDate < 0 || (iAmt < 0 && iDebit < 0 && iCredit < 0)) throw new Error('Need Date and Amount (or Debit/Credit) columns.');
  const importId = crypto.randomUUID();
  let added = 0; let dupes = 0;
  for (const r of rows.slice(h + 1)) {
    const date = toDate(r[iDate]); if (!date) continue;
    let amount = iAmt >= 0 ? money(r[iAmt]) : null;
    if (amount === null) { const d = money(r[iDebit]); const c = money(r[iCredit]); amount = (c ? Math.abs(c) : 0) - (d ? Math.abs(d) : 0); }
    if (!amount) continue;
    const desc = scrub(iDesc >= 0 ? r[iDesc] : '');
    const fp = crypto.createHash('sha256').update(`${account || ''}|${date}|${amount.toFixed(2)}|${desc}`).digest('hex');
    const ins = await q(`INSERT INTO bank_rows (import_id, account, date, description, amount, fingerprint) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (fingerprint) DO NOTHING RETURNING id`, [importId, account || null, date, desc, r2(amount), fp]);
    if (ins.rows.length) added++; else dupes++;
  }
  const matched = await autoMatch();
  return { added, duplicates_skipped: dupes, matched };
}
// Match statement rows to ledger entries with the same amount within 4 days.
async function autoMatch() {
  const { rows } = await q(`SELECT * FROM bank_rows WHERE status='new'`);
  let n = 0;
  for (const b of rows) {
    const kind = b.amount > 0 ? 'income' : 'expense';
    const m = await q(`SELECT t.id FROM transactions t WHERE t.kind=$1 AND abs(t.amount - $2) < 0.01 AND abs(t.date - $3::date) <= 4
      AND NOT t.reconciled AND NOT EXISTS (SELECT 1 FROM bank_rows br WHERE br.tx_id=t.id) ORDER BY abs(t.date - $3::date) LIMIT 1`, [kind, Math.abs(b.amount), b.date]);
    if (m.rows[0]) {
      await q(`UPDATE bank_rows SET status='matched', tx_id=$2 WHERE id=$1`, [b.id, m.rows[0].id]);
      await q('UPDATE transactions SET reconciled=true WHERE id=$1', [m.rows[0].id]);
      n++;
    }
  }
  return n;
}
async function applyBankDecisions(decisions, createdBy = 'manual') {
  let added = 0; let ignored = 0;
  for (const d of decisions || []) {
    const { rows } = await q(`SELECT * FROM bank_rows WHERE id=$1 AND status='new'`, [d.row_id]);
    const b = rows[0]; if (!b) continue;
    if (d.action === 'ignore') { await q(`UPDATE bank_rows SET status='ignored' WHERE id=$1`, [b.id]); ignored++; continue; }
    const t = await S.addTransaction({ kind: b.amount > 0 ? 'income' : 'expense', date: b.date, amount: Math.abs(b.amount), category: d.category,
      job_name: d.job_name || null, job_id: d.job_id || null, party: d.party || b.description, memo: `Bank: ${b.description}` }, createdBy);
    await q('UPDATE transactions SET reconciled=true WHERE id=$1', [t.id]);
    await q(`UPDATE bank_rows SET status='added', tx_id=$2 WHERE id=$1`, [b.id, t.id]);
    added++;
  }
  return { added, ignored };
}

module.exports = { importInvoiceApp, importBankCsv, autoMatch, applyBankDecisions, parseCsv };
