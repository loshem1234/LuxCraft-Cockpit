/* LuxCraft Cockpit – core: utilities, API, modal, navigation, charts, login */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const state = { meta: null, tab: 'overview', sub: 'ledger', ledgerFilter: { period: 'ytd' }, taxYear: null, chartRange: '12m', charts: {}, pages: {} };

// ---------- utils ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n, dec = 2) => (n === null || n === undefined || isNaN(n) ? '—' : (n < 0 ? '−' : '') + '$' + Math.abs(Number(n)).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }));
const money0 = (n) => money(n, 0);
const pct = (n) => (n === null || n === undefined || !isFinite(n) ? '—' : `${(n * 100).toFixed(0)}%`);
const today = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const fmtDate = (d) => (d ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: d.slice(0, 4) === today().slice(0, 4) ? undefined : 'numeric' }) : '—');
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const cssVar = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const formData = (form) => {
  const o = Object.fromEntries(new FormData(form).entries());
  $$('input[type=checkbox][name]', form).forEach((cb) => { o[cb.name] = cb.checked; });
  return o;
};
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

// Minimal, safe markdown for agent replies: escape first, then bold/italic/links/bullets.
function md(text) {
  const lines = esc(text).split('\n');
  let html = ''; let inList = false;
  for (const raw of lines) {
    const m = raw.match(/^\s*(?:[-•*]|\d+\.)\s+(.*)$/);
    if (m) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${inline(m[1])}</li>`; continue; }
    if (inList) { html += '</ul>'; inList = false; }
    html += raw.trim() ? `<p>${inline(raw)}</p>` : '';
  }
  if (inList) html += '</ul>';
  return html;
  function inline(s) {
    return s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>')
      .replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }
}

async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: { 'x-cockpit': '1' }, credentials: 'same-origin' };
  if (opts.body instanceof FormData) init.body = opts.body;
  else if (opts.body !== undefined) { init.body = JSON.stringify(opts.body); init.headers['Content-Type'] = 'application/json'; }
  const res = await fetch(path, init);
  if (res.status === 401 && !path.startsWith('/api/auth')) { showLogin(); throw new Error('Please log in'); }
  if (opts.raw) { if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Request failed (${res.status})`); return res; }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) { const e = new Error(data.error || `Request failed (${res.status})`); e.data = data; throw e; }
  return data;
}
let toastTimer;
function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), bad ? 5000 : 2600);
}
const fail = (e) => { if (e && e.message !== 'Please log in') toast(e.message || String(e), true); };

// ---------- modal (no inline handlers: CSP blocks them) ----------
function openModal(html, onMount, { wide = false } = {}) {
  const m = $('#modal');
  m.className = 'modal' + (wide ? ' wide' : '');
  m.innerHTML = html;
  $('#modalWrap').classList.remove('hidden');
  onMount && onMount(m);
  const first = $('#modal input[name=amount]') || $('#modal input:not([type=hidden]):not([type=checkbox]), #modal select, #modal textarea');
  first && setTimeout(() => first.focus(), 50);
}
function closeModal() { $('#modalWrap').classList.add('hidden'); $('#modal').innerHTML = ''; }
$('#modalWrap').addEventListener('mousedown', (e) => { if (e.target.id === 'modalWrap') closeModal(); });
document.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeModal(); closeFab(); } });

// ---------- shared option builders ----------
const AWAITING = 'Invoiced – Awaiting Payment';
// The awaiting-payment category is managed by invoice sync, so it's only offered on rows that already use it.
const catOptions = (kind, sel) => state.meta.categories.filter((c) => c.active && (!kind || c.kind === kind) && (c.name !== AWAITING || sel === AWAITING))
  .map((c) => `<option ${c.name === sel ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
// With the "only invoices make jobs" rule, pickers list only jobs from invoices (plus whatever is already chosen).
const jobOptions = (sel, blank = 'No job') => `<option value="">${blank}</option>` + state.meta.jobs
  .filter((j) => (state.meta.rules || {}).jobs_source !== 'invoices_only' || j.from_invoices || String(j.id) === String(sel))
  .map((j) => `<option value="${j.id}" ${String(j.id) === String(sel) ? 'selected' : ''}>${esc(j.name)}${['complete', 'lost'].includes(j.status) ? ` (${j.status})` : ''}</option>`).join('');
const workerOptions = (sel) => state.meta.workers.filter((w) => w.active).map((w) => `<option ${w.name === (sel || 'Me') ? 'selected' : ''}>${esc(w.name)}</option>`).join('');
const METHODS = ['check', 'cash', 'card', 'ach', 'zelle', 'venmo', 'other'];
const methodOptions = (sel) => `<option value="">—</option>${METHODS.map((m) => `<option ${sel === m ? 'selected' : ''}>${m}</option>`).join('')}`;

function periodRange(p) {
  const t = today(); const y = Number(t.slice(0, 4)); const m = t.slice(0, 7);
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  switch (p) {
    case 'month': return { from: `${m}-01`, to: t };
    case 'lastmonth': return { from: iso(new Date(y, Number(t.slice(5, 7)) - 2, 1)), to: iso(new Date(y, Number(t.slice(5, 7)) - 1, 0)) };
    case '30': return { from: addDays(t, -29), to: t };
    case 'ytd': return { from: `${y}-01-01`, to: t };
    case 'lastyear': return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
    case '12m': return { from: addDays(t, -364).slice(0, 7) + '-01', to: t };
    case '24m': return { from: addDays(t, -729).slice(0, 7) + '-01', to: t };
    default: return {};
  }
}

// ---------- auth / boot ----------
function showLogin() { $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); $('#loginPw').focus(); }
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/auth/login', { method: 'POST', body: { password: $('#loginPw').value, code: $('#loginCode').value } });
    $('#loginErr').textContent = ''; $('#loginPw').value = ''; $('#loginCode').value = '';
    boot();
  } catch (err) {
    if (err.data && err.data.need_2fa) { $('#codeRow').classList.remove('hidden'); $('#loginCode').focus(); }
    $('#loginErr').textContent = err.message;
  }
});
$('#logoutBtn').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); showLogin(); });

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  lsSet('lc-theme', t);
  $('meta[name=theme-color]').content = t === 'light' ? '#f4f2ec' : '#121210';
  $('#themeBtn').textContent = t === 'light' ? '☾' : '☀';
}
applyTheme(lsGet('lc-theme', 'dark'));
$('#themeBtn').addEventListener('click', () => { applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'); render(); });

async function loadMeta() { state.meta = await api('/api/meta'); updateApprovalBadge(state.meta.pending_approvals); }
async function boot() {
  try {
    await loadMeta();
    $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
    const hash = location.hash.slice(1);
    if (hash) { const [tab, sub] = hash.split('/'); state.tab = tab; if (sub) state.sub = sub; }
    showTab(state.tab, false);
  } catch (e) { fail(e); }
}

// ---------- navigation ----------
const PAGE_AGENT = { overview: 'home', invoicing: 'financials', financials: 'financials', jobs: 'jobs', taxes: 'taxes', productivity: 'daily', settings: 'home' };
$('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) showTab(b.dataset.tab); });
$('#finSubtabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-sub]'); if (b) { state.sub = b.dataset.sub; showTab('financials'); } });
function showTab(tab, push = true) {
  if (!document.getElementById(`tab-${tab}`)) tab = 'overview';
  state.tab = tab;
  document.body.dataset.tab = tab;
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab').forEach((s) => s.classList.toggle('active', s.id === `tab-${tab}`));
  $$('#finSubtabs button').forEach((b) => b.classList.toggle('active', b.dataset.sub === state.sub));
  $$('#tab-financials .sub').forEach((s) => s.classList.toggle('active', s.id === `fin-${state.sub}`));
  if (push) history.replaceState(null, '', `#${tab}${tab === 'financials' ? '/' + state.sub : ''}`);
  window.scrollTo(0, 0);
  Drawer.setAgent(PAGE_AGENT[tab], tab === 'productivity');
  render();
}
function render() {
  const pages = state.pages;
  const r = tabRenderer();
  Promise.resolve(r && r()).catch(fail);
  function tabRenderer() {
    if (state.tab === 'financials') return pages[`fin-${state.sub}`];
    return pages[state.tab];
  }
}
async function refreshAfterChange() { await loadMeta(); render(); }
function wireGoTo(el) {
  $$('[data-go]', el).forEach((b) => b.addEventListener('click', () => showTab(b.dataset.go)));
  $$('[data-gosub]', el).forEach((b) => b.addEventListener('click', () => { state.sub = b.dataset.gosub; showTab('financials'); }));
}

// ---------- charts ----------
function chartTheme() {
  return { text: cssVar('--text-2'), muted: cssVar('--muted'), grid: cssVar('--line'), surface: cssVar('--surface'),
    income: cssVar('--income'), expense: cssVar('--expense'), profit: cssVar('--profit'), gold: cssVar('--gold'), warn: cssVar('--warn'), bad: cssVar('--bad') };
}
function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof a[k] === 'object' ? deepMerge(a[k], v) : v;
  return out;
}
function makeChart(id, config) {
  if (state.charts[id]) state.charts[id].destroy();
  const el = document.getElementById(id); if (!el || !window.Chart) return;
  const th = chartTheme();
  Chart.defaults.font.family = 'Archivo, system-ui, sans-serif';
  Chart.defaults.color = th.text;
  const base = {
    responsive: true, maintainAspectRatio: false, animation: { duration: 250 }, interaction: { mode: 'index', intersect: false },
    plugins: { legend: { display: false },
      tooltip: { backgroundColor: th.surface, titleColor: cssVar('--text'), bodyColor: th.text, borderColor: th.grid, borderWidth: 1, padding: 10,
        callbacks: { label: (c) => ` ${c.dataset.label}: ${money(c.parsed.y ?? c.parsed.x)}` } } },
    scales: { x: { grid: { display: false }, ticks: { color: th.muted }, border: { color: th.grid } },
      y: { grid: { color: th.grid }, border: { display: false }, ticks: { color: th.muted, callback: (v) => money0(v) } } },
  };
  state.charts[id] = new Chart(el, { ...config, options: deepMerge(base, config.options || {}) });
}
const barStyle = (color) => ({ backgroundColor: color, borderRadius: 4, borderSkipped: 'start', maxBarThickness: 28, borderWidth: 0 });
const monthLabel = (m) => new Date(m + '-15').toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
const legend = (items) => `<div class="legend">${items.map(([c, l]) => `<span><i style="background:${c}"></i>${l}</span>`).join('')}</div>`;
const miniTable = (head, rows) => `<div class="table-wrap" style="margin-top:8px;max-height:260px;overflow:auto"><table><thead><tr>${head.map((h, i) => `<th class="${i ? 'n' : ''}">${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td class="${i ? 'n' : ''}">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

// ---------- quick add ----------
function closeFab() { $('#fabMenu').classList.add('hidden'); $('#fab').classList.remove('open'); }
$('#fab').addEventListener('click', () => { $('#fabMenu').classList.toggle('hidden'); $('#fab').classList.toggle('open'); });
$('#fabMenu').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  closeFab();
  const k = b.dataset.quick;
  if (k === 'receipt') $('#receiptInput').click();
  else if (k === 'miles') mileageModal();
  else if (k === 'hours') hoursModal();
  else txModal({ kind: k, category: k === 'income' ? 'Contract Revenue' : 'Materials', method: k === 'income' ? 'check' : '' });
});

// ---------- approvals badge ----------
function updateApprovalBadge(n) {
  const b = $('#approvalsBtn');
  b.querySelector('b').textContent = n || '';
  b.classList.toggle('has', n > 0);
}
$('#approvalsBtn').addEventListener('click', () => openApprovals());
