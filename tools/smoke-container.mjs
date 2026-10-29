import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const origin = process.env.SMOKE_ORIGIN || 'http://127.0.0.1:18689';
let healthy = false;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    const response = await fetch(origin + '/healthz');
    if (response.ok) { healthy = true; break; }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 1000));
}
assert.ok(healthy, 'Container must start with PostgreSQL and no provider keys');
const index = await fetch(origin + '/');
assert.equal(index.status, 200);
assert.match(index.headers.get('content-security-policy'), /script-src 'self'/);
assert.equal(index.headers.get('cache-control'), 'no-store');
assert.equal(index.headers.get('x-frame-options'), 'DENY');
assert.equal(index.headers.get('referrer-policy'), 'no-referrer');
const consentPage = await fetch(origin + '/api/integrations/grok-bot/oauth/requests/' + 'R'.repeat(43));
assert.equal(consentPage.headers.get('referrer-policy'), 'same-origin', 'Proxy must preserve the consent form origin policy, including error responses');
const html = await index.text();
for (const asset of ['preferences.js', 'runtime-config.js', 'api-client.js', 'live-app.js']) {
  assert.ok(html.includes(asset), 'Missing production client asset: ' + asset);
  assert.equal((await fetch(origin + '/' + asset)).status, 200);
}
const runtime = await (await fetch(origin + '/runtime-config.js')).text();
assert.match(runtime, /mode:'live'/);
assert.match(runtime, /apiBase:'\/api'/);
assert.doesNotMatch(runtime, /apiKey|secret|password|token/i);
const build = await (await fetch(origin + '/build-info.json')).json();
const pinned = (await readFile(new URL('../deploy/frontend-revision.txt', import.meta.url), 'utf8')).trim();
assert.equal(build.frontendCommit, pinned);
const health = await (await fetch(origin + '/api/health')).json();
assert.equal(health.database, 'postgres');
const capabilities = await (await fetch(origin + '/api/capabilities')).json();
assert.equal(capabilities.devLogin, false);
assert.equal(capabilities.frontendConnected, true);
assert.equal(capabilities.teamMode, 'company');
assert.equal(capabilities.auth.loginEnabled, false);
assert.equal(capabilities.aiReview, 'not_integrated');
assert.equal(capabilities.aiReviewMode, 'bot');
assert.equal(capabilities.botMcpAuthMode, 'oauth');
assert.ok(capabilities.setup.aiMissing.includes('GROK_BOT_WEBHOOK_URL'));
assert.ok(capabilities.setup.aiMissing.includes('GROK_BOT_OAUTH_REDIRECT_URIS'));
for(const path of ['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/api/integrations/grok-bot/mcp','/.well-known/oauth-authorization-server','/.well-known/oauth-authorization-server/api/integrations/grok-bot/oauth','/api/.well-known/oauth-protected-resource']){
  const response=await fetch(origin+path);assert.equal(response.status,503,path+' must reach disabled OAuth rather than static HTML');assert.equal((await response.json()).error,'temporarily_unavailable');
}
assert.match((await fetch(origin+'/api/integrations/grok-bot/oauth/consent.css')).headers.get('content-type'),/text\/css/);
assert.equal(capabilities.employeeDecisions, 'not_supported');
assert.ok(capabilities.setup.dingtalkMissing.includes('DINGTALK_CLIENT_SECRET'));
for (const path of ['/api/tasks', '/api/directory', '/api/objectives', '/api/auth/csrf']) {
  assert.equal((await fetch(origin + path)).status, 401, path + ' must require login');
}
assert.equal((await fetch(origin + '/api/auth/dev-login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' })).status, 404);
assert.equal((await fetch(origin + '/api/auth/dingtalk/start', {redirect:'manual'})).status, 501);
assert.equal((await fetch(origin + '/api/integrations/grok-bot/mcp', {
  method:'POST', headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},
  body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})
})).status, 503);
for (const path of ['/.env', '/src/server.ts', '/deploy/Caddyfile']) {
  assert.equal((await fetch(origin + path)).status, 404);
}
console.log('Same-origin container smoke passed: pinned live frontend, PostgreSQL API, CSP, and fail-closed authentication. No provider requests sent.');
