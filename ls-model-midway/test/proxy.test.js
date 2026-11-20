'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { after, test } = require('node:test');

const { createProxyServer } = require('../src/proxy');

const servers = [];

after(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
});

test('forwards request method, URL, headers, and raw body to the fixed upstream', async () => {
  const body = Buffer.from([0x00, 0x7f, 0x80, 0xff]);
  const received = new Promise((resolve) => {
    const upstream = track(http.createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) {
        chunks.push(chunk);
      }
      resolve({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks),
      });
      response.end('ok');
    }));
    upstream.listen(0, '127.0.0.1');
  });

  const upstream = servers.at(-1);
  await onceListening(upstream);
  const upstreamAddress = upstream.address();
  const upstreamBaseUrl = `http://127.0.0.1:${upstreamAddress.port}/api`;
  const proxy = track(createProxyServer({ upstreamBaseUrl }));
  proxy.listen(0, '127.0.0.1');
  await onceListening(proxy);

  const proxyAddress = proxy.address();
  void sendRequest({
    port: proxyAddress.port,
    method: 'PATCH',
    path: '/models?stream=true',
    headers: {
      host: 'spoofed.example',
      connection: 'keep-alive, x-remove-me',
      'x-remove-me': 'secret-hop-value',
      'proxy-authorization': 'Basic secret',
      'x-custom-header': 'preserved',
      'content-length': String(body.length),
    },
    body,
  }).catch(() => {});

  const request = await received;
  assert.equal(request.method, 'PATCH');
  assert.equal(request.url, '/api/models?stream=true');
  assert.equal(request.headers.host, `127.0.0.1:${upstreamAddress.port}`);
  assert.equal(request.headers['x-custom-header'], 'preserved');
  assert.doesNotMatch(request.headers.connection, /x-remove-me/);
  assert.equal(request.headers['x-remove-me'], undefined);
  assert.equal(request.headers['proxy-authorization'], undefined);
  assert.deepEqual(request.body, body);
});

test('forwards response status, end-to-end headers, and raw body', async () => {
  const body = Buffer.from([0xff, 0x00, 0x81, 0x7e]);
  const upstream = track(http.createServer((request, response) => {
    request.resume();
    response.writeHead(429, 'Rate Limited', {
      'content-type': 'application/octet-stream',
      'x-upstream-header': 'preserved',
      connection: 'x-upstream-hop',
      'x-upstream-hop': 'remove-me',
    });
    response.end(body);
  }));
  upstream.listen(0, '127.0.0.1');
  await onceListening(upstream);

  const upstreamAddress = upstream.address();
  const proxy = track(createProxyServer({
    upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
  }));
  proxy.listen(0, '127.0.0.1');
  await onceListening(proxy);

  const proxyAddress = proxy.address();
  const response = await collectResponse({
    port: proxyAddress.port,
    path: '/binary',
  });

  assert.equal(response.statusCode, 429);
  assert.equal(response.statusMessage, 'Rate Limited');
  assert.equal(response.headers['x-upstream-header'], 'preserved');
  assert.equal(response.headers['x-upstream-hop'], undefined);
  assert.deepEqual(response.body, body);
});

test('streams response chunks before the upstream response completes', async (context) => {
  let releaseUpstream;
  const upstreamGate = new Promise((resolve) => {
    releaseUpstream = resolve;
  });
  context.after(releaseUpstream);

  const upstream = track(http.createServer(async (request, response) => {
    request.resume();
    response.write('first');
    await upstreamGate;
    response.end('second');
  }));
  upstream.listen(0, '127.0.0.1');
  await onceListening(upstream);

  const upstreamAddress = upstream.address();
  const proxy = track(createProxyServer({
    upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
  }));
  proxy.listen(0, '127.0.0.1');
  await onceListening(proxy);

  const proxyAddress = proxy.address();
  const firstChunk = await waitForFirstChunk({
    port: proxyAddress.port,
    path: '/stream',
  });

  assert.equal(firstChunk.chunk.toString(), 'first');
  releaseUpstream();
  assert.equal((await firstChunk.remaining).toString(), 'second');
});

test('returns 502 without leaking request details when the upstream is unavailable', async () => {
  const unavailablePort = await reserveClosedPort();
  const proxy = track(createProxyServer({
    upstreamBaseUrl: `http://127.0.0.1:${unavailablePort}/hidden-upstream`,
  }));
  proxy.listen(0, '127.0.0.1');
  await onceListening(proxy);

  const proxyAddress = proxy.address();
  const response = await collectResponse({
    port: proxyAddress.port,
    path: '/private-path?token=request-secret',
    headers: { authorization: 'Bearer header-secret' },
  });

  assert.equal(response.statusCode, 502);
  assert.equal(response.body.toString(), 'Bad Gateway\n');
  assert.doesNotMatch(response.body.toString(), /hidden-upstream|request-secret|header-secret/);
});

test('aborts the upstream request when the caller disconnects', async () => {
  let markUpstreamReceived;
  let markUpstreamAborted;
  const upstreamReceived = new Promise((resolve) => {
    markUpstreamReceived = resolve;
  });
  const upstreamAborted = new Promise((resolve) => {
    markUpstreamAborted = resolve;
  });
  const upstream = track(http.createServer((request) => {
    markUpstreamReceived();
    request.once('aborted', markUpstreamAborted);
  }));
  upstream.listen(0, '127.0.0.1');
  await onceListening(upstream);

  const upstreamAddress = upstream.address();
  const proxy = track(createProxyServer({
    upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
  }));
  proxy.listen(0, '127.0.0.1');
  await onceListening(proxy);

  const proxyAddress = proxy.address();
  const caller = http.request({
    host: '127.0.0.1',
    port: proxyAddress.port,
    method: 'POST',
    path: '/streaming-request',
    headers: { 'content-length': '100' },
  });
  caller.once('error', () => {});
  caller.write('partial');

  await withTimeout(upstreamReceived, 500, 'upstream did not receive request');
  caller.destroy();
  await withTimeout(upstreamAborted, 500, 'upstream request was not aborted');
});

test('routes providers and preserves task JSON, upload bytes, auth and raw URL', async () => {
  const received = [];
  async function provider(name) {
    const server = track(http.createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      received.push({ name, url: request.url, method: request.method,
        headers: request.headers, body: Buffer.concat(chunks) });
      response.end(name);
    }));
    server.listen(0, '127.0.0.1');
    await onceListening(server);
    return `http://127.0.0.1:${server.address().port}`;
  }
  const tripo = await provider('tripo');
  const other = await provider('other');
  const proxy = track(createProxyServer({ upstreamRoutes: { tripo, other: `${other}/api` } }));
  proxy.listen(0, '127.0.0.1');
  await onceListening(proxy);
  const port = proxy.address().port;
  const json = Buffer.from('{ "prompt": "猫", "model": "v3.1-20260211", "future": true }');
  const upload = Buffer.concat([Buffer.from('--boundary\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\n\r\n'), Buffer.from([0, 255, 128]), Buffer.from('\r\n--boundary--\r\n')]);
  for (const [path, body, contentType] of [
    ['/tripo/v3/generation/text-to-model?x=%2f&x=+&empty=', json, 'application/json'],
    ['/tripo/v3/upload', upload, 'multipart/form-data; boundary=boundary'],
  ]) {
    await sendRequest({ port, method: 'POST', path, body,
      headers: { authorization: 'Bearer test-only', 'content-type': contentType } });
    const actual = received.at(-1);
    assert.equal(actual.name, 'tripo');
    assert.equal(actual.url, path.slice('/tripo'.length));
    assert.equal(actual.method, 'POST');
    assert.equal(actual.headers.authorization, 'Bearer test-only');
    assert.equal(actual.headers['content-type'], contentType);
    assert.deepEqual(actual.body, body);
  }
  const result = await collectResponse({ port, path: '/other/v1/models?q=one&q=two' });
  assert.equal(result.body.toString(), 'other');
  assert.equal(received.at(-1).url, '/api/v1/models?q=one&q=two');
  await collectResponse({ port, path: '/tripo/v3/tasks/task-123' });
  assert.equal(received.at(-1).url, '/v3/tasks/task-123');
  await collectResponse({ port, path: '/tripo/a/../b%2Fc?signature=%2f+%20' });
  assert.equal(received.at(-1).url, '/a/../b%2Fc?signature=%2f+%20');
  await collectResponse({ port, path: '/tripo?x=1' });
  assert.equal(received.at(-1).url, '/?x=1');
  const count = received.length;
  for (const path of ['/missing/task', '/tripox/task', '/constructor/task', '/']) {
    assert.equal((await collectResponse({ port, path })).statusCode, 404);
  }
  for (const path of ['http://evil.invalid/task', '//evil.invalid/task']) {
    assert.equal((await collectResponse({ port, path })).statusCode, 400);
  }
  assert.equal(received.length, count);
});

test('forwards Azure OpenAI paths, API versions, credentials and request bodies', async () => {
  const received = [];
  const upstream = track(http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ url: request.url, headers: request.headers,
      body: Buffer.concat(chunks) });
    response.end('ok');
  }));
  upstream.listen(0, '127.0.0.1');
  await onceListening(upstream);
  const proxy = track(createProxyServer({ upstreamRoutes: {
    'azure-sub1512448-intsig-eus2': `http://127.0.0.1:${upstream.address().port}`,
  } }));
  proxy.listen(0, '127.0.0.1');
  await onceListening(proxy);
  for (const endpoint of ['responses', 'chat/completions', 'images/generations', 'images/edits']) {
    const multipart = endpoint === 'images/edits';
    const body = multipart
      ? Buffer.from('--azure\r\nContent-Disposition: form-data; name="image"; filename="a.png"\r\n\r\n\x00\xff\r\n--azure--\r\n', 'latin1')
      : Buffer.from('{ "model": "deployment-name", "stream": true }');
    const contentType = multipart ? 'multipart/form-data; boundary=azure' : 'application/json';
    const path = `/openai/v1/${endpoint}?api-version=preview&x=%2f+%20`;
    await sendRequest({ port: proxy.address().port, method: 'POST',
      path: `/azure-sub1512448-intsig-eus2${path}`, body,
      headers: { 'api-key': 'test-azure-key', authorization: 'Bearer test-token',
        'content-type': contentType } });
    const actual = received.at(-1);
    assert.equal(actual.url, path);
    assert.equal(actual.headers['api-key'], 'test-azure-key');
    assert.equal(actual.headers.authorization, 'Bearer test-token');
    assert.equal(actual.headers['content-type'], contentType);
    assert.deepEqual(actual.body, body);
  }
});

test('rejects malformed route maps and ambiguous upstream URLs at startup', () => {
  for (const upstreamRoutes of [null, [], {}, { 'a/b': 'https://example.com' },
    { tripo: 'ftp://example.com' }, { tripo: 'https://user:pass@example.com' },
    { tripo: 'https://example.com?key=secret' }, { tripo: 'https://example.com/#hash' }]) {
    assert.throws(() => createProxyServer({ upstreamRoutes }), /route|upstream/i);
  }
});

function track(server) {
  servers.push(server);
  return server;
}

function onceListening(server) {
  return new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

function sendRequest({ port, method, path, headers, body }) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers,
    }, (response) => {
      response.resume();
      response.once('end', resolve);
    });
    request.once('error', reject);
    request.end(body);
  });
}

function collectResponse({ port, path, headers }) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('end', () => resolve({
        statusCode: response.statusCode,
        statusMessage: response.statusMessage,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    request.setTimeout(500, () => request.destroy(new Error('response timeout')));
    request.once('error', reject);
  });
}

async function reserveClosedPort() {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await onceListening(server);
  const { port } = server.address();
  await closeServer(server);
  return port;
}

function waitForFirstChunk({ port, path }) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path }, (response) => {
      response.once('data', (chunk) => {
        const remaining = new Promise((resolveRemaining) => {
          const chunks = [];
          response.on('data', (nextChunk) => chunks.push(nextChunk));
          response.once('end', () => resolveRemaining(Buffer.concat(chunks)));
        });
        resolve({ chunk, remaining });
      });
    });
    request.setTimeout(500, () => request.destroy(new Error('stream timeout')));
    request.once('error', reject);
  });
}

function withTimeout(promise, milliseconds, message) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
