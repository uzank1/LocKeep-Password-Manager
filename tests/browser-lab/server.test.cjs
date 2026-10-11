'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLabServer } = require('./server.cjs');
const { cases } = require('./catalog');

test('Lab serves every scenario and isolates native mode, sources and writes', async () => {
  const port = 49000 + process.pid % 1000;
  const lab = await createLabServer({ port });
  try {
    assert.equal(new Set(cases.map(scenario => scenario.id)).size, cases.length);
    const health = await (await fetch(lab.url + '/health')).json();
    assert.equal(health.scenarios, cases.length);
    for (const scenario of cases) {
      const page = await fetch(lab.url + scenario.path);
      assert.equal(page.status, 200, scenario.id);
      const html = await page.text();
      assert.ok(html.includes('src="/bridge.js"'), scenario.id);
      assert.ok(html.includes('src="/extension/content_script.js"'), scenario.id);
    }
    assert.equal((await fetch(lab.url + '/case/signup')).status, 200);
    const native = await (await fetch(lab.url + '/case/signup?mode=native')).text();
    assert.ok(!native.includes('src="/bridge.js"'));
    assert.ok(!native.includes('src="/extension/content_script.js"'));
    assert.ok(native.includes('src="/fixture.js"'));
    const locked = await (await fetch(lab.url + '/case/locked-vault')).text();
    assert.ok(locked.includes('"profile":"locked"'));
    const overridden = await (await fetch(lab.url + '/case/locked-vault?profile=available')).text();
    assert.ok(overridden.includes('"profile":"available"'));
    assert.equal((await fetch(`http://127.0.0.1:${port + 1}/case/login?mode=native`)).status, 200);
    for (const denied of ['/package.json', '/case/missing', '/extension/..%2fpackage.json', '/results/..%2fpackage.json']) {
      assert.equal((await fetch(lab.url + denied)).status, 404, denied);
    }
    assert.equal((await fetch(lab.url + '/case/signup', { method: 'POST', body: 'sample-only' })).status, 405);
  } finally { await lab.close(); }
});
