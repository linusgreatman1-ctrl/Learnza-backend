/* Meetings: video or audio meetings the admin hosts with the people invited, and the schedule of meetings and other activities.
   Star shape, like a live class: the host sees and hears everyone who joins; everyone who joins sees and hears the host.
   Used by the Schools app. ctx = { api, esc, toast, token(), user, navigate(screen, params) } */
(function () {
  'use strict';
  const ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
  const css = `
  .mt-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px;margin:12px 0}
  .mt-tile{position:relative;background:#0b1220;border-radius:14px;overflow:hidden;aspect-ratio:4/3;display:flex;align-items:center;justify-content:center;border:1px solid rgba(255,255,255,.08)}
  .mt-tile video{width:100%;height:100%;object-fit:cover;background:#000}
  .mt-tile .mt-name{position:absolute;left:8px;bottom:8px;right:8px;font-size:.75rem;color:#fff;text-shadow:0 1px 3px #000;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .mt-tile .mt-ini{width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,#c1861f,#e9b949);color:#1b1305;font-weight:800;font-size:1.3rem;display:flex;align-items:center;justify-content:center}
  .mt-main{position:relative;background:#0b1220;border-radius:16px;overflow:hidden;min-height:260px;aspect-ratio:16/9;display:flex;align-items:center;justify-content:center}
  .mt-main video{width:100%;height:100%;object-fit:contain;background:#000}
  .mt-self{position:absolute;right:10px;bottom:10px;width:120px;aspect-ratio:4/3;border-radius:10px;overflow:hidden;border:2px solid rgba(255,255,255,.4);background:#000}
  .mt-self video{width:100%;height:100%;object-fit:cover}
  .mt-bar{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}
  .mt-row{display:flex;align-items:center;gap:14px;padding:12px 0;border-bottom:1px solid rgba(128,128,128,.2)}
  .mt-row:last-child{border-bottom:none}
  .mt-when{width:62px;flex-shrink:0;text-align:center;background:rgba(201,150,12,.14);border-radius:10px;padding:6px 4px}
  .mt-when .d{font-size:1.15rem;font-weight:800;line-height:1.1}
  .mt-when .m{font-size:.62rem;text-transform:uppercase;letter-spacing:.05em;opacity:.7}
  .mt-body{flex:1;min-width:0}
  .mt-title{font-weight:700;font-size:.92rem}
  .mt-sub{font-size:.78rem;opacity:.7;margin-top:2px}
  .mt-live{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:14px 18px;border-radius:14px;background:linear-gradient(135deg,#7f1d1d,#b91c1c);color:#fff;margin-bottom:18px}
  #mt-add input,#mt-add select,#mt-title,#mt-aud{background:var(--paper);color:var(--ink);border:1px solid var(--line);border-radius:10px;padding:10px 12px;width:100%}
  .mt-pill{display:inline-block;padding:3px 10px;border-radius:999px;background:rgba(201,150,12,.16);font-size:.74rem;margin:2px 4px 2px 0}`;
  function injectCss() { if (!document.getElementById('mt-css')) { const s = document.createElement('style'); s.id = 'mt-css'; s.textContent = css; document.head.appendChild(s); } }
  const initials = (n) => String(n || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';

  // "in 2 hours", "3 days ago"
  function whenText(d) {
    const ms = new Date(d).getTime() - Date.now(), a = Math.abs(ms), m = Math.round(a / 60000);
    const span = m < 60 ? m + ' min' : m < 1440 ? Math.round(m / 60) + ' hr' : Math.round(m / 1440) + ' day' + (Math.round(m / 1440) === 1 ? '' : 's');
    return ms >= 0 ? (m < 1 ? 'starting now' : 'in ' + span) : span + ' ago';
  }

  // ── the room ────────────────────────────────────────────────────────────
  let room = null; // { socket, local, pcs: Map, ... }
  function leaveRoom() {
    if (!room) return;
    try { room.pcs.forEach((pc) => pc.close()); } catch { /* closing */ }
    try { room.socket.disconnect(); } catch { /* closing */ }
    try { room.local && room.local.getTracks().forEach((t) => t.stop()); } catch { /* closing */ }
    room = null;
  }

  async function localMedia(video) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return null;
    try { return await navigator.mediaDevices.getUserMedia({ audio: true, video: video ? { width: 640, height: 480 } : false }); } catch { /* no camera, or refused */ }
    if (video) { try { return await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { /* no mic either */ } }
    return null;
  }

  async function openRoom(view, ctx, params) {
    injectCss();
    leaveRoom();
    const { esc, toast, api } = ctx;
    let info;
    try { info = (await api('/meetings/' + encodeURIComponent(params.meetingId))).meeting; } catch (err) { view.innerHTML = '<div class="page-head"><h1>Meeting</h1></div><div class="card" style="padding:18px;">' + esc(err.message) + '</div>'; return; }
    if (info.status !== 'ACTIVE') { view.innerHTML = '<div class="page-head"><h1>' + esc(info.title) + '</h1></div><div class="card" style="padding:18px;">This meeting has ended.</div>'; return; }
    const hosting = !!info.hosting, video = !!info.video;
    view.innerHTML = `
      <div class="page-head"><h1>${esc(info.title)}</h1><span class="pill pill-accent">${video ? '🎥 Video' : '📞 Audio'} meeting</span></div>
      <div class="muted" id="mt-status" style="margin-bottom:8px;">Connecting…</div>
      ${hosting ? '<div class="mt-grid" id="mt-grid"></div>' : '<div class="mt-main" id="mt-main"><div class="mt-ini" id="mt-host-ini">' + esc(initials(info.hostName)) + '</div></div>'}
      <div class="mt-bar">
        <button class="btn btn-ghost btn-sm" id="mt-mic">🎙️ Mute</button>
        ${video ? '<button class="btn btn-ghost btn-sm" id="mt-cam">📷 Camera off</button>' : ''}
        ${hosting ? '<button class="btn btn-ghost btn-sm" id="mt-leave">← Leave (meeting keeps going)</button><button class="btn btn-accent btn-sm" id="mt-end" style="background:#b91c1c;border-color:#b91c1c;color:#fff;">End meeting for everyone</button>' : '<button class="btn btn-accent btn-sm" id="mt-leave" style="background:#b91c1c;border-color:#b91c1c;color:#fff;">Leave meeting</button>'}
      </div>
      ${hosting ? '<p class="muted" style="margin-top:10px;font-size:.82rem;">You see and hear everyone who joins. They see and hear you.</p>' : '<p class="muted" style="margin-top:10px;font-size:.82rem;">You see and hear the host, and the host sees and hears you.</p>'}`;
    const $ = (id) => view.querySelector('#' + id);
    const status = (t) => { const s = $('mt-status'); if (s) s.textContent = t; };
    const local = await localMedia(video);
    if (!local) status('Your microphone could not be started — you can still listen. Allow the microphone in your browser to speak.');
    const socket = window.io('/meeting', { auth: (cb) => cb({ token: ctx.token() }) });
    room = { socket, local, pcs: new Map(), hosting };
    const attachLocal = (pc) => { if (local) local.getTracks().forEach((t) => pc.addTrack(t, local)); };
    const send = (to, data) => socket.emit('meeting:signal', { to, data });

    if (hosting) {
      const grid = $('mt-grid');
      const tile = (id, name) => {
        let t = grid.querySelector('[data-id="' + id + '"]');
        if (!t) { t = document.createElement('div'); t.className = 'mt-tile'; t.dataset.id = id; t.innerHTML = '<div class="mt-ini">' + esc(initials(name)) + '</div><video autoplay playsinline style="display:none"></video><div class="mt-name">' + esc(name) + '</div>'; grid.appendChild(t); }
        return t;
      };
      if (local) { // your own tile (muted so you do not hear yourself)
        const t = tile('self', 'You'); const v = t.querySelector('video'); v.muted = true; v.srcObject = local; if (video && local.getVideoTracks().length) { v.style.display = ''; t.querySelector('.mt-ini').style.display = 'none'; }
      } else tile('self', 'You');
      const count = () => status((room && room.pcs.size) + ' joined — ' + (grid.children.length - 1 ? 'everyone can hear you.' : 'waiting for people to join.'));
      const connect = async (socketId, name) => {
        if (!room) return;
        const old = room.pcs.get(socketId); if (old) { try { old.close(); } catch { /* replaced */ } }
        const pc = new RTCPeerConnection({ iceServers: ICE });
        room.pcs.set(socketId, pc);
        const t = tile(socketId, name);
        attachLocal(pc);
        pc.ontrack = (e) => {
          const v = t.querySelector('video'); v.srcObject = e.streams[0]; v.style.display = ''; v.play().catch(() => {});
          if (!video || !e.streams[0].getVideoTracks().length) { v.style.display = 'none'; t.querySelector('.mt-ini').style.display = ''; v.style.display = 'none'; const au = t.querySelector('audio') || (() => { const a = document.createElement('audio'); a.autoplay = true; t.appendChild(a); return a; })(); au.srcObject = e.streams[0]; au.play().catch(() => {}); }
          else t.querySelector('.mt-ini').style.display = 'none';
        };
        pc.onicecandidate = (e) => { if (e.candidate) send(socketId, { candidate: e.candidate }); };
        const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: video });
        await pc.setLocalDescription(offer);
        send(socketId, { sdp: pc.localDescription });
        count();
      };
      socket.on('connect', () => socket.emit('meeting:enter', { meetingId: params.meetingId }));
      socket.on('meeting:hosting', ({ participants }) => { status('Waiting for people to join…'); (participants || []).forEach((p) => connect(p.socketId, p.name)); });
      socket.on('meeting:participant-joined', (p) => connect(p.socketId, p.name));
      socket.on('meeting:participant-left', ({ socketId }) => { const pc = room && room.pcs.get(socketId); if (pc) pc.close(); room && room.pcs.delete(socketId); const t = grid.querySelector('[data-id="' + socketId + '"]'); if (t) t.remove(); count(); });
      socket.on('meeting:signal', async ({ from, data }) => {
        const pc = room && room.pcs.get(from); if (!pc) return;
        try { if (data.sdp) await pc.setRemoteDescription(data.sdp); else if (data.candidate) await pc.addIceCandidate(data.candidate); } catch { /* a stale message */ }
      });
    } else {
      let pc = null;
      const mainEl = $('mt-main');
      socket.on('connect', () => socket.emit('meeting:enter', { meetingId: params.meetingId }));
      socket.on('meeting:joined', ({ hostOnline }) => status(hostOnline ? 'Joining…' : 'Waiting for the host to arrive…'));
      socket.on('meeting:host-online', () => { status('Joining…'); socket.emit('meeting:ready'); });
      socket.on('meeting:host-offline', () => status('The host has lost connection — waiting for them to come back…'));
      socket.on('meeting:signal', async ({ from, data }) => {
        try {
          if (data.sdp && data.sdp.type === 'offer') {
            if (pc) { try { pc.close(); } catch { /* replaced */ } }
            pc = new RTCPeerConnection({ iceServers: ICE });
            room.pcs.set('host', pc);
            pc.ontrack = (e) => {
              mainEl.querySelectorAll('video,audio').forEach((x) => x.remove());
              const hasVideo = e.streams[0].getVideoTracks().length > 0;
              const el = document.createElement(hasVideo ? 'video' : 'audio'); el.autoplay = true; if (hasVideo) el.playsInline = true; el.srcObject = e.streams[0]; mainEl.appendChild(el); el.play().catch(() => {});
              const ini = $('mt-host-ini'); if (ini && hasVideo) ini.style.display = 'none';
              status('Connected — ' + esc(info.hostName || 'the host') + ' can see and hear you.');
            };
            pc.onicecandidate = (e) => { if (e.candidate) send(from, { candidate: e.candidate }); };
            await pc.setRemoteDescription(data.sdp);
            attachLocal(pc);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            send(from, { sdp: pc.localDescription });
            if (local && video && local.getVideoTracks().length) {
              let self = mainEl.querySelector('.mt-self');
              if (!self) { self = document.createElement('div'); self.className = 'mt-self'; self.innerHTML = '<video autoplay playsinline muted></video>'; mainEl.appendChild(self); }
              self.querySelector('video').srcObject = local;
            }
          } else if (data.candidate && pc) await pc.addIceCandidate(data.candidate);
        } catch { /* a stale message */ }
      });
    }
    socket.on('meeting:error', ({ message }) => { status(message); toast(message); });
    socket.on('meeting:ended', () => { toast('The meeting has ended.'); leaveRoom(); ctx.navigate(ctx.user.role === 'ADMIN' ? 'meeting' : 'meeting-join'); });

    const mic = $('mt-mic'), cam = $('mt-cam');
    if (mic) mic.addEventListener('click', () => { if (!local) return toast('No microphone found.'); const on = local.getAudioTracks().some((t) => t.enabled); local.getAudioTracks().forEach((t) => { t.enabled = !on; }); mic.textContent = on ? '🎙️ Unmute' : '🎙️ Mute'; });
    if (cam) cam.addEventListener('click', () => { if (!local || !local.getVideoTracks().length) return toast('No camera found.'); const on = local.getVideoTracks().some((t) => t.enabled); local.getVideoTracks().forEach((t) => { t.enabled = !on; }); cam.textContent = on ? '📷 Camera on' : '📷 Camera off'; });
    $('mt-leave').addEventListener('click', () => { try { sessionStorage.setItem('mt_declined_' + params.meetingId, '1'); } catch { /* ignore */ } leaveRoom(); ctx.navigate(hosting ? 'meeting' : 'meeting-join'); });
    const end = $('mt-end');
    if (end) end.addEventListener('click', async () => { if (!confirm('End this meeting for everyone?')) return; try { await api('/meetings/' + params.meetingId + '/end', { method: 'POST' }); } catch (err) { toast(err.message); } leaveRoom(); ctx.navigate('meeting'); });
  }

  // ── schedule ────────────────────────────────────────────────────────────
  function scheduleCard(ctx, audiences, onChange) {
    const { esc, toast, api } = ctx;
    const wrap = document.createElement('div');
    wrap.innerHTML = '<div class="muted" style="padding:10px 0;">Loading…</div>';
    const rowHtml = (s) => {
      const d = new Date(s.whenAt);
      return `<div class="mt-row"><div class="mt-when"><div class="d">${d.getDate()}</div><div class="m">${d.toLocaleString('en', { month: 'short' })}</div></div>
        <div class="mt-body"><div class="mt-title">${esc(s.title)}</div><div class="mt-sub">${esc(d.toLocaleString('en-NG', { weekday: 'short', hour: 'numeric', minute: '2-digit' }))} · ${esc(whenText(s.whenAt))}${s.note ? ' · ' + esc(s.note) : ''}</div></div>
        <button class="btn btn-ghost btn-sm" data-del="${s.id}">Remove</button></div>`;
    };
    async function load() {
      const { schedules } = await api('/meeting-schedules');
      const upcoming = schedules.filter((s) => new Date(s.whenAt).getTime() >= Date.now() - 3600 * 1000), past = schedules.filter((s) => !upcoming.includes(s)).reverse();
      wrap.innerHTML = `
        <div class="card" style="padding:6px 18px;">${upcoming.map(rowHtml).join('') || '<p class="muted" style="padding:14px 0;">Nothing scheduled yet.</p>'}</div>
        ${past.length ? '<h3 style="margin:18px 0 8px;font-size:.95rem;">Earlier</h3><div class="card" style="padding:6px 18px;opacity:.8;">' + past.slice(0, 15).map(rowHtml).join('') + '</div>' : ''}
        <h3 style="margin:22px 0 8px;font-size:1rem;">Add to the schedule</h3>
        <form class="card" id="mt-add" style="padding:18px;">
          <div class="field"><label>Meeting or activity</label><input id="ms-title" required placeholder="e.g. Staff meeting, Senate meeting, Inspection visit"></div>
          <div style="display:flex;gap:12px;flex-wrap:wrap;"><div class="field" style="flex:1;min-width:200px;"><label>Date and time</label><input id="ms-when" type="datetime-local" required></div>
            ${audiences && audiences.length ? '<div class="field" style="flex:1;min-width:200px;"><label>With</label><select id="ms-aud"><option value="">Just for me</option>' + audiences.map((a) => '<option value="' + a.key + '">' + esc(a.label) + '</option>').join('') + '</select></div>' : ''}</div>
          <div class="field"><label>Note (optional)</label><input id="ms-note" placeholder="Venue, agenda…"></div>
          <button class="btn btn-primary" type="submit">+ Add to schedule</button>
        </form>`;
      wrap.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => { try { await api('/meeting-schedules/' + b.dataset.del, { method: 'DELETE' }); toast('Removed'); load(); } catch (err) { toast(err.message); } }));
      wrap.querySelector('#mt-add').addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await api('/meeting-schedules', { method: 'POST', body: { title: wrap.querySelector('#ms-title').value, when: new Date(wrap.querySelector('#ms-when').value).toISOString(), note: wrap.querySelector('#ms-note').value, audience: (wrap.querySelector('#ms-aud') || {}).value || '' } });
          toast('Added to your schedule'); load();
        } catch (err) { toast(err.message); }
      });
    }
    load().catch((err) => { wrap.innerHTML = '<p class="muted">' + esc(err.message) + '</p>'; });
    return wrap;
  }

  // ── the admin's Meeting page ────────────────────────────────────────────
  async function meetingHome(view, ctx) {
    injectCss();
    leaveRoom();
    const { esc, toast, api } = ctx;
    const [{ audiences }, { meetings }] = await Promise.all([api('/meetings/audiences'), api('/meetings/active')]);
    const mine = meetings.filter((m) => m.hosting);
    view.innerHTML = `
      <div class="page-head"><h1>Meeting</h1></div>
      ${mine.map((m) => `<div class="mt-live"><div><b>🔴 ${esc(m.title)}</b><div style="font-size:.82rem;opacity:.85;">Your ${m.video ? 'video' : 'audio'} meeting is going on.</div></div><button class="btn btn-accent btn-sm" data-return="${m.id}">Return to meeting</button></div>`).join('')}
      <div class="card" style="padding:18px;margin-bottom:22px;">
        <h3 style="font-size:1rem;margin-bottom:10px;">Start a meeting</h3>
        <div style="display:flex;gap:12px;flex-wrap:wrap;">
          <div class="field" style="flex:2;min-width:220px;"><label>Title (optional)</label><input id="mt-title" placeholder="e.g. Staff meeting"></div>
          <div class="field" style="flex:1;min-width:220px;"><label>Meet with</label><select id="mt-aud">${audiences.map((a) => `<option value="${a.key}">${esc(a.label)} (${a.people})</option>`).join('')}</select></div>
        </div>
        <div id="mt-who" class="muted" style="margin:4px 0 12px;font-size:.84rem;"></div>
        <div class="mt-bar" style="margin-top:0;"><button class="btn btn-primary" id="mt-video">🎥 Start video meeting</button><button class="btn btn-ghost" id="mt-audio">📞 Start audio meeting</button></div>
        <p class="muted" style="font-size:.78rem;margin-top:10px;">Everyone invited gets a notification and can join from it. You see and hear everyone who joins; they see and hear you.</p>
      </div>
      <h3 style="margin-bottom:10px;font-size:1rem;">Meeting schedule &amp; reminders</h3>
      <div id="mt-sched"></div>`;
    view.querySelectorAll('[data-return]').forEach((b) => b.addEventListener('click', () => ctx.navigate('meeting-room', { meetingId: b.dataset.return })));
    const who = view.querySelector('#mt-who');
    async function showWho() {
      try { const { people } = await api('/meetings/roster?audience=' + view.querySelector('#mt-aud').value); who.innerHTML = people.length ? people.slice(0, 40).map((p) => '<span class="mt-pill">' + esc(p.fullName) + '</span>').join('') + (people.length > 40 ? ' +' + (people.length - 40) + ' more' : '') : 'Nobody to invite yet.'; } catch { who.textContent = ''; }
    }
    view.querySelector('#mt-aud').addEventListener('change', showWho); showWho();
    const start = async (video) => {
      try {
        const { meeting } = await api('/meetings/start', { method: 'POST', body: { title: view.querySelector('#mt-title').value, audience: view.querySelector('#mt-aud').value, video } });
        toast('Meeting started — ' + meeting.invited + ' invited');
        ctx.navigate('meeting-room', { meetingId: meeting.id });
      } catch (err) { toast(err.message); }
    };
    view.querySelector('#mt-video').addEventListener('click', () => start(true));
    view.querySelector('#mt-audio').addEventListener('click', () => start(false));
    view.querySelector('#mt-sched').appendChild(scheduleCard(ctx, audiences));
  }

  async function schedulesPage(view, ctx) {
    injectCss();
    const { audiences } = await ctx.api('/meetings/audiences').catch(() => ({ audiences: [] }));
    view.innerHTML = '<div class="page-head"><h1>My Schedules</h1></div><p class="muted" style="margin-bottom:14px;">All your scheduled meetings and activities, with reminders. Only you can see them.</p><div id="mt-sched"></div>';
    view.querySelector('#mt-sched').appendChild(scheduleCard(ctx, audiences));
  }

  // ── what a lecturer or other staff member sees: the meetings they are invited to ───────────────
  async function joinPage(view, ctx) {
    injectCss();
    leaveRoom();
    const { esc, api } = ctx;
    const { meetings } = await api('/meetings/active');
    view.innerHTML = `<div class="page-head"><h1>Meetings</h1></div>
      ${meetings.map((m) => `<div class="mt-live"><div><b>🔴 ${esc(m.title)}</b><div style="font-size:.82rem;opacity:.85;">${esc(m.hostName)} · ${m.video ? 'video' : 'audio'} meeting</div></div><button class="btn btn-accent btn-sm" data-join="${m.id}">Join now</button></div>`).join('') || '<div class="card" style="padding:18px;">No meeting is going on right now. When your administrator starts one you will get a notification here and can join from it.</div>'}`;
    view.querySelectorAll('[data-join]').forEach((b) => b.addEventListener('click', () => ctx.navigate('meeting-room', { meetingId: b.dataset.join })));
  }

  // ── an incoming meeting: a pop-up that rings, for everyone invited ──────────────────────────────────────────────
  // The ring is made with the browser's own sound (no file). Browsers only allow sound after the person has touched the page
  // once, so the first tap or key press unlocks it; until then the pop-up, the title and a phone vibration still tell them.
  let visBound = false;
  let audioCtx = null, ringTimer = null, ringStop = null, watchTimer = null, titleTimer = null;
  function unlockAudio() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch { /* no sound available */ }
  }
  ['click', 'keydown', 'touchstart'].forEach((e) => document.addEventListener(e, unlockAudio, { passive: true }));
  function ringOnce() {
    try {
      if (audioCtx && audioCtx.state === 'running') {
        const t = audioCtx.currentTime;
        [[0, 660], [0.34, 880]].forEach(([d, f]) => {
          const o = audioCtx.createOscillator(), g = audioCtx.createGain();
          o.type = 'sine'; o.frequency.value = f;
          g.gain.setValueAtTime(0.0001, t + d); g.gain.exponentialRampToValueAtTime(0.3, t + d + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.3);
          o.connect(g); g.connect(audioCtx.destination); o.start(t + d); o.stop(t + d + 0.32);
        });
      }
      if (navigator.vibrate) navigator.vibrate([250, 120, 250]);
    } catch { /* ringing is a courtesy */ }
  }
  function stopRing() {
    if (ringTimer) { clearInterval(ringTimer); ringTimer = null; }
    if (ringStop) { clearTimeout(ringStop); ringStop = null; }
    if (titleTimer) { clearInterval(titleTimer); titleTimer = null; document.title = document.title.replace(/^📞 /, ''); }
  }
  function startRing() {
    stopRing(); unlockAudio(); ringOnce();
    ringTimer = setInterval(ringOnce, 2200);
    ringStop = setTimeout(() => { if (ringTimer) { clearInterval(ringTimer); ringTimer = null; } }, 60000);     // rings for a minute; the pop-up stays
    titleTimer = setInterval(() => { document.title = /^📞 /.test(document.title) ? document.title.replace(/^📞 /, '') : '📞 ' + document.title; }, 900);
  }
  function closeCall() { stopRing(); const o = document.getElementById('mt-call'); if (o) o.remove(); }
  function showCall(m, ctx) {
    closeCall();
    const o = document.createElement('div');
    o.id = 'mt-call'; o.dataset.id = m.id;
    o.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(5,10,20,.72);display:flex;align-items:center;justify-content:center;padding:20px;';
    o.innerHTML = `<style>@keyframes mtpulse{0%{box-shadow:0 0 0 0 rgba(34,197,94,.55)}100%{box-shadow:0 0 0 26px rgba(34,197,94,0)}}</style>
      <div style="background:#0f1b2d;color:#fff;border-radius:22px;padding:28px 24px;max-width:340px;width:100%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.5);">
        <div style="width:78px;height:78px;border-radius:50%;margin:0 auto 14px;background:#16a34a;display:flex;align-items:center;justify-content:center;font-size:34px;animation:mtpulse 1.3s infinite;">${m.video ? '🎥' : '📞'}</div>
        <div style="font-size:.78rem;letter-spacing:.12em;text-transform:uppercase;opacity:.7;">Incoming ${m.video ? 'video' : 'audio'} meeting</div>
        <div style="font-size:1.25rem;font-weight:800;margin:6px 0 2px;">${ctx.esc(m.hostName || 'Meeting')}</div>
        <div style="opacity:.85;margin-bottom:20px;">${ctx.esc(m.title)}</div>
        <div style="display:flex;gap:12px;"><button id="mt-call-no" style="flex:1;padding:14px;border-radius:14px;border:none;background:#b91c1c;color:#fff;font-weight:800;font-size:1rem;cursor:pointer;">Decline</button><button id="mt-call-yes" style="flex:1;padding:14px;border-radius:14px;border:none;background:#16a34a;color:#fff;font-weight:800;font-size:1rem;cursor:pointer;">Join</button></div>
      </div>`;
    document.body.appendChild(o);
    startRing();
    o.querySelector('#mt-call-yes').onclick = () => { closeCall(); ctx.navigate('meeting-room', { meetingId: m.id }); };
    o.querySelector('#mt-call-no').onclick = () => { try { sessionStorage.setItem('mt_declined_' + m.id, '1'); } catch { /* ignore */ } closeCall(); };
  }
  async function pollCalls(ctx) {
    try {
      const { meetings } = await ctx.api('/meetings/active');
      const incoming = meetings.filter((m) => !m.hosting);
      const open = document.getElementById('mt-call');
      if (!incoming.length) { if (open) closeCall(); return; }
      const m = incoming.find((x) => { try { return !sessionStorage.getItem('mt_declined_' + x.id); } catch { return true; } });
      if (!m) { if (open) closeCall(); return; }
      if (ctx.currentScreen && ctx.currentScreen() === 'meeting-room') { if (open) closeCall(); return; }
      if (!open || open.dataset.id !== m.id) showCall(m, ctx);
    } catch { /* tries again on the next check */ }
  }
  function watch(ctx) {
    if (watchTimer) clearInterval(watchTimer);
    pollCalls(ctx);
    watchTimer = setInterval(() => { if (!document.hidden || document.getElementById('mt-call')) pollCalls(ctx); }, 6000);
    if (!visBound) { visBound = true; document.addEventListener('visibilitychange', () => { if (!document.hidden) pollCalls(ctx); }); }
  }
  function unwatch() { if (watchTimer) { clearInterval(watchTimer); watchTimer = null; } closeCall(); }

  window.LZMeet = { watch, unwatch, meetingHome, schedulesPage, joinPage, openRoom, leaveRoom };
})();
