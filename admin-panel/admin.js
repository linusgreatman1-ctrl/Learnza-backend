(function () {
  'use strict';

  const API = '/api/super';
  const TOKEN_KEY = 'lz_admin_token';
  const USER_KEY = 'lz_admin_user';
  const REFRESH_KEY = 'lz_admin_refresh';
  let token = sessionStorage.getItem(TOKEN_KEY);
  let refreshToken = sessionStorage.getItem(REFRESH_KEY);
  let me = JSON.parse(sessionStorage.getItem(USER_KEY) || 'null');

  const STATES = ['Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue', 'Borno', 'Cross River', 'Delta', 'Ebonyi', 'Edo', 'Ekiti', 'Enugu', 'FCT (Abuja)', 'Gombe', 'Imo', 'Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Kogi', 'Kwara', 'Lagos', 'Nasarawa', 'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo', 'Plateau', 'Rivers', 'Sokoto', 'Taraba', 'Yobe', 'Zamfara'];

  const $ = (id) => document.getElementById(id);
  const view = $('view');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtDate(d) { return d ? new Date(d).toLocaleDateString() : '—'; }
  function fmtDateTime(d) { return d ? new Date(d).toLocaleString() : '—'; }
  function naira(kobo) { return '₦' + (Number(kobo || 0) / 100).toLocaleString('en-NG', { maximumFractionDigits: 0 }); }
  function clip(text, n) { const t = String(text == null ? '' : text); return t.length > n ? t.slice(0, n) + '…' : t; }
  function tabs(host, names, onPick) {
    host.innerHTML = '<div class="tabs">' + names.map(([k, label], i) => '<button class="tab' + (i === 0 ? ' on' : '') + '" data-tab="' + k + '">' + esc(label) + '</button>').join('') + '</div><div class="tab-body"></div>';
    const body = host.querySelector('.tab-body');
    const pick = (k) => { host.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === k)); onPick(k, body); };
    host.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => pick(t.dataset.tab)));
    pick(names[0][0]);
  }

  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  function storeSession(data) {
    token = data.token;
    refreshToken = data.refreshToken;
    if (data.user) me = data.user;
    sessionStorage.setItem(TOKEN_KEY, token);
    sessionStorage.setItem(REFRESH_KEY, refreshToken);
    sessionStorage.setItem(USER_KEY, JSON.stringify(me));
  }

  // Access tokens last 15 minutes; on a 401 the refresh token is swapped for a new pair and
  // the request retried once. Simultaneous failures share a single refresh call.
  let refreshInFlight = null;
  function refreshSession() {
    if (!refreshInFlight) {
      refreshInFlight = fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      })
        .then(async (res) => {
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'Session expired.');
          storeSession(data);
        })
        .finally(() => { refreshInFlight = null; });
    }
    return refreshInFlight;
  }

  async function api(path, opts = {}) {
    const isForm = typeof FormData !== 'undefined' && opts.body instanceof FormData;
    const send = () => fetch((opts.base || API) + path, {
      method: opts.method || 'GET',
      headers: Object.assign(isForm ? {} : { 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
      body: opts.body ? (isForm ? opts.body : JSON.stringify(opts.body)) : undefined,
    });
    let res = await send();
    if (res.status === 401 && token) {
      if (refreshToken) {
        try { await refreshSession(); res = await send(); } catch { /* fall through to sign-out below */ }
      }
      if (res.status === 401) { logout(); throw new Error('Session expired. Please sign in again.'); }
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    return data;
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); } catch {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      ta.remove();
    }
    toast('Copied');
  }

  function modal(html) {
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal">${html}</div>`;
    document.body.appendChild(bg);
    const close = () => bg.remove();
    bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
    bg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
    return { el: bg.firstElementChild, close };
  }

  // ---------------- auth ----------------
  function showApp() {
    $('login-screen').classList.add('hidden');
    $('app-screen').classList.remove('hidden');
    $('nav-user-name').textContent = me ? me.fullName : '';
    go(location.hash.replace('#', '') || 'dashboard');
  }
  function logout() {
    if (refreshToken) {
      fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken }), keepalive: true }).catch(() => {});
    }
    token = null; me = null; refreshToken = null;
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(USER_KEY);
    sessionStorage.removeItem(REFRESH_KEY);
    $('app-screen').classList.add('hidden');
    $('login-screen').classList.remove('hidden');
  }

  $('pw-eye').addEventListener('click', () => {
    const input = $('password');
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('login-btn');
    $('login-error').textContent = '';
    btn.disabled = true;
    try {
      const data = await api('/login', { method: 'POST', body: { email: $('email').value.trim(), password: $('password').value } });
      storeSession(data);
      $('password').value = '';
      showApp();
    } catch (err) {
      $('login-error').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  $('logout-btn').addEventListener('click', logout);

  $('change-password-btn').addEventListener('click', () => {
    const m = modal(`
      <div class="modal-head"><h3>Change password</h3><button class="btn-ghost btn-sm" data-close>✕</button></div>
      <form id="cp-form">
        <label>Current password</label><input type="password" id="cp-current" required autocomplete="current-password">
        <label>New password (at least 8 characters)</label><input type="password" id="cp-new" required minlength="8" autocomplete="new-password">
        <div style="margin-top:16px"><button type="submit" class="btn-gold">Save</button></div>
      </form>`);
    m.el.querySelector('#cp-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const changed = await api('/change-password', { base: '/api/auth', method: 'POST', body: { currentPassword: m.el.querySelector('#cp-current').value, newPassword: m.el.querySelector('#cp-new').value } });
        if (changed.token) storeSession(changed); // every refresh token was retired; this is the replacement
        toast('Password changed');
        m.close();
      } catch (err) { toast(err.message); }
    });
  });

  // ---------------- navigation ----------------
  const views = {
    dashboard: renderDashboard, schools: renderSchools, users: renderUsers,
    announcements: renderAnnouncements, payments: renderPayments, ai: renderAi, live: renderLive,
    gamification: renderGamification, library: renderLibrary, settings: renderSettings,
    admins: renderAdmins, audit: renderAudit,
  };

  function go(name) {
    if (!views[name]) name = 'dashboard';
    location.hash = name;
    document.querySelectorAll('#nav li').forEach((li) => li.classList.toggle('active', li.dataset.view === name));
    view.innerHTML = '<p class="muted">Loading…</p>';
    views[name]().catch((err) => { view.innerHTML = `<p class="error-msg">${esc(err.message)}</p>`; });
  }
  $('nav').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-view]');
    if (li) go(li.dataset.view);
  });

  function pager(page, total, pageSize, onPage) {
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const div = document.createElement('div');
    div.className = 'pager';
    div.innerHTML = `<button class="btn-ghost btn-sm" ${page <= 1 ? 'disabled' : ''} data-p="-1">← Prev</button><span class="muted small">Page ${page} of ${pages} · ${total} total</span><button class="btn-ghost btn-sm" ${page >= pages ? 'disabled' : ''} data-p="1">Next →</button>`;
    div.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => onPage(page + Number(b.dataset.p))));
    return div;
  }

  function licencePill(licence) {
    if (licence === 'ACTIVE') return '<span class="pill ok">Active</span>';
    if (licence === 'EXPIRED') return '<span class="pill warn">Expired</span>';
    return '<span class="pill bad">Suspended</span>';
  }

  // ---------------- dashboard ----------------
  async function renderDashboard() {
    const d = await api('/dashboard');
    const stat = (n, l) => `<div class="stat"><div class="n">${n}</div><div class="l">${l}</div></div>`;
    view.innerHTML = `
      <div class="view-head"><div><h1>Dashboard</h1><div class="muted">Everything across the Learnza platform.</div></div>
        <button class="btn-gold" id="goto-onboard">+ Onboard a school</button></div>
      <h3>Schools</h3>
      <div class="cards">${stat(d.schools.total, 'Schools onboarded')}${stat(d.schools.active, 'Active licences')}${stat(d.schools.expired, 'Expired licences')}${stat(d.schools.suspended, 'Suspended')}</div>
      <h3>People</h3>
      <div class="cards">${stat(d.schoolUsers.students, 'School students')}${stat(d.schoolUsers.lecturers, 'Lecturers')}${stat(d.schoolUsers.staff, 'Non-academic staff')}${stat(d.schoolUsers.admins, 'School admins')}${stat(d.independentStudents, 'Independent students')}</div>
      <h3>This month</h3>
      <div class="cards">${stat(naira(d.activity.revenueThisMonthKobo), 'Subscription revenue')}${stat(d.activity.activeSubscriptions, 'Active subscriptions')}${stat(d.activity.aiQuestionsToday, 'AI questions today')}${stat(d.activity.liveNow, 'Live classes on now')}${stat(d.activity.newUsersToday, 'New users today')}</div>
      <h3>Recently onboarded</h3>
      <div class="table-wrap"><table><thead><tr><th>School</th><th>State</th><th>Onboarded</th></tr></thead><tbody>
        ${d.recentSchools.map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.state || '—')}</td><td>${fmtDate(s.createdAt)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No schools yet — onboard your first one.</td></tr>'}
      </tbody></table></div>`;
    $('goto-onboard').addEventListener('click', () => go('schools'));
  }

  // ---------------- schools ----------------
  async function renderSchools() {
    view.innerHTML = `
      <div class="view-head"><div><h1>Schools</h1><div class="muted">Schools are onboarded here — they cannot register themselves. Each gets a permanent Join Code to sign in with.</div></div></div>
      <div class="panel">
        <h3>Onboard a school</h3>
        <form id="onboard-form">
          <div class="row">
            <div style="flex:2"><label>School name *</label><input id="ob-name" required placeholder="e.g. University of Lagos"></div>
            <div><label>State</label><select id="ob-state"><option value="">Select…</option>${STATES.map((s) => `<option>${esc(s)}</option>`).join('')}</select></div>
          </div>
          <div class="row">
            <div style="flex:2"><label>Address</label><input id="ob-address" placeholder="Campus address"></div>
            <div><label>Contact phone</label><input id="ob-phone" type="tel"></div>
            <div><label>Contact email</label><input id="ob-email" type="email"></div>
          </div>
          <div class="row">
            <div><label>First admin's name (optional)</label><input id="ob-admin" placeholder="e.g. The Registrar"></div>
            <div style="flex:0 0 auto"><button type="submit" class="btn-gold" id="ob-btn">+ Onboard School</button></div>
          </div>
        </form>
        <div id="ob-result"></div>
      </div>
      <div class="toolbar"><input id="school-search" placeholder="Search schools…"></div>
      <div id="school-table"></div>`;

    $('onboard-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('ob-btn');
      btn.disabled = true;
      try {
        const { school, joinCode } = await api('/schools', { method: 'POST', body: {
          name: $('ob-name').value.trim(), state: $('ob-state').value, address: $('ob-address').value.trim(),
          contactPhone: $('ob-phone').value.trim(), contactEmail: $('ob-email').value.trim(), adminName: $('ob-admin').value.trim(),
        } });
        $('ob-result').innerHTML = `<div class="result-box"><strong>${esc(school.name)} created!</strong> Give the school this permanent Join Code — they sign in to the Schools app with their school name and this code.<span class="code">${esc(joinCode)}</span><button class="btn-ghost btn-sm" id="ob-copy">Copy code</button></div>`;
        $('ob-copy').addEventListener('click', () => copy(joinCode));
        $('onboard-form').reset();
        loadSchools();
      } catch (err) { toast(err.message); } finally { btn.disabled = false; }
    });

    let timer;
    $('school-search').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(loadSchools, 250); });
    await loadSchools();
  }

  async function loadSchools() {
    const box = $('school-table');
    if (!box) return;
    const { schools } = await api('/schools?search=' + encodeURIComponent($('school-search').value.trim()));
    box.innerHTML = `<div class="table-wrap"><table><thead><tr><th>School</th><th>State</th><th>Students</th><th>Lecturers</th><th>Depts</th><th>Join code</th><th>Licence</th><th>Expires</th></tr></thead><tbody>
      ${schools.map((s) => `<tr class="clickable" data-id="${s.id}"><td><strong>${esc(s.name)}</strong></td><td>${esc(s.state || '—')}</td><td class="tabular">${s.students}</td><td class="tabular">${s.lecturers}</td><td class="tabular">${s.departments}</td><td class="code">${esc(s.joinCode)}</td><td>${licencePill(s.licence)}</td><td>${fmtDate(s.subscriptionExpiresAt)}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">No schools yet.</td></tr>'}
    </tbody></table></div>`;
    box.querySelectorAll('tr.clickable').forEach((tr) => tr.addEventListener('click', () => openSchool(tr.dataset.id)));
  }

  async function openSchool(id) {
    const { school, counts, admins, recentUsers } = await api('/schools/' + id);
    const m = modal(`
      <div class="modal-head"><div><h3 style="margin:0">${esc(school.name)}</h3><div class="muted small">Onboarded ${fmtDate(school.createdAt)}</div></div><button class="btn-ghost btn-sm" data-close>✕</button></div>
      <div class="kv">
        <div class="k">Licence</div><div>${licencePill(school.licence)} · expires ${fmtDate(school.subscriptionExpiresAt)}</div>
        <div class="k">Join code</div><div><span class="code">${esc(school.joinCode)}</span> <button class="btn-ghost btn-sm" id="sc-copy">Copy</button> <button class="btn-ghost btn-sm" id="sc-regen">Issue a new code</button></div>
        <div class="k">People</div><div class="tabular">${counts.STUDENT || 0} students · ${counts.LECTURER || 0} lecturers · ${counts.STAFF || 0} staff · ${counts.ADMIN || 0} admin accounts</div>
        <div class="k">Departments</div><div class="tabular">${school._count.departments}</div>
        <div class="k">Other admins</div><div>${admins.map((a) => esc(a.fullName)).join(', ') || '<span class="muted">None added yet</span>'}</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px">
        <button class="btn-gold btn-sm" id="sc-renew">Renew +1 year</button>
        <button class="btn-ghost btn-sm" id="sc-status">${school.status === 'ACTIVE' ? 'Suspend school' : 'Reactivate school'}</button>
        <button class="btn-danger btn-sm" id="sc-delete">Delete…</button>
      </div>
      <h3>Edit details</h3>
      <form id="sc-edit">
        <div class="row">
          <div style="flex:2"><label>Name</label><input id="se-name" value="${esc(school.name)}" required></div>
          <div><label>State</label><select id="se-state"><option value="">—</option>${STATES.map((s) => `<option ${s === school.state ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></div>
        </div>
        <div class="row">
          <div style="flex:2"><label>Address</label><input id="se-address" value="${esc(school.address || '')}"></div>
          <div><label>Contact phone</label><input id="se-phone" value="${esc(school.contactPhone || '')}"></div>
          <div><label>Contact email</label><input id="se-email" value="${esc(school.contactEmail || '')}"></div>
        </div>
        <div style="margin-top:12px"><button type="submit" class="btn-sm">Save changes</button></div>
      </form>
      <h3 style="margin-top:20px">Recent people</h3>
      <div class="table-wrap"><table><tbody>${recentUsers.map((u) => `<tr><td>${esc(u.fullName)}</td><td>${esc(u.role)}</td><td>${esc(u.status)}</td><td>${fmtDate(u.createdAt)}</td></tr>`).join('') || '<tr><td class="muted">Nobody has been added yet.</td></tr>'}</tbody></table></div>`);
    const q = (sel) => m.el.querySelector(sel);

    q('#sc-copy').addEventListener('click', () => copy(school.joinCode));
    q('#sc-regen').addEventListener('click', async () => {
      if (!confirm('Issue a new join code? The old code stops working immediately, and the school admin must be given the new one.')) return;
      try { const r = await api(`/schools/${id}/regenerate-join-code`, { method: 'POST' }); toast('New join code: ' + r.joinCode); m.close(); loadSchools(); openSchool(id); } catch (err) { toast(err.message); }
    });
    q('#sc-renew').addEventListener('click', async () => {
      try { await api(`/schools/${id}/renew`, { method: 'POST' }); toast('Licence renewed for another year'); m.close(); loadSchools(); openSchool(id); } catch (err) { toast(err.message); }
    });
    q('#sc-status').addEventListener('click', async () => {
      const next = school.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
      if (next === 'SUSPENDED' && !confirm(`Suspend ${school.name}? Everyone at the school is signed out of access immediately.`)) return;
      try { await api(`/schools/${id}/status`, { method: 'PATCH', body: { status: next } }); toast(next === 'ACTIVE' ? 'School reactivated' : 'School suspended'); m.close(); loadSchools(); } catch (err) { toast(err.message); }
    });
    q('#sc-delete').addEventListener('click', async () => {
      const typed = prompt(`Only a school with no data in it can be deleted (otherwise suspend it).\n\nType the school name to confirm:\n${school.name}`);
      if (typed == null) return;
      try { await api(`/schools/${id}?confirm=${encodeURIComponent(typed)}`, { method: 'DELETE' }); toast('School deleted'); m.close(); loadSchools(); } catch (err) { toast(err.message); }
    });
    q('#sc-edit').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/schools/' + id, { method: 'PATCH', body: { name: q('#se-name').value.trim(), state: q('#se-state').value, address: q('#se-address').value.trim(), contactPhone: q('#se-phone').value.trim(), contactEmail: q('#se-email').value.trim() } });
        toast('Saved'); m.close(); loadSchools();
      } catch (err) { toast(err.message); }
    });
  }

  // ---------------- users ----------------
  async function renderUsers() {
    view.innerHTML = `
      <div class="view-head"><div><h1>Users</h1><div class="muted">Everyone on the platform, across all schools.</div></div></div>
      <div class="toolbar">
        <input id="u-search" placeholder="Search name or email…">
        <select id="u-role"><option value="">All roles</option><option>STUDENT</option><option>LECTURER</option><option>STAFF</option><option>ADMIN</option><option>SUPER_ADMIN</option></select>
        <label style="margin:0;font-weight:500"><input type="checkbox" id="u-indep" style="width:auto"> Independent students only</label>
      </div>
      <div id="u-table"></div>`;
    let page = 1;
    async function load() {
      const params = new URLSearchParams({ page: String(page) });
      if ($('u-search').value.trim()) params.set('search', $('u-search').value.trim());
      if ($('u-role').value) params.set('role', $('u-role').value);
      if ($('u-indep').checked) params.set('independent', 'true');
      const { users, total, pageSize } = await api('/users?' + params);
      const box = $('u-table');
      box.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>School</th><th>Status</th><th>Joined</th><th></th></tr></thead><tbody>
        ${users.map((u) => `<tr><td><strong>${esc(u.fullName)}</strong></td><td>${esc(u.email.endsWith('@internal.learnza.local') ? '(school join-code account)' : u.email)}</td><td>${esc(u.role)}</td><td>${esc(u.school ? u.school.name : (u.isIndividual ? 'Independent' : '—'))}</td><td><span class="pill ${u.status === 'ACTIVE' ? 'ok' : 'bad'}">${esc(u.status)}</span></td><td>${fmtDate(u.createdAt)}</td><td>${u.id === me.id ? '' : `<button class="btn-ghost btn-sm" data-toggle="${u.id}" data-to="${u.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE'}">${u.status === 'ACTIVE' ? 'Suspend' : 'Reactivate'}</button>`}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No users found.</td></tr>'}
      </tbody></table></div>`;
      box.appendChild(pager(page, total, pageSize, (p) => { page = p; load(); }));
      box.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
        try { await api(`/users/${b.dataset.toggle}/status`, { method: 'PATCH', body: { status: b.dataset.to } }); toast('Updated'); load(); } catch (err) { toast(err.message); }
      }));
    }
    let timer;
    $('u-search').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { page = 1; load(); }, 250); });
    $('u-role').addEventListener('change', () => { page = 1; load(); });
    $('u-indep').addEventListener('change', () => { page = 1; load(); });
    await load();
  }

  // ---------------- platform admins ----------------
  async function renderAdmins() {
    const { admins } = await api('/admins');
    view.innerHTML = `
      <div class="view-head"><div><h1>Platform Admins</h1><div class="muted">People who can sign in to this panel. Only a super admin can add another.</div></div></div>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Added</th></tr></thead><tbody>
        ${admins.map((a) => `<tr><td><strong>${esc(a.fullName)}</strong></td><td>${esc(a.email)}</td><td><span class="pill ${a.status === 'ACTIVE' ? 'ok' : 'bad'}">${esc(a.status)}</span></td><td>${fmtDate(a.createdAt)}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="panel" style="margin-top:20px">
        <h3>Add a platform admin</h3>
        <form id="adm-form"><div class="row">
          <div><label>Full name</label><input id="adm-name" required></div>
          <div><label>Email</label><input id="adm-email" type="email" required></div>
          <div><label>Password (8+ characters)</label><input id="adm-pw" type="password" required minlength="8" autocomplete="new-password"></div>
          <div style="flex:0 0 auto"><button type="submit" class="btn-gold">Add admin</button></div>
        </div></form>
      </div>`;
    $('adm-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/admins', { method: 'POST', body: { fullName: $('adm-name').value.trim(), email: $('adm-email').value.trim(), password: $('adm-pw').value } });
        toast('Admin added'); renderAdmins();
      } catch (err) { toast(err.message); }
    });
  }

  // ---------------- audit log ----------------
  async function renderAudit() {
    view.innerHTML = '<div class="view-head"><div><h1>Audit Log</h1><div class="muted">Every privileged action taken from this panel.</div></div></div><div id="a-table"></div>';
    let page = 1;
    async function load() {
      const { logs, total, pageSize } = await api('/audit-logs?page=' + page);
      const box = $('a-table');
      box.innerHTML = `<div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Details</th><th>IP</th></tr></thead><tbody>
        ${logs.map((l) => `<tr><td>${fmtDateTime(l.createdAt)}</td><td>${esc(l.actorEmail || '—')}</td><td><strong>${esc(l.action)}</strong></td><td>${esc(l.targetType || '')}</td><td class="small muted" style="white-space:normal;max-width:320px">${esc(l.metadata || '')}</td><td class="small">${esc(l.ip || '')}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Nothing recorded yet.</td></tr>'}
      </tbody></table></div>`;
      box.appendChild(pager(page, total, pageSize, (p) => { page = p; load(); }));
    }
    await load();
  }

  // ---------------- announcements ----------------
  async function renderAnnouncements() {
    const [{ schools }, list] = await Promise.all([api('/schools'), api('/announcements')]);
    const ch = list.channelsAvailable;
    view.innerHTML = `
      <div class="view-head"><div><h1>Announcements</h1><div class="muted">One message to a slice of the platform. It always arrives in the app as a notification; email and SMS are optional extras.</div></div></div>
      <div class="panel">
        <form id="an-form">
          <div class="row">
            <div><label>Send to</label><select id="an-aud">
              <option value="ALL">Everyone</option><option value="INDEPENDENT">Independent students</option>
              <option value="SCHOOLS">Everyone at schools</option><option value="SCHOOL">One school…</option></select></div>
            <div id="an-school-wrap" class="hidden" style="flex:2"><label>School</label><select id="an-school">${schools.map((s) => '<option value="' + s.id + '">' + esc(s.name) + '</option>').join('')}</select></div>
          </div>
          <label>Title</label><input id="an-title" maxlength="120" required placeholder="e.g. Exams timetable is out">
          <label>Message</label><textarea id="an-body" rows="4" maxlength="2000" required></textarea>
          <div style="display:flex;gap:18px;margin:12px 0;flex-wrap:wrap">
            <label style="margin:0;font-weight:500"><input type="checkbox" checked disabled style="width:auto"> In-app notification</label>
            <label style="margin:0;font-weight:500"><input type="checkbox" id="an-email" style="width:auto" ${ch.email ? '' : 'disabled'}> Email ${ch.email ? '' : '<span class="muted small">(not set up on the server)</span>'}</label>
            <label style="margin:0;font-weight:500"><input type="checkbox" id="an-sms" style="width:auto" ${ch.sms ? '' : 'disabled'}> SMS ${ch.sms ? '' : '<span class="muted small">(not set up on the server)</span>'}</label>
          </div>
          <button type="submit" class="btn-gold" id="an-btn">Send announcement</button>
        </form>
      </div>
      <h3>Sent</h3>
      <div class="table-wrap"><table><thead><tr><th>When</th><th>Title</th><th>To</th><th>Recipients</th><th>Email</th><th>SMS</th></tr></thead><tbody>
        ${list.announcements.map((a) => '<tr><td>' + fmtDateTime(a.createdAt) + '</td><td><strong>' + esc(a.title) + '</strong><div class="small muted" style="white-space:normal;max-width:380px">' + esc(clip(a.body, 140)) + '</div></td><td>' + esc(a.audience === 'SCHOOL' ? (a.schoolName || 'One school') : ({ ALL: 'Everyone', INDEPENDENT: 'Independent students', SCHOOLS: 'All schools' }[a.audience])) + '</td><td class="tabular">' + a.recipientCount + '</td><td class="tabular">' + (a.channels.includes('EMAIL') ? a.emailSent : '—') + '</td><td class="tabular">' + (a.channels.includes('SMS') ? a.smsSent : '—') + '</td></tr>').join('') || '<tr><td colspan="6" class="muted">Nothing sent yet.</td></tr>'}
      </tbody></table></div>`;
    $('an-aud').addEventListener('change', () => $('an-school-wrap').classList.toggle('hidden', $('an-aud').value !== 'SCHOOL'));
    $('an-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const aud = $('an-aud').value;
      const where = aud === 'SCHOOL' ? $('an-school').selectedOptions[0].textContent : ({ ALL: 'everyone on Learnza', INDEPENDENT: 'all independent students', SCHOOLS: 'everyone at every school' }[aud]);
      if (!confirm('Send this to ' + where + '? It cannot be recalled.')) return;
      const channels = [];
      if ($('an-email').checked) channels.push('EMAIL');
      if ($('an-sms').checked) channels.push('SMS');
      $('an-btn').disabled = true;
      try {
        const { announcement } = await api('/announcements', { method: 'POST', body: { title: $('an-title').value.trim(), body: $('an-body').value.trim(), audience: aud, schoolId: aud === 'SCHOOL' ? $('an-school').value : undefined, channels } });
        toast('Sending to ' + announcement.recipientCount + ' people');
        renderAnnouncements();
      } catch (err) { toast(err.message); $('an-btn').disabled = false; }
    });
  }

  // ---------------- payments & subscriptions ----------------
  async function renderPayments() {
    view.innerHTML = '<div class="view-head"><div><h1>Payments &amp; Subscriptions</h1><div class="muted">Student subscriptions paid through Paystack or Flutterwave, and manual grants.</div></div></div><div id="pay-host"></div>';
    tabs($('pay-host'), [['payments', 'Payments'], ['subs', 'Subscriptions'], ['grant', 'Grant access']], async (tab, body) => {
      if (tab === 'grant') return renderGrant(body);
      let page = 1;
      let filter = '';
      async function load() {
        if (tab === 'payments') {
          const d = await api('/payments?page=' + page + (filter ? '&status=' + filter : ''));
          if (!body.isConnected) return;
          const stat = (n, l) => '<div class="stat"><div class="n">' + n + '</div><div class="l">' + l + '</div></div>';
          body.innerHTML = '<div class="cards">' + stat(naira(d.summary.revenueKobo), 'All-time revenue (' + d.summary.paid + ' payments)') + stat(naira(d.summary.monthKobo), 'This month (' + d.summary.monthPaid + ')') + stat(d.summary.pending, 'Pending') + stat(d.summary.failed, 'Failed') + '</div>' +
            '<div class="toolbar"><select id="pay-f"><option value="">All</option><option>SUCCESS</option><option>PENDING</option><option>FAILED</option></select></div>' +
            '<div class="table-wrap"><table><thead><tr><th>When</th><th>Student</th><th>Plan</th><th>Amount</th><th>Provider</th><th>Status</th><th>Reference</th></tr></thead><tbody>' +
            (d.payments.map((p) => '<tr><td>' + fmtDateTime(p.createdAt) + '</td><td><strong>' + esc(p.user.fullName) + '</strong><div class="small muted">' + esc(p.user.school ? p.user.school.name : p.user.email) + '</div></td><td>' + esc(p.plan) + '</td><td class="tabular">' + naira(p.amountKobo) + '</td><td>' + esc(p.provider) + '</td><td><span class="pill ' + (p.status === 'SUCCESS' ? 'ok' : p.status === 'PENDING' ? 'warn' : 'bad') + '">' + esc(p.status) + '</span></td><td class="small muted">' + esc(p.reference) + '</td></tr>').join('') || '<tr><td colspan="7" class="muted">No payments yet.</td></tr>') + '</tbody></table></div>';
          $('pay-f').value = filter;
          $('pay-f').addEventListener('change', () => { filter = $('pay-f').value; page = 1; load(); });
          body.appendChild(pager(page, d.total, d.pageSize, (p) => { page = p; load(); }));
        } else {
          const d = await api('/subscriptions?page=' + page + (filter ? '&state=' + filter : ''));
          if (!body.isConnected) return;
          body.innerHTML = '<div class="toolbar"><select id="sub-f"><option value="">All</option><option value="active">Active</option><option value="expired">Expired / cancelled</option></select><span class="muted">' + d.activeCount + ' active right now</span></div>' +
            '<div class="table-wrap"><table><thead><tr><th>Student</th><th>Plan</th><th>Status</th><th>Expires</th><th>AI minutes used</th><th></th></tr></thead><tbody>' +
            (d.subscriptions.map((s) => '<tr><td><strong>' + esc(s.user.fullName) + '</strong><div class="small muted">' + esc(s.user.email) + '</div></td><td>' + esc(s.plan) + '</td><td><span class="pill ' + (s.active ? 'ok' : 'bad') + '">' + (s.active ? 'Active' : esc(s.status === 'ACTIVE' ? 'EXPIRED' : s.status)) + '</span></td><td>' + fmtDate(s.expiresAt) + '</td><td class="tabular">' + Math.round(s.aiSecondsUsed / 60) + ' / ' + Math.round(s.aiSecondsGranted / 60) + '</td><td>' + (s.active ? '<button class="btn-ghost btn-sm" data-revoke="' + s.userId + '">Revoke</button>' : '') + '</td></tr>').join('') || '<tr><td colspan="6" class="muted">No subscriptions yet.</td></tr>') + '</tbody></table></div>';
          $('sub-f').value = filter;
          $('sub-f').addEventListener('change', () => { filter = $('sub-f').value; page = 1; load(); });
          body.appendChild(pager(page, d.total, d.pageSize, (p) => { page = p; load(); }));
          body.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', async () => {
            if (!confirm('End this subscription now?')) return;
            try { await api('/subscriptions/' + b.dataset.revoke + '/revoke', { method: 'POST' }); toast('Subscription ended'); load(); } catch (err) { toast(err.message); }
          }));
        }
      }
      await load();
    });
  }

  function renderGrant(body) {
    body.innerHTML = `
      <div class="panel" style="max-width:560px">
        <h3>Grant a subscription</h3>
        <p class="muted small">For an offline payment, a scholarship, or to make good on a problem. It starts today and resets the student's AI minutes.</p>
        <form id="gr-form">
          <label>Student's email</label><input id="gr-email" type="email" required>
          <div class="row"><div><label>Plan</label><select id="gr-plan"><option value="MONTHLY">Monthly (30 days)</option><option value="YEARLY">Yearly (365 days)</option></select></div>
          <div><label>Days (optional override)</label><input id="gr-days" type="number" min="1" max="3650" placeholder="plan default"></div></div>
          <div style="margin-top:14px"><button type="submit" class="btn-gold">Grant access</button></div>
        </form>
      </div>`;
    $('gr-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const { subscription } = await api('/subscriptions/grant', { method: 'POST', body: { email: $('gr-email').value.trim(), plan: $('gr-plan').value, days: $('gr-days').value || undefined } });
        toast('Active until ' + fmtDate(subscription.expiresAt));
        $('gr-form').reset();
      } catch (err) { toast(err.message); }
    });
  }

  // ---------------- AI activity ----------------
  async function renderAi() {
    view.innerHTML = '<div class="view-head"><div><h1>AI Activity</h1><div class="muted">What students ask the AI and how it answers, and AI Teacher lessons in progress. Review for quality and misuse.</div></div></div><div id="ai-host"></div>';
    tabs($('ai-host'), [['logs', 'Questions & answers'], ['sessions', 'AI Teacher sessions']], async (tab, body) => {
      let page = 1;
      let kind = '';
      let search = '';
      async function load() {
        if (tab === 'logs') {
          const d = await api('/ai-logs?page=' + page + (kind ? '&kind=' + kind : '') + (search ? '&search=' + encodeURIComponent(search) : ''));
          if (!body.isConnected) return;
          body.innerHTML = '<div class="toolbar"><input id="ai-s" placeholder="Search questions, answers or names…" value="' + esc(search) + '"><select id="ai-k"><option value="">All kinds</option><option value="RESEARCH">Research assistant</option><option value="LAB">Lab questions</option></select><span class="muted">' + d.today + ' today</span></div>' +
            '<div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>Kind</th><th>Question</th><th>Answer</th></tr></thead><tbody>' +
            (d.logs.map((l) => '<tr><td>' + fmtDateTime(l.createdAt) + '</td><td><strong>' + esc(l.user.fullName) + '</strong><div class="small muted">' + esc(l.user.school ? l.user.school.name : 'Independent') + '</div></td><td>' + esc(l.kind) + '</td><td style="white-space:normal;max-width:300px">' + esc(clip(l.question, 220)) + '</td><td style="white-space:normal;max-width:380px" class="small">' + esc(clip(l.answer, 320)) + '</td></tr>').join('') || '<tr><td colspan="5" class="muted">No AI conversations recorded yet.</td></tr>') + '</tbody></table></div>';
          $('ai-k').value = kind;
          $('ai-k').addEventListener('change', () => { kind = $('ai-k').value; page = 1; load(); });
          let t; $('ai-s').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { search = $('ai-s').value.trim(); page = 1; load(); }, 350); });
          body.appendChild(pager(page, d.total, d.pageSize, (p) => { page = p; load(); }));
        } else {
          const d = await api('/ai-sessions?page=' + page);
          if (!body.isConnected) return;
          body.innerHTML = '<div class="muted" style="margin-bottom:10px">' + d.active + ' in progress · ' + d.total + ' total</div><div class="table-wrap"><table><thead><tr><th>Started</th><th>Student</th><th>Course</th><th>Topic</th><th>Progress</th><th>Status</th></tr></thead><tbody>' +
            (d.sessions.map((s) => '<tr><td>' + fmtDateTime(s.createdAt) + '</td><td><strong>' + esc(s.student.fullName) + '</strong><div class="small muted">' + esc(s.student.school ? s.student.school.name : 'Independent') + '</div></td><td>' + esc(s.course ? s.course.code : (s.individualCourse ? s.individualCourse.title : '—')) + '</td><td style="white-space:normal;max-width:260px">' + esc(s.topic) + '</td><td class="tabular">section ' + (s.sectionIdx + 1) + ' · ' + s._count.turns + ' turns</td><td><span class="pill ' + (s.status === 'COMPLETED' ? 'ok' : 'warn') + '">' + esc(s.status) + '</span></td></tr>').join('') || '<tr><td colspan="6" class="muted">No AI Teacher sessions yet.</td></tr>') + '</tbody></table></div>';
          body.appendChild(pager(page, d.total, d.pageSize, (p) => { page = p; load(); }));
        }
      }
      await load();
    });
  }

  // ---------------- live classes ----------------
  async function renderLive() {
    view.innerHTML = '<div class="view-head"><div><h1>Live Classes</h1><div class="muted">Every live session across all schools, and their recordings.</div></div></div><div id="lv-host"></div>';
    let page = 1;
    async function load() {
      const d = await api('/live-classes?page=' + page);
      if (!$('lv-host')) return;
      const stat = (n, l) => '<div class="stat"><div class="n">' + n + '</div><div class="l">' + l + '</div></div>';
      $('lv-host').innerHTML = '<div class="cards">' + stat(d.liveNow, 'Live right now') + stat(d.total, 'Classes held') + stat(d.withRecording, 'With a recording') + '</div>' +
        '<div class="table-wrap"><table><thead><tr><th>Started</th><th>Class</th><th>School</th><th>Lecturer</th><th>Status</th><th>Recording</th></tr></thead><tbody>' +
        (d.classes.map((c) => '<tr><td>' + fmtDateTime(c.startedAt) + '</td><td><strong>' + esc(c.title) + '</strong><div class="small muted">' + esc(c.courseCode) + ' · ' + esc(c.courseTitle) + '</div></td><td>' + esc(c.schoolName || '—') + '</td><td>' + esc(c.host.fullName) + '</td><td><span class="pill ' + (c.status === 'ACTIVE' ? 'ok' : '') + '">' + (c.status === 'ACTIVE' ? 'LIVE' : 'Ended') + '</span></td><td>' + (c.recordingUrl ? '<a href="' + esc(c.recordingUrl) + '" target="_blank" rel="noopener">Watch</a>' : '<span class="muted">—</span>') + '</td></tr>').join('') || '<tr><td colspan="6" class="muted">No live classes yet.</td></tr>') + '</tbody></table></div>';
      $('lv-host').appendChild(pager(page, d.total, d.pageSize, (p) => { page = p; load(); }));
    }
    await load();
  }

  // ---------------- gamification ----------------
  async function renderGamification() {
    const d = await api('/gamification');
    const stat = (n, l) => '<div class="stat"><div class="n">' + n + '</div><div class="l">' + l + '</div></div>';
    view.innerHTML = '<div class="view-head"><div><h1>Gamification</h1><div class="muted">Points, study streaks and badges. Students only ever see their own progress — there is no leaderboard in the apps; this view is for you.</div></div></div>' +
      '<div class="cards">' + stat(d.players, 'Students with activity') + stat(d.totalPoints.toLocaleString(), 'Points earned') + stat(d.longestStreak + ' days', 'Longest streak') + '</div>' +
      '<h3>Badges</h3><div class="table-wrap"><table><thead><tr><th></th><th>Badge</th><th>How it is earned</th><th>Awarded</th></tr></thead><tbody>' +
      (d.badges.map((b) => '<tr><td style="font-size:20px">' + esc(b.icon) + '</td><td><strong>' + esc(b.name) + '</strong></td><td>' + esc(b.description) + '</td><td class="tabular">' + b.earned + '</td></tr>').join('') || '<tr><td colspan="4" class="muted">Badges appear here once students start earning them.</td></tr>') + '</tbody></table></div>' +
      '<h3>Current streaks</h3><div class="table-wrap"><table><tbody>' +
      (d.streaks.map((s) => '<tr><td><strong>' + esc(s.user.fullName) + '</strong><div class="small muted">' + esc(s.user.school ? s.user.school.name : 'Independent') + '</div></td><td class="tabular">🔥 ' + s.currentStreak + ' days</td><td class="tabular">' + s.points + ' pts</td></tr>').join('') || '<tr><td class="muted">No active streaks.</td></tr>') + '</tbody></table></div>' +
      '<h3>Recently earned</h3><div class="table-wrap"><table><tbody>' +
      (d.recent.map((r) => '<tr><td>' + esc(r.badge.icon) + ' <strong>' + esc(r.badge.name) + '</strong></td><td>' + esc(r.user.fullName) + '</td><td>' + esc(r.user.school ? r.user.school.name : 'Independent') + '</td><td>' + fmtDateTime(r.earnedAt) + '</td></tr>').join('') || '<tr><td class="muted">Nothing yet.</td></tr>') + '</tbody></table></div>';
  }

  // ---------------- platform e-Library ----------------
  async function renderLibrary() {
    view.innerHTML = `
      <div class="view-head"><div><h1>e-Library</h1><div class="muted">Add textbooks and past questions here and every student and every school can read them. Schools' own uploads stay private to that school and are listed below for oversight.</div></div></div>
      <div class="panel">
        <h3>Add to the platform library</h3>
        <form id="lb-form">
          <div class="row">
            <div style="flex:2"><label>Title *</label><input id="lb-title" required></div>
            <div style="flex:2"><label>Author *</label><input id="lb-author" required></div>
            <div><label>Type *</label><select id="lb-type"><option>Textbook</option><option>Journal</option><option>Past Question</option><option>Handout</option></select></div>
          </div>
          <div class="row">
            <div style="flex:2"><label>Publisher</label><input id="lb-pub"></div>
            <div style="flex:2"><label>File * (PDF, up to 25 MB)</label><input id="lb-file" type="file" required></div>
            <div style="flex:0 0 auto"><button type="submit" class="btn-gold" id="lb-btn">Upload</button></div>
          </div>
        </form>
      </div>
      <div class="toolbar"><input id="lb-search" placeholder="Search…"><select id="lb-scope"><option value="platform">Platform library</option><option value="all">Everything (incl. schools')</option></select></div>
      <div id="lb-table"></div>`;
    $('lb-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData();
      fd.append('title', $('lb-title').value.trim());
      fd.append('author', $('lb-author').value.trim());
      fd.append('type', $('lb-type').value);
      fd.append('publisher', $('lb-pub').value.trim());
      fd.append('file', $('lb-file').files[0]);
      $('lb-btn').disabled = true;
      try { await api('/library', { method: 'POST', body: fd }); toast('Added to the library'); $('lb-form').reset(); loadLib(); } catch (err) { toast(err.message); } finally { $('lb-btn').disabled = false; }
    });
    let page = 1;
    async function loadLib() {
      const d = await api('/library?page=' + page + '&scope=' + $('lb-scope').value + '&search=' + encodeURIComponent($('lb-search').value.trim()));
      if (!$('lb-table')) return;
      const box = $('lb-table');
      box.innerHTML = '<div class="table-wrap"><table><thead><tr><th>Title</th><th>Author</th><th>Type</th><th>Owner</th><th>Added</th><th></th></tr></thead><tbody>' +
        (d.items.map((i) => '<tr><td><a href="' + esc(i.fileUrl) + '" target="_blank" rel="noopener"><strong>' + esc(i.title) + '</strong></a></td><td>' + esc(i.author) + '</td><td>' + esc(i.type) + '</td><td>' + (i.school ? esc(i.school.name) : '<span class="pill ok">Platform</span>') + '</td><td>' + fmtDate(i.createdAt) + '</td><td><button class="btn-ghost btn-sm" data-del="' + i.id + '">Remove</button></td></tr>').join('') || '<tr><td colspan="6" class="muted">Nothing here yet.</td></tr>') + '</tbody></table></div>';
      box.appendChild(pager(page, d.total, d.pageSize, (p) => { page = p; loadLib(); }));
      box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('Remove this resource for everyone who can see it?')) return;
        try { await api('/library/' + b.dataset.del, { method: 'DELETE' }); toast('Removed'); loadLib(); } catch (err) { toast(err.message); }
      }));
    }
    let t; $('lb-search').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { page = 1; loadLib(); }, 300); });
    $('lb-scope').addEventListener('change', () => { page = 1; loadLib(); });
    await loadLib();
  }

  // ---------------- settings ----------------
  async function renderSettings() {
    const { settings } = await api('/settings');
    const groups = {};
    settings.forEach((s) => { (groups[s.category] = groups[s.category] || []).push(s); });
    const field = (s) => {
      let input;
      if (s.type === 'boolean') input = '<label class="switch"><input type="checkbox" data-k="' + s.key + '" ' + (s.value ? 'checked' : '') + '> <span>' + (s.value ? 'On' : 'Off') + '</span></label>';
      else if (s.type === 'select') input = '<select data-k="' + s.key + '">' + s.options.map((o) => '<option value="' + o + '" ' + (o === s.value ? 'selected' : '') + '>' + ({ env: 'Follow server setting', on: 'Always on', off: 'Always off' }[o] || o) + '</option>').join('') + '</select>';
      else if (s.type === 'number') input = '<input type="number" min="' + (s.min || 0) + '" data-k="' + s.key + '" value="' + esc(s.value) + '">';
      else input = '<textarea rows="2" data-k="' + s.key + '">' + esc(s.value) + '</textarea>';
      return '<div class="setting"><div><strong>' + esc(s.label) + '</strong><div class="muted small">' + esc(s.help) + '</div></div><div>' + input + '</div></div>';
    };
    view.innerHTML = '<div class="view-head"><div><h1>Settings</h1><div class="muted">Platform-wide switches. Changes apply within a minute, no redeploy.</div></div></div>' +
      Object.entries(groups).map(([cat, list]) => '<div class="panel"><h3>' + esc(cat) + '</h3>' + list.map(field).join('') + '</div>').join('') +
      '<button class="btn-gold" id="st-save">Save settings</button>';
    view.querySelectorAll('input[type=checkbox][data-k]').forEach((c) => c.addEventListener('change', () => { c.nextElementSibling.textContent = c.checked ? 'On' : 'Off'; }));
    $('st-save').addEventListener('click', async () => {
      const out = {};
      view.querySelectorAll('[data-k]').forEach((el) => { out[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value; });
      if (out.maintenanceMode && !settings.find((s) => s.key === 'maintenanceMode').value && !confirm('Turn on maintenance mode? Every student, lecturer and school admin is locked out until you turn it off.')) return;
      try { await api('/settings', { method: 'PUT', body: { settings: out } }); toast('Settings saved'); renderSettings(); } catch (err) { toast(err.message); }
    });
  }

  // ---------------- boot ----------------
  if (token && me) showApp();
})();
