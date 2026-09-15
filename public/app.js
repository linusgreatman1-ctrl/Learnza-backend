(function () {
  'use strict';

  const state = {
    token: localStorage.getItem('vp_token') || null,
    user: JSON.parse(localStorage.getItem('vp_user') || 'null'),
    schoolId: null,
    view: { screen: 'home', courseId: null, groupId: null, assessmentId: null },
  };
  let examTimerHandle = null; // the countdown interval from renderTakeAssessment, if any

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
          attendedSchoolName: document.getElementById('reg-school').value.trim(),
          attendedDepartment: document.getElementById('reg-department').value.trim(),
          courseOfStudy: document.getElementById('reg-course').value.trim(),
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
    localStorage.removeItem('vp_token');
    localStorage.removeItem('vp_user');
    window.speechSynthesis && window.speechSynthesis.cancel();
    window.location.href = 'index.html';
  });

  async function onAuthed(token, user) {
    state.token = token;
    state.user = user;
    localStorage.setItem('vp_token', token);
    localStorage.setItem('vp_user', JSON.stringify(user));
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
      const { school, department } = await api('/auth/me');
      state.school = school;
      state.department = department;
    } catch { state.school = null; state.department = null; }
    if (state.school) {
      try { state.semesters = (await api('/semesters')).semesters; } catch { state.semesters = []; }
    } else {
      state.semesters = [];
    }
  }

  function defaultScreenFor(role) {
    if (role === 'STUDENT') return state.user.isIndividual ? 'individual-courses' : 'courses';
    if (role === 'LECTURER') return 'lect-courses';
    return 'admin-directory';
  }

  // ---------- Sidebar ----------
  // Individual (non-school) learners get a deliberately smaller nav -- no
  // library/groups/CBT/leaderboard/digital-id, since those are all school-institutional
  // features. They get their own self-directed courses instead of "My Courses".
  const NAV = {
    STUDENT: [
      ['my-dashboard', 'My Dashboard'],
      ['courses', 'My Courses'],
      ['library', 'e-Library'],
      ['groups', 'Study Groups'],
      ['past-questions-hub', 'Past Questions'],
      ['cbt-mock', 'CBT Mock Exam Practice'],
      ['semester-exam-hub', 'Semester Exam'],
      ['research', 'AI Research Assistant'],
      ['progress', 'My Progress'],
      ['leaderboard', 'Leaderboard'],
      ['digital-id', 'Digital ID'],
      ['billing', 'Subscription'],
    ],
    // Individual learners get the same dashboard concept, but no library/groups/
    // leaderboard/digital-id (school-institutional features) and no CBT/past-questions/
    // semester-exam yet -- those need an app-generated-content engine for self-created
    // courses that doesn't exist yet.
    STUDENT_INDIVIDUAL: [
      ['individual-courses', 'My Courses'],
      ['my-dashboard', 'My Dashboard'],
      ['research', 'AI Research Assistant'],
      ['progress', 'My Progress'],
      ['billing', 'Subscription'],
    ],
    LECTURER: [
      ['lect-courses', 'My Courses'],
      ['lect-library', 'e-Library'],
      ['lect-assessments', 'Assessments'],
      ['lect-semester-exam', 'Semester Exam'],
      ['research', 'AI Research Assistant'],
      ['staff-profile', 'My Staff Profile'],
    ],
    ADMIN: [
      ['admin-directory', 'Staff & Student Directory'],
      ['admin-academics', 'Departments & Courses'],
      ['admin-semester-exam', 'Semester Exam'],
      ['admin-activity', 'Lecturer Activity'],
      ['admin-student-activity', 'Student Activity'],
      ['admin-lab-queue', 'Digital Lab'],
      ['admin-admissions', 'Admissions'],
      ['admin-staff-records', 'Staff Records'],
      ['admin-student-requests', 'Student Requests'],
      ['admin-hostel-allocations', 'Hostels'],
    ],
  };

  function buildSidebar() {
    const u = state.user;
    const roleLabel = u.isIndividual ? 'Independent learner' : u.role.charAt(0) + u.role.slice(1).toLowerCase();
    const lines = [`${esc(u.fullName)} · ${esc(roleLabel)}`];
    if (u.isIndividual) {
      const bits = [u.attendedSchoolName, u.courseOfStudy].filter(Boolean).map(esc);
      if (bits.length) lines.push(bits.join(' · '));
    } else if (state.school) {
      const schoolLine = [state.school.name, state.school.location].filter(Boolean).map(esc).join(', ');
      lines.push(schoolLine);
      if (state.department) lines.push(esc(state.department.name));
    }
    document.getElementById('who-box').innerHTML = lines.map((l) => `<div>${l}</div>`).join('');

    const semesterBox = document.getElementById('semester-box');
    if (state.school && state.semesters && state.semesters.length) {
      const current = state.semesters.find((s) => s.isCurrent);
      if (u.role === 'ADMIN') {
        semesterBox.innerHTML = `
          <select id="semester-select" class="nav-item" style="font-weight:600;">
            ${state.semesters.map((s) => `<option value="${s.id}" ${s.isCurrent ? 'selected' : ''}>${esc(s.name)}${s.isCurrent ? ' (current)' : ''}</option>`).join('')}
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
        semesterBox.innerHTML = current ? `<div class="who" style="padding-bottom:8px;">📅 ${esc(current.name)}</div>` : '';
      }
    } else {
      semesterBox.innerHTML = '';
    }

    const nav = document.getElementById('nav-items');
    const navKey = state.user.role === 'STUDENT' && state.user.isIndividual ? 'STUDENT_INDIVIDUAL' : state.user.role;
    nav.innerHTML = NAV[navKey]
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
          if (item.dataset.link) navigate(item.dataset.link);
          refreshNotifications();
        });
      });
    } catch {
      // silent -- notifications are a convenience, not critical path
    }
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
  }

  const view = document.getElementById('view');

  function navigate(screen, params = {}) {
    window.speechSynthesis && window.speechSynthesis.cancel();
    if (state.view.screen === 'live-class' && screen !== 'live-class') teardownLive();
    if (examTimerHandle) { clearInterval(examTimerHandle); examTimerHandle = null; }
    if (simliAvatarClient) { try { simliAvatarClient.close(); } catch { /* already closed */ } simliAvatarClient = null; }
    state.view = Object.assign({ screen }, params);
    markActiveNav(screen);
    render();
  }

  // Navigation should feel instant: only show a "Loading…" placeholder if the target
  // screen's data hasn't arrived within 150ms, instead of blanking the page on every
  // click regardless of how fast the response is.
  async function render() {
    const loadingTimer = setTimeout(() => { view.innerHTML = '<p class="muted">Loading…</p>'; }, 150);
    try {
      await dispatch();
    } catch (err) {
      if (err.code === 'SUBSCRIPTION_REQUIRED') return renderUpgradePrompt(err.message);
      view.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
    } finally {
      clearTimeout(loadingTimer);
    }

    function dispatch() {
      switch (state.view.screen) {
        case 'courses': return renderStudentCourses();
        case 'individual-courses': return renderIndividualCourses();
        case 'individual-course-detail': return renderIndividualCourseDetail();
        case 'course-detail': return renderCourseDetail();
        case 'lesson-player': return renderLessonPlayer();
        case 'library': return renderLibrary(false);
        case 'groups': return renderGroups();
        case 'group-chat': return renderGroupChat();
        case 'my-dashboard': return renderMyDashboard();
        case 'cbt-mock': return renderAssessments(false);
        case 'take-assessment': return renderTakeAssessment();
        case 'assessment-review': return renderAssessmentReview();
        case 'billing': return renderBilling();
        case 'ai-teacher-session': return renderAiTeacherSession();
        case 'live-class': return renderLiveClass();
        case 'progress': return renderProgress();
        case 'leaderboard': return renderLeaderboard();
        case 'research': return renderResearchAssistant();
        case 'digital-id': return renderDigitalId();
        case 'lab': return renderLab();
        case 'transcript': return renderTranscript();
        case 'attendance-history': return renderStudentAttendanceHistory();
        case 'past-questions-hub': return renderPastQuestionsHub();
        case 'practice-take': return renderPracticeTake();
        case 'semester-exam-hub': return renderSemesterExamHub();

        case 'lect-courses': return renderLecturerCourses();
        case 'lect-lessons': return renderLecturerLessons();
        case 'lect-library': return renderLibrary(true);
        case 'lect-assessments': return renderAssessments(true);
        case 'lect-semester-exam': return renderLecturerSemesterExam();
        case 'lect-assessment-results': return renderAssessmentResults();
        case 'lect-attendance': return renderLecturerAttendance();
        case 'lect-assignments': return renderLecturerAssignments();
        case 'lect-assignment-submissions': return renderAssignmentSubmissions();
        case 'lect-results': return renderLecturerResults();
        case 'staff-profile': return renderStaffProfile();

        case 'admin-directory': return renderAdminDirectory();
        case 'admin-directory-list': return renderAdminDirectoryList();
        case 'admin-directory-detail': return renderAdminDirectoryDetail();
        case 'admin-academics': return renderAdminAcademics();
        case 'admin-semester-exam': return renderAdminSemesterExam();
        case 'admin-activity': return renderAdminActivity();
        case 'admin-lab-queue': return renderAdminLabQueue();
        case 'admin-admissions': return renderAdminAdmissions();
        case 'admin-admissions-detail': return renderAdminAdmissionDetail();
        case 'admin-attitude-test': return renderAdminAttitudeTest();
        case 'admin-staff-records': return renderAdminStaffRecords();
        case 'admin-student-requests': return renderAdminStudentRequests();
        case 'admin-hostel-allocations': return renderAdminHostelAllocations();
        case 'admin-hostel-detail': return renderAdminHostelDetail();
        case 'admin-student-activity': return renderAdminStudentActivity();
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
    const [{ course }, { assessments }] = await Promise.all([
      api(`/individual-courses/${state.view.courseId}`),
      api(`/individual-courses/${state.view.courseId}/assessments`),
    ]);
    view.innerHTML = `
      <div class="page-head">
        <h1>${esc(course.title)}</h1>
        <button class="btn btn-ghost btn-sm" id="back-btn">← Back to courses</button>
      </div>
      ${course.description ? `<p class="muted" style="margin-bottom:20px;">${esc(course.description)}</p>` : ''}
      <div class="card" style="padding:24px; text-align:center; margin-bottom:22px;">
        <span class="pill pill-accent">Subscription feature</span>
        <h3 style="margin:14px 0 8px;">Start an AI Teacher lesson</h3>
        <p class="muted" style="margin-bottom:18px;">Tell the AI Teacher what to cover in this course.</p>
        <button class="btn btn-accent" id="start-ai-teacher-btn">Start AI Teacher</button>
      </div>

      <h3 style="margin-bottom:10px; font-size:1rem;">Tests &amp; assignments</h3>
      <p class="muted" style="margin-bottom:12px;">No lecturer here — the AI Teacher generates these on request, auto-scores them, and always shows you a review of your mistakes.</p>
      <div style="display:flex; gap:10px; margin-bottom:18px; flex-wrap:wrap;">
        <button class="btn btn-ghost btn-sm" id="gen-test-btn">📝 Generate a test</button>
        <button class="btn btn-ghost btn-sm" id="gen-assignment-btn">📋 Generate an assignment</button>
      </div>
      <div class="card" style="margin-bottom:22px;">
        ${assessments.map((a) => `
          <div class="list-row" data-take="${a.id}" style="cursor:pointer;">
            <div><div style="font-weight:600;">${esc(a.title)}</div><div class="meta">${esc(a.type)} · ${a._count.questions} question${a._count.questions === 1 ? '' : 's'}</div></div>
            <span class="pill pill-accent">Open</span>
          </div>
        `).join('') || '<p class="muted" style="padding:16px;">None yet — generate one above.</p>'}
      </div>

      <button class="btn btn-ghost btn-sm" id="delete-course-btn" style="color:var(--danger);">Delete this course</button>
    `;
    document.getElementById('back-btn').addEventListener('click', () => navigate('individual-courses'));
    document.getElementById('start-ai-teacher-btn').addEventListener('click', () => {
      const topic = prompt(`What topic in ${course.title} should the AI Teacher cover?`);
      if (!topic || !topic.trim()) return;
      startAiTeacherSession(course.id, topic.trim(), true);
    });
    async function generate(kind, label) {
      const topic = prompt(`What topic should the ${label} cover?`);
      if (!topic || !topic.trim()) return;
      toast(`Generating your ${label}…`);
      try {
        await api(`/individual-courses/${course.id}/assessments/generate`, { method: 'POST', body: { topic: topic.trim(), kind } });
        toast(`${label.charAt(0).toUpperCase() + label.slice(1)} ready`);
        render();
      } catch (err) {
        if (err.code === 'AI_NOT_CONFIGURED') return renderUpgradePrompt(err.message);
        toast(err.message);
      }
    }
    document.getElementById('gen-test-btn').addEventListener('click', () => generate('TEST', 'test'));
    document.getElementById('gen-assignment-btn').addEventListener('click', () => generate('ASSIGNMENT', 'assignment'));
    view.querySelectorAll('[data-take]').forEach((row) => {
      row.addEventListener('click', () => navigate('take-assessment', { assessmentId: row.dataset.take, backTo: 'individual-course-detail', backCourseId: course.id }));
    });
    document.getElementById('delete-course-btn').addEventListener('click', async () => {
      if (!confirm('Delete this course? This cannot be undone.')) return;
      await api(`/individual-courses/${course.id}`, { method: 'DELETE' });
      toast('Course deleted');
      navigate('individual-courses');
    });
  }

  // ================= STUDENT =================

  async function renderStudentCourses() {
    const [{ courses: mine }, { departments }] = await Promise.all([
      api('/students/me/courses'),
      api(`/departments?schoolId=${state.user.schoolId}`),
    ]);
    const deptCourses = {};
    for (const d of departments) {
      deptCourses[d.id] = (await api(`/departments/${d.id}/courses`)).courses;
    }
    const mineIds = new Set(mine.map((c) => c.id));

    view.innerHTML = `
      <div class="page-head"><h1>My Courses</h1></div>
      ${mine.length ? `<div class="grid-cards" style="margin-bottom:30px;">
        ${mine.map(courseCardHtml).join('')}
      </div>` : '<p class="muted" style="margin-bottom:24px;">You are not enrolled in any course yet — pick from your department below.</p>'}
      <div class="page-head"><h1 style="font-size:1.15rem;">Browse &amp; enroll by department</h1></div>
      ${departments.map((d) => `
        <div style="margin-bottom:22px;">
          <div class="muted" style="font-weight:700; margin-bottom:8px;">${esc(d.name)}</div>
          <div class="grid-cards">
            ${deptCourses[d.id].map((c) => enrollCardHtml(c, mineIds.has(c.id))).join('') || '<p class="muted">No courses yet.</p>'}
          </div>
        </div>
      `).join('')}
    `;

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
          <span class="pill pill-accent">Subscription feature</span>
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
    try {
      const { session } = await api(path, { method: 'POST', body: { topic } });
      navigate('ai-teacher-session', { sessionId: session.id, isIndividual });
    } catch (err) {
      if (err.code === 'SUBSCRIPTION_REQUIRED') return renderUpgradePrompt(err.message);
      toast(err.message);
    }
  }

  async function renderLessonPlayer() {
    const { lessons } = await api(`/courses/${state.view.courseId}/lessons`);
    const lesson = lessons.find((l) => l.id === state.view.lessonId);
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
      document.getElementById('back-btn').addEventListener('click', () => navigate('course-detail', { courseId: state.view.courseId }));
      document.getElementById('go-upgrade-btn').addEventListener('click', () => navigate('billing'));
      return;
    }

    if (simliAvatarClient) { try { simliAvatarClient.close(); } catch { /* already closed */ } simliAvatarClient = null; }
    const { avatarConfigured } = await api('/config').catch(() => ({ avatarConfigured: false }));
    const words = lesson.script.split(/(\s+)/);
    const scriptHtml = words.map((w, i) => `<span data-w="${i}">${esc(w)}</span>`).join('');

    view.innerHTML = `
      <div class="page-head">
        <h1>${esc(lesson.title)}</h1>
        <button class="btn btn-ghost btn-sm" id="back-btn">← Back to course</button>
      </div>
      <div class="card lesson-player">
        <span class="pill pill-accent">AI Teacher — subscriber lesson</span>
        ${lesson.videoUrl ? `<div style="margin-top:14px;"><video src="${esc(lesson.videoUrl)}" controls style="width:100%; border-radius:10px;"></video></div>` : `
          <div class="ai-avatar-box" style="margin-top:14px;">
            <div class="ai-avatar-ring" id="ai-avatar-ring">${esc(initials(lesson.title || 'AI'))}</div>
            <video id="avatar-video" class="ai-avatar-video" autoplay playsinline hidden></video>
            <audio id="avatar-audio" autoplay hidden></audio>
            <div class="ai-avatar-label" id="ai-avatar-label">${avatarConfigured ? 'AI Teacher — video avatar available' : 'AI Teacher'}</div>
            ${avatarConfigured ? `<button class="btn btn-ghost btn-sm" id="start-avatar-btn" style="margin-top:10px;">🎥 Connect video avatar</button>` : ''}
          </div>
        `}
        <div class="controls">
          <button class="btn btn-primary" id="play-btn">▶ Play AI narration</button>
          <button class="btn btn-ghost" id="pause-btn">Pause</button>
          <button class="btn btn-ghost" id="stop-btn">Stop</button>
        </div>
        <div class="smart-board"><div class="board-action board-text" id="script-text">${scriptHtml}</div></div>
      </div>
    `;
    document.getElementById('back-btn').addEventListener('click', () => navigate('course-detail', { courseId: state.view.courseId }));

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

  function speak(text, avatarEl) {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 0.98;
    if (avatarEl) {
      utter.onstart = () => avatarEl.classList.add('speaking');
      utter.onend = () => avatarEl.classList.remove('speaking');
      utter.onerror = () => avatarEl.classList.remove('speaking');
    }
    window.speechSynthesis.speak(utter);
  }

  // A live Simli connection is tied to specific video/audio DOM elements, and this
  // app fully replaces view.innerHTML on every render (section advance, interrupt
  // answer, etc.) rather than patching the DOM -- so the connection can't survive a
  // re-render. Closed and nulled at the top of every renderAiTeacherSession() call;
  // the student just taps "Connect video avatar" again for the new section.
  let simliAvatarClient = null;

  function renderBoardActionsHtml(actions) {
    if (!actions || !actions.length) return '<div class="board-action board-text muted">Nothing on the board yet.</div>';
    return actions.map((a, i) => {
      if (a.type === 'DIAGRAM') return `<div class="board-action board-diagram" data-idx="${i}">${a.content}</div>`;
      if (a.type === 'EQUATION') return `<div class="board-action board-equation" data-idx="${i}"></div>`;
      if (a.type === 'GRAPH') return `<div class="board-action board-graph" data-idx="${i}"><canvas></canvas></div>`;
      return `<div class="board-action board-text" data-idx="${i}">${esc(a.content)}</div>`;
    }).join('');
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
  // failure -- config comes from the backend so the raw Simli API key only ever
  // reaches an authenticated, subscribed student, never an anonymous visitor.
  async function connectAvatar(videoEl, audioEl, ringEl, labelEl) {
    if (!window.SimliClient) { toast('Video avatar library failed to load.'); return null; }
    try {
      const config = await api(`/ai-teacher/avatar-config`, { method: 'POST' });
      const client = new window.SimliClient();
      client.Initialize({ apiKey: config.apiKey, faceID: config.faceID, handleSilence: true, videoRef: videoEl, audioRef: audioEl });
      await client.start();
      videoEl.hidden = false;
      ringEl.style.display = 'none';
      if (labelEl) labelEl.textContent = 'AI Teacher — video avatar connected';
      return client;
    } catch (err) {
      if (err.code === 'SUBSCRIPTION_REQUIRED') { renderUpgradePrompt(err.message); return null; }
      toast(err.message || 'Could not connect the video avatar.');
      return null;
    }
  }

  // Speaks through the connected avatar (server TTS -> PCM16 -> Simli lip-sync),
  // falling back to the browser's own speech synthesis when no avatar is connected.
  async function speakThroughAvatarOrTts(text, ringEl) {
    if (!simliAvatarClient) return speak(text, ringEl);
    try {
      const { data } = await api(`/ai-teacher/tts`, { method: 'POST', body: { text } });
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const chunkSize = 6400; // ~130ms of 24kHz 16-bit mono PCM per chunk
      let i = 0;
      const interval = setInterval(() => {
        if (i >= bytes.length) { clearInterval(interval); return; }
        simliAvatarClient.sendAudioData(bytes.subarray(i, i + chunkSize));
        i += chunkSize;
      }, 130);
    } catch (err) {
      toast(err.message || 'The AI Teacher had trouble speaking that.');
    }
  }

  async function renderAiTeacherSession() {
    if (simliAvatarClient) { try { simliAvatarClient.close(); } catch { /* already closed */ } simliAvatarClient = null; }
    const { session } = await api(`/ai-teacher/sessions/${state.view.sessionId}`);
    const section = session.plan.sections[session.sectionIdx];
    const isLast = session.sectionIdx >= session.plan.sections.length - 1;
    const { avatarConfigured } = await api('/config').catch(() => ({ avatarConfigured: false }));

    view.innerHTML = `
      <div class="page-head">
        <div><span class="pill pill-accent">AI Teacher — live session</span><h1 style="margin-top:8px;">${esc(session.plan.title)}</h1></div>
        <button class="btn btn-ghost btn-sm" id="back-btn">← End session</button>
      </div>
      <div class="card lesson-player">
        <div class="ai-avatar-box">
          <div class="ai-avatar-ring" id="ai-avatar-ring">${esc(initials(session.plan.title || 'AI'))}</div>
          <video id="avatar-video" class="ai-avatar-video" autoplay playsinline hidden></video>
          <audio id="avatar-audio" autoplay hidden></audio>
          <div class="ai-avatar-label" id="ai-avatar-label">${avatarConfigured ? 'AI Teacher — video avatar available' : 'AI Teacher'}</div>
          ${avatarConfigured ? `<button class="btn btn-ghost btn-sm" id="start-avatar-btn" style="margin-top:10px;">🎥 Connect video avatar</button>` : ''}
        </div>
        <div class="smart-board" id="smart-board">${renderBoardActionsHtml(section.boardActions)}</div>
        <div class="meta" style="margin-top:12px;">Section ${session.sectionIdx + 1} of ${session.plan.sections.length}${session.status === 'COMPLETED' ? ' · Completed' : ''}</div>
        <h3 style="margin:8px 0 12px;">${esc(section.title)}</h3>
        <div class="controls">
          <button class="btn btn-primary" id="play-btn">▶ Hear the teacher</button>
          ${session.status !== 'COMPLETED' ? `<button class="btn btn-accent" id="next-btn">${isLast ? 'Finish lesson' : 'Next section →'}</button>` : ''}
        </div>

        ${section.checkQuestion && session.status !== 'COMPLETED' ? `
          <div class="hr"></div>
          <div style="font-weight:600; margin-bottom:8px;">Quick check: ${esc(section.checkQuestion)}</div>
          <div class="field"><textarea id="check-answer-input" placeholder="Type your answer…"></textarea></div>
          <button class="btn btn-ghost btn-sm" id="check-answer-btn">Submit answer</button>
          <div id="check-feedback" style="margin-top:10px;"></div>
        ` : ''}

        <div class="got-question-toggle" id="got-question-toggle">
          <div><div style="font-weight:600;">✋ Got a question? Raise your hand</div><div class="gq-sub">Learnza answers visually without leaving the lesson</div></div>
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
    mountBoardActions(document.getElementById('smart-board'), section.boardActions);

    document.getElementById('back-btn').addEventListener('click', () => {
      if (session.individualCourseId) navigate('individual-course-detail', { courseId: session.individualCourseId });
      else navigate('course-detail', { courseId: session.courseId });
    });
    document.getElementById('play-btn').addEventListener('click', () => speakThroughAvatarOrTts(section.speechText, document.getElementById('ai-avatar-ring')));

    const nextBtn = document.getElementById('next-btn');
    if (nextBtn) nextBtn.addEventListener('click', async () => {
      try {
        const { done } = await api(`/ai-teacher/sessions/${session.id}/next`, { method: 'POST' });
        if (done) toast('Lesson complete — nice work!');
        render();
      } catch (err) {
        if (err.code === 'SUBSCRIPTION_REQUIRED') return renderUpgradePrompt(err.message);
        toast(err.message);
      }
    });

    const checkBtn = document.getElementById('check-answer-btn');
    if (checkBtn) checkBtn.addEventListener('click', async () => {
      const answer = document.getElementById('check-answer-input').value.trim();
      if (!answer) return;
      try {
        const result = await api(`/ai-teacher/sessions/${session.id}/check-answer`, { method: 'POST', body: { answer } });
        document.getElementById('check-feedback').innerHTML = `<div class="pill ${result.correct ? 'pill-pass' : 'pill-danger'}">${result.correct ? 'Correct' : 'Not quite'}</div><p class="muted" style="margin-top:6px;">${esc(result.feedback)}</p>`;
      } catch (err) {
        toast(err.message);
      }
    });

    document.getElementById('got-question-toggle').addEventListener('click', () => {
      const panel = document.getElementById('got-question-panel');
      panel.hidden = !panel.hidden;
      document.getElementById('gq-arrow').textContent = panel.hidden ? '▼' : '▲';
    });
    document.getElementById('interrupt-btn').addEventListener('click', async () => {
      const input = document.getElementById('interrupt-input');
      const question = input.value.trim();
      if (!question) return;
      input.value = '';
      try {
        // Updates the log/board in place (not a full render()) so a live avatar
        // connection survives the interrupt instead of needing to reconnect.
        const { answer, boardActions } = await api(`/ai-teacher/sessions/${session.id}/interrupt`, { method: 'POST', body: { question } });
        const log = document.getElementById('interrupt-log');
        log.insertAdjacentHTML('beforeend', `
          <div class="chat-msg" style="max-width:100%; align-self:flex-end; background:var(--accent-soft);">${esc(question)}</div>
          <div class="chat-msg" style="max-width:100%;">${esc(answer)}</div>
        `);
        log.scrollTop = log.scrollHeight;
        if (boardActions && boardActions.length) {
          const board = document.getElementById('smart-board');
          board.innerHTML = renderBoardActionsHtml(boardActions);
          mountBoardActions(board, boardActions);
        }
        speakThroughAvatarOrTts(answer, document.getElementById('ai-avatar-ring'));
      } catch (err) {
        if (err.code === 'SUBSCRIPTION_REQUIRED') return renderUpgradePrompt(err.message);
        toast(err.message);
      }
    });

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
        speakThroughAvatarOrTts(section.speechText, document.getElementById('ai-avatar-ring'));
      } else {
        avatarBtn.disabled = false;
        avatarBtn.textContent = '🎥 Connect video avatar';
      }
    });
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
    if (live.localStream) live.localStream.getTracks().forEach((t) => t.stop());
    if (live.socket) live.socket.disconnect();
    live = null;
  }

  async function renderLiveClass() {
    const { courseId, liveClassId, isHost, title } = state.view;
    view.innerHTML = `
      <div class="page-head">
        <div><span class="pill pill-danger"><span class="live-dot"></span>Live</span><h1 style="margin-top:8px;">${esc(title || 'Live class')}</h1></div>
        <button class="btn btn-ghost btn-sm" id="leave-btn">${isHost ? 'End class' : 'Leave'}</button>
      </div>
      <div class="video-grid" id="video-grid"></div>
      <div class="card live-chat">
        <div class="chat-messages" id="live-chat-messages"></div>
        <form class="chat-input-row" id="live-chat-form">
          <input type="text" id="live-chat-input" placeholder="Message the class…">
          <button class="btn btn-primary btn-sm" type="submit">Send</button>
        </form>
      </div>
    `;

    teardownLive();
    live = { isHost, liveClassId, peers: new Map(), localStream: null, socket: null };

    document.getElementById('leave-btn').addEventListener('click', async () => {
      // Call the REST endpoint directly rather than emitting a socket event right
      // before disconnecting -- that emit can race the disconnect and never reach
      // the server, leaving the class stuck "live" for students.
      if (isHost) {
        try { await api(`/live/${liveClassId}/end`, { method: 'POST' }); } catch {}
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

    try {
      await setupLiveSocket(isHost, liveClassId, courseId);
    } catch (err) {
      toast(err.message || 'Could not connect to the live class.');
    }
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
    socket.on('live:ended', () => {
      toast('The live class has ended.');
      teardownLive();
      navigate('course-detail', { courseId });
    });

    if (isHost) {
      live.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      addVideoTile('self', 'You (host)', live.localStream, true);
      socket.emit('teacher:join', { liveClassId });

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
      });
      socket.on('webrtc:answer', async ({ from, answer }) => {
        const pc = live.peers.get(from);
        if (pc) await pc.setRemoteDescription(answer);
      });
      socket.on('webrtc:ice-candidate', async ({ from, candidate }) => {
        const pc = live.peers.get(from);
        if (pc) { try { await pc.addIceCandidate(candidate); } catch {} }
      });
    } else {
      socket.emit('student:join', { liveClassId });
      socket.on('webrtc:offer', async ({ from, offer }) => {
        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        live.peers.set(from, pc);
        pc.onicecandidate = (e) => { if (e.candidate) socket.emit('webrtc:ice-candidate', { to: from, candidate: e.candidate }); };
        pc.ontrack = (e) => addVideoTile('host', 'Lecturer', e.streams[0], false);
        await pc.setRemoteDescription(offer);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('webrtc:answer', { to: from, answer });
      });
      socket.on('webrtc:ice-candidate', async ({ from, candidate }) => {
        const pc = live.peers.get(from);
        if (pc) { try { await pc.addIceCandidate(candidate); } catch {} }
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
    const { departments } = await api(`/departments?schoolId=${state.user.schoolId}`);
    const deptId = state.view.departmentId || '';
    const { leaderboard } = await api('/leaderboard' + (deptId ? `?departmentId=${deptId}` : ''));
    const myEntry = leaderboard.find((row) => row.fullName === state.user.fullName);

    view.innerHTML = `
      <div class="page-head"><h1>Leaderboard</h1><button class="btn btn-ghost btn-sm" id="back-btn">← Back</button></div>
      <div class="field" style="max-width:280px; margin-bottom:16px;">
        <label>Department</label>
        <select id="leaderboard-dept">
          <option value="">All departments</option>
          ${departments.map((d) => `<option value="${d.id}" ${d.id === deptId ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
        </select>
      </div>
      ${myEntry ? `<div class="card" style="padding:14px 18px; margin-bottom:16px; display:flex; justify-content:space-between; align-items:center;"><span>Your rank: <strong class="tabular">#${myEntry.rank}</strong></span><span class="pill pill-accent tabular">${myEntry.points} pts</span></div>` : ''}
      <div class="card" style="overflow-x:auto;">
        <table class="data-table">
          <thead><tr><th>#</th><th>Student</th><th>Department</th><th>Points</th><th>Streak</th></tr></thead>
          <tbody>
            ${leaderboard.map((row) => `
              <tr ${row.fullName === state.user.fullName ? 'style="background:var(--accent-soft);"' : ''}>
                <td class="tabular">${row.rank}</td>
                <td>${esc(row.fullName)}</td>
                <td>${esc(row.department || '—')}</td>
                <td class="tabular">${row.points}</td>
                <td class="tabular">${row.currentStreak}🔥</td>
              </tr>
            `).join('') || '<tr><td colspan="5" class="muted" style="padding:16px;">No points earned yet — be the first!</td></tr>'}
          </tbody>
        </table>
      </div>
    `;
    document.getElementById('back-btn').addEventListener('click', () => navigate('my-dashboard'));
    document.getElementById('leaderboard-dept').addEventListener('change', (e) => {
      navigate('leaderboard', { departmentId: e.target.value });
    });
  }

  // ================= DIGITAL ID / STUDENT PROFILE =================

  function initials(name) {
    return name.split(' ').filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  }

  async function renderDigitalId() {
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
        <div class="id-top"><span>Learnza · Edo College of Education</span><span>Student</span></div>
        <div class="id-row">
          <div class="id-avatar">${esc(initials(u.fullName))}</div>
          <div>
            <div class="id-value">${esc(u.fullName)}</div>
            <div class="id-field tabular" style="margin-top:4px;">${esc(u.matricNumber || 'Matric number pending')}</div>
          </div>
        </div>
        <div class="id-grid">
          <div><div class="id-field">Email</div><div>${esc(u.email)}</div></div>
          <div><div class="id-field">Member since</div><div>${new Date(u.createdAt).toLocaleDateString()}</div></div>
        </div>
      </div>

      <h3 style="margin-bottom:12px; font-size:1rem;">Digital credentials</h3>
      <ul class="credential-list" style="margin-bottom:28px;">
        <li><span>Course registration</span><span class="pill pill-pass">${courses.length} course${courses.length === 1 ? '' : 's'}</span></li>
        <li><span>Subscription</span><span class="pill ${active ? 'pill-pass' : 'pill-muted'}">${active ? `Active until ${new Date(subscription.expiresAt).toLocaleDateString()}` : 'No active plan'}</span></li>
        <li><span>e-Library access</span><span class="pill pill-pass">Granted</span></li>
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
            ? hostelApp.status === 'APPROVED' ? `<span class="pill pill-pass">Room: ${esc(hostelApp.roomAssigned)}</span>`
            : hostelApp.status === 'REJECTED' ? '<span class="pill pill-danger">Not approved</span>'
            : '<span class="pill pill-accent">Pending admin review</span>'
            : `<button class="btn btn-ghost btn-sm" id="request-hostel-btn">Apply for hostel</button>`}
        </li>
        <li><span>Certificates &amp; graduation records</span><span class="pill ${credentials.length ? 'pill-pass' : 'pill-muted'}">${credentials.length ? `${credentials.length} issued` : 'None issued yet'}</span></li>
      </ul>
      ${credentials.length ? `
        <div class="card" style="margin-bottom:28px;">
          ${credentials.map((c) => `<div class="list-row"><div><div style="font-weight:600;">${esc(c.title)}</div><div class="meta">Issued ${new Date(c.issuedAt).toLocaleDateString()} · verification code <span class="tabular">${esc(c.verifyCode)}</span></div></div><a class="btn btn-ghost btn-sm" href="verify.html?code=${esc(c.verifyCode)}" target="_blank" rel="noopener">Verify link</a></div>`).join('')}
        </div>
      ` : ''}

      <h3 style="margin-bottom:12px; font-size:1rem;">Results</h3>
      <div class="card" style="overflow-x:auto;">
        <table class="data-table">
          <thead><tr><th>Course</th><th>Assessment</th><th>Type</th><th>Score</th><th>Date</th></tr></thead>
          <tbody>
            ${results.map((r) => `
              <tr>
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
          <thead><tr><th>Course</th><th>Term</th><th>Score</th><th>Grade</th><th>Remark</th><th>Published</th></tr></thead>
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
  async function renderMyDashboard() {
    const isIndividual = state.user.isIndividual;
    const [{ assignments, attendance, recentResults }, { notifications }] = await Promise.all([
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
    // Individual learners have no lecturer-set assignments/attendance at all (school-
    // institutional concepts) -- only their own app-generated test/assignment results.
    const statTiles = isIndividual
      ? [[avgScorePct == null ? '—' : avgScorePct + '%', 'Recent test average'], [recentResults.length, 'Tests & assignments taken']]
      : [
          [assignments.filter((a) => !a.mySubmission).length, 'Assignments pending'],
          [attendancePct == null ? '—' : attendancePct + '%', 'Attendance rate'],
          [avgScorePct == null ? '—' : avgScorePct + '%', 'Recent test average'],
        ];

    view.innerHTML = `
      <div class="page-head"><h1>My Dashboard</h1></div>
      <div class="grid-cards" style="margin-bottom:26px;">
        ${statTiles.map(([value, label]) => `<div class="card course-card"><div class="code">${value}</div><div class="meta">${esc(label)}</div></div>`).join('')}
      </div>

      ${isIndividual ? '' : `
      <h3 style="margin-bottom:10px; font-size:1rem;">Assignments</h3>
      <div class="card" style="margin-bottom:26px;">
        ${assignments.map((a) => `
          <div class="list-row" style="align-items:flex-start; flex-direction:column; gap:10px;">
            <div style="display:flex; justify-content:space-between; width:100%; flex-wrap:wrap; gap:8px;">
              <div><div style="font-weight:600;">${esc(a.title)} <span class="meta">(${esc(a.course.code)})</span>${a.kind === 'PROJECT' ? ' <span class="pill pill-muted">Project</span>' : ''}</div>${a.dueAt ? `<div class="meta">Due ${new Date(a.dueAt).toLocaleDateString()}</div>` : ''}</div>
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
          </div>
        `).join('') || '<p class="muted" style="padding:16px;">No assignments posted yet.</p>'}
      </div>

      <h3 style="margin-bottom:10px; font-size:1rem;">Attendance</h3>
      <div class="card" style="margin-bottom:26px;">
        ${Object.values(attendanceByCourse).map((c) => `
          <div class="list-row">
            <div>${esc(c.courseCode)}</div>
            <div style="display:flex; align-items:center; gap:10px;">
              <span class="meta tabular">${c.present}/${c.total} present</span>
              <button class="btn btn-ghost btn-sm" data-view-attendance="${c.courseId}" data-code="${esc(c.courseCode)}">View history</button>
            </div>
          </div>
        `).join('') || '<p class="muted" style="padding:16px;">No attendance recorded yet.</p>'}
      </div>
      `}

      <h3 style="margin-bottom:10px; font-size:1rem;">Recent test${isIndividual ? '/assignment' : ''} results</h3>
      <div class="card" style="margin-bottom:26px;">
        ${recentResults.map((r) => `
          <div class="list-row">
            <div><div style="font-weight:600;">${esc(r.assessment.title)}</div><div class="meta">${esc(r.assessment.course ? r.assessment.course.code : r.assessment.individualCourse.title)} · ${esc(r.assessment.type)}</div></div>
            <span class="tabular">${r.score}/${r.total}</span>
          </div>
        `).join('') || `<p class="muted" style="padding:16px;">No ${isIndividual ? 'tests or assignments' : 'test results'} yet.</p>`}
      </div>

      <h3 style="margin-bottom:10px; font-size:1rem;">Notifications</h3>
      <div class="card" style="margin-bottom:26px;">
        ${notifications.slice(0, 8).map((n) => `
          <div class="list-row">
            <div><div style="font-weight:600;">${esc(n.title)}</div><div class="meta">${esc(n.body)}</div></div>
            <span class="meta tabular">${new Date(n.createdAt).toLocaleDateString()}</span>
          </div>
        `).join('') || '<p class="muted" style="padding:16px;">No notifications yet.</p>'}
      </div>

      <div style="display:flex; gap:12px; flex-wrap:wrap;">
        ${isIndividual ? '' : '<button class="btn btn-ghost" id="dash-leaderboard-btn">🏆 See leaderboard</button><button class="btn btn-ghost" id="dash-profile-btn">👤 My profile</button>'}
      </div>
    `;
    const leaderboardBtn = document.getElementById('dash-leaderboard-btn');
    if (leaderboardBtn) leaderboardBtn.addEventListener('click', () => navigate('leaderboard'));
    const profileBtn = document.getElementById('dash-profile-btn');
    if (profileBtn) profileBtn.addEventListener('click', () => navigate('digital-id'));
    view.querySelectorAll('[data-view-attendance]').forEach((btn) => {
      btn.addEventListener('click', () => navigate('attendance-history', { courseId: btn.dataset.viewAttendance, courseCode: btn.dataset.code }));
    });
    view.querySelectorAll('.submit-form').forEach((form) => {
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

  // Every past-question set across every enrolled course, in one page -- the sidebar's
  // "Past Questions" entry (no more per-course-only access).
  async function renderPastQuestionsHub() {
    const { courses } = await api('/students/me/courses');
    const rows = [];
    for (const c of courses) {
      const { assessments } = await api(`/courses/${c.id}/assessments`);
      rows.push({ course: c, sets: assessments.filter((a) => a.type === 'PAST_QUESTION') });
    }
    view.innerHTML = `
      <div class="page-head"><h1>Past Questions</h1></div>
      <p class="muted" style="margin-bottom:16px;">Practice as many times as you like — these don't affect your CBT scores.</p>
      ${rows.map(({ course, sets }) => `
        <div style="margin-bottom:22px;">
          <div class="muted" style="font-weight:700; margin-bottom:8px;">${esc(course.code)} — ${esc(course.title)}</div>
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

  async function renderPracticeTake() {
    const { assessmentId, assessmentTitle, courseId, courseTitle, courseCode } = state.view;
    const { assessment } = await api(`/assessments/${assessmentId}`);
    const answers = {};
    view.innerHTML = `
      <div class="page-head"><h1>${esc(assessmentTitle || assessment.title)}</h1><button class="btn btn-ghost btn-sm" id="back-btn">← Back</button></div>
      <p class="muted" style="margin-bottom:16px;">${assessment.questions.length} questions · practice mode — instant feedback, unlimited retries</p>
      <div id="pq-questions">
        ${assessment.questions.map((q, qi) => `
          <div class="card quiz-q" data-question="${q.id}">
            <div style="font-weight:600; margin-bottom:6px;">${qi + 1}. ${esc(q.text)}</div>
            ${q.questionType === 'THEORY'
              ? `<textarea class="theory-answer" data-q="${q.id}" placeholder="Write your answer…" rows="4" style="width:100%;"></textarea>`
              : q.options.map((opt, oi) => `<div class="quiz-opt" data-q="${q.id}" data-opt="${oi}">${esc(opt)}</div>`).join('')}
            <p class="pq-feedback meta" style="margin-top:8px; display:none;"></p>
          </div>
        `).join('')}
      </div>
      <div style="display:flex; gap:10px;">
        <button class="btn btn-primary" id="pq-submit-btn">Check my answers</button>
        <button class="btn btn-ghost" id="pq-retry-btn" hidden>Try again</button>
      </div>
      <p id="pq-score" class="meta" style="margin-top:12px;"></p>
    `;
    document.getElementById('back-btn').addEventListener('click', () => navigate('past-questions-hub'));
    view.querySelectorAll('.quiz-opt').forEach((opt) => {
      opt.addEventListener('click', () => {
        const q = opt.dataset.q;
        view.querySelectorAll(`.quiz-opt[data-q="${q}"]`).forEach((o) => o.classList.remove('selected'));
        opt.classList.add('selected');
        answers[q] = { questionId: q, choice: Number(opt.dataset.opt) };
      });
    });
    view.querySelectorAll('.theory-answer').forEach((ta) => {
      ta.addEventListener('input', () => { answers[ta.dataset.q] = { questionId: ta.dataset.q, text: ta.value }; });
    });
    document.getElementById('pq-submit-btn').addEventListener('click', async () => {
      const payload = Object.values(answers);
      try {
        const { score, total, corrections } = await api(`/assessments/${assessmentId}/practice-submit`, { method: 'POST', body: { answers: payload } });
        corrections.forEach((c) => {
          const block = view.querySelector(`[data-question="${c.questionId}"]`);
          const fb = block.querySelector('.pq-feedback');
          fb.style.display = 'block';
          if (c.questionType === 'THEORY') {
            fb.textContent = `Model answer: ${c.modelAnswer || '(none provided)'}`;
            return;
          }
          block.querySelectorAll('.quiz-opt').forEach((opt) => {
            const oi = Number(opt.dataset.opt);
            opt.classList.toggle('correct', oi === c.correctIndex);
            opt.classList.toggle('wrong', oi === c.chosen && !c.correct);
          });
          fb.textContent = c.correct ? 'Correct' : 'Not quite — correct answer highlighted above.';
        });
        document.getElementById('pq-score').textContent = `Score: ${score} / ${total} (objective questions only)`;
        document.getElementById('pq-submit-btn').hidden = true;
        document.getElementById('pq-retry-btn').hidden = false;
      } catch (err) { toast(err.message); }
    });
    document.getElementById('pq-retry-btn').addEventListener('click', () => navigate('practice-take', { assessmentId, assessmentTitle, courseId, courseTitle, courseCode }));
  }

  // ================= DIGITAL LAB (curated + AI-generated, admin-approved) =================

  function demoCardHtml(d) {
    const steps = d.steps;
    return `<div class="card" style="padding:20px; margin-bottom:14px;" data-demo-card="${d.id}">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px;">
        <div>
          <div style="font-weight:600;">${esc(d.title)}</div>
          <div class="meta">${esc(d.description)}</div>
        </div>
        <span class="pill ${d.source === 'AI_GENERATED' ? 'pill-accent' : 'pill-pass'}">${d.source === 'AI_GENERATED' ? 'AI-generated' : 'Curated'}</span>
      </div>
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
          if (err.code === 'SUBSCRIPTION_REQUIRED') return renderUpgradePrompt(err.message);
          toast(err.message);
        }
      });
    });
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
      ${demonstrations.map(demoCardHtml).join('') || '<p class="muted">No practicals published yet.</p>'}
    `;
    document.getElementById('back-btn').addEventListener('click', () => navigate(isLecturer ? 'lect-lessons' : 'course-detail', { courseId }));
    wireLabQuestionPanels(view);

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
        if (err.code === 'SUBSCRIPTION_REQUIRED') return renderUpgradePrompt(err.message);
        toast(err.message);
        requestBtn.disabled = false;
        requestBtn.textContent = 'Generate practical';
      }
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
        <div id="research-answer" style="margin-top:18px; white-space:pre-wrap; line-height:1.7;"></div>
      </div>
    `;
    document.getElementById('research-ask-btn').addEventListener('click', async () => {
      const question = document.getElementById('research-input').value.trim();
      if (!question) return;
      const answerBox = document.getElementById('research-answer');
      answerBox.textContent = 'Thinking…';
      try {
        const { answer } = await api('/research-assistant/ask', { method: 'POST', body: { question } });
        answerBox.textContent = answer;
      } catch (err) {
        if (err.code === 'SUBSCRIPTION_REQUIRED') return renderUpgradePrompt(err.message);
        answerBox.innerHTML = `<span style="color:var(--danger);">${esc(err.message)}</span>`;
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
        </div>
      ` : `
        <div class="card" style="padding:20px; margin-bottom:20px;">
          <span class="pill pill-muted">No active plan</span>
          <p class="muted" style="margin-top:10px;">Subscribe to unlock AI Teacher lessons, recorded lectures and live classes. e-Library, study groups and CBT practice stay free either way.</p>
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

  async function renderLibrary(isLecturer) {
    const courses = isLecturer ? (await ensureLectCourses()).courses : (await api('/students/me/courses')).courses;
    const items = [];
    for (const c of courses) {
      const { items: courseItems } = await api(`/library?courseId=${c.id}`);
      items.push(...courseItems.map((it) => ({ ...it, courseCode: c.code })));
    }
    view.innerHTML = `
      <div class="page-head"><h1>e-Library</h1></div>
      ${isLecturer ? `
        <div class="card" style="padding:20px; margin-bottom:22px;">
          <h3 style="margin-bottom:12px; font-size:1rem;">Upload a resource</h3>
          <form id="upload-form">
            <div class="field"><label>Course</label>
              <select id="lib-course">${courses.map((c) => `<option value="${c.id}">${esc(c.code)} — ${esc(c.title)}</option>`).join('')}</select>
            </div>
            <div class="field"><label>Title</label><input type="text" id="lib-title" required></div>
            <div class="field"><label>Author</label><input type="text" id="lib-author" required></div>
            <div class="field"><label>Type</label>
              <select id="lib-type"><option>Textbook</option><option>Past Question</option><option>Handout</option><option>Journal</option></select>
            </div>
            <div class="field"><label>File (from your device)</label><input type="file" id="lib-file" required></div>
            <button class="btn btn-primary" type="submit" id="lib-submit-btn">Upload</button>
          </form>
        </div>` : ''}
      <div class="card">
        ${items.map((it) => `
          <div class="list-row">
            <div>
              <div style="font-weight:600;">${esc(it.title)}</div>
              <div class="meta">${esc(it.author)} · ${esc(it.courseCode)}</div>
            </div>
            <div style="display:flex; align-items:center; gap:10px;">
              <span class="pill pill-muted">${esc(it.type)}</span>
              <a class="btn btn-ghost btn-sm" href="${esc(it.fileUrl)}" target="_blank" rel="noopener">Open</a>
            </div>
          </div>
        `).join('') || '<p class="muted" style="padding:16px;">No resources yet.</p>'}
      </div>
    `;
    if (isLecturer) {
      document.getElementById('upload-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData();
        fd.append('courseId', document.getElementById('lib-course').value);
        fd.append('title', document.getElementById('lib-title').value);
        fd.append('author', document.getElementById('lib-author').value);
        fd.append('type', document.getElementById('lib-type').value);
        const file = document.getElementById('lib-file').files[0];
        if (!file) return toast('Attach a file from your device.');
        fd.append('file', file);

        const submitBtn = document.getElementById('lib-submit-btn');
        submitBtn.disabled = true;
        submitBtn.textContent = 'Uploading…';
        try {
          const { storage } = await api('/library', { method: 'POST', body: fd });
          toast('Resource uploaded');
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
  }

  async function renderGroups() {
    const { courses } = await api('/students/me/courses');
    const groupsByCourse = [];
    for (const c of courses) {
      const { groups } = await api(`/courses/${c.id}/groups`);
      groupsByCourse.push({ course: c, groups });
    }
    view.innerHTML = `
      <div class="page-head"><h1>Study Groups</h1></div>
      <p class="muted" style="margin-bottom:20px;">Peer discussion spaces for your courses — no scores, no leaderboard.</p>
      ${groupsByCourse.map(({ course, groups }) => `
        <div style="margin-bottom:22px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
            <div class="muted" style="font-weight:700;">${esc(course.code)} — ${esc(course.title)}</div>
            <button class="btn btn-ghost btn-sm" data-new-group="${course.id}">+ New group</button>
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
      `).join('') || '<p class="muted">Enroll in a course first to join its study group.</p>'}
    `;
    view.querySelectorAll('[data-new-group]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const name = prompt('Name your study group:');
        if (!name) return;
        await api(`/courses/${btn.dataset.newGroup}/groups`, { method: 'POST', body: { name } });
        render();
      });
    });
    view.querySelectorAll('[data-open-group]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await api(`/groups/${btn.dataset.openGroup}/join`, { method: 'POST' });
        navigate('group-chat', { groupId: btn.dataset.openGroup });
      });
    });
  }

  function groupMessageBubbleHtml(m) {
    const sender = `<div class="sender">${esc(m.sender.fullName)}</div>`;
    if (!m.fileUrl) return `<div class="chat-msg">${sender}${esc(m.body)}</div>`;
    const isImage = (m.fileMime || '').startsWith('image/');
    const isVideo = (m.fileMime || '').startsWith('video/');
    const preview = isImage
      ? `<img src="${esc(m.fileUrl)}" alt="${esc(m.fileName)}" style="max-width:220px; max-height:220px; border-radius:8px; display:block; margin-top:6px;">`
      : isVideo
        ? `<video src="${esc(m.fileUrl)}" controls style="max-width:220px; border-radius:8px; display:block; margin-top:6px;"></video>`
        : `<div style="margin-top:6px;">📎 ${esc(m.fileName)}</div>`;
    return `<div class="chat-msg">${sender}${preview}<a href="${esc(m.fileUrl)}" target="_blank" rel="noopener" style="font-size:0.78rem; text-decoration:underline; display:block; margin-top:4px;">⬇ Download</a></div>`;
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
          <input type="text" id="chat-input" placeholder="Message your study group…">
          <button class="btn btn-primary" type="submit">Send</button>
        </form>
      </div>
    `;
    document.getElementById('back-btn').addEventListener('click', () => navigate('groups'));
    const box = document.getElementById('chat-messages');
    box.scrollTop = box.scrollHeight;
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
  }

  // opts.typeFilter restricts to specific Assessment.type values (e.g. only
  // SEMESTER_EXAM for the Semester Exam pages); otherwise students see everything
  // except PAST_QUESTION and SEMESTER_EXAM (those have their own dedicated pages) and
  // lecturers see everything they've created.
  async function renderAssessments(isLecturer, opts = {}) {
    const { heading, typeFilter, defaultType } = opts;
    const courses = isLecturer ? (await ensureLectCourses()).courses : (await api('/students/me/courses')).courses;
    const rows = [];
    for (const c of courses) {
      const { assessments } = await api(`/courses/${c.id}/assessments`);
      rows.push({ course: c, assessments });
    }
    const defaultExclude = ['PAST_QUESTION', 'SEMESTER_EXAM'];
    view.innerHTML = `
      <div class="page-head"><h1>${esc(heading || (isLecturer ? 'Assessments' : 'CBT Mock Exam Practice'))}</h1></div>
      ${isLecturer ? `<button class="btn btn-accent btn-sm" id="new-assessment-btn" style="margin-bottom:18px;">+ New assessment</button>` : ''}
      ${rows.map(({ course, assessments: allAssessments }) => {
        const assessments = allAssessments.filter((a) => typeFilter ? typeFilter.includes(a.type) : (isLecturer || !defaultExclude.includes(a.type)));
        return `
        <div style="margin-bottom:22px;">
          <div class="muted" style="font-weight:700; margin-bottom:8px;">${esc(course.code)} — ${esc(course.title)}</div>
          <div class="card">
            ${assessments.map((a) => `
              <div class="list-row">
                <div>
                  <div style="font-weight:600;">${esc(a.title)}</div>
                  <div class="meta">${esc(a.type)} · ${a._count.questions} question${a._count.questions === 1 ? '' : 's'} · ${a.durationMin} min</div>
                </div>
                ${isLecturer
                  ? `<button class="btn btn-ghost btn-sm" data-results="${a.id}">View results</button>`
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
    if (isLecturer) {
      document.getElementById('new-assessment-btn').addEventListener('click', () => openNewAssessmentDialog(courses, { defaultType }));
    }
  }

  function renderLecturerSemesterExam() {
    return renderAssessments(true, { heading: 'Semester Exam', typeFilter: ['SEMESTER_EXAM'], defaultType: 'SEMESTER_EXAM' });
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
    // regardless of what the client's clock says).
    const { startedAt } = await api(`/assessments/${assessment.id}/start`, { method: 'POST' });
    const deadline = new Date(startedAt).getTime() + assessment.durationMin * 60000;

    const answers = {};
    view.innerHTML = `
      <div class="page-head">
        <h1>${esc(assessment.title)}</h1>
        <div style="display:flex; align-items:center; gap:12px;">
          <span class="pill pill-accent tabular" id="exam-timer">--:--</span>
          <button class="btn btn-ghost btn-sm" id="back-btn">← Back</button>
        </div>
      </div>
      <p class="muted" style="margin-bottom:16px;">${assessment.durationMin} minutes · ${assessment.questions.length} questions · auto-graded on submit</p>
      ${assessment.questions.map((q, qi) => `
        <div class="card quiz-q">
          <div style="font-weight:600; margin-bottom:6px;">${qi + 1}. ${esc(q.text)}</div>
          ${q.questionType === 'THEORY'
            ? `<textarea class="theory-answer" data-q="${q.id}" placeholder="Write your answer…" rows="4" style="width:100%;"></textarea>`
            : q.options.map((opt, oi) => `<div class="quiz-opt" data-q="${q.id}" data-opt="${oi}">${esc(opt)}</div>`).join('')}
        </div>
      `).join('')}
      <button class="btn btn-primary" id="submit-btn">Submit test</button>
    `;
    document.getElementById('back-btn').addEventListener('click', () => navigate(state.view.backTo || 'cbt-mock', { courseId: state.view.backCourseId }));
    view.querySelectorAll('.quiz-opt').forEach((opt) => {
      opt.addEventListener('click', () => {
        const q = opt.dataset.q;
        view.querySelectorAll(`.quiz-opt[data-q="${q}"]`).forEach((o) => o.classList.remove('selected'));
        opt.classList.add('selected');
        answers[q] = { questionId: q, choice: Number(opt.dataset.opt) };
      });
    });
    view.querySelectorAll('.theory-answer').forEach((ta) => {
      ta.addEventListener('input', () => { answers[ta.dataset.q] = { questionId: ta.dataset.q, text: ta.value }; });
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
    document.getElementById('submit-btn').addEventListener('click', () => doSubmit(false));

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
      <div style="display:flex; gap:12px; margin-bottom:22px; flex-wrap:wrap;">
        <button class="btn btn-ghost" id="open-attendance-btn">🗓️ Class attendance</button>
        <button class="btn btn-ghost" id="open-assignments-btn">📋 Assignments</button>
        <button class="btn btn-ghost" id="open-results-btn">📊 Student results</button>
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
    document.getElementById('open-attendance-btn').addEventListener('click', () => navigate('lect-attendance', { courseId: course.id, courseTitle: course.title, courseCode: course.code }));
    document.getElementById('open-assignments-btn').addEventListener('click', () => navigate('lect-assignments', { courseId: course.id, courseTitle: course.title, courseCode: course.code }));
    document.getElementById('open-results-btn').addEventListener('click', () => navigate('lect-results', { courseId: course.id, courseTitle: course.title, courseCode: course.code }));
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

  async function renderLecturerAttendance() {
    const { courseId, courseTitle, courseCode } = state.view;
    const todayIso = new Date().toISOString().slice(0, 10);
    const dateStr = state.view.date || todayIso;
    const { roster } = await api(`/courses/${courseId}/attendance?date=${dateStr}`);
    view.innerHTML = `
      <div class="page-head">
        <div><div class="muted tabular">${esc(courseCode || '')}</div><h1>Class attendance — ${esc(courseTitle || '')}</h1></div>
        <button class="btn btn-ghost btn-sm" id="back-btn">← Back to course</button>
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
    document.getElementById('back-btn').addEventListener('click', () => navigate('lect-lessons', { courseId }));
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

  async function renderLecturerAssignments() {
    const { courseId, courseTitle, courseCode } = state.view;
    const { assignments } = await api(`/courses/${courseId}/assignments`);
    view.innerHTML = `
      <div class="page-head">
        <div><div class="muted tabular">${esc(courseCode || '')}</div><h1>Assignments — ${esc(courseTitle || '')}</h1></div>
        <button class="btn btn-ghost btn-sm" id="back-btn">← Back to course</button>
      </div>
      <div class="card" style="padding:20px; margin-bottom:22px;">
        <h3 style="margin-bottom:12px; font-size:1rem;">Post a new assignment</h3>
        <form id="assignment-form">
          <div class="field"><label>Kind</label><select id="asg-kind"><option value="ASSIGNMENT">Assignment</option><option value="PROJECT">Project</option></select></div>
          <div class="field"><label>Title</label><input type="text" id="asg-title" required></div>
          <div class="field"><label>Instructions</label><textarea id="asg-instructions" required></textarea></div>
          <div class="field"><label>Due date (optional)</label><input type="date" id="asg-due"></div>
          <button class="btn btn-primary" type="submit">Post assignment</button>
        </form>
      </div>
      <div class="card">
        ${assignments.map((a) => `
          <div class="list-row" data-open="${a.id}" style="cursor:pointer;">
            <div><div style="font-weight:600;">${esc(a.title)} ${a.kind === 'PROJECT' ? '<span class="pill pill-muted" style="margin-left:6px;">Project</span>' : ''}</div><div class="meta">${a._count.submissions} submission${a._count.submissions === 1 ? '' : 's'}${a.dueAt ? ' · due ' + new Date(a.dueAt).toLocaleDateString() : ''}</div></div>
            <span class="pill pill-accent">View submissions</span>
          </div>
        `).join('') || '<p class="muted" style="padding:16px;">No assignments posted yet.</p>'}
      </div>
    `;
    document.getElementById('back-btn').addEventListener('click', () => navigate('lect-lessons', { courseId }));
    document.getElementById('assignment-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = document.getElementById('asg-title').value.trim();
      const instructions = document.getElementById('asg-instructions').value.trim();
      const dueAt = document.getElementById('asg-due').value || null;
      const kind = document.getElementById('asg-kind').value;
      try {
        await api(`/courses/${courseId}/assignments`, { method: 'POST', body: { title, instructions, dueAt, kind } });
        toast(kind === 'PROJECT' ? 'Project posted' : 'Assignment posted');
        navigate('lect-assignments', { courseId, courseTitle, courseCode });
      } catch (err) { toast(err.message); }
    });
    view.querySelectorAll('[data-open]').forEach((el) => {
      const a = assignments.find((x) => x.id === el.dataset.open);
      el.addEventListener('click', () => navigate('lect-assignment-submissions', { assignmentId: a.id, assignmentTitle: a.title, courseId, courseTitle, courseCode }));
    });
  }

  async function renderAssignmentSubmissions() {
    const { assignmentId, assignmentTitle, courseId, courseTitle, courseCode } = state.view;
    const { submissions } = await api(`/assignments/${assignmentId}/submissions`);
    view.innerHTML = `
      <div class="page-head">
        <h1>${esc(assignmentTitle || 'Submissions')}</h1>
        <button class="btn btn-ghost btn-sm" id="back-btn">← Back to assignments</button>
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
    document.getElementById('back-btn').addEventListener('click', () => navigate('lect-assignments', { courseId, courseTitle, courseCode }));
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

  async function renderLecturerResults() {
    const { courseId, courseTitle, courseCode } = state.view;
    const [{ results }, { count }] = await Promise.all([
      api(`/courses/${courseId}/results`),
      api(`/courses/${courseId}/enrollment-count`),
    ]);
    const { roster } = await api(`/courses/${courseId}/attendance`);
    view.innerHTML = `
      <div class="page-head">
        <div><div class="muted tabular">${esc(courseCode || '')}</div><h1>Student results — ${esc(courseTitle || '')}</h1></div>
        <button class="btn btn-ghost btn-sm" id="back-btn">← Back to course</button>
      </div>
      <p class="muted" style="margin-bottom:18px;">${count} student${count === 1 ? '' : 's'} enrolled</p>
      <div class="card" style="padding:20px; margin-bottom:22px;">
        <h3 style="margin-bottom:12px; font-size:1rem;">Publish a result</h3>
        <form id="result-form">
          <div class="field"><label>Student</label><select id="res-student">${roster.map((r) => `<option value="${r.student.id}">${esc(r.student.fullName)} (${esc(r.student.matricNumber || '—')})</option>`).join('')}</select></div>
          <div class="field"><label>Term</label><input type="text" id="res-term" placeholder="e.g. First Semester 2025/2026" required></div>
          <div class="field"><label>Score</label><input type="number" id="res-score" required></div>
          <div class="field"><label>Grade (optional)</label><input type="text" id="res-grade" placeholder="e.g. A"></div>
          <div class="field"><label>Remark (optional)</label><input type="text" id="res-remark"></div>
          <button class="btn btn-primary" type="submit">Publish result</button>
        </form>
      </div>
      <div class="card" style="overflow-x:auto;">
        <table class="data-table">
          <thead><tr><th>Student</th><th>Term</th><th>Score</th><th>Grade</th><th>Published</th></tr></thead>
          <tbody>
            ${results.map((r) => `<tr><td>${esc(r.student.fullName)}</td><td>${esc(r.term)}</td><td class="tabular">${r.score}</td><td>${esc(r.grade || '—')}</td><td class="tabular">${new Date(r.publishedAt).toLocaleDateString()}</td></tr>`).join('') || '<tr><td colspan="5" class="muted" style="padding:16px;">No results published yet.</td></tr>'}
          </tbody>
        </table>
      </div>
    `;
    document.getElementById('back-btn').addEventListener('click', () => navigate('lect-lessons', { courseId }));
    document.getElementById('result-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api(`/courses/${courseId}/results`, {
          method: 'POST',
          body: {
            studentId: document.getElementById('res-student').value,
            term: document.getElementById('res-term').value.trim(),
            score: document.getElementById('res-score').value,
            grade: document.getElementById('res-grade').value.trim() || null,
            remark: document.getElementById('res-remark').value.trim() || null,
          },
        });
        toast('Result published');
        navigate('lect-results', { courseId, courseTitle, courseCode });
      } catch (err) { toast(err.message); }
    });
  }

  function openNewAssessmentDialog(courses, opts = {}) {
    const container = document.createElement('div');
    container.className = 'card';
    container.style.cssText = 'position:fixed; inset:0; margin:auto; width:min(560px,92vw); height:fit-content; max-height:86vh; overflow-y:auto; padding:24px; z-index:200;';
    let qCount = 1;
    function questionBlock(i) {
      return `<div class="field" data-question-block="${i}">
        <label>Question ${i + 1}</label>
        <select class="q-type" style="margin-bottom:6px;">
          <option value="OBJECTIVE">Objective (multiple choice)</option>
          <option value="THEORY">Theory (free response)</option>
        </select>
        <input type="text" class="q-text" placeholder="Question text" required>
        <div class="q-objective-fields">
          <input type="text" class="q-opt" placeholder="Option A" style="margin-top:6px;">
          <input type="text" class="q-opt" placeholder="Option B" style="margin-top:6px;">
          <input type="text" class="q-opt" placeholder="Option C" style="margin-top:6px;">
          <input type="text" class="q-opt" placeholder="Option D" style="margin-top:6px;">
          <select class="q-correct" style="margin-top:6px;">
            <option value="0">Correct: Option A</option><option value="1">Correct: Option B</option>
            <option value="2">Correct: Option C</option><option value="3">Correct: Option D</option>
          </select>
        </div>
        <textarea class="q-model-answer" placeholder="Model answer (shown to the student to self-review against)" style="margin-top:6px; width:100%;" hidden rows="2"></textarea>
      </div>`;
    }
    function wireQuestionTypeToggle(block) {
      const typeSelect = block.querySelector('.q-type');
      const objectiveFields = block.querySelector('.q-objective-fields');
      const modelAnswer = block.querySelector('.q-model-answer');
      typeSelect.addEventListener('change', () => {
        const isTheory = typeSelect.value === 'THEORY';
        objectiveFields.hidden = isTheory;
        modelAnswer.hidden = !isTheory;
      });
    }
    container.innerHTML = `
      <h3 style="margin-bottom:14px;">New assessment</h3>
      <div class="field"><label>Course</label><select id="na-course">${courses.map((c) => `<option value="${c.id}">${esc(c.code)}</option>`).join('')}</select></div>
      <div class="field"><label>Title</label><input type="text" id="na-title" required></div>
      <div class="field"><label>Type</label><select id="na-type">
        <option value="CA" ${opts.defaultType === 'CA' ? 'selected' : ''}>CA</option>
        <option value="Test" ${opts.defaultType === 'Test' ? 'selected' : ''}>Test</option>
        <option value="Mock" ${opts.defaultType === 'Mock' ? 'selected' : ''}>Mock</option>
        <option value="Assignment" ${opts.defaultType === 'Assignment' ? 'selected' : ''}>Assignment</option>
        <option value="SEMESTER_EXAM" ${opts.defaultType === 'SEMESTER_EXAM' ? 'selected' : ''}>Semester Exam</option>
        <option value="PAST_QUESTION" ${opts.defaultType === 'PAST_QUESTION' ? 'selected' : ''}>Past Question (practice)</option>
      </select></div>
      <p class="meta" id="na-cap-note" style="margin-bottom:10px;"></p>
      <div class="field"><label>Duration (minutes)</label><input type="number" id="na-duration" value="20"></div>
      <div id="na-questions">${questionBlock(0)}</div>
      <button type="button" class="btn btn-ghost btn-sm" id="na-add-q" style="margin-bottom:14px;">+ Add question</button>
      <div style="display:flex; gap:10px;">
        <button class="btn btn-primary" id="na-save">Publish assessment</button>
        <button class="btn btn-ghost" id="na-cancel">Cancel</button>
      </div>
    `;
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
    wireQuestionTypeToggle(container.querySelector('[data-question-block="0"]'));

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
    container.querySelector('#na-save').addEventListener('click', async () => {
      const blocks = container.querySelectorAll('[data-question-block]');
      const questions = Array.from(blocks).map((b) => {
        const questionType = b.querySelector('.q-type').value;
        const text = b.querySelector('.q-text').value;
        if (questionType === 'THEORY') {
          return { questionType, text, modelAnswer: b.querySelector('.q-model-answer').value };
        }
        return {
          questionType,
          text,
          options: Array.from(b.querySelectorAll('.q-opt')).map((i) => i.value).filter(Boolean),
          correctIndex: Number(b.querySelector('.q-correct').value),
        };
      }).filter((q) => q.text && (q.questionType === 'THEORY' || q.options.length >= 2));
      if (!questions.length) { toast('Add at least one complete question'); return; }
      try {
        await api(`/courses/${container.querySelector('#na-course').value}/assessments`, {
          method: 'POST',
          body: {
            title: container.querySelector('#na-title').value,
            type: container.querySelector('#na-type').value,
            durationMin: Number(container.querySelector('#na-duration').value) || 20,
            questions,
          },
        });
        toast('Assessment published');
        close();
        render();
      } catch (err) { toast(err.message); }
    });
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
    document.getElementById('back-btn').addEventListener('click', () => navigate(state.view.backTo || 'lect-assessments'));
  }

  // Read-only, school-wide view of every semester exam set by any lecturer -- admin
  // can drill into results but not create/edit (that's the lecturer's job).
  async function renderAdminSemesterExam() {
    const { departments } = await api(`/departments?schoolId=${state.user.schoolId}`);
    const rows = [];
    for (const d of departments) {
      const { courses } = await api(`/departments/${d.id}/courses`);
      for (const c of courses) {
        const { assessments } = await api(`/courses/${c.id}/assessments`);
        const exams = assessments.filter((a) => a.type === 'SEMESTER_EXAM');
        if (exams.length) rows.push({ course: c, exams });
      }
    }
    view.innerHTML = `
      <div class="page-head"><h1>Semester Exam</h1></div>
      <p class="muted" style="margin-bottom:18px;">Read-only view of every semester exam set by lecturers across the school.</p>
      ${rows.map(({ course, exams }) => `
        <div style="margin-bottom:22px;">
          <div class="muted" style="font-weight:700; margin-bottom:8px;">${esc(course.code)} — ${esc(course.title)}</div>
          <div class="card">
            ${exams.map((a) => `
              <div class="list-row">
                <div><div style="font-weight:600;">${esc(a.title)}</div><div class="meta">${a._count.questions} question${a._count.questions === 1 ? '' : 's'} · ${a.durationMin} min</div></div>
                <button class="btn btn-ghost btn-sm" data-results="${a.id}">View results</button>
              </div>
            `).join('')}
          </div>
        </div>
      `).join('') || '<p class="muted">No semester exams set yet.</p>'}
    `;
    view.querySelectorAll('[data-results]').forEach((btn) => {
      btn.addEventListener('click', () => navigate('lect-assessment-results', { assessmentId: btn.dataset.results, backTo: 'admin-semester-exam' }));
    });
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
      actions: [
        { key: 'suspend', label: 'Suspend', show: (u) => u.status === 'ACTIVE' },
        { key: 'lift-suspension', label: 'Lift suspension', show: (u) => u.status === 'SUSPENDED' },
        { key: 'dismiss', label: 'Dismiss', show: (u) => u.status !== 'DISMISSED' },
      ],
      addFields: [
        { key: 'fullName', label: 'Full name', required: true },
        { key: 'staffId', label: 'Staff ID' },
        { key: 'departmentId', label: 'Department', type: 'department', required: true },
        { key: 'email', label: 'Email', type: 'email', required: true },
        { key: 'phone', label: 'Phone number', type: 'tel' },
      ],
    },
    NON_ACADEMIC: {
      label: 'Non-Academic Staff', base: '/admin/non-academic-staff', listKey: 'staff', detailKey: 'staff',
      idLabel: 'Staff ID', idField: 'staffId', extraLabel: 'Position',
      extraValue: (u) => u.position || '—',
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
    },
    STUDENT: {
      label: 'Students', base: '/admin/students', listKey: 'students', detailKey: 'student',
      idLabel: 'Matric No.', idField: 'matricNumber', extraLabel: 'Course(s)',
      extraValue: (u) => (u.courses || []).map((c) => c.code).join(', ') || '—',
      actions: [
        { key: 'suspend', label: 'Suspend', show: (u) => u.status === 'ACTIVE' },
        { key: 'lift-suspension', label: 'Lift suspension', show: (u) => u.status === 'SUSPENDED' },
        { key: 'expel', label: 'Expel', show: (u) => u.status !== 'EXPELLED' },
      ],
      addFields: [
        { key: 'fullName', label: 'Full name', required: true },
        { key: 'matricNumber', label: 'Matric number', required: true },
        { key: 'departmentId', label: 'Department', type: 'department', required: true },
        { key: 'email', label: 'Email', type: 'email', required: true },
        { key: 'phone', label: 'Phone number', type: 'tel' },
      ],
    },
  };

  async function departmentOptionsHtml(selectedId) {
    const { departments } = await api(`/departments?schoolId=${state.user.schoolId}`);
    return departments.map((d) => `<option value="${d.id}" ${d.id === selectedId ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
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
    view.innerHTML = `
      <div class="page-head">
        <h1>${cfg.label}</h1>
        <div style="display:flex; gap:10px;">
          <button class="btn btn-accent btn-sm" id="add-btn">+ Add</button>
          <button class="btn btn-ghost btn-sm" id="back-btn">← Back</button>
        </div>
      </div>
      <div id="add-box" hidden></div>
      <div class="card" style="overflow-x:auto;">
        <table class="data-table">
          <thead><tr><th>Name</th><th>${cfg.idLabel}</th><th>Department</th><th>${cfg.extraLabel}</th><th>Status</th></tr></thead>
          <tbody>${items.map((u) => `<tr class="clickable" data-id="${u.id}" style="cursor:pointer;">
            <td>${esc(u.fullName)}</td><td class="tabular">${esc(u[cfg.idField] || '—')}</td><td>${esc(u.department ? u.department.name : '—')}</td><td>${esc(cfg.extraValue(u))}</td>
            <td>${statusPillHtml(u.status)}</td>
          </tr>`).join('') || `<tr><td colspan="5" class="muted" style="padding:16px;">None yet.</td></tr>`}</tbody>
        </table>
      </div>
    `;
    document.getElementById('back-btn').addEventListener('click', () => navigate('admin-directory'));
    view.querySelectorAll('tr[data-id]').forEach((row) => {
      row.addEventListener('click', () => navigate('admin-directory-detail', { directoryType: state.view.directoryType, userId: row.dataset.id }));
    });
    document.getElementById('add-btn').addEventListener('click', async () => {
      const box = document.getElementById('add-box');
      box.hidden = !box.hidden;
      if (box.hidden) return;
      const fieldsHtml = await Promise.all(cfg.addFields.map(async (f) => {
        if (f.type === 'department') {
          return `<div class="field"><label>${f.label}</label><select id="add-${f.key}" ${f.required ? 'required' : ''}><option value="">${f.required ? 'Select…' : 'None'}</option>${await departmentOptionsHtml()}</select></div>`;
        }
        return `<div class="field"><label>${f.label}</label><input type="${f.type || 'text'}" id="add-${f.key}" ${f.required ? 'required' : ''}></div>`;
      }));
      box.innerHTML = `<form id="add-form" class="card" style="padding:20px; margin-bottom:18px;">${fieldsHtml.join('')}<button class="btn btn-primary" type="submit">Add & generate access code</button></form>`;
      box.hidden = false;
      document.getElementById('add-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = {};
        for (const f of cfg.addFields) body[f.key] = document.getElementById(`add-${f.key}`).value.trim();
        try {
          const { user, accessCode, tempPassword } = await api(cfg.base, { method: 'POST', body });
          alert(`${user.fullName} added.\n\nAccess code: ${accessCode}\nTemporary password: ${tempPassword}\n\nShare these with them to log in.`);
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
          <div><div class="meta">${cfg.extraLabel}</div><div>${esc(cfg.extraValue(u))}</div></div>
          <div><div class="meta">Status</div><div>${statusPillHtml(u.status)}</div></div>
          <div><div class="meta">Email</div><div>${esc(u.email)}</div></div>
          <div><div class="meta">Phone</div><div>${esc(u.phone || '—')}</div></div>
          <div><div class="meta">Access code</div><div class="tabular">${esc(u.accessCode || '—')}</div></div>
        </div>
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:16px;">
          ${cfg.actions.filter((a) => a.show(u)).map((a) => `<button class="btn btn-ghost btn-sm" data-action="${a.key}">${a.label}</button>`).join('')}
          ${state.view.directoryType === 'STUDENT' ? `<button class="btn btn-ghost btn-sm" id="issue-credential-btn">Issue credential</button>` : ''}
        </div>
      </div>
    `;
    document.getElementById('back-btn').addEventListener('click', () => navigate('admin-directory-list', { directoryType: state.view.directoryType }));
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
  }

  async function renderAdminAcademics() {
    const [{ departments }, { school }] = await Promise.all([api(`/departments?schoolId=${state.user.schoolId}`), api('/admin/school')]);
    const deptCourses = {};
    for (const d of departments) deptCourses[d.id] = (await api(`/departments/${d.id}/courses`)).courses;
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
          <div class="muted" style="font-weight:700; margin-bottom:8px;">${esc(d.name)} (${esc(d.code)})</div>
          <div class="card">
            ${deptCourses[d.id].map((c) => `<div class="list-row"><div>${esc(c.code)} — ${esc(c.title)}</div><span class="pill pill-muted">${esc(c.level)}</span></div>`).join('') || '<p class="muted" style="padding:16px;">No courses yet.</p>'}
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

  async function renderAdminActivity() {
    const { logs } = await api('/admin/lecturer-activity');
    view.innerHTML = `
      <div class="page-head"><h1>Lecturer Activity</h1></div>
      <p class="muted" style="margin-bottom:18px;">Logins, lessons published, resources uploaded, and assignments/tests/exams/projects created — by design, student activity is never tracked here.</p>
      <div class="card" style="overflow-x:auto;">
        <table class="data-table">
          <thead><tr><th>Lecturer</th><th>Action</th><th>Detail</th><th>When</th></tr></thead>
          <tbody>${logs.map((l) => `<tr><td>${esc(l.user.fullName)}</td><td>${esc(ACTIVITY_ACTION_LABELS[l.action] || l.action)}</td><td>${esc(l.detail || '—')}</td><td class="tabular">${new Date(l.createdAt).toLocaleString()}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No activity yet.</td></tr>'}</tbody>
        </table>
      </div>
    `;
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
      <div class="page-head"><h1>Admissions</h1><button class="btn btn-ghost btn-sm" id="manage-attitude-test-btn">Manage attitude test</button></div>
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
    document.getElementById('manage-attitude-test-btn').addEventListener('click', () => navigate('admin-attitude-test'));
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

  async function renderAdminAdmissionDetail() {
    const { application: a } = await api(`/admin/admissions/${state.view.applicationId}`);
    const sub = a.attitudeTestSubmission;
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
          <div><div class="meta">Attitude test</div><div>${sub ? `${sub.score} / ${sub.total}` : 'Not taken yet'}</div></div>
        </div>
        ${a.statement ? `<p class="muted" style="margin-top:14px;">${esc(a.statement)}</p>` : ''}
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:18px;">
          ${a.status === 'SUBMITTED' ? `<button class="btn btn-ghost btn-sm" data-screen>Screen</button>` : ''}
          ${['SUBMITTED', 'UNDER_REVIEW'].includes(a.status) ? `<button class="btn btn-primary btn-sm" data-accept>Accept</button><button class="btn btn-ghost btn-sm" data-reject>Reject</button>` : ''}
          ${a.status === 'ACCEPTED' ? `<button class="btn btn-accent btn-sm" data-register>Register as student</button>` : ''}
        </div>
      </div>
    `;
    document.getElementById('back-btn').addEventListener('click', () => navigate('admin-admissions'));
    const screenBtn = view.querySelector('[data-screen]');
    if (screenBtn) screenBtn.addEventListener('click', async () => { await api(`/admin/admissions/${a.id}/screen`, { method: 'POST' }); toast('Marked under review'); render(); });
    const acceptBtn = view.querySelector('[data-accept]');
    if (acceptBtn) acceptBtn.addEventListener('click', async () => { await api(`/admin/admissions/${a.id}/accept`, { method: 'POST' }); toast('Accepted'); render(); });
    const rejectBtn = view.querySelector('[data-reject]');
    if (rejectBtn) rejectBtn.addEventListener('click', async () => { await api(`/admin/admissions/${a.id}/reject`, { method: 'POST' }); toast('Rejected'); render(); });
    const registerBtn = view.querySelector('[data-register]');
    if (registerBtn) registerBtn.addEventListener('click', async () => {
      try {
        const { user, tempPassword } = await api(`/admin/admissions/${a.id}/register`, { method: 'POST' });
        alert(`Student account created.\n\nName: ${user.fullName}\nMatric number: ${user.matricNumber}\nEmail: ${user.email}\nTemporary password: ${tempPassword}\n\nShare these with the student now — this password won't be shown again.`);
        render();
      } catch (err) { toast(err.message); }
    });
  }

  async function renderAdminAttitudeTest() {
    const { test } = await api('/admin/attitude-test');
    view.innerHTML = `
      <div class="page-head"><h1>Admission Attitude Test</h1><button class="btn btn-ghost btn-sm" id="back-btn">← Back</button></div>
      ${test ? `<p class="meta" style="margin-bottom:14px;">Current test: "${esc(test.title)}" (${test.questions.length} questions). Saving below replaces it with a new version for future applicants — past scores stay as they were.</p>` : '<p class="meta" style="margin-bottom:14px;">No attitude test configured yet — applicants won\'t see one to take until you add questions below.</p>'}
      <form id="attitude-form" class="card" style="padding:20px;">
        <div class="field"><label>Test title</label><input type="text" id="at-title" value="${test ? esc(test.title) : 'General Attitude Test'}" required></div>
        <div id="at-questions">
          ${(test ? test.questions : [{ text: '', options: ['', '', '', ''], correctIndex: 0 }]).map((q, qi) => questionEditorHtml(qi, q)).join('')}
        </div>
        <button type="button" class="btn btn-ghost btn-sm" id="at-add-q" style="margin:10px 0;">+ Add question</button>
        <button class="btn btn-primary" type="submit" style="display:block;">Save test</button>
      </form>
    `;
    document.getElementById('back-btn').addEventListener('click', () => navigate('admin-admissions'));
    wireQuestionEditor('at-questions', 'at-add-q');
    document.getElementById('attitude-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const questions = readQuestionEditor('at-questions');
      if (!questions.length) return toast('Add at least one question.');
      try {
        await api('/admin/attitude-test', { method: 'POST', body: { title: document.getElementById('at-title').value.trim(), questions } });
        toast('Attitude test saved');
        navigate('admin-admissions');
      } catch (err) { toast(err.message); }
    });
  }

  // Shared MCQ-question editor, reused by the attitude test and (Phase 4) CBT/exam
  // authoring screens.
  function questionEditorHtml(qi, q) {
    return `
      <div class="card quiz-q" data-q-idx="${qi}">
        <div class="field"><label>Question ${qi + 1}</label><input type="text" class="q-text" value="${esc(q.text || '')}" required></div>
        ${[0, 1, 2, 3].map((oi) => `
          <div class="field" style="display:flex; align-items:center; gap:8px;">
            <input type="radio" name="q-correct-${qi}" class="q-correct" value="${oi}" ${(q.correctIndex ?? 0) === oi ? 'checked' : ''}>
            <input type="text" class="q-opt" placeholder="Option ${oi + 1}" value="${esc((q.options && q.options[oi]) || '')}" required style="flex:1;">
          </div>
        `).join('')}
        <button type="button" class="btn btn-ghost btn-sm" data-remove-q>Remove question</button>
      </div>
    `;
  }
  function wireQuestionEditor(containerId, addBtnId) {
    const container = document.getElementById(containerId);
    container.addEventListener('click', (e) => {
      if (e.target.matches('[data-remove-q]')) e.target.closest('.quiz-q').remove();
    });
    document.getElementById(addBtnId).addEventListener('click', () => {
      const idx = container.querySelectorAll('.quiz-q').length;
      container.insertAdjacentHTML('beforeend', questionEditorHtml(idx, { text: '', options: ['', '', '', ''], correctIndex: 0 }));
    });
  }
  function readQuestionEditor(containerId) {
    return Array.from(document.getElementById(containerId).querySelectorAll('.quiz-q')).map((row) => ({
      text: row.querySelector('.q-text').value.trim(),
      options: Array.from(row.querySelectorAll('.q-opt')).map((i) => i.value.trim()),
      correctIndex: Number(row.querySelector('.q-correct:checked')?.value || 0),
    })).filter((q) => q.text);
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
      <div class="page-head"><h1>${esc(state.view.hostelName)}</h1><button class="btn btn-ghost btn-sm" id="back-btn">← Back</button></div>
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
  }

  async function renderAdminStudentActivity() {
    const { submissions, assignmentSubmissions, results, attendance } = await api('/admin/student-activity');
    view.innerHTML = `
      <div class="page-head"><h1>Student Activity</h1></div>
      <h3 style="margin-bottom:10px; font-size:1rem;">Tests &amp; exams</h3>
      <div class="card" style="overflow-x:auto; margin-bottom:26px;">
        <table class="data-table">
          <thead><tr><th>Student</th><th>Course</th><th>Assessment</th><th>Type</th><th>Score</th><th>Date</th></tr></thead>
          <tbody>${submissions.map((s) => `<tr><td>${esc(s.student.fullName)}</td><td class="tabular">${esc(s.assessment.course.code)}</td><td>${esc(s.assessment.title)}</td><td>${esc(s.assessment.type)}</td><td class="tabular">${s.score}/${s.total}</td><td class="tabular">${new Date(s.submittedAt).toLocaleDateString()}</td></tr>`).join('') || '<tr><td colspan="6" class="muted" style="padding:16px;">None yet.</td></tr>'}</tbody>
        </table>
      </div>
      <h3 style="margin-bottom:10px; font-size:1rem;">Assignments</h3>
      <div class="card" style="overflow-x:auto; margin-bottom:26px;">
        <table class="data-table">
          <thead><tr><th>Student</th><th>Course</th><th>Assignment</th><th>Score</th><th>Submitted</th></tr></thead>
          <tbody>${assignmentSubmissions.map((s) => `<tr><td>${esc(s.student.fullName)}</td><td class="tabular">${esc(s.assignment.course.code)}</td><td>${esc(s.assignment.title)}</td><td class="tabular">${s.score == null ? 'Unmarked' : s.score}</td><td class="tabular">${new Date(s.submittedAt).toLocaleDateString()}</td></tr>`).join('') || '<tr><td colspan="5" class="muted" style="padding:16px;">None yet.</td></tr>'}</tbody>
        </table>
      </div>
      <h3 style="margin-bottom:10px; font-size:1rem;">Formal results</h3>
      <div class="card" style="overflow-x:auto;">
        <table class="data-table">
          <thead><tr><th>Student</th><th>Course</th><th>Term</th><th>Score</th><th>Grade</th><th>Published</th></tr></thead>
          <tbody>${results.map((r) => `<tr><td>${esc(r.student.fullName)}</td><td class="tabular">${esc(r.course.code)}</td><td>${esc(r.term)}</td><td class="tabular">${r.score}</td><td>${esc(r.grade || '—')}</td><td class="tabular">${new Date(r.publishedAt).toLocaleDateString()}</td></tr>`).join('') || '<tr><td colspan="6" class="muted" style="padding:16px;">None yet.</td></tr>'}</tbody>
        </table>
      </div>
      <h3 style="margin-bottom:10px; font-size:1rem; margin-top:26px;">Classes attended</h3>
      <div class="card" style="overflow-x:auto;">
        <table class="data-table">
          <thead><tr><th>Student</th><th>Course</th><th>Date</th><th>Status</th></tr></thead>
          <tbody>${attendance.map((a) => `<tr><td>${esc(a.student.fullName)}</td><td class="tabular">${esc(a.course.code)}</td><td class="tabular">${new Date(a.date).toLocaleDateString()}</td><td>${esc(a.status)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted" style="padding:16px;">None yet.</td></tr>'}</tbody>
        </table>
      </div>
    `;
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
  } else if (location.hash.includes('register')) {
    document.querySelector('[data-audience="individual"]').click();
    document.querySelector('#individual-panel [data-tab="register"]').click();
  }
})();
