/* LuxCraft Cockpit – agents: chat panels, approvals, voice */
const SUGGEST = {
  home: ['What needs my attention today?', "How's cash this month?", 'Summarize my week'],
  financials: ['Categorize my new bank rows', "What materials haven't I billed?", 'Who owes me money?', 'Log an expense: '],
  taxes: ['Am I on track with quarterly payments?', 'Should I buy the truck and trailer this year?', 'Does my garage qualify as a home office?', 'Which subs need a 1099?'],
  jobs: ['Help me price a bathroom remodel', 'Which jobs pay best per hour?', 'Is any job running over budget?', 'Which estimates should I follow up on?'],
  daily: ["Here's my plan for today: ", 'Yesterday went: ', 'Plan Jake\'s day: ', 'How many hours did I work this week?'],
};
const agentInfo = (id) => (state.meta && state.meta.agents[id]) || { name: id, title: '' };
const initials = (n) => String(n || '?').trim().slice(0, 1).toUpperCase();

// ---------- voice ----------
const Voice = {
  audio: null, url: null, speaking: null,
  stop() {
    if (this.audio) { this.audio.pause(); this.audio = null; }
    if (this.url) { URL.revokeObjectURL(this.url); this.url = null; }
    if (window.speechSynthesis) speechSynthesis.cancel();
    $$('.speak.on').forEach((b) => b.classList.remove('on'));
    this.speaking = null;
  },
  async speak(text, agent, btn) {
    const key = text;
    if (this.speaking === key) { this.stop(); return; }
    this.stop(); this.speaking = key; btn && btn.classList.add('on');
    const done = () => { if (this.speaking === key) { this.speaking = null; btn && btn.classList.remove('on'); } };
    try {
      if (state.meta.tts_enabled) {
        const res = await api('/api/tts', { method: 'POST', body: { text, agent }, raw: true });
        if (this.speaking !== key) return;
        this.url = URL.createObjectURL(await res.blob());
        this.audio = new Audio(this.url); this.audio.onended = done;
        await this.audio.play();
      } else if (window.speechSynthesis) {
        const u = new SpeechSynthesisUtterance(text.replace(/[*_#`]/g, '')); u.onend = done; speechSynthesis.speak(u);
      } else done();
    } catch (e) { done(); fail(e); }
  },
};

// ---------- proposals ----------
function proposalHtml(p) {
  const done = p.status !== 'pending';
  return `<div class="prop ${p.status}" data-pid="${p.id}">
    <div class="prop-sum">${esc(p.summary)}</div>
    ${done ? `<span class="chip ${p.status === 'approved' ? 'paid' : p.status === 'failed' ? 'overdue' : ''}">${p.status === 'approved' ? 'Approved' : p.status === 'failed' ? `Failed: ${esc(p.error || '')}` : 'Declined'}</span>`
    : `<div class="prop-btns"><button class="btn sm primary" data-decide="approve">Approve</button><button class="btn sm ghost" data-decide="reject">Decline</button></div>`}
  </div>`;
}
async function decideProposals(ids, approve) {
  const out = await api('/api/proposals/decide-many', { method: 'POST', body: { ids, approve } });
  const failed = out.filter((p) => p.status === 'failed');
  if (failed.length) toast(`Couldn't apply: ${failed[0].error}`, true);
  else toast(approve ? (ids.length > 1 ? `${ids.length} changes approved` : 'Approved') : 'Declined');
  await loadMeta();
  if (state.tab !== 'productivity') render(); else if (window.refreshTodayCard) refreshTodayCard();
  return out;
}
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-decide]'); if (!btn) return;
  const card = btn.closest('.prop'); const id = Number(card.dataset.pid);
  btn.disabled = true;
  try { const [p] = await decideProposals([id], btn.dataset.decide === 'approve'); card.outerHTML = proposalHtml(p); updateAllButtons(); }
  catch (err) { btn.disabled = false; fail(err); }
});
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-approve-all]'); if (!btn) return;
  const msg = btn.closest('.msg, .approvals');
  const ids = $$('.prop.pending', msg).map((c) => Number(c.dataset.pid));
  if (!ids.length) return;
  btn.disabled = true;
  try { const out = await decideProposals(ids, true); out.forEach((p) => { const c = $(`.prop[data-pid="${p.id}"]`, msg); if (c) c.outerHTML = proposalHtml(p); }); updateAllButtons(); }
  catch (err) { btn.disabled = false; fail(err); }
});
function updateAllButtons() { $$('[data-approve-all]').forEach((b) => { const scope = b.closest('.msg, .approvals'); b.classList.toggle('hidden', $$('.prop.pending', scope).length < 2); }); }

async function openApprovals() {
  const list = await api('/api/proposals?status=pending');
  const byAgent = {};
  list.forEach((p) => (byAgent[p.agent] ||= []).push(p));
  openModal(`<h2>Waiting for your approval</h2>
    <div class="approvals">${list.length ? Object.entries(byAgent).map(([a, ps]) => `<h3>${esc(agentInfo(a).name)} · ${esc(agentInfo(a).title)}</h3>${ps.map(proposalHtml).join('')}`).join('')
      + `<div class="foot"><button class="btn primary ${list.length < 2 ? 'hidden' : ''}" data-approve-all>Approve all ${list.length}</button></div>`
    : '<p class="note">Nothing waiting. When an agent suggests a change, it shows up here and in its chat.</p>'}</div>
    <div class="foot"><button class="btn" data-close>Close</button></div>`, null, { wide: true });
}

// ---------- chat component ----------
function Chat(root, agentId, { embedded = false } = {}) {
  const a = agentInfo(agentId);
  root.innerHTML = `
    <div class="chat-log" data-log></div>
    <div class="suggest">${(SUGGEST[agentId] || []).map((s) => `<button type="button" data-s="${esc(s)}">${esc(s.replace(/: $/, ''))}</button>`).join('')}</div>
    <form class="chat-input" data-form>
      <textarea rows="1" data-text placeholder="${state.meta.ai_enabled ? `Message ${esc(a.name)}…` : 'Add ANTHROPIC_API_KEY in Railway to enable the agents'}"></textarea>
      <button type="button" class="icon-btn mic" data-mic title="Speak">🎤</button>
      <button class="btn primary" ${state.meta.ai_enabled ? '' : 'disabled'}>Send</button>
    </form>`;
  const log = $('[data-log]', root); const ta = $('[data-text]', root); const form = $('[data-form]', root);
  const scroll = () => { log.scrollTop = log.scrollHeight; };
  const add = (m) => { const el = msgEl(m, agentId); log.appendChild(el); updateAllButtons(); return el; };
  const typing = (label) => { const t = document.createElement('div'); t.className = 'typing'; t.textContent = label; log.appendChild(t); scroll(); return t; };
  async function load() {
    const msgs = await api(`/api/agents/${agentId}/messages`);
    log.innerHTML = msgs.length ? '' : `<p class="note intro">${esc(a.name)} is your ${esc(a.title)}. Ask anything, or tell her what happened – she'll suggest the changes and you approve them.</p>`;
    msgs.forEach(add); scroll();
  }
  async function send(text) {
    if (!text.trim()) return;
    $('.intro', log)?.remove();
    add({ role: 'user', text, created_at: new Date().toISOString() }); scroll();
    const t = typing(`${a.name} is thinking…`);
    try {
      const reply = await api(`/api/agents/${agentId}/message`, { method: 'POST', body: { text } });
      t.remove(); const el = add(reply); scroll();
      if (reply.proposals) await loadMeta();
      if (lsGet('lc-autoread', false)) Voice.speak(reply.text, agentId, $('.speak', el));
    } catch (e) { t.remove(); fail(e); }
  }
  async function opener() {
    const t = typing(`${a.name} is getting your day ready…`);
    try {
      const r = await api(`/api/agents/${agentId}/opener`, { method: 'POST' });
      t.remove();
      if (!r.skipped) { $('.intro', log)?.remove(); const el = add(r); scroll(); if (lsGet('lc-autoread', false)) Voice.speak(r.text, agentId, $('.speak', el)); }
      return r.skipped ? r.message : r;
    } catch (e) { t.remove(); return null; }
  }
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(160, ta.scrollHeight) + 'px'; });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer:coarse)').matches) { e.preventDefault(); form.requestSubmit(); } });
  form.addEventListener('submit', (e) => { e.preventDefault(); const v = ta.value; ta.value = ''; ta.style.height = 'auto'; send(v); });
  $$('.suggest button', root).forEach((b) => b.addEventListener('click', () => {
    const s = b.dataset.s;
    if (s.endsWith(': ')) { ta.value = s; ta.focus(); } else send(s);
  }));
  setupMic($('[data-mic]', root), ta);
  return { load, send, opener, el: root };
}
function msgEl(m, agentId) {
  const d = document.createElement('div'); d.className = `msg ${m.role}${m.kind === 'briefing' ? ' briefing' : ''}`;
  const props = m.proposal_items || [];
  d.innerHTML = `<div class="md">${m.role === 'assistant' ? md(m.text) : esc(m.text)}</div>
    ${props.length ? `<div class="props">${props.map(proposalHtml).join('')}<button class="btn sm primary hidden" data-approve-all>Approve all</button></div>` : ''}
    ${m.sources && m.sources.length ? `<div class="sources">Sources: ${m.sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title || new URL(s.url).hostname)}</a>`).join(' · ')}</div>` : ''}
    <div class="meta-row"><time>${new Date(m.created_at).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</time>
    ${m.role === 'assistant' ? '<button class="speak" title="Read aloud">🔊</button>' : ''}</div>`;
  const sp = $('.speak', d); if (sp) sp.addEventListener('click', () => Voice.speak(m.text, agentId, sp));
  return d;
}
let recog = null;
function setupMic(btn, ta) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { btn.classList.add('hidden'); return; }
  btn.addEventListener('click', () => {
    if (recog) { recog.stop(); return; }
    recog = new SR(); recog.lang = 'en-US'; recog.interimResults = true; recog.continuous = true;
    const start = ta.value ? ta.value + ' ' : '';
    recog.onresult = (e) => { ta.value = start + [...e.results].map((r) => r[0].transcript).join(''); ta.dispatchEvent(new Event('input')); };
    recog.onend = () => { recog = null; btn.classList.remove('rec'); };
    recog.start(); btn.classList.add('rec');
  });
}

// ---------- side drawer (one per page) ----------
const Drawer = {
  agent: null, chat: null, loaded: {},
  open: lsGet('lc-drawer', window.innerWidth >= 1200),
  setAgent(id, hidden) {
    this.hidden = hidden;
    document.body.classList.toggle('drawer-open', this.open && !hidden);
    $('#drawer').classList.toggle('hidden', hidden || !this.open);
    const a = agentInfo(id);
    $('#askBtn').classList.toggle('hidden', hidden);
    $('#askBtn span').textContent = `Ask ${a.name}`;
    if (this.agent === id) return;
    this.agent = id;
    $('#drawerHead').innerHTML = `<span class="avatar">${initials(a.name)}</span><div><b>${esc(a.name)}</b><div class="note">${esc(a.title)}</div></div>`;
    if (hidden) return;
    this.chat = Chat($('#drawerBody'), id);
    if (this.open) this.chat.load().catch(fail);
    else this.needsLoad = true;
  },
  toggle(force) {
    this.open = force ?? !this.open;
    lsSet('lc-drawer', this.open);
    document.body.classList.toggle('drawer-open', this.open && !this.hidden);
    $('#drawer').classList.toggle('hidden', !this.open || this.hidden);
    if (this.open && this.needsLoad && this.chat) { this.needsLoad = false; this.chat.load().catch(fail); }
    if (this.open) setTimeout(() => $('#drawer textarea')?.focus(), 50);
    setTimeout(() => Object.values(state.charts).forEach((c) => c.resize && c.resize()), 260);
  },
  ask(text) { this.toggle(true); this.chat && this.chat.send(text); },
};
$('#askBtn').addEventListener('click', () => Drawer.toggle());
$('#drawerClose').addEventListener('click', () => Drawer.toggle(false));
$('#drawerClear').addEventListener('click', async () => {
  if (!confirm(`Clear your chat with ${agentInfo(Drawer.agent).name}? Approved changes and shared memory stay.`)) return;
  await api(`/api/agents/${Drawer.agent}/messages`, { method: 'DELETE' });
  Drawer.chat.load();
});
function syncAutoread() { const on = lsGet('lc-autoread', false); $$('.autoread').forEach((b) => { b.classList.toggle('on', on); b.title = on ? 'Reading replies aloud (click to turn off)' : 'Read replies aloud'; }); }
document.addEventListener('click', (e) => { if (e.target.closest('.autoread')) { lsSet('lc-autoread', !lsGet('lc-autoread', false)); syncAutoread(); if (!lsGet('lc-autoread', false)) Voice.stop(); } });
syncAutoread();
