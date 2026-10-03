(function () {
  'use strict';

  const API = '/api/super';
  const TOKEN_KEY = 'lz_admin_token';
  const USER_KEY = 'lz_admin_user';
  let token = sessionStorage.getItem(TOKEN_KEY);
  let me = JSON.parse(sessionStorage.getItem(USER_KEY) || 'null');

  const STATES = ['Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue', 'Borno', 'Cross River', 'Delta', 'Ebonyi', 'Edo', 'Ekiti', 'Enugu', 'FCT (Abuja)', 'Gombe', 'Imo', 'Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Kogi', 'Kwara', 'Lagos', 'Nasarawa', 'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo', 'Plateau', 'Rivers', 'Sokoto', 'Taraba', 'Yobe', 'Zamfara'];

  const $ = (id) => document.getElementById(id);
  const view = $('view');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtDate(d) { return d ? new Date(d).toLocaleDateString() : '—'; }
  function fmtDateTime(d) { return d ? new Date(d).toLocaleString() : '—'; }

  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  async function api(path, opts = {}) {
    const res = await fetch((opts.base || API) + path, {
      method: opts.method || 'GET',
      headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && token) { logout(); throw new Error('Session expired. Please sign in again.'); }
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
    token = null; me = null;
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(USER_KEY);
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
      token = data.token; me = data.user;
      sessionStorage.setItem(TOKEN_KEY, token);
      sessionStorage.setItem(USER_KEY, JSON.stringify(me));
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
        await api('/change-password', { base: '/api/auth', method: 'POST', body: { currentPassword: m.el.querySelector('#cp-current').value, newPassword: m.el.querySelector('#cp-new').value } });
        toast('Password changed');
        m.close();
      } catch (err) { toast(err.message); }
    });
  });

  // ---------------- navigation ----------------
  const views = { dashboard: renderDashboard, schools: renderSchools, users: renderUsers, admins: renderAdmins, audit: renderAudit };

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

  // ---------------- boot ----------------
  if (token && me) showApp();
})();
