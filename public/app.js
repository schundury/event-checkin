'use strict';

(function () {
  const $ = (sel) => document.querySelector(sel);
  const isHostPage = location.pathname === '/admin' || location.hash === '#admin';
  const PASSWORD_KEY = 'checkin.hostPassword';

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  async function api(path, options = {}) {
    const res = await fetch(path, options);
    const body = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
    if (!res.ok) throw Object.assign(new Error(body?.error || 'Request failed'), { status: res.status });
    return body;
  }

  // ======================= Attendee view =======================

  function initAttendee() {
    const input = $('#search');
    const results = $('#results');
    const hint = $('#search-hint');
    let lastQuery = '';

    function highlight(text, q) {
      const i = text.toLowerCase().indexOf(q.toLowerCase());
      if (i < 0) return escapeHtml(text);
      return escapeHtml(text.slice(0, i)) + '<mark>' + escapeHtml(text.slice(i, i + q.length)) + '</mark>' + escapeHtml(text.slice(i + q.length));
    }

    function checkedInBadge() {
      return '<span class="badge"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>Checked in</span>';
    }

    function render(list, q) {
      if (!list.length) {
        results.innerHTML = '';
        hint.textContent = 'No matching names. Try a different spelling, or see the registration desk.';
        return;
      }
      hint.textContent = list.length === 1 ? '1 match' : list.length + ' matches';
      results.innerHTML = list.map((a) => {
        const full = (a.firstName + ' ' + a.lastName).trim();
        const action = a.checkedInAt
          ? checkedInBadge()
          : `<button class="btn primary" data-id="${a.id}" data-name="${escapeHtml(a.firstName)}">Check in</button>`;
        return `<li class="result">
          <div class="who">
            <div class="name">${highlight(full, q)}</div>
            ${a.company ? `<div class="company">${escapeHtml(a.company)}</div>` : ''}
          </div>
          ${action}
        </li>`;
      }).join('');
    }

    const search = debounce(async () => {
      const q = input.value.trim();
      lastQuery = q;
      document.querySelector('.welcome')?.remove();
      if (q.length < 2) {
        results.innerHTML = '';
        hint.textContent = 'Type at least 2 letters.';
        return;
      }
      try {
        const { results: list } = await api('/api/search?q=' + encodeURIComponent(q));
        if (q === lastQuery) render(list, q);
      } catch {
        hint.textContent = 'Could not search right now. Please try again.';
      }
    }, 200);

    input.addEventListener('input', search);

    results.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-id]');
      if (!btn) return;
      btn.disabled = true;
      btn.textContent = 'Checking in…';
      try {
        const { attendee, alreadyCheckedIn } = await api(`/api/attendees/${btn.dataset.id}/checkin`, { method: 'POST' });
        btn.outerHTML = checkedInBadge();
        document.querySelector('.welcome')?.remove();
        const note = document.createElement('div');
        note.className = 'welcome';
        note.textContent = alreadyCheckedIn
          ? `${attendee.firstName}, you were already checked in. Enjoy the event!`
          : `Welcome, ${attendee.firstName}! You're checked in. Enjoy the event!`;
        results.after(note);
      } catch {
        btn.disabled = false;
        btn.textContent = 'Check in';
        alert('Sorry, check-in failed. Please try again or see the registration desk.');
      }
    });

    input.focus();
  }

  // ======================= Host view =======================

  function initHost() {
    $('#attendee-view').hidden = true;
    $('#host-view').hidden = false;
    $('#mode-link').textContent = 'Go to attendee check-in';
    $('#mode-link').href = '/';
    document.title = 'Host · PrincipiumX Check-in';

    let password = '';
    try { password = sessionStorage.getItem(PASSWORD_KEY) || ''; } catch {}
    let attendees = [];

    const hostApi = (path, options = {}) =>
      api(path, { ...options, headers: { ...(options.headers || {}), 'X-Admin-Password': password } });

    function showMsg(el, text, isError) {
      el.hidden = false;
      el.textContent = text;
      el.classList.toggle('err', Boolean(isError));
    }

    function handleAuthError(err) {
      if (err.status === 401) {
        logout();
        showMsg($('#login-error'), 'Your session expired. Please sign in again.', true);
        return true;
      }
      return false;
    }

    async function login(pw) {
      password = pw;
      await hostApi('/api/admin/login', { method: 'POST' });
      try { sessionStorage.setItem(PASSWORD_KEY, pw); } catch {}
      $('#login-card').hidden = true;
      $('#host-panel').hidden = false;
      renderQr();
      await load();
    }

    function logout() {
      password = '';
      try { sessionStorage.removeItem(PASSWORD_KEY); } catch {}
      $('#host-panel').hidden = true;
      $('#login-card').hidden = false;
      $('#password').value = '';
    }

    async function load() {
      try {
        const data = await hostApi('/api/admin/attendees');
        attendees = data.attendees;
        $('#stat-total').textContent = data.total;
        $('#stat-checked').textContent = data.checkedIn;
        $('#stat-pending').textContent = data.total - data.checkedIn;
        renderTable();
      } catch (err) {
        if (!handleAuthError(err)) console.error(err);
      }
    }

    function renderTable() {
      const f = $('#filter').value.trim().toLowerCase();
      const status = $('#status-filter').value;
      const rows = attendees.filter((a) => {
        if (status === 'in' && !a.checkedInAt) return false;
        if (status === 'out' && a.checkedInAt) return false;
        return !f || `${a.firstName} ${a.lastName} ${a.company}`.toLowerCase().includes(f);
      });
      $('#empty-list').hidden = attendees.length > 0;
      $('#attendee-rows').innerHTML = rows.map((a) => {
        const time = a.checkedInAt ? new Date(a.checkedInAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
        return `<tr>
          <td>${escapeHtml(a.firstName + ' ' + a.lastName)}</td>
          <td>${escapeHtml(a.company)}</td>
          <td>${a.checkedInAt ? `<span class="status-in">✓ ${escapeHtml(time)}</span>` : '<span class="status-out">—</span>'}</td>
          <td class="actions-cell">
            ${a.checkedInAt
              ? `<button class="btn small" data-undo="${a.id}">Undo</button>`
              : `<button class="btn small" data-checkin="${a.id}">Check in</button>`}
            <button class="btn small danger" data-delete="${a.id}" aria-label="Remove">✕</button>
          </td>
        </tr>`;
      }).join('');
    }

    // ---- CSV parsing ----
    function parseCsv(text) {
      text = text.replace(/^﻿/, '');
      const firstLine = text.split(/\r?\n/, 1)[0] || '';
      const delim = [',', '\t', ';'].reduce((best, d) =>
        firstLine.split(d).length > firstLine.split(best).length ? d : best, ',');
      const rows = [];
      let row = [], cell = '', quoted = false;
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
          if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
          else if (c === '"') quoted = false;
          else cell += c;
        } else if (c === '"') quoted = true;
        else if (c === delim) { row.push(cell); cell = ''; }
        else if (c === '\n' || c === '\r') {
          if (c === '\r' && text[i + 1] === '\n') i++;
          row.push(cell); rows.push(row); row = []; cell = '';
        } else cell += c;
      }
      if (cell || row.length) { row.push(cell); rows.push(row); }
      return rows.map((r) => r.map((v) => v.trim())).filter((r) => r.some(Boolean));
    }

    function rowsToAttendees(rows) {
      if (!rows.length) return [];
      const head = rows[0].map((h) => h.toLowerCase().replace(/[^a-z]/g, ''));
      const find = (...names) => head.findIndex((h) => names.includes(h));
      let iFirst = find('firstname', 'first', 'givenname', 'fname');
      let iLast = find('lastname', 'last', 'surname', 'familyname', 'lname');
      let iCompany = find('company', 'companyname', 'organization', 'organisation', 'org', 'employer');
      const iFull = find('name', 'fullname', 'attendee', 'attendeename');
      const hasHeader = iFirst >= 0 || iLast >= 0 || iCompany >= 0 || iFull >= 0;
      const body = hasHeader ? rows.slice(1) : rows;
      if (!hasHeader) { iFirst = 0; iLast = 1; iCompany = 2; }

      return body.map((r) => {
        let firstName = iFirst >= 0 ? r[iFirst] : '';
        let lastName = iLast >= 0 ? r[iLast] : '';
        if (!firstName && !lastName && iFull >= 0 && r[iFull]) {
          const parts = r[iFull].split(/\s+/);
          firstName = parts.shift();
          lastName = parts.join(' ');
        }
        return { firstName: firstName || '', lastName: lastName || '', company: (iCompany >= 0 && r[iCompany]) || '' };
      }).filter((a) => a.firstName);
    }

    // ---- QR code ----
    function renderQr() {
      const url = location.origin + '/';
      $('#qr-url').textContent = url;
      const draw = () => {
        const qr = window.qrcode(0, 'M');
        qr.addData(url);
        qr.make();
        $('#qr').innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
      };
      if (window.qrcode) return draw();
      const s = document.createElement('script');
      s.src = '/vendor/qrcode.js';
      s.onload = draw;
      s.onerror = () => { $('#qr').textContent = 'QR code could not be generated — share the link below.'; };
      document.head.appendChild(s);
    }

    // ---- Events ----
    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('#login-error').hidden = true;
      try {
        await login($('#password').value);
      } catch (err) {
        password = '';
        showMsg($('#login-error'), err.status === 401 ? 'Incorrect password.' : 'Could not sign in. Try again.', true);
      }
    });

    $('#logout').addEventListener('click', logout);

    $('#upload-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const file = $('#file').files[0];
      const msg = $('#upload-msg');
      if (!file) return;
      if (/\.xlsx?$/i.test(file.name)) {
        return showMsg(msg, 'Excel files are not supported. In Excel choose File → Save As → CSV, then upload that.', true);
      }
      try {
        const list = rowsToAttendees(parseCsv(await file.text()));
        if (!list.length) return showMsg(msg, 'No attendees found in that file.', true);
        const { added, skipped } = await hostApi('/api/admin/attendees', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ attendees: list }),
        });
        showMsg(msg, `Added ${added} attendee${added === 1 ? '' : 's'}` + (skipped ? ` (${skipped} duplicate${skipped === 1 ? '' : 's'} skipped)` : '') + '.');
        $('#upload-form').reset();
        load();
      } catch (err) {
        if (!handleAuthError(err)) showMsg(msg, 'Upload failed: ' + err.message, true);
      }
    });

    $('#add-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const msg = $('#add-msg');
      const data = Object.fromEntries(new FormData(form));
      try {
        const { added } = await hostApi('/api/admin/attendees', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        showMsg(msg, added ? `Added ${data.firstName} ${data.lastName}`.trim() + '.' : 'That attendee is already on the list.', !added);
        if (added) form.reset();
        form.firstName.focus();
        load();
      } catch (err) {
        if (!handleAuthError(err)) showMsg(msg, 'Could not add attendee: ' + err.message, true);
      }
    });

    $('#attendee-rows').addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      try {
        if (btn.dataset.checkin) {
          await hostApi(`/api/attendees/${btn.dataset.checkin}/checkin`, { method: 'POST' });
        } else if (btn.dataset.undo) {
          await hostApi(`/api/admin/attendees/${btn.dataset.undo}/checkin`, { method: 'DELETE' });
        } else if (btn.dataset.delete) {
          const a = attendees.find((x) => String(x.id) === btn.dataset.delete);
          if (!confirm(`Remove ${a ? a.firstName + ' ' + a.lastName : 'this attendee'} from the list?`)) return;
          await hostApi(`/api/admin/attendees/${btn.dataset.delete}`, { method: 'DELETE' });
        }
        load();
      } catch (err) {
        if (!handleAuthError(err)) alert(err.message);
      }
    });

    $('#filter').addEventListener('input', renderTable);
    $('#status-filter').addEventListener('change', renderTable);
    $('#refresh').addEventListener('click', load);
    $('#print-qr').addEventListener('click', () => window.print());

    $('#export').addEventListener('click', async () => {
      try {
        const res = await fetch('/api/admin/export.csv', { headers: { 'X-Admin-Password': password } });
        if (!res.ok) throw Object.assign(new Error('Export failed'), { status: res.status });
        const url = URL.createObjectURL(await res.blob());
        const a = Object.assign(document.createElement('a'), { href: url, download: 'attendees.csv' });
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch (err) {
        if (!handleAuthError(err)) alert(err.message);
      }
    });

    $('#clear-all').addEventListener('click', async () => {
      if (!confirm('Delete ALL attendees and check-ins? This cannot be undone.')) return;
      try {
        await hostApi('/api/admin/attendees', { method: 'DELETE' });
        load();
      } catch (err) {
        if (!handleAuthError(err)) alert(err.message);
      }
    });

    // Keep the dashboard live during the event.
    setInterval(() => { if (password && !document.hidden) load(); }, 15000);

    if (password) login(password).catch(logout);
  }

  if (isHostPage) initHost();
  else initAttendee();
})();
