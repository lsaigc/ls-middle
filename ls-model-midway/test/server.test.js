'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { readConfig } = require('../src/server');

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
