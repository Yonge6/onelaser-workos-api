import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { ApiError } from '../src/errors.js';
import { AiIntegrationError } from '../src/integrations/grok.js';
import { GROK_BOT_MCP_PATH, GROK_BOT_MCP_VERSIONS, registerGrokBotMcp, type GrokBotMcpOptions } from '../src/integrations/grok-bot-mcp.js';

const token = 'test-worker-secret-with-sufficient-entropy';
const leaseToken = 'L'.repeat(43);
const headers = { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' };
const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
async function fixture(overrides: Partial<GrokBotMcpOptions> = {}) {
  const calls: unknown[][] = [];
  const app = Fastify({ logger: false });
  await registerGrokBotMcp(app, {
    workerToken: token, appPublicUrl: 'https://workos.example',
    getReviewJob: async jobId => { calls.push(['get', jobId]); return { jobId, evidence: 'Untrusted evidence' }; },
    submitReview: async (jobId, lease, result) => { calls.push(['submit', jobId, lease, result]); return { jobId, stored: true }; },
    ...overrides
  });
  return { app, calls };
}
function modern(method: string, params: Record<string, unknown> = {}) {
  return {
    headers: { ...headers, 'mcp-protocol-version': '2026-07-28', 'mcp-method': method, ...(method === 'tools/call' ? { 'mcp-name': String(params.name) } : {}) },
    payload: { jsonrpc: '2.0', id: 7, method, params: { ...params, _meta: meta } }
  };
}
function legacy(method: string, params?: Record<string, unknown>, id: string | number = 1) {
  return { headers, payload: { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) } };
}

test('MCP is unavailable without its worker secret; cookies and business bearer tokens cannot authenticate it', async t => {
  const disabled = await fixture({ workerToken: undefined }); t.after(() => disabled.app.close());
  assert.equal((await disabled.app.inject({ method: 'POST', url: GROK_BOT_MCP_PATH, ...legacy('ping') })).statusCode, 503);
  const { app, calls } = await fixture(); t.after(() => app.close());
  for (const supplied of [{}, { cookie: `workos_session=${'s'.repeat(43)}` }, { authorization: 'Bearer unrelated-business-session' }]) {
    const response = await app.inject({ method: 'POST', url: GROK_BOT_MCP_PATH, ...legacy('ping'), headers: { accept: headers.accept, ...supplied } });
    assert.equal(response.statusCode, 401); assert.equal(response.headers['www-authenticate'], 'Bearer');
    assert.equal(response.json().error.code, 'UNAUTHORIZED'); assert(!response.body.includes(token));
  }
  assert.deepEqual(calls, []);
});

test('MCP validates a present Origin exactly and permits an authenticated non-browser request without Origin', async t => {
  const { app } = await fixture(); t.after(() => app.close());
  for (const origin of ['https://workos.example.evil.test', 'null', 'http://workos.example', 'https://workos.example/path']) {
    assert.equal((await app.inject({ method: 'POST', url: GROK_BOT_MCP_PATH, ...legacy('ping'), headers: { ...headers, origin } })).statusCode, 403);
  }
  assert.equal((await app.inject({ method: 'POST', url: GROK_BOT_MCP_PATH, ...legacy('ping'), headers: { ...headers, origin: 'https://workos.example' } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: GROK_BOT_MCP_PATH, ...legacy('ping') })).statusCode, 200);
  const unconfigured = await fixture({ appPublicUrl: undefined }); t.after(() => unconfigured.app.close());
  assert.equal((await unconfigured.app.inject({ method: 'POST', url: GROK_BOT_MCP_PATH, ...legacy('ping'), headers: { ...headers, origin: 'https://workos.example' } })).statusCode, 403);
});

test('MCP intentionally offers JSON POST without sessions or standalone SSE streams', async t => {
  const { app } = await fixture(); t.after(() => app.close());
  for (const method of ['GET', 'DELETE'] as const) {
    const response = await app.inject({ method, url: GROK_BOT_MCP_PATH, headers });
    assert.equal(response.statusCode, 405); assert.equal(response.headers.allow, 'POST'); assert.equal(response.body, '');
    assert.equal(response.headers['cache-control'], 'no-store'); assert.equal(response.headers['mcp-session-id'], undefined);
  }
  const response = await app.inject({ method: 'POST', url: GROK_BOT_MCP_PATH, ...legacy('ping', undefined, 0), headers: { ...headers, 'mcp-session-id': 'ignored', 'last-event-id': 'ignored' } });
  assert.deepEqual(response.json(), { jsonrpc: '2.0', id: 0, result: {} });
  assert.match(String(response.headers['content-type']), /application\/json/);
  assert.equal(response.headers['mcp-session-id'], undefined);
});

test('legacy initialization negotiates supported versions and notification acceptance returns an empty 202', async t => {
  const { app } = await fixture(); t.after(() => app.close());
  for (const version of ['2025-03-26', '2025-11-25', 'unknown-client-version']) {
    const response = await app.inject({ method: 'POST', url: GROK_BOT_MCP_PATH, ...legacy('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'test', version: '1' } }) });
    assert.equal(response.statusCode, 200); assert.equal(response.json().result.protocolVersion, version === 'unknown-client-version' ? '2025-11-25' : version);
    assert.deepEqual(response.json().result.capabilities, { tools: {} }); assert.equal(response.headers['mcp-session-id'], undefined);
  }
  const invalid = await app.inject({ method: 'POST', url: GROK_BOT_MCP_PATH, ...legacy('initialize', { protocolVersion: '2025-11-25' }) });
  assert.equal(invalid.json().error.code, -32602);
  const notification = await app.inject({ method: 'POST', url: GROK_BOT_MCP_PATH, headers: { ...headers, 'mcp-protocol-version': '2025-11-25' }, payload: { jsonrpc: '2.0', method: 'notifications/initialized' } });
  assert.equal(notification.statusCode, 202); assert.equal(notification.body, '');
});

test('headerless 2025-03-26 and explicit legacy requests list only the two review tools', async t => {
  const { app } = await fixture(); t.after(() => app.close());
  for (const version of [undefined, '2025-03-26', '2025-11-25']) {
    const response = await app.inject({ method: 'POST', url: GROK_BOT_MCP_PATH, ...legacy('tools/list'), headers: { ...headers, ...(version ? { 'mcp-protocol-version': version } : {}) } });
    assert.equal(response.statusCode, 200); assert.equal(response.json().result.resultType, undefined);
    assert.deepEqual(response.json().result.tools.map((tool: any) => tool.name), ['workos_get_review_job', 'workos_submit_review']);
    assert(response.json().result.tools.every((tool: any) => tool.inputSchema.additionalProperties === false));
  }
});

test('modern discovery and list results advertise the exact supported set and private cache hints', async t => {
  const { app } = await fixture(); t.after(() => app.close());
  const discover = await app.inject({ method: 'POST', url: GROK_BOT_MCP_PATH, ...modern('server/discover') });
  assert.equal(discover.statusCode, 200); assert.deepEqual(discover.json().result.supportedVersions, [...GROK_BOT_MCP_VERSIONS]);
  for (const response of [discover, await app.inject({ method: 'POST', url: GROK_BOT_MCP_PATH, ...modern('tools/list') })]) {
    const result = response.json().result;
    assert.equal(result.resultType, 'complete'); assert.equal(result.ttlMs, 0); assert.equal(result.cacheScope, 'private');
    assert.equal(result._meta['io.modelcontextprotocol/serverInfo'].name, 'onelaser-workos-review');
  }
});

test('modern protocol fields and mirrored HTTP headers are validated before calling a tool', async t => {
  const { app, calls } = await fixture(); t.after(() => app.close());
  const missingCapabilities = modern('tools/list');
  missingCapabilities.payload.params._meta = { ...meta, 'io.modelcontextprotocol/clientCapabilities': undefined } as any;
  const invalidMeta = await app.inject({ method: 'POST', url: GROK_BOT_MCP_PATH, ...missingCapabilities });
  assert.equal(invalidMeta.statusCode, 400); assert.equal(invalidMeta.json().error.code, -32602);
  for (const mutate of [
    (value: ReturnType<typeof modern>) => { delete (value.headers as any)['mcp-protocol-version']; },
    (value: ReturnType<typeof modern>) => { value.headers['mcp-method'] = 'tools/list'; },
    (value: ReturnType<typeof modern>) => { (value.headers as any)['mcp-name'] = 'WORKOS_GET_REVIEW_JOB'; },
    (value: ReturnType<typeof modern>) => { (value.headers as any)['mcp-name'] = '=?base64?/w==?='; }
  ]) {
    const value = modern('tools/call', { name: 'workos_get_review_job', arguments: { jobId: 'job_1' } }); mutate(value);
    const response = await app.inject({ method: 'POST', url: GROK_BOT_MCP_PATH, ...value });
    assert.equal(response.statusCode, 400); assert.equal(response.json().error.code, -32020);
  }
  assert.deepEqual(calls, []);
  const missingName = modern('tools/call');
  delete (missingName.headers as any)['mcp-name'];
  const invalidName = await app.inject({ method: 'POST', url: GROK_BOT_MCP_PATH, ...missingName });
  assert.equal(invalidName.statusCode, 400); assert.equal(invalidName.json().error.code, -32020);
  const encoded = modern('tools/call', { name: 'workos_get_review_job', arguments: { jobId: 'job_1' } });
  (encoded.headers as any)['mcp-name'] = `=?base64?${Buffer.from('workos_get_review_job').toString('base64')}?=`;
  assert.equal((await app.inject({ method: 'POST', url: GROK_BOT_MCP_PATH, ...encoded })).json().result.isError, false);
});

test('unsupported versions and unknown methods return explicit protocol errors without version guessing', async t => {
  const { app } = await fixture(); t.after(() => app.close());
  const request = modern('tools/list'); request.headers['mcp-protocol-version'] = '2099-01-01';
  request.payload.params._meta = { ...meta, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' };
  const unsupported = await app.inject({ method: 'POST', url: GROK_BOT_MCP_PATH, ...request });
  assert.equal(unsupported.statusCode, 400); assert.equal(unsupported.json().error.code, -32022);
  assert.deepEqual(unsupported.json().error.data, { supported: [...GROK_BOT_MCP_VERSIONS], requested: '2099-01-01' });
  for (const method of ['ping', 'initialize', 'unimplemented']) {
    const response = await app.inject({ method: 'POST', url: GROK_BOT_MCP_PATH, ...modern(method) });
    assert.equal(response.statusCode, 404); assert.equal(response.json().error.code, -32601);
  }
  const unknownLegacy = await app.inject({ method: 'POST', url: GROK_BOT_MCP_PATH, ...legacy('unimplemented') });
  assert.equal(unknownLegacy.statusCode, 200); assert.equal(unknownLegacy.json().error.code, -32601);
});

test('tool callbacks receive only strict job and lease arguments, with structured results', async t => {
  const { app, calls } = await fixture(); t.after(() => app.close());
  const result = { summary: 'Needs human review', humanReviewRequired: true };
  const get = await app.inject({ method: 'POST', url: GROK_BOT_MCP_PATH, ...modern('tools/call', { name: 'workos_get_review_job', arguments: { jobId: 'job_1' } }) });
  const submit = await app.inject({ method: 'POST', url: GROK_BOT_MCP_PATH, ...modern('tools/call', { name: 'workos_submit_review', arguments: { jobId: 'job_1', leaseToken, result } }) });
  assert.deepEqual(calls, [['get', 'job_1'], ['submit', 'job_1', leaseToken, result]]);
  assert.equal(get.json().result.resultType, 'complete'); assert.equal(submit.json().result.isError, false);
  assert.deepEqual(JSON.parse(submit.json().result.content[0].text), submit.json().result.structuredContent);
  const primitive = await fixture({ getReviewJob: async () => null }); t.after(() => primitive.app.close());
  const response = await primitive.app.inject({ method: 'POST', url: GROK_BOT_MCP_PATH, ...legacy('tools/call', { name: 'workos_get_review_job', arguments: { jobId: 'job_1' } }) });
  assert.equal(response.json().result.content[0].text, 'null'); assert.equal(response.json().result.structuredContent, undefined);
});

test('tool argument validation failures and unknown tool names never invoke callbacks', async t => {
  const { app, calls } = await fixture(); t.after(() => app.close());
  for (const [name, args] of [
    ['workos_get_review_job', { jobId: '../escape' }],
    ['workos_get_review_job', { jobId: 'j', orgId: 'other-org' }],
    ['workos_submit_review', { jobId: 'j', leaseToken: 'short', result: {} }],
    ['workos_submit_review', { jobId: 'j', leaseToken }],
    ['workos_submit_review', { jobId: 'j', leaseToken, result: {}, workerId: 'other-worker' }]
  ] as const) {
    const response = await app.inject({ method: 'POST', url: GROK_BOT_MCP_PATH, ...legacy('tools/call', { name, arguments: args }) });
    assert.equal(response.statusCode, 200); assert.equal(response.json().result.isError, true);
    assert.deepEqual(response.json().result.structuredContent, { error: { code: 'VALIDATION_ERROR', status: 400 } });
  }
  const unknown = await app.inject({ method: 'POST', url: GROK_BOT_MCP_PATH, ...legacy('tools/call', { name: 'arbitrary_admin_tool', arguments: {} }) });
  assert.equal(unknown.json().error.code, -32602); assert.deepEqual(calls, []);
});

test('tool execution errors contain only safe status and code, never upstream messages or secrets', async t => {
  const secret = 'DO_NOT_EXPOSE_CALLBACK_PROVIDER_SECRET';
  for (const [error, expected] of [
    [new ApiError(409, 'LEASE_EXPIRED', secret), { code: 'LEASE_EXPIRED', status: 409 }],
    [new AiIntegrationError('AI_INVALID_OUTPUT'), { code: 'AI_INVALID_OUTPUT', status: 502 }],
    [new Error(secret), { code: 'INTERNAL_ERROR', status: 500 }],
    [new ApiError(500, secret + '!', secret), { code: 'INTERNAL_ERROR', status: 500 }]
  ] as const) {
    const { app } = await fixture({ getReviewJob: async () => { throw error; } }); t.after(() => app.close());
    const response = await app.inject({ method: 'POST', url: GROK_BOT_MCP_PATH, ...modern('tools/call', { name: 'workos_get_review_job', arguments: { jobId: 'job_1' } }) });
    assert.equal(response.statusCode, 200); assert.equal(response.json().result.isError, true);
    assert.deepEqual(response.json().result.structuredContent, { error: expected }); assert(!response.body.includes(secret));
  }
});

test('malformed JSON, invalid IDs and tool notifications do not execute work', async t => {
  const { app, calls } = await fixture(); t.after(() => app.close());
  const parse = await app.inject({ method: 'POST', url: GROK_BOT_MCP_PATH, headers: { ...headers, 'content-type': 'application/json' }, payload: '{' });
  assert.equal(parse.statusCode, 400); assert.equal(parse.json().error.code, -32700);
  for (const payload of [
    [],
    { jsonrpc: '2.0', id: null, method: 'ping' },
    { jsonrpc: '2.0', id: 1.2, method: 'ping' },
    { jsonrpc: '2.0', id: 1, method: 'ping', params: [] },
    { jsonrpc: '2.0', id: 1, method: 'ping', result: {} },
    { jsonrpc: '2.0', method: 'tools/call', params: { name: 'workos_get_review_job', arguments: { jobId: 'job_1' } } }
  ]) {
    const response = await app.inject({ method: 'POST', url: GROK_BOT_MCP_PATH, headers, payload });
    assert.equal(response.statusCode, 400); assert.equal(response.json().error.code, -32600);
  }
  assert.deepEqual(calls, []);
});

test('2025-03-26 accepts bounded batches while later revisions reject them before performing work', async t => {
  const { app, calls } = await fixture(); t.after(() => app.close());
  const payload = [
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 'batch-ping', method: 'ping' },
    { jsonrpc: '2.0', id: 'batch-job', method: 'tools/call', params: { name: 'workos_get_review_job', arguments: { jobId: 'job_1' } } }
  ];
  const response = await app.inject({ method: 'POST', url: GROK_BOT_MCP_PATH, headers, payload });
  assert.equal(response.statusCode, 200); assert.equal(response.json().length, 2);
  assert.deepEqual(response.json()[0], { jsonrpc: '2.0', id: 'batch-ping', result: {} });
  assert.equal(response.json()[1].result.structuredContent.jobId, 'job_1'); assert.deepEqual(calls, [['get', 'job_1']]);
  const notifications = await app.inject({ method: 'POST', url: GROK_BOT_MCP_PATH, headers, payload: [payload[0]] });
  assert.equal(notifications.statusCode, 202); assert.equal(notifications.body, '');
  for (const version of ['2025-11-25', '2026-07-28']) {
    assert.equal((await app.inject({ method: 'POST', url: GROK_BOT_MCP_PATH, headers: { ...headers, 'mcp-protocol-version': version }, payload })).statusCode, 400);
  }
  const mixed = await app.inject({ method: 'POST', url: GROK_BOT_MCP_PATH, headers, payload: [...payload, modern('tools/list').payload] });
  assert.equal(mixed.statusCode, 400); assert.equal(calls.length, 1);
  const oversized = await app.inject({ method: 'POST', url: GROK_BOT_MCP_PATH, headers, payload: Array.from({ length: 21 }, () => payload[2]) });
  assert.equal(oversized.statusCode, 413); assert.equal(calls.length, 1);
});

test('MCP requires both accepted response media types and bounds tool invocation bursts', async t => {
  const { app, calls } = await fixture(); t.after(() => app.close());
  for (const accept of ['application/json', 'text/event-stream', 'application/json, text/event-stream;q=0']) {
    assert.equal((await app.inject({ method: 'POST', url: GROK_BOT_MCP_PATH, ...legacy('ping'), headers: { ...headers, accept } })).statusCode, 406);
  }
  for (let i = 0; i < 120; i++) {
    const response = await app.inject({ method: 'POST', url: GROK_BOT_MCP_PATH, ...legacy('tools/call', { name: 'workos_get_review_job', arguments: { jobId: 'job_1' } }, i) });
    assert.equal(response.statusCode, 200);
  }
  const limited = await app.inject({ method: 'POST', url: GROK_BOT_MCP_PATH, ...legacy('tools/call', { name: 'workos_get_review_job', arguments: { jobId: 'job_1' } }) });
  assert.equal(limited.statusCode, 429); assert.equal(calls.length, 120);
});
