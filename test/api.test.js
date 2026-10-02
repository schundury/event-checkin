'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-test-'));
process.env.ADMIN_PASSWORD = 'secret';
const { server } = require('../server');

let base;
before(() => new Promise((resolve) => server.listen(0, () => {
  base = `http://127.0.0.1:${server.address().port}`;
  resolve();
})));
after(() => new Promise((resolve) => server.close(resolve)));

const admin = { 'X-Admin-Password': 'secret', 'Content-Type': 'application/json' };

test('host endpoints require the password', async () => {
  const res = await fetch(`${base}/api/admin/attendees`);
  assert.strictEqual(res.status, 401);
});

test('upload, partial search and check in', async () => {
  let res = await fetch(`${base}/api/admin/attendees`, {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({ attendees: [
      { firstName: 'Jason', lastName: 'Bourne', company: 'Treadstone' },
      { firstName: 'Jassie', lastName: 'Puji', company: 'Acme' },
      { firstName: 'Mary', lastName: 'Smith', company: 'Globex' },
      { firstName: 'jason', lastName: 'bourne', company: 'treadstone' },
    ] }),
  });
  assert.deepStrictEqual(await res.json(), { added: 3, skipped: 1 });

  // Manual single add.
  res = await fetch(`${base}/api/admin/attendees`, {
    method: 'POST', headers: admin, body: JSON.stringify({ firstName: 'Ana', lastName: 'Jasper', company: '' }),
  });
  assert.strictEqual((await res.json()).added, 1);

  res = await fetch(`${base}/api/search?q=jas`);
  const names = (await res.json()).results.map((a) => `${a.firstName} ${a.lastName}`);
  assert.deepStrictEqual(names, ['Ana Jasper', 'Jason Bourne', 'Jassie Puji']);

  res = await fetch(`${base}/api/search?q=${encodeURIComponent('son bou')}`);
  assert.strictEqual((await res.json()).results.length, 1);

  res = await fetch(`${base}/api/search?q=%25`);
  assert.strictEqual((await res.json()).results.length, 0, 'wildcards are literal');

  res = await fetch(`${base}/api/search?q=j`);
  assert.strictEqual((await res.json()).results.length, 0, 'needs 2+ characters');

  res = await fetch(`${base}/api/search?q=jason`);
  const jason = (await res.json()).results[0];
  assert.strictEqual(jason.checkedInAt, null);

  res = await fetch(`${base}/api/attendees/${jason.id}/checkin`, { method: 'POST' });
  let body = await res.json();
  assert.strictEqual(body.alreadyCheckedIn, false);
  assert.ok(body.attendee.checkedInAt);

  res = await fetch(`${base}/api/attendees/${jason.id}/checkin`, { method: 'POST' });
  body = await res.json();
  assert.strictEqual(body.alreadyCheckedIn, true);

  res = await fetch(`${base}/api/admin/attendees`, { headers: admin });
  body = await res.json();
  assert.strictEqual(body.total, 4);
  assert.strictEqual(body.checkedIn, 1);

  res = await fetch(`${base}/api/admin/export.csv`, { headers: admin });
  const csv = await res.text();
  assert.match(csv, /Jason,Bourne,Treadstone,Yes,/);

  res = await fetch(`${base}/api/attendees/99999/checkin`, { method: 'POST' });
  assert.strictEqual(res.status, 404);
});
