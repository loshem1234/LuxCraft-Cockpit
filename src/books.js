// Storage for the built-in invoice & estimate app. The app saves its whole data set (exactly as it would to the
// browser) and every save refreshes the Cockpit: invoices, estimates, projects, draws, ledger, taxes, agents.
const crypto = require('crypto');
const { q, pool } = require('./db');
const IMP = require('./importers');

const KEYS = { 'luxcraft.invoices.v1': 'invoices', 'luxcraft.estimates.v1': 'estimates' };
const isKey = (k) => Object.prototype.hasOwnProperty.call(KEYS, k);

async function loadAll() {
  const { rows } = await q('SELECT key, value, version, updated_at FROM books');
  return Object.fromEntries(rows.map((r) => [r.key, { value: r.value, version: r.version, updated_at: r.updated_at }]));
}

// Two windows saving at once: keep every record from both, the newer edit of each winning.
function mergeLists(server, incoming, listKey) {
  const out = { ...(server || {}), ...(incoming || {}) };
  const byId = new Map();
  for (const r of (server && server[listKey]) || []) if (r && r.id) byId.set(r.id, r);
  for (const r of (incoming && incoming[listKey]) || []) {
    if (!r || !r.id) continue;
    const cur = byId.get(r.id);
    if (!cur || String(r.updatedAt || '') >= String(cur.updatedAt || '')) byId.set(r.id, r);
  }
  out[listKey] = [...byId.values()].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return out;
}

const fingerprint = (v, listKey) => crypto.createHash('sha256').update(JSON.stringify((v && v[listKey]) || [])).digest('hex');

// Remember the day an invoice flips to Paid (and forget it if it's flipped back), so its payment gets a real date.
async function notePaidMarks(client, before, after) {
  const was = new Map(((before && before.invoices) || []).map((r) => [r.id, r.status]));
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  for (const r of (after && after.invoices) || []) {
    if (!r || !r.id) continue;
    if (r.status === 'paid' && was.get(r.id) !== 'paid') await client.query('INSERT INTO paid_marks (record_id, paid_on) VALUES ($1,$2) ON CONFLICT (record_id) DO NOTHING', [r.id, today]);
    if (r.status !== 'paid' && was.get(r.id) === 'paid') await client.query('DELETE FROM paid_marks WHERE record_id=$1', [r.id]);
  }
}

let refreshing = Promise.resolve();
// Rebuild the Cockpit's view of invoices/estimates from the app's data. Runs one at a time.
function refresh() {
  refreshing = refreshing.then(async () => {
    const all = await loadAll();
    const inv = all['luxcraft.invoices.v1']?.value || {};
    const est = all['luxcraft.estimates.v1']?.value || {};
    return IMP.importInvoiceApp({ invoices: inv.invoices || [], estimates: est.estimates || [] }, 'invoice-app', { full: true });
  }).catch((e) => { console.error('Invoice app refresh failed:', e); return { error: e.message }; });
  return refreshing;
}

// Apply only what one window changed (its edited/new records and deletions) on top of the latest saved data.
function applyChanges(server, incoming, listKey, changed, deleted) {
  const out = { ...(server || {}), ...(incoming || {}) };
  const inc = new Map(((incoming && incoming[listKey]) || []).filter((r) => r && r.id).map((r) => [r.id, r]));
  const list = ((server && server[listKey]) || []).filter((r) => r && r.id && !deleted.includes(r.id)).map((r) => (changed.includes(r.id) && inc.get(r.id)) || r);
  const have = new Set(list.map((r) => r.id));
  for (const id of changed) if (!have.has(id) && inc.get(id)) list.push(inc.get(id));
  out[listKey] = list.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return out;
}

async function save(key, value, baseVersion, changes = null) {
  if (!isKey(key)) throw Object.assign(new Error('Unknown key'), { status: 404 });
  const listKey = KEYS[key];
  if (value !== null && (typeof value !== 'object' || Array.isArray(value))) throw Object.assign(new Error('Bad data'), { status: 400 });
  if (value && value[listKey] !== undefined && !Array.isArray(value[listKey])) throw Object.assign(new Error('Bad data'), { status: 400 });
  const client = await pool.connect();
  let merged = false; let finalValue = value; let version; let changed;
  try {
    await client.query('BEGIN');
    const cur = (await client.query('SELECT value, version FROM books WHERE key=$1 FOR UPDATE', [key])).rows[0];
    const curVersion = cur ? cur.version : 0;
    const hasDiff = changes && Array.isArray(changes.changed) && Array.isArray(changes.deleted);
    // Always apply just this window's edits on top of the latest saved data – never a wholesale replace.
    if (cur && value && hasDiff) finalValue = applyChanges(cur.value, value, listKey, changes.changed.map(String), changes.deleted.map(String));
    else if (cur && value && Number(baseVersion) !== curVersion) finalValue = mergeLists(cur.value, value, listKey);
    merged = !!(cur && value && Number(baseVersion) !== curVersion);
    changed = !cur || fingerprint(cur.value, listKey) !== fingerprint(finalValue, listKey);
    if (listKey === 'invoices') await notePaidMarks(client, cur && cur.value, finalValue);
    version = curVersion + 1;
    await client.query(`INSERT INTO books (key, value, version, updated_at) VALUES ($1,$2,$3,now())
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, version=EXCLUDED.version, updated_at=now()`, [key, JSON.stringify(finalValue), version]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  // Only invoice/estimate changes need the Cockpit refreshed (not settings or the draft being typed).
  const summary = changed ? await refresh() : null;
  return { version, merged, value: merged ? finalValue : undefined, summary };
}

// A change made from the Cockpit side (an approved fix by Clara): edit the saved invoice data directly, in one
// locked step, then rebuild every number. The Invoicing tab shows it the next time it loads.
async function edit(key, mutate) {
  if (!isKey(key)) throw Object.assign(new Error('Unknown key'), { status: 404 });
  const listKey = KEYS[key];
  const client = await pool.connect();
  let result; let version;
  try {
    await client.query('BEGIN');
    const cur = (await client.query('SELECT value, version FROM books WHERE key=$1 FOR UPDATE', [key])).rows[0];
    const before = cur ? cur.value : { [listKey]: [] };
    const value = JSON.parse(JSON.stringify(before));
    if (!Array.isArray(value[listKey])) value[listKey] = [];
    result = await mutate(value);
    if (listKey === 'invoices') await notePaidMarks(client, before, value);
    version = (cur ? cur.version : 0) + 1;
    await client.query(`INSERT INTO books (key, value, version, updated_at) VALUES ($1,$2,$3,now())
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, version=EXCLUDED.version, updated_at=now()`, [key, JSON.stringify(value), version]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  const summary = await refresh();
  return { ...(result || {}), version, refreshed: !(summary && summary.error) };
}

// A backup file exported from the invoice app (or the old standalone app): merged into the built-in app's data.
async function importBackup(data) {
  const all = await loadAll();
  let added = 0;
  for (const [key, listKey] of Object.entries(KEYS)) {
    if (!Array.isArray(data[listKey])) continue;
    const cur = all[key] ? all[key].value : null;
    const before = new Set(((cur && cur[listKey]) || []).map((r) => r && r.id));
    const merged = mergeLists(cur, { [listKey]: data[listKey] }, listKey);
    if (!merged.settings && data.settings) merged.settings = data.settings;
    added += merged[listKey].filter((r) => !before.has(r.id)).length;
    await q(`INSERT INTO books (key, value, version, updated_at) VALUES ($1,$2,1,now())
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, version=books.version+1, updated_at=now()`, [key, JSON.stringify(merged)]);
  }
  const r = await refresh();
  return { ...r, added };
}

module.exports = { loadAll, save, refresh, importBackup, edit, isKey, KEYS };
