import test from 'node:test';
import assert from 'node:assert/strict';
import { callTool } from '../src/tools.js';
import { createICS, parseCalendar } from '../src/ical.js';
import { safeError, xmlEscape } from '../src/common.js';
import { ENV, CALENDAR, eventData, mockDAV } from './helpers.js';
const eventId = CALENDAR + 'event.ics';
const args = { calendar_id: CALENDAR, event_id: eventId, expected_etag: '"v1"', scope: 'event', patch: { reminders: [10, 0, -5] } };
const ics = (uid = eventData.uid, summary = 'Fresh full-query body') => createICS({ ...eventData, uid, summary }, 'fixture');
const xml = rows => new Response(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${rows}</d:multistatus>`, { status: 207 });
const denied = (href = eventId) => `<d:response><d:href>${xmlEscape(href)}</d:href><d:propstat><d:prop><c:calendar-data/></d:prop><d:status>HTTP/1.1 403 Forbidden</d:status></d:propstat></d:response>`;
function setup(initial = { 'event.ics': ics() }, queryOverride = null, getBody = null) {
  const mock = mockDAV(initial); const calls = []; let firstGet = true;
  const fetcher = async (url, options) => {
    calls.push(options);
    if (options.method === 'REPORT' && options.body.includes('calendar-multiget')) return xml(denied());
    if (options.method === 'REPORT' && queryOverride) return queryOverride();
    const response = await mock.fetch(url, options);
    if (options.method === 'GET' && firstGet) { firstGet = false; return new Response(getBody ?? await response.text(), { headers: { etag: 'W/"v1"' } }); }
    return response;
  };
  return { mock, fetcher, calls };
}

test('incomplete multiget falls back once to complete bounded query and uses its exact body/ETag', async () => {
  const { mock, fetcher, calls } = setup({ 'event.ics': ics(), 'unrelated.ics': ics('another-uid') }, null, ics(eventData.uid, 'Old GET body'));
  const result = await callTool('update_event', args, ENV, fetcher);
  assert.equal(result.updated, true); assert.equal(result.event.summary, 'Fresh full-query body'); assert.equal(mock.writes, 1);
  assert.deepEqual(result.event.reminders.map(alarm => alarm.trigger), ['-PT10M', 'PT0S', 'PT5M']);
  const reports = calls.filter(call => call.method === 'REPORT'); assert.equal(reports.length, 2);
  assert.match(reports[0].body, /calendar-multiget/); assert.match(reports[1].body, /calendar-query/); assert.ok(!reports[1].body.includes('time-range')); assert.ok(!reports[1].body.includes('prop-filter'));
  const put = mock.calls.find(call => call.method === 'PUT'); assert.equal(put.url, eventId); assert.equal(put.headers['If-Match'], '"v1"'); assert.equal(parseCalendar(put.body).master.getFirstPropertyValue('summary'), 'Fresh full-query body');
});
test('full-query fallback checks exact URL and UID as well as strong expected ETag', async () => {
  for (const type of ['missing', 'uid', 'etag']) {
    const resources = type === 'missing' ? { 'other.ics': ics() } : { 'event.ics': ics(type === 'uid' ? 'changed-uid' : eventData.uid) };
    const { mock, fetcher } = setup(resources, null, ics());
    const input = type === 'etag' ? { ...args, expected_etag: '"old"' } : args;
    await assert.rejects(() => callTool('update_event', input, ENV, fetcher), error => error.code === 'ETAG_CONFLICT'); assert.equal(mock.writes, 0);
  }
});
test('full-query fallback cannot ignore unreadable rows or exceed resource limits', async () => {
  const bad = setup(undefined, () => xml(denied(CALENDAR + 'private-unreadable.ics')));
  await assert.rejects(() => callTool('update_event', args, ENV, bad.fetcher), error => {
    const safe = safeError(error); assert.equal(safe.diagnostic.scan_error, 'INCOMPLETE_DAV_RESPONSE');
    assert.equal(safe.diagnostic.report_diagnostic.stage, 'event_multiget'); assert.equal(safe.diagnostic.scan_diagnostic.stage, 'uid_fallback_scan');
    assert.deepEqual(safe.diagnostic.report_diagnostic.propstat_statuses, [403]); assert.equal(safe.diagnostic.get_weak, true);
    for (const secret of ['private-unreadable', eventId, ENV.CALDAV_PASSWORD]) assert.ok(!JSON.stringify(safe).includes(secret)); return true;
  }); assert.equal(bad.mock.writes, 0);
  const many = setup({ 'event.ics': ics(), ...Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`other-${i}.ics`, ics(`other-${i}`)])) });
  await assert.rejects(() => callTool('update_event', args, ENV, many.fetcher), error => safeError(error).diagnostic.scan_error === 'TOO_MANY_EVENTS'); assert.equal(many.mock.writes, 0);
});
test('duplicate exact target and query-byte limit fail without a PUT', async () => {
  const body = `<d:response><d:href>${eventId}</d:href><d:propstat><d:prop><d:getetag>"v1"</d:getetag><c:calendar-data>${xmlEscape(ics())}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  const duplicate = setup(undefined, () => xml(body + body));
  await assert.rejects(() => callTool('update_event', args, ENV, duplicate.fetcher), error => safeError(error).diagnostic.scan_error === 'EXACT_RESOURCE_REQUIRED'); assert.equal(duplicate.mock.writes, 0);
  const large = setup(undefined, () => new Response('', { status: 207, headers: { 'content-length': String(4 * 1024 * 1024 + 1) } }));
  await assert.rejects(() => callTool('update_event', args, ENV, large.fetcher), error => safeError(error).diagnostic.scan_error === 'UPSTREAM_TOO_LARGE'); assert.equal(large.mock.writes, 0);
});
test('full-query fallback does not permit out-of-calendar resources', async () => {
  const { mock, fetcher } = setup(undefined, () => xml(denied('https://p01-caldav.icloud.com/outside/event.ics')));
  await assert.rejects(() => callTool('update_event', args, ENV, fetcher), error => error.code === 'UNSAFE_DAV_RESPONSE'); assert.equal(mock.writes, 0);
});
test('concurrent change after full-query fallback is still protected by one If-Match PUT', async () => {
  const { mock, fetcher } = setup(); mock.failNextPut = true;
  await assert.rejects(() => callTool('update_event', args, ENV, fetcher), error => error.code === 'ETAG_CONFLICT');
  assert.equal(mock.writes, 0); assert.equal(mock.calls.filter(call => call.method === 'PUT').length, 1); assert.equal(mock.calls.find(call => call.method === 'PUT').headers['If-Match'], '"v1"');
});
