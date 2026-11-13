// Books rules: the plain-language switches that decide how invoices become projects and numbers. Every tab and
// every agent reads them from here, so a rule changed once (by Loshem in Settings, or by Clara with his approval)
// applies across the whole Cockpit without a code change. House rules are free-text conventions the agents follow.
const { q, getSettings } = require('./db');

const RULES = {
  jobs_source: {
    label: 'What counts as a job',
    options: {
      invoices_only: 'Only invoices from the Invoicing tab create jobs. Jobs made any other way are hidden from Jobs and left out of every total.',
      invoices_and_manual: 'Invoices create jobs, and jobs can also be added by hand or by an agent (for work not invoiced yet).',
    },
    default: 'invoices_only',
  },
  project_grouping: {
    label: 'Which invoices belong to the same job',
    options: {
      invoice_chain: 'Each new invoice starts its own job. An invoice made with "Bill next draw" joins the job of the invoice it came from.',
      lot: 'All invoices for the same client and lot number are one job.',
    },
    default: 'invoice_chain',
  },
  job_closes_when: {
    label: 'When a job moves to Completed',
    options: {
      all_draws_paid: 'When every draw in its schedule has been invoiced and paid in full.',
      billed_paid: 'When every invoice billed so far is paid in full (draws not invoiced yet don\'t keep it open).',
      manual: 'Only when you mark it complete.',
    },
    default: 'all_draws_paid',
  },
  count_to_bill: {
    label: 'Draws not invoiced yet',
    options: {
      show: 'Show them as "Still to bill" (money expected on the contract but not invoiced yet).',
      hide: 'Leave them out. Numbers only change when an invoice is created.',
    },
    default: 'show',
  },
  later_check_marks_paid: {
    label: 'A check # typed on a later invoice',
    options: {
      yes: 'Marks the earlier draw\'s invoice paid.',
      no: 'Does nothing. An invoice is paid only when its own payment is recorded.',
    },
    default: 'yes',
  },
  short_payment: {
    label: 'A payment less than the invoice',
    options: {
      rest_owed: 'The difference stays owed on that invoice.',
      paid_in_full: 'The invoice counts as paid in full (the difference is written off).',
    },
    default: 'rest_owed',
  },
  manual_income: {
    label: 'Income entered by hand in the ledger',
    options: {
      no_invoice_only: 'Allowed only for money that had no invoice (never for an invoice\'s payment).',
      never: 'Not allowed. All income comes from invoices.',
    },
    default: 'no_invoice_only',
  },
  receipt_grace_days: {
    label: '"Due upon receipt" invoices are overdue after',
    number: { min: 0, max: 120, unit: 'days' },
    default: 14,
  },
};

async function getRules() {
  const s = await getSettings();
  const saved = (s.books_rules && typeof s.books_rules === 'object') ? s.books_rules : {};
  const out = {};
  for (const [k, def] of Object.entries(RULES)) {
    let v = k === 'receipt_grace_days' ? s.receipt_grace_days : saved[k]; // grace days live in their own setting (also on Settings → Business)
    if (def.number) { v = Number(v); if (!Number.isFinite(v)) v = def.default; }
    else if (!def.options[v]) v = def.default;
    out[k] = v;
  }
  out.house_rules = Array.isArray(s.house_rules) ? s.house_rules : [];
  return out;
}

function validate(changes) {
  const clean = {};
  for (const [k, v] of Object.entries(changes || {})) {
    const def = RULES[k];
    if (!def) throw Object.assign(new Error(`There's no rule called "${k}"`), { status: 400 });
    if (def.number) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < def.number.min || n > def.number.max) throw Object.assign(new Error(`${def.label}: must be ${def.number.min}–${def.number.max}`), { status: 400 });
      clean[k] = n;
    } else {
      if (!def.options[v]) throw Object.assign(new Error(`${def.label}: choose one of ${Object.keys(def.options).join(', ')}`), { status: 400 });
      clean[k] = v;
    }
  }
  return clean;
}

// Saves rule changes and house-rule edits, then rebuilds every number from the invoices.
async function setRules({ changes = {}, add_house_rules = [], remove_house_rules = [] } = {}) {
  const clean = validate(changes);
  const cur = await getRules();
  const { house_rules, ...rules } = cur;
  const next = { ...rules, ...clean };
  let house = house_rules.slice();
  for (const r of [].concat(remove_house_rules || [])) {
    const i = typeof r === 'number' ? r - 1 : house.findIndex((h) => h.toLowerCase() === String(r).trim().toLowerCase());
    if (i >= 0 && i < house.length) house.splice(i, 1);
  }
  for (const r of [].concat(add_house_rules || [])) {
    const t = String(r || '').trim().slice(0, 400);
    if (t && !house.some((h) => h.toLowerCase() === t.toLowerCase())) house.push(t);
  }
  house = house.slice(0, 60);
  await q(`INSERT INTO settings (key, value) VALUES ('books_rules', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify(next)]);
  await q(`INSERT INTO settings (key, value) VALUES ('house_rules', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify(house)]);
  await q(`INSERT INTO settings (key, value) VALUES ('receipt_grace_days', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [String(next.receipt_grace_days)]);
  const BOOKS = require('./books');
  const summary = await BOOKS.refresh();
  return { rules: next, house_rules: house, refreshed: summary && !summary.error };
}

// Plain-language list of the rules in effect, for agents and for the Numbers check.
function describe(rules) {
  return Object.entries(RULES).map(([k, def]) => ({
    key: k, label: def.label, value: rules[k],
    text: def.number ? `${rules[k]} ${def.number.unit}` : def.options[rules[k]],
    choices: def.number ? { number: def.number } : def.options,
  }));
}

module.exports = { RULES, getRules, setRules, describe, validate };
