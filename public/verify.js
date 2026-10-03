(function () {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const box = document.getElementById('box');
  const brand = '<div class="brand">Learnza · Credential Verification</div>';

  // Credential titles and student names are typed in by school staff, so they are escaped
  // before going into the page -- otherwise a crafted title would run script in the
  // browser of whoever verifies it.
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  if (!code) {
    box.innerHTML = brand + '<p class="muted">No verification code provided.</p>';
    return;
  }
  fetch('/api/verify/' + encodeURIComponent(code))
    .then((r) => r.json())
    .then((data) => {
      if (!data.valid) {
        box.innerHTML = `
          ${brand}
          <span class="pill pill-danger">Not found</span>
          <p class="muted" style="margin-top:14px;">No credential matches this code. It may be invalid or revoked.</p>
        `;
        return;
      }
      box.innerHTML = `
        ${brand}
        <span class="pill pill-pass">Verified genuine</span>
        <h2 style="margin:16px 0 4px;">${esc(data.title)}</h2>
        <p style="margin-bottom:18px;">Awarded to <strong>${esc(data.studentName)}</strong></p>
        <div class="id-grid" style="text-align:left;">
          <div><div class="id-field" style="color:var(--ink-soft);">Matric number</div><div class="tabular">${esc(data.matricNumber || '—')}</div></div>
          <div><div class="id-field" style="color:var(--ink-soft);">Institution</div><div>${esc(data.school)}</div></div>
        </div>
        <p class="muted tabular" style="margin-top:16px; font-size:0.82rem;">Issued ${new Date(data.issuedAt).toLocaleDateString()}</p>
      `;
    })
    .catch(() => {
      box.innerHTML = brand + '<p class="muted">Something went wrong. Please try again.</p>';
    });
})();
