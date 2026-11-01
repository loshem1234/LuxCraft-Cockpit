// Importers: the LuxCraft invoice/estimate app, and bank/card CSV statements.
const crypto = require('crypto');
const { q, resolveJob } = require('./db');
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

async function importInvoiceApp({ invoices = [], estimates = [] }, source = 'invoice-app') {
  const stats = { invoices: 0, estimates: 0, payments_added: 0, jobs_touched: new Set() };
  // Estimates first so jobs get their bid amount.
  for (const rec of estimates) {
    if (!rec || !rec.id || !rec.st) continue;
    const st = rec.st;
    const jobName = jobNameFor(st);
    const jobId = jobName ? await resolveJob(jobName, { create: true, client: st.client?.name || null,
      status: rec.status === 'accepted' ? 'active' : rec.status === 'declined' ? 'lost' : 'estimating' }) : null;
    const items = [];
    for (const sec of st.sections || []) for (const it of sec.items || []) {
      if (!String(it.desc || '').trim() && !num(it.rate)) continue;
      items.push({ section: sec.name || '', desc: it.desc, qty: num(it.qty), unit: it.unit, rate: num(it.rate), total: r2(num(it.qty) * num(it.rate)), optional: !!it.optional });
    }
    await q(`INSERT INTO estimates (est_no, job_id, client, project, est_date, valid_until, total, status, items, scope, source, external_id, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
      ON CONFLICT (external_id) DO UPDATE SET est_no=EXCLUDED.est_no, job_id=EXCLUDED.job_id, client=EXCLUDED.client, project=EXCLUDED.project,
        est_date=EXCLUDED.est_date, valid_until=EXCLUDED.valid_until, total=EXCLUDED.total, status=EXCLUDED.status, items=EXCLUDED.items, scope=EXCLUDED.scope, updated_at=now()`,
    [st.estNo, jobId, st.client?.name || null, st.project || null, toDate(st.estDate), toDate(st.validUntil), num(rec.total), rec.status || 'draft',
      JSON.stringify(items), st.scope || null, source, `${source}:est:${rec.id}`]);
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

  // Invoices: each one bills one draw. A draw is "received" when a later invoice on the same
  // contract records its date/check #, or when the invoice itself is marked Paid.
  const valid = invoices.filter((r) => r && r.id && r.st && r.st.invNo);
  const groups = {};
  for (const r of valid) (groups[`${jobNameFor(r.st)}|${num(r.st.proposal)}`] ||= []).push(r);
  for (const rec of valid) {
    const st = rec.st; const ci = Math.min(st.currentIdx || 0, (st.draws || []).length - 1);
    const jobName = jobNameFor(st);
    const jobId = jobName ? await resolveJob(jobName, { create: true, client: st.client?.name || null }) : null;
    if (jobId) {
      stats.jobs_touched.add(jobId);
      await q(`UPDATE jobs SET contract_amount=COALESCE(contract_amount,$2), status=CASE WHEN status IN ('lead','estimating') THEN 'active' ELSE status END WHERE id=$1`, [jobId, num(st.proposal) || null]);
    }
    const amount = invoiceTotal(rec);
    await S.upsertInvoice({ invoice_no: st.invNo, job_id: jobId, client: st.client?.name || null, issue_date: toDate(st.invDate),
      amount, draw_label: st.draws?.[ci]?.label || null, notes: st.project || null, external_id: `${source}:inv:${rec.id}` }, source);
    stats.invoices++;

    let pay = null;
    for (const other of groups[`${jobName}|${num(st.proposal)}`] || []) {
      const d = other.st.draws?.[ci];
      if (other.id !== rec.id && (other.st.currentIdx || 0) > ci && d && d.date) { pay = { date: toDate(d.date), check_no: d.ck || null }; break; }
    }
    if (!pay && rec.status === 'paid') pay = { date: toDate(st.draws?.[ci]?.date) || toDate(rec.updatedAt) || S.todayISO(), check_no: st.draws?.[ci]?.ck || null };
    if (pay) {
      const ref = `${source}:pay:${rec.id}`;
      const exists = await q('SELECT 1 FROM transactions WHERE ext_ref=$1', [ref]);
      // Skip if Loshem already logged this check by hand.
      const manual = await q(`SELECT 1 FROM transactions WHERE kind='income' AND lower(invoice_no)=lower($1) AND (($2::text IS NOT NULL AND check_no=$2) OR abs(amount-$3) < 0.01)`,
        [st.invNo, pay.check_no, amount]);
      if (!exists.rows.length && !manual.rows.length) {
        await S.addTransaction({ kind: 'income', date: pay.date, amount, category: 'Contract Revenue', party: st.client?.name || null, job_id: jobId,
          method: pay.check_no ? 'check' : null, check_no: pay.check_no, invoice_no: st.invNo, memo: `${st.draws?.[ci]?.label || 'Draw'} – from invoice app`, ext_ref: ref }, 'sync');
        stats.payments_added++;
      }
    }
  }
  return { invoices: stats.invoices, estimates: stats.estimates, payments_added: stats.payments_added, jobs: stats.jobs_touched.size };
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
