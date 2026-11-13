// Clara's correction tools. Every change here runs only after Loshem approves the card, and every card shows a
// before → after preview built from the live data, so he sees exactly what will change.
//  - invoice edits are written into the Invoicing tab's own data (the invoice and the Cockpit always match);
//  - data fixes clean up Cockpit-side records (hand entries, stray jobs, hours, invoices from outside the tab).
const { q, resolveJob } = require('./db');
const S = require('./services');
const LCP = require('../public/invoice-app/projects.js');
const RULES = require('./rules');

const KEY = 'luxcraft.invoices.v1';
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
const money = (n) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const bad = (m) => Object.assign(new Error(m), { status: 400 });

async function invoiceData() {
  const { rows } = await q('SELECT value FROM books WHERE key=$1', [KEY]);
  return (rows[0] && rows[0].value) || { invoices: [] };
}
function findRec(list, invoiceNo, matchDate) {
  const want = String(invoiceNo || '').trim().toLowerCase();
  let hits = list.filter((r) => r && r.st && String(r.st.invNo || '').trim().toLowerCase() === want);
  if (matchDate && hits.length > 1) hits = hits.filter((r) => r.st.invDate === matchDate);
  if (!hits.length) throw bad(`No invoice ${invoiceNo} in the Invoicing tab`);
  if (hits.length > 1) throw bad(`${hits.length} invoices are numbered ${invoiceNo} (dated ${hits.map((r) => r.st.invDate).join(', ')}). Say which one with match_date.`);
  return hits[0];
}
const drawAmounts = (st) => (st.draws || []).map((d) => r2(st.mode === 'pct' ? num(st.proposal) * num(d.val) / 100 : num(d.val)));
const ci = (st) => LCP.drawIdx(st);
function computeTotal(st) {
  const items = (st.items || []).reduce((s, it) => s + num(it.amt), 0);
  return r2((drawAmounts(st)[ci(st)] + items) * (1 + num(st.taxRate) / 100));
}
function view(rec) {
  const st = rec.st; const p = rec.payment || {};
  return {
    invoice_no: st.invNo, invoice_date: st.invDate, terms: st.terms, client_name: st.client && st.client.name,
    client_address_1: st.client && st.client.a1, client_address_2: st.client && st.client.a2, project: st.project,
    site_line_1: st.site1, site_line_2: st.site2, contract_amount: num(st.proposal), schedule_mode: st.mode,
    draws: (st.draws || []).map((d, i) => ({ n: i + 1, label: d.label, value: num(d.val), amount: drawAmounts(st)[i], paid_date_typed: d.date || null, check_no_typed: d.ck || null })),
    this_draw: ci(st) + 1, extra_items: (st.items || []).map((it) => ({ description: it.desc, amount: num(it.amt) })), tax_rate_pct: num(st.taxRate),
    total: num(rec.total) || computeTotal(st), status: rec.status === 'paid' ? 'paid' : 'unpaid',
    payment: rec.status === 'paid' ? { date: p.date || null, amount: p.amount ?? null, method: p.method || null, check_no: p.ck || null } : null,
    job_pinned: !!st.contractPinned,
  };
}

// Full record for one invoice, with the other invoices in its job (read tool).
async function invoiceRecord(invoiceNo, matchDate) {
  const data = await invoiceData(); const list = data.invoices || [];
  const rules = await RULES.getRules();
  const rec = findRec(list, invoiceNo, matchDate);
  const map = LCP.assign(list, { mode: rules.project_grouping });
  const pid = map.get(rec.id);
  const same = list.filter((r) => r !== rec && map.get(r.id) === pid).map((r) => ({ invoice_no: r.st.invNo, invoice_date: r.st.invDate, draw: ci(r.st) + 1, status: r.status === 'paid' ? 'paid' : 'unpaid' }));
  const job = (await q(`SELECT j.name FROM invoices i JOIN jobs j ON j.id=i.job_id WHERE i.external_id=$1`, [`invoice-app:inv:${rec.id}`])).rows[0];
  return { ...view(rec), cockpit_job: job ? job.name : null, other_invoices_in_same_job: same, created: rec.createdAt, last_saved: rec.updatedAt };
}

// ---------- invoice edits ----------
const FIELD = {
  new_invoice_no: ['Invoice #', (st) => st.invNo, (st, v) => { st.invNo = String(v).trim(); }],
  invoice_date: ['Invoice date', (st) => st.invDate, (st, v) => { if (!ISO.test(v)) throw bad('invoice_date must be YYYY-MM-DD'); st.invDate = v; }],
  terms: ['Terms', (st) => st.terms, (st, v) => { st.terms = String(v); }],
  client_name: ['Client', (st) => st.client && st.client.name, (st, v) => { st.client = { ...(st.client || {}), name: String(v) }; }],
  client_address_1: ['Billing address', (st) => st.client && st.client.a1, (st, v) => { st.client = { ...(st.client || {}), a1: String(v) }; }],
  client_address_2: ['Billing city/state', (st) => st.client && st.client.a2, (st, v) => { st.client = { ...(st.client || {}), a2: String(v) }; }],
  project: ['Project', (st) => st.project, (st, v) => { st.project = String(v); }],
  site_line_1: ['Job site', (st) => st.site1, (st, v) => { st.site1 = String(v); }],
  site_line_2: ['Job site line 2', (st) => st.site2, (st, v) => { st.site2 = String(v); }],
  contract_amount: ['Contract', (st) => money(st.proposal), (st, v) => { if (!(num(v) >= 0)) throw bad('contract_amount must be a number'); st.proposal = r2(num(v)); }],
  schedule_mode: ['Draws in', (st) => (st.mode === 'pct' ? '% of contract' : '$ amounts'), (st, v) => { if (!['pct', 'amt'].includes(v)) throw bad('schedule_mode is pct or amt'); st.mode = v; }],
  tax_rate_pct: ['Tax rate', (st) => `${num(st.taxRate)}%`, (st, v) => { st.taxRate = num(v); }],
};
const AMOUNT_FIELDS = ['contract_amount', 'schedule_mode', 'draws', 'this_draw', 'extra_items', 'tax_rate_pct'];

// Applies the edit to a copy-in-place of the whole invoice list; returns the plain-language change lines.
function applyInvoiceEdit(list, p, rules) {
  const rec = findRec(list, p.invoice_no, p.match_date);
  const st = rec.st; const lines = []; const label = `${st.invNo}`;
  const now = new Date().toISOString();
  if (p.delete) {
    const i = list.indexOf(rec); list.splice(i, 1);
    lines.push(`Delete invoice ${label} (${st.invDate}, ${money(num(rec.total) || computeTotal(st))}) from the Invoicing tab`);
    return { rec: null, lines };
  }
  for (const [k, [name, get, set]] of Object.entries(FIELD)) {
    if (p[k] === undefined || p[k] === null || p[k] === '') continue;
    const was = get(st); set(st, p[k]); const now2 = get(st);
    if (String(was ?? '') !== String(now2 ?? '')) lines.push(`${name}: ${was || '(blank)'} → ${now2}`);
  }
  if (p.new_invoice_no) {
    const clash = list.find((r) => r !== rec && String(r.st.invNo).trim().toLowerCase() === String(p.new_invoice_no).trim().toLowerCase());
    if (clash) throw bad(`Invoice ${p.new_invoice_no} already exists (dated ${clash.st.invDate})`);
  }
  if (Array.isArray(p.draws)) {
    if (!p.draws.length) throw bad('A schedule needs at least one draw');
    const old = (st.draws || []).map((d) => `${d.label} ${st.mode === 'pct' ? `${num(d.val)}%` : money(d.val)}`).join(' / ');
    st.draws = p.draws.map((d, i) => ({ label: String(d.label || `Draw ${i + 1}`), val: num(d.value), date: ((st.draws || [])[i] || {}).date || '', ck: ((st.draws || [])[i] || {}).ck || '' }));
    if (st.mode === 'pct') { const sum = r2(st.draws.reduce((a, d) => a + num(d.val), 0)); if (Math.abs(sum - 100) > 0.01) throw bad(`Draw percentages add up to ${sum}%, not 100%`); }
    lines.push(`Draw schedule: ${old} → ${st.draws.map((d) => `${d.label} ${st.mode === 'pct' ? `${num(d.val)}%` : money(d.val)}`).join(' / ')}`);
  }
  if (p.this_draw) {
    const n = Math.round(num(p.this_draw));
    if (n < 1 || n > (st.draws || []).length) throw bad(`this_draw must be 1–${(st.draws || []).length}`);
    if (n - 1 !== ci(st)) { lines.push(`Bills draw #${ci(st) + 1} → draw #${n}`); st.currentIdx = n - 1; }
  }
  if (Array.isArray(p.extra_items)) {
    const was = (st.items || []).map((it) => `${it.desc} ${money(it.amt)}`).join(', ') || 'none';
    st.items = p.extra_items.map((it) => ({ desc: String(it.description || 'Additional item'), amt: r2(num(it.amount)) }));
    lines.push(`Extra items: ${was} → ${st.items.map((it) => `${it.desc} ${money(it.amt)}`).join(', ') || 'none'}`);
  }
  if (AMOUNT_FIELDS.some((k) => p[k] !== undefined && p[k] !== null && p[k] !== '')) {
    const was = num(rec.total); rec.total = computeTotal(st);
    if (Math.abs(was - rec.total) > 0.004) lines.push(`Amount due: ${money(was)} → ${money(rec.total)}`);
  }
  // Which job it belongs to.
  const map = LCP.assign(list, { mode: rules.project_grouping });
  if (p.same_job_as) {
    const target = findRec(list, p.same_job_as);
    if (target === rec) throw bad('same_job_as must be a different invoice');
    const pid = map.get(target.id) || target.id;
    target.st.contractId = pid; target.st.contractPinned = true; target.updatedAt = now;
    st.contractId = pid; st.contractPinned = true;
    lines.push(`Job: put ${label} in the same job as ${target.st.invNo}`);
  } else if (p.own_job) {
    st.contractId = `own:${rec.id}`; st.contractPinned = true;
    lines.push(`Job: ${label} becomes its own job`);
  }
  // Paid / unpaid.
  if (p.status === 'unpaid' && rec.status === 'paid') {
    const pid = map.get(rec.id); const i = ci(st);
    for (const r of list) if (r !== rec && map.get(r.id) === pid && ci(r.st) > i && r.st.draws[i]) { r.st.draws[i].ck = ''; r.st.draws[i].date = ''; r.updatedAt = now; }
    rec.status = 'unpaid'; delete rec.payment;
    lines.push(`Status: paid → unpaid`);
  } else if (p.status === 'paid' || p.payment) {
    const pay = p.payment || {};
    if (pay.date && !ISO.test(pay.date)) throw bad('payment.date must be YYYY-MM-DD');
    const was = rec.status === 'paid' ? `paid${rec.payment && rec.payment.date ? ` ${rec.payment.date}` : ''}${rec.payment && rec.payment.ck ? ` ck ${rec.payment.ck}` : ''}` : 'unpaid';
    const prev = rec.payment || {};
    rec.status = 'paid';
    rec.payment = { date: pay.date || prev.date || '', amount: pay.amount != null ? r2(num(pay.amount)) : (prev.amount ?? r2(num(rec.total) || computeTotal(st))),
      method: pay.method || prev.method || (pay.check_no ? 'check' : 'check'), ck: pay.check_no != null ? String(pay.check_no) : (prev.ck || '') };
    const p2 = rec.payment;
    lines.push(`Status: ${was} → paid ${p2.date || '(no date)'} · ${money(p2.amount)}${p2.ck ? ` · ck ${p2.ck}` : ''}${p2.method && p2.method !== 'check' ? ` · ${p2.method}` : ''}`);
  }
  if (!lines.length) throw bad('That edit doesn\'t change anything');
  rec.updatedAt = now;
  return { rec, lines };
}

async function previewInvoiceEdit(p) {
  const data = JSON.parse(JSON.stringify(await invoiceData()));
  const rules = await RULES.getRules();
  const { lines } = applyInvoiceEdit(data.invoices || [], p, rules);
  return `Invoice ${p.invoice_no}\n${lines.join('\n')}${p.reason ? `\nWhy: ${p.reason}` : ''}`;
}
async function runInvoiceEdit(p) {
  const BOOKS = require('./books');
  const rules = await RULES.getRules();
  return BOOKS.edit(KEY, (value) => {
    const { lines } = applyInvoiceEdit(value.invoices, p, rules);
    LCP.reconcile(value.invoices, { mode: rules.project_grouping, laterCheck: rules.later_check_marks_paid === 'yes' });
    return { changed: lines };
  });
}

// ---------- data fixes (Cockpit-side records) ----------
async function jobByName(name) {
  const id = await resolveJob(name);
  if (!id) throw bad(`No job named "${name}"`);
  return (await q('SELECT id, name, status, draws IS NOT NULL AS from_invoices FROM jobs WHERE id=$1', [id])).rows[0];
}
async function txById(id) {
  const t = (await q('SELECT * FROM transactions WHERE id=$1', [id])).rows[0];
  if (!t) throw bad(`Ledger entry #${id} doesn't exist`);
  return t;
}
const txLabel = (t) => `#${t.id} ${t.date instanceof Date ? t.date.toISOString().slice(0, 10) : t.date} ${t.kind} ${money(t.amount)} ${t.category}${t.party ? ` · ${t.party}` : ''}`;

// Checks every operation and returns { line, run } for each, so nothing runs unless all of them are valid.
async function planDataFix(p) {
  const ops = Array.isArray(p.ops) ? p.ops : [];
  if (!ops.length) throw bad('No changes listed');
  const plan = [];
  for (const o of ops) {
    switch (o.op) {
      case 'delete_entry': {
        const t = await txById(o.id);
        if (t.created_by === 'sync') throw bad(`${txLabel(t)} comes from an invoice – change or delete the invoice instead`);
        plan.push({ line: `Delete ledger entry ${txLabel(t)}`, run: () => q('DELETE FROM transactions WHERE id=$1', [t.id]) });
        break;
      }
      case 'update_entry': {
        const t = await txById(o.id);
        if (t.created_by === 'sync') throw bad(`${txLabel(t)} comes from an invoice – edit the invoice instead`);
        const f = o.fields || {};
        const changes = Object.entries(f).filter(([k]) => ['date', 'amount', 'category', 'party', 'job_name', 'method', 'check_no', 'memo', 'invoice_no'].includes(k));
        if (!changes.length) throw bad(`Nothing to change on #${t.id}`);
        plan.push({ line: `Change ${txLabel(t)}: ${changes.map(([k, v]) => `${k} → ${v}`).join(', ')}`, run: async () => {
          const cur = (await q('SELECT t.*, j.name AS job_name FROM transactions t LEFT JOIN jobs j ON j.id=t.job_id WHERE t.id=$1', [t.id])).rows[0];
          const merged = { ...cur, ...Object.fromEntries(changes) }; if (f.job_name) delete merged.job_id;
          return S.updateTransaction(t.id, merged);
        } });
        break;
      }
      case 'delete_job': {
        const j = await jobByName(o.job_name);
        if (j.from_invoices) throw bad(`"${j.name}" comes from invoices – delete or move its invoices instead`);
        const n = (await q(`SELECT (SELECT COUNT(*) FROM transactions WHERE job_id=$1)::int + (SELECT COUNT(*) FROM time_entries WHERE job_id=$1)::int + (SELECT COUNT(*) FROM mileage WHERE job_id=$1)::int AS n`, [j.id])).rows[0].n;
        plan.push({ line: `Delete job "${j.name}"${n ? ` (its ${n} entr${n === 1 ? 'y stays' : 'ies stay'} in the books, untagged)` : ''}`, run: async () => {
          for (const t of ['transactions', 'time_entries', 'mileage', 'invoices', 'estimates']) await q(`UPDATE ${t} SET job_id=NULL WHERE job_id=$1`, [j.id]);
          await q('DELETE FROM jobs WHERE id=$1', [j.id]);
        } });
        break;
      }
      case 'merge_job': {
        const a = await jobByName(o.job_name); const b = await jobByName(o.into_job_name);
        if (a.id === b.id) throw bad('Pick two different jobs');
        if (a.from_invoices) throw bad(`"${a.name}" comes from invoices – to combine invoice jobs, edit the invoices (same_job_as)`);
        plan.push({ line: `Move everything tagged to "${a.name}" into "${b.name}", then remove "${a.name}"`, run: () => require('./check').mergeJob(a.id, b.id) });
        break;
      }
      case 'rename_job': {
        const j = await jobByName(o.job_name);
        if (!String(o.new_name || '').trim()) throw bad('new_name is required');
        plan.push({ line: `Rename job "${j.name}" → "${o.new_name}"`, run: () => q('UPDATE jobs SET name=$2 WHERE id=$1', [j.id, String(o.new_name).trim().slice(0, 150)]) });
        break;
      }
      case 'set_job_status': {
        const j = await jobByName(o.job_name);
        if (!['lead', 'estimating', 'active', 'complete', 'lost'].includes(o.status)) throw bad('status is lead, estimating, active, complete or lost');
        plan.push({ line: `Job "${j.name}": ${j.status} → ${o.status}`, run: () => q('UPDATE jobs SET status=$2 WHERE id=$1', [j.id, o.status]) });
        break;
      }
      case 'delete_outside_invoice': {
        const i = (await q(`SELECT id, invoice_no, amount, source FROM invoices WHERE lower(invoice_no)=lower($1) AND source<>'invoice-app'`, [o.invoice_no])).rows[0];
        if (!i) throw bad(`No invoice ${o.invoice_no} outside the Invoicing tab (to delete one in the Invoicing tab, use propose_invoice_edit with delete)`);
        plan.push({ line: `Delete stray invoice ${i.invoice_no} (${money(i.amount)}, not from the Invoicing tab)`, run: () => q('DELETE FROM invoices WHERE id=$1', [i.id]) });
        break;
      }
      case 'update_time_entry': case 'delete_time_entry': {
        const t = (await q('SELECT te.*, j.name AS job_name FROM time_entries te LEFT JOIN jobs j ON j.id=te.job_id WHERE te.id=$1', [o.id])).rows[0];
        if (!t) throw bad(`Hours entry #${o.id} doesn't exist`);
        const lab = `hours #${t.id} ${t.date instanceof Date ? t.date.toISOString().slice(0, 10) : t.date} ${t.worker} ${t.hours}h${t.job_name ? ` ${t.job_name}` : ''}`;
        if (o.op === 'delete_time_entry') { plan.push({ line: `Delete ${lab}`, run: () => q('DELETE FROM time_entries WHERE id=$1', [t.id]) }); break; }
        const jobId = o.job_name ? (await jobByName(o.job_name)).id : t.job_id;
        if (o.hours != null && !(Number(o.hours) > 0 && Number(o.hours) <= 24)) throw bad('hours must be between 0 and 24');
        if (o.date && !ISO.test(o.date)) throw bad('date must be YYYY-MM-DD');
        plan.push({ line: `Change ${lab}: ${[o.date && `date → ${o.date}`, o.hours != null && `hours → ${o.hours}`, o.job_name && `job → ${o.job_name}`].filter(Boolean).join(', ')}`,
          run: () => q('UPDATE time_entries SET date=COALESCE($2,date), hours=COALESCE($3,hours), job_id=$4 WHERE id=$1', [t.id, o.date || null, o.hours ?? null, jobId]) });
        break;
      }
      case 'resolve_flag': {
        const f = (await q('SELECT * FROM books_flags WHERE id=$1', [o.id])).rows[0];
        if (!f) throw bad(`No flag #${o.id}`);
        plan.push({ line: `Close flag #${f.id}: ${f.text.slice(0, 80)}`, run: () => q('UPDATE books_flags SET resolved_at=now() WHERE id=$1', [f.id]) });
        break;
      }
      default: throw bad(`Unknown change "${o.op}"`);
    }
  }
  return plan;
}
async function previewDataFix(p) {
  const plan = await planDataFix(p);
  return `${plan.map((x) => x.line).join('\n')}${p.reason ? `\nWhy: ${p.reason}` : ''}`;
}
async function runDataFix(p) {
  const plan = await planDataFix(p); // re-checked at approval time: the data may have changed since
  const done = [];
  for (const x of plan) { await x.run(); done.push(x.line); }
  const BOOKS = require('./books'); await BOOKS.refresh();
  return { done };
}

// ---------- rules ----------
async function previewRuleChange(p) {
  const rules = await RULES.getRules();
  const clean = RULES.validate(p.changes || {});
  const lines = Object.entries(clean).filter(([k, v]) => rules[k] !== v).map(([k, v]) => {
    const def = RULES.RULES[k];
    return `${def.label}: ${def.number ? `${rules[k]} → ${v} ${def.number.unit}` : `"${def.options[rules[k]]}" → "${def.options[v]}"`}`;
  });
  // What changing the grouping does to the number of jobs.
  if (clean.project_grouping && clean.project_grouping !== rules.project_grouping) {
    const list = ((await invoiceData()).invoices || []).filter((r) => r && r.st && String(r.st.invNo || '').trim() && Array.isArray(r.st.draws) && r.st.draws.length);
    lines.push(`(${LCP.groups(list, { mode: rules.project_grouping }).size} jobs from invoices now → ${LCP.groups(list, { mode: clean.project_grouping }).size} after; expenses and hours move with their invoices)`);
  }
  for (const h of [].concat(p.add_house_rules || [])) lines.push(`New house rule: "${h}"`);
  for (const h of [].concat(p.remove_house_rules || [])) lines.push(`Drop house rule: ${typeof h === 'number' ? `#${h} "${rules.house_rules[h - 1] || '?'}"` : `"${h}"`}`);
  if (!lines.length) throw bad('Those rules are already set that way');
  return `${lines.join('\n')}${p.reason ? `\nWhy: ${p.reason}` : ''}`;
}

module.exports = { invoiceRecord, previewInvoiceEdit, runInvoiceEdit, previewDataFix, runDataFix, previewRuleChange };
