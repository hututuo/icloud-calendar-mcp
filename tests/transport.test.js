import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from '../worker/index.js';
import { ENV, request, mockDAV } from './helpers.js';

test('initialize negotiates current protocol without exposing identity or credentials', async () => {
  const worker = createWorker(() => { throw new Error('Network forbidden'); });
  const response = await worker.fetch(request('initialize', { protocolVersion: '2025-11-25' }, null), ENV); const body = await response.json();
  assert.equal(body.result.protocolVersion, '2025-11-25'); assert.equal(body.result.serverInfo.name, 'icloud-calendar-mcp');
  assert.ok(!JSON.stringify(body).includes(ENV.CALDAV_PASSWORD)); assert.ok(!JSON.stringify(body).includes(ENV.OWNER_USER_ID));
});
test('tools discovery exposes only static schemas with no data request', async () => {
  const worker = createWorker(() => { throw new Error('Network forbidden'); });
  const body = await (await worker.fetch(request('tools/list', {}, null), ENV)).json();
  assert.deepEqual(body.result.tools.map(t => t.name), ['list_calendars', 'list_events', 'freebusy', 'create_event', 'update_event']);
  assert.ok(!JSON.stringify(body).includes(ENV.CALDAV_USERNAME));
});
test('all data tool calls require owner identity; no network on unauthenticated or wrong-owner calls', async () => {
  const worker = createWorker(() => { throw new Error('Network forbidden'); });
  for (const identity of [null, 'wrong-owner']) {
    const response = await worker.fetch(request('tools/call', { name: 'list_calendars' }, identity), ENV);
    assert.equal(response.status, identity ? 403 : 401);
  }
});
test('service/bearer access alone cannot replace owner identity', async () => {
  const worker = createWorker(() => { throw new Error('Network forbidden'); });
  const response = await worker.fetch(request('tools/call', { name: 'list_calendars' }, null, { 'OAI-Sites-Authorization': 'Bearer fixture', Authorization: 'Bearer fixture' }), ENV);
  assert.equal(response.status, 401);
});
test('missing owner binding and missing secrets fail closed', async () => {
  const worker = createWorker(() => { throw new Error('Network forbidden'); });
  for (const env of [{ ...ENV, OWNER_USER_ID: '' }, { ...ENV, CALDAV_PASSWORD: '' }]) {
    const body = await (await worker.fetch(request('tools/call', { name: 'list_calendars' }), env)).json();
    assert.equal(body.result.isError, true); assert.ok(['OWNER_NOT_CONFIGURED', 'NOT_CONFIGURED'].includes(body.result.structuredContent.error.code));
  }
});
test('write tools default off before any outbound request', async () => {
  const worker = createWorker(() => { throw new Error('Network forbidden'); });
  const body = await (await worker.fetch(request('tools/call', { name: 'create_event', arguments: {} }), { ...ENV, WRITE_ENABLED: undefined })).json();
  assert.equal(body.result.structuredContent.error.code, 'WRITES_DISABLED');
});
test('status page is authenticated, no-store, no secrets and no password input', async () => {
  const worker = createWorker();
  assert.equal((await worker.fetch(new Request('https://fixture.chatgpt.site/api/status'), ENV)).status, 401);
  const response = await worker.fetch(new Request('https://fixture.chatgpt.site/api/status', { headers: { 'oai-authenticated-user-id': ENV.OWNER_USER_ID } }), ENV);
  assert.ok(response.headers.get('cache-control').includes('no-store')); const body = await response.json();
  assert.equal(body.authenticated_subject, ENV.OWNER_USER_ID); assert.equal(body.live_icloud_verified, false); assert.ok(!JSON.stringify(body).includes(ENV.CALDAV_PASSWORD));
  const page = await worker.fetch(new Request('https://fixture.chatgpt.site/', { headers: { 'oai-authenticated-user-id': ENV.OWNER_USER_ID } }), ENV);
  assert.ok(!(await page.text()).includes('<input'));
});
test('stateless notifications accepted with 202; no SSE session endpoint', async () => {
  const worker = createWorker();
  const notification = new Request('https://fixture.chatgpt.site/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal((await worker.fetch(notification, ENV)).status, 202);
  assert.equal((await worker.fetch(new Request('https://fixture.chatgpt.site/mcp'), ENV)).status, 405);
});
test('cross-origin requests and unsupported version rejected', async () => {
  const worker = createWorker();
  assert.equal((await worker.fetch(request('tools/list', {}, null, { origin: 'https://evil.invalid' }), ENV)).status, 403);
  assert.equal((await worker.fetch(new Request('https://fixture.chatgpt.site/mcp', { headers: { origin: 'https://evil.invalid' } }), ENV)).status, 403);
  assert.equal((await worker.fetch(request('tools/list', {}, null, { 'mcp-protocol-version': 'bogus' }), ENV)).status, 400);
});
test('invalid JSON, batches, and oversized request bodies rejected', async () => {
  const worker = createWorker();
  for (const body of ['{', '[]', 'x'.repeat(65537)]) {
    const response = await worker.fetch(new Request('https://fixture.chatgpt.site/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }), ENV);
    assert.equal(response.status, 400);
  }
});
test('mocked MCP end-to-end list_calendars succeeds', async () => {
  const mock = mockDAV(); const worker = createWorker(mock.fetch);
  const body = await (await worker.fetch(request('tools/call', { name: 'list_calendars' }), ENV)).json();
  assert.equal(body.result.isError, false); assert.equal(body.result.structuredContent.calendars.length, 1); assert.equal(mock.calls.length, 3);
});

test('legacy batch-capable protocol versions are not advertised or accepted via version header', async () => {
  const worker = createWorker();
  for (const version of ['2025-03-26', '2024-11-05']) {
    const body = await (await worker.fetch(request('initialize', { protocolVersion: version }, null), ENV)).json();
    assert.equal(body.result.protocolVersion, '2025-11-25');
    assert.equal((await worker.fetch(request('tools/list', {}, null, { 'mcp-protocol-version': version }), ENV)).status, 400);
  }
});
