/* Screens shared by the Student app (/app) and the Schools app (/schools): Help & Support
   (tickets, live chat, rate the app), the AI-minutes coin wallet, and study-group polls.
   Each app hands in its own api(), esc() and toast() so sessions, token refresh and error
   handling stay exactly as the rest of that app does them. */
(function () {
  'use strict';

  const css = document.createElement('style');
  css.textContent = `
    .lzx-tabs { display: flex; gap: 6px; margin-bottom: 16px; flex-wrap: wrap; }
    .lzx-tab { border: 1.5px solid rgba(128,128,128,.35); background: transparent; color: inherit; padding: 8px 16px; border-radius: 999px; font: inherit; font-weight: 700; cursor: pointer; }
    .lzx-tab.on { background: #c1861f; border-color: #c1861f; color: #1b1406; }
    .lzx-thread { display: flex; flex-direction: column; gap: 8px; max-height: 52vh; overflow-y: auto; padding: 4px 2px; }
    .lzx-bubble { max-width: 82%; padding: 9px 13px; border-radius: 14px; white-space: pre-wrap; word-break: break-word; line-height: 1.45; border: 1px solid rgba(128,128,128,.3); }
    .lzx-bubble.me { align-self: flex-end; background: rgba(193,134,31,.18); }
    .lzx-bubble.them { align-self: flex-start; }
    .lzx-bubble small { display: block; opacity: .6; font-size: .72rem; margin-bottom: 2px; }
    .lzx-row { display: flex; gap: 8px; margin-top: 10px; }
    .lzx-row input { flex: 1; }
    .lzx-stars { display: flex; gap: 4px; font-size: 2rem; }
    .lzx-stars button { background: none; border: none; cursor: pointer; padding: 0 2px; color: rgba(128,128,128,.6); line-height: 1; }
    .lzx-stars button.on { color: #e3ac4c; }
    .lzx-pack { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 14px 0; border-top: 1px solid rgba(128,128,128,.25); }
    .lzx-pack:first-child { border-top: none; }
    .lzx-bar { height: 8px; border-radius: 4px; background: rgba(128,128,128,.25); overflow: hidden; margin-top: 4px; }
    .lzx-bar > div { height: 100%; background: #c1861f; }
    .lzx-seen { display: block; font-size: .7rem; opacity: .6; margin-top: 2px; }
    .lzx-optionbtn { display: block; width: 100%; text-align: left; margin-top: 6px; padding: 8px 12px; border-radius: 10px; border: 1.5px solid rgba(128,128,128,.35); background: transparent; color: inherit; font: inherit; cursor: pointer; position: relative; overflow: hidden; }
    .lzx-optionbtn.mine { border-color: #c1861f; }
    .lzx-optionbtn .fill { position: absolute; inset: 0 auto 0 0; background: rgba(193,134,31,.18); z-index: 0; }
    .lzx-optionbtn span { position: relative; z-index: 1; }
  `;
  document.head.appendChild(css);

  const fmt = (d) => new Date(d).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const naira = (kobo) => '₦' + (kobo / 100).toLocaleString('en-NG', { maximumFractionDigits: 0 });

  function tabs(host, esc, names, onPick) {
    host.innerHTML = '<div class="lzx-tabs">' + names.map(([k, label], i) => `<button class="lzx-tab${i === 0 ? ' on' : ''}" data-tab="${k}">${esc(label)}</button>`).join('') + '</div><div class="lzx-body"></div>';
    const body = host.querySelector('.lzx-body');
    let current = null;
    const pick = (k) => {
      current = k;
      host.querySelectorAll('.lzx-tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === k));
      onPick(k, body, () => current === k && body.isConnected);
    };
    host.querySelectorAll('.lzx-tab').forEach((t) => t.addEventListener('click', () => pick(t.dataset.tab)));
    pick(names[0][0]);
  }

  // ---------------------------------------------------------------- Help & Support
  function support(view, { api, esc, toast, tab }) {
    let timer = null;
    view.innerHTML = '<div class="page-head"><h1>Help &amp; Support</h1></div><div id="lzx-host"></div>';
    const order = [['tickets', 'My tickets'], ['chat', 'Live chat'], ['review', 'Rate Learnza']];
    if (tab) order.sort((a, b) => (b[0] === tab) - (a[0] === tab));
    tabs(view.querySelector('#lzx-host'), esc, order, (k, body, alive) => {
      clearInterval(timer);
      if (k === 'tickets') return ticketsTab(body, alive);
      if (k === 'chat') return chatTab(body, alive);
      return reviewTab(body);
    });
    // A badge on the Live chat tab when the team (or the assistant) has replied and it has not been read yet.
    api('/support/chat/unread').then(({ unread }) => {
      const t = view.querySelector('.lzx-tab[data-tab="chat"]');
      if (t && unread > 0 && !t.classList.contains('on')) t.textContent = 'Live chat (' + unread + ' new)';
    }).catch(() => {});

    async function ticketsTab(body, alive, openId) {
      const { tickets } = await api('/support/tickets');
      if (!alive()) return;
      body.innerHTML = `
        <div class="card" style="margin-bottom:16px;">
          <h3 style="margin-bottom:10px;">Ask for help</h3>
          <form id="lzx-new">
            <div class="field"><label>What is it about?</label><input id="lzx-subject" maxlength="120" required placeholder="e.g. My results are not showing"></div>
            <div class="field"><label>Type</label><select id="lzx-cat"><option value="GENERAL">General question</option><option value="BILLING">Payments &amp; subscription</option><option value="ACCOUNT">My account</option><option value="BUG">Something is broken</option><option value="OTHER">Other</option></select></div>
            <div class="field"><label>Tell us more</label><textarea id="lzx-text" rows="4" maxlength="3000" required></textarea></div>
            <button class="btn btn-primary" type="submit">Send to Learnza</button>
          </form>
        </div>
        <div class="card">${tickets.map((t) => `
          <div class="list-row" data-ticket="${t.id}" style="cursor:pointer;">
            <div><div style="font-weight:600;">${esc(t.subject)}</div><div class="meta">${esc(fmt(t.updatedAt))}</div></div>
            <span class="pill ${t.status === 'ANSWERED' ? 'pill-pass' : 'pill-muted'}">${t.status === 'ANSWERED' ? 'Replied' : t.status === 'OPEN' ? 'Waiting' : 'Closed'}</span>
          </div>`).join('') || '<p class="muted" style="padding:14px;">No tickets yet.</p>'}</div>`;
      body.querySelector('#lzx-new').addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const { ticket } = await api('/support/tickets', { method: 'POST', body: { subject: body.querySelector('#lzx-subject').value, category: body.querySelector('#lzx-cat').value, body: body.querySelector('#lzx-text').value } });
          toast('Sent — we will reply here.');
          openTicket(body, ticket.id, alive);
        } catch (err) { toast(err.message); }
      });
      body.querySelectorAll('[data-ticket]').forEach((row) => row.addEventListener('click', () => openTicket(body, row.dataset.ticket, alive)));
      if (openId) openTicket(body, openId, alive);
    }

    async function openTicket(body, id, alive) {
      const { ticket } = await api('/support/tickets/' + id);
      if (!alive()) return;
      body.innerHTML = `
        <button class="btn btn-ghost btn-sm" id="lzx-back" style="margin-bottom:12px;">← All tickets</button>
        <div class="card">
          <h3>${esc(ticket.subject)}</h3>
          <div class="meta" style="margin-bottom:12px;">${esc(ticket.status === 'CLOSED' ? 'Closed' : ticket.status === 'ANSWERED' ? 'Replied' : 'Waiting for a reply')}</div>
          <div class="lzx-thread">${ticket.messages.map((m) => `<div class="lzx-bubble ${m.fromStaff ? 'them' : 'me'}"><small>${m.fromStaff ? 'Learnza' : 'You'} · ${esc(fmt(m.createdAt))}</small>${esc(m.body)}</div>`).join('')}</div>
          ${ticket.status === 'CLOSED' ? '<p class="muted" style="margin-top:12px;">This ticket is closed. Open a new one if you still need help.</p>' : `
          <form class="lzx-row" id="lzx-reply"><input id="lzx-reply-text" placeholder="Write a reply…" required maxlength="3000" autocomplete="off"><button class="btn btn-primary" type="submit">Send</button></form>`}
        </div>`;
      body.querySelector('#lzx-back').addEventListener('click', () => ticketsTab(body, alive));
      const form = body.querySelector('#lzx-reply');
      if (form) form.addEventListener('submit', async (e) => {
        e.preventDefault();
        try { await api(`/support/tickets/${id}/messages`, { method: 'POST', body: { body: body.querySelector('#lzx-reply-text').value } }); openTicket(body, id, alive); } catch (err) { toast(err.message); }
      });
    }

    async function chatTab(body, alive) {
      body.innerHTML = `
        <div class="card">
          <div class="meta" id="lzx-who" style="margin-bottom:8px;">Chat with the Learnza assistant. A member of the team joins when it is needed.</div>
          <div class="lzx-thread" id="lzx-chat"></div>
          <form class="lzx-row" id="lzx-chat-form"><input id="lzx-chat-text" placeholder="Type a message…" required maxlength="1500" autocomplete="off"><button class="btn btn-primary" type="submit">Send</button></form>
        </div>`;
      const box = body.querySelector('#lzx-chat');
      let last = null;
      const seen = new Set();
      async function pull() {
        if (!alive()) return clearInterval(timer);
        const r = await api('/support/chat' + (last ? '?after=' + encodeURIComponent(last) : ''));
        let added = false;
        for (const m of r.messages) {
          if (seen.has(m.id)) continue;
          seen.add(m.id);
          last = m.createdAt;
          added = true;
          const mine = m.sender === 'USER';
          const who = mine ? 'You' : m.sender === 'AI' ? 'Learnza assistant' : 'Learnza team';
          box.insertAdjacentHTML('beforeend', `<div class="lzx-bubble ${mine ? 'me' : 'them'}"><small>${who} · ${esc(fmt(m.createdAt))}</small>${esc(m.body)}</div>`);
        }
        if (added) box.scrollTop = box.scrollHeight;
        body.querySelector('#lzx-who').textContent = r.withTeam ? 'You are chatting with the Learnza team.' : 'Chat with the Learnza assistant. A member of the team joins when it is needed.';
      }
      body.querySelector('#lzx-chat-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = body.querySelector('#lzx-chat-text');
        const text = input.value;
        input.value = '';
        try { await api('/support/chat', { method: 'POST', body: { body: text } }); await pull(); setTimeout(() => pull().catch(() => {}), 2500); } catch (err) { input.value = text; toast(err.message); }
      });
      await pull();
      timer = setInterval(() => pull().catch(() => {}), 5000);
    }

    async function reviewTab(body) {
      const { review } = await api('/support/review');
      let rating = review ? review.rating : 0;
      body.innerHTML = `
        <div class="card">
          <h3>How is Learnza working for you?</h3>
          <div class="lzx-stars" id="lzx-stars" style="margin:12px 0;">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-n="${n}" class="${n <= rating ? 'on' : ''}" aria-label="${n} star${n > 1 ? 's' : ''}">★</button>`).join('')}</div>
          <div class="field"><label>Anything you would like to add? (optional)</label><textarea id="lzx-comment" rows="3" maxlength="1000">${esc(review ? review.comment || '' : '')}</textarea></div>
          <button class="btn btn-primary" id="lzx-save-review">${review ? 'Update my review' : 'Submit review'}</button>
        </div>`;
      const stars = body.querySelectorAll('#lzx-stars button');
      stars.forEach((b) => b.addEventListener('click', () => { rating = Number(b.dataset.n); stars.forEach((s) => s.classList.toggle('on', Number(s.dataset.n) <= rating)); }));
      body.querySelector('#lzx-save-review').addEventListener('click', async () => {
        if (!rating) return toast('Tap a star first.');
        try { await api('/support/review', { method: 'PUT', body: { rating, comment: body.querySelector('#lzx-comment').value } }); toast('Thank you for your feedback!'); } catch (err) { toast(err.message); }
      });
    }
  }

  // ---------------------------------------------------------------- AI minutes & coins
  async function wallet(view, { api, esc, toast }) {
    const [w, sub] = await Promise.all([api('/coins'), api('/billing/status').catch(() => null)]);
    const providers = [];
    if (w.providers.paystack) providers.push(['paystack', 'Paystack']);
    if (w.providers.flutterwave) providers.push(['flutterwave', 'Flutterwave']);
    view.innerHTML = `
      <div class="page-head"><h1>AI Minutes &amp; Coins</h1></div>
      <div class="card" style="margin-bottom:16px;">
        <div class="meta">Coin balance</div>
        <div style="font-size:2.2rem;font-weight:800;">🪙 ${w.balance}</div>
        <div class="meta">${w.minutesLeft} minutes of live AI Teacher time in your wallet (1 coin = ${w.secondsPerCoin / 60} minutes)</div>
        <p class="muted" style="margin-top:10px;font-size:.85rem;">Your subscription already includes AI Teacher minutes each cycle. Coins are used only after those run out, so nothing is wasted.${sub && sub.enforced === false ? ' (The subscription paywall is currently off.)' : ''}</p>
      </div>
      <div class="card" style="margin-bottom:16px;">
        <h3 style="margin-bottom:6px;">Buy coins</h3>
        ${providers.length ? '' : '<p class="muted">Online payment is not set up yet. Please contact Learnza support to top up.</p>'}
        ${w.packs.map((p) => `
          <div class="lzx-pack"><div><div style="font-weight:700;">${esc(p.label)}</div><div class="meta">${p.minutes} minutes · ${naira(p.amountKobo)}</div></div>
          <div>${providers.map(([id, label]) => `<button class="btn btn-primary btn-sm" data-buy="${p.id}" data-provider="${id}" style="margin-left:6px;">${esc(label)}</button>`).join('')}</div></div>`).join('')}
      </div>
      <div class="card"><h3 style="margin-bottom:6px;">History</h3>
        ${w.ledger.map((e) => `<div class="list-row"><div><div style="font-weight:600;">${esc(e.reason === 'PURCHASE' ? 'Coins bought' : e.reason === 'AI_USAGE' ? 'Live AI Teacher' : e.reason === 'GRANT' ? 'Added by Learnza' : 'Adjustment')}</div><div class="meta">${esc(e.note || '')} · ${esc(fmt(e.createdAt))}</div></div><div style="font-weight:700;">${e.delta > 0 ? '+' : ''}${e.delta} 🪙</div></div>`).join('') || '<p class="muted" style="padding:10px;">Nothing yet.</p>'}
      </div>`;
    view.querySelectorAll('[data-buy]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const r = await api('/coins/checkout', { method: 'POST', body: { packId: b.dataset.buy, provider: b.dataset.provider } });
        try { localStorage.setItem('vp_pending_payment_ref', r.reference); } catch { /* private mode */ }
        window.location.href = r.checkoutUrl;
      } catch (err) { toast(err.message); b.disabled = false; }
    }));
  }

  // ---------------------------------------------------------------- study-group polls + seen
  function seenLabel(m, memberCount, mineId) {
    if (m.senderId !== mineId || m.deletedForEveryone || memberCount <= 1) return '';
    return `<span class="lzx-seen">${m.seenBy > 0 ? '✓✓ Seen by ' + m.seenBy + (m.seenBy >= memberCount - 1 ? ' (everyone)' : '') : '✓ Sent'}</span>`;
  }

  async function groupExtras({ api, esc, toast, groupId, view }) {
    api(`/groups/${groupId}/read`, { method: 'POST' }).catch(() => {});
    const host = document.createElement('div');
    host.className = 'card';
    host.style.marginTop = '16px';
    view.appendChild(host);

    async function draw() {
      const { polls } = await api(`/groups/${groupId}/polls`);
      host.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;"><h3>Polls</h3><button class="btn btn-ghost btn-sm" id="lzx-newpoll">+ New poll</button></div>
        <div id="lzx-pollform" hidden>
          <div class="field"><label>Question</label><input id="lzx-pq" maxlength="200" placeholder="e.g. Which day should we meet?"></div>
          <div class="field"><label>Options (one per line, 2 to 6)</label><textarea id="lzx-po" rows="3" placeholder="Monday&#10;Tuesday"></textarea></div>
          <button class="btn btn-primary btn-sm" id="lzx-postpoll">Post poll</button>
        </div>
        ${polls.map((p) => `
          <div style="margin:14px 0;padding-top:12px;border-top:1px solid rgba(128,128,128,.25);">
            <div style="font-weight:700;">${esc(p.question)}</div>
            <div class="meta">${esc(p.creator || '')} · ${p.totalVotes} vote${p.totalVotes === 1 ? '' : 's'}${p.closed ? ' · closed' : ''}</div>
            ${p.options.map((o, i) => `<button class="lzx-optionbtn ${p.myVote === i ? 'mine' : ''}" data-vote="${p.id}" data-idx="${i}" ${p.closed ? 'disabled' : ''}><div class="fill" style="width:${p.totalVotes ? Math.round(o.votes / p.totalVotes * 100) : 0}%"></div><span>${esc(o.label)} — ${o.votes}</span></button>`).join('')}
            ${p.mine && !p.closed ? `<button class="btn btn-ghost btn-sm" data-close-poll="${p.id}" style="margin-top:8px;">Close poll</button>` : ''}
          </div>`).join('') || '<p class="muted">No polls yet — start one to ask the group a quick question.</p>'}`;
      host.querySelector('#lzx-newpoll').addEventListener('click', () => { const f = host.querySelector('#lzx-pollform'); f.hidden = !f.hidden; });
      host.querySelector('#lzx-postpoll').addEventListener('click', async () => {
        try {
          await api(`/groups/${groupId}/polls`, { method: 'POST', body: { question: host.querySelector('#lzx-pq').value, options: host.querySelector('#lzx-po').value.split('\n') } });
          draw();
        } catch (err) { toast(err.message); }
      });
      host.querySelectorAll('[data-vote]').forEach((b) => b.addEventListener('click', async () => {
        try { await api(`/polls/${b.dataset.vote}/vote`, { method: 'POST', body: { optionIdx: Number(b.dataset.idx) } }); draw(); } catch (err) { toast(err.message); }
      }));
      host.querySelectorAll('[data-close-poll]').forEach((b) => b.addEventListener('click', async () => {
        try { await api(`/polls/${b.dataset.closePoll}/close`, { method: 'POST' }); draw(); } catch (err) { toast(err.message); }
      }));
    }
    await draw();
  }

  // ---------------------------------------------------------------- practice questions
  // Questions the platform owner curates in the admin panel. Pick a subject, answer a set,
  // then see the correct answers and explanations (grading happens on the server).
  async function practice(view, { api, esc, toast }) {
    const { subjects } = await api('/questions/subjects');
    view.innerHTML = `
      <div class="page-head"><h1>Practice Questions</h1></div>
      <div class="card">
        ${subjects.length ? `
        <div class="field"><label>Subject</label><select id="pq-subject">${subjects.map((x) => `<option value="${esc(x.subject)}">${esc(x.subject)} (${x.count})</option>`).join('')}</select></div>
        <div class="field"><label>How many questions?</label><select id="pq-count"><option>10</option><option>20</option><option>30</option></select></div>
        <button class="btn btn-primary" id="pq-start">Start practising</button>` : '<p class="muted">No practice questions have been added yet. Check back soon.</p>'}
      </div>`;
    const start = view.querySelector('#pq-start');
    if (!start) return;
    start.addEventListener('click', async () => {
      start.disabled = true;
      try {
        const subject = view.querySelector('#pq-subject').value;
        const { questions } = await api('/questions/practice?subject=' + encodeURIComponent(subject) + '&count=' + view.querySelector('#pq-count').value);
        quiz(subject, questions);
      } catch (err) { toast(err.message); start.disabled = false; }
    });

    function quiz(subject, questions) {
      const chosen = {};
      view.innerHTML = `
        <div class="page-head"><h1>${esc(subject)}</h1><button class="btn btn-ghost btn-sm" id="pq-quit">Quit</button></div>
        ${questions.map((q, i) => `
          <div class="card" style="margin-bottom:14px;">
            <div class="meta">Question ${i + 1} of ${questions.length}${q.year ? ' · ' + q.year : ''}${q.source ? ' · ' + esc(q.source) : ''}</div>
            <div style="font-weight:600;margin:6px 0 10px;white-space:pre-wrap;">${esc(q.text)}</div>
            ${q.options.map((o, k) => `<button class="lzx-optionbtn" data-q="${i}" data-k="${k}"><span>${'ABCDEF'[k]}. ${esc(o)}</span></button>`).join('')}
          </div>`).join('')}
        <button class="btn btn-primary" id="pq-submit">Submit answers</button>`;
      view.querySelector('#pq-quit').addEventListener('click', () => practice(view, { api, esc, toast }));
      view.querySelectorAll('.lzx-optionbtn').forEach((b) => b.addEventListener('click', () => {
        const qi = b.dataset.q;
        chosen[qi] = Number(b.dataset.k);
        view.querySelectorAll('.lzx-optionbtn[data-q="' + qi + '"]').forEach((x) => x.classList.toggle('mine', x === b));
      }));
      view.querySelector('#pq-submit').addEventListener('click', async () => {
        const unanswered = questions.length - Object.keys(chosen).length;
        if (unanswered && !confirm(unanswered + ' question' + (unanswered === 1 ? ' is' : 's are') + ' unanswered. Submit anyway?')) return;
        try {
          const r = await api('/questions/check', { method: 'POST', body: { answers: questions.map((q, i) => ({ id: q.id, choice: chosen[i] == null ? null : chosen[i] })) } });
          results(subject, r);
        } catch (err) { toast(err.message); }
      });
    }

    function results(subject, r) {
      view.innerHTML = `
        <div class="page-head"><h1>Your result</h1></div>
        <div class="card" style="margin-bottom:14px;text-align:center;">
          <div style="font-size:2.4rem;font-weight:800;">${r.score} / ${r.total}</div>
          <div class="meta">${Math.round((r.score / r.total) * 100)}% in ${esc(subject)}${r.points ? ' · +' + r.points + ' points' : ''}</div>
          <button class="btn btn-primary" id="pq-again" style="margin-top:12px;">Practise again</button>
        </div>
        ${r.review.map((q, i) => `
          <div class="card" style="margin-bottom:12px;border-left:4px solid ${q.correct ? '#1f8a5b' : '#c0392b'};">
            <div style="font-weight:600;white-space:pre-wrap;">${i + 1}. ${esc(q.text)}</div>
            ${q.options.map((o, k) => `<div style="margin-top:4px;${k === q.correctIndex ? 'font-weight:700;color:#1f8a5b;' : k === q.choice ? 'color:#c0392b;' : 'opacity:.75;'}">${'ABCDEF'[k]}. ${esc(o)}${k === q.correctIndex ? ' ✓' : k === q.choice ? ' ✗ (your answer)' : ''}</div>`).join('')}
            ${q.choice == null ? '<div class="meta" style="margin-top:6px;">You skipped this one.</div>' : ''}
            ${q.explanation ? `<div class="meta" style="margin-top:8px;">💡 ${esc(q.explanation)}</div>` : ''}
          </div>`).join('')}`;
      view.querySelector('#pq-again').addEventListener('click', () => practice(view, { api, esc, toast }));
    }
  }

  // ---------------------------------------------------------------- Digital ID
  // One card for every kind of account — student, independent learner, lecturer, non-academic
  // staff, school admin — same layout as PassNow's: role badge, photo (tap to add or change),
  // name, the facts we actually hold, and a QR code. Nothing is invented: a field we do not
  // have is left out. "Save as picture" draws the card straight to a PNG.
  const QR_LIB = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';
  const ROLE_LABEL = { STUDENT: 'Student', LECTURER: 'Lecturer', STAFF: 'Staff', ADMIN: 'School Admin' };
  let qrLoading = null;
  function loadQr() {
    if (window.qrcode) return Promise.resolve(window.qrcode);
    if (!qrLoading) qrLoading = new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = QR_LIB; el.onload = () => resolve(window.qrcode); el.onerror = () => { qrLoading = null; reject(new Error('qr')); };
      document.head.appendChild(el);
    });
    return qrLoading;
  }
  const initialsOf = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';
  function idNumber(u) {
    if (u.role === 'STUDENT' && u.matricNumber) return u.matricNumber;
    if (u.role !== 'STUDENT' && u.staffId) return u.staffId;
    return 'LZ-' + String(u.id || '').replace(/[^a-z0-9]/gi, '').slice(-8).toUpperCase();
  }
  function levelOf(u) { return u.yearOfStudy ? u.yearOfStudy * 100 + 'L' : ''; }
  function idFacts(u, ctx) {
    const f = [['ID No.', idNumber(u)]];
    const inst = (ctx.school && ctx.school.name) || u.attendedSchoolName || (u.schoolId ? '' : 'Independent learner');
    if (inst) f.push(['Institution', inst]);
    const dept = (ctx.department && ctx.department.name) || u.departmentName || u.attendedDepartment;
    if (dept) f.push(['Department', dept]);
    if (u.role === 'STUDENT' && levelOf(u)) f.push(['Level', levelOf(u)]);
    if (u.role === 'STUDENT' && u.courseOfStudy) f.push(['Programme', u.courseOfStudy]);
    if (u.role === 'STAFF' && u.position) f.push(['Position', u.position]);
    if (ctx.school && ctx.school.state) f.push(['State', ctx.school.state]);
    if (u.createdAt) f.push(['Member since', new Date(u.createdAt).getFullYear()]);
    return f;
  }
  function idSubLine(u, ctx) {
    const dept = (ctx.department && ctx.department.name) || u.departmentName || u.attendedDepartment;
    if (u.role === 'STUDENT') return [dept, levelOf(u)].filter(Boolean).join(' · ') || 'Learnza student';
    if (u.role === 'LECTURER') return dept ? 'Lecturer · ' + dept : 'Teaching staff';
    if (u.role === 'STAFF') return u.position || 'Non-academic staff';
    return 'School administration';
  }
  const qrText = (u) => 'LEARNZA|' + u.role + '|' + u.id + '|' + idNumber(u);

  // ctx: { user, school, department, api, esc, toast, photoPath, onUser, readOnly }
  //   photoPath  where a new photo is POSTed ('/auth/me/avatar' for your own card)
  //   onUser     called with the updated user after a photo is saved
  function digitalId(host, ctx) {
    const { esc, toast, api } = ctx;
    const u = ctx.user;
    const canPhoto = !!ctx.photoPath;
    host.innerHTML = `
      <div class="lzx-id" id="lzx-id-card">
        <div class="lzx-id-top"><div class="lzx-id-brand">Learn<b>za</b> · Digital ID</div><div class="lzx-id-role">${esc(ROLE_LABEL[u.role] || 'Member')}</div></div>
        <div class="lzx-id-mid">
          <div class="lzx-id-pic" ${canPhoto ? 'id="lzx-id-pic" title="Tap to add or change the photo"' : ''}>${u.avatarUrl ? `<img alt="" src="${esc(u.avatarUrl)}">` : esc(initialsOf(u.fullName))}${canPhoto ? '<span class="lzx-id-cam">📷</span>' : ''}</div>
          <div><div class="lzx-id-name">${esc(u.fullName)}</div><div class="lzx-id-sub">${esc(idSubLine(u, ctx))}</div></div>
        </div>
        <div class="lzx-id-grid">${idFacts(u, ctx).map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>
        <div class="lzx-id-qr" id="lzx-id-qr"></div>
      </div>
      <div class="lzx-id-foot"><button class="btn btn-ghost btn-sm" id="lzx-id-save">⬇ Save as picture</button><small>${canPhoto ? 'Tap the photo to add or change it. ' : ''}Show this ID or its QR code when asked.</small></div>`;

    loadQr().then((qrcode) => {
      const box = host.querySelector('#lzx-id-qr');
      if (!box) return;
      const q = qrcode(0, 'M'); q.addData(qrText(u)); q.make();
      box.innerHTML = q.createSvgTag({ cellSize: 3, margin: 0, scalable: true });
    }).catch(() => { const box = host.querySelector('#lzx-id-qr'); if (box) box.style.display = 'none'; });

    if (canPhoto) host.querySelector('#lzx-id-pic').addEventListener('click', (e) => {
      e.stopPropagation();
      const input = document.createElement('input');
      input.type = 'file'; input.accept = 'image/*'; input.hidden = true;
      document.body.appendChild(input);
      input.addEventListener('change', async () => {
        const file = input.files[0];
        input.remove();
        if (!file) return;
        try {
          const blob = await squarePhoto(file);
          const fd = new FormData();
          fd.append('avatar', blob, 'photo.jpg');
          const r = await api(ctx.photoPath, { method: 'POST', body: fd });
          if (r.user) { ctx.user = r.user; if (ctx.onUser) ctx.onUser(r.user); }
          toast('📸 Photo saved');
          digitalId(host, Object.assign({}, ctx, { user: r.user || u }));
        } catch (err) { toast(err.message || 'Could not use that photo.'); }
      });
      input.click();
    });
    host.querySelector('#lzx-id-save').addEventListener('click', () => saveCard(u, ctx).catch(() => toast('Could not save the picture.')));
  }

  // Crops to a centred square and shrinks, so the upload is small (the server accepts 5 MB).
  function squarePhoto(file) {
    return new Promise((resolve, reject) => {
      if (!file || !/^image\//.test(file.type)) return reject(new Error('Please choose an image file.'));
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const side = Math.min(img.width, img.height), out = Math.min(480, side);
        const c = document.createElement('canvas'); c.width = out; c.height = out;
        c.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, out, out);
        URL.revokeObjectURL(url);
        c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not read that photo.'))), 'image/jpeg', 0.86);
      };
      img.onerror = () => reject(new Error('Could not read that photo.'));
      img.src = url;
    });
  }

  // Draws the card to a PNG so it needs no extra library, and downloads it.
  async function saveCard(u, ctx) {
    const W = 1011, H = 638;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    const bg = g.createLinearGradient(0, 0, W, H); bg.addColorStop(0, '#0f1b2e'); bg.addColorStop(.55, '#16355c'); bg.addColorStop(1, '#5a3d0e');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    const stripe = g.createLinearGradient(0, 0, W, 0); stripe.addColorStop(0, '#e3ac4c'); stripe.addColorStop(.5, '#4a8cff'); stripe.addColorStop(1, '#e3ac4c');
    g.fillStyle = stripe; g.fillRect(0, H - 16, W, 16);
    g.fillStyle = '#fff'; g.font = '800 34px Sora, sans-serif'; g.fillText('Learn', 48, 74);
    const lw = g.measureText('Learn').width; g.fillStyle = '#e3ac4c'; g.fillText('za', 48 + lw, 74);
    g.fillStyle = '#fff'; g.font = '700 26px sans-serif'; g.fillText('Digital ID', 48 + lw + g.measureText('za').width + 18, 74);
    g.font = '800 22px sans-serif';
    const role = (ROLE_LABEL[u.role] || 'Member').toUpperCase(); const rw = g.measureText(role).width + 40;
    g.fillStyle = 'rgba(255,255,255,.16)'; g.beginPath(); if (g.roundRect) g.roundRect(W - 48 - rw, 38, rw, 46, 23); else g.rect(W - 48 - rw, 38, rw, 46); g.fill();
    g.fillStyle = '#fff'; g.fillText(role, W - 48 - rw + 20, 70);
    g.font = '800 46px Sora, sans-serif'; g.fillText(String(u.fullName || '').slice(0, 30), 270, 200);
    g.font = '600 26px sans-serif'; g.fillStyle = 'rgba(255,255,255,.75)'; g.fillText(idSubLine(u, ctx).slice(0, 44), 270, 246);
    let y = 380, col = 0;
    idFacts(u, ctx).forEach(([k, v]) => {
      const px = 48 + col * 330;
      g.fillStyle = 'rgba(255,255,255,.55)'; g.font = '700 18px sans-serif'; g.fillText(String(k).toUpperCase(), px, y);
      g.fillStyle = '#fff'; g.font = '700 26px sans-serif'; g.fillText(String(v).slice(0, 22), px, y + 34);
      col++; if (col === 2) { col = 0; y += 90; }
    });
    await new Promise((done) => {
      const initials = () => { g.fillStyle = '#c1861f'; g.fillRect(48, 130, 190, 190); g.fillStyle = '#fff'; g.font = '800 72px Sora, sans-serif'; g.textAlign = 'center'; g.fillText(initialsOf(u.fullName), 143, 252); g.textAlign = 'left'; };
      if (!u.avatarUrl) { initials(); return done(); }
      const im = new Image(); im.crossOrigin = 'anonymous';
      im.onload = () => { g.drawImage(im, 48, 130, 190, 190); done(); };
      im.onerror = () => { initials(); done(); };
      im.src = u.avatarUrl;
    });
    try {
      const qrcode = await loadQr();
      const q = qrcode(0, 'M'); q.addData(qrText(u)); q.make();
      const n = q.getModuleCount(), size = 190, cell = Math.floor(size / n), off = Math.floor((size - cell * n) / 2);
      g.fillStyle = '#fff'; g.fillRect(W - 48 - 214, H - 16 - 24 - 214, 214, 214);
      g.fillStyle = '#000';
      for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (q.isDark(r, k)) g.fillRect(W - 48 - 202 + off + k * cell, H - 16 - 24 - 202 + off + r * cell, cell, cell);
    } catch { /* offline: the card is still useful without the QR */ }
    const a = document.createElement('a');
    a.download = 'Learnza-ID-' + String(u.fullName || 'me').replace(/[^a-z0-9]+/gi, '-') + '.png';
    a.href = c.toDataURL('image/png');
    document.body.appendChild(a); a.click(); a.remove();
    ctx.toast('⬇ ID saved');
  }

  // ---------------------------------------------------------------- installable app (PWA)
  // Registers the service worker, shows a ribbon while offline, and — by checking
  // /version.json — offers a refresh when a new version has been deployed.
  function pwa() {
    const ribbon = document.createElement('div');
    ribbon.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;padding:10px 14px;text-align:center;font:600 14px system-ui,sans-serif;display:none;';
    document.body.appendChild(ribbon);
    function show(text, bg, fg, action) {
      ribbon.style.display = 'block';
      ribbon.style.background = bg;
      ribbon.style.color = fg;
      ribbon.textContent = text + ' ';
      if (action) {
        const b = document.createElement('button');
        b.textContent = action.label;
        b.style.cssText = 'margin-left:8px;padding:5px 12px;border-radius:8px;border:none;font-weight:700;cursor:pointer;background:#fff;color:#142033;';
        b.addEventListener('click', action.run);
        ribbon.appendChild(b);
      }
    }
    const hide = () => { ribbon.style.display = 'none'; };

    let updateReady = false;
    const refreshAction = { label: 'Refresh', run: () => window.location.reload() };
    function offlineState() {
      if (!navigator.onLine) show("You're offline — some things won't load until you're back online.", '#7a5410', '#fff');
      else if (updateReady) show('A new version of Learnza is ready.', '#142033', '#e3ac4c', refreshAction);
      else hide();
    }
    window.addEventListener('online', offlineState);
    window.addEventListener('offline', offlineState);
    offlineState();

    let known = null;
    async function checkVersion() {
      if (!navigator.onLine) return;
      try {
        const { version } = await (await fetch('/version.json', { cache: 'no-store' })).json();
        if (known === null) known = version;
        else if (version !== known) { updateReady = true; offlineState(); }
      } catch { /* try again next time */ }
    }
    checkVersion();
    setInterval(checkVersion, 5 * 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkVersion(); });

    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', pwa); else pwa();

  window.LZX = { support, wallet, groupExtras, seenLabel, practice, digitalId };
})();
