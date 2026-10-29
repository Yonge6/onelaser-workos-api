import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Run against the real edge binary: CADDY_BIN=/path/to/caddy npm test.
// The Docker smoke check also validates this Caddyfile on every CI build.
test('canonical origin switches only the approved Render host and retains health probes', {
  skip: !process.env.CADDY_BIN && 'Set CADDY_BIN to run the edge integration test',
  timeout: 30_000,
}, async t => {
  await mkdir(resolve('.runtime'), { recursive: true });
  const root = await mkdtemp(resolve('.runtime/caddy-redirect-test-'));
  const upstream = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ path: req.url, method: req.method }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamPort = (upstream.address() as { port: number }).port;
  const config = (await readFile(resolve('deploy/Caddyfile'), 'utf8'))
    .replaceAll('127.0.0.1:3001', `127.0.0.1:${upstreamPort}`)
    .replace('root * /app/public', `root * ${root}`);
  const configPath = resolve(root, 'Caddyfile');
  await writeFile(configPath, config);
  await writeFile(resolve(root, 'index.html'), 'workos frontend');
  const oldHost = 'onelaser-workos.onrender.com';
  try {
    for (const appUrl of ['', `https://${oldHost}`, 'https://elsewhere.example',
      "https://evil.example' || true || '", 'https://craftos.app.evil.example',
      'https://craftos.app', 'https://craftos.app/']) {
      await t.test(`APP_PUBLIC_URL=${JSON.stringify(appUrl)}`, async () => {
        const listener = createServer();
        listener.listen(0, '127.0.0.1');
        await once(listener, 'listening');
        const port = (listener.address() as { port: number }).port;
        await new Promise<void>(resolve => listener.close(() => resolve()));
        const edge = spawn(process.env.CADDY_BIN!, ['run', '--config', configPath, '--adapter', 'caddyfile'], {
          env: { ...process.env, PORT: String(port), APP_PUBLIC_URL: appUrl,
            XDG_DATA_HOME: root, XDG_CONFIG_HOME: root }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let diagnostics = '';
        edge.stdout.on('data', chunk => { diagnostics += chunk; });
        edge.stderr.on('data', chunk => { diagnostics += chunk; });
        const exited = once(edge, 'exit');
        const get = (host: string, path: string, method = 'GET', headers: Record<string, string> = {}) =>
          new Promise<{ status: number; location?: string; cacheControl?: string; body: string }>((resolve, reject) => {
            const req = request({ hostname: '127.0.0.1', port, path, method, headers: { host, ...headers } }, res => {
              let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
              res.on('end', () => resolve({ status: res.statusCode!, location: res.headers.location,
                cacheControl: res.headers['cache-control'], body }));
            });
            req.on('error', reject); req.end();
          });
        try {
          let ready = false;
          for (let attempt = 0; attempt < 100; attempt++) {
            try { ready = (await get(oldHost, '/healthz')).status === 200; } catch {}
            if (ready || edge.exitCode !== null) break;
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          assert.ok(ready, diagnostics);
          for (const path of ['/healthz', '/api/health']) {
            const response = await get(oldHost, path);
            assert.equal(response.status, 200); assert.equal(response.location, undefined);
            assert.equal(JSON.parse(response.body).path, '/health');
          }
          const cutover = appUrl === 'https://craftos.app' || appUrl === 'https://craftos.app/';
          for (const path of ['/', '/api/auth/dingtalk/start?next=%2Ftasks',
            '/api/tasks?limit=10', '/.well-known/oauth-authorization-server']) {
            const response = await get(oldHost, path);
            assert.equal(response.status, cutover ? 307 : 200, path);
            assert.equal(response.location, cutover ? `https://craftos.app${path}` : undefined);
            assert.equal(response.cacheControl, 'no-store');
          }
          const write = await get(oldHost, '/api/tasks', 'POST');
          assert.equal(write.status, cutover ? 307 : 200);
          if (!cutover) assert.equal(JSON.parse(write.body).method, 'POST');
          for (const host of ['craftos.app', 'localhost', 'evil.example', `${oldHost}.evil.example`]) {
            const response = await get(host, '/', 'GET', { 'x-forwarded-host': oldHost });
            assert.equal(response.status, 200); assert.equal(response.location, undefined);
          }
          if (cutover) {
            for (const path of ['//evil.example/path?next=https://evil.example',
              '/%5C%5Cevil.example/path']) {
              const untrustedPath = await get(oldHost, path);
              assert.equal(untrustedPath.status, 307, path);
              assert.equal(new URL(untrustedPath.location!).origin, 'https://craftos.app');
            }
            // Go uses the absolute-form authority instead of the Host header.
            // It must not trick the host matcher or produce a reflected redirect.
            const absoluteForm = await get(oldHost, 'http://evil.example/path?x=1');
            assert.equal(absoluteForm.status, 404);
            assert.equal(absoluteForm.location, undefined);
          }
        } finally {
          edge.kill('SIGTERM'); await exited;
        }
      });
    }
  } finally {
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
