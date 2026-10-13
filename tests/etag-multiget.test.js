import test from 'node:test';
import assert from 'node:assert/strict';
import { callTool } from '../src/tools.js';
import { CalDAV } from '../src/caldav.js';
import { createICS, parseCalendar } from '../src/ical.js';
import { safeError, xmlEscape } from '../src/common.js';
import { ENV, CALENDAR, eventData, mockDAV } from './helpers.js';
const eventId = CALENDAR + 'event.ics';
const args = { calendar_id: CALENDAR, event_id: eventId, expected_etag: '"v1"', scope: 'event', patch: { reminders: [10, 0, -5] } };
const initial = () => createICS({ ...eventData, summary: 'Fresh report body' }, 'fixture');
function withGetVariant(mock, etag, body = null, reportOverride = null) {
  let firstGet = true; const reports = [];
  const fetcher = async (url, options) => {
    if (options.method === 'REPORT') { reports.push(options.body); if (reportOverride) return reportOverride(url, options); }
    const response = await mock.fetch(url, options);
    if (options.method === 'GET' && firstGet) { firstGet = false; const headers = new Headers(response.headers); headers.delete('etag'); if (etag !== null) headers.set('etag', etag); return new Response(body ?? await response.text(), { status: response.status, headers }); }
    return response;
  };
  return { fetcher, reports };
}
const xml = rows => new Response(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${rows}</d:multistatus>`, { status: 207 });
const row = (id, etag, ics) => `<d:response><d:href>${xmlEscape(id)}</d:href><d:propstat><d:prop><d:getetag>${xmlEscape(etag)}</d:getetag><c:calendar-data>${xmlEscape(ics)}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;

test('missing weak or different GET ETag uses one exact multiget body/strong-ETag pair', async () => {
  for (const getEtag of [null, 'W/"v1"', '"http-representation-tag"']) {
    const mock = mockDAV({ 'event.ics': initial() });
    const staleBody = createICS({ ...eventData, summary: 'Stale GET body' }, 'fixture');
    const { fetcher, reports } = withGetVariant(mock, getEtag, staleBody);
    const result = await callTool('update_event', args, ENV, fetcher);
    assert.equal(result.updated, true); assert.equal(result.event.summary, 'Fresh report body');
    assert.deepEqual(result.event.reminders.map(alarm => alarm.trigger), ['-PT10M', 'PT0S', 'PT5M']);
    assert.equal(mock.writes, 1); assert.equal(reports.length, 1); assert.match(reports[0], /calendar-multiget/);
    assert.equal((reports[0].match(/<d:href>/g) || []).length, 1); assert.ok(reports[0].includes(`<d:href>${eventId}</d:href>`));
    const put = mock.calls.find(call => call.method === 'PUT'); assert.equal(put.url, eventId); assert.equal(put.headers['If-Match'], '"v1"');
    assert.equal(parseCalendar(put.body).master.getFirstPropertyValue('summary'), 'Fresh report body');
  }
});
test('matching strong GET ETag does not trigger any REPORT fallback', async () => {
  const mock = mockDAV({ 'event.ics': initial() }); const { fetcher, reports } = withGetVariant(mock, '"v1"');
  assert.equal((await callTool('update_event', args, ENV, fetcher)).updated, true); assert.equal(reports.length, 0);
});
test('different missing or weak REPORT ETags remain conflicts with boolean-only diagnostics', async () => {
  for (const reportEtag of ['"changed-private-tag"', '', 'W/"v1"']) {
    const mock = mockDAV({ 'event.ics': initial() }); const { fetcher } = withGetVariant(mock, null, null, () => xml(row(eventId, reportEtag, initial())));
    await assert.rejects(() => callTool('update_event', args, ENV, fetcher), error => {
      const safe = safeError(error); assert.equal(safe.code, 'ETAG_CONFLICT');
      assert.equal(safe.diagnostic.get_has, false); assert.equal(safe.diagnostic.report_attempted, true); assert.equal(safe.diagnostic.report_has, Boolean(reportEtag)); assert.equal(safe.diagnostic.report_matches, false); assert.equal(safe.diagnostic.report_weak, reportEtag.startsWith('W/'));
      for (const secret of ['changed-private-tag', eventId, ENV.CALDAV_PASSWORD, 'Fresh report body']) assert.ok(!JSON.stringify(safe).includes(secret)); return true;
    });
    assert.equal(mock.writes, 0);
  }
});
test('failed missing duplicate or different exact-resource REPORT cannot authorize a PUT', async () => {
  const valid = row(eventId, '"v1"', initial());
  for (const report of [() => new Response('', { status: 412 }), () => xml(''), () => xml(valid + valid), () => xml(row(CALENDAR + 'other.ics', '"v1"', initial())), () => xml(`<d:response><d:href>${eventId}</d:href><d:status>HTTP/1.1 403 Forbidden</d:status></d:response>`)]) {
    const mock = mockDAV({ 'event.ics': initial() }); const { fetcher, reports } = withGetVariant(mock, null, null, report);
    await assert.rejects(() => callTool('update_event', args, ENV, fetcher), error => error.code === 'ETAG_CONFLICT'); assert.equal(mock.writes, 0); assert.equal(reports.length, 2);
  }
});
test('concurrent change after multiget still fails the conditional PUT without retry', async () => {
  const mock = mockDAV({ 'event.ics': initial() }); mock.failNextPut = true; const { fetcher } = withGetVariant(mock, null);
  await assert.rejects(() => callTool('update_event', args, ENV, fetcher), error => error.code === 'ETAG_CONFLICT');
  assert.equal(mock.writes, 0); assert.equal(mock.calls.filter(call => call.method === 'PUT').length, 1); assert.equal(mock.calls.find(call => call.method === 'PUT').headers['If-Match'], '"v1"');
});
test('multiget does not bypass resource scope and caller weak ETags are rejected', async () => {
  const mock = mockDAV();
  await assert.rejects(() => new CalDAV(ENV, mock.fetch).multiget({ calendar_id: CALENDAR }, 'https://p01-caldav.icloud.com/other/event.ics'), error => error.code === 'EVENT_NOT_ALLOWED'); assert.equal(mock.calls.length, 0);
  const current = mockDAV({ 'event.ics': initial() });
  await assert.rejects(() => callTool('update_event', { ...args, expected_etag: 'W/"v1"' }, ENV, current.fetch), error => error.code === 'ETAG_REQUIRED');
  assert.equal(current.writes, 0); assert.ok(current.calls.every(call => call.method === 'PROPFIND'));
});
