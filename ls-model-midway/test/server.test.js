'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { readConfig } = require('../src/server');

test('loads project .env, preserves environment overrides and allows a missing file', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'midway-env-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'src'));
  for (const name of ['server.js', 'proxy.js']) {
    copyFileSync(path.join(__dirname, '../src', name), path.join(dir, 'src', name));
  }
  const env = { ...process.env };
  for (const name of ['UPSTREAM_ROUTES', 'UPSTREAM_BASE_URL', 'PORT']) delete env[name];
  function run(extra = {}) {
    const result = spawnSync(process.execPath, ['-e',
      `console.log(JSON.stringify(require(${JSON.stringify(path.join(dir, 'src/server.js'))}).loadConfig()))`],
    { env: { ...env, ...extra }, cwd: tmpdir(), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  writeFileSync(path.join(dir, '.env'), '# local config\nUPSTREAM_ROUTES=\'{"tripo":"https://openapi.tripo3d.ai"}\'\nPORT=4321\n');
  assert.deepEqual(run(), { upstreamBaseUrl: '', port: 4321,
    upstreamRoutes: { tripo: 'https://openapi.tripo3d.ai' } });
  assert.equal(run({ PORT: '5000' }).port, 5000);
  rmSync(path.join(dir, '.env'));
  assert.deepEqual(run({ UPSTREAM_BASE_URL: 'https://example.com' }), {
    upstreamBaseUrl: 'https://example.com', port: 3000,
  });
});

test('reads server config with a required upstream and default port', () => {
  assert.deepEqual(
    readConfig({ UPSTREAM_BASE_URL: 'https://api.example.com/v1' }),
    {
      upstreamBaseUrl: 'https://api.example.com/v1',
      port: 3000,
    },
  );

  assert.deepEqual(
    readConfig({ UPSTREAM_BASE_URL: 'http://127.0.0.1:9000', PORT: '0' }),
    {
      upstreamBaseUrl: 'http://127.0.0.1:9000',
      port: 0,
    },
  );
});

test('reads server config rejects missing upstream and invalid ports', () => {
  assert.throws(
    () => readConfig({}),
    /UPSTREAM_BASE_URL is required/,
  );
  assert.throws(
    () => readConfig({ UPSTREAM_BASE_URL: 'https://api.example.com', PORT: '3.5' }),
    /PORT must be an integer between 0 and 65535/,
  );
  assert.throws(
    () => readConfig({ UPSTREAM_BASE_URL: 'https://api.example.com', PORT: '65536' }),
    /PORT must be an integer between 0 and 65535/,
  );
});

test('reads a JSON provider route map without requiring a default upstream', () => {
  const upstreamRoutes = { tripo: 'https://openapi.tripo3d.ai', other: 'https://example.com/api' };
  assert.deepEqual(readConfig({ UPSTREAM_ROUTES: JSON.stringify(upstreamRoutes) }), {
    upstreamBaseUrl: '', upstreamRoutes, port: 3000,
  });
  assert.throws(() => readConfig({ UPSTREAM_ROUTES: '{' }), /UPSTREAM_ROUTES/);
});
