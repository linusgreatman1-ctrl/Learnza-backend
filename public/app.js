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

  // Top-level audience tabs: School (access code) / Individual Student / Admin.
  document.querySelectorAll('[data-audience]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-audience]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('school-login-form').style.display = btn.dataset.audience === 'school' ? 'block' : 'none';
      document.getElementById('individual-panel').style.display = btn.dataset.audience === 'individual' ? 'block' : 'none';
      document.getElementById('admin-panel').style.display = btn.dataset.audience === 'admin' ? 'block' : 'none';
      authError.innerHTML = '';
    });
  });

  // Nested login/signup toggle, reused by both the Individual Student and Admin panels.
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
  wireLoginRegisterToggle('admin-panel', 'admin-login-form', 'admin-register-form');

  document.getElementById('school-login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    authError.innerHTML = '';
    try {
      const { token, user } = await api('/auth/login-with-code', {
        method: 'POST',
        body: {
          fullName: document.getElementById('school-name').value.trim(),
          schoolName: document.getElementById('school-school').value.trim(),
          accessCode: document.getElementById('school-code').value.trim(),
        },
      });
      onAuthed(token, user);
    } catch (err) {
      authError.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
    }
  });

  document.getElementById('admin-login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    authError.innerHTML = '';
    try {
      const { token, user } = await api('/auth/login', {
        method: 'POST',
        body: {
          email: document.getElementById('admin-email').value.trim(),
          password: document.getElementById('admin-password').value,
        },
      });
      onAuthed(token, user);
    } catch (err) {
      authError.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
    }
  });

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

  document.getElementById('admin-register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    authError.innerHTML = '';
    try {
      const { token, user } = await api('/auth/register-school', {
        method: 'POST',
        body: {
          schoolName: document.getElementById('admin-reg-school').value.trim(),
          location: document.getElementById('admin-reg-location').value || '',
          fullName: document.getElementById('admin-reg-name').value.trim(),
          email: document.getElementById('admin-reg-email').value.trim(),
          phone: document.getElementById('admin-reg-phone').value.trim(),
          password: document.getElementById('admin-reg-password').value,
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
    STUDENT: [
      ['my-dashboard', 'My Dashboard'],
      ['courses', 'My Courses'],
      ['library', 'e-Library'],
      ['groups', 'Study Groups'],
      ['lab-hub', 'Digital Lab'],
      ['past-questions-hub', 'Past Questions'],
      ['tests-hub', 'Tests'],
      ['cbt-mock', 'CBT Mock Exam Practice'],
      ['semester-exam-hub', 'Semester Exam'],
      ['student-results', 'Results'],
      ['research', 'AI Research Assistant'],
      ['progress', 'My Progress'],
      ['leaderboard', 'Leaderboard'],
      ['admission-status', 'Admission Status'],
      ['digital-id', 'Digital ID'],
      ['billing', 'Subscription'],
      ['settings', 'Settings'],
    ],
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
    LECTURER: [
      ['lect-dashboard', 'My Dashboard'],
      ['lect-courses', 'My Courses'],
      ['lect-students', 'My Students'],
      ['lect-library', 'e-Library'],
      ['lect-attendance-hub', 'Class Attendance'],
      ['lect-tests', 'Tests'],
      ['lect-semester-exam', 'Semester Exam'],
      ['lect-assessments', 'Assessments'],
      ['lect-assignments-hub', 'Assignments'],
      ['lect-results-hub', 'Student Results'],
      ['research', 'AI Research Assistant'],
      ['staff-profile', 'My Staff Profile'],
      ['digital-id', 'Digital ID'],
      ['settings', 'Settings'],
      ['preview-student-dashboard', '🎓 Preview Student Dashboard'],
    ],
    ADMIN: [
      ['admin-dashboard', 'My Dashboard'],
      ['admin-directory', 'Staff & Student Directory'],
      ['admin-academics', 'Departments & Courses'],
      ['admin-tests', 'Tests'],
      ['admin-semester-exam', 'Semester Exam'],
      ['admin-activity', 'Lecturer Activity'],
      ['admin-student-activity', 'Student Activity'],
      ['admin-lab-queue', 'Digital Lab'],
      ['admin-admissions', 'Admissions'],
      ['admin-staff-records', 'Staff Records'],
      ['admin-student-requests', 'Student Requests'],
      ['admin-hostel-allocations', 'Hostels'],
      ['admin-results', 'Results'],
      ['admin-announce', 'Announce'],
      ['admin-bulk-message', 'Bulk SMS/Email'],
      ['admin-management', 'Admin Management'],
      ['settings', 'Settings'],
      ['preview-student-dashboard', '🎓 Preview Student Dashboard'],
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
    banner.querySelector('[data-dismiss]').addEventListener('click', () => banner.remove());
    // Left unread if dismissed (still sitting in the bell for later) -- only
    // auto-removed from screen so it doesn't linger forever if ignored.
    setTimeout(() => banner.remove(), 45000);
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
    // not just at the moment of login.
    setInterval(refreshNotifications, 20000);
  }

  const view = document.getElementById('view');

  function navigate(screen, params = {}) {
    window.speechSynthesis && window.speechSynthesis.cancel();
    if (state.view.screen === 'live-class' && screen !== 'live-class') teardownLive();
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
        case 'courses': return renderStudentCourses();
        case 'individual-courses': return renderIndividualCourses();
        case 'individual-course-detail': return renderIndividualCourseDetail();
        case 'course-detail': return renderCourseDetail();
        case 'lesson-player': return renderLessonPlayer();
        case 'library': return renderLibrary(false);
        case 'pdf-viewer': return renderPdfViewer();
        case 'groups': return renderGroups();
        case 'group-chat': return renderGroupChat();
        case 'my-dashboard': return renderMyDashboard();
        case 'cbt-mock': return renderAssessments(false, { heading: 'CBT Mock Exam Practice', typeFilter: ['Mock'] });
        case 'tests-hub': return renderAssessments(false, { heading: 'Tests', typeFilter: ['CA', 'Test'] });
        case 'admission-status': return renderAdmissionStatus();
        case 'student-results': return renderStudentResultsHub();
        case 'take-assessment': return renderTakeAssessment();
        case 'assessment-review': return renderAssessmentReview();
        case 'billing': return renderBilling();
        case 'ai-teacher-session': return renderAiTeacherSession();
        case 'live-class': return renderLiveClass();
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
        case 'transcript': return renderTranscript();
        case 'attendance-history': return renderStudentAttendanceHistory();
        case 'assignment-detail': return renderAssignmentDetail();
        case 'past-questions-hub': return renderPastQuestionsHub();
        case 'practice-take': return renderPracticeTake();
        case 'semester-exam-hub': return renderSemesterExamHub();

        case 'lect-dashboard': return renderLecturerDashboard();
        case 'lect-courses': return renderLecturerCourses();
        case 'lect-lessons': return renderLecturerLessons();
        case 'lect-library': return renderLibrary(true);
        case 'lect-tests': return renderAssessments(true, { heading: 'Tests', excludeTypes: ['SEMESTER_EXAM', 'PAST_QUESTION'], allowedTypes: ['CA', 'Test', 'Mock'] });
        case 'lect-assessments': return renderAssessments(true, { heading: 'Assessments', typeFilter: ['PAST_QUESTION'], defaultType: 'PAST_QUESTION', allowedTypes: ['PAST_QUESTION'] });
        case 'lect-classwork-quiz': return renderAssessments(true, { heading: 'Classwork / Quiz', typeFilter: ['Classwork', 'Quiz'], defaultType: 'Classwork', allowedTypes: ['Classwork', 'Quiz'] });
        case 'lect-mark-work': return renderMarkWorkHub();
        case 'lect-semester-exam': return renderLecturerSemesterExam();
        case 'lect-assessment-results': return renderAssessmentResults();
        case 'lect-attendance-hub': return renderLecturerAttendanceHub();
        case 'lect-attendance': return renderLecturerAttendance();
        case 'lect-assignments-hub': return renderLecturerAssignmentsHub();
        case 'lect-assignment-submissions': return renderAssignmentSubmissions();
        case 'lect-results-hub': return renderLecturerResultsHub();
        case 'lect-students': return renderLecturerStudentsHub();
        case 'lect-class-roster': return renderLecturerClassRoster();
        case 'lect-student-detail': return renderLecturerStudentDetail();
        case 'staff-profile': return renderStaffProfile();
        case 'preview-student-dashboard': return renderPreviewStudentDashboard();

        case 'admin-dashboard': return renderAdminDashboard();
        case 'admin-directory': return renderAdminDirectory();
        case 'admin-directory-list': return renderAdminDirectoryList();
        case 'admin-directory-detail': return renderAdminDirectoryDetail();
        case 'admin-academics': return renderAdminAcademics();
        case 'admin-tests': return renderAdminTests();
        case 'admin-semester-exam': return renderAdminSemesterExam();
        case 'admin-exam-questions': return renderAdminExamQuestions();
        case 'admin-activity': return renderAdminActivity();
        case 'admin-lab-queue': return renderAdminLabQueue();
        case 'admin-admissions': return renderAdminAdmissions();
        case 'admin-admissions-detail': return renderAdminAdmissionDetail();
        case 'admin-aptitude-test': return renderAdminAptitudeTest();
        case 'admin-staff-records': return renderAdminStaffRecords();
        case 'admin-student-requests': return renderAdminStudentRequests();
        case 'admin-hostel-allocations': return renderAdminHostelAllocations();
        case 'admin-hostel-detail': return renderAdminHostelDetail();
        case 'admin-results': return renderAdminResults();
        case 'admin-student-results': return renderAdminStudentResults();
        case 'admin-student-activity': return renderAdminStudentActivity();
        case 'admin-announce': return renderAdminAnnounce();
        case 'admin-bulk-message': return renderAdminBulkMessage();
        case 'admin-management': return renderAdminManagement();
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

  // ================= STUDENT =================

  // state.view.semesterId picks which semester's courses "Browse & enroll" shows,
  // defaulting to the school's current semester -- matches Course.semesterId, so
  // switching the tab is a pure client-side filter, no extra request.
  async function renderStudentCourses() {
    const [{ courses: mine }, { departments }] = await Promise.all([
      api('/students/me/courses'),
      api(`/departments?schoolId=${state.user.schoolId}`),
    ]);
    const deptCourses = {};
    await Promise.all(departments.map(async (d) => { deptCourses[d.id] = (await api(`/departments/${d.id}/courses`)).courses; }));
    const mineIds = new Set(mine.map((c) => c.id));
    const semesters = state.semesters || [];
    const activeSemesterId = state.view.semesterId || (semesters.find((s) => s.isCurrent) || semesters[0] || {}).id;

    view.innerHTML = `
      <div class="page-head"><h1>My Courses</h1></div>
      ${mine.length ? `<div class="grid-cards" style="margin-bottom:30px;">
        ${mine.map(courseCardHtml).join('')}
      </div>` : '<p class="muted" style="margin-bottom:24px;">You are not enrolled in any course yet — pick a semester below to see what is on offer.</p>'}
      <div class="page-head"><h1 style="font-size:1.15rem;">Browse &amp; enroll by semester</h1></div>
      ${semesters.length ? `
        <div class="tabs" style="max-width:420px;">
          ${semesters.map((s) => `<button class="tab-btn ${s.id === activeSemesterId ? 'active' : ''}" data-semester-tab="${s.id}">${esc(semesterLabel(s.name))}</button>`).join('')}
        </div>
      ` : ''}
      ${departments.map((d) => {
        const courses = activeSemesterId ? deptCourses[d.id].filter((c) => c.semesterId === activeSemesterId) : deptCourses[d.id];
        return `
        <div style="margin-bottom:22px; margin-top:18px;">
          <div class="muted" style="font-weight:700; margin-bottom:8px;">${esc(d.name)}${d.id === state.department?.id ? ' <span class="pill pill-accent">Your department</span>' : ''}</div>
          <div class="grid-cards">
            ${courses.map((c) => enrollCardHtml(c, mineIds.has(c.id))).join('') || '<p class="muted">No courses for this semester yet.</p>'}
          </div>
        </div>
      `;
      }).join('')}
    `;

    view.querySelectorAll('[data-semester-tab]').forEach((btn) => {
      btn.addEventListener('click', () => navigate('courses', { semesterId: btn.dataset.semesterTab }));
    });
    view.querySelectorAll('[data-open-course]').forEach((el) => {
      el.addEventListener('click', () => navigate('course-detail', { courseId: el.dataset.openCourse }));
    });
    view.querySelectorAll('[data-enroll]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await api(`/courses/${btn.dataset.enroll}/enroll`, { method: 'POST' });
        toast('Enrolled! Opening course…');
        navigate('course-detail', { courseId: btn.dataset.enroll });
      });
    });
    view.querySelectorAll('[data-unenroll]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Unenroll from this course?')) return;
        await api(`/courses/${btn.dataset.unenroll}/enroll`, { method: 'DELETE' });
        toast('Unenrolled');
        renderStudentCourses();
      });
    });
  }

  function courseCardHtml(c) {
    return `<div class="card course-card" data-open-course="${c.id}">
      <div class="code tabular">${esc(c.code)}</div>
      <div style="margin:4px 0 8px;">${esc(c.title)}</div>
      <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
        <span class="pill pill-pass">${esc(c.level)}</span>
        <button class="btn btn-ghost btn-sm" data-unenroll="${c.id}">Unenroll</button>
      </div>
    </div>`;
  }
  function enrollCardHtml(c, enrolled) {
    return `<div class="card course-card" ${enrolled ? `data-open-course="${c.id}"` : ''}>
      <div class="code tabular">${esc(c.code)}</div>
      <div style="margin:4px 0 8px;">${esc(c.title)}</div>
      ${enrolled
        ? '<span class="pill pill-pass">Enrolled</span>'
        : `<button class="btn btn-accent btn-sm" data-enroll="${c.id}">Enroll — free</button>`}
    </div>`;
  }

  async function renderCourseDetail() {
    const { course } = await api(`/courses/${state.view.courseId}`);
    const { lessons } = await api(`/courses/${state.view.courseId}/lessons`);
    const { liveClass } = await api(`/courses/${state.view.courseId}/live`);
    const subBadge = await subscriptionBadgeHtml();
    view.innerHTML = `
      <div class="page-head">
        <div>
          <div class="muted tabular">${esc(course.department.name)} · ${esc(course.code)}</div>
          <h1>${esc(course.title)}</h1>
        </div>
        <button class="btn btn-ghost btn-sm" id="back-btn">← Back to courses</button>
      </div>
      ${liveClass ? `
        <div class="live-banner">
          <div><span class="live-dot"></span><strong>${esc(liveClass.host.fullName)}</strong> is live now — ${esc(liveClass.title)}</div>
          <button class="btn btn-accent btn-sm" id="join-live-btn">Join live class</button>
        </div>
      ` : ''}
      <div class="card" style="padding:20px; margin-bottom:18px; display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap;">
        <div>
          ${subBadge}
          <div style="font-weight:600; margin-top:8px;">AI Teacher — ask about any topic in this course</div>
          <div class="meta">A real AI lecturer builds a live lesson on the spot, section by section, and answers your questions.</div>
        </div>
        <button class="btn btn-accent" id="start-ai-teacher-btn">Start AI Teacher</button>
      </div>
      <div class="card" style="padding:20px; margin-bottom:18px; display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap;">
        <div>
          <div style="font-weight:600;">Digital Lab — practical demonstrations</div>
          <div class="meta">Step-by-step practicals for this course, curated by your lecturer.</div>
        </div>
        <button class="btn btn-ghost" id="open-lab-btn">Open Digital Lab</button>
      </div>
      <div class="card">
        ${lessons.map((l) => `
          <div class="list-row" data-open-lesson="${l.id}" style="cursor:pointer;">
            <div>
              <div style="font-weight:600;">${esc(l.title)} ${l.locked ? '<span class="pill pill-muted" style="margin-left:6px;">Subscribers only</span>' : ''}</div>
              <div class="meta">${l.isAiTeacher ? 'AI Teacher · narrated lesson' : 'Recorded lesson'}${l.videoUrl || (!l.locked && l.isAiTeacher) ? ' · video available' : ''}</div>
            </div>
            <span class="pill pill-accent">Lesson ${l.order}</span>
          </div>
        `).join('') || '<p class="muted" style="padding:16px;">No lessons uploaded yet.</p>'}
      </div>
    `;
    document.getElementById('back-btn').addEventListener('click', () => navigate('courses'));
    view.querySelectorAll('[data-open-lesson]').forEach((el) => {
      el.addEventListener('click', () => navigate('lesson-player', { courseId: course.id, lessonId: el.dataset.openLesson }));
    });
    document.getElementById('start-ai-teacher-btn').addEventListener('click', () => {
      const topic = prompt(`What topic in ${course.title} should the AI Teacher cover?`);
      if (!topic || !topic.trim()) return;
      startAiTeacherSession(course.id, topic.trim());
    });
    document.getElementById('open-lab-btn').addEventListener('click', () => navigate('lab', { courseId: course.id }));
    const joinLiveBtn = document.getElementById('join-live-btn');
    if (joinLiveBtn) joinLiveBtn.addEventListener('click', () => {
      navigate('live-class', { courseId: course.id, liveClassId: liveClass.id, isHost: false, title: liveClass.title });
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

  // ================= LIVE CLASSES (WebRTC via Socket.IO) =================
  // Star topology: the host holds one RTCPeerConnection per viewer and sends its own
  // camera/mic to each. STUN only (no TURN configured), so some networks may fail to
  // connect -- a known limitation, not a bug to chase down blind.

  const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
  let live = null; // { socket, isHost, localStream, peers: Map(socketId -> RTCPeerConnection), liveClassId }

  function teardownLive() {
    if (!live) return;
    live.peers.forEach((pc) => pc.close());
    live.speakerInboundPcs?.forEach((pc) => pc.close());
    live.relayPcs?.forEach((pc) => pc.close());
    live.relayReceivePcs?.forEach((pc) => pc.close());
    if (live.speakPc) live.speakPc.close();
    if (live.speakMicStream) live.speakMicStream.getTracks().forEach((t) => t.stop());
    if (live.localStream) live.localStream.getTracks().forEach((t) => t.stop());
    if (live.socket) live.socket.disconnect();
    document.getElementById('speaking-banner')?.remove();
    document.querySelectorAll('[id^="relay-audio-"]').forEach((el) => el.remove());
    live = null;
  }

  // Stops the host's local recorder (if any) and resolves with the finished video
  // Blob once the last chunk has flushed -- resolves null when nothing was recorded
  // (unsupported browser, or the recorder was never started) so callers can just
  // check truthiness rather than branching on support themselves.
  function stopRecordingAndGetBlob() {
    return new Promise((resolve) => {
      if (!live || !live.recorder || live.recorder.state === 'inactive') return resolve(null);
      live.recorder.onstop = () => resolve(new Blob(live.recordedChunks, { type: 'video/webm' }));
      live.recorder.stop();
    });
  }

  async function uploadLiveRecording(liveClassId, blob) {
    const fd = new FormData();
    fd.append('video', blob, 'recording.webm');
    try {
      await api(`/live/${liveClassId}/recording`, { method: 'POST', body: fd });
      toast('Class recording saved — students can rewatch and download it from their dashboard.');
    } catch {
      toast('Could not save the class recording.');
    }
  }

  async function renderLiveClass() {
    const { courseId, liveClassId, isHost, title } = state.view;
    view.innerHTML = `
      <div class="page-head">
        <div><span class="pill pill-danger"><span class="live-dot"></span>Live</span><h1 style="margin-top:8px;">${esc(title || 'Live class')}</h1></div>
        <div style="display:flex; align-items:center; gap:10px;">
          <span class="pill pill-muted" id="live-watching-pill">👀 0 watching</span>
          <button class="btn btn-ghost btn-sm" id="leave-btn">${isHost ? 'End class' : 'Leave'}</button>
        </div>
      </div>
      <div class="video-grid" id="video-grid"></div>
      ${isHost ? `
        <div class="card" style="padding:14px 18px; margin-bottom:16px;">
          <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
            <h3 style="font-size:0.95rem;">🙋 Student questions</h3>
            <span class="pill pill-accent" id="live-question-count">0 waiting</span>
          </div>
          <div id="live-question-queue"><p class="muted">No questions yet.</p></div>
        </div>
      ` : ''}
      <div id="live-qa-feed"></div>
      <div class="card live-chat">
        <div class="chat-messages" id="live-chat-messages"></div>
        ${!isHost ? `
          <form class="chat-input-row" id="live-question-form">
            <input type="text" id="live-question-input" placeholder="Ask the lecturer a question…">
            <button class="btn btn-accent btn-sm" type="submit">🙋 Ask</button>
          </form>
        ` : ''}
        <form class="chat-input-row" id="live-chat-form">
          <input type="text" id="live-chat-input" placeholder="Message the class…">
          <button class="btn btn-primary btn-sm" type="submit">Send</button>
        </form>
      </div>
    `;

    teardownLive();
    live = { isHost, liveClassId, peers: new Map(), localStream: null, socket: null, questions: new Map() };

    document.getElementById('leave-btn').addEventListener('click', async () => {
      // Call the REST endpoint directly rather than emitting a socket event right
      // before disconnecting -- that emit can race the disconnect and never reach
      // the server, leaving the class stuck "live" for students.
      if (isHost) {
        const recordingBlob = await stopRecordingAndGetBlob();
        try {
          const { durationMin } = await api(`/live/${liveClassId}/end`, { method: 'POST' });
          if (durationMin) toast(`Class ended — it lasted ${durationMin} minute${durationMin === 1 ? '' : 's'}.`);
        } catch {}
        // Uploading can take a while for a longer class -- fired without waiting so
        // "End class" doesn't stall on it; the upload keeps running in the
        // background after navigate() below since this is a same-page SPA route.
        if (recordingBlob && recordingBlob.size > 0) uploadLiveRecording(liveClassId, recordingBlob);
      }
      teardownLive();
      navigate('course-detail', { courseId });
    });
    document.getElementById('live-chat-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = document.getElementById('live-chat-input');
      if (!input.value.trim()) return;
      live.socket.emit('chat:message', { liveClassId, text: input.value.trim() });
      input.value = '';
    });
    const questionForm = document.getElementById('live-question-form');
    if (questionForm) {
      questionForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const input = document.getElementById('live-question-input');
        if (!input.value.trim()) return;
        live.socket.emit('live:question', { liveClassId, text: input.value.trim() });
        toast('Question sent to the lecturer');
        input.value = '';
      });
    }

    try {
      await setupLiveSocket(isHost, liveClassId, courseId);
    } catch (err) {
      toast(err.message || 'Could not connect to the live class.');
    }
  }

  function renderQuestionQueue() {
    const box = document.getElementById('live-question-queue');
    const countPill = document.getElementById('live-question-count');
    if (!box || !live) return;
    const items = Array.from(live.questions.values());
    countPill.textContent = `${items.length} waiting`;
    box.innerHTML = items.length ? items.map((q) => `
      <div class="list-row" style="align-items:flex-start; flex-direction:column; gap:8px;" data-question-row="${q.id}">
        <div><div style="font-weight:600;">${esc(q.studentName)}</div><p style="margin-top:4px;">${esc(q.text)}</p></div>
        <form class="answer-form" data-answer-for="${q.id}" style="display:flex; gap:8px; width:100%;">
          <input type="text" class="answer-input" placeholder="Type your answer…" style="flex:1;">
          <button class="btn btn-primary btn-sm" type="submit">Answer</button>
        </form>
      </div>
    `).join('') : '<p class="muted">No questions yet.</p>';
    box.querySelectorAll('.answer-form').forEach((form) => {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const input = form.querySelector('.answer-input');
        if (!input.value.trim()) return;
        live.socket.emit('live:answer-question', { liveClassId: live.liveClassId, questionId: form.dataset.answerFor, answer: input.value.trim() });
        live.questions.delete(form.dataset.answerFor);
        renderQuestionQueue();
      });
    });
  }

  function appendQaFeed(studentName, question, answer) {
    const feed = document.getElementById('live-qa-feed');
    if (!feed) return;
    const div = document.createElement('div');
    div.className = 'card';
    div.style.cssText = 'padding:12px 16px; margin-bottom:12px; border-left:3px solid var(--accent);';
    div.innerHTML = `
      <div class="meta">${esc(studentName)} asked${question ? ':' : ' a question'}</div>
      ${question ? `<p style="font-weight:600; margin:4px 0 8px;">${esc(question)}</p>` : ''}
      <div class="meta">Lecturer's answer</div>
      <p>${esc(answer)}</p>
    `;
    feed.prepend(div);
  }

  function addVideoTile(id, label, stream, muted) {
    const grid = document.getElementById('video-grid');
    if (!grid) return;
    let tile = document.getElementById('tile-' + id);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'video-tile';
      tile.id = 'tile-' + id;
      tile.innerHTML = `<video autoplay playsinline ${muted ? 'muted' : ''}></video><span class="label">${esc(label)}</span>`;
      grid.appendChild(tile);
    }
    tile.querySelector('video').srcObject = stream;
  }

  function removeVideoTile(id) {
    document.getElementById('tile-' + id)?.remove();
  }

  // Student-side: a toggle on their one video tile (the lecturer's feed) to grow it
  // beyond its already-larger default size, and shrink it back -- CSS-only (see
  // .video-tile.expanded in app.html), so it works the same on every browser without
  // depending on the Fullscreen API.
  function addExpandToggleButton(tileId) {
    const tile = document.getElementById('tile-' + tileId);
    if (!tile || tile.querySelector('.expand-toggle-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'btn btn-ghost btn-sm expand-toggle-btn';
    btn.textContent = '⤢ Expand';
    btn.addEventListener('click', () => {
      const expanded = tile.classList.toggle('expanded');
      btn.textContent = expanded ? '⤡ Collapse' : '⤢ Expand';
    });
    tile.appendChild(btn);
  }

  // Host-side: one button per student tile to call them on to speak. While a student
  // is speaking, the SAME button turns into "Stop speaking" (still clickable, not
  // disabled) so the lecturer always has a direct way to cut them off and carry on
  // teaching -- rather than depending entirely on the student's own client correctly
  // signaling live:stop-speaking (a dropped signal, e.g. around a brief reconnect,
  // previously left the lecturer with no recourse at all). resetInviteToSpeakButton()
  // (also called on live:speaker-stopped, from either side) puts it back to "Invite".
  function addInviteToSpeakButton(studentSocketId) {
    const tile = document.getElementById('tile-' + studentSocketId);
    if (!tile || tile.querySelector('.invite-speak-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'btn btn-accent btn-sm invite-speak-btn';
    btn.dataset.speaking = 'false';
    btn.style.cssText = 'position:absolute; bottom:6px; right:6px; z-index:2;';
    btn.textContent = '🎤 Invite to speak';
    btn.addEventListener('click', () => {
      if (btn.dataset.speaking === 'true') {
        live.socket.emit('live:stop-speaking', { liveClassId: live.liveClassId, studentSocketId });
        resetInviteToSpeakButton(studentSocketId);
      } else {
        live.socket.emit('live:invite-to-speak', { liveClassId: live.liveClassId, studentSocketId });
        btn.textContent = '🛑 Stop speaking';
        btn.dataset.speaking = 'true';
      }
    });
    tile.appendChild(btn);
  }
  function resetInviteToSpeakButton(studentSocketId) {
    const btn = document.querySelector(`#tile-${studentSocketId} .invite-speak-btn`);
    if (btn) { btn.textContent = '🎤 Invite to speak'; btn.dataset.speaking = 'false'; btn.disabled = false; }
  }

  // Student-side: plays one classmate's relayed audio through a hidden <audio>
  // element keyed by their socket id, so a second speaker later gets its own element
  // instead of stealing the first one's.
  function playRelayedAudio(speakerId, stream) {
    let el = document.getElementById('relay-audio-' + speakerId);
    if (!el) {
      el = document.createElement('audio');
      el.id = 'relay-audio-' + speakerId;
      el.autoplay = true;
      el.hidden = true;
      document.body.appendChild(el);
    }
    el.srcObject = stream;
  }
  function removeRelayedAudio(speakerId) {
    document.getElementById('relay-audio-' + speakerId)?.remove();
  }

  // Student-side: banner shown while this student's own mic is live to the class,
  // with a button to end it themselves rather than waiting for the teacher to.
  function showSpeakingBanner() {
    if (document.getElementById('speaking-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'speaking-banner';
    banner.className = 'live-banner';
    banner.style.cssText = 'position:fixed; bottom:20px; left:50%; transform:translateX(-50%); z-index:80;';
    banner.innerHTML = `<span>🎤 You're speaking to the class</span><button class="btn btn-ghost btn-sm" id="stop-speaking-btn">Stop speaking</button>`;
    document.body.appendChild(banner);
    document.getElementById('stop-speaking-btn').addEventListener('click', () => {
      live.socket.emit('live:stop-speaking', { liveClassId: live.liveClassId, studentSocketId: live.socket.id });
      stopSpeaking();
    });
  }
  function stopSpeaking() {
    document.getElementById('speaking-banner')?.remove();
    if (live.speakMicStream) { live.speakMicStream.getTracks().forEach((t) => t.stop()); live.speakMicStream = null; }
    if (live.speakPc) { live.speakPc.close(); live.speakPc = null; }
  }

  function appendLiveChat(from, role, text) {
    const box = document.getElementById('live-chat-messages');
    if (!box) return;
    const div = document.createElement('div');
    div.className = 'chat-msg';
    div.innerHTML = `<div class="sender">${esc(from)}${role !== 'STUDENT' ? ' · Lecturer' : ''}</div>${esc(text)}`;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  async function setupLiveSocket(isHost, liveClassId, courseId) {
    const socket = io('/live', { auth: { token: state.token } });
    live.socket = socket;

    socket.on('live:error', (err) => {
      toast(err.message);
      if (err.code === 'SUBSCRIPTION_REQUIRED') { teardownLive(); renderUpgradePrompt(err.message); }
    });
    socket.on('chat:message', ({ from, role, text }) => appendLiveChat(from, role, text));
    socket.on('live:ended', ({ durationMin } = {}) => {
      toast(durationMin ? `The live class has ended — it lasted ${durationMin} minute${durationMin === 1 ? '' : 's'}.` : 'The live class has ended.');
      teardownLive();
      navigate('course-detail', { courseId });
    });
    socket.on('live:watching-count', ({ count }) => {
      const pill = document.getElementById('live-watching-pill');
      if (pill) pill.textContent = `👀 ${count} watching`;
    });
    socket.on('live:room-info', ({ title: roomTitle }) => {
      if (roomTitle) { const h1 = view.querySelector('.page-head h1'); if (h1) h1.textContent = roomTitle; }
    });
    socket.on('live:qa', ({ studentName, question, answer }) => appendQaFeed(studentName, question, answer));
    socket.on('live:new-question', (q) => { live.questions.set(q.id, q); renderQuestionQueue(); });
    socket.on('live:questions-sync', ({ questions }) => {
      live.questions = new Map((questions || []).map((q) => [q.id, q]));
      renderQuestionQueue();
    });
    socket.on('live:question-received', () => {});

    // Socket.IO auto-reconnects on its own after a drop (WiFi blip, tab backgrounding),
    // opening a new socket id each time -- re-running the join handshake on every
    // 'connect' (not just the first) is what lets the server's reconnect grace period
    // actually work, instead of the class looking joined client-side but not
    // server-side after a reconnect.
    socket.on('connect', () => {
      if (isHost) socket.emit('teacher:join', { liveClassId });
      else socket.emit('student:join', { liveClassId });
    });

    if (isHost) {
      live.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      live.speakerInboundPcs = new Map(); // speaking student's socket id -> pc receiving their mic
      live.relayPcs = new Map(); // "speakerId:listenerId" -> pc sending that speaker's audio on to one listener
      addVideoTile('self', 'You (host)', live.localStream, true);

      // Record the lecturer's own camera/mic locally throughout the class -- there's
      // no central media server that sees every stream (see the star-topology note
      // above), so this is the only feed worth recording. Uploaded once the class
      // ends (see the leave-btn handler) so students can rewatch/download it from
      // their dashboard. Recording is best-effort: unsupported browsers just skip it
      // rather than blocking the live class itself.
      live.recordedChunks = [];
      try {
        live.recorder = new MediaRecorder(live.localStream, { mimeType: 'video/webm;codecs=vp8,opus' });
        live.recorder.ondataavailable = (e) => { if (e.data.size) live.recordedChunks.push(e.data); };
        live.recorder.start();
      } catch {
        live.recorder = null;
      }

      socket.on('student:joined', async ({ studentSocketId, studentName }) => {
        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        live.peers.set(studentSocketId, pc);
        live.localStream.getTracks().forEach((track) => pc.addTrack(track, live.localStream));
        pc.onicecandidate = (e) => { if (e.candidate) socket.emit('webrtc:ice-candidate', { to: studentSocketId, candidate: e.candidate }); };
        pc.onconnectionstatechange = () => { if (['disconnected', 'closed', 'failed'].includes(pc.connectionState)) removeVideoTile(studentSocketId); };
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('webrtc:offer', { to: studentSocketId, offer });
        addVideoTile(studentSocketId, studentName + ' (joining…)', new MediaStream());
        addInviteToSpeakButton(studentSocketId);
      });
      socket.on('webrtc:answer', async ({ from, answer, purpose, speakerId }) => {
        if (purpose === 'relay') { const pc = live.relayPcs.get(`${speakerId}:${from}`); if (pc) await pc.setRemoteDescription(answer); return; }
        const pc = live.peers.get(from);
        if (pc) await pc.setRemoteDescription(answer);
      });
      socket.on('webrtc:ice-candidate', async ({ from, candidate, purpose, speakerId }) => {
        if (purpose === 'speak') { const pc = live.speakerInboundPcs.get(from); if (pc) { try { await pc.addIceCandidate(candidate); } catch {} } return; }
        if (purpose === 'relay') { const pc = live.relayPcs.get(`${speakerId}:${from}`); if (pc) { try { await pc.addIceCandidate(candidate); } catch {} } return; }
        const pc = live.peers.get(from);
        if (pc) { try { await pc.addIceCandidate(candidate); } catch {} }
      });

      // A student's "invite to speak" mic connection arrives as an ordinary offer,
      // distinguished only by purpose:'speak' -- a fresh, separate connection from
      // their main (receive-only) video pc, so accepting it can never disturb that
      // already-working connection. Once their audio arrives, it's relayed out to
      // every OTHER connected student via its own small relay connection each,
      // mirroring PassNow's "the whole class hears the student who's speaking"
      // without renegotiating any of the existing per-student video connections.
      socket.on('webrtc:offer', async ({ from: studentSocketId, offer, purpose }) => {
        if (purpose !== 'speak') return;
        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        live.speakerInboundPcs.set(studentSocketId, pc);
        pc.onicecandidate = (e) => { if (e.candidate) socket.emit('webrtc:ice-candidate', { to: studentSocketId, candidate: e.candidate, purpose: 'speak' }); };
        pc.ontrack = (e) => {
          const audioTrack = e.streams[0].getAudioTracks()[0];
          if (!audioTrack) return;
          // The lecturer invited this student to speak specifically to hear them --
          // relaying only to the OTHER students (below) and never playing it back
          // for the host themselves left the lecturer unable to hear anyone at all.
          playRelayedAudio(studentSocketId, e.streams[0]);
          live.peers.forEach((_listenerMainPc, listenerId) => {
            if (listenerId === studentSocketId) return;
            relaySpeakerToListener(studentSocketId, listenerId, audioTrack, e.streams[0]);
          });
        };
        await pc.setRemoteDescription(offer);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('webrtc:answer', { to: studentSocketId, answer, purpose: 'speak' });
      });

      function relaySpeakerToListener(speakerId, listenerId, audioTrack, stream) {
        const key = `${speakerId}:${listenerId}`;
        if (live.relayPcs.has(key)) return;
        const relayPc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        live.relayPcs.set(key, relayPc);
        relayPc.addTrack(audioTrack, stream);
        relayPc.onicecandidate = (e) => { if (e.candidate) socket.emit('webrtc:ice-candidate', { to: listenerId, candidate: e.candidate, purpose: 'relay', speakerId }); };
        (async () => {
          const offer = await relayPc.createOffer();
          await relayPc.setLocalDescription(offer);
          socket.emit('webrtc:offer', { to: listenerId, offer, purpose: 'relay', speakerId });
        })();
      }

      socket.on('live:speaker-stopped', ({ studentSocketId }) => {
        live.speakerInboundPcs.get(studentSocketId)?.close();
        live.speakerInboundPcs.delete(studentSocketId);
        live.relayPcs.forEach((pc, key) => {
          if (key.startsWith(`${studentSocketId}:`)) { pc.close(); live.relayPcs.delete(key); }
        });
        removeRelayedAudio(studentSocketId);
        resetInviteToSpeakButton(studentSocketId);
      });
    } else {
      live.relayReceivePcs = new Map(); // speakerId -> pc receiving that speaker's relayed audio
      live.speakPc = null; // this student's own mic connection, only while invited to speak

      socket.on('webrtc:offer', async ({ from, offer, purpose, speakerId }) => {
        // A relayed classmate's audio arrives as its own offer, tagged separately
        // from the main host<->me video offer -- a dedicated receiving connection
        // per speaker, so it can never interfere with the always-on video pc below.
        if (purpose === 'relay') {
          const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
          live.relayReceivePcs.set(speakerId, pc);
          pc.onicecandidate = (e) => { if (e.candidate) socket.emit('webrtc:ice-candidate', { to: from, candidate: e.candidate, purpose: 'relay', speakerId }); };
          pc.ontrack = (e) => playRelayedAudio(speakerId, e.streams[0]);
          await pc.setRemoteDescription(offer);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit('webrtc:answer', { to: from, answer, purpose: 'relay', speakerId });
          return;
        }
        live.hostSocketId = from; // needed later to send the "invite to speak" mic offer
        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        live.peers.set(from, pc);
        pc.onicecandidate = (e) => { if (e.candidate) socket.emit('webrtc:ice-candidate', { to: from, candidate: e.candidate }); };
        pc.ontrack = (e) => { addVideoTile('host', 'Lecturer', e.streams[0], false); addExpandToggleButton('host'); };
        await pc.setRemoteDescription(offer);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('webrtc:answer', { to: from, answer });
      });
      socket.on('webrtc:ice-candidate', async ({ from, candidate, purpose, speakerId }) => {
        if (purpose === 'relay') { const pc = live.relayReceivePcs.get(speakerId); if (pc) { try { await pc.addIceCandidate(candidate); } catch {} } return; }
        const pc = live.peers.get(from);
        if (pc) { try { await pc.addIceCandidate(candidate); } catch {} }
      });

      // Invited by the teacher to speak: opens this student's mic on a fresh,
      // separate connection to the host (never touching the always-on video pc
      // above), so joining/leaving speaking never risks the video feed.
      socket.on('live:invited-to-speak', async () => {
        try {
          const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
          live.speakPc = pc;
          live.speakMicStream = micStream;
          micStream.getTracks().forEach((t) => pc.addTrack(t, micStream));
          pc.onicecandidate = (e) => { if (e.candidate) socket.emit('webrtc:ice-candidate', { to: live.hostSocketId, candidate: e.candidate, purpose: 'speak' }); };
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit('webrtc:offer', { to: live.hostSocketId, offer, purpose: 'speak' });
          showSpeakingBanner();
        } catch {
          toast('Could not access your microphone.');
        }
      });
      socket.on('webrtc:answer', async ({ answer, purpose }) => {
        if (purpose === 'speak' && live.speakPc) await live.speakPc.setRemoteDescription(answer);
      });
      socket.on('live:speaker-stopped', ({ studentSocketId }) => {
        if (studentSocketId === socket.id) stopSpeaking();
        const relayPc = live.relayReceivePcs.get(studentSocketId);
        if (relayPc) { relayPc.close(); live.relayReceivePcs.delete(studentSocketId); }
        removeRelayedAudio(studentSocketId);
      });
    }
  }

  // ================= PROGRESS (points, streak, badges — no leaderboard) =================

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

  // ================= ADMISSION STATUS (student self-view + admin view) =================
  // Same render function for both: state.view.studentId present means an admin is
  // viewing a specific student (editable -- year of admission, class position,
  // disciplinary records); absent means a student viewing their own (read-only).
  async function renderAdmissionStatus() {
    const isAdminView = !!state.view.studentId;
    const data = isAdminView
      ? await api(`/admin/students/${state.view.studentId}/admission-status`)
      : await api('/students/me/admission-status');

    const statRow = (label, done, missed, total) => `
      <div class="card course-card"><div class="code">${done}/${total}</div><div class="meta">${esc(label)} done${missed ? ` · ${missed} missed` : ''}</div></div>
    `;

    view.innerHTML = `
      <div class="page-head">
        <h1>Admission Status${isAdminView ? ` — ${esc(data.fullName)}` : ''}</h1>
        <button class="btn btn-ghost btn-sm" id="back-btn">← Back</button>
      </div>

      <div class="card" style="padding:24px; margin-bottom:22px;">
        <div class="id-grid">
          <div><div class="meta">Full name</div><div style="font-weight:600;">${esc(data.fullName)}</div></div>
          <div><div class="meta">Matric number</div><div class="tabular">${esc(data.matricNumber || '—')}</div></div>
          <div><div class="meta">Email</div><div>${esc(data.email)}</div></div>
          <div><div class="meta">Phone</div><div>${esc(data.phone || '—')}</div></div>
          <div><div class="meta">Department</div><div>${esc(data.department || '—')}</div></div>
          <div><div class="meta">Current level</div><div>${esc(data.level || '—')}</div></div>
          <div><div class="meta">Position held</div><div>${esc(data.classPosition || '—')}</div></div>
          <div><div class="meta">Account status</div><div>${statusPillHtml(data.status)}</div></div>
          <div><div class="meta">Year of admission</div><div class="tabular">${data.yearOfAdmission || '—'}</div></div>
          <div><div class="meta">Expected graduation year</div><div class="tabular">${data.expectedGraduationYear || '—'} <span class="muted" style="font-size:0.75rem;">(3-year programme assumed)</span></div></div>
          <div><div class="meta">CGPA</div><div class="tabular" style="font-weight:600;">${data.cgpa != null ? data.cgpa : '—'}</div></div>
          <div><div class="meta">Disciplinary issues</div><div>${data.disciplinaryIssueCount}</div></div>
        </div>
      </div>

      <h3 style="margin-bottom:12px; font-size:1rem;">Academic activity</h3>
      <div class="grid-cards" style="margin-bottom:26px;">
        ${statRow('Semester exams', data.exams.done, data.exams.missed, data.exams.total)}
        ${statRow('Tests / CA', data.tests.done, data.tests.missed, data.tests.total)}
        ${statRow('Assignments', data.assignments.done, data.assignments.missed, data.assignments.total)}
      </div>

      ${isAdminView ? `
        <h3 style="margin-bottom:12px; font-size:1rem;">Update admission details</h3>
        <form id="admission-details-form" class="card" style="padding:20px; margin-bottom:26px; display:flex; gap:12px; flex-wrap:wrap; align-items:flex-end;">
          <div class="field" style="margin-bottom:0;"><label>Year of admission</label><input type="number" id="admission-year" value="${data.yearOfAdmission || ''}" placeholder="e.g. 2024" style="width:140px;"></div>
          <div class="field" style="margin-bottom:0;"><label>Position held</label><input type="text" id="admission-position" value="${esc(data.classPosition || '')}" placeholder="e.g. Class Governor" style="width:200px;"></div>
          <button class="btn btn-primary btn-sm" type="submit">Save</button>
        </form>
      ` : ''}

      <h3 style="margin-bottom:12px; font-size:1rem;">Disciplinary report</h3>
      ${isAdminView ? `
        <form id="disciplinary-form" class="card" style="padding:16px 20px; margin-bottom:16px; display:flex; gap:10px; flex-wrap:wrap; align-items:flex-end;">
          <div class="field" style="margin-bottom:0; flex:1; min-width:160px;"><label>Title</label><input type="text" id="disciplinary-title" required placeholder="e.g. Exam malpractice"></div>
          <div class="field" style="margin-bottom:0; flex:2; min-width:220px;"><label>Description</label><input type="text" id="disciplinary-description" placeholder="Optional detail"></div>
          <button class="btn btn-accent btn-sm" type="submit">Add record</button>
        </form>
      ` : ''}
      <div class="card">
        ${data.disciplinaryRecords.map((r) => `
          <div class="list-row" style="align-items:flex-start;">
            <div>
              <div style="font-weight:600;">${esc(r.title)}</div>
              ${r.description ? `<div class="meta">${esc(r.description)}</div>` : ''}
              <div class="meta tabular">${new Date(r.createdAt).toLocaleDateString()}</div>
            </div>
            <div style="display:flex; align-items:center; gap:8px;">
              <span class="pill ${r.status === 'RESOLVED' ? 'pill-pass' : 'pill-danger'}">${esc(r.status)}</span>
              ${isAdminView && r.status !== 'RESOLVED' ? `<button class="btn btn-ghost btn-sm" data-resolve-disciplinary="${r.id}">Resolve</button>` : ''}
            </div>
          </div>
        `).join('') || '<p class="muted" style="padding:16px;">No disciplinary issues on record.</p>'}
      </div>
    `;

    document.getElementById('back-btn').addEventListener('click', () => {
      if (isAdminView) navigate('admin-directory-detail', { directoryType: 'STUDENT', userId: state.view.studentId });
      else navigate('my-dashboard');
    });

    const detailsForm = document.getElementById('admission-details-form');
    if (detailsForm) detailsForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api(`/admin/students/${state.view.studentId}/admission-details`, {
          method: 'POST',
          body: {
            yearOfAdmission: document.getElementById('admission-year').value,
            classPosition: document.getElementById('admission-position').value,
          },
        });
        toast('Saved');
        render();
      } catch (err) { toast(err.message); }
    });

    const disciplinaryForm = document.getElementById('disciplinary-form');
    if (disciplinaryForm) disciplinaryForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api(`/admin/students/${state.view.studentId}/disciplinary-records`, {
          method: 'POST',
          body: {
            title: document.getElementById('disciplinary-title').value,
            description: document.getElementById('disciplinary-description').value,
          },
        });
        toast('Record added');
        render();
      } catch (err) { toast(err.message); }
    });

    view.querySelectorAll('[data-resolve-disciplinary]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await api(`/admin/disciplinary-records/${btn.dataset.resolveDisciplinary}/resolve`, { method: 'POST' });
        toast('Marked resolved');
        render();
      });
    });
  }

  // ================= DIGITAL ID / STUDENT PROFILE =================

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
  async function renderStudentResultsHub() {
    const [{ results }, { results: formalResults }] = await Promise.all([
      api('/students/me/results'),
      api('/students/me/formal-results'),
    ]);
    view.innerHTML = `
      <div class="page-head"><h1>Results</h1></div>
      <h3 style="margin-bottom:10px; font-size:1rem;">Tests &amp; assessments</h3>
      <div class="card" style="overflow-x:auto; margin-bottom:26px;">
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
      <h3 style="margin-bottom:10px; font-size:1rem;">Formal results (published by lecturers)</h3>
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
    view.querySelectorAll('[data-open-result]').forEach((row) => {
      row.addEventListener('click', () => navigate('take-assessment', { assessmentId: row.dataset.openResult, backTo: 'student-results' }));
    });
  }

  async function renderDigitalId() {
    if (state.user.role === 'LECTURER') return renderLecturerDigitalId();
    if (state.user.isIndividual) return renderIndividualDigitalId();
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
          <div class="field"><label>Current password</label><input type="password" id="pw-current" required></div>
          <div class="field"><label>New password</label><input type="password" id="pw-new" required minlength="6"></div>
          <div class="field"><label>Confirm new password</label><input type="password" id="pw-confirm" required minlength="6"></div>
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

  async function renderTranscript() {
    const data = await api('/students/me/transcript');
    view.innerHTML = `
      <div class="page-head no-print"><h1>Official Transcript</h1><button class="btn btn-ghost btn-sm" id="back-btn">← Back</button></div>
      <div class="card" style="padding:32px;">
        <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:20px;">
          <div>
            <div style="font-family:var(--font-display); font-size:1.3rem;">Edo College of Education</div>
            <div class="muted">Official academic transcript — Learnza</div>
          </div>
          <div class="muted tabular">Issued ${new Date(data.issuedAt).toLocaleDateString()}</div>
        </div>
        <div class="id-grid" style="margin-bottom:20px;">
          <div><div class="meta">Student</div><div style="font-weight:600;">${esc(state.user.fullName)}</div></div>
          <div><div class="meta">Matric number</div><div class="tabular" style="font-weight:600;">${esc(state.user.matricNumber || '—')}</div></div>
        </div>
        <table class="data-table">
          <thead><tr><th>Course</th><th>Assessment</th><th>Score</th></tr></thead>
          <tbody>
            ${data.results.map((r) => `<tr><td class="tabular">${r.courseCode ? `${esc(r.courseCode)} — ` : ''}${esc(r.courseTitle)}</td><td>${esc(r.assessmentTitle)}</td><td class="tabular">${r.score}/${r.total}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No results on record.</td></tr>'}
          </tbody>
        </table>
        <button class="btn btn-primary no-print" style="margin-top:20px;" id="print-btn">Print / Save as PDF</button>
      </div>
    `;
    document.getElementById('back-btn').addEventListener('click', () => navigate('digital-id'));
    document.getElementById('print-btn').addEventListener('click', () => window.print());
  }

  // ================= STUDENT: ASSIGNMENTS, ATTENDANCE HISTORY, PAST QUESTIONS =================

  // ---------- My Dashboard ----------
  // Aggregates every enrolled course's assignments, attendance and recent test scores
  // in one place, so a student never has to hunt through each course individually.
  // Dashboard list sections (Assignments, Attendance, Results, Lessons, Notifications)
  // all follow the same "show 3, View more reveals the rest" pattern.
  const DASH_LIMIT = 3;

  // A visual preview of the student dashboard for an admin/lecturer, without leaving
  // their own session or losing their login (the previous version signed them out to
  // the public site instead, which turned out not to be what was wanted). There's no
  // real student data behind an admin/lecturer account, so it's shown with their own
  // name/school -- the same identity information they already see on their own
  // dashboard -- rather than fabricating a fake student. "Return to Dashboard" goes
  // straight back to whichever dashboard actually matches their real role.
  async function renderPreviewStudentDashboard() {
    const u = state.user;
    view.innerHTML = `
      <div class="page-head">
        <h1>Student Dashboard (Preview)</h1>
        <button class="btn btn-ghost btn-sm" id="return-dash-btn">← Return to Dashboard</button>
      </div>
      <p class="muted" style="margin-bottom:18px;">This is what a student sees on logging in, shown here with your own details since there's no student data on your account to display instead.</p>
      <div class="card" style="padding:20px; margin-bottom:22px; display:flex; align-items:center; gap:16px;">
        ${selfAvatarHtml('avatar-preview-dash')}
        <div>
          <div>${esc(u.fullName)} · ${esc(u.role.charAt(0) + u.role.slice(1).toLowerCase())}</div>
          <div>${state.school ? [state.school.name, state.school.location].filter(Boolean).map(esc).join(', ') : ''}</div>
        </div>
      </div>
      <div class="grid-cards" style="margin-bottom:26px;">
        <div class="card course-card"><div class="code">—</div><div class="meta">Assignments pending</div></div>
        <div class="card course-card"><div class="code">—</div><div class="meta">Attendance rate</div></div>
        <div class="card course-card"><div class="code">—</div><div class="meta">Recent test average</div></div>
      </div>
      <p class="muted">A real student's dashboard also lists their courses, assignments, attendance history, and test results below here.</p>
    `;
    wireSelfAvatarUpload('avatar-preview-dash');
    document.getElementById('return-dash-btn').addEventListener('click', () => navigate(defaultScreenFor(u.role)));
  }

  async function renderMyDashboard() {
    const isIndividual = state.user.isIndividual;
    const [{ assignments, attendance, recentResults, lessons, individualAssessments }, { notifications }] = await Promise.all([
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

      <h3 id="dash-lessons" style="margin-bottom:10px; font-size:1rem;">Lessons</h3>
      ${dashSection('lessons', lessons || [], lessonRowHtml, 'No lecturer-uploaded lessons yet.')}
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
        <div class="meta" style="margin-bottom:6px;">Instructions</div>
        <p style="white-space:pre-wrap;">${esc(assignment.instructions)}</p>
      </div>

      <h3 style="margin-bottom:12px; font-size:1rem;">Your submission</h3>
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
  async function renderAdminLabQueue() {
    const { demonstrations } = await api('/admin/lab');
    view.innerHTML = `
      <div class="page-head"><h1>Digital Lab</h1></div>
      <p class="muted" style="margin-bottom:18px;">Records of every practical — lecturer-curated and AI-generated alike. Student access to AI-generated practicals is based on their subscription, not admin approval.</p>
      ${demonstrations.map((d) => `
        <div class="card" style="padding:20px; margin-bottom:14px;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap;">
            <div>
              <div class="muted tabular">${esc(d.course.code)} · ${d.source === 'AI_GENERATED' ? `AI-generated, requested by ${esc(d.author ? d.author.fullName : 'a student')}` : 'Lecturer-curated'}</div>
              <div style="font-weight:600; margin-top:4px;">${esc(d.title)}</div>
              <div class="meta">${esc(d.description)}</div>
            </div>
            <span class="pill ${d.source === 'AI_GENERATED' ? 'pill-accent' : 'pill-pass'}">${d.source === 'AI_GENERATED' ? 'AI-generated' : 'Curated'}</span>
          </div>
          <ol style="margin:14px 0 0; padding-left:20px; display:flex; flex-direction:column; gap:6px;">
            ${d.steps.map((s) => `<li><strong>${esc(s.title)}</strong> — ${esc(s.instruction)}<br><span class="meta">Expected: ${esc(s.expectedResult)}</span></li>`).join('')}
          </ol>
          <div style="margin-top:14px; padding-top:14px; border-top:1px solid var(--line);">
            <div class="meta" style="margin-bottom:8px;">Students who did this practical (${d.attempts.length})</div>
            ${d.attempts.length ? `
              <div style="display:flex; flex-direction:column; gap:4px;">
                ${d.attempts.map((a) => `<div class="meta">${esc(a.student.fullName)}${a.student.matricNumber ? ` (${esc(a.student.matricNumber)})` : ''} · ${new Date(a.startedAt).toLocaleDateString()}</div>`).join('')}
              </div>
            ` : '<div class="meta">No one yet.</div>'}
          </div>
        </div>
      `).join('') || '<p class="muted">No lab activity yet.</p>'}
    `;
  }

  // ================= AI RESEARCH ASSISTANT =================

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

  async function renderLibrary(isLecturer) {
    if (!isLecturer && state.user.isIndividual) return renderIndividualLibrary();
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

  function renderLecturerSemesterExam() {
    return renderAssessments(true, { heading: 'Semester Exam', typeFilter: ['SEMESTER_EXAM'], defaultType: 'SEMESTER_EXAM', allowedTypes: ['SEMESTER_EXAM'] });
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

  // ================= LECTURER =================

  async function ensureLectCourses() {
    const { departments } = await api(`/departments?schoolId=${state.user.schoolId}`);
    const myDept = departments.find((d) => d.id === state.user.departmentId) || departments[0];
    const courses = myDept ? (await api(`/departments/${myDept.id}/courses`)).courses : [];
    window.__lectCourses = courses;
    return { department: myDept, courses };
  }

  async function renderLecturerCourses() {
    const { department, courses } = await ensureLectCourses();
    const counts = await Promise.all(courses.map((c) => api(`/courses/${c.id}/enrollment-count`).catch(() => ({ count: 0 }))));
    view.innerHTML = `
      <div class="page-head">
        <h1>My Courses</h1>
        <button class="btn btn-primary btn-sm" id="add-course-btn">+ Add course</button>
      </div>
      <p class="muted" style="margin-bottom:18px;">${department ? esc(department.name) : ''} department</p>
      <div class="grid-cards">
        ${courses.map((c, i) => `
          <div class="card course-card" data-open="${c.id}">
            <div class="code tabular">${esc(c.code)}</div>
            <div style="margin:4px 0 8px;">${esc(c.title)}</div>
            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
              <span class="pill pill-pass">${esc(c.level)}</span>
              <span class="pill">${counts[i].count} enrolled</span>
            </div>
          </div>
        `).join('') || '<p class="muted">No courses in your department yet — add one to get started.</p>'}
      </div>
    `;
    view.querySelectorAll('[data-open]').forEach((el) => {
      el.addEventListener('click', () => navigate('lect-lessons', { courseId: el.dataset.open }));
    });
    view.querySelector('#add-course-btn').addEventListener('click', () => openAddCourseDialog(department));
  }

  function openAddCourseDialog(department) {
    const container = document.createElement('div');
    container.className = 'card';
    container.style.cssText = 'position:fixed; inset:0; margin:auto; width:min(480px,92vw); height:fit-content; max-height:86vh; overflow-y:auto; padding:24px; z-index:200;';
    container.innerHTML = `
      <h3 style="margin-bottom:14px;">Add a course</h3>
      <p class="muted" style="font-size:13px; margin-bottom:14px;">Department: ${department ? esc(department.name) : '—'}</p>
      <div class="field"><label>Course code</label><input type="text" id="ac-code" placeholder="e.g. CSC 201" required></div>
      <div class="field"><label>Course title</label><input type="text" id="ac-title" placeholder="e.g. Data Structures" required></div>
      <div class="field"><label>Level</label><select id="ac-level"><option>NCE 1</option><option>NCE 2</option><option>NCE 3</option></select></div>
      <div class="field"><label>Semester</label><select id="ac-semester"><option>First</option><option>Second</option></select></div>
      <div style="display:flex; gap:10px; margin-top:10px;">
        <button class="btn btn-primary" id="ac-save">Create course</button>
        <button class="btn btn-ghost" id="ac-cancel">Cancel</button>
      </div>
    `;
    const backdrop = document.createElement('div');
    backdrop.style.cssText = 'position:fixed; inset:0; background:rgba(20,32,51,0.45); z-index:190;';
    document.body.appendChild(backdrop);
    document.body.appendChild(container);
    function close() { backdrop.remove(); container.remove(); }
    container.querySelector('#ac-cancel').addEventListener('click', close);
    container.querySelector('#ac-save').addEventListener('click', async () => {
      const code = container.querySelector('#ac-code').value.trim();
      const title = container.querySelector('#ac-title').value.trim();
      if (!code || !title) { toast('Course code and title are required'); return; }
      try {
        await api('/courses', {
          method: 'POST',
          body: {
            departmentId: department.id,
            code,
            title,
            level: container.querySelector('#ac-level').value,
            semester: container.querySelector('#ac-semester').value,
          },
        });
        toast('Course created');
        close();
        renderLecturerCourses();
      } catch (err) { toast(err.message); }
    });
  }

  async function renderLecturerLessons() {
    const { course } = await api(`/courses/${state.view.courseId}`);
    const { lessons } = await api(`/courses/${course.id}/lessons`);
    view.innerHTML = `
      <div class="page-head">
        <div><div class="muted tabular">${esc(course.code)}</div><h1>${esc(course.title)}</h1></div>
        <button class="btn btn-ghost btn-sm" id="back-btn">← Back to courses</button>
      </div>
      <div class="card" style="padding:20px; margin-bottom:18px; display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap;">
        <div>
          <div style="font-weight:600;">Teach this course live</div>
          <div class="meta">Students with an active subscription can join and watch in real time.</div>
        </div>
        <button class="btn btn-accent" id="go-live-btn">🔴 Go live</button>
      </div>
      <div class="card" style="padding:20px; margin-bottom:18px; display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap;">
        <div>
          <div style="font-weight:600;">Digital Lab — practical demonstrations</div>
          <div class="meta">Add curated practicals, or review AI-drafted ones students have requested.</div>
        </div>
        <button class="btn btn-ghost" id="open-lab-btn">Open Digital Lab</button>
      </div>
      <div class="card" style="padding:20px; margin-bottom:22px;">
        <h3 style="margin-bottom:12px; font-size:1rem;">Add a recorded lesson (subscribers only)</h3>
        <form id="lesson-form">
          <div class="field"><label>Title</label><input type="text" id="lsn-title" required></div>
          <div class="field"><label>Order</label><input type="number" id="lsn-order" value="${lessons.length + 1}" required></div>
          <div class="field"><label>Narration script (read aloud in the lesson player)</label><textarea id="lsn-script" required></textarea></div>
          <div class="field"><label>Recorded video (optional — upload from your device)</label><input type="file" id="lsn-video" accept="video/*"></div>
          <button class="btn btn-primary" type="submit" id="lsn-submit-btn">Publish lesson</button>
        </form>
      </div>
      <div class="card">
        ${lessons.map((l) => `
          <div class="list-row">
            <div><div style="font-weight:600;">${esc(l.title)}</div><div class="meta">Lesson ${l.order}${l.videoUrl ? ' · has video' : ''}</div></div>
            <button class="btn btn-ghost btn-sm" data-delete="${l.id}">Delete</button>
          </div>
        `).join('') || '<p class="muted" style="padding:16px;">No lessons yet.</p>'}
      </div>
    `;
    document.getElementById('back-btn').addEventListener('click', () => navigate('lect-courses'));
    document.getElementById('open-lab-btn').addEventListener('click', () => navigate('lab', { courseId: course.id }));
    document.getElementById('go-live-btn').addEventListener('click', async () => {
      const title = prompt('Title your live class:', `${course.code} live session`);
      if (!title || !title.trim()) return;
      try {
        const { liveClass } = await api(`/courses/${course.id}/live/start`, { method: 'POST', body: { title: title.trim() } });
        navigate('live-class', { courseId: course.id, liveClassId: liveClass.id, isHost: true, title: liveClass.title });
      } catch (err) {
        toast(err.message);
      }
    });
    document.getElementById('lesson-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData();
      fd.append('title', document.getElementById('lsn-title').value);
      fd.append('order', document.getElementById('lsn-order').value);
      fd.append('script', document.getElementById('lsn-script').value);
      const videoFile = document.getElementById('lsn-video').files[0];
      if (videoFile) fd.append('video', videoFile);

      const submitBtn = document.getElementById('lsn-submit-btn');
      submitBtn.disabled = true;
      submitBtn.textContent = videoFile ? 'Uploading video…' : 'Publishing…';
      try {
        const { storage } = await api(`/courses/${course.id}/lessons`, { method: 'POST', body: fd });
        toast('Lesson published');
        if (storage === 'local-disk') toast('Note: cloud storage isn\'t configured yet, so this video may not survive the next deploy.');
        render();
      } catch (err) {
        toast(err.message);
        submitBtn.disabled = false;
        submitBtn.textContent = 'Publish lesson';
      }
    });
    view.querySelectorAll('[data-delete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this lesson?')) return;
        await api(`/lessons/${btn.dataset.delete}`, { method: 'DELETE' });
        render();
      });
    });
  }

  // ================= LECTURER: ATTENDANCE, ASSIGNMENTS, RESULTS =================

  // Reached only from the Class Attendance sidebar hub now -- attendance/assignments/
  // results were removed from the course page itself, which only ever offered a
  // confusing second route to the exact same screens the sidebar hubs already cover.
  async function renderLecturerAttendance() {
    const { courseId, courseTitle, courseCode } = state.view;
    const todayIso = new Date().toISOString().slice(0, 10);
    const dateStr = state.view.date || todayIso;
    const { roster } = await api(`/courses/${courseId}/attendance?date=${dateStr}`);
    view.innerHTML = `
      <div class="page-head">
        <div><div class="muted tabular">${esc(courseCode || '')}</div><h1>Class attendance — ${esc(courseTitle || '')}</h1></div>
        <button class="btn btn-ghost btn-sm" id="back-btn">← Back</button>
      </div>
      <div class="card" style="padding:16px 20px; margin-bottom:18px; display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
        <label style="display:flex; align-items:center; gap:8px;">
          <span class="meta">Date</span>
          <input type="date" id="att-date" value="${dateStr}" max="${todayIso}">
        </label>
      </div>
      <div class="card">
        ${roster.map((r) => `
          <div class="list-row" data-student="${r.student.id}">
            <div><div style="font-weight:600;">${esc(r.student.fullName)}</div><div class="meta tabular">${esc(r.student.matricNumber || '—')}</div></div>
            <div style="display:flex; gap:8px;">
              <button class="btn btn-sm ${r.status === 'PRESENT' ? 'btn-primary' : 'btn-ghost'}" data-mark="PRESENT">Present</button>
              <button class="btn btn-sm ${r.status === 'ABSENT' ? 'btn-accent' : 'btn-ghost'}" data-mark="ABSENT">Absent</button>
            </div>
          </div>
        `).join('') || '<p class="muted" style="padding:16px;">No students enrolled yet.</p>'}
      </div>
    `;
    document.getElementById('back-btn').addEventListener('click', () => navigate('lect-attendance-hub'));
    document.getElementById('att-date').addEventListener('change', (e) => {
      navigate('lect-attendance', { courseId, courseTitle, courseCode, date: e.target.value });
    });
    view.querySelectorAll('[data-mark]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const row = btn.closest('[data-student]');
        try {
          await api(`/courses/${courseId}/attendance`, {
            method: 'POST',
            body: { studentId: row.dataset.student, status: btn.dataset.mark, date: dateStr },
          });
          navigate('lect-attendance', { courseId, courseTitle, courseCode, date: dateStr });
        } catch (err) { toast(err.message); }
      });
    });
  }

  // Reached only from the Assignments sidebar hub now (same reasoning as attendance
  // above).
  async function renderAssignmentSubmissions() {
    const { assignmentId, assignmentTitle, courseId, courseTitle, courseCode } = state.view;
    const { submissions } = await api(`/assignments/${assignmentId}/submissions`);
    view.innerHTML = `
      <div class="page-head">
        <h1>${esc(assignmentTitle || 'Submissions')}</h1>
        <button class="btn btn-ghost btn-sm" id="back-btn">← Back</button>
      </div>
      <div class="card">
        ${submissions.map((s) => `
          <div class="list-row" style="align-items:flex-start; flex-direction:column; gap:10px;">
            <div style="display:flex; justify-content:space-between; width:100%; flex-wrap:wrap; gap:8px;">
              <div><div style="font-weight:600;">${esc(s.student.fullName)}</div><div class="meta tabular">${esc(s.student.matricNumber || '—')}</div></div>
              <span class="pill ${s.status === 'MARKED' ? 'pill-pass' : 'pill-accent'}">${s.status === 'MARKED' ? `Marked: ${s.score}` : 'Awaiting mark'}</span>
            </div>
            <p style="white-space:pre-wrap;">${esc(s.answerText)}</p>
            ${s.status !== 'MARKED' ? `
              <form class="mark-form" data-sub="${s.id}" style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                <input type="number" class="mark-score" placeholder="Score" style="width:90px;" required>
                <input type="text" class="mark-feedback" placeholder="Feedback (optional)" style="flex:1; min-width:160px;">
                <button class="btn btn-primary btn-sm" type="submit">Save mark</button>
              </form>
            ` : s.feedback ? `<p class="meta">Feedback: ${esc(s.feedback)}</p>` : ''}
          </div>
        `).join('') || '<p class="muted" style="padding:16px;">No submissions yet.</p>'}
      </div>
    `;
    document.getElementById('back-btn').addEventListener('click', () => navigate('lect-assignments-hub'));
    view.querySelectorAll('.mark-form').forEach((form) => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const score = form.querySelector('.mark-score').value;
        const feedback = form.querySelector('.mark-feedback').value;
        try {
          await api(`/assignment-submissions/${form.dataset.sub}/mark`, { method: 'POST', body: { score, feedback } });
          toast('Marked');
          navigate('lect-assignment-submissions', { assignmentId, assignmentTitle, courseId, courseTitle, courseCode });
        } catch (err) { toast(err.message); }
      });
    });
  }

  // ================= LECTURER: DASHBOARD, MY STUDENTS, ATTENDANCE/ASSIGNMENTS/RESULTS HUBS =================

  async function renderLecturerDashboard() {
    const { department, courses } = await ensureLectCourses();
    const counts = await Promise.all(courses.map((c) => api(`/courses/${c.id}/enrollment-count`).catch(() => ({ count: 0 }))));
    const totalStudents = counts.reduce((sum, c) => sum + c.count, 0);
    const u = state.user;
    view.innerHTML = `
      <div class="page-head"><h1>My Dashboard</h1></div>
      <div class="card" style="padding:20px; margin-bottom:22px; display:flex; align-items:center; gap:16px; cursor:pointer;" id="dash-profile-card">
        ${selfAvatarHtml('avatar-lect-dash')}
        <div>
          <div>${esc(u.fullName)} · Lecturer</div>
          <div>${state.school ? [state.school.name, state.school.location].filter(Boolean).map(esc).join(', ') : ''}</div>
          <div>${[department && department.name, u.staffId].filter(Boolean).map(esc).join(' · ')}</div>
        </div>
      </div>
      <div class="grid-cards" style="margin-bottom:26px;">
        <div class="card course-card" data-jump-nav="lect-courses" style="cursor:pointer;"><div class="code">${courses.length}</div><div class="meta">Courses</div></div>
        <div class="card course-card" data-jump-nav="lect-students" style="cursor:pointer;"><div class="code">${totalStudents}</div><div class="meta">Students</div></div>
      </div>
      <h3 style="margin-bottom:10px; font-size:1rem;">Quick actions</h3>
      <div class="grid-cards" style="margin-bottom:26px;">
        <div class="card course-card" data-jump-nav="lect-lessons-entry" style="cursor:pointer;"><div class="code">📹</div><div class="meta">Upload Lecture</div></div>
        <div class="card course-card" data-jump-nav="lect-tests" style="cursor:pointer;"><div class="code">📝</div><div class="meta">Create Test</div></div>
        <div class="card course-card" data-jump-nav="lect-students" style="cursor:pointer;"><div class="code">👥</div><div class="meta">My Students</div></div>
        <div class="card course-card" data-jump-nav="lect-classwork-quiz" style="cursor:pointer;"><div class="code">📋</div><div class="meta">Classwork / Quiz</div></div>
        <div class="card course-card" data-jump-nav="lect-mark-work" style="cursor:pointer;"><div class="code">✅</div><div class="meta">Mark Work</div></div>
        <div class="card course-card" data-jump-nav="lect-attendance-hub" style="cursor:pointer;"><div class="code">🗓️</div><div class="meta">Attendance</div></div>
        <div class="card course-card" id="dash-announce-btn" style="cursor:pointer;"><div class="code">📣</div><div class="meta">Announce</div></div>
      </div>
      <div style="display:flex; gap:12px; flex-wrap:wrap;">
        <button class="btn btn-ghost" id="dash-digital-id-btn">🪪 Digital ID</button>
        <button class="btn btn-ghost" id="dash-staff-profile-btn">👤 My Staff Profile</button>
      </div>
    `;
    document.getElementById('dash-profile-card').addEventListener('click', () => navigate('digital-id'));
    wireSelfAvatarUpload('avatar-lect-dash');
    view.querySelectorAll('[data-jump-nav]').forEach((el) => el.addEventListener('click', () => {
      if (el.dataset.jumpNav === 'lect-lessons-entry') return openLessonCoursePicker(courses);
      navigate(el.dataset.jumpNav);
    }));
    document.getElementById('dash-digital-id-btn').addEventListener('click', () => navigate('digital-id'));
    document.getElementById('dash-staff-profile-btn').addEventListener('click', () => navigate('staff-profile'));
    document.getElementById('dash-announce-btn').addEventListener('click', () => openAnnounceDialog(courses));
  }

  // "Upload Lecture" has no cross-course hub of its own (a lecture always belongs to
  // one course, and the upload form lives on that course's own page) -- this just asks
  // which class first, then goes straight there, instead of making the lecturer find
  // "My Courses" themselves.
  function openLessonCoursePicker(courses) {
    if (courses.length === 1) return navigate('lect-lessons', { courseId: courses[0].id });
    const container = document.createElement('div');
    container.className = 'card';
    container.style.cssText = 'position:fixed; inset:0; margin:auto; width:min(420px,92vw); height:fit-content; padding:24px; z-index:200;';
    container.innerHTML = `
      <h3 style="margin-bottom:14px;">Upload a lecture to which class?</h3>
      <div class="field"><select id="lp-course">${courses.map((c) => `<option value="${c.id}">${esc(c.code)} — ${esc(c.title)}</option>`).join('')}</select></div>
      <div style="display:flex; gap:10px; margin-top:10px;">
        <button class="btn btn-primary" id="lp-go">Continue</button>
        <button class="btn btn-ghost" id="lp-cancel">Cancel</button>
      </div>
    `;
    const backdrop = document.createElement('div');
    backdrop.style.cssText = 'position:fixed; inset:0; background:rgba(20,32,51,0.45); z-index:190;';
    document.body.appendChild(backdrop);
    document.body.appendChild(container);
    function close() { backdrop.remove(); container.remove(); }
    container.querySelector('#lp-cancel').addEventListener('click', close);
    container.querySelector('#lp-go').addEventListener('click', () => {
      const courseId = container.querySelector('#lp-course').value;
      close();
      navigate('lect-lessons', { courseId });
    });
  }

  // A quick broadcast to everyone enrolled in one class -- delivered as a regular
  // in-app notification (respects each student's own mute setting), not a new channel.
  function openAnnounceDialog(courses) {
    const container = document.createElement('div');
    container.className = 'card';
    container.style.cssText = 'position:fixed; inset:0; margin:auto; width:min(480px,92vw); height:fit-content; padding:24px; z-index:200;';
    container.innerHTML = `
      <h3 style="margin-bottom:14px;">Announce to a class</h3>
      <div class="field"><label>Class (course)</label><select id="an-course">${courses.map((c) => `<option value="${c.id}">${esc(c.code)} — ${esc(c.title)}</option>`).join('')}</select></div>
      <div class="field"><label>Title</label><input type="text" id="an-title" required placeholder="e.g. Class moved to Friday"></div>
      <div class="field"><label>Message</label><textarea id="an-body" required></textarea></div>
      <div style="display:flex; gap:10px; margin-top:10px;">
        <button class="btn btn-primary" id="an-save">Send</button>
        <button class="btn btn-ghost" id="an-cancel">Cancel</button>
      </div>
    `;
    const backdrop = document.createElement('div');
    backdrop.style.cssText = 'position:fixed; inset:0; background:rgba(20,32,51,0.45); z-index:190;';
    document.body.appendChild(backdrop);
    document.body.appendChild(container);
    function close() { backdrop.remove(); container.remove(); }
    container.querySelector('#an-cancel').addEventListener('click', close);
    container.querySelector('#an-save').addEventListener('click', async () => {
      const title = container.querySelector('#an-title').value.trim();
      const body = container.querySelector('#an-body').value.trim();
      if (!title || !body) return toast('Title and message are required.');
      try {
        await api(`/courses/${container.querySelector('#an-course').value}/announce`, { method: 'POST', body: { title, body } });
        toast('Announcement sent');
        close();
      } catch (err) { toast(err.message); }
    });
  }

  async function renderLecturerDigitalId() {
    const { department, courses } = await ensureLectCourses();
    const u = state.user;
    view.innerHTML = `
      <div class="page-head"><h1>Digital ID</h1></div>
      <div class="id-card" style="margin-bottom:28px;">
        <div class="id-top"><span>Learnza${state.school ? ` · ${esc(state.school.name)}` : ''}</span><span>Lecturer</span></div>
        <div class="id-row">
          ${selfAvatarHtml('avatar-lect-id')}
          <div>
            <div class="id-value">${esc(u.fullName)}</div>
            <div class="id-field tabular" style="margin-top:4px;">${esc(u.staffId || 'Staff ID pending')}</div>
          </div>
        </div>
        <div class="id-grid">
          <div><div class="id-field">Department</div><div>${department ? esc(department.name) : '—'}</div></div>
          <div><div class="id-field">Courses taught</div><div>${courses.length}</div></div>
          <div><div class="id-field">Email</div><div>${esc(u.email)}</div></div>
          <div><div class="id-field">Phone</div><div>${esc(u.phone || '—')}</div></div>
          <div><div class="id-field">Access code</div><div class="tabular">${esc(u.accessCode || '—')}</div></div>
          <div><div class="id-field">Member since</div><div>${new Date(u.createdAt).toLocaleDateString()}</div></div>
        </div>
      </div>
    `;
    wireSelfAvatarUpload('avatar-lect-id');
  }

  // "My Students" -- banner per class (course), matching My Courses -- clicking one
  // shows only that class's roster, and creating a test/assignment/exam always requires
  // picking a class too (openNewAssessmentDialog/openNewAssignmentDialog), so a
  // student only ever sees what their own class received.
  async function renderLecturerStudentsHub() {
    const { courses } = await ensureLectCourses();
    const counts = await Promise.all(courses.map((c) => api(`/courses/${c.id}/enrollment-count`).catch(() => ({ count: 0 }))));
    view.innerHTML = `
      <div class="page-head"><h1>My Students</h1></div>
      <p class="muted" style="margin-bottom:18px;">Pick a class to see its students.</p>
      <div class="grid-cards">
        ${courses.map((c, i) => `
          <div class="card course-card" data-open="${c.id}" data-title="${esc(c.title)}" data-code="${esc(c.code)}" style="cursor:pointer;">
            <div class="code tabular">${esc(c.code)}</div>
            <div style="margin:4px 0 8px;">${esc(c.title)}</div>
            <span class="pill">${counts[i].count} student${counts[i].count === 1 ? '' : 's'}</span>
          </div>
        `).join('') || '<p class="muted">No courses yet.</p>'}
      </div>
    `;
    view.querySelectorAll('[data-open]').forEach((el) => {
      el.addEventListener('click', () => navigate('lect-class-roster', { courseId: el.dataset.open, courseTitle: el.dataset.title, courseCode: el.dataset.code }));
    });
  }

  async function renderLecturerClassRoster() {
    const { courseId, courseTitle, courseCode } = state.view;
    const { students } = await api(`/courses/${courseId}/roster`);
    view.innerHTML = `
      <div class="page-head">
        <div><div class="muted tabular">${esc(courseCode || '')}</div><h1>${esc(courseTitle || 'Class')}</h1></div>
        <div style="display:flex; gap:10px;">
          <button class="btn btn-accent btn-sm" id="add-student-btn">+ Add student</button>
          <button class="btn btn-ghost btn-sm" id="back-btn">← Back to My Students</button>
        </div>
      </div>
      <div class="card">
        ${students.map((s) => `
          <div class="list-row clickable" data-open-student="${s.id}" style="cursor:pointer;">
            <div><div style="font-weight:600;">${esc(s.fullName)}</div><div class="meta tabular">${esc(s.matricNumber || '—')}</div></div>
            ${statusPillHtml(s.status)}
          </div>
        `).join('') || '<p class="muted" style="padding:16px;">No students in this class yet — add one above.</p>'}
      </div>
    `;
    document.getElementById('back-btn').addEventListener('click', () => navigate('lect-students'));
    view.querySelectorAll('[data-open-student]').forEach((row) => {
      row.addEventListener('click', () => navigate('lect-student-detail', { studentId: row.dataset.openStudent, courseId, courseTitle, courseCode }));
    });
    document.getElementById('add-student-btn').addEventListener('click', () => openAddStudentDialog(courseId, courseTitle));
  }

  function openAddStudentDialog(courseId, courseTitle) {
    const container = document.createElement('div');
    container.className = 'card';
    container.style.cssText = 'position:fixed; inset:0; margin:auto; width:min(420px,92vw); height:fit-content; padding:24px; z-index:200;';
    container.innerHTML = `
      <h3 style="margin-bottom:14px;">Add student to ${esc(courseTitle || 'this class')}</h3>
      <p class="muted" style="font-size:13px; margin-bottom:14px;">Enter the matric number of a student who already has a Learnza account. To create a brand-new account, use the admin's Staff &amp; Student Directory.</p>
      <div class="field"><label>Matric number</label><input type="text" id="as-matric" required placeholder="e.g. ECOE/23/CSC/041"></div>
      <div style="display:flex; gap:10px; margin-top:10px;">
        <button class="btn btn-primary" id="as-save">Add student</button>
        <button class="btn btn-ghost" id="as-cancel">Cancel</button>
      </div>
    `;
    const backdrop = document.createElement('div');
    backdrop.style.cssText = 'position:fixed; inset:0; background:rgba(20,32,51,0.45); z-index:190;';
    document.body.appendChild(backdrop);
    document.body.appendChild(container);
    function close() { backdrop.remove(); container.remove(); }
    container.querySelector('#as-cancel').addEventListener('click', close);
    container.querySelector('#as-save').addEventListener('click', async () => {
      const matricNumber = container.querySelector('#as-matric').value.trim();
      if (!matricNumber) return toast('Enter a matric number.');
      try {
        const { student } = await api(`/courses/${courseId}/enroll-student`, { method: 'POST', body: { matricNumber } });
        toast(`${student.fullName} added to the class`);
        close();
        render();
      } catch (err) { toast(err.message); }
    });
  }

  // Comprehensive detail for one student in the lecturer's class -- reuses the exact
  // same computation as the student/admin Admission Status screens.
  async function renderLecturerStudentDetail() {
    const { studentId, courseId, courseTitle, courseCode } = state.view;
    const data = await api(`/lect/students/${studentId}`);
    view.innerHTML = `
      <div class="page-head"><h1>${esc(data.fullName)}</h1><button class="btn btn-ghost btn-sm" id="back-btn">← Back to class</button></div>
      <div class="card" style="padding:24px; max-width:640px; margin-bottom:22px;">
        <div class="id-grid">
          <div><div class="meta">Matric No.</div><div class="tabular">${esc(data.matricNumber || '—')}</div></div>
          <div><div class="meta">Department</div><div>${esc(data.department || '—')}</div></div>
          <div><div class="meta">Level</div><div>${esc(data.level || '—')}</div></div>
          <div><div class="meta">Status</div><div>${statusPillHtml(data.status)}</div></div>
          <div><div class="meta">Email</div><div>${esc(data.email)}</div></div>
          <div><div class="meta">Phone</div><div>${esc(data.phone || '—')}</div></div>
          <div><div class="meta">Year of admission</div><div>${data.yearOfAdmission || '—'}</div></div>
          <div><div class="meta">Expected graduation</div><div>${data.expectedGraduationYear || '—'}</div></div>
          <div><div class="meta">CGPA</div><div>${data.cgpa ?? '—'}</div></div>
          <div><div class="meta">Class position</div><div>${esc(data.classPosition || '—')}</div></div>
        </div>
      </div>
      <div class="grid-cards" style="margin-bottom:22px;">
        <div class="card course-card"><div class="code">${data.exams.done}/${data.exams.total}</div><div class="meta">Exams done</div></div>
        <div class="card course-card"><div class="code">${data.tests.done}/${data.tests.total}</div><div class="meta">Tests done</div></div>
        <div class="card course-card"><div class="code">${data.assignments.done}/${data.assignments.total}</div><div class="meta">Assignments done</div></div>
        <div class="card course-card"><div class="code">${data.disciplinaryIssueCount}</div><div class="meta">Disciplinary issues</div></div>
      </div>
      ${data.disciplinaryRecords.length ? `
        <h3 style="margin-bottom:10px; font-size:1rem;">Disciplinary records</h3>
        <div class="card" style="margin-bottom:22px;">
          ${data.disciplinaryRecords.map((r) => `<div class="list-row"><div><div style="font-weight:600;">${esc(r.title)}</div><div class="meta">${esc(r.description || '')}</div></div><span class="pill ${r.status === 'RESOLVED' ? 'pill-pass' : 'pill-accent'}">${esc(r.status)}</span></div>`).join('')}
        </div>
      ` : ''}
    `;
    document.getElementById('back-btn').addEventListener('click', () => navigate('lect-class-roster', { courseId, courseTitle, courseCode }));
  }

  // Attendance stays a per-class, per-day marking workflow (unchanged) -- this hub is
  // just the cross-course entry point the sidebar needed, a class picker in front of it.
  async function renderLecturerAttendanceHub() {
    const { courses } = await ensureLectCourses();
    const counts = await Promise.all(courses.map((c) => api(`/courses/${c.id}/enrollment-count`).catch(() => ({ count: 0 }))));
    view.innerHTML = `
      <div class="page-head"><h1>Class Attendance</h1></div>
      <p class="muted" style="margin-bottom:18px;">Pick a class to mark today's (or a past) attendance.</p>
      <div class="grid-cards">
        ${courses.map((c, i) => `
          <div class="card course-card" data-open="${c.id}" data-title="${esc(c.title)}" data-code="${esc(c.code)}" style="cursor:pointer;">
            <div class="code tabular">${esc(c.code)}</div>
            <div style="margin:4px 0 8px;">${esc(c.title)}</div>
            <span class="pill">${counts[i].count} enrolled</span>
          </div>
        `).join('') || '<p class="muted">No courses yet.</p>'}
      </div>
    `;
    view.querySelectorAll('[data-open]').forEach((el) => {
      el.addEventListener('click', () => navigate('lect-attendance', { courseId: el.dataset.open, courseTitle: el.dataset.title, courseCode: el.dataset.code }));
    });
  }

  // Every assignment/project across every class in one page, labeled per class --
  // posting one always requires picking which class receives it (openNewAssignmentDialog).
  async function renderLecturerAssignmentsHub() {
    const { courses } = await ensureLectCourses();
    const rows = await Promise.all(courses.map(async (c) => ({ course: c, assignments: (await api(`/courses/${c.id}/assignments`)).assignments })));
    view.innerHTML = `
      <div class="page-head">
        <h1>Assignments</h1>
        <button class="btn btn-accent btn-sm" id="new-assignment-btn">+ Post assignment</button>
      </div>
      ${rows.map(({ course, assignments }) => `
        <div style="margin-bottom:22px;">
          <div class="muted" style="font-weight:700; margin-bottom:8px;">${esc(course.code)} — ${esc(course.title)}</div>
          <div class="card">
            ${assignments.map((a) => `
              <div class="list-row">
                <div>
                  <div style="font-weight:600;">${esc(a.title)} ${a.kind === 'PROJECT' ? '<span class="pill pill-muted" style="margin-left:6px;">Project</span>' : ''} ${a.sentAt ? '<span class="pill pill-pass" style="margin-left:6px;">Sent</span>' : '<span class="pill pill-muted" style="margin-left:6px;">Draft</span>'}</div>
                  <div class="meta">${a._count.submissions} submission${a._count.submissions === 1 ? '' : 's'}${a.dueAt ? ' · due ' + new Date(a.dueAt).toLocaleDateString() : ''}</div>
                </div>
                <div style="display:flex; gap:8px; flex-wrap:wrap;">
                  ${!a.sentAt ? `<button class="btn btn-ghost btn-sm" data-edit-assignment="${a.id}">Edit</button>` : ''}
                  <button class="btn btn-ghost btn-sm" data-send-assignment="${a.id}">${a.sentAt ? 'Resend' : 'Send'}</button>
                  <button class="btn btn-ghost btn-sm" data-open="${a.id}" data-course="${course.id}" data-course-title="${esc(course.title)}" data-course-code="${esc(course.code)}">View submissions</button>
                </div>
              </div>
            `).join('') || '<p class="muted" style="padding:16px;">None yet.</p>'}
          </div>
        </div>
      `).join('') || '<p class="muted">No courses yet.</p>'}
    `;
    view.querySelectorAll('[data-open]').forEach((el) => {
      el.addEventListener('click', () => navigate('lect-assignment-submissions', {
        assignmentId: el.dataset.open, courseId: el.dataset.course, courseTitle: el.dataset.courseTitle, courseCode: el.dataset.courseCode,
      }));
    });
    view.querySelectorAll('[data-edit-assignment]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const assignment = rows.flatMap((r) => r.assignments).find((a) => a.id === btn.dataset.editAssignment);
        if (assignment) openNewAssignmentDialog(courses, { existing: assignment });
      });
    });
    view.querySelectorAll('[data-send-assignment]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await api(`/assignments/${btn.dataset.sendAssignment}/send`, { method: 'POST' });
          toast(btn.textContent === 'Resend' ? 'Resent to the class' : 'Sent to the class');
          render();
        } catch (err) { toast(err.message); }
      });
    });
    document.getElementById('new-assignment-btn').addEventListener('click', () => openNewAssignmentDialog(courses));
  }

  // A single ungraded-work inbox, distinct from "Classwork / Quiz" (which is for
  // *setting* work) -- covers Assignment submissions (manually marked, one holistic
  // score) and Assessment theory-question answers (Classwork/Quiz/Test/Exam alike;
  // objective questions there are already auto-graded on submit, but theory answers
  // never are, so without this they'd sit ungraded indefinitely).
  async function renderMarkWorkHub() {
    const [{ submissions: assignmentSubs }, { submissions: theorySubs }] = await Promise.all([
      api('/lecturer/unmarked-assignment-submissions'),
      api('/lecturer/theory-submissions'),
    ]);
    view.innerHTML = `
      <div class="page-head"><h1>Mark Work</h1></div>
      <h3 style="margin-bottom:10px; font-size:1rem;">Assignments &amp; Projects</h3>
      <div class="card" style="margin-bottom:26px;">
        ${assignmentSubs.map((s) => `
          <div class="list-row" data-open-assignment="${s.assignment.id}" data-assignment-title="${esc(s.assignment.title)}" data-course="${s.assignment.course.id}" data-course-title="${esc(s.assignment.course.title)}" data-course-code="${esc(s.assignment.course.code)}" style="cursor:pointer;">
            <div>
              <div style="font-weight:600;">${esc(s.student.fullName)} — ${esc(s.assignment.title)} ${s.assignment.kind === 'PROJECT' ? '<span class="pill pill-muted" style="margin-left:6px;">Project</span>' : ''}</div>
              <div class="meta">${esc(s.assignment.course.code)} · submitted ${new Date(s.submittedAt).toLocaleDateString()}</div>
            </div>
            <span class="pill pill-accent">Mark</span>
          </div>
        `).join('') || '<p class="muted" style="padding:16px;">Nothing awaiting a mark.</p>'}
      </div>

      <h3 style="margin-bottom:10px; font-size:1rem;">Classwork, Quiz, Test &amp; Exam — written answers</h3>
      <p class="muted" style="margin-bottom:14px;">Objective (multiple-choice) questions are graded automatically on submit. Written answers need a score from you.</p>
      <div id="theory-list">
        ${theorySubs.map((s) => `
          <div class="card" style="padding:18px; margin-bottom:14px;">
            <div style="display:flex; justify-content:space-between; flex-wrap:wrap; gap:8px; margin-bottom:10px;">
              <div>
                <div style="font-weight:600;">${esc(s.student.fullName)} — ${esc(s.assessment.title)}</div>
                <div class="meta">${esc(s.assessment.type)} · ${esc(s.assessment.course.code)}</div>
              </div>
            </div>
            ${s.theoryAnswers.map((q, i) => `
              <div style="${i < s.theoryAnswers.length - 1 ? 'margin-bottom:12px; padding-bottom:12px; border-bottom:1px solid var(--line);' : 'margin-bottom:12px;'}">
                <div style="font-weight:600; margin-bottom:6px;">${i + 1}. ${esc(q.text)}</div>
                <div class="meta">Student's answer</div>
                <p style="margin-bottom:8px;">${esc(q.myAnswer || '(no answer)')}</p>
                ${q.modelAnswer ? `<div class="meta">Model answer</div><p>${esc(q.modelAnswer)}</p>` : ''}
              </div>
            `).join('')}
            <form class="mark-theory-form" data-sub="${s.id}" style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
              <input type="number" class="theory-score" placeholder="Score" style="width:90px;" required>
              <span class="meta">out of</span>
              <input type="number" class="theory-max" placeholder="Max" style="width:90px;" required>
              <button class="btn btn-primary btn-sm" type="submit">Save mark</button>
            </form>
          </div>
        `).join('') || '<p class="muted" style="padding:16px;">Nothing awaiting a mark.</p>'}
      </div>
    `;
    view.querySelectorAll('[data-open-assignment]').forEach((row) => {
      row.addEventListener('click', () => navigate('lect-assignment-submissions', {
        assignmentId: row.dataset.openAssignment, assignmentTitle: row.dataset.assignmentTitle,
        courseId: row.dataset.course, courseTitle: row.dataset.courseTitle, courseCode: row.dataset.courseCode,
      }));
    });
    view.querySelectorAll('.mark-theory-form').forEach((form) => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const theoryScore = form.querySelector('.theory-score').value;
        const theoryMaxScore = form.querySelector('.theory-max').value;
        try {
          await api(`/submissions/${form.dataset.sub}/mark-theory`, { method: 'POST', body: { theoryScore, theoryMaxScore } });
          toast('Marked');
          render();
        } catch (err) { toast(err.message); }
      });
    });
  }

  // Assignment/Project creation gets the same theory/objective question-drafting body
  // as a test/exam (openNewAssessmentDialog) -- compiled into the assignment's
  // instructions as one numbered body, since a student still submits one holistic
  // written answer (Assignment has no per-question submission model, unlike Assessment).
  // opts.existing switches to editing a still-unsent draft -- the compiled instructions
  // are shown as one editable block rather than re-deriving individual question rows
  // from the compiled text, which would be fragile to parse back out.
  function openNewAssignmentDialog(courses, opts = {}) {
    const { existing } = opts;
    const container = document.createElement('div');
    container.className = 'card';
    container.style.cssText = 'position:fixed; inset:0; margin:auto; width:min(560px,92vw); height:fit-content; max-height:86vh; overflow-y:auto; padding:24px; z-index:200;';
    let qCount = 1;
    function questionBlock(i) {
      return `<div class="field" data-aq-block="${i}">
        <label>Question ${i + 1}</label>
        <div class="tabs aq-type" data-value="OBJECTIVE" style="margin:0 0 10px;">
          <button type="button" class="tab-btn active" data-val="OBJECTIVE">Objective (multiple choice)</button>
          <button type="button" class="tab-btn" data-val="THEORY">Theory (free response)</button>
        </div>
        <input type="text" class="aq-text" placeholder="Question text" required>
        <div class="aq-objective-fields">
          <input type="text" class="aq-opt" placeholder="Option A" style="margin-top:6px;">
          <input type="text" class="aq-opt" placeholder="Option B" style="margin-top:6px;">
          <input type="text" class="aq-opt" placeholder="Option C" style="margin-top:6px;">
          <input type="text" class="aq-opt" placeholder="Option D" style="margin-top:6px;">
        </div>
      </div>`;
    }
    function wireToggle(block) {
      const typeToggle = block.querySelector('.aq-type');
      const objectiveFields = block.querySelector('.aq-objective-fields');
      typeToggle.querySelectorAll('.tab-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          typeToggle.dataset.value = btn.dataset.val;
          typeToggle.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
          objectiveFields.hidden = btn.dataset.val === 'THEORY';
        });
      });
    }
    const course = existing ? courses.find((c) => c.id === existing.courseId) : null;
    const courseFieldHtml = existing
      ? `<div class="field"><label>Class (course)</label><div style="padding:10px 0; font-weight:600;">${course ? esc(`${course.code} — ${course.title}`) : ''}</div></div>`
      : `<div class="field"><label>Class (course)</label><select id="na-course">${courses.map((c) => `<option value="${c.id}">${esc(c.code)} — ${esc(c.title)}</option>`).join('')}</select></div>`;
    container.innerHTML = existing ? `
      <h3 style="margin-bottom:14px;">Edit ${existing.kind === 'PROJECT' ? 'project' : 'assignment'}</h3>
      ${courseFieldHtml}
      <div class="field"><label>Kind</label><select id="na-kind"><option value="ASSIGNMENT" ${existing.kind !== 'PROJECT' ? 'selected' : ''}>Assignment</option><option value="PROJECT" ${existing.kind === 'PROJECT' ? 'selected' : ''}>Project</option></select></div>
      <div class="field"><label>Title</label><input type="text" id="na-title" value="${esc(existing.title)}" required></div>
      <div class="field"><label>Due date (optional)</label><input type="date" id="na-due" value="${existing.dueAt ? new Date(existing.dueAt).toISOString().slice(0, 10) : ''}"></div>
      <div class="field"><label>Instructions</label><textarea id="na-instructions" rows="8" required>${esc(existing.instructions)}</textarea></div>
      <p class="meta" style="margin-bottom:10px;">"Save and Send" delivers it to the class now. "Save" keeps it as a draft.</p>
      <div style="display:flex; gap:10px; flex-wrap:wrap;">
        <button class="btn btn-primary" id="na-save-send">Save and Send</button>
        <button class="btn btn-ghost" id="na-save">Save</button>
        <button class="btn btn-ghost" id="na-cancel">Cancel</button>
      </div>
    ` : `
      <h3 style="margin-bottom:14px;">Post a new assignment</h3>
      ${courseFieldHtml}
      <div class="field"><label>Kind</label><select id="na-kind"><option value="ASSIGNMENT">Assignment</option><option value="PROJECT">Project</option></select></div>
      <div class="field"><label>Title</label><input type="text" id="na-title" required></div>
      <div class="field"><label>Due date (optional)</label><input type="date" id="na-due"></div>
      <p class="meta" style="margin-bottom:10px;">Draft the questions the same way a test/exam is drafted — objective or theory, one or more. They're compiled into the body students see, answered as one written submission.</p>
      <div id="na-questions">${questionBlock(0)}</div>
      <button type="button" class="btn btn-ghost btn-sm" id="na-add-q" style="margin-bottom:14px;">+ Add question</button>
      <p class="meta" style="margin-bottom:10px;">"Save and Send" posts it to the class now. "Save" keeps it as a draft you can review, edit, and send later -- even tomorrow.</p>
      <div style="display:flex; gap:10px; flex-wrap:wrap;">
        <button class="btn btn-primary" id="na-save-send">Save and Send</button>
        <button class="btn btn-ghost" id="na-save">Save</button>
        <button class="btn btn-ghost" id="na-cancel">Cancel</button>
      </div>
    `;
    const backdrop = document.createElement('div');
    backdrop.style.cssText = 'position:fixed; inset:0; background:rgba(20,32,51,0.45); z-index:190;';
    document.body.appendChild(backdrop);
    document.body.appendChild(container);
    if (!existing) {
      wireToggle(container.querySelector('[data-aq-block="0"]'));
      container.querySelector('#na-add-q').addEventListener('click', () => {
        const div = document.createElement('div');
        div.innerHTML = questionBlock(qCount++);
        const block = div.firstElementChild;
        container.querySelector('#na-questions').appendChild(block);
        wireToggle(block);
      });
    }
    function close() { backdrop.remove(); container.remove(); }
    container.querySelector('#na-cancel').addEventListener('click', close);
    async function save(send) {
      const title = container.querySelector('#na-title').value.trim();
      if (!title) return toast('Give it a title.');
      const dueAt = container.querySelector('#na-due').value || null;
      const kind = container.querySelector('#na-kind').value;
      try {
        if (existing) {
          const instructions = container.querySelector('#na-instructions').value.trim();
          if (!instructions) return toast('Instructions cannot be empty.');
          await api(`/assignments/${existing.id}`, { method: 'PUT', body: { title, instructions, dueAt, kind, send } });
          toast(send ? 'Saved and sent' : 'Saved as a draft');
        } else {
          const blocks = container.querySelectorAll('[data-aq-block]');
          const bodyParts = Array.from(blocks).map((b, i) => {
            const type = b.querySelector('.aq-type').dataset.value;
            const text = b.querySelector('.aq-text').value.trim();
            if (!text) return null;
            if (type === 'OBJECTIVE') {
              const opts = Array.from(b.querySelectorAll('.aq-opt')).map((el) => el.value.trim()).filter(Boolean);
              const lettered = opts.map((o, idx) => `   ${OPTION_LABELS[idx]}) ${o}`).join('\n');
              return `${i + 1}. ${text}${lettered ? `\n${lettered}` : ''}`;
            }
            return `${i + 1}. ${text}`;
          }).filter(Boolean);
          if (!bodyParts.length) return toast('Add at least one question.');
          await api(`/courses/${container.querySelector('#na-course').value}/assignments`, {
            method: 'POST',
            body: { title, instructions: bodyParts.join('\n\n'), dueAt, kind, send },
          });
          toast(send ? 'Posted and sent' : 'Saved as a draft');
        }
        close();
        render();
      } catch (err) { toast(err.message); }
    }
    container.querySelector('#na-save-send').addEventListener('click', () => save(true));
    container.querySelector('#na-save').addEventListener('click', () => save(false));
  }

  // Every published result across every class in one page, labeled per class.
  async function renderLecturerResultsHub() {
    const { courses } = await ensureLectCourses();
    const rows = await Promise.all(courses.map(async (c) => ({ course: c, results: (await api(`/courses/${c.id}/results`)).results })));
    const totalDrafts = rows.reduce((sum, { results }) => sum + results.filter((r) => !r.sentAt).length, 0);
    view.innerHTML = `
      <div class="page-head">
        <h1>Student Results</h1>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          ${totalDrafts ? `<button class="btn btn-primary btn-sm" id="send-all-btn">📤 Send all to all students (${totalDrafts})</button>` : ''}
          <button class="btn btn-accent btn-sm" id="new-result-btn">+ Create new result</button>
        </div>
      </div>
      ${rows.map(({ course, results }) => {
        const draftCount = results.filter((r) => !r.sentAt).length;
        return `
        <div style="margin-bottom:22px;">
          <div class="page-head" style="margin-bottom:8px;">
            <div class="muted" style="font-weight:700;">${esc(course.code)} — ${esc(course.title)}</div>
            ${draftCount ? `<button class="btn btn-ghost btn-sm" data-publish="${course.id}">📤 Publish results (${draftCount} draft${draftCount === 1 ? '' : 's'})</button>` : ''}
          </div>
          <div class="card" style="overflow-x:auto;">
            <table class="data-table">
              <thead><tr><th>Student</th><th>Course</th><th>Semester</th><th>Score</th><th>Grade</th><th>Status</th><th></th></tr></thead>
              <tbody>${results.map((r) => `<tr>
                <td>${esc(r.student.fullName)}</td><td class="tabular">${esc(course.code)}</td><td>${esc(r.term)}</td><td class="tabular">${r.score}</td><td>${esc(r.grade || '—')}</td>
                <td>${r.sentAt ? `<span class="pill pill-pass">Sent ${new Date(r.sentAt).toLocaleDateString()}</span>` : '<span class="pill pill-muted">Draft</span>'}</td>
                <td><div style="display:flex; gap:6px;"><button class="btn btn-ghost btn-sm" data-edit-result="${r.id}">Edit</button><button class="btn btn-ghost btn-sm" data-send-result="${r.id}">${r.sentAt ? 'Resend' : 'Send'}</button></div></td>
              </tr>`).join('') || '<tr><td colspan="7" class="muted" style="padding:16px;">No results yet.</td></tr>'}</tbody>
            </table>
          </div>
        </div>
      `;
      }).join('') || '<p class="muted">No courses yet.</p>'}
    `;
    document.getElementById('new-result-btn').addEventListener('click', () => openPublishResultDialog(courses));
    const sendAllBtn = document.getElementById('send-all-btn');
    if (sendAllBtn) sendAllBtn.addEventListener('click', async () => {
      sendAllBtn.disabled = true;
      sendAllBtn.textContent = 'Sending…';
      try {
        const coursesWithDrafts = rows.filter(({ results }) => results.some((r) => !r.sentAt));
        const counts = await Promise.all(coursesWithDrafts.map(({ course }) =>
          api(`/courses/${course.id}/results/publish`, { method: 'POST' }).then((r) => r.count)
        ));
        const total = counts.reduce((sum, c) => sum + c, 0);
        toast(total ? `${total} result${total === 1 ? '' : 's'} sent to students` : 'Nothing to send');
        render();
      } catch (err) {
        toast(err.message);
        sendAllBtn.disabled = false;
        sendAllBtn.textContent = `📤 Send all to all students (${totalDrafts})`;
      }
    });
    view.querySelectorAll('[data-publish]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          const { count } = await api(`/courses/${btn.dataset.publish}/results/publish`, { method: 'POST' });
          toast(count ? `${count} result${count === 1 ? '' : 's'} sent to students` : 'Nothing to publish');
          render();
        } catch (err) { toast(err.message); }
      });
    });
    view.querySelectorAll('[data-edit-result]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const result = rows.flatMap((r) => r.results).find((x) => x.id === btn.dataset.editResult);
        if (result) openPublishResultDialog(courses, { existing: result });
      });
    });
    view.querySelectorAll('[data-send-result]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await api(`/results/${btn.dataset.sendResult}/send`, { method: 'POST' });
          toast(btn.textContent === 'Resend' ? 'Resent to the student' : 'Sent to the student');
          render();
        } catch (err) { toast(err.message); }
      });
    });
  }

  // opts.existing switches to editing an already-saved result (draft or sent) --
  // student/course are shown as fixed context rather than the search/pick flow, since
  // those never change on an edit.
  function openPublishResultDialog(courses, opts = {}) {
    const { existing } = opts;
    const container = document.createElement('div');
    container.className = 'card';
    container.style.cssText = 'position:fixed; inset:0; margin:auto; width:min(480px,92vw); height:fit-content; max-height:86vh; overflow-y:auto; padding:24px; z-index:200;';
    const course = existing ? courses.find((c) => c.id === existing.courseId) : null;
    container.innerHTML = `
      <h3 style="margin-bottom:14px;">${existing ? 'Edit result' : 'Create new result'}</h3>
      ${existing ? `
        <div class="field"><label>Student</label><div style="padding:10px 0; font-weight:600;">${esc(existing.student.fullName)}</div></div>
        <div class="field"><label>Course</label><div style="padding:10px 0; font-weight:600;">${course ? esc(`${course.code} — ${course.title}`) : ''}</div></div>
      ` : `
        <div class="field"><label>Class (course)</label><select id="pr-course">${courses.map((c) => `<option value="${c.id}">${esc(c.code)} — ${esc(c.title)}</option>`).join('')}</select></div>
        <div class="field"><label>Student</label><select id="pr-student"><option value="">Loading students…</option></select></div>
      `}
      <div class="field"><label>Semester</label><input type="text" id="pr-term" value="${esc(existing ? existing.term : '')}" placeholder="e.g. 1st Semester 2025/2026" required></div>
      <div class="field"><label>Score</label><input type="number" id="pr-score" value="${existing ? existing.score : ''}" required></div>
      <div class="field"><label>Grade (optional)</label><input type="text" id="pr-grade" value="${esc(existing ? existing.grade || '' : '')}" placeholder="e.g. A"></div>
      <div class="field"><label>Remark (optional)</label><input type="text" id="pr-remark" value="${esc(existing ? existing.remark || '' : '')}"></div>
      ${existing && existing.sentAt ? `
        <p class="meta" style="margin-bottom:10px;">Already sent -- changes save in place. Use Resend on the list if the student should be notified again.</p>
      ` : `
        <p class="meta" style="margin-bottom:10px;">"Save and Send" delivers it to the student right away. "Save" keeps it as a draft you can send later, individually or all at once with "Publish results".</p>
      `}
      <div style="display:flex; gap:10px; margin-top:10px; flex-wrap:wrap;">
        ${existing && existing.sentAt
          ? `<button class="btn btn-primary" id="pr-save">Save changes</button>`
          : `<button class="btn btn-primary" id="pr-save-send">Save and Send</button><button class="btn btn-ghost" id="pr-save">Save</button>`}
        <button class="btn btn-ghost" id="pr-cancel">Cancel</button>
      </div>
    `;
    const backdrop = document.createElement('div');
    backdrop.style.cssText = 'position:fixed; inset:0; background:rgba(20,32,51,0.45); z-index:190;';
    document.body.appendChild(backdrop);
    document.body.appendChild(container);
    if (!existing) {
      async function loadStudents(courseId) {
        const studentSelect = container.querySelector('#pr-student');
        if (!courseId) { studentSelect.innerHTML = '<option value="">No class selected</option>'; return; }
        const { students } = await api(`/courses/${courseId}/roster`);
        studentSelect.innerHTML = students.map((s) => `<option value="${s.id}">${esc(s.fullName)} (${esc(s.matricNumber || '—')})</option>`).join('') || '<option value="">No students enrolled</option>';
      }
      loadStudents(courses[0] && courses[0].id);
      container.querySelector('#pr-course').addEventListener('change', (e) => loadStudents(e.target.value));
    }
    function close() { backdrop.remove(); container.remove(); }
    container.querySelector('#pr-cancel').addEventListener('click', close);
    async function save(send) {
      const term = container.querySelector('#pr-term').value.trim();
      const score = container.querySelector('#pr-score').value;
      const grade = container.querySelector('#pr-grade').value.trim() || null;
      const remark = container.querySelector('#pr-remark').value.trim() || null;
      try {
        if (existing) {
          await api(`/results/${existing.id}`, { method: 'PUT', body: { term, score, grade, remark } });
          toast('Result updated');
        } else {
          const courseId = container.querySelector('#pr-course').value;
          const studentId = container.querySelector('#pr-student').value;
          if (!studentId) return toast('No student to save this for.');
          await api(`/courses/${courseId}/results`, { method: 'POST', body: { studentId, send, term, score, grade, remark } });
          toast(send ? 'Result saved and sent' : 'Result saved as a draft');
        }
        close();
        render();
      } catch (err) { toast(err.message); }
    }
    const sendBtn = container.querySelector('#pr-save-send');
    if (sendBtn) sendBtn.addEventListener('click', () => save(true));
    container.querySelector('#pr-save').addEventListener('click', () => save(false));
  }

  // Which types the dropdown offers depends on where this dialog was opened from --
  // Tests and Semester Exam are separate, disjoint sidebar pages now (they used to
  // share one "everything" list, which read as the same screen twice), so the type
  // choices offered here mirror that split instead of listing every type always.
  // "Assignment" was removed entirely -- that's the real Assignment/Project model
  // and its own screen (free-text instructions + manual marking), not an Assessment.
  const ASSESSMENT_TYPE_LABELS = { CA: 'CA', Test: 'Test', Mock: 'Mock', SEMESTER_EXAM: 'Semester Exam', PAST_QUESTION: 'Past Question', Classwork: 'Classwork', Quiz: 'Quiz' };
  // Singular, human label for whichever type this dialog is scoped to -- drives the
  // dialog title and save-button wording so it reads "New test"/"Edit test" instead of
  // always the generic "New assessment", which is what the lecturer was actually
  // seeing on the Tests/Semester Exam pages regardless of which one they were on.
  function assessmentKindLabel(allowedTypes) {
    const key = [...allowedTypes].sort().join(',');
    const KNOWN_COMBOS = {
      'Classwork,Quiz': 'classwork/quiz',
      'CA,Mock,Test': 'test',
    };
    if (KNOWN_COMBOS[key]) return KNOWN_COMBOS[key];
    if (allowedTypes.length !== 1) return 'assessment';
    return { CA: 'assessment', Test: 'test', Mock: 'mock test', SEMESTER_EXAM: 'semester exam', PAST_QUESTION: 'past question set', Classwork: 'classwork', Quiz: 'quiz' }[allowedTypes[0]] || 'assessment';
  }

  // Shared Objective/Theory question editor block -- used by the lecturer's
  // assessment composer below and by the admin's aptitude-test composer, so both
  // read the exact same segmented-toggle UI and question shape.
  function questionBlock(i, q) {
    const isTheory = q && q.questionType === 'THEORY';
    const opts4 = q && !isTheory ? JSON.parse(q.options || '[]') : [];
    return `<div class="field" data-question-block="${i}">
      <label>Question ${i + 1}</label>
      <div class="tabs q-type" data-value="${isTheory ? 'THEORY' : 'OBJECTIVE'}" style="margin:0 0 10px;">
        <button type="button" class="tab-btn ${!isTheory ? 'active' : ''}" data-val="OBJECTIVE">Objective (multiple choice)</button>
        <button type="button" class="tab-btn ${isTheory ? 'active' : ''}" data-val="THEORY">Theory (free response)</button>
      </div>
      <input type="text" class="q-text" placeholder="Question text" value="${esc(q ? q.text : '')}" required>
      <div class="q-objective-fields" ${isTheory ? 'hidden' : ''}>
        <input type="text" class="q-opt" placeholder="Option A" value="${esc(opts4[0] || '')}" style="margin-top:6px;">
        <input type="text" class="q-opt" placeholder="Option B" value="${esc(opts4[1] || '')}" style="margin-top:6px;">
        <input type="text" class="q-opt" placeholder="Option C" value="${esc(opts4[2] || '')}" style="margin-top:6px;">
        <input type="text" class="q-opt" placeholder="Option D" value="${esc(opts4[3] || '')}" style="margin-top:6px;">
        <select class="q-correct" style="margin-top:6px;">
          <option value="0" ${q && q.correctIndex === 0 ? 'selected' : ''}>Correct: Option A</option><option value="1" ${q && q.correctIndex === 1 ? 'selected' : ''}>Correct: Option B</option>
          <option value="2" ${q && q.correctIndex === 2 ? 'selected' : ''}>Correct: Option C</option><option value="3" ${q && q.correctIndex === 3 ? 'selected' : ''}>Correct: Option D</option>
        </select>
        <textarea class="q-explanation" placeholder="Briefly explain why this is correct (shown to students when they review mistakes)" style="margin-top:6px; width:100%;" rows="2">${esc(q ? q.explanation || '' : '')}</textarea>
      </div>
      <textarea class="q-model-answer" placeholder="Correct / model answer (not shown to the student or applicant)" style="margin-top:6px; width:100%;" ${isTheory ? '' : 'hidden'} rows="2">${esc(isTheory ? (q.modelAnswer || '') : '')}</textarea>
    </div>`;
  }
  // A visible segmented toggle rather than a native <select> that only ever shows
  // its current value -- lecturers were missing that Theory was even an option
  // since nothing on screen hinted a second choice existed behind the dropdown.
  function wireQuestionTypeToggle(block) {
    const typeToggle = block.querySelector('.q-type');
    const objectiveFields = block.querySelector('.q-objective-fields');
    const modelAnswer = block.querySelector('.q-model-answer');
    typeToggle.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        typeToggle.dataset.value = btn.dataset.val;
        typeToggle.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
        const isTheory = btn.dataset.val === 'THEORY';
        objectiveFields.hidden = isTheory;
        modelAnswer.hidden = !isTheory;
      });
    });
  }
  // Reads every question block in a container back into the same shape the backend
  // expects, filtering out any left fully blank (a stray "+ Add question" click with
  // nothing typed in it).
  function readQuestionBlocks(container) {
    const blocks = container.querySelectorAll('[data-question-block]');
    return Array.from(blocks).map((b) => {
      const questionType = b.querySelector('.q-type').dataset.value;
      const text = b.querySelector('.q-text').value;
      if (questionType === 'THEORY') {
        return { questionType, text, modelAnswer: b.querySelector('.q-model-answer').value };
      }
      return {
        questionType,
        text,
        options: Array.from(b.querySelectorAll('.q-opt')).map((i) => i.value).filter(Boolean),
        correctIndex: Number(b.querySelector('.q-correct').value),
        explanation: b.querySelector('.q-explanation') ? (b.querySelector('.q-explanation').value.trim() || null) : null,
      };
    }).filter((q) => q.text && (q.questionType === 'THEORY' || q.options.length >= 2));
  }

  // opts.existing (an already-loaded assessment with its full questions, e.g. from
  // GET /assessments/:id) switches this into edit mode: fields prefill, the course is
  // fixed (can't move a test to a different class), and saving PUTs in place instead
  // of creating a new one.
  function openNewAssessmentDialog(courses, opts = {}) {
    const { existing } = opts;
    const container = document.createElement('div');
    container.className = 'card';
    container.style.cssText = 'position:fixed; inset:0; margin:auto; width:min(560px,92vw); height:fit-content; max-height:86vh; overflow-y:auto; padding:24px; z-index:200;';
    let qCount = 1;
    const allowedTypes = opts.allowedTypes || ['CA', 'Test', 'Mock', 'PAST_QUESTION'];
    const kindLabel = assessmentKindLabel(allowedTypes);
    const lockedType = existing ? existing.type : (allowedTypes.length === 1 ? allowedTypes[0] : null);
    const typeFieldHtml = lockedType
      ? `<div class="field"><label>Type</label><div style="padding:10px 0; font-weight:600;">${esc(ASSESSMENT_TYPE_LABELS[lockedType] || lockedType)}</div><input type="hidden" id="na-type" value="${lockedType}"></div>`
      : `<div class="field"><label>Type</label><select id="na-type">${allowedTypes.map((t) => `<option value="${t}" ${opts.defaultType === t ? 'selected' : ''}>${esc(ASSESSMENT_TYPE_LABELS[t])}</option>`).join('')}</select></div>`;
    const course = existing ? courses.find((c) => c.id === existing.courseId) : null;
    const courseFieldHtml = existing
      ? `<div class="field"><label>Class (course)</label><div style="padding:10px 0; font-weight:600;">${course ? esc(`${course.code} — ${course.title}`) : ''}</div></div>`
      : `<div class="field"><label>Class (course)</label><select id="na-course">${courses.map((c) => `<option value="${c.id}">${esc(c.code)} — ${esc(c.title)}</option>`).join('')}</select></div>`;
    container.innerHTML = `
      <h3 style="margin-bottom:14px;">${existing ? 'Edit' : 'Set new'} ${esc(kindLabel)}</h3>
      ${courseFieldHtml}
      <div class="field"><label>Title</label><input type="text" id="na-title" value="${esc(existing ? existing.title : '')}" required></div>
      ${typeFieldHtml}
      <p class="meta" id="na-cap-note" style="margin-bottom:10px;"></p>
      <p class="meta" style="margin-bottom:14px;">Students get 1 minute per question automatically — no need to set a duration.</p>
      <div id="na-questions">${existing ? existing.questions.map((q, i) => questionBlock(i, q)).join('') : questionBlock(0)}</div>
      <button type="button" class="btn btn-ghost btn-sm" id="na-add-q" style="margin-bottom:14px;">+ Add question</button>
      ${existing && existing.sentAt ? `
        <p class="meta" style="margin-bottom:10px;">Already sent -- changes save in place without re-sending. Use Resend on the list if you want students notified again.</p>
      ` : `
        <p class="meta" style="margin-bottom:10px;">"Save and Send" notifies the class now. "Save" keeps it as a draft you can review, edit, and send later -- even tomorrow.</p>
      `}
      <div style="display:flex; gap:10px; flex-wrap:wrap;">
        ${existing && existing.sentAt
          ? `<button class="btn btn-primary" id="na-save">Save changes</button>`
          : `<button class="btn btn-primary" id="na-save-send">Save and Send</button><button class="btn btn-ghost" id="na-save">Save</button>`}
        <button class="btn btn-ghost" id="na-cancel">Cancel</button>
      </div>
    `;
    qCount = existing ? existing.questions.length : 1;
    const backdrop = document.createElement('div');
    backdrop.style.cssText = 'position:fixed; inset:0; background:rgba(20,32,51,0.45); z-index:190;';
    document.body.appendChild(backdrop);
    document.body.appendChild(container);

    function maxQuestions() {
      return container.querySelector('#na-type').value === 'PAST_QUESTION' ? 20 : 10;
    }
    function updateCapNote() {
      const max = maxQuestions();
      container.querySelector('#na-cap-note').textContent = `Up to ${max} questions for this type.`;
      container.querySelector('#na-add-q').disabled = container.querySelectorAll('[data-question-block]').length >= max;
    }
    container.querySelector('#na-type').addEventListener('change', updateCapNote);
    updateCapNote();
    container.querySelectorAll('[data-question-block]').forEach(wireQuestionTypeToggle);

    container.querySelector('#na-add-q').addEventListener('click', () => {
      if (container.querySelectorAll('[data-question-block]').length >= maxQuestions()) return;
      const div = document.createElement('div');
      div.innerHTML = questionBlock(qCount++);
      const block = div.firstElementChild;
      container.querySelector('#na-questions').appendChild(block);
      wireQuestionTypeToggle(block);
      updateCapNote();
    });
    function close() { backdrop.remove(); container.remove(); }
    container.querySelector('#na-cancel').addEventListener('click', close);
    async function save(send) {
      const questions = readQuestionBlocks(container);
      if (!questions.length) { toast('Add at least one complete question'); return; }
      const title = container.querySelector('#na-title').value;
      try {
        if (existing) {
          await api(`/assessments/${existing.id}`, {
            method: 'PUT',
            body: { title, questions, send: existing.sentAt ? undefined : send },
          });
          const Kind = kindLabel.charAt(0).toUpperCase() + kindLabel.slice(1);
          toast(existing.sentAt ? 'Changes saved' : send ? `${Kind} saved and sent` : `${Kind} saved as a draft`);
        } else {
          await api(`/courses/${container.querySelector('#na-course').value}/assessments`, {
            method: 'POST',
            body: { title, type: container.querySelector('#na-type').value, questions, send },
          });
          const Kind = kindLabel.charAt(0).toUpperCase() + kindLabel.slice(1);
          toast(send ? `${Kind} saved and sent` : `${Kind} saved as a draft`);
        }
        close();
        render();
      } catch (err) { toast(err.message); }
    }
    const sendBtn = container.querySelector('#na-save-send');
    if (sendBtn) sendBtn.addEventListener('click', () => save(true));
    container.querySelector('#na-save').addEventListener('click', () => save(existing && existing.sentAt ? undefined : false));
  }

  async function renderAssessmentResults() {
    const { submissions } = await api(`/assessments/${state.view.assessmentId}/results`);
    view.innerHTML = `
      <div class="page-head"><h1>Results</h1><button class="btn btn-ghost btn-sm" id="back-btn">← Back</button></div>
      <div class="card" style="overflow-x:auto;">
        <table class="data-table">
          <thead><tr><th>Student</th><th>Matric No.</th><th>Score</th></tr></thead>
          <tbody>
            ${submissions.map((s) => `<tr><td>${esc(s.student.fullName)}</td><td class="tabular">${esc(s.student.matricNumber || '—')}</td><td class="tabular">${s.score}/${s.total}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No submissions yet.</td></tr>'}
          </tbody>
        </table>
      </div>
    `;
    document.getElementById('back-btn').addEventListener('click', () => navigate(state.view.backTo || 'lect-tests'));
  }

  // Read-only, school-wide view of every test/exam set by any lecturer -- admin can
  // drill into questions and results but not create/edit (that's the lecturer's job).
  // Shared by "Semester Exam" and "Tests" in the admin sidebar (same structure,
  // different type filter); each reads live off the same Assessment rows the
  // lecturer's own screen writes to -- there's no caching/approval step in between --
  // grouped department by department so a large school stays scannable. Clicking one
  // shows every question (and, via View results, every score) in it.
  async function renderAdminAssessmentTypeView(heading, types, backTo, emptyNote) {
    const { departments } = await api(`/departments?schoolId=${state.user.schoolId}`);
    const deptRows = await Promise.all(departments.map(async (d) => {
      const { courses } = await api(`/departments/${d.id}/courses`);
      const rows = (await Promise.all(courses.map(async (c) => {
        const { assessments } = await api(`/courses/${c.id}/assessments`);
        const matches = assessments.filter((a) => types.includes(a.type));
        return matches.length ? { course: c, exams: matches } : null;
      }))).filter(Boolean);
      return { department: d, rows };
    }));
    const nonEmpty = deptRows.filter((d) => d.rows.length);
    view.innerHTML = `
      <div class="page-head"><h1>${esc(heading)}</h1></div>
      <p class="muted" style="margin-bottom:18px;">Every ${heading.toLowerCase()} a lecturer sets appears here immediately, grouped by department. Click one to see its full question set, answers, and results.</p>
      ${nonEmpty.map(({ department, rows }) => `
        <h3 style="margin:20px 0 10px; font-size:1rem;">${esc(department.name)}</h3>
        ${rows.map(({ course, exams }) => `
          <div style="margin-bottom:18px;">
            <div class="muted" style="font-weight:700; margin-bottom:8px;">${course.code ? `${esc(course.code)} — ` : ''}${esc(course.title)}</div>
            <div class="card">
              ${exams.map((a) => `
                <div class="list-row clickable" data-exam="${a.id}" style="cursor:pointer;">
                  <div><div style="font-weight:600;">${esc(a.title)} ${a.sentAt ? '<span class="pill pill-pass" style="margin-left:6px;">Sent</span>' : '<span class="pill pill-muted" style="margin-left:6px;">Draft</span>'}</div><div class="meta">${esc(a.type)} · ${a._count.questions} question${a._count.questions === 1 ? '' : 's'} · ${a._count.questions} min</div></div>
                  <span class="pill pill-accent">View questions</span>
                </div>
              `).join('')}
            </div>
          </div>
        `).join('')}
      `).join('') || `<p class="muted">${esc(emptyNote)}</p>`}
    `;
    view.querySelectorAll('[data-exam]').forEach((el) => {
      el.addEventListener('click', () => navigate('admin-exam-questions', { assessmentId: el.dataset.exam, backTo }));
    });
  }
  function renderAdminSemesterExam() {
    return renderAdminAssessmentTypeView('Semester Exam', ['SEMESTER_EXAM'], 'admin-semester-exam', 'No semester exams set yet.');
  }
  function renderAdminTests() {
    return renderAdminAssessmentTypeView('Tests', ['CA', 'Test', 'Mock'], 'admin-tests', 'No tests set yet.');
  }

  // Full question set for one exam/test -- correct answers/model answers included,
  // since this is an admin-only read (GET /assessments/:id returns the raw questions
  // for any non-STUDENT role already).
  async function renderAdminExamQuestions() {
    const { assessmentId, backTo } = state.view;
    const { assessment } = await api(`/assessments/${assessmentId}`);
    view.innerHTML = `
      <div class="page-head"><h1>${esc(assessment.title)}</h1><button class="btn btn-ghost btn-sm" id="back-btn">← Back</button></div>
      <p class="muted" style="margin-bottom:16px;">${assessment.questions.length} question${assessment.questions.length === 1 ? '' : 's'}</p>
      <div class="card" style="padding:20px; margin-bottom:18px;">
        ${assessment.questions.map((q, i) => `
          <div style="${i < assessment.questions.length - 1 ? 'margin-bottom:18px; padding-bottom:18px; border-bottom:1px solid var(--line);' : ''}">
            <div style="font-weight:600; margin-bottom:8px;">${i + 1}. ${esc(q.text)}</div>
            ${q.questionType === 'THEORY'
              ? `<div class="meta">Model answer: ${esc(q.modelAnswer || '—')}</div>`
              : `<div style="display:flex; flex-direction:column; gap:4px;">${JSON.parse(q.options || '[]').map((o, idx) => `<div class="meta" style="${idx === q.correctIndex ? 'color:var(--pass); font-weight:600;' : ''}">${OPTION_LABELS[idx]}) ${esc(o)}${idx === q.correctIndex ? ' ✓' : ''}</div>`).join('')}</div>`}
          </div>
        `).join('')}
      </div>
      <button class="btn btn-ghost btn-sm" id="results-btn">View results</button>
    `;
    document.getElementById('back-btn').addEventListener('click', () => navigate(backTo || 'admin-semester-exam'));
    document.getElementById('results-btn').addEventListener('click', () => navigate('lect-assessment-results', { assessmentId: assessment.id, backTo: backTo || 'admin-semester-exam' }));
  }

  // ================= STAFF PROFILE (attendance, CPD, publications) =================

  async function renderStaffProfile() {
    const [{ records: attendance }, { records: cpd }, { records: publications }] = await Promise.all([
      api('/staff/attendance/me'),
      api('/staff/cpd/me'),
      api('/staff/publications/me'),
    ]);
    const checkedInToday = attendance.some((r) => new Date(r.date).toDateString() === new Date().toDateString());

    view.innerHTML = `
      <div class="page-head"><h1>My Staff Profile</h1></div>

      <div class="card" style="padding:20px; margin-bottom:22px; display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap;">
        <div>
          <div style="font-weight:600;">Attendance</div>
          <div class="meta">${checkedInToday ? 'You\'re checked in for today.' : 'Not checked in yet today.'}</div>
        </div>
        <button class="btn ${checkedInToday ? 'btn-ghost' : 'btn-primary'}" id="checkin-btn" ${checkedInToday ? 'disabled' : ''}>${checkedInToday ? 'Checked in ✓' : 'Check in today'}</button>
      </div>
      <div class="card" style="margin-bottom:22px; overflow-x:auto;">
        <table class="data-table">
          <thead><tr><th>Date</th><th>Status</th></tr></thead>
          <tbody>${attendance.slice(0, 10).map((r) => `<tr><td class="tabular">${new Date(r.date).toLocaleDateString()}</td><td>${esc(r.status)}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">No attendance recorded yet.</td></tr>'}</tbody>
        </table>
      </div>

      <div class="card" style="padding:20px; margin-bottom:22px;">
        <h3 style="margin-bottom:12px; font-size:1rem;">Log a CPD activity</h3>
        <form id="cpd-form">
          <div class="field"><label>Title</label><input type="text" id="cpd-title" required></div>
          <div class="field"><label>Provider</label><input type="text" id="cpd-provider" required></div>
          <div class="field"><label>Hours</label><input type="number" id="cpd-hours" min="1" required></div>
          <div class="field"><label>Date completed</label><input type="date" id="cpd-date" required></div>
          <button class="btn btn-primary" type="submit">Add CPD record</button>
        </form>
      </div>
      <div class="card" style="margin-bottom:22px;">
        ${cpd.map((c) => `<div class="list-row"><div><div style="font-weight:600;">${esc(c.title)}</div><div class="meta">${esc(c.provider)} · ${c.hours}h · ${new Date(c.completedAt).toLocaleDateString()}</div></div></div>`).join('') || '<p class="muted" style="padding:16px;">No CPD records yet.</p>'}
      </div>

      <div class="card" style="padding:20px; margin-bottom:22px;">
        <h3 style="margin-bottom:12px; font-size:1rem;">Log a publication</h3>
        <form id="pub-form">
          <div class="field"><label>Title</label><input type="text" id="pub-title" required></div>
          <div class="field"><label>Outlet / journal</label><input type="text" id="pub-outlet" required></div>
          <div class="field"><label>Year</label><input type="number" id="pub-year" min="1990" max="2100" required></div>
          <div class="field"><label>Link (optional)</label><input type="url" id="pub-url" placeholder="https://"></div>
          <button class="btn btn-primary" type="submit">Add publication</button>
        </form>
      </div>
      <div class="card">
        ${publications.map((p) => `<div class="list-row"><div><div style="font-weight:600;">${esc(p.title)}</div><div class="meta">${esc(p.outlet)} · ${p.year}${p.url ? ` · <a href="${esc(p.url)}" target="_blank" rel="noopener">Link</a>` : ''}</div></div></div>`).join('') || '<p class="muted" style="padding:16px;">No publications logged yet.</p>'}
      </div>
    `;

    const checkinBtn = document.getElementById('checkin-btn');
    if (!checkedInToday) checkinBtn.addEventListener('click', async () => { await api('/staff/attendance/checkin', { method: 'POST' }); toast('Checked in'); render(); });

    document.getElementById('cpd-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      await api('/staff/cpd', {
        method: 'POST',
        body: {
          title: document.getElementById('cpd-title').value,
          provider: document.getElementById('cpd-provider').value,
          hours: document.getElementById('cpd-hours').value,
          completedAt: document.getElementById('cpd-date').value,
        },
      });
      toast('CPD record added');
      render();
    });

    document.getElementById('pub-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      await api('/staff/publications', {
        method: 'POST',
        body: {
          title: document.getElementById('pub-title').value,
          outlet: document.getElementById('pub-outlet').value,
          year: document.getElementById('pub-year').value,
          url: document.getElementById('pub-url').value.trim() || null,
        },
      });
      toast('Publication added');
      render();
    });
  }

  // ================= ADMIN =================

  function statusPillHtml(status) {
    const cls = status === 'ACTIVE' ? 'pill-pass' : status === 'SUSPENDED' ? 'pill-accent' : 'pill-danger';
    return `<span class="pill ${cls}">${esc(status || 'ACTIVE')}</span>`;
  }

  // Three banners -> a shared list/detail implementation, parameterized by type, so
  // academic staff, non-academic staff and students don't need three near-identical
  // screens each.
  const DIRECTORY_TYPES = {
    ACADEMIC: {
      label: 'Academic Staff', base: '/admin/lecturers', listKey: 'lecturers', detailKey: 'lecturer',
      idLabel: 'Staff ID', idField: 'staffId', extraLabel: 'Course(s)',
      extraValue: (u) => (u.courses || []).map((c) => c.code).join(', ') || '—',
      generatesAccessCode: true,
      actions: [
        { key: 'suspend', label: 'Suspend', show: (u) => u.status === 'ACTIVE' },
        { key: 'lift-suspension', label: 'Lift suspension', show: (u) => u.status === 'SUSPENDED' },
        { key: 'dismiss', label: 'Dismiss', show: (u) => u.status !== 'DISMISSED' },
      ],
      addFields: [
        { key: 'fullName', label: 'Full name', required: true },
        { key: 'staffId', label: 'Staff ID' },
        { key: 'departmentId', label: 'Department', type: 'department', required: true },
        { key: 'courseIds', label: 'Course(s) taught', type: 'courses' },
        { key: 'email', label: 'Email', type: 'email', required: true },
        { key: 'phone', label: 'Phone number', type: 'tel' },
      ],
      editFields: [
        { key: 'fullName', label: 'Full name', required: true },
        { key: 'staffId', label: 'Staff ID' },
        { key: 'departmentId', label: 'Department', type: 'department', required: true },
        { key: 'courseIds', label: 'Course(s) taught', type: 'courses' },
        { key: 'phone', label: 'Phone number', type: 'tel' },
      ],
    },
    NON_ACADEMIC: {
      label: 'Non-Academic Staff', base: '/admin/non-academic-staff', listKey: 'staff', detailKey: 'staff',
      idLabel: 'Staff ID', idField: 'staffId', extraLabel: 'Position',
      extraValue: (u) => u.position || '—',
      generatesAccessCode: false,
      actions: [
        { key: 'suspend', label: 'Suspend', show: (u) => u.status === 'ACTIVE' },
        { key: 'lift-suspension', label: 'Lift suspension', show: (u) => u.status === 'SUSPENDED' },
        { key: 'dismiss', label: 'Dismiss', show: (u) => u.status !== 'DISMISSED' },
      ],
      addFields: [
        { key: 'fullName', label: 'Full name', required: true },
        { key: 'staffId', label: 'Staff ID' },
        { key: 'position', label: 'Position', required: true },
        { key: 'departmentId', label: 'Department', type: 'department' },
        { key: 'email', label: 'Email', type: 'email', required: true },
        { key: 'phone', label: 'Phone number', type: 'tel' },
      ],
      editFields: [
        { key: 'fullName', label: 'Full name', required: true },
        { key: 'staffId', label: 'Staff ID' },
        { key: 'position', label: 'Position', required: true },
        { key: 'departmentId', label: 'Department', type: 'department' },
        { key: 'phone', label: 'Phone number', type: 'tel' },
      ],
    },
    STUDENT: {
      label: 'Students', base: '/admin/students', listKey: 'students', detailKey: 'student',
      idLabel: 'Matric No.', idField: 'matricNumber', extraLabel: 'Course(s)',
      extraValue: (u) => (u.courses || []).map((c) => c.code).join(', ') || '—',
      generatesAccessCode: true,
      actions: [
        { key: 'suspend', label: 'Suspend', show: (u) => u.status === 'ACTIVE' },
        { key: 'lift-suspension', label: 'Lift suspension', show: (u) => u.status === 'SUSPENDED' },
        { key: 'expel', label: 'Expel', show: (u) => u.status !== 'EXPELLED' },
      ],
      addFields: [
        { key: 'fullName', label: 'Full name', required: true },
        { key: 'matricNumber', label: 'Matric number', required: true },
        { key: 'departmentId', label: 'Department', type: 'department', required: true },
        { key: 'yearOfStudy', label: 'Level', type: 'year', required: true },
        { key: 'courseIds', label: 'Course(s)', type: 'courses' },
        { key: 'email', label: 'Email', type: 'email', required: true },
        { key: 'phone', label: 'Phone number', type: 'tel' },
      ],
      editFields: [
        { key: 'fullName', label: 'Full name', required: true },
        { key: 'matricNumber', label: 'Matric number', required: true },
        { key: 'departmentId', label: 'Department', type: 'department', required: true },
        { key: 'yearOfStudy', label: 'Level', type: 'year', required: true },
        { key: 'courseIds', label: 'Course(s)', type: 'courses' },
        { key: 'phone', label: 'Phone number', type: 'tel' },
      ],
    },
  };

  async function departmentOptionsHtml(selectedId) {
    const { departments } = await api(`/departments?schoolId=${state.user.schoolId}`);
    return departments.map((d) => `<option value="${d.id}" ${d.id === selectedId ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
  }

  async function courseOptionsHtml(selectedIds) {
    const { courses } = await api('/admin/courses');
    const selected = new Set(selectedIds || []);
    return courses.map((c) => `<option value="${c.id}" ${selected.has(c.id) ? 'selected' : ''}>${esc(c.department.name)} — ${esc(c.code)}</option>`).join('');
  }

  // ================= ADMIN: DASHBOARD + ADMIN MANAGEMENT =================

  async function renderAdminDashboard() {
    const u = state.user;
    const [{ school }, { students }, { lecturers }, { staff }] = await Promise.all([
      api('/admin/school'),
      api('/admin/students'),
      api('/admin/lecturers'),
      api('/admin/non-academic-staff'),
    ]);
    view.innerHTML = `
      <div class="page-head"><h1>My Dashboard</h1></div>
      <div class="card" style="padding:20px; margin-bottom:22px; display:flex; align-items:center; gap:16px;">
        ${selfAvatarHtml('avatar-admin-dash')}
        <div>
          <div>${esc(u.fullName)} · Admin</div>
          <div>${[school.name, school.location].filter(Boolean).map(esc).join(', ')}</div>
        </div>
      </div>
      <div class="grid-cards" style="margin-bottom:26px;">
        <div class="card course-card" data-jump-nav="admin-directory" style="cursor:pointer;"><div class="code">${students.length}</div><div class="meta">Students</div></div>
        <div class="card course-card" data-jump-nav="admin-directory" style="cursor:pointer;"><div class="code">${lecturers.length}</div><div class="meta">Lecturers</div></div>
        <div class="card course-card" data-jump-nav="admin-directory" style="cursor:pointer;"><div class="code">${staff.length}</div><div class="meta">Non-academic staff</div></div>
      </div>
    `;
    wireSelfAvatarUpload('avatar-admin-dash');
    view.querySelectorAll('[data-jump-nav]').forEach((el) => el.addEventListener('click', () => navigate(el.dataset.jumpNav)));
  }

  // A school can have more than one admin (e.g. a vice-principal or registrar
  // alongside the principal) -- its own sidebar page now rather than living on the
  // dashboard homepage. The add-admin form shows the school name/location as
  // read-only context (which school this new admin belongs to) above the fields that
  // actually get filled in; the creating admin sets the password directly here and
  // hands it to the new admin along with their email, rather than an auto-generated
  // one-time code.
  async function renderAdminManagement() {
    const u = state.user;
    const [{ school }, { admins }] = await Promise.all([api('/admin/school'), api('/admin/admins')]);
    view.innerHTML = `
      <div class="page-head">
        <h1>Admin Management</h1>
        <button class="btn btn-accent btn-sm" id="add-admin-btn">+ Add Admin</button>
      </div>
      <p class="muted" style="margin-bottom:14px;">Other admin accounts for ${esc(school.name)} -- e.g. a vice-principal or registrar who also needs full admin access.</p>
      <div id="add-admin-box" hidden></div>
      <div class="card">
        ${admins.map((a) => `
          <div class="list-row">
            <div>
              <div style="font-weight:600;">${esc(a.fullName)} ${a.id === u.id ? '<span class="pill pill-muted" style="margin-left:6px;">You</span>' : ''}</div>
              <div class="meta">${esc(a.email)}${a.phone ? ` · ${esc(a.phone)}` : ''}</div>
            </div>
            <div style="display:flex; align-items:center; gap:8px;">
              ${statusPillHtml(a.status)}
              ${a.id !== u.id && a.status === 'ACTIVE' ? `<button class="btn btn-ghost btn-sm" data-remove-admin="${a.id}" data-name="${esc(a.fullName)}">Remove</button>` : ''}
            </div>
          </div>
        `).join('') || '<p class="muted" style="padding:16px;">No admins yet.</p>'}
      </div>
    `;
    document.getElementById('add-admin-btn').addEventListener('click', () => {
      const box = document.getElementById('add-admin-box');
      box.hidden = !box.hidden;
      if (box.hidden) return;
      box.innerHTML = `
        <form id="add-admin-form" class="card" style="padding:20px; margin-bottom:18px;">
          <div class="field"><label>School name</label><div style="padding:10px 0; font-weight:600;">${esc(school.name)}</div></div>
          <div class="field"><label>Location / campus</label><div style="padding:10px 0; font-weight:600;">${esc(school.location || '—')}</div></div>
          <div class="field"><label>Full name</label><input type="text" id="aa-name" required></div>
          <div class="field"><label>Email</label><input type="email" id="aa-email" required></div>
          <div class="field"><label>Phone number</label><input type="tel" id="aa-phone"></div>
          <div class="field"><label>Password</label><input type="password" id="aa-password" required minlength="6"></div>
          <p class="meta" style="margin-bottom:10px;">Give this email and password to the new admin -- that's what they'll log in with.</p>
          <button class="btn btn-primary" type="submit">Add admin</button>
        </form>
      `;
      document.getElementById('add-admin-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const { user } = await api('/admin/admins', {
            method: 'POST',
            body: {
              fullName: document.getElementById('aa-name').value.trim(),
              email: document.getElementById('aa-email').value.trim(),
              phone: document.getElementById('aa-phone').value.trim(),
              password: document.getElementById('aa-password').value,
            },
          });
          toast(`${user.fullName} added as admin`);
          render();
        } catch (err) { toast(err.message); }
      });
    });
    view.querySelectorAll('[data-remove-admin]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Remove ${btn.dataset.name} as admin? They will no longer be able to log in.`)) return;
        try {
          await api(`/admin/admins/${btn.dataset.removeAdmin}/remove`, { method: 'POST' });
          toast('Admin removed');
          render();
        } catch (err) { toast(err.message); }
      });
    });
  }

  async function renderAdminDirectory() {
    view.innerHTML = `
      <div class="page-head"><h1>Staff & Student Directory</h1></div>
      <div class="grid-cards">
        <div class="card course-card" data-type="ACADEMIC"><div class="code">Academic Staff</div><div class="meta">Lecturers</div></div>
        <div class="card course-card" data-type="NON_ACADEMIC"><div class="code">Non-Academic Staff</div><div class="meta">Librarians, admin staff, and other non-teaching roles</div></div>
        <div class="card course-card" data-type="STUDENT"><div class="code">Students</div><div class="meta">All enrolled students</div></div>
      </div>
    `;
    view.querySelectorAll('[data-type]').forEach((el) => {
      el.addEventListener('click', () => navigate('admin-directory-list', { directoryType: el.dataset.type }));
    });
  }

  async function renderAdminDirectoryList() {
    const cfg = DIRECTORY_TYPES[state.view.directoryType];
    const { [cfg.listKey]: items } = await api(cfg.base);
    const idNoun = state.view.directoryType === 'STUDENT' ? 'matric number' : 'staff ID';

    function rowsHtml(list) {
      return list.map((u) => `<tr class="clickable" data-id="${u.id}" style="cursor:pointer;">
            <td>${esc(u.fullName)}</td><td class="tabular">${esc(u[cfg.idField] || '—')}</td><td>${esc(u.department ? u.department.name : '—')}</td><td>${esc(cfg.extraValue(u))}</td>
            <td>${statusPillHtml(u.status)}</td>
          </tr>`).join('') || `<tr><td colspan="5" class="muted" style="padding:16px;">None yet.</td></tr>`;
    }

    view.innerHTML = `
      <div class="page-head">
        <h1>${cfg.label}</h1>
        <div style="display:flex; gap:10px;">
          <button class="btn btn-accent btn-sm" id="add-btn">+ Add</button>
          <button class="btn btn-ghost btn-sm" id="back-btn">← Back</button>
        </div>
      </div>
      <div class="field" style="max-width:340px; margin-bottom:16px;">
        <input type="text" id="directory-search" placeholder="Search by name or ${idNoun}…" style="width:100%; padding:10px 12px; border-radius:10px; border:1px solid var(--line); background:var(--paper); color:var(--ink);">
      </div>
      <div id="add-box" hidden></div>
      <div class="card" style="overflow-x:auto;">
        <table class="data-table">
          <thead><tr><th>Name</th><th>${cfg.idLabel}</th><th>Department</th><th>${cfg.extraLabel}</th><th>Status</th></tr></thead>
          <tbody id="directory-tbody">${rowsHtml(items)}</tbody>
        </table>
      </div>
    `;
    function wireRows() {
      view.querySelectorAll('tr[data-id]').forEach((row) => {
        row.addEventListener('click', () => navigate('admin-directory-detail', { directoryType: state.view.directoryType, userId: row.dataset.id }));
      });
    }
    wireRows();
    document.getElementById('directory-search').addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      const filtered = !q ? items : items.filter((u) =>
        (u.fullName || '').toLowerCase().includes(q) || (u[cfg.idField] || '').toLowerCase().includes(q)
      );
      document.getElementById('directory-tbody').innerHTML = rowsHtml(filtered);
      wireRows();
    });
    document.getElementById('back-btn').addEventListener('click', () => navigate('admin-directory'));
    document.getElementById('add-btn').addEventListener('click', async () => {
      const box = document.getElementById('add-box');
      box.hidden = !box.hidden;
      if (box.hidden) return;
      const fieldsHtml = await Promise.all(cfg.addFields.map(async (f) => {
        if (f.type === 'department') {
          return `<div class="field"><label>${f.label}</label><select id="add-${f.key}" ${f.required ? 'required' : ''}><option value="">${f.required ? 'Select…' : 'None'}</option>${await departmentOptionsHtml()}</select></div>`;
        }
        if (f.type === 'year') {
          const opts = [1, 2, 3, 4, 5, 6].map((n) => `<option value="${n}">${n * 100}L</option>`).join('');
          return `<div class="field"><label>${f.label}</label><select id="add-${f.key}" ${f.required ? 'required' : ''}><option value="">Select…</option>${opts}</select></div>`;
        }
        if (f.type === 'courses') {
          return `<div class="field"><label>${f.label} <span class="muted">(ctrl/cmd-click for more than one)</span></label><select id="add-${f.key}" multiple size="5">${await courseOptionsHtml()}</select></div>`;
        }
        return `<div class="field"><label>${f.label}</label><input type="${f.type || 'text'}" id="add-${f.key}" ${f.required ? 'required' : ''}></div>`;
      }));
      box.innerHTML = `<form id="add-form" class="card" style="padding:20px; margin-bottom:18px;">${fieldsHtml.join('')}<button class="btn btn-primary" type="submit">${cfg.generatesAccessCode ? 'Add & generate access code' : 'Add'}</button></form>`;
      box.hidden = false;
      document.getElementById('add-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = {};
        for (const f of cfg.addFields) {
          const el = document.getElementById(`add-${f.key}`);
          body[f.key] = f.type === 'courses' ? Array.from(el.selectedOptions).map((o) => o.value) : el.value.trim();
        }
        try {
          const { user, accessCode, tempPassword } = await api(cfg.base, { method: 'POST', body });
          alert(cfg.generatesAccessCode
            ? `${user.fullName} added.\n\nAccess code: ${accessCode}\nTemporary password: ${tempPassword}\n\nShare these with them to log in.`
            : `${user.fullName} added.\n\nTemporary password: ${tempPassword}\n\nThey log in with their email and this password (Settings > Change Password lets them set their own afterward).`);
          render();
        } catch (err) { toast(err.message); }
      });
    });
  }

  async function renderAdminDirectoryDetail() {
    const cfg = DIRECTORY_TYPES[state.view.directoryType];
    const { [cfg.detailKey]: u } = await api(`${cfg.base}/${state.view.userId}`);
    view.innerHTML = `
      <div class="page-head"><h1>${esc(u.fullName)}</h1><button class="btn btn-ghost btn-sm" id="back-btn">← Back</button></div>
      <div class="card" style="padding:24px; max-width:560px;">
        <div class="id-grid" style="margin-bottom:8px;">
          <div><div class="meta">${cfg.idLabel}</div><div>${esc(u[cfg.idField] || '—')}</div></div>
          <div><div class="meta">Department</div><div>${esc(u.department ? u.department.name : '—')}</div></div>
          ${state.view.directoryType === 'STUDENT' ? `<div><div class="meta">Level</div><div>${levelLabel(u.yearOfStudy) || '—'}</div></div>` : ''}
          <div><div class="meta">${cfg.extraLabel}</div><div>${esc(cfg.extraValue(u))}</div></div>
          <div><div class="meta">Status</div><div>${statusPillHtml(u.status)}</div></div>
          <div><div class="meta">Email</div><div>${esc(u.email)}</div></div>
          <div><div class="meta">Phone</div><div>${esc(u.phone || '—')}</div></div>
          <div><div class="meta">Access code</div><div class="tabular">${esc(u.accessCode || '—')}</div></div>
        </div>
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:16px;">
          <button class="btn btn-accent btn-sm" id="edit-btn">✏️ Edit</button>
          ${cfg.actions.filter((a) => a.show(u)).map((a) => `<button class="btn btn-ghost btn-sm" data-action="${a.key}">${a.label}</button>`).join('')}
          ${state.view.directoryType === 'STUDENT' ? `<button class="btn btn-ghost btn-sm" id="issue-credential-btn">Issue credential</button>` : ''}
          ${state.view.directoryType === 'STUDENT' ? `<button class="btn btn-accent btn-sm" id="admission-status-btn">📋 Admission Status</button>` : ''}
        </div>
      </div>
      <div id="edit-box" style="max-width:560px;" hidden></div>
    `;
    document.getElementById('back-btn').addEventListener('click', () => navigate('admin-directory-list', { directoryType: state.view.directoryType }));
    const admissionBtn = document.getElementById('admission-status-btn');
    if (admissionBtn) admissionBtn.addEventListener('click', () => navigate('admission-status', { studentId: u.id }));
    view.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm(`${btn.dataset.action} ${u.fullName}?`)) return;
        try {
          await api(`${cfg.base}/${u.id}/${btn.dataset.action}`, { method: 'POST' });
          toast('Updated');
          render();
        } catch (err) { toast(err.message); }
      });
    });
    const issueBtn = document.getElementById('issue-credential-btn');
    if (issueBtn) issueBtn.addEventListener('click', async () => {
      const title = prompt(`Credential title for ${u.fullName}:`, 'Nigeria Certificate in Education (NCE)');
      if (!title || !title.trim()) return;
      try {
        const { credential } = await api('/admin/credentials', { method: 'POST', body: { studentId: u.id, title: title.trim() } });
        alert(`Credential issued.\n\nVerification link: ${location.origin}/verify.html?code=${credential.verifyCode}`);
      } catch (err) { toast(err.message); }
    });
    document.getElementById('edit-btn').addEventListener('click', async () => {
      const box = document.getElementById('edit-box');
      box.hidden = !box.hidden;
      if (box.hidden) return;
      const fieldsHtml = await Promise.all(cfg.editFields.map(async (f) => {
        if (f.type === 'department') {
          return `<div class="field"><label>${f.label}</label><select id="edit-${f.key}" ${f.required ? 'required' : ''}><option value="">${f.required ? 'Select…' : 'None'}</option>${await departmentOptionsHtml(u.departmentId)}</select></div>`;
        }
        if (f.type === 'year') {
          const opts = [1, 2, 3, 4, 5, 6].map((n) => `<option value="${n}" ${u.yearOfStudy === n ? 'selected' : ''}>${n * 100}L</option>`).join('');
          return `<div class="field"><label>${f.label}</label><select id="edit-${f.key}" ${f.required ? 'required' : ''}><option value="">Select…</option>${opts}</select></div>`;
        }
        if (f.type === 'courses') {
          return `<div class="field"><label>${f.label} <span class="muted">(ctrl/cmd-click for more than one)</span></label><select id="edit-${f.key}" multiple size="5">${await courseOptionsHtml((u.courses || []).map((c) => c.id))}</select></div>`;
        }
        return `<div class="field"><label>${f.label}</label><input type="${f.type || 'text'}" id="edit-${f.key}" value="${esc(u[f.key] || '')}" ${f.required ? 'required' : ''}></div>`;
      }));
      box.innerHTML = `<form id="edit-form" class="card" style="padding:20px; margin-top:6px;">${fieldsHtml.join('')}<button class="btn btn-primary" type="submit">Save changes</button></form>`;
      box.hidden = false;
      document.getElementById('edit-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = {};
        for (const f of cfg.editFields) {
          const el = document.getElementById(`edit-${f.key}`);
          body[f.key] = f.type === 'courses' ? Array.from(el.selectedOptions).map((o) => o.value) : el.value.trim();
        }
        try {
          await api(`${cfg.base}/${u.id}`, { method: 'PATCH', body });
          toast('Saved');
          render();
        } catch (err) { toast(err.message); }
      });
    });
  }

  async function renderAdminAcademics() {
    const [{ departments }, { school }] = await Promise.all([api(`/departments?schoolId=${state.user.schoolId}`), api('/admin/school')]);
    const deptCourses = {};
    await Promise.all(departments.map(async (d) => { deptCourses[d.id] = (await api(`/departments/${d.id}/courses`)).courses; }));
    view.innerHTML = `
      <div class="page-head"><h1>Departments & Courses</h1></div>
      <div class="card" style="padding:16px 20px; margin-bottom:22px; display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap;">
        <div><span style="font-weight:600;">School licence</span> <span class="meta">— ${esc(school.name)}</span></div>
        <span class="pill ${school.licenseStatus === 'ACTIVE' ? 'pill-pass' : 'pill-danger'}">${school.licenseStatus === 'ACTIVE' ? 'Active' : 'Expired'}${school.licenseExpiresAt ? ` until ${new Date(school.licenseExpiresAt).toLocaleDateString()}` : ''}</span>
      </div>
      <h3 style="margin-bottom:10px; font-size:1rem;">Add Departments and Courses</h3>
      <div class="grid-2" style="margin-bottom:26px;">
        <div class="card" style="padding:20px;">
          <h3 style="margin-bottom:12px; font-size:1rem;">Add department</h3>
          <form id="dept-form">
            <div class="field"><label>Name</label><input type="text" id="dept-name" required></div>
            <div class="field"><label>Code</label><input type="text" id="dept-code" required placeholder="e.g. PHY"></div>
            <button class="btn btn-primary" type="submit">Add department</button>
          </form>
        </div>
        <div class="card" style="padding:20px;">
          <h3 style="margin-bottom:12px; font-size:1rem;">Add course</h3>
          <form id="course-form">
            <div class="field"><label>Department</label><select id="course-dept">${departments.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></div>
            <div class="field"><label>Code</label><input type="text" id="course-code" required placeholder="e.g. PHY 101"></div>
            <div class="field"><label>Title</label><input type="text" id="course-title" required></div>
            <div class="field"><label>Level</label><input type="text" id="course-level" value="NCE 1"></div>
            <div class="field"><label>Semester</label><select id="course-semester"><option>First</option><option>Second</option></select></div>
            <button class="btn btn-primary" type="submit">Add course</button>
          </form>
        </div>
      </div>
      ${departments.map((d) => `
        <div style="margin-bottom:18px;">
          <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
            <div class="muted" style="font-weight:700;">${esc(d.name)} (${esc(d.code)})</div>
            <button class="btn btn-ghost btn-sm" data-edit-dept="${d.id}" data-name="${esc(d.name)}" data-code="${esc(d.code)}" style="padding:2px 8px; font-size:0.75rem;">✏️ Edit</button>
          </div>
          <div class="card">
            ${deptCourses[d.id].map((c) => `<div class="list-row"><div>${esc(c.code)} — ${esc(c.title)}</div><div style="display:flex; align-items:center; gap:8px;"><span class="pill pill-muted">${esc(c.level)}</span><button class="btn btn-ghost btn-sm" data-edit-course="${c.id}" data-code="${esc(c.code)}" data-title="${esc(c.title)}" data-level="${esc(c.level)}" data-semester="${esc(c.semester)}" style="padding:2px 8px; font-size:0.75rem;">✏️</button></div></div>`).join('') || '<p class="muted" style="padding:16px;">No courses yet.</p>'}
          </div>
        </div>
      `).join('')}
    `;
    document.getElementById('dept-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      await api('/admin/departments', { method: 'POST', body: { name: document.getElementById('dept-name').value, code: document.getElementById('dept-code').value } });
      toast('Department added');
      render();
    });
    document.getElementById('course-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      await api('/admin/courses', {
        method: 'POST',
        body: {
          departmentId: document.getElementById('course-dept').value,
          code: document.getElementById('course-code').value,
          title: document.getElementById('course-title').value,
          level: document.getElementById('course-level').value,
          semester: document.getElementById('course-semester').value,
        },
      });
      toast('Course added');
      render();
    });
    view.querySelectorAll('[data-edit-dept]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const name = prompt('Department name:', btn.dataset.name);
        if (name === null) return;
        const code = prompt('Department code:', btn.dataset.code);
        if (code === null) return;
        try {
          await api(`/admin/departments/${btn.dataset.editDept}`, { method: 'PATCH', body: { name, code } });
          toast('Department updated');
          render();
        } catch (err) { toast(err.message); }
      });
    });
    view.querySelectorAll('[data-edit-course]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const code = prompt('Course code:', btn.dataset.code);
        if (code === null) return;
        const title = prompt('Course title:', btn.dataset.title);
        if (title === null) return;
        const level = prompt('Level:', btn.dataset.level);
        if (level === null) return;
        try {
          await api(`/admin/courses/${btn.dataset.editCourse}`, { method: 'PATCH', body: { code, title, level } });
          toast('Course updated');
          render();
        } catch (err) { toast(err.message); }
      });
    });
  }

  const ACTIVITY_ACTION_LABELS = {
    LOGIN: 'Logged in',
    CREATE_COURSE: 'Created course',
    CREATE_LESSON: 'Published lesson',
    DELETE_LESSON: 'Removed lesson',
    CREATE_LAB_DEMO: 'Added digital practical',
    CREATE_ASSESSMENT: 'Created test/exam',
    UPLOAD_LIBRARY_RESOURCE: 'Uploaded library resource',
    CREATE_ASSIGNMENT: 'Created assignment',
    CREATE_PROJECT: 'Created project',
    START_LIVE_CLASS: 'Started live class',
  };

  // Grouped by lecturer name, searchable -- click a name to see everything they've
  // done, instead of one long flat table mixing everyone together.
  async function renderAdminActivity() {
    const { logs } = await api('/admin/lecturer-activity');
    const byPerson = new Map();
    for (const l of logs) {
      if (!byPerson.has(l.userId)) byPerson.set(l.userId, { id: l.userId, name: l.user.fullName, logs: [] });
      byPerson.get(l.userId).logs.push(l);
    }
    const people = Array.from(byPerson.values());

    function listHtml(list) {
      return list.map((p) => `
        <div class="list-row clickable" data-person="${p.id}" style="cursor:pointer;">
          <div style="font-weight:600;">${esc(p.name)}</div>
          <span class="pill pill-muted">${p.logs.length} activit${p.logs.length === 1 ? 'y' : 'ies'}</span>
        </div>
      `).join('') || '<p class="muted" style="padding:16px;">No activity yet.</p>';
    }

    function renderPersonActivity(p) {
      view.innerHTML = `
        <div class="page-head"><h1>${esc(p.name)}</h1><button class="btn btn-ghost btn-sm" id="back-btn">← Back</button></div>
        <div class="card" style="overflow-x:auto;">
          <table class="data-table">
            <thead><tr><th>Action</th><th>Detail</th><th>When</th></tr></thead>
            <tbody>${p.logs.map((l) => `<tr><td>${esc(ACTIVITY_ACTION_LABELS[l.action] || l.action)}</td><td>${esc(l.detail || '—')}</td><td class="tabular">${new Date(l.createdAt).toLocaleString()}</td></tr>`).join('')}</tbody>
          </table>
        </div>
      `;
      document.getElementById('back-btn').addEventListener('click', () => navigate('admin-activity'));
    }

    view.innerHTML = `
      <div class="page-head"><h1>Lecturer Activity</h1></div>
      <p class="muted" style="margin-bottom:14px;">Logins, lessons published, resources uploaded, and assignments/tests/exams/projects created — by design, student activity is never tracked here.</p>
      <div class="field" style="max-width:320px; margin-bottom:16px;">
        <input type="text" id="activity-search" placeholder="Search by name…" style="width:100%; padding:10px 12px; border-radius:10px; border:1px solid var(--line); background:var(--paper); color:var(--ink);">
      </div>
      <div class="card" id="activity-list">${listHtml(people)}</div>
    `;
    function wire() {
      view.querySelectorAll('[data-person]').forEach((row) => {
        row.addEventListener('click', () => renderPersonActivity(people.find((p) => p.id === row.dataset.person)));
      });
    }
    wire();
    document.getElementById('activity-search').addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      const filtered = !q ? people : people.filter((p) => p.name.toLowerCase().includes(q));
      document.getElementById('activity-list').innerHTML = listHtml(filtered);
      wire();
    });
  }

  const APPLICATION_TABS = ['SUBMITTED', 'UNDER_REVIEW', 'ACCEPTED', 'REJECTED', 'REGISTERED'];

  async function renderAdminAdmissions() {
    const statusFilter = state.view.status || 'SUBMITTED';
    const [{ applications: allApps }, { applications }] = await Promise.all([
      api('/admin/admissions'),
      api(`/admin/admissions?status=${statusFilter}`),
    ]);
    const counts = Object.fromEntries(APPLICATION_TABS.map((s) => [s, allApps.filter((a) => a.status === s).length]));

    view.innerHTML = `
      <div class="page-head"><h1>Admissions</h1><div style="display:flex; gap:8px; flex-wrap:wrap;"><button class="btn btn-ghost btn-sm" id="upload-admission-letter-btn">Upload admission letter</button><button class="btn btn-ghost btn-sm" id="manage-aptitude-test-btn">Manage aptitude test</button></div></div>
      <div class="grid-cards" style="margin-bottom:20px;">
        ${APPLICATION_TABS.map((s) => `<div class="card course-card" data-status-tile="${s}"><div class="code">${counts[s]}</div><div class="meta">${s.replace('_', ' ')}</div></div>`).join('')}
      </div>
      <div class="tabs" style="max-width:100%; overflow-x:auto; display:inline-flex;">
        ${APPLICATION_TABS.map((s) => `<button class="tab-btn ${s === statusFilter ? 'active' : ''}" data-status="${s}">${s.replace('_', ' ')}</button>`).join('')}
      </div>
      <div style="margin-top:18px;">
        ${applications.map((a) => `
          <div class="card clickable" data-app-id="${a.id}" style="padding:20px; margin-bottom:14px; cursor:pointer;">
            <div style="font-weight:600;">${esc(a.fullName)}</div>
            <div class="meta">${esc(a.email)} · ${esc(a.phone)} · ${esc(a.department.name)} · ${esc(a.level)}</div>
            <div class="meta" style="margin-top:6px;">Applied ${new Date(a.createdAt).toLocaleDateString()}</div>
          </div>
        `).join('') || '<p class="muted">No applications here yet.</p>'}
      </div>
    `;
    document.getElementById('manage-aptitude-test-btn').addEventListener('click', () => navigate('admin-aptitude-test'));
    document.getElementById('upload-admission-letter-btn').addEventListener('click', () => openAdmissionLetterPickerDialog(allApps));
    view.querySelectorAll('[data-status-tile]').forEach((el) => {
      el.addEventListener('click', () => navigate('admin-admissions', { status: el.dataset.statusTile }));
    });
    view.querySelectorAll('[data-status]').forEach((btn) => {
      btn.addEventListener('click', () => navigate('admin-admissions', { status: btn.dataset.status }));
    });
    view.querySelectorAll('[data-app-id]').forEach((card) => {
      card.addEventListener('click', () => navigate('admin-admissions-detail', { applicationId: card.dataset.appId }));
    });
  }

  // A shortcut from the admissions list itself -- pick the applicant here instead of
  // opening their page first just to reach the same upload button there. Skips
  // rejected applicants (nothing to send them); everyone else can get a letter staged
  // any time, whether or not they've been accepted yet.
  function openAdmissionLetterPickerDialog(allApps) {
    const eligible = allApps.filter((a) => a.status !== 'REJECTED');
    const container = document.createElement('div');
    container.className = 'card';
    container.style.cssText = 'position:fixed; inset:0; margin:auto; width:min(480px,92vw); height:fit-content; max-height:86vh; overflow-y:auto; padding:24px; z-index:200;';
    container.innerHTML = `
      <h3 style="margin-bottom:14px;">Upload admission letter</h3>
      <div class="field">
        <label>Applicant</label>
        <select id="ual-applicant">${eligible.map((a) => `<option value="${a.id}">${esc(a.fullName)} — ${esc(a.status.replace('_', ' '))}${a.admissionLetterUrl ? ' (already has one)' : ''}</option>`).join('') || '<option value="">No applicants yet</option>'}</select>
      </div>
      <div class="field"><label>File</label><input type="file" id="ual-file" accept="application/pdf,image/*" required></div>
      <div style="display:flex; gap:10px; margin-top:10px;">
        <button class="btn btn-primary" id="ual-upload">Upload</button>
        <button class="btn btn-ghost" id="ual-cancel">Cancel</button>
      </div>
    `;
    const backdrop = document.createElement('div');
    backdrop.style.cssText = 'position:fixed; inset:0; background:rgba(20,32,51,0.45); z-index:190;';
    document.body.appendChild(backdrop);
    document.body.appendChild(container);
    function close() { backdrop.remove(); container.remove(); }
    container.querySelector('#ual-cancel').addEventListener('click', close);
    container.querySelector('#ual-upload').addEventListener('click', async () => {
      const applicationId = container.querySelector('#ual-applicant').value;
      const file = container.querySelector('#ual-file').files[0];
      if (!applicationId) return toast('No applicant to upload for.');
      if (!file) return toast('Choose a file first.');
      const fd = new FormData();
      fd.append('admissionLetter', file);
      try {
        await api(`/admin/admissions/${applicationId}/admission-letter`, { method: 'POST', body: fd });
        toast('Admission letter uploaded');
        close();
      } catch (err) { toast(err.message); }
    });
  }

  async function renderAdminAdmissionDetail() {
    const { application: a } = await api(`/admin/admissions/${state.view.applicationId}`);
    const sub = a.aptitudeTestSubmission;
    const needsGrading = sub && sub.submittedAt && !sub.gradedAt;
    const aptitudeStatusHtml = sub && sub.submittedAt
      ? (needsGrading
          ? `Submitted <span class="pill pill-accent" style="margin-left:6px;">Awaiting grading</span>`
          : `${sub.score}% <span class="pill pill-pass" style="margin-left:6px;">Submitted</span>`)
      : sub && sub.sentAt
        ? `Sent, awaiting response <span class="pill pill-accent" style="margin-left:6px;">${sub.startedAt ? 'In progress' : 'Not started'}</span>`
        : 'Not sent yet';
    view.innerHTML = `
      <div class="page-head"><h1>${esc(a.fullName)}</h1><button class="btn btn-ghost btn-sm" id="back-btn">← Back</button></div>
      <div class="card" style="padding:24px; max-width:560px; margin-bottom:18px;">
        <div class="id-grid">
          <div><div class="meta">Email</div><div>${esc(a.email)}</div></div>
          <div><div class="meta">Phone</div><div>${esc(a.phone)}</div></div>
          <div><div class="meta">Department</div><div>${esc(a.department.name)}</div></div>
          <div><div class="meta">Level</div><div>${esc(a.level)}</div></div>
          <div><div class="meta">Status</div><div>${esc(a.status.replace('_', ' '))}</div></div>
          <div><div class="meta">Applied</div><div class="tabular">${new Date(a.createdAt).toLocaleDateString()}</div></div>
          <div><div class="meta">O-level result</div><div>${a.olevelResultUrl ? `${esc(a.olevelType || '')} — <a href="${esc(a.olevelResultUrl)}" target="_blank" rel="noopener">View upload</a> · <a href="${esc(a.olevelResultUrl)}" download="${esc(a.fullName.replace(/\s+/g, '_'))}_Olevel${(a.olevelResultUrl.match(/\.[a-zA-Z0-9]+$/) || [''])[0]}">Download</a>` : 'Not uploaded'}</div></div>
          <div><div class="meta">Screening question</div><div>${a.iqAnswer != null ? (a.iqCorrect ? 'Answered correctly' : 'Answered') : '—'}</div></div>
          <div><div class="meta">Aptitude test</div><div>${aptitudeStatusHtml}</div></div>
          ${['ACCEPTED', 'REGISTERED', 'REJECTED'].includes(a.status) ? `<div><div class="meta">Admission letter</div><div>${a.admissionLetterUrl ? `<a href="${esc(a.admissionLetterUrl)}" target="_blank" rel="noopener">View</a> · <a href="${esc(a.admissionLetterUrl)}" download="${esc(a.fullName.replace(/\s+/g, '_'))}_Admission_Letter${(a.admissionLetterUrl.match(/\.[a-zA-Z0-9]+$/) || [''])[0]}">Download</a>` : 'Not uploaded yet'}</div></div>` : ''}
        </div>
        ${a.statement ? `<p class="muted" style="margin-top:14px;">${esc(a.statement)}</p>` : ''}
        ${a.status === 'REJECTED' && a.rejectionReason ? `<p class="meta" style="margin-top:14px;"><strong>Rejection reason:</strong> ${esc(a.rejectionReason)}</p>` : ''}
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:18px;">
          ${a.status === 'SUBMITTED' ? `<button class="btn btn-ghost btn-sm" data-screen>Screen</button>` : ''}
          ${!sub || !sub.sentAt ? `<button class="btn btn-accent btn-sm" data-send-aptitude>Send aptitude test</button>` : ''}
          ${needsGrading ? `<button class="btn btn-accent btn-sm" data-grade-aptitude>Grade theory answers</button>` : ''}
          ${['SUBMITTED', 'UNDER_REVIEW'].includes(a.status) ? `<button class="btn btn-primary btn-sm" data-accept>Accept</button><button class="btn btn-ghost btn-sm" data-reject>Reject</button>` : ''}
          ${['ACCEPTED', 'REGISTERED'].includes(a.status) ? `<button class="btn btn-ghost btn-sm" data-upload-letter>${a.admissionLetterUrl ? 'Replace' : 'Upload'} admission letter</button>` : ''}
          ${a.status === 'ACCEPTED' ? `<button class="btn btn-accent btn-sm" data-register>Register as student</button>` : ''}
        </div>
      </div>
    `;
    document.getElementById('back-btn').addEventListener('click', () => navigate('admin-admissions'));
    const screenBtn = view.querySelector('[data-screen]');
    if (screenBtn) screenBtn.addEventListener('click', async () => { await api(`/admin/admissions/${a.id}/screen`, { method: 'POST' }); toast('Marked under review'); render(); });
    const sendAptitudeBtn = view.querySelector('[data-send-aptitude]');
    if (sendAptitudeBtn) sendAptitudeBtn.addEventListener('click', async () => {
      try {
        await api(`/admin/admissions/${a.id}/send-aptitude-test`, { method: 'POST' });
        toast('Aptitude test sent to the applicant');
        render();
      } catch (err) {
        // No test bank exists yet -- take the admin straight to where they set
        // questions, with this applicant carried along so "Save and Send" there
        // sends to them right away without a second trip back here.
        if (err.code === 'NO_TEST_BANK') navigate('admin-aptitude-test', { forApplicationId: a.id });
        else toast(err.message);
      }
    });
    const gradeAptitudeBtn = view.querySelector('[data-grade-aptitude]');
    if (gradeAptitudeBtn) gradeAptitudeBtn.addEventListener('click', () => openGradeAptitudeDialog(a, sub));
    const acceptBtn = view.querySelector('[data-accept]');
    if (acceptBtn) acceptBtn.addEventListener('click', () => openAcceptDialog(a));
    const rejectBtn = view.querySelector('[data-reject]');
    if (rejectBtn) rejectBtn.addEventListener('click', () => openRejectDialog(a));
    const uploadLetterBtn = view.querySelector('[data-upload-letter]');
    if (uploadLetterBtn) uploadLetterBtn.addEventListener('click', () => openUploadAdmissionLetterDialog(a));
    const registerBtn = view.querySelector('[data-register]');
    if (registerBtn) registerBtn.addEventListener('click', async () => {
      try {
        const { user, tempPassword } = await api(`/admin/admissions/${a.id}/register`, { method: 'POST' });
        alert(`Student account created.\n\nName: ${user.fullName}\nMatric number: ${user.matricNumber}\nEmail: ${user.email}\nTemporary password: ${tempPassword}\n\nShare these with the student now — this password won't be shown again.`);
        render();
      } catch (err) { toast(err.message); }
    });
  }

  // Attaching the admission letter is optional here -- accepting still works with
  // nothing chosen, and the letter can be added or replaced afterward from the
  // "Upload admission letter" button on the same admission page (openUploadAdmissionLetterDialog).
  function openAcceptDialog(a) {
    const container = document.createElement('div');
    container.className = 'card';
    container.style.cssText = 'position:fixed; inset:0; margin:auto; width:min(480px,92vw); height:fit-content; max-height:86vh; overflow-y:auto; padding:24px; z-index:200;';
    container.innerHTML = `
      <h3 style="margin-bottom:10px;">Accept ${esc(a.fullName)}</h3>
      <p class="meta" style="margin-bottom:14px;">Attach the admission letter now to send it together with the acceptance, or leave this blank and upload it later from this application's page.</p>
      <div class="field"><label>Admission letter (optional)</label><input type="file" id="accept-letter-file" accept="application/pdf,image/*"></div>
      <div style="display:flex; gap:10px; margin-top:10px;">
        <button class="btn btn-primary" id="accept-confirm">Accept</button>
        <button class="btn btn-ghost" id="accept-cancel">Cancel</button>
      </div>
    `;
    const backdrop = document.createElement('div');
    backdrop.style.cssText = 'position:fixed; inset:0; background:rgba(20,32,51,0.45); z-index:190;';
    document.body.appendChild(backdrop);
    document.body.appendChild(container);
    function close() { backdrop.remove(); container.remove(); }
    container.querySelector('#accept-cancel').addEventListener('click', close);
    container.querySelector('#accept-confirm').addEventListener('click', async () => {
      const file = container.querySelector('#accept-letter-file').files[0];
      const fd = new FormData();
      if (file) fd.append('admissionLetter', file);
      try {
        await api(`/admin/admissions/${a.id}/accept`, { method: 'POST', body: fd });
        toast(file ? 'Accepted — admission letter sent to the applicant' : 'Accepted');
        close();
        render();
      } catch (err) { toast(err.message); }
    });
  }

  function openRejectDialog(a) {
    const container = document.createElement('div');
    container.className = 'card';
    container.style.cssText = 'position:fixed; inset:0; margin:auto; width:min(480px,92vw); height:fit-content; max-height:86vh; overflow-y:auto; padding:24px; z-index:200;';
    container.innerHTML = `
      <h3 style="margin-bottom:10px;">Reject ${esc(a.fullName)}</h3>
      <div class="field"><label>Reason (shown to the applicant)</label><textarea id="reject-reason" rows="4" placeholder="e.g. Did not meet the minimum O-level requirement for this programme."></textarea></div>
      <div style="display:flex; gap:10px; margin-top:10px;">
        <button class="btn btn-primary" id="reject-confirm">Reject</button>
        <button class="btn btn-ghost" id="reject-cancel">Cancel</button>
      </div>
    `;
    const backdrop = document.createElement('div');
    backdrop.style.cssText = 'position:fixed; inset:0; background:rgba(20,32,51,0.45); z-index:190;';
    document.body.appendChild(backdrop);
    document.body.appendChild(container);
    function close() { backdrop.remove(); container.remove(); }
    container.querySelector('#reject-cancel').addEventListener('click', close);
    container.querySelector('#reject-confirm').addEventListener('click', async () => {
      const reason = container.querySelector('#reject-reason').value.trim();
      try {
        await api(`/admin/admissions/${a.id}/reject`, { method: 'POST', body: { reason: reason || undefined } });
        toast('Rejected');
        close();
        render();
      } catch (err) { toast(err.message); }
    });
  }

  function openUploadAdmissionLetterDialog(a) {
    const container = document.createElement('div');
    container.className = 'card';
    container.style.cssText = 'position:fixed; inset:0; margin:auto; width:min(480px,92vw); height:fit-content; max-height:86vh; overflow-y:auto; padding:24px; z-index:200;';
    container.innerHTML = `
      <h3 style="margin-bottom:10px;">${a.admissionLetterUrl ? 'Replace' : 'Upload'} admission letter</h3>
      <p class="meta" style="margin-bottom:14px;">${esc(a.fullName)} will be notified once this is uploaded.</p>
      <div class="field"><label>File</label><input type="file" id="letter-file" accept="application/pdf,image/*" required></div>
      <div style="display:flex; gap:10px; margin-top:10px;">
        <button class="btn btn-primary" id="letter-upload">Upload</button>
        <button class="btn btn-ghost" id="letter-cancel">Cancel</button>
      </div>
    `;
    const backdrop = document.createElement('div');
    backdrop.style.cssText = 'position:fixed; inset:0; background:rgba(20,32,51,0.45); z-index:190;';
    document.body.appendChild(backdrop);
    document.body.appendChild(container);
    function close() { backdrop.remove(); container.remove(); }
    container.querySelector('#letter-cancel').addEventListener('click', close);
    container.querySelector('#letter-upload').addEventListener('click', async () => {
      const file = container.querySelector('#letter-file').files[0];
      if (!file) return toast('Choose a file first.');
      const fd = new FormData();
      fd.append('admissionLetter', file);
      try {
        await api(`/admin/admissions/${a.id}/admission-letter`, { method: 'POST', body: fd });
        toast('Admission letter uploaded');
        close();
        render();
      } catch (err) { toast(err.message); }
    });
  }

  // Only the THEORY questions need a decision here -- OBJECTIVE ones are already
  // auto-graded at submit time. Each still carries a flat 10%, same as OBJECTIVE, so
  // grading is just "award this one or not" per question, not a numeric score entry.
  // Mirrors the backend's normalizeAnswerText exactly, so a checkbox's default state
  // here always matches what auto-grading already decided at submit time.
  function normalizeAnswerText(s) {
    return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }
  function openGradeAptitudeDialog(a, sub) {
    const questions = sub.test.questions;
    const theoryQuestions = questions.filter((q) => q.questionType === 'THEORY');
    const answers = JSON.parse(sub.answers || '[]');
    const answerMap = new Map(answers.map((x) => [x.questionId, x]));
    const existingGrades = sub.theoryGrades ? JSON.parse(sub.theoryGrades) : {};
    const container = document.createElement('div');
    container.className = 'card';
    container.style.cssText = 'position:fixed; inset:0; margin:auto; width:min(560px,92vw); height:fit-content; max-height:86vh; overflow-y:auto; padding:24px; z-index:200;';
    container.innerHTML = `
      <h3 style="margin-bottom:6px;">Grade theory answers</h3>
      <p class="meta" style="margin-bottom:16px;">${esc(a.fullName)} — objective questions, and any theory question with a correct answer typed in, are already auto-graded below (uncheck to override). Only questions left without a correct answer genuinely need your decision.</p>
      ${theoryQuestions.map((q, i) => {
        const ans = answerMap.get(q.id);
        const autoMatch = q.modelAnswer ? normalizeAnswerText(ans && ans.text) === normalizeAnswerText(q.modelAnswer) : null;
        const checked = q.id in existingGrades ? existingGrades[q.id] : (autoMatch !== null ? autoMatch : false);
        return `
          <div class="field" data-grade-q="${esc(q.id)}" style="border:1px solid var(--line); border-radius:10px; padding:14px; margin-bottom:12px;">
            <label style="margin-bottom:8px;">${i + 1}. ${esc(q.text)}</label>
            <div class="meta" style="margin-bottom:4px;">Applicant's answer</div>
            <div style="white-space:pre-wrap; padding:10px; background:var(--paper); border-radius:8px; margin-bottom:8px;">${esc(ans && ans.text ? ans.text : '(no answer given)')}</div>
            ${q.modelAnswer
              ? `<div class="meta" style="margin-bottom:10px;">Correct answer: ${esc(q.modelAnswer)} ${autoMatch ? '<span class="pill pill-pass" style="margin-left:4px;">Auto-matched</span>' : '<span class="pill pill-muted" style="margin-left:4px;">No match</span>'}</div>`
              : `<div class="meta" style="margin-bottom:10px;">No correct answer was set for this question — your decision here is final.</div>`}
            <label style="display:flex; align-items:center; gap:8px; font-weight:600; cursor:pointer;">
              <input type="checkbox" class="grade-correct" ${checked ? 'checked' : ''}>
              Award full credit (10%)
            </label>
          </div>
        `;
      }).join('') || '<p class="muted">No theory questions to grade.</p>'}
      <div style="display:flex; gap:10px; margin-top:6px;">
        <button class="btn btn-primary" id="grade-save">Save grades</button>
        <button class="btn btn-ghost" id="grade-cancel">Cancel</button>
      </div>
    `;
    const backdrop = document.createElement('div');
    backdrop.style.cssText = 'position:fixed; inset:0; background:rgba(20,32,51,0.45); z-index:190;';
    document.body.appendChild(backdrop);
    document.body.appendChild(container);
    function close() { backdrop.remove(); container.remove(); }
    container.querySelector('#grade-cancel').addEventListener('click', close);
    container.querySelector('#grade-save').addEventListener('click', async () => {
      const grades = theoryQuestions.map((q) => ({
        questionId: q.id,
        correct: container.querySelector(`[data-grade-q="${q.id}"] .grade-correct`).checked,
      }));
      try {
        await api(`/admin/admissions/${a.id}/aptitude-test/grade`, { method: 'POST', body: { grades } });
        toast('Grades saved');
        close();
        render();
      } catch (err) { toast(err.message); }
    });
  }

  // state.view.forApplicationId is set when this screen was reached from "Send
  // aptitude test" on an application that has no test bank yet (see
  // renderAdminAdmissionDetail) -- it changes the save options from a single
  // "Save test" to "Save" (return to that application, still waiting to be sent) and
  // "Save and Send" (save, then immediately send to that one applicant), structured
  // like the assignment/assessment composer's Save vs Save-and-Send.
  async function renderAdminAptitudeTest() {
    const { forApplicationId } = state.view;
    const { test, maxQuestions } = await api('/admin/aptitude-test');
    view.innerHTML = `
      <div class="page-head"><h1>Admission Aptitude Test</h1><button class="btn btn-ghost btn-sm" id="back-btn">← Back</button></div>
      ${test ? `<p class="meta" style="margin-bottom:14px;">Current test: "${esc(test.title)}" (${test.questions.length} questions). Saving below replaces it with a new version for future sends — already-sent/scored applicants keep their own copy.</p>` : '<p class="meta" style="margin-bottom:14px;">No aptitude test configured yet — you won\'t be able to send one to an applicant until you add questions below.</p>'}
      <p class="meta" style="margin-bottom:14px;">Theory questions auto-score too — type the correct answer into "Correct / model answer" and the applicant's typed answer is matched against it (case and spacing don't matter, but wording otherwise has to match). Leave it blank if a question has no single right answer, and you'll grade that one yourself once the applicant submits.</p>
      <p class="meta" id="at-cap-note" style="margin-bottom:14px;"></p>
      <div id="at-questions">
        ${(test ? test.questions : [null]).map((q, qi) => questionBlock(qi, q)).join('')}
      </div>
      <button type="button" class="btn btn-ghost btn-sm" id="at-add-q" style="margin-bottom:14px;">+ Add question</button>
      <div class="field" style="max-width:420px;"><label>Test title</label><input type="text" id="at-title" value="${test ? esc(test.title) : 'General Aptitude Test'}" required></div>
      ${forApplicationId
        ? '<p class="meta" style="margin-bottom:10px;">"Save and Send" saves this test and sends it to the applicant right away. "Save" keeps it here, ready to send from their admission page whenever you\'re ready.</p>'
        : ''}
      <div style="display:flex; gap:10px; flex-wrap:wrap;">
        ${forApplicationId ? '<button class="btn btn-primary" id="at-save-send">Save and Send</button>' : ''}
        <button class="btn ${forApplicationId ? 'btn-ghost' : 'btn-primary'}" id="at-save">${forApplicationId ? 'Save' : 'Save test'}</button>
      </div>
    `;
    document.getElementById('back-btn').addEventListener('click', () => navigate(forApplicationId ? 'admin-admissions-detail' : 'admin-admissions', forApplicationId ? { applicationId: forApplicationId } : undefined));
    const questionsEl = document.getElementById('at-questions');
    let qCount = test ? test.questions.length : 1;
    questionsEl.querySelectorAll('[data-question-block]').forEach(wireQuestionTypeToggle);
    // Each question is a flat 10% of the applicant's score, so more than 10 would push
    // the total over 100% -- the add-question button disables right at the cap rather
    // than letting the save request fail after the fact.
    function updateCapNote() {
      const count = questionsEl.querySelectorAll('[data-question-block]').length;
      document.getElementById('at-cap-note').textContent = `${count} / ${maxQuestions} questions (each is worth 10% of the applicant's score).`;
      document.getElementById('at-add-q').disabled = count >= maxQuestions;
    }
    document.getElementById('at-add-q').addEventListener('click', () => {
      if (questionsEl.querySelectorAll('[data-question-block]').length >= maxQuestions) return;
      const div = document.createElement('div');
      div.innerHTML = questionBlock(qCount++);
      const block = div.firstElementChild;
      questionsEl.appendChild(block);
      wireQuestionTypeToggle(block);
      updateCapNote();
    });
    updateCapNote();
    async function save(send) {
      const questions = readQuestionBlocks(view);
      if (!questions.length) return toast('Add at least one complete question.');
      if (questions.length > maxQuestions) return toast(`At most ${maxQuestions} questions allowed.`);
      try {
        await api('/admin/aptitude-test', { method: 'POST', body: { title: document.getElementById('at-title').value.trim(), questions } });
        if (send && forApplicationId) {
          await api(`/admin/admissions/${forApplicationId}/send-aptitude-test`, { method: 'POST' });
          toast('Aptitude test saved and sent to the applicant');
        } else {
          toast('Aptitude test saved');
        }
        navigate(forApplicationId ? 'admin-admissions-detail' : 'admin-admissions', forApplicationId ? { applicationId: forApplicationId } : undefined);
      } catch (err) { toast(err.message); }
    }
    document.getElementById('at-save').addEventListener('click', () => save(false));
    const saveSendBtn = document.getElementById('at-save-send');
    if (saveSendBtn) saveSendBtn.addEventListener('click', () => save(true));
  }

  async function renderAdminStaffRecords() {
    const [{ workload }, { records: attendance }, { records: cpd }, { records: publications }] = await Promise.all([
      api('/admin/staff/workload'),
      api('/admin/staff/attendance'),
      api('/admin/staff/cpd'),
      api('/admin/staff/publications'),
    ]);

    view.innerHTML = `
      <div class="page-head"><h1>Staff Records</h1></div>

      <h3 style="margin-bottom:10px; font-size:1rem;">Workload (from real activity — courses, lessons, assessments, live classes, practicals)</h3>
      <div class="card" style="overflow-x:auto; margin-bottom:26px;">
        <table class="data-table">
          <thead><tr><th>Lecturer</th><th>Department</th><th>Courses</th><th>Lessons</th><th>Assessments</th><th>Live classes</th><th>Practicals</th></tr></thead>
          <tbody>${workload.map((w) => `<tr><td>${esc(w.fullName)}</td><td>${esc(w.department || '—')}</td><td class="tabular">${w.courses}</td><td class="tabular">${w.lessons}</td><td class="tabular">${w.assessments}</td><td class="tabular">${w.liveClasses}</td><td class="tabular">${w.labDemos}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No lecturers yet.</td></tr>'}</tbody>
        </table>
      </div>

      <h3 style="margin-bottom:10px; font-size:1rem;">Attendance</h3>
      <div class="card" style="overflow-x:auto; margin-bottom:26px;">
        <table class="data-table">
          <thead><tr><th>Lecturer</th><th>Date</th><th>Status</th></tr></thead>
          <tbody>${attendance.map((r) => `<tr><td>${esc(r.user.fullName)}</td><td class="tabular">${new Date(r.date).toLocaleDateString()}</td><td>${esc(r.status)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No records yet.</td></tr>'}</tbody>
        </table>
      </div>

      <h3 style="margin-bottom:10px; font-size:1rem;">CPD records</h3>
      <div class="card" style="overflow-x:auto; margin-bottom:26px;">
        <table class="data-table">
          <thead><tr><th>Lecturer</th><th>Title</th><th>Provider</th><th>Hours</th><th>Date</th></tr></thead>
          <tbody>${cpd.map((c) => `<tr><td>${esc(c.user.fullName)}</td><td>${esc(c.title)}</td><td>${esc(c.provider)}</td><td class="tabular">${c.hours}</td><td class="tabular">${new Date(c.completedAt).toLocaleDateString()}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No CPD logged yet.</td></tr>'}</tbody>
        </table>
      </div>

      <h3 style="margin-bottom:10px; font-size:1rem;">Publications</h3>
      <div class="card" style="overflow-x:auto;">
        <table class="data-table">
          <thead><tr><th>Lecturer</th><th>Title</th><th>Outlet</th><th>Year</th></tr></thead>
          <tbody>${publications.map((p) => `<tr><td>${esc(p.user.fullName)}</td><td>${esc(p.title)}</td><td>${esc(p.outlet)}</td><td class="tabular">${p.year}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No publications logged yet.</td></tr>'}</tbody>
        </table>
      </div>
    `;
  }

  async function renderAdminStudentRequests() {
    const [{ requests: transcripts }, { requests: clearances }, { applications: hostelApps }] = await Promise.all([
      api('/admin/transcript-requests'),
      api('/admin/clearance-requests'),
      api('/admin/hostel-applications'),
    ]);

    view.innerHTML = `
      <div class="page-head"><h1>Student Requests</h1></div>

      <h3 style="margin-bottom:10px; font-size:1rem;">Transcript requests</h3>
      <div class="card" style="margin-bottom:26px;">
        ${transcripts.map((t) => `
          <div class="list-row">
            <div><div style="font-weight:600;">${esc(t.student.fullName)}</div><div class="meta tabular">${esc(t.student.matricNumber || '—')} · requested ${new Date(t.requestedAt).toLocaleDateString()}</div></div>
            <button class="btn btn-primary btn-sm" data-issue-transcript="${t.id}">Issue</button>
          </div>
        `).join('') || '<p class="muted" style="padding:16px;">No pending requests.</p>'}
      </div>

      <h3 style="margin-bottom:10px; font-size:1rem;">Clearance requests</h3>
      <div class="card" style="margin-bottom:26px;">
        ${clearances.map((c) => `
          <div class="list-row">
            <div><div style="font-weight:600;">${esc(c.student.fullName)}</div><div class="meta tabular">${esc(c.student.matricNumber || '—')} · requested ${new Date(c.requestedAt).toLocaleDateString()}</div></div>
            <div style="display:flex; gap:8px;">
              <button class="btn btn-primary btn-sm" data-clear="${c.id}">Clear</button>
              <button class="btn btn-ghost btn-sm" data-deny="${c.id}">Deny</button>
            </div>
          </div>
        `).join('') || '<p class="muted" style="padding:16px;">No pending requests.</p>'}
      </div>

      <h3 style="margin-bottom:10px; font-size:1rem;">Hostel applications</h3>
      <div class="card">
        ${hostelApps.map((h) => `
          <div class="list-row">
            <div><div style="font-weight:600;">${esc(h.student.fullName)}</div><div class="meta tabular">${esc(h.student.matricNumber || '—')}${h.roomPreference ? ` · prefers: ${esc(h.roomPreference)}` : ''}</div></div>
            <div style="display:flex; gap:8px;">
              <button class="btn btn-primary btn-sm" data-approve-hostel="${h.id}">Approve</button>
              <button class="btn btn-ghost btn-sm" data-reject-hostel="${h.id}">Reject</button>
            </div>
          </div>
        `).join('') || '<p class="muted" style="padding:16px;">No pending applications.</p>'}
      </div>
    `;

    view.querySelectorAll('[data-issue-transcript]').forEach((btn) => {
      btn.addEventListener('click', async () => { await api(`/admin/transcript-requests/${btn.dataset.issueTranscript}/issue`, { method: 'POST' }); toast('Transcript issued'); render(); });
    });
    view.querySelectorAll('[data-clear]').forEach((btn) => {
      btn.addEventListener('click', async () => { await api(`/admin/clearance-requests/${btn.dataset.clear}/decide`, { method: 'POST', body: { status: 'CLEARED' } }); toast('Cleared'); render(); });
    });
    view.querySelectorAll('[data-deny]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const note = prompt('Reason for denial (optional):') || '';
        await api(`/admin/clearance-requests/${btn.dataset.deny}/decide`, { method: 'POST', body: { status: 'DENIED', note } });
        toast('Denied');
        render();
      });
    });
    view.querySelectorAll('[data-approve-hostel]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const { hostels } = await api('/admin/hostels');
        if (!hostels.length) return toast('Add a hostel first, from the Hostels page.');
        const names = hostels.map((h) => h.name).join(', ');
        const chosen = prompt(`Which hostel? (${names})`);
        const hostel = hostels.find((h) => h.name.toLowerCase() === (chosen || '').trim().toLowerCase());
        if (!hostel) return toast('No matching hostel name — approval cancelled.');
        const roomAssigned = prompt('Room number:') || 'To be confirmed';
        await api(`/admin/hostel-applications/${btn.dataset.approveHostel}/approve`, { method: 'POST', body: { hostelId: hostel.id, roomAssigned } });
        toast('Approved');
        render();
      });
    });
    view.querySelectorAll('[data-reject-hostel]').forEach((btn) => {
      btn.addEventListener('click', async () => { await api(`/admin/hostel-applications/${btn.dataset.rejectHostel}/reject`, { method: 'POST' }); toast('Rejected'); render(); });
    });
  }

  async function renderAdminHostelAllocations() {
    const { hostels } = await api('/admin/hostels');
    view.innerHTML = `
      <div class="page-head"><h1>Hostels</h1><button class="btn btn-accent btn-sm" id="add-hostel-btn">+ Add hostel</button></div>
      <div class="grid-cards">
        ${hostels.map((h) => `<div class="card course-card" data-hostel-id="${h.id}"><div class="code">${esc(h.name)}</div><div class="meta">${h._count.applications} student${h._count.applications === 1 ? '' : 's'}</div></div>`).join('') || '<p class="muted">No hostels added yet.</p>'}
      </div>
    `;
    document.getElementById('add-hostel-btn').addEventListener('click', async () => {
      const name = prompt('Hostel name, e.g. "Daws Hostel"');
      if (!name || !name.trim()) return;
      await api('/admin/hostels', { method: 'POST', body: { name: name.trim() } });
      toast('Hostel added');
      render();
    });
    view.querySelectorAll('[data-hostel-id]').forEach((el) => {
      el.addEventListener('click', () => navigate('admin-hostel-detail', { hostelId: el.dataset.hostelId, hostelName: el.querySelector('.code').textContent }));
    });
  }

  async function renderAdminHostelDetail() {
    const { allocations } = await api(`/admin/hostels/${state.view.hostelId}/allocations`);
    view.innerHTML = `
      <div class="page-head">
        <h1>${esc(state.view.hostelName)}</h1>
        <div style="display:flex; gap:10px;">
          <button class="btn btn-accent btn-sm" id="add-student-hostel-btn">+ Add student</button>
          <button class="btn btn-ghost btn-sm" id="back-btn">← Back</button>
        </div>
      </div>
      <div class="card" style="overflow-x:auto;">
        <table class="data-table">
          <thead><tr><th>Student</th><th>Matric No.</th><th>Department</th><th>Room</th><th>Phone</th><th>Allocated</th></tr></thead>
          <tbody>
            ${allocations.map((a) => `
              <tr>
                <td>${esc(a.student.fullName)}</td>
                <td class="tabular">${esc(a.student.matricNumber || '—')}</td>
                <td>${esc(a.student.department ? a.student.department.name : '—')}</td>
                <td class="tabular">${esc(a.roomAssigned || '—')}</td>
                <td class="tabular">${esc(a.student.phone || '—')}</td>
                <td class="tabular">${a.decidedAt ? new Date(a.decidedAt).toLocaleDateString() : '—'}</td>
              </tr>
            `).join('') || '<tr><td colspan="6" class="muted" style="padding:16px;">No students allocated here yet.</td></tr>'}
          </tbody>
        </table>
      </div>
    `;
    document.getElementById('back-btn').addEventListener('click', () => navigate('admin-hostel-allocations'));
    document.getElementById('add-student-hostel-btn').addEventListener('click', () => openAddStudentToHostelDialog());
  }

  async function openAddStudentToHostelDialog() {
    const { hostelId, hostelName } = state.view;
    const { students } = await api('/admin/students');
    const container = document.createElement('div');
    container.className = 'card';
    container.style.cssText = 'position:fixed; inset:0; margin:auto; width:min(440px,92vw); height:fit-content; padding:24px; z-index:200;';
    container.innerHTML = `
      <h3 style="margin-bottom:14px;">Add student to ${esc(hostelName || 'this hostel')}</h3>
      <div class="field"><label>Student</label><select id="ah-student">${students.map((s) => `<option value="${s.id}">${esc(s.fullName)} (${esc(s.matricNumber || '—')})</option>`).join('') || '<option value="">No students in the school yet</option>'}</select></div>
      <div class="field"><label>Room (optional)</label><input type="text" id="ah-room" placeholder="e.g. Block C, Room 14"></div>
      <div style="display:flex; gap:10px; margin-top:10px;">
        <button class="btn btn-primary" id="ah-save">Add</button>
        <button class="btn btn-ghost" id="ah-cancel">Cancel</button>
      </div>
    `;
    const backdrop = document.createElement('div');
    backdrop.style.cssText = 'position:fixed; inset:0; background:rgba(20,32,51,0.45); z-index:190;';
    document.body.appendChild(backdrop);
    document.body.appendChild(container);
    function close() { backdrop.remove(); container.remove(); }
    container.querySelector('#ah-cancel').addEventListener('click', close);
    container.querySelector('#ah-save').addEventListener('click', async () => {
      const studentId = container.querySelector('#ah-student').value;
      if (!studentId) return toast('No student to add.');
      try {
        await api(`/admin/hostels/${hostelId}/allocate`, { method: 'POST', body: { studentId, roomAssigned: container.querySelector('#ah-room').value.trim() } });
        toast('Student added to hostel');
        close();
        render();
      } catch (err) { toast(err.message); }
    });
  }

  // Admin-wide Results: create a result for any student in any department (reusing the
  // exact same dialog the lecturer's own Student Results hub uses -- it only ever
  // needed a `courses` list, never assumed it was the lecturer's own), and see every
  // already-published result grouped by department then course.
  // A searchable list of students -- click one to see every result they have, across
  // every course. Publishing a new one starts from "search and select the student"
  // rather than "pick a course first", since the point of this screen is students.
  async function renderAdminResults() {
    const { students } = await api('/admin/students');

    function rowsHtml(list) {
      return list.map((s) => `
        <div class="list-row clickable" data-student="${s.id}" style="cursor:pointer;">
          <div><div style="font-weight:600;">${esc(s.fullName)}</div><div class="meta tabular">${esc(s.matricNumber || '—')}</div></div>
          <div class="meta">${s.department ? esc(s.department.name) : '—'}</div>
        </div>
      `).join('') || '<p class="muted" style="padding:16px;">No students yet.</p>';
    }

    view.innerHTML = `
      <div class="page-head">
        <h1>Results</h1>
        <button class="btn btn-accent btn-sm" id="new-result-btn">+ Create new result</button>
      </div>
      <p class="muted" style="margin-bottom:14px;">Click a student to see all their results (including drafts awaiting send). "Create new result" searches for a student to create one for.</p>
      <div class="field" style="max-width:320px; margin-bottom:16px;">
        <input type="text" id="results-search" placeholder="Search by name or matric number…" style="width:100%; padding:10px 12px; border-radius:10px; border:1px solid var(--line); background:var(--paper); color:var(--ink);">
      </div>
      <div class="card" id="results-student-list">${rowsHtml(students)}</div>
    `;
    function wireRows() {
      view.querySelectorAll('[data-student]').forEach((row) => {
        row.addEventListener('click', () => navigate('admin-student-results', { studentId: row.dataset.student }));
      });
    }
    wireRows();
    document.getElementById('results-search').addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      const filtered = !q ? students : students.filter((s) => s.fullName.toLowerCase().includes(q) || (s.matricNumber || '').toLowerCase().includes(q));
      document.getElementById('results-student-list').innerHTML = rowsHtml(filtered);
      wireRows();
    });
    document.getElementById('new-result-btn').addEventListener('click', () => openSendResultDialog(students));
  }

  // All of one student's published results -- every course, every semester.
  async function renderAdminStudentResults() {
    const { student, results } = await api(`/admin/students/${state.view.studentId}/results`);
    view.innerHTML = `
      <div class="page-head">
        <h1>${esc(student.fullName)}</h1>
        <div style="display:flex; gap:10px;">
          <button class="btn btn-accent btn-sm" id="send-result-btn">+ Create new result</button>
          <button class="btn btn-ghost btn-sm" id="back-btn">← Back to Results</button>
        </div>
      </div>
      <p class="muted tabular" style="margin-bottom:16px;">${esc(student.matricNumber || '—')}</p>
      <div class="card" style="overflow-x:auto;">
        <table class="data-table">
          <thead><tr><th>Course</th><th>Semester</th><th>Score</th><th>Grade</th><th>Remark</th><th>Status</th><th></th></tr></thead>
          <tbody>${results.map((r) => `<tr>
            <td class="tabular">${esc(r.course.code)}</td><td>${esc(r.term)}</td><td class="tabular">${r.score}</td><td>${esc(r.grade || '—')}</td><td>${esc(r.remark || '—')}</td>
            <td>${r.sentAt ? `<span class="pill pill-pass">Sent ${new Date(r.sentAt).toLocaleDateString()}</span>` : '<span class="pill pill-muted">Draft</span>'}</td>
            <td><div style="display:flex; gap:6px;"><button class="btn btn-ghost btn-sm" data-edit="${r.id}">Edit</button><button class="btn btn-ghost btn-sm" data-send="${r.id}">${r.sentAt ? 'Resend' : 'Send'}</button></div></td>
          </tr>`).join('') || '<tr><td colspan="7" class="muted" style="padding:16px;">No results for this student yet.</td></tr>'}</tbody>
        </table>
      </div>
    `;
    document.getElementById('back-btn').addEventListener('click', () => navigate('admin-results'));
    document.getElementById('send-result-btn').addEventListener('click', async () => {
      const { students } = await api('/admin/students');
      openSendResultDialog(students, student.id);
    });
    view.querySelectorAll('[data-edit]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const result = results.find((r) => r.id === btn.dataset.edit);
        if (!result) return;
        const { students } = await api('/admin/students');
        openSendResultDialog(students, student.id, { ...result, student, courseId: result.course.id });
      });
    });
    view.querySelectorAll('[data-send]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await api(`/results/${btn.dataset.send}/send`, { method: 'POST' });
          toast(btn.textContent === 'Resend' ? 'Result resent' : 'Result sent');
          render();
        } catch (err) { toast(err.message); }
      });
    });
  }

  // "Search and select student" flow: type a name/matric to filter, pick one, then the
  // course dropdown narrows to just the courses that student is actually enrolled in
  // (each student's own `courses` list is already included in GET /admin/students).
  // opts.existing switches to editing an already-saved result -- student/course shown
  // as fixed context instead of the search/pick flow, since neither changes on an edit.
  function openSendResultDialog(students, preselectStudentId, existing) {
    const container = document.createElement('div');
    container.className = 'card';
    container.style.cssText = 'position:fixed; inset:0; margin:auto; width:min(480px,92vw); height:fit-content; max-height:86vh; overflow-y:auto; padding:24px; z-index:200;';
    container.innerHTML = `
      <h3 style="margin-bottom:14px;">${existing ? 'Edit result' : 'Create new result'}</h3>
      ${existing ? `
        <div class="field"><label>Student</label><div style="padding:10px 0; font-weight:600;">${esc(existing.student.fullName)}</div></div>
        <div class="field"><label>Course</label><div style="padding:10px 0; font-weight:600;">${existing.course ? esc(`${existing.course.code} — ${existing.course.title}`) : ''}</div></div>
      ` : `
        <div class="field"><label>Student</label><input type="text" id="sr-search" placeholder="Search by name or matric number…"></div>
        <div id="sr-matches" class="card" style="max-height:160px; overflow-y:auto; margin-bottom:14px;"></div>
        <div id="sr-form" hidden>
          <p class="meta" id="sr-picked" style="margin-bottom:10px;"></p>
          <div class="field"><label>Course</label><select id="sr-course"></select></div>
        </div>
      `}
      <div class="field"><label>Semester</label><input type="text" id="sr-term" value="${esc(existing ? existing.term : '')}" placeholder="e.g. 1st Semester 2025/2026" required></div>
      <div class="field"><label>Score</label><input type="number" id="sr-score" value="${existing ? existing.score : ''}" required></div>
      <div class="field"><label>Grade (optional)</label><input type="text" id="sr-grade" value="${esc(existing ? existing.grade || '' : '')}" placeholder="e.g. A"></div>
      <div class="field"><label>Remark (optional)</label><input type="text" id="sr-remark" value="${esc(existing ? existing.remark || '' : '')}"></div>
      ${existing && existing.sentAt ? `
        <p class="meta" style="margin:8px 0;">Already sent -- changes save in place. Use Resend on the list if the student should be notified again.</p>
      ` : `
        <p class="meta" style="margin:8px 0;">"Save and Send" delivers it right away. "Save" keeps it as a draft to send later.</p>
      `}
      <div style="display:flex; gap:10px; margin-top:10px; flex-wrap:wrap;">
        ${existing && existing.sentAt
          ? `<button class="btn btn-primary" id="sr-save">Save changes</button>`
          : `<button class="btn btn-primary" id="sr-save-send" ${!existing && preselectStudentId ? '' : existing ? '' : 'hidden'}>Save and Send</button><button class="btn btn-ghost" id="sr-save" ${!existing && preselectStudentId ? '' : existing ? '' : 'hidden'}>Save</button>`}
        <button class="btn btn-ghost" id="sr-cancel">Cancel</button>
      </div>
    `;
    const backdrop = document.createElement('div');
    backdrop.style.cssText = 'position:fixed; inset:0; background:rgba(20,32,51,0.45); z-index:190;';
    document.body.appendChild(backdrop);
    document.body.appendChild(container);
    function close() { backdrop.remove(); container.remove(); }
    container.querySelector('#sr-cancel').addEventListener('click', close);

    let picked = existing ? existing.student : null;
    if (!existing) {
      function pickStudent(s) {
        picked = s;
        container.querySelector('#sr-matches').innerHTML = '';
        container.querySelector('#sr-search').value = s.fullName;
        container.querySelector('#sr-picked').textContent = `${s.fullName} (${s.matricNumber || '—'})`;
        container.querySelector('#sr-course').innerHTML = (s.courses || []).map((c) => `<option value="${c.id}">${esc(c.code)} — ${esc(c.title)}</option>`).join('') || '<option value="">Not enrolled in any course</option>';
        container.querySelector('#sr-form').hidden = false;
        container.querySelector('#sr-save-send').hidden = false;
        container.querySelector('#sr-save').hidden = false;
      }
      function renderMatches(q) {
        const matchesEl = container.querySelector('#sr-matches');
        if (!q) { matchesEl.innerHTML = ''; return; }
        const matches = students.filter((s) => s.fullName.toLowerCase().includes(q.toLowerCase()) || (s.matricNumber || '').toLowerCase().includes(q.toLowerCase())).slice(0, 8);
        matchesEl.innerHTML = matches.map((s) => `<div class="list-row clickable" data-pick="${s.id}" style="cursor:pointer; padding:8px 12px;"><div>${esc(s.fullName)}</div><span class="meta tabular">${esc(s.matricNumber || '—')}</span></div>`).join('') || '<p class="muted" style="padding:8px 12px;">No match.</p>';
        matchesEl.querySelectorAll('[data-pick]').forEach((row) => {
          row.addEventListener('click', () => pickStudent(students.find((s) => s.id === row.dataset.pick)));
        });
      }
      container.querySelector('#sr-search').addEventListener('input', (e) => renderMatches(e.target.value.trim()));
      if (preselectStudentId) {
        const pre = students.find((s) => s.id === preselectStudentId);
        if (pre) pickStudent(pre);
      }
    }

    async function saveResult(send) {
      const term = container.querySelector('#sr-term').value.trim();
      const score = container.querySelector('#sr-score').value;
      const grade = container.querySelector('#sr-grade').value.trim() || null;
      const remark = container.querySelector('#sr-remark').value.trim() || null;
      try {
        if (existing) {
          await api(`/results/${existing.id}`, { method: 'PUT', body: { term, score, grade, remark } });
          toast('Result updated');
        } else {
          if (!picked) return toast('Search for and select a student first.');
          const courseId = container.querySelector('#sr-course').value;
          if (!courseId) return toast(`${picked.fullName} isn't enrolled in any course.`);
          await api(`/courses/${courseId}/results`, { method: 'POST', body: { studentId: picked.id, send, term, score, grade, remark } });
          toast(send ? 'Result saved and sent' : 'Result saved as a draft');
        }
        close();
        render();
      } catch (err) { toast(err.message); }
    }
    const sendBtn = container.querySelector('#sr-save-send');
    if (sendBtn) sendBtn.addEventListener('click', () => saveResult(true));
    container.querySelector('#sr-save').addEventListener('click', () => saveResult(false));
  }

  // A quick school-wide broadcast -- title + message + who it goes to, nothing else.
  // Reuses the same /admin/bulk-message endpoint "Bulk SMS/Email" uses (an in-app
  // notification to the whole audience), just always in-app and never narrowed by
  // department -- that fuller control still lives on the Bulk SMS/Email page for
  // when admin actually wants Email/SMS too.
  async function renderAdminAnnounce() {
    view.innerHTML = `
      <div class="page-head"><h1>Announce</h1></div>
      <p class="muted" style="margin-bottom:18px;">Send an announcement to every student, every academic (lecturer) or non-academic staff member, or the whole school. Delivered as an in-app notification right away.</p>
      <div class="card" style="padding:20px; max-width:560px;">
        <form id="announce-form">
          <div class="field">
            <label>Audience</label>
            <select id="ann-audience">
              <option value="STUDENTS">All students</option>
              <option value="ACADEMIC_STAFF">All academic staff (lecturers)</option>
              <option value="NON_ACADEMIC_STAFF">All non-academic staff</option>
              <option value="EVERYONE">Everyone</option>
            </select>
          </div>
          <div class="field"><label>Title</label><input type="text" id="ann-title" required placeholder="e.g. Resumption date changed"></div>
          <div class="field"><label>Message</label><textarea id="ann-body" required rows="5"></textarea></div>
          <button class="btn btn-primary" type="submit" id="ann-send-btn">Send announcement</button>
        </form>
        <div id="ann-result" style="margin-top:16px;"></div>
      </div>
    `;
    document.getElementById('announce-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = document.getElementById('ann-title').value.trim();
      const body = document.getElementById('ann-body').value.trim();
      if (!title || !body) return toast('Title and message are required.');
      const btn = document.getElementById('ann-send-btn');
      btn.disabled = true;
      btn.textContent = 'Sending…';
      try {
        const result = await api('/admin/bulk-message', {
          method: 'POST',
          body: { audience: document.getElementById('ann-audience').value, channels: ['IN_APP'], subject: title, body },
        });
        document.getElementById('ann-result').innerHTML = `<div class="hint-box">Sent to ${result.recipientCount} recipient${result.recipientCount === 1 ? '' : 's'}.</div>`;
        toast('Announcement sent');
        document.getElementById('announce-form').reset();
      } catch (err) {
        toast(err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Send announcement';
      }
    });
  }

  // Broadcasts to a whole audience at once (all students, all academic staff, all
  // non-academic staff, or everyone), optionally narrowed to one department. In-app
  // notification always sends (no setup needed); Email/SMS are opt-in channels that
  // may come back only partially configured -- the result banner reports exactly how
  // many went out per channel rather than a single pass/fail.
  async function renderAdminBulkMessage() {
    const deptOptions = await departmentOptionsHtml();
    view.innerHTML = `
      <div class="page-head"><h1>Bulk SMS/Email</h1></div>
      <p class="muted" style="margin-bottom:18px;">Send a message to every student, every academic (lecturer) or non-academic staff member, or the whole school -- by in-app notification, email, and/or SMS.</p>
      <div class="card" style="padding:20px;">
        <form id="bulk-msg-form">
          <div class="field">
            <label>Audience</label>
            <select id="bm-audience">
              <option value="STUDENTS">All students</option>
              <option value="ACADEMIC_STAFF">All academic staff (lecturers)</option>
              <option value="NON_ACADEMIC_STAFF">All non-academic staff</option>
              <option value="EVERYONE">Everyone</option>
            </select>
          </div>
          <div class="field">
            <label>Department (optional -- narrows the audience above)</label>
            <select id="bm-department"><option value="">All departments</option>${deptOptions}</select>
          </div>
          <div class="field">
            <label>Channels</label>
            <div style="display:flex; gap:16px; flex-wrap:wrap; padding:8px 0;">
              <label style="display:flex; align-items:center; gap:6px; font-weight:500;"><input type="checkbox" id="bm-ch-inapp" checked> In-app notification</label>
              <label style="display:flex; align-items:center; gap:6px; font-weight:500;"><input type="checkbox" id="bm-ch-email"> Email</label>
              <label style="display:flex; align-items:center; gap:6px; font-weight:500;"><input type="checkbox" id="bm-ch-sms"> SMS</label>
            </div>
          </div>
          <div class="field"><label>Subject (used for in-app/email; SMS has no subject line)</label><input type="text" id="bm-subject" placeholder="e.g. Resumption date changed"></div>
          <div class="field"><label>Message</label><textarea id="bm-body" required rows="5"></textarea></div>
          <button class="btn btn-primary" type="submit" id="bm-send-btn">Send</button>
        </form>
        <div id="bm-result" style="margin-top:16px;"></div>
      </div>
    `;
    document.getElementById('bulk-msg-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const channels = [];
      if (document.getElementById('bm-ch-inapp').checked) channels.push('IN_APP');
      if (document.getElementById('bm-ch-email').checked) channels.push('EMAIL');
      if (document.getElementById('bm-ch-sms').checked) channels.push('SMS');
      if (!channels.length) return toast('Pick at least one channel.');
      const body = document.getElementById('bm-body').value.trim();
      if (!body) return toast('Write a message first.');
      const btn = document.getElementById('bm-send-btn');
      btn.disabled = true;
      btn.textContent = 'Sending…';
      try {
        const result = await api('/admin/bulk-message', {
          method: 'POST',
          body: {
            audience: document.getElementById('bm-audience').value,
            departmentId: document.getElementById('bm-department').value || null,
            channels,
            subject: document.getElementById('bm-subject').value.trim(),
            body,
          },
        });
        const lines = [`Sent to ${result.recipientCount} recipient${result.recipientCount === 1 ? '' : 's'}.`];
        if (channels.includes('IN_APP')) lines.push(`In-app: ${result.inApp} notified.`);
        if (channels.includes('EMAIL')) lines.push(result.emailError ? `Email: ${result.emailError}` : `Email: ${result.email} sent${result.emailSkipped ? `, ${result.emailSkipped} skipped (no address on file)` : ''}.`);
        if (channels.includes('SMS')) lines.push(result.smsError ? `SMS: ${result.smsError}` : `SMS: ${result.sms} sent${result.smsSkipped ? `, ${result.smsSkipped} skipped (no number on file)` : ''}.`);
        document.getElementById('bm-result').innerHTML = `<div class="hint-box">${lines.map(esc).join('<br>')}</div>`;
        toast('Message sent');
      } catch (err) {
        toast(err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Send';
      }
    });
  }

  // Grouped by student name, searchable -- click a name to see all four of their
  // activity categories together, instead of four long flat tables mixing every
  // student together.
  async function renderAdminStudentActivity() {
    const { submissions, assignmentSubmissions, results, attendance } = await api('/admin/student-activity');
    const byStudent = new Map();
    function bucket(id, name) {
      if (!byStudent.has(id)) byStudent.set(id, { id, name, submissions: [], assignmentSubmissions: [], results: [], attendance: [] });
      return byStudent.get(id);
    }
    submissions.forEach((s) => bucket(s.studentId, s.student.fullName).submissions.push(s));
    assignmentSubmissions.forEach((s) => bucket(s.studentId, s.student.fullName).assignmentSubmissions.push(s));
    results.forEach((r) => bucket(r.studentId, r.student.fullName).results.push(r));
    attendance.forEach((a) => bucket(a.studentId, a.student.fullName).attendance.push(a));
    const students = Array.from(byStudent.values());

    function listHtml(list) {
      return list.map((s) => {
        const count = s.submissions.length + s.assignmentSubmissions.length + s.results.length + s.attendance.length;
        return `
        <div class="list-row clickable" data-student="${s.id}" style="cursor:pointer;">
          <div style="font-weight:600;">${esc(s.name)}</div>
          <span class="pill pill-muted">${count} activit${count === 1 ? 'y' : 'ies'}</span>
        </div>`;
      }).join('') || '<p class="muted" style="padding:16px;">No activity yet.</p>';
    }

    function renderStudentActivity(s) {
      view.innerHTML = `
        <div class="page-head"><h1>${esc(s.name)}</h1><button class="btn btn-ghost btn-sm" id="back-btn">← Back</button></div>
        <h3 style="margin-bottom:10px; font-size:1rem;">Tests &amp; exams</h3>
        <div class="card" style="overflow-x:auto; margin-bottom:26px;">
          <table class="data-table">
            <thead><tr><th>Course</th><th>Assessment</th><th>Type</th><th>Score</th><th>Date</th></tr></thead>
            <tbody>${s.submissions.map((x) => `<tr><td class="tabular">${esc(x.assessment.course.code)}</td><td>${esc(x.assessment.title)}</td><td>${esc(x.assessment.type)}</td><td class="tabular">${x.score}/${x.total}</td><td class="tabular">${new Date(x.submittedAt).toLocaleDateString()}</td></tr>`).join('') || '<tr><td colspan="5" class="muted" style="padding:16px;">None yet.</td></tr>'}</tbody>
          </table>
        </div>
        <h3 style="margin-bottom:10px; font-size:1rem;">Assignments</h3>
        <div class="card" style="overflow-x:auto; margin-bottom:26px;">
          <table class="data-table">
            <thead><tr><th>Course</th><th>Assignment</th><th>Score</th><th>Submitted</th></tr></thead>
            <tbody>${s.assignmentSubmissions.map((x) => `<tr><td class="tabular">${esc(x.assignment.course.code)}</td><td>${esc(x.assignment.title)}</td><td class="tabular">${x.score == null ? 'Unmarked' : x.score}</td><td class="tabular">${new Date(x.submittedAt).toLocaleDateString()}</td></tr>`).join('') || '<tr><td colspan="4" class="muted" style="padding:16px;">None yet.</td></tr>'}</tbody>
          </table>
        </div>
        <h3 style="margin-bottom:10px; font-size:1rem;">Formal results</h3>
        <div class="card" style="overflow-x:auto; margin-bottom:26px;">
          <table class="data-table">
            <thead><tr><th>Course</th><th>Semester</th><th>Score</th><th>Grade</th><th>Published</th></tr></thead>
            <tbody>${s.results.map((x) => `<tr><td class="tabular">${esc(x.course.code)}</td><td>${esc(x.term)}</td><td class="tabular">${x.score}</td><td>${esc(x.grade || '—')}</td><td class="tabular">${new Date(x.publishedAt).toLocaleDateString()}</td></tr>`).join('') || '<tr><td colspan="5" class="muted" style="padding:16px;">None yet.</td></tr>'}</tbody>
          </table>
        </div>
        <h3 style="margin-bottom:10px; font-size:1rem;">Classes attended</h3>
        <div class="card" style="overflow-x:auto;">
          <table class="data-table">
            <thead><tr><th>Course</th><th>Date</th><th>Status</th></tr></thead>
            <tbody>${s.attendance.map((x) => `<tr><td class="tabular">${esc(x.course.code)}</td><td class="tabular">${new Date(x.date).toLocaleDateString()}</td><td>${esc(x.status)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted" style="padding:16px;">None yet.</td></tr>'}</tbody>
          </table>
        </div>
      `;
      document.getElementById('back-btn').addEventListener('click', () => navigate('admin-student-activity'));
    }

    view.innerHTML = `
      <div class="page-head"><h1>Student Activity</h1></div>
      <div class="field" style="max-width:320px; margin-bottom:16px;">
        <input type="text" id="activity-search" placeholder="Search by name…" style="width:100%; padding:10px 12px; border-radius:10px; border:1px solid var(--line); background:var(--paper); color:var(--ink);">
      </div>
      <div class="card" id="activity-list">${listHtml(students)}</div>
    `;
    function wire() {
      view.querySelectorAll('[data-student]').forEach((row) => {
        row.addEventListener('click', () => renderStudentActivity(students.find((s) => s.id === row.dataset.student)));
      });
    }
    wire();
    document.getElementById('activity-search').addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      const filtered = !q ? students : students.filter((s) => s.name.toLowerCase().includes(q));
      document.getElementById('activity-list').innerHTML = listHtml(filtered);
      wire();
    });
  }

  // ---------- boot ----------
  if (state.token && state.user) {
    authScreen.style.display = 'none';
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
  } else if (new URLSearchParams(location.search).get('from') !== 'intro') {
    // Landed here directly -- a bookmark, a typed URL, or a new tab's own history
    // autocomplete -- rather than by clicking through from the introduction page.
    // index.html's own links to this page all carry ?from=intro, so its "Open
    // Learnza"/"Log in"/"Learn independently" buttons still land straight on this
    // login screen as always; anything else goes to the introduction page first,
    // matching the site's intended entry flow instead of skipping straight to a
    // bare login form.
    window.location.replace('index.html');
  } else if (location.hash.includes('register')) {
    document.querySelector('[data-audience="individual"]').click();
    document.querySelector('#individual-panel [data-tab="register"]').click();
  }
})();
