/* Makes the LuxCraft invoice & estimate app save to the Cockpit's database instead of this browser.
   The app's own code is untouched: it still calls localStorage, and this file answers those calls for its two
   data keys from the copy the server loaded (window.__LC_BOOKS), then saves every change back to the server.
   Everything else in localStorage behaves normally. */
(function () {
  const KEYS = ['luxcraft.invoices.v1', 'luxcraft.estimates.v1'];
  const boot = window.__LC_BOOKS;
  if (!boot || !boot.ok) {
    // Not signed in (or the server is unreachable): send the user to the Cockpit login instead of letting the app
    // start empty and overwrite real data.
    document.documentElement.style.visibility = 'hidden';
    location.replace('/');
    throw new Error('Cockpit login required');
  }
  const LIST = { 'luxcraft.invoices.v1': 'invoices', 'luxcraft.estimates.v1': 'estimates' };
  const mem = {}; const version = {}; const base = {};
  for (const k of KEYS) { mem[k] = boot.data[k] ? JSON.stringify(boot.data[k].value) : null; version[k] = boot.data[k] ? boot.data[k].version : 0; base[k] = mem[k]; }
  // Which records this window changed or deleted since its last save, so another window's edits are never overwritten.
  function diff(k, value) {
    const list = LIST[k]; const before = base[k] ? (JSON.parse(base[k])[list] || []) : [];
    const old = new Map(before.filter((r) => r && r.id).map((r) => [r.id, JSON.stringify(r)]));
    const now = ((value && value[list]) || []).filter((r) => r && r.id);
    const ids = new Set(now.map((r) => r.id));
    return { changed: now.filter((r) => old.get(r.id) !== JSON.stringify(r)).map((r) => r.id), deleted: [...old.keys()].filter((id) => !ids.has(id)) };
  }

  const proto = Storage.prototype;
  const _get = proto.getItem; const _set = proto.setItem; const _remove = proto.removeItem;
  const ours = (store, k) => store === window.localStorage && KEYS.includes(k);
  proto.getItem = function (k) { return ours(this, k) ? mem[k] : _get.call(this, k); };
  proto.setItem = function (k, v) {
    if (!ours(this, k)) return _set.call(this, k, v);
    v = String(v);
    if (mem[k] === v) return;
    mem[k] = v; queue(k);
  };
  proto.removeItem = function (k) { if (!ours(this, k)) return _remove.call(this, k); mem[k] = null; queue(k); };

  // ---------- saving ----------
  const timers = {}; const inflight = {}; const dirty = {};
  function queue(k) { dirty[k] = true; clearTimeout(timers[k]); timers[k] = setTimeout(() => save(k), 600); badge('saving'); }
  async function save(k, { keepalive = false } = {}) {
    if (!dirty[k]) return;
    if (inflight[k]) { timers[k] = setTimeout(() => save(k), 300); return; }
    dirty[k] = false; inflight[k] = true;
    const sent = mem[k];
    const value = sent === null ? null : JSON.parse(sent);
    const body = JSON.stringify({ value, version: version[k], ...diff(k, value) });
    try {
      const res = await fetch('/api/books/' + encodeURIComponent(k), {
        method: 'PUT', credentials: 'same-origin', keepalive: keepalive && body.length < 60000,
        headers: { 'Content-Type': 'application/json', 'x-cockpit': '1' }, body,
      });
      if (res.status === 401) { badge('login'); dirty[k] = true; return; }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
      version[k] = data.version;
      // The baseline is what THIS window last saved, so its next save sends only its own new edits.
      base[k] = sent;
      if (data.merged) badge('merged');
      else badge(Object.values(dirty).some(Boolean) ? 'saving' : 'saved');
      try { window.parent && window.parent !== window && window.parent.postMessage({ type: 'lc-books-saved', key: k, summary: data.summary || null }, location.origin); } catch (e) {}
    } catch (e) {
      dirty[k] = true; badge('error', e.message);
      clearTimeout(timers[k]); timers[k] = setTimeout(() => save(k), 5000);
    } finally { inflight[k] = false; }
  }
  const flush = () => KEYS.forEach((k) => { if (dirty[k]) { clearTimeout(timers[k]); save(k, { keepalive: true }); } });
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  window.addEventListener('beforeunload', (e) => { if (KEYS.some((k) => dirty[k] || inflight[k])) { flush(); e.preventDefault(); e.returnValue = ''; } });

  // ---------- a small save indicator (bottom-left) ----------
  let el = null; let hideT = null;
  function badge(state, detail) {
    if (!el) {
      if (!document.body) { document.addEventListener('DOMContentLoaded', () => badge(state, detail), { once: true }); return; }
      el = document.createElement('div');
      el.setAttribute('role', 'status');
      el.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:9999;font:600 12px/1.2 system-ui,sans-serif;padding:6px 10px;border-radius:8px;background:#1d1f1b;color:#ece6d7;opacity:.92;pointer-events:none;transition:opacity .3s';
      document.body.appendChild(el);
    }
    clearTimeout(hideT); el.style.opacity = '.92';
    const t = { saving: 'Saving to Cockpit…', saved: 'Saved to Cockpit ✓', merged: 'Saved · merged with changes from another window – reload to see them',
      error: "Couldn't save – retrying" + (detail ? ' (' + detail + ')' : ''), login: 'Signed out – open the Cockpit and log in again; your change will save then' }[state];
    el.textContent = t;
    el.style.background = state === 'error' || state === 'login' ? '#a4462a' : '#1d1f1b';
    if (state === 'saved') hideT = setTimeout(() => { el.style.opacity = '0'; }, 1800);
  }

  // The app's Backup box says data lives in this browser; now it lives in the Cockpit.
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('#view-settings .note').forEach((n) => {
      if (/stored in this browser/i.test(n.textContent)) n.textContent = 'Saved automatically to your LuxCraft Cockpit, so it is the same on every device. Export a backup any time to keep your own copy; Import backup brings in invoices from the old standalone app.';
    });
  });
})();
