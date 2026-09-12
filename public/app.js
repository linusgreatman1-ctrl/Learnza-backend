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
      ['research', 'AI Research Assistant'],
      ['progress', 'My Progress'],
      ['billing', 'Subscription'],
    ],
    LECTURER: [
      ['lect-courses', 'My Courses'],
      ['lect-library', 'e-Library'],
      ['lect-assessments', 'Assessments'],
      ['research', 'AI Research Assistant'],
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
    if (state.view.screen === 'live-class' && screen !== 'live-class') teardownLive();
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
        case 'billing': return renderBilling();
        case 'ai-teacher-session': return renderAiTeacherSession();
        case 'live-class': return renderLiveClass();
        case 'progress': return renderProgress();
        case 'research': return renderResearchAssistant();

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
      if (err.code === 'SUBSCRIPTION_REQUIRED') return renderUpgradePrompt(err.message);
      view.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
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
    const joinLiveBtn = document.getElementById('join-live-btn');
    if (joinLiveBtn) joinLiveBtn.addEventListener('click', () => {
      navigate('live-class', { courseId: course.id, liveClassId: liveClass.id, isHost: false, title: liveClass.title });
    });
  }

  async function startAiTeacherSession(courseId, topic) {
    try {
      const { session } = await api(`/courses/${courseId}/ai-teacher/sessions`, { method: 'POST', body: { topic } });
      navigate('ai-teacher-session', { sessionId: session.id });
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

    const words = lesson.script.split(/(\s+)/);
    const scriptHtml = words.map((w, i) => `<span data-w="${i}">${esc(w)}</span>`).join('');

    view.innerHTML = `
      <div class="page-head">
        <h1>${esc(lesson.title)}</h1>
        <button class="btn btn-ghost btn-sm" id="back-btn">← Back to course</button>
      </div>
      <div class="card lesson-player">
        <span class="pill pill-accent">AI Teacher — subscriber lesson</span>
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

  // ================= AI TEACHER (live interactive session) =================

  function speak(text) {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 0.98;
    window.speechSynthesis.speak(utter);
  }

  async function renderAiTeacherSession() {
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
        <div class="meta">Section ${session.sectionIdx + 1} of ${session.plan.sections.length}${session.status === 'COMPLETED' ? ' · Completed' : ''}</div>
        <h3 style="margin:8px 0 12px;">${esc(section.title)}</h3>
        ${avatarConfigured ? `<div id="avatar-box" style="background:var(--paper); border:1px solid var(--line); border-radius:10px; padding:14px; margin-bottom:14px;">
          <button class="btn btn-ghost btn-sm" id="start-avatar-btn">🎥 Connect AI video avatar</button>
        </div>` : ''}
        <div class="script-text" style="white-space:pre-wrap;">${esc(section.boardText)}</div>
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

        <div class="hr"></div>
        <div style="font-weight:600; margin-bottom:8px;">Ask the AI Teacher a question</div>
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
    `;

    document.getElementById('back-btn').addEventListener('click', () => navigate('course-detail', { courseId: session.courseId }));
    document.getElementById('play-btn').addEventListener('click', () => speak(section.speechText));

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

    document.getElementById('interrupt-btn').addEventListener('click', async () => {
      const input = document.getElementById('interrupt-input');
      const question = input.value.trim();
      if (!question) return;
      input.value = '';
      try {
        await api(`/ai-teacher/sessions/${session.id}/interrupt`, { method: 'POST', body: { question } });
        render();
      } catch (err) {
        if (err.code === 'SUBSCRIPTION_REQUIRED') return renderUpgradePrompt(err.message);
        toast(err.message);
      }
    });

    const avatarBtn = document.getElementById('start-avatar-btn');
    if (avatarBtn) avatarBtn.addEventListener('click', async () => {
      try {
        await api(`/ai-teacher/sessions/${session.id}/avatar`, { method: 'POST' });
        toast('Avatar session started — video wiring finishes once Simli is fully connected.');
      } catch (err) {
        toast(err.message);
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
      <div class="page-head"><h1>My Progress</h1></div>
      <p class="muted" style="margin-bottom:20px;">Private to you — Learnza has no leaderboard or ranking.</p>
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
    const [{ active, subscription }, { paystack, flutterwave }] = await Promise.all([
      api('/billing/status'),
      api('/billing/providers'),
    ]);
    const noProvider = !paystack && !flutterwave;

    view.innerHTML = `
      <div class="page-head"><h1>Subscription</h1></div>
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
        const { submission, pointsEarned, newBadges } = await api(`/assessments/${assessment.id}/submit`, { method: 'POST', body: { answers: payload } });
        toast(`Submitted — score ${submission.score}/${submission.total} · +${pointsEarned} points`);
        (newBadges || []).forEach((b) => setTimeout(() => toast(`Badge earned: ${b.icon} ${b.name}`), 400));
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
      <div class="card" style="padding:20px; margin-bottom:18px; display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap;">
        <div>
          <div style="font-weight:600;">Teach this course live</div>
          <div class="meta">Students with an active subscription can join and watch in real time.</div>
        </div>
        <button class="btn btn-accent" id="go-live-btn">🔴 Go live</button>
      </div>
      <div class="card" style="padding:20px; margin-bottom:22px;">
        <h3 style="margin-bottom:12px; font-size:1rem;">Add a recorded lesson (subscribers only)</h3>
        <form id="lesson-form">
          <div class="field"><label>Title</label><input type="text" id="lsn-title" required></div>
          <div class="field"><label>Order</label><input type="number" id="lsn-order" value="${lessons.length + 1}" required></div>
          <div class="field"><label>Narration script (read aloud in the lesson player)</label><textarea id="lsn-script" required></textarea></div>
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
    if (location.hash.includes('billing-callback') && state.user.role === 'STUDENT') {
      checkPendingPayment().then(() => navigate('billing'));
    } else {
      navigate(defaultScreenFor(state.user.role));
    }
  }
})();
