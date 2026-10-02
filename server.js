'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_SEARCH_RESULTS = 25;

if (!process.env.ADMIN_PASSWORD) {
  console.warn('WARNING: ADMIN_PASSWORD is not set; using the default "changeme". Set it before the event.');
}

// ---------- Database ----------

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(process.env.DB_FILE || path.join(DATA_DIR, 'checkin.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS attendees (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name    TEXT NOT NULL,
    last_name     TEXT NOT NULL DEFAULT '',
    company       TEXT NOT NULL DEFAULT '',
    checked_in_at TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const stmt = {
  search: db.prepare(`
    SELECT id, first_name, last_name, company, checked_in_at
    FROM attendees
    WHERE (first_name || ' ' || last_name) LIKE :q ESCAPE '\\'
    ORDER BY first_name COLLATE NOCASE, last_name COLLATE NOCASE
    LIMIT ${MAX_SEARCH_RESULTS}
  `),
  get: db.prepare('SELECT id, first_name, last_name, company, checked_in_at FROM attendees WHERE id = ?'),
  checkIn: db.prepare(`UPDATE attendees SET checked_in_at = datetime('now') WHERE id = ? AND checked_in_at IS NULL`),
  undoCheckIn: db.prepare('UPDATE attendees SET checked_in_at = NULL WHERE id = ?'),
  insert: db.prepare('INSERT INTO attendees (first_name, last_name, company) VALUES (?, ?, ?)'),
  exists: db.prepare(`
    SELECT 1 FROM attendees
    WHERE first_name = ? COLLATE NOCASE AND last_name = ? COLLATE NOCASE AND company = ? COLLATE NOCASE
  `),
  all: db.prepare(`
    SELECT id, first_name, last_name, company, checked_in_at FROM attendees
    ORDER BY first_name COLLATE NOCASE, last_name COLLATE NOCASE
  `),
  remove: db.prepare('DELETE FROM attendees WHERE id = ?'),
  removeAll: db.prepare('DELETE FROM attendees'),
};

function toAttendee(row) {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    company: row.company,
    checkedInAt: row.checked_in_at ? row.checked_in_at.replace(' ', 'T') + 'Z' : null,
  };
}

function clean(value, max = 200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Inserts a batch of attendees, skipping blanks and exact duplicates.
function addAttendees(list) {
  let added = 0;
  let skipped = 0;
  db.exec('BEGIN');
  try {
    for (const item of list) {
      const first = clean(item.firstName);
      const last = clean(item.lastName);
      const company = clean(item.company);
      if (!first || stmt.exists.get(first, last, company)) {
        skipped++;
        continue;
      }
      stmt.insert.run(first, last, company);
      added++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { added, skipped };
}

// ---------- HTTP helpers ----------

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function isAdmin(req) {
  const given = Buffer.from(String(req.headers['x-admin-password'] || ''));
  const expected = Buffer.from(ADMIN_PASSWORD);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function csvCell(value) {
  const s = String(value ?? '');
  // Neutralise spreadsheet formula injection and quote when needed.
  const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  return /[",\n\r]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' || pathname === '/admin' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

// ---------- Routes ----------

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  // Public: partial name search.
  if (method === 'GET' && pathname === '/api/search') {
    const q = clean(url.searchParams.get('q'), 100);
    if (q.length < 2) return sendJson(res, 200, { results: [] });
    const escaped = q.replace(/[\\%_]/g, (c) => '\\' + c);
    // Match anywhere in the full name ("jas" -> "Jason Bourne", "Jassie Puji").
    const rows = stmt.search.all({ q: '%' + escaped + '%' });
    return sendJson(res, 200, { results: rows.map(toAttendee) });
  }

  // Public: check an attendee in.
  let m = pathname.match(/^\/api\/attendees\/(\d+)\/checkin$/);
  if (m && method === 'POST') {
    const id = Number(m[1]);
    const row = stmt.get.get(id);
    if (!row) return sendJson(res, 404, { error: 'Attendee not found' });
    const alreadyCheckedIn = Boolean(row.checked_in_at);
    if (!alreadyCheckedIn) stmt.checkIn.run(id);
    return sendJson(res, 200, { attendee: toAttendee(stmt.get.get(id)), alreadyCheckedIn });
  }

  // Everything below is for the host only.
  if (!isAdmin(req)) return sendJson(res, 401, { error: 'Invalid host password' });

  if (method === 'POST' && pathname === '/api/admin/login') {
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'GET' && pathname === '/api/admin/attendees') {
    const attendees = stmt.all.all().map(toAttendee);
    const checkedIn = attendees.filter((a) => a.checkedInAt).length;
    return sendJson(res, 200, { attendees, total: attendees.length, checkedIn });
  }

  if (method === 'POST' && pathname === '/api/admin/attendees') {
    const body = await readJson(req);
    const list = Array.isArray(body.attendees) ? body.attendees : [body];
    if (list.length > 20000) return sendJson(res, 400, { error: 'Too many attendees in one upload' });
    return sendJson(res, 200, addAttendees(list));
  }

  if (method === 'DELETE' && pathname === '/api/admin/attendees') {
    stmt.removeAll.run();
    return sendJson(res, 200, { ok: true });
  }

  m = pathname.match(/^\/api\/admin\/attendees\/(\d+)$/);
  if (m && method === 'DELETE') {
    stmt.remove.run(Number(m[1]));
    return sendJson(res, 200, { ok: true });
  }

  m = pathname.match(/^\/api\/admin\/attendees\/(\d+)\/checkin$/);
  if (m && method === 'DELETE') {
    stmt.undoCheckIn.run(Number(m[1]));
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'GET' && pathname === '/api/admin/export.csv') {
    const lines = [['First Name', 'Last Name', 'Company', 'Checked In', 'Checked In At (UTC)'].join(',')];
    for (const a of stmt.all.all().map(toAttendee)) {
      lines.push([a.firstName, a.lastName, a.company, a.checkedInAt ? 'Yes' : 'No', a.checkedInAt || '']
        .map(csvCell).join(','));
    }
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="attendees.csv"',
      'Cache-Control': 'no-store',
    });
    return res.end('﻿' + lines.join('\r\n'));
  }

  return sendJson(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url.pathname);
    res.writeHead(405).end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, err.status || 500, { error: err.status ? err.message : 'Server error' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Event check-in running at http://localhost:${PORT}`));
}

module.exports = { server, db };
