(function () {
  'use strict';

  // Every browser tab keeps its own sign-in, so signing in as someone else in another tab (a lecturer
  // in one, the school admin in another) can never change who THIS tab is. The sign-in is held in this
  // tab's sessionStorage and, for browsers that lose that on a refresh, in a copy in localStorage that
  // is keyed by the tab's own name (window.name belongs to the tab and survives a refresh). A tab that
  // is opened fresh has no name yet, so it asks for a sign-in instead of quietly taking over whichever
  // account last signed in anywhere.
  const TAB_ID = (function () {
    try {
      if (!/^lzt_/.test(window.name)) window.name = 'lzt_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      return window.name;
    } catch { return 'lzt_x'; }
  })();
  const lsKey = (key) => key + '@' + TAB_ID;
  (function tidyOldSessions() {
    try {
      const now = Date.now();
      for (const k of Object.keys(localStorage)) {
        const m = /^(lz_[a-z]+_)stamp@(lzt_.+)$/.exec(k);
        if (m && now - Number(localStorage.getItem(k) || 0) > 14 * 864e5) {
          for (const part of ['token', 'user', 'refresh', 'stamp']) localStorage.removeItem(m[1] + part + '@' + m[2]);
        }
      }
      // the one shared "last active" copy older versions kept: it is what let tabs swap accounts
      for (const part of ['token', 'user', 'refresh']) localStorage.removeItem('lz_app_' + part);
    } catch { /* storage unavailable */ }
  })();
  function readSession(key) {
    return sessionStorage.getItem(key) || localStorage.getItem(lsKey(key));
  }
  function saveSession(token, user, refreshToken) {
    const put = (key, value) => { sessionStorage.setItem(key, value); localStorage.setItem(lsKey(key), value); };
    put('lz_app_token', token);
    put('lz_app_user', JSON.stringify(user));
    if (refreshToken) put('lz_app_refresh', refreshToken);
    localStorage.setItem(lsKey('lz_app_stamp'), String(Date.now()));
  }
  function clearSession() {
    for (const part of ['token', 'user', 'refresh', 'stamp']) {
      sessionStorage.removeItem('lz_app_' + part);
      localStorage.removeItem(lsKey('lz_app_' + part));
    }
  }

  const state = {
    token: readSession('lz_app_token') || null,
    refreshToken: readSession('lz_app_refresh') || null,
    user: JSON.parse(readSession('lz_app_user') || 'null'),
    schoolId: null,
    view: { screen: 'home', courseId: null, groupId: null, assessmentId: null },
  };
  // Seed this tab's own sessionStorage immediately so it's independent from here on --
  // later logins in other tabs (which only touch localStorage's "last active" copy)
  // won't affect this tab even though it fell back to localStorage just now.
  if (state.token && state.user) saveSession(state.token, state.user, state.refreshToken);
  let examTimerHandle = null; // the countdown interval from renderTakeAssessment, if any

  // Dark Mode (Settings > Appearance) -- a per-device preference, applied immediately
  // on boot (before any render) so there's no flash of the wrong theme. No preference
  // stored means "follow the system", which app.html's CSS already handles on its own
  // via prefers-color-scheme.
  (function applyStoredTheme() {
    const theme = localStorage.getItem('vp_theme');
    if (theme === 'dark' || theme === 'light') document.documentElement.setAttribute('data-theme', theme);
  })();

  // ---------- API helper ----------
  // Access tokens last 15 minutes. When one lapses the server answers 401; the refresh
  // token (kept per tab, like the access token) is swapped for a new pair and the request
  // is retried once, so nobody is signed out mid-lesson. Several requests failing at the
  // same moment share one refresh call.
  let refreshInFlight = null;
  function refreshSession() {
    if (!refreshInFlight) {
      refreshInFlight = fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: state.refreshToken }),
      })
        .then(async (res) => {
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            const err = new Error(data.error || 'Your session expired. Please sign in again.');
            err.status = res.status;
            throw err;
          }
          state.token = data.token;
          state.refreshToken = data.refreshToken;
          if (data.user) state.user = data.user;
          saveSession(state.token, state.user, state.refreshToken);
        })
        .finally(() => { refreshInFlight = null; });
    }
    return refreshInFlight;
  }

  // Back to the sign-in screen, with a one-line reason shown on the way.
  function endSession(message) {
    clearSession();
    if (message) sessionStorage.setItem('lz_notice', message);
    window.location.href = '/app';
  }

  const BLOCKED_CODES = ['SCHOOL_SUSPENDED', 'SCHOOL_LICENCE_EXPIRED', 'ACCOUNT_INACTIVE'];

  async function api(path, opts = {}) {
    const send = () => {
      const headers = Object.assign({}, opts.headers);
      if (!(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
      if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
      return fetch('/api' + path, {
        method: opts.method || 'GET',
        headers,
        body: opts.body instanceof FormData ? opts.body : opts.body ? JSON.stringify(opts.body) : undefined,
      });
    };
    let res = await send();
    if (res.status === 401 && state.token) {
      if (state.refreshToken) {
        try {
          await refreshSession();
          res = await send();
        } catch (err) {
          if (err.status === 401 || err.status === 403) endSession(err.status === 403 ? err.message : 'Your session expired. Please sign in again.');
          throw err;
        }
      }
      if (res.status === 401) endSession('Your session expired. Please sign in again.');
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 403 && state.token && BLOCKED_CODES.includes(data.code)) endSession(data.error);
    if (!res.ok) {
      const err = new Error(data.error || 'Something went wrong');
      err.code = data.code;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Show/hide toggle for every password field -- delegated on document so it works
  // for any .password-field/.pw-toggle-btn pair regardless of which screen rendered
  // it or when, with nothing to wire up per-field.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.pw-toggle-btn');
    if (!btn) return;
    const input = btn.parentElement.querySelector('input');
    if (!input) return;
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.textContent = showing ? '👁' : '🙈';
  });

  // Terms & Conditions / Privacy Policy links open in an in-app modal (an iframe onto
  // legal.html) instead of a new tab -- so a registration form's filled-in fields stay
  // intact instead of being abandoned in a background tab. Delegated on document, same
  // pattern as the password toggle above, so it works from any [data-legal] link
  // regardless of which screen rendered it.
  document.addEventListener('click', (e) => {
    const link = e.target.closest('[data-legal]');
    if (!link) return;
    e.preventDefault();
    const backdrop = document.createElement('div');
    backdrop.style.cssText = 'position:fixed; inset:0; background:rgba(20,32,51,0.55); z-index:290;';
    const box = document.createElement('div');
    box.className = 'card';
    box.style.cssText = 'position:fixed; inset:0; margin:auto; width:min(720px,94vw); height:min(80vh,760px); padding:0; z-index:300; overflow:hidden; display:flex; flex-direction:column;';
    box.innerHTML = `
      <div style="display:flex; justify-content:flex-end; padding:8px 8px 0;">
        <button id="legal-modal-close" class="btn btn-ghost btn-sm" aria-label="Close">✕</button>
      </div>
      <iframe src="legal.html#${link.dataset.legal}" title="Terms &amp; Conditions and Privacy Policy" style="flex:1; border:0; width:100%;"></iframe>
    `;
    document.body.appendChild(backdrop);
    document.body.appendChild(box);
    const close = () => { backdrop.remove(); box.remove(); };
    box.querySelector('#legal-modal-close').addEventListener('click', close);
    backdrop.addEventListener('click', close);
  });

  // MCQ option letters -- always A/B/C/D (E/F as a fallback for any question with
  // more than 4 options), matching PassNow's exam-taking convention.
  const OPTION_LABELS = ['A', 'B', 'C', 'D', 'E', 'F'];

  // Reflects the real backend gate (src/subscription.js's REQUIRE_SUBSCRIPTION toggle)
  // instead of a hardcoded "Subscription feature" label that would keep implying a
  // paywall while testing has it switched off -- flips itself back once launched.
  async function subscriptionBadgeHtml() {
    const { subscriptionEnforced } = await api('/config').catch(() => ({ subscriptionEnforced: true }));
    return subscriptionEnforced
      ? '<span class="pill pill-accent">Subscription feature</span>'
      : '<span class="pill pill-pass">Free during testing</span>';
  }

  // Falls back to a hidden-textarea copy when navigator.clipboard is unavailable (e.g.
  // a non-HTTPS embedded webview) rather than silently doing nothing.
  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed; opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch {}
      ta.remove();
    }
    toast('Copied to clipboard');
  }

  function toast(msg) {
    let stack = document.getElementById('toast-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'toast-stack';
      stack.style.cssText = 'position:fixed; bottom:20px; right:20px; display:flex; flex-direction:column-reverse; gap:8px; z-index:100;';
      document.body.appendChild(stack);
    }
    const t = document.createElement('div');
    t.className = 'toast';
    t.style.position = 'static';
    t.textContent = msg;
    stack.appendChild(t);
    setTimeout(() => t.remove(), 3200);
  }

  // The AI provider's raw error text ("You exceeded your current quota, please check
  // your plan and billing details." / "This model is currently experiencing high
  // demand. Spikes in demand are usually temporary.") reflects a real upstream
  // condition, not a bug in the app -- surfaced as a friendlier, less alarming message
  // than passing that raw text straight through everywhere an AI call can fail. Kept
  // as two separate messages since they're different situations: one is this app
  // hitting its own usage limit, the other is the provider itself being overloaded.
  function aiErrorMessage(err) {
    const msg = (err && err.message) || '';
    if (/quota|rate.?limit|resource.?exhausted|too many requests/i.test(msg)) {
      return "The AI Lecturer is getting a lot of use right now and has hit its provider limit — please try again in a few minutes.";
    }
    if (/high demand|overloaded|unavailable|\b503\b|\b502\b/i.test(msg)) {
      return "The AI Lecturer's provider is temporarily overloaded — please try again in a few minutes.";
    }
    return msg || 'Something went wrong. Please try again.';
  }

  // ---------- Auth screen ----------
  const authScreen = document.getElementById('auth-screen');
  const appScreen = document.getElementById('app-screen');

  // The sign-in screens are a stack of panels (#lg-*), one visible at a time. Any element
  // inside #auth-screen with a data-go="panel-id" attribute switches to that panel.
  function showAuthPanel(id) {
    authScreen.querySelectorAll('.lg-s').forEach((p) => p.classList.toggle('on', p.id === id));
    const panel = document.getElementById(id);
    if (panel) panel.scrollTop = 0;
  }
  document.addEventListener('click', (e) => {
    const el = e.target.closest('#auth-screen [data-go]');
    if (!el) return;
    e.preventDefault();
    const who = el.dataset.who;
    if (who && document.getElementById('lg-code-title')) {
      document.getElementById('lg-code-title').textContent = who === 'student' ? 'Student Sign In' : 'Lecturer / Staff Sign In';
      document.getElementById('lg-code-hint').textContent = who === 'student'
        ? 'Your school has already registered you. Enter your full name, your school\'s name and the Access Code your school gave you.'
        : 'Your school administrator added you. Enter your full name, your school\'s name and the Access Code they gave you.';
    }
    showAuthPanel(el.dataset.go);
  });

  // Disables a form's submit button while its request is in flight so a slow connection
  // can't send the same sign-in twice, and always re-enables it afterwards.
  async function submitting(buttonId, fn) {
    const btn = document.getElementById(buttonId);
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Please wait…';
    try { await fn(); } catch (err) { toast(err.message); } finally { btn.disabled = false; btn.textContent = label; }
  }

  // Let the browser's password manager keep the sign-in (Chrome is handed the details when it works);
  // the last email used is remembered here, never the password.
  function rememberLogin(id, secret) {
    try {
      localStorage.setItem('lz_last_email', id);
      if (window.PasswordCredential && navigator.credentials && navigator.credentials.store) navigator.credentials.store(new PasswordCredential({ id, password: secret, name: id }));
    } catch { /* the browser will offer to save it by itself */ }
  }
  try { const le = localStorage.getItem('lz_last_email'), el = document.getElementById('lg-login-email'); if (le && el && !el.value) el.value = le; } catch { /* private mode */ }

  document.getElementById('lg-login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    submitting('lg-login-submit', async () => {
      const { token, user, refreshToken } = await api('/auth/login', {
        method: 'POST',
        body: {
          email: document.getElementById('lg-login-email').value.trim(),
          password: document.getElementById('lg-login-pw').value,
        },
      });
      rememberLogin(document.getElementById('lg-login-email').value.trim(), document.getElementById('lg-login-pw').value);
      onAuthed(token, user, refreshToken);
    });
  });

  document.getElementById('lg-forgot-form').addEventListener('submit', (e) => {
    e.preventDefault();
    submitting('lg-forgot-submit', async () => {
      const r = await api('/auth/password/forgot', { method: 'POST', body: { email: document.getElementById('lg-forgot-email').value.trim() } });
      toast(r.message);
      showAuthPanel('lg-login');
    });
  });

  // The reset link in the email is /app#reset=<token>. The token is lifted out of the URL
  // straight away (boot below) so it doesn't linger in the address bar or history.
  let resetToken = null;
  function openResetFromHash() {
    const m = location.hash.match(/reset=([A-Za-z0-9_-]+)/);
    if (!m) return false;
    resetToken = m[1];
    history.replaceState(null, '', location.pathname);
    showAuthPanel('lg-reset');
    return true;
  }
  // Also react when the fragment changes inside an already-open page (a same-page link
  // doesn't reload, so boot alone would miss it).
  window.addEventListener('hashchange', () => { if (!state.token) openResetFromHash(); });
  document.getElementById('lg-reset-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (document.getElementById('lg-reset-pw').value !== document.getElementById('lg-reset-pw2').value) {
      toast('Your two passwords do not match.');
      return;
    }
    submitting('lg-reset-submit', async () => {
      await api('/auth/password/reset', { method: 'POST', body: { token: resetToken, password: document.getElementById('lg-reset-pw').value } });
      resetToken = null;
      toast('Password updated — sign in with your new password.');
      showAuthPanel('lg-login');
    });
  });

  document.getElementById('lg-register-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (document.getElementById('lg-reg-pw').value !== document.getElementById('lg-reg-pw2').value) {
      toast('Your two passwords do not match.');
      return;
    }
    submitting('lg-reg-submit', async () => {
      const { token, user, refreshToken } = await api('/auth/register-individual', {
        method: 'POST',
        body: {
          fullName: document.getElementById('lg-reg-name').value.trim(),
          email: document.getElementById('lg-reg-email').value.trim(),
          phone: document.getElementById('lg-reg-phone').value.trim(),
          institutionType: document.getElementById('lg-reg-type').value,
          attendedSchoolName: document.getElementById('lg-reg-school').value.trim(),
          attendedDepartment: document.getElementById('lg-reg-dept').value.trim(),
          courseOfStudy: document.getElementById('lg-reg-course').value.trim(),
          yearOfStudy: document.getElementById('lg-reg-level').value,
          password: document.getElementById('lg-reg-pw').value,
        },
      });
      onAuthed(token, user, refreshToken);
    });
  });

  document.getElementById('signout-btn').addEventListener('click', () => {
    if (state.refreshToken) {
      fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: state.refreshToken }),
        keepalive: true,
      }).catch(() => {});
    }
    clearSession();
    window.speechSynthesis && window.speechSynthesis.cancel();
    window.location.href = '/app';
  });


  async function onAuthed(token, user, refreshToken) {
    state.token = token;
    state.refreshToken = refreshToken || null;
    state.user = user;
    saveSession(token, user, refreshToken);
    authScreen.style.display = 'none';
    appScreen.classList.add('active');
    await loadHeaderContext();
    buildSidebar();
    initNotifications();
    navigate(defaultScreenFor(user.role));
  }

  // Resolved school/department names + the school's semester list, for the sidebar
  // header strip and semester switcher. Best-effort: a stale/expired token shouldn't
  // block the rest of boot, since navigate() will surface the real auth error anyway.
  async function loadHeaderContext() {
    let meSemesters;
    try {
      const { user, school, department, semesters } = await api('/auth/me');
      meSemesters = semesters;
      // Refresh state.user (and its saved copies) too, not just school/department --
      // otherwise a server-side change to the student's own record (level, admission
      // details, etc.) never reaches an already-logged-in browser until they log out and
      // back in, since state.user was only ever set once at login time.
      if (user) { state.user = user; saveSession(state.token, user); }
      state.school = school;
      state.department = department;
    } catch { state.school = null; state.department = null; }
    if (state.school) {
      // /auth/me already carries the semester list; only an older server needs the extra request
      if (Array.isArray(meSemesters)) state.semesters = meSemesters;
      else { try { state.semesters = (await api('/semesters')).semesters; } catch { state.semesters = []; } }
    } else {
      state.semesters = [];
    }
  }

  // Notification.link is a plain string field with no structured params support, so a
  // deep link like "join a specific live class" is encoded as "screen?key=value&...";
  // this decodes it back into navigate()'s (screen, params) call. A bare screen name
  // (no "?") still works exactly as before.
  function parseNotificationLink(link) {
    const [screen, query] = link.split('?');
    if (!query) return [screen, {}];
    const params = {};
    for (const [k, v] of new URLSearchParams(query)) params[k] = v;
    return [screen, params];
  }

  // Cosmetic only -- semester names are free text ("First Semester 2025/2026"), but
  // every screen that displays one should read "1st/2nd Semester" consistently.
  function semesterLabel(name) {
    return String(name || '').replace(/^First\b/i, '1st').replace(/^Second\b/i, '2nd').replace(/^Third\b/i, '3rd');
  }

  // User.yearOfStudy is stored as a plain year number (1, 2, 3...) but always
  // displayed in the Nigerian tertiary "level" format -- 100L, 200L, 300L.
  function levelLabel(yearOfStudy) {
    return yearOfStudy ? `${yearOfStudy * 100}L` : null;
  }

  // App-generated Assessment.type values for an individual learner's auto-scheduled
  // content -- friendlier labels than the raw type string.
  const INDIVIDUAL_ASSESSMENT_TYPE_LABELS = { ASSIGNMENT: 'Daily Assignment', CA: 'Weekly Test', Mock: 'Mock Exam', PAST_QUESTION: 'Past Questions', SEMESTER_EXAM: 'Semester Exam' };
  function individualAssessmentTypeLabel(type) {
    return INDIVIDUAL_ASSESSMENT_TYPE_LABELS[type] || type;
  }

  function defaultScreenFor(role) {
    if (role === 'STUDENT') return 'my-dashboard';
    if (role === 'LECTURER') return 'lect-dashboard';
    return 'admin-dashboard';
  }

  // ---------- Sidebar ----------
  // Individual (non-school) learners get every feature a school student has, scoped to
  // their own self-directed IndividualCourse instead of a school Course/lecturer, with
  // three deliberate exceptions: no live classes (there's no human lecturer to host
  // one), no Admission Status (no admission process for a self-registered learner), and
  // school-administrative concepts folded into their Digital ID instead (hostel/
  // transcript/clearance -- there's no school admin to administer those).
  const NAV = {
    STUDENT_INDIVIDUAL: [
      ['my-dashboard', 'Home'],
      ['individual-courses', 'My Courses'],
      ['library', 'e-Library'],
      ['groups', 'Study Groups'],
      ['lab-hub', 'Digital Lab'],
      ['tests-hub', 'Tests'],
      ['cbt-mock', 'CBT Mock Exam Practice'],
      ['semester-exam-hub', 'Semester Exam'],
      ['my-ai-lectures', 'AI Pre-recorded Lectures'],
      ['my-ai-live', 'AI Live Recorded Lectures'],
      ['research', 'AI Research Assistant'],
      ['progress', 'My Progress'],
      ['leaderboard', 'Leaderboard'],
      ['study-plan', 'Study Plan'],
      ['student-dashboard', 'My Dashboard'],
      ['digital-id', 'Digital ID'],
      ['billing', 'Subscription'],
      ['wallet', 'AI Minutes & Coins'],
      ['settings', 'Settings'],
    ],
  };

  // Builds the "name / school / department" identity lines shown as a profile card
  // on the homepage (My Dashboard, or the admin/lecturer landing screen) instead of
  // the sidebar -- the sidebar stays nav-only.
  const INSTITUTION_TYPE_LABELS = { UNIVERSITY: 'University', POLYTECHNIC: 'Polytechnic', MONOTECHNIC: 'Monotechnic', COLLEGE_OF_EDUCATION: 'College of Education', OTHER: 'Other institution' };

  function profileLines() {
    const u = state.user;
    const roleLabel = u.role.charAt(0) + u.role.slice(1).toLowerCase();
    const lines = [`${esc(u.fullName)} · ${esc(roleLabel)}`];
    if (u.isIndividual) {
      // Institution type (e.g. "University") is left off here -- attendedSchoolName is
      // the actual school name and already says as much, so showing both read as
      // redundant. Level shows the same way a school student's does.
      const bits = [u.attendedSchoolName, u.courseOfStudy, levelLabel(u.yearOfStudy)].filter(Boolean).map(esc);
      if (bits.length) lines.push(bits.join(' · '));
    } else if (state.school) {
      const schoolLine = [state.school.name, state.school.location].filter(Boolean).map(esc).join(', ');
      lines.push(schoolLine);
      const deptBits = [state.department && state.department.name, levelLabel(u.yearOfStudy)].filter(Boolean).map(esc);
      if (deptBits.length) lines.push(deptBits.join(' · '));
    }
    return lines;
  }

  // The greeting at the top of the home page, as in PassNow: time of day, the name large, then who they are.
  // An independent learner's details, laid out like a school student's.
  function learnerDetailsCard(u) {
    const row = (k, v) => `<div><div class="meta">${esc(k)}</div><div class="tabular">${v}</div></div>`;
    return `<div class="card" style="padding:24px; max-width:680px; margin-bottom:22px;"><div class="id-grid">
      ${row('Institution', esc(u.attendedSchoolName || '—'))}
      ${row('Type', esc(INSTITUTION_TYPE_LABELS[u.institutionType] || '—'))}
      ${row('Department', esc(u.attendedDepartment || '—'))}
      ${row('Course of study', esc(u.courseOfStudy || '—'))}
      ${row('Level', esc(levelLabel(u.yearOfStudy) || '—'))}
      ${row('Email', esc(u.email || '—'))}
      ${row('Phone', esc(u.phone || '—'))}
      ${row('Member since', esc(u.createdAt ? String(new Date(u.createdAt).getFullYear()) : '—'))}
    </div></div>`;
  }

  function greetingBlock(extraLine) {
    const u = state.user;
    const hour = new Date().getHours();
    const hello = hour < 12 ? 'Good morning,' : hour < 18 ? 'Good afternoon,' : 'Good evening,';
    const lines = profileLines().slice(1);
    const role = esc((typeof ROLE_NAMES !== 'undefined' && ROLE_NAMES[u.role]) || 'Student');
    const rest = [...lines, extraLine ? esc(extraLine) : ''].filter(Boolean);
    return `<div class="greet">
      <div class="meta">${hello}</div>
      <div class="greet-name">${esc(u.fullName)} 👋</div>
      <div class="meta"><b>${role}</b>${rest.length ? ' · ' + rest.join(' · ') : ''}</div>
    </div>`;
  }

  function buildSidebar() {
    const u = state.user;

    // The top of the sidebar says who is signed in, as PassNow's does.
    const brandRole = document.getElementById('brand-role');
    if (brandRole) brandRole.textContent = 'Student';
    const sideWho = document.getElementById('sidebar-who');
    if (sideWho) sideWho.innerHTML = `<div class="nm">${esc(u.fullName)}</div>`;

    const semesterBox = document.getElementById('semester-box');
    if (state.school && state.semesters && state.semesters.length) {
      const current = state.semesters.find((s) => s.isCurrent);
      if (u.role === 'ADMIN') {
        semesterBox.innerHTML = `
          <select id="semester-select" class="nav-item" style="font-weight:600;">
            ${state.semesters.map((s) => `<option value="${s.id}" ${s.isCurrent ? 'selected' : ''}>${esc(semesterLabel(s.name))}${s.isCurrent ? ' (current)' : ''}</option>`).join('')}
          </select>
          <button class="nav-item" id="new-semester-btn" style="font-weight:500; font-size:0.82rem;">+ New semester</button>
        `;
        document.getElementById('semester-select').addEventListener('change', async (e) => {
          await api(`/admin/semesters/${e.target.value}/activate`, { method: 'POST' });
          await loadHeaderContext();
          buildSidebar();
          toast('Current semester updated');
        });
        document.getElementById('new-semester-btn').addEventListener('click', async () => {
          const name = prompt('Semester name, e.g. "Second Semester 2025/2026"');
          if (!name) return;
          const { semester } = await api('/admin/semesters', { method: 'POST', body: { name } });
          await api(`/admin/semesters/${semester.id}/activate`, { method: 'POST' });
          await loadHeaderContext();
          buildSidebar();
          toast('Semester created and set as current');
        });
      } else {
        semesterBox.innerHTML = current ? `<div class="who" style="padding-bottom:8px;">📅 ${esc(semesterLabel(current.name))}</div>` : '';
      }
    } else {
      semesterBox.innerHTML = '';
    }

    const nav = document.getElementById('nav-items');
    const navKey = state.user.role === 'STUDENT' && state.user.isIndividual ? 'STUDENT_INDIVIDUAL' : state.user.role;
    const navItems = NAV[navKey];
    nav.innerHTML = navItems
      .map(([key, label]) => `<button class="nav-item" data-screen="${key}">${esc(label)}</button>`)
      .join('');
    nav.querySelectorAll('.nav-item').forEach((btn) => {
      btn.addEventListener('click', () => { navigate(btn.dataset.screen); closeMobileNav(); });
    });
  }

  // ---- A back arrow on every screen, the bottom bar on phones and tablets, and the home-page building blocks ----
  const navStack = [];
  let navGoingBack = false;
  function goBack() {
    const prev = navStack.pop();
    navGoingBack = true;
    try {
      if (prev) { const { screen, ...rest } = prev; navigate(screen, rest); } else navigate(defaultScreenFor(state.user.role));
    } finally { navGoingBack = false; }
  }
  const HOME_SCREENS = ['my-dashboard', 'lect-dashboard', 'admin-dashboard', 'staff-dashboard'];
  function addBackArrow() {
    const v = document.getElementById('view');
    if (!v || !state.user || !state.view || !state.view.screen || HOME_SCREENS.includes(state.view.screen) || state.view.screen === 'live-class' || v.querySelector('#exit-exam-btn')) return;
    let head = v.querySelector(':scope > .page-head');
    if (!head) {
      if (!v.children.length) return;
      head = document.createElement('div');
      head.className = 'page-head bk-only';
      v.insertBefore(head, v.firstChild);
    }
    if (head.querySelector(':scope > .bk-arrow')) return;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'bk-arrow'; b.setAttribute('aria-label', 'Back'); b.textContent = '←';
    b.addEventListener('click', goBack);
    head.insertBefore(b, head.firstChild);
    head.classList.add('has-bk');
  }
  new MutationObserver(addBackArrow).observe(document.getElementById('view'), { childList: true });

  const SJ_COLORS = ['#142033,#234672', '#00c853,#00913b', '#6a1b9a,#4a148c', '#ff6b35,#d9481a', '#0f766e,#065f46', '#e02020,#a31616', '#2979ff,#1a4fb8', '#e3ac4c,#b8791a'];
  const SJ_ICONS = ['📘', '📗', '📙', '📕', '📒', '📓', '📔', '📚'];
  function homeTile(nav, icon, label, sub) {
    return `<button type="button" class="card course-card" data-jump-nav="${nav}"><div class="code">${icon}</div><div class="meta">${label}</div><div class="sub">${sub}</div></button>`;
  }
  function homeBanner(icon, title, sub, nav) {
    return `<div class="pn-banner" data-jump-nav="${nav}"><div class="pn-banner-ico">${icon}</div><div class="pn-banner-txt"><div class="pn-banner-t">${title}</div><div class="pn-banner-s">${sub}</div></div><div class="pn-banner-go">Go!</div></div>`;
  }
  function homeSection(title, seeNav, body) {
    return `<div class="sec"><div class="sh"><div class="st">${title}</div>${seeNav ? `<div class="sa" data-jump-nav="${seeNav}">See all</div>` : ''}</div>${body}</div>`;
  }
  function sjStrip(items) {
    return `<div class="sj-strip">${items.map((c, i) => `<div class="sj" data-sj-screen="${c.screen}" data-sj-params="${esc(JSON.stringify(c.params || {}))}" style="background:linear-gradient(135deg,${SJ_COLORS[i % SJ_COLORS.length]})"><div class="sj-ico">${SJ_ICONS[i % SJ_ICONS.length]}</div><div class="sj-name">${esc(c.title)}</div><div class="sj-sub">${esc(c.sub || '')}</div></div>`).join('')}</div>`;
  }
  document.addEventListener('click', (e) => {
    const sj = e.target.closest('[data-sj-screen]');
    if (!sj) return;
    let p = {};
    try { p = JSON.parse(sj.dataset.sjParams || '{}'); } catch { p = {}; }
    navigate(sj.dataset.sjScreen, p);
  });
  function pnRows(rows) {
    return `<div class="card pn-list">${rows.map((r) => `<div class="pn-row"><div class="pn-ico">${r.icon}</div><div class="pn-main"><div class="pn-t">${esc(r.title)}</div>${r.sub ? `<div class="pn-s">${esc(r.sub)}</div>` : ''}</div>${r.side ? `<div class="pn-d">${esc(r.side)}</div>` : ''}</div>`).join('') || `<div class="pn-empty">${esc('Nothing here yet.')}</div>`}</div>`;
  }
  function notifRows(list) {
    return pnRows((list || []).slice(0, 3).map((n) => ({ icon: '🔔', title: n.title, sub: n.body, side: new Date(n.createdAt).toLocaleDateString() })));
  }
  // What a student's home shows around the tiles: the Daily Challenge banner, then the streak, the courses to
  // continue, a glance at today, what is due and what is new.
  async function studentHomeExtras({ isIndividual, assignments, notifications, daily, pendingCount, attendancePct, takenCount, results, courses: given }) {
    let courses = given || [];
    if (!given) { try { courses = (await api(isIndividual ? '/individual-courses' : '/students/me/courses')).courses || []; } catch { courses = []; } }
    const titles = daily && daily.sources && daily.sources.length ? daily.sources.slice(0, 4).map((c) => esc(c.title)).join(' · ') + ' · 10Q · 8 min each' : 'Practise questions from your courses every day';
    const banner = homeBanner('⚡', 'Daily Challenge', titles, 'daily-challenge');
    const days = daily && daily.days ? daily.days : [];
    const streak = homeSection('🔥 Your Streak', null, `<div class="card" style="padding:16px;"><div class="streak-row">${days.map((x) => `<div class="sd"><div class="sc${x.done ? ' done' : ''}${x.today && !x.done ? ' now' : ''}">${x.label}</div><div class="sl">${x.today ? 'TODAY' : x.name}</div></div>`).join('')}</div></div>`).replace('<div class="sh"><div class="st">🔥 Your Streak</div></div>', `<div class="sh"><div class="st">🔥 Your Streak</div><div class="sa" style="cursor:default;">${daily ? daily.streak : 0} day${daily && daily.streak === 1 ? '' : 's'} 🏆</div></div>`);
    const cont = homeSection('Continue Learning', isIndividual ? 'individual-courses' : 'courses', courses.length
      ? courses.slice(0, 4).map((c, i) => `<div class="card cl-row" data-sj-screen="${isIndividual ? 'individual-course-detail' : 'course-detail'}" data-sj-params="${esc(JSON.stringify({ courseId: c.id }))}"><div class="cl-ico" style="background:linear-gradient(135deg,${SJ_COLORS[i % SJ_COLORS.length]})">${SJ_ICONS[i % SJ_ICONS.length]}</div><div class="cl-main"><div class="cl-t">${esc(c.title)}</div><div class="cl-s">${esc(c.code || '')}${c.department && c.department.name ? ' · ' + esc(c.department.name) : ''}</div></div><div class="cl-go">›</div></div>`).join('')
      : pnRows([{ icon: '📚', title: 'No courses yet', sub: isIndividual ? 'Create a course and your AI lecturer prepares the lectures.' : 'Open My Courses to enrol.' }]));
    const pm = planModel(daily, courses, results);
    const glance = `<div class="sec"><div class="sh"><div class="st">📋 Study Plan — Today</div></div><div class="plan-wrap"><div class="plan-card"><div class="plan-n"><b>${pm.daysLeft}</b><span>days to exam</span></div><div class="plan-n"><b>${pm.hours} hrs</b><span>study/day</span></div><div class="plan-n"><b style="color:#E02020;">${pm.weak.length}</b><span>weak areas</span></div></div><div class="plan-goal">🎯 Goal: <b>${isIndividual ? 'My exams' : 'Semester exam'}</b></div><button class="btn btn-primary" data-jump-nav="study-plan" style="width:100%;">See Full Plan →</button></div></div>`;
    const due = (assignments || []).filter((a) => !a.mySubmission && a.dueAt).sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt)).slice(0, 3);
    const upcoming = isIndividual ? '' : homeSection('⏰ Coming Up', 'my-assignments', pnRows(due.map((a) => ({ icon: '📋', title: a.title, sub: a.course ? a.course.code : '', side: 'Due ' + new Date(a.dueAt).toLocaleDateString() })).concat(due.length ? [] : [{ icon: '✅', title: 'Nothing due right now' }])));
    return { banner, rest: `${streak}${cont}${glance}${upcoming}${homeSection('🔔 Latest', null, notifRows(notifications))}` };
  }

  function markActiveNav(screen) {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.screen === screen));
  }

  function closeMobileNav() {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebar-backdrop').classList.remove('open');
    const toggle = document.getElementById('mobile-menu-toggle');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.textContent = '☰';
  }

  document.getElementById('mobile-menu-toggle').addEventListener('click', () => {
    const sidebar = document.getElementById('sidebar');
    const backdrop = document.getElementById('sidebar-backdrop');
    const open = sidebar.classList.toggle('open');
    backdrop.classList.toggle('open', open);
    const toggle = document.getElementById('mobile-menu-toggle');
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = open ? '✕' : '☰';
  });
  document.getElementById('sidebar-backdrop').addEventListener('click', closeMobileNav);

  // ---------- Notifications ----------

  function timeAgo(iso) {
    const diffMs = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  async function refreshNotifications() {
    try {
      const { notifications, unreadCount } = await api('/notifications');
      document.querySelectorAll('.notif-badge').forEach((b) => {
        b.hidden = unreadCount === 0;
        b.textContent = unreadCount > 9 ? '9+' : String(unreadCount);
      });
      const list = document.getElementById('notif-list');
      list.innerHTML = notifications.map((n) => `
        <div class="notif-item ${n.read ? '' : 'unread'}" data-id="${n.id}" data-link="${n.link || ''}">
          <div class="notif-title">${esc(n.title)}</div>
          <div class="notif-body">${esc(n.body)}</div>
          <div class="notif-time">${timeAgo(n.createdAt)}</div>
        </div>
      `).join('') || '<div class="notif-item"><span class="muted">No notifications yet.</span></div>';
      list.querySelectorAll('.notif-item[data-id]').forEach((item) => {
        item.addEventListener('click', async () => {
          await api(`/notifications/${item.dataset.id}/read`, { method: 'POST' });
          toggleNotifPanel(false);
          if (item.dataset.link) navigate(...parseNotificationLink(item.dataset.link));
          refreshNotifications();
        });
      });
      // "X is teaching live" shouldn't wait for the student to think to open the bell
      // -- pop it on screen directly too, on top of whatever they're currently doing.
      notifications
        .filter((n) => !n.read && n.link && n.link.startsWith('live-class'))
        .forEach(showLiveClassPopup);
    } catch {
      // silent -- notifications are a convenience, not critical path
    }
  }

  // Shown at most once per notification id per page load (a poll re-fetching the same
  // still-unread notification a minute later shouldn't pop it again). Stacks above any
  // other popup the same way toast-stack stacks toasts, in case more than one course
  // goes live at once.
  const shownLiveNotifIds = new Set();
  function showLiveClassPopup(n) {
    if (shownLiveNotifIds.has(n.id)) return;
    shownLiveNotifIds.add(n.id);
    let stack = document.getElementById('live-popup-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'live-popup-stack';
      stack.style.cssText = 'position:fixed; top:76px; left:50%; transform:translateX(-50%); z-index:110; display:flex; flex-direction:column; gap:10px; width:min(420px,92vw); align-items:stretch;';
      document.body.appendChild(stack);
    }
    const banner = document.createElement('div');
    banner.className = 'live-banner';
    banner.style.cssText = 'margin-bottom:0; box-shadow:var(--shadow);';
    banner.innerHTML = `
      <div><span class="live-dot"></span><strong>${esc(n.title)}</strong><div class="meta" style="margin-top:2px; color:inherit;">${esc(n.body)}</div></div>
      <div style="display:flex; gap:6px; flex-shrink:0;">
        <button class="btn btn-accent btn-sm" data-join>Join now</button>
        <button class="btn btn-ghost btn-sm" data-dismiss>✕</button>
      </div>
    `;
    stack.appendChild(banner);
    banner.querySelector('[data-join]').addEventListener('click', async () => {
      try { await api(`/notifications/${n.id}/read`, { method: 'POST' }); } catch {}
      banner.remove();
      navigate(...parseNotificationLink(n.link));
    });
    // Dismissing (or letting it time out) marks the notification read, same as
    // "Join now" -- leaving it unread meant the popup came right back on every
    // refresh (shownLiveNotifIds is only an in-memory guard for the current page
    // load) and on every 20s re-poll, since the unread filter in refreshNotifications
    // would just pick it straight back up. It still stays visible in the bell.
    const markSeen = () => { api(`/notifications/${n.id}/read`, { method: 'POST' }).catch(() => {}); };
    banner.querySelector('[data-dismiss]').addEventListener('click', () => { markSeen(); banner.remove(); });
    setTimeout(() => { markSeen(); banner.remove(); }, 45000);
  }

  function toggleNotifPanel(force) {
    const panel = document.getElementById('notif-panel');
    const open = force !== undefined ? force : panel.hidden;
    panel.hidden = !open;
    if (open) refreshNotifications();
  }

  function initNotifications() {
    document.getElementById('notif-bell-mobile').addEventListener('click', () => toggleNotifPanel());
    document.getElementById('notif-bell-desktop').addEventListener('click', () => toggleNotifPanel());
    document.getElementById('notif-mark-all').addEventListener('click', async () => {
      await api('/notifications/read-all', { method: 'POST' });
      refreshNotifications();
    });
    document.addEventListener('click', (e) => {
      const panel = document.getElementById('notif-panel');
      if (!panel.hidden && !panel.contains(e.target) && !e.target.closest('.notif-bell')) toggleNotifPanel(false);
    });
    refreshNotifications();
    // Nothing previously re-checked notifications after the initial load -- a "your
    // lecturer is live" notification could sit unseen until the student happened to
    // open the bell. Re-polling periodically is also what lets showLiveClassPopup
    // (inside refreshNotifications) catch a class going live while already logged in,
    // not just at the moment of login. Kept as a fallback even now that a socket push
    // (below) delivers new ones instantly -- covers the gap around a reconnect, or a
    // browser that killed the socket in a background tab.
    setInterval(refreshNotifications, 20000);
    // Real-time push so a new notification shows up the instant it's created instead
    // of waiting for the next poll -- the same live-class popup and bell badge, just
    // triggered immediately rather than up to 20s late.
    const notifSocket = io('/notifications', { auth: (cb) => cb({ token: state.token }) });
    notifSocket.on('notification:new', () => refreshNotifications());
  }

  const view = document.getElementById('view');

  function navigate(screen, params = {}) {
    aiRecStop();
    window.speechSynthesis && window.speechSynthesis.cancel();
    if (examTimerHandle) { clearInterval(examTimerHandle); examTimerHandle = null; }
    if (simliAvatarClient) { try { simliAvatarClient.close(); } catch { /* already closed */ } simliAvatarClient = null; }
    if (speechCtrl) {
      if (speechCtrl.timer) clearInterval(speechCtrl.timer);
      if (speechCtrl.doneTimeout) clearTimeout(speechCtrl.doneTimeout);
    }
    speechCtrl = null;
    if (voiceRecognizer) { try { voiceRecognizer.abort(); } catch { /* already stopped */ } voiceRecognizer = null; }
    if (!navGoingBack && state.view && state.view.screen && state.view.screen !== screen) { navStack.push(state.view); if (navStack.length > 40) navStack.shift(); }
    state.view = Object.assign({ screen }, params);
    markActiveNav(screen);
    render();
  }

  // No loading placeholder: the previous screen just stays on-screen (instead of
  // blanking to "Loading…") until the next one's data is ready and replaces it.
  async function render() {
    LZX.progress(true);
    try {
      await renderScreen();
    } finally {
      LZX.progress(false);
    }
  }

  async function renderScreen() {
    try {
      await dispatch();
      if (state.user && state.user.role === 'STUDENT') LZX.payReturn({ api, toast, rerender: () => renderScreen() });
      // The system writes mock exams, past questions and practice questions for each course; while
      // that is going on these screens say so and refresh themselves when it is done.
      if (state.user && state.user.role === 'STUDENT' && ['cbt-mock'].includes(state.view.screen)) {
        LZX.practiceWatch(view, { api, esc, rerender: () => renderScreen() });
      }
    } catch (err) {
      if (err.code === 'SUBSCRIPTION_REQUIRED' || err.code === 'AI_CREDITS_EXHAUSTED') return renderUpgradePrompt(err.message);
      view.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
    }

    function dispatch() {
      switch (state.view.screen) {
        case 'individual-courses': return renderIndividualCourses();
        case 'my-ai-lectures': return renderMyAiLectures();
        case 'my-ai-live': return renderMyAiLive();
        case 'ai-live-replay': return renderAiLiveReplay();
        case 'individual-course-detail': return renderIndividualCourseDetail();
        case 'lesson-player': return renderLessonPlayer();
        case 'library': return renderLibrary(false);
        case 'pdf-viewer': return renderPdfViewer();
        case 'groups': return renderGroups();
        case 'group-chat': return renderGroupChat();
        case 'my-dashboard': return renderMyDashboard();
        case 'student-dashboard': return renderStudentHub();
        case 'study-plan': return renderStudyPlan();
        case 'daily-challenge': return LZX.dailyChallenge(view, { api, esc, toast, navigate });
        case 'my-assessments': return renderMyDashboard('assessments');
        case 'my-activity': return renderMyDashboard('activity');
        case 'cbt-mock': return renderCbtMock();
        case 'tests-hub': return renderAssessments(false, { heading: 'Tests', typeFilter: ['CA', 'Test'] });
        case 'take-assessment': return renderTakeAssessment();
        case 'assessment-review': return renderAssessmentReview();
        case 'billing': return renderBilling();
        case 'ai-teacher-session': return renderAiTeacherSession();
        case 'progress': return renderProgress();
        case 'leaderboard': return renderLeaderboard();
        case 'research': return renderResearchAssistant();
        case 'digital-id': return renderDigitalId();
        case 'settings': return renderSettings();
        case 'support': return LZX.support(view, { api, esc, toast, tab: state.view.tab });
        case 'support-review': return LZX.support(view, { api, esc, toast, tab: 'review' });
        case 'wallet': return LZX.wallet(view, { api, esc, toast });
        case 'settings-profile': return renderSettingsProfile();
        case 'settings-password': return renderSettingsPassword();
        case 'lab': return renderLab();
        case 'lab-hub': return renderLabHub();
        case 'lab-teach': return renderLabTeach();
        case 'attendance-history': return renderStudentAttendanceHistory();
        case 'assignment-detail': return renderAssignmentDetail();
        case 'semester-exam-hub': return renderSemesterExamHub();
        default: view.innerHTML = '<p>Not found.</p>';
      }
    }
  }

  function renderUpgradePrompt(message) {
    view.innerHTML = `
      <div class="card" style="padding:32px; max-width:480px; margin:40px auto; text-align:center;">
        <span class="pill pill-accent">Learnza subscription</span>
        <h2 style="margin:14px 0 8px;">This needs an active subscription</h2>
        <p class="muted" style="margin-bottom:20px;">${esc(message || 'Subscribe to unlock AI Lecturer lectures, recorded lectures and live classes.')}</p>
        <button class="btn btn-accent" id="go-upgrade-btn">See plans — ₦10,000/month</button>
      </div>
    `;
    document.getElementById('go-upgrade-btn').addEventListener('click', () => navigate('billing'));
  }

  // ================= INDIVIDUAL (non-school) LEARNER COURSES =================

  async function renderIndividualCourses() {
    const { courses } = await api('/individual-courses');
    view.innerHTML = `
      <div class="page-head">
        <h1>My Courses</h1>
        <button class="btn btn-accent" id="new-individual-course-btn">+ New course</button>
      </div>
      <p class="muted" style="margin-bottom:20px;">Create a course on anything you want to learn — the AI Lecturer covers it.</p>
      <div class="grid-cards">
        ${courses.map((c) => `
          <div class="card course-card" data-open="${c.id}">
            <div style="font-weight:600;">${esc(c.title)}</div>
            ${c.description ? `<div class="meta" style="margin-top:6px;">${esc(c.description)}</div>` : ''}
          </div>
        `).join('') || '<p class="muted">No courses yet — create your first one.</p>'}
      </div>
    `;
    view.querySelectorAll('[data-open]').forEach((el) => {
      el.addEventListener('click', () => navigate('individual-course-detail', { courseId: el.dataset.open }));
    });
    document.getElementById('new-individual-course-btn').addEventListener('click', async () => {
      const title = prompt('What do you want to learn?');
      if (!title || !title.trim()) return;
      const description = prompt('Add a short description (optional):') || '';
      try {
        await api('/individual-courses', { method: 'POST', body: { title: title.trim(), description } });
        toast('Course created');
        render();
      } catch (err) { toast(err.message); }
    });
  }

  // ---- AI Pre-recorded Lectures and AI Live Recorded Lectures: two different things ----
  // Pre-recorded: the narrated lectures the AI Lecturer prepared for a course, ready to watch again.
  // Live recorded: the classes the student took live with the AI Lecturer, kept to replay and download.
  function downloadTextFile(filename, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  const safeFileName = (n) => String(n || 'lecture').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'lecture';

  

  // The same lectures that are listed inside each course ("Pre-recorded lectures"), gathered in one place and set out the same
  // way: one block per course, each row opens the lecture.
  async function renderMyAiLectures() {
    const { lessons } = await api('/ai-teacher/prerecorded');
    const groups = new Map();
    lessons.forEach((l) => { const k = l.individualCourseId || l.courseId; if (!groups.has(k)) groups.set(k, { title: l.courseTitle, courseId: k, isIndividual: !!l.individualCourseId, items: [] }); groups.get(k).items.push(l); });
    view.innerHTML = `
      <div class="page-head"><h1>AI Pre-recorded Lectures</h1></div>
      <p class="muted" style="margin-bottom:16px;">The pre-recorded lectures the system's AI Lecturer made for each of your courses: the same ones listed inside the course. This is where you carry on learning when your live AI minutes or coins run out. Classes you took live are under <b>AI Live Recorded Lectures</b>.</p>
      ${[...groups.values()].map((g) => `
        <div style="margin-bottom:22px;">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:8px;">
            <div class="muted" style="font-weight:700;">${esc(g.title)}</div>
            <button class="btn btn-ghost btn-sm" data-open-course="${g.courseId}" data-individual="${g.isIndividual}">Open course</button>
          </div>
          <div class="card">${g.items.map((l) => `
            <div class="list-row" data-open-lesson="${l.id}" data-course="${g.courseId}" data-individual="${g.isIndividual}" style="cursor:pointer;">
              <div><div style="font-weight:600;">${esc(l.title)} ${l.locked ? '<span class="pill pill-muted" style="margin-left:6px;">Subscribers only</span>' : ''}</div><div class="meta">AI Lecturer · narrated lecture</div></div>
              <span class="pill pill-accent">Lecture ${l.order}</span>
            </div>`).join('')}</div>
        </div>`).join('') || '<div class="card"><p class="muted" style="padding:16px;">No pre-recorded lectures in your courses yet. They appear here, and inside each course, as the system records them.</p></div>'}`;
    view.querySelectorAll('[data-open-lesson]').forEach((el) => el.addEventListener('click', () => navigate('lesson-player', { courseId: el.dataset.course, lessonId: el.dataset.openLesson, isIndividual: el.dataset.individual === 'true' })));
    view.querySelectorAll('[data-open-course]').forEach((b) => b.addEventListener('click', () => navigate(b.dataset.individual === 'true' ? 'individual-course-detail' : 'course-detail', { courseId: b.dataset.openCourse })));
  }

  async function renderMyAiLive() {
    const { sessions } = await api('/ai-teacher/my-sessions');
    view.innerHTML = `
      <div class="page-head"><h1>AI Live Recorded Lectures</h1></div>
      <p class="muted" style="margin-bottom:16px;">The live classes the AI Lecturer taught you, recorded as they happened. Watch a class again, pick it up where you stopped, or download its notes. Lectures the system recorded in advance are under <b>AI Pre-recorded Lectures</b>.</p>
      <div class="card">${sessions.map((x) => `
        <div class="list-row" style="gap:10px; flex-wrap:wrap;">
          <div style="min-width:0; flex:1;"><div style="font-weight:600;">${esc(x.title)}</div>
            <div class="meta">${esc(x.course)} · ${new Date(x.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })} · ${x.status === 'COMPLETED' ? 'finished' : 'in progress'}${x.recordings && x.recordings.length ? ' · 🎥 video recorded' : ''}</div></div>
          <div style="display:flex; gap:6px; flex-wrap:wrap;">
            <button class="btn btn-accent btn-sm" data-live-replay="${x.id}">▶ Watch again</button>
            ${x.status === 'COMPLETED' ? '' : `<button class="btn btn-ghost btn-sm" data-live-continue="${x.id}">Continue class</button>`}
            <button class="btn btn-ghost btn-sm" data-live-notes="${x.id}">⬇ Download notes</button>
          </div>
        </div>`).join('') || '<p class="muted" style="padding:16px;">You have not taken a live class with the AI Lecturer yet. Open a course and tap <b>Start AI Lectures</b>.</p>'}</div>`;
    const find = (id) => sessions.find((y) => y.id === id);
    view.querySelectorAll('[data-live-replay]').forEach((b) => b.addEventListener('click', () => navigate('ai-live-replay', { sessionId: b.dataset.liveReplay })));
    view.querySelectorAll('[data-live-continue]').forEach((b) => b.addEventListener('click', () => navigate('ai-teacher-session', { sessionId: b.dataset.liveContinue, isIndividual: !!find(b.dataset.liveContinue).isIndividual })));
    view.querySelectorAll('[data-live-notes]').forEach((b) => b.addEventListener('click', () => {
      const x = find(b.dataset.liveNotes);
      const body = x.sections.map((sec, i) => `${i + 1}. ${sec.title}\n${sec.boardText ? sec.boardText + '\n' : ''}\n${sec.speechText || ''}\n`).join('\n');
      downloadTextFile(safeFileName(x.course + '-' + x.title) + '-notes.txt', `${x.title}\n${x.course}\nAI Lecturer live class · ${new Date(x.createdAt).toLocaleDateString()}\n\n${body}`);
    }));
  }

  // Watch a finished live class again: every section as it was written on the board and spoken, with a Read aloud button.
  async function renderAiLiveReplay() {
    const { sessions } = await api('/ai-teacher/my-sessions');
    const x = sessions.find((y) => y.id === state.view.sessionId);
    if (!x) { view.innerHTML = '<div class="page-head"><h1>AI Live Recorded Lectures</h1></div><p class="muted">That class was not found.</p>'; return; }
    view.innerHTML = `
      <div class="page-head"><div><div class="muted">${esc(x.course)}</div><h1>${esc(x.title)}</h1></div></div>
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:14px;">
        <button class="btn btn-accent" id="replay-speak">🔊 Read aloud</button>
        <button class="btn btn-ghost" id="replay-stop" hidden>⏹ Stop</button>
        <button class="btn btn-ghost" id="replay-notes">⬇ Download notes</button>
      </div>
      ${(x.recordings || []).map((r, i) => `
        <div class="card" style="padding:14px; margin-bottom:14px;">
          <div class="meta" style="margin-bottom:8px;">🎥 Video of the class${x.recordings.length > 1 ? ' · part ' + (i + 1) : ''}</div>
          <video class="lecture-video" controls playsinline preload="metadata" src="${esc(r.url)}"></video>
          <div style="margin-top:10px;"><a class="btn btn-ghost btn-sm" href="${esc(r.url)}" download target="_blank" rel="noopener">⬇ Download video</a></div>
        </div>`).join('')}
      ${x.sections.map((sec, i) => `
        <div class="card" style="padding:18px; margin-bottom:12px;" id="replay-sec-${i}">
          <div class="meta">Part ${i + 1} of ${x.sections.length}</div>
          <h3 style="margin:4px 0 8px; font-size:1rem;">${esc(sec.title)}</h3>
          ${sec.boardText ? `<div class="script-text" style="max-height:none; white-space:pre-wrap; margin-bottom:10px;">${esc(sec.boardText)}</div>` : ''}
          <p style="white-space:pre-wrap;">${esc(sec.speechText || '')}</p>
        </div>`).join('') || '<p class="muted">This class has no saved parts.</p>'}`;
    const speakBtn = view.querySelector('#replay-speak'), stopBtn = view.querySelector('#replay-stop');
    let playing = false;
    const stop = () => { playing = false; window.speechSynthesis && window.speechSynthesis.cancel(); speakBtn.hidden = false; stopBtn.hidden = true; };
    speakBtn.addEventListener('click', () => {
      if (!window.speechSynthesis) return toast('Reading aloud is not available on this device.');
      playing = true; speakBtn.hidden = true; stopBtn.hidden = false;
      let i = 0;
      const next = () => {
        if (!playing || i >= x.sections.length) { stop(); return; }
        const sec = x.sections[i++];
        const el = document.getElementById('replay-sec-' + (i - 1));
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const u = new SpeechSynthesisUtterance(`${sec.title}. ${sec.speechText || ''}`);
        u.onend = next; u.onerror = stop;
        window.speechSynthesis.speak(u);
      };
      next();
    });
    stopBtn.addEventListener('click', stop);
    view.querySelector('#replay-notes').addEventListener('click', () => {
      const body = x.sections.map((sec, i) => `${i + 1}. ${sec.title}\n${sec.boardText ? sec.boardText + '\n' : ''}\n${sec.speechText || ''}\n`).join('\n');
      downloadTextFile(safeFileName(x.course + '-' + x.title) + '-notes.txt', `${x.title}\n${x.course}\nAI Lecturer live class · ${new Date(x.createdAt).toLocaleDateString()}\n\n${body}`);
    });
  }

  async function renderIndividualCourseDetail() {
    const [{ course }, { lessons }, subBadge] = await Promise.all([
      api(`/individual-courses/${state.view.courseId}`),
      api(`/individual-courses/${state.view.courseId}/lessons`),
      subscriptionBadgeHtml(),
    ]);
    view.innerHTML = `
      <div class="page-head">
        <h1>${esc(course.title)}</h1>
        <button class="btn btn-ghost btn-sm" id="back-btn">← Back to courses</button>
      </div>
      ${course.description ? `<p class="muted" style="margin-bottom:20px;">${esc(course.description)}</p>` : ''}
      <div class="card" style="padding:24px; text-align:center; margin-bottom:22px;">
        ${subBadge}
        <h3 style="margin:14px 0 8px;">Start AI Lectures</h3>
        <p class="muted" style="margin-bottom:18px;">Tell the AI Lecturer what to cover in this course.</p>
        <button class="btn btn-accent" id="start-ai-teacher-btn">Start AI Lectures</button>
      </div>

      <h3 style="margin-bottom:10px; font-size:1rem;">Pre-recorded lectures</h3>
      <p class="muted" style="margin-bottom:12px;">The app automatically generates narrated AI Lecturer lectures for this course. Your assignments, tests and semester exams are on your dashboard and sidebar.</p>
      <div class="card" style="margin-bottom:22px;">
        ${lessons.map((l) => `
          <div class="list-row" data-open-lesson="${l.id}" style="cursor:pointer;">
            <div>
              <div style="font-weight:600;">${esc(l.title)} ${l.locked ? '<span class="pill pill-muted" style="margin-left:6px;">Subscribers only</span>' : ''}</div>
              <div class="meta">AI Lecturer · narrated lecture</div>
            </div>
            <span class="pill pill-accent">Lecture ${l.order}</span>
          </div>
        `).join('') || '<p class="muted" style="padding:16px;">Nothing yet — check back shortly, the app generates your first lectures automatically.</p>'}
      </div>

      <button class="btn btn-ghost btn-sm" id="delete-course-btn" style="color:var(--danger);">Delete this course</button>
    `;
    document.getElementById('back-btn').addEventListener('click', () => navigate('individual-courses'));
    document.getElementById('start-ai-teacher-btn').addEventListener('click', () => {
      const topic = prompt(`What topic in ${course.title} should the AI Lecturer cover?`);
      if (!topic || !topic.trim()) return;
      startAiTeacherSession(course.id, topic.trim(), true);
    });
    view.querySelectorAll('[data-open-lesson]').forEach((el) => {
      el.addEventListener('click', () => navigate('lesson-player', { courseId: course.id, lessonId: el.dataset.openLesson, isIndividual: true }));
    });
    document.getElementById('delete-course-btn').addEventListener('click', async () => {
      if (!confirm('Delete this course? This cannot be undone.')) return;
      await api(`/individual-courses/${course.id}`, { method: 'DELETE' });
      toast('Course deleted');
      navigate('individual-courses');
    });
  }

  async function startAiTeacherSession(courseId, topic, isIndividual) {
    const path = isIndividual ? `/individual-courses/${courseId}/ai-teacher/sessions` : `/courses/${courseId}/ai-teacher/sessions`;
    // A full-view loading state (not just a toast that can scroll out of sight) so the
    // few real seconds of LLM generation don't read as the app having done nothing.
    const previousView = view.innerHTML;
    view.innerHTML = `
      <div class="card" style="padding:48px 24px; text-align:center;">
        <div class="ai-avatar-ring" style="margin:0 auto 18px; animation: avatar-pulse 1.4s ease-in-out infinite;">✨</div>
        <h3 style="margin-bottom:8px;">Preparing your lecture on "${esc(topic)}"…</h3>
        <p class="muted">The AI Lecturer is drafting a full, comprehensive lecture — this takes a little while.</p>
      </div>
    `;
    try {
      const { session } = await api(path, { method: 'POST', body: { topic } });
      navigate('ai-teacher-session', { sessionId: session.id, isIndividual });
    } catch (err) {
      view.innerHTML = previousView;
      if (err.code === 'SUBSCRIPTION_REQUIRED' || err.code === 'AI_CREDITS_EXHAUSTED') return renderUpgradePrompt(err.message);
      toast(aiErrorMessage(err));
    }
  }

  async function renderLessonPlayer() {
    const { courseId, lessonId, isIndividual } = state.view;
    const lessonsPath = isIndividual ? `/individual-courses/${courseId}/lessons` : `/courses/${courseId}/lessons`;
    const backScreen = isIndividual ? 'individual-course-detail' : 'course-detail';
    const { lessons } = await api(lessonsPath);
    const lesson = lessons.find((l) => l.id === lessonId);
    if (!lesson) { view.innerHTML = '<p>Lecture not found.</p>'; return; }

    if (lesson.locked) {
      view.innerHTML = `
        <div class="page-head"><h1>${esc(lesson.title)}</h1><button class="btn btn-ghost btn-sm" id="back-btn">← Back to course</button></div>
        <div class="card" style="padding:32px; text-align:center;">
          <span class="pill pill-accent">Subscription feature</span>
          <h2 style="margin:14px 0 8px;">This lecture needs an active subscription</h2>
          <p class="muted" style="margin-bottom:20px;">AI Lecturer narration and recorded lectures are part of Learnza's paid plan — ₦10,000/month or ₦105,000/year.</p>
          <button class="btn btn-accent" id="go-upgrade-btn">See plans</button>
        </div>
      `;
      document.getElementById('back-btn').addEventListener('click', () => navigate(backScreen, { courseId }));
      document.getElementById('go-upgrade-btn').addEventListener('click', () => navigate('billing'));
      return;
    }

    if (simliAvatarClient) { try { simliAvatarClient.close(); } catch { /* already closed */ } simliAvatarClient = null; }
    const { avatarConfigured, subscriptionEnforced, aiCredits } = await api('/config').catch(() => ({ avatarConfigured: false, subscriptionEnforced: true, aiCredits: null }));
    const words = lesson.script.split(/(\s+)/);
    const scriptHtml = words.map((w, i) => `<span data-w="${i}">${esc(w)}</span>`).join('');

    view.innerHTML = `
      <div class="page-head">
        <h1>${esc(lesson.title)}</h1>
        <button class="btn btn-ghost btn-sm" id="back-btn">← Back to course</button>
      </div>
      <div class="card lesson-player">
        ${lesson.videoUrl ? `
          <span class="pill pill-muted">Recorded lecture${lesson.author ? ` — ${esc(lesson.author.fullName)}` : ''}</span>
          <div style="margin-top:14px;"><video src="${esc(lesson.videoUrl)}" controls style="width:100%; border-radius:10px;"></video></div>
          <h3 style="margin:18px 0 8px; font-size:0.95rem;">Lecture notes</h3>
          <p style="white-space:pre-wrap;">${esc(lesson.script)}</p>
        ` : `
          <span class="pill ${subscriptionEnforced ? 'pill-accent' : 'pill-pass'}">AI Lecturer — ${subscriptionEnforced ? 'subscriber lecture' : 'free during testing'}</span>
          ${aiCredits && aiCredits.tracked ? ` <span class="pill ${aiCredits.exhausted ? 'pill-danger' : 'pill-muted'}">${Math.floor(aiCredits.secondsRemaining / 60)} min left this cycle</span>` : ''}
          <div class="ai-avatar-box" style="margin-top:14px;">
            <div class="ai-avatar-ring" id="ai-avatar-ring">${esc(initials(lesson.title || 'AI'))}</div>
            <video id="avatar-video" class="ai-avatar-video" autoplay playsinline hidden></video>
            <audio id="avatar-audio" autoplay hidden></audio>
            <div class="ai-avatar-label" id="ai-avatar-label">${avatarConfigured ? 'AI Lecturer — video avatar available' : 'AI Lecturer'}</div>
            ${avatarConfigured ? `<button class="btn btn-ghost btn-sm" id="start-avatar-btn" style="margin-top:10px;">🎥 Connect video avatar</button>` : ''}
          </div>
          <div class="controls">
            <button class="btn btn-primary" id="play-btn">▶ Play AI narration</button>
            <button class="btn btn-ghost" id="pause-btn">Pause</button>
            <button class="btn btn-ghost" id="stop-btn">Stop</button>
          </div>
          <div class="smart-board"><div class="board-action board-text" id="script-text">${scriptHtml}</div></div>
        `}
      </div>
    `;
    document.getElementById('back-btn').addEventListener('click', () => navigate(backScreen, { courseId }));
    if (lesson.videoUrl) return;

    const synth = window.speechSynthesis;
    const scriptEl = document.getElementById('script-text');

    document.getElementById('play-btn').addEventListener('click', () => {
      if (simliAvatarClient) { speakThroughAvatarOrTts(lesson.script, document.getElementById('ai-avatar-ring')); return; }
      if (!synth) { toast('Your browser does not support spoken narration — read the script below.'); return; }
      synth.cancel();
      const utter = new SpeechSynthesisUtterance(lesson.script);
      utter.rate = 0.98;
      utter.onboundary = (e) => {
        if (e.name !== 'word' && e.charIndex === undefined) return;
        let count = 0;
        scriptEl.querySelectorAll('.speaking-word').forEach((s) => s.classList.remove('speaking-word'));
        for (const span of scriptEl.children) {
          const len = span.textContent.length;
          if (count <= e.charIndex && e.charIndex < count + len) {
            span.classList.add('speaking-word');
            span.scrollIntoView({ block: 'center', behavior: 'smooth' });
            break;
          }
          count += len;
        }
      };
      synth.speak(utter);
    });
    document.getElementById('pause-btn').addEventListener('click', () => synth && synth.pause());
    document.getElementById('stop-btn').addEventListener('click', () => synth && synth.cancel());

    const avatarBtn = document.getElementById('start-avatar-btn');
    if (avatarBtn) avatarBtn.addEventListener('click', async () => {
      avatarBtn.disabled = true;
      avatarBtn.textContent = 'Connecting…';
      const client = await connectAvatar(
        document.getElementById('avatar-video'),
        document.getElementById('avatar-audio'),
        document.getElementById('ai-avatar-ring'),
        document.getElementById('ai-avatar-label')
      );
      if (client) {
        simliAvatarClient = client;
        avatarBtn.hidden = true;
      } else {
        avatarBtn.disabled = false;
        avatarBtn.textContent = '🎥 Connect video avatar';
      }
    });
  }

  // ================= AI LECTURER (live interactive session) =================

  function speak(text, avatarEl, onDone) {
    if (!window.speechSynthesis) { if (onDone) onDone(); return; }
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 0.98;
    if (avatarEl) utter.onstart = () => avatarEl.classList.add('speaking');
    utter.onend = () => { if (avatarEl) avatarEl.classList.remove('speaking'); speechCtrl = null; if (onDone) onDone(); };
    utter.onerror = () => { if (avatarEl) avatarEl.classList.remove('speaking'); speechCtrl = null; };
    // Stores the original text/onDone (not just the utterance) because browser
    // SpeechSynthesis has no reliable cross-browser "resume from an arbitrary
    // offset" -- pausing for a question cancels the utterance outright and resuming
    // re-speaks this same text from the start, rather than silently doing nothing
    // (which is what plain .pause()/.resume() around an intervening .cancel() did).
    speechCtrl = { mode: 'browser', ringEl: avatarEl, text, onDone };
    window.speechSynthesis.speak(utter);
  }

  // A live Simli connection is tied to specific video/audio DOM elements, and this
  // app fully replaces view.innerHTML on every render (section advance, interrupt
  // answer, etc.) rather than patching the DOM -- so the connection can't survive a
  // re-render. Closed and nulled at the top of every renderAiTeacherSession() call;
  // the student just taps "Connect video avatar" again for the new section.
  let simliAvatarClient = null;

  // The in-progress Web Speech API recognizer for "ask by voice" -- aborted/nulled
  // on navigation and at the top of renderAiTeacherSession the same way the avatar
  // connection is, since it's likewise tied to a screen that's about to be torn down.
  let voiceRecognizer = null;

  function renderBoardActionsHtml(actions) {
    if (!actions || !actions.length) return '<div class="board-action board-text muted">Nothing on the board yet.</div>';
    return actions.map((a, i) => {
      if (a.type === 'DIAGRAM') return `<div class="board-action board-diagram" data-idx="${i}">${a.content}</div>`;
      if (a.type === 'EQUATION') return `<div class="board-action board-equation" data-idx="${i}"></div>`;
      if (a.type === 'GRAPH') return `<div class="board-action board-graph" data-idx="${i}"><canvas></canvas></div>`;
      return `<div class="board-action board-text" data-idx="${i}">${esc(a.content)}</div>`;
    }).join('');
  }

  // On mobile/tablet the smart board overlays the avatar box instead of stacking below
  // it (CSS in app.html), so the teacher is covered only while there's actually a
  // diagram/equation/graph to show, and visible again the instant the board goes back
  // to plain narration text (or the next thing on the board is text-only). Desktop's
  // side-by-side layout is unaffected either way -- the class just does nothing there.
  function setBoardContent(board, actions) {
    board.innerHTML = renderBoardActionsHtml(actions);
    mountBoardActions(board, actions);
    const wrap = board.closest('.smart-board-wrap');
    const hasVisual = (actions || []).some((a) => a.type === 'DIAGRAM' || a.type === 'EQUATION' || a.type === 'GRAPH');
    if (wrap) wrap.classList.toggle('board-visual', hasVisual);
  }

  function mountBoardActions(containerEl, actions) {
    (actions || []).forEach((a, i) => {
      const el = containerEl.querySelector(`[data-idx="${i}"]`);
      if (!el) return;
      if (a.type === 'EQUATION') {
        LZX.lib('katex').then(() => {
          try { window.katex.render(a.content, el, { throwOnError: false }); } catch { el.textContent = a.content; }
        }).catch(() => { el.textContent = a.content; });
      } else if (a.type === 'GRAPH') {
        LZX.lib('chart').then(() => {
          try {
            const spec = JSON.parse(a.content);
            new window.Chart(el.querySelector('canvas'), {
              type: spec.type === 'bar' ? 'bar' : 'line',
              data: { labels: spec.labels || [], datasets: [{ data: spec.values || [], backgroundColor: '#e3ac4c', borderColor: '#e3ac4c' }] },
              options: { responsive: true, plugins: { legend: { display: false } } },
            });
          } catch { /* malformed graph spec -- leave the empty canvas rather than crash the board */ }
        }).catch(() => {});
      }
    });
  }

  // Connects the video avatar and returns the SimliClient, or null (with a toast) on
  // failure -- the backend mints a short-lived session token per connect (never
  // exposing the raw Simli API key to the browser), and the SDK itself is dynamically
  // imported at connect time straight from its dist/client.js file rather than the
  // package's barrel export -- jsDelivr's on-the-fly bundler can resolve client.js's
  // own imports (it pulls in livekit-client cleanly) but fails outright bundling the
  // barrel index.js, which is what silently broke the avatar before.
  async function connectAvatar(videoEl, audioEl, ringEl, labelEl) {
    try {
      const { sessionToken } = await api('/ai-teacher/avatar-config', { method: 'POST' });
      const mod = await import('https://cdn.jsdelivr.net/npm/simli-client@3.0.2/dist/client.js/+esm');
      const iceServers = await mod.generateIceServers();
      const client = new mod.SimliClient(sessionToken, videoEl, audioEl, iceServers, mod.LogLevel ? mod.LogLevel.INFO : undefined, 'p2p');
      await client.start();
      videoEl.hidden = false;
      videoEl.play?.().catch(() => {});
      audioEl.play?.().catch(() => {});
      ringEl.style.display = 'none';
      if (labelEl) labelEl.textContent = 'AI Lecturer — video avatar connected';
      return client;
    } catch (err) {
      if (err.code === 'SUBSCRIPTION_REQUIRED' || err.code === 'AI_CREDITS_EXHAUSTED') { renderUpgradePrompt(err.message); return null; }
      console.error('Video avatar connection failed:', err);
      toast(err.message || 'Could not connect the video avatar — continuing with voice only.');
      return null;
    }
  }

  // Tracks whatever the AI Lecturer is currently saying so a question can pause it
  // mid-sentence and resume from the exact same spot afterwards, instead of the
  // lesson restarting the section from the top. `mode: 'avatar'` tracks a byte
  // offset into the PCM stream fed to Simli; `mode: 'browser'` defers to the
  // SpeechSynthesis API's own native pause/resume.
  let speechCtrl = null;

  function avatarPlaybackTick() {
    const ctrl = speechCtrl;
    ctrl.timer = setInterval(() => {
      if (ctrl.index >= ctrl.bytes.length) {
        clearInterval(ctrl.timer);
        // All bytes have been *sent* to Simli, but WebRTC/pipeline playback still has a
        // little audio queued up -- firing onDone (which the lesson loop treats as "the
        // teacher finished speaking") right here ends the session while the avatar is
        // still audibly talking. A short buffer after the last chunk, matching PassNow's
        // own reference implementation, lets actual playback catch up first.
        ctrl.doneTimeout = setTimeout(() => {
          if (ctrl.ringEl) ctrl.ringEl.classList.remove('speaking');
          if (speechCtrl === ctrl) speechCtrl = null;
          if (ctrl.onDone) ctrl.onDone();
        }, 250);
        return;
      }
      simliAvatarClient.sendAudioData(ctrl.bytes.subarray(ctrl.index, ctrl.index + ctrl.chunkSize));
      ctrl.index += ctrl.chunkSize;
    }, 20);
  }

  // Speaks through the connected avatar (server TTS -> PCM16 -> Simli lip-sync),
  // falling back to the browser's own speech synthesis when no avatar is connected.
  // Chunked in ~20ms slices at Simli's expected 16kHz mono PCM16 rate (640 bytes per
  // slice) so the SDK ingests it like a live feed rather than one giant blob dumped
  // instantly -- matches how PassNow's own working integration paces this.
  async function speakThroughAvatarOrTts(text, ringEl, onDone) {
    aiLastCaption = { text, at: Date.now() };
    if (aiRec) { aiRec.caption = text; aiRec.capStart = aiLastCaption.at; }
    if (speechCtrl) {
      if (speechCtrl.timer) clearInterval(speechCtrl.timer);
      if (speechCtrl.doneTimeout) clearTimeout(speechCtrl.doneTimeout);
    }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    speechCtrl = null;
    if (!simliAvatarClient) return speak(text, ringEl, onDone);
    try {
      const { data, sampleRate } = await api(`/ai-teacher/tts`, { method: 'POST', body: { text } });
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      if (ringEl) ringEl.classList.add('speaking');
      const chunkSize = Math.round((sampleRate || 16000) * 0.02) * 2;
      speechCtrl = { mode: 'avatar', bytes, index: 0, chunkSize, ringEl, onDone, text };
      avatarPlaybackTick();
    } catch (err) {
      // Still call onDone on failure -- otherwise the continuous lesson loop's
      // `await speakAsync(...)` would hang forever waiting for a callback that will
      // never come, which looks exactly like the teacher freezing mid-lesson.
      if (err.code === 'SUBSCRIPTION_REQUIRED' || err.code === 'AI_CREDITS_EXHAUSTED') renderUpgradePrompt(err.message);
      else toast(err.message || 'The AI Lecturer had trouble speaking that.');
      if (onDone) onDone();
    }
  }

  // Pauses whatever's currently being spoken so it can be resumed afterwards.
  // Returns a resumable snapshot, or null if nothing was playing. Avatar mode keeps
  // its exact byte offset (true resume); browser mode has no reliable cross-browser
  // "pause and resume from this offset" (speechSynthesis.pause()/.resume() silently
  // does nothing once anything else calls .cancel() in between, which is exactly
  // what speaking an interrupt's answer does) -- so it's cancelled outright here and
  // resumePausedSpeech() below re-speaks the same text from the start instead.
  function pauseSpeechForQuestion() {
    const ctrl = speechCtrl;
    if (!ctrl) return null;
    if (ctrl.mode === 'avatar') {
      if (ctrl.timer) clearInterval(ctrl.timer);
      if (ctrl.doneTimeout) clearTimeout(ctrl.doneTimeout);
    } else if (ctrl.mode === 'browser' && window.speechSynthesis) window.speechSynthesis.cancel();
    if (ctrl.ringEl) ctrl.ringEl.classList.remove('speaking');
    speechCtrl = null;
    return ctrl;
  }

  function resumePausedSpeech(paused) {
    if (!paused) return;
    if (paused.mode === 'avatar' && paused.index < paused.bytes.length && simliAvatarClient) {
      speechCtrl = paused;
      if (paused.ringEl) paused.ringEl.classList.add('speaking');
      avatarPlaybackTick();
    } else {
      // Either browser mode, or the avatar disconnected while paused -- either way,
      // re-speak the same text from the start rather than silently stopping.
      speak(paused.text, paused.ringEl, paused.onDone);
    }
  }

  // Resolves once speakThroughAvatarOrTts finishes (or is skipped) -- lets the
  // continuous lesson loop below just `await` speech instead of nesting callbacks.
  function speakAsync(text, ringEl) {
    return new Promise((resolve) => speakThroughAvatarOrTts(text, ringEl, resolve));
  }

  // A SpeechRecognition capture with a hard 60-second cutoff, toggling shared UI state
  // on the given button/avatar ring/label while listening. Shared by the general
  // "ask a question" mic and the comprehension-check answer mic.
  function startVoiceCapture({ button, ringEl, labelEl, onTranscript, onCancelled }) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      toast('Voice answers need Chrome or Edge on this device — type instead.');
      if (onCancelled) onCancelled();
      return null;
    }
    const recognizer = new SR();
    recognizer.lang = 'en-US';
    recognizer.interimResults = false;
    recognizer.maxAlternatives = 1;
    let heardSomething = false;
    const originalButtonText = button.textContent;
    const originalLabelText = labelEl ? labelEl.textContent : '';

    button.textContent = '🛑 Listening… tap to cancel';
    button.classList.add('listening');
    if (ringEl) ringEl.classList.add('listening');
    if (labelEl) { labelEl.textContent = 'Listening…'; labelEl.classList.add('listening-label'); }

    // Hard cutoff: "should last for 1 minute before disappearing" even if the browser
    // never fires its own end-of-speech event.
    const timeout = setTimeout(() => { try { recognizer.stop(); } catch { /* already stopping */ } }, 60000);

    recognizer.onresult = (e) => {
      heardSomething = true;
      const transcript = (e.results[0][0].transcript || '').trim();
      if (transcript) onTranscript(transcript);
      else if (onCancelled) onCancelled();
    };
    recognizer.onerror = () => {
      if (!heardSomething) toast("Didn't catch that — try again, or type instead.");
    };
    recognizer.onend = () => {
      clearTimeout(timeout);
      button.textContent = originalButtonText;
      button.classList.remove('listening');
      if (ringEl) ringEl.classList.remove('listening');
      if (labelEl) {
        labelEl.classList.remove('listening-label');
        labelEl.textContent = simliAvatarClient ? 'AI Lecturer — video avatar connected' : originalLabelText;
      }
      if (!heardSomething && onCancelled) onCancelled();
    };
    try { recognizer.start(); } catch { toast('Could not start the microphone.'); recognizer.onend(); return null; }
    return recognizer;
  }

  // ---- A real video recording of every AI live class ----
  // While the AI Lecturer teaches, a video is made of what the student sees and hears: the talking avatar (or the
  // lecturer's initials when the avatar is not connected), the smart board, and a caption of what is being said, with
  // the avatar's voice mixed in. It is sent to the server in pieces every ten seconds, so nothing is lost if the page
  // is closed, and it appears under AI Live Recorded Lectures.
  let aiRec = null;
  const AI_REC_W = 1280, AI_REC_H = 720;

  function aiRecWrap(g, text, x, y, maxW, lineH, maxLines) {
    const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ');
    const lines = [];
    let line = '';
    for (const w of words) {
      const t = line ? line + ' ' + w : w;
      if (g.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
    }
    if (line) lines.push(line);
    lines.slice(0, maxLines).forEach((l, i) => g.fillText(l, x, y + i * lineH));
    return Math.min(lines.length, maxLines);
  }

  function aiRecDraw(rec) {
    const g = rec.g;
    // the avatar's voice joins the recording as soon as it is connected
    const au = document.getElementById('avatar-audio');
    const src = au && au.srcObject;
    if (rec.ac && src && rec.audioFrom !== src && src.getAudioTracks && src.getAudioTracks().length) {
      try { rec.ac.createMediaStreamSource(src).connect(rec.dest); rec.audioFrom = src; } catch { /* the class is still heard live */ }
    }
    const bg = g.createLinearGradient(0, 0, AI_REC_W, AI_REC_H);
    bg.addColorStop(0, '#0b1423'); bg.addColorStop(1, '#16294a');
    g.fillStyle = bg; g.fillRect(0, 0, AI_REC_W, AI_REC_H);
    g.fillStyle = '#e3ac4c'; g.font = '700 26px Sora, sans-serif'; g.textBaseline = 'alphabetic';
    g.fillText('Learnza · AI Lecturer — live class', 40, 50);
    g.fillStyle = 'rgba(255,255,255,.75)'; g.font = '500 20px sans-serif';
    g.fillText(String(rec.title || '').slice(0, 70), 40, 80);
    const meta = document.getElementById('section-meta');
    const st = document.getElementById('section-title');
    if (meta || st) { g.textAlign = 'right'; g.fillText(`${meta ? meta.textContent : ''}${st && st.textContent ? ' · ' + st.textContent.slice(0, 40) : ''}`, AI_REC_W - 40, 80); g.textAlign = 'left'; }

    // the avatar
    const ax = 40, ay = 110, aw = 470, ah = 470;
    g.save();
    g.beginPath(); if (g.roundRect) g.roundRect(ax, ay, aw, ah, 24); else g.rect(ax, ay, aw, ah); g.clip();
    g.fillStyle = '#0f1b2e'; g.fillRect(ax, ay, aw, ah);
    const v = document.getElementById('avatar-video');
    if (v && !v.hidden && v.readyState >= 2 && v.videoWidth) {
      const s = Math.max(aw / v.videoWidth, ah / v.videoHeight);
      const dw = v.videoWidth * s, dh = v.videoHeight * s;
      g.drawImage(v, ax + (aw - dw) / 2, ay + (ah - dh) / 2, dw, dh);
    } else {
      const pulse = document.getElementById('ai-avatar-ring') && document.getElementById('ai-avatar-ring').classList.contains('speaking') ? 8 * Math.sin(Date.now() / 160) : 0;
      g.fillStyle = '#e3ac4c'; g.beginPath(); g.arc(ax + aw / 2, ay + ah / 2, 120 + pulse, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#142033'; g.font = '800 96px Sora, sans-serif'; g.textAlign = 'center';
      g.fillText(String(rec.initials || 'AI'), ax + aw / 2, ay + ah / 2 + 32); g.textAlign = 'left';
    }
    g.restore();

    // the board
    const bx = 540, by = 110, bw = AI_REC_W - bx - 40, bh = 470;
    g.fillStyle = '#ffffff'; g.beginPath(); if (g.roundRect) g.roundRect(bx, by, bw, bh, 24); else g.rect(bx, by, bw, bh); g.fill();
    g.fillStyle = '#f6f7f9'; g.fillRect(bx, by, bw, 44);
    g.fillStyle = '#4a5568'; g.font = '700 18px sans-serif'; g.fillText('SMART BOARD', bx + 20, by + 29);
    const board = document.getElementById('smart-board');
    g.fillStyle = '#22252B'; g.font = '500 26px sans-serif';
    aiRecWrap(g, board ? board.innerText : '', bx + 24, by + 90, bw - 48, 36, 10);

    // what is being said
    const sentences = String(rec.caption || '').match(/[^.!?]+[.!?]*/g) || [];
    if (sentences.length) {
      const pos = ((Date.now() - (rec.capStart || Date.now())) / 1000) * 14;
      let acc = 0, chosen = sentences[sentences.length - 1];
      for (const s of sentences) { acc += s.length; if (pos <= acc) { chosen = s; break; } }
      g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(0, AI_REC_H - 120, AI_REC_W, 120);
      g.fillStyle = '#ffffff'; g.font = '600 28px sans-serif';
      aiRecWrap(g, chosen.trim(), 40, AI_REC_H - 74, AI_REC_W - 80, 38, 2);
    }
  }

  let aiRecToken = null;
  let aiLastCaption = { text: '', at: 0 };
  async function aiRecStart(session, title, initialsText) {
    aiRecStop();
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) return;
    const token = {};
    aiRecToken = token;
    let canvas = null, ac = null;
    try {
      canvas = document.createElement('canvas');
      canvas.width = AI_REC_W; canvas.height = AI_REC_H;
      canvas.style.cssText = 'position:fixed; left:-9999px; top:0; width:320px; height:180px; pointer-events:none;';
      document.body.appendChild(canvas); // a canvas that is part of the page keeps producing frames even when the tab is in the background
      const stream = canvas.captureStream(15);
      // The avatar's voice is mixed in through an audio track. A browser only lets that track run once the person has used
      // the page, so if it is not running within a moment the class is recorded without it rather than not at all.
      let dest = null;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        try {
          ac = new AC();
          await Promise.race([ac.resume(), new Promise((r) => setTimeout(r, 700))]);
          if (ac.state === 'running') { dest = ac.createMediaStreamDestination(); dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t)); } else { ac.close().catch(() => {}); ac = null; }
        } catch { ac = null; dest = null; }
      }
      if (aiRecToken !== token) { canvas.remove(); if (ac) ac.close().catch(() => {}); return; }
      const mime = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
      if (!mime) { canvas.remove(); return; }
      const rec = { session, title, initials: initialsText, canvas, g: canvas.getContext('2d'), ac, dest, audioFrom: null, rid: Date.now(), seq: 0, queue: [], sending: false, failed: 0, caption: aiLastCaption.text, capStart: aiLastCaption.at };
      const attach = (tracks) => {
        const r = new MediaRecorder(new MediaStream(tracks), { mimeType: mime, videoBitsPerSecond: 700000, audioBitsPerSecond: 64000 });
        r.ondataavailable = (e) => { if (e.data && e.data.size) { rec.queue.push({ seq: rec.seq++, blob: e.data }); aiRecPump(rec); } };
        r.start(10000);
        return r;
      };
      rec.recorder = attach(stream.getTracks());
      // if a browser never delivers anything while the audio track is in, record the picture alone rather than nothing
      if (dest) {
        rec.watchdog = setTimeout(() => {
          if (aiRec !== rec || rec.seq > 0) return;
          try { rec.recorder.ondataavailable = null; rec.recorder.stop(); } catch { /* already stopped */ }
          rec.dest = null; rec.audioFrom = null; rec.rid = Date.now();
          rec.recorder = attach(stream.getVideoTracks());
        }, 14000);
      }
      rec.timer = setInterval(() => { try { aiRecDraw(rec); } catch { /* a frame is skipped */ } }, 66);
      aiRec = rec;
    } catch { aiRec = null; if (canvas) canvas.remove(); }
  }

  async function aiRecPump(rec) {
    if (rec.sending) return;
    rec.sending = true;
    while (rec.queue.length) {
      const item = rec.queue[0];
      let ok = false;
      for (let attempt = 0; attempt < 5 && !ok; attempt++) {
        try {
          const res = await fetch(`/api/ai-teacher/sessions/${rec.session.id}/recording/chunk?rid=${rec.rid}&seq=${item.seq}`, { method: 'POST', headers: { Authorization: 'Bearer ' + state.token, 'Content-Type': 'application/octet-stream' }, body: item.blob });
          if (res.status === 401 && state.refreshToken) { await refreshSession().catch(() => {}); continue; }
          ok = res.ok || res.status === 404;
        } catch { /* try again */ }
        if (!ok) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
      if (!ok) rec.failed++;
      rec.queue.shift();
    }
    rec.sending = false;
  }

  // Ends the recording (when the class finishes, or the student leaves). The last piece is still sent in the background.
  function aiRecStop() {
    aiRecToken = null;
    const rec = aiRec;
    if (!rec) return;
    aiRec = null;
    clearInterval(rec.timer);
    clearTimeout(rec.watchdog);
    try { if (rec.recorder.state !== 'inactive') rec.recorder.stop(); } catch { /* already stopped */ }
    setTimeout(() => { try { rec.canvas.remove(); } catch { /* already gone */ } }, 3000);
    setTimeout(() => { try { if (rec.ac) rec.ac.close(); } catch { /* already closed */ } }, 3000);
  }

  async function renderAiTeacherSession() {
    aiRecStop();
    if (simliAvatarClient) { try { simliAvatarClient.close(); } catch { /* already closed */ } simliAvatarClient = null; }
    if (speechCtrl) {
      if (speechCtrl.timer) clearInterval(speechCtrl.timer);
      if (speechCtrl.doneTimeout) clearTimeout(speechCtrl.doneTimeout);
    }
    speechCtrl = null;
    const { session } = await api(`/ai-teacher/sessions/${state.view.sessionId}`);
    const plan = session.plan;
    let sectionIdx = session.sectionIdx;
    const { avatarConfigured, aiCredits } = await api('/config').catch(() => ({ avatarConfigured: false, aiCredits: null }));
    let stopped = false;
    // "Got a question" only becomes usable once the teacher has actually started
    // speaking -- matches a real classroom, and avoids a question firing before there's
    // any lesson state to pause/resume.
    let teachingStarted = false;

    view.innerHTML = `
      <div class="page-head">
        <div><span class="pill pill-accent">AI Lecturer — live session</span>${aiCredits && aiCredits.tracked ? ` <span class="pill ${aiCredits.exhausted ? 'pill-danger' : 'pill-muted'}">${Math.floor(aiCredits.secondsRemaining / 60)} min left this cycle</span>` : ''}<h1 style="margin-top:8px;">${esc(plan.title)}</h1></div>
        <button class="btn btn-ghost btn-sm" id="back-btn">← End session</button>
      </div>
      <div class="card lesson-player">
        <div class="lesson-stage" id="lesson-stage">
          <button class="lesson-stage-expand-btn" id="lesson-expand-btn" title="Expand">⛶</button>
          <div class="ai-avatar-box">
            <div class="ai-avatar-ring" id="ai-avatar-ring">${esc(initials(plan.title || 'AI'))}</div>
            <video id="avatar-video" class="ai-avatar-video" autoplay playsinline hidden></video>
            <audio id="avatar-audio" autoplay hidden></audio>
            <div class="ai-avatar-label" id="ai-avatar-label">${avatarConfigured ? 'Connecting video avatar…' : 'AI Lecturer'}</div>
          </div>
          <div class="smart-board-wrap">
            <div class="smart-board-head"><div class="dot">👩🏾‍🏫</div><div class="label" id="board-status">AI Lecturer — writing on the board</div></div>
            <div class="smart-board" id="smart-board"></div>
            <div class="smart-board-tray"><span class="marker red"></span><span class="marker blue"></span><span class="marker black"></span><span class="tag">LEARNZA SMART BOARD</span></div>
          </div>
        </div>
        <div class="meta" style="margin-top:12px;" id="section-meta"></div>
        <h3 style="margin:8px 0 12px;" id="section-title"></h3>

        <div id="check-question-box" hidden style="margin:14px 0; padding:14px; border-radius:10px; background:var(--accent-soft);">
          <div style="font-weight:600; margin-bottom:8px;" id="check-question-text"></div>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            <input type="text" id="check-answer-input" placeholder="Type your answer…" style="flex:1; min-width:160px; padding:10px 12px; border-radius:10px; border:1px solid var(--line); background:var(--paper); color:var(--ink);">
            <button class="btn btn-ghost btn-sm" id="check-answer-voice-btn">🎤 Answer by voice</button>
            <button class="btn btn-primary btn-sm" id="check-answer-btn">Submit</button>
          </div>
        </div>

        <div class="controls">
          <button class="btn btn-ghost" id="ask-voice-btn" disabled>🎤 Ask a question</button>
        </div>

        <div class="got-question-toggle" id="got-question-toggle" style="opacity:0.5; cursor:default;">
          <div><div style="font-weight:600;">✋ Got a question? Raise your hand</div><div class="gq-sub" id="gq-sub">Wait for the AI Lecturer to start…</div></div>
          <span id="gq-arrow">▼</span>
        </div>
        <div class="got-question-panel" id="got-question-panel" hidden>
          <div id="interrupt-log" style="display:flex; flex-direction:column; gap:8px; margin-bottom:10px;">
            ${session.turns.filter((t) => t.type === 'INTERRUPT_QUESTION' || t.type === 'INTERRUPT_ANSWER').map((t) => `
              <div class="chat-msg" style="max-width:100%; ${t.role === 'STUDENT' ? 'align-self:flex-end; background:var(--accent-soft);' : ''}">${esc(t.content)}</div>
            `).join('')}
          </div>
          <div style="display:flex; gap:8px;">
            <input type="text" id="interrupt-input" placeholder="e.g. Can you explain that differently?" style="flex:1; padding:10px 12px; border-radius:10px; border:1px solid var(--line); background:var(--paper); color:var(--ink);">
            <button class="btn btn-primary btn-sm" id="interrupt-btn">Ask</button>
          </div>
        </div>
      </div>
    `;

    const avatarRing = document.getElementById('ai-avatar-ring');
    const avatarLabel = document.getElementById('ai-avatar-label');
    const boardStatus = document.getElementById('board-status');
    const board = document.getElementById('smart-board');
    const sectionMeta = document.getElementById('section-meta');
    const sectionTitleEl = document.getElementById('section-title');
    const askVoiceBtn = document.getElementById('ask-voice-btn');

    document.getElementById('lesson-expand-btn').addEventListener('click', () => {
      const stage = document.getElementById('lesson-stage');
      if (!document.fullscreenElement) {
        (stage.requestFullscreen || stage.webkitRequestFullscreen)?.call(stage).catch(() => toast('Fullscreen is not available on this device.'));
      } else {
        document.exitFullscreen?.();
      }
    });

    document.getElementById('back-btn').addEventListener('click', () => {
      stopped = true;
      aiRecStop();
      if (session.individualCourseId) navigate('individual-course-detail', { courseId: session.individualCourseId });
      else navigate('course-detail', { courseId: session.courseId });
    });

    function renderSection(idx) {
      const section = plan.sections[idx];
      sectionMeta.textContent = `Section ${idx + 1} of ${plan.sections.length}`;
      sectionTitleEl.textContent = section.title;
      setBoardContent(board, section.boardActions);
      boardStatus.textContent = 'AI Lecturer — writing on the board';
      return section;
    }

    document.getElementById('got-question-toggle').addEventListener('click', () => {
      if (!teachingStarted) return;
      const panel = document.getElementById('got-question-panel');
      panel.hidden = !panel.hidden;
      document.getElementById('gq-arrow').textContent = panel.hidden ? '▼' : '▲';
    });

    // Flips on once the teacher starts speaking the first section -- unlocks
    // "Ask a question" / "Got a question" for the rest of the lesson, just like a real
    // classroom where you can't raise your hand before class has started.
    function markTeachingStarted() {
      if (teachingStarted) return;
      teachingStarted = true;
      askVoiceBtn.disabled = false;
      const toggle = document.getElementById('got-question-toggle');
      toggle.style.opacity = '';
      toggle.style.cursor = '';
      document.getElementById('gq-sub').textContent = 'Learnza answers visually without leaving the lecture';
    }

    // Shared by the typed "Ask" button and the voice-question flow. `pausedSnapshot`
    // (from pauseSpeechForQuestion()) is whatever the teacher was saying when the
    // question came in -- speaking the answer's onDone resumes that paused narration
    // from its exact spot, which naturally un-blocks the continuous lesson loop's
    // `await speakAsync(...)` below rather than restarting the section.
    async function askInterruptQuestion(question, pausedSnapshot) {
      const panel = document.getElementById('got-question-panel');
      panel.hidden = false;
      document.getElementById('gq-arrow').textContent = '▲';
      boardStatus.textContent = 'AI Lecturer — thinking…';
      try {
        const { answer, boardActions } = await api(`/ai-teacher/sessions/${session.id}/interrupt`, { method: 'POST', body: { question } });
        const log = document.getElementById('interrupt-log');
        log.insertAdjacentHTML('beforeend', `
          <div class="chat-msg" style="max-width:100%; align-self:flex-end; background:var(--accent-soft);">${esc(question)}</div>
          <div class="chat-msg" style="max-width:100%;">${esc(answer)}</div>
        `);
        log.scrollTop = log.scrollHeight;
        // Every answer lands on the board itself, not just the chat log underneath it.
        const answerBoardActions = boardActions && boardActions.length ? boardActions : [{ type: 'TEXT', content: answer }];
        setBoardContent(board, answerBoardActions);
        boardStatus.textContent = 'AI Lecturer — answering your question';
        speakThroughAvatarOrTts(answer, avatarRing, () => {
          if (pausedSnapshot) resumePausedSpeech(pausedSnapshot);
        });
      } catch (err) {
        if (pausedSnapshot) resumePausedSpeech(pausedSnapshot);
        if (err.code === 'SUBSCRIPTION_REQUIRED' || err.code === 'AI_CREDITS_EXHAUSTED') return renderUpgradePrompt(err.message);
        toast(aiErrorMessage(err));
      }
    }

    document.getElementById('interrupt-btn').addEventListener('click', () => {
      if (!teachingStarted) return;
      const input = document.getElementById('interrupt-input');
      const question = input.value.trim();
      if (!question) return;
      input.value = '';
      askInterruptQuestion(question, pauseSpeechForQuestion());
    });

    askVoiceBtn.addEventListener('click', () => {
      if (voiceRecognizer) { try { voiceRecognizer.abort(); } catch { /* already stopping */ } return; }
      const pausedSnapshot = pauseSpeechForQuestion();
      voiceRecognizer = startVoiceCapture({
        button: askVoiceBtn,
        ringEl: avatarRing,
        labelEl: avatarLabel,
        onTranscript: (question) => { voiceRecognizer = null; askInterruptQuestion(question, pausedSnapshot); },
        onCancelled: () => { voiceRecognizer = null; if (pausedSnapshot) resumePausedSpeech(pausedSnapshot); },
      });
    });

    // Speaks the comprehension-check question first; only once that finishes does the
    // answer box (mic + text) appear on screen. Grading reuses the existing
    // check-answer endpoint (graded against whatever section is still current
    // server-side); either way the explanation is spoken before the lesson resumes.
    async function runCheckQuestion(question) {
      boardStatus.textContent = 'AI Lecturer — checking your understanding';
      setBoardContent(board, [{ type: 'TEXT', content: question }]);
      await speakAsync(`Quick question to check you're following: ${question}`, avatarRing);
      if (stopped) return;
      const box = document.getElementById('check-question-box');
      const textEl = document.getElementById('check-question-text');
      const input = document.getElementById('check-answer-input');
      const submitBtn = document.getElementById('check-answer-btn');
      const voiceBtn = document.getElementById('check-answer-voice-btn');
      textEl.textContent = question;
      input.value = '';
      box.hidden = false;
      askVoiceBtn.disabled = true;

      const answer = await new Promise((resolve) => {
        function submit() {
          const value = input.value.trim();
          if (!value) return;
          cleanup();
          resolve(value);
        }
        function onKeydown(e) { if (e.key === 'Enter') submit(); }
        function onVoice() {
          if (voiceRecognizer) { try { voiceRecognizer.abort(); } catch { /* already stopping */ } return; }
          voiceRecognizer = startVoiceCapture({
            button: voiceBtn,
            ringEl: avatarRing,
            labelEl: avatarLabel,
            onTranscript: (text) => { voiceRecognizer = null; input.value = text; submit(); },
            onCancelled: () => { voiceRecognizer = null; },
          });
        }
        function cleanup() {
          submitBtn.removeEventListener('click', submit);
          input.removeEventListener('keydown', onKeydown);
          voiceBtn.removeEventListener('click', onVoice);
        }
        submitBtn.addEventListener('click', submit);
        input.addEventListener('keydown', onKeydown);
        voiceBtn.addEventListener('click', onVoice);
      });
      if (stopped) return;

      box.hidden = true;
      askVoiceBtn.disabled = false;
      boardStatus.textContent = 'AI Lecturer — thinking…';
      try {
        const result = await api(`/ai-teacher/sessions/${session.id}/check-answer`, { method: 'POST', body: { answer } });
        boardStatus.textContent = result.correct ? 'AI Lecturer — well done!' : 'AI Lecturer — explaining';
        setBoardContent(board, [{ type: 'TEXT', content: `${result.correct ? "Correct! " : 'Not quite — '}${result.feedback}` }]);
        await speakAsync(`${result.correct ? "That's correct! " : 'Not quite. '}${result.feedback}`, avatarRing);
      } catch (err) {
        toast(aiErrorMessage(err));
      }
    }

    // The continuous lesson loop: speaks each section, then either runs a
    // comprehension check (once enough teaching has accumulated and this section has
    // one) or advances straight to the next section -- there is no manual "next
    // section" click, ever. A student interrupt naturally pauses this: pausing the
    // in-flight speech just leaves the `await speakAsync(...)` below unresolved until
    // resumePausedSpeech() lets it finish.
    async function runLesson() {
      // Avatar connects in the background -- the lesson starts speaking immediately
      // (via the browser-voice fallback until the avatar is ready) instead of making
      // the student sit through a multi-second WebRTC handshake before anything
      // happens at all. speakThroughAvatarOrTts() automatically upgrades to the
      // avatar for whatever it says next as soon as simliAvatarClient gets set.
      if (avatarConfigured) {
        connectAvatar(document.getElementById('avatar-video'), document.getElementById('avatar-audio'), avatarRing, avatarLabel)
          .then((client) => { if (!stopped && client) simliAvatarClient = client; else if (!stopped) avatarLabel.textContent = 'AI Lecturer'; });
      }
      aiRecStart(session, plan.title, initials(plan.title || 'AI'));
      while (!stopped) {
        const section = renderSection(sectionIdx);
        markTeachingStarted();
        await speakAsync(section.speechText, avatarRing);
        if (stopped) return;

        // The lesson plan already spaces checkQuestions across roughly half the
        // sections (a handful of sections total, so a word-count minimum before
        // asking one almost never got crossed in time -- the check just never fired).
        // Ask it as soon as its section finishes, every time one exists.
        if (section.checkQuestion) {
          await runCheckQuestion(section.checkQuestion);
          if (stopped) return;
        }

        // The full plan is already in hand client-side, so advancing doesn't need to
        // wait on a round trip -- /next only persists the pointer server-side (for
        // resuming a reopened session later) and is fired in the background.
        api(`/ai-teacher/sessions/${session.id}/next`, { method: 'POST' }).catch((err) => {
          if (err.code === 'SUBSCRIPTION_REQUIRED' || err.code === 'AI_CREDITS_EXHAUSTED') renderUpgradePrompt(err.message);
        });
        if (sectionIdx >= plan.sections.length - 1) {
          boardStatus.textContent = 'Lecture complete';
          toast('Lecture complete — nice work!');
          askVoiceBtn.disabled = true;
          setTimeout(aiRecStop, 2500);
          return;
        }
        sectionIdx++;
      }
    }

    runLesson();
  }

  async function renderProgress() {
    const progress = await api('/students/me/progress');
    view.innerHTML = `
      <div class="page-head">
        <h1>My Progress</h1>
        <button class="btn btn-ghost btn-sm" id="view-leaderboard-btn">See leaderboard →</button>
      </div>
      <div class="grid-cards" style="margin-bottom:24px;">
        <div class="card" style="padding:20px;">
          <div class="muted" style="font-size:0.8rem; text-transform:uppercase; letter-spacing:0.03em;">Points</div>
          <div style="font-family:var(--font-display); font-size:2rem;" class="tabular">${progress.points}</div>
        </div>
        <div class="card" style="padding:20px;">
          <div class="muted" style="font-size:0.8rem; text-transform:uppercase; letter-spacing:0.03em;">Current streak</div>
          <div style="font-family:var(--font-display); font-size:2rem;" class="tabular">${progress.currentStreak} day${progress.currentStreak === 1 ? '' : 's'}</div>
        </div>
        <div class="card" style="padding:20px;">
          <div class="muted" style="font-size:0.8rem; text-transform:uppercase; letter-spacing:0.03em;">Longest streak</div>
          <div style="font-family:var(--font-display); font-size:2rem;" class="tabular">${progress.longestStreak} day${progress.longestStreak === 1 ? '' : 's'}</div>
        </div>
      </div>
      <h3 style="margin-bottom:12px; font-size:1rem;">Badges earned</h3>
      <div class="grid-cards">
        ${progress.badges.map((b) => `
          <div class="card" style="padding:18px; text-align:center;">
            <div style="font-size:2rem;">${b.icon}</div>
            <div style="font-weight:600; margin-top:8px;">${esc(b.name)}</div>
            <div class="meta">${esc(b.description)}</div>
          </div>
        `).join('') || '<p class="muted">Take a CBT test to start earning badges.</p>'}
      </div>
    `;
    document.getElementById('view-leaderboard-btn').addEventListener('click', () => navigate('leaderboard'));
  }

  async function renderLeaderboard() {
    const isIndividual = state.user.isIndividual;
    // Individual learners have no department concept at all -- gamification.getLeaderboard
    // already scopes by schoolId (null for individuals), so this naturally becomes an
    // individual-learners-only leaderboard with no department filter needed.
    const departments = isIndividual ? [] : (await api(`/departments?schoolId=${state.user.schoolId}`)).departments;
    const deptId = state.view.departmentId || '';
    const { leaderboard } = await api('/leaderboard' + (deptId ? `?departmentId=${deptId}` : ''));
    const myEntry = leaderboard.find((row) => row.fullName === state.user.fullName);

    view.innerHTML = `
      <div class="page-head"><h1>Leaderboard</h1><button class="btn btn-ghost btn-sm" id="back-btn">← Back</button></div>
      ${isIndividual ? '' : `
      <div class="field" style="max-width:280px; margin-bottom:16px;">
        <label>Department</label>
        <select id="leaderboard-dept">
          <option value="">All departments</option>
          ${departments.map((d) => `<option value="${d.id}" ${d.id === deptId ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
        </select>
      </div>
      `}
      ${myEntry ? `<div class="card" style="padding:14px 18px; margin-bottom:16px; display:flex; justify-content:space-between; align-items:center;"><span>Your rank: <strong class="tabular">#${myEntry.rank}</strong></span><span class="pill pill-accent tabular">${myEntry.points} pts</span></div>` : ''}
      <div class="card" style="overflow-x:auto;">
        <table class="data-table">
          <thead><tr><th>#</th><th>Student</th>${isIndividual ? '' : '<th>Department</th>'}<th>Points</th><th>Streak</th></tr></thead>
          <tbody>
            ${leaderboard.map((row) => `
              <tr ${row.fullName === state.user.fullName ? 'style="background:var(--accent-soft);"' : ''}>
                <td class="tabular">${row.rank}</td>
                <td>${esc(row.fullName)}</td>
                ${isIndividual ? '' : `<td>${esc(row.department || '—')}</td>`}
                <td class="tabular">${row.points}</td>
                <td class="tabular">${row.currentStreak}🔥</td>
              </tr>
            `).join('') || `<tr><td colspan="${isIndividual ? 4 : 5}" class="muted" style="padding:16px;">No points earned yet — be the first!</td></tr>`}
          </tbody>
        </table>
      </div>
    `;
    document.getElementById('back-btn').addEventListener('click', () => navigate('my-dashboard'));
    const deptSelect = document.getElementById('leaderboard-dept');
    if (deptSelect) deptSelect.addEventListener('change', (e) => {
      navigate('leaderboard', { departmentId: e.target.value });
    });
  }

  function initials(name) {
    return name.split(' ').filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  }

  // The initials circle doubles as a click-to-upload profile picture, for the logged-in
  // user's own avatar only (Digital ID, My Dashboard) -- shows the uploaded photo once
  // set, falling back to initials. `id` must be unique per render since a screen can
  // show it more than once (it currently never does, but this keeps it safe).
  // Mounts the shared Digital ID card for the signed-in person into #lzx-id-host.
  function mountMyDigitalId() {
    const host = document.getElementById('lzx-id-host');
    if (!host) return;
    LZX.digitalId(host, {
      user: state.user, school: state.school, department: state.department, api, esc, toast,
      photoPath: '/auth/me/avatar',
      onUser: (user) => { state.user = user; saveSession(state.token, user); },
    });
  }

  function selfAvatarHtml(id) {
    const u = state.user;
    return u.avatarUrl
      ? `<img src="${esc(u.avatarUrl)}" id="${id}" class="id-avatar" style="object-fit:cover; cursor:pointer;" title="Change photo">`
      : `<div class="id-avatar" id="${id}" style="cursor:pointer;" title="Add a profile photo">${esc(initials(u.fullName))}</div>`;
  }

  function wireSelfAvatarUpload(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('click', (e) => {
      // The avatar often sits inside a larger clickable card (e.g. My Dashboard's
      // profile card navigates to Digital ID) -- stop that from also firing.
      e.stopPropagation();
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.hidden = true;
      document.body.appendChild(input);
      input.addEventListener('change', async () => {
        const file = input.files[0];
        input.remove();
        if (!file) return;
        const fd = new FormData();
        fd.append('avatar', file);
        try {
          const { user } = await api('/auth/me/avatar', { method: 'POST', body: fd });
          state.user = user;
          saveSession(state.token, user);
          toast('Photo updated');
          render();
        } catch (err) { toast(err.message); }
      });
      input.click();
    });
  }

  // Individual (non-school) learners get a Digital ID too -- structured around Learnza
  // account details (member since, subscription, self-directed courses, e-Library
  // access) and their own personal/student details, instead of school-only concepts
  // (department, matric number, hostel, transcript, clearance) that don't apply to them.
  async function renderIndividualDigitalId() {
    const [{ courses }, { active, subscription }] = await Promise.all([
      api('/individual-courses'),
      api('/billing/status'),
    ]);
    const u = state.user;
    view.innerHTML = `
      <div class="page-head"><h1>Digital ID</h1></div>
      <div id="lzx-id-host"></div>

      <h3 style="margin:22px 0 12px; font-size:1rem;">My details</h3>
      ${learnerDetailsCard(u)}

      <h3 style="margin-bottom:12px; font-size:1rem;">Learnza account</h3>
      <ul class="credential-list" style="margin-bottom:28px;">
        <li class="clickable" id="cred-courses" style="cursor:pointer;"><span>Self-directed courses</span><span class="pill pill-pass">${courses.length} course${courses.length === 1 ? '' : 's'}</span></li>
        <li class="clickable" id="cred-subscription" style="cursor:pointer;"><span>Subscription</span><span class="pill ${active ? 'pill-pass' : 'pill-muted'}">${active ? `Active until ${new Date(subscription.expiresAt).toLocaleDateString()}` : 'No active plan'}</span></li>
        <li class="clickable" id="cred-library" style="cursor:pointer;"><span>e-Library access</span><span class="pill pill-pass">Granted</span></li>
      </ul>
    `;
    mountMyDigitalId();
    document.getElementById('cred-courses').addEventListener('click', () => navigate('individual-courses'));
    document.getElementById('cred-subscription').addEventListener('click', () => navigate('billing'));
    document.getElementById('cred-library').addEventListener('click', () => navigate('library'));
  }

  // A student's full result history, all in one place -- self-taken test/assessment
  // scores and lecturer-published formal results, across every course, not just the
  // capped "recent" list on the dashboard or the summary on Digital ID.
  async function renderDigitalId() {
    return renderIndividualDigitalId();
    const [{ courses }, { results }, { results: formalResults }, { active, subscription }, { request: transcriptReq }, { request: clearanceReq }, { application: hostelApp }, { credentials }] = await Promise.all([
      api('/students/me/courses'),
      api('/students/me/results'),
      api('/students/me/formal-results'),
      api('/billing/status'),
      api('/students/me/transcript-request'),
      api('/students/me/clearance-request'),
      api('/students/me/hostel-application'),
      api('/students/me/credentials'),
    ]);
    const u = state.user;

    view.innerHTML = `
      <div class="page-head"><h1>Digital ID</h1></div>
      <div id="lzx-id-host"></div>

      <h3 style="margin-bottom:12px; font-size:1rem;">Digital credentials</h3>
      <ul class="credential-list" style="margin-bottom:28px;">
        <li class="clickable" id="cred-courses" style="cursor:pointer;"><span>Course registration</span><span class="pill pill-pass">${courses.length} course${courses.length === 1 ? '' : 's'}</span></li>
        <li class="clickable" id="cred-subscription" style="cursor:pointer;"><span>Subscription</span><span class="pill ${active ? 'pill-pass' : 'pill-muted'}">${active ? `Active until ${new Date(subscription.expiresAt).toLocaleDateString()}` : 'No active plan'}</span></li>
        <li class="clickable" id="cred-library" style="cursor:pointer;"><span>e-Library access</span><span class="pill pill-pass">Granted</span></li>
        <li>
          <span>Transcript</span>
          ${transcriptReq
            ? transcriptReq.status === 'ISSUED'
              ? `<button class="btn btn-primary btn-sm" id="view-transcript-btn">View transcript</button>`
              : `<span class="pill pill-accent">Pending admin review</span>`
            : `<button class="btn btn-ghost btn-sm" id="request-transcript-btn">Request transcript</button>`}
        </li>
        <li>
          <span>Clearance</span>
          ${clearanceReq
            ? clearanceReq.status === 'CLEARED' ? '<span class="pill pill-pass">Cleared</span>'
            : clearanceReq.status === 'DENIED' ? `<span class="pill pill-danger">Denied${clearanceReq.note ? `: ${esc(clearanceReq.note)}` : ''}</span>`
            : '<span class="pill pill-accent">Pending admin review</span>'
            : `<button class="btn btn-ghost btn-sm" id="request-clearance-btn">Request clearance</button>`}
        </li>
        <li>
          <span>Hostel / accommodation</span>
          ${hostelApp
            ? hostelApp.status === 'APPROVED' ? `<span class="pill pill-pass">${hostelApp.hostel ? `${esc(hostelApp.hostel.name)} — ` : ''}Room: ${esc(hostelApp.roomAssigned)}</span>`
            : hostelApp.status === 'REJECTED' ? '<span class="pill pill-danger">Not approved</span>'
            : '<span class="pill pill-accent">Pending admin review</span>'
            : `<button class="btn btn-ghost btn-sm" id="request-hostel-btn">Apply for hostel</button>`}
        </li>
        <li class="clickable" id="cred-certificates" style="cursor:pointer;"><span>Certificates &amp; graduation records</span><span class="pill ${credentials.length ? 'pill-pass' : 'pill-muted'}">${credentials.length ? `${credentials.length} issued` : 'None issued yet'}</span></li>
      </ul>
      <div id="certificates-section">
      ${credentials.length ? `
        <div class="card" style="margin-bottom:28px;">
          ${credentials.map((c) => `<div class="list-row"><div><div style="font-weight:600;">${esc(c.title)}</div><div class="meta">Issued ${new Date(c.issuedAt).toLocaleDateString()} · verification code <span class="tabular">${esc(c.verifyCode)}</span></div></div><a class="btn btn-ghost btn-sm" href="verify.html?code=${esc(c.verifyCode)}" target="_blank" rel="noopener">Verify link</a></div>`).join('')}
        </div>
      ` : ''}
      </div>

      <h3 style="margin-bottom:12px; font-size:1rem;">Results</h3>
      <div class="card" style="overflow-x:auto;">
        <table class="data-table">
          <thead><tr><th>Course</th><th>Assessment</th><th>Type</th><th>Score</th><th>Date</th></tr></thead>
          <tbody>
            ${results.map((r) => `
              <tr class="clickable" data-open-result="${r.assessmentId}" style="cursor:pointer;">
                <td class="tabular">${esc(r.courseCode || r.courseTitle)}</td>
                <td>${esc(r.assessmentTitle)}</td>
                <td>${esc(r.assessmentType)}</td>
                <td class="tabular">${r.score}/${r.total}</td>
                <td class="tabular">${new Date(r.submittedAt).toLocaleDateString()}</td>
              </tr>
            `).join('') || '<tr><td colspan="5" class="muted" style="padding:16px;">No results yet.</td></tr>'}
          </tbody>
        </table>
      </div>

      <h3 style="margin:24px 0 12px; font-size:1rem;">Formal results (published by lecturers)</h3>
      <div class="card" style="overflow-x:auto;">
        <table class="data-table">
          <thead><tr><th>Course</th><th>Semester</th><th>Score</th><th>Grade</th><th>Remark</th><th>Published</th></tr></thead>
          <tbody>
            ${formalResults.map((r) => `
              <tr>
                <td class="tabular">${esc(r.course.code)}</td>
                <td>${esc(r.term)}</td>
                <td class="tabular">${r.score}</td>
                <td class="tabular">${esc(r.grade || '—')}</td>
                <td>${esc(r.remark || '—')}</td>
                <td class="tabular">${new Date(r.publishedAt).toLocaleDateString()}</td>
              </tr>
            `).join('') || '<tr><td colspan="6" class="muted" style="padding:16px;">No formal results published yet.</td></tr>'}
          </tbody>
        </table>
      </div>
    `;

    mountMyDigitalId();
    document.getElementById('cred-courses').addEventListener('click', () => navigate(state.user.isIndividual ? 'individual-courses' : 'courses'));
    view.querySelectorAll('[data-open-result]').forEach((row) => {
      row.addEventListener('click', () => navigate('take-assessment', { assessmentId: row.dataset.openResult, backTo: 'digital-id' }));
    });
    document.getElementById('cred-subscription').addEventListener('click', () => navigate('billing'));
    document.getElementById('cred-library').addEventListener('click', () => navigate('library'));
    document.getElementById('cred-certificates').addEventListener('click', () => {
      if (!credentials.length) return toast('No certificates issued yet — your school issues these on graduation.');
      document.getElementById('certificates-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    const reqTranscriptBtn = document.getElementById('request-transcript-btn');
    if (reqTranscriptBtn) reqTranscriptBtn.addEventListener('click', async () => { await api('/students/me/transcript-request', { method: 'POST' }); toast('Transcript requested'); render(); });
    const viewTranscriptBtn = document.getElementById('view-transcript-btn');
    if (viewTranscriptBtn) viewTranscriptBtn.addEventListener('click', () => navigate('transcript'));
    const reqClearanceBtn = document.getElementById('request-clearance-btn');
    if (reqClearanceBtn) reqClearanceBtn.addEventListener('click', async () => { await api('/students/me/clearance-request', { method: 'POST' }); toast('Clearance requested'); render(); });
    const reqHostelBtn = document.getElementById('request-hostel-btn');
    if (reqHostelBtn) reqHostelBtn.addEventListener('click', async () => {
      const roomPreference = prompt('Any room/accommodation preference? (optional)') || '';
      await api('/students/me/hostel-application', { method: 'POST', body: { roomPreference } });
      toast('Hostel application submitted');
      render();
    });
  }

  // ================= SETTINGS (student, lecturer, admin -- shared) =================
  // Structured the same way PassNow's Settings screens are: uppercase section labels,
  // each a card of stacked rows -- either a toggle (persisted immediately on change)
  // or an arrow row that navigates to a sub-screen (Edit Profile / Change Password).

  function settingsToggleRowHtml({ icon, label, sub, key, on }) {
    return `
      <div class="settings-item">
        <div class="settings-item-icon">${icon}</div>
        <div class="settings-item-text"><div style="font-weight:600;">${esc(label)}</div>${sub ? `<div class="settings-item-sub">${esc(sub)}</div>` : ''}</div>
        <button class="settings-toggle ${on ? 'on' : ''}" data-toggle-key="${key}"><div class="settings-toggle-knob"></div></button>
      </div>`;
  }

  function settingsArrowRowHtml({ icon, label, sub, action }) {
    return `
      <div class="settings-item clickable" data-settings-action="${action}">
        <div class="settings-item-icon">${icon}</div>
        <div class="settings-item-text"><div style="font-weight:600;">${esc(label)}</div>${sub ? `<div class="settings-item-sub">${esc(sub)}</div>` : ''}</div>
        <span class="settings-item-arrow">›</span>
      </div>`;
  }

  function renderSettings() {
    const u = state.user;
    const isAdmin = u.role === 'ADMIN';
    const currentTheme = localStorage.getItem('vp_theme') || 'system';

    view.innerHTML = `
      <div class="page-head"><h1>Settings</h1></div>

      <div class="settings-section">
        <div class="settings-section-label">Appearance</div>
        <div class="card">
          ${settingsToggleRowHtml({ icon: '🌙', label: 'Dark Mode', sub: 'Easier on the eyes at night', key: 'darkMode', on: currentTheme === 'dark' })}
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-label">Notifications</div>
        <div class="card">
          ${settingsToggleRowHtml({ icon: '🔔', label: 'Notifications', sub: u.notificationsMuted ? 'Muted -- you won\'t get new alerts' : 'You\'ll get new alerts as they happen', key: 'notificationsMuted', on: !u.notificationsMuted })}
        </div>
      </div>

      ${isAdmin ? `
      <div class="settings-section">
        <div class="settings-section-label">School</div>
        <div class="card">
          ${settingsArrowRowHtml({ icon: '🏫', label: 'Departments & Courses', action: 'nav:admin-academics' })}
          ${settingsArrowRowHtml({ icon: '🏠', label: 'Hostels', action: 'nav:admin-hostel-allocations' })}
        </div>
      </div>
      ` : ''}

      <div class="settings-section">
        <div class="settings-section-label">Help</div>
        <div class="card">
          ${u.role === 'STUDENT' ? settingsArrowRowHtml({ icon: '🪙', label: 'AI Minutes & Coins', sub: 'Top up live AI Lecturer time', action: 'nav:wallet' }) : ''}
          ${settingsArrowRowHtml({ icon: '🎧', label: 'Help & Support', sub: 'Tickets and live chat', action: 'nav:support' })}
          ${settingsArrowRowHtml({ icon: '⭐', label: 'Rate Learnza', action: 'nav:support-review' })}
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-label">Account</div>
        <div class="card">
          ${settingsArrowRowHtml({ icon: '👤', label: 'Edit Profile', sub: 'Name and phone number', action: 'nav:settings-profile' })}
          ${settingsArrowRowHtml({ icon: '🔒', label: 'Change Password', action: 'nav:settings-password' })}
          ${settingsArrowRowHtml({ icon: '🚪', label: 'Log Out', action: 'logout' })}
        </div>
      </div>
    `;

    view.querySelectorAll('[data-toggle-key]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const key = btn.dataset.toggleKey;
        if (key === 'darkMode') {
          const next = currentTheme === 'dark' ? 'light' : 'dark';
          localStorage.setItem('vp_theme', next);
          document.documentElement.setAttribute('data-theme', next);
          render();
          return;
        }
        if (key === 'notificationsMuted') {
          const nextMuted = !u.notificationsMuted;
          try {
            const { user } = await api('/auth/me/notifications', { method: 'PATCH', body: { muted: nextMuted } });
            state.user = user;
            saveSession(state.token, user);
            render();
          } catch (err) { toast(err.message); }
        }
      });
    });
    view.querySelectorAll('[data-settings-action]').forEach((row) => {
      row.addEventListener('click', () => {
        const action = row.dataset.settingsAction;
        if (action === 'logout') return document.getElementById('signout-btn').click();
        if (action.startsWith('nav:')) navigate(action.slice(4));
      });
    });
  }

  // Shows every detail on record for this person, not just the two fields that happen
  // to be self-editable -- identity fields a school controls (matric/staff ID,
  // department, access code) are shown read-only with a note to contact admin, since
  // those stay admin-managed in the Directory. Individual learners have no admin
  // managing those for them, so their institution/level fields are fully editable here.
  function renderSettingsProfile() {
    const u = state.user;
    const readOnlyRows = [];
    if (!u.isIndividual) {
      if (u.role === 'STUDENT') {
        readOnlyRows.push(['Matric number', u.matricNumber || '—'], ['Department', state.department ? state.department.name : '—'], ['Level', levelLabel(u.yearOfStudy) || '—']);
      } else if (u.role === 'LECTURER' || u.role === 'STAFF') {
        readOnlyRows.push(['Staff ID', u.staffId || '—'], ['Department', state.department ? state.department.name : '—']);
        if (u.position) readOnlyRows.push(['Position', u.position]);
      }
      if (state.school) readOnlyRows.push(['School', [state.school.name, state.school.location].filter(Boolean).join(', ')]);
      if (u.accessCode) readOnlyRows.push(['Access code', u.accessCode]);
    }
    readOnlyRows.push(['Email', u.email], ['Member since', new Date(u.createdAt).toLocaleDateString()]);

    view.innerHTML = `
      <div class="page-head"><h1>Edit Profile</h1><button class="btn btn-ghost btn-sm" id="back-btn">← Back to Settings</button></div>
      <div class="card" style="padding:24px; max-width:480px; margin-bottom:22px;">
        <form id="profile-form">
          <div class="field"><label>Full name</label><input type="text" id="profile-name" value="${esc(u.fullName)}" required></div>
          <div class="field"><label>Phone number</label><input type="tel" id="profile-phone" value="${esc(u.phone || '')}"></div>
          ${u.isIndividual ? `
            <div class="field"><label>Institution type</label>
              <select id="profile-institution-type">
                ${Object.entries(INSTITUTION_TYPE_LABELS).map(([v, l]) => `<option value="${v}" ${u.institutionType === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}
              </select>
            </div>
            <div class="field"><label>School name</label><input type="text" id="profile-school" value="${esc(u.attendedSchoolName || '')}"></div>
            <div class="field"><label>Department</label><input type="text" id="profile-department" value="${esc(u.attendedDepartment || '')}"></div>
            <div class="field"><label>Course of study</label><input type="text" id="profile-course" value="${esc(u.courseOfStudy || '')}"></div>
            <div class="field"><label>Level</label>
              <select id="profile-level">
                <option value="">Select…</option>
                ${[1, 2, 3, 4, 5, 6].map((n) => `<option value="${n}" ${u.yearOfStudy === n ? 'selected' : ''}>${n * 100}L</option>`).join('')}
              </select>
            </div>
          ` : ''}
          <button class="btn btn-primary" type="submit">Save changes</button>
        </form>
      </div>
      <h3 style="margin-bottom:10px; font-size:1rem;">On record</h3>
      <div class="card" style="max-width:480px;">
        ${readOnlyRows.map(([label, value]) => `<div class="list-row"><div class="meta">${esc(label)}</div><div>${esc(value)}</div></div>`).join('')}
      </div>
      ${!u.isIndividual ? '<p class="muted" style="max-width:480px; margin-top:10px; font-size:0.82rem;">Identity details above are managed by your school administrator.</p>' : ''}
    `;
    document.getElementById('back-btn').addEventListener('click', () => navigate('settings'));
    document.getElementById('profile-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = { fullName: document.getElementById('profile-name').value, phone: document.getElementById('profile-phone').value };
      if (u.isIndividual) {
        body.institutionType = document.getElementById('profile-institution-type').value;
        body.attendedSchoolName = document.getElementById('profile-school').value;
        body.attendedDepartment = document.getElementById('profile-department').value;
        body.courseOfStudy = document.getElementById('profile-course').value;
        body.yearOfStudy = document.getElementById('profile-level').value;
      }
      try {
        const { user } = await api('/auth/me', { method: 'PATCH', body });
        state.user = user;
        saveSession(state.token, user);
        toast('Profile updated');
        navigate('settings');
      } catch (err) { toast(err.message); }
    });
  }

  function renderSettingsPassword() {
    view.innerHTML = `
      <div class="page-head"><h1>Change Password</h1><button class="btn btn-ghost btn-sm" id="back-btn">← Back to Settings</button></div>
      <div class="card" style="padding:24px; max-width:480px;">
        <form id="password-form">
          <div class="field"><label>Current password</label><div class="password-field"><input type="password" id="pw-current" required><button type="button" class="pw-toggle-btn" tabindex="-1">👁</button></div></div>
          <div class="field"><label>New password</label><div class="password-field"><input type="password" id="pw-new" required minlength="6"><button type="button" class="pw-toggle-btn" tabindex="-1">👁</button></div></div>
          <div class="field"><label>Confirm new password</label><div class="password-field"><input type="password" id="pw-confirm" required minlength="6"><button type="button" class="pw-toggle-btn" tabindex="-1">👁</button></div></div>
          <button class="btn btn-primary" type="submit">Update password</button>
        </form>
      </div>
    `;
    document.getElementById('back-btn').addEventListener('click', () => navigate('settings'));
    document.getElementById('password-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const newPassword = document.getElementById('pw-new').value;
      if (newPassword !== document.getElementById('pw-confirm').value) return toast('New passwords do not match.');
      try {
        const changed = await api('/auth/change-password', {
          method: 'POST',
          body: { currentPassword: document.getElementById('pw-current').value, newPassword },
        });
        if (changed.token) {
          state.token = changed.token;
          state.refreshToken = changed.refreshToken;
          saveSession(state.token, state.user, state.refreshToken);
        }
        toast('Password updated');
        navigate('settings');
      } catch (err) { toast(err.message); }
    });
  }

  // Dashboard list sections (Assignments, Attendance, Results, Lessons, Notifications)
  // all follow the same "show 3, View more reveals the rest" pattern.
  const DASH_LIMIT = 3;

  // ---- Study Plan (as in PassNow): days to the exam, hours a day, a week laid out course by course, and the weak areas ----
  function planModel(daily, courses, results) {
    const plan = (daily && daily.plan) || {};
    const exam = plan.examDate ? new Date(plan.examDate + 'T00:00:00') : null;
    const examDate = exam || new Date(Date.now() + 56 * 86400000);
    const daysLeft = Math.max(0, Math.ceil((examDate - new Date()) / 86400000));
    const hours = plan.hours || 3;
    const scores = {};
    (results || []).forEach((r) => {
      const a = r.assessment || {};
      const key = a.course ? a.course.code : (a.individualCourse ? a.individualCourse.title : null);
      if (!key) return;
      (scores[key] = scores[key] || []).push((r.score / (r.total || 1)) * 100);
    });
    const rows = (courses || []).map((c) => {
      const list = scores[c.code || c.title] || [];
      return { course: c, avg: list.length ? Math.round(list.reduce((x, y) => x + y, 0) / list.length) : null };
    });
    const weak = rows.filter((r) => r.avg == null || r.avg < 60);
    const n = rows.length;
    const shift = n ? ((plan.seed || 0) % n + n) % n : 0;
    const order = n ? rows.map((_, i) => rows[(i + shift) % n].course) : [];
    return { plan, estimated: !exam, examDate, daysLeft, hours, rows, weak, order };
  }

  async function renderStudyPlan() {
    const isIndividual = state.user.isIndividual;
    const [daily, dash, cr] = await Promise.all([
      api('/questions/daily').catch(() => null),
      api('/students/me/dashboard').catch(() => ({ recentResults: [] })),
      api(isIndividual ? '/individual-courses' : '/students/me/courses').catch(() => ({ courses: [] })),
    ]);
    const m = planModel(daily, cr.courses || [], dash.recentResults);
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const todayIdx = new Date().getDay();
    const sunday = new Date(); sunday.setHours(0, 0, 0, 0); sunday.setDate(sunday.getDate() - todayIdx);
    const doneOn = (d) => { const t = new Date(sunday.getTime() + d * 86400000).getTime(); return !!(daily && daily.days && daily.days.find((x) => x.date === t && x.done)); };
    const nm = (c) => esc(c ? c.title : 'Mixed revision');
    const courseScreen = isIndividual ? 'individual-course-detail' : 'course-detail';
    const week = [0, 1, 2, 3, 4, 5, 6].map((d) => {
      const c1 = m.order[d % (m.order.length || 1)], c2 = m.order[(d + 1) % (m.order.length || 1)];
      if (d < todayIdx) return `<div class="sp-day past"><div class="sp-head"><span>${dayNames[d]}</span><span class="pill ${doneOn(d) ? 'pill-pass' : 'pill-muted'}">${doneOn(d) ? 'Done ✓' : 'Missed'}</span></div><div class="sp-body"><b>${nm(c1)}:</b> Daily Challenge · <b>${nm(c2)}:</b> read and revise</div></div>`;
      if (d === todayIdx) return `<div class="sp-day today"><div class="sp-head"><span>${dayNames[d]} — Today</span><span class="pill pill-accent">⏰ Now</span></div><div class="sp-body">
        <div class="sp-go" data-jump-nav="daily-challenge">➤ ${nm(c1)}: Daily Challenge → Start now</div>
        ${c2 ? `<div class="sp-go" data-sj-screen="${courseScreen}" data-sj-params="${esc(JSON.stringify({ courseId: c2.id }))}">➤ ${nm(c2)}: read and revise → Open course</div>` : ''}
        <div class="sp-go" data-jump-nav="cbt-mock">➤ CBT Mock Exam practice → Start now</div></div></div>`;
      const names = m.order.slice(0, 3).map((c) => esc(c.title)).join(' · ') || 'Revision';
      return `<div class="sp-day future"><div class="sp-head"><span>${dayNames[d]}</span></div><div class="sp-body">${names} revision${d === 6 ? ' · Full CBT Mock Exam (weekend)' : ''}</div></div>`;
    }).join('');
    const weakHtml = m.weak.length
      ? m.weak.slice(0, 6).map((r) => `<div class="sp-weak"><div class="sp-weak-t">${esc(r.course.title)}</div><div class="sp-weak-s">${r.avg == null ? 'Not started — take a test' : r.avg + '% average'}</div><div class="pn-progress"><div style="width:${r.avg || 0}%;background:linear-gradient(90deg,#FF3B3B,#FF8A80);"></div></div></div>`).join('')
      : '<div class="pn-empty">No weak areas. Keep going! 🎉</div>';
    view.innerHTML = `
      <div class="page-head"><h1>Study Plan</h1></div>
      <div class="sp-hero">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;gap:10px;">
          <div><div class="sp-k">Generated for</div><div class="sp-name">${esc(state.user.fullName)} 🎓</div></div>
          <div style="text-align:right;"><div class="sp-k">Goal</div><div class="sp-goal">${isIndividual ? 'My exams' : 'Semester exam'} 🎯</div></div>
        </div>
        <div class="sp-stats">
          <div><b>${m.daysLeft} days</b><span>to exam${m.estimated ? ' (estimate)' : ''}</span></div>
          <div class="sp-sep"></div><div><b>${m.hours} hrs</b><span>study/day</span></div>
          <div class="sp-sep"></div><div><b style="color:#00C853;">${m.rows.length} course${m.rows.length === 1 ? '' : 's'}</b><span>to cover</span></div>
        </div>
      </div>
      <div class="card" style="padding:16px;margin-bottom:16px;">
        <div class="sp-form">
          <div class="field" style="margin:0;"><label>Exam date</label><input type="date" id="sp-date" value="${m.plan.examDate || m.examDate.toISOString().slice(0, 10)}"></div>
          <div class="field" style="margin:0;"><label>Hours a day</label><select id="sp-hours">${[1, 1.5, 2, 3, 4, 5, 6].map((h) => `<option value="${h}" ${h === m.hours ? 'selected' : ''}>${h} hr${h === 1 ? '' : 's'}</option>`).join('')}</select></div>
        </div>
        <div style="display:flex;gap:10px;margin-top:14px;"><button class="btn btn-ghost" id="sp-regen" style="flex:1;">🔄 Regenerate</button><button class="btn btn-primary" id="sp-save" style="flex:1;">💾 Save Plan</button></div>
      </div>
      <div class="sec"><div class="sh"><div class="st">📅 This Week</div></div><div class="sp-week">${week}</div></div>
      <div class="sp-weakbox"><div class="sp-weak-h">⚠️ Priority Weak Areas</div>${weakHtml}</div>`;
    const save = async (seed) => {
      try {
        await api('/questions/plan', { method: 'POST', body: { examDate: view.querySelector('#sp-date').value, hours: Number(view.querySelector('#sp-hours').value), seed } });
        toast('Study plan saved');
        renderStudyPlan();
      } catch (err) { toast(err.message); }
    };
    view.querySelector('#sp-save').addEventListener('click', () => save(m.plan.seed || 0));
    view.querySelector('#sp-regen').addEventListener('click', () => save((m.plan.seed || 0) + 1));
    view.querySelectorAll('[data-jump-nav]').forEach((el) => el.addEventListener('click', () => navigate(el.dataset.jumpNav)));
  }

  // ---- My Dashboard (a student's hub, laid out like PassNow's): the numbers, then every activity in one place ----
  function dhTile(nav, icon, label, pal) {
    return `<div class="dh-tile p${pal}" data-jump-nav="${nav}"><div class="dh-i">${icon}</div><div class="dh-l">${label}</div></div>`;
  }
  async function renderStudentHub() {
    const isIndividual = state.user.isIndividual;
    const { assignments, attendance, recentResults, individualAssessments } = await api('/students/me/dashboard');
    const attendancePct = attendance && attendance.totalCount ? Math.round((attendance.presentCount / attendance.totalCount) * 100) : null;
    const avg = recentResults.length ? Math.round(recentResults.reduce((sum, r) => sum + (r.score / (r.total || 1)) * 100, 0) / recentResults.length) : null;
    const pending = isIndividual ? (individualAssessments || []).filter((a) => !a.mySubmission || !a.mySubmission.submittedAt).length : assignments.filter((a) => !a.mySubmission).length;
    const numbers = isIndividual
      ? [[pending, 'To do', '#FFD600'], [avg == null ? '—' : avg + '%', 'Average', '#00C853'], [recentResults.length, 'Taken', '#fff']]
      : [[pending, 'Assignments', '#FFD600'], [attendancePct == null ? '—' : attendancePct + '%', 'Attendance', '#00C853'], [avg == null ? '—' : avg + '%', 'Average', '#fff']];
    view.innerHTML = `
      <div class="page-head"><h1>My Dashboard</h1></div>
      <div class="dh-band">${numbers.map(([v, l, c]) => `<div><div class="dh-n" style="color:${c}">${v}</div><div class="dh-nl">${l}</div></div>`).join('')}</div>
      <div class="dh-title">📋 My Activities</div>
      <div class="dh-grid">${isIndividual ? `${dhTile('my-assessments', '📋', 'Assignments & Tests', 0)}${dhTile('my-ai-lectures', '🎓', 'AI Pre-recorded', 1)}${dhTile('my-ai-live', '🎙️', 'AI Live Recorded', 2)}${dhTile('my-activity', '📝', 'Test Results', 2)}${dhTile('daily-challenge', '⚡', 'Daily Challenge', 3)}${dhTile('study-plan', '🗓️', 'Study Plan', 4)}${dhTile('tests-hub', '✅', 'Tests', 4)}${dhTile('cbt-mock', '🎯', 'CBT Mock', 5)}${dhTile('semester-exam-hub', '🏁', 'Semester Exam', 1)}${dhTile('lab-hub', '🧪', 'Digital Lab', 3)}` : `${dhTile('my-assignments', '📋', 'Assignments', 0)}${dhTile('my-attendance', '🗓️', 'Attendance', 1)}${dhTile('my-lectures', '🎬', 'Lectures', 2)}${dhTile('class-recordings', '🎞️', 'Class Recordings', 3)}${dhTile('my-ai-lectures', '🎓', 'AI Pre-recorded', 1)}${dhTile('my-ai-live', '🎙️', 'AI Live Recorded', 2)}${dhTile('my-activity', '📝', 'Test Results', 4)}${dhTile('daily-challenge', '⚡', 'Daily Challenge', 5)}${dhTile('study-plan', '🗓️', 'Study Plan', 0)}${dhTile('tests-hub', '✅', 'Tests', 0)}${dhTile('cbt-mock', '🎯', 'CBT Mock', 1)}${dhTile('semester-exam-hub', '🏁', 'Semester Exam', 3)}${dhTile('lab-hub', '🧪', 'Digital Lab', 5)}`}</div>
      <div class="dh-row" data-jump-nav="my-activity"><span>🔔</span><span class="dh-rt">Notifications</span><span class="dh-go">›</span></div>
      <div class="dh-title">🏆 Leaderboard Positions</div>
      <div class="dh-grid two">${dhTile('leaderboard', '🌍', 'Leaderboard', 4)}${dhTile('groups', '👨‍👩‍👧', 'Study Groups', 2)}</div>
      <div class="dh-title">📊 Progress</div>
      <div class="dh-grid two">${dhTile('progress', '📈', 'My Progress', 0)}${isIndividual ? dhTile('billing', '💳', 'Subscription', 1) : dhTile('student-results', '📊', 'Results', 1)}${isIndividual ? '' : dhTile('academic-record', '🎓', 'Academic Record', 3)}${isIndividual ? '' : dhTile('fees', '💰', 'School Fees', 5)}</div>
      <div class="dh-title">👤 More</div>
      <div class="dh-grid two">${dhTile('digital-id', '🪪', 'Digital ID & Profile', 2)}${dhTile('settings', '⚙️', 'Settings', 4)}</div>`
      .replace('__X__', '');
    view.querySelectorAll('[data-jump-nav]').forEach((el) => el.addEventListener('click', () => navigate(el.dataset.jumpNav)));
  }

  async function renderMyDashboard(only) {
    const isIndividual = state.user.isIndividual;
    // Everything the page needs is asked for at once: one wait instead of five in a row.
    const [{ assignments, attendance, recentResults, lessons, liveRecordings, individualAssessments }, { notifications }, dailyRes, courseRes] = await Promise.all([
      api('/students/me/dashboard'),
      api('/notifications'),
      only || false ? null : api('/questions/daily').catch(() => null),
      only ? null : api(isIndividual ? '/individual-courses' : '/students/me/courses').catch(() => ({ courses: [] })),
    ]);
    const attendancePct = attendance.totalCount ? Math.round((attendance.presentCount / attendance.totalCount) * 100) : null;
    const avgScorePct = recentResults.length
      ? Math.round(recentResults.reduce((sum, r) => sum + (r.score / (r.total || 1)) * 100, 0) / recentResults.length)
      : null;
    const attendanceByCourse = {};
    for (const a of attendance.recent) {
      if (!attendanceByCourse[a.course.code]) attendanceByCourse[a.course.code] = { present: 0, total: 0, courseId: a.courseId, courseCode: a.course.code };
      attendanceByCourse[a.course.code].total += 1;
      if (a.status === 'PRESENT') attendanceByCourse[a.course.code].present += 1;
    }
    const attendanceRows = Object.values(attendanceByCourse);
    // Individual learners have no lecturer-set assignments/attendance/lessons at all
    // (school-institutional concepts) -- only their own app-generated test/assignment
    // results. Each tile links to the dashboard section (or dedicated screen) it
    // summarizes, instead of being a static, unclickable number.
    const statTiles = isIndividual
      ? [
          [(individualAssessments || []).filter((a) => !a.mySubmission || !a.mySubmission.submittedAt).length, 'Assignments & tests pending', '#dash-individualAssessments'],
          [avgScorePct == null ? '—' : avgScorePct + '%', 'Recent test average', '#dash-results'],
          [recentResults.length, 'Tests & assignments taken', '#dash-results'],
        ]
      : [
          [assignments.filter((a) => !a.mySubmission).length, 'Assignments pending', '#dash-assignments'],
          [attendancePct == null ? '—' : attendancePct + '%', 'Attendance rate', '#dash-attendance'],
          [(liveRecordings || []).length, 'Live class recordings', '#dash-recordings'],
          [(lessons || []).length, 'Lectures', '#dash-lessons'],
          [avgScorePct == null ? '—' : avgScorePct + '%', 'Recent test average', '#dash-results'],
        ];

    function assignmentRowHtml(a) {
      return `
          <div class="list-row" style="align-items:flex-start; flex-direction:column; gap:10px;">
            <div style="display:flex; justify-content:space-between; width:100%; flex-wrap:wrap; gap:8px;">
              <div data-open-assignment="${a.id}" style="cursor:pointer;"><div style="font-weight:600;">${esc(a.title)} <span class="meta">(${esc(a.course.code)})</span>${a.kind === 'PROJECT' ? ' <span class="pill pill-muted">Project</span>' : ''}</div>${a.dueAt ? `<div class="meta">Due ${new Date(a.dueAt).toLocaleDateString()}</div>` : ''}</div>
              ${a.mySubmission
                ? a.mySubmission.status === 'MARKED'
                  ? `<span class="pill pill-pass">Marked: ${a.mySubmission.score}</span>`
                  : '<span class="pill pill-accent">Submitted — awaiting mark</span>'
                : ''}
            </div>
            ${a.mySubmission
              ? a.mySubmission.status === 'MARKED' && a.mySubmission.feedback
                ? `<p class="meta">Feedback: ${esc(a.mySubmission.feedback)}</p>`
                : ''
              : `<form class="submit-form" data-assignment="${a.id}" style="display:flex; flex-direction:column; gap:8px; width:100%;">
                  <textarea class="submit-answer" placeholder="Write your answer…" required></textarea>
                  <button class="btn btn-primary btn-sm" type="submit" style="align-self:flex-start;">Submit answer</button>
                </form>`}
          </div>`;
    }
    function attendanceRowHtml(c) {
      return `
          <div class="list-row">
            <div>${esc(c.courseCode)}</div>
            <div style="display:flex; align-items:center; gap:10px;">
              <span class="meta tabular">${c.present}/${c.total} present</span>
              <button class="btn btn-ghost btn-sm" data-view-attendance="${c.courseId}" data-code="${esc(c.courseCode)}">View history</button>
            </div>
          </div>`;
    }
    function resultRowHtml(r) {
      return `
          <div class="list-row clickable" data-open-result="${r.assessmentId}" style="cursor:pointer;">
            <div><div style="font-weight:600;">${esc(r.assessment.title)}</div><div class="meta">${esc(r.assessment.course ? r.assessment.course.code : r.assessment.individualCourse.title)} · ${esc(r.assessment.type)}</div></div>
            <span class="tabular">${r.score}/${r.total}</span>
          </div>`;
    }
    function lessonRowHtml(l) {
      return `
          <div class="list-row" style="align-items:center;">
            <div data-open-lesson="${l.id}" data-course="${l.courseId}" style="cursor:pointer; flex:1;">
              <div style="font-weight:600;">${esc(l.title)}</div><div class="meta">${esc(l.course.code)}${l.author ? ` · ${esc(l.author.fullName)}` : ''} · ${new Date(l.createdAt).toLocaleDateString()}</div>
            </div>
            <div style="display:flex; gap:8px; align-items:center;">
              <span class="pill pill-muted" data-open-lesson="${l.id}" data-course="${l.courseId}" style="cursor:pointer;">▶ Watch</span>
              <a class="pill pill-muted" href="${esc(l.videoUrl)}" download target="_blank" rel="noopener" title="Download">⬇ Download</a>
            </div>
          </div>`;
    }
    // A live class the lecturer recorded and ended -- own banner, own row shape
    // (title/course/host/date, same Watch+Download pills as lectures). No lesson
    // player to open here, so Watch just opens the video file directly.
    function liveRecordingRowHtml(r) {
      return `
          <div class="list-row" style="align-items:center;">
            <div style="flex:1;">
              <div style="font-weight:600;">${esc(r.title)}</div><div class="meta">${esc(r.course.code)} · ${esc(r.host.fullName)} · ${new Date(r.endedAt).toLocaleDateString()}</div>
            </div>
            <div style="display:flex; gap:8px; align-items:center;">
              <a class="pill pill-muted" href="${esc(r.recordingUrl)}" target="_blank" rel="noopener">▶ Watch</a>
              <a class="pill pill-muted" href="${esc(r.recordingUrl)}" download target="_blank" rel="noopener" title="Download">⬇ Download</a>
            </div>
          </div>`;
    }
    function notificationRowHtml(n) {
      return `
          <div class="list-row">
            <div><div style="font-weight:600;">${esc(n.title)}</div><div class="meta">${esc(n.body)}</div></div>
            <span class="meta tabular">${new Date(n.createdAt).toLocaleDateString()}</span>
          </div>`;
    }
    // Individual learners' app-generated assignments/tests/exams (no lecturer here --
    // see individualAutoGen.service.js) -- clicking one opens it the same way a school
    // student opens a test result, whether it's still unanswered or already scored.
    function individualAssessmentRowHtml(a) {
      const done = a.mySubmission && a.mySubmission.submittedAt;
      return `
          <div class="list-row clickable" data-open-result="${a.id}" style="cursor:pointer;">
            <div><div style="font-weight:600;">${esc(a.title)}</div><div class="meta">${esc(a.individualCourse.title)} · ${esc(individualAssessmentTypeLabel(a.type))} · ${a._count.questions} question${a._count.questions === 1 ? '' : 's'}</div></div>
            ${done ? `<span class="pill pill-pass tabular">${a.mySubmission.score}/${a.mySubmission.total}</span>` : '<span class="pill pill-accent">Not started</span>'}
          </div>`;
    }

    // Renders a section capped at DASH_LIMIT items with a "View more" button that,
    // when clicked, swaps in the full list for that one section only.
    const sectionFullRender = {};
    function dashSection(key, items, renderRow, emptyText) {
      sectionFullRender[key] = () => items.map(renderRow).join('') || `<p class="muted" style="padding:16px;">${emptyText}</p>`;
      const shown = items.slice(0, DASH_LIMIT).map(renderRow).join('') || `<p class="muted" style="padding:16px;">${emptyText}</p>`;
      const moreBtn = items.length > DASH_LIMIT
        ? `<button class="btn btn-ghost btn-sm view-more-btn" data-target="dash-${key}-list" style="margin-top:10px;">View more (${items.length - DASH_LIMIT})</button>`
        : '';
      return `<div class="card" id="dash-${key}-list" style="margin-bottom:10px;">${shown}</div>${moreBtn ? `<div style="margin-bottom:26px;">${moreBtn}</div>` : '<div style="margin-bottom:16px;"></div>'}`;
    }

    const SECTION_TITLES = { assignments: 'Assignments', attendance: 'Attendance', lessons: 'Lectures', assessments: 'Assignments & Tests', activity: 'Recent Activity' };
    const sectionHtml = {
      assignments: () => dashSection('assignments', assignments, assignmentRowHtml, 'No assignments posted yet.'),
      attendance: () => dashSection('attendance', attendanceRows, attendanceRowHtml, 'No attendance recorded yet.'),
      lessons: () => dashSection('lessons', lessons || [], lessonRowHtml, 'No lecturer-uploaded lectures yet.'),
      assessments: () => dashSection('individualAssessments', individualAssessments || [], individualAssessmentRowHtml, 'Nothing yet — check back shortly.'),
      activity: () => `<h3 style="margin-bottom:10px; font-size:1rem;">Recent test${isIndividual ? '/assignment' : ''} results</h3>
        ${dashSection('results', recentResults, resultRowHtml, `No ${isIndividual ? 'tests or assignments' : 'test results'} yet.`)}
        <h3 style="margin-bottom:10px; font-size:1rem;">Notifications</h3>
        ${dashSection('notifications', notifications, notificationRowHtml, 'No notifications yet.')}`,
    };
    const pendingCount = isIndividual ? (individualAssessments || []).filter((a) => !a.mySubmission || !a.mySubmission.submittedAt).length : assignments.filter((a) => !a.mySubmission).length;
    const homeTiles = isIndividual ? `${homeTile('individual-courses', '📚', 'My Courses', 'Your own courses')}${homeTile('lab-hub', '🧪', 'Digital Lab', 'Practicals')}${homeTile('tests-hub', '📝', 'Tests', 'Practice anytime')}${homeTile('cbt-mock', '🎯', 'CBT Mock Exam', 'Exam practice')}${homeTile('research', '🤖', 'AI Research Assistant', 'Your study helper')}${homeTile('library', '📖', 'e-Library', 'Textbooks')}` : `${homeTile('courses', '📚', 'My Courses', 'Your classes')}${homeTile('tests-hub', '📝', 'Tests', 'Practice anytime')}${homeTile('cbt-mock', '🎯', 'CBT Mock Exam', 'Exam practice')}${homeTile('research', '🤖', 'AI Research Assistant', 'Your study helper')}${homeTile('lab-hub', '🧪', 'Digital Lab', 'Practicals')}${homeTile('library', '📖', 'e-Library', 'Textbooks')}`;
    const showHome = !(only && sectionHtml[only]);
    const daily = showHome ? dailyRes : null;
    const takenCount = recentResults.length;
    const homeExtra = showHome ? await studentHomeExtras({ isIndividual, assignments, notifications, daily, pendingCount, attendancePct, takenCount, results: recentResults, courses: courseRes && courseRes.courses }) : { banner: '', rest: '' };
    const goalPct = daily && daily.goal ? Math.round((daily.done / daily.goal) * 100) : 0;

    view.innerHTML = !showHome
      ? `<div class="page-head"><h1>${SECTION_TITLES[only]}</h1></div>${sectionHtml[only]()}`
      : `
      <div class="hero-wrap" id="dash-profile-card">
        <div class="card hero pn-hero hero-profile"><div class="hero-top">${greetingBlock()}${selfAvatarHtml('avatar-student-dash')}</div></div>
        <div class="hero-extra">
        ${daily && daily.goal ? `<div class="hero-goal"><div class="hg-top"><span>Today's Goal</span><b>${daily.done} / ${daily.goal} courses</b></div><div class="pn-progress"><div style="width:${goalPct}%"></div></div></div>` : ''}
        <div class="hero-stats">
          <div class="hs" data-jump-nav="student-dashboard"><div class="hs-n" style="color:#FF6B35">🔥 ${daily ? daily.streak : 0}</div><div class="hs-l">Streak</div></div>
          <div class="hs" data-jump-nav="progress"><div class="hs-n" style="color:#00C853">${daily ? daily.points : 0}</div><div class="hs-l">Points</div></div>
          <div class="hs" data-jump-nav="my-activity"><div class="hs-n" style="color:#FFD600">${avgScorePct == null ? '—' : avgScorePct + '%'}</div><div class="hs-l">Avg Score</div></div>
        </div>
        </div>
      </div>
      ${homeExtra.banner}
      <div class="grid-cards tiles">${homeTiles}</div>
      ${homeExtra.rest}`;

    // Item-level interactions live in one wiring pass, scoped to a container, so it can
    // be re-run on just the newly-revealed rows after a "View more" expand instead of
    // needing to rebuild the whole page.
    function wireDashRows(container) {
      container.querySelectorAll('[data-view-attendance]').forEach((btn) => {
        btn.addEventListener('click', () => navigate('attendance-history', { courseId: btn.dataset.viewAttendance, courseCode: btn.dataset.code }));
      });
      container.querySelectorAll('[data-open-result]').forEach((row) => {
        row.addEventListener('click', () => navigate('take-assessment', { assessmentId: row.dataset.openResult, backTo: 'my-dashboard' }));
      });
      container.querySelectorAll('[data-open-assignment]').forEach((el) => {
        el.addEventListener('click', () => navigate('assignment-detail', { assignmentId: el.dataset.openAssignment }));
      });
      container.querySelectorAll('[data-open-lesson]').forEach((el) => {
        el.addEventListener('click', () => navigate('lesson-player', { courseId: el.dataset.course, lessonId: el.dataset.openLesson }));
      });
      container.querySelectorAll('.submit-form').forEach((form) => {
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          try {
            await api(`/assignments/${form.dataset.assignment}/submit`, { method: 'POST', body: { answerText: form.querySelector('.submit-answer').value } });
            toast('Answer submitted');
            render();
          } catch (err) { toast(err.message); }
        });
      });
    }

    const leaderboardBtn = document.getElementById('dash-leaderboard-btn');
    if (leaderboardBtn) leaderboardBtn.addEventListener('click', () => navigate('leaderboard'));
    const profileBtn = document.getElementById('dash-profile-btn');
    if (profileBtn) profileBtn.addEventListener('click', () => navigate('digital-id'));
    const profileCard = document.getElementById('dash-profile-card');
    if (profileCard) { wireSelfAvatarUpload('avatar-student-dash'); }
    view.querySelectorAll('[data-jump-nav]').forEach((el) => el.addEventListener('click', () => navigate(el.dataset.jumpNav)));
    view.querySelectorAll('[data-jump]').forEach((tile) => {
      tile.addEventListener('click', () => {
        const target = view.querySelector(tile.dataset.jump);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
    view.querySelectorAll('.view-more-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const container = document.getElementById(btn.dataset.target);
        const key = btn.dataset.target.replace(/^dash-/, '').replace(/-list$/, '');
        container.innerHTML = sectionFullRender[key]();
        wireDashRows(container);
        btn.remove();
      });
    });
    wireDashRows(view);
  }

  async function renderStudentAttendanceHistory() {
    const { courseId, courseTitle, courseCode } = state.view;
    const { records } = await api(`/courses/${courseId}/attendance/me`);
    view.innerHTML = `
      <div class="page-head">
        <div><h1>My attendance${courseCode ? ` — ${esc(courseCode)}` : ''}${courseTitle ? ` (${esc(courseTitle)})` : ''}</h1></div>
        <button class="btn btn-ghost btn-sm" id="back-btn">← Back to dashboard</button>
      </div>
      <div class="card">
        ${records.map((r) => `
          <div class="list-row">
            <div>${new Date(r.date).toLocaleDateString()}</div>
            <span class="pill ${r.status === 'PRESENT' ? 'pill-pass' : 'pill-danger'}">${esc(r.status)}</span>
          </div>
        `).join('') || '<p class="muted" style="padding:16px;">No attendance recorded yet.</p>'}
      </div>
    `;
    document.getElementById('back-btn').addEventListener('click', () => navigate('my-dashboard'));
  }

  // Full detail for one assignment -- instructions, your submission, and the
  // lecturer's score/feedback underneath, reached by clicking it on My Dashboard
  // instead of only seeing the inline summary there.
  async function renderAssignmentDetail() {
    const { assignment, mySubmission } = await api(`/assignments/${state.view.assignmentId}`);
    view.innerHTML = `
      <div class="page-head">
        <div><span class="pill pill-muted">${esc(assignment.course.code)}</span><h1 style="margin-top:8px;">${esc(assignment.title)}</h1></div>
        <button class="btn btn-ghost btn-sm" id="back-btn">← Back to dashboard</button>
      </div>
      <div class="card" style="padding:24px; margin-bottom:22px;">
        ${assignment.kind === 'PROJECT' ? '<span class="pill pill-muted" style="margin-bottom:10px;">Project</span>' : ''}
        ${assignment.dueAt ? `<div class="meta" style="margin-bottom:10px;">Due ${new Date(assignment.dueAt).toLocaleDateString()}</div>` : ''}
        <div class="meta" style="margin-bottom:6px;">Questions</div>
        <p style="white-space:pre-wrap;">${esc(assignment.instructions)}</p>
      </div>

      <h3 style="margin-bottom:12px; font-size:1rem;">Answers</h3>
      <div class="card" style="padding:24px;">
        ${mySubmission ? `
          <div class="meta" style="margin-bottom:6px;">Submitted ${new Date(mySubmission.submittedAt).toLocaleDateString()}</div>
          <p style="white-space:pre-wrap; margin-bottom:16px;">${esc(mySubmission.answerText)}</p>
          <div class="hr"></div>
          <div style="margin-top:16px;">
            ${mySubmission.status === 'MARKED'
              ? `<span class="pill pill-pass tabular">Score: ${mySubmission.score}</span><p class="meta" style="margin-top:10px;">Review: ${esc(mySubmission.feedback || 'No written feedback provided.')}</p>`
              : '<span class="pill pill-accent">Submitted — awaiting mark</span>'}
          </div>
        ` : `
          <p class="muted" style="margin-bottom:14px;">You have not submitted this yet.</p>
          <form id="assignment-submit-form">
            <div class="field"><textarea id="assignment-answer" placeholder="Write your answer…" required rows="6"></textarea></div>
            <button class="btn btn-primary btn-sm" type="submit">Submit answer</button>
          </form>
        `}
      </div>
    `;
    document.getElementById('back-btn').addEventListener('click', () => navigate('my-dashboard'));
    const form = document.getElementById('assignment-submit-form');
    if (form) form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api(`/assignments/${assignment.id}/submit`, { method: 'POST', body: { answerText: document.getElementById('assignment-answer').value } });
        toast('Answer submitted');
        render();
      } catch (err) { toast(err.message); }
    });
  }

  // Every past-question set across every enrolled course, in one page -- the sidebar's
  // "Past Questions" entry (no more per-course-only access).
  

  // One question at a time (matching PassNow's exam-taking pattern), like
  // renderTakeAssessment -- but practice mode stays batch-graded with unlimited
  // retries: answering pages through questions, then "Check my answers" switches the
  // same paginated view into a read-only correction mode (still one question at a
  // time) instead of dumping every corrected question down the page at once.
  

  // ================= DIGITAL LAB (curated + AI-generated, admin-approved) =================

  function demoCardHtml(d, opts = {}) {
    const steps = d.steps;
    return `<div class="card" style="padding:20px; margin-bottom:14px;" data-demo-card="${d.id}">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px;">
        <div>
          <div style="font-weight:600;">${esc(d.title)}</div>
          <div class="meta">${esc(d.description)}</div>
        </div>
        <span class="pill ${d.source === 'AI_GENERATED' ? 'pill-accent' : 'pill-pass'}">${d.source === 'AI_GENERATED' ? 'AI-generated' : 'Curated'}</span>
      </div>
      ${opts.courseId ? `<button class="btn btn-accent btn-sm" data-teach-lab="${d.id}" data-teach-course="${opts.courseId}" data-teach-individual="${opts.isIndividual ? 'true' : 'false'}" style="margin-top:12px;">▶ Start guided practical</button>` : ''}
      <ol style="margin:14px 0 0; padding-left: 20px; display:flex; flex-direction:column; gap:8px;">
        ${steps.map((s) => `<li><strong>${esc(s.title)}</strong> — ${esc(s.instruction)}<br><span class="meta">Expected: ${esc(s.expectedResult)}</span></li>`).join('')}
      </ol>
      <div class="got-question-toggle" data-gq-toggle="${d.id}" style="margin-top:14px;">
        <div style="font-weight:600;">✋ Got a question about this practical?</div>
        <span data-gq-arrow="${d.id}">▼</span>
      </div>
      <div class="got-question-panel" data-gq-panel="${d.id}" hidden>
        <div data-gq-log="${d.id}" style="display:flex; flex-direction:column; gap:8px; margin-bottom:10px;"></div>
        <div style="display:flex; gap:8px;">
          <input type="text" data-gq-input="${d.id}" placeholder="e.g. Why does this step matter?" style="flex:1; padding:10px 12px; border-radius:10px; border:1px solid var(--line); background:var(--paper); color:var(--ink);">
          <button class="btn btn-primary btn-sm" data-gq-ask="${d.id}">Ask</button>
        </div>
      </div>
    </div>`;
  }

  function wireLabQuestionPanels(container) {
    container.querySelectorAll('[data-gq-toggle]').forEach((toggle) => {
      const id = toggle.dataset.gqToggle;
      toggle.addEventListener('click', () => {
        const panel = container.querySelector(`[data-gq-panel="${id}"]`);
        panel.hidden = !panel.hidden;
        container.querySelector(`[data-gq-arrow="${id}"]`).textContent = panel.hidden ? '▼' : '▲';
      });
    });
    container.querySelectorAll('[data-gq-ask]').forEach((btn) => {
      const id = btn.dataset.gqAsk;
      btn.addEventListener('click', async () => {
        const input = container.querySelector(`[data-gq-input="${id}"]`);
        const question = input.value.trim();
        if (!question) return;
        input.value = '';
        const log = container.querySelector(`[data-gq-log="${id}"]`);
        log.insertAdjacentHTML('beforeend', `<div class="chat-msg" style="max-width:100%; align-self:flex-end; background:var(--accent-soft);">${esc(question)}</div>`);
        try {
          const { answer } = await api(`/lab/${id}/ask`, { method: 'POST', body: { question } });
          log.insertAdjacentHTML('beforeend', `<div class="chat-msg" style="max-width:100%;">${esc(answer)}</div>`);
        } catch (err) {
          if (err.code === 'SUBSCRIPTION_REQUIRED' || err.code === 'AI_CREDITS_EXHAUSTED') return renderUpgradePrompt(err.message);
          toast(aiErrorMessage(err));
        }
      });
    });
  }

  function labStepBoardActions(step) {
    return [
      { type: 'TEXT', content: `${step.title}\n\n${step.instruction}` },
      { type: 'TEXT', content: `Expected result: ${step.expectedResult}` },
    ];
  }

  // The same continuous, avatar-narrated, whiteboard-illustrated teaching method as
  // the live AI Lecturer session -- applied to a Digital Lab practical's steps instead
  // of a generated lesson plan's sections. Reuses every shared piece (connectAvatar,
  // speakThroughAvatarOrTts, pause/resume, startVoiceCapture, the sticky lesson-stage
  // layout) rather than a second parallel implementation. No comprehension checks
  // here -- a hands-on practical walkthrough doesn't have Question-bank checkpoints
  // the way a generated lesson plan does -- and no server-side step pointer either,
  // since all of a practical's steps are already in hand from one fetch.
  async function renderLabTeach() {
    if (simliAvatarClient) { try { simliAvatarClient.close(); } catch { /* already closed */ } simliAvatarClient = null; }
    if (speechCtrl) {
      if (speechCtrl.timer) clearInterval(speechCtrl.timer);
      if (speechCtrl.doneTimeout) clearTimeout(speechCtrl.doneTimeout);
    }
    speechCtrl = null;
    const { courseId, demoId, isIndividual } = state.view;
    const [{ demonstrations }, { avatarConfigured, aiCredits }] = await Promise.all([
      api(isIndividual ? `/individual-courses/${courseId}/lab` : `/courses/${courseId}/lab`),
      api('/config').catch(() => ({ avatarConfigured: false, aiCredits: null })),
    ]);
    const demo = demonstrations.find((d) => d.id === demoId);
    if (!demo) { view.innerHTML = '<p>Practical not found.</p>'; return; }
    let stepIdx = 0;
    let stopped = false;
    // "Got a question" only becomes usable once the teacher has actually started
    // speaking -- structured the same way as AI Lecturer's session.
    let teachingStarted = false;

    view.innerHTML = `
      <div class="page-head">
        <div><span class="pill pill-accent">Digital Lab — guided practical</span>${aiCredits && aiCredits.tracked ? ` <span class="pill ${aiCredits.exhausted ? 'pill-danger' : 'pill-muted'}">${Math.floor(aiCredits.secondsRemaining / 60)} min left this cycle</span>` : ''}<h1 style="margin-top:8px;">${esc(demo.title)}</h1></div>
        <button class="btn btn-ghost btn-sm" id="back-btn">← End practical</button>
      </div>
      <div class="card lesson-player">
        <div class="lesson-stage" id="lesson-stage">
          <button class="lesson-stage-expand-btn" id="lesson-expand-btn" title="Expand">⛶</button>
          <div class="ai-avatar-box">
            <div class="ai-avatar-ring" id="ai-avatar-ring">${esc(initials(demo.title || 'AI'))}</div>
            <video id="avatar-video" class="ai-avatar-video" autoplay playsinline hidden></video>
            <audio id="avatar-audio" autoplay hidden></audio>
            <div class="ai-avatar-label" id="ai-avatar-label">${avatarConfigured ? 'Connecting video avatar…' : 'AI Lecturer'}</div>
          </div>
          <div class="smart-board-wrap">
            <div class="smart-board-head"><div class="dot">🧪</div><div class="label" id="board-status">AI Lecturer — writing on the board</div></div>
            <div class="smart-board" id="smart-board"></div>
            <div class="smart-board-tray"><span class="marker red"></span><span class="marker blue"></span><span class="marker black"></span><span class="tag">LEARNZA SMART BOARD</span></div>
          </div>
        </div>
        <div class="meta" style="margin-top:12px;" id="step-meta"></div>
        <h3 style="margin:8px 0 12px;" id="step-title"></h3>

        <div class="controls">
          <button class="btn btn-ghost" id="ask-voice-btn" disabled>🎤 Ask a question</button>
        </div>

        <div class="got-question-toggle" id="got-question-toggle" style="opacity:0.5; cursor:default;">
          <div><div style="font-weight:600;">✋ Got a question? Raise your hand</div><div class="gq-sub" id="gq-sub">Wait for the AI Lecturer to start…</div></div>
          <span id="gq-arrow">▼</span>
        </div>
        <div class="got-question-panel" id="got-question-panel" hidden>
          <div id="interrupt-log" style="display:flex; flex-direction:column; gap:8px; margin-bottom:10px;"></div>
          <div style="display:flex; gap:8px;">
            <input type="text" id="interrupt-input" placeholder="e.g. Why does this step matter?" style="flex:1; padding:10px 12px; border-radius:10px; border:1px solid var(--line); background:var(--paper); color:var(--ink);">
            <button class="btn btn-primary btn-sm" id="interrupt-btn">Ask</button>
          </div>
        </div>
      </div>
    `;

    const avatarRing = document.getElementById('ai-avatar-ring');
    const avatarLabel = document.getElementById('ai-avatar-label');
    const boardStatus = document.getElementById('board-status');
    const board = document.getElementById('smart-board');
    const stepMeta = document.getElementById('step-meta');
    const stepTitleEl = document.getElementById('step-title');
    const askVoiceBtn = document.getElementById('ask-voice-btn');

    document.getElementById('lesson-expand-btn').addEventListener('click', () => {
      const stage = document.getElementById('lesson-stage');
      if (!document.fullscreenElement) {
        (stage.requestFullscreen || stage.webkitRequestFullscreen)?.call(stage).catch(() => toast('Fullscreen is not available on this device.'));
      } else {
        document.exitFullscreen?.();
      }
    });

    document.getElementById('back-btn').addEventListener('click', () => {
      stopped = true;
      // renderLab (single course view) only understands school Courses -- individual
      // learners always came from the cross-course Lab Hub, so send them back there.
      if (isIndividual) navigate('lab-hub');
      else navigate('lab', { courseId });
    });

    function renderStep(idx) {
      const step = demo.steps[idx];
      stepMeta.textContent = `Step ${idx + 1} of ${demo.steps.length}`;
      stepTitleEl.textContent = step.title;
      const actions = labStepBoardActions(step);
      setBoardContent(board, actions);
      boardStatus.textContent = 'AI Lecturer — writing on the board';
      return step;
    }

    document.getElementById('got-question-toggle').addEventListener('click', () => {
      if (!teachingStarted) return;
      const panel = document.getElementById('got-question-panel');
      panel.hidden = !panel.hidden;
      document.getElementById('gq-arrow').textContent = panel.hidden ? '▼' : '▲';
    });

    // Flips on once the teacher starts speaking the first step -- structured the same
    // way as AI Lecturer, so "got a question" only opens once teaching has actually begun.
    function markTeachingStarted() {
      if (teachingStarted) return;
      teachingStarted = true;
      askVoiceBtn.disabled = false;
      const toggle = document.getElementById('got-question-toggle');
      toggle.style.opacity = '';
      toggle.style.cursor = '';
      document.getElementById('gq-sub').textContent = 'Learnza answers visually without leaving the practical';
      // Logs "this student did this practical" for admin's Digital Lab view -- fired
      // once per session start, not awaited (never worth blocking/interrupting the
      // lesson over), and only individual-course practicals never reach an admin view
      // anyway so this is harmless there too.
      if (state.user.role === 'STUDENT') api(`/lab/${demo.id}/attempt`, { method: 'POST' }).catch(() => {});
    }

    async function askLabQuestion(question, pausedSnapshot) {
      const panel = document.getElementById('got-question-panel');
      panel.hidden = false;
      document.getElementById('gq-arrow').textContent = '▲';
      boardStatus.textContent = 'AI Lecturer — thinking…';
      try {
        const { answer, boardActions } = await api(`/lab/${demo.id}/ask`, { method: 'POST', body: { question } });
        const log = document.getElementById('interrupt-log');
        log.insertAdjacentHTML('beforeend', `
          <div class="chat-msg" style="max-width:100%; align-self:flex-end; background:var(--accent-soft);">${esc(question)}</div>
          <div class="chat-msg" style="max-width:100%;">${esc(answer)}</div>
        `);
        log.scrollTop = log.scrollHeight;
        // Every answer lands on the board itself, not just the chat log underneath it.
        const answerBoardActions = boardActions && boardActions.length ? boardActions : [{ type: 'TEXT', content: answer }];
        setBoardContent(board, answerBoardActions);
        boardStatus.textContent = 'AI Lecturer — answering your question';
        speakThroughAvatarOrTts(answer, avatarRing, () => {
          if (pausedSnapshot) resumePausedSpeech(pausedSnapshot);
        });
      } catch (err) {
        if (pausedSnapshot) resumePausedSpeech(pausedSnapshot);
        if (err.code === 'SUBSCRIPTION_REQUIRED' || err.code === 'AI_CREDITS_EXHAUSTED') return renderUpgradePrompt(err.message);
        toast(aiErrorMessage(err));
      }
    }

    document.getElementById('interrupt-btn').addEventListener('click', () => {
      if (!teachingStarted) return;
      const input = document.getElementById('interrupt-input');
      const question = input.value.trim();
      if (!question) return;
      input.value = '';
      askLabQuestion(question, pauseSpeechForQuestion());
    });

    askVoiceBtn.addEventListener('click', () => {
      if (voiceRecognizer) { try { voiceRecognizer.abort(); } catch { /* already stopping */ } return; }
      const pausedSnapshot = pauseSpeechForQuestion();
      voiceRecognizer = startVoiceCapture({
        button: askVoiceBtn,
        ringEl: avatarRing,
        labelEl: avatarLabel,
        onTranscript: (question) => { voiceRecognizer = null; askLabQuestion(question, pausedSnapshot); },
        onCancelled: () => { voiceRecognizer = null; if (pausedSnapshot) resumePausedSpeech(pausedSnapshot); },
      });
    });

    async function runPractical() {
      if (avatarConfigured) {
        connectAvatar(document.getElementById('avatar-video'), document.getElementById('avatar-audio'), avatarRing, avatarLabel)
          .then((client) => { if (!stopped && client) simliAvatarClient = client; else if (!stopped) avatarLabel.textContent = 'AI Lecturer'; });
      }
      while (!stopped) {
        const step = renderStep(stepIdx);
        markTeachingStarted();
        await speakAsync(`${step.title}. ${step.instruction}`, avatarRing);
        if (stopped) return;
        if (stepIdx >= demo.steps.length - 1) {
          boardStatus.textContent = 'Practical complete';
          toast('Practical complete — nice work!');
          askVoiceBtn.disabled = true;
          return;
        }
        stepIdx++;
      }
    }

    runPractical();
  }

  async function renderLab() {
    const { courseId } = state.view;
    const { course } = await api(`/courses/${courseId}`);
    const { demonstrations } = await api(`/courses/${courseId}/lab`);
    const isLecturer = state.user.role !== 'STUDENT';

    view.innerHTML = `
      <div class="page-head">
        <div><div class="muted tabular">${esc(course.code)}</div><h1>Digital Lab</h1></div>
        <button class="btn btn-ghost btn-sm" id="back-btn">← Back</button>
      </div>
      ${isLecturer ? `
        <div class="card" style="padding:20px; margin-bottom:22px;">
          <h3 style="margin-bottom:12px; font-size:1rem;">Add a curated practical</h3>
          <form id="demo-form">
            <div class="field"><label>Title</label><input type="text" id="demo-title" required></div>
            <div class="field"><label>Description</label><input type="text" id="demo-desc"></div>
            <div class="field">
              <label>Steps — one per line, as "Step title | Instruction | Expected result"</label>
              <textarea id="demo-steps" placeholder="Prepare the slide | Place a thin sample on the glass slide | The sample is flat and centered" required></textarea>
            </div>
            <button class="btn btn-primary" type="submit">Publish practical</button>
          </form>
        </div>
      ` : `
        <div class="card" style="padding:20px; margin-bottom:22px;">
          <div style="font-weight:600;">Don't see the practical you need?</div>
          <div class="meta" style="margin-bottom:12px;">Type a topic and the AI Lecturer drafts it instantly — no admin review, included with your subscription.</div>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            <input type="text" id="gen-demo-topic" placeholder="e.g. Titration of acid and base" style="flex:1; min-width:220px; padding:10px 12px; border-radius:10px; border:1px solid var(--line); background:var(--paper); color:var(--ink);">
            <button class="btn btn-accent" id="request-demo-btn">Generate practical</button>
          </div>
        </div>
      `}
      ${demonstrations.map((d) => demoCardHtml(d, { courseId: isLecturer ? null : courseId })).join('') || '<p class="muted">No practicals published yet.</p>'}
    `;
    document.getElementById('back-btn').addEventListener('click', () => navigate(isLecturer ? 'lect-lessons' : 'course-detail', { courseId }));
    wireLabQuestionPanels(view);
    view.querySelectorAll('[data-teach-lab]').forEach((btn) => {
      btn.addEventListener('click', () => navigate('lab-teach', { courseId: btn.dataset.teachCourse, demoId: btn.dataset.teachLab }));
    });

    const demoForm = document.getElementById('demo-form');
    if (demoForm) demoForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const steps = document.getElementById('demo-steps').value
        .split('\n').map((l) => l.trim()).filter(Boolean)
        .map((line) => {
          const [title, instruction, expectedResult] = line.split('|').map((s) => (s || '').trim());
          return { title: title || 'Step', instruction: instruction || '', expectedResult: expectedResult || '' };
        });
      try {
        await api(`/courses/${courseId}/lab`, {
          method: 'POST',
          body: { title: document.getElementById('demo-title').value, description: document.getElementById('demo-desc').value, steps },
        });
        toast('Practical published');
        render();
      } catch (err) { toast(err.message); }
    });

    const requestBtn = document.getElementById('request-demo-btn');
    if (requestBtn) requestBtn.addEventListener('click', async () => {
      const topicInput = document.getElementById('gen-demo-topic');
      const topic = topicInput.value.trim();
      if (!topic) return toast('Type a topic first.');
      requestBtn.disabled = true;
      requestBtn.textContent = 'Generating…';
      try {
        await api(`/courses/${courseId}/lab/generate`, { method: 'POST', body: { topic } });
        toast('Practical ready');
        render();
      } catch (err) {
        if (err.code === 'SUBSCRIPTION_REQUIRED' || err.code === 'AI_CREDITS_EXHAUSTED') return renderUpgradePrompt(err.message);
        toast(aiErrorMessage(err));
        requestBtn.disabled = false;
        requestBtn.textContent = 'Generate practical';
      }
    });
  }

  // Every practical across every enrolled course, in one page -- the sidebar's
  // "Digital Lab" entry, matching the Past Questions / CBT hub pattern instead of
  // Digital Lab only being reachable from inside a specific course.
  async function renderLabHub() {
    const { courses } = await api('/students/me/courses');
    const { courses: individualCourses } = await api('/individual-courses');
    const rows = await Promise.all([
      ...courses.map(async (c) => ({ course: c, isIndividual: false, demonstrations: (await api(`/courses/${c.id}/lab`)).demonstrations })),
      ...individualCourses.map(async (c) => ({ course: c, isIndividual: true, demonstrations: (await api(`/individual-courses/${c.id}/lab`)).demonstrations })),
    ]);
    view.innerHTML = `
      <div class="page-head"><h1>Digital Lab</h1></div>
      <p class="muted" style="margin-bottom:20px;">Guided practicals with a talking AI Lecturer and a smart board — pick a course to see what's available.</p>
      ${rows.map(({ course, isIndividual, demonstrations }) => `
        <div style="margin-bottom:22px;">
          <div class="muted" style="font-weight:700; margin-bottom:8px;">${course.code ? `${esc(course.code)} — ` : ''}${esc(course.title)}</div>
          ${isIndividual ? `
            <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px;">
              <input type="text" class="gen-demo-topic" data-gen-course="${course.id}" placeholder="e.g. Titration of acid and base" style="flex:1; min-width:220px; padding:10px 12px; border-radius:10px; border:1px solid var(--line); background:var(--paper); color:var(--ink);">
              <button class="btn btn-accent btn-sm request-demo-btn" data-gen-course="${course.id}">Generate practical</button>
            </div>
          ` : ''}
          ${demonstrations.map((d) => demoCardHtml(d, { courseId: course.id, isIndividual })).join('') || '<p class="muted" style="padding:8px 0;">No practicals published yet.</p>'}
        </div>
      `).join('') || '<p class="muted">Enroll in (or create) a course first to see its practicals.</p>'}
    `;
    wireLabQuestionPanels(view);
    view.querySelectorAll('[data-teach-lab]').forEach((btn) => {
      btn.addEventListener('click', () => navigate('lab-teach', { courseId: btn.dataset.teachCourse, demoId: btn.dataset.teachLab, isIndividual: btn.dataset.teachIndividual === 'true' }));
    });
    view.querySelectorAll('.request-demo-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const courseId = btn.dataset.genCourse;
        const input = view.querySelector(`.gen-demo-topic[data-gen-course="${courseId}"]`);
        const topic = input.value.trim();
        if (!topic) return toast('Type a topic first.');
        btn.disabled = true;
        btn.textContent = 'Generating…';
        try {
          await api(`/individual-courses/${courseId}/lab/generate`, { method: 'POST', body: { topic } });
          toast('Practical ready');
          render();
        } catch (err) {
          if (err.code === 'SUBSCRIPTION_REQUIRED' || err.code === 'AI_CREDITS_EXHAUSTED') return renderUpgradePrompt(err.message);
          toast(aiErrorMessage(err));
          btn.disabled = false;
          btn.textContent = 'Generate practical';
        }
      });
    });
  }

  // Read-only records of lab activity -- students get lab access straight from their
  // subscription now, so there's nothing here for admin to approve/reject any more.
  async function renderResearchAssistant() {
    view.innerHTML = `
      <div class="page-head"><h1>AI Research Assistant</h1></div>
      <p class="muted" style="margin-bottom:18px;">Ask it to explain a concept, help structure a project or lecture, or suggest what to search for. It can't browse the web, so it won't invent fake citations — always verify sources with your ${state.user.role === 'STUDENT' ? 'lecturer or library' : 'own research'}.</p>
      <div class="card" style="padding:20px;">
        <div class="field">
          <label>Your topic or question</label>
          <textarea id="research-input" placeholder="e.g. How should I structure a project comparing two teaching methods for primary science?"></textarea>
        </div>
        <button class="btn btn-primary" id="research-ask-btn">Ask</button>
        <div id="research-answer-wrap" hidden style="margin-top:18px;">
          <div style="display:flex; justify-content:flex-end; margin-bottom:6px;">
            <button class="btn btn-ghost btn-sm" id="research-copy-btn" title="Copy answer">📋 Copy</button>
          </div>
          <div id="research-answer" style="white-space:pre-wrap; line-height:1.7;"></div>
        </div>
      </div>
    `;
    let lastAnswer = '';
    document.getElementById('research-copy-btn').addEventListener('click', () => { if (lastAnswer) copyToClipboard(lastAnswer); });
    document.getElementById('research-ask-btn').addEventListener('click', async () => {
      const question = document.getElementById('research-input').value.trim();
      if (!question) return;
      const wrap = document.getElementById('research-answer-wrap');
      const answerBox = document.getElementById('research-answer');
      wrap.hidden = false;
      answerBox.textContent = 'Thinking…';
      try {
        const { answer } = await api('/research-assistant/ask', { method: 'POST', body: { question } });
        answerBox.textContent = answer;
        lastAnswer = answer;
      } catch (err) {
        if (err.code === 'SUBSCRIPTION_REQUIRED' || err.code === 'AI_CREDITS_EXHAUSTED') return renderUpgradePrompt(err.message);
        answerBox.innerHTML = `<span style="color:var(--danger);">${esc(aiErrorMessage(err))}</span>`;
        lastAnswer = '';
      }
    });
  }

  // ================= BILLING =================

  async function renderBilling() {
    const { active, subscription, enforced } = await api('/billing/status');
    const noProvider = false; // bank transfer is always available; the Flutterwave popup is offered on top when configured

    view.innerHTML = `
      <div class="page-head"><h1>Subscription</h1></div>
      ${!enforced ? `<div class="hint-box" style="margin-bottom:18px;">Testing phase: every feature is free for everyone right now, subscribed or not. Pricing below is what it'll cost once testing wraps up.</div>` : ''}
      ${active ? `
        <div class="card" style="padding:20px; margin-bottom:20px;">
          <span class="pill pill-pass">Active</span>
          <p style="margin-top:10px;">Your ${esc(subscription.plan === 'YEARLY' ? 'yearly' : 'monthly')} plan is active until <strong>${new Date(subscription.expiresAt).toLocaleDateString()}</strong>.</p>
          <div style="margin-top:14px;">
            <div class="meta" style="margin-bottom:4px;">Live AI Lecturer minutes this cycle</div>
            <div class="tabular" style="font-weight:600;">${Math.max(0, Math.floor((subscription.aiSecondsGranted - subscription.aiSecondsUsed) / 60))} / ${Math.floor(subscription.aiSecondsGranted / 60)} min left</div>
            ${subscription.aiSecondsUsed >= subscription.aiSecondsGranted ? '<p class="muted" style="margin-top:6px;">You have used up this cycle\'s AI credit — subscribe again to top up.</p>' : ''}
          </div>
        </div>
      ` : `
        <div class="card" style="padding:20px; margin-bottom:20px;">
          <span class="pill pill-muted">No active plan</span>
          <p class="muted" style="margin-top:10px;">Subscribe to unlock AI Lecturer lectures, recorded lectures and live classes — each plan includes a bank of live AI Lecturer minutes (300/month, or 3,600 for the year) that refills every time you subscribe. e-Library, study groups and CBT practice stay free either way.</p>
        </div>
      `}
      ${noProvider ? `<div class="hint-box" style="background:var(--danger-soft); color:var(--danger);">Payments aren't configured on this server yet — checkout will be available once a payment provider is connected.</div>` : ''}
      <div class="pricing" style="display:grid; grid-template-columns:1fr 1fr; gap:16px; max-width:640px;">
        <div class="card" style="padding:22px;">
          <div class="pill pill-accent">Monthly</div>
          <div style="font-family:var(--font-display); font-size:1.8rem; margin:10px 0;" class="tabular">₦10,000</div>
          <button class="btn btn-primary" data-plan="MONTHLY" ${noProvider ? 'disabled' : ''}>Subscribe monthly</button>
        </div>
        <div class="card" style="padding:22px;">
          <div class="pill pill-accent">Yearly</div>
          <div style="font-family:var(--font-display); font-size:1.8rem; margin:10px 0;" class="tabular">₦105,000</div>
          <button class="btn btn-primary" data-plan="YEARLY" ${noProvider ? 'disabled' : ''}>Subscribe yearly</button>
        </div>
      </div>
    `;

    const PLAN_INFO = { MONTHLY: { title: 'Monthly plan', amountNaira: 10000 }, YEARLY: { title: 'Yearly plan', amountNaira: 105000 } };
    view.querySelectorAll('[data-plan]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const info = PLAN_INFO[btn.dataset.plan];
        LZX.pay({ api, esc, toast }, { kind: 'plan', plan: btn.dataset.plan, title: info.title, amountNaira: info.amountNaira, onDone: () => render() });
      });
    });
  }

  async function checkPendingPayment() {
    const reference = localStorage.getItem('vp_pending_payment_ref');
    if (!reference || !location.hash.includes('billing-callback')) return;
    localStorage.removeItem('vp_pending_payment_ref');
    try {
      const r = await api(`/billing/verify/${reference}`);
      if (r.kind === 'coins') {
        toast(r.status === 'SUCCESS' ? 'Payment confirmed — coins added!' : 'Payment received — your coins will appear shortly.');
        return 'coins';
      }
      toast('Payment confirmed — subscription activated!');
    } catch {
      // Webhook may still be catching up; the billing page will reflect status shortly either way.
    }
    return 'billing';
  }

  function libraryTypeIcon(type) {
    if (type === 'Past Question') return '📝';
    if (type === 'Journal') return '📰';
    if (type === 'Handout') return '📄';
    return '📗'; // Textbook, and the default for anything else
  }

  function libraryItemCardHtml(it) {
    return `
      <div class="list-row">
        <div style="display:flex; align-items:center; gap:12px;">
          <div class="lib-cover">${libraryTypeIcon(it.type)}</div>
          <div>
            <div style="font-weight:600;">${esc(it.title)}</div>
            <div class="meta">by ${esc(it.author)}${it.publisher ? ` · ${esc(it.publisher)}` : ''}</div>
          </div>
        </div>
        <div style="display:flex; align-items:center; gap:10px;">
          <span class="pill pill-muted">${esc(it.type)}</span>
          <button class="btn btn-ghost btn-sm" data-open-pdf="${esc(it.fileUrl)}" data-pdf-title="${esc(it.title)}">Open</button>
        </div>
      </div>
    `;
  }

  // Read-only in-app PDF viewer -- students read on the same page, never a new tab or
  // an external domain. Browsers render PDFs natively inside an <iframe>.
  async function renderPdfViewer() {
    const { url, title, backTo } = state.view;
    view.innerHTML = `
      <div class="page-head"><h1>${esc(title || 'Document')}</h1><button class="btn btn-ghost btn-sm" id="back-btn">← Back</button></div>
      <div class="card" style="padding:0; overflow:hidden; height:80vh;">
        <iframe src="${esc(url)}" title="${esc(title || 'Document')}" style="width:100%; height:100%; border:0;"></iframe>
      </div>
    `;
    document.getElementById('back-btn').addEventListener('click', () => navigate(backTo || 'library'));
  }

  // A shared campus catalog -- browsable by department and course like the "Browse &
  // enroll" screen, not limited to the courses the viewer happens to be enrolled in
  // or teaching. Textbooks (with real authors/publishers) are the primary resource
  // type; past questions, journals and handouts are still supported as secondary types.
  // Individual (non-school) learners have no department/course hierarchy to browse by
  // -- they see a flat list of resources Learnza itself stocks directly (uploaded with
  // no course attached), per "we will upload textbooks ourselves, not through school".
  // ---- e-Library, laid out the way PassNow's is: a card to add a file (lecturers), search and filters, one list of
  // files with Open / Download (and Delete on your own), and a viewer that opens PDFs and pictures in place ----
  const LIB_TYPES = ['Textbook', 'Handout', 'Notes', 'Journal'];
  const libIcon = (u) => { const e = String(u || '').split('?')[0].split('.').pop().toLowerCase(); return e === 'pdf' ? '📕' : /png|jpe?g|webp|gif/.test(e) ? '🖼️' : /docx?/.test(e) ? '📘' : /pptx?/.test(e) ? '📙' : /xlsx?/.test(e) ? '📗' : '📄'; };
  const libInline = (u) => /\.(pdf|png|jpe?g|webp|gif)(\?|#|$)/i.test(String(u || ''));
  async function renderIndividualLibrary() { return renderLibrary(false); }
  async function renderLibrary(isLecturer) {
    const lecturer = false; // only the backend admin adds e-books; lecturers and students read them
    const { items } = await api('/library');
    const filter = { q: '', type: '', course: '' };
    const courseLabel = (it) => (it.course ? `${it.course.code} — ${it.course.title}` : '');
    const old = document.getElementById('lib-viewer'); if (old) old.remove();
    const viewer = document.createElement('div');
    viewer.id = 'lib-viewer';
    viewer.innerHTML = '<div class="lib-bar"><button class="lib-btn" id="lib-close">← Close</button><b id="lib-vt"></b><a class="lib-btn g" id="lib-vd" download target="_blank" rel="noopener">⬇ Download</a></div><div id="lib-vbody"></div>';
    document.body.appendChild(viewer);
    const closeViewer = () => { viewer.classList.remove('on'); viewer.querySelector('#lib-vbody').innerHTML = ''; };
    viewer.querySelector('#lib-close').addEventListener('click', closeViewer);

    view.innerHTML = `
      <div class="page-head"><h1>📖 e-Library</h1></div>
      <div class="card" style="padding:14px; margin-bottom:12px;">
        <input class="lib-q" id="lib-q" placeholder="Search by title, author or course…">
        <div class="lib-two" style="margin-top:10px;">
          <select id="lib-ftype"><option value="">All types</option>${LIB_TYPES.map((t) => `<option>${t}</option>`).join('')}</select>
          <select id="lib-fcourse"><option value="">All courses</option></select>
        </div>
      </div>
      <div id="lib-list"></div>`;

    const fcourse = view.querySelector('#lib-fcourse');
    const courseNames = [...new Set(items.map(courseLabel).filter(Boolean))].sort();
    fcourse.innerHTML = '<option value="">All courses</option>' + courseNames.map((n) => `<option>${esc(n)}</option>`).join('');
    const paint = () => {
      const shown = items.filter((it) => (!filter.type || it.type === filter.type) && (!filter.course || courseLabel(it) === filter.course)
        && (!filter.q || `${it.title} ${it.author || ''} ${courseLabel(it)}`.toLowerCase().includes(filter.q)));
      const list = view.querySelector('#lib-list');
      if (!shown.length) { list.innerHTML = `<div class="lib-empty">${items.length ? 'Nothing matches that search.' : 'No files yet. Lecturers add textbooks, handouts and past questions here, and they show up as soon as they are added.'}</div>`; return; }
      list.innerHTML = shown.map((it) => {
        const mine = lecturer && it.schoolId && it.uploaderId === state.user.id;
        const meta = [it.type, courseLabel(it) || 'Every course', it.schoolId ? null : 'Learnza library'].filter(Boolean).map(esc).join(' · ');
        return `<div class="lib-row"><div class="lib-ic">${libIcon(it.fileUrl)}</div><div class="lib-mid"><div class="lib-t">${esc(it.title)}</div><div class="lib-m">${meta}</div><div class="lib-m">${it.author ? 'by ' + esc(it.author) + ' · ' : ''}${it.uploader ? 'added by ' + esc(it.uploader.fullName) + ' · ' : ''}${new Date(it.createdAt).toLocaleDateString()}</div></div>
          <div class="lib-side"><button class="lib-btn g" data-lib-open="${it.id}">${libInline(it.fileUrl) ? 'Open' : 'Download'}</button>${mine ? `<button class="lib-btn r" data-lib-del="${it.id}">Delete</button>` : ''}</div></div>`;
      }).join('');
      list.querySelectorAll('[data-lib-open]').forEach((b) => b.addEventListener('click', () => {
        const it = items.find((x) => x.id === b.dataset.libOpen);
        if (!libInline(it.fileUrl)) { window.open(it.fileUrl, '_blank', 'noopener'); return; }
        viewer.querySelector('#lib-vt').textContent = it.title;
        viewer.querySelector('#lib-vd').href = it.fileUrl;
        viewer.querySelector('#lib-vbody').innerHTML = /\.pdf(\?|#|$)/i.test(it.fileUrl) ? `<iframe title="${esc(it.title)}" src="${esc(it.fileUrl)}"></iframe>` : `<img alt="${esc(it.title)}" src="${esc(it.fileUrl)}">`;
        viewer.classList.add('on');
      }));
      list.querySelectorAll('[data-lib-del]').forEach((b) => b.addEventListener('click', async () => {
        const it = items.find((x) => x.id === b.dataset.libDel);
        if (!confirm(`Delete “${it.title}” from the e-Library?`)) return;
        try { await api('/library/' + it.id, { method: 'DELETE' }); items.splice(items.indexOf(it), 1); paint(); toast('Deleted'); } catch (err) { toast(err.message); }
      }));
    };
    view.querySelector('#lib-q').addEventListener('input', (e) => { filter.q = e.target.value.trim().toLowerCase(); paint(); });
    view.querySelector('#lib-ftype').addEventListener('change', (e) => { filter.type = e.target.value; paint(); });
    fcourse.addEventListener('change', (e) => { filter.course = e.target.value; paint(); });
    paint();

  }

  async function renderGroups() {
    const { courses } = await api('/students/me/courses');
    const { courses: individualCourses } = await api('/individual-courses');
    const groupsByCourse = await Promise.all([
      ...courses.map(async (c) => ({ course: c, isIndividual: false, groups: (await api(`/courses/${c.id}/groups`)).groups })),
      ...individualCourses.map(async (c) => ({ course: c, isIndividual: true, groups: (await api(`/individual-courses/${c.id}/groups`)).groups })),
    ]);
    const allGroupCourses = [
      ...courses.map((c) => ({ course: c, isIndividual: false })),
      ...individualCourses.map((c) => ({ course: c, isIndividual: true })),
    ];
    view.innerHTML = `
      <div class="page-head">
        <h1>Study Groups</h1>
        ${allGroupCourses.length ? '<button class="btn btn-accent btn-sm" id="new-group-top-btn">+ Create new group</button>' : ''}
      </div>
      <p class="muted" style="margin-bottom:20px;">Peer discussion spaces for your courses — no scores, no leaderboard.</p>
      ${groupsByCourse.map(({ course, isIndividual, groups }) => `
        <div style="margin-bottom:22px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
            <div class="muted" style="font-weight:700;">${course.code ? `${esc(course.code)} — ` : ''}${esc(course.title)}</div>
            <button class="btn btn-ghost btn-sm" data-new-group="${course.id}" data-new-group-individual="${isIndividual ? 'true' : 'false'}">+ New group</button>
          </div>
          <div class="card">
            ${groups.map((g) => `
              <div class="list-row">
                <div>
                  <div style="font-weight:600;">${esc(g.name)}</div>
                  <div class="meta">${g._count.members} member${g._count.members === 1 ? '' : 's'}</div>
                </div>
                <button class="btn btn-primary btn-sm" data-open-group="${g.id}">Open</button>
              </div>
            `).join('') || '<p class="muted" style="padding:16px;">No groups yet — start one.</p>'}
          </div>
        </div>
      `).join('') || '<p class="muted">Enroll in (or create) a course first to join its study group.</p>'}
    `;
    async function createGroup(courseId, isIndividualCourse) {
      const name = prompt('Name your study group:');
      if (!name) return;
      const base = isIndividualCourse ? '/individual-courses' : '/courses';
      await api(`${base}/${courseId}/groups`, { method: 'POST', body: { name } });
      render();
    }
    view.querySelectorAll('[data-new-group]').forEach((btn) => {
      btn.addEventListener('click', () => createGroup(btn.dataset.newGroup, btn.dataset.newGroupIndividual === 'true'));
    });
    view.querySelectorAll('[data-open-group]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await api(`/groups/${btn.dataset.openGroup}/join`, { method: 'POST' });
        navigate('group-chat', { groupId: btn.dataset.openGroup });
      });
    });
    const topBtn = document.getElementById('new-group-top-btn');
    if (topBtn) topBtn.addEventListener('click', () => {
      if (allGroupCourses.length === 1) {
        return createGroup(allGroupCourses[0].course.id, allGroupCourses[0].isIndividual);
      }
      const container = document.createElement('div');
      container.className = 'card';
      container.style.cssText = 'position:fixed; inset:0; margin:auto; width:min(420px,92vw); height:fit-content; padding:24px; z-index:200;';
      container.innerHTML = `
        <h3 style="margin-bottom:14px;">Create a group for which course?</h3>
        <div class="field"><select id="ng-course">${allGroupCourses.map(({ course, isIndividual: ic }, i) => `<option value="${i}">${course.code ? `${esc(course.code)} — ` : ''}${esc(course.title)}</option>`).join('')}</select></div>
        <div style="display:flex; gap:10px; margin-top:10px;">
          <button class="btn btn-primary" id="ng-go">Continue</button>
          <button class="btn btn-ghost" id="ng-cancel">Cancel</button>
        </div>
      `;
      const backdrop = document.createElement('div');
      backdrop.style.cssText = 'position:fixed; inset:0; background:rgba(20,32,51,0.45); z-index:190;';
      document.body.appendChild(backdrop);
      document.body.appendChild(container);
      container.querySelector('#ng-cancel').addEventListener('click', () => { backdrop.remove(); container.remove(); });
      container.querySelector('#ng-go').addEventListener('click', () => {
        const picked = allGroupCourses[Number(container.querySelector('#ng-course').value)];
        backdrop.remove();
        container.remove();
        createGroup(picked.course.id, picked.isIndividual);
      });
    });
  }

  function groupMessageBubbleHtml(m) {
    const isMine = m.senderId === state.user.id;
    const sender = `<div class="sender">${esc(m.sender.fullName)}</div>`;
    if (m.deletedForEveryone) {
      return `<div class="chat-msg">${sender}<span class="muted" style="font-style:italic;">🚫 This message was deleted</span></div>`;
    }
    // Every message gets a delete control with two choices -- "for me" (hide from
    // just this member's own view) available to anyone, and "for everyone" (clears
    // the content for the whole group) restricted to the sender, re-checked
    // server-side regardless of what this menu shows.
    const deleteMenu = `
      <span style="position:relative; display:inline-block; margin-top:4px;">
        <button class="btn btn-ghost btn-sm" data-toggle-delete-menu="${m.id}" style="padding:2px 8px; font-size:0.72rem;" title="Delete">🗑️ Delete</button>
        <div class="delete-menu-options" id="delete-menu-${m.id}" hidden style="position:absolute; bottom:100%; left:0; background:var(--surface,#fff); border:1px solid var(--border,#ddd); border-radius:8px; padding:4px; z-index:5; white-space:nowrap; box-shadow:0 4px 12px rgba(0,0,0,0.15);">
          <button class="btn btn-ghost btn-sm" data-delete-msg="${m.id}" data-delete-mode="me" style="display:block; width:100%; text-align:left;">Delete for me</button>
          ${isMine ? `<button class="btn btn-ghost btn-sm" data-delete-msg="${m.id}" data-delete-mode="everyone" style="display:block; width:100%; text-align:left;">Delete for everyone</button>` : ''}
        </div>
      </span>`;
    if (!m.fileUrl) return `<div class="chat-msg">${sender}${esc(m.body)}${deleteMenu}</div>`;
    const isImage = (m.fileMime || '').startsWith('image/');
    const isVideo = (m.fileMime || '').startsWith('video/');
    const isAudio = (m.fileMime || '').startsWith('audio/');
    if (isAudio) return `<div class="chat-msg">${sender}<div style="margin-top:6px; display:flex; align-items:center; gap:6px;">🎙️ <audio controls src="${esc(m.fileUrl)}" style="height:32px; max-width:220px;"></audio></div>${deleteMenu}</div>`;
    const preview = isImage
      ? `<img src="${esc(m.fileUrl)}" alt="${esc(m.fileName)}" style="max-width:220px; max-height:220px; border-radius:8px; display:block; margin-top:6px;">`
      : isVideo
        ? `<video src="${esc(m.fileUrl)}" controls style="max-width:220px; border-radius:8px; display:block; margin-top:6px;"></video>`
        : `<div style="margin-top:6px;">📎 ${esc(m.fileName)}</div>`;
    return `<div class="chat-msg">${sender}${preview}<a href="${esc(m.fileUrl)}" target="_blank" rel="noopener" style="font-size:0.78rem; text-decoration:underline; display:block; margin-top:4px;">⬇ Download</a>${deleteMenu}</div>`;
  }

  async function renderGroupChat() {
    const { messages, memberCount } = await api(`/groups/${state.view.groupId}/messages`);
    const bubble = (m) => groupMessageBubbleHtml(m).replace(/<\/div>$/, LZX.seenLabel(m, memberCount, state.user.id) + '</div>');
    view.innerHTML = `
      <div class="page-head"><h1>Study group</h1><button class="btn btn-ghost btn-sm" id="back-btn">← Back to groups</button></div>
      <div class="card chat-box">
        <div class="chat-messages" id="chat-messages">
          ${messages.map(bubble).join('') || '<p class="muted">No messages yet — say hello.</p>'}
        </div>
        <form class="chat-input-row" id="chat-form">
          <input type="file" id="chat-file" hidden>
          <button type="button" class="btn btn-ghost" id="chat-attach-btn" title="Attach a file">📎</button>
          <button type="button" class="btn btn-ghost" id="chat-voice-btn" title="Record a voice note">🎙️</button>
          <input type="text" id="chat-input" placeholder="Message your study group…">
          <button class="btn btn-primary" type="submit">Send</button>
        </form>
      </div>
    `;
    document.getElementById('back-btn').addEventListener('click', () => navigate('groups'));
    const box = document.getElementById('chat-messages');
    box.scrollTop = box.scrollHeight;
    LZX.groupExtras({ api, esc, toast, groupId: state.view.groupId, view }).catch(() => {});
    view.querySelectorAll('[data-toggle-delete-menu]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const menu = document.getElementById('delete-menu-' + btn.dataset.toggleDeleteMenu);
        const closeAll = () => view.querySelectorAll('.delete-menu-options').forEach((m) => { m.hidden = true; });
        view.querySelectorAll('.delete-menu-options').forEach((m) => { if (m !== menu) m.hidden = true; });
        if (!menu) return;
        menu.hidden = !menu.hidden;
        if (menu.hidden) return;
        // Placed with fixed coordinates, so the chat box's own scroll area can never clip it. (The
        // first message sits at the very top of that box, where a menu opening upward was cut off.)
        // It opens below the button when there is room, otherwise above, and stays on screen.
        const r = btn.getBoundingClientRect();
        menu.style.position = 'fixed';
        menu.style.bottom = 'auto';
        menu.style.right = 'auto';
        menu.style.zIndex = '400';
        const h = menu.offsetHeight || 96, w = menu.offsetWidth || 200;
        const fitsBelow = r.bottom + 6 + h <= window.innerHeight - 8;
        menu.style.top = (fitsBelow ? r.bottom + 6 : Math.max(8, r.top - h - 6)) + 'px';
        menu.style.left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - w - 8)) + 'px';
        setTimeout(() => document.addEventListener('click', closeAll, { once: true }), 0);
        const box = document.getElementById('chat-messages');
        if (box) box.addEventListener('scroll', closeAll, { once: true });
      });
    });
    view.querySelectorAll('[data-delete-msg]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const mode = btn.dataset.deleteMode;
        if (mode === 'everyone' && !confirm('Delete this message for everyone?')) return;
        try {
          await api(`/groups/${state.view.groupId}/messages/${btn.dataset.deleteMsg}?for=${mode}`, { method: 'DELETE' });
          renderGroupChat();
        } catch (err) { toast(err.message); }
      });
    });
    document.getElementById('chat-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('chat-input');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      // Show the message straight away and save it in the background — no full reload of the
      // chat, so it does not wait on (or repeat) three server round trips.
      const list = document.getElementById('chat-messages');
      const empty = list.querySelector('p.muted');
      if (empty) empty.remove();
      const pending = document.createElement('div');
      pending.innerHTML = groupMessageBubbleHtml({ id: 'pending', senderId: state.user.id, sender: { fullName: state.user.fullName }, body: text, deletedForEveryone: false })
        .replace(/<span style="position:relative[\s\S]*?<\/span>/, '<span class="muted" style="font-size:0.72rem;">sending…</span>');
      const bubble = pending.firstElementChild;
      list.appendChild(bubble);
      list.scrollTop = list.scrollHeight;
      try {
        await api(`/groups/${state.view.groupId}/messages`, { method: 'POST', body: { body: text } });
        bubble.querySelector('.muted') && (bubble.querySelector('.muted').textContent = '✓ Sent');
      } catch (err) {
        bubble.remove();
        input.value = text;
        toast(err.message);
      }
    });
    document.getElementById('chat-attach-btn').addEventListener('click', () => document.getElementById('chat-file').click());
    document.getElementById('chat-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const formData = new FormData();
      formData.append('file', file);
      try {
        await api(`/groups/${state.view.groupId}/messages/file`, { method: 'POST', body: formData });
        renderGroupChat();
      } catch (err) {
        toast(err.message);
      }
    });

    // Voice notes: tap to start recording, tap again to stop and send -- same
    // record-then-upload shape as PassNow's, but sent through the existing group
    // file-upload endpoint (audio is just another fileMime) instead of a data URL.
    const voiceBtn = document.getElementById('chat-voice-btn');
    let mediaRecorder = null;
    voiceBtn.addEventListener('click', async () => {
      if (mediaRecorder && mediaRecorder.state === 'recording') { mediaRecorder.stop(); return; }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        toast('Voice notes need microphone access, which this browser/device does not support.');
        return;
      }
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        toast('Microphone permission denied — cannot record a voice note.');
        return;
      }
      const chunks = [];
      const startedAt = Date.now();
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        voiceBtn.textContent = '🎙️';
        voiceBtn.classList.remove('listening');
        const durationSec = Math.round((Date.now() - startedAt) / 1000);
        if (durationSec < 1) { toast('Recording too short — try again.'); return; }
        const blob = new Blob(chunks, { type: 'audio/webm' });
        const formData = new FormData();
        formData.append('file', new File([blob], `voice-note-${Date.now()}.webm`, { type: 'audio/webm' }));
        try {
          await api(`/groups/${state.view.groupId}/messages/file`, { method: 'POST', body: formData });
          renderGroupChat();
        } catch (err) {
          toast(err.message);
        }
      };
      mediaRecorder.start();
      voiceBtn.textContent = '⏹️';
      voiceBtn.classList.add('listening');
      toast('Recording… tap the mic again to stop and send.');
    });
  }

  // opts.typeFilter restricts to specific Assessment.type values (e.g. only
  // SEMESTER_EXAM for the Semester Exam pages); otherwise students see everything
  // except PAST_QUESTION and SEMESTER_EXAM (those have their own dedicated pages) and
  // lecturers see everything they've created.
  // The server decides how long an assessment gets; these only word it.
  function fmtMins(m) {
    if (m < 60) return m + ' minute' + (m === 1 ? '' : 's');
    const h = Math.floor(m / 60), r = m % 60;
    return h + ' hour' + (h === 1 ? '' : 's') + (r ? ' ' + r + ' minutes' : '');
  }
  function paperSummary(a) {
    const parts = [];
    if (a.objectiveCount) parts.push(a.objectiveCount + ' objective');
    if (a.theoryCount) parts.push(a.theoryCount + ' theory');
    if (!parts.length) parts.push(a._count.questions + ' question' + (a._count.questions === 1 ? '' : 's'));
    parts.push(fmtMins(a.minutes || a._count.questions));
    if (a.totalMarks) parts.push(a.totalMarks + ' marks');
    return parts.join(' · ');
  }

  // ---- CBT / Mock Exam Practice (the way PassNow's mock exams work: pick what you are preparing for, then the year) ----
  // Pick one of your courses, then the year of the paper (2026 back to 2016). Each year is a full paper: Section A is
  // 30 objective questions, Section B is 5 theory questions. The system writes the papers for every course a student
  // is in, so a course opened for the first time shows how many are ready while the rest are still being written.
  async function renderCbtMock() {
    const [{ courses }, ind] = await Promise.all([
      state.user.isIndividual ? Promise.resolve({ courses: [] }) : api('/students/me/courses'),
      api('/individual-courses').catch(() => ({ courses: [] })),
    ]);
    const all = [
      ...courses.map((c) => ({ kind: 'school', id: c.id, title: c.code ? `${c.code} — ${c.title}` : c.title })),
      ...(ind.courses || []).map((c) => ({ kind: 'self', id: c.id, title: c.title })),
    ];
    if (!all.length) {
      view.innerHTML = '<div class="page-head"><h1>CBT Mock Exam Practice</h1></div><div class="card" style="padding:18px;">You have no courses yet. Open <b>My Courses</b> to join one, and its mock exams appear here.</div>';
      return;
    }
    const YEARS = [2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018, 2017, 2016];
    let current = all.find((c) => c.id === state.view.mockCourse) || all[0];
    let timer = null;
    view.innerHTML = `
      <div class="page-head"><h1>CBT Mock Exam Practice</h1></div>
      <p class="muted" style="margin-bottom:12px;">Choose a course, then the year of the paper. Every paper has <b>Section A</b> (30 objective questions) and <b>Section B</b> (5 theory questions), set the way your kind of institution sets its examinations.</p>
      <div class="mk-chips" id="mk-chips">${all.map((c) => `<button type="button" class="mk-chip" data-mk-course="${c.id}">${esc(c.title)}</button>`).join('')}</div>
      <div id="mk-status"></div>
      <div id="mk-list"></div>`;

    const stopTimer = () => { if (timer) { clearInterval(timer); timer = null; } };
    async function paint(c) {
      current = c;
      state.view.mockCourse = c.id;
      view.querySelectorAll('.mk-chip').forEach((b) => b.classList.toggle('on', b.dataset.mkCourse === c.id));
      const { assessments } = await api(c.kind === 'school' ? `/courses/${c.id}/assessments` : `/individual-courses/${c.id}/assessments`);
      if (!document.getElementById('mk-list')) { stopTimer(); return; }
      const papers = new Map();
      assessments.filter((a) => a.type === 'Mock').forEach((a) => {
        const key = a.paperId || a.id;
        const p = papers.get(key) || { year: null, a: null, b: null, created: a.createdAt };
        const m = String(a.title).match(/CBT Mock Exam (20\d\d)/);
        if (m) p.year = Number(m[1]);
        if (a.section === 'THEORY') p.b = a; else p.a = a;
        papers.set(key, p);
      });
      const list = [...papers.values()];
      const byYear = new Map(list.filter((p) => p.year).map((p) => [p.year, p]));
      const others = list.filter((p) => !p.year);
      const ready = byYear.size;
      const card = (year, p) => `
        <div class="mk-year ${p ? '' : 'wait'}"><div class="mk-y">${year}</div><div class="mk-ys">CBT Mock Exam</div>
          ${p ? [p.a, p.b].filter(Boolean).map((a) => `
          <div class="mk-sec"><div class="mk-st"><b>${a.section === 'THEORY' ? 'Section B · Theory' : 'Section A · Objective'}</b><span>${esc(paperSummary(a))}</span></div>
            <button type="button" class="btn btn-primary btn-sm" data-take="${a.id}">Take exam</button></div>`).join('') : '<div class="mk-pending">Being written…</div>'}
        </div>`;
      view.querySelector('#mk-list').innerHTML = `<div class="mk-grid">${YEARS.map((y) => card(y, byYear.get(y))).join('')}${others.map((p) => card('Earlier', p)).join('')}</div>`;
      view.querySelector('#mk-status').innerHTML = ready >= YEARS.length ? '' : `<div class="card" style="padding:12px 14px; margin-bottom:12px;">⏳ The system is writing the ${YEARS[YEARS.length - 1]}–${YEARS[0]} papers for this course: <b>${ready} of ${YEARS.length}</b> ready. This page fills in by itself.</div>`;
      view.querySelectorAll('[data-take]').forEach((btn) => btn.addEventListener('click', () => navigate('take-assessment', { assessmentId: btn.dataset.take, backTo: 'cbt-mock' })));
      stopTimer();
      if (ready < YEARS.length) timer = setInterval(() => { if (!document.getElementById('mk-list')) return stopTimer(); paint(current).catch(() => {}); }, 25000);
    }
    view.querySelectorAll('.mk-chip').forEach((b) => b.addEventListener('click', () => paint(all.find((c) => c.id === b.dataset.mkCourse))));
    paint(current);
    // asks the system to start writing whatever this student's courses are missing (it runs in the background)
    api('/practice/ensure', { method: 'POST' }).catch(() => {});
  }

  async function renderAssessments(isLecturer, opts = {}) {
    const { heading, typeFilter, defaultType, excludeTypes } = opts;
    const courses = isLecturer ? (await ensureLectCourses()).courses : (await api('/students/me/courses')).courses;
    // Individual (non-school) learners have IndividualCourse rows instead of enrolled
    // Courses -- their app-generated assessments live under /individual-courses/:id
    // instead of /courses/:id, but otherwise render identically here.
    const individualCourses = isLecturer ? [] : (await api('/individual-courses')).courses;
    const rows = await Promise.all([
      ...courses.map(async (c) => ({ course: c, assessments: (await api(`/courses/${c.id}/assessments`)).assessments })),
      ...individualCourses.map(async (c) => ({ course: c, assessments: (await api(`/individual-courses/${c.id}/assessments`)).assessments })),
    ]);
    const defaultExclude = ['PAST_QUESTION', 'SEMESTER_EXAM'];
    const kindLabel = isLecturer ? assessmentKindLabel(opts.allowedTypes || ['CA', 'Test', 'Mock']) : '';
    view.innerHTML = `
      <div class="page-head"><h1>${esc(heading || (isLecturer ? 'Tests' : 'CBT Mock Exam Practice'))}</h1></div>
      ${isLecturer ? `<button class="btn btn-accent btn-sm" id="new-assessment-btn" style="margin-bottom:18px;">+ Set new ${esc(kindLabel)}</button>` : ''}
      ${rows.map(({ course, assessments: allAssessments }) => {
        // typeFilter is an inclusive allow-list (e.g. only SEMESTER_EXAM); excludeTypes
        // is a deny-list (e.g. everything except SEMESTER_EXAM) -- kept as two separate
        // options because "Tests" and "Semester Exam" need to be disjoint, not just two
        // different views of the same "everything" list the way they used to be.
        const assessments = allAssessments.filter((a) => {
          if (typeFilter) return typeFilter.includes(a.type);
          if (excludeTypes) return !excludeTypes.includes(a.type);
          return isLecturer || !defaultExclude.includes(a.type);
        });
        return `
        <div style="margin-bottom:22px;">
          <div class="muted" style="font-weight:700; margin-bottom:8px;">${course.code ? `${esc(course.code)} — ` : ''}${esc(course.title)}</div>
          <div class="card">
            ${assessments.map((a) => `
              <div class="list-row">
                <div>
                  <div style="font-weight:600;">${esc(a.title)} ${isLecturer ? (a.sentAt ? '<span class="pill pill-pass" style="margin-left:6px;">Sent</span>' : '<span class="pill pill-muted" style="margin-left:6px;">Draft</span>') : ''}</div>
                  <div class="meta">${esc(a.type === 'PAST_QUESTION' ? 'Mock exam' : a.type)} · ${paperSummary(a)}</div>
                </div>
                ${isLecturer
                  ? `<div style="display:flex; gap:8px; flex-wrap:wrap;">
                      <button class="btn btn-ghost btn-sm" data-edit="${a.id}" data-course="${course.id}">Edit</button>
                      <button class="btn btn-ghost btn-sm" data-send="${a.id}">${a.sentAt ? 'Resend' : 'Send'}</button>
                      <button class="btn btn-ghost btn-sm" data-results="${a.id}">View results</button>
                    </div>`
                  : `<button class="btn btn-primary btn-sm" data-take="${a.id}">${['SEMESTER_EXAM', 'Mock', 'PAST_QUESTION'].includes(a.type) ? 'Take exam' : 'Take test'}</button>`}
              </div>
            `).join('') || '<p class="muted" style="padding:16px;">None yet.</p>'}
          </div>
        </div>
      `;
      }).join('') || '<p class="muted">No courses yet.</p>'}
    `;
    view.querySelectorAll('[data-take]').forEach((btn) => {
      btn.addEventListener('click', () => navigate('take-assessment', { assessmentId: btn.dataset.take, backTo: state.view.screen }));
    });
    view.querySelectorAll('[data-results]').forEach((btn) => {
      btn.addEventListener('click', () => navigate('lect-assessment-results', { assessmentId: btn.dataset.results }));
    });
    view.querySelectorAll('[data-edit]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          const { assessment } = await api(`/assessments/${btn.dataset.edit}`);
          openNewAssessmentDialog(courses, { defaultType, allowedTypes: opts.allowedTypes, existing: { ...assessment, courseId: btn.dataset.course } });
        } catch (err) { toast(err.message); }
      });
    });
    view.querySelectorAll('[data-send]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await api(`/assessments/${btn.dataset.send}/send`, { method: 'POST' });
          toast(btn.textContent === 'Resend' ? 'Resent to the class' : 'Sent to the class');
          render();
        } catch (err) { toast(err.message); }
      });
    });
    if (isLecturer) {
      document.getElementById('new-assessment-btn').addEventListener('click', () => openNewAssessmentDialog(courses, { defaultType, allowedTypes: opts.allowedTypes }));
    }
  }

  function renderSemesterExamHub() {
    return renderAssessments(false, { heading: 'Semester Exam', typeFilter: ['SEMESTER_EXAM'] });
  }

  async function renderTakeAssessment() {
    const { assessment, mySubmission } = await api(`/assessments/${state.view.assessmentId}`);
    if (mySubmission && mySubmission.submittedAt) {
      view.innerHTML = `
        <div class="page-head"><h1>${esc(assessment.title)}</h1><button class="btn btn-ghost btn-sm" id="back-btn">← Back</button></div>
        <div class="card" style="padding:24px;">
          <span class="pill pill-pass">Already submitted</span>
          <p style="margin-top:12px; font-size:1.3rem;" class="tabular">${mySubmission.score} / ${mySubmission.total}</p>
          <button class="btn btn-ghost btn-sm" id="review-btn" style="margin-top:14px;">🔍 Review mistakes</button>
        </div>
      `;
      document.getElementById('back-btn').addEventListener('click', () => navigate(state.view.backTo || 'cbt-mock', { courseId: state.view.backCourseId }));
      document.getElementById('review-btn').addEventListener('click', () => navigate('assessment-review', { assessmentId: assessment.id, assessmentTitle: assessment.title, hubBackTo: state.view.backTo, hubBackCourseId: state.view.backCourseId }));
      return;
    }

    // Starting (or resuming) stamps/reads the server-side deadline -- the countdown is
    // purely a display of that, not the source of truth (server rejects a late submit
    // regardless of what the client's clock says). durationMin here is the server's
    // computed 1-minute-per-question allowance, not the lecturer-set field on the
    // assessment record -- using that stale value instead of what /start actually
    // returned was the bug behind the timer looking broken.
    const { startedAt, durationMin } = await api(`/assessments/${assessment.id}/start`, { method: 'POST' });
    const deadline = new Date(startedAt).getTime() + durationMin * 60000;

    const answers = {};
    const questions = assessment.questions;
    let qIdx = 0;
    view.innerHTML = `
      <div class="page-head">
        <h1>${esc(assessment.title)}</h1>
        <div style="display:flex; align-items:center; gap:12px;">
          <span class="pill pill-accent tabular" id="exam-timer">--:--</span>
          <button class="btn btn-ghost btn-sm exit-exam-btn" id="exit-exam-btn">✕ Exit</button>
        </div>
      </div>
      <p class="muted" style="margin-bottom:10px;">${fmtMins(durationMin)} · ${questions.some((q) => q.questionType === 'THEORY') ? 'write full answers; compare them with the model answer afterwards' : 'auto-graded on submit'}</p>
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:14px;">
        <span class="meta tabular" id="quiz-counter" style="white-space:nowrap;"></span>
        <div style="flex:1; height:6px; border-radius:999px; background:var(--line); overflow:hidden;"><div id="quiz-progress" style="height:100%; background:var(--accent); width:0%;"></div></div>
      </div>
      <div id="quiz-body"></div>
      <div class="controls" style="margin-top:14px;">
        <button class="btn btn-ghost" id="quiz-prev-btn">← Previous</button>
        <button class="btn btn-primary" id="quiz-next-btn">Next →</button>
      </div>
      <div id="quiz-nav" style="display:flex; flex-wrap:wrap; gap:8px; margin-top:18px;"></div>
    `;
    // Leaving the questions asks first (the way PassNow does): the answers typed so far are not kept.
    const isExam = ['SEMESTER_EXAM', 'Mock', 'PAST_QUESTION'].includes(assessment.type);
    document.getElementById('exit-exam-btn').addEventListener('click', () => {
      if (document.getElementById('exit-overlay')) return;
      const box = document.createElement('div');
      box.id = 'exit-overlay';
      box.className = 'exit-overlay';
      box.innerHTML = `<div class="exit-box" role="dialog" aria-modal="true">
        <h3>Exit now?</h3>
        <p>Your progress on this ${isExam ? 'exam' : 'test'} will be lost.</p>
        <div class="exit-actions"><button type="button" class="btn btn-ghost" id="exit-stay">Stay</button><button type="button" class="btn btn-danger" id="exit-go">Exit</button></div>
      </div>`;
      document.body.appendChild(box);
      box.addEventListener('click', (e) => { if (e.target === box) box.remove(); });
      box.querySelector('#exit-stay').addEventListener('click', () => box.remove());
      box.querySelector('#exit-go').addEventListener('click', () => {
        box.remove();
        if (examTimerHandle) { clearInterval(examTimerHandle); examTimerHandle = null; }
        navigate(state.view.backTo || 'cbt-mock', { courseId: state.view.backCourseId });
      });
    });

    function renderNav() {
      document.getElementById('quiz-nav').innerHTML = questions.map((q, i) => `
        <button class="quiz-nav-dot ${answers[q.id] ? 'answered' : ''} ${i === qIdx ? 'current' : ''}" data-jump-q="${i}">${i + 1}</button>
      `).join('');
      document.getElementById('quiz-nav').querySelectorAll('[data-jump-q]').forEach((btn) => {
        btn.addEventListener('click', () => { qIdx = Number(btn.dataset.jumpQ); renderQuestion(); });
      });
    }

    // One question at a time, matching PassNow's exam-taking pattern -- MCQ options
    // are always labeled A/B/C/D, and the Prev/Next controls (plus a jump-to-any
    // question palette below) replace scrolling through every question at once.
    function renderQuestion() {
      const q = questions[qIdx];
      const mine = answers[q.id];
      document.getElementById('quiz-counter').textContent = `Question ${qIdx + 1} of ${questions.length}`;
      document.getElementById('quiz-progress').style.width = `${Math.round(((qIdx + 1) / questions.length) * 100)}%`;
      document.getElementById('quiz-body').innerHTML = `
        <div class="card quiz-q">
          <div style="font-weight:600; margin-bottom:12px; white-space:pre-wrap;">${qIdx + 1}. ${esc(q.text)}</div>
          ${q.questionType === 'THEORY'
            ? `<textarea class="theory-answer" data-q="${q.id}" placeholder="Write your answer…" rows="12" style="width:100%;">${esc(mine ? mine.text : '')}</textarea>`
            : q.options.map((opt, oi) => `
                <div class="quiz-opt ${mine && mine.choice === oi ? 'selected' : ''}" data-opt="${oi}">
                  <span class="opt-label">${OPTION_LABELS[oi] || oi + 1}</span>${esc(opt)}
                </div>
              `).join('')}
        </div>
      `;
      document.getElementById('quiz-body').querySelectorAll('.quiz-opt').forEach((opt) => {
        opt.addEventListener('click', () => {
          answers[q.id] = { questionId: q.id, choice: Number(opt.dataset.opt) };
          renderQuestion();
          renderNav();
        });
      });
      const theoryEl = document.getElementById('quiz-body').querySelector('.theory-answer');
      if (theoryEl) theoryEl.addEventListener('input', () => { answers[q.id] = { questionId: q.id, text: theoryEl.value }; });
      document.getElementById('quiz-prev-btn').disabled = qIdx === 0;
      document.getElementById('quiz-next-btn').textContent = qIdx === questions.length - 1 ? (['SEMESTER_EXAM', 'Mock', 'PAST_QUESTION'].includes(assessment.type) ? 'Submit exam' : 'Submit test') : 'Next →';
    }

    document.getElementById('quiz-prev-btn').addEventListener('click', () => { if (qIdx > 0) { qIdx--; renderQuestion(); renderNav(); } });
    document.getElementById('quiz-next-btn').addEventListener('click', () => {
      if (qIdx < questions.length - 1) { qIdx++; renderQuestion(); renderNav(); }
      else doSubmit(false);
    });

    async function doSubmit(auto) {
      clearInterval(examTimerHandle);
      examTimerHandle = null;
      const payload = Object.values(answers);
      try {
        const { submission, pointsEarned, newBadges } = await api(`/assessments/${assessment.id}/submit`, { method: 'POST', body: { answers: payload } });
        toast(auto ? `Time's up — submitted automatically. Score ${submission.score}/${submission.total}` : `Submitted — score ${submission.score}/${submission.total} · +${pointsEarned} points`);
        (newBadges || []).forEach((b) => setTimeout(() => toast(`Badge earned: ${b.icon} ${b.name}`), 400));
        navigate('take-assessment', { assessmentId: assessment.id, backTo: state.view.backTo, backCourseId: state.view.backCourseId });
      } catch (err) { toast(err.message); }
    }

    renderQuestion();
    renderNav();

    const timerEl = document.getElementById('exam-timer');
    function tick() {
      const msLeft = deadline - Date.now();
      if (msLeft <= 0) {
        timerEl.textContent = '0:00';
        doSubmit(true);
        return;
      }
      const totalSec = Math.floor(msLeft / 1000);
      timerEl.textContent = `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, '0')}`;
    }
    tick();
    examTimerHandle = setInterval(tick, 1000);
  }

  // Review-mistakes for a graded (non-practice) assessment: correct answer highlighted
  // against the student's own choice for objective questions, model answer shown
  // alongside the student's text for theory questions.
  async function renderAssessmentReview() {
    const { assessmentTitle, assessmentId, hubBackTo, hubBackCourseId } = state.view;
    const { review, score, total } = await api(`/assessments/${assessmentId}/my-review`);
    view.innerHTML = `
      <div class="page-head"><h1>Review — ${esc(assessmentTitle || '')}</h1><button class="btn btn-ghost btn-sm" id="back-btn">← Back</button></div>
      <p class="muted" style="margin-bottom:16px;">Score: <span class="tabular">${score}/${total}</span></p>
      ${review.map((q, qi) => q.questionType === 'THEORY' ? `
        <div class="card quiz-q">
          <div style="font-weight:600; margin-bottom:6px;">${qi + 1}. ${esc(q.text)}</div>
          <div class="meta">Your answer</div>
          <p style="margin-bottom:10px;">${esc(q.myAnswer || '(no answer)')}</p>
          <div class="meta">Model answer</div>
          <p>${esc(q.modelAnswer || '(none provided)')}</p>
        </div>
      ` : `
        <div class="card quiz-q">
          <div style="font-weight:600; margin-bottom:6px;">${qi + 1}. ${esc(q.text)}</div>
          ${q.options.map((opt, oi) => `<div class="quiz-opt ${oi === q.correctIndex ? 'correct' : ''} ${oi === q.chosen && oi !== q.correctIndex ? 'wrong' : ''}">${esc(opt)}${oi === q.chosen ? ' — your answer' : ''}</div>`).join('')}
          ${q.explanation ? `<p class="meta" style="margin-top:10px;">${esc(q.explanation)}</p>` : ''}
        </div>
      `).join('')}
    `;
    document.getElementById('back-btn').addEventListener('click', () => navigate('take-assessment', { assessmentId, backTo: hubBackTo, backCourseId: hubBackCourseId }));
  }

  // ---------- boot ----------
  if (state.token && state.user) {
    appScreen.classList.add('active');
    loadHeaderContext().then(() => {
      buildSidebar();
      if (location.hash.includes('billing-callback') && state.user.role === 'STUDENT') {
        checkPendingPayment().then((where) => navigate(where === 'coins' ? 'wallet' : 'billing'));
      } else {
        navigate(defaultScreenFor(state.user.role));
      }
    });
    initNotifications();
  } else {
    // #auth-screen starts hidden so a signed-in user refreshing never sees it flash; it's
    // only revealed once we know we're staying on it.
    authScreen.classList.remove('js-hidden');
    const notice = sessionStorage.getItem('lz_notice');
    if (notice) { sessionStorage.removeItem('lz_notice'); toast(notice); }
    if (openResetFromHash()) { /* the reset screen is showing */ }
    else if (location.hash.includes('login')) showAuthPanel('lg-login');
    else if (location.hash.includes('register')) showAuthPanel('lg-register');
  }
})();
