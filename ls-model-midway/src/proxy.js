'use strict';

const http = require('node:http');
const https = require('node:https');

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function createProxyServer({ upstreamBaseUrl, upstreamRoutes }) {
  let routes;
  let defaultUpstream;
  if (upstreamRoutes === undefined) {
    defaultUpstream = parseUpstream(upstreamBaseUrl);
  } else {
    if (!upstreamRoutes || typeof upstreamRoutes !== 'object' ||
        Array.isArray(upstreamRoutes) || Object.keys(upstreamRoutes).length === 0) {
      throw new TypeError('UPSTREAM_ROUTES must be a non-empty JSON object');
    }
    routes = new Map(Object.entries(upstreamRoutes).map(([name, url]) => {
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        throw new TypeError('Route names must contain only letters, digits, underscores or hyphens');
      }
      return [name, parseUpstream(url)];
    }));
  }

  return http.createServer((request, response) => {
    let requestUrl = request.url;
    if (!requestUrl.startsWith('/') || requestUrl.startsWith('//')) {
      response.writeHead(400);
      response.end('Bad Request\n');
      request.resume();
      return;
    }
    let upstream = defaultUpstream;
    if (routes) {
      const name = requestUrl.slice(1).split(/[/?]/, 1)[0];
      upstream = routes.get(name);
      if (!upstream) {
        response.writeHead(404);
        response.end('Unknown upstream\n');
        request.resume();
        return;
      }
      requestUrl = requestUrl.slice(name.length + 1);
      if (!requestUrl.startsWith('/')) requestUrl = `/${requestUrl}`;
    }
    const transport = upstream.protocol === 'http:' ? http : https;
    const headers = filterHeaders(request.headers);
    headers.host = upstream.host;

    const upstreamRequest = transport.request(
      upstream,
      {
        path: `${upstream.pathname.replace(/\/$/, '')}${requestUrl}`,
        method: request.method,
        headers,
      },
      (upstreamResponse) => {
        const responseHeaders = filterHeaders(upstreamResponse.headers);
        response.writeHead(
          upstreamResponse.statusCode,
          upstreamResponse.statusMessage,
          responseHeaders,
        );
        upstreamResponse.pipe(response);
      },
    );

    upstreamRequest.once('error', () => {
      if (response.destroyed) {
        return;
      }

      if (response.headersSent) {
        response.destroy();
        return;
      }

      const body = 'Bad Gateway\n';
      response.writeHead(502, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      });
      response.end(body);
    });
    request.once('aborted', () => upstreamRequest.destroy());
    request.pipe(upstreamRequest);
  });
}

function parseUpstream(upstreamBaseUrl) {
  let upstream;
  try {
    upstream = new URL(upstreamBaseUrl);
  } catch {
    throw new TypeError('upstreamBaseUrl must be a valid URL');
  }

  if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') {
    throw new TypeError('upstreamBaseUrl must use http: or https:');
  }
  if (upstream.username || upstream.password || upstream.search || upstream.hash) {
    throw new TypeError('upstreamBaseUrl must not contain credentials, query or fragment');
  }

  return upstream;
}

function filterHeaders(headers) {
  const connectionHeaders = new Set(
    String(headers.connection || '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
  const filtered = {};

  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    if (!HOP_BY_HOP_HEADERS.has(lowerName) && !connectionHeaders.has(lowerName)) {
      filtered[name] = value;
    }
  }

  return filtered;
}

module.exports = { createProxyServer };
