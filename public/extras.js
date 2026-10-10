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
    .lzx-pay [hidden] { display: none !important; }
    .lzx-card { padding: 14px 16px; }
    .lzx-hero { background: linear-gradient(135deg, #0f1b2e, #16355c); color: #fff; padding: 18px 20px; margin-bottom: 14px; }
    .lzx-hero .who { font-size: .85rem; color: rgba(255,255,255,.72); line-height: 1.5; }
    .lzx-hero .big { font: 800 2.1rem Sora, sans-serif; margin: 4px 0 2px; }
    .lzx-hero .sub { font-size: .85rem; color: rgba(255,255,255,.72); }
    .lzx-hero .bar { height: 8px; border-radius: 4px; background: rgba(255,255,255,.2); overflow: hidden; margin: 10px 0 6px; }
    .lzx-hero .bar > div { height: 100%; background: #35e08a; }
    .lzx-feerow { display: flex; gap: 12px; align-items: flex-start; padding: 14px 0; border-bottom: 1px solid rgba(128,128,128,.25); }
    .lzx-feerow:last-child { border-bottom: none; }
    .lzx-feerow input[type=checkbox] { width: 22px; height: 22px; margin: 1px 0 0; flex: 0 0 22px; }
    .lzx-feerow .mid { flex: 1; min-width: 0; }
    .lzx-feerow .t { font-weight: 700; line-height: 1.35; }
    .lzx-feerow .m { font-size: .82rem; opacity: .75; margin-top: 3px; line-height: 1.5; }
    .lzx-feerow .side { flex: 0 0 auto; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
    .lzx-fee-page { padding-bottom: 20px; }
    .lzx-paybar { position: sticky; bottom: 10px; z-index: 5; padding: 6px 0; }
    .lzx-paybar .btn { box-shadow: 0 8px 24px rgba(0,0,0,.25); }
    .lzx-sum { background: rgba(128,128,128,.12); border-radius: 12px; padding: 10px 12px; margin-bottom: 12px; font-size: .88rem; }
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
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        // Show it at once; the server's copy replaces it on the next poll (pull() de-duplicates by id).
        const mine = document.createElement('div');
        mine.className = 'lzx-bubble me';
        mine.innerHTML = '<small>You · sending…</small>' + esc(text);
        box.appendChild(mine);
        box.scrollTop = box.scrollHeight;
        try {
          await api('/support/chat', { method: 'POST', body: { body: text } });
          mine.remove();                   // pull() draws the saved message in its place
          await pull();
          setTimeout(() => pull().catch(() => {}), 2500);
        } catch (err) { mine.remove(); input.value = text; toast(err.message); }
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
  async function wallet(view, ctx) {
    const { api, esc, toast } = ctx;
    const [w, sub] = await Promise.all([api('/coins'), api('/billing/status').catch(() => null)]);
    view.innerHTML = `
      <div class="page-head"><h1>AI Minutes &amp; Coins</h1></div>
      <div class="card" style="margin-bottom:16px;">
        <div class="meta">Coin balance</div>
        <div style="font-size:2.2rem;font-weight:800;">🪙 ${w.balance}</div>
        <div class="meta">${w.minutesLeft} minute${w.minutesLeft === 1 ? '' : 's'} of live AI Lecturer time in your wallet (1 coin = 1 minute)</div>
        <p class="muted" style="margin-top:10px;font-size:.85rem;">Your subscription already includes AI Lecturer minutes each cycle. Coins are used only after those run out, so nothing is wasted.${sub && sub.enforced === false ? ' (The subscription paywall is currently off.)' : ''}</p>
      </div>
      ${w.pending.length ? `<div class="hint-box" style="margin-bottom:16px;">⏳ ${w.pending.length} bank-transfer purchase${w.pending.length === 1 ? ' is' : 's are'} waiting to be confirmed (${w.pending.map((p) => p.coins + ' coins').join(', ')}). Your coins appear as soon as it is.</div>` : ''}
      <div class="card" style="margin-bottom:16px;">
        <h3 style="margin-bottom:6px;">Buy coins</h3>
        ${w.packs.map((p) => `
          <div class="lzx-pack"><div><div style="font-weight:700;">${esc(p.label)}</div><div class="meta">${esc(p.blurb || p.minutes + ' minutes')} · ${naira(p.amountKobo)}</div></div>
          <button class="btn btn-primary btn-sm" data-buy="${p.id}">Buy</button></div>`).join('')}
      </div>
      <div class="card"><h3 style="margin-bottom:6px;">History</h3>
        ${w.ledger.map((e) => `<div class="list-row"><div><div style="font-weight:600;">${esc(e.reason === 'PURCHASE' ? 'Coins bought' : e.reason === 'AI_USAGE' ? 'Live AI Lecturer' : e.reason === 'GRANT' ? 'Added by Learnza' : 'Adjustment')}</div><div class="meta">${esc(e.note || '')} · ${esc(fmt(e.createdAt))}</div></div><div style="font-weight:700;">${e.delta > 0 ? '+' : ''}${e.delta} 🪙</div></div>`).join('') || '<p class="muted" style="padding:10px;">Nothing yet.</p>'}
      </div>`;
    view.querySelectorAll('[data-buy]').forEach((b) => b.addEventListener('click', () => {
      const pack = w.packs.find((p) => p.id === b.dataset.buy);
      pay(ctx, { kind: 'coins', packId: pack.id, title: pack.label, amountNaira: pack.amountKobo / 100, onDone: () => wallet(view, ctx) });
    }));
  }

  // ---------------------------------------------------------------- paying (subscriptions + coins)
  // Same two routes as PassNow: Flutterwave's popup (card, bank transfer, USSD, mobile money), or a
  // plain bank transfer / USSD that an admin confirms by hand. The price always comes from the
  // server; the browser only names the plan or pack.
  let payCfg = null;
  async function pay(ctx, opts) {
    const { api, esc, toast } = ctx;
    if (!payCfg) payCfg = await api('/billing/config');
    const cfg = payCfg;
    const amount = opts.amountNaira;
    const ussd = cfg.ussdTemplate.replace('{amount}', Math.round(amount));
    const overlay = document.createElement('div');
    overlay.className = 'lzx-pay-bg';
    overlay.innerHTML = `
      <div class="lzx-pay" role="dialog" aria-label="Choose payment method">
        <div class="lzx-pay-head"><button class="lzx-pay-x" id="lzx-pay-close" aria-label="Close">✕</button><div style="opacity:.6;font-size:12px;">${esc(opts.title)}</div><div style="font:800 30px Sora,sans-serif;">${naira(amount * 100)}</div></div>
        <div class="lzx-pay-body">
          <div style="font:700 15px Sora,sans-serif;margin-bottom:12px;">Choose payment method</div>
          ${cfg.flutterwavePublicKey ? `
          <button class="lzx-pay-fw" id="lzx-pay-fw"><span style="font-size:22px">🦋</span><div style="flex:1;text-align:left"><div style="font-weight:800;font-size:14px;">Pay with Flutterwave</div><div style="font-size:11px;opacity:.65;">Card, Bank, USSD, Mobile Money</div></div><span>→</span></button>` : ''}
          ${cfg.paystack ? `
          <button class="lzx-pay-fw lzx-pay-ps" id="lzx-pay-ps" style="${cfg.flutterwavePublicKey ? 'margin-top:10px;' : ''}"><span style="font-size:22px">💳</span><div style="flex:1;text-align:left"><div style="font-weight:800;font-size:14px;">Pay with Paystack</div><div style="font-size:11px;opacity:.65;">Card, Bank, USSD, Bank Transfer</div></div><span>→</span></button>` : ''}
          <div style="font:700 15px Sora,sans-serif;margin:${cfg.flutterwavePublicKey || cfg.paystack ? '18px' : '0'} 0 12px;">${cfg.flutterwavePublicKey || cfg.paystack ? 'Or pay directly' : 'Pay by bank transfer'}</div>
          <div class="lzx-pay-card">
            <div style="font-weight:800;font-size:13px;margin-bottom:8px;color:#1f8a5b;">🏦 Bank transfer</div>
            <div class="lzx-pay-row"><span>Bank</span><b>${esc(cfg.bank.bankName)}</b></div>
            <div class="lzx-pay-row"><span>Account name</span><b>${esc(cfg.bank.accountName)}</b></div>
            <div class="lzx-pay-row"><span>Account number</span><b>${esc(cfg.bank.accountNumber)}</b></div>
            <div class="lzx-pay-row"><span>Amount</span><b>${naira(amount * 100)}</b></div>
            <button class="btn btn-ghost btn-sm" id="lzx-pay-copy" style="width:100%;margin-top:10px;">📋 Copy account number</button>
            <button class="btn btn-primary btn-sm" id="lzx-pay-bank" style="width:100%;margin-top:8px;">✅ I've made the transfer</button>
          </div>
          <div class="lzx-pay-card">
            <div style="font-weight:800;font-size:13px;margin-bottom:8px;color:#2563d6;">📱 USSD (no internet needed)</div>
            <div style="font-size:13px;line-height:1.7;">Dial <b>${esc(ussd)}</b> on your phone (${esc(cfg.bank.bankName.split(' ')[0])} EazyBanking) and follow the prompts, then confirm below.</div>
            <button class="btn btn-primary btn-sm" id="lzx-pay-ussd" style="width:100%;margin-top:10px;">✅ I've completed the USSD payment</button>
          </div>
          <div class="muted" style="font-size:11px;text-align:center;line-height:1.6;">🔒 Payments are processed securely. Bank transfer / USSD payments are confirmed manually, usually within 24 hours.</div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('#lzx-pay-close').addEventListener('click', close);
    const done = () => { close(); if (opts.onDone) opts.onDone(); };

    overlay.querySelector('#lzx-pay-copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(cfg.bank.accountNumber); toast('📋 Account number copied'); } catch { toast('Account number: ' + cfg.bank.accountNumber); }
    });

    async function manual(method) {
      try {
        const body = opts.kind === 'coins' ? { packId: opts.packId, method } : { plan: opts.plan };
        const r = await api(opts.kind === 'coins' ? '/coins/manual' : '/billing/manual', { method: 'POST', body });
        toast('✅ ' + r.message);
        done();
      } catch (err) { toast(err.message); }
    }
    overlay.querySelector('#lzx-pay-bank').addEventListener('click', () => manual('BANK'));
    overlay.querySelector('#lzx-pay-ussd').addEventListener('click', () => manual('USSD'));

    // Paystack: the server prepares the checkout page; we go there and Paystack sends the browser
    // back here, where payReturn() confirms the payment.
    const psBtn = overlay.querySelector('#lzx-pay-ps');
    if (psBtn) psBtn.addEventListener('click', async () => {
      psBtn.disabled = true;
      try {
        const returnUrl = location.origin + location.pathname;
        const init = await api(opts.kind === 'coins' ? '/coins/initiate' : '/billing/initiate', { method: 'POST', body: Object.assign({ provider: 'PAYSTACK', returnUrl }, opts.kind === 'coins' ? { packId: opts.packId } : { plan: opts.plan }) });
        try { sessionStorage.setItem('lzx_pay', JSON.stringify({ ref: init.reference, kind: opts.kind === 'coins' ? 'coins' : 'plan' })); } catch { /* the return page also carries the reference */ }
        location.href = init.authorizationUrl;
      } catch (err) { psBtn.disabled = false; toast(err.message || 'Could not start the payment. Please try again.'); }
    });

    const fwBtn = overlay.querySelector('#lzx-pay-fw');
    if (fwBtn) fwBtn.addEventListener('click', async () => {
      fwBtn.disabled = true;
      try {
        await lib('flutterwave');
        const init = await api(opts.kind === 'coins' ? '/coins/initiate' : '/billing/initiate', { method: 'POST', body: opts.kind === 'coins' ? { packId: opts.packId } : { plan: opts.plan } });
        fwBtn.disabled = false;
        window.FlutterwaveCheckout({
          public_key: cfg.flutterwavePublicKey,
          tx_ref: init.reference,
          amount: init.amount,
          currency: 'NGN',
          payment_options: 'card,banktransfer,ussd,mobilemoney',
          customer: { email: init.email, name: init.name || 'Learnza student' },
          customizations: { title: 'Learnza ' + opts.title, description: opts.kind === 'coins' ? 'Coin purchase' : 'Subscription payment' },
          callback: async () => {
            // A popup "success" is not proof of payment: ask the server, which asks Flutterwave.
            try {
              const r = await api('/billing/verify/' + encodeURIComponent(init.reference));
              toast(r.status === 'SUCCESS' ? (opts.kind === 'coins' ? '✅ Coins added!' : '✅ Payment successful! Your plan is now active.') : 'Payment received — confirming with the provider, this can take a moment.');
            } catch { toast('Payment received — confirming with the provider, this can take a moment.'); }
            done();
          },
          onclose: () => toast('Payment window closed.'),
        });
      } catch (err) { fwBtn.disabled = false; toast(err.message || 'Could not start the payment. Please try again.'); }
    });
  }

  // Back from Paystack's checkout page (it adds ?reference=… to the address we gave it): confirm the
  // payment with the server and say what happened. Called by each app once it is signed in.
  let payReturned = false;
  async function payReturn({ api, toast, rerender }) {
    if (payReturned) return;
    let ref = null;
    try {
      const q = new URLSearchParams(location.search);
      ref = q.get('reference') || q.get('trxref');
      if (!ref) { const saved = JSON.parse(sessionStorage.getItem('lzx_pay') || 'null'); ref = saved && saved.ref; }
    } catch { /* storage may be blocked */ }
    if (!ref || !/^LZ-/.test(ref)) return;
    payReturned = true;
    try { sessionStorage.removeItem('lzx_pay'); history.replaceState(null, '', location.pathname + location.hash); } catch { /* ignore */ }
    try {
      const r = await api('/billing/verify/' + encodeURIComponent(ref));
      toast(r.status === 'SUCCESS' ? (r.kind === 'coins' ? '✅ Coins added!' : '✅ Payment successful! Your plan is now active.') : 'Payment received — confirming with Paystack, this can take a moment.');
      if (r.status === 'SUCCESS' && rerender) rerender();
    } catch { /* not our payment, or not signed in: nothing to report */ }
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

    // Everything the user does here shows on screen at once; the request follows in the
    // background and the screen only changes again if the server disagrees. (A slow or distant
    // connection should not make a tap feel like it did nothing.)
    let polls = [];
    let formOpen = false;
    const clone = (x) => JSON.parse(JSON.stringify(x));

    function applyVote(p, idx) {
      if (p.closed || p.myVote === idx) return;
      if (p.myVote == null) p.totalVotes += 1; else p.options[p.myVote].votes -= 1;
      p.options[idx].votes += 1;
      p.myVote = idx;
    }

    function paint() {
      const draft = { q: (host.querySelector('#lzx-pq') || {}).value || '', o: (host.querySelector('#lzx-po') || {}).value || '' };
      host.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;"><h3>Polls</h3><button class="btn btn-ghost btn-sm" id="lzx-newpoll">+ New poll</button></div>
        <div id="lzx-pollform" ${formOpen ? '' : 'hidden'}>
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
      host.querySelector('#lzx-pq').value = draft.q;
      host.querySelector('#lzx-po').value = draft.o;
      host.querySelector('#lzx-newpoll').addEventListener('click', () => { formOpen = !formOpen; host.querySelector('#lzx-pollform').hidden = !formOpen; });
      host.querySelector('#lzx-postpoll').addEventListener('click', async () => {
        const btn = host.querySelector('#lzx-postpoll');
        btn.disabled = true;
        try {
          const r = await api(`/groups/${groupId}/polls`, { method: 'POST', body: { question: host.querySelector('#lzx-pq').value, options: host.querySelector('#lzx-po').value.split('\n') } });
          polls.unshift(r.poll);
          formOpen = false;
          host.querySelector('#lzx-pq').value = ''; host.querySelector('#lzx-po').value = '';
          paint();
        } catch (err) { toast(err.message); btn.disabled = false; }
      });
      host.querySelectorAll('[data-vote]').forEach((b) => b.addEventListener('click', async () => {
        const p = polls.find((x) => x.id === b.dataset.vote);
        if (!p || p.closed) return;
        const before = clone(p);
        applyVote(p, Number(b.dataset.idx));
        paint();                      // instant
        try {
          const r = await api(`/polls/${p.id}/vote`, { method: 'POST', body: { optionIdx: Number(b.dataset.idx) } });
          Object.assign(p, r.poll);   // the server's numbers win (other people may have voted)
        } catch (err) {
          Object.assign(p, before);   // put it back
          toast(err.message);
        }
        paint();
      }));
      host.querySelectorAll('[data-close-poll]').forEach((b) => b.addEventListener('click', async () => {
        const p = polls.find((x) => x.id === b.dataset.closePoll);
        if (!p) return;
        p.closed = true;
        paint();
        try { Object.assign(p, (await api(`/polls/${p.id}/close`, { method: 'POST' })).poll); } catch (err) { p.closed = false; toast(err.message); }
        paint();
      }));
    }

    polls = (await api(`/groups/${groupId}/polls`)).polls;
    paint();
  }

  // ---------------------------------------------------------------- practice questions
  // Questions the platform owner curates in the admin panel. Pick a subject, answer a set,
  // then see the correct answers and explanations (grading happens on the server).
  async function practice(view, { api, esc, toast }) {
    const [{ subjects }, { courses }] = await Promise.all([api('/questions/subjects'), api('/questions/my-courses').catch(() => ({ courses: [] }))]);
    const mine = courses.filter((c) => c.count > 0);
    const preparing = courses.filter((c) => c.count === 0);
    view.innerHTML = `
      <div class="page-head"><h1>Practice Questions</h1></div>
      <div class="card">
        ${mine.length || subjects.length ? `
        <div class="field"><label>What would you like to practise?</label><select id="pq-subject">
          ${mine.length ? `<optgroup label="Your courses">${mine.map((c) => `<option value="${c.kind}:${esc(c.id)}">${esc(c.title)} (${c.count} questions)</option>`).join('')}</optgroup>` : ''}
          ${subjects.length ? `<optgroup label="General subjects">${subjects.map((x) => `<option value="subject:${esc(x.subject)}">${esc(x.subject)} (${x.count})</option>`).join('')}</optgroup>` : ''}
        </select></div>
        <div class="field"><label>How many questions?</label><select id="pq-count"><option value="10">10 (8 minutes)</option><option value="20" selected>20 (15 minutes)</option><option value="30">30 (23 minutes)</option></select><div class="meta" style="margin-top:4px;">A full practice set is 20 objective questions in 15 minutes. For theory questions, open a Past Questions or CBT Mock paper and take Section B.</div></div>
        <button class="btn btn-primary" id="pq-start">Start practising</button>` : '<p class="muted">No practice questions yet.</p>'}
        ${preparing.length ? `<p class="muted" style="margin-top:14px;font-size:.85rem;">⏳ Still being prepared for: ${preparing.map((c) => esc(c.title)).join(', ')}. This page updates when they are ready.</p>` : ''}
      </div>`;
    const start = view.querySelector('#pq-start');
    if (!start) return;
    start.addEventListener('click', async () => {
      start.disabled = true;
      try {
        const [kind, ...rest] = view.querySelector('#pq-subject').value.split(':');
        const id = rest.join(':');
        const q = kind === 'school' ? 'courseId=' + encodeURIComponent(id) : kind === 'self' ? 'individualCourseId=' + encodeURIComponent(id) : 'subject=' + encodeURIComponent(id);
        const { subject, questions } = await api('/questions/practice?' + q + '&count=' + view.querySelector('#pq-count').value);
        quiz(subject, questions);
      } catch (err) { toast(err.message); start.disabled = false; }
    });

    function quiz(subject, questions) {
      const chosen = {};
      // Same timing as every objective paper: 20 questions in 15 minutes.
      const minutes = Math.max(1, Math.ceil(questions.length * 0.75));
      const deadline = Date.now() + minutes * 60000;
      let ticker = null;
      const stop = () => { if (ticker) { clearInterval(ticker); ticker = null; } };
      view.innerHTML = `
        <div class="page-head"><h1>${esc(subject)}</h1><div style="display:flex;align-items:center;gap:10px;"><span class="pill pill-accent tabular" id="pq-clock">--:--</span><button class="btn btn-ghost btn-sm" id="pq-quit">Quit</button></div></div>
        <p class="meta" style="margin-bottom:10px;">${questions.length} objective question${questions.length === 1 ? '' : 's'} · ${minutes} minute${minutes === 1 ? '' : 's'} · submitted automatically when time is up</p>
        ${questions.map((q, i) => `
          <div class="card" style="margin-bottom:14px;">
            <div class="meta">Question ${i + 1} of ${questions.length}${q.year ? ' · ' + q.year : ''}${q.source ? ' · ' + esc(q.source) : ''}</div>
            <div style="font-weight:600;margin:6px 0 10px;white-space:pre-wrap;">${esc(q.text)}</div>
            ${q.options.map((o, k) => `<button class="lzx-optionbtn" data-q="${i}" data-k="${k}"><span>${'ABCDEF'[k]}. ${esc(o)}</span></button>`).join('')}
          </div>`).join('')}
        <button class="btn btn-primary" id="pq-submit">Submit answers</button>`;
      view.querySelector('#pq-quit').addEventListener('click', () => { stop(); practice(view, { api, esc, toast }); });
      const submit = async (auto) => {
        const unanswered = questions.length - Object.keys(chosen).length;
        if (!auto && unanswered && !confirm(unanswered + ' question' + (unanswered === 1 ? ' is' : 's are') + ' unanswered. Submit anyway?')) return;
        stop();
        try {
          const r = await api('/questions/check', { method: 'POST', body: { answers: questions.map((q, i) => ({ id: q.id, choice: chosen[i] == null ? null : chosen[i] })) } });
          results(subject, r);
        } catch (err) { toast(err.message); }
      };
      const clock = view.querySelector('#pq-clock');
      const tick = () => {
        const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
        if (clock) clock.textContent = String(Math.floor(left / 60)).padStart(2, '0') + ':' + String(left % 60).padStart(2, '0');
        if (!left) { stop(); toast("Time is up — submitting your answers."); submit(true); }
      };
      tick(); ticker = setInterval(tick, 1000);
      view.querySelectorAll('.lzx-optionbtn').forEach((b) => b.addEventListener('click', () => {
        const qi = b.dataset.q;
        chosen[qi] = Number(b.dataset.k);
        view.querySelectorAll('.lzx-optionbtn[data-q="' + qi + '"]').forEach((x) => x.classList.toggle('mine', x === b));
      }));
      view.querySelector('#pq-submit').addEventListener('click', () => submit(false));
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

  // ---------------------------------------------------------------- Daily Challenge
  // A short timed set from the question bank, one course at a time, every day. Answers are not shown until the set is
  // submitted; every right answer earns points and keeps the streak going.
  async function dailyChallenge(view, { api, esc, toast, navigate }) {
    const QN = 10;
    let d;
    try { d = await api('/questions/daily'); } catch (err) {
      view.innerHTML = '<div class="page-head"><h1>Daily Challenge</h1></div><div class="card" style="padding:18px;">' + esc(err.message) + '</div>';
      return;
    }
    const minutesFor = (n) => Math.max(1, Math.ceil(n * 0.75));
    const row = (c, i) => `<div class="pn-row" data-dc="${i}" style="cursor:pointer;"><div class="pn-ico">${c.done ? '✅' : '⚡'}</div><div class="pn-main"><div class="pn-t">${esc(c.title)}</div><div class="pn-s">${Math.min(QN, c.count)} questions · ${minutesFor(Math.min(QN, c.count))} min</div></div><div class="pn-d" style="font-weight:800;color:var(--ui-accent,#c1861f);">${c.done ? 'Done' : 'Start ›'}</div></div>`;

    function home() {
      const todo = d.sources.filter((c) => !c.done);
      view.innerHTML = `
        <div class="page-head"><h1>⚡ Daily Challenge</h1></div>
        <div class="pn-banner" style="cursor:default;"><div class="pn-banner-ico">⚡</div><div class="pn-banner-txt"><div class="pn-banner-t">Practise a little every day</div><div class="pn-banner-s">${QN} questions from each of your courses · +10 points for every right answer</div></div></div>
        <div class="sec"><div class="sh"><div class="st">Today</div><div class="sa" style="cursor:default;">${d.done} / ${d.goal} done</div></div>
          <div class="card pn-list">${d.sources.map(row).join('') || '<div class="pn-empty">There are no practice questions for your courses yet. Check back soon.</div>'}</div>
          ${d.sources.length && d.sources[0].kind === 'subject' ? '<div class="meta" style="margin-top:8px;">No questions have been written for your own courses yet, so these are general subjects.</div>' : ''}
        </div>
        ${todo.length ? `<button class="btn btn-primary" id="dc-go" style="width:100%;margin-bottom:18px;">Start with ${esc(todo[0].title)} →</button>` : (d.sources.length ? '<div class="card" style="padding:16px;text-align:center;margin-bottom:18px;">🎉 You have done every course today. Come back tomorrow to keep your streak.</div>' : '')}
        <div class="sec"><div class="sh"><div class="st">Recent results</div></div>
          <div class="card pn-list">${d.history.map((h) => `<div class="pn-row"><div class="pn-ico">📝</div><div class="pn-main"><div class="pn-t">${esc(h.title)}</div><div class="pn-s">${new Date(h.at).toLocaleString()}</div></div><div class="pn-d" style="font-weight:800;">${h.score}/${h.total}</div></div>`).join('') || '<div class="pn-empty">No challenges yet this week.</div>'}</div>
        </div>`;
      view.querySelectorAll('[data-dc]').forEach((r) => r.addEventListener('click', () => start(d.sources[Number(r.dataset.dc)])));
      const go = view.querySelector('#dc-go');
      if (go) go.addEventListener('click', () => start(todo[0]));
    }

    async function start(c) {
      if (!c) return;
      const key = c.kind === 'school' ? 'courseId' : c.kind === 'self' ? 'individualCourseId' : 'subject';
      let data;
      try { data = await api('/questions/practice?' + key + '=' + encodeURIComponent(c.id) + '&count=' + QN); } catch (err) { return toast(err.message); }
      run(c, data.questions);
    }

    function run(c, questions) {
      let i = 0;
      const chosen = [];
      const deadline = Date.now() + minutesFor(questions.length) * 60000;
      let ticker = null;
      const stop = () => { if (ticker) { clearInterval(ticker); ticker = null; } };
      const last = questions.length - 1;
      function paint() {
        const q = questions[i];
        view.innerHTML = `
          <div class="page-head"><h1>${esc(c.title)}</h1><span class="pill pill-accent tabular" id="dc-clock">--:--</span></div>
          <div class="pn-progress"><div style="width:${((i + 1) / questions.length) * 100}%"></div></div>
          <div class="meta" style="margin:8px 0;">Question ${i + 1} of ${questions.length}</div>
          <div class="card" style="padding:18px;margin-bottom:14px;"><div style="font:700 16px Sora,sans-serif;white-space:pre-wrap;line-height:1.5;">${esc(q.text)}</div></div>
          ${q.options.map((o, k) => `<div class="dc-opt${chosen[i] === k ? ' sel' : ''}" data-k="${k}"><div class="dc-l">${'ABCDEF'[k]}</div><div>${esc(o)}</div></div>`).join('')}
          <div style="display:flex;gap:10px;margin-top:6px;"><button class="btn btn-ghost" id="dc-prev" ${i ? '' : 'style="visibility:hidden;"'}>← Back</button><button class="btn btn-primary" id="dc-next" style="flex:1;">${i < last ? 'Next Question →' : 'Submit →'}</button></div>`;
        view.querySelectorAll('.dc-opt').forEach((o) => o.addEventListener('click', () => {
          chosen[i] = Number(o.dataset.k);
          view.querySelectorAll('.dc-opt').forEach((x) => x.classList.toggle('sel', x === o));
        }));
        view.querySelector('#dc-prev').addEventListener('click', () => { i -= 1; paint(); });
        view.querySelector('#dc-next').addEventListener('click', () => { if (i < last) { i += 1; paint(); } else submit(false); });
        tick();
      }
      function tick() {
        const clock = view.querySelector('#dc-clock');
        if (!clock) { stop(); return; }
        const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
        clock.textContent = String(Math.floor(left / 60)).padStart(2, '0') + ':' + String(left % 60).padStart(2, '0');
        if (left < 60) clock.style.background = '#ffe5e5';
        if (!left) { stop(); toast('Time is up — submitting your answers.'); submit(true); }
      }
      async function submit(auto) {
        const unanswered = questions.filter((_, k) => chosen[k] == null).length;
        if (!auto && unanswered && !confirm(unanswered + ' question' + (unanswered === 1 ? ' is' : 's are') + ' unanswered. Submit anyway?')) return;
        stop();
        try {
          const r = await api('/questions/check', { method: 'POST', body: { mode: 'daily', label: c.title, answers: questions.map((q, k) => ({ id: q.id, choice: chosen[k] == null ? null : chosen[k] })) } });
          results(r);
        } catch (err) { toast(err.message); }
      }
      function results(r) {
        c.done = true;
        d.done = d.sources.filter((x) => x.done).length;
        const next = d.sources.find((x) => !x.done);
        const pct = r.total ? Math.round((r.score / r.total) * 100) : 0;
        view.innerHTML = `
          <div class="page-head"><h1>Your result</h1></div>
          <div class="card" style="margin-bottom:14px;text-align:center;padding:22px;">
            <div style="font:800 40px Sora,sans-serif;">${r.score} / ${r.total}</div>
            <div class="meta" style="margin-top:4px;">${pct}% in ${esc(c.title)} ${pct >= 70 ? '🌟' : ''}${r.points ? ' · +' + r.points + ' points earned!' : ''}</div>
            <div style="display:flex;gap:10px;margin-top:16px;justify-content:center;flex-wrap:wrap;">
              ${next ? `<button class="btn btn-accent" id="dc-next-course">${esc(next.title)} →</button>` : ''}
              <button class="btn btn-primary" id="dc-home">Back Home</button>
            </div>
          </div>
          ${r.review.map((q, n) => `
            <div class="card" style="margin-bottom:12px;border-left:4px solid ${q.correct ? '#1f8a5b' : '#c0392b'};padding:16px;">
              <div style="font-weight:700;white-space:pre-wrap;">${n + 1}. ${esc(q.text)}</div>
              ${q.options.map((o, k) => `<div style="margin-top:4px;${k === q.correctIndex ? 'font-weight:700;color:#1f8a5b;' : k === q.choice ? 'color:#c0392b;' : 'opacity:.75;'}">${'ABCDEF'[k]}. ${esc(o)}${k === q.correctIndex ? ' ✓' : k === q.choice ? ' ✗ (your answer)' : ''}</div>`).join('')}
              ${q.choice == null ? '<div class="meta" style="margin-top:6px;">You skipped this one.</div>' : ''}
              ${q.explanation ? `<div class="meta" style="margin-top:8px;">💡 ${esc(q.explanation)}</div>` : ''}
            </div>`).join('')}`;
        const nb = view.querySelector('#dc-next-course');
        if (nb) nb.addEventListener('click', () => start(next));
        view.querySelector('#dc-home').addEventListener('click', () => navigate('my-dashboard'));
      }
      paint();
      ticker = setInterval(tick, 1000);
    }

    home();
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
  // The ID number belongs to the card and is never the matric number or the staff ID: those are shown on
  // their own lines.
  function idNumber(u) {
    return 'LZ-' + String(u.id || '').replace(/[^a-z0-9]/gi, '').slice(-8).toUpperCase();
  }
  function levelOf(u) { return u.yearOfStudy ? u.yearOfStudy * 100 + 'L' : ''; }
  function idFacts(u, ctx) {
    const f = [['ID No.', idNumber(u)]];
    if (u.role === 'STUDENT' && u.matricNumber) f.push(['Matric No.', u.matricNumber]);
    if (u.role !== 'STUDENT' && u.staffId) f.push(['Staff ID', u.staffId]);
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
    const bg = g.createLinearGradient(0, 0, W, H); bg.addColorStop(0, '#0b1423'); bg.addColorStop(.55, '#0f1b2e'); bg.addColorStop(1, '#1a2c47');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    const stripe = g.createLinearGradient(0, 0, W, 0); stripe.addColorStop(0, '#e3ac4c'); stripe.addColorStop(.5, '#f3d58c'); stripe.addColorStop(1, '#e3ac4c');
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
    let y = 342, col = 0;
    idFacts(u, ctx).forEach(([k, v]) => {
      const px = 48 + col * 330;
      g.fillStyle = 'rgba(255,255,255,.55)'; g.font = '700 18px sans-serif'; g.fillText(String(k).toUpperCase(), px, y);
      g.fillStyle = '#fff'; g.font = '700 26px sans-serif'; g.fillText(String(v).slice(0, 22), px, y + 34);
      col++; if (col === 2) { col = 0; y += 74; }
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

  // ---------------------------------------------------------------- elections
  // Voters (students and lecturers) see the elections open to them and vote once, in secret.
  // The school admin sets elections up (a student-union SUG election, or an election among
  // lecturers), opens and closes them, and watches each candidate's votes — with the split
  // between student and lecturer voters and who has turned out, but never who voted for whom.
  const stateLabel = { DRAFT: 'Draft', UPCOMING: 'Starts soon', OPEN: 'Voting open', CLOSED: 'Closed' };
  const statePill = (s) => (s === 'OPEN' ? 'pill-pass' : s === 'CLOSED' ? 'pill-muted' : 'pill-accent');
  const kindLabel = (k, courseName) => (k === 'CLASS_REP' ? 'Class representative' + (courseName ? ' · ' + courseName : '') : k === 'STUDENT_SUG' ? 'Student union (SUG)' : 'Lecturers\' election');
  // the admin's election calls, or the lecturer's class-representative ones
  const base = (ctx) => (ctx.mode === 'class' ? '/elections/class' : '/elections/manage');
  const votersLabel = (v) => ({ STUDENTS: 'students vote', LECTURERS: 'lecturers vote', BOTH: 'students and lecturers vote' }[v]);
  const when = (d) => (d ? fmt(d) : null);
  function candidateFace(esc, c, size) {
    const px = size || 44;
    return c.photoUrl
      ? `<img alt="" src="${esc(c.photoUrl)}" style="width:${px}px;height:${px}px;border-radius:50%;object-fit:cover;flex:0 0 ${px}px;">`
      : `<div style="width:${px}px;height:${px}px;border-radius:50%;background:linear-gradient(135deg,#e3ac4c,#c1861f);color:#1b1406;font-weight:800;display:flex;align-items:center;justify-content:center;flex:0 0 ${px}px;">${esc(initialsOf(c.name))}</div>`;
  }

  // ---- the dashboard banner: "N elections are waiting for your vote"
  async function electionBanner(view, { api, esc, go, role }) {
    let s;
    try { s = await api('/elections/summary'); } catch { return; }
    if (!view.isConnected) return;
    const old = view.querySelector('.lzx-election-banner');
    if (old) old.remove();
    if (!(s.pending > 0 || s.open > 0)) return;
    const el = document.createElement('div');
    el.className = 'hint-box lzx-election-banner';
    el.style.cssText = 'cursor:pointer;display:flex;align-items:center;gap:12px;margin-bottom:16px;';
    const admin = typeof s.pending === 'number' && s.pending === 0 && s.open > 0 && role === 'ADMIN';
    el.innerHTML = s.pending > 0
      ? `<span style="font-size:22px">🗳️</span><div style="flex:1;"><strong>${s.pending} election${s.pending === 1 ? ' is' : 's are'} waiting for your vote.</strong><div class="meta">Tap to vote — it takes a minute and your ballot is secret.</div></div><span>→</span>`
      : `<span style="font-size:22px">🗳️</span><div style="flex:1;"><strong>${s.open} election${s.open === 1 ? ' is' : 's are'} open for voting.</strong><div class="meta">${admin ? 'Tap to see the live count.' : 'You have already voted in every one.'}</div></div><span>→</span>`;
    el.addEventListener('click', () => go(role === 'ADMIN' ? 'admin-elections' : 'elections'));
    const head = view.querySelector('.page-head');
    if (head && head.parentNode === view) head.insertAdjacentElement('afterend', el); else view.insertBefore(el, view.firstChild);
  }

  // ---- voters
  async function elections(view, ctx) {
    const { api, esc, toast } = ctx;
    const { elections: list } = await api('/elections');
    view.innerHTML = `
      <div class="page-head"><h1>Elections</h1></div>
      ${list.length ? list.map((e) => `
        <div class="card lzx-card" style="margin-bottom:12px;cursor:pointer;" data-open="${e.id}">
          <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;">
            <div><div style="font-weight:700;font-size:1.05rem;">${esc(e.title)}</div><div class="meta">${esc(kindLabel(e.kind, e.courseName))}${e.closesAt ? ' · closes ' + esc(when(e.closesAt)) : ''}</div></div>
            <div style="text-align:right;"><span class="pill ${statePill(e.state)}">${stateLabel[e.state]}</span>${e.hasVoted ? '<div class="meta" style="margin-top:6px;">✓ You voted</div>' : e.state === 'OPEN' ? '<div class="meta" style="margin-top:6px;color:#c1861f;font-weight:700;">Vote now →</div>' : ''}</div>
          </div>
        </div>`).join('') : '<div class="card"><p class="muted">There are no elections for you right now. When your school opens one, you will be notified here.</p></div>'}`;
    view.querySelectorAll('[data-open]').forEach((c) => c.addEventListener('click', () => ballot(view, ctx, c.dataset.open)));
  }

  async function ballot(view, ctx, id) {
    const { api, esc, toast } = ctx;
    const d = await api('/elections/' + id);
    const e = d.election;
    const open = e.state === 'OPEN' && !e.hasVoted;
    view.innerHTML = `
      <div class="page-head"><h1>${esc(e.title)}</h1><button class="btn btn-ghost btn-sm" id="el-back">← All elections</button></div>
      ${e.description ? `<p class="muted" style="margin-bottom:14px;">${esc(e.description)}</p>` : ''}
      <div class="meta" style="margin-bottom:16px;">${esc(kindLabel(e.kind, e.courseName))} · ${esc(votersLabel(e.voters))}${e.closesAt ? ' · closes ' + esc(when(e.closesAt)) : ''} · <span class="pill ${statePill(e.state)}">${stateLabel[e.state]}</span></div>
      ${e.hasVoted ? '<div class="hint-box" style="margin-bottom:16px;">✅ Your vote has been counted. Thank you for taking part. Your ballot is secret — nobody can see who you voted for.</div>' : ''}
      ${e.state === 'UPCOMING' ? `<div class="hint-box" style="margin-bottom:16px;">Voting opens ${esc(when(e.opensAt) || 'soon')}.</div>` : ''}
      ${d.positions.map((p) => `
        <div class="card lzx-card" style="margin-bottom:14px;">
          <h3 style="margin-bottom:10px;">${esc(p.title)}</h3>
          ${p.candidates.map((c) => `
            <label class="lzx-cand" style="display:flex;gap:12px;align-items:flex-start;padding:10px;border:1.5px solid rgba(128,128,128,.3);border-radius:12px;margin-bottom:8px;${open ? 'cursor:pointer;' : 'opacity:.85;'}">
              ${open ? `<input type="radio" name="pos-${p.id}" value="${c.id}" style="margin-top:14px;">` : ''}
              ${candidateFace(esc, c)}
              <div><div style="font-weight:700;">${esc(c.name)}</div>${c.manifesto ? `<div class="meta" style="white-space:pre-wrap;">${esc(c.manifesto)}</div>` : ''}</div>
            </label>`).join('')}
          ${open ? `<button class="btn btn-ghost btn-sm" data-clear="${p.id}">Clear my choice</button>` : ''}
        </div>`).join('')}
      ${open ? '<button class="btn btn-primary" id="el-cast">Cast my vote</button><p class="muted" style="font-size:.8rem;margin-top:8px;">You can skip a position. Once you cast your vote it cannot be changed.</p>' : ''}
      ${d.results ? resultsHtml(esc, d.results, null) : ''}`;
    view.querySelector('#el-back').addEventListener('click', () => elections(view, ctx));
    view.querySelectorAll('[data-clear]').forEach((b) => b.addEventListener('click', () => view.querySelectorAll(`input[name="pos-${b.dataset.clear}"]`).forEach((r) => { r.checked = false; })));
    const cast = view.querySelector('#el-cast');
    if (cast) cast.addEventListener('click', async () => {
      const choices = d.positions.map((p) => { const r = view.querySelector(`input[name="pos-${p.id}"]:checked`); return r ? { positionId: p.id, candidateId: r.value } : null; }).filter(Boolean);
      if (!choices.length) return toast('Pick at least one candidate.');
      const skipped = d.positions.length - choices.length;
      if (!confirm(`Cast your vote${skipped ? ` (skipping ${skipped} position${skipped === 1 ? '' : 's'})` : ''}? You cannot change it afterwards.`)) return;
      cast.disabled = true;
      try { await api(`/elections/${id}/vote`, { method: 'POST', body: { choices } }); toast('🗳️ Vote counted — thank you!'); ballot(view, ctx, id); } catch (err) { toast(err.message); cast.disabled = false; }
    });
  }

  // ---- results (used by both the admin and, once allowed, voters)
  function resultsHtml(esc, positions, turn) {
    return `
      <h2 style="margin:22px 0 10px;font-size:1.1rem;">Results</h2>
      ${turn ? `<div class="grid-cards" style="margin-bottom:16px;">${Object.entries(turn).map(([g, t]) => `<div class="card course-card"><div class="code">${t.voted} / ${t.eligible}</div><div class="meta">${g === 'students' ? 'Students' : 'Lecturers'} voted${t.eligible ? ' (' + Math.round(t.voted / t.eligible * 100) + '%)' : ''}</div></div>`).join('')}</div>` : ''}
      ${positions.map((p) => `
        <div class="card lzx-card" style="margin-bottom:14px;">
          <div style="display:flex;justify-content:space-between;"><h3>${esc(p.title)}</h3><span class="meta">${p.totalVotes} vote${p.totalVotes === 1 ? '' : 's'}${p.tied ? ' · tie for the lead' : ''}</span></div>
          ${p.candidates.map((c) => `
            <div style="margin-top:12px;">
              <div style="display:flex;align-items:center;gap:10px;">
                ${candidateFace(esc, c, 34)}
                <div style="flex:1;"><div style="font-weight:700;">${c.leading ? '👑 ' : ''}${esc(c.name)}</div>
                  ${turn ? `<div class="meta">${c.byStudents} from students · ${c.byLecturers} from lecturers</div>` : ''}</div>
                <div style="text-align:right;font-weight:800;">${c.votes}<div class="meta" style="font-weight:500;">${c.percent}%</div></div>
              </div>
              <div class="lzx-bar"><div style="width:${c.percent}%"></div></div>
            </div>`).join('')}
        </div>`).join('')}`;
  }

  // ---- the school admin
  async function electionsAdmin(view, ctx) {
    const { api, esc, toast } = ctx;
    const { elections: list } = await api(base(ctx) + '');
    view.innerHTML = `
      <div class="page-head"><h1>${ctx.mode === 'class' ? 'Class Rep Voting' : 'Elections'}</h1><button class="btn btn-accent btn-sm" id="el-new">+ ${ctx.mode === 'class' ? 'New class rep vote' : 'New election'}</button></div>
      <p class="muted" style="margin-bottom:16px;">${ctx.mode === 'class' ? 'Choose one of your courses and add the students standing for class representative. Only the students enrolled in that course can vote. They are told when you open it, vote once, and the ballot is secret — you see each candidate\'s votes and who has turned out, never who voted for whom.' : 'Run a student union (SUG) election or an election among lecturers. Voters get a notification when you open it, vote once, and the ballot is secret — you see each candidate\'s votes and who has turned out, never who voted for whom.'}</p>
      ${list.length ? list.map((e) => `
        <div class="card lzx-card" style="margin-bottom:12px;">
          <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;">
            <div><div style="font-weight:700;font-size:1.05rem;">${esc(e.title)}</div><div class="meta">${esc(kindLabel(e.kind, e.courseName))} · ${esc(votersLabel(e.voters))} · ${e.positions} position${e.positions === 1 ? '' : 's'} · ${e.ballots} ballot${e.ballots === 1 ? '' : 's'} cast${e.closesAt ? ' · closes ' + esc(when(e.closesAt)) : ''}</div></div>
            <div><span class="pill ${statePill(e.state)}">${stateLabel[e.state]}</span></div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">
            ${e.state === 'DRAFT' ? `<button class="btn btn-ghost btn-sm" data-edit="${e.id}">✏️ Edit</button><button class="btn btn-primary btn-sm" data-open="${e.id}">▶ Open voting</button><button class="btn btn-ghost btn-sm" data-del="${e.id}">Delete</button>` : ''}
            ${e.state !== 'DRAFT' ? `<button class="btn btn-primary btn-sm" data-results="${e.id}">📊 View votes</button>` : ''}
            ${e.state === 'OPEN' || e.state === 'UPCOMING' ? `<button class="btn btn-ghost btn-sm" data-close="${e.id}">⏹ Close voting</button>` : ''}
          </div>
        </div>`).join('') : `<div class="card"><p class="muted">Nothing here yet. Start one with “${ctx.mode === 'class' ? 'New class rep vote' : 'New election'}”.</p></div>`}`;
    view.querySelector('#el-new').addEventListener('click', () => electionForm(view, ctx, null));
    const act = (sel, fn) => view.querySelectorAll(sel).forEach((b) => b.addEventListener('click', () => fn(b)));
    act('[data-edit]', (b) => electionForm(view, ctx, b.dataset.edit));
    act('[data-results]', (b) => electionResults(view, ctx, b.dataset.results));
    act('[data-open]', async (b) => {
      if (!confirm('Open voting now? Everyone who can vote is notified straight away. After this the election can no longer be edited.')) return;
      try { const r = await api(`${base(ctx)}/${b.dataset.open}/open`, { method: 'POST' }); toast(`Voting is open — ${r.notified} people notified`); electionsAdmin(view, ctx); } catch (err) { toast(err.message); }
    });
    act('[data-close]', async (b) => {
      if (!confirm('Close voting now? Nobody can vote after this.')) return;
      try { await api(`${base(ctx)}/${b.dataset.close}/close`, { method: 'POST' }); toast('Voting closed'); electionsAdmin(view, ctx); } catch (err) { toast(err.message); }
    });
    act('[data-del]', async (b) => {
      if (!confirm('Delete this draft election?')) return;
      try { await api(`${base(ctx)}/${b.dataset.del}`, { method: 'DELETE' }); electionsAdmin(view, ctx); } catch (err) { toast(err.message); }
    });
  }

  async function electionResults(view, ctx, id) {
    const { api, esc, toast } = ctx;
    const d = await api(`${base(ctx)}/${id}/results`);
    const e = d.election;
    view.innerHTML = `
      <div class="page-head"><h1>${esc(e.title)}</h1><button class="btn btn-ghost btn-sm" id="el-back">← Elections</button></div>
      <div class="meta" style="margin-bottom:12px;">${esc(kindLabel(e.kind, e.courseName))} · ${esc(votersLabel(e.voters))} · <span class="pill ${statePill(e.state)}">${stateLabel[e.state]}</span></div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:6px;">
        <label style="display:flex;gap:8px;align-items:center;font-weight:500;"><input type="checkbox" id="el-vis" ${e.resultsVisible ? 'checked' : ''}> Let voters see the result once voting closes</label>
        <button class="btn btn-ghost btn-sm" id="el-refresh">↻ Refresh count</button>
      </div>
      ${resultsHtml(esc, d.positions, d.turnout)}
      <h3 style="margin:22px 0 8px;">Who has voted (${d.voted.length})</h3>
      <p class="muted" style="font-size:.85rem;margin-bottom:8px;">This list shows that a person voted, not what they chose.</p>
      <div class="card" style="max-height:340px;overflow:auto;">${d.voted.map((v) => `<div class="list-row"><div><div style="font-weight:600;">${esc(v.name)}</div><div class="meta">${esc(v.idNumber || '')} · ${v.role === 'STUDENT' ? 'Student' : 'Lecturer'}</div></div><div class="meta">${esc(fmt(v.at))}</div></div>`).join('') || '<p class="muted" style="padding:12px;">Nobody has voted yet.</p>'}</div>`;
    view.querySelector('#el-back').addEventListener('click', () => electionsAdmin(view, ctx));
    view.querySelector('#el-refresh').addEventListener('click', () => electionResults(view, ctx, id));
    view.querySelector('#el-vis').addEventListener('change', async (ev) => {
      try { await api(`${base(ctx)}/${id}/results-visible`, { method: 'POST', body: { visible: ev.target.checked } }); toast(ev.target.checked ? 'Voters will see the result' : 'Result hidden from voters'); } catch (err) { toast(err.message); }
    });
  }

  async function electionForm(view, ctx, editId) {
    const { api, esc, toast } = ctx;
    const classMode = ctx.mode === 'class';
    let courses = [];
    if (classMode) courses = (await api('/elections/class/courses')).courses;
    let model = classMode
      ? { title: '', description: '', kind: 'CLASS_REP', voters: 'STUDENTS', courseId: courses.length === 1 ? courses[0].id : '', opensAt: '', closesAt: '', resultsVisible: false, positions: [{ title: 'Class Representative', candidates: [] }] }
      : { title: '', description: '', kind: 'STUDENT_SUG', voters: 'STUDENTS', opensAt: '', closesAt: '', resultsVisible: false, positions: [{ title: '', candidates: [] }] };
    if (editId) {
      const d = await api(base(ctx) + '/' + editId);
      const e = d.election;
      const local = (x) => (x ? new Date(new Date(x).getTime() - new Date(x).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
      model = { title: e.title, description: e.description || '', kind: e.kind, voters: e.voters, courseId: e.courseId || '', opensAt: local(e.opensAt), closesAt: local(e.closesAt), resultsVisible: e.resultsVisible, positions: d.positions.map((p) => ({ title: p.title, candidates: p.candidates.map((c) => ({ userId: c.userId, name: c.name, manifesto: c.manifesto || '' })) })) };
    }
    function draw() {
      view.innerHTML = `
        <div class="page-head"><h1>${editId ? (classMode ? 'Edit class rep vote' : 'Edit election') : (classMode ? 'New class rep vote' : 'New election')}</h1><button class="btn btn-ghost btn-sm" id="ef-cancel">Cancel</button></div>
        <div class="card lzx-card" style="margin-bottom:14px;">
          <div class="field"><label>Title</label><input id="ef-title" maxlength="120" value="${esc(model.title)}" placeholder="${classMode ? 'e.g. Class Rep — CSC 201' : 'e.g. SUG Election 2026/2027'}"></div>
          <div class="field"><label>Description (optional)</label><textarea id="ef-desc" rows="2" maxlength="600">${esc(model.description)}</textarea></div>
          ${classMode
            ? `<div class="field"><label>Which course is voting?</label><select id="ef-course"><option value="">Choose a course…</option>${courses.map((c) => `<option value="${c.id}" ${c.id === model.courseId ? 'selected' : ''}>${esc(c.code)} — ${esc(c.title)} (${c.students} student${c.students === 1 ? '' : 's'})</option>`).join('')}</select>${courses.length ? '' : '<div class="meta" style="color:#b45309;margin-top:4px;">You are not assigned to a course yet. Ask your school admin to assign you one.</div>'}<div class="meta" style="margin-top:4px;">Only the students enrolled in this course can stand and vote.</div></div>`
            : `<div class="field"><label>Who is standing?</label><select id="ef-kind"><option value="STUDENT_SUG" ${model.kind === 'STUDENT_SUG' ? 'selected' : ''}>Students — student union (SUG) election</option><option value="LECTURER" ${model.kind === 'LECTURER' ? 'selected' : ''}>Lecturers — lecturers' election</option></select></div>
          <div class="field"><label>Who votes?</label><select id="ef-voters"><option value="STUDENTS" ${model.voters === 'STUDENTS' ? 'selected' : ''}>Students</option><option value="LECTURERS" ${model.voters === 'LECTURERS' ? 'selected' : ''}>Lecturers</option><option value="BOTH" ${model.voters === 'BOTH' ? 'selected' : ''}>Students and lecturers</option></select></div>`}
          <div class="field"><label>Voting opens (optional — leave empty to start when you press Open)</label><input id="ef-opens" type="datetime-local" value="${esc(model.opensAt)}"></div>
          <div class="field"><label>Voting closes (optional — leave empty to close it yourself)</label><input id="ef-closes" type="datetime-local" value="${esc(model.closesAt)}"></div>
          <label style="display:flex;gap:8px;align-items:center;font-weight:500;"><input type="checkbox" id="ef-vis" ${model.resultsVisible ? 'checked' : ''}> Let voters see the result once voting closes</label>
        </div>
        ${model.positions.map((p, pi) => `
          <div class="card lzx-card" style="margin-bottom:12px;" data-pos="${pi}">
            <div style="display:flex;gap:8px;"><input class="ef-ptitle" data-pi="${pi}" value="${esc(p.title)}" placeholder="Position, e.g. President" maxlength="80" style="flex:1;font-weight:700;">${model.positions.length > 1 ? `<button class="btn btn-ghost btn-sm" data-delpos="${pi}">Remove position</button>` : ''}</div>
            ${p.candidates.map((c, ci) => `
              <div style="margin-top:10px;padding:10px;border:1px solid rgba(128,128,128,.3);border-radius:10px;">
                <div style="display:flex;gap:8px;align-items:center;"><input class="ef-cname" data-pi="${pi}" data-ci="${ci}" value="${esc(c.name)}" placeholder="Candidate name" maxlength="100" style="flex:1;" ${c.userId ? 'readonly title="Picked from your school directory"' : ''}><button class="btn btn-ghost btn-sm" data-delcand="${pi}:${ci}">✕</button></div>
                <textarea class="ef-cman" data-pi="${pi}" data-ci="${ci}" rows="2" placeholder="Manifesto / short bio (optional)" maxlength="600" style="width:100%;margin-top:6px;">${esc(c.manifesto || '')}</textarea>
              </div>`).join('')}
            <div style="margin-top:10px;position:relative;">
              <input class="ef-find" data-pi="${pi}" placeholder="🔎 ${classMode ? 'Add a candidate from the course (search by name or ID)…' : 'Add a candidate from your school (search by name or ID)…'}" style="width:100%;">
              <div class="ef-found" data-found="${pi}" style="position:absolute;left:0;right:0;z-index:20;background:var(--paper-raised,#fff);color:var(--ink,#142033);border:1px solid rgba(128,128,128,.4);border-radius:10px;max-height:220px;overflow:auto;" hidden></div>
            </div>
            <button class="btn btn-ghost btn-sm" data-addname="${pi}" style="margin-top:8px;">+ Add a candidate by name</button>
          </div>`).join('')}
        <button class="btn btn-ghost" id="ef-addpos" style="margin-bottom:16px;">+ Add another position</button>
        <div style="display:flex;gap:10px;"><button class="btn btn-primary" id="ef-save">Save election</button></div>`;
      wire();
    }
    function readForm() {
      model.title = view.querySelector('#ef-title').value; model.description = view.querySelector('#ef-desc').value;
      if (classMode) model.courseId = view.querySelector('#ef-course').value; else { model.kind = view.querySelector('#ef-kind').value; model.voters = view.querySelector('#ef-voters').value; }
      model.opensAt = view.querySelector('#ef-opens').value; model.closesAt = view.querySelector('#ef-closes').value;
      model.resultsVisible = view.querySelector('#ef-vis').checked;
      view.querySelectorAll('.ef-ptitle').forEach((i) => { model.positions[i.dataset.pi].title = i.value; });
      view.querySelectorAll('.ef-cname').forEach((i) => { model.positions[i.dataset.pi].candidates[i.dataset.ci].name = i.value; });
      view.querySelectorAll('.ef-cman').forEach((i) => { model.positions[i.dataset.pi].candidates[i.dataset.ci].manifesto = i.value; });
    }
    function wire() {
      view.querySelector('#ef-cancel').addEventListener('click', () => electionsAdmin(view, ctx));
      if (classMode) view.querySelector('#ef-course').addEventListener('change', () => { readForm(); model.positions.forEach((p) => { p.candidates = p.candidates.filter((c) => !c.userId); }); draw(); });
      else view.querySelector('#ef-kind').addEventListener('change', (e) => {
        readForm();
        // picking the kind sets the natural voters; candidates picked for the other kind no longer fit
        model.voters = e.target.value === 'STUDENT_SUG' ? 'STUDENTS' : 'LECTURERS';
        model.positions.forEach((p) => { p.candidates = p.candidates.filter((c) => !c.userId); });
        draw();
      });
      view.querySelector('#ef-addpos').addEventListener('click', () => { readForm(); model.positions.push({ title: '', candidates: [] }); draw(); });
      view.querySelectorAll('[data-delpos]').forEach((b) => b.addEventListener('click', () => { readForm(); model.positions.splice(Number(b.dataset.delpos), 1); draw(); }));
      view.querySelectorAll('[data-delcand]').forEach((b) => b.addEventListener('click', () => { readForm(); const [p, c] = b.dataset.delcand.split(':').map(Number); model.positions[p].candidates.splice(c, 1); draw(); }));
      view.querySelectorAll('[data-addname]').forEach((b) => b.addEventListener('click', () => { readForm(); model.positions[Number(b.dataset.addname)].candidates.push({ userId: null, name: '', manifesto: '' }); draw(); }));
      let timer;
      view.querySelectorAll('.ef-find').forEach((input) => input.addEventListener('input', () => {
        clearTimeout(timer);
        const box = view.querySelector(`[data-found="${input.dataset.pi}"]`);
        const q = input.value.trim();
        if (q.length < 2) { box.hidden = true; return; }
        if (classMode && !model.courseId) { toast('Choose the course first.'); input.value = ''; return; }
        timer = setTimeout(async () => {
          try {
            const { people } = await api(`${base(ctx)}/candidates?${classMode ? 'courseId=' + encodeURIComponent(model.courseId) : 'kind=' + model.kind}&q=${encodeURIComponent(q)}`);
            box.innerHTML = people.map((p) => `<div class="list-row" data-pick="${p.id}" style="cursor:pointer;padding:8px 12px;"><div><div style="font-weight:600;">${esc(p.name)}</div><div class="meta">${esc(p.detail)}</div></div></div>`).join('') || '<p class="muted" style="padding:10px;">Nobody matches.</p>';
            box.hidden = false;
            box.querySelectorAll('[data-pick]').forEach((row) => row.addEventListener('click', () => {
              const person = people.find((x) => x.id === row.dataset.pick);
              readForm();
              const list = model.positions[Number(input.dataset.pi)].candidates;
              if (list.some((c) => c.userId === person.id)) return toast('Already added to this position.');
              list.push({ userId: person.id, name: person.name, manifesto: '' });
              draw();
            }));
          } catch (err) { toast(err.message); }
        }, 250);
      }));
      view.querySelector('#ef-save').addEventListener('click', async () => {
        readForm();
        const body = {
          title: model.title, description: model.description, kind: model.kind, voters: model.voters, courseId: classMode ? model.courseId : undefined, resultsVisible: model.resultsVisible,
          opensAt: model.opensAt ? new Date(model.opensAt).toISOString() : null, closesAt: model.closesAt ? new Date(model.closesAt).toISOString() : null,
          positions: model.positions.map((p) => ({ title: p.title, candidates: p.candidates.map((c) => ({ userId: c.userId || undefined, name: c.name, manifesto: c.manifesto })) })),
        };
        try {
          await api(editId ? base(ctx) + '/' + editId : base(ctx) + '', { method: editId ? 'PUT' : 'POST', body });
          toast(classMode ? 'Saved — open the vote when you are ready.' : 'Election saved — open it when you are ready.');
          electionsAdmin(view, ctx);
        } catch (err) { toast(err.message); }
      });
    }
    draw();
  }

  // ---------------------------------------------------------------- school fees
  // Students see the fees for their level and department, the school's own bank details, and what is paid
  // and owing; they transfer to the school's account and tell the school (the school confirms, with a receipt).
  // The school admin sets the bank details and fees, confirms payments, records cash, and sees who has paid.
  const FEE_CHIP = { PAID: ['pill-pass', 'Paid ✓'], PARTIAL: ['pill-accent', 'Part paid'], PENDING: ['pill-muted', 'Awaiting school'], UNPAID: ['pill-danger', 'Unpaid'], NO_FEES: ['pill-muted', 'No fees'] };
  const FEE_PAY = { CONFIRMED: ['pill-pass', 'Confirmed'], PENDING: ['pill-muted', 'Waiting'], REJECTED: ['pill-danger', 'Not accepted'] };
  const toKobo = (t) => { const n = parseFloat(String(t).replace(/[₦,\s]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) : NaN; };
  const money = (kobo) => '₦' + (Number(kobo || 0) / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 });
  const onDate = (d) => (d ? new Date(d).toLocaleDateString([], { dateStyle: 'medium' }) : '');
  const methodLabel = (p) => String(p.method).replace('_', ' ').toLowerCase();

  function feeModal(html) {
    const bg = document.createElement('div');
    bg.className = 'lzx-pay-bg';
    bg.innerHTML = '<div class="lzx-pay" role="dialog"><div class="lzx-pay-body">' + html + '</div></div>';
    document.body.appendChild(bg);
    const close = () => bg.remove();
    bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
    return { el: bg.firstElementChild, close };
  }
  // a receipt photo is cropped down so it is quick to send
  function shrinkPhoto(file) {
    return new Promise((resolve, reject) => {
      if (!file) return resolve(null);
      if (!/^image\//.test(file.type)) return reject(new Error('The receipt must be a photo.'));
      const img = new Image(), url = URL.createObjectURL(file);
      img.onload = () => {
        const k = Math.min(1, 1000 / Math.max(img.width, img.height)), c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.72));
      };
      img.onerror = () => reject(new Error('Could not read that photo.'));
      img.src = url;
    });
  }
  const receiptHtml = (esc, d, p) => {
    const status = { CONFIRMED: '✅ Confirmed by the school', PENDING: '⏳ Waiting for the school to confirm', REJECTED: '❌ Not accepted by the school' }[p.status];
    return `<div id="lzx-receipt"><div style="text-align:center;margin-bottom:10px;"><div style="font:800 17px Sora,sans-serif;">${esc(d.school.name)}</div><div class="meta">Fee payment ${p.receiptNo ? 'receipt' : 'record'}</div></div>
      <div style="font-size:.88rem;line-height:1.7;"><div><b>Student:</b> ${esc(d.student.name)}${d.student.matricNumber ? ' (' + esc(d.student.matricNumber) + ')' : ''}</div>${p.receiptNo ? `<div><b>Receipt no:</b> ${esc(p.receiptNo)}</div>` : ''}<div><b>Date:</b> ${esc(onDate(p.paidOn || p.createdAt))}</div><div><b>Method:</b> ${esc(methodLabel(p))}</div>${p.reference ? `<div><b>Reference:</b> ${esc(p.reference)}</div>` : ''}${p.depositorName ? `<div><b>Paid by:</b> ${esc(p.depositorName)}</div>` : ''}</div>
      <div style="border-top:1px dashed rgba(128,128,128,.5);border-bottom:1px dashed rgba(128,128,128,.5);margin:10px 0;padding:8px 0;">${p.items.map((i) => `<div style="display:flex;justify-content:space-between;gap:10px;padding:3px 0;"><span>${esc(i.title)}</span><b>${money(i.amountKobo)}</b></div>`).join('')}<div style="display:flex;justify-content:space-between;border-top:1px solid rgba(128,128,128,.3);margin-top:6px;padding-top:6px;"><b>Total</b><b>${money(p.amountKobo)}</b></div></div>
      <div style="text-align:center;font-weight:800;">${status}</div>${p.rejectReason ? `<div style="text-align:center;color:#b42318;margin-top:4px;">${esc(p.rejectReason)}</div>` : ''}</div>`;
  };
  function printReceipt() {
    const el = document.getElementById('lzx-receipt'); if (!el) return;
    const w = window.open('', '_blank'); if (!w) return;
    w.document.write('<!doctype html><title>Receipt</title><body style="font-family:system-ui,sans-serif;max-width:420px;margin:24px auto">' + el.innerHTML + '</body>');
    w.document.close(); w.focus(); setTimeout(() => w.print(), 250);
  }

  // ---- the student
  async function feesStudent(view, ctx) {
    const { api, esc, toast } = ctx;
    const d = await api('/fees/mine');
    const cat = {}; d.categories.forEach((c) => { cat[c.id] = c; });
    const sel = {}; const others = [];
    const t = d.totals, pct = t.dueKobo ? Math.min(100, Math.round((t.paidKobo / t.dueKobo) * 100)) : 0;
    const picked = () => Object.keys(sel).reduce((a, k) => a + sel[k], 0) + others.reduce((a, o) => a + o.amountKobo, 0);
    const count = () => Object.keys(sel).length + others.length;
    const itemsPayload = () => Object.keys(sel).map((id) => ({ feeId: id, amountKobo: sel[id] })).concat(others.map((o) => ({ title: o.title, amountKobo: o.amountKobo })));
    const itemsShown = () => Object.keys(sel).map((id) => { const f = d.fees.find((x) => x.id === id); return { title: f.title, amountKobo: sel[id] }; }).concat(others.map((o) => ({ title: o.title, amountKobo: o.amountKobo })));

    function paint() {
      const feeRow = (f) => {
        const open = f.balanceKobo > 0, on = sel[f.id] != null, chip = FEE_CHIP[f.status];
        const meta = [f.semester, f.session, f.dueDate ? 'due ' + onDate(f.dueDate) : null].filter(Boolean).map(esc).join(' · ');
        return `<div class="lzx-feerow">
          ${open ? `<input type="checkbox" data-sel="${f.id}" ${on ? 'checked' : ''} aria-label="Pay ${esc(f.title)}">` : '<span style="width:22px;flex:0 0 22px;"></span>'}
          <div class="mid"><div class="t">${(cat[f.category] || cat.OTHER).icon} ${esc(f.title)}</div>${meta ? `<div class="m">${meta}</div>` : ''}
            <div class="m">${money(f.amountKobo)}${f.paidKobo && open ? ' · paid ' + money(f.paidKobo) + ' · owing ' + money(f.balanceKobo) : ''}</div>
            ${on ? `<div style="margin-top:8px;display:flex;align-items:center;gap:6px;"><span class="m" style="margin:0;">Paying now ₦</span><input data-amt="${f.id}" value="${sel[f.id] / 100}" inputmode="decimal" style="width:130px;text-align:right;padding:6px 8px;"></div>` : ''}</div>
          <div class="side"><span class="pill ${chip[0]}">${chip[1]}</span></div></div>`;
      };
      view.innerHTML = `<div id="fee-root" class="lzx-fee-page">
        <div class="page-head"><h1>School Fees</h1></div>
        <div class="card lzx-hero">
          <div class="who">${esc(d.school.name)}${d.student.department ? ' · ' + esc(d.student.department) : ''}${d.student.level ? ' · ' + esc(d.student.level) : ''}</div>
          <div class="big">${money(t.balanceKobo)}</div><div class="sub">still to pay of ${money(t.dueKobo)}</div>
          <div class="bar"><div style="width:${pct}%"></div></div>
          <div class="sub">${money(t.paidKobo)} paid${t.pendingKobo ? ' · ' + money(t.pendingKobo) + ' waiting for the school to confirm' : ''}</div></div>
        ${d.bank ? `<div class="hint-box lzx-card" style="margin:0 0 14px;"><strong>🏦 The school's account</strong><div style="margin-top:4px;">${esc(d.bank.bankName)} · ${esc(d.bank.accountName)}</div><div style="font:800 1.35rem Sora,sans-serif;letter-spacing:1px;margin:2px 0;">${esc(d.bank.accountNumber)}</div>${d.bank.instructions ? `<div class="meta">${esc(d.bank.instructions)}</div>` : ''}<button class="btn btn-ghost btn-sm" id="fee-copy" style="margin-top:10px;">📋 Copy account number</button></div>`
          : '<div class="hint-box lzx-card" style="margin:0 0 14px;"><strong>The school has not added its bank details yet.</strong> Ask the bursary. You can still see what is owed below.</div>'}
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;"><h3 style="flex:1;margin:0;">Your fees</h3>${d.fees.some((f) => f.balanceKobo > 0) ? '<button class="btn btn-ghost btn-sm" id="fee-all">Select all unpaid</button>' : ''}</div>
        <div class="card lzx-card" style="margin-bottom:12px;">
          ${d.fees.map(feeRow).join('')}
          ${others.map((o, i) => `<div class="lzx-feerow"><span style="width:22px;flex:0 0 22px;"></span><div class="mid"><div class="t">➕ ${esc(o.title)}</div><div class="m">Other fee · ${money(o.amountKobo)}</div></div><div class="side"><button class="btn btn-ghost btn-sm" data-rmother="${i}">Remove</button></div></div>`).join('')}
          ${!d.fees.length && !others.length ? '<p class="muted" style="padding:6px 0;">The school has not listed any fee for your level and department yet. Use <b>Other fees</b> below to choose what you are paying for.</p>' : ''}
        </div>
        <button class="btn btn-ghost" id="fee-other" style="width:100%;margin-bottom:12px;">➕ Other fees — choose from the list</button>
        <div class="lzx-paybar"><button class="btn btn-primary" id="fee-pay" style="width:100%;" ${count() ? '' : 'disabled'}>${count() ? 'Pay ' + money(picked()) + ' (' + count() + ' item' + (count() === 1 ? '' : 's') + ')' : 'Tick the fees you are paying'}</button></div>
        ${d.payments.length ? `<h3 style="margin:22px 0 8px;">🧾 Your payments</h3><div class="card lzx-card">${d.payments.map((p) => `<div class="lzx-feerow" data-receipt="${p.id}" style="cursor:pointer;"><div class="mid"><div class="t">${money(p.amountKobo)}</div><div class="m">${esc(p.items.map((i) => i.title).join(', ').slice(0, 90))} · ${esc(onDate(p.createdAt))}</div>${p.status === 'REJECTED' && p.rejectReason ? `<div class="m" style="color:#b42318;">${esc(p.rejectReason)}</div>` : ''}</div><div class="side"><span class="pill ${FEE_PAY[p.status][0]}">${FEE_PAY[p.status][1]}</span></div></div>`).join('')}</div>` : ''}</div>`;
      wire();
    }
    function wire() {
      const copy = view.querySelector('#fee-copy');
      if (copy) copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(d.bank.accountNumber); toast('📋 Account number copied'); } catch { toast('Account number: ' + d.bank.accountNumber); } });
      view.querySelectorAll('[data-sel]').forEach((c) => c.addEventListener('change', () => { const f = d.fees.find((x) => x.id === c.dataset.sel); if (c.checked) sel[f.id] = f.balanceKobo; else delete sel[f.id]; paint(); }));
      view.querySelectorAll('[data-amt]').forEach((i) => i.addEventListener('input', () => {
        const f = d.fees.find((x) => x.id === i.dataset.amt), k = toKobo(i.value);
        if (!Number.isFinite(k) || k < 100) return;
        sel[f.id] = Math.min(k, f.balanceKobo);
        const b = view.querySelector('#fee-pay'); b.textContent = 'Pay ' + money(picked()) + ' (' + count() + ' item' + (count() === 1 ? '' : 's') + ')';
      }));
      view.querySelectorAll('[data-rmother]').forEach((b) => b.addEventListener('click', () => { others.splice(Number(b.dataset.rmother), 1); paint(); }));
      const all = view.querySelector('#fee-all');
      if (all) all.addEventListener('click', () => { d.fees.forEach((f) => { if (f.balanceKobo > 0) sel[f.id] = f.balanceKobo; }); paint(); });
      view.querySelector('#fee-other').addEventListener('click', otherForm);
      view.querySelector('#fee-pay').addEventListener('click', openPay);
      view.querySelectorAll('[data-receipt]').forEach((r) => r.addEventListener('click', () => {
        const p = d.payments.find((x) => x.id === r.dataset.receipt);
        const m = feeModal(receiptHtml(esc, d, p) + '<button class="btn btn-primary" id="rc-print" style="width:100%;margin-top:14px;">🖨 Print / save</button><button class="btn btn-ghost" id="rc-close" style="width:100%;margin-top:8px;">Close</button>');
        m.el.querySelector('#rc-print').addEventListener('click', printReceipt); m.el.querySelector('#rc-close').addEventListener('click', m.close);
      }));
    }
    // "Other fees": pick what the payment is for from the same list of fee types the school uses. Only
    // "Something else" asks for a short description.
    function otherForm() {
      const kinds = d.categories.filter((c) => c.id !== 'OTHER');
      const m = feeModal(`<h3 style="margin-bottom:4px;">➕ Other fees</h3><p class="meta" style="margin-bottom:12px;">For anything you need to pay that is not ticked above. Choose what it is for.</p>
        <div class="field"><label>What is it for?</label><select id="of-kind">${kinds.map((c) => `<option value="${c.id}">${c.icon} ${esc(c.label)}</option>`).join('')}<option value="__other">➕ Something else (describe it)</option></select></div>
        <div class="field" id="of-text-box" hidden><label>Describe it</label><input id="of-t" maxlength="120" placeholder="e.g. Replacement ID card"></div>
        <div class="field"><label>Amount (₦)</label><input id="of-a" inputmode="decimal" placeholder="e.g. 2000"></div>
        <button class="btn btn-primary" id="of-add" style="width:100%;">Add to my payment</button><button class="btn btn-ghost" id="of-x" style="width:100%;margin-top:8px;">Cancel</button>`);
      const q = (s) => m.el.querySelector(s);
      q('#of-x').addEventListener('click', m.close);
      q('#of-kind').addEventListener('change', () => { q('#of-text-box').hidden = q('#of-kind').value !== '__other'; });
      q('#of-add').addEventListener('click', () => {
        const kind = q('#of-kind').value, k = toKobo(q('#of-a').value);
        const title = kind === '__other' ? q('#of-t').value.trim() : (cat[kind] || {}).label;
        if (!title) return toast('Say what the fee is for.');
        if (!Number.isFinite(k) || k < 100) return toast('Enter the amount in naira.');
        others.push({ title, amountKobo: k }); m.close(); paint();
      });
    }
    function openPay() {
      if (!count()) return;
      const items = itemsShown(), total = picked(), today = new Date().toISOString().slice(0, 10);
      const m = feeModal(`<h3 style="margin-bottom:8px;">Tell the school you have paid</h3>
        <div class="lzx-sum">${items.map((i) => `<div style="display:flex;justify-content:space-between;gap:10px;padding:3px 0;"><span>${esc(i.title)}</span><b>${money(i.amountKobo)}</b></div>`).join('')}<div style="display:flex;justify-content:space-between;border-top:1px solid rgba(128,128,128,.3);margin-top:6px;padding-top:6px;"><b>Total</b><b>${money(total)}</b></div></div>
        ${d.bank ? `<div class="lzx-pay-card"><div class="meta">Pay ${money(total)} to ${esc(d.bank.bankName)} · ${esc(d.bank.accountName)}</div><div style="font:800 1.3rem Sora,sans-serif;letter-spacing:1px;">${esc(d.bank.accountNumber)}</div></div>` : ''}
        <p class="meta" style="margin-bottom:10px;">Make the transfer first, then fill this in. The school checks its bank statement and confirms your payment; you will get a receipt.</p>
        <div class="field"><label>Transfer reference / teller number</label><input id="fp-ref" maxlength="80" placeholder="From your bank app or teller"></div>
        <div class="field"><label>Name on the transfer</label><input id="fp-dep" maxlength="100" placeholder="Who sent the money"></div>
        <div class="field"><label>Date paid</label><input id="fp-date" type="date" value="${today}" max="${today}"></div>
        <div class="field"><label>Photo of the receipt (optional)</label><input id="fp-proof" type="file" accept="image/*"></div>
        <div class="field"><label>Note (optional)</label><input id="fp-note" maxlength="300"></div>
        <button class="btn btn-primary" id="fp-go" style="width:100%;">✅ I have paid ${money(total)}</button><button class="btn btn-ghost" id="fp-x" style="width:100%;margin-top:8px;">Cancel</button>`);
      const q = (s) => m.el.querySelector(s);
      q('#fp-x').addEventListener('click', m.close);
      q('#fp-go').addEventListener('click', async () => {
        const btn = q('#fp-go'); btn.disabled = true; btn.textContent = 'Sending…';
        try {
          const proof = await shrinkPhoto(q('#fp-proof').files[0]);
          await api('/fees/pay', { method: 'POST', body: { items: itemsPayload(), reference: q('#fp-ref').value, depositorName: q('#fp-dep').value, paidOn: q('#fp-date').value || null, note: q('#fp-note').value, proofUrl: proof || undefined } });
          m.close(); toast('✅ Sent. The school will confirm it and you will get a receipt.'); feesStudent(view, ctx);
        } catch (err) { btn.disabled = false; btn.textContent = 'Try again'; toast(err.message || 'Could not send that.'); }
      });
    }
    paint();
  }

  // ---- the school admin
  async function feesAdmin(view, ctx) {
    const { api, esc, toast } = ctx;
    const ov = await api('/fees/admin/overview');
    view.innerHTML = '<div class="page-head"><h1>Fee Payment</h1></div><div id="fa-sum"></div><div id="fa-tabs"></div>';
    const sum = view.querySelector('#fa-sum');
    const drawSummary = (o) => {
      sum.innerHTML = `<div class="grid-cards" style="margin-bottom:14px;">
        <div class="card course-card"><div class="code">${money(o.totals.collectedKobo)}</div><div class="meta">Collected</div></div>
        <div class="card course-card"><div class="code">${money(o.totals.balanceKobo)}</div><div class="meta">Still owing</div></div>
        <div class="card course-card"><div class="code">${o.pendingPayments}</div><div class="meta">Payments to confirm</div></div>
        <div class="card course-card"><div class="code">${o.students.paid}/${o.students.total}</div><div class="meta">Students fully paid</div></div></div>
        ${!o.hasBank ? '<div class="hint-box" style="margin-bottom:14px;"><strong>Add your institution\'s bank details first.</strong> Open the “Bank details” tab. Only your own students see them.</div>' : ''}`;
    };
    drawSummary(ov);
    const state = { status: 'PENDING', q: '', sq: '' };
    // a school with no bank details yet starts on that tab
    const names = ov.hasBank ? [['payments', 'Payments'], ['students', 'Who has paid'], ['fees', 'Fees'], ['bank', 'Bank details']] : [['bank', 'Bank details'], ['payments', 'Payments'], ['students', 'Who has paid'], ['fees', 'Fees']];
    tabs(view.querySelector('#fa-tabs'), esc, names, async (tab, body, alive) => {
      const refresh = async () => { try { drawSummary(await api('/fees/admin/overview')); } catch { /* keep the old numbers */ } };
      if (tab === 'payments') await paymentsTab(body, alive, refresh);
      else if (tab === 'students') await studentsTab(body, alive, refresh);
      else if (tab === 'fees') await feesTab(body, alive);
      else await bankTab(body, alive, refresh);
    });

    async function paymentsTab(body, alive, refresh) {
      body.innerHTML = `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;">${[['PENDING', 'Waiting'], ['CONFIRMED', 'Confirmed'], ['REJECTED', 'Rejected'], ['ALL', 'All']].map(([k, l]) => `<button class="lzx-tab${state.status === k ? ' on' : ''}" data-st="${k}">${l}</button>`).join('')}</div><input id="fa-q" placeholder="Search student name…" value="${esc(state.q)}" style="width:100%;margin-bottom:10px;"><div id="fa-list"></div>`;
      body.querySelectorAll('[data-st]').forEach((b) => b.addEventListener('click', () => { state.status = b.dataset.st; paymentsTab(body, alive, refresh); }));
      let timer; body.querySelector('#fa-q').addEventListener('input', (e) => { clearTimeout(timer); timer = setTimeout(() => { state.q = e.target.value.trim(); drawList(); }, 300); });
      const list = body.querySelector('#fa-list');
      async function drawList() {
        const d = await api('/fees/admin/payments?status=' + (state.status === 'ALL' ? '' : state.status) + '&q=' + encodeURIComponent(state.q));
        if (!alive()) return;
        list.innerHTML = d.payments.length ? d.payments.map((p) => `<div class="card" style="margin-bottom:8px;padding:12px 14px;">
          <div style="display:flex;gap:10px;align-items:flex-start;"><div style="flex:1;min-width:0;"><div style="font-weight:800;">${esc(p.studentName)} <span class="meta">${esc([p.department, p.level].filter(Boolean).join(' · '))}</span></div>
          <div class="meta">${esc(p.items.map((i) => i.title + ' ' + money(i.amountKobo)).join(' · '))}</div>
          <div class="meta">${esc(methodLabel(p))}${p.reference ? ' · ref ' + esc(p.reference) : ''}${p.depositorName ? ' · by ' + esc(p.depositorName) : ''} · ${esc(onDate(p.paidOn || p.createdAt))}${p.submittedByType === 'SCHOOL' ? ' · recorded by the school' : ''}</div>
          ${p.note ? `<div class="meta">${esc(p.note)}</div>` : ''}</div><div style="text-align:right;"><div style="font:800 1.05rem Sora,sans-serif;">${money(p.amountKobo)}</div><span class="pill ${FEE_PAY[p.status][0]}">${FEE_PAY[p.status][1]}</span></div></div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">${p.hasProof ? `<button class="btn btn-ghost btn-sm" data-proof="${p.id}">🖼 Receipt photo</button>` : ''}${p.status === 'PENDING' ? `<button class="btn btn-primary btn-sm" data-ok="${p.id}">✅ Confirm</button><button class="btn btn-ghost btn-sm" data-no="${p.id}">Reject</button>` : ''}${p.receiptNo ? `<span class="meta" style="align-self:center;">Receipt ${esc(p.receiptNo)}</span>` : ''}</div></div>`).join('')
          : '<div class="card lzx-card"><p class="muted">Nothing here.</p></div>';
        list.querySelectorAll('[data-proof]').forEach((b) => b.addEventListener('click', async () => {
          const { payment } = await api('/fees/admin/payments/' + b.dataset.proof);
          const m = feeModal(`<img alt="Receipt photo" src="${esc(payment.proofUrl)}" style="max-width:100%;border-radius:10px;"><button class="btn btn-ghost" style="width:100%;margin-top:10px;" id="pf-x">Close</button>`);
          m.el.querySelector('#pf-x').addEventListener('click', m.close);
        }));
        list.querySelectorAll('[data-ok]').forEach((b) => b.addEventListener('click', async () => {
          if (!confirm('Confirm this payment? The student gets a receipt.')) return;
          try { await api('/fees/admin/payments/' + b.dataset.ok + '/confirm', { method: 'POST', body: {} }); toast('✅ Confirmed'); await refresh(); drawList(); } catch (err) { toast(err.message); }
        }));
        list.querySelectorAll('[data-no]').forEach((b) => b.addEventListener('click', async () => {
          const reason = prompt('Why is it not accepted? The student will see this.');
          if (!reason) return;
          try { await api('/fees/admin/payments/' + b.dataset.no + '/reject', { method: 'POST', body: { reason } }); toast('Rejected'); await refresh(); drawList(); } catch (err) { toast(err.message); }
        }));
      }
      await drawList();
    }

    async function studentsTab(body, alive, refresh) {
      body.innerHTML = `<input id="fs-q" placeholder="Search student name…" value="${esc(state.sq)}" style="width:100%;margin-bottom:10px;"><div id="fs-list"></div>`;
      const list = body.querySelector('#fs-list');
      async function drawList() {
        const { students } = await api('/fees/admin/students?q=' + encodeURIComponent(state.sq));
        if (!alive()) return;
        list.innerHTML = students.length ? `<div class="card lzx-card" style="padding-top:4px;padding-bottom:4px;">${students.map((s) => { const c = FEE_CHIP[s.status]; return `<div class="list-row" style="align-items:center;gap:10px;"><div style="flex:1;min-width:0;"><div style="font-weight:700;">${esc(s.name)}</div><div class="meta">${esc([s.matricNumber, s.department, s.level].filter(Boolean).join(' · '))}</div></div><div style="text-align:right;"><div style="font-weight:700;">${s.status === 'NO_FEES' ? '—' : money(s.balanceKobo) + ' owing'}</div><span class="pill ${c[0]}">${c[1]}</span></div><button class="btn btn-ghost btn-sm" data-rec="${s.id}">Record payment</button></div>`; }).join('')}</div>` : '<div class="card lzx-card"><p class="muted">No students found.</p></div>';
        list.querySelectorAll('[data-rec]').forEach((b) => b.addEventListener('click', () => recordFor(b.dataset.rec, refresh, drawList)));
      }
      let timer; body.querySelector('#fs-q').addEventListener('input', (e) => { clearTimeout(timer); timer = setTimeout(() => { state.sq = e.target.value.trim(); drawList(); }, 300); });
      await drawList();
    }
    async function recordFor(studentId, refresh, redraw) {
      let d;
      try { d = await api('/fees/admin/students/' + studentId); } catch (err) { return toast(err.message); }
      const open = d.fees.filter((f) => f.balanceKobo > 0), today = new Date().toISOString().slice(0, 10);
      const m = feeModal(`<h3 style="margin-bottom:2px;">Record a payment</h3><p class="meta" style="margin-bottom:10px;">${esc(d.student.name)}${d.student.level ? ' · ' + esc(d.student.level) : ''} — cash at the bursar's, a POS payment, or a transfer you saw in the bank statement. It is confirmed at once and the student gets a receipt.</p>
        ${open.length ? open.map((f) => `<div class="list-row" style="align-items:center;gap:10px;"><input type="checkbox" class="rc-on" data-id="${f.id}" style="width:20px;height:20px;"><div style="flex:1;"><div style="font-weight:700;">${esc(f.title)}</div><div class="meta">owing ${money(f.balanceKobo)}</div></div><input class="rc-amt" data-id="${f.id}" value="${f.balanceKobo / 100}" style="width:110px;text-align:right;"></div>`).join('') : '<p class="muted">No listed fee is owing. You can still record an “Other” payment below.</p>'}
        <div class="list-row" style="align-items:center;gap:8px;margin-top:6px;"><input type="checkbox" id="rc-oth-on" style="width:20px;height:20px;"><input id="rc-oth-t" placeholder="Other: what for?" style="flex:1;"><input id="rc-oth-a" placeholder="₦" style="width:90px;text-align:right;"></div>
        <div class="field" style="margin-top:10px;"><label>How was it paid?</label><select id="rc-m"><option value="CASH">Cash</option><option value="POS">POS</option><option value="BANK_TRANSFER">Bank transfer</option></select></div>
        <div class="field"><label>Date</label><input id="rc-d" type="date" value="${today}" max="${today}"></div>
        <div class="field"><label>Reference / teller number (optional)</label><input id="rc-ref" maxlength="80"></div>
        <button class="btn btn-primary" id="rc-go" style="width:100%;">💾 Record payment</button><button class="btn btn-ghost" id="rc-x" style="width:100%;margin-top:8px;">Cancel</button>`);
      const q = (s) => m.el.querySelector(s);
      q('#rc-x').addEventListener('click', m.close);
      q('#rc-go').addEventListener('click', async () => {
        const items = [...m.el.querySelectorAll('.rc-on:checked')].map((c) => ({ feeId: c.dataset.id, amountKobo: toKobo(m.el.querySelector('.rc-amt[data-id="' + c.dataset.id + '"]').value) }));
        if (q('#rc-oth-on').checked) items.push({ title: q('#rc-oth-t').value, amountKobo: toKobo(q('#rc-oth-a').value) });
        if (!items.length) return toast('Tick what is being paid.');
        try {
          await api('/fees/admin/record', { method: 'POST', body: { studentId, items, method: q('#rc-m').value, paidOn: q('#rc-d').value, reference: q('#rc-ref').value } });
          m.close(); toast('✅ Recorded'); await refresh(); redraw();
        } catch (err) { toast(err.message); }
      });
    }

    async function feesTab(body, alive) {
      const d = await api('/fees/admin/fees');
      if (!alive()) return;
      const catOf = (id) => d.categories.find((c) => c.id === id) || d.categories[d.categories.length - 1];
      const deptName = (id) => { const x = d.departments.find((y) => y.id === id); return x ? x.name : null; };
      body.innerHTML = `<button class="btn btn-primary" id="ff-add" style="margin-bottom:10px;">➕ Add a fee</button><div class="card lzx-card" style="padding-top:4px;padding-bottom:4px;">${d.fees.map((f) => `<div class="list-row" style="align-items:center;gap:10px;"><div style="font-size:1.4rem;">${catOf(f.category).icon}</div><div style="flex:1;min-width:0;"><div style="font-weight:700;">${esc(f.title)}${f.active ? '' : ' <span class="pill pill-muted">hidden</span>'}</div><div class="meta">${money(f.amountKobo)} · ${f.levels.length ? f.levels.map((l) => l * 100 + 'L').join(', ') : 'every level'}${f.departmentId ? ' · ' + esc(deptName(f.departmentId) || 'one department') : ' · every department'}${f.semester ? ' · ' + esc(f.semester) : ''}${f.session ? ' · ' + esc(f.session) : ''}</div></div><button class="btn btn-ghost btn-sm" data-edit="${f.id}">Edit</button></div>`).join('') || '<p class="muted" style="padding:20px 0;">No fees yet. Tap “Add a fee”: the list covers tuition, acceptance fee, registration, faculty and departmental dues, SUG dues, ICT, library, medical, laboratory, SIWES, teaching practice, project, hostel, convocation and more.</p>'}</div>`;
      body.querySelector('#ff-add').addEventListener('click', () => feeForm(null));
      body.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => feeForm(d.fees.find((f) => f.id === b.dataset.edit))));
      function feeForm(cur) {
        cur = cur || { title: '', category: 'TUITION', amountKobo: 0, semester: '', session: '', levels: [], departmentId: '', dueDate: '', description: '', active: true };
        const m = feeModal(`<h3 style="margin-bottom:10px;">${cur.id ? 'Edit fee' : 'Add a fee'}</h3>
          <div class="field"><label>What kind of fee?</label><select id="ff-cat">${d.categories.map((c) => `<option value="${c.id}" ${c.id === cur.category ? 'selected' : ''}>${c.icon} ${esc(c.label)}</option>`).join('')}</select></div>
          <div class="field" id="ff-title-box" ${cur.category === 'OTHER' ? '' : 'hidden'}><label>What is it for?</label><input id="ff-title" maxlength="120" value="${esc(cur.category === 'OTHER' ? cur.title : '')}" placeholder="e.g. Faculty week contribution"></div>
          <div class="field"><label>Amount (₦)</label><input id="ff-amt" inputmode="decimal" value="${cur.amountKobo ? cur.amountKobo / 100 : ''}"></div>
          <div style="display:flex;gap:8px;"><div class="field" style="flex:1;"><label>Semester</label><select id="ff-sem"><option value="">Whole session</option>${['First Semester', 'Second Semester'].map((t) => `<option ${cur.semester === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div><div class="field" style="flex:1;"><label>Session</label><input id="ff-ses" maxlength="20" placeholder="2026/2027" value="${esc(cur.session || '')}"></div></div>
          <div class="field"><label>Which levels pay it? (none ticked = every level)</label><div style="display:flex;flex-wrap:wrap;gap:6px;">${d.levels.map((l) => `<label style="border:1.5px solid rgba(128,128,128,.35);border-radius:999px;padding:5px 11px;cursor:pointer;font-weight:500;"><input type="checkbox" class="ff-lv" value="${l.year}" ${cur.levels.includes(l.year) ? 'checked' : ''}> ${l.label}</label>`).join('')}</div></div>
          <div class="field"><label>Which department? (leave on “Every department” if all pay it)</label><select id="ff-dep"><option value="">Every department</option>${d.departments.map((x) => `<option value="${x.id}" ${x.id === cur.departmentId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>
          <div class="field"><label>Due date (optional)</label><input id="ff-due" type="date" value="${cur.dueDate ? String(cur.dueDate).slice(0, 10) : ''}"></div>
          <div class="field"><label>Details (optional)</label><input id="ff-desc" maxlength="300" value="${esc(cur.description || '')}"></div>
          <label style="display:flex;gap:8px;align-items:center;margin-bottom:12px;font-weight:500;"><input type="checkbox" id="ff-active" ${cur.active ? 'checked' : ''}> Show it to students</label>
          <button class="btn btn-primary" id="ff-save" style="width:100%;">💾 Save</button>${cur.id ? '<button class="btn btn-ghost" id="ff-del" style="width:100%;margin-top:8px;color:#b42318;">🗑 Delete this fee</button>' : ''}<button class="btn btn-ghost" id="ff-x" style="width:100%;margin-top:8px;">Cancel</button>`);
        const q = (s) => m.el.querySelector(s);
        q('#ff-x').addEventListener('click', m.close);
        q('#ff-cat').addEventListener('change', () => { q('#ff-title-box').hidden = q('#ff-cat').value !== 'OTHER'; });
        q('#ff-save').addEventListener('click', async () => {
          const category = q('#ff-cat').value;
          const payload = { category, title: category === 'OTHER' ? q('#ff-title').value : catOf(category).label, amountNaira: q('#ff-amt').value, semester: q('#ff-sem').value, session: q('#ff-ses').value, levels: [...m.el.querySelectorAll('.ff-lv:checked')].map((x) => Number(x.value)), departmentId: q('#ff-dep').value || null, dueDate: q('#ff-due').value || null, description: q('#ff-desc').value, active: q('#ff-active').checked };
          try { await api(cur.id ? '/fees/admin/fees/' + cur.id : '/fees/admin/fees', { method: cur.id ? 'PATCH' : 'POST', body: payload }); m.close(); toast('✅ Saved'); feesTab(body, alive); } catch (err) { toast(err.message); }
        });
        const del = q('#ff-del');
        if (del) del.addEventListener('click', async () => {
          if (!confirm('Delete this fee? Payments already made keep their record.')) return;
          try { await api('/fees/admin/fees/' + cur.id, { method: 'DELETE' }); m.close(); toast('Deleted'); feesTab(body, alive); } catch (err) { toast(err.message); }
        });
      }
    }

    async function bankTab(body, alive, refresh) {
      const { bank } = await api('/fees/admin/bank');
      if (!alive()) return;
      body.innerHTML = `<div class="card lzx-card"><h3 style="margin-bottom:4px;">🏦 Where students pay</h3><p class="meta" style="margin-bottom:12px;">These details are shown <b>only to the students of your institution</b>, on their School Fees page. Learnza staff cannot change them.</p>
        <div class="field"><label>Bank name</label><input id="bk-bank" maxlength="80" value="${esc(bank ? bank.bankName : '')}" placeholder="e.g. Zenith Bank"></div>
        <div class="field"><label>Account name</label><input id="bk-name" maxlength="120" value="${esc(bank ? bank.accountName : '')}"></div>
        <div class="field"><label>Account number (10 digits)</label><input id="bk-no" maxlength="10" inputmode="numeric" value="${esc(bank ? bank.accountNumber : '')}"></div>
        <div class="field"><label>Instructions for students (optional)</label><input id="bk-ins" maxlength="300" value="${esc(bank ? bank.instructions || '' : '')}" placeholder="e.g. Use your matric number as the narration"></div>
        <button class="btn btn-primary" id="bk-save">💾 Save bank details</button></div>`;
      body.querySelector('#bk-save').addEventListener('click', async () => {
        try {
          await api('/fees/admin/bank', { method: 'PUT', body: { bankName: body.querySelector('#bk-bank').value, accountName: body.querySelector('#bk-name').value, accountNumber: body.querySelector('#bk-no').value, instructions: body.querySelector('#bk-ins').value } });
          toast('✅ Bank details saved'); await refresh();
        } catch (err) { toast(err.message); }
      });
    }
  }

  // ---------------------------------------------------------------- generated practice: progress banner
  // The system writes mock exams, past-question practice and practice questions for every course
  // on the student's dashboard. Opening a screen that shows them starts anything still missing;
  // while it is being written this shows a note and refreshes the screen when it is done.
  async function practiceWatch(view, { api, esc, rerender }) {
    let data;
    try { data = await api('/practice/ensure', { method: 'POST' }); } catch { return; }
    const busy = (d) => d.courses.filter((c) => c.status === 'generating' || c.status === 'pending');
    if (!busy(data).length) return;
    const bar = document.createElement('div');
    bar.className = 'hint-box lzx-prep';
    const head = view.querySelector('.page-head');
    if (head && head.parentNode === view) head.insertAdjacentElement('afterend', bar); else view.insertBefore(bar, view.firstChild);
    const text = (d) => '⏳ Preparing your practice questions for ' + busy(d).map((c) => esc(c.title)).join(', ') + '… this page updates by itself.';
    bar.innerHTML = text(data);
    let tries = 0;
    const timer = setInterval(async () => {
      if (!bar.isConnected || ++tries > 30) return clearInterval(timer);
      try {
        const d = await api('/practice/status');
        if (!bar.isConnected) return clearInterval(timer);
        if (!busy(d).length) { clearInterval(timer); bar.remove(); rerender(); } else bar.innerHTML = text(d);
      } catch { /* keep trying */ }
    }, 8000);
  }

  // ---------------------------------------------------------------- on-demand libraries
  // KaTeX (maths) and Chart.js (graphs) are only used on the AI Lecturer's board. They used to be
  // downloaded on every visit to every screen (~450 KB); now they are fetched the first time a
  // lesson actually draws an equation or a graph.
  const LIBS = {
    katex: { css: 'https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.11/katex.min.css', js: 'https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.11/katex.min.js', ready: () => window.katex },
    chart: { js: 'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js', ready: () => window.Chart },
    flutterwave: { js: 'https://checkout.flutterwave.com/v3.js', ready: () => typeof window.FlutterwaveCheckout === 'function' },
  };
  const libLoads = {};
  function lib(name) {
    const def = LIBS[name];
    if (!def) return Promise.reject(new Error('Unknown library ' + name));
    if (def.ready()) return Promise.resolve();
    if (!libLoads[name]) {
      libLoads[name] = new Promise((resolve, reject) => {
        if (def.css) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = def.css; document.head.appendChild(l); }
        const sc = document.createElement('script');
        sc.src = def.js; sc.onload = () => resolve(); sc.onerror = () => { delete libLoads[name]; reject(new Error('Could not load ' + name)); };
        document.head.appendChild(sc);
      });
    }
    return libLoads[name];
  }

  // ---------------------------------------------------------------- loading bar
  // A thin bar across the top while a screen's data is on its way, so a tap always gets an
  // immediate visible response even when the connection is slow. It only appears if the wait
  // lasts longer than a blink, so quick screens do not flicker.
  let barEl = null, barTimer = null, barDepth = 0;
  function progress(on) {
    barDepth = Math.max(0, barDepth + (on ? 1 : -1));
    clearTimeout(barTimer);
    if (barDepth > 0) {
      barTimer = setTimeout(() => {
        if (!barEl) { barEl = document.createElement('div'); barEl.className = 'lzx-progress'; document.body.appendChild(barEl); }
        barEl.classList.add('on');
      }, 120);
    } else if (barEl) barEl.classList.remove('on');
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

  window.LZX = { support, wallet, groupExtras, seenLabel, practice, dailyChallenge, digitalId, progress, lib, pay, payReturn, elections, electionsAdmin, electionBanner, practiceWatch, fees: feesStudent, feesAdmin };
})();
