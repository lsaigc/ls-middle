'use strict';

const { createProxyServer } = require('./proxy');
const path = require('node:path');

function loadConfig() {
  try {
    process.loadEnvFile(path.join(__dirname, '..', '.env'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return readConfig(process.env);
}

function readConfig(env) {
  const upstreamBaseUrl = String(env.UPSTREAM_BASE_URL || '').trim();
  let upstreamRoutes;
  if (env.UPSTREAM_ROUTES !== undefined) {
    try {
      upstreamRoutes = JSON.parse(env.UPSTREAM_ROUTES);
    } catch {
      throw new TypeError('UPSTREAM_ROUTES must be a JSON object');
    }
  }
  if (!upstreamBaseUrl && upstreamRoutes === undefined) {
    throw new TypeError('UPSTREAM_BASE_URL is required');
  }

  const rawPort = env.PORT === undefined ? '3000' : String(env.PORT);
  if (!/^\d+$/.test(rawPort)) {
    throw new TypeError('PORT must be an integer between 0 and 65535');
  }

  const port = Number(rawPort);
  if (port > 65535) {
    throw new TypeError('PORT must be an integer between 0 and 65535');
  }

  return { upstreamBaseUrl, port,
    ...(upstreamRoutes === undefined ? {} : { upstreamRoutes }) };
}

function startServer(config) {
  const server = createProxyServer({
    upstreamBaseUrl: config.upstreamBaseUrl,
    upstreamRoutes: config.upstreamRoutes,
  });

  server.listen(config.port, () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : config.port;
    const upstreamOrigins = config.upstreamRoutes === undefined
      ? new URL(config.upstreamBaseUrl).origin
      : Object.entries(config.upstreamRoutes)
        .map(([name, url]) => `${name}=${new URL(url).origin}`).join(', ');
    console.log(`ls-model-midway listening on port ${port}; upstream ${upstreamOrigins}`);
  });

  return server;
}

if (require.main === module) {
  try {
    const server = startServer(loadConfig());
    server.once('error', reportStartupError);
  } catch (error) {
    reportStartupError(error);
  }
}

function reportStartupError(error) {
  console.error(`Startup failed: ${error.message}`);
  process.exitCode = 1;
}

module.exports = { readConfig, loadConfig, startServer };
