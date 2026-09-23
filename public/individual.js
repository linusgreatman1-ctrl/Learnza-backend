(function () {
  'use strict';

  // Session storage strategy: sessionStorage is the source of truth once a tab has one
  // (per-tab, so logging into a different account in another tab never overwrites this
  // tab's own session). It falls back to localStorage ONLY when this load is an actual
  // page reload (F5/refresh) -- covering both a normal reload (sessionStorage should
  // already have it, but some embedded webviews don't reliably keep sessionStorage
  // across a reload) and that edge case alike, so refreshing never forces a fresh
  // login. A genuinely fresh navigation into app.html (a new tab, clicking "Open
  // Learnza" from the public site, typing the URL) is deliberately NOT given the
  // fallback: that tab's sessionStorage is empty because it's actually new, not
  // because a reload lost it, so it should show the login screen rather than quietly
  // resuming whichever account last logged in anywhere. Every write (login, profile
  // update, etc.) still saves to both, via saveSession()/clearSession() below, so
  // localStorage always holds the last-active session for the reload fallback, while
  // each tab's own sessionStorage still wins over whatever any other tab does after.
  function isPageReload() {
    try {
      const nav = performance.getEntriesByType('navigation')[0];
      if (nav) return nav.type === 'reload';
      if (performance.navigation) return performance.navigation.type === 1; // legacy TYPE_RELOAD
    } catch { /* Performance/Navigation Timing unavailable */ }
    return true; // unknown -- default to preserving login, the safer direction
  }
  const IS_RELOAD = isPageReload();
  function readSession(key) {
    return sessionStorage.getItem(key) || (IS_RELOAD ? localStorage.getItem(key) : null);
  }
  function saveSession(token, user) {
    sessionStorage.setItem('vp_token', token);
    sessionStorage.setItem('vp_user', JSON.stringify(user));
    localStorage.setItem('vp_token', token);
    localStorage.setItem('vp_user', JSON.stringify(user));
  }
  function clearSession() {
    sessionStorage.removeItem('vp_token');
    sessionStorage.removeItem('vp_user');
    localStorage.removeItem('vp_token');
    localStorage.removeItem('vp_user');
  }

  const state = {
    token: readSession('vp_token') || null,
    user: JSON.parse(readSession('vp_user') || 'null'),
    schoolId: null,
    view: { screen: 'home', courseId: null, groupId: null, assessmentId: null },
  };
  // Seed this tab's own sessionStorage immediately so it's independent from here on --
  // later logins in other tabs (which only touch localStorage's "last active" copy)
  // won't affect this tab even though it fell back to localStorage just now.
  if (state.token && state.user) saveSession(state.token, state.user);
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
  async function api(path, opts = {}) {
    const headers = Object.assign({}, opts.headers);
    if (!(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
    if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
    const res = await fetch('/api' + path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body instanceof FormData ? opts.body : opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
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
  // your plan and billing details.") is a real upstream rate/quota limit, not a bug in
  // the app -- surfaced as a friendlier, less alarming message than passing that raw
  // text straight through everywhere an AI call can fail.
  function aiErrorMessage(err) {
    const msg = (err && err.message) || '';
    if (/quota|rate.?limit|resource.?exhausted|too many requests/i.test(msg)) {
      return "The AI Teacher is getting a lot of use right now and has hit its provider limit — please try again in a few minutes.";
    }
    return msg || 'Something went wrong. Please try again.';
  }

  // ---------- Auth screen ----------
  const authScreen = document.getElementById('auth-screen');
  const appScreen = document.getElementById('app-screen');
  const authError = document.getElementById('auth-error');

  // Nested login/signup toggle inside the individual-panel.
  function wireLoginRegisterToggle(panelId, loginFormId, registerFormId) {
    document.querySelectorAll(`#${panelId} [data-tab]`).forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll(`#${panelId} [data-tab]`).forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const isLogin = btn.dataset.tab === 'login';
        document.getElementById(loginFormId).style.display = isLogin ? 'block' : 'none';
        document.getElementById(registerFormId).style.display = isLogin ? 'none' : 'block';
        authError.innerHTML = '';
      });
    });
  }
  wireLoginRegisterToggle('individual-panel', 'login-form', 'register-form');

  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    authError.innerHTML = '';
    try {
      const { token, user } = await api('/auth/login', {
        method: 'POST',
        body: {
          email: document.getElementById('login-email').value.trim(),
          password: document.getElementById('login-password').value,
        },
      });
      onAuthed(token, user);
    } catch (err) {
      authError.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
    }
  });

  document.getElementById('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    authError.innerHTML = '';
    try {
      const { token, user } = await api('/auth/register-individual', {
        method: 'POST',
        body: {
          fullName: document.getElementById('reg-name').value.trim(),
          institutionType: document.getElementById('reg-institution-type').value,
          attendedSchoolName: document.getElementById('reg-school').value.trim(),
          attendedDepartment: document.getElementById('reg-department').value.trim(),
          courseOfStudy: document.getElementById('reg-course').value.trim(),
          yearOfStudy: document.getElementById('reg-level').value,
          email: document.getElementById('reg-email').value.trim(),
          phone: document.getElementById('reg-phone').value.trim(),
          password: document.getElementById('reg-password').value,
        },
      });
      onAuthed(token, user);
    } catch (err) {
      authError.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
    }
  });

  document.getElementById('signout-btn').addEventListener('click', () => {
    clearSession();
    window.speechSynthesis && window.speechSynthesis.cancel();
    window.location.href = 'index.html';
  });


  async function onAuthed(token, user) {
    state.token = token;
    state.user = user;
    saveSession(token, user);
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
    try {
      const { user, school, department } = await api('/auth/me');
      // Refresh state.user (and its saved copies) too, not just school/department --
      // otherwise a server-side change to the student's own record (level, admission
      // details, etc.) never reaches an already-logged-in browser until they log out and
      // back in, since state.user was only ever set once at login time.
      if (user) { state.user = user; saveSession(state.token, user); }
      state.school = school;
      state.department = department;
    } catch { state.school = null; state.department = null; }
    if (state.school) {
      try { state.semesters = (await api('/semesters')).semesters; } catch { state.semesters = []; }
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
      ['my-dashboard', 'My Dashboard'],
      ['individual-courses', 'My Courses'],
      ['library', 'e-Library'],
      ['groups', 'Study Groups'],
      ['lab-hub', 'Digital Lab'],
      ['past-questions-hub', 'Past Questions'],
      ['tests-hub', 'Tests'],
      ['cbt-mock', 'CBT Mock Exam Practice'],
      ['semester-exam-hub', 'Semester Exam'],
      ['research', 'AI Research Assistant'],
      ['progress', 'My Progress'],
      ['leaderboard', 'Leaderboard'],
      ['digital-id', 'Digital ID'],
      ['billing', 'Subscription'],
      ['settings', 'Settings'],
    ],
  };

  // Builds the "name / school / department" identity lines shown as a profile card
  // on the homepage (My Dashboard, or the admin/lecturer landing screen) instead of
  // the sidebar -- the sidebar stays nav-only.
  const INSTITUTION_TYPE_LABELS = { UNIVERSITY: 'University', POLYTECHNIC: 'Polytechnic', COLLEGE_OF_EDUCATION: 'College of Education', OTHER: 'Other institution' };

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

  function buildSidebar() {
    const u = state.user;

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
    const notifSocket = io('/notifications', { auth: { token: state.token } });
    notifSocket.on('notification:new', () => refreshNotifications());
  }

  const view = document.getElementById('view');

  function navigate(screen, params = {}) {
    window.speechSynthesis && window.speechSynthesis.cancel();
    if (examTimerHandle) { clearInterval(examTimerHandle); examTimerHandle = null; }
    if (simliAvatarClient) { try { simliAvatarClient.close(); } catch { /* already closed */ } simliAvatarClient = null; }
    if (speechCtrl) {
      if (speechCtrl.timer) clearInterval(speechCtrl.timer);
      if (speechCtrl.doneTimeout) clearTimeout(speechCtrl.doneTimeout);
    }
    speechCtrl = null;
    if (voiceRecognizer) { try { voiceRecognizer.abort(); } catch { /* already stopped */ } voiceRecognizer = null; }
    state.view = Object.assign({ screen }, params);
    markActiveNav(screen);
    render();
  }

  // No loading placeholder: the previous screen just stays on-screen (instead of
  // blanking to "Loading…") until the next one's data is ready and replaces it.
  async function render() {
    try {
      await dispatch();
    } catch (err) {
      if (err.code === 'SUBSCRIPTION_REQUIRED' || err.code === 'AI_CREDITS_EXHAUSTED') return renderUpgradePrompt(err.message);
      view.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
    }

    function dispatch() {
      switch (state.view.screen) {
        case 'individual-courses': return renderIndividualCourses();
        case 'individual-course-detail': return renderIndividualCourseDetail();
        case 'lesson-player': return renderLessonPlayer();
        case 'library': return renderLibrary(false);
        case 'pdf-viewer': return renderPdfViewer();
        case 'groups': return renderGroups();
        case 'group-chat': return renderGroupChat();
        case 'my-dashboard': return renderMyDashboard();
        case 'cbt-mock': return renderAssessments(false, { heading: 'CBT Mock Exam Practice', typeFilter: ['Mock'] });
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
        case 'settings-profile': return renderSettingsProfile();
        case 'settings-password': return renderSettingsPassword();
        case 'lab': return renderLab();
        case 'lab-hub': return renderLabHub();
        case 'lab-teach': return renderLabTeach();
        case 'attendance-history': return renderStudentAttendanceHistory();
        case 'assignment-detail': return renderAssignmentDetail();
        case 'past-questions-hub': return renderPastQuestionsHub();
        case 'practice-take': return renderPracticeTake();
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
        <p class="muted" style="margin-bottom:20px;">${esc(message || 'Subscribe to unlock AI Teacher lessons, recorded lectures and live classes.')}</p>
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
      <p class="muted" style="margin-bottom:20px;">Create a course on anything you want to learn — the AI Teacher covers it.</p>
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
        <h3 style="margin:14px 0 8px;">Start an AI Teacher lesson</h3>
        <p class="muted" style="margin-bottom:18px;">Tell the AI Teacher what to cover in this course.</p>
        <button class="btn btn-accent" id="start-ai-teacher-btn">Start AI Teacher</button>
      </div>

      <h3 style="margin-bottom:10px; font-size:1rem;">Pre-recorded lessons</h3>
      <p class="muted" style="margin-bottom:12px;">The app automatically generates narrated AI Teacher lessons for this course. Your assignments, tests and semester exams are on your dashboard and sidebar.</p>
      <div class="card" style="margin-bottom:22px;">
        ${lessons.map((l) => `
          <div class="list-row" data-open-lesson="${l.id}" style="cursor:pointer;">
            <div>
              <div style="font-weight:600;">${esc(l.title)} ${l.locked ? '<span class="pill pill-muted" style="margin-left:6px;">Subscribers only</span>' : ''}</div>
              <div class="meta">AI Teacher · narrated lesson</div>
            </div>
            <span class="pill pill-accent">Lesson ${l.order}</span>
          </div>
        `).join('') || '<p class="muted" style="padding:16px;">Nothing yet — check back shortly, the app generates your first lessons automatically.</p>'}
      </div>

      <button class="btn btn-ghost btn-sm" id="delete-course-btn" style="color:var(--danger);">Delete this course</button>
    `;
    document.getElementById('back-btn').addEventListener('click', () => navigate('individual-courses'));
    document.getElementById('start-ai-teacher-btn').addEventListener('click', () => {
      const topic = prompt(`What topic in ${course.title} should the AI Teacher cover?`);
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
        <h3 style="margin-bottom:8px;">Preparing your lesson on "${esc(topic)}"…</h3>
        <p class="muted">The AI Teacher is drafting a full, comprehensive lesson — this takes a little while.</p>
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
    if (!lesson) { view.innerHTML = '<p>Lesson not found.</p>'; return; }

    if (lesson.locked) {
      view.innerHTML = `
        <div class="page-head"><h1>${esc(lesson.title)}</h1><button class="btn btn-ghost btn-sm" id="back-btn">← Back to course</button></div>
        <div class="card" style="padding:32px; text-align:center;">
          <span class="pill pill-accent">Subscription feature</span>
          <h2 style="margin:14px 0 8px;">This lesson needs an active subscription</h2>
          <p class="muted" style="margin-bottom:20px;">AI Teacher narration and recorded lectures are part of Learnza's paid plan — ₦10,000/month or ₦105,000/year.</p>
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
          <span class="pill pill-muted">Recorded lesson${lesson.author ? ` — ${esc(lesson.author.fullName)}` : ''}</span>
          <div style="margin-top:14px;"><video src="${esc(lesson.videoUrl)}" controls style="width:100%; border-radius:10px;"></video></div>
          <h3 style="margin:18px 0 8px; font-size:0.95rem;">Lesson notes</h3>
          <p style="white-space:pre-wrap;">${esc(lesson.script)}</p>
        ` : `
          <span class="pill ${subscriptionEnforced ? 'pill-accent' : 'pill-pass'}">AI Teacher — ${subscriptionEnforced ? 'subscriber lesson' : 'free during testing'}</span>
          ${aiCredits && aiCredits.tracked ? ` <span class="pill ${aiCredits.exhausted ? 'pill-danger' : 'pill-muted'}">${Math.floor(aiCredits.secondsRemaining / 60)} min left this cycle</span>` : ''}
          <div class="ai-avatar-box" style="margin-top:14px;">
            <div class="ai-avatar-ring" id="ai-avatar-ring">${esc(initials(lesson.title || 'AI'))}</div>
            <video id="avatar-video" class="ai-avatar-video" autoplay playsinline hidden></video>
            <audio id="avatar-audio" autoplay hidden></audio>
            <div class="ai-avatar-label" id="ai-avatar-label">${avatarConfigured ? 'AI Teacher — video avatar available' : 'AI Teacher'}</div>
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

  // ================= AI TEACHER (live interactive session) =================

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
      if (a.type === 'EQUATION' && window.katex) {
        try { window.katex.render(a.content, el, { throwOnError: false }); } catch { el.textContent = a.content; }
      } else if (a.type === 'GRAPH' && window.Chart) {
        try {
          const spec = JSON.parse(a.content);
          new window.Chart(el.querySelector('canvas'), {
            type: spec.type === 'bar' ? 'bar' : 'line',
            data: { labels: spec.labels || [], datasets: [{ data: spec.values || [], backgroundColor: '#e3ac4c', borderColor: '#e3ac4c' }] },
            options: { responsive: true, plugins: { legend: { display: false } } },
          });
        } catch { /* malformed graph spec -- leave the empty canvas rather than crash the board */ }
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
      if (labelEl) labelEl.textContent = 'AI Teacher — video avatar connected';
      return client;
    } catch (err) {
      if (err.code === 'SUBSCRIPTION_REQUIRED' || err.code === 'AI_CREDITS_EXHAUSTED') { renderUpgradePrompt(err.message); return null; }
      console.error('Video avatar connection failed:', err);
      toast(err.message || 'Could not connect the video avatar — continuing with voice only.');
      return null;
    }
  }

  // Tracks whatever the AI Teacher is currently saying so a question can pause it
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
      else toast(err.message || 'The AI Teacher had trouble speaking that.');
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
        labelEl.textContent = simliAvatarClient ? 'AI Teacher — video avatar connected' : originalLabelText;
      }
      if (!heardSomething && onCancelled) onCancelled();
    };
    try { recognizer.start(); } catch { toast('Could not start the microphone.'); recognizer.onend(); return null; }
    return recognizer;
  }

  async function renderAiTeacherSession() {
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
        <div><span class="pill pill-accent">AI Teacher — live session</span>${aiCredits && aiCredits.tracked ? ` <span class="pill ${aiCredits.exhausted ? 'pill-danger' : 'pill-muted'}">${Math.floor(aiCredits.secondsRemaining / 60)} min left this cycle</span>` : ''}<h1 style="margin-top:8px;">${esc(plan.title)}</h1></div>
        <button class="btn btn-ghost btn-sm" id="back-btn">← End session</button>
      </div>
      <div class="card lesson-player">
        <div class="lesson-stage" id="lesson-stage">
          <button class="lesson-stage-expand-btn" id="lesson-expand-btn" title="Expand">⛶</button>
          <div class="ai-avatar-box">
            <div class="ai-avatar-ring" id="ai-avatar-ring">${esc(initials(plan.title || 'AI'))}</div>
            <video id="avatar-video" class="ai-avatar-video" autoplay playsinline hidden></video>
            <audio id="avatar-audio" autoplay hidden></audio>
            <div class="ai-avatar-label" id="ai-avatar-label">${avatarConfigured ? 'Connecting video avatar…' : 'AI Teacher'}</div>
          </div>
          <div class="smart-board-wrap">
            <div class="smart-board-head"><div class="dot">👩🏾‍🏫</div><div class="label" id="board-status">AI Teacher — writing on the board</div></div>
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
          <div><div style="font-weight:600;">✋ Got a question? Raise your hand</div><div class="gq-sub" id="gq-sub">Wait for the teacher to start…</div></div>
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
      if (session.individualCourseId) navigate('individual-course-detail', { courseId: session.individualCourseId });
      else navigate('course-detail', { courseId: session.courseId });
    });

    function renderSection(idx) {
      const section = plan.sections[idx];
      sectionMeta.textContent = `Section ${idx + 1} of ${plan.sections.length}`;
      sectionTitleEl.textContent = section.title;
      setBoardContent(board, section.boardActions);
      boardStatus.textContent = 'AI Teacher — writing on the board';
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
      document.getElementById('gq-sub').textContent = 'Learnza answers visually without leaving the lesson';
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
      boardStatus.textContent = 'AI Teacher — thinking…';
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
        boardStatus.textContent = 'AI Teacher — answering your question';
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
      boardStatus.textContent = 'AI Teacher — checking your understanding';
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
      boardStatus.textContent = 'AI Teacher — thinking…';
      try {
        const result = await api(`/ai-teacher/sessions/${session.id}/check-answer`, { method: 'POST', body: { answer } });
        boardStatus.textContent = result.correct ? 'AI Teacher — well done!' : 'AI Teacher — explaining';
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
          .then((client) => { if (!stopped && client) simliAvatarClient = client; else if (!stopped) avatarLabel.textContent = 'AI Teacher'; });
      }
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
          boardStatus.textContent = 'Lesson complete';
          toast('Lesson complete — nice work!');
          askVoiceBtn.disabled = true;
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
      <div class="id-card" style="margin-bottom:28px;">
        <div class="id-top"><span>Learnza</span><span>Student</span></div>
        <div class="id-row">
          ${selfAvatarHtml('avatar-individual-id')}
          <div>
            <div class="id-value">${esc(u.fullName)}</div>
            <div class="id-field tabular" style="margin-top:4px;">${esc(u.email)}</div>
          </div>
        </div>
        <div class="id-grid">
          <div><div class="id-field">Phone</div><div>${esc(u.phone || '—')}</div></div>
          <div><div class="id-field">Level</div><div>${levelLabel(u.yearOfStudy) || '—'}</div></div>
          <div><div class="id-field">Institution type</div><div>${esc(INSTITUTION_TYPE_LABELS[u.institutionType] || '—')}</div></div>
          <div><div class="id-field">Attended institution</div><div>${esc(u.attendedSchoolName || '—')}</div></div>
          <div><div class="id-field">Department</div><div>${esc(u.attendedDepartment || '—')}</div></div>
          <div><div class="id-field">Course of study</div><div>${esc(u.courseOfStudy || '—')}</div></div>
          <div><div class="id-field">Member since</div><div>${new Date(u.createdAt).toLocaleDateString()}</div></div>
        </div>
      </div>

      <h3 style="margin-bottom:12px; font-size:1rem;">Learnza account</h3>
      <ul class="credential-list" style="margin-bottom:28px;">
        <li class="clickable" id="cred-courses" style="cursor:pointer;"><span>Self-directed courses</span><span class="pill pill-pass">${courses.length} course${courses.length === 1 ? '' : 's'}</span></li>
        <li class="clickable" id="cred-subscription" style="cursor:pointer;"><span>Subscription</span><span class="pill ${active ? 'pill-pass' : 'pill-muted'}">${active ? `Active until ${new Date(subscription.expiresAt).toLocaleDateString()}` : 'No active plan'}</span></li>
        <li class="clickable" id="cred-library" style="cursor:pointer;"><span>e-Library access</span><span class="pill pill-pass">Granted</span></li>
      </ul>
    `;
    wireSelfAvatarUpload('avatar-individual-id');
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
      <div class="id-card" style="margin-bottom:28px;">
        <div class="id-top"><span>Learnza${state.school ? ` · ${esc(state.school.name)}` : ''}</span><span>Student</span></div>
        <div class="id-row">
          ${selfAvatarHtml('avatar-student-id')}
          <div>
            <div class="id-value">${esc(u.fullName)}</div>
            <div class="id-field tabular" style="margin-top:4px;">${esc(u.matricNumber || 'Matric number pending')}</div>
          </div>
        </div>
        <div class="id-grid">
          <div><div class="id-field">Department</div><div>${state.department ? esc(state.department.name) : '—'}</div></div>
          <div><div class="id-field">Level</div><div>${levelLabel(u.yearOfStudy) || '—'}</div></div>
          <div><div class="id-field">Email</div><div>${esc(u.email)}</div></div>
          <div><div class="id-field">Access code</div><div class="tabular">${esc(u.accessCode || '—')}</div></div>
          <div><div class="id-field">Member since</div><div>${new Date(u.createdAt).toLocaleDateString()}</div></div>
        </div>
      </div>

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

    wireSelfAvatarUpload('avatar-student-id');
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
        await api('/auth/change-password', {
          method: 'POST',
          body: { currentPassword: document.getElementById('pw-current').value, newPassword },
        });
        toast('Password updated');
        navigate('settings');
      } catch (err) { toast(err.message); }
    });
  }

  async function renderMyDashboard() {
    const isIndividual = state.user.isIndividual;
    const [{ assignments, attendance, recentResults, lessons, liveRecordings, individualAssessments }, { notifications }] = await Promise.all([
      api('/students/me/dashboard'),
      api('/notifications'),
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

    view.innerHTML = `
      <div class="page-head"><h1>My Dashboard</h1></div>
      <div class="card" style="padding:20px; margin-bottom:22px; display:flex; align-items:center; gap:16px; cursor:pointer;" id="dash-profile-card">
        ${selfAvatarHtml('avatar-student-dash')}
        <div>${profileLines().map((l) => `<div>${l}</div>`).join('')}</div>
      </div>
      <div class="grid-cards" style="margin-bottom:26px;">
        ${statTiles.map(([value, label, anchor]) => `<div class="card course-card" data-jump="${anchor}" style="cursor:pointer;"><div class="code">${value}</div><div class="meta">${esc(label)}</div></div>`).join('')}
      </div>

      ${isIndividual ? '' : `
      <h3 id="dash-assignments" style="margin-bottom:10px; font-size:1rem;">Assignments</h3>
      ${dashSection('assignments', assignments, assignmentRowHtml, 'No assignments posted yet.')}

      <h3 id="dash-attendance" style="margin-bottom:10px; font-size:1rem;">Attendance</h3>
      ${dashSection('attendance', attendanceRows, attendanceRowHtml, 'No attendance recorded yet.')}

      <h3 id="dash-recordings" style="margin-bottom:10px; font-size:1rem;">Live class recordings</h3>
      ${dashSection('recordings', liveRecordings || [], liveRecordingRowHtml, 'No recorded live classes yet.')}

      <h3 id="dash-lessons" style="margin-bottom:10px; font-size:1rem;">Lectures</h3>
      ${dashSection('lessons', lessons || [], lessonRowHtml, 'No lecturer-uploaded lectures yet.')}
      `}

      ${isIndividual ? `
      <h3 id="dash-individualAssessments" style="margin-bottom:10px; font-size:1rem;">Assignments &amp; Tests</h3>
      ${dashSection('individualAssessments', individualAssessments || [], individualAssessmentRowHtml, 'Nothing yet — check back shortly.')}
      ` : ''}

      <h3 id="dash-results" style="margin-bottom:10px; font-size:1rem;">Recent test${isIndividual ? '/assignment' : ''} results</h3>
      ${dashSection('results', recentResults, resultRowHtml, `No ${isIndividual ? 'tests or assignments' : 'test results'} yet.`)}

      <h3 style="margin-bottom:10px; font-size:1rem;">Notifications</h3>
      ${dashSection('notifications', notifications, notificationRowHtml, 'No notifications yet.')}

      <div style="display:flex; gap:12px; flex-wrap:wrap;">
        <button class="btn btn-ghost" id="dash-leaderboard-btn">🏆 See leaderboard</button>
        <button class="btn btn-ghost" id="dash-profile-btn">👤 My profile</button>
      </div>
    `;

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
    document.getElementById('dash-profile-card').addEventListener('click', () => navigate('digital-id'));
    wireSelfAvatarUpload('avatar-student-dash');
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
  async function renderPastQuestionsHub() {
    const { courses } = await api('/students/me/courses');
    const { courses: individualCourses } = await api('/individual-courses');
    const rows = await Promise.all([
      ...courses.map(async (c) => {
        const { assessments } = await api(`/courses/${c.id}/assessments`);
        return { course: c, sets: assessments.filter((a) => a.type === 'PAST_QUESTION') };
      }),
      ...individualCourses.map(async (c) => {
        const { assessments } = await api(`/individual-courses/${c.id}/assessments`);
        return { course: c, sets: assessments.filter((a) => a.type === 'PAST_QUESTION') };
      }),
    ]);
    view.innerHTML = `
      <div class="page-head"><h1>Past Questions</h1></div>
      <p class="muted" style="margin-bottom:16px;">Practice as many times as you like — these don't affect your CBT scores.</p>
      ${rows.map(({ course, sets }) => `
        <div style="margin-bottom:22px;">
          <div class="muted" style="font-weight:700; margin-bottom:8px;">${course.code ? `${esc(course.code)} — ` : ''}${esc(course.title)}</div>
          <div class="card">
            ${sets.map((a) => `
              <div class="list-row">
                <div><div style="font-weight:600;">${esc(a.title)}</div><div class="meta">${a._count.questions} question${a._count.questions === 1 ? '' : 's'}</div></div>
                <button class="btn btn-primary btn-sm" data-practice="${a.id}" data-course-id="${course.id}" data-course-title="${esc(course.title)}" data-course-code="${esc(course.code)}">Practice</button>
              </div>
            `).join('') || '<p class="muted" style="padding:16px;">None yet.</p>'}
          </div>
        </div>
      `).join('') || '<p class="muted">No courses yet.</p>'}
    `;
    view.querySelectorAll('[data-practice]').forEach((btn) => {
      btn.addEventListener('click', () => navigate('practice-take', {
        assessmentId: btn.dataset.practice,
        courseId: btn.dataset.courseId,
        courseTitle: btn.dataset.courseTitle,
        courseCode: btn.dataset.courseCode,
      }));
    });
  }

  // One question at a time (matching PassNow's exam-taking pattern), like
  // renderTakeAssessment -- but practice mode stays batch-graded with unlimited
  // retries: answering pages through questions, then "Check my answers" switches the
  // same paginated view into a read-only correction mode (still one question at a
  // time) instead of dumping every corrected question down the page at once.
  async function renderPracticeTake() {
    const { assessmentId, assessmentTitle, courseId, courseTitle, courseCode } = state.view;
    const { assessment } = await api(`/assessments/${assessmentId}`);
    const questions = assessment.questions;
    const answers = {};
    let qIdx = 0;
    let corrections = null; // set once graded; null while still answering
    let score = null, total = null;
    // 1 minute per question, same rule as timed tests/exams -- auto-submits (grading
    // whatever's answered so far) when time runs out instead of running forever.
    const durationMin = Math.max(1, questions.length);
    const deadline = Date.now() + durationMin * 60000;

    view.innerHTML = `
      <div class="page-head">
        <h1>${esc(assessmentTitle || assessment.title)}</h1>
        <div style="display:flex; align-items:center; gap:12px;">
          <span class="pill pill-accent tabular" id="pq-timer">--:--</span>
          <button class="btn btn-ghost btn-sm" id="back-btn">← Back</button>
        </div>
      </div>
      <p class="muted" style="margin-bottom:10px;">Practice mode — ${durationMin} minute${durationMin === 1 ? '' : 's'} (1 min/question), auto-submits when time's up</p>
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:14px;">
        <span class="meta tabular" id="pq-counter" style="white-space:nowrap;"></span>
        <div style="flex:1; height:6px; border-radius:999px; background:var(--line); overflow:hidden;"><div id="pq-progress" style="height:100%; background:var(--accent); width:0%;"></div></div>
      </div>
      <div id="pq-body"></div>
      <div class="controls" style="margin-top:14px;">
        <button class="btn btn-ghost" id="pq-prev-btn">← Previous</button>
        <button class="btn btn-primary" id="pq-next-btn">Next →</button>
        <button class="btn btn-ghost" id="pq-retry-btn" hidden>↻ Try again</button>
      </div>
      <div id="pq-nav" style="display:flex; flex-wrap:wrap; gap:8px; margin-top:18px;"></div>
      <p id="pq-score" class="meta" style="margin-top:12px;"></p>
    `;
    document.getElementById('back-btn').addEventListener('click', () => {
      if (examTimerHandle) { clearInterval(examTimerHandle); examTimerHandle = null; }
      navigate('past-questions-hub');
    });

    function renderNav() {
      document.getElementById('pq-nav').innerHTML = questions.map((q, i) => {
        let cls = answers[q.id] ? 'answered' : '';
        if (corrections) {
          const c = corrections.get(q.id);
          cls = c && c.questionType !== 'THEORY' && c.correct ? 'answered' : '';
        }
        return `<button class="quiz-nav-dot ${cls} ${i === qIdx ? 'current' : ''}" data-jump-q="${i}">${i + 1}</button>`;
      }).join('');
      document.getElementById('pq-nav').querySelectorAll('[data-jump-q]').forEach((btn) => {
        btn.addEventListener('click', () => { qIdx = Number(btn.dataset.jumpQ); renderQuestion(); });
      });
    }

    function renderQuestion() {
      const q = questions[qIdx];
      const mine = answers[q.id];
      document.getElementById('pq-counter').textContent = `Question ${qIdx + 1} of ${questions.length}`;
      document.getElementById('pq-progress').style.width = `${Math.round(((qIdx + 1) / questions.length) * 100)}%`;
      const c = corrections ? corrections.get(q.id) : null;
      document.getElementById('pq-body').innerHTML = `
        <div class="card quiz-q">
          <div style="font-weight:600; margin-bottom:12px;">${qIdx + 1}. ${esc(q.text)}</div>
          ${q.questionType === 'THEORY'
            ? c
              ? `<div class="meta">Your answer</div><p style="margin-bottom:10px;">${esc(c.myAnswer || '(no answer)')}</p><div class="meta">Model answer</div><p>${esc(c.modelAnswer || '(none provided)')}</p>`
              : `<textarea class="theory-answer" placeholder="Write your answer…" rows="5" style="width:100%;">${esc(mine ? mine.text : '')}</textarea>`
            : q.options.map((opt, oi) => `
                <div class="quiz-opt
                  ${!c && mine && mine.choice === oi ? 'selected' : ''}
                  ${c && oi === c.correctIndex ? 'correct' : ''}
                  ${c && oi === c.chosen && !c.correct ? 'wrong' : ''}"
                  data-opt="${oi}">
                  <span class="opt-label">${OPTION_LABELS[oi] || oi + 1}</span>${esc(opt)}
                </div>
              `).join('')}
          ${c && c.questionType !== 'THEORY' ? `<p class="meta" style="margin-top:10px;">${c.correct ? 'Correct' : 'Not quite — correct answer highlighted above.'}</p>${c.explanation ? `<p style="margin-top:6px;">${esc(c.explanation)}</p>` : ''}` : ''}
        </div>
      `;
      if (!c) {
        document.getElementById('pq-body').querySelectorAll('.quiz-opt').forEach((opt) => {
          opt.addEventListener('click', () => {
            answers[q.id] = { questionId: q.id, choice: Number(opt.dataset.opt) };
            renderQuestion();
            renderNav();
          });
        });
        const theoryEl = document.getElementById('pq-body').querySelector('.theory-answer');
        if (theoryEl) theoryEl.addEventListener('input', () => { answers[q.id] = { questionId: q.id, text: theoryEl.value }; });
      }
      document.getElementById('pq-prev-btn').disabled = qIdx === 0;
      const nextBtn = document.getElementById('pq-next-btn');
      nextBtn.hidden = !!corrections;
      nextBtn.textContent = qIdx === questions.length - 1 ? 'Check my answers' : 'Next →';
    }

    async function submitPractice(auto) {
      if (corrections) return; // already graded (e.g. timer fired right after a manual submit)
      if (examTimerHandle) { clearInterval(examTimerHandle); examTimerHandle = null; }
      try {
        const result = await api(`/assessments/${assessmentId}/practice-submit`, { method: 'POST', body: { answers: Object.values(answers) } });
        corrections = new Map(result.corrections.map((c) => [c.questionId, c]));
        score = result.score; total = result.total;
        document.getElementById('pq-score').textContent = `${auto ? "Time's up — auto-submitted. " : ''}Score: ${score} / ${total} (objective questions only)`;
        document.getElementById('pq-retry-btn').hidden = false;
        qIdx = 0;
        renderQuestion();
        renderNav();
      } catch (err) { toast(err.message); }
    }

    document.getElementById('pq-prev-btn').addEventListener('click', () => { if (qIdx > 0) { qIdx--; renderQuestion(); } });
    document.getElementById('pq-next-btn').addEventListener('click', () => {
      if (qIdx < questions.length - 1) { qIdx++; renderQuestion(); return; }
      submitPractice(false);
    });
    document.getElementById('pq-retry-btn').addEventListener('click', () => navigate('practice-take', { assessmentId, assessmentTitle, courseId, courseTitle, courseCode }));

    const timerEl = document.getElementById('pq-timer');
    function tick() {
      const msLeft = deadline - Date.now();
      if (msLeft <= 0) {
        timerEl.textContent = '0:00';
        submitPractice(true);
        return;
      }
      const totalSec = Math.floor(msLeft / 1000);
      timerEl.textContent = `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, '0')}`;
    }
    tick();
    examTimerHandle = setInterval(tick, 1000);

    renderQuestion();
    renderNav();
  }

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
  // the live AI Teacher session -- applied to a Digital Lab practical's steps instead
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
    // speaking -- structured the same way as AI Teacher's session.
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
            <div class="ai-avatar-label" id="ai-avatar-label">${avatarConfigured ? 'Connecting video avatar…' : 'AI Teacher'}</div>
          </div>
          <div class="smart-board-wrap">
            <div class="smart-board-head"><div class="dot">🧪</div><div class="label" id="board-status">AI Teacher — writing on the board</div></div>
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
          <div><div style="font-weight:600;">✋ Got a question? Raise your hand</div><div class="gq-sub" id="gq-sub">Wait for the teacher to start…</div></div>
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
      boardStatus.textContent = 'AI Teacher — writing on the board';
      return step;
    }

    document.getElementById('got-question-toggle').addEventListener('click', () => {
      if (!teachingStarted) return;
      const panel = document.getElementById('got-question-panel');
      panel.hidden = !panel.hidden;
      document.getElementById('gq-arrow').textContent = panel.hidden ? '▼' : '▲';
    });

    // Flips on once the teacher starts speaking the first step -- structured the same
    // way as AI Teacher, so "got a question" only opens once teaching has actually begun.
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
      boardStatus.textContent = 'AI Teacher — thinking…';
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
        boardStatus.textContent = 'AI Teacher — answering your question';
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
          .then((client) => { if (!stopped && client) simliAvatarClient = client; else if (!stopped) avatarLabel.textContent = 'AI Teacher'; });
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
          <div class="meta" style="margin-bottom:12px;">Type a topic and the AI Teacher drafts it instantly — no admin review, included with your subscription.</div>
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
      <p class="muted" style="margin-bottom:20px;">Guided practicals with a talking AI teacher and a smart board — pick a course to see what's available.</p>
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
      <p class="muted" style="margin-bottom:18px;">Ask it to explain a concept, help structure a project or lesson, or suggest what to search for. It can't browse the web, so it won't invent fake citations — always verify sources with your ${state.user.role === 'STUDENT' ? 'lecturer or library' : 'own research'}.</p>
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
    const [{ active, subscription, enforced }, { paystack, flutterwave }] = await Promise.all([
      api('/billing/status'),
      api('/billing/providers'),
    ]);
    const noProvider = !paystack && !flutterwave;

    view.innerHTML = `
      <div class="page-head"><h1>Subscription</h1></div>
      ${!enforced ? `<div class="hint-box" style="margin-bottom:18px;">Testing phase: every feature is free for everyone right now, subscribed or not. Pricing below is what it'll cost once testing wraps up.</div>` : ''}
      ${active ? `
        <div class="card" style="padding:20px; margin-bottom:20px;">
          <span class="pill pill-pass">Active</span>
          <p style="margin-top:10px;">Your ${esc(subscription.plan === 'YEARLY' ? 'yearly' : 'monthly')} plan is active until <strong>${new Date(subscription.expiresAt).toLocaleDateString()}</strong>.</p>
          <div style="margin-top:14px;">
            <div class="meta" style="margin-bottom:4px;">Live AI Teacher minutes this cycle</div>
            <div class="tabular" style="font-weight:600;">${Math.max(0, Math.floor((subscription.aiSecondsGranted - subscription.aiSecondsUsed) / 60))} / ${Math.floor(subscription.aiSecondsGranted / 60)} min left</div>
            ${subscription.aiSecondsUsed >= subscription.aiSecondsGranted ? '<p class="muted" style="margin-top:6px;">You have used up this cycle\'s AI credit — subscribe again to top up.</p>' : ''}
          </div>
        </div>
      ` : `
        <div class="card" style="padding:20px; margin-bottom:20px;">
          <span class="pill pill-muted">No active plan</span>
          <p class="muted" style="margin-top:10px;">Subscribe to unlock AI Teacher lessons, recorded lectures and live classes — each plan includes a bank of live AI Teacher minutes (300/month, or 3,600 for the year) that refills every time you subscribe. e-Library, study groups and CBT practice stay free either way.</p>
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

    view.querySelectorAll('[data-plan]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const provider = paystack ? 'paystack' : 'flutterwave';
        try {
          const { checkoutUrl, reference } = await api('/billing/checkout', {
            method: 'POST',
            body: { plan: btn.dataset.plan, provider },
          });
          localStorage.setItem('vp_pending_payment_ref', reference);
          window.location.href = checkoutUrl;
        } catch (err) {
          toast(err.message);
        }
      });
    });
  }

  async function checkPendingPayment() {
    const reference = localStorage.getItem('vp_pending_payment_ref');
    if (!reference || !location.hash.includes('billing-callback')) return;
    localStorage.removeItem('vp_pending_payment_ref');
    try {
      await api(`/billing/verify/${reference}`);
      toast('Payment confirmed — subscription activated!');
    } catch {
      // Webhook may still be catching up; the billing page will reflect status shortly either way.
    }
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
  async function renderIndividualLibrary() {
    const { items } = await api('/library?global=true');
    view.innerHTML = `
      <div class="page-head"><h1>e-Library</h1></div>
      <p class="muted" style="margin-bottom:20px;">Textbooks and resources available to every Learnza learner.</p>
      <div class="card">
        ${items.map(libraryItemCardHtml).join('') || '<p class="muted" style="padding:16px;">No textbooks available yet — check back soon.</p>'}
      </div>
    `;
    view.querySelectorAll('[data-open-pdf]').forEach((btn) => {
      btn.addEventListener('click', () => navigate('pdf-viewer', { url: btn.dataset.openPdf, title: btn.dataset.pdfTitle, backTo: 'library' }));
    });
  }

  async function renderLibrary() {
    return renderIndividualLibrary();
    const [{ departments }, { items: allItems }, lecturerCourses] = await Promise.all([
      api(`/departments?schoolId=${state.user.schoolId}`),
      api(`/library?schoolId=${state.user.schoolId}`),
      isLecturer ? ensureLectCourses().then((r) => r.courses) : Promise.resolve([]),
    ]);
    const deptCourses = {};
    await Promise.all(departments.map(async (d) => { deptCourses[d.id] = (await api(`/departments/${d.id}/courses`)).courses; }));
    const itemsByCourse = {};
    for (const it of allItems) (itemsByCourse[it.courseId] = itemsByCourse[it.courseId] || []).push(it);

    view.innerHTML = `
      <div class="page-head"><h1>e-Library</h1></div>
      <p class="muted" style="margin-bottom:20px;">Textbooks for every department and course, browsable by subject — not just what you're enrolled in.</p>
      ${isLecturer ? `
        <div class="card" style="padding:20px; margin-bottom:22px;">
          <h3 style="margin-bottom:12px; font-size:1rem;">Add a textbook</h3>
          <form id="upload-form">
            <div class="field"><label>Course</label>
              <select id="lib-course">${lecturerCourses.map((c) => `<option value="${c.id}">${esc(c.code)} — ${esc(c.title)}</option>`).join('')}</select>
            </div>
            <div class="field"><label>Title</label><input type="text" id="lib-title" required placeholder="e.g. Introduction to Organic Chemistry"></div>
            <div class="field"><label>Author(s)</label><input type="text" id="lib-author" required placeholder="e.g. J. O. Adeyemi, T. K. Bello"></div>
            <div class="field"><label>Publisher <span class="muted">(optional)</span></label><input type="text" id="lib-publisher" placeholder="e.g. Spectrum Books"></div>
            <div class="field"><label>Type</label>
              <select id="lib-type"><option>Textbook</option><option>Journal</option><option>Past Question</option><option>Handout</option></select>
            </div>
            <div class="field"><label>File (from your device)</label><input type="file" id="lib-file" required></div>
            <button class="btn btn-primary" type="submit" id="lib-submit-btn">Upload</button>
          </form>
        </div>` : ''}
      ${departments.map((d) => `
        <div style="margin-bottom:26px;">
          <div class="muted" style="font-weight:700; margin-bottom:10px;">${esc(d.name)}</div>
          ${(deptCourses[d.id] || []).map((c) => `
            <div style="margin-bottom:14px;">
              <div style="font-size:0.85rem; font-weight:600; margin-bottom:6px;">${esc(c.code)} — ${esc(c.title)}</div>
              <div class="card">
                ${(itemsByCourse[c.id] || []).map(libraryItemCardHtml).join('') || '<p class="muted" style="padding:14px 16px;">No textbooks yet.</p>'}
              </div>
            </div>
          `).join('') || '<p class="muted">No courses yet.</p>'}
        </div>
      `).join('') || '<p class="muted">No departments yet.</p>'}
    `;
    if (isLecturer) {
      document.getElementById('upload-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData();
        fd.append('courseId', document.getElementById('lib-course').value);
        fd.append('title', document.getElementById('lib-title').value);
        fd.append('author', document.getElementById('lib-author').value);
        fd.append('publisher', document.getElementById('lib-publisher').value);
        fd.append('type', document.getElementById('lib-type').value);
        const file = document.getElementById('lib-file').files[0];
        if (!file) return toast('Attach a file from your device.');
        fd.append('file', file);

        const submitBtn = document.getElementById('lib-submit-btn');
        submitBtn.disabled = true;
        submitBtn.textContent = 'Uploading…';
        try {
          const { storage } = await api('/library', { method: 'POST', body: fd });
          toast('Textbook added');
          if (storage === 'local-disk') {
            toast('Note: cloud storage isn\'t configured yet, so this file may not survive the next deploy.');
          }
          render();
        } catch (err) {
          toast(err.message);
          submitBtn.disabled = false;
          submitBtn.textContent = 'Upload';
        }
      });
    }
    view.querySelectorAll('[data-open-pdf]').forEach((btn) => {
      btn.addEventListener('click', () => navigate('pdf-viewer', { url: btn.dataset.openPdf, title: btn.dataset.pdfTitle, backTo: isLecturer ? 'lect-library' : 'library' }));
    });
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
    const { messages } = await api(`/groups/${state.view.groupId}/messages`);
    view.innerHTML = `
      <div class="page-head"><h1>Study group</h1><button class="btn btn-ghost btn-sm" id="back-btn">← Back to groups</button></div>
      <div class="card chat-box">
        <div class="chat-messages" id="chat-messages">
          ${messages.map(groupMessageBubbleHtml).join('') || '<p class="muted">No messages yet — say hello.</p>'}
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
    view.querySelectorAll('[data-toggle-delete-menu]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const menu = document.getElementById('delete-menu-' + btn.dataset.toggleDeleteMenu);
        view.querySelectorAll('.delete-menu-options').forEach((m) => { if (m !== menu) m.hidden = true; });
        if (menu) menu.hidden = !menu.hidden;
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
      if (!input.value.trim()) return;
      await api(`/groups/${state.view.groupId}/messages`, { method: 'POST', body: { body: input.value } });
      input.value = '';
      renderGroupChat();
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
    const kindLabel = isLecturer ? assessmentKindLabel(opts.allowedTypes || ['CA', 'Test', 'Mock', 'PAST_QUESTION']) : '';
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
                  <div class="meta">${esc(a.type)} · ${a._count.questions} question${a._count.questions === 1 ? '' : 's'} · ${a._count.questions} min</div>
                </div>
                ${isLecturer
                  ? `<div style="display:flex; gap:8px; flex-wrap:wrap;">
                      <button class="btn btn-ghost btn-sm" data-edit="${a.id}" data-course="${course.id}">Edit</button>
                      <button class="btn btn-ghost btn-sm" data-send="${a.id}">${a.sentAt ? 'Resend' : 'Send'}</button>
                      <button class="btn btn-ghost btn-sm" data-results="${a.id}">View results</button>
                    </div>`
                  : `<button class="btn btn-primary btn-sm" data-take="${a.id}">Take test</button>`}
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
          <button class="btn btn-ghost btn-sm" id="back-btn">← Back</button>
        </div>
      </div>
      <p class="muted" style="margin-bottom:10px;">${durationMin} minute${durationMin === 1 ? '' : 's'} (1 min/question) · auto-graded on submit</p>
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
    document.getElementById('back-btn').addEventListener('click', () => navigate(state.view.backTo || 'cbt-mock', { courseId: state.view.backCourseId }));

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
          <div style="font-weight:600; margin-bottom:12px;">${qIdx + 1}. ${esc(q.text)}</div>
          ${q.questionType === 'THEORY'
            ? `<textarea class="theory-answer" data-q="${q.id}" placeholder="Write your answer…" rows="5" style="width:100%;">${esc(mine ? mine.text : '')}</textarea>`
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
      document.getElementById('quiz-next-btn').textContent = qIdx === questions.length - 1 ? 'Submit test' : 'Next →';
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
        checkPendingPayment().then(() => navigate('billing'));
      } else {
        navigate(defaultScreenFor(state.user.role));
      }
    });
    initNotifications();
  } else {
    // #auth-screen starts hidden (see app.html) precisely so a logged-in user
    // refreshing never sees it at all -- it's only revealed once we've actually
    // decided we're staying on it, right here, instead of painting on every
    // load/refresh by default and getting hidden again a moment later.
    authScreen.classList.remove('js-hidden');
    if (new URLSearchParams(location.search).get('from') !== 'intro') {
      // Landed here directly -- a bookmark, a typed URL, or a new tab's own history
      // autocomplete -- rather than by clicking through from the introduction page.
      // index.html's own links to this page all carry ?from=intro, so its "Open
      // Learnza"/"Log in"/"Learn independently" buttons still land straight on this
      // login screen as always; anything else goes to the introduction page first,
      // matching the site's intended entry flow instead of skipping straight to a
      // bare login form.
      window.location.replace('index.html');
    } else if (location.hash.includes('register')) {
      document.querySelector('#individual-panel [data-tab="register"]').click();
    }
  }
})();
