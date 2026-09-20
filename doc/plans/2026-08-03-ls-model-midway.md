# ls-model-midway Passthrough Proxy Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a dependency-free Node.js service that streams HTTP requests to one configured Yunwu upstream and streams responses back without interpreting model payloads.

**Architecture:** Export a `createProxyServer` factory around Node's native `http` and `https` clients so tests can bind ephemeral local ports. A small process entry point reads environment variables and starts the server; request and response streams are piped directly, with only hop-by-hop headers removed as required by HTTP proxy semantics.

**Tech Stack:** Node.js 20+, CommonJS, native `node:http`, `node:https`, and `node:test`.

---

### Task 1: Create the package shell and first failing passthrough test

**Files:**
- Create: `ls-model-midway/package.json`
- Create: `ls-model-midway/test/proxy.test.js`
- Create: `ls-model-midway/src/proxy.js`

**Step 1: Create package metadata**

Define a private CommonJS package requiring Node 20, with `start` set to `node src/server.js` and `test` set to `node --test`.

**Step 2: Write the failing request passthrough test**

Create a local fake upstream and call the planned `createProxyServer({ upstreamBaseUrl })` API. Send a `PATCH` request containing a query string, custom header, and byte buffer, then assert that the fake upstream received the same method, URL, custom header, and bytes.

Also send spoofed `host`, `connection`, and `proxy-authorization` headers and assert that the upstream receives its own host while the hop-by-hop and proxy credential headers are absent.

**Step 3: Run the test to verify RED**

Run: `npm test -- --test-name-pattern="forwards request"`

Working directory: `ls-model-midway`

Expected: FAIL because `../src/proxy` does not export `createProxyServer`.

**Step 4: Implement the minimal request forwarding factory**

In `src/proxy.js`:

- Parse and validate `upstreamBaseUrl` once when constructing the server.
- Accept only `http:` and `https:` configured upstreams.
- Build the target URL from the configured upstream base path plus the inbound request URL.
- Copy request headers after removing standard hop-by-hop headers and headers named by `Connection`.
- Remove `proxy-authorization` and `proxy-authenticate`.
- Set `Host` to the fixed upstream authority.
- Create the native upstream request and pipe the inbound request into it.
- Return the native `http.Server` without binding a port.

**Step 5: Run the focused test to verify GREEN**

Run: `npm test -- --test-name-pattern="forwards request"`

Expected: PASS.

**Step 6: Commit**

```bash
git add ls-model-midway/package.json ls-model-midway/src/proxy.js ls-model-midway/test/proxy.test.js
git commit -m "feat: forward raw model requests"
```

### Task 2: Stream upstream responses unchanged

**Files:**
- Modify: `ls-model-midway/test/proxy.test.js`
- Modify: `ls-model-midway/src/proxy.js`

**Step 1: Write the failing response passthrough test**

Configure the fake upstream to return a non-2xx status, a custom end-to-end header, a hop-by-hop response header, and a binary byte buffer. Assert that the caller receives the same status, custom header, and exact bytes, but not the hop-by-hop header.

**Step 2: Run the test to verify RED**

Run: `npm test -- --test-name-pattern="forwards response"`

Expected: FAIL because the implementation does not yet write the upstream response.

**Step 3: Implement minimal response forwarding**

On the upstream response callback, copy the status code, status message, and filtered end-to-end response headers to the downstream response, then pipe the upstream response directly into it.

**Step 4: Run the focused test to verify GREEN**

Run: `npm test -- --test-name-pattern="forwards response"`

Expected: PASS.

**Step 5: Write a failing streaming test**

Have the fake upstream write one chunk, wait on a test-controlled promise, then write the second chunk and end. Assert that the caller observes the first chunk before allowing the upstream to finish.

**Step 6: Run the streaming test to verify RED or existing GREEN behavior**

Run: `npm test -- --test-name-pattern="streams response"`

Expected: PASS if native piping is already correct. If it fails, make the smallest stream-handling correction and rerun until PASS. This test documents the no-buffering guarantee.

**Step 7: Commit**

```bash
git add ls-model-midway/src/proxy.js ls-model-midway/test/proxy.test.js
git commit -m "feat: stream upstream model responses"
```

### Task 3: Handle transport failures and disconnects

**Files:**
- Modify: `ls-model-midway/test/proxy.test.js`
- Modify: `ls-model-midway/src/proxy.js`

**Step 1: Write the failing unavailable-upstream test**

Point the proxy at a local port that has been allocated and closed. Assert that the caller receives status `502` with a short generic response that contains no target URL, headers, or request content.

**Step 2: Run the test to verify RED**

Run: `npm test -- --test-name-pattern="returns 502"`

Expected: FAIL due to an unhandled upstream request error or missing response.

**Step 3: Implement minimal failure handling**

Handle upstream request errors. If downstream headers have not been sent, return `502 Bad Gateway`; otherwise destroy the downstream response. When the inbound request is aborted, destroy the corresponding upstream request.

**Step 4: Run the focused test and full suite**

Run: `npm test -- --test-name-pattern="returns 502"`

Expected: PASS.

Run: `npm test`

Expected: all tests PASS with no warnings or unhandled errors.

**Step 5: Commit**

```bash
git add ls-model-midway/src/proxy.js ls-model-midway/test/proxy.test.js
git commit -m "fix: handle proxy transport failures"
```

### Task 4: Add the executable entry point and operator documentation

**Files:**
- Create: `ls-model-midway/src/server.js`
- Create: `ls-model-midway/.env.example`
- Create: `ls-model-midway/README.md`
- Modify: `ls-model-midway/package.json`

**Step 1: Write a failing configuration test**

Add an exported `readConfig(env)` helper to the planned server entry module API. Test that it requires `UPSTREAM_BASE_URL`, defaults `PORT` to `3000`, and rejects a non-integer or out-of-range port.

**Step 2: Run the configuration test to verify RED**

Run: `npm test -- --test-name-pattern="reads server config"`

Expected: FAIL because `src/server.js` does not exist.

**Step 3: Implement the minimal entry point**

Create `src/server.js` that:

- Exports `readConfig(env)` and `startServer(config)` for testability.
- Reads `UPSTREAM_BASE_URL` and `PORT` only when executed as the main module.
- Starts `createProxyServer` and logs only the listening port and configured upstream origin, never request data or authorization headers.
- Prints a concise startup error and exits non-zero for invalid configuration or listen failure.

**Step 4: Run the focused test and full suite**

Run: `npm test -- --test-name-pattern="reads server config"`

Expected: PASS.

Run: `npm test`

Expected: all tests PASS.

**Step 5: Document deployment and integration**

Add `.env.example` with non-secret placeholders. Document Node 20+, `UPSTREAM_BASE_URL`, `PORT`, start/test commands, network-whitelist security assumptions, and how to replace only Yunwu entries' `baseUrl` in `ls-model-api/configs/model-providers.local.json` with the deployed midpoint URL.

Explicitly document that the service has no application authentication, request logging, retries, body limits, or content transformation.

**Step 6: Install package metadata and verify startup**

Run: `npm install --package-lock-only`

Expected: creates `ls-model-midway/package-lock.json` without adding runtime dependencies.

Run: `UPSTREAM_BASE_URL=http://127.0.0.1:9 PORT=0 node src/server.js`

Expected: service starts and prints a listening message; terminate it after observing startup.

Run: `npm test`

Expected: all tests PASS.

**Step 7: Commit**

```bash
git add ls-model-midway
git commit -m "docs: add midway deployment instructions"
```

### Task 5: Final verification

**Files:**
- Verify only; no expected modifications.

**Step 1: Run automated verification**

Run: `npm test`

Working directory: `ls-model-midway`

Expected: all tests PASS with no failures, warnings, or open-handle hangs.

**Step 2: Inspect the final change scope**

Run: `git status --short`

Expected: only unrelated pre-existing user files may remain untracked or modified.

Run: `git diff HEAD~4..HEAD -- ls-model-midway docs/plans/2026-08-03-ls-model-midway-design.md docs/plans/2026-08-03-ls-model-midway.md`

Expected: every changed line traces to the passthrough service, its tests, or its documentation; no credentials appear.
