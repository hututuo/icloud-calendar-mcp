import test from 'node:test';
import assert from 'node:assert/strict';
import { appleURL, regionalHosts } from '../src/caldav.js';
import { safeError } from '../src/common.js';
import { createWorker } from '../worker/index.js';
import { ENV, request, mockDAV } from './helpers.js';

test('unapproved China host is still rejected; diagnostic contains only origin metadata and stage', () => {
  let caught;
  try { appleURL('https://hidden-user:hidden-password@p43-caldav.icloud.com.cn:443/private-account/private-calendar?hidden=query#hidden-fragment', undefined, 'calendar_home_href'); }
  catch (error) { caught = safeError(error); }
  assert.equal(caught.code, 'UNSAFE_URL');
  assert.deepEqual(caught.diagnostic, { scheme: 'https:', hostname: 'p43-caldav.icloud.com.cn', port: '443', stage: 'calendar_home_href' });
  for (const sensitive of ['hidden-user', 'hidden-password', 'private-account', 'private-calendar', 'hidden=query', 'hidden-fragment']) assert.ok(!JSON.stringify(caught).includes(sensitive));
});
test('explicit standard HTTPS port is already accepted without expanding any host', () => {
  assert.equal(appleURL('https://p12-caldav.icloud.com:443/fixture/'), 'https://p12-caldav.icloud.com/fixture/');
  assert.throws(() => appleURL('https://p12-caldav.icloud.com:8443/fixture/'), error => safeError(error).diagnostic.port === '8443');
});
test('redirect diagnostics reach authenticated MCP caller without contacting rejected host', async () => {
  const mock = mockDAV(); mock.redirect = { method: 'PROPFIND', location: 'https://caldav.icloud.com.cn/private-fixture-account?private-token=secret' };
  const worker = createWorker(mock.fetch);
  const body = await (await worker.fetch(request('tools/call', { name: 'list_calendars' }), ENV)).json();
  const error = body.result.structuredContent.error;
  assert.deepEqual(error.diagnostic, { scheme: 'https:', hostname: 'caldav.icloud.com.cn', port: '443', stage: 'principal_discovery_redirect' });
  assert.equal(mock.calls.length, 1); assert.equal(mock.calls[0].url, 'https://caldav.icloud.com/');
  assert.ok(!JSON.stringify(body).includes('private-fixture-account')); assert.ok(!JSON.stringify(body).includes('private-token')); assert.ok(!JSON.stringify(body).includes(ENV.CALDAV_PASSWORD));
});
test('calendar-home href rejection reports discovery stage before sending credentials to new host', async () => {
  const mock = mockDAV(); const originalFetch = mock.fetch;
  const fetcher = async (url, options) => {
    const response = await originalFetch(url, options);
    if (url.endsWith('/principal/')) return new Response((await response.text()).replace('/account/calendars/', 'https://p43-caldav.icloud.com.cn/private-account/calendars/'), { status: 207 });
    return response;
  };
  const body = await (await createWorker(fetcher).fetch(request('tools/call', { name: 'list_calendars' }), ENV)).json();
  assert.equal(body.result.structuredContent.error.diagnostic.stage, 'calendar_home_href');
  assert.equal(body.result.structuredContent.error.diagnostic.hostname, 'p43-caldav.icloud.com.cn');
  assert.equal(mock.calls.length, 2); assert.ok(mock.calls.every(call => new URL(call.url).hostname.endsWith('.icloud.com')));
});

test('regional hosts default off and an explicit exact host is accepted over HTTPS/default 443', () => {
  assert.throws(() => appleURL('https://p42-caldav.icloud.com.cn/fixture/'), error => error.code === 'UNSAFE_URL');
  assert.equal(appleURL('https://p42-caldav.icloud.com.cn:443/fixture/', undefined, undefined, ['p42-caldav.icloud.com.cn']), 'https://p42-caldav.icloud.com.cn/fixture/');
  for (const hostname of ['caldav.icloud.com.cn', 'p41-caldav.icloud.com.cn', 'p43-caldav.icloud.com.cn', 'p0042-caldav.icloud.com.cn', 'p42-caldav.icloud.com.cn.evil.invalid', 'evil.p42-caldav.icloud.com.cn']) {
    assert.throws(() => appleURL(`https://${hostname}/fixture/`, undefined, undefined, ['p42-caldav.icloud.com.cn']), error => error.code === 'UNSAFE_URL');
  }
});
test('approved regional host keeps HTTPS, port, query, URL-credential and traversal restrictions', () => {
  for (const input of ['http://p42-caldav.icloud.com.cn/fixture/', 'https://p42-caldav.icloud.com.cn:8443/fixture/', 'https://user:pass@p42-caldav.icloud.com.cn/fixture/', 'https://p42-caldav.icloud.com.cn/fixture/?token=private', 'https://p42-caldav.icloud.com.cn/a/%2e%2e/b', 'https://p42-caldav.icloud.com.cn/fixture/#private']) {
    assert.throws(() => appleURL(input, undefined, undefined, ['p42-caldav.icloud.com.cn']), error => error.code === 'UNSAFE_URL');
  }
});
test('mocked discovery may follow the approved exact regional calendar-home host', async () => {
  const mock = mockDAV(); const received = [];
  const fetcher = async (url, options) => {
    received.push(url);
    const fixtureURL = url.replace('p42-caldav.icloud.com.cn', 'p01-caldav.icloud.com');
    const response = await mock.fetch(fixtureURL, options); let body = await response.text();
    if (url.endsWith('/principal/')) body = body.replace('/account/calendars/', 'https://p42-caldav.icloud.com.cn:443/account/calendars/');
    if (new URL(url).hostname === 'p42-caldav.icloud.com.cn') body = body.replaceAll('p01-caldav.icloud.com', 'p42-caldav.icloud.com.cn');
    return new Response(body, { status: response.status });
  };
  const body = await (await createWorker(fetcher).fetch(request('tools/call', { name: 'list_calendars' }), { ...ENV, CALDAV_ALLOWED_REGIONAL_HOSTS: JSON.stringify(['p42-caldav.icloud.com.cn']) })).json();
  assert.equal(body.result.isError, false);
  assert.equal(body.result.structuredContent.calendars[0].calendar_id, 'https://p42-caldav.icloud.com.cn/account/calendars/personal/');
  assert.equal(received.length, 3); assert.equal(new URL(received[2]).hostname, 'p42-caldav.icloud.com.cn');
  assert.ok(mock.calls.every(call => call.method === 'PROPFIND')); assert.equal(mock.writes, 0);
});
