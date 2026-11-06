// Importers: the LuxCraft invoice/estimate app, and bank/card CSV statements.
const crypto = require('crypto');
const { q, resolveJob, getSettings } = require('./db');
const S = require('./services');
// The same project/payment rules the invoice app uses, so the two always agree.
const LCP = require('../public/invoice-app/projects.js');

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
// ---------- projects: one per lot ----------
const clean = (x) => String(x || '').replace(/\s+/g, ' ').trim();
// Lot number from the project/site lines (e.g. "Lot 262", "Lot #12B", "LOT 7").
function lotOf(st) {
  for (const f of [st.site1, st.site2, st.project, st.client?.a1, st.client?.a2]) {
    const m = clean(f).match(/\blot\s*#?\s*([A-Za-z0-9-]+)/i);
    if (m) return m[1].toUpperCase();
  }
  return null;
}
const siteOf = (st) => [st.site1, st.site2].map(clean).filter(Boolean).join(', ') || [st.client?.a1, st.client?.a2].map(clean).filter(Boolean).join(', ') || null;
// Identity: client + lot; without a lot, client + job site address; without that, client + project.
function jobKeyFor(st) {
  const client = clean(st.client?.name).toLowerCase();
  const lot = lotOf(st);
  if (lot) return `${client}|lot:${lot}`;
  const site = clean(st.site1 || '').toLowerCase();
  if (site) return `${client}|site:${site}`;
  return `${client}|project:${clean(st.project).toLowerCase()}`;
}
function jobNameFor(st) {
  const lot = lotOf(st); const project = clean(st.project); const client = clean(st.client?.name);
  if (lot) return [`Lot ${lot}`, project || client].filter(Boolean).join(' · ').slice(0, 120);
  return (project ? `${project} · ${client}` : client || 'Untitled job').slice(0, 120);
}
// Find or create the Cockpit project for one invoice project (an invoice plus its "Bill next draw" follow-ups).
// Projects made by an older version of this sync (one per lot) are taken over by the first project for that lot,
// so expenses, hours and miles you attached to them stay put.
async function projectJob(pid, recs, stats) {
  const present = recs.slice().sort((x, y) => (LCP.drawIdx(y.st) - LCP.drawIdx(x.st)) || String(y.updatedAt || '').localeCompare(String(x.updatedAt || '')))[0];
  const first = recs.slice().sort((x, y) => String(x.createdAt || '').localeCompare(String(y.createdAt || '')) || (LCP.drawIdx(x.st) - LCP.drawIdx(y.st)))[0];
  const st = present.st;
  if (!clean(st.client?.name) && !clean(st.project) && !lotOf(st)) return null;
  const key = `project:${pid}`;
  const client = clean(st.client?.name) || null; const lot = lotOf(st); const site = siteOf(st);
  let found = (await q('SELECT id FROM jobs WHERE ext_key=$1', [key])).rows[0];
  if (!found) {
    const legacy = (await q('SELECT id FROM jobs WHERE ext_key=$1', [jobKeyFor(st)])).rows[0];
    if (legacy && !stats.claimed.has(legacy.id)) { await q('UPDATE jobs SET ext_key=$2 WHERE id=$1', [legacy.id, key]); found = legacy; }
  }
  if (found) {
    stats.claimed.add(found.id);
    await q(`UPDATE jobs SET client=COALESCE($2, client), lot=$3, address=COALESCE($4, address), pricing='fixed', source='invoice-app',
      status=CASE WHEN status IN ('lead','estimating','lost') THEN 'active' ELSE status END WHERE id=$1`, [found.id, client, lot, site]);
    return found.id;
  }
  // Same lot and project as another project: the first invoice number tells them apart.
  const base = jobNameFor(st);
  let name = base;
  if ((await q('SELECT 1 FROM jobs WHERE lower(name)=lower($1)', [name])).rows.length) name = `${base} · ${String(first.st.invNo || '').trim()}`.slice(0, 150);
  for (let n = 2; (await q('SELECT 1 FROM jobs WHERE lower(name)=lower($1)', [name])).rows.length; n++) name = `${base} · ${String(first.st.invNo || '').trim()} (${n})`.slice(0, 150);
  const { rows } = await q(`INSERT INTO jobs (name, client, address, status, pricing, source, ext_key, lot) VALUES ($1,$2,$3,'active','fixed','invoice-app',$4,$5) RETURNING id`,
    [name, client, site, key, lot]);
  stats.claimed.add(rows[0].id);
  return rows[0].id;
}
// Bank/routing/account numbers never leave the invoice: long digit runs are hidden in what the Cockpit keeps.
const redact = (t) => String(t || '').replace(/\d[\d\s-]{5,}\d/g, '[number hidden]');
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

// Everything written on the invoice / estimate, kept for the agents' brief (bank numbers hidden).
function invoiceDetails(st, rec) {
  const amounts = drawAmounts(st);
  return {
    invoice_no: st.invNo, invoice_date: toDate(st.invDate), terms: st.terms || null, status_in_app: rec.status || 'unpaid',
    client: { name: clean(st.client?.name), address: [st.client?.a1, st.client?.a2].map(clean).filter(Boolean).join(', '), phone: clean(st.client?.phone), email: clean(st.client?.email) },
    project: clean(st.project), job_site: siteOf(st), lot: lotOf(st),
    contract_amount: num(st.proposal), schedule_mode: st.mode === 'amt' ? 'dollars' : 'percent', this_draw: drawIndex(st) + 1,
    draws: (st.draws || []).map((d, i) => ({ n: i + 1, description: clean(d.label), share: st.mode === 'pct' ? `${num(d.val)}%` : null, amount: amounts[i],
      paid_or_request_date: toDate(d.date), check_no: clean(d.ck) || null })),
    extra_items: (st.items || []).filter((it) => clean(it.desc) || num(it.amt)).map((it) => ({ description: clean(it.desc), amount: num(it.amt) })),
    tax_rate_pct: num(st.taxRate), amount_due: invoiceTotal(rec), notes: redact(st.notes),
    payment: rec.status === 'paid' ? { date_received: toDate(rec.payment && rec.payment.date), amount: rec.payment && num(rec.payment.amount) ? num(rec.payment.amount) : invoiceTotal(rec),
      method: (rec.payment && rec.payment.method) || null, check_no: (rec.payment && clean(rec.payment.ck)) || null } : null,
  };
}
function estimateDetails(st) {
  return {
    estimate_no: st.estNo, date: toDate(st.estDate), valid_until: toDate(st.validUntil),
    client: { name: clean(st.client?.name), address: [st.client?.a1, st.client?.a2].map(clean).filter(Boolean).join(', '), phone: clean(st.client?.phone), email: clean(st.client?.email) },
    project: clean(st.project), job_site: siteOf(st), lot: lotOf(st), scope: redact(st.scope),
    sections: (st.sections || []).map((sec) => ({ name: clean(sec.name), items: (sec.items || []).filter((it) => clean(it.desc) || num(it.rate))
      .map((it) => ({ description: clean(it.desc), qty: num(it.qty), unit: it.unit, rate: num(it.rate), total: r2(num(it.qty) * num(it.rate)), optional: !!it.optional })) })),
    discount: num(st.discount) ? `${num(st.discount)}${st.discountMode === 'pct' ? '%' : ' dollars'}` : null, tax_rate_pct: num(st.taxRate),
    payment_schedule: (st.payments || []).map((p2) => ({ description: clean(p2.label), share: `${num(p2.pct)}%` })),
    terms: redact(st.terms), exclusions: redact(st.exclusions),
  };
}

async function importEstimate(rec, source, stats) {
  const st = rec.st;
  const extId = `${source}:est:${rec.id}`;
  const wanted = String(st.estNo || '').trim() || `EST-${String(rec.id).slice(0, 6)}`;
  // Estimates are bids, not projects: only invoices make projects. An estimate is linked to a project when an
  // invoice project for the same client and lot exists.
  const jobId = stats.lotJobs[`${clean(st.client?.name).toLowerCase()}|${lotOf(st) || ''}`] || null;
  stats.est_ids.push(extId);
  const items = [];
  for (const sec of st.sections || []) for (const it of sec.items || []) {
    if (!String(it.desc || '').trim() && !num(it.rate)) continue;
    items.push({ section: sec.name || '', desc: it.desc, qty: num(it.qty), unit: it.unit, rate: num(it.rate), total: r2(num(it.qty) * num(it.rate)), optional: !!it.optional });
  }
  const existing = (await q('SELECT id FROM estimates WHERE external_id=$1', [extId])).rows[0];
  const estNo = await freeNumber('estimates', 'est_no', wanted, existing && existing.id);
  if (estNo !== wanted) stats.renamed.push(`${wanted} → ${estNo}`);
  const vals = [estNo, jobId, st.client?.name || null, st.project || null, toDate(st.estDate), toDate(st.validUntil), num(rec.total),
    rec.status || 'draft', JSON.stringify(items), st.scope || null, JSON.stringify(estimateDetails(st))];
  if (existing) {
    await q(`UPDATE estimates SET est_no=$2, job_id=$3, client=$4, project=$5, est_date=$6, valid_until=$7, total=$8, status=$9, items=$10, scope=$11, details=$12, updated_at=now() WHERE id=$1`, [existing.id, ...vals]);
  } else {
    await q(`INSERT INTO estimates (est_no, job_id, client, project, est_date, valid_until, total, status, items, scope, details, source, external_id, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())`, [...vals, source, extId]);
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

async function importInvoice(rec, source, stats, jobId) {
  const st = rec.st; const ci = drawIndex(st);
  const extId = `${source}:inv:${rec.id}`;
  const wanted = String(st.invNo).trim();
  const client = clean(st.client?.name) || null;
  if (jobId) stats.jobs_touched.add(jobId);
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
      details=$18, external_id=$19, source=$20, void=false WHERE id=$1`, [existing.id, ...vals, JSON.stringify(invoiceDetails(st, rec)), extId, source]);
  } else {
    await q(`INSERT INTO invoices (invoice_no, job_id, client, issue_date, due_date, amount, draw_label, notes, draw_no, draw_count, terms,
      draw_amount, items_total, tax, contract_amount, app_status, details, external_id, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [...vals, JSON.stringify(invoiceDetails(st, rec)), extId, source]);
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
    const markedPaid = biller && biller.status === 'paid';
    const pay = (markedPaid && biller.payment) || {};
    const laterCk = String(ld.ck || '').trim() || null;
    const checkNo = String(pay.ck || '').trim() || laterCk;
    const paid = !!(markedPaid || laterCk);
    let date = null; let note = '';
    if (paid) {
      // The date you entered when recording the payment; else the paid date typed on a later invoice; else the day it was marked Paid.
      // (Older versions filled that paid date in with the earlier invoice's own date, so that one isn't trusted.)
      const laterDate = laterCk && toDate(ld.date) !== toDate(biller && biller.st.invDate) ? toDate(ld.date) : null;
      const typed = toDate(pay.date) || laterDate;
      date = typed || (markedPaid ? (stats.marks[biller.id] || toDate(biller.updatedAt)) : null) || (billed && billed.issue_date);
      note = typed ? '' : markedPaid ? ' · no payment date entered (dated the day it was marked Paid)' : ' · no paid date entered';
    }
    const received = paid && num(pay.amount) > 0 ? r2(num(pay.amount)) : null;
    return {
      n: i + 1, label: d.label || `Draw ${i + 1}`, pct: st.mode === 'pct' ? num(d.val) : (num(st.proposal) ? r2(amounts[i] / num(st.proposal) * 100) : null),
      amount: amounts[i] || 0, status: paid ? 'paid' : billed ? 'billed' : 'scheduled',
      invoice_no: billed ? billed.invoice_no : null, billed_amount: billed ? billed.amount : null, items: billed ? billed.items : 0, tax: billed ? billed.tax : 0,
      issue_date: billed ? billed.issue_date : null, due_date: billed ? billed.due_date : null,
      paid_date: paid ? date : null, check_no: checkNo, note, received, method: pay.method || (checkNo ? 'check' : null),
      flag: !paid && later ? `${(stats.stored[later.id] || {}).invoice_no || 'A later invoice'} prints this draw under "Paid to date", but it isn't marked paid` : null,
      biller_id: biller ? biller.id : null,
    };
  });
  return { present, schedule, contract: num(st.proposal), job_id: (stats.stored[present.id] || {}).job_id ?? null, client: (stats.stored[present.id] || {}).client || null };
}

async function mirrorContracts(valid, source, stats) {
  const keep = new Set(); const jobs = new Set();
  for (const recs of LCP.groups(valid).values()) {
    const c = contractSchedule(recs, stats);
    jobs.add(c.job_id ?? 'none');
    if (c.job_id) {
      const co = r2(c.schedule.reduce((s2, d) => s2 + (d.items || 0), 0));
      // Every draw paid → the project is complete; a draw owed again (marked unpaid) → active again.
      const done = c.schedule.length > 0 && c.schedule.every((d) => d.status === 'paid' && !(d.received != null && d.received < (d.billed_amount ?? d.amount) - 0.004));
      await q(`UPDATE jobs SET contract_amount=$2, change_orders=$3, draws=$4, draws_synced_at=now(),
          status=CASE WHEN $5 AND status='active' THEN 'complete' WHEN NOT $5 AND status='complete' THEN 'active' ELSE status END WHERE id=$1`,
        [c.job_id, c.contract || null, co || null, JSON.stringify(c.schedule.map(({ biller_id, ...d }) => d)), done]);
    }
    for (const d of c.schedule) {
      if (d.status === 'scheduled') continue;
      const amount = d.billed_amount ?? d.amount;
      if (!(amount > 0)) continue;
      const ref = d.biller_id ? `${source}:invoice:${d.biller_id}` : `${source}:draw:${c.job_id ?? 'none'}:${d.n}`;
      // A payment you entered by hand for this invoice wins; the synced row steps aside so nothing counts twice
      // (the Numbers check lists these so you can move them to the Invoicing tab).
      if (d.invoice_no) {
        const manual = (await q(`SELECT 1 FROM transactions WHERE kind='income' AND created_by<>'sync' AND category<>$2 AND lower(invoice_no)=lower($1) LIMIT 1`,
          [d.invoice_no, S.AWAITING])).rows.length;
        if (manual) { stats.manual_payments.push(d.invoice_no); continue; }
      }
      const label = `${d.label} (draw ${d.n} of ${c.schedule.length})`;
      const paid = d.status === 'paid';
      const rows = [];
      if (paid) {
        const got = d.received ?? amount;
        rows.push({ ref, amount: got, date: d.paid_date || d.issue_date || S.todayISO(), category: 'Contract Revenue', check_no: d.check_no, method: d.method,
          memo: `${label} · paid${d.note}${got < amount - 0.004 ? ` · short ${(amount - got).toFixed(2)}` : ''}${d.issue_date ? ` · invoiced ${d.issue_date}` : ''} – from invoice app` });
        // Paid less than billed: the rest stays owed.
        if (got < amount - 0.004) rows.push({ ref: `${ref}:rest`, amount: r2(amount - got), date: d.issue_date || S.todayISO(), category: S.AWAITING, check_no: null, method: null,
          memo: `${label} · balance still owed after a short payment – from invoice app` });
      } else {
        rows.push({ ref, amount, date: d.issue_date || S.todayISO(), category: S.AWAITING, check_no: null, method: null,
          memo: `${label} · awaiting payment${d.flag ? ' · printed as paid on a later invoice' : ''} – from invoice app` });
      }
      for (const row of rows) {
        keep.add(row.ref);
        const full = { kind: 'income', amount: row.amount, party: c.client, job_id: c.job_id, invoice_no: d.invoice_no, date: row.date, category: row.category,
          check_no: row.check_no, method: row.method, memo: row.memo };
        const mine = (await q('SELECT id, category FROM transactions WHERE ext_ref=$1', [row.ref])).rows[0];
        if (mine) {
          // Keep a revenue category you chose yourself for a paid row (e.g. Materials Reimbursement); otherwise follow the invoice.
          const category = row.category !== S.AWAITING && mine.category !== S.AWAITING ? mine.category : row.category;
          await q(`UPDATE transactions SET date=$2, amount=$3, category=$4, party=$5, job_id=$6, method=$7, check_no=$8, invoice_no=$9, memo=$10 WHERE id=$1`,
            [mine.id, full.date, full.amount, category, full.party, full.job_id, full.method, full.check_no, full.invoice_no, full.memo]);
          stats.ledger_updated++;
        } else {
          await S.addTransaction({ ...full, ext_ref: row.ref }, 'sync');
          if (row.category === S.AWAITING) stats.invoices_added++; else stats.payments_added++;
        }
      }
      if (d.flag) stats.flags.push(`${d.invoice_no || c.client}: ${d.flag}`);
    }
  }
  // Remove synced rows whose invoice is gone from the app or that a hand-entered payment now covers.
  // Only for jobs in this sync; rows you entered yourself are never touched.
  if (stats.full) {
    // The built-in app always has the complete set, so anything synced that isn't in it is gone.
    const { rows } = await q(`SELECT id, ext_ref FROM transactions WHERE created_by='sync' AND ext_ref LIKE $1`, [`${source}:%`]);
    for (const t of rows) if (!keep.has(t.ext_ref)) { await q('DELETE FROM transactions WHERE id=$1', [t.id]); stats.ledger_removed++; }
  } else for (const job of jobs) {
    const { rows } = await q(`SELECT id, ext_ref FROM transactions WHERE created_by='sync' AND ext_ref LIKE $1 AND ${job === 'none' ? 'job_id IS NULL' : 'job_id=$2'}`,
      job === 'none' ? [`${source}:%`] : [`${source}:%`, Number(job)]);
    for (const t of rows) if (!keep.has(t.ext_ref)) { await q('DELETE FROM transactions WHERE id=$1', [t.id]); stats.ledger_removed++; }
  }
}

async function importInvoiceApp({ invoices = [], estimates = [] }, source = 'invoice-app', { full = false } = {}) {
  const stats = { full, est_ids: [], jobs_removed: 0, invoices: 0, estimates: 0, payments_added: 0, invoices_added: 0, ledger_updated: 0, ledger_removed: 0,
    jobs_touched: new Set(), claimed: new Set(), lotJobs: {}, renamed: [], skipped: [], flags: [], manual_payments: [], stored: {}, settings: await getSettings() };
  stats.marks = Object.fromEntries((await q('SELECT record_id, paid_on FROM paid_marks')).rows.map((r) => [r.record_id, r.paid_on]));
  // One bad record never stops the rest of the sync.
  const safely = async (label, fn) => {
    try { await fn(); } catch (e) { stats.skipped.push(`${label}: ${e.message}`); console.error('Invoice-app sync skipped', label, e.message); }
  };
  const valid = invoices.filter((r) => r && r.id && r.st && String(r.st.invNo || '').trim() && Array.isArray(r.st.draws) && r.st.draws.length);
  // Projects come only from invoices: one per invoice project. Oldest first, so the first project on a lot keeps
  // the project an older sync made for that lot.
  const projects = [...LCP.groups(valid).entries()].sort(([, a], [, b]) =>
    String(a.map((r) => r.createdAt || '').sort()[0] || '').localeCompare(String(b.map((r) => r.createdAt || '').sort()[0] || '')));
  for (const [pid, recs] of projects) {
    let jobId = null;
    await safely(`Project ${recs[0].st.invNo}`, async () => { jobId = await projectJob(pid, recs, stats); });
    const st0 = recs[0].st; const lk = `${clean(st0.client?.name).toLowerCase()}|${lotOf(st0) || ''}`;
    if (jobId && lotOf(st0) && !stats.lotJobs[lk]) stats.lotJobs[lk] = jobId;
    for (const rec of recs) await safely(`Invoice ${rec.st.invNo}`, () => importInvoice(rec, source, stats, jobId));
  }
  for (const rec of estimates) {
    if (!rec || !rec.id || !rec.st) continue;
    await safely(`Estimate ${rec.st.estNo || rec.id}`, () => importEstimate(rec, source, stats));
  }
  // Invoices deleted in the app: voided here (not deleted); they come back if the app sends them again.
  await safely('Removed invoices', async () => {
    const ids = valid.map((r) => `${source}:inv:${r.id}`);
    if (full) {
      await q(`UPDATE invoices SET void=true WHERE source=$1 AND NOT (external_id = ANY($2))`, [source, ids]);
      await q(`DELETE FROM estimates WHERE source=$1 AND NOT (external_id = ANY($2))`, [source, stats.est_ids]);
    } else {
      const jobIds = [...stats.jobs_touched];
      if (jobIds.length) await q(`UPDATE invoices SET void=true WHERE source=$1 AND job_id = ANY($2) AND NOT (external_id = ANY($3))`, [source, jobIds, ids]);
    }
  });
  await safely('Ledger', () => mirrorContracts(valid.filter((r) => stats.stored[r.id]), source, stats));
  // Projects no invoice feeds any more (deleted invoices, or projects older versions made from estimates or from
  // merged lots): empty ones are removed; ones holding your own entries (expenses, hours, miles) are kept, lose their
  // draw schedule, and show in the Numbers check so you can move those entries.
  if (full) await safely('Projects', async () => {
    const { rows } = await q(`SELECT j.id,
        EXISTS (SELECT 1 FROM transactions t WHERE t.job_id=j.id AND t.created_by<>'sync') AS has_tx,
        EXISTS (SELECT 1 FROM time_entries te WHERE te.job_id=j.id) OR EXISTS (SELECT 1 FROM mileage m WHERE m.job_id=j.id) AS has_work
      FROM jobs j WHERE (j.source IN ('invoice-app','estimate') OR j.draws_synced_at IS NOT NULL OR j.ext_key IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.job_id=j.id AND NOT i.void)`);
    for (const j of rows) {
      if (!j.has_tx && !j.has_work) {
        await q('UPDATE invoices SET job_id=NULL WHERE job_id=$1', [j.id]); await q('UPDATE estimates SET job_id=NULL WHERE job_id=$1', [j.id]);
        await q(`DELETE FROM transactions WHERE job_id=$1 AND created_by='sync'`, [j.id]);
        await q('DELETE FROM jobs WHERE id=$1', [j.id]); stats.jobs_removed++;
      // A per-lot project from an older version keeps its lot key, so the first invoice project on that lot can take it over.
      } else await q(`UPDATE jobs SET draws=NULL, change_orders=NULL, draws_synced_at=NULL, contract_amount=NULL,
          ext_key=CASE WHEN ext_key LIKE '%|lot:%' THEN ext_key ELSE NULL END, source='manual' WHERE id=$1`, [j.id]);
    }
  });
  return { invoices: stats.invoices, estimates: stats.estimates, payments_added: stats.payments_added, invoices_added: stats.invoices_added, ledger_updated: stats.ledger_updated,
    ledger_removed: stats.ledger_removed, jobs: stats.jobs_touched.size, jobs_removed: stats.jobs_removed, renamed: stats.renamed, skipped: stats.skipped, flags: stats.flags,
    manual_payments: stats.manual_payments };
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
    // Deposits often land days after the check date, so income gets a wider window.
    const m = await q(`SELECT t.id FROM transactions t WHERE t.kind=$1 AND t.category<>'Invoiced – Awaiting Payment' AND abs(t.amount - $2) < 0.01 AND abs(t.date - $3::date) <= ${b.amount > 0 ? 21 : 4}
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
  let added = 0; let ignored = 0; const skipped = [];
  for (const d of decisions || []) {
    const { rows } = await q(`SELECT * FROM bank_rows WHERE id=$1 AND status='new'`, [d.row_id]);
    const b = rows[0]; if (!b) continue;
    if (d.action === 'ignore') { await q(`UPDATE bank_rows SET status='ignored' WHERE id=$1`, [b.id]); ignored++; continue; }
    // A deposit that matches an invoice from the Invoicing tab is that invoice's payment, not new income.
    if (b.amount > 0 && !d.force) {
      const inv = (await q(`SELECT invoice_no FROM invoices WHERE source='invoice-app' AND NOT void AND abs(amount - $1) < 0.01
        AND (issue_date IS NULL OR $2::date BETWEEN issue_date - 7 AND issue_date + 120) ORDER BY abs($2::date - COALESCE(issue_date, $2::date)) LIMIT 1`, [b.amount, b.date])).rows[0];
      if (inv) { skipped.push(`${b.date} ${b.amount.toFixed(2)} matches invoice ${inv.invoice_no} – mark that invoice paid in the Invoicing tab instead`); continue; }
    }
    const t = await S.addTransaction({ kind: b.amount > 0 ? 'income' : 'expense', date: b.date, amount: Math.abs(b.amount), category: d.category,
      job_name: d.job_name || null, job_id: d.job_id || null, party: d.party || b.description, memo: `Bank: ${b.description}` }, createdBy);
    await q('UPDATE transactions SET reconciled=true WHERE id=$1', [t.id]);
    await q(`UPDATE bank_rows SET status='added', tx_id=$2 WHERE id=$1`, [b.id, t.id]);
    added++;
  }
  return { added, ignored, skipped };
}

module.exports = { importInvoiceApp, importBankCsv, autoMatch, applyBankDecisions, parseCsv };
