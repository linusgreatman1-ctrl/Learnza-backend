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
  function tabs(host, names, onPick, initial) {
    const first = names.some(([k]) => k === initial) ? initial : names[0][0];
    host.innerHTML = '<div class="tabs">' + names.map(([k, label]) => '<button class="tab' + (k === first ? ' on' : '') + '" data-tab="' + k + '">' + esc(label) + '</button>').join('') + '</div><div class="tab-body"></div>';
    const body = host.querySelector('.tab-body');
    const pick = (k) => { host.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === k)); onPick(k, body); };
    host.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => pick(t.dataset.tab)));
    pick(first);
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
    dashboard: renderDashboard, analytics: renderAnalytics, questions: renderQuestions,
    lessons: renderLessons, courses: renderCourses,
    conversations: () => renderAi('logs'), teacher: () => renderAi('sessions'), demonstrations: renderDemonstrations,
    payments: () => renderPayments('payments'), coins: () => renderPayments('coins'), subscriptions: () => renderPayments('subs'),
    gamification: renderGamification, attendance: renderAttendance, results: renderResults, records: renderRecords,
    users: renderUsers, teachers: renderTeachers, fees: renderFees, elections: renderElections, schools: renderSchools,
    announcements: renderAnnouncements, 'bulk-email': () => renderBulk('EMAIL'), 'bulk-sms': () => renderBulk('SMS'),
    tickets: () => renderSupport('tickets'), reviews: renderReviews, chat: () => renderSupport('chat'),
    live: renderLive, library: renderLibrary, 'access-codes': renderAccessCodes, editor: renderCodeEditor, preview: renderPreview, codes: renderCodes,
    settings: renderSettings, admins: renderAdmins, audit: renderAudit, logs: renderSystemLogs,
  };

  let navigationId = 0;
  function go(name) {
    if (!views[name]) name = 'dashboard';
    location.hash = name;
    document.querySelectorAll('#nav li').forEach((li) => li.classList.toggle('active', li.dataset.view === name));
    if (typeof chatTimer !== 'undefined') clearInterval(chatTimer);
    view.innerHTML = '<p class="muted">Loading…</p>';
    // A view that was still loading when the user clicked elsewhere must not draw into (or put an
    // error over) the page they are now on.
    const mine = ++navigationId;
    views[name]().catch((err) => { if (mine === navigationId) view.innerHTML = `<p class="error-msg">${esc(err.message)}</p>`; });
  }
  $('nav').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-view]');
    if (li) { $('app-screen').classList.remove('nav-open'); go(li.dataset.view); }
  });
  // On a phone the menu slides in from the ☰ button.
  $('nav-toggle').addEventListener('click', () => $('app-screen').classList.toggle('nav-open'));
  $('nav-scrim').addEventListener('click', () => $('app-screen').classList.remove('nav-open'));

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
      <h3>Needs attention</h3>
      <div class="cards">${stat(d.activity.pendingManualPayments, 'Bank transfers to confirm')}${stat(d.activity.openTickets, 'Tickets waiting on you')}${stat(d.activity.unreadChats, 'Chats with unread messages')}</div>
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
            <div><label>Type of institution</label><select id="ob-type"><option value="">Select…</option>${[['UNIVERSITY','University'],['POLYTECHNIC','Polytechnic'],['MONOTECHNIC','Monotechnic'],['COLLEGE_OF_EDUCATION','College of Education'],['OTHER','Other']].map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
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
          name: $('ob-name').value.trim(), institutionType: $('ob-type').value, state: $('ob-state').value, address: $('ob-address').value.trim(),
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
          <div><label>Type of institution</label><select id="se-type"><option value="">—</option>${[['UNIVERSITY','University'],['POLYTECHNIC','Polytechnic'],['MONOTECHNIC','Monotechnic'],['COLLEGE_OF_EDUCATION','College of Education'],['OTHER','Other']].map(([v, l]) => `<option value="${v}" ${v === school.institutionType ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
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
        await api('/schools/' + id, { method: 'PATCH', body: { name: q('#se-name').value.trim(), institutionType: q('#se-type').value, state: q('#se-state').value, address: q('#se-address').value.trim(), contactPhone: q('#se-phone').value.trim(), contactEmail: q('#se-email').value.trim() } });
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
  const providerLabel = (p) => (p === 'MANUAL_TRANSFER' ? 'Bank transfer / USSD' : p === 'FLUTTERWAVE' ? 'Flutterwave' : p === 'PAYSTACK' ? 'Paystack' : esc(p));
  // A student reported a bank transfer or USSD payment: the admin confirms it once the money is seen.
  function manualButtons(path, row) {
    if (row.provider !== 'MANUAL_TRANSFER' || row.status !== 'PENDING') return '';
    return '<button class="btn-gold btn-sm" data-confirm="' + path + '|' + row.id + '">Confirm paid</button> <button class="btn-ghost btn-sm" data-reject="' + path + '|' + row.id + '">Reject</button>';
  }
  function wireManual(root, path, reload) {
    root.querySelectorAll('[data-confirm]').forEach((b) => b.addEventListener('click', async () => {
      const [p, id] = b.dataset.confirm.split('|');
      if (p !== path) return;
      if (!confirm('Confirm that the money for this payment has arrived? The student gets what they paid for straight away.')) return;
      try { await api('/' + p + '/' + id + '/confirm', { method: 'POST' }); toast('Confirmed'); reload(); } catch (err) { toast(err.message); }
    }));
    root.querySelectorAll('[data-reject]').forEach((b) => b.addEventListener('click', async () => {
      const [p, id] = b.dataset.reject.split('|');
      if (p !== path) return;
      if (!confirm('Reject this payment? Nothing is given to the student.')) return;
      try { await api('/' + p + '/' + id + '/reject', { method: 'POST' }); toast('Rejected'); reload(); } catch (err) { toast(err.message); }
    }));
  }

  async function renderPayments(initial) {
    view.innerHTML = '<div class="view-head"><div><h1>Payments &amp; Subscriptions</h1><div class="muted">Student subscriptions paid through Paystack or Flutterwave, and manual grants.</div></div></div><div id="pay-host"></div>';
    tabs($('pay-host'), [['payments', 'Payments'], ['subs', 'Subscriptions'], ['coins', 'Coins'], ['grant', 'Grant access']], async (tab, body) => {
      if (tab === 'grant') return renderGrant(body);
      if (tab === 'coins') return coinsTab(body);
      let page = 1;
      let filter = '';
      async function load() {
        if (tab === 'payments') {
          const d = await api('/payments?page=' + page + (filter ? '&status=' + filter : ''));
          if (!body.isConnected) return;
          const stat = (n, l) => '<div class="stat"><div class="n">' + n + '</div><div class="l">' + l + '</div></div>';
          body.innerHTML = '<div class="cards">' + stat(naira(d.summary.revenueKobo), 'All-time revenue (' + d.summary.paid + ' payments)') + stat(naira(d.summary.monthKobo), 'This month (' + d.summary.monthPaid + ')') + stat(d.summary.pending, 'Pending') + stat(d.summary.failed, 'Failed') + '</div>' +
            '<div class="toolbar"><select id="pay-f"><option value="">All</option><option>SUCCESS</option><option>PENDING</option><option>FAILED</option></select></div>' +
            '<div class="table-wrap"><table><thead><tr><th>When</th><th>Student</th><th>Plan</th><th>Amount</th><th>Provider</th><th>Status</th><th>Reference</th><th></th></tr></thead><tbody>' +
            (d.payments.map((p) => '<tr><td>' + fmtDateTime(p.createdAt) + '</td><td><strong>' + esc(p.user.fullName) + '</strong><div class="small muted">' + esc(p.user.school ? p.user.school.name : p.user.email) + '</div></td><td>' + esc(p.plan) + '</td><td class="tabular">' + naira(p.amountKobo) + '</td><td>' + providerLabel(p.provider) + '</td><td><span class="pill ' + (p.status === 'SUCCESS' ? 'ok' : p.status === 'PENDING' ? 'warn' : 'bad') + '">' + esc(p.status) + '</span></td><td class="small muted">' + esc(p.reference) + '</td><td style="white-space:nowrap">' + manualButtons('payments', p) + '</td></tr>').join('') || '<tr><td colspan="8" class="muted">No payments yet.</td></tr>') + '</tbody></table></div>';
          $('pay-f').value = filter;
          wireManual(body, 'payments', load);
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
    }, initial);
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
  async function renderAi(initial) {
    view.innerHTML = '<div class="view-head"><div><h1>AI Activity</h1><div class="muted">What students ask the AI and how it answers, and AI Lecturer lessons in progress. Review for quality and misuse.</div></div></div><div id="ai-host"></div>';
    tabs($('ai-host'), [['logs', 'Questions & answers'], ['sessions', 'AI Lecturer sessions']], async (tab, body) => {
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
            (d.sessions.map((s) => '<tr><td>' + fmtDateTime(s.createdAt) + '</td><td><strong>' + esc(s.student.fullName) + '</strong><div class="small muted">' + esc(s.student.school ? s.student.school.name : 'Independent') + '</div></td><td>' + esc(s.course ? s.course.code : (s.individualCourse ? s.individualCourse.title : '—')) + '</td><td style="white-space:normal;max-width:260px">' + esc(s.topic) + '</td><td class="tabular">section ' + (s.sectionIdx + 1) + ' · ' + s._count.turns + ' turns</td><td><span class="pill ' + (s.status === 'COMPLETED' ? 'ok' : 'warn') + '">' + esc(s.status) + '</span></td></tr>').join('') || '<tr><td colspan="6" class="muted">No AI Lecturer sessions yet.</td></tr>') + '</tbody></table></div>';
          body.appendChild(pager(page, d.total, d.pageSize, (p) => { page = p; load(); }));
        }
      }
      await load();
    }, initial);
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
      <div class="view-head"><div><h1>e-Library</h1><div class="muted">Add e-books here and every student, lecturer and school can read them. Only the backend admin adds e-books. Schools' own uploads stay private to that school and are listed below for oversight.</div></div></div>
      <div class="panel">
        <h3>Add to the platform library</h3>
        <form id="lb-form">
          <div class="row">
            <div style="flex:2"><label>Title *</label><input id="lb-title" required></div>
            <div style="flex:2"><label>Author *</label><input id="lb-author" required></div>
            <div><label>Type *</label><select id="lb-type"><option>Textbook</option><option>Journal</option><option>Handout</option></select></div>
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

  // ---------------- support: tickets + live chat ----------------
  async function renderSupport(initial) {
    view.innerHTML = '<div class="view-head"><div><h1>Support</h1><div class="muted">Tickets and live chats from students, lecturers and school admins. A chat is answered by the AI assistant until you reply — then it stays quiet.</div></div></div><div id="sp-host"></div>';
    tabs($('sp-host'), [['tickets', 'Tickets'], ['chat', 'Live chat']], async (tab, body) => {
      if (tab === 'tickets') return supportTickets(body);
      return supportChat(body);
    }, initial);
  }

  async function supportTickets(body) {
    let page = 1;
    let status = 'OPEN';
    async function load() {
      const d = await api('/tickets?page=' + page + (status ? '&status=' + status : ''));
      if (!body.isConnected) return;
      body.innerHTML = '<div class="toolbar"><select id="tk-f"><option value="OPEN">Waiting on us (' + d.open + ')</option><option value="ANSWERED">Answered</option><option value="CLOSED">Closed</option><option value="">All</option></select></div>' +
        '<div class="table-wrap"><table><thead><tr><th>Updated</th><th>From</th><th>Subject</th><th>Category</th><th>Msgs</th><th>Status</th></tr></thead><tbody>' +
        (d.tickets.map((t) => '<tr class="clickable" data-id="' + t.id + '"><td>' + fmtDateTime(t.updatedAt) + '</td><td><strong>' + esc(t.user.fullName) + '</strong><div class="small muted">' + esc(t.user.school ? t.user.school.name : t.user.role) + '</div></td><td>' + esc(t.subject) + '</td><td>' + esc(t.category) + '</td><td class="tabular">' + t._count.messages + '</td><td><span class="pill ' + (t.status === 'OPEN' ? 'warn' : t.status === 'ANSWERED' ? 'ok' : '') + '">' + esc(t.status) + '</span></td></tr>').join('') || '<tr><td colspan="6" class="muted">Nothing here.</td></tr>') + '</tbody></table></div>';
      $('tk-f').value = status;
      $('tk-f').addEventListener('change', () => { status = $('tk-f').value; page = 1; load(); });
      body.appendChild(pager(page, d.total, d.pageSize, (p) => { page = p; load(); }));
      body.querySelectorAll('tr.clickable').forEach((tr) => tr.addEventListener('click', () => openTicket(tr.dataset.id, load)));
    }
    await load();
  }

  async function openTicket(id, refresh) {
    const { ticket } = await api('/tickets/' + id);
    const m = modal('<div class="modal-head"><div><h3 style="margin:0">' + esc(ticket.subject) + '</h3><div class="muted small">' + esc(ticket.user.fullName) + ' · ' + esc(ticket.user.email) + ' · ' + esc(ticket.user.school ? ticket.user.school.name : ticket.user.role) + ' · ' + esc(ticket.category) + '</div></div><button class="btn-ghost btn-sm" data-close>✕</button></div>' +
      '<div class="thread">' + ticket.messages.map((x) => '<div class="bubble ' + (x.fromStaff ? 'staff' : 'user') + '"><div class="small muted">' + (x.fromStaff ? 'Learnza' : esc(ticket.user.fullName)) + ' · ' + fmtDateTime(x.createdAt) + '</div>' + esc(x.body) + '</div>').join('') + '</div>' +
      (ticket.status === 'CLOSED' ? '<p class="muted">This ticket is closed.</p><button class="btn-ghost btn-sm" id="tk-reopen">Reopen</button>' :
        '<form id="tk-form"><label>Reply</label><textarea id="tk-body" rows="4" required></textarea><div style="margin-top:12px;display:flex;gap:8px"><button type="submit" class="btn-gold">Send reply</button><button type="button" class="btn-ghost" id="tk-close">Reply &amp; close</button></div></form>'));
    const q = (sel) => m.el.querySelector(sel);
    const send = async (close) => {
      try { await api('/tickets/' + id + '/reply', { method: 'POST', body: { body: q('#tk-body').value.trim(), close } }); toast('Reply sent'); m.close(); refresh(); } catch (err) { toast(err.message); }
    };
    if (q('#tk-form')) {
      q('#tk-form').addEventListener('submit', (e) => { e.preventDefault(); send(false); });
      q('#tk-close').addEventListener('click', () => { if (q('#tk-body').value.trim()) send(true); else toast('Write a reply first'); });
    }
    if (q('#tk-reopen')) q('#tk-reopen').addEventListener('click', async () => { try { await api('/tickets/' + id + '/status', { method: 'POST', body: { status: 'OPEN' } }); m.close(); refresh(); } catch (err) { toast(err.message); } });
  }

  let chatTimer = null;
  async function supportChat(body) {
    clearInterval(chatTimer);
    let active = null;
    async function drawList() {
      const d = await api('/chat/threads');
      if (!body.isConnected) { clearInterval(chatTimer); return; }
      const list = $('ch-list');
      if (!list) return;
      list.innerHTML = d.threads.map((t) => '<div class="ch-item ' + (t.id === active ? 'on' : '') + '" data-id="' + t.id + '"><div><strong>' + esc(t.user.fullName) + '</strong>' + (t.unreadForAdmin ? ' <span class="pill bad">' + t.unreadForAdmin + '</span>' : '') + '</div><div class="small muted">' + esc(t.user.school ? t.user.school.name : t.user.role) + (t.adminTookOver ? ' · with team' : ' · AI') + '</div><div class="small">' + esc(t.lastMessage ? clip(t.lastMessage.body, 60) : '') + '</div></div>').join('') || '<p class="muted" style="padding:12px">No chats yet.</p>';
      list.querySelectorAll('.ch-item').forEach((el) => el.addEventListener('click', () => { active = el.dataset.id; drawThread(); drawList(); }));
    }
    async function drawThread() {
      if (!active) return;
      const { thread } = await api('/chat/threads/' + active);
      const pane = $('ch-pane');
      if (!pane) return;
      const typing = $('ch-text') ? $('ch-text').value : '';
      pane.innerHTML = '<div class="ch-head"><div><strong>' + esc(thread.user.fullName) + '</strong><div class="small muted">' + esc(thread.user.email) + ' · ' + esc(thread.user.school ? thread.user.school.name : thread.user.role) + '</div></div>' + (thread.adminTookOver ? '<button class="btn-ghost btn-sm" id="ch-release">Hand back to AI</button>' : '<span class="pill">AI is answering</span>') + '</div>' +
        '<div class="thread" id="ch-thread">' + thread.messages.map((x) => '<div class="bubble ' + (x.sender === 'USER' ? 'user' : 'staff') + '"><div class="small muted">' + (x.sender === 'USER' ? esc(thread.user.fullName) : x.sender === 'AI' ? 'AI assistant' : 'You') + ' · ' + fmtDateTime(x.createdAt) + '</div>' + esc(x.body) + '</div>').join('') + '</div>' +
        '<form id="ch-form" class="ch-form"><input id="ch-text" placeholder="Reply as the Learnza team…" required autocomplete="off"><button class="btn-gold" type="submit">Send</button></form>';
      $('ch-text').value = typing;
      const th = $('ch-thread'); th.scrollTop = th.scrollHeight;
      $('ch-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        try { await api('/chat/threads/' + active + '/reply', { method: 'POST', body: { body: $('ch-text').value.trim() } }); $('ch-text').value = ''; drawThread(); drawList(); } catch (err) { toast(err.message); }
      });
      if ($('ch-release')) $('ch-release').addEventListener('click', async () => { await api('/chat/threads/' + active + '/release', { method: 'POST' }); drawThread(); drawList(); });
    }
    body.innerHTML = '<div class="ch-layout"><div id="ch-list" class="ch-list"></div><div id="ch-pane" class="ch-pane"><p class="muted" style="padding:20px">Pick a chat.</p></div></div>';
    await drawList();
    // Light polling keeps the open chat and the list fresh without a socket.
    chatTimer = setInterval(() => { if (!body.isConnected) return clearInterval(chatTimer); drawList().catch(() => {}); if (active && !(document.activeElement && document.activeElement.id === 'ch-text' && $('ch-text').value)) drawThread().catch(() => {}); }, 6000);
  }

  // ---------------- reviews ----------------
  async function renderReviews() {
    const d = await api('/reviews');
    const max = Math.max(1, ...Object.values(d.distribution));
    const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);
    view.innerHTML = '<div class="view-head"><div><h1>App Reviews</h1><div class="muted">What people say about Learnza, one review each.</div></div></div>' +
      '<div class="panel"><div style="display:flex;gap:32px;align-items:center;flex-wrap:wrap"><div><div style="font-size:42px;font-weight:700">' + (d.average == null ? '—' : d.average) + '</div><div class="muted">' + d.total + ' review' + (d.total === 1 ? '' : 's') + '</div></div><div style="flex:1;min-width:220px">' +
      [5, 4, 3, 2, 1].map((n) => '<div style="display:flex;align-items:center;gap:8px;margin:3px 0"><span class="small" style="width:14px">' + n + '</span><div style="flex:1;background:var(--line);border-radius:4px;height:8px"><div style="width:' + (d.distribution[n] / max * 100) + '%;background:var(--gold);height:8px;border-radius:4px"></div></div><span class="small tabular" style="width:28px">' + d.distribution[n] + '</span></div>').join('') + '</div></div></div>' +
      '<div class="table-wrap"><table><thead><tr><th>When</th><th>From</th><th>Rating</th><th>Comment</th></tr></thead><tbody>' +
      (d.reviews.map((r) => '<tr><td>' + fmtDate(r.updatedAt) + '</td><td><strong>' + esc(r.user.fullName) + '</strong><div class="small muted">' + esc(r.user.school ? r.user.school.name : r.user.role) + '</div></td><td style="color:#c1861f;white-space:nowrap">' + stars(r.rating) + '</td><td style="white-space:normal;max-width:420px">' + esc(r.comment || '') + '</td></tr>').join('') || '<tr><td colspan="4" class="muted">No reviews yet.</td></tr>') + '</tbody></table></div>';
    view.appendChild(pager(d.page, d.total, d.pageSize, () => {}));
  }

  // ---------------- coins (a tab inside Payments & Subscriptions) ----------------
  async function coinsTab(body) {
    let page = 1;
    async function load() {
      const d = await api('/coins/purchases?page=' + page);
      if (!body.isConnected) return;
      const stat = (n, l) => '<div class="stat"><div class="n">' + n + '</div><div class="l">' + l + '</div></div>';
      body.innerHTML = '<div class="cards">' + stat(naira(d.summary.revenueKobo), 'Coin revenue') + stat(d.summary.coinsSold, 'Coins sold') + stat(d.summary.paid, 'Paid purchases') + '</div>' +
        '<div class="panel" style="max-width:640px"><h3>Add coins to a student</h3><form id="cg-form"><div class="row"><div style="flex:2"><label>Student email</label><input id="cg-email" type="email" required></div><div><label>Coins</label><input id="cg-n" type="number" min="1" max="10000" required></div></div><label>Note (shown in their history)</label><input id="cg-note" placeholder="e.g. Scholarship top-up"><div style="margin-top:12px"><button class="btn-gold" type="submit">Add coins</button></div></form></div>' +
        '<h3 style="margin-top:20px">Purchases</h3><div class="table-wrap"><table><thead><tr><th>When</th><th>Student</th><th>Coins</th><th>Amount</th><th>Provider</th><th>Status</th><th></th></tr></thead><tbody>' +
        (d.purchases.map((p) => '<tr><td>' + fmtDateTime(p.createdAt) + '</td><td><strong>' + esc(p.user.fullName) + '</strong></td><td class="tabular">' + p.coins + '</td><td class="tabular">' + naira(p.amountKobo) + '</td><td>' + providerLabel(p.provider) + '</td><td><span class="pill ' + (p.status === 'SUCCESS' ? 'ok' : p.status === 'PENDING' ? 'warn' : 'bad') + '">' + esc(p.status) + '</span></td><td style="white-space:nowrap">' + manualButtons('coins/purchases', p) + '</td></tr>').join('') || '<tr><td colspan="7" class="muted">No purchases yet.</td></tr>') + '</tbody></table></div>';
      body.appendChild(pager(page, d.total, d.pageSize, (p) => { page = p; load(); }));
      wireManual(body, 'coins/purchases', load);
      // The append-only ledger: every coin that was credited, granted or spent.
      const ledgerBox = document.createElement('div');
      ledgerBox.innerHTML = '<h3 style="margin-top:24px">Ledger</h3><div id="cg-ledger"><p class="muted">Loading…</p></div>';
      body.appendChild(ledgerBox);
      api('/coins/ledger?page=1').then((l) => {
        const box = ledgerBox.querySelector('#cg-ledger');
        if (!box) return;
        box.innerHTML = table(['When', 'Student', 'Change', 'Balance after', 'Reason', 'Note'], l.entries.map((e) => '<tr><td>' + fmtDateTime(e.createdAt) + '</td><td><strong>' + esc(e.user.fullName) + '</strong></td><td class="tabular" style="color:' + (e.delta > 0 ? 'var(--ok)' : 'var(--bad)') + '">' + (e.delta > 0 ? '+' : '') + e.delta + '</td><td class="tabular">' + e.balanceAfter + '</td><td>' + esc(e.reason) + '</td><td class="small muted" style="white-space:normal;max-width:260px">' + esc(e.note || '') + '</td></tr>').join(''), 'No coin movements yet.');
        if (l.total > l.pageSize) box.insertAdjacentHTML('beforeend', '<p class="muted small">Showing the latest ' + l.pageSize + ' of ' + l.total + '.</p>');
      }).catch(() => {});
      $('cg-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        try { await api('/coins/grant', { method: 'POST', body: { email: $('cg-email').value.trim(), coins: $('cg-n').value, note: $('cg-note').value.trim() } }); toast('Coins added'); load(); } catch (err) { toast(err.message); }
      });
    }
    await load();
  }

  // ---------------- small helpers shared by the oversight views ----------------
  function searchBar(id, placeholder, onChange, extra) {
    return '<div class="toolbar"><input id="' + id + '" placeholder="' + esc(placeholder) + '">' + (extra || '') + '</div>';
  }
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms || 300); }; }
  function table(headers, rowsHtml, empty) {
    return '<div class="table-wrap"><table><thead><tr>' + headers.map((h) => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>' + (rowsHtml || '<tr><td colspan="' + headers.length + '" class="muted">' + esc(empty || 'Nothing here yet.') + '</td></tr>') + '</tbody></table></div>';
  }
  function cardStat(n, l) { return '<div class="stat"><div class="n">' + n + '</div><div class="l">' + l + '</div></div>'; }
  async function schoolOptions(selectedId) {
    const { schools } = await api('/schools');
    return '<option value="">All schools</option>' + schools.map((s) => '<option value="' + s.id + '" ' + (s.id === selectedId ? 'selected' : '') + '>' + esc(s.name) + '</option>').join('');
  }
  // A paged list view: draws `render(data)` into `box` and re-fetches on page/filter change.
  function listView(box, fetchUrl, render) {
    let page = 1;
    async function load() {
      const d = await api(fetchUrl(page));
      if (!box.isConnected) return;
      box.innerHTML = '';
      const inner = document.createElement('div');
      inner.innerHTML = render(d);
      box.appendChild(inner);
      if (d.total != null && d.pageSize) box.appendChild(pager(page, d.total, d.pageSize, (p) => { page = p; load(); }));
      box.dispatchEvent(new CustomEvent('drawn', { detail: d }));
    }
    box.reload = (resetPage) => { if (resetPage) page = 1; return load(); };
    return load();
  }

  // ---------------- analytics ----------------
  function barChart(values, labels, color, fmt) {
    const max = Math.max(1, ...values);
    const w = 600, h = 120, gap = 2;
    const bw = Math.max(2, (w - gap * values.length) / values.length);
    return '<svg viewBox="0 0 ' + w + ' ' + (h + 18) + '" style="width:100%;height:auto" role="img">' +
      values.map((v, i) => {
        const bh = Math.round((v / max) * h);
        return '<rect x="' + (i * (bw + gap)) + '" y="' + (h - bh) + '" width="' + bw + '" height="' + Math.max(bh, v ? 2 : 0) + '" rx="1.5" fill="' + color + '"><title>' + esc(labels[i]) + ': ' + esc(fmt ? fmt(v) : v) + '</title></rect>';
      }).join('') +
      '<text x="0" y="' + (h + 14) + '" font-size="10" fill="#6b7588">' + esc(labels[0].slice(5)) + '</text><text x="' + w + '" y="' + (h + 14) + '" font-size="10" text-anchor="end" fill="#6b7588">' + esc(labels[labels.length - 1].slice(5)) + '</text></svg>';
  }

  async function renderAnalytics() {
    let days = 30;
    view.innerHTML = '<div class="view-head"><div><h1>Analytics</h1><div class="muted">How the platform is growing and being used.</div></div><select id="an-days"><option value="14">Last 14 days</option><option value="30" selected>Last 30 days</option><option value="90">Last 90 days</option></select></div><div id="an-body"></div>';
    async function load() {
      const d = await api('/analytics?days=' + days);
      if (!$('an-body')) return;
      const sum = (a) => a.reduce((x, y) => x + y, 0);
      const chart = (title, key, color, fmt, total) => '<div class="panel"><div style="display:flex;justify-content:space-between"><h3>' + title + '</h3><strong>' + (total != null ? total : sum(d.series[key])) + '</strong></div>' + barChart(d.series[key], d.labels, color, fmt) + '</div>';
      const roles = d.usersByRole;
      $('an-body').innerHTML =
        '<div class="cards">' + cardStat(sum(d.series.schoolSignups) + sum(d.series.independentSignups), 'New accounts') + cardStat(naira(sum(d.series.revenueKobo)), 'Revenue') + cardStat(sum(d.series.aiQuestions), 'AI questions') + cardStat(sum(d.series.testsSubmitted), 'Tests submitted') + cardStat(sum(d.series.liveClasses), 'Live classes') + '</div>' +
        '<div class="grid2">' +
        chart('Daily active users', 'activeUsers', '#1e3a5f', null, Math.max(0, ...d.series.activeUsers) + ' peak') +
        chart('School sign-ups', 'schoolSignups', '#e3ac4c') +
        chart('Independent sign-ups', 'independentSignups', '#1f8a5b') +
        chart('Revenue', 'revenueKobo', '#c1861f', (v) => naira(v), naira(sum(d.series.revenueKobo))) +
        chart('AI questions', 'aiQuestions', '#7b5ea7') +
        chart('Tests submitted', 'testsSubmitted', '#2f80c0') +
        '</div>' +
        '<div class="grid2"><div class="panel"><h3>People by role</h3>' + table(['Role', 'People'], Object.entries(roles).map(([r, n]) => '<tr><td>' + esc(r) + '</td><td class="tabular">' + n + '</td></tr>').join('')) + '</div>' +
        '<div class="panel"><h3>Biggest schools</h3>' + table(['School', 'People'], d.topSchools.map((s) => '<tr><td>' + esc(s.name) + '</td><td class="tabular">' + s.users + '</td></tr>').join(''), 'No schools yet.') + '</div></div>';
    }
    $('an-days').addEventListener('change', () => { days = Number($('an-days').value); load(); });
    await load();
  }

  // ---------------- questions (platform question bank) ----------------
  async function renderQuestions() {
    view.innerHTML = '<div class="view-head"><div><h1>Questions</h1><div class="muted">The practice question bank students and lecturers draw from in both apps. Answers are checked on the server.</div></div><div style="display:flex;gap:8px"><button class="btn-ghost" id="q-import">Import…</button><button class="btn-gold" id="q-add">+ Add question</button></div></div>' +
      '<div class="toolbar"><input id="q-search" placeholder="Search question text…"><select id="q-subject"><option value="">All subjects</option></select><select id="q-active"><option value="">Active &amp; hidden</option><option value="true">Active only</option><option value="false">Hidden only</option></select></div><div id="q-list"></div>';
    const box = $('q-list');
    let subjects = [];
    const url = (p) => '/questions?page=' + p + '&search=' + encodeURIComponent($('q-search').value.trim()) + '&subject=' + encodeURIComponent($('q-subject').value) + '&active=' + $('q-active').value;
    box.addEventListener('drawn', (e) => {
      subjects = e.detail.subjects;
      const sel = $('q-subject'); const cur = sel.value;
      sel.innerHTML = '<option value="">All subjects</option>' + subjects.map((s) => '<option value="' + esc(s.subject) + '">' + esc(s.subject) + ' (' + s.count + ')</option>').join('');
      sel.value = cur;
      box.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => questionForm(e.detail.questions.find((q) => q.id === b.dataset.edit))));
      box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('Delete this question?')) return;
        try { await api('/questions/' + b.dataset.del, { method: 'DELETE' }); toast('Deleted'); box.reload(); } catch (err) { toast(err.message); }
      }));
    });
    await listView(box, url, (d) => table(['Subject', 'Question', 'Answer', 'Source', ''], d.questions.map((q) =>
      '<tr><td><strong>' + esc(q.subject) + '</strong><div class="small muted">' + esc([q.topic, q.level].filter(Boolean).join(' · ')) + '</div></td><td style="white-space:normal;max-width:420px">' + esc(clip(q.text, 160)) + (q.active ? '' : ' <span class="pill bad">hidden</span>') + '</td><td>' + 'ABCDEF'[q.correctIndex] + '. ' + esc(clip(q.options[q.correctIndex], 40)) + '</td><td class="small">' + esc([q.source, q.year].filter(Boolean).join(' · ')) + '</td><td style="white-space:nowrap"><button class="btn-ghost btn-sm" data-edit="' + q.id + '">Edit</button> <button class="btn-ghost btn-sm" data-del="' + q.id + '">Delete</button></td></tr>').join(''), 'No questions yet — add one or import a batch.'));
    const reload = debounce(() => box.reload(true), 300);
    ['q-search', 'q-subject', 'q-active'].forEach((id) => $(id).addEventListener(id === 'q-search' ? 'input' : 'change', reload));
    $('q-add').addEventListener('click', () => questionForm(null));
    $('q-import').addEventListener('click', importQuestions);

    function questionForm(q) {
      const opts = q ? q.options : ['', '', '', ''];
      const m = modal('<div class="modal-head"><h3>' + (q ? 'Edit question' : 'Add a question') + '</h3><button class="btn-ghost btn-sm" data-close>✕</button></div>' +
        '<form id="qf"><div class="row"><div><label>Subject *</label><input id="qf-subject" list="qf-subjects" required value="' + esc(q ? q.subject : '') + '"><datalist id="qf-subjects">' + subjects.map((s) => '<option value="' + esc(s.subject) + '">').join('') + '</datalist></div><div><label>Topic</label><input id="qf-topic" value="' + esc(q && q.topic || '') + '"></div></div>' +
        '<div class="row"><div><label>Level</label><input id="qf-level" placeholder="100L, ND1…" value="' + esc(q && q.level || '') + '"></div><div><label>Source</label><input id="qf-source" placeholder="e.g. UNILAG 2022 exam" value="' + esc(q && q.source || '') + '"></div><div><label>Year</label><input id="qf-year" type="number" value="' + esc(q && q.year || '') + '"></div></div>' +
        '<label>Question *</label><textarea id="qf-text" rows="3" required>' + esc(q ? q.text : '') + '</textarea>' +
        '<label>Options (2–6, one per line) *</label><textarea id="qf-options" rows="5" required>' + esc(opts.join('\n')) + '</textarea>' +
        '<div class="row"><div><label>Correct option *</label><select id="qf-correct">' + [0, 1, 2, 3, 4, 5].map((i) => '<option value="' + i + '" ' + (q && q.correctIndex === i ? 'selected' : '') + '>' + 'ABCDEF'[i] + '</option>').join('') + '</select></div><div><label>Show to students</label><select id="qf-active"><option value="true">Yes</option><option value="false" ' + (q && !q.active ? 'selected' : '') + '>Hidden</option></select></div></div>' +
        '<label>Explanation (shown after answering)</label><textarea id="qf-expl" rows="2">' + esc(q && q.explanation || '') + '</textarea>' +
        '<div style="margin-top:14px"><button type="submit" class="btn-gold">Save</button></div></form>');
      m.el.querySelector('#qf').addEventListener('submit', async (e) => {
        e.preventDefault();
        const g = (id) => m.el.querySelector(id).value;
        const body = { subject: g('#qf-subject').trim(), topic: g('#qf-topic'), level: g('#qf-level'), source: g('#qf-source'), year: g('#qf-year'), text: g('#qf-text'), options: g('#qf-options').split('\n').map((x) => x.trim()).filter(Boolean), correctIndex: g('#qf-correct'), active: g('#qf-active') === 'true', explanation: g('#qf-expl') };
        try { await api(q ? '/questions/' + q.id : '/questions', { method: q ? 'PUT' : 'POST', body }); toast('Saved'); m.close(); box.reload(); } catch (err) { toast(err.message); }
      });
    }

    function importQuestions() {
      const sample = JSON.stringify([{ text: 'What is 2 + 2?', options: ['3', '4', '5'], correctIndex: 1, explanation: 'Basic addition.', topic: 'Arithmetic', year: 2022 }], null, 2);
      const m = modal('<div class="modal-head"><h3>Import questions</h3><button class="btn-ghost btn-sm" data-close>✕</button></div>' +
        '<p class="muted small">Paste a JSON list. Each item needs <code>text</code>, <code>options</code> (2–6) and <code>correctIndex</code> (0 = first option). Optional: <code>subject</code>, <code>topic</code>, <code>level</code>, <code>source</code>, <code>year</code>, <code>explanation</code>. Nothing is added if any item has a problem.</p>' +
        '<label>Subject for items without one</label><input id="im-subject" placeholder="e.g. Use of English">' +
        '<label>Questions (JSON)</label><textarea id="im-json" rows="12" style="font-family:monospace;font-size:12px">' + esc(sample) + '</textarea><div id="im-err" class="error-msg"></div>' +
        '<div style="margin-top:12px"><button class="btn-gold" id="im-go">Import</button></div>');
      m.el.querySelector('#im-go').addEventListener('click', async () => {
        let list;
        try { list = JSON.parse(m.el.querySelector('#im-json').value); } catch { m.el.querySelector('#im-err').textContent = 'That is not valid JSON.'; return; }
        try { const r = await api('/questions/bulk', { method: 'POST', body: { subject: m.el.querySelector('#im-subject').value.trim(), questions: list } }); toast(r.added + ' questions added'); m.close(); box.reload(true); } catch (err) { m.el.querySelector('#im-err').textContent = err.message; }
      });
    }
  }

  // ---------------- lessons ----------------
  async function renderLessons() {
    view.innerHTML = '<div class="view-head"><div><h1>Lessons</h1><div class="muted">Every lesson on the platform — lecturer-recorded, and AI Lecturer lessons written for self-study courses.</div></div></div>' +
      searchBar('ls-search', 'Search lesson titles…', null, '<select id="ls-kind"><option value="">All</option><option value="recorded">Lecturer lessons</option><option value="ai">AI Lecturer lessons</option></select>') + '<div id="ls-list"></div>';
    const box = $('ls-list');
    box.addEventListener('drawn', () => box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Remove this lesson for everyone?')) return;
      try { await api('/lessons/' + b.dataset.del, { method: 'DELETE' }); toast('Lesson removed'); box.reload(); } catch (err) { toast(err.message); }
    })));
    await listView(box, (p) => '/lessons?page=' + p + '&search=' + encodeURIComponent($('ls-search').value.trim()) + '&kind=' + $('ls-kind').value, (d) =>
      table(['Lesson', 'Where', 'School', 'By', 'Type', 'Added', ''], d.lessons.map((l) => '<tr><td><strong>' + esc(l.title) + '</strong></td><td>' + esc(l.where) + '</td><td>' + esc(l.schoolName || '—') + '</td><td>' + esc(l.owner || '—') + '</td><td>' + (l.isAiTeacher ? '<span class="pill ok">AI Lecturer</span>' : (l.videoUrl ? 'Video' : 'Script')) + '</td><td>' + fmtDate(l.createdAt) + '</td><td><button class="btn-ghost btn-sm" data-del="' + l.id + '">Remove</button></td></tr>').join(''), 'No lessons yet.'));
    const reload = debounce(() => box.reload(true));
    $('ls-search').addEventListener('input', reload); $('ls-kind').addEventListener('change', reload);
  }

  // ---------------- courses ----------------
  async function renderCourses() {
    view.innerHTML = '<div class="view-head"><div><h1>Courses</h1><div class="muted">School courses across every institution, and learners\' own self-study courses.</div></div></div><div id="co-host"></div>';
    tabs($('co-host'), [['school', 'School courses'], ['self', 'Self-study courses']], async (tab, body) => {
      body.innerHTML = searchBar('co-search', 'Search…', null, tab === 'school' ? '<select id="co-school"></select>' : '') + '<div id="co-list"></div>';
      if (tab === 'school') $('co-school').innerHTML = await schoolOptions();
      const box = $('co-list');
      await listView(box, (p) => '/courses?kind=' + tab + '&page=' + p + '&search=' + encodeURIComponent($('co-search').value.trim()) + (tab === 'school' ? '&schoolId=' + $('co-school').value : ''), (d) => tab === 'school'
        ? table(['Course', 'School', 'Department', 'Level', 'Students', 'Lecturers', 'Lessons', 'Tests', ''], d.courses.map((c) => '<tr><td><strong>' + esc(c.code) + ' — ' + esc(c.title) + '</strong></td><td>' + esc(c.schoolName || '—') + '</td><td>' + esc(c.department) + '</td><td>' + esc(c.level) + '</td><td class="tabular">' + c.students + '</td><td>' + esc(c.lecturers.join(', ') || '—') + '</td><td class="tabular">' + c.lessons + '</td><td class="tabular">' + c.assessments + '</td><td><button class="btn-ghost btn-sm" data-edit-course="' + c.id + '" data-code="' + esc(c.code) + '" data-title="' + esc(c.title) + '" data-level="' + esc(c.level) + '">✏️ Edit</button></td></tr>').join(''), 'No courses yet.')
        : table(['Course', 'Learner', 'Lessons', 'Tests', 'Created', ''], d.courses.map((c) => '<tr><td><strong>' + esc(c.title) + '</strong></td><td>' + esc(c.owner) + '</td><td class="tabular">' + c.lessons + '</td><td class="tabular">' + c.assessments + '</td><td>' + fmtDate(c.createdAt) + '</td><td><button class="btn-ghost btn-sm" data-edit-course="' + c.id + '" data-self="1" data-title="' + esc(c.title) + '">✏️ Edit</button></td></tr>').join(''), 'No self-study courses yet.'));
      box.addEventListener('drawn', () => box.querySelectorAll('[data-edit-course]').forEach((b) => b.addEventListener('click', () => {
        const self = !!b.dataset.self;
        const m = modal('<div class="modal-head"><h3>Edit course</h3><button class="btn-ghost btn-sm" data-close>✕</button></div>' +
          '<form id="ce-form">' + (self ? '' : '<div class="row"><div><label>Course code</label><input id="ce-code" value="' + esc(b.dataset.code) + '" required></div><div><label>Level</label><input id="ce-level" value="' + esc(b.dataset.level) + '"></div></div>') +
          '<label>Course title</label><input id="ce-title" value="' + esc(b.dataset.title) + '" required>' +
          '<div style="margin-top:14px"><button type="submit" class="btn-gold">Save changes</button></div></form>');
        m.el.querySelector('#ce-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const body = { title: m.el.querySelector('#ce-title').value.trim() };
          if (!self) { body.code = m.el.querySelector('#ce-code').value.trim(); body.level = m.el.querySelector('#ce-level').value.trim(); }
          try { await api('/courses/' + b.dataset.editCourse + (self ? '?kind=self' : ''), { method: 'PATCH', body }); toast('Course updated'); m.close(); box.reload(); } catch (err) { toast(err.message); }
        });
      })));
      const reload = debounce(() => box.reload(true));
      $('co-search').addEventListener('input', reload);
      if ($('co-school')) $('co-school').addEventListener('change', () => box.reload(true));
    });
  }

  // ---------------- demonstrations (digital lab) ----------------
  async function renderDemonstrations() {
    view.innerHTML = '<div class="view-head"><div><h1>Demonstrations</h1><div class="muted">Digital Lab practicals — lecturer-written and AI-generated. Hide one to stop students seeing it.</div></div></div>' +
      '<div class="toolbar"><select id="dm-source"><option value="">All sources</option><option value="CURATED">Lecturer-written</option><option value="AI_GENERATED">AI-generated</option></select><select id="dm-status"><option value="">All</option><option value="APPROVED">Visible</option><option value="REJECTED">Hidden</option></select></div><div id="dm-list"></div>';
    const box = $('dm-list');
    box.addEventListener('drawn', (e) => {
      box.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', async () => {
        const d = await api('/demonstrations/' + b.dataset.view);
        modal('<div class="modal-head"><h3>' + esc(d.title) + '</h3><button class="btn-ghost btn-sm" data-close>✕</button></div><p class="muted">' + esc(d.description) + '</p><ol>' + d.steps.map((s) => '<li style="margin-bottom:8px"><strong>' + esc(s.title) + '</strong><div>' + esc(s.instruction) + '</div>' + (s.expectedResult ? '<div class="small muted">Expected: ' + esc(s.expectedResult) + '</div>' : '') + '</li>').join('') + '</ol>');
      }));
      box.querySelectorAll('[data-set]').forEach((b) => b.addEventListener('click', async () => { try { await api('/demonstrations/' + b.dataset.id, { method: 'PATCH', body: { status: b.dataset.set } }); box.reload(); } catch (err) { toast(err.message); } }));
      box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => { if (!confirm('Delete this demonstration and its attempts?')) return; try { await api('/demonstrations/' + b.dataset.del, { method: 'DELETE' }); box.reload(); } catch (err) { toast(err.message); } }));
    });
    await listView(box, (p) => '/demonstrations?page=' + p + '&source=' + $('dm-source').value + '&status=' + $('dm-status').value, (d) =>
      table(['Practical', 'Where', 'Source', 'Steps', 'Done by', 'Status', ''], d.demonstrations.map((x) => '<tr><td><strong>' + esc(x.title) + '</strong><div class="small muted">' + esc(x.author || '') + '</div></td><td>' + esc(x.where) + '<div class="small muted">' + esc(x.schoolName || '') + '</div></td><td>' + (x.source === 'AI_GENERATED' ? 'AI' : 'Lecturer') + '</td><td class="tabular">' + x.steps + '</td><td class="tabular">' + x.attempts + '</td><td><span class="pill ' + (x.status === 'APPROVED' ? 'ok' : 'bad') + '">' + (x.status === 'APPROVED' ? 'Visible' : 'Hidden') + '</span></td><td style="white-space:nowrap"><button class="btn-ghost btn-sm" data-view="' + x.id + '">View</button> <button class="btn-ghost btn-sm" data-id="' + x.id + '" data-set="' + (x.status === 'APPROVED' ? 'REJECTED' : 'APPROVED') + '">' + (x.status === 'APPROVED' ? 'Hide' : 'Show') + '</button> <button class="btn-ghost btn-sm" data-del="' + x.id + '">Delete</button></td></tr>').join(''), 'No demonstrations yet.'));
    $('dm-source').addEventListener('change', () => box.reload(true)); $('dm-status').addEventListener('change', () => box.reload(true));
  }

  // ---------------- attendance ----------------
  async function renderAttendance() {
    view.innerHTML = '<div class="view-head"><div><h1>Attendance</h1><div class="muted">Class attendance by course and staff check-ins, last 30 days.</div></div></div><div id="at-host"></div>';
    tabs($('at-host'), [['class', 'Classes'], ['staff', 'Staff']], async (tab, body) => {
      body.innerHTML = '<div id="at-list"></div>';
      await listView($('at-list'), (p) => '/attendance?kind=' + tab + '&page=' + p, (d) => tab === 'class'
        ? table(['Course', 'School', 'Present', 'Absent', 'Rate'], d.courses.map((c) => '<tr><td><strong>' + esc(c.code) + '</strong> ' + esc(c.title) + '</td><td>' + esc(c.schoolName || '—') + '</td><td class="tabular">' + c.present + '</td><td class="tabular">' + c.absent + '</td><td><span class="pill ' + (c.rate == null ? '' : c.rate >= 75 ? 'ok' : c.rate >= 50 ? 'warn' : 'bad') + '">' + (c.rate == null ? '—' : c.rate + '%') + '</span></td></tr>').join(''), 'No class attendance recorded in the last 30 days.')
        : '<div class="muted" style="margin-bottom:8px">' + d.today + ' staff checked in today</div>' + table(['Date', 'Name', 'Role', 'School', 'Status'], d.records.map((r) => '<tr><td>' + fmtDate(r.date) + '</td><td><strong>' + esc(r.name) + '</strong></td><td>' + esc(r.role) + '</td><td>' + esc(r.schoolName || '—') + '</td><td><span class="pill ' + (r.status === 'PRESENT' ? 'ok' : 'warn') + '">' + esc(r.status) + '</span></td></tr>').join(''), 'No staff check-ins in the last 30 days.'));
    });
  }

  // ---------------- results ----------------
  async function renderResults() {
    view.innerHTML = '<div class="view-head"><div><h1>Results</h1><div class="muted">Formal results lecturers have recorded, across all schools.</div></div></div>' +
      searchBar('rs-search', 'Search student name or matric number…', null, '<select id="rs-school"></select><select id="rs-sent"><option value="">Drafts &amp; published</option><option value="sent">Published</option><option value="draft">Drafts</option></select>') + '<div id="rs-list"></div>';
    $('rs-school').innerHTML = await schoolOptions();
    const box = $('rs-list');
    await listView(box, (p) => '/results?page=' + p + '&search=' + encodeURIComponent($('rs-search').value.trim()) + '&schoolId=' + $('rs-school').value + '&sent=' + $('rs-sent').value, (d) =>
      '<div class="muted" style="margin-bottom:8px">' + d.sent + ' of ' + d.total + ' published to students</div>' + table(['Student', 'Course', 'School', 'Semester', 'Score', 'Grade', 'By', 'Status'], d.results.map((r) => '<tr><td><strong>' + esc(r.student) + '</strong><div class="small muted">' + esc(r.matric || '') + '</div></td><td>' + esc(r.course) + '</td><td>' + esc(r.schoolName || '—') + '</td><td>' + esc(r.term) + '</td><td class="tabular">' + r.score + '</td><td>' + esc(r.grade || '—') + '</td><td>' + esc(r.by) + '</td><td><span class="pill ' + (r.sentAt ? 'ok' : 'warn') + '">' + (r.sentAt ? 'Published' : 'Draft') + '</span></td></tr>').join(''), 'No results recorded yet.'));
    const reload = debounce(() => box.reload(true));
    $('rs-search').addEventListener('input', reload); $('rs-school').addEventListener('change', () => box.reload(true)); $('rs-sent').addEventListener('change', () => box.reload(true));
  }

  // ---------------- teachers ----------------
  async function renderTeachers() {
    view.innerHTML = '<div class="view-head"><div><h1>Lecturers</h1><div class="muted">Lecturers and non-academic staff at every school.</div></div></div>' +
      searchBar('te-search', 'Search name or staff ID…', null, '<select id="te-school"></select><select id="te-role"><option value="">Lecturers &amp; staff</option><option value="LECTURER">Lecturers</option><option value="STAFF">Non-academic staff</option></select>') + '<div id="te-list"></div>';
    $('te-school').innerHTML = await schoolOptions();
    const box = $('te-list');
    await listView(box, (p) => '/teachers?page=' + p + '&search=' + encodeURIComponent($('te-search').value.trim()) + '&schoolId=' + $('te-school').value + '&role=' + $('te-role').value, (d) =>
      table(['Name', 'School', 'Department', 'Role', 'Courses', 'Lessons', 'Tests', 'Status'], d.teachers.map((t) => '<tr><td><strong>' + esc(t.fullName) + '</strong><div class="small muted">' + esc(t.staffId || t.email || '') + '</div></td><td>' + esc(t.school ? t.school.name : '—') + '</td><td>' + esc(t.department || t.position || '—') + '</td><td>' + (t.role === 'LECTURER' ? 'Lecturer' : 'Staff') + '</td><td class="tabular">' + t.courses + '</td><td class="tabular">' + t.lessons + '</td><td class="tabular">' + t.tests + '</td><td><span class="pill ' + (t.status === 'ACTIVE' ? 'ok' : 'bad') + '">' + esc(t.status) + '</span></td></tr>').join(''), 'No teachers yet.'));
    const reload = debounce(() => box.reload(true));
    $('te-search').addEventListener('input', reload); $('te-school').addEventListener('change', () => box.reload(true)); $('te-role').addEventListener('change', () => box.reload(true));
  }

  // ---------------- school fees (read-only) ----------------
  async function renderFees() {
    const o = await api('/fees/overview');
    const N = (k) => (Number(k || 0) / 100).toLocaleString('en-NG', { maximumFractionDigits: 0 });
    const STATUS = { PENDING: 'Waiting for the school', CONFIRMED: 'Confirmed', REJECTED: 'Rejected' };
    view.innerHTML = '<div class="view-head"><div><h1>School Fees</h1><div class="muted">What students pay their institutions. <strong>View only</strong>: the school confirms every payment itself, so there is nothing here for Learnza staff to confirm, change or delete.</div></div></div>' +
      '<div class="cards">' + cardStat(o.totals.schools, 'Schools') + cardStat(o.totals.schoolsWithBank, 'With bank details') + cardStat('₦' + N(o.totals.confirmedKobo), 'Confirmed') + cardStat('₦' + N(o.totals.pendingKobo), 'Waiting for schools') + cardStat(o.totals.payments, 'Payments') + '</div>' +
      '<h3 style="margin-top:18px">By school</h3>' + table(['School', 'Fee bank account', 'Fee items', 'Confirmed (₦)', 'Confirmed', 'Waiting (₦)', 'Waiting'], o.schools.map((s) => '<tr><td><strong>' + esc(s.name) + '</strong><div class="small muted">' + esc(s.state || '') + '</div></td><td>' + (s.bank ? esc(s.bank.bankName) + ' · ' + esc(s.bank.accountName) + '<div class="small muted">' + esc(s.bank.accountNumber) + '</div>' : '<span class="muted">not added yet</span>') + '</td><td class="tabular">' + s.feeItems + '</td><td class="tabular">' + N(s.confirmedKobo) + '</td><td class="tabular">' + s.confirmedCount + '</td><td class="tabular">' + N(s.pendingKobo) + '</td><td class="tabular">' + s.pendingCount + '</td></tr>').join(''), 'No schools yet.') +
      '<h3 style="margin-top:18px">Payments</h3>' +
      searchBar('fe-search', 'Search student name…', null, '<select id="fe-school">' + '<option value="">All schools</option>' + o.schools.map((s) => '<option value="' + s.id + '">' + esc(s.name) + '</option>').join('') + '</select><select id="fe-status"><option value="">All</option><option value="PENDING">Waiting for the school</option><option value="CONFIRMED">Confirmed</option><option value="REJECTED">Rejected</option></select>') + '<div id="fe-list"></div>';
    const box = $('fe-list');
    box.addEventListener('drawn', () => box.querySelectorAll('tr.clickable').forEach((tr) => tr.addEventListener('click', async () => {
      const { payment: p } = await api('/fees/payments/' + tr.dataset.id);
      const m = modal('<div class="modal-head"><div><h3 style="margin:0">Payment · ' + esc(p.studentName) + '</h3><div class="muted small">' + esc(p.schoolName) + (p.department ? ' · ' + esc(p.department) : '') + (p.level ? ' · ' + esc(p.level) : '') + ' · ' + esc(STATUS[p.status] || p.status) + '</div></div><button class="btn-ghost btn-sm" data-close>✕</button></div>' +
        table(['Paying for', 'Amount (₦)'], p.items.map((i) => '<tr><td>' + esc(i.title) + '</td><td class="tabular">' + N(i.amountKobo) + '</td></tr>').join('') + '<tr><td><strong>Total</strong></td><td class="tabular"><strong>' + N(p.amountKobo) + '</strong></td></tr>') +
        '<div class="kv" style="margin-top:12px"><div class="k">Method</div><div>' + esc(String(p.method).replace('_', ' ').toLowerCase()) + '</div><div class="k">Reference</div><div>' + esc(p.reference || '—') + '</div><div class="k">Paid by</div><div>' + esc(p.depositorName || '—') + '</div><div class="k">Receipt</div><div>' + esc(p.receiptNo || '—') + '</div><div class="k">Sent by</div><div>' + esc(String(p.submittedBy).toLowerCase()) + '</div>' + (p.schoolBank ? '<div class="k">School account</div><div>' + esc(p.schoolBank.bankName) + ' ' + esc(p.schoolBank.accountNumber) + '</div>' : '') + (p.rejectReason ? '<div class="k">Rejected because</div><div>' + esc(p.rejectReason) + '</div>' : '') + (p.note ? '<div class="k">Note</div><div>' + esc(p.note) + '</div>' : '') + '</div>' +
        (p.proofUrl ? '<img alt="Receipt photo" src="' + esc(p.proofUrl) + '" style="max-width:100%;border-radius:8px;margin-top:12px;border:1px solid #d6dae6">' : ''));
      void m;
    })));
    await listView(box, (pg) => '/fees/payments?page=' + pg + '&q=' + encodeURIComponent($('fe-search').value.trim()) + '&schoolId=' + $('fe-school').value + '&status=' + $('fe-status').value, (d) =>
      table(['When', 'School', 'Student', 'Paying for', 'Amount (₦)', 'Method', 'Status'], d.items.map((p) => '<tr class="clickable" data-id="' + p.id + '"><td>' + fmtDateTime(p.createdAt) + '</td><td>' + esc(p.schoolName) + '</td><td><strong>' + esc(p.studentName) + '</strong><div class="small muted">' + esc([p.matricNumber, p.department, p.level].filter(Boolean).join(' · ')) + '</div></td><td>' + esc(clip(p.items.map((i) => i.title).join(', '), 70)) + '</td><td class="tabular">' + N(p.amountKobo) + '</td><td>' + esc(String(p.method).replace('_', ' ').toLowerCase()) + '</td><td>' + esc(STATUS[p.status] || p.status) + '</td></tr>').join(''), 'No payments yet.'));
    const reload = debounce(() => box.reload(true));
    $('fe-search').addEventListener('input', reload); $('fe-school').addEventListener('change', () => box.reload(true)); $('fe-status').addEventListener('change', () => box.reload(true));
  }

  // ---------------- elections (read-only) ----------------
  async function renderElections() {
    view.innerHTML = '<div class="view-head"><div><h1>Elections</h1><div class="muted">Student union (SUG), class representative and lecturer elections run by each school. You see the count and turnout, never who voted for whom. Click an election for the full result.</div></div></div>' +
      searchBar('el-search', 'Search elections…', null, '<select id="el-school"></select><select id="el-state"><option value="">All</option><option value="OPEN">Open</option><option value="UPCOMING">Upcoming</option><option value="CLOSED">Closed</option></select>') + '<div id="el-list"></div>';
    $('el-school').innerHTML = await schoolOptions();
    const box = $('el-list');
    const pill = (s) => '<span class="pill ' + (s === 'OPEN' ? 'ok' : s === 'UPCOMING' ? 'warn' : '') + '">' + esc(s) + '</span>';
    box.addEventListener('drawn', () => box.querySelectorAll('tr.clickable').forEach((tr) => tr.addEventListener('click', async () => {
      const d = await api('/elections/' + tr.dataset.id);
      const t = d.turnout;
      const who = (x, label) => (x ? '<div>' + label + ': <strong>' + x.voted + '</strong> of ' + x.eligible + ' voted</div>' : '');
      const m = modal('<div class="modal-head"><div><h3 style="margin:0">' + esc(d.election.title) + '</h3><div class="muted small">' + esc(d.election.schoolName || '') + ' · ' + (d.election.kind === 'STUDENT_SUG' ? 'Student union (SUG)' : d.election.kind === 'CLASS_REP' ? 'Class representative' + (d.election.courseName ? ' · ' + esc(d.election.courseName) : '') : 'Lecturers') + ' · ' + pill(d.election.state) + '</div></div><button class="btn-ghost btn-sm" data-close>✕</button></div>' +
        '<div class="kv"><div class="k">Turnout</div><div>' + (who(t.students, 'Students') + who(t.lecturers, 'Lecturers') || '—') + '</div><div class="k">Opens</div><div>' + fmtDateTime(d.election.opensAt) + '</div><div class="k">Closes</div><div>' + fmtDateTime(d.election.closesAt) + '</div></div>' +
        d.positions.map((p) => '<h3 style="margin-top:18px">' + esc(p.title) + ' <span class="muted small">' + p.totalVotes + ' vote' + (p.totalVotes === 1 ? '' : 's') + (p.tied ? ' · tied' : '') + '</span></h3>' +
          p.candidates.map((c) => '<div style="margin:8px 0"><div style="display:flex;justify-content:space-between;gap:12px"><span>' + (c.leading ? '🏆 ' : '') + '<strong>' + esc(c.name) + '</strong></span><span class="tabular">' + c.votes + ' · ' + c.percent + '%' + (c.byStudents || c.byLecturers ? ' <span class="muted small">(students ' + c.byStudents + ', lecturers ' + c.byLecturers + ')</span>' : '') + '</span></div><div style="height:8px;border-radius:4px;background:rgba(128,128,128,.25);overflow:hidden;margin-top:4px"><div style="height:100%;width:' + c.percent + '%;background:#c1861f"></div></div></div>').join('')).join(''));
      void m;
    })));
    await listView(box, (p) => '/elections?page=' + p + '&search=' + encodeURIComponent($('el-search').value.trim()) + '&schoolId=' + $('el-school').value + '&state=' + $('el-state').value, (d) =>
      table(['Election', 'School', 'Type', 'Who votes', 'Positions', 'Ballots', 'Status', 'Closes'], d.elections.map((e) => '<tr class="clickable" data-id="' + e.id + '"><td><strong>' + esc(e.title) + '</strong></td><td>' + esc(e.schoolName || '—') + '</td><td>' + (e.kind === 'STUDENT_SUG' ? 'Student union (SUG)' : e.kind === 'CLASS_REP' ? 'Class representative' + (e.courseName ? ' · ' + esc(e.courseName) : '') : 'Lecturers') + '</td><td>' + esc(e.voters.toLowerCase()) + '</td><td class="tabular">' + e.positions + '</td><td class="tabular">' + e.ballots + '</td><td>' + pill(e.state) + '</td><td>' + fmtDateTime(e.closesAt) + '</td></tr>').join(''), 'No elections yet.'));
    const reload = debounce(() => box.reload(true));
    $('el-search').addEventListener('input', reload); $('el-school').addEventListener('change', () => box.reload(true)); $('el-state').addEventListener('change', () => box.reload(true));
  }

  // ---------------- academic records ----------------
  async function renderRecords() {
    view.innerHTML = '<div class="view-head"><div><h1>Academic Records</h1><div class="muted">Each school student\'s level, CGPA, results and conduct record. Click a student for the full record.</div></div></div>' +
      searchBar('ar-search', 'Search name or matric number…', null, '<select id="ar-school"></select>') + '<div id="ar-list"></div>';
    $('ar-school').innerHTML = await schoolOptions();
    const box = $('ar-list');
    box.addEventListener('drawn', () => box.querySelectorAll('tr.clickable').forEach((tr) => tr.addEventListener('click', async () => {
      const d = await api('/academic-records/' + tr.dataset.id);
      const r = d.record;
      modal('<div class="modal-head"><div><h3 style="margin:0">' + esc(r.fullName) + '</h3><div class="muted small">' + esc(d.schoolName) + ' · ' + esc(r.matricNumber || '') + '</div></div><button class="btn-ghost btn-sm" data-close>✕</button></div>' +
        '<div class="kv"><div class="k">Department</div><div>' + esc(r.department || '—') + '</div><div class="k">Level</div><div>' + esc(r.level || '—') + '</div><div class="k">CGPA</div><div>' + (r.cgpa == null ? '—' : r.cgpa + ' / 5.00') + '</div><div class="k">Admitted</div><div>' + esc(r.yearOfAdmission || '—') + '</div><div class="k">Expected graduation</div><div>' + esc(r.expectedGraduationYear || '—') + '</div><div class="k">Class position</div><div>' + esc(r.classPosition || '—') + '</div><div class="k">Status</div><div>' + esc(r.status) + '</div>' +
        '<div class="k">Exams</div><div class="tabular">' + r.exams.done + ' done · ' + r.exams.missed + ' missed</div><div class="k">Tests</div><div class="tabular">' + r.tests.done + ' done · ' + r.tests.missed + ' missed</div><div class="k">Assignments</div><div class="tabular">' + r.assignments.done + ' done · ' + r.assignments.missed + ' missed</div><div class="k">Conduct</div><div>' + (r.disciplinaryIssueCount ? r.disciplinaryIssueCount + ' record(s) on file' : 'Clean') + '</div></div>' +
        '<h3>Published results</h3>' + table(['Course', 'Semester', 'Score', 'Grade'], d.results.map((x) => '<tr><td>' + esc(x.course) + '</td><td>' + esc(x.term) + '</td><td class="tabular">' + x.score + '</td><td>' + esc(x.grade || '—') + '</td></tr>').join(''), 'No published results.') +
        (r.disciplinaryRecords.length ? '<h3 style="margin-top:16px">Disciplinary records</h3>' + table(['Title', 'Status', 'Date'], r.disciplinaryRecords.map((x) => '<tr><td>' + esc(x.title) + '</td><td>' + esc(x.status) + '</td><td>' + fmtDate(x.createdAt) + '</td></tr>').join('')) : ''));
    })));
    await listView(box, (p) => '/academic-records?page=' + p + '&search=' + encodeURIComponent($('ar-search').value.trim()) + '&schoolId=' + $('ar-school').value, (d) =>
      table(['Student', 'School', 'Department', 'Level', 'CGPA', 'Graduates', 'Status'], d.students.map((s) => '<tr class="clickable" data-id="' + s.id + '"><td><strong>' + esc(s.fullName) + '</strong><div class="small muted">' + esc(s.matricNumber || '') + '</div></td><td>' + esc(s.school ? s.school.name : '—') + '</td><td>' + esc(s.department || '—') + '</td><td>' + esc(s.level || '—') + '</td><td class="tabular">' + (s.cgpa == null ? '—' : s.cgpa) + '</td><td>' + esc(s.graduates || '—') + '</td><td><span class="pill ' + (s.status === 'ACTIVE' ? 'ok' : 'bad') + '">' + esc(s.status) + '</span></td></tr>').join(''), 'No school students yet.'));
    const reload = debounce(() => box.reload(true));
    $('ar-search').addEventListener('input', reload); $('ar-school').addEventListener('change', () => box.reload(true));
  }

  // ---------------- bulk email / SMS ----------------
  async function renderBulk(channel) {
    const isEmail = channel === 'EMAIL';
    const schools = await schoolOptions();
    view.innerHTML = '<div class="view-head"><div><h1>' + (isEmail ? 'Bulk Email' : 'Bulk SMS') + '</h1><div class="muted">' + (isEmail ? 'Email a group of people at once.' : 'Text a group of people at once (160 characters per message part).') + ' Only active accounts with ' + (isEmail ? 'a real email address' : 'a phone number') + ' receive it.</div></div></div>' +
      '<div class="panel" style="max-width:720px"><form id="bk-form"><div class="row"><div><label>Send to</label><select id="bk-aud"><option value="EVERYONE">Everyone</option><option value="STUDENTS">Students</option><option value="LECTURERS">Lecturers</option><option value="STAFF">Non-academic staff</option><option value="ADMINS">School admins</option><option value="INDEPENDENT">Independent students</option></select></div><div style="flex:2"><label>School (optional)</label><select id="bk-school">' + schools + '</select></div></div>' +
      (isEmail ? '<label>Subject</label><input id="bk-subject" maxlength="120" required>' : '') +
      '<label>Message</label><textarea id="bk-body" rows="6" maxlength="1500" required></textarea>' + (isEmail ? '' : '<div class="small muted" id="bk-count">0 characters</div>') +
      '<div style="margin-top:14px"><button class="btn-gold" type="submit" id="bk-btn">Send ' + (isEmail ? 'email' : 'SMS') + '</button></div></form><div id="bk-result"></div></div>';
    if (!isEmail) $('bk-body').addEventListener('input', () => { $('bk-count').textContent = $('bk-body').value.length + ' characters'; });
    $('bk-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!confirm('Send this ' + (isEmail ? 'email' : 'SMS') + ' now? It cannot be recalled.')) return;
      $('bk-btn').disabled = true;
      try {
        const r = await api('/bulk', { method: 'POST', body: { channel, audience: $('bk-aud').value, schoolId: $('bk-school').value || undefined, subject: isEmail ? $('bk-subject').value : undefined, body: $('bk-body').value } });
        $('bk-result').innerHTML = '<div class="result-box">Sending to <strong>' + r.deliverable + '</strong> of ' + r.recipients + ' people' + (r.deliverable < r.recipients ? ' (the rest have no ' + (isEmail ? 'email address' : 'phone number') + ')' : '') + '. It continues in the background.</div>';
        $('bk-form').reset();
      } catch (err) { toast(err.message); } finally { $('bk-btn').disabled = false; }
    });
  }

  // ---------------- codes ----------------
  async function renderAccessCodes() {
    view.innerHTML = '<div class="view-head"><div><h1>Access Codes</h1><div class="muted">Join codes for schools and access codes for the people they add. Treat these like passwords.</div></div></div><div id="cd-host"></div>';
    tabs($('cd-host'), [['users', 'Access codes'], ['schools', 'School join codes']], async (tab, body) => {
      if (tab === 'schools') {
        const { schools } = await api('/schools');
        body.innerHTML = table(['School', 'Join code', 'Licence', ''], schools.map((s) => '<tr><td><strong>' + esc(s.name) + '</strong></td><td class="code">' + esc(s.joinCode) + '</td><td>' + licencePill(s.licence) + '</td><td style="white-space:nowrap"><button class="btn-ghost btn-sm" data-copy="' + esc(s.joinCode) + '">Copy</button> <button class="btn-ghost btn-sm" data-regen="' + s.id + '">Issue new</button></td></tr>').join(''), 'No schools yet.');
        body.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => copy(b.dataset.copy)));
        body.querySelectorAll('[data-regen]').forEach((b) => b.addEventListener('click', async () => {
          if (!confirm('Issue a new join code? The old one stops working immediately and the school admin must be given the new one.')) return;
          try { const r = await api('/schools/' + b.dataset.regen + '/regenerate-join-code', { method: 'POST' }); toast('New code: ' + r.joinCode); go('access-codes'); } catch (err) { toast(err.message); }
        }));
        return;
      }
      body.innerHTML = searchBar('cd-search', 'Search name, matric number or staff ID…', null, '<select id="cd-school"></select>') + '<div id="cd-list"></div>';
      $('cd-school').innerHTML = await schoolOptions();
      const box = $('cd-list');
      box.addEventListener('drawn', () => {
        box.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => copy(b.dataset.copy)));
        box.querySelectorAll('[data-regen]').forEach((b) => b.addEventListener('click', async () => {
          if (!confirm('Issue a new access code for ' + b.dataset.name + '? Their old code stops working immediately.')) return;
          try { const r = await api('/codes/users/' + b.dataset.regen + '/regenerate', { method: 'POST' }); toast('New code: ' + r.accessCode); box.reload(); } catch (err) { toast(err.message); }
        }));
      });
      await listView(box, (p) => '/codes/users?page=' + p + '&search=' + encodeURIComponent($('cd-search').value.trim()) + '&schoolId=' + $('cd-school').value, (d) =>
        table(['Person', 'School', 'Role', 'Access code', ''], d.users.map((u) => '<tr><td><strong>' + esc(u.fullName) + '</strong></td><td>' + esc(u.school ? u.school.name : '—') + '</td><td>' + esc(u.role) + '</td><td class="code">' + esc(u.accessCode) + '</td><td style="white-space:nowrap"><button class="btn-ghost btn-sm" data-copy="' + esc(u.accessCode) + '">Copy</button> <button class="btn-ghost btn-sm" data-regen="' + u.id + '" data-name="' + esc(u.fullName) + '">Issue new</button></td></tr>').join(''), 'No access codes found.'));
      const reload = debounce(() => box.reload(true));
      $('cd-search').addEventListener('input', reload); $('cd-school').addEventListener('change', () => box.reload(true));
    });
  }

  // ---------------- system logs ----------------
  async function renderSystemLogs() {
    view.innerHTML = '<div class="view-head"><div><h1>System Logs</h1><div class="muted">Errors and warnings from the server. A spike here usually means something is wrong before users tell you.</div></div><button class="btn-ghost" id="sl-clear">Clear old logs…</button></div>' +
      searchBar('sl-search', 'Search message or path…', null, '<select id="sl-level"><option value="">All levels</option><option>ERROR</option><option>WARN</option><option>INFO</option></select>') + '<div id="sl-list"></div>';
    const box = $('sl-list');
    box.addEventListener('drawn', (e) => { box.lastDrawn = e.detail; });
    box.addEventListener('drawn', () => box.querySelectorAll('[data-detail]').forEach((b) => b.addEventListener('click', () => {
      const row = box.lastDrawn.logs.find((l) => l.id === b.dataset.detail);
      modal('<div class="modal-head"><h3>' + esc(row.message) + '</h3><button class="btn-ghost btn-sm" data-close>✕</button></div><div class="muted small">' + fmtDateTime(row.createdAt) + ' · ' + esc(row.source) + (row.method ? ' · ' + esc(row.method) + ' ' + esc(row.path || '') : '') + '</div><pre style="white-space:pre-wrap;font-size:12px;max-height:50vh;overflow:auto">' + esc(row.detail || 'No further detail.') + '</pre>');
    })));
    await listView(box, (p) => '/system-logs?page=' + p + '&level=' + $('sl-level').value + '&search=' + encodeURIComponent($('sl-search').value.trim()), (d) =>
      '<div class="muted" style="margin-bottom:8px">' + d.errors24h + ' error' + (d.errors24h === 1 ? '' : 's') + ' in the last 24 hours</div>' + table(['When', 'Level', 'Source', 'Message', 'Where', ''], d.logs.map((l) => '<tr><td>' + fmtDateTime(l.createdAt) + '</td><td><span class="pill ' + (l.level === 'ERROR' ? 'bad' : l.level === 'WARN' ? 'warn' : 'ok') + '">' + esc(l.level) + '</span></td><td>' + esc(l.source) + '</td><td style="white-space:normal;max-width:380px">' + esc(clip(l.message, 160)) + '</td><td class="small">' + esc((l.method || '') + ' ' + (l.path || '')) + '</td><td>' + (l.detail ? '<button class="btn-ghost btn-sm" data-detail="' + l.id + '">Details</button>' : '') + '</td></tr>').join(''), 'No logs — all quiet.'));
    const reload = debounce(() => box.reload(true));
    $('sl-search').addEventListener('input', reload); $('sl-level').addEventListener('change', () => box.reload(true));
    $('sl-clear').addEventListener('click', async () => {
      const days = prompt('Delete logs older than how many days? (0 deletes everything)', '30');
      if (days == null) return;
      try { const r = await api('/system-logs?olderThanDays=' + encodeURIComponent(days), { method: 'DELETE' }); toast(r.deleted + ' deleted'); box.reload(true); } catch (err) { toast(err.message); }
    });
  }

  // ---------------- Code Editor / Live Preview / Codes (modelled on PassNow's) ----------------
  // Saves are live immediately and each one keeps a backup; JavaScript that does not parse is
  // refused. All three views share these helpers.
  const APP_FILES = {
    app: { label: 'Learnza App (student)', files: ['app.js', 'app.html', 'auth.css'], page: '/app' },
    schools: { label: 'Learnza For Schools', files: ['schools.js', 'schools.html', 'auth.css'], page: '/schools' },
    shared: { label: 'Shared', files: ['extras.js', 'style.css', 'legal.html', 'legal.js', 'verify.html', 'verify.js'], page: null },
  };
  async function codeFileOptions(selected) {
    const { files } = await api('/code/files');
    const by = new Map(files.map((f) => [f.path, f]));
    const opt = (p) => by.has(p) ? '<option value="' + esc(p) + '" ' + (p === selected ? 'selected' : '') + '>' + esc(p) + (by.get(p).customised ? ' ✎' : '') + ' (' + Math.round(by.get(p).size / 1024) + ' KB)</option>' : '';
    const listed = new Set(Object.values(APP_FILES).flatMap((g) => g.files));
    const rest = files.filter((f) => !listed.has(f.path)).map((f) => f.path);
    return Object.values(APP_FILES).map((g) => '<optgroup label="' + esc(g.label) + '">' + g.files.map(opt).join('') + '</optgroup>').join('') + (rest.length ? '<optgroup label="Other">' + rest.map(opt).join('') + '</optgroup>' : '');
  }

  // ----- Code Editor: find a snippet, see it in context, replace it -----
  async function renderCodeEditor() {
    view.innerHTML = '<div class="view-head"><div><h1>Code Editor</h1><div class="muted">Edit the live front-end source. Changes save immediately — no separate deploy step. Search for an exact snippet, check it is the right spot, then replace it. Every change keeps a backup you can undo below.</div></div></div>' +
      '<h3>Jump to a known feature</h3><p class="muted small">Pick a screen to fill in the search for its code — or type your own search below.</p><div id="ce-features" class="chips"></div>' +
      '<div class="toolbar"><select id="ce-file"></select><input id="ce-search" placeholder="Text to find (exact match)…" style="flex:1;min-width:260px"><button class="btn-gold" id="ce-go">Search</button><button class="btn-ghost" id="ce-original" title="Remove every edit of this file">Restore original…</button></div>' +
      '<div id="ce-results"></div>' +
      '<div id="ce-replace" class="panel hidden"><h3>Replace</h3><label>Replace with</label><textarea id="ce-with" rows="5" style="font-family:monospace;font-size:12.5px"></textarea>' +
      '<div style="margin-top:10px;display:flex;gap:14px;align-items:center;flex-wrap:wrap"><label style="margin:0;font-weight:500"><input type="checkbox" id="ce-all" style="width:auto"> Replace all occurrences</label><button class="btn-gold" id="ce-apply">Apply &amp; save</button><span id="ce-status" class="small"></span></div></div>' +
      '<h3 style="margin-top:24px">Backups (undo)</h3><div id="ce-backups"></div>';
    $('ce-file').innerHTML = await codeFileOptions('app.js');
    let chosen = null; // which match the owner picked when there are several

    async function loadFeatures() {
      const { features } = await api('/code/features?file=' + encodeURIComponent($('ce-file').value));
      if (!$('ce-features')) return;
      $('ce-features').innerHTML = features.length ? features.map((f, i) => '<span class="chip" data-i="' + i + '">' + esc(f.label) + '</span>').join('') : '<span class="muted small">No screen index for this kind of file — use the search box.</span>';
      $('ce-features').querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => { $('ce-search').value = features[c.dataset.i].search; search(); }));
    }
    async function search() {
      const query = $('ce-search').value;
      if (!query) return toast('Type the text to look for');
      chosen = null;
      $('ce-replace').classList.add('hidden');
      try {
        const r = await api('/code/search', { method: 'POST', body: { file: $('ce-file').value, query } });
        if (!$('ce-results')) return;
        if (!r.totalMatches) { $('ce-results').innerHTML = '<p class="muted">No match for that exact text in ' + esc(r.file) + '.</p>'; return; }
        $('ce-results').innerHTML = '<p class="muted small">' + r.totalMatches + (r.truncated ? '+' : '') + ' match' + (r.totalMatches === 1 ? '' : 'es') + ' in ' + esc(r.file) + '. ' + (r.totalMatches > 1 ? 'Pick the one to change, or replace all.' : '') + '</p>' +
          r.matches.map((m, i) => '<label class="ce-match"><input type="radio" name="ce-pick" value="' + i + '" ' + (r.totalMatches === 1 ? 'checked' : '') + '> <span class="small muted">line ' + m.line + '</span><pre>' + esc(m.before) + '<mark>' + esc(m.match) + '</mark>' + esc(m.after) + '</pre></label>').join('');
        $('ce-results').querySelectorAll('input[name=ce-pick]').forEach((r2) => r2.addEventListener('change', () => { chosen = Number(r2.value); }));
        if (r.totalMatches === 1) chosen = 0;
        $('ce-with').value = query;
        $('ce-replace').classList.remove('hidden');
      } catch (err) { toast(err.message); }
    }
    async function backups() {
      const { backups } = await api('/code/backups');
      if (!$('ce-backups')) return;
      $('ce-backups').innerHTML = table(['File', 'Saved over', 'By', 'Note', 'Size', ''], backups.map((b) => '<tr><td><strong>' + esc(b.path) + '</strong></td><td>' + fmtDateTime(b.createdAt) + '</td><td>' + esc(b.authorEmail || '—') + '</td><td style="white-space:normal;max-width:260px">' + esc(b.note || '') + '</td><td class="tabular">' + Math.round(b.size / 1024) + ' KB</td><td><button class="btn-ghost btn-sm" data-restore="' + b.id + '" data-file="' + esc(b.path) + '">Restore this</button></td></tr>').join(''), 'No backups yet — one is made each time you save.');
      $('ce-backups').querySelectorAll('[data-restore]').forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('Put back this earlier version of ' + b.dataset.file + '? The current version is kept as a backup too.')) return;
        try { await api('/code/restore', { method: 'POST', body: { backupId: b.dataset.restore } }); toast('Restored'); backups(); } catch (err) { toast(err.message); }
      }));
    }
    $('ce-file').addEventListener('change', () => { $('ce-results').innerHTML = ''; $('ce-replace').classList.add('hidden'); loadFeatures(); });
    $('ce-go').addEventListener('click', search);
    $('ce-original').addEventListener('click', async () => {
      const file = $('ce-file').value;
      if (!confirm('Remove every edit of ' + file + ' and go back to the copy that shipped with the last deploy? It goes live immediately; your edits stay in Backups.')) return;
      try { await api('/code/revert', { method: 'POST', body: { path: file } }); toast('Original restored'); $('ce-results').innerHTML = ''; $('ce-replace').classList.add('hidden'); backups(); } catch (err) { toast(err.message); }
    });
    $('ce-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
    $('ce-apply').addEventListener('click', async () => {
      const all = $('ce-all').checked;
      const find = $('ce-search').value;
      const body = { file: $('ce-file').value, find, replaceWith: $('ce-with').value, replaceAll: all };
      if (!all && chosen != null) body.occurrenceIndex = chosen;
      if (!confirm((all ? 'Replace every occurrence' : 'Apply this change') + ' in ' + body.file + '? It goes live immediately for all users (a backup is kept).')) return;
      $('ce-status').textContent = 'Saving…';
      try { const r = await api('/code/replace', { method: 'POST', body }); $('ce-status').textContent = 'Saved — ' + r.replaced + ' replaced.'; toast('Saved'); $('ce-results').innerHTML = ''; $('ce-replace').classList.add('hidden'); backups(); } catch (err) { $('ce-status').textContent = ''; toast(err.message); }
    });
    await Promise.all([loadFeatures(), backups()]);
  }

  // ----- Live Preview: the real running app, with a jump-to-screen menu -----
  async function renderPreview() {
    view.innerHTML = '<div class="view-head"><div><h1>Live Preview</h1><div class="muted">The actual running app, exactly as users see it — not a mockup. Sign in inside the frame with any account, then use “Jump to screen” to go straight to a screen instead of clicking through.</div></div></div>' +
      '<div class="toolbar"><select id="lp-app"><option value="/app">Learnza App (student)</option><option value="/schools">Learnza For Schools</option></select><select id="lp-screen"><option value="">— Jump to screen —</option></select><button class="btn-ghost" id="lp-refresh">Refresh screen list</button><button class="btn-ghost" id="lp-reload">↻ Reload</button></div>' +
      '<iframe id="lp-frame" src="/app" title="Live preview" style="width:100%;height:75vh;border:1px solid var(--line);border-radius:10px;background:#fff"></iframe>';
    const frame = $('lp-frame');
    function screens() {
      let doc;
      try { doc = frame.contentDocument; } catch { return; }
      if (!doc) return;
      const items = [...doc.querySelectorAll('.nav-item[data-screen]')].map((b) => [b.dataset.screen, b.textContent.trim()]);
      $('lp-screen').innerHTML = '<option value="">— Jump to screen' + (items.length ? '' : ' (sign in first)') + ' —</option>' + items.map(([k, l]) => '<option value="' + esc(k) + '">' + esc(l) + '</option>').join('');
    }
    frame.addEventListener('load', () => { screens(); clearInterval(window.__lpTimer); window.__lpTimer = setInterval(() => { if (!$('lp-frame')) return clearInterval(window.__lpTimer); screens(); }, 4000); });
    $('lp-app').addEventListener('change', () => { frame.src = $('lp-app').value; });
    $('lp-reload').addEventListener('click', () => frame.contentWindow.location.reload());
    $('lp-refresh').addEventListener('click', screens);
    $('lp-screen').addEventListener('change', () => {
      const key = $('lp-screen').value;
      if (!key) return;
      const btn = frame.contentDocument.querySelector('.nav-item[data-screen="' + key + '"]');
      if (btn) btn.click(); else toast('That screen is not in the menu for this account.');
    });
  }

  // ----- Codes: the whole raw source of a file -----
  async function renderCodes() {
    view.innerHTML = '<div class="view-head"><div><h1>Codes</h1><div class="muted">The complete, raw source of either app — not a curated snippet. Load a file, edit it directly, and Save writes the whole file. Live immediately; a backup of the previous version is kept.</div></div></div>' +
      '<div class="toolbar"><button class="btn-gold" id="cd-app">📱 Learnza App (student)</button><button class="btn-gold" id="cd-schools">🏫 Learnza For Schools</button><select id="cd-file"></select></div>' +
      '<div id="cd-wrap" class="hidden"><div class="toolbar" style="justify-content:space-between"><div><strong id="cd-name"></strong> <span class="muted small" id="cd-meta"></span></div><div style="display:flex;gap:8px"><button class="btn-ghost" id="cd-original">Restore original…</button><button class="btn-ghost" id="cd-reload">↻ Reload (discard edits)</button><button class="btn-gold" id="cd-save">💾 Save</button></div></div>' +
      '<p id="cd-status" class="small" style="min-height:1.2em"></p>' +
      '<div class="toolbar"><input id="cd-find" placeholder="Search for a feature name, function, or any text…" style="flex:1;min-width:260px"><button class="btn-ghost" id="cd-next">🔍 Find next</button><span class="muted small" id="cd-found"></span></div>' +
      '<textarea id="cd-text" spellcheck="false" wrap="off" style="width:100%;height:65vh;font-family:ui-monospace,Consolas,monospace;font-size:12.5px;line-height:1.5;white-space:pre;tab-size:2"></textarea></div>';
    $('cd-file').innerHTML = '<option value="">— or pick any file —</option>' + (await codeFileOptions(''));
    let file = null;
    let original = '';
    const dirty = () => file && $('cd-text').value !== original;

    async function load(path) {
      if (dirty() && !confirm('You have unsaved changes. Discard them?')) { $('cd-file').value = file || ''; return; }
      $('cd-status').textContent = 'Loading…';
      try {
        const r = await api('/code/content?path=' + encodeURIComponent(path));
        file = r.path; original = r.content;
        $('cd-wrap').classList.remove('hidden');
        $('cd-text').value = r.content;
        $('cd-name').textContent = r.path;
        $('cd-meta').textContent = r.lines.toLocaleString() + ' lines · ' + Math.round(r.size / 1024) + ' KB' + (r.customised ? ' · edited' : '');
        $('cd-file').value = r.path;
        $('cd-status').textContent = '';
        $('cd-found').textContent = '';
      } catch (err) { $('cd-status').textContent = ''; toast(err.message); }
    }
    async function save() {
      if (!file) return;
      if (!dirty()) return toast('Nothing to save');
      if (!confirm('Save ' + file + '? It goes live immediately for all users (a backup of the current version is kept).')) return;
      $('cd-status').textContent = 'Saving…';
      try {
        await api('/code/save', { method: 'POST', body: { path: file, content: $('cd-text').value } });
        original = $('cd-text').value;
        $('cd-status').textContent = 'Saved ✓ — live now.';
        $('cd-meta').textContent = $('cd-text').value.split('\n').length.toLocaleString() + ' lines · edited';
        toast('Saved');
      } catch (err) { $('cd-status').textContent = ''; $('cd-status').innerHTML = '<span class="error-msg">' + esc(err.message) + '</span>'; }
    }
    $('cd-app').addEventListener('click', () => load('app.js'));
    $('cd-schools').addEventListener('click', () => load('schools.js'));
    $('cd-file').addEventListener('change', () => { if ($('cd-file').value) load($('cd-file').value); });
    $('cd-reload').addEventListener('click', () => { if (!file) return; original = ''; load(file); });
    $('cd-save').addEventListener('click', save);
    $('cd-original').addEventListener('click', async () => {
      if (!file) return;
      if (!confirm('Remove every edit of ' + file + ' and go back to the copy that shipped with the last deploy? It goes live immediately; your edits stay in Backups.')) return;
      try { await api('/code/revert', { method: 'POST', body: { path: file } }); toast('Original restored'); original = ''; load(file); } catch (err) { toast(err.message); }
    });
    $('cd-text').addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); }
      if (e.key === 'Tab') { e.preventDefault(); const t = e.target; const s = t.selectionStart; t.setRangeText('  ', s, t.selectionEnd, 'end'); }
    });
    function findNext() {
      const q = $('cd-find').value;
      const ta = $('cd-text');
      if (!q) return;
      let i = ta.value.indexOf(q, ta.selectionEnd);
      let wrapped = false;
      if (i === -1) { i = ta.value.indexOf(q); wrapped = true; }
      if (i === -1) { $('cd-found').textContent = 'Not found'; return; }
      ta.focus();
      ta.setSelectionRange(i, i + q.length);
      const line = ta.value.slice(0, i).split('\n').length;
      ta.scrollTop = Math.max(0, (line - 6) * 18.75);
      $('cd-found').textContent = 'Line ' + line + (wrapped ? ' (from the top)' : '');
    }
    $('cd-next').addEventListener('click', findNext);
    $('cd-find').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); findNext(); } });
    window.onbeforeunload = () => (dirty() ? 'You have unsaved changes.' : undefined);
  }

  // ---------------- boot ----------------
  if (token && me) showApp();
})();
