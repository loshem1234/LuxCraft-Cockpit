/* One set of rules, used by both the invoice app (in the browser) and the Cockpit server, so the two can never
   disagree about which invoices belong to the same project or whether an invoice is paid.

   PROJECT: every invoice starts its own project. An invoice made with "Bill next draw" continues the project of the
   invoice it came from (stored as st.contractId). Older invoices made before contractId existed are joined only when
   they are clearly the same contract: same client, billing address, job site, project, contract amount and number of
   draws, and a later draw number. Two invoices for the same draw are never the same project, even on the same lot.

   The Cockpit's "Which invoices belong to the same job" rule can switch this to one job per client + lot number
   (mode 'lot'). An invoice Clara pinned to a job (st.contractPinned) stays with it whatever the rule says.

   PAID: an invoice is paid when it is marked Paid (rec.status === 'paid'). The payment's date, check # and amount are
   kept on the invoice (rec.payment). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LCProjects = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const clean = (x) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim().toLowerCase();
  const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  const drawIdx = (st) => Math.max(0, Math.min(num(st && st.currentIdx), ((st && st.draws) || []).length - 1));

  function legacyKey(st) {
    const c = st.client || {};
    return [c.name, c.a1, c.a2, st.project, st.site1, st.site2, num(st.proposal).toFixed(2), (st.draws || []).length].map(clean).join('|');
  }

  function lotOf(st) {
    for (const f of [st.site1, st.site2, st.project]) { const m = String(f || '').match(/\blot\s*(?:#|no\.?|number)?\s*(\d+[a-z]?)\b/i); if (m) return m[1].toLowerCase(); }
    return null;
  }

  // Map of invoice record id → project id. mode: 'invoice_chain' (default) or 'lot'.
  function assign(invoices, { mode = 'invoice_chain' } = {}) {
    const all = (invoices || []).filter((r) => r && r.id && r.st);
    const out = new Map();
    // Pinned by Clara (with Loshem's approval) – always wins.
    for (const r of all) if (r.st.contractPinned && r.st.contractId) out.set(r.id, String(r.st.contractId));
    let recs = all.filter((r) => !out.has(r.id));
    if (mode === 'lot') {
      for (const r of recs) { const lot = lotOf(r.st); if (lot) out.set(r.id, `lot:${clean(r.st.client && r.st.client.name)}|${lot}`); }
      recs = recs.filter((r) => !out.has(r.id));
    }
    const byCreated = (a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || (drawIdx(a.st) - drawIdx(b.st));
    // 1) Older invoices without a project id: chain them by matching details.
    const groups = new Map();
    for (const r of recs) if (!r.st.contractId) { const k = legacyKey(r.st); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
    for (const list of groups.values()) {
      const chains = [];
      for (const r of list.slice().sort(byCreated)) {
        const i = drawIdx(r.st);
        const c = chains.find((ch) => ch.top < i);
        if (c) { c.top = i; out.set(r.id, c.id); } else { chains.push({ id: r.id, top: i }); out.set(r.id, r.id); }
      }
    }
    // 2) Invoices that carry a project id use it.
    for (const r of recs) if (r.st.contractId) out.set(r.id, String(r.st.contractId));
    return out;
  }

  function groups(invoices, opts) {
    const map = assign(invoices, opts); const g = new Map();
    for (const r of invoices || []) { if (!r || !map.has(r.id)) continue; const p = map.get(r.id); if (!g.has(p)) g.set(p, []); g.get(p).push(r); }
    return g;
  }

  const isPaid = (r) => !!r && r.status === 'paid';

  // Keep every invoice in a project telling the same story (run before each save and once on load):
  //  - a check # typed on a later invoice for an earlier draw marks that draw's invoice Paid with that date/check;
  //  - a payment recorded on an invoice is copied onto later invoices' draw lines, so their PDFs print it.
  // Returns the ids of records it changed.
  function reconcile(invoices, { today, mode, laterCheck = true } = {}) {
    const changed = new Set();
    // Payments link draw-by-draw within one contract (an invoice and its "Bill next draw" follow-ups), even when the
    // grouping rule puts several contracts in one job – otherwise one contract's check could mark another's draw paid.
    void mode;
    for (const list of groups(invoices).values()) {
      const billerOf = (i) => list.filter((r) => drawIdx(r.st) === i).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];
      // later → earlier (unless the "check # on a later invoice" rule is off)
      if (laterCheck) for (const later of list) {
        const ci = drawIdx(later.st);
        for (let i = 0; i < ci; i++) {
          const d = (later.st.draws || [])[i] || {};
          const ck = String(d.ck || '').trim();
          if (!ck) continue;
          const b = billerOf(i);
          if (!b || b === later) continue;
          // Older versions filled the paid date in with the earlier invoice's own date – not a real payment date.
          const date = d.date && d.date !== b.st.invDate ? d.date : '';
          if (!isPaid(b)) { b.status = 'paid'; b.payment = { date, ck, method: 'check' }; changed.add(b.id); }
          else if (!b.payment || !b.payment.ck) { b.payment = { ...(b.payment || {}), ck, date: (b.payment && b.payment.date) || date, method: (b.payment && b.payment.method) || 'check' }; changed.add(b.id); }
        }
      }
      // earlier → later
      for (const b of list) {
        if (!isPaid(b) || !b.payment) continue;
        const i = drawIdx(b.st);
        for (const later of list) {
          if (later === b || drawIdx(later.st) <= i) continue;
          const d = (later.st.draws || [])[i]; if (!d) continue;
          const ck = b.payment.ck || ''; const date = b.payment.date || '';
          if ((ck && d.ck !== ck) || (date && d.date !== date)) { if (ck) d.ck = ck; if (date) d.date = date; changed.add(later.id); }
        }
      }
    }
    return [...changed];
  }

  return { assign, groups, reconcile, legacyKey, drawIdx, isPaid, lotOf };
}));
