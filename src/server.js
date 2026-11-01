process.env.TZ = process.env.TZ || 'America/New_York'; // "today" follows Ohio time
const path = require('path');
const express = require('express');
const multer = require('multer');
const QR = require('qrcode');
const { q, migrate, getSettings, getSecret, setSecret, resolveJob } = require('./db');
const SEC = require('./security');
const S = require('./services');
const AI = require('./ai');
const A = require('./agents');
const F = require('./files');
const IMP = require('./importers');
const TTS = require('./tts');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(SEC.securityHeaders);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const ip = (req) => req.ip;

const PASSWORD = process.env.ADMIN_PASSWORD || '';
if (!PASSWORD) console.warn('WARNING: ADMIN_PASSWORD is not set – nobody can log in until you set it.');

app.get('/healthz', (req, res) => res.json({ ok: true }));

// ---------- integrations (API token, CORS for the invoice app only) ----------
async function allowedOrigin(origin) {
  if (!origin) return false;
  const { rows } = await q(`SELECT 1 FROM api_tokens WHERE origin=$1 AND NOT revoked LIMIT 1`, [origin]);
  return rows.length > 0;
}
app.use('/api/integrations', express.json({ limit: '10mb' }), wrap(async (req, res, next) => {
  const origin = req.get('origin');
  if (origin && await allowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}));
const integrationLimit = SEC.rateLimit({ windowMs: 60000, max: 30 });
app.post('/api/integrations/invoice-app', integrationLimit, wrap(async (req, res) => {
  const tok = await SEC.checkToken(req, 'invoice-app');
  if (!tok) { await SEC.audit('integration.denied', 'invoice-app', ip(req)); return res.status(401).json({ error: 'Invalid token' }); }
  const body = req.body || {};
  if (!Array.isArray(body.invoices) && !Array.isArray(body.estimates)) return res.status(400).json({ error: 'Expected invoices and/or estimates' });
  const r = await IMP.importInvoiceApp({ invoices: body.invoices || [], estimates: body.estimates || [] });
  res.json({ ok: true, ...r });
}));
// Ready for the website's lead intake later.
app.post('/api/integrations/leads', integrationLimit, wrap(async (req, res) => {
  const tok = await SEC.checkToken(req, 'leads');
  if (!tok) return res.status(401).json({ error: 'Invalid token' });
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'name required' });
  const name = `${String(b.name).slice(0, 60)}${b.project ? ` · ${String(b.project).slice(0, 60)}` : ''}`;
  const id = await resolveJob(name, { create: true, client: b.name });
  await q(`UPDATE jobs SET status='lead', source=$2, address=COALESCE($3,address), notes=COALESCE($4,notes) WHERE id=$1 AND status='active'`,
    [id, String(b.source || 'website').slice(0, 40), b.address || null, b.message ? String(b.message).slice(0, 2000) : null]);
  res.json({ ok: true, job_id: id });
}));

// ---------- auth ----------
app.use('/api', express.json({ limit: '2mb' }));
app.use('/api', SEC.csrfGuard);
const loginLimit = SEC.rateLimit({ windowMs: 15 * 60000, max: 8 });
app.post('/api/auth/login', loginLimit, wrap(async (req, res) => {
  const { password = '', code = '' } = req.body || {};
  if (!PASSWORD || !SEC.safeEqual(password, PASSWORD)) {
    await SEC.audit('login.failed', 'bad password', ip(req));
    return res.status(401).json({ error: 'Wrong password' });
  }
  const secret = await SEC.twoFactor();
  if (secret) {
    if (!code) return res.status(401).json({ need_2fa: true, error: 'Enter the 6-digit code from your authenticator app' });
    const ok = SEC.verifyTotp(secret, code) || (String(code).length > 6 && await SEC.useRecoveryCode(code));
    if (!ok) { await SEC.audit('login.failed', 'bad 2FA code', ip(req)); return res.status(401).json({ need_2fa: true, error: 'That code didn\'t work' }); }
  }
  await SEC.createSession(req, res);
  await SEC.audit('login.ok', secret ? 'with 2FA' : 'password only', ip(req));
  res.json({ ok: true });
}));
app.post('/api/auth/logout', wrap(async (req, res) => { await SEC.destroySession(req, res); res.json({ ok: true }); }));
app.use('/api', wrap(async (req, res, next) => {
  const s = await SEC.getSession(req);
  if (!s) return res.status(401).json({ error: 'Not logged in' });
  req.sessionRow = s;
  next();
}));
app.use('/api', SEC.rateLimit({ windowMs: 60000, max: 400 }));
const aiLimit = SEC.rateLimit({ windowMs: 60000, max: 30 });

// ---------- meta / overview ----------
app.get('/api/meta', wrap(async (req, res) => {
  const [cats, jobs, settings, workers, agents, pending] = await Promise.all([
    q('SELECT * FROM categories ORDER BY kind DESC, sort, name'),
    q(`SELECT id, name, client, status FROM jobs ORDER BY status='complete', status='lost', created_at DESC`),
    getSettings(), q('SELECT * FROM workers ORDER BY id'), A.agentConfig(),
    q(`SELECT COUNT(*)::int AS n FROM proposals WHERE status='pending'`),
  ]);
  const agentInfo = Object.fromEntries(Object.entries(agents).map(([id, a]) => [id, { id, name: a.name, title: a.title, page: a.page, voice: a.voice, style: a.style || '' }]));
  res.json({ categories: cats.rows, jobs: jobs.rows, workers: workers.rows, settings, agents: agentInfo,
    ai_enabled: !!process.env.ANTHROPIC_API_KEY, tts_enabled: TTS.enabled(), model: AI.MODEL, today: S.todayISO(),
    line_labels: S.LINE_LABELS, pending_approvals: pending.rows[0].n, two_factor: !!(await SEC.twoFactor()) });
}));
app.get('/api/overview', wrap(async (req, res) => res.json(await S.overview())));
app.get('/api/analytics', wrap(async (req, res) => res.json(await S.analytics(req.query))));
app.get('/api/taxes', wrap(async (req, res) => res.json(await S.taxSummary(req.query.year))));

// ---------- transactions ----------
app.get('/api/transactions', wrap(async (req, res) => res.json(await S.listTransactions(req.query))));
app.post('/api/transactions', wrap(async (req, res) => res.json(await S.addTransaction(req.body, 'manual'))));
app.post('/api/transactions/split', wrap(async (req, res) => {
  const { parts, ...base } = req.body || {};
  const total = (parts || []).reduce((s, p) => s + Number(p.amount || 0), 0);
  if (base.total && Math.abs(total - Number(base.total)) > 0.01) return res.status(400).json({ error: `Parts add up to $${total.toFixed(2)}, not $${Number(base.total).toFixed(2)}` });
  res.json(await S.addSplit(base, parts, 'manual'));
}));
app.put('/api/transactions/:id', wrap(async (req, res) => res.json(await S.updateTransaction(Number(req.params.id), req.body))));
app.delete('/api/transactions/:id', wrap(async (req, res) => {
  const { rows } = await q('DELETE FROM transactions WHERE id=$1 RETURNING kind, amount, date', [req.params.id]);
  if (rows[0]) await SEC.audit('tx.delete', `#${req.params.id} ${rows[0].kind} ${rows[0].amount} ${rows[0].date}`, ip(req));
  res.json({ ok: true });
}));
app.post('/api/transactions/mark-billed', wrap(async (req, res) => {
  const ids = (req.body.ids || []).map(Number).filter(Boolean);
  const { rowCount } = await q('UPDATE transactions SET billed=true WHERE id = ANY($1) AND billable', [ids]);
  res.json({ marked: rowCount });
}));

// ---------- files & AI reading ----------
app.post('/api/attachments', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json(await F.saveAttachment(req.file));
}));
app.get('/api/attachments/:id', wrap(async (req, res) => {
  const f = await F.loadAttachment(Number(req.params.id));
  if (!f) return res.status(404).end();
  res.setHeader('Content-Type', f.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${(f.filename || 'file').replace(/[^\w.\- ]/g, '_')}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  res.send(f.data);
}));
app.post('/api/ai/extract', aiLimit, upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const kind = req.body.kind === 'invoice' ? 'invoice' : 'receipt';
  const att = await F.saveAttachment(req.file);
  const fields = await AI.extractDocument(req.file.buffer, att.mime, kind);
  res.json({ attachment_id: att.id, fields });
}));

// ---------- invoices & estimates ----------
app.get('/api/invoices', wrap(async (req, res) => res.json(await S.listInvoices(req.query))));
app.post('/api/invoices', wrap(async (req, res) => {
  if (!req.body.invoice_no) return res.status(400).json({ error: 'Invoice number is required' });
  res.json(await S.upsertInvoice(req.body, 'manual'));
}));
app.put('/api/invoices/:id', wrap(async (req, res) => {
  const b = req.body;
  const jobId = b.job_id ? await resolveJob(b.job_id) : null;
  const { rows } = await q(`UPDATE invoices SET invoice_no=$2, job_id=$3, client=$4, issue_date=$5, due_date=$6, amount=$7, notes=$8, void=$9 WHERE id=$1 RETURNING *`,
    [req.params.id, b.invoice_no, jobId, b.client || null, b.issue_date || null, b.due_date || null, S.round2(b.amount), b.notes || null, !!b.void]);
  res.json(rows[0]);
}));
app.delete('/api/invoices/:id', wrap(async (req, res) => { await q('DELETE FROM invoices WHERE id=$1', [req.params.id]); res.json({ ok: true }); }));
// Upload the invoice app's "Export backup" file(s).
app.post('/api/invoices/import-backup', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  let data;
  try { data = JSON.parse(req.file.buffer.toString('utf8')); } catch { return res.status(400).json({ error: 'That isn\'t a backup file (JSON).' }); }
  if (!Array.isArray(data.invoices) && !Array.isArray(data.estimates)) return res.status(400).json({ error: 'That isn\'t a LuxCraft invoices or estimates backup.' });
  const r = await IMP.importInvoiceApp({ invoices: data.invoices || [], estimates: data.estimates || [] }, 'invoice-app');
  await SEC.audit('import.invoice-backup', JSON.stringify(r), ip(req));
  res.json(r);
}));
app.get('/api/estimates', wrap(async (req, res) => res.json(await S.listEstimates())));

// ---------- jobs, crew, time ----------
app.get('/api/jobs', wrap(async (req, res) => res.json(await S.listJobs())));
app.post('/api/jobs', wrap(async (req, res) => {
  if (!req.body.name) return res.status(400).json({ error: 'Job name is required' });
  res.json(await S.upsertJob({ ...req.body, id: undefined }));
}));
app.put('/api/jobs/:id', wrap(async (req, res) => res.json(await S.upsertJob({ ...req.body, id: Number(req.params.id) }))));
app.delete('/api/jobs/:id', wrap(async (req, res) => { await q('DELETE FROM jobs WHERE id=$1', [req.params.id]); res.json({ ok: true }); }));
app.get('/api/workers', wrap(async (req, res) => res.json((await q('SELECT * FROM workers ORDER BY id')).rows)));
app.post('/api/workers', wrap(async (req, res) => {
  const b = req.body;
  const { rows } = await q(`INSERT INTO workers (name, role, rate, active) VALUES ($1,$2,$3,COALESCE($4,true))
    ON CONFLICT (name) DO UPDATE SET role=EXCLUDED.role, rate=EXCLUDED.rate, active=EXCLUDED.active RETURNING *`,
  [String(b.name).trim(), b.role === 'sub' ? 'sub' : 'helper', b.rate || null, b.active ?? true]);
  res.json(rows[0]);
}));
app.get('/api/time', wrap(async (req, res) => res.json(await S.listTimeEntries(req.query))));
app.post('/api/time', wrap(async (req, res) => res.json(await S.addTimeEntries(req.body.date, req.body.entries || [req.body]))));
app.delete('/api/time/:id', wrap(async (req, res) => { await q('DELETE FROM time_entries WHERE id=$1', [req.params.id]); res.json({ ok: true }); }));

// ---------- mileage ----------
app.get('/api/mileage', wrap(async (req, res) => res.json(await S.listMileage(req.query.year))));
app.post('/api/mileage', wrap(async (req, res) => res.json(await S.addMileage(req.body))));
app.delete('/api/mileage/:id', wrap(async (req, res) => { await q('DELETE FROM mileage WHERE id=$1', [req.params.id]); res.json({ ok: true }); }));

// ---------- daily logs ----------
app.get('/api/daily-logs', wrap(async (req, res) => {
  const days = Math.min(Number(req.query.days) || 30, 366);
  res.json((await q('SELECT * FROM daily_logs WHERE date > $1::date - $2::int ORDER BY date DESC', [S.todayISO(), days])).rows);
}));
app.put('/api/daily-logs/:date', wrap(async (req, res) => {
  const b = req.body; const nul = (v) => (v === '' || v === undefined ? null : v);
  const { rows } = await q(`INSERT INTO daily_logs (date, plan, goals, met, outcome, est_earned, hours) VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (date) DO UPDATE SET plan=EXCLUDED.plan, goals=EXCLUDED.goals, met=EXCLUDED.met, outcome=EXCLUDED.outcome,
      est_earned=EXCLUDED.est_earned, hours=EXCLUDED.hours, updated_at=now() RETURNING *`,
  [req.params.date, nul(b.plan), JSON.stringify(b.goals || []), nul(b.met), nul(b.outcome), nul(b.est_earned), nul(b.hours)]);
  res.json(rows[0]);
}));

// ---------- planned purchases ----------
app.post('/api/planned', wrap(async (req, res) => {
  const b = req.body;
  const { rows } = await q('INSERT INTO planned_purchases (item, kind, cost, business_pct, planned_date, note) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [b.item, b.kind || 'tools', b.cost, b.business_pct || 100, b.planned_date || null, b.note || null]);
  res.json(rows[0]);
}));
app.put('/api/planned/:id', wrap(async (req, res) => {
  const b = req.body;
  const { rows } = await q(`UPDATE planned_purchases SET item=$2, kind=$3, cost=$4, business_pct=$5, planned_date=$6, status=$7, note=$8 WHERE id=$1 RETURNING *`,
    [req.params.id, b.item, b.kind, b.cost, b.business_pct, b.planned_date || null, b.status || 'planned', b.note || null]);
  res.json(rows[0]);
}));
app.delete('/api/planned/:id', wrap(async (req, res) => { await q('DELETE FROM planned_purchases WHERE id=$1', [req.params.id]); res.json({ ok: true }); }));

// ---------- bank / card statements ----------
app.post('/api/bank/import', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  if (SEC.sniffType(req.file.buffer, req.file.mimetype, req.file.originalname) !== 'text/csv') return res.status(400).json({ error: 'Upload a .csv statement export.' });
  const r = await IMP.importBankCsv(req.file.buffer.toString('utf8'), String(req.body.account || '').slice(0, 40));
  await SEC.audit('import.bank-csv', JSON.stringify(r), ip(req));
  res.json(r);
}));
app.get('/api/bank/rows', wrap(async (req, res) => {
  const { rows } = await q(`SELECT b.*, t.category AS tx_category, t.party AS tx_party FROM bank_rows b LEFT JOIN transactions t ON t.id=b.tx_id
    WHERE ($1::text IS NULL OR b.status=$1) ORDER BY b.date DESC, b.id DESC LIMIT 500`, [req.query.status || null]);
  res.json(rows);
}));
app.post('/api/bank/decide', wrap(async (req, res) => res.json(await IMP.applyBankDecisions(req.body.rows || []))));
app.post('/api/bank/rematch', wrap(async (req, res) => res.json({ matched: await IMP.autoMatch() })));

// ---------- agents ----------
const agentGuard = (req, res, next) => (A.AGENTS[req.params.id] ? next() : res.status(404).json({ error: 'Unknown agent' }));
app.get('/api/agents/:id/messages', agentGuard, wrap(async (req, res) => res.json(await A.history(req.params.id))));
app.post('/api/agents/:id/message', agentGuard, aiLimit, wrap(async (req, res) => {
  const text = String(req.body.text || '').trim().slice(0, 8000);
  if (!text) return res.status(400).json({ error: 'Empty message' });
  res.json(await A.respond(req.params.id, text));
}));
app.post('/api/agents/:id/opener', agentGuard, aiLimit, wrap(async (req, res) => res.json(await A.opener(req.params.id))));
app.delete('/api/agents/:id/messages', agentGuard, wrap(async (req, res) => { await q('DELETE FROM agent_messages WHERE agent=$1', [req.params.id]); res.json({ ok: true }); }));
app.put('/api/agents/:id/config', agentGuard, wrap(async (req, res) => {
  const s = await getSettings(); const agents = s.agents || {};
  const b = req.body || {};
  agents[req.params.id] = { ...(agents[req.params.id] || {}),
    ...(b.name ? { name: String(b.name).slice(0, 30) } : {}), ...(b.voice !== undefined ? { voice: String(b.voice).slice(0, 80) } : {}),
    ...(b.style !== undefined ? { style: String(b.style).slice(0, 200) } : {}) };
  await q(`INSERT INTO settings (key, value) VALUES ('agents',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify(agents)]);
  res.json(agents[req.params.id]);
}));

// ---------- approvals ----------
app.get('/api/proposals', wrap(async (req, res) => {
  const { rows } = await q(`SELECT * FROM proposals WHERE ($1::text IS NULL OR status=$1) ORDER BY id DESC LIMIT 200`, [req.query.status || null]);
  res.json(rows);
}));
app.post('/api/proposals/:id/:decision(approve|reject)', wrap(async (req, res) => {
  const r = await A.decide(Number(req.params.id), req.params.decision === 'approve');
  await SEC.audit(`proposal.${r.status}`, `#${r.id} ${r.summary}`, ip(req));
  res.json(r);
}));
app.post('/api/proposals/decide-many', wrap(async (req, res) => {
  const out = [];
  for (const id of (req.body.ids || []).map(Number)) {
    const r = await A.decide(id, !!req.body.approve);
    await SEC.audit(`proposal.${r.status}`, `#${r.id} ${r.summary}`, ip(req));
    out.push(r);
  }
  res.json(out);
}));

// ---------- shared memory ----------
app.get('/api/facts', wrap(async (req, res) => res.json((await q('SELECT * FROM facts ORDER BY id')).rows)));
app.post('/api/facts', wrap(async (req, res) => {
  const t = String(req.body.text || '').trim().slice(0, 500);
  if (!t) return res.status(400).json({ error: 'Empty' });
  res.json((await q('INSERT INTO facts (text, agent) VALUES ($1, $2) RETURNING *', [t, 'you'])).rows[0]);
}));
app.delete('/api/facts/:id', wrap(async (req, res) => { await q('DELETE FROM facts WHERE id=$1', [req.params.id]); res.json({ ok: true }); }));

// ---------- knowledge folders ----------
const docAgents = [...A.AGENT_IDS, 'shared'];
app.get('/api/docs', wrap(async (req, res) => res.json(await F.listDocs(req.query.agent))));
app.post('/api/docs/:agent', aiLimit, upload.single('file'), wrap(async (req, res) => {
  if (!docAgents.includes(req.params.agent)) return res.status(404).json({ error: 'Unknown folder' });
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const doc = await F.addDoc(req.params.agent, req.file, req.body.note, AI.describeImage);
  await SEC.audit('doc.upload', `${req.params.agent}: ${doc.filename}`, ip(req));
  res.json(doc);
}));
app.delete('/api/docs/:id', wrap(async (req, res) => { await F.deleteDoc(Number(req.params.id)); await SEC.audit('doc.delete', `#${req.params.id}`, ip(req)); res.json({ ok: true }); }));

// ---------- voice ----------
app.post('/api/tts', aiLimit, wrap(async (req, res) => {
  const cfg = await A.agentConfig();
  const a = cfg[req.body.agent] || cfg.home;
  const wav = await TTS.synthesize(req.body.text, a.voice, a.style || null);
  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(wav);
}));

// ---------- settings & categories ----------
const USER_SETTING_KEYS = ['business_name', 'business_city', 'vehicle_method', 'default_markup_pct', 'daily_target', 'goal_monthly_revenue',
  'mileage_rates', 'ss_wage_base', 'threshold_1099', 'filing_status', 'other_income', 'apply_qbi', 'tax_tables', 'ohio_bid', 'ohio_business_rate',
  'school_district_rate', 'city_rate', 'use_tax_rate', 'home_office_sqft', 'home_office_method'];
app.put('/api/settings', wrap(async (req, res) => {
  for (const [k, v] of Object.entries(req.body || {})) {
    if (!USER_SETTING_KEYS.includes(k)) continue;
    await q('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [k, typeof v === 'string' ? v : JSON.stringify(v)]);
  }
  res.json(await getSettings());
}));
app.post('/api/categories', wrap(async (req, res) => {
  const b = req.body;
  const { rows } = await q('INSERT INTO categories (name, kind, sched_c, note, sort) VALUES ($1,$2,$3,$4,60) RETURNING *',
    [String(b.name).trim(), b.kind === 'income' ? 'income' : 'expense', b.sched_c || (b.kind === 'income' ? 'L1' : 'L27a'), b.note || null]);
  res.json(rows[0]);
}));
app.put('/api/categories/:id', wrap(async (req, res) => {
  const b = req.body;
  const { rows } = await q('UPDATE categories SET sched_c=COALESCE($2,sched_c), note=COALESCE($3,note), active=COALESCE($4,active) WHERE id=$1 RETURNING *',
    [req.params.id, b.sched_c || null, b.note ?? null, b.active ?? null]);
  res.json(rows[0]);
}));

// ---------- security ----------
const pending2fa = new Map(); // session id → secret awaiting confirmation
app.get('/api/security', wrap(async (req, res) => {
  const [sessions, tokens, auditRows] = await Promise.all([
    q(`SELECT id, created_at, last_seen, ip, user_agent FROM sessions WHERE NOT revoked AND expires_at > now() ORDER BY last_seen DESC`),
    q(`SELECT id, label, scope, origin, last_used, created_at FROM api_tokens WHERE NOT revoked ORDER BY id`),
    q(`SELECT at, event, detail, ip FROM audit_log ORDER BY id DESC LIMIT 60`),
  ]);
  const rec = await getSecret('recovery');
  res.json({
    two_factor: !!(await SEC.twoFactor()), recovery_left: rec ? JSON.parse(SEC.decryptText(rec)).length : 0,
    password_strength: PASSWORD.length >= 16 ? 'strong' : PASSWORD.length >= 12 ? 'ok' : 'weak',
    https: req.secure, sessions: sessions.rows.map((s) => ({ ...s, current: s.id === req.sessionRow.id, id: s.id.slice(0, 8) })),
    tokens: tokens.rows, audit: auditRows.rows,
  });
}));
app.post('/api/security/2fa/setup', wrap(async (req, res) => {
  const secret = SEC.newTotpSecret();
  pending2fa.set(req.sessionRow.id, secret);
  const s = await getSettings();
  const label = encodeURIComponent(`${s.business_name || 'LuxCraft'} Cockpit`);
  const uri = `otpauth://totp/${label}?secret=${secret}&issuer=${label}&algorithm=SHA1&digits=6&period=30`;
  res.json({ secret, uri, qr: await QR.toString(uri, { type: 'svg', margin: 1, width: 200 }) });
}));
app.post('/api/security/2fa/enable', wrap(async (req, res) => {
  const secret = pending2fa.get(req.sessionRow.id);
  if (!secret || !SEC.verifyTotp(secret, req.body.code)) return res.status(400).json({ error: 'That code didn\'t match. Check the time on your phone and try again.' });
  pending2fa.delete(req.sessionRow.id);
  const { codes, hashes } = SEC.makeRecoveryCodes();
  await setSecret('totp', SEC.encryptText(secret));
  await setSecret('recovery', SEC.encryptText(JSON.stringify(hashes)));
  await SEC.audit('2fa.enabled', null, ip(req));
  res.json({ ok: true, recovery_codes: codes });
}));
app.post('/api/security/2fa/disable', wrap(async (req, res) => {
  const secret = await SEC.twoFactor();
  if (!secret || !SEC.verifyTotp(secret, req.body.code)) return res.status(400).json({ error: 'Enter a current code from your authenticator to turn 2FA off.' });
  await setSecret('totp', null); await setSecret('recovery', null);
  await SEC.audit('2fa.disabled', null, ip(req));
  res.json({ ok: true });
}));
app.post('/api/security/sessions/revoke-others', wrap(async (req, res) => {
  const { rowCount } = await q('UPDATE sessions SET revoked=true WHERE id<>$1 AND NOT revoked', [req.sessionRow.id]);
  await SEC.audit('sessions.revoked', `${rowCount} other sessions`, ip(req));
  res.json({ revoked: rowCount });
}));
app.post('/api/security/tokens', wrap(async (req, res) => {
  const scope = ['invoice-app', 'leads'].includes(req.body.scope) ? req.body.scope : null;
  if (!scope) return res.status(400).json({ error: 'Unknown scope' });
  let origin = null;
  if (req.body.origin) { try { origin = new URL(req.body.origin).origin; } catch { return res.status(400).json({ error: 'Enter the app address, like https://luxcraft-invoices.up.railway.app' }); } }
  const token = await SEC.createToken(String(req.body.label || scope).slice(0, 60), scope, origin);
  await SEC.audit('token.created', `${scope} ${origin || ''}`, ip(req));
  res.json({ token });
}));
app.delete('/api/security/tokens/:id', wrap(async (req, res) => {
  await q('UPDATE api_tokens SET revoked=true WHERE id=$1', [req.params.id]);
  await SEC.audit('token.revoked', `#${req.params.id}`, ip(req));
  res.json({ ok: true });
}));

// ---------- exports ----------
const csvCell = (v) => { if (v === null || v === undefined) return ''; let s = String(v); if (/^[=+\-@]/.test(s)) s = `'${s}`; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const sendCsv = (res, name, header, rows) => {
  res.setHeader('Content-Type', 'text/csv'); res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send([header.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n'));
};
app.get('/api/export/transactions.csv', wrap(async (req, res) => {
  const y = Number(req.query.year) || new Date().getFullYear();
  const rows = await S.listTransactions({ from: `${y}-01-01`, to: `${y}-12-31`, limit: 5000 });
  const cats = Object.fromEntries((await q('SELECT name, sched_c FROM categories')).rows.map((c) => [c.name, c.sched_c]));
  sendCsv(res, `ledger-${y}.csv`, ['Date', 'Type', 'Amount', 'Category', 'Schedule C', 'Job', 'Party', 'Method', 'Check #', 'Invoice #', 'Sales tax', 'Billable', 'Memo'],
    rows.reverse().map((t) => [t.date, t.kind, t.amount, t.category, S.LINE_LABELS[cats[t.category]] || '', t.job_name, t.party, t.method, t.check_no, t.invoice_no, t.sales_tax, t.billable ? 'yes' : '', t.memo]));
}));
app.get('/api/export/tax.csv', wrap(async (req, res) => {
  const t = await S.taxSummary(req.query.year);
  const rows = [['Gross receipts', '', t.income.gross_receipts], ['Cost of goods sold (materials)', '', t.income.cogs], ['Other income', '', t.income.other_income], ['Gross income', '', t.income.gross_income]];
  for (const l of t.expense_lines) for (const c of l.categories) rows.push([l.label, c.category, c.amount]);
  rows.push(['Total expenses', '', t.total_expenses], ['Tentative profit (L29)', '', t.tentative_profit], ['Home office (L30)', `${t.home_office.sqft} sq ft`, t.home_office.deduction],
    ['Net profit (L31)', '', t.net_profit], ['Business miles', '', t.mileage.miles], ['Estimated SE tax', '', t.estimate.se_tax], ['Estimated payments made', '', t.estimate.paid],
    ['Sales tax paid on purchases', '', t.sales_use_tax.sales_tax_paid], ['Untaxed purchases (use tax?)', '', t.sales_use_tax.untaxed_purchases]);
  for (const p of t.contractors_1099.payees) rows.push(['Subcontractor paid', p.payee, p.total]);
  sendCsv(res, `tax-summary-${t.year}.csv`, ['Line', 'Detail', 'Amount'], rows);
}));
app.get('/api/export/mileage.csv', wrap(async (req, res) => {
  const y = Number(req.query.year) || new Date().getFullYear();
  const rows = await S.listMileage(y);
  sendCsv(res, `mileage-${y}.csv`, ['Date', 'Miles', 'Job', 'Purpose', 'Rate', 'Deduction'], rows.reverse().map((m) => [m.date, m.miles, m.job_name, m.purpose, m.rate, m.deduction]));
}));
app.get('/api/export/time.csv', wrap(async (req, res) => {
  const y = Number(req.query.year) || new Date().getFullYear();
  const rows = await S.listTimeEntries({ from: `${y}-01-01`, to: `${y}-12-31` });
  sendCsv(res, `hours-${y}.csv`, ['Date', 'Worker', 'Job', 'Hours', 'Est. earned', 'Note'], rows.reverse().map((t) => [t.date, t.worker, t.job_name, t.hours, t.est_earned, t.note]));
}));
app.get('/api/export/backup.json', wrap(async (req, res) => {
  const tables = ['settings', 'categories', 'jobs', 'workers', 'invoices', 'estimates', 'transactions', 'mileage', 'time_entries', 'daily_logs', 'planned_purchases', 'facts'];
  const out = { app: 'luxcraft-cockpit', exported_at: new Date().toISOString() };
  for (const t of tables) out[t] = (await q(`SELECT * FROM ${t}${t === 'settings' ? " WHERE key NOT LIKE 'secret_%'" : ''}`)).rows;
  await SEC.audit('export.backup', null, ip(req));
  res.setHeader('Content-Disposition', `attachment; filename="cockpit-backup-${S.todayISO()}.json"`);
  res.json(out);
}));

// ---------- errors & static ----------
app.use('/api', (err, req, res, next) => {
  const status = err.status && err.status < 600 ? err.status : err.code === 'LIMIT_FILE_SIZE' ? 413 : 500;
  if (status >= 500) console.error(err);
  const msg = err.code === '23505' ? 'That already exists (duplicate).' : err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (20 MB max).'
    : status >= 500 && !err.expose && !/ANTHROPIC|GEMINI|Voice|read/.test(err.message) ? 'Something went wrong on the server.' : err.message;
  res.status(status).json({ error: msg });
});
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'], setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
migrate().then(() => app.listen(PORT, () => console.log(`LuxCraft Cockpit listening on :${PORT}`)))
  .catch((e) => { console.error('Database setup failed:', e); process.exit(1); });
