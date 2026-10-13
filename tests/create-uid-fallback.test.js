import test from 'node:test';
import assert from 'node:assert/strict';
import { callTool } from '../src/tools.js';
import { createICS, canonical, sha256 } from '../src/ical.js';
import { ENV, CALENDAR, mockDAV, eventData } from './helpers.js';
const args = { calendar_id: CALENDAR, ...eventData };
function uidRejectingMock(mock, fallbackOverride) {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ method: options.method, body: options.body });
    if (options.method === 'REPORT' && options.body.includes('prop-filter name="UID"')) return new Response('', { status: 412 });
    if (options.method === 'REPORT' && fallbackOverride) return fallbackOverride(url, options);
    return mock.fetch(url, options);
  };
  return { fetcher, calls };
}

test('UID REPORT 412 falls back once, then creates using unchanged If-None-Match', async () => {
  const mock = mockDAV(); const { fetcher, calls } = uidRejectingMock(mock);
  const result = await callTool('create_event', args, ENV, fetcher);
  assert.equal(result.created, true); assert.equal(mock.writes, 1);
  assert.equal(mock.calls.find(call => call.method === 'PUT').headers['If-None-Match'], '*');
  assert.deepEqual(calls.map(call => call.method), ['PROPFIND', 'PROPFIND', 'PROPFIND', 'REPORT', 'REPORT', 'PUT', 'GET']);
  const fallback = calls.filter(call => call.method === 'REPORT')[1].body;
  assert.ok(!fallback.includes('prop-filter')); assert.ok(!fallback.includes('time-range')); assert.ok(fallback.includes('comp-filter name="VEVENT"'));
});
test('fallback finds same UID at another resource and returns replay without creating', async () => {
  const ics = createICS(eventData, await sha256(canonical(eventData)));
  const mock = mockDAV({ 'server-named-resource.ics': ics }); const { fetcher } = uidRejectingMock(mock);
  const result = await callTool('create_event', args, ENV, fetcher);
  assert.equal(result.idempotent_replay, true); assert.equal(result.event.event_id, CALENDAR + 'server-named-resource.ics'); assert.equal(mock.writes, 0);
});
test('fallback finds conflicting UID and blocks any PUT', async () => {
  const mock = mockDAV({ 'other.ics': createICS(eventData, 'different-creation-request') }); const { fetcher } = uidRejectingMock(mock);
  await assert.rejects(() => callTool('create_event', args, ENV, fetcher), error => error.code === 'UID_CONFLICT'); assert.equal(mock.writes, 0);
});
test('fallback never writes after resource limit or incomplete response', async () => {
  const many = Object.fromEntries(Array.from({ length: 251 }, (_, i) => [`event-${i}.ics`, createICS({ ...eventData, uid: `other-${i}` }, 'fixture')]));
  const mock = mockDAV(many); const { fetcher } = uidRejectingMock(mock);
  await assert.rejects(() => callTool('create_event', args, ENV, fetcher), error => error.code === 'TOO_MANY_EVENTS'); assert.equal(mock.writes, 0);
  const incomplete = mockDAV(); const fallback = uidRejectingMock(incomplete, () => new Response('<d:multistatus xmlns:d="DAV:"><d:response><d:href>/account/calendars/personal/missing.ics</d:href><d:propstat><d:prop/><d:status>HTTP/1.1 403 Forbidden</d:status></d:propstat></d:response></d:multistatus>', { status: 207 }));
  await assert.rejects(() => callTool('create_event', args, ENV, fallback.fetcher), error => error.code === 'INCOMPLETE_DAV_RESPONSE'); assert.equal(incomplete.writes, 0);
});
test('fallback byte limit rejects before a write and repeated REPORT 412 does not loop', async () => {
  const mock = mockDAV(); const large = uidRejectingMock(mock, () => new Response('x', { status: 207, headers: { 'content-length': String(4 * 1024 * 1024 + 1) } }));
  await assert.rejects(() => callTool('create_event', args, ENV, large.fetcher), error => error.code === 'UPSTREAM_TOO_LARGE'); assert.equal(mock.writes, 0);
  const denied = uidRejectingMock(mockDAV(), () => new Response('', { status: 412 }));
  await assert.rejects(() => callTool('create_event', args, ENV, denied.fetcher), error => error.code === 'QUERY_FAILED');
  assert.equal(denied.calls.filter(call => call.method === 'REPORT').length, 2); assert.equal(denied.calls.filter(call => call.method === 'PUT').length, 0);
});
test('true conditional PUT conflict is never bypassed when target is absent', async () => {
  const mock = mockDAV(); mock.failNextPut = true;
  await assert.rejects(() => callTool('create_event', args, ENV, mock.fetch), error => error.code === 'CREATE_PRECONDITION_FAILED');
  assert.equal(mock.writes, 0); assert.equal(mock.calls.filter(call => call.method === 'PUT').length, 1);
  assert.equal(mock.calls.find(call => call.method === 'PUT').headers['If-None-Match'], '*');
});
