// Database connection, schema, and seed data.
const { Pool, types } = require('pg');

// Return NUMERIC as JS numbers and DATE as 'YYYY-MM-DD' strings.
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
types.setTypeParser(1082, (v) => v);

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set. Add a Postgres database in Railway and link it to this service.');
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  ssl: /localhost|127\.0\.0\.1|\.railway\.internal/.test(connectionString) ? false : { rejectUnauthorized: false },
});

const q = (text, params) => pool.query(text, params);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('income','expense')),
  sched_c TEXT NOT NULL,
  note TEXT,
  sort INT DEFAULT 100,
  active BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS jobs (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  client TEXT,
  address TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('lead','estimating','active','complete','lost')),
  pricing TEXT NOT NULL DEFAULT 'fixed' CHECK (pricing IN ('fixed','tm','day')),
  contract_amount NUMERIC(12,2),
  budget_cost NUMERIC(12,2),
  start_date DATE,
  end_date DATE,
  source TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workers (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL DEFAULT 'helper' CHECK (role IN ('owner','helper','sub')),
  rate NUMERIC(10,2),
  active BOOLEAN DEFAULT TRUE
);

-- Files are stored AES-256-GCM encrypted (see security.js).
CREATE TABLE IF NOT EXISTS attachments (
  id SERIAL PRIMARY KEY,
  filename TEXT,
  mime TEXT,
  size INT,
  data BYTEA NOT NULL,
  encrypted BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  invoice_no TEXT UNIQUE NOT NULL,
  job_id INT REFERENCES jobs(id) ON DELETE SET NULL,
  client TEXT,
  issue_date DATE,
  due_date DATE,
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  draw_label TEXT,
  notes TEXT,
  void BOOLEAN DEFAULT FALSE,
  source TEXT NOT NULL DEFAULT 'manual',
  external_id TEXT UNIQUE,
  attachment_id INT REFERENCES attachments(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS estimates (
  id SERIAL PRIMARY KEY,
  est_no TEXT UNIQUE NOT NULL,
  job_id INT REFERENCES jobs(id) ON DELETE SET NULL,
  client TEXT,
  project TEXT,
  est_date DATE,
  valid_until DATE,
  total NUMERIC(12,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  scope TEXT,
  source TEXT NOT NULL DEFAULT 'invoice-app',
  external_id TEXT UNIQUE,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('income','expense')),
  date DATE NOT NULL,
  amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  category TEXT NOT NULL,
  job_id INT REFERENCES jobs(id) ON DELETE SET NULL,
  party TEXT,
  method TEXT,
  check_no TEXT,
  invoice_no TEXT,
  memo TEXT,
  attachment_id INT REFERENCES attachments(id) ON DELETE SET NULL,
  split_group TEXT,
  billable BOOLEAN NOT NULL DEFAULT FALSE,
  markup_pct NUMERIC(6,2),
  billed BOOLEAN NOT NULL DEFAULT FALSE,
  sales_tax NUMERIC(12,2),
  untaxed BOOLEAN NOT NULL DEFAULT FALSE,
  reconciled BOOLEAN NOT NULL DEFAULT FALSE,
  ext_ref TEXT UNIQUE,
  created_by TEXT DEFAULT 'manual',
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tx_date_idx ON transactions(date);
CREATE INDEX IF NOT EXISTS tx_invoice_idx ON transactions(lower(invoice_no));
CREATE INDEX IF NOT EXISTS tx_split_idx ON transactions(split_group);

CREATE TABLE IF NOT EXISTS mileage (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL,
  miles NUMERIC(8,1) NOT NULL CHECK (miles > 0),
  job_id INT REFERENCES jobs(id) ON DELETE SET NULL,
  purpose TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS time_entries (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL,
  worker TEXT NOT NULL DEFAULT 'Me',
  job_id INT REFERENCES jobs(id) ON DELETE SET NULL,
  hours NUMERIC(5,2) NOT NULL CHECK (hours > 0),
  est_earned NUMERIC(12,2),
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS te_date_idx ON time_entries(date);

CREATE TABLE IF NOT EXISTS daily_logs (
  date DATE PRIMARY KEY,
  plan TEXT,
  goals JSONB NOT NULL DEFAULT '[]'::jsonb,
  met TEXT CHECK (met IN ('yes','partial','no')),
  outcome TEXT,
  est_earned NUMERIC(12,2),
  hours NUMERIC(5,2),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS planned_purchases (
  id SERIAL PRIMARY KEY,
  item TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'tools' CHECK (kind IN ('tools','truck','trailer','equipment','other')),
  cost NUMERIC(12,2) NOT NULL,
  business_pct NUMERIC(5,2) NOT NULL DEFAULT 100,
  planned_date DATE,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','bought','dropped')),
  note TEXT
);

CREATE TABLE IF NOT EXISTS bank_rows (
  id SERIAL PRIMARY KEY,
  import_id TEXT NOT NULL,
  account TEXT,
  date DATE NOT NULL,
  description TEXT,
  amount NUMERIC(12,2) NOT NULL,
  fingerprint TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','matched','added','ignored')),
  tx_id INT REFERENCES transactions(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Agents
CREATE TABLE IF NOT EXISTS agent_messages (
  id SERIAL PRIMARY KEY,
  agent TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  kind TEXT NOT NULL DEFAULT 'chat',
  text TEXT NOT NULL,
  proposals JSONB,
  sources JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS am_agent_idx ON agent_messages(agent, id);

CREATE TABLE IF NOT EXISTS proposals (
  id SERIAL PRIMARY KEY,
  agent TEXT NOT NULL,
  action TEXT NOT NULL,
  payload JSONB NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','failed')),
  result JSONB,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  decided_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS facts (
  id SERIAL PRIMARY KEY,
  text TEXT NOT NULL,
  agent TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_docs (
  id SERIAL PRIMARY KEY,
  agent TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT,
  size INT,
  attachment_id INT REFERENCES attachments(id) ON DELETE SET NULL,
  text_enc BYTEA,
  chars INT NOT NULL DEFAULT 0,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Security
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT now(),
  last_seen TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  ip TEXT,
  user_agent TEXT,
  revoked BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id SERIAL PRIMARY KEY,
  label TEXT NOT NULL,
  scope TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  origin TEXT,
  last_used TIMESTAMPTZ,
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  at TIMESTAMPTZ DEFAULT now(),
  event TEXT NOT NULL,
  detail TEXT,
  ip TEXT
);
`;

// Schedule C lines. "COGS" = Part III cost of goods sold, "NONE" = not a business deduction.
const CATEGORIES = [
  ['Contract Revenue', 'income', 'L1', 'Client payments for jobs, including deposits and draws', 1],
  ['Materials Reimbursement', 'income', 'L1', 'Client paying you back for materials you bought for their job', 2],
  ['Other Business Income', 'income', 'L6', 'Scrap sales, rebates, misc.', 3],
  ['Owner Contribution', 'income', 'NONE', 'Your own money put into the business (not taxable income)', 4],
  ['Invoiced – Awaiting Payment', 'income', 'NONE', 'Billed to a client and not paid yet. Synced from invoices; becomes Contract Revenue when paid. Not counted as revenue or taxed until paid.', 5],
  ['Materials', 'expense', 'COGS', 'Lumber, drywall, tile, fixtures that go into client jobs', 10],
  ['Subcontractors', 'expense', 'L11', 'Subs and helpers paid on 1099 (tracked for 1099-NEC)', 11],
  ['Equipment Rental', 'expense', 'L20a', 'Rented machinery, lifts, trailers', 14],
  ['Dumpster & Disposal', 'expense', 'L27a', 'Dumpsters, dump fees, haul-away', 15],
  ['Permits & Inspections', 'expense', 'L23', 'Building permits, inspection fees', 16],
  ['Tools & Small Equipment', 'expense', 'L22', 'Hand/power tools and supplies under your capitalization threshold', 20],
  ['Large Equipment (Depreciable)', 'expense', 'L13', 'Bigger tools, trailers – depreciate or expense (Section 179/bonus); confirm with accountant', 21],
  ['Fuel / Gas', 'expense', 'L9', 'Only deductible if you use the actual-expense vehicle method', 22],
  ['Vehicle Repairs & Maintenance', 'expense', 'L9', 'Only deductible if you use the actual-expense vehicle method', 23],
  ['Equipment Repairs', 'expense', 'L21', 'Repairs to your own tools and equipment', 24],
  ['Insurance', 'expense', 'L15', 'General liability, tools, commercial auto', 30],
  ['Advertising & Marketing', 'expense', 'L8', 'Ads, website, signs, cards', 31],
  ['Software & Subscriptions', 'expense', 'L27a', 'Apps, hosting, AI tools', 32],
  ['Phone & Internet', 'expense', 'L25', 'Business share of phone/internet', 33],
  ['Office Supplies', 'expense', 'L18', 'Paper, printer, small office items', 34],
  ['Licenses & Business Taxes', 'expense', 'L23', 'Contractor registrations, business taxes', 35],
  ['Professional Services', 'expense', 'L17', 'Accountant, attorney', 36],
  ['Bank & Card Fees', 'expense', 'L27a', 'Processing fees, bank charges', 37],
  ['Rent – Shop/Storage', 'expense', 'L20b', 'Shop or storage unit rent', 38],
  ['Interest', 'expense', 'L16b', 'Business loan / card interest', 39],
  ['Meals (50%)', 'expense', 'L24b', 'Business meals – 50% deductible', 40],
  ['Travel', 'expense', 'L24a', 'Overnight business travel', 41],
  ['Training & Certifications', 'expense', 'L27a', 'Courses, certifications', 42],
  ['Other Expense', 'expense', 'L27a', 'Anything else business-related', 50],
  ['Estimated Tax Payment', 'expense', 'NONE', 'Quarterly IRS/state/city payments (tracked on Taxes tab)', 90],
  ['Owner Draw', 'expense', 'NONE', 'Money you pay yourself (not deductible)', 91],
];

const DEFAULT_SETTINGS = {
  business_name: 'LuxCraft Renovations',
  business_city: 'Fairborn',
  vehicle_method: 'standard',
  default_markup_pct: '0',
  daily_target: '0',
  goal_monthly_revenue: '0',
  // IRS business standard mileage rates by effective date (2026 rose mid-year on July 1).
  mileage_rates: JSON.stringify([{ from: '2025-01-01', rate: 0.70 }, { from: '2026-01-01', rate: 0.725 }, { from: '2026-07-01', rate: 0.76 }]),
  ss_wage_base: JSON.stringify({ 2025: 176100, 2026: 184500 }),
  threshold_1099: JSON.stringify({ 2025: 600, 2026: 2000 }),
  // Federal estimate
  filing_status: 'single',
  other_income: '0', // other household taxable income (spouse wages etc.)
  apply_qbi: 'true',
  tax_tables: JSON.stringify({
    2026: {
      single: { std: 16100, brackets: [[12400, 0.10], [50400, 0.12], [105700, 0.22], [201775, 0.24], [256225, 0.32], [640600, 0.35], [null, 0.37]] },
      mfj: { std: 32200, brackets: [[24800, 0.10], [100800, 0.12], [211400, 0.22], [403550, 0.24], [512450, 0.32], [768700, 0.35], [null, 0.37]] },
    },
  }),
  // Ohio: business income deduction, then flat rate on the rest
  ohio_bid: '250000',
  ohio_business_rate: '3',
  school_district_rate: '0.5', // Fairborn CSD, traditional base (taxes Ohio taxable income)
  city_rate: '2', // Fairborn municipal income tax
  use_tax_rate: '6.75', // Greene County combined sales/use rate
  home_office_sqft: '0',
  home_office_method: 'simplified',
  agents: JSON.stringify({}),
};

async function migrate() {
  await q(SCHEMA);
  for (const [name, kind, sched, note, sort] of CATEGORIES) {
    await q('INSERT INTO categories (name, kind, sched_c, note, sort) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (name) DO NOTHING', [name, kind, sched, note, sort]);
  }
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    await q('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING', [k, v]);
  }
  await q(`INSERT INTO workers (name, role) VALUES ('Me','owner') ON CONFLICT (name) DO NOTHING`);
}

async function getSettings() {
  const { rows } = await q('SELECT key, value FROM settings');
  const s = {};
  for (const r of rows) {
    if (r.key.startsWith('secret_')) continue; // never hand secrets to callers
    try { s[r.key] = JSON.parse(r.value); } catch { s[r.key] = r.value; }
  }
  return s;
}
async function getSecret(key) {
  const { rows } = await q('SELECT value FROM settings WHERE key=$1', [`secret_${key}`]);
  return rows[0] ? rows[0].value : null;
}
async function setSecret(key, value) {
  if (value === null) return q('DELETE FROM settings WHERE key=$1', [`secret_${key}`]);
  return q('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [`secret_${key}`, value]);
}

// Find a job by id or by (case-insensitive) name; optionally create it.
async function resolveJob(jobIdOrName, { create = false, client = null, status = 'active' } = {}) {
  if (jobIdOrName === null || jobIdOrName === undefined || jobIdOrName === '') return null;
  if (typeof jobIdOrName === 'number' || /^\d+$/.test(String(jobIdOrName))) {
    const { rows } = await q('SELECT id FROM jobs WHERE id=$1', [Number(jobIdOrName)]);
    return rows[0] ? rows[0].id : null;
  }
  const name = String(jobIdOrName).trim();
  const { rows } = await q('SELECT id FROM jobs WHERE lower(name)=lower($1)', [name]);
  if (rows[0]) return rows[0].id;
  if (!create) {
    const fuzzy = await q('SELECT id FROM jobs WHERE name ILIKE $1 ORDER BY created_at DESC LIMIT 1', [`%${name}%`]);
    return fuzzy.rows[0] ? fuzzy.rows[0].id : null;
  }
  const ins = await q('INSERT INTO jobs (name, client, status) VALUES ($1,$2,$3) ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING id', [name, client, status]);
  return ins.rows[0].id;
}

module.exports = { pool, q, migrate, getSettings, getSecret, setSecret, resolveJob };
