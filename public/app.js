(function () {
  'use strict';

  const state = {
    token: localStorage.getItem('vp_token') || null,
    user: JSON.parse(localStorage.getItem('vp_user') || 'null'),
    schoolId: null,
    view: { screen: 'home', courseId: null, groupId: null, assessmentId: null },
  };

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
    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    return data;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3200);
  }

  // ---------- Auth screen ----------
  const authScreen = document.getElementById('auth-screen');
  const appScreen = document.getElementById('app-screen');
  const authError = document.getElementById('auth-error');

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const isLogin = btn.dataset.tab === 'login';
      document.getElementById('login-form').style.display = isLogin ? 'block' : 'none';
      document.getElementById('register-form').style.display = isLogin ? 'none' : 'block';
      authError.innerHTML = '';
    });
  });

  async function loadDepartmentsIntoRegisterForm() {
    try {
      const { schools } = await api('/schools');
      const school = schools[0];
      state.schoolId = school ? school.id : null;
      if (!school) return;
      const { departments } = await api('/departments?schoolId=' + school.id);
      const sel = document.getElementById('reg-department');
      sel.innerHTML = departments.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
    } catch (e) {
      // landing content still works without this
    }
  }
  loadDepartmentsIntoRegisterForm();

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
      const { token, user } = await api('/auth/register-student', {
        method: 'POST',
        body: {
          fullName: document.getElementById('reg-name').value.trim(),
          email: document.getElementById('reg-email').value.trim(),
          password: document.getElementById('reg-password').value,
          matricNumber: document.getElementById('reg-matric').value.trim() || null,
          departmentId: document.getElementById('reg-department').value,
          schoolId: state.schoolId,
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
    state.token = null;
    state.user = null;
    window.speechSynthesis && window.speechSynthesis.cancel();
    appScreen.classList.remove('active');
    authScreen.style.display = 'flex';
  });

  function onAuthed(token, user) {
    state.token = token;
    state.user = user;
    localStorage.setItem('vp_token', token);
    localStorage.setItem('vp_user', JSON.stringify(user));
    authScreen.style.display = 'none';
    appScreen.classList.add('active');
    buildSidebar();
    navigate(defaultScreenFor(user.role));
  }

  function defaultScreenFor(role) {
    if (role === 'STUDENT') return 'courses';
    if (role === 'LECTURER') return 'lect-courses';
    return 'admin-directory';
  }

  // ---------- Sidebar ----------
  const NAV = {
    STUDENT: [
      ['courses', 'My Courses'],
      ['library', 'e-Library'],
      ['groups', 'Study Groups'],
      ['assessments', 'CBT & Tests'],
    ],
    LECTURER: [
      ['lect-courses', 'My Courses'],
      ['lect-library', 'e-Library'],
      ['lect-assessments', 'Assessments'],
    ],
    ADMIN: [
      ['admin-directory', 'Staff & Student Directory'],
      ['admin-academics', 'Departments & Courses'],
      ['admin-activity', 'Lecturer Activity'],
    ],
  };

  function buildSidebar() {
    document.getElementById('who-box').textContent = `${state.user.fullName} · ${state.user.role.charAt(0) + state.user.role.slice(1).toLowerCase()}`;
    const nav = document.getElementById('nav-items');
    nav.innerHTML = NAV[state.user.role]
      .map(([key, label]) => `<button class="nav-item" data-screen="${key}">${esc(label)}</button>`)
      .join('');
    nav.querySelectorAll('.nav-item').forEach((btn) => {
      btn.addEventListener('click', () => navigate(btn.dataset.screen));
    });
  }

  function markActiveNav(screen) {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.screen === screen));
  }

  const view = document.getElementById('view');

  function navigate(screen, params = {}) {
    window.speechSynthesis && window.speechSynthesis.cancel();
    state.view = Object.assign({ screen }, params);
    markActiveNav(screen);
    render();
  }

  async function render() {
    view.innerHTML = '<p class="muted">Loading…</p>';
    try {
      switch (state.view.screen) {
        case 'courses': return renderStudentCourses();
        case 'course-detail': return renderCourseDetail();
        case 'lesson-player': return renderLessonPlayer();
        case 'library': return renderLibrary(false);
        case 'groups': return renderGroups();
        case 'group-chat': return renderGroupChat();
        case 'assessments': return renderAssessments(false);
        case 'take-assessment': return renderTakeAssessment();

        case 'lect-courses': return renderLecturerCourses();
        case 'lect-lessons': return renderLecturerLessons();
        case 'lect-library': return renderLibrary(true);
        case 'lect-assessments': return renderAssessments(true);
        case 'lect-assessment-results': return renderAssessmentResults();

        case 'admin-directory': return renderAdminDirectory();
        case 'admin-academics': return renderAdminAcademics();
        case 'admin-activity': return renderAdminActivity();
        default: view.innerHTML = '<p>Not found.</p>';
      }
    } catch (err) {
      view.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
    }
  }

  // ================= STUDENT =================

  async function renderStudentCourses() {
    const [{ courses: mine }, { departments }] = await Promise.all([
      api('/students/me/courses'),
      api('/departments'),
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
  }

  function courseCardHtml(c) {
    return `<div class="card course-card" data-open-course="${c.id}">
      <div class="code tabular">${esc(c.code)}</div>
      <div style="margin:4px 0 8px;">${esc(c.title)}</div>
      <span class="pill pill-pass">${esc(c.level)}</span>
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
    view.innerHTML = `
      <div class="page-head">
        <div>
          <div class="muted tabular">${esc(course.department.name)} · ${esc(course.code)}</div>
          <h1>${esc(course.title)}</h1>
        </div>
        <button class="btn btn-ghost btn-sm" id="back-btn">← Back to courses</button>
      </div>
      <div class="card">
        ${lessons.map((l) => `
          <div class="list-row" data-open-lesson="${l.id}" style="cursor:pointer;">
            <div>
              <div style="font-weight:600;">${esc(l.title)}</div>
              <div class="meta">${l.isAiTeacher ? 'AI Teacher · narrated lesson' : 'Recorded lesson'}${l.videoUrl ? ' · video available' : ''}</div>
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
  }

  let speechState = { spans: [], utterance: null };

  async function renderLessonPlayer() {
    const { lessons } = await api(`/courses/${state.view.courseId}/lessons`);
    const lesson = lessons.find((l) => l.id === state.view.lessonId);
    if (!lesson) { view.innerHTML = '<p>Lesson not found.</p>'; return; }
    const words = lesson.script.split(/(\s+)/);
    const scriptHtml = words.map((w, i) => `<span data-w="${i}">${esc(w)}</span>`).join('');

    view.innerHTML = `
      <div class="page-head">
        <h1>${esc(lesson.title)}</h1>
        <button class="btn btn-ghost btn-sm" id="back-btn">← Back to course</button>
      </div>
      <div class="card lesson-player">
        <span class="pill pill-accent">AI Teacher — free narrated lesson</span>
        ${lesson.videoUrl ? `<div style="margin-top:14px;"><video src="${esc(lesson.videoUrl)}" controls style="width:100%; border-radius:10px;"></video></div>` : ''}
        <div class="controls">
          <button class="btn btn-primary" id="play-btn">▶ Play AI narration</button>
          <button class="btn btn-ghost" id="pause-btn">Pause</button>
          <button class="btn btn-ghost" id="stop-btn">Stop</button>
        </div>
        <div class="script-text" id="script-text">${scriptHtml}</div>
      </div>
    `;
    document.getElementById('back-btn').addEventListener('click', () => navigate('course-detail', { courseId: state.view.courseId }));

    const synth = window.speechSynthesis;
    const scriptEl = document.getElementById('script-text');

    document.getElementById('play-btn').addEventListener('click', () => {
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
            <div class="field"><label>File</label><input type="file" id="lib-file"></div>
            <div class="field"><label>...or a link instead</label><input type="url" id="lib-url" placeholder="https://"></div>
            <button class="btn btn-primary" type="submit">Upload</button>
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
        const url = document.getElementById('lib-url').value.trim();
        if (file) fd.append('file', file);
        if (url) fd.append('externalUrl', url);
        try {
          await api('/library', { method: 'POST', body: fd });
          toast('Resource uploaded');
          render();
        } catch (err) { toast(err.message); }
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

  async function renderGroupChat() {
    const { messages } = await api(`/groups/${state.view.groupId}/messages`);
    view.innerHTML = `
      <div class="page-head"><h1>Study group</h1><button class="btn btn-ghost btn-sm" id="back-btn">← Back to groups</button></div>
      <div class="card chat-box">
        <div class="chat-messages" id="chat-messages">
          ${messages.map((m) => `<div class="chat-msg"><div class="sender">${esc(m.sender.fullName)}</div>${esc(m.body)}</div>`).join('') || '<p class="muted">No messages yet — say hello.</p>'}
        </div>
        <form class="chat-input-row" id="chat-form">
          <input type="text" id="chat-input" placeholder="Message your study group…" required>
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
  }

  async function renderAssessments(isLecturer) {
    const courses = isLecturer ? (await ensureLectCourses()).courses : (await api('/students/me/courses')).courses;
    const rows = [];
    for (const c of courses) {
      const { assessments } = await api(`/courses/${c.id}/assessments`);
      rows.push({ course: c, assessments });
    }
    view.innerHTML = `
      <div class="page-head"><h1>${isLecturer ? 'Assessments' : 'CBT & Tests'}</h1></div>
      ${isLecturer ? `<button class="btn btn-accent btn-sm" id="new-assessment-btn" style="margin-bottom:18px;">+ New assessment</button>` : ''}
      ${rows.map(({ course, assessments }) => `
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
      `).join('') || '<p class="muted">No courses yet.</p>'}
    `;
    view.querySelectorAll('[data-take]').forEach((btn) => {
      btn.addEventListener('click', () => navigate('take-assessment', { assessmentId: btn.dataset.take }));
    });
    view.querySelectorAll('[data-results]').forEach((btn) => {
      btn.addEventListener('click', () => navigate('lect-assessment-results', { assessmentId: btn.dataset.results }));
    });
    if (isLecturer) {
      document.getElementById('new-assessment-btn').addEventListener('click', () => openNewAssessmentDialog(courses));
    }
  }

  async function renderTakeAssessment() {
    const { assessment, mySubmission } = await api(`/assessments/${state.view.assessmentId}`);
    if (mySubmission) {
      view.innerHTML = `
        <div class="page-head"><h1>${esc(assessment.title)}</h1><button class="btn btn-ghost btn-sm" id="back-btn">← Back</button></div>
        <div class="card" style="padding:24px;">
          <span class="pill pill-pass">Already submitted</span>
          <p style="margin-top:12px; font-size:1.3rem;" class="tabular">${mySubmission.score} / ${mySubmission.total}</p>
        </div>
      `;
      document.getElementById('back-btn').addEventListener('click', () => navigate('assessments'));
      return;
    }
    const answers = {};
    view.innerHTML = `
      <div class="page-head"><h1>${esc(assessment.title)}</h1><button class="btn btn-ghost btn-sm" id="back-btn">← Back</button></div>
      <p class="muted" style="margin-bottom:16px;">${assessment.durationMin} minutes · ${assessment.questions.length} questions · auto-graded on submit</p>
      ${assessment.questions.map((q, qi) => `
        <div class="card quiz-q">
          <div style="font-weight:600; margin-bottom:6px;">${qi + 1}. ${esc(q.text)}</div>
          ${q.options.map((opt, oi) => `<div class="quiz-opt" data-q="${q.id}" data-opt="${oi}">${esc(opt)}</div>`).join('')}
        </div>
      `).join('')}
      <button class="btn btn-primary" id="submit-btn">Submit test</button>
    `;
    document.getElementById('back-btn').addEventListener('click', () => navigate('assessments'));
    view.querySelectorAll('.quiz-opt').forEach((opt) => {
      opt.addEventListener('click', () => {
        const q = opt.dataset.q;
        view.querySelectorAll(`.quiz-opt[data-q="${q}"]`).forEach((o) => o.classList.remove('selected'));
        opt.classList.add('selected');
        answers[q] = Number(opt.dataset.opt);
      });
    });
    document.getElementById('submit-btn').addEventListener('click', async () => {
      const payload = Object.entries(answers).map(([questionId, choice]) => ({ questionId, choice }));
      try {
        const { submission } = await api(`/assessments/${assessment.id}/submit`, { method: 'POST', body: { answers: payload } });
        toast(`Submitted — score ${submission.score}/${submission.total}`);
        navigate('take-assessment', { assessmentId: assessment.id });
      } catch (err) { toast(err.message); }
    });
  }

  // ================= LECTURER =================

  async function ensureLectCourses() {
    const { departments } = await api('/departments');
    const myDept = departments.find((d) => d.id === state.user.departmentId) || departments[0];
    const courses = myDept ? (await api(`/departments/${myDept.id}/courses`)).courses : [];
    window.__lectCourses = courses;
    return { department: myDept, courses };
  }

  async function renderLecturerCourses() {
    const { department, courses } = await ensureLectCourses();
    view.innerHTML = `
      <div class="page-head"><h1>My Courses</h1></div>
      <p class="muted" style="margin-bottom:18px;">${department ? esc(department.name) : ''} department</p>
      <div class="grid-cards">
        ${courses.map((c) => `
          <div class="card course-card" data-open="${c.id}">
            <div class="code tabular">${esc(c.code)}</div>
            <div style="margin:4px 0 8px;">${esc(c.title)}</div>
            <span class="pill pill-pass">${esc(c.level)}</span>
          </div>
        `).join('') || '<p class="muted">No courses in your department yet — ask school admin to add one.</p>'}
      </div>
    `;
    view.querySelectorAll('[data-open]').forEach((el) => {
      el.addEventListener('click', () => navigate('lect-lessons', { courseId: el.dataset.open }));
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
      <div class="card" style="padding:20px; margin-bottom:22px;">
        <h3 style="margin-bottom:12px; font-size:1rem;">Add an AI-teacher lesson or recording</h3>
        <form id="lesson-form">
          <div class="field"><label>Title</label><input type="text" id="lsn-title" required></div>
          <div class="field"><label>Order</label><input type="number" id="lsn-order" value="${lessons.length + 1}" required></div>
          <div class="field"><label>Narration script (read aloud by the free AI teacher)</label><textarea id="lsn-script" required></textarea></div>
          <div class="field"><label>Recorded video URL (optional)</label><input type="url" id="lsn-video" placeholder="https://"></div>
          <button class="btn btn-primary" type="submit">Publish lesson</button>
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
    document.getElementById('lesson-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api(`/courses/${course.id}/lessons`, {
          method: 'POST',
          body: {
            title: document.getElementById('lsn-title').value,
            order: Number(document.getElementById('lsn-order').value),
            script: document.getElementById('lsn-script').value,
            videoUrl: document.getElementById('lsn-video').value.trim() || null,
          },
        });
        toast('Lesson published');
        render();
      } catch (err) { toast(err.message); }
    });
    view.querySelectorAll('[data-delete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this lesson?')) return;
        await api(`/lessons/${btn.dataset.delete}`, { method: 'DELETE' });
        render();
      });
    });
  }

  function openNewAssessmentDialog(courses) {
    const container = document.createElement('div');
    container.className = 'card';
    container.style.cssText = 'position:fixed; inset:0; margin:auto; width:min(560px,92vw); height:fit-content; max-height:86vh; overflow-y:auto; padding:24px; z-index:200;';
    let qCount = 1;
    function questionBlock(i) {
      return `<div class="field" data-question-block="${i}">
        <label>Question ${i + 1}</label>
        <input type="text" class="q-text" placeholder="Question text" required>
        <input type="text" class="q-opt" placeholder="Option A" required style="margin-top:6px;">
        <input type="text" class="q-opt" placeholder="Option B" required style="margin-top:6px;">
        <input type="text" class="q-opt" placeholder="Option C" style="margin-top:6px;">
        <input type="text" class="q-opt" placeholder="Option D" style="margin-top:6px;">
        <select class="q-correct" style="margin-top:6px;">
          <option value="0">Correct: Option A</option><option value="1">Correct: Option B</option>
          <option value="2">Correct: Option C</option><option value="3">Correct: Option D</option>
        </select>
      </div>`;
    }
    container.innerHTML = `
      <h3 style="margin-bottom:14px;">New assessment</h3>
      <div class="field"><label>Course</label><select id="na-course">${courses.map((c) => `<option value="${c.id}">${esc(c.code)}</option>`).join('')}</select></div>
      <div class="field"><label>Title</label><input type="text" id="na-title" required></div>
      <div class="field"><label>Type</label><select id="na-type"><option>CA</option><option>Test</option><option>Mock</option><option>Assignment</option></select></div>
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

    container.querySelector('#na-add-q').addEventListener('click', () => {
      const div = document.createElement('div');
      div.innerHTML = questionBlock(qCount++);
      container.querySelector('#na-questions').appendChild(div.firstElementChild);
    });
    function close() { backdrop.remove(); container.remove(); }
    container.querySelector('#na-cancel').addEventListener('click', close);
    container.querySelector('#na-save').addEventListener('click', async () => {
      const blocks = container.querySelectorAll('[data-question-block]');
      const questions = Array.from(blocks).map((b) => ({
        text: b.querySelector('.q-text').value,
        options: Array.from(b.querySelectorAll('.q-opt')).map((i) => i.value).filter(Boolean),
        correctIndex: Number(b.querySelector('.q-correct').value),
      })).filter((q) => q.text && q.options.length >= 2);
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
    document.getElementById('back-btn').addEventListener('click', () => navigate('lect-assessments'));
  }

  // ================= ADMIN =================

  async function renderAdminDirectory() {
    const [{ students }, { lecturers }] = await Promise.all([api('/admin/students'), api('/admin/lecturers')]);
    view.innerHTML = `
      <div class="page-head"><h1>Staff & Student Directory</h1></div>
      <h3 style="margin-bottom:10px; font-size:1rem;">Lecturers (${lecturers.length})</h3>
      <div class="card" style="overflow-x:auto; margin-bottom:26px;">
        <table class="data-table">
          <thead><tr><th>Name</th><th>Staff ID</th><th>Department</th><th>Email</th></tr></thead>
          <tbody>${lecturers.map((l) => `<tr><td>${esc(l.fullName)}</td><td class="tabular">${esc(l.staffId || '—')}</td><td>${esc(l.department ? l.department.name : '—')}</td><td>${esc(l.email)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">None yet.</td></tr>'}</tbody>
        </table>
      </div>
      <h3 style="margin-bottom:10px; font-size:1rem;">Students (${students.length})</h3>
      <div class="card" style="overflow-x:auto;">
        <table class="data-table">
          <thead><tr><th>Name</th><th>Matric No.</th><th>Department</th><th>Email</th></tr></thead>
          <tbody>${students.map((s) => `<tr><td>${esc(s.fullName)}</td><td class="tabular">${esc(s.matricNumber || '—')}</td><td>${esc(s.department ? s.department.name : '—')}</td><td>${esc(s.email)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">None yet.</td></tr>'}</tbody>
        </table>
      </div>
    `;
  }

  async function renderAdminAcademics() {
    const { departments } = await api('/departments');
    const deptCourses = {};
    for (const d of departments) deptCourses[d.id] = (await api(`/departments/${d.id}/courses`)).courses;
    view.innerHTML = `
      <div class="page-head"><h1>Departments & Courses</h1></div>
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

  async function renderAdminActivity() {
    const { logs } = await api('/admin/lecturer-activity');
    view.innerHTML = `
      <div class="page-head"><h1>Lecturer Activity</h1></div>
      <p class="muted" style="margin-bottom:18px;">Logins, lessons published, resources uploaded and assessments created — by design, student activity is never tracked here.</p>
      <div class="card" style="overflow-x:auto;">
        <table class="data-table">
          <thead><tr><th>Lecturer</th><th>Action</th><th>Detail</th><th>When</th></tr></thead>
          <tbody>${logs.map((l) => `<tr><td>${esc(l.user.fullName)}</td><td>${esc(l.action)}</td><td>${esc(l.detail || '—')}</td><td class="tabular">${new Date(l.createdAt).toLocaleString()}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No activity yet.</td></tr>'}</tbody>
        </table>
      </div>
    `;
  }

  // ---------- boot ----------
  if (state.token && state.user) {
    authScreen.style.display = 'none';
    appScreen.classList.add('active');
    buildSidebar();
    navigate(defaultScreenFor(state.user.role));
  }
})();
