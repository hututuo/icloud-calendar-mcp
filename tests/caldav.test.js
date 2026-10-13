import test from 'node:test';
import assert from 'node:assert/strict';
import { CalDAV, appleURL } from '../src/caldav.js';
import { callTool } from '../src/tools.js';
import { createICS, parseCalendar } from '../src/ical.js';
import { CALENDAR, ENV, mockDAV, eventData, fixture } from './helpers.js';
const rejected = (fn, code) => assert.rejects(fn, error => error.code === code);

test('URL allowlist rejects insecure hosts, credentials, ports, queries and encoded traversal', () => {
  for (const url of ['http://caldav.icloud.com/', 'https://caldav.icloud.com.evil.invalid/', 'https://user@caldav.icloud.com/', 'https://p01-caldav.icloud.com:8443/', 'https://caldav.icloud.com/?token=x', 'https://caldav.icloud.com/a/%2e%2e/b', 'https://caldav.icloud.com/a/%252e%252e/b', 'https://caldav.icloud.com/a/../b']) assert.throws(() => appleURL(url), error => error.code === 'UNSAFE_URL');
  assert.equal(appleURL('/account/', 'https://p01-caldav.icloud.com/'), 'https://p01-caldav.icloud.com/account/');
});
test('principal and home discovery uses PROPFIND and retains calendar metadata', async () => {
  const mock = mockDAV(); const calendars = await new CalDAV(ENV, mock.fetch).calendars();
  assert.equal(calendars[0].calendar_id, CALENDAR); assert.equal(calendars[0].writable, true);
  assert.deepEqual(mock.calls.map(call => call.headers.Depth), ['0', '0', '1']);
});
test('configured calendar scope filters calendar list and rejects outside IDs', async () => {
  const mock = mockDAV(); const dav = new CalDAV({ ...ENV, CALDAV_ALLOWED_CALENDAR_URLS: '[]' }, mock.fetch);
  assert.deepEqual(await dav.calendars(), []); await rejected(() => dav.calendar(CALENDAR), 'CALENDAR_NOT_ALLOWED');
});
test('credentialed requests never follow hostile redirects', async () => {
  const mock = mockDAV(); mock.redirect = { method: 'PROPFIND', location: 'https://evil.invalid/steal' };
  await rejected(() => new CalDAV(ENV, mock.fetch).calendars(), 'UNSAFE_URL'); assert.equal(mock.calls.length, 1);
});
test('event GET and PUT cannot redirect to another resource even inside the same calendar', async () => {
  for (const method of ['GET', 'PUT']) {
    const mock = mockDAV(); mock.redirect = { method, location: CALENDAR + 'other.ics' };
    const dav = new CalDAV(ENV, mock.fetch);
    await rejected(() => method === 'GET' ? dav.get({ calendar_id: CALENDAR }, CALENDAR + 'original.ics') : dav.put({ calendar_id: CALENDAR }, CALENDAR + 'original.ics', 'fixture', '"v1"'), 'UNSAFE_REDIRECT');
    assert.equal(mock.calls.length, 1);
  }
});
test('create performs If-None-Match and returns verified read-back', async () => {
  const mock = mockDAV(); const result = await callTool('create_event', { calendar_id: CALENDAR, ...eventData }, ENV, mock.fetch);
  assert.equal(result.created, true); assert.equal(mock.writes, 1); assert.equal(result.event.reminders.length, 2);
  assert.equal(mock.calls.find(call => call.method === 'PUT').headers['If-None-Match'], '*');
});
test('create retries reuse UID and return same event without a second write', async () => {
  const mock = mockDAV(); const args = { calendar_id: CALENDAR, ...eventData };
  const first = await callTool('create_event', args, ENV, mock.fetch); const second = await callTool('create_event', args, ENV, mock.fetch);
  assert.equal(first.event.event_id, second.event.event_id); assert.equal(second.idempotent_replay, true); assert.equal(mock.writes, 1);
  await rejected(() => callTool('create_event', { ...args, summary: 'Different' }, ENV, mock.fetch), 'UID_CONFLICT');
});
test('summary update preserves two alarms and uses exact expected If-Match', async () => {
  const mock = mockDAV({ 'event.ics': createICS(eventData, 'fixture') });
  const result = await callTool('update_event', { calendar_id: CALENDAR, event_id: CALENDAR + 'event.ics', expected_etag: '"v1"', scope: 'event', patch: { summary: 'Patched' } }, ENV, mock.fetch);
  assert.equal(result.event.summary, 'Patched'); assert.equal(result.event.reminders.length, 2); assert.equal(mock.calls.find(call => call.method === 'PUT').headers['If-Match'], '"v1"');
});
test('stale ETags and upstream conditional conflicts never overwrite', async () => {
  const mock = mockDAV({ 'event.ics': createICS(eventData, 'fixture') });
  const args = { calendar_id: CALENDAR, event_id: CALENDAR + 'event.ics', expected_etag: '"stale"', scope: 'event', patch: { summary: 'No' } };
  await rejected(() => callTool('update_event', args, ENV, mock.fetch), 'ETAG_CONFLICT'); assert.equal(mock.writes, 0);
  mock.failNextPut = true; await rejected(() => callTool('update_event', { ...args, expected_etag: '"v1"' }, ENV, mock.fetch), 'ETAG_CONFLICT'); assert.equal(mock.writes, 0);
});
test('missing and weak ETags are never sent as unsafe conditional writes', async () => {
  const mock = mockDAV(); const dav = new CalDAV(ENV, mock.fetch);
  for (const etag of ['', 'W/"weak"']) await rejected(() => dav.put({ calendar_id: CALENDAR }, CALENDAR + 'event.ics', 'fixture', etag), 'ETAG_REQUIRED');
  assert.equal(mock.calls.length, 0);
});
test('participant event updates rejected without a PUT', async () => {
  const mock = mockDAV({ 'event.ics': await fixture('preserved-series.ics') });
  await rejected(() => callTool('update_event', { calendar_id: CALENDAR, event_id: CALENDAR + 'event.ics', expected_etag: '"v1"', scope: 'series', patch: { summary: 'No' } }, ENV, mock.fetch), 'SCHEDULING_SIDE_EFFECT_BLOCKED');
  assert.equal(mock.writes, 0);
});
test('freebusy merges overlap and excludes transparent and cancelled events', async () => {
  const first = createICS(eventData, 'fixture'); const second = createICS({ ...eventData, uid: 'second', start: '2026-10-13T09:30:00+08:00', end: '2026-10-13T11:00:00+08:00' }, 'fixture');
  const transparent = createICS({ ...eventData, uid: 'transparent', start: '2026-10-13T12:00:00+08:00', end: '2026-10-13T13:00:00+08:00' }, 'fixture').replace('END:VEVENT', 'TRANSP:TRANSPARENT\r\nEND:VEVENT');
  const cancelled = transparent.replace('TRANSP:TRANSPARENT', 'STATUS:CANCELLED');
  const mock = mockDAV({ 'a.ics': first, 'b.ics': second, 'c.ics': transparent, 'd.ics': cancelled });
  const result = await callTool('freebusy', { calendar_id: CALENDAR, start: '2026-10-13T00:00:00Z', end: '2026-10-14T00:00:00Z' }, ENV, mock.fetch);
  assert.deepEqual(result.busy, [{ start: '2026-10-13T01:00:00.000Z', end: '2026-10-13T03:00:00.000Z' }]);
  assert.ok(mock.calls.find(call => call.method === 'REPORT').body.includes('<c:timezone>')); assert.ok(mock.calls.find(call => call.method === 'REPORT').body.includes('Asia/Shanghai'));
});
test('partial failed REPORT cannot become an empty free-time claim', async () => {
  const mock = mockDAV(); mock.customQuery = '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/account/calendars/personal/a.ics</d:href><d:propstat><d:prop/><d:status>HTTP/1.1 403 Forbidden</d:status></d:propstat></d:response></d:multistatus>';
  await rejected(() => callTool('freebusy', { calendar_id: CALENDAR, start: '2026-10-13T00:00:00Z', end: '2026-10-14T00:00:00Z' }, ENV, mock.fetch), 'INCOMPLETE_DAV_RESPONSE');
});
test('DTD and entity declarations rejected without parsing', async () => {
  const mock = mockDAV(); mock.customQuery = '<!DOCTYPE x [<!ENTITY x "bad">]><d:multistatus xmlns:d="DAV:"></d:multistatus>';
  await rejected(() => callTool('list_events', { calendar_id: CALENDAR, start: '2026-10-13T00:00:00Z', end: '2026-10-14T00:00:00Z' }, ENV, mock.fetch), 'INVALID_DAV_RESPONSE');
});
test('invalid and overlong query windows rejected before any network', async () => {
  const mock = mockDAV();
  await rejected(() => callTool('list_events', { calendar_id: CALENDAR, start: '2026-01-01T00:00:00Z', end: '2028-01-01T00:00:00Z' }, ENV, mock.fetch), 'INVALID_ARGUMENT'); assert.equal(mock.calls.length, 0);
});
test('deletion and unexpected arguments explicitly unavailable', async () => {
  const mock = mockDAV();
  await rejected(() => callTool('delete_event', {}, ENV, mock.fetch), 'UNKNOWN_TOOL');
  await rejected(() => callTool('list_calendars', { password: 'never accept credentials here' }, ENV, mock.fetch), 'INVALID_ARGUMENT'); assert.equal(mock.calls.length, 0);
});
